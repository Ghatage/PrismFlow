import assert from 'node:assert/strict';
import test from 'node:test';

import {buildGenerationRequest} from '../src/generation-request-builder.js';
import {createProjectStore} from '../src/project-store.js';
import {createStyleLibrary} from '../src/style-library.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const createFixture = () => {
  let id = 0;
  const storage = new MemoryStorage();
  const store = createProjectStore({
    storage,
    createId: (prefix) => `${prefix}-style-${++id}`,
    now: () => '2026-07-17T12:00:00.000Z',
  });
  const assetA = store.dispatch({
    type: 'asset/import',
    asset: {name: 'film-grain.png', kind: 'image', mimeType: 'image/png', url: 'https://assets.example.test/grain.png'},
  }).affectedId;
  const assetB = store.dispatch({
    type: 'asset/import',
    asset: {name: 'palette.png', kind: 'image', mimeType: 'image/png', url: 'https://assets.example.test/palette.png'},
  }).affectedId;
  const library = createStyleLibrary(store);
  const styleId = library.createDraft('Noir film').affectedId;
  library.recordVersion(styleId, {
    id: 'noir-v1',
    referenceAssetIds: [assetA, assetB],
    prompt: 'high contrast 35mm grain',
    modelId: 'local/manual',
    parentAssetIds: [assetA, assetB],
  });
  library.lockVersion(styleId, 'noir-v1');
  const clipId = store.dispatch({
    type: 'clip/add',
    assetId: assetA,
    provenance: {prompt: 'A rainy street', modelId: 'fal-ai/test'},
  }).affectedId;
  return {storage, store, library, assetA, assetB, styleId, clipId};
};

test('persists append-only style versions and lock state', () => {
  const {storage, library, styleId, assetA, assetB} = createFixture();
  const [style] = library.load();
  assert.equal(style.id, styleId);
  assert.equal(style.lockedVersionId, 'noir-v1');
  assert.deepEqual(style.versions[0].referenceAssetIds, [assetA, assetB]);

  const reloaded = createProjectStore({storage, now: () => '2026-07-17T12:01:00.000Z'}).getProject();
  assert.equal(reloaded.styles[0].lockedVersionId, 'noir-v1');
  assert.deepEqual(reloaded.styles[0].versions[0].referenceAssetIds, [assetA, assetB]);
});

test('automatically adds locked style references to future generation requests', () => {
  const {store, assetA, assetB, clipId} = createFixture();
  const clip = store.getProject().timeline.clips.find((candidate) => candidate.id === clipId);
  const request = buildGenerationRequest({clip, project: store.getProject()});
  assert.deepEqual(request.referenceAssetIds, [assetA, assetB]);
  assert.deepEqual(request.provenance.styleVersionIds, ['noir-v1']);
  assert.equal(request.provenance.resolvedStyleVersions[0].styleName, 'Noir film');
});

test('rejects style versions that point at missing assets', () => {
  const {library, styleId} = createFixture();
  assert.throws(() => library.recordVersion(styleId, {
    referenceAssetIds: ['missing-reference'],
  }), /must reference at least one existing asset/);
});
