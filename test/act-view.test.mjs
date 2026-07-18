import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actForViewTime,
  actOffsets,
  orderedScenes,
  toLocalStart,
  toViewStart,
  visibleAssetIds,
  visibleClips,
} from '../src/act-view.js';

const project = {
  scenes: [
    {id: 'act-3', metadata: {actNumber: 3}},
    {id: 'act-1', metadata: {actNumber: 1}},
    {id: 'act-2', metadata: {actNumber: 2}},
  ],
  mediaAssets: [
    {id: 'global', sceneId: null},
    {id: 'one', sceneId: 'act-1'},
    {id: 'two', sceneId: 'act-2'},
    {id: 'legacy-reference', sceneId: 'act-1'},
  ],
  timeline: {
    clips: [
      {id: 'one-a', assetId: 'one', sceneId: 'act-1', trackId: 'V1', start: 1, duration: 4},
      {id: 'one-b', assetId: 'global', sceneId: 'act-1', trackId: 'A1', start: 0, duration: 2},
      {id: 'two-a', assetId: 'two', sceneId: 'act-2', trackId: 'V1', start: 0, duration: 3},
      {id: 'two-b', assetId: 'legacy-reference', sceneId: 'act-2', trackId: 'A1', start: 1, duration: 1},
    ],
  },
};

test('orders acts, computes offsets, and projects all-view clip starts', () => {
  assert.deepEqual(orderedScenes(project).map((scene) => scene.id), ['act-1', 'act-2', 'act-3']);
  const offsets = actOffsets(project);
  assert.deepEqual([...offsets], [['act-1', 0], ['act-2', 5], ['act-3', 8]]);
  assert.equal(actOffsets(project), offsets);

  const all = visibleClips(project, 'all');
  assert.equal(all.find((clip) => clip.id === 'one-a').start, 1);
  assert.equal(all.find((clip) => clip.id === 'two-a').start, 5);
  assert.equal(all.find((clip) => clip.id === 'two-b').start, 6);
  assert.equal(project.timeline.clips.find((clip) => clip.id === 'two-a').start, 0);

  assert.deepEqual(visibleClips(project, 'act-2').map((clip) => clip.id), ['two-a', 'two-b']);
});

test('maps edits between concatenated and act-local time', () => {
  assert.equal(toViewStart(project, 'all', 'act-2', 2.5), 7.5);
  assert.equal(toLocalStart(project, 'all', 'act-2', 7.5), 2.5);
  assert.equal(toLocalStart(project, 'act-2', 'act-2', 2.5), 2.5);
  assert.equal(toLocalStart(project, 'all', 'act-2', 3), 0);
  assert.equal(actForViewTime(project, 4.9), 'act-1');
  assert.equal(actForViewTime(project, 5), 'act-2');
  assert.equal(actForViewTime(project, 99), 'act-3');
});

test('act media includes globals and every asset referenced by its clips', () => {
  assert.deepEqual([...visibleAssetIds(project, 'act-2')].sort(), ['global', 'legacy-reference', 'two']);
  assert.deepEqual([...visibleAssetIds(project, 'all')].sort(), ['global', 'legacy-reference', 'one', 'two']);
});
