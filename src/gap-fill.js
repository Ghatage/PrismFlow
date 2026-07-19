// Fill Gap transition: a draggable card that, dropped between two video clips,
// generates a short bridging clip whose first frame is the outgoing clip's last
// frame and whose last frame is the incoming clip's first frame. The planning
// helpers here are pure; frame capture, submission, and timeline mutation live
// with the caller.

import {NO_MUSIC_DIRECTION} from './beat-video.js';

export const FILL_GAP_TRANSITION_KEY = 'fill-gap';
// Veo 3.1 first-last-frame pins both endpoints; 4s is its minimum duration.
export const FILL_GAP_MODEL_ID = 'fal-ai/veo3.1/fast/first-last-frame-to-video';
export const FILL_GAP_DURATION = 4;

const EDGE_EPSILON = 0.05;

const laneClips = (clips, trackId) => clips
  .filter((clip) => clip?.trackId === trackId
    && Number.isFinite(clip.start) && Number.isFinite(clip.duration) && clip.duration > 0)
  .toSorted((left, right) => left.start - right.start);

// Picks the pair of consecutive clips whose junction is nearest the drop time.
// Unlike CSS transitions, the pair does not need to touch — the gap is the point.
export const findGapFillPair = ({clips = [], trackId, time = 0} = {}) => {
  const lane = laneClips(clips, trackId);
  let best = null;
  for (let index = 0; index + 1 < lane.length; index += 1) {
    const from = lane[index];
    const to = lane[index + 1];
    const fromEnd = from.start + from.duration;
    if (to.start < fromEnd - EDGE_EPSILON) continue;
    const junction = (fromEnd + Math.max(fromEnd, to.start)) / 2;
    const distance = Math.abs(junction - time);
    if (!best || distance < best.distance) {
      best = {distance, fromClipId: from.id, toClipId: to.id, gap: Math.max(0, to.start - fromEnd)};
    }
  }
  return best ? {fromClipId: best.fromClipId, toClipId: best.toClipId, gap: best.gap} : null;
};

// Media-time positions of the boundary frames, honoring each clip's trim.
export const gapFillCaptureTimes = ({fromClip, toClip, epsilon = EDGE_EPSILON} = {}) => {
  if (!fromClip || !toClip) throw new Error('Gap fill capture requires both boundary clips.');
  return {
    fromTime: Math.max(0, (fromClip.sourceStart || 0) + fromClip.duration - epsilon),
    toTime: Math.max(0, (toClip.sourceStart || 0) + epsilon),
  };
};

export const buildGapFillPrompt = ({styleBible = '', fromText = '', toText = ''} = {}) => [
  'Create one seamless connecting shot that begins exactly on the supplied first frame and ends exactly on the supplied last frame.',
  'Bridge the two moments with continuous, motivated camera movement and performance — no cuts, no flash frames, no captions, no morphing artifacts.',
  'Preserve the identity, wardrobe, environment, lighting, and color grade of both frames throughout the shot.',
  styleBible ? `Visual style bible — stay inside this look: ${styleBible}` : '',
  fromText ? `Outgoing moment: ${fromText}` : '',
  toText ? `Incoming moment: ${toText}` : '',
  NO_MUSIC_DIRECTION,
].filter(Boolean).join('\n');

// Chat messages asking the project LLM to write the bridging-shot prompt from
// the two neighboring shots' own video prompts. The frame pinning is done by
// the video model itself — the LLM only has to write the motion between.
export const buildGapFillPromptMessages = ({styleBible = '', fromBeat = {}, toBeat = {}, duration = FILL_GAP_DURATION} = {}) => {
  const system = [
    `You write one production-ready prompt for an AI video model that generates a single ${duration}-second connecting shot between two existing shots.`,
    "The video model already pins the exact first frame (the outgoing shot's last frame) and the exact last frame (the incoming shot's first frame). Do not describe the stills — describe only the continuous motion between them.",
    'Cover camera movement, blocking, performance, environment, and ambient sound that carry the outgoing shot naturally into the incoming shot with no cuts.',
    'Never request music, a musical score, a soundtrack, singing, or rhythmic underscore.',
    'Return plain text only with no Markdown, timecodes, headings, analysis, or preamble.',
  ].join(' ');
  const user = [
    styleBible ? `Visual style bible — the shot must stay inside this look: ${styleBible}` : '',
    fromBeat.text ? `Outgoing beat: ${fromBeat.text}` : '',
    fromBeat.videoPrompt ? `Outgoing shot's video prompt:\n${fromBeat.videoPrompt}` : '',
    toBeat.text ? `Incoming beat: ${toBeat.text}` : '',
    toBeat.videoPrompt ? `Incoming shot's video prompt:\n${toBeat.videoPrompt}` : '',
    `Write the ${duration}-second bridging shot prompt now.`,
  ].filter(Boolean).join('\n\n');
  return [
    {role: 'system', content: system},
    {role: 'user', content: user},
  ];
};

// Moves needed after the fill lands so the incoming clip starts exactly where
// the fill ends. Only pushes right (rightmost clip first); a gap already wider
// than the fill is left alone rather than pulling clips leftward.
export const gapFillShiftPlan = ({clips = [], toClipId, fillStart, fillDuration, excludeClipId = null, epsilon = 0.01} = {}) => {
  const toClip = clips.find((clip) => clip.id === toClipId);
  if (!toClip || !Number.isFinite(fillStart) || !Number.isFinite(fillDuration)) return [];
  const delta = fillStart + fillDuration - toClip.start;
  if (delta <= epsilon) return [];
  return clips
    .filter((clip) => clip.id !== excludeClipId
      && clip.trackId === toClip.trackId
      && clip.sceneId === toClip.sceneId
      && clip.start >= toClip.start - epsilon)
    .toSorted((left, right) => right.start - left.start)
    .map((clip) => ({clipId: clip.id, trackId: clip.trackId, start: clip.start + delta}));
};
