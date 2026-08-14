import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpfsModelCache } from '../src/audio/opfs-model-cache.js';
import { installFakeOpfs } from './fake-opfs.js';

const URL_UNDER_TEST =
  'https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/main/onnx/speech_encoder.onnx_data';
const KEY = encodeURIComponent(URL_UNDER_TEST);
const BODY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

/**
 * Serve `BODY` in two chunks, so a test can interrupt the stream between them.
 *
 * Two chunks rather than one because the failures worth covering here — an
 * aborted install, a dropped connection — all happen mid-body, and a
 * single-chunk response cannot express that.
 */
function stubFetch({ gate = null, failAfterFirstChunk = false } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(BODY.slice(0, 4));
        if (gate) await gate.opened;
        if (failAfterFirstChunk) {
          controller.error(new Error('The connection dropped.'));
          return;
        }
        controller.enqueue(BODY.slice(4));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-length': String(BODY.length) },
    });
  };
  return () => {
    globalThis.fetch = original;
  };
}

function openGate() {
  const gate = {};
  gate.opened = new Promise((resolve) => {
    gate.open = resolve;
  });
  return gate;
}

/**
 * The regression test.
 *
 * WebKit declares only `move(destination, newName)`, both arguments required,
 * and its binding layer throws `TypeError: Not enough arguments` for the
 * one-argument rename Chromium accepts. That threw on the first file of every
 * Safari install — the ONNX Runtime module, seconds in — and because the commit
 * path deletes its own partial file on failure, every retry repeated it exactly.
 */
test('a WebKit-shaped rename does not fail the download', async () => {
  const opfs = installFakeOpfs({ move: 'webkit' });
  const restoreFetch = stubFetch();
  try {
    const cache = await createOpfsModelCache('ns');
    const loaded = await cache.download(URL_UNDER_TEST);

    assert.equal(loaded, BODY.length);
    assert.equal(await cache.sizeOf(URL_UNDER_TEST), BODY.length);

    const response = await cache.match(URL_UNDER_TEST);
    assert.equal(response.headers.get('content-length'), String(BODY.length));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), BODY);

    assert.ok(!opfs.entries.has(`${KEY}.part`), 'the temporary file must not survive');
  } finally {
    restoreFetch();
    opfs.restore();
  }
});

test('the rename is always called with an explicit destination directory', async () => {
  const opfs = installFakeOpfs({ move: 'chromium' });
  const restoreFetch = stubFetch();
  try {
    const cache = await createOpfsModelCache('ns');
    await cache.download(URL_UNDER_TEST);

    assert.ok(opfs.moveCalls.length > 0, 'the rename path must actually run');
    for (const args of opfs.moveCalls) {
      // Pins the one spelling every engine with `move` accepts. A future edit
      // back to `move(name)` looks tidier and silently breaks Safari again.
      assert.equal(args.length, 2, 'move must be given a destination and a name');
      assert.equal(args[0].kind, 'directory');
      assert.equal(typeof args[1], 'string');
    }
  } finally {
    restoreFetch();
    opfs.restore();
  }
});

/**
 * The reason renaming is proven up front rather than attempted and caught.
 *
 * `download`'s body is a single-use stream, so a rename that fails *after* the
 * bytes have landed cannot be retried — recovering would mean re-fetching the
 * file, and for the speech encoder that is 591 MB. The probe answers the
 * question while it is still free.
 */
test('a rename that fails at runtime costs no download', async () => {
  const opfs = installFakeOpfs({ move: 'throws' });
  const restoreFetch = stubFetch();
  try {
    const cache = await createOpfsModelCache('ns');
    const loaded = await cache.download(URL_UNDER_TEST);

    assert.equal(loaded, BODY.length);
    assert.equal(await cache.sizeOf(URL_UNDER_TEST), BODY.length);
    assert.equal(opfs.moveCalls.length, 1, 'only the probe may attempt a rename');
  } finally {
    restoreFetch();
    opfs.restore();
  }
});

test('a completed download leaves nothing behind but the file itself', async () => {
  const opfs = installFakeOpfs({ move: 'chromium' });
  const restoreFetch = stubFetch();
  try {
    const cache = await createOpfsModelCache('ns');
    await cache.download(URL_UNDER_TEST);
    assert.deepEqual([...opfs.entries.keys()], [KEY]);
  } finally {
    restoreFetch();
    opfs.restore();
  }
});

test('an interrupted write is never served as a cache hit', async () => {
  const opfs = installFakeOpfs({ move: 'chromium' });
  const gate = openGate();
  const restoreFetch = stubFetch({ gate, failAfterFirstChunk: true });
  try {
    const cache = await createOpfsModelCache('ns');
    gate.open();
    await assert.rejects(() => cache.download(URL_UNDER_TEST));

    assert.equal(await cache.match(URL_UNDER_TEST), undefined);
    assert.equal(await cache.sizeOf(URL_UNDER_TEST), null);
    assert.ok(!opfs.entries.has(`${KEY}.part`));
  } finally {
    restoreFetch();
    opfs.restore();
  }
});

test('a browser without any rename writes in place and still cleans up', async () => {
  const opfs = installFakeOpfs({ move: 'none' });
  const restoreFetch = stubFetch();
  try {
    const cache = await createOpfsModelCache('ns');
    await cache.download(URL_UNDER_TEST);
    assert.equal(await cache.sizeOf(URL_UNDER_TEST), BODY.length);
    assert.deepEqual([...opfs.entries.keys()], [KEY]);
  } finally {
    restoreFetch();
    opfs.restore();
  }
});

/**
 * These messages reach a `role="alert"` verbatim, and the errors that land here
 * are written for browser implementers, not users. "Not enough arguments" on its
 * own is what the original bug report contained.
 */
test('a storage failure names the file and keeps the original error', async () => {
  const opfs = installFakeOpfs({ move: 'chromium' });
  const restoreFetch = stubFetch();
  try {
    const cache = await createOpfsModelCache('ns');
    const quota = new Error('The quota has been exceeded.');
    quota.name = 'QuotaExceededError';
    globalThis.FileSystemFileHandle.prototype.createWritable = () => {
      throw quota;
    };

    await assert.rejects(
      () => cache.download(URL_UNDER_TEST),
      (error) => {
        assert.match(error.message, /ran out of storage/);
        assert.match(error.message, /speech_encoder\.onnx_data/);
        assert.equal(error.cause, quota);
        return true;
      },
    );
  } finally {
    restoreFetch();
    opfs.restore();
  }
});

test('an unrecognised storage failure keeps its browser text but gains a subject', async () => {
  const opfs = installFakeOpfs({ move: 'chromium' });
  const restoreFetch = stubFetch();
  try {
    const cache = await createOpfsModelCache('ns');
    globalThis.FileSystemFileHandle.prototype.createWritable = () => {
      throw new TypeError('Not enough arguments');
    };

    await assert.rejects(
      () => cache.download(URL_UNDER_TEST),
      (error) => {
        assert.match(error.message, /could not save/);
        assert.match(error.message, /speech_encoder\.onnx_data/);
        assert.match(error.message, /Not enough arguments/);
        return true;
      },
    );
  } finally {
    restoreFetch();
    opfs.restore();
  }
});

test('a cancelled install is not reported as a storage fault', async () => {
  const opfs = installFakeOpfs({ move: 'chromium' });
  const gate = openGate();
  const restoreFetch = stubFetch({ gate });
  try {
    const cache = await createOpfsModelCache('ns');
    const controller = new AbortController();
    const pending = cache.download(URL_UNDER_TEST, { signal: controller.signal });
    controller.abort();
    gate.open();

    await assert.rejects(
      () => pending,
      (error) => {
        // The user's own Cancel. `abortInit` relies on this staying recognisable
        // so it does not present a deliberate stop back as a failure.
        assert.equal(error.name, 'AbortError');
        return true;
      },
    );
  } finally {
    restoreFetch();
    opfs.restore();
  }
});

/**
 * `navigator.storage.getDirectory` is Safari 15.2; `createWritable` is Safari 26.
 * Testing only the entry point hands four Safari versions a cache object whose
 * every write is `undefined is not a function`.
 */
test('OPFS is refused when the browser cannot write files', async () => {
  const opfs = installFakeOpfs({ writable: false });
  try {
    assert.equal(await createOpfsModelCache('ns'), null);
  } finally {
    opfs.restore();
  }
});
