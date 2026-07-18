import assert from 'node:assert/strict';
import test from 'node:test';

import {createProjectStore, PROJECT_SCHEMA_VERSION, PROJECT_STORAGE_KEY} from '../src/project-store.js';

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

const createDependencies = () => {
  let id = 0;
  let tick = 0;
  return {
    createId: (prefix) => `${prefix}-test-${++id}`,
    now: () => `2026-07-16T12:00:${String(tick++).padStart(2, '0')}.000Z`,
  };
};

test('persists project structure and provenance without runtime URLs or secrets', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});

  const imported = store.dispatch({
    type: 'asset/import',
    asset: {
      name: 'opening.png',
      kind: 'image',
      mimeType: 'image/png',
      size: 2048,
      duration: 5,
      url: 'blob:http://localhost/private-object-url',
      source: {type: 'local-file', fileName: 'opening.png', lastModified: 1234},
      metadata: {width: 1920, falApiKey: 'never-persist-this'},
    },
  });
  const added = store.dispatch({
    type: 'clip/add',
    assetId: imported.affectedId,
    trackId: 'V1',
    start: 1.5,
    provenance: {
      prompt: 'A calm opening frame',
      modelId: 'fal-ai/example',
      seed: 42,
      params: {steps: 28, authorization: 'Bearer hidden'},
      parentAssetId: 'media-parent',
      derivedMetadata: {operation: 'upscale', previewUrl: 'blob:http://localhost/derived'},
    },
  });

  const runtimeProject = added.project;
  assert.equal(runtimeProject.mediaAssets[0].url, 'blob:http://localhost/private-object-url');
  assert.equal(runtimeProject.timeline.clips[0].id, added.affectedId);

  const serialized = storage.getItem(PROJECT_STORAGE_KEY);
  const persisted = JSON.parse(serialized);
  assert.equal(persisted.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.match(persisted.updatedAt, /^2026-07-16/);
  assert.equal(persisted.project.name, 'Untitled story');
  assert.equal(persisted.scenes.length, 1);
  assert.deepEqual(persisted.characters, []);
  assert.equal(persisted.mediaAssets[0].metadata.width, 1920);
  assert.equal(persisted.timeline.tracks.length, 2);
  assert.deepEqual(persisted.timeline.clips[0].provenance, {
    prompt: 'A calm opening frame',
    modelId: 'fal-ai/example',
    seed: 42,
    params: {steps: 28},
    parentAssetId: 'media-parent',
    parentAssetIds: ['media-parent'],
    derivedMetadata: {operation: 'upscale'},
    characterVersionIds: [],
  });
  assert.equal(serialized.includes('blob:'), false);
  assert.equal(serialized.includes('never-persist-this'), false);
  assert.equal(serialized.includes('Bearer hidden'), false);

  const moved = store.dispatch({type: 'clip/move', clipId: added.affectedId, trackId: 'V1', start: 3.2});
  assert.equal(moved.project.timeline.clips[0].start, 3.2);
  assert.equal(JSON.parse(storage.getItem(PROJECT_STORAGE_KEY)).timeline.clips[0].start, 3.2);

  const hydrated = createProjectStore({storage, ...createDependencies()}).getProject();
  assert.equal(hydrated.mediaAssets[0].url, null);
  assert.equal(hydrated.timeline.clips[0].start, 3.2);
  assert.equal(hydrated.timeline.clips[0].provenance.prompt, 'A calm opening frame');
});

test('recovers from malformed or unavailable browser storage', () => {
  const malformedStorage = new MemoryStorage({[PROJECT_STORAGE_KEY]: '{not-json'});
  const recoveredStore = createProjectStore({storage: malformedStorage, ...createDependencies()});
  const recovered = recoveredStore.getProject();
  assert.equal(recovered.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(recovered.mediaAssets.length, 0);
  assert.doesNotThrow(() => JSON.parse(malformedStorage.getItem(PROJECT_STORAGE_KEY)));

  const unavailableStorage = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
  };
  const memoryOnlyStore = createProjectStore({storage: unavailableStorage, ...createDependencies()});
  const imported = memoryOnlyStore.dispatch({
    type: 'asset/import',
    asset: {name: 'offline.wav', kind: 'audio', mimeType: 'audio/wav'},
  });
  const added = memoryOnlyStore.dispatch({type: 'clip/add', assetId: imported.affectedId, trackId: 'V1', start: 0});
  assert.equal(memoryOnlyStore.getProject().mediaAssets.length, 1);
  assert.deepEqual(added.project.timeline.clips[0].provenance, {
    prompt: null,
    modelId: null,
    seed: null,
    params: {},
    parentAssetId: null,
    parentAssetIds: [],
    derivedMetadata: null,
    characterVersionIds: [],
  });
  assert.equal(added.project.timeline.clips[0].trackId, 'A1');
  assert.doesNotThrow(() => memoryOnlyStore.dispatch({type: 'clip/remove', clipId: added.affectedId}));
  assert.equal(memoryOnlyStore.getProject().timeline.clips.length, 0);
});

test('splits a clip at a timeline time and preserves source continuity', () => {
  const store = createProjectStore({storage: new MemoryStorage(), ...createDependencies()});
  const imported = store.dispatch({
    type: 'asset/import',
    asset: {name: 'scene.mp4', kind: 'video', mimeType: 'video/mp4', duration: 8},
  });
  const added = store.dispatch({type: 'clip/add', assetId: imported.affectedId, trackId: 'V1', start: 2, duration: 6});

  const split = store.dispatch({type: 'clip/split', clipId: added.affectedId, time: 5});
  assert.equal(split.changed, true);
  assert.notEqual(split.affectedId, added.affectedId);
  const clips = split.project.timeline.clips.toSorted((left, right) => left.start - right.start);
  assert.equal(clips.length, 2);
  assert.deepEqual(clips.map(({start, duration, sourceStart}) => ({start, duration, sourceStart})), [
    {start: 2, duration: 3, sourceStart: 0},
    {start: 5, duration: 3, sourceStart: 3},
  ]);
});

test('adds video tracks above the video stack and audio tracks below the audio stack', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});

  const addedVideo = store.dispatch({type: 'track/add', kind: 'video'});
  assert.equal(addedVideo.affectedId, 'V2');
  assert.deepEqual(addedVideo.project.timeline.tracks.map(({id, kind}) => ({id, kind})), [
    {id: 'V2', kind: 'video'},
    {id: 'V1', kind: 'video'},
    {id: 'A1', kind: 'audio'},
  ]);

  const addedAudio = store.dispatch({type: 'track/add', kind: 'audio'});
  assert.equal(addedAudio.affectedId, 'A2');
  assert.deepEqual(addedAudio.project.timeline.tracks.map(({id, kind}) => ({id, kind})), [
    {id: 'V2', kind: 'video'},
    {id: 'V1', kind: 'video'},
    {id: 'A1', kind: 'audio'},
    {id: 'A2', kind: 'audio'},
  ]);

  const imported = store.dispatch({
    type: 'asset/import',
    asset: {name: 'still.png', kind: 'image', mimeType: 'image/png'},
  });
  const added = store.dispatch({type: 'clip/add', assetId: imported.affectedId, trackId: 'V2', start: 0});
  assert.equal(added.project.timeline.clips[0].trackId, 'V2');

  const moved = store.dispatch({type: 'clip/move', clipId: added.affectedId, trackId: 'V1', start: 1});
  assert.equal(moved.project.timeline.clips[0].trackId, 'V1');

  const hydrated = createProjectStore({storage, ...createDependencies()}).getProject();
  assert.deepEqual(hydrated.timeline.tracks.map(({id, kind}) => ({id, kind})), [
    {id: 'V2', kind: 'video'},
    {id: 'V1', kind: 'video'},
    {id: 'A1', kind: 'audio'},
    {id: 'A2', kind: 'audio'},
  ]);
});

test('clip/detach-audio splits audio to the audio track and mutes the source clip', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const videoAssetId = store.dispatch({
    type: 'asset/import',
    asset: {name: 'shot.mp4', kind: 'video', mimeType: 'video/mp4', duration: 20, url: 'blob:http://localhost/shot'},
  }).affectedId;
  const clipId = store.dispatch({type: 'clip/add', assetId: videoAssetId, trackId: 'V1', start: 3, duration: 8, sourceStart: 2}).affectedId;

  const detached = store.dispatch({
    type: 'clip/detach-audio',
    clipId,
    audioAsset: {
      id: 'media-detached-1',
      name: 'shot.mp4 (audio)',
      kind: 'audio',
      mimeType: 'audio/wav',
      duration: 20,
      url: 'blob:http://localhost/shot-audio',
      source: {type: 'detached-audio', fileName: 'shot.mp4'},
    },
  });
  assert.equal(detached.changed, true);

  const project = detached.project;
  const audioAsset = project.mediaAssets.find((asset) => asset.id === 'media-detached-1');
  assert.equal(audioAsset.kind, 'audio');
  assert.equal(audioAsset.url, 'blob:http://localhost/shot-audio');
  assert.deepEqual(audioAsset.metadata.detachedFrom, {assetId: videoAssetId, clipId});

  const audioClip = project.timeline.clips.find((clip) => clip.id === detached.affectedId);
  assert.equal(audioClip.trackId, 'A1');
  assert.equal(audioClip.assetId, 'media-detached-1');
  assert.equal(audioClip.start, 3);
  assert.equal(audioClip.duration, 8);
  assert.equal(audioClip.sourceStart, 2);
  assert.equal(audioClip.provenance.parentAssetId, videoAssetId);
  assert.equal(audioClip.provenance.derivedMetadata.type, 'detached-audio');

  const videoClip = project.timeline.clips.find((clip) => clip.id === clipId);
  assert.equal(videoClip.audioDetached, true);

  const again = store.dispatch({type: 'clip/detach-audio', clipId, audioAsset: {id: 'media-detached-2', kind: 'audio'}});
  assert.equal(again.changed, false);
  assert.equal(again.project.mediaAssets.some((asset) => asset.id === 'media-detached-2'), false);
});

test('clip/detach-audio ignores non-video clips and persists the detached flag', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const imageAssetId = store.dispatch({type: 'asset/import', asset: {name: 'still.png', kind: 'image', duration: 5}}).affectedId;
  const imageClipId = store.dispatch({type: 'clip/add', assetId: imageAssetId, trackId: 'V1', start: 0}).affectedId;
  assert.equal(store.dispatch({type: 'clip/detach-audio', clipId: imageClipId, audioAsset: {id: 'media-x', kind: 'audio'}}).changed, false);

  const videoAssetId = store.dispatch({type: 'asset/import', asset: {name: 'shot.mp4', kind: 'video', duration: 10}}).affectedId;
  const clipId = store.dispatch({type: 'clip/add', assetId: videoAssetId, trackId: 'V1', start: 0, duration: 4}).affectedId;
  store.dispatch({type: 'clip/detach-audio', clipId, audioAsset: {id: 'media-detached-1', name: 'a', kind: 'audio', duration: 10}});

  const reloaded = createProjectStore({storage, ...createDependencies()});
  const clips = reloaded.getProject().timeline.clips;
  assert.equal(clips.find((clip) => clip.id === clipId).audioDetached, true);
  assert.equal(clips.find((clip) => clip.assetId === 'media-detached-1').trackId, 'A1');
});

test('transitions attach to clip edges, clamp duration, replace at junctions, and prune when invalid', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const assetId = store.dispatch({type: 'asset/import', asset: {name: 'a.mp4', kind: 'video', duration: 30}}).affectedId;
  const first = store.dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 0, duration: 5}).affectedId;
  const second = store.dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 5, duration: 5}).affectedId;

  const added = store.dispatch({type: 'transition/add', transitionType: 'crossfade', fromClipId: first, toClipId: second, duration: 9});
  const transition = added.project.timeline.transitions[0];
  assert.equal(transition.type, 'crossfade');
  assert.equal(transition.trackId, 'V1');
  assert.equal(transition.duration, 2.5);

  store.dispatch({type: 'transition/add', transitionType: 'wipe-left', fromClipId: first, toClipId: second});
  let project = store.getProject();
  assert.equal(project.timeline.transitions.length, 1);
  assert.equal(project.timeline.transitions[0].type, 'wipe-left');

  const fade = store.dispatch({type: 'transition/add', transitionType: 'dip-to-black', fromClipId: second});
  assert.equal(fade.changed, true);
  assert.equal(store.getProject().timeline.transitions.length, 2);

  const third = store.dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 20, duration: 5}).affectedId;
  assert.throws(
    () => store.dispatch({type: 'transition/add', transitionType: 'crossfade', fromClipId: first, toClipId: third}),
    /adjacent/,
  );
  assert.throws(
    () => store.dispatch({type: 'transition/add', transitionType: 'sparkle', fromClipId: first}),
    /Unknown transition type/,
  );

  const reloaded = createProjectStore({storage, ...createDependencies()});
  assert.equal(reloaded.getProject().timeline.transitions.length, 2);

  store.dispatch({type: 'clip/move', clipId: second, start: 12});
  project = store.getProject();
  assert.equal(project.timeline.transitions.length, 1);
  assert.equal(project.timeline.transitions[0].fromClipId, second);
  assert.equal(project.timeline.transitions[0].toClipId, null);

  store.dispatch({type: 'clip/remove', clipId: second});
  assert.equal(store.getProject().timeline.transitions.length, 0);

  const again = store.dispatch({type: 'transition/add', transitionType: 'crossfade', fromClipId: first});
  const removed = store.dispatch({type: 'transition/remove', transitionId: again.affectedId});
  assert.equal(removed.changed, true);
  assert.equal(store.getProject().timeline.transitions.length, 0);
});

test('custom transition definitions persist, drive the timeline, and clean up on removal', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const assetId = store.dispatch({type: 'asset/import', asset: {name: 'a.mp4', kind: 'video', duration: 30}}).affectedId;
  const first = store.dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 0, duration: 5}).affectedId;
  const second = store.dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 5, duration: 5}).affectedId;

  const definition = {
    label: 'Iris open',
    glyph: '◎',
    defaultDuration: 1.2,
    mode: 'blend',
    tracks: [
      {target: 'layerB', property: 'opacity', keyframes: [{at: 0, value: '1'}, {at: 1, value: '1'}]},
      {target: 'layerB', property: 'clipPath', keyframes: [{at: 0, value: 'circle(0% at 50% 50%)'}, {at: 1, value: 'circle(75% at 50% 50%)'}]},
    ],
  };
  const created = store.dispatch({type: 'transition-def/create', definition, promptText: 'circular reveal'});
  assert.equal(created.affectedId, 'custom-iris-open');
  assert.equal(store.getProject().customTransitions[0].promptText, 'circular reveal');

  assert.throws(
    () => store.dispatch({type: 'transition-def/create', definition: {label: 'Bad', mode: 'blend', tracks: []}}),
    /Invalid transition definition/,
  );

  const duplicate = store.dispatch({type: 'transition-def/create', definition});
  assert.equal(duplicate.affectedId, 'custom-iris-open-2');

  const added = store.dispatch({type: 'transition/add', transitionType: 'custom-iris-open', fromClipId: first, toClipId: second});
  assert.equal(added.project.timeline.transitions[0].duration, 1.2);

  const reloaded = createProjectStore({storage, ...createDependencies()});
  assert.equal(reloaded.getProject().customTransitions.length, 2);
  assert.equal(reloaded.getProject().timeline.transitions[0].type, 'custom-iris-open');

  const removed = store.dispatch({type: 'transition-def/remove', key: 'custom-iris-open'});
  assert.equal(removed.changed, true);
  assert.equal(store.getProject().customTransitions.length, 1);
  assert.equal(store.getProject().timeline.transitions.length, 0);
  assert.throws(
    () => store.dispatch({type: 'transition/add', transitionType: 'custom-iris-open', fromClipId: first, toClipId: second}),
    /Unknown transition type/,
  );
});

test('transitions are rejected on audio tracks', () => {
  const store = createProjectStore({storage: new MemoryStorage(), ...createDependencies()});
  const audioAssetId = store.dispatch({type: 'asset/import', asset: {name: 'a.wav', kind: 'audio', duration: 10}}).affectedId;
  const audioClipId = store.dispatch({type: 'clip/add', assetId: audioAssetId, trackId: 'A1', start: 0, duration: 5}).affectedId;
  assert.throws(
    () => store.dispatch({type: 'transition/add', transitionType: 'crossfade', fromClipId: audioClipId}),
    /video tracks/,
  );
});
