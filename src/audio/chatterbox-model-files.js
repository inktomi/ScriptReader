/**
 * The Chatterbox model's file layout, in one place.
 *
 * Three callers need to agree on this and previously could not: the worker picks
 * the dtype set, the engine has to know which files an install consists of to
 * verify one, and the settings modal needs a download size for its quota
 * pre-check. The dtype config used to live only in the worker, so the engine's
 * install check could not know whether it was looking for `language_model_q4`
 * or `language_model_q4f16` — and reported "installed" either way.
 */

export const CHATTERBOX_MODEL_ID = 'onnx-community/chatterbox-ONNX';

// The OPFS directory the weights live in. Not Cache Storage: Chromium's
// `put()` refuses bodies of this size (see `kokoro-worker.js`), and all four
// of Chatterbox's external-data blobs are over that ceiling.
export const OPFS_NAMESPACE = 'chatterbox-onnx-weights';

/**
 * Per-session dtype, by device.
 *
 * Only `language_model` has quantised variants published; `embed_tokens`,
 * `speech_encoder` and `conditional_decoder` ship fp32 only, which is why this
 * install is ~1.4 GB and cannot be made meaningfully smaller.
 */
export const DTYPE_CONFIGS = {
  wasm: {
    embed_tokens: 'fp32',
    speech_encoder: 'fp32',
    language_model: 'q4',
    conditional_decoder: 'fp32',
  },
  webgpu: {
    embed_tokens: 'fp32',
    speech_encoder: 'fp32',
    language_model: 'q4f16',
    conditional_decoder: 'fp32',
  },
};

/**
 * Published sizes, read from the Hugging Face API for
 * `onnx-community/chatterbox-ONNX` at main on 2026-08-11.
 *
 * These are *advisory*. They stand in as a progress denominator when a response
 * arrives without a usable `Content-Length`, and they drive the "about N GB"
 * copy. They must never gate whether an install counts as complete: if the repo
 * is revised under us, a stale number here should make the progress bar
 * slightly wrong, never make a good install read as broken.
 */
const FILE_BYTES = {
  'onnx/embed_tokens.onnx': 13_286,
  'onnx/embed_tokens.onnx_data': 61_640_704,
  'onnx/speech_encoder.onnx': 1_184_608,
  'onnx/speech_encoder.onnx_data': 591_274_880,
  'onnx/conditional_decoder.onnx': 6_350_448,
  'onnx/conditional_decoder.onnx_data': 533_970_816,
  'onnx/language_model_q4.onnx': 227_911,
  'onnx/language_model_q4.onnx_data': 353_621_248,
  'onnx/language_model_q4f16.onnx': 229_388,
  'onnx/language_model_q4f16.onnx_data': 304_737_408,
};

export function modelFileUrl(path) {
  // Matches how transformers.js builds its own cache keys, so a file fetched by
  // the library and a file fetched by our prefetch land on the same entry.
  return `https://huggingface.co/${CHATTERBOX_MODEL_ID}/resolve/main/${path}`;
}

/**
 * Resolve the device the worker will actually use.
 *
 * Shared rather than duplicated: the modal has to report on an install before
 * any worker exists, and if the two probes ever disagreed the modal would check
 * the cache for one dtype set while the worker downloaded the other.
 */
export async function pickChatterboxDevice(preferred = 'auto') {
  if (preferred === 'wasm') return 'wasm';
  if (typeof navigator === 'undefined' || !navigator.gpu) return 'wasm';
  try {
    return (await navigator.gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch (_) {
    return 'wasm';
  }
}

/**
 * Every file one device's install consists of.
 *
 * transformers.js names a session file `<name>.onnx` for fp32 and
 * `<name>_<dtype>.onnx` otherwise, and pairs each with an `.onnx_data`
 * sidecar when the weights are stored externally.
 *
 * The sidecar is only listed when this module knows about it. An unknown
 * sidecar is one we cannot prove exists, and demanding a file the repo does
 * not publish would leave every install permanently "partial".
 */
export function expectedFilesFor(device) {
  const dtypes = DTYPE_CONFIGS[device] || DTYPE_CONFIGS.wasm;

  return Object.entries(dtypes).flatMap(([session, dtype]) => {
    const stem = dtype === 'fp32' ? session : `${session}_${dtype}`;
    const graph = `onnx/${stem}.onnx`;
    const weights = `onnx/${stem}.onnx_data`;

    const files = [describe(graph, false)];
    if (weights in FILE_BYTES) files.push(describe(weights, true));
    return files;
  });
}

function describe(path, isWeights) {
  return { path, url: modelFileUrl(path), bytes: FILE_BYTES[path] || 0, isWeights };
}

export function expectedTotalBytes(device) {
  return expectedFilesFor(device).reduce((sum, file) => sum + file.bytes, 0);
}

/**
 * Whether a file on disk can be treated as the whole file.
 *
 * Shared so the worker's "skip what I already have" and the engine's "is this
 * installed" can never disagree. The 2% tolerance absorbs a revised model
 * without demanding an exact byte match; a file we have no expected size for
 * only has to be non-empty, since a wrong guess must not invalidate a good
 * install.
 */
export function isCompleteSize(actual, expected) {
  if (typeof actual !== 'number' || actual <= 0) return false;
  if (!expected) return true;
  return actual >= expected * 0.98;
}

export function expectedBytesForUrl(url) {
  for (const path of Object.keys(FILE_BYTES)) {
    if (url.endsWith(path)) return FILE_BYTES[path];
  }
  return 0;
}

/**
 * The figure the storage pre-check and the download copy use.
 *
 * Deliberately the larger of the two dtype sets: the check runs before the
 * device is known, and refusing to start is far better than running out of
 * quota 1.3 GB in.
 */
export const CHATTERBOX_DOWNLOAD_BYTES = Math.max(expectedTotalBytes('wasm'), expectedTotalBytes('webgpu'));
