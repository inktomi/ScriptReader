import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVoiceSampleSearchUrl,
  downloadVoiceSample,
  normalizeSharedVoice,
  searchVoiceSamples,
  voiceSampleQualityLabel
} from '../src/audio/voice-sample-catalog.js';
import { createVoiceSampleCatalogModal } from '../src/ui/voice-sample-catalog-modal.js';
import { installDom, removeDom } from './dom-helpers.js';

const rawVoice = {
  public_owner_id: 'owner-1',
  voice_id: 'voice-1',
  name: 'Maya',
  accent: 'american',
  gender: 'Female',
  age: 'middle_aged',
  descriptive: 'warm',
  use_case: 'characters_animation',
  category: 'professional',
  usage_character_count_1y: 250_000,
  cloned_by_count: 120,
  language: 'en',
  description: 'A warm, restrained dramatic performance.',
  preview_url: 'https://cdn.example.test/maya.mp3',
  verified_languages: [{
    language: 'en',
    locale: 'en-US',
    accent: 'american',
    preview_url: 'https://cdn.example.test/maya.mp3'
  }]
};

function nextTurn() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('voice catalog requests popular professional voices with the selected attributes', () => {
  const url = new URL(buildVoiceSampleSearchUrl({
    query: 'warm narrator',
    gender: 'female',
    age: 'middle_aged',
    accent: 'british',
    language: 'en',
    page: 2,
    pageSize: 40
  }));

  assert.equal(url.origin, 'https://api.elevenlabs.io');
  assert.equal(url.searchParams.get('search'), 'warm narrator');
  assert.equal(url.searchParams.get('gender'), 'female');
  assert.equal(url.searchParams.get('age'), 'middle_aged');
  assert.equal(url.searchParams.get('accent'), 'british');
  assert.equal(url.searchParams.get('language'), 'en');
  assert.equal(url.searchParams.has('category'), false, 'all quality categories must be searchable');
  assert.equal(url.searchParams.get('sort'), 'usage_character_count_1y');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('page_size'), '40');
});

test('shared voice metadata becomes casting metadata and an honest quality label', () => {
  const voice = normalizeSharedVoice(rawVoice);
  assert.equal(voice.name, 'Maya');
  assert.equal(voice.gender, 'Female');
  assert.equal(voice.age, 'Middle-aged');
  assert.equal(voice.accent, 'American');
  assert.equal(voice.useCase, 'Characters Animation');
  assert.equal(voiceSampleQualityLabel(voice), 'Verified professional');
  assert.ok(voice.qualityScore > 35);
});

test('multilingual normalization selects the requested preview and keeps unknown genders selectable', () => {
  const voice = normalizeSharedVoice({
    ...rawVoice,
    gender: 'non-binary',
    verified_languages: [
      ...rawVoice.verified_languages,
      { language: 'es', locale: 'es-MX', accent: 'mexican', preview_url: 'https://cdn.example.test/maya-es.mp3' }
    ]
  }, 'es');

  assert.equal(voice.gender, 'Neutral');
  assert.equal(voice.language, 'es');
  assert.equal(voice.locale, 'es-MX');
  assert.equal(voice.accent, 'Mexican');
  assert.equal(voice.previewUrl, 'https://cdn.example.test/maya-es.mp3');
});

test('catalog search drops unusable results and ranks stronger voices first', async () => {
  const categories = [];
  const result = await searchVoiceSamples({}, {
    fetchImpl: async url => {
      categories.push(new URL(url).searchParams.get('category'));
      return ({
      ok: true,
      async json() {
        return {
          voices: [
            { ...rawVoice, voice_id: 'no-preview', preview_url: '', verified_languages: [] },
            { ...rawVoice, voice_id: 'professional', usage_character_count_1y: 10 },
            { ...rawVoice, voice_id: 'top', category: 'high_quality', usage_character_count_1y: 1 }
          ],
          has_more: true,
          total_count: 10_214
        };
      }
      });
    }
  });

  assert.deepEqual(result.voices.map(voice => voice.id), ['top', 'professional']);
  assert.equal(result.hasMore, true);
  assert.deepEqual(categories.sort(), ['high_quality', 'professional']);
  assert.equal(result.totalCount, 20_428);
});

test('voice browser searches, escapes remote metadata, and imports a selected preview', async () => {
  const dom = installDom();
  try {
    const searches = [];
    const added = [];
    const voice = normalizeSharedVoice({
      ...rawVoice,
      name: '<img src=x onerror="window.pwned=1">'
    });
    const catalogClient = {
      async search(filters) {
        searches.push(filters);
        return { voices: [voice], hasMore: false, totalCount: 10_214 };
      },
      async download(selectedVoice) {
        assert.equal(selectedVoice.id, voice.id);
        return new File(['audio'], 'maya.mp3', { type: 'audio/mpeg' });
      }
    };
    const modal = createVoiceSampleCatalogModal({
      catalogClient,
      async onAdd(file, selectedVoice) {
        added.push({ file, selectedVoice });
      }
    });
    document.body.appendChild(modal);
    await nextTurn();

    assert.equal(modal.querySelectorAll('.voice-sample-card').length, 1);
    assert.equal(modal.querySelector('img'), null);
    assert.equal(dom.window.pwned, undefined);
    assert.match(modal.textContent, /10,214 catalog voices/);

    const query = modal.querySelector('#voice-catalog-query');
    query.value = 'quiet detective';
    modal.querySelector('.voice-catalog-search').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));
    await nextTurn();
    assert.equal(searches.at(-1).query, 'quiet detective');

    const addButton = modal.querySelector('.btn-catalog-add');
    addButton.focus();
    addButton.click();
    assert.equal(document.activeElement.classList.contains('btn-catalog-preview'), true);
    await nextTurn();
    assert.equal(added.length, 1);
    assert.equal(added[0].selectedVoice.id, voice.id);
    assert.match(modal.textContent, /ready in your private voice library/);
  } finally {
    removeDom(dom);
  }
});

test('catalog preserves live query text and globally reorders appended quality results', async () => {
  const dom = installDom();
  try {
    let resolveInitial;
    const low = { ...normalizeSharedVoice(rawVoice), id: 'low', qualityScore: 10 };
    const high = { ...normalizeSharedVoice({ ...rawVoice, voice_id: 'high', category: 'high_quality' }), qualityScore: 90 };
    const catalogClient = {
      search(filters) {
        if (filters.page === 0) {
          return new Promise(resolve => { resolveInitial = resolve; });
        }
        return Promise.resolve({ voices: [high], hasMore: false, totalCount: 2 });
      },
      async download() { return new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' }); }
    };
    const modal = createVoiceSampleCatalogModal({ catalogClient });
    document.body.appendChild(modal);
    const query = modal.querySelector('#voice-catalog-query');
    query.focus();
    query.value = 'unfinished thought';
    resolveInitial({ voices: [low], hasMore: true, totalCount: 2 });
    await nextTurn();

    assert.equal(modal.querySelector('#voice-catalog-query').value, 'unfinished thought');
    const grid = modal.querySelector('.voice-sample-grid');
    grid.scrollTop = 73;
    const moreButton = modal.querySelector('.btn-catalog-more');
    moreButton.focus();
    moreButton.click();
    assert.equal(document.activeElement.classList.contains('btn-catalog-more'), true);
    await nextTurn();
    assert.deepEqual([...modal.querySelectorAll('.voice-sample-card')].map(card => card.dataset.voiceId), ['high', 'low']);
    assert.equal(modal.querySelector('.voice-sample-grid').scrollTop, 73);
    assert.equal(document.activeElement, modal.querySelector('#voice-catalog-query'));
  } finally {
    removeDom(dom);
  }
});

test('rapid catalog replacement aborts the old search and ignores its stale completion', async () => {
  const dom = installDom();
  try {
    const oldSearch = deferred();
    const newSearch = deferred();
    const signals = [];
    let calls = 0;
    const initial = { ...normalizeSharedVoice(rawVoice), id: 'initial' };
    const stale = { ...normalizeSharedVoice(rawVoice), id: 'stale', name: 'Stale result' };
    const current = { ...normalizeSharedVoice(rawVoice), id: 'current', name: 'Current result' };
    const catalogClient = {
      search(_filters, { signal }) {
        signals.push(signal);
        calls++;
        if (calls === 1) return Promise.resolve({ voices: [initial], hasMore: false, totalCount: 1 });
        return calls === 2 ? oldSearch.promise : newSearch.promise;
      },
      async download() { return new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' }); }
    };
    const modal = createVoiceSampleCatalogModal({ catalogClient });
    document.body.appendChild(modal);
    await nextTurn();

    let query = modal.querySelector('#voice-catalog-query');
    query.value = 'old request';
    query.focus();
    query.setSelectionRange(4, 11);
    modal.querySelector('.voice-catalog-search').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));
    query = modal.querySelector('#voice-catalog-query');
    assert.equal(document.activeElement, query);
    assert.equal(query.selectionStart, 4);
    assert.equal(query.selectionEnd, 11);

    query.value = 'new request';
    modal.querySelector('.voice-catalog-search').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));
    assert.equal(signals[1].aborted, true);
    newSearch.resolve({ voices: [current], hasMore: false, totalCount: 1 });
    await nextTurn();
    oldSearch.resolve({ voices: [stale], hasMore: false, totalCount: 1 });
    await nextTurn();

    assert.deepEqual([...modal.querySelectorAll('.voice-sample-card')].map(card => card.dataset.voiceId), ['current']);
    assert.equal(modal.querySelector('#voice-catalog-query').value, 'new request');
    assert.equal(modal.querySelector('.voice-catalog-error'), null);
    assert.notEqual(document.activeElement, document.body);
  } finally {
    removeDom(dom);
  }
});

test('a replacement search cannot be overwritten by late pagination', async () => {
  const dom = installDom();
  try {
    const pagination = deferred();
    const replacement = deferred();
    let calls = 0;
    const first = { ...normalizeSharedVoice(rawVoice), id: 'first' };
    const late = { ...normalizeSharedVoice(rawVoice), id: 'late-page' };
    const current = { ...normalizeSharedVoice(rawVoice), id: 'replacement' };
    const catalogClient = {
      search(filters) {
        calls++;
        if (calls === 1) return Promise.resolve({ voices: [first], hasMore: true, totalCount: 3 });
        if (filters.page === 1) return pagination.promise;
        return replacement.promise;
      },
      async download() { return new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' }); }
    };
    const modal = createVoiceSampleCatalogModal({ catalogClient });
    document.body.appendChild(modal);
    await nextTurn();
    modal.querySelector('.btn-catalog-more').click();
    const query = modal.querySelector('#voice-catalog-query');
    query.value = 'replacement';
    modal.querySelector('.voice-catalog-search').dispatchEvent(new dom.window.Event('submit', {
      bubbles: true,
      cancelable: true
    }));

    replacement.resolve({ voices: [current], hasMore: false, totalCount: 1 });
    await nextTurn();
    pagination.resolve({ voices: [late], hasMore: false, totalCount: 3 });
    await nextTurn();
    assert.deepEqual([...modal.querySelectorAll('.voice-sample-card')].map(card => card.dataset.voiceId), ['replacement']);
  } finally {
    removeDom(dom);
  }
});

test('focus stays in the catalog through preview retry and import state changes', async () => {
  const dom = installDom();
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  try {
    URL.createObjectURL = () => 'blob:preview';
    URL.revokeObjectURL = () => {};
    dom.window.HTMLMediaElement.prototype.play = async () => {};
    dom.window.HTMLMediaElement.prototype.pause = () => {};
    dom.window.HTMLMediaElement.prototype.load = () => {};

    const retryDownload = deferred();
    const importCommit = deferred();
    let downloads = 0;
    const voice = normalizeSharedVoice(rawVoice);
    const catalogClient = {
      async search() { return { voices: [voice], hasMore: false, totalCount: 1 }; },
      download() {
        downloads++;
        if (downloads === 1) return Promise.reject(new Error('Preview temporarily failed.'));
        return retryDownload.promise;
      }
    };
    const modal = createVoiceSampleCatalogModal({
      catalogClient,
      onAdd: async () => await importCommit.promise
    });
    document.body.appendChild(modal);
    await nextTurn();

    modal.querySelector('.btn-catalog-preview').focus();
    modal.querySelector('.btn-catalog-preview').click();
    await nextTurn();
    assert.match(modal.textContent, /Preview temporarily failed/);
    const retry = modal.querySelector('.btn-catalog-retry');
    retry.focus();
    retry.click();
    assert.equal(document.activeElement.classList.contains('btn-catalog-preview'), true);

    retryDownload.resolve(new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' }));
    await nextTurn();
    assert.equal(document.activeElement.classList.contains('btn-catalog-preview'), true);

    const add = modal.querySelector('.btn-catalog-add');
    add.focus();
    add.click();
    assert.equal(modal.querySelector('.btn-catalog-add').disabled, true);
    assert.equal(document.activeElement.classList.contains('btn-catalog-preview'), true);
    importCommit.resolve();
    await nextTurn();
    assert.equal(modal.querySelector('.btn-catalog-add').disabled, true);
    assert.equal(document.activeElement.classList.contains('btn-catalog-preview'), true);
    assert.notEqual(document.activeElement, document.body);
  } finally {
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    removeDom(dom);
  }
});

test('closing the catalog aborts a pending add before it reaches local storage', async () => {
  const dom = installDom();
  try {
    let resolveDownload;
    let downloadSignal;
    let added = 0;
    const voice = normalizeSharedVoice(rawVoice);
    const catalogClient = {
      async search() { return { voices: [voice], hasMore: false, totalCount: 1 }; },
      download(_voice, { signal }) {
        downloadSignal = signal;
        return new Promise(resolve => { resolveDownload = resolve; });
      }
    };
    const modal = createVoiceSampleCatalogModal({ catalogClient, onAdd: async () => { added++; } });
    document.body.appendChild(modal);
    await nextTurn();
    modal.querySelector('.btn-catalog-add').click();
    await nextTurn();
    modal.close();
    resolveDownload(new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' }));
    await nextTurn();

    assert.equal(downloadSignal.aborted, true);
    assert.equal(added, 0);
  } finally {
    removeDom(dom);
  }
});

test('an add failure retries the add operation without discarding search results', async () => {
  const dom = installDom();
  try {
    let searches = 0;
    let downloads = 0;
    let added = 0;
    const voice = normalizeSharedVoice(rawVoice);
    const catalogClient = {
      async search() { searches++; return { voices: [voice], hasMore: false, totalCount: 1 }; },
      async download() {
        downloads++;
        if (downloads === 1) throw new Error('Temporary download failure.');
        return new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' });
      }
    };
    const modal = createVoiceSampleCatalogModal({ catalogClient, onAdd: async () => { added++; } });
    document.body.appendChild(modal);
    await nextTurn();
    modal.querySelector('.btn-catalog-add').click();
    await nextTurn();
    assert.match(modal.textContent, /Temporary download failure/);
    modal.querySelector('.btn-catalog-retry').click();
    await nextTurn();

    assert.equal(searches, 1);
    assert.equal(downloads, 2);
    assert.equal(added, 1);
  } finally {
    removeDom(dom);
  }
});

test('voice downloads stop reading as soon as the byte limit is exceeded', async () => {
  let pulls = 0;
  const tooLargeChunk = new Uint8Array(26 * 1024 * 1024);
  const response = {
    ok: true,
    headers: { get: name => name.toLowerCase() === 'content-type' ? 'audio/mpeg' : null },
    body: {
      getReader() {
        return {
          async read() { pulls++; return { done: false, value: tooLargeChunk }; },
          async cancel() {},
          releaseLock() {}
        };
      }
    }
  };

  await assert.rejects(
    downloadVoiceSample({ name: 'Huge', previewUrl: 'https://cdn.example.test/huge.mp3' }, { fetchImpl: async () => response }),
    /too large/
  );
  assert.equal(pulls, 1);
});

test('voice downloads reject a declared oversized response without pulling its body', async () => {
  let pulls = 0;
  let cancelled = 0;
  let released = 0;
  const response = {
    ok: true,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-length') return String(26 * 1024 * 1024);
        if (name.toLowerCase() === 'content-type') return 'audio/mpeg';
        return null;
      }
    },
    body: {
      getReader() {
        return {
          async read() { pulls++; return { done: true }; },
          async cancel() { cancelled++; },
          releaseLock() { released++; }
        };
      }
    }
  };

  await assert.rejects(downloadVoiceSample(
    { name: 'Huge', previewUrl: 'https://cdn.example.test/huge.mp3' },
    { fetchImpl: async () => response }
  ), /That voice preview is too large to import/);
  assert.equal(pulls, 0);
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
});

test('aborting a voice download cancels and releases its response reader', async () => {
  const controller = new AbortController();
  let finishRead;
  let cancelled = 0;
  let released = 0;
  const response = {
    ok: true,
    headers: { get: name => name.toLowerCase() === 'content-type' ? 'audio/mpeg' : null },
    body: {
      getReader() {
        return {
          read: () => new Promise(resolve => { finishRead = resolve; }),
          async cancel() {
            cancelled++;
            finishRead?.({ done: true });
          },
          releaseLock() { released++; }
        };
      }
    }
  };
  const download = downloadVoiceSample(
    { name: 'Pending', previewUrl: 'https://cdn.example.test/pending.mp3' },
    { signal: controller.signal, fetchImpl: async () => response }
  );
  await Promise.resolve();
  controller.abort();

  await assert.rejects(download, error => error?.name === 'AbortError');
  assert.ok(cancelled >= 1);
  assert.equal(released, 1);
});
