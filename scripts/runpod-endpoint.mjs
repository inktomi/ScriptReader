#!/usr/bin/env node
/**
 * The RunPod endpoint's own configuration, kept in the repository.
 *
 * Everything the worker depends on to be fast lived only in the RunPod console
 * before this: which GPU it lands on, how many workers it may spin, how long a
 * job is allowed to run. The engine is written for an L40S — half precision
 * weights, a wide decode batch, a device-resident attention cache — and none of
 * that is worth anything on a card the console silently substituted. GPU
 * selection there is a prioritised fallback list, so an endpoint that merely
 * asks for "48GB" can be answered with an A40 or an A6000 and never say so.
 *
 * Usage:
 *   RUNPOD_API_KEY=... node scripts/runpod-endpoint.mjs            # show the diff
 *   RUNPOD_API_KEY=... node scripts/runpod-endpoint.mjs --apply    # write it
 *   RUNPOD_API_KEY=... node scripts/runpod-endpoint.mjs --endpoint <id>
 */

const API_BASE = 'https://rest.runpod.io/v1';
const DEFAULT_ENDPOINT_ID = 'lp3hrmg85v80jm';

export const ENDPOINT_CONFIG = {
  // Ada Lovelace, 48GB, 864 GB/s. Listed alone rather than alongside the other
  // 48GB cards: a fallback that quietly swaps in an A40 would halve throughput
  // for the fp16 path this worker is built around, and nothing would report it.
  gpuTypeIds: ['NVIDIA L40S'],
  gpuCount: 1,

  // Three workers is the fleet a feature-length render is sized for. The
  // browser keeps six batch requests in flight, so every worker has a job
  // waiting the moment it finishes one.
  workersMax: 3,
  // Zero idle workers between renders. A render pays one cold start; keeping a
  // worker warm across an editing session would cost far more than it saves.
  workersMin: 0,

  // Scale on queued requests rather than on how long they have waited. The
  // default QUEUE_DELAY holds a burst behind a four second observation window
  // before adding the second and third worker — dead time at the exact moment
  // the whole fleet should be starting.
  scalerType: 'REQUEST_COUNT',
  scalerValue: 1,

  // Cold start dominates the first job: a multi-gigabyte image, then the model
  // load and warmup the handler now performs before it accepts work. FlashBoot
  // keeps a spun-down worker's state around so the next one skips most of it.
  flashboot: true,

  // Long enough to hold a worker through the gaps between batches in a render
  // pass, short enough not to bill through a coffee break.
  idleTimeout: 60,

  // A batch of 24 lines on a warm L40S finishes in well under a minute; this is
  // headroom for a cold worker, not an expected duration. The browser's own
  // polling deadline is set above this so it never abandons a job the endpoint
  // is still willing to run.
  executionTimeoutMs: 600_000,
};

function parseArgs(argv) {
  const args = { apply: false, endpointId: process.env.RUNPOD_ENDPOINT_ID || DEFAULT_ENDPOINT_ID };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--apply') args.apply = true;
    else if (argv[index] === '--endpoint') args.endpointId = argv[++index];
  }
  return args;
}

async function request(path, { apiKey, method = 'GET', body }) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`RunPod ${method} ${path} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

export function diffConfig(current, desired) {
  const changes = [];
  for (const [key, value] of Object.entries(desired)) {
    const actual = current?.[key];
    const same = Array.isArray(value)
      ? Array.isArray(actual) && value.length === actual.length && value.every((item, i) => item === actual[i])
      : actual === value;
    if (!same) {
      changes.push({ key, from: actual, to: value });
    }
  }
  return changes;
}

async function main() {
  const { apply, endpointId } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) {
    console.error('Set RUNPOD_API_KEY to the key that owns this endpoint.');
    process.exitCode = 1;
    return;
  }

  const current = await request(`/endpoints/${endpointId}`, { apiKey });
  const changes = diffConfig(current, ENDPOINT_CONFIG);

  console.log(`Endpoint ${endpointId} (${current.name || 'unnamed'})`);
  if (changes.length === 0) {
    console.log('Already matches the configuration in this file.');
    return;
  }

  for (const { key, from, to } of changes) {
    console.log(`  ${key}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
  }

  if (!apply) {
    console.log('\nRe-run with --apply to write these changes.');
    return;
  }

  await request(`/endpoints/${endpointId}`, { apiKey, method: 'PATCH', body: ENDPOINT_CONFIG });
  console.log('\nApplied.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
