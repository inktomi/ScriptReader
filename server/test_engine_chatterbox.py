import io
import os
import sys
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))


class FakeInferenceMode:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class FakeTensor:
    def __init__(self, array):
        self._array = np.asarray(array, dtype=np.float32)

    def detach(self):
        return self

    def cpu(self):
        return self

    def squeeze(self):
        return self

    def numpy(self):
        return self._array


class FakeSoundFile:
    @staticmethod
    def read(buffer, dtype="float32"):
        return np.full(2400, 0.1, dtype=np.float32), 24000

    @staticmethod
    def write(target, audio, sample_rate, format=None, subtype=None):
        pass


# Mock torch and soundfile if not installed in test environment
fake_torch = types.SimpleNamespace(
    cuda=types.SimpleNamespace(is_available=lambda: False),
    inference_mode=lambda: FakeInferenceMode(),
    backends=types.SimpleNamespace(
        cuda=types.SimpleNamespace(matmul=types.SimpleNamespace(allow_tf32=True)),
        cudnn=types.SimpleNamespace(allow_tf32=True),
    ),
    Tensor=FakeTensor,
)
sys.modules.setdefault("torch", fake_torch)
sys.modules.setdefault("soundfile", FakeSoundFile)
sys.modules.setdefault("librosa", types.SimpleNamespace(
    effects=types.SimpleNamespace(time_stretch=lambda y, rate: y)
))

from engine_chatterbox import ChatterboxEngine, LRUSpeakerCache  # noqa: E402


class FakeChatterboxModel:
    def __init__(self, sr=24000):
        self.sr = sr
        self.conds = None
        self.recorded_calls = []

    def prepare_conditionals(self, wav_path, exaggeration=0.5):
        self.conds = ("fake_conds", wav_path, exaggeration)

    def generate(
        self,
        text,
        audio_prompt_path=None,
        language_id="en",
        exaggeration=0.5,
        cfg_weight=0.5,
        temperature=0.8,
        repetition_penalty=1.2,
        min_p=0.05,
        top_p=1.0,
    ):
        self.recorded_calls.append({
            "text": text,
            "language_id": language_id,
            "exaggeration": exaggeration,
            "cfg_weight": cfg_weight,
            "temperature": temperature,
            "repetition_penalty": repetition_penalty,
            "min_p": min_p,
            "top_p": top_p,
            "conds": self.conds,
        })
        # 100 samples of 0.25 float
        return FakeTensor(np.full(100, 0.25, dtype=np.float32))


class ConcurrentFakeChatterboxModel:
    def __init__(self, sr=24000):
        self.sr = sr
        self.conds = None
        self.generation_records = []
        self._active_generations = 0
        self.had_concurrent_execution = False
        self._lock = threading.Lock()
        self.prepare_count = 0

    def prepare_conditionals(self, wav_path, exaggeration=0.5):
        time.sleep(0.01)
        self.conds = ("fake_conds", wav_path, exaggeration)
        with self._lock:
            self.prepare_count += 1

    def generate(self, text, **kwargs):
        current_conds = self.conds
        with self._lock:
            self._active_generations += 1
            if self._active_generations > 1:
                self.had_concurrent_execution = True

        # Simulate GPU inference delay where GIL would be released
        time.sleep(0.02)

        exit_conds = self.conds
        with self._lock:
            self.generation_records.append({
                "text": text,
                "entry_conds": current_conds,
                "exit_conds": exit_conds,
                "corrupted": current_conds != exit_conds,
            })
            self._active_generations -= 1

        return FakeTensor(np.full(100, 0.25, dtype=np.float32))



class ChatterboxEngineTests(unittest.TestCase):
    def setUp(self):
        self.fake_model = FakeChatterboxModel()

    def _build_engine(self, require_gpu=False):
        engine = ChatterboxEngine(require_gpu=require_gpu)
        engine.model = self.fake_model
        engine.device = "cpu"
        engine._initialized = True
        return engine

    def test_generate_runs_with_registered_speaker_conditionals(self):
        engine = self._build_engine()

        with mock.patch("engine_chatterbox.sf", FakeSoundFile):
            engine.register_speaker_reference("speaker_1", b"fake_wav_bytes")

        self.assertIn("speaker_1", engine.speakers_cache)
        self.assertIsNotNone(engine.speakers_cache["speaker_1"])

        audio = engine.generate(
            text="Hello world.",
            voice_id="speaker_1",
            exaggeration=0.65,
            speed=1.0,
            language_id="fr",
        )

        self.assertIsInstance(audio, np.ndarray)
        self.assertEqual(len(audio), 100)
        self.assertEqual(len(self.fake_model.recorded_calls), 1)

        call = self.fake_model.recorded_calls[0]
        self.assertEqual(call["text"], "Hello world.")
        self.assertEqual(call["language_id"], "fr")
        self.assertEqual(call["exaggeration"], 0.65)
        self.assertEqual(call["cfg_weight"], 0.5)
        self.assertEqual(call["temperature"], 0.8)
        self.assertEqual(call["min_p"], 0.05)
        self.assertEqual(call["repetition_penalty"], 1.2)

    def test_generate_returns_empty_for_unspeakable_or_empty_text(self):
        engine = self._build_engine()

        for unspeakable in ("", "   ", "...", "--", "( )", "!?", "- - -"):
            audio = engine.generate(unspeakable, voice_id="voice@2")
            self.assertEqual(len(audio), 0)
            self.assertEqual(audio.dtype, np.float32)

    def test_missing_reference_raises_runtime_error(self):
        engine = self._build_engine()
        with self.assertRaisesRegex(RuntimeError, "has no reference recording"):
            engine.generate("Hello there.", voice_id="unregistered_voice")

    def test_batched_render_isolates_failures_per_line(self):
        engine = self._build_engine()
        engine.speakers_cache["voice_good"] = ("mock_conds",)

        items = [
            {"text": "Line one.", "voice_id": "voice_good", "exaggeration": 0.5},
            {"text": "Line two.", "voice_id": "voice_missing", "exaggeration": 0.5},
            {"text": "Line three.", "voice_id": "voice_good", "exaggeration": 0.5},
            {"text": "...", "voice_id": "voice_good", "exaggeration": 0.5},
        ]

        results = engine.generate_batch(items)

        self.assertEqual(len(results), 4)
        self.assertIsInstance(results[0], np.ndarray)
        self.assertEqual(len(results[0]), 100)
        self.assertIsInstance(results[1], Exception)
        self.assertIn("has no reference recording", str(results[1]))
        self.assertIsInstance(results[2], np.ndarray)
        self.assertEqual(len(results[2]), 100)
        self.assertIsInstance(results[3], np.ndarray)
        self.assertEqual(len(results[3]), 0)

    def test_speed_modification_applies_time_stretch(self):
        engine = self._build_engine()
        engine.speakers_cache["voice_good"] = ("mock_conds",)

        with mock.patch("librosa.effects.time_stretch", return_value=np.full(80, 0.25, dtype=np.float32)) as stretch:
            audio = engine.generate("Line text.", voice_id="voice_good", speed=1.25)
            self.assertEqual(len(audio), 80)
            stretch.assert_called_once()

    def test_gpu_requirement_enforcement(self):
        engine = ChatterboxEngine(require_gpu=True)
        engine.device = "cpu"
        with self.assertRaisesRegex(RuntimeError, "Chatterbox requires a CUDA device"):
            engine._ensure_loaded()

    def test_warmup_executes_and_cleans_cache(self):
        engine = self._build_engine()
        with mock.patch("engine_chatterbox.sf", FakeSoundFile):
            engine.warmup()
        self.assertNotIn("__warmup__", engine.speakers_cache)

    def test_batch_caches_reference_from_unspeakable_first_item(self):
        engine = self._build_engine()

        items = [
            {
                "text": "...",
                "voice_id": "voice_early_ref",
                "reference_audio_bytes": b"fake_wav_bytes",
            },
            {
                "text": "This line must succeed.",
                "voice_id": "voice_early_ref",
                "reference_audio_bytes": None,
            },
        ]

        with mock.patch("engine_chatterbox.sf", FakeSoundFile):
            results = engine.generate_batch(items)

        # Voice should be successfully registered in cache
        self.assertIn("voice_early_ref", engine.speakers_cache)
        self.assertIsNotNone(engine.speakers_cache["voice_early_ref"])

        # Item 0 returns empty array
        self.assertEqual(len(results), 2)
        self.assertIsInstance(results[0], np.ndarray)
        self.assertEqual(len(results[0]), 0)

        # Item 1 successfully rendered using the cached conditionals
        self.assertIsInstance(results[1], np.ndarray)
        self.assertEqual(len(results[1]), 100)

        # Model generate was called once for the speakable line
        self.assertEqual(len(self.fake_model.recorded_calls), 1)
        self.assertEqual(self.fake_model.recorded_calls[0]["text"], "This line must succeed.")

    def test_generate_caches_reference_even_if_single_call_is_unspeakable(self):
        engine = self._build_engine()

        with mock.patch("engine_chatterbox.sf", FakeSoundFile):
            # Prime cache with unspeakable text
            empty_audio = engine.generate(
                text="   ---   ",
                voice_id="voice_prime",
                reference_audio_bytes=b"fake_wav_bytes",
            )

        self.assertEqual(len(empty_audio), 0)
        self.assertIn("voice_prime", engine.speakers_cache)

        # Next call without reference audio should now succeed
        spoken_audio = engine.generate(
            text="Spoken line after priming.",
            voice_id="voice_prime",
        )
        self.assertEqual(len(spoken_audio), 100)
        self.assertEqual(len(self.fake_model.recorded_calls), 1)
        self.assertEqual(self.fake_model.recorded_calls[0]["text"], "Spoken line after priming.")

    def test_batch_unspeakable_with_corrupt_reference_isolates_error(self):
        engine = self._build_engine()

        class ErrorSoundFile:
            @staticmethod
            def read(buffer, dtype="float32"):
                raise RuntimeError("Invalid WAV header")

        items = [
            {
                "text": "...",
                "voice_id": "voice_bad_ref",
                "reference_audio_bytes": b"invalid_bytes",
            },
        ]

        with mock.patch("engine_chatterbox.sf", ErrorSoundFile):
            results = engine.generate_batch(items)

        self.assertEqual(len(results), 1)
        self.assertIsInstance(results[0], Exception)
        self.assertIn("Invalid WAV header", str(results[0]))
        self.assertNotIn("voice_bad_ref", engine.speakers_cache)

    def test_batch_unspeakable_without_reference_returns_empty_and_does_not_cache(self):
        engine = self._build_engine()

        items = [
            {
                "text": "...",
                "voice_id": "voice_never_registered",
                "reference_audio_bytes": None,
            },
            {
                "text": "Spoken line",
                "voice_id": "voice_never_registered",
                "reference_audio_bytes": None,
            },
        ]

        results = engine.generate_batch(items)
        self.assertEqual(len(results), 2)
        self.assertIsInstance(results[0], np.ndarray)
        self.assertEqual(len(results[0]), 0)
        self.assertIsInstance(results[1], Exception)
        self.assertIn("has no reference recording", str(results[1]))
        self.assertNotIn("voice_never_registered", engine.speakers_cache)

    def test_concurrent_generation_protects_speaker_conditionals(self):
        concurrent_model = ConcurrentFakeChatterboxModel()
        engine = self._build_engine()
        engine.model = concurrent_model

        voices = [f"speaker_{i}" for i in range(5)]
        for v in voices:
            engine.speakers_cache[v] = (f"conds_for_{v}",)

        errors = []
        threads = []
        num_threads = 10

        def worker(thread_idx):
            try:
                voice = voices[thread_idx % len(voices)]
                audio = engine.generate(
                    text=f"Line from thread {thread_idx}",
                    voice_id=voice,
                )
                if len(audio) != 100:
                    errors.append(f"Thread {thread_idx} received invalid audio length")
            except Exception as e:
                errors.append(f"Thread {thread_idx} failed: {e}")

        for i in range(num_threads):
            t = threading.Thread(target=worker, args=(i,))
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        self.assertFalse(concurrent_model.had_concurrent_execution)
        self.assertEqual(len(concurrent_model.generation_records), num_threads)
        for record in concurrent_model.generation_records:
            self.assertFalse(record["corrupted"], f"State corrupted in record: {record}")
            expected_conds = (f"conds_for_speaker_{int(record['text'].split()[-1]) % len(voices)}",)
            self.assertEqual(record["entry_conds"], expected_conds)
            self.assertEqual(record["exit_conds"], expected_conds)

    def test_concurrent_registration_and_generation_safety(self):
        concurrent_model = ConcurrentFakeChatterboxModel()
        engine = self._build_engine()
        engine.model = concurrent_model
        engine.speakers_cache["speaker_static"] = ("conds_static",)

        errors = []
        threads = []

        def registration_worker(i):
            try:
                engine.register_speaker_reference(f"dynamic_speaker_{i}", b"audio_bytes")
            except Exception as e:
                errors.append(f"Reg {i} failed: {e}")

        def generation_worker(i):
            try:
                audio = engine.generate(f"Generation line {i}", voice_id="speaker_static")
                if len(audio) != 100:
                    errors.append(f"Gen {i} invalid audio length")
            except Exception as e:
                errors.append(f"Gen {i} failed: {e}")

        with mock.patch("engine_chatterbox.sf", FakeSoundFile):
            for i in range(5):
                threads.append(threading.Thread(target=registration_worker, args=(i,)))
                threads.append(threading.Thread(target=generation_worker, args=(i,)))

            for t in threads:
                t.start()
            for t in threads:
                t.join()

        self.assertEqual(errors, [])
        self.assertFalse(concurrent_model.had_concurrent_execution)
        for i in range(5):
            self.assertIn(f"dynamic_speaker_{i}", engine.speakers_cache)

    def test_concurrent_registration_same_voice_deduplicates_model_prepare(self):
        concurrent_model = ConcurrentFakeChatterboxModel()
        engine = self._build_engine()
        engine.model = concurrent_model

        threads = []
        errors = []

        def worker():
            try:
                engine.register_speaker_reference("shared_voice", b"audio_bytes")
            except Exception as e:
                errors.append(e)

        with mock.patch("engine_chatterbox.sf", FakeSoundFile):
            for _ in range(8):
                t = threading.Thread(target=worker)
                threads.append(t)
                t.start()

            for t in threads:
                t.join()

        self.assertEqual(errors, [])
        self.assertIn("shared_voice", engine.speakers_cache)
        self.assertEqual(concurrent_model.prepare_count, 1)

    def test_concurrent_ensure_loaded_initializes_once(self):
        engine = ChatterboxEngine(require_gpu=False)
        engine.device = "cpu"
        engine._initialized = False
        load_count = 0
        load_lock = threading.Lock()

        class MockTTS:
            sr = 24000

            @classmethod
            def from_pretrained(cls, *args, **kwargs):
                nonlocal load_count
                with load_lock:
                    load_count += 1
                time.sleep(0.02)
                return FakeChatterboxModel()

        errors = []
        threads = []

        def worker():
            try:
                with mock.patch.dict("sys.modules", {"chatterbox.mtl_tts": types.SimpleNamespace(ChatterboxMultilingualTTS=MockTTS)}):
                    engine._ensure_loaded()
            except Exception as e:
                errors.append(e)

        for _ in range(8):
            t = threading.Thread(target=worker)
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        self.assertEqual(errors, [])
        self.assertTrue(engine._initialized)
        self.assertEqual(load_count, 1)

    def test_lock_released_on_generation_error(self):
        engine = self._build_engine()

        class ErrorModel:
            def __init__(self):
                self.sr = 24000
                self.conds = None

            def generate(self, *args, **kwargs):
                raise RuntimeError("Simulated CUDA failure")

        engine.model = ErrorModel()
        engine.speakers_cache["voice_fail"] = ("conds",)

        with self.assertRaisesRegex(RuntimeError, "Simulated CUDA failure"):
            engine.generate("Fail text", voice_id="voice_fail")

        # Verify the lock is released: we can acquire it without blocking
        acquired = engine._lock.acquire(blocking=False)
        self.assertTrue(acquired)
        if acquired:
            engine._lock.release()

        # Now replace with working model and verify generate succeeds
        engine.model = self.fake_model
        audio = engine.generate("Recovery text", voice_id="voice_fail")
        self.assertEqual(len(audio), 100)

    def test_lock_released_on_prepare_conditionals_error(self):
        engine = self._build_engine()

        class ErrorModel:
            def __init__(self):
                self.sr = 24000
                self.conds = None

            def prepare_conditionals(self, *args, **kwargs):
                raise RuntimeError("Simulated prepare failure")

        engine.model = ErrorModel()

        with mock.patch("engine_chatterbox.sf", FakeSoundFile):
            with self.assertRaisesRegex(RuntimeError, "Simulated prepare failure"):
                engine.register_speaker_reference("voice_fail", b"audio_bytes")

        # Verify the lock is released
        acquired = engine._lock.acquire(blocking=False)
        self.assertTrue(acquired)
        if acquired:
            engine._lock.release()

    def test_cache_capacity_enforced(self):
        cache = LRUSpeakerCache(maxsize=3)
        cache["v1"] = "cond1"
        cache["v2"] = "cond2"
        cache["v3"] = "cond3"
        cache["v4"] = "cond4"

        self.assertEqual(len(cache), 3)
        self.assertNotIn("v1", cache)
        self.assertIn("v2", cache)
        self.assertIn("v3", cache)
        self.assertIn("v4", cache)

    def test_cache_lru_eviction_order(self):
        cache = LRUSpeakerCache(maxsize=3)
        cache["v1"] = "cond1"
        cache["v2"] = "cond2"
        cache["v3"] = "cond3"

        cache["v4"] = "cond4"
        self.assertEqual(list(cache.keys()), ["v2", "v3", "v4"])

        cache["v5"] = "cond5"
        self.assertEqual(list(cache.keys()), ["v3", "v4", "v5"])

    def test_cache_get_and_getitem_promotes_to_mru(self):
        cache = LRUSpeakerCache(maxsize=3)
        cache["v1"] = "cond1"
        cache["v2"] = "cond2"
        cache["v3"] = "cond3"

        # Access v1 via get() to make v2 the oldest
        _ = cache.get("v1")
        cache["v4"] = "cond4"

        self.assertNotIn("v2", cache)
        self.assertIn("v1", cache)
        self.assertIn("v3", cache)
        self.assertIn("v4", cache)

        # Access v3 via __getitem__ to make v1 the oldest
        _ = cache["v3"]
        cache["v5"] = "cond5"

        self.assertNotIn("v1", cache)
        self.assertIn("v3", cache)
        self.assertIn("v4", cache)
        self.assertIn("v5", cache)

    def test_cache_re_registration_updates_and_promotes(self):
        cache = LRUSpeakerCache(maxsize=3)
        cache["v1"] = "cond1"
        cache["v2"] = "cond2"
        cache["v3"] = "cond3"

        cache["v1"] = "cond1_updated"
        cache["v4"] = "cond4"

        self.assertNotIn("v2", cache)
        self.assertEqual(list(cache.keys()), ["v3", "v1", "v4"])
        self.assertEqual(cache["v1"], "cond1_updated")
        self.assertEqual(list(cache.keys()), ["v3", "v4", "v1"])

    def test_cache_methods_and_copies(self):
        cache = LRUSpeakerCache(maxsize=3)
        cache["v1"] = "c1"
        cache["v2"] = "c2"

        self.assertEqual(cache.keys(), ["v1", "v2"])
        self.assertEqual(cache.values(), ["c1", "c2"])
        self.assertEqual(cache.items(), [("v1", "c1"), ("v2", "c2")])

        # Test pop
        popped = cache.pop("v1")
        self.assertEqual(popped, "c1")
        self.assertNotIn("v1", cache)
        self.assertEqual(cache.pop("nonexistent", "fallback"), "fallback")

        # Test __delitem__
        cache["v3"] = "c3"
        del cache["v2"]
        self.assertNotIn("v2", cache)
        self.assertEqual(len(cache), 1)

        # Test clear
        cache.clear()
        self.assertEqual(len(cache), 0)

    def test_cache_min_size_enforcement(self):
        cache_zero = LRUSpeakerCache(maxsize=0)
        self.assertEqual(cache_zero.maxsize, 1)

        cache_neg = LRUSpeakerCache(maxsize=-5)
        self.assertEqual(cache_neg.maxsize, 1)

    def test_batch_generation_exceeding_cache_capacity_succeeds(self):
        engine = ChatterboxEngine(require_gpu=False, max_cache_size=2)
        engine.model = self.fake_model
        engine.device = "cpu"
        engine._initialized = True

        items = [
            {"text": "Line 1.", "voice_id": "v1", "reference_audio_bytes": b"wav1"},
            {"text": "Line 2.", "voice_id": "v2", "reference_audio_bytes": b"wav2"},
            {"text": "Line 3.", "voice_id": "v3", "reference_audio_bytes": b"wav3"},
            {"text": "Line 4.", "voice_id": "v4", "reference_audio_bytes": b"wav4"},
        ]

        with mock.patch("engine_chatterbox.sf", FakeSoundFile):
            results = engine.generate_batch(items)

        self.assertEqual(len(results), 4)
        for r in results:
            self.assertIsInstance(r, np.ndarray)
            self.assertEqual(len(r), 100)

        # Only the 2 most recent voices remain in cache
        self.assertEqual(len(engine.speakers_cache), 2)
        self.assertNotIn("v1", engine.speakers_cache)
        self.assertNotIn("v2", engine.speakers_cache)
        self.assertIn("v3", engine.speakers_cache)
        self.assertIn("v4", engine.speakers_cache)

    def test_cache_thread_safety_concurrent_access(self):
        cache = LRUSpeakerCache(maxsize=5)

        def worker(thread_id):
            for i in range(50):
                key = f"voice_{thread_id}_{i % 10}"
                cache[key] = f"cond_{thread_id}_{i}"
                _ = cache.get(key)

        threads = [threading.Thread(target=worker, args=(t,)) for t in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertLessEqual(len(cache), 5)

    def test_configurable_cache_size_via_env_var(self):
        with mock.patch.dict(os.environ, {"SCRIPTREADER_SPEAKER_CACHE_SIZE": "16"}):
            engine = ChatterboxEngine(require_gpu=False)
            self.assertEqual(engine.speakers_cache.maxsize, 16)

    def test_cache_explicit_constructor_arg(self):
        engine = ChatterboxEngine(require_gpu=False, max_cache_size=10)
        self.assertEqual(engine.speakers_cache.maxsize, 10)


if __name__ == "__main__":
    unittest.main()
