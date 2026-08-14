import os
import io
import base64
import torch
import numpy as np
import soundfile as sf


START_SPEECH_TOKEN = 6561
STOP_SPEECH_TOKEN = 6562
SILENCE_TOKEN = 4299
MAX_NEW_TOKENS = 512
NUM_HIDDEN_LAYERS = 30
NUM_KEY_VALUE_HEADS = 16
HEAD_DIM = 64


class RepetitionPenaltyLogitsProcessor:
    def __init__(self, penalty: float = 1.2):
        self.penalty = penalty

    def __call__(self, input_ids: np.ndarray, scores: np.ndarray) -> np.ndarray:
        selected = np.take_along_axis(scores, input_ids, axis=1)
        selected = np.where(selected < 0, selected * self.penalty, selected / self.penalty)
        processed = scores.copy()
        np.put_along_axis(processed, input_ids, selected, axis=1)
        return processed

class ChatterboxEngine:
    def __init__(self, models_dir="/models/chatterbox"):
        self.models_dir = models_dir
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.sample_rate = 24000
        self.sessions = {}
        self.tokenizer = None
        # Script-scoped memory only. The dedicated RunPod worker is torn down
        # after the active script render and this cache is never serialized.
        self.speakers_cache = {}
        self._initialized = False

    def _ensure_loaded(self):
        if self._initialized:
            return

        import onnxruntime as ort
        from transformers import AutoTokenizer

        providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if self.device == 'cuda' else ['CPUExecutionProvider']
        sess_options = ort.SessionOptions()
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        print(f"[ChatterboxEngine] Loading ONNX sessions with providers={providers}...")
        try:
            self.tokenizer = AutoTokenizer.from_pretrained(self.models_dir)
        except Exception as e:
            raise RuntimeError(f"Could not load the Chatterbox tokenizer: {e}") from e

        # Check for model files
        onnx_dir = os.path.join(self.models_dir, "onnx") if os.path.isdir(os.path.join(self.models_dir, "onnx")) else self.models_dir
        
        session_names = ["embed_tokens", "speech_encoder", "conditional_decoder"]
        for name in session_names:
            path = os.path.join(onnx_dir, f"{name}.onnx")
            if os.path.exists(path):
                self.sessions[name] = ort.InferenceSession(path, sess_options, providers=providers)

        # Look for language_model - prioritize full precision unquantized weights on GPU
        for lm_name in ["language_model.onnx", "language_model_fp16.onnx", "language_model_q4f16.onnx", "language_model_q4.onnx"]:
            path = os.path.join(onnx_dir, lm_name)
            if os.path.exists(path):
                self.sessions["language_model"] = ort.InferenceSession(path, sess_options, providers=providers)
                print(f"[ChatterboxEngine] Selected language model: {lm_name}")
                break

        print(f"[ChatterboxEngine] Successfully loaded sessions: {list(self.sessions.keys())}")
        required = {"embed_tokens", "speech_encoder", "language_model", "conditional_decoder"}
        missing = sorted(required.difference(self.sessions))
        if missing:
            raise RuntimeError(f"Chatterbox model is incomplete; missing sessions: {', '.join(missing)}")
        self._initialized = True

    @staticmethod
    def _feed(session, values):
        names = [item.name for item in session.get_inputs()]
        missing = [name for name in names if name not in values]
        if missing:
            raise RuntimeError(f"Model input contract changed; missing values for: {', '.join(missing)}")
        return {name: values[name] for name in names}

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

    def _generate_speech_tokens(self, text, speaker_prompt, exaggeration):
        cond_emb, prompt_token, ref_x_vector, prompt_feat = speaker_prompt
        input_ids = self.tokenizer(text, return_tensors="np")["input_ids"].astype(np.int64)
        position_ids = np.zeros_like(input_ids, dtype=np.int64)
        for row_index, row in enumerate(input_ids):
            position = 0
            for token_index, token in enumerate(row):
                if token < START_SPEECH_TOKEN:
                    position_ids[row_index, token_index] = position
                    position += 1
        inputs_embeds = self._embed(input_ids, position_ids, exaggeration)
        inputs_embeds = np.concatenate((cond_emb, inputs_embeds), axis=1)

        batch_size, sequence_length, _ = inputs_embeds.shape
        language_model = self.sessions["language_model"]
        past_names = [
            item.name for item in language_model.get_inputs()
            if item.name.startswith("past_key_values.")
        ]
        expected_past = NUM_HIDDEN_LAYERS * 2
        if len(past_names) != expected_past:
            raise RuntimeError(
                f"Chatterbox language model expected {expected_past} cache inputs; found {len(past_names)}"
            )
        past_key_values = {
            name: np.zeros(
                [batch_size, NUM_KEY_VALUE_HEADS, 0, HEAD_DIM],
                dtype=np.float32,
            )
            for name in past_names
        }
        attention_mask = np.ones((batch_size, sequence_length), dtype=np.int64)
        generated = np.array([[START_SPEECH_TOKEN]], dtype=np.int64)
        penalty = RepetitionPenaltyLogitsProcessor()
        stopped = False

        for index in range(MAX_NEW_TOKENS):
            values = {
                "inputs_embeds": inputs_embeds,
                "attention_mask": attention_mask,
                **past_key_values,
            }
            outputs = language_model.run(None, self._feed(language_model, values))
            logits, present_values = outputs[0], outputs[1:]
            if len(present_values) != len(past_names):
                raise RuntimeError("Chatterbox language model returned an incomplete attention cache")

            next_logits = penalty(generated, logits[:, -1, :])
            next_token = np.argmax(next_logits, axis=-1, keepdims=True).astype(np.int64)
            generated = np.concatenate((generated, next_token), axis=-1)
            if np.all(next_token == STOP_SPEECH_TOKEN):
                stopped = True
                break

            next_position = np.full((batch_size, 1), index + 1, dtype=np.int64)
            inputs_embeds = self._embed(next_token, next_position, exaggeration)
            attention_mask = np.concatenate(
                (attention_mask, np.ones((batch_size, 1), dtype=np.int64)),
                axis=1,
            )
            past_key_values = dict(zip(past_names, present_values))

        speech_tokens = generated[:, 1:-1] if stopped else generated[:, 1:]
        if speech_tokens.shape[1] == 0:
            raise RuntimeError("Chatterbox language model produced no speech tokens")
        silence_tokens = np.full(
            (speech_tokens.shape[0], 3),
            SILENCE_TOKEN,
            dtype=np.int64,
        )
        return (
            np.concatenate((prompt_token, speech_tokens, silence_tokens), axis=1),
            ref_x_vector,
            prompt_feat,
        )

    def _decode(self, speech_tokens, speaker_embeddings, speaker_features):
        decoder = self.sessions["conditional_decoder"]
        values = {
            "speech_tokens": speech_tokens,
            "speaker_embeddings": speaker_embeddings,
            "speaker_features": speaker_features,
        }
        return decoder.run(None, self._feed(decoder, values))[0].squeeze()

    def generate(
        self,
        text: str,
        voice_id: str = "default",
        reference_audio_bytes: bytes = None,
        exaggeration: float = 0.5,
        speed: float = 1.0
    ) -> np.ndarray:
        self._ensure_loaded()
        if not text or not text.strip() or not any(c.isalnum() for c in text):
            return np.zeros(0, dtype=np.float32)

        if reference_audio_bytes and voice_id not in self.speakers_cache:
            self.register_speaker_reference(voice_id, reference_audio_bytes)
        speaker_prompt = self.speakers_cache.get(voice_id)
        if speaker_prompt is None:
            raise RuntimeError(f"Chatterbox voice '{voice_id}' has no reference recording")

        speech_tokens, speaker_embeddings, speaker_features = self._generate_speech_tokens(
            text.strip(), speaker_prompt, exaggeration
        )
        waveform = self._decode(speech_tokens, speaker_embeddings, speaker_features)
        if waveform is None or len(waveform) == 0 or np.all(waveform == 0):
            raise RuntimeError(f"Chatterbox voice generation failed for voice '{voice_id}'")

        audio = waveform.astype(np.float32)
        if abs(speed - 1.0) > 0.01:
            # Chatterbox does not expose a native rate control. Librosa's phase
            # vocoder changes duration without the pitch shift caused by simple
            # sample-rate conversion, matching the browser engine contract.
            import librosa
            audio = librosa.effects.time_stretch(audio, rate=speed).astype(np.float32)
        return audio
