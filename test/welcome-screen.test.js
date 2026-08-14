import assert from 'node:assert/strict';
import test from 'node:test';
import { ENGINE_IDS } from '../src/audio/engine-contract.js';
import { SAMPLE_SCRIPTS } from '../src/screenplay/sample-scripts.js';
import { createVoiceConfigModal } from '../src/ui/voice-config-modal.js';
import { createWelcomeScreen } from '../src/ui/welcome-screen.js';
import { installDom, removeDom } from './dom-helpers.js';

test('fresh welcome screen leads with import and sample choices', () => {
  const dom = installDom();
  try {
    const selected = [];
    const screen = createWelcomeScreen({
      onFileSelected: () => {},
      onPasteSubmitted: () => {},
      onSelectSample: (id) => selected.push(id),
      onContinueRecent: () => {},
      onOpenHelp: () => {},
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
        elements: [{ type: 'DIALOGUE', character: 'MARA', text: 'We should listen.' }],
      },
      castAssignments: new Map(),
      getNarratorVoice: () => 'bf_emma',
      updateCast() {
        saved = true;
      },
    };
    const audioManager = {
      engineId: ENGINE_IDS.KOKORO,
      capabilities: { supportsInstructions: false },
      getVoiceProfileForCharacter: () => ({ id: 'bf_emma' }),
      stop() {},
      setNarratorVoice() {},
      setVoiceAssignment() {},
    };
    const casting = createVoiceConfigModal({
      scriptStore,
      audioManager,
      isInitialSetup: true,
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

test('a character introduction expands in place, keeping focus and the audition running', () => {
  const dom = installDom();
  try {
    const introduction = {
      text: '50s, nervous housekeeper, trembling hands',
      age: '50s',
      sourceText: 'MRS. HIGGINS (50s, nervous housekeeper, trembling hands) sets down a silver tea tray.',
      elementId: 'line-6',
      form: 'parenthetical',
    };
    const scriptStore = {
      currentScript: {
        title: 'Manor',
        characters: [{ name: 'MRS. HIGGINS', lineCount: 3, sampleLine: 'Tea, sir?', introduction }],
        elements: [{ type: 'DIALOGUE', character: 'MRS. HIGGINS', text: 'Tea, sir?' }],
      },
      castAssignments: new Map(),
      getNarratorVoice: () => 'bf_emma',
      updateCast() {},
    };
    const audioManager = {
      engineId: ENGINE_IDS.KOKORO,
      capabilities: { supportsInstructions: false },
      getVoiceProfileForCharacter: () => ({ id: 'bf_emma' }),
      stop() {},
      setNarratorVoice() {},
      setVoiceAssignment() {},
    };

    const casting = createVoiceConfigModal({ scriptStore, audioManager });
    document.body.appendChild(casting);

    assert.equal(casting.querySelector('.badge-age').textContent.trim(), '50s');
    assert.match(casting.querySelector('.char-intro-text').textContent, /nervous housekeeper/);

    const toggle = casting.querySelector('.char-intro-toggle');
    const source = casting.querySelector('.char-intro-source');
    assert.equal(source.hidden, true);

    toggle.focus();
    toggle.click();

    // Expanding must not rebuild the card: the same nodes stay in the document,
    // so focus never leaves the control the user is operating.
    assert.equal(source.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(casting.querySelector('.char-intro-toggle'), toggle);
    assert.equal(document.activeElement, toggle);
    assert.match(source.textContent, /sets down a silver tea tray/);

    // A later full re-render — triggered here by changing a voice — restores it.
    const select = casting.querySelector('.modal-char-select');
    select.value = 'af_bella';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(casting.querySelector('.char-intro-source').hidden, false);
    assert.equal(casting.querySelector('.char-intro-toggle').getAttribute('aria-expanded'), 'true');
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
      onPasteSubmitted: (text, title) => {
        pasted = { text, title };
      },
      onSelectSample: () => {},
      onContinueRecent: () => {
        continued = true;
      },
      onOpenHelp: () => {},
    });
    document.body.appendChild(screen);

    assert.match(screen.querySelector('.recent-section').textContent, /Quiet Draft/);
    screen.querySelector('#welcome-continue').click();
    assert.equal(continued, true);

    screen.querySelector('#welcome-paste-toggle').click();
    screen.querySelector('#welcome-paste-title').value = 'My Draft';
    screen.querySelector('#welcome-paste-text').value = 'INT. ROOM - DAY';
    screen.querySelector('#welcome-paste-panel').dispatchEvent(
      new dom.window.Event('submit', {
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.deepEqual(pasted, { text: 'INT. ROOM - DAY', title: 'My Draft' });
  } finally {
    removeDom(dom);
  }
});

test('casting screen preserves scroll position and focus when selecting a voice', () => {
  const dom = installDom();
  try {
    const characters = [
      { name: 'ALICE', lineCount: 10, sampleLine: 'Hello Alice here.' },
      { name: 'BOB', lineCount: 8, sampleLine: 'Hello Bob here.' },
      { name: 'CHARLIE', lineCount: 6, sampleLine: 'Charlie speaking.' },
      { name: 'DIANA', lineCount: 4, sampleLine: 'Diana reporting in.' },
    ];
    const scriptStore = {
      currentScript: {
        title: 'Cast Test Screenplay',
        characters,
        elements: characters.map((c) => ({ type: 'DIALOGUE', character: c.name, text: c.sampleLine })),
      },
      castAssignments: new Map(),
      getNarratorVoice: () => 'af_heart',
      updateCast() {},
    };
    const audioManager = {
      engineId: ENGINE_IDS.KOKORO,
      capabilities: { supportsInstructions: true },
      getVoiceProfileForCharacter: () => ({ id: 'af_heart', name: 'Heart', avatarBg: '#333' }),
      stop() {},
      setNarratorVoice() {},
      setVoiceAssignment() {},
      prewarmAudition() {},
      async previewVoice(_voiceId, _text, _pitch, _speed, _direction, _engine, onStateChange) {
        onStateChange?.('preparing');
        onStateChange?.('rendering');
        onStateChange?.('playing');
        onStateChange?.('idle');
      },
    };

    const casting = createVoiceConfigModal({
      scriptStore,
      audioManager,
      isInitialSetup: true,
    });
    document.body.appendChild(casting);

    // Switch to detailed mode
    casting.querySelector('#casting-path-custom').click();

    const scrollContainer = casting.querySelector('.voice-config-body');
    assert.ok(scrollContainer, 'scroll container should exist');

    // Simulate scrolling down to Charlie
    scrollContainer.scrollTop = 420;

    const charlieSelect = casting.querySelector('.modal-char-select[data-char="CHARLIE"]');
    assert.ok(charlieSelect, 'CHARLIE select dropdown should exist');

    charlieSelect.focus();
    assert.equal(document.activeElement, charlieSelect);

    // Change Charlie's voice
    charlieSelect.value = 'am_adam';
    charlieSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    // Verify scroll position is preserved
    const updatedScrollContainer = casting.querySelector('.voice-config-body');
    assert.equal(updatedScrollContainer.scrollTop, 420);

    // Verify focus is preserved on Charlie's select dropdown
    const updatedCharlieSelect = casting.querySelector('.modal-char-select[data-char="CHARLIE"]');
    assert.equal(document.activeElement, updatedCharlieSelect);
    assert.notEqual(document.activeElement, document.body);
  } finally {
    removeDom(dom);
  }
});

test('casting modal preserves scroll position, focus, and open details across tone presets and auditions', async () => {
  const dom = installDom();
  try {
    const characters = [
      { name: 'ALICE', lineCount: 10, sampleLine: 'Hello Alice here.' },
      { name: 'BOB', lineCount: 8, sampleLine: 'Hello Bob here.' },
    ];
    let auditionCalls = 0;
    const scriptStore = {
      currentScript: {
        title: 'Cast Audition Test',
        characters,
        elements: characters.map((c) => ({ type: 'DIALOGUE', character: c.name, text: c.sampleLine })),
      },
      castAssignments: new Map(),
      getNarratorVoice: () => 'af_heart',
      updateCast() {},
    };
    const audioManager = {
      engineId: ENGINE_IDS.KOKORO,
      capabilities: { supportsInstructions: true },
      getVoiceProfileForCharacter: () => ({ id: 'af_heart', name: 'Heart', avatarBg: '#333' }),
      stop() {},
      setNarratorVoice() {},
      setVoiceAssignment() {},
      prewarmAudition() {},
      async previewVoice(_voiceId, _text, _pitch, _speed, _direction, _engine, onStateChange) {
        auditionCalls++;
        onStateChange?.('rendering');
        onStateChange?.('playing');
      },
    };

    const casting = createVoiceConfigModal({
      scriptStore,
      audioManager,
      isInitialSetup: false,
    });
    document.body.appendChild(casting);

    const scrollContainer = casting.querySelector('.voice-config-body');
    scrollContainer.scrollTop = 250;

    // Open advanced details on BOB
    const bobCard = casting.querySelector('.voice-card[data-char="BOB"]');
    const bobDetails = bobCard.querySelector('.voice-advanced');
    bobDetails.open = true;
    bobDetails.dispatchEvent(new dom.window.Event('toggle', { bubbles: true }));

    // Click tone preset "Dramatic"
    const dramaticChip = bobCard.querySelector('.btn-tone-chip[data-preset="dramatic"]');
    dramaticChip.focus();
    dramaticChip.click();

    // Verify scroll is preserved, details stay open, and focus stays on dramatic chip
    const updatedScroll = casting.querySelector('.voice-config-body');
    assert.equal(updatedScroll.scrollTop, 250);
    const updatedBobDetails = casting.querySelector('.voice-card[data-char="BOB"] .voice-advanced');
    assert.equal(updatedBobDetails.open, true);
    const updatedDramaticChip = casting.querySelector(
      '.voice-card[data-char="BOB"] .btn-tone-chip[data-preset="dramatic"]',
    );
    assert.equal(document.activeElement, updatedDramaticChip);

    // Audition BOB
    const auditionBtn = casting.querySelector('.voice-card[data-char="BOB"] .btn-audition-char');
    auditionBtn.focus();
    auditionBtn.click();
    await Promise.resolve();

    assert.equal(auditionCalls, 1);
    assert.equal(casting.querySelector('.voice-config-body').scrollTop, 250);
    const updatedAuditionBtn = casting.querySelector('.voice-card[data-char="BOB"] .btn-audition-char');
    assert.equal(document.activeElement, updatedAuditionBtn);
  } finally {
    removeDom(dom);
  }
});

test('casting modal preserves live direction text and handles slider focus without selection errors', () => {
  const dom = installDom();
  try {
    const characters = [{ name: 'ALICE', lineCount: 5, sampleLine: 'Hello from Alice.' }];
    const scriptStore = {
      currentScript: {
        title: 'Direction Input Test',
        characters,
        elements: [{ type: 'DIALOGUE', character: 'ALICE', text: 'Hello from Alice.' }],
      },
      castAssignments: new Map(),
      getNarratorVoice: () => 'af_heart',
      updateCast() {},
    };
    const audioManager = {
      engineId: ENGINE_IDS.KOKORO,
      capabilities: { supportsInstructions: true },
      getVoiceProfileForCharacter: () => ({ id: 'af_heart', name: 'Heart', avatarBg: '#333' }),
      stop() {},
      setNarratorVoice() {},
      setVoiceAssignment() {},
      prewarmAudition() {},
    };

    const casting = createVoiceConfigModal({
      scriptStore,
      audioManager,
      isInitialSetup: false,
    });
    document.body.appendChild(casting);

    // Open advanced controls
    const aliceCard = casting.querySelector('.voice-card[data-char="ALICE"]');
    const details = aliceCard.querySelector('.voice-advanced');
    details.open = true;
    details.dispatchEvent(new dom.window.Event('toggle', { bubbles: true }));

    // User types direction without blurring
    const directionInput = aliceCard.querySelector('.modal-direction-input');
    directionInput.value = 'Warm and friendly, slightly breathless.';
    directionInput.focus();

    // Re-render triggered by voice select change
    const select = casting.querySelector('.modal-char-select[data-char="ALICE"]');
    select.value = 'af_bella';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    // Direction must survive
    const updatedDirection = casting.querySelector('.modal-direction-input[data-char="ALICE"]');
    assert.equal(updatedDirection.value, 'Warm and friendly, slightly breathless.');
    assert.equal(document.activeElement, updatedDirection);

    // Focus range slider and trigger another render
    const slider = casting.querySelector('.modal-pitch-slider[data-char="ALICE"]');
    slider.focus();
    assert.equal(document.activeElement, slider);

    select.value = 'af_sarah';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

    const updatedSlider = casting.querySelector('.modal-pitch-slider[data-char="ALICE"]');
    assert.equal(document.activeElement, updatedSlider);
  } finally {
    removeDom(dom);
  }
});
