import test from 'node:test';
import assert from 'node:assert/strict';

import { createWelcomeScreen } from '../src/ui/welcome-screen.js';
import { createVoiceConfigModal } from '../src/ui/voice-config-modal.js';
import { SAMPLE_SCRIPTS } from '../src/screenplay/sample-scripts.js';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';
import { installDom, removeDom } from './dom-helpers.js';

test('fresh welcome screen leads with import and sample choices', () => {
  const dom = installDom();
  try {
    const selected = [];
    const screen = createWelcomeScreen({
      onFileSelected: () => {},
      onPasteSubmitted: () => {},
      onSelectSample: id => selected.push(id),
      onContinueRecent: () => {},
      onOpenHelp: () => {}
    });
    document.body.appendChild(screen);

    assert.match(screen.querySelector('h1').textContent, /Hear your screenplay performed/);
    assert.equal(screen.querySelectorAll('[data-sample-id]').length, SAMPLE_SCRIPTS.length);
    assert.equal(screen.querySelector('#welcome-continue'), null);

    screen.querySelector('[data-sample-id]').click();
    assert.deepEqual(selected, [SAMPLE_SCRIPTS[0].id]);
  } finally {
    removeDom(dom);
  }
});

test('initial casting requires a quick or detailed path before opening the player', () => {
  const dom = installDom();
  try {
    let saved = false;
    const scriptStore = {
      currentScript: {
        title: 'Quiet Draft',
        characters: [{ name: 'MARA', lineCount: 3, sampleLine: 'We should listen.' }],
        elements: [{ type: 'DIALOGUE', character: 'MARA', text: 'We should listen.' }]
      },
      castAssignments: new Map(),
      getNarratorVoice: () => 'bf_emma',
      updateCast() { saved = true; }
    };
    const audioManager = {
      engineId: ENGINE_IDS.KOKORO,
      capabilities: { supportsInstructions: false },
      getVoiceProfileForCharacter: () => ({ id: 'bf_emma' }),
      stop() {},
      setNarratorVoice() {},
      setVoiceAssignment() {}
    };
    const casting = createVoiceConfigModal({
      scriptStore,
      audioManager,
      isInitialSetup: true
    });
    document.body.appendChild(casting);

    assert.equal(casting.classList.contains('casting-screen'), true);
    assert.equal(casting.querySelector('#btn-modal-save').disabled, true);
    casting.querySelector('#casting-path-recommended').click();
    assert.equal(casting.querySelector('#btn-modal-save').disabled, false);
    assert.equal(casting.querySelectorAll('.voice-card').length, 2);
    casting.querySelector('#btn-modal-save').click();
    assert.equal(saved, true);
  } finally {
    removeDom(dom);
  }
});

test('welcome screen exposes recent progress and the paste workflow', () => {
  const dom = installDom();
  try {
    let continued = false;
    let pasted = null;
    const screen = createWelcomeScreen({
      recentScript: { title: 'Quiet Draft', detail: 'Imported screenplay · saved at line 42' },
      onFileSelected: () => {},
      onPasteSubmitted: (text, title) => { pasted = { text, title }; },
      onSelectSample: () => {},
      onContinueRecent: () => { continued = true; },
      onOpenHelp: () => {}
    });
    document.body.appendChild(screen);

    assert.match(screen.querySelector('.recent-section').textContent, /Quiet Draft/);
    screen.querySelector('#welcome-continue').click();
    assert.equal(continued, true);

    screen.querySelector('#welcome-paste-toggle').click();
    screen.querySelector('#welcome-paste-title').value = 'My Draft';
    screen.querySelector('#welcome-paste-text').value = 'INT. ROOM - DAY';
    screen.querySelector('#welcome-paste-panel').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));
    assert.deepEqual(pasted, { text: 'INT. ROOM - DAY', title: 'My Draft' });
  } finally {
    removeDom(dom);
  }
});
