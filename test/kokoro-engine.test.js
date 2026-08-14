import assert from 'node:assert/strict';
import test from 'node:test';

import { KokoroNeuralEngine } from '../src/audio/kokoro-engine.js';
import { expectedBytesForKokoroFile, KokoroDownloadProgress } from '../src/audio/kokoro-model-files.js';

// What `kokoro-worker.js` actually asks for: fp16 on WebGPU, q8 on WASM — which
// transformers.js spells `_quantized`.
const FP16 = 'onnx/model_fp16.onnx';
const FP16_BYTES = 163_234_740;
const Q8 = 'onnx/model_quantized.onnx';

/** Drive the engine's progress path without booting a worker. */
function record(engine, events) {
  const seen = [];
  engine.onProgress(({ progress, message }) => seen.push({ progress, message }));
  for (const event of events) engine._noteDownloadProgress(event);
  engine._clearStallWatchdog();
  return seen;
}

test('the published size is known for every dtype the repo ships', () => {
  assert.equal(expectedBytesForKokoroFile(FP16), FP16_BYTES);
  assert.ok(expectedBytesForKokoroFile(Q8) > 1024 * 1024);
  // A caller holding a full URL should not have to take it apart first.
  assert.equal(
    expectedBytesForKokoroFile(`https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/${FP16}`),
    FP16_BYTES,
  );
  assert.equal(expectedBytesForKokoroFile('onnx/model_not_published.onnx'), 0);
  assert.equal(expectedBytesForKokoroFile(undefined), 0);
});

/**
 * The bug. Hugging Face serves LFS weights chunked with no Content-Length, and
 * transformers.js's `readResponse` grows `total` to match `loaded` on every
 * chunk — so every event claims `loaded === total` and `progress === 100`.
 * Believed, that pins the bar at its ceiling on the first megabyte.
 */
test('progress advances when every event claims loaded === total', () => {
  const engine = new KokoroNeuralEngine();
  const seen = record(
    engine,
    [20_000_000, 60_000_000, 120_000_000, FP16_BYTES].map((loaded) => ({
      file: FP16,
      loaded,
      total: loaded,
      progress: 100,
    })),
  );

  assert.ok(seen.length >= 4, `expected an update per event, saw ${seen.length}`);
  const values = seen.map((entry) => entry.progress);
  assert.ok(
    values.every((value, i) => i === 0 || value >= values[i - 1]),
    'progress went backwards',
  );
  assert.ok(values[0] < 40, `should start low in the band, got ${values[0]}`);
  assert.ok(values.at(-1) > values[0], 'progress never advanced');
  // 20 (floor) + 70 (band) = 90 is where the old code parked on chunk one.
  assert.ok(values.at(-1) >= 85, `should reach the top of the band, got ${values.at(-1)}`);
  assert.match(seen.at(-1).message, /100% — 155\.7 MB \/ 155\.7 MB/);
});

test('a trustworthy total is preferred over the published size', () => {
  const engine = new KokoroNeuralEngine();
  // A real Content-Length exceeds what has arrived from the very first chunk,
  // which is exactly what the grow-as-you-go fallback can never do.
  const seen = record(engine, [{ file: FP16, loaded: 4_000_000, total: 8_000_000, progress: 50 }]);

  // Half of a genuine 8 MB total lands mid-band; half of the 155 MB published
  // size would be a couple of points above the floor.
  assert.ok(seen[0].progress > 50, `expected the reported total to be used, got ${seen[0].progress}`);
  assert.match(seen[0].message, /3\.8 MB \/ 7\.6 MB/);
});

test('the metadata files are not enough to move the bar', () => {
  const engine = new KokoroNeuralEngine();
  const seen = record(engine, [
    { file: 'config.json', loaded: 44, total: 44, progress: 100 },
    { file: 'tokenizer.json', loaded: 3497, total: 3497, progress: 100 },
  ]);

  assert.ok(
    seen.every((entry) => entry.progress === 20),
    `expected the floor, got ${seen.map((e) => e.progress)}`,
  );
  assert.match(seen.at(-1).message, /Fetching model metadata/);
});

/**
 * A WebGPU failure retries on WASM, which swaps the 155 MB fp16 weights for the
 * 88 MB q8 ones. The denominator changes under the bar, and it must not rewind.
 */
test('the bar does not walk backwards when a WASM retry swaps the weights file', () => {
  const engine = new KokoroNeuralEngine();
  const seen = record(engine, [
    { file: FP16, loaded: 150_000_000, total: 150_000_000, progress: 100 },
    { file: Q8, loaded: 1_000_000, total: 1_000_000, progress: 100 },
  ]);

  const values = seen.map((entry) => entry.progress);
  assert.ok(
    values.every((value, i) => i === 0 || value >= values[i - 1]),
    `progress went backwards: ${values}`,
  );
});

test('a file with no trustworthy total and no published size is left out of the denominator', () => {
  const download = new KokoroDownloadProgress();
  download.note({ file: 'onnx/model_not_published.onnx', loaded: 5_000_000, total: 5_000_000 });
  // Counting a running byte count as its own denominator is what reads as 100%.
  assert.deepEqual(download.totals(), { loaded: 0, total: 0 });

  download.note({ file: FP16, loaded: 1_000_000, total: 1_000_000 });
  assert.deepEqual(download.totals(), { loaded: 1_000_000, total: FP16_BYTES });
});

test('a retry does not inherit byte totals from the attempt that failed', () => {
  const download = new KokoroDownloadProgress();
  download.note({ file: FP16, loaded: 90_000_000, total: 90_000_000 });
  download.reset();
  assert.deepEqual(download.totals(), { loaded: 0, total: 0 });
});

test('loaded is clamped so a stale published size cannot report over 100%', () => {
  const download = new KokoroDownloadProgress();
  download.note({ file: FP16, loaded: FP16_BYTES * 2, total: FP16_BYTES * 2 });
  const { loaded, total } = download.totals();
  assert.equal(loaded, total);
});
