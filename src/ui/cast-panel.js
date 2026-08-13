import { getIconSvg } from '../utils/icons.js';
import { formatPitchOffset } from '../audio/performance-director.js';
import { escapeHtml } from '../utils/escape-html.js';
import { getVoiceById, getVoicesForEngine, makeDefaultAssignment } from '../audio/voice-catalog.js';
import { ENGINE_IDS } from '../audio/engine-contract.js';

export function createCastPanel({
  scriptStore,
  audioManager,
  onOpenVoiceConfig
}) {
  const panel = document.createElement('aside');
  panel.className = 'cast-sidebar';

  let auditioningChar = null;
  let auditionPhase = 'idle';
  let auditionGen = 0;

  function render() {
    const script = scriptStore.currentScript;
    const characters = script ? script.characters : [];
    const engineId = audioManager.engineId;
    const isStudio = engineId === ENGINE_IDS.CHATTERBOX;
    const isHybrid = isStudio && audioManager.hybridCasting;
    const narratorEngineId = isHybrid ? ENGINE_IDS.KOKORO : engineId;
    const enginePool = getVoicesForEngine(engineId);
    const narratorPool = getVoicesForEngine(narratorEngineId);
    const storedNarratorVoiceId = scriptStore.getNarratorVoice(narratorEngineId);
    const narratorProfile = narratorPool.some(v => v.id === storedNarratorVoiceId)
      ? getVoiceById(storedNarratorVoiceId, narratorEngineId)
      : audioManager.getVoiceProfileForCharacter('NARRATOR', narratorEngineId);
    const narratorVoiceId = narratorProfile.id;
    const voiceIdOf = (assignment) =>
      (assignment.voiceIds && assignment.voiceIds[engineId]) || assignment.voiceId;

    // Build options for voice select
    const voiceOptionsHtml = (selectedId, pool = enginePool) => {
      // Group voices by sex / category
      const femaleVoices = pool.filter(v => v.sex === 'Female');
      const maleVoices = pool.filter(v => v.sex === 'Male');
      const neutralVoices = pool.filter(v => v.sex === 'Neutral');

      const buildGroup = (label, voices) => voices.length === 0 ? '' : `
        <optgroup label="${label}">
          ${voices.map(v => `
            <option value="${v.id}" ${v.id === selectedId ? 'selected' : ''}>
              ${escapeHtml(v.name)} (${escapeHtml(v.sex)} ${escapeHtml(v.ageGroup)} • ${escapeHtml(v.accent)}) - ${escapeHtml(v.tone.split(',')[0])}
            </option>
          `).join('')}
        </optgroup>
      `;

      return buildGroup('Female voices', femaleVoices)
        + buildGroup('Male voices', maleVoices)
        + buildGroup('Neutral voices', neutralVoices);
    };

    // Calculate total dialogue lines
    const totalDialogueLines = characters.reduce((acc, c) => acc + c.lineCount, 0) || 1;

    panel.innerHTML = `
      <div class="cast-panel-header">
        <div class="cast-panel-title">
          <div style="display: flex; align-items: center; gap: 8px;">
            ${getIconSvg('users', 18)}
            <h2>Voice Cast</h2>
          </div>
          <button id="btn-cast-modal-open" class="btn btn-secondary btn-sm btn-studio-glow" title="Open Cast Studio">
            ${getIconSvg('sparkles', 14)} Cast Studio
          </button>
        </div>
        <div class="cast-panel-desc">
          Assign voices and fine-tune delivery for each character.
        </div>
      </div>

      <div class="cast-list">
        <!-- NARRATOR CARD -->
        <div class="character-card narrator-card ${auditioningChar === 'NARRATOR' ? 'is-previewing' : ''}">
          <div class="char-header">
            <div class="char-avatar" style="background: linear-gradient(135deg, #F59E0B, #B45309);">
              ${getIconSvg('mic', 16)}
            </div>
            <div class="char-meta">
              <div class="char-name" style="color: #F59E0B;">THE NARRATOR</div>
              <div class="char-badges">
                <span class="badge-lines">${isHybrid ? 'Kokoro Neural' : 'Scene Headings & Actions'}</span>
                <span class="badge-voice">${escapeHtml(narratorProfile.name)}</span>
              </div>
            </div>
          </div>

          <div class="char-controls">
            <div class="voice-select-row">
              <select class="voice-select narrator-voice-select">
                ${voiceOptionsHtml(narratorVoiceId, narratorPool)}
              </select>
              <button class="btn btn-secondary btn-test-narrator ${auditioningChar === 'NARRATOR' ? (auditionPhase === 'playing' ? 'btn-active' : 'is-loading') : ''}"
                      style="padding: 6px 10px;"
                      title="${auditioningChar === 'NARRATOR' ? (auditionPhase === 'rendering' ? 'Synthesizing…' : 'Stop') : 'Test Narrator Voice'}">
                ${auditioningChar === 'NARRATOR'
                  ? (auditionPhase === 'preparing'
                      ? getIconSvg('replay', 14, 'spin-icon')
                      : (auditionPhase === 'rendering'
                          ? getIconSvg('sparkles', 14, 'pulse-icon')
                          : getIconSvg('stop', 14)))
                  : getIconSvg('volume', 14)}
              </button>
            </div>
          </div>
        </div>

        <!-- CHARACTER CARDS -->
        <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 8px;">
          Speaking Cast (${characters.length})
        </div>

        ${characters.map(char => {
          const charKey = char.name.toUpperCase().trim();
          const assignment = scriptStore.castAssignments.get(charKey)
            || makeDefaultAssignment();
          const voiceProfile = getVoiceById(voiceIdOf(assignment), engineId);
          const percent = Math.round((char.lineCount / totalDialogueLines) * 100);
          const isPlaying = auditioningChar === charKey;

          // The character name comes from the uploaded script, so it is escaped
          // everywhere it appears — including in `data-char`, where a bare quote
          // would otherwise close the attribute and let the rest of the cue
          // become markup. Escaped attributes round-trip cleanly: the parser
          // turns `&quot;` back into `"`, so `dataset.char` still matches the
          // name the store is keyed by.
          const charAttr = escapeHtml(char.name);

          return `
            <div class="character-card ${isPlaying ? 'is-previewing' : ''}" data-char="${charAttr}">
              <div class="char-header">
                <div class="char-avatar" style="background: ${voiceProfile.avatarBg};">
                  ${escapeHtml(char.name.substring(0, 2).toUpperCase())}
                </div>
                <div class="char-meta">
                  <div class="char-name">${escapeHtml(char.name)}</div>
                  <div class="char-badges">
                    ${char.introduction?.age ? `<span class="badge-age" title="Age, as written in the screenplay">${escapeHtml(char.introduction.age)}</span>` : ''}
                    <span class="badge-lines">${char.lineCount} lines (${percent}%)</span>
                    <span class="badge-voice">${escapeHtml(voiceProfile.name)}</span>
                  </div>
                  ${char.introduction?.text ? `
                    <div class="char-intro-line" title="${escapeHtml(char.introduction.sourceText || char.introduction.text)}">
                      ${escapeHtml(char.introduction.text)}
                    </div>
                  ` : ''}
                </div>
              </div>

              <div class="char-controls">
                <div class="voice-select-row">
                  <select class="voice-select char-voice-select" data-char="${charAttr}">
                    ${voiceOptionsHtml(voiceIdOf(assignment))}
                  </select>
                  <button class="btn btn-secondary btn-test-voice ${isPlaying ? (auditionPhase === 'playing' ? 'btn-active' : 'is-loading') : ''}"
                          data-char="${charAttr}"
                          style="padding: 6px 10px;"
                          title="${isPlaying ? (auditionPhase === 'rendering' ? 'Synthesizing…' : 'Stop') : 'Test Assigned Voice'}">
                    ${isPlaying
                      ? (auditionPhase === 'preparing'
                          ? getIconSvg('replay', 14, 'spin-icon')
                          : (auditionPhase === 'rendering'
                              ? getIconSvg('sparkles', 14, 'pulse-icon')
                              : getIconSvg('stop', 14)))
                      : getIconSvg('volume', 14)}
                  </button>
                </div>

                <!-- Pitch & Speed Fine-tuning -->
                <div class="slider-group">
                  <span class="slider-label">Pitch:</span>
                  <input type="range" class="slider-input char-pitch-slider" data-char="${charAttr}" min="-50" max="50" value="${assignment.pitchOffset || 0}">
                  <span class="slider-val char-pitch-val">${formatPitchOffset(assignment.pitchOffset)}</span>
                </div>

                <div class="slider-group">
                  <span class="slider-label">Speed:</span>
                  <input type="range" class="slider-input char-speed-slider" data-char="${charAttr}" min="50" max="150" value="${Math.round((assignment.speedMultiplier || 1.0) * 100)}">
                  <span class="slider-val char-speed-val">${(assignment.speedMultiplier || 1.0).toFixed(1)}x</span>
                </div>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    // Attach listeners
    const btnOpenStudio = panel.querySelector('#btn-cast-modal-open');
    if (btnOpenStudio && onOpenVoiceConfig) {
      btnOpenStudio.addEventListener('click', onOpenVoiceConfig);
    }

    // Narrator select
    const narratorSelect = panel.querySelector('.narrator-voice-select');
    if (narratorSelect) {
      narratorSelect.addEventListener('change', (e) => {
        scriptStore.updateNarratorVoice(e.target.value, narratorEngineId);
        audioManager.setNarratorVoice(e.target.value);
      });
    }

    // Narrator test button
    const narratorTestBtn = panel.querySelector('.btn-test-narrator');
    if (narratorTestBtn) {
      narratorTestBtn.addEventListener('click', async () => {
        if (auditioningChar === 'NARRATOR') {
          auditionGen++;
          audioManager.stop({ preservePrewarm: true });
          auditioningChar = null;
          auditionPhase = 'idle';
          render();
          return;
        }

        const gen = ++auditionGen;
        auditioningChar = 'NARRATOR';
        auditionPhase = 'rendering';
        render();

        const onStateChange = (phase) => {
          if (gen !== auditionGen) return;
          auditionPhase = phase;
          if (phase === 'idle' || phase === 'error') {
            auditioningChar = null;
          }
          render();
        };

        try {
          await audioManager.previewVoice(
            narratorVoiceId,
            "EXT. OMNICORP SPIRE - NIGHT. Torrential rain lashes against the glass as the city sleeps below.",
            0, 1.0, '', narratorEngineId, onStateChange
          );
        } catch (e) {
          console.warn('Narrator test error:', e);
        } finally {
          if (gen === auditionGen) {
            auditioningChar = null;
            auditionPhase = 'idle';
            render();
          }
        }
      });
    }

    // Character voice selects
    panel.querySelectorAll('.char-voice-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const charName = select.dataset.char;
        const charKey = charName.toUpperCase().trim();
        // Recorded against the active engine so the character's casting on the
        // other engine is not overwritten by a choice made here.
        scriptStore.updateCharacterVoice(charName, { voiceId: e.target.value, engineId });
        const assignment = scriptStore.castAssignments.get(charKey);
        audioManager.setVoiceAssignment(charName, assignment);
        const charObj = characters.find(c => c.name.toUpperCase().trim() === charKey);
        audioManager.prewarmAudition?.(e.target.value, charObj ? charObj.sampleLine : null, assignment, engineId);
        render(); // update avatar & badge
      });
    });

    // Character test buttons
    panel.querySelectorAll('.btn-test-voice').forEach(btn => {
      btn.addEventListener('click', async () => {
        const charName = btn.dataset.char;
        const charKey = charName.toUpperCase().trim();

        if (auditioningChar === charKey) {
          auditionGen++;
          audioManager.stop({ preservePrewarm: true });
          auditioningChar = null;
          auditionPhase = 'idle';
          render();
          return;
        }

        const gen = ++auditionGen;
        auditioningChar = charKey;
        auditionPhase = 'rendering';
        render();

        const assignment = scriptStore.castAssignments.get(charKey);
        const charObj = characters.find(c => c.name.toUpperCase().trim() === charKey);
        const sampleText = charObj ? charObj.sampleLine : null;
        
        const onStateChange = (phase) => {
          if (gen !== auditionGen) return;
          auditionPhase = phase;
          if (phase === 'idle' || phase === 'error') {
            auditioningChar = null;
          }
          render();
        };

        try {
          await audioManager.previewVoice(
            voiceIdOf(assignment),
            sampleText,
            assignment.pitchOffset || 0,
            assignment.speedMultiplier || 1.0,
            assignment.direction || '',
            null,
            onStateChange
          );
        } catch (e) {
          console.warn('Character test error:', e);
        } finally {
          if (gen === auditionGen) {
            auditioningChar = null;
            auditionPhase = 'idle';
            render();
          }
        }
      });
    });

    // Pitch sliders
    panel.querySelectorAll('.char-pitch-slider').forEach(slider => {
      slider.addEventListener('input', (e) => {
        const charName = slider.dataset.char;
        const val = parseInt(e.target.value, 10);
        const card = slider.closest('.character-card');
        if (card) {
          card.querySelector('.char-pitch-val').textContent = formatPitchOffset(val);
        }
        scriptStore.updateCharacterVoice(charName, { pitchOffset: val, deferRender: true });
        audioManager.setVoiceAssignment(charName, scriptStore.castAssignments.get(charName.toUpperCase().trim()));
      });
    });

    // Speed sliders
    panel.querySelectorAll('.char-speed-slider').forEach(slider => {
      slider.addEventListener('input', (e) => {
        const charName = slider.dataset.char;
        const val = parseInt(e.target.value, 10) / 100;
        const card = slider.closest('.character-card');
        if (card) {
          card.querySelector('.char-speed-val').textContent = `${val.toFixed(1)}x`;
        }
        scriptStore.updateCharacterVoice(charName, { speedMultiplier: val, deferRender: true });
        audioManager.setVoiceAssignment(charName, scriptStore.castAssignments.get(charName.toUpperCase().trim()));
      });
    });

    // Auto-cast button
    const autoCastBtn = panel.querySelector('#btn-autocast');
    if (autoCastBtn) {
      autoCastBtn.addEventListener('click', () => {
        if (script) {
          scriptStore.autoCastCurrentScript(engineId);
          audioManager.setNarratorVoice(scriptStore.getNarratorVoice(engineId));
          audioManager.setScript(
            scriptStore.currentScript.elements,
            scriptStore.castAssignments,
            scriptStore.activeLineIndex
          );
          render();
        }
      });
    }
  }

  // Highlight everyone currently speaking — during an overlap that is more than
  // one person, and one of them falling silent must not dim the other.
  function setSpeakingCharacters(charNames) {
    const speaking = (Array.isArray(charNames) ? charNames : [charNames])
      .filter(Boolean)
      .map(name => name.toUpperCase().trim());

    panel.querySelectorAll('.character-card').forEach(card => {
      const cardName = (card.dataset.char || '').toUpperCase().trim();
      card.classList.toggle('speaking', !!cardName && speaking.includes(cardName));
    });
  }


  // Subscribe to script store changes
  scriptStore.subscribe((event, data) => {
    if (event === 'scriptLoaded' || event === 'castUpdated' || event === 'narratorUpdated') {
      if (event === 'castUpdated' && data && data.deferRender) return;
      render();
    }
  });

  render();

  return {
    element: panel,
    render,
    setSpeakingCharacters,
    toggleCollapse: () => !panel.classList.toggle('collapsed'),
    isOpen: () => !panel.classList.contains('collapsed')
  };
}
