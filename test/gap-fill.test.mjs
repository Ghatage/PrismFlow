import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FILL_GAP_DURATION,
  FILL_GAP_MODEL_ID,
  FILL_GAP_TRANSITION_KEY,
  buildGapFillPrompt,
  buildGapFillPromptMessages,
  findGapFillPair,
  gapFillCaptureTimes,
  gapFillShiftPlan,
} from '../src/gap-fill.js';

const clips = () => [
  {id: 'clip-a', trackId: 'V1', sceneId: 'scene-1', start: 0, duration: 6, sourceStart: 0},
  {id: 'clip-b', trackId: 'V1', sceneId: 'scene-1', start: 8, duration: 5, sourceStart: 1.5},
  {id: 'clip-c', trackId: 'V1', sceneId: 'scene-1', start: 13, duration: 4, sourceStart: 0},
  {id: 'clip-audio', trackId: 'A1', sceneId: 'scene-1', start: 0, duration: 20, sourceStart: 0},
];

test('gap fill constants pin the first-last-frame model at its minimum duration', () => {
  assert.equal(FILL_GAP_TRANSITION_KEY, 'fill-gap');
  assert.equal(FILL_GAP_MODEL_ID, 'fal-ai/veo3.1/fast/first-last-frame-to-video');
  assert.equal(FILL_GAP_DURATION, 4);
});

test('findGapFillPair picks the junction nearest the drop, including real gaps', () => {
  assert.deepEqual(findGapFillPair({clips: clips(), trackId: 'V1', time: 7}), {
    fromClipId: 'clip-a', toClipId: 'clip-b', gap: 2,
  });
  assert.deepEqual(findGapFillPair({clips: clips(), trackId: 'V1', time: 12.9}), {
    fromClipId: 'clip-b', toClipId: 'clip-c', gap: 0,
  });
  assert.equal(findGapFillPair({clips: clips(), trackId: 'A1', time: 5}), null);
  assert.equal(findGapFillPair({clips: [clips()[0]], trackId: 'V1', time: 5}), null);
});

test('findGapFillPair skips overlapping neighbors instead of bridging into them', () => {
  const overlapping = [
    {id: 'clip-a', trackId: 'V1', sceneId: 'scene-1', start: 0, duration: 6},
    {id: 'clip-overlap', trackId: 'V1', sceneId: 'scene-1', start: 4, duration: 6},
    {id: 'clip-c', trackId: 'V1', sceneId: 'scene-1', start: 12, duration: 4},
  ];
  assert.deepEqual(findGapFillPair({clips: overlapping, trackId: 'V1', time: 3}), {
    fromClipId: 'clip-overlap', toClipId: 'clip-c', gap: 2,
  });
});

test('gapFillCaptureTimes lands just inside each clip trim window', () => {
  const [fromClip, toClip] = clips();
  const times = gapFillCaptureTimes({fromClip, toClip: clips()[1]});
  assert.ok(Math.abs(times.fromTime - 5.95) < 1e-9);
  assert.ok(Math.abs(times.toTime - 1.55) < 1e-9);
  assert.throws(() => gapFillCaptureTimes({fromClip, toClip: null}), /both boundary clips/);
});

test('buildGapFillPrompt anchors both frames, the style bible, and the no-music rule', () => {
  const prompt = buildGapFillPrompt({
    styleBible: 'Hand-painted 2D animation, dusk palette.',
    fromText: 'Mara boards the ferry.',
    toText: 'The ferry meets the rising tide.',
  });
  assert.match(prompt, /begins exactly on the supplied first frame/i);
  assert.match(prompt, /ends exactly on the supplied last frame/i);
  assert.match(prompt, /Hand-painted 2D animation/);
  assert.match(prompt, /Outgoing moment: Mara boards the ferry\./);
  assert.match(prompt, /Incoming moment: The ferry meets the rising tide\./);
  assert.match(prompt, /No music or musical score/i);
  assert.doesNotMatch(buildGapFillPrompt({}), /Outgoing moment|Incoming moment|style bible/i);
});

test('buildGapFillPromptMessages hands the LLM both neighboring video prompts and the frame-pinning contract', () => {
  const messages = buildGapFillPromptMessages({
    styleBible: 'Hand-painted 2D animation.',
    fromBeat: {text: 'Mara boards the ferry.', videoPrompt: '00:00 - 00:04 Mara steps aboard as gulls scatter.'},
    toBeat: {text: 'The tide rises.', videoPrompt: '00:00 - 00:04 The ferry lifts on the impossible tide.'},
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /4-second connecting shot/);
  assert.match(messages[0].content, /pins the exact first frame/i);
  assert.match(messages[0].content, /Never request music/i);
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /Hand-painted 2D animation/);
  assert.match(messages[1].content, /Outgoing shot's video prompt:\n00:00 - 00:04 Mara steps aboard/);
  assert.match(messages[1].content, /Incoming shot's video prompt:\n00:00 - 00:04 The ferry lifts/);
});

test('gapFillShiftPlan pushes the incoming clip chain right, rightmost first, and never pulls left', () => {
  const moves = gapFillShiftPlan({
    clips: clips(),
    toClipId: 'clip-b',
    fillStart: 6,
    fillDuration: 4,
    excludeClipId: 'clip-fill',
  });
  assert.deepEqual(moves, [
    {clipId: 'clip-c', trackId: 'V1', start: 15},
    {clipId: 'clip-b', trackId: 'V1', start: 10},
  ]);
  // A gap already wider than the fill needs no moves.
  assert.deepEqual(gapFillShiftPlan({clips: clips(), toClipId: 'clip-b', fillStart: 2, fillDuration: 4}), []);
  // The freshly landed fill clip itself is never shifted.
  const withFill = [...clips(), {id: 'clip-fill', trackId: 'V1', sceneId: 'scene-1', start: 8, duration: 4}];
  const excluded = gapFillShiftPlan({
    clips: withFill, toClipId: 'clip-b', fillStart: 8, fillDuration: 4, excludeClipId: 'clip-fill',
  });
  assert.ok(!excluded.some((move) => move.clipId === 'clip-fill'));
  assert.deepEqual(gapFillShiftPlan({clips: clips(), toClipId: 'missing', fillStart: 6, fillDuration: 4}), []);
});
