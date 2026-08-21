import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeader } from '../src/ui/header.js';
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

function mountTransport(handlers = {}) {
  const transport = createTransportBar({
    audioManager: audioManagerStub(),
    scriptStore: { currentScript: { elements: [{}] } },
    onPlay() {},
    onPause() {},
    onStop() {},
    onSkipNext() {},
    onSkipPrev() {},
    onSeek() {},
    ...handlers,
  });
  document.body.appendChild(transport.element);
  return transport;
}

const RENDERED = { visible: true, active: false, canPlay: true, percent: 100 };

test('the download affordance appears only once the whole script is rendered', () => {
  const dom = installDom();
  try {
    const transport = mountTransport();
    const download = transport.element.querySelector('#transport-render-download');

    transport.updateRenderProgress({ visible: true, active: true, canPlay: false, percent: 40 });
    assert.equal(download.hidden, true, 'offered a download mid-render');

    transport.updateRenderProgress({ visible: true, active: true, canPlay: true, percent: 92 });
    assert.equal(download.hidden, true, 'offered a download before the bar filled');

    transport.updateRenderProgress(RENDERED);
    assert.equal(download.hidden, false, 'a finished pre-render should offer the file');
  } finally {
    removeDom(dom);
  }
});

test('a stopped pre-render does not offer a file it never finished', () => {
  const dom = installDom();
  try {
    const transport = mountTransport();
    const download = transport.element.querySelector('#transport-render-download');

    transport.updateRenderProgress({ ...RENDERED, error: 'Studio Local ran out of storage.' });
    assert.equal(download.hidden, true);
  } finally {
    removeDom(dom);
  }
});

test('engines with no pre-render bar keep the affordance out of the hidden row', () => {
  const dom = installDom();
  try {
    const transport = mountTransport();
    transport.updateRenderProgress(RENDERED);
    transport.updateRenderProgress({ visible: false });

    assert.equal(transport.element.querySelector('#transport-render-row').hidden, true);
    assert.equal(transport.element.querySelector('#transport-render-download').hidden, true);
  } finally {
    removeDom(dom);
  }
});

test('clicking download reports the request once', () => {
  const dom = installDom();
  try {
    let exports = 0;
    let cancels = 0;
    const transport = mountTransport({
      onExport: () => {
        exports++;
      },
      onCancelExport: () => {
        cancels++;
      },
    });
    transport.updateRenderProgress(RENDERED);

    transport.element.querySelector('#transport-render-download').click();
    assert.equal(exports, 1);

    transport.updateExportProgress({ active: true, phase: 'rendering', percent: 3 });
    transport.element.querySelector('#transport-export-cancel').click();
    assert.equal(cancels, 1);
  } finally {
    removeDom(dom);
  }
});

test('the export row reports its own progress without disturbing the pre-render bar', () => {
  const dom = installDom();
  try {
    const transport = mountTransport();
    transport.updateRenderProgress(RENDERED);

    const exportRow = transport.element.querySelector('#transport-export-row');
    const exportFill = transport.element.querySelector('#transport-export-fill');
    const renderFill = transport.element.querySelector('#transport-render-fill');
    assert.equal(exportRow.hidden, true);

    transport.updateExportProgress({ active: true, phase: 'rendering', percent: 37, etaSeconds: 300 });
    assert.equal(exportRow.hidden, false);
    assert.equal(exportFill.style.width, '37%');
    assert.match(exportRow.textContent, /Rendering the read/);
    assert.match(exportRow.textContent, /about 5 minutes remaining/);

    // The pre-render bar still says what it said; two bars, two meanings.
    assert.equal(renderFill.style.width, '100%');
    assert.match(transport.element.querySelector('#transport-render-label').textContent, /100%/);

    transport.updateExportProgress({ active: true, phase: 'saving', percent: 100 });
    assert.match(exportRow.textContent, /Saving the file/);
  } finally {
    removeDom(dom);
  }
});

test('an export takes the download affordance away and gives it back when it ends', () => {
  const dom = installDom();
  try {
    const transport = mountTransport();
    const download = transport.element.querySelector('#transport-render-download');
    transport.updateRenderProgress(RENDERED);
    assert.equal(download.hidden, false);

    transport.updateExportProgress({ active: true, phase: 'rendering', percent: 10 });
    assert.equal(download.hidden, true, 'two ways to start the same export at once');

    transport.updateExportProgress({ active: false, phase: 'done' });
    assert.equal(download.hidden, false);
  } finally {
    removeDom(dom);
  }
});

test('focus follows the control that replaces the one it was on', () => {
  const dom = installDom();
  try {
    const transport = mountTransport();
    const download = transport.element.querySelector('#transport-render-download');
    const cancel = transport.element.querySelector('#transport-export-cancel');
    transport.updateRenderProgress(RENDERED);

    download.focus();
    assert.equal(document.activeElement, download);

    transport.updateExportProgress({ active: true, phase: 'rendering', percent: 1 });
    assert.equal(document.activeElement, cancel, 'focus fell off the disabled download button');

    transport.updateExportProgress({ active: false, phase: 'done' });
    assert.equal(document.activeElement, download, 'focus never came back from the closed row');
  } finally {
    removeDom(dom);
  }
});

test('a failed export says why where the listener was already looking', () => {
  const dom = installDom();
  try {
    const transport = mountTransport();
    transport.updateRenderProgress(RENDERED);
    transport.updateExportProgress({ active: true, phase: 'rendering', percent: 12 });
    transport.updateExportProgress({ active: false, error: 'The voice engine stopped.' });

    assert.equal(transport.element.querySelector('#transport-export-row').hidden, true);
    assert.match(transport.element.querySelector('#transport-render-detail').textContent, /voice engine stopped/);
  } finally {
    removeDom(dom);
  }
});

// ------------------------------------------------------------------- header

function mountHeader(handlers = {}) {
  const header = createHeader({
    onChangeScript() {},
    onOpenVoiceConfig() {},
    onToggleLibrary() {},
    onShowLibrary() {},
    onToggleHelp() {},
    onOpenEngineSettings() {},
    ...handlers,
  });
  document.body.appendChild(header.element);
  return header;
}

test('the header download button explains itself when it cannot be used', () => {
  const dom = installDom();
  try {
    const header = mountHeader();
    const btn = header.element.querySelector('#btn-export-audio');
    assert.equal(btn.disabled, true, 'export should start unavailable');

    header.setExportState({ blockedReason: 'Load a screenplay first.' });
    assert.equal(btn.disabled, true);
    assert.equal(btn.title, 'Load a screenplay first.');

    header.setExportState({ blockedReason: null });
    assert.equal(btn.disabled, false);
    assert.match(btn.title, /Download the whole read/);

    header.setExportState({ blockedReason: null, exporting: true });
    assert.equal(btn.disabled, true);
    assert.match(btn.title, /Rendering the read/);
  } finally {
    removeDom(dom);
  }
});

test('the header hands focus on rather than dropping it to the body', () => {
  const dom = installDom();
  try {
    const header = mountHeader();
    const btn = header.element.querySelector('#btn-export-audio');
    header.setExportState({ blockedReason: null });

    btn.focus();
    assert.equal(document.activeElement, btn);

    header.setExportState({ blockedReason: null, exporting: true });
    assert.equal(document.activeElement, header.element.querySelector('#btn-voice-setup'));
  } finally {
    removeDom(dom);
  }
});

test('the header only exports when it is allowed to', () => {
  const dom = installDom();
  try {
    let calls = 0;
    const header = mountHeader({
      onExportAudio: () => {
        calls++;
      },
    });
    const btn = header.element.querySelector('#btn-export-audio');

    btn.click();
    assert.equal(calls, 0, 'a disabled button started an export');

    header.setExportState({ blockedReason: null });
    btn.click();
    assert.equal(calls, 1);
  } finally {
    removeDom(dom);
  }
});

test('focus never lands on a disabled Play button when the export row closes', () => {
  const dom = installDom();
  try {
    const transport = mountTransport();
    const cancel = transport.element.querySelector('#transport-export-cancel');
    const play = transport.element.querySelector('#btn-transport-play');
    const prev = transport.element.querySelector('#btn-transport-prev');

    // Mid pre-render: Play is disabled and there is no download affordance yet,
    // so neither of the usual hand-off targets can take focus.
    transport.updateRenderProgress({ visible: true, active: true, canPlay: false, percent: 30 });
    transport.updateExportProgress({ active: true, phase: 'rendering', percent: 5 });
    assert.equal(play.disabled, true);

    cancel.focus();
    assert.equal(document.activeElement, cancel);

    transport.updateExportProgress({ active: false, phase: 'idle' });
    assert.notEqual(document.activeElement, document.body, 'focus fell through to the body');
    assert.equal(document.activeElement, prev);
  } finally {
    removeDom(dom);
  }
});

test('hiding the download affordance while focused still parks focus somewhere usable', () => {
  const dom = installDom();
  try {
    const transport = mountTransport();
    const download = transport.element.querySelector('#transport-render-download');
    const play = transport.element.querySelector('#btn-transport-play');

    transport.updateRenderProgress(RENDERED);
    download.focus();
    assert.equal(document.activeElement, download);

    // A cast edit reopens the pre-render, taking the affordance away.
    transport.updateRenderProgress({ visible: true, active: true, canPlay: true, percent: 10 });
    assert.equal(download.hidden, true);
    assert.equal(document.activeElement, play);
    assert.notEqual(document.activeElement, document.body);
  } finally {
    removeDom(dom);
  }
});

test('the header hands focus to a control that survives a narrow viewport', () => {
  const dom = installDom();
  try {
    const header = mountHeader();
    const btn = header.element.querySelector('#btn-export-audio');
    const cast = header.element.querySelector('#btn-voice-setup');
    header.setExportState({ blockedReason: null });

    // Under 760px the stylesheet sets `.header-actions .btn-secondary` to
    // display:none, and focusing a hidden element drops the caret to the body.
    cast.style.display = 'none';
    btn.focus();
    header.setExportState({ blockedReason: null, exporting: true });

    assert.notEqual(document.activeElement, document.body, 'focus fell through to the body');
    assert.equal(document.activeElement, header.element.querySelector('#btn-library'));
  } finally {
    removeDom(dom);
  }
});
