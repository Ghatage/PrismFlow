import assert from 'node:assert/strict';
import test from 'node:test';

import {createCharacterLibrary} from '../src/character-library.js';
import {buildGenerationRequest} from '../src/generation-request-builder.js';
import {createProjectStore} from '../src/project-store.js';
import {createTimelineCharacterAttachments} from '../src/timeline-characters.js';

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

const version = (id, sheetAssetId, prompt) => ({
  id,
  sheetAssetId,
  referenceAssetIds: [],
  prompt,
  modelId: 'local/test',
  seed: id,
  params: {},
  parentAssetIds: [],
});

test('attaches multiple locked versions, persists them, and resolves exact sheet assets', () => {
  let id = 0;
  let tick = 0;
  const storage = new MemoryStorage();
  const dependencies = {
    createId: (prefix) => `${prefix}-timeline-${++id}`,
    now: () => `2026-07-16T15:00:${String(tick++).padStart(2, '0')}.000Z`,
  };
  const store = createProjectStore({storage, ...dependencies});
  const library = createCharacterLibrary(store);
  const attachments = createTimelineCharacterAttachments(store);

  const foxV1Sheet = store.dispatch({type: 'asset/import', asset: {name: 'fox-v1.png', kind: 'image', mimeType: 'image/png'}}).affectedId;
  const foxV2Sheet = store.dispatch({type: 'asset/import', asset: {name: 'fox-v2.png', kind: 'image', mimeType: 'image/png'}}).affectedId;
  const owlSheet = store.dispatch({type: 'asset/import', asset: {name: 'owl-v1.png', kind: 'image', mimeType: 'image/png'}}).affectedId;
  const shotAsset = store.dispatch({type: 'asset/import', asset: {name: 'shot.png', kind: 'image', mimeType: 'image/png'}}).affectedId;
  const clipId = store.dispatch({
    type: 'clip/add',
    assetId: shotAsset,
    trackId: 'V1',
    start: 0,
    provenance: {prompt: 'Marlow and Ada share a map'},
  }).affectedId;

  const foxId = library.createDraft('Marlow').affectedId;
  library.recordVersion(foxId, version('fox-v1', foxV1Sheet, 'First fox'));
  library.lockVersion(foxId, 'fox-v1');
  const owlId = library.createDraft('Ada').affectedId;
  library.recordVersion(owlId, version('owl-v1', owlSheet, 'First owl'));
  library.lockVersion(owlId, 'owl-v1');

  assert.deepEqual(attachments.lockedVersions(clipId).map((entry) => entry.versionId), ['fox-v1', 'owl-v1']);
  attachments.attach(clipId, 'fox-v1');
  attachments.attach(clipId, 'owl-v1');
  attachments.attach(clipId, 'fox-v1');

  let project = store.getProject();
  let clip = project.timeline.clips.find((candidate) => candidate.id === clipId);
  assert.deepEqual(clip.provenance.characterVersionIds, ['fox-v1', 'owl-v1']);
  assert.deepEqual(buildGenerationRequest({clip, project}), {
    prompt: 'Marlow and Ada share a map',
    referenceAssetIds: [foxV1Sheet, owlSheet],
    provenance: {
      prompt: 'Marlow and Ada share a map',
      modelId: null,
      seed: null,
      params: {},
      parentAssetId: null,
      derivedMetadata: null,
      characterVersionIds: ['fox-v1', 'owl-v1'],
      resolvedCharacterVersions: [
        {characterId: foxId, characterName: 'Marlow', versionId: 'fox-v1', sheetAssetId: foxV1Sheet},
        {characterId: owlId, characterName: 'Ada', versionId: 'owl-v1', sheetAssetId: owlSheet},
      ],
    },
  });

  library.unlockVersion(foxId);
  library.recordVersion(foxId, version('fox-v2', foxV2Sheet, 'Second fox'));
  library.lockVersion(foxId, 'fox-v2');
  project = store.getProject();
  clip = project.timeline.clips.find((candidate) => candidate.id === clipId);
  assert.deepEqual(clip.provenance.characterVersionIds, ['fox-v1', 'owl-v1']);
  assert.deepEqual(buildGenerationRequest({clip, project}).referenceAssetIds, [foxV1Sheet, owlSheet]);
  assert.equal(attachments.attachedVersions(clipId)[0].isLocked, false);

  const hydratedStore = createProjectStore({storage, ...dependencies});
  const hydratedAttachments = createTimelineCharacterAttachments(hydratedStore);
  assert.deepEqual(hydratedAttachments.attachedVersions(clipId).map((entry) => entry.versionId), ['fox-v1', 'owl-v1']);

  hydratedAttachments.remove(clipId, 'fox-v1');
  const afterRemoval = hydratedStore.getProject();
  assert.deepEqual(afterRemoval.timeline.clips[0].provenance.characterVersionIds, ['owl-v1']);
  assert.equal(afterRemoval.characters.length, 2);
  assert.deepEqual(afterRemoval.characters[0].versions.map((entry) => entry.id), ['fox-v1', 'fox-v2']);
});

test('rejects unlocked attachments and missing generation references', () => {
  let id = 0;
  const store = createProjectStore({
    storage: new MemoryStorage(),
    createId: (prefix) => `${prefix}-reject-${++id}`,
    now: () => '2026-07-16T16:00:00.000Z',
  });
  const library = createCharacterLibrary(store);
  const attachments = createTimelineCharacterAttachments(store);
  const sheetId = store.dispatch({type: 'asset/import', asset: {name: 'sheet.png', kind: 'image', mimeType: 'image/png'}}).affectedId;
  const clipId = store.dispatch({type: 'clip/add', assetId: sheetId, trackId: 'V1', start: 0}).affectedId;
  const characterId = library.createDraft('Unlocked').affectedId;
  library.recordVersion(characterId, version('unlocked-v1', sheetId, 'Unlocked'));

  assert.throws(() => attachments.attach(clipId, 'unlocked-v1'), /currently locked/);
  assert.throws(() => buildGenerationRequest({
    clip: {...store.getProject().timeline.clips[0], provenance: {characterVersionIds: ['missing-v1']}},
    project: store.getProject(),
  }), /Character version is missing/);
});
