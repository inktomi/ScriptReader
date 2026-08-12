import test from 'node:test';
import assert from 'node:assert/strict';

import { createTransportBar } from '../src/ui/transport-bar.js';
import { installDom, removeDom } from './dom-helpers.js';

function audioManagerStub() {
  return {
    playbackState: 'idle',
    volume: 1,
    isMuted: false,
    setVolume() {},
    setMuted() {},
    setPacingMode() {},
    setMasterSpeed() {}
  };
}

test('Studio pre-render progress patches the persistent bar and unlocks Play at a safe lead', () => {
  const dom = installDom();
  try {
    const transport = createTransportBar({
      audioManager: audioManagerStub(),
      scriptStore: { currentScript: { elements: [{}] } },
      onPlay() {},
      onPause() {},
      onStop() {},
      onSkipNext() {},
      onSkipPrev() {},
      onSeek() {}
    });
    document.body.appendChild(transport.element);

    transport.updateRenderProgress({
      visible: true,
      active: true,
      canPlay: false,
      percent: 24,
      etaSeconds: 480
    });
    const row = transport.element.querySelector('#transport-render-row');
    const fill = transport.element.querySelector('#transport-render-fill');
    const play = transport.element.querySelector('#btn-transport-play');
    assert.equal(row.hidden, false);
    assert.equal(fill.style.width, '24%');
    assert.equal(play.disabled, true);
    assert.match(row.textContent, /about 8 minutes remaining/);

    transport.updateRenderProgress({
      visible: true,
      active: true,
      canPlay: true,
      percent: 61,
      etaSeconds: 180
    });

    assert.equal(transport.element.querySelector('#transport-render-row'), row);
    assert.equal(transport.element.querySelector('#transport-render-fill'), fill);
    assert.equal(fill.style.width, '61%');
    assert.equal(play.disabled, false);
    assert.match(row.textContent, /Ready to play/);

    play.focus();
    transport.updateRenderProgress({ canPlay: false, percent: 0 });
    assert.equal(document.activeElement, transport.element.querySelector('#btn-transport-prev'));
  } finally {
    removeDom(dom);
  }
});
