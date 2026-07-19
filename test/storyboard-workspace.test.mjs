import assert from 'node:assert/strict';
import test from 'node:test';

import {createActWorkspace} from '../src/storyboard-workspace.js';

const fixture = () => ({
  project: {id: 'project-story', name: 'The Glass Harbor', metadata: {aspectRatio: '16:9'}},
  characters: [],
  storyboard: {
    schemaVersion: 1,
    styleId: 'story-circle',
    styleTitle: 'The Story Circle',
    nodes: [{
      id: 'act-one',
      kind: 'act',
      actNumber: 1,
      sceneId: 'scene-one',
      title: 'Departure',
      summary: 'Mara leaves the harbor.',
      beats: [
        {id: 'beat-a', text: 'Mara sees the impossible tide.', mentions: {}},
        {id: 'beat-b', text: 'She boards the last ferry.', mentions: {}},
      ],
      stills: [],
    }],
  },
});

test('contextual insertion splits a beat link and deletion never reconnects the chain', () => {
  let nextId = 0;
  const workspace = createActWorkspace({
    project: fixture(),
    actId: 'act-one',
    createId: (prefix) => `${prefix}-${++nextId}`,
  });

  const opened = workspace.read();
  assert.equal(opened.dirty, false);
  assert.deepEqual(opened.act.connections.map(({fromBeatId, toBeatId}) => [fromBeatId, toBeatId]), [
    ['beat-a', 'beat-b'],
  ]);
  assert.ok(opened.act.beats.every((beat) => Number.isFinite(beat.layout.x) && Number.isFinite(beat.layout.y)));

  workspace.dispatch({
    type: 'beat/insert',
    connectionId: opened.act.connections[0].id,
    beat: {id: 'beat-middle', text: 'The water rises into the sky.'},
  });
  const inserted = workspace.read();
  assert.deepEqual(inserted.act.beats.map((beat) => beat.id), ['beat-a', 'beat-middle', 'beat-b']);
  assert.deepEqual(inserted.act.connections.map(({fromBeatId, toBeatId}) => [fromBeatId, toBeatId]), [
    ['beat-a', 'beat-middle'],
    ['beat-middle', 'beat-b'],
  ]);
  assert.equal(inserted.dirty, true);

  workspace.dispatch({type: 'beat/remove', beatId: 'beat-middle'});
  const removed = workspace.read();
  assert.deepEqual(removed.act.beats.map((beat) => beat.id), ['beat-a', 'beat-b']);
  assert.deepEqual(removed.act.connections, []);
});

test('node output insertion appends one linked beat while general insertion stays standalone', () => {
  let nextId = 0;
  const project = fixture();
  project.storyboard.nodes[0].connections = [];
  const workspace = createActWorkspace({
    project,
    actId: 'act-one',
    createId: (prefix) => `${prefix}-${++nextId}`,
  });

  workspace.dispatch({
    type: 'beat/insert',
    afterBeatId: 'beat-a',
    beat: {id: 'beat-linked', text: 'Mara follows the light.'},
  });
  workspace.dispatch({
    type: 'beat/insert',
    beat: {id: 'beat-standalone', text: 'A memory without a connection.'},
  });

  const {act} = workspace.read();
  assert.deepEqual(act.connections.map(({fromBeatId, toBeatId}) => [fromBeatId, toBeatId]), [
    ['beat-a', 'beat-linked'],
  ]);
  assert.deepEqual(act.beats.map((beat) => beat.id), [
    'beat-a', 'beat-linked', 'beat-b', 'beat-standalone',
  ]);
  assert.ok(act.beats.find((beat) => beat.id === 'beat-linked').layout.x > act.beats[0].layout.x);
});

test('act edits remain a draft until the caller marks the saved snapshot committed', () => {
  const workspace = createActWorkspace({
    project: fixture(),
    actId: 'act-one',
    createId: (prefix) => `${prefix}-new`,
  });

  workspace.dispatch({type: 'act/update', patch: {title: 'The Impossible Tide'}});
  workspace.dispatch({
    type: 'beat/update',
    beatId: 'beat-a',
    patch: {
      text: 'Mara watches the sea climb into the clouds.',
      hero: {assetId: 'still-a', prompt: 'A rising sea'},
      screenplay: {text: 'EXT. HARBOR — DAWN\nMara looks up as the tide rises into the sky.'},
    },
  });

  const edited = workspace.read();
  assert.equal(edited.dirty, true);
  assert.equal(edited.act.title, 'The Impossible Tide');
  assert.deepEqual(edited.completion, {beats: 2, stills: 1, screenplays: 1});

  const snapshot = workspace.snapshot();
  assert.equal(snapshot.beats[0].hero.assetId, 'still-a');
  assert.equal(workspace.read().dirty, true);
  workspace.markSaved();
  assert.equal(workspace.read().dirty, false);
});

test('generation context contains the ordered story so far and exact mentioned character versions', () => {
  const project = fixture();
  project.storyboard.nodes.unshift({
    id: 'act-prologue', kind: 'act', actNumber: 0, sceneId: 'scene-prologue', title: 'Prologue',
    summary: 'The harbor has slept for a century.',
    beats: [{id: 'beat-prologue', text: 'A bell rings beneath the water.', mentions: {}, screenplay: {text: 'A submerged bell moves.'}}],
    connections: [],
  });
  project.storyboard.nodes.push({
    id: 'act-future', kind: 'act', actNumber: 2, sceneId: 'scene-future', title: 'Return',
    summary: 'Mara comes home changed.',
    beats: [{id: 'beat-future', text: 'The ferry returns.', mentions: {}}], connections: [],
  });
  project.storyboard.nodes.find((node) => node.id === 'act-one').beats[0].screenplay = {
    text: 'EXT. HARBOR — DAWN\nMara studies the impossible tide.',
  };
  project.storyboard.nodes.find((node) => node.id === 'act-one').beats[1].mentions = {Mara: 'character-mara'};
  project.characters.push({
    id: 'character-mara', name: 'Mara', status: 'ready', lockedVersionId: null, activeVersionId: 'mara-v2',
    versions: [
      {id: 'mara-v1', sheetAssetId: 'sheet-v1', prompt: 'A young sailor'},
      {id: 'mara-v2', sheetAssetId: 'sheet-v2', prompt: 'A young sailor in a red raincoat'},
    ],
  });

  const workspace = createActWorkspace({
    project,
    actId: 'act-one',
    narrativeStyle: {
      id: 'story-circle', title: 'The Story Circle', authors: ['Dan Harmon'],
      tagline: 'you · need · go · search · find · take · return · change',
      notes: ['Order descends into chaos and returns changed.'],
    },
    createId: (prefix) => `${prefix}-new`,
  });

  const context = workspace.contextFor('beat-b');
  assert.equal(context.project.name, 'The Glass Harbor');
  assert.equal(context.narrative.title, 'The Story Circle');
  assert.deepEqual(context.storySoFar.map((act) => ({title: act.title, beats: act.beats.map((beat) => beat.text)})), [
    {title: 'Prologue', beats: ['A bell rings beneath the water.']},
    {title: 'Departure', beats: ['Mara sees the impossible tide.']},
  ]);
  assert.equal(context.storySoFar[1].beats[0].screenplay, 'EXT. HARBOR — DAWN\nMara studies the impossible tide.');
  assert.equal(context.target.text, 'She boards the last ferry.');
  assert.deepEqual(context.characters, [{
    id: 'character-mara',
    name: 'Mara',
    versionId: 'mara-v2',
    sheetAssetId: 'sheet-v2',
    prompt: 'A young sailor in a red raincoat',
    mentioned: true,
  }]);
  assert.doesNotMatch(JSON.stringify(context), /The ferry returns/);
});

test('generation context always carries the full sheeted cast, locked style references, and the previous still', () => {
  const project = fixture();
  project.storyboard.visualStyle = 'Hand-painted 2D animation, dusk palette, soft rim light.';
  project.storyboard.nodes[0].beats[0].hero = {assetId: 'still-beat-a', prompt: 'The tide', characterVersionIds: []};
  project.storyboard.nodes[0].beats[1].mentions = {Mara: 'character-mara'};
  project.characters.push(
    {
      id: 'character-mara', name: 'Mara', status: 'ready', lockedVersionId: null, activeVersionId: 'mara-v2',
      versions: [{id: 'mara-v2', sheetAssetId: 'sheet-v2', prompt: 'A young sailor in a red raincoat'}],
    },
    {
      id: 'character-pip', name: 'Pip', status: 'ready', lockedVersionId: 'pip-v1', activeVersionId: 'pip-v1',
      versions: [{id: 'pip-v1', sheetAssetId: 'sheet-pip', prompt: 'A grey harbor mouse in a patched coat'}],
    },
    {id: 'character-sheetless', name: 'Extra', status: 'draft', lockedVersionId: null, activeVersionId: null, versions: []},
  );
  project.styles = [
    {
      id: 'style-locked', name: 'Harbor look', lockedVersionId: 'style-v1', activeVersionId: 'style-v1',
      versions: [{id: 'style-v1', referenceAssetIds: ['style-ref-1', 'style-ref-2']}],
    },
    {
      id: 'style-unlocked', name: 'Unused look', lockedVersionId: null, activeVersionId: 'style-v9',
      versions: [{id: 'style-v9', referenceAssetIds: ['style-ref-unlocked']}],
    },
  ];

  const workspace = createActWorkspace({
    project,
    actId: 'act-one',
    createId: (prefix) => `${prefix}-new`,
  });
  const context = workspace.contextFor('beat-b');

  // Unmentioned cast with sheets still anchors identity; sheetless extras without mentions drop out.
  assert.deepEqual(context.characters.map(({id, mentioned}) => ({id, mentioned})), [
    {id: 'character-mara', mentioned: true},
    {id: 'character-pip', mentioned: false},
  ]);
  assert.equal(context.style.bible, 'Hand-painted 2D animation, dusk palette, soft rim light.');
  assert.deepEqual(context.style.referenceAssetIds, ['style-ref-1', 'style-ref-2']);
  assert.deepEqual(context.previousStill, {beatId: 'beat-a', assetId: 'still-beat-a'});
  // The first beat has no earlier still to chain from.
  assert.equal(workspace.contextFor('beat-a').previousStill, null);
});
