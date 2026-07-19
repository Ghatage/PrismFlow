// Projects hub: the docked prism above a grid of projects. The "+" tile is
// always first; project tiles sort newest-first by the caller.

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

export const summarizeProject = (project) => ({
  id: project?.project?.id || '',
  name: project?.project?.name || 'Untitled story',
  createdAt: project?.project?.createdAt || '',
  updatedAt: project?.updatedAt || project?.project?.createdAt || '',
  sceneCount: (project?.scenes || []).length,
  beatCount: (project?.storyboard?.nodes || [])
    .filter((node) => node?.kind === 'act')
    .reduce((total, node) => total + (node.beats || []).length, 0),
  clipCount: (project?.timeline?.clips || []).length,
  hasStoryboard: Boolean(project?.storyboard),
});

export const sortSummaries = (summaries) => summaries.toSorted((left, right) =>
  String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

const countLine = (summary) => {
  const part = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  return `${part(summary.sceneCount, 'scene')} · ${part(summary.beatCount, 'beat')} · ${part(summary.clipCount, 'clip')}`;
};

const updatedLine = (iso) => {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const date = new Date(time);
  return `Updated ${date.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'})}`;
};

export const renderProjectsHub = (app, {summaries, onOpen, onCreate, onDelete}) => {
  const tiles = summaries.map((summary, index) => `
    <article class="hub-tile" data-project-id="${escapeHtml(summary.id)}" style="animation-delay:${Math.min((index + 1) * 45, 500)}ms">
      <button class="hub-tile-open" type="button" data-action="hub-open" aria-label="Open ${escapeHtml(summary.name)}">
        <span class="hub-tile-name">${escapeHtml(summary.name)}</span>
        <span class="hub-tile-meta">${escapeHtml(countLine(summary))}</span>
        <span class="hub-tile-updated">${escapeHtml(updatedLine(summary.updatedAt))}</span>
      </button>
      <button class="hub-tile-delete" type="button" data-action="hub-delete" aria-label="Delete ${escapeHtml(summary.name)}" title="Delete project">×</button>
    </article>`).join('');

  app.innerHTML = `
    <div class="projects-hub">
      <header class="hub-header">
        <div class="hub-prism-anchor" aria-hidden="true">
          <div class="hub-prism"><div class="brand-mark"><span></span><span></span><span></span></div></div>
        </div>
        <h1 class="hub-title">Prism</h1>
        <p class="hub-sub">Choose a project, or begin a new one</p>
      </header>
      <div class="hub-grid">
        <button class="hub-tile hub-tile-new" type="button" data-action="hub-create" aria-label="Create a new project">
          <span class="hub-tile-plus" aria-hidden="true">+</span>
          <span class="hub-tile-name">New project</span>
        </button>
        ${tiles}
      </div>
    </div>
  `;

  const root = app.querySelector('.projects-hub');
  root.querySelector('[data-action="hub-create"]').addEventListener('click', () => onCreate());
  root.querySelectorAll('.hub-tile[data-project-id]').forEach((tile) => {
    const projectId = tile.dataset.projectId;
    tile.querySelector('[data-action="hub-open"]').addEventListener('click', () => onOpen(projectId));
    tile.querySelector('[data-action="hub-delete"]').addEventListener('click', (event) => {
      event.stopPropagation();
      onDelete(projectId);
    });
  });
};
