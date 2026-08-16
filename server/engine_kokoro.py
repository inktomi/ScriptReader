import os
import threading
import torch
import numpy as np


def _requires_gpu():
    return os.environ.get("SCRIPTREADER_REQUIRE_GPU", "1").strip().lower() not in {"0", "false", "no", ""}


class KokoroEngine:
    """Kokoro narration.

    Weights are not read from a directory: KPipeline resolves them through the
    Hugging Face cache, which the image warms at build time. That is why there
    is no models_dir here — passing one only ever looked like it did something.
    """

    def __init__(self, require_gpu=None):
        self._require_gpu = _requires_gpu() if require_gpu is None else require_gpu
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        if self.device != "cuda" and self._require_gpu:
            raise RuntimeError(
                "torch reports no CUDA device. This worker bills at GPU rates "
                "and will not quietly run Kokoro on CPU. Set "
                "SCRIPTREADER_REQUIRE_GPU=0 to allow a deliberate CPU run."
            )
        if self.device == "cuda":
            # Ada runs fp32 matmuls through the tensor cores at TF32 precision,
            # which is ample for an 82M vocoder and several times faster.
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
        self.sample_rate = 24000
        self.pipelines = {}
        self._lock = threading.RLock()
        print(f"[KokoroEngine] Initialized on device: {self.device}")

    def _get_pipeline(self, lang_code='a'):
        with self._lock:
            if lang_code not in self.pipelines:
                try:
                    from kokoro import KPipeline
                    self.pipelines[lang_code] = KPipeline(lang_code=lang_code, device=self.device)
                except Exception as e:
                    if self._require_gpu:
                        raise
                    print(f"[KokoroEngine] Failed to initialize KPipeline with device={self.device}, falling back to cpu: {e}")
                    from kokoro import KPipeline
                    self.pipelines[lang_code] = KPipeline(lang_code=lang_code, device='cpu')
            return self.pipelines[lang_code]

    def generate(self, text: str, voice: str = "af_heart", speed: float = 1.0) -> np.ndarray:
        if not text or not text.strip() or not any(c.isalnum() for c in text):
            return np.zeros(0, dtype=np.float32)

        # British voices start with 'b' (e.g. 'bf_emma', 'bm_george') -> use lang_code 'b'
        lang_code = 'b' if voice.startswith('b') else 'a'
        pipeline = self._get_pipeline(lang_code)

        chunks = []
        with self._lock:
            with torch.inference_mode():
                generator = pipeline(text.strip(), voice=voice, speed=speed, split_pattern=r'\n+')
                for _, _, audio in generator:
                    if audio is not None and len(audio) > 0:
                        chunks.append(audio)

        if not chunks:
            return np.zeros(0, dtype=np.float32)

        return np.concatenate(chunks).astype(np.float32)

    def warmup(self, voices: tuple = ("af_heart", "bf_emma")):
        """Build both American and British pipelines before any job arrives."""
        total_samples = 0
        for voice in voices:
            audio = self.generate("Warm up.", voice=voice, speed=1.0)
            total_samples += len(audio)
            lang = "British ('b')" if voice.startswith("b") else "American ('a')"
            print(f"[KokoroEngine] Warmed {lang} pipeline with voice '{voice}' ({len(audio)} samples)")
        print(f"[KokoroEngine] Full warmup complete ({total_samples} total samples)")
