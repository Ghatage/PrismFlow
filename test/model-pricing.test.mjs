import assert from 'node:assert/strict';
import test from 'node:test';

import {syncModelPricing} from '../src/model-pricing.js';

test('browser sync script sends the server response into IndexedDB storage', async () => {
  let request;
  let storedRecords;
  const database = {
    async replaceModelPricing(records) {
      storedRecords = records;
    },
  };
  const payload = {
    records: [{id: 'fal-ai/flux/dev', endpointId: 'fal-ai/flux/dev', prices: []}],
    modelCount: 1,
    priceCount: 0,
    syncedAt: '2026-07-16T20:00:00.000Z',
  };

  const result = await syncModelPricing({
    database,
    status: 'active',
    fetchImpl: async (url, options) => {
      request = {url, options};
      return {
        ok: true,
        status: 200,
        json: async () => payload,
      };
    },
  });

  assert.equal(request.url, '/api/fal/model-pricing?status=active');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(storedRecords, payload.records);
  assert.deepEqual(result, payload);
});
