import assert from 'node:assert/strict';
import test from 'node:test';

import {createAgentRunStore} from '../src/agent-runs.js';

const makeStore = () => {
  let id = 0;
  return createAgentRunStore({
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => '2026-07-17T15:00:00.000Z',
  });
};

test('creates runs and records steps through the lifecycle', () => {
  const store = makeStore();
  let notified = 0;
  store.subscribe(() => { notified += 1; });

  const run = store.create({prompt: 'Split the first clip.', clipContext: [{clipId: 'clip-1'}]});
  assert.equal(run.status, 'running');
  assert.deepEqual(run.clipContext, [{clipId: 'clip-1'}]);
  assert.equal(store.list().length, 1);

  const step = store.appendStep(run.id, {type: 'tool', name: 'split_clip', args: {clipId: 'clip-1'}, status: 'running'});
  store.updateStep(run.id, step.id, {status: 'done', result: {ok: true}});
  store.setStatus(run.id, 'completed', {summary: 'Split done.'});

  const saved = store.get(run.id);
  assert.equal(saved.steps.length, 1);
  assert.equal(saved.steps[0].result.ok, true);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.summary, 'Split done.');
  assert.ok(notified >= 4);
});

test('cancel aborts the registered controller for running runs only', () => {
  const store = makeStore();
  const run = store.create({prompt: 'Trim things.'});
  const controller = new AbortController();
  store.registerAbort(run.id, controller);

  store.cancel(run.id);
  assert.equal(controller.signal.aborted, true);

  store.setStatus(run.id, 'cancelled');
  const second = new AbortController();
  store.cancel(run.id);
  assert.equal(second.signal.aborted, false);
});

test('rejects empty prompts, unknown runs, and invalid statuses', () => {
  const store = makeStore();
  assert.throws(() => store.create({prompt: '  '}), /Agent prompt is required/);
  assert.throws(() => store.appendStep('nope', {}), /Unknown agent run/);
  const run = store.create({prompt: 'ok'});
  assert.throws(() => store.updateStep(run.id, 'nope', {}), /Unknown agent step/);
  assert.throws(() => store.setStatus(run.id, 'paused'), /Invalid agent run status/);
});
