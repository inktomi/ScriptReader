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
)

# Global engine instances
kokoro_engine = None
chatterbox_engine = None

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

def process_single_unit(item: dict) -> dict:
    try:
        normalized = normalize_item(item)
        text = normalized["text"]
        engine_type = normalized["engine"]
        voice = normalized["voice"]
        speed = normalized["speed"]
        exaggeration = normalized["exaggeration"]
        ref_bytes = normalized["reference_audio"]

        if engine_type == "kokoro":
            audio = get_kokoro().generate(text=text, voice=voice, speed=speed)
            sr = 24000
        else:
            # Default to Chatterbox high quality voice cloning
            audio = get_chatterbox().generate(
                text=text,
                voice_id=voice,
                reference_audio_bytes=ref_bytes,
                exaggeration=exaggeration,
                speed=speed
            )
            sr = 24000

        if audio is None or len(audio) == 0 or np.all(audio == 0):
            return {
                "id": normalized["id"],
                "error": "Synthesis produced empty or silent audio",
                "audio_base64": "",
                "sample_rate": 24000,
                "duration": 0.0
            }
        if len(audio) / sr > MAX_OUTPUT_SECONDS:
            raise InputError(f"synthesis output exceeds {MAX_OUTPUT_SECONDS:g} seconds")

        # Encode to WAV 16-bit PCM
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
        audio_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

        return {
            "id": normalized["id"],
            "audio_base64": audio_b64,
            "sample_rate": sr,
            "duration": round(len(audio) / sr, 3)
        }
    except Exception as e:
        print(f"[Handler Error] Failed processing unit: {e}")
        return {
            "id": item.get("id") if isinstance(item, dict) else None,
            "error": str(e),
            "audio_base64": "",
            "sample_rate": 24000,
            "duration": 0.0
        }

def runpod_handler(job: dict):
    if not isinstance(job, dict):
        return {"error": "job must be an object"}
    job_input = job.get("input", {})
    if not isinstance(job_input, dict):
        return {"error": "input must be an object"}

    # 1. Batch Request (Full screenplay render pass)
    if "batch" in job_input:
        try:
            batch = validate_batch(job_input["batch"])
        except InputError as error:
            return {"error": str(error), "batch_results": [], "count": 0}
        results = [process_single_unit(item) for item in batch]
        return {"batch_results": results, "count": len(results)}

    # 2. Single line streaming request
    return process_single_unit(job_input)

# FastAPI HTTP support
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="ScriptReader TTS Worker", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"status": "ok", "service": "ScriptReader TTS Worker"}

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
    results = [process_single_unit(item) for item in batch]
    return {"results": results, "count": len(results)}

if __name__ == "__main__":
    # Check if run under RunPod Serverless or standalone HTTP
    if os.environ.get("RUNPOD_SERVERLESS", "true").lower() == "true":
        try:
            import runpod
            print("[ScriptReader Worker] Starting RunPod Serverless Listener...")
            runpod.serverless.start({"handler": runpod_handler})
        except Exception as e:
            print(f"[ScriptReader Worker] Starting Uvicorn HTTP Server fallback: {e}")
            import uvicorn
            uvicorn.run(app, host="0.0.0.0", port=8000)
    else:
        import uvicorn
        uvicorn.run(app, host="0.0.0.0", port=8000)
