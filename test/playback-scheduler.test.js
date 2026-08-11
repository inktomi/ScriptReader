import test from 'node:test';
import assert from 'node:assert/strict';

class AudioParamStub {
  constructor(value = 0) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  cancelScheduledValues() {}
}

class AudioNodeStub {
  constructor() { this.connections = []; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() {}
}

class AudioContextStub {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new AudioNodeStub();
  }

  createGain() {
    const node = new AudioNodeStub();
    node.gain = new AudioParamStub(1);
    return node;
  }

  createDynamicsCompressor() {
    const node = new AudioNodeStub();
    node.threshold = new AudioParamStub();
    node.knee = new AudioParamStub();
    node.ratio = new AudioParamStub();
    node.attack = new AudioParamStub();
    node.release = new AudioParamStub();
    return node;
  }

  createAnalyser() { return new AudioNodeStub(); }

  createStereoPanner() {
    const node = new AudioNodeStub();
    node.pan = new AudioParamStub();
    return node;
  }
}

test('overlap mix keeps headroom and limits the destination bus', async () => {
  globalThis.window = { AudioContext: AudioContextStub };
  const { PlaybackScheduler } = await import('../src/audio/playback-scheduler.js');
  const scheduler = new PlaybackScheduler();

  assert.equal(scheduler.master.gain.value, 0.76);
  assert.equal(scheduler.limiter.ratio.value, 20);
  assert.equal(scheduler.master.connections[0], scheduler.limiter);
  assert.equal(scheduler.limiter.connections[0], scheduler.analyser);

  const source = new AudioNodeStub();
  const { gainNode } = scheduler._buildChain({ gain: 1, pan: 0, filter: null }, source);
  assert.equal(gainNode.gain.value, 1);
});
