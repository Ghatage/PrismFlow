import assert from 'node:assert/strict';
import test from 'node:test';

import {resolveTimelinePlaybackAt} from '../src/timeline-playback.js';

const tracks = [
  {id: 'V2', name: 'Video 2', kind: 'video', order: 0},
  {id: 'V1', name: 'Video 1', kind: 'video', order: 1},
  {id: 'A1', name: 'Audio 1', kind: 'audio', order: 2},
  {id: 'A2', name: 'Audio 2', kind: 'audio', order: 3},
];

const mediaAssets = [
  {id: 'visual-top', kind: 'image', name: 'Top still', url: 'https://media.test/top.png'},
  {id: 'visual-lower', kind: 'video', name: 'Lower video', url: 'https://media.test/lower.mp4'},
  {id: 'visual-offline', kind: 'image', name: 'Offline still', url: null},
  {id: 'audio-one', kind: 'audio', name: 'Dialogue', url: 'https://media.test/dialogue.wav'},
  {id: 'audio-two', kind: 'audio', name: 'Music', url: 'https://media.test/music.wav'},
];

const clip = (id, assetId, trackId, start = 0, duration = 5) => ({
  id,
  assetId,
  trackId,
  start,
  duration,
});

test('selects the active visual from the topmost displayed video track', () => {
  const lower = clip('clip-lower', 'visual-lower', 'V1', 0, 8);
  const top = clip('clip-top', 'visual-top', 'V2', 2, 3);

  const overlap = resolveTimelinePlaybackAt({
    time: 3,
    tracks,
    mediaAssets,
    // Deliberately put the lower clip first: clip insertion order is not z-order.
    clips: [lower, top],
  });
  assert.equal(overlap.visual?.clip.id, 'clip-top');
  assert.equal(overlap.visual?.media.id, 'visual-top');

  const afterTopEnds = resolveTimelinePlaybackAt({
    time: 5,
    tracks,
    mediaAssets,
    clips: [lower, top],
  });
  assert.equal(afterTopEnds.visual?.clip.id, 'clip-lower');
});

test('falls through an offline top track to the next playable visual', () => {
  const result = resolveTimelinePlaybackAt({
    time: 1,
    tracks,
    mediaAssets,
    clips: [
      clip('offline-top', 'visual-offline', 'V2'),
      clip('playable-lower', 'visual-lower', 'V1'),
    ],
  });

  assert.equal(result.visual?.clip.id, 'playable-lower');
});

test('returns every active audio entry in displayed track order alongside the visual', () => {
  const result = resolveTimelinePlaybackAt({
    time: 2,
    tracks,
    mediaAssets,
    clips: [
      clip('music', 'audio-two', 'A2'),
      clip('lower-visual', 'visual-lower', 'V1'),
      clip('dialogue', 'audio-one', 'A1'),
      clip('top-visual', 'visual-top', 'V2'),
    ],
  });

  assert.equal(result.visual?.clip.id, 'top-visual');
  assert.deepEqual(result.audio.map(({clip: activeClip}) => activeClip.id), ['dialogue', 'music']);
  assert.deepEqual(result.audio.map(({media}) => media.id), ['audio-one', 'audio-two']);
});

test('returns an empty playback state in gaps and at a clip exclusive end', () => {
  const clips = [
    clip('visual', 'visual-top', 'V2', 2, 2),
    clip('audio', 'audio-one', 'A1', 2, 2),
  ];

  assert.deepEqual(resolveTimelinePlaybackAt({time: 1, tracks, mediaAssets, clips}), {
    visual: null,
    audio: [],
  });
  assert.deepEqual(resolveTimelinePlaybackAt({time: 4, tracks, mediaAssets, clips}), {
    visual: null,
    audio: [],
  });
});

test('ignores invalid clips and missing media with deterministic fallbacks and ordering', () => {
  const suppliedClips = [
    clip('missing-top', 'missing-media', 'V2'),
    clip('invalid-top', 'visual-top', 'V2', Number.NaN, 5),
    clip('zero-duration-audio', 'audio-one', 'A1', 0, 0),
    clip('music-z', 'audio-two', 'A2'),
    clip('valid-lower', 'visual-lower', 'V1'),
    clip('dialogue', 'audio-one', 'A1'),
    clip('music-a', 'audio-two', 'A2'),
  ];
  const original = structuredClone(suppliedClips);

  const first = resolveTimelinePlaybackAt({time: 1, tracks, mediaAssets, clips: suppliedClips});
  const second = resolveTimelinePlaybackAt({time: 1, tracks, mediaAssets, clips: suppliedClips});

  assert.equal(first.visual?.clip.id, 'valid-lower');
  assert.deepEqual(first.audio.map(({clip: activeClip}) => activeClip.id), [
    'dialogue',
    'music-z',
    'music-a',
  ]);
  assert.deepEqual(second, first);
  assert.deepEqual(suppliedClips, original);
});

test('uses the caller-supplied clip set without consulting accepted timeline state', () => {
  const acceptedClips = [clip('accepted-lower', 'visual-lower', 'V1')];
  const proposalClips = [
    ...acceptedClips,
    clip('proposed-top', 'visual-top', 'V2'),
    clip('proposed-audio', 'audio-one', 'A1'),
  ];

  const accepted = resolveTimelinePlaybackAt({time: 1, tracks, mediaAssets, clips: acceptedClips});
  const proposal = resolveTimelinePlaybackAt({time: 1, tracks, mediaAssets, clips: proposalClips});

  assert.equal(accepted.visual?.clip.id, 'accepted-lower');
  assert.deepEqual(accepted.audio, []);
  assert.equal(proposal.visual?.clip.id, 'proposed-top');
  assert.deepEqual(proposal.audio.map(({clip: activeClip}) => activeClip.id), ['proposed-audio']);
});
