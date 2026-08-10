/**
 * Shared AudioContext.
 *
 * Every part of the audio stack (synthesis buffers, playback scheduling, previews)
 * must share one context: AudioBuffers are context-bound, and the scheduler relies
 * on a single monotonic `currentTime` clock to lay lines end-to-end.
 *
 * Kokoro emits 24 kHz mono. Requesting a matching context sample rate avoids a
 * resample on every buffer; browsers that refuse the rate fall back to default.
 */

const KOKORO_SAMPLE_RATE = 24000;

let sharedContext = null;

export function getAudioContext() {
  if (sharedContext) return sharedContext;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  try {
    sharedContext = new AudioContextClass({
      sampleRate: KOKORO_SAMPLE_RATE,
      latencyHint: 'playback'
    });
  } catch (err) {
    // Some browsers reject explicit sample rates; a resampled context is fine.
    sharedContext = new AudioContextClass({ latencyHint: 'playback' });
  }

  return sharedContext;
}

/**
 * Browsers start the context suspended until a user gesture. Every playback entry
 * point funnels through here so a click on Play reliably wakes the clock.
 */
export async function resumeAudioContext() {
  const ctx = getAudioContext();
  if (!ctx) return null;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch (err) {
      console.warn('AudioContext resume notice:', err);
    }
  }
  return ctx;
}

export async function suspendAudioContext() {
  const ctx = getAudioContext();
  if (!ctx) return null;
  if (ctx.state === 'running') {
    try {
      await ctx.suspend();
    } catch (err) {
      console.warn('AudioContext suspend notice:', err);
    }
  }
  return ctx;
}
