import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildNanoBananaCharacterRequest,
  createFalCharacterSheetAdapter,
  NANO_BANANA_2_EDIT_MODEL_ID,
  NANO_BANANA_2_MODEL_ID,
} from '../server/character-sheet-adapter.mjs';
import {createFalAdapter} from '../server/fal-adapter.mjs';
import {createServerCharacterGenerationAdapter} from '../src/character-generation.js';

const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {'Content-Type': 'application/json'},
});

test('keeps the FAL key in server-side queue request headers', async () => {
  const requests = [];
  const responses = [
    {request_id: 'queue-job-1'},
    {status: 'IN_PROGRESS'},
    {images: [{url: 'https://fal.media/sheet.png', content_type: 'image/png'}]},
  ];
  const fal = createFalAdapter({
    apiKey: 'server-secret-key',
    queueOrigin: 'https://queue.example.test',
    fetchImpl: async (url, options) => {
      requests.push({url, options});
      return jsonResponse(responses.shift());
    },
  });

  await fal.submit(NANO_BANANA_2_MODEL_ID, {prompt: 'Character sheet'});
  await fal.status(NANO_BANANA_2_MODEL_ID, 'queue-job-1');
  await fal.result(NANO_BANANA_2_MODEL_ID, 'queue-job-1');

  assert.equal(fal.configured, true);
  assert.deepEqual(requests.map((request) => request.url), [
    'https://queue.example.test/fal-ai/nano-banana-2',
    'https://queue.example.test/fal-ai/nano-banana-2/requests/queue-job-1/status',
    'https://queue.example.test/fal-ai/nano-banana-2/requests/queue-job-1',
  ]);
  assert.ok(requests.every((request) => request.options.headers.Authorization === 'Key server-secret-key'));
  assert.equal(requests[0].options.body.includes('server-secret-key'), false);
});

test('polls queue status and result at the root app id for nested endpoints', async () => {
  const requests = [];
  const responses = [
    {request_id: 'queue-job-2'},
    {status: 'COMPLETED'},
    {video: {url: 'https://fal.media/clip.mp4', content_type: 'video/mp4'}},
  ];
  const fal = createFalAdapter({
    apiKey: 'server-secret-key',
    queueOrigin: 'https://queue.example.test',
    fetchImpl: async (url) => {
      requests.push(url);
      return jsonResponse(responses.shift());
    },
  });

  await fal.submit('fal-ai/veo3.1/fast', {prompt: 'clip'});
  await fal.status('fal-ai/veo3.1/fast', 'queue-job-2');
  await fal.result('fal-ai/veo3.1/fast', 'queue-job-2');

  assert.deepEqual(requests, [
    'https://queue.example.test/fal-ai/veo3.1/fast',
    'https://queue.example.test/fal-ai/veo3.1/requests/queue-job-2/status',
    'https://queue.example.test/fal-ai/veo3.1/requests/queue-job-2',
  ]);
});

test('normalizes Nano Banana 2 text and reference requests server-side', () => {
  const textRequest = buildNanoBananaCharacterRequest({
    name: 'Marlow',
    prompt: 'A friendly fox with a green satchel',
    styleNotes: 'Soft geometric illustration',
  }, 123);
  assert.equal(textRequest.modelId, NANO_BANANA_2_MODEL_ID);
  assert.equal(textRequest.payload.seed, 123);
  assert.equal(textRequest.payload.aspect_ratio, '4:3');
  assert.match(textRequest.payload.prompt, /Character name: Marlow/);
  assert.equal(textRequest.payload.image_urls, undefined);

  const editRequest = buildNanoBananaCharacterRequest({
    name: 'Marlow',
    prompt: 'Keep the same identity',
    referenceUrls: ['blob:http://localhost/private', 'https://assets.example.test/ref.png'],
  }, 456);
  assert.equal(editRequest.modelId, NANO_BANANA_2_EDIT_MODEL_ID);
  assert.deepEqual(editRequest.payload.image_urls, ['https://assets.example.test/ref.png']);
  assert.equal(editRequest.provenance.params.referenceCount, 1);
});

test('maps FAL queue states, results, provenance, and remote failures', async () => {
  const submitted = [];
  const statuses = [
    {status: 'IN_QUEUE'},
    {status: 'IN_PROGRESS'},
    {status: 'COMPLETED'},
  ];
  const fal = {
    configured: true,
    async submit(modelId, payload) {
      submitted.push({modelId, payload});
      return {request_id: 'fal-character-job'};
    },
    async status() {
      return statuses.shift();
    },
    async result() {
      return {
        images: [{
          url: 'https://fal.media/marlow.png',
          content_type: 'image/png',
          file_name: 'marlow.png',
          width: 1024,
          height: 768,
        }],
        description: 'A fox reference sheet',
      };
    },
  };
  const adapter = createFalCharacterSheetAdapter({fal, createSeed: () => 9876});
  const {jobId} = await adapter.submitCharacterSheet({name: 'Marlow', prompt: 'Friendly fox'});
  assert.equal(jobId, 'fal-character-job');
  assert.equal(submitted[0].modelId, NANO_BANANA_2_MODEL_ID);
  assert.deepEqual(await adapter.getCharacterSheetJob(jobId), {status: 'queued'});
  assert.deepEqual(await adapter.getCharacterSheetJob(jobId), {status: 'running'});

  const completed = await adapter.getCharacterSheetJob(jobId);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.modelId, NANO_BANANA_2_MODEL_ID);
  assert.equal(completed.seed, 9876);
  assert.deepEqual(completed.asset, {
    url: 'https://fal.media/marlow.png',
    mimeType: 'image/png',
    width: 1024,
    height: 768,
  });
  assert.deepEqual(completed.source, {
    provider: 'fal',
    jobId: 'fal-character-job',
    modelId: NANO_BANANA_2_MODEL_ID,
    fileName: 'marlow.png',
    description: 'A fox reference sheet',
  });

  const failingFal = {
    ...fal,
    async submit() { return {request_id: 'failed-job'}; },
    async status() { throw new Error('fal queue unavailable'); },
  };
  const failingAdapter = createFalCharacterSheetAdapter({fal: failingFal, createSeed: () => 1});
  await failingAdapter.submitCharacterSheet({name: 'Marlow', prompt: 'Friendly fox'});
  assert.deepEqual(await failingAdapter.getCharacterSheetJob('failed-job'), {
    status: 'failed',
    error: 'fal queue unavailable',
  });
});

test('browser adapter sends only stable character input to local routes', async () => {
  const requests = [];
  const responses = [
    jsonResponse({jobId: 'browser-job'} , 202),
    jsonResponse({status: 'queued'}),
  ];
  const adapter = createServerCharacterGenerationAdapter({
    resolveReferenceUrl: (assetId) => assetId === 'remote-ref' ? 'https://assets.example.test/ref.png' : 'blob:http://localhost/private',
    fetchImpl: async (url, options = {}) => {
      requests.push({url, options});
      return responses.shift();
    },
  });

  assert.deepEqual(await adapter.generateCharacterSheet({
    name: 'Marlow',
    prompt: 'Friendly fox',
    styleNotes: 'Soft shapes',
    referenceAssetIds: ['local-ref', 'remote-ref'],
  }), {jobId: 'browser-job'});
  assert.deepEqual(await adapter.getCharacterSheetJob('browser-job'), {status: 'queued'});

  const body = JSON.parse(requests[0].options.body);
  assert.equal(requests[0].url, '/api/characters/generate');
  assert.equal(requests[1].url, '/api/characters/jobs/browser-job');
  assert.deepEqual(body.referenceAssetIds, ['local-ref', 'remote-ref']);
  assert.deepEqual(body.referenceUrls, ['https://assets.example.test/ref.png']);
  assert.equal(body.modelId, undefined);
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(JSON.stringify(requests).includes('FAL_API_KEY'), false);
});

test('browser adapter converts blob references to uploadable data uris', async () => {
  const requests = [];
  const responses = [jsonResponse({jobId: 'browser-job-2'}, 202)];
  const adapter = createServerCharacterGenerationAdapter({
    resolveReferenceUrl: (assetId) => ({
      'blob-ref': 'blob:http://localhost/sheet',
      'huge-ref': 'blob:http://localhost/huge',
      'remote-ref': 'https://assets.example.test/ref.png',
    })[assetId] || null,
    toUploadableUrl: async (url) => {
      if (url === 'blob:http://localhost/sheet') return 'data:image/png;base64,AAAA';
      if (url === 'blob:http://localhost/huge') throw new Error('Image is too large to send inline.');
      return url;
    },
    fetchImpl: async (url, options = {}) => {
      requests.push({url, options});
      return responses.shift();
    },
  });

  await adapter.generateCharacterSheet({
    name: 'Marlow',
    prompt: 'Friendly fox',
    referenceAssetIds: ['blob-ref', 'huge-ref', 'remote-ref'],
  });
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body.referenceUrls, ['data:image/png;base64,AAAA', 'https://assets.example.test/ref.png']);
});
