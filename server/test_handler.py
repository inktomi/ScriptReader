import base64
import io
import sys
import types
import unittest
from unittest import mock
import numpy as np

# Provide fake modules for headless testing if soundfile/torch are not installed
try:
    import soundfile as sf
except ImportError:
    sf = types.SimpleNamespace()
    sys.modules.setdefault("soundfile", sf)

sys.modules.setdefault("torch", types.SimpleNamespace(
    cuda=types.SimpleNamespace(is_available=lambda: False)
))

from handler import _encode_result  # noqa: E402


class HandlerEncodeResultTests(unittest.TestCase):
    def test_encode_result_clamps_out_of_bounds_amplitudes(self):
        unit = {"id": "line-1", "text": "Hello world"}
        # Array with severe overshoots and non-finite values
        raw_audio = np.array([-2.5, -1.01, -0.5, 0.0, 0.5, 1.01, 3.2, np.nan, np.inf, -np.inf], dtype=np.float32)

        captured_audio = []

        def mock_write(buf, audio, sr, format=None, subtype=None):
            captured_audio.append(audio.copy())
            buf.write(b"RIFF_MOCK_WAV")

        with mock.patch("handler.sf.write", side_effect=mock_write):
            result = _encode_result(unit, raw_audio, sr=24000)

        self.assertEqual(result["id"], "line-1")
        self.assertTrue(result["audio_base64"])
        self.assertEqual(len(captured_audio), 1)

        encoded = captured_audio[0]
        self.assertFalse(np.isnan(encoded).any(), "Encoded audio must not have NaNs")
        self.assertFalse(np.isinf(encoded).any(), "Encoded audio must not have Infs")
        self.assertTrue(np.all(encoded >= -1.0), "Encoded audio must be >= -1.0")
        self.assertTrue(np.all(encoded <= 1.0), "Encoded audio must be <= 1.0")
        self.assertEqual(encoded[0], -1.0)
        self.assertEqual(encoded[1], -1.0)
        self.assertEqual(encoded[5], 1.0)
        self.assertEqual(encoded[6], 1.0)
        self.assertEqual(encoded[7], 0.0)  # NaN converted to 0.0
        self.assertEqual(encoded[8], 1.0)  # +Inf converted to 1.0
        self.assertEqual(encoded[9], -1.0)  # -Inf converted to -1.0

    def test_encode_result_handles_all_nans_as_empty_audio(self):
        unit = {"id": "line-nan", "text": "Silent glitch"}
        raw_audio = np.full(100, np.nan, dtype=np.float32)

        result = _encode_result(unit, raw_audio, sr=24000)
        self.assertEqual(result["id"], "line-nan")
        self.assertIn("empty or silent audio", result["error"])
        self.assertEqual(result["audio_base64"], "")

    def test_encode_result_handles_multidimensional_audio(self):
        unit = {"id": "line-2d", "text": "Multi-dim"}
        raw_audio = np.ones((1, 2400), dtype=np.float32) * 0.5

        captured_audio = []

        def mock_write(buf, audio, sr, format=None, subtype=None):
            captured_audio.append(audio)
            buf.write(b"RIFF_MOCK_WAV")

        with mock.patch("handler.sf.write", side_effect=mock_write):
            result = _encode_result(unit, raw_audio, sr=24000)

        self.assertEqual(captured_audio[0].ndim, 1)
        self.assertEqual(len(captured_audio[0]), 2400)


if __name__ == "__main__":
    unittest.main()
