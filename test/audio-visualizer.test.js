import test from 'node:test';
import assert from 'node:assert/strict';

import { AudioVisualizer } from '../src/audio/audio-visualizer.js';
import { installDom, removeDom } from './dom-helpers.js';

function createMockCanvas(width = 118, height = 24, dpr = 2) {
  const drawnRects = [];
  const drawnRoundRects = [];
  const fillStyles = [];
  let currentTransform = [1, 0, 0, 1, 0, 0];

  const ctx = {
    fillStyle: '#000000',
    clearRect(x, y, w, h) {},
    beginPath() {},
    fill() {},
    fillRect(x, y, w, h) {
      fillStyles.push(this.fillStyle);
      drawnRects.push({ x, y, w, h, fillStyle: this.fillStyle });
    },
    roundRect(x, y, w, h, r) {
      fillStyles.push(this.fillStyle);
      drawnRoundRects.push({ x, y, w, h, r, fillStyle: this.fillStyle });
    },
    setTransform(a, b, c, d, e, f) {
      currentTransform = [a, b, c, d, e, f];
    },
    scale(sx, sy) {}
  };

  const canvas = {
    width: 0,
    height: 0,
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect() {
      return { width, height, top: 0, left: 0, right: width, bottom: height };
    },
    getContext(type) {
      if (type === '2d') return ctx;
      return null;
    }
  };

  return {
    canvas,
    ctx,
    drawnRects,
    drawnRoundRects,
    fillStyles,
    getTransform: () => currentTransform
  };
}

test('AudioVisualizer handles initial hidden state and resizes with devicePixelRatio', () => {
  const dom = installDom();
  globalThis.window.devicePixelRatio = 2;

  try {
    // Hidden initially (width = 0, height = 0)
    const mockHidden = createMockCanvas(0, 0, 2);
    const viz = new AudioVisualizer(mockHidden.canvas);

    // Hidden canvas should not crash or bake in stale fallback dimensions
    assert.equal(mockHidden.canvas.width, 0);
    assert.equal(mockHidden.canvas.height, 0);

    // Now layout settles and dimensions become 118x24
    mockHidden.canvas.clientWidth = 118;
    mockHidden.canvas.clientHeight = 24;
    mockHidden.canvas.getBoundingClientRect = () => ({
      width: 118,
      height: 24,
      top: 0,
      left: 0,
      right: 118,
      bottom: 24
    });

    const resized = viz.resizeCanvas();
    assert.equal(resized, true);
    assert.equal(mockHidden.canvas.width, 236); // 118 * 2
    assert.equal(mockHidden.canvas.height, 48); // 24 * 2
    assert.deepEqual(mockHidden.getTransform(), [2, 0, 0, 2, 0, 0]);

    viz.destroy();
  } finally {
    removeDom(dom);
  }
});

test('barCountFor and renderMeter fill the full width and height of the canvas', () => {
  const dom = installDom();
  globalThis.window.devicePixelRatio = 2;

  try {
    const mock = createMockCanvas(118, 24, 2);
    const viz = new AudioVisualizer(mock.canvas);

    const barCount = viz.barCountFor(118);
    assert.equal(barCount, 22);

    mock.drawnRoundRects.length = 0;
    viz.renderMeter(118, 24, 0.5, 0.5);

    // 2 rows * 22 segments = 44 segments drawn
    assert.equal(mock.drawnRoundRects.length, 44);

    const row0 = mock.drawnRoundRects.filter(r => Math.abs(r.y - 2.5) < 0.1);
    const row1 = mock.drawnRoundRects.filter(r => r.y > 10);

    assert.equal(row0.length, 22);
    assert.equal(row1.length, 22);

    // Check that segments span from left margin (3px) to right margin (width - 3px = 115px)
    const firstSegment = row0[0];
    const lastSegment = row0[21];

    assert.equal(firstSegment.x, 3);
    const rightEdge = lastSegment.x + lastSegment.w;
    assert.ok(Math.abs(rightEdge - 115) < 0.01, `Right edge ${rightEdge} should be 115`);

    // Check vertical distribution: both rows have equal height and fill the height
    assert.equal(firstSegment.h, row1[0].h);
    const bottomEdge = row1[0].y + row1[0].h;
    assert.ok(bottomEdge <= 24 - 2.5 + 0.01, `Bottom edge ${bottomEdge} should fit in canvas`);

    viz.destroy();
  } finally {
    removeDom(dom);
  }
});

test('renderIdle renders all segments as inactive without any spurious lit bars', () => {
  const dom = installDom();
  globalThis.window.devicePixelRatio = 1;

  try {
    const mock = createMockCanvas(118, 24, 1);
    const viz = new AudioVisualizer(mock.canvas);

    mock.drawnRoundRects.length = 0;
    viz.renderIdle();

    assert.equal(mock.drawnRoundRects.length, 44);
    // Every single segment must have inactive dim style, none green or gold
    const allInactive = mock.drawnRoundRects.every(
      r => r.fillStyle === 'rgba(167, 160, 149, 0.18)'
    );
    assert.equal(allInactive, true);

    viz.destroy();
  } finally {
    removeDom(dom);
  }
});

test('renderMeter lights active segments with secondary (green) and accent (gold) for peaks', () => {
  const dom = installDom();
  globalThis.window.devicePixelRatio = 1;

  try {
    const mock = createMockCanvas(118, 24, 1);
    const viz = new AudioVisualizer(mock.canvas);

    mock.drawnRoundRects.length = 0;
    // 90% level should light up green for low/mid and gold for high/peak segments
    viz.renderMeter(118, 24, 0.9, 0);

    const row0 = mock.drawnRoundRects.slice(0, 22);
    const row1 = mock.drawnRoundRects.slice(22);

    // Row 0 (left channel at 0.9 = 20 active out of 22)
    const activeRow0 = row0.filter(r => r.fillStyle !== 'rgba(167, 160, 149, 0.18)');
    assert.equal(activeRow0.length, 20);

    const greenSegments = activeRow0.filter(r => r.fillStyle === '#78977B');
    const goldSegments = activeRow0.filter(r => r.fillStyle === '#C6A466');

    assert.ok(greenSegments.length > 0, 'Should have green segments');
    assert.ok(goldSegments.length > 0, 'Should have gold peak segments');

    // Row 1 (right channel at 0) should be all inactive
    const activeRow1 = row1.filter(r => r.fillStyle !== 'rgba(167, 160, 149, 0.18)');
    assert.equal(activeRow1.length, 0);

    viz.destroy();
  } finally {
    removeDom(dom);
  }
});

test('AudioVisualizer lifecycle cleans up animation frame and observers on stop/destroy', () => {
  const dom = installDom();

  try {
    let animCallback = null;
    let animIdSeq = 1;
    globalThis.window.requestAnimationFrame = (cb) => {
      animCallback = cb;
      return animIdSeq++;
    };
    let cancelledId = null;
    globalThis.window.cancelAnimationFrame = (id) => {
      cancelledId = id;
    };

    const mock = createMockCanvas(118, 24, 1);
    const viz = new AudioVisualizer(mock.canvas);

    // Initial state is idle
    assert.equal(viz.isPlaying, false);

    // Start speaking
    viz.setSpeaking(true);
    assert.equal(viz.isPlaying, true);

    // Stop speaking
    viz.stop();
    assert.equal(viz.isPlaying, false);
    assert.ok(cancelledId !== null);

    // Destroy
    viz.destroy();
  } finally {
    removeDom(dom);
  }
});
