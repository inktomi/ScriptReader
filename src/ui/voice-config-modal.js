import {
  hasChatterboxVoiceSample,
  listChatterboxVoices,
  saveChatterboxVoice,
} from '../audio/chatterbox-voice-store.js';
import { ENGINE_IDS } from '../audio/engine-contract.js';
import { formatPitchOffset } from '../audio/performance-director.js';
import {
  getDefaultNarratorVoice,
  getSuggestedVoiceForCharacter,
  getVoiceById,
  getVoicesForEngine,
  makeDefaultAssignment,
  mapVoiceAcrossEngines,
} from '../audio/voice-catalog.js';
import { gradeColor, gradeLabel, KOKORO_GRADES } from '../audio/voice-grades.js';
import { escapeHtml } from '../utils/escape-html.js';
import { createFocusPreservingRenderer } from '../utils/focus-preserving-render.js';
import { getIconSvg } from '../utils/icons.js';
import { createVoiceSampleCatalogModal } from './voice-sample-catalog-modal.js';

export function createVoiceConfigModal({
  scriptStore,
  audioManager,
  onSave,
  onCancel,
  onOpenEngineSettings,
  isInitialSetup = false,
}) {
  const modal = document.createElement('div');
  modal.className = isInitialSetup ? 'casting-screen' : 'modal-overlay voice-config-modal-overlay';

  const script = scriptStore.currentScript;
  const characters = script ? [...script.characters].sort((a, b) => b.lineCount - a.lineCount) : [];
  const scriptTitle = script ? script.title : 'Screenplay';
  const totalLines = script ? script.elements.length : 0;
  const totalDialogue = characters.reduce((sum, c) => sum + c.lineCount, 0) || 1;
  const engineId = audioManager.engineId;
  const isStudio = engineId === ENGINE_IDS.CHATTERBOX;
  const isRunPod = engineId === ENGINE_IDS.RUNPOD;
  const hasReferenceVoices = isStudio || isRunPod;
  const isHybrid = isStudio && audioManager.hybridCasting;
  const narratorEngineId = isHybrid ? ENGINE_IDS.KOKORO : engineId;
  let enginePool = getVoicesForEngine(engineId);
  let narratorPool = getVoicesForEngine(narratorEngineId);

  // Local working copy of assignments so user can edit, preview, and cancel if desired
  const storedNarratorVoiceId = scriptStore.getNarratorVoice(narratorEngineId);
  let workingNarratorVoiceId = narratorPool.some((v) => v.id === storedNarratorVoiceId)
    ? storedNarratorVoiceId
    : narratorPool[0]?.id || audioManager.getVoiceProfileForCharacter('NARRATOR', narratorEngineId).id;
  const workingAssignments = new Map();

  for (const char of characters) {
    const key = char.name.toUpperCase().trim();
    const existing = scriptStore.castAssignments.get(key);
    if (existing) {
      workingAssignments.set(key, { ...existing });
    } else {
      workingAssignments.set(key, makeDefaultAssignment());
    }
  }

  let currentlyPlayingChar = null;
  let auditionPhase = 'idle'; // 'idle' | 'preparing' | 'rendering' | 'playing' | 'error'
  let auditionGeneration = 0;
  // Which introductions the user has expanded. Held out here rather than read
  // back off the DOM because every voice change rebuilds these cards, and an
  // expansion the user opened must survive that.
  const expandedIntros = new Set();
  const openAdvanced = new Set();
  let setupMode = isInitialSetup ? 'choice' : 'detailed';
  let studioVoiceError = '';
  let addingStudioVoice = false;
  let catalogDialog = null;
  let openingCatalog = false;
  let closed = false;

  const focusRenderer = createFocusPreservingRenderer(modal, {
    scrollSelectors: ['.voice-config-body', '.modal-body', ':scope'],
    keepFocusInside: () => modal.isConnected && !closed,
    fallback: ({ snapshot, findByIdentity, focusables }) => {
      const identity = snapshot.focus.identity;
      if (identity.startsWith('key:char-')) {
        const rest = identity.slice('key:char-'.length);
        const colonIdx = rest.indexOf(':');
        if (colonIdx !== -1) {
          const type = rest.slice(0, colonIdx);
          const afterType = rest.slice(colonIdx + 1);
          const charName = type === 'tone' ? afterType.slice(0, afterType.lastIndexOf(':')) : afterType;
          const fallbackSelect = findByIdentity(`key:char-voice:${charName}`);
          if (fallbackSelect) return fallbackSelect;
        }
      }
      return (
        findByIdentity('id:btn-modal-save') ||
        findByIdentity('id:casting-path-recommended') ||
        findByIdentity('id:btn-casting-engine') ||
        focusables()[0]
      );
    },
  });

  function syncLiveInputs() {
    modal.querySelectorAll('.voice-advanced').forEach((details) => {
      const charName = details.dataset.char;
      if (!charName) return;
      const charKey = charName.toUpperCase().trim();
      if (details.open) openAdvanced.add(charKey);
      else openAdvanced.delete(charKey);
    });
    modal.querySelectorAll('.modal-direction-input').forEach((field) => {
      const charName = field.dataset.char;
      if (!charName) return;
      const charKey = charName.toUpperCase().trim();
      const existing = workingAssignments.get(charKey);
      if (existing) {
        existing.direction = field.value;
      }
    });
  }

  // The casting UI has to show the pool the *active* engine can actually speak
  // with; the two id spaces are disjoint.
  const supportsDirection = audioManager.capabilities.supportsInstructions;

  /** This character's voice under the active engine, falling back to the legacy field. */
  function voiceIdOf(assignment) {
    const candidate = (assignment.voiceIds && assignment.voiceIds[engineId]) || assignment.voiceId;
    if ((isStudio || isRunPod) && !enginePool.some((voice) => voice.id === candidate)) return enginePool[0]?.id || '';
    return candidate;
  }

  /**
   * Honest quality badge, derived from upstream's grade rather than from a stored
   * label. The Kokoro pool is graded; the OpenAI pool is not, so it says what it
   * is instead of inventing a tier.
   */
  function qualityBadge(voiceId, forEngineId = engineId) {
    if (forEngineId === ENGINE_IDS.CHATTERBOX) return voiceId ? 'Studio reference' : 'Reference needed';
    if (forEngineId === ENGINE_IDS.RUNPOD) {
      if (
        voiceId &&
        !voiceId.startsWith('af_') &&
        !voiceId.startsWith('am_') &&
        !voiceId.startsWith('bf_') &&
        !voiceId.startsWith('bm_') &&
        !voiceId.startsWith('zf_') &&
        !voiceId.startsWith('zm_')
      ) {
        return 'Studio reference';
      }
      const grade = KOKORO_GRADES[voiceId];
      return grade ? `Kokoro · ${grade}` : 'RunPod GPU';
    }
    const grade = KOKORO_GRADES[voiceId];
    return grade ? `${gradeLabel(voiceId)} · ${grade}` : forEngineId === ENGINE_IDS.KOKORO ? 'Kokoro Neural' : 'Cloud';
  }

  function buildVoiceOptions(selectedId, pool = enginePool) {
    if (pool.length === 0) {
      return '<option value="">Add a reference voice first</option>';
    }
    const femaleVoices = pool.filter((v) => v.sex === 'Female');
    const maleVoices = pool.filter((v) => v.sex === 'Male');
    const neutralVoices = pool.filter((v) => v.sex === 'Neutral');

    const buildGroup = (label, voices) =>
      voices.length === 0
        ? ''
        : `
      <optgroup label="${label}">
        ${voices
          .map(
            (v) => `
          <option value="${v.id}" ${v.id === selectedId ? 'selected' : ''}>
            ${escapeHtml(v.name)} (${escapeHtml(v.sex)} ${escapeHtml(v.ageGroup)} • ${escapeHtml(v.accent)}) - ${escapeHtml(v.tone.split(',')[0])}
          </option>
        `,
          )
          .join('')}
      </optgroup>
    `;

    return (
      buildGroup('Female voices', femaleVoices) +
      buildGroup('Male voices', maleVoices) +
      buildGroup('Neutral voices', neutralVoices)
    );
  }

  /**
   * How the screenplay introduces this character — the fact somebody choosing a
   * voice actually wants, and one this app used to walk straight past. It is the
   * writer's own words, so it is escaped like every other value lifted out of an
   * uploaded script.
   *
   * Both halves are rendered up front and the toggle only flips `hidden`. This
   * view rebuilds its entire subtree on every voice change, so a control that
   * re-rendered to expand would collapse itself the next time anyone touched a
   * dropdown, and would drop keyboard focus while doing it.
   */
  function characterIntroHtml(char, charAttr, index) {
    const intro = char.introduction;
    if (!intro || !intro.text) return '';

    const source = intro.sourceText && intro.sourceText !== intro.text ? intro.sourceText : '';
    const expanded = expandedIntros.has(char.name.toUpperCase().trim());
    const sourceId = `char-intro-source-${index}`;

    return `
      <div class="char-intro">
        <p class="char-intro-text">${escapeHtml(intro.text)}</p>
        ${
          source
            ? `
          <button type="button" class="char-intro-toggle" data-char="${charAttr}" data-focus-key="char-intro:${charAttr}"
                  aria-expanded="${expanded}" aria-controls="${sourceId}">
            ${getIconSvg('chevronRight', 12)} As written
          </button>
          <p class="char-intro-source" id="${sourceId}" ${expanded ? '' : 'hidden'}>${escapeHtml(source)}</p>
        `
            : ''
        }
      </div>
    `;
  }

  function applyRecommendedCast() {
    if (isStudio && enginePool.length === 0) return;
    const localNarrator = getDefaultNarratorVoice().id;
    const activeIsHybrid = isStudio && audioManager.hybridCasting;
    const activeNarratorEngine = activeIsHybrid ? ENGINE_IDS.KOKORO : engineId;
    workingNarratorVoiceId =
      activeNarratorEngine === ENGINE_IDS.KOKORO
        ? localNarrator
        : mapVoiceAcrossEngines(localNarrator, activeNarratorEngine);
    const usedLocalVoices = new Set([localNarrator]);
    const usedEngineVoices = new Set([workingNarratorVoiceId]);

    for (const char of characters) {
      const localVoiceId = getSuggestedVoiceForCharacter(char.name, {
        sampleLine: char.sampleLine,
        introduction: char.introduction,
        usedVoices: usedLocalVoices,
      });
      usedLocalVoices.add(localVoiceId);
      const suggestedVoiceId =
        engineId === ENGINE_IDS.KOKORO ? localVoiceId : mapVoiceAcrossEngines(localVoiceId, engineId, usedEngineVoices);
      usedEngineVoices.add(suggestedVoiceId);
      const key = char.name.toUpperCase().trim();
      const existing = workingAssignments.get(key) || makeDefaultAssignment(localVoiceId);
      workingAssignments.set(key, {
        ...existing,
        voiceId: engineId === ENGINE_IDS.KOKORO ? suggestedVoiceId : existing.voiceId,
        voiceIds: { ...(existing.voiceIds || {}), [engineId]: suggestedVoiceId },
        pitchOffset: 0,
        speedMultiplier: 1.0,
        tonePreset: 'natural',
        auto: true,
      });
    }
  }

  function renderContent() {
    if (closed) return;
    focusRenderer.render(() => {
      syncLiveInputs();
      enginePool = getVoicesForEngine(engineId);
      const activeIsHybrid = isStudio && audioManager.hybridCasting;
      const activeNarratorEngine = activeIsHybrid ? ENGINE_IDS.KOKORO : engineId;
      narratorPool = getVoicesForEngine(activeNarratorEngine);

      if (!narratorPool.some((voice) => voice.id === workingNarratorVoiceId)) {
        const stored = scriptStore.getNarratorVoice(activeNarratorEngine);
        workingNarratorVoiceId = narratorPool.some((v) => v.id === stored) ? stored : narratorPool[0]?.id || 'af_heart';
      }

      if (isStudio && enginePool.length > 0) {
        characters.forEach((char, index) => {
          const key = char.name.toUpperCase().trim();
          const assignment = workingAssignments.get(key) || makeDefaultAssignment();
          const savedStudioVoice = assignment.voiceIds?.[engineId];
          if (!enginePool.some((voice) => voice.id === savedStudioVoice)) {
            const voiceId = enginePool[index % enginePool.length].id;
            workingAssignments.set(key, {
              ...assignment,
              voiceIds: { ...(assignment.voiceIds || {}), [engineId]: voiceId },
            });
          }
        });
      }
      const narratorProfile = getVoiceById(workingNarratorVoiceId, activeNarratorEngine);
      const studioCastReady =
        !isStudio ||
        (enginePool.length > 0 &&
          !!workingNarratorVoiceId &&
          characters.every((char) => {
            const assignment = workingAssignments.get(char.name.toUpperCase().trim()) || {};
            return enginePool.some((voice) => voice.id === voiceIdOf(assignment));
          }));

      modal.innerHTML = `
        ${
          isInitialSetup
            ? `
          <div class="workflow-header">
            <a class="wordmark" href="#" aria-label="ScriptReader">
              <span class="wordmark-mark">${getIconSvg('book', 17)}</span>
              <span>ScriptReader</span>
            </a>
            <nav class="workflow-steps" aria-label="Setup progress">
              <span class="is-complete">${getIconSvg('check', 13)} Script</span>
              <i></i>
              <span class="is-active">2 Cast</span>
              <i></i>
              <span>3 Listen</span>
            </nav>
            <span class="workflow-privacy">Local by default</span>
          </div>
        `
            : ''
        }
        <div class="modal-card voice-config-card">
          <!-- Header -->
          <div class="modal-header voice-config-header">
            <div style="display: flex; align-items: center; gap: 14px;">
              <div class="brand-badge" style="width: 44px; height: 44px; border-radius: 12px; font-size: 1.25rem;">
                ${getIconSvg('mic', 20)}
              </div>
              <div>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <h2 style="font-size: 1.25rem; font-weight: 800; color: #FFFFFF; letter-spacing: -0.01em;">
                    ${isInitialSetup ? 'Cast your screenplay' : 'Edit voice cast'}
                  </h2>
                  <span class="brand-tag" style="font-size: 0.7rem;">${characters.length} roles</span>
                </div>
                <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
                  <span class="script-summary-title">${escapeHtml(scriptTitle)}</span> · ${totalLines} elements · ${totalDialogue} dialogue cues
                </div>
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 8px;">
              ${
                !isInitialSetup
                  ? `
                <button id="btn-modal-autocast" class="btn btn-secondary" style="padding: 6px 12px; font-size: 0.8rem;" title="Reset to recommended voices">
                  ${getIconSvg('replay', 14)}
                  <span>Recommended cast</span>
                </button>
                <button id="btn-close-voice-modal" class="btn-icon btn-close-voice-modal" title="Close" data-focus-key="close-voice-modal">
                  ${getIconSvg('close', 18)}
                </button>
              `
                  : ''
              }
            </div>
          </div>

          <!-- Body -->
          <div class="modal-body voice-config-body">
            <div class="casting-engine">
              <div>
                ${getIconSvg('cpu', 17)}
                <span>
                  <strong>${
                    engineId === ENGINE_IDS.OPENAI
                      ? 'OpenAI cloud voices'
                      : isRunPod
                        ? 'RunPod Serverless GPU (L40S)'
                        : isStudio
                          ? 'Studio Local · Chatterbox'
                          : 'Kokoro local voices'
                  }</strong>
                  <small>${
                    engineId === ENGINE_IDS.OPENAI
                      ? 'Dialogue is sent to OpenAI for synthesis.'
                      : isRunPod
                        ? 'High-speed Chatterbox and Kokoro neural synthesis on dedicated NVIDIA L40S GPUs.'
                        : isStudio
                          ? 'Highest-quality local voices cloned from private reference recordings.'
                          : 'Audio is generated on this device. Your screenplay stays local.'
                  }</small>
                </span>
              </div>
              <button id="btn-casting-engine" class="btn btn-quiet" type="button">Change engine</button>
            </div>

            ${
              hasReferenceVoices
                ? `
              <section class="studio-voice-library" aria-labelledby="studio-voice-title">
                <div>
                  <span class="eyebrow">Private voice library</span>
                  <strong id="studio-voice-title">${(() => {
                    const refCount = listChatterboxVoices().length;
                    return refCount
                      ? `${refCount} reference voice${refCount === 1 ? '' : 's'} available`
                      : 'Add your first reference voice';
                  })()}</strong>
                  <small>Use a clean 5–10 second recording with one speaker and little background noise. Stored only in this browser.</small>
                </div>
                <div class="studio-voice-actions">
                  <button id="btn-find-studio-voice" class="btn btn-primary" type="button">
                    ${getIconSvg('search', 15)} Find a voice
                  </button>
                  <label class="btn btn-secondary studio-add-voice ${addingStudioVoice ? 'is-loading' : ''}">
                    ${getIconSvg('upload', 15)} ${addingStudioVoice ? 'Adding voice…' : 'Upload your own'}
                    <input id="studio-voice-file" type="file" accept="audio/*,.wav,.mp3,.m4a,.ogg" ${addingStudioVoice ? 'disabled' : ''}>
                  </label>
                </div>
                <p>Only clone a voice you own or have permission to use.</p>
                ${studioVoiceError ? `<div class="studio-voice-error" role="alert">${escapeHtml(studioVoiceError)}</div>` : ''}
              </section>
            `
                : ''
            }

            ${
              setupMode === 'choice'
                ? `
              <div class="casting-choice">
                <div class="casting-choice-copy">
                  <div class="eyebrow">Choose your level of control</div>
                  <h3>Start quickly or direct every performance.</h3>
                  <p>Both paths can be adjusted later from the listening room.</p>
                </div>
                <div class="casting-choice-grid">
                  <button class="casting-path is-recommended" id="casting-path-recommended" type="button" ${isStudio && enginePool.length === 0 ? 'disabled' : ''}>
                    <span class="path-icon">${getIconSvg('sparkles', 20)}</span>
                    <span><strong>Use recommended cast</strong><small>${
                      isStudio && enginePool.length === 0
                        ? 'Add at least one reference voice to create a Studio cast.'
                        : 'Assign distinct voices automatically, then review them before listening.'
                    }</small></span>
                    <em>Fastest</em>
                    ${getIconSvg('chevronRight', 18)}
                  </button>
                  <button class="casting-path" id="casting-path-custom" type="button">
                    <span class="path-icon">${getIconSvg('sliders', 20)}</span>
                    <span><strong>Customize every role</strong><small>Audition voices and fine-tune pitch, pace, tone, and direction.</small></span>
                    ${getIconSvg('chevronRight', 18)}
                  </button>
                </div>
              </div>
            `
                : `
              <div class="voice-config-instruction">
                ${getIconSvg('volume', 16)}
                <div>
                  ${
                    setupMode === 'review'
                      ? 'A recommended cast is ready. Audition any role, change a voice, or continue to the listening room.'
                      : 'Audition each role and open Advanced only when you want to shape the performance.'
                  }
                </div>
                ${isInitialSetup ? `<button id="casting-change-path" class="text-button" type="button">Choose another path</button>` : ''}
              </div>

            <!-- NARRATOR SECTION -->
            <div class="voice-config-section-title">
              <span>Stage & Action Direction</span>
            </div>

            <div class="voice-card narrator-config-card ${currentlyPlayingChar === 'NARRATOR' ? 'is-previewing' : ''}">
              <div class="voice-card-header">
                <div class="char-avatar" style="background: linear-gradient(135deg, #F59E0B, #B45309); width: 44px; height: 44px; font-size: 1.2rem;">
                  ${getIconSvg('mic', 18)}
                </div>
                <div style="flex: 1;">
                  <div style="display: flex; align-items: center; justify-content: space-between;">
                    <span style="font-weight: 800; font-size: 1rem;">Narrator</span>
                    <span class="badge-voice" style="background: rgba(245, 158, 11, 0.15); color: #F59E0B; border: 1px solid rgba(245, 158, 11, 0.3);">
                      ${escapeHtml(activeIsHybrid ? `Kokoro Neural · ${qualityBadge(narratorProfile.id, ENGINE_IDS.KOKORO)}` : qualityBadge(narratorProfile.id, engineId))}
                    </span>
                  </div>
                  <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 2px;">
                    Reads scene headings, physical action blocks, and cinematic descriptions${activeIsHybrid ? ' (Kokoro Neural)' : ''}
                  </div>
                </div>
              </div>

              <div class="voice-card-controls">
                <div class="voice-select-row">
                  <select class="voice-select modal-narrator-select" id="modal-narrator-select" data-focus-key="narrator-select" style="font-weight: 500;" ${narratorPool.length === 0 ? 'disabled' : ''}>
                    ${buildVoiceOptions(workingNarratorVoiceId, narratorPool)}
                  </select>
                  <button class="btn btn-secondary btn-audition-narrator ${currentlyPlayingChar === 'NARRATOR' ? (auditionPhase === 'playing' ? 'btn-active' : 'is-loading') : ''}"
                          id="btn-audition-narrator"
                          data-focus-key="narrator-audition"
                          style="padding: 7px 14px; white-space: nowrap; ${currentlyPlayingChar === 'NARRATOR' && auditionPhase === 'rendering' ? 'background: rgba(245, 158, 11, 0.15); border-color: rgba(245, 158, 11, 0.4); color: #F59E0B;' : ''}"
                          ${narratorPool.length === 0 ? 'disabled' : ''}>
                    ${
                      currentlyPlayingChar === 'NARRATOR'
                        ? auditionPhase === 'preparing'
                          ? `${getIconSvg('replay', 14, 'spin-icon')} Loading model…`
                          : auditionPhase === 'rendering'
                            ? `${getIconSvg('sparkles', 14, 'pulse-icon')} Synthesizing…`
                            : `${getIconSvg('stop', 15)} Stop`
                        : `${getIconSvg('volume', 15)} Listen`
                    }
                  </button>
                </div>

                <div class="voice-desc-pill">
                  <strong>${escapeHtml(narratorProfile.name)}:</strong> ${escapeHtml(narratorProfile.tone)} • ${escapeHtml(narratorProfile.description)}
                </div>
              </div>
            </div>

            <!-- SPEAKING CAST SECTION -->
            <div class="voice-config-section-title" style="margin-top: 24px;">
              <span>Speaking Characters (${characters.length})</span>
            </div>

            <div class="voice-cards-grid">
              ${characters
                .map((char, charIndex) => {
                  const charKey = char.name.toUpperCase().trim();
                  const assignment = workingAssignments.get(charKey) || makeDefaultAssignment();
                  const voiceProfile = getVoiceById(voiceIdOf(assignment), engineId);
                  const percent = Math.round((char.lineCount / totalDialogue) * 100);
                  const isPlaying = currentlyPlayingChar === charKey;

                  // Character name and sample line both come from the uploaded
                  // script. Escaped in `data-char` too, where an unescaped quote
                  // would close the attribute and let the rest of the cue become
                  // markup; the parser decodes it back, so `dataset.char` still
                  // matches the key the assignments map uses.
                  const charAttr = escapeHtml(char.name);

                  return `
                  <div class="voice-card ${isPlaying ? 'is-previewing' : ''}" data-char="${charAttr}">
                    <div class="voice-card-header">
                      <div class="char-avatar" style="background: ${voiceProfile.avatarBg}; width: 42px; height: 42px;">
                        ${escapeHtml(char.name.substring(0, 2).toUpperCase())}
                      </div>
                      <div style="flex: 1; min-width: 0;">
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
                          <span class="char-name" style="font-size: 0.95rem;">${escapeHtml(char.name)}</span>
                          <span style="display: flex; align-items: center; gap: 5px; flex-shrink: 0;">
                            ${char.introduction?.age ? `<span class="badge-age" title="Age, as written in the screenplay">${escapeHtml(char.introduction.age)}</span>` : ''}
                            <span class="badge-lines">${char.lineCount} lines (${percent}%)</span>
                          </span>
                        </div>
                        <div style="font-size: 0.75rem; color: #06B6D4; font-weight: 600; margin-top: 1px;">
                          ${escapeHtml(voiceProfile.name)} • ${escapeHtml(voiceProfile.sex)} ${escapeHtml(voiceProfile.accent)}
                          <span style="color: ${gradeColor(voiceProfile.id)}; font-weight: 700;">
                            · ${escapeHtml(qualityBadge(voiceProfile.id))}
                          </span>
                        </div>
                      </div>
                    </div>

                    <!-- How the screenplay introduces this character -->
                    ${characterIntroHtml(char, charAttr, charIndex)}

                    <!-- Character Sample Line Quote -->
                    <div class="char-sample-quote" title="Excerpt from screenplay">
                      "${escapeHtml(char.sampleLine || 'Ready for readthrough.')}"
                    </div>

                    ${
                      isPlaying && (auditionPhase === 'rendering' || auditionPhase === 'preparing')
                        ? `
                      <div class="audition-progress-hint" style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 6px; margin: 8px 0 4px; font-size: 0.76rem; color: #F59E0B;">
                        <span class="pulse-icon">${getIconSvg('sparkles', 14)}</span>
                        <span>${auditionPhase === 'preparing' ? (isRunPod ? 'Connecting to RunPod GPU…' : 'Loading neural voice model into memory…') : isRunPod ? 'Synthesizing with RunPod GPU…' : 'Generating custom performance with Studio Local…'}</span>
                      </div>
                    `
                        : ''
                    }

                    <!-- Voice Selection Row -->
                    <div class="voice-card-controls">
                      <div class="voice-select-row">
                        <select class="voice-select modal-char-select" data-char="${charAttr}" data-focus-key="char-voice:${charAttr}" ${enginePool.length === 0 ? 'disabled' : ''}>
                          ${buildVoiceOptions(voiceIdOf(assignment))}
                        </select>
                        <button class="btn btn-secondary btn-audition-char ${isPlaying ? (auditionPhase === 'playing' ? 'btn-active' : 'is-loading') : ''}"
                                data-char="${charAttr}"
                                data-focus-key="char-audition:${charAttr}"
                                style="padding: 7px 12px; white-space: nowrap; ${isPlaying && auditionPhase === 'rendering' ? 'background: rgba(245, 158, 11, 0.15); border-color: rgba(245, 158, 11, 0.4); color: #F59E0B;' : ''}"
                                ${enginePool.length === 0 ? 'disabled' : ''}>
                          ${
                            isPlaying
                              ? auditionPhase === 'preparing'
                                ? `${getIconSvg('replay', 14, 'spin-icon')} Loading…`
                                : auditionPhase === 'rendering'
                                  ? `${getIconSvg('sparkles', 14, 'pulse-icon')} Synthesizing…`
                                  : `${getIconSvg('stop', 14)} Stop`
                              : `${getIconSvg('volume', 14)} Listen`
                          }
                        </button>
                      </div>

                      <details class="voice-advanced" ${openAdvanced.has(charKey) ? 'open' : ''} data-char="${charAttr}">
                        <summary data-focus-key="char-advanced:${charAttr}">${getIconSvg('sliders', 13)} Advanced performance controls</summary>
                        <div class="voice-advanced-body">
                      <div class="voice-tone-tag">
                        <span>${escapeHtml(voiceProfile.tone)}</span>
                      </div>

                      <div class="voice-sliders-container">
                        <div class="slider-group">
                          <span class="slider-label">Pitch:</span>
                          <input type="range" class="slider-input modal-pitch-slider" data-char="${charAttr}" data-focus-key="char-pitch:${charAttr}" min="-50" max="50" value="${assignment.pitchOffset || 0}">
                          <span class="slider-val modal-pitch-val">${formatPitchOffset(assignment.pitchOffset)}</span>
                        </div>

                        <div class="slider-group">
                          <span class="slider-label">Speed:</span>
                          <input type="range" class="slider-input modal-speed-slider" data-char="${charAttr}" data-focus-key="char-speed:${charAttr}" min="50" max="150" value="${Math.round((assignment.speedMultiplier || 1.0) * 100)}">
                          <span class="slider-val modal-speed-val">${(assignment.speedMultiplier || 1.0).toFixed(1)}x</span>
                        </div>
                      </div>

                      <!-- Tone Presets -->
                      <div class="tone-presets-row">
                        <span style="font-size: 0.7rem; color: var(--text-muted); font-weight: 600;">Style:</span>
                        <button class="btn-tone-chip ${assignment.tonePreset === 'natural' ? 'active' : ''}" data-char="${charAttr}" data-preset="natural" data-focus-key="char-tone:${charAttr}:natural">Natural</button>
                        <button class="btn-tone-chip ${assignment.tonePreset === 'dramatic' ? 'active' : ''}" data-char="${charAttr}" data-preset="dramatic" data-focus-key="char-tone:${charAttr}:dramatic">Dramatic</button>
                        <button class="btn-tone-chip ${assignment.tonePreset === 'urgent' ? 'active' : ''}" data-char="${charAttr}" data-preset="urgent" data-focus-key="char-tone:${charAttr}:urgent">Urgent</button>
                        <button class="btn-tone-chip ${assignment.tonePreset === 'whispering' ? 'active' : ''}" data-char="${charAttr}" data-preset="whispering" data-focus-key="char-tone:${charAttr}:whispering">Intimate</button>
                      </div>

                      ${
                        supportsDirection
                          ? `
                        <div style="margin-top: 10px;">
                          <label style="font-size: 0.7rem; color: var(--text-muted); font-weight: 600;">
                            Direction — describe the voice in your own words
                          </label>
                          <textarea class="modal-direction-input" data-char="${charAttr}" data-focus-key="char-direction:${charAttr}" rows="2"
                            placeholder="e.g. Gravelly ex-cop, late fifties, world-weary. Never raises his voice."
                            style="width: 100%; margin-top: 4px; padding: 7px 9px; border-radius: 6px; resize: vertical;
                                   background: rgba(255,255,255,0.04); color: var(--text-primary, #fff);
                                   border: 1px solid rgba(255,255,255,0.12); font-size: 0.78rem;
                                   font-family: inherit; line-height: 1.45;"
                          >${escapeHtml(assignment.direction || '')}</textarea>
                        </div>
                      `
                          : ''
                      }
                        </div>
                      </details>
                    </div>
                  </div>
                `;
                })
                .join('')}
            </div>
            `
            }
          </div>

          <!-- Footer -->
          <div class="modal-footer voice-config-footer">
            <div style="display: flex; align-items: center; gap: 8px; font-size: 0.8rem; color: var(--text-secondary);">
              ${getIconSvg('check', 14)}
              <span>Voice choices and listening position are saved on this device.</span>
            </div>

            <div style="display: flex; align-items: center; gap: 12px;">
              <button id="btn-modal-cancel" class="btn btn-quiet">
                ${isInitialSetup ? 'Back to scripts' : 'Cancel'}
              </button>
              ${setupMode !== 'choice' ? `<button id="btn-reset-cast" class="btn btn-secondary" type="button">${getIconSvg('replay', 14)} Reset cast</button>` : ''}
              <button id="btn-modal-save" class="btn btn-primary" style="padding: 10px 24px; font-size: 0.95rem; font-weight: 700;" ${setupMode === 'choice' || !studioCastReady ? 'disabled' : ''}>
                ${getIconSvg('play', 16)}
                <span>${isInitialSetup ? 'Save cast and open player' : 'Save voice cast'}</span>
              </button>
            </div>
          </div>
        </div>
      `;

      attachEventListeners();
    });
  }

  function attachEventListeners() {
    modal.querySelector('#btn-find-studio-voice')?.addEventListener('click', async () => {
      if (catalogDialog || openingCatalog) return;
      openingCatalog = true;
      const catalogButton = modal.querySelector('#btn-find-studio-voice');
      catalogButton.disabled = true;
      const importedVoiceIds = (
        await Promise.all(
          enginePool
            .filter((voice) => voice.sourceVoiceId)
            .map(async (voice) => ((await hasChatterboxVoiceSample(voice.id)) ? voice.sourceVoiceId : '')),
        )
      ).filter(Boolean);
      openingCatalog = false;
      if (!modal.isConnected || catalogDialog) return;
      catalogDialog = createVoiceSampleCatalogModal({
        importedVoiceIds,
        getAudioSettings: () => ({ volume: audioManager.volume, isMuted: audioManager.isMuted }),
        async onAdd(file, voice, { signal } = {}) {
          const wasEmpty = enginePool.length === 0;
          const replacedVoiceIds = new Set(
            enginePool.filter((profile) => profile.sourceVoiceId === voice.id).map((profile) => profile.id),
          );
          const saved = await saveChatterboxVoice(
            file,
            voice.name,
            {
              sex: voice.gender,
              // Age and accent are deliberately left to the store's defaults. The
              // bundled catalog measures register and pace; it does not know how
              // old the reader is or where they are from, and guessing would put
              // invented biography on a real person's voice.
              tone: [voice.registerLabel, voice.paceLabel].filter(Boolean).join(' · '),
              description: voice.description,
              source: 'Voice catalog',
              sourceVoiceId: voice.id,
            },
            { signal },
          );
          // Once storage commits, assignment reconciliation is part of that
          // transaction's logical completion even if the child catalog closes.
          // Skipping it would leave the working cast pointed at deleted samples.
          if (!modal.isConnected) return;
          enginePool = getVoicesForEngine(engineId);
          if (replacedVoiceIds.has(workingNarratorVoiceId)) workingNarratorVoiceId = saved.id;
          for (const [charKey, assignment] of workingAssignments) {
            if (!replacedVoiceIds.has(assignment.voiceIds?.[engineId])) continue;
            workingAssignments.set(charKey, {
              ...assignment,
              voiceIds: { ...(assignment.voiceIds || {}), [engineId]: saved.id },
            });
          }
          if (wasEmpty) {
            applyRecommendedCast();
            if (setupMode === 'choice') setupMode = 'review';
          }
          renderContent();
        },
        onClose() {
          catalogDialog = null;
          const button = modal.querySelector('#btn-find-studio-voice');
          if (button) {
            button.disabled = false;
            button.focus();
          }
        },
      });
      document.body.appendChild(catalogDialog);
    });

    modal.querySelector('#studio-voice-file')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      addingStudioVoice = true;
      studioVoiceError = '';
      renderContent();
      try {
        await saveChatterboxVoice(file);
        enginePool = getVoicesForEngine(engineId);
        applyRecommendedCast();
        if (setupMode === 'choice') setupMode = 'review';
      } catch (error) {
        studioVoiceError = error.message || 'The reference voice could not be added.';
      } finally {
        addingStudioVoice = false;
        renderContent();
      }
    });
    // Close button
    const btnClose = modal.querySelector('.btn-close-voice-modal');
    if (btnClose) {
      btnClose.addEventListener('click', handleClose);
    }

    // Cancel button
    const btnCancel = modal.querySelector('#btn-modal-cancel');
    if (btnCancel) {
      btnCancel.addEventListener('click', handleClose);
    }

    // Save button
    const btnSave = modal.querySelector('#btn-modal-save');
    if (btnSave) {
      btnSave.addEventListener('click', handleSave);
    }

    modal.querySelector('.wordmark')?.addEventListener('click', (event) => event.preventDefault());
    modal.querySelector('#casting-path-recommended')?.addEventListener('click', () => {
      applyRecommendedCast();
      setupMode = 'review';
      renderContent();
    });
    modal.querySelector('#casting-path-custom')?.addEventListener('click', () => {
      setupMode = 'detailed';
      renderContent();
    });
    modal.querySelector('#casting-change-path')?.addEventListener('click', () => {
      setupMode = 'choice';
      renderContent();
    });
    modal.querySelector('#btn-casting-engine')?.addEventListener('click', () => {
      if (onOpenEngineSettings) onOpenEngineSettings();
    });
    modal.querySelector('#btn-reset-cast')?.addEventListener('click', () => {
      applyRecommendedCast();
      renderContent();
    });

    // Smart Auto-Cast button
    const btnAutoCast = modal.querySelector('#btn-modal-autocast');
    if (btnAutoCast) {
      btnAutoCast.addEventListener('click', () => {
        applyRecommendedCast();
        renderContent();
      });
    }

    // Narrator Voice select
    const narratorSelect = modal.querySelector('.modal-narrator-select');
    if (narratorSelect) {
      narratorSelect.addEventListener('change', (e) => {
        workingNarratorVoiceId = e.target.value;
        const activeIsHybrid = isStudio && audioManager.hybridCasting;
        const activeNarratorEngine = activeIsHybrid ? ENGINE_IDS.KOKORO : engineId;
        const sampleHeading =
          script && script.elements && script.elements[0]
            ? script.elements[0].text
            : 'EXT. OMNICORP SPIRE - NIGHT. Torrential rain lashes against the glass as the city sleeps below.';
        audioManager.prewarmAudition?.(e.target.value, sampleHeading, {}, activeNarratorEngine);
        renderContent();
      });
    }

    // Narrator Audition button
    const narratorAuditionBtn = modal.querySelector('.btn-audition-narrator');
    if (narratorAuditionBtn) {
      narratorAuditionBtn.addEventListener('click', async () => {
        if (currentlyPlayingChar === 'NARRATOR') {
          auditionGeneration++;
          audioManager.stop({ preservePrewarm: true });
          currentlyPlayingChar = null;
          auditionPhase = 'idle';
          renderContent();
          return;
        }

        const generation = ++auditionGeneration;
        currentlyPlayingChar = 'NARRATOR';
        auditionPhase = 'rendering';
        renderContent();

        const sampleHeading =
          script && script.elements && script.elements[0]
            ? script.elements[0].text
            : 'EXT. OMNICORP SPIRE - NIGHT. Torrential rain lashes against the glass as the city sleeps below.';

        const activeIsHybrid = isStudio && audioManager.hybridCasting;
        const activeNarratorEngine = activeIsHybrid ? ENGINE_IDS.KOKORO : engineId;

        const onStateChange = (phase) => {
          if (generation !== auditionGeneration) return;
          auditionPhase = phase;
          if (phase === 'idle' || phase === 'error') {
            currentlyPlayingChar = null;
          }
          renderContent();
        };

        try {
          await audioManager.previewVoice(
            workingNarratorVoiceId,
            sampleHeading,
            0,
            1.0,
            '',
            activeNarratorEngine,
            onStateChange,
          );
        } catch (e) {
          console.warn('Narrator audition error:', e);
        } finally {
          if (generation === auditionGeneration) {
            currentlyPlayingChar = null;
            auditionPhase = 'idle';
            renderContent();
          }
        }
      });
    }

    // Character Voice selects
    modal.querySelectorAll('.modal-char-select').forEach((select) => {
      select.addEventListener('change', (e) => {
        const charName = select.dataset.char;
        const charKey = charName.toUpperCase().trim();
        const existing = workingAssignments.get(charKey) || {};
        workingAssignments.set(charKey, {
          ...existing,
          // Written into this engine's slot so the character's casting on the
          // other engine survives. `voiceId` stays mirrored for the local engine
          // because saved configs and older code still read it.
          voiceIds: { ...(existing.voiceIds || {}), [engineId]: e.target.value },
          voiceId: engineId === ENGINE_IDS.KOKORO ? e.target.value : existing.voiceId,
          auto: false,
        });
        const charObj = characters.find((c) => c.name.toUpperCase().trim() === charKey);
        audioManager.prewarmAudition?.(e.target.value, charObj ? charObj.sampleLine : null, existing, engineId);
        renderContent();
      });
    });

    // Advanced details toggle listener
    modal.querySelectorAll('.voice-advanced').forEach((details) => {
      details.addEventListener('toggle', () => {
        const charName = details.dataset.char;
        if (!charName) return;
        const charKey = charName.toUpperCase().trim();
        if (details.open) openAdvanced.add(charKey);
        else openAdvanced.delete(charKey);
      });
    });

    // Introduction expanders. Deliberately no `renderContent()`: the expansion
    // is already in the DOM, so flipping `hidden` shows it without disturbing
    // focus, scroll, or a running audition. The Set keeps it open across the
    // next full re-render.
    modal.querySelectorAll('.char-intro-toggle').forEach((toggle) => {
      toggle.addEventListener('click', () => {
        const charKey = toggle.dataset.char.toUpperCase().trim();
        const source = modal.querySelector(`#${CSS.escape(toggle.getAttribute('aria-controls'))}`);
        const expanded = !expandedIntros.has(charKey);

        if (expanded) expandedIntros.add(charKey);
        else expandedIntros.delete(charKey);

        toggle.setAttribute('aria-expanded', String(expanded));
        if (source) source.hidden = !expanded;
      });
    });

    // Per-character direction. Applied on blur rather than per keystroke: the
    // text feeds the composed instructions, which feed the cache key, so saving
    // mid-word would invalidate — and on a metered engine re-buy — every one of
    // this character's rendered lines on the way to a finished sentence.
    modal.querySelectorAll('.modal-direction-input').forEach((field) => {
      field.addEventListener('blur', (e) => {
        const charKey = field.dataset.char.toUpperCase().trim();
        const existing = workingAssignments.get(charKey) || {};
        const next = e.target.value.trim();
        if ((existing.direction || '') === next) return;
        workingAssignments.set(charKey, { ...existing, direction: next, auto: false });
      });
    });

    // Character Audition buttons
    modal.querySelectorAll('.btn-audition-char').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const charName = btn.dataset.char;
        const charKey = charName.toUpperCase().trim();

        if (currentlyPlayingChar === charKey) {
          auditionGeneration++;
          audioManager.stop({ preservePrewarm: true });
          currentlyPlayingChar = null;
          auditionPhase = 'idle';
          renderContent();
          return;
        }

        const generation = ++auditionGeneration;
        currentlyPlayingChar = charKey;
        auditionPhase = 'rendering';
        renderContent();

        const assignment = workingAssignments.get(charKey) || makeDefaultAssignment();
        const charObj = characters.find((c) => c.name.toUpperCase().trim() === charKey);
        const sampleText = charObj ? charObj.sampleLine : null;

        // Read the direction out of the live field rather than the working copy:
        // auditioning without leaving the textarea first is the normal way to try
        // a direction out, and blur has not fired yet at that point.
        const liveDirection = modal.querySelector(`.modal-direction-input[data-char="${CSS.escape(charName)}"]`);
        const direction = liveDirection ? liveDirection.value.trim() : assignment.direction || '';

        const onStateChange = (phase) => {
          if (generation !== auditionGeneration) return;
          auditionPhase = phase;
          if (phase === 'idle' || phase === 'error') {
            currentlyPlayingChar = null;
          }
          renderContent();
        };

        try {
          await audioManager.previewVoice(
            voiceIdOf(assignment),
            sampleText,
            assignment.pitchOffset || 0,
            assignment.speedMultiplier || 1.0,
            direction,
            engineId,
            onStateChange,
          );
        } catch (e) {
          console.warn('Character audition error:', e);
        } finally {
          if (generation === auditionGeneration) {
            currentlyPlayingChar = null;
            auditionPhase = 'idle';
            renderContent();
          }
        }
      });
    });

    // Pitch sliders
    modal.querySelectorAll('.modal-pitch-slider').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        const charName = slider.dataset.char;
        const charKey = charName.toUpperCase().trim();
        const val = parseInt(e.target.value, 10);
        const card = slider.closest('.voice-card');
        if (card) {
          const label = card.querySelector('.modal-pitch-val');
          if (label) label.textContent = formatPitchOffset(val);
        }
        const existing = workingAssignments.get(charKey) || makeDefaultAssignment();
        workingAssignments.set(charKey, { ...existing, pitchOffset: val });
      });
    });

    // Speed sliders
    modal.querySelectorAll('.modal-speed-slider').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        const charName = slider.dataset.char;
        const charKey = charName.toUpperCase().trim();
        const val = parseInt(e.target.value, 10) / 100;
        const card = slider.closest('.voice-card');
        if (card) {
          const label = card.querySelector('.modal-speed-val');
          if (label) label.textContent = `${val.toFixed(1)}x`;
        }
        const existing = workingAssignments.get(charKey) || makeDefaultAssignment();
        workingAssignments.set(charKey, { ...existing, speedMultiplier: val });
      });
    });

    // Tone preset chips
    modal.querySelectorAll('.btn-tone-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const charName = chip.dataset.char;
        const charKey = charName.toUpperCase().trim();
        const preset = chip.dataset.preset;
        const existing = workingAssignments.get(charKey) || makeDefaultAssignment();

        let pitchOffset = 0;
        let speedMultiplier = 1.0;

        switch (preset) {
          case 'dramatic':
            pitchOffset = -5;
            speedMultiplier = 0.92;
            break;
          case 'urgent':
            pitchOffset = 5;
            speedMultiplier = 1.15;
            break;
          case 'whispering':
            pitchOffset = -10;
            speedMultiplier = 0.88;
            break;
          default:
            pitchOffset = 0;
            speedMultiplier = 1.0;
            break;
        }

        workingAssignments.set(charKey, {
          ...existing,
          pitchOffset,
          speedMultiplier,
          tonePreset: preset,
        });

        renderContent();
      });
    });
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (catalogDialog) {
        catalogDialog.close();
        return;
      }
      handleClose();
    }
  };
  window.addEventListener('keydown', onKeyDown);
  modal.addEventListener('click', (e) => {
    if (!isInitialSetup && e.target === modal) handleClose();
  });

  function handleClose() {
    closed = true;
    auditionGeneration++;
    currentlyPlayingChar = null;
    auditionPhase = 'idle';
    window.removeEventListener('keydown', onKeyDown);
    catalogDialog?.close();
    catalogDialog = null;
    audioManager.stop({ preservePrewarm: true });
    modal.remove();
    if (onCancel) onCancel();
  }

  function handleSave() {
    closed = true;
    auditionGeneration++;
    currentlyPlayingChar = null;
    auditionPhase = 'idle';
    window.removeEventListener('keydown', onKeyDown);
    catalogDialog?.close();
    catalogDialog = null;
    audioManager.stop({ preservePrewarm: true });

    // Commit to script store
    const activeIsHybrid = isStudio && audioManager.hybridCasting;
    const activeNarratorEngine = activeIsHybrid ? ENGINE_IDS.KOKORO : engineId;
    scriptStore.updateCast({
      narratorVoiceId: workingNarratorVoiceId,
      narratorEngineId: activeNarratorEngine,
      castAssignments: workingAssignments,
    });
    audioManager.setNarratorVoice(workingNarratorVoiceId);
    if (audioManager.setCastAssignments) {
      audioManager.setCastAssignments(workingAssignments);
    } else {
      for (const [charKey, assignment] of workingAssignments.entries()) {
        audioManager.setVoiceAssignment(charKey, assignment);
      }
    }

    modal.remove();

    if (onSave) {
      onSave({
        narratorVoiceId: workingNarratorVoiceId,
        castAssignments: workingAssignments,
      });
    }
  }

  renderContent();

  // Eagerly prewarm audition sample lines in the background so auditions play instantly
  const prewarmInitialAuditions = () => {
    for (const char of characters) {
      const charKey = char.name.toUpperCase().trim();
      const assignment = workingAssignments.get(charKey);
      if (assignment) {
        audioManager.prewarmAudition?.(voiceIdOf(assignment), char.sampleLine, assignment, engineId);
      }
    }
    const sampleHeading =
      script && script.elements && script.elements[0]
        ? script.elements[0].text
        : 'EXT. OMNICORP SPIRE - NIGHT. Torrential rain lashes against the glass as the city sleeps below.';
    const activeIsHybrid = isStudio && audioManager.hybridCasting;
    const activeNarratorEngine = activeIsHybrid ? ENGINE_IDS.KOKORO : engineId;
    audioManager.prewarmAudition?.(workingNarratorVoiceId, sampleHeading, {}, activeNarratorEngine);
  };
  setTimeout(prewarmInitialAuditions, 200);

  return modal;
}
