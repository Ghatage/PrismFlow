import {createProjectStore} from './project-store.js';
import {createCharacterLibrary} from './character-library.js';
import {
  createCharacterGenerationController,
  createFakeCharacterGenerationAdapter,
  normalizeCharacterGenerationInput,
  recordCharacterSheetVersion,
} from './character-generation.js';

const projectStore = createProjectStore();
let project = projectStore.getProject();

const state = {
  get media() { return project.mediaAssets; },
  get characters() { return project.characters; },
  get clips() { return project.timeline.clips; },
  get timelineDuration() { return project.timeline.duration; },
  selectedClipId: null,
  currentTime: 0,
  isPlaying: false,
  zoom: 1,
  activeTab: 'media',
  selectedCharacterId: null,
  isCharacterModalOpen: false,
  characterModalMode: 'detail',
  characterComposerInput: {name: '', prompt: '', styleNotes: '', referenceAssetIds: []},
  previewSourceId: null,
  previewClipId: null,
  rafId: null,
  playbackStartedAt: 0,
  playbackOrigin: 0,
  dragPayload: null,
};

const updateProject = (command) => {
  const result = projectStore.dispatch(command);
  project = result.project;
  return result;
};

const characterLibrary = createCharacterLibrary({
  getProject: () => project,
  dispatch: updateProject,
});
const characterGenerationAdapter = createFakeCharacterGenerationAdapter();
let characterGenerationController = null;
let characterPollTimer = null;

const app = document.querySelector('#app');
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'video/*,audio/*,image/*';
fileInput.multiple = true;
fileInput.hidden = true;
document.body.append(fileInput);

const icons = {
  chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>',
  grid: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h4v4h-4zm7 0h4v4h-4zm-7 7h4v4h-4zm7 0h4v4h-4z"/></svg>',
  upload: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 11V2m0 0L4.8 5.2M8 2l3.2 3.2M2.5 10.5v2A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-2"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 7 5-7 5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9M11 3.5v9"/></svg>',
  skipBack: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v10m1 0 7-5-7-5z"/></svg>',
  skipForward: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12 3v10M11 3 4 8l7 5z"/></svg>',
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  scissors: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5.2 5.2 7.3 7.3M10.8 5.2 3.5 12.5M4.4 3.7a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4Zm7.2 5.2a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4Z"/></svg>',
  sliders: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h10M6 2.5v3M10 6.5v3M7 10.5v3"/></svg>',
  film: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M5 3v10M11 3v10M2.5 6h11M2.5 10h11"/></svg>',
  image: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><circle cx="5.5" cy="5.5" r="1"/><path d="m3.5 11 3.2-3 2.2 2 1.6-1.3 2 2.3"/></svg>',
  audio: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5v7.2M9.5 3.5 13 2v7.2M9.5 10.7a2.2 2.2 0 1 1-2.2-2.2 2.2 2.2 0 0 1 2.2 2.2Zm3.5-1.5a2.2 2.2 0 1 1-2.2-2.2 2.2 2.2 0 0 1 2.2 2.2Z"/></svg>',
  magic: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9.6 2.2.6 2.2 2.2.6-2.2.6-.6 2.2L9 5.6l-2.2-.6L9 4.4l.6-2.2ZM4.2 7.5l.8 2.7 2.7.8-2.7.8-.8 2.7-.8-2.7-2.7-.8 2.7-.8.8-2.7ZM12.5 10l.4 1.4 1.4.4-1.4.4-.4 1.4-.4-1.4-1.4-.4 1.4-.4.4-1.4Z"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  more: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/></svg>',
};

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[character]));

const formatTime = (seconds, showHours = false) => {
  const safeSeconds = Math.max(0, seconds || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  const secondsText = remainder.toFixed(2).padStart(5, '0');
  return `${showHours ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:` : ''}${String(minutes % 60).padStart(2, '0')}:${secondsText}`;
};

const formatBytes = (bytes) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const mediaKind = (file) => {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'video';
};

const kindIcon = (kind) => icons[kind] || icons.film;
const clipById = (id) => state.clips.find((clip) => clip.id === id);
const mediaById = (id) => state.media.find((item) => item.id === id);
const characterById = (id) => state.characters.find((character) => character.id === id);
const characterVersion = (character) => character?.versions.find((version) => version.id === (character.lockedVersionId || character.activeVersionId)) || null;
const activeScene = () => project.scenes.find((scene) => scene.id === project.timeline.activeSceneId) || project.scenes[0];
const scale = () => 88 * state.zoom;

const renderMediaVisual = (item) => {
  if (item.url && item.kind === 'image') return `<img src="${item.url}" alt="" />`;
  if (item.url && item.kind === 'video') return `<video src="${item.url}" muted preload="metadata"></video>`;
  if (item.kind === 'audio') return `<div class="audio-thumb">${icons.audio}</div>`;
  return `<div class="offline-thumb">${kindIcon(item.kind)}<span>offline</span></div>`;
};

const renderApp = () => {
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand-lockup">
          <div class="brand-mark"><span></span><span></span><span></span></div>
          <span class="brand-name">PrismFlow</span>
          <span class="brand-divider"></span>
          <button class="project-switcher" type="button">${escapeHtml(project.project.name)} ${icons.chevron}</button>
          <span class="save-state"><i></i> Local draft</span>
        </div>
        <div class="top-actions">
          <button class="icon-button" title="Project settings" type="button">${icons.sliders}</button>
          <button class="button ghost" type="button" data-action="export">Export</button>
          <button class="button primary" type="button" data-action="render"><span class="button-spark">${icons.magic}</span> Render draft</button>
          <button class="avatar" type="button" aria-label="Account">PF</button>
        </div>
      </header>

      <main class="workspace">
        <aside class="sidebar left-panel">
          <div class="panel-tabs">
            <button class="panel-tab ${state.activeTab === 'media' ? 'active' : ''}" data-tab="media" type="button">Media <span class="tab-count">${state.media.length || ''}</span></button>
            <button class="panel-tab ${state.activeTab === 'characters' ? 'active' : ''}" data-tab="characters" type="button">Characters <span class="tab-count">${state.characters.length || ''}</span></button>
            <button class="panel-tab ${state.activeTab === 'scenes' ? 'active' : ''}" data-tab="scenes" type="button">Scenes</button>
          </div>
          ${state.activeTab === 'media' ? renderMediaPanel() : state.activeTab === 'characters' ? renderCharactersPanel() : renderScenesPanel()}
        </aside>

        <section class="stage">
          <div class="stage-toolbar">
            <div class="breadcrumb"><span class="eyebrow">STORYBOARD</span><span class="slash">/</span><span>${escapeHtml(project.project.name)}</span></div>
            <div class="stage-tools"><button class="toolbar-button" type="button">${icons.grid} Fit</button><button class="toolbar-button" type="button">100%</button><button class="toolbar-button" type="button">${icons.more}</button></div>
          </div>
          <div class="preview-wrap">
            <div class="preview-frame" id="previewFrame">
              <video id="previewVideo" playsinline preload="metadata"></video>
              <img id="previewImage" alt="Selected timeline image" />
              <div class="audio-preview" id="audioPreview"><div class="audio-orb">${icons.audio}</div><span>Audio clip</span></div>
              <div class="empty-preview" id="emptyPreview"><div class="empty-preview-icon">${icons.film}</div><strong>Your canvas is ready</strong><span>Import media, then drop a clip onto the timeline.</span></div>
              <div class="safe-area"></div>
            </div>
            <div class="player-controls">
              <div class="player-time"><span id="playerCurrent">00:00.00</span><span class="muted"> / </span><span id="playerDuration">00:12.00</span></div>
              <div class="player-buttons"><button class="round-control" data-action="step-back" title="Previous frame" type="button">${icons.skipBack}</button><button class="play-control" data-action="toggle-play" title="${state.isPlaying ? 'Pause' : 'Play'}" type="button">${state.isPlaying ? icons.pause : icons.play}</button><button class="round-control" data-action="step-forward" title="Next frame" type="button">${icons.skipForward}</button></div>
              <div class="player-right"><span class="live-dot"></span><span>Preview</span><button class="toolbar-button" type="button">${icons.more}</button></div>
            </div>
          </div>
          <div class="stage-footer"><div class="tip"><span class="tip-icon">${icons.magic}</span><span>FAL-ready workspace</span><span class="muted">Generation hooks are isolated until you are ready.</span></div><div class="keyboard-hint"><kbd>Space</kbd> play/pause <kbd>⌘K</kbd> command menu</div></div>
        </section>

        <aside class="sidebar inspector-panel">
          ${renderInspector()}
        </aside>
      </main>

      <section class="timeline-panel">
        ${renderTimeline()}
      </section>
    </div>
    ${state.isCharacterModalOpen ? renderCharacterModal() : ''}
  `;

  bindEvents();
  state.previewSourceId = null;
  state.previewClipId = null;
  syncPreview(true);
};

const renderMediaPanel = () => `
  <div class="panel-heading"><div><span class="eyebrow">ASSET BIN</span><h2>Media</h2></div><button class="small-icon-button" data-action="open-file" type="button">${icons.plus}</button></div>
  <div class="media-dropzone" data-dropzone="media"><div class="dropzone-icon">${icons.upload}</div><strong>Drop media here</strong><span>or <button data-action="open-file" type="button">browse files</button> · <button data-action="add-sample" type="button">try sample</button></span><small>Video, audio, and images</small></div>
  ${state.media.length ? `<div class="media-list">${state.media.map(renderMediaCard).join('')}</div>` : `<div class="panel-empty"><div class="empty-dots">•••</div><span>Your imported media will appear here.</span></div>`}
  <div class="panel-footnote"><span class="fal-dot"></span><span>FAL adapter</span><span class="status-pill">ready</span></div>
`;

const renderMediaCard = (item) => `
  <div class="media-card" draggable="true" data-media-id="${item.id}">
    <div class="media-thumb ${item.kind}">${renderMediaVisual(item)}<span class="type-badge">${kindIcon(item.kind)}</span></div>
    <div class="media-card-copy"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><span>${item.url ? `${item.kind} · ${item.kind === 'image' ? 'still' : formatTime(item.duration)}` : `${item.kind} · re-import to preview`}</span></div>
    <button class="card-more" data-action="remove-media" data-media-id="${item.id}" type="button">${icons.more}</button>
  </div>
`;

const renderCharacterVisual = (character) => {
  const version = characterVersion(character);
  const asset = version ? mediaById(version.sheetAssetId) : null;
  if (asset) return renderMediaVisual(asset);
  return `<div class="character-placeholder">${icons.magic}<span>${character.status === 'failed' ? 'failed' : 'draft'}</span></div>`;
};

const renderCharactersPanel = () => `
  <div class="panel-heading"><div><span class="eyebrow">IDENTITY LIBRARY</span><h2>Characters</h2></div></div>
  <div class="character-grid">
    <button class="character-card character-add-card" data-action="create-character" type="button"><span>${icons.plus}</span><strong>New character</strong></button>
    ${characterLibrary.load().map((character) => `<button class="character-card" data-character-id="${character.id}" type="button"><div class="character-sheet">${renderCharacterVisual(character)}</div><div class="character-card-copy"><strong>${escapeHtml(character.name)}</strong><span>${character.lockedVersionId ? 'Locked' : character.status} · ${character.versions.length} ${character.versions.length === 1 ? 'version' : 'versions'}</span></div>${character.lockedVersionId ? '<span class="character-lock">LOCKED</span>' : ''}</button>`).join('')}
  </div>
  ${state.characters.length ? '' : '<div class="panel-empty"><span>Create reusable identities without adding clips to the timeline.</span></div>'}
  <div class="panel-footnote"><span class="fal-dot"></span><span>Versioned references</span><span class="status-pill">local</span></div>
`;

const renderCharacterModal = () => {
  if (state.characterModalMode === 'composer') return renderCharacterComposerModal();
  const character = characterById(state.selectedCharacterId);
  if (!character) return '';
  const activeVersion = characterVersion(character);
  const sheet = activeVersion ? mediaById(activeVersion.sheetAssetId) : null;
  const imageAssets = state.media.filter((asset) => asset.kind === 'image');
  return `
    <div class="modal-backdrop" data-action="close-character-modal">
      <section class="character-modal" role="dialog" aria-modal="true" aria-labelledby="characterModalTitle">
        <div class="modal-head"><div><span class="eyebrow">CHARACTER DETAIL</span><h2 id="characterModalTitle">${escapeHtml(character.name)}</h2></div><button class="small-icon-button" data-action="close-character-modal" aria-label="Close" type="button">${icons.close}</button></div>
        <div class="character-detail-grid">
          <div class="character-detail-sheet">${sheet ? renderMediaVisual(sheet) : `<div class="character-placeholder">${icons.magic}<span>Add an image version</span></div>`}${character.lockedVersionId ? '<span class="character-lock detail-lock">LOCKED VERSION</span>' : ''}</div>
          <div class="character-detail-copy">
            <form class="character-name-form" data-character-name-form>
              <label for="characterName">Character name</label>
              <div><input id="characterName" name="name" value="${escapeHtml(character.name)}" required /><button class="button ghost" type="submit">Rename</button></div>
            </form>
            <div class="character-status-row"><span>Status</span><strong>${escapeHtml(character.status)}</strong><span>Active version</span><strong>${activeVersion ? escapeHtml(activeVersion.id) : 'None'}</strong></div>
            <div class="character-version-actions">
              <label for="characterVersionAsset">Create a version from imported media</label>
              <div><select id="characterVersionAsset" ${imageAssets.length ? '' : 'disabled'}>${imageAssets.map((asset) => `<option value="${asset.id}">${escapeHtml(asset.name)}</option>`).join('')}</select><button class="button ghost" data-action="record-character-version" type="button" ${imageAssets.length ? '' : 'disabled'}>Add version</button></div>
              ${imageAssets.length ? '' : '<small>Import an image in Media first.</small>'}
            </div>
            <div class="character-lock-actions">${activeVersion ? character.lockedVersionId ? '<button class="button ghost" data-action="unlock-character" type="button">Unlock character</button>' : '<button class="button primary" data-action="lock-character" type="button">Lock character</button>' : '<span>Add a version before locking this identity.</span>'}</div>
          </div>
        </div>
        <div class="character-version-list"><div class="version-list-head"><strong>Immutable versions</strong><span>${character.versions.length}</span></div>${character.versions.length ? character.versions.map((version, index) => { const asset = mediaById(version.sheetAssetId); const isActive = version.id === activeVersion?.id; return `<button class="character-version-row ${isActive ? 'active' : ''}" data-action="activate-character-version" data-version-id="${version.id}" type="button" ${character.lockedVersionId ? 'disabled' : ''}><span class="version-number">V${index + 1}</span><div class="version-thumb">${asset ? renderMediaVisual(asset) : icons.image}</div><div><strong>${escapeHtml(asset?.name || 'Missing sheet asset')}</strong><span>${escapeHtml(version.modelId)} · ${new Date(version.createdAt).toLocaleString()}</span></div><span>${version.id === character.lockedVersionId ? 'Locked' : isActive ? 'Active' : 'Select'}</span></button>`; }).join('') : '<div class="version-empty">Versions are append-only. Existing versions are never overwritten.</div>'}</div>
      </section>
    </div>
  `;
};

const renderCharacterComposerModal = () => {
  const job = characterGenerationController?.snapshot() || {status: 'idle', providerStatus: null, attempt: 0, error: null};
  const isWorking = job.status === 'generating' || job.status === 'retrying';
  const input = state.characterComposerInput;
  const imageAssets = state.media.filter((asset) => asset.kind === 'image');
  const action = job.status === 'failed'
    ? '<button class="button primary" data-action="retry-character-generation" type="button">Retry generation</button>'
    : `<button class="button primary" type="submit" ${isWorking ? 'disabled' : ''}>${isWorking ? 'Generating…' : 'Generate character sheet'}</button>`;
  return `
    <div class="modal-backdrop" data-action="close-character-modal">
      <section class="character-modal composer-modal" role="dialog" aria-modal="true" aria-labelledby="characterComposerTitle">
        <div class="modal-head"><div><span class="eyebrow">NEW CHARACTER</span><h2 id="characterComposerTitle">Character composer</h2></div><button class="small-icon-button" data-action="close-character-modal" aria-label="Close" type="button">${icons.close}</button></div>
        <form class="character-composer-form" data-character-composer-form>
          <div class="composer-fields">
            <label for="composerName">Character name</label>
            <input id="composerName" name="name" value="${escapeHtml(input.name)}" placeholder="Marlow the fox" ${isWorking ? 'disabled' : ''} required />
            <label for="composerPrompt">Visual prompt</label>
            <textarea id="composerPrompt" name="prompt" rows="5" placeholder="Describe appearance, clothing, proportions, and expressions…" ${isWorking ? 'disabled' : ''} required>${escapeHtml(input.prompt)}</textarea>
            <label for="composerStyleNotes">Style notes</label>
            <textarea id="composerStyleNotes" name="styleNotes" rows="3" placeholder="Palette, line quality, camera, rendering style…" ${isWorking ? 'disabled' : ''}>${escapeHtml(input.styleNotes)}</textarea>
          </div>
          <fieldset class="composer-references" ${isWorking ? 'disabled' : ''}><legend>Optional media references</legend>${imageAssets.length ? `<div class="reference-options">${imageAssets.map((asset) => `<label><input type="checkbox" name="referenceAssetIds" value="${asset.id}" ${input.referenceAssetIds.includes(asset.id) ? 'checked' : ''}/><span class="reference-option-thumb">${renderMediaVisual(asset)}</span><span>${escapeHtml(asset.name)}</span></label>`).join('')}</div>` : '<p>Import images in Media to use them as references.</p>'}</fieldset>
          <div class="generation-job-card ${job.status}">
            <span class="job-state-dot"></span>
            <div><strong>${job.status === 'idle' ? 'Ready to compose' : job.status === 'failed' ? 'Generation failed' : job.status === 'ready' ? 'Character sheet ready' : job.status === 'retrying' ? 'Retrying character sheet' : 'Generating character sheet'}</strong><span>${job.status === 'idle' ? 'The local adapter creates a deterministic sheet without network calls.' : job.status === 'failed' ? escapeHtml(job.error || 'Unknown generation error') : `${escapeHtml(job.providerStatus || 'queued')} · attempt ${job.attempt}`}</span></div>
          </div>
          <div class="composer-foot"><small>Deterministic test path: include <code>[fail]</code> in the prompt, then remove it before retrying.</small>${action}</div>
        </form>
      </section>
    </div>
  `;
};

const renderScenesPanel = () => `
  <div class="panel-heading"><div><span class="eyebrow">PROJECT MAP</span><h2>Scenes</h2></div><button class="small-icon-button" type="button">${icons.plus}</button></div>
  <div class="scene-list">${project.scenes.map((scene, index) => `<div class="scene-item ${scene.id === project.timeline.activeSceneId ? 'active' : ''}"><span class="scene-number">${String(index + 1).padStart(2, '0')}</span><div><strong>${escapeHtml(scene.name)}</strong><span>${escapeHtml(project.project.name)} · ${formatTime(scene.duration)}</span></div><span class="scene-status"></span></div>`).join('')}</div>
  <div class="scene-empty"><div class="scene-line"></div><span>Scenes will group timeline beats as your story grows.</span></div>
`;

const renderInspector = () => {
  const selected = clipById(state.selectedClipId);
  const media = selected ? mediaById(selected.assetId) : null;
  return `
    <div class="inspector-head"><div><span class="eyebrow">INSPECTOR</span><h2>${selected ? 'Clip properties' : 'Workspace'}</h2></div><button class="small-icon-button" type="button">${icons.more}</button></div>
    ${selected && media ? `<div class="selected-preview ${media.kind}">${media.url ? media.kind === 'audio' ? `<div class="audio-orb">${icons.audio}</div>` : renderMediaVisual(media) : `<div class="offline-thumb">${kindIcon(media.kind)}<span>re-import source</span></div>`}<span class="selected-type">${media.kind.toUpperCase()}</span></div><div class="inspector-title"><strong>${escapeHtml(media.name)}</strong><span>${selected.trackId === 'V1' ? 'Video track' : 'Audio track'} · ${formatTime(selected.duration)}</span></div><div class="property-group"><label>Timing</label><div class="property-grid"><div><span>Start</span><strong>${formatTime(selected.start)}</strong></div><div><span>Duration</span><strong>${formatTime(selected.duration)}</strong></div></div></div><div class="property-group"><label>Source</label><div class="source-line"><span class="source-icon">${kindIcon(media.kind)}</span><span>${escapeHtml(media.name)}</span></div></div><button class="danger-button" data-action="delete-clip" type="button">${icons.close} Remove from timeline</button>` : `<div class="workspace-card"><div class="workspace-glow">${icons.magic}</div><strong>Compose with intent</strong><span>Select a timeline clip to inspect timing, provenance, and future generation settings.</span></div>`}
    <div class="fal-card"><div class="fal-card-top"><div class="fal-logo">f/</div><div><strong>FAL connection</strong><span>Generation adapter</span></div><span class="connection-indicator" id="falIndicator"></span></div><div class="fal-status" id="falStatus">Checking local adapter…</div><button class="fal-button" type="button" disabled>${icons.magic} Add a generation later</button></div>
  `;
};

const renderTimeline = () => {
  const timelineWidth = Math.max(900, (state.timelineDuration + 3) * scale());
  const ticks = Array.from({length: Math.ceil(state.timelineDuration) + 2}, (_, index) => index);
  const videoClips = state.clips.filter((clip) => clip.trackId === 'V1');
  const audioClips = state.clips.filter((clip) => clip.trackId === 'A1');
  return `
    <div class="timeline-toolbar"><div class="timeline-title"><span class="eyebrow">EDIT</span><h2>Timeline</h2><span class="sequence-chip">${escapeHtml(activeScene()?.name || 'Scene 01')}</span></div><div class="timeline-actions"><button class="toolbar-button" data-action="split" type="button">${icons.scissors} Split</button><button class="toolbar-button" data-action="add-track" type="button">${icons.plus} Track</button><span class="tool-divider"></span><button class="toolbar-button" data-action="zoom-out" type="button">−</button><span class="zoom-value">${Math.round(state.zoom * 100)}%</span><button class="toolbar-button" data-action="zoom-in" type="button">+</button></div></div>
    <div class="timeline-body">
      <div class="track-labels"><div class="ruler-spacer"></div><div class="track-label video-label"><span class="track-color video"></span><div><strong>Video</strong><span>V1</span></div></div><div class="track-label audio-label"><span class="track-color audio"></span><div><strong>Audio</strong><span>A1</span></div></div></div>
      <div class="timeline-scroll" id="timelineScroll"><div class="timeline-content" id="timelineContent" style="width:${timelineWidth}px">
        <div class="ruler" id="timelineRuler">${ticks.map((tick) => `<div class="tick ${tick % 5 === 0 ? 'major' : ''}" style="left:${tick * scale()}px"><span>${formatTime(tick).slice(0, 5)}</span></div>`).join('')}</div>
        <div class="track-lane video-lane" data-track-id="V1">${videoClips.length ? videoClips.map(renderClip).join('') : '<div class="lane-placeholder">Drop video or images here</div>'}</div>
        <div class="track-lane audio-lane" data-track-id="A1">${audioClips.length ? audioClips.map(renderClip).join('') : '<div class="lane-placeholder">Drop audio here</div>'}</div>
        <div class="playhead" id="playhead" style="left:${state.currentTime * scale()}px"><span></span></div>
      </div></div>
    </div>
  `;
};

const renderClip = (clip) => {
  const media = mediaById(clip.assetId);
  if (!media) return '';
  const width = Math.max(clip.duration * scale(), 66);
  return `<div class="timeline-clip ${media.kind} ${clip.id === state.selectedClipId ? 'selected' : ''}" draggable="true" data-clip-id="${clip.id}" style="left:${clip.start * scale()}px;width:${width}px"><div class="clip-thumb">${media.url ? media.kind === 'audio' ? `<span>${icons.audio}</span>` : renderMediaVisual(media) : `<span>${kindIcon(media.kind)}</span>`}</div><div class="clip-copy"><strong>${escapeHtml(media.name)}</strong><span>${formatTime(clip.duration)}</span></div><div class="clip-handle left"></div><div class="clip-handle right"></div></div>`;
};

const bindEvents = () => {
  app.querySelectorAll('[data-action="open-file"]').forEach((button) => button.addEventListener('click', () => fileInput.click()));
  app.querySelectorAll('[data-action="add-sample"]').forEach((button) => button.addEventListener('click', addSampleMedia));
  app.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => { state.activeTab = button.dataset.tab; renderApp(); }));
  app.querySelector('[data-action="create-character"]')?.addEventListener('click', createCharacter);
  app.querySelectorAll('[data-character-id]').forEach((button) => button.addEventListener('click', () => openCharacter(button.dataset.characterId)));
  app.querySelectorAll('[data-action="close-character-modal"]').forEach((element) => element.addEventListener('click', (event) => { if (event.currentTarget === event.target || event.currentTarget.tagName === 'BUTTON') closeCharacterModal(); }));
  app.querySelector('[data-character-name-form]')?.addEventListener('submit', renameCharacter);
  app.querySelector('[data-character-composer-form]')?.addEventListener('submit', submitCharacterComposer);
  app.querySelector('[data-action="retry-character-generation"]')?.addEventListener('click', retryCharacterComposer);
  app.querySelector('[data-action="record-character-version"]')?.addEventListener('click', recordCharacterVersion);
  app.querySelector('[data-action="lock-character"]')?.addEventListener('click', lockCharacter);
  app.querySelector('[data-action="unlock-character"]')?.addEventListener('click', unlockCharacter);
  app.querySelectorAll('[data-action="activate-character-version"]').forEach((button) => button.addEventListener('click', () => activateCharacterVersion(button.dataset.versionId)));
  app.querySelector('[data-dropzone="media"]')?.addEventListener('dragover', (event) => { event.preventDefault(); event.currentTarget.classList.add('dragging'); });
  app.querySelector('[data-dropzone="media"]')?.addEventListener('dragleave', (event) => event.currentTarget.classList.remove('dragging'));
  app.querySelector('[data-dropzone="media"]')?.addEventListener('drop', (event) => { event.preventDefault(); event.currentTarget.classList.remove('dragging'); addFiles([...event.dataTransfer.files]); });
  app.querySelectorAll('[data-media-id]').forEach((element) => {
    if (element.draggable) {
      element.addEventListener('dragstart', (event) => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('text/media-id', element.dataset.mediaId); });
      element.addEventListener('pointerdown', (event) => startPointerDrag(event, 'media', element.dataset.mediaId));
    }
  });
  app.querySelectorAll('[data-action="remove-media"]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); removeMedia(button.dataset.mediaId); }));
  app.querySelectorAll('[data-clip-id]').forEach((clipElement) => {
    clipElement.addEventListener('click', () => { state.selectedClipId = clipElement.dataset.clipId; renderApp(); });
    clipElement.addEventListener('dragstart', (event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/clip-id', clipElement.dataset.clipId); });
    clipElement.addEventListener('pointerdown', (event) => startPointerDrag(event, 'clip', clipElement.dataset.clipId));
  });
  app.querySelectorAll('.track-lane').forEach((lane) => {
    lane.addEventListener('dragover', (event) => { event.preventDefault(); lane.classList.add('dragging'); });
    lane.addEventListener('dragleave', () => lane.classList.remove('dragging'));
    lane.addEventListener('drop', (event) => { event.preventDefault(); lane.classList.remove('dragging'); dropOnTimeline(event, lane.dataset.trackId); });
    lane.addEventListener('click', (event) => { if (event.target.closest('.timeline-clip')) return; seekFromTimeline(event); });
  });
  app.querySelector('#timelineRuler')?.addEventListener('click', seekFromTimeline);
  app.querySelector('[data-action="toggle-play"]')?.addEventListener('click', togglePlay);
  app.querySelector('[data-action="step-back"]')?.addEventListener('click', () => seekTo(state.currentTime - 1 / 30));
  app.querySelector('[data-action="step-forward"]')?.addEventListener('click', () => seekTo(state.currentTime + 1 / 30));
  app.querySelector('[data-action="zoom-in"]')?.addEventListener('click', () => { state.zoom = Math.min(2, state.zoom + 0.1); renderApp(); });
  app.querySelector('[data-action="zoom-out"]')?.addEventListener('click', () => { state.zoom = Math.max(0.6, state.zoom - 0.1); renderApp(); });
  app.querySelector('[data-action="delete-clip"]')?.addEventListener('click', deleteSelectedClip);
  app.querySelector('[data-action="render"]')?.addEventListener('click', () => showToast('Render queue is ready for a FAL model hookup.'));
  app.querySelector('[data-action="export"]')?.addEventListener('click', () => showToast('Export will be connected after the composition pipeline is defined.'));
  checkFalStatus();
};

const createCharacter = () => {
  state.selectedCharacterId = null;
  state.characterModalMode = 'composer';
  state.characterComposerInput = {name: '', prompt: '', styleNotes: '', referenceAssetIds: []};
  characterGenerationController = null;
  state.isCharacterModalOpen = true;
  renderApp();
};

const openCharacter = (characterId) => {
  state.selectedCharacterId = characterId;
  state.characterModalMode = 'detail';
  state.isCharacterModalOpen = true;
  renderApp();
};

const closeCharacterModal = () => {
  state.isCharacterModalOpen = false;
  renderApp();
};

const renameCharacter = (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    characterLibrary.rename(state.selectedCharacterId, String(form.get('name') || ''));
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const recordCharacterVersion = () => {
  const assetId = app.querySelector('#characterVersionAsset')?.value;
  const asset = mediaById(assetId);
  if (!asset) return;
  characterLibrary.recordVersion(state.selectedCharacterId, {
    sheetAssetId: asset.id,
    referenceAssetIds: [asset.id],
    prompt: '',
    modelId: 'local/manual',
    seed: null,
    params: {},
    parentAssetIds: [asset.id],
  });
  renderApp();
};

const activateCharacterVersion = (versionId) => {
  characterLibrary.activateVersion(state.selectedCharacterId, versionId);
  renderApp();
};

const lockCharacter = () => {
  const character = characterById(state.selectedCharacterId);
  if (character?.activeVersionId) characterLibrary.lockVersion(character.id, character.activeVersionId);
  renderApp();
};

const unlockCharacter = () => {
  characterLibrary.unlockVersion(state.selectedCharacterId);
  renderApp();
};

const composerInputFromForm = () => {
  const form = app.querySelector('[data-character-composer-form]');
  if (!form) throw new Error('Character composer is unavailable.');
  const data = new FormData(form);
  return normalizeCharacterGenerationInput({
    name: data.get('name'),
    prompt: data.get('prompt'),
    styleNotes: data.get('styleNotes'),
    referenceAssetIds: data.getAll('referenceAssetIds'),
  });
};

const createComposerController = (characterId) => createCharacterGenerationController({
  adapter: characterGenerationAdapter,
  onCompleted: async (result, input) => {
    recordCharacterSheetVersion({
      dispatch: updateProject,
      library: characterLibrary,
      characterId,
      input,
      result,
    });
  },
});

const submitCharacterComposer = async (event) => {
  event.preventDefault();
  try {
    const input = composerInputFromForm();
    state.characterComposerInput = input;
    if (!state.selectedCharacterId) {
      state.selectedCharacterId = characterLibrary.createDraft(input.name).affectedId;
      characterGenerationController = createComposerController(state.selectedCharacterId);
    } else {
      characterLibrary.rename(state.selectedCharacterId, input.name);
    }
    await characterGenerationController.submit(input);
    renderApp();
    scheduleCharacterPoll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const retryCharacterComposer = async () => {
  try {
    const input = composerInputFromForm();
    state.characterComposerInput = input;
    characterLibrary.rename(state.selectedCharacterId, input.name);
    characterLibrary.setStatus(state.selectedCharacterId, 'draft');
    await characterGenerationController.retry(input);
    renderApp();
    scheduleCharacterPoll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const scheduleCharacterPoll = () => {
  clearTimeout(characterPollTimer);
  characterPollTimer = setTimeout(pollCharacterGeneration, 250);
};

const pollCharacterGeneration = async () => {
  if (!characterGenerationController) return;
  const job = await characterGenerationController.poll();
  if (job.status === 'failed' && state.selectedCharacterId) {
    characterLibrary.setStatus(state.selectedCharacterId, 'failed');
  }
  if (job.status === 'ready') state.characterModalMode = 'detail';
  renderApp();
  if (job.status === 'generating' || job.status === 'retrying') scheduleCharacterPoll();
};

const dropOnTimeline = (event, trackId) => {
  const mediaId = event.dataTransfer.getData('text/media-id');
  const clipId = event.dataTransfer.getData('text/clip-id');
  placeOnTimeline({mediaId, clipId, clientX: event.clientX, trackId});
};

const startPointerDrag = (event, type, id) => {
  if (event.button !== 0) return;
  event.preventDefault();
  state.dragPayload = {type, id};
  document.body.classList.add('dragging-payload');

  const onPointerUp = (upEvent) => {
    const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
    const lane = target?.closest('.track-lane');
    if (lane && state.dragPayload) {
      placeOnTimeline({
        mediaId: state.dragPayload.type === 'media' ? state.dragPayload.id : '',
        clipId: state.dragPayload.type === 'clip' ? state.dragPayload.id : '',
        clientX: upEvent.clientX,
        trackId: lane.dataset.trackId,
      });
    }
    state.dragPayload = null;
    document.body.classList.remove('dragging-payload');
    document.removeEventListener('pointerup', onPointerUp);
  };

  document.addEventListener('pointerup', onPointerUp, {once: true});
};

const placeOnTimeline = ({mediaId, clipId, clientX, trackId}) => {
  const start = timeFromClientX(clientX);
  if (mediaId) {
    const media = mediaById(mediaId);
    if (!media) return;
    const result = updateProject({
      type: 'clip/add',
      assetId: mediaId,
      trackId,
      start,
    });
    state.selectedClipId = result.affectedId;
  } else if (clipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    const result = updateProject({type: 'clip/move', clipId, trackId, start});
    state.selectedClipId = result.affectedId;
  }
  renderApp();
};

const timeFromPointer = (event) => {
  return timeFromClientX(event.clientX);
};

const timeFromClientX = (clientX) => {
  const content = app.querySelector('#timelineContent');
  const scroll = app.querySelector('#timelineScroll');
  if (!content || !scroll) return 0;
  const rect = content.getBoundingClientRect();
  return Math.max(0, Math.round(((clientX - rect.left) / scale()) * 10) / 10);
};

const seekFromTimeline = (event) => seekTo(timeFromPointer(event));

const addFiles = (files) => {
  files.filter((file) => file.type.startsWith('video/') || file.type.startsWith('audio/') || file.type.startsWith('image/')).forEach((file) => {
    const kind = mediaKind(file);
    const result = updateProject({
      type: 'asset/import',
      asset: {
        name: file.name,
        kind,
        mimeType: file.type,
        size: file.size,
        duration: kind === 'image' ? 5 : 0,
        url: URL.createObjectURL(file),
        source: {type: 'local-file', fileName: file.name, lastModified: file.lastModified},
        metadata: {},
      },
    });
    const item = mediaById(result.affectedId);
    if (kind === 'image') renderApp();
    else {
      const probe = document.createElement(kind === 'audio' ? 'audio' : 'video');
      probe.preload = 'metadata';
      probe.src = item.url;
      probe.onloadedmetadata = () => { updateProject({type: 'asset/update', assetId: item.id, patch: {duration: Number.isFinite(probe.duration) ? probe.duration : 5}}); renderApp(); };
      probe.onerror = () => { updateProject({type: 'asset/update', assetId: item.id, patch: {duration: 5}}); renderApp(); };
    }
  });
  if (files.length) showToast(`${files.length} media ${files.length === 1 ? 'file' : 'files'} imported.`);
};

const addSampleMedia = () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#6d4bd5"/><stop offset="1" stop-color="#42b9af"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="510" cy="90" r="72" fill="#f7d6a0" opacity=".8"/><text x="48" y="190" fill="white" font-family="sans-serif" font-size="42" font-weight="700">PrismFlow sample</text></svg>`;
  addFiles([new File([svg], 'prismflow-sample.svg', {type: 'image/svg+xml'})]);
};

const removeMedia = (mediaId) => {
  const clips = state.clips.filter((clip) => clip.assetId === mediaId);
  clips.forEach((clip) => { if (clip.id === state.selectedClipId) state.selectedClipId = null; });
  const item = mediaById(mediaId);
  if (item?.url) URL.revokeObjectURL(item.url);
  updateProject({type: 'asset/remove', assetId: mediaId});
  renderApp();
};

const deleteSelectedClip = () => {
  updateProject({type: 'clip/remove', clipId: state.selectedClipId});
  state.selectedClipId = null;
  renderApp();
};

const activeClipAt = (time) => state.clips.find((clip) => time >= clip.start && time < clip.start + clip.duration);

const syncPreview = (forceSeek = false) => {
  const video = app.querySelector('#previewVideo');
  const image = app.querySelector('#previewImage');
  const audio = app.querySelector('#audioPreview');
  const empty = app.querySelector('#emptyPreview');
  if (!video || !image || !audio || !empty) return;
  const clip = activeClipAt(state.currentTime);
  const media = clip ? mediaById(clip.assetId) : null;
  const hasSource = Boolean(media?.url);
  const shouldShow = (element, show) => element.classList.toggle('visible', Boolean(show));
  shouldShow(empty, !hasSource);
  shouldShow(video, hasSource && media?.kind === 'video');
  shouldShow(image, hasSource && media?.kind === 'image');
  shouldShow(audio, hasSource && media?.kind === 'audio');
  const emptyTitle = empty.querySelector('strong');
  const emptyCopy = empty.querySelector('span');
  if (media && !hasSource) {
    if (emptyTitle) emptyTitle.textContent = 'Source needs re-import';
    if (emptyCopy) emptyCopy.textContent = `${media.name} metadata and timeline placement are still saved.`;
  }
  if (!media || !clip || !hasSource) {
    video.pause();
    audio.querySelector('audio')?.pause();
    state.previewSourceId = null;
    state.previewClipId = null;
  } else if (state.previewSourceId !== media.id || state.previewClipId !== clip.id) {
    state.previewSourceId = media.id;
    state.previewClipId = clip.id;
    if (media.kind === 'video') { video.src = media.url; video.currentTime = Math.max(0, state.currentTime - clip.start); }
    if (media.kind === 'image') image.src = media.url;
    if (media.kind === 'audio') {
      if (!audio.querySelector('audio')) { const element = document.createElement('audio'); element.controls = false; audio.append(element); }
      const audioElement = audio.querySelector('audio'); audioElement.src = media.url; audioElement.currentTime = Math.max(0, state.currentTime - clip.start);
    }
  } else if (forceSeek) {
    if (media.kind === 'video') video.currentTime = Math.max(0, state.currentTime - clip.start);
    if (media.kind === 'audio') { const audioElement = audio.querySelector('audio'); if (audioElement) audioElement.currentTime = Math.max(0, state.currentTime - clip.start); }
  }
  if (state.isPlaying && media) {
    if (media.kind === 'video') video.play().catch(() => {});
    if (media.kind === 'audio') audio.querySelector('audio')?.play().catch(() => {});
  } else {
    video.pause();
    audio.querySelector('audio')?.pause();
  }
};

const updatePlaybackFrame = () => {
  if (!state.isPlaying) return;
  const elapsed = (performance.now() - state.playbackStartedAt) / 1000;
  state.currentTime = Math.min(state.timelineDuration, state.playbackOrigin + elapsed);
  const playhead = app.querySelector('#playhead');
  if (playhead) playhead.style.left = `${state.currentTime * scale()}px`;
  const current = app.querySelector('#playerCurrent');
  if (current) current.textContent = formatTime(state.currentTime);
  const clip = activeClipAt(state.currentTime);
  if (clip && (clip.id !== state.previewClipId || mediaById(clip.assetId)?.id !== state.previewSourceId)) syncPreview(true);
  if (state.currentTime >= state.timelineDuration) {
    state.isPlaying = false;
    state.currentTime = 0;
    state.previewSourceId = null;
    state.previewClipId = null;
    renderApp();
    return;
  }
  state.rafId = requestAnimationFrame(updatePlaybackFrame);
};

const togglePlay = () => {
  if (state.isPlaying) {
    state.isPlaying = false;
    cancelAnimationFrame(state.rafId);
    syncPreview();
    renderApp();
  } else {
    if (state.currentTime >= state.timelineDuration) state.currentTime = 0;
    state.isPlaying = true;
    state.playbackOrigin = state.currentTime;
    state.playbackStartedAt = performance.now();
    syncPreview(true);
    renderApp();
    state.rafId = requestAnimationFrame(updatePlaybackFrame);
  }
};

const seekTo = (time) => {
  state.currentTime = Math.max(0, Math.min(state.timelineDuration, time));
  state.previewSourceId = null;
  state.previewClipId = null;
  renderApp();
};

const checkFalStatus = async () => {
  const status = app.querySelector('#falStatus');
  const indicator = app.querySelector('#falIndicator');
  if (!status || !indicator) return;
  try {
    const response = await fetch('/api/fal/status');
    const data = await response.json();
    status.textContent = data.configured ? 'Server key detected · ready for models' : 'Add FAL_API_KEY to .env to enable calls';
    indicator.classList.toggle('ready', Boolean(data.configured));
  } catch {
    status.textContent = 'Local adapter is offline';
    indicator.classList.remove('ready');
  }
};

const showToast = (message) => {
  const existing = document.querySelector('.toast');
  existing?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => { toast.classList.remove('visible'); setTimeout(() => toast.remove(), 220); }, 2600);
};

fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !['INPUT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName)) { event.preventDefault(); togglePlay(); }
});

renderApp();
