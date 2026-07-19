import assert from 'node:assert/strict';
import test from 'node:test';

import {createFalStyleApplicationAdapter} from '../server/style-application-adapter.mjs';
import {createProjectStore} from '../src/project-store.js';
import {createStyleLibrary} from '../src/style-library.js';
import {createTimelineDiffs} from '../src/timeline-diffs.js';
import {
  DEFAULT_STYLE_IMAGE_MODEL,
  DEFAULT_STYLE_TRIM_MODEL,
  DEFAULT_STYLE_VIDEO_MODEL,
  buildStyleApplicationPrompt,
  createStyleApplicationBatch,
  createStyleApplicationController,
  styleApplicationEligibility,
} from '../src/style-application.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const fixture = () => {
  let sequence = 0;
  const storage = new MemoryStorage();
  const store = createProjectStore({
    storage,
    createId: (prefix) => `${prefix}-style-app-${++sequence}`,
    now: () => '2026-07-18T18:00:00.000Z',
  });
  const importAsset = (asset) => store.dispatch({type: 'asset/import', asset}).affectedId;
  const referenceIds = Array.from({length: 5}, (_, index) => importAsset({
    name: `reference-${index + 1}.png`, kind: 'image', mimeType: 'image/png', duration: 5,
    url: `https://assets.example.test/reference-${index + 1}.png`,
  }));
  const videoId = importAsset({
    name: 'source-video.mp4', kind: 'video', mimeType: 'video/mp4', duration: 20,
    url: 'https://assets.example.test/source-video.mp4',
  });
  const imageId = importAsset({
    name: 'source-image.png', kind: 'image', mimeType: 'image/png', duration: 5,
    url: 'https://assets.example.test/source-image.png',
  });
  const library = createStyleLibrary(store);
  const styleId = library.createDraft('Ink wash').affectedId;
  library.recordVersion(styleId, {id: 'ink-v1', referenceAssetIds: referenceIds, modelId: 'local/manual'});
  const videoClipId = store.dispatch({
    type: 'clip/add', assetId: videoId, trackId: 'V1', start: 0, duration: 5,
    provenance: {styleVersionIds: ['ink-v1']},
  }).affectedId;
  const imageClipId = store.dispatch({type: 'clip/add', assetId: imageId, trackId: 'V1', start: 6, duration: 4}).affectedId;
  const longClipId = store.dispatch({type: 'clip/add', assetId: videoId, trackId: 'V1', start: 11, duration: 16}).affectedId;
  const project = store.getProject();
  return {
    storage, store, library, styleId, referenceIds, videoId, imageId, videoClipId, imageClipId, longClipId,
    style: project.styles[0],
    version: project.styles[0].versions[0],
  };
};

test('builds a mixed-media batch with four references and leaves unsupported clips out', () => {
  const data = fixture();
  const project = data.store.getProject();
  const clips = [data.videoClipId, data.imageClipId, data.longClipId]
    .map((clipId) => project.timeline.clips.find((clip) => clip.id === clipId));
  const longClip = clips[2];
  assert.deepEqual(styleApplicationEligibility({
    clip: longClip,
    asset: project.mediaAssets.find((asset) => asset.id === longClip.assetId),
    project,
  }), {eligible: false, reason: 'Kling O3 Edit supports video clips from 3–15 seconds.'});

  const batch = createStyleApplicationBatch({
    project,
    clips,
    style: data.style,
    styleVersion: data.version,
    referenceAssetIds: data.referenceIds,
    prices: {video: 0.1, image: 0.03},
    createId: (() => { let id = 0; return (prefix) => `${prefix}-fixed-${++id}`; })(),
  });
  assert.deepEqual(batch.referenceAssetIds, data.referenceIds.slice(0, 4));
  assert.deepEqual(batch.jobs.map((job) => job.mediaKind), ['video', 'image']);
  assert.equal(batch.jobs[0].estimatedUsd, 0.5);
  assert.equal(batch.jobs[1].estimatedUsd, 0.03);
  assert.match(buildStyleApplicationPrompt({mediaKind: 'video', styleName: 'Ink wash', referenceCount: 2}), /@Video1.*@Image1, @Image2/);
  assert.match(buildStyleApplicationPrompt({mediaKind: 'image', styleName: 'Ink wash', referenceCount: 2}), /Edit @Image1.*@Image2, @Image3/);
});

test('maps trim, Kling O3 Standard, and Nano Banana 2 requests to exact fal schemas', async () => {
  const submissions = [];
  const fal = {
    async submit(modelId, input) { submissions.push({modelId, input}); return {request_id: `request-${submissions.length}`}; },
    async status() { return {status: 'COMPLETED'}; },
    async result() { return {video: {url: 'https://fal.media/result.mp4', content_type: 'video/mp4'}, trimmed_duration: 5}; },
  };
  const adapter = createFalStyleApplicationAdapter({fal});
  assert.equal((await adapter.submitStyleJob({stage: 'trim', input: {videoUrl: 'https://assets.test/video.mp4', startTime: 2, duration: 5}})).modelId, DEFAULT_STYLE_TRIM_MODEL);
  assert.equal((await adapter.submitStyleJob({stage: 'video-style', input: {
    videoUrl: 'https://assets.test/trimmed.mp4', referenceImageUrls: ['https://assets.test/style.png'],
    prompt: 'Restyle @Video1 with @Image1', keepAudio: false,
  }})).modelId, DEFAULT_STYLE_VIDEO_MODEL);
  assert.equal((await adapter.submitStyleJob({stage: 'image-style', input: {
    sourceImageUrl: 'https://assets.test/source.png', referenceImageUrls: ['https://assets.test/style.png'],
    prompt: 'Edit @Image1 with @Image2',
  }})).modelId, DEFAULT_STYLE_IMAGE_MODEL);
  assert.deepEqual(submissions[0].input, {video_url: 'https://assets.test/video.mp4', start_time: 2, duration: 5});
  assert.deepEqual(submissions[1].input, {
    prompt: 'Restyle @Video1 with @Image1', video_url: 'https://assets.test/trimmed.mp4',
    image_urls: ['https://assets.test/style.png'], keep_audio: false, shot_type: 'customize',
  });
  assert.deepEqual(submissions[2].input.image_urls, ['https://assets.test/source.png', 'https://assets.test/style.png']);
  assert.equal(submissions[2].input.resolution, '1K');
  assert.equal((await adapter.getStyleJob({modelId: DEFAULT_STYLE_VIDEO_MODEL, requestId: 'request-2'})).asset.url, 'https://fal.media/result.mp4');
});

test('runs persisted mixed-media jobs independently and lands imports plus replacement ghosts', async () => {
  const data = fixture();
  const diffs = createTimelineDiffs(data.store);
  const project = data.store.getProject();
  const batch = createStyleApplicationBatch({
    project,
    clips: [data.videoClipId, data.imageClipId].map((clipId) => project.timeline.clips.find((clip) => clip.id === clipId)),
    style: data.style,
    styleVersion: data.version,
    referenceAssetIds: data.referenceIds.slice(0, 2),
    createId: (() => { let id = 0; return (prefix) => `${prefix}-${++id}`; })(),
  });
  const requests = new Map();
  let requestId = 0;
  const adapter = {
    async submitStage(stage) {
      const id = `provider-${++requestId}`;
      requests.set(id, stage);
      return {requestId: id, modelId: stage === 'trim' ? DEFAULT_STYLE_TRIM_MODEL : stage === 'video-style' ? DEFAULT_STYLE_VIDEO_MODEL : DEFAULT_STYLE_IMAGE_MODEL};
    },
    async getJob(modelId, id) {
      const stage = requests.get(id);
      return {
        status: 'completed', modelId,
        asset: {url: `https://fal.media/${stage}-${id}.${stage === 'image-style' ? 'png' : 'mp4'}`, mimeType: stage === 'image-style' ? 'image/png' : 'video/mp4', duration: 5},
        cost: {estimatedUsd: 0.01, credits: 1, unit: 'request', quantity: 1, basis: 'reported'},
        source: {provider: 'fal'},
      };
    },
  };
  const persisted = [];
  const controller = createStyleApplicationController({
    store: data.store,
    diffs,
    adapter,
    resolveAssetUrl: async (asset) => asset.url,
    persistAsset: async (assetId) => persisted.push(assetId),
  });
  controller.createBatch(batch);
  assert.equal((await controller.tick()).hasWork, true);
  assert.deepEqual(data.store.getProject().styleApplications.batches[0].jobs.map((job) => job.status), ['trimming', 'generating']);
  assert.equal((await controller.tick()).hasWork, true);
  assert.deepEqual(data.store.getProject().styleApplications.batches[0].jobs.map((job) => job.status), ['generating', 'completed']);
  assert.equal((await controller.tick()).hasWork, false);

  const landed = data.store.getProject();
  assert.equal(landed.styleApplications.batches[0].status, 'completed');
  assert.equal(landed.mediaAssets.length, 9);
  assert.equal(landed.usage.generationCount, 3);
  assert.equal(landed.usage.estimatedUsd, 0.03);
  assert.equal(diffs.listPending().length, 2);
  assert.deepEqual(diffs.listPending().map((diff) => diff.source), ['style-application', 'style-application']);
  assert.deepEqual(new Set(persisted), new Set(landed.styleApplications.batches[0].jobs.map((job) => job.outputAssetId)));
});

test('resumes a persisted provider request after reload', async () => {
  const data = fixture();
  const project = data.store.getProject();
  const batch = createStyleApplicationBatch({
    project,
    clips: [project.timeline.clips.find((clip) => clip.id === data.imageClipId)],
    style: data.style,
    styleVersion: data.version,
    referenceAssetIds: data.referenceIds.slice(0, 1),
    createId: (prefix) => `${prefix}-resume`,
  });
  data.store.dispatch({type: 'style-application/batch-create', batch});
  data.store.dispatch({type: 'style-application/job-update', batchId: batch.id, jobId: batch.jobs[0].id, patch: {
    status: 'generating', stage: 'image-style', providerModelId: DEFAULT_STYLE_IMAGE_MODEL,
    providerRequestId: 'provider-resume', referenceUrls: ['https://assets.example.test/reference-1.png'],
  }});

  const reloadedStore = createProjectStore({storage: data.storage, now: () => '2026-07-18T18:01:00.000Z'});
  const diffs = createTimelineDiffs(reloadedStore);
  const controller = createStyleApplicationController({
    store: reloadedStore,
    diffs,
    adapter: {
      async submitStage() { throw new Error('A resumed provider request must not be resubmitted.'); },
      async getJob(modelId, requestId) {
        assert.equal(modelId, DEFAULT_STYLE_IMAGE_MODEL);
        assert.equal(requestId, 'provider-resume');
        return {status: 'completed', modelId, asset: {url: 'https://fal.media/resumed.png', mimeType: 'image/png'}, source: {provider: 'fal'}};
      },
    },
    resolveAssetUrl: async (asset) => asset.url,
  });
  controller.resume();
  assert.equal((await controller.tick()).hasWork, false);
  assert.equal(reloadedStore.getProject().styleApplications.batches[0].jobs[0].status, 'completed');
  assert.equal(diffs.listPending().length, 1);
});

test('starts no more than three style jobs at once', async () => {
  const data = fixture();
  const clips = [];
  for (let index = 0; index < 4; index += 1) {
    const result = data.store.dispatch({type: 'clip/add', assetId: data.imageId, trackId: 'V1', start: 30 + index * 5, duration: 4});
    clips.push(result.project.timeline.clips.find((clip) => clip.id === result.affectedId));
  }
  const project = data.store.getProject();
  const batch = createStyleApplicationBatch({
    project, clips, style: data.style, styleVersion: data.version, referenceAssetIds: data.referenceIds.slice(0, 1),
  });
  let submissions = 0;
  const controller = createStyleApplicationController({
    store: data.store,
    diffs: createTimelineDiffs(data.store),
    adapter: {
      async submitStage() { submissions += 1; return {requestId: `provider-${submissions}`, modelId: DEFAULT_STYLE_IMAGE_MODEL}; },
      async getJob() { return {status: 'running'}; },
    },
    resolveAssetUrl: async (asset) => asset.url,
  });
  controller.createBatch(batch);
  await controller.tick();
  assert.equal(submissions, 3);
  assert.deepEqual(data.store.getProject().styleApplications.batches.at(-1).jobs.map((job) => job.status), ['generating', 'generating', 'generating', 'queued']);
});

test('blocks deletion during active jobs, then detaches deleted style provenance without deleting media', () => {
  const data = fixture();
  const project = data.store.getProject();
  const batch = createStyleApplicationBatch({
    project,
    clips: [project.timeline.clips.find((clip) => clip.id === data.imageClipId)],
    style: data.style,
    styleVersion: data.version,
    referenceAssetIds: data.referenceIds.slice(0, 1),
  });
  data.store.dispatch({type: 'style-application/batch-create', batch});
  assert.throws(() => data.library.remove(data.styleId), /cannot be deleted while Apply Style jobs are active/);
  data.store.dispatch({type: 'style-application/job-update', batchId: batch.id, jobId: batch.jobs[0].id, patch: {status: 'completed', stage: 'completed'}});
  const assetCount = data.store.getProject().mediaAssets.length;
  data.library.remove(data.styleId);
  const after = data.store.getProject();
  assert.equal(after.styles.length, 0);
  assert.equal(after.mediaAssets.length, assetCount);
  assert.deepEqual(after.timeline.clips.find((clip) => clip.id === data.videoClipId).provenance.styleVersionIds, []);

  const reloaded = createProjectStore({storage: data.storage}).getProject();
  assert.equal(reloaded.styles.length, 0);
  assert.equal(reloaded.styleApplications.batches.length, 1);
});
