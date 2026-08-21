/**
 * Where exported bytes go.
 *
 * Two routes, same interface. With the File System Access API the encoder writes
 * straight to the file the listener picked, so a two-hour read never exists in
 * memory as one object. Without it the parts are held and assembled into a Blob
 * at the end - the only route Safari and Firefox have, and the reason the
 * exporter still cares about staying small per window.
 *
 * `patch` exists for WAV, whose header has to state a size nobody knows until
 * the last frame is written. A streaming sink seeks; a Blob sink swaps the part.
 */

// How long a blob URL is kept alive after the download is triggered.
const REVOKE_DELAY_MS = 60_000;

/** True when this browser can stream an export straight to disk. */
export function canStreamToDisk() {
  return typeof globalThis.showSaveFilePicker === 'function';
}

async function openStreamingSink({ filename, mimeType, extension }) {
  const handle = await globalThis.showSaveFilePicker({
    suggestedName: filename,
    types: [{ description: 'Audio', accept: { [mimeType]: [`.${extension}`] } }],
  });
  const stream = await handle.createWritable();
  let position = 0;
  let settled = false;

  return {
    streaming: true,
    async write(bytes) {
      await stream.write({ type: 'write', position, data: bytes });
      position += bytes.byteLength;
    },
    async patch(at, bytes) {
      await stream.write({ type: 'write', position: at, data: bytes });
    },
    async close() {
      if (settled) return null;
      settled = true;
      await stream.close();
      return null;
    },
    async abort() {
      if (settled) return;
      settled = true;
      try {
        // Leaves a zero-length file rather than a truncated one that looks
        // like a complete recording of a script it only got a third of the way
        // through.
        await stream.truncate(0);
      } catch (_err) {
        // Nothing to salvage; closing is still the important half.
      }
      try {
        await stream.close();
      } catch (_err) {
        // Already torn down by the failure that brought us here.
      }
    },
  };
}

function openBlobSink({ filename, mimeType, document: injected }) {
  const doc = injected || globalThis.document;
  let parts = [];
  let offsets = [];
  let length = 0;
  let settled = false;

  return {
    streaming: false,
    async write(bytes) {
      // Copy: the mixer reuses its planes, and a Blob part must not alias a
      // buffer that is about to be overwritten by the next window.
      parts.push(bytes.slice());
      offsets.push(length);
      length += bytes.byteLength;
    },
    async patch(at, bytes) {
      // Header corrections replace a placeholder of identical length written
      // earlier - a WAV size field, or an MP4 chunk header. Anything else would
      // mean re-cutting the parts, which no caller needs.
      const index = offsets.indexOf(at);
      if (index === -1 || parts[index].byteLength !== bytes.byteLength) {
        throw new Error('A buffered export can only correct a header it already wrote.');
      }
      parts[index] = bytes.slice();
    },
    async close() {
      if (settled) return null;
      settled = true;

      const blob = new Blob(parts, { type: mimeType });
      parts = [];
      offsets = [];
      const url = URL.createObjectURL(blob);
      try {
        const link = doc.createElement('a');
        link.href = url;
        link.download = filename;
        link.rel = 'noopener';
        doc.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        // WebKit and Gecko hand a synthetic link click to their download
        // manager asynchronously and read the blob several turns later, so
        // revoking on the next tick yields a failed or zero-byte download.
        // Hold the URL well past that, then release it.
        const revoke = setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
        // Browsers hand back a plain id; Node hands back a handle that would
        // otherwise keep a test runner alive for the full minute.
        revoke?.unref?.();
      }
      return blob;
    },
    async abort() {
      settled = true;
      parts = [];
      offsets = [];
    },
  };
}

/**
 * Open the best sink this browser offers.
 *
 * A listener who dismisses the save dialog has cancelled the export, not hit an
 * error, so the AbortError is passed through untouched for the caller to read
 * as a cancellation.
 */
export async function openExportSink({ filename, mimeType, extension, preferStreaming = true, document }) {
  if (preferStreaming && canStreamToDisk()) {
    return openStreamingSink({ filename, mimeType, extension });
  }
  return openBlobSink({ filename, mimeType, document });
}
