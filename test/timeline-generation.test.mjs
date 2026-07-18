import assert from 'node:assert/strict';
import test from 'node:test';

import {createFalTimelineGenerationAdapter} from '../server/timeline-generation-adapter.mjs';
import {createProjectStore} from '../src/project-store.js';
import {createTimelineDiffs} from '../src/timeline-diffs.js';
import {
  createFakeTimelineGenerationAdapter,
  createServerTimelineGenerationAdapter,
  createTimelineGenerationController,
  landGenerationResult,
  normalizeGenerationResult,
} from '../src/timeline-generation.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const createFixture = () => {
  let id = 0;
  const store = createProjectStore({
    storage: new MemoryStorage(),
    createId: (prefix) => `${prefix}-generation-${++id}`,
    now: () => '2026-07-16T21:00:00.000Z',
  });
  const sourceAssetId = store.dispatch({
    type: 'asset/import',
    asset: {name: 'source.png', kind: 'image', mimeType: 'image/png', duration: 4, url: 'https://assets.example.test/source.png'},
  }).affectedId;
  const clipId = store.dispatch({
    type: 'clip/add',
    assetId: sourceAssetId,
    start: 1,
    duration: 4,
    provenance: {
      prompt: 'A fox opens a map',
      modelId: 'local/original',
      seed: 10,
      params: {quality: 'draft'},
      parentAssetId: 'earlier-asset',
      characterVersionIds: ['fox-v1'],
    },
  }).affectedId;
  return {store, diffs: createTimelineDiffs(store), sourceAssetId, clipId};
};

const replacementInput = (clipId, overrides = {}) => ({
  operation: 'replace',
  sourceClipId: clipId,
  prompt: 'A fox opens a glowing map',
  modelId: 'local/fake-shot-v1',
  seed: 42,
  params: {quality: 'preview'},
  characterVersionIds: ['fox-v1'],
  ...overrides,
});

test('moves queued and running jobs into one pending generation diff', async () => {
  const {store, diffs, sourceAssetId, clipId} = createFixture();
  const acceptedBefore = structuredClone(store.getProject().timeline.clips);
  const landings = [];
  const controller = createTimelineGenerationController({
    adapter: createFakeTimelineGenerationAdapter(),
    onCompleted: async (output, job) => {
      const sourceClip = store.getProject().timeline.clips.find((clip) => clip.id === clipId);
      landings.push({output, job, landed: landGenerationResult({store, diffs, job, output, sourceClip})});
    },
  });

  const queued = await controller.submit(replacementInput(clipId));
  assert.equal(queued.status, 'queued');
  assert.equal(queued.providerStatus, 'queued');
  assert.equal((await controller.poll()).status, 'queued');
  assert.equal((await controller.poll()).status, 'running');
  const completed = await controller.poll();
  assert.equal(completed.status, 'completed');
  assert.equal(landings.length, 1);

  const project = store.getProject();
  assert.deepEqual(project.timeline.clips, acceptedBefore);
  assert.equal(project.mediaAssets.length, 2);
  assert.equal(diffs.listPending().length, 1);
  const [pending] = diffs.listPending();
  assert.equal(pending.source, 'generation');
  assert.equal(pending.operations[0].type, 'replace');
  const proposed = pending.operations[0].after;
  assert.equal(proposed.id, clipId);
  assert.equal(proposed.provenance.prompt, 'A fox opens a glowing map');
  assert.equal(proposed.provenance.modelId, 'local/fake-shot-v1');
  assert.equal(proposed.provenance.seed, 42);
  assert.deepEqual(proposed.provenance.params, {quality: 'preview', mode: 'deterministic'});
  assert.equal(proposed.provenance.parentAssetId, sourceAssetId);
  assert.deepEqual(proposed.provenance.parentAssetIds, [sourceAssetId, 'earlier-asset']);
  assert.deepEqual(proposed.provenance.characterVersionIds, ['fox-v1']);

  const replay = landGenerationResult({
    store,
    diffs,
    job: landings[0].job,
    output: landings[0].output,
    sourceClip: acceptedBefore[0],
  });
  assert.equal(replay.changed, false);
  assert.equal(store.getProject().mediaAssets.length, 2);
  assert.equal(diffs.listPending().length, 1);
  assert.equal((await controller.poll()).status, 'completed');
  assert.equal(landings.length, 1);

  const accepted = diffs.accept(pending.id).project;
  const generatedClip = accepted.timeline.clips.find((clip) => clip.id === clipId);
  assert.equal(generatedClip.assetId, replay.assetId);
  assert.match(accepted.mediaAssets.find((asset) => asset.id === replay.assetId).url, /^data:image\/svg\+xml/);
});

test('normalizes and lands add completions idempotently', () => {
  const {store, diffs} = createFixture();
  const job = {
    jobId: 'add-job-1',
    input: {
      operation: 'add',
      prompt: 'A wide establishing shot',
      modelId: 'local/fake-shot-v1',
      seed: 7,
      params: {camera: 'wide'},
      characterVersionIds: ['fox-v1'],
      start: 7,
      duration: 3,
    },
  };
  const output = {
    status: 'completed',
    asset: {url: 'https://assets.example.test/generated.png', mimeType: 'image/png', duration: 3},
    modelId: job.input.modelId,
    seed: 7,
    params: {mode: 'deterministic'},
    source: {provider: 'local-fake', jobId: job.jobId},
  };
  const normalized = normalizeGenerationResult({job, output, project: store.getProject()});
  assert.equal(normalized.diff.operations[0].type, 'add');
  assert.equal(normalized.diff.operations[0].proposedClip.start, 7);
  assert.deepEqual(normalized.diff.operations[0].proposedClip.provenance.characterVersionIds, ['fox-v1']);

  const first = landGenerationResult({store, diffs, job, output});
  const second = landGenerationResult({store, diffs, job, output});
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(store.getProject().mediaAssets.filter((asset) => asset.id === first.assetId).length, 1);
  assert.equal(diffs.listPending().filter((diff) => diff.id === first.diffId).length, 1);
});

test('keeps failed jobs visible, creates no orphan, and retries with a new job', async () => {
  const {store, diffs, clipId} = createFixture();
  const completed = [];
  const controller = createTimelineGenerationController({
    adapter: createFakeTimelineGenerationAdapter(),
    onCompleted: async (output, job) => {
      completed.push(job.jobId);
      landGenerationResult({
        store,
        diffs,
        job,
        output,
        sourceClip: store.getProject().timeline.clips.find((clip) => clip.id === clipId),
      });
    },
  });

  const first = await controller.submit(replacementInput(clipId, {prompt: 'A broken request [fail]'}));
  await controller.poll();
  await controller.poll();
  const failed = await controller.poll();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Deterministic timeline generation failure/);
  assert.equal(store.getProject().mediaAssets.length, 1);
  assert.equal(diffs.listPending().length, 0);

  const retried = await controller.retry(replacementInput(clipId, {prompt: 'A repaired request'}));
  assert.equal(retried.status, 'retrying');
  assert.notEqual(retried.jobId, first.jobId);
  await controller.poll();
  await controller.poll();
  assert.equal((await controller.poll()).status, 'completed');
  assert.deepEqual(completed, [retried.jobId]);
  assert.equal(diffs.listPending().length, 1);
});

test('rejects character reference substitution before importing an output', () => {
  const {store, diffs, clipId} = createFixture();
  const sourceClip = store.getProject().timeline.clips.find((clip) => clip.id === clipId);
  assert.throws(() => landGenerationResult({
    store,
    diffs,
    sourceClip,
    job: {jobId: 'wrong-character', input: replacementInput(clipId, {characterVersionIds: ['fox-v2']})},
    output: {asset: {url: 'https://assets.example.test/wrong.png', mimeType: 'image/png'}},
  }), /cannot replace the source clip character versions/);
  assert.equal(store.getProject().mediaAssets.length, 1);
  assert.equal(diffs.listPending().length, 0);
});

test('maps generic FAL queue output and browser routes without remote calls', async () => {
  const calls = [];
  let statusPolls = 0;
  const fal = {
    async submit(modelId, payload) { calls.push({kind: 'submit', modelId, payload}); return {request_id: 'fal-shot-1'}; },
    async status() { statusPolls += 1; return {status: statusPolls === 1 ? 'IN_PROGRESS' : 'COMPLETED'}; },
    async result() { return {video: {url: 'https://fal.media/shot.mp4', content_type: 'video/mp4', duration: 4}, seed: 123}; },
  };
  const serverAdapter = createFalTimelineGenerationAdapter({fal});
  const input = replacementInput('clip-1', {modelId: 'fal-ai/example-video', seed: 123});
  assert.deepEqual(await serverAdapter.submitTimelineGeneration(input), {jobId: 'fal-shot-1'});
  assert.deepEqual(await serverAdapter.getTimelineGenerationJob('fal-shot-1'), {status: 'running'});
  const result = await serverAdapter.getTimelineGenerationJob('fal-shot-1');
  assert.equal(result.status, 'completed');
  assert.equal(result.asset.url, 'https://fal.media/shot.mp4');
  assert.equal(calls[0].payload.prompt, input.prompt);
  assert.equal(calls[0].payload.seed, 123);

  const requests = [];
  const responses = [
    new Response(JSON.stringify({jobId: 'browser-shot'}), {status: 202}),
    new Response(JSON.stringify({status: 'queued'}), {status: 200}),
  ];
  const browserAdapter = createServerTimelineGenerationAdapter({
    fetchImpl: async (url, options = {}) => { requests.push({url, options}); return responses.shift(); },
  });
  assert.deepEqual(await browserAdapter.submitGeneration(input), {jobId: 'browser-shot'});
  assert.deepEqual(await browserAdapter.getGenerationJob('browser-shot'), {status: 'queued'});
  assert.equal(requests[0].url, '/api/timeline/generate');
  assert.equal(requests[1].url, '/api/timeline/jobs/browser-shot');
  assert.equal(JSON.stringify(requests).includes('FAL_API_KEY'), false);
});
