import assert from 'node:assert/strict';
import test from 'node:test';
import {
  downloadVoiceSample,
  loadVoiceSampleCatalog,
  matchesVoiceFilters,
  normalizeCatalogVoice,
  resetVoiceSampleCatalog,
  searchVoiceSamples,
  voiceSampleQualityLabel,
} from '../src/audio/voice-sample-catalog.js';
import { createVoiceSampleCatalogModal } from '../src/ui/voice-sample-catalog-modal.js';
import { installDom, removeDom } from './dom-helpers.js';

const rawEntry = {
  id: 'libritts-r-1272',
  name: 'Maya Ellery',
  gender: 'Female',
  ageBand: 'young',
  accent: 'Irish',
  register: 'bright',
  pitchHz: 196,
  pace: 'brisk',
  wordsPerMinute: 205,
  seconds: 10,
  bytes: 58_000,
  snrDb: 31.4,
  subset: 'dev-clean',
  clip: '1272.mp3',
};

function catalogPayload(entries) {
  return {
    source: 'LibriTTS-R',
    license: 'CC BY 4.0',
    accents: ['Irish', 'Unspecified'],
    voices: entries,
  };
}

function fetchingCatalog(entries, onUrl = () => {}) {
  return async (url) => {
    onUrl(url);
    return {
      ok: true,
      async json() {
        return catalogPayload(entries);
      },
    };
  };
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('catalog entries become casting metadata from sourced facts only', () => {
  const voice = normalizeCatalogVoice(rawEntry, catalogPayload([]));

  assert.equal(voice.name, 'Maya Ellery');
  assert.equal(voice.gender, 'Female');
  assert.equal(voice.ageBand, 'young');
  assert.equal(voice.ageLabel, 'Young');
  assert.equal(voice.accent, 'Irish');
  assert.equal(voice.registerLabel, 'Bright');
  assert.equal(voice.paceLabel, 'Brisk pace');
  assert.equal(voice.previewUrl, '/voice-samples/1272.mp3');
  assert.equal(voiceSampleQualityLabel(voice), 'Studio clean');
  assert.match(voice.description, /Maya Ellery/);
  assert.match(voice.description, /Young, Irish/);
  assert.match(voice.description, /196 Hz/);
  assert.match(voice.description, /205 words per minute/);

  // The annotation sets agree with the corpus for this reader, so there is
  // nothing to warn about; only a contradiction is worth putting on a card.
  assert.equal(voice.perceivedGender, '');
});

test('a reader outside the annotation sets is unspecified, never guessed', () => {
  const { ageBand, accent, ...unannotated } = rawEntry;
  const voice = normalizeCatalogVoice({ ...unannotated, id: 'bare' }, catalogPayload([]));

  // An uncovered reader must not be quietly filed under the commonest band.
  assert.equal(voice.ageBand, 'unspecified');
  assert.equal(voice.ageLabel, 'Unspecified');
  assert.equal(voice.accent, 'Unspecified');

  // ...and the blurb says nothing rather than something invented.
  assert.equal(
    voice.description,
    'Audiobook narration read by Maya Ellery. Median pitch 196 Hz, 205 words per minute.',
  );

  // The filter still reaches them, so they are never dropped without a trace.
  assert.equal(matchesVoiceFilters(voice, { age: 'unspecified' }), true);
  assert.equal(matchesVoiceFilters(voice, { accent: 'Unspecified' }), true);
  assert.equal(matchesVoiceFilters(voice, { age: 'young' }), false);

  // But an unspecified reader answers to no age or accent search term, or an
  // unannotated voice would surface as a match for a trait nobody recorded.
  assert.equal(matchesVoiceFilters(voice, { query: 'irish' }), false);
  assert.equal(matchesVoiceFilters(voice, { query: 'young' }), false);
});

test('a bare entry with no measurements still reads as one clean sentence', () => {
  const voice = normalizeCatalogVoice({ id: 'sparse', name: 'Ada Vane', clip: 'x.mp3' }, catalogPayload([]));
  assert.equal(voice.description, 'Audiobook narration read by Ada Vane.');
});

test('catalog search ranks clearer recordings first and paginates locally', async () => {
  resetVoiceSampleCatalog();
  const requested = [];
  const result = await searchVoiceSamples(
    { pageSize: 2 },
    {
      fetchImpl: fetchingCatalog(
        [
          { ...rawEntry, id: 'noisy', name: 'Noisy', snrDb: 24 },
          { ...rawEntry, id: 'unusable', clip: '' },
          { ...rawEntry, id: 'clearest', name: 'Clearest', snrDb: 41 },
          { ...rawEntry, id: 'middling', name: 'Middling', snrDb: 33 },
        ],
        (url) => requested.push(url),
      ),
    },
  );

  assert.deepEqual(
    result.voices.map((voice) => voice.id),
    ['clearest', 'middling'],
  );
  assert.equal(result.totalCount, 3, 'the entry with no clip is not shippable');
  assert.equal(result.hasMore, true);
  assert.deepEqual(requested, ['/voice-samples/catalog.json'], 'served from our own origin');
});

test('ranking is the measured SNR alone, with clip length carrying no weight', async () => {
  resetVoiceSampleCatalog();
  const result = await searchVoiceSamples(
    {},
    {
      fetchImpl: fetchingCatalog([
        // The old score was min(45, snr) * 2 + min(12, seconds), which ranked
        // `padded` above `cleanest` on three extra seconds. Chatterbox slices a
        // reference to 10s for conditioning and 6s for the prompt tokens, so
        // those seconds reach no model and must not move a voice up the list.
        { ...rawEntry, id: 'padded', name: 'Padded', snrDb: 36, seconds: 12 },
        { ...rawEntry, id: 'cleanest', name: 'Cleanest', snrDb: 38, seconds: 9 },
        { ...rawEntry, id: 'noisier', name: 'Noisier', snrDb: 30, seconds: 12 },
      ]),
    },
  );

  assert.deepEqual(
    result.voices.map((voice) => voice.id),
    ['cleanest', 'padded', 'noisier'],
  );
  // Nothing derived hangs off the removed score either.
  assert.equal('qualityScore' in result.voices[0], false);
});

test('the catalog is revalidated, so a cached copy cannot outlive the code reading it', async () => {
  resetVoiceSampleCatalog();
  const calls = [];
  await searchVoiceSamples(
    {},
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          async json() {
            return catalogPayload([rawEntry]);
          },
        };
      },
    },
  );

  // The bundle is content-hashed and updates the moment a deploy lands; a
  // long-cached catalog.json does not. Pairing the two means new code filtering
  // on a field an old manifest lacks, which returns zero matches rather than an
  // error — exactly what shipping ageBand/accent did to returning visitors.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.cache, 'no-cache');
});

test('a second search reuses the loaded catalog instead of refetching it', async () => {
  resetVoiceSampleCatalog();
  let fetches = 0;
  const fetchImpl = fetchingCatalog([rawEntry], () => {
    fetches++;
  });

  await searchVoiceSamples({}, { fetchImpl });
  const second = await searchVoiceSamples({ query: 'maya' }, { fetchImpl });

  assert.equal(fetches, 1);
  assert.equal(second.voices.length, 1);
});

test('a superseded search does not abort the catalog load for the search replacing it', async () => {
  resetVoiceSampleCatalog();
  let release;
  const fetchImpl = async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return {
      ok: true,
      async json() {
        return catalogPayload([rawEntry]);
      },
    };
  };

  // The modal aborts the previous search on every keystroke. The catalog fetch
  // is shared, so binding it to the first caller would sink the one that
  // replaced it.
  const stale = new AbortController();
  const first = searchVoiceSamples({}, { signal: stale.signal, fetchImpl });
  const second = searchVoiceSamples({}, { fetchImpl });
  stale.abort();
  release();

  await assert.rejects(first, (error) => error?.name === 'AbortError');
  assert.equal((await second).voices.length, 1);
});

test('a failed catalog load does not poison later attempts', async () => {
  resetVoiceSampleCatalog();
  let attempts = 0;
  const fetchImpl = async (_url) => {
    attempts++;
    if (attempts === 1) return { ok: false, status: 503 };
    return {
      ok: true,
      async json() {
        return catalogPayload([rawEntry]);
      },
    };
  };

  await assert.rejects(loadVoiceSampleCatalog({ fetchImpl }), /could not be loaded/);
  const catalog = await loadVoiceSampleCatalog({ fetchImpl });
  assert.equal(catalog.voices.length, 1);
});

test('filters narrow by every axis the catalog stores, and unknown traits match nothing', () => {
  const bright = normalizeCatalogVoice(rawEntry);
  const deep = normalizeCatalogVoice({
    ...rawEntry,
    id: 'deep',
    name: 'Gordon Vale',
    gender: 'Male',
    ageBand: 'senior',
    accent: 'Scottish',
    register: 'deep',
    pitchHz: 92,
    pace: 'measured',
    wordsPerMinute: 128,
  });

  assert.equal(matchesVoiceFilters(deep, { gender: 'male' }), true);
  assert.equal(matchesVoiceFilters(bright, { gender: 'male' }), false);
  assert.equal(matchesVoiceFilters(deep, { register: 'deep' }), true);
  assert.equal(matchesVoiceFilters(deep, { pace: 'brisk' }), false);
  assert.equal(matchesVoiceFilters(deep, { age: 'senior' }), true);
  assert.equal(matchesVoiceFilters(bright, { age: 'senior' }), false);
  assert.equal(matchesVoiceFilters(deep, { accent: 'Scottish' }), true);
  assert.equal(matchesVoiceFilters(bright, { accent: 'Scottish' }), false);

  // Free text reaches the reader's name, the measured axes, and the sourced
  // traits by their common synonyms — the whole point of the annotation sets is
  // that "older scottish man" is now a question the catalog can answer.
  assert.equal(matchesVoiceFilters(deep, { query: 'gordon' }), true);
  assert.equal(matchesVoiceFilters(deep, { query: 'gravelly slow' }), true);
  assert.equal(matchesVoiceFilters(bright, { query: 'gravelly' }), false);
  assert.equal(matchesVoiceFilters(deep, { query: 'older scottish man' }), true);
  assert.equal(matchesVoiceFilters(bright, { query: 'young irish woman' }), true);
  assert.equal(matchesVoiceFilters(bright, { query: 'scottish' }), false);
  assert.equal(matchesVoiceFilters(deep, { query: 'young' }), false);

  // A trait no source records must still return nothing rather than quietly
  // ignoring the word and returning everything.
  assert.equal(matchesVoiceFilters(deep, { query: 'sardonic' }), false);
  assert.equal(matchesVoiceFilters(bright, { query: 'nasal' }), false);
});

test('the age and accent filters populate from the catalog and keep keyboard focus', async () => {
  const dom = installDom();
  try {
    const searches = [];
    const voice = normalizeCatalogVoice(rawEntry);
    const modal = createVoiceSampleCatalogModal({
      catalogClient: {
        async search(filters) {
          searches.push(filters);
          return {
            voices: [voice],
            hasMore: false,
            totalCount: 1,
            accents: ['American', 'Irish', 'Unspecified'],
          };
        },
        async download() {
          throw new Error('not used');
        },
      },
    });
    document.body.appendChild(modal);
    await nextTurn();

    const accent = modal.querySelector('#voice-catalog-accent');
    const age = modal.querySelector('#voice-catalog-age');

    // The accent list is data-driven, so it can only offer accents that exist.
    assert.deepEqual(
      [...accent.options].map((option) => option.value),
      ['', 'American', 'Irish', 'Unspecified'],
    );
    // `Unspecified` stays reachable: four readers sit outside the annotation
    // sets, and a filter that could not select them would hide voices silently.
    assert.deepEqual(
      [...age.options].map((option) => option.value),
      ['', 'young', 'adult', 'senior', 'unspecified'],
    );

    // Changing a filter re-renders the whole modal; focus has to survive it, or
    // a keyboard user is dropped to the document body mid-search.
    accent.focus();
    accent.value = 'Irish';
    accent.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await nextTurn();

    assert.equal(searches.at(-1).accent, 'Irish');
    assert.equal(document.activeElement.id, 'voice-catalog-accent');
    assert.equal(modal.querySelector('#voice-catalog-accent').value, 'Irish');

    // Re-query: the previous render replaced every node in the modal, so the
    // handle taken before it is detached and focusing it would do nothing.
    const nextAge = modal.querySelector('#voice-catalog-age');
    nextAge.focus();
    nextAge.value = 'senior';
    nextAge.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await nextTurn();

    assert.equal(searches.at(-1).age, 'senior');
    assert.equal(searches.at(-1).accent, 'Irish', 'the two filters are independent');
    assert.equal(document.activeElement.id, 'voice-catalog-age');

    modal.close();
  } finally {
    removeDom(dom);
  }
});

test('voice browser searches, escapes remote metadata, and imports a selected preview', async () => {
  const dom = installDom();
  try {
    const searches = [];
    const added = [];
    const voice = normalizeCatalogVoice({
      ...rawEntry,
      name: '<img src=x onerror="window.pwned=1">',
    });
    const catalogClient = {
      async search(filters) {
        searches.push(filters);
        return { voices: [voice], hasMore: false, totalCount: 10_214 };
      },
      async download(selectedVoice) {
        assert.equal(selectedVoice.id, voice.id);
        return new File(['audio'], 'maya.mp3', { type: 'audio/mpeg' });
      },
    };
    const modal = createVoiceSampleCatalogModal({
      catalogClient,
      async onAdd(file, selectedVoice) {
        added.push({ file, selectedVoice });
      },
    });
    document.body.appendChild(modal);
    await nextTurn();

    assert.equal(modal.querySelectorAll('.voice-sample-card').length, 1);
    assert.equal(modal.querySelector('img'), null);
    assert.equal(dom.window.pwned, undefined);
    assert.match(modal.textContent, /10,214 catalog voices/);

    const query = modal.querySelector('#voice-catalog-query');
    query.value = 'quiet detective';
    modal.querySelector('.voice-catalog-search').dispatchEvent(
      new dom.window.Event('submit', {
        bubbles: true,
        cancelable: true,
      }),
    );
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
    // Ranked on measured SNR, so the fixtures carry a real one rather than a
    // score handed to them.
    const low = { ...normalizeCatalogVoice({ ...rawEntry, snrDb: 24 }), id: 'low' };
    const high = { ...normalizeCatalogVoice({ ...rawEntry, id: 'high', snrDb: 41 }) };
    const catalogClient = {
      search(filters) {
        if (filters.page === 0) {
          return new Promise((resolve) => {
            resolveInitial = resolve;
          });
        }
        return Promise.resolve({ voices: [high], hasMore: false, totalCount: 2 });
      },
      async download() {
        return new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' });
      },
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
    assert.deepEqual(
      [...modal.querySelectorAll('.voice-sample-card')].map((card) => card.dataset.voiceId),
      ['high', 'low'],
    );
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
    const initial = { ...normalizeCatalogVoice(rawEntry), id: 'initial' };
    const stale = { ...normalizeCatalogVoice(rawEntry), id: 'stale', name: 'Stale result' };
    const current = { ...normalizeCatalogVoice(rawEntry), id: 'current', name: 'Current result' };
    const catalogClient = {
      search(_filters, { signal }) {
        signals.push(signal);
        calls++;
        if (calls === 1) return Promise.resolve({ voices: [initial], hasMore: false, totalCount: 1 });
        return calls === 2 ? oldSearch.promise : newSearch.promise;
      },
      async download() {
        return new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' });
      },
    };
    const modal = createVoiceSampleCatalogModal({ catalogClient });
    document.body.appendChild(modal);
    await nextTurn();

    let query = modal.querySelector('#voice-catalog-query');
    query.value = 'old request';
    query.focus();
    query.setSelectionRange(4, 11);
    modal.querySelector('.voice-catalog-search').dispatchEvent(
      new dom.window.Event('submit', {
        bubbles: true,
        cancelable: true,
      }),
    );
    query = modal.querySelector('#voice-catalog-query');
    assert.equal(document.activeElement, query);
    assert.equal(query.selectionStart, 4);
    assert.equal(query.selectionEnd, 11);

    query.value = 'new request';
    modal.querySelector('.voice-catalog-search').dispatchEvent(
      new dom.window.Event('submit', {
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal(signals[1].aborted, true);
    newSearch.resolve({ voices: [current], hasMore: false, totalCount: 1 });
    await nextTurn();
    oldSearch.resolve({ voices: [stale], hasMore: false, totalCount: 1 });
    await nextTurn();

    assert.deepEqual(
      [...modal.querySelectorAll('.voice-sample-card')].map((card) => card.dataset.voiceId),
      ['current'],
    );
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
    const first = { ...normalizeCatalogVoice(rawEntry), id: 'first' };
    const late = { ...normalizeCatalogVoice(rawEntry), id: 'late-page' };
    const current = { ...normalizeCatalogVoice(rawEntry), id: 'replacement' };
    const catalogClient = {
      search(filters) {
        calls++;
        if (calls === 1) return Promise.resolve({ voices: [first], hasMore: true, totalCount: 3 });
        if (filters.page === 1) return pagination.promise;
        return replacement.promise;
      },
      async download() {
        return new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' });
      },
    };
    const modal = createVoiceSampleCatalogModal({ catalogClient });
    document.body.appendChild(modal);
    await nextTurn();
    modal.querySelector('.btn-catalog-more').click();
    const query = modal.querySelector('#voice-catalog-query');
    query.value = 'replacement';
    modal.querySelector('.voice-catalog-search').dispatchEvent(
      new dom.window.Event('submit', {
        bubbles: true,
        cancelable: true,
      }),
    );

    replacement.resolve({ voices: [current], hasMore: false, totalCount: 1 });
    await nextTurn();
    pagination.resolve({ voices: [late], hasMore: false, totalCount: 3 });
    await nextTurn();
    assert.deepEqual(
      [...modal.querySelectorAll('.voice-sample-card')].map((card) => card.dataset.voiceId),
      ['replacement'],
    );
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
    const voice = normalizeCatalogVoice(rawEntry);
    const catalogClient = {
      async search() {
        return { voices: [voice], hasMore: false, totalCount: 1 };
      },
      download() {
        downloads++;
        if (downloads === 1) return Promise.reject(new Error('Preview temporarily failed.'));
        return retryDownload.promise;
      },
    };
    const modal = createVoiceSampleCatalogModal({
      catalogClient,
      onAdd: async () => await importCommit.promise,
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
    const voice = normalizeCatalogVoice(rawEntry);
    const catalogClient = {
      async search() {
        return { voices: [voice], hasMore: false, totalCount: 1 };
      },
      download(_voice, { signal }) {
        downloadSignal = signal;
        return new Promise((resolve) => {
          resolveDownload = resolve;
        });
      },
    };
    const modal = createVoiceSampleCatalogModal({
      catalogClient,
      onAdd: async () => {
        added++;
      },
    });
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
    const voice = normalizeCatalogVoice(rawEntry);
    const catalogClient = {
      async search() {
        searches++;
        return { voices: [voice], hasMore: false, totalCount: 1 };
      },
      async download() {
        downloads++;
        if (downloads === 1) throw new Error('Temporary download failure.');
        return new File(['audio'], 'sample.mp3', { type: 'audio/mpeg' });
      },
    };
    const modal = createVoiceSampleCatalogModal({
      catalogClient,
      onAdd: async () => {
        added++;
      },
    });
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
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
    body: {
      getReader() {
        return {
          async read() {
            pulls++;
            return { done: false, value: tooLargeChunk };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };

  await assert.rejects(
    downloadVoiceSample(
      { name: 'Huge', previewUrl: 'https://cdn.example.test/huge.mp3' },
      { fetchImpl: async () => response },
    ),
    /too large/,
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
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            pulls++;
            return { done: true };
          },
          async cancel() {
            cancelled++;
          },
          releaseLock() {
            released++;
          },
        };
      },
    },
  };

  await assert.rejects(
    downloadVoiceSample(
      { name: 'Huge', previewUrl: 'https://cdn.example.test/huge.mp3' },
      { fetchImpl: async () => response },
    ),
    /That voice sample is too large to import/,
  );
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
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
    body: {
      getReader() {
        return {
          read: () =>
            new Promise((resolve) => {
              finishRead = resolve;
            }),
          async cancel() {
            cancelled++;
            finishRead?.({ done: true });
          },
          releaseLock() {
            released++;
          },
        };
      },
    },
  };
  const download = downloadVoiceSample(
    { name: 'Pending', previewUrl: 'https://cdn.example.test/pending.mp3' },
    { signal: controller.signal, fetchImpl: async () => response },
  );
  await Promise.resolve();
  controller.abort();

  await assert.rejects(download, (error) => error?.name === 'AbortError');
  assert.ok(cancelled >= 1);
  assert.equal(released, 1);
});
