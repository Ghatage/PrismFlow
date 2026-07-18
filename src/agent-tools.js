import {describeClip} from './project-context.js';
import {TRANSITION_TYPES, transitionEdgeTime} from './project-store.js';
import {getTransitionDefinition} from './transitions.js';

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;

const tool = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {type: 'object', properties, required, additionalProperties: false},
  },
});

const clipSummary = (project, clip) => ({
  clipId: clip.id,
  trackId: clip.trackId,
  assetId: clip.assetId,
  assetName: project.mediaAssets.find((asset) => asset.id === clip.assetId)?.name || null,
  start: round(clip.start),
  end: round(clip.start + clip.duration),
  duration: round(clip.duration),
  sourceStart: round(clip.sourceStart),
  description: describeClip(project, clip).description,
});

export const createAgentTools = ({
  getProject,
  dispatch,
  getState,
  setState,
  projectContext,
  videoIndexer,
  database,
}) => {
  const requireClip = (clipId) => {
    const clip = getProject().timeline.clips.find((candidate) => candidate.id === clipId);
    if (!clip) throw new Error(`No timeline clip with id ${clipId}. Call list_timeline_clips for valid ids.`);
    return clip;
  };

  const writeResult = (result, reason) => result?.changed
    ? {ok: true, affectedId: result.affectedId || null}
    : {ok: false, reason};

  const definitions = [
    tool('get_project_overview', 'Get a compact overview of the project: timeline duration, playhead, tracks, clip and asset counts, scenes.'),
    tool('list_timeline_clips', 'List all clips on the timeline sorted by start time, with ids, timing, and a short description.', {
      trackId: {type: 'string', description: 'Optional track id (e.g. "V1") to filter by.'},
    }),
    tool('get_clip', 'Get full details for one clip: timing, source asset metadata, provenance (prompt/model), indexing status.', {
      clipId: {type: 'string'},
    }, ['clipId']),
    tool('get_clip_transcription', 'Get the 5-second-interval visual frame annotations ("transcription") covering a clip, with source and timeline timestamps.', {
      clipId: {type: 'string'},
    }, ['clipId']),
    tool('list_media_assets', 'List all media assets in the bin with id, name, kind, duration, and indexing status.'),
    tool('search_project', 'Keyword-search project context (clips, scenes, characters, styles).', {
      query: {type: 'string'},
      type: {type: 'string', enum: ['clip', 'scene', 'character', 'style']},
      limit: {type: 'number'},
    }, ['query']),
    tool('search_video_frames', 'Semantic search over indexed video frame annotations across the project. Returns frames with asset id and source time.', {
      query: {type: 'string'},
      limit: {type: 'number'},
    }, ['query']),
    tool('move_clip', 'Move a clip to a new timeline start time (seconds), optionally to another track of the same kind.', {
      clipId: {type: 'string'},
      start: {type: 'number', description: 'New timeline start in seconds.'},
      trackId: {type: 'string'},
    }, ['clipId', 'start']),
    tool('trim_clip', 'Trim one edge of a clip. time is the new timeline position (seconds) of that edge. Left trims advance into the source; right trims shorten the tail.', {
      clipId: {type: 'string'},
      edge: {type: 'string', enum: ['left', 'right']},
      time: {type: 'number', description: 'New timeline position of the chosen edge, in seconds.'},
    }, ['clipId', 'edge', 'time']),
    tool('split_clip', 'Split a clip in two at a timeline time (seconds). The time must be at least 0.1s inside both ends.', {
      clipId: {type: 'string'},
      time: {type: 'number'},
    }, ['clipId', 'time']),
    tool('remove_clip', 'Remove a clip from the timeline.', {
      clipId: {type: 'string'},
    }, ['clipId']),
    tool('add_clip', 'Add a media asset to the timeline as a new clip.', {
      assetId: {type: 'string'},
      trackId: {type: 'string'},
      start: {type: 'number'},
      duration: {type: 'number'},
      sourceStart: {type: 'number'},
    }, ['assetId', 'trackId', 'start']),
    tool('add_track', 'Add a new video or audio track to the timeline.', {
      kind: {type: 'string', enum: ['video', 'audio']},
    }, ['kind']),
    tool('list_transitions', 'List all transitions on the timeline with ids, type, attached clips, duration, and the clip-edge time they sit on.'),
    tool('add_transition', 'Add a transition at a clip edge. Give both fromClipId and toClipId for a clip-to-clip transition (the clips must be adjacent on the same video track), or only one of them for a fade to/from black at that clip\'s free edge. Replaces any existing transition at the same edge.', {
      type: {type: 'string', description: `Built-in transition key (${Object.keys(TRANSITION_TYPES).join(', ')}) or a custom transition key from the project's transition library.`},
      fromClipId: {type: 'string', description: 'Clip the transition leads out of (its end edge).'},
      toClipId: {type: 'string', description: 'Clip the transition leads into (its start edge).'},
      duration: {type: 'number', description: 'Transition length in seconds (clamped to half the shortest attached clip).'},
    }, ['type']),
    tool('remove_transition', 'Remove a transition from the timeline.', {
      transitionId: {type: 'string'},
    }, ['transitionId']),
    tool('select_clip', 'Select a clip in the editor UI so the user can see which clip is being worked on.', {
      clipId: {type: 'string'},
    }, ['clipId']),
    tool('seek_playhead', 'Move the playhead to a timeline time (seconds) so the preview shows that moment.', {
      time: {type: 'number'},
    }, ['time']),
  ];

  const executors = {
    get_project_overview() {
      const project = getProject();
      const state = getState();
      return {
        projectName: project.project.name,
        timelineDuration: round(project.timeline.duration),
        revision: project.timeline.revision,
        playhead: round(state.currentTime),
        selectedClipId: state.selectedClipId || null,
        tracks: project.timeline.tracks.map(({id, name, kind}) => ({id, name, kind})),
        clipCount: project.timeline.clips.length,
        sceneNames: project.scenes.map((scene) => scene.name),
        mediaAssetCount: project.mediaAssets.length,
      };
    },

    list_timeline_clips({trackId} = {}) {
      const project = getProject();
      return project.timeline.clips
        .filter((clip) => !trackId || clip.trackId === trackId)
        .sort((a, b) => a.start - b.start)
        .map((clip) => clipSummary(project, clip));
    },

    get_clip({clipId}) {
      const clip = requireClip(clipId);
      const project = getProject();
      const asset = project.mediaAssets.find((candidate) => candidate.id === clip.assetId) || null;
      return {
        ...clipSummary(project, clip),
        sceneId: clip.sceneId,
        asset: asset ? {
          assetId: asset.id,
          name: asset.name,
          kind: asset.kind,
          duration: round(asset.duration),
          indexStatus: asset.metadata?.videoIndex?.status || 'none',
        } : null,
        provenance: {
          prompt: clip.provenance?.prompt || null,
          modelId: clip.provenance?.modelId || null,
        },
      };
    },

    async get_clip_transcription({clipId}) {
      const clip = requireClip(clipId);
      const project = getProject();
      const asset = project.mediaAssets.find((candidate) => candidate.id === clip.assetId);
      const sourceStart = clip.sourceStart || 0;
      const sourceEnd = sourceStart + clip.duration;
      if (asset?.kind === 'audio') {
        const spoken = (asset.metadata?.transcription?.segments || [])
          .filter((segment) => segment.start >= sourceStart && segment.start < sourceEnd)
          .sort((a, b) => a.start - b.start)
          .map((segment) => ({
            sourceTime: round(segment.start),
            timelineTime: round(clip.start + (segment.start - sourceStart)),
            annotation: segment.text || '',
          }));
        const audioStatus = asset.metadata?.audioIndex?.status || 'none';
        return {
          clipId,
          segments: spoken,
          ...(audioStatus !== 'complete' ? {indexing: audioStatus === 'none' ? 'not-indexed' : 'incomplete'} : {}),
        };
      }
      const frames = await database.getVideoFrames(clip.assetId);
      const segments = (frames || [])
        .filter((frame) => frame.time >= sourceStart && frame.time < sourceEnd)
        .sort((a, b) => a.time - b.time)
        .map((frame) => ({
          sourceTime: round(frame.time),
          timelineTime: round(clip.start + (frame.time - sourceStart)),
          annotation: frame.annotation || '',
        }));
      const status = asset?.metadata?.videoIndex?.status || 'none';
      return {
        clipId,
        segments,
        ...(status !== 'complete' ? {indexing: status === 'none' ? 'not-indexed' : 'incomplete'} : {}),
      };
    },

    list_media_assets() {
      return getProject().mediaAssets.map((asset) => ({
        assetId: asset.id,
        name: asset.name,
        kind: asset.kind,
        duration: round(asset.duration),
        indexStatus: asset.metadata?.videoIndex?.status || 'none',
      }));
    },

    search_project({query, type, limit}) {
      return projectContext.search(query, {type: type || null, limit}).map((entry) => ({
        id: entry.id,
        type: entry.type,
        clipId: entry.clipId || null,
        start: entry.start !== undefined ? round(entry.start) : null,
        duration: entry.duration !== undefined ? round(entry.duration) : null,
        description: entry.description,
      }));
    },

    async search_video_frames({query, limit}) {
      const results = await videoIndexer.search(query, {limit: limit || 10});
      return results.map((result) => ({
        frameId: result.id,
        assetId: result.videoAssetId,
        videoName: result.videoName || null,
        sourceTime: round(result.time),
        annotation: result.annotation || '',
      }));
    },

    move_clip({clipId, start, trackId}) {
      requireClip(clipId);
      const command = {type: 'clip/move', clipId, start};
      if (trackId) command.trackId = trackId;
      return writeResult(dispatch(command), 'Move was rejected (check trackId kind matches the clip).');
    },

    trim_clip({clipId, edge, time}) {
      const clip = requireClip(clipId);
      if (edge !== 'left' && edge !== 'right') throw new Error('edge must be "left" or "right".');
      const command = edge === 'left'
        ? {type: 'clip/trim', clipId, edge, start: time}
        : {type: 'clip/trim', clipId, edge, duration: time - clip.start};
      return writeResult(dispatch(command), 'Trim was rejected (clips keep a 0.1s minimum duration).');
    },

    split_clip({clipId, time}) {
      requireClip(clipId);
      return writeResult(
        dispatch({type: 'clip/split', clipId, time}),
        'Split point must be at least 0.1s inside both clip ends.',
      );
    },

    remove_clip({clipId}) {
      requireClip(clipId);
      return writeResult(dispatch({type: 'clip/remove', clipId}), 'Clip was not removed.');
    },

    add_clip({assetId, trackId, start, duration, sourceStart}) {
      const project = getProject();
      if (!project.mediaAssets.some((asset) => asset.id === assetId)) {
        throw new Error(`No media asset with id ${assetId}. Call list_media_assets for valid ids.`);
      }
      const command = {type: 'clip/add', assetId, trackId, start};
      if (duration !== undefined) command.duration = duration;
      if (sourceStart !== undefined) command.sourceStart = sourceStart;
      return writeResult(dispatch(command), 'Clip was not added.');
    },

    add_track({kind}) {
      return writeResult(dispatch({type: 'track/add', kind}), 'kind must be "video" or "audio".');
    },

    list_transitions() {
      const project = getProject();
      return project.timeline.transitions.map((transition) => ({
        transitionId: transition.id,
        type: transition.type,
        trackId: transition.trackId,
        fromClipId: transition.fromClipId,
        toClipId: transition.toClipId,
        duration: round(transition.duration),
        edgeTime: round(transitionEdgeTime(transition, project.timeline.clips)),
      }));
    },

    add_transition({type, fromClipId, toClipId, duration} = {}) {
      const customTransitions = getProject().customTransitions || [];
      if (!getTransitionDefinition(type, customTransitions)) {
        const keys = [...Object.keys(TRANSITION_TYPES), ...customTransitions.map((definition) => definition.key)];
        throw new Error(`type must be one of: ${keys.join(', ')}.`);
      }
      if (!fromClipId && !toClipId) throw new Error('Provide fromClipId, toClipId, or both. Call list_timeline_clips for valid ids.');
      if (fromClipId) requireClip(fromClipId);
      if (toClipId) requireClip(toClipId);
      const command = {type: 'transition/add', transitionType: type, fromClipId, toClipId};
      if (duration !== undefined) command.duration = duration;
      return writeResult(dispatch(command), 'Transition was not added.');
    },

    remove_transition({transitionId}) {
      if (!getProject().timeline.transitions.some((transition) => transition.id === transitionId)) {
        throw new Error(`No transition with id ${transitionId}. Call list_transitions for valid ids.`);
      }
      return writeResult(dispatch({type: 'transition/remove', transitionId}), 'Transition was not removed.');
    },

    select_clip({clipId}) {
      requireClip(clipId);
      setState({selectedClipId: clipId});
      return {ok: true, selectedClipId: clipId};
    },

    seek_playhead({time}) {
      const project = getProject();
      const clamped = Math.min(Math.max(0, Number(time) || 0), project.timeline.duration);
      setState({currentTime: clamped});
      return {ok: true, playhead: round(clamped)};
    },
  };

  const execute = async (name, args = {}) => {
    const executor = executors[name];
    if (!executor) return {error: `Unknown tool: ${name}`};
    try {
      return await executor(args ?? {});
    } catch (error) {
      return {error: error instanceof Error ? error.message : String(error)};
    }
  };

  return {definitions, execute};
};
