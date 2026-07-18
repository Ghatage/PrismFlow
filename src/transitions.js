// Normalized transition definitions.
//
// TransitionDefinition = {
//   key: string,              // unique slug, e.g. "wipe-left", "custom-iris-open"
//   label: string,
//   glyph: string,            // card display character
//   defaultDuration: number,  // seconds, clamped 0.1–5
//   mode: "blend" | "dip",    // blend: window before the edge, layerB shows the incoming clip
//                             // dip: window centered on the edge, fade overlay only
//   tracks: [{
//     target: "layerB" | "fade",
//     property: "opacity" | "clipPath" | "transform" | "filter",  // fade: opacity only
//     keyframes: [{at: 0..1, value: "<CSS value>"}, ...]          // at ascending, first 0, last 1
//   }]
// }
//
// Interpolation: adjacent keyframe values must be the same CSS string with only the
// numbers differing; each number lerps linearly between keyframes. Definitions describe
// only clip-to-clip behavior — lone-edge attachments always render as a fade to/from black.

const NUMBER_PATTERN = /-?\d+(?:\.\d+)?/g;
const TRACK_TARGETS = new Set(['layerB', 'fade']);
const TRACK_PROPERTIES = new Set(['opacity', 'clipPath', 'transform', 'filter']);
const MAX_TRACKS = 6;
const MAX_KEYFRAMES = 12;
const MAX_VALUE_LENGTH = 200;

export const BUILT_IN_TRANSITIONS = {
  'crossfade': {
    key: 'crossfade', label: 'Crossfade', glyph: '◐', defaultDuration: 1, mode: 'blend',
    tracks: [
      {target: 'layerB', property: 'opacity', keyframes: [{at: 0, value: '0'}, {at: 1, value: '1'}]},
    ],
  },
  'dip-to-black': {
    key: 'dip-to-black', label: 'Dip to black', glyph: '●', defaultDuration: 1, mode: 'dip',
    tracks: [
      {target: 'fade', property: 'opacity', keyframes: [{at: 0, value: '0'}, {at: 0.5, value: '1'}, {at: 1, value: '0'}]},
    ],
  },
  'wipe-left': {
    key: 'wipe-left', label: 'Wipe left', glyph: '◧', defaultDuration: 0.8, mode: 'blend',
    tracks: [
      {target: 'layerB', property: 'opacity', keyframes: [{at: 0, value: '1'}, {at: 1, value: '1'}]},
      {target: 'layerB', property: 'clipPath', keyframes: [{at: 0, value: 'inset(0 0 0 100%)'}, {at: 1, value: 'inset(0 0 0 0%)'}]},
    ],
  },
  'wipe-right': {
    key: 'wipe-right', label: 'Wipe right', glyph: '◨', defaultDuration: 0.8, mode: 'blend',
    tracks: [
      {target: 'layerB', property: 'opacity', keyframes: [{at: 0, value: '1'}, {at: 1, value: '1'}]},
      {target: 'layerB', property: 'clipPath', keyframes: [{at: 0, value: 'inset(0 100% 0 0)'}, {at: 1, value: 'inset(0 0% 0 0)'}]},
    ],
  },
  'slide-left': {
    key: 'slide-left', label: 'Slide left', glyph: '⇤', defaultDuration: 0.8, mode: 'blend',
    tracks: [
      {target: 'layerB', property: 'opacity', keyframes: [{at: 0, value: '1'}, {at: 1, value: '1'}]},
      {target: 'layerB', property: 'transform', keyframes: [{at: 0, value: 'translateX(100%)'}, {at: 1, value: 'translateX(0%)'}]},
    ],
  },
  'slide-right': {
    key: 'slide-right', label: 'Slide right', glyph: '⇥', defaultDuration: 0.8, mode: 'blend',
    tracks: [
      {target: 'layerB', property: 'opacity', keyframes: [{at: 0, value: '1'}, {at: 1, value: '1'}]},
      {target: 'layerB', property: 'transform', keyframes: [{at: 0, value: 'translateX(-100%)'}, {at: 1, value: 'translateX(0%)'}]},
    ],
  },
};

export const TRANSITION_TYPES = Object.fromEntries(Object.values(BUILT_IN_TRANSITIONS).map(
  (definition) => [definition.key, {label: definition.label, defaultDuration: definition.defaultDuration}],
));

export const getTransitionDefinition = (type, customTransitions = []) =>
  BUILT_IN_TRANSITIONS[type] || customTransitions.find((definition) => definition && definition.key === type) || null;

const valueSkeleton = (value) => value.replace(NUMBER_PATTERN, '#');

const hasUnsafeValue = (value) =>
  value.length > MAX_VALUE_LENGTH || /[;<]|url\(|expression/i.test(value);

export const validateTransitionDefinition = (value) => {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {ok: false, definition: null, errors: ['definition must be a JSON object']};
  }
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  if (!label) errors.push('label must be a non-empty string');
  const glyph = typeof value.glyph === 'string' && value.glyph.trim() ? [...value.glyph.trim()].slice(0, 2).join('') : '✦';
  const defaultDuration = Number.isFinite(value.defaultDuration)
    ? Math.min(5, Math.max(0.1, value.defaultDuration))
    : 1;
  const mode = value.mode === 'dip' ? 'dip' : value.mode === 'blend' ? 'blend' : null;
  if (!mode) errors.push('mode must be "blend" or "dip"');
  const tracks = [];
  if (!Array.isArray(value.tracks) || !value.tracks.length || value.tracks.length > MAX_TRACKS) {
    errors.push(`tracks must be an array of 1–${MAX_TRACKS} tracks`);
  } else {
    value.tracks.forEach((track, index) => {
      const where = `tracks[${index}]`;
      if (!track || typeof track !== 'object') { errors.push(`${where} must be an object`); return; }
      if (!TRACK_TARGETS.has(track.target)) { errors.push(`${where}.target must be "layerB" or "fade"`); return; }
      if (!TRACK_PROPERTIES.has(track.property)) { errors.push(`${where}.property must be opacity, clipPath, transform, or filter`); return; }
      if (track.target === 'fade' && track.property !== 'opacity') { errors.push(`${where}: fade tracks may only animate opacity`); return; }
      if (mode === 'dip' && track.target !== 'fade') { errors.push(`${where}: dip transitions may only target fade`); return; }
      if (!Array.isArray(track.keyframes) || track.keyframes.length < 2 || track.keyframes.length > MAX_KEYFRAMES) {
        errors.push(`${where}.keyframes must be an array of 2–${MAX_KEYFRAMES} keyframes`);
        return;
      }
      const keyframes = [];
      for (let i = 0; i < track.keyframes.length; i += 1) {
        const frame = track.keyframes[i];
        const at = frame && Number.isFinite(frame.at) ? frame.at : NaN;
        const frameValue = frame && typeof frame.value === 'string' ? frame.value.trim() : '';
        if (!Number.isFinite(at) || at < 0 || at > 1) { errors.push(`${where}.keyframes[${i}].at must be a number between 0 and 1`); return; }
        if (i > 0 && at <= keyframes[i - 1].at) { errors.push(`${where}.keyframes must have strictly ascending "at" values`); return; }
        if (!frameValue || hasUnsafeValue(frameValue)) { errors.push(`${where}.keyframes[${i}].value must be a short plain CSS value`); return; }
        if (i > 0 && valueSkeleton(frameValue) !== valueSkeleton(keyframes[i - 1].value)) {
          errors.push(`${where}.keyframes[${i}].value must match the previous keyframe's value with only the numbers changed`);
          return;
        }
        keyframes.push({at, value: frameValue});
      }
      if (keyframes[0].at !== 0) errors.push(`${where}.keyframes must start at 0`);
      if (keyframes[keyframes.length - 1].at !== 1) errors.push(`${where}.keyframes must end at 1`);
      tracks.push({target: track.target, property: track.property, keyframes});
    });
  }
  if (errors.length) return {ok: false, definition: null, errors};
  const key = typeof value.key === 'string' && value.key.trim() ? value.key.trim() : '';
  return {ok: true, definition: {key, label, glyph, defaultDuration, mode, tracks}, errors: []};
};

const lerpValues = (fromValue, toValue, t) => {
  const toNumbers = toValue.match(NUMBER_PATTERN) || [];
  let index = 0;
  return fromValue.replace(NUMBER_PATTERN, (fromNumber) => {
    const from = Number(fromNumber);
    const to = Number(toNumbers[index]);
    index += 1;
    const mixed = Number.isFinite(to) ? from + (to - from) * t : from;
    return String(Math.round(mixed * 1000) / 1000);
  });
};

export const interpolateTrackValue = (track, progress) => {
  const keyframes = track.keyframes;
  if (progress <= keyframes[0].at) return keyframes[0].value;
  const last = keyframes[keyframes.length - 1];
  if (progress >= last.at) return last.value;
  for (let i = 1; i < keyframes.length; i += 1) {
    if (progress <= keyframes[i].at) {
      const from = keyframes[i - 1];
      const to = keyframes[i];
      const t = (progress - from.at) / (to.at - from.at);
      return lerpValues(from.value, to.value, t);
    }
  }
  return last.value;
};

export const applyTransitionStyles = (definition, progress, {layer, fade}) => {
  for (const track of definition.tracks) {
    const element = track.target === 'fade' ? fade : layer;
    if (!element) continue;
    element.style[track.property] = interpolateTrackValue(track, progress);
  }
};

export const createTransitionKey = (name, existingKeys) => {
  const taken = new Set([...Object.keys(BUILT_IN_TRANSITIONS), ...existingKeys]);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'transition';
  const base = `custom-${slug}`;
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
};

export const buildTransitionGenerationMessages = ({name, prompt, existingKeys = []}) => {
  const examples = JSON.stringify(Object.values(BUILT_IN_TRANSITIONS), null, 2);
  const taken = [...Object.keys(BUILT_IN_TRANSITIONS), ...existingKeys].join(', ');
  const system = [
    'You design video clip transitions for a browser editor. Reply with ONLY a single JSON object — no prose, no code fences.',
    '',
    'The JSON object must match this schema:',
    '- key: new kebab-case slug for the transition',
    '- label: short display name',
    '- glyph: a single unicode character that evokes the transition',
    '- defaultDuration: seconds, between 0.1 and 5',
    '- mode: "blend" (the incoming clip is revealed over the outgoing clip) or "dip" (the screen dips through black at the cut)',
    '- tracks: 1–6 animation tracks, each {target, property, keyframes}',
    '  - target: "layerB" (the incoming clip, stacked above the outgoing clip) or "fade" (a black overlay above both)',
    '  - property: "opacity", "clipPath", "transform", or "filter" ("fade" tracks may only use "opacity")',
    '  - keyframes: 2–12 entries of {at, value}; "at" is progress from 0 to 1, strictly ascending, first at 0 and last at 1; "value" is a plain CSS value string',
    '- mode "dip" may only use "fade" tracks; mode "blend" animates "layerB" (and optionally "fade")',
    '',
    'Interpolation rule: between adjacent keyframes, the value strings must be identical except for the numbers in them; each number is linearly interpolated. Example: "inset(0 0 0 100%)" → "inset(0 0 0 0%)".',
    'Rendering context: at progress 0 the outgoing clip must be fully visible; at progress 1 the incoming clip must be fully visible. If layerB starts fully covering the screen (opacity 1, no clip), the outgoing clip would be hidden immediately — use clipPath, transform, or opacity so layerB reveals gradually.',
    'Values must not contain semicolons, url(), or HTML.',
    '',
    'Examples — the built-in transitions:',
    examples,
    '',
    `Keys already taken: ${taken}. Choose a new kebab-case key.`,
  ].join('\n');
  const user = `Transition name: "${name}"\nDescription: ${prompt}`;
  return [
    {role: 'system', content: system},
    {role: 'user', content: user},
  ];
};
