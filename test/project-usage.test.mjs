import assert from 'node:assert/strict';
import test from 'node:test';

import {createProjectStore} from '../src/project-store.js';
import {createProjectFalUsageEntry, recordProjectFalUsage} from '../src/project-usage.js';

test('normalizes reported FAL costs and ignores non-FAL work', () => {
  const entry = createProjectFalUsageEntry({
    id: 'screenplay-act-1',
    provider: 'fal',
    modelId: 'google/gemini-2.5-flash',
    operation: 'storyboard-screenplay',
    usage: {cost: 0.0042},
    now: () => '2026-07-19T12:00:00.000Z',
  });
  assert.deepEqual(entry, {
    id: 'usage-screenplay-act-1',
    generationJobId: 'screenplay-act-1',
    modelId: 'google/gemini-2.5-flash',
    qualityTier: 'final',
    estimatedUsd: 0.0042,
    credits: 0.42,
    unit: 'generation',
    quantity: 1,
    currency: 'USD',
    costBasis: 'reported',
    createdAt: '2026-07-19T12:00:00.000Z',
    operation: 'storyboard-screenplay',
  });
  assert.equal(createProjectFalUsageEntry({provider: 'local-fake', modelId: 'local/fake', cost: 1}), null);
});

test('adds every completed FAL call to the current project total idempotently', () => {
  const store = createProjectStore({storage: null, now: () => '2026-07-19T12:00:00.000Z'});
  const dispatch = (command) => store.dispatch(command);
  const first = {
    dispatch,
    id: 'storyboard-still-job-1',
    generationJobId: 'job-1',
    provider: 'fal',
    modelId: 'fal-ai/nano-banana-2',
    operation: 'storyboard-still',
    cost: {estimatedUsd: 0.08, basis: 'historical-api-price'},
  };
  assert.equal(recordProjectFalUsage(first).changed, true);
  assert.equal(recordProjectFalUsage(first).changed, false);
  assert.equal(recordProjectFalUsage({
    dispatch,
    id: 'background-score-job-2',
    generationJobId: 'job-2',
    provider: 'fal',
    modelId: 'fal-ai/elevenlabs/music',
    operation: 'background-score',
    cost: {estimatedUsd: 0.24, basis: 'historical-api-price'},
  }).changed, true);
  assert.equal(store.getProject().usage.estimatedUsd, 0.32);
  assert.equal(store.getProject().usage.generationCount, 2);
  assert.deepEqual(store.getProject().usage.entries.map((entry) => entry.operation), [
    'storyboard-still',
    'background-score',
  ]);
});
