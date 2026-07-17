const state = {
  media: [],
  clips: [],
  selectedClipId: null,
  currentTime: 0,
  isPlaying: false,
  zoom: 1,
  timelineDuration: 12,
  activeTab: 'media',
  previewSourceId: null,
  previewClipId: null,
  rafId: null,
  playbackStartedAt: 0,
  playbackOrigin: 0,
  dragPayload: null,
};

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
const scale = () => 88 * state.zoom;

const renderApp = () => {
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand-lockup">
          <div class="brand-mark"><span></span><span></span><span></span></div>
          <span class="brand-name">PrismFlow</span>
          <span class="brand-divider"></span>
          <button class="project-switcher" type="button">Untitled story ${icons.chevron}</button>
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
            <button class="panel-tab ${state.activeTab === 'scenes' ? 'active' : ''}" data-tab="scenes" type="button">Scenes</button>
          </div>
          ${state.activeTab === 'media' ? renderMediaPanel() : renderScenesPanel()}
        </aside>

        <section class="stage">
          <div class="stage-toolbar">
            <div class="breadcrumb"><span class="eyebrow">STORYBOARD</span><span class="slash">/</span><span>Untitled story</span></div>
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
    <div class="media-thumb ${item.kind}">${item.kind === 'image' ? `<img src="${item.url}" alt="" />` : item.kind === 'video' ? `<video src="${item.url}" muted preload="metadata"></video>` : `<div class="audio-thumb">${icons.audio}</div>`}<span class="type-badge">${kindIcon(item.kind)}</span></div>
    <div class="media-card-copy"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><span>${item.kind} · ${item.kind === 'image' ? 'still' : formatTime(item.duration)}</span></div>
    <button class="card-more" data-action="remove-media" data-media-id="${item.id}" type="button">${icons.more}</button>
  </div>
`;

const renderScenesPanel = () => `
  <div class="panel-heading"><div><span class="eyebrow">PROJECT MAP</span><h2>Scenes</h2></div><button class="small-icon-button" type="button">${icons.plus}</button></div>
  <div class="scene-list"><div class="scene-item active"><span class="scene-number">01</span><div><strong>Opening scene</strong><span>Untitled · ${formatTime(state.timelineDuration)}</span></div><span class="scene-status"></span></div></div>
  <div class="scene-empty"><div class="scene-line"></div><span>Scenes will group timeline beats as your story grows.</span></div>
`;

const renderInspector = () => {
  const selected = clipById(state.selectedClipId);
  const media = selected ? mediaById(selected.mediaId) : null;
  return `
    <div class="inspector-head"><div><span class="eyebrow">INSPECTOR</span><h2>${selected ? 'Clip properties' : 'Workspace'}</h2></div><button class="small-icon-button" type="button">${icons.more}</button></div>
    ${selected && media ? `<div class="selected-preview ${media.kind}">${media.kind === 'image' ? `<img src="${media.url}" alt="" />` : media.kind === 'video' ? `<video src="${media.url}" muted preload="metadata"></video>` : `<div class="audio-orb">${icons.audio}</div>`}<span class="selected-type">${media.kind.toUpperCase()}</span></div><div class="inspector-title"><strong>${escapeHtml(media.name)}</strong><span>${selected.trackId === 'V1' ? 'Video track' : 'Audio track'} · ${formatTime(selected.duration)}</span></div><div class="property-group"><label>Timing</label><div class="property-grid"><div><span>Start</span><strong>${formatTime(selected.start)}</strong></div><div><span>Duration</span><strong>${formatTime(selected.duration)}</strong></div></div></div><div class="property-group"><label>Source</label><div class="source-line"><span class="source-icon">${kindIcon(media.kind)}</span><span>${escapeHtml(media.name)}</span></div></div><button class="danger-button" data-action="delete-clip" type="button">${icons.close} Remove from timeline</button>` : `<div class="workspace-card"><div class="workspace-glow">${icons.magic}</div><strong>Compose with intent</strong><span>Select a timeline clip to inspect timing, provenance, and future generation settings.</span></div>`}
    <div class="fal-card"><div class="fal-card-top"><div class="fal-logo">f/</div><div><strong>FAL connection</strong><span>Generation adapter</span></div><span class="connection-indicator" id="falIndicator"></span></div><div class="fal-status" id="falStatus">Checking local adapter…</div><button class="fal-button" type="button" disabled>${icons.magic} Add a generation later</button></div>
  `;
};

const renderTimeline = () => {
  const timelineWidth = Math.max(900, (state.timelineDuration + 3) * scale());
  const ticks = Array.from({length: Math.ceil(state.timelineDuration) + 2}, (_, index) => index);
  const videoClips = state.clips.filter((clip) => clip.trackId === 'V1');
  const audioClips = state.clips.filter((clip) => clip.trackId === 'A1');
  return `
    <div class="timeline-toolbar"><div class="timeline-title"><span class="eyebrow">EDIT</span><h2>Timeline</h2><span class="sequence-chip">Scene 01</span></div><div class="timeline-actions"><button class="toolbar-button" data-action="split" type="button">${icons.scissors} Split</button><button class="toolbar-button" data-action="add-track" type="button">${icons.plus} Track</button><span class="tool-divider"></span><button class="toolbar-button" data-action="zoom-out" type="button">−</button><span class="zoom-value">${Math.round(state.zoom * 100)}%</span><button class="toolbar-button" data-action="zoom-in" type="button">+</button></div></div>
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
  const media = mediaById(clip.mediaId);
  if (!media) return '';
  const width = Math.max(clip.duration * scale(), 66);
  return `<div class="timeline-clip ${media.kind} ${clip.id === state.selectedClipId ? 'selected' : ''}" draggable="true" data-clip-id="${clip.id}" style="left:${clip.start * scale()}px;width:${width}px"><div class="clip-thumb">${media.kind === 'image' ? `<img src="${media.url}" alt="" />` : media.kind === 'video' ? `<video src="${media.url}" muted preload="metadata"></video>` : `<span>${icons.audio}</span>`}</div><div class="clip-copy"><strong>${escapeHtml(media.name)}</strong><span>${formatTime(clip.duration)}</span></div><div class="clip-handle left"></div><div class="clip-handle right"></div></div>`;
};

const bindEvents = () => {
  app.querySelectorAll('[data-action="open-file"]').forEach((button) => button.addEventListener('click', () => fileInput.click()));
  app.querySelectorAll('[data-action="add-sample"]').forEach((button) => button.addEventListener('click', addSampleMedia));
  app.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => { state.activeTab = button.dataset.tab; renderApp(); }));
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
    const clip = {id: `clip-${crypto.randomUUID()}`, mediaId, trackId: media.kind === 'audio' ? 'A1' : trackId === 'A1' ? 'V1' : trackId, start, duration: media.kind === 'image' ? 5 : Math.max(0.1, media.duration || 5)};
    state.clips.push(clip);
    state.selectedClipId = clip.id;
    state.timelineDuration = Math.max(state.timelineDuration, clip.start + clip.duration + 2);
  } else if (clipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    clip.start = start;
    clip.trackId = trackId;
    state.selectedClipId = clip.id;
    state.timelineDuration = Math.max(state.timelineDuration, clip.start + clip.duration + 2);
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
    const item = {id: `media-${crypto.randomUUID()}`, name: file.name, kind, type: file.type, size: file.size, url: URL.createObjectURL(file), duration: kind === 'image' ? 5 : 0};
    state.media.push(item);
    if (kind === 'image') renderApp();
    else {
      const probe = document.createElement(kind === 'audio' ? 'audio' : 'video');
      probe.preload = 'metadata';
      probe.src = item.url;
      probe.onloadedmetadata = () => { item.duration = Number.isFinite(probe.duration) ? probe.duration : 5; renderApp(); };
      probe.onerror = () => { item.duration = 5; renderApp(); };
    }
  });
  if (files.length) showToast(`${files.length} media ${files.length === 1 ? 'file' : 'files'} imported.`);
};

const addSampleMedia = () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#6d4bd5"/><stop offset="1" stop-color="#42b9af"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="510" cy="90" r="72" fill="#f7d6a0" opacity=".8"/><text x="48" y="190" fill="white" font-family="sans-serif" font-size="42" font-weight="700">PrismFlow sample</text></svg>`;
  addFiles([new File([svg], 'prismflow-sample.svg', {type: 'image/svg+xml'})]);
};

const removeMedia = (mediaId) => {
  const clips = state.clips.filter((clip) => clip.mediaId === mediaId);
  clips.forEach((clip) => { if (clip.id === state.selectedClipId) state.selectedClipId = null; });
  state.clips = state.clips.filter((clip) => clip.mediaId !== mediaId);
  const item = mediaById(mediaId);
  if (item) URL.revokeObjectURL(item.url);
  state.media = state.media.filter((media) => media.id !== mediaId);
  renderApp();
};

const deleteSelectedClip = () => {
  state.clips = state.clips.filter((clip) => clip.id !== state.selectedClipId);
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
  const media = clip ? mediaById(clip.mediaId) : null;
  const shouldShow = (element, show) => element.classList.toggle('visible', Boolean(show));
  shouldShow(empty, !media);
  shouldShow(video, media?.kind === 'video');
  shouldShow(image, media?.kind === 'image');
  shouldShow(audio, media?.kind === 'audio');
  if (!media || !clip) {
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
  if (clip && (clip.id !== state.previewClipId || mediaById(clip.mediaId)?.id !== state.previewSourceId)) syncPreview(true);
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
