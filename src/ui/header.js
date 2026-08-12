import { getIconSvg } from '../utils/icons.js';
import { ENGINE_TYPES } from '../audio/audio-manager.js';

export function createHeader({
  onChangeScript,
  onOpenVoiceConfig,
  onShowLibrary,
  onToggleHelp,
  onOpenEngineSettings,
  currentEngine = ENGINE_TYPES.KOKORO_NEURAL
}) {
  const header = document.createElement('header');
  header.className = 'app-header';

  header.innerHTML = `
    <div class="header-left">
      <button id="btn-library" class="btn btn-quiet btn-library" type="button" title="Open library (C for cast, S for scenes)">
        ${getIconSvg('layers', 17)}
        <span>Library</span>
      </button>
      <div class="header-brand" aria-label="ScriptReader">
        <span class="wordmark-mark">${getIconSvg('book', 17)}</span>
        <span>ScriptReader</span>
      </div>
    </div>

    <div class="header-script">
      <strong id="header-script-title">No screenplay loaded</strong>
      <span id="header-script-detail">Listening room</span>
    </div>

    <div class="header-actions">
      <button id="btn-change-script" class="btn btn-quiet" type="button">
        ${getIconSvg('file', 15)}
        <span>Change script</span>
      </button>
      <button id="btn-voice-setup" class="btn btn-secondary" type="button" title="Edit voice cast (V)">
        ${getIconSvg('users', 15)}
        <span>Cast</span>
      </button>
      <button id="engine-status-badge" class="engine-badge" type="button" title="Voice engine settings">
        ${getIconSvg('cpu', 14)}
        <span id="engine-badge-text">Local voices</span>
      </button>
      <button id="btn-help" class="btn-icon" type="button" title="Help and keyboard shortcuts (?)">
        ${getIconSvg('help', 17)}
      </button>
    </div>
  `;

  header.querySelector('#btn-change-script').addEventListener('click', onChangeScript);
  header.querySelector('#btn-voice-setup').addEventListener('click', onOpenVoiceConfig);
  header.querySelector('#btn-library').addEventListener('click', () => onShowLibrary('cast'));
  header.querySelector('#engine-status-badge').addEventListener('click', onOpenEngineSettings);
  header.querySelector('#btn-help').addEventListener('click', onToggleHelp);

  function setScript(script) {
    const title = header.querySelector('#header-script-title');
    const detail = header.querySelector('#header-script-detail');
    title.textContent = script ? script.title : 'No screenplay loaded';
    detail.textContent = script
      ? `${script.scenes.length} scenes · ${script.characters.length} speaking roles`
      : 'Listening room';
  }

  function setEngineBadge(engineId) {
    const badgeText = header.querySelector('#engine-badge-text');
    const badge = header.querySelector('#engine-status-badge');
    if (!badgeText || !badge) return false;

    const isCloud = engineId === ENGINE_TYPES.OPENAI;
    const isStudio = engineId === ENGINE_TYPES.CHATTERBOX;
    badgeText.textContent = isCloud ? 'Cloud voices' : (isStudio ? 'Studio Local' : 'Local voices');
    badge.classList.toggle('is-cloud', isCloud);
    badge.title = isCloud
      ? 'OpenAI voices — dialogue is sent to OpenAI. Click to change.'
      : (isStudio
        ? 'Chatterbox Studio voices — generated privately on this device. Click to change.'
        : 'Kokoro voices — screenplay audio is generated on this device. Click to change.');
  }

  /**
   * Upgrade the badge to say "ready offline" once the weights really are local.
   *
   * The two local engines answer that question differently — Kokoro from a single
   * cached blob, Studio Local from an eight-file install — so each gets its own
   * branch rather than one inheriting the other's status.
   */
  function updateEngineCacheBadge({ isModelCached, isFullyCached, engineId, studioInstalled }) {
    setEngineBadge(engineId);
    const badgeText = header.querySelector('#engine-badge-text');
    if (!badgeText) return;

    if (engineId === ENGINE_TYPES.CHATTERBOX) {
      if (studioInstalled) badgeText.textContent = 'Studio · ready offline';
      return;
    }
    if (engineId !== ENGINE_TYPES.KOKORO_NEURAL) return;
    if (isFullyCached || isModelCached) badgeText.textContent = 'Local · ready offline';
  }

  setEngineBadge(currentEngine);

  return {
    element: header,
    setScript,
    updateEngineCacheBadge,
    setEngineBadge,
    setSelectedSample: () => {}
  };
}
