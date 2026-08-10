import { getIconSvg } from '../utils/icons.js';

export function createScriptTeleprompter({
  scriptStore,
  audioManager,
  onLineClick
}) {
  const container = document.createElement('main');
  container.className = 'screenplay-viewport';

  let autoScrollEnabled = true;

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
        <div class="script-title-text">${script.title.toUpperCase()}</div>
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
              <span>${elem.text}</span>
              <span style="font-size: 0.7rem; font-family: var(--font-ui); color: #0284C7; font-weight: 600;">SCENE ${elem.sceneNumber}</span>
            </div>
          `;
          break;

        case 'ACTION':
          lineClass += ' action';
          contentHtml = elem.text;
          break;

        case 'CHARACTER':
        case 'DIALOGUE':
          lineClass += ' dialogue';
          const directionTag = elem.parenthetical ? `
            <div class="script-line parenthetical" style="padding-left: 0; padding-right: 0;">
              (${elem.parenthetical})
            </div>
          ` : '';

          const emotionBadge = nuance.emotionKey && nuance.emotionKey !== 'neutral' ? `
            <span class="emotion-badge" style="background: ${nuance.badgeColor}22; border-color: ${nuance.badgeColor}66; color: ${nuance.badgeColor};">
              ${nuance.emotionIcon || '🎭'} ${nuance.emotionLabel || nuance.emotionKey}
            </span>
          ` : '';

          contentHtml = `
            <div class="script-line character-cue" style="padding-left: 0; padding-right: 0; margin-top: 0;">
              <span>${elem.characterOriginal || elem.character}</span>
              ${emotionBadge}
            </div>
            ${directionTag}
            <div>${elem.text}</div>
          `;
          break;

        case 'TRANSITION':
          lineClass += ' transition';
          contentHtml = elem.text;
          break;

        default:
          lineClass += ' action';
          contentHtml = elem.text;
      }

      html += `
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

  function highlightActiveLine(index, shouldScroll = true) {
    pageContent.querySelectorAll('.script-line').forEach(el => {
      el.classList.remove('active');
      const indicator = el.querySelector('.active-glow-indicator');
      if (indicator) indicator.style.display = 'none';
    });

    const activeEl = pageContent.querySelector(`#line-el-${index}`);
    if (activeEl) {
      activeEl.classList.add('active');
      const indicator = activeEl.querySelector('.active-glow-indicator');
      if (indicator) indicator.style.display = 'block';

      if (autoScrollEnabled && shouldScroll) {
        scrollToActiveLine();
      }
    }
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
    highlightActiveLine,
    scrollToActiveLine
  };
}
