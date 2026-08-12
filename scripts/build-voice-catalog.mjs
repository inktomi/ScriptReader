#!/usr/bin/env node
/**
 * Builds the bundled voice-casting catalog from LibriTTS-R.
 *
 * The app used to search ElevenLabs' shared-voices endpoint live. That endpoint
 * now answers anonymous callers with 401 "You must be logged in to use
 * filters", so casting is built from a corpus we can redistribute instead:
 * LibriTTS-R (Google LLC, CC BY 4.0), the speech-restored rebuild of LibriTTS.
 * Its `clean` subsets are studio-grade audiobook narration, which is the same
 * performance register a screenplay reader needs.
 *
 * Only facts the corpus states are stored as metadata. Gender and reader name
 * come from the corpus speaker table; register and pace are measured off the
 * rendered audio. Nothing here infers age, accent, or personality, because
 * LibriTTS-R does not record them and casting copy must not invent them.
 *
 * Usage:
 *   node scripts/build-voice-catalog.mjs [--limit N] [--subsets a,b]
 *                                        [--force] [--relabel] [--report]
 *
 * The run is resumable at every stage. Archives resume per byte-range segment,
 * extracted subsets are marked done, and per-speaker measurements are appended
 * to a ledger, so an interrupted build picks up where it stopped. --force
 * re-measures speakers already in the ledger; --relabel skips fetching entirely
 * and rebuilds catalog.json from it, which is how band thresholds get retuned
 * without re-downloading 37 GB. --report prints the measured distributions.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'voice-samples');
const CATALOG_PATH = path.join(OUT_DIR, 'catalog.json');
const WORK_DIR = path.join(os.tmpdir(), 'scriptreader-voice-catalog');

const RESOURCE_BASE = 'https://www.openslr.org/resources/141';
const DOC_URL = `${RESOURCE_BASE}/doc.tar.gz`;

// "clean" is the corpus's own quality split. train-other-500 is excluded on
// purpose: it is the subset LibriTTS grades as harder/noisier audio, and a
// noisy reference is the one input that most degrades a voice clone.
//
// The full archives are fetched even though only ~10 seconds per speaker is
// kept. Hugging Face's dataset viewer can serve individual utterances by
// speaker and would have been far cheaper, but it only indexes a prefix of the
// large splits (`partial: true`), so a filter by speaker returns zero rows for
// most of train-clean-360 — enough for a demo, not for a catalog.
const SUBSETS = {
  'dev-clean': 'dev_clean',
  'test-clean': 'test_clean',
  'train-clean-100': 'train_clean_100',
  'train-clean-360': 'train_clean_360'
};

const CLIP_SECONDS = 10;
const TARGET_SOURCE_SECONDS = 13;
const MAX_UTTERANCES = 6;
const CONCURRENCY = 6;

// Thresholds calibrated against the measured distribution of the clean subsets
// (see --report). They reject the tail where restoration left artefacts or the
// reader is too far off-mic, not merely the quietest voices.
const MIN_VOICED_RATIO = 0.25;
const MAX_CLIP_RATIO = 0.005;
const MIN_SNR_DB = 22;
const MIN_CLIP_SECONDS = 7;

function parseArgs(argv) {
  const args = { limit: Infinity, subsets: Object.keys(SUBSETS), force: false, report: false, relabel: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--subsets') args.subsets = argv[++i].split(',');
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--report') args.report = true;
    else if (argv[i] === '--relabel') args.relabel = true;
  }
  return args;
}

/**
 * Measurements are expensive (a download and two ffmpeg passes per speaker);
 * the band labels derived from them are not. Keeping them in a sidecar means a
 * threshold can be retuned with --relabel instead of refetching the corpus.
 */
const LEDGER_PATH = () => path.join(WORK_DIR, 'measurements.jsonl');

async function readLedger() {
  const byReader = new Map();
  try {
    const text = await fs.readFile(LEDGER_PATH(), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      byReader.set(record.reader, record);
    }
  } catch { /* first run */ }
  return byReader;
}

async function appendLedger(record) {
  await fs.appendFile(LEDGER_PATH(), `${JSON.stringify(record)}\n`);
}

async function fetchWithRetry(url, { attempts = 5, init, timeoutMs = 60_000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      // A hung connection is the failure mode that silently stalls the whole
      // run, so every request that is not an open-ended archive stream carries
      // a deadline.
      const res = await fetch(url, {
        ...init,
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
      });
      // openslr.org sheds load under concurrent range requests; these statuses
      // clear on their own, so they are worth waiting out rather than failing.
      if (res.status === 500 || res.status === 429 || res.status === 503) {
        throw new Error(`retryable ${res.status}`);
      }
      if (!res.ok) throw Object.assign(new Error(`http ${res.status}`), { fatal: true });
      return res;
    } catch (error) {
      lastError = error;
      if (error.fatal) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1) ** 2));
    }
  }
  throw lastError;
}

/** Corpus speaker table: reader id, gender, subset, and LibriVox reader name. */
async function loadSpeakers() {
  const cached = path.join(WORK_DIR, 'speakers.tsv');
  let tsv;
  try {
    tsv = await fs.readFile(cached, 'utf8');
  } catch {
    const res = await fetchWithRetry(DOC_URL);
    const gz = Buffer.from(await res.arrayBuffer());
    const tar = zlib.gunzipSync(gz);
    tsv = extractFromTar(tar, 'speakers.tsv');
    await fs.mkdir(WORK_DIR, { recursive: true });
    await fs.writeFile(cached, tsv);
  }
  return tsv.split('\n').slice(1)
    .map(line => line.split('\t').map(cell => cell.trim()))
    .filter(cells => cells.length >= 4)
    .map(([reader, gender, subset, name]) => ({ reader, gender, subset, name }));
}

function extractFromTar(tar, suffix) {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const name = tar.toString('utf8', offset, offset + 100).replace(/\0.*$/, '');
    const size = parseInt(tar.toString('utf8', offset + 124, offset + 136).replace(/\0.*$/, '').trim() || '0', 8);
    if (!name) break;
    const start = offset + 512;
    if (name.endsWith(suffix)) return tar.toString('utf8', start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${suffix} not found in archive`);
}

/**
 * Fetches one file as N concurrent byte ranges, then joins them.
 *
 * Downloaded to disk rather than piped straight into the parser because a gzip
 * stream cannot resume mid-file: one dropped socket 20 GB into train-clean-360
 * would mean starting over, and the socket does drop. Segmenting is also worth
 * it on its own — openslr.org throttles per connection, so four ranges measured
 * ~41 MB/s against ~13 MB/s for one.
 *
 * Each segment appends to its own part file, so an interrupted run resumes from
 * whatever every part already holds instead of refetching the archive.
 */
/**
 * Appends one byte range to its part file, resuming from whatever the file
 * already holds.
 *
 * Retrying is done here rather than with `curl --retry` for a reason that cost
 * a 29 GB download: curl restarts the whole range on retry, and with output
 * appended to a file that silently writes the same bytes twice. The archive
 * then passes every per-request check and fails only on total size. Recomputing
 * the offset from the file itself before each attempt makes a retry resume
 * instead of duplicate, and the truncate below is the belt to that braces.
 */
async function downloadSegment(url, part, attempts = 20) {
  const length = part.end - part.start + 1;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let have = await fs.stat(part.file).then(stat => stat.size, () => 0);
    if (have > length) {
      await fs.truncate(part.file, length);
      have = length;
    }
    if (have === length) return;

    try {
      await run('sh', ['-c', [
        'curl --fail --location --silent --show-error --no-buffer',
        `--range ${part.start + have}-${part.end}`,
        `'${url}' >> '${part.file}'`
      ].join(' ')], { maxBuffer: 1 << 20 });
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 2000 * (attempt + 1))));
  }

  const have = await fs.stat(part.file).then(stat => stat.size, () => 0);
  if (have === length) return;
  throw new Error(`segment ${part.start}-${part.end} incomplete: ${have}/${length} (${lastError?.message || 'short read'})`);
}

async function downloadInSegments(url, dest, segments = 4) {
  const head = await fetchWithRetry(url, { init: { method: 'HEAD' } });
  const total = Number(head.headers.get('content-length'));
  if (!Number.isFinite(total) || total <= 0) throw new Error(`no content-length for ${url}`);

  const size = Math.ceil(total / segments);
  const parts = Array.from({ length: segments }, (_, index) => ({
    file: `${dest}.part${index}`,
    start: index * size,
    end: Math.min(total, (index + 1) * size) - 1
  }));

  await Promise.all(parts.map(part => downloadSegment(url, part)));

  await run('sh', ['-c', `cat ${parts.map(part => `'${part.file}'`).join(' ')} > '${dest}'`]);
  await Promise.all(parts.map(part => fs.unlink(part.file).catch(() => {})));

  const written = (await fs.stat(dest)).size;
  if (written !== total) throw new Error(`${dest}: got ${written} bytes, expected ${total}`);
}

/** Yields {name, data} for every file in a tar byte stream, in archive order. */
async function* tarEntries(stream) {
  let buffer = Buffer.alloc(0);
  let pending = null;

  for await (const chunk of stream) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

    for (;;) {
      if (pending) {
        const padded = Math.ceil(pending.size / 512) * 512;
        if (buffer.length < padded) break;
        yield { name: pending.name, data: buffer.subarray(0, pending.size) };
        buffer = buffer.subarray(padded);
        pending = null;
        continue;
      }
      if (buffer.length < 512) break;
      const header = buffer.subarray(0, 512);
      const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
      if (!name) { buffer = buffer.subarray(512); continue; }
      const size = parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
      const type = String.fromCharCode(header[156]);
      buffer = buffer.subarray(512);
      // '0'/'\0' are regular files; directories and metadata entries carry no
      // payload worth reading here.
      if (type === '0' || type === '\0') pending = { name, size };
      else if (size) buffer = buffer.subarray(Math.ceil(size / 512) * 512);
    }
  }
}

/** LibriTTS-R ships 24 kHz 16-bit mono PCM, so length is a header read. */
function wavSeconds(data) {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF') return 0;
  let offset = 12;
  let sampleRate = 24000;
  let bytesPerFrame = 2;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      const channels = data.readUInt16LE(offset + 10);
      sampleRate = data.readUInt32LE(offset + 12);
      bytesPerFrame = channels * (data.readUInt16LE(offset + 22) / 8);
    } else if (id === 'data') {
      return size / (sampleRate * (bytesPerFrame || 2));
    }
    offset += 8 + size + (size % 2);
  }
  return 0;
}

/**
 * Streams one subset archive and keeps a short run of utterances per speaker.
 *
 * Selection has to commit as the bytes arrive — there is no second pass over a
 * 27 GB stream — so it takes the first chapter that yields enough usable audio.
 * Staying inside one chapter means one recording session, so the rendered clip
 * never splices two different mic setups into a voice that never existed.
 */
async function extractSubset(subset, wantedReaders, { onSpeaker }) {
  const marker = path.join(WORK_DIR, `${subset}.done`);
  try {
    await fs.access(marker);
    console.log(`  ${subset}: already extracted`);
    return;
  } catch { /* not extracted yet */ }

  const url = `${RESOURCE_BASE}/${SUBSETS[subset]}.tar.gz`;
  const archive = path.join(WORK_DIR, `${SUBSETS[subset]}.tar.gz`);
  console.log(`  ${subset}: downloading ${url}`);
  await downloadInSegments(url, archive);

  const { createReadStream } = await import('node:fs');
  const body = createReadStream(archive).pipe(zlib.createGunzip());

  const state = new Map();
  const texts = new Map();
  let bytes = 0;
  let lastLog = 0;

  for await (const entry of tarEntries(body)) {
    bytes += entry.data.length;
    if (bytes - lastLog > 2_000_000_000) {
      lastLog = bytes;
      console.log(`    ${subset}: ${(bytes / 1e9).toFixed(1)} GB read · ${state.size} speakers seen`);
    }

    // Transcripts and wavs are interleaved in no particular order inside a
    // chapter, so pairing cannot be done as the bytes arrive. Word counts are
    // banked for every wanted reader and reconciled against the chosen
    // utterances once the archive ends — that is what makes the pace figure a
    // measured rate rather than a guess.
    const textMatch = /\/(\d+)\/\d+\/([^/]+)\.normalized\.txt$/.exec(entry.name);
    if (textMatch && wantedReaders.has(textMatch[1])) {
      texts.set(textMatch[2], entry.data.toString('utf8').split(/\s+/).filter(Boolean).length);
      continue;
    }

    const match = /\/(\d+)\/(\d+)\/([^/]+)\.wav$/.exec(entry.name);
    if (!match) continue;
    const [, reader, chapter, utterance] = match;
    if (!wantedReaders.has(reader)) continue;

    let speaker = state.get(reader);
    if (!speaker) {
      speaker = { chapter: null, seconds: 0, count: 0, utterances: [], done: false };
      state.set(reader, speaker);
    }
    if (speaker.done) continue;

    const seconds = wavSeconds(entry.data);
    if (seconds < 3.5 || seconds > 12) continue;
    if (speaker.chapter && speaker.chapter !== chapter) continue;
    speaker.chapter ??= chapter;

    const dir = path.join(WORK_DIR, 'clips', reader);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${speaker.count}.wav`), entry.data);
    speaker.count++;
    speaker.seconds += seconds;
    speaker.utterances.push(utterance);
    if (speaker.seconds >= TARGET_SOURCE_SECONDS || speaker.count >= MAX_UTTERANCES) {
      speaker.done = true;
      await onSpeaker?.(reader);
    }
  }

  // Speakers whose chapter ran out before the target still get a clip built
  // from what was found; the quality gates decide whether it is shippable.
  for (const [reader, speaker] of state) {
    if (!speaker.count) continue;
    const words = speaker.utterances.reduce((sum, id) => sum + (texts.get(id) || 0), 0);
    await fs.writeFile(
      path.join(WORK_DIR, 'clips', reader, 'meta.json'),
      JSON.stringify({ words })
    );
  }

  await fs.writeFile(marker, `${state.size}\n`);
  await fs.unlink(archive).catch(() => {});
  console.log(`  ${subset}: extracted ${state.size} speakers`);
}

async function ffprobeDuration(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file
  ]);
  return Number(stdout.trim());
}

async function renderClip(wavFiles, dest) {
  const listFile = `${dest}.concat.txt`;
  await fs.writeFile(listFile, wavFiles.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    await run('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-af', [
        // Head and tail only. Internal pauses are the reader's phrasing and the
        // clone should hear them.
        'silenceremove=start_periods=1:start_silence=0.1:start_threshold=-45dB',
        'areverse',
        'silenceremove=start_periods=1:start_silence=0.1:start_threshold=-45dB',
        'areverse',
        'loudnorm=I=-18:TP=-2:LRA=11',
        // Single-pass loudnorm treats its TP target as a hint, and lame can
        // overshoot on top of that — measured peaks came back above 0 dBFS.
        // A clipped reference is the one artefact a voice clone reproduces
        // faithfully, so the ceiling is enforced rather than requested.
        'alimiter=limit=0.891:attack=5:release=50:level=disabled'
      ].join(','),
      '-t', String(CLIP_SECONDS),
      '-ac', '1', '-ar', '24000', '-q:a', '6', '-codec:a', 'libmp3lame',
      dest
    ]);
  } finally {
    await fs.unlink(listFile).catch(() => {});
  }
}

async function decodePcm(file) {
  const { stdout } = await run('ffmpeg', [
    '-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'
  ], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const samples = new Float32Array(stdout.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = stdout.readInt16LE(i * 2) / 32768;
  return samples;
}

/**
 * Pitch, voicing and noise floor measured off the finished clip via normalized
 * autocorrelation. These are measurements of the recording, and are labelled as
 * such in the catalog — they are never presented as facts about the person.
 */
function analyze(samples, sampleRate = 16000) {
  const frame = Math.round(sampleRate * 0.04);
  const hop = Math.round(sampleRate * 0.02);
  const minLag = Math.floor(sampleRate / 400);
  const maxLag = Math.floor(sampleRate / 60);
  const pitches = [];
  const energies = [];
  let frames = 0;
  let clipped = 0;

  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > 0.985) clipped++;

  for (let start = 0; start + frame + maxLag < samples.length; start += hop) {
    frames++;
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += samples[start + i] ** 2;
    energy /= frame;
    energies.push(energy);
    if (energy < 1e-5) continue;

    let bestLag = 0;
    let bestScore = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      let norm = 0;
      for (let i = 0; i < frame; i++) {
        corr += samples[start + i] * samples[start + i + lag];
        norm += samples[start + i + lag] ** 2;
      }
      const score = corr / (Math.sqrt(energy * frame * norm) + 1e-9);
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }
    if (bestScore > 0.45 && bestLag > 0) pitches.push(sampleRate / bestLag);
  }

  energies.sort((a, b) => a - b);
  const floor = energies[Math.floor(energies.length * 0.05)] || 1e-9;
  const speech = energies[Math.floor(energies.length * 0.85)] || 1e-9;
  pitches.sort((a, b) => a - b);

  return {
    medianPitch: pitches.length ? pitches[Math.floor(pitches.length / 2)] : null,
    voicedRatio: frames ? pitches.length / frames : 0,
    clipRatio: samples.length ? clipped / samples.length : 0,
    snrDb: 10 * Math.log10(speech / floor)
  };
}

/**
 * Vocal register, stated as the measured band it falls in.
 *
 * The cut points are physical rather than fitted to the corpus: below 100 Hz is
 * a genuine bass speaking voice, 100-135 the typical male range, and so on up.
 * Across 1,150 voices that leaves `deep` holding only 27 — widening it to 110 Hz
 * would nearly quadruple that, but "deep" would stop meaning deep.
 */
function registerFor(hz) {
  if (hz == null) return 'unmeasured';
  if (hz < 100) return 'deep';
  if (hz < 135) return 'low';
  if (hz < 175) return 'mid';
  if (hz < 215) return 'bright';
  return 'high';
}

/**
 * Pace has no physical anchor to borrow, so the bands come from the corpus's own
 * distribution: p25 and p75 land at 164 and 199 wpm. Note these are articulation
 * rates — LibriTTS utterances are silence-trimmed, so they run faster than the
 * same reader's book-average pace.
 */
function paceFor(wpm) {
  if (wpm < 165) return 'measured';
  if (wpm < 200) return 'steady';
  return 'brisk';
}

async function buildSpeaker(speaker) {
  const clipPath = path.join(OUT_DIR, `${speaker.reader}.mp3`);
  const scratch = path.join(WORK_DIR, 'clips', speaker.reader);

  const files = (await fs.readdir(scratch).catch(() => []))
    .filter(file => file.endsWith('.wav'))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    .map(file => path.join(scratch, file));
  if (!files.length) throw new Error('no extracted audio');

  let sourceSeconds = 0;
  for (const file of files) sourceSeconds += await ffprobeDuration(file);

  const meta = JSON.parse(await fs.readFile(path.join(scratch, 'meta.json'), 'utf8').catch(() => '{}'));
  await renderClip(files, clipPath);
  const seconds = await ffprobeDuration(clipPath);
  const metrics = analyze(await decodePcm(clipPath));
  const wpm = sourceSeconds > 0 ? ((meta.words || 0) / sourceSeconds) * 60 : 0;
  const bytes = (await fs.stat(clipPath)).size;

  return {
    reader: speaker.reader,
    name: speaker.name,
    gender: speaker.gender,
    subset: speaker.subset,
    pitchHz: metrics.medianPitch ? Math.round(metrics.medianPitch) : null,
    wordsPerMinute: Math.round(wpm),
    seconds: Number(seconds.toFixed(2)),
    bytes,
    snrDb: Number(metrics.snrDb.toFixed(1)),
    voicedRatio: Number(metrics.voicedRatio.toFixed(3)),
    clipRatio: Number(metrics.clipRatio.toFixed(5))
  };
}

/** Why a measured speaker is not shippable, or '' when it is. */
function rejectionFor(record) {
  if (record.error) return record.error;
  if (record.seconds < MIN_CLIP_SECONDS) return `short clip ${record.seconds}s`;
  if (record.voicedRatio < MIN_VOICED_RATIO) return `voiced ${record.voicedRatio}`;
  if (record.clipRatio > MAX_CLIP_RATIO) return `clipping ${record.clipRatio}`;
  if (record.snrDb < MIN_SNR_DB) return `snr ${record.snrDb}dB`;
  return '';
}

function entryFor(record) {
  return {
    id: `libritts-r-${record.reader}`,
    // One clean-subset speaker has no name in the corpus table. Fall back to the
    // reader id rather than a generic placeholder, so the card still identifies
    // which recording it is.
    name: record.name?.trim() || `Reader ${record.reader}`,
    gender: record.gender === 'F' ? 'Female' : record.gender === 'M' ? 'Male' : 'Neutral',
    register: registerFor(record.pitchHz),
    pitchHz: record.pitchHz,
    pace: paceFor(record.wordsPerMinute),
    wordsPerMinute: record.wordsPerMinute,
    seconds: record.seconds,
    bytes: record.bytes,
    snrDb: record.snrDb,
    subset: record.subset,
    clip: `${record.reader}.mp3`
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(WORK_DIR, { recursive: true });

  const all = await loadSpeakers();
  const wanted = all.filter(speaker => args.subsets.includes(speaker.subset)).slice(0, args.limit);
  const ledger = await readLedger();
  console.log(`${wanted.length} speakers in ${args.subsets.join(', ')} · ${ledger.size} already measured`);

  if (!args.relabel) {
    const bySubset = new Map();
    for (const speaker of wanted) {
      if (!bySubset.has(speaker.subset)) bySubset.set(speaker.subset, new Set());
      bySubset.get(speaker.subset).add(speaker.reader);
    }
    console.log('extracting reference audio:');
    for (const [subset, readers] of bySubset) {
      await extractSubset(subset, readers, {});
    }
  }

  let done = 0;
  const pending = args.relabel ? [] : wanted.filter(speaker => {
    return args.force || !ledger.has(speaker.reader);
  });

  await mapWithConcurrency(pending, CONCURRENCY, async speaker => {
    let record;
    try {
      record = await buildSpeaker(speaker);
    } catch (error) {
      record = {
        reader: speaker.reader,
        name: speaker.name,
        gender: speaker.gender,
        subset: speaker.subset,
        error: error.message
      };
      await fs.unlink(path.join(OUT_DIR, `${speaker.reader}.mp3`)).catch(() => {});
    }
    ledger.set(speaker.reader, record);
    await appendLedger(record);
    done++;
    if (done % 25 === 0) console.log(`  measured ${done}/${pending.length}`);
  });

  const kept = [];
  const rejected = [];
  for (const speaker of wanted) {
    const record = ledger.get(speaker.reader);
    if (!record) continue;
    const rejection = rejectionFor(record);
    if (rejection) {
      rejected.push({ reader: record.reader, reason: rejection });
      await fs.unlink(path.join(OUT_DIR, `${record.reader}.mp3`)).catch(() => {});
    } else {
      kept.push(entryFor(record));
    }
  }

  kept.sort((a, b) => a.name.localeCompare(b.name));
  const totalBytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);

  // A clip left behind by an earlier run — a speaker since rejected, or one
  // built while narrowing --subsets — would ship as an asset nothing in the
  // catalog references. Only files the catalog names survive.
  const shipped = new Set(kept.map(entry => entry.clip));
  const orphans = (await fs.readdir(OUT_DIR))
    .filter(file => file.endsWith('.mp3') && !shipped.has(file));
  for (const file of orphans) await fs.unlink(path.join(OUT_DIR, file));
  if (orphans.length) console.log(`removed ${orphans.length} orphaned clips`);
  const failed = rejected.filter(item => !/^(short clip|voiced|clipping|snr)/.test(item.reason));

  if (args.report) {
    const bands = key => kept.reduce((counts, entry) => {
      counts[entry[key]] = (counts[entry[key]] || 0) + 1;
      return counts;
    }, {});
    console.log('\nregister:', bands('register'));
    console.log('pace:', bands('pace'));
    console.log('gender:', bands('gender'));
    const wpms = kept.map(entry => entry.wordsPerMinute).sort((a, b) => a - b);
    const pitches = kept.map(entry => entry.pitchHz).filter(Boolean).sort((a, b) => a - b);
    const at = (arr, q) => arr[Math.floor(arr.length * q)];
    console.log(`wpm p10/p50/p90: ${at(wpms, 0.1)}/${at(wpms, 0.5)}/${at(wpms, 0.9)}`);
    console.log(`pitch p10/p50/p90: ${at(pitches, 0.1)}/${at(pitches, 0.5)}/${at(pitches, 0.9)}`);
    console.log('rejected sample:', JSON.stringify(rejected.slice(0, 25)));
  }

  await fs.writeFile(CATALOG_PATH, `${JSON.stringify({
    source: 'LibriTTS-R',
    sourceUrl: 'https://www.openslr.org/141/',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'LibriTTS-R corpus, Google LLC, derived from LibriVox public-domain audiobooks.',
    clipSeconds: CLIP_SECONDS,
    voices: kept
  }, null, 0)}\n`);

  console.log(`\nkept ${kept.length} · rejected ${rejected.length} · failed ${failed.length}`);
  console.log(`clips ${(totalBytes / 1e6).toFixed(1)} MB · catalog ${((await fs.stat(CATALOG_PATH)).size / 1e3).toFixed(0)} KB`);
}

await main();
