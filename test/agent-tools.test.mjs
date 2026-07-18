import assert from 'node:assert/strict';
import test from 'node:test';

import {createAgentTools} from '../src/agent-tools.js';
import {createProjectStore} from '../src/project-store.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const setup = () => {
  let id = 0;
  const store = createProjectStore({
    storage: new MemoryStorage(),
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => '2026-07-17T16:00:00.000Z',
  });
  let project = store.getProject();
  const dispatch = (command) => {
    const result = store.dispatch(command);
    project = result.project;
    return result;
  };
  const state = {currentTime: 1.5, selectedClipId: null};
  const frames = new Map();
  const tools = createAgentTools({
    getProject: () => project,
    dispatch,
    getState: () => state,
    setState: (patch) => Object.assign(state, patch),
    projectContext: {search: (query, options) => [{id: 'clip:x', type: 'clip', clipId: 'x', start: 1, duration: 2, description: `hit for ${query} ${options?.type || ''}`.trim()}]},
    videoIndexer: {search: async (query) => [{id: 'frame-1', videoAssetId: 'asset-9', videoName: 'shot.mp4', time: 10, annotation: `frame about ${query}`}]},
    database: {getVideoFrames: async (assetId) => frames.get(assetId) || []},
  });

  const assetId = dispatch({type: 'asset/import', asset: {name: 'shot.mp4', kind: 'video', mimeType: 'video/mp4', duration: 30}}).affectedId;
  const clipId = dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 2, duration: 10, sourceStart: 5}).affectedId;
  return {tools, dispatch, getProject: () => project, state, frames, assetId, clipId};
};

test('every executor has a definition and every definition an executor', async () => {
  const {tools} = setup();
  const names = tools.definitions.map((definition) => definition.function.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) {
    const result = await tools.execute(name, {});
    assert.notEqual(result?.error, `Unknown tool: ${name}`);
  }
  const unknown = await tools.execute('does_not_exist', {});
  assert.match(unknown.error, /Unknown tool/);
});

test('read tools return compact project data', async () => {
  const {tools, clipId, assetId, frames} = setup();

  const overview = await tools.execute('get_project_overview', {});
  assert.equal(overview.clipCount, 1);
  assert.equal(overview.playhead, 1.5);
  assert.ok(overview.tracks.some((track) => track.id === 'V1'));

  const clips = await tools.execute('list_timeline_clips', {});
  assert.equal(clips.length, 1);
  assert.equal(clips[0].clipId, clipId);
  assert.equal(clips[0].start, 2);
  assert.equal(clips[0].end, 12);

  const clip = await tools.execute('get_clip', {clipId});
  assert.equal(clip.asset.assetId, assetId);
  assert.equal(clip.asset.indexStatus, 'none');

  frames.set(assetId, [
    {time: 0, annotation: 'before in-point'},
    {time: 5, annotation: 'first covered frame'},
    {time: 10, annotation: 'middle frame'},
    {time: 20, annotation: 'past out-point'},
  ]);
  const transcription = await tools.execute('get_clip_transcription', {clipId});
  assert.equal(transcription.segments.length, 2);
  assert.deepEqual(transcription.segments[0], {sourceTime: 5, timelineTime: 2, annotation: 'first covered frame'});
  assert.deepEqual(transcription.segments[1], {sourceTime: 10, timelineTime: 7, annotation: 'middle frame'});
  assert.equal(transcription.indexing, 'not-indexed');

  const assets = await tools.execute('list_media_assets', {});
  assert.equal(assets[0].duration, 30);

  const found = await tools.execute('search_project', {query: 'fox', type: 'clip'});
  assert.equal(found[0].description, 'hit for fox clip');

  const framesFound = await tools.execute('search_video_frames', {query: 'puddle'});
  assert.equal(framesFound[0].frameId, 'frame-1');
  assert.equal(framesFound[0].sourceTime, 10);
});

test('write tools mutate the timeline and report ok/affectedId', async () => {
  const {tools, getProject, clipId, assetId, state} = setup();

  const moved = await tools.execute('move_clip', {clipId, start: 4});
  assert.deepEqual(moved, {ok: true, affectedId: clipId});
  assert.equal(getProject().timeline.clips[0].start, 4);

  const trimmedLeft = await tools.execute('trim_clip', {clipId, edge: 'left', time: 6});
  assert.equal(trimmedLeft.ok, true);
  const afterLeft = getProject().timeline.clips[0];
  assert.equal(afterLeft.start, 6);
  assert.equal(afterLeft.duration, 8);
  assert.equal(afterLeft.sourceStart, 7);

  const trimmedRight = await tools.execute('trim_clip', {clipId, edge: 'right', time: 12});
  assert.equal(trimmedRight.ok, true);
  assert.equal(getProject().timeline.clips[0].duration, 6);

  const split = await tools.execute('split_clip', {clipId, time: 9});
  assert.equal(split.ok, true);
  assert.equal(getProject().timeline.clips.length, 2);
  const secondId = split.affectedId;

  const badSplit = await tools.execute('split_clip', {clipId, time: 6.05});
  assert.equal(badSplit.ok, false);
  assert.match(badSplit.reason, /0\.1s/);

  const selected = await tools.execute('select_clip', {clipId: secondId});
  assert.equal(selected.ok, true);
  assert.equal(state.selectedClipId, secondId);

  const sought = await tools.execute('seek_playhead', {time: 9999});
  assert.equal(sought.ok, true);
  assert.equal(state.currentTime, getProject().timeline.duration);

  const removed = await tools.execute('remove_clip', {clipId: secondId});
  assert.equal(removed.ok, true);
  assert.equal(getProject().timeline.clips.length, 1);

  const added = await tools.execute('add_clip', {assetId, trackId: 'V1', start: 20, duration: 3});
  assert.equal(added.ok, true);

  const track = await tools.execute('add_track', {kind: 'audio'});
  assert.equal(track.ok, true);
});

test('errors come back as {error} instead of throwing', async () => {
  const {tools} = setup();
  const missing = await tools.execute('get_clip', {clipId: 'clip-nope'});
  assert.match(missing.error, /No timeline clip with id clip-nope/);
  const badAsset = await tools.execute('add_clip', {assetId: 'asset-nope', trackId: 'V1', start: 0});
  assert.match(badAsset.error, /No media asset/);
  const badEdge = await tools.execute('trim_clip', {clipId: 'clip-nope', edge: 'left', time: 1});
  assert.match(badEdge.error, /No timeline clip/);
});
