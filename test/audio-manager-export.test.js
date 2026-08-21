import assert from 'node:assert/strict';
import test from 'node:test';

import { ScreenplayAudioManager } from '../src/audio/audio-manager.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';

const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

test.before(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  // Node has no Web Audio; the export gate only asks whether it exists.
  globalThis.OfflineAudioContext = function OfflineAudioContextStub() {};
});

test.after(() => {
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else delete globalThis.localStorage;
  delete globalThis.OfflineAudioContext;
});

function managerWithScript(elements, unitsForLine) {
  const manager = new ScreenplayAudioManager();
  manager.engineId = ENGINE_IDS.KOKORO;
  manager.scriptElements = elements;
  if (unitsForLine) manager._unitsForLine = unitsForLine;
  return manager;
}

const unitsByLine = (map) => (line) => (line in map ? map[line] : line < 0 ? null : null);

// ------------------------------------------------------------------- gating

test('export explains the one engine that cannot be recorded', () => {
  const manager = managerWithScript([{ type: 'ACTION' }]);

  manager.engineId = ENGINE_IDS.WEB_SPEECH;
  assert.match(manager.exportBlockedReason(), /built-in voice cannot be recorded/);

  manager.engineId = ENGINE_IDS.KOKORO;
  manager.usingWebSpeechFallback = true;
  assert.match(manager.exportBlockedReason(), /built-in voice cannot be recorded/);

  manager.usingWebSpeechFallback = false;
  assert.equal(manager.exportBlockedReason(), null);
});

test('export is blocked before a screenplay is loaded', () => {
  const manager = managerWithScript([]);
  assert.match(manager.exportBlockedReason(), /Load a screenplay/);
});

test('export is blocked where the browser cannot render offline', () => {
  const manager = managerWithScript([{ type: 'ACTION' }]);
  const saved = globalThis.OfflineAudioContext;
  delete globalThis.OfflineAudioContext;
  try {
    assert.match(manager.exportBlockedReason(), /cannot render audio offline/);
  } finally {
    globalThis.OfflineAudioContext = saved;
  }
});

test('exportAudio refuses rather than writing a file it cannot fill', async () => {
  const manager = managerWithScript([]);
  const seen = [];
  manager.subscribe((event, data) => {
    if (event === 'exportProgress') seen.push(data);
  });

  await assert.rejects(() => manager.exportAudio({ title: 'Nothing' }), /Load a screenplay/);
  assert.match(seen.at(-1).error, /Load a screenplay/);
  assert.equal(seen.at(-1).active, false);
});

// --------------------------------------------------------------------- plan

test('the export plan covers the whole script in order, starting at line one', () => {
  const manager = managerWithScript(
    [{ type: 'ACTION' }, { type: 'DIALOGUE' }, { type: 'DIALOGUE' }],
    unitsByLine({ 0: [{ key: 'a' }], 1: [{ key: 'b' }], 2: [{ key: 'c' }] }),
  );
  // A playhead parked mid-script must not rotate the file.
  manager.currentIndex = 2;

  const plan = manager.getExportPlan();
  assert.deepEqual(
    plan.map((cluster) => cluster.map((u) => u.key)),
    [['a'], ['b'], ['c']],
  );
});

test('overlapping lines stay in one cluster so their anchors resolve together', () => {
  const manager = managerWithScript(
    [
      { type: 'DIALOGUE' },
      { type: 'DIALOGUE', overlap: { mode: 'interrupt' } },
      { type: 'DIALOGUE', overlap: { mode: 'simultaneous' } },
      { type: 'ACTION' },
    ],
    unitsByLine({ 0: [{ key: 'a' }], 1: [{ key: 'b' }], 2: [{ key: 'c' }], 3: [{ key: 'd' }] }),
  );

  const plan = manager.getExportPlan();
  assert.deepEqual(
    plan.map((cluster) => cluster.map((u) => u.key)),
    [['a', 'b', 'c'], ['d']],
  );
});

test('lines with nothing speakable do not become empty clusters', () => {
  const manager = managerWithScript(
    [{ type: 'ACTION' }, { type: 'ACTION' }, { type: 'ACTION' }],
    unitsByLine({ 0: [{ key: 'a' }], 1: [], 2: [{ key: 'c' }] }),
  );

  const plan = manager.getExportPlan();
  assert.deepEqual(
    plan.map((cluster) => cluster.map((u) => u.key)),
    [['a'], ['c']],
  );
});

test('the plan still terminates when every line overlaps the next', () => {
  const elements = Array.from({ length: 6 }, (_, i) => ({
    type: 'DIALOGUE',
    ...(i > 0 ? { overlap: { mode: 'simultaneous' } } : {}),
  }));
  const manager = managerWithScript(elements, (line) =>
    line >= 0 && line < elements.length ? [{ key: `u${line}` }] : null,
  );

  const plan = manager.getExportPlan();
  assert.equal(plan.length, 1);
  assert.equal(plan[0].length, 6);
});

// ---------------------------------------------------------------- ownership

function runningExport(manager) {
  const controller = new AbortController();
  manager._exportAbort = controller;
  return controller;
}

test('a cast or pacing change stops an export it would have changed halfway', () => {
  const manager = managerWithScript([{ type: 'ACTION' }]);
  const controller = runningExport(manager);

  manager._invalidateUnits();

  assert.equal(controller.signal.aborted, true);
  assert.match(String(controller.signal.reason?.message), /cast or pacing changed/);
});

test('setMasterSpeed reaches the export through the same invalidation', () => {
  const manager = managerWithScript([{ type: 'ACTION' }]);
  const controller = runningExport(manager);

  manager.setMasterSpeed(1.5);

  assert.equal(controller.signal.aborted, true);
});

test('pressing Play stands the export down rather than starving playback', async () => {
  const manager = managerWithScript([{ type: 'ACTION' }], unitsByLine({ 0: [{ key: 'a' }] }));
  const controller = runningExport(manager);

  await manager.play().catch(() => {});

  assert.equal(controller.signal.aborted, true);
  assert.match(String(controller.signal.reason?.message), /Playback started/);
});

test('cancelExport reports whether there was anything to stop', () => {
  const manager = managerWithScript([{ type: 'ACTION' }]);
  assert.equal(manager.cancelExport(), false);
  assert.equal(manager.isExporting, false);

  const controller = runningExport(manager);
  assert.equal(manager.isExporting, true);
  assert.equal(manager.cancelExport(), true);
  assert.equal(controller.signal.aborted, true);
});

test('two exports cannot run at once', async () => {
  const manager = managerWithScript([{ type: 'ACTION' }]);
  runningExport(manager);
  await assert.rejects(() => manager.exportAudio({ title: 'Busy' }), /already running/);
});

// ------------------------------------------------------------------ routing

test('each unit is requested from the engine that owns its voice', () => {
  const manager = managerWithScript([{ type: 'ACTION' }]);
  const calls = [];
  const engineFor = (id) => ({
    capabilities: { id },
    request(unit, priority) {
      calls.push([id, unit.key, priority]);
      return Promise.resolve({ duration: 1 });
    },
  });

  manager.engine = engineFor(ENGINE_IDS.CHATTERBOX);
  manager._engines.set(ENGINE_IDS.KOKORO, engineFor(ENGINE_IDS.KOKORO));

  manager.requestUnit({ key: 'dialogue', engineId: ENGINE_IDS.CHATTERBOX }, 0);
  manager.requestUnit({ key: 'narration', engineId: ENGINE_IDS.KOKORO }, 3);

  assert.deepEqual(calls, [
    [ENGINE_IDS.CHATTERBOX, 'dialogue', 0],
    [ENGINE_IDS.KOKORO, 'narration', 3],
  ]);
});

// ------------------------------------------------- engine readiness on export

function exportableManager() {
  const manager = managerWithScript([{ type: 'ACTION' }], unitsByLine({ 0: [{ key: 'a', estimatedDuration: 1 }] }));
  manager.engine = {
    isReady: false,
    capabilities: { id: ENGINE_IDS.KOKORO, label: 'Kokoro', metered: false },
    request: () => Promise.resolve({ duration: 1 }),
    dropPendingExcept() {},
    onProgress: () => () => {},
  };
  return manager;
}

test('a primary engine that will not start fails the export instead of rendering silence', async () => {
  const manager = exportableManager();
  // `_initRequiredEngines` reports the active engine through `primaryError`
  // and deliberately keeps it out of `failed`, so checking only `failed` let
  // the export start against an engine that never loaded, and surface the
  // outage much later as a generic queue error.
  manager._initRequiredEngines = async () => ({ primaryError: new Error('Kokoro weights failed'), failed: [] });

  await assert.rejects(() => manager.exportAudio({ title: 'Cold engine' }), /Kokoro weights failed/);
  assert.equal(manager.isExporting, false);
});

test('an engine that reports no error but never became ready still fails the export', async () => {
  const manager = exportableManager();
  manager._initRequiredEngines = async () => ({ primaryError: null, failed: [] });

  await assert.rejects(() => manager.exportAudio({ title: 'Silently cold' }), /Kokoro could not be started/);
});

test('a supporting engine failure is still reported', async () => {
  const manager = exportableManager();
  manager.engine.isReady = true;
  manager._initRequiredEngines = async () => ({
    primaryError: null,
    failed: [{ capabilities: { label: 'Studio Local' } }],
  });

  await assert.rejects(() => manager.exportAudio({ title: 'Half a cast' }), /Studio Local could not be started/);
});

// ------------------------------------------- transport actions during export

test('a transport action does not flush the queues an export is waiting on', () => {
  const manager = managerWithScript([{ type: 'ACTION' }], unitsByLine({ 0: [{ key: 'a' }] }));
  let drops = 0;
  manager._dropPendingExcept = () => {
    drops++;
  };

  // Without an export running these still behave exactly as they did.
  manager.stop();
  manager.seek(0);
  assert.ok(drops > 0, 'ordinary transport actions should still abandon lookahead');

  drops = 0;
  runningExport(manager);
  manager.stop();
  manager.seek(0);
  assert.equal(drops, 0, "a seek or stop rejected the export's in-flight units");
});
