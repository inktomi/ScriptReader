import sys
import types
import unittest
from unittest import mock
import numpy as np

# Mock torch if running in a lightweight test environment without CUDA
fake_torch = types.SimpleNamespace(
    cuda=types.SimpleNamespace(is_available=lambda: False),
    inference_mode=lambda: mock.MagicMock(__enter__=lambda s: s, __exit__=lambda *a: None),
    backends=types.SimpleNamespace(
        cuda=types.SimpleNamespace(matmul=types.SimpleNamespace(allow_tf32=True)),
        cudnn=types.SimpleNamespace(allow_tf32=True),
    ),
)
sys.modules.setdefault("torch", fake_torch)
fake_kokoro = types.SimpleNamespace(KPipeline=None)
sys.modules.setdefault("kokoro", fake_kokoro)
if not hasattr(sys.modules["kokoro"], "KPipeline"):
    sys.modules["kokoro"].KPipeline = None

from engine_kokoro import KokoroEngine  # noqa: E402


class FakeKPipeline:
    def __init__(self, lang_code='a', device='cpu'):
        self.lang_code = lang_code
        self.device = device
        self.recorded_calls = []

    def __call__(self, text, voice='af_heart', speed=1.0, split_pattern=None):
        self.recorded_calls.append({
            "text": text,
            "voice": voice,
            "speed": speed,
            "split_pattern": split_pattern,
        })
        # Yield (graphemes, phonemes, audio_array)
        yield "Warm up.", "wɔːm ʌp", np.full(2400, 0.1, dtype=np.float32)


class KokoroEngineTests(unittest.TestCase):
    def setUp(self):
        self.pipelines_instantiated = {}

        def mock_kpipeline_factory(lang_code='a', device='cpu'):
            pipe = FakeKPipeline(lang_code=lang_code, device=device)
            self.pipelines_instantiated[lang_code] = pipe
            return pipe

        self.mock_factory = mock_kpipeline_factory

    def test_voice_prefix_routing(self):
        with mock.patch("kokoro.KPipeline", side_effect=self.mock_factory):
            engine = KokoroEngine(require_gpu=False)

            # 1. American voices (af_*, am_*) route to lang_code='a'
            engine.generate("American text.", voice="af_heart")
            self.assertIn("a", engine.pipelines)
            self.assertEqual(engine.pipelines["a"].lang_code, "a")

            engine.generate("American male text.", voice="am_adam")
            self.assertEqual(len(engine.pipelines["a"].recorded_calls), 2)

            # 2. British voices (bf_*, bm_*) route to lang_code='b'
            engine.generate("British text.", voice="bf_emma")
            self.assertIn("b", engine.pipelines)
            self.assertEqual(engine.pipelines["b"].lang_code, "b")

            engine.generate("British male text.", voice="bm_george")
            self.assertEqual(len(engine.pipelines["b"].recorded_calls), 2)

    def test_warmup_initializes_both_american_and_british_pipelines(self):
        with mock.patch("kokoro.KPipeline", side_effect=self.mock_factory):
            engine = KokoroEngine(require_gpu=False)
            self.assertEqual(len(engine.pipelines), 0)

            engine.warmup()

            # Verify both pipelines 'a' and 'b' were constructed and warmed
            self.assertIn("a", engine.pipelines)
            self.assertIn("b", engine.pipelines)
            self.assertEqual(len(engine.pipelines["a"].recorded_calls), 1)
            self.assertEqual(len(engine.pipelines["b"].recorded_calls), 1)
            self.assertEqual(engine.pipelines["a"].recorded_calls[0]["voice"], "af_heart")
            self.assertEqual(engine.pipelines["b"].recorded_calls[0]["voice"], "bf_emma")

    def test_empty_or_whitespace_text_returns_empty_array(self):
        engine = KokoroEngine(require_gpu=False)
        for invalid_text in ("", "   ", "\n\t", "..."):
            audio = engine.generate(invalid_text, voice="bf_emma")
            self.assertEqual(len(audio), 0)
            self.assertEqual(audio.dtype, np.float32)


if __name__ == "__main__":
    unittest.main()
