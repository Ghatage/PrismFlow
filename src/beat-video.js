export const SEEDANCE_REFERENCE_VIDEO_MODEL_ID = 'bytedance/seedance-2.0/reference-to-video';
export const SEEDANCE_VIDEO_DURATIONS = Object.freeze(Array.from({length: 12}, (_, index) => index + 4));
export const MAX_BEAT_VIDEO_SHOT_SECONDS = 3;
export const NO_MUSIC_DIRECTION = 'AUDIO DIRECTION: No music or musical score. Ambient sound, sound effects, environmental sound, and story-appropriate dialogue are allowed.';
export const CUT_AND_DIALOGUE_DIRECTION = 'EDITING DIRECTION: Treat every timecoded segment as a hard camera cut. Each shot must last no more than 3 seconds, visibly change camera angle, shot size, focal subject, or staging from the previous shot, and include spoken dialogue shorter than 3 seconds. For a solo character, use self-directed speech.';

export const normalizeSeedanceDuration = (value) => {
  const duration = Number(value);
  if (!Number.isInteger(duration) || !SEEDANCE_VIDEO_DURATIONS.includes(duration)) {
    throw new Error('Seedance duration must be between 4 and 15 seconds.');
  }
  return duration;
};

export const nextBeatVideoTimelineStart = ({clips = [], trackId, sceneId} = {}) => clips
  .filter((clip) => clip?.trackId === trackId && clip?.sceneId === sceneId)
  .reduce((latestEnd, clip) => {
    const start = Number(clip.start);
    const duration = Number(clip.duration);
    if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return latestEnd;
    return Math.max(latestEnd, Math.max(0, start) + duration);
  }, 0);

export const withSeedanceReferenceDirections = (value) => {
  let prompt = String(value || '').trim();
  if (!prompt) throw new Error('Seedance video prompt is required.');
  if (!/@Image1\b/i.test(prompt)) {
    prompt = `Use @Image1 as the exact visual reference and opening frame. Preserve its character identity, wardrobe, environment, composition, and visual style.\n${prompt}`;
  }
  if (!/Treat every timecoded segment as a hard camera cut/i.test(prompt)) prompt = `${prompt}\n${CUT_AND_DIALOGUE_DIRECTION}`;
  if (!/No music or musical score/i.test(prompt)) prompt = `${prompt}\n${NO_MUSIC_DIRECTION}`;
  return prompt;
};

const TIMECODE_PATTERN = /^00:(\d{2})\s*-\s*00:(\d{2})\s+(.+)$/;
const DIALOGUE_PATTERN = /\bDIALOGUE\s*\(\s*[^,()]+\s*,\s*(\d+(?:\.\d+)?)s\s*\)\s*:\s*["“][^"”]+["”]/i;

export const normalizeTimedVideoPrompt = (value, requestedDuration) => {
  const duration = normalizeSeedanceDuration(requestedDuration);
  let cursor = 0;
  const candidates = String(value || '')
    .replace(/^```(?:[a-z]+)?\s*/i, '')
    .replace(/\s*```$/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => ({line, match: line.match(TIMECODE_PATTERN)}))
    .filter(({match}) => match)
    .map(({match}) => ({start: Number(match[1]), end: Number(match[2]), description: match[3].trim()}));
  const segments = [];
  for (const segment of candidates) {
    if (segment.start >= duration) continue;
    if (segment.start !== cursor || segment.end <= segment.start || segment.end > duration || !segment.description) {
      throw new Error(`Generated video prompt must cover 00:00 through 00:${String(duration).padStart(2, '0')} with contiguous timecoded cuts.`);
    }
    if (segment.end - segment.start > MAX_BEAT_VIDEO_SHOT_SECONDS) {
      throw new Error(`Generated video prompt cuts must be ${MAX_BEAT_VIDEO_SHOT_SECONDS} seconds or shorter.`);
    }
    const dialogue = segment.description.match(DIALOGUE_PATTERN);
    if (!dialogue || Number(dialogue[1]) >= MAX_BEAT_VIDEO_SHOT_SECONDS) {
      throw new Error('Every generated video prompt cut must include DIALOGUE (Speaker, <3s): "spoken line".');
    }
    segments.push(segment);
    cursor = segment.end;
  }
  if (!segments.length) throw new Error('Generated video prompt did not contain valid timecoded segments.');
  if (cursor !== duration) {
    throw new Error(`Generated video prompt must end at 00:${String(duration).padStart(2, '0')}.`);
  }
  if (!segments.some((segment) => /@Image1\b/i.test(segment.description))) {
    segments[0].description = `@Image1 is the exact visual reference and opening frame. ${segments[0].description}`;
  }
  return withSeedanceReferenceDirections([
    ...segments.map((segment) => `00:${String(segment.start).padStart(2, '0')} - 00:${String(segment.end).padStart(2, '0')} ${segment.description}`),
    CUT_AND_DIALOGUE_DIRECTION,
    NO_MUSIC_DIRECTION,
  ].join('\n'));
};

export const createFakeTimedVideoPrompt = ({context, duration: requestedDuration}) => {
  const duration = normalizeSeedanceDuration(requestedDuration);
  const screenplay = String(context?.target?.screenplay || context?.target?.text || 'The beat unfolds on screen.').trim();
  const actions = screenplay
    .split(/(?:\r?\n)+|(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const speaker = context?.characters?.find((character) => character.mentioned)?.name
    || context?.characters?.[0]?.name
    || 'Character';
  const cameraSetups = [
    `HARD CUT to a low-angle close-up focused on ${speaker}`,
    `HARD CUT to an over-the-shoulder medium shot that changes the focal plane around ${speaker}`,
    `HARD CUT to a wide profile with new foreground staging around ${speaker}`,
    `HARD CUT to a high-angle reaction close-up on ${speaker}`,
  ];
  const dialogueLines = [
    'I have to keep moving.',
    'Something here is changing.',
    'I know what I must do.',
    'Stay focused. Keep going.',
  ];
  const segments = [];
  for (let start = 0, index = 0; start < duration; index += 1) {
    const end = Math.min(duration, start + 2);
    const action = actions[index % actions.length] || context?.target?.text || 'The beat unfolds.';
    segments.push(`00:${String(start).padStart(2, '0')} - 00:${String(end).padStart(2, '0')} ${index === 0 ? '@Image1 is the exact opening frame. ' : ''}${cameraSetups[index % cameraSetups.length]}; ${action} DIALOGUE (${speaker}, 1.5s): "${dialogueLines[index % dialogueLines.length]}"`);
    start = end;
  }
  return withSeedanceReferenceDirections([...segments, CUT_AND_DIALOGUE_DIRECTION, NO_MUSIC_DIRECTION].join('\n'));
};
