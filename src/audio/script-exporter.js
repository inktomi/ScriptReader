import {
  applyUnitEnvelope,
  buildUnitChain,
  createTimelineEdges,
  MIX_HEADROOM,
  placeOnTimeline,
} from './playback-scheduler.js';

/**
 * Offline export of a whole table read to one audio file.
 *
 * The naive approach - one `OfflineAudioContext` spanning the script - does not
 * survive contact with a feature-length screenplay: stereo Float32 at 24 kHz is
 * roughly 690 MB per hour, and a full read is closer to two. So the timeline is
 * never materialised whole. Each unit is rendered alone through its own small
 * offline context, summed into a sliding window, and handed to the encoder as
 * soon as no future unit can reach back into it. Peak memory is a function of
 * the longest overlap cluster, not of the script.
 *
 * Placement comes from `placeOnTimeline` - the same arithmetic the live
 * scheduler runs - because a file whose interruptions land differently from the
 * speakers is a different performance, not a recording of one.
 */

// Extra tail rendered past a unit's audible end so a biquad's ringing is not
// clipped off mid-decay. Cheap, and inaudible if the filter had nothing left.
const TAIL_PAD_SEC = 0.02;

// How far behind the current cluster the mixer refuses to finalise. The cluster
// itself already bounds how far an anchor can reach backwards; this is slack
// against a script that anchors further than expected, at a cost of well under
// a megabyte.
const FLUSH_MARGIN_SEC = 2;

// Clusters queued with the engine beyond the one being awaited. A remote engine
// only reaches full speed with enough units in flight to batch.
const PREFETCH_CLUSTERS = 4;

const MIN_ACCUMULATOR_FRAMES = 1 << 16;

/**
 * Sliding multi-channel mix buffer addressed in absolute frames.
 *
 * `mix` sums; it never overwrites. Two actors talking at once are two units
 * landing on overlapping frame ranges, which is the whole reason this is a
 * mixer and not a concatenator.
 */
export function createMixAccumulator({ channels = 2 } = {}) {
  let origin = 0;
  let length = 0;
  let planes = Array.from({ length: channels }, () => new Float32Array(MIN_ACCUMULATOR_FRAMES));

  function ensureCapacity(frames) {
    if (frames <= planes[0].length) return;
    let capacity = planes[0].length;
    while (capacity < frames) capacity *= 2;
    planes = planes.map((plane) => {
      const grown = new Float32Array(capacity);
      grown.set(plane);
      return grown;
    });
  }

  function take(untilFrame) {
    const count = Math.max(0, Math.min(length, untilFrame - origin));
    if (count === 0) return null;

    const out = planes.map((plane) => plane.slice(0, count));
    const remaining = length - count;
    for (const plane of planes) {
      plane.copyWithin(0, count, length);
      plane.fill(0, remaining, length);
    }
    origin += count;
    length = remaining;
    return out;
  }

  return {
    get origin() {
      return origin;
    },
    get length() {
      return length;
    },
    mix(source, atFrame) {
      const offset = atFrame - origin;
      if (offset < 0) {
        throw new Error('Export mixer was asked to write into audio it had already committed.');
      }
      const frames = source[0]?.length || 0;
      if (frames === 0) return;

      ensureCapacity(offset + frames);
      for (let channel = 0; channel < channels; channel++) {
        const target = planes[channel];
        // A mono render feeds every channel; the panner normally makes this moot.
        const from = source[Math.min(channel, source.length - 1)];
        for (let i = 0; i < frames; i++) target[offset + i] += from[i];
      }
      length = Math.max(length, offset + frames);
    },
    take,
    drain() {
      return take(origin + length);
    },
  };
}

/**
 * Peak limiter standing in for the live chain's `DynamicsCompressor`.
 *
 * This is the one place the export is not sample-identical to playback: the
 * compressor sits after the mix bus and cannot be reproduced without holding the
 * entire mix in one context, which is exactly what this design refuses to do.
 * The ceiling and the attack/release constants match the live settings, and the
 * envelope carries across flushes, so the gain riding is continuous even though
 * the audio is delivered a window at a time.
 */
export function createSoftLimiter({ sampleRate, ceiling = 0.891, attackSec = 0.001, releaseSec = 0.12 }) {
  let gain = 1;
  const attackCoefficient = Math.exp(-1 / Math.max(1, attackSec * sampleRate));
  const releaseCoefficient = Math.exp(-1 / Math.max(1, releaseSec * sampleRate));

  return {
    get gain() {
      return gain;
    },
    process(planes) {
      const frames = planes[0]?.length || 0;
      for (let i = 0; i < frames; i++) {
        let peak = 0;
        for (const plane of planes) {
          const magnitude = Math.abs(plane[i]);
          if (magnitude > peak) peak = magnitude;
        }

        const target = peak > ceiling ? ceiling / peak : 1;
        const coefficient = target < gain ? attackCoefficient : releaseCoefficient;
        gain = target + (gain - target) * coefficient;

        for (const plane of planes) {
          // The smoothed envelope lags a true peak by its attack time, so the
          // clamp is what actually guarantees nothing leaves here above 0 dBFS.
          const value = plane[i] * gain;
          plane[i] = value > 1 ? 1 : value < -1 ? -1 : value;
        }
      }
      return planes;
    },
  };
}

/** Render one placed unit on its own, through the live per-unit signal chain. */
export async function renderUnitOffline({ unit, placement, buffer, sampleRate, OfflineContext }) {
  const audible = Math.max(placement.endAt - placement.startAt, 1 / sampleRate);
  const frames = Math.max(1, Math.ceil((audible + TAIL_PAD_SEC) * sampleRate));

  const ctx = new OfflineContext(2, frames, sampleRate);
  const source = ctx.createBufferSource();
  // AudioBuffer carries its own sample rate and is not bound to the context that
  // made it, so the cached render is reused as-is and the context resamples if
  // the export rate differs.
  source.buffer = buffer;
  source.playbackRate.value = unit.playbackRate || 1.0;

  const { gainNode } = buildUnitChain(ctx, unit, source, ctx.destination);
  applyUnitEnvelope(source, gainNode, placement, 0);

  const rendered = await ctx.startRendering();
  return [rendered.getChannelData(0), rendered.getChannelData(1)];
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
}

/**
 * Run one export end to end.
 *
 * Platform pieces are injected so the pipeline can be exercised without
 * WebCodecs or Web Audio: `renderUnit` produces a unit's stereo planes,
 * `requestUnit` fetches its rendered buffer from whichever engine owns it, and
 * `sink` receives the encoded bytes.
 *
 * @returns {Promise<{frames: number, seconds: number}>}
 */
export async function runScriptExport({
  clusters,
  sampleRate,
  encoder,
  sink,
  requestUnit,
  renderUnit,
  signal,
  onProgress = () => {},
}) {
  const edges = createTimelineEdges(0);
  const accumulator = createMixAccumulator({ channels: 2 });
  const limiter = createSoftLimiter({ sampleRate });
  const flushMarginFrames = Math.round(FLUSH_MARGIN_SEC * sampleRate);

  const allUnits = clusters.flat();
  const totalEstimated = allUnits.reduce((sum, unit) => sum + (unit.estimatedDuration || 0), 0);
  let completedEstimated = 0;
  let completedUnits = 0;
  let framesWritten = 0;
  const startedAt = Date.now();

  const publish = (phase) => {
    const elapsed = (Date.now() - startedAt) / 1000;
    const fraction = totalEstimated > 0 ? completedEstimated / totalEstimated : 1;
    const etaSeconds = fraction > 0.02 && elapsed > 1 ? Math.max(0, elapsed / fraction - elapsed) : null;
    onProgress({
      active: true,
      phase,
      completed: completedUnits,
      total: allUnits.length,
      percent: Math.min(100, Math.round(fraction * 100)),
      renderedSeconds: framesWritten / sampleRate,
      etaSeconds,
      error: null,
    });
  };

  async function emit(planes) {
    if (!planes) return;
    framesWritten += planes[0].length;
    // Master gain, then the limiter. The volume slider and the analyser are
    // deliberately absent: an exported file sits at a fixed reference level
    // whatever the listener had the transport set to.
    for (const plane of planes) {
      for (let i = 0; i < plane.length; i++) plane[i] *= MIX_HEADROOM;
    }
    await encoder.encode(limiter.process(planes));
  }

  publish('rendering');

  for (let index = 0; index < clusters.length; index++) {
    throwIfAborted(signal);

    // Queue the clusters after this one without waiting on them; they carry a
    // later priority, so the group being awaited is still served first.
    for (let ahead = index + 1; ahead < Math.min(clusters.length, index + 1 + PREFETCH_CLUSTERS); ahead++) {
      for (const unit of clusters[ahead]) requestUnit(unit, ahead)?.catch(() => {});
    }

    const cluster = clusters[index];
    const buffers = await Promise.all(
      cluster.map(async (unit) => {
        const pending = requestUnit(unit, index);
        if (!pending) throw new Error('The voice engine stopped accepting render requests.');
        return pending;
      }),
    );
    throwIfAborted(signal);

    let clusterStartFrame = Number.POSITIVE_INFINITY;
    for (let i = 0; i < cluster.length; i++) {
      const unit = cluster[i];
      const buffer = buffers[i];
      const rate = unit.playbackRate || 1.0;
      const placement = placeOnTimeline(edges, unit, buffer.duration / rate, 0);

      const planes = await renderUnit({ unit, placement, buffer, sampleRate });
      throwIfAborted(signal);

      const atFrame = Math.round(placement.startAt * sampleRate);
      accumulator.mix(planes, atFrame);
      clusterStartFrame = Math.min(clusterStartFrame, atFrame);

      completedUnits++;
      completedEstimated += unit.estimatedDuration || 0;
    }

    if (Number.isFinite(clusterStartFrame)) {
      await emit(accumulator.take(clusterStartFrame - flushMarginFrames));
    }
    publish('rendering');
  }

  throwIfAborted(signal);
  await emit(accumulator.drain());

  publish('encoding');
  await encoder.finish();

  publish('saving');
  await sink.close();

  return { frames: framesWritten, seconds: framesWritten / sampleRate };
}

/** A filename a filesystem will accept, derived from the screenplay's title. */
export function exportFilename(title, extension) {
  const base =
    String(title || 'ScriptReader table read')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'ScriptReader table read';
  return `${base}.${extension}`;
}
