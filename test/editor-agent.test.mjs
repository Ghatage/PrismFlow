import assert from 'node:assert/strict';
import test from 'node:test';

import {AgentCancelledError, runEditorAgent} from '../src/editor-agent.js';

const assistantToolCall = (id, name, args) => ({
  choices: [{message: {role: 'assistant', content: null, tool_calls: [
    {id, type: 'function', function: {name, arguments: JSON.stringify(args)}},
  ]}}],
});

const assistantText = (content) => ({choices: [{message: {role: 'assistant', content}}]});

const makeTools = (log) => ({
  definitions: [{type: 'function', function: {name: 'split_clip'}}],
  execute: async (name, args) => {
    log.push({name, args});
    return name === 'boom' ? {error: 'exploded'} : {ok: true, affectedId: 'clip-2'};
  },
});

test('executes tool calls, feeds results back, and returns the final summary', async () => {
  const executed = [];
  const scripted = [
    assistantToolCall('call-1', 'split_clip', {clipId: 'clip-1', time: 5}),
    assistantText('Split the clip at 5s.'),
  ];
  const seenMessages = [];
  const steps = [];

  const result = await runEditorAgent({
    prompt: 'Split the first clip.',
    tools: makeTools(executed),
    callLlm: async ({messages}) => {
      seenMessages.push(messages.map((message) => message.role).join(','));
      return scripted.shift();
    },
    onStep: (step) => { steps.push(step); return step; },
  });

  assert.equal(result.summary, 'Split the clip at 5s.');
  assert.equal(result.iterations, 2);
  assert.deepEqual(executed, [{name: 'split_clip', args: {clipId: 'clip-1', time: 5}}]);
  assert.equal(seenMessages[0], 'system,user');
  assert.equal(seenMessages[1], 'system,user,assistant,tool');
  assert.equal(steps.filter((step) => step.type === 'tool').at(-1).status, 'done');
  assert.equal(steps.at(-1).type, 'result');
});

test('tool errors are surfaced to the model and the loop continues', async () => {
  const executed = [];
  const scripted = [
    assistantToolCall('call-1', 'boom', {}),
    assistantText('That failed; done.'),
  ];
  const toolMessages = [];
  const steps = [];

  await runEditorAgent({
    prompt: 'x',
    tools: {definitions: [], execute: async (name) => ({error: `no such tool ${name}`})},
    callLlm: async ({messages}) => {
      toolMessages.push(...messages.filter((message) => message.role === 'tool'));
      return scripted.shift();
    },
    onStep: (step) => { steps.push(step); return step; },
  });

  assert.match(toolMessages[0].content, /no such tool boom/);
  assert.equal(steps.filter((step) => step.type === 'tool').at(-1).status, 'error');
});

test('malformed tool arguments become an error result without executing', async () => {
  let executions = 0;
  const scripted = [
    {choices: [{message: {role: 'assistant', content: null, tool_calls: [
      {id: 'call-1', type: 'function', function: {name: 'split_clip', arguments: '{not json'}},
    ]}}]},
    assistantText('done'),
  ];
  const toolMessages = [];

  await runEditorAgent({
    prompt: 'x',
    tools: {definitions: [], execute: async () => { executions += 1; return {ok: true}; }},
    callLlm: async ({messages}) => {
      toolMessages.push(...messages.filter((message) => message.role === 'tool'));
      return scripted.shift();
    },
  });

  assert.equal(executions, 0);
  assert.match(toolMessages[0].content, /not valid JSON/);
});

test('stops at maxIterations with a capped summary', async () => {
  const result = await runEditorAgent({
    prompt: 'x',
    tools: {definitions: [], execute: async () => ({ok: true})},
    callLlm: async () => assistantToolCall('call-n', 'split_clip', {}),
    maxIterations: 3,
  });
  assert.equal(result.capped, true);
  assert.equal(result.iterations, 3);
  assert.match(result.summary, /3-step limit/);
});

test('aborting throws AgentCancelledError', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runEditorAgent({
      prompt: 'x',
      tools: {definitions: [], execute: async () => ({ok: true})},
      callLlm: async () => assistantText('never'),
      signal: controller.signal,
    }),
    AgentCancelledError,
  );
});

test('llm failures propagate and fetch aborts map to cancellation', async () => {
  await assert.rejects(
    runEditorAgent({
      prompt: 'x',
      tools: {definitions: [], execute: async () => ({})},
      callLlm: async () => { throw new Error('llm request failed (500): down'); },
    }),
    /llm request failed/,
  );

  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  await assert.rejects(
    runEditorAgent({
      prompt: 'x',
      tools: {definitions: [], execute: async () => ({})},
      callLlm: async () => { throw abortError; },
    }),
    AgentCancelledError,
  );
});
