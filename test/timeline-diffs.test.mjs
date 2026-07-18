import assert from 'node:assert/strict';
import test from 'node:test';

import {createProjectStore, PROJECT_STORAGE_KEY, TIMELINE_DIFF_SCHEMA_VERSION} from '../src/project-store.js';
import {createTimelineDiffs} from '../src/timeline-diffs.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

const createDependencies = () => {
  let id = 0;
  let tick = 0;
  return {
    createId: (prefix) => `${prefix}-diff-${++id}`,
    now: () => new Date(Date.UTC(2026, 6, 16, 18, 0, tick++)).toISOString(),
  };
};

const createFixture = () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const firstAssetId = store.dispatch({
    type: 'asset/import',
    asset: {name: 'first.png', kind: 'image', mimeType: 'image/png', duration: 5},
  }).affectedId;
  const secondAssetId = store.dispatch({
    type: 'asset/import',
    asset: {name: 'second.png', kind: 'image', mimeType: 'image/png', duration: 5},
  }).affectedId;
  const clipIds = Array.from({length: 4}, (_, index) => store.dispatch({
    type: 'clip/add',
    assetId: firstAssetId,
    trackId: 'V1',
    start: index * 2,
    duration: 1.5,
    provenance: {
      prompt: `Original prompt ${index + 1}`,
      modelId: 'local/original',
      seed: index + 1,
      params: {quality: 'draft'},
      parentAssetId: `parent-${index + 1}`,
      characterVersionIds: [`character-v${index + 1}`],
    },
  }).affectedId);
  return {storage, store, diffs: createTimelineDiffs(store), firstAssetId, secondAssetId, clipIds};
};

test('persists and atomically accepts add, move, trim, replace, and remove operations', () => {
  const fixture = createFixture();
  const {store, storage, diffs, firstAssetId, secondAssetId, clipIds} = fixture;
  const before = store.getProject();
  const baseRevision = before.timeline.revision;

  const created = diffs.createProposal({
    id: 'diff-all-operations',
    source: 'agent',
    summary: 'Rework the opening sequence',
    provenance: {requestId: 'agent-request-1'},
    operations: [
      {
        type: 'add',
        clipId: 'clip-added',
        proposedClip: {
          assetId: firstAssetId,
          trackId: 'V1',
          start: 8,
          duration: 2,
          provenance: {prompt: 'A new ending', characterVersionIds: ['character-v5']},
        },
      },
      {type: 'move', clipId: clipIds[0], after: {start: 6, trackId: 'V1'}},
      {type: 'trim', clipId: clipIds[1], after: {start: 2.25, duration: 0.75}},
      {
        type: 'replace',
        clipId: clipIds[2],
        proposedClip: {
          assetId: secondAssetId,
          start: 4,
          duration: 1.5,
          provenance: {
            prompt: 'Replacement prompt',
            modelId: 'local/replacement',
            seed: 99,
            params: {quality: 'preview'},
            parentAssetId: firstAssetId,
          },
        },
      },
      {type: 'remove', clipId: clipIds[3]},
    ],
  });

  assert.equal(created.project.timeline.revision, baseRevision);
  assert.deepEqual(created.project.timeline.clips, before.timeline.clips);
  assert.equal(created.project.timelineDiffs.schemaVersion, TIMELINE_DIFF_SCHEMA_VERSION);
  assert.deepEqual(created.project.timelineDiffs.items[0].operations.map((operation) => operation.type), [
    'add', 'move', 'trim', 'replace', 'remove',
  ]);

  const hydratedStore = createProjectStore({storage, ...createDependencies()});
  const hydratedDiffs = createTimelineDiffs(hydratedStore);
  assert.equal(hydratedDiffs.listPending()[0].id, 'diff-all-operations');
  assert.equal(JSON.parse(storage.getItem(PROJECT_STORAGE_KEY)).timelineDiffs.items.length, 1);

  const accepted = hydratedDiffs.accept('diff-all-operations');
  assert.equal(accepted.project.timeline.revision, baseRevision + 1);
  assert.equal(accepted.project.timelineDiffs.items[0].status, 'accepted');
  assert.equal(accepted.project.timeline.clips.length, 4);
  assert.equal(accepted.project.timeline.clips.find((clip) => clip.id === clipIds[0]).start, 6);
  assert.equal(accepted.project.timeline.clips.find((clip) => clip.id === clipIds[1]).duration, 0.75);
  assert.deepEqual(
    accepted.project.timeline.clips.find((clip) => clip.id === clipIds[1]).provenance.characterVersionIds,
    ['character-v2'],
  );
  const replacement = accepted.project.timeline.clips.find((clip) => clip.id === clipIds[2]);
  assert.equal(replacement.assetId, secondAssetId);
  assert.equal(replacement.provenance.prompt, 'Replacement prompt');
  assert.deepEqual(replacement.provenance.characterVersionIds, ['character-v3']);
  assert.equal(accepted.project.timeline.clips.some((clip) => clip.id === clipIds[3]), false);
  assert.deepEqual(
    accepted.project.timeline.clips.find((clip) => clip.id === 'clip-added').provenance.characterVersionIds,
    ['character-v5'],
  );

  const repeated = hydratedDiffs.accept('diff-all-operations');
  assert.equal(repeated.changed, false);
  assert.equal(repeated.project.timeline.revision, baseRevision + 1);
});

test('rejects idempotently without changing the accepted timeline or referenced records', () => {
  const {store, diffs, firstAssetId, clipIds} = createFixture();
  const beforeTimeline = JSON.stringify(store.getProject().timeline);
  const beforeAssetCount = store.getProject().mediaAssets.length;

  diffs.createProposal({
    id: 'diff-reject',
    source: 'user',
    summary: 'Move one clip',
    operations: [{type: 'move', clipId: clipIds[0], after: {start: 9}}],
  });
  const rejected = diffs.reject('diff-reject');
  assert.equal(rejected.project.timelineDiffs.items[0].status, 'rejected');
  assert.equal(JSON.stringify(rejected.project.timeline), beforeTimeline);
  assert.equal(rejected.project.mediaAssets.length, beforeAssetCount);
  assert.ok(rejected.project.mediaAssets.some((asset) => asset.id === firstAssetId));

  const repeated = diffs.reject('diff-reject');
  assert.equal(repeated.changed, false);
  assert.equal(JSON.stringify(repeated.project.timeline), beforeTimeline);
  assert.throws(() => diffs.accept('diff-reject'), /Rejected timeline diffs cannot be accepted/);
});

test('marks old proposals stale and prevents silent acceptance after accepted edits', () => {
  const {storage, store, diffs, clipIds} = createFixture();
  diffs.createProposal({
    id: 'diff-stale',
    operations: [{type: 'trim', clipId: clipIds[0], after: {duration: 1}}],
  });

  store.dispatch({type: 'clip/move', clipId: clipIds[1], trackId: 'V1', start: 7});
  const [stale] = diffs.listPending();
  assert.equal(stale.status, 'stale');
  assert.throws(() => diffs.accept(stale.id), /must be reconciled/);

  const reopened = createProjectStore({storage, ...createDependencies()});
  assert.equal(createTimelineDiffs(reopened).listPending()[0].status, 'stale');
  assert.doesNotThrow(() => createTimelineDiffs(reopened).reject('diff-stale'));
});

test('rebases compatible stale proposals into new pending history and is idempotent', () => {
  const {storage, store, diffs, clipIds} = createFixture();
  diffs.createProposal({
    id: 'diff-rebase-compatible',
    operations: [{type: 'move', clipId: clipIds[0], after: {start: 9}}],
  });
  store.dispatch({type: 'clip/move', clipId: clipIds[1], trackId: 'V1', start: 7});
  const acceptedAfterConcurrentEdit = JSON.stringify(store.getProject().timeline.clips);

  const first = diffs.rebase('diff-rebase-compatible');
  assert.equal(first.changed, true);
  const rebased = first.project.timelineDiffs.items.find((diff) => diff.id === first.affectedId);
  assert.equal(rebased.status, 'pending');
  assert.equal(rebased.baseRevision, first.project.timeline.revision);
  assert.equal(rebased.provenance.reconciliation.rebasedFromDiffId, 'diff-rebase-compatible');
  assert.equal(first.project.timelineDiffs.items.find((diff) => diff.id === 'diff-rebase-compatible').status, 'stale');
  assert.equal(JSON.stringify(first.project.timeline.clips), acceptedAfterConcurrentEdit);

  const reopened = createProjectStore({storage, ...createDependencies()});
  const reopenedDiffs = createTimelineDiffs(reopened).listPending();
  assert.deepEqual(reopenedDiffs.map((diff) => diff.status), ['stale', 'pending']);
  assert.equal(reopenedDiffs[1].provenance.reconciliation.rebasedFromDiffId, 'diff-rebase-compatible');

  const repeated = diffs.rebase('diff-rebase-compatible');
  assert.equal(repeated.changed, false);
  assert.equal(repeated.affectedId, first.affectedId);
  assert.equal(repeated.project.timelineDiffs.items.filter((diff) => diff.provenance.reconciliation?.rebasedFromDiffId === 'diff-rebase-compatible').length, 1);

  const accepted = diffs.accept(first.affectedId);
  assert.equal(accepted.project.timelineDiffs.items.find((diff) => diff.id === first.affectedId).status, 'accepted');
  assert.equal(accepted.project.timeline.clips.find((clip) => clip.id === clipIds[0]).start, 9);
});

test('round-trips accepted, rejected, stale, and rebased proposal history', () => {
  const {storage, store, diffs, clipIds} = createFixture();
  diffs.createProposal({id: 'history-accepted', operations: [{type: 'move', clipId: clipIds[0], after: {start: 1}}]});
  diffs.accept('history-accepted');
  diffs.createProposal({id: 'history-rejected', operations: [{type: 'trim', clipId: clipIds[1], after: {duration: 1}}]});
  diffs.reject('history-rejected');
  diffs.createProposal({id: 'history-stale', operations: [{type: 'move', clipId: clipIds[0], after: {start: 6}}]});
  store.dispatch({type: 'clip/move', clipId: clipIds[1], trackId: 'V1', start: 8});
  const rebased = diffs.rebase('history-stale');
  assert.deepEqual(rebased.project.timelineDiffs.items.map((diff) => diff.status), ['accepted', 'rejected', 'stale', 'pending']);

  const reopened = createProjectStore({storage, ...createDependencies()}).getProject();
  assert.deepEqual(reopened.timelineDiffs.items.map((diff) => diff.status), ['accepted', 'rejected', 'stale', 'pending']);
  assert.equal(reopened.timelineDiffs.items[3].provenance.reconciliation.rebasedFromDiffId, 'history-stale');
});

test('reports stale rebase conflicts without changing accepted clips or the stale record', () => {
  const {store, diffs, clipIds, secondAssetId} = createFixture();
  diffs.createProposal({
    id: 'diff-rebase-move-conflict',
    operations: [{type: 'move', clipId: clipIds[0], after: {start: 9}}],
  });
  store.dispatch({type: 'clip/move', clipId: clipIds[0], trackId: 'V1', start: 4});
  const beforeConflict = JSON.stringify(store.getProject());
  const moveConflict = diffs.rebase('diff-rebase-move-conflict');
  assert.equal(moveConflict.changed, false);
  assert.ok(moveConflict.conflicts.some((conflict) => conflict.code === 'target-changed-concurrently'));
  assert.equal(JSON.stringify(moveConflict.project), beforeConflict);

  diffs.createProposal({
    id: 'diff-rebase-replace-conflict',
    operations: [{type: 'replace', clipId: clipIds[1], proposedClip: {assetId: secondAssetId, start: 2, duration: 1}}],
  });
  diffs.createProposal({
    id: 'diff-current-replace',
    operations: [{type: 'replace', clipId: clipIds[1], proposedClip: {assetId: secondAssetId, start: 2, duration: 1}}],
  });
  diffs.accept('diff-current-replace');
  const replacementConflict = diffs.rebase('diff-rebase-replace-conflict');
  assert.equal(replacementConflict.changed, false);
  assert.ok(replacementConflict.conflicts.some((conflict) => conflict.code === 'target-identity-changed'));
  assert.equal(replacementConflict.project.timelineDiffs.items.filter((diff) => diff.provenance.reconciliation?.rebasedFromDiffId === 'diff-rebase-replace-conflict').length, 0);
});

test('reports deleted proposal assets as explicit rebase conflicts', () => {
  const {store, diffs, firstAssetId, clipIds} = createFixture();
  diffs.createProposal({
    id: 'diff-rebase-add-asset-conflict',
    operations: [{type: 'add', clipId: 'generated-clip', proposedClip: {assetId: firstAssetId, start: 10, duration: 1}}],
  });
  store.dispatch({type: 'clip/move', clipId: clipIds[0], trackId: 'V1', start: 3});
  store.dispatch({type: 'asset/remove', assetId: firstAssetId});
  const beforeConflict = JSON.stringify(store.getProject());
  const result = diffs.rebase('diff-rebase-add-asset-conflict');
  assert.equal(result.changed, false);
  assert.ok(result.conflicts.some((conflict) => conflict.code === 'missing-proposed-asset'));
  assert.equal(JSON.stringify(result.project), beforeConflict);
});

test('rejects malformed proposals without partially changing clips or persistence', () => {
  const {store, diffs, firstAssetId, clipIds} = createFixture();
  const before = JSON.stringify(store.getProject());

  assert.throws(() => diffs.createProposal({operations: [{type: 'unknown', clipId: clipIds[0]}]}), /Unknown timeline diff operation/);
  assert.throws(() => diffs.createProposal({operations: [{type: 'move', clipId: 'missing', after: {start: 2}}]}), /not found/);
  assert.throws(() => diffs.createProposal({operations: [{type: 'add', proposedClip: {assetId: 'missing'}}]}), /missing asset/);
  assert.throws(() => diffs.createProposal({
    operations: [
      {type: 'add', proposedClip: {assetId: firstAssetId, start: 9, duration: 1}},
      {type: 'trim', clipId: clipIds[0], after: {duration: 0}},
    ],
  }), /at least 0.1 seconds/);

  assert.equal(JSON.stringify(store.getProject()), before);
  assert.equal(diffs.listPending().length, 0);
});
