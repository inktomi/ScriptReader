# Voice sample attribution

The reference clips in this directory, and the metadata in `catalog.json`, are
derived from the **LibriTTS-R** corpus.

> LibriTTS-R: A Restored Multi-Speaker Text-to-Speech Corpus.
> Yuma Koizumi, Heiga Zen, Shigeki Karita, Yifan Ding, Kohei Yatabe, Nobuyuki
> Morioka, Michiel Bacchiani, Yu Zhang, Wei Han, Ankur Bapna. Google LLC, 2023.
> <https://www.openslr.org/141/>

LibriTTS-R is made available by Google LLC under a
[Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/),
and is itself derived from LibriTTS and from public-domain LibriVox audiobook
recordings. The individual readers are credited by name in `catalog.json` and on
each voice card in the app.

## What was changed

`scripts/build-voice-catalog.mjs` produced these clips from the corpus. For each
speaker it selects a short run of utterances from a single chapter, trims silence
at the head and tail, normalises loudness to -18 LUFS, and encodes 10 seconds of
mono 24 kHz MP3. No other processing is applied.

Only the corpus's own `clean` subsets are used. `train-other-500` is excluded
because LibriTTS grades it as harder, noisier audio.

## What the metadata means

`gender` and the reader's name come from the corpus speaker table. Everything
else in `catalog.json` is measured from the shipped clip itself:

- `pitchHz` — median fundamental frequency over voiced frames, and the
  `register` band derived from it.
- `wordsPerMinute` — words in the source transcripts over their speech duration,
  and the `pace` band derived from it.
- `snrDb` — the clip's speech level over its noise floor, which drives ranking
  and the quality label.

The corpus records no age, accent, or personality information for its speakers,
so the catalog states none. These are real people who volunteered recordings to
the public domain; the app describes how their recordings sound and does not
invent anything else about them.
