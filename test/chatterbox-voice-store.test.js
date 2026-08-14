import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileChatterboxVoiceStorage, saveChatterboxVoice } from '../src/audio/chatterbox-voice-store.js';
import { installDom, removeDom } from './dom-helpers.js';

function installDecodingAudioContext(dom) {
  dom.window.AudioContext = class {
    async decodeAudioData() {
      const audio = new Float32Array(4 * 24_000).fill(0.25);
      return {
        duration: 4,
        length: audio.length,
        numberOfChannels: 1,
        sampleRate: 24_000,
        getChannelData: () => audio,
      };
    }
  };
}

function audioFile(name = 'voice.wav') {
  return {
    name,
    async arrayBuffer() {
      return new ArrayBuffer(8);
    },
  };
}

function cloneMetadata(items) {
  return items.map((item) => ({ ...item }));
}

function fakePersistence({ metadata = [], samples = new Map(), onPut, onWrite, onDelete } = {}) {
  let storedMetadata = cloneMetadata(metadata);
  return {
    samples,
    readMetadata: () => cloneMetadata(storedMetadata),
    async writeMetadata(next) {
      await onWrite?.(next);
      storedMetadata = cloneMetadata(next);
    },
    async putSample(record) {
      await onPut?.(record, samples);
      samples.set(record.id, record);
    },
    async deleteSample(id) {
      await onDelete?.(id, samples);
      samples.delete(id);
    },
    async inspectSampleRecords() {
      return [...samples.values()].map((record) => ({
        id: record.id,
        usable: Number(record.audio?.length ?? record.audio?.byteLength ?? 0) > 0,
      }));
    },
    metadata: () => cloneMetadata(storedMetadata),
  };
}

const existingMetadata = {
  id: 'studio-existing',
  name: 'Old voice',
  sourceVoiceId: 'catalog-voice',
  duration: 4,
};

test('replacement aborted while staged preserves the old stable sample and metadata', async () => {
  const dom = installDom();
  try {
    installDecodingAudioContext(dom);
    const controller = new AbortController();
    const oldRecord = { id: existingMetadata.id, audio: new Float32Array([0.75]) };
    const persistence = fakePersistence({
      metadata: [existingMetadata],
      samples: new Map([[existingMetadata.id, oldRecord]]),
      onWrite() {},
    });

    const originalRead = persistence.readMetadata;
    persistence.readMetadata = () => {
      const metadata = originalRead();
      controller.abort();
      return metadata;
    };

    await assert.rejects(
      saveChatterboxVoice(
        audioFile(),
        'New voice',
        {
          sourceVoiceId: 'catalog-voice',
        },
        { signal: controller.signal, persistence },
      ),
      (error) => error?.name === 'AbortError',
    );

    assert.equal(persistence.samples.get(existingMetadata.id), oldRecord);
    assert.deepEqual(persistence.metadata(), [existingMetadata]);
    assert.deepEqual([...persistence.samples.keys()], [existingMetadata.id]);
  } finally {
    removeDom(dom);
  }
});

test('replacement aborted after durable commit finishes metadata and keeps the stable local ID', async () => {
  const dom = installDom();
  try {
    installDecodingAudioContext(dom);
    const controller = new AbortController();
    let stablePuts = 0;
    const persistence = fakePersistence({
      metadata: [existingMetadata],
      samples: new Map([[existingMetadata.id, { id: existingMetadata.id, audio: new Float32Array([0.75]) }]]),
      onPut(record) {
        if (record.id === existingMetadata.id && ++stablePuts === 1) controller.abort();
      },
    });

    const saved = await saveChatterboxVoice(
      audioFile(),
      'New voice',
      {
        sourceVoiceId: 'catalog-voice',
      },
      { signal: controller.signal, persistence },
    );

    assert.equal(controller.signal.aborted, true);
    assert.equal(saved.id, existingMetadata.id);
    assert.equal(persistence.metadata()[0].id, existingMetadata.id);
    assert.equal(persistence.metadata()[0].name, 'New voice');
    assert.equal(persistence.samples.get(existingMetadata.id).audio.length, 4 * 24_000);
    assert.deepEqual([...persistence.samples.keys()], [existingMetadata.id]);
  } finally {
    removeDom(dom);
  }
});

test('a durable IndexedDB failure leaves the old replacement unchanged', async () => {
  const dom = installDom();
  try {
    installDecodingAudioContext(dom);
    const oldRecord = { id: existingMetadata.id, audio: new Float32Array([0.75]) };
    const persistence = fakePersistence({
      metadata: [existingMetadata],
      samples: new Map([[existingMetadata.id, oldRecord]]),
      onPut(record) {
        if (record.id === existingMetadata.id) throw new Error('IndexedDB commit failed');
      },
    });

    await assert.rejects(
      saveChatterboxVoice(
        audioFile(),
        'New voice',
        {
          sourceVoiceId: 'catalog-voice',
        },
        { persistence },
      ),
      /IndexedDB commit failed/,
    );
    assert.equal(persistence.samples.get(existingMetadata.id), oldRecord);
    assert.deepEqual(persistence.metadata(), [existingMetadata]);
    assert.deepEqual([...persistence.samples.keys()], [existingMetadata.id]);
  } finally {
    removeDom(dom);
  }
});

test('metadata failure removes a newly committed orphan and preserves the metadata error', async () => {
  const dom = installDom();
  try {
    installDecodingAudioContext(dom);
    const persistence = fakePersistence({
      onWrite() {
        throw new Error('localStorage failed');
      },
    });

    await assert.rejects(saveChatterboxVoice(audioFile(), 'New voice', {}, { persistence }), /localStorage failed/);
    assert.deepEqual([...persistence.samples.keys()], []);
    assert.deepEqual(persistence.metadata(), []);
  } finally {
    removeDom(dom);
  }
});

test('replacement metadata failure retains the newly durable sample under the old discoverable ID', async () => {
  const dom = installDom();
  try {
    installDecodingAudioContext(dom);
    const persistence = fakePersistence({
      metadata: [existingMetadata],
      samples: new Map([[existingMetadata.id, { id: existingMetadata.id, audio: new Float32Array([0.75]) }]]),
      onWrite() {
        throw new Error('localStorage failed');
      },
    });

    await assert.rejects(
      saveChatterboxVoice(
        audioFile(),
        'New voice',
        {
          sourceVoiceId: 'catalog-voice',
        },
        { persistence },
      ),
      /localStorage failed/,
    );
    assert.deepEqual(persistence.metadata(), [existingMetadata]);
    assert.equal(persistence.samples.get(existingMetadata.id).audio.length, 4 * 24_000);
    assert.deepEqual([...persistence.samples.keys()], [existingMetadata.id]);
  } finally {
    removeDom(dom);
  }
});

test('voice-store reconciliation removes stale metadata and orphan samples in safe order', async () => {
  const events = [];
  const persistence = fakePersistence({
    metadata: [
      { id: 'valid', name: 'Valid' },
      { id: 'stale', name: 'Missing sample' },
    ],
    samples: new Map([
      ['valid', { id: 'valid', audio: new Float32Array([1]) }],
      ['orphan', { id: 'orphan', audio: new Float32Array([1]) }],
    ]),
    onWrite() {
      events.push('metadata');
    },
    onDelete(id) {
      events.push(`delete:${id}`);
    },
  });

  const result = await reconcileChatterboxVoiceStorage({ persistence });
  assert.deepEqual(result, { removedMetadata: 1, removedOrphans: 1, failedOrphanIds: [] });
  assert.deepEqual(persistence.metadata(), [{ id: 'valid', name: 'Valid' }]);
  assert.deepEqual([...persistence.samples.keys()], ['valid']);
  assert.deepEqual(events, ['metadata', 'delete:orphan']);
});

test('voice-store reconciliation removes metadata backed by a record without usable audio', async () => {
  const persistence = fakePersistence({
    metadata: [{ id: 'broken', name: 'Broken' }],
    samples: new Map([['broken', { id: 'broken' }]]),
  });

  const result = await reconcileChatterboxVoiceStorage({ persistence });
  assert.deepEqual(result, { removedMetadata: 1, removedOrphans: 1, failedOrphanIds: [] });
  assert.deepEqual(persistence.metadata(), []);
  assert.deepEqual([...persistence.samples.keys()], []);
});

test('overlapping voice saves serialize metadata snapshots so neither import is lost', async () => {
  const dom = installDom();
  try {
    installDecodingAudioContext(dom);
    const firstMetadataWrite = new Promise((resolve) => setTimeout(resolve, 0));
    let writes = 0;
    const persistence = fakePersistence({
      async onWrite() {
        if (++writes === 1) await firstMetadataWrite;
      },
    });

    const [first, second] = await Promise.all([
      saveChatterboxVoice(audioFile('first.wav'), 'First', {}, { persistence }),
      saveChatterboxVoice(audioFile('second.wav'), 'Second', {}, { persistence }),
    ]);

    assert.notEqual(first.id, second.id);
    assert.deepEqual(
      persistence.metadata().map((item) => item.name),
      ['First', 'Second'],
    );
    assert.equal(persistence.samples.size, 2);
  } finally {
    removeDom(dom);
  }
});

test('reconciliation does not delete samples when stale-metadata repair fails', async () => {
  let deletes = 0;
  const persistence = fakePersistence({
    metadata: [{ id: 'stale', name: 'Missing sample' }],
    samples: new Map([['orphan', { id: 'orphan', audio: new Float32Array([1]) }]]),
    onWrite() {
      throw new Error('metadata unavailable');
    },
    onDelete() {
      deletes++;
    },
  });

  await assert.rejects(reconcileChatterboxVoiceStorage({ persistence }), /metadata unavailable/);
  assert.equal(deletes, 0);
  assert.equal(persistence.samples.has('orphan'), true);
});

test('reconciliation does not delete samples when metadata cannot be read', async () => {
  let deletes = 0;
  const persistence = fakePersistence({
    samples: new Map([['valid', { id: 'valid', audio: new Float32Array([1]) }]]),
    onDelete() {
      deletes++;
    },
  });
  persistence.readMetadata = () => {
    throw new Error('metadata unreadable');
  };

  await assert.rejects(reconcileChatterboxVoiceStorage({ persistence }), /metadata unreadable/);
  assert.equal(deletes, 0);
  assert.equal(persistence.samples.has('valid'), true);
});

test('reconciliation starts independent orphan deletions without serial round trips', async () => {
  const pending = [];
  const persistence = fakePersistence({
    samples: new Map([
      ['orphan-1', { id: 'orphan-1', audio: new Float32Array([1]) }],
      ['orphan-2', { id: 'orphan-2', audio: new Float32Array([1]) }],
    ]),
    onDelete(id) {
      return new Promise((resolve) => pending.push({ id, resolve }));
    },
  });

  const reconciliation = reconcileChatterboxVoiceStorage({ persistence });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    pending.map((item) => item.id),
    ['orphan-1', 'orphan-2'],
  );
  pending.forEach((item) => {
    item.resolve();
  });
  assert.deepEqual(await reconciliation, {
    removedMetadata: 0,
    removedOrphans: 2,
    failedOrphanIds: [],
  });
});
