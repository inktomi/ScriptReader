/**
 * AAC-LC export encoder, built on the browser's own `AudioEncoder`.
 *
 * WebCodecs gives us a platform AAC encoder with no dependency and no licence
 * to carry. It emits bare access units, which `mp4-muxer.js` indexes into an
 * .m4a - the container a listener can actually double-click.
 *
 * Support is probed, never assumed: Firefox ships `AudioEncoder` without an AAC
 * encoder, and the caller falls back to WAV when `pickAacConfig` returns null.
 */

export const DEFAULT_AAC_BITRATE = 96000;

/**
 * The rates we will encode at, best first.
 *
 * Native 24 kHz leads because every engine renders there - encoding it as-is
 * costs the resampler nothing and invents no bandwidth the voices never had. In
 * practice Chrome's AAC encoder refuses everything below 44.1 kHz, so the later
 * entries are the ones that usually win; they are not decoration.
 */
export const PREFERRED_EXPORT_RATES = [24000, 48000, 44100];

/**
 * The first rate in `PREFERRED_EXPORT_RATES` this browser will actually encode,
 * or null when AAC is unavailable and the caller should write WAV instead.
 */
export async function pickAacConfig({ channels = 2, bitrate = DEFAULT_AAC_BITRATE } = {}) {
  if (typeof globalThis.AudioEncoder?.isConfigSupported !== 'function') return null;

  for (const sampleRate of PREFERRED_EXPORT_RATES) {
    const config = {
      codec: 'mp4a.40.2',
      sampleRate,
      numberOfChannels: channels,
      bitrate,
      // Bare access units, not ADTS: the MP4 sample table does the framing, and
      // this is also what makes the encoder report its AudioSpecificConfig.
      aac: { format: 'aac' },
    };
    try {
      const support = await globalThis.AudioEncoder.isConfigSupported(config);
      if (support?.supported) return { ...config, ...support.config };
    } catch (_err) {
      // A rate the encoder rejects outright is simply not a candidate.
    }
  }

  return null;
}

function toBytes(source) {
  if (!source) return null;
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
}

/**
 * Streaming AAC encoder.
 *
 * `onChunk(bytes, durationSamples)` receives each access unit. Encoding is
 * asynchronous inside the platform encoder, so `finish()` is what guarantees
 * every frame has been handed over - returning before it resolves would
 * truncate the file by however deep the queue happened to be.
 */
export function createAacEncoder({ config, channels = 2, onChunk, onDescription = () => {} }) {
  const { sampleRate } = config;
  let framesSubmitted = 0;
  let failure = null;
  let closed = false;
  let described = false;

  // Resolver for whoever is parked in `drainTo`. The encoder stops emitting
  // `dequeue` the moment it closes on an error, so the error path has to wake
  // the waiter itself or the export hangs with no error and no file.
  let wakeDrain = null;
  const wake = () => {
    if (!wakeDrain) return;
    const resolve = wakeDrain;
    wakeDrain = null;
    resolve();
  };

  const encoder = new globalThis.AudioEncoder({
    output: (chunk, metadata) => {
      // The encoder states its own decoder configuration once, on the first
      // chunk. It is authoritative: it also describes any tool-specific choice
      // the encoder made that a rebuilt config would not know about.
      if (!described) {
        const description = toBytes(metadata?.decoderConfig?.description);
        if (description) {
          described = true;
          onDescription(description);
        }
      }

      const payload = new Uint8Array(chunk.byteLength);
      chunk.copyTo(payload);
      // `duration` is microseconds; the muxer counts in samples.
      const durationSamples = chunk.duration ? Math.round((chunk.duration * sampleRate) / 1e6) : 0;
      onChunk(payload, durationSamples);
    },
    error: (err) => {
      failure = err;
      wake();
    },
  });
  encoder.configure(config);

  /**
   * The encoder queue is the one place an export can outrun its own output.
   * Waiting on `dequeue` keeps the backlog bounded without a polling timer.
   */
  async function drainTo(depth) {
    while (!failure && encoder.encodeQueueSize > depth) {
      await new Promise((resolve) => {
        wakeDrain = resolve;
        encoder.addEventListener('dequeue', wake, { once: true });
      });
    }
    // Surface the failure on the call that was waiting, rather than leaving it
    // for whichever later call happens to check first.
    if (failure) throw failure;
  }

  return {
    get sampleRate() {
      return sampleRate;
    },
    /** @param {Float32Array[]} planes one per channel, equal length. */
    async encode(planes) {
      if (failure) throw failure;
      const numberOfFrames = planes[0]?.length || 0;
      if (numberOfFrames === 0) return;

      // `f32-planar` wants every channel end to end in one allocation.
      const planar = new Float32Array(numberOfFrames * channels);
      for (let channel = 0; channel < channels; channel++) {
        planar.set(planes[channel], channel * numberOfFrames);
      }

      const data = new globalThis.AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames,
        numberOfChannels: channels,
        timestamp: Math.round((framesSubmitted / sampleRate) * 1e6),
        data: planar,
      });

      try {
        encoder.encode(data);
      } finally {
        data.close();
      }

      framesSubmitted += numberOfFrames;
      await drainTo(8);
    },
    async finish() {
      if (failure) throw failure;
      await encoder.flush();
      if (failure) throw failure;
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        encoder.close();
      } catch (_err) {
        // Already closed by an error callback.
      }
    },
  };
}
