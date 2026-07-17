export const VIDEO_FRAME_SCHEMA_VERSION = 1;
export const VIDEO_FRAME_INTERVAL_SECONDS = 5;
export const VIDEO_FRAME_VLM_PROMPT = 'Describe exactly what is visible in this video frame. Mention the main subjects, actions, setting, camera composition, text, and distinctive visual details. Be concise and concrete for semantic search.';

const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const clean = (value) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

export const frameIdFor = (videoAssetId, time) => `${videoAssetId}@${Number(time).toFixed(3)}`;

export const snapshotTimes = (duration, interval = VIDEO_FRAME_INTERVAL_SECONDS) => {
  const safeDuration = Number.isFinite(duration) && duration >= 0 ? duration : 0;
  const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : VIDEO_FRAME_INTERVAL_SECONDS;
  const times = [0];
  for (let time = safeInterval; time <= safeDuration + 0.0001; time += safeInterval) {
    times.push(Number(time.toFixed(3)));
  }
  return [...new Set(times)];
};

const waitForEvent = (target, eventName, errorName = 'error') => new Promise((resolve, reject) => {
  const onResolve = () => { cleanup(); resolve(); };
  const onReject = () => { cleanup(); reject(new Error(`Video frame capture failed while waiting for ${eventName}.`)); };
  const cleanup = () => {
    target.removeEventListener(eventName, onResolve);
    target.removeEventListener(errorName, onReject);
  };
  target.addEventListener(eventName, onResolve, {once: true});
  target.addEventListener(errorName, onReject, {once: true});
});

export const captureVideoFrame = async (video, time, {
  canvas = globalThis.document?.createElement?.('canvas'),
  maxWidth = 640,
  quality = 0.78,
} = {}) => {
  if (!video || !canvas) throw new Error('Video frame capture requires a video and canvas.');
  if (video.readyState < 1) await waitForEvent(video, 'loadedmetadata');
  video.currentTime = Math.max(0, time);
  if (Math.abs(video.currentTime - time) > 0.01 || video.readyState < 2) await waitForEvent(video, 'seeked');
  const sourceWidth = video.videoWidth || 640;
  const sourceHeight = video.videoHeight || 360;
  const width = Math.min(maxWidth, sourceWidth);
  const height = Math.max(1, Math.round(sourceHeight * (width / sourceWidth)));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', {willReadFrequently: false});
  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Canvas did not produce a video frame.')), 'image/jpeg', quality));
  return {blob, width, height};
};

const blobToDataUrl = async (blob) => {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Frame could not be encoded.'));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const binary = [...bytes].map((byte) => String.fromCharCode(byte)).join('');
  const base64 = globalThis.btoa ? globalThis.btoa(binary) : Buffer.from(bytes).toString('base64');
  return `data:${blob.type || 'image/jpeg'};base64,${base64}`;
};

const responseJson = async (response, fallbackMessage) => {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || fallbackMessage);
  return payload;
};

export const createVideoFrameIndexer = ({
  database,
  getProject = () => null,
  fetchImpl = globalThis.fetch,
  captureFrame = captureVideoFrame,
  now = () => new Date().toISOString(),
  onProgress = () => {},
} = {}) => {
  if (!database || typeof database.putVideoFrame !== 'function') throw new TypeError('Video indexing requires a browser database.');
  if (typeof fetchImpl !== 'function') throw new TypeError('Video indexing requires fetch.');
  const active = new Map();
  const frameCache = new Map();

  const saveManifest = async (manifest) => {
    await database.putVideoFrameManifest(clone(manifest));
    return manifest;
  };

  const indexRecords = async (records) => {
    if (!records.length) return;
    const response = await fetchImpl('/api/video/index', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({projectId: getProject()?.project?.id || null, records}),
    });
    await responseJson(response, 'Video annotations could not be indexed.');
  };

  const annotate = async (frame) => {
    const imageDataUrl = await blobToDataUrl(frame.blob);
    const response = await fetchImpl('/api/video/annotate', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        frameId: frame.id,
        videoAssetId: frame.videoAssetId,
        time: frame.time,
        imageDataUrl,
        prompt: VIDEO_FRAME_VLM_PROMPT,
      }),
    });
    const payload = await responseJson(response, 'Video frame annotation failed.');
    return {
      ...frame,
      status: 'annotated',
      annotation: clean(payload.annotation || payload.text),
      modelId: payload.modelId || null,
      annotatedAt: now(),
    };
  };

  const run = async ({asset, video, duration = asset.duration, interval = VIDEO_FRAME_INTERVAL_SECONDS} = {}) => {
    if (!asset?.id || asset.kind !== 'video') throw new Error('Only video assets can be indexed.');
    if (active.has(asset.id)) return active.get(asset.id);
    const task = (async () => {
      const times = snapshotTimes(duration, interval);
      const existing = new Map((await database.getVideoFrames(asset.id)).map((frame) => [frame.id, frame]));
      const manifest = {
        id: asset.id,
        schemaVersion: VIDEO_FRAME_SCHEMA_VERSION,
        videoAssetId: asset.id,
        videoName: asset.name,
        interval,
        duration,
        frameCount: times.length,
        status: 'capturing',
        modelId: null,
        completedCount: 0,
        updatedAt: now(),
      };
      await saveManifest(manifest);
      const indexedRecords = [];
      for (let index = 0; index < times.length; index += 1) {
        const time = times[index];
        const id = frameIdFor(asset.id, time);
        let frame = existing.get(id);
        if (!frame?.blob) {
          const captured = await captureFrame(video, time);
          frame = {
            id,
            schemaVersion: VIDEO_FRAME_SCHEMA_VERSION,
            videoAssetId: asset.id,
            videoName: asset.name,
            time,
            duration,
            blob: captured.blob,
            width: captured.width,
            height: captured.height,
            status: 'captured',
            capturedAt: now(),
          };
          await database.putVideoFrame(frame);
        }
        if (!frame.annotation) {
          try {
            frame = await annotate(frame);
            await database.putVideoFrame(frame);
          } catch (error) {
            frame = {...frame, status: 'annotation-failed', error: error instanceof Error ? error.message : String(error), updatedAt: now()};
            await database.putVideoFrame(frame);
          }
        }
        if (frame.annotation) indexedRecords.push({
          id: frame.id,
          projectId: getProject()?.project?.id || null,
          videoAssetId: asset.id,
          videoName: asset.name,
          time,
          duration,
          annotation: frame.annotation,
          modelId: frame.modelId || manifest.modelId,
          searchText: `${asset.name}. ${frame.annotation}`,
          createdAt: frame.capturedAt || now(),
        });
        manifest.completedCount = index + 1;
        manifest.status = manifest.completedCount === times.length ? 'complete' : 'annotating';
        manifest.modelId ||= frame.modelId || null;
        manifest.updatedAt = now();
        await saveManifest(manifest);
        onProgress(clone(manifest), clone(frame));
      }
      await indexRecords(indexedRecords);
      manifest.status = indexedRecords.length === times.length ? 'complete' : 'partial';
      manifest.updatedAt = now();
      await saveManifest(manifest);
      return {manifest: clone(manifest), frames: indexedRecords.map(clone)};
    })();
    active.set(asset.id, task);
    try { return await task; } finally { active.delete(asset.id); }
  };

  const resume = async ({assets = []} = {}) => {
    if (typeof document === 'undefined') return [];
    const assetById = new Map((Array.isArray(assets) ? assets : []).map((asset) => [asset.id, asset]));
    const manifests = await database.listVideoFrameManifests();
    return Promise.all(manifests
      .filter((manifest) => manifest.status !== 'complete')
      .map(async (manifest) => {
        const asset = assetById.get(manifest.videoAssetId);
        if (!asset?.url || asset.kind !== 'video') return null;
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.src = asset.url;
        try {
          if (video.readyState < 1) await waitForEvent(video, 'loadedmetadata');
          const duration = Number.isFinite(video.duration) && video.duration > 0
            ? video.duration
            : manifest.duration;
          return await run({asset, video, duration, interval: manifest.interval});
        } finally {
          video.removeAttribute('src');
          video.load?.();
        }
      }));
  };

  const search = async (query, {limit = 10} = {}) => {
    const projectId = getProject()?.project?.id || '';
    const url = `/api/search/video?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit)}&projectId=${encodeURIComponent(projectId)}`;
    const response = await fetchImpl(url);
    const payload = await responseJson(response, 'Video annotation search failed.');
    const results = Array.isArray(payload.results) ? payload.results : [];
    results.forEach((result) => frameCache.set(result.id, result));
    return results;
  };

  const getCachedFrame = (frameId) => clone(frameCache.get(frameId) || null);

  return {run, resume, search, getCachedFrame, snapshotTimes, frameIdFor};
};
