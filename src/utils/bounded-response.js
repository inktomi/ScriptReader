import { createAbortError, throwIfAborted } from './latest-operation.js';

function declaredContentLength(response) {
  const raw = response?.headers?.get?.('content-length');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null;
  const size = Number(raw);
  return Number.isSafeInteger(size) ? size : null;
}

async function cancelBody(body, reason) {
  try {
    await body?.cancel?.(reason);
  } catch (_) {
    // Preserve the read/limit/abort error that caused cleanup.
  }
}

/**
 * Reads a response incrementally and refuses to retain more than maxBytes.
 * Content-Length is an early rejection only; every received chunk is counted.
 */
export async function readBoundedResponseBlob(
  response,
  {
    maxBytes,
    signal,
    contentType = response?.headers?.get?.('content-type') || '',
    tooLargeError = () => new Error('The response is too large.'),
    unsafeFallbackError = () => new Error('This browser cannot safely read the response.'),
  } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer.');
  }

  const body = response?.body;
  if (signal?.aborted) {
    await cancelBody(body, signal.reason || createAbortError());
    throwIfAborted(signal);
  }
  const declared = declaredContentLength(response);

  if (!body?.getReader) {
    await cancelBody(
      body,
      declared !== null && declared > maxBytes
        ? 'Response exceeded the configured byte limit.'
        : 'Response could not be read safely.',
    );
    if (declared !== null && declared > maxBytes) throw tooLargeError();
    // Without a reader there is no way to enforce the bound before blob()
    // buffers the response. A declared size is useful for early rejection, but
    // it is not trustworthy enough to make an unbounded fallback safe.
    throw unsafeFallbackError();
  }

  const reader = body.getReader();
  let finished = false;
  let cancelPromise = null;
  let abortListener = null;
  const cancelReader = async (reason) => {
    if (finished) return;
    if (!cancelPromise) cancelPromise = cancelBody(reader, reason);
    await cancelPromise;
  };

  if (signal) {
    abortListener = () => {
      void cancelReader(signal.reason || createAbortError());
    };
    signal.addEventListener('abort', abortListener, { once: true });
  }

  try {
    throwIfAborted(signal);
    if (declared !== null && declared > maxBytes) {
      await cancelReader('Response exceeded the configured byte limit.');
      throw tooLargeError();
    }

    const chunks = [];
    let received = 0;
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) {
        finished = true;
        break;
      }
      if (!value?.byteLength) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await cancelReader('Response exceeded the configured byte limit.');
        throw tooLargeError();
      }
      chunks.push(value);
    }
    return new Blob(chunks, { type: contentType });
  } catch (error) {
    await cancelReader(error);
    if (signal?.aborted && error?.name !== 'AbortError') throw createAbortError();
    throw error;
  } finally {
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    reader.releaseLock?.();
  }
}

/**
 * JSON variant of the same streaming boundary. Parsing happens only after the
 * complete body has been proven to fit inside `maxBytes`.
 */
export async function readBoundedResponseJson(response, options = {}) {
  const blob = await readBoundedResponseBlob(response, {
    ...options,
    contentType: response?.headers?.get?.('content-type') || 'application/json',
  });
  let text;
  try {
    text = await blob.text();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('The server returned invalid JSON.');
    }
    throw error;
  }
}
