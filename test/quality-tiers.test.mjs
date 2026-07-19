import assert from 'node:assert/strict';
import test from 'node:test';

import {createGenerationUsageEntry, estimateGenerationCost, qualitySettingsFor} from '../src/quality-tiers.js';
import {createProjectStore} from '../src/project-store.js';
import {createTimelineDiffs} from '../src/timeline-diffs.js';
import {landGenerationResult, normalizeTimelineGenerationInput} from '../src/timeline-generation.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

test('provides separate draft and final settings with transparent cost estimates', () => {
  assert.deepEqual(qualitySettingsFor('draft'), {resolution: '720p', fps: 24, steps: 20, tier: 'draft'});
  assert.deepEqual(qualitySettingsFor('final'), {resolution: '1080p', fps: 30, steps: 50, tier: 'final'});
  assert.deepEqual(estimateGenerationCost({unitPrice: 0.04, unit: 'image', qualityTier: 'final'}), {
    estimatedUsd: 0.04,
    credits: 4,
    unit: 'image',
    quantity: 1,
    qualityTier: 'final',
  });
  assert.equal(estimateGenerationCost({unitPrice: null}), null);
});

test('normalizes a quality tier into generation input and usage provenance', () => {
  const input = normalizeTimelineGenerationInput({
    operation: 'add',
    prompt: 'A moonlit fox',
    modelId: 'fal-ai/example',
    qualityTier: 'final',
    qualitySettings: {fps: 48},
    unitPrice: 0.02,
  });
  assert.equal(input.qualityTier, 'final');
  assert.deepEqual(input.qualitySettings, {resolution: '1080p', fps: 48, steps: 50, tier: 'final'});
  assert.equal(input.unitPrice, 0.02);
  const usage = createGenerationUsageEntry({job: {jobId: 'job-1', input}, output: {modelId: input.modelId}});
  assert.equal(usage.estimatedUsd, 0.02);
  assert.equal(usage.credits, 2);
  assert.equal(usage.qualityTier, 'final');
});

test('accepts FAL reported numeric costs instead of dropping them from usage', () => {
  const usage = createGenerationUsageEntry({
    job: {jobId: 'fal-reported-job', input: {modelId: 'fal-ai/example'}},
    output: {modelId: 'fal-ai/example', cost: 0.137},
    now: () => '2026-07-19T12:00:00.000Z',
  });
  assert.equal(usage.estimatedUsd, 0.137);
  assert.ok(Math.abs(usage.credits - 13.7) < 1e-9);
  assert.equal(usage.costBasis, 'reported');
});

test('records generation usage idempotently in the project JSON model', () => {
  const store = createProjectStore({storage: new MemoryStorage(), now: () => '2026-07-17T13:00:00.000Z'});
  const entry = {
    id: 'usage-job-1',
    generationJobId: 'job-1',
    modelId: 'fal-ai/example',
    qualityTier: 'draft',
    estimatedUsd: 0.01,
    credits: 1,
    unit: 'image',
    quantity: 1,
  };
  assert.equal(store.dispatch({type: 'usage/record', entry}).changed, true);
  assert.equal(store.dispatch({type: 'usage/record', entry}).changed, false);
  assert.equal(store.getProject().usage.generationCount, 1);
  assert.equal(store.getProject().usage.estimatedUsd, 0.01);
  assert.equal(store.getProject().usage.credits, 1);
});

test('lands priced generation results into a pending diff and usage ledger', () => {
  const store = createProjectStore({storage: new MemoryStorage(), now: () => '2026-07-17T13:00:00.000Z'});
  const assetId = store.dispatch({type: 'asset/import', asset: {name: 'source.png', kind: 'image', mimeType: 'image/png', url: 'https://assets.example.test/source.png'}}).affectedId;
  const diffs = createTimelineDiffs(store);
  const result = landGenerationResult({
    store,
    diffs,
    job: {jobId: 'priced-job', input: {operation: 'add', prompt: 'A fox', modelId: 'fal-ai/example', qualityTier: 'draft', unitPrice: 0.02}},
    output: {asset: {url: 'https://assets.example.test/generated.png', mimeType: 'image/png'}, modelId: 'fal-ai/example'},
  });
  assert.equal(result.changed, true);
  assert.equal(result.usageId, 'usage-priced-job');
  assert.equal(store.getProject().usage.estimatedUsd, 0.01);
  assert.equal(store.getProject().timelineDiffs.items.length, 1);
  assert.equal(store.getProject().timelineDiffs.items[0].operations[0].proposedClip.provenance.qualityTier, 'draft');
  assert.ok(assetId);
});
