import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUILT_IN_TRANSITIONS,
  TRANSITION_TYPES,
  applyTransitionStyles,
  buildTransitionGenerationMessages,
  createTransitionKey,
  getTransitionDefinition,
  interpolateTrackValue,
  validateTransitionDefinition,
} from '../src/transitions.js';

const fakeElement = () => ({style: {}});

const customDefinition = () => ({
  key: 'iris-open',
  label: 'Iris open',
  glyph: '◎',
  defaultDuration: 1.2,
  mode: 'blend',
  tracks: [
    {target: 'layerB', property: 'opacity', keyframes: [{at: 0, value: '1'}, {at: 1, value: '1'}]},
    {target: 'layerB', property: 'clipPath', keyframes: [{at: 0, value: 'circle(0% at 50% 50%)'}, {at: 1, value: 'circle(75% at 50% 50%)'}]},
  ],
});

test('TRANSITION_TYPES is derived from the built-in definitions', () => {
  assert.deepEqual(Object.keys(TRANSITION_TYPES), Object.keys(BUILT_IN_TRANSITIONS));
  assert.equal(TRANSITION_TYPES['wipe-left'].defaultDuration, 0.8);
  assert.equal(TRANSITION_TYPES['crossfade'].label, 'Crossfade');
});

test('every built-in definition passes its own validator', () => {
  for (const definition of Object.values(BUILT_IN_TRANSITIONS)) {
    const result = validateTransitionDefinition(definition);
    assert.equal(result.ok, true, `${definition.key}: ${result.errors.join('; ')}`);
  }
});

test('getTransitionDefinition resolves built-ins and custom definitions', () => {
  assert.equal(getTransitionDefinition('crossfade').key, 'crossfade');
  assert.equal(getTransitionDefinition('iris-open'), null);
  assert.equal(getTransitionDefinition('iris-open', [customDefinition()]).label, 'Iris open');
});

test('interpolation lerps every number and matches the legacy hardcoded styles', () => {
  const wipe = BUILT_IN_TRANSITIONS['wipe-left'].tracks.find((track) => track.property === 'clipPath');
  assert.equal(interpolateTrackValue(wipe, 0.25), 'inset(0 0 0 75%)');
  const slide = BUILT_IN_TRANSITIONS['slide-right'].tracks.find((track) => track.property === 'transform');
  assert.equal(interpolateTrackValue(slide, 0.5), 'translateX(-50%)');
  const dip = BUILT_IN_TRANSITIONS['dip-to-black'].tracks[0];
  assert.equal(interpolateTrackValue(dip, 0.25), '0.5');
  assert.equal(interpolateTrackValue(dip, 0.5), '1');
  assert.equal(interpolateTrackValue(dip, 0.75), '0.5');
  const iris = customDefinition().tracks[1];
  assert.equal(interpolateTrackValue(iris, 0.5), 'circle(37.5% at 50% 50%)');
});

test('applyTransitionStyles writes tracks to the right elements', () => {
  const layer = fakeElement();
  const fade = fakeElement();
  applyTransitionStyles(BUILT_IN_TRANSITIONS['wipe-left'], 0.5, {layer, fade});
  assert.equal(layer.style.opacity, '1');
  assert.equal(layer.style.clipPath, 'inset(0 0 0 50%)');
  assert.equal(fade.style.opacity, undefined);
  applyTransitionStyles(BUILT_IN_TRANSITIONS['dip-to-black'], 0.5, {layer: null, fade});
  assert.equal(fade.style.opacity, '1');
});

test('validator rejects malformed and unsafe definitions', () => {
  assert.equal(validateTransitionDefinition(null).ok, false);
  assert.equal(validateTransitionDefinition({...customDefinition(), mode: 'spin'}).ok, false);
  const skewed = customDefinition();
  skewed.tracks[1].keyframes[1].value = 'ellipse(75% 40%)';
  assert.match(validateTransitionDefinition(skewed).errors.join(' '), /only the numbers changed/);
  const unsafe = customDefinition();
  unsafe.tracks[1].keyframes = [{at: 0, value: 'url(x)'}, {at: 1, value: 'url(y)'}];
  assert.equal(validateTransitionDefinition(unsafe).ok, false);
  const fadeFilter = customDefinition();
  fadeFilter.tracks = [{target: 'fade', property: 'filter', keyframes: [{at: 0, value: 'blur(0px)'}, {at: 1, value: 'blur(4px)'}]}];
  assert.match(validateTransitionDefinition(fadeFilter).errors.join(' '), /fade tracks may only animate opacity/);
  const dipLayer = {...customDefinition(), mode: 'dip'};
  assert.match(validateTransitionDefinition(dipLayer).errors.join(' '), /dip transitions may only target fade/);
});

test('createTransitionKey slugifies and avoids collisions with built-ins', () => {
  assert.equal(createTransitionKey('Iris Open!', []), 'custom-iris-open');
  assert.equal(createTransitionKey('Crossfade', []), 'custom-crossfade');
  assert.equal(createTransitionKey('Iris Open', ['custom-iris-open']), 'custom-iris-open-2');
});

test('generation messages carry the schema, examples, and taken keys', () => {
  const messages = buildTransitionGenerationMessages({name: 'Iris open', prompt: 'circle reveal', existingKeys: ['custom-glow']});
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /ONLY a single JSON object/);
  assert.match(messages[0].content, /"key": "wipe-left"/);
  assert.match(messages[0].content, /custom-glow/);
  assert.match(messages[1].content, /Iris open/);
});
