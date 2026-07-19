export const SEEDANCE_REFERENCE_VIDEO_MODEL_ID = 'bytedance/seedance-2.0/reference-to-video';
export const SEEDANCE_VIDEO_DURATIONS = Object.freeze(Array.from({length: 12}, (_, index) => index + 4));
export const NO_MUSIC_DIRECTION = 'AUDIO DIRECTION: No music or musical score. Ambient sound, sound effects, environmental sound, and story-appropriate dialogue are allowed.';

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
  if (!/No music or musical score/i.test(prompt)) prompt = `${prompt}\n${NO_MUSIC_DIRECTION}`;
  return prompt;
};

const TIMECODE_PATTERN = /^00:(\d{2})\s*-\s*00:(\d{2})\s+(.+)$/;

export const normalizeTimedVideoPrompt = (value, requestedDuration) => {
  const duration = normalizeSeedanceDuration(requestedDuration);
  let cursor = 0;
  const segments = String(value || '')
    .replace(/^```(?:[a-z]+)?\s*/i, '')
    .replace(/\s*```$/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => ({line, match: line.match(TIMECODE_PATTERN)}))
    .filter(({match}) => match)
    .map(({match}) => ({start: Number(match[1]), end: Number(match[2]), description: match[3].trim()}))
    .filter((segment) => {
      if (segment.start < cursor || segment.end <= segment.start || segment.end > duration || !segment.description) return false;
      cursor = segment.end;
      return true;
    });
  if (!segments.length) throw new Error('Generated video prompt did not contain valid timecoded segments.');
  if (!segments.some((segment) => /@Image1\b/i.test(segment.description))) {
    segments[0].description = `@Image1 is the exact visual reference and opening frame. ${segments[0].description}`;
  }
  return withSeedanceReferenceDirections([
    ...segments.map((segment) => `00:${String(segment.start).padStart(2, '0')} - 00:${String(segment.end).padStart(2, '0')} ${segment.description}`),
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
  const segments = [];
  for (let start = 0, index = 0; start < duration; index += 1) {
    const end = Math.min(duration, start + 2);
    const action = actions[index % actions.length] || context?.target?.text || 'The beat unfolds.';
    segments.push(`00:${String(start).padStart(2, '0')} - 00:${String(end).padStart(2, '0')} ${index === 0 ? '@Image1 is the exact opening frame. ' : ''}${action}`);
    start = end;
  }
  return withSeedanceReferenceDirections([...segments, NO_MUSIC_DIRECTION].join('\n'));
};
