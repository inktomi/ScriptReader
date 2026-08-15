import sys
import types
import unittest
from unittest import mock

import numpy as np


# The unit exercises the ONNX orchestration with fake sessions; importing the
# production module must not require CUDA/PyTorch or libsndfile on a developer's
# machine.
sys.modules.setdefault("torch", types.SimpleNamespace(
    cuda=types.SimpleNamespace(is_available=lambda: False)
))
sys.modules.setdefault("soundfile", types.SimpleNamespace())

from engine_chatterbox import (  # noqa: E402
    ChatterboxEngine,
    HEAD_DIM,
    NUM_HIDDEN_LAYERS,
    NUM_KEY_VALUE_HEADS,
    SILENCE_TOKEN,
    START_SPEECH_TOKEN,
    STOP_SPEECH_TOKEN,
    _BoundDecodeRunner,
)


HIDDEN = 4
VOCAB = STOP_SPEECH_TOKEN + 1


class Input:
    def __init__(self, name, type=None):
        self.name = name
        self.type = type


class EmbedSession:
    def __init__(self):
        self.exaggerations = []

    def get_inputs(self):
        return [Input("input_ids"), Input("position_ids"), Input("exaggeration")]

    def run(self, _, feed):
        self.exaggerations.append(float(feed["exaggeration"][0]))
        width = feed["input_ids"].shape[1]
        return [np.zeros((1, width, HIDDEN), dtype=np.float32)]


class BatchEmbedSession(EmbedSession):
    """Embedding stub that keeps the batch dimension it was handed."""

    def run(self, _, feed):
        self.exaggerations.append(float(feed["exaggeration"][0]))
        batch, width = feed["input_ids"].shape
        return [np.zeros((batch, width, HIDDEN), dtype=np.float32)]


class LanguageModelSession:
    def __init__(self):
        self.calls = 0
        self.past_names = [
            f"past_key_values.{layer}.{kind}"
            for layer in range(30)
            for kind in ("key", "value")
        ]

    def get_inputs(self):
        return [Input("inputs_embeds"), Input("attention_mask"), *map(Input, self.past_names)]

    def run(self, _, feed):
        self.calls += 1
        sequence_length = feed["inputs_embeds"].shape[1]
        logits = np.zeros((1, sequence_length, STOP_SPEECH_TOKEN + 1), dtype=np.float32)
        token = 42 if self.calls == 1 else STOP_SPEECH_TOKEN
        logits[0, -1, token] = 10
        present = [np.zeros((1, 16, sequence_length, 64), dtype=np.float32) for _ in self.past_names]
        return [logits, *present]


class DecoderSession:
    def __init__(self):
        self.feed = None

    def get_inputs(self):
        return [Input("speech_tokens"), Input("speaker_embeddings"), Input("speaker_features")]

    def run(self, _, feed):
        self.feed = feed
        return [np.array([[0.1, -0.1, 0.2]], dtype=np.float32)]


class Tokenizer:
    def __call__(self, _text, return_tensors):
        assert return_tensors == "np"
        return {"input_ids": np.array([[11, 12]], dtype=np.int64)}


class WordTokenizer:
    """One token per word, so a row's prompt length follows its text."""

    def __call__(self, text, return_tensors):
        assert return_tensors == "np"
        ids = [11 + index for index in range(len(text.split()))]
        return {"input_ids": np.array([ids], dtype=np.int64)}


class ScriptedLanguageModel:
    """A model whose logits depend on the masked attention cache.

    Each row's identity is written into the cache at prefill and read back from
    the first *unmasked* key position on every later step. A batched run that
    padded on the wrong side, failed to mask the padding, or lost the cache
    between steps cannot reproduce the tokens a solo run produces — which is the
    property the equivalence tests exist to check. The shape assertion on
    attention_mask covers the other half: the mask has to keep describing every
    key the cache holds.
    """

    def __init__(self, scripts, float_dtype=None):
        self.scripts = scripts
        self.float_dtype = float_dtype
        # How far a row has advanced is read from its own unmasked key count
        # rather than a call counter, so a row behaves the same whether it is
        # alone, sharing a batch, or being retried after a failed one.
        self.prefix_lengths = {}
        self.seen_masks = []
        self.seen_dtypes = []
        self.past_names = [
            f"past_key_values.{layer}.{kind}"
            for layer in range(NUM_HIDDEN_LAYERS)
            for kind in ("key", "value")
        ]
        self.output_names = ["logits"] + [
            f"present.{layer}.{kind}"
            for layer in range(NUM_HIDDEN_LAYERS)
            for kind in ("key", "value")
        ]

    def get_inputs(self):
        declared = "tensor(float16)" if self.float_dtype == np.float16 else None
        return [
            Input("inputs_embeds", declared),
            Input("attention_mask"),
            *[Input(name, declared) for name in self.past_names],
        ]

    def get_outputs(self):
        return [Input(name) for name in self.output_names]

    def run(self, _, feed):
        embeds = feed["inputs_embeds"]
        mask = feed["attention_mask"]
        past = feed[self.past_names[0]]
        batch, width, _ = embeds.shape
        total = past.shape[2] + width
        if mask.shape != (batch, total):
            raise AssertionError(f"attention_mask {mask.shape} does not cover {total} key positions")
        self.seen_masks.append(mask.copy())
        self.seen_dtypes.append((embeds.dtype, past.dtype))

        signature = embeds[:, :, 0]
        fresh = np.broadcast_to(
            signature[:, None, :, None], (batch, NUM_KEY_VALUE_HEADS, width, HEAD_DIM)
        )
        present = np.concatenate((past, fresh.astype(past.dtype)), axis=2)

        logits = np.zeros((batch, width, VOCAB), dtype=np.float32)
        for row in range(batch):
            visible = np.nonzero(mask[row])[0]
            seed = int(round(float(present[row, 0, visible[0], 0])))
            script = self.scripts.get(seed)
            if script is None:
                raise AssertionError(f"row {row} carried an unrecognised seed {seed}")
            prefix = self.prefix_lengths.setdefault(seed, len(visible))
            offset = len(visible) - prefix
            token = script[offset] if offset < len(script) else STOP_SPEECH_TOKEN
            logits[row, -1, token] = 10.0

        return [logits, *[present] * len(self.past_names)]


class BindableLanguageModel(ScriptedLanguageModel):
    def io_binding(self):
        return FakeIoBinding()

    def run_with_iobinding(self, binding):
        binding.results = [FakeOrtValue(value) for value in self.run(None, binding.inputs)]


class FakeOrtValue:
    def __init__(self, array):
        self._array = array

    def numpy(self):
        return self._array


class FakeIoBinding:
    def __init__(self):
        self.inputs = {}
        self.bound_outputs = []
        self.results = []

    def bind_cpu_input(self, name, array):
        self.inputs[name] = array

    def bind_ortvalue_input(self, name, value):
        self.inputs[name] = value.numpy()

    def bind_output(self, name, device, device_id=0):
        assert device == "cuda", device
        self.bound_outputs.append(name)

    def get_outputs(self):
        return self.results


class RecordingDecoder:
    def __init__(self):
        self.calls = []

    def get_inputs(self):
        return [Input("speech_tokens"), Input("speaker_embeddings"), Input("speaker_features")]

    def run(self, _, feed):
        tokens = feed["speech_tokens"]
        self.calls.append(tokens.copy())
        width = tokens.shape[1]
        return [np.linspace(0.1, 0.2, width, dtype=np.float32).reshape(1, width)]


def speaker_prompt(seed, prompt_width=1, cond_width=1):
    cond_emb = np.zeros((1, cond_width, HIDDEN), dtype=np.float32)
    cond_emb[0, 0, 0] = float(seed)
    prompt_token = np.full((1, prompt_width), START_SPEECH_TOKEN, dtype=np.int64)
    return (cond_emb, prompt_token, np.zeros((1, 2), dtype=np.float32), np.zeros((1, 2), dtype=np.float32))


def build_engine(language_model, decoder=None, embed=None, speakers=None, uses_cuda=False):
    engine = ChatterboxEngine.__new__(ChatterboxEngine)
    engine.sample_rate = 24000
    engine.tokenizer = WordTokenizer()
    engine.uses_cuda = uses_cuda
    engine.sessions = {
        "embed_tokens": embed if embed is not None else BatchEmbedSession(),
        "language_model": language_model,
        "conditional_decoder": decoder if decoder is not None else RecordingDecoder(),
    }
    engine.speakers_cache = dict(speakers or {})
    engine._ensure_loaded = lambda: None
    return engine


class ChatterboxPipelineTests(unittest.TestCase):
    def test_generate_runs_embedding_language_model_and_decoder(self):
        engine = ChatterboxEngine.__new__(ChatterboxEngine)
        engine.sample_rate = 24000
        engine.tokenizer = Tokenizer()
        embed = EmbedSession()
        language_model = LanguageModelSession()
        decoder = DecoderSession()
        engine.sessions = {
            "embed_tokens": embed,
            "language_model": language_model,
            "conditional_decoder": decoder,
        }
        engine.speakers_cache = {
            "voice@2": (
                np.zeros((1, 1, HIDDEN), dtype=np.float32),
                np.array([[START_SPEECH_TOKEN]], dtype=np.int64),
                np.zeros((1, 2), dtype=np.float32),
                np.zeros((1, 2), dtype=np.float32),
            )
        }
        engine._ensure_loaded = lambda: None

        audio = engine.generate("Hello", voice_id="voice@2", exaggeration=0.7, speed=1.0)

        self.assertEqual(language_model.calls, 2)
        for value in embed.exaggerations:
            self.assertAlmostEqual(value, 0.7)
        self.assertEqual(
            decoder.feed["speech_tokens"].tolist(),
            [[START_SPEECH_TOKEN, 42, SILENCE_TOKEN, SILENCE_TOKEN, SILENCE_TOKEN]],
        )
        np.testing.assert_allclose(audio, np.array([0.1, -0.1, 0.2], dtype=np.float32))

    def test_generate_returns_empty_for_unspeakable_or_empty_text(self):
        engine = ChatterboxEngine.__new__(ChatterboxEngine)
        engine.sample_rate = 24000
        engine.speakers_cache = {}
        engine._ensure_loaded = lambda: None

        for unspeakable in ("", "   ", "...", "--", "( )", "!?", "- - -"):
            audio = engine.generate(unspeakable, voice_id="voice@2")
            self.assertEqual(len(audio), 0)
            self.assertEqual(audio.dtype, np.float32)


class BatchedDecodeTests(unittest.TestCase):
    SCRIPTS = {7: [101, 102, 103], 8: [201], 9: [301, 302]}
    ROWS = [
        {"text": "one two three four", "voice_id": "seven", "exaggeration": 0.5, "speed": 1.0},
        {"text": "solo", "voice_id": "eight", "exaggeration": 0.5, "speed": 1.0},
        {"text": "a slightly longer line here", "voice_id": "nine", "exaggeration": 0.5, "speed": 1.0},
    ]
    SPEAKERS = {
        "seven": speaker_prompt(7, prompt_width=1, cond_width=1),
        "eight": speaker_prompt(8, prompt_width=2, cond_width=3),
        "nine": speaker_prompt(9, prompt_width=1, cond_width=2),
    }

    def render_one_at_a_time(self):
        rendered = []
        for row in self.ROWS:
            decoder = RecordingDecoder()
            engine = build_engine(
                ScriptedLanguageModel(self.SCRIPTS), decoder=decoder, speakers=self.SPEAKERS
            )
            audio = engine.generate_batch([row])[0]
            self.assertNotIsInstance(audio, Exception)
            rendered.append((decoder.calls[0], audio))
        return rendered

    def test_batched_render_matches_one_line_at_a_time(self):
        solo = self.render_one_at_a_time()

        decoder = RecordingDecoder()
        engine = build_engine(
            ScriptedLanguageModel(self.SCRIPTS), decoder=decoder, speakers=self.SPEAKERS
        )
        batched = engine.generate_batch(list(self.ROWS))

        self.assertEqual(len(decoder.calls), len(self.ROWS))
        for index, ((solo_tokens, solo_audio), batch_audio) in enumerate(zip(solo, batched)):
            self.assertNotIsInstance(batch_audio, Exception)
            np.testing.assert_array_equal(
                decoder.calls[index], solo_tokens, err_msg=f"row {index} token mismatch"
            )
            np.testing.assert_allclose(batch_audio, solo_audio, err_msg=f"row {index} audio mismatch")

        # The scripts differ in length, so this also proves a row that stopped
        # early is not still contributing tokens while its neighbours run on.
        self.assertEqual(
            [tokens.shape[1] for tokens in decoder.calls],
            [1 + 3 + 3, 2 + 1 + 3, 1 + 2 + 3],
        )

    def test_shorter_rows_are_left_padded_and_masked_off(self):
        language_model = ScriptedLanguageModel(self.SCRIPTS)
        engine = build_engine(language_model, speakers=self.SPEAKERS)
        engine.generate_batch(list(self.ROWS))

        prefixes = [
            self.SPEAKERS[row["voice_id"]][0].shape[1] + len(row["text"].split())
            for row in self.ROWS
        ]
        width = max(prefixes)
        # The first batched call is the first decode step: one key position has
        # already been appended for the token the prefill produced.
        first_decode_mask = next(mask for mask in language_model.seen_masks if mask.shape[0] == len(self.ROWS))
        self.assertEqual(first_decode_mask.shape, (len(self.ROWS), width + 1))
        for row, prefix in enumerate(prefixes):
            np.testing.assert_array_equal(
                first_decode_mask[row],
                np.array([0] * (width - prefix) + [1] * (prefix + 1), dtype=np.int64),
                err_msg=f"row {row} padding is not masked off on the left",
            )

    def test_device_resident_cache_produces_the_same_tokens(self):
        host_decoder = RecordingDecoder()
        host_engine = build_engine(
            ScriptedLanguageModel(self.SCRIPTS), decoder=host_decoder, speakers=self.SPEAKERS
        )
        host_engine.generate_batch(list(self.ROWS))

        bound_model = BindableLanguageModel(self.SCRIPTS)
        bound_decoder = RecordingDecoder()
        bound_engine = build_engine(
            bound_model, decoder=bound_decoder, speakers=self.SPEAKERS, uses_cuda=True
        )
        bound_engine._decode_runner = lambda session, past_names, past: _BoundDecodeRunner(
            session, past_names, past, ortvalue_factory=lambda array, device, index: FakeOrtValue(array)
        )
        bound_engine.generate_batch(list(self.ROWS))

        self.assertEqual(len(bound_decoder.calls), len(host_decoder.calls))
        for index, (bound, host) in enumerate(zip(bound_decoder.calls, host_decoder.calls)):
            np.testing.assert_array_equal(bound, host, err_msg=f"row {index} diverged on the bound path")

    def test_bound_runner_is_selected_only_on_cuda(self):
        with mock.patch("engine_chatterbox._BoundDecodeRunner") as bound:
            engine = build_engine(BindableLanguageModel(self.SCRIPTS), speakers=self.SPEAKERS, uses_cuda=False)
            engine.generate_batch([self.ROWS[0]])
            bound.assert_not_called()

        with mock.patch("engine_chatterbox._BoundDecodeRunner") as bound:
            bound.side_effect = RuntimeError("no device")
            engine = build_engine(BindableLanguageModel(self.SCRIPTS), speakers=self.SPEAKERS, uses_cuda=True)
            # The host runner has to take over rather than failing the render.
            self.assertNotIsInstance(engine.generate_batch([self.ROWS[0]])[0], Exception)
            bound.assert_called_once()

    def test_one_unrenderable_row_does_not_lose_its_neighbours(self):
        rows = [
            self.ROWS[0],
            {"text": "no voice for this", "voice_id": "missing", "exaggeration": 0.5, "speed": 1.0},
            self.ROWS[2],
        ]
        engine = build_engine(ScriptedLanguageModel(self.SCRIPTS), speakers=self.SPEAKERS)
        results = engine.generate_batch(rows)

        self.assertIsInstance(results[0], np.ndarray)
        self.assertIsInstance(results[1], Exception)
        self.assertIn("has no reference recording", str(results[1]))
        self.assertIsInstance(results[2], np.ndarray)

    def test_a_failing_batch_is_retried_row_by_row(self):
        class PoisonedModel(ScriptedLanguageModel):
            def run(self, _, feed):
                if feed["inputs_embeds"].shape[0] > 1:
                    raise RuntimeError("batched decode exploded")
                return super().run(None, feed)

        decoder = RecordingDecoder()
        engine = build_engine(PoisonedModel(self.SCRIPTS), decoder=decoder, speakers=self.SPEAKERS)
        results = engine.generate_batch(list(self.ROWS))

        for index, audio in enumerate(results):
            self.assertIsInstance(audio, np.ndarray, msg=f"row {index} was not recovered")
        self.assertEqual(len(decoder.calls), len(self.ROWS))

    def test_rows_are_grouped_by_exaggeration(self):
        rows = [
            dict(self.ROWS[0], exaggeration=0.25),
            dict(self.ROWS[1], exaggeration=0.75),
            dict(self.ROWS[2], exaggeration=0.25),
        ]
        embed = BatchEmbedSession()
        decoder = RecordingDecoder()
        engine = build_engine(
            ScriptedLanguageModel(self.SCRIPTS), decoder=decoder, embed=embed, speakers=self.SPEAKERS
        )
        results = engine.generate_batch(rows)

        for audio in results:
            self.assertIsInstance(audio, np.ndarray)
        # Each value reached the embedding graph unmixed; nothing was rendered
        # under a neighbour's setting.
        self.assertEqual(set(embed.exaggerations), {0.25, 0.75})

    def test_language_model_half_precision_contract_is_honoured(self):
        language_model = ScriptedLanguageModel(self.SCRIPTS, float_dtype=np.float16)
        engine = build_engine(language_model, speakers=self.SPEAKERS)
        results = engine.generate_batch(list(self.ROWS))

        for audio in results:
            self.assertIsInstance(audio, np.ndarray)
        self.assertTrue(language_model.seen_dtypes)
        for embeds_dtype, past_dtype in language_model.seen_dtypes:
            self.assertEqual(embeds_dtype, np.float16)
            self.assertEqual(past_dtype, np.float16)

    def test_generation_runs_to_the_ceiling_instead_of_stopping_at_512(self):
        engine = build_engine(ScriptedLanguageModel({7: [101] * 40}), speakers=self.SPEAKERS)
        decoder = engine.sessions["conditional_decoder"]

        results = engine.generate_batch([self.ROWS[0]], max_new_tokens=6)
        self.assertIsInstance(results[0], np.ndarray)
        prompt_width = self.SPEAKERS["seven"][1].shape[1]
        self.assertEqual(decoder.calls[0].shape[1], prompt_width + 6 + 3)


class GpuContractTests(unittest.TestCase):
    def _load_with_providers(self, providers, require_gpu):
        engine = ChatterboxEngine(models_dir="/nonexistent", require_gpu=require_gpu)
        fake_ort = types.SimpleNamespace(
            get_available_providers=lambda: list(providers),
            SessionOptions=lambda: types.SimpleNamespace(graph_optimization_level=None),
            GraphOptimizationLevel=types.SimpleNamespace(ORT_ENABLE_ALL=99),
            InferenceSession=lambda *args, **kwargs: None,
        )
        with mock.patch.dict(sys.modules, {"onnxruntime": fake_ort}):
            engine._ensure_loaded()

    def test_cpu_only_worker_refuses_to_start_when_a_gpu_was_paid_for(self):
        with self.assertRaisesRegex(RuntimeError, "CUDAExecutionProvider"):
            self._load_with_providers(["CPUExecutionProvider"], require_gpu=True)

    def test_cpu_only_worker_is_allowed_when_explicitly_requested(self):
        # Reaching the tokenizer means the provider gate let it past; the model
        # directory does not exist, so loading fails after that point.
        transformers = types.SimpleNamespace(
            AutoTokenizer=types.SimpleNamespace(
                from_pretrained=mock.Mock(side_effect=OSError("no tokenizer here"))
            )
        )
        with mock.patch.dict(sys.modules, {"transformers": transformers}):
            with self.assertRaisesRegex(RuntimeError, "Could not load the Chatterbox tokenizer"):
                self._load_with_providers(["CPUExecutionProvider"], require_gpu=False)


if __name__ == "__main__":
    unittest.main()
