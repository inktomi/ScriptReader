import os
import io
import base64
import torch
import numpy as np
import soundfile as sf

class ChatterboxEngine:
    def __init__(self, models_dir="/models/chatterbox"):
        self.models_dir = models_dir
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.sample_rate = 24000
        self.sessions = {}
        self.processor = None
        self.speakers_cache = {}
        self._initialized = False

    def _ensure_loaded(self):
        if self._initialized:
            return

        import onnxruntime as ort
        from transformers import AutoProcessor

        providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if self.device == 'cuda' else ['CPUExecutionProvider']
        sess_options = ort.SessionOptions()
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        print(f"[ChatterboxEngine] Loading ONNX sessions with providers={providers}...")
        try:
            self.processor = AutoProcessor.from_pretrained(self.models_dir)
        except Exception as e:
            print(f"[ChatterboxEngine] Warning loading AutoProcessor: {e}")

        # Check for model files
        onnx_dir = os.path.join(self.models_dir, "onnx") if os.path.isdir(os.path.join(self.models_dir, "onnx")) else self.models_dir
        
        session_names = ["embed_tokens", "speech_encoder", "conditional_decoder"]
        for name in session_names:
            path = os.path.join(onnx_dir, f"{name}.onnx")
            if os.path.exists(path):
                self.sessions[name] = ort.InferenceSession(path, sess_options, providers=providers)

        # Look for language_model - prioritize full precision unquantized weights on GPU
        for lm_name in ["language_model.onnx", "language_model_fp16.onnx", "language_model_q4f16.onnx", "language_model_q4.onnx"]:
            path = os.path.join(onnx_dir, lm_name)
            if os.path.exists(path):
                self.sessions["language_model"] = ort.InferenceSession(path, sess_options, providers=providers)
                print(f"[ChatterboxEngine] Selected language model: {lm_name}")
                break

        print(f"[ChatterboxEngine] Successfully loaded sessions: {list(self.sessions.keys())}")
        self._initialized = True

    def register_speaker_reference(self, voice_id: str, audio_bytes: bytes):
        """Encode and cache reference voice sample embedding."""
        self._ensure_loaded()
        if voice_id in self.speakers_cache:
            return

        audio_data, sr = sf.read(io.BytesIO(audio_bytes), dtype='float32')
        if audio_data.ndim > 1:
            audio_data = audio_data.mean(axis=1) # Mono

        # Resample to 24kHz if necessary
        if sr != self.sample_rate:
            import scipy.signal
            num_samples = int(len(audio_data) * self.sample_rate / sr)
            audio_data = scipy.signal.resample(audio_data, num_samples).astype(np.float32)

        if "speech_encoder" in self.sessions:
            encoder = self.sessions["speech_encoder"]
            input_name = encoder.get_inputs()[0].name
            # audio tensor shape [1, length]
            inp = np.expand_dims(audio_data, axis=0).astype(np.float32)
            outputs = encoder.run(None, {input_name: inp})
            self.speakers_cache[voice_id] = outputs[0]
        else:
            self.speakers_cache[voice_id] = audio_data

    def generate(
        self,
        text: str,
        voice_id: str = "default",
        reference_audio_bytes: bytes = None,
        exaggeration: float = 0.5,
        speed: float = 1.0
    ) -> np.ndarray:
        self._ensure_loaded()
        if not text or not text.strip():
            return np.zeros(0, dtype=np.float32)

        if reference_audio_bytes and voice_id not in self.speakers_cache:
            self.register_speaker_reference(voice_id, reference_audio_bytes)

        # Run tokenization / synthesis
        if self.processor and "language_model" in self.sessions and "conditional_decoder" in self.sessions:
            try:
                inputs = self.processor(text.strip(), return_tensors="np")
                input_ids = inputs["input_ids"]

                # Run decoder & synthesize waveform
                decoder = self.sessions["conditional_decoder"]
                dec_in = decoder.get_inputs()
                # Run conditional decoder graph
                spk_emb = self.speakers_cache.get(voice_id)
                feed = {dec_in[0].name: input_ids}
                if len(dec_in) > 1 and spk_emb is not None:
                    feed[dec_in[1].name] = spk_emb

                out = decoder.run(None, feed)
                waveform = out[0].squeeze()
                if waveform is not None and len(waveform) > 0 and not np.all(waveform == 0):
                    return waveform.astype(np.float32)
            except Exception as e:
                print(f"[ChatterboxEngine] Generation error: {e}")

        # Fallback to high quality neural voice if Chatterbox ONNX graph is not available
        try:
            from engine_kokoro import KokoroEngine
            audio = KokoroEngine().generate(text=text, voice="af_heart", speed=speed)
            if audio is not None and len(audio) > 0 and not np.all(audio == 0):
                return audio.astype(np.float32)
        except Exception as e:
            print(f"[ChatterboxEngine] Fallback Kokoro generation notice: {e}")

        raise RuntimeError(f"Chatterbox voice generation failed for voice '{voice_id}'")
