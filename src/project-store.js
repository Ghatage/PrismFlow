export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_STORAGE_KEY = 'prismflow.project';
export const TIMELINE_DIFF_SCHEMA_VERSION = 1;
export const PROJECT_CONTEXT_SCHEMA_VERSION = 1;

const DEFAULT_TIMELINE_DURATION = 12;
const DEFAULT_TRACKS = [
  {id: 'V1', name: 'Video', kind: 'video', order: 0},
  {id: 'A1', name: 'Audio', kind: 'audio', order: 1},
];
const SECRET_KEY_PATTERN = /(api.?key|authorization|bearer|credential|password|secret|token)/i;
const TIMELINE_DIFF_OPERATION_TYPES = new Set(['add', 'move', 'trim', 'replace', 'remove']);
const TIMELINE_DIFF_STATUSES = new Set(['pending', 'accepted', 'rejected', 'stale']);
const TIMELINE_DIFF_SOURCES = new Set(['agent', 'generation', 'user']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asString = (value, fallback = '') => typeof value === 'string' && value.trim() ? value : fallback;
const asNullableString = (value) => typeof value === 'string' && value.trim() ? value : null;
const asRemoteUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
const asNumber = (value, fallback = 0, minimum = 0) => Number.isFinite(value) ? Math.max(minimum, value) : fallback;
const asTimestamp = (value, fallback) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
const normalizeStringIds = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((entry) => asString(entry))
  .filter(Boolean))];

const sanitizeJson = (value, depth = 0, seen = new WeakSet()) => {
  if (depth > 16 || value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
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
  const parentAssetIds = normalizeStringIds(provenance.parentAssetIds);
  const parentAssetId = asNullableString(provenance.parentAssetId) || parentAssetIds[0] || null;
  if (parentAssetId && !parentAssetIds.includes(parentAssetId)) parentAssetIds.unshift(parentAssetId);
  return {
    prompt: asNullableString(provenance.prompt),
    modelId: asNullableString(provenance.modelId),
    seed,
    params: isRecord(provenance.params) ? sanitizeJson(provenance.params) || {} : {},
    parentAssetId,
    parentAssetIds,
    derivedMetadata: isRecord(derivedMetadata) ? sanitizeJson(derivedMetadata) || {} : null,
    characterVersionIds: normalizeStringIds(provenance.characterVersionIds),
  };
};

const mergeProvenance = (current, proposed) => {
  const before = normalizeProvenance(current);
  if (!isRecord(proposed)) return before;
  return normalizeProvenance({
    ...before,
    ...proposed,
    params: isRecord(proposed.params) ? proposed.params : before.params,
    derivedMetadata: proposed.derivedMetadata === undefined && proposed.derived === undefined
      ? before.derivedMetadata
      : proposed.derivedMetadata || proposed.derived,
    characterVersionIds: Array.isArray(proposed.characterVersionIds)
      ? proposed.characterVersionIds
      : before.characterVersionIds,
  });
};

const cloneJson = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

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
    contextIndex: {schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION, sourceRevision: 0, generatedAt: timestamp, entries: []},
    mediaAssets: [],
    timeline: {
      revision: 0,
      activeSceneId: sceneId,
      duration: DEFAULT_TIMELINE_DURATION,
      tracks: DEFAULT_TRACKS.map((track) => ({...track})),
      clips: [],
    },
    timelineDiffs: {schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION, items: []},
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
    remoteUrl: asRemoteUrl(asset.remoteUrl || asset.url),
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
    sourceStart: asNumber(value.sourceStart),
    provenance: normalizeProvenance(value.provenance),
  };
};

const normalizeProposedClip = (value, context, {clipId, currentClip = null} = {}) => {
  if (!isRecord(value)) throw new Error('Timeline diff clips must be objects.');
  const assetId = asString(value.assetId || value.mediaId, currentClip?.assetId);
  if (!context.assetIds.has(assetId)) throw new Error(`Timeline diff references a missing asset: ${assetId || 'unknown'}`);
  const sceneId = value.sceneId === undefined
    ? currentClip?.sceneId || context.activeSceneId
    : value.sceneId;
  const trackId = value.trackId === undefined ? currentClip?.trackId || 'V1' : value.trackId;
  if (!context.sceneIds.has(sceneId)) throw new Error(`Timeline diff references a missing scene: ${String(sceneId)}`);
  if (!context.trackIds.has(trackId)) throw new Error(`Timeline diff references a missing track: ${String(trackId)}`);
  const duration = value.duration === undefined ? currentClip?.duration ?? 5 : value.duration;
  if (!Number.isFinite(duration) || duration < 0.1) throw new Error('Timeline diff clip duration must be at least 0.1 seconds.');
  const start = value.start === undefined ? currentClip?.start ?? 0 : value.start;
  if (!Number.isFinite(start) || start < 0) throw new Error('Timeline diff clip start must be a non-negative number.');
  const sourceStart = value.sourceStart === undefined ? currentClip?.sourceStart ?? 0 : value.sourceStart;
  if (!Number.isFinite(sourceStart) || sourceStart < 0) throw new Error('Timeline diff clip source start must be a non-negative number.');
  return {
    id: asString(clipId || value.id, currentClip?.id),
    assetId,
    sceneId,
    trackId,
    start,
    duration,
    sourceStart,
    provenance: mergeProvenance(currentClip?.provenance, value.provenance),
  };
};

const normalizeTimelineDiffOperation = (value, context) => {
  if (!isRecord(value) || !TIMELINE_DIFF_OPERATION_TYPES.has(value.type)) {
    throw new Error(`Unknown timeline diff operation: ${String(value?.type)}`);
  }

  const requestedClipId = asString(value.clipId || value.proposedClip?.id || value.after?.id);
  const currentClip = context.clips.find((clip) => clip.id === requestedClipId) || null;
  if (value.type !== 'add' && !currentClip) {
    throw new Error(`Timeline diff target clip was not found: ${requestedClipId || 'unknown'}`);
  }

  if (value.type === 'add') {
    const clipId = requestedClipId || context.createId('clip');
    if (context.clips.some((clip) => clip.id === clipId)) throw new Error(`Timeline clip already exists: ${clipId}`);
    const after = normalizeProposedClip(value.proposedClip || value.after, context, {clipId});
    context.clips.push(after);
    return {type: value.type, clipId, proposedClip: cloneJson(after), before: null, after: cloneJson(after)};
  }

  const before = cloneJson(currentClip);
  if (value.type === 'remove') {
    context.clips = context.clips.filter((clip) => clip.id !== requestedClipId);
    return {type: value.type, clipId: requestedClipId, proposedClip: null, before, after: null};
  }

  let after;
  if (value.type === 'move') {
    const patch = isRecord(value.after) ? value.after : value;
    if (!Number.isFinite(patch.start) && patch.trackId === undefined) {
      throw new Error('Move operations require a start or track destination.');
    }
    after = normalizeProposedClip({
      ...currentClip,
      start: patch.start === undefined ? currentClip.start : patch.start,
      trackId: patch.trackId === undefined ? currentClip.trackId : patch.trackId,
      provenance: currentClip.provenance,
    }, context, {clipId: requestedClipId, currentClip});
  } else if (value.type === 'trim') {
    const patch = isRecord(value.after) ? value.after : value;
    if (!Number.isFinite(patch.duration)) throw new Error('Trim operations require a duration.');
    after = normalizeProposedClip({
      ...currentClip,
      start: patch.start === undefined ? currentClip.start : patch.start,
      duration: patch.duration,
      provenance: currentClip.provenance,
    }, context, {clipId: requestedClipId, currentClip});
  } else {
    after = normalizeProposedClip(value.proposedClip || value.after, context, {
      clipId: requestedClipId,
      currentClip,
    });
  }

  const index = context.clips.findIndex((clip) => clip.id === requestedClipId);
  context.clips[index] = after;
  return {
    type: value.type,
    clipId: requestedClipId,
    proposedClip: value.type === 'replace' ? cloneJson(after) : null,
    before,
    after: cloneJson(after),
  };
};

const normalizeTimelineDiff = (value, context, {strict = false} = {}) => {
  if (!isRecord(value)) {
    if (strict) throw new Error('Timeline diffs must be objects.');
    return null;
  }
  try {
    const baseRevision = Number.isInteger(value.baseRevision) && value.baseRevision >= 0
      ? value.baseRevision
      : context.revision;
    if (baseRevision > context.revision) throw new Error('Timeline diff base revision cannot be newer than the accepted timeline.');
    const operations = Array.isArray(value.operations) ? value.operations : [];
    if (!operations.length) throw new Error('Timeline diffs require at least one operation.');
    const operationContext = {...context, clips: context.clips.map(cloneJson)};
    const normalizedOperations = operations.map((operation) => normalizeTimelineDiffOperation(operation, operationContext));
    const requestedStatus = TIMELINE_DIFF_STATUSES.has(value.status) ? value.status : 'pending';
    const status = requestedStatus === 'pending' && baseRevision !== context.revision ? 'stale' : requestedStatus;
    const createdAt = asTimestamp(value.createdAt, context.now());
    return {
      id: asString(value.id, context.createId('timeline-diff')),
      baseRevision,
      status,
      source: TIMELINE_DIFF_SOURCES.has(value.source) ? value.source : 'agent',
      summary: asString(value.summary, `${normalizedOperations.length} proposed timeline ${normalizedOperations.length === 1 ? 'change' : 'changes'}`),
      operations: normalizedOperations,
      provenance: isRecord(value.provenance) ? sanitizeJson(value.provenance) || {} : {},
      createdAt,
      updatedAt: asTimestamp(value.updatedAt, createdAt),
    };
  } catch (error) {
    if (strict) throw error;
    return null;
  }
};

const restoreTimelineDiff = (value, context) => {
  if (!isRecord(value) || !Array.isArray(value.operations) || !value.operations.length) return null;
  const baseRevision = Number.isInteger(value.baseRevision) && value.baseRevision >= 0 ? value.baseRevision : null;
  if (baseRevision === null || baseRevision > context.revision) return null;
  const operations = value.operations.map((operation) => {
    if (!isRecord(operation) || !TIMELINE_DIFF_OPERATION_TYPES.has(operation.type)) return null;
    const clipId = asString(operation.clipId || operation.after?.id || operation.before?.id);
    if (!clipId) return null;
    const restoreClip = (clip) => {
      if (!isRecord(clip)) return null;
      const restored = sanitizeJson(clip) || {};
      restored.id = asString(restored.id, clipId);
      restored.provenance = normalizeProvenance(restored.provenance);
      return restored;
    };
    const before = restoreClip(operation.before);
    const after = restoreClip(operation.after || operation.proposedClip);
    return {
      type: operation.type,
      clipId,
      proposedClip: operation.type === 'add' || operation.type === 'replace' ? cloneJson(after) : null,
      before,
      after,
    };
  });
  if (operations.some((operation) => !operation)) return null;
  const requestedStatus = TIMELINE_DIFF_STATUSES.has(value.status) ? value.status : 'pending';
  const createdAt = asTimestamp(value.createdAt, context.now());
  return {
    id: asString(value.id, context.createId('timeline-diff')),
    baseRevision,
    status: requestedStatus === 'pending' && baseRevision !== context.revision ? 'stale' : requestedStatus,
    source: TIMELINE_DIFF_SOURCES.has(value.source) ? value.source : 'agent',
    summary: asString(value.summary, `${operations.length} proposed timeline ${operations.length === 1 ? 'change' : 'changes'}`),
    operations,
    provenance: isRecord(value.provenance) ? sanitizeJson(value.provenance) || {} : {},
    createdAt,
    updatedAt: asTimestamp(value.updatedAt, createdAt),
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
  const revision = Number.isInteger(timeline.revision) && timeline.revision >= 0 ? timeline.revision : 0;
  const timelineDiffCollection = isRecord(value.timelineDiffs) && value.timelineDiffs.schemaVersion === TIMELINE_DIFF_SCHEMA_VERSION
    ? value.timelineDiffs
    : {items: []};
  const diffContext = {
    revision,
    now: dependencies.now,
    createId: dependencies.createId,
  };
  const timelineDiffs = (Array.isArray(timelineDiffCollection.items) ? timelineDiffCollection.items : [])
    .map((diff) => restoreTimelineDiff(diff, diffContext))
    .filter(Boolean);
  const contextIndex = isRecord(value.contextIndex) && value.contextIndex.schemaVersion === PROJECT_CONTEXT_SCHEMA_VERSION
    ? {
      schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
      sourceRevision: Number.isInteger(value.contextIndex.sourceRevision) ? Math.max(0, value.contextIndex.sourceRevision) : revision,
      generatedAt: asTimestamp(value.contextIndex.generatedAt, fallback.updatedAt),
      entries: Array.isArray(value.contextIndex.entries) ? sanitizeJson(value.contextIndex.entries) || [] : [],
    }
    : {
      ...fallback.contextIndex,
      sourceRevision: revision,
    };

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
    contextIndex,
    mediaAssets,
    timeline: {revision, activeSceneId, duration, tracks, clips},
    timelineDiffs: {schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION, items: timelineDiffs},
  };
};

const toPersistedProject = (project) => ({
  schemaVersion: PROJECT_SCHEMA_VERSION,
  updatedAt: project.updatedAt,
  project: sanitizeJson(project.project),
  scenes: sanitizeJson(project.scenes),
  characters: sanitizeJson(project.characters),
  contextIndex: {
    schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
    sourceRevision: project.contextIndex?.sourceRevision || 0,
    generatedAt: project.contextIndex?.generatedAt,
    entries: sanitizeJson(project.contextIndex?.entries || []),
  },
  mediaAssets: project.mediaAssets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    mimeType: asset.mimeType,
    size: asset.size,
    duration: asset.duration,
    remoteUrl: asset.remoteUrl,
    createdAt: asset.createdAt,
    source: sanitizeJson(asset.source),
    metadata: sanitizeJson(asset.metadata),
  })),
  timeline: {
    revision: project.timeline.revision,
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
      sourceStart: clip.sourceStart,
      provenance: normalizeProvenance(clip.provenance),
    })),
  },
  timelineDiffs: {
    schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION,
    items: sanitizeJson(project.timelineDiffs.items),
  },
});

const loadProject = (storage, dependencies, initialProject = null) => {
  if (initialProject) return normalizeProject(initialProject, dependencies);
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
  initialProject = null,
  onCommit = null,
} = {}) => {
  const dependencies = {now, createId};
  const assetUrls = new Map();
  let project = loadProject(storage, dependencies, initialProject);

  const getProject = () => {
    const snapshot = toPersistedProject(project);
    snapshot.mediaAssets = snapshot.mediaAssets.map((asset) => ({
      ...asset,
      url: assetUrls.get(asset.id) || asset.remoteUrl || null,
    }));
    return snapshot;
  };

  const commit = () => {
    project.updatedAt = now();
    saveProject(storage, project);
    try {
      const result = onCommit?.(toPersistedProject(project));
      result?.catch?.(() => {});
    } catch {
      // Persistence can be unavailable in private or quota-constrained browser contexts.
    }
  };

  const extendTimeline = (clip) => {
    const duration = Math.max(project.timeline.duration, clip.start + clip.duration + 2);
    project.timeline.duration = duration;
    const activeScene = project.scenes.find((scene) => scene.id === clip.sceneId);
    if (activeScene) activeScene.duration = Math.max(activeScene.duration, duration);
  };

  const timelineDiffContext = () => ({
    revision: project.timeline.revision,
    clips: project.timeline.clips,
    assetIds: new Set(project.mediaAssets.map((asset) => asset.id)),
    sceneIds: new Set(project.scenes.map((scene) => scene.id)),
    trackIds: new Set(project.timeline.tracks.map((track) => track.id)),
    activeSceneId: project.timeline.activeSceneId,
    now,
    createId,
  });

  const markPendingDiffsStale = (timestamp, diffIds = null) => {
    const requestedIds = diffIds ? new Set(diffIds) : null;
    let changed = false;
    project.timelineDiffs.items.forEach((diff) => {
      const shouldMark = diff.status === 'pending'
        && (requestedIds ? requestedIds.has(diff.id) : diff.baseRevision !== project.timeline.revision);
      if (shouldMark) {
        diff.status = 'stale';
        diff.updatedAt = timestamp;
        changed = true;
      }
    });
    return changed;
  };

  const advanceTimelineRevision = (timestamp) => {
    project.timeline.revision += 1;
    markPendingDiffsStale(timestamp);
  };

  const applyTimelineDiff = (diff, clips = project.timeline.clips) => {
    const context = {...timelineDiffContext(), clips: clips.map(cloneJson)};
    diff.operations.forEach((operation) => normalizeTimelineDiffOperation(operation, context));
    return context.clips;
  };

  const rebaseConflictsFor = (diff) => {
    const conflicts = [];
    const acceptedClip = (clipId) => project.timeline.clips.find((clip) => clip.id === clipId) || null;
    const conflict = (operationIndex, operation, code, message, expected, actual) => {
      conflicts.push({
        diffId: diff.id,
        operationIndex,
        type: operation.type,
        code,
        message,
        expected: cloneJson(expected),
        actual: cloneJson(actual),
      });
    };
    const beforeFor = (operation) => operation.before || operation.after || operation.proposedClip || null;
    const sameIdentityAndAsset = (current, before) => Boolean(current && before)
      && current.id === before.id
      && current.assetId === before.assetId;
    const samePlacement = (current, before) => sameIdentityAndAsset(current, before)
      && current.sceneId === before.sceneId
      && current.trackId === before.trackId
      && current.start === before.start
      && current.duration === before.duration;

    diff.operations.forEach((operation, operationIndex) => {
      const before = beforeFor(operation);
      const proposed = operation.after || operation.proposedClip || null;
      const sourceAssetId = before?.assetId;
      const proposedAssetId = proposed?.assetId;
      if (sourceAssetId && !project.mediaAssets.some((asset) => asset.id === sourceAssetId)) {
        conflict(operationIndex, operation, 'missing-source-asset', `Source asset ${sourceAssetId} is no longer available.`, sourceAssetId, null);
      }
      if (proposedAssetId && !project.mediaAssets.some((asset) => asset.id === proposedAssetId)) {
        conflict(operationIndex, operation, 'missing-proposed-asset', `Proposed asset ${proposedAssetId} is no longer available.`, proposedAssetId, null);
      }

      if (operation.type === 'add') {
        const clipId = operation.clipId || proposed?.id;
        if (clipId && acceptedClip(clipId)) {
          conflict(operationIndex, operation, 'clip-id-used', `Proposed clip ${clipId} is already present in the accepted timeline.`, null, acceptedClip(clipId));
        }
        return;
      }

      const current = acceptedClip(operation.clipId);
      if (!current) {
        conflict(operationIndex, operation, 'target-clip-missing', `Target clip ${operation.clipId} is no longer present.`, before, null);
        return;
      }
      if (!sameIdentityAndAsset(current, before)) {
        conflict(operationIndex, operation, 'target-identity-changed', `Target clip ${operation.clipId} no longer matches the proposal source.`, before, current);
        return;
      }
      if ((operation.type === 'move' || operation.type === 'trim') && !samePlacement(current, before)) {
        conflict(operationIndex, operation, 'target-changed-concurrently', `Target clip ${operation.clipId} moved or changed while this proposal was waiting.`, before, current);
      }
    });
    return conflicts;
  };

  const existingRebaseFor = (diffId) => project.timelineDiffs.items.find((candidate) =>
    candidate.provenance?.reconciliation?.rebasedFromDiffId === diffId);

  const dispatch = (command) => {
    if (!isRecord(command)) throw new TypeError('Project commands must be objects.');
    let affectedId = null;
    let changed = false;
    let acceptedTimelineChanged = false;
    let conflicts = [];

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
        const removedAcceptedClips = project.timeline.clips.some((clip) => clip.assetId === command.assetId);
        project.mediaAssets = project.mediaAssets.filter((asset) => asset.id !== command.assetId);
        project.timeline.clips = project.timeline.clips.filter((clip) => clip.assetId !== command.assetId);
        assetUrls.delete(command.assetId);
        affectedId = command.assetId;
        changed = true;
        acceptedTimelineChanged = removedAcceptedClips;
      }
    } else if (command.type === 'track/add') {
      const kind = command.kind === 'audio' ? 'audio' : command.kind === 'video' ? 'video' : null;
      if (kind) {
        const prefix = kind === 'video' ? 'V' : 'A';
        const numbers = project.timeline.tracks
          .filter((track) => track.kind === kind)
          .map((track) => Number.parseInt(track.id.slice(1), 10))
          .filter(Number.isFinite);
        const number = Math.max(0, ...numbers) + 1;
        const track = {
          id: `${prefix}${number}`,
          name: `${kind[0].toUpperCase()}${kind.slice(1)} ${number}`,
          kind,
          order: 0,
        };
        const firstKindIndex = project.timeline.tracks.findIndex((candidate) => candidate.kind === kind);
        const lastKindIndex = project.timeline.tracks.reduce((lastIndex, candidate, index) => candidate.kind === kind ? index : lastIndex, -1);
        const insertionIndex = kind === 'video'
          ? (firstKindIndex >= 0 ? firstKindIndex : 0)
          : (lastKindIndex >= 0 ? lastKindIndex + 1 : project.timeline.tracks.length);
        project.timeline.tracks.splice(insertionIndex, 0, track);
        project.timeline.tracks.forEach((candidate, index) => { candidate.order = index; });
        affectedId = track.id;
        changed = true;
      }
    } else if (command.type === 'clip/add') {
      const asset = project.mediaAssets.find((candidate) => candidate.id === command.assetId);
      if (asset) {
        const preferredKind = asset.kind === 'audio' ? 'audio' : 'video';
        const requestedTrack = project.timeline.tracks.find((track) => track.id === command.trackId);
        const fallbackTrack = project.timeline.tracks.find((track) => track.kind === preferredKind) || project.timeline.tracks[0];
        const trackId = requestedTrack?.kind === preferredKind ? requestedTrack.id : fallbackTrack.id;
        const clip = {
          id: createId('clip'),
          assetId: asset.id,
          sceneId: project.timeline.activeSceneId,
          trackId,
          start: asNumber(command.start),
          duration: asNumber(command.duration, asset.kind === 'image' ? 5 : Math.max(0.1, asset.duration || 5), 0.1),
          sourceStart: asNumber(command.sourceStart),
          provenance: normalizeProvenance(command.provenance),
        };
        project.timeline.clips.push(clip);
        extendTimeline(clip);
        affectedId = clip.id;
        changed = true;
        acceptedTimelineChanged = true;
      }
    } else if (command.type === 'clip/move') {
      const clip = project.timeline.clips.find((candidate) => candidate.id === command.clipId);
      if (clip) {
        const asset = project.mediaAssets.find((candidate) => candidate.id === clip.assetId);
        const requestedTrack = project.timeline.tracks.find((track) => track.id === command.trackId);
        const fallbackTrack = project.timeline.tracks.find((track) => track.kind === (asset?.kind === 'audio' ? 'audio' : 'video'));
        clip.start = asNumber(command.start, clip.start);
        clip.trackId = requestedTrack?.kind === (asset?.kind === 'audio' ? 'audio' : 'video')
          ? requestedTrack.id
          : fallbackTrack?.id || clip.trackId;
        extendTimeline(clip);
        affectedId = clip.id;
        changed = true;
        acceptedTimelineChanged = true;
      }
    } else if (command.type === 'clip/trim') {
      const clip = project.timeline.clips.find((candidate) => candidate.id === command.clipId);
      if (clip && (command.edge === 'left' || command.edge === 'right')) {
        const minimumDuration = 0.1;
        const originalEnd = clip.start + clip.duration;
        if (command.edge === 'left') {
          const nextStart = Math.min(Math.max(0, asNumber(command.start, clip.start)), originalEnd - minimumDuration);
          clip.sourceStart = Math.max(0, (clip.sourceStart || 0) + nextStart - clip.start);
          clip.start = nextStart;
          clip.duration = Math.max(minimumDuration, originalEnd - nextStart);
        } else {
          clip.duration = Math.max(minimumDuration, asNumber(command.duration, clip.duration, minimumDuration));
        }
        extendTimeline(clip);
        affectedId = clip.id;
        changed = true;
        acceptedTimelineChanged = true;
      }
    } else if (command.type === 'clip/split') {
      const clip = project.timeline.clips.find((candidate) => candidate.id === command.clipId);
      if (clip) {
        const minimumDuration = 0.1;
        const splitTime = asNumber(command.time, clip.start);
        const originalEnd = clip.start + clip.duration;
        if (splitTime > clip.start + minimumDuration && splitTime < originalEnd - minimumDuration) {
          const firstDuration = splitTime - clip.start;
          const secondClip = {
            ...clip,
            id: createId('clip'),
            start: splitTime,
            duration: originalEnd - splitTime,
            sourceStart: (clip.sourceStart || 0) + firstDuration,
            provenance: normalizeProvenance(clip.provenance),
          };
          clip.duration = firstDuration;
          project.timeline.clips.push(secondClip);
          affectedId = secondClip.id;
          changed = true;
          acceptedTimelineChanged = true;
        }
      }
    } else if (command.type === 'clip/remove') {
      if (project.timeline.clips.some((clip) => clip.id === command.clipId)) {
        project.timeline.clips = project.timeline.clips.filter((clip) => clip.id !== command.clipId);
        affectedId = command.clipId;
        changed = true;
        acceptedTimelineChanged = true;
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
        acceptedTimelineChanged = true;
      }
    } else if (command.type === 'clip/character-remove') {
      const clip = project.timeline.clips.find((candidate) => candidate.id === command.clipId);
      if (!clip) throw new Error('Timeline clip was not found.');
      if (clip.provenance.characterVersionIds.includes(command.versionId)) {
        clip.provenance.characterVersionIds = clip.provenance.characterVersionIds.filter((versionId) => versionId !== command.versionId);
        affectedId = clip.id;
        changed = true;
        acceptedTimelineChanged = true;
      }
    } else if (command.type === 'timeline/set-duration') {
      if (Number.isFinite(command.duration)) {
        project.timeline.duration = asNumber(command.duration, project.timeline.duration, 0.1);
        const activeScene = project.scenes.find((scene) => scene.id === project.timeline.activeSceneId);
        if (activeScene) activeScene.duration = project.timeline.duration;
        affectedId = project.timeline.activeSceneId;
        changed = true;
        acceptedTimelineChanged = true;
      }
    } else if (command.type === 'timeline-diff/create') {
      const diff = normalizeTimelineDiff({...command.diff, status: 'pending'}, timelineDiffContext(), {strict: true});
      if (project.timelineDiffs.items.some((candidate) => candidate.id === diff.id)) {
        throw new Error(`Timeline diff already exists: ${diff.id}`);
      }
      project.timelineDiffs.items.push(diff);
      affectedId = diff.id;
      changed = true;
    } else if (command.type === 'timeline-diff/accept') {
      const diff = project.timelineDiffs.items.find((candidate) => candidate.id === command.diffId);
      if (!diff) throw new Error('Timeline diff was not found.');
      if (diff.status === 'rejected') throw new Error('Rejected timeline diffs cannot be accepted.');
      if (diff.status === 'accepted') {
        affectedId = diff.id;
      } else if (diff.status === 'stale' || diff.baseRevision !== project.timeline.revision) {
        if (diff.status !== 'stale') {
          diff.status = 'stale';
          diff.updatedAt = now();
          commit();
        }
        throw new Error('Stale timeline diffs must be reconciled before acceptance.');
      } else {
        const nextClips = applyTimelineDiff(diff);
        project.timeline.clips = nextClips;
        nextClips.forEach(extendTimeline);
        const timestamp = now();
        diff.status = 'accepted';
        diff.updatedAt = timestamp;
        advanceTimelineRevision(timestamp);
        affectedId = diff.id;
        changed = true;
      }
    } else if (command.type === 'timeline-diff/reject') {
      const diff = project.timelineDiffs.items.find((candidate) => candidate.id === command.diffId);
      if (!diff) throw new Error('Timeline diff was not found.');
      if (diff.status === 'accepted') throw new Error('Accepted timeline diffs cannot be rejected.');
      affectedId = diff.id;
      if (diff.status !== 'rejected') {
        diff.status = 'rejected';
        diff.updatedAt = now();
        changed = true;
      }
    } else if (command.type === 'timeline-diff/accept-all') {
      const reviewable = project.timelineDiffs.items.filter((diff) => diff.status === 'pending' || diff.status === 'stale');
      if (reviewable.some((diff) => diff.status === 'stale' || diff.baseRevision !== project.timeline.revision)) {
        throw new Error('Stale timeline diffs must be reconciled before acceptance.');
      }
      if (reviewable.length) {
        const nextClips = reviewable.reduce((clips, diff) => applyTimelineDiff(diff, clips), project.timeline.clips);
        project.timeline.clips = nextClips;
        nextClips.forEach(extendTimeline);
        const timestamp = now();
        reviewable.forEach((diff) => {
          diff.status = 'accepted';
          diff.updatedAt = timestamp;
        });
        advanceTimelineRevision(timestamp);
        affectedId = reviewable[0].id;
        changed = true;
      }
    } else if (command.type === 'timeline-diff/reject-all') {
      const reviewable = project.timelineDiffs.items.filter((diff) => diff.status === 'pending' || diff.status === 'stale');
      if (reviewable.length) {
        const timestamp = now();
        reviewable.forEach((diff) => {
          diff.status = 'rejected';
          diff.updatedAt = timestamp;
        });
        affectedId = reviewable[0].id;
        changed = true;
      }
    } else if (command.type === 'timeline-diff/mark-stale') {
      const diffIds = Array.isArray(command.diffIds)
        ? command.diffIds.filter((id) => typeof id === 'string' && id.trim())
        : null;
      changed = markPendingDiffsStale(now(), diffIds);
      affectedId = diffIds?.[0] || null;
    } else if (command.type === 'timeline-diff/rebase') {
      const diff = project.timelineDiffs.items.find((candidate) => candidate.id === command.diffId);
      if (!diff) throw new Error('Timeline diff was not found.');
      const existing = existingRebaseFor(diff.id);
      if (existing) {
        affectedId = existing.id;
      } else if (diff.status !== 'stale') {
        conflicts = [{
          diffId: diff.id,
          operationIndex: null,
          type: 'proposal',
          code: 'not-stale',
          message: 'Only stale timeline diffs can be rebased.',
          expected: 'stale',
          actual: diff.status,
        }];
        affectedId = diff.id;
      } else {
        conflicts = rebaseConflictsFor(diff);
        affectedId = diff.id;
        if (!conflicts.length) {
          const rebased = cloneJson(diff);
          delete rebased.id;
          delete rebased.status;
          delete rebased.createdAt;
          delete rebased.updatedAt;
          rebased.baseRevision = project.timeline.revision;
          rebased.summary = `${diff.summary} (rebased)`;
          rebased.provenance = {
            ...rebased.provenance,
            reconciliation: {
              ...(rebased.provenance?.reconciliation || {}),
              rebasedFromDiffId: diff.id,
            },
          };
          const normalized = normalizeTimelineDiff({...rebased, status: 'pending'}, timelineDiffContext(), {strict: true});
          project.timelineDiffs.items.push(normalized);
          affectedId = normalized.id;
          changed = true;
        }
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
    } else if (command.type === 'context/index') {
      const index = command.index;
      if (!isRecord(index) || index.schemaVersion !== PROJECT_CONTEXT_SCHEMA_VERSION || !Array.isArray(index.entries)) {
        throw new Error('Project context indexes must include a schema version and entries.');
      }
      project.contextIndex = {
        schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
        sourceRevision: Number.isInteger(index.sourceRevision) ? Math.max(0, index.sourceRevision) : project.timeline.revision,
        generatedAt: asTimestamp(index.generatedAt, now()),
        entries: sanitizeJson(index.entries) || [],
      };
      affectedId = 'context-index';
      changed = true;
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

    if (changed) {
      if (acceptedTimelineChanged) advanceTimelineRevision(now());
      commit();
    }
    return {project: getProject(), affectedId, changed, conflicts};
  };

  saveProject(storage, project);
  try {
    const result = onCommit?.(toPersistedProject(project));
    result?.catch?.(() => {});
  } catch {
    // Persistence can be unavailable in private or quota-constrained browser contexts.
  }
  const registerAssetUrl = (assetId, url) => {
    if (!assetId) return;
    if (typeof url === 'string' && url.trim()) assetUrls.set(assetId, url);
    else assetUrls.delete(assetId);
  };
  return {getProject, dispatch, registerAssetUrl};
};
