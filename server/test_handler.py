import sys
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _test_stubs  # noqa: F401, E402  (installs the stubs)
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

    def test_encode_result_does_not_mutate_the_callers_array(self):
        """np.asarray returns a view for float32, so sanitizing must copy first."""
        unit = {"id": "line-shared", "text": "Shared buffer"}
        raw_audio = np.array([-2.5, np.nan, 0.5, np.inf], dtype=np.float32)
        original = raw_audio.copy()

        with mock.patch("handler.sf.write", side_effect=lambda buf, *a, **k: buf.write(b"RIFF")):
            _encode_result(unit, raw_audio, sr=24000)

        self.assertEqual(raw_audio[0], original[0], "caller's sample was clamped in place")
        self.assertTrue(np.isnan(raw_audio[1]), "caller's NaN was overwritten in place")
        self.assertTrue(np.isinf(raw_audio[3]), "caller's Inf was overwritten in place")

    def test_encode_result_handles_zero_dimensional_audio(self):
        """A single sample can arrive 0-d, which has no len() and breaks np.clip(out=)."""
        unit = {"id": "line-scalar", "text": "One sample"}

        captured = []

        def mock_write(buf, audio, sr, format=None, subtype=None):
            captured.append(audio)
            buf.write(b"RIFF_MOCK_WAV")

        with mock.patch("handler.sf.write", side_effect=mock_write):
            result = _encode_result(unit, np.float32(0.5), sr=24000)

        self.assertNotIn("error", result)
        self.assertEqual(captured[0].ndim, 1)
        self.assertEqual(len(captured[0]), 1)
        self.assertEqual(captured[0][0], 0.5)

    def test_encode_result_marks_silent_audio_as_a_client_error(self):
        unit = {"id": "line-silent", "text": "..."}
        result = _encode_result(unit, np.zeros(100, dtype=np.float32))
        self.assertIn("empty or silent audio", result["error"])
        self.assertTrue(result["client_error"])

    def test_openai_speech_returns_json_error_on_invalid_input(self):
        import asyncio
        import json
        from handler import openai_speech

        class FakeRequest:
            def __init__(self, body_bytes):
                self._body = body_bytes

            async def stream(self):
                yield self._body

        # Empty text input error
        req = FakeRequest(json.dumps({"input": "", "model": "tts-1"}).encode("utf-8"))
        res = asyncio.run(openai_speech(req))
        self.assertEqual(res.status_code, 400)
        body = json.loads(res.body.decode("utf-8"))
        self.assertIn("error", body)
        self.assertIn("text must not be empty", body["error"])

    def test_openai_speech_returns_400_for_missing_voice_reference(self):
        """An unregistered voice is the caller's to fix, so it must not read 5xx."""
        import asyncio
        import json
        import handler
        from handler import openai_speech

        class FakeRequest:
            async def stream(self):
                yield json.dumps({
                    "input": "Hello",
                    "engine": "chatterbox",
                    "voice_id": "unregistered",
                }).encode("utf-8")

        class FakeChatterbox:
            def generate_batch(self, items):
                return [RuntimeError("Chatterbox voice 'unregistered' has no reference recording")]

        # Without this the real engine is constructed, and the 400 under test
        # comes from "requires a CUDA device" rather than the missing reference.
        with mock.patch.object(handler, "get_chatterbox", FakeChatterbox):
            res = asyncio.run(openai_speech(FakeRequest()))

        self.assertEqual(res.status_code, 400)
        body = json.loads(res.body.decode("utf-8"))
        self.assertIn("has no reference recording", body["error"])

    def test_openai_speech_returns_500_for_worker_failure(self):
        """A worker fault must stay retryable: 400 would tell the client to give up."""
        import asyncio
        import json
        import handler
        from handler import openai_speech

        class FakeRequest:
            async def stream(self):
                yield json.dumps({
                    "input": "Hello",
                    "engine": "chatterbox",
                    "voice_id": "some-voice",
                }).encode("utf-8")

        class BrokenChatterbox:
            def generate_batch(self, items):
                raise RuntimeError("CUDA out of memory")

        with mock.patch.object(handler, "get_chatterbox", BrokenChatterbox):
            res = asyncio.run(openai_speech(FakeRequest()))

        self.assertEqual(res.status_code, 500)
        body = json.loads(res.body.decode("utf-8"))
        self.assertIn("CUDA out of memory", body["error"])


if __name__ == "__main__":
    unittest.main()
