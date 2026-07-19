import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SECTION_MS,
  MIN_SECTION_MS,
  barDurationMs,
  buildElevenLabsMusicInput,
  buildScoreContext,
  buildSingleMusicPrompt,
  clampBpm,
  normalizeCueSheet,
  quantizeSectionsToBars,
} from '../src/score-direction.js';

const rawCueSheet = (overrides = {}) => ({
  global: {
    genre: 'neo-noir orchestral electronic',
    bpm: 96,
    key: 'D minor',
    instrumentation: ['felt piano', 'taiko'],
    moodArc: 'curiosity to release',
  },
  sections: [
    {name: 'Opening', startMs: 4000, intensity: 3, description: 'sparse piano', transition: 'swell'},
    {name: 'Build', startMs: 22000, intensity: 7, description: 'strings build', transition: 'drop'},
  ],
  hitPoints: [{timeMs: 22000, kind: 'reveal', treatment: 'low brass hit'}],
  ...overrides,
});

test('normalizeCueSheet makes sections contiguous over the full duration', () => {
  const cueSheet = normalizeCueSheet(rawCueSheet(), {durationMs: 60000});
  assert.equal(cueSheet.durationMs, 60000);
  assert.equal(cueSheet.sections[0].startMs, 0);
  assert.equal(cueSheet.sections[0].endMs, 22000);
  assert.equal(cueSheet.sections[1].startMs, 22000);
  assert.equal(cueSheet.sections[1].endMs, 60000);
  assert.equal(cueSheet.hitPoints.length, 1);
  assert.equal(cueSheet.hitPoints[0].kind, 'reveal');
});

test('normalizeCueSheet merges sections shorter than the model minimum', () => {
  const cueSheet = normalizeCueSheet(rawCueSheet({
    sections: [
      {name: 'A', startMs: 0, intensity: 3, description: 'a', transition: 'sustain'},
      {name: 'Tiny', startMs: 10000, intensity: 5, description: 'tiny', transition: 'cut'},
      {name: 'B', startMs: 11000, intensity: 7, description: 'b', transition: 'decay'},
    ],
  }), {durationMs: 30000});
  assert.ok(cueSheet.sections.every((section) => section.endMs - section.startMs >= MIN_SECTION_MS));
  assert.equal(cueSheet.sections[0].endMs, cueSheet.sections[1].startMs);
  assert.equal(cueSheet.sections.at(-1).endMs, 30000);
});

test('normalizeCueSheet splits sections longer than the model maximum', () => {
  const cueSheet = normalizeCueSheet(rawCueSheet({
    sections: [{name: 'Long', startMs: 0, intensity: 5, description: 'long haul', transition: 'decay'}],
  }), {durationMs: 300000});
  assert.ok(cueSheet.sections.length >= 3);
  assert.ok(cueSheet.sections.every((section) => section.endMs - section.startMs <= MAX_SECTION_MS));
  assert.equal(cueSheet.sections[0].startMs, 0);
  assert.equal(cueSheet.sections.at(-1).endMs, 300000);
  assert.equal(cueSheet.sections.at(-1).transition, 'decay');
  assert.equal(cueSheet.sections[0].transition, 'sustain');
});

test('normalizeCueSheet survives garbage input with a single full-length section', () => {
  const cueSheet = normalizeCueSheet({sections: 'nope', hitPoints: [{timeMs: -5}]}, {durationMs: 20000});
  assert.equal(cueSheet.sections.length, 1);
  assert.equal(cueSheet.sections[0].startMs, 0);
  assert.equal(cueSheet.sections[0].endMs, 20000);
  assert.equal(cueSheet.hitPoints.length, 0);
  assert.equal(cueSheet.global.bpm, 96);
});

test('normalizeCueSheet rejects invalid durations', () => {
  assert.throws(() => normalizeCueSheet(rawCueSheet(), {durationMs: 1000}), /at least/);
  assert.throws(() => normalizeCueSheet(rawCueSheet(), {durationMs: 700000}), /at most/);
  assert.throws(() => normalizeCueSheet(rawCueSheet(), {}), /at least/);
});

test('clampBpm bounds and defaults the tempo', () => {
  assert.equal(clampBpm(300), 200);
  assert.equal(clampBpm(10), 50);
  assert.equal(clampBpm('not a number'), 96);
});

test('quantizeSectionsToBars snaps interior boundaries to bar lines', () => {
  const cueSheet = normalizeCueSheet(rawCueSheet({
    global: {...rawCueSheet().global, bpm: 120}, // bar = 2000ms
    sections: [
      {name: 'A', startMs: 0, intensity: 3, description: 'a', transition: 'swell'},
      {name: 'B', startMs: 21150, intensity: 7, description: 'b', transition: 'decay'},
    ],
  }), {durationMs: 60000});
  const quantized = quantizeSectionsToBars(cueSheet);
  const bar = barDurationMs(120);
  assert.equal(quantized.sections[1].startMs % bar, 0);
  assert.equal(quantized.sections[1].startMs, 22000);
  assert.equal(quantized.sections[0].endMs, quantized.sections[1].startMs);
});

test('buildElevenLabsMusicInput maps the cue sheet onto the composition plan contract', () => {
  const cueSheet = normalizeCueSheet(rawCueSheet(), {durationMs: 60000});
  const input = buildElevenLabsMusicInput(cueSheet);
  // The endpoint 422s when music_length_ms or force_instrumental accompany
  // composition_plan; empty lines + negative styles keep it instrumental.
  assert.equal(input.music_length_ms, undefined);
  assert.equal(input.force_instrumental, undefined);
  assert.equal(input.respect_sections_durations, true);
  assert.equal(input.respect_sections_durations, true);
  assert.ok(input.composition_plan.positive_global_styles.includes('96 BPM'));
  assert.ok(input.composition_plan.negative_global_styles.includes('vocals'));
  const sections = input.composition_plan.sections;
  assert.equal(sections.reduce((sum, section) => sum + section.duration_ms, 0), 60000);
  assert.ok(sections.every((section) => section.lines.length === 0));
  assert.ok(sections.every((section) => section.duration_ms >= MIN_SECTION_MS && section.duration_ms <= MAX_SECTION_MS));
  // The reveal hit lands at the start of section 2, so its accent is described there.
  assert.ok(sections[1].positive_local_styles.some((style) => style.includes('reveal accent')));
});

test('buildSingleMusicPrompt condenses the cue sheet with timestamps and hits', () => {
  const prompt = buildSingleMusicPrompt(normalizeCueSheet(rawCueSheet(), {durationMs: 60000}));
  assert.match(prompt, /neo-noir orchestral electronic/);
  assert.match(prompt, /96 BPM/);
  assert.match(prompt, /00:22.*reveal.*low brass hit/);
  assert.match(prompt, /No vocals/);
});

const scoreProject = () => ({
  project: {id: 'p1', name: 'The Glass Harbor', metadata: {theme: 'loss and return'}},
  storyboard: {
    narrative: {title: 'The Story Circle'},
    nodes: [
      {kind: 'act', sceneId: 'scene-1', title: 'Departure', summary: 'Mara leaves.', beats: [{text: 'Mara at the pier', screenplay: {text: 'EXT. PIER — DAWN'}}]},
      {kind: 'note', sceneId: 'scene-1', title: 'ignore me'},
      {kind: 'act', sceneId: 'scene-2', title: 'Return', summary: 'Mara returns.', beats: []},
    ],
  },
  mediaAssets: [
    {id: 'asset-1', kind: 'video', name: 'Pier shot', metadata: {prompt: 'a foggy pier'}},
    {id: 'asset-2', kind: 'video', name: 'Return shot', metadata: {}},
  ],
  timeline: {
    tracks: [{id: 'V1', kind: 'video'}, {id: 'A1', kind: 'audio'}],
    clips: [],
  },
});

test('buildScoreContext derives ordered segments, acts, and total duration', () => {
  const context = buildScoreContext({
    project: scoreProject(),
    clips: [
      {trackId: 'V1', assetId: 'asset-2', sceneId: 'scene-2', start: 8, duration: 6},
      {trackId: 'V1', assetId: 'asset-1', sceneId: 'scene-1', start: 0, duration: 8, provenance: {prompt: 'shot prompt wins'}},
      {trackId: 'A1', assetId: 'asset-1', sceneId: 'scene-1', start: 0, duration: 14},
    ],
    annotations: {'asset-1': 'A woman stands on a foggy pier.'},
  });
  assert.equal(context.project.name, 'The Glass Harbor');
  assert.equal(context.theme, 'loss and return');
  assert.equal(context.durationMs, 14000);
  assert.equal(context.segments.length, 2);
  assert.deepEqual(context.segments.map((segment) => segment.startMs), [0, 8000]);
  assert.equal(context.segments[0].prompt, 'shot prompt wins');
  assert.equal(context.segments[0].annotation, 'A woman stands on a foggy pier.');
  assert.equal(context.segments[1].prompt, '');
  assert.equal(context.acts.length, 2);
  assert.equal(context.acts[0].actCount, 2);
  assert.equal(context.acts[0].beats[0].screenplay, 'EXT. PIER — DAWN');
});

test('buildScoreContext requires video segments', () => {
  assert.throws(() => buildScoreContext({project: scoreProject(), clips: []}), /Add video clips/);
});
