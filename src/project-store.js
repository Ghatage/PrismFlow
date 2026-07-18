export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_STORAGE_KEY = 'prismflow.project';

const DEFAULT_TIMELINE_DURATION = 12;
const DEFAULT_TRACKS = [
  {id: 'V1', name: 'Video', kind: 'video', order: 0},
  {id: 'A1', name: 'Audio', kind: 'audio', order: 1},
];
const SECRET_KEY_PATTERN = /(api.?key|authorization|bearer|credential|password|secret|token)/i;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asString = (value, fallback = '') => typeof value === 'string' && value.trim() ? value : fallback;
const asNullableString = (value) => typeof value === 'string' && value.trim() ? value : null;
const asNumber = (value, fallback = 0, minimum = 0) => Number.isFinite(value) ? Math.max(minimum, value) : fallback;
const asTimestamp = (value, fallback) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
const normalizeStringIds = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((entry) => asString(entry))
  .filter(Boolean))];

const sanitizeJson = (value, depth = 0, seen = new WeakSet()) => {
  if (depth > 8 || value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return /^(blob:|data:)/i.test(value) ? undefined : value;
  if (typeof value !== 'object' || seen.has(value)) return undefined;

  seen.add(value);
  if (Array.isArray(value)) {
    const sanitized = value.map((entry) => sanitizeJson(entry, depth + 1, seen)).filter((entry) => entry !== undefined);
    seen.delete(value);
    return sanitized;
  }

  const sanitized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    const safeEntry = sanitizeJson(entry, depth + 1, seen);
    if (safeEntry !== undefined) sanitized[key] = safeEntry;
  }
  seen.delete(value);
  return sanitized;
};

const normalizeProvenance = (value) => {
  const provenance = isRecord(value) ? value : {};
  const seed = typeof provenance.seed === 'string' || Number.isFinite(provenance.seed) ? provenance.seed : null;
  const derivedMetadata = provenance.derivedMetadata || provenance.derived;
  return {
    prompt: asNullableString(provenance.prompt),
    modelId: asNullableString(provenance.modelId),
    seed,
    params: isRecord(provenance.params) ? sanitizeJson(provenance.params) || {} : {},
    parentAssetId: asNullableString(provenance.parentAssetId),
    derivedMetadata: isRecord(derivedMetadata) ? sanitizeJson(derivedMetadata) || {} : null,
    characterVersionIds: normalizeStringIds(provenance.characterVersionIds),
  };
};

const createDefaultProject = ({now, createId}) => {
  const timestamp = now();
  const sceneId = createId('scene');
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    updatedAt: timestamp,
    project: {
      id: createId('project'),
      name: 'Untitled story',
      createdAt: timestamp,
      metadata: {aspectRatio: '16:9', frameRate: 30},
    },
    scenes: [{id: sceneId, name: 'Opening scene', duration: DEFAULT_TIMELINE_DURATION, metadata: {}}],
    characters: [],
    mediaAssets: [],
    timeline: {
      activeSceneId: sceneId,
      duration: DEFAULT_TIMELINE_DURATION,
      tracks: DEFAULT_TRACKS.map((track) => ({...track})),
      clips: [],
    },
  };
};

const normalizeAsset = (value, {now, createId}) => {
  const asset = isRecord(value) ? value : {};
  const kind = ['image', 'audio', 'video'].includes(asset.kind) ? asset.kind : 'video';
  const source = isRecord(asset.source) ? asset.source : {};
  return {
    id: asString(asset.id, createId('media')),
    name: asString(asset.name, 'Untitled media'),
    kind,
    mimeType: asString(asset.mimeType || asset.type, 'application/octet-stream'),
    size: asNumber(asset.size),
    duration: asNumber(asset.duration, kind === 'image' ? 5 : 0),
    createdAt: asTimestamp(asset.createdAt, now()),
    source: {
      type: asString(source.type, 'local-file'),
      fileName: asString(source.fileName, asString(asset.name, 'Untitled media')),
      lastModified: asNumber(source.lastModified),
    },
    metadata: isRecord(asset.metadata) ? sanitizeJson(asset.metadata) || {} : {},
  };
};

const normalizeCharacterVersion = (value, {now, createId}) => {
  if (!isRecord(value)) return null;
  const seed = typeof value.seed === 'string' || Number.isFinite(value.seed) ? value.seed : null;
  return {
    id: asString(value.id, createId('character-version')),
    sheetAssetId: asString(value.sheetAssetId),
    referenceAssetIds: normalizeStringIds(value.referenceAssetIds),
    prompt: asString(value.prompt),
    modelId: asString(value.modelId, 'local/manual'),
    seed,
    params: isRecord(value.params) ? sanitizeJson(value.params) || {} : {},
    parentAssetIds: normalizeStringIds(value.parentAssetIds),
    createdAt: asTimestamp(value.createdAt, now()),
  };
};

const normalizeCharacter = (value, dependencies) => {
  if (!isRecord(value)) return null;
  const versions = (Array.isArray(value.versions) ? value.versions : [])
    .map((version) => normalizeCharacterVersion(version, dependencies))
    .filter(Boolean);
  const versionIds = new Set(versions.map((version) => version.id));
  const lockedVersionId = versionIds.has(value.lockedVersionId) ? value.lockedVersionId : null;
  const requestedActiveVersionId = versionIds.has(value.activeVersionId) ? value.activeVersionId : null;
  const activeVersionId = lockedVersionId || requestedActiveVersionId || versions.at(-1)?.id || null;
  const requestedStatus = ['draft', 'ready', 'failed'].includes(value.status) ? value.status : null;

  return {
    id: asString(value.id, dependencies.createId('character')),
    name: asString(value.name, 'Untitled character'),
    status: versions.length ? (requestedStatus === 'failed' ? 'failed' : 'ready') : (requestedStatus || 'draft'),
    lockedVersionId,
    activeVersionId,
    versions,
  };
};

const normalizeClip = (value, {assetIds, sceneIds, trackIds, createId}) => {
  if (!isRecord(value)) return null;
  const assetId = asString(value.assetId || value.mediaId);
  if (!assetIds.has(assetId)) return null;
  const sceneId = sceneIds.has(value.sceneId) ? value.sceneId : [...sceneIds][0];
  const trackId = trackIds.has(value.trackId) ? value.trackId : 'V1';
  return {
    id: asString(value.id, createId('clip')),
    assetId,
    sceneId,
    trackId,
    start: asNumber(value.start),
    duration: asNumber(value.duration, 5, 0.1),
    provenance: normalizeProvenance(value.provenance),
  };
};

const normalizeProject = (value, dependencies) => {
  if (!isRecord(value) || value.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    return createDefaultProject(dependencies);
  }

  const fallback = createDefaultProject(dependencies);
  const projectMetadata = isRecord(value.project) ? value.project : {};
  const scenes = (Array.isArray(value.scenes) ? value.scenes : []).filter(isRecord).map((scene, index) => ({
    id: asString(scene.id, dependencies.createId('scene')),
    name: asString(scene.name, `Scene ${String(index + 1).padStart(2, '0')}`),
    duration: asNumber(scene.duration, DEFAULT_TIMELINE_DURATION, 0.1),
    metadata: isRecord(scene.metadata) ? sanitizeJson(scene.metadata) || {} : {},
  }));
  if (!scenes.length) scenes.push(...fallback.scenes);

  const timeline = isRecord(value.timeline) ? value.timeline : {};
  const tracks = (Array.isArray(timeline.tracks) ? timeline.tracks : []).filter(isRecord).map((track, index) => ({
    id: asString(track.id, `T${index + 1}`),
    name: asString(track.name, `Track ${index + 1}`),
    kind: ['video', 'audio'].includes(track.kind) ? track.kind : 'video',
    order: asNumber(track.order, index),
  }));
  if (!tracks.some((track) => track.id === 'V1')) tracks.push({...DEFAULT_TRACKS[0]});
  if (!tracks.some((track) => track.id === 'A1')) tracks.push({...DEFAULT_TRACKS[1]});
  tracks.sort((left, right) => left.order - right.order);

  const mediaAssets = (Array.isArray(value.mediaAssets) ? value.mediaAssets : []).filter(isRecord)
    .map((asset) => normalizeAsset(asset, dependencies));
  const assetIds = new Set(mediaAssets.map((asset) => asset.id));
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const trackIds = new Set(tracks.map((track) => track.id));
  const clips = (Array.isArray(timeline.clips) ? timeline.clips : [])
    .map((clip) => normalizeClip(clip, {assetIds, sceneIds, trackIds, createId: dependencies.createId}))
    .filter(Boolean);
  const clipEnd = clips.reduce((maximum, clip) => Math.max(maximum, clip.start + clip.duration), 0);
  const duration = Math.max(DEFAULT_TIMELINE_DURATION, asNumber(timeline.duration, DEFAULT_TIMELINE_DURATION, 0.1), clipEnd);
  const activeSceneId = sceneIds.has(timeline.activeSceneId) ? timeline.activeSceneId : scenes[0].id;

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    updatedAt: asTimestamp(value.updatedAt, fallback.updatedAt),
    project: {
      id: asString(projectMetadata.id, fallback.project.id),
      name: asString(projectMetadata.name, fallback.project.name),
      createdAt: asTimestamp(projectMetadata.createdAt, fallback.project.createdAt),
      metadata: isRecord(projectMetadata.metadata) ? sanitizeJson(projectMetadata.metadata) || {} : fallback.project.metadata,
    },
    scenes,
    characters: (Array.isArray(value.characters) ? value.characters : [])
      .map((character) => normalizeCharacter(character, dependencies))
      .filter(Boolean),
    mediaAssets,
    timeline: {activeSceneId, duration, tracks, clips},
  };
};

const toPersistedProject = (project) => ({
  schemaVersion: PROJECT_SCHEMA_VERSION,
  updatedAt: project.updatedAt,
  project: sanitizeJson(project.project),
  scenes: sanitizeJson(project.scenes),
  characters: sanitizeJson(project.characters),
  mediaAssets: project.mediaAssets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    mimeType: asset.mimeType,
    size: asset.size,
    duration: asset.duration,
    createdAt: asset.createdAt,
    source: sanitizeJson(asset.source),
    metadata: sanitizeJson(asset.metadata),
  })),
  timeline: {
    activeSceneId: project.timeline.activeSceneId,
    duration: project.timeline.duration,
    tracks: sanitizeJson(project.timeline.tracks),
    clips: project.timeline.clips.map((clip) => ({
      id: clip.id,
      assetId: clip.assetId,
      sceneId: clip.sceneId,
      trackId: clip.trackId,
      start: clip.start,
      duration: clip.duration,
      provenance: normalizeProvenance(clip.provenance),
    })),
  },
});

const loadProject = (storage, dependencies) => {
  try {
    const raw = storage?.getItem(PROJECT_STORAGE_KEY);
    return normalizeProject(raw ? JSON.parse(raw) : null, dependencies);
  } catch {
    return createDefaultProject(dependencies);
  }
};

const saveProject = (storage, project) => {
  try {
    storage?.setItem(PROJECT_STORAGE_KEY, JSON.stringify(toPersistedProject(project)));
  } catch {
    // Persistence can be unavailable in private or quota-constrained browser contexts.
  }
};

const defaultCreateId = (prefix) => {
  const randomId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${randomId}`;
};

export const createProjectStore = ({
  storage = globalThis.localStorage,
  now = () => new Date().toISOString(),
  createId = defaultCreateId,
} = {}) => {
  const dependencies = {now, createId};
  const assetUrls = new Map();
  let project = loadProject(storage, dependencies);

  const getProject = () => {
    const snapshot = toPersistedProject(project);
    snapshot.mediaAssets = snapshot.mediaAssets.map((asset) => ({
      ...asset,
      url: assetUrls.get(asset.id) || null,
    }));
    return snapshot;
  };

  const commit = () => {
    project.updatedAt = now();
    saveProject(storage, project);
  };

  const extendTimeline = (clip) => {
    const duration = Math.max(project.timeline.duration, clip.start + clip.duration + 2);
    project.timeline.duration = duration;
    const activeScene = project.scenes.find((scene) => scene.id === clip.sceneId);
    if (activeScene) activeScene.duration = Math.max(activeScene.duration, duration);
  };

  const dispatch = (command) => {
    if (!isRecord(command)) throw new TypeError('Project commands must be objects.');
    let affectedId = null;
    let changed = false;

    if (command.type === 'asset/import') {
      const asset = normalizeAsset(command.asset, dependencies);
      if (typeof command.asset?.url === 'string' && command.asset.url.trim()) {
        assetUrls.set(asset.id, command.asset.url);
      }
      project.mediaAssets.push(asset);
      affectedId = asset.id;
      changed = true;
    } else if (command.type === 'asset/update') {
      const asset = project.mediaAssets.find((candidate) => candidate.id === command.assetId);
      if (asset && isRecord(command.patch)) {
        if (Number.isFinite(command.patch.duration)) asset.duration = asNumber(command.patch.duration, asset.duration);
        if (isRecord(command.patch.metadata)) asset.metadata = sanitizeJson({...asset.metadata, ...command.patch.metadata}) || {};
        affectedId = asset.id;
        changed = true;
      }
    } else if (command.type === 'asset/remove') {
      if (project.mediaAssets.some((asset) => asset.id === command.assetId)) {
        project.mediaAssets = project.mediaAssets.filter((asset) => asset.id !== command.assetId);
        project.timeline.clips = project.timeline.clips.filter((clip) => clip.assetId !== command.assetId);
        assetUrls.delete(command.assetId);
        affectedId = command.assetId;
        changed = true;
      }
    } else if (command.type === 'clip/add') {
      const asset = project.mediaAssets.find((candidate) => candidate.id === command.assetId);
      if (asset) {
        const requestedTrack = project.timeline.tracks.some((track) => track.id === command.trackId) ? command.trackId : 'V1';
        const trackId = asset.kind === 'audio' ? 'A1' : requestedTrack === 'A1' ? 'V1' : requestedTrack;
        const clip = {
          id: createId('clip'),
          assetId: asset.id,
          sceneId: project.timeline.activeSceneId,
          trackId,
          start: asNumber(command.start),
          duration: asNumber(command.duration, asset.kind === 'image' ? 5 : Math.max(0.1, asset.duration || 5), 0.1),
          provenance: normalizeProvenance(command.provenance),
        };
        project.timeline.clips.push(clip);
        extendTimeline(clip);
        affectedId = clip.id;
        changed = true;
      }
    } else if (command.type === 'clip/move') {
      const clip = project.timeline.clips.find((candidate) => candidate.id === command.clipId);
      if (clip) {
        const asset = project.mediaAssets.find((candidate) => candidate.id === clip.assetId);
        const requestedTrack = project.timeline.tracks.some((track) => track.id === command.trackId) ? command.trackId : clip.trackId;
        clip.start = asNumber(command.start, clip.start);
        clip.trackId = asset?.kind === 'audio' ? 'A1' : requestedTrack === 'A1' ? 'V1' : requestedTrack;
        extendTimeline(clip);
        affectedId = clip.id;
        changed = true;
      }
    } else if (command.type === 'clip/remove') {
      if (project.timeline.clips.some((clip) => clip.id === command.clipId)) {
        project.timeline.clips = project.timeline.clips.filter((clip) => clip.id !== command.clipId);
        affectedId = command.clipId;
        changed = true;
      }
    } else if (command.type === 'clip/character-attach') {
      const clip = project.timeline.clips.find((candidate) => candidate.id === command.clipId);
      const character = project.characters.find((candidate) => candidate.lockedVersionId === command.versionId);
      if (!clip) throw new Error('Timeline clip was not found.');
      if (!character) throw new Error('Only a currently locked character version can be attached.');
      if (!clip.provenance.characterVersionIds.includes(command.versionId)) {
        clip.provenance.characterVersionIds.push(command.versionId);
        affectedId = clip.id;
        changed = true;
      }
    } else if (command.type === 'clip/character-remove') {
      const clip = project.timeline.clips.find((candidate) => candidate.id === command.clipId);
      if (!clip) throw new Error('Timeline clip was not found.');
      if (clip.provenance.characterVersionIds.includes(command.versionId)) {
        clip.provenance.characterVersionIds = clip.provenance.characterVersionIds.filter((versionId) => versionId !== command.versionId);
        affectedId = clip.id;
        changed = true;
      }
    } else if (command.type === 'timeline/set-duration') {
      if (Number.isFinite(command.duration)) {
        project.timeline.duration = asNumber(command.duration, project.timeline.duration, 0.1);
        const activeScene = project.scenes.find((scene) => scene.id === project.timeline.activeSceneId);
        if (activeScene) activeScene.duration = project.timeline.duration;
        affectedId = project.timeline.activeSceneId;
        changed = true;
      }
    } else if (command.type === 'scene/update') {
      const scene = project.scenes.find((candidate) => candidate.id === command.sceneId);
      if (scene && isRecord(command.patch)) {
        scene.name = asString(command.patch.name, scene.name);
        if (Number.isFinite(command.patch.duration)) scene.duration = asNumber(command.patch.duration, scene.duration, 0.1);
        if (isRecord(command.patch.metadata)) scene.metadata = sanitizeJson({...scene.metadata, ...command.patch.metadata}) || {};
        affectedId = scene.id;
        changed = true;
      }
    } else if (command.type === 'character/create') {
      const character = normalizeCharacter({
        id: createId('character'),
        name: command.name,
        status: 'draft',
        versions: [],
      }, dependencies);
      project.characters.push(character);
      affectedId = character.id;
      changed = true;
    } else if (command.type === 'character/rename') {
      const character = project.characters.find((candidate) => candidate.id === command.characterId);
      const name = asString(command.name);
      if (character && name) {
        character.name = name;
        affectedId = character.id;
        changed = true;
      }
    } else if (command.type === 'character/status') {
      const character = project.characters.find((candidate) => candidate.id === command.characterId);
      if (character && ['draft', 'ready', 'failed'].includes(command.status)) {
        character.status = command.status;
        affectedId = character.id;
        changed = true;
      }
    } else if (command.type === 'character/version-record') {
      const character = project.characters.find((candidate) => candidate.id === command.characterId);
      if (character) {
        const version = normalizeCharacterVersion({
          ...command.version,
          id: command.version?.id || createId('character-version'),
        }, dependencies);
        if (!version.sheetAssetId || !project.mediaAssets.some((asset) => asset.id === version.sheetAssetId)) {
          throw new Error('A character version must reference an existing sheet asset.');
        }
        if (character.versions.some((candidate) => candidate.id === version.id)) {
          throw new Error(`Character version already exists: ${version.id}`);
        }
        character.versions.push(version);
        character.status = 'ready';
        if (!character.lockedVersionId) character.activeVersionId = version.id;
        affectedId = version.id;
        changed = true;
      }
    } else if (command.type === 'character/version-activate') {
      const character = project.characters.find((candidate) => candidate.id === command.characterId);
      if (character && !character.lockedVersionId && character.versions.some((version) => version.id === command.versionId)) {
        character.activeVersionId = command.versionId;
        affectedId = character.id;
        changed = true;
      }
    } else if (command.type === 'character/lock') {
      const character = project.characters.find((candidate) => candidate.id === command.characterId);
      if (character && character.versions.some((version) => version.id === command.versionId)) {
        character.lockedVersionId = command.versionId;
        character.activeVersionId = command.versionId;
        affectedId = character.id;
        changed = true;
      }
    } else if (command.type === 'character/unlock') {
      const character = project.characters.find((candidate) => candidate.id === command.characterId);
      if (character && character.lockedVersionId) {
        character.lockedVersionId = null;
        character.activeVersionId = character.versions.at(-1)?.id || null;
        affectedId = character.id;
        changed = true;
      }
    } else {
      throw new Error(`Unknown project command: ${String(command.type)}`);
    }

    if (changed) commit();
    return {project: getProject(), affectedId, changed};
  };

  saveProject(storage, project);
  return {getProject, dispatch};
};
