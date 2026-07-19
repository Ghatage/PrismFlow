import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyStillContextSettings,
  buildStillContextItems,
  normalizeStillContextSettings,
} from '../src/still-context.js';

const context = () => ({
  project: {id: 'project-one', name: 'Harbor Story', metadata: {aspectRatio: '16:9'}},
  narrative: {title: 'The Story Circle', tagline: 'you need go search', notes: ['Return changed.']},
  act: {id: 'act-one', actNumber: 1, title: 'Departure', summary: 'Pip leaves home.'},
  storySoFar: [{
    id: 'act-prologue', actNumber: 0, title: 'Prologue', summary: 'The bell sleeps.',
    beats: [{id: 'beat-old', text: 'The harbor bell rings.', screenplay: 'PIP: I hear it.'}],
  }],
  target: {id: 'beat-target', text: 'Pip enters a neon observatory.', screenplay: 'PIP: The stars are maps.'},
  characters: [
    {id: 'pip', name: 'Pip', versionId: 'pip-v2', sheetAssetId: 'sheet-pip', prompt: 'A small grey mouse', mentioned: true},
    {id: 'mara', name: 'Mara', versionId: 'mara-v1', sheetAssetId: 'sheet-mara', prompt: 'A sailor in red', mentioned: false},
  ],
  style: {bible: 'Hand-painted harbor animation.', referenceAssetIds: ['style-one', 'style-two']},
  previousStill: {beatId: 'beat-old', assetId: 'still-old'},
});

test('still context items expose prompts, references, history, and the previous still', () => {
  const items = buildStillContextItems(context());
  const byId = new Map(items.map((item) => [item.id, item]));

  assert.equal(byId.get('target:screenplay').text, 'PIP: The stars are maps.');
  assert.equal(byId.get('story:act-prologue:beat-old:screenplay').text, 'PIP: I hear it.');
  assert.equal(byId.get('character:pip').assetId, 'sheet-pip');
  assert.equal(byId.get('style-reference:style-one').assetId, 'style-one');
  assert.equal(byId.get('previous-still').assetId, 'still-old');
  assert.ok(items.every((item) => item.included));
});

test('hidden items stay in the editable list but are removed from generated still context', () => {
  const source = context();
  const settings = normalizeStillContextSettings({
    hiddenItemIds: [
      'story:act-prologue:beat-old:screenplay',
      'character:mara',
      'style-reference:style-one',
      'previous-still',
    ],
    overrides: {
      'target:beat': 'Pip floats inside a zero-gravity glass observatory.',
      'target:screenplay': 'PIP: Every star points home.',
      'character:pip': 'A tiny grey mouse in a silver pressure suit',
    },
  });

  const items = buildStillContextItems(source, settings);
  assert.equal(items.find((item) => item.id === 'previous-still').included, false);
  assert.equal(items.find((item) => item.id === 'target:screenplay').text, 'PIP: Every star points home.');

  const applied = applyStillContextSettings(source, settings);
  assert.equal(applied.target.text, 'Pip floats inside a zero-gravity glass observatory.');
  assert.equal(applied.target.screenplay, 'PIP: Every star points home.');
  assert.deepEqual(applied.characters.map(({id, prompt}) => ({id, prompt})), [
    {id: 'pip', prompt: 'A tiny grey mouse in a silver pressure suit'},
  ]);
  assert.deepEqual(applied.style.referenceAssetIds, ['style-two']);
  assert.equal(applied.previousStill, null);
  assert.equal(applied.storySoFar[0].beats[0].screenplay, '');

  // Context choices never mutate or delete the canonical beat metadata.
  assert.equal(source.target.text, 'Pip enters a neon observatory.');
  assert.equal(source.characters.length, 2);
  assert.equal(source.previousStill.assetId, 'still-old');
});
