import assert from 'node:assert/strict';
import test from 'node:test';

import {createCharacterLibrary} from '../src/character-library.js';
import {createProjectStore, PROJECT_STORAGE_KEY} from '../src/project-store.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
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
    createId: (prefix) => `${prefix}-library-${++id}`,
    now: () => `2026-07-16T13:00:${String(tick++).padStart(2, '0')}.000Z`,
  };
};

test('creates, renames, versions, locks, unlocks, and reloads characters', () => {
  const storage = new MemoryStorage();
  const dependencies = createDependencies();
  const store = createProjectStore({storage, ...dependencies});
  const library = createCharacterLibrary(store);

  const firstAsset = store.dispatch({
    type: 'asset/import',
    asset: {
      name: 'fox-front.png',
      kind: 'image',
      mimeType: 'image/png',
      url: 'blob:http://localhost/fox-front',
      metadata: {width: 1024, apiKey: 'do-not-store'},
    },
  }).affectedId;
  const secondAsset = store.dispatch({
    type: 'asset/import',
    asset: {
      name: 'fox-turnaround.png',
      kind: 'image',
      mimeType: 'image/png',
      url: 'data:image/png;base64,private-pixels',
      metadata: {height: 1024, preview: 'data:image/png;base64,also-private'},
    },
  }).affectedId;

  const characterId = library.createDraft('Fox').affectedId;
  library.rename(characterId, 'Marlow the fox');
  library.recordVersion(characterId, {
    id: 'char-fox-v1',
    sheetAssetId: firstAsset,
    referenceAssetIds: [firstAsset],
    prompt: 'A friendly fox turnaround',
    modelId: 'local/manual',
    seed: 11,
    params: {format: 'sheet', authorization: 'Bearer hidden'},
    parentAssetIds: [firstAsset],
  });
  library.lockVersion(characterId, 'char-fox-v1');
  library.recordVersion(characterId, {
    id: 'char-fox-v2',
    sheetAssetId: secondAsset,
    referenceAssetIds: [firstAsset, secondAsset],
    prompt: 'A refined friendly fox turnaround',
    modelId: 'local/manual',
    seed: 12,
    params: {format: 'sheet'},
    parentAssetIds: [firstAsset],
  });

  let [character] = library.load();
  assert.equal(character.name, 'Marlow the fox');
  assert.equal(character.status, 'ready');
  assert.equal(character.versions.length, 2);
  assert.equal(character.lockedVersionId, 'char-fox-v1');
  assert.equal(character.activeVersionId, 'char-fox-v1');
  assert.equal(character.versions[0].prompt, 'A friendly fox turnaround');

  library.unlockVersion(characterId);
  [character] = library.load();
  assert.equal(character.lockedVersionId, null);
  assert.equal(character.activeVersionId, 'char-fox-v2');

  character.name = 'Mutation must not leak';
  assert.equal(library.load()[0].name, 'Marlow the fox');

  const serialized = storage.getItem(PROJECT_STORAGE_KEY);
  assert.equal(serialized.includes('blob:'), false);
  assert.equal(serialized.includes('base64'), false);
  assert.equal(serialized.includes('do-not-store'), false);
  assert.equal(serialized.includes('Bearer hidden'), false);

  const hydrated = createProjectStore({storage, ...createDependencies()}).getProject();
  assert.equal(hydrated.characters[0].name, 'Marlow the fox');
  assert.deepEqual(hydrated.characters[0].versions.map((version) => version.id), ['char-fox-v1', 'char-fox-v2']);
  assert.equal(hydrated.characters[0].versions[0].params.authorization, undefined);
  assert.equal(hydrated.mediaAssets[0].url, null);
});

test('rejects invalid character versions and leaves the timeline untouched', () => {
  const store = createProjectStore({storage: new MemoryStorage(), ...createDependencies()});
  const library = createCharacterLibrary(store);
  const characterId = library.createDraft('No sheet yet').affectedId;

  assert.throws(() => library.recordVersion(characterId, {
    sheetAssetId: 'missing-asset',
    prompt: 'Cannot be recorded',
  }), /existing sheet asset/);
  assert.equal(library.load()[0].versions.length, 0);
  assert.equal(store.getProject().timeline.clips.length, 0);
});

test('deletes a character and detaches its versions from timeline clips', () => {
  const store = createProjectStore({storage: new MemoryStorage(), ...createDependencies()});
  const library = createCharacterLibrary(store);
  const sheetId = store.dispatch({type: 'asset/import', asset: {name: 'fox-sheet.png', kind: 'image', mimeType: 'image/png'}}).affectedId;
  const shotId = store.dispatch({type: 'asset/import', asset: {name: 'shot.png', kind: 'image', mimeType: 'image/png'}}).affectedId;
  const characterId = library.createDraft('Fox').affectedId;
  library.recordVersion(characterId, {id: 'fox-version-1', sheetAssetId: sheetId, prompt: 'A fox', modelId: 'local/test'});
  library.lockVersion(characterId, 'fox-version-1');
  const clipId = store.dispatch({
    type: 'clip/add',
    assetId: shotId,
    trackId: 'V1',
    start: 0,
    provenance: {characterVersionIds: ['fox-version-1']},
  }).affectedId;
  const revisionBeforeDelete = store.getProject().timeline.revision;

  library.remove(characterId);

  const project = store.getProject();
  assert.equal(project.characters.length, 0);
  assert.deepEqual(project.timeline.clips.find((clip) => clip.id === clipId).provenance.characterVersionIds, []);
  assert.ok(project.timeline.revision > revisionBeforeDelete);
});
