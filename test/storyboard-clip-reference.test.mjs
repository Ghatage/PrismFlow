import assert from 'node:assert/strict';
import test from 'node:test';

import {storyboardReferenceForClip} from '../src/storyboard-clip-reference.js';

const project = () => ({
  mediaAssets: [
    {id: 'still-current', name: 'Current beat still', kind: 'image'},
    {id: 'still-original', name: 'Original beat still', kind: 'image'},
    {id: 'video-source', name: 'Generated video', kind: 'video'},
  ],
  storyboard: {nodes: [{
    id: 'act-one', kind: 'act', actNumber: 1, title: 'Departure',
    beats: [{id: 'beat-one', text: 'Pip enters the observatory.', hero: {assetId: 'still-current'}}],
  }]},
});

const clip = () => ({
  id: 'clip-one',
  assetId: 'video-source',
  provenance: {
    params: {storyboardActId: 'act-one', storyboardBeatId: 'beat-one'},
    parentAssetIds: ['video-source', 'still-original'],
  },
});

test('timeline regeneration resolves the current still from its linked storyboard beat', () => {
  assert.deepEqual(storyboardReferenceForClip(project(), clip()), {
    assetId: 'still-current',
    source: 'beat',
    actId: 'act-one',
    beatId: 'beat-one',
    label: 'Departure · Pip enters the observatory.',
  });
});

test('timeline regeneration falls back to an image parent when the linked beat still is unavailable', () => {
  const input = project();
  input.storyboard.nodes[0].beats[0].hero = null;
  assert.deepEqual(storyboardReferenceForClip(input, clip()), {
    assetId: 'still-original',
    source: 'provenance',
    actId: 'act-one',
    beatId: 'beat-one',
    label: 'Original beat still',
  });
});

test('timeline regeneration does not mistake a video parent for the beat still', () => {
  const input = project();
  input.storyboard = null;
  input.mediaAssets = input.mediaAssets.filter((asset) => asset.id !== 'still-original');
  assert.equal(storyboardReferenceForClip(input, clip()), null);
});
