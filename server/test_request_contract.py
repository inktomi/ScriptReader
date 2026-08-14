import asyncio
import base64
import unittest
from pathlib import Path

from request_contract import (
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


if __name__ == "__main__":
    unittest.main()
