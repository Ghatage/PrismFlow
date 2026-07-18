// Storyboard canvas: a comfy-ui-style free surface. Act boxes and note cards
// are draggable nodes on a pannable, zoomable dotted-grid canvas. Node
// positions are written straight to element transforms during drags — no full
// re-render on pointer moves. The board object is owned by the caller and
// persisted through the debounced onChange callback.

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ACT_WIDTH = 380;
const ACT_GAP = 60;
const ACT_Y = 200;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const GRID_SIZE = 26;

let nodeCounter = 0;
const nodeId = (prefix = 'sbnode') => `${prefix}-${Date.now().toString(36)}-${++nodeCounter}`;

let context = null; // {app, root, viewport, canvas, board, options}
let changeTimer = 0;

const scheduleChange = () => {
  if (!context?.options?.onChange) return;
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => context?.options?.onChange(context.board), 500);
};

export const buildStoryboardFromStyle = (style) => {
  const board = {
    schemaVersion: 1,
    styleId: style.id,
    styleTitle: style.title,
    pan: {x: 0, y: 0},
    zoom: 1,
    nextZ: 10,
    nodes: [],
  };

  const acts = style.acts.slice(0, 4);
  acts.forEach((act, index) => {
    board.nodes.push({
      id: nodeId(),
      kind: 'act',
      actNumber: index + 1,
      sceneId: null,
      title: act.title,
      summary: act.summary,
      beats: (act.beats || []).map((text) => ({id: nodeId('sb-beat'), text, mentions: {}})),
      stills: [],
      x: 90 + index * (ACT_WIDTH + ACT_GAP),
      y: ACT_Y,
      w: ACT_WIDTH,
      z: ++board.nextZ,
    });
  });

  // Helpful notes live OUTSIDE the act row.
  const noteTexts = [
    `${style.title}${style.authors?.length ? ` — ${style.authors.join(' · ')}` : ''}\n${style.tagline}`,
    ...(style.notes || []),
    'Drag any card to rearrange · drag the background to pan · pinch or ctrl+scroll to zoom · double-click text to edit.',
  ];
  noteTexts.forEach((text, index) => {
    board.nodes.push({
      id: nodeId(),
      kind: 'note',
      text,
      x: 90 + index * 320,
      y: 40,
      w: 280,
      z: ++board.nextZ,
    });
  });
  return board;
};

const beatTextMarkup = (beat) => {
  let html = escapeHtml(beat.text);
  Object.keys(beat.mentions || {})
    .sort((left, right) => right.length - left.length)
    .forEach((name) => {
      const pattern = new RegExp(`@${escapeRegExp(escapeHtml(name))}(?![\\w])`, 'gi');
      html = html.replace(pattern, (match) => `<em class="beat-mention">${match}</em>`);
    });
  return html;
};

const stillMarkup = (still, options) => {
  if (still.status === 'generating') {
    return `<figure class="board-still is-generating" data-still-id="${still.id}"><span>Generating…</span></figure>`;
  }
  if (still.status === 'failed') {
    return `<figure class="board-still is-failed" data-still-id="${still.id}"><span>Still failed</span><button class="board-still-remove" data-action="remove-still" type="button">×</button></figure>`;
  }
  const asset = still.assetId ? options.assetById?.(still.assetId) : null;
  if (!asset?.url) return '';
  return `<figure class="board-still" data-still-id="${still.id}"><img src="${escapeHtml(asset.url)}" alt="${escapeHtml(asset.name || 'Scene still')}" draggable="false" /></figure>`;
};

const actInnerMarkup = (node, options) => {
  const generating = node.stills.some((still) => still.status === 'generating');
  const stills = node.stills.map((still) => stillMarkup(still, options)).join('');
  return `
    <header class="board-act-header">
      <span class="board-act-number">ACT ${node.actNumber}</span>
      <span class="board-act-title" data-editable-title>${escapeHtml(node.title)}</span>
    </header>
    <p class="board-act-summary" data-editable>${escapeHtml(node.summary)}</p>
    ${node.beats.length ? `<ul class="board-beats">${node.beats.map((beat) => `<li class="board-beat" data-beat-id="${beat.id}"><span class="board-beat-text" data-editable-beat>${beatTextMarkup(beat)}</span><button class="board-beat-delete" data-action="delete-beat" title="Delete beat" aria-label="Delete beat" type="button">×</button></li>`).join('')}</ul>` : ''}
    <div class="board-beat-add"><textarea data-beat-input rows="1" placeholder="Add a beat · @mention cast · Enter saves"></textarea></div>
    ${stills ? `<div class="board-act-stills">${stills}</div>` : ''}
    <div class="board-act-actions"><button class="board-still-button" data-action="generate-still" type="button" ${generating ? 'disabled' : ''}>${generating ? 'Generating still…' : '✦ Generate still'}</button></div>
  `;
};

const nodeMarkup = (node, options) => {
  const transform = `transform: translate(${node.x}px, ${node.y}px); width: ${node.w}px; z-index: ${node.z};`;
  if (node.kind === 'act') {
    return `<div class="board-node board-node--act" data-node-id="${node.id}" style="${transform}">${actInnerMarkup(node, options)}</div>`;
  }
  const lines = String(node.text).split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('');
  return `
    <div class="board-node board-node--note" data-node-id="${node.id}" style="${transform}">
      <span class="board-note-pin" aria-hidden="true"></span>
      <div class="board-note-text" data-editable>${lines}</div>
    </div>
  `;
};

const castMarkup = (options) => {
  const characters = options.characters?.() || [];
  return `
    <header class="board-cast-header"><span class="board-act-number">CAST</span><button class="board-cast-add" data-action="cast-create" type="button">+ New character</button></header>
    <div class="board-cast-list">
      ${characters.map((character) => `<button class="board-cast-card" data-cast-character-id="${character.id}" type="button"><span class="board-cast-thumb">${options.renderCharacterVisual?.(character) || ''}</span><span class="board-cast-name">${escapeHtml(character.name)}</span><span class="board-cast-meta">${character.lockedVersionId ? 'Locked' : character.status}</span></button>`).join('')}
      ${characters.length ? '' : '<p class="board-cast-empty">Create your cast here, then @mention them in act beats.</p>'}
    </div>
  `;
};

const applyView = () => {
  if (!context) return;
  const {viewport, canvas, board} = context;
  const zoom = board.zoom || 1;
  canvas.style.transform = `translate(${board.pan.x}px, ${board.pan.y}px) scale(${zoom})`;
  const grid = GRID_SIZE * zoom;
  viewport.style.backgroundSize = `${grid}px ${grid}px`;
  viewport.style.backgroundPosition = `${board.pan.x % grid}px ${board.pan.y % grid}px`;
};

const setZoom = (nextZoom, anchorX, anchorY) => {
  if (!context) return;
  const {board} = context;
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  if (zoom === board.zoom) return;
  // Keep the canvas point under the anchor stationary while scaling.
  board.pan.x = anchorX - (anchorX - board.pan.x) * (zoom / board.zoom);
  board.pan.y = anchorY - (anchorY - board.pan.y) * (zoom / board.zoom);
  board.zoom = zoom;
  applyView();
  scheduleChange();
};

const bindDynamicInputs = () => {
  if (!context) return;
  const {root, options} = context;
  root.querySelectorAll('[data-beat-input]:not([data-mention-bound])').forEach((textarea) => {
    textarea.dataset.mentionBound = 'true';
    options.attachMentionInput?.(textarea);
  });
};

export const refreshStoryboardChrome = () => {
  if (!context) return;
  const {app, board, options} = context;
  const cast = app.querySelector('#boardCast');
  if (cast) cast.innerHTML = castMarkup(options);
  board.nodes.filter((node) => node.kind === 'act').forEach((node) => {
    const element = app.querySelector(`.board-node[data-node-id="${node.id}"]`);
    if (element && !element.querySelector('[data-beat-input]:focus')) {
      element.innerHTML = actInnerMarkup(node, options);
    }
  });
  bindDynamicInputs();
};

const commitBeat = (textarea) => {
  const {board, options} = context;
  const nodeElement = textarea.closest('.board-node');
  const node = board.nodes.find((entry) => entry.id === nodeElement?.dataset.nodeId);
  const text = textarea.value.trim();
  if (!node || !text) return;
  node.beats.push({
    id: nodeId('sb-beat'),
    text,
    mentions: options.resolveMentions?.(text) || {},
  });
  textarea.value = '';
  // The chrome refresher intentionally preserves a focused composer while
  // unrelated board state changes. A committed beat is the exception: release
  // focus so the new list item can replace the composer DOM, then focus its
  // freshly rendered successor below.
  textarea.blur();
  refreshStoryboardChrome();
  context.app.querySelector(`.board-node[data-node-id="${node.id}"] [data-beat-input]`)?.focus();
  scheduleChange();
};

export const renderStoryboard = (app, options) => {
  if (app.querySelector('.storyboard')) {
    // Preserve drag state across stray re-renders; adopt the latest options.
    if (context) context.options = options;
    return;
  }

  const board = options.storyboard;
  if (!board) return;
  if (!Number.isFinite(board.zoom)) board.zoom = 1;

  app.innerHTML = `
    <div class="storyboard">
      <header class="storyboard-topbar">
        <div class="brand-lockup">
          <div class="brand-mark"><span></span><span></span><span></span></div>
          <span class="brand-name">PrismFlow</span>
          <span class="brand-divider"></span>
          <button class="storyboard-back" type="button" data-action="back-to-picker">← Structures</button>
          <span class="storyboard-style-name">${escapeHtml(board.styleTitle)}</span>
        </div>
        <div class="storyboard-topbar-right">
          <span class="storyboard-hint">drag cards · pan background · pinch to zoom</span>
          <span class="storyboard-zoom" id="storyboardZoom">${Math.round((board.zoom || 1) * 100)}%</span>
          <button class="button primary" type="button" data-action="jump-to-editor">Jump to editor →</button>
        </div>
      </header>
      <div class="board-viewport" id="boardViewport">
        <div class="board-canvas" id="boardCanvas">
          ${board.nodes.map((node) => nodeMarkup(node, options)).join('')}
        </div>
        <aside class="board-cast" id="boardCast">${castMarkup(options)}</aside>
      </div>
    </div>
  `;

  const root = app.querySelector('.storyboard');
  root.querySelector('[data-action="jump-to-editor"]').addEventListener('click', options.onJumpToEditor);
  root.querySelector('[data-action="back-to-picker"]').addEventListener('click', options.onBackToPicker);

  const viewport = root.querySelector('#boardViewport');
  const canvas = root.querySelector('#boardCanvas');
  context = {app, root, viewport, canvas, board, options};
  applyView();
  bindDynamicInputs();

  const zoomReadout = root.querySelector('#storyboardZoom');
  const updateZoomReadout = () => { zoomReadout.textContent = `${Math.round(board.zoom * 100)}%`; };

  let gesture = null; // {mode: 'pan'|'node', node?, startX, startY, originX, originY, element?}
  let rafId = 0;
  let lastEvent = null;

  const applyGesture = () => {
    rafId = 0;
    if (!gesture || !lastEvent) return;
    const dx = lastEvent.clientX - gesture.startX;
    const dy = lastEvent.clientY - gesture.startY;
    if (gesture.mode === 'pan') {
      board.pan.x = gesture.originX + dx;
      board.pan.y = gesture.originY + dy;
      applyView();
    } else {
      gesture.node.x = gesture.originX + dx / board.zoom;
      gesture.node.y = gesture.originY + dy / board.zoom;
      gesture.element.style.transform = `translate(${gesture.node.x}px, ${gesture.node.y}px)`;
    }
  };

  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('button, a, input, textarea, select, .board-cast')) return;
    if (event.target.isContentEditable) return;
    const nodeElement = event.target.closest('.board-node');
    root.querySelectorAll('.board-node.is-selected').forEach((el) => el.classList.remove('is-selected'));
    if (nodeElement) {
      const node = board.nodes.find((entry) => entry.id === nodeElement.dataset.nodeId);
      if (!node) return;
      node.z = ++board.nextZ;
      nodeElement.style.zIndex = node.z;
      nodeElement.classList.add('is-selected', 'is-dragging');
      gesture = {mode: 'node', node, element: nodeElement, startX: event.clientX, startY: event.clientY, originX: node.x, originY: node.y};
    } else {
      viewport.classList.add('is-panning');
      gesture = {mode: 'pan', startX: event.clientX, startY: event.clientY, originX: board.pan.x, originY: board.pan.y};
    }
    viewport.setPointerCapture(event.pointerId);
  });

  viewport.addEventListener('pointermove', (event) => {
    if (!gesture) return;
    lastEvent = event;
    if (!rafId) rafId = requestAnimationFrame(applyGesture);
  });

  const endGesture = (event) => {
    if (!gesture) return;
    if (gesture.element) gesture.element.classList.remove('is-dragging');
    viewport.classList.remove('is-panning');
    if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    gesture = null;
    lastEvent = null;
    scheduleChange();
  };
  viewport.addEventListener('pointerup', endGesture);
  viewport.addEventListener('pointercancel', endGesture);

  // Trackpad pinch arrives as ctrl+wheel; plain wheel pans the canvas.
  viewport.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const anchorX = event.clientX - rect.left;
    const anchorY = event.clientY - rect.top;
    if (event.ctrlKey || event.metaKey) {
      setZoom(board.zoom * Math.exp(-event.deltaY * 0.01), anchorX, anchorY);
      updateZoomReadout();
    } else {
      board.pan.x -= event.deltaX;
      board.pan.y -= event.deltaY;
      applyView();
      scheduleChange();
    }
  }, {passive: false});

  // Safari reports trackpad pinches through proprietary gesture events.
  let gestureStartZoom = 1;
  viewport.addEventListener('gesturestart', (event) => {
    event.preventDefault();
    gestureStartZoom = board.zoom;
  });
  viewport.addEventListener('gesturechange', (event) => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    setZoom(gestureStartZoom * event.scale, event.clientX - rect.left, event.clientY - rect.top);
    updateZoomReadout();
  });
  viewport.addEventListener('gestureend', (event) => event.preventDefault());

  // Board interactions: cast, beats, stills.
  root.addEventListener('click', (event) => {
    const castCard = event.target.closest('[data-cast-character-id]');
    if (castCard) { options.onOpenCharacter?.(castCard.dataset.castCharacterId); return; }
    if (event.target.closest('[data-action="cast-create"]')) { options.onCreateCharacter?.(); return; }
    const deleteBeat = event.target.closest('[data-action="delete-beat"]');
    if (deleteBeat) {
      const beatId = deleteBeat.closest('.board-beat')?.dataset.beatId;
      const node = board.nodes.find((entry) => entry.id === deleteBeat.closest('.board-node')?.dataset.nodeId);
      if (node && beatId) {
        node.beats = node.beats.filter((beat) => beat.id !== beatId);
        refreshStoryboardChrome();
        scheduleChange();
      }
      return;
    }
    const removeStill = event.target.closest('[data-action="remove-still"]');
    if (removeStill) {
      const stillId = removeStill.closest('.board-still')?.dataset.stillId;
      const node = board.nodes.find((entry) => entry.id === removeStill.closest('.board-node')?.dataset.nodeId);
      if (node && stillId) {
        node.stills = node.stills.filter((still) => still.id !== stillId);
        refreshStoryboardChrome();
        scheduleChange();
      }
      return;
    }
    const generateStill = event.target.closest('[data-action="generate-still"]');
    if (generateStill) {
      const node = board.nodes.find((entry) => entry.id === generateStill.closest('.board-node')?.dataset.nodeId);
      if (node) options.onGenerateStill?.(node);
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.defaultPrevented) return;
    if (!event.target.matches?.('[data-beat-input]')) return;
    event.preventDefault();
    commitBeat(event.target);
  });

  // Double-click to edit titles, summaries, and notes in place.
  viewport.addEventListener('dblclick', (event) => {
    const editable = event.target.closest('[data-editable], [data-editable-title], [data-editable-beat]');
    if (!editable) return;
    editable.contentEditable = 'plaintext-only';
    editable.focus();
    const stopEditing = () => {
      editable.contentEditable = 'false';
      const nodeElement = editable.closest('.board-node');
      const node = board.nodes.find((entry) => entry.id === nodeElement?.dataset.nodeId);
      if (node) {
        if (editable.hasAttribute('data-editable-beat')) {
          const beat = node.beats?.find((entry) => entry.id === editable.closest('.board-beat')?.dataset.beatId);
          if (beat) {
            beat.text = editable.textContent.trim() || beat.text;
            beat.mentions = options.resolveMentions?.(beat.text) || {};
            refreshStoryboardChrome();
          }
        } else if (editable.hasAttribute('data-editable-title')) {
          node.title = editable.textContent.trim() || node.title;
          options.onActRename?.(node);
        } else if (node.kind === 'act') {
          node.summary = editable.textContent;
        } else {
          node.text = editable.textContent;
        }
        scheduleChange();
      }
    };
    editable.addEventListener('blur', stopEditing, {once: true});
  });
};
