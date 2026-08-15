import assert from 'node:assert/strict';
import test from 'node:test';

import { diffConfig, ENDPOINT_CONFIG } from '../scripts/runpod-endpoint.mjs';
import { RunPodServerlessEngine } from '../src/audio/runpod-engine.js';

/**
 * The worker's engine is written for one card: half-precision weights, a wide
 * decode batch, a device-resident attention cache. RunPod treats gpuTypeIds as
 * a prioritised fallback list, so listing a second 48GB card here would let it
 * substitute one silently and halve throughput with nothing to show for it.
 */
test('the endpoint pins the L40S rather than accepting any 48GB card', () => {
  assert.deepEqual(ENDPOINT_CONFIG.gpuTypeIds, ['NVIDIA L40S']);
  assert.equal(ENDPOINT_CONFIG.gpuCount, 1);
});

test('the endpoint scales to the fleet a feature-length render is sized for', () => {
  assert.equal(ENDPOINT_CONFIG.workersMax, 3);
  // QUEUE_DELAY holds a burst behind an observation window before adding the
  // second and third worker, which is dead time at the start of every render.
  assert.equal(ENDPOINT_CONFIG.scalerType, 'REQUEST_COUNT');
  assert.equal(ENDPOINT_CONFIG.scalerValue, 1);
  assert.equal(ENDPOINT_CONFIG.flashboot, true);
});

/**
 * The browser abandons a job at its own deadline. If the endpoint were allowed
 * to run longer than the browser waits, a render could be billed in full and
 * then discarded — the failure this whole change set exists to remove.
 */
test('the endpoint execution timeout stays inside the browser polling deadline', () => {
  const clientDeadlineMs = new RunPodServerlessEngine({ hasConsent: () => true }).batchJobDeadlineMs;

  assert.ok(
    ENDPOINT_CONFIG.executionTimeoutMs < clientDeadlineMs,
    `endpoint timeout ${ENDPOINT_CONFIG.executionTimeoutMs}ms must be under the client deadline ${clientDeadlineMs}ms`,
  );
});

test('diffConfig reports only fields that actually differ', () => {
  const current = { gpuTypeIds: ['NVIDIA L40S'], workersMax: 5, flashboot: true };
  const changes = diffConfig(current, { gpuTypeIds: ['NVIDIA L40S'], workersMax: 3, flashboot: true });

  assert.deepEqual(changes, [{ key: 'workersMax', from: 5, to: 3 }]);
  assert.deepEqual(diffConfig({ gpuTypeIds: ['NVIDIA A40'] }, { gpuTypeIds: ['NVIDIA L40S'] }), [
    { key: 'gpuTypeIds', from: ['NVIDIA A40'], to: ['NVIDIA L40S'] },
  ]);
});
