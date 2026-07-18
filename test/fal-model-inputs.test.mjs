import test from 'node:test';
import assert from 'node:assert/strict';
import {extractModelInputs} from '../scripts/build-fal-model-inputs.mjs';

const openapiDoc = (inputName, properties) => ({
  openapi: '3.0.4',
  paths: {
    ['/fal-ai/some-model']: {
      post: {
        requestBody: {
          content: {'application/json': {schema: {$ref: `#/components/schemas/${inputName}`}}},
        },
      },
    },
  },
  components: {
    schemas: {
      [inputName]: {type: 'object', properties},
      SomeModelOutput: {type: 'object', properties: {video: {type: 'object'}}},
    },
  },
});

test('extracts singular image_url input from the requestBody schema', () => {
  const doc = openapiDoc('KlingImageToVideoInput', {
    prompt: {type: 'string'},
    image_url: {type: 'string'},
    duration: {type: 'string'},
  });
  assert.deepEqual(extractModelInputs(doc), {
    imageKey: 'image_url',
    imageKeyIsArray: false,
    hasPrompt: true,
  });
});

test('prefers image_urls array over singular image_url', () => {
  const doc = openapiDoc('NanoBananaEditInput', {
    prompt: {type: 'string'},
    image_url: {type: 'string'},
    image_urls: {type: 'array'},
  });
  assert.deepEqual(extractModelInputs(doc), {
    imageKey: 'image_urls',
    imageKeyIsArray: true,
    hasPrompt: true,
  });
});

test('reports text-only models with no image key', () => {
  const doc = openapiDoc('VeoTextToVideoInput', {prompt: {type: 'string'}, duration: {type: 'string'}});
  assert.deepEqual(extractModelInputs(doc), {imageKey: null, imageKeyIsArray: false, hasPrompt: true});
});

test('falls back to an *Input schema when no requestBody ref exists', () => {
  const doc = openapiDoc('SomeInput', {prompt: {type: 'string'}});
  delete doc.paths['/fal-ai/some-model'].post.requestBody;
  assert.deepEqual(extractModelInputs(doc), {imageKey: null, imageKeyIsArray: false, hasPrompt: true});
});

test('returns null for docs without any input schema', () => {
  assert.equal(extractModelInputs({paths: {}, components: {schemas: {}}}), null);
  assert.equal(extractModelInputs(null), null);
});
