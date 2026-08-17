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
            "ve.pt",
            "t3_mtl23ls_v3.safetensors",
            "s3gen.pt",
            "grapheme_mtl_merged_expanded_v1.json",
            "conds.pt",
            "Cangjie5_TC.json",
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

    print("3. Pre-warming Kokoro pipelines for all supported dialects...")
    # ScriptReader supports both American English ('a') and British English ('b')
    # voices (e.g. 'af_heart', 'bf_emma' which is the default narrator).
    # Warming both downloads and caches the respective misaki G2P dictionaries and assets.
    from kokoro import KPipeline
    warmup_configs = [
        ("a", "af_heart", "American English ('a')"),
        ("b", "bf_emma", "British English ('b')"),
    ]
    for lang_code, voice, label in warmup_configs:
        print(f"   - Warming {label} pipeline with voice '{voice}'...")
        pipeline = KPipeline(lang_code=lang_code)
        list(pipeline("Pre-warming dialect pipeline.", voice=voice, speed=1.0))
        del pipeline
        gc.collect()
        print(f"   ✓ {label} pipeline warmed up successfully.")

    print("=== All model weights pre-baked into image! ===")


if __name__ == "__main__":
    main()
