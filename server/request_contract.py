import base64
import binascii
import json
import math


MAX_TEXT_CHARS = 350
MAX_VOICE_ID_CHARS = 160
MAX_REFERENCE_AUDIO_BYTES = 1_000_000
MAX_REFERENCE_AUDIO_B64_CHARS = ((MAX_REFERENCE_AUDIO_BYTES + 2) // 3) * 4
MAX_BATCH_ITEMS = 128
MAX_BATCH_TEXT_CHARS = 40_000
MAX_HTTP_REQUEST_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_SECONDS = 60.0
MIN_SPEED = 0.5
MAX_SPEED = 2.0

ENGINE_ALIASES = {
    # Canonical engines
    "kokoro": "kokoro",
    "chatterbox": "chatterbox",
    # OpenAI model identifiers aliased to Kokoro
    "tts-1": "kokoro",
    "tts-1-hd": "kokoro",
    "tts-1-1106": "kokoro",
    "tts-1-hd-1106": "kokoro",
    "openai": "kokoro",
    "gpt-4o-mini-tts": "kokoro",
}


class InputError(ValueError):
    """A client-visible request-contract failure."""


def _bounded_number(value, *, name, default, minimum, maximum):
    try:
        number = float(default if value is None else value)
    except (TypeError, ValueError) as error:
        raise InputError(f"{name} must be a number") from error
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise InputError(f"{name} must be between {minimum} and {maximum}")
    return number


def _decode_reference(value):
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise InputError("reference_audio_b64 must be a Base64 string")
    if len(value) > MAX_REFERENCE_AUDIO_B64_CHARS:
        raise InputError("reference audio is too large")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise InputError("reference audio is not valid Base64") from error
    if len(decoded) > MAX_REFERENCE_AUDIO_BYTES:
        raise InputError("reference audio is too large")
    return decoded


def normalize_item(item):
    if not isinstance(item, dict):
        raise InputError("render item must be an object")

    raw_text = item.get("text")
    if raw_text is None or (isinstance(raw_text, str) and not raw_text.strip()):
        raw_text = item.get("input", "")
    if not isinstance(raw_text, str):
        raise InputError("text must be a string")
    text = raw_text.strip()
    if not text:
        raise InputError("text must not be empty")
    if len(text) > MAX_TEXT_CHARS:
        raise InputError(f"text exceeds {MAX_TEXT_CHARS} characters")

    raw_engine = item.get("engine") or item.get("model") or "chatterbox"
    if not isinstance(raw_engine, str):
        raise InputError("engine must be a string")
    engine_key = raw_engine.strip().lower()
    if engine_key not in ENGINE_ALIASES:
        raise InputError("engine must be 'kokoro' or 'chatterbox'")
    engine = ENGINE_ALIASES[engine_key]

    if engine == "chatterbox":
        # Chatterbox's worker-memory speaker cache must use the revisioned
        # identity supplied by the browser so a replaced local voice cannot
        # reuse the earlier prompt during the same script render.
        raw_voice = item.get("voice_id") or item.get("voice") or "default"
    else:
        raw_voice = item.get("voice") or item.get("voice_id") or "af_heart"
    if not isinstance(raw_voice, str) or not raw_voice.strip():
        raise InputError("voice must be a non-empty string")
    voice = raw_voice.strip()
    if len(voice) > MAX_VOICE_ID_CHARS:
        raise InputError("voice identifier is too long")

    raw_language = item.get("language_id") or item.get("language") or item.get("lang") or "en"
    if not isinstance(raw_language, str) or not raw_language.strip():
        raw_language = "en"
    language_id = raw_language.strip().lower()

    return {
        "id": item.get("id"),
        "text": text,
        "engine": engine,
        "voice": voice,
        "speed": _bounded_number(
            item.get("speed"), name="speed", default=1.0,
            minimum=MIN_SPEED, maximum=MAX_SPEED
        ),
        "exaggeration": _bounded_number(
            item.get("exaggeration"), name="exaggeration", default=0.5,
            minimum=0.0, maximum=1.0
        ),
        "language_id": language_id,
        "reference_audio": _decode_reference(item.get("reference_audio_b64")),
    }


def validate_batch(items):
    if not isinstance(items, list):
        raise InputError("batch must be an array")
    if len(items) > MAX_BATCH_ITEMS:
        raise InputError(f"batch exceeds {MAX_BATCH_ITEMS} items")
    text_chars = sum(
        len(item.get("text") or item.get("input") or "")
        for item in items
        if isinstance(item, dict) and isinstance(item.get("text") or item.get("input") or "", str)
    )
    if text_chars > MAX_BATCH_TEXT_CHARS:
        raise InputError(f"batch text exceeds {MAX_BATCH_TEXT_CHARS} characters")
    return items


MAX_VOICE_REGISTRATIONS = 64


def validate_voice_registration(items):
    if not isinstance(items, list):
        raise InputError("voices must be an array")
    if not items:
        raise InputError("voices array must not be empty")
    if len(items) > MAX_VOICE_REGISTRATIONS:
        raise InputError(f"voices exceeds {MAX_VOICE_REGISTRATIONS} items")

    validated = []
    for item in items:
        if not isinstance(item, dict):
            raise InputError("voice registration item must be an object")
        raw_voice = item.get("voice_id") or item.get("voice")
        if not isinstance(raw_voice, str) or not raw_voice.strip():
            raise InputError("voice_id must be a non-empty string")
        voice_id = raw_voice.strip()
        if len(voice_id) > MAX_VOICE_ID_CHARS:
            raise InputError("voice identifier is too long")

        ref_b64 = item.get("reference_audio_b64")
        if not ref_b64:
            raise InputError(f"reference_audio_b64 is required for voice '{voice_id}'")
        ref_bytes = _decode_reference(ref_b64)
        if not ref_bytes:
            raise InputError(f"reference audio is empty for voice '{voice_id}'")

        validated.append({
            "voice_id": voice_id,
            "reference_audio": ref_bytes,
        })
    return validated


async def read_bounded_json(request):
    chunks = []
    received = 0
    async for chunk in request.stream():
        received += len(chunk)
        if received > MAX_HTTP_REQUEST_BYTES:
            raise InputError("request body is too large")
        chunks.append(chunk)
    try:
        data = json.loads(b"".join(chunks) or b"{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise InputError("request body must be valid JSON") from error
    if not isinstance(data, dict):
        raise InputError("request body must be an object")
    return data
