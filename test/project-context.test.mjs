import assert from 'node:assert/strict';
import test from 'node:test';

import {createProjectContextService, searchProjectContext} from '../src/project-context.js';
import {createProjectStore} from '../src/project-store.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const createFixture = () => {
  const storage = new MemoryStorage();
  let id = 0;
  const store = createProjectStore({
    storage,
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => '2026-07-17T10:00:00.000Z',
  });
  const assetId = store.dispatch({
    type: 'asset/import',
    asset: {id: 'fox-shot', name: 'fox-shot.png', kind: 'image', mimeType: 'image/png', duration: 5, url: 'https://assets.example.test/fox.png'},
  }).affectedId;
  const clipId = store.dispatch({
    type: 'clip/add',
    assetId,
    start: 2,
    duration: 5,
    provenance: {
      prompt: 'A red fox jumps over a puddle',
      modelId: 'fal-ai/image-model',
      seed: 42,
      derivedMetadata: {description: 'A red fox leaps over a puddle in the forest'},
    },
  }).affectedId;
  return {storage, store, clipId};
};

test('builds durable searchable clip context with provenance and descriptions', () => {
  const {store, clipId} = createFixture();
  const context = createProjectContextService({
    getProject: () => store.getProject(),
    dispatch: (command) => store.dispatch(command),
    now: () => '2026-07-17T10:01:00.000Z',
  });

  const index = context.rebuild();
  const entry = index.entries.find((candidate) => candidate.clipId === clipId);
  assert.ok(entry);
  assert.equal(entry.description, 'A red fox leaps over a puddle in the forest');
  assert.equal(entry.metadata.prompt, 'A red fox jumps over a puddle');
  assert.equal(entry.metadata.modelId, 'fal-ai/image-model');
  assert.equal(entry.start, 2);
  assert.equal(store.getProject().contextIndex.sourceRevision, store.getProject().timeline.revision);
  assert.equal(context.search('fox jumps')[0].clipId, clipId);
});

test('refreshes stale context after accepted timeline edits and supports type filters', () => {
  const {store, clipId} = createFixture();
  const context = createProjectContextService({
    getProject: () => store.getProject(),
    dispatch: (command) => store.dispatch(command),
    now: () => '2026-07-17T10:01:00.000Z',
  });
  context.rebuild();
  store.dispatch({type: 'clip/move', clipId, start: 8});
  const result = context.search('fox puddle', {type: 'clip'});
  assert.equal(result.length, 1);
  assert.equal(result[0].start, 8);
  assert.ok(context.search('Opening scene', {type: 'scene'}).length);
  assert.equal(searchProjectContext(context.getIndex(), 'not present').length, 0);
});

test('context index survives project reload', () => {
  const {storage, store} = createFixture();
  const context = createProjectContextService({
    getProject: () => store.getProject(),
    dispatch: (command) => store.dispatch(command),
    now: () => '2026-07-17T10:01:00.000Z',
  });
  context.rebuild();

  const reloaded = createProjectStore({storage, now: () => '2026-07-17T10:02:00.000Z'});
  assert.ok(reloaded.getProject().contextIndex.entries.some((entry) => entry.type === 'clip'));
});

test('refreshes in-memory context when metadata changes without a timeline revision', () => {
  const {store} = createFixture();
  let currentProject = store.getProject();
  const context = createProjectContextService({
    getProject: () => currentProject,
    dispatch: (command) => {
      const result = store.dispatch(command);
      currentProject = result.project;
      return result;
    },
    now: () => '2026-07-17T10:01:00.000Z',
  });
  context.rebuild();
  const sceneId = currentProject.scenes[0].id;
  const revision = currentProject.timeline.revision;
  store.dispatch({type: 'scene/update', sceneId, patch: {name: 'Rainy forest'}});
  currentProject = store.getProject();
  assert.equal(currentProject.timeline.revision, revision);
  assert.equal(context.search('Rainy forest', {type: 'scene'})[0].sceneId, sceneId);
});
