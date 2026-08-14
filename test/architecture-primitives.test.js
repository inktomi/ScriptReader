import assert from 'node:assert/strict';
import test from 'node:test';

import { readBoundedResponseBlob, readBoundedResponseJson } from '../src/utils/bounded-response.js';
import { createFocusPreservingRenderer } from '../src/utils/focus-preserving-render.js';
import { LatestOperation } from '../src/utils/latest-operation.js';
import { createMutationQueue, runStagedMutation } from '../src/utils/staged-mutation.js';
import { installDom, removeDom } from './dom-helpers.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function streamingResponse({ declared, chunks = [], readError } = {}) {
  let index = 0;
  const calls = { cancel: 0, release: 0, read: 0 };
  const reader = {
    async read() {
      calls.read++;
      if (readError) throw readError;
      if (index >= chunks.length) return { done: true };
      return { done: false, value: chunks[index++] };
    },
    async cancel() {
      calls.cancel++;
    },
    releaseLock() {
      calls.release++;
    },
  };
  return {
    response: {
      headers: {
        get(name) {
          if (name.toLowerCase() === 'content-length') return declared ?? null;
          if (name.toLowerCase() === 'content-type') return 'audio/mpeg';
          return null;
        },
      },
      body: { getReader: () => reader },
    },
    calls,
  };
}

test('latest operation aborts its predecessor and rejects stale commits even when work ignores abort', async () => {
  const operation = new LatestOperation();
  const first = deferred();
  const second = deferred();
  const commits = [];
  const errors = [];
  let firstSignal;

  const firstRun = operation.run(
    async ({ signal }) => {
      firstSignal = signal;
      return await first.promise;
    },
    { onCommit: (value) => commits.push(value), onError: (error) => errors.push(error) },
  );
  const secondRun = operation.run(async () => await second.promise, {
    onCommit: (value) => commits.push(value),
    onError: (error) => errors.push(error),
  });

  assert.equal(firstSignal.aborted, true);
  second.resolve('new');
  assert.equal((await secondRun).status, 'committed');
  first.resolve('stale');
  assert.equal((await firstRun).status, 'aborted');
  assert.deepEqual(commits, ['new']);
  assert.deepEqual(errors, []);
});

test('closing a latest operation aborts active work and prevents future work', async () => {
  const operation = new LatestOperation();
  const pending = deferred();
  let signal;
  const run = operation.run(async (context) => {
    signal = context.signal;
    return await pending.promise;
  });
  operation.close();
  pending.resolve('late');

  assert.equal(signal.aborted, true);
  assert.equal((await run).status, 'aborted');
  assert.equal((await operation.run(async () => 'never')).status, 'closed');
});

test('bounded reader rejects a declared oversized response before pulling and releases it', async () => {
  const { response, calls } = streamingResponse({ declared: '11', chunks: [new Uint8Array(1)] });
  await assert.rejects(readBoundedResponseBlob(response, { maxBytes: 10 }), /too large/);
  assert.deepEqual(calls, { cancel: 1, release: 1, read: 0 });
});

test('bounded reader rejects an undeclared oversized response at the first violating chunk', async () => {
  const { response, calls } = streamingResponse({
    chunks: [new Uint8Array(6), new Uint8Array(5), new Uint8Array(1)],
  });
  await assert.rejects(readBoundedResponseBlob(response, { maxBytes: 10 }), /too large/);
  assert.equal(calls.read, 2);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.release, 1);
});

test('bounded reader forwards abort to a pending reader and releases its lock', async () => {
  const controller = new AbortController();
  let finishRead;
  const calls = { cancel: 0, release: 0 };
  const response = {
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          read: () =>
            new Promise((resolve) => {
              finishRead = resolve;
            }),
          async cancel() {
            calls.cancel++;
            finishRead?.({ done: true });
          },
          releaseLock() {
            calls.release++;
          },
        };
      },
    },
  };
  const reading = readBoundedResponseBlob(response, { maxBytes: 10, signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(reading, (error) => error?.name === 'AbortError');
  assert.ok(calls.cancel >= 1);
  assert.equal(calls.release, 1);
});

test('bounded reader cancels and releases after an underlying read failure', async () => {
  const failure = new Error('socket failed');
  const { response, calls } = streamingResponse({ readError: failure });
  await assert.rejects(readBoundedResponseBlob(response, { maxBytes: 10 }), failure);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.release, 1);
});

test('bounded reader cancels a supplied response when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let cancelled = 0;
  const response = {
    headers: { get: () => null },
    body: {
      async cancel() {
        cancelled++;
      },
    },
  };

  await assert.rejects(
    readBoundedResponseBlob(response, { maxBytes: 10, signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(cancelled, 1);
});

test('bounded reader refuses a non-streaming body without buffering it', async () => {
  let blobCalls = 0;
  const response = {
    headers: { get: (name) => (name === 'content-length' ? '5' : null) },
    async blob() {
      blobCalls++;
      return new Blob([new Uint8Array(100)]);
    },
  };
  await assert.rejects(readBoundedResponseBlob(response, { maxBytes: 10 }), /cannot safely read/);
  assert.equal(blobCalls, 0);
});

test('bounded JSON reader parses only after the streamed body fits the limit', async () => {
  const response = new Response(JSON.stringify({ status: 'COMPLETED', count: 2 }), {
    headers: { 'content-type': 'application/json' },
  });
  assert.deepEqual(await readBoundedResponseJson(response, { maxBytes: 128 }), {
    status: 'COMPLETED',
    count: 2,
  });
});

test('focus-preserving renderer restores live values, selection, scroll, and a deterministic fallback', () => {
  const dom = installDom();
  try {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const view = (disabled) => `
      <input id="query" value="state value">
      <div class="scroll"></div>
      <button data-focus-key="first">First</button>
      <button data-focus-key="active" ${disabled ? 'disabled' : ''}>Active</button>`;
    root.innerHTML = view(false);
    const renderer = createFocusPreservingRenderer(root, {
      valueSelectors: ['#query'],
      scrollSelectors: ['.scroll'],
      keepFocusInside: () => root.isConnected,
      fallback: ({ findByIdentity }) => findByIdentity('key:first'),
    });
    const query = root.querySelector('#query');
    query.value = 'live unfinished text';
    query.setSelectionRange(5, 13);
    root.querySelector('.scroll').scrollTop = 42;
    root.querySelector('[data-focus-key="active"]').focus();

    renderer.render(() => {
      root.innerHTML = view(true);
    });

    const restoredQuery = root.querySelector('#query');
    assert.equal(restoredQuery.value, 'live unfinished text');
    assert.equal(restoredQuery.selectionStart, 5);
    assert.equal(restoredQuery.selectionEnd, 13);
    assert.equal(root.querySelector('.scroll').scrollTop, 42);
    assert.equal(document.activeElement.dataset.focusKey, 'first');
    assert.notEqual(document.activeElement, document.body);
  } finally {
    removeDom(dom);
  }
});

test('staged mutation honors abort before commit and finishes metadata after the durable boundary', async () => {
  const beforeCommit = new AbortController();
  const beforeEvents = [];
  await assert.rejects(
    runStagedMutation({
      signal: beforeCommit.signal,
      async stage() {
        beforeEvents.push('stage');
        beforeCommit.abort();
        return 'staged';
      },
      async commitDurable() {
        beforeEvents.push('commit');
      },
      async persistMetadata() {
        beforeEvents.push('metadata');
      },
      async cleanupStage() {
        beforeEvents.push('cleanup');
      },
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.deepEqual(beforeEvents, ['stage', 'cleanup']);

  const afterCommit = new AbortController();
  const afterEvents = [];
  const result = await runStagedMutation({
    signal: afterCommit.signal,
    async stage() {
      afterEvents.push('stage');
      return 'staged';
    },
    async commitDurable() {
      afterEvents.push('commit');
      afterCommit.abort();
      return 'durable';
    },
    async persistMetadata() {
      afterEvents.push('metadata');
      return 'saved';
    },
    async reconcile() {
      afterEvents.push('reconcile');
    },
    async cleanupStage() {
      afterEvents.push('cleanup');
    },
  });
  assert.equal(result, 'saved');
  assert.deepEqual(afterEvents, ['stage', 'commit', 'metadata', 'reconcile', 'cleanup']);
});

test('staged mutation compensates metadata failure and preserves the primary error', async () => {
  const failure = new Error('metadata failed');
  const events = [];
  await assert.rejects(
    runStagedMutation({
      async stage() {
        events.push('stage');
        return 'staged';
      },
      async commitDurable() {
        events.push('commit');
        return 'durable';
      },
      async persistMetadata() {
        events.push('metadata');
        throw failure;
      },
      async compensateDurable() {
        events.push('compensate');
      },
      async cleanupStage() {
        events.push('cleanup');
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, ['stage', 'commit', 'metadata', 'compensate', 'cleanup']);
});

test('staged mutation surfaces cleanup failures without replacing an earlier failure', async () => {
  const cleanupFailure = new Error('cleanup failed');
  await assert.rejects(
    runStagedMutation({
      async stage() {
        return 'staged';
      },
      async commitDurable() {
        return 'durable';
      },
      async persistMetadata() {
        return 'saved';
      },
      async cleanupStage() {
        throw cleanupFailure;
      },
    }),
    (error) => error === cleanupFailure,
  );

  const primaryFailure = new Error('metadata failed');
  const secondaryFailure = new Error('second cleanup failed');
  await assert.rejects(
    runStagedMutation({
      async stage() {
        return 'staged';
      },
      async commitDurable() {
        return 'durable';
      },
      async persistMetadata() {
        throw primaryFailure;
      },
      async cleanupStage() {
        throw secondaryFailure;
      },
    }),
    (error) => error === primaryFailure && error.cleanupErrors?.[0] === secondaryFailure,
  );
});

test('mutation queue serializes overlapping mutations and continues after failure', async () => {
  const queue = createMutationQueue();
  const first = deferred();
  const events = [];
  const firstRun = queue.run(async () => {
    events.push('first:start');
    await first.promise;
    events.push('first:end');
    throw new Error('first failed');
  });
  const secondRun = queue.run(async () => {
    events.push('second');
    return 'saved';
  });
  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  first.resolve();
  await assert.rejects(firstRun, /first failed/);
  assert.equal(await secondRun, 'saved');
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
});

test('mutation queue uses a named browser lock when one is available', async () => {
  const locks = [];
  const queue = createMutationQueue({
    lockName: 'voice-store',
    getLockManager: () => ({
      async request(name, operation) {
        locks.push(name);
        return await operation();
      },
    }),
  });

  assert.equal(await queue.run(async () => 'saved'), 'saved');
  assert.deepEqual(locks, ['voice-store']);
});
