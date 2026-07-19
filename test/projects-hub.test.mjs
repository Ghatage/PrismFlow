import assert from 'node:assert/strict';
import test from 'node:test';

import {sortSummaries, summarizeProject} from '../src/projects-hub.js';

const baseProject = {
  schemaVersion: 1,
  updatedAt: '2026-07-18T12:00:00.000Z',
  project: {id: 'project-a', name: 'First light', createdAt: '2026-07-17T09:00:00.000Z', metadata: {}},
  scenes: [{id: 'scene-1'}, {id: 'scene-2'}],
  storyboard: {
    schemaVersion: 2,
    nodes: [
      {kind: 'act', id: 'act-1', beats: [{id: 'beat-1'}, {id: 'beat-2'}]},
      {kind: 'act', id: 'act-2', beats: [{id: 'beat-3'}]},
      {kind: 'note', id: 'note-1'},
    ],
  },
  timeline: {clips: [{id: 'clip-1'}], tracks: [], transitions: []},
};

test('summarizeProject reports identity, counts, and storyboard presence', () => {
  const summary = summarizeProject(baseProject);
  assert.deepEqual(summary, {
    id: 'project-a',
    name: 'First light',
    createdAt: '2026-07-17T09:00:00.000Z',
    updatedAt: '2026-07-18T12:00:00.000Z',
    sceneCount: 2,
    beatCount: 3,
    clipCount: 1,
    hasStoryboard: true,
  });
});

test('summarizeProject tolerates a pristine project with nothing in it', () => {
  const summary = summarizeProject({project: {id: 'project-new', createdAt: '2026-07-18T08:00:00.000Z'}});
  assert.equal(summary.name, 'Untitled story');
  assert.equal(summary.updatedAt, '2026-07-18T08:00:00.000Z');
  assert.equal(summary.sceneCount, 0);
  assert.equal(summary.beatCount, 0);
  assert.equal(summary.clipCount, 0);
  assert.equal(summary.hasStoryboard, false);
});

test('sortSummaries orders newest-updated first without mutating its input', () => {
  const summaries = [
    {id: 'old', updatedAt: '2026-07-16T00:00:00.000Z'},
    {id: 'new', updatedAt: '2026-07-18T00:00:00.000Z'},
    {id: 'mid', updatedAt: '2026-07-17T00:00:00.000Z'},
  ];
  const sorted = sortSummaries(summaries);
  assert.deepEqual(sorted.map((entry) => entry.id), ['new', 'mid', 'old']);
  assert.equal(summaries[0].id, 'old');
});
