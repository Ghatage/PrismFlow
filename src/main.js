import {createProjectStore} from './project-store.js';
import {createBrowserDatabase} from './browser-database.js';
import {createCharacterLibrary} from './character-library.js';
import {createStyleLibrary} from './style-library.js';
import {
  createCharacterGenerationController,
  createFakeCharacterGenerationAdapter,
  createServerCharacterGenerationAdapter,
  normalizeCharacterGenerationInput,
  recordCharacterSheetVersion,
} from './character-generation.js';
import {createTimelineCharacterAttachments} from './timeline-characters.js';
import {createTimelineDiffs} from './timeline-diffs.js';
import {
  buildGhostItems,
  derivePreviewClips,
  findGhostItem,
  listReviewableDiffs,
  listReviewItems,
  reviseGhostProposal,
  selectFirstReviewItem,
  selectNextReviewItem,
  selectPreviousReviewItem,
} from './timeline-diff-review.js';
import {
  createFakeTimelineGenerationAdapter,
  createServerTimelineGenerationAdapter,
} from './timeline-generation.js';
import {createClipRegenerationService} from './clip-regeneration.js';
import {resolveTimelinePlaybackAt} from './timeline-playback.js';
import {formatCredits, formatUsd, normalizeQualityTier, qualitySettingsFor} from './quality-tiers.js';
import {createAgentWorkspace} from './agent-workspace.js';
import {createProjectContextService} from './project-context.js';
import {createVideoFrameIndexer} from './video-indexing.js';

const legacyStorage = {
  getItem: (key) => {
    try {
      return globalThis.localStorage?.getItem(key) || null;
    } catch {
      return null;
    }
  },
  setItem: () => {},
};
const projectDatabase = createBrowserDatabase();
let projectStore = createProjectStore({storage: legacyStorage});
let project = projectStore.getProject();

const state = {
  get media() { return project.mediaAssets; },
  get characters() { return project.characters; },
  get styles() { return project.styles; },
  get agentWorkspace() { return project.agentWorkspace; },
  get clips() { return project.timeline.clips; },
  get tracks() { return project.timeline.tracks; },
  get pendingDiffs() { return listReviewableDiffs(project.timelineDiffs.items); },
  get timelineDuration() { return project.timeline.duration; },
  selectedClipId: null,
  selectedGhostKey: null,
  previewDiffId: null,
  regenerationEditorClipId: null,
  regenerationEditorMode: 'prompt',
  currentTime: 0,
  isPlaying: false,
  zoom: 1,
  activeTab: 'media',
  agentPaneOpen: false,
  videoSearchQuery: '',
  videoSearchLoading: false,
  videoSearchError: '',
  videoSearchResults: [],
  selectedFrameResult: null,
  videoIndexingByAsset: new Map(),
  trackMenuOpen: false,
  selectedCharacterId: null,
  isCharacterModalOpen: false,
  characterModalMode: 'detail',
  selectedStyleId: null,
  isStyleModalOpen: false,
  characterComposerInput: {name: '', prompt: '', styleNotes: '', referenceAssetIds: []},
  rebaseConflicts: {},
  mediaPanelOpen: true,
  mediaHydrated: false,
  previewPlaybackSignature: null,
  timelineScrollTop: 0,
  timelineScrollLeft: 0,
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
const styleLibrary = createStyleLibrary({
  getProject: () => project,
  dispatch: updateProject,
});
const agentWorkspace = createAgentWorkspace({
  getProject: () => project,
  dispatch: updateProject,
});
const projectContext = createProjectContextService({
  getProject: () => project,
  dispatch: updateProject,
});
const videoIndexer = createVideoFrameIndexer({
  database: projectDatabase,
  getProject: () => project,
  onProgress: (manifest) => {
    state.videoIndexingByAsset.set(manifest.videoAssetId, manifest);
    const asset = project.mediaAssets.find((candidate) => candidate.id === manifest.videoAssetId);
    if (asset) updateProject({
      type: 'asset/update',
      assetId: asset.id,
      patch: {metadata: {videoIndex: {
        status: manifest.status,
        frameCount: manifest.frameCount,
        completedCount: manifest.completedCount,
        interval: manifest.interval,
        modelId: manifest.modelId,
        updatedAt: manifest.updatedAt,
      }}},
    });
  },
});
const timelineCharacterAttachments = createTimelineCharacterAttachments({
  getProject: () => project,
  dispatch: updateProject,
});
const timelineDiffs = createTimelineDiffs({getProject: () => project, dispatch: updateProject});
const useFakeTimelineAdapter = new URLSearchParams(globalThis.location.search).get('timelineAdapter') === 'fake';
const timelineGenerationAdapter = useFakeTimelineAdapter
  ? createFakeTimelineGenerationAdapter()
  : createServerTimelineGenerationAdapter();
const clipRegeneration = createClipRegenerationService({
  store: {getProject: () => project, dispatch: updateProject},
  diffs: timelineDiffs,
  adapter: timelineGenerationAdapter,
});
let regenerationPollTimer = null;
const useFakeCharacterAdapter = new URLSearchParams(globalThis.location.search).get('characterAdapter') === 'fake';
const characterGenerationAdapter = useFakeCharacterAdapter
  ? createFakeCharacterGenerationAdapter()
  : createServerCharacterGenerationAdapter({
    resolveReferenceUrl: (assetId) => project.mediaAssets.find((asset) => asset.id === assetId)?.url || null,
  });
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
const diffById = (id) => state.pendingDiffs.find((diff) => diff.id === id);
const selectedGhost = () => findGhostItem(state.pendingDiffs, state.selectedGhostKey);
const reviewItems = () => listReviewItems(state.pendingDiffs);
const reviewItemForDiff = (diffId) => reviewItems().find((item) => item.diffId === diffId) || null;
const selectReviewItem = (item) => {
  state.selectedGhostKey = item?.ghostKey || item?.key || null;
  state.selectedClipId = null;
  return item;
};
const mediaById = (id) => state.media.find((item) => item.id === id);
const characterById = (id) => state.characters.find((character) => character.id === id);
const characterVersion = (character) => character?.versions.find((version) => version.id === (character.lockedVersionId || character.activeVersionId)) || null;
const styleById = (id) => state.styles.find((style) => style.id === id);
const styleVersion = (style) => style?.versions.find((version) => version.id === (style.lockedVersionId || style.activeVersionId)) || null;
const activeScene = () => project.scenes.find((scene) => scene.id === project.timeline.activeSceneId) || project.scenes[0];
const scale = () => 88 * state.zoom;

const renderMediaVisual = (item) => {
  if (item.url && item.kind === 'image') return `<img src="${item.url}" alt="" />`;
  if (item.url && item.kind === 'video') return `<video src="${item.url}" muted preload="metadata"></video>`;
  if (item.kind === 'audio') return `<div class="audio-thumb">${icons.audio}</div>`;
  return `<div class="offline-thumb">${kindIcon(item.kind)}<span>offline</span></div>`;
};

const renderApp = () => {
  const previousTimelineBody = app.querySelector('.timeline-body');
  const previousTimelineScroll = app.querySelector('#timelineScroll');
  if (previousTimelineBody) state.timelineScrollTop = previousTimelineBody.scrollTop;
  if (previousTimelineScroll) state.timelineScrollLeft = previousTimelineScroll.scrollLeft;
  app.querySelectorAll('#previewVideo, #previewAudioMix audio').forEach((element) => element.pause());

  app.innerHTML = `
    <div class="shell" data-media-hydrated="${state.mediaHydrated}">
      <header class="topbar">
        <div class="brand-lockup">
          <div class="brand-mark"><span></span><span></span><span></span></div>
          <span class="brand-name">PrismFlow</span>
          <span class="brand-divider"></span>
          <button class="project-switcher" type="button">${escapeHtml(project.project.name)} ${icons.chevron}</button>
          <span class="save-state"><i></i> Local draft</span>
        </div>
        <form class="global-search" data-video-search-form role="search">
          <span class="global-search-icon" aria-hidden="true">⌕</span>
          <input name="query" value="${escapeHtml(state.videoSearchQuery)}" placeholder="Search video frames…" aria-label="Search video frames" autocomplete="off" />
          <button type="submit" ${state.videoSearchLoading ? 'disabled' : ''}>${state.videoSearchLoading ? 'Searching…' : 'Search'}</button>
        </form>
        <div class="top-actions">
          <button class="icon-button" title="Project settings" type="button">${icons.sliders}</button>
          <div class="fal-status-chip" id="falConnection" aria-live="polite" title="Checking local FAL adapter">
            <span class="connection-indicator" id="falIndicator"></span>
            <span class="fal-chip-label">FAL</span>
            <span id="falStatus">Checking…</span>
          </div>
          <div class="usage-chip" title="Estimated generation usage"><span>${formatCredits(project.usage?.credits || 0)}</span><small>${formatUsd(project.usage?.estimatedUsd || 0)}</small></div>
          <button class="button ghost" type="button" data-action="export">Export</button>
          <button class="button primary" type="button" data-action="render"><span class="button-spark">${icons.magic}</span> Render draft</button>
          <button class="avatar" type="button" aria-label="Account">PF</button>
        </div>
      </header>

      <main class="workspace ${state.mediaPanelOpen ? '' : 'media-panel-hidden'} ${state.agentPaneOpen ? 'agent-pane-open' : ''}">
        <aside class="sidebar left-panel ${state.mediaPanelOpen ? '' : 'is-hidden'}">
          <div class="panel-tabs">
            <button class="panel-tab ${state.activeTab === 'media' ? 'active' : ''}" data-tab="media" type="button">Media <span class="tab-count">${state.media.length || ''}</span></button>
            <button class="panel-tab ${state.activeTab === 'characters' ? 'active' : ''}" data-tab="characters" type="button">Characters <span class="tab-count">${state.characters.length || ''}</span></button>
            <button class="panel-tab ${state.activeTab === 'styles' ? 'active' : ''}" data-tab="styles" type="button">Styles <span class="tab-count">${state.styles.length || ''}</span></button>
            <button class="panel-tab ${state.activeTab === 'scenes' ? 'active' : ''}" data-tab="scenes" type="button">Scenes</button>
            <button class="panel-tab ${state.activeTab === 'script' ? 'active' : ''}" data-tab="script" type="button">Script <span class="tab-count">${state.agentWorkspace.script.beats.length || ''}</span></button>
          </div>
          ${state.activeTab === 'media' ? renderMediaPanel() : state.activeTab === 'characters' ? renderCharactersPanel() : state.activeTab === 'styles' ? renderStylesPanel() : state.activeTab === 'script' ? renderScriptPanel() : renderScenesPanel()}
        </aside>

        <section class="stage">
          <div class="stage-toolbar">
            <div class="breadcrumb"><span class="eyebrow">STORYBOARD</span><span class="slash">/</span><span>${escapeHtml(project.project.name)}</span></div>
            <div class="stage-tools"><button class="toolbar-button media-toggle" data-action="toggle-media-panel" aria-pressed="${state.mediaPanelOpen}" type="button">${icons.grid} ${state.mediaPanelOpen ? 'Hide media' : 'Show media'}</button><button class="toolbar-button" data-action="toggle-agent-pane" aria-pressed="${state.agentPaneOpen}" type="button">${icons.magic} ${state.agentPaneOpen ? 'Hide agent' : 'Agent'}</button><button class="toolbar-button" type="button">${icons.grid} Fit</button><button class="toolbar-button" type="button">100%</button><button class="toolbar-button" type="button">${icons.more}</button></div>
          </div>
          <div class="preview-wrap">
            <div class="preview-frame" id="previewFrame">
              <video id="previewVideo" playsinline preload="metadata"></video>
              <img id="previewImage" alt="Selected timeline image" />
              <div class="audio-preview" id="audioPreview"><div class="audio-orb">${icons.audio}</div><span>Audio clip</span></div>
              <div class="preview-audio-mix" id="previewAudioMix" aria-hidden="true"></div>
              <div class="safe-area"></div>
            </div>
            <div class="player-controls">
              <div class="player-time"><span id="playerCurrent">${formatTime(state.currentTime)}</span><span class="muted"> / </span><span id="playerDuration">${formatTime(playbackDuration())}</span></div>
              <div class="player-buttons"><button class="round-control" data-action="step-back" title="Previous frame" type="button">${icons.skipBack}</button><button class="play-control" data-action="toggle-play" title="${state.isPlaying ? 'Pause' : 'Play'}" type="button">${state.isPlaying ? icons.pause : icons.play}</button><button class="round-control" data-action="step-forward" title="Next frame" type="button">${icons.skipForward}</button></div>
              <div class="player-right" aria-live="polite"><span class="live-dot ${state.previewDiffId ? 'proposal' : ''}"></span><span data-player-status>${state.previewDiffId ? 'Proposal preview' : 'Accepted preview'}</span><button class="toolbar-button" type="button" aria-label="Player options">${icons.more}</button></div>
            </div>
          </div>
          ${renderContextPanel()}
          <div class="stage-footer"><div class="tip"><span class="tip-icon">${icons.magic}</span><span>FAL-ready workspace</span><span class="muted">Generation hooks are isolated until you are ready.</span></div><div class="keyboard-hint"><kbd>Space</kbd> play/pause <kbd>⌘K</kbd> command menu</div></div>
        </section>
        ${renderAgentPane()}
      </main>

      <section class="timeline-panel">
        ${renderTimeline()}
      </section>
    </div>
    ${state.isCharacterModalOpen ? renderCharacterModal() : state.isStyleModalOpen ? renderStyleModal() : ''}
  `;

  bindEvents();
  state.previewPlaybackSignature = null;
  syncPreview(true);
};

const renderMediaPanel = () => `
  <div class="panel-heading"><div><span class="eyebrow">ASSET BIN</span><h2>Media</h2></div></div>
  <div class="media-library" data-dropzone="media"><div class="media-list">${state.media.map(renderMediaCard).join('')}<button class="media-add-card" data-action="open-file" type="button" aria-label="Import media">${icons.plus}</button></div>${renderVideoSearchResults()}</div>
  <div class="panel-footnote"><span>Drag assets onto the timeline to start editing.</span></div>
`;

const renderMediaCard = (item) => {
  const videoIndex = state.videoIndexingByAsset.get(item.id) || item.metadata?.videoIndex;
  const isSelectedFrame = state.selectedFrameResult?.videoAssetId === item.id;
  const indexingLabel = item.kind === 'video' && videoIndex
    ? ` · ${videoIndex.status === 'complete' ? `${videoIndex.frameCount} frames indexed` : `indexing ${videoIndex.completedCount || 0}/${videoIndex.frameCount || '…'}`}`
    : '';
  return `
  <div class="media-card ${isSelectedFrame ? 'frame-selected' : ''}" draggable="true" data-media-id="${item.id}">
    <div class="media-thumb ${item.kind}">${renderMediaVisual(item)}<span class="type-badge">${kindIcon(item.kind)}</span></div>
    <div class="media-card-copy"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><span>${item.url ? `${item.kind} · ${item.kind === 'image' ? 'still' : formatTime(item.duration)}` : state.mediaHydrated ? `${item.kind} · re-import to preview` : `${item.kind} · restoring…`}${indexingLabel}</span></div>
    <button class="card-more" data-action="remove-media" data-media-id="${item.id}" type="button">${icons.more}</button>
  </div>
`;
};

const renderVideoSearchResults = () => state.videoSearchQuery ? `
  <div class="video-search-results" aria-label="Video frame search results">
    <div class="video-search-results-head"><span class="eyebrow">FRAME HITS</span><button type="button" data-action="clear-video-search">Clear</button></div>
    ${state.videoSearchLoading ? '<p class="video-search-empty">Searching annotated frames…</p>' : state.videoSearchError ? `<p class="video-search-empty error">${escapeHtml(state.videoSearchError)}</p>` : state.videoSearchResults.length ? state.videoSearchResults.map((result) => `<button class="video-search-result ${state.selectedFrameResult?.id === result.id ? 'selected' : ''}" data-video-frame-id="${escapeHtml(result.id)}" type="button"><strong>${escapeHtml(result.videoName || result.videoAssetId)}</strong><span>${formatTime(result.time)} · ${escapeHtml(result.annotation || result.searchText || '')}</span></button>`).join('') : '<p class="video-search-empty">No annotated video frames matched this search.</p>'}
  </div>
` : '';

const searchVideoFrames = async (query) => {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return [];
  state.videoSearchQuery = normalizedQuery;
  state.videoSearchLoading = true;
  state.videoSearchError = '';
  try {
    const results = await videoIndexer.search(normalizedQuery, {limit: 10});
    state.videoSearchResults = results;
    state.selectedFrameResult = null;
    return results;
  } catch (error) {
    state.videoSearchError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    state.videoSearchLoading = false;
  }
};

const submitVideoSearch = async (event) => {
  event.preventDefault();
  const query = String(new FormData(event.currentTarget).get('query') || '').trim();
  if (!query) return;
  state.videoSearchQuery = query;
  state.activeTab = 'media';
  state.mediaPanelOpen = true;
  state.videoSearchLoading = true;
  renderApp();
  try {
    await searchVideoFrames(query);
    renderApp();
  } catch (error) {
    showToast(`Video search failed: ${error instanceof Error ? error.message : String(error)}`);
    renderApp();
  }
};

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

const renderStyleVisual = (style) => {
  const version = styleVersion(style);
  const asset = version?.referenceAssetIds.map(mediaById).find(Boolean);
  if (asset) return renderMediaVisual(asset);
  return `<div class="character-placeholder">${icons.magic}<span>${style.status === 'failed' ? 'failed' : 'draft'}</span></div>`;
};

const renderStylesPanel = () => `
  <div class="panel-heading"><div><span class="eyebrow">REFERENCE LIBRARY</span><h2>Styles</h2></div></div>
  <div class="character-grid">
    <button class="character-card character-add-card" data-action="create-style" type="button"><span>${icons.plus}</span><strong>New style</strong></button>
    ${styleLibrary.load().map((style) => `<button class="character-card" data-style-id="${style.id}" type="button"><div class="character-sheet">${renderStyleVisual(style)}</div><div class="character-card-copy"><strong>${escapeHtml(style.name)}</strong><span>${style.lockedVersionId ? 'Locked' : style.status} · ${style.versions.length} ${style.versions.length === 1 ? 'version' : 'versions'}</span></div>${style.lockedVersionId ? '<span class="character-lock">LOCKED</span>' : ''}</button>`).join('')}
  </div>
  ${state.styles.length ? '' : '<div class="panel-empty"><span>Lock reusable visual references for future generations.</span></div>'}
  <div class="panel-footnote"><span class="fal-dot"></span><span>Auto-attached to new generations</span><span class="status-pill">local</span></div>
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
        <div class="modal-head"><div><span class="eyebrow">CHARACTER DETAIL</span><h2 id="characterModalTitle">${escapeHtml(character.name)}</h2></div><div class="modal-head-actions"><button class="danger-button character-delete-button" data-action="delete-character" type="button">${icons.close} Delete</button><button class="small-icon-button" data-action="close-character-modal" aria-label="Close" type="button">${icons.close}</button></div></div>
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

const renderStyleModal = () => {
  const style = styleById(state.selectedStyleId);
  if (!style) return '';
  const activeVersion = styleVersion(style);
  const imageAssets = state.media.filter((asset) => asset.kind === 'image');
  return `
    <div class="modal-backdrop" data-action="close-style-modal">
      <section class="character-modal" role="dialog" aria-modal="true" aria-labelledby="styleModalTitle">
        <div class="modal-head"><div><span class="eyebrow">STYLE DETAIL</span><h2 id="styleModalTitle">${escapeHtml(style.name)}</h2></div><button class="small-icon-button" data-action="close-style-modal" aria-label="Close" type="button">${icons.close}</button></div>
        <div class="character-detail-grid">
          <div class="character-detail-sheet">${activeVersion ? renderStyleVisual(style) : `<div class="character-placeholder">${icons.magic}<span>Add reference images</span></div>`}${style.lockedVersionId ? '<span class="character-lock detail-lock">LOCKED VERSION</span>' : ''}</div>
          <div class="character-detail-copy">
            <form class="style-name-form" data-style-name-form>
              <label for="styleName">Style name</label>
              <div><input id="styleName" name="name" value="${escapeHtml(style.name)}" required /><button class="button ghost" type="submit">Rename</button></div>
            </form>
            <div class="character-status-row"><span>Status</span><strong>${escapeHtml(style.status)}</strong><span>Active version</span><strong>${activeVersion ? escapeHtml(activeVersion.id) : 'None'}</strong></div>
            <div class="character-version-actions">
              <label for="styleVersionAssets">Create a version from imported images</label>
              <div><select id="styleVersionAssets" multiple size="${Math.min(4, Math.max(2, imageAssets.length))}" ${imageAssets.length ? '' : 'disabled'}>${imageAssets.map((asset) => `<option value="${asset.id}">${escapeHtml(asset.name)}</option>`).join('')}</select><button class="button ghost" data-action="record-style-version" type="button" ${imageAssets.length ? '' : 'disabled'}>Add version</button></div>
              ${imageAssets.length ? '<small>Choose one or more images, then add an immutable reference version.</small>' : '<small>Import an image in Media first.</small>'}
            </div>
            <div class="character-lock-actions">${activeVersion ? style.lockedVersionId ? '<button class="button ghost" data-action="unlock-style" type="button">Unlock style</button>' : '<button class="button primary" data-action="lock-style" type="button">Lock style</button>' : '<span>Add a reference version before locking this style.</span>'}</div>
          </div>
        </div>
        <div class="character-version-list"><div class="version-list-head"><strong>Immutable versions</strong><span>${style.versions.length}</span></div>${style.versions.length ? style.versions.map((version, index) => { const asset = version.referenceAssetIds.map(mediaById).find(Boolean); const isActive = version.id === activeVersion?.id; return `<button class="character-version-row ${isActive ? 'active' : ''}" data-action="activate-style-version" data-version-id="${version.id}" type="button" ${style.lockedVersionId ? 'disabled' : ''}><span class="version-number">V${index + 1}</span><div class="version-thumb">${asset ? renderMediaVisual(asset) : icons.image}</div><div><strong>${escapeHtml(asset?.name || 'Missing reference asset')}</strong><span>${version.referenceAssetIds.length} reference${version.referenceAssetIds.length === 1 ? '' : 's'} · ${new Date(version.createdAt).toLocaleString()}</span></div><span>${version.id === style.lockedVersionId ? 'Locked' : isActive ? 'Active' : 'Select'}</span></button>`; }).join('') : '<div class="version-empty">Versions are append-only. Existing references are never overwritten.</div>'}</div>
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
            <div><strong>${job.status === 'idle' ? 'Ready to compose' : job.status === 'failed' ? 'Generation failed' : job.status === 'ready' ? 'Character sheet ready' : job.status === 'retrying' ? 'Retrying character sheet' : 'Generating character sheet'}</strong><span>${job.status === 'idle' ? useFakeCharacterAdapter ? 'The local adapter creates a deterministic sheet without network calls.' : 'Nano Banana 2 will run through the credential-safe local server.' : job.status === 'failed' ? escapeHtml(job.error || 'Unknown generation error') : `${escapeHtml(job.providerStatus || 'queued')} · attempt ${job.attempt}`}</span></div>
          </div>
          <div class="composer-foot"><small>${useFakeCharacterAdapter ? 'Deterministic test path: include <code>[fail]</code> in the prompt, then remove it before retrying.' : 'The browser sends no model ID or FAL credential. Queue polling and result extraction stay server-side.'}</small>${action}</div>
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

const renderScriptPanel = () => {
  const script = state.agentWorkspace.script;
  return `
    <div class="panel-heading"><div><span class="eyebrow">SCRIPT VIEW</span><h2>Script</h2></div></div>
    <form class="script-title-form" data-script-title-form><input name="title" value="${escapeHtml(script.title)}" aria-label="Script title" /><button class="button ghost" type="submit">Save</button></form>
    <div class="script-beat-list">
      ${script.beats.length ? script.beats.map((beat, index) => `<form class="script-beat" data-script-beat-form data-beat-id="${escapeHtml(beat.id)}"><div class="script-beat-head"><span>${String(index + 1).padStart(2, '0')}</span><select name="sceneId" aria-label="Scene for beat"><option value="">No scene link</option>${project.scenes.map((scene) => `<option value="${escapeHtml(scene.id)}" ${scene.id === beat.sceneId ? 'selected' : ''}>${escapeHtml(scene.name)}</option>`).join('')}</select></div><textarea name="text" rows="3" aria-label="Script beat">${escapeHtml(beat.text)}</textarea><div class="script-beat-foot"><input name="clipIds" value="${escapeHtml(beat.clipIds.join(', '))}" placeholder="Clip IDs (optional)" /><button class="button ghost" type="submit">Save beat</button></div></form>`).join('') : '<div class="panel-empty"><span>Add beats, then link them to scenes and clips.</span></div>'}
    </div>
    <form class="script-add-form" data-script-add-form><textarea name="text" rows="3" placeholder="Write the next beat…" required></textarea><button class="button primary" type="submit">Add script beat</button></form>
  `;
};

const renderAgentPane = () => {
  const workspace = state.agentWorkspace;
  const entries = projectContext.getIndex().entries;
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const renderFrameResults = (frameIds) => (frameIds || []).map((id) => {
    const result = state.videoSearchResults.find((candidate) => candidate.id === id) || videoIndexer.getCachedFrame(id);
    return result
      ? `<button type="button" class="agent-result frame-result" data-video-frame-id="${escapeHtml(id)}"><strong>${escapeHtml(result.videoName || result.videoAssetId)}</strong><small>${formatTime(result.time)} · ${escapeHtml(result.annotation || '')}</small></button>`
      : `<span class="agent-result-missing">Frame ${escapeHtml(id)} is indexed in the local video catalog.</span>`;
  }).join('');
  return `<aside class="agent-pane ${state.agentPaneOpen ? '' : 'is-hidden'}" aria-label="Agent workspace"><div class="agent-pane-head"><div><span class="eyebrow">PROJECT AGENT</span><h2>Agent</h2></div><button class="small-icon-button" data-action="toggle-agent-pane" aria-label="Close agent" type="button">${icons.close}</button></div><div class="agent-messages">${workspace.messages.length ? workspace.messages.map((message) => `<article class="agent-message ${message.role}"><span>${escapeHtml(message.role)}</span><p>${escapeHtml(message.text)}</p>${message.resultIds.length || message.frameIds?.length ? `<div class="agent-results">${message.resultIds.map((id) => { const entry = entryById.get(id); return entry ? `<button type="button" class="agent-result" data-agent-result-id="${escapeHtml(id)}"><strong>${escapeHtml(entry.description || entry.text)}</strong><small>${escapeHtml(entry.type)}${entry.start !== undefined ? ` · ${formatTime(entry.start)}` : ''}</small></button>` : ''; }).join('')}${renderFrameResults(message.frameIds)}</div>` : ''}</article>`).join('') : '<div class="agent-empty"><span>${icons.magic}</span><p>Ask about shots, characters, scenes, or provenance.</p><small>Search is grounded in this project’s accepted timeline and local video-frame annotations.</small></div>'}</div><form class="agent-form" data-agent-form><textarea name="query" rows="3" placeholder="Find the shot where the fox jumps…" required></textarea><button class="button primary" type="submit">Search project</button></form></aside>`;
};

const renderInspectorCharacters = (clip) => {
  const attached = timelineCharacterAttachments.attachedVersions(clip.id);
  const available = timelineCharacterAttachments.lockedVersions(clip.id);
  return `
    <div class="property-group inspector-characters">
      <label>Characters</label>
      ${attached.length ? `<div class="character-chips">${attached.map((entry) => `<span class="character-chip ${entry.missing ? 'missing' : ''}"><span>${entry.missing ? 'Missing version' : `${escapeHtml(entry.characterName)} · V${entry.versionNumber}`}</span><small>${entry.missing ? escapeHtml(entry.versionId) : entry.isLocked ? 'Locked reference' : 'Historical reference'}</small><button data-action="remove-clip-character" data-version-id="${escapeHtml(entry.versionId)}" aria-label="Remove ${escapeHtml(entry.characterName || entry.versionId)}" type="button">${icons.close}</button></span>`).join('')}</div>` : '<p class="inspector-empty-copy">No character versions attached.</p>'}
      ${available.length ? `<div class="attach-character-row"><select id="clipCharacterVersion" aria-label="Locked character version">${available.map((entry) => `<option value="${escapeHtml(entry.versionId)}">${escapeHtml(entry.characterName)} · V${entry.versionNumber} (locked)</option>`).join('')}</select><button class="button ghost" data-action="attach-clip-character" type="button">Add character</button></div>` : '<p class="inspector-empty-copy">Lock a library character to make it available here.</p>'}
      ${attached.length ? '<small class="generation-reference-note">Future generation uses the exact version shown above.</small>' : ''}
    </div>
  `;
};

const renderRegenerationTools = (clip) => {
  if (!clip.provenance?.prompt || !clip.provenance?.modelId) return '';
  const isEditing = state.regenerationEditorClipId === clip.id;
  const jobs = clipRegeneration.listJobs(clip.id);
  const candidates = jobs.filter((job) => job.status === 'completed');
  const activeJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'failed');
  return `
    <div class="property-group regeneration-tools">
      <label>Prompt as source</label>
      <div class="regeneration-source">
        <div><span>Prompt</span><strong>${escapeHtml(clip.provenance.prompt)}</strong></div>
        <div><span>Model</span><strong>${escapeHtml(clip.provenance.modelId)}</strong></div>
        <div><span>Seed</span><strong>${escapeHtml(clip.provenance.seed ?? 'None')}</strong></div>
        <div><span>Parameters</span><strong>${escapeHtml(JSON.stringify(clip.provenance.params || {}))}</strong></div>
        <div><span>Parent assets</span><strong>${(clip.provenance.parentAssetIds || []).map(escapeHtml).join(', ') || 'None'}</strong></div>
        <div><span>Characters</span><strong>${(clip.provenance.characterVersionIds || []).map(escapeHtml).join(', ') || 'None'}</strong></div>
        <div><span>Styles</span><strong>${(clip.provenance.styleVersionIds || []).map(escapeHtml).join(', ') || 'Auto-locked styles'}</strong></div>
        <div><span>Quality</span><strong>${escapeHtml(clip.provenance.qualityTier || 'draft')}</strong></div>
      </div>
      <div class="regeneration-actions">
        <button class="button ghost" data-action="edit-clip-prompt" type="button">Edit prompt</button>
        <button class="button ghost" data-action="reroll-clip-seed" type="button">Reroll seed</button>
        <button class="button ghost" data-action="change-clip-model" type="button">Same prompt, different model</button>
        <button class="button primary" data-action="compare-clip-variants" type="button">Compare variants</button>
      </div>
      ${isEditing ? `
        <form class="regeneration-form" data-regeneration-form>
          <label for="regenerationPrompt">Prompt</label>
          <textarea id="regenerationPrompt" name="prompt" rows="4" required>${escapeHtml(clip.provenance.prompt)}</textarea>
          <label for="regenerationModel">Model ID</label>
          <input id="regenerationModel" name="modelId" value="${escapeHtml(clip.provenance.modelId)}" required />
          <div class="regeneration-form-row"><div><label for="regenerationSeed">Seed</label><input id="regenerationSeed" name="seed" value="${escapeHtml(clip.provenance.seed ?? '')}" /></div><div><label for="regenerationQuality">Quality tier</label><select id="regenerationQuality" name="qualityTier"><option value="draft" ${normalizeQualityTier(clip.provenance.qualityTier) === 'draft' ? 'selected' : ''}>Draft · 720p / 24fps</option><option value="final" ${normalizeQualityTier(clip.provenance.qualityTier) === 'final' ? 'selected' : ''}>Final · 1080p / 30fps</option></select></div></div>
          <label for="regenerationParams">Parameters (JSON)</label>
          <textarea id="regenerationParams" name="params" rows="2">${escapeHtml(JSON.stringify(clip.provenance.params || {}))}</textarea>
          <label for="regenerationQualitySettings">Quality settings (JSON)</label>
          <textarea id="regenerationQualitySettings" name="qualitySettings" rows="2">${escapeHtml(JSON.stringify(clip.provenance.qualitySettings || qualitySettingsFor(clip.provenance.qualityTier), null, 2))}</textarea>
          <div class="regeneration-form-actions"><button class="button ghost" data-action="cancel-regeneration" type="button">Cancel</button><button class="button primary" type="submit">Generate candidate</button></div>
        </form>
      ` : ''}
      ${activeJobs.length ? `<div class="regeneration-job-list">${activeJobs.map((job) => `<div class="regeneration-job ${job.status}"><span></span><div><strong>${job.status === 'failed' ? 'Generation failed' : `${job.status} candidate`}</strong><small>${job.status === 'failed' ? escapeHtml(job.error) : `${escapeHtml(job.input.modelId)} · seed ${escapeHtml(job.input.seed ?? 'auto')}`}</small></div></div>`).join('')}</div>` : ''}
      ${candidates.length ? `<div class="variant-panel"><div class="variant-panel-head"><strong>Generated variants</strong><span>${candidates.length} candidates · accepted clip unchanged</span></div><div class="variant-grid">${candidates.map((job) => `<article class="variant-card"><div class="variant-visual">${job.output?.asset?.url ? `<img src="${escapeHtml(job.output.asset.url)}" alt="Generated variant" />` : icons.image}</div><div><strong>${escapeHtml(job.input.modelId)}</strong><span>Seed ${escapeHtml(job.output?.seed ?? job.input.seed ?? 'auto')}</span><small>${escapeHtml(Object.keys(job.changedFields).join(', ') || 'same source settings')}</small></div><button class="button ${job.used ? 'ghost' : 'primary'}" data-action="use-regeneration-candidate" data-job-id="${escapeHtml(job.jobId)}" type="button" ${job.used ? 'disabled' : ''}>${job.used ? 'Proposed' : 'Use this version'}</button></article>`).join('')}</div></div>` : ''}
    </div>
  `;
};

const renderSelectedClipInspector = (selected, media) => `
  <div class="selected-preview ${media.kind}">${media.url ? media.kind === 'audio' ? `<div class="audio-orb">${icons.audio}</div>` : renderMediaVisual(media) : `<div class="offline-thumb">${kindIcon(media.kind)}<span>re-import source</span></div>`}<span class="selected-type">${media.kind.toUpperCase()}</span></div>
  <div class="inspector-title"><strong>${escapeHtml(media.name)}</strong><span>${selected.trackId === 'V1' ? 'Video track' : 'Audio track'} · ${formatTime(selected.duration)}</span></div>
  <div class="property-group"><label>Timing</label><div class="property-grid"><div><span>Start</span><strong>${formatTime(selected.start)}</strong></div><div><span>Duration</span><strong>${formatTime(selected.duration)}</strong></div></div></div>
  <div class="property-group"><label>Source</label><div class="source-line"><span class="source-icon">${kindIcon(media.kind)}</span><span>${escapeHtml(media.name)}</span></div></div>
  ${renderRegenerationTools(selected)}
  ${renderInspectorCharacters(selected)}
  <button class="danger-button" data-action="delete-clip" type="button">${icons.close} Remove from timeline</button>
`;

const renderProvenanceReview = (label, clip) => {
  const provenance = clip?.provenance || {};
  const characterVersions = Array.isArray(provenance.characterVersionIds) ? provenance.characterVersionIds : [];
  return `
    <div class="provenance-review">
      <strong>${label}</strong>
      <dl>
        <div><dt>Prompt</dt><dd>${escapeHtml(provenance.prompt || 'None')}</dd></div>
        <div><dt>Model</dt><dd>${escapeHtml(provenance.modelId || 'None')}</dd></div>
        <div><dt>Seed</dt><dd>${escapeHtml(provenance.seed ?? 'None')}</dd></div>
        <div><dt>Parameters</dt><dd>${escapeHtml(JSON.stringify(provenance.params || {}))}</dd></div>
        <div><dt>Parent asset</dt><dd>${escapeHtml(provenance.parentAssetId || 'None')}</dd></div>
        <div><dt>Character versions</dt><dd>${characterVersions.length ? characterVersions.map(escapeHtml).join(', ') : 'None'}</dd></div>
      </dl>
    </div>
  `;
};

const renderRebaseConflicts = (conflicts) => `
  <div class="rebase-conflicts" role="alert">
    <strong>Cannot rebase this proposal</strong>
    <ul>${conflicts.map((conflict) => `<li>${escapeHtml(conflict.message)}</li>`).join('')}</ul>
  </div>
`;

const renderGhostInspector = (ghost) => {
  const diff = diffById(ghost.diffId);
  if (!diff) return '';
  const beforeMedia = ghost.before ? mediaById(ghost.before.assetId) : null;
  const afterMedia = ghost.after ? mediaById(ghost.after.assetId) : null;
  const conflicts = state.rebaseConflicts[diff.id] || [];
  const actionLabel = ghost.type[0].toUpperCase() + ghost.type.slice(1);
  return `
    <div class="diff-review-card ${diff.status}">
      <div class="diff-review-heading"><span>${actionLabel}</span><strong>${escapeHtml(diff.summary)}</strong><small data-review-status>${diff.status === 'stale' ? 'Stale proposal' : 'Pending proposal'} · Base revision ${diff.baseRevision} · ${escapeHtml(diff.source)}</small></div>
      <div class="diff-review-timing">
        <div><span>Before</span><strong>${ghost.before ? `${formatTime(ghost.before.start)} · ${formatTime(ghost.before.duration)}` : 'New clip'}</strong><small>${escapeHtml(beforeMedia?.name || 'No accepted source')}</small></div>
        <div><span>After</span><strong>${ghost.after ? `${formatTime(ghost.after.start)} · ${formatTime(ghost.after.duration)}` : 'Removed'}</strong><small>${escapeHtml(afterMedia?.name || 'No proposed source')}</small></div>
      </div>
      ${renderProvenanceReview('Before provenance', ghost.before)}
      ${renderProvenanceReview('After provenance', ghost.after)}
      ${diff.status === 'stale' && !conflicts.length ? '<p class="stale-warning">The accepted timeline changed. Reconcile this proposal before accepting it.</p>' : ''}
      ${conflicts.length ? renderRebaseConflicts(conflicts) : ''}
      <div class="diff-review-actions">
        <button class="button ghost" data-action="preview-diff" data-diff-id="${diff.id}" type="button" ${state.previewDiffId === diff.id ? 'disabled' : ''}>Preview proposal</button>
        <button class="button ghost" data-action="exit-preview" data-diff-id="${diff.id}" type="button" ${state.previewDiffId !== diff.id ? 'disabled' : ''}>Exit preview</button>
        ${diff.status === 'stale' ? `<button class="button ghost" data-action="rebase-diff" data-diff-id="${diff.id}" type="button" ${conflicts.length ? 'disabled' : ''}>Rebase proposal</button>` : ''}
        <button class="button ghost" data-action="reject-diff" data-diff-id="${diff.id}" type="button">Reject</button>
        <button class="button primary" data-action="accept-diff" data-diff-id="${diff.id}" type="button" ${diff.status === 'stale' ? 'disabled' : ''}>Accept</button>
      </div>
    </div>
  `;
};

const renderContextPanel = () => {
  const ghost = selectedGhost();
  if (ghost) return `<div class="context-panel ghost-context-panel" role="region" aria-label="Ghost proposal review">${renderGhostInspector(ghost)}</div>`;
  return '';
};

const submitAgentQuery = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const query = String(new FormData(form).get('query') || '').trim();
  if (!query) return;
  agentWorkspace.addMessage({role: 'user', text: query});
  try {
    const results = projectContext.search(query, {limit: 5});
    const videoResults = await searchVideoFrames(query).catch(() => []);
    state.videoSearchResults = videoResults;
    state.selectedFrameResult = null;
    const resultCount = results.length + videoResults.length;
    agentWorkspace.addMessage({
      role: 'assistant',
      text: resultCount
        ? `Found ${resultCount} matching ${resultCount === 1 ? 'project record' : 'project records'}${videoResults.length ? `, including ${videoResults.length} video frame ${videoResults.length === 1 ? 'hit' : 'hits'}.` : '.'}`
        : 'No matching project records or annotated video frames yet.',
      resultIds: results.map((result) => result.id),
      frameIds: videoResults.map((result) => result.id),
    });
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const saveScriptTitle = (event) => {
  event.preventDefault();
  const title = String(new FormData(event.currentTarget).get('title') || '').trim();
  if (!title) return;
  agentWorkspace.updateScript({title});
  renderApp();
};

const addScriptBeat = (event) => {
  event.preventDefault();
  const text = String(new FormData(event.currentTarget).get('text') || '').trim();
  if (!text) return;
  agentWorkspace.addBeat({text});
  renderApp();
};

const saveScriptBeat = (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  agentWorkspace.updateBeat(form.dataset.beatId, {
    text: String(data.get('text') || ''),
    sceneId: String(data.get('sceneId') || '') || null,
    clipIds: String(data.get('clipIds') || '').split(',').map((id) => id.trim()).filter(Boolean),
  });
  renderApp();
};

const selectAgentResult = (entryId) => {
  const entry = projectContext.getIndex().entries.find((candidate) => candidate.id === entryId);
  if (!entry) return;
  if (entry.clipId) {
    state.selectedClipId = entry.clipId;
    state.selectedGhostKey = null;
    state.previewDiffId = null;
    state.currentTime = entry.start || 0;
  }
  renderApp();
};

const selectVideoSearchResult = (frameId) => {
  const result = state.videoSearchResults.find((candidate) => candidate.id === frameId) || videoIndexer.getCachedFrame(frameId);
  if (!result) return;
  state.selectedFrameResult = result;
  state.selectedGhostKey = null;
  state.previewDiffId = null;
  const matchingClips = state.clips.filter((clip) => clip.assetId === result.videoAssetId);
  const clip = matchingClips.find((candidate) => {
    const sourceStart = candidate.sourceStart || 0;
    return result.time >= sourceStart && result.time <= sourceStart + candidate.duration;
  }) || matchingClips[0];
  state.selectedClipId = clip?.id || null;
  state.activeTab = 'media';
  state.currentTime = clip
    ? clip.start + Math.max(0, Math.min(clip.duration, result.time - (clip.sourceStart || 0)))
    : result.time;
  if (!state.videoSearchResults.some((candidate) => candidate.id === result.id)) {
    state.videoSearchResults = [result, ...state.videoSearchResults].slice(0, 10);
  }
  renderApp();
};

const renderTimeline = () => {
  const duration = playbackDuration();
  const timelineWidth = Math.max(900, (duration + 3) * scale());
  const ticks = Array.from({length: Math.ceil(duration) + 2}, (_, index) => index);
  const ghosts = buildGhostItems(state.pendingDiffs);
  const pendingCount = state.pendingDiffs.length;
  const reviewQueue = reviewItems();
  const selectedReviewIndex = reviewQueue.findIndex((item) => item.diffId === selectedGhost()?.diffId);
  const reviewPosition = selectedReviewIndex >= 0 ? selectedReviewIndex + 1 : 1;
  const contentHeight = 29 + state.tracks.length * 74;
  const reviewControls = pendingCount ? `
    <span class="review-position" aria-live="polite" data-review-position>${reviewPosition} of ${pendingCount}</span>
    <button class="toolbar-button review-nav" data-action="previous-diff" type="button" aria-label="Previous proposal" ${reviewPosition <= 1 ? 'disabled' : ''}>‹</button>
    <button class="toolbar-button review-nav" data-action="next-diff" type="button" aria-label="Next proposal" ${reviewPosition >= pendingCount ? 'disabled' : ''}>›</button>` : '';
  const trackMenu = state.trackMenuOpen ? `<div class="track-menu" role="menu"><button type="button" role="menuitem" data-action="add-track-kind" data-track-kind="video"><span class="track-color video"></span>Video</button><button type="button" role="menuitem" data-action="add-track-kind" data-track-kind="audio"><span class="track-color audio"></span>Audio</button></div>` : '';
  return `
    <div class="timeline-toolbar"><div class="timeline-title"><span class="eyebrow">EDIT</span><div><h2>Timeline</h2><span class="sequence-chip">${escapeHtml(activeScene()?.name || 'Scene 01')}</span>${pendingCount ? `<button class="diff-badge" data-action="select-first-diff" type="button" aria-label="Select pending proposal ${reviewPosition} of ${pendingCount}"><strong>${pendingCount}</strong> pending · ${escapeHtml(state.pendingDiffs[0].summary)}</button>${reviewControls}` : ''}</div></div><div class="timeline-actions">${pendingCount > 1 ? '<button class="toolbar-button reject-all" data-action="reject-all-diffs" type="button">Reject all</button><button class="toolbar-button accept-all" data-action="accept-all-diffs" type="button">Accept all</button><span class="tool-divider"></span>' : ''}<button class="toolbar-button" data-action="split" type="button">${icons.scissors} Split</button><div class="track-menu-wrap"><button class="toolbar-button" data-action="add-track" type="button" aria-expanded="${state.trackMenuOpen}">${icons.plus} Track</button>${trackMenu}</div><span class="tool-divider"></span><button class="toolbar-button" data-action="zoom-out" type="button" aria-label="Zoom out">−</button><span class="zoom-value">${Math.round(state.zoom * 100)}%</span><button class="toolbar-button" data-action="zoom-in" type="button" aria-label="Zoom in">+</button></div></div>
    <div class="timeline-body">
      <div class="track-labels"><div class="ruler-spacer"></div>${state.tracks.map((track) => `<div class="track-label ${track.kind}-label"><span class="track-color ${track.kind}"></span><div><strong>${escapeHtml(track.name)}</strong><span>${escapeHtml(track.id)}</span></div></div>`).join('')}</div>
      <div class="timeline-scroll" id="timelineScroll"><div class="timeline-content" id="timelineContent" style="height:${contentHeight}px;width:${timelineWidth}px">
        <div class="ruler" id="timelineRuler">${ticks.map((tick) => `<div class="tick ${tick % 5 === 0 ? 'major' : ''}" style="left:${tick * scale()}px"><span>${formatTime(tick).slice(0, 5)}</span></div>`).join('')}</div>
        ${state.tracks.map((track) => {
          const clips = state.clips.filter((clip) => clip.trackId === track.id);
          const trackGhosts = ghosts.filter((ghost) => ghost.clip?.trackId === track.id);
          const content = `${clips.map(renderClip).join('')}${trackGhosts.map(renderGhostClip).join('')}`;
          return `<div class="track-lane ${track.kind}-lane" data-track-id="${escapeHtml(track.id)}">${content || `<div class="lane-placeholder">Drop ${track.kind} here</div>`}</div>`;
        }).join('')}
        <div class="timeline-drag-guide" id="timelineDragGuide" hidden></div>
        <div class="playhead" id="playhead" style="left:${state.currentTime * scale()}px"><span></span></div>
      </div></div>
    </div>
  `;
};

const renderClip = (clip) => {
  const media = mediaById(clip.assetId);
  if (!media) return '';
  const width = Math.max(clip.duration * scale(), 66);
  const frame = state.selectedFrameResult;
  const sourceStart = clip.sourceStart || 0;
  const frameSelected = frame?.videoAssetId === clip.assetId && frame.time >= sourceStart && frame.time <= sourceStart + clip.duration;
  return `<div class="timeline-clip ${media.kind} ${clip.id === state.selectedClipId ? 'selected' : ''} ${frameSelected ? 'frame-selected' : ''}" draggable="true" data-clip-id="${clip.id}" style="left:${clip.start * scale()}px;width:${width}px">${renderClipContents(media, clip.duration)}</div>`;
};

const renderClipContents = (media, duration) => `<div class="clip-thumb">${media.url ? media.kind === 'audio' ? `<span>${icons.audio}</span>` : renderMediaVisual(media) : `<span>${kindIcon(media.kind)}</span>`}</div><div class="clip-copy"><strong>${escapeHtml(media.name)}</strong><span>${formatTime(duration)}</span></div><div class="clip-handle left"></div><div class="clip-handle right"></div>`;

const renderGhostClip = (ghost) => {
  const clip = ghost.clip;
  if (!clip) return '';
  const media = mediaById(clip.assetId);
  const width = Math.max(clip.duration * scale(), 66);
  const statusLabel = ghost.status === 'stale' ? 'Stale' : 'Pending';
  const roleLabel = ghost.role === 'origin' ? 'original position' : ghost.role === 'destination' ? 'destination' : ghost.role === 'removal' ? 'removal' : 'proposal';
  const label = `${statusLabel} ${ghost.type} ${roleLabel}: ${ghost.summary}`;
  const draggable = ghost.role !== 'origin' && ghost.type !== 'remove';
  return `<button class="timeline-ghost ghost-${ghost.type} ghost-${ghost.role} ${ghost.status} ${ghost.key === state.selectedGhostKey ? 'selected' : ''}" ${draggable ? 'draggable="true"' : ''} data-ghost-key="${escapeHtml(ghost.key)}" data-ghost-status="${escapeHtml(ghost.status)}" data-ghost-role="${escapeHtml(ghost.role)}" type="button" style="left:${clip.start * scale()}px;width:${width}px" aria-label="${escapeHtml(label)}" aria-pressed="${ghost.key === state.selectedGhostKey}"><span class="ghost-kind">${escapeHtml(ghost.type)}</span><strong>${escapeHtml(media?.name || 'Proposed clip')}</strong><small>${statusLabel} · ${formatTime(clip.duration)}</small></button>`;
};

const bindEvents = () => {
  const timelineBody = app.querySelector('.timeline-body');
  const timelineScroll = app.querySelector('#timelineScroll');
  if (timelineBody) {
    timelineBody.scrollTop = state.timelineScrollTop;
    state.timelineScrollTop = timelineBody.scrollTop;
    timelineBody.addEventListener('scroll', () => { state.timelineScrollTop = timelineBody.scrollTop; }, {passive: true});
  }
  if (timelineScroll) {
    timelineScroll.scrollLeft = state.timelineScrollLeft;
    state.timelineScrollLeft = timelineScroll.scrollLeft;
    timelineScroll.addEventListener('scroll', () => { state.timelineScrollLeft = timelineScroll.scrollLeft; }, {passive: true});
  }
  app.querySelectorAll('[data-action="open-file"]').forEach((button) => button.addEventListener('click', () => fileInput.click()));
  app.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => { state.activeTab = button.dataset.tab; renderApp(); }));
  app.querySelector('[data-action="toggle-media-panel"]')?.addEventListener('click', () => { state.mediaPanelOpen = !state.mediaPanelOpen; renderApp(); });
  app.querySelectorAll('[data-action="toggle-agent-pane"]').forEach((button) => button.addEventListener('click', () => { state.agentPaneOpen = !state.agentPaneOpen; renderApp(); }));
  app.querySelector('[data-agent-form]')?.addEventListener('submit', submitAgentQuery);
  app.querySelector('[data-video-search-form]')?.addEventListener('submit', submitVideoSearch);
  app.querySelector('[data-script-title-form]')?.addEventListener('submit', saveScriptTitle);
  app.querySelector('[data-script-add-form]')?.addEventListener('submit', addScriptBeat);
  app.querySelectorAll('[data-script-beat-form]').forEach((form) => form.addEventListener('submit', saveScriptBeat));
  app.querySelectorAll('[data-agent-result-id]').forEach((button) => button.addEventListener('click', () => selectAgentResult(button.dataset.agentResultId)));
  app.querySelectorAll('[data-video-frame-id]').forEach((button) => button.addEventListener('click', () => selectVideoSearchResult(button.dataset.videoFrameId)));
  app.querySelector('[data-action="clear-video-search"]')?.addEventListener('click', () => { state.videoSearchQuery = ''; state.videoSearchResults = []; state.selectedFrameResult = null; state.videoSearchError = ''; renderApp(); });
  app.querySelector('[data-action="create-character"]')?.addEventListener('click', createCharacter);
  app.querySelectorAll('[data-character-id]').forEach((button) => button.addEventListener('click', () => openCharacter(button.dataset.characterId)));
  app.querySelector('[data-action="create-style"]')?.addEventListener('click', createStyle);
  app.querySelectorAll('[data-style-id]').forEach((button) => button.addEventListener('click', () => openStyle(button.dataset.styleId)));
  app.querySelectorAll('[data-action="close-character-modal"]').forEach((element) => element.addEventListener('click', (event) => { if (event.currentTarget === event.target || event.currentTarget.tagName === 'BUTTON') closeCharacterModal(); }));
  app.querySelectorAll('[data-action="close-style-modal"]').forEach((element) => element.addEventListener('click', (event) => { if (event.currentTarget === event.target || event.currentTarget.tagName === 'BUTTON') closeStyleModal(); }));
  app.querySelector('[data-character-name-form]')?.addEventListener('submit', renameCharacter);
  app.querySelector('[data-style-name-form]')?.addEventListener('submit', renameStyle);
  app.querySelector('[data-character-composer-form]')?.addEventListener('submit', submitCharacterComposer);
  app.querySelector('[data-action="retry-character-generation"]')?.addEventListener('click', retryCharacterComposer);
  app.querySelector('[data-action="record-character-version"]')?.addEventListener('click', recordCharacterVersion);
  app.querySelector('[data-action="lock-character"]')?.addEventListener('click', lockCharacter);
  app.querySelector('[data-action="unlock-character"]')?.addEventListener('click', unlockCharacter);
  app.querySelector('[data-action="delete-character"]')?.addEventListener('click', deleteCharacter);
  app.querySelectorAll('[data-action="activate-character-version"]').forEach((button) => button.addEventListener('click', () => activateCharacterVersion(button.dataset.versionId)));
  app.querySelector('[data-action="record-style-version"]')?.addEventListener('click', recordStyleVersion);
  app.querySelector('[data-action="lock-style"]')?.addEventListener('click', lockStyle);
  app.querySelector('[data-action="unlock-style"]')?.addEventListener('click', unlockStyle);
  app.querySelectorAll('[data-action="activate-style-version"]').forEach((button) => button.addEventListener('click', () => activateStyleVersion(button.dataset.versionId)));
  app.querySelector('[data-dropzone="media"]')?.addEventListener('dragover', (event) => { event.preventDefault(); event.currentTarget.classList.add('dragging'); });
  app.querySelector('[data-dropzone="media"]')?.addEventListener('dragleave', (event) => event.currentTarget.classList.remove('dragging'));
  app.querySelector('[data-dropzone="media"]')?.addEventListener('drop', (event) => { event.preventDefault(); event.currentTarget.classList.remove('dragging'); addFiles([...event.dataTransfer.files]); });
  app.querySelectorAll('[data-media-id]').forEach((element) => {
    if (element.draggable) {
      element.addEventListener('dragstart', (event) => {
        state.dragPayload = {type: 'media', id: element.dataset.mediaId, native: true, grabOffset: 0};
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('text/media-id', element.dataset.mediaId);
      });
      element.addEventListener('dragend', clearNativeDrag);
      element.addEventListener('pointerdown', (event) => startPointerDrag(event, 'media', element.dataset.mediaId));
    }
  });
  app.querySelectorAll('[data-action="remove-media"]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); removeMedia(button.dataset.mediaId); }));
  app.querySelectorAll('[data-clip-id]').forEach((clipElement) => {
    clipElement.addEventListener('click', () => { state.selectedClipId = clipElement.dataset.clipId; state.selectedGhostKey = null; state.previewDiffId = null; renderApp(); });
    clipElement.addEventListener('dragstart', (event) => {
      const clip = clipById(clipElement.dataset.clipId);
      state.dragPayload = {type: 'clip', id: clipElement.dataset.clipId, native: true, grabOffset: rawTimeFromClientX(event.clientX) - (clip?.start || 0)};
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/clip-id', clipElement.dataset.clipId);
    });
    clipElement.addEventListener('dragend', clearNativeDrag);
    clipElement.addEventListener('pointerdown', (event) => startPointerDrag(event, 'clip', clipElement.dataset.clipId));
    clipElement.querySelectorAll('.clip-handle').forEach((handle) => {
      const edge = handle.classList.contains('left') ? 'left' : 'right';
      handle.addEventListener('pointerdown', (event) => startTrimDrag(event, clipElement.dataset.clipId, edge));
    });
  });
  app.querySelectorAll('[data-ghost-key]').forEach((ghostElement) => {
    ghostElement.addEventListener('click', (event) => {
      event.stopPropagation();
      state.selectedGhostKey = ghostElement.dataset.ghostKey;
      state.selectedClipId = null;
      renderApp();
    });
    if (ghostElement.draggable) {
      ghostElement.addEventListener('dragstart', (event) => {
        const clip = findGhostItem(state.pendingDiffs, ghostElement.dataset.ghostKey)?.clip;
        state.dragPayload = {type: 'ghost', id: ghostElement.dataset.ghostKey, native: true, grabOffset: rawTimeFromClientX(event.clientX) - (clip?.start || 0)};
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/ghost-key', ghostElement.dataset.ghostKey);
      });
      ghostElement.addEventListener('dragend', clearNativeDrag);
      ghostElement.addEventListener('pointerdown', (event) => startPointerDrag(event, 'ghost', ghostElement.dataset.ghostKey));
    }
  });
  app.querySelectorAll('.track-lane').forEach((lane) => {
    lane.addEventListener('dragover', (event) => { event.preventDefault(); lane.classList.add('dragging'); });
    lane.addEventListener('dragleave', () => lane.classList.remove('dragging'));
    lane.addEventListener('drop', (event) => { event.preventDefault(); lane.classList.remove('dragging'); dropOnTimeline(event, lane.dataset.trackId); });
    lane.addEventListener('click', (event) => { if (event.target.closest('.timeline-clip, .timeline-ghost')) return; seekFromTimeline(event); });
  });
  app.querySelector('#timelineRuler')?.addEventListener('click', seekFromTimeline);
  app.querySelector('[data-action="split"]')?.addEventListener('click', splitClipAtPlayhead);
  app.querySelector('[data-action="add-track"]')?.addEventListener('click', () => {
    state.trackMenuOpen = !state.trackMenuOpen;
    renderApp();
  });
  app.querySelectorAll('[data-action="add-track-kind"]').forEach((button) => {
    button.addEventListener('click', () => addTrack(button.dataset.trackKind));
  });
  app.querySelector('[data-action="toggle-play"]')?.addEventListener('click', togglePlay);
  app.querySelector('[data-action="step-back"]')?.addEventListener('click', () => seekTo(state.currentTime - 1 / 30));
  app.querySelector('[data-action="step-forward"]')?.addEventListener('click', () => seekTo(state.currentTime + 1 / 30));
  app.querySelector('[data-action="zoom-in"]')?.addEventListener('click', () => { state.zoom = Math.min(2, state.zoom + 0.1); renderApp(); });
  app.querySelector('[data-action="zoom-out"]')?.addEventListener('click', () => { state.zoom = Math.max(0.6, state.zoom - 0.1); renderApp(); });
  app.querySelector('[data-action="delete-clip"]')?.addEventListener('click', deleteSelectedClip);
  app.querySelector('[data-action="select-first-diff"]')?.addEventListener('click', selectFirstDiff);
  app.querySelector('[data-action="accept-diff"]')?.addEventListener('click', (event) => acceptDiff(event.currentTarget.dataset.diffId));
  app.querySelector('[data-action="reject-diff"]')?.addEventListener('click', (event) => rejectDiff(event.currentTarget.dataset.diffId));
  app.querySelector('[data-action="preview-diff"]')?.addEventListener('click', (event) => previewDiff(event.currentTarget.dataset.diffId));
  app.querySelector('[data-action="exit-preview"]')?.addEventListener('click', exitProposalPreview);
  app.querySelector('[data-action="rebase-diff"]')?.addEventListener('click', (event) => rebaseDiff(event.currentTarget.dataset.diffId));
  app.querySelector('[data-action="previous-diff"]')?.addEventListener('click', previousDiff);
  app.querySelector('[data-action="next-diff"]')?.addEventListener('click', nextDiff);
  app.querySelector('[data-action="accept-all-diffs"]')?.addEventListener('click', acceptAllDiffs);
  app.querySelector('[data-action="reject-all-diffs"]')?.addEventListener('click', rejectAllDiffs);
  app.querySelector('[data-action="edit-clip-prompt"]')?.addEventListener('click', () => openRegenerationEditor('prompt'));
  app.querySelector('[data-action="change-clip-model"]')?.addEventListener('click', () => openRegenerationEditor('model'));
  app.querySelector('[data-action="reroll-clip-seed"]')?.addEventListener('click', rerollSelectedClip);
  app.querySelector('[data-action="compare-clip-variants"]')?.addEventListener('click', compareSelectedClipVariants);
  app.querySelector('[data-action="cancel-regeneration"]')?.addEventListener('click', closeRegenerationEditor);
  app.querySelector('[data-regeneration-form]')?.addEventListener('submit', submitClipRegeneration);
  app.querySelectorAll('[data-action="use-regeneration-candidate"]').forEach((button) => button.addEventListener('click', () => useRegenerationCandidate(button.dataset.jobId)));
  app.querySelector('[data-action="attach-clip-character"]')?.addEventListener('click', attachCharacterToSelectedClip);
  app.querySelectorAll('[data-action="remove-clip-character"]').forEach((button) => button.addEventListener('click', () => removeCharacterFromSelectedClip(button.dataset.versionId)));
  app.querySelector('[data-action="render"]')?.addEventListener('click', () => showToast('Render queue is ready for a FAL model hookup.'));
  app.querySelector('[data-action="export"]')?.addEventListener('click', () => showToast('Export will be connected after the composition pipeline is defined.'));
  if (!bindEvents.escapeReviewHandlerBound) {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.previewDiffId) {
        event.preventDefault();
        event.stopPropagation();
        exitProposalPreview();
      }
    });
    bindEvents.escapeReviewHandlerBound = true;
  }
  checkFalStatus();
};
bindEvents.escapeReviewHandlerBound = false;

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

const createStyle = () => {
  state.selectedStyleId = styleLibrary.createDraft('Untitled style').affectedId;
  state.isStyleModalOpen = true;
  renderApp();
};

const openStyle = (styleId) => {
  state.selectedStyleId = styleId;
  state.isStyleModalOpen = true;
  renderApp();
};

const closeStyleModal = () => {
  state.isStyleModalOpen = false;
  renderApp();
};

const renameStyle = (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    styleLibrary.rename(state.selectedStyleId, String(form.get('name') || ''));
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const recordStyleVersion = () => {
  const assetIds = [...(app.querySelector('#styleVersionAssets')?.selectedOptions || [])].map((option) => option.value);
  if (!assetIds.length) return;
  styleLibrary.recordVersion(state.selectedStyleId, {
    referenceAssetIds: assetIds,
    prompt: '',
    modelId: 'local/manual',
    seed: null,
    params: {},
    parentAssetIds: assetIds,
  });
  renderApp();
};

const activateStyleVersion = (versionId) => {
  styleLibrary.activateVersion(state.selectedStyleId, versionId);
  renderApp();
};

const lockStyle = () => {
  const style = styleById(state.selectedStyleId);
  if (style?.activeVersionId) styleLibrary.lockVersion(style.id, style.activeVersionId);
  renderApp();
};

const unlockStyle = () => {
  styleLibrary.unlockVersion(state.selectedStyleId);
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

const deleteCharacter = () => {
  const character = characterById(state.selectedCharacterId);
  if (!character) return;
  const attachedClipCount = state.clips.filter((clip) => (clip.provenance.characterVersionIds || [])
    .some((versionId) => character.versions.some((version) => version.id === versionId))).length;
  const attachmentNote = attachedClipCount ? ` This will detach it from ${attachedClipCount} timeline ${attachedClipCount === 1 ? 'clip' : 'clips'}.` : '';
  if (typeof globalThis.confirm === 'function' && !globalThis.confirm(`Delete character “${character.name}”?${attachmentNote}`)) return;
  try {
    clearTimeout(characterPollTimer);
    characterPollTimer = null;
    characterGenerationController = null;
    characterLibrary.remove(character.id);
    state.selectedCharacterId = null;
    state.isCharacterModalOpen = false;
    renderApp();
    showToast(`Deleted character “${character.name}”.`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
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

const openRegenerationEditor = (mode) => {
  if (!state.selectedClipId) return;
  state.regenerationEditorClipId = state.selectedClipId;
  state.regenerationEditorMode = mode;
  renderApp();
  const field = app.querySelector(mode === 'model' ? '#regenerationModel' : '#regenerationPrompt');
  field?.focus();
  field?.select();
};

const closeRegenerationEditor = () => {
  state.regenerationEditorClipId = null;
  renderApp();
};

const parseRegenerationForm = () => {
  const form = app.querySelector('[data-regeneration-form]');
  if (!form) throw new Error('The regeneration form is unavailable.');
  const data = new FormData(form);
  const seedText = String(data.get('seed') || '').trim();
  const numericSeed = Number(seedText);
  let params;
  try {
    params = JSON.parse(String(data.get('params') || '{}'));
  } catch {
    throw new Error('Parameters must be valid JSON.');
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Parameters must be a JSON object.');
  let qualitySettings;
  try {
    qualitySettings = JSON.parse(String(data.get('qualitySettings') || '{}'));
  } catch {
    throw new Error('Quality settings must be valid JSON.');
  }
  if (!qualitySettings || typeof qualitySettings !== 'object' || Array.isArray(qualitySettings)) throw new Error('Quality settings must be a JSON object.');
  return {
    prompt: String(data.get('prompt') || ''),
    modelId: String(data.get('modelId') || ''),
    seed: seedText === '' ? null : Number.isFinite(numericSeed) ? numericSeed : seedText,
    params,
    qualityTier: normalizeQualityTier(String(data.get('qualityTier') || 'draft')),
    qualitySettings,
  };
};

const submitClipRegeneration = async (event) => {
  event.preventDefault();
  const clip = clipById(state.selectedClipId);
  if (!clip) return;
  try {
    await clipRegeneration.regenerateClip({
      clipId: clip.id,
      ...parseRegenerationForm(),
      characterVersionIds: clip.provenance.characterVersionIds,
    });
    state.regenerationEditorClipId = null;
    renderApp();
    scheduleRegenerationPoll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const rerollSelectedClip = async () => {
  if (!state.selectedClipId) return;
  try {
    await clipRegeneration.rerollSeed(state.selectedClipId);
    renderApp();
    scheduleRegenerationPoll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const compareSelectedClipVariants = async () => {
  if (!state.selectedClipId) return;
  try {
    await clipRegeneration.compareVariants(state.selectedClipId, {count: 2});
    renderApp();
    scheduleRegenerationPoll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const scheduleRegenerationPoll = () => {
  clearTimeout(regenerationPollTimer);
  regenerationPollTimer = setTimeout(pollRegenerationJobs, 220);
};

const pollRegenerationJobs = async () => {
  const activeJobs = clipRegeneration.listJobs().filter((job) => job.status === 'queued' || job.status === 'running');
  await Promise.all(activeJobs.map((job) => clipRegeneration.poll(job.jobId)));
  renderApp();
  if (clipRegeneration.listJobs().some((job) => job.status === 'queued' || job.status === 'running')) {
    scheduleRegenerationPoll();
  }
};

const useRegenerationCandidate = (jobId) => {
  try {
    clipRegeneration.useCandidate(jobId);
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const selectFirstDiff = () => {
  selectReviewItem(selectFirstReviewItem(state.pendingDiffs));
  state.previewDiffId = null;
  renderApp();
};

const navigateDiff = (direction) => {
  const current = selectedGhost();
  const item = direction < 0
    ? selectPreviousReviewItem(state.pendingDiffs, current?.key)
    : selectNextReviewItem(state.pendingDiffs, current?.key);
  if (!item) return;
  selectReviewItem(item);
  state.previewDiffId = null;
  renderApp();
};

const previousDiff = () => navigateDiff(-1);
const nextDiff = () => navigateDiff(1);

const selectNextAvailableReviewItem = (diffId, previousItems) => {
  const previousIndex = previousItems.findIndex((item) => item.diffId === diffId);
  const remaining = reviewItems();
  return remaining[previousIndex] || remaining[previousIndex - 1] || null;
};

const acceptDiff = (diffId) => {
  const previousItems = reviewItems();
  try {
    timelineDiffs.accept(diffId);
    selectReviewItem(selectNextAvailableReviewItem(diffId, previousItems));
    state.previewDiffId = null;
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const rejectDiff = (diffId) => {
  const previousItems = reviewItems();
  try {
    timelineDiffs.reject(diffId);
    selectReviewItem(selectNextAvailableReviewItem(diffId, previousItems));
    if (state.previewDiffId === diffId) state.previewDiffId = null;
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const previewDiff = (diffId) => {
  const diff = diffById(diffId);
  if (!diff) return;
  const item = reviewItemForDiff(diffId);
  if (item) selectReviewItem(item);
  state.previewDiffId = diffId;
  const firstChangedClip = diff.operations.find((operation) => operation.after || operation.before);
  state.currentTime = firstChangedClip?.after?.start ?? firstChangedClip?.before?.start ?? state.currentTime;
  if (state.isPlaying) {
    state.playbackOrigin = state.currentTime;
    state.playbackStartedAt = performance.now();
  }
  renderApp();
};

const exitProposalPreview = () => {
  if (!state.previewDiffId) return;
  state.previewDiffId = null;
  state.currentTime = Math.min(state.currentTime, state.timelineDuration);
  if (state.isPlaying) {
    state.playbackOrigin = state.currentTime;
    state.playbackStartedAt = performance.now();
  }
  state.previewPlaybackSignature = null;
  renderApp();
};

const rebaseDiff = (diffId) => {
  try {
    const result = timelineDiffs.rebase(diffId);
    if (result.conflicts?.length) {
      state.rebaseConflicts = {...state.rebaseConflicts, [diffId]: result.conflicts};
      renderApp();
      return;
    }
    const nextConflicts = {...state.rebaseConflicts};
    delete nextConflicts[diffId];
    state.rebaseConflicts = nextConflicts;
    selectReviewItem(reviewItemForDiff(result.affectedId));
    state.previewDiffId = null;
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const acceptAllDiffs = () => {
  try {
    timelineDiffs.acceptAll();
    state.selectedGhostKey = null;
    state.previewDiffId = null;
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const rejectAllDiffs = () => {
  timelineDiffs.rejectAll();
  state.selectedGhostKey = null;
  state.previewDiffId = null;
  renderApp();
};

const splitClipAtPlayhead = () => {
  const clip = state.clips.find((candidate) => state.currentTime >= candidate.start && state.currentTime < candidate.start + candidate.duration);
  if (!clip) {
    showToast('Place the playhead over a clip to split it.');
    return;
  }
  const result = updateProject({type: 'clip/split', clipId: clip.id, time: state.currentTime});
  if (!result.changed) {
    showToast('Move the playhead away from the clip edge to split it.');
    return;
  }
  state.selectedClipId = result.affectedId;
  renderApp();
};

const addTrack = (kind) => {
  if (kind !== 'video' && kind !== 'audio') return;
  const result = updateProject({type: 'track/add', kind});
  state.trackMenuOpen = false;
  if (!result.changed) return;
  renderApp();
  showToast(`${kind[0].toUpperCase()}${kind.slice(1)} track added.`);
};

const dropOnTimeline = (event, trackId) => {
  const mediaId = event.dataTransfer.getData('text/media-id');
  const clipId = event.dataTransfer.getData('text/clip-id');
  const ghostKey = event.dataTransfer.getData('text/ghost-key');
  const payload = state.dragPayload;
  const start = payload?.native && payload.id === (clipId || ghostKey || mediaId) && payload.type !== 'media'
    ? Math.max(0, rawTimeFromClientX(event.clientX) - payload.grabOffset)
    : undefined;
  placeOnTimeline({mediaId, clipId, ghostKey, clientX: event.clientX, trackId, start});
  state.dragPayload = null;
};

const clearTimelineDragGuide = () => {
  const guide = app.querySelector('#timelineDragGuide');
  if (guide) guide.hidden = true;
};

const createTimelineDragPreview = (media) => {
  const preview = document.createElement('div');
  preview.className = `timeline-clip ${media.kind} timeline-drag-preview`;
  preview.innerHTML = renderClipContents(media, media.kind === 'image' ? 5 : Math.max(0.1, media.duration || 5));
  preview.style.width = `${Math.max((media.kind === 'image' ? 5 : Math.max(0.1, media.duration || 5)) * scale(), 66)}px`;
  return preview;
};

const updateTimelineDragPreview = (payload, clientX, clientY) => {
  const target = document.elementFromPoint(clientX, clientY);
  const lane = target?.closest('.track-lane');
  if (!lane) return false;

  const start = Math.max(0, rawTimeFromClientX(clientX) - payload.grabOffset);
  payload.currentStart = start;
  payload.currentTrackId = lane.dataset.trackId;

  if (payload.type === 'clip' || payload.type === 'ghost') {
    if (payload.element.parentElement !== lane) lane.append(payload.element);
    payload.element.classList.add('dragging');
    payload.element.style.left = `${start * scale()}px`;
  } else if (payload.type === 'media') {
    if (!payload.previewElement) payload.previewElement = createTimelineDragPreview(mediaById(payload.id));
    if (payload.previewElement && payload.previewElement.parentElement !== lane) lane.append(payload.previewElement);
    if (payload.previewElement) payload.previewElement.style.left = `${start * scale()}px`;
  }

  const guide = app.querySelector('#timelineDragGuide');
  if (guide) {
    guide.hidden = false;
    guide.style.left = `${start * scale()}px`;
  }
  return true;
};

const cleanupPointerDrag = (payload) => {
  payload?.element?.classList?.remove('dragging', 'trimming');
  payload?.previewElement?.remove();
  clearTimelineDragGuide();
  document.body.classList.remove('dragging-payload');
};

const clearNativeDrag = () => {
  if (state.dragPayload?.native) state.dragPayload = null;
  clearTimelineDragGuide();
};

const startTrimDrag = (event, clipId, edge) => {
  if (event.button !== 0) return;
  const clip = clipById(clipId);
  const element = event.currentTarget.closest('.timeline-clip');
  if (!clip || !element) return;
  event.preventDefault();
  event.stopPropagation();

  const payload = {
    type: 'trim',
    id: clipId,
    edge,
    startX: event.clientX,
    startY: event.clientY,
    originalStart: clip.start,
    originalDuration: clip.duration,
    originalEnd: clip.start + clip.duration,
    currentStart: clip.start,
    currentDuration: clip.duration,
    element,
    dragging: false,
  };
  state.dragPayload = payload;
  document.body.classList.add('dragging-payload');

  const onPointerMove = (moveEvent) => {
    if (state.dragPayload !== payload) return;
    const moved = Math.hypot(moveEvent.clientX - payload.startX, moveEvent.clientY - payload.startY) >= 4;
    if (!payload.dragging && !moved) return;
    payload.dragging = true;
    const pointerTime = rawTimeFromClientX(moveEvent.clientX);
    if (edge === 'left') {
      payload.currentStart = Math.min(Math.max(0, pointerTime), payload.originalEnd - 0.1);
      payload.currentDuration = Math.max(0.1, payload.originalEnd - payload.currentStart);
    } else {
      payload.currentStart = payload.originalStart;
      payload.currentDuration = Math.max(0.1, pointerTime - payload.originalStart);
    }
    element.classList.add('trimming');
    element.style.left = `${payload.currentStart * scale()}px`;
    element.style.width = `${Math.max(payload.currentDuration * scale(), 66)}px`;
    const durationLabel = element.querySelector('.clip-copy span');
    if (durationLabel) durationLabel.textContent = formatTime(payload.currentDuration);
    const guide = app.querySelector('#timelineDragGuide');
    if (guide) {
      guide.hidden = false;
      guide.style.left = `${(edge === 'left' ? payload.currentStart : payload.currentStart + payload.currentDuration) * scale()}px`;
    }
    moveEvent.preventDefault();
  };

  const finish = (upEvent, cancelled = false) => {
    if (state.dragPayload !== payload) return;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    const moved = payload.dragging;
    cleanupPointerDrag(payload);
    state.dragPayload = null;
    if (!moved) return;
    if (!cancelled) {
      updateProject({
        type: 'clip/trim',
        clipId,
        edge,
        start: payload.currentStart,
        duration: payload.currentDuration,
      });
    }
    renderApp();
  };

  const onPointerUp = (upEvent) => finish(upEvent);
  const onPointerCancel = (cancelEvent) => finish(cancelEvent, true);
  document.addEventListener('pointermove', onPointerMove, {passive: false});
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
};

const startPointerDrag = (event, type, id) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const source = type === 'clip'
    ? clipById(id)
    : type === 'ghost'
      ? findGhostItem(state.pendingDiffs, id)?.clip
      : mediaById(id);
  const sourceStart = Number.isFinite(source?.start) ? source.start : 0;
  const payload = {
    type,
    id,
    startX: event.clientX,
    startY: event.clientY,
    grabOffset: rawTimeFromClientX(event.clientX) - sourceStart,
    currentStart: sourceStart,
    currentTrackId: source?.trackId || null,
    element: event.currentTarget,
    previewElement: null,
    dragging: false,
  };
  state.dragPayload = payload;
  document.body.classList.add('dragging-payload');

  const onPointerMove = (moveEvent) => {
    if (!state.dragPayload) return;
    const moved = Math.hypot(moveEvent.clientX - payload.startX, moveEvent.clientY - payload.startY) >= 4;
    if (!payload.dragging && !moved) return;
    payload.dragging = true;
    updateTimelineDragPreview(payload, moveEvent.clientX, moveEvent.clientY);
    moveEvent.preventDefault();
  };

  const finish = (upEvent, cancelled = false) => {
    if (state.dragPayload !== payload) return;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    const target = cancelled ? null : document.elementFromPoint(upEvent.clientX, upEvent.clientY);
    const lane = target?.closest('.track-lane');
    const moved = payload.dragging;
    const canPlace = moved && lane && Number.isFinite(payload.currentStart);
    const finalStart = payload.currentStart;
    const finalTrackId = payload.currentTrackId;
    cleanupPointerDrag(payload);
    state.dragPayload = null;

    if (!moved) return;
    if (canPlace) {
      placeOnTimeline({
        mediaId: type === 'media' ? id : '',
        clipId: type === 'clip' ? id : '',
        ghostKey: type === 'ghost' ? id : '',
        clientX: upEvent.clientX,
        trackId: finalTrackId,
        start: finalStart,
      });
    } else {
      renderApp();
    }
  };

  const onPointerUp = (upEvent) => {
    finish(upEvent);
  };

  const onPointerCancel = (cancelEvent) => finish(cancelEvent, true);

  document.addEventListener('pointermove', onPointerMove, {passive: false});
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
};

const placeOnTimeline = ({mediaId, clipId, ghostKey, clientX, trackId, start: requestedStart}) => {
  const start = Number.isFinite(requestedStart) ? Math.max(0, requestedStart) : timeFromClientX(clientX);
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
  } else if (ghostKey) {
    const ghost = findGhostItem(state.pendingDiffs, ghostKey);
    const diff = ghost ? diffById(ghost.diffId) : null;
    if (!ghost || !diff || ghost.role === 'origin' || ghost.type === 'remove') return;
    try {
      const revised = reviseGhostProposal(diff, ghost.operationIndex, {start, trackId});
      const result = timelineDiffs.createProposal({...revised, baseRevision: project.timeline.revision});
      timelineDiffs.reject(diff.id);
      selectReviewItem(reviewItemForDiff(result.affectedId));
      state.previewDiffId = null;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
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
  return Math.max(0, Math.round(rawTimeFromClientX(clientX) * 10) / 10);
};

const rawTimeFromClientX = (clientX) => {
  const content = app.querySelector('#timelineContent');
  const scroll = app.querySelector('#timelineScroll');
  if (!content || !scroll) return 0;
  const rect = content.getBoundingClientRect();
  return Math.max(0, (clientX - rect.left) / scale());
};

const seekFromTimeline = (event) => seekTo(timeFromPointer(event));

const addFiles = async (files) => {
  const acceptedFiles = files.filter((file) => file.type.startsWith('video/') || file.type.startsWith('audio/') || file.type.startsWith('image/'));
  await Promise.all(acceptedFiles.map(async (file) => {
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
    try {
      await projectDatabase.putAsset(item.id, file);
    } catch {
      showToast('Media imported for this session, but could not be saved for refresh.');
    }
    if (kind === 'image') renderApp();
    else {
      const probe = document.createElement(kind === 'audio' ? 'audio' : 'video');
      probe.preload = 'metadata';
      probe.src = item.url;
      probe.onloadedmetadata = () => {
        const duration = Number.isFinite(probe.duration) ? probe.duration : 5;
        updateProject({type: 'asset/update', assetId: item.id, patch: {duration}});
        renderApp();
        if (kind === 'video') {
          void videoIndexer.run({asset: mediaById(item.id), video: probe, duration}).catch((error) => {
            updateProject({type: 'asset/update', assetId: item.id, patch: {metadata: {videoIndex: {status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString()}}}});
            showToast(`Video indexing failed: ${error instanceof Error ? error.message : String(error)}`);
            renderApp();
          });
        }
      };
      probe.onerror = () => { updateProject({type: 'asset/update', assetId: item.id, patch: {duration: 5}}); renderApp(); };
    }
  }));
  if (acceptedFiles.length) showToast(`${acceptedFiles.length} media ${acceptedFiles.length === 1 ? 'file' : 'files'} imported.`);
};

const removeMedia = (mediaId) => {
  const clips = state.clips.filter((clip) => clip.assetId === mediaId);
  clips.forEach((clip) => { if (clip.id === state.selectedClipId) state.selectedClipId = null; });
  const item = mediaById(mediaId);
  if (item?.url) URL.revokeObjectURL(item.url);
  updateProject({type: 'asset/remove', assetId: mediaId});
  void projectDatabase.removeAsset(mediaId).catch(() => {});
  renderApp();
};

const deleteSelectedClip = () => {
  const clipId = state.selectedClipId;
  if (!clipId || !clipById(clipId)) return false;
  const result = updateProject({type: 'clip/remove', clipId});
  if (!result.changed) return false;
  state.selectedClipId = null;
  if (state.regenerationEditorClipId === clipId) state.regenerationEditorClipId = null;
  renderApp();
  return true;
};

const attachCharacterToSelectedClip = () => {
  const versionId = app.querySelector('#clipCharacterVersion')?.value;
  if (!state.selectedClipId || !versionId) return;
  try {
    timelineCharacterAttachments.attach(state.selectedClipId, versionId);
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const removeCharacterFromSelectedClip = (versionId) => {
  if (!state.selectedClipId) return;
  timelineCharacterAttachments.remove(state.selectedClipId, versionId);
  renderApp();
};

const playbackClips = () => {
  const previewDiff = state.previewDiffId ? diffById(state.previewDiffId) : null;
  return previewDiff ? derivePreviewClips(state.clips, previewDiff) : state.clips;
};

const playbackDuration = () => {
  const clips = playbackClips();
  const clipEnd = clips.reduce((maximum, clip) => Math.max(maximum, clip.start + clip.duration), 0);
  return clipEnd > state.timelineDuration ? clipEnd + 2 : state.timelineDuration;
};

const playbackAt = (time) => resolveTimelinePlaybackAt({
  time,
  clips: playbackClips(),
  tracks: state.tracks,
  mediaAssets: state.media,
});

const playbackSignature = ({visual, audio}) => {
  const visualPart = visual?.media.url ? `${visual.clip.id}:${visual.media.id}` : '';
  const audioPart = audio
    .filter(({media}) => Boolean(media.url))
    .map(({clip, media}) => `${clip.id}:${media.id}`)
    .join(',');
  return `${visualPart}|${audioPart}`;
};

const sourceTimeAtPlayhead = (clip) => (clip.sourceStart || 0) + Math.max(0, state.currentTime - clip.start);

const seekMediaElement = (element, getTime) => {
  const applyTime = () => {
    try {
      element.currentTime = getTime();
    } catch {
      // Metadata may not be available on the first assignment.
    }
  };
  applyTime();
  if (element.readyState === 0) element.addEventListener('loadedmetadata', applyTime, {once: true});
};

const syncPreview = (forceSeek = false) => {
  const video = app.querySelector('#previewVideo');
  const image = app.querySelector('#previewImage');
  const audioPreview = app.querySelector('#audioPreview');
  const audioMix = app.querySelector('#previewAudioMix');
  if (!video || !image || !audioPreview || !audioMix) return;

  const playback = playbackAt(state.currentTime);
  const visual = playback.visual?.media.url ? playback.visual : null;
  const activeAudio = playback.audio.filter(({media}) => Boolean(media.url));
  const shouldShow = (element, show) => element.classList.toggle('visible', Boolean(show));

  shouldShow(video, visual?.media.kind === 'video');
  shouldShow(image, visual?.media.kind === 'image');
  shouldShow(audioPreview, !visual && activeAudio.length > 0);

  if (visual?.media.kind === 'video') {
    const sourceChanged = video.dataset.clipId !== visual.clip.id || video.dataset.mediaId !== visual.media.id;
    if (sourceChanged) {
      video.pause();
      video.src = visual.media.url;
      video.dataset.clipId = visual.clip.id;
      video.dataset.mediaId = visual.media.id;
    }
    if (sourceChanged || forceSeek) seekMediaElement(video, () => sourceTimeAtPlayhead(visual.clip));
    if (state.isPlaying) video.play().catch(() => {});
    else video.pause();
  } else {
    video.pause();
    delete video.dataset.clipId;
    delete video.dataset.mediaId;
  }

  if (visual?.media.kind === 'image') {
    if (image.dataset.clipId !== visual.clip.id || image.dataset.mediaId !== visual.media.id) {
      image.src = visual.media.url;
      image.dataset.clipId = visual.clip.id;
      image.dataset.mediaId = visual.media.id;
    }
  } else {
    image.removeAttribute('src');
    delete image.dataset.clipId;
    delete image.dataset.mediaId;
  }

  const existingAudio = new Map([...audioMix.querySelectorAll('audio[data-clip-id]')]
    .map((element) => [element.dataset.clipId, element]));
  activeAudio.forEach(({clip, media}) => {
    let element = existingAudio.get(clip.id);
    const sourceChanged = !element || element.dataset.mediaId !== media.id;
    if (!element) {
      element = document.createElement('audio');
      element.preload = 'auto';
      element.dataset.clipId = clip.id;
      audioMix.append(element);
    }
    existingAudio.delete(clip.id);
    if (sourceChanged) {
      element.pause();
      element.src = media.url;
      element.dataset.mediaId = media.id;
    }
    if (sourceChanged || forceSeek) {
      seekMediaElement(element, () => sourceTimeAtPlayhead(clip));
    }
    if (state.isPlaying) element.play().catch(() => {});
    else element.pause();
  });
  existingAudio.forEach((element) => {
    element.pause();
    element.remove();
  });

  state.previewPlaybackSignature = playbackSignature(playback);
};

const updatePlaybackFrame = () => {
  if (!state.isPlaying) return;
  const duration = playbackDuration();
  const elapsed = (performance.now() - state.playbackStartedAt) / 1000;
  state.currentTime = Math.min(duration, state.playbackOrigin + elapsed);
  const playhead = app.querySelector('#playhead');
  if (playhead) playhead.style.left = `${state.currentTime * scale()}px`;
  const current = app.querySelector('#playerCurrent');
  if (current) current.textContent = formatTime(state.currentTime);
  const playback = playbackAt(state.currentTime);
  if (playbackSignature(playback) !== state.previewPlaybackSignature) syncPreview(true);
  if (state.currentTime >= duration) {
    state.isPlaying = false;
    state.currentTime = 0;
    state.previewPlaybackSignature = null;
    renderApp();
    return;
  }
  state.rafId = requestAnimationFrame(updatePlaybackFrame);
};

const togglePlay = () => {
  if (state.isPlaying) {
    state.isPlaying = false;
    cancelAnimationFrame(state.rafId);
    renderApp();
  } else {
    if (state.currentTime >= playbackDuration()) state.currentTime = 0;
    state.isPlaying = true;
    state.playbackOrigin = state.currentTime;
    state.playbackStartedAt = performance.now();
    renderApp();
    state.rafId = requestAnimationFrame(updatePlaybackFrame);
  }
};

const seekTo = (time) => {
  state.currentTime = Math.max(0, Math.min(playbackDuration(), time));
  if (state.isPlaying) {
    state.playbackOrigin = state.currentTime;
    state.playbackStartedAt = performance.now();
  }
  state.previewPlaybackSignature = null;
  renderApp();
};

let falStatusRequest = null;

const checkFalStatus = async () => {
  const status = app.querySelector('#falStatus');
  const indicator = app.querySelector('#falIndicator');
  const connection = app.querySelector('#falConnection');
  if (!status || !indicator || !connection) return;
  try {
    // Fetch once per page load and reuse; renders happen on every
    // interaction and must not each issue a status request.
    falStatusRequest ||= fetch('/api/fal/status').then((response) => response.json());
    const data = await falStatusRequest;
    status.textContent = data.configured ? 'Ready' : 'Key missing';
    connection.title = data.configured ? 'FAL adapter ready for models' : 'Add FAL_API_KEY to .env to enable calls';
    indicator.classList.toggle('ready', Boolean(data.configured));
  } catch {
    falStatusRequest = null;
    status.textContent = 'Offline';
    connection.title = 'Local FAL adapter is offline';
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
const isKeyboardEditingTarget = (target) => target instanceof Element && Boolean(target.closest(
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
));
document.addEventListener('keydown', (event) => {
  if (
    event.key === 'Backspace'
    && !event.defaultPrevented
    && !event.isComposing
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && !isKeyboardEditingTarget(event.target)
    && deleteSelectedClip()
  ) {
    event.preventDefault();
    return;
  }
  if (event.code === 'Space' && !['INPUT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName)) { event.preventDefault(); togglePlay(); }
});

const restoreSession = async () => {
  const legacyProject = project;
  let persistedProject = null;
  try {
    await projectDatabase.requestPersistence();
    persistedProject = await projectDatabase.loadProject();
  } catch {
    // Fall back to the legacy bootstrap project if IndexedDB is unavailable.
  }

  projectStore = createProjectStore({
    storage: null,
    initialProject: persistedProject || legacyProject,
    onCommit: (savedProject) => projectDatabase.saveProject(savedProject),
  });
  project = projectStore.getProject();

  await Promise.all(project.mediaAssets.map(async (asset) => {
    const blob = await projectDatabase.getAsset(asset.id);
    if (!blob) return;
    projectStore.registerAssetUrl(asset.id, URL.createObjectURL(blob));
  }));
  project = projectStore.getProject();
  state.mediaHydrated = true;
  renderApp();
  void videoIndexer.resume({assets: project.mediaAssets}).catch((error) => {
    showToast(`Video indexing could not resume: ${error instanceof Error ? error.message : String(error)}`);
  });

  if (new URLSearchParams(globalThis.location.search).get('syncModelPricing') === '1') {
    try {
      const {result} = await import('/scripts/sync-model-pricing.mjs');
      showToast(`Stored ${result.modelCount} FAL models and ${result.priceCount} prices.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  }
  if (new URLSearchParams(globalThis.location.search).get('importModelPricing') === '1') {
    try {
      const {result} = await import('/scripts/import-model-pricing.mjs');
      showToast(`Imported ${result.storedCount} model pricing records.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  }
};

renderApp();
void restoreSession().catch(() => {
  state.mediaHydrated = true;
  renderApp();
});
