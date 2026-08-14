import test from 'node:test';
import assert from 'node:assert/strict';

import { createHeader } from '../src/ui/header.js';
import { ENGINE_TYPES } from '../src/audio/audio-manager.js';
import { installDom, removeDom } from './dom-helpers.js';

test('header creates library button with active state and toggle handler', () => {
  const dom = installDom();
  try {
    let toggleCount = 0;
    const header = createHeader({
      onChangeScript: () => {},
      onOpenVoiceConfig: () => {},
      onToggleLibrary: () => { toggleCount++; },
      onToggleHelp: () => {},
      onOpenEngineSettings: () => {},
      currentEngine: ENGINE_TYPES.KOKORO_NEURAL
    });
    document.body.appendChild(header.element);

    const btnLibrary = header.element.querySelector('#btn-library');
    assert.ok(btnLibrary, 'Library button should exist in header');
    assert.equal(btnLibrary.getAttribute('aria-expanded'), 'true');
    assert.ok(btnLibrary.classList.contains('btn-active'), 'Library button should be active initially');
    assert.match(btnLibrary.title, /Close library/);

    btnLibrary.click();
    assert.equal(toggleCount, 1, 'Clicking Library button should invoke onToggleLibrary');

    header.setLibraryActive(false);
    assert.equal(btnLibrary.getAttribute('aria-expanded'), 'false');
    assert.equal(btnLibrary.classList.contains('btn-active'), false);
    assert.match(btnLibrary.title, /Open library/);

    header.setLibraryActive(true);
    assert.equal(btnLibrary.getAttribute('aria-expanded'), 'true');
    assert.ok(btnLibrary.classList.contains('btn-active'));
    assert.match(btnLibrary.title, /Close library/);
  } finally {
    removeDom(dom);
  }
});

test('header falls back to onShowLibrary when onToggleLibrary is omitted', () => {
  const dom = installDom();
  try {
    const shownTabs = [];
    const header = createHeader({
      onChangeScript: () => {},
      onOpenVoiceConfig: () => {},
      onShowLibrary: tab => shownTabs.push(tab),
      onToggleHelp: () => {},
      onOpenEngineSettings: () => {},
      currentEngine: ENGINE_TYPES.KOKORO_NEURAL
    });
    document.body.appendChild(header.element);

    const btnLibrary = header.element.querySelector('#btn-library');
    btnLibrary.click();
    assert.deepEqual(shownTabs, ['cast']);
  } finally {
    removeDom(dom);
  }
});

test('header updates script info and engine badge correctly', () => {
  const dom = installDom();
  try {
    const header = createHeader({
      onChangeScript: () => {},
      onOpenVoiceConfig: () => {},
      onToggleHelp: () => {},
      onOpenEngineSettings: () => {},
      currentEngine: ENGINE_TYPES.KOKORO_NEURAL
    });
    document.body.appendChild(header.element);

    header.setScript({
      title: 'Hamlet',
      scenes: [1, 2, 3],
      characters: ['Hamlet', 'Ophelia']
    });

    assert.equal(header.element.querySelector('#header-script-title').textContent, 'Hamlet');
    assert.equal(header.element.querySelector('#header-script-detail').textContent, '3 scenes · 2 speaking roles');

    header.setEngineBadge(ENGINE_TYPES.OPENAI);
    assert.equal(header.element.querySelector('#engine-badge-text').textContent, 'Cloud voices');

    header.setEngineBadge(ENGINE_TYPES.KOKORO_NEURAL);
    assert.equal(header.element.querySelector('#engine-badge-text').textContent, 'Local voices');
  } finally {
    removeDom(dom);
  }
});

