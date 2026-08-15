import io
import sys
import types
import unittest
from unittest import mock

import numpy as np


class FakeInferenceMode:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class FakeTensor:
    def __init__(self, array):
        self._array = np.asarray(array, dtype=np.float32)

    def detach(self):
        return self

    def cpu(self):
        return self

    def squeeze(self):
        return self

    def numpy(self):
        return self._array


# Mock torch and soundfile if not installed in test environment
fake_torch = types.SimpleNamespace(
    cuda=types.SimpleNamespace(is_available=lambda: False),
    inference_mode=lambda: FakeInferenceMode(),
    backends=types.SimpleNamespace(
        cuda=types.SimpleNamespace(matmul=types.SimpleNamespace(allow_tf32=True)),
        cudnn=types.SimpleNamespace(allow_tf32=True),
    ),
    Tensor=FakeTensor,
)
sys.modules.setdefault("torch", fake_torch)
sys.modules.setdefault("soundfile", types.SimpleNamespace())
sys.modules.setdefault("librosa", types.SimpleNamespace(
    effects=types.SimpleNamespace(time_stretch=lambda y, rate: y)
))

from engine_chatterbox import ChatterboxEngine  # noqa: E402


class FakeChatterboxModel:
    def __init__(self, sr=24000):
        self.sr = sr
        self.conds = None
        self.recorded_calls = []

    def prepare_conditionals(self, wav_path, exaggeration=0.5):
        self.conds = ("fake_conds", wav_path, exaggeration)

    def generate(
        self,
        text,
        audio_prompt_path=None,
        language_id="en",
        exaggeration=0.5,
        cfg_weight=0.5,
        temperature=0.8,
        repetition_penalty=1.2,
        min_p=0.05,
        top_p=1.0,
    ):
        self.recorded_calls.append({
            "text": text,
            "language_id": language_id,
            "exaggeration": exaggeration,
            "cfg_weight": cfg_weight,
            "temperature": temperature,
            "repetition_penalty": repetition_penalty,
            "min_p": min_p,
            "top_p": top_p,
            "conds": self.conds,
        })
        # 100 samples of 0.25 float
        return FakeTensor(np.full(100, 0.25, dtype=np.float32))


class FakeSoundFile:
    @staticmethod
    def read(buffer, dtype="float32"):
        return np.full(2400, 0.1, dtype=np.float32), 24000

    @staticmethod
    def write(target, audio, sample_rate, format=None, subtype=None):
        pass


class ChatterboxEngineTests(unittest.TestCase):
    def setUp(self):
        self.fake_model = FakeChatterboxModel()

    def _build_engine(self, require_gpu=False):
        engine = ChatterboxEngine(require_gpu=require_gpu)
        engine.model = self.fake_model
        engine.device = "cpu"
        engine._initialized = True
        return engine

    def test_generate_runs_with_registered_speaker_conditionals(self):
        engine = self._build_engine()

        with mock.patch("engine_chatterbox.sf", FakeSoundFile):
            engine.register_speaker_reference("speaker_1", b"fake_wav_bytes")

        self.assertIn("speaker_1", engine.speakers_cache)
        self.assertIsNotNone(engine.speakers_cache["speaker_1"])

        audio = engine.generate(
            text="Hello world.",
            voice_id="speaker_1",
            exaggeration=0.65,
            speed=1.0,
            language_id="fr",
        )

        self.assertIsInstance(audio, np.ndarray)
        self.assertEqual(len(audio), 100)
        self.assertEqual(len(self.fake_model.recorded_calls), 1)

        call = self.fake_model.recorded_calls[0]
        self.assertEqual(call["text"], "Hello world.")
        self.assertEqual(call["language_id"], "fr")
        self.assertEqual(call["exaggeration"], 0.65)
        self.assertEqual(call["cfg_weight"], 0.5)
        self.assertEqual(call["temperature"], 0.8)
        self.assertEqual(call["min_p"], 0.05)
        self.assertEqual(call["repetition_penalty"], 1.2)

    def test_generate_returns_empty_for_unspeakable_or_empty_text(self):
        engine = self._build_engine()

        for unspeakable in ("", "   ", "...", "--", "( )", "!?", "- - -"):
            audio = engine.generate(unspeakable, voice_id="voice@2")
            self.assertEqual(len(audio), 0)
            self.assertEqual(audio.dtype, np.float32)

    def test_missing_reference_raises_runtime_error(self):
        engine = self._build_engine()
        with self.assertRaisesRegex(RuntimeError, "has no reference recording"):
            engine.generate("Hello there.", voice_id="unregistered_voice")

    def test_batched_render_isolates_failures_per_line(self):
        engine = self._build_engine()
        engine.speakers_cache["voice_good"] = ("mock_conds",)

        items = [
            {"text": "Line one.", "voice_id": "voice_good", "exaggeration": 0.5},
            {"text": "Line two.", "voice_id": "voice_missing", "exaggeration": 0.5},
            {"text": "Line three.", "voice_id": "voice_good", "exaggeration": 0.5},
            {"text": "...", "voice_id": "voice_good", "exaggeration": 0.5},
        ]

        results = engine.generate_batch(items)

        self.assertEqual(len(results), 4)
        self.assertIsInstance(results[0], np.ndarray)
        self.assertEqual(len(results[0]), 100)
        self.assertIsInstance(results[1], Exception)
        self.assertIn("has no reference recording", str(results[1]))
        self.assertIsInstance(results[2], np.ndarray)
        self.assertEqual(len(results[2]), 100)
        self.assertIsInstance(results[3], np.ndarray)
        self.assertEqual(len(results[3]), 0)

    def test_speed_modification_applies_time_stretch(self):
        engine = self._build_engine()
        engine.speakers_cache["voice_good"] = ("mock_conds",)

        with mock.patch("librosa.effects.time_stretch", return_value=np.full(80, 0.25, dtype=np.float32)) as stretch:
            audio = engine.generate("Line text.", voice_id="voice_good", speed=1.25)
            self.assertEqual(len(audio), 80)
            stretch.assert_called_once()

    def test_gpu_requirement_enforcement(self):
        engine = ChatterboxEngine(require_gpu=True)
        engine.device = "cpu"
        with self.assertRaisesRegex(RuntimeError, "Chatterbox requires a CUDA device"):
            engine._ensure_loaded()

    def test_warmup_executes_and_cleans_cache(self):
        engine = self._build_engine()
        with mock.patch("engine_chatterbox.sf", FakeSoundFile):
            engine.warmup()
        self.assertNotIn("__warmup__", engine.speakers_cache)


if __name__ == "__main__":
    unittest.main()
