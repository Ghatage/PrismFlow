import assert from 'node:assert/strict';
import test from 'node:test';

import {createClipRegenerationService} from '../src/clip-regeneration.js';
import {createProjectStore} from '../src/project-store.js';
import {createTimelineDiffs} from '../src/timeline-diffs.js';
import {createFakeTimelineGenerationAdapter} from '../src/timeline-generation.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const createFixture = () => {
  let id = 0;
  let seed = 100;
  const store = createProjectStore({
    storage: new MemoryStorage(),
    createId: (prefix) => `${prefix}-regeneration-${++id}`,
    now: () => '2026-07-16T22:00:00.000Z',
  });
  const assetId = store.dispatch({
    type: 'asset/import',
    asset: {
      name: 'Original generated shot',
      kind: 'image',
      mimeType: 'image/png',
      duration: 4,
      url: 'https://assets.example.test/original.png',
      source: {type: 'generated', fileName: 'original.png'},
    },
  }).affectedId;
  const clipId = store.dispatch({
    type: 'clip/add',
    assetId,
    start: 2,
    duration: 4,
    provenance: {
      prompt: 'Original fox prompt',
      modelId: 'local/original-model',
      seed: 10,
      params: {quality: 'draft'},
      parentAssetId: 'ancestor-asset',
      characterVersionIds: ['fox-locked-v1'],
    },
  }).affectedId;
  const diffs = createTimelineDiffs(store);
  const service = createClipRegenerationService({
    store,
    diffs,
    adapter: createFakeTimelineGenerationAdapter(),
    createSeed: () => ++seed,
  });
  return {store, diffs, service, assetId, clipId};
};

const finish = async (service, jobId) => {
  let job;
  for (let attempt = 0; attempt < 3; attempt += 1) job = await service.poll(jobId);
  assert.equal(job.status, 'completed');
  return job;
};

test('derives distinct prompt, seed, model, and comparison jobs from persisted provenance', async () => {
  const {store, diffs, service, assetId, clipId} = createFixture();
  const originalClip = structuredClone(store.getProject().timeline.clips[0]);

  const promptJob = await service.regenerateClip({clipId, prompt: 'Edited fox prompt'});
  const seedJob = await service.rerollSeed(clipId);
  const modelJob = await service.changeModel(clipId, 'local/alternate-model');
  assert.equal(new Set([promptJob.jobId, seedJob.jobId, modelJob.jobId]).size, 3);
  const initialJobs = service.listJobs(clipId);
  assert.equal(initialJobs.find((job) => job.jobId === promptJob.jobId).input.prompt, 'Edited fox prompt');
  assert.equal(initialJobs.find((job) => job.jobId === seedJob.jobId).input.seed, 101);
  assert.equal(initialJobs.find((job) => job.jobId === modelJob.jobId).input.modelId, 'local/alternate-model');
  assert.ok(initialJobs.every((job) => job.input.sourceClipId === clipId));
  assert.ok(initialJobs.every((job) => job.input.characterVersionIds[0] === 'fox-locked-v1'));

  await Promise.all([promptJob, seedJob, modelJob].map(({jobId}) => finish(service, jobId)));
  const comparison = await service.compareVariants(clipId, {count: 2});
  assert.equal(comparison.length, 2);
  await Promise.all(comparison.map(({jobId}) => finish(service, jobId)));
  assert.ok(service.listCandidates(clipId).length >= 2);
  assert.equal(store.getProject().mediaAssets.length, 1);
  assert.equal(diffs.listPending().length, 0);

  const proposedModel = service.useCandidate(modelJob.jobId);
  assert.equal(proposedModel.changed, true);
  assert.equal(store.getProject().mediaAssets.length, 2);
  assert.equal(diffs.listPending().length, 1);
  const modelDiff = diffs.listPending()[0];
  assert.equal(modelDiff.operations[0].after.provenance.modelId, 'local/alternate-model');
  assert.deepEqual(modelDiff.operations[0].after.provenance.characterVersionIds, ['fox-locked-v1']);
  diffs.reject(modelDiff.id);
  assert.deepEqual(store.getProject().timeline.clips[0], originalClip);

  const proposedPrompt = service.useCandidate(promptJob.jobId);
  assert.equal(proposedPrompt.changed, true);
  assert.equal(service.useCandidate(promptJob.jobId).changed, false);
  assert.equal(diffs.listPending().length, 1);
  const promptDiff = diffs.listPending()[0];
  const proposedClip = promptDiff.operations[0].after;
  assert.equal(proposedClip.provenance.prompt, 'Edited fox prompt');
  assert.equal(proposedClip.provenance.parentAssetId, assetId);
  assert.deepEqual(proposedClip.provenance.parentAssetIds, [assetId, 'ancestor-asset']);
  assert.deepEqual(proposedClip.provenance.derivedMetadata.changedFields.prompt, {
    from: 'Original fox prompt',
    to: 'Edited fox prompt',
  });
  assert.deepEqual(proposedClip.provenance.characterVersionIds, ['fox-locked-v1']);

  const accepted = diffs.accept(promptDiff.id).project;
  const acceptedClip = accepted.timeline.clips[0];
  assert.equal(acceptedClip.provenance.prompt, 'Edited fox prompt');
  assert.equal(acceptedClip.provenance.derivedMetadata.changedFields.prompt.from, 'Original fox prompt');
  assert.deepEqual(acceptedClip.provenance.parentAssetIds, [assetId, 'ancestor-asset']);
  assert.ok(accepted.mediaAssets.some((asset) => asset.id === assetId));
  assert.deepEqual(acceptedClip.provenance.characterVersionIds, ['fox-locked-v1']);
});

test('never allows regeneration to substitute a locked character version', async () => {
  const {store, service, clipId} = createFixture();
  await assert.rejects(service.regenerateClip({
    clipId,
    prompt: 'Try another identity',
    characterVersionIds: ['fox-locked-v2'],
  }), /cannot be replaced/);
  assert.equal(service.listJobs().length, 0);
  assert.equal(store.getProject().mediaAssets.length, 1);
  assert.equal(store.getProject().timelineDiffs.items.length, 0);
});

test('marks a completed candidate stale when accepted edits advance during generation', async () => {
  const {store, diffs, service, clipId} = createFixture();
  const submitted = await service.rerollSeed(clipId);
  store.dispatch({type: 'clip/move', clipId, start: 5, trackId: 'V1'});
  await finish(service, submitted.jobId);
  service.useCandidate(submitted.jobId);
  const [proposal] = diffs.listPending();
  assert.equal(proposal.status, 'stale');
  assert.throws(() => diffs.accept(proposal.id), /must be reconciled/);
});
