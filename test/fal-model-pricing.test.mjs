import assert from 'node:assert/strict';
import test from 'node:test';

import {createFalModelPricingAdapter} from '../server/model-pricing.mjs';

const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Bad Request',
  text: async () => JSON.stringify(payload),
});

test('paginates FAL models, batches pricing, and joins prices by endpoint', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    requests.push({url: parsed, options});
    if (parsed.pathname === '/v1/models') {
      if (parsed.searchParams.get('cursor') === 'page-2') {
        return response({
          models: [{endpoint_id: 'fal-ai/third', metadata: {status: 'deprecated'}}],
          next_cursor: null,
          has_more: false,
        });
      }
      return response({
        models: [
          {endpoint_id: 'fal-ai/first', metadata: {category: 'text-to-image'}},
          {endpoint_id: 'fal-ai/second', metadata: {category: 'image-to-video'}},
        ],
        next_cursor: 'page-2',
        has_more: true,
      });
    }
    assert.equal(parsed.pathname, '/v1/models/pricing');
    assert.deepEqual(parsed.searchParams.getAll('endpoint_id'), ['fal-ai/first', 'fal-ai/second', 'fal-ai/third']);
    assert.equal(parsed.searchParams.get('cursor'), null);
    assert.equal(options.headers.Authorization, 'Key test-key');
    return response({
      prices: [
        {endpoint_id: 'fal-ai/first', unit_price: 0.025, unit: 'image', currency: 'USD'},
        {endpoint_id: 'fal-ai/third', unit_price: 0.2, unit: 'video_second', currency: 'USD'},
      ],
      next_cursor: null,
      has_more: false,
    });
  };

  const result = await createFalModelPricingAdapter({apiKey: 'test-key', fetchImpl}).sync();

  assert.equal(requests.length, 3);
  assert.equal(result.modelCount, 3);
  assert.equal(result.priceCount, 2);
  assert.deepEqual(result.records.map(({endpointId}) => endpointId), [
    'fal-ai/first',
    'fal-ai/second',
    'fal-ai/third',
  ]);
  assert.equal(result.records[0].prices[0].unit_price, 0.025);
  assert.deepEqual(result.records[1].prices, []);
  assert.equal(result.records[2].prices[0].unit, 'video_second');
  assert.match(result.syncedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('fails before making a request when the FAL key is missing', async () => {
  const adapter = createFalModelPricingAdapter({apiKey: '', fetchImpl: async () => response({})});
  await assert.rejects(() => adapter.sync(), /FAL_ADMIN_KEY or FAL_API_KEY is not configured/);
});

test('skips unpriced endpoints when a pricing batch contains a missing endpoint', async () => {
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/models') {
      return response({
        models: [{endpoint_id: 'fal-ai/valid'}, {endpoint_id: 'fal-ai/missing'}],
        next_cursor: null,
        has_more: false,
      });
    }
    const endpointIds = parsed.searchParams.getAll('endpoint_id');
    if (endpointIds.includes('fal-ai/missing')) return response({message: 'Endpoint(s) not found'}, 404);
    return response({
      prices: [{endpoint_id: 'fal-ai/valid', unit_price: 0.01, unit: 'image', currency: 'USD'}],
      next_cursor: null,
      has_more: false,
    });
  };

  const result = await createFalModelPricingAdapter({apiKey: 'test-key', fetchImpl}).sync();

  assert.equal(result.modelCount, 2);
  assert.equal(result.records[0].prices.length, 1);
  assert.deepEqual(result.records[1].prices, []);
});
