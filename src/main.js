import {createProjectStore, TRANSITION_EDGE_EPSILON, transitionEdgeTime} from './project-store.js';
import {BUILT_IN_TRANSITIONS, applyTransitionStyles, buildTransitionGenerationMessages, getTransitionDefinition} from './transitions.js';
import {createBrowserDatabase} from './browser-database.js';
import {createCharacterLibrary} from './character-library.js';
import {createStyleLibrary} from './style-library.js';
import {
  createCharacterGenerationController,
  createFakeCharacterGenerationAdapter,
  createServerCharacterGenerationAdapter,
  normalizeCharacterGenerationInput,
  recordCharacterSheetVersion,
} from './character-generation.js';
import {createTimelineCharacterAttachments} from './timeline-characters.js';
import {createTimelineDiffs} from './timeline-diffs.js';
import {
  buildGhostItems,
  derivePreviewClips,
  findGhostItem,
  listReviewableDiffs,
  listReviewItems,
  reviseGhostProposal,
  selectFirstReviewItem,
  selectNextReviewItem,
  selectPreviousReviewItem,
} from './timeline-diff-review.js';
import {
  createFakeTimelineGenerationAdapter,
  createServerTimelineGenerationAdapter,
  createTimelineGenerationController,
  landGenerationResult,
} from './timeline-generation.js';
import {createClipRegenerationService} from './clip-regeneration.js';
import {resolveTimelinePlaybackAt} from './timeline-playback.js';
import {formatCredits, formatUsd, normalizeQualityTier, qualitySettingsFor} from './quality-tiers.js';
import {expandMentionPrompt, findMentions, imageInputFor, resolveMentionedVersions} from './prompt-mentions.js';
import {attachMentionAutocomplete} from './mention-autocomplete.js';
import {toUploadableUrl} from './asset-data-url.js';
import {createAgentWorkspace} from './agent-workspace.js';
import {createProjectContextService} from './project-context.js';
import {blobToDataUrl, captureVideoFrame, createVideoFrameIndexer} from './video-indexing.js';
import {
  FILL_GAP_DURATION,
  FILL_GAP_MODEL_ID,
  FILL_GAP_TRANSITION_KEY,
  buildGapFillPrompt,
  buildGapFillPromptMessages,
  findGapFillPair,
  gapFillCaptureTimes,
  gapFillShiftPlan,
} from './gap-fill.js';
import {createAudioTranscriptionIndexer} from './audio-indexing.js';
import {AudioExtractError, extractAudioFromBlob} from './audio-extract.js';
import {createAgentRunStore} from './agent-runs.js';
import {buildSelectedClipContext, createAgentTools} from './agent-tools.js';
import {AgentCancelledError, runEditorAgent} from './editor-agent.js';
import {
  DEFAULT_STYLE_IMAGE_MODEL,
  DEFAULT_STYLE_VIDEO_MODEL,
  createServerStyleApplicationAdapter,
  createStyleApplicationBatch,
  createStyleApplicationController,
  defaultStyleInstruction,
  styleApplicationEligibility,
} from './style-application.js';
import {getNarrativeStyle, narrativeStyles} from './data/narrative-styles.js';
import {dockSplash, removeSplashLayer, renderSplash} from './splash.js';
import {renderProjectsHub, sortSummaries, summarizeProject} from './projects-hub.js';
import {patchStylePickerSelection, renderStylePicker} from './style-picker.js';
import {renderStoryboard, buildStoryboardFromStyle, refreshStoryboardChrome} from './storyboard.js';
import {renderActWorkspace} from './act-workspace.js';
import {createActWorkspace} from './storyboard-workspace.js';
import {
  createFakeStoryboardGenerationAdapter,
  createServerStoryboardGenerationAdapter,
  stableStillSeed,
} from './storyboard-generation.js';
import {
  NO_MUSIC_DIRECTION,
  SEEDANCE_REFERENCE_VIDEO_MODEL_ID,
  SEEDANCE_VIDEO_DURATIONS,
  nextBeatVideoTimelineStart,
  withSeedanceReferenceDirections,
} from './beat-video.js';
import {
  actForViewTime,
  actOffsets,
  orderedScenes,
  toLocalStart,
  toViewStart,
  visibleAssetIds,
  visibleClips,
} from './act-view.js';
import {
  createFakeMusicGenerationAdapter,
  createServerMusicGenerationAdapter,
} from './music-generation.js';
import {buildScoreContext} from './score-direction.js';
import {bestAlignmentOffset, detectBeats, monoSamples, scoreClipPlacements} from './music-sync.js';

const legacyStorage = {
  getItem: (key) => {
    try {
      return globalThis.localStorage?.getItem(key) || null;
    } catch {
      return null;
    }
  },
  setItem: () => {},
};
const projectDatabase = createBrowserDatabase();
// Whether legacy localStorage held a project at boot; only then does the
// bootstrap store's content deserve to be migrated into IndexedDB — otherwise
// it is a throwaway default that must not appear in the projects hub.
const hadLegacyProject = Boolean(legacyStorage.getItem('prismflow.project'));
let projectStore = createProjectStore({storage: legacyStorage});
let project = projectStore.getProject();
let projectOpen = false;

const initialView = (() => {
  const requested = new URLSearchParams(globalThis.location?.search || '').get('view');
  return ['splash', 'projects', 'picker', 'storyboard', 'editor'].includes(requested) ? requested : 'splash';
})();

const state = {
  view: initialView,
  projectSummaries: [],
  selectedNarrativeStyleId: null,
  get media() { return project.mediaAssets; },
  get characters() { return project.characters; },
  get styles() { return project.styles; },
  get agentWorkspace() { return project.agentWorkspace; },
  get clips() { return project.timeline.clips; },
  get tracks() { return project.timeline.tracks; },
  get transitions() { return project.timeline.transitions; },
  get customTransitions() { return project.customTransitions; },
  get pendingDiffs() { return listReviewableDiffs(project.timelineDiffs.items); },
  get timelineDuration() { return project.timeline.duration; },
  activeActId: 'all',
  selectedClipId: null,
  selectedClipIds: new Set(),
  selectedTransitionId: null,
  selectedGhostKey: null,
  previewDiffId: null,
  regenerationEditorClipId: null,
  regenerationEditorMode: 'prompt',
  currentTime: 0,
  isPlaying: false,
  scoreGeneration: null,
  playerVolume: 1,
  lastAudibleVolume: 1,
  zoom: 1,
  activeTab: 'media',
  agentPaneOpen: false,
  expandedAgentRunId: null,
  agentPromptModalOpen: false,
  agentPromptDraft: '',
  agentLlmStatus: null,
  agentStepperScrollTop: 0,
  videoSearchQuery: '',
  videoSearchLoading: false,
  videoSearchError: '',
  videoSearchResults: [],
  selectedFrameResult: null,
  videoIndexingByAsset: new Map(),
  trackMenuOpen: false,
  selectedCharacterId: null,
  isCharacterModalOpen: false,
  characterModalMode: 'detail',
  selectedStyleId: null,
  isStyleModalOpen: false,
  styleApplicationModal: null,
  generateVideoModal: null,
  beatVideoModal: null,
  editorSessionInitialized: false,
  characterComposerInput: {name: '', prompt: '', styleNotes: '', referenceAssetIds: []},
  isTransitionComposerOpen: false,
  transitionComposerInput: {name: '', prompt: ''},
  transitionComposerStatus: {phase: 'idle', error: ''},
  promptMentionMap: {},
  rebaseConflicts: {},
  mediaPanelOpen: true,
  mediaHydrated: false,
  previewPlaybackSignature: null,
  timelineScrollTop: 0,
  timelineScrollLeft: 0,
  rafId: null,
  playbackStartedAt: 0,
  playbackOrigin: 0,
  dragPayload: null,
};

const updateProject = (command) => {
  const result = projectStore.dispatch(command);
  project = result.project;
  return result;
};

const characterLibrary = createCharacterLibrary({
  getProject: () => project,
  dispatch: updateProject,
});
const styleLibrary = createStyleLibrary({
  getProject: () => project,
  dispatch: updateProject,
});
const agentWorkspace = createAgentWorkspace({
  getProject: () => project,
  dispatch: updateProject,
});
const projectContext = createProjectContextService({
  getProject: () => project,
  dispatch: updateProject,
});
const videoIndexer = createVideoFrameIndexer({
  database: projectDatabase,
  getProject: () => project,
  onProgress: (manifest) => {
    state.videoIndexingByAsset.set(manifest.videoAssetId, manifest);
    const asset = project.mediaAssets.find((candidate) => candidate.id === manifest.videoAssetId);
    if (asset) updateProject({
      type: 'asset/update',
      assetId: asset.id,
      patch: {metadata: {videoIndex: {
        status: manifest.status,
        frameCount: manifest.frameCount,
        completedCount: manifest.completedCount,
        interval: manifest.interval,
        modelId: manifest.modelId,
        updatedAt: manifest.updatedAt,
      }}},
    });
  },
});
const audioIndexer = createAudioTranscriptionIndexer({
  getProject: () => project,
  updateAsset: (assetId, metadata) => {
    updateProject({type: 'asset/update', assetId, patch: {metadata}});
    renderApp();
  },
});
const agentRuns = createAgentRunStore();
const agentTools = createAgentTools({
  getProject: () => project,
  dispatch: updateProject,
  getState: () => state,
  setState: (patch) => Object.assign(state, patch),
  projectContext,
  videoIndexer,
  database: projectDatabase,
  getSearchScope: () => ({
    activeSceneId: activeActSceneId(),
    assetIds: [...scopedAssetIds()],
    characterIds: charactersForAct().map((character) => character.id),
  }),
});
const callLlm = async ({messages, tools, signal}) => {
  const response = await fetch('/api/agent/llm', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({messages, tools}),
    signal,
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) throw new Error(data?.error || `Agent LLM request failed (${response.status}).`);
  return data;
};
const timelineCharacterAttachments = createTimelineCharacterAttachments({
  getProject: () => project,
  dispatch: updateProject,
});
const timelineDiffs = createTimelineDiffs({getProject: () => project, dispatch: updateProject});
const styleApplicationAdapter = createServerStyleApplicationAdapter();
const styleAssetUploadPromises = new Map();
const styleApplicationController = createStyleApplicationController({
  store: {getProject: () => project, dispatch: updateProject},
  diffs: timelineDiffs,
  adapter: styleApplicationAdapter,
  resolveAssetUrl: (asset) => resolveStyleAssetUrl(asset),
  persistAsset: (assetId) => persistGeneratedAsset(assetId),
});
let styleApplicationPollTimer = null;
let styleApplicationPollInFlight = false;
const useFakeTimelineAdapter = new URLSearchParams(globalThis.location.search).get('timelineAdapter') === 'fake';
const timelineGenerationAdapter = useFakeTimelineAdapter
  ? createFakeTimelineGenerationAdapter({
    createId: (() => { let jobNumber = 0; const sessionKey = Math.random().toString(36).slice(2, 7); return () => `fake-timeline-job-${sessionKey}-${++jobNumber}`; })(),
  })
  : createServerTimelineGenerationAdapter();
const clipRegeneration = createClipRegenerationService({
  store: {getProject: () => project, dispatch: updateProject},
  diffs: timelineDiffs,
  adapter: timelineGenerationAdapter,
});
let regenerationPollTimer = null;
const timelineAddGeneration = createTimelineGenerationController({
  adapter: timelineGenerationAdapter,
  onCompleted: async (output, job) => {
    const landed = landGenerationResult({
      store: {getProject: () => project, dispatch: updateProject},
      diffs: timelineDiffs,
      job: {jobId: job.jobId, input: job.input},
      output,
    });
    if (landed.diffId) timelineDiffs.accept(landed.diffId);
    await persistGeneratedAsset(landed.assetId);
    finalizeGapFill(job);
  },
});
// After a fill-gap clip lands, push the incoming clip (and everything after it
// on that track) right so the fill sits snugly between its two boundary clips.
const finalizeGapFill = (job) => {
  const toClipId = job?.input?.params?.gapFillToClipId;
  if (!toClipId) return;
  const fillClip = project.timeline.clips.find((clip) =>
    clip.provenance?.derivedMetadata?.generationJobId === job.jobId);
  if (!fillClip) return;
  const moves = gapFillShiftPlan({
    clips: project.timeline.clips,
    toClipId,
    fillStart: fillClip.start,
    fillDuration: fillClip.duration,
    excludeClipId: fillClip.id,
  });
  moves.forEach((move) => updateProject({type: 'clip/move', clipId: move.clipId, trackId: move.trackId, start: move.start}));
};
const useFakeMusicAdapter = new URLSearchParams(globalThis.location.search).get('musicAdapter') === 'fake';
const musicGenerationAdapter = useFakeMusicAdapter
  ? createFakeMusicGenerationAdapter()
  : createServerMusicGenerationAdapter();
let scorePollTimer = null;
let generateVideoPollTimer = null;
let modelCatalogPromise = null;
const autoApplyRegenerationJobIds = new Set();
const useFakeCharacterAdapter = new URLSearchParams(globalThis.location.search).get('characterAdapter') === 'fake';
const characterGenerationAdapter = useFakeCharacterAdapter
  ? createFakeCharacterGenerationAdapter()
  : createServerCharacterGenerationAdapter({
    resolveReferenceUrl: (assetId) => project.mediaAssets.find((asset) => asset.id === assetId)?.url || null,
    toUploadableUrl,
  });
const useFakeStoryboardAdapter = new URLSearchParams(globalThis.location.search).get('storyboardAdapter') === 'fake';
const storyboardGenerationAdapter = useFakeStoryboardAdapter
  ? createFakeStoryboardGenerationAdapter()
  : createServerStoryboardGenerationAdapter({
    resolveReferenceUrl: (assetId) => project.mediaAssets.find((asset) => asset.id === assetId)?.url || null,
    toUploadableUrl,
  });
let modelInputsPromise = null;
let characterGenerationController = null;
let characterPollTimer = null;

const app = document.querySelector('#app');
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'video/*,audio/*,image/*';
fileInput.multiple = true;
fileInput.hidden = true;
document.body.append(fileInput);

const icons = {
  chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>',
  grid: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h4v4h-4zm7 0h4v4h-4zm-7 7h4v4h-4zm7 0h4v4h-4z"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 7 5-7 5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9M11 3.5v9"/></svg>',
  skipBack: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v10m1 0 7-5-7-5z"/></svg>',
  skipForward: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12 3v10M11 3 4 8l7 5z"/></svg>',
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  scissors: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5.2 5.2 7.3 7.3M10.8 5.2 3.5 12.5M4.4 3.7a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4Zm7.2 5.2a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4Z"/></svg>',
  sliders: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h10M6 2.5v3M10 6.5v3M7 10.5v3"/></svg>',
  film: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M5 3v10M11 3v10M2.5 6h11M2.5 10h11"/></svg>',
  image: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><circle cx="5.5" cy="5.5" r="1"/><path d="m3.5 11 3.2-3 2.2 2 1.6-1.3 2 2.3"/></svg>',
  audio: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5v7.2M9.5 3.5 13 2v7.2M9.5 10.7a2.2 2.2 0 1 1-2.2-2.2 2.2 2.2 0 0 1 2.2 2.2Zm3.5-1.5a2.2 2.2 0 1 1-2.2-2.2 2.2 2.2 0 0 1 2.2 2.2Z"/></svg>',
  magic: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9.6 2.2.6 2.2 2.2.6-2.2.6-.6 2.2L9 5.6l-2.2-.6L9 4.4l.6-2.2ZM4.2 7.5l.8 2.7 2.7.8-2.7.8-.8 2.7-.8-2.7-2.7-.8 2.7-.8.8-2.7ZM12.5 10l.4 1.4 1.4.4-1.4.4-.4 1.4-.4-1.4-1.4-.4 1.4-.4.4-1.4Z"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
  robot: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="5.5" width="10" height="7" rx="1.5"/><path d="M8 5.5V3m0 0h2M5.5 12.5V14m5-1.5V14"/><circle cx="6" cy="8.5" r=".9"/><circle cx="10" cy="8.5" r=".9"/><path d="M6.5 10.8h3"/></svg>',
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1"/></svg>',
  more: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12.5" cy="8" r="1"/></svg>',
  volume: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6.2v3.6h2.3L8.2 12.6V3.4L4.8 6.2H2.5Z"/><path d="M10.5 5.6a3.4 3.4 0 0 1 0 4.8M12.4 4a6 6 0 0 1 0 8"/></svg>',
  volumeMuted: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6.2v3.6h2.3L8.2 12.6V3.4L4.8 6.2H2.5Z"/><path d="m10.5 6.2 3.4 3.6m0-3.6-3.4 3.6"/></svg>',
  fullscreen: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10"/></svg>',
  exitFullscreen: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5"/></svg>',
};

const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[character]));

const formatTime = (seconds, showHours = false) => {
  const safeSeconds = Math.max(0, seconds || 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  const secondsText = remainder.toFixed(2).padStart(5, '0');
  return `${showHours ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:` : ''}${String(minutes % 60).padStart(2, '0')}:${secondsText}`;
};

const formatBytes = (bytes) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const mediaKind = (file) => {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'video';
};

const kindIcon = (kind) => icons[kind] || icons.film;
const clipById = (id) => state.clips.find((clip) => clip.id === id);
const selectedTimelineClips = () => state.clips.filter((clip) => state.selectedClipIds.has(clip.id));
const clearTimelineClipSelection = () => {
  state.selectedClipId = null;
  state.selectedClipIds.clear();
};
const selectOnlyClip = (clipId) => {
  state.selectedClipIds = new Set(clipId ? [clipId] : []);
  state.selectedClipId = clipId || null;
};
const selectTimelineClip = (clipId, event = {}) => {
  const clip = clipById(clipId);
  if (!clip) return;
  if (event.shiftKey && state.selectedClipId) {
    const anchor = clipById(state.selectedClipId);
    if (anchor?.trackId === clip.trackId) {
      const trackClips = viewClips()
        .filter((candidate) => candidate.trackId === clip.trackId)
        .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
      const anchorIndex = trackClips.findIndex((candidate) => candidate.id === anchor.id);
      const clipIndex = trackClips.findIndex((candidate) => candidate.id === clip.id);
      const [start, end] = anchorIndex < clipIndex ? [anchorIndex, clipIndex] : [clipIndex, anchorIndex];
      state.selectedClipIds = new Set([...state.selectedClipIds, ...trackClips.slice(start, end + 1).map((candidate) => candidate.id)]);
      state.selectedClipId = clip.id;
    } else {
      state.selectedClipIds = new Set([...state.selectedClipIds, clip.id]);
      state.selectedClipId = clip.id;
    }
  } else if (event.metaKey || event.ctrlKey) {
    const next = new Set(state.selectedClipIds);
    if (next.has(clip.id)) next.delete(clip.id);
    else next.add(clip.id);
    state.selectedClipIds = next;
    state.selectedClipId = next.has(clip.id) ? clip.id : [...next].at(-1) || null;
  } else {
    selectOnlyClip(clip.id);
  }
  state.selectedTransitionId = null;
  state.selectedGhostKey = null;
  state.previewDiffId = null;
};
const diffById = (id) => state.pendingDiffs.find((diff) => diff.id === id);
const selectedGhost = () => findGhostItem(state.pendingDiffs, state.selectedGhostKey);
const reviewItems = () => listReviewItems(state.pendingDiffs);
const reviewItemForDiff = (diffId) => reviewItems().find((item) => item.diffId === diffId) || null;
const selectReviewItem = (item) => {
  state.selectedGhostKey = item?.ghostKey || item?.key || null;
  clearTimelineClipSelection();
  return item;
};
const mediaById = (id) => state.media.find((item) => item.id === id);
const characterById = (id) => state.characters.find((character) => character.id === id);
const characterVersion = (character) => character?.versions.find((version) => version.id === (character.lockedVersionId || character.activeVersionId)) || null;
const styleById = (id) => state.styles.find((style) => style.id === id);
const styleVersion = (style) => style?.versions.find((version) => version.id === (style.lockedVersionId || style.activeVersionId)) || null;
const styleReferenceImageIds = (style) => (styleVersion(style)?.referenceAssetIds || [])
  .filter((assetId) => mediaById(assetId)?.kind === 'image');
const activeScene = () => project.scenes.find((scene) => scene.id === (
  state.activeActId !== 'all' ? state.activeActId : project.timeline.activeSceneId
)) || project.scenes[0];
const activeActSceneId = () => state.activeActId === 'all' ? null : activeScene()?.id || null;
const viewClips = (clips = state.clips) => visibleClips(project, state.activeActId, clips);
const viewClipById = (id) => viewClips().find((clip) => clip.id === id) || null;
const viewClip = (clip) => {
  if (!clip || (state.activeActId !== 'all' && clip.sceneId !== state.activeActId)) return null;
  return state.activeActId === 'all'
    ? {...clip, start: toViewStart(project, state.activeActId, clip.sceneId, clip.start)}
    : clip;
};
const scopedAssetIds = () => visibleAssetIds(project, state.activeActId);
const scopedMedia = () => {
  const ids = scopedAssetIds();
  return state.media.filter((asset) => ids.has(asset.id));
};
const mentionedCharacterIds = (sceneId = null) => new Set((project.storyboard?.nodes || [])
  .filter((node) => node.kind === 'act' && (!sceneId || node.sceneId === sceneId))
  .flatMap((node) => (node.beats || []).flatMap((beat) => Object.values(beat.mentions || {})))
  .filter((id) => typeof id === 'string'));
const charactersForAct = (sceneId = activeActSceneId()) => {
  if (!sceneId) return characterLibrary.load();
  const inAct = mentionedCharacterIds(sceneId);
  const mentionedAnywhere = mentionedCharacterIds();
  return characterLibrary.load().filter((character) => inAct.has(character.id) || !mentionedAnywhere.has(character.id));
};
const scopedMessages = () => state.activeActId === 'all'
  ? state.agentWorkspace.messages
  : state.agentWorkspace.messages.filter((message) => message.sceneId === null || message.sceneId === state.activeActId);
const placementForViewStart = (viewStart, sceneId = null) => {
  const owningSceneId = state.activeActId === 'all'
    ? sceneId || actForViewTime(project, viewStart)
    : state.activeActId;
  return {
    sceneId: owningSceneId || activeScene()?.id || null,
    start: toLocalStart(project, state.activeActId, owningSceneId, viewStart),
  };
};
const scale = () => 88 * state.zoom;

const renderMediaVisual = (item) => {
  if (item.url && item.kind === 'image') return `<img src="${item.url}" alt="" />`;
  if (item.url && item.kind === 'video') return `<video src="${item.url}" muted preload="metadata"></video>`;
  if (item.kind === 'audio') return `<div class="audio-thumb">${icons.audio}</div>`;
  return `<div class="offline-thumb">${kindIcon(item.kind)}<span>offline</span></div>`;
};

const setView = (view) => {
  if (view === 'editor' && state.view !== 'editor') state.editorSessionInitialized = false;
  if (view !== 'editor') state.beatVideoModal = null;
  // The docked prism overlay only belongs to the splash and hub screens.
  if (view !== 'splash' && view !== 'projects') removeSplashLayer();
  state.view = view;
  renderApp();
};

let storyboardWorking = null; // mutable board the storyboard view edits before persisting
let actWorkspaceSession = null;
let actWorkspaceId = 0;

const ensureStoryboardSeeded = (style) => {
  if (project.storyboard?.styleId === style.id && project.storyboard.nodes.length) return;
  const board = buildStoryboardFromStyle(style);
  board.nodes.filter((node) => node.kind === 'act').forEach((node) => {
    let scene = project.scenes.find((candidate) => candidate.metadata?.actNumber === node.actNumber);
    if (!scene && node.actNumber === 1) scene = project.scenes[0];
    if (scene) {
      updateProject({type: 'scene/update', sceneId: scene.id, patch: {name: node.title, metadata: {actNumber: node.actNumber}}});
      node.sceneId = scene.id;
    } else {
      node.sceneId = updateProject({type: 'scene/add', scene: {name: node.title, metadata: {actNumber: node.actNumber}}}).affectedId;
    }
  });
  updateProject({type: 'storyboard/update', storyboard: board});
  storyboardWorking = null;
};

const openStoryboardFromPicker = () => {
  const style = getNarrativeStyle(state.selectedNarrativeStyleId);
  if (!style) return;
  ensureStoryboardSeeded(style);
  setView('storyboard');
};

const actWorkspaceLayer = () => {
  let layer = document.querySelector('#actWorkspaceLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'actWorkspaceLayer';
    document.body.append(layer);
  }
  return layer;
};

const resolveStoryboardMentions = (text) => Object.fromEntries(
  findMentions(text, project.characters, state.promptMentionMap)
    .map((mention) => [mention.name, mention.characterId]),
);

const attachStoryboardMentionInput = (textarea) => attachMentionAutocomplete(textarea, {
  getCharacters: () => project.characters,
  onInsert: ({characterId, name}) => { state.promptMentionMap[name] = characterId; },
});

const saveActWorkspace = () => {
  if (!actWorkspaceSession) return;
  try {
    updateProject({
      type: 'storyboard/act-save',
      actId: actWorkspaceSession.actId,
      act: actWorkspaceSession.workspace.snapshot(),
    });
    actWorkspaceSession.workspace.markSaved();
    storyboardWorking = project.storyboard;
    renderStoryboard(app, storyboardOptions());
    refreshStoryboardChrome();
    renderActWorkspaceLayer();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const actWorkspaceBusy = (session = actWorkspaceSession) => [...(session?.jobs?.values() || [])]
  .some((job) => job.still?.status === 'generating' || job.screenplay?.status === 'generating');

const closeActWorkspace = () => {
  const session = actWorkspaceSession;
  if (!session) return;
  const busy = actWorkspaceBusy(session);
  const dirty = session.workspace.read().dirty;
  const busyMessage = dirty
    ? 'Generation is still running and unsaved act changes will be discarded. Close this act? Completed output may remain in Media without being attached to the beat.'
    : 'Generation is still running. Close this act? Completed output may remain in Media without being attached to the beat.';
  if (busy && !window.confirm(busyMessage)) return;
  if (!busy && dirty && !window.confirm('Discard unsaved changes to this act?')) return;
  actWorkspaceSession = null;
  renderActWorkspaceLayer();
};

const updateActWorkspaceJob = (session, beatId, kind, patch) => {
  const current = session.jobs.get(beatId) || {};
  session.jobs.set(beatId, {...current, [kind]: {...(current[kind] || {}), ...patch}});
  if (actWorkspaceSession === session) renderActWorkspaceLayer();
};

const generateBeatStill = async (beatId) => {
  const session = actWorkspaceSession;
  if (!session) return;
  let context;
  try {
    context = session.workspace.contextFor(beatId);
    const unresolved = context.characters.filter((character) =>
      character.mentioned && (!character.versionId || !character.sheetAssetId));
    if (unresolved.length) throw new Error(`Generate a character sheet for ${unresolved.map((character) => character.name).join(', ')} first.`);
    const referenceAssetIds = [...new Set(context.characters.map((character) => character.sheetAssetId).filter(Boolean))];
    if (referenceAssetIds.length > 14) throw new Error('Nano Banana 2 accepts at most 14 character reference images.');
    const styleReferenceAssetIds = (context.style?.referenceAssetIds || [])
      .filter((assetId) => !referenceAssetIds.includes(assetId));
    const targetBeat = session.workspace.read().act.beats.find((entry) => entry.id === beatId);
    // First generation is seeded deterministically per beat; an explicit
    // regenerate rolls a fresh random seed so retries can differ.
    const seed = targetBeat?.hero?.assetId ? null : stableStillSeed(context.project.id || 'project', beatId);
    updateActWorkspaceJob(session, beatId, 'still', {status: 'generating', error: '', jobId: null});
    const {jobId} = await storyboardGenerationAdapter.submitStill({
      context,
      referenceAssetIds,
      styleReferenceAssetIds,
      previousStillAssetId: context.previousStill?.assetId || null,
      seed,
    });
    updateActWorkspaceJob(session, beatId, 'still', {jobId});

    const poll = async () => {
      try {
        const result = await storyboardGenerationAdapter.getStillJob(jobId);
        if (result.status === 'queued' || result.status === 'running') {
          setTimeout(poll, storyboardGenerationAdapter.kind === 'fake' ? 80 : 400);
          return;
        }
        if (result.status !== 'completed') throw new Error(result.error || 'Storyboard still generation failed.');
        const act = session.workspace.read().act;
        const beat = act.beats.find((entry) => entry.id === beatId);
        if (!beat) return;
        const imported = updateProject({
          type: 'asset/import',
          asset: {
            name: `${act.title} — ${beat.text.slice(0, 54)}`,
            kind: 'image',
            mimeType: result.asset.mimeType,
            size: 0,
            duration: 5,
            url: result.asset.url,
            sceneId: act.sceneId,
            source: {type: 'generated', fileName: result.asset.fileName || `${beat.id}-still`, lastModified: 0},
            metadata: {
              storyboardActId: act.id,
              storyboardBeatId: beat.id,
              provider: result.source?.provider || 'fal',
              providerJobId: result.source?.jobId || jobId,
              providerModelId: result.source?.modelId || null,
              seed: result.seed ?? null,
              prompt: result.prompt || context.target.text,
              characterVersionIds: result.characterVersionIds || context.characters.map((character) => character.versionId).filter(Boolean),
              width: result.asset.width,
              height: result.asset.height,
            },
          },
        });
        await persistGeneratedAsset(imported.affectedId);
        if (actWorkspaceSession === session) {
          session.workspace.dispatch({
            type: 'beat/update',
            beatId,
            patch: {hero: {
              assetId: imported.affectedId,
              prompt: result.prompt || context.target.text,
              generatedAt: new Date().toISOString(),
              characterVersionIds: result.characterVersionIds || context.characters.map((character) => character.versionId).filter(Boolean),
            }},
          });
        }
        updateActWorkspaceJob(session, beatId, 'still', {status: 'ready', error: '', assetId: imported.affectedId});
      } catch (error) {
        updateActWorkspaceJob(session, beatId, 'still', {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    setTimeout(poll, storyboardGenerationAdapter.kind === 'fake' ? 40 : 300);
  } catch (error) {
    updateActWorkspaceJob(session, beatId, 'still', {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const generateBeatScreenplay = async (beatId) => {
  const session = actWorkspaceSession;
  if (!session) return;
  updateActWorkspaceJob(session, beatId, 'screenplay', {status: 'generating', error: ''});
  try {
    const result = await storyboardGenerationAdapter.generateScreenplay({context: session.workspace.contextFor(beatId)});
    if (actWorkspaceSession === session) {
      session.workspace.dispatch({
        type: 'beat/update',
        beatId,
        patch: {screenplay: {
          text: result.text,
          generatedAt: new Date().toISOString(),
          modelId: result.modelId,
          usage: result.usage || {},
          editedAt: null,
        }},
      });
    }
    updateActWorkspaceJob(session, beatId, 'screenplay', {status: 'ready', error: ''});
  } catch (error) {
    updateActWorkspaceJob(session, beatId, 'screenplay', {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

const renderActWorkspaceLayer = () => {
  const layer = actWorkspaceLayer();
  renderActWorkspace(layer, {
    workspace: state.view === 'storyboard' ? actWorkspaceSession?.workspace : null,
    onClose: closeActWorkspace,
    onSave: saveActWorkspace,
    busy: actWorkspaceBusy(),
    jobs: actWorkspaceSession?.jobs || new Map(),
    assetById: mediaById,
    onGenerateStill: generateBeatStill,
    onGenerateScreenplay: generateBeatScreenplay,
    resolveMentions: resolveStoryboardMentions,
    attachMentionInput: attachStoryboardMentionInput,
  });
};

const openActWorkspace = (actId) => {
  if (storyboardWorking) {
    updateProject({type: 'storyboard/update', storyboard: storyboardWorking});
    storyboardWorking = project.storyboard;
  }
  const activeStoryboard = project.storyboard;
  if (!activeStoryboard?.nodes.some((node) => node.kind === 'act' && node.id === actId)) return;
  actWorkspaceSession = {
    actId,
    jobs: new Map(),
    workspace: createActWorkspace({
      project: {...project, storyboard: activeStoryboard},
      actId,
      narrativeStyle: getNarrativeStyle(activeStoryboard.styleId),
      createId: (prefix) => `${prefix}-${Date.now().toString(36)}-${++actWorkspaceId}`,
    }),
  };
  renderActWorkspaceLayer();
};

const storyboardOptions = () => ({
  storyboard: storyboardWorking,
  onChange: (board) => updateProject({type: 'storyboard/update', storyboard: board}),
  onJumpToEditor: () => {
    actWorkspaceSession = null;
    setView('editor');
  },
  onBackToPicker: () => setView('picker'),
  onOpenAct: openActWorkspace,
  characters: () => project.characters,
  renderCharacterVisual,
  assetById: mediaById,
  onCreateCharacter: createCharacter,
  onOpenCharacter: openCharacter,
  onActRename: (node) => {
    if (node.sceneId) updateProject({type: 'scene/update', sceneId: node.sceneId, patch: {name: node.title}});
  },
  resolveMentions: resolveStoryboardMentions,
  attachMentionInput: attachStoryboardMentionInput,
});

const characterModalLayer = () => {
  let layer = document.querySelector('#modalLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'modalLayer';
    document.body.append(layer);
  }
  return layer;
};

const renderCharacterModalLayer = () => {
  const layer = characterModalLayer();
  const modalAllowed = state.view === 'storyboard' || state.view === 'editor';
  layer.innerHTML = modalAllowed && state.isCharacterModalOpen ? renderCharacterModal() : '';
};

const renderApp = () => {
  renderActWorkspaceLayer();
  if (state.view === 'splash') {
    renderCharacterModalLayer();
    app.innerHTML = '';
    renderSplash();
    return;
  }
  if (state.view === 'projects') {
    renderCharacterModalLayer();
    renderProjectsHub(app, {
      summaries: state.projectSummaries,
      onOpen: (projectId) => { void openProjectById(projectId); },
      onCreate: () => { void createNewProject(); },
      onDelete: (projectId) => { void deleteProjectById(projectId); },
    });
    return;
  }
  if (state.view === 'picker') {
    renderCharacterModalLayer();
    renderStylePicker(app, {
      styles: narrativeStyles,
      selectedId: state.selectedNarrativeStyleId,
      onSelect: (styleId) => {
        state.selectedNarrativeStyleId = styleId;
        patchStylePickerSelection(app, narrativeStyles, styleId);
      },
      onNext: (target) => {
        if (target === 'editor') { setView('editor'); return; }
        openStoryboardFromPicker();
      },
    });
    return;
  }
  if (state.view === 'storyboard') {
    if (!project.storyboard) {
      if (!state.mediaHydrated) {
        // A direct storyboard deep link can arrive before IndexedDB has
        // restored the project. Do not redirect based on the temporary default
        // project; restoreSession will render the persisted board momentarily.
        app.innerHTML = '';
        return;
      }
      // With a project open the missing storyboard means "not seeded yet" —
      // send the user to the structure picker. Without one (deep link into an
      // empty install) fall back to the projects hub.
      state.view = projectOpen ? 'picker' : 'projects';
      renderApp();
      return;
    }
    if (!storyboardWorking || storyboardWorking.styleId !== project.storyboard.styleId) {
      storyboardWorking = project.storyboard;
    }
    renderStoryboard(app, storyboardOptions());
    refreshStoryboardChrome();
    renderCharacterModalLayer();
    if (state.isCharacterModalOpen) bindCharacterModalEvents(characterModalLayer());
    return;
  }
  renderEditorApp();
};

const editorStoryboardActs = () => (project.storyboard?.nodes || [])
  .filter((node) => node.kind === 'act' && (state.activeActId === 'all' || node.sceneId === state.activeActId))
  .toSorted((left, right) => left.actNumber - right.actNumber);

const renderEditorBeatStrip = () => {
  const acts = editorStoryboardActs();
  if (!acts.length) return '';
  const entries = acts.flatMap((act) => (act.beats || []).map((beat, index) => {
    const nextBeat = act.beats[index + 1] || null;
    const linkedToNext = Boolean(nextBeat && (act.connections || []).some((connection) =>
      connection.fromBeatId === beat.id && connection.toBeatId === nextBeat.id));
    return {act, beat, index, linkedToNext};
  }));
  const title = acts.length === 1 ? acts[0].title : 'All acts';
  return `
    <section class="editor-beat-strip" aria-label="Storyboard beat stills">
      <div class="editor-beat-strip-label"><span class="eyebrow">BEAT STILLS</span><strong>${escapeHtml(title)}</strong></div>
      <div class="editor-beat-strip-scroll">
        <div class="editor-beat-strip-list">
          ${entries.map(({act, beat, index, linkedToNext}) => {
            const asset = beat.hero?.assetId ? mediaById(beat.hero.assetId) : null;
            return `<div class="editor-beat-strip-entry ${linkedToNext ? 'is-linked' : 'is-disjoint'}">
              <button class="editor-beat-still ${asset?.url ? '' : 'is-missing'}" data-editor-act-id="${escapeHtml(act.id)}" data-editor-beat-id="${escapeHtml(beat.id)}" type="button" ${asset?.url ? '' : 'disabled'} aria-label="${asset?.url ? `Open beat ${index + 1} video generator` : `Beat ${index + 1} has no still`}">
                <span class="editor-beat-still-image">${asset?.url ? `<img src="${escapeHtml(asset.url)}" alt="" />` : '<span>No still</span>'}</span>
                <span class="editor-beat-still-copy"><strong>Beat ${String(index + 1).padStart(2, '0')}</strong><small>${escapeHtml(beat.text)}</small></span>
              </button>
              ${linkedToNext ? '<span class="editor-beat-connector" aria-hidden="true"></span>' : ''}
            </div>`;
          }).join('')}
        </div>
      </div>
    </section>`;
};

const renderEditorApp = () => {
  if (!state.editorSessionInitialized && state.mediaHydrated) {
    const firstStoryboardAct = (project.storyboard?.nodes || [])
      .filter((node) => node.kind === 'act' && node.sceneId)
      .toSorted((left, right) => left.actNumber - right.actNumber)[0];
    state.activeActId = firstStoryboardAct?.sceneId || orderedScenes(project)[0]?.id || 'all';
    state.editorSessionInitialized = true;
  }
  if (state.activeActId !== 'all' && !project.scenes.some((scene) => scene.id === state.activeActId)) {
    state.activeActId = project.scenes.some((scene) => scene.id === project.timeline.activeSceneId)
      ? project.timeline.activeSceneId
      : 'all';
  }
  const acceptedClipIds = new Set(viewClips().map((clip) => clip.id));
  state.selectedClipIds = new Set([...state.selectedClipIds].filter((clipId) => acceptedClipIds.has(clipId)));
  if (state.selectedClipId && !acceptedClipIds.has(state.selectedClipId)) state.selectedClipId = [...state.selectedClipIds].at(-1) || null;
  const previousTimelineBody = app.querySelector('.timeline-body');
  const previousTimelineScroll = app.querySelector('#timelineScroll');
  if (previousTimelineBody) state.timelineScrollTop = previousTimelineBody.scrollTop;
  if (previousTimelineScroll) state.timelineScrollLeft = previousTimelineScroll.scrollLeft;
  app.querySelectorAll('#previewVideo, #previewAudioMix audio').forEach((element) => element.pause());

  app.innerHTML = `
    <div class="shell" data-media-hydrated="${state.mediaHydrated}">
      <header class="topbar">
        <div class="brand-lockup">
          <div class="brand-mark"><span></span><span></span><span></span></div>
          <span class="brand-name">PrismFlow</span>
          <span class="brand-divider"></span>
          <button class="project-switcher" type="button">${escapeHtml(project.project.name)} ${icons.chevron}</button>
          <span class="save-state"><i></i> Local draft</span>
        </div>
        <form class="global-search" data-video-search-form role="search">
          <span class="global-search-icon" aria-hidden="true">⌕</span>
          <input name="query" value="${escapeHtml(state.videoSearchQuery)}" placeholder="Search video frames…" aria-label="Search video frames" autocomplete="off" />
          <button type="submit" ${state.videoSearchLoading ? 'disabled' : ''}>${state.videoSearchLoading ? 'Searching…' : 'Search'}</button>
        </form>
        <div class="top-actions">
          <button class="icon-button" title="Project settings" type="button">${icons.sliders}</button>
          <div class="fal-status-chip" id="falConnection" aria-live="polite" title="Checking local FAL adapter">
            <span class="connection-indicator" id="falIndicator"></span>
            <span class="fal-chip-label">FAL</span>
            <span id="falStatus">Checking…</span>
          </div>
          <div class="usage-chip" title="Estimated generation usage"><span>${formatCredits(project.usage?.credits || 0)}</span><small>${formatUsd(project.usage?.estimatedUsd || 0)}</small></div>
          <button class="button ghost" type="button" data-action="export">Export</button>
          <button class="button primary" type="button" data-action="render"><span class="button-spark">${icons.magic}</span> Render draft</button>
          <button class="avatar" type="button" aria-label="Account">PF</button>
        </div>
      </header>

      <main class="workspace ${state.mediaPanelOpen ? '' : 'media-panel-hidden'} ${state.agentPaneOpen ? 'agent-pane-open' : ''}">
        ${renderAgentRail()}
        ${renderAgentRunCard()}
        <aside class="sidebar left-panel ${state.mediaPanelOpen ? '' : 'is-hidden'}">
          <div class="panel-tabs">
            <button class="panel-tab ${state.activeTab === 'media' ? 'active' : ''}" data-tab="media" type="button">Media <span class="tab-count">${scopedMedia().length || ''}</span></button>
            <button class="panel-tab ${state.activeTab === 'characters' ? 'active' : ''}" data-tab="characters" type="button">Characters <span class="tab-count">${charactersForAct().length || ''}</span></button>
            <button class="panel-tab ${state.activeTab === 'styles' ? 'active' : ''}" data-tab="styles" type="button">Styles <span class="tab-count">${state.styles.length || ''}</span></button>
            <button class="panel-tab ${state.activeTab === 'transitions' ? 'active' : ''}" data-tab="transitions" type="button">Transitions</button>
            <button class="panel-tab ${state.activeTab === 'script' ? 'active' : ''}" data-tab="script" type="button">Script <span class="tab-count">${state.agentWorkspace.script.beats.length || ''}</span></button>
          </div>
          ${state.activeTab === 'media' ? renderMediaPanel() : state.activeTab === 'characters' ? renderCharactersPanel() : state.activeTab === 'styles' ? renderStylesPanel() : state.activeTab === 'script' ? renderScriptPanel() : renderTransitionsPanel()}
        </aside>

        <section class="stage">
          <div class="stage-toolbar">
            <div class="breadcrumb"><span class="eyebrow">STORYBOARD</span><span class="slash">/</span><span>${escapeHtml(project.project.name)}</span></div>
            <div class="stage-tools"><button class="toolbar-button media-toggle" data-action="toggle-media-panel" aria-pressed="${state.mediaPanelOpen}" type="button">${icons.grid} ${state.mediaPanelOpen ? 'Hide media' : 'Show media'}</button><button class="toolbar-button" data-action="toggle-agent-pane" aria-pressed="${state.agentPaneOpen}" type="button">${icons.magic} ${state.agentPaneOpen ? 'Hide agent' : 'Agent'}</button><button class="toolbar-button" type="button">${icons.grid} Fit</button><button class="toolbar-button" type="button">100%</button><button class="toolbar-button" type="button">${icons.more}</button></div>
          </div>
          <div class="preview-wrap">
            <div class="preview-frame" id="previewFrame">
              <video id="previewVideo" playsinline preload="metadata"></video>
              <img id="previewImage" alt="Selected timeline image" />
              <video id="previewVideoB" playsinline preload="metadata" muted aria-hidden="true"></video>
              <img id="previewImageB" alt="" aria-hidden="true" />
              <div class="preview-fade" id="previewFade" aria-hidden="true"></div>
              <div class="audio-preview" id="audioPreview"><div class="audio-orb">${icons.audio}</div><span>Audio clip</span></div>
              <div class="preview-audio-mix" id="previewAudioMix" aria-hidden="true"></div>
              <div class="safe-area"></div>
            </div>
            <div class="player-controls">
              <div class="player-time"><span id="playerCurrent">${formatTime(state.currentTime)}</span><span class="muted"> / </span><span id="playerDuration">${formatTime(playbackDuration())}</span></div>
              <div class="player-buttons"><button class="round-control" data-action="step-back" title="Previous frame" type="button">${icons.skipBack}</button><button class="play-control" data-action="toggle-play" title="${state.isPlaying ? 'Pause' : 'Play'}" type="button">${state.isPlaying ? icons.pause : icons.play}</button><button class="round-control" data-action="step-forward" title="Next frame" type="button">${icons.skipForward}</button></div>
              <div class="player-right" aria-live="polite"><span class="live-dot ${state.previewDiffId ? 'proposal' : ''}"></span><span data-player-status>${state.previewDiffId ? 'Proposal preview' : 'Accepted preview'}</span><div class="volume-control"><button class="toolbar-button" data-action="toggle-mute" title="${state.playerVolume === 0 ? 'Unmute' : 'Mute'}" aria-label="${state.playerVolume === 0 ? 'Unmute' : 'Mute'}" type="button">${state.playerVolume === 0 ? icons.volumeMuted : icons.volume}</button><input id="playerVolume" type="range" min="0" max="1" step="0.01" value="${state.playerVolume}" aria-label="Volume" /></div><button class="toolbar-button" data-action="toggle-fullscreen" title="${document.fullscreenElement ? 'Exit full screen' : 'Full screen'}" aria-label="${document.fullscreenElement ? 'Exit full screen' : 'Full screen'}" type="button">${document.fullscreenElement ? icons.exitFullscreen : icons.fullscreen}</button><button class="toolbar-button" type="button" aria-label="Player options">${icons.more}</button></div>
            </div>
          </div>
          ${renderContextPanel()}
          ${renderEditorBeatStrip()}
        </section>
        ${renderAgentPane()}
      </main>

      <section class="timeline-panel">
        ${renderTimeline()}
      </section>
    </div>
    ${state.beatVideoModal ? renderBeatVideoModal() : state.agentPromptModalOpen ? renderAgentPromptModal() : state.styleApplicationModal ? renderStyleApplicationModal() : state.generateVideoModal ? renderGenerateVideoModal() : state.isCharacterModalOpen ? '' : state.isStyleModalOpen ? renderStyleModal() : state.isTransitionComposerOpen ? renderTransitionComposerModal() : ''}
  `;

  renderCharacterModalLayer();
  bindEvents();
  state.previewPlaybackSignature = null;
  syncPreview(true);
  // Re-rendering replaces the fullscreen element; re-enter fullscreen on the
  // fresh preview while the triggering user gesture is still active.
  if (document.fullscreenElement && !app.contains(document.fullscreenElement)) {
    app.querySelector('.preview-wrap')?.requestFullscreen?.().catch(() => {});
  }
};

const renderMediaPanel = () => `
  <div class="panel-heading"><div><span class="eyebrow">ASSET BIN</span><h2>Media</h2></div></div>
  <div class="media-library" data-dropzone="media"><div class="media-list">${scopedMedia().map(renderMediaCard).join('')}<button class="media-add-card" data-action="open-file" type="button" aria-label="Import media">${icons.plus}</button></div>${renderVideoSearchResults()}</div>
  <div class="panel-footnote"><span>Drag assets onto the timeline to start editing.</span></div>
`;

const renderMediaCard = (item) => {
  const videoIndex = state.videoIndexingByAsset.get(item.id) || item.metadata?.videoIndex;
  const isSelectedFrame = state.selectedFrameResult?.videoAssetId === item.id;
  const indexingLabel = item.kind === 'video' && videoIndex
    ? ` · ${videoIndex.status === 'complete' ? `${videoIndex.frameCount} frames indexed` : `indexing ${videoIndex.completedCount || 0}/${videoIndex.frameCount || '…'}`}`
    : '';
  return `
  <div class="media-card ${isSelectedFrame ? 'frame-selected' : ''}" draggable="true" data-media-id="${item.id}">
    <div class="media-thumb ${item.kind}">${renderMediaVisual(item)}<span class="type-badge">${kindIcon(item.kind)}</span></div>
    <div class="media-card-copy"><strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong><span>${item.url ? `${item.kind} · ${item.kind === 'image' ? 'still' : formatTime(item.duration)}` : state.mediaHydrated ? `${item.kind} · re-import to preview` : `${item.kind} · restoring…`}${indexingLabel}</span></div>
    <button class="card-more" data-action="remove-media" data-media-id="${item.id}" type="button">${icons.more}</button>
  </div>
`;
};

const renderVideoSearchResults = () => state.videoSearchQuery ? `
  <div class="video-search-results" aria-label="Video frame search results">
    <div class="video-search-results-head"><span class="eyebrow">FRAME HITS</span><button type="button" data-action="clear-video-search">Clear</button></div>
    ${state.videoSearchLoading ? '<p class="video-search-empty">Searching annotated frames…</p>' : state.videoSearchError ? `<p class="video-search-empty error">${escapeHtml(state.videoSearchError)}</p>` : state.videoSearchResults.length ? state.videoSearchResults.map((result) => `<button class="video-search-result ${state.selectedFrameResult?.id === result.id ? 'selected' : ''}" data-video-frame-id="${escapeHtml(result.id)}" type="button"><strong>${escapeHtml(result.videoName || result.videoAssetId)}</strong><span>${formatTime(result.time)} · ${escapeHtml(result.annotation || result.searchText || '')}</span></button>`).join('') : '<p class="video-search-empty">No annotated video frames matched this search.</p>'}
  </div>
` : '';

const searchVideoFrames = async (query) => {
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return [];
  state.videoSearchQuery = normalizedQuery;
  state.videoSearchLoading = true;
  state.videoSearchError = '';
  try {
    const assetIds = scopedAssetIds();
    const requestedLimit = state.activeActId === 'all' ? 10 : 30;
    const results = await videoIndexer.search(normalizedQuery, {limit: requestedLimit});
    state.videoSearchResults = results.filter((result) => assetIds.has(result.videoAssetId)).slice(0, 10);
    state.selectedFrameResult = null;
    return state.videoSearchResults;
  } catch (error) {
    state.videoSearchError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    state.videoSearchLoading = false;
  }
};

const submitVideoSearch = async (event) => {
  event.preventDefault();
  const query = String(new FormData(event.currentTarget).get('query') || '').trim();
  if (!query) return;
  state.videoSearchQuery = query;
  state.activeTab = 'media';
  state.mediaPanelOpen = true;
  state.videoSearchLoading = true;
  renderApp();
  try {
    await searchVideoFrames(query);
    renderApp();
  } catch (error) {
    showToast(`Video search failed: ${error instanceof Error ? error.message : String(error)}`);
    renderApp();
  }
};

const renderCharacterVisual = (character) => {
  const version = characterVersion(character);
  const asset = version ? mediaById(version.sheetAssetId) : null;
  if (asset) return renderMediaVisual(asset);
  return `<div class="character-placeholder">${icons.magic}<span>${character.status === 'failed' ? 'failed' : 'draft'}</span></div>`;
};

const renderCharactersPanel = () => `
  <div class="panel-heading"><div><span class="eyebrow">IDENTITY LIBRARY</span><h2>Characters</h2></div></div>
  <div class="character-grid">
    <button class="character-card character-add-card" data-action="create-character" type="button"><span>${icons.plus}</span><strong>New character</strong></button>
    ${charactersForAct().map((character) => `<button class="character-card" data-character-id="${character.id}" type="button"><div class="character-sheet">${renderCharacterVisual(character)}</div><div class="character-card-copy"><strong>${escapeHtml(character.name)}</strong><span>${character.lockedVersionId ? 'Locked' : character.status} · ${character.versions.length} ${character.versions.length === 1 ? 'version' : 'versions'}</span></div>${character.lockedVersionId ? '<span class="character-lock">LOCKED</span>' : ''}</button>`).join('')}
  </div>
  ${state.characters.length ? '' : '<div class="panel-empty"><span>Create reusable identities without adding clips to the timeline.</span></div>'}
  <div class="panel-footnote"><span class="fal-dot"></span><span>Versioned references</span><span class="status-pill">local</span></div>
`;

const renderStyleVisual = (style) => {
  const version = styleVersion(style);
  const asset = version?.referenceAssetIds.map(mediaById).find(Boolean);
  if (asset) return renderMediaVisual(asset);
  return `<div class="character-placeholder">${icons.magic}<span>${style.status === 'failed' ? 'failed' : 'draft'}</span></div>`;
};

const renderStylesPanel = () => `
  <div class="panel-heading"><div><span class="eyebrow">REFERENCE LIBRARY</span><h2>Styles</h2></div></div>
  <div class="character-grid">
    <button class="character-card character-add-card" data-action="create-style" type="button"><span>${icons.plus}</span><strong>New style</strong></button>
    ${styleLibrary.load().map((style) => `<button class="character-card" data-style-id="${style.id}" type="button"><div class="character-sheet">${renderStyleVisual(style)}</div><div class="character-card-copy"><strong>${escapeHtml(style.name)}</strong><span>${style.lockedVersionId ? 'Locked' : style.status} · ${style.versions.length} ${style.versions.length === 1 ? 'version' : 'versions'}</span></div>${style.lockedVersionId ? '<span class="character-lock">LOCKED</span>' : ''}</button>`).join('')}
  </div>
  ${state.styles.length ? '' : '<div class="panel-empty"><span>Lock reusable visual references for future generations.</span></div>'}
  <div class="panel-footnote"><span class="fal-dot"></span><span>Auto-attached to new generations</span><span class="status-pill">local</span></div>
`;

const renderCharacterModal = () => {
  if (state.characterModalMode === 'composer') return renderCharacterComposerModal();
  const character = characterById(state.selectedCharacterId);
  if (!character) return '';
  const activeVersion = characterVersion(character);
  const sheet = activeVersion ? mediaById(activeVersion.sheetAssetId) : null;
  const imageAssets = state.media.filter((asset) => asset.kind === 'image');
  return `
    <div class="modal-backdrop" data-action="close-character-modal">
      <section class="character-modal" role="dialog" aria-modal="true" aria-labelledby="characterModalTitle">
        <div class="modal-head"><div><span class="eyebrow">CHARACTER DETAIL</span><h2 id="characterModalTitle">${escapeHtml(character.name)}</h2></div><div class="modal-head-actions"><button class="danger-button character-delete-button" data-action="delete-character" type="button">${icons.close} Delete</button><button class="small-icon-button" data-action="close-character-modal" aria-label="Close" type="button">${icons.close}</button></div></div>
        <div class="character-detail-grid">
          <div class="character-detail-sheet">${sheet ? renderMediaVisual(sheet) : `<div class="character-placeholder">${icons.magic}<span>Add an image version</span></div>`}${character.lockedVersionId ? '<span class="character-lock detail-lock">LOCKED VERSION</span>' : ''}</div>
          <div class="character-detail-copy">
            <form class="character-name-form" data-character-name-form>
              <label for="characterName">Character name</label>
              <div><input id="characterName" name="name" value="${escapeHtml(character.name)}" required /><button class="button ghost" type="submit">Rename</button></div>
            </form>
            <div class="character-status-row"><span>Status</span><strong>${escapeHtml(character.status)}</strong><span>Active version</span><strong>${activeVersion ? escapeHtml(activeVersion.id) : 'None'}</strong></div>
            <div class="character-version-actions">
              <label for="characterVersionAsset">Create a version from imported media</label>
              <div><select id="characterVersionAsset" ${imageAssets.length ? '' : 'disabled'}>${imageAssets.map((asset) => `<option value="${asset.id}">${escapeHtml(asset.name)}</option>`).join('')}</select><button class="button ghost" data-action="record-character-version" type="button" ${imageAssets.length ? '' : 'disabled'}>Add version</button></div>
              ${imageAssets.length ? '' : '<small>Import an image in Media first.</small>'}
            </div>
            <div class="character-lock-actions">${activeVersion ? character.lockedVersionId ? '<button class="button ghost" data-action="unlock-character" type="button">Unlock character</button>' : '<button class="button primary" data-action="lock-character" type="button">Lock character</button>' : '<span>Add a version before locking this identity.</span>'}</div>
          </div>
        </div>
        <div class="character-version-list"><div class="version-list-head"><strong>Immutable versions</strong><span>${character.versions.length}</span></div>${character.versions.length ? character.versions.map((version, index) => { const asset = mediaById(version.sheetAssetId); const isActive = version.id === activeVersion?.id; return `<button class="character-version-row ${isActive ? 'active' : ''}" data-action="activate-character-version" data-version-id="${version.id}" type="button" ${character.lockedVersionId ? 'disabled' : ''}><span class="version-number">V${index + 1}</span><div class="version-thumb">${asset ? renderMediaVisual(asset) : icons.image}</div><div><strong>${escapeHtml(asset?.name || 'Missing sheet asset')}</strong><span>${escapeHtml(version.modelId)} · ${new Date(version.createdAt).toLocaleString()}</span></div><span>${version.id === character.lockedVersionId ? 'Locked' : isActive ? 'Active' : 'Select'}</span></button>`; }).join('') : '<div class="version-empty">Versions are append-only. Existing versions are never overwritten.</div>'}</div>
      </section>
    </div>
  `;
};

const renderStyleModal = () => {
  const style = styleById(state.selectedStyleId);
  if (!style) return '';
  const activeVersion = styleVersion(style);
  const imageAssets = state.media.filter((asset) => asset.kind === 'image');
  return `
    <div class="modal-backdrop" data-action="close-style-modal">
      <section class="character-modal" role="dialog" aria-modal="true" aria-labelledby="styleModalTitle">
        <div class="modal-head"><div><span class="eyebrow">STYLE DETAIL</span><h2 id="styleModalTitle">${escapeHtml(style.name)}</h2></div><div class="modal-head-actions"><button class="danger-button character-delete-button" data-action="delete-style" type="button">${icons.close} Delete</button><button class="small-icon-button" data-action="close-style-modal" aria-label="Close" type="button">${icons.close}</button></div></div>
        <div class="character-detail-grid">
          <div class="character-detail-sheet">${activeVersion ? renderStyleVisual(style) : `<div class="character-placeholder">${icons.magic}<span>Add reference images</span></div>`}${style.lockedVersionId ? '<span class="character-lock detail-lock">LOCKED VERSION</span>' : ''}</div>
          <div class="character-detail-copy">
            <form class="style-name-form" data-style-name-form>
              <label for="styleName">Style name</label>
              <div><input id="styleName" name="name" value="${escapeHtml(style.name)}" required /><button class="button ghost" type="submit">Rename</button></div>
            </form>
            <div class="character-status-row"><span>Status</span><strong>${escapeHtml(style.status)}</strong><span>Active version</span><strong>${activeVersion ? escapeHtml(activeVersion.id) : 'None'}</strong></div>
            <div class="character-version-actions">
              <label for="styleVersionAssets">Create a version from imported images</label>
              <div><select id="styleVersionAssets" multiple size="${Math.min(4, Math.max(2, imageAssets.length))}" ${imageAssets.length ? '' : 'disabled'}>${imageAssets.map((asset) => `<option value="${asset.id}">${escapeHtml(asset.name)}</option>`).join('')}</select><button class="button ghost" data-action="record-style-version" type="button" ${imageAssets.length ? '' : 'disabled'}>Add version</button></div>
              ${imageAssets.length ? '<small>Choose one or more images, then add an immutable reference version.</small>' : '<small>Import an image in Media first.</small>'}
            </div>
            <div class="character-lock-actions">${activeVersion ? style.lockedVersionId ? '<button class="button ghost" data-action="unlock-style" type="button">Unlock style</button>' : '<button class="button primary" data-action="lock-style" type="button">Lock style</button>' : '<span>Add a reference version before locking this style.</span>'}</div>
          </div>
        </div>
        <div class="character-version-list"><div class="version-list-head"><strong>Immutable versions</strong><span>${style.versions.length}</span></div>${style.versions.length ? style.versions.map((version, index) => { const asset = version.referenceAssetIds.map(mediaById).find(Boolean); const isActive = version.id === activeVersion?.id; return `<button class="character-version-row ${isActive ? 'active' : ''}" data-action="activate-style-version" data-version-id="${version.id}" type="button" ${style.lockedVersionId ? 'disabled' : ''}><span class="version-number">V${index + 1}</span><div class="version-thumb">${asset ? renderMediaVisual(asset) : icons.image}</div><div><strong>${escapeHtml(asset?.name || 'Missing reference asset')}</strong><span>${version.referenceAssetIds.length} reference${version.referenceAssetIds.length === 1 ? '' : 's'} · ${new Date(version.createdAt).toLocaleString()}</span></div><span>${version.id === style.lockedVersionId ? 'Locked' : isActive ? 'Active' : 'Select'}</span></button>`; }).join('') : '<div class="version-empty">Versions are append-only. Existing references are never overwritten.</div>'}</div>
      </section>
    </div>
  `;
};

const styleApplicationBatchById = (batchId) => project.styleApplications?.batches.find((batch) => batch.id === batchId) || null;

const renderStyleApplicationModal = () => {
  const modal = state.styleApplicationModal;
  if (!modal) return '';
  const batch = modal.batchId ? styleApplicationBatchById(modal.batchId) : null;
  if (batch) {
    const completed = batch.jobs.filter((job) => job.status === 'completed').length;
    const failed = batch.jobs.filter((job) => job.status === 'failed').length;
    return `
      <div class="modal-backdrop" data-action="close-style-application-modal">
        <section class="character-modal style-application-modal" role="dialog" aria-modal="true" aria-labelledby="styleApplicationTitle">
          <div class="modal-head"><div><span class="eyebrow">APPLY STYLE</span><h2 id="styleApplicationTitle">${escapeHtml(batch.styleName)}</h2></div><button class="small-icon-button" data-action="close-style-application-modal" aria-label="Close" type="button">${icons.close}</button></div>
          <div class="style-application-progress" aria-live="polite"><div><strong>${completed} of ${batch.jobs.length} complete</strong><span>${failed ? `${failed} failed · completed results are already available` : batch.status === 'completed' ? 'All styled media is ready for review' : 'Jobs run independently, up to 3 at a time'}</span></div><span class="status-pill ${escapeHtml(batch.status)}">${escapeHtml(batch.status)}</span></div>
          <div class="style-clip-list">${batch.jobs.map((job) => `
            <article class="style-clip-row ${escapeHtml(job.status)}">
              <div class="style-clip-thumb">${renderMediaVisual(mediaById(job.sourceAssetId) || {kind: job.mediaKind})}</div>
              <div><strong>${escapeHtml(job.sourceAssetName)}</strong><span>${escapeHtml(job.mediaKind)} · ${formatTime(job.sourceClip.duration)} · ${escapeHtml(job.stage)}</span>${job.error ? `<small>${escapeHtml(job.error)}</small>` : ''}</div>
              ${job.status === 'failed' ? `<button class="button ghost" data-action="retry-style-application" data-batch-id="${escapeHtml(batch.id)}" data-job-id="${escapeHtml(job.id)}" type="button">Retry</button>` : `<span class="style-job-state">${job.status === 'completed' ? 'Ready' : job.status}</span>`}
            </article>`).join('')}</div>
          <div class="style-application-note"><strong>Review on the timeline</strong><span>Each finished result appears in Imports and in a ghost rail above its source clip. Accept or reject each proposal independently.</span></div>
          <div class="style-application-actions"><button class="button primary" data-action="close-style-application-modal" type="button">Done</button></div>
        </section>
      </div>`;
  }

  const styles = state.styles.filter((style) => styleReferenceImageIds(style).length);
  const selectedStyle = styles.find((style) => style.id === modal.styleId) || styles[0] || null;
  const selectedVersion = styleVersion(selectedStyle);
  const referenceAssets = (selectedVersion?.referenceAssetIds || []).map(mediaById).filter((asset) => asset?.kind === 'image');
  const selectedReferenceIds = new Set(modal.referenceAssetIds || []);
  const selectedClips = (modal.clipIds || []).map(clipById).filter(Boolean);
  const clipEntries = selectedClips.map((clip) => {
    const asset = mediaById(clip.assetId);
    return {clip, asset, eligibility: styleApplicationEligibility({clip, asset, project})};
  });
  const eligibleEntries = clipEntries.filter((entry) => entry.eligibility.eligible);
  const estimatedUsd = eligibleEntries.reduce((total, {clip, asset}) => {
    const unitPrice = asset.kind === 'video' ? modal.prices?.video : modal.prices?.image;
    return Number.isFinite(unitPrice) ? total + unitPrice * (asset.kind === 'video' ? clip.duration : 1) : total;
  }, 0);
  const hasKnownCost = eligibleEntries.some(({asset}) => Number.isFinite(asset.kind === 'video' ? modal.prices?.video : modal.prices?.image));
  return `
    <div class="modal-backdrop" data-action="close-style-application-modal">
      <section class="character-modal style-application-modal" role="dialog" aria-modal="true" aria-labelledby="styleApplicationTitle">
        <div class="modal-head"><div><span class="eyebrow">APPLY STYLE</span><h2 id="styleApplicationTitle">Restyle ${selectedClips.length} selected clip${selectedClips.length === 1 ? '' : 's'}</h2></div><button class="small-icon-button" data-action="close-style-application-modal" aria-label="Close" type="button">${icons.close}</button></div>
        <form class="style-application-form" data-style-application-form>
          <div class="style-application-grid">
            <div>
              <label for="styleApplicationStyle">Style</label>
              <select id="styleApplicationStyle" name="styleId" ${styles.length ? '' : 'disabled'}>${styles.map((style) => `<option value="${escapeHtml(style.id)}" ${style.id === selectedStyle?.id ? 'selected' : ''}>${escapeHtml(style.name)}${style.lockedVersionId ? ' · locked' : ''}</option>`).join('')}</select>
              ${styles.length ? '' : '<small>Create a style and add an image reference version first.</small>'}
            </div>
            <div class="style-model-summary"><span>Video model</span><strong>Kling O3 Edit · Standard</strong><code>${escapeHtml(DEFAULT_STYLE_VIDEO_MODEL)}</code><span>Images</span><strong>Nano Banana 2 Edit</strong></div>
          </div>
          <div><label>Selected clips</label><div class="style-clip-list compact">${clipEntries.map(({clip, asset, eligibility}) => `<article class="style-clip-row ${eligibility.eligible ? 'eligible' : 'unsupported'}"><div class="style-clip-thumb">${asset ? renderMediaVisual(asset) : icons.image}</div><div><strong>${escapeHtml(asset?.name || 'Missing media')}</strong><span>${escapeHtml(asset?.kind || 'unknown')} · ${formatTime(clip.duration)} · ${escapeHtml(clip.trackId)}</span>${eligibility.eligible ? '' : `<small>${escapeHtml(eligibility.reason)}</small>`}</div><span class="style-job-state">${eligibility.eligible ? 'Ready' : 'Unsupported'}</span></article>`).join('')}</div></div>
          <fieldset class="composer-references style-reference-picker" ${referenceAssets.length ? '' : 'disabled'}><legend>Style references · choose up to 4</legend><div class="reference-options">${referenceAssets.map((asset) => `<label><input type="checkbox" data-style-reference-id="${escapeHtml(asset.id)}" ${selectedReferenceIds.has(asset.id) ? 'checked' : ''} /><span class="reference-option-thumb">${renderMediaVisual(asset)}</span><span>${escapeHtml(asset.name)}</span></label>`).join('')}</div></fieldset>
          <div class="composer-fields"><label for="styleApplicationInstruction">Preservation instruction</label><textarea id="styleApplicationInstruction" rows="3">${escapeHtml(modal.instruction)}</textarea></div>
          <label class="style-audio-option"><input id="styleApplicationAudio" type="checkbox" ${modal.preserveAudio ? 'checked' : ''} /><span><strong>Preserve source audio</strong><small>Detached-audio clips remain muted in the styled video.</small></span></label>
          <div class="style-application-cost"><div><span>Eligible</span><strong>${eligibleEntries.length} / ${clipEntries.length}</strong></div><div><span>Estimated provider cost</span><strong>${modal.loadingPrices ? 'Loading…' : hasKnownCost ? formatUsd(estimatedUsd) : 'Unavailable'}</strong></div></div>
          ${modal.error ? `<p class="style-application-error" role="alert">${escapeHtml(modal.error)}</p>` : ''}
          <div class="style-application-actions"><button class="button ghost" data-action="close-style-application-modal" type="button">Cancel</button><button class="button primary" type="submit" ${!selectedStyle || !selectedReferenceIds.size || !eligibleEntries.length || modal.submitting ? 'disabled' : ''}>${modal.submitting ? 'Starting…' : `Apply ${escapeHtml(selectedStyle?.name || 'style')}`}</button></div>
        </form>
      </section>
    </div>`;
};

const renderCharacterComposerModal = () => {
  const job = characterGenerationController?.snapshot() || {status: 'idle', providerStatus: null, attempt: 0, error: null};
  const isWorking = job.status === 'generating' || job.status === 'retrying';
  const input = state.characterComposerInput;
  const imageAssets = state.media.filter((asset) => asset.kind === 'image');
  const action = job.status === 'failed'
    ? '<button class="button primary" data-action="retry-character-generation" type="button">Retry generation</button>'
    : `<button class="button primary" type="submit" ${isWorking ? 'disabled' : ''}>${isWorking ? 'Generating…' : 'Generate character sheet'}</button>`;
  return `
    <div class="modal-backdrop" data-action="close-character-modal">
      <section class="character-modal composer-modal" role="dialog" aria-modal="true" aria-labelledby="characterComposerTitle">
        <div class="modal-head"><div><span class="eyebrow">NEW CHARACTER</span><h2 id="characterComposerTitle">Character composer</h2></div><button class="small-icon-button" data-action="close-character-modal" aria-label="Close" type="button">${icons.close}</button></div>
        <form class="character-composer-form" data-character-composer-form>
          <div class="composer-fields">
            <label for="composerName">Character name</label>
            <input id="composerName" name="name" value="${escapeHtml(input.name)}" placeholder="Marlow the fox" ${isWorking ? 'disabled' : ''} required />
            <label for="composerPrompt">Visual prompt</label>
            <textarea id="composerPrompt" name="prompt" rows="5" placeholder="Describe appearance, clothing, proportions, and expressions…" ${isWorking ? 'disabled' : ''} required>${escapeHtml(input.prompt)}</textarea>
            <label for="composerStyleNotes">Style notes</label>
            <textarea id="composerStyleNotes" name="styleNotes" rows="3" placeholder="Palette, line quality, camera, rendering style…" ${isWorking ? 'disabled' : ''}>${escapeHtml(input.styleNotes)}</textarea>
          </div>
          <fieldset class="composer-references" ${isWorking ? 'disabled' : ''}><legend>Optional media references</legend>${imageAssets.length ? `<div class="reference-options">${imageAssets.map((asset) => `<label><input type="checkbox" name="referenceAssetIds" value="${asset.id}" ${input.referenceAssetIds.includes(asset.id) ? 'checked' : ''}/><span class="reference-option-thumb">${renderMediaVisual(asset)}</span><span>${escapeHtml(asset.name)}</span></label>`).join('')}</div>` : '<p>Import images in Media to use them as references.</p>'}</fieldset>
          <div class="generation-job-card ${job.status}">
            <span class="job-state-dot"></span>
            <div><strong>${job.status === 'idle' ? 'Ready to compose' : job.status === 'failed' ? 'Generation failed' : job.status === 'ready' ? 'Character sheet ready' : job.status === 'retrying' ? 'Retrying character sheet' : 'Generating character sheet'}</strong><span>${job.status === 'idle' ? useFakeCharacterAdapter ? 'The local adapter creates a deterministic sheet without network calls.' : 'Nano Banana 2 will run through the credential-safe local server.' : job.status === 'failed' ? escapeHtml(job.error || 'Unknown generation error') : `${escapeHtml(job.providerStatus || 'queued')} · attempt ${job.attempt}`}</span></div>
          </div>
          <div class="composer-foot"><small>${useFakeCharacterAdapter ? 'Deterministic test path: include <code>[fail]</code> in the prompt, then remove it before retrying.' : 'The browser sends no model ID or FAL credential. Queue polling and result extraction stay server-side.'}</small>${action}</div>
        </form>
      </section>
    </div>
  `;
};

const renderGapFillCard = () => `<div class="transition-card gap-fill" draggable="true" data-transition-type="${FILL_GAP_TRANSITION_KEY}" title="Drop between two clips to generate a bridging shot from the last frame of one to the first frame of the next"><div class="transition-thumb" aria-hidden="true">⧉</div><div class="transition-card-copy"><strong>Fill gap</strong><span>AI bridge · ${FILL_GAP_DURATION}s</span></div></div>`;

const renderTransitionCard = (definition, isCustom) => `<div class="transition-card ${isCustom ? 'custom' : ''}" draggable="true" data-transition-type="${escapeHtml(definition.key)}" title="Drag onto the timeline"><div class="transition-thumb" aria-hidden="true">${escapeHtml(definition.glyph || '◐')}</div><div class="transition-card-copy"><strong>${escapeHtml(definition.label)}</strong><span>${definition.defaultDuration}s</span></div>${isCustom ? `<button class="transition-card-delete" data-action="delete-transition-def" data-transition-key="${escapeHtml(definition.key)}" draggable="false" title="Delete transition" aria-label="Delete ${escapeHtml(definition.label)}" type="button">${icons.close}</button>` : ''}</div>`;

const renderTransitionsPanel = () => `
  <div class="panel-heading"><div><span class="eyebrow">CLIP BLENDS</span><h2>Transitions</h2></div></div>
  <div class="transition-list">${renderGapFillCard()}${Object.values(BUILT_IN_TRANSITIONS).map((definition) => renderTransitionCard(definition, false)).join('')}${state.customTransitions.map((definition) => renderTransitionCard(definition, true)).join('')}<button class="transition-card add-card" data-action="open-transition-composer" type="button"><div class="transition-thumb" aria-hidden="true">${icons.plus}</div><div class="transition-card-copy"><strong>AI transition</strong><span>Describe your own</span></div></button></div>
  <div class="scene-empty"><div class="scene-line"></div><span>Drop between two clips to blend them, or at a lone clip edge to fade to black. Drops snap to the nearest clip edge.</span></div>
`;

const renderTransitionComposerModal = () => {
  const status = state.agentLlmStatus;
  const unconfigured = status && !status.configured;
  const composer = state.transitionComposerStatus;
  const isWorking = composer.phase === 'generating';
  const input = state.transitionComposerInput;
  return `
    <div class="modal-backdrop" data-action="close-transition-composer">
      <section class="character-modal composer-modal" role="dialog" aria-modal="true" aria-labelledby="transitionComposerTitle">
        <div class="modal-head"><div><span class="eyebrow">NEW TRANSITION</span><h2 id="transitionComposerTitle">AI transition</h2></div><button class="small-icon-button" data-action="close-transition-composer" aria-label="Close" type="button">${icons.close}</button></div>
        <form class="character-composer-form" data-transition-composer-form>
          <div class="composer-fields">
            <label for="transitionComposerName">Transition name</label>
            <input id="transitionComposerName" name="name" value="${escapeHtml(input.name)}" placeholder="Iris open" ${isWorking ? 'disabled' : ''} required />
            <label for="transitionComposerPrompt">Describe the transition</label>
            <textarea id="transitionComposerPrompt" name="prompt" rows="5" placeholder="A circular reveal of the incoming clip, expanding from the center of the frame…" ${isWorking ? 'disabled' : ''} required>${escapeHtml(input.prompt)}</textarea>
          </div>
          <div class="generation-job-card ${composer.phase === 'error' ? 'failed' : composer.phase === 'generating' ? 'generating' : 'idle'}">
            <span class="job-state-dot"></span>
            <div><strong>${composer.phase === 'error' ? 'Generation failed' : isWorking ? 'Generating transition' : 'Ready to compose'}</strong><span>${composer.phase === 'error' ? escapeHtml(composer.error || 'Unknown generation error') : isWorking ? 'The model is drafting keyframes for your transition…' : 'The model turns your description into animation keyframes you can drag onto the timeline.'}</span></div>
          </div>
          ${unconfigured ? '<p class="agent-prompt-note error">Set LLM_BASE_URL (and LLM_API_KEY) in .env, then restart the server.</p>' : ''}
          <div class="composer-foot"><small>Built-in transitions are sent as examples; the result is saved to this project.</small><button class="button primary" type="submit" ${isWorking || unconfigured ? 'disabled' : ''}>${isWorking ? 'Generating…' : 'Generate transition'}</button></div>
        </form>
      </section>
    </div>
  `;
};

const renderScriptPanel = () => {
  const script = state.agentWorkspace.script;
  const storyboardBeats = (project.storyboard?.nodes || [])
    .filter((node) => node.kind === 'act' && (state.activeActId === 'all' || node.sceneId === state.activeActId))
    .toSorted((left, right) => left.actNumber - right.actNumber)
    .flatMap((act) => (act.beats || []).map((beat) => ({act, beat})));
  const storyboardMarkup = storyboardBeats.map(({act, beat}, index) => `
    <form class="script-beat storyboard-script-beat" data-storyboard-script-form data-act-id="${escapeHtml(act.id)}" data-beat-id="${escapeHtml(beat.id)}">
      <div class="script-beat-head"><span>${String(index + 1).padStart(2, '0')}</span><strong>${escapeHtml(act.title)}</strong></div>
      <p class="storyboard-script-source">${escapeHtml(beat.text)}</p>
      <textarea name="text" rows="6" aria-label="Screenplay for ${escapeHtml(beat.text)}" placeholder="No screenplay written for this beat yet.">${escapeHtml(beat.screenplay?.text || '')}</textarea>
      <div class="script-beat-foot"><span>${beat.hero?.assetId ? 'Still ready' : 'No still'}</span><button class="button ghost" type="submit">Save screenplay</button></div>
    </form>`).join('');
  const legacyMarkup = script.beats.map((beat, index) => `<form class="script-beat" data-script-beat-form data-beat-id="${escapeHtml(beat.id)}"><div class="script-beat-head"><span>${String(index + 1).padStart(2, '0')}</span><select name="sceneId" aria-label="Scene for beat"><option value="">No scene link</option>${project.scenes.map((scene) => `<option value="${escapeHtml(scene.id)}" ${scene.id === beat.sceneId ? 'selected' : ''}>${escapeHtml(scene.name)}</option>`).join('')}</select></div><textarea name="text" rows="3" aria-label="Script beat">${escapeHtml(beat.text)}</textarea><div class="script-beat-foot"><input name="clipIds" value="${escapeHtml(beat.clipIds.join(', '))}" placeholder="Clip IDs (optional)" /><button class="button ghost" type="submit">Save beat</button></div></form>`).join('');
  return `
    <div class="panel-heading"><div><span class="eyebrow">SCRIPT VIEW</span><h2>Script</h2></div></div>
    <form class="script-title-form" data-script-title-form><input name="title" value="${escapeHtml(script.title)}" aria-label="Script title" /><button class="button ghost" type="submit">Save</button></form>
    <div class="script-beat-list">
      ${storyboardMarkup || legacyMarkup || '<div class="panel-empty"><span>Add beats in the storyboard, then write their screenplay here.</span></div>'}
      ${storyboardMarkup && legacyMarkup ? `<div class="script-legacy-heading">Unlinked legacy beats</div>${legacyMarkup}` : ''}
    </div>
    ${project.storyboard ? '' : '<form class="script-add-form" data-script-add-form><textarea name="text" rows="3" placeholder="Write the next beat…" required></textarea><button class="button primary" type="submit">Add script beat</button></form>'}
  `;
};

const renderAgentPane = () => {
  const messages = scopedMessages();
  const entries = projectContext.getIndex().entries;
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const renderFrameResults = (frameIds) => (frameIds || []).map((id) => {
    const result = state.videoSearchResults.find((candidate) => candidate.id === id) || videoIndexer.getCachedFrame(id);
    return result
      ? `<button type="button" class="agent-result frame-result" data-video-frame-id="${escapeHtml(id)}"><strong>${escapeHtml(result.videoName || result.videoAssetId)}</strong><small>${formatTime(result.time)} · ${escapeHtml(result.annotation || '')}</small></button>`
      : `<span class="agent-result-missing">Frame ${escapeHtml(id)} is indexed in the local video catalog.</span>`;
  }).join('');
  return `<aside class="agent-pane ${state.agentPaneOpen ? '' : 'is-hidden'}" aria-label="Agent workspace"><div class="agent-pane-head"><div><span class="eyebrow">PROJECT AGENT</span><h2>Agent</h2></div><button class="small-icon-button" data-action="toggle-agent-pane" aria-label="Close agent" type="button">${icons.close}</button></div><div class="agent-messages">${messages.length ? messages.map((message) => `<article class="agent-message ${message.role}"><span>${escapeHtml(message.role)}</span><p>${escapeHtml(message.text)}</p>${message.resultIds.length || message.frameIds?.length ? `<div class="agent-results">${message.resultIds.map((id) => { const entry = entryById.get(id); return entry ? `<button type="button" class="agent-result" data-agent-result-id="${escapeHtml(id)}"><strong>${escapeHtml(entry.description || entry.text)}</strong><small>${escapeHtml(entry.type)}${entry.start !== undefined ? ` · ${formatTime(entry.start)}` : ''}</small></button>` : ''; }).join('')}${renderFrameResults(message.frameIds)}</div>` : ''}</article>`).join('') : '<div class="agent-empty"><span>${icons.magic}</span><p>Ask about shots, characters, scenes, or provenance.</p><small>Search is grounded in this project’s accepted timeline and local video-frame annotations.</small></div>'}</div><form class="agent-form" data-agent-form><textarea name="query" rows="3" placeholder="Find the shot where the fox jumps…" required></textarea><button class="button primary" type="submit">Search project</button></form></aside>`;
};

const RUN_STATUS_LABELS = {running: 'Running', completed: 'Done', failed: 'Failed', cancelled: 'Stopped'};

const renderAgentPromptModal = () => {
  const status = state.agentLlmStatus;
  const unconfigured = status && !status.configured;
  const clipContext = buildSelectedClipContext(project, [...state.selectedClipIds]);
  return `
    <div class="modal-backdrop" data-action="close-agent-prompt">
      <section class="agent-prompt-modal" role="dialog" aria-modal="true" aria-labelledby="agentPromptTitle">
        <div class="modal-head"><div><span class="eyebrow">TIMELINE AGENT</span><h2 id="agentPromptTitle">What should the agent do?</h2></div><button class="small-icon-button" data-action="close-agent-prompt" aria-label="Close" type="button">${icons.close}</button></div>
        <form class="agent-prompt-form" data-agent-prompt-form>
          ${renderAgentClipContext(clipContext)}
          <textarea id="agentPromptInput" name="prompt" rows="3" placeholder="Trim the dead air at the start, then tighten the middle section…" required ${unconfigured ? 'disabled' : ''}>${escapeHtml(state.agentPromptDraft)}</textarea>
          ${unconfigured ? '<p class="agent-prompt-note error">Set LLM_BASE_URL (and LLM_API_KEY) in .env, then restart the server.</p>' : '<p class="agent-prompt-note">Enter to launch · Shift+Enter for a new line</p>'}
        </form>
      </section>
    </div>
  `;
};

const renderAgentStep = (step, index, steps) => {
  const isLast = index === steps.length - 1;
  const label = step.type === 'tool' ? step.name : step.type === 'thought' ? 'Thought' : 'Summary';
  const detail = step.type === 'tool'
    ? `${step.args && Object.keys(step.args).length ? `<code>${escapeHtml(JSON.stringify(step.args))}</code>` : ''}${step.result !== undefined ? `<details><summary>${step.status === 'error' ? 'Error' : 'Result'}</summary><code>${escapeHtml(JSON.stringify(step.result).slice(0, 400))}</code></details>` : ''}`
    : `<p>${escapeHtml(step.text || '')}</p>`;
  return `<li class="agent-step ${step.status}"><span class="agent-step-marker"><span class="agent-step-dot"></span>${isLast ? '' : '<span class="agent-step-line"></span>'}</span><div class="agent-step-body"><strong>${escapeHtml(label)}</strong>${detail}</div></li>`;
};

const renderAgentClipContext = (clipContext = []) => {
  if (!clipContext.length) return '';
  return `
    <section class="agent-clip-context" aria-label="Selected clip context">
      <div class="agent-clip-context-head"><span>Selected context</span><strong>${clipContext.length} clip${clipContext.length === 1 ? '' : 's'}</strong></div>
      <div class="agent-context-clips">
        ${clipContext.map((entry) => {
          const asset = mediaById(entry.asset.assetId);
          const visual = asset ? renderMediaVisual(asset) : `<div class="offline-thumb">${icons.film}</div>`;
          return `<div class="agent-context-clip" data-agent-context-clip-id="${escapeHtml(entry.clipId)}"><div class="agent-context-thumb">${visual}</div><div><strong>${escapeHtml(entry.asset.name || entry.clipId)}</strong><small>${escapeHtml(entry.timeline.trackId)} · ${formatTime(entry.timeline.start)}–${formatTime(entry.timeline.end)}</small></div></div>`;
        }).join('')}
      </div>
      <p>Clip IDs, timing, source ranges, asset metadata, and provenance will be sent with your request.</p>
    </section>`;
};

const renderAgentRunCard = () => {
  const run = agentRuns.get(state.expandedAgentRunId);
  if (!run) return '';
  return `
    <section class="agent-run-card" aria-label="Agent run detail">
      <div class="agent-run-head">
        <div><span class="eyebrow">AGENT RUN · ${escapeHtml(RUN_STATUS_LABELS[run.status] || run.status)}</span><h2>${escapeHtml(run.prompt)}</h2></div>
        <div class="agent-run-head-actions">
          ${run.status === 'running' ? `<button class="toolbar-button danger" data-action="stop-agent-run" type="button">${icons.stop} Stop</button>` : ''}
          <button class="small-icon-button" data-action="close-agent-run-card" aria-label="Close run detail" type="button">${icons.close}</button>
        </div>
      </div>
      ${renderAgentClipContext(run.clipContext)}
      <ol class="agent-stepper" data-agent-stepper>
        ${run.steps.length ? run.steps.map((step, index) => renderAgentStep(step, index, run.steps)).join('') : `<li class="agent-step running"><span class="agent-step-marker"><span class="agent-step-dot"></span></span><div class="agent-step-body"><strong>Starting…</strong></div></li>`}
        ${run.status === 'failed' && run.error ? `<li class="agent-step error"><span class="agent-step-marker"><span class="agent-step-dot"></span></span><div class="agent-step-body"><strong>Failed</strong><p>${escapeHtml(run.error)}</p></div></li>` : ''}
        ${run.status === 'cancelled' ? '<li class="agent-step error"><span class="agent-step-marker"><span class="agent-step-dot"></span></span><div class="agent-step-body"><strong>Stopped by you</strong></div></li>' : ''}
      </ol>
    </section>
  `;
};

const renderAgentRail = () => {
  const runs = agentRuns.list();
  return `
    <aside class="agent-rail" aria-label="Editing agents">
      ${runs.length
        ? runs.map((run) => `<button class="agent-rail-item ${run.id === state.expandedAgentRunId ? 'active' : ''}" data-agent-run-id="${escapeHtml(run.id)}" title="${escapeHtml(run.prompt)}" aria-label="Agent: ${escapeHtml(run.prompt)}" type="button">${icons.robot}<span class="agent-status-dot ${run.status}"></span></button>`).join('')
        : '<div class="agent-rail-empty">no active agents</div>'}
    </aside>
  `;
};

const openAgentPrompt = () => {
  state.agentPromptModalOpen = true;
  renderApp();
  if (!state.agentLlmStatus) {
    fetch('/api/agent/status')
      .then((response) => response.json())
      .then((status) => { state.agentLlmStatus = status; renderApp(); })
      .catch(() => { state.agentLlmStatus = {configured: false}; renderApp(); });
  }
};

const openTransitionComposer = () => {
  state.isTransitionComposerOpen = true;
  state.transitionComposerStatus = {phase: 'idle', error: ''};
  renderApp();
  if (!state.agentLlmStatus) {
    fetch('/api/agent/status')
      .then((response) => response.json())
      .then((status) => { state.agentLlmStatus = status; renderApp(); })
      .catch(() => { state.agentLlmStatus = {configured: false}; renderApp(); });
  }
};

const closeTransitionComposer = () => {
  if (state.transitionComposerStatus.phase === 'generating') return;
  state.isTransitionComposerOpen = false;
  state.transitionComposerInput = {name: '', prompt: ''};
  state.transitionComposerStatus = {phase: 'idle', error: ''};
  renderApp();
};

const parseTransitionResponse = (response) => {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('The model returned an empty response.');
  const stripped = content.replace(/```[a-z]*\n?/gi, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model reply did not contain a JSON object.');
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    throw new Error('The model reply was not valid JSON.');
  }
};

const submitTransitionComposer = async (event) => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const name = String(formData.get('name') || '').trim();
  const prompt = String(formData.get('prompt') || '').trim();
  if (!name || !prompt) return;
  state.transitionComposerInput = {name, prompt};
  state.transitionComposerStatus = {phase: 'generating', error: ''};
  renderApp();
  try {
    const messages = buildTransitionGenerationMessages({
      name,
      prompt,
      existingKeys: state.customTransitions.map((definition) => definition.key),
    });
    const response = await callLlm({messages});
    const definition = parseTransitionResponse(response);
    definition.label = name;
    updateProject({type: 'transition-def/create', definition, promptText: prompt});
    state.isTransitionComposerOpen = false;
    state.transitionComposerInput = {name: '', prompt: ''};
    state.transitionComposerStatus = {phase: 'idle', error: ''};
    state.activeTab = 'transitions';
  } catch (error) {
    state.transitionComposerStatus = {phase: 'error', error: error?.message || 'Transition generation failed.'};
  }
  renderApp();
};

const deleteTransitionDefinition = (key) => {
  updateProject({type: 'transition-def/remove', key});
  if (state.selectedTransitionId && !state.transitions.some((transition) => transition.id === state.selectedTransitionId)) {
    state.selectedTransitionId = null;
  }
  renderApp();
};

const closeAgentPrompt = () => {
  state.agentPromptModalOpen = false;
  renderApp();
};

const updateAgentRunView = (runId) => {
  const run = agentRuns.get(runId);
  if (!run) return;
  const dot = app.querySelector(`.agent-rail-item[data-agent-run-id="${CSS.escape(runId)}"] .agent-status-dot`);
  if (dot) dot.className = `agent-status-dot ${run.status}`;
  if (state.expandedAgentRunId !== runId) return;
  const stepper = app.querySelector('[data-agent-stepper]');
  if (!stepper) return;
  const openSteps = new Set([...stepper.querySelectorAll('.agent-step')]
    .flatMap((step, index) => (step.querySelector('details')?.open ? [index] : [])));
  stepper.innerHTML = run.steps.map((step, index) => renderAgentStep(step, index, run.steps)).join('');
  stepper.querySelectorAll('.agent-step').forEach((step, index) => {
    const details = step.querySelector('details');
    if (details && openSteps.has(index)) details.open = true;
  });
};

const startEditorAgent = (prompt, {clipContext = buildSelectedClipContext(project, [...state.selectedClipIds])} = {}) => {
  const run = agentRuns.create({prompt, clipContext});
  const controller = new AbortController();
  agentRuns.registerAbort(run.id, controller);
  state.expandedAgentRunId = run.id;
  state.agentStepperScrollTop = 0;
  renderApp();
  let lastRenderedProject = project;
  let lastRenderedTime = state.currentTime;
  let lastRenderedSelection = [...state.selectedClipIds].join('\u0000');
  runEditorAgent({
    prompt,
    selectedClips: clipContext,
    tools: agentTools,
    callLlm,
    signal: controller.signal,
    onStep: (step, existing) => {
      const record = existing
        ? agentRuns.updateStep(run.id, existing.id, step)
        : agentRuns.appendStep(run.id, step);
      const selectionSignature = [...state.selectedClipIds].join('\u0000');
      if (project !== lastRenderedProject || selectionSignature !== lastRenderedSelection) {
        lastRenderedProject = project;
        renderApp();
      } else {
        updateAgentRunView(run.id);
        if (state.currentTime !== lastRenderedTime) refreshPlayheadView();
      }
      lastRenderedTime = state.currentTime;
      lastRenderedSelection = selectionSignature;
      return record;
    },
  })
    .then((result) => {
      agentRuns.setStatus(run.id, 'completed', {summary: result.summary});
      if (result.summary) agentWorkspace.addMessage({
        role: 'assistant',
        text: `Editing agent: ${result.summary}`,
        sceneId: activeActSceneId(),
      });
    })
    .catch((error) => {
      agentRuns.setStatus(
        run.id,
        error instanceof AgentCancelledError ? 'cancelled' : 'failed',
        {error: error instanceof Error ? error.message : String(error)},
      );
    })
    .finally(() => renderApp());
};

const submitAgentPrompt = (event) => {
  event.preventDefault();
  const prompt = state.agentPromptDraft.trim();
  if (!prompt || (state.agentLlmStatus && !state.agentLlmStatus.configured)) return;
  const clipContext = buildSelectedClipContext(project, [...state.selectedClipIds]);
  state.agentPromptModalOpen = false;
  state.agentPromptDraft = '';
  startEditorAgent(prompt, {clipContext});
};

const renderInspectorCharacters = (clip) => {
  const attached = timelineCharacterAttachments.attachedVersions(clip.id);
  const available = timelineCharacterAttachments.lockedVersions(clip.id);
  return `
    <div class="property-group inspector-characters">
      <label>Characters</label>
      ${attached.length ? `<div class="character-chips">${attached.map((entry) => `<span class="character-chip ${entry.missing ? 'missing' : ''}"><span>${entry.missing ? 'Missing version' : `${escapeHtml(entry.characterName)} · V${entry.versionNumber}`}</span><small>${entry.missing ? escapeHtml(entry.versionId) : entry.isLocked ? 'Locked reference' : 'Historical reference'}</small><button data-action="remove-clip-character" data-version-id="${escapeHtml(entry.versionId)}" aria-label="Remove ${escapeHtml(entry.characterName || entry.versionId)}" type="button">${icons.close}</button></span>`).join('')}</div>` : '<p class="inspector-empty-copy">No character versions attached.</p>'}
      ${available.length ? `<div class="attach-character-row"><select id="clipCharacterVersion" aria-label="Locked character version">${available.map((entry) => `<option value="${escapeHtml(entry.versionId)}">${escapeHtml(entry.characterName)} · V${entry.versionNumber} (locked)</option>`).join('')}</select><button class="button ghost" data-action="attach-clip-character" type="button">Add character</button></div>` : '<p class="inspector-empty-copy">Lock a library character to make it available here.</p>'}
      ${attached.length ? '<small class="generation-reference-note">Future generation uses the exact version shown above.</small>' : ''}
    </div>
  `;
};

const renderRegenerationTools = (clip) => {
  if (!clip.provenance?.prompt || !clip.provenance?.modelId) return '';
  const isEditing = state.regenerationEditorClipId === clip.id;
  const jobs = clipRegeneration.listJobs(clip.id);
  const candidates = jobs.filter((job) => job.status === 'completed');
  const activeJobs = jobs.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'failed');
  return `
    <div class="property-group regeneration-tools">
      <label>Prompt as source</label>
      <div class="regeneration-source">
        <div><span>Prompt</span><strong>${escapeHtml(clip.provenance.prompt)}</strong></div>
        <div><span>Model</span><strong>${escapeHtml(clip.provenance.modelId)}</strong></div>
        <div><span>Seed</span><strong>${escapeHtml(clip.provenance.seed ?? 'None')}</strong></div>
        <div><span>Parameters</span><strong>${escapeHtml(JSON.stringify(clip.provenance.params || {}))}</strong></div>
        <div><span>Parent assets</span><strong>${(clip.provenance.parentAssetIds || []).map(escapeHtml).join(', ') || 'None'}</strong></div>
        <div><span>Characters</span><strong>${(clip.provenance.characterVersionIds || []).map(escapeHtml).join(', ') || 'None'}</strong></div>
        <div><span>Styles</span><strong>${(clip.provenance.styleVersionIds || []).map(escapeHtml).join(', ') || 'Auto-locked styles'}</strong></div>
        <div><span>Quality</span><strong>${escapeHtml(clip.provenance.qualityTier || 'draft')}</strong></div>
      </div>
      <div class="regeneration-actions">
        <button class="button ghost" data-action="edit-clip-prompt" type="button">Edit prompt</button>
        <button class="button ghost" data-action="reroll-clip-seed" type="button">Reroll seed</button>
        <button class="button ghost" data-action="change-clip-model" type="button">Same prompt, different model</button>
        <button class="button primary" data-action="compare-clip-variants" type="button">Compare variants</button>
      </div>
      ${isEditing ? `
        <form class="regeneration-form" data-regeneration-form>
          <label for="regenerationPrompt">Prompt</label>
          <textarea id="regenerationPrompt" name="prompt" rows="4" required>${escapeHtml(clip.provenance.prompt)}</textarea>
          <label for="regenerationModel">Model ID</label>
          <input id="regenerationModel" name="modelId" value="${escapeHtml(clip.provenance.modelId)}" required />
          <div class="regeneration-form-row"><div><label for="regenerationSeed">Seed</label><input id="regenerationSeed" name="seed" value="${escapeHtml(clip.provenance.seed ?? '')}" /></div><div><label for="regenerationQuality">Quality tier</label><select id="regenerationQuality" name="qualityTier"><option value="draft" ${normalizeQualityTier(clip.provenance.qualityTier) === 'draft' ? 'selected' : ''}>Draft · 720p / 24fps</option><option value="final" ${normalizeQualityTier(clip.provenance.qualityTier) === 'final' ? 'selected' : ''}>Final · 1080p / 30fps</option></select></div></div>
          <label for="regenerationParams">Parameters (JSON)</label>
          <textarea id="regenerationParams" name="params" rows="2">${escapeHtml(JSON.stringify(clip.provenance.params || {}))}</textarea>
          <label for="regenerationQualitySettings">Quality settings (JSON)</label>
          <textarea id="regenerationQualitySettings" name="qualitySettings" rows="2">${escapeHtml(JSON.stringify(clip.provenance.qualitySettings || qualitySettingsFor(clip.provenance.qualityTier), null, 2))}</textarea>
          <div class="regeneration-form-actions"><button class="button ghost" data-action="cancel-regeneration" type="button">Cancel</button><button class="button primary" type="submit">Generate candidate</button></div>
        </form>
      ` : ''}
      ${activeJobs.length ? `<div class="regeneration-job-list">${activeJobs.map((job) => `<div class="regeneration-job ${job.status}"><span></span><div><strong>${job.status === 'failed' ? 'Generation failed' : `${job.status} candidate`}</strong><small>${job.status === 'failed' ? escapeHtml(job.error) : `${escapeHtml(job.input.modelId)} · seed ${escapeHtml(job.input.seed ?? 'auto')}`}</small></div></div>`).join('')}</div>` : ''}
      ${candidates.length ? `<div class="variant-panel"><div class="variant-panel-head"><strong>Generated variants</strong><span>${candidates.length} candidates · accepted clip unchanged</span></div><div class="variant-grid">${candidates.map((job) => `<article class="variant-card"><div class="variant-visual">${job.output?.asset?.url ? `<img src="${escapeHtml(job.output.asset.url)}" alt="Generated variant" />` : icons.image}</div><div><strong>${escapeHtml(job.input.modelId)}</strong><span>Seed ${escapeHtml(job.output?.seed ?? job.input.seed ?? 'auto')}</span><small>${escapeHtml(Object.keys(job.changedFields).join(', ') || 'same source settings')}</small></div><button class="button ${job.used ? 'ghost' : 'primary'}" data-action="use-regeneration-candidate" data-job-id="${escapeHtml(job.jobId)}" type="button" ${job.used ? 'disabled' : ''}>${job.used ? 'Proposed' : 'Use this version'}</button></article>`).join('')}</div></div>` : ''}
    </div>
  `;
};

const renderSelectedClipInspector = (selected, media) => `
  <div class="selected-preview ${media.kind}">${media.url ? media.kind === 'audio' ? `<div class="audio-orb">${icons.audio}</div>` : renderMediaVisual(media) : `<div class="offline-thumb">${kindIcon(media.kind)}<span>re-import source</span></div>`}<span class="selected-type">${media.kind.toUpperCase()}</span></div>
  <div class="inspector-title"><strong>${escapeHtml(media.name)}</strong><span>${selected.trackId === 'V1' ? 'Video track' : 'Audio track'} · ${formatTime(selected.duration)}</span></div>
  <div class="property-group"><label>Timing</label><div class="property-grid"><div><span>Start</span><strong>${formatTime(selected.start)}</strong></div><div><span>Duration</span><strong>${formatTime(selected.duration)}</strong></div></div></div>
  <div class="property-group"><label>Source</label><div class="source-line"><span class="source-icon">${kindIcon(media.kind)}</span><span>${escapeHtml(media.name)}</span></div></div>
  ${renderRegenerationTools(selected)}
  ${renderInspectorCharacters(selected)}
  <button class="danger-button" data-action="delete-clip" type="button">${icons.close} Remove from timeline</button>
`;

const renderProvenanceReview = (label, clip) => {
  const provenance = clip?.provenance || {};
  const characterVersions = Array.isArray(provenance.characterVersionIds) ? provenance.characterVersionIds : [];
  return `
    <div class="provenance-review">
      <strong>${label}</strong>
      <dl>
        <div><dt>Prompt</dt><dd>${escapeHtml(provenance.prompt || 'None')}</dd></div>
        <div><dt>Model</dt><dd>${escapeHtml(provenance.modelId || 'None')}</dd></div>
        <div><dt>Seed</dt><dd>${escapeHtml(provenance.seed ?? 'None')}</dd></div>
        <div><dt>Parameters</dt><dd>${escapeHtml(JSON.stringify(provenance.params || {}))}</dd></div>
        <div><dt>Parent asset</dt><dd>${escapeHtml(provenance.parentAssetId || 'None')}</dd></div>
        <div><dt>Character versions</dt><dd>${characterVersions.length ? characterVersions.map(escapeHtml).join(', ') : 'None'}</dd></div>
      </dl>
    </div>
  `;
};

const renderRebaseConflicts = (conflicts) => `
  <div class="rebase-conflicts" role="alert">
    <strong>Cannot rebase this proposal</strong>
    <ul>${conflicts.map((conflict) => `<li>${escapeHtml(conflict.message)}</li>`).join('')}</ul>
  </div>
`;

const renderGhostInspector = (ghost) => {
  const diff = diffById(ghost.diffId);
  if (!diff) return '';
  const beforeMedia = ghost.before ? mediaById(ghost.before.assetId) : null;
  const afterMedia = ghost.after ? mediaById(ghost.after.assetId) : null;
  const conflicts = state.rebaseConflicts[diff.id] || [];
  const actionLabel = ghost.type[0].toUpperCase() + ghost.type.slice(1);
  return `
    <div class="diff-review-card ${diff.status}">
      <div class="diff-review-heading"><span>${actionLabel}</span><strong>${escapeHtml(diff.summary)}</strong><small data-review-status>${diff.status === 'stale' ? 'Stale proposal' : 'Pending proposal'} · Base revision ${diff.baseRevision} · ${escapeHtml(diff.source)}</small></div>
      <div class="diff-review-timing">
        <div><span>Before</span><strong>${ghost.before ? `${formatTime(ghost.before.start)} · ${formatTime(ghost.before.duration)}` : 'New clip'}</strong><small>${escapeHtml(beforeMedia?.name || 'No accepted source')}</small></div>
        <div><span>After</span><strong>${ghost.after ? `${formatTime(ghost.after.start)} · ${formatTime(ghost.after.duration)}` : 'Removed'}</strong><small>${escapeHtml(afterMedia?.name || 'No proposed source')}</small></div>
      </div>
      ${renderProvenanceReview('Before provenance', ghost.before)}
      ${renderProvenanceReview('After provenance', ghost.after)}
      ${diff.status === 'stale' && !conflicts.length ? '<p class="stale-warning">The accepted timeline changed. Reconcile this proposal before accepting it.</p>' : ''}
      ${conflicts.length ? renderRebaseConflicts(conflicts) : ''}
      <div class="diff-review-actions">
        <button class="button ghost" data-action="preview-diff" data-diff-id="${diff.id}" type="button" ${state.previewDiffId === diff.id ? 'disabled' : ''}>Preview proposal</button>
        <button class="button ghost" data-action="exit-preview" data-diff-id="${diff.id}" type="button" ${state.previewDiffId !== diff.id ? 'disabled' : ''}>Exit preview</button>
        ${diff.status === 'stale' ? `<button class="button ghost" data-action="rebase-diff" data-diff-id="${diff.id}" type="button" ${conflicts.length ? 'disabled' : ''}>Rebase proposal</button>` : ''}
        <button class="button ghost" data-action="reject-diff" data-diff-id="${diff.id}" type="button">Reject</button>
        <button class="button primary" data-action="accept-diff" data-diff-id="${diff.id}" type="button" ${diff.status === 'stale' ? 'disabled' : ''}>Accept</button>
      </div>
    </div>
  `;
};

const renderContextPanel = () => {
  const ghost = selectedGhost();
  if (ghost) return `<div class="context-panel ghost-context-panel" role="region" aria-label="Ghost proposal review">${renderGhostInspector(ghost)}</div>`;
  return '';
};

const submitAgentQuery = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const query = String(new FormData(form).get('query') || '').trim();
  if (!query) return;
  const sceneId = activeActSceneId();
  agentWorkspace.addMessage({role: 'user', text: query, sceneId});
  try {
    const allowedAssets = scopedAssetIds();
    const allowedCharacters = new Set(charactersForAct().map((character) => character.id));
    const results = projectContext.search(query, {limit: state.activeActId === 'all' ? 5 : 30})
      .filter((entry) => {
        if (state.activeActId === 'all') return true;
        if (entry.type === 'clip') return entry.sceneId === state.activeActId || allowedAssets.has(entry.metadata?.assetId);
        if (entry.type === 'scene') return entry.sceneId === state.activeActId;
        if (entry.type === 'character') return allowedCharacters.has(entry.characterId);
        return true;
      })
      .slice(0, 5);
    const videoResults = await searchVideoFrames(query).catch(() => []);
    state.videoSearchResults = videoResults;
    state.selectedFrameResult = null;
    const resultCount = results.length + videoResults.length;
    agentWorkspace.addMessage({
      role: 'assistant',
      sceneId,
      text: resultCount
        ? `Found ${resultCount} matching ${resultCount === 1 ? 'project record' : 'project records'}${videoResults.length ? `, including ${videoResults.length} video frame ${videoResults.length === 1 ? 'hit' : 'hits'}.` : '.'}`
        : 'No matching project records or annotated video frames yet.',
      resultIds: results.map((result) => result.id),
      frameIds: videoResults.map((result) => result.id),
    });
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const saveScriptTitle = (event) => {
  event.preventDefault();
  const title = String(new FormData(event.currentTarget).get('title') || '').trim();
  if (!title) return;
  agentWorkspace.updateScript({title});
  renderApp();
};

const addScriptBeat = (event) => {
  event.preventDefault();
  const text = String(new FormData(event.currentTarget).get('text') || '').trim();
  if (!text) return;
  agentWorkspace.addBeat({text});
  renderApp();
};

const saveScriptBeat = (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  agentWorkspace.updateBeat(form.dataset.beatId, {
    text: String(data.get('text') || ''),
    sceneId: String(data.get('sceneId') || '') || null,
    clipIds: String(data.get('clipIds') || '').split(',').map((id) => id.trim()).filter(Boolean),
  });
  renderApp();
};

const saveStoryboardScreenplay = (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const act = project.storyboard?.nodes.find((node) => node.kind === 'act' && node.id === form.dataset.actId);
  if (!act) return;
  const nextAct = structuredClone(act);
  const beat = nextAct.beats.find((entry) => entry.id === form.dataset.beatId);
  if (!beat) return;
  const text = String(new FormData(form).get('text') || '').trim();
  beat.screenplay = text ? {
    ...(beat.screenplay || {}),
    text,
    editedAt: new Date().toISOString(),
  } : null;
  updateProject({type: 'storyboard/act-save', actId: nextAct.id, act: nextAct});
  renderApp();
};

const selectAgentResult = (entryId) => {
  const entry = projectContext.getIndex().entries.find((candidate) => candidate.id === entryId);
  if (!entry) return;
  if (entry.clipId) {
    selectOnlyClip(entry.clipId);
    state.selectedGhostKey = null;
    state.previewDiffId = null;
    state.currentTime = viewClip(clipById(entry.clipId))?.start ?? entry.start ?? 0;
  }
  renderApp();
};

const selectVideoSearchResult = (frameId) => {
  const result = state.videoSearchResults.find((candidate) => candidate.id === frameId) || videoIndexer.getCachedFrame(frameId);
  if (!result) return;
  state.selectedFrameResult = result;
  state.selectedGhostKey = null;
  state.previewDiffId = null;
  const matchingClips = viewClips().filter((clip) => clip.assetId === result.videoAssetId);
  const clip = matchingClips.find((candidate) => {
    const sourceStart = candidate.sourceStart || 0;
    return result.time >= sourceStart && result.time <= sourceStart + candidate.duration;
  }) || matchingClips[0];
  selectOnlyClip(clip?.id || null);
  state.activeTab = 'media';
  state.currentTime = clip
    ? clip.start + Math.max(0, Math.min(clip.duration, result.time - (clip.sourceStart || 0)))
    : result.time;
  if (!state.videoSearchResults.some((candidate) => candidate.id === result.id)) {
    state.videoSearchResults = [result, ...state.videoSearchResults].slice(0, 10);
  }
  renderApp();
};

const renderTimeline = () => {
  const duration = playbackDuration();
  const timelineWidth = Math.max(900, (duration + 3) * scale());
  const ticks = Array.from({length: Math.ceil(duration) + 2}, (_, index) => index);
  const timelineClips = viewClips();
  const timelineClipIds = new Set(timelineClips.map((clip) => clip.id));
  const ghosts = buildGhostItems(state.pendingDiffs)
    .map((ghost) => ({...ghost, clip: viewClip(ghost.clip)}))
    .filter((ghost) => ghost.clip);
  const trackLayouts = state.tracks.map((track) => {
    const styleGhosts = ghosts.filter((ghost) => ghost.source === 'style-application' && ghost.clip?.trackId === track.id);
    const hasStyleRail = styleGhosts.length > 0;
    return {track, hasStyleRail, height: hasStyleRail ? 139 : 74, acceptedTop: hasStyleRail ? 74 : 9};
  });
  const pendingCount = state.pendingDiffs.length;
  const reviewQueue = reviewItems();
  const selectedReviewIndex = reviewQueue.findIndex((item) => item.diffId === selectedGhost()?.diffId);
  const reviewPosition = selectedReviewIndex >= 0 ? selectedReviewIndex + 1 : 1;
  const contentHeight = 29 + trackLayouts.reduce((total, layout) => total + layout.height, 0);
  const reviewControls = pendingCount ? `
    <span class="review-position" aria-live="polite" data-review-position>${reviewPosition} of ${pendingCount}</span>
    <button class="toolbar-button review-nav" data-action="previous-diff" type="button" aria-label="Previous proposal" ${reviewPosition <= 1 ? 'disabled' : ''}>‹</button>
    <button class="toolbar-button review-nav" data-action="next-diff" type="button" aria-label="Next proposal" ${reviewPosition >= pendingCount ? 'disabled' : ''}>›</button>` : '';
  const trackMenu = state.trackMenuOpen ? `<div class="track-menu" role="menu"><button type="button" role="menuitem" data-action="add-track-kind" data-track-kind="video"><span class="track-color video"></span>Video</button><button type="button" role="menuitem" data-action="add-track-kind" data-track-kind="audio"><span class="track-color audio"></span>Audio</button></div>` : '';
  const actOptions = orderedScenes(project)
    .map((scene) => `<option value="${escapeHtml(scene.id)}" ${state.activeActId === scene.id ? 'selected' : ''}>${escapeHtml(scene.name)}</option>`)
    .join('');
  return `
    <div class="timeline-toolbar"><div class="timeline-title"><span class="eyebrow">EDIT</span><div><h2>Timeline</h2><button class="toolbar-button agent-launch" data-action="open-agent-prompt" title="AI editing agent" aria-label="Launch AI editing agent" type="button">${icons.robot} Agent</button><select class="sequence-chip" data-action="select-act" aria-label="Timeline act"><option value="all" ${state.activeActId === 'all' ? 'selected' : ''}>All</option>${actOptions}</select>${pendingCount ? `<button class="diff-badge" data-action="select-first-diff" type="button" aria-label="Select pending proposal ${reviewPosition} of ${pendingCount}"><strong>${pendingCount}</strong> pending · ${escapeHtml(state.pendingDiffs[0].summary)}</button>${reviewControls}` : ''}</div></div><div class="timeline-actions">${pendingCount > 1 ? '<button class="toolbar-button reject-all" data-action="reject-all-diffs" type="button">Reject all</button><button class="toolbar-button accept-all" data-action="accept-all-diffs" type="button">Accept all</button><span class="tool-divider"></span>' : ''}<button class="toolbar-button" data-action="generate-score" type="button" title="Generate an AI background score for the whole timeline" ${state.scoreGeneration ? 'disabled' : ''}>♪ ${state.scoreGeneration ? scoreGenerationLabel() : 'Score'}</button><button class="toolbar-button" data-action="split" type="button">${icons.scissors} Split</button><div class="track-menu-wrap"><button class="toolbar-button" data-action="add-track" type="button" aria-expanded="${state.trackMenuOpen}">${icons.plus} Track</button>${trackMenu}</div><span class="tool-divider"></span><button class="toolbar-button" data-action="zoom-out" type="button" aria-label="Zoom out">−</button><span class="zoom-value">${Math.round(state.zoom * 100)}%</span><button class="toolbar-button" data-action="zoom-in" type="button" aria-label="Zoom in">+</button></div></div>
    <div class="timeline-body">
      <div class="track-labels"><div class="ruler-spacer"></div>${trackLayouts.map(({track, height, hasStyleRail}) => `<div class="track-label ${track.kind}-label ${hasStyleRail ? 'has-style-rail' : ''}" style="height:${height}px"><span class="track-color ${track.kind}"></span><div><strong>${escapeHtml(track.name)}</strong><span>${escapeHtml(track.id)}</span>${hasStyleRail ? '<small>STYLE REVIEW</small>' : ''}</div></div>`).join('')}</div>
      <div class="timeline-scroll" id="timelineScroll"><div class="timeline-content" id="timelineContent" style="height:${contentHeight}px;width:${timelineWidth}px">
        <div class="ruler" id="timelineRuler">${ticks.map((tick) => `<div class="tick ${tick % 5 === 0 ? 'major' : ''}" style="left:${tick * scale()}px"><span>${formatTime(tick).slice(0, 5)}</span></div>`).join('')}</div>
        ${trackLayouts.map(({track, height, acceptedTop, hasStyleRail}) => {
          const clips = timelineClips.filter((clip) => clip.trackId === track.id);
          const trackGhosts = ghosts.filter((ghost) => ghost.clip?.trackId === track.id);
          const generating = pendingGenerationForView();
          const trackTransitions = state.transitions.filter((transition) => transition.trackId === track.id
            && (!transition.fromClipId || timelineClipIds.has(transition.fromClipId))
            && (!transition.toClipId || timelineClipIds.has(transition.toClipId)));
          const content = `${hasStyleRail ? '<div class="style-review-rail-label">Styled candidates</div><div class="style-review-rail-line"></div>' : ''}${clips.map((clip) => renderClip(clip, {top: acceptedTop})).join('')}${trackTransitions.map((transition) => renderTransitionMarker(transition, {top: acceptedTop + 17}, timelineClips)).join('')}${trackGhosts.map((ghost) => renderGhostClip(ghost, {top: ghost.source === 'style-application' ? 9 : acceptedTop})).join('')}${generating?.trackId === track.id ? renderGenerationPendingClip(generating, {top: acceptedTop}) : ''}`;
          return `<div class="track-lane ${track.kind}-lane ${hasStyleRail ? 'has-style-rail' : ''}" data-track-id="${escapeHtml(track.id)}" style="height:${height}px">${content || `<div class="lane-placeholder">Drop ${track.kind} here</div>`}</div>`;
        }).join('')}
        <div class="timeline-drag-guide" id="timelineDragGuide" hidden></div>
        <div class="playhead" id="playhead" style="left:${state.currentTime * scale()}px"><span></span></div>
      </div></div>
    </div>
  `;
};

const renderClip = (clip, {top = 9} = {}) => {
  const media = mediaById(clip.assetId);
  if (!media) return '';
  const width = Math.max(clip.duration * scale(), 66);
  const frame = state.selectedFrameResult;
  const sourceStart = clip.sourceStart || 0;
  const frameSelected = frame?.videoAssetId === clip.assetId && frame.time >= sourceStart && frame.time <= sourceStart + clip.duration;
  const regenerating = clipRegeneration.listJobs(clip.id).some((job) => job.status === 'queued' || job.status === 'running');
  const styleApplying = (project.styleApplications?.batches || []).some((batch) => batch.jobs.some((job) => job.clipId === clip.id && ['queued', 'uploading', 'trimming', 'generating'].includes(job.status)));
  const selected = state.selectedClipIds.has(clip.id);
  return `<div class="timeline-clip ${media.kind} ${selected ? 'selected' : ''} ${frameSelected ? 'frame-selected' : ''} ${regenerating ? 'regenerating' : ''} ${styleApplying ? 'style-applying' : ''}" draggable="true" data-clip-id="${clip.id}" aria-selected="${selected}" style="left:${clip.start * scale()}px;width:${width}px;top:${top}px">${renderClipContents(media, clip.duration)}</div>`;
};

const renderTransitionMarker = (transition, {top = 26} = {}, clips = viewClips()) => {
  const edgeTime = transitionEdgeTime(transition, clips);
  if (!Number.isFinite(edgeTime)) return '';
  const definition = getTransitionDefinition(transition.type, state.customTransitions);
  const label = definition?.label || transition.type;
  const placement = transition.fromClipId && transition.toClipId ? 'between clips' : transition.fromClipId ? 'to black' : 'from black';
  const description = `${label} · ${placement} · ${formatTime(transition.duration)}`;
  return `<button class="timeline-transition ${transition.id === state.selectedTransitionId ? 'selected' : ''}" data-transition-id="${escapeHtml(transition.id)}" type="button" style="left:${edgeTime * scale()}px;top:${top}px" title="${escapeHtml(description)}" aria-label="${escapeHtml(`${label} transition, ${placement}`)}"><span aria-hidden="true">${escapeHtml(definition?.glyph || '◐')}</span></button>`;
};

const renderClipContents = (media, duration) => `<div class="clip-thumb">${media.url ? media.kind === 'audio' ? `<span>${icons.audio}</span>` : renderMediaVisual(media) : `<span>${kindIcon(media.kind)}</span>`}</div><div class="clip-copy"><strong>${escapeHtml(media.name)}</strong><span>${formatTime(duration)}</span></div><div class="clip-handle left"></div><div class="clip-handle right"></div>`;

const renderGenerationPendingClip = (input, {top = 9} = {}) => {
  const duration = input.duration || 5;
  const width = Math.max(duration * scale(), 66);
  const isBeatVideo = Boolean(input.params?.storyboardBeatId);
  const label = isBeatVideo ? 'Generating beat video…' : 'Generating…';
  return `<div class="timeline-clip video generation-pending" style="left:${(input.start || 0) * scale()}px;width:${width}px;top:${top}px" aria-label="${isBeatVideo ? 'Generating beat video' : 'Generating video'}"><div class="clip-copy"><strong>${label}</strong><span>${escapeHtml(input.prompt.slice(0, 48))}</span></div></div>`;
};

const renderGhostClip = (ghost, {top = 9} = {}) => {
  const clip = ghost.clip;
  if (!clip) return '';
  const media = mediaById(clip.assetId);
  const width = Math.max(clip.duration * scale(), 66);
  const statusLabel = ghost.status === 'stale' ? 'Stale' : 'Pending';
  const roleLabel = ghost.role === 'origin' ? 'original position' : ghost.role === 'destination' ? 'destination' : ghost.role === 'removal' ? 'removal' : 'proposal';
  const label = `${statusLabel} ${ghost.type} ${roleLabel}: ${ghost.summary}`;
  const draggable = ghost.role !== 'origin' && ghost.type !== 'remove';
  return `<button class="timeline-ghost ghost-${ghost.type} ghost-${ghost.role} ${ghost.source === 'style-application' ? 'style-application-ghost' : ''} ${ghost.status} ${ghost.key === state.selectedGhostKey ? 'selected' : ''}" ${draggable ? 'draggable="true"' : ''} data-ghost-key="${escapeHtml(ghost.key)}" data-ghost-status="${escapeHtml(ghost.status)}" data-ghost-role="${escapeHtml(ghost.role)}" type="button" style="left:${clip.start * scale()}px;width:${width}px;top:${top}px" aria-label="${escapeHtml(label)}" aria-pressed="${ghost.key === state.selectedGhostKey}"><span class="ghost-kind">${ghost.source === 'style-application' ? 'STYLE' : escapeHtml(ghost.type)}</span><strong>${escapeHtml(media?.name || 'Proposed clip')}</strong><small>${statusLabel} · ${formatTime(clip.duration)}</small></button>`;
};

const filteredModalModels = (modal) => modal.categoryFilter
  ? modal.models.filter((entry) => entry.category === modal.categoryFilter)
  : modal.models;

const renderModelCategorySelect = (modal, busy) => {
  const categories = [...new Set(modal.models.map((entry) => entry.category))];
  if (categories.length < 2) return '';
  return `<label for="generateVideoCategory">Model type</label>
          <select id="generateVideoCategory" aria-label="Filter models by type" ${busy ? 'disabled' : ''}><option value="">All types</option>${categories.map((category) => `<option value="${escapeHtml(category)}" ${category === modal.categoryFilter ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}</select>`;
};

const renderGenerateVideoModal = () => {
  const modal = state.generateVideoModal;
  if (!modal) return '';
  const model = modalModel(modal);
  const busy = modal.status === 'submitting' || modal.status === 'generating';
  return `
    <div class="modal-backdrop" data-action="close-generate-modal">
      <section class="generate-modal" role="dialog" aria-modal="true" aria-labelledby="generateVideoTitle">
        <div class="modal-head"><div><span class="eyebrow">TIMELINE</span><h2 id="generateVideoTitle">${modal.mode === 'regenerate' ? 'Regenerate clip' : 'Generate video'}</h2></div><button class="small-icon-button" data-action="close-generate-modal" aria-label="Close" type="button">${icons.close}</button></div>
        <form class="generate-form" data-generate-video-form>
          <label for="generateVideoPrompt">Prompt</label>
          <textarea id="generateVideoPrompt" rows="3" placeholder="Describe the shot…" required ${busy ? 'disabled' : ''}>${escapeHtml(modal.prompt)}</textarea>
          ${modal.status === 'loading-models'
            ? '<label for="generateVideoModel">Model</label><p class="generate-note">Loading model catalog…</p>'
            : `${renderModelCategorySelect(modal, busy)}<label for="generateVideoModel">Model</label><select id="generateVideoModel" ${busy ? 'disabled' : ''}>${filteredModalModels(modal).map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === modal.modelId ? 'selected' : ''}>${escapeHtml(modelOptionLabel(entry))}</option>`).join('')}</select>`}
          ${model?.category.includes('video') ? `
          <label for="generateVideoDuration">Duration</label>
          <select id="generateVideoDuration" ${busy ? 'disabled' : ''}><option value="">Model default</option>${GENERATION_DURATIONS.map((seconds) => `<option value="${seconds}" ${modal.duration === seconds ? 'selected' : ''}>${seconds}s</option>`).join('')}</select>` : ''}
          <p class="generate-note">${modal.mode === 'regenerate' ? 'Replaces the clip' : 'Insert'} on ${escapeHtml(modal.trackId)} at ${formatTime(modal.start)}</p>
          ${modal.error ? `<p class="generate-error">${escapeHtml(modal.error)}</p>` : ''}
          <div class="generate-footer">
            <div class="generate-cost">${model ? `<span>Estimated cost</span><strong>${escapeHtml(generateTotalCost(model, modal.duration))}</strong><small>${escapeHtml(generateCostLine(model, modal.duration))}</small>` : ''}</div>
            <div class="generate-actions"><button class="button ghost" data-action="close-generate-modal" type="button">Cancel</button><button class="button primary" type="submit" ${busy || modal.status === 'loading-models' ? 'disabled' : ''}>${busy ? 'Generating…' : modal.mode === 'regenerate' ? 'Regenerate' : 'Generate'}</button></div>
          </div>
        </form>
      </section>
    </div>
  `;
};

const storyboardActAndBeat = (actId, beatId) => {
  const act = (project.storyboard?.nodes || []).find((node) => node.kind === 'act' && node.id === actId) || null;
  const beat = act?.beats?.find((entry) => entry.id === beatId) || null;
  return {act, beat};
};

const beatVideoContext = (actId, beatId) => createActWorkspace({
  project,
  actId,
  narrativeStyle: getNarrativeStyle(project.storyboard?.styleId),
  createId: (() => { let id = 0; return (prefix) => `${prefix}-video-context-${++id}`; })(),
}).contextFor(beatId);

const openBeatVideoModal = (actId, beatId) => {
  const {act, beat} = storyboardActAndBeat(actId, beatId);
  const asset = beat?.hero?.assetId ? mediaById(beat.hero.assetId) : null;
  if (!act || !beat || !asset?.url) {
    showToast('Generate and save a still for this beat before creating video.');
    return;
  }
  state.beatVideoModal = {
    actId,
    beatId,
    duration: SEEDANCE_VIDEO_DURATIONS.includes(beat.videoPrompt?.duration) ? beat.videoPrompt.duration : 6,
    prompt: beat.videoPrompt?.text || '',
    status: 'idle',
    error: '',
  };
  renderApp();
};

const persistBeatVideoPrompt = ({actId, beatId, text, duration, patch = {}}) => {
  const prompt = String(text || '').trim();
  if (!prompt) return null;
  const {act, beat} = storyboardActAndBeat(actId, beatId);
  if (!act || !beat) return null;
  const current = beat.videoPrompt || null;
  const next = {
    ...(current || {}),
    text: prompt,
    duration,
    ...patch,
  };
  if (current && JSON.stringify(current) === JSON.stringify(next)) return current;
  const nextAct = structuredClone(act);
  const nextBeat = nextAct.beats.find((entry) => entry.id === beatId);
  if (!nextBeat) return null;
  nextBeat.videoPrompt = next;
  updateProject({type: 'storyboard/act-save', actId, act: nextAct});
  return next;
};

const closeBeatVideoModal = () => {
  const modal = state.beatVideoModal;
  if (modal) {
    const prompt = app.querySelector('[data-beat-video-prompt]')?.value || modal.prompt;
    persistBeatVideoPrompt({
      actId: modal.actId,
      beatId: modal.beatId,
      text: prompt,
      duration: modal.duration,
      patch: {editedAt: new Date().toISOString()},
    });
  }
  state.beatVideoModal = null;
  renderApp();
};

const generateBeatVideoPrompt = async () => {
  const modal = state.beatVideoModal;
  if (!modal || modal.status !== 'idle') return;
  modal.prompt = app.querySelector('[data-beat-video-prompt]')?.value || modal.prompt;
  modal.status = 'generating-prompt';
  modal.error = '';
  renderApp();
  try {
    const result = await storyboardGenerationAdapter.generateVideoPrompt({
      context: beatVideoContext(modal.actId, modal.beatId),
      duration: modal.duration,
    });
    persistBeatVideoPrompt({
      actId: modal.actId,
      beatId: modal.beatId,
      text: result.text,
      duration: modal.duration,
      patch: {
        modelId: result.modelId || null,
        generatedAt: new Date().toISOString(),
        editedAt: null,
        usage: result.usage || {},
      },
    });
    if (state.beatVideoModal !== modal) return;
    modal.prompt = result.text;
    modal.status = 'idle';
    renderApp();
  } catch (error) {
    if (state.beatVideoModal !== modal) return;
    modal.status = 'idle';
    modal.error = error instanceof Error ? error.message : String(error);
    renderApp();
  }
};

const submitBeatVideo = async (event) => {
  event.preventDefault();
  const modal = state.beatVideoModal;
  if (!modal || modal.status !== 'idle') return;
  try {
    const prompt = withSeedanceReferenceDirections(app.querySelector('[data-beat-video-prompt]')?.value || modal.prompt);
    const {act, beat} = storyboardActAndBeat(modal.actId, modal.beatId);
    const still = beat?.hero?.assetId ? mediaById(beat.hero.assetId) : null;
    if (!act || !beat || !still?.url) throw new Error('The beat still is no longer available.');
    persistBeatVideoPrompt({
      actId: modal.actId,
      beatId: modal.beatId,
      text: prompt,
      duration: modal.duration,
      patch: {
        videoModelId: SEEDANCE_REFERENCE_VIDEO_MODEL_ID,
        editedAt: new Date().toISOString(),
        submittedAt: new Date().toISOString(),
      },
    });
    const referenceUrl = await toUploadableUrl(still.url);
    if (typeof referenceUrl !== 'string' || !/^(https:\/\/|data:image\/)/i.test(referenceUrl)) {
      throw new Error('The beat still could not be prepared as a Seedance reference image.');
    }
    // Character sheets ride along as @Image2+ so identities hold once the
    // motion leaves the opening frame. @Image1 must stay the beat still.
    const sheetAssetIds = [...new Set((beat.hero?.characterVersionIds || [])
      .map((versionId) => (project.characters || [])
        .flatMap((character) => character.versions || [])
        .find((version) => version.id === versionId)?.sheetAssetId || null)
      .filter(Boolean))];
    const sheetUrls = (await Promise.all(sheetAssetIds.map(async (assetId) => {
      const asset = mediaById(assetId);
      if (!asset?.url) return null;
      try { return await toUploadableUrl(asset.url); } catch { return null; }
    }))).filter((url) => typeof url === 'string' && /^(https:\/\/|data:image\/)/i.test(url)).slice(0, 3);
    const submittedPrompt = sheetUrls.length
      ? `${prompt}\n${sheetUrls.length === 1 ? '@Image2 is a character reference sheet' : `@Image2 through @Image${sheetUrls.length + 1} are character reference sheets`}. Keep every character's identity, face, wardrobe, and proportions consistent with the sheets in every frame.`
      : prompt;
    modal.prompt = prompt;
    modal.status = 'submitting';
    modal.error = '';
    renderApp();
    const trackId = project.timeline.tracks.find((track) => track.kind === 'video')?.id || 'V1';
    const sceneId = act.sceneId || activeScene()?.id || null;
    const start = nextBeatVideoTimelineStart({clips: project.timeline.clips, trackId, sceneId});
    const job = await timelineAddGeneration.submit({
      operation: 'add',
      prompt: submittedPrompt,
      referenceImageUrls: [referenceUrl, ...sheetUrls],
      characterVersionIds: beat.hero?.characterVersionIds || [],
      parentAssetIds: [still.id],
      modelId: SEEDANCE_REFERENCE_VIDEO_MODEL_ID,
      trackId,
      start,
      sceneId,
      duration: modal.duration,
      params: {
        duration: String(modal.duration),
        resolution: '720p',
        aspect_ratio: 'auto',
        generate_audio: true,
        bitrate_mode: 'standard',
        storyboardActId: act.id,
        storyboardBeatId: beat.id,
      },
    });
    if (job.status === 'failed') throw new Error(job.error || 'Beat video generation failed.');
    state.beatVideoModal = null;
    showToast(`Generating beat video… a ghost clip starts at ${formatTime(start)}.`);
    renderApp();
    scheduleGenerateVideoPoll();
  } catch (error) {
    const openModal = state.beatVideoModal;
    const message = error instanceof Error ? error.message : String(error);
    if (openModal === modal) {
      openModal.status = 'idle';
      openModal.error = message;
      renderApp();
    } else {
      showToast(message);
    }
  }
};

const renderBeatVideoModal = () => {
  const modal = state.beatVideoModal;
  if (!modal) return '';
  const {act, beat} = storyboardActAndBeat(modal.actId, modal.beatId);
  const still = beat?.hero?.assetId ? mediaById(beat.hero.assetId) : null;
  if (!act || !beat || !still?.url) return '';
  const busy = modal.status !== 'idle';
  const screenplay = beat.screenplay?.text?.trim() || beat.text;
  return `
    <div class="modal-backdrop beat-video-backdrop" data-action="close-beat-video-modal">
      <section class="beat-video-modal" role="dialog" aria-modal="true" aria-labelledby="beatVideoTitle">
        <div class="modal-head beat-video-head"><div><span class="eyebrow">ACT ${String(act.actNumber || '').padStart(2, '0')} · BEAT VIDEO</span><h2 id="beatVideoTitle">${escapeHtml(beat.text)}</h2></div><button class="small-icon-button" data-action="close-beat-video-modal" aria-label="Close" type="button">${icons.close}</button></div>
        <form class="beat-video-form" data-beat-video-form>
          <div class="beat-video-copy-pane">
            <section class="beat-video-screenplay"><span class="eyebrow">SCREENPLAY FOR THIS BEAT</span><pre>${escapeHtml(screenplay)}</pre></section>
            <section class="beat-video-prompt-workspace">
              <div class="beat-video-prompt-head"><label for="beatVideoPrompt">Time-coded Seedance prompt</label><div class="beat-video-prompt-actions"><select data-beat-video-duration aria-label="Video duration" ${busy ? 'disabled' : ''}>${SEEDANCE_VIDEO_DURATIONS.map((seconds) => `<option value="${seconds}" ${modal.duration === seconds ? 'selected' : ''}>${seconds} seconds</option>`).join('')}</select><button class="button ghost" data-action="generate-beat-video-prompt" type="button" ${busy ? 'disabled' : ''}>${modal.status === 'generating-prompt' ? 'Generating prompt…' : 'Generate prompt'}</button></div></div>
              <textarea id="beatVideoPrompt" data-beat-video-prompt placeholder="Generate a time-coded prompt from this screenplay, then edit it here…" ${busy ? 'disabled' : ''}>${escapeHtml(modal.prompt)}</textarea>
              <p class="beat-video-audio-note">Hard camera cuts are capped at 3 seconds. Every cut changes composition and includes dialogue under 3 seconds—even for a solo character. Music is always disabled.</p>
              ${modal.error ? `<p class="generate-error">${escapeHtml(modal.error)}</p>` : ''}
            </section>
          </div>
          <aside class="beat-video-still-pane"><span class="eyebrow">REFERENCE STILL · @IMAGE1</span><div><img src="${escapeHtml(still.url)}" alt="Reference still for ${escapeHtml(beat.text)}" /></div></aside>
          <footer class="beat-video-footer"><div><strong>${escapeHtml(SEEDANCE_REFERENCE_VIDEO_MODEL_ID)}</strong><span>Reference-to-video · prompt clock begins at 00:00 · timeline placement appends</span></div><div class="generate-actions"><button class="button ghost" data-action="close-beat-video-modal" type="button">Cancel</button><button class="button primary" data-action="generate-beat-video" type="submit" ${busy || !modal.prompt.trim() ? 'disabled' : ''}>${modal.status === 'submitting' ? 'Submitting…' : 'Generate video'}</button></div></footer>
        </form>
      </section>
    </div>`;
};

const bindEvents = () => {
  const timelineBody = app.querySelector('.timeline-body');
  const timelineScroll = app.querySelector('#timelineScroll');
  if (timelineBody) {
    timelineBody.scrollTop = state.timelineScrollTop;
    state.timelineScrollTop = timelineBody.scrollTop;
    timelineBody.addEventListener('scroll', () => { state.timelineScrollTop = timelineBody.scrollTop; }, {passive: true});
  }
  if (timelineScroll) {
    timelineScroll.scrollLeft = state.timelineScrollLeft;
    state.timelineScrollLeft = timelineScroll.scrollLeft;
    timelineScroll.addEventListener('scroll', () => { state.timelineScrollLeft = timelineScroll.scrollLeft; }, {passive: true});
  }
  app.querySelectorAll('[data-action="open-file"]').forEach((button) => button.addEventListener('click', () => fileInput.click()));
  app.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => { state.activeTab = button.dataset.tab; renderApp(); }));
  app.querySelector('[data-action="select-act"]')?.addEventListener('change', (event) => {
    const nextActId = event.target.value;
    if (nextActId !== 'all' && !project.scenes.some((scene) => scene.id === nextActId)) return;
    state.activeActId = nextActId;
    if (nextActId !== 'all') updateProject({type: 'timeline/set-active-scene', sceneId: nextActId});
    state.currentTime = 0;
    state.isPlaying = false;
    clearTimelineClipSelection();
    state.selectedTransitionId = null;
    state.selectedGhostKey = null;
    state.previewDiffId = null;
    state.videoSearchResults = state.videoSearchResults.filter((result) => scopedAssetIds().has(result.videoAssetId));
    state.selectedFrameResult = null;
    renderApp();
  });
  app.querySelectorAll('[data-editor-beat-id]').forEach((button) => button.addEventListener('click', () => openBeatVideoModal(button.dataset.editorActId, button.dataset.editorBeatId)));
  app.querySelectorAll('[data-action="close-beat-video-modal"]').forEach((element) => element.addEventListener('click', (event) => { if (event.currentTarget === event.target || event.currentTarget.tagName === 'BUTTON') closeBeatVideoModal(); }));
  app.querySelector('[data-action="generate-beat-video-prompt"]')?.addEventListener('click', generateBeatVideoPrompt);
  app.querySelector('[data-beat-video-duration]')?.addEventListener('change', (event) => {
    if (!state.beatVideoModal) return;
    state.beatVideoModal.duration = Number(event.target.value);
    state.beatVideoModal.prompt = '';
    renderApp();
  });
  app.querySelector('[data-beat-video-prompt]')?.addEventListener('input', (event) => {
    if (state.beatVideoModal) state.beatVideoModal.prompt = event.target.value;
  });
  app.querySelector('[data-beat-video-form]')?.addEventListener('submit', submitBeatVideo);
  app.querySelector('[data-action="toggle-media-panel"]')?.addEventListener('click', () => { state.mediaPanelOpen = !state.mediaPanelOpen; renderApp(); });
  app.querySelectorAll('[data-action="toggle-agent-pane"]').forEach((button) => button.addEventListener('click', () => { state.agentPaneOpen = !state.agentPaneOpen; renderApp(); }));
  app.querySelector('[data-agent-form]')?.addEventListener('submit', submitAgentQuery);
  app.querySelector('[data-action="generate-score"]')?.addEventListener('click', generateBackgroundScore);
  app.querySelectorAll('[data-action="open-agent-prompt"]').forEach((button) => button.addEventListener('click', openAgentPrompt));
  app.querySelectorAll('[data-action="close-agent-prompt"]').forEach((element) => element.addEventListener('click', (event) => { if (event.currentTarget === event.target || event.currentTarget.tagName === 'BUTTON') closeAgentPrompt(); }));
  app.querySelector('[data-agent-prompt-form]')?.addEventListener('submit', submitAgentPrompt);
  app.querySelector('#agentPromptInput')?.addEventListener('input', (event) => { state.agentPromptDraft = event.target.value; });
  app.querySelector('#agentPromptInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.target.closest('form')?.requestSubmit();
    }
  });
  if (state.agentPromptModalOpen) app.querySelector('#agentPromptInput')?.focus();
  app.querySelectorAll('[data-agent-run-id]').forEach((button) => button.addEventListener('click', () => {
    const runId = button.dataset.agentRunId;
    state.expandedAgentRunId = state.expandedAgentRunId === runId ? null : runId;
    state.agentStepperScrollTop = 0;
    renderApp();
  }));
  app.querySelector('[data-action="close-agent-run-card"]')?.addEventListener('click', () => { state.expandedAgentRunId = null; renderApp(); });
  app.querySelector('[data-action="stop-agent-run"]')?.addEventListener('click', () => { if (state.expandedAgentRunId) agentRuns.cancel(state.expandedAgentRunId); });
  const agentStepper = app.querySelector('[data-agent-stepper]');
  if (agentStepper) {
    const run = agentRuns.get(state.expandedAgentRunId);
    const nearBottom = state.agentStepperScrollTop >= agentStepper.scrollHeight - agentStepper.clientHeight - 40;
    agentStepper.scrollTop = run?.status === 'running' && nearBottom ? agentStepper.scrollHeight : state.agentStepperScrollTop;
    state.agentStepperScrollTop = agentStepper.scrollTop;
    agentStepper.addEventListener('scroll', () => { state.agentStepperScrollTop = agentStepper.scrollTop; }, {passive: true});
  }
  app.querySelector('[data-video-search-form]')?.addEventListener('submit', submitVideoSearch);
  app.querySelector('[data-script-title-form]')?.addEventListener('submit', saveScriptTitle);
  app.querySelector('[data-script-add-form]')?.addEventListener('submit', addScriptBeat);
  app.querySelectorAll('[data-script-beat-form]').forEach((form) => form.addEventListener('submit', saveScriptBeat));
  app.querySelectorAll('[data-storyboard-script-form]').forEach((form) => form.addEventListener('submit', saveStoryboardScreenplay));
  app.querySelectorAll('[data-agent-result-id]').forEach((button) => button.addEventListener('click', () => selectAgentResult(button.dataset.agentResultId)));
  app.querySelectorAll('[data-video-frame-id]').forEach((button) => button.addEventListener('click', () => selectVideoSearchResult(button.dataset.videoFrameId)));
  app.querySelector('[data-action="clear-video-search"]')?.addEventListener('click', () => { state.videoSearchQuery = ''; state.videoSearchResults = []; state.selectedFrameResult = null; state.videoSearchError = ''; renderApp(); });
  app.querySelector('[data-action="create-character"]')?.addEventListener('click', createCharacter);
  app.querySelectorAll('[data-character-id]').forEach((button) => button.addEventListener('click', () => openCharacter(button.dataset.characterId)));
  app.querySelector('[data-action="create-style"]')?.addEventListener('click', createStyle);
  app.querySelectorAll('[data-style-id]').forEach((button) => button.addEventListener('click', () => openStyle(button.dataset.styleId)));
  bindCharacterModalEvents(characterModalLayer());
  app.querySelectorAll('[data-action="close-style-modal"]').forEach((element) => element.addEventListener('click', (event) => { if (event.currentTarget === event.target || event.currentTarget.tagName === 'BUTTON') closeStyleModal(); }));
  app.querySelectorAll('[data-action="close-style-application-modal"]').forEach((element) => element.addEventListener('click', (event) => { if (event.currentTarget === event.target || event.currentTarget.tagName === 'BUTTON') closeStyleApplicationModal(); }));
  app.querySelector('[data-style-application-form]')?.addEventListener('submit', submitStyleApplication);
  app.querySelector('#styleApplicationStyle')?.addEventListener('change', (event) => {
    const modal = state.styleApplicationModal;
    if (!modal) return;
    modal.styleId = event.target.value;
    modal.referenceAssetIds = styleReferenceImageIds(styleById(modal.styleId)).slice(0, 4);
    renderApp();
  });
  app.querySelectorAll('[data-style-reference-id]').forEach((input) => input.addEventListener('change', () => {
    const modal = state.styleApplicationModal;
    if (!modal) return;
    const next = new Set(modal.referenceAssetIds);
    if (input.checked) {
      if (next.size >= 4) {
        showToast('Choose up to 4 style references.');
        renderApp();
        return;
      }
      next.add(input.dataset.styleReferenceId);
    } else next.delete(input.dataset.styleReferenceId);
    modal.referenceAssetIds = [...next];
  }));
  app.querySelector('#styleApplicationInstruction')?.addEventListener('input', (event) => { if (state.styleApplicationModal) state.styleApplicationModal.instruction = event.target.value; });
  app.querySelector('#styleApplicationAudio')?.addEventListener('change', (event) => { if (state.styleApplicationModal) state.styleApplicationModal.preserveAudio = event.target.checked; });
  app.querySelectorAll('[data-action="retry-style-application"]').forEach((button) => button.addEventListener('click', () => retryStyleApplicationJob(button.dataset.batchId, button.dataset.jobId)));
  app.querySelectorAll('[data-action="close-generate-modal"]').forEach((element) => element.addEventListener('click', (event) => { if (event.currentTarget === event.target || event.currentTarget.tagName === 'BUTTON') closeGenerateVideoModal(); }));
  app.querySelector('[data-generate-video-form]')?.addEventListener('submit', submitGenerateVideoForm);
  attachPromptMentions('#generateVideoPrompt');
  attachPromptMentions('#regenerationPrompt');
  app.querySelector('#generateVideoPrompt')?.addEventListener('input', (event) => { if (state.generateVideoModal) state.generateVideoModal.prompt = event.target.value; });
  app.querySelector('#generateVideoModel')?.addEventListener('change', (event) => { const modal = state.generateVideoModal; if (modal) { modal.modelId = event.target.value; renderApp(); } });
  app.querySelector('#generateVideoCategory')?.addEventListener('change', (event) => {
    const modal = state.generateVideoModal;
    if (!modal) return;
    modal.categoryFilter = event.target.value || null;
    const filtered = filteredModalModels(modal);
    if (!filtered.some((entry) => entry.id === modal.modelId)) modal.modelId = filtered[0]?.id || null;
    renderApp();
  });
  app.querySelector('#generateVideoDuration')?.addEventListener('change', (event) => { const modal = state.generateVideoModal; if (modal) { modal.duration = event.target.value ? Number(event.target.value) : null; renderApp(); } });
  app.querySelector('[data-style-name-form]')?.addEventListener('submit', renameStyle);
  app.querySelector('[data-action="open-transition-composer"]')?.addEventListener('click', openTransitionComposer);
  app.querySelectorAll('[data-action="close-transition-composer"]').forEach((element) => element.addEventListener('click', (event) => { if (event.currentTarget === event.target || event.currentTarget.tagName === 'BUTTON') closeTransitionComposer(); }));
  app.querySelector('[data-transition-composer-form]')?.addEventListener('submit', submitTransitionComposer);
  app.querySelector('#transitionComposerName')?.addEventListener('input', (event) => { state.transitionComposerInput.name = event.target.value; });
  app.querySelector('#transitionComposerPrompt')?.addEventListener('input', (event) => { state.transitionComposerInput.prompt = event.target.value; });
  app.querySelectorAll('[data-action="delete-transition-def"]').forEach((button) => {
    button.addEventListener('pointerdown', (event) => event.stopPropagation());
    button.addEventListener('click', (event) => { event.stopPropagation(); deleteTransitionDefinition(button.dataset.transitionKey); });
  });
  app.querySelector('[data-action="record-style-version"]')?.addEventListener('click', recordStyleVersion);
  app.querySelector('[data-action="lock-style"]')?.addEventListener('click', lockStyle);
  app.querySelector('[data-action="unlock-style"]')?.addEventListener('click', unlockStyle);
  app.querySelector('[data-action="delete-style"]')?.addEventListener('click', deleteStyle);
  app.querySelectorAll('[data-action="activate-style-version"]').forEach((button) => button.addEventListener('click', () => activateStyleVersion(button.dataset.versionId)));
  app.querySelector('[data-dropzone="media"]')?.addEventListener('dragover', (event) => { event.preventDefault(); event.currentTarget.classList.add('dragging'); });
  app.querySelector('[data-dropzone="media"]')?.addEventListener('dragleave', (event) => event.currentTarget.classList.remove('dragging'));
  app.querySelector('[data-dropzone="media"]')?.addEventListener('drop', (event) => { event.preventDefault(); event.currentTarget.classList.remove('dragging'); addFiles([...event.dataTransfer.files]); });
  app.querySelector('[data-dropzone="media"]')?.closest('.sidebar')?.addEventListener('contextmenu', (event) => {
    if (event.target.closest('input, textarea, select')) return;
    const card = event.target.closest('[data-media-id]');
    if (card) {
      showContextMenu(event, [{label: 'Remove', danger: true, onSelect: () => removeMedia(card.dataset.mediaId)}]);
    } else {
      showContextMenu(event, [{label: 'Import media…', onSelect: () => fileInput.click()}]);
    }
  });
  app.querySelector('#timelineContent')?.addEventListener('contextmenu', (event) => {
    const clipElement = event.target.closest('[data-clip-id]');
    if (clipElement) {
      const clipId = clipElement.dataset.clipId;
      if (!state.selectedClipIds.has(clipId)) selectOnlyClip(clipId);
      const clip = clipById(clipId);
      const generated = Boolean(clip?.provenance?.prompt && clip?.provenance?.modelId);
      const clipAsset = mediaById(clip?.assetId);
      const canDetachAudio = clipAsset?.kind === 'video' && !clip?.audioDetached;
      const selectedClips = selectedTimelineClips();
      const hasVisualSelection = selectedClips.some((candidate) => ['video', 'image'].includes(mediaById(candidate.assetId)?.kind));
      const relatedBatch = [...(project.styleApplications?.batches || [])].reverse().find((batch) =>
        batch.jobs.some((job) => state.selectedClipIds.has(job.clipId)));
      showContextMenu(event, [
        ...(hasVisualSelection ? [{label: `Apply Style${selectedClips.length > 1 ? ` to ${selectedClips.length} clips` : ''}`, onSelect: () => openStyleApplicationModal({clipIds: selectedClips.map((candidate) => candidate.id)})}] : []),
        ...(relatedBatch ? [{label: 'View Apply Style jobs', onSelect: () => openStyleApplicationModal({batchId: relatedBatch.id})}] : []),
        ...(canDetachAudio ? [
          {label: 'Detach audio', onSelect: () => { void detachAudioFromClip(clipId); }},
        ] : []),
        ...(generated ? [
          {label: 'Regenerate clip', onSelect: () => regenerateClipFromMenu(clipId)},
          {label: 'Modify prompt + regen', onSelect: () => openGenerateVideoModal({mode: 'regenerate', clipId})},
        ] : []),
        {label: generated ? 'Delete' : 'Remove', danger: true, onSelect: () => removeClip(clipId)},
      ]);
      return;
    }
    if (event.target.closest('.timeline-ghost, .generation-pending')) return;
    const lane = event.target.closest('.track-lane');
    if (!lane?.classList.contains('video-lane')) return;
    const trackId = lane.dataset.trackId;
    const start = timeFromClientX(event.clientX);
    showContextMenu(event, [{label: 'Generate video', onSelect: () => openGenerateVideoModal({trackId, start})}]);
  });
  app.querySelectorAll('[data-media-id]').forEach((element) => {
    if (element.draggable) {
      element.addEventListener('dragstart', (event) => {
        state.dragPayload = {type: 'media', id: element.dataset.mediaId, native: true, grabOffset: 0};
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('text/media-id', element.dataset.mediaId);
      });
      element.addEventListener('dragend', clearNativeDrag);
      element.addEventListener('pointerdown', (event) => startPointerDrag(event, 'media', element.dataset.mediaId));
    }
  });
  app.querySelectorAll('[data-action="remove-media"]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); removeMedia(button.dataset.mediaId); }));
  app.querySelectorAll('[data-transition-type]').forEach((element) => {
    element.addEventListener('dragstart', (event) => {
      state.dragPayload = {type: 'transition', id: element.dataset.transitionType, native: true, grabOffset: 0};
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('text/transition-type', element.dataset.transitionType);
    });
    element.addEventListener('dragend', clearNativeDrag);
    element.addEventListener('pointerdown', (event) => startPointerDrag(event, 'transition', element.dataset.transitionType));
  });
  app.querySelectorAll('[data-transition-id]').forEach((marker) => {
    marker.addEventListener('click', (event) => {
      event.stopPropagation();
      state.selectedTransitionId = marker.dataset.transitionId;
      clearTimelineClipSelection();
      state.selectedGhostKey = null;
      renderApp();
    });
    marker.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event, [{label: 'Remove transition', danger: true, onSelect: () => removeTransition(marker.dataset.transitionId)}]);
    });
  });
  app.querySelectorAll('[data-clip-id]').forEach((clipElement) => {
    clipElement.addEventListener('click', (event) => { selectTimelineClip(clipElement.dataset.clipId, event); renderApp(); });
    clipElement.addEventListener('dragstart', (event) => {
      const clip = viewClipById(clipElement.dataset.clipId);
      state.dragPayload = {type: 'clip', id: clipElement.dataset.clipId, native: true, grabOffset: rawTimeFromClientX(event.clientX) - (clip?.start || 0)};
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/clip-id', clipElement.dataset.clipId);
    });
    clipElement.addEventListener('dragend', clearNativeDrag);
    clipElement.addEventListener('pointerdown', (event) => startPointerDrag(event, 'clip', clipElement.dataset.clipId));
    clipElement.querySelectorAll('.clip-handle').forEach((handle) => {
      const edge = handle.classList.contains('left') ? 'left' : 'right';
      handle.addEventListener('pointerdown', (event) => startTrimDrag(event, clipElement.dataset.clipId, edge));
    });
  });
  app.querySelectorAll('[data-ghost-key]').forEach((ghostElement) => {
    ghostElement.addEventListener('click', (event) => {
      event.stopPropagation();
      state.selectedGhostKey = ghostElement.dataset.ghostKey;
      clearTimelineClipSelection();
      renderApp();
    });
    if (ghostElement.draggable) {
      ghostElement.addEventListener('dragstart', (event) => {
        const clip = viewClip(findGhostItem(state.pendingDiffs, ghostElement.dataset.ghostKey)?.clip);
        state.dragPayload = {type: 'ghost', id: ghostElement.dataset.ghostKey, native: true, grabOffset: rawTimeFromClientX(event.clientX) - (clip?.start || 0)};
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/ghost-key', ghostElement.dataset.ghostKey);
      });
      ghostElement.addEventListener('dragend', clearNativeDrag);
      ghostElement.addEventListener('pointerdown', (event) => startPointerDrag(event, 'ghost', ghostElement.dataset.ghostKey));
    }
  });
  app.querySelectorAll('.track-lane').forEach((lane) => {
    lane.addEventListener('dragover', (event) => { event.preventDefault(); lane.classList.add('dragging'); });
    lane.addEventListener('dragleave', () => lane.classList.remove('dragging'));
    lane.addEventListener('drop', (event) => { event.preventDefault(); lane.classList.remove('dragging'); dropOnTimeline(event, lane.dataset.trackId); });
    lane.addEventListener('click', (event) => {
      if (performance.now() < suppressTimelineClickUntil) return;
      if (event.target.closest('.timeline-clip, .timeline-ghost')) return;
      seekFromTimeline(event);
    });
  });
  app.querySelector('#timelineContent')?.addEventListener('pointerdown', startTimelineMarquee);
  app.querySelector('#timelineRuler')?.addEventListener('click', seekFromTimeline);
  app.querySelector('[data-action="split"]')?.addEventListener('click', splitClipAtPlayhead);
  app.querySelector('[data-action="add-track"]')?.addEventListener('click', () => {
    state.trackMenuOpen = !state.trackMenuOpen;
    renderApp();
  });
  app.querySelectorAll('[data-action="add-track-kind"]').forEach((button) => {
    button.addEventListener('click', () => addTrack(button.dataset.trackKind));
  });
  app.querySelector('[data-action="toggle-play"]')?.addEventListener('click', togglePlay);
  app.querySelector('[data-action="toggle-mute"]')?.addEventListener('click', togglePlayerMute);
  app.querySelector('[data-action="toggle-fullscreen"]')?.addEventListener('click', togglePreviewFullscreen);
  app.querySelector('#playerVolume')?.addEventListener('input', (event) => {
    state.playerVolume = Number(event.target.value);
    if (state.playerVolume > 0) state.lastAudibleVolume = state.playerVolume;
    applyPlayerVolume();
    const muteButton = app.querySelector('[data-action="toggle-mute"]');
    if (muteButton) {
      muteButton.innerHTML = state.playerVolume === 0 ? icons.volumeMuted : icons.volume;
      muteButton.title = state.playerVolume === 0 ? 'Unmute' : 'Mute';
      muteButton.setAttribute('aria-label', muteButton.title);
    }
  });
  app.querySelector('[data-action="step-back"]')?.addEventListener('click', () => seekTo(state.currentTime - 1 / 30));
  app.querySelector('[data-action="step-forward"]')?.addEventListener('click', () => seekTo(state.currentTime + 1 / 30));
  app.querySelector('[data-action="zoom-in"]')?.addEventListener('click', () => { state.zoom = Math.min(2, state.zoom + 0.1); renderApp(); });
  app.querySelector('[data-action="zoom-out"]')?.addEventListener('click', () => { state.zoom = Math.max(0.6, state.zoom - 0.1); renderApp(); });
  app.querySelector('[data-action="delete-clip"]')?.addEventListener('click', deleteSelectedClip);
  app.querySelector('[data-action="select-first-diff"]')?.addEventListener('click', selectFirstDiff);
  app.querySelector('[data-action="accept-diff"]')?.addEventListener('click', (event) => acceptDiff(event.currentTarget.dataset.diffId));
  app.querySelector('[data-action="reject-diff"]')?.addEventListener('click', (event) => rejectDiff(event.currentTarget.dataset.diffId));
  app.querySelector('[data-action="preview-diff"]')?.addEventListener('click', (event) => previewDiff(event.currentTarget.dataset.diffId));
  app.querySelector('[data-action="exit-preview"]')?.addEventListener('click', exitProposalPreview);
  app.querySelector('[data-action="rebase-diff"]')?.addEventListener('click', (event) => rebaseDiff(event.currentTarget.dataset.diffId));
  app.querySelector('[data-action="previous-diff"]')?.addEventListener('click', previousDiff);
  app.querySelector('[data-action="next-diff"]')?.addEventListener('click', nextDiff);
  app.querySelector('[data-action="accept-all-diffs"]')?.addEventListener('click', acceptAllDiffs);
  app.querySelector('[data-action="reject-all-diffs"]')?.addEventListener('click', rejectAllDiffs);
  app.querySelector('[data-action="edit-clip-prompt"]')?.addEventListener('click', () => openRegenerationEditor('prompt'));
  app.querySelector('[data-action="change-clip-model"]')?.addEventListener('click', () => openRegenerationEditor('model'));
  app.querySelector('[data-action="reroll-clip-seed"]')?.addEventListener('click', rerollSelectedClip);
  app.querySelector('[data-action="compare-clip-variants"]')?.addEventListener('click', compareSelectedClipVariants);
  app.querySelector('[data-action="cancel-regeneration"]')?.addEventListener('click', closeRegenerationEditor);
  app.querySelector('[data-regeneration-form]')?.addEventListener('submit', submitClipRegeneration);
  app.querySelectorAll('[data-action="use-regeneration-candidate"]').forEach((button) => button.addEventListener('click', () => useRegenerationCandidate(button.dataset.jobId)));
  app.querySelector('[data-action="attach-clip-character"]')?.addEventListener('click', attachCharacterToSelectedClip);
  app.querySelectorAll('[data-action="remove-clip-character"]').forEach((button) => button.addEventListener('click', () => removeCharacterFromSelectedClip(button.dataset.versionId)));
  app.querySelector('[data-action="render"]')?.addEventListener('click', () => showToast('Render queue is ready for a FAL model hookup.'));
  app.querySelector('[data-action="export"]')?.addEventListener('click', () => showToast('Export will be connected after the composition pipeline is defined.'));
  if (!bindEvents.fullscreenHandlerBound) {
    document.addEventListener('fullscreenchange', () => {
      const button = app.querySelector('[data-action="toggle-fullscreen"]');
      if (!button) return;
      const active = Boolean(document.fullscreenElement);
      button.innerHTML = active ? icons.exitFullscreen : icons.fullscreen;
      button.title = active ? 'Exit full screen' : 'Full screen';
      button.setAttribute('aria-label', button.title);
    });
    bindEvents.fullscreenHandlerBound = true;
  }
  if (!bindEvents.escapeReviewHandlerBound) {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (state.previewDiffId) {
        event.preventDefault();
        event.stopPropagation();
        exitProposalPreview();
        return;
      }
      if (state.agentPromptModalOpen) {
        event.preventDefault();
        closeAgentPrompt();
      } else if (state.beatVideoModal) {
        event.preventDefault();
        closeBeatVideoModal();
      } else if (state.styleApplicationModal) {
        event.preventDefault();
        closeStyleApplicationModal();
      } else if (state.generateVideoModal) {
        event.preventDefault();
        closeGenerateVideoModal();
      } else if (state.isCharacterModalOpen) {
        event.preventDefault();
        closeCharacterModal();
      } else if (state.isStyleModalOpen) {
        event.preventDefault();
        closeStyleModal();
      } else if (state.expandedAgentRunId) {
        event.preventDefault();
        state.expandedAgentRunId = null;
        renderApp();
      }
    });
    bindEvents.escapeReviewHandlerBound = true;
  }
  checkFalStatus();
};
bindEvents.escapeReviewHandlerBound = false;

// Character modal (composer + detail) bindings, shared by the editor render
// and the storyboard modal layer.
const bindCharacterModalEvents = (root) => {
  root.querySelectorAll('[data-action="close-character-modal"]').forEach((element) => element.addEventListener('click', (event) => { if (event.currentTarget === event.target || event.currentTarget.tagName === 'BUTTON') closeCharacterModal(); }));
  root.querySelector('[data-character-name-form]')?.addEventListener('submit', renameCharacter);
  root.querySelector('[data-character-composer-form]')?.addEventListener('submit', submitCharacterComposer);
  root.querySelector('[data-action="retry-character-generation"]')?.addEventListener('click', retryCharacterComposer);
  root.querySelector('[data-action="record-character-version"]')?.addEventListener('click', recordCharacterVersion);
  root.querySelector('[data-action="lock-character"]')?.addEventListener('click', lockCharacter);
  root.querySelector('[data-action="unlock-character"]')?.addEventListener('click', unlockCharacter);
  root.querySelector('[data-action="delete-character"]')?.addEventListener('click', deleteCharacter);
  root.querySelectorAll('[data-action="activate-character-version"]').forEach((button) => button.addEventListener('click', () => activateCharacterVersion(button.dataset.versionId)));
  const composerPrompt = root.querySelector('#composerPrompt');
  if (composerPrompt) {
    attachMentionAutocomplete(composerPrompt, {
      getCharacters: () => project.characters,
      onInsert: ({characterId, name}) => { state.promptMentionMap[name] = characterId; },
    });
  }
};

const createCharacter = () => {
  state.selectedCharacterId = null;
  state.characterModalMode = 'composer';
  state.characterComposerInput = {name: '', prompt: '', styleNotes: '', referenceAssetIds: []};
  characterGenerationController = null;
  state.isCharacterModalOpen = true;
  renderApp();
};

const openCharacter = (characterId) => {
  state.selectedCharacterId = characterId;
  state.characterModalMode = 'detail';
  state.isCharacterModalOpen = true;
  renderApp();
};

const closeCharacterModal = () => {
  state.isCharacterModalOpen = false;
  renderApp();
};

const createStyle = () => {
  state.selectedStyleId = styleLibrary.createDraft('Untitled style').affectedId;
  state.isStyleModalOpen = true;
  renderApp();
};

const openStyle = (styleId) => {
  state.selectedStyleId = styleId;
  state.isStyleModalOpen = true;
  renderApp();
};

const closeStyleModal = () => {
  state.isStyleModalOpen = false;
  renderApp();
};

const closeStyleApplicationModal = () => {
  state.styleApplicationModal = null;
  renderApp();
};

const openStyleApplicationModal = ({clipIds = [...state.selectedClipIds], batchId = null} = {}) => {
  if (batchId) {
    const batch = styleApplicationBatchById(batchId);
    if (!batch) return;
    state.styleApplicationModal = {batchId, clipIds: batch.jobs.map((job) => job.clipId)};
    renderApp();
    return;
  }
  const readyStyles = state.styles.filter((style) => styleReferenceImageIds(style).length);
  const selectedStyle = readyStyles[0] || null;
  state.styleApplicationModal = {
    batchId: null,
    clipIds: [...new Set(clipIds)].filter((clipId) => clipById(clipId)),
    styleId: selectedStyle?.id || null,
    referenceAssetIds: styleReferenceImageIds(selectedStyle).slice(0, 4),
    instruction: defaultStyleInstruction(),
    preserveAudio: true,
    prices: {video: null, image: null},
    loadingPrices: true,
    submitting: false,
    error: '',
  };
  const modal = state.styleApplicationModal;
  renderApp();
  void loadModelCatalog().then((models) => {
    if (state.styleApplicationModal !== modal) return;
    modal.prices = {
      video: models.find((model) => model.id === DEFAULT_STYLE_VIDEO_MODEL)?.unitPrice ?? null,
      image: models.find((model) => model.id === DEFAULT_STYLE_IMAGE_MODEL)?.unitPrice ?? null,
    };
  }).catch(() => {}).finally(() => {
    if (state.styleApplicationModal !== modal) return;
    modal.loadingPrices = false;
    renderApp();
  });
};

const scheduleStyleApplicationPoll = (delay = 0) => {
  if (styleApplicationPollTimer) clearTimeout(styleApplicationPollTimer);
  styleApplicationPollTimer = setTimeout(async () => {
    if (styleApplicationPollInFlight) return scheduleStyleApplicationPoll(500);
    styleApplicationPollInFlight = true;
    try {
      const result = await styleApplicationController.tick();
      if (state.styleApplicationModal?.batchId || result.hasWork) renderApp();
      if (result.hasWork) scheduleStyleApplicationPoll(1200);
    } catch (error) {
      showToast(`Apply Style could not continue: ${error instanceof Error ? error.message : String(error)}`);
      scheduleStyleApplicationPoll(1800);
    } finally {
      styleApplicationPollInFlight = false;
    }
  }, delay);
};

const submitStyleApplication = (event) => {
  event.preventDefault();
  const modal = state.styleApplicationModal;
  if (!modal || modal.batchId || modal.submitting) return;
  const style = styleById(modal.styleId);
  const version = styleVersion(style);
  modal.submitting = true;
  modal.error = '';
  try {
    const batch = createStyleApplicationBatch({
      project,
      clips: modal.clipIds.map(clipById).filter(Boolean),
      style,
      styleVersion: version,
      referenceAssetIds: modal.referenceAssetIds,
      instruction: modal.instruction,
      preserveAudio: modal.preserveAudio,
      prices: modal.prices,
    });
    styleApplicationController.createBatch(batch);
    modal.batchId = batch.id;
    modal.submitting = false;
    renderApp();
    scheduleStyleApplicationPoll();
  } catch (error) {
    modal.submitting = false;
    modal.error = error instanceof Error ? error.message : String(error);
    renderApp();
  }
};

const retryStyleApplicationJob = (batchId, jobId) => {
  try {
    styleApplicationController.retry(batchId, jobId);
    renderApp();
    scheduleStyleApplicationPoll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const renameStyle = (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    styleLibrary.rename(state.selectedStyleId, String(form.get('name') || ''));
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const recordStyleVersion = () => {
  const assetIds = [...(app.querySelector('#styleVersionAssets')?.selectedOptions || [])].map((option) => option.value);
  if (!assetIds.length) return;
  styleLibrary.recordVersion(state.selectedStyleId, {
    referenceAssetIds: assetIds,
    prompt: '',
    modelId: 'local/manual',
    seed: null,
    params: {},
    parentAssetIds: assetIds,
  });
  renderApp();
};

const activateStyleVersion = (versionId) => {
  styleLibrary.activateVersion(state.selectedStyleId, versionId);
  renderApp();
};

const lockStyle = () => {
  const style = styleById(state.selectedStyleId);
  if (style?.activeVersionId) styleLibrary.lockVersion(style.id, style.activeVersionId);
  renderApp();
};

const unlockStyle = () => {
  styleLibrary.unlockVersion(state.selectedStyleId);
  renderApp();
};

const deleteStyle = () => {
  const style = styleById(state.selectedStyleId);
  if (!style) return;
  const versionIds = new Set(style.versions.map((version) => version.id));
  const clipCount = state.clips.filter((clip) => clip.provenance?.styleVersionIds?.some((versionId) => versionIds.has(versionId))).length;
  const proposalCount = project.timelineDiffs.items.filter((diff) =>
    diff.provenance?.styleVersionIds?.some((versionId) => versionIds.has(versionId))
    || diff.operations?.some((operation) => [operation.before, operation.after, operation.proposedClip]
      .some((clip) => clip?.provenance?.styleVersionIds?.some((versionId) => versionIds.has(versionId))))).length;
  const detail = clipCount || proposalCount
    ? ` This will detach it from ${clipCount} accepted clip${clipCount === 1 ? '' : 's'} and ${proposalCount} proposal${proposalCount === 1 ? '' : 's'} without deleting media.`
    : ' Imported and generated media will be preserved.';
  if (!globalThis.confirm?.(`Delete “${style.name}”?${detail}`)) return;
  try {
    styleLibrary.remove(style.id);
    state.isStyleModalOpen = false;
    state.selectedStyleId = null;
    renderApp();
    showToast(`Deleted ${style.name}.`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const renameCharacter = (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    characterLibrary.rename(state.selectedCharacterId, String(form.get('name') || ''));
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const recordCharacterVersion = () => {
  const assetId = app.querySelector('#characterVersionAsset')?.value;
  const asset = mediaById(assetId);
  if (!asset) return;
  characterLibrary.recordVersion(state.selectedCharacterId, {
    sheetAssetId: asset.id,
    referenceAssetIds: [asset.id],
    prompt: '',
    modelId: 'local/manual',
    seed: null,
    params: {},
    parentAssetIds: [asset.id],
  });
  renderApp();
};

const activateCharacterVersion = (versionId) => {
  characterLibrary.activateVersion(state.selectedCharacterId, versionId);
  renderApp();
};

const lockCharacter = () => {
  const character = characterById(state.selectedCharacterId);
  if (character?.activeVersionId) characterLibrary.lockVersion(character.id, character.activeVersionId);
  renderApp();
};

const unlockCharacter = () => {
  characterLibrary.unlockVersion(state.selectedCharacterId);
  renderApp();
};

const deleteCharacter = () => {
  const character = characterById(state.selectedCharacterId);
  if (!character) return;
  const attachedClipCount = state.clips.filter((clip) => (clip.provenance.characterVersionIds || [])
    .some((versionId) => character.versions.some((version) => version.id === versionId))).length;
  const attachmentNote = attachedClipCount ? ` This will detach it from ${attachedClipCount} timeline ${attachedClipCount === 1 ? 'clip' : 'clips'}.` : '';
  if (typeof globalThis.confirm === 'function' && !globalThis.confirm(`Delete character “${character.name}”?${attachmentNote}`)) return;
  try {
    clearTimeout(characterPollTimer);
    characterPollTimer = null;
    characterGenerationController = null;
    characterLibrary.remove(character.id);
    state.selectedCharacterId = null;
    state.isCharacterModalOpen = false;
    renderApp();
    showToast(`Deleted character “${character.name}”.`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const composerInputFromForm = () => {
  const form = characterModalLayer().querySelector('[data-character-composer-form]');
  if (!form) throw new Error('Character composer is unavailable.');
  const data = new FormData(form);
  const prompt = data.get('prompt');
  const {resolved} = resolveMentionedVersions({
    text: typeof prompt === 'string' ? prompt : '',
    mentionMap: state.promptMentionMap,
    project,
  });
  const mentionedSheetAssetIds = resolved
    .filter((entry) => entry.characterId !== state.selectedCharacterId && entry.sheetAssetId)
    .map((entry) => entry.sheetAssetId);
  return normalizeCharacterGenerationInput({
    name: data.get('name'),
    prompt,
    styleNotes: data.get('styleNotes'),
    referenceAssetIds: [...data.getAll('referenceAssetIds'), ...mentionedSheetAssetIds],
  });
};

const createComposerController = (characterId) => createCharacterGenerationController({
  adapter: characterGenerationAdapter,
  onCompleted: async (result, input) => {
    const recorded = recordCharacterSheetVersion({
      dispatch: updateProject,
      library: characterLibrary,
      characterId,
      input,
      result,
    });
    await persistGeneratedAsset(recorded.assetId);
  },
});

const submitCharacterComposer = async (event) => {
  event.preventDefault();
  try {
    const input = composerInputFromForm();
    state.characterComposerInput = input;
    if (!state.selectedCharacterId) {
      state.selectedCharacterId = characterLibrary.createDraft(input.name).affectedId;
      characterGenerationController = createComposerController(state.selectedCharacterId);
    } else {
      characterLibrary.rename(state.selectedCharacterId, input.name);
    }
    await characterGenerationController.submit(input);
    renderApp();
    scheduleCharacterPoll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const retryCharacterComposer = async () => {
  try {
    const input = composerInputFromForm();
    state.characterComposerInput = input;
    characterLibrary.rename(state.selectedCharacterId, input.name);
    characterLibrary.setStatus(state.selectedCharacterId, 'draft');
    await characterGenerationController.retry(input);
    renderApp();
    scheduleCharacterPoll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const scheduleCharacterPoll = () => {
  clearTimeout(characterPollTimer);
  characterPollTimer = setTimeout(pollCharacterGeneration, 250);
};

const pollCharacterGeneration = async () => {
  if (!characterGenerationController) return;
  const job = await characterGenerationController.poll();
  if (job.status === 'failed' && state.selectedCharacterId) {
    characterLibrary.setStatus(state.selectedCharacterId, 'failed');
  }
  if (job.status === 'ready') state.characterModalMode = 'detail';
  renderApp();
  if (job.status === 'generating' || job.status === 'retrying') scheduleCharacterPoll();
};

const openRegenerationEditor = (mode) => {
  if (!state.selectedClipId) return;
  state.regenerationEditorClipId = state.selectedClipId;
  state.regenerationEditorMode = mode;
  renderApp();
  const field = app.querySelector(mode === 'model' ? '#regenerationModel' : '#regenerationPrompt');
  field?.focus();
  field?.select();
};

const closeRegenerationEditor = () => {
  state.regenerationEditorClipId = null;
  renderApp();
};

const parseRegenerationForm = () => {
  const form = app.querySelector('[data-regeneration-form]');
  if (!form) throw new Error('The regeneration form is unavailable.');
  const data = new FormData(form);
  const seedText = String(data.get('seed') || '').trim();
  const numericSeed = Number(seedText);
  let params;
  try {
    params = JSON.parse(String(data.get('params') || '{}'));
  } catch {
    throw new Error('Parameters must be valid JSON.');
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Parameters must be a JSON object.');
  let qualitySettings;
  try {
    qualitySettings = JSON.parse(String(data.get('qualitySettings') || '{}'));
  } catch {
    throw new Error('Quality settings must be valid JSON.');
  }
  if (!qualitySettings || typeof qualitySettings !== 'object' || Array.isArray(qualitySettings)) throw new Error('Quality settings must be a JSON object.');
  return {
    prompt: String(data.get('prompt') || ''),
    modelId: String(data.get('modelId') || ''),
    seed: seedText === '' ? null : Number.isFinite(numericSeed) ? numericSeed : seedText,
    params,
    qualityTier: normalizeQualityTier(String(data.get('qualityTier') || 'draft')),
    qualitySettings,
  };
};

const submitClipRegeneration = async (event) => {
  event.preventDefault();
  const clip = clipById(state.selectedClipId);
  if (!clip) return;
  try {
    const parsed = parseRegenerationForm();
    const mention = await buildMentionPayload({prompt: parsed.prompt, modelId: parsed.modelId});
    await clipRegeneration.regenerateClip({
      clipId: clip.id,
      ...parsed,
      prompt: mention.prompt,
      referenceImageUrls: mention.referenceImageUrls,
      characterVersionIds: clip.provenance.characterVersionIds,
    });
    state.regenerationEditorClipId = null;
    renderApp();
    scheduleRegenerationPoll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const rerollSelectedClip = async () => {
  if (!state.selectedClipId) return;
  try {
    await clipRegeneration.rerollSeed(state.selectedClipId);
    renderApp();
    scheduleRegenerationPoll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const compareSelectedClipVariants = async () => {
  if (!state.selectedClipId) return;
  try {
    await clipRegeneration.compareVariants(state.selectedClipId, {count: 2});
    renderApp();
    scheduleRegenerationPoll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const scheduleRegenerationPoll = () => {
  clearTimeout(regenerationPollTimer);
  regenerationPollTimer = setTimeout(pollRegenerationJobs, 220);
};

const pollRegenerationJobs = async () => {
  const activeJobs = clipRegeneration.listJobs().filter((job) => job.status === 'queued' || job.status === 'running');
  await Promise.all(activeJobs.map((job) => clipRegeneration.poll(job.jobId)));
  for (const job of clipRegeneration.listJobs()) {
    if (!autoApplyRegenerationJobIds.has(job.jobId)) continue;
    if (job.status === 'completed' && !job.used) {
      autoApplyRegenerationJobIds.delete(job.jobId);
      try {
        const landed = clipRegeneration.useCandidate(job.jobId);
        if (landed.diffId) timelineDiffs.accept(landed.diffId);
        await persistGeneratedAsset(landed.assetId);
        showToast('Clip regenerated.');
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
      }
    } else if (job.status === 'failed') {
      autoApplyRegenerationJobIds.delete(job.jobId);
      showToast(job.error || 'Clip regeneration failed.');
    }
  }
  renderApp();
  if (clipRegeneration.listJobs().some((job) => job.status === 'queued' || job.status === 'running')) {
    scheduleRegenerationPoll();
  }
};

const useRegenerationCandidate = (jobId) => {
  try {
    clipRegeneration.useCandidate(jobId);
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const selectFirstDiff = () => {
  selectReviewItem(selectFirstReviewItem(state.pendingDiffs));
  state.previewDiffId = null;
  renderApp();
};

const navigateDiff = (direction) => {
  const current = selectedGhost();
  const item = direction < 0
    ? selectPreviousReviewItem(state.pendingDiffs, current?.key)
    : selectNextReviewItem(state.pendingDiffs, current?.key);
  if (!item) return;
  selectReviewItem(item);
  state.previewDiffId = null;
  renderApp();
};

const previousDiff = () => navigateDiff(-1);
const nextDiff = () => navigateDiff(1);

const selectNextAvailableReviewItem = (diffId, previousItems) => {
  const previousIndex = previousItems.findIndex((item) => item.diffId === diffId);
  const remaining = reviewItems();
  return remaining[previousIndex] || remaining[previousIndex - 1] || null;
};

const acceptDiff = (diffId) => {
  const previousItems = reviewItems();
  try {
    timelineDiffs.accept(diffId);
    selectReviewItem(selectNextAvailableReviewItem(diffId, previousItems));
    state.previewDiffId = null;
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const rejectDiff = (diffId) => {
  const previousItems = reviewItems();
  try {
    timelineDiffs.reject(diffId);
    selectReviewItem(selectNextAvailableReviewItem(diffId, previousItems));
    if (state.previewDiffId === diffId) state.previewDiffId = null;
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const previewDiff = (diffId) => {
  const diff = diffById(diffId);
  if (!diff) return;
  const item = reviewItemForDiff(diffId);
  if (item) selectReviewItem(item);
  state.previewDiffId = diffId;
  const firstChangedClip = diff.operations.find((operation) => operation.after || operation.before);
  const changedClip = firstChangedClip?.after || firstChangedClip?.before || null;
  state.currentTime = viewClip(changedClip)?.start ?? state.currentTime;
  if (state.isPlaying) {
    state.playbackOrigin = state.currentTime;
    state.playbackStartedAt = performance.now();
  }
  renderApp();
};

const exitProposalPreview = () => {
  if (!state.previewDiffId) return;
  state.previewDiffId = null;
  state.currentTime = Math.min(state.currentTime, playbackDuration());
  if (state.isPlaying) {
    state.playbackOrigin = state.currentTime;
    state.playbackStartedAt = performance.now();
  }
  state.previewPlaybackSignature = null;
  renderApp();
};

const rebaseDiff = (diffId) => {
  try {
    const result = timelineDiffs.rebase(diffId);
    if (result.conflicts?.length) {
      state.rebaseConflicts = {...state.rebaseConflicts, [diffId]: result.conflicts};
      renderApp();
      return;
    }
    const nextConflicts = {...state.rebaseConflicts};
    delete nextConflicts[diffId];
    state.rebaseConflicts = nextConflicts;
    selectReviewItem(reviewItemForDiff(result.affectedId));
    state.previewDiffId = null;
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const acceptAllDiffs = () => {
  try {
    timelineDiffs.acceptAll();
    state.selectedGhostKey = null;
    state.previewDiffId = null;
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const rejectAllDiffs = () => {
  timelineDiffs.rejectAll();
  state.selectedGhostKey = null;
  state.previewDiffId = null;
  renderApp();
};

const splitClipAtPlayhead = () => {
  const clip = viewClips().find((candidate) => state.currentTime >= candidate.start && state.currentTime < candidate.start + candidate.duration);
  if (!clip) {
    showToast('Place the playhead over a clip to split it.');
    return;
  }
  const result = updateProject({
    type: 'clip/split',
    clipId: clip.id,
    time: toLocalStart(project, state.activeActId, clip.sceneId, state.currentTime),
  });
  if (!result.changed) {
    showToast('Move the playhead away from the clip edge to split it.');
    return;
  }
  selectOnlyClip(result.affectedId);
  renderApp();
};

const addTrack = (kind) => {
  if (kind !== 'video' && kind !== 'audio') return;
  const result = updateProject({type: 'track/add', kind});
  state.trackMenuOpen = false;
  if (!result.changed) return;
  renderApp();
  showToast(`${kind[0].toUpperCase()}${kind.slice(1)} track added.`);
};

const dropOnTimeline = (event, trackId) => {
  const mediaId = event.dataTransfer.getData('text/media-id');
  const clipId = event.dataTransfer.getData('text/clip-id');
  const ghostKey = event.dataTransfer.getData('text/ghost-key');
  const transitionType = event.dataTransfer.getData('text/transition-type');
  const payload = state.dragPayload;
  const start = payload?.native && payload.id === (clipId || ghostKey || mediaId) && payload.type !== 'media'
    ? Math.max(0, rawTimeFromClientX(event.clientX) - payload.grabOffset)
    : undefined;
  placeOnTimeline({mediaId, clipId, ghostKey, transitionType, clientX: event.clientX, trackId, start});
  state.dragPayload = null;
};

// Snaps a transition drop to the nearest clip edge on a video track, preferring
// the hovered lane, and classifies the edge as between-clips or a lone edge.
const snapTransitionDrop = (time, preferredTrackId = null) => {
  const clips = viewClips();
  const videoTrackIds = new Set(state.tracks.filter((track) => track.kind === 'video').map((track) => track.id));
  const candidateTrackIds = preferredTrackId && videoTrackIds.has(preferredTrackId)
    && clips.some((clip) => clip.trackId === preferredTrackId)
    ? new Set([preferredTrackId])
    : videoTrackIds;
  let best = null;
  clips.forEach((clip) => {
    if (!candidateTrackIds.has(clip.trackId)) return;
    [clip.start, clip.start + clip.duration].forEach((edge) => {
      const distance = Math.abs(edge - time);
      if (!best || distance < best.distance) best = {distance, edgeTime: edge, trackId: clip.trackId};
    });
  });
  if (!best) return null;
  const clipsOnTrack = clips.filter((clip) => clip.trackId === best.trackId);
  const fromClip = clipsOnTrack.find((clip) => Math.abs(clip.start + clip.duration - best.edgeTime) <= TRANSITION_EDGE_EPSILON) || null;
  const toClip = clipsOnTrack.find((clip) => Math.abs(clip.start - best.edgeTime) <= TRANSITION_EDGE_EPSILON) || null;
  return {...best, fromClipId: fromClip?.id || null, toClipId: toClip?.id || null};
};

const captureAssetFrame = async (asset, time) => {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = asset.url;
  try {
    const {blob} = await captureVideoFrame(video, time, {maxWidth: 1280, quality: 0.92});
    return await blobToDataUrl(blob);
  } finally {
    video.removeAttribute('src');
    video.load?.();
  }
};

const beatForClip = (clip) => {
  const beatId = clip?.provenance?.params?.storyboardBeatId;
  if (!beatId || !project.storyboard?.nodes) return null;
  for (const node of project.storyboard.nodes) {
    if (node.kind !== 'act') continue;
    const beat = (node.beats || []).find((entry) => entry.id === beatId);
    if (beat) return beat;
  }
  return null;
};

// The bridging prompt is written by the project LLM from the two neighboring
// shots' own video prompts; the static template is the offline fallback.
const generateGapFillPrompt = async ({fromClip, toClip}) => {
  const fromBeat = beatForClip(fromClip);
  const toBeat = beatForClip(toClip);
  const styleBible = project.storyboard?.visualStyle || '';
  const fallback = buildGapFillPrompt({
    styleBible,
    fromText: fromBeat?.text || '',
    toText: toBeat?.text || '',
  });
  try {
    const response = await callLlm({messages: buildGapFillPromptMessages({
      styleBible,
      fromBeat: {
        text: fromBeat?.text || '',
        videoPrompt: fromClip?.provenance?.prompt || fromBeat?.videoPrompt?.text || '',
      },
      toBeat: {
        text: toBeat?.text || '',
        videoPrompt: toClip?.provenance?.prompt || toBeat?.videoPrompt?.text || '',
      },
    })});
    const text = String(response?.choices?.[0]?.message?.content || '')
      .replace(/^```(?:[a-z]+)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    if (!text) return fallback;
    return /No music or musical score/i.test(text) ? text : `${text}\n${NO_MUSIC_DIRECTION}`;
  } catch {
    return fallback;
  }
};

const startGapFill = async (viewTime, trackId) => {
  try {
    const active = timelineAddGeneration.snapshot();
    if (['queued', 'running', 'retrying'].includes(active.status)) {
      throw new Error('Another timeline generation is already running — try again when it finishes.');
    }
    const track = state.tracks.find((entry) => entry.id === trackId);
    if (track?.kind !== 'video') throw new Error('Drop the gap filler on a video track.');
    const pair = findGapFillPair({clips: viewClips(), trackId, time: viewTime});
    if (!pair) throw new Error('Fill gap needs two clips in sequence — drop it between the two videos to bridge.');
    const fromClip = clipById(pair.fromClipId);
    const toClip = clipById(pair.toClipId);
    const fromAsset = fromClip ? mediaById(fromClip.assetId) : null;
    const toAsset = toClip ? mediaById(toClip.assetId) : null;
    if (fromAsset?.kind !== 'video' || toAsset?.kind !== 'video') {
      throw new Error('Fill gap can only bridge two video clips.');
    }
    showToast('Capturing boundary frames and writing the bridging prompt…');
    const times = gapFillCaptureTimes({fromClip, toClip});
    const [firstFrameUrl, lastFrameUrl, prompt] = await Promise.all([
      captureAssetFrame(fromAsset, times.fromTime),
      captureAssetFrame(toAsset, times.toTime),
      generateGapFillPrompt({fromClip, toClip}),
    ]);
    await timelineAddGeneration.submit({
      operation: 'add',
      prompt,
      modelId: FILL_GAP_MODEL_ID,
      trackId: fromClip.trackId,
      sceneId: fromClip.sceneId,
      start: fromClip.start + fromClip.duration,
      duration: FILL_GAP_DURATION,
      parentAssetIds: [fromAsset.id, toAsset.id],
      params: {
        first_frame_url: firstFrameUrl,
        last_frame_url: lastFrameUrl,
        duration: `${FILL_GAP_DURATION}s`,
        resolution: '720p',
        generate_audio: true,
        gapFillToClipId: toClip.id,
      },
    });
    const submitted = timelineAddGeneration.snapshot();
    if (submitted.status === 'failed') throw new Error(submitted.error || 'Gap fill submission failed.');
    scheduleGenerateVideoPoll();
    showToast('Generating the bridging shot — it will slot in between the two clips when ready.');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
  renderApp();
};

const removeTransition = (transitionId) => {
  if (!transitionId || !state.transitions.some((transition) => transition.id === transitionId)) return false;
  const result = updateProject({type: 'transition/remove', transitionId});
  if (!result.changed) return false;
  if (state.selectedTransitionId === transitionId) state.selectedTransitionId = null;
  renderApp();
  return true;
};

const deleteSelectedTransition = () => removeTransition(state.selectedTransitionId);

const clearTimelineDragGuide = () => {
  const guide = app.querySelector('#timelineDragGuide');
  if (guide) guide.hidden = true;
};

const createTimelineDragPreview = (media) => {
  const preview = document.createElement('div');
  preview.className = `timeline-clip ${media.kind} timeline-drag-preview`;
  preview.innerHTML = renderClipContents(media, media.kind === 'image' ? 5 : Math.max(0.1, media.duration || 5));
  preview.style.width = `${Math.max((media.kind === 'image' ? 5 : Math.max(0.1, media.duration || 5)) * scale(), 66)}px`;
  return preview;
};

const updateTimelineDragPreview = (payload, clientX, clientY) => {
  const target = document.elementFromPoint(clientX, clientY);
  const lane = target?.closest('.track-lane');
  if (!lane) return false;

  const start = Math.max(0, rawTimeFromClientX(clientX) - payload.grabOffset);
  payload.currentStart = start;
  payload.currentTrackId = lane.dataset.trackId;

  if (payload.type === 'clip' || payload.type === 'ghost') {
    if (payload.element.parentElement !== lane) lane.append(payload.element);
    payload.element.classList.add('dragging');
    payload.element.style.left = `${start * scale()}px`;
  } else if (payload.type === 'media') {
    if (!payload.previewElement) payload.previewElement = createTimelineDragPreview(mediaById(payload.id));
    if (payload.previewElement && payload.previewElement.parentElement !== lane) lane.append(payload.previewElement);
    if (payload.previewElement) payload.previewElement.style.left = `${start * scale()}px`;
  } else if (payload.type === 'transition') {
    payload.snap = snapTransitionDrop(rawTimeFromClientX(clientX), lane.dataset.trackId);
  }

  const guide = app.querySelector('#timelineDragGuide');
  if (guide) {
    guide.hidden = false;
    const snapped = payload.type === 'transition' && payload.snap;
    guide.classList.toggle('snapped', Boolean(snapped));
    guide.style.left = `${(snapped ? payload.snap.edgeTime : start) * scale()}px`;
  }
  return true;
};

const cleanupPointerDrag = (payload) => {
  payload?.element?.classList?.remove('dragging', 'trimming');
  payload?.previewElement?.remove();
  clearTimelineDragGuide();
  document.body.classList.remove('dragging-payload');
};

const clearNativeDrag = () => {
  if (state.dragPayload?.native) state.dragPayload = null;
  clearTimelineDragGuide();
};

let suppressTimelineClickUntil = 0;

const startTimelineMarquee = (event) => {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  if (!event.target.closest('.track-lane')) return;
  if (event.target.closest('.timeline-clip, .timeline-ghost, .timeline-transition, .generation-pending, .clip-handle')) return;
  const content = event.currentTarget;
  const contentRect = content.getBoundingClientRect();
  const additive = event.shiftKey || event.metaKey || event.ctrlKey;
  const baseSelection = additive ? new Set(state.selectedClipIds) : new Set();
  const originalSelection = new Set(state.selectedClipIds);
  const originalPrimary = state.selectedClipId;
  const payload = {
    startX: event.clientX,
    startY: event.clientY,
    dragging: false,
    marquee: null,
  };

  const localPoint = (clientX, clientY) => ({
    x: Math.min(Math.max(0, clientX - contentRect.left), contentRect.width),
    y: Math.min(Math.max(0, clientY - contentRect.top), contentRect.height),
  });

  const paintSelection = (nextSelection) => {
    state.selectedClipIds = nextSelection;
    state.selectedClipId = nextSelection.has(originalPrimary)
      ? originalPrimary
      : [...nextSelection].at(-1) || null;
    content.querySelectorAll('.timeline-clip[data-clip-id]').forEach((clipElement) => {
      const selected = nextSelection.has(clipElement.dataset.clipId);
      clipElement.classList.toggle('selected', selected);
      clipElement.setAttribute('aria-selected', String(selected));
    });
  };

  const onPointerMove = (moveEvent) => {
    const moved = Math.hypot(moveEvent.clientX - payload.startX, moveEvent.clientY - payload.startY) >= 4;
    if (!payload.dragging && !moved) return;
    if (!payload.dragging) {
      payload.dragging = true;
      payload.marquee = document.createElement('div');
      payload.marquee.className = 'timeline-selection-marquee';
      content.append(payload.marquee);
      state.selectedTransitionId = null;
      state.selectedGhostKey = null;
      state.previewDiffId = null;
    }
    const start = localPoint(payload.startX, payload.startY);
    const end = localPoint(moveEvent.clientX, moveEvent.clientY);
    const left = Math.min(start.x, end.x);
    const right = Math.max(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const bottom = Math.max(start.y, end.y);
    Object.assign(payload.marquee.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
    });
    const selectionRect = {
      left: contentRect.left + left,
      right: contentRect.left + right,
      top: contentRect.top + top,
      bottom: contentRect.top + bottom,
    };
    const intersecting = [...content.querySelectorAll('.timeline-clip[data-clip-id]')]
      .filter((clipElement) => {
        const rect = clipElement.getBoundingClientRect();
        return rect.right >= selectionRect.left && rect.left <= selectionRect.right
          && rect.bottom >= selectionRect.top && rect.top <= selectionRect.bottom;
      })
      .map((clipElement) => clipElement.dataset.clipId);
    paintSelection(new Set([...baseSelection, ...intersecting]));
    moveEvent.preventDefault();
  };

  const finish = (upEvent, cancelled = false) => {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    payload.marquee?.remove();
    if (!payload.dragging) return;
    if (cancelled) {
      state.selectedClipId = originalPrimary;
      paintSelection(originalSelection);
    } else {
      suppressTimelineClickUntil = performance.now() + 250;
      upEvent.preventDefault();
    }
  };

  const onPointerUp = (upEvent) => finish(upEvent);
  const onPointerCancel = (cancelEvent) => finish(cancelEvent, true);
  document.addEventListener('pointermove', onPointerMove, {passive: false});
  document.addEventListener('pointerup', onPointerUp, {passive: false});
  document.addEventListener('pointercancel', onPointerCancel);
};

const startTrimDrag = (event, clipId, edge) => {
  if (event.button !== 0) return;
  const acceptedClip = clipById(clipId);
  const clip = viewClip(acceptedClip);
  const element = event.currentTarget.closest('.timeline-clip');
  if (!clip || !element) return;
  event.preventDefault();
  event.stopPropagation();

  const payload = {
    type: 'trim',
    id: clipId,
    edge,
    startX: event.clientX,
    startY: event.clientY,
    originalStart: clip.start,
    originalDuration: clip.duration,
    originalEnd: clip.start + clip.duration,
    currentStart: clip.start,
    currentDuration: clip.duration,
    element,
    dragging: false,
  };
  state.dragPayload = payload;
  document.body.classList.add('dragging-payload');

  const onPointerMove = (moveEvent) => {
    if (state.dragPayload !== payload) return;
    const moved = Math.hypot(moveEvent.clientX - payload.startX, moveEvent.clientY - payload.startY) >= 4;
    if (!payload.dragging && !moved) return;
    payload.dragging = true;
    const pointerTime = rawTimeFromClientX(moveEvent.clientX);
    if (edge === 'left') {
      payload.currentStart = Math.min(Math.max(0, pointerTime), payload.originalEnd - 0.1);
      payload.currentDuration = Math.max(0.1, payload.originalEnd - payload.currentStart);
    } else {
      payload.currentStart = payload.originalStart;
      payload.currentDuration = Math.max(0.1, pointerTime - payload.originalStart);
    }
    element.classList.add('trimming');
    element.style.left = `${payload.currentStart * scale()}px`;
    element.style.width = `${Math.max(payload.currentDuration * scale(), 66)}px`;
    const durationLabel = element.querySelector('.clip-copy span');
    if (durationLabel) durationLabel.textContent = formatTime(payload.currentDuration);
    const guide = app.querySelector('#timelineDragGuide');
    if (guide) {
      guide.hidden = false;
      guide.style.left = `${(edge === 'left' ? payload.currentStart : payload.currentStart + payload.currentDuration) * scale()}px`;
    }
    moveEvent.preventDefault();
  };

  const finish = (upEvent, cancelled = false) => {
    if (state.dragPayload !== payload) return;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    const moved = payload.dragging;
    cleanupPointerDrag(payload);
    state.dragPayload = null;
    if (!moved) return;
    if (!cancelled) {
      updateProject({
        type: 'clip/trim',
        clipId,
        edge,
        start: toLocalStart(project, state.activeActId, acceptedClip.sceneId, payload.currentStart),
        duration: payload.currentDuration,
      });
    }
    renderApp();
  };

  const onPointerUp = (upEvent) => finish(upEvent);
  const onPointerCancel = (cancelEvent) => finish(cancelEvent, true);
  document.addEventListener('pointermove', onPointerMove, {passive: false});
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
};

const startPointerDrag = (event, type, id) => {
  if (event.button !== 0) return;
  event.preventDefault();
  const source = type === 'clip'
    ? viewClipById(id)
    : type === 'ghost'
      ? viewClip(findGhostItem(state.pendingDiffs, id)?.clip)
      : type === 'transition'
        ? null
        : mediaById(id);
  const sourceStart = Number.isFinite(source?.start) ? source.start : 0;
  const payload = {
    type,
    id,
    startX: event.clientX,
    startY: event.clientY,
    grabOffset: type === 'transition' ? 0 : rawTimeFromClientX(event.clientX) - sourceStart,
    currentStart: sourceStart,
    currentTrackId: source?.trackId || null,
    element: event.currentTarget,
    previewElement: null,
    dragging: false,
  };
  state.dragPayload = payload;
  document.body.classList.add('dragging-payload');

  const onPointerMove = (moveEvent) => {
    if (!state.dragPayload) return;
    const moved = Math.hypot(moveEvent.clientX - payload.startX, moveEvent.clientY - payload.startY) >= 4;
    if (!payload.dragging && !moved) return;
    payload.dragging = true;
    updateTimelineDragPreview(payload, moveEvent.clientX, moveEvent.clientY);
    moveEvent.preventDefault();
  };

  const finish = (upEvent, cancelled = false) => {
    if (state.dragPayload !== payload) return;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    const target = cancelled ? null : document.elementFromPoint(upEvent.clientX, upEvent.clientY);
    const lane = target?.closest('.track-lane');
    const moved = payload.dragging;
    const canPlace = moved && lane && Number.isFinite(payload.currentStart);
    const finalStart = payload.currentStart;
    const finalTrackId = payload.currentTrackId;
    cleanupPointerDrag(payload);
    state.dragPayload = null;

    if (!moved) return;
    if (canPlace) {
      placeOnTimeline({
        mediaId: type === 'media' ? id : '',
        clipId: type === 'clip' ? id : '',
        ghostKey: type === 'ghost' ? id : '',
        transitionType: type === 'transition' ? id : '',
        clientX: upEvent.clientX,
        trackId: finalTrackId,
        start: finalStart,
      });
    } else {
      renderApp();
    }
  };

  const onPointerUp = (upEvent) => {
    finish(upEvent);
  };

  const onPointerCancel = (cancelEvent) => finish(cancelEvent, true);

  document.addEventListener('pointermove', onPointerMove, {passive: false});
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
};

const placeOnTimeline = ({mediaId, clipId, ghostKey, transitionType, clientX, trackId, start: requestedStart}) => {
  const viewStart = Number.isFinite(requestedStart) ? Math.max(0, requestedStart) : timeFromClientX(clientX);
  if (transitionType === FILL_GAP_TRANSITION_KEY) {
    void startGapFill(viewStart, trackId);
    return;
  }
  if (transitionType) {
    const snap = snapTransitionDrop(viewStart, trackId);
    if (!snap) {
      showToast('Add clips to a video track before dropping a transition.');
    } else {
      try {
        const result = updateProject({type: 'transition/add', transitionType, fromClipId: snap.fromClipId, toClipId: snap.toClipId});
        state.selectedTransitionId = result.affectedId;
        clearTimelineClipSelection();
        state.selectedGhostKey = null;
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error));
      }
    }
    renderApp();
    return;
  }
  if (mediaId) {
    const media = mediaById(mediaId);
    if (!media) return;
    const placement = placementForViewStart(viewStart);
    const result = updateProject({
      type: 'clip/add',
      assetId: mediaId,
      trackId,
      start: placement.start,
      sceneId: placement.sceneId,
    });
    selectOnlyClip(result.affectedId);
  } else if (clipId) {
    const clip = clipById(clipId);
    if (!clip) return;
    const placement = placementForViewStart(viewStart, clip.sceneId);
    const result = updateProject({type: 'clip/move', clipId, trackId, start: placement.start});
    selectOnlyClip(result.affectedId);
  } else if (ghostKey) {
    const ghost = findGhostItem(state.pendingDiffs, ghostKey);
    const diff = ghost ? diffById(ghost.diffId) : null;
    if (!ghost || !diff || ghost.role === 'origin' || ghost.type === 'remove') return;
    try {
      const placement = placementForViewStart(viewStart, ghost.clip?.sceneId || null);
      const revised = reviseGhostProposal(diff, ghost.operationIndex, {start: placement.start, trackId});
      const result = timelineDiffs.createProposal({...revised, baseRevision: project.timeline.revision});
      timelineDiffs.reject(diff.id);
      selectReviewItem(reviewItemForDiff(result.affectedId));
      state.previewDiffId = null;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  }
  renderApp();
};

const timeFromPointer = (event) => {
  return timeFromClientX(event.clientX);
};

const timeFromClientX = (clientX) => {
  const content = app.querySelector('#timelineContent');
  const scroll = app.querySelector('#timelineScroll');
  if (!content || !scroll) return 0;
  const rect = content.getBoundingClientRect();
  return Math.max(0, Math.round(rawTimeFromClientX(clientX) * 10) / 10);
};

const rawTimeFromClientX = (clientX) => {
  const content = app.querySelector('#timelineContent');
  const scroll = app.querySelector('#timelineScroll');
  if (!content || !scroll) return 0;
  const rect = content.getBoundingClientRect();
  return Math.max(0, (clientX - rect.left) / scale());
};

const seekFromTimeline = (event) => seekTo(timeFromPointer(event));

const addFiles = async (files) => {
  const acceptedFiles = files.filter((file) => file.type.startsWith('video/') || file.type.startsWith('audio/') || file.type.startsWith('image/'));
  await Promise.all(acceptedFiles.map(async (file) => {
    const kind = mediaKind(file);
    const result = updateProject({
      type: 'asset/import',
      asset: {
        name: file.name,
        kind,
        mimeType: file.type,
        size: file.size,
        duration: kind === 'image' ? 5 : 0,
        sceneId: activeActSceneId(),
        url: URL.createObjectURL(file),
        source: {type: 'local-file', fileName: file.name, lastModified: file.lastModified},
        metadata: {},
      },
    });
    const item = mediaById(result.affectedId);
    try {
      await projectDatabase.putAsset(item.id, file);
    } catch {
      showToast('Media imported for this session, but could not be saved for refresh.');
    }
    if (kind === 'image') renderApp();
    else {
      const probe = document.createElement(kind === 'audio' ? 'audio' : 'video');
      probe.preload = 'metadata';
      probe.src = item.url;
      probe.onloadedmetadata = () => {
        const duration = Number.isFinite(probe.duration) ? probe.duration : 5;
        updateProject({type: 'asset/update', assetId: item.id, patch: {duration}});
        renderApp();
        if (kind === 'video') {
          void videoIndexer.run({asset: mediaById(item.id), video: probe, duration}).catch((error) => {
            updateProject({type: 'asset/update', assetId: item.id, patch: {metadata: {videoIndex: {status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString()}}}});
            showToast(`Video indexing failed: ${error instanceof Error ? error.message : String(error)}`);
            renderApp();
          });
        }
      };
      probe.onerror = () => { updateProject({type: 'asset/update', assetId: item.id, patch: {duration: 5}}); renderApp(); };
    }
  }));
  if (acceptedFiles.length) showToast(`${acceptedFiles.length} media ${acceptedFiles.length === 1 ? 'file' : 'files'} imported.`);
};

const removeMedia = (mediaId) => {
  const clips = state.clips.filter((clip) => clip.assetId === mediaId);
  clips.forEach((clip) => state.selectedClipIds.delete(clip.id));
  if (!state.selectedClipIds.has(state.selectedClipId)) state.selectedClipId = [...state.selectedClipIds].at(-1) || null;
  const item = mediaById(mediaId);
  if (item?.url) URL.revokeObjectURL(item.url);
  updateProject({type: 'asset/remove', assetId: mediaId});
  void projectDatabase.removeAsset(mediaId).catch(() => {});
  renderApp();
};

const removeClip = (clipId) => {
  if (!clipId || !clipById(clipId)) return false;
  const result = updateProject({type: 'clip/remove', clipId});
  if (!result.changed) return false;
  state.selectedClipIds.delete(clipId);
  if (state.selectedClipId === clipId) state.selectedClipId = [...state.selectedClipIds].at(-1) || null;
  if (state.regenerationEditorClipId === clipId) state.regenerationEditorClipId = null;
  renderApp();
  return true;
};

const deleteSelectedClip = () => removeClip(state.selectedClipId);

const detachAudioFromClip = async (clipId) => {
  const clip = clipById(clipId);
  const asset = mediaById(clip?.assetId);
  if (!clip || asset?.kind !== 'video' || clip.audioDetached) return false;
  showToast('Extracting audio…');
  let extracted;
  try {
    let blob = null;
    try { blob = await projectDatabase.getAsset(asset.id); } catch {}
    if (!blob && asset.url) blob = await fetch(asset.url).then((response) => response.ok ? response.blob() : null).catch(() => null);
    if (!blob) throw new Error('The source media for this clip is unavailable.');
    extracted = await extractAudioFromBlob(blob);
  } catch (error) {
    if (error instanceof AudioExtractError && error.code === 'no-audio') showToast('This video has no audio track.');
    else showToast(`Audio could not be detached: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  const audioAssetId = `media-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  const url = URL.createObjectURL(extracted.wavBlob);
  const result = updateProject({
    type: 'clip/detach-audio',
    clipId,
    audioAsset: {
      id: audioAssetId,
      name: `${asset.name} (audio)`,
      kind: 'audio',
      mimeType: 'audio/wav',
      size: extracted.wavBlob.size,
      duration: extracted.duration,
      url,
      source: {type: 'detached-audio', fileName: asset.name},
      metadata: {},
    },
  });
  if (!result.changed) {
    URL.revokeObjectURL(url);
    return false;
  }
  try {
    await projectDatabase.putAsset(audioAssetId, extracted.wavBlob);
  } catch {
    showToast('Audio detached for this session, but could not be saved for refresh.');
  }
  renderApp();
  showToast('Audio detached to the audio track.');
  void audioIndexer.run({asset: mediaById(audioAssetId), blob: extracted.wavBlob, audioBuffer: extracted.audioBuffer}).catch((error) => {
    showToast(`Audio transcription failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return true;
};

const GENERATION_DURATIONS = [4, 5, 6, 8, 10, 12];

const loadModelCatalog = () => {
  modelCatalogPromise ||= (async () => {
    let records = [];
    try { records = await projectDatabase.loadModelPricing(); } catch {}
    if (!records.length) {
      const response = await fetch('/fal-model-pricing.json');
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || 'Model catalog is unavailable.');
      records = payload.records || [];
      void projectDatabase.replaceModelPricing(records).catch(() => {});
    }
    const rank = (model) => model.category === 'text-to-video' ? 0 : model.category === 'image-to-video' ? 1 : model.category.includes('video') ? 2 : 3;
    return records.map((record) => {
      const metadata = record.model?.metadata || {};
      const price = (Array.isArray(record.prices) ? record.prices : [])[0] || {};
      return {
        id: record.endpointId || record.id,
        name: metadata.display_name || record.endpointId || record.id,
        category: metadata.category || 'unknown',
        tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
        unitPrice: Number.isFinite(price.unit_price) ? price.unit_price : null,
        unit: price.unit || null,
      };
    }).sort((a, b) => rank(a) - rank(b) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  })();
  return modelCatalogPromise;
};

const modalModel = (modal) => modal?.models.find((entry) => entry.id === modal.modelId) || null;

const loadModelInputs = () => {
  modelInputsPromise ||= fetch('/fal-model-inputs.json')
    .then((response) => response.ok ? response.json() : {})
    .then((payload) => payload.models || {})
    .catch(() => { modelInputsPromise = null; return {}; });
  return modelInputsPromise;
};

const attachPromptMentions = (selector) => {
  const textarea = app.querySelector(selector);
  if (!textarea) return;
  attachMentionAutocomplete(textarea, {
    getCharacters: () => project.characters,
    onInsert: ({characterId, name}) => { state.promptMentionMap[name] = characterId; },
  });
};

const buildMentionPayload = async ({prompt, modelId}) => {
  const {resolved, unresolved} = resolveMentionedVersions({
    text: prompt,
    mentionMap: state.promptMentionMap,
    project,
  });
  if (unresolved.length) {
    showToast(`No sheet versions yet for ${unresolved.map((entry) => entry.name).join(', ')} — mention kept as plain text.`);
  }
  if (!resolved.length) return {prompt, referenceImageUrls: [], characterVersionIds: []};
  const expandedPrompt = expandMentionPrompt({text: prompt, resolved});
  const imageInput = imageInputFor(modelId, await loadModelInputs());
  let referenceImageUrls = [];
  if (imageInput) {
    const urls = await Promise.all(resolved.map(async (entry) => {
      const url = project.mediaAssets.find((asset) => asset.id === entry.sheetAssetId)?.url || null;
      try {
        return await toUploadableUrl(url);
      } catch (error) {
        showToast(`${entry.characterName}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    }));
    referenceImageUrls = urls.filter(Boolean);
    if (!imageInput.isArray) referenceImageUrls = referenceImageUrls.slice(0, 1);
  } else {
    showToast('This model is text-only — using character descriptions without the sprite sheet.');
  }
  return {
    prompt: expandedPrompt,
    referenceImageUrls,
    characterVersionIds: resolved.map((entry) => entry.versionId),
  };
};

const resolveStyleAssetUrl = async (asset) => {
  if (!asset?.id) throw new Error('The media asset is unavailable.');
  if (/^https:\/\//i.test(asset.url || '')) return asset.url;
  if (!styleAssetUploadPromises.has(asset.id)) {
    const upload = (async () => {
      let blob = await projectDatabase.getAsset(asset.id).catch(() => null);
      if (!blob && asset.url) {
        const response = await fetch(asset.url);
        if (!response.ok) throw new Error(`Could not read ${asset.name} (${response.status}).`);
        blob = await response.blob();
      }
      if (!blob) throw new Error(`Re-import ${asset.name} before applying a style.`);
      const uploaded = await styleApplicationAdapter.uploadAsset(blob, {
        fileName: asset.source?.fileName || asset.name || `${asset.id}.${asset.kind === 'image' ? 'png' : 'mp4'}`,
        mimeType: asset.mimeType || blob.type,
      });
      if (!/^https:\/\//i.test(uploaded?.url || '')) throw new Error('fal upload did not return a secure media URL.');
      return uploaded.url;
    })().catch((error) => {
      styleAssetUploadPromises.delete(asset.id);
      throw error;
    });
    styleAssetUploadPromises.set(asset.id, upload);
  }
  return styleAssetUploadPromises.get(asset.id);
};

const persistGeneratedAsset = async (assetId) => {
  const asset = project.mediaAssets.find((entry) => entry.id === assetId);
  if (!asset?.url) return;
  try {
    const response = await fetch(asset.url);
    if (!response.ok) throw new Error(`Asset download failed (${response.status}).`);
    const blob = await response.blob();
    await projectDatabase.putAsset(assetId, blob);
    updateProject({type: 'asset/update', assetId, patch: {url: URL.createObjectURL(blob), size: blob.size}});
  } catch {
    // Keep the remote URL when the download fails; playback still works while online.
  }
};

const scoreGenerationLabel = () => ({
  direction: 'Directing…',
  composing: 'Composing…',
  rendering: 'Rendering…',
}[state.scoreGeneration?.phase] || 'Scoring…');

// Moondream frame annotations already captured by the video index; one
// representative annotation per timeline asset, best-effort.
const collectScoreAnnotations = async () => {
  const annotations = {};
  const assetIds = [...new Set(project.timeline.clips.map((clip) => clip.assetId))];
  await Promise.all(assetIds.map(async (assetId) => {
    try {
      const frames = await projectDatabase.getVideoFrames(assetId);
      const annotated = (frames || []).filter((frame) => frame.annotation);
      if (annotated.length) annotations[assetId] = annotated[Math.floor(annotated.length / 2)].annotation;
    } catch {
      // The frame index is optional context; scoring works without it.
    }
  }));
  return annotations;
};

const generateBackgroundScore = async () => {
  if (state.scoreGeneration) return;
  try {
    const context = buildScoreContext({
      project,
      clips: visibleClips(project, 'all'),
      annotations: await collectScoreAnnotations(),
    });
    state.scoreGeneration = {phase: 'direction', durationMs: context.durationMs};
    renderApp();
    const direction = await musicGenerationAdapter.generateScoreDirection({context});
    state.scoreGeneration = {phase: 'composing', durationMs: context.durationMs, cueSheet: direction.cueSheet};
    renderApp();
    const submitted = await musicGenerationAdapter.submitScore({
      cueSheet: direction.cueSheet,
      durationMs: context.durationMs,
    });
    state.scoreGeneration = {...state.scoreGeneration, phase: 'rendering', jobId: submitted.jobId};
    renderApp();
    scheduleScorePoll();
  } catch (error) {
    state.scoreGeneration = null;
    showToast(error instanceof Error ? error.message : String(error));
    renderApp();
  }
};

const scheduleScorePoll = () => {
  clearTimeout(scorePollTimer);
  scorePollTimer = setTimeout(pollScoreJob, 2500);
};

const pollScoreJob = async () => {
  const generation = state.scoreGeneration;
  if (!generation?.jobId) return;
  try {
    const job = await musicGenerationAdapter.getScoreJob(generation.jobId);
    if (job.status === 'failed') throw new Error(job.error || 'Score generation failed.');
    if (job.status !== 'completed') {
      scheduleScorePoll();
      return;
    }
    await landScoreResult(job, generation);
    state.scoreGeneration = null;
    showToast('Background score added to the audio track.');
  } catch (error) {
    state.scoreGeneration = null;
    showToast(error instanceof Error ? error.message : String(error));
  }
  renderApp();
};

// Beat-syncs the score: detect onsets in the rendered audio and pick the
// global delay that lands them closest to the cue sheet's hit points.
const scoreBeatDelaySec = async (blob, cueSheet) => {
  const hitPoints = (cueSheet?.hitPoints || []).map((hit) => hit.timeMs);
  if (!hitPoints.length || typeof globalThis.AudioContext !== 'function') return 0;
  const audioContext = new AudioContext();
  try {
    const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const beats = detectBeats(monoSamples(decoded), decoded.sampleRate);
    return bestAlignmentOffset(hitPoints, beats).offsetMs / 1000;
  } catch {
    return 0;
  } finally {
    audioContext.close().catch(() => {});
  }
};

const landScoreResult = async (job, generation) => {
  const response = await fetch(job.asset.url);
  if (!response.ok) throw new Error(`Score download failed (${response.status}).`);
  const blob = await response.blob();
  const cueSheet = job.cueSheet || generation.cueSheet || null;
  const musicDelaySec = await scoreBeatDelaySec(blob, cueSheet);
  const audioDurationSec = (generation.durationMs || 0) / 1000;
  const imported = updateProject({
    type: 'asset/import',
    asset: {
      name: 'Background score',
      kind: 'audio',
      mimeType: job.asset.mimeType || blob.type || 'audio/mpeg',
      size: blob.size,
      duration: audioDurationSec,
      sceneId: null,
      url: URL.createObjectURL(blob),
      source: {type: 'generated-score', ...(job.source || {})},
      metadata: {cueSheet, beatDelaySec: musicDelaySec},
    },
  });
  try {
    await projectDatabase.putAsset(imported.affectedId, blob);
  } catch {
    showToast('Score generated for this session, but could not be saved for refresh.');
  }
  let audioTrack = project.timeline.tracks.find((track) => track.kind === 'audio');
  if (!audioTrack) {
    const added = updateProject({type: 'track/add', kind: 'audio'});
    audioTrack = project.timeline.tracks.find((track) => track.id === added.affectedId);
  }
  // The timeline is scene-local, so one continuous score becomes one clip per
  // act, windowed into the same audio file via sourceStart.
  const offsets = actOffsets(project);
  const scenes = orderedScenes(project).map((scene) => ({
    sceneId: scene.id,
    offsetSec: offsets.get(scene.id) || 0,
    lengthSec: project.timeline.clips
      .filter((clip) => clip.sceneId === scene.id)
      .reduce((maximum, clip) => Math.max(maximum, clip.start + clip.duration), 0),
  }));
  scoreClipPlacements({scenes, audioDurationSec, musicDelaySec}).forEach((placement) => {
    updateProject({
      type: 'clip/add',
      assetId: imported.affectedId,
      trackId: audioTrack.id,
      sceneId: placement.sceneId,
      start: placement.start,
      duration: placement.duration,
      sourceStart: placement.sourceStart,
    });
  });
};

const pendingAddGeneration = () => {
  const job = timelineAddGeneration.snapshot();
  return ['queued', 'running', 'retrying'].includes(job.status) && job.input ? job.input : null;
};

const pendingGenerationForView = () => {
  const input = pendingAddGeneration();
  if (!input) return null;
  return viewClip({
    ...input,
    sceneId: input.sceneId || project.timeline.activeSceneId,
    duration: input.duration || 5,
  });
};

const modelOptionLabel = (model) => {
  const tags = model.tags.length ? ` · ${model.tags.slice(0, 3).join(', ')}` : '';
  const price = model.unitPrice !== null ? ` — $${model.unitPrice}/${model.unit || 'run'}` : '';
  return `${model.name} · ${model.category}${tags}${price}`;
};

const generateCostLine = (model, duration) => {
  if (model.unitPrice === null) return `${model.category} · pricing unavailable`;
  const base = `$${model.unitPrice} per ${model.unit || 'run'}`;
  if (model.unit === 'seconds' && duration) return `${base} · ${duration}s`;
  return base;
};

const generateTotalCost = (model, duration) => {
  if (model.unitPrice === null) return '—';
  if (model.unit === 'seconds') return duration ? `≈ $${(model.unitPrice * duration).toFixed(2)}` : 'Select a duration';
  return `≈ $${model.unitPrice.toFixed(2)}`;
};

const openGenerateVideoModal = async ({trackId = null, start = 0, mode = 'add', clipId = null}) => {
  const sourceClip = mode === 'regenerate' ? clipById(clipId) : null;
  if (mode === 'regenerate' && !sourceClip?.provenance?.prompt) { showToast('Only generated clips can be regenerated.'); return; }
  const provenance = sourceClip?.provenance || null;
  const placement = sourceClip
    ? {sceneId: sourceClip.sceneId, start: sourceClip.start}
    : placementForViewStart(start);
  state.generateVideoModal = {
    mode,
    clipId,
    trackId: sourceClip?.trackId || trackId,
    start: placement.start,
    sceneId: placement.sceneId,
    prompt: provenance?.prompt || '',
    modelId: null,
    models: [],
    categoryFilter: null,
    duration: provenance?.params?.duration ? Number(provenance.params.duration) || null : null,
    status: 'loading-models',
    error: null,
  };
  renderApp();
  try {
    const models = await loadModelCatalog();
    const modal = state.generateVideoModal;
    if (!modal) return;
    modal.models = models;
    if (provenance?.modelId) {
      if (!models.some((entry) => entry.id === provenance.modelId)) {
        modal.models = [{id: provenance.modelId, name: provenance.modelId, category: 'video (uncataloged)', tags: [], unitPrice: null, unit: null}, ...models];
      }
      modal.modelId = provenance.modelId;
    } else {
      modal.modelId = (models.find((entry) => entry.category === 'text-to-video') || models[0])?.id || null;
    }
    modal.status = 'idle';
    renderApp();
  } catch (error) {
    modelCatalogPromise = null;
    const modal = state.generateVideoModal;
    if (!modal) return;
    modal.status = 'idle';
    modal.error = error instanceof Error ? error.message : String(error);
    renderApp();
  }
};

const closeGenerateVideoModal = () => {
  state.generateVideoModal = null;
  renderApp();
};

const regenerateClipFromMenu = async (clipId) => {
  try {
    const {jobId} = await clipRegeneration.rerollSeed(clipId);
    autoApplyRegenerationJobIds.add(jobId);
    showToast('Regenerating clip…');
    renderApp();
    scheduleRegenerationPoll();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const submitGenerateVideoForm = async (event) => {
  event.preventDefault();
  const modal = state.generateVideoModal;
  if (!modal || modal.status === 'submitting' || modal.status === 'generating') return;
  const prompt = app.querySelector('#generateVideoPrompt')?.value.trim() || '';
  if (!prompt || !modal.modelId) { showToast('A prompt and a model are required.'); return; }
  const model = modalModel(modal);
  modal.prompt = prompt;
  modal.status = 'submitting';
  modal.error = null;
  renderApp();
  if (modal.mode === 'regenerate') {
    try {
      const sourceClip = clipById(modal.clipId);
      if (!sourceClip) throw new Error('The clip to regenerate no longer exists.');
      const mention = await buildMentionPayload({prompt, modelId: modal.modelId});
      const {jobId} = await clipRegeneration.regenerateClip({
        clipId: modal.clipId,
        prompt: mention.prompt,
        referenceImageUrls: mention.referenceImageUrls,
        modelId: modal.modelId,
        ...(modal.duration ? {params: {...(sourceClip.provenance?.params || {}), duration: String(modal.duration)}} : {}),
      });
      autoApplyRegenerationJobIds.add(jobId);
      state.generateVideoModal = null;
      showToast('Regenerating clip…');
      renderApp();
      scheduleRegenerationPoll();
    } catch (error) {
      const openModal = state.generateVideoModal;
      const message = error instanceof Error ? error.message : String(error);
      if (openModal) { openModal.status = 'idle'; openModal.error = message; } else showToast(message);
      renderApp();
    }
    return;
  }
  try {
    const mention = await buildMentionPayload({prompt, modelId: modal.modelId});
    const job = await timelineAddGeneration.submit({
      operation: 'add',
      prompt: mention.prompt,
      referenceImageUrls: mention.referenceImageUrls,
      characterVersionIds: mention.characterVersionIds,
      modelId: modal.modelId,
      trackId: modal.trackId,
      start: modal.start,
      sceneId: modal.sceneId || activeScene()?.id || null,
      ...(modal.duration ? {duration: modal.duration, params: {duration: String(modal.duration)}} : {}),
      ...(model?.unitPrice !== null && model ? {
        unitPrice: model.unitPrice,
        costUnit: model.unit || 'units',
        costQuantity: model.unit === 'seconds' ? modal.duration || 5 : 1,
      } : {}),
    });
    if (job.status === 'failed') throw new Error(job.error || 'Timeline generation failed.');
    state.generateVideoModal = null;
    showToast('Generating video… a ghost clip marks the spot.');
    renderApp();
    scheduleGenerateVideoPoll();
  } catch (error) {
    const openModal = state.generateVideoModal;
    const message = error instanceof Error ? error.message : String(error);
    if (openModal) { openModal.status = 'idle'; openModal.error = message; } else showToast(message);
    renderApp();
  }
};

const scheduleGenerateVideoPoll = () => {
  clearTimeout(generateVideoPollTimer);
  generateVideoPollTimer = setTimeout(pollGenerateVideoJob, 700);
};

const pollGenerateVideoJob = async () => {
  const job = await timelineAddGeneration.poll();
  if (job.status === 'completed') {
    showToast('Generated clip added to the timeline and media bin.');
    renderApp();
  } else if (job.status === 'failed') {
    showToast(job.error || 'Timeline generation failed.');
    renderApp();
  } else {
    scheduleGenerateVideoPoll();
  }
};

const attachCharacterToSelectedClip = () => {
  const versionId = app.querySelector('#clipCharacterVersion')?.value;
  if (!state.selectedClipId || !versionId) return;
  try {
    timelineCharacterAttachments.attach(state.selectedClipId, versionId);
    renderApp();
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error));
  }
};

const removeCharacterFromSelectedClip = (versionId) => {
  if (!state.selectedClipId) return;
  timelineCharacterAttachments.remove(state.selectedClipId, versionId);
  renderApp();
};

const playbackClips = () => {
  const previewDiff = state.previewDiffId ? diffById(state.previewDiffId) : null;
  const clips = previewDiff ? derivePreviewClips(state.clips, previewDiff) : state.clips;
  return visibleClips(project, state.activeActId, clips);
};

const playbackDuration = () => {
  const clips = playbackClips();
  const clipEnd = clips.reduce((maximum, clip) => Math.max(maximum, clip.start + clip.duration), 0);
  if (state.activeActId === 'all' && project.scenes.length > 1) return clipEnd;
  const baseDuration = state.activeActId === 'all'
    ? state.timelineDuration
    : activeScene()?.duration || state.timelineDuration;
  return clipEnd > baseDuration ? clipEnd + 2 : baseDuration;
};

const playbackAt = (time) => resolveTimelinePlaybackAt({
  time,
  clips: playbackClips(),
  tracks: state.tracks,
  mediaAssets: state.media,
});

const playbackSignature = ({visual, audio}) => {
  const visualPart = visual?.media.url ? `${visual.clip.id}:${visual.media.id}` : '';
  const audioPart = audio
    .filter(({media}) => Boolean(media.url))
    .map(({clip, media}) => `${clip.id}:${media.id}`)
    .join(',');
  const active = activeTransitionAt(state.currentTime);
  const transitionPart = active ? `${active.transition.id}:${active.mode}` : '';
  return `${visualPart}|${audioPart}|${transitionPart}`;
};

// Finds the transition whose window covers a timeline time. Windows sit on the
// outgoing clip's tail (or the incoming clip's head for fade-from-black), so
// the blend happens while the main layer still shows the outgoing clip.
const activeTransitionAt = (time) => {
  const clips = playbackClips();
  for (const transition of state.transitions) {
    const edge = transitionEdgeTime(transition, clips);
    if (!Number.isFinite(edge)) continue;
    const duration = transition.duration;
    if (transition.fromClipId && transition.toClipId && getTransitionDefinition(transition.type, state.customTransitions)?.mode === 'dip') {
      if (time >= edge - duration / 2 && time < edge + duration / 2) {
        return {transition, progress: (time - (edge - duration / 2)) / duration, incomingClip: null, mode: 'dip'};
      }
    } else if (transition.fromClipId && transition.toClipId) {
      if (time >= edge - duration && time < edge) {
        return {transition, progress: (time - (edge - duration)) / duration, incomingClip: clips.find((clip) => clip.id === transition.toClipId) || null, mode: 'blend'};
      }
    } else if (transition.fromClipId) {
      if (time >= edge - duration && time < edge) {
        return {transition, progress: (time - (edge - duration)) / duration, incomingClip: null, mode: 'to-black'};
      }
    } else if (time >= edge && time < edge + duration) {
      return {transition, progress: (time - edge) / duration, incomingClip: null, mode: 'from-black'};
    }
  }
  return null;
};

// Style-only writes each frame: layer-B effect for blends, black overlay for fades.
const applyTransitionFrame = () => {
  const fade = app.querySelector('#previewFade');
  const videoB = app.querySelector('#previewVideoB');
  const imageB = app.querySelector('#previewImageB');
  if (!fade || !videoB || !imageB) return;
  const active = activeTransitionAt(state.currentTime);
  const resetLayer = (element) => { element.style.opacity = ''; element.style.clipPath = ''; element.style.transform = ''; element.style.filter = ''; };
  if (!active || active.mode !== 'blend') [videoB, imageB].forEach(resetLayer);
  if (!active) {
    fade.style.opacity = '0';
    return;
  }
  const {mode, progress, transition} = active;
  const definition = getTransitionDefinition(transition.type, state.customTransitions);
  if (mode === 'blend') {
    fade.style.opacity = '0';
    const layer = videoB.classList.contains('visible') ? videoB : imageB.classList.contains('visible') ? imageB : null;
    if (!layer || !definition) return;
    resetLayer(layer);
    applyTransitionStyles(definition, progress, {layer, fade});
  } else if (mode === 'dip') {
    if (!definition) return;
    applyTransitionStyles(definition, progress, {layer: null, fade});
  } else if (mode === 'to-black') {
    fade.style.opacity = String(progress);
  } else {
    fade.style.opacity = String(1 - progress);
  }
};

const sourceTimeAtPlayhead = (clip) => (clip.sourceStart || 0) + Math.max(0, state.currentTime - clip.start);

const seekMediaElement = (element, getTime) => {
  const applyTime = () => {
    try {
      element.currentTime = getTime();
    } catch {
      // Metadata may not be available on the first assignment.
    }
  };
  applyTime();
  if (element.readyState === 0) element.addEventListener('loadedmetadata', applyTime, {once: true});
};

const syncPreview = (forceSeek = false) => {
  const video = app.querySelector('#previewVideo');
  const image = app.querySelector('#previewImage');
  const audioPreview = app.querySelector('#audioPreview');
  const audioMix = app.querySelector('#previewAudioMix');
  if (!video || !image || !audioPreview || !audioMix) return;

  const playback = playbackAt(state.currentTime);
  const visual = playback.visual?.media.url ? playback.visual : null;
  const activeAudio = playback.audio.filter(({media}) => Boolean(media.url));
  const shouldShow = (element, show) => element.classList.toggle('visible', Boolean(show));

  shouldShow(video, visual?.media.kind === 'video');
  shouldShow(image, visual?.media.kind === 'image');
  shouldShow(audioPreview, !visual && activeAudio.length > 0);

  video.volume = state.playerVolume;
  if (visual?.media.kind === 'video') {
    video.muted = Boolean(visual.clip.audioDetached);
    const sourceChanged = video.dataset.clipId !== visual.clip.id || video.dataset.mediaId !== visual.media.id;
    if (sourceChanged) {
      video.pause();
      video.src = visual.media.url;
      video.dataset.clipId = visual.clip.id;
      video.dataset.mediaId = visual.media.id;
    }
    if (sourceChanged || forceSeek) seekMediaElement(video, () => sourceTimeAtPlayhead(visual.clip));
    if (state.isPlaying) video.play().catch(() => {});
    else video.pause();
  } else {
    video.pause();
    delete video.dataset.clipId;
    delete video.dataset.mediaId;
  }

  if (visual?.media.kind === 'image') {
    if (image.dataset.clipId !== visual.clip.id || image.dataset.mediaId !== visual.media.id) {
      image.src = visual.media.url;
      image.dataset.clipId = visual.clip.id;
      image.dataset.mediaId = visual.media.id;
    }
  } else {
    image.removeAttribute('src');
    delete image.dataset.clipId;
    delete image.dataset.mediaId;
  }

  const existingAudio = new Map([...audioMix.querySelectorAll('audio[data-clip-id]')]
    .map((element) => [element.dataset.clipId, element]));
  activeAudio.forEach(({clip, media}) => {
    let element = existingAudio.get(clip.id);
    const sourceChanged = !element || element.dataset.mediaId !== media.id;
    if (!element) {
      element = document.createElement('audio');
      element.preload = 'auto';
      element.dataset.clipId = clip.id;
      audioMix.append(element);
    }
    existingAudio.delete(clip.id);
    element.volume = state.playerVolume;
    if (sourceChanged) {
      element.pause();
      element.src = media.url;
      element.dataset.mediaId = media.id;
    }
    if (sourceChanged || forceSeek) {
      seekMediaElement(element, () => sourceTimeAtPlayhead(clip));
    }
    if (state.isPlaying) element.play().catch(() => {});
    else element.pause();
  });
  existingAudio.forEach((element) => {
    element.pause();
    element.remove();
  });

  // Incoming layer for clip-to-clip blends: a held first frame of the next clip.
  const blend = activeTransitionAt(state.currentTime);
  const incomingClip = blend?.mode === 'blend' ? blend.incomingClip : null;
  const incomingMedia = incomingClip ? state.media.find((item) => item.id === incomingClip.assetId) : null;
  const videoB = app.querySelector('#previewVideoB');
  const imageB = app.querySelector('#previewImageB');
  if (videoB && imageB) {
    const showVideoB = Boolean(incomingMedia?.url && incomingMedia.kind === 'video');
    const showImageB = Boolean(incomingMedia?.url && incomingMedia.kind === 'image');
    shouldShow(videoB, showVideoB);
    shouldShow(imageB, showImageB);
    if (showVideoB) {
      const sourceChanged = videoB.dataset.clipId !== incomingClip.id || videoB.dataset.mediaId !== incomingMedia.id;
      if (sourceChanged) {
        videoB.pause();
        videoB.src = incomingMedia.url;
        videoB.dataset.clipId = incomingClip.id;
        videoB.dataset.mediaId = incomingMedia.id;
      }
      if (sourceChanged || forceSeek) seekMediaElement(videoB, () => incomingClip.sourceStart || 0);
    } else {
      videoB.pause();
      delete videoB.dataset.clipId;
      delete videoB.dataset.mediaId;
    }
    if (showImageB) {
      if (imageB.dataset.mediaId !== incomingMedia.id) {
        imageB.src = incomingMedia.url;
        imageB.dataset.mediaId = incomingMedia.id;
      }
    } else {
      delete imageB.dataset.mediaId;
    }
  }
  applyTransitionFrame();

  state.previewPlaybackSignature = playbackSignature(playback);
};

const updatePlaybackFrame = () => {
  if (!state.isPlaying) return;
  const duration = playbackDuration();
  const elapsed = (performance.now() - state.playbackStartedAt) / 1000;
  state.currentTime = Math.min(duration, state.playbackOrigin + elapsed);
  const playhead = app.querySelector('#playhead');
  if (playhead) playhead.style.left = `${state.currentTime * scale()}px`;
  const current = app.querySelector('#playerCurrent');
  if (current) current.textContent = formatTime(state.currentTime);
  const playback = playbackAt(state.currentTime);
  if (playbackSignature(playback) !== state.previewPlaybackSignature) syncPreview(true);
  else applyTransitionFrame();
  if (state.currentTime >= duration) {
    state.isPlaying = false;
    state.currentTime = 0;
    state.previewPlaybackSignature = null;
    renderApp();
    return;
  }
  state.rafId = requestAnimationFrame(updatePlaybackFrame);
};

const applyPlayerVolume = () => {
  app.querySelectorAll('#previewVideo, #previewAudioMix audio').forEach((element) => {
    element.volume = state.playerVolume;
  });
};

const togglePlayerMute = () => {
  if (state.playerVolume === 0) {
    state.playerVolume = state.lastAudibleVolume || 1;
  } else {
    state.lastAudibleVolume = state.playerVolume;
    state.playerVolume = 0;
  }
  applyPlayerVolume();
  renderApp();
};

const togglePreviewFullscreen = () => {
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  } else {
    app.querySelector('.preview-wrap')?.requestFullscreen?.().catch(() => {});
  }
};

const togglePlay = () => {
  if (state.isPlaying) {
    state.isPlaying = false;
    cancelAnimationFrame(state.rafId);
    renderApp();
  } else {
    if (state.currentTime >= playbackDuration()) state.currentTime = 0;
    state.isPlaying = true;
    state.playbackOrigin = state.currentTime;
    state.playbackStartedAt = performance.now();
    renderApp();
    state.rafId = requestAnimationFrame(updatePlaybackFrame);
  }
};

const seekTo = (time) => {
  state.currentTime = Math.max(0, Math.min(playbackDuration(), time));
  if (state.isPlaying) {
    state.playbackOrigin = state.currentTime;
    state.playbackStartedAt = performance.now();
  }
  refreshPlayheadView();
};

const refreshPlayheadView = () => {
  const playhead = app.querySelector('#playhead');
  if (playhead) playhead.style.left = `${state.currentTime * scale()}px`;
  const current = app.querySelector('#playerCurrent');
  if (current) current.textContent = formatTime(state.currentTime);
  syncPreview(true);
};

let falStatusRequest = null;

const checkFalStatus = async () => {
  const status = app.querySelector('#falStatus');
  const indicator = app.querySelector('#falIndicator');
  const connection = app.querySelector('#falConnection');
  if (!status || !indicator || !connection) return;
  try {
    // Fetch once per page load and reuse; renders happen on every
    // interaction and must not each issue a status request.
    falStatusRequest ||= fetch('/api/fal/status').then((response) => response.json());
    const data = await falStatusRequest;
    status.textContent = data.configured ? 'Ready' : 'Key missing';
    connection.title = data.configured ? 'FAL adapter ready for models' : 'Add FAL_API_KEY to .env to enable calls';
    indicator.classList.toggle('ready', Boolean(data.configured));
  } catch {
    falStatusRequest = null;
    status.textContent = 'Offline';
    connection.title = 'Local FAL adapter is offline';
    indicator.classList.remove('ready');
  }
};

const showToast = (message) => {
  const existing = document.querySelector('.toast');
  existing?.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => { toast.classList.remove('visible'); setTimeout(() => toast.remove(), 220); }, 2600);
};

const closeContextMenu = () => document.querySelector('.context-menu')?.remove();

const showContextMenu = (event, items) => {
  event.preventDefault();
  event.stopPropagation();
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  items.forEach((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    if (item.danger) button.classList.add('danger');
    button.textContent = item.label;
    button.addEventListener('click', () => { closeContextMenu(); item.onSelect(); });
    menu.append(button);
  });
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
};

document.addEventListener('pointerdown', (event) => { if (!(event.target instanceof Element && event.target.closest('.context-menu'))) closeContextMenu(); });
document.addEventListener('scroll', closeContextMenu, {capture: true, passive: true});
window.addEventListener('resize', closeContextMenu);
window.addEventListener('blur', closeContextMenu);

fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });
const isKeyboardEditingTarget = (target) => target instanceof Element && Boolean(target.closest(
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeContextMenu();
  if (
    (event.key === 'Backspace' || event.key === 'Delete')
    && !event.defaultPrevented
    && !event.isComposing
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
    && !isKeyboardEditingTarget(event.target)
    && (deleteSelectedTransition() || deleteSelectedClip())
  ) {
    event.preventDefault();
    return;
  }
  if (event.code === 'Space' && !['INPUT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName)) { event.preventDefault(); togglePlay(); }
});

// Clear every piece of state that belongs to one project so a freshly opened
// project starts from a clean slate (selection, playback, sessions, hydration).
const resetPerProjectState = () => {
  storyboardWorking = null;
  actWorkspaceSession = null;
  state.activeActId = 'all';
  state.selectedClipId = null;
  state.selectedClipIds = new Set();
  state.selectedTransitionId = null;
  state.selectedGhostKey = null;
  state.previewDiffId = null;
  state.regenerationEditorClipId = null;
  state.currentTime = 0;
  state.isPlaying = false;
  state.selectedNarrativeStyleId = null;
  state.editorSessionInitialized = false;
  state.videoIndexingByAsset.clear();
  state.mediaHydrated = false;
  state.previewPlaybackSignature = null;
  state.promptMentionMap = {};
  state.selectedCharacterId = null;
  state.isCharacterModalOpen = false;
  state.selectedStyleId = null;
  state.isStyleModalOpen = false;
  state.beatVideoModal = null;
};

const hydrateProjectMedia = async () => {
  await Promise.all(project.mediaAssets.map(async (asset) => {
    const blob = await projectDatabase.getAsset(asset.id);
    if (!blob) return;
    projectStore.registerAssetUrl(asset.id, URL.createObjectURL(blob));
  }));
  project = projectStore.getProject();
  state.mediaHydrated = true;
  styleApplicationController.resume();
  renderApp();
  if ((project.styleApplications?.batches || []).some((batch) => batch.jobs.some((job) => ['queued', 'uploading', 'trimming', 'generating'].includes(job.status)))) {
    scheduleStyleApplicationPoll();
  }
  void videoIndexer.resume({assets: project.mediaAssets}).catch((error) => {
    showToast(`Video indexing could not resume: ${error instanceof Error ? error.message : String(error)}`);
  });
  void audioIndexer.resume({
    assets: project.mediaAssets,
    getBlob: (asset) => projectDatabase.getAsset(asset.id).catch(() => null),
  }).catch((error) => {
    showToast(`Audio transcription could not resume: ${error instanceof Error ? error.message : String(error)}`);
  });
};

const activateProject = async (persistedProject) => {
  projectStore = createProjectStore({
    storage: null,
    initialProject: persistedProject,
    onCommit: (savedProject) => projectDatabase.saveProject(savedProject),
  });
  project = projectStore.getProject();
  projectOpen = true;
  resetPerProjectState();
  // Rebuild the DOM from scratch: view modules capture their data objects in
  // event-handler closures at build time, so adopting the new project's
  // objects into an existing DOM would leave stale closures behind.
  app.innerHTML = '';
  try {
    globalThis.localStorage?.setItem('prismflow.activeProjectId', project.project.id);
  } catch {}
  await hydrateProjectMedia();
};

const refreshProjectSummaries = async () => {
  try {
    state.projectSummaries = sortSummaries((await projectDatabase.listProjects()).map(summarizeProject));
  } catch {}
};

const openProjectById = async (projectId) => {
  let persisted = null;
  try {
    persisted = await projectDatabase.loadProject(projectId);
  } catch {}
  if (!persisted) {
    showToast('That project could not be opened.');
    return;
  }
  await activateProject(persisted);
  setView(project.storyboard ? 'storyboard' : 'picker');
};

const createNewProject = async () => {
  // A brand-new store with no stored payload yields the pristine default
  // project: empty storyboard, timeline, characters, and beats.
  const fresh = createProjectStore({storage: null}).getProject();
  try {
    await projectDatabase.saveProject(fresh);
  } catch {}
  await activateProject(fresh);
  setView('picker');
};

const deleteProjectById = async (projectId) => {
  const summary = state.projectSummaries.find((entry) => entry.id === projectId);
  const confirmed = globalThis.confirm?.(`Delete "${summary?.name || 'this project'}" and all of its media? This cannot be undone.`);
  if (confirmed === false) return;
  try {
    await projectDatabase.deleteProject(projectId);
  } catch {
    showToast('That project could not be deleted.');
    return;
  }
  state.projectSummaries = state.projectSummaries.filter((entry) => entry.id !== projectId);
  renderApp();
};

const returnToProjectsHub = async () => {
  await refreshProjectSummaries();
  setView('projects');
};

const restoreSession = async () => {
  const legacyProject = hadLegacyProject ? project : null;
  try {
    await projectDatabase.requestPersistence();
    if (legacyProject) {
      // IndexedDB is the source of truth from here on; drop the legacy
      // localStorage copy once the project is confirmed saved.
      await projectDatabase.saveProject(legacyProject);
      globalThis.localStorage?.removeItem('prismflow.project');
    }
    state.projectSummaries = sortSummaries((await projectDatabase.listProjects()).map(summarizeProject));
  } catch {
    // IndexedDB unavailable: surface the legacy project (if any) in memory.
    if (legacyProject) state.projectSummaries = [summarizeProject(legacyProject)];
  }

  if (['picker', 'storyboard', 'editor'].includes(state.view)) {
    // Deep links skip the hub, so resolve which project they mean: the last
    // one opened, else the most recently updated.
    const activeId = (() => {
      try {
        return globalThis.localStorage?.getItem('prismflow.activeProjectId') || null;
      } catch {
        return null;
      }
    })();
    const targetId = state.projectSummaries.find((entry) => entry.id === activeId)?.id
      || state.projectSummaries[0]?.id
      || null;
    let persisted = null;
    if (targetId) {
      try {
        persisted = await projectDatabase.loadProject(targetId);
      } catch {}
    }
    if (!persisted && legacyProject) persisted = legacyProject;
    if (!persisted) {
      // Deep link into an empty install: spin up a fresh project so the
      // requested view has something real to operate on.
      persisted = createProjectStore({storage: null}).getProject();
      try {
        await projectDatabase.saveProject(persisted);
      } catch {}
      state.projectSummaries = sortSummaries([...state.projectSummaries, summarizeProject(persisted)]);
    }
    await activateProject(persisted);
  } else {
    state.mediaHydrated = true;
  }
  renderApp();

  if (new URLSearchParams(globalThis.location.search).get('syncModelPricing') === '1') {
    try {
      const {result} = await import('/scripts/sync-model-pricing.mjs');
      showToast(`Stored ${result.modelCount} FAL models and ${result.priceCount} prices.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  }
  if (new URLSearchParams(globalThis.location.search).get('importModelPricing') === '1') {
    try {
      const {result} = await import('/scripts/import-model-pricing.mjs');
      showToast(`Imported ${result.storedCount} model pricing records.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    }
  }
};

// Clicking the brand prism anywhere in the app returns to the projects hub.
document.addEventListener('click', (event) => {
  const lockup = event.target.closest?.('.brand-lockup');
  if (!lockup || state.view === 'projects' || state.view === 'splash') return;
  // Controls nested inside the lockup (e.g. the storyboard back button) keep
  // their own behavior; only the mark and name navigate to the hub.
  if (event.target.closest('button, a, input, textarea, select')) return;
  void returnToProjectsHub();
});

renderApp();
const sessionReady = restoreSession().catch(() => {
  state.mediaHydrated = true;
  renderApp();
});
if (state.view === 'splash') {
  const minimumSplashTime = new Promise((resolve) => setTimeout(resolve, 2200));
  void Promise.all([sessionReady, minimumSplashTime]).then(() => {
    if (state.view !== 'splash') return;
    // The splash overlay stays put: the hub renders beneath it while the
    // prism glides up and settles onto the hub's header anchor.
    state.view = 'projects';
    renderApp();
    dockSplash(app.querySelector('.hub-prism-anchor'));
  });
}
