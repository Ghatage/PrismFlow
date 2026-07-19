import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

import {createLocalVideoVlmAdapter} from '../server/video-vlm.mjs';
import {createVideoSearchAdapter} from '../server/video-search.mjs';

test('local VLM adapter decodes a frame description without network calls', async () => {
  let calls = 0;
  const tokenizer = (text) => ({input_ids: [text.length]});
  tokenizer.batch_decode = () => ['Question: describe\nAnswer: A fox jumps over a puddle.<|endoftext|>'];
  const adapter = createLocalVideoVlmAdapter({
    modelId: 'fake/moondream',
    loadModel: async () => ({
      processor: async () => ({pixel_values: [1]}),
      tokenizer,
      model: {generate: async () => { calls += 1; return [1]; }},
      RawImage: {fromBlob: async (blob) => ({blob})},
    }),
  });
  const result = await adapter.annotateFrame({
    imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
    prompt: 'Describe this frame.',
  });
  assert.equal(result.annotation, 'A fox jumps over a puddle.');
  assert.equal(result.modelId, 'fake/moondream');
  assert.equal(calls, 1);
});

test('TinkerBird video search persists annotation records and traces frames to videos', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prismflow-video-search-'));
  const embedder = {
    model: 'fake-embedder',
    async embed(texts) {
      return {data: texts.map((text) => {
        const value = String(text).toLowerCase();
        return {embedding: [value.includes('fox') ? 1 : 0, value.includes('puddle') ? 1 : 0, value.includes('city') ? 1 : 0]};
      })};
    },
  };
  const search = createVideoSearchAdapter({indexPath: join(directory, 'video-index.json'), embedder});
  await search.upsert([
    {id: 'video-a@0.000', projectId: 'project-1', videoAssetId: 'video-a', videoName: 'fox.mp4', time: 0, annotation: 'A fox jumps over a puddle', searchText: 'fox.mp4 A fox jumps over a puddle'},
    {id: 'video-b@5.000', projectId: 'project-1', videoAssetId: 'video-b', videoName: 'city.mp4', time: 5, annotation: 'A city street', searchText: 'city.mp4 A city street'},
  ]);
  const result = await search.search('fox puddle', {projectId: 'project-1', limit: 1});
  assert.equal(result.results[0].id, 'video-a@0.000');
  assert.equal(result.results[0].videoAssetId, 'video-a');
  assert.equal(result.results[0].time, 0);
  const reloaded = createVideoSearchAdapter({indexPath: join(directory, 'video-index.json'), embedder});
  assert.equal((await reloaded.search('city', {projectId: 'project-1'})).results[0].videoAssetId, 'video-b');
  assert.deepEqual(await reloaded.status({projectId: 'project-1'}), {
    ready: true,
    model: 'fake-embedder',
    dimensions: 3,
    recordCount: 2,
    videoCount: 2,
    assets: [
      {videoAssetId: 'video-a', frameCount: 1},
      {videoAssetId: 'video-b', frameCount: 1},
    ],
    indexedAt: (await reloaded.status({projectId: 'project-1'})).indexedAt,
    indexPath: join(directory, 'video-index.json'),
  });
  await reloaded.removeVideo('video-a');
  assert.equal((await reloaded.search('fox', {projectId: 'project-1'})).results.length, 0);
});

test('repairs a persisted video index that contains records but no HNSW nodes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prismflow-video-search-repair-'));
  const indexPath = join(directory, 'video-index.json');
  const embedder = {
    model: 'fake-embedder',
    async embed(texts) {
      return {data: texts.map((text) => ({embedding: [String(text).includes('fox') ? 1 : 0, 0]}))};
    },
  };
  await writeFile(indexPath, JSON.stringify({
    schemaVersion: 1,
    embeddingModel: 'fake-embedder',
    dimensions: 0,
    records: [{id: 'video-a@0.000', videoAssetId: 'video-a', videoName: 'fox.mp4', time: 0, annotation: 'A fox', searchText: 'fox.mp4 A fox'}],
    hnsw: {M: 16, efConstruction: 200, levelMax: 0, entryPointId: -1, node: []},
  }));
  const search = createVideoSearchAdapter({indexPath, embedder});
  const result = await search.search('fox');
  assert.equal(result.results[0].videoAssetId, 'video-a');
  const repaired = JSON.parse(await readFile(indexPath, 'utf8'));
  assert.equal(repaired.dimensions, 2);
  assert.equal(repaired.hnsw.node.length, 1);
});
