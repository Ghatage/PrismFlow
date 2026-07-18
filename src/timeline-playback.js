const VISUAL_MEDIA_KINDS = new Set(['image', 'video']);

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasPlayableSource = (media) => typeof media.url === 'string' && Boolean(media.url.trim());

const isActiveAt = (clip, time) => {
  if (!isRecord(clip)) return false;
  if (!Number.isFinite(clip.start) || clip.start < 0) return false;
  if (!Number.isFinite(clip.duration) || clip.duration <= 0) return false;
  const end = clip.start + clip.duration;
  return Number.isFinite(end) && time >= clip.start && time < end;
};

/**
 * Resolves the playable media that should be active at one timeline time.
 *
 * The `tracks` array is authoritative because it is also the editor's displayed
 * top-to-bottom order. Clips are active on the half-open interval
 * `[start, start + duration)`. Within one track, caller-supplied clip order is
 * preserved as the deterministic tie-breaker for otherwise ambiguous overlaps.
 *
 * @param {{
 *   time: number,
 *   clips?: unknown[],
 *   tracks?: unknown[],
 *   mediaAssets?: unknown[],
 * }} input
 * @returns {{
 *   visual: {clip: object, media: object} | null,
 *   audio: Array<{clip: object, media: object}>,
 * }}
 */
export const resolveTimelinePlaybackAt = ({
  time,
  clips = [],
  tracks = [],
  mediaAssets = [],
} = {}) => {
  const resolved = {visual: null, audio: []};
  if (!Number.isFinite(time) || time < 0) return resolved;
  if (!Array.isArray(clips) || !Array.isArray(tracks) || !Array.isArray(mediaAssets)) return resolved;

  const mediaById = new Map();
  mediaAssets.forEach((media) => {
    if (!isRecord(media) || typeof media.id !== 'string' || !media.id || mediaById.has(media.id)) return;
    mediaById.set(media.id, media);
  });

  const activeByTrack = new Map();
  clips.forEach((clip) => {
    if (!isActiveAt(clip, time)) return;
    if (typeof clip.trackId !== 'string' || !clip.trackId) return;
    if (typeof clip.assetId !== 'string' || !clip.assetId) return;
    const media = mediaById.get(clip.assetId);
    if (!media) return;
    const entries = activeByTrack.get(clip.trackId) || [];
    entries.push({clip, media});
    activeByTrack.set(clip.trackId, entries);
  });

  const seenTrackIds = new Set();
  tracks.forEach((track) => {
    if (!isRecord(track) || typeof track.id !== 'string' || !track.id || seenTrackIds.has(track.id)) return;
    seenTrackIds.add(track.id);
    const entries = activeByTrack.get(track.id) || [];

    if (track.kind === 'video' && !resolved.visual) {
      resolved.visual = entries.find(({media}) => VISUAL_MEDIA_KINDS.has(media.kind) && hasPlayableSource(media)) || null;
      return;
    }

    if (track.kind === 'audio') {
      resolved.audio.push(...entries.filter(({media}) => media.kind === 'audio' && hasPlayableSource(media)));
    }
  });

  return resolved;
};
