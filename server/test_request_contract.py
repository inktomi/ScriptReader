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
    normalize_item,
    read_bounded_json,
    validate_batch,
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

    def test_worker_image_includes_request_contract(self):
        dockerfile = Path(__file__).with_name("Dockerfile").read_text(encoding="utf-8")
        self.assertIn("COPY request_contract.py .", dockerfile)

    def test_http_json_reader_counts_streamed_bytes(self):
        request = FakeRequest([b"{\"text\":\"", b"x" * MAX_HTTP_REQUEST_BYTES, b"\"}"])
        with self.assertRaisesRegex(InputError, "request body is too large"):
            asyncio.run(read_bounded_json(request))


if __name__ == "__main__":
    unittest.main()
