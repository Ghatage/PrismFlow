import assert from 'node:assert/strict';
import test from 'node:test';

import {createProjectStore} from '../src/project-store.js';
import {
  buildGhostItems,
  createReviewSession,
  derivePreviewClips,
  enterPreview,
  exitPreview,
  listReviewableDiffs,
  listReviewItems,
  previewTimelineForDiff,
  reviseGhostProposal,
  selectFirstReviewItem,
  selectNextReviewItem,
  selectPreviousReviewItem,
} from '../src/timeline-diff-review.js';
import {createTimelineDiffs} from '../src/timeline-diffs.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

const clip = (id, start, duration = 2) => ({
  id,
  assetId: 'asset-1',
  sceneId: 'scene-1',
  trackId: 'V1',
  start,
  duration,
  provenance: {
    prompt: `Prompt ${id}`,
    modelId: 'local/model',
    seed: 10,
    params: {mode: 'draft'},
    parentAssetId: 'parent-1',
    derivedMetadata: null,
    characterVersionIds: ['character-v1'],
  },
});

test('builds distinct ghost representations and previews without mutating accepted clips', () => {
  const accepted = [clip('move-clip', 0), clip('trim-clip', 2), clip('replace-clip', 4), clip('remove-clip', 6)];
  const added = clip('add-clip', 8);
  const moved = {...accepted[0], start: 1};
  const trimmed = {...accepted[1], duration: 1};
  const replaced = {...accepted[2], assetId: 'asset-2'};
  const diff = {
    id: 'diff-ghosts',
    status: 'pending',
    source: 'agent',
    summary: 'Five visible operations',
    provenance: {},
    operations: [
      {type: 'add', clipId: added.id, before: null, after: added, proposedClip: added},
      {type: 'move', clipId: moved.id, before: accepted[0], after: moved, proposedClip: null},
      {type: 'trim', clipId: trimmed.id, before: accepted[1], after: trimmed, proposedClip: null},
      {type: 'replace', clipId: replaced.id, before: accepted[2], after: replaced, proposedClip: replaced},
      {type: 'remove', clipId: accepted[3].id, before: accepted[3], after: null, proposedClip: null},
    ],
  };

  const ghosts = buildGhostItems([diff]);
  assert.equal(ghosts.length, 6);
  assert.deepEqual(ghosts.map((ghost) => `${ghost.type}:${ghost.role}`), [
    'add:proposal',
    'move:destination',
    'move:origin',
    'trim:proposal',
    'replace:proposal',
    'remove:removal',
  ]);
  assert.equal(ghosts.find((ghost) => ghost.role === 'destination').clip.start, 1);
  assert.equal(ghosts.find((ghost) => ghost.role === 'origin').clip.start, 0);

  const acceptedBefore = structuredClone(accepted);
  const preview = previewTimelineForDiff(accepted, diff);
  assert.deepEqual(accepted, acceptedBefore);
  assert.equal(preview.length, 4);
  assert.ok(preview.some((candidate) => candidate.id === added.id));
  assert.equal(preview.find((candidate) => candidate.id === moved.id).start, 1);
  assert.equal(preview.find((candidate) => candidate.id === trimmed.id).duration, 1);
  assert.equal(preview.find((candidate) => candidate.id === replaced.id).assetId, 'asset-2');
  assert.equal(preview.some((candidate) => candidate.id === 'remove-clip'), false);

  const revised = reviseGhostProposal(diff, 1, {start: 3, trackId: 'V1'});
  assert.equal(revised.id, undefined);
  assert.equal(revised.operations[1].after.start, 3);
  assert.equal(revised.provenance.revisedFromDiffId, diff.id);
  assert.equal(diff.operations[1].after.start, 1);
  assert.throws(() => reviseGhostProposal(diff, 4, {start: 9}), /cannot be dragged/);
});

test('orders review proposals deterministically and navigates one item per diff', () => {
  const first = {
    id: 'diff-first',
    status: 'pending',
    source: 'generation',
    baseRevision: 2,
    summary: 'First proposal',
    provenance: {requestId: 'first'},
    createdAt: '2026-07-16T10:00:00.000Z',
    operations: [{type: 'add', clipId: 'new-clip', before: null, after: clip('new-clip', 0)}],
  };
  const second = {
    id: 'diff-second',
    status: 'stale',
    source: 'user',
    baseRevision: 1,
    summary: 'Second proposal',
    provenance: {requestId: 'second'},
    createdAt: '2026-07-16T11:00:00.000Z',
    operations: [{type: 'move', clipId: 'move-clip', before: clip('move-clip', 1), after: clip('move-clip', 4)}],
  };
  const ignored = {...first, id: 'ignored', status: 'accepted'};

  assert.deepEqual(listReviewableDiffs([second, ignored, first]).map((diff) => diff.id), ['diff-first', 'diff-second']);
  const items = listReviewItems([second, first]);
  assert.deepEqual(items.map((item) => item.diffId), ['diff-first', 'diff-second']);
  assert.equal(items[1].type, 'move');
  assert.equal(items[1].role, 'destination');
  assert.equal(items[1].status, 'stale');
  assert.equal(items[1].source, 'user');
  assert.deepEqual(items[1].provenance, {requestId: 'second'});

  const firstItem = selectFirstReviewItem([second, first]);
  assert.equal(firstItem.diffId, 'diff-first');
  assert.equal(selectPreviousReviewItem([second, first], firstItem.key).key, firstItem.key);
  assert.equal(selectNextReviewItem([second, first], firstItem.key).diffId, 'diff-second');
  assert.equal(selectNextReviewItem([second, first], 'missing').diffId, 'diff-first');
  assert.equal(selectNextReviewItem([], firstItem.key), null);

  firstItem.provenance.requestId = 'mutated';
  assert.equal(first.provenance.requestId, 'first');
});

test('keeps preview state separate from accepted playback clips', () => {
  const accepted = [clip('accepted', 0)];
  const diff = {
    id: 'diff-preview',
    status: 'pending',
    createdAt: '2026-07-16T12:00:00.000Z',
    operations: [{type: 'trim', clipId: 'accepted', before: accepted[0], after: {...accepted[0], duration: 0.5}}],
  };
  const session = createReviewSession({acceptedClips: accepted, diffs: [diff]});
  const selected = session.selectFirst();
  assert.equal(selected.diffId, diff.id);
  assert.deepEqual(session.getState(), {selectedKey: selected.key, previewDiffId: null});
  assert.deepEqual(session.getPlaybackClips(), accepted);

  assert.deepEqual(enterPreview(session.getState(), diff.id), {
    selectedKey: selected.key,
    previewDiffId: diff.id,
  });
  session.enterPreview(diff.id);
  const preview = session.getPlaybackClips();
  assert.equal(preview[0].duration, 0.5);
  assert.equal(accepted[0].duration, 2);
  assert.equal(derivePreviewClips(accepted, diff)[0].duration, 0.5);

  session.exitPreview();
  assert.deepEqual(session.getPlaybackClips(), accepted);
  assert.equal(exitPreview(session.getState()).previewDiffId, null);
});

test('accepts or rejects multiple reviewable diffs as one store transition', () => {
  let id = 0;
  const store = createProjectStore({
    storage: new MemoryStorage(),
    createId: (prefix) => `${prefix}-review-${++id}`,
    now: () => '2026-07-16T19:00:00.000Z',
  });
  const assetId = store.dispatch({type: 'asset/import', asset: {name: 'shot.png', kind: 'image', mimeType: 'image/png'}}).affectedId;
  const firstClipId = store.dispatch({type: 'clip/add', assetId, start: 0, duration: 2}).affectedId;
  const secondClipId = store.dispatch({type: 'clip/add', assetId, start: 3, duration: 2}).affectedId;
  const diffs = createTimelineDiffs(store);
  const baseRevision = store.getProject().timeline.revision;

  diffs.createProposal({id: 'move-review', operations: [{type: 'move', clipId: firstClipId, after: {start: 1}}]});
  diffs.createProposal({id: 'trim-review', operations: [{type: 'trim', clipId: secondClipId, after: {duration: 1}}]});
  const accepted = diffs.acceptAll();
  assert.equal(accepted.project.timeline.revision, baseRevision + 1);
  assert.equal(accepted.project.timeline.clips.find((candidate) => candidate.id === firstClipId).start, 1);
  assert.equal(accepted.project.timeline.clips.find((candidate) => candidate.id === secondClipId).duration, 1);
  assert.deepEqual(accepted.project.timelineDiffs.items.map((diff) => diff.status), ['accepted', 'accepted']);

  diffs.createProposal({id: 'move-again', operations: [{type: 'move', clipId: firstClipId, after: {start: 5}}]});
  diffs.createProposal({id: 'trim-again', operations: [{type: 'trim', clipId: secondClipId, after: {duration: 0.5}}]});
  const beforeReject = JSON.stringify(store.getProject().timeline);
  const rejected = diffs.rejectAll();
  assert.equal(JSON.stringify(rejected.project.timeline), beforeReject);
  assert.deepEqual(rejected.project.timelineDiffs.items.slice(-2).map((diff) => diff.status), ['rejected', 'rejected']);
});
