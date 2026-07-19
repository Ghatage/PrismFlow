const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const clean = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const tokens = (value) => [...new Set(clean(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .split(' ')
  .filter((token) => token.length > 1))];

const limitValue = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(MAX_LIMIT, Math.max(1, parsed)) : DEFAULT_LIMIT;
};

const readableStrings = (value, output = []) => {
  if (typeof value === 'string') {
    const text = clean(value);
    if (text && !/^(?:blob:|data:|https?:\/\/)/i.test(text)) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => readableStrings(entry, output));
    return output;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => readableStrings(entry, output));
  }
  return output;
};

const addSource = (sources, label, value, weight = 1) => {
  const text = clean(value);
  if (text) sources.push({label, text, weight});
};

export const buildMediaSearchDocuments = (project) => {
  const assets = Array.isArray(project?.mediaAssets) ? project.mediaAssets : [];
  const documents = new Map(assets.map((asset) => [asset.id, {
    asset,
    sources: [],
  }]));

  for (const document of documents.values()) {
    const {asset, sources} = document;
    addSource(sources, 'Import name', asset.name, 5);
    addSource(sources, 'File name', asset.source?.fileName, 4);
    addSource(sources, 'Media type', `${asset.kind || ''} ${asset.mimeType || ''}`, 1);
    readableStrings(asset.metadata).forEach((text) => addSource(sources, 'Metadata', text, 2));
  }

  for (const clip of project?.timeline?.clips || []) {
    const sources = documents.get(clip.assetId)?.sources;
    if (!sources) continue;
    addSource(sources, 'Generation prompt', clip.provenance?.prompt, 5);
    readableStrings(clip.provenance?.derivedMetadata).forEach((text) => addSource(sources, 'Clip description', text, 4));
    readableStrings(clip.provenance?.params).forEach((text) => addSource(sources, 'Generation settings', text, 1));
  }

  for (const diff of project?.timelineDiffs?.items || []) {
    for (const operation of diff.operations || []) {
      const candidate = operation.proposedClip || operation.after;
      const sources = documents.get(candidate?.assetId)?.sources;
      if (!sources) continue;
      addSource(sources, 'Pending generation prompt', candidate.provenance?.prompt || diff.provenance?.prompt, 5);
      addSource(sources, 'Review proposal', diff.summary, 2);
      readableStrings(candidate.provenance?.derivedMetadata || diff.provenance?.derivedMetadata)
        .forEach((text) => addSource(sources, 'Pending clip description', text, 4));
    }
  }

  for (const batch of project?.styleApplications?.batches || []) {
    for (const job of batch.jobs || []) {
      const sources = documents.get(job.outputAssetId)?.sources;
      if (!sources) continue;
      addSource(sources, 'Style application', `${batch.styleName || ''}. ${batch.instruction || ''}`, 3);
      addSource(sources, 'Source prompt', job.sourceClip?.provenance?.prompt, 4);
    }
  }

  for (const act of (project?.storyboard?.nodes || []).filter((node) => node?.kind === 'act')) {
    for (const beat of act.beats || []) {
      const linkedAssetIds = new Set([
        beat.hero?.assetId,
        ...(beat.stills || []).map((still) => still?.assetId),
      ].filter(Boolean));
      for (const assetId of linkedAssetIds) {
        const sources = documents.get(assetId)?.sources;
        if (!sources) continue;
        addSource(sources, 'Story beat', beat.text, 5);
        addSource(sources, 'Screenplay', beat.screenplay?.text, 4);
        addSource(sources, 'Video prompt', beat.videoPrompt?.text, 4);
        (beat.stills || [])
          .filter((still) => still?.assetId === assetId)
          .forEach((still) => addSource(sources, 'Still prompt', still.prompt, 5));
      }
    }
  }

  for (const character of project?.characters || []) {
    for (const version of character.versions || []) {
      const sources = documents.get(version.sheetAssetId)?.sources;
      if (!sources) continue;
      addSource(sources, 'Character', character.name, 4);
      addSource(sources, 'Character prompt', version.prompt, 4);
    }
  }

  for (const style of project?.styles || []) {
    for (const version of style.versions || []) {
      for (const assetId of version.referenceAssetIds || []) {
        const sources = documents.get(assetId)?.sources;
        if (!sources) continue;
        addSource(sources, 'Style', style.name, 3);
        addSource(sources, 'Style prompt', version.prompt, 3);
      }
    }
  }

  return [...documents.values()];
};

const scoreSource = (query, queryTokens, source) => {
  const normalizedText = source.text.toLowerCase();
  const textTokens = new Set(tokens(source.text));
  const matchedTokens = queryTokens.filter((token) => textTokens.has(token)).length;
  if (!matchedTokens) return 0;
  const coverage = matchedTokens / queryTokens.length;
  if (queryTokens.length > 1 && coverage < 0.6) return 0;
  const phraseBonus = normalizedText.includes(query) ? 1 : 0;
  return (coverage + phraseBonus) * source.weight;
};

export const searchMediaAssets = (project, query, {assetIds = null, limit = DEFAULT_LIMIT} = {}) => {
  const normalizedQuery = clean(query).toLowerCase();
  const queryTokens = tokens(normalizedQuery);
  if (!normalizedQuery || !queryTokens.length) return [];
  return buildMediaSearchDocuments(project)
    .filter(({asset}) => !assetIds || assetIds.has(asset.id))
    .map(({asset, sources}) => {
      const rankedSources = sources
        .map((source) => ({...source, score: scoreSource(normalizedQuery, queryTokens, source)}))
        .filter((source) => source.score > 0)
        .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
      const best = rankedSources[0];
      return best ? {
        id: `media:${asset.id}`,
        assetId: asset.id,
        name: asset.name,
        kind: asset.kind,
        score: best.score + rankedSources.slice(1).reduce((total, source) => total + source.score * 0.1, 0),
        matchLabel: best.label,
        matchText: best.text,
      } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limitValue(limit));
};
