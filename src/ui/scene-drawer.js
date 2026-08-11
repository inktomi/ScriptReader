import { getIconSvg } from '../utils/icons.js';
import { escapeHtml } from '../utils/escape-html.js';

export function createSceneDrawer({
  scriptStore,
  onSelectScene,
  onClose
}) {
  const drawer = document.createElement('aside');
  drawer.className = 'scene-drawer collapsed';

  function render() {
    const script = scriptStore.currentScript;
    const scenes = script ? script.scenes : [];

    drawer.innerHTML = `
      <div class="sidebar-header">
        <div class="sidebar-title">
          ${getIconSvg('layers', 18)}
          <span>Scene Navigator (${scenes.length})</span>
        </div>
        <button class="btn-icon btn-close-scenes" title="Close Scene Navigator">
          ${getIconSvg('close', 16)}
        </button>
      </div>

      <div class="cast-scroll-area">
        ${scenes.length === 0 ? `
          <div style="text-align: center; color: var(--text-muted); padding: 40px 10px;">
            No scenes detected in this script.
          </div>
        ` : ''}

        ${scenes.map(s => `
          <div class="character-card scene-nav-card" data-index="${s.lineIndex}">
            <div style="display: flex; align-items: flex-start; gap: 10px;">
              <span style="font-size: 0.75rem; font-weight: 700; background: rgba(6, 182, 212, 0.15); color: #06B6D4; padding: 2px 6px; border-radius: 4px; font-family: var(--font-mono);">
                #${s.number}
              </span>
              <div style="flex: 1;">
                <div style="font-weight: 700; font-size: 0.85rem; color: #FFFFFF;">${escapeHtml(s.title)}</div>
                <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 4px;">Line ${s.lineIndex + 1}</div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    const closeBtn = drawer.querySelector('.btn-close-scenes');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        close();
      });
    }

    drawer.querySelectorAll('.scene-nav-card').forEach(card => {
      card.addEventListener('click', () => {
        const lineIdx = parseInt(card.dataset.index, 10);
        if (!isNaN(lineIdx)) {
          onSelectScene(lineIdx);
        }
      });
    });
  }

  function open() {
    drawer.classList.remove('collapsed');
  }

  function close() {
    drawer.classList.add('collapsed');
    if (onClose) {
      onClose();
    }
  }

  function toggle() {
    const isCollapsed = drawer.classList.toggle('collapsed');
    if (isCollapsed && onClose) {
      onClose();
    }
    return !isCollapsed; // returns true if now open
  }

  scriptStore.subscribe((event) => {
    if (event === 'scriptLoaded') {
      render();
    }
  });

  render();

  return {
    element: drawer,
    render,
    open,
    close,
    toggle,
    isOpen: () => !drawer.classList.contains('collapsed')
  };
}
