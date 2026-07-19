import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProjectStore,
  PROJECT_SCHEMA_VERSION,
  PROJECT_STORAGE_KEY,
  STORYBOARD_SCHEMA_VERSION,
} from '../src/project-store.js';

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
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
    createId: (prefix) => `${prefix}-test-${++id}`,
    now: () => `2026-07-16T12:00:${String(tick++).padStart(2, '0')}.000Z`,
  };
};

test('persists project structure and provenance without runtime URLs or secrets', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});

  const imported = store.dispatch({
    type: 'asset/import',
    asset: {
      name: 'opening.png',
      kind: 'image',
      mimeType: 'image/png',
      size: 2048,
      duration: 5,
      url: 'blob:http://localhost/private-object-url',
      source: {type: 'local-file', fileName: 'opening.png', lastModified: 1234},
      metadata: {width: 1920, falApiKey: 'never-persist-this'},
    },
  });
  const added = store.dispatch({
    type: 'clip/add',
    assetId: imported.affectedId,
    trackId: 'V1',
    start: 1.5,
    provenance: {
      prompt: 'A calm opening frame',
      modelId: 'fal-ai/example',
      seed: 42,
      params: {steps: 28, authorization: 'Bearer hidden'},
      parentAssetId: 'media-parent',
      derivedMetadata: {operation: 'upscale', previewUrl: 'blob:http://localhost/derived'},
    },
  });

  const runtimeProject = added.project;
  assert.equal(runtimeProject.mediaAssets[0].url, 'blob:http://localhost/private-object-url');
  assert.equal(runtimeProject.timeline.clips[0].id, added.affectedId);

  const serialized = storage.getItem(PROJECT_STORAGE_KEY);
  const persisted = JSON.parse(serialized);
  assert.equal(persisted.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.match(persisted.updatedAt, /^2026-07-16/);
  assert.equal(persisted.project.name, 'Untitled story');
  assert.equal(persisted.scenes.length, 1);
  assert.deepEqual(persisted.characters, []);
  assert.equal(persisted.mediaAssets[0].metadata.width, 1920);
  assert.equal(persisted.timeline.tracks.length, 2);
  assert.deepEqual(persisted.timeline.clips[0].provenance, {
    prompt: 'A calm opening frame',
    modelId: 'fal-ai/example',
    seed: 42,
    params: {steps: 28},
    parentAssetId: 'media-parent',
    parentAssetIds: ['media-parent'],
    derivedMetadata: {operation: 'upscale'},
    characterVersionIds: [],
  });
  assert.equal(serialized.includes('blob:'), false);
  assert.equal(serialized.includes('never-persist-this'), false);
  assert.equal(serialized.includes('Bearer hidden'), false);

  const moved = store.dispatch({type: 'clip/move', clipId: added.affectedId, trackId: 'V1', start: 3.2});
  assert.equal(moved.project.timeline.clips[0].start, 3.2);
  assert.equal(JSON.parse(storage.getItem(PROJECT_STORAGE_KEY)).timeline.clips[0].start, 3.2);

  const hydrated = createProjectStore({storage, ...createDependencies()}).getProject();
  assert.equal(hydrated.mediaAssets[0].url, null);
  assert.equal(hydrated.timeline.clips[0].start, 3.2);
  assert.equal(hydrated.timeline.clips[0].provenance.prompt, 'A calm opening frame');
});

test('recovers from malformed or unavailable browser storage', () => {
  const malformedStorage = new MemoryStorage({[PROJECT_STORAGE_KEY]: '{not-json'});
  const recoveredStore = createProjectStore({storage: malformedStorage, ...createDependencies()});
  const recovered = recoveredStore.getProject();
  assert.equal(recovered.schemaVersion, PROJECT_SCHEMA_VERSION);
  assert.equal(recovered.mediaAssets.length, 0);
  assert.doesNotThrow(() => JSON.parse(malformedStorage.getItem(PROJECT_STORAGE_KEY)));

  const unavailableStorage = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
  };
  const memoryOnlyStore = createProjectStore({storage: unavailableStorage, ...createDependencies()});
  const imported = memoryOnlyStore.dispatch({
    type: 'asset/import',
    asset: {name: 'offline.wav', kind: 'audio', mimeType: 'audio/wav'},
  });
  const added = memoryOnlyStore.dispatch({type: 'clip/add', assetId: imported.affectedId, trackId: 'V1', start: 0});
  assert.equal(memoryOnlyStore.getProject().mediaAssets.length, 1);
  assert.deepEqual(added.project.timeline.clips[0].provenance, {
    prompt: null,
    modelId: null,
    seed: null,
    params: {},
    parentAssetId: null,
    parentAssetIds: [],
    derivedMetadata: null,
    characterVersionIds: [],
  });
  assert.equal(added.project.timeline.clips[0].trackId, 'A1');
  assert.doesNotThrow(() => memoryOnlyStore.dispatch({type: 'clip/remove', clipId: added.affectedId}));
  assert.equal(memoryOnlyStore.getProject().timeline.clips.length, 0);
});

test('renames the project durably and ignores empty names', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const original = store.getProject();

  const renamed = store.dispatch({type: 'project/rename', name: '  Moonlit Cat  '});
  assert.equal(renamed.changed, true);
  assert.equal(renamed.affectedId, original.project.id);
  assert.equal(renamed.project.project.name, 'Moonlit Cat');
  assert.equal(JSON.parse(storage.getItem(PROJECT_STORAGE_KEY)).project.name, 'Moonlit Cat');

  const ignored = store.dispatch({type: 'project/rename', name: '   '});
  assert.equal(ignored.changed, false);
  assert.equal(ignored.project.project.name, 'Moonlit Cat');
});

test('splits a clip at a timeline time and preserves source continuity', () => {
  const store = createProjectStore({storage: new MemoryStorage(), ...createDependencies()});
  const imported = store.dispatch({
    type: 'asset/import',
    asset: {name: 'scene.mp4', kind: 'video', mimeType: 'video/mp4', duration: 8},
  });
  const added = store.dispatch({type: 'clip/add', assetId: imported.affectedId, trackId: 'V1', start: 2, duration: 6});

  const split = store.dispatch({type: 'clip/split', clipId: added.affectedId, time: 5});
  assert.equal(split.changed, true);
  assert.notEqual(split.affectedId, added.affectedId);
  const clips = split.project.timeline.clips.toSorted((left, right) => left.start - right.start);
  assert.equal(clips.length, 2);
  assert.deepEqual(clips.map(({start, duration, sourceStart}) => ({start, duration, sourceStart})), [
    {start: 2, duration: 3, sourceStart: 0},
    {start: 5, duration: 3, sourceStart: 3},
  ]);
});

test('adds video tracks above the video stack and audio tracks below the audio stack', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});

  const addedVideo = store.dispatch({type: 'track/add', kind: 'video'});
  assert.equal(addedVideo.affectedId, 'V2');
  assert.deepEqual(addedVideo.project.timeline.tracks.map(({id, kind}) => ({id, kind})), [
    {id: 'V2', kind: 'video'},
    {id: 'V1', kind: 'video'},
    {id: 'A1', kind: 'audio'},
  ]);

  const addedAudio = store.dispatch({type: 'track/add', kind: 'audio'});
  assert.equal(addedAudio.affectedId, 'A2');
  assert.deepEqual(addedAudio.project.timeline.tracks.map(({id, kind}) => ({id, kind})), [
    {id: 'V2', kind: 'video'},
    {id: 'V1', kind: 'video'},
    {id: 'A1', kind: 'audio'},
    {id: 'A2', kind: 'audio'},
  ]);

  const imported = store.dispatch({
    type: 'asset/import',
    asset: {name: 'still.png', kind: 'image', mimeType: 'image/png'},
  });
  const added = store.dispatch({type: 'clip/add', assetId: imported.affectedId, trackId: 'V2', start: 0});
  assert.equal(added.project.timeline.clips[0].trackId, 'V2');

  const moved = store.dispatch({type: 'clip/move', clipId: added.affectedId, trackId: 'V1', start: 1});
  assert.equal(moved.project.timeline.clips[0].trackId, 'V1');

  const hydrated = createProjectStore({storage, ...createDependencies()}).getProject();
  assert.deepEqual(hydrated.timeline.tracks.map(({id, kind}) => ({id, kind})), [
    {id: 'V2', kind: 'video'},
    {id: 'V1', kind: 'video'},
    {id: 'A1', kind: 'audio'},
    {id: 'A2', kind: 'audio'},
  ]);
});

test('clip/detach-audio splits audio to the audio track and mutes the source clip', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const videoAssetId = store.dispatch({
    type: 'asset/import',
    asset: {name: 'shot.mp4', kind: 'video', mimeType: 'video/mp4', duration: 20, url: 'blob:http://localhost/shot'},
  }).affectedId;
  const clipId = store.dispatch({type: 'clip/add', assetId: videoAssetId, trackId: 'V1', start: 3, duration: 8, sourceStart: 2}).affectedId;

  const detached = store.dispatch({
    type: 'clip/detach-audio',
    clipId,
    audioAsset: {
      id: 'media-detached-1',
      name: 'shot.mp4 (audio)',
      kind: 'audio',
      mimeType: 'audio/wav',
      duration: 20,
      url: 'blob:http://localhost/shot-audio',
      source: {type: 'detached-audio', fileName: 'shot.mp4'},
    },
  });
  assert.equal(detached.changed, true);

  const project = detached.project;
  const audioAsset = project.mediaAssets.find((asset) => asset.id === 'media-detached-1');
  assert.equal(audioAsset.kind, 'audio');
  assert.equal(audioAsset.url, 'blob:http://localhost/shot-audio');
  assert.deepEqual(audioAsset.metadata.detachedFrom, {assetId: videoAssetId, clipId});

  const audioClip = project.timeline.clips.find((clip) => clip.id === detached.affectedId);
  assert.equal(audioClip.trackId, 'A1');
  assert.equal(audioClip.assetId, 'media-detached-1');
  assert.equal(audioClip.start, 3);
  assert.equal(audioClip.duration, 8);
  assert.equal(audioClip.sourceStart, 2);
  assert.equal(audioClip.provenance.parentAssetId, videoAssetId);
  assert.equal(audioClip.provenance.derivedMetadata.type, 'detached-audio');

  const videoClip = project.timeline.clips.find((clip) => clip.id === clipId);
  assert.equal(videoClip.audioDetached, true);

  const again = store.dispatch({type: 'clip/detach-audio', clipId, audioAsset: {id: 'media-detached-2', kind: 'audio'}});
  assert.equal(again.changed, false);
  assert.equal(again.project.mediaAssets.some((asset) => asset.id === 'media-detached-2'), false);
});

test('clip/detach-audio ignores non-video clips and persists the detached flag', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const imageAssetId = store.dispatch({type: 'asset/import', asset: {name: 'still.png', kind: 'image', duration: 5}}).affectedId;
  const imageClipId = store.dispatch({type: 'clip/add', assetId: imageAssetId, trackId: 'V1', start: 0}).affectedId;
  assert.equal(store.dispatch({type: 'clip/detach-audio', clipId: imageClipId, audioAsset: {id: 'media-x', kind: 'audio'}}).changed, false);

  const videoAssetId = store.dispatch({type: 'asset/import', asset: {name: 'shot.mp4', kind: 'video', duration: 10}}).affectedId;
  const clipId = store.dispatch({type: 'clip/add', assetId: videoAssetId, trackId: 'V1', start: 0, duration: 4}).affectedId;
  store.dispatch({type: 'clip/detach-audio', clipId, audioAsset: {id: 'media-detached-1', name: 'a', kind: 'audio', duration: 10}});

  const reloaded = createProjectStore({storage, ...createDependencies()});
  const clips = reloaded.getProject().timeline.clips;
  assert.equal(clips.find((clip) => clip.id === clipId).audioDetached, true);
  assert.equal(clips.find((clip) => clip.assetId === 'media-detached-1').trackId, 'A1');
});

test('transitions attach to clip edges, clamp duration, replace at junctions, and prune when invalid', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const assetId = store.dispatch({type: 'asset/import', asset: {name: 'a.mp4', kind: 'video', duration: 30}}).affectedId;
  const first = store.dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 0, duration: 5}).affectedId;
  const second = store.dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 5, duration: 5}).affectedId;

  const added = store.dispatch({type: 'transition/add', transitionType: 'crossfade', fromClipId: first, toClipId: second, duration: 9});
  const transition = added.project.timeline.transitions[0];
  assert.equal(transition.type, 'crossfade');
  assert.equal(transition.trackId, 'V1');
  assert.equal(transition.duration, 2.5);

  store.dispatch({type: 'transition/add', transitionType: 'wipe-left', fromClipId: first, toClipId: second});
  let project = store.getProject();
  assert.equal(project.timeline.transitions.length, 1);
  assert.equal(project.timeline.transitions[0].type, 'wipe-left');

  const fade = store.dispatch({type: 'transition/add', transitionType: 'dip-to-black', fromClipId: second});
  assert.equal(fade.changed, true);
  assert.equal(store.getProject().timeline.transitions.length, 2);

  const third = store.dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 20, duration: 5}).affectedId;
  assert.throws(
    () => store.dispatch({type: 'transition/add', transitionType: 'crossfade', fromClipId: first, toClipId: third}),
    /adjacent/,
  );
  assert.throws(
    () => store.dispatch({type: 'transition/add', transitionType: 'sparkle', fromClipId: first}),
    /Unknown transition type/,
  );

  const reloaded = createProjectStore({storage, ...createDependencies()});
  assert.equal(reloaded.getProject().timeline.transitions.length, 2);

  store.dispatch({type: 'clip/move', clipId: second, start: 12});
  project = store.getProject();
  assert.equal(project.timeline.transitions.length, 1);
  assert.equal(project.timeline.transitions[0].fromClipId, second);
  assert.equal(project.timeline.transitions[0].toClipId, null);

  store.dispatch({type: 'clip/remove', clipId: second});
  assert.equal(store.getProject().timeline.transitions.length, 0);

  const again = store.dispatch({type: 'transition/add', transitionType: 'crossfade', fromClipId: first});
  const removed = store.dispatch({type: 'transition/remove', transitionId: again.affectedId});
  assert.equal(removed.changed, true);
  assert.equal(store.getProject().timeline.transitions.length, 0);
});

test('custom transition definitions persist, drive the timeline, and clean up on removal', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const assetId = store.dispatch({type: 'asset/import', asset: {name: 'a.mp4', kind: 'video', duration: 30}}).affectedId;
  const first = store.dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 0, duration: 5}).affectedId;
  const second = store.dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 5, duration: 5}).affectedId;

  const definition = {
    label: 'Iris open',
    glyph: '◎',
    defaultDuration: 1.2,
    mode: 'blend',
    tracks: [
      {target: 'layerB', property: 'opacity', keyframes: [{at: 0, value: '1'}, {at: 1, value: '1'}]},
      {target: 'layerB', property: 'clipPath', keyframes: [{at: 0, value: 'circle(0% at 50% 50%)'}, {at: 1, value: 'circle(75% at 50% 50%)'}]},
    ],
  };
  const created = store.dispatch({type: 'transition-def/create', definition, promptText: 'circular reveal'});
  assert.equal(created.affectedId, 'custom-iris-open');
  assert.equal(store.getProject().customTransitions[0].promptText, 'circular reveal');

  assert.throws(
    () => store.dispatch({type: 'transition-def/create', definition: {label: 'Bad', mode: 'blend', tracks: []}}),
    /Invalid transition definition/,
  );

  const duplicate = store.dispatch({type: 'transition-def/create', definition});
  assert.equal(duplicate.affectedId, 'custom-iris-open-2');

  const added = store.dispatch({type: 'transition/add', transitionType: 'custom-iris-open', fromClipId: first, toClipId: second});
  assert.equal(added.project.timeline.transitions[0].duration, 1.2);

  const reloaded = createProjectStore({storage, ...createDependencies()});
  assert.equal(reloaded.getProject().customTransitions.length, 2);
  assert.equal(reloaded.getProject().timeline.transitions[0].type, 'custom-iris-open');

  const removed = store.dispatch({type: 'transition-def/remove', key: 'custom-iris-open'});
  assert.equal(removed.changed, true);
  assert.equal(store.getProject().customTransitions.length, 1);
  assert.equal(store.getProject().timeline.transitions.length, 0);
  assert.throws(
    () => store.dispatch({type: 'transition/add', transitionType: 'custom-iris-open', fromClipId: first, toClipId: second}),
    /Unknown transition type/,
  );
});

test('transitions are rejected on audio tracks', () => {
  const store = createProjectStore({storage: new MemoryStorage(), ...createDependencies()});
  const audioAssetId = store.dispatch({type: 'asset/import', asset: {name: 'a.wav', kind: 'audio', duration: 10}}).affectedId;
  const audioClipId = store.dispatch({type: 'clip/add', assetId: audioAssetId, trackId: 'A1', start: 0, duration: 5}).affectedId;
  assert.throws(
    () => store.dispatch({type: 'transition/add', transitionType: 'crossfade', fromClipId: audioClipId}),
    /video tracks/,
  );
});

test('round-trips storyboard state, scene tags on assets and agent messages', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const sceneAdd = store.dispatch({type: 'scene/add', scene: {name: 'Act 2', metadata: {actNumber: 2}}});
  const actSceneId = sceneAdd.affectedId;

  store.dispatch({
    type: 'storyboard/update',
    storyboard: {
      styleId: 'style-1',
      styleTitle: 'Three act',
      visualStyle: 'Hand-painted 2D animation, dusk palette.',
      pan: {x: -40, y: 12},
      zoom: 1.4,
      nextZ: 12,
      nodes: [
        {id: 'n1', kind: 'act', actNumber: 2, sceneId: actSceneId, title: 'Act 2', summary: 'Rising action',
          beats: ['legacy string beat', {id: 'b2', text: 'Hero meets @Mara', mentions: {Mara: 'character-1'}}],
          stills: [{id: 's1', assetId: null, beatIds: ['b2'], prompt: 'still prompt', status: 'generating'}],
          x: 90, y: 200, w: 380, z: 11},
        {id: 'n2', kind: 'note', text: 'a note', x: -20, y: 40, w: 280, z: 12},
      ],
    },
  });
  const imported = store.dispatch({
    type: 'asset/import',
    asset: {name: 'clip.mp4', kind: 'video', mimeType: 'video/mp4', sceneId: actSceneId},
  });
  store.dispatch({type: 'agent/message-add', text: 'scoped message', role: 'user', sceneId: actSceneId});

  const reloaded = createProjectStore({storage, ...createDependencies()}).getProject();
  const storyboard = reloaded.storyboard;
  assert.equal(storyboard.styleId, 'style-1');
  assert.equal(storyboard.visualStyle, 'Hand-painted 2D animation, dusk palette.');
  assert.equal(storyboard.zoom, 1.4);
  assert.deepEqual(storyboard.pan, {x: -40, y: 12});
  const act = storyboard.nodes.find((node) => node.kind === 'act');
  assert.equal(act.sceneId, actSceneId);
  assert.equal(act.beats.length, 2);
  assert.equal(act.beats[0].text, 'legacy string beat');
  assert.deepEqual(act.beats[1].mentions, {Mara: 'character-1'});
  assert.equal(act.stills[0].status, 'generating');
  assert.equal(reloaded.mediaAssets.find((asset) => asset.id === imported.affectedId).sceneId, actSceneId);
  assert.equal(reloaded.agentWorkspace.messages.at(-1).sceneId, actSceneId);
});

test('migrates legacy storyboard beats into positioned linked beat workspaces', () => {
  const store = createProjectStore({storage: new MemoryStorage(), ...createDependencies()});
  const sceneId = store.getProject().scenes[0].id;
  const stillAssetId = store.dispatch({
    type: 'asset/import',
    asset: {name: 'legacy-act-still.png', kind: 'image', mimeType: 'image/png', sceneId},
  }).affectedId;

  store.dispatch({
    type: 'storyboard/update',
    storyboard: {
      schemaVersion: 1,
      styleId: 'story-circle',
      nodes: [{
        id: 'act-node', kind: 'act', actNumber: 1, sceneId, title: 'Departure', summary: 'The tide turns.',
        beats: [
          {id: 'beat-one', text: 'The bell rings.', mentions: {}},
          {id: 'beat-two', text: 'Mara boards the ferry.', mentions: {}},
        ],
        stills: [{
          id: 'legacy-still', assetId: stillAssetId, beatIds: ['beat-one', 'beat-two'],
          prompt: 'A harbor at dawn', status: 'ready',
        }],
      }],
    },
  });

  const storyboard = store.getProject().storyboard;
  const act = storyboard.nodes[0];
  assert.equal(storyboard.schemaVersion, STORYBOARD_SCHEMA_VERSION);
  assert.deepEqual(act.connections.map(({fromBeatId, toBeatId}) => [fromBeatId, toBeatId]), [
    ['beat-one', 'beat-two'],
  ]);
  assert.ok(act.beats.every((beat) => Number.isFinite(beat.layout.x) && Number.isFinite(beat.layout.y)));
  assert.deepEqual(act.beats.map((beat) => beat.hero?.assetId), [stillAssetId, stillAssetId]);
  assert.deepEqual(act.beats.map((beat) => beat.screenplay), [null, null]);
});

test('storyboard act saves replace the whole draft atomically and reject dangling links', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const sceneId = store.getProject().scenes[0].id;
  const heroAssetId = store.dispatch({
    type: 'asset/import',
    asset: {name: 'beat-hero.png', kind: 'image', mimeType: 'image/png', sceneId},
  }).affectedId;
  store.dispatch({
    type: 'storyboard/update',
    storyboard: {nodes: [{
      id: 'act-node', kind: 'act', actNumber: 1, sceneId, title: 'Departure', summary: 'Old summary',
      beats: [{id: 'beat-one', text: 'Old beat', mentions: {}}], connections: [],
    }]},
  });

  const saved = store.dispatch({
    type: 'storyboard/act-save',
    actId: 'act-node',
    act: {
      ...store.getProject().storyboard.nodes[0],
      title: 'The Impossible Tide',
      summary: 'Mara follows the water into the sky.',
      beats: [
        {
          id: 'beat-one', text: 'The tide rises.', mentions: {Mara: 'character-mara'}, layout: {x: 40, y: 60},
          hero: {assetId: heroAssetId, prompt: 'A cinematic rising tide', characterVersionIds: []},
          screenplay: {text: 'EXT. HARBOR — DAWN\nThe tide rises into the clouds.', modelId: 'google/gemini-2.5-flash'},
          videoPrompt: {
            text: '00:00 - 00:04 @Image1 follows the rising tide.',
            duration: 4,
            modelId: 'google/gemini-2.5-flash',
            generatedAt: '2026-07-18T22:00:00.000Z',
            editedAt: '2026-07-18T22:01:00.000Z',
          },
          stillContext: {
            hiddenItemIds: ['previous-still', 'character:character-pip'],
            overrides: {'target:screenplay': 'MARA: The sky is an ocean now.'},
          },
        },
        {id: 'beat-two', text: 'Mara follows.', mentions: {}, layout: {x: 420, y: 60}},
      ],
      connections: [{id: 'link-one-two', fromBeatId: 'beat-one', toBeatId: 'beat-two'}],
    },
  });
  const act = saved.project.storyboard.nodes[0];
  assert.equal(saved.affectedId, 'act-node');
  assert.equal(act.title, 'The Impossible Tide');
  assert.equal(act.beats[0].hero.assetId, heroAssetId);
  assert.match(act.beats[0].screenplay.text, /EXT\. HARBOR/);
  assert.match(act.beats[0].videoPrompt.text, /@Image1/);
  assert.equal(act.beats[0].videoPrompt.duration, 4);
  assert.deepEqual(act.beats[0].stillContext, {
    hiddenItemIds: ['previous-still', 'character:character-pip'],
    overrides: {'target:screenplay': 'MARA: The sky is an ocean now.'},
  });
  assert.deepEqual(act.connections, [{id: 'link-one-two', fromBeatId: 'beat-one', toBeatId: 'beat-two'}]);

  const beforeInvalidSave = JSON.stringify(store.getProject().storyboard.nodes[0]);
  assert.throws(() => store.dispatch({
    type: 'storyboard/act-save',
    actId: 'act-node',
    act: {...act, connections: [{id: 'dangling', fromBeatId: 'beat-one', toBeatId: 'missing-beat'}]},
  }), /connection.*missing beat/i);
  assert.equal(JSON.stringify(store.getProject().storyboard.nodes[0]), beforeInvalidSave);
  assert.equal(JSON.parse(storage.getItem(PROJECT_STORAGE_KEY)).storyboard.nodes[0].title, 'The Impossible Tide');
  assert.match(JSON.parse(storage.getItem(PROJECT_STORAGE_KEY)).storyboard.nodes[0].beats[0].videoPrompt.text, /rising tide/);
});

test('removing a character clears storyboard mention bindings but preserves prose and generated heroes', () => {
  const store = createProjectStore({storage: new MemoryStorage(), ...createDependencies()});
  const characterId = store.dispatch({type: 'character/create', name: 'Mara'}).affectedId;
  const sceneId = store.getProject().scenes[0].id;
  const heroAssetId = store.dispatch({
    type: 'asset/import',
    asset: {name: 'Mara hero.png', kind: 'image', mimeType: 'image/png', sceneId},
  }).affectedId;
  store.dispatch({
    type: 'storyboard/update',
    storyboard: {nodes: [{
      id: 'act-node', kind: 'act', actNumber: 1, sceneId, title: 'Departure', summary: '',
      beats: [{
        id: 'beat-one', text: '@Mara leaves the harbor.', mentions: {Mara: characterId},
        hero: {assetId: heroAssetId, prompt: 'Mara at the harbor'},
      }],
      connections: [],
    }]},
  });

  store.dispatch({type: 'character/remove', characterId});

  const beat = store.getProject().storyboard.nodes[0].beats[0];
  assert.equal(beat.text, '@Mara leaves the harbor.');
  assert.deepEqual(beat.mentions, {});
  assert.equal(beat.hero.assetId, heroAssetId);
});

test('scene/add, timeline/set-active-scene, and scene/remove reassign scoped content', () => {
  const storage = new MemoryStorage();
  const store = createProjectStore({storage, ...createDependencies()});
  const defaultSceneId = store.getProject().scenes[0].id;
  const actSceneId = store.dispatch({type: 'scene/add', scene: {name: 'Act 2'}}).affectedId;

  store.dispatch({type: 'timeline/set-active-scene', sceneId: actSceneId});
  assert.equal(store.getProject().timeline.activeSceneId, actSceneId);

  const assetId = store.dispatch({
    type: 'asset/import',
    asset: {name: 'clip.mp4', kind: 'video', mimeType: 'video/mp4', sceneId: actSceneId},
  }).affectedId;
  const clipId = store.dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 0, duration: 4}).affectedId;
  assert.equal(store.getProject().timeline.clips.find((clip) => clip.id === clipId).sceneId, actSceneId);

  store.dispatch({type: 'scene/remove', sceneId: actSceneId});
  const project = store.getProject();
  assert.equal(project.scenes.length, 1);
  assert.equal(project.timeline.activeSceneId, defaultSceneId);
  assert.equal(project.timeline.clips.find((clip) => clip.id === clipId).sceneId, defaultSceneId);
  assert.equal(project.mediaAssets.find((asset) => asset.id === assetId).sceneId, defaultSceneId);
  assert.throws(() => store.dispatch({type: 'scene/remove', sceneId: defaultSceneId}), /at least one scene/);
});

test('clip/add accepts an explicit act and removing a later act falls back to the previous act', () => {
  const store = createProjectStore({storage: new MemoryStorage(), ...createDependencies()});
  const act1 = store.getProject().scenes[0].id;
  const act2 = store.dispatch({type: 'scene/add', scene: {name: 'Act 2', metadata: {actNumber: 2}}}).affectedId;
  const act3 = store.dispatch({type: 'scene/add', scene: {name: 'Act 3', metadata: {actNumber: 3}}}).affectedId;
  store.dispatch({type: 'timeline/set-active-scene', sceneId: act3});
  const assetId = store.dispatch({type: 'asset/import', asset: {name: 'global.png', kind: 'image'}}).affectedId;
  const clipId = store.dispatch({type: 'clip/add', assetId, trackId: 'V1', start: 1, sceneId: act1}).affectedId;
  assert.equal(store.getProject().timeline.clips.find((clip) => clip.id === clipId).sceneId, act1);

  store.dispatch({
    type: 'storyboard/update',
    storyboard: {
      nodes: [
        {id: 'act-node-1', kind: 'act', actNumber: 1, sceneId: act1, title: 'Act 1'},
        {id: 'act-node-2', kind: 'act', actNumber: 2, sceneId: act2, title: 'Act 2'},
        {id: 'act-node-3', kind: 'act', actNumber: 3, sceneId: act3, title: 'Act 3'},
      ],
    },
  });
  store.dispatch({type: 'scene/remove', sceneId: act3});
  const project = store.getProject();
  assert.equal(project.timeline.activeSceneId, act2);
  assert.deepEqual(project.storyboard.nodes.filter((node) => node.kind === 'act').map((node) => node.sceneId), [act1, act2]);
});
