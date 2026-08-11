import { getIconSvg } from '../utils/icons.js';
import { formatPitchOffset } from '../audio/performance-director.js';
import { escapeHtml } from '../utils/escape-html.js';
import {
  VOICE_CATALOG,
  getVoiceById,
  getVoicesForEngine,
  getSuggestedVoiceForCharacter,
  getDefaultNarratorVoice,
  makeDefaultAssignment
} from '../audio/voice-catalog.js';
import { ENGINE_IDS } from '../audio/engine-contract.js';
import { KOKORO_GRADES, gradeLabel, gradeColor } from '../audio/voice-grades.js';

export function createVoiceConfigModal({
  scriptStore,
  audioManager,
  onSave,
  onCancel,
  isInitialSetup = false
}) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay voice-config-modal-overlay';

  const script = scriptStore.currentScript;
  const characters = script ? script.characters : [];
  const scriptTitle = script ? script.title : 'Screenplay';
  const totalLines = script ? script.elements.length : 0;
  const totalDialogue = characters.reduce((sum, c) => sum + c.lineCount, 0) || 1;

  // Local working copy of assignments so user can edit, preview, and cancel if desired
  let workingNarratorVoiceId = scriptStore.narratorVoiceId || getDefaultNarratorVoice().id;
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

  // The casting UI has to show the pool the *active* engine can actually speak
  // with; the two id spaces are disjoint.
  const engineId = audioManager.engineId;
  const enginePool = getVoicesForEngine(engineId);
  const supportsDirection = audioManager.capabilities.supportsInstructions;

  /** This character's voice under the active engine, falling back to the legacy field. */
  function voiceIdOf(assignment) {
    return (assignment.voiceIds && assignment.voiceIds[engineId]) || assignment.voiceId;
  }

  /**
   * Honest quality badge, derived from upstream's grade rather than from a stored
   * label. The Kokoro pool is graded; the OpenAI pool is not, so it says what it
   * is instead of inventing a tier.
   */
  function qualityBadge(voiceId) {
    const grade = KOKORO_GRADES[voiceId];
    return grade ? `${gradeLabel(voiceId)} · ${grade}` : 'Cloud';
  }

  function buildVoiceOptions(selectedId) {
    const femaleVoices = enginePool.filter(v => v.sex === 'Female');
    const maleVoices = enginePool.filter(v => v.sex === 'Male');
    const neutralVoices = enginePool.filter(v => v.sex === 'Neutral');

    const buildGroup = (label, voices) => voices.length === 0 ? '' : `
      <optgroup label="${label}">
        ${voices.map(v => `
          <option value="${v.id}" ${v.id === selectedId ? 'selected' : ''}>
            ${v.name} (${v.sex} ${v.ageGroup} • ${v.accent}) - ${v.tone.split(',')[0]}
          </option>
        `).join('')}
      </optgroup>
    `;

    return buildGroup('👩 Female Voices', femaleVoices)
      + buildGroup('👨 Male Voices', maleVoices)
      + buildGroup('◐ Neutral Voices', neutralVoices);
  }

  function renderContent() {
    const narratorProfile = getVoiceById(workingNarratorVoiceId, engineId);

    modal.innerHTML = `
      <div class="modal-card voice-config-card">
        <!-- Header -->
        <div class="modal-header voice-config-header">
          <div style="display: flex; align-items: center; gap: 14px;">
            <div class="brand-badge" style="width: 44px; height: 44px; border-radius: 12px; font-size: 1.25rem;">
              🎙️
            </div>
            <div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <h2 style="font-size: 1.25rem; font-weight: 800; color: #FFFFFF; letter-spacing: -0.01em;">
                  ${isInitialSetup ? 'Cast Voice Setup' : 'Cast Voice Studio'}
                </h2>
                <span class="brand-tag" style="font-size: 0.7rem;">${characters.length} CHARACTERS</span>
              </div>
              <div style="font-size: 0.8rem; color: var(--text-secondary); margin-top: 2px;">
                <span style="color: #F59E0B; font-weight: 600;">${scriptTitle}</span> • ${totalLines} total elements • ${totalDialogue} dialogue cues
              </div>
            </div>
          </div>

          <div style="display: flex; align-items: center; gap: 8px;">
            <button id="btn-modal-autocast" class="btn btn-secondary" style="padding: 6px 12px; font-size: 0.8rem;" title="Auto-assign unique AI voices based on character names and context">
              ${getIconSvg('sparkles', 14)}
              <span>Smart Auto-Cast</span>
            </button>
            <button class="btn-icon btn-close-voice-modal" title="Close">
              ${getIconSvg('close', 18)}
            </button>
          </div>
        </div>

        <!-- Body -->
        <div class="modal-body voice-config-body">
          <div class="voice-config-instruction">
            <span style="font-size: 1.1rem;">💡</span>
            <div>
              Audition and configure custom voices for each role. Your voice preferences and reading progress are 
              <strong>automatically saved for this script</strong> in local storage.
            </div>
          </div>

          <!-- NARRATOR SECTION -->
          <div class="voice-config-section-title">
            <span>Stage & Action Direction</span>
          </div>

          <div class="voice-card narrator-config-card ${currentlyPlayingChar === 'NARRATOR' ? 'is-previewing' : ''}">
            <div class="voice-card-header">
              <div class="char-avatar" style="background: linear-gradient(135deg, #F59E0B, #B45309); width: 44px; height: 44px; font-size: 1.2rem;">
                🎙️
              </div>
              <div style="flex: 1;">
                <div style="display: flex; align-items: center; justify-content: space-between;">
                  <span style="font-weight: 800; font-size: 1rem; color: #F59E0B;">THE NARRATOR</span>
                  <span class="badge-voice" style="background: rgba(245, 158, 11, 0.15); color: #F59E0B; border: 1px solid rgba(245, 158, 11, 0.3);">
                    ${escapeHtml(qualityBadge(narratorProfile.id))}
                  </span>
                </div>
                <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 2px;">
                  Reads scene headings, physical action blocks, and cinematic descriptions
                </div>
              </div>
            </div>

            <div class="voice-card-controls">
              <div class="voice-select-row">
                <select class="voice-select modal-narrator-select" style="font-weight: 500;">
                  ${buildVoiceOptions(workingNarratorVoiceId)}
                </select>
                <button class="btn btn-secondary btn-audition-narrator ${currentlyPlayingChar === 'NARRATOR' ? 'btn-active' : ''}" style="padding: 7px 14px;">
                  ${currentlyPlayingChar === 'NARRATOR' ? '⏹️ Stop' : `${getIconSvg('volume', 15)} Listen`}
                </button>
              </div>

              <div class="voice-desc-pill">
                <strong>${narratorProfile.name}:</strong> ${narratorProfile.tone} • ${narratorProfile.description}
              </div>
            </div>
          </div>

          <!-- SPEAKING CAST SECTION -->
          <div class="voice-config-section-title" style="margin-top: 24px;">
            <span>Speaking Characters (${characters.length})</span>
          </div>

          <div class="voice-cards-grid">
            ${characters.map(char => {
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
                      <div style="display: flex; align-items: center; justify-content: space-between;">
                        <span class="char-name" style="font-size: 0.95rem;">${escapeHtml(char.name)}</span>
                        <span class="badge-lines">${char.lineCount} lines (${percent}%)</span>
                      </div>
                      <div style="font-size: 0.75rem; color: #06B6D4; font-weight: 600; margin-top: 1px;">
                        ${voiceProfile.name} • ${voiceProfile.sex} ${voiceProfile.accent}
                        <span style="color: ${gradeColor(voiceProfile.id)}; font-weight: 700;">
                          · ${escapeHtml(qualityBadge(voiceProfile.id))}
                        </span>
                      </div>
                    </div>
                  </div>

                  <!-- Character Sample Line Quote -->
                  <div class="char-sample-quote" title="Excerpt from screenplay">
                    "${escapeHtml(char.sampleLine || 'Ready for readthrough.')}"
                  </div>

                  <!-- Voice Selection Row -->
                  <div class="voice-card-controls">
                    <div class="voice-select-row">
                      <select class="voice-select modal-char-select" data-char="${charAttr}">
                        ${buildVoiceOptions(voiceIdOf(assignment))}
                      </select>
                      <button class="btn btn-secondary btn-audition-char ${isPlaying ? 'btn-active' : ''}" data-char="${charAttr}" style="padding: 7px 12px; white-space: nowrap;">
                        ${isPlaying ? '⏹️ Stop' : `${getIconSvg('volume', 14)} Listen`}
                      </button>
                    </div>

                    <!-- Voice Tone Tag -->
                    <div class="voice-tone-tag">
                      <span>🎭 ${voiceProfile.tone}</span>
                    </div>

                    <!-- Sliders for Pitch and Speed -->
                    <div class="voice-sliders-container">
                      <div class="slider-group">
                        <span class="slider-label">Pitch:</span>
                        <input type="range" class="slider-input modal-pitch-slider" data-char="${charAttr}" min="-50" max="50" value="${assignment.pitchOffset || 0}">
                        <span class="slider-val modal-pitch-val">${formatPitchOffset(assignment.pitchOffset)}</span>
                      </div>

                      <div class="slider-group">
                        <span class="slider-label">Speed:</span>
                        <input type="range" class="slider-input modal-speed-slider" data-char="${charAttr}" min="50" max="150" value="${Math.round((assignment.speedMultiplier || 1.0) * 100)}">
                        <span class="slider-val modal-speed-val">${(assignment.speedMultiplier || 1.0).toFixed(1)}x</span>
                      </div>
                    </div>

                    <!-- Tone Presets -->
                    <div class="tone-presets-row">
                      <span style="font-size: 0.7rem; color: var(--text-muted); font-weight: 600;">Style:</span>
                      <button class="btn-tone-chip ${assignment.tonePreset === 'natural' ? 'active' : ''}" data-char="${charAttr}" data-preset="natural">Natural</button>
                      <button class="btn-tone-chip ${assignment.tonePreset === 'dramatic' ? 'active' : ''}" data-char="${charAttr}" data-preset="dramatic">Dramatic</button>
                      <button class="btn-tone-chip ${assignment.tonePreset === 'urgent' ? 'active' : ''}" data-char="${charAttr}" data-preset="urgent">Urgent</button>
                      <button class="btn-tone-chip ${assignment.tonePreset === 'whispering' ? 'active' : ''}" data-char="${charAttr}" data-preset="whispering">Intimate</button>
                    </div>

                    ${supportsDirection ? `
                      <div style="margin-top: 10px;">
                        <label style="font-size: 0.7rem; color: var(--text-muted); font-weight: 600;">
                          Direction — describe the voice in your own words
                        </label>
                        <textarea class="modal-direction-input" data-char="${charAttr}" rows="2"
                          placeholder="e.g. Gravelly ex-cop, late fifties, world-weary. Never raises his voice."
                          style="width: 100%; margin-top: 4px; padding: 7px 9px; border-radius: 6px; resize: vertical;
                                 background: rgba(255,255,255,0.04); color: var(--text-primary, #fff);
                                 border: 1px solid rgba(255,255,255,0.12); font-size: 0.78rem;
                                 font-family: inherit; line-height: 1.45;"
                        >${escapeHtml(assignment.direction || '')}</textarea>
                      </div>
                    ` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Footer -->
        <div class="modal-footer voice-config-footer">
          <div style="display: flex; align-items: center; gap: 8px; font-size: 0.8rem; color: var(--text-secondary);">
            <span style="color: #10B981;">✓</span>
            <span>Voices & playback progress automatically persist in LocalStorage</span>
          </div>

          <div style="display: flex; align-items: center; gap: 12px;">
            <button id="btn-modal-cancel" class="btn btn-secondary">
              ${isInitialSetup ? 'Skip & Use Defaults' : 'Cancel'}
            </button>
            <button id="btn-modal-save" class="btn btn-primary" style="padding: 10px 24px; font-size: 0.95rem; font-weight: 700;">
              ${getIconSvg('play', 16)}
              <span>${isInitialSetup ? 'Save & Start Reading' : 'Save Voice Cast'}</span>
            </button>
          </div>
        </div>
      </div>
    `;

    attachEventListeners();
  }

  function attachEventListeners() {
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

    // Modal background overlay click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        handleClose();
      }
    });

    // Save button
    const btnSave = modal.querySelector('#btn-modal-save');
    if (btnSave) {
      btnSave.addEventListener('click', handleSave);
    }

    // Smart Auto-Cast button
    const btnAutoCast = modal.querySelector('#btn-modal-autocast');
    if (btnAutoCast) {
      btnAutoCast.addEventListener('click', () => {
        // Re-run smart assignment
        workingNarratorVoiceId = getDefaultNarratorVoice().id;
        const usedVoices = new Set([workingNarratorVoiceId]);

        for (const char of characters) {
          const suggestedVoiceId = getSuggestedVoiceForCharacter(char.name, {
            sampleLine: char.sampleLine,
            usedVoices
          });
          usedVoices.add(suggestedVoiceId);
          const key = char.name.toUpperCase().trim();
          workingAssignments.set(key, {
            voiceId: suggestedVoiceId,
            pitchOffset: 0,
            speedMultiplier: 1.0,
            tonePreset: 'natural'
          });
        }

        renderContent();
      });
    }

    // Narrator Voice select
    const narratorSelect = modal.querySelector('.modal-narrator-select');
    if (narratorSelect) {
      narratorSelect.addEventListener('change', (e) => {
        workingNarratorVoiceId = e.target.value;
        renderContent();
      });
    }

    // Narrator Audition button
    const narratorAuditionBtn = modal.querySelector('.btn-audition-narrator');
    if (narratorAuditionBtn) {
      narratorAuditionBtn.addEventListener('click', async () => {
        if (currentlyPlayingChar === 'NARRATOR') {
          audioManager.stop();
          currentlyPlayingChar = null;
          renderContent();
          return;
        }

        currentlyPlayingChar = 'NARRATOR';
        renderContent();

        const sampleHeading = script && script.elements && script.elements[0]
          ? script.elements[0].text
          : "EXT. OMNICORP SPIRE - NIGHT. Torrential rain lashes against the glass as the city sleeps below.";

        await audioManager.previewVoice(workingNarratorVoiceId, sampleHeading, 0, 1.0);
        currentlyPlayingChar = null;
        renderContent();
      });
    }

    // Character Voice selects
    modal.querySelectorAll('.modal-char-select').forEach(select => {
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
          auto: false
        });
        renderContent();
      });
    });

    // Per-character direction. Applied on blur rather than per keystroke: the
    // text feeds the composed instructions, which feed the cache key, so saving
    // mid-word would invalidate — and on a metered engine re-buy — every one of
    // this character's rendered lines on the way to a finished sentence.
    modal.querySelectorAll('.modal-direction-input').forEach(field => {
      field.addEventListener('blur', (e) => {
        const charKey = field.dataset.char.toUpperCase().trim();
        const existing = workingAssignments.get(charKey) || {};
        const next = e.target.value.trim();
        if ((existing.direction || '') === next) return;
        workingAssignments.set(charKey, { ...existing, direction: next, auto: false });
      });
    });

    // Character Audition buttons
    modal.querySelectorAll('.btn-audition-char').forEach(btn => {
      btn.addEventListener('click', async () => {
        const charName = btn.dataset.char;
        const charKey = charName.toUpperCase().trim();

        if (currentlyPlayingChar === charKey) {
          audioManager.stop();
          currentlyPlayingChar = null;
          renderContent();
          return;
        }

        currentlyPlayingChar = charKey;
        renderContent();

        const assignment = workingAssignments.get(charKey) || makeDefaultAssignment();
        const charObj = characters.find(c => c.name.toUpperCase().trim() === charKey);
        const sampleText = charObj ? charObj.sampleLine : null;

        // Read the direction out of the live field rather than the working copy:
        // auditioning without leaving the textarea first is the normal way to try
        // a direction out, and blur has not fired yet at that point.
        const liveDirection = modal.querySelector(`.modal-direction-input[data-char="${CSS.escape(charName)}"]`);
        const direction = liveDirection ? liveDirection.value.trim() : (assignment.direction || '');

        await audioManager.previewVoice(
          voiceIdOf(assignment),
          sampleText,
          assignment.pitchOffset || 0,
          assignment.speedMultiplier || 1.0,
          direction
        );

        currentlyPlayingChar = null;
        renderContent();
      });
    });

    // Pitch sliders
    modal.querySelectorAll('.modal-pitch-slider').forEach(slider => {
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
    modal.querySelectorAll('.modal-speed-slider').forEach(slider => {
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
    modal.querySelectorAll('.btn-tone-chip').forEach(chip => {
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
          case 'natural':
          default:
            pitchOffset = 0;
            speedMultiplier = 1.0;
            break;
        }

        workingAssignments.set(charKey, {
          ...existing,
          pitchOffset,
          speedMultiplier,
          tonePreset: preset
        });

        renderContent();
      });
    });
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      handleClose();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  function handleClose() {
    window.removeEventListener('keydown', onKeyDown);
    audioManager.stop();
    modal.remove();
    if (onCancel) onCancel();
  }

  function handleSave() {
    window.removeEventListener('keydown', onKeyDown);
    audioManager.stop();

    // Commit to script store
    scriptStore.updateNarratorVoice(workingNarratorVoiceId);
    audioManager.setNarratorVoice(workingNarratorVoiceId);

    for (const [charKey, assignment] of workingAssignments.entries()) {
      scriptStore.updateCharacterVoice(charKey, assignment);
      audioManager.setVoiceAssignment(charKey, assignment);
    }

    // Persist explicitly
    scriptStore.saveCurrentState();

    modal.remove();

    if (onSave) {
      onSave({
        narratorVoiceId: workingNarratorVoiceId,
        castAssignments: workingAssignments
      });
    }
  }

  renderContent();
  return modal;
}
