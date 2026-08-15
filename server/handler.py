import os
import io
import base64
import soundfile as sf
import numpy as np
from engine_kokoro import KokoroEngine
from engine_chatterbox import ChatterboxEngine
from request_contract import (
    InputError,
    MAX_OUTPUT_SECONDS,
    normalize_item,
    read_bounded_json,
    validate_batch,
    validate_voice_registration,
)

# Global engine instances
kokoro_engine = None
chatterbox_engine = None

# A batch already keeps the GPU busy, so this only overlaps one job's WAV
# encoding with another's inference. Raising it much further competes for the
# same device without adding throughput.
WORKER_CONCURRENCY = max(1, int(os.environ.get("SCRIPTREADER_WORKER_CONCURRENCY", "2")))

def get_kokoro():
    global kokoro_engine
    if kokoro_engine is None:
        kokoro_engine = KokoroEngine()
    return kokoro_engine

def get_chatterbox():
    global chatterbox_engine
    if chatterbox_engine is None:
        chatterbox_engine = ChatterboxEngine()
    return chatterbox_engine

def _error_result(item_id, error) -> dict:
    print(f"[Handler Error] Failed processing unit: {error}")
    return {
        "id": item_id,
        "error": str(error),
        "audio_base64": "",
        "sample_rate": 24000,
        "duration": 0.0
    }

def _encode_result(unit: dict, audio, sr: int = 24000) -> dict:
    if audio is None or len(audio) == 0 or np.all(audio == 0) or np.all(np.abs(audio) <= 0.0001):
        return {
            "id": unit["id"],
            "error": "Synthesis produced empty or silent audio",
            "audio_base64": "",
            "sample_rate": 24000,
            "duration": 0.0
        }
    if len(audio) / sr > MAX_OUTPUT_SECONDS:
        return _error_result(unit["id"], InputError(f"synthesis output exceeds {MAX_OUTPUT_SECONDS:g} seconds"))

    # Encode to WAV 16-bit PCM
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    return {
        "id": unit["id"],
        "audio_base64": base64.b64encode(buf.getvalue()).decode("utf-8"),
        "sample_rate": sr,
        "duration": round(len(audio) / sr, 3)
    }

def process_units(items: list) -> list:
    """Render a whole request together, one result per input in input order.

    Chatterbox lines go through the engine as a single batch because its decode
    loop is bound by streaming model weights, not by arithmetic — thirty-two
    lines at once cost barely more than one. Errors stay attached to the line
    that caused them so a scene does not fail on account of one bad unit.
    """
    results = [None] * len(items)
    units = []
    for index, item in enumerate(items):
        try:
            units.append((index, normalize_item(item)))
        except Exception as error:
            results[index] = _error_result(item.get("id") if isinstance(item, dict) else None, error)

    kokoro_units = [(index, unit) for index, unit in units if unit["engine"] == "kokoro"]
    # Default to Chatterbox high quality voice cloning
    chatterbox_units = [(index, unit) for index, unit in units if unit["engine"] != "kokoro"]

    for index, unit in kokoro_units:
        try:
            audio = get_kokoro().generate(text=unit["text"], voice=unit["voice"], speed=unit["speed"])
            results[index] = _encode_result(unit, audio)
        except Exception as error:
            results[index] = _error_result(unit["id"], error)

    if chatterbox_units:
        payload = [
            {
                "text": unit["text"],
                "voice_id": unit["voice"],
                "reference_audio_bytes": unit["reference_audio"],
                "exaggeration": unit["exaggeration"],
                "speed": unit["speed"],
            }
            for _index, unit in chatterbox_units
        ]
        try:
            rendered = get_chatterbox().generate_batch(payload)
        except Exception as error:
            # Only a whole-engine failure (a model that will not load) lands
            # here; per-line failures come back inside the list.
            rendered = [error] * len(payload)
        for (index, unit), audio in zip(chatterbox_units, rendered):
            if isinstance(audio, Exception):
                results[index] = _error_result(unit["id"], audio)
                continue
            try:
                results[index] = _encode_result(unit, audio)
            except Exception as error:
                results[index] = _error_result(unit["id"], error)

    return results

def process_single_unit(item: dict) -> dict:
    return process_units([item])[0]

def runpod_handler(job: dict):
    if not isinstance(job, dict):
        return {"error": "job must be an object"}
    job_input = job.get("input", {})
    if not isinstance(job_input, dict):
        return {"error": "input must be an object"}

    # 1. Voice Registration Request
    if "register_voices" in job_input or job_input.get("action") == "register_voices":
        raw_reg = job_input.get("register_voices")
        raw_voices = job_input.get("voices")
        voices_payload = raw_reg if isinstance(raw_reg, list) else (raw_voices if isinstance(raw_voices, list) else raw_reg or raw_voices or [])
        try:
            validated_voices = validate_voice_registration(voices_payload)
            registered = []
            for voice_entry in validated_voices:
                vid = voice_entry["voice_id"]
                audio_data = voice_entry["reference_audio"]
                get_chatterbox().register_speaker_reference(vid, audio_data)
                registered.append(vid)
            return {"registered": len(registered), "voices": registered}
        except Exception as error:
            return {"error": str(error), "registered": 0, "voices": []}

    # 2. Batch Request (Full screenplay render pass)
    if "batch" in job_input:
        try:
            batch = validate_batch(job_input["batch"])
        except InputError as error:
            return {"error": str(error), "batch_results": [], "count": 0}
        results = process_units(batch)
        return {"batch_results": results, "count": len(results)}

    # 3. Single line streaming request
    return process_single_unit(job_input)

# FastAPI HTTP support
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="ScriptReader TTS Worker", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    # A wildcard origin and credentials are not a legal combination; browsers
    # reject the pair outright. This worker authenticates through RunPod, so it
    # has no cookie or credentialed request to support.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "ok", "service": "ScriptReader TTS Worker"}

@app.post("/v1/voices/register")
async def register_voices_endpoint(request: Request):
    """Register voice embeddings in worker memory to avoid re-uploading reference audio."""
    try:
        data = await read_bounded_json(request)
        raw_reg = data.get("register_voices")
        raw_voices = data.get("voices")
        voices_payload = raw_reg if isinstance(raw_reg, list) else (raw_voices if isinstance(raw_voices, list) else raw_reg or raw_voices or [])
        validated_voices = validate_voice_registration(voices_payload)
        registered = []
        for voice_entry in validated_voices:
            vid = voice_entry["voice_id"]
            audio_data = voice_entry["reference_audio"]
            get_chatterbox().register_speaker_reference(vid, audio_data)
            registered.append(vid)
        return {"registered": len(registered), "voices": registered}
    except InputError as error:
        return JSONResponse({"error": str(error)}, status_code=413 if "too large" in str(error) or "exceeds" in str(error) else 400)
    except Exception as error:
        return JSONResponse({"error": str(error)}, status_code=400)


@app.post("/v1/audio/speech")
async def openai_speech(request: Request):
    """OpenAI TTS API compatible endpoint for direct ScriptReader streaming."""
    try:
        data = await read_bounded_json(request)
    except InputError as error:
        return JSONResponse({"error": str(error)}, status_code=413 if "too large" in str(error) else 400)
    result = process_single_unit(data)
    if result.get("audio_base64"):
        audio_bytes = base64.b64decode(result["audio_base64"])
        return Response(content=audio_bytes, media_type="audio/wav")
    return Response(content=b"", status_code=400)

@app.post("/v1/audio/batch")
async def batch_speech(request: Request):
    """Batch synthesis endpoint for fast multi-scene or full-screenplay rendering."""
    try:
        data = await read_bounded_json(request)
        batch = validate_batch(data.get("batch", []))
    except InputError as error:
        return JSONResponse({"error": str(error)}, status_code=413 if "too large" in str(error) or "exceeds" in str(error) else 400)
    results = process_units(batch)
    return {"results": results, "batch_results": results, "count": len(results)}

def preload_engines():
    """Build both engines before any job is accepted.

    RunPod marks a worker ready as soon as the handler is registered, so loading
    on first use put a multi-gigabyte session build and CUDA context creation
    inside a customer's request — and inside the browser's polling window.
    Chatterbox is the reason this worker rents a GPU, so a failure there stops
    the process rather than leaving a worker that bills while it cannot do the
    job it was started for.
    """
    get_chatterbox().warmup()
    try:
        get_kokoro().warmup()
    except Exception as error:
        # A cast can be entirely Chatterbox, so a Kokoro problem is worth
        # reporting without refusing the jobs this worker can still serve.
        print(f"[ScriptReader Worker] Kokoro warmup notice: {error}")

def adjust_concurrency(_current_concurrency: int) -> int:
    return WORKER_CONCURRENCY

if __name__ == "__main__":
    # Check if run under RunPod Serverless or standalone HTTP
    if os.environ.get("RUNPOD_SERVERLESS", "true").lower() == "true":
        try:
            import runpod
        except ImportError as error:
            # Only a missing SDK justifies serving HTTP instead. Catching every
            # exception here turned any serverless failure into a worker that
            # billed while RunPod routed no traffic to it.
            print(f"[ScriptReader Worker] Starting Uvicorn HTTP Server fallback: {error}")
            import uvicorn
            preload_engines()
            uvicorn.run(app, host="0.0.0.0", port=8000)
        else:
            preload_engines()
            print(f"[ScriptReader Worker] Starting RunPod Serverless Listener (concurrency={WORKER_CONCURRENCY})...")
            runpod.serverless.start({
                "handler": runpod_handler,
                "concurrency_modifier": adjust_concurrency,
            })
    else:
        import uvicorn
        preload_engines()
        uvicorn.run(app, host="0.0.0.0", port=8000)
