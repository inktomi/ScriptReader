/**
 * Kokoro's published file sizes, and the byte counter that reads a download
 * through them.
 *
 * Hugging Face serves LFS objects chunked, with no `Content-Length`.
 * transformers.js reacts to a missing length by growing `total` to match
 * `loaded` on every chunk (`readResponse` in
 * `@huggingface/transformers/src/utils/hub.js`), so every progress event it
 * emits claims `loaded === total` and `progress === 100`. Taken at face value
 * that pins a bar at its ceiling on the first megabyte of a 155 MB download and
 * leaves it there for the remaining several minutes — the same failure Studio
 * Local had, from the same cause.
 *
 * The rule that separates the two cases is below: a `total` is believed only
 * once it has been observed to exceed what had already arrived, which a real
 * `Content-Length` does from the first chunk and the grow-as-you-go fallback
 * never does. Until then the published size stands in.
 */

// Files below this are the config and the tokenizer. They are a few kilobytes
// and arrive first, so counting them would drive the bar to 100% within a
// second and snap it back the moment the weights joined the total.
const SIGNIFICANT_BYTES = 1024 * 1024;

/**
 * Published sizes, read from the Hugging Face API for
 * `onnx-community/Kokoro-82M-v1.0-ONNX` at main on 2026-08-12.
 *
 * Every dtype variant the repo publishes is listed, not just the two
 * `kokoro-worker.js` currently asks for (`fp16` on WebGPU, `q8` — which
 * transformers.js spells `_quantized` — on WASM). A dtype change should make
 * the bar slightly optimistic at worst, never drop the weights file out of the
 * denominator entirely and leave the bar parked at its floor.
 *
 * These are *advisory*. They are a progress denominator and nothing else; no
 * decision about whether a download succeeded may be taken from them.
 */
const FILE_BYTES = {
  'onnx/model.onnx': 325_532_232,
  'onnx/model_fp16.onnx': 163_234_740,
  'onnx/model_q4.onnx': 305_215_966,
  'onnx/model_q4f16.onnx': 154_586_422,
  'onnx/model_q8f16.onnx': 86_033_585,
  'onnx/model_quantized.onnx': 92_361_116,
  'onnx/model_uint8.onnx': 177_464_632,
  'onnx/model_uint8f16.onnx': 114_209_226,
};

/**
 * The published size for a file transformers.js is reporting on, or 0.
 *
 * The library names the file relative to the repo (`onnx/model_fp16.onnx`);
 * the suffix match also accepts a full URL so a caller holding one does not
 * have to take it apart first.
 */
export function expectedBytesForKokoroFile(file) {
  if (typeof file !== 'string') return 0;
  if (file in FILE_BYTES) return FILE_BYTES[file];
  for (const path of Object.keys(FILE_BYTES)) {
    if (file.endsWith(path)) return FILE_BYTES[path];
  }
  return 0;
}

/**
 * Aggregate byte counts across the files one `from_pretrained` is fetching.
 *
 * Per file rather than a single newest-sample, because transformers.js restarts
 * `progress` at 0 for each one: reading the newest event directly makes the bar
 * bounce config.json -> tokenizer.json -> model.onnx.
 */
export class KokoroDownloadProgress {
  constructor() {
    // file -> { loaded, total, totalTrusted }
    this.files = new Map();
  }

  /** A retry must not inherit byte totals from the attempt that failed. */
  reset() {
    this.files.clear();
  }

  /** Fold one transformers.js `{ file, loaded, total }` event in. */
  note(payload) {
    const file = (payload && payload.file) || 'weights';
    const known = this.files.get(file) || { loaded: 0, total: 0, totalTrusted: false };
    const loaded = Number(payload && payload.loaded) || known.loaded;
    const total = Number(payload && payload.total) || known.total;

    // The only file that could be misread as untrustworthy is one that finishes
    // in a single chunk, and those are the sub-megabyte config files `totals()`
    // leaves out anyway.
    const totalTrusted = known.totalTrusted || (total > 0 && total > loaded);

    this.files.set(file, { loaded, total, totalTrusted });
  }

  /**
   * Bytes in and bytes expected, over the files large enough to matter.
   *
   * A file that is neither vouched for by its response nor known here is left
   * out entirely rather than counted against its own `loaded` — treating a
   * running byte count as its own denominator is precisely what pins a bar at
   * 100%.
   */
  totals() {
    let loaded = 0;
    let total = 0;

    for (const [file, entry] of this.files) {
      // A total the response actually vouched for wins: it describes the bytes
      // in flight right now, where the published size was recorded when this
      // module was written.
      const size = (entry.totalTrusted ? entry.total : 0) || expectedBytesForKokoroFile(file);
      if (size < SIGNIFICANT_BYTES) continue;
      loaded += Math.min(entry.loaded, size);
      total += size;
    }

    return { loaded, total };
  }
}
