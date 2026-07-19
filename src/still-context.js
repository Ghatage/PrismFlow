const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const text = (value) => typeof value === 'string' ? value : '';

export const normalizeStillContextSettings = (value = {}) => {
  const hiddenItemIds = [...new Set((Array.isArray(value?.hiddenItemIds) ? value.hiddenItemIds : [])
    .filter((itemId) => typeof itemId === 'string' && itemId.trim())
    .map((itemId) => itemId.trim()))];
  const overrides = Object.fromEntries(Object.entries(value?.overrides && typeof value.overrides === 'object'
    ? value.overrides
    : {})
    .filter(([itemId, override]) => itemId.trim() && typeof override === 'string')
    .map(([itemId, override]) => [itemId.trim(), override]));
  return {hiddenItemIds, overrides};
};

const item = (settings, input) => {
  const hidden = settings.hiddenItemIds.includes(input.id);
  const sourceText = text(input.text);
  return {
    type: input.assetId ? 'reference' : 'text',
    editable: (input.editable !== false && !input.assetId) || Boolean(input.editable),
    ...input,
    sourceText,
    text: Object.hasOwn(settings.overrides, input.id) ? settings.overrides[input.id] : sourceText,
    included: !hidden,
  };
};

export const buildStillContextItems = (context, rawSettings = {}) => {
  const settings = normalizeStillContextSettings(rawSettings);
  const items = [
    item(settings, {id: 'project:name', group: 'Project', title: 'Project name', text: context.project?.name}),
    item(settings, {id: 'project:aspect-ratio', group: 'Project', title: 'Aspect ratio', text: context.project?.metadata?.aspectRatio, editable: false}),
    item(settings, {id: 'narrative:title', group: 'Narrative', title: 'Narrative structure', text: context.narrative?.title}),
    item(settings, {id: 'narrative:tagline', group: 'Narrative', title: 'Narrative pattern', text: context.narrative?.tagline}),
    item(settings, {id: 'narrative:notes', group: 'Narrative', title: 'Narrative direction', text: (context.narrative?.notes || []).join('\n')}),
    item(settings, {id: 'act:title', group: 'Current act', title: 'Act title', text: context.act?.title}),
    item(settings, {id: 'act:summary', group: 'Current act', title: 'Act summary', text: context.act?.summary}),
  ];

  (context.storySoFar || []).forEach((act, actIndex) => {
    const actKey = act.id || `act-${actIndex}`;
    items.push(
      item(settings, {id: `story:${actKey}:title`, group: 'Story so far', title: `Prior act ${act.actNumber ?? actIndex + 1}`, text: act.title}),
      item(settings, {id: `story:${actKey}:summary`, group: 'Story so far', title: `${act.title || 'Prior act'} summary`, text: act.summary}),
    );
    (act.beats || []).forEach((beat, beatIndex) => {
      const beatKey = beat.id || `beat-${beatIndex}`;
      items.push(
        item(settings, {id: `story:${actKey}:${beatKey}:text`, group: 'Story so far', title: `Prior beat: ${beat.text || beatKey}`, text: beat.text}),
        item(settings, {id: `story:${actKey}:${beatKey}:screenplay`, group: 'Story so far', title: `Prior screenplay: ${beat.text || beatKey}`, text: beat.screenplay}),
      );
    });
  });

  items.push(
    item(settings, {id: 'target:beat', group: 'Target beat', title: 'Still prompt / beat description', text: context.target?.text, required: true}),
    item(settings, {id: 'target:screenplay', group: 'Target beat', title: 'Target screenplay', text: context.target?.screenplay}),
  );

  (context.characters || []).forEach((character) => {
    items.push(item(settings, {
      id: `character:${character.id}`,
      group: 'Character references',
      title: `${character.mentioned ? 'In frame' : 'Established cast'}: ${character.name}`,
      text: character.prompt,
      assetId: character.sheetAssetId,
      detail: character.versionId ? `Version ${character.versionId}` : 'No character version',
      editable: true,
    }));
  });

  items.push(item(settings, {id: 'style:bible', group: 'Visual style', title: 'Visual style bible', text: context.style?.bible}));
  (context.style?.referenceAssetIds || []).forEach((assetId, index) => {
    items.push(item(settings, {
      id: `style-reference:${assetId}`,
      group: 'Visual style',
      title: `Style reference ${index + 1}`,
      assetId,
      detail: assetId,
      editable: false,
    }));
  });
  if (context.previousStill?.assetId) {
    items.push(item(settings, {
      id: 'previous-still',
      group: 'Continuity',
      title: 'Previous storyboard still',
      assetId: context.previousStill.assetId,
      detail: `From beat ${context.previousStill.beatId}`,
      editable: false,
    }));
  }
  return items.filter((entry) => entry.assetId || entry.sourceText || entry.required);
};

export const applyStillContextSettings = (sourceContext, rawSettings = {}) => {
  const context = clone(sourceContext);
  const settings = normalizeStillContextSettings(rawSettings);
  const hidden = new Set(settings.hiddenItemIds);
  const override = (itemId, fallback) => Object.hasOwn(settings.overrides, itemId)
    ? settings.overrides[itemId]
    : text(fallback);
  const includedText = (itemId, fallback) => hidden.has(itemId) ? '' : override(itemId, fallback);

  context.project.name = includedText('project:name', context.project?.name);
  context.project.metadata = {...(context.project?.metadata || {})};
  if (hidden.has('project:aspect-ratio')) delete context.project.metadata.aspectRatio;

  context.narrative.title = includedText('narrative:title', context.narrative?.title);
  context.narrative.tagline = includedText('narrative:tagline', context.narrative?.tagline);
  const narrativeNotes = includedText('narrative:notes', (context.narrative?.notes || []).join('\n'));
  context.narrative.notes = narrativeNotes ? narrativeNotes.split(/\r?\n/).filter(Boolean) : [];
  context.act.title = includedText('act:title', context.act?.title);
  context.act.summary = includedText('act:summary', context.act?.summary);

  context.storySoFar = (context.storySoFar || []).map((act, actIndex) => {
    const actKey = act.id || `act-${actIndex}`;
    const next = {
      ...act,
      title: includedText(`story:${actKey}:title`, act.title),
      summary: includedText(`story:${actKey}:summary`, act.summary),
      beats: (act.beats || []).map((beat, beatIndex) => {
        const beatKey = beat.id || `beat-${beatIndex}`;
        return {
          ...beat,
          text: includedText(`story:${actKey}:${beatKey}:text`, beat.text),
          screenplay: includedText(`story:${actKey}:${beatKey}:screenplay`, beat.screenplay),
        };
      }).filter((beat) => beat.text || beat.screenplay),
    };
    return next;
  }).filter((act) => act.title || act.summary || act.beats.length);

  context.target.text = includedText('target:beat', context.target?.text)
    || 'Create a distinct cinematic storyboard still using only the included context.';
  context.target.screenplay = includedText('target:screenplay', context.target?.screenplay);
  context.characters = (context.characters || [])
    .filter((character) => !hidden.has(`character:${character.id}`))
    .map((character) => ({...character, prompt: override(`character:${character.id}`, character.prompt)}));
  context.style.bible = includedText('style:bible', context.style?.bible);
  context.style.referenceAssetIds = (context.style?.referenceAssetIds || [])
    .filter((assetId) => !hidden.has(`style-reference:${assetId}`));
  if (hidden.has('previous-still')) context.previousStill = null;
  return context;
};
