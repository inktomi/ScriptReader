import { getIconSvg } from '../utils/icons.js';
import { escapeHtml } from '../utils/escape-html.js';
import { createFocusPreservingRenderer } from '../utils/focus-preserving-render.js';
import { LatestOperation, throwIfAborted } from '../utils/latest-operation.js';
import {
  downloadVoiceSample,
  searchVoiceSamples,
  VOICE_SAMPLE_CATALOG
} from '../audio/voice-sample-catalog.js';

const LANGUAGE_OPTIONS = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['it', 'Italian'], ['pt', 'Portuguese'], ['pl', 'Polish']
];
const ACCENT_OPTIONS = [
  ['', 'Any accent'], ['american', 'American'], ['british', 'British'],
  ['australian', 'Australian'], ['canadian', 'Canadian'], ['irish', 'Irish'],
  ['indian', 'Indian'], ['african', 'African']
];
const MAX_VISIBLE_RESULTS = 240;
const MAX_CACHED_PREVIEWS = 5;
const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function selected(value, expected) {
  return value === expected ? 'selected' : '';
}

function usageLabel(value) {
  const count = Number(value || 0);
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m characters`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k characters`;
  return count > 0 ? `${count} characters` : 'New voice';
}

function languageLabel(value) {
  return LANGUAGE_OPTIONS.find(([code]) => code === value)?.[1] || String(value || '').toUpperCase();
}

export function createVoiceSampleCatalogModal({
  onAdd,
  onClose,
  importedVoiceIds = [],
  getAudioSettings = () => ({ volume: 1, isMuted: false }),
  catalogClient = { search: searchVoiceSamples, download: downloadVoiceSample }
} = {}) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay voice-sample-catalog-overlay';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'voice-catalog-title');

  const state = {
    filters: { query: '', gender: '', age: '', accent: '', language: 'en' },
    voices: [],
    page: 0,
    hasMore: false,
    capped: false,
    totalCount: 0,
    loading: true,
    loadingMore: false,
    importingId: '',
    error: '',
    notice: '',
    retry: null,
    addedIds: new Set(importedVoiceIds)
  };
  const sampleCache = new Map();
  const searchOperation = new LatestOperation();
  const previewOperation = new LatestOperation();
  const importOperation = new LatestOperation();
  let previewAudio = null;
  let previewObjectUrl = '';
  let previewingId = '';
  let previewLoading = false;
  let closed = false;
  const focusRenderer = createFocusPreservingRenderer(modal, {
    valueSelectors: ['#voice-catalog-query'],
    scrollSelectors: ['.voice-sample-grid'],
    focusableSelector: FOCUSABLE,
    keepFocusInside: () => modal.isConnected && !closed,
    fallback: ({ snapshot, findByIdentity }) => {
      const identity = snapshot.focus.identity;
      if (identity.startsWith('key:add:')) {
        return findByIdentity(`key:preview:${identity.slice('key:add:'.length)}`);
      }
      if (identity.startsWith('key:retry:')) {
        const voiceId = identity.split(':').slice(3).join(':');
        if (voiceId) {
          const preview = findByIdentity(`key:preview:${voiceId}`);
          if (preview) return preview;
        }
      }
      return findByIdentity('id:voice-catalog-query');
    }
  });

  function resultSummary() {
    if (state.loading && state.voices.length === 0) return 'Finding the strongest matches…';
    const count = state.totalCount || state.voices.length;
    const scope = count === 1 ? 'catalog voice' : 'catalog voices';
    return `${count.toLocaleString()} ${scope} · strongest matches first`;
  }

  function voiceCard(voice) {
    const isAdded = state.addedIds.has(voice.id);
    const isImporting = state.importingId === voice.id;
    const isPreviewing = previewingId === voice.id;
    const attributes = [voice.gender, voice.age, voice.accent, languageLabel(voice.language)].filter(Boolean);
    return `
      <article class="voice-sample-card" data-voice-id="${escapeHtml(voice.id)}">
        <div class="voice-sample-card-heading">
          <div class="voice-sample-avatar" aria-hidden="true">${escapeHtml(voice.name.slice(0, 2).toUpperCase())}</div>
          <div><h3>${escapeHtml(voice.name)}</h3><p>${attributes.map(escapeHtml).join(' · ')}</p></div>
          <span class="voice-quality-badge">${getIconSvg('sparkles', 12)} ${escapeHtml(voice.qualityLabel)}</span>
        </div>
        <p class="voice-sample-description">${escapeHtml(voice.description)}</p>
        <div class="voice-sample-tags">
          ${voice.descriptive ? `<span>${escapeHtml(voice.descriptive)}</span>` : ''}
          <span>${escapeHtml(voice.useCase)}</span><span>${escapeHtml(usageLabel(voice.usageCount))}</span>
        </div>
        <div class="voice-sample-actions">
          <button class="btn btn-secondary btn-catalog-preview ${isPreviewing ? 'btn-active' : ''}" type="button" data-voice-id="${escapeHtml(voice.id)}" data-focus-key="preview:${escapeHtml(voice.id)}" aria-label="${isPreviewing ? 'Stop' : 'Preview'} ${escapeHtml(voice.name)}">
            ${getIconSvg(isPreviewing ? 'stop' : 'volume', 14)} <span>${isPreviewing ? (previewLoading ? 'Loading…' : 'Stop') : 'Preview'}</span>
          </button>
          <button class="btn ${isAdded ? 'btn-secondary' : 'btn-primary'} btn-catalog-add" type="button" data-voice-id="${escapeHtml(voice.id)}" data-focus-key="add:${escapeHtml(voice.id)}" ${isAdded || isImporting || state.importingId ? 'disabled' : ''}>
            ${isAdded ? `${getIconSvg('check', 14)} Added` : isImporting ? 'Adding…' : `${getIconSvg('download', 14)} Add voice`}
          </button>
        </div>
      </article>`;
  }

  function render({ preserveUi = false } = {}) {
    focusRenderer.render(() => {
      modal.innerHTML = `
      <div class="modal-card voice-sample-catalog-card">
        <header class="voice-catalog-header">
          <div><span class="eyebrow">Quality-first voice catalog</span><h2 id="voice-catalog-title">Find the right performance</h2>
            <p>Search ${VOICE_SAMPLE_CATALOG.estimatedVoices} quality-ranked voices. Preview anything; only voices you add are stored on this device.</p></div>
          <button class="btn-icon btn-close-catalog" type="button" data-focus-key="close" aria-label="Close voice catalog">${getIconSvg('close', 18)}</button>
        </header>
        <form class="voice-catalog-search" role="search">
          <label class="voice-catalog-query"><span class="sr-only">Describe the voice you want</span>${getIconSvg('search', 17)}
            <input id="voice-catalog-query" type="search" value="${escapeHtml(state.filters.query)}" placeholder="Try “warm older British narrator” or “gravelly villain”" autocomplete="off">
            <button class="btn btn-primary" type="submit" data-focus-key="search">Search</button></label>
          <div class="voice-catalog-filters" aria-label="Voice filters">
            <label><span>Voice</span><select id="voice-catalog-gender">
              <option value="" ${selected(state.filters.gender, '')}>Any voice</option><option value="female" ${selected(state.filters.gender, 'female')}>Female</option>
              <option value="male" ${selected(state.filters.gender, 'male')}>Male</option><option value="neutral" ${selected(state.filters.gender, 'neutral')}>Neutral</option>
            </select></label>
            <label><span>Age</span><select id="voice-catalog-age">
              <option value="" ${selected(state.filters.age, '')}>Any age</option><option value="young" ${selected(state.filters.age, 'young')}>Young adult</option>
              <option value="middle_aged" ${selected(state.filters.age, 'middle_aged')}>Middle-aged</option><option value="old" ${selected(state.filters.age, 'old')}>Older adult</option>
            </select></label>
            <label><span>Accent</span><select id="voice-catalog-accent">${ACCENT_OPTIONS.map(([value, label]) => `<option value="${value}" ${selected(state.filters.accent, value)}>${label}</option>`).join('')}</select></label>
            <label><span>Language</span><select id="voice-catalog-language">${LANGUAGE_OPTIONS.map(([value, label]) => `<option value="${value}" ${selected(state.filters.language, value)}>${label}</option>`).join('')}</select></label>
          </div>
        </form>
        <div class="voice-catalog-status"><span>${getIconSvg('sparkles', 14)} ${escapeHtml(resultSummary())}</span><span>Ranked by verification and real-world usage</span></div>
        <div class="voice-catalog-message" aria-live="polite">
          ${state.error ? `<div class="voice-catalog-error" role="alert">${escapeHtml(state.error)} ${state.retry ? `<button class="text-button btn-catalog-retry" type="button" data-focus-key="retry:${escapeHtml(state.retry.kind)}:${escapeHtml(state.retry.voiceId || '')}">Try again</button>` : ''}</div>` : ''}
          ${state.notice ? `<div class="voice-catalog-notice">${getIconSvg('check', 14)} ${escapeHtml(state.notice)}</div>` : ''}
        </div>
        <div class="voice-sample-grid" aria-busy="${state.loading}">
          ${state.loading && state.voices.length === 0
            ? Array.from({ length: 6 }, () => '<div class="voice-sample-card voice-sample-skeleton" aria-hidden="true"><i></i><i></i><i></i></div>').join('')
            : state.voices.map(voiceCard).join('')}
          ${!state.loading && !state.error && state.voices.length === 0 ? '<div class="voice-catalog-empty"><strong>No exact matches yet.</strong><span>Try fewer words or broaden one of the filters.</span></div>' : ''}
        </div>
        <footer class="voice-catalog-footer"><span>${state.capped ? `Showing ${MAX_VISIBLE_RESULTS} popular matches, ranked by quality. Refine your search to explore more.` : 'Catalog previews require an internet connection. Imported voices remain available offline.'}</span>
          ${state.hasMore && !state.capped ? `<button class="btn btn-secondary btn-catalog-more" type="button" data-focus-key="more" ${state.loadingMore ? 'aria-disabled="true"' : ''}>${state.loadingMore ? 'Loading…' : 'Show more voices'}</button>` : ''}
        </footer>
      </div>`;
      attachListeners();
    }, { preserve: preserveUi });
  }

  function readFilters() {
    state.filters = {
      query: modal.querySelector('#voice-catalog-query')?.value.trim() || '',
      gender: modal.querySelector('#voice-catalog-gender')?.value || '',
      age: modal.querySelector('#voice-catalog-age')?.value || '',
      accent: modal.querySelector('#voice-catalog-accent')?.value || '',
      language: modal.querySelector('#voice-catalog-language')?.value || 'en'
    };
  }

  async function runSearch({ append = false } = {}) {
    if (!append) {
      stopPreview();
      state.page = 0;
      state.voices = [];
      state.hasMore = false;
      state.capped = false;
      state.totalCount = 0;
      state.loading = true;
      state.error = '';
      state.notice = '';
      state.retry = null;
    } else {
      if (state.loadingMore || state.loading || state.capped) return;
      state.loadingMore = true;
      state.error = '';
      state.retry = null;
    }
    render({ preserveUi: true });

    const nextPage = append ? state.page + 1 : 0;
    await searchOperation.run(async ({ signal }) => {
      const result = await catalogClient.search(
        { ...state.filters, page: nextPage, pageSize: VOICE_SAMPLE_CATALOG.pageSize },
        { signal }
      );
      return { result, append, nextPage };
    }, {
      onCommit: ({ result, append: shouldAppend, nextPage: committedPage }) => {
      const known = new Set(state.voices.map(voice => voice.id));
      const newVoices = result.voices.filter(voice => !known.has(voice.id));
      const combined = shouldAppend ? [...state.voices, ...newVoices] : newVoices;
      combined.sort((a, b) => b.qualityScore - a.qualityScore || b.usageCount - a.usageCount);
      state.capped = combined.length > MAX_VISIBLE_RESULTS
        || (result.hasMore && combined.length >= MAX_VISIBLE_RESULTS);
      state.voices = combined.slice(0, MAX_VISIBLE_RESULTS);
      state.page = committedPage;
      state.hasMore = result.hasMore && !state.capped;
      state.totalCount = result.totalCount;
      },
      onError: error => {
        state.error = error.message || 'The voice catalog could not be loaded.';
        state.retry = { kind: 'search', append };
      },
      onFinally: () => {
        state.loading = false;
        state.loadingMore = false;
        render({ preserveUi: true });
      }
    });
  }

  function cacheSample(id, file) {
    sampleCache.delete(id);
    sampleCache.set(id, file);
    while (sampleCache.size > MAX_CACHED_PREVIEWS) sampleCache.delete(sampleCache.keys().next().value);
  }

  async function getSampleFile(voice, signal) {
    const cached = sampleCache.get(voice.id);
    if (cached) {
      cacheSample(voice.id, cached);
      return cached;
    }
    const file = await catalogClient.download(voice, { signal });
    throwIfAborted(signal);
    cacheSample(voice.id, file);
    return file;
  }

  function stopPreview() {
    previewOperation.cancel();
    if (previewAudio) {
      const audio = previewAudio;
      previewAudio = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load?.();
    }
    if (previewObjectUrl) URL.revokeObjectURL?.(previewObjectUrl);
    previewObjectUrl = '';
    previewingId = '';
    previewLoading = false;
    modal.querySelectorAll('.btn-catalog-preview').forEach(button => {
      button.classList.remove('btn-active');
      button.querySelector('span').textContent = 'Preview';
    });
  }

  async function togglePreview(voice) {
    if (previewingId === voice.id) {
      stopPreview();
      render({ preserveUi: true });
      return;
    }
    stopPreview();
    previewingId = voice.id;
    previewLoading = true;
    state.error = '';
    state.retry = null;
    render({ preserveUi: true });
    await previewOperation.run(async ({ signal, commit }) => {
      const file = await getSampleFile(voice, signal);
      let audio;
      commit(() => {
        previewObjectUrl = URL.createObjectURL(file);
        audio = document.createElement('audio');
        const settings = getAudioSettings() || {};
        audio.volume = Math.min(1, Math.max(0, Number(settings.volume ?? 1)));
        audio.muted = settings.isMuted === true;
        audio.preload = 'auto';
        audio.src = previewObjectUrl;
        previewAudio = audio;
        previewLoading = false;
        audio.onended = () => {
          if (previewAudio === audio) {
            stopPreview();
            if (!closed) render({ preserveUi: true });
          }
        };
        audio.onerror = () => {
          if (previewAudio !== audio) return;
          stopPreview();
          state.error = 'That preview could not be played.';
          state.retry = { kind: 'preview', voiceId: voice.id };
          if (!closed) render({ preserveUi: true });
        };
        render({ preserveUi: true });
      });
      throwIfAborted(signal);
      await audio.play();
    }, {
      onError: error => {
        stopPreview();
        state.error = error.message || 'That preview could not be played.';
        state.retry = { kind: 'preview', voiceId: voice.id };
        render({ preserveUi: true });
      }
    });
  }

  async function addVoice(voice) {
    if (state.addedIds.has(voice.id) || state.importingId) return;
    stopPreview();
    state.importingId = voice.id;
    state.error = '';
    state.notice = '';
    state.retry = null;
    render({ preserveUi: true });
    await importOperation.run(async ({ signal }) => {
      const file = await getSampleFile(voice, signal);
      throwIfAborted(signal);
      await onAdd?.(file, voice, { signal });
      return voice;
    }, {
      onCommit: addedVoice => {
        state.addedIds.add(addedVoice.id);
        state.notice = `${addedVoice.name} is ready in your private voice library.`;
      },
      onError: error => {
        state.error = error.message || 'That voice could not be added.';
        state.retry = { kind: 'add', voiceId: voice.id };
      },
      onFinally: () => {
        state.importingId = '';
        render({ preserveUi: true });
      }
    });
  }

  function retryLastOperation() {
    const retry = state.retry;
    if (!retry) return;
    const voice = retry.voiceId ? state.voices.find(item => item.id === retry.voiceId) : null;
    if (retry.kind === 'search') void runSearch({ append: retry.append });
    else if (retry.kind === 'preview' && voice) void togglePreview(voice);
    else if (retry.kind === 'add' && voice) void addVoice(voice);
  }

  function attachListeners() {
    modal.querySelector('.btn-close-catalog')?.addEventListener('click', close);
    modal.querySelector('.voice-catalog-search')?.addEventListener('submit', event => {
      event.preventDefault();
      readFilters();
      void runSearch();
    });
    modal.querySelectorAll('.voice-catalog-filters select').forEach(select => select.addEventListener('change', () => {
      readFilters();
      void runSearch();
    }));
    modal.querySelector('.btn-catalog-retry')?.addEventListener('click', retryLastOperation);
    modal.querySelector('.btn-catalog-more')?.addEventListener('click', () => void runSearch({ append: true }));
    modal.querySelectorAll('.btn-catalog-preview').forEach(button => button.addEventListener('click', () => {
      const voice = state.voices.find(item => item.id === button.dataset.voiceId);
      if (voice) void togglePreview(voice);
    }));
    modal.querySelectorAll('.btn-catalog-add').forEach(button => button.addEventListener('click', () => {
      const voice = state.voices.find(item => item.id === button.dataset.voiceId);
      if (voice) void addVoice(voice);
    }));
  }

  function close() {
    if (closed) return;
    closed = true;
    stopPreview();
    searchOperation.close();
    previewOperation.close();
    importOperation.close();
    modal.remove();
    onClose?.();
  }

  modal.close = close;
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll(FOCUSABLE)].filter(element => element.offsetParent !== null || element === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  render();
  void runSearch();
  queueMicrotask(() => modal.querySelector('#voice-catalog-query')?.focus());
  return modal;
}
