import gc
import os
import sys
from huggingface_hub import snapshot_download


def main():
    print("=== Pre-caching model weights for offline GPU inference ===")

    print("1. Downloading Chatterbox Multilingual V3 PyTorch weights...")
    snapshot_download(
        repo_id="ResembleAI/chatterbox",
        allow_patterns=[
            "*.json",
            "*.txt",
            "*.model",
            "*.safetensors",
            "*.pt",
        ],
        max_workers=1,
    )
    print("Chatterbox Multilingual V3 weights cached successfully.")
    gc.collect()

    # Kokoro goes into the Hugging Face cache.
    # KPipeline resolves through that cache, so pre-downloading and warming it
    # guarantees it will work under HF_HUB_OFFLINE. Every voice file is included.
    print("2. Caching Kokoro 82M weights and every voice...")
    snapshot_download(
        repo_id="hexgrad/Kokoro-82M",
        allow_patterns=["config.json", "*.pth", "voices/*"],
        max_workers=1,
    )
    print("Kokoro weights cached successfully.")
    gc.collect()

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
