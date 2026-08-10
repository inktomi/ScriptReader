import { getIconSvg } from '../utils/icons.js';
import { VOICE_CATALOG, getVoiceById } from '../audio/voice-catalog.js';

export function createCastPanel({
  scriptStore,
  audioManager,
  onOpenVoiceConfig
}) {
  const panel = document.createElement('aside');
  panel.className = 'cast-sidebar';

  function render() {
    const script = scriptStore.currentScript;
    const characters = script ? script.characters : [];
    const narratorVoiceId = scriptStore.narratorVoiceId;
    const narratorProfile = getVoiceById(narratorVoiceId);

    // Build options for voice select
    const voiceOptionsHtml = (selectedId) => {
      // Group voices by sex / category
      const femaleVoices = VOICE_CATALOG.filter(v => v.sex === 'Female');
      const maleVoices = VOICE_CATALOG.filter(v => v.sex === 'Male');

      const buildGroup = (label, voices) => `
        <optgroup label="${label}">
          ${voices.map(v => `
            <option value="${v.id}" ${v.id === selectedId ? 'selected' : ''}>
              ${v.name} (${v.sex} ${v.ageGroup} • ${v.accent}) - ${v.tone.split(',')[0]}
            </option>
          `).join('')}
        </optgroup>
      `;

      return buildGroup('👩 Female Voices', femaleVoices) + buildGroup('👨 Male Voices', maleVoices);
    };

    // Calculate total dialogue lines
    const totalDialogueLines = characters.reduce((sum, c) => sum + c.lineCount, 0) || 1;

    panel.innerHTML = `
      <div class="sidebar-header">
        <div class="sidebar-title">
          ${getIconSvg('users', 18)}
          <span>Cast Voices (${characters.length + 1})</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <button id="btn-cast-modal-open" class="btn btn-primary" style="padding: 4px 10px; font-size: 0.75rem;" title="Open full Voice Studio modal">
            ${getIconSvg('sparkles', 13)}
            <span>Studio</span>
          </button>
          <button id="btn-autocast" class="btn btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" title="Auto-assign voices based on character traits">
            ${getIconSvg('refresh', 13)}
          </button>
        </div>
      </div>

      <div class="cast-scroll-area">
        <!-- NARRATOR CARD -->
        <div class="character-card" style="border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.04);">
          <div class="char-header">
            <div class="char-avatar" style="background: linear-gradient(135deg, #F59E0B, #B45309);">
              🎙️
            </div>
            <div class="char-meta">
              <div class="char-name" style="color: #F59E0B;">THE NARRATOR</div>
              <div class="char-badges">
                <span class="badge-lines">Scene Headings & Actions</span>
                <span class="badge-voice">${narratorProfile.name}</span>
              </div>
            </div>
          </div>

          <div class="char-controls">
            <div class="voice-select-row">
              <select class="voice-select narrator-voice-select">
                ${voiceOptionsHtml(narratorVoiceId)}
              </select>
              <button class="btn btn-secondary btn-test-narrator" style="padding: 6px 10px;" title="Test Narrator Voice">
                ${getIconSvg('volume', 14)}
              </button>
            </div>
          </div>
        </div>

        <!-- CHARACTER CARDS -->
        <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 8px;">
          Speaking Cast (${characters.length})
        </div>

        ${characters.map(char => {
          const assignment = scriptStore.castAssignments.get(char.name.toUpperCase().trim()) || {
            voiceId: 'am_adam',
            pitchOffset: 0,
            speedMultiplier: 1.0
          };
          const voiceProfile = getVoiceById(assignment.voiceId);
          const percent = Math.round((char.lineCount / totalDialogueLines) * 100);

          return `
            <div class="character-card" data-char="${char.name}">
              <div class="char-header">
                <div class="char-avatar" style="background: ${voiceProfile.avatarBg};">
                  ${char.name.substring(0, 2).toUpperCase()}
                </div>
                <div class="char-meta">
                  <div class="char-name">${char.name}</div>
                  <div class="char-badges">
                    <span class="badge-lines">${char.lineCount} lines (${percent}%)</span>
                    <span class="badge-voice">${voiceProfile.name}</span>
                  </div>
                </div>
              </div>

              <div class="char-controls">
                <div class="voice-select-row">
                  <select class="voice-select char-voice-select" data-char="${char.name}">
                    ${voiceOptionsHtml(assignment.voiceId)}
                  </select>
                  <button class="btn btn-secondary btn-test-voice" data-char="${char.name}" style="padding: 6px 10px;" title="Test Assigned Voice">
                    ${getIconSvg('volume', 14)}
                  </button>
                </div>

                <!-- Pitch & Speed Fine-tuning -->
                <div class="slider-group">
                  <span class="slider-label">Pitch:</span>
                  <input type="range" class="slider-input char-pitch-slider" data-char="${char.name}" min="-50" max="50" value="${assignment.pitchOffset || 0}">
                  <span class="slider-val char-pitch-val">${assignment.pitchOffset > 0 ? '+' : ''}${assignment.pitchOffset || 0}%</span>
                </div>

                <div class="slider-group">
                  <span class="slider-label">Speed:</span>
                  <input type="range" class="slider-input char-speed-slider" data-char="${char.name}" min="50" max="150" value="${Math.round((assignment.speedMultiplier || 1.0) * 100)}">
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
        scriptStore.updateNarratorVoice(e.target.value);
        audioManager.setNarratorVoice(e.target.value);
      });
    }

    // Narrator test button
    const narratorTestBtn = panel.querySelector('.btn-test-narrator');
    if (narratorTestBtn) {
      narratorTestBtn.addEventListener('click', () => {
        audioManager.previewVoice(
          scriptStore.narratorVoiceId,
          "EXT. OMNICORP SPIRE - NIGHT. Torrential rain lashes against the glass as the city sleeps below."
        );
      });
    }

    // Character voice selects
    panel.querySelectorAll('.char-voice-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const charName = select.dataset.char;
        const voiceId = e.target.value;
        scriptStore.updateCharacterVoice(charName, { voiceId });
        audioManager.setVoiceAssignment(charName, scriptStore.castAssignments.get(charName.toUpperCase().trim()));
        render(); // update avatar & badge
      });
    });

    // Character test buttons
    panel.querySelectorAll('.btn-test-voice').forEach(btn => {
      btn.addEventListener('click', () => {
        const charName = btn.dataset.char;
        const assignment = scriptStore.castAssignments.get(charName.toUpperCase().trim());
        const charObj = characters.find(c => c.name.toUpperCase().trim() === charName.toUpperCase().trim());
        const sampleText = charObj ? charObj.sampleLine : null;
        
        audioManager.previewVoice(
          assignment.voiceId,
          sampleText,
          assignment.pitchOffset || 0,
          assignment.speedMultiplier || 1.0
        );
      });
    });

    // Pitch sliders
    panel.querySelectorAll('.char-pitch-slider').forEach(slider => {
      slider.addEventListener('input', (e) => {
        const charName = slider.dataset.char;
        const val = parseInt(e.target.value, 10);
        const card = slider.closest('.character-card');
        if (card) {
          card.querySelector('.char-pitch-val').textContent = `${val > 0 ? '+' : ''}${val}%`;
        }
        scriptStore.updateCharacterVoice(charName, { pitchOffset: val });
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
        scriptStore.updateCharacterVoice(charName, { speedMultiplier: val });
        audioManager.setVoiceAssignment(charName, scriptStore.castAssignments.get(charName.toUpperCase().trim()));
      });
    });

    // Auto-cast button
    const autoCastBtn = panel.querySelector('#btn-autocast');
    if (autoCastBtn) {
      autoCastBtn.addEventListener('click', () => {
        if (script) {
          scriptStore.setScriptData(script, {
            scriptKey: scriptStore.scriptKey,
            scriptType: scriptStore.scriptType,
            sampleId: scriptStore.sampleId,
            customData: scriptStore.customScriptData,
            resetProgress: false
          });
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
  scriptStore.subscribe((event) => {
    if (event === 'scriptLoaded' || event === 'castUpdated' || event === 'narratorUpdated') {
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
