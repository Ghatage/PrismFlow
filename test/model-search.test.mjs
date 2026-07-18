import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

import {
  buildModelSearchCorpus,
  createModelSearchAdapter,
  MODEL_SEARCH_EMBEDDING_MODEL,
} from '../server/model-search.mjs';

const catalog = [
  {
    endpointId: 'fal-ai/nano-banana-2',
    model: {
      metadata: {
        display_name: 'Nano Banana 2',
        category: 'text-to-image',
        description: "Google's latest fast image generation and editing model",
        group: {label: 'Text to Image'},
        model_url: 'https://fal.run/fal-ai/nano-banana-2',
      },
    },
    prices: [{unit_price: 0.08, unit: 'images', currency: 'USD'}],
  },
  {
    endpointId: 'fal-ai/ltx-video',
    model: {
      metadata: {
        display_name: 'LTX Video',
        category: 'text-to-video',
        description: 'Generate video from a text prompt',
        model_url: 'https://fal.run/fal-ai/ltx-video',
      },
    },
    prices: [],
  },
];

const fakeEmbedder = {
  model: MODEL_SEARCH_EMBEDDING_MODEL,
  async embed(texts) {
    return texts.map((text) => /banana|google|image/i.test(text) ? [1, 0] : [0, 1]);
  },
};

test('model search corpus preserves display name, description, type, and derived API URL', () => {
  const [record] = buildModelSearchCorpus(catalog);

  assert.equal(record.displayName, 'Nano Banana 2');
  assert.equal(record.category, 'text-to-image');
  assert.equal(record.text, "Nano Banana 2. Google's latest fast image generation and editing model");
  assert.match(record.embeddingText, /Model type: text to image/);
  assert.equal(record.apiUrl, 'https://fal.ai/models/fal-ai/nano-banana-2/api');
  assert.deepEqual(record.prices, [{unit_price: 0.08, unit: 'images', currency: 'USD'}]);
});

test('model search builds a persisted TinkerBird index and returns semantic matches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prismflow-model-search-'));
  const catalogPath = join(directory, 'catalog.json');
  const indexPath = join(directory, 'index.json');
  await writeFile(catalogPath, JSON.stringify({records: catalog}), 'utf8');

  const search = createModelSearchAdapter({catalogPath, indexPath, embedder: fakeEmbedder});
  const buildStatus = await search.buildIndex();
  assert.equal(buildStatus.recordCount, 2);
  assert.equal(buildStatus.dimensions, 2);

  const persisted = JSON.parse(await readFile(indexPath, 'utf8'));
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.embeddingModel, MODEL_SEARCH_EMBEDDING_MODEL);
  assert.equal(persisted.records[0].displayName, 'Nano Banana 2');
  assert.match(persisted.hnsw.node[0][1].content, /Nano Banana 2/);

  const result = await search.search('Google latest text to image', {limit: 1});
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].endpointId, 'fal-ai/nano-banana-2');
  assert.equal(result.results[0].apiUrl, 'https://fal.ai/models/fal-ai/nano-banana-2/api');
  assert.ok(result.results[0].score > 0.7);
  assert.equal(result.results[0].semanticScore, 1);

  const reloaded = createModelSearchAdapter({catalogPath, indexPath, embedder: fakeEmbedder});
  const reloadedResult = await reloaded.search('Google latest text to image', {limit: 1});
  assert.equal(reloadedResult.results[0].displayName, 'Nano Banana 2');
});

test('model search rejects empty queries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'prismflow-model-search-'));
  const search = createModelSearchAdapter({
    catalogPath: join(directory, 'catalog.json'),
    indexPath: join(directory, 'index.json'),
    embedder: fakeEmbedder,
  });

  await assert.rejects(() => search.search('  '), /non-empty search query/);
});
