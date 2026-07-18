import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findMentions,
  resolveMentionedVersions,
  expandMentionPrompt,
  imageInputFor,
} from '../src/prompt-mentions.js';

const character = (id, name, versions = []) => ({
  id,
  name,
  status: versions.length ? 'ready' : 'draft',
  lockedVersionId: null,
  activeVersionId: null,
  versions,
});

const version = (id, overrides = {}) => ({
  id,
  sheetAssetId: `asset-${id}`,
  prompt: `prompt for ${id}`,
  ...overrides,
});

test('findMentions matches names case-insensitively and longest-first', () => {
  const characters = [
    character('character-1', 'Iron Fox'),
    character('character-2', 'Iron Fox Junior'),
  ];
  const mentions = findMentions('Show @iron fox junior beside @Iron Fox.', characters);
  assert.deepEqual(
    mentions.map((mention) => mention.characterId),
    ['character-2', 'character-1']
  );
});

test('findMentions does not match inside longer words and requires a boundary', () => {
  const characters = [character('character-1', 'Fox')];
  assert.equal(findMentions('email me @Foxtrot', characters).length, 0);
  assert.equal(findMentions('say hi to @Fox!', characters).length, 1);
});

test('findMentions resolves renamed characters through the mention map', () => {
  const characters = [character('character-1', 'New Name')];
  const mentions = findMentions('walk with @Old Name today', characters, {'Old Name': 'character-1'});
  assert.deepEqual(mentions, [{characterId: 'character-1', name: 'Old Name', start: 10, end: 19}]);
});

test('findMentions prefers the mention map on name collisions', () => {
  const characters = [character('character-1', 'Fox'), character('character-2', 'Fox')];
  const withMap = findMentions('@Fox runs', characters, {Fox: 'character-2'});
  assert.equal(withMap[0].characterId, 'character-2');
  const withoutMap = findMentions('@Fox runs', characters);
  assert.equal(withoutMap[0].characterId, 'character-1');
});

test('resolveMentionedVersions picks locked over active over latest', () => {
  const locked = {
    ...character('character-1', 'Fox', [version('v1'), version('v2'), version('v3')]),
    lockedVersionId: 'v1',
    activeVersionId: 'v2',
  };
  const active = {
    ...character('character-2', 'Owl', [version('v4'), version('v5')]),
    activeVersionId: 'v4',
  };
  const latest = character('character-3', 'Bear', [version('v6'), version('v7')]);
  const project = {characters: [locked, active, latest]};
  const {resolved, unresolved} = resolveMentionedVersions({
    text: '@Fox and @Owl and @Bear',
    project,
  });
  assert.equal(unresolved.length, 0);
  assert.deepEqual(
    resolved.map((entry) => entry.versionId),
    ['v1', 'v4', 'v7']
  );
  assert.equal(resolved[0].sheetAssetId, 'asset-v1');
});

test('resolveMentionedVersions reports characters without versions and dedupes repeats', () => {
  const project = {
    characters: [character('character-1', 'Fox', [version('v1')]), character('character-2', 'Owl')],
  };
  const {resolved, unresolved} = resolveMentionedVersions({
    text: '@Fox meets @Owl then @Fox leaves',
    project,
  });
  assert.equal(resolved.length, 1);
  assert.deepEqual(unresolved, [{characterId: 'character-2', name: 'Owl'}]);
});

test('expandMentionPrompt appends one block per character and skips empty prompts', () => {
  const expanded = expandMentionPrompt({
    text: 'A duel at dawn with @Fox and @Owl.  ',
    resolved: [
      {characterName: 'Fox', prompt: 'a red fox in a bomber jacket'},
      {characterName: 'Owl', prompt: '   '},
    ],
  });
  assert.equal(
    expanded,
    'A duel at dawn with @Fox and @Owl.\n\nCharacter reference — Fox: a red fox in a bomber jacket'
  );
});

test('expandMentionPrompt returns text unchanged with no usable prompts', () => {
  assert.equal(expandMentionPrompt({text: 'plain', resolved: []}), 'plain');
});

test('imageInputFor reads the model inputs map', () => {
  const modelInputs = {
    'fal-ai/nano-banana-2/edit': {imageKey: 'image_urls', imageKeyIsArray: true, hasPrompt: true},
    'fal-ai/kling-video/v2.5-turbo/pro/image-to-video': {imageKey: 'image_url', imageKeyIsArray: false, hasPrompt: true},
    'fal-ai/veo3.1/fast': {imageKey: null, imageKeyIsArray: false, hasPrompt: true},
  };
  assert.deepEqual(imageInputFor('fal-ai/nano-banana-2/edit', modelInputs), {key: 'image_urls', isArray: true});
  assert.deepEqual(imageInputFor('fal-ai/kling-video/v2.5-turbo/pro/image-to-video', modelInputs), {
    key: 'image_url',
    isArray: false,
  });
  assert.equal(imageInputFor('fal-ai/veo3.1/fast', modelInputs), null);
  assert.equal(imageInputFor('unknown/model', modelInputs), null);
  assert.equal(imageInputFor('unknown/model', undefined), null);
});
