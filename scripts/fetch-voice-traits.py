#!/usr/bin/env python3
"""
Fetches the per-speaker voice traits that LibriTTS-R itself does not record.

The catalog built by build-voice-catalog.mjs knows a reader's name, their
recorded sex, and whatever can be measured off the shipped clip. It does not
know how old the voice sounds or where the reader is from, and guessing either
from the audio was the thing the old rule rightly forbade. Both facts are
published instead, keyed by the same LibriTTS-R speaker ids we already ship:

  LibriTTS-P   https://github.com/line/libritts-p            CC BY 4.0
    Three professional annotators independently described every one of the
    2,443 LibriTTS-R speakers. data/df{1,2,3}_en.csv are one annotator each,
    `speaker_id|word,word,...`, where the age words are young / adult-like /
    middle-aged / mature / old and the gender words are masculine / feminine /
    gender-neutral, each optionally graded "slightly" or "very".

  parler-tts/libritts-r-filtered-speaker-descriptions            CC BY 4.0
    Carries an `accent` column that is constant across every utterance of a
    given speaker, i.e. a speaker-level label rather than a per-clip guess.

This writes the pooled result to scripts/voice-traits.json, which is committed.
Nothing in the app build reads the network or this script; apply-voice-traits.mjs
turns the committed scores into bands. Run it only to refresh the annotations:

    uv run --with pyarrow scripts/fetch-voice-traits.py --refresh

Downloads are cached in the temp dir between runs; --refresh re-downloads them,
which is what you want when picking up an upstream correction.

Python is here solely because the accent column lives in Parquet. It is not a
project dependency and `npm run build` never invokes it.
"""

import collections
import json
import os
import pathlib
import re
import sys
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "scripts" / "voice-traits.json"

LIBRITTS_P_BASE = "https://raw.githubusercontent.com/line/libritts-p/main/data"
ANNOTATOR_FILES = ("df1_en.csv", "df2_en.csv", "df3_en.csv")

PARQUET_BASE = (
    "https://huggingface.co/api/datasets/"
    "parler-tts/libritts-r-filtered-speaker-descriptions/parquet/clean"
)
# The catalog only ships speakers from the corpus's own `clean` subsets, so the
# `other` config is deliberately not fetched.
PARQUET_SPLITS = ("dev.clean", "test.clean", "train.clean.100", "train.clean.360")

# "slightly cute, cute, very cute" is the intensity ladder the annotators were
# given, so a bare word counts once and the graded forms scale it.
INTENSITY = re.compile(r"^(very|slightly)\s+")
INTENSITY_WEIGHT = {"very": 1.5, "slightly": 0.5}

# Signed so that pooling is a plain sum: negative reads younger, positive older.
# `adult-like` is scored zero rather than dropped because it is the word almost
# every speaker attracts, and counting it would swamp the directional ones.
AGE_WEIGHT = {"young": -1.0, "adult-like": 0.0, "middle-aged": 1.0, "mature": 1.5, "old": 2.0}
GENDER_WORDS = ("masculine", "feminine", "gender-neutral")


def fetch(url, dest, refresh=False):
    """Cached by filename. The cache has to be bypassable: the only reason to
    run this script twice is to pick up an upstream correction, and silently
    reusing the previous download would make that a no-op."""
    if refresh or not dest.exists():
        print(f"  fetching {url}")
        urllib.request.urlretrieve(url, dest)
    else:
        print(f"  cached   {dest.name} (--refresh to re-download)")
    return dest


def read_annotator(path):
    """One annotator's file: `speaker_id|word,word,...` per line."""
    rows = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if not line or "|" not in line:
                continue
            speaker, words = line.split("|", 1)
            rows[speaker.strip()] = [w.strip() for w in words.split(",") if w.strip()]
    return rows


def graded(word):
    """Split "very mature" into its base word and its intensity multiplier."""
    match = INTENSITY.match(word)
    return INTENSITY.sub("", word), INTENSITY_WEIGHT.get(match.group(1) if match else "", 1.0)


def pool_annotations(annotators):
    """Average the three annotators into one age score and one gender vote."""
    traits = {}
    for speaker in annotators[0]:
        age_words = collections.Counter()
        gender_words = collections.Counter()
        score = 0.0
        for annotator in annotators:
            for word in annotator.get(speaker, []):
                base, weight = graded(word)
                if base in AGE_WEIGHT:
                    age_words[base] += weight
                    score += AGE_WEIGHT[base] * weight
                elif base in GENDER_WORDS:
                    gender_words[base] += weight
        if not age_words and not gender_words:
            continue
        traits[speaker] = {
            "ageScore": round(score / len(annotators), 4),
            "ageWords": {k: round(v, 2) for k, v in sorted(age_words.items())},
            "perceivedGender": gender_words.most_common(1)[0][0] if gender_words else "",
        }
    return traits


def read_accents(work_dir, refresh=False):
    """Speaker -> accent, verifying the label really is constant per speaker."""
    import pyarrow.parquet as pq

    by_speaker = collections.defaultdict(collections.Counter)
    for split in PARQUET_SPLITS:
        path = fetch(f"{PARQUET_BASE}/{split}/0.parquet", work_dir / f"{split}.parquet", refresh)
        table = pq.read_table(path, columns=["speaker_id", "accent"])
        for speaker, accent in zip(table["speaker_id"].to_pylist(), table["accent"].to_pylist()):
            if accent:
                by_speaker[speaker][accent] += 1

    # The whole reason this column is usable is that it does not vary per
    # utterance. If that ever stops being true it is a per-clip guess, not a
    # speaker fact, and it must not be shipped as one.
    conflicted = sorted(s for s, counts in by_speaker.items() if len(counts) > 1)
    if conflicted:
        raise SystemExit(
            f"{len(conflicted)} speakers carry more than one accent value "
            f"(e.g. {conflicted[:5]}); the column is no longer speaker-level."
        )
    return {speaker: counts.most_common(1)[0][0] for speaker, counts in by_speaker.items()}


def main():
    refresh = "--refresh" in sys.argv[1:]
    work_dir = pathlib.Path(tempfile.gettempdir()) / "scriptreader-voice-traits"
    work_dir.mkdir(parents=True, exist_ok=True)
    print(f"work dir {work_dir}")

    print("LibriTTS-P speaker prompts:")
    annotators = [
        read_annotator(fetch(f"{LIBRITTS_P_BASE}/{name}", work_dir / name, refresh))
        for name in ANNOTATOR_FILES
    ]
    traits = pool_annotations(annotators)
    print(f"  pooled {len(traits)} speakers from {len(annotators)} annotators")

    print("parler-tts accent column:")
    accents = read_accents(work_dir, refresh)
    print(f"  {len(accents)} speakers")

    for speaker, accent in accents.items():
        traits.setdefault(speaker, {"ageScore": None, "ageWords": {}, "perceivedGender": ""})
        traits[speaker]["accent"] = accent
    for record in traits.values():
        record.setdefault("accent", "")

    header = {
        "sources": [
            {
                "name": "LibriTTS-P",
                "url": "https://github.com/line/libritts-p",
                "license": "CC BY 4.0",
                "provides": ["ageScore", "ageWords", "perceivedGender"],
            },
            {
                "name": "parler-tts/libritts-r-filtered-speaker-descriptions",
                "url": "https://huggingface.co/datasets/parler-tts/libritts-r-filtered-speaker-descriptions",
                "license": "CC BY 4.0",
                "provides": ["accent"],
            },
        ],
        "ageWeights": AGE_WEIGHT,
        "intensityWeights": INTENSITY_WEIGHT,
    }
    # One line per speaker: still ordinary JSON, but a re-fetch that changes one
    # reader shows up as a one-line diff instead of a reflowed file.
    lines = [json.dumps(header, indent=2)[1:-1].strip("\n") + ",", '  "speakers": {']
    ordered = sorted(traits.items(), key=lambda kv: int(kv[0]))
    for index, (speaker, record) in enumerate(ordered):
        comma = "," if index < len(ordered) - 1 else ""
        lines.append(f"    {json.dumps(speaker)}: {json.dumps(record, separators=(',', ':'))}{comma}")
    lines += ["  }", "}"]
    OUT_PATH.write_text("{\n" + "\n".join(lines) + "\n", encoding="utf-8")

    json.loads(OUT_PATH.read_text(encoding="utf-8"))  # never commit a file we cannot read back
    print(f"\nwrote {OUT_PATH.relative_to(ROOT)} — {len(traits)} speakers, "
          f"{OUT_PATH.stat().st_size / 1000:.0f} KB")


if __name__ == "__main__":
    main()
