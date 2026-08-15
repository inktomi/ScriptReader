import os
import sys
from huggingface_hub import snapshot_download

# The repository ships five language-model variants totalling ~3.8GB, of which
# the worker loads exactly one. Every unused byte is pulled again on each cold
# worker, three times over for a feature-length render, so only the selected
# variant is baked in. fp16 is the default because the L40S reads half as much
# memory for it and only engages its tensor cores below fp32.
LANGUAGE_MODEL = os.environ.get("CHATTERBOX_LANGUAGE_MODEL", "language_model_fp16")

CHATTERBOX_FILES = [
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "onnx/embed_tokens.onnx*",
    "onnx/speech_encoder.onnx*",
    "onnx/conditional_decoder.onnx*",
    f"onnx/{LANGUAGE_MODEL}.onnx*",
]


def main():
    print("=== Pre-caching model weights for offline GPU inference ===")

    os.makedirs("/models/chatterbox", exist_ok=True)

    print(f"1. Downloading Chatterbox ONNX models ({LANGUAGE_MODEL})...")
    snapshot_download(
        repo_id="onnx-community/chatterbox-ONNX",
        local_dir="/models/chatterbox",
        allow_patterns=CHATTERBOX_FILES,
    )
    print("Chatterbox ONNX downloaded successfully.")

    # Kokoro goes into the Hugging Face cache rather than /models/kokoro.
    # KPipeline only ever resolves through that cache, so the old snapshot was
    # 360MB nothing opened while the same weights were fetched again at run
    # time — which would now fail outright under HF_HUB_OFFLINE. Every voice
    # file is included because casting can reach any of them; the demo clips
    # and evaluation images are not.
    print("2. Caching Kokoro 82M weights and every voice...")
    snapshot_download(
        repo_id="hexgrad/Kokoro-82M",
        allow_patterns=["config.json", "*.pth", "voices/*"],
    )
    print("Kokoro weights cached successfully.")

    print("3. Pre-warming Kokoro pipeline (downloads the g2p dictionaries)...")
    try:
        from kokoro import KPipeline
        pipeline = KPipeline(lang_code='a')
        pipeline("Warmup.", voice='af_heart', speed=1.0)
        print("Kokoro pipeline warmed up successfully.")
    except Exception as e:
        print(f"Kokoro pipeline warmup notice (non-fatal): {e}")

    print("=== All model weights pre-baked into image! ===")

if __name__ == "__main__":
    main()
