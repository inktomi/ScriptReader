import io
import os

import numpy as np
import soundfile as sf


START_SPEECH_TOKEN = 6561
STOP_SPEECH_TOKEN = 6562
SILENCE_TOKEN = 4299
# Chatterbox emits roughly 25 speech tokens per second, so the old cap of 512
# stopped a line at about 20 seconds — shorter than the 350-character unit the
# browser is allowed to send. The loop returned those truncated tokens with no
# error, which cut long lines off mid-word.
MAX_NEW_TOKENS = 1024
NUM_HIDDEN_LAYERS = 30
NUM_KEY_VALUE_HEADS = 16
HEAD_DIM = 64
SILENCE_TAIL_TOKENS = 3
# Decoding streams the model's weights once per token, so it is bound by memory
# bandwidth rather than arithmetic: a wide batch costs almost the same wall
# clock as a single row. 32 full-length caches is well under a gigabyte, which
# an L40S has in abundance.
MAX_DECODE_ROWS = 32

_ORT_TO_NUMPY = {
    "tensor(float)": np.float32,
    "tensor(float16)": np.float16,
    "tensor(double)": np.float64,
    "tensor(int64)": np.int64,
    "tensor(int32)": np.int32,
}


def _requires_gpu():
    return os.environ.get("SCRIPTREADER_REQUIRE_GPU", "1").strip().lower() not in {"0", "false", "no", ""}


def _numpy_dtype(declared):
    """Map an ONNX tensor type onto numpy.

    Sessions built by hand in tests do not carry a declared type; treating that
    as float32 keeps them working while a real session that reports something
    this worker cannot represent still fails loudly.
    """
    if not declared:
        return np.float32
    try:
        return _ORT_TO_NUMPY[declared]
    except KeyError:
        raise RuntimeError(f"Chatterbox model uses an unsupported tensor type: {declared}") from None


def _input_dtype(session, name, default=np.float32):
    for item in session.get_inputs():
        if item.name == name:
            return _numpy_dtype(getattr(item, "type", None))
    return default


def _past_key_value_names(session):
    names = [item.name for item in session.get_inputs() if item.name.startswith("past_key_values.")]
    expected = NUM_HIDDEN_LAYERS * 2
    if len(names) != expected:
        raise RuntimeError(f"Chatterbox language model expected {expected} cache inputs; found {len(names)}")
    return names


class RepetitionPenaltyLogitsProcessor:
    def __init__(self, penalty: float = 1.2):
        self.penalty = penalty

    def __call__(self, input_ids: np.ndarray, scores: np.ndarray) -> np.ndarray:
        selected = np.take_along_axis(scores, input_ids, axis=1)
        selected = np.where(selected < 0, selected * self.penalty, selected / self.penalty)
        processed = scores.copy()
        np.put_along_axis(processed, input_ids, selected, axis=1)
        return processed


class _HostDecodeRunner:
    """Carries the attention cache back through host memory between steps.

    Correct everywhere, and the only option on CPU, but on CUDA it copies the
    whole cache off the device and back again on every token.
    """

    def __init__(self, session, past_names, past):
        self.session = session
        self.past_names = past_names
        self.input_names = [item.name for item in session.get_inputs()]
        self.past = dict(past)

    def step(self, inputs_embeds, attention_mask):
        values = {"inputs_embeds": inputs_embeds, "attention_mask": attention_mask, **self.past}
        outputs = self.session.run(None, ChatterboxEngine._feed(self.session, values))
        logits, present = outputs[0], outputs[1:]
        if len(present) != len(self.past_names):
            raise RuntimeError("Chatterbox language model returned an incomplete attention cache")
        self.past = dict(zip(self.past_names, present))
        return logits


class _BoundDecodeRunner:
    """Keeps the attention cache in GPU memory for the whole decode loop.

    The cache is what this loop actually costs: 30 layers of keys and values
    grow by ~245KB per token position, so handing them back as numpy moved the
    entire cache device-to-host and host-to-device on every single step — two
    orders of magnitude more traffic than the matmuls it was feeding. Binding
    the outputs to the device and rebinding them as the next step's inputs
    leaves only the logits crossing the bus.
    """

    def __init__(self, session, past_names, past, ortvalue_factory=None):
        if ortvalue_factory is None:
            import onnxruntime as ort

            ortvalue_factory = ort.OrtValue.ortvalue_from_numpy

        self.session = session
        self.past_names = past_names
        self.input_names = [item.name for item in session.get_inputs()]
        self.output_names = [item.name for item in session.get_outputs()]
        self.float_dtype = _input_dtype(session, "inputs_embeds")
        allowed = {"inputs_embeds", "attention_mask", *past_names}
        unexpected = [name for name in self.input_names if name not in allowed]
        if unexpected:
            raise RuntimeError(f"Model input contract changed; cannot bind: {', '.join(unexpected)}")
        if len(self.output_names) != len(past_names) + 1:
            raise RuntimeError("Chatterbox language model returned an incomplete attention cache")
        self.past = [
            ortvalue_factory(np.asarray(past[name], dtype=self.float_dtype), "cuda", 0)
            for name in past_names
        ]

    def step(self, inputs_embeds, attention_mask):
        binding = self.session.io_binding()
        inputs_embeds = np.asarray(inputs_embeds, dtype=self.float_dtype)
        attention_mask = np.asarray(attention_mask, dtype=np.int64)
        binding.bind_cpu_input("inputs_embeds", inputs_embeds)
        binding.bind_cpu_input("attention_mask", attention_mask)
        for name, value in zip(self.past_names, self.past):
            binding.bind_ortvalue_input(name, value)
        for name in self.output_names:
            binding.bind_output(name, "cuda", 0)
        self.session.run_with_iobinding(binding)
        outputs = binding.get_outputs()
        present = outputs[1:]
        if len(present) != len(self.past_names):
            raise RuntimeError("Chatterbox language model returned an incomplete attention cache")
        self.past = present
        return outputs[0].numpy()


class ChatterboxEngine:
    # Class defaults so a session assembled by hand (tests, diagnostics) behaves
    # like a freshly constructed engine without having to know these exist.
    uses_cuda = False

    def __init__(self, models_dir="/models/chatterbox", require_gpu=None):
        self.models_dir = models_dir
        self.sample_rate = 24000
        self.sessions = {}
        self.tokenizer = None
        # Script-scoped memory only. The dedicated RunPod worker is torn down
        # after the active script render and this cache is never serialized.
        self.speakers_cache = {}
        self._initialized = False
        self._require_gpu = _requires_gpu() if require_gpu is None else require_gpu

    def _ensure_loaded(self):
        if self._initialized:
            return

        import onnxruntime as ort

        # Ask onnxruntime what it can actually do. Deriving this from
        # torch.cuda.is_available() meant an unrelated torch/cuDNN problem
        # silently moved every ONNX session onto the CPU of a rented GPU.
        available = ort.get_available_providers()
        self.uses_cuda = "CUDAExecutionProvider" in available
        if not self.uses_cuda and self._require_gpu:
            raise RuntimeError(
                "onnxruntime has no CUDAExecutionProvider available "
                f"(providers: {available}). This worker bills at GPU rates and "
                "will not quietly run on CPU. Set SCRIPTREADER_REQUIRE_GPU=0 to "
                "allow a deliberate CPU run."
            )

        if self.uses_cuda:
            providers = [
                (
                    "CUDAExecutionProvider",
                    {
                        "device_id": 0,
                        "arena_extend_strategy": "kNextPowerOfTwo",
                        # Every line has a different token count. An exhaustive
                        # search re-runs for each new shape instead of ever
                        # amortising, so it costs more than it recovers here.
                        "cudnn_conv_algo_search": "HEURISTIC",
                    },
                ),
                "CPUExecutionProvider",
            ]
        else:
            providers = ["CPUExecutionProvider"]

        sess_options = ort.SessionOptions()
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        from transformers import AutoTokenizer

        print(f"[ChatterboxEngine] Loading ONNX sessions with providers={providers}...")
        try:
            self.tokenizer = AutoTokenizer.from_pretrained(self.models_dir)
        except Exception as e:
            raise RuntimeError(f"Could not load the Chatterbox tokenizer: {e}") from e

        onnx_dir = os.path.join(self.models_dir, "onnx") if os.path.isdir(os.path.join(self.models_dir, "onnx")) else self.models_dir

        session_names = ["embed_tokens", "speech_encoder", "conditional_decoder"]
        for name in session_names:
            path = os.path.join(onnx_dir, f"{name}.onnx")
            if os.path.exists(path):
                self.sessions[name] = ort.InferenceSession(path, sess_options, providers=providers)

        # On Ada the half-precision weights are strictly better: half the memory
        # traffic for a loop that is bound by exactly that, and the tensor cores
        # only engage below fp32. On CPU the reverse holds, since fp16 there is
        # emulated.
        if self.uses_cuda:
            language_models = [
                "language_model_fp16.onnx",
                "language_model.onnx",
                "language_model_q4f16.onnx",
                "language_model_q4.onnx",
            ]
        else:
            language_models = [
                "language_model.onnx",
                "language_model_fp16.onnx",
                "language_model_q4f16.onnx",
                "language_model_q4.onnx",
            ]
        for lm_name in language_models:
            path = os.path.join(onnx_dir, lm_name)
            if os.path.exists(path):
                try:
                    self.sessions["language_model"] = ort.InferenceSession(path, sess_options, providers=providers)
                    print(f"[ChatterboxEngine] Selected language model: {lm_name}")
                    break
                except Exception as e:
                    print(f"[ChatterboxEngine] Notice: Could not load {lm_name} with {providers}: {e}")

        print(f"[ChatterboxEngine] Successfully loaded sessions: {list(self.sessions.keys())}")
        required = {"embed_tokens", "speech_encoder", "language_model", "conditional_decoder"}
        missing = sorted(required.difference(self.sessions))
        if missing:
            raise RuntimeError(f"Chatterbox model is incomplete; missing sessions: {', '.join(missing)}")

        active = {name: session.get_providers() for name, session in self.sessions.items()}
        print(f"[ChatterboxEngine] Active execution providers: {active}")
        if self.uses_cuda:
            # Registering the CUDA provider is not the same as getting it. A
            # session that quietly fell back to CPU has to stop the worker, not
            # log a line nobody reads while the render runs at 1/50th speed.
            stranded = sorted(name for name, providers in active.items() if "CUDAExecutionProvider" not in providers)
            if stranded:
                raise RuntimeError(
                    f"These Chatterbox sessions fell back to CPU: {', '.join(stranded)}. "
                    "The CUDA libraries onnxruntime needs are missing or mismatched."
                )

        self._initialized = True

    @staticmethod
    def _feed(session, values):
        inputs = session.get_inputs()
        missing = [item.name for item in inputs if item.name not in values]
        if missing:
            raise RuntimeError(f"Model input contract changed; missing values for: {', '.join(missing)}")
        result = {}
        for item in inputs:
            val = values[item.name]
            expected_np_type = _numpy_dtype(getattr(item, "type", None))
            if isinstance(val, np.ndarray) and val.dtype != expected_np_type:
                val = val.astype(expected_np_type, copy=False)
            result[item.name] = val
        return result

    def register_speaker_reference(self, voice_id: str, audio_bytes: bytes):
        """Encode and cache reference voice sample embedding."""
        self._ensure_loaded()
        if voice_id in self.speakers_cache:
            return

        audio_data, sr = sf.read(io.BytesIO(audio_bytes), dtype='float32')
        if audio_data.ndim > 1:
            audio_data = audio_data.mean(axis=1) # Mono

        # Resample to 24kHz if necessary
        if sr != self.sample_rate:
            import scipy.signal
            num_samples = int(len(audio_data) * self.sample_rate / sr)
            audio_data = scipy.signal.resample(audio_data, num_samples).astype(np.float32)

        encoder = self.sessions["speech_encoder"]
        input_name = encoder.get_inputs()[0].name
        inp = np.expand_dims(audio_data, axis=0).astype(np.float32)
        outputs = encoder.run(None, {input_name: inp})
        if len(outputs) < 4:
            raise RuntimeError("Chatterbox speech encoder returned an incomplete speaker prompt")
        self.speakers_cache[voice_id] = tuple(outputs[:4])

    def _embed(self, input_ids, position_ids, exaggeration):
        session = self.sessions["embed_tokens"]
        values = {
            "input_ids": input_ids.astype(np.int64),
            "position_ids": position_ids.astype(np.int64),
            "exaggeration": np.array([exaggeration], dtype=np.float32),
        }
        return session.run(None, self._feed(session, values))[0]

    def _prepare_row(self, item):
        """Resolve one render request into everything the decode loop needs.

        Returns None for text with nothing speakable in it, matching the
        browser's own contract that such a unit yields silence rather than an
        error. The text check comes first so a line with no words never has to
        have a voice registered to succeed.
        """
        text = (item.get("text") or "").strip()
        if not text or not any(c.isalnum() for c in text):
            return None

        voice_id = item.get("voice_id") or "default"
        reference = item.get("reference_audio_bytes")
        if reference and voice_id not in self.speakers_cache:
            self.register_speaker_reference(voice_id, reference)
        speaker = self.speakers_cache.get(voice_id)
        if speaker is None:
            raise RuntimeError(f"Chatterbox voice '{voice_id}' has no reference recording")

        return {
            "text": text,
            "voice_id": voice_id,
            "speaker": speaker,
            "exaggeration": float(item.get("exaggeration", 0.5)),
            "speed": float(item.get("speed", 1.0)),
        }

    def _prefill(self, row, exaggeration):
        """Run the prompt through the language model once, per row.

        Prefill stays unbatched because each row's prompt is a different length
        and its positions were computed against its own sequence. It is a single
        forward pass either way; the loop that follows it is what needed fixing.
        """
        cond_emb, _prompt_token, _ref_x_vector, _prompt_feat = row["speaker"]
        language_model = self.sessions["language_model"]
        float_dtype = _input_dtype(language_model, "inputs_embeds")

        input_ids = self.tokenizer(row["text"], return_tensors="np")["input_ids"].astype(np.int64)
        position_ids = np.zeros_like(input_ids, dtype=np.int64)
        for row_index, token_row in enumerate(input_ids):
            position = 0
            for token_index, token in enumerate(token_row):
                if token < START_SPEECH_TOKEN:
                    position_ids[row_index, token_index] = position
                    position += 1

        inputs_embeds = self._embed(input_ids, position_ids, exaggeration)
        inputs_embeds = np.concatenate((cond_emb, inputs_embeds), axis=1).astype(float_dtype, copy=False)

        batch_size, sequence_length, _ = inputs_embeds.shape
        past_names = _past_key_value_names(language_model)
        values = {
            "inputs_embeds": inputs_embeds,
            "attention_mask": np.ones((batch_size, sequence_length), dtype=np.int64),
        }
        for name in past_names:
            values[name] = np.zeros([batch_size, NUM_KEY_VALUE_HEADS, 0, HEAD_DIM], dtype=float_dtype)

        outputs = language_model.run(None, self._feed(language_model, values))
        logits, present = outputs[0], outputs[1:]
        if len(present) != len(past_names):
            raise RuntimeError("Chatterbox language model returned an incomplete attention cache")

        return {
            "past": dict(zip(past_names, present)),
            "past_names": past_names,
            "prefix_length": sequence_length,
            "logits": np.asarray(logits[:, -1, :], dtype=np.float32),
            "float_dtype": float_dtype,
        }

    def _decode_runner(self, session, past_names, past):
        if self.uses_cuda and hasattr(session, "io_binding"):
            try:
                return _BoundDecodeRunner(session, past_names, past)
            except Exception as error:
                print(f"[ChatterboxEngine] Device-resident cache unavailable ({error}); falling back to host copies")
        return _HostDecodeRunner(session, past_names, past)

    def _decode_batch(self, states, exaggeration, max_new_tokens=MAX_NEW_TOKENS):
        """Generate speech tokens for several lines in one pass.

        Every row is at the same decode step, so they share the position id and
        the token count; what differs is prompt length. Left-padding each cache
        to a common width and masking the padding off lets rows of any length
        ride in the same batch, which is the whole point — a batch of 32 costs
        barely more wall clock than a batch of 1.
        """
        batch = len(states)
        language_model = self.sessions["language_model"]
        past_names = states[0]["past_names"]
        prefix_lengths = [state["prefix_length"] for state in states]
        width = max(prefix_lengths)

        past = {}
        for name in past_names:
            padded = []
            for state, length in zip(states, prefix_lengths):
                cache = state["past"][name]
                if length < width:
                    pad = np.zeros(
                        (cache.shape[0], NUM_KEY_VALUE_HEADS, width - length, HEAD_DIM),
                        dtype=cache.dtype,
                    )
                    cache = np.concatenate((pad, cache), axis=2)
                padded.append(cache)
            past[name] = np.ascontiguousarray(np.concatenate(padded, axis=0))

        attention_mask = np.zeros((batch, width), dtype=np.int64)
        for index, length in enumerate(prefix_lengths):
            attention_mask[index, width - length:] = 1

        float_dtype = states[0]["float_dtype"]
        penalty = RepetitionPenaltyLogitsProcessor()
        generated = np.full((batch, 1), START_SPEECH_TOKEN, dtype=np.int64)
        logits = np.concatenate([state["logits"] for state in states], axis=0)
        finished = np.zeros(batch, dtype=bool)
        collected = [[] for _ in range(batch)]

        runner = self._decode_runner(language_model, past_names, past)
        for index in range(max_new_tokens):
            next_logits = penalty(generated, logits)
            next_token = np.argmax(next_logits, axis=-1, keepdims=True).astype(np.int64)
            generated = np.concatenate((generated, next_token), axis=-1)

            stopping = next_token[:, 0] == STOP_SPEECH_TOKEN
            for keep in np.nonzero(~finished & ~stopping)[0]:
                collected[keep].append(int(next_token[keep, 0]))
            finished = finished | stopping
            if finished.all() or index == max_new_tokens - 1:
                break

            position_ids = np.full((batch, 1), index + 1, dtype=np.int64)
            inputs_embeds = self._embed(next_token, position_ids, exaggeration).astype(float_dtype, copy=False)
            attention_mask = np.concatenate((attention_mask, np.ones((batch, 1), dtype=np.int64)), axis=1)
            logits = np.asarray(runner.step(inputs_embeds, attention_mask)[:, -1, :], dtype=np.float32)

        for row_index, done in enumerate(finished):
            if not done:
                print(
                    f"[ChatterboxEngine] Row {row_index} hit the {max_new_tokens}-token ceiling "
                    "without reaching a stop token; its audio is truncated."
                )
        return collected

    def _decode(self, speech_tokens, speaker_embeddings, speaker_features):
        decoder = self.sessions["conditional_decoder"]
        values = {
            "speech_tokens": speech_tokens,
            "speaker_embeddings": speaker_embeddings,
            "speaker_features": speaker_features,
        }
        return decoder.run(None, self._feed(decoder, values))[0].squeeze()

    def _render_row(self, row, tokens):
        """Turn one row's speech tokens into audio.

        The vocoder runs per row rather than batched: it is a single forward
        pass, so it is a rounding error next to the token loop, and padding a
        batch of different token counts would bleed across the boundaries.
        """
        _cond_emb, prompt_token, ref_x_vector, prompt_feat = row["speaker"]
        speech_tokens = np.asarray(tokens, dtype=np.int64).reshape(1, -1)
        if speech_tokens.shape[1] == 0:
            raise RuntimeError("Chatterbox language model produced no speech tokens")

        silence_tokens = np.full((speech_tokens.shape[0], SILENCE_TAIL_TOKENS), SILENCE_TOKEN, dtype=np.int64)
        waveform = self._decode(
            np.concatenate((prompt_token, speech_tokens, silence_tokens), axis=1),
            ref_x_vector,
            prompt_feat,
        )
        if waveform is None or len(waveform) == 0 or np.all(waveform == 0):
            raise RuntimeError(f"Chatterbox voice generation failed for voice '{row['voice_id']}'")

        audio = np.asarray(waveform, dtype=np.float32)
        if abs(row["speed"] - 1.0) > 0.01:
            # Chatterbox does not expose a native rate control. Librosa's phase
            # vocoder changes duration without the pitch shift caused by simple
            # sample-rate conversion, matching the browser engine contract.
            import librosa
            audio = librosa.effects.time_stretch(audio, rate=row["speed"]).astype(np.float32)
        return audio

    def _render_chunk(self, chunk, exaggeration, results, max_new_tokens):
        prefilled = []
        for index, row in chunk:
            try:
                prefilled.append((index, row, self._prefill(row, exaggeration)))
            except Exception as error:
                results[index] = error
        if not prefilled:
            return

        try:
            token_rows = self._decode_batch(
                [state for _index, _row, state in prefilled], exaggeration, max_new_tokens
            )
        except Exception as error:
            if len(prefilled) == 1:
                results[prefilled[0][0]] = error
                return
            # One unlucky row must not cost the whole batch. Re-running the rows
            # one at a time isolates the failure to the line that caused it.
            print(f"[ChatterboxEngine] Batched decode failed ({error}); retrying {len(prefilled)} lines individually")
            for index, row, _state in prefilled:
                self._render_chunk([(index, row)], exaggeration, results, max_new_tokens)
            return

        for (index, row, _state), tokens in zip(prefilled, token_rows):
            try:
                results[index] = self._render_row(row, tokens)
            except Exception as error:
                results[index] = error

    def generate_batch(self, items, max_new_tokens=MAX_NEW_TOKENS):
        """Render several lines together, returning audio or an error per line.

        Failures are per row on purpose: a batch is a whole scene's worth of
        dialogue, and one line with a missing voice reference should not take
        the other thirty-one down with it.
        """
        self._ensure_loaded()

        results = [None] * len(items)
        pending = []
        for index, item in enumerate(items):
            try:
                row = self._prepare_row(item)
            except Exception as error:
                results[index] = error
                continue
            if row is None:
                results[index] = np.zeros(0, dtype=np.float32)
                continue
            pending.append((index, row))

        # The embedding graph takes one exaggeration value for the whole call,
        # so rows share a decode batch only when they share that value. Casting
        # normally uses a handful of distinct settings, which keeps the groups
        # close to the size they would have been anyway.
        groups = {}
        for index, row in pending:
            groups.setdefault(row["exaggeration"], []).append((index, row))

        for exaggeration, group in groups.items():
            for start in range(0, len(group), MAX_DECODE_ROWS):
                self._render_chunk(group[start:start + MAX_DECODE_ROWS], exaggeration, results, max_new_tokens)
        return results

    def generate(
        self,
        text: str,
        voice_id: str = "default",
        reference_audio_bytes: bytes = None,
        exaggeration: float = 0.5,
        speed: float = 1.0
    ) -> np.ndarray:
        result = self.generate_batch([{
            "text": text,
            "voice_id": voice_id,
            "reference_audio_bytes": reference_audio_bytes,
            "exaggeration": exaggeration,
            "speed": speed,
        }])[0]
        if isinstance(result, Exception):
            raise result
        return result

    def warmup(self):
        """Pay for model load and kernel selection before the first billed job.

        RunPod marks a worker ready as soon as the handler is registered, so
        loading lazily put a 2GB session build, CUDA context creation and cuDNN
        kernel selection inside the first customer request. Running a synthetic
        line here exercises all four graphs with real shapes — the reference is
        a generated tone, so it needs no assets and no network.
        """
        self._ensure_loaded()

        voice_id = "__warmup__"
        try:
            if voice_id not in self.speakers_cache:
                # A quiet tone rather than digital silence: an encoder handed a
                # constant-zero signal can produce degenerate statistics.
                samples = np.arange(self.sample_rate, dtype=np.float32) / self.sample_rate
                tone = (0.05 * np.sin(2 * np.pi * 220.0 * samples)).astype(np.float32)
                buffer = io.BytesIO()
                sf.write(buffer, tone, self.sample_rate, format="WAV", subtype="PCM_16")
                self.register_speaker_reference(voice_id, buffer.getvalue())

            result = self.generate_batch(
                [{"text": "Warm up.", "voice_id": voice_id, "exaggeration": 0.5, "speed": 1.0}],
                max_new_tokens=24,
            )[0]
            if isinstance(result, Exception):
                raise result
            print("[ChatterboxEngine] Warmup complete")
        except Exception as error:
            # Session load already succeeded, which is the part that guards
            # against a mis-provisioned worker. A synthetic line failing is
            # worth knowing about but is not itself a reason to refuse jobs.
            print(f"[ChatterboxEngine] Warmup notice: {error}")
        finally:
            self.speakers_cache.pop(voice_id, None)
