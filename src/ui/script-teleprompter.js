import { getIconSvg } from '../utils/icons.js';
import { escapeHtml } from '../utils/escape-html.js';
import { PACE_PROFILES } from '../screenplay/overlap-pacing.js';

export function createScriptTeleprompter({
  scriptStore,
  audioManager,
  onLineClick
}) {
  const container = document.createElement('main');
  container.className = 'screenplay-viewport';

  let autoScrollEnabled = true;
  let activeLineSet = new Set();

  container.innerHTML = `
    <div class="teleprompter-toolbar">
      <div id="teleprompter-status" style="display: flex; align-items: center; gap: 10px;">
        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #10B981; box-shadow: 0 0 8px #10B981;"></span>
        <span id="teleprompter-title" style="font-weight: 600; color: #FFFFFF;">Screenplay Loaded</span>
        <span class="badge-voice" style="font-size: 0.7rem; padding: 2px 8px; background: rgba(245, 158, 11, 0.15); color: #F59E0B; border: 1px solid rgba(245, 158, 11, 0.3);">
          🎭 Table Read Mode
        </span>
      </div>

      <div style="display: flex; align-items: center; gap: 12px;">
        <label style="display: flex; align-items: center; gap: 6px; font-size: 0.75rem; cursor: pointer; color: var(--text-secondary);">
          <input type="checkbox" id="chk-autoscroll" checked style="accent-color: #F59E0B;">
          <span>Auto-Scroll Follow</span>
        </label>
        <button id="btn-recenter" class="btn btn-secondary" style="padding: 3px 8px; font-size: 0.7rem;">
          ${getIconSvg('eye', 12)}
          <span>Recenter</span>
        </button>
      </div>
    </div>

    <div class="teleprompter-scroll" id="teleprompter-scroll-area">
      <div class="screenplay-page" id="screenplay-content">
        <!-- Rendered screenplay lines go here -->
      </div>
    </div>
  `;

  const scrollArea = container.querySelector('#teleprompter-scroll-area');
  const pageContent = container.querySelector('#screenplay-content');
  const titleDisplay = container.querySelector('#teleprompter-title');
  const chkAutoscroll = container.querySelector('#chk-autoscroll');
  const btnRecenter = container.querySelector('#btn-recenter');

  chkAutoscroll.addEventListener('change', (e) => {
    autoScrollEnabled = e.target.checked;
  });

  btnRecenter.addEventListener('click', () => {
    scrollToActiveLine(true);
  });

  function renderScript() {
    activeLineSet = new Set();
    const script = scriptStore.currentScript;
    if (!script || !script.elements || script.elements.length === 0) {
      pageContent.innerHTML = `
        <div style="text-align: center; padding: 60px 20px; color: var(--text-secondary);">
          <div style="font-size: 2.5rem; margin-bottom: 16px;">🎬</div>
          <div style="font-size: 1.25rem; font-weight: 700; color: #FFFFFF; margin-bottom: 8px;">No Screenplay Loaded</div>
          <p style="font-size: 0.9rem; max-width: 440px; margin: 0 auto 20px auto;">
            Import a PDF screenplay export, Fountain script, or select one of our pre-loaded cinematic sample scenes above.
          </p>
        </div>
      `;
      return;
    }

    titleDisplay.textContent = `${script.title} (${script.elements.length} elements, ${script.scenes.length} scenes)`;

    let html = `
      <div class="script-title-header">
        <div class="script-title-text">${escapeHtml(script.title.toUpperCase())}</div>
        <div class="script-author-text">Formatted for Voice Model Readthrough • Standard Hollywood Layout</div>
      </div>
    `;

    script.elements.forEach((elem, index) => {
      const nuance = elem.nuance || {};
      let lineClass = 'script-line';
      let contentHtml = '';

      switch (elem.type) {
        case 'SCENE_HEADING':
          lineClass += ' scene-heading';
          contentHtml = `
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <span>${escapeHtml(elem.text)}</span>
              <span style="font-size: 0.7rem; font-family: var(--font-ui); color: #0284C7; font-weight: 600;">SCENE ${elem.sceneNumber}</span>
            </div>
          `;
          break;

        case 'ACTION':
          lineClass += ' action';
          contentHtml = escapeHtml(elem.text);
          break;

        case 'CHARACTER':
        case 'DIALOGUE':
          lineClass += ' dialogue';
          const overlapMode = elem.overlap && elem.overlap.mode;
          if (overlapMode === 'simultaneous') lineClass += ' is-simultaneous';
          if (overlapMode === 'interrupt') lineClass += ' is-interrupting';

          const directionTag = elem.parenthetical ? `
            <div class="script-line parenthetical" style="padding-left: 0; padding-right: 0;">
              (${escapeHtml(elem.parenthetical)})
            </div>
          ` : '';

          const emotionBadge = nuance.emotionKey && nuance.emotionKey !== 'neutral' ? `
            <span class="emotion-badge" style="background: ${nuance.badgeColor}22; border-color: ${nuance.badgeColor}66; color: ${nuance.badgeColor};">
              ${nuance.emotionIcon || '🎭'} ${nuance.emotionLabel || nuance.emotionKey}
            </span>
          ` : '';

          const overlapBadge = overlapMode ? (() => {
            const color = overlapMode === 'simultaneous' ? '#06B6D4' : '#F43F5E';
            const text = overlapMode === 'simultaneous' ? '⇉ Simultaneous' : '⏵ Interrupts';
            return `<span class="emotion-badge" style="background: ${color}22; border-color: ${color}66; color: ${color};">${text}</span>`;
          })() : '';

          // The dash the author wrote is already in the text; this just marks
          // that somebody actually took the line away.
          const cutMark = elem.cutOff ? '<span class="cut-off-mark" title="Cut off">—</span>' : '';

          contentHtml = `
            <div class="script-line character-cue" style="padding-left: 0; padding-right: 0; margin-top: 0;">
              <span>${escapeHtml(elem.characterOriginal || elem.character)}</span>
              ${emotionBadge}
              ${overlapBadge}
            </div>
            ${directionTag}
            <div>${escapeHtml(elem.text)}${cutMark}</div>
          `;
          break;

        case 'TRANSITION':
          lineClass += ' transition';
          contentHtml = escapeHtml(elem.text);
          break;

        default:
          lineClass += ' action';
          contentHtml = escapeHtml(elem.text);
      }

      // Mark where the pace changes, not every line that inherits it.
      const prevPace = index > 0 ? script.elements[index - 1].pace : 'natural';
      const paceMarker = elem.pace && elem.pace !== prevPace
        ? `<div class="pace-marker">${PACE_PROFILES[elem.pace] ? PACE_PROFILES[elem.pace].icon : ''} ${PACE_PROFILES[elem.pace] ? PACE_PROFILES[elem.pace].label : elem.pace}</div>`
        : '';

      html += `
        ${paceMarker}
        <div class="${lineClass}" id="line-el-${index}" data-index="${index}">
          <div class="active-glow-indicator" style="display: none;"></div>
          ${contentHtml}
        </div>
      `;
    });

    pageContent.innerHTML = html;

    // Attach click to play listener on each line
    pageContent.querySelectorAll('.script-line').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index, 10);
        if (!isNaN(idx)) {
          onLineClick(idx);
        }
      });
    });

    highlightActiveLine(scriptStore.activeLineIndex, false);
  }

  /**
   * Light every line currently being spoken. More than one at a time is normal
   * once characters talk over each other.
   */
  function setActiveLines(indices, shouldScroll = true) {
    const active = (Array.isArray(indices) ? indices : [indices])
      .filter(index => Number.isInteger(index));
    const next = new Set(active);

    for (const index of activeLineSet) {
      if (next.has(index)) continue;
      const el = pageContent.querySelector(`#line-el-${index}`);
      if (!el) continue;
      el.classList.remove('active');
      const indicator = el.querySelector('.active-glow-indicator');
      if (indicator) indicator.style.display = 'none';
    }

    let scrollTarget = null;
    for (const index of active) {
      const activeEl = pageContent.querySelector(`#line-el-${index}`);
      if (!activeEl) continue;
      if (!activeLineSet.has(index)) {
        activeEl.classList.add('active');
        const indicator = activeEl.querySelector('.active-glow-indicator');
        if (indicator) indicator.style.display = 'block';
      }
      if (scrollTarget === null) scrollTarget = activeEl;
    }
    activeLineSet = next;

    // Only follow the line that opened the exchange. Chasing the second speaker
    // of an overlapping pair makes the page jitter between them.
    if (autoScrollEnabled && shouldScroll && scrollTarget) {
      scrollToActiveLine();
    }
  }

  function highlightActiveLine(index, shouldScroll = true) {
    setActiveLines([index], shouldScroll);
  }

  function scrollToActiveLine(force = false) {
    const activeEl = pageContent.querySelector('.script-line.active');
    if (!activeEl) return;

    const scrollRect = scrollArea.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();

    // Center the element in viewport
    const offset = (activeRect.top - scrollRect.top) - (scrollRect.height / 3);

    scrollArea.scrollBy({
      top: offset,
      behavior: 'smooth'
    });
  }

  // Subscribe to changes
  scriptStore.subscribe((event, data) => {
    if (event === 'scriptLoaded') {
      renderScript();
    } else if (event === 'activeLineChanged') {
      highlightActiveLine(data.index, true);
    }
  });

  return {
    element: container,
    renderScript,
    setActiveLines,
    highlightActiveLine,
    scrollToActiveLine
  };
}
