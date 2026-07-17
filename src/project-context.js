import {PROJECT_CONTEXT_SCHEMA_VERSION} from './project-store.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const clean = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const tokens = (value) => [...new Set(clean(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .split(' ')
  .filter((token) => token.length > 1))];

const tokenSet = (value) => new Set(tokens(value));

const limitValue = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(MAX_LIMIT, Math.max(1, parsed)) : DEFAULT_LIMIT;
};

const assetById = (project, id) => project.mediaAssets?.find((asset) => asset.id === id) || null;
const sceneById = (project, id) => project.scenes?.find((scene) => scene.id === id) || null;
const characterVersionById = (project, id) => {
  for (const character of project.characters || []) {
    const version = (character.versions || []).find((candidate) => candidate.id === id);
    if (version) return {character, version};
  }
  return null;
};

const derivedDescription = (clip, asset) => {
  const metadata = clip.provenance?.derivedMetadata || {};
  return clean(metadata.description || metadata.visionDescription || metadata.shotDescription)
    || clean(clip.provenance?.prompt)
    || clean(asset?.name)
    || 'Uncaptioned timeline clip';
};

export const describeClip = (project, clip) => {
  const asset = assetById(project, clip.assetId);
  const scene = sceneById(project, clip.sceneId);
  const characterNames = (clip.provenance?.characterVersionIds || [])
    .map((versionId) => characterVersionById(project, versionId)?.character?.name)
    .filter(Boolean);
  const description = derivedDescription(clip, asset);
  const contextParts = [
    scene?.name,
    asset?.name,
    description,
    characterNames.length ? `Characters: ${characterNames.join(', ')}` : '',
    clip.provenance?.modelId ? `Model: ${clip.provenance.modelId}` : '',
  ].filter(Boolean);
  return {
    description,
    text: contextParts.join('. '),
    characterNames,
  };
};

const clipEntry = (project, clip) => {
  const asset = assetById(project, clip.assetId);
  const scene = sceneById(project, clip.sceneId);
  const described = describeClip(project, clip);
  return {
    id: `clip:${clip.id}`,
    type: 'clip',
    clipId: clip.id,
    sceneId: clip.sceneId,
    trackId: clip.trackId,
    start: clip.start,
    duration: clip.duration,
    text: described.text,
    description: described.description,
    metadata: {
      sceneName: scene?.name || null,
      assetId: clip.assetId,
      assetName: asset?.name || null,
      assetKind: asset?.kind || null,
      prompt: clip.provenance?.prompt || null,
      modelId: clip.provenance?.modelId || null,
      seed: clip.provenance?.seed ?? null,
      params: clone(clip.provenance?.params || {}),
      parentAssetIds: [...(clip.provenance?.parentAssetIds || [])],
      characterVersionIds: [...(clip.provenance?.characterVersionIds || [])],
      characterNames: described.characterNames,
    },
  };
};

const sceneEntry = (scene) => ({
  id: `scene:${scene.id}`,
  type: 'scene',
  sceneId: scene.id,
  start: 0,
  duration: scene.duration,
  text: `${scene.name}. ${clean(scene.metadata?.description || '')}`.trim(),
  description: clean(scene.metadata?.description || scene.name),
  metadata: clone(scene.metadata || {}),
});

const characterEntry = (character) => ({
  id: `character:${character.id}`,
  type: 'character',
  characterId: character.id,
  text: `${character.name}. ${(character.versions || []).map((version) => version.prompt).filter(Boolean).join('. ')}`,
  description: character.name,
  metadata: {
    status: character.status,
    lockedVersionId: character.lockedVersionId,
    activeVersionId: character.activeVersionId,
  },
});

export const buildProjectContextIndex = (project, {now = () => new Date().toISOString()} = {}) => ({
  schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
  sourceRevision: project?.timeline?.revision || 0,
  generatedAt: now(),
  entries: [
    ...(project?.scenes || []).map(sceneEntry),
    ...(project?.timeline?.clips || []).map((clip) => clipEntry(project, clip)),
    ...(project?.characters || []).map(characterEntry),
  ],
});

const scoreEntry = (queryTokens, entry) => {
  const textTokens = tokenSet(entry.text);
  if (!queryTokens.length || !textTokens.size) return 0;
  const matches = queryTokens.filter((token) => textTokens.has(token)).length;
  const phraseBonus = clean(entry.text).toLowerCase().includes(queryTokens.join(' ')) ? 0.25 : 0;
  return matches / queryTokens.length + phraseBonus;
};

export const searchProjectContext = (index, query, {limit = DEFAULT_LIMIT, type = null} = {}) => {
  const normalizedQuery = clean(query);
  if (!normalizedQuery) return [];
  const queryTokens = tokens(normalizedQuery);
  return (Array.isArray(index?.entries) ? index.entries : [])
    .filter((entry) => !type || entry.type === type)
    .map((entry) => ({...clone(entry), score: scoreEntry(queryTokens, entry)}))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)))
    .slice(0, limitValue(limit));
};

export const createProjectContextService = ({getProject, dispatch, now = () => new Date().toISOString()} = {}) => {
  if (typeof getProject !== 'function') throw new TypeError('Project context requires a project reader.');
  let index = null;

  const rebuild = () => {
    const next = buildProjectContextIndex(getProject(), {now});
    index = clone(next);
    if (typeof dispatch === 'function') dispatch({type: 'context/index', index: next});
    return clone(next);
  };

  const current = () => {
    const project = getProject();
    const persisted = project.contextIndex;
    if (!index || !persisted || persisted.sourceRevision !== project.timeline.revision) return rebuild();
    return clone(index);
  };

  const search = (query, options = {}) => searchProjectContext(current(), query, options);

  return {
    getIndex: () => current(),
    rebuild,
    search,
  };
};
