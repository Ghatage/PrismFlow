// Derived act-scoped views over the flat, seconds-based timeline. Acts are
// scenes ordered by metadata.actNumber; the "all" view concatenates every
// act's clips back-to-back by offsetting starts with the running act length.

export const orderedScenes = (project) => [...project.scenes].sort((left, right) => {
  const leftNumber = left.metadata?.actNumber;
  const rightNumber = right.metadata?.actNumber;
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  if (Number.isFinite(leftNumber)) return -1;
  if (Number.isFinite(rightNumber)) return 1;
  return 0;
});

const offsetCache = new WeakMap();

export const actOffsets = (project, clips = project.timeline.clips) => {
  const cacheable = clips === project.timeline.clips;
  const revision = project.timeline.revision || 0;
  const cached = cacheable ? offsetCache.get(project) : null;
  if (cached?.revision === revision && cached.clips === clips) return cached.offsets;
  const offsets = new Map();
  let cursor = 0;
  for (const scene of orderedScenes(project)) {
    offsets.set(scene.id, cursor);
    const actEnd = clips
      .filter((clip) => clip.sceneId === scene.id)
      .reduce((maximum, clip) => Math.max(maximum, clip.start + clip.duration), 0);
    cursor += actEnd;
  }
  if (cacheable) offsetCache.set(project, {revision, clips, offsets});
  return offsets;
};

export const visibleClips = (project, activeActId, clips = project.timeline.clips) => {
  if (!activeActId || activeActId === 'all') {
    const offsets = actOffsets(project, clips);
    return clips.map((clip) => ({...clip, start: clip.start + (offsets.get(clip.sceneId) || 0)}));
  }
  return clips.filter((clip) => clip.sceneId === activeActId);
};

export const toViewStart = (project, activeActId, sceneId, localStart) => {
  if (!activeActId || activeActId === 'all') {
    return localStart + (actOffsets(project).get(sceneId) || 0);
  }
  return localStart;
};

// Maps a start expressed in the current view's seconds back to the owning
// act's local seconds. In a single-act view the two are identical.
export const toLocalStart = (project, activeActId, sceneId, viewStart) => {
  if (!activeActId || activeActId === 'all') {
    return Math.max(0, viewStart - (actOffsets(project).get(sceneId) || 0));
  }
  return viewStart;
};

// The act whose concatenated range contains the given "all"-view time; falls
// back to the last act when the time is past the end.
export const actForViewTime = (project, viewTime, clips = project.timeline.clips) => {
  const scenes = orderedScenes(project);
  const offsets = actOffsets(project, clips);
  let chosen = scenes[0]?.id || null;
  for (const scene of scenes) {
    if ((offsets.get(scene.id) || 0) <= viewTime) chosen = scene.id;
  }
  return chosen;
};

// Global assets (sceneId:null) are available in every act. Clip references are
// included even when an older asset was tagged differently from its clip.
export const visibleAssetIds = (project, activeActId) => {
  if (!activeActId || activeActId === 'all') {
    return new Set(project.mediaAssets.map((asset) => asset.id));
  }
  const ids = new Set(project.mediaAssets
    .filter((asset) => asset.sceneId === null || asset.sceneId === activeActId)
    .map((asset) => asset.id));
  project.timeline.clips
    .filter((clip) => clip.sceneId === activeActId)
    .forEach((clip) => ids.add(clip.assetId));
  return ids;
};
