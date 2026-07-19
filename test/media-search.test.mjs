import assert from 'node:assert/strict';
import test from 'node:test';

import {searchMediaAssets} from '../src/media-search.js';

const project = {
  mediaAssets: [
    {id: 'cat-still', name: 'concept-01.png', kind: 'image', source: {fileName: 'concept-01.png'}, metadata: {}},
    {id: 'alley-video', name: 'alley.mp4', kind: 'video', source: {fileName: 'alley.mp4'}, metadata: {}},
    {id: 'style-sheet', name: 'look.png', kind: 'image', source: {fileName: 'look.png'}, metadata: {}},
    {id: 'pending-cat', name: 'Generated replacement', kind: 'video', source: {fileName: 'output.mp4'}, metadata: {}},
  ],
  timeline: {clips: [{
    id: 'clip-cat',
    assetId: 'alley-video',
    provenance: {prompt: 'A black cat crosses a moonlit alley', derivedMetadata: {shotDescription: 'Low tracking shot'}},
  }]},
  storyboard: {nodes: [{
    kind: 'act',
    beats: [{
      text: 'The black cat discovers a silver key.',
      hero: {assetId: 'cat-still'},
      stills: [{assetId: 'cat-still', prompt: 'Black cat beside a silver key'}],
    }],
  }]},
  characters: [],
  styles: [{name: 'Noir ink', versions: [{referenceAssetIds: ['style-sheet'], prompt: 'Deep black shadows'}]}],
  timelineDiffs: {items: [{
    id: 'diff-cat',
    summary: 'Review generated replacement',
    operations: [{after: {assetId: 'pending-cat', provenance: {prompt: 'Close-up of a black cat blinking'}}}],
  }]},
};

test('searches import names, clip prompts, and linked beat context', () => {
  const results = searchMediaAssets(project, 'black cat');
  assert.deepEqual(results.map((result) => result.assetId), ['cat-still', 'alley-video', 'pending-cat']);
  assert.equal(results[0].matchLabel, 'Still prompt');
  assert.equal(results[1].matchLabel, 'Generation prompt');
});

test('respects the visible asset scope and searches style metadata', () => {
  const scoped = searchMediaAssets(project, 'black', {assetIds: new Set(['style-sheet'])});
  assert.deepEqual(scoped.map((result) => result.assetId), ['style-sheet']);
  assert.equal(scoped[0].matchLabel, 'Style prompt');
});
