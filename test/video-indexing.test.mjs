import assert from 'node:assert/strict';
import test from 'node:test';

import {createVideoFrameIndexer, frameIdFor, snapshotTimes} from '../src/video-indexing.js';

class MemoryVideoDatabase {
  constructor() {
    this.frames = new Map();
    this.manifests = new Map();
  }
  async putVideoFrame(frame) { this.frames.set(frame.id, frame); }
  async getVideoFrames(videoAssetId) { return [...this.frames.values()].filter((frame) => frame.videoAssetId === videoAssetId); }
  async putVideoFrameManifest(manifest) { this.manifests.set(manifest.id, manifest); }
  async getVideoFrameManifest(videoAssetId) { return this.manifests.get(videoAssetId) || null; }
  async listVideoFrameManifests() { return [...this.manifests.values()]; }
}

test('creates first-frame and five-second snapshots', () => {
  assert.deepEqual(snapshotTimes(0), [0]);
  assert.deepEqual(snapshotTimes(12), [0, 5, 10]);
  assert.equal(frameIdFor('video-1', 5), 'video-1@5.000');
});

test('captures, annotates, tags, resumes, and indexes video frames', async () => {
  const database = new MemoryVideoDatabase();
  const calls = [];
  const progress = [];
  const indexer = createVideoFrameIndexer({
    database,
    getProject: () => ({project: {id: 'project-1'}}),
    captureFrame: async (_video, time) => ({blob: new Blob([`frame-${time}`], {type: 'image/jpeg'}), width: 320, height: 180}),
    fetchImpl: async (url, options) => {
      calls.push({url, body: JSON.parse(options.body)});
      if (url === '/api/video/annotate') return new Response(JSON.stringify({annotation: `fox at ${JSON.parse(options.body).time}s`, modelId: 'Xenova/moondream2'}));
      return new Response(JSON.stringify({indexedCount: 3}));
    },
    now: () => '2026-07-17T15:00:00.000Z',
    onProgress: (manifest, frame) => progress.push({manifest, frame}),
  });

  const result = await indexer.run({asset: {id: 'video-1', name: 'fox.mp4', kind: 'video'}, video: {}, duration: 12});
  assert.equal(result.frames.length, 3);
  assert.deepEqual(result.frames.map((frame) => frame.time), [0, 5, 10]);
  assert.equal(database.frames.get('video-1@0.000').videoAssetId, 'video-1');
  assert.equal(database.frames.get('video-1@0.000').annotation, 'fox at 0s');
  assert.equal(database.manifests.get('video-1').status, 'complete');
  assert.equal(progress.at(-1).manifest.status, 'complete');
  assert.equal(progress.at(-1).manifest.indexedCount, 3);
  assert.equal(calls.filter((call) => call.url === '/api/video/annotate').length, 3);
  assert.equal(calls.filter((call) => call.url === '/api/video/index').length, 1);
  assert.equal(calls.find((call) => call.url === '/api/video/index').body.projectId, 'project-1');
});

test('does not re-annotate an already completed interim frame', async () => {
  const database = new MemoryVideoDatabase();
  database.frames.set('video-1@0.000', {
    id: 'video-1@0.000',
    videoAssetId: 'video-1',
    time: 0,
    blob: new Blob(['existing'], {type: 'image/jpeg'}),
    annotation: 'existing annotation',
  });
  let annotationCalls = 0;
  const indexer = createVideoFrameIndexer({
    database,
    getProject: () => ({project: {id: 'project-1'}}),
    captureFrame: async () => { throw new Error('should use saved frame'); },
    fetchImpl: async (url) => {
      if (url === '/api/video/annotate') annotationCalls += 1;
      return new Response(JSON.stringify({indexedCount: 1}));
    },
  });
  await indexer.run({asset: {id: 'video-1', name: 'fox.mp4', kind: 'video'}, video: {}, duration: 0});
  assert.equal(annotationCalls, 0);
});

test('resumes incomplete manifests after a refresh without recapturing saved frames', async () => {
  const database = new MemoryVideoDatabase();
  database.manifests.set('video-2', {
    id: 'video-2',
    videoAssetId: 'video-2',
    videoName: 'river.mp4',
    interval: 5,
    duration: 7,
    frameCount: 2,
    completedCount: 0,
    status: 'partial',
  });
  database.frames.set('video-2@0.000', {
    id: 'video-2@0.000',
    videoAssetId: 'video-2',
    time: 0,
    blob: new Blob(['saved'], {type: 'image/jpeg'}),
    annotation: 'saved first frame',
  });
  let captureCalls = 0;
  let annotationCalls = 0;
  const indexer = createVideoFrameIndexer({
    database,
    getProject: () => ({project: {id: 'project-1'}}),
    captureFrame: async (_video, time) => {
      captureCalls += 1;
      return {blob: new Blob([`frame-${time}`], {type: 'image/jpeg'}), width: 320, height: 180};
    },
    fetchImpl: async (url) => {
      if (url === '/api/video/annotate') annotationCalls += 1;
      return new Response(JSON.stringify({annotation: 'new river frame', modelId: 'Xenova/moondream2'}));
    },
  });
  const previousDocument = globalThis.document;
  globalThis.document = {createElement: () => ({readyState: 1, duration: 7, src: '', removeAttribute() {}, load() {}})};
  try {
    const results = await indexer.resume({assets: [{id: 'video-2', name: 'river.mp4', kind: 'video', url: 'blob:river'}]});
    assert.equal(results.length, 1);
    assert.equal(captureCalls, 1);
    assert.equal(annotationCalls, 1);
    assert.equal(database.manifests.get('video-2').status, 'complete');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('indexes videos with no manifest and repairs completed manifests missing from the server index', async () => {
  const database = new MemoryVideoDatabase();
  database.manifests.set('video-complete', {
    id: 'video-complete',
    videoAssetId: 'video-complete',
    videoName: 'cat.mp4',
    interval: 5,
    duration: 0,
    frameCount: 1,
    completedCount: 1,
    indexedCount: 1,
    status: 'complete',
  });
  database.frames.set('video-complete@0.000', {
    id: 'video-complete@0.000',
    videoAssetId: 'video-complete',
    time: 0,
    blob: new Blob(['saved'], {type: 'image/jpeg'}),
    annotation: 'A black cat on a chair',
  });
  const indexedAssets = [];
  const indexer = createVideoFrameIndexer({
    database,
    getProject: () => ({project: {id: 'project-1'}}),
    captureFrame: async (_video, time) => ({blob: new Blob([`frame-${time}`]), width: 320, height: 180}),
    fetchImpl: async (url, options) => {
      if (url.startsWith('/api/search/video/status')) return new Response(JSON.stringify({assets: []}));
      if (url === '/api/video/annotate') return new Response(JSON.stringify({annotation: 'A new black cat frame'}));
      if (url === '/api/video/index') {
        indexedAssets.push(...JSON.parse(options.body).records.map((record) => record.videoAssetId));
        return new Response(JSON.stringify({indexedCount: indexedAssets.length}));
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  const previousDocument = globalThis.document;
  globalThis.document = {createElement: () => ({readyState: 1, duration: 0, src: '', removeAttribute() {}, load() {}})};
  try {
    const results = await indexer.resume({assets: [
      {id: 'video-complete', name: 'cat.mp4', kind: 'video', duration: 0, url: 'blob:cat'},
      {id: 'video-new', name: 'new-cat.mp4', kind: 'video', duration: 0, url: 'blob:new-cat'},
    ]});
    assert.equal(results.length, 2);
    assert.deepEqual(new Set(indexedAssets), new Set(['video-complete', 'video-new']));
    assert.equal(database.manifests.get('video-new').status, 'complete');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
