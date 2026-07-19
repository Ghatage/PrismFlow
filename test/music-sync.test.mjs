import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bestAlignmentOffset,
  detectBeats,
  monoSamples,
  scoreClipPlacements,
} from '../src/music-sync.js';

// Synthesizes a click track: decaying noise bursts on a fixed beat grid over
// near-silence, the shape a percussive underscore presents to onset detection.
const clickTrack = ({bpm = 120, seconds = 8, sampleRate = 22050, startMs = 0} = {}) => {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  const beatGap = (60 / bpm) * sampleRate;
  for (let index = 0; index < samples.length; index += 1) samples[index] = (Math.sin(index * 12.9898) % 1) * 0.002;
  const expected = [];
  for (let beat = Math.round((startMs / 1000) * sampleRate); beat < samples.length; beat += Math.round(beatGap)) {
    expected.push(Math.round((beat / sampleRate) * 1000));
    for (let index = 0; index < 900 && beat + index < samples.length; index += 1) {
      samples[beat + index] += Math.sin(index * 0.9) * Math.exp(-index / 180) * 0.9;
    }
  }
  return {samples, sampleRate, expected};
};

test('detectBeats finds the clicks of a synthetic click track', () => {
  const {samples, sampleRate, expected} = clickTrack({bpm: 120, seconds: 8});
  const beats = detectBeats(samples, sampleRate);
  assert.ok(beats.length >= expected.length - 1, `found ${beats.length} of ${expected.length} beats`);
  for (const beat of beats) {
    const nearest = Math.min(...expected.map((time) => Math.abs(time - beat)));
    assert.ok(nearest <= 60, `beat at ${beat}ms is ${nearest}ms from the grid`);
  }
});

test('detectBeats returns nothing for silence', () => {
  assert.deepEqual(detectBeats(new Float32Array(22050), 22050), []);
});

test('bestAlignmentOffset recovers a known shift between hits and beats', () => {
  const beats = [500, 1000, 1500, 2000, 2500];
  const hits = [1120, 2120]; // beats shifted 120ms late
  const result = bestAlignmentOffset(hits, beats, {maxShiftMs: 300, stepMs: 5});
  assert.equal(result.offsetMs, 120);
  assert.ok(result.meanAbsErrorMs <= 5);
  assert.equal(result.alignments.length, 2);
});

test('bestAlignmentOffset stays neutral without hits or beats', () => {
  assert.deepEqual(bestAlignmentOffset([], [100]), {offsetMs: 0, meanAbsErrorMs: null, alignments: []});
  assert.deepEqual(bestAlignmentOffset([100], []), {offsetMs: 0, meanAbsErrorMs: null, alignments: []});
});

test('monoSamples averages stereo channels', () => {
  const buffer = {
    numberOfChannels: 2,
    length: 3,
    getChannelData: (channel) => channel === 0 ? Float32Array.from([1, 0, -1]) : Float32Array.from([0, 1, -1]),
  };
  assert.deepEqual([...monoSamples(buffer)], [0.5, 0.5, -1]);
});

test('scoreClipPlacements windows one audio file across scene-local clips', () => {
  const placements = scoreClipPlacements({
    scenes: [
      {sceneId: 'scene-1', offsetSec: 0, lengthSec: 10},
      {sceneId: 'scene-2', offsetSec: 10, lengthSec: 6},
      {sceneId: 'empty', offsetSec: 16, lengthSec: 0},
    ],
    audioDurationSec: 16,
  });
  assert.deepEqual(placements, [
    {sceneId: 'scene-1', start: 0, sourceStart: 0, duration: 10},
    {sceneId: 'scene-2', start: 0, sourceStart: 10, duration: 6},
  ]);
});

test('scoreClipPlacements delays the score into the timeline for positive offsets', () => {
  const placements = scoreClipPlacements({
    scenes: [{sceneId: 'scene-1', offsetSec: 0, lengthSec: 10}, {sceneId: 'scene-2', offsetSec: 10, lengthSec: 6}],
    audioDurationSec: 16,
    musicDelaySec: 0.25,
  });
  assert.equal(placements[0].start, 0.25);
  assert.equal(placements[0].sourceStart, 0);
  assert.equal(placements[0].duration, 9.75);
  assert.equal(placements[1].sourceStart, 9.75);
  assert.equal(placements[1].duration, 6);
});

test('scoreClipPlacements trims the audio head for negative offsets', () => {
  const placements = scoreClipPlacements({
    scenes: [{sceneId: 'scene-1', offsetSec: 0, lengthSec: 10}],
    audioDurationSec: 16,
    musicDelaySec: -0.3,
  });
  assert.deepEqual(placements, [{sceneId: 'scene-1', start: 0, sourceStart: 0.3, duration: 10}]);
});
