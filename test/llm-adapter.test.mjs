import assert from 'node:assert/strict';
import test from 'node:test';

import {createLlmAdapter} from '../server/llm-adapter.mjs';

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  text: async () => JSON.stringify(payload),
});

test('reports configured only when a base url is present', () => {
  assert.equal(createLlmAdapter({baseUrl: '', apiKey: 'k'}).configured, false);
  assert.equal(createLlmAdapter({baseUrl: 'http://localhost:11434/v1'}).configured, true);
});

test('posts to normalized chat completions url with bearer auth and model', async () => {
  const calls = [];
  const adapter = createLlmAdapter({
    baseUrl: 'http://localhost:11434/v1/',
    apiKey: 'secret',
    model: 'llama3',
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return jsonResponse(200, {choices: [{message: {role: 'assistant', content: 'hi'}}]});
    },
  });

  const result = await adapter.chat({messages: [{role: 'user', content: 'hello'}], temperature: 0.2});

  assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'llama3');
  assert.equal(body.temperature, 0.2);
  assert.equal(body.messages[0].content, 'hello');
  assert.equal(result.choices[0].message.content, 'hi');
});

test('keeps an explicit chat/completions base url and the server-configured model', async () => {
  const calls = [];
  const adapter = createLlmAdapter({
    baseUrl: 'https://example.test/v1/chat/completions',
    apiKey: 'k',
    model: 'default-model',
    fetchImpl: async (url, options) => {
      calls.push({url, options});
      return jsonResponse(200, {choices: []});
    },
  });

  await adapter.chat({messages: [{role: 'user', content: 'x'}], model: 'override', tools: [{type: 'function'}]});

  assert.equal(calls[0].url, 'https://example.test/v1/chat/completions');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'default-model');
  assert.equal(body.tools.length, 1);
});

test('surfaces upstream errors with status and detail', async () => {
  const adapter = createLlmAdapter({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    fetchImpl: async () => jsonResponse(401, {error: {message: 'bad key'}}),
  });
  await assert.rejects(
    adapter.chat({messages: [{role: 'user', content: 'x'}]}),
    /llm request failed \(401\): bad key/,
  );
});

test('rejects when unconfigured or messages missing', async () => {
  const unconfigured = createLlmAdapter({baseUrl: ''});
  await assert.rejects(unconfigured.chat({messages: [{role: 'user', content: 'x'}]}), /LLM_BASE_URL/);
  const adapter = createLlmAdapter({baseUrl: 'https://example.test/v1', fetchImpl: async () => jsonResponse(200, {})});
  await assert.rejects(adapter.chat({messages: []}), /non-empty array/);
});
