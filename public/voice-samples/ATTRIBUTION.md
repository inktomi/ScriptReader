# Voice sample attribution

The reference clips in this directory, and the metadata in `catalog.json`, are
derived from the **LibriTTS-R** corpus and from two annotation sets that cover
the same speakers. All three are used under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

> LibriTTS-R: A Restored Multi-Speaker Text-to-Speech Corpus.
> Yuma Koizumi, Heiga Zen, Shigeki Karita, Yifan Ding, Kohei Yatabe, Nobuyuki
> Morioka, Michiel Bacchiani, Yu Zhang, Wei Han, Ankur Bapna. Google LLC, 2023.
> <https://www.openslr.org/141/>

> LibriTTS-P: A Corpus with Speaking Style and Speaker Identity Prompts for
> Text-to-Speech and Style Captioning.
> Masaya Kawamura, Ryuichi Yamamoto, Yuma Shirahata, Takuya Hasumi, Kentaro
> Tachibana. LINE Corporation, Proc. Interspeech 2024.
> <https://github.com/line/libritts-p>

> Annotated LibriTTS-R — `parler-tts/libritts-r-filtered-speaker-descriptions`.
> Hugging Face, derived from LibriTTS-R via the Data-Speech pipeline.
> <https://huggingface.co/datasets/parler-tts/libritts-r-filtered-speaker-descriptions>

LibriTTS-R is made available by Google LLC and is itself derived from LibriTTS
and from public-domain LibriVox audiobook recordings. The individual readers are
credited by name in `catalog.json` and on each voice card in the app.

## What was changed

`scripts/build-voice-catalog.mjs` produced these clips from the corpus. For each
speaker it selects a short run of utterances from a single chapter, trims silence
at the head and tail, normalises loudness to -18 LUFS, and encodes 10 seconds of
mono 24 kHz MP3. No other processing is applied.

Only the corpus's own `clean` subsets are used. `train-other-500` is excluded
because LibriTTS grades it as harder, noisier audio.

## What the metadata means

`gender` and the reader's name come from the LibriTTS-R speaker table.

Measured from the shipped clip itself:

- `pitchHz` — median fundamental frequency over voiced frames, and the
  `register` band derived from it.
- `wordsPerMinute` — words in the source transcripts over their speech duration,
  and the `pace` band derived from it.
- `snrDb` — the clip's speech level over its noise floor, which drives ranking
  and the quality label.

Taken from the annotation sets above, by speaker id, by
`scripts/fetch-voice-traits.py`:

- `ageBand` — pooled from LibriTTS-P, where three professional annotators
  independently described each speaker using `young`, `adult-like`,
  `middle-aged`, `mature` and `old`, optionally graded "slightly" or "very".
  Their pooled score is ranked against the same-gender distribution, because the
  annotators applied the vocabulary on a gender-relative scale: `mature` was
  used for 84.7% of the male readers here but only 3.4% of the female ones.
- `perceivedGender` — also LibriTTS-P, recorded only where the annotators heard
  the recording as the opposite of what the speaker table states, which is true
  for 20 of the 1,150 readers.
- `accent` — the `accent` column of the parler-tts speaker descriptions, which
  is constant across every utterance of a given speaker.

Nothing in `catalog.json` is inferred from the audio by a model or a heuristic.
Where a source does not cover a reader — four of the 1,150 — the value is
`unspecified` or `Unspecified` rather than a guess. These are real people who
volunteered recordings to the public domain; the app repeats what the corpus and
its annotators recorded, and invents nothing else about them.
