import assert from 'node:assert/strict';
import test from 'node:test';
import { canStreamToDisk, openExportSink } from '../src/audio/export-sink.js';
import { installDom, removeDom } from './dom-helpers.js';

/**
 * A document whose anchor records the download instead of following it.
 * jsdom treats a real `link.click()` as navigation and logs a hard error.
 */
function recordingDocument() {
  const clicks = [];
  return {
    clicks,
    body: { appendChild: () => {} },
    createElement: () => ({
      set href(value) {
        this._href = value;
      },
      get href() {
        return this._href;
      },
      click() {
        clicks.push({ href: this._href, download: this.download });
      },
      remove() {},
    }),
  };
}

function stubObjectUrls() {
  const created = [];
  const revoked = [];
  const savedCreate = URL.createObjectURL;
  const savedRevoke = URL.revokeObjectURL;

  URL.createObjectURL = (blob) => {
    created.push(blob);
    return `blob:test/${created.length}`;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);

  return {
    created,
    revoked,
    restore() {
      URL.createObjectURL = savedCreate;
      URL.revokeObjectURL = savedRevoke;
    },
  };
}

test('the streaming route is used only where the browser has the picker', () => {
  const saved = globalThis.showSaveFilePicker;
  delete globalThis.showSaveFilePicker;
  try {
    assert.equal(canStreamToDisk(), false);
    globalThis.showSaveFilePicker = () => {};
    assert.equal(canStreamToDisk(), true);
  } finally {
    if (saved) globalThis.showSaveFilePicker = saved;
    else delete globalThis.showSaveFilePicker;
  }
});

test('the blob URL outlives the download handoff before being revoked', async (t) => {
  const dom = installDom();
  const urls = stubObjectUrls();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  try {
    const sink = await openExportSink({
      filename: 'read.m4a',
      mimeType: 'audio/mp4',
      extension: 'm4a',
      preferStreaming: false,
      document: recordingDocument(),
    });

    await sink.write(Uint8Array.from([1, 2, 3]));
    await sink.close();

    assert.equal(urls.created.length, 1, 'no blob was handed to the browser');

    // WebKit and Gecko read the blob several turns after the synthetic click.
    // Revoking on the next tick is what produced empty downloads there.
    t.mock.timers.tick(1000);
    assert.deepEqual(urls.revoked, [], 'revoked while the download was still starting');

    t.mock.timers.tick(60_000);
    assert.deepEqual(urls.revoked, ['blob:test/1'], 'the URL was never released');
  } finally {
    t.mock.timers.reset();
    urls.restore();
    removeDom(dom);
  }
});

test('a buffered export corrects a header it already wrote', async () => {
  const dom = installDom();
  const urls = stubObjectUrls();
  try {
    const sink = await openExportSink({
      filename: 'read.wav',
      mimeType: 'audio/wav',
      extension: 'wav',
      preferStreaming: false,
      document: recordingDocument(),
    });

    await sink.write(Uint8Array.from([0, 0, 0, 0]));
    await sink.write(Uint8Array.from([9, 9]));
    // The MP4 route patches at the ftyp boundary, not only at zero.
    await sink.write(Uint8Array.from([7, 7, 7, 7]));

    await sink.patch(0, Uint8Array.from([1, 2, 3, 4]));
    await sink.patch(6, Uint8Array.from([5, 5, 5, 5]));

    await sink.close();
    const bytes = new Uint8Array(await urls.created[0].arrayBuffer());
    assert.deepEqual([...bytes], [1, 2, 3, 4, 9, 9, 5, 5, 5, 5]);
  } finally {
    urls.restore();
    removeDom(dom);
  }
});

test('a patch that does not line up with a written header is refused', async () => {
  const dom = installDom();
  const urls = stubObjectUrls();
  try {
    const sink = await openExportSink({
      filename: 'read.wav',
      mimeType: 'audio/wav',
      extension: 'wav',
      preferStreaming: false,
      document: recordingDocument(),
    });
    await sink.write(Uint8Array.from([0, 0, 0, 0]));

    await assert.rejects(() => sink.patch(2, Uint8Array.from([1, 1])), /already wrote/);
    await assert.rejects(() => sink.patch(0, Uint8Array.from([1, 1])), /already wrote/);
  } finally {
    urls.restore();
    removeDom(dom);
  }
});

test('an aborted buffered export hands the browser nothing at all', async () => {
  const dom = installDom();
  const urls = stubObjectUrls();
  try {
    const sink = await openExportSink({
      filename: 'read.wav',
      mimeType: 'audio/wav',
      extension: 'wav',
      preferStreaming: false,
      document: recordingDocument(),
    });
    await sink.write(Uint8Array.from([1, 2, 3]));
    await sink.abort();
    await sink.close();

    assert.deepEqual(urls.created, [], 'a cancelled export started a download');
  } finally {
    urls.restore();
    removeDom(dom);
  }
});

test('a cancelled save truncates the file instead of leaving a partial recording', async () => {
  const calls = [];
  const stream = {
    async write(op) {
      calls.push(['write', op.position]);
    },
    async truncate(n) {
      calls.push(['truncate', n]);
    },
    async close() {
      calls.push(['close']);
    },
  };
  globalThis.showSaveFilePicker = async () => ({ createWritable: async () => stream });

  try {
    const sink = await openExportSink({ filename: 'read.m4a', mimeType: 'audio/mp4', extension: 'm4a' });
    await sink.write(Uint8Array.from([1, 2, 3]));
    await sink.abort();

    assert.deepEqual(calls, [['write', 0], ['truncate', 0], ['close']]);
  } finally {
    delete globalThis.showSaveFilePicker;
  }
});
