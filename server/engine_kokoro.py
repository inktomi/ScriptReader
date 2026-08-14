import os
import torch
import numpy as np

class KokoroEngine:
    def __init__(self, models_dir="/models/kokoro"):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.sample_rate = 24000
        self.pipelines = {}
        print(f"[KokoroEngine] Initialized on device: {self.device}")

    def _get_pipeline(self, lang_code='a'):
        if lang_code not in self.pipelines:
            try:
                from kokoro import KPipeline
                self.pipelines[lang_code] = KPipeline(lang_code=lang_code, device=self.device)
            except Exception as e:
                print(f"[KokoroEngine] Failed to initialize KPipeline with device={self.device}, falling back to cpu: {e}")
                from kokoro import KPipeline
                self.pipelines[lang_code] = KPipeline(lang_code=lang_code, device='cpu')
        return self.pipelines[lang_code]

    def generate(self, text: str, voice: str = "af_heart", speed: float = 1.0) -> np.ndarray:
        if not text or not text.strip():
            return np.zeros(0, dtype=np.float32)

        # British voices start with 'b' (e.g. 'bf_emma', 'bm_george') -> use lang_code 'b'
        lang_code = 'b' if voice.startswith('b') else 'a'
        pipeline = self._get_pipeline(lang_code)

        chunks = []
        generator = pipeline(text.strip(), voice=voice, speed=speed, split_pattern=r'\n+')
        for _, _, audio in generator:
            if audio is not None and len(audio) > 0:
                chunks.append(audio)

        if not chunks:
            return np.zeros(0, dtype=np.float32)

        return np.concatenate(chunks).astype(np.float32)
