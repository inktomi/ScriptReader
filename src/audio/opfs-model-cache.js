/**
 * An Origin Private File System cache for model weights.
 *
 * Two problems make Cache Storage unusable for Chatterbox, and this module
 * exists to solve both:
 *
 * 1. Size. Chromium's `caches.put()` refuses bodies well below the storage
 *    quota — measured on this project as succeeding at 200 MB and failing at
 *    256 MB (see `kokoro-worker.js`). Chatterbox's four external-data blobs are
 *    354-591 MB each, so *none* of them can be stored, and transformers.js only
 *    `console.warn`s when the write fails. OPFS has no per-file ceiling beyond
 *    the origin quota.
 *
 * 2. `Content-Length`. Hugging Face serves LFS objects chunked, without a
 *    readable length, and transformers.js's `readResponse` reacts to a missing
 *    length by reallocating and copying its whole accumulated buffer on every
 *    chunk — quadratic, and for a 591 MB file that is terabytes of memcpy and a
 *    transient heap twice the file size. Because `match()` here serves a file
 *    whose size is known exactly, it can supply a real `Content-Length`, and
 *    that growth loop never runs.
 *
 * The shape is transformers.js's `CacheInterface` (`match`/`put`, see
 * `src/utils/cache.js` in the package) plus `download`, which is how weights
 * actually arrive: streamed to disk rather than buffered in memory.
 */

// Two capabilities, shipped years apart, and both are needed. Reaching the OPFS
// root is Safari 15.2; `createWritable` — which every write below goes through —
// is Safari 26. Testing only the entry point handed four Safari versions a cache
// object whose first write was `undefined is not a function`, with no path back
// to the honest "this browser cannot store the model" copy the UI already has.
function opfsAvailable() {
  return typeof navigator !== 'undefined'
    && !!navigator.storage
    && typeof navigator.storage.getDirectory === 'function'
    && typeof FileSystemFileHandle !== 'undefined'
    && typeof FileSystemFileHandle.prototype.createWritable === 'function';
}

// A cheap negative before the probe below bothers writing anything.
//
// The *presence* of `move` proves nothing, and that is not hypothetical: WebKit
// has exposed `FileSystemHandle.prototype.move` since Safari 15.2 — inherited by
// `FileSystemFileHandle`, so a `typeof` test passes — while declaring only
// `move(destination, newName)` with both arguments required. The one-argument
// `move(newName)` rename Chromium also accepts does not exist there, and
// WebKit's binding layer throws a bare `TypeError: Not enough arguments` before
// any of its implementation runs. That killed the first file of every Safari
// install.
function mayRename() {
  return typeof FileSystemFileHandle !== 'undefined'
    && typeof FileSystemFileHandle.prototype.move === 'function';
}

/**
 * Give a storage failure a subject and an action.
 *
 * These messages reach the DOM verbatim, by way of the worker's `postError` and
 * the settings modal's alert banner, and what lands here is written for browser
 * implementers rather than users — "Not enough arguments", "undefined is not a
 * function". Naming the file and the operation is the difference between a dead
 * end and something a reader can act on. The original text is quoted inline and
 * kept as `cause` rather than replaced: a bug report that loses it costs a
 * diagnosis.
 */
function describeStorageFailure(name, error) {
  // A cancelled install is the user's own Cancel, not a storage fault, and
  // `abortInit` relies on it staying recognisable.
  if (error?.name === 'AbortError') return error;

  let label = name;
  try {
    label = decodeURIComponent(name).split('/').pop() || name;
  } catch (_) {
    // A name that will not decode is still better than no name at all.
  }

  const detail = error?.name ? `${error.name}: ${error.message}` : String(error?.message || error);
  const message = error?.name === 'QuotaExceededError'
    ? `This browser ran out of storage while saving ${label}. Free up space and try again.`
    : `This browser could not save ${label} to local storage (${detail}).`;

  const wrapped = new Error(message, { cause: error });
  wrapped.name = 'ModelStorageError';
  return wrapped;
}

function urlOf(request) {
  if (typeof request === 'string') return request;
  if (request instanceof URL) return request.href;
  return request?.url || String(request);
}

// The cache key is a full URL, which cannot be a filename. Percent-encoding
// escapes `/` and `:`, is reversible, and leaves these keys around 120
// characters — comfortably inside the 255-byte filename limit.
function fileNameFor(request) {
  return encodeURIComponent(urlOf(request));
}

/**
 * @returns {Promise<object|null>} null when OPFS is unavailable, so callers can
 *   fall back rather than handle a throw. Note that transformers.js's
 *   `getCache()` throws if `env.useCustomCache` is set while `env.customCache`
 *   is null, so the two must always be set together.
 */
export async function createOpfsModelCache(namespace) {
  if (!opfsAvailable()) return null;

  let dir;
  try {
    const root = await navigator.storage.getDirectory();
    dir = await root.getDirectoryHandle(namespace, { create: true });
  } catch (error) {
    console.warn('OPFS model cache unavailable:', error);
    return null;
  }

  // Memoised for the life of this cache object. Only the worker ever commits, so
  // in practice this runs at most once per install; the main-thread callers that
  // just read install status never reach it.
  let renameSupport = null;

  /**
   * Prove a rename works, on a throwaway pair of names.
   *
   * Deliberately not a try/catch around the real commit. `download`'s body is a
   * single-use stream, so a `move` that fails *after* the bytes have landed
   * cannot be retried — recovering would mean re-fetching the file, and for the
   * speech encoder that is 591 MB, repeated identically on every attempt. Two
   * empty files cost microseconds and answer the question while it is still
   * free, for every engine including ones whose accepted signatures nobody has
   * enumerated yet.
   *
   * A hard crash between create and remove can strand a zero-byte
   * `.rename-probe-*`. Nothing reads it — install status only ever looks up
   * expected names — and `clear()` removes the namespace recursively.
   */
  async function probeRename() {
    if (!mayRename()) return false;
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const from = `.rename-probe-${id}`;
    const to = `${from}.moved`;
    try {
      const handle = await dir.getFileHandle(from, { create: true });
      await handle.move(dir, to);
      return true;
    } catch (error) {
      console.warn('OPFS rename unavailable; model files will be written in place:', error);
      return false;
    } finally {
      await dir.removeEntry(from).catch(() => {});
      await dir.removeEntry(to).catch(() => {});
    }
  }

  function canRename() {
    if (!renameSupport) renameSupport = probeRename();
    return renameSupport;
  }

  /**
   * Write through a temporary name and only adopt the final one once the whole
   * body has landed. On the no-rename path the partial file is deleted instead,
   * which covers the realistic failures — an aborted fetch or an exhausted
   * quota — even though it cannot cover a hard crash mid-write.
   */
  async function commit(name, write) {
    const rename = await canRename();
    const target = rename ? `${name}.part` : name;
    const handle = await dir.getFileHandle(target, { create: true });

    try {
      await write(handle);
      // The destination directory is passed explicitly because that is the only
      // spelling every engine implementing `move` accepts — see `mayRename`.
      // `move(name)` reads more naturally and breaks Safari outright.
      if (rename) await handle.move(dir, name);
    } catch (error) {
      await dir.removeEntry(target).catch(() => {});
      throw describeStorageFailure(name, error);
    }
  }

  async function fileFor(request) {
    try {
      const handle = await dir.getFileHandle(fileNameFor(request));
      return await handle.getFile();
    } catch (_) {
      // Absent, or being written under its `.part` name — either way, not a
      // cache hit.
      return null;
    }
  }

  return {
    /** transformers.js `CacheInterface.match` */
    async match(request) {
      const file = await fileFor(request);
      if (!file) return undefined;

      // The header is the whole point of this class: `file.size` is exact by
      // construction, so `readResponse` preallocates instead of growing, and
      // the progress it reports is real. A Blob body also streams lazily rather
      // than materialising 591 MB on the JS heap just to be handed back.
      return new Response(file, {
        status: 200,
        headers: {
          'content-length': String(file.size),
          'content-type': 'application/octet-stream'
        }
      });
    },

    /**
     * transformers.js `CacheInterface.put`.
     *
     * Only the small files — configs, tokenizer, the `.onnx` graphs — reach
     * this: weights are fetched by `download` before the library is asked for
     * them. The library always calls the two-argument form in a browser (it has
     * already read the body into a Uint8Array by this point), so there is no
     * extra copy to avoid here.
     */
    async put(request, response) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      await commit(fileNameFor(request), async (handle) => {
        const writable = await handle.createWritable();
        try {
          await writable.write(bytes);
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => {});
          throw error;
        }
      });
    },

    /**
     * Stream a URL to disk, reporting bytes as they land.
     *
     * This is what replaces letting transformers.js fetch the weights. Memory
     * stays at one chunk however large the file is, progress is counted from
     * actual bytes rather than inferred from a header that is not there, and an
     * `AbortSignal` makes Cancel mean cancel.
     */
    async download(url, { expectedBytes = 0, onProgress, signal } = {}) {
      // no-referrer for the same reason as everywhere else in this codebase:
      // huggingface.co drops `Access-Control-Allow-Origin` when a request
      // carries a Referer from this host. See `public/_headers`.
      const response = await fetch(url, { referrerPolicy: 'no-referrer', signal });
      if (!response.ok) {
        throw new Error(`Could not download ${url.split('/').pop()} (HTTP ${response.status}).`);
      }

      const header = Number(response.headers.get('content-length')) || 0;
      const total = header || expectedBytes;
      let loaded = 0;

      const counter = new TransformStream({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          // Never report a total below what has already arrived, so a stale
          // expected size cannot produce a bar over 100%.
          if (onProgress) onProgress({ loaded, total: Math.max(total, loaded) });
          controller.enqueue(chunk);
        }
      });

      await commit(fileNameFor(url), async (handle) => {
        const writable = await handle.createWritable();
        // pipeTo closes the writable on success and aborts it on failure, so a
        // cancelled or failed download leaves nothing half-written behind.
        await response.body.pipeThrough(counter).pipeTo(writable, { signal });
      });

      return loaded;
    },

    /** Bytes on disk for one entry, or null when it is not there. */
    async sizeOf(request) {
      const file = await fileFor(request);
      return file ? file.size : null;
    },

    async remove(request) {
      await dir.removeEntry(fileNameFor(request)).catch(() => {});
    },

    async clear() {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(namespace, { recursive: true });
        return true;
      } catch (error) {
        console.warn('Could not clear OPFS model cache:', error);
        return false;
      }
    }
  };
}
