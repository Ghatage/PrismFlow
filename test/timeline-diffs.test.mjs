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
