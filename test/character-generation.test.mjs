import assert from 'node:assert/strict';
import test from 'node:test';

import {createCharacterLibrary} from '../src/character-library.js';
import {
  createCharacterGenerationController,
  createFakeCharacterGenerationAdapter,
  normalizeCharacterGenerationInput,
  recordCharacterSheetVersion,
} from '../src/character-generation.js';
import {createProjectStore} from '../src/project-store.js';

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

const input = {
  name: 'Marlow',
  prompt: 'A warm, adventurous fox character turnaround',
  styleNotes: 'Soft geometric shapes',
  referenceAssetIds: ['reference-1', 'reference-1', 'reference-2'],
};

test('validates composer input and prevents duplicate active submissions', async () => {
  assert.throws(() => normalizeCharacterGenerationInput({...input, name: ' '}), /Character name is required/);
  assert.throws(() => normalizeCharacterGenerationInput({...input, prompt: ''}), /Visual prompt is required/);
  assert.deepEqual(normalizeCharacterGenerationInput(input).referenceAssetIds, ['reference-1', 'reference-2']);
  assert.equal(normalizeCharacterGenerationInput({...input, kind: 'scene-still'}).kind, 'scene-still');

  const controller = createCharacterGenerationController({adapter: createFakeCharacterGenerationAdapter()});
  const submitted = await controller.submit(input);
  assert.equal(submitted.status, 'generating');
  assert.equal(submitted.providerStatus, 'queued');
  assert.ok(submitted.jobId);
  await assert.rejects(controller.submit(input), /already generating/);

  const running = await controller.poll();
  assert.equal(running.status, 'generating');
  assert.equal(running.providerStatus, 'running');
  const ready = await controller.poll();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.providerStatus, 'completed');
  assert.equal(ready.result.modelId, 'local/fake-character-sheet-v1');
  assert.match(ready.result.asset.url, /^data:image\/svg\+xml/);
});

test('exercises deterministic failure and retry with a new job', async () => {
  const completed = [];
  const controller = createCharacterGenerationController({
    adapter: createFakeCharacterGenerationAdapter(),
    onCompleted: async (result) => completed.push(result.source.jobId),
  });

  const first = await controller.submit({...input, prompt: `${input.prompt} [fail]`});
  await controller.poll();
  const failed = await controller.poll();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Deterministic local generation failure/);

  const retried = await controller.retry(input);
  assert.equal(retried.status, 'retrying');
  assert.equal(retried.attempt, 2);
  assert.notEqual(retried.jobId, first.jobId);
  await controller.poll();
  const ready = await controller.poll();
  assert.equal(ready.status, 'ready');
  assert.deepEqual(completed, [retried.jobId]);
});

test('records one completed version without locking or duplicating its character', async () => {
  let id = 0;
  const storage = new MemoryStorage();
  const store = createProjectStore({
    storage,
    createId: (prefix) => `${prefix}-generation-${++id}`,
    now: () => '2026-07-16T14:00:00.000Z',
  });
  const library = createCharacterLibrary(store);
  const characterId = library.createDraft(input.name).affectedId;
  const controller = createCharacterGenerationController({
    adapter: createFakeCharacterGenerationAdapter(),
    onCompleted: async (result, completedInput) => recordCharacterSheetVersion({
      dispatch: store.dispatch,
      library,
      characterId,
      input: completedInput,
      result,
    }),
  });

  await controller.submit(input);
  await controller.poll();
  await controller.poll();

  const project = store.getProject();
  assert.equal(project.characters.length, 1);
  assert.equal(project.characters[0].versions.length, 1);
  assert.equal(project.characters[0].lockedVersionId, null);
  assert.equal(project.characters[0].versions[0].prompt, input.prompt);
  assert.equal(project.characters[0].versions[0].modelId, 'local/fake-character-sheet-v1');
  assert.equal(Number.isFinite(project.characters[0].versions[0].seed), true);
  assert.equal(project.characters[0].versions[0].params.mode, 'deterministic');
  assert.equal(project.mediaAssets.length, 1);
  assert.match(project.mediaAssets[0].url, /^data:image\/svg\+xml/);
  assert.equal(project.mediaAssets[0].metadata.provider, 'local-fake');
  assert.equal(project.mediaAssets[0].metadata.providerModelId, 'local/fake-character-sheet-v1');
  assert.match(project.mediaAssets[0].metadata.providerJobId, /^fake-character-job-/);

  const reopened = createProjectStore({storage}).getProject();
  assert.equal(reopened.characters[0].versions.length, 1);
  assert.equal(reopened.characters[0].lockedVersionId, null);
  assert.equal(reopened.mediaAssets[0].url, null);
});
