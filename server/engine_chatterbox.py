import collections
import inspect
import io
import os
import tempfile
import threading
import numpy as np
import soundfile as sf
import torch

os.environ.setdefault("TRANSFORMERS_ATTN_IMPLEMENTATION", "eager")


def _requires_gpu():
    return os.environ.get("SCRIPTREADER_REQUIRE_GPU", "1").strip().lower() not in {"0", "false", "no", ""}


DEFAULT_MAX_SPEAKER_CACHE_SIZE = 64

# Chatterbox has no speed control of its own, so a `speed` request is served by
# time-scaling the rendered waveform. Below this the change is under the ear's
# discrimination threshold for speech rate and the scaling pass is pure cost —
# a browser asking for 0.99 is asking for nothing.
SPEED_DEADBAND = 0.02
# WSOLA frame, at 24 kHz: 42.7 ms, comfortably more than two pitch periods even
# for a 70 Hz voice, which is what the similarity search needs to lock onto.
WSOLA_FRAME = 1024


def _speaker_cache_size(explicit=None):
    """Resolve the speaker-cache bound, preferring an explicit constructor value.

    A malformed environment value must not take the worker down: preload_engines()
    builds this engine before any job is accepted, so an exception raised here
    kills the process rather than failing one request.
    """
    if explicit is not None:
        return explicit
    raw = os.environ.get("SCRIPTREADER_SPEAKER_CACHE_SIZE", "")
    if not raw.strip():
        return DEFAULT_MAX_SPEAKER_CACHE_SIZE
    try:
        return int(raw)
    except ValueError:
        print(
            f"[ChatterboxEngine] Ignoring malformed SCRIPTREADER_SPEAKER_CACHE_SIZE={raw!r}; "
            f"using {DEFAULT_MAX_SPEAKER_CACHE_SIZE}."
        )
        return DEFAULT_MAX_SPEAKER_CACHE_SIZE


def time_stretch_wsola(audio: np.ndarray, rate: float, frame: int = WSOLA_FRAME) -> np.ndarray:
    """Scale `audio` in time by `rate` without moving its pitch.

    This replaces a phase vocoder, which is where "the voices sound like they are
    speaking through a metal box" came from. A phase vocoder discards the real
    phase of every frame and integrates an estimated one instead; on speech the
    estimate drifts between overlapping frames, the harmonics stop lining up, and
    the result rings — audibly, at any rate, including the 1% ordinary narration
    was being stretched by.

    WSOLA never leaves the time domain. Each output frame is copied from the
    input at whichever offset within a small search window best matches the
    waveform already written, so overlapping frames stay phase-coherent and the
    timbre survives intact.
    """
    audio = np.asarray(audio, dtype=np.float32)
    hop_syn = frame // 2
    # Two frames is the least that can overlap-add into anything; below it there
    # is no window to slide and the speed request is simply dropped.
    if not np.isfinite(rate) or rate <= 0 or audio.size < frame * 2:
        return audio

    from scipy.signal import correlate

    hop_ana = hop_syn * rate
    tolerance = hop_syn  # ±21 ms covers a full pitch period at any speaking F0
    # Periodic Hann sums to exactly 1.0 at 50% overlap, so the interior needs no
    # normalisation and only the two ramped edges do.
    window = (0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(frame) / frame)).astype(np.float32)

    out_len = int(np.ceil(audio.size / rate)) + frame
    out = np.zeros(out_len, dtype=np.float32)
    weight = np.zeros(out_len, dtype=np.float32)

    selected = 0
    index = 0
    while True:
        out_start = index * hop_syn
        ideal = int(round(index * hop_ana))
        if out_start + frame > out_len or ideal + frame > audio.size:
            break

        if index > 0:
            low = max(0, ideal - tolerance)
            high = min(audio.size - frame, ideal + tolerance)
            if high <= low:
                selected = max(0, min(audio.size - frame, ideal))
            else:
                # The samples that would have followed naturally had the previous
                # frame simply played on: the candidate most like this is the one
                # that continues the waveform instead of interrupting it.
                target = audio[selected + hop_syn : selected + hop_syn + frame]
                if target.size < frame:
                    target = np.pad(target, (0, frame - target.size))
                search = audio[low : high + frame]
                similarity = correlate(search, target, mode="valid")
                # Normalise by candidate energy, or the search locks onto
                # whichever offset is merely loudest rather than the best match.
                squares = np.concatenate(([0.0], np.cumsum(search.astype(np.float64) ** 2)))
                count = similarity.size
                energy = squares[frame : frame + count] - squares[:count]
                selected = low + int(np.argmax(similarity / np.sqrt(energy + 1e-9)))

        out[out_start : out_start + frame] += audio[selected : selected + frame] * window
        weight[out_start : out_start + frame] += window
        index += 1

    if index == 0:
        return audio

    used = min(out_len, (index - 1) * hop_syn + frame)
    out = out[:used]
    weight = weight[:used]
    np.divide(out, weight, out=out, where=weight > 1e-6)
    return out


class LRUSpeakerCache(collections.OrderedDict):
    """Thread-safe bounded LRU cache for speaker conditioning tensors."""

    def __init__(self, maxsize: int = DEFAULT_MAX_SPEAKER_CACHE_SIZE, *args, **kwargs):
        # Both attributes must exist before OrderedDict.__init__ runs: it seeds
        # any initial items through the overridden __setitem__, which reads them.
        self.maxsize = max(1, int(maxsize))
        self._lock = threading.RLock()
        super().__init__(*args, **kwargs)

    def copy(self):
        # OrderedDict.copy() rebuilds through self.__class__(self), which would
        # read the source mapping as this class's maxsize argument. Copying
        # explicitly keeps the bound and every entry.
        with self._lock:
            duplicate = self.__class__(self.maxsize)
            for key, value in super().items():
                duplicate[key] = value
            return duplicate

    def __getitem__(self, key):
        with self._lock:
            val = super().__getitem__(key)
            super().move_to_end(key)
            return val

    def get(self, key, default=None):
        with self._lock:
            try:
                val = super().__getitem__(key)
                super().move_to_end(key)
                return val
            except KeyError:
                return default

    def __setitem__(self, key, value):
        with self._lock:
            super().__setitem__(key, value)
            super().move_to_end(key)
            while len(self) > self.maxsize:
                oldest_key = next(iter(self))
                oldest_val = super().__getitem__(oldest_key)
                super().__delitem__(oldest_key)
                del oldest_val

    def pop(self, key, *args):
        with self._lock:
            if key in self:
                val = super().__getitem__(key)
                super().__delitem__(key)
                return val
            if args:
                return args[0]
            raise KeyError(key)

    def popitem(self, last=True):
        with self._lock:
            if not self:
                raise KeyError("dictionary is empty")
            key = next(reversed(self)) if last else next(iter(self))
            val = super().__getitem__(key)
            super().__delitem__(key)
            return key, val

    def __delitem__(self, key):
        with self._lock:
            super().__delitem__(key)

    def __contains__(self, key):
        with self._lock:
            return super().__contains__(key)

    def __len__(self):
        with self._lock:
            return super().__len__()

    def clear(self):
        with self._lock:
            super().clear()

    def keys(self):
        with self._lock:
            return list(super().keys())

    def values(self):
        with self._lock:
            return list(super().values())

    def items(self):
        with self._lock:
            return list(super().items())


class ChatterboxEngine:
    """High-quality PyTorch-native Chatterbox Multilingual V3 voice cloning engine.

    Replaces ONNX orchestration with native PyTorch CUDA execution.
    Speaker conditionals are extracted from reference audio and cached in worker
    memory for instant zero-latency reuse across screenplay lines.
    """

    def __init__(self, models_dir=None, require_gpu=None, max_cache_size=None):
        self.models_dir = models_dir
        self.sample_rate = 24000
        self.speakers_cache = LRUSpeakerCache(maxsize=_speaker_cache_size(max_cache_size))
        self.model = None
        self._initialized = False
        self._lock = threading.RLock()
        self._require_gpu = _requires_gpu() if require_gpu is None else require_gpu
        self.device = "cuda" if torch.cuda.is_available() else "cpu"

        if self.device == "cuda":
            # Ada Lovelace (L40S) TF32 precision for fast matmuls
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True

    def _ensure_loaded(self):
        with self._lock:
            if self._initialized:
                return

            if self.device != "cuda" and self._require_gpu:
                raise RuntimeError(
                    f"Chatterbox requires a CUDA device (torch reports device='{self.device}'). "
                    "This worker bills at GPU rates and will not quietly run on CPU. "
                    "Set SCRIPTREADER_REQUIRE_GPU=0 to allow a deliberate CPU run."
                )

            print(f"[ChatterboxEngine] Loading Chatterbox Multilingual model on device: {self.device}...")

            try:
                from chatterbox.mtl_tts import ChatterboxMultilingualTTS
                try:
                    self.model = ChatterboxMultilingualTTS.from_pretrained(device=self.device, t3_model="v3")
                except (TypeError, Exception):
                    self.model = ChatterboxMultilingualTTS.from_pretrained(device=self.device)
                print("[ChatterboxEngine] Loaded ChatterboxMultilingualTTS V3 successfully.")
            except Exception as e:
                try:
                    from chatterbox.tts import ChatterboxTTS
                    self.model = ChatterboxTTS.from_pretrained(device=self.device)
                    print(f"[ChatterboxEngine] Loaded ChatterboxTTS fallback ({e}).")
                except Exception as e2:
                    raise RuntimeError(
                        f"Could not load Chatterbox model from Hugging Face cache: {e}; fallback error: {e2}"
                    ) from e

            self.sample_rate = getattr(self.model, "sr", 24000)
            self._initialized = True

    def register_speaker_reference(self, voice_id: str, audio_bytes: bytes):
        """Extract and cache speaker conditioning embeddings from reference audio."""
        self._ensure_loaded()
        with self._lock:
            if voice_id in self.speakers_cache:
                return

        audio_data, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32")
        if audio_data.ndim > 1:
            audio_data = audio_data.mean(axis=1)  # Mono

        # Resample to model sample rate (24 kHz) if needed
        if sr != self.sample_rate:
            import scipy.signal
            num_samples = int(len(audio_data) * self.sample_rate / sr)
            audio_data = scipy.signal.resample(audio_data, num_samples).astype(np.float32)

        # Write to temporary WAV file to pass to prepare_conditionals
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_wav:
                temp_path = temp_wav.name
            sf.write(temp_path, audio_data, self.sample_rate, format="WAV", subtype="PCM_16")
            with self._lock:
                if voice_id in self.speakers_cache:
                    return
                with torch.inference_mode():
                    self.model.conds = None
                    self.model.prepare_conditionals(temp_path, exaggeration=0.5)
                    # Cache the extracted speaker condition tensors
                    if hasattr(self.model, "conds") and self.model.conds is not None:
                        self.speakers_cache[voice_id] = self.model.conds
                    else:
                        raise RuntimeError("Chatterbox failed to extract speaker conditioning tensors")
        finally:
            if temp_path and os.path.exists(temp_path):
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass

    def _prepare_row(self, item: dict):
        voice_id = item.get("voice_id") or "default"
        reference = item.get("reference_audio_bytes")
        if reference and voice_id not in self.speakers_cache:
            self.register_speaker_reference(voice_id, reference)

        text = (item.get("text") or "").strip()
        if not text or not any(c.isalnum() for c in text):
            return None

        speaker_conds = self.speakers_cache.get(voice_id)
        if speaker_conds is None:
            raise RuntimeError(f"Chatterbox voice '{voice_id}' has no reference recording")

        return {
            "text": text,
            "voice_id": voice_id,
            "speaker_conds": speaker_conds,
            "exaggeration": float(0.5 if item.get("exaggeration") is None else item.get("exaggeration")),
            "speed": float(1.0 if item.get("speed") is None else item.get("speed")),
            "language_id": str(item.get("language_id") or "en").strip().lower() or "en",
        }

    def _safe_generate(
        self,
        text: str,
        language_id: str,
        exaggeration: float,
        cfg_weight: float = 0.5,
        temperature: float = 0.8,
        repetition_penalty: float = 1.2,
        min_p: float = 0.05,
        top_p: float = 1.0,
    ):
        """Invoke model.generate with filtered arguments supported by the model instance."""
        kwargs = {
            "text": text,
            "audio_prompt_path": None,
            "exaggeration": exaggeration,
            "cfg_weight": cfg_weight,
            "temperature": temperature,
            "repetition_penalty": repetition_penalty,
            "min_p": min_p,
            "top_p": top_p,
        }
        sig = inspect.signature(self.model.generate)
        params = sig.parameters
        has_var_keyword = any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values())
        # A model taking **kwargs accepts everything, so nothing is filtered out.
        # One that does not would raise on any argument it never declared.
        filtered_kwargs = dict(kwargs) if has_var_keyword else {
            k: v for k, v in kwargs.items() if k in params
        }
        # A declared parameter decides what the language argument is called.
        # Only fall back to language_id-through-**kwargs when neither name is
        # declared: a model with both `lang` and **kwargs would otherwise keep
        # its default and synthesise the wrong language without complaining.
        if "language_id" in params:
            filtered_kwargs["language_id"] = language_id
        elif "lang" in params:
            filtered_kwargs["lang"] = language_id
        elif has_var_keyword:
            filtered_kwargs["language_id"] = language_id

        return self.model.generate(**filtered_kwargs)

    def _render_row(self, row: dict) -> np.ndarray:
        with self._lock:
            # Load cached speaker conditionals onto model instance
            self.model.conds = row["speaker_conds"]

            with torch.inference_mode():
                wav = self._safe_generate(
                    text=row["text"],
                    language_id=row["language_id"],
                    exaggeration=row["exaggeration"],
                    cfg_weight=0.5,
                    temperature=0.8,
                    repetition_penalty=1.2,
                    min_p=0.05,
                    top_p=1.0,
                )

        if isinstance(wav, torch.Tensor):
            audio = wav.detach().cpu().squeeze().numpy().astype(np.float32)
        else:
            audio = np.asarray(wav, dtype=np.float32).squeeze()

        if audio.ndim == 0:
            audio = np.atleast_1d(audio)

        # Sanitize non-finite values and clamp raw vocoder output
        audio = np.nan_to_num(audio, copy=False, nan=0.0, posinf=1.0, neginf=-1.0)
        audio = np.clip(audio, -1.0, 1.0, out=audio)

        if audio is None or audio.size == 0 or np.all(audio == 0):
            raise RuntimeError(f"Chatterbox voice generation failed for voice '{row['voice_id']}'")

        # A request inside the deadband, or audio too short to hold two overlap
        # frames, keeps the render exactly as the model produced it. Nothing
        # audible is lost either way, and an untouched waveform is the best one.
        if abs(row["speed"] - 1.0) > SPEED_DEADBAND:
            audio = time_stretch_wsola(audio, row["speed"]).astype(np.float32)
            # Overlap-add sums two windowed frames, so a coherent match can peak
            # above the input's own range.
            audio = np.nan_to_num(audio, copy=False, nan=0.0, posinf=1.0, neginf=-1.0)
            audio = np.clip(audio, -1.0, 1.0, out=audio)

        return audio

    def generate_batch(self, items: list) -> list:
        """Render dialogue items with per-line error isolation."""
        self._ensure_loaded()

        results = [None] * len(items)
        pending = []
        for index, item in enumerate(items):
            try:
                row = self._prepare_row(item)
            except Exception as error:
                results[index] = error
                continue
            if row is None:
                results[index] = np.zeros(0, dtype=np.float32)
                continue
            pending.append((index, row))

        for index, row in pending:
            try:
                results[index] = self._render_row(row)
            except Exception as error:
                results[index] = error

        return results

    def generate(
        self,
        text: str,
        voice_id: str = "default",
        reference_audio_bytes: bytes = None,
        exaggeration: float = 0.5,
        speed: float = 1.0,
        language_id: str = "en",
    ) -> np.ndarray:
        result = self.generate_batch([{
            "text": text,
            "voice_id": voice_id,
            "reference_audio_bytes": reference_audio_bytes,
            "exaggeration": exaggeration,
            "speed": speed,
            "language_id": language_id,
        }])[0]
        if isinstance(result, Exception):
            raise result
        return result

    def warmup(self):
        """Pre-warm model kernels and speaker conditioning before first billed request."""
        self._ensure_loaded()

        voice_id = "__warmup__"
        try:
            if voice_id not in self.speakers_cache:
                samples = np.arange(self.sample_rate, dtype=np.float32) / self.sample_rate
                tone = (0.05 * np.sin(2 * np.pi * 220.0 * samples)).astype(np.float32)
                buf = io.BytesIO()
                sf.write(buf, tone, self.sample_rate, format="WAV", subtype="PCM_16")
                self.register_speaker_reference(voice_id, buf.getvalue())

            result = self.generate(
                text="Warm up.",
                voice_id=voice_id,
                exaggeration=0.5,
                speed=1.0,
            )
            if isinstance(result, Exception):
                raise result
            print(f"[ChatterboxEngine] Warmup complete ({len(result)} samples)")
        except Exception as error:
            print(f"[ChatterboxEngine] Warmup notice (non-fatal): {error}")
        finally:
            with self._lock:
                self.speakers_cache.pop(voice_id, None)
