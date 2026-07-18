// Narrative style picker: full-screen card grid of storyline structures.
// Card headline is the structure name; the credited authors live in the
// sub-tagline. "Custom" is always the first card.

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const authorLine = (style) => (style.authors.length ? style.authors.join(' · ') : 'Your structure');

const explanationLine = (style) => style.notes?.find(Boolean) || style.acts[0]?.summary || style.tagline;

// One large generated tapestry supplies many distinct-looking crops without
// making the picker download a separate full-resolution image for every row.
const artPosition = (index) => ({
  x: [0, 25, 50, 75, 100][index % 5],
  y: [0, 34, 67, 100][Math.floor(index / 5) % 4],
});

export const renderStylePicker = (app, {styles, selectedId, onSelect, onNext}) => {
  const existing = app.querySelector('.style-picker');
  if (existing) {
    // Cheap patch: update selection highlight + button state without a rebuild.
    existing.querySelectorAll('.picker-card').forEach((card) => {
      const isSelected = card.dataset.styleId === selectedId;
      card.classList.toggle('is-selected', isSelected);
      card.setAttribute('aria-pressed', String(isSelected));
    });
    const next = existing.querySelector('[data-action="picker-next"]');
    if (next) next.disabled = !selectedId;
    return;
  }

  const cards = styles.map((style, index) => {
    const position = artPosition(index);
    const isSelected = style.id === selectedId;
    return `
      <button class="picker-card${style.id === 'custom' ? ' picker-card--custom' : ''}${isSelected ? ' is-selected' : ''}"
              type="button" data-style-id="${escapeHtml(style.id)}" aria-pressed="${isSelected}"
              style="--picker-art-x:${position.x}%;--picker-art-y:${position.y}%;animation-delay:${Math.min(index * 28, 700)}ms">
        <span class="picker-card-art" aria-hidden="true"></span>
        <span class="picker-card-vignette" aria-hidden="true"></span>
        <span class="picker-card-copy">
          <h3 class="picker-card-title">${escapeHtml(style.title)}</h3>
          <p class="picker-card-authors">${escapeHtml(authorLine(style))}</p>
          <p class="picker-card-tagline">${escapeHtml(style.tagline)}</p>
          <p class="picker-card-explanation" title="${escapeHtml(explanationLine(style))}">${escapeHtml(explanationLine(style))}</p>
          <span class="picker-card-acts">${style.acts.length} act${style.acts.length === 1 ? '' : 's'}</span>
        </span>
      </button>
    `;
  }).join('');

  app.innerHTML = `
    <div class="style-picker">
      <div class="picker-halo" aria-hidden="true"></div>
      <header class="picker-header">
        <div class="brand-lockup">
          <div class="brand-mark"><span></span><span></span><span></span></div>
          <span class="brand-name">PrismFlow</span>
        </div>
        <button class="button ghost picker-skip" type="button" data-action="picker-skip">Jump to editor →</button>
      </header>
      <div class="picker-body">
        <p class="picker-eyebrow">STORYBOARD · CHOOSE A STRUCTURE</p>
        <h2 class="picker-heading">How will this story be told?</h2>
        <p class="picker-lede">Every film hangs on a shape. Pick a narrative structure and we'll lay out your acts — or start from nothing.</p>
        <div class="picker-grid">${cards}</div>
      </div>
      <footer class="picker-footer">
        <span class="picker-selection-label"></span>
        <button class="button primary picker-next" type="button" data-action="picker-next" ${selectedId ? '' : 'disabled'}>Next →</button>
      </footer>
    </div>
  `;

  const root = app.querySelector('.style-picker');
  root.querySelectorAll('.picker-card').forEach((card) => {
    card.addEventListener('click', () => onSelect(card.dataset.styleId));
    card.addEventListener('dblclick', () => { onSelect(card.dataset.styleId); onNext(); });
  });
  root.querySelector('[data-action="picker-next"]').addEventListener('click', onNext);
  root.querySelector('[data-action="picker-skip"]').addEventListener('click', () => onNext('editor'));
  updateSelectionLabel(root, styles, selectedId);
};

const updateSelectionLabel = (root, styles, selectedId) => {
  const label = root.querySelector('.picker-selection-label');
  if (!label) return;
  const style = styles.find((entry) => entry.id === selectedId);
  label.textContent = style ? `${style.title} — ${authorLine(style)}` : 'Select a structure to continue';
};

export const patchStylePickerSelection = (app, styles, selectedId) => {
  const root = app.querySelector('.style-picker');
  if (!root) return;
  root.querySelectorAll('.picker-card').forEach((card) => {
    const isSelected = card.dataset.styleId === selectedId;
    card.classList.toggle('is-selected', isSelected);
    card.setAttribute('aria-pressed', String(isSelected));
  });
  const next = root.querySelector('[data-action="picker-next"]');
  if (next) next.disabled = !selectedId;
  updateSelectionLabel(root, styles, selectedId);
};
