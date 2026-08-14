import os
import io
import base64
import soundfile as sf
import numpy as np
from engine_kokoro import KokoroEngine
from engine_chatterbox import ChatterboxEngine

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
    text = item.get("text") or item.get("input") or ""
    engine_type = (item.get("engine") or item.get("model") or "chatterbox").lower()
    voice = item.get("voice") or item.get("voice_id") or "af_heart"
    speed = float(item.get("speed", 1.0))
    exaggeration = float(item.get("exaggeration", 0.5))
    ref_b64 = item.get("reference_audio_b64")

    if not text.strip():
        return {
            "audio_base64": "",
            "sample_rate": 24000,
            "duration": 0.0,
            "error": "Empty text"
        }

    try:
        ref_bytes = base64.b64decode(ref_b64) if ref_b64 else None

        if "kokoro" in engine_type:
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
                "id": item.get("id"),
                "error": "Synthesis produced empty or silent audio",
                "audio_base64": "",
                "sample_rate": 24000,
                "duration": 0.0
            }

        # Encode to WAV 16-bit PCM
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
        audio_b64 = base64.b64encode(buf.getvalue()).decode("utf-8")

        return {
            "id": item.get("id"),
            "audio_base64": audio_b64,
            "sample_rate": sr,
            "duration": round(len(audio) / sr, 3)
        }
    except Exception as e:
        print(f"[Handler Error] Failed processing unit: {e}")
        return {
            "id": item.get("id"),
            "error": str(e),
            "audio_base64": "",
            "sample_rate": 24000,
            "duration": 0.0
        }

def runpod_handler(job: dict):
    job_input = job.get("input", {})

    # 1. Batch Request (Full screenplay render pass)
    if "batch" in job_input and isinstance(job_input["batch"], list):
        results = [process_single_unit(item) for item in job_input["batch"]]
        return {"batch_results": results, "count": len(results)}

    # 2. Single line streaming request
    return process_single_unit(job_input)

# FastAPI HTTP support
from fastapi import FastAPI, Request, Response
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
    data = await request.json()
    result = process_single_unit(data)
    if result.get("audio_base64"):
        audio_bytes = base64.b64decode(result["audio_base64"])
        return Response(content=audio_bytes, media_type="audio/wav")
    return Response(content=b"", status_code=400)

@app.post("/v1/audio/batch")
async def batch_speech(request: Request):
    """Batch synthesis endpoint for fast multi-scene or full-screenplay rendering."""
    data = await request.json()
    batch = data.get("batch", [])
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
