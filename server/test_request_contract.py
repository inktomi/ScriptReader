import asyncio
import base64
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np


# Importing handler pulls in the engines, which must not require CUDA, PyTorch
# or libsndfile just to check the request contract. Declared here as well as in
# the engine tests so this file can be run on its own.
sys.modules.setdefault("torch", types.SimpleNamespace(
    cuda=types.SimpleNamespace(is_available=lambda: False)
))
sys.modules.setdefault("soundfile", types.SimpleNamespace())

from request_contract import (  # noqa: E402
    InputError,
    MAX_BATCH_ITEMS,
    MAX_HTTP_REQUEST_BYTES,
    MAX_REFERENCE_AUDIO_BYTES,
    MAX_TEXT_CHARS,
    MAX_VOICE_REGISTRATIONS,
    normalize_item,
    read_bounded_json,
    validate_batch,
    validate_voice_registration,
)


class FakeRequest:
    def __init__(self, chunks):
        self._chunks = chunks

    async def stream(self):
        for chunk in self._chunks:
            yield chunk


class RequestContractTests(unittest.TestCase):
    def test_malformed_item_is_rejected_without_preventing_neighbor_validation(self):
        items = [
            {"id": "good", "text": "Hello", "speed": 1.0},
            {"id": "bad", "text": "Nope", "speed": "fast"},
        ]

        results = []
        for item in validate_batch(items):
            try:
                results.append({"id": item["id"], "value": normalize_item(item)})
            except InputError as error:
                results.append({"id": item.get("id"), "error": str(error)})

        self.assertEqual(results[0]["value"]["text"], "Hello")
        self.assertIn("speed must be a number", results[1]["error"])

    def test_text_reference_and_batch_bounds_are_enforced(self):
        with self.assertRaisesRegex(InputError, "text exceeds"):
            normalize_item({"text": "x" * (MAX_TEXT_CHARS + 1)})
        too_large_reference = base64.b64encode(b"x" * (MAX_REFERENCE_AUDIO_BYTES + 1)).decode()
        with self.assertRaisesRegex(InputError, "reference audio is too large"):
            normalize_item({"text": "hello", "reference_audio_b64": too_large_reference})
        with self.assertRaisesRegex(InputError, "batch exceeds"):
            validate_batch([{"text": "hello"}] * (MAX_BATCH_ITEMS + 1))

    def test_chatterbox_prefers_revisioned_worker_cache_identity(self):
        chatterbox = normalize_item({
            "engine": "chatterbox",
            "text": "Hello",
            "voice": "studio-alice",
            "voice_id": "studio-alice@4@runpod:endpoint-a",
        })
        kokoro = normalize_item({
            "engine": "kokoro",
            "text": "Hello",
            "voice": "af_heart",
            "voice_id": "ignored-cache-identity",
        })

        self.assertEqual(chatterbox["voice"], "studio-alice@4@runpod:endpoint-a")
        self.assertEqual(kokoro["voice"], "af_heart")

    def test_voice_registration_validates_and_decodes_audio(self):
        sample_audio = base64.b64encode(b"RIFF....WAVEfmt ").decode()
        validated = validate_voice_registration([
            {
                "voice_id": "studio-alice@1@runpod:ep-1",
                "reference_audio_b64": sample_audio,
            }
        ])
        self.assertEqual(len(validated), 1)
        self.assertEqual(validated[0]["voice_id"], "studio-alice@1@runpod:ep-1")
        self.assertEqual(validated[0]["reference_audio"], b"RIFF....WAVEfmt ")

        with self.assertRaisesRegex(InputError, "voices must be an array"):
            validate_voice_registration("not-a-list")
        with self.assertRaisesRegex(InputError, "voices array must not be empty"):
            validate_voice_registration([])
        with self.assertRaisesRegex(InputError, "reference_audio_b64 is required"):
            validate_voice_registration([{"voice_id": "voice-1"}])
        with self.assertRaisesRegex(InputError, "voice_id must be a non-empty string"):
            validate_voice_registration([{"voice_id": "", "reference_audio_b64": sample_audio}])

    def test_worker_image_includes_request_contract(self):
        dockerfile = Path(__file__).with_name("Dockerfile").read_text(encoding="utf-8")
        self.assertIn("COPY request_contract.py .", dockerfile)

    def test_http_json_reader_counts_streamed_bytes(self):
        request = FakeRequest([b"{\"text\":\"", b"x" * MAX_HTTP_REQUEST_BYTES, b"\"}"])
        with self.assertRaisesRegex(InputError, "request body is too large"):
            asyncio.run(read_bounded_json(request))

    def test_runpod_handler_voice_registration(self):
        from handler import runpod_handler
        sample_audio = base64.b64encode(b"not-a-wav-but-valid-b64").decode()

        # Malformed audio returns error object instead of crashing
        res = runpod_handler({
            "input": {
                "action": "register_voices",
                "voices": [{"voice_id": "v1", "reference_audio_b64": sample_audio}],
            }
        })
        self.assertEqual(res["registered"], 0)
        self.assertIn("error", res)

        # Invalid payload type returns error object
        res_invalid = runpod_handler({
            "input": {
                "action": "register_voices",
                "register_voices": True,
                "voices": "not-a-list",
            }
        })
        self.assertEqual(res_invalid["registered"], 0)
        self.assertIn("error", res_invalid)


class FakeSoundFile:
    @staticmethod
    def write(buffer, audio, sample_rate, format=None, subtype=None):
        buffer.write(b"RIFF" + len(audio).to_bytes(4, "little") + b"WAVE")


class HandlerBatchTests(unittest.TestCase):
    def test_chatterbox_lines_render_in_one_batched_engine_call(self):
        import handler

        recorded = []

        class FakeChatterbox:
            def generate_batch(self, items, max_new_tokens=None):
                recorded.append(items)
                return [np.full(2400, 0.5, dtype=np.float32), RuntimeError("this line failed")]

        class FakeKokoro:
            def generate(self, text, voice, speed):
                return np.full(1200, 0.25, dtype=np.float32)

        with mock.patch.object(handler, "get_chatterbox", FakeChatterbox), \
             mock.patch.object(handler, "get_kokoro", FakeKokoro), \
             mock.patch.object(handler, "sf", FakeSoundFile):
            results = handler.process_units([
                {"id": "a", "engine": "chatterbox", "text": "Alpha", "voice_id": "studio@1"},
                {"id": "b", "engine": "kokoro", "text": "Bravo", "voice": "af_heart"},
                {"id": "c", "engine": "chatterbox", "text": "Charlie", "voice_id": "studio@1"},
                {"id": "d", "engine": "chatterbox", "text": "", "voice_id": "studio@1"},
            ])

        # Both Chatterbox lines reach the engine as one batch, and the Kokoro
        # line in between does not split them apart.
        self.assertEqual(len(recorded), 1)
        self.assertEqual([item["text"] for item in recorded[0]], ["Alpha", "Charlie"])

        # Results stay in request order regardless of how they were routed.
        self.assertEqual([result["id"] for result in results], ["a", "b", "c", "d"])
        self.assertTrue(results[0]["audio_base64"])
        self.assertTrue(results[1]["audio_base64"])
        self.assertIn("this line failed", results[2]["error"])
        self.assertIn("text must not be empty", results[3]["error"])

    def test_single_unit_path_shares_the_batch_implementation(self):
        import handler

        class FakeChatterbox:
            def generate_batch(self, items, max_new_tokens=None):
                return [np.full(2400, 0.5, dtype=np.float32)]

        with mock.patch.object(handler, "get_chatterbox", FakeChatterbox), \
             mock.patch.object(handler, "sf", FakeSoundFile):
            result = handler.process_single_unit(
                {"id": "solo", "engine": "chatterbox", "text": "Alone", "voice_id": "studio@1"}
            )

        self.assertEqual(result["id"], "solo")
        self.assertEqual(result["sample_rate"], 24000)
        self.assertTrue(result["audio_base64"])


if __name__ == "__main__":
    unittest.main()
