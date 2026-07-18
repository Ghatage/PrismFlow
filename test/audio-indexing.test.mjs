import assert from 'node:assert/strict';
import test from 'node:test';

import {AUDIO_TRANSCRIPTION_MODEL_ID, createAudioTranscriptionIndexer, segmentIdFor} from '../src/audio-indexing.js';

const audioAsset = (overrides = {}) => ({
  id: 'media-audio-1',
  name: 'shot.mp4 (audio)',
  kind: 'audio',
  duration: 12,
  metadata: {detachedFrom: {assetId: 'media-video-1', clipId: 'clip-1'}},
  ...overrides,
});

const setup = ({transcribe, fetchImpl} = {}) => {
  const calls = [];
  const patches = [];
  const indexer = createAudioTranscriptionIndexer({
    getProject: () => ({project: {id: 'project-1'}}),
    fetchImpl: fetchImpl || (async (url, options) => {
      calls.push({url, body: JSON.parse(options.body)});
      return new Response(JSON.stringify({indexedCount: 2}));
    }),
    transcribe: transcribe || (async () => [
      {start: 0, end: 4.5, text: 'hello there'},
      {start: 4.5, end: 9, text: 'general kenobi'},
    ]),
    decode: async () => ({audioBuffer: {length: 10, numberOfChannels: 1, sampleRate: 16000, getChannelData: () => new Float32Array(10)}}),
    resample: async () => new Float32Array(10),
    updateAsset: (assetId, metadata) => patches.push({assetId, metadata}),
    now: () => '2026-07-18T10:00:00.000Z',
  });
  return {indexer, calls, patches};
};

test('builds stable segment ids', () => {
  assert.equal(segmentIdFor('media-audio-1', 4.5), 'media-audio-1@4.500');
});

test('transcribes, stores metadata, and indexes segments for semantic search', async () => {
  const {indexer, calls, patches} = setup();
  const result = await indexer.run({asset: audioAsset(), blob: new Blob(['wav'])});

  assert.equal(result.transcription.modelId, AUDIO_TRANSCRIPTION_MODEL_ID);
  assert.equal(result.transcription.text, 'hello there general kenobi');
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].id, 'media-audio-1@0.000');
  assert.equal(result.records[0].searchText, 'shot.mp4 (audio). hello there');
  assert.equal(result.records[1].kind, 'audio-transcript');
  assert.equal(result.records[1].videoAssetId, 'media-audio-1');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/video/index');
  assert.equal(calls[0].body.projectId, 'project-1');
  assert.equal(calls[0].body.records.length, 2);

  assert.equal(patches[0].metadata.audioIndex.status, 'transcribing');
  const finalPatch = patches.at(-1);
  assert.equal(finalPatch.metadata.audioIndex.status, 'complete');
  assert.equal(finalPatch.metadata.audioIndex.segmentCount, 2);
  assert.equal(finalPatch.metadata.transcription.segments.length, 2);
});

test('rejects non-audio assets and missing blobs', async () => {
  const {indexer} = setup();
  await assert.rejects(indexer.run({asset: {...audioAsset(), kind: 'video'}, blob: new Blob(['x'])}), /Only audio assets/);
  await assert.rejects(indexer.run({asset: audioAsset()}), /requires the audio blob/);
});

test('marks the asset failed when transcription throws', async () => {
  const {indexer, patches} = setup({transcribe: async () => { throw new Error('model unavailable'); }});
  await assert.rejects(indexer.run({asset: audioAsset(), blob: new Blob(['wav'])}), /model unavailable/);
  assert.equal(patches.at(-1).metadata.audioIndex.status, 'failed');
  assert.match(patches.at(-1).metadata.audioIndex.error, /model unavailable/);
});

test('resume re-runs incomplete detached assets and skips complete ones', async () => {
  const {indexer, calls} = setup();
  const complete = audioAsset({id: 'media-audio-done', metadata: {detachedFrom: {}, audioIndex: {status: 'complete'}}});
  const incomplete = audioAsset({id: 'media-audio-retry', metadata: {detachedFrom: {}, audioIndex: {status: 'failed'}}});
  const untouched = audioAsset({id: 'media-audio-new', metadata: {detachedFrom: {}}});
  const requested = [];
  await indexer.resume({
    assets: [complete, incomplete, untouched, {id: 'media-video-1', kind: 'video'}],
    getBlob: (asset) => { requested.push(asset.id); return new Blob(['wav']); },
  });
  assert.deepEqual(requested, ['media-audio-retry']);
  assert.equal(calls.length, 1);
});
