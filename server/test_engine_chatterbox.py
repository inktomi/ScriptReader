import sys
import types
import unittest

import numpy as np


# The unit exercises the ONNX orchestration with fake sessions; importing the
# production module must not require CUDA/PyTorch or libsndfile on a developer's
# machine.
sys.modules.setdefault("torch", types.SimpleNamespace(
    cuda=types.SimpleNamespace(is_available=lambda: False)
))
sys.modules.setdefault("soundfile", types.SimpleNamespace())

from engine_chatterbox import (  # noqa: E402
    ChatterboxEngine,
    SILENCE_TOKEN,
    START_SPEECH_TOKEN,
    STOP_SPEECH_TOKEN,
)


class Input:
    def __init__(self, name):
        self.name = name


class EmbedSession:
    def __init__(self):
        self.exaggerations = []

    def get_inputs(self):
        return [Input("input_ids"), Input("position_ids"), Input("exaggeration")]

    def run(self, _, feed):
        self.exaggerations.append(float(feed["exaggeration"][0]))
        width = feed["input_ids"].shape[1]
        return [np.zeros((1, width, 4), dtype=np.float32)]


class LanguageModelSession:
    def __init__(self):
        self.calls = 0
        self.past_names = [
            f"past_key_values.{layer}.{kind}"
            for layer in range(30)
            for kind in ("key", "value")
        ]

    def get_inputs(self):
        return [Input("inputs_embeds"), Input("attention_mask"), *map(Input, self.past_names)]

    def run(self, _, feed):
        self.calls += 1
        sequence_length = feed["inputs_embeds"].shape[1]
        logits = np.zeros((1, sequence_length, STOP_SPEECH_TOKEN + 1), dtype=np.float32)
        token = 42 if self.calls == 1 else STOP_SPEECH_TOKEN
        logits[0, -1, token] = 10
        present = [np.zeros((1, 16, sequence_length, 64), dtype=np.float32) for _ in self.past_names]
        return [logits, *present]


class DecoderSession:
    def __init__(self):
        self.feed = None

    def get_inputs(self):
        return [Input("speech_tokens"), Input("speaker_embeddings"), Input("speaker_features")]

    def run(self, _, feed):
        self.feed = feed
        return [np.array([[0.1, -0.1, 0.2]], dtype=np.float32)]


class Tokenizer:
    def __call__(self, _text, return_tensors):
        assert return_tensors == "np"
        return {"input_ids": np.array([[11, 12]], dtype=np.int64)}


class ChatterboxPipelineTests(unittest.TestCase):
    def test_generate_runs_embedding_language_model_and_decoder(self):
        engine = ChatterboxEngine.__new__(ChatterboxEngine)
        engine.sample_rate = 24000
        engine.tokenizer = Tokenizer()
        embed = EmbedSession()
        language_model = LanguageModelSession()
        decoder = DecoderSession()
        engine.sessions = {
            "embed_tokens": embed,
            "language_model": language_model,
            "conditional_decoder": decoder,
        }
        engine.speakers_cache = {
            "voice@2": (
                np.zeros((1, 1, 4), dtype=np.float32),
                np.array([[START_SPEECH_TOKEN]], dtype=np.int64),
                np.zeros((1, 2), dtype=np.float32),
                np.zeros((1, 2), dtype=np.float32),
            )
        }
        engine._ensure_loaded = lambda: None

        audio = engine.generate("Hello", voice_id="voice@2", exaggeration=0.7, speed=1.0)

        self.assertEqual(language_model.calls, 2)
        for value in embed.exaggerations:
            self.assertAlmostEqual(value, 0.7)
        self.assertEqual(
            decoder.feed["speech_tokens"].tolist(),
            [[START_SPEECH_TOKEN, 42, SILENCE_TOKEN, SILENCE_TOKEN, SILENCE_TOKEN]],
        )
        np.testing.assert_allclose(audio, np.array([0.1, -0.1, 0.2], dtype=np.float32))

    def test_generate_returns_empty_for_unspeakable_or_empty_text(self):
        engine = ChatterboxEngine.__new__(ChatterboxEngine)
        engine.sample_rate = 24000
        engine.speakers_cache = {}
        engine._ensure_loaded = lambda: None

        for unspeakable in ("", "   ", "...", "--", "( )", "!?", "- - -"):
            audio = engine.generate(unspeakable, voice_id="voice@2")
            self.assertEqual(len(audio), 0)
            self.assertEqual(audio.dtype, np.float32)


if __name__ == "__main__":
    unittest.main()
