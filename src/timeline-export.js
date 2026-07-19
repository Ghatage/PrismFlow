const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 30;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' ? value.trim() : '';
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export const buildTimelineExportManifest = (project, {
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  fps = DEFAULT_FPS,
} = {}) => {
  if (!isRecord(project?.timeline)) throw new Error('This project does not have a timeline to export.');

  const tracks = (Array.isArray(project.timeline.tracks) ? project.timeline.tracks : [])
    .filter((track) => text(track?.id) && ['video', 'audio'].includes(track.kind))
    .map((track, order) => ({
      id: text(track.id),
      kind: track.kind,
      order: finite(track.order, order),
    }))
    .sort((left, right) => left.order - right.order);
  const trackIds = new Set(tracks.map((track) => track.id));

  const mediaById = new Map((Array.isArray(project.mediaAssets) ? project.mediaAssets : [])
    .filter((asset) => text(asset?.id))
    .map((asset) => [text(asset.id), asset]));
  const clips = (Array.isArray(project.timeline.clips) ? project.timeline.clips : [])
    .filter((clip) => text(clip?.id)
      && mediaById.has(text(clip.assetId))
      && trackIds.has(text(clip.trackId))
      && Number.isFinite(clip.start)
      && Number.isFinite(clip.duration)
      && clip.start >= 0
      && clip.duration > 0)
    .map((clip) => ({
      id: text(clip.id),
      assetId: text(clip.assetId),
      trackId: text(clip.trackId),
      start: clip.start,
      duration: clip.duration,
      sourceStart: Math.max(0, finite(clip.sourceStart)),
      audioDetached: Boolean(clip.audioDetached),
    }));
  if (!clips.length) throw new Error('Add at least one clip to the timeline before exporting.');

  const usedAssetIds = new Set(clips.map((clip) => clip.assetId));
  const assets = [...mediaById.values()]
    .filter((asset) => usedAssetIds.has(text(asset.id)))
    .map((asset) => ({
      id: text(asset.id),
      name: text(asset.name) || `${text(asset.id)}.${asset.kind === 'image' ? 'png' : asset.kind === 'audio' ? 'wav' : 'mp4'}`,
      kind: ['video', 'audio', 'image'].includes(asset.kind) ? asset.kind : 'video',
      mimeType: text(asset.mimeType) || 'application/octet-stream',
    }));

  const clipIds = new Set(clips.map((clip) => clip.id));
  const transitions = (Array.isArray(project.timeline.transitions) ? project.timeline.transitions : [])
    .filter((transition) => text(transition?.id)
      && (!transition.fromClipId || clipIds.has(text(transition.fromClipId)))
      && (!transition.toClipId || clipIds.has(text(transition.toClipId))))
    .map((transition) => ({
      id: text(transition.id),
      type: text(transition.type) || 'crossfade',
      fromClipId: text(transition.fromClipId) || null,
      toClipId: text(transition.toClipId) || null,
      duration: Math.max(0.1, finite(transition.duration, 1)),
    }));
  const customTransitions = (Array.isArray(project.customTransitions) ? project.customTransitions : [])
    .filter((definition) => text(definition?.key))
    .map((definition) => ({key: text(definition.key), mode: definition.mode === 'dip' ? 'dip' : 'blend'}));
  const clipEnd = clips.reduce((maximum, clip) => Math.max(maximum, clip.start + clip.duration), 0);

  return {
    schemaVersion: 1,
    projectId: text(project.project?.id) || null,
    duration: Math.max(0.1, finite(project.timeline.duration), clipEnd),
    width: Math.max(320, Math.round(finite(width, DEFAULT_WIDTH) / 2) * 2),
    height: Math.max(180, Math.round(finite(height, DEFAULT_HEIGHT) / 2) * 2),
    fps: Math.min(60, Math.max(1, Math.round(finite(fps, DEFAULT_FPS)))),
    tracks,
    clips,
    transitions,
    customTransitions,
    assets,
  };
};

const responseError = async (response, fallback) => {
  const payload = await response.json().catch(() => null);
  return new Error(payload?.error || fallback);
};

const defaultDownload = (blob, fileName) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

export const createTimelineExporter = ({
  fetchImpl = globalThis.fetch,
  resolveAssetBlob,
  download = defaultDownload,
} = {}) => ({
  async exportProject(project, {onProgress = () => {}} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('Timeline export requires fetch.');
    if (typeof resolveAssetBlob !== 'function') throw new Error('Timeline export requires access to project media.');
    const manifest = buildTimelineExportManifest(project);
    onProgress({phase: 'preparing', completed: 0, total: manifest.assets.length});

    const created = await fetchImpl('/api/export/sessions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({manifest}),
    });
    if (!created.ok) throw await responseError(created, 'The export session could not be created.');
    const {sessionId} = await created.json();
    if (!text(sessionId)) throw new Error('The export server did not return a session id.');

    try {
      for (let index = 0; index < manifest.assets.length; index += 1) {
        const exportAsset = manifest.assets[index];
        const projectAsset = project.mediaAssets.find((asset) => asset.id === exportAsset.id);
        let blob = await resolveAssetBlob(projectAsset);
        if (!blob && projectAsset?.url) {
          const source = await fetchImpl(projectAsset.url);
          if (source.ok) blob = await source.blob();
        }
        if (!blob) throw new Error(`Re-import ${exportAsset.name} before exporting; its media file is unavailable.`);
        onProgress({phase: 'uploading', completed: index, total: manifest.assets.length, asset: exportAsset});
        const uploaded = await fetchImpl(`/api/export/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(exportAsset.id)}`, {
          method: 'PUT',
          headers: {
            'Content-Type': blob.type || exportAsset.mimeType,
            'X-File-Name': encodeURIComponent(exportAsset.name),
          },
          body: blob,
        });
        if (!uploaded.ok) throw await responseError(uploaded, `Could not upload ${exportAsset.name} for export.`);
        onProgress({phase: 'uploading', completed: index + 1, total: manifest.assets.length, asset: exportAsset});
      }

      onProgress({phase: 'rendering', completed: manifest.assets.length, total: manifest.assets.length});
      const rendered = await fetchImpl(`/api/export/sessions/${encodeURIComponent(sessionId)}/render`, {method: 'POST'});
      if (!rendered.ok) throw await responseError(rendered, 'FFmpeg could not render the timeline.');
      const output = await rendered.blob();
      if (!output.size) throw new Error('The export server returned an empty video.');
      download(output, 'output.mp4');
      onProgress({phase: 'completed', completed: manifest.assets.length, total: manifest.assets.length});
      return {fileName: 'output.mp4', blob: output, manifest};
    } finally {
      fetchImpl(`/api/export/sessions/${encodeURIComponent(sessionId)}`, {method: 'DELETE'}).catch(() => {});
    }
  },
});
