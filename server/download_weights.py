import os
import sys
from huggingface_hub import snapshot_download

def main():
    print("=== Pre-caching model weights for offline GPU inference ===")
    
    os.makedirs("/models/chatterbox", exist_ok=True)
    os.makedirs("/models/kokoro", exist_ok=True)

    print("1. Downloading Chatterbox ONNX models...")
    snapshot_download(
        repo_id="onnx-community/chatterbox-ONNX",
        local_dir="/models/chatterbox",
        ignore_patterns=[".git*", "*.msgpack"]
    )
    print("Chatterbox ONNX downloaded successfully.")

    print("2. Downloading Kokoro 82M PyTorch / ONNX models & voices...")
    snapshot_download(
        repo_id="hexgrad/Kokoro-82M",
        local_dir="/models/kokoro",
        ignore_patterns=[".git*"]
    )
    print("Kokoro 82M downloaded successfully.")

    print("3. Pre-warming Kokoro pipeline cache...")
    try:
        from kokoro import KPipeline
        # Initialize pipeline to download any language/g2p dictionaries into the container image
        pipeline = KPipeline(lang_code='a')
        pipeline("Warmup.", voice='af_heart', speed=1.0)
        print("Kokoro pipeline warmed up successfully.")
    except Exception as e:
        print(f"Kokoro pipeline warmup notice (non-fatal): {e}")

    print("=== All model weights pre-baked into image! ===")

if __name__ == "__main__":
    main()
