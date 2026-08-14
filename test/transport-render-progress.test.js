import assert from 'node:assert/strict';
import test from 'node:test';
import { PLAYBACK_STATES } from '../src/audio/audio-manager.js';
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
    setMasterSpeed() {},
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
      onSeek() {},
    });
    document.body.appendChild(transport.element);

    transport.updateRenderProgress({
      visible: true,
      active: true,
      canPlay: false,
      percent: 24,
      etaSeconds: 480,
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
      etaSeconds: 180,
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

/**
 * `active: false` only means the render loop is not running — a paused or
 * abandoned run is idle too. Reading that alone as "ready" is how a disabled
 * Play button came to sit under the words "Ready for uninterrupted playback".
 */
test('an idle pre-render only claims readiness when playback can actually start', () => {
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
      onSeek() {},
    });
    document.body.appendChild(transport.element);
    const row = transport.element.querySelector('#transport-render-row');
    const play = transport.element.querySelector('#btn-transport-play');

    transport.updateRenderProgress({ visible: true, active: false, canPlay: false, percent: 100 });
    assert.equal(play.disabled, true);
    assert.doesNotMatch(row.textContent, /Ready for uninterrupted playback/);

    transport.updateRenderProgress({ visible: true, active: false, canPlay: true, percent: 100 });
    assert.equal(play.disabled, false);
    assert.match(row.textContent, /Ready for uninterrupted playback/);
  } finally {
    removeDom(dom);
  }
});

/**
 * When paused, scheduled audio is held in place by suspending the audio context.
 * The Play button is the resume control and must stay enabled even if canPlay
 * is false.
 */
test('Play button remains enabled while playback is paused, even if canPlay is false', () => {
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
      onSeek() {},
    });
    document.body.appendChild(transport.element);
    const row = transport.element.querySelector('#transport-render-row');
    const play = transport.element.querySelector('#btn-transport-play');

    transport.updateRenderProgress({ visible: true, active: false, canPlay: false, percent: 50 });
    // In IDLE state with canPlay false, Play is disabled
    assert.equal(play.disabled, true);
    assert.match(row.textContent, /Pre-render paused — not ready yet/);

    // In PAUSED state, Play button acts as resume and must be enabled
    transport.updatePlaybackState(PLAYBACK_STATES.PAUSED);
    transport.updateRenderProgress({ visible: true, active: false, canPlay: false, percent: 50 });
    assert.equal(play.disabled, false);
    assert.match(row.textContent, /Playback paused — press Play to resume/);

    // Transitioning back to IDLE disables it again
    transport.updatePlaybackState(PLAYBACK_STATES.IDLE);
    assert.equal(play.disabled, true);
  } finally {
    removeDom(dom);
  }
});

/**
 * The buffering notice and the scrub percentage used to sit side by side, so
 * "Rendering voices…" and the playhead's "3%" read as one sentence — a render
 * that looked stuck at 3% when it was the position in the script.
 */
test('the buffering notice is not adjacent to the scrub percentage', () => {
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
      onSeek() {},
    });
    document.body.appendChild(transport.element);

    const bufferStatus = transport.element.querySelector('#transport-buffer-status');
    const percent = transport.element.querySelector('#transport-progress-percent');
    assert.notEqual(bufferStatus.nextElementSibling, percent);
    assert.equal(bufferStatus.nextElementSibling.id, 'scrub-track');
  } finally {
    removeDom(dom);
  }
});
