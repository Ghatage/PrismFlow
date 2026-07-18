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
