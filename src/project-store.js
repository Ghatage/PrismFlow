export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_STORAGE_KEY = 'prismflow.project';
export const TIMELINE_DIFF_SCHEMA_VERSION = 1;
export const PROJECT_CONTEXT_SCHEMA_VERSION = 1;
export const PROJECT_USAGE_SCHEMA_VERSION = 1;
export const AGENT_WORKSPACE_SCHEMA_VERSION = 1;
export const STYLE_APPLICATION_SCHEMA_VERSION = 1;
export const STORYBOARD_SCHEMA_VERSION = 2;

const DEFAULT_TIMELINE_DURATION = 12;
const DEFAULT_TRACKS = [
  {id: 'V1', name: 'Video', kind: 'video', order: 0},
  {id: 'A1', name: 'Audio', kind: 'audio', order: 1},
];
const SECRET_KEY_PATTERN = /(api.?key|authorization|bearer|credential|password|secret|token)/i;
import {TRANSITION_TYPES, getTransitionDefinition, validateTransitionDefinition, createTransitionKey} from './transitions.js';
export {TRANSITION_TYPES};
export const TRANSITION_EDGE_EPSILON = 0.05;
const MIN_TRANSITION_DURATION = 0.1;
const TIMELINE_DIFF_OPERATION_TYPES = new Set(['add', 'move', 'trim', 'replace', 'remove']);
const TIMELINE_DIFF_STATUSES = new Set(['pending', 'accepted', 'rejected', 'stale']);
const TIMELINE_DIFF_SOURCES = new Set(['agent', 'generation', 'style-application', 'user']);
const ACTIVE_STYLE_APPLICATION_STATUSES = new Set(['queued', 'uploading', 'trimming', 'generating']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asString = (value, fallback = '') => typeof value === 'string' && value.trim() ? value : fallback;
const asNullableString = (value) => typeof value === 'string' && value.trim() ? value : null;
const asRemoteUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
const asNumber = (value, fallback = 0, minimum = 0) => Number.isFinite(value) ? Math.max(minimum, value) : fallback;
const asTimestamp = (value, fallback) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
const normalizeStringIds = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((entry) => asString(entry))
  .filter(Boolean))];

const normalizeUsage = (value, {now}) => {
  const usage = isRecord(value) ? value : {};
  const entries = (Array.isArray(usage.entries) ? usage.entries : [])
    .filter(isRecord)
    .map((entry) => sanitizeJson(entry))
    .filter(Boolean);
  return {
    schemaVersion: PROJECT_USAGE_SCHEMA_VERSION,
    estimatedUsd: asNumber(usage.estimatedUsd),
    credits: asNumber(usage.credits),
    generationCount: Number.isInteger(usage.generationCount) ? Math.max(0, usage.generationCount) : entries.length,
    updatedAt: asTimestamp(usage.updatedAt, now()),
    entries,
  };
};

const normalizeAgentWorkspace = (value, {now, createId}) => {
  const workspace = isRecord(value) ? value : {};
  const script = isRecord(workspace.script) ? workspace.script : {};
  const beats = (Array.isArray(script.beats) ? script.beats : [])
    .filter(isRecord)
    .map((beat) => ({
      id: asString(beat.id, createId('script-beat')),
      text: asString(beat.text),
      sceneId: asNullableString(beat.sceneId),
      clipIds: normalizeStringIds(beat.clipIds),
      notes: asString(beat.notes),
      status: ['draft', 'locked', 'complete'].includes(beat.status) ? beat.status : 'draft',
      createdAt: asTimestamp(beat.createdAt, now()),
      updatedAt: asTimestamp(beat.updatedAt, now()),
    }));
  const messages = (Array.isArray(workspace.messages) ? workspace.messages : [])
    .filter(isRecord)
    .map((message) => ({
      id: asString(message.id, createId('agent-message')),
      role: ['user', 'assistant', 'system'].includes(message.role) ? message.role : 'assistant',
      text: asString(message.text),
      sceneId: asNullableString(message.sceneId),
      resultIds: normalizeStringIds(message.resultIds),
      frameIds: normalizeStringIds(message.frameIds),
      createdAt: asTimestamp(message.createdAt, now()),
    }))
    .filter((message) => message.text);
  return {
    schemaVersion: AGENT_WORKSPACE_SCHEMA_VERSION,
    updatedAt: asTimestamp(workspace.updatedAt, now()),
    messages,
    script: {
      title: asString(script.title, 'Untitled story'),
      metadata: isRecord(script.metadata) ? sanitizeJson(script.metadata) || {} : {},
      beats,
    },
  };
};

const asCoordinate = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

const normalizeStoryboardHero = (value) => {
  if (!isRecord(value) || !asNullableString(value.assetId)) return null;
  return {
    assetId: asString(value.assetId),
    prompt: asString(value.prompt),
    generatedAt: asNullableString(value.generatedAt),
    characterVersionIds: normalizeStringIds(value.characterVersionIds),
  };
};

const normalizeStoryboardScreenplay = (value) => {
  if (!isRecord(value) || !asNullableString(value.text)) return null;
  return {
    text: asString(value.text),
    generatedAt: asNullableString(value.generatedAt),
    modelId: asNullableString(value.modelId),
    usage: isRecord(value.usage) ? sanitizeJson(value.usage) || {} : {},
    editedAt: asNullableString(value.editedAt),
  };
};

const normalizeStoryboardVideoPrompt = (value) => {
  if (!isRecord(value) || !asNullableString(value.text)) return null;
  const duration = Number(value.duration);
  return {
    text: asString(value.text),
    duration: Number.isInteger(duration) && duration >= 4 && duration <= 15 ? duration : 6,
    modelId: asNullableString(value.modelId),
    videoModelId: asNullableString(value.videoModelId),
    generatedAt: asNullableString(value.generatedAt),
    editedAt: asNullableString(value.editedAt),
    submittedAt: asNullableString(value.submittedAt),
    usage: isRecord(value.usage) ? sanitizeJson(value.usage) || {} : {},
  };
};

const normalizeStoryboardStillContext = (value) => {
  if (!isRecord(value)) return {hiddenItemIds: [], overrides: {}};
  const overrides = isRecord(value.overrides)
    ? Object.fromEntries(Object.entries(value.overrides)
      .filter(([itemId, override]) => asNullableString(itemId) && typeof override === 'string')
      .map(([itemId, override]) => [itemId, override]))
    : {};
  return {
    hiddenItemIds: normalizeStringIds(value.hiddenItemIds),
    overrides: sanitizeJson(overrides) || {},
  };
};

const normalizeStoryboardBeat = (value, {createId}, index = 0, legacyStills = []) => {
  if (typeof value === 'string') {
    if (!value.trim()) return null;
    value = {id: createId('sb-beat'), text: value, mentions: {}};
  }
  if (!isRecord(value)) return null;
  const text = asString(value.text);
  if (!text) return null;
  const id = asString(value.id, createId('sb-beat'));
  const legacyHero = [...legacyStills].reverse().find((still) =>
    still.status === 'ready' && still.assetId && still.beatIds.includes(id));
  return {
    id,
    text,
    mentions: isRecord(value.mentions) ? sanitizeJson(value.mentions) || {} : {},
    layout: {
      x: asCoordinate(value.layout?.x, 56 + index * 380),
      y: asCoordinate(value.layout?.y, 72),
    },
    hero: normalizeStoryboardHero(value.hero) || (legacyHero ? {
      assetId: legacyHero.assetId,
      prompt: legacyHero.prompt,
      generatedAt: null,
      characterVersionIds: [],
    } : null),
    screenplay: normalizeStoryboardScreenplay(value.screenplay),
    videoPrompt: normalizeStoryboardVideoPrompt(value.videoPrompt),
    stillContext: normalizeStoryboardStillContext(value.stillContext),
  };
};

const normalizeStoryboard = (value, {createId}) => {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return null;
  const nodes = value.nodes.filter(isRecord).map((node) => {
    const base = {
      id: asString(node.id, createId('sbnode')),
      x: asCoordinate(node.x),
      y: asCoordinate(node.y),
      w: asNumber(node.w, 280, 120),
      z: asNumber(node.z, 1),
    };
    if (node.kind === 'act') {
      const stills = (Array.isArray(node.stills) ? node.stills : []).filter(isRecord).map((still) => ({
        id: asString(still.id, createId('sb-still')),
        assetId: asNullableString(still.assetId),
        beatIds: normalizeStringIds(still.beatIds),
        prompt: asString(still.prompt),
        status: ['generating', 'ready', 'failed'].includes(still.status) ? still.status : 'ready',
      }));
      const beats = (Array.isArray(node.beats) ? node.beats : [])
        .map((beat, index) => normalizeStoryboardBeat(beat, {createId}, index, stills))
        .filter(Boolean);
      const beatIds = new Set(beats.map((beat) => beat.id));
      const connections = Array.isArray(node.connections)
        ? node.connections.filter(isRecord).map((connection) => ({
          id: asString(connection.id, createId('sb-link')),
          fromBeatId: asString(connection.fromBeatId),
          toBeatId: asString(connection.toBeatId),
        })).filter((connection) => beatIds.has(connection.fromBeatId) && beatIds.has(connection.toBeatId))
        : beats.slice(1).map((beat, index) => ({
          id: createId('sb-link'),
          fromBeatId: beats[index].id,
          toBeatId: beat.id,
        }));
      return {
        ...base,
        kind: 'act',
        actNumber: Math.round(asNumber(node.actNumber, 1, 1)),
        sceneId: asNullableString(node.sceneId),
        title: asString(node.title, `Act ${Math.round(asNumber(node.actNumber, 1, 1))}`),
        summary: asString(node.summary),
        beats,
        connections,
        stills,
      };
    }
    return {...base, kind: 'note', text: asString(node.text)};
  }).filter((node) => node.kind === 'act' || node.text);
  return {
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    styleId: asNullableString(value.styleId),
    styleTitle: asString(value.styleTitle),
    visualStyle: asString(value.visualStyle),
    pan: {x: asCoordinate(value.pan?.x), y: asCoordinate(value.pan?.y)},
    zoom: Number.isFinite(value.zoom) ? Math.min(2.5, Math.max(0.25, value.zoom)) : 1,
    nextZ: asNumber(value.nextZ, 10),
    nodes,
  };
};

const normalizeStyleApplications = (value, {now, createId}) => {
  const collection = isRecord(value) && value.schemaVersion === STYLE_APPLICATION_SCHEMA_VERSION ? value : {};
  const batches = (Array.isArray(collection.batches) ? collection.batches : [])
    .filter(isRecord)
    .map((batch) => {
      const createdAt = asTimestamp(batch.createdAt, now());
      const jobs = (Array.isArray(batch.jobs) ? batch.jobs : [])
        .filter(isRecord)
        .map((job) => ({
          ...(sanitizeJson(job) || {}),
          id: asString(job.id, createId('style-job')),
          clipId: asString(job.clipId),
          mediaKind: job.mediaKind === 'image' ? 'image' : 'video',
          status: ['queued', 'uploading', 'trimming', 'generating', 'completed', 'failed', 'skipped'].includes(job.status)
            ? job.status
            : 'queued',
          createdAt: asTimestamp(job.createdAt, createdAt),
          updatedAt: asTimestamp(job.updatedAt, createdAt),
        }))
        .filter((job) => job.clipId);
      return {
        ...(sanitizeJson(batch) || {}),
        id: asString(batch.id, createId('style-batch')),
        styleId: asString(batch.styleId),
        styleName: asString(batch.styleName, 'Deleted style'),
        styleVersionId: asString(batch.styleVersionId),
        referenceAssetIds: normalizeStringIds(batch.referenceAssetIds),
        referenceUrls: normalizeStringIds(batch.referenceUrls).filter((url) => /^https:\/\//i.test(url)),
        instruction: asString(batch.instruction),
        preserveAudio: batch.preserveAudio !== false,
        status: ['queued', 'running', 'completed', 'failed'].includes(batch.status) ? batch.status : 'queued',
        baseRevision: Number.isInteger(batch.baseRevision) && batch.baseRevision >= 0 ? batch.baseRevision : 0,
        jobs,
        createdAt,
        updatedAt: asTimestamp(batch.updatedAt, createdAt),
      };
    })
    .filter((batch) => batch.styleId && batch.styleVersionId && batch.jobs.length);
  return {schemaVersion: STYLE_APPLICATION_SCHEMA_VERSION, batches};
};

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
  const qualityTier = provenance.qualityTier === 'final' || provenance.qualityTier === 'draft' ? provenance.qualityTier : null;
  const normalized = {
    prompt: asNullableString(provenance.prompt),
    modelId: asNullableString(provenance.modelId),
    seed,
    params: isRecord(provenance.params) ? sanitizeJson(provenance.params) || {} : {},
    parentAssetId,
    parentAssetIds,
    derivedMetadata: isRecord(derivedMetadata) ? sanitizeJson(derivedMetadata) || {} : null,
    characterVersionIds: normalizeStringIds(provenance.characterVersionIds),
  };
  const styleVersionIds = normalizeStringIds(provenance.styleVersionIds);
  if (styleVersionIds.length || Array.isArray(provenance.styleVersionIds)) normalized.styleVersionIds = styleVersionIds;
  if (qualityTier) normalized.qualityTier = qualityTier;
  if (isRecord(provenance.qualitySettings)) normalized.qualitySettings = sanitizeJson(provenance.qualitySettings) || {};
  if (Number.isFinite(provenance.estimatedUsd)) normalized.estimatedUsd = Math.max(0, provenance.estimatedUsd);
  return normalized;
};

const detachStyleVersions = (provenance, versionIds) => {
  if (!isRecord(provenance) || !Array.isArray(provenance.styleVersionIds)) return false;
  const next = provenance.styleVersionIds.filter((versionId) => !versionIds.has(versionId));
  if (next.length === provenance.styleVersionIds.length) return false;
  provenance.styleVersionIds = next;
  return true;
};

const detachStyleVersionsFromDiff = (diff, versionIds) => {
  let changed = detachStyleVersions(diff?.provenance, versionIds);
  for (const operation of Array.isArray(diff?.operations) ? diff.operations : []) {
    for (const clip of [operation.before, operation.after, operation.proposedClip]) {
      if (detachStyleVersions(clip?.provenance, versionIds)) changed = true;
    }
  }
  return changed;
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
    styleVersionIds: Array.isArray(proposed.styleVersionIds)
      ? proposed.styleVersionIds
      : before.styleVersionIds,
    qualityTier: proposed.qualityTier === undefined ? before.qualityTier : proposed.qualityTier,
    qualitySettings: proposed.qualitySettings === undefined ? before.qualitySettings : proposed.qualitySettings,
    estimatedUsd: proposed.estimatedUsd === undefined ? before.estimatedUsd : proposed.estimatedUsd,
  });
};

const cloneJson = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

export const transitionEdgeTime = (transition, clips) => {
  const fromClip = transition.fromClipId ? clips.find((clip) => clip.id === transition.fromClipId) : null;
  if (fromClip) return fromClip.start + fromClip.duration;
  const toClip = transition.toClipId ? clips.find((clip) => clip.id === transition.toClipId) : null;
  return toClip ? toClip.start : null;
};

const resolveTransitionAttachment = (transition, clips) => {
  const fromClip = transition.fromClipId ? clips.find((clip) => clip.id === transition.fromClipId) : null;
  const toClip = transition.toClipId ? clips.find((clip) => clip.id === transition.toClipId) : null;
  if (transition.fromClipId && !fromClip) return null;
  if (transition.toClipId && !toClip) return null;
  if (!fromClip && !toClip) return null;
  if (fromClip && toClip) {
    if (fromClip.trackId !== toClip.trackId) return null;
    if (Math.abs(fromClip.start + fromClip.duration - toClip.start) > TRANSITION_EDGE_EPSILON) return null;
    return {fromClip, toClip, trackId: fromClip.trackId, edgeTime: fromClip.start + fromClip.duration};
  }
  // Single-clip fades stay valid only while their edge is not shared with a neighbor.
  const anchor = fromClip || toClip;
  const edgeTime = fromClip ? fromClip.start + fromClip.duration : toClip.start;
  const neighbor = clips.find((clip) => clip.id !== anchor.id
    && clip.trackId === anchor.trackId
    && Math.abs((fromClip ? clip.start : clip.start + clip.duration) - edgeTime) <= TRANSITION_EDGE_EPSILON);
  if (neighbor) return null;
  return {fromClip, toClip, trackId: anchor.trackId, edgeTime};
};

const normalizeTransition = (value, {clips, createId, customTransitions = []}) => {
  if (!isRecord(value)) return null;
  const definition = getTransitionDefinition(value.type, customTransitions);
  if (!definition) return null;
  const transition = {
    id: asString(value.id, createId('transition')),
    type: value.type,
    trackId: asString(value.trackId),
    fromClipId: asNullableString(value.fromClipId),
    toClipId: asNullableString(value.toClipId),
    duration: asNumber(value.duration, definition.defaultDuration, MIN_TRANSITION_DURATION),
  };
  const attachment = resolveTransitionAttachment(transition, clips);
  if (!attachment) return null;
  transition.trackId = attachment.trackId;
  return transition;
};

const pruneInvalidTransitions = (timeline) => {
  const before = timeline.transitions.length;
  timeline.transitions = timeline.transitions.filter((transition) => {
    const attachment = resolveTransitionAttachment(transition, timeline.clips);
    if (!attachment) return false;
    transition.trackId = attachment.trackId;
    return true;
  });
  return timeline.transitions.length !== before;
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
    styles: [],
    styleApplications: {schemaVersion: STYLE_APPLICATION_SCHEMA_VERSION, batches: []},
    customTransitions: [],
    usage: {schemaVersion: PROJECT_USAGE_SCHEMA_VERSION, estimatedUsd: 0, credits: 0, generationCount: 0, updatedAt: timestamp, entries: []},
    agentWorkspace: {schemaVersion: AGENT_WORKSPACE_SCHEMA_VERSION, updatedAt: timestamp, messages: [], script: {title: 'Untitled story', metadata: {}, beats: []}},
    contextIndex: {schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION, sourceRevision: 0, generatedAt: timestamp, entries: []},
    storyboard: null,
    mediaAssets: [],
    timeline: {
      revision: 0,
      activeSceneId: sceneId,
      duration: DEFAULT_TIMELINE_DURATION,
      tracks: DEFAULT_TRACKS.map((track) => ({...track})),
      clips: [],
      transitions: [],
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
    sceneId: asNullableString(asset.sceneId),
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

const normalizeStyleVersion = (value, {now, createId}) => {
  if (!isRecord(value)) return null;
  const seed = typeof value.seed === 'string' || Number.isFinite(value.seed) ? value.seed : null;
  return {
    id: asString(value.id, createId('style-version')),
    referenceAssetIds: normalizeStringIds(value.referenceAssetIds),
    prompt: asString(value.prompt),
    modelId: asString(value.modelId, 'local/manual'),
    seed,
    params: isRecord(value.params) ? sanitizeJson(value.params) || {} : {},
    parentAssetIds: normalizeStringIds(value.parentAssetIds),
    createdAt: asTimestamp(value.createdAt, now()),
  };
};

const normalizeStyle = (value, dependencies) => {
  if (!isRecord(value)) return null;
  const versions = (Array.isArray(value.versions) ? value.versions : [])
    .map((version) => normalizeStyleVersion(version, dependencies))
    .filter(Boolean);
  const versionIds = new Set(versions.map((version) => version.id));
  const lockedVersionId = versionIds.has(value.lockedVersionId) ? value.lockedVersionId : null;
  const requestedActiveVersionId = versionIds.has(value.activeVersionId) ? value.activeVersionId : null;
  const activeVersionId = lockedVersionId || requestedActiveVersionId || versions.at(-1)?.id || null;
  const requestedStatus = ['draft', 'ready', 'failed'].includes(value.status) ? value.status : null;

  return {
    id: asString(value.id, dependencies.createId('style')),
    name: asString(value.name, 'Untitled style'),
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
    audioDetached: Boolean(value.audioDetached),
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
    audioDetached: value.audioDetached === undefined ? Boolean(currentClip?.audioDetached) : Boolean(value.audioDetached),
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
  const seenTransitionKeys = new Set();
  const customTransitions = (Array.isArray(value.customTransitions) ? value.customTransitions : [])
    .map((definition) => {
      const result = validateTransitionDefinition(definition);
      if (!result.ok || !result.definition.key || TRANSITION_TYPES[result.definition.key]) return null;
      if (isRecord(definition) && typeof definition.promptText === 'string') result.definition.promptText = definition.promptText;
      return result.definition;
    })
    .filter((definition) => definition && !seenTransitionKeys.has(definition.key) && seenTransitionKeys.add(definition.key));
  const seenTransitionIds = new Set();
  const transitions = (Array.isArray(timeline.transitions) ? timeline.transitions : [])
    .map((transition) => normalizeTransition(transition, {clips, createId: dependencies.createId, customTransitions}))
    .filter((transition) => transition && !seenTransitionIds.has(transition.id) && seenTransitionIds.add(transition.id));
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
  const usage = normalizeUsage(value.usage || fallback.usage, dependencies);
  const agentWorkspace = normalizeAgentWorkspace(value.agentWorkspace || fallback.agentWorkspace, dependencies);
  const styleApplications = normalizeStyleApplications(value.styleApplications || fallback.styleApplications, dependencies);

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
    styles: (Array.isArray(value.styles) ? value.styles : [])
      .map((style) => normalizeStyle(style, dependencies))
      .filter(Boolean),
    styleApplications,
    customTransitions,
    usage,
    agentWorkspace,
    contextIndex,
    storyboard: normalizeStoryboard(value.storyboard, dependencies),
    mediaAssets,
    timeline: {revision, activeSceneId, duration, tracks, clips, transitions},
    timelineDiffs: {schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION, items: timelineDiffs},
  };
};

const toPersistedProject = (project) => ({
  schemaVersion: PROJECT_SCHEMA_VERSION,
  updatedAt: project.updatedAt,
  project: sanitizeJson(project.project),
  scenes: sanitizeJson(project.scenes),
  characters: sanitizeJson(project.characters),
  styles: sanitizeJson(project.styles),
  styleApplications: sanitizeJson(project.styleApplications || {schemaVersion: STYLE_APPLICATION_SCHEMA_VERSION, batches: []}),
  customTransitions: sanitizeJson(project.customTransitions || []),
  usage: {
    schemaVersion: PROJECT_USAGE_SCHEMA_VERSION,
    estimatedUsd: project.usage?.estimatedUsd || 0,
    credits: project.usage?.credits || 0,
    generationCount: project.usage?.generationCount || 0,
    updatedAt: project.usage?.updatedAt,
    entries: sanitizeJson(project.usage?.entries || []),
  },
  agentWorkspace: sanitizeJson(project.agentWorkspace),
  contextIndex: {
    schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
    sourceRevision: project.contextIndex?.sourceRevision || 0,
    generatedAt: project.contextIndex?.generatedAt,
    entries: sanitizeJson(project.contextIndex?.entries || []),
  },
  storyboard: project.storyboard ? sanitizeJson(project.storyboard) : null,
  mediaAssets: project.mediaAssets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    mimeType: asset.mimeType,
    size: asset.size,
    duration: asset.duration,
    sceneId: asset.sceneId ?? null,
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
      audioDetached: clip.audioDetached,
      provenance: normalizeProvenance(clip.provenance),
    })),
    transitions: project.timeline.transitions.map((transition) => ({
      id: transition.id,
      type: transition.type,
      trackId: transition.trackId,
      fromClipId: transition.fromClipId,
      toClipId: transition.toClipId,
      duration: transition.duration,
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

  const refreshStyleApplicationBatchStatus = (batch) => {
    const statuses = batch.jobs.map((job) => job.status);
    batch.status = statuses.some((status) => ACTIVE_STYLE_APPLICATION_STATUSES.has(status))
      ? 'running'
      : statuses.some((status) => status === 'failed')
        ? 'failed'
        : 'completed';
    batch.updatedAt = now();
  };

  const dispatch = (command) => {
    if (!isRecord(command)) throw new TypeError('Project commands must be objects.');
    let affectedId = null;
    let changed = false;
    let acceptedTimelineChanged = false;
    let conflicts = [];

    if (command.type === 'project/rename') {
      const name = typeof command.name === 'string' ? command.name.trim() : '';
      if (name && name !== project.project.name) {
        project.project.name = name;
        affectedId = project.project.id;
        changed = true;
      }
    } else if (command.type === 'asset/import') {
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
          sceneId: project.scenes.some((scene) => scene.id === command.sceneId)
            ? command.sceneId
            : project.timeline.activeSceneId,
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
    } else if (command.type === 'clip/detach-audio') {
      const clip = project.timeline.clips.find((candidate) => candidate.id === command.clipId);
      const sourceAsset = clip && project.mediaAssets.find((candidate) => candidate.id === clip.assetId);
      const audioTrack = project.timeline.tracks.find((track) => track.kind === 'audio');
      if (clip && sourceAsset?.kind === 'video' && !clip.audioDetached && audioTrack) {
        const audioAsset = normalizeAsset({
          ...command.audioAsset,
          kind: 'audio',
          metadata: {
            ...(isRecord(command.audioAsset?.metadata) ? command.audioAsset.metadata : {}),
            detachedFrom: {assetId: sourceAsset.id, clipId: clip.id},
          },
        }, dependencies);
        if (typeof command.audioAsset?.url === 'string' && command.audioAsset.url.trim()) {
          assetUrls.set(audioAsset.id, command.audioAsset.url);
        }
        project.mediaAssets.push(audioAsset);
        const audioClip = {
          id: createId('clip'),
          assetId: audioAsset.id,
          sceneId: clip.sceneId,
          trackId: audioTrack.id,
          start: clip.start,
          duration: clip.duration,
          sourceStart: clip.sourceStart || 0,
          audioDetached: false,
          provenance: normalizeProvenance({
            parentAssetId: sourceAsset.id,
            derivedMetadata: {type: 'detached-audio', detachedFromClipId: clip.id},
          }),
        };
        project.timeline.clips.push(audioClip);
        clip.audioDetached = true;
        extendTimeline(audioClip);
        affectedId = audioClip.id;
        changed = true;
        acceptedTimelineChanged = true;
      }
    } else if (command.type === 'clip/remove') {
      if (project.timeline.clips.some((clip) => clip.id === command.clipId)) {
        project.timeline.clips = project.timeline.clips.filter((clip) => clip.id !== command.clipId);
        affectedId = command.clipId;
        changed = true;
        acceptedTimelineChanged = true;
      }
    } else if (command.type === 'transition/add') {
      const definition = getTransitionDefinition(command.transitionType, project.customTransitions);
      if (!definition) throw new Error(`Unknown transition type: ${String(command.transitionType)}`);
      const fromClipId = asNullableString(command.fromClipId);
      const toClipId = asNullableString(command.toClipId);
      if (!fromClipId && !toClipId) throw new Error('Transitions require at least one clip.');
      const transition = {
        id: createId('transition'),
        type: command.transitionType,
        trackId: '',
        fromClipId,
        toClipId,
        duration: asNumber(command.duration, definition.defaultDuration, MIN_TRANSITION_DURATION),
      };
      const attachment = resolveTransitionAttachment(transition, project.timeline.clips);
      if (!attachment) throw new Error('Transitions attach to an existing clip edge; between-clip transitions need two adjacent clips on the same track.');
      const track = project.timeline.tracks.find((candidate) => candidate.id === attachment.trackId);
      if (track?.kind !== 'video') throw new Error('Transitions can only be placed on video tracks.');
      transition.trackId = attachment.trackId;
      const shortestClip = Math.min(...[attachment.fromClip, attachment.toClip].filter(Boolean).map((clip) => clip.duration));
      transition.duration = Math.max(MIN_TRANSITION_DURATION, Math.min(transition.duration, shortestClip / 2));
      project.timeline.transitions = project.timeline.transitions.filter((existing) =>
        existing.trackId !== transition.trackId
        || Math.abs(transitionEdgeTime(existing, project.timeline.clips) - attachment.edgeTime) > TRANSITION_EDGE_EPSILON);
      project.timeline.transitions.push(transition);
      affectedId = transition.id;
      changed = true;
      acceptedTimelineChanged = true;
    } else if (command.type === 'transition/remove') {
      if (project.timeline.transitions.some((transition) => transition.id === command.transitionId)) {
        project.timeline.transitions = project.timeline.transitions.filter((transition) => transition.id !== command.transitionId);
        affectedId = command.transitionId;
        changed = true;
        acceptedTimelineChanged = true;
      }
    } else if (command.type === 'transition-def/create') {
      const result = validateTransitionDefinition(command.definition);
      if (!result.ok) throw new Error(`Invalid transition definition: ${result.errors.join('; ')}`);
      const definition = result.definition;
      definition.key = createTransitionKey(definition.label, project.customTransitions.map((existing) => existing.key));
      if (typeof command.promptText === 'string' && command.promptText.trim()) definition.promptText = command.promptText.trim();
      definition.createdAt = now();
      project.customTransitions.push(definition);
      affectedId = definition.key;
      changed = true;
    } else if (command.type === 'transition-def/remove') {
      const definitionIndex = project.customTransitions.findIndex((definition) => definition.key === command.key);
      if (definitionIndex >= 0) {
        project.customTransitions.splice(definitionIndex, 1);
        const before = project.timeline.transitions.length;
        project.timeline.transitions = project.timeline.transitions.filter((transition) => transition.type !== command.key);
        if (project.timeline.transitions.length !== before) acceptedTimelineChanged = true;
        affectedId = command.key;
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
    } else if (command.type === 'scene/add') {
      const input = isRecord(command.scene) ? command.scene : command;
      const scene = {
        id: asString(input.id, createId('scene')),
        name: asString(input.name, `Scene ${String(project.scenes.length + 1).padStart(2, '0')}`),
        duration: asNumber(input.duration, DEFAULT_TIMELINE_DURATION, 0.1),
        metadata: isRecord(input.metadata) ? sanitizeJson(input.metadata) || {} : {},
      };
      if (project.scenes.some((candidate) => candidate.id === scene.id)) {
        throw new Error(`Scene already exists: ${scene.id}`);
      }
      project.scenes.push(scene);
      affectedId = scene.id;
      changed = true;
    } else if (command.type === 'scene/remove') {
      const scene = project.scenes.find((candidate) => candidate.id === command.sceneId);
      if (scene) {
        if (project.scenes.length <= 1) throw new Error('Projects must keep at least one scene.');
        const sceneIndex = project.scenes.findIndex((candidate) => candidate.id === scene.id);
        const reassignTo = project.scenes.find((candidate) => candidate.id === command.reassignToSceneId && candidate.id !== scene.id)
          || project.scenes[sceneIndex - 1]
          || project.scenes[sceneIndex + 1];
        const movedClips = project.timeline.clips.some((clip) => clip.sceneId === scene.id);
        project.timeline.clips.forEach((clip) => { if (clip.sceneId === scene.id) clip.sceneId = reassignTo.id; });
        project.mediaAssets.forEach((asset) => { if (asset.sceneId === scene.id) asset.sceneId = reassignTo.id; });
        project.agentWorkspace.messages.forEach((message) => { if (message.sceneId === scene.id) message.sceneId = reassignTo.id; });
        if (project.storyboard) {
          project.storyboard.nodes = project.storyboard.nodes.filter((node) => node.kind !== 'act' || node.sceneId !== scene.id);
        }
        project.scenes = project.scenes.filter((candidate) => candidate.id !== scene.id);
        if (project.timeline.activeSceneId === scene.id) project.timeline.activeSceneId = reassignTo.id;
        affectedId = scene.id;
        changed = true;
        acceptedTimelineChanged = movedClips;
      }
    } else if (command.type === 'timeline/set-active-scene') {
      const scene = project.scenes.find((candidate) => candidate.id === command.sceneId);
      if (scene && project.timeline.activeSceneId !== scene.id) {
        project.timeline.activeSceneId = scene.id;
        affectedId = scene.id;
        changed = true;
      }
    } else if (command.type === 'storyboard/update') {
      const storyboard = normalizeStoryboard(command.storyboard, dependencies);
      if (!storyboard) throw new Error('Storyboard updates require a nodes array.');
      project.storyboard = storyboard;
      affectedId = 'storyboard';
      changed = true;
    } else if (command.type === 'storyboard/act-save') {
      if (!project.storyboard) throw new Error('Storyboard act saves require an existing storyboard.');
      const currentIndex = project.storyboard.nodes.findIndex((node) => node.kind === 'act' && node.id === command.actId);
      if (currentIndex < 0) throw new Error(`Storyboard act was not found: ${command.actId}`);
      if (!isRecord(command.act) || command.act.id !== command.actId || !Array.isArray(command.act.beats)) {
        throw new Error('Storyboard act saves require a matching act draft with beats.');
      }
      const rawBeatIds = command.act.beats.map((beat) => asNullableString(beat?.id));
      if (rawBeatIds.some((id) => !id) || new Set(rawBeatIds).size !== rawBeatIds.length) {
        throw new Error('Storyboard act beats require unique ids.');
      }
      const rawBeatIdSet = new Set(rawBeatIds);
      for (const connection of Array.isArray(command.act.connections) ? command.act.connections : []) {
        if (!rawBeatIdSet.has(connection?.fromBeatId) || !rawBeatIdSet.has(connection?.toBeatId)) {
          throw new Error('Storyboard connection references a missing beat.');
        }
      }
      for (const beat of command.act.beats) {
        if (!beat?.hero?.assetId) continue;
        const asset = project.mediaAssets.find((candidate) => candidate.id === beat.hero.assetId);
        if (!asset || asset.kind !== 'image') throw new Error('Storyboard beat heroes must reference an existing image asset.');
      }
      const normalized = normalizeStoryboard({
        ...project.storyboard,
        nodes: [command.act],
      }, dependencies)?.nodes?.[0];
      if (!normalized || normalized.kind !== 'act') throw new Error('Storyboard act draft is invalid.');
      project.storyboard.nodes[currentIndex] = normalized;
      const scene = project.scenes.find((candidate) => candidate.id === normalized.sceneId);
      if (scene) scene.name = normalized.title;
      affectedId = normalized.id;
      changed = true;
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
    } else if (command.type === 'usage/record') {
      const input = isRecord(command.entry) ? command.entry : {};
      const modelId = asString(input.modelId);
      if (!modelId || !Number.isFinite(input.estimatedUsd) || !Number.isFinite(input.credits)) {
        throw new Error('Usage entries require a model id, estimated USD, and credits.');
      }
      const id = asString(input.id, createId('usage'));
      if (!project.usage.entries.some((entry) => entry.id === id)) {
        const entry = {
          id,
          generationJobId: asNullableString(input.generationJobId),
          modelId,
          qualityTier: input.qualityTier === 'final' ? 'final' : 'draft',
          estimatedUsd: asNumber(input.estimatedUsd),
          credits: asNumber(input.credits),
          unit: asString(input.unit, 'generation'),
          quantity: asNumber(input.quantity, 1),
          currency: asString(input.currency, 'USD'),
          costBasis: asString(input.costBasis, 'catalog-estimate'),
          operation: asString(input.operation, 'generation'),
          createdAt: asTimestamp(input.createdAt, now()),
        };
        project.usage.entries.push(entry);
        project.usage.estimatedUsd += entry.estimatedUsd;
        project.usage.credits += entry.credits;
        project.usage.generationCount += 1;
        project.usage.updatedAt = now();
        affectedId = id;
        changed = true;
      } else {
        affectedId = id;
      }
    } else if (command.type === 'agent/message-add') {
      const text = asString(command.message?.text ?? command.text);
      if (!text) throw new Error('Agent messages require text.');
      const role = ['user', 'assistant', 'system'].includes(command.message?.role ?? command.role)
        ? (command.message?.role ?? command.role)
        : 'user';
      const message = {
        id: asString(command.message?.id, createId('agent-message')),
        role,
        text,
        sceneId: asNullableString(command.message?.sceneId ?? command.sceneId),
        resultIds: normalizeStringIds(command.message?.resultIds ?? command.resultIds),
        frameIds: normalizeStringIds(command.message?.frameIds ?? command.frameIds),
        createdAt: asTimestamp(command.message?.createdAt, now()),
      };
      project.agentWorkspace.messages.push(message);
      project.agentWorkspace.updatedAt = now();
      affectedId = message.id;
      changed = true;
    } else if (command.type === 'script/update') {
      if (isRecord(command.patch)) {
        project.agentWorkspace.script.title = asString(command.patch.title, project.agentWorkspace.script.title);
        if (isRecord(command.patch.metadata)) {
          project.agentWorkspace.script.metadata = sanitizeJson({...project.agentWorkspace.script.metadata, ...command.patch.metadata}) || {};
        }
        project.agentWorkspace.updatedAt = now();
        affectedId = 'script';
        changed = true;
      }
    } else if (command.type === 'script/beat-add') {
      const text = asString(command.beat?.text ?? command.text);
      if (!text) throw new Error('Script beats require text.');
      const beat = normalizeAgentWorkspace({script: {beats: [{
        ...command.beat,
        id: command.beat?.id || createId('script-beat'),
        text,
        createdAt: now(),
        updatedAt: now(),
      }]}}, dependencies).script.beats[0];
      project.agentWorkspace.script.beats.push(beat);
      project.agentWorkspace.updatedAt = now();
      affectedId = beat.id;
      changed = true;
    } else if (command.type === 'script/beat-update') {
      const beat = project.agentWorkspace.script.beats.find((candidate) => candidate.id === command.beatId);
      if (beat && isRecord(command.patch)) {
        if (command.patch.text !== undefined) beat.text = asString(command.patch.text, beat.text);
        if (command.patch.sceneId !== undefined) beat.sceneId = asNullableString(command.patch.sceneId);
        if (command.patch.clipIds !== undefined) beat.clipIds = normalizeStringIds(command.patch.clipIds);
        if (command.patch.notes !== undefined) beat.notes = asString(command.patch.notes);
        if (['draft', 'locked', 'complete'].includes(command.patch.status)) beat.status = command.patch.status;
        beat.updatedAt = now();
        project.agentWorkspace.updatedAt = now();
        affectedId = beat.id;
        changed = true;
      }
    } else if (command.type === 'script/beat-remove') {
      if (project.agentWorkspace.script.beats.some((beat) => beat.id === command.beatId)) {
        project.agentWorkspace.script.beats = project.agentWorkspace.script.beats.filter((beat) => beat.id !== command.beatId);
        project.agentWorkspace.updatedAt = now();
        affectedId = command.beatId;
        changed = true;
      }
    } else if (command.type === 'style-application/batch-create') {
      const normalized = normalizeStyleApplications({
        schemaVersion: STYLE_APPLICATION_SCHEMA_VERSION,
        batches: [{...command.batch, createdAt: command.batch?.createdAt || now(), updatedAt: now()}],
      }, dependencies).batches[0];
      if (!normalized) throw new Error('Style application batch is invalid.');
      if (project.styleApplications.batches.some((batch) => batch.id === normalized.id)) {
        throw new Error(`Style application batch already exists: ${normalized.id}`);
      }
      const style = project.styles.find((candidate) => candidate.id === normalized.styleId);
      if (!style?.versions.some((version) => version.id === normalized.styleVersionId)) {
        throw new Error('Style application requires an existing style version.');
      }
      project.styleApplications.batches.push(normalized);
      affectedId = normalized.id;
      changed = true;
    } else if (command.type === 'style-application/batch-update') {
      const batch = project.styleApplications.batches.find((candidate) => candidate.id === command.batchId);
      if (batch && isRecord(command.patch)) {
        if (command.patch.referenceUrls !== undefined) {
          batch.referenceUrls = normalizeStringIds(command.patch.referenceUrls).filter((url) => /^https:\/\//i.test(url));
        }
        if (command.patch.error !== undefined) batch.error = asNullableString(command.patch.error);
        if (['queued', 'running', 'completed', 'failed'].includes(command.patch.status)) batch.status = command.patch.status;
        batch.updatedAt = now();
        affectedId = batch.id;
        changed = true;
      }
    } else if (command.type === 'style-application/job-update') {
      const batch = project.styleApplications.batches.find((candidate) => candidate.id === command.batchId);
      const job = batch?.jobs.find((candidate) => candidate.id === command.jobId);
      if (batch && job && isRecord(command.patch)) {
        const patch = sanitizeJson(command.patch) || {};
        delete patch.id;
        delete patch.clipId;
        delete patch.sourceClip;
        delete patch.sourceAssetId;
        if (patch.status && !['queued', 'uploading', 'trimming', 'generating', 'completed', 'failed', 'skipped'].includes(patch.status)) {
          throw new Error(`Unknown style application job status: ${String(patch.status)}`);
        }
        Object.assign(job, patch, {updatedAt: now()});
        refreshStyleApplicationBatchStatus(batch);
        affectedId = job.id;
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
    } else if (command.type === 'character/remove') {
      const characterIndex = project.characters.findIndex((candidate) => candidate.id === command.characterId);
      if (characterIndex >= 0) {
        const versionIds = new Set(project.characters[characterIndex].versions.map((version) => version.id));
        project.characters.splice(characterIndex, 1);
        for (const node of project.storyboard?.nodes || []) {
          if (node.kind !== 'act') continue;
          for (const beat of node.beats || []) {
            beat.mentions = Object.fromEntries(Object.entries(beat.mentions || {})
              .filter(([, characterId]) => characterId !== command.characterId));
          }
        }
        for (const clip of project.timeline.clips) {
          const previousIds = clip.provenance.characterVersionIds;
          clip.provenance.characterVersionIds = previousIds.filter((versionId) => !versionIds.has(versionId));
          if (clip.provenance.characterVersionIds.length !== previousIds.length) acceptedTimelineChanged = true;
        }
        affectedId = command.characterId;
        changed = true;
      }
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
    } else if (command.type === 'style/remove') {
      const styleIndex = project.styles.findIndex((candidate) => candidate.id === command.styleId);
      if (styleIndex >= 0) {
        const style = project.styles[styleIndex];
        const hasActiveJobs = project.styleApplications.batches.some((batch) => batch.styleId === style.id
          && batch.jobs.some((job) => ACTIVE_STYLE_APPLICATION_STATUSES.has(job.status)));
        if (hasActiveJobs) throw new Error('This style cannot be deleted while Apply Style jobs are active.');
        const versionIds = new Set(style.versions.map((version) => version.id));
        project.styles.splice(styleIndex, 1);
        for (const clip of project.timeline.clips) {
          if (detachStyleVersions(clip.provenance, versionIds)) acceptedTimelineChanged = true;
        }
        for (const diff of project.timelineDiffs.items) detachStyleVersionsFromDiff(diff, versionIds);
        affectedId = style.id;
        changed = true;
      }
    } else if (command.type === 'style/create') {
      const style = normalizeStyle({
        id: createId('style'),
        name: command.name,
        status: 'draft',
        versions: [],
      }, dependencies);
      project.styles.push(style);
      affectedId = style.id;
      changed = true;
    } else if (command.type === 'style/rename') {
      const style = project.styles.find((candidate) => candidate.id === command.styleId);
      const name = asString(command.name);
      if (style && name) {
        style.name = name;
        affectedId = style.id;
        changed = true;
      }
    } else if (command.type === 'style/status') {
      const style = project.styles.find((candidate) => candidate.id === command.styleId);
      if (style && ['draft', 'ready', 'failed'].includes(command.status)) {
        style.status = command.status;
        affectedId = style.id;
        changed = true;
      }
    } else if (command.type === 'style/version-record') {
      const style = project.styles.find((candidate) => candidate.id === command.styleId);
      if (style) {
        const version = normalizeStyleVersion({
          ...command.version,
          id: command.version?.id || createId('style-version'),
        }, dependencies);
        if (!version.referenceAssetIds.length || version.referenceAssetIds.some((assetId) => !project.mediaAssets.some((asset) => asset.id === assetId))) {
          throw new Error('A style version must reference at least one existing asset.');
        }
        if (style.versions.some((candidate) => candidate.id === version.id)) {
          throw new Error(`Style version already exists: ${version.id}`);
        }
        style.versions.push(version);
        style.status = 'ready';
        if (!style.lockedVersionId) style.activeVersionId = version.id;
        affectedId = version.id;
        changed = true;
      }
    } else if (command.type === 'style/version-activate') {
      const style = project.styles.find((candidate) => candidate.id === command.styleId);
      if (style && !style.lockedVersionId && style.versions.some((version) => version.id === command.versionId)) {
        style.activeVersionId = command.versionId;
        affectedId = style.id;
        changed = true;
      }
    } else if (command.type === 'style/lock') {
      const style = project.styles.find((candidate) => candidate.id === command.styleId);
      if (style && style.versions.some((version) => version.id === command.versionId)) {
        style.lockedVersionId = command.versionId;
        style.activeVersionId = command.versionId;
        affectedId = style.id;
        changed = true;
      }
    } else if (command.type === 'style/unlock') {
      const style = project.styles.find((candidate) => candidate.id === command.styleId);
      if (style && style.lockedVersionId) {
        style.lockedVersionId = null;
        style.activeVersionId = style.versions.at(-1)?.id || null;
        affectedId = style.id;
        changed = true;
      }
    } else {
      throw new Error(`Unknown project command: ${String(command.type)}`);
    }

    if (changed) {
      pruneInvalidTransitions(project.timeline);
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
