const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const BEAT_WIDTH = 330;
const PORT_Y = 37;
const MIN_GRAPH_WIDTH = 1400;
const MIN_GRAPH_HEIGHT = 850;

const graphSize = (beats) => ({
  width: Math.max(MIN_GRAPH_WIDTH, ...beats.map((beat) => beat.layout.x + BEAT_WIDTH + 160)),
  height: Math.max(MIN_GRAPH_HEIGHT, ...beats.map((beat) => beat.layout.y + 720)),
});

const connectionGeometry = (connection, beatById) => {
  const source = beatById.get(connection.fromBeatId);
  const target = beatById.get(connection.toBeatId);
  if (!source || !target) return null;
  const fromX = source.layout.x + BEAT_WIDTH;
  const fromY = source.layout.y + PORT_Y;
  const toX = target.layout.x;
  const toY = target.layout.y + PORT_Y;
  const bend = Math.max(72, Math.abs(toX - fromX) * .48);
  return {
    path: `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`,
    midpoint: {x: (fromX + toX) / 2, y: (fromY + toY) / 2},
  };
};

const patchDraftChrome = (layer, workspace, busy) => {
  const state = workspace.read();
  const dirty = layer.querySelector('.act-workspace-dirty');
  if (dirty) dirty.textContent = state.dirty ? 'Unsaved changes' : 'Saved';
  const save = layer.querySelector('[data-action="save-act-workspace"]');
  if (save) save.disabled = !state.dirty || busy;
};

const heroMarkup = (beat, job, assetById) => {
  if (job?.status === 'generating') return '<div class="act-beat-hero is-generating"><span>Generating still…</span></div>';
  const asset = beat.hero?.assetId ? assetById?.(beat.hero.assetId) : null;
  if (asset?.url) return `<div class="act-beat-hero"><img src="${escapeHtml(asset.url)}" alt="Storyboard still for ${escapeHtml(beat.text)}" /></div>`;
  return `<div class="act-beat-hero is-empty"><span>${job?.status === 'failed' ? 'Still failed — retry below' : 'No still yet'}</span></div>`;
};

const bindDialogKeyboard = (layer, modal, onClose) => {
  const handleKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]')]
      .filter((element) => !element.hidden && element.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', handleKeydown);
  return () => document.removeEventListener('keydown', handleKeydown);
};

const updateGraphGeometry = (layer, workspace) => {
  const {act} = workspace.read();
  const beatById = new Map(act.beats.map((beat) => [beat.id, beat]));
  const size = graphSize(act.beats);
  const graph = layer.querySelector('.act-workspace-graph');
  const svg = layer.querySelector('.act-beat-connections');
  if (graph) {
    graph.style.width = `${size.width}px`;
    graph.style.height = `${size.height}px`;
  }
  if (svg) svg.setAttribute('viewBox', `0 0 ${size.width} ${size.height}`);
  act.connections.forEach((connection) => {
    const geometry = connectionGeometry(connection, beatById);
    if (!geometry) return;
    layer.querySelector(`[data-connection-path="${CSS.escape(connection.id)}"]`)?.setAttribute('d', geometry.path);
    const insert = layer.querySelector(`[data-connection-insert="${CSS.escape(connection.id)}"]`);
    if (insert) {
      insert.style.left = `${geometry.midpoint.x}px`;
      insert.style.top = `${geometry.midpoint.y}px`;
    }
  });
};

export const renderActWorkspace = (layer, {
  workspace,
  onClose,
  onSave,
  busy = false,
  jobs = new Map(),
  assetById,
  onGenerateStill,
  onGenerateScreenplay,
  resolveMentions = () => ({}),
  attachMentionInput,
} = {}) => {
  if (!layer) return;
  const wasOpen = Boolean(layer.querySelector('.act-workspace-modal'));
  layer._actWorkspaceCleanup?.();
  layer._actWorkspaceCleanup = null;
  if (!workspace) {
    layer.innerHTML = '';
    layer.hidden = true;
    layer._actWorkspaceReturnFocus?.focus?.();
    layer._actWorkspaceReturnFocus = null;
    return;
  }
  if (!wasOpen) layer._actWorkspaceReturnFocus = document.activeElement;

  const renderOptions = {
    workspace, onClose, onSave, busy, jobs, assetById, onGenerateStill, onGenerateScreenplay,
    resolveMentions, attachMentionInput,
  };
  const rerender = () => renderActWorkspace(layer, renderOptions);
  const {act, dirty, completion} = workspace.read();
  const beatById = new Map(act.beats.map((beat) => [beat.id, beat]));
  const outgoingIds = new Set(act.connections.map((connection) => connection.fromBeatId));
  const size = graphSize(act.beats);
  const connectionMarkup = act.connections.map((connection) => {
    const geometry = connectionGeometry(connection, beatById);
    if (!geometry) return '';
    return `<path class="act-beat-connection" data-connection-path="${escapeHtml(connection.id)}" d="${geometry.path}" />`;
  }).join('');
  const connectionButtons = act.connections.map((connection) => {
    const geometry = connectionGeometry(connection, beatById);
    if (!geometry) return '';
    return `<button class="act-beat-link-insert" data-action="insert-beat-on-connection" data-connection-insert="${escapeHtml(connection.id)}" style="left:${geometry.midpoint.x}px;top:${geometry.midpoint.y}px" type="button" aria-label="Insert beat on connection">+</button>`;
  }).join('');

  layer.hidden = false;
  layer.innerHTML = `
    <div class="act-workspace-scrim">
      <section class="act-workspace-modal" role="dialog" aria-modal="true" aria-labelledby="actWorkspaceTitle">
        <header class="act-workspace-header">
          <div class="act-workspace-heading">
            <span class="board-act-number">ACT ${act.actNumber}</span>
            <input id="actWorkspaceTitle" class="act-workspace-title-input" value="${escapeHtml(act.title)}" aria-label="Act title" />
            <span class="act-workspace-dirty">${dirty ? 'Unsaved changes' : 'Saved'}</span>
          </div>
          <div class="act-workspace-progress" aria-label="Act completion">
            <span>${completion.stills}/${completion.beats} stills</span>
            <span>${completion.screenplays}/${completion.beats} scripts</span>
          </div>
          <div class="act-workspace-actions">
            <button class="button ghost" type="button" data-action="add-standalone-beat">+ Add beat</button>
            <button class="button primary" type="button" data-action="save-act-workspace" ${dirty && !busy ? '' : 'disabled'}>${busy ? 'Generating…' : 'Save'}</button>
            <button class="small-icon-button" type="button" data-action="close-act-workspace" aria-label="Close act workspace">×</button>
          </div>
        </header>
        <div class="act-workspace-summary-row"><textarea data-act-summary rows="2" aria-label="Act summary">${escapeHtml(act.summary)}</textarea></div>
        <div class="act-workspace-stage">
          <div class="act-workspace-graph" style="width:${size.width}px;height:${size.height}px">
            <svg class="act-beat-connections" viewBox="0 0 ${size.width} ${size.height}" aria-hidden="true">${connectionMarkup}</svg>
            ${connectionButtons}
            ${act.beats.map((beat, index) => {
              const job = jobs.get(beat.id) || {};
              const stillWorking = job.still?.status === 'generating';
              const scriptWorking = job.screenplay?.status === 'generating';
              return `<article class="act-beat-node" data-beat-id="${escapeHtml(beat.id)}" style="left:${beat.layout.x}px;top:${beat.layout.y}px">
                <span class="act-beat-port act-beat-port--input" aria-hidden="true"></span>
                <header class="act-beat-node-head">
                  <span>BEAT ${String(index + 1).padStart(2, '0')}</span>
                  <span class="act-beat-node-tools">
                    <button class="act-beat-drag-handle" type="button" aria-label="Move beat ${index + 1}">⠿</button>
                    <button class="act-beat-delete" data-action="delete-workspace-beat" type="button" aria-label="Delete beat ${index + 1}" ${stillWorking || scriptWorking ? 'disabled' : ''}>×</button>
                  </span>
                </header>
                ${heroMarkup(beat, job.still, assetById)}
                <label><span>Beat</span><textarea data-beat-description rows="3" aria-label="Beat description ${index + 1}">${escapeHtml(beat.text)}</textarea></label>
                <button class="button ghost act-generate-button" data-action="generate-beat-still" type="button" ${stillWorking ? 'disabled' : ''}>${stillWorking ? 'Generating still…' : job.still?.status === 'failed' ? 'Retry still' : beat.hero?.assetId ? 'Regenerate still' : 'Generate still'}</button>
                ${job.still?.error ? `<p class="act-generation-error">${escapeHtml(job.still.error)}</p>` : ''}
                <label class="act-screenplay-field"><span>Screenplay</span><textarea data-beat-screenplay rows="6" aria-label="Screenplay for beat ${index + 1}" placeholder="Generate or write action and dialogue…">${escapeHtml(beat.screenplay?.text || '')}</textarea></label>
                <button class="button ghost act-generate-button" data-action="generate-beat-script" type="button" ${scriptWorking ? 'disabled' : ''}>${scriptWorking ? 'Writing screenplay…' : job.screenplay?.status === 'failed' ? 'Retry script' : beat.screenplay?.text ? 'Regenerate script' : 'Generate script'}</button>
                ${job.screenplay?.error ? `<p class="act-generation-error">${escapeHtml(job.screenplay.error)}</p>` : ''}
                ${outgoingIds.has(beat.id) ? '<span class="act-beat-port act-beat-port--output" aria-hidden="true"></span>' : `<button class="act-beat-output-add" data-action="append-linked-beat" type="button" aria-label="Add linked beat after beat ${index + 1}">+</button>`}
              </article>`;
            }).join('')}
          </div>
        </div>
      </section>
    </div>
  `;

  const modal = layer.querySelector('.act-workspace-modal');
  layer._actWorkspaceCleanup = bindDialogKeyboard(layer, modal, onClose);
  if (!wasOpen) layer.querySelector('#actWorkspaceTitle')?.focus();
  layer.querySelector('[data-action="close-act-workspace"]')?.addEventListener('click', onClose);
  layer.querySelector('[data-action="save-act-workspace"]')?.addEventListener('click', onSave);
  layer.querySelector('[data-action="add-standalone-beat"]')?.addEventListener('click', () => {
    const nextY = act.beats.length ? Math.max(...act.beats.map((beat) => beat.layout.y)) + 720 : 72;
    workspace.dispatch({type: 'beat/insert', beat: {text: 'New beat', layout: {x: 56, y: nextY}}});
    rerender();
  });
  layer.querySelectorAll('[data-action="insert-beat-on-connection"]').forEach((button) => {
    button.addEventListener('click', () => {
      workspace.dispatch({type: 'beat/insert', connectionId: button.dataset.connectionInsert});
      rerender();
    });
  });
  layer.querySelectorAll('[data-action="append-linked-beat"]').forEach((button) => {
    button.addEventListener('click', () => {
      workspace.dispatch({type: 'beat/insert', afterBeatId: button.closest('[data-beat-id]')?.dataset.beatId});
      rerender();
    });
  });
  layer.querySelectorAll('[data-action="delete-workspace-beat"]').forEach((button) => {
    button.addEventListener('click', () => {
      workspace.dispatch({type: 'beat/remove', beatId: button.closest('[data-beat-id]')?.dataset.beatId});
      rerender();
    });
  });
  layer.querySelector('#actWorkspaceTitle')?.addEventListener('input', (event) => {
    workspace.dispatch({type: 'act/update', patch: {title: event.target.value}});
    patchDraftChrome(layer, workspace, busy);
  });
  layer.querySelector('[data-act-summary]')?.addEventListener('input', (event) => {
    workspace.dispatch({type: 'act/update', patch: {summary: event.target.value}});
    patchDraftChrome(layer, workspace, busy);
  });
  layer.querySelectorAll('[data-beat-description]').forEach((textarea) => {
    const beatId = textarea.closest('[data-beat-id]')?.dataset.beatId;
    textarea.addEventListener('input', () => {
      workspace.dispatch({type: 'beat/update', beatId, patch: {text: textarea.value, mentions: resolveMentions(textarea.value)}});
      patchDraftChrome(layer, workspace, busy);
    });
    attachMentionInput?.(textarea);
  });
  layer.querySelectorAll('[data-beat-screenplay]').forEach((textarea) => {
    const beatId = textarea.closest('[data-beat-id]')?.dataset.beatId;
    textarea.addEventListener('input', () => {
      const beat = workspace.read().act.beats.find((entry) => entry.id === beatId);
      workspace.dispatch({
        type: 'beat/update', beatId,
        patch: {screenplay: {...(beat?.screenplay || {}), text: textarea.value, editedAt: new Date().toISOString()}},
      });
      patchDraftChrome(layer, workspace, busy);
    });
  });
  layer.querySelectorAll('[data-action="generate-beat-still"]').forEach((button) => {
    button.addEventListener('click', () => onGenerateStill?.(button.closest('[data-beat-id]')?.dataset.beatId));
  });
  layer.querySelectorAll('[data-action="generate-beat-script"]').forEach((button) => {
    button.addEventListener('click', () => onGenerateScreenplay?.(button.closest('[data-beat-id]')?.dataset.beatId));
  });

  layer.querySelectorAll('.act-beat-drag-handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const node = handle.closest('[data-beat-id]');
      const beatId = node?.dataset.beatId;
      const beat = workspace.read().act.beats.find((entry) => entry.id === beatId);
      if (!node || !beat) return;
      const origin = {...beat.layout};
      const start = {x: event.clientX, y: event.clientY};
      handle.setPointerCapture(event.pointerId);
      node.classList.add('is-dragging');
      const move = (moveEvent) => {
        const layout = {
          x: Math.max(24, origin.x + moveEvent.clientX - start.x),
          y: Math.max(24, origin.y + moveEvent.clientY - start.y),
        };
        workspace.dispatch({type: 'beat/update', beatId, patch: {layout}});
        node.style.left = `${layout.x}px`;
        node.style.top = `${layout.y}px`;
        updateGraphGeometry(layer, workspace);
        patchDraftChrome(layer, workspace, busy);
      };
      const end = (endEvent) => {
        node.classList.remove('is-dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        if (handle.hasPointerCapture?.(endEvent.pointerId)) handle.releasePointerCapture(endEvent.pointerId);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  });
};
