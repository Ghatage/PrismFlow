import {spawn} from 'node:child_process';
import {createReadStream, createWriteStream} from 'node:fs';
import {copyFile, mkdtemp, rename, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {extname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const VISUAL_KINDS = new Set(['video', 'image']);
const SAFE_ID = /^[a-zA-Z0-9._-]{1,200}$/;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const EPSILON = 0.0001;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' ? value.trim() : '';
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const seconds = (value) => String(Math.round(Math.max(0, value) * 1_000_000) / 1_000_000);

const assertSafeId = (value, label) => {
  if (!SAFE_ID.test(value || '')) throw new Error(`${label} is invalid.`);
  return value;
};

export const normalizeTimelineExportManifest = (value) => {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('Unsupported timeline export manifest.');
  const width = Math.max(320, Math.min(7680, Math.round(finite(value.width, 1920) / 2) * 2));
  const height = Math.max(180, Math.min(4320, Math.round(finite(value.height, 1080) / 2) * 2));
  const fps = Math.max(1, Math.min(60, Math.round(finite(value.fps, 30))));
  const tracks = (Array.isArray(value.tracks) ? value.tracks : [])
    .filter((track) => SAFE_ID.test(text(track?.id)) && ['video', 'audio'].includes(track.kind))
    .map((track, order) => ({id: text(track.id), kind: track.kind, order: finite(track.order, order)}))
    .sort((left, right) => left.order - right.order);
  const trackIds = new Set(tracks.map((track) => track.id));
  const seenAssets = new Set();
  const assets = (Array.isArray(value.assets) ? value.assets : [])
    .filter((asset) => SAFE_ID.test(text(asset?.id)) && !seenAssets.has(text(asset.id)) && seenAssets.add(text(asset.id)))
    .map((asset) => ({
      id: text(asset.id),
      kind: ['video', 'audio', 'image'].includes(asset.kind) ? asset.kind : 'video',
      name: text(asset.name) || text(asset.id),
      mimeType: text(asset.mimeType) || 'application/octet-stream',
    }));
  const assetIds = new Set(assets.map((asset) => asset.id));
  const clips = (Array.isArray(value.clips) ? value.clips : [])
    .filter((clip) => SAFE_ID.test(text(clip?.id))
      && assetIds.has(text(clip.assetId))
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
  if (!clips.length) throw new Error('The timeline export does not contain any playable clips.');
  const clipIds = new Set(clips.map((clip) => clip.id));
  const transitions = (Array.isArray(value.transitions) ? value.transitions : [])
    .filter((transition) => SAFE_ID.test(text(transition?.id))
      && (!transition.fromClipId || clipIds.has(text(transition.fromClipId)))
      && (!transition.toClipId || clipIds.has(text(transition.toClipId))))
    .map((transition) => ({
      id: text(transition.id),
      type: text(transition.type) || 'crossfade',
      fromClipId: text(transition.fromClipId) || null,
      toClipId: text(transition.toClipId) || null,
      duration: Math.max(0.1, Math.min(5, finite(transition.duration, 1))),
    }));
  const customTransitions = (Array.isArray(value.customTransitions) ? value.customTransitions : [])
    .filter((definition) => text(definition?.key))
    .map((definition) => ({key: text(definition.key), mode: definition.mode === 'dip' ? 'dip' : 'blend'}));
  const clipEnd = clips.reduce((maximum, clip) => Math.max(maximum, clip.start + clip.duration), 0);
  const duration = Math.min(24 * 60 * 60, Math.max(0.1, finite(value.duration), clipEnd));
  return {schemaVersion: 1, projectId: text(value.projectId) || null, width, height, fps, duration, tracks, assets, clips, transitions, customTransitions};
};

const visualSegments = (manifest) => {
  const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const videoTracks = manifest.tracks.filter((track) => track.kind === 'video');
  const trackIds = new Set(videoTracks.map((track) => track.id));
  const clips = manifest.clips.filter((clip) => trackIds.has(clip.trackId) && VISUAL_KINDS.has(assets.get(clip.assetId)?.kind));
  const boundaries = new Set([0, manifest.duration]);
  clips.forEach((clip) => {
    boundaries.add(Math.min(manifest.duration, clip.start));
    boundaries.add(Math.min(manifest.duration, clip.start + clip.duration));
  });
  const ordered = [...boundaries].filter((value) => value >= 0 && value <= manifest.duration).sort((a, b) => a - b);
  const activeAt = (time) => {
    for (const track of videoTracks) {
      const clip = clips.find((candidate) => candidate.trackId === track.id
        && time >= candidate.start
        && time < candidate.start + candidate.duration);
      if (clip) return {clip, asset: assets.get(clip.assetId)};
    }
    return null;
  };
  const segments = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const start = ordered[index - 1];
    const end = ordered[index];
    if (end - start <= EPSILON) continue;
    const active = activeAt(start + (end - start) / 2);
    const previous = segments.at(-1);
    if (previous && previous.clip?.id === active?.clip?.id && Math.abs(previous.end - start) <= EPSILON) {
      previous.end = end;
    } else {
      segments.push({start, end, clip: active?.clip || null, asset: active?.asset || null});
    }
  }
  return segments;
};

const inputVideoFilter = ({inputIndex, asset, start = 0, duration, width, height, fps, label, held = false}) => {
  const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`;
  if (asset.kind === 'image') {
    return `[${inputIndex}:v]trim=duration=${seconds(duration)},setpts=PTS-STARTPTS,${fit}[${label}]`;
  }
  if (held) {
    const frameDuration = Math.min(duration, 1 / fps);
    return `[${inputIndex}:v]trim=start=${seconds(start)}:duration=${seconds(frameDuration)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${seconds(duration)},trim=duration=${seconds(duration)},${fit}[${label}]`;
  }
  return `[${inputIndex}:v]trim=start=${seconds(start)}:duration=${seconds(duration)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${seconds(duration)},trim=duration=${seconds(duration)},${fit}[${label}]`;
};

const BUILT_IN_XFADE = {
  crossfade: 'fade',
  'wipe-left': 'wipeleft',
  'wipe-right': 'wiperight',
  'slide-left': 'slideleft',
  'slide-right': 'slideright',
};

export const buildTimelineFfmpegArgs = ({manifest: rawManifest, assetPaths, streamInfo = {}, outputPath}) => {
  const manifest = normalizeTimelineExportManifest(rawManifest);
  if (!outputPath) throw new Error('Timeline export requires an output path.');
  const pathFor = assetPaths instanceof Map ? assetPaths : new Map(Object.entries(assetPaths || {}));
  const inputIndex = new Map();
  const args = ['-hide_banner', '-loglevel', 'error'];
  manifest.assets.forEach((asset, index) => {
    const filePath = pathFor.get(asset.id);
    if (!filePath) throw new Error(`Timeline export is missing ${asset.name}.`);
    inputIndex.set(asset.id, index);
    if (asset.kind === 'image') args.push('-loop', '1', '-framerate', String(manifest.fps));
    args.push('-i', filePath);
  });

  const filters = [];
  const segments = visualSegments(manifest);
  const segmentLabels = [];
  segments.forEach((segment, index) => {
    const label = `vseg${index}`;
    const duration = segment.end - segment.start;
    segmentLabels.push(label);
    if (!segment.clip) {
      filters.push(`color=c=black:s=${manifest.width}x${manifest.height}:r=${manifest.fps}:d=${seconds(duration)},format=yuv420p[${label}]`);
      return;
    }
    filters.push(inputVideoFilter({
      inputIndex: inputIndex.get(segment.asset.id),
      asset: segment.asset,
      start: segment.clip.sourceStart + segment.start - segment.clip.start,
      duration,
      width: manifest.width,
      height: manifest.height,
      fps: manifest.fps,
      label,
    }));
  });
  if (!segmentLabels.length) {
    filters.push(`color=c=black:s=${manifest.width}x${manifest.height}:r=${manifest.fps}:d=${seconds(manifest.duration)},format=yuv420p[vbase]`);
  } else if (segmentLabels.length === 1) {
    filters.push(`[${segmentLabels[0]}]null[vbase]`);
  } else {
    filters.push(`${segmentLabels.map((label) => `[${label}]`).join('')}concat=n=${segmentLabels.length}:v=1:a=0[vbase]`);
  }

  const clips = new Map(manifest.clips.map((clip) => [clip.id, clip]));
  const assets = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const customModes = new Map(manifest.customTransitions.map((definition) => [definition.key, definition.mode]));
  let currentVideo = 'vbase';
  let transitionIndex = 0;
  manifest.transitions.forEach((transition) => {
    const fromClip = clips.get(transition.fromClipId);
    const toClip = clips.get(transition.toClipId);
    const edge = fromClip ? fromClip.start + fromClip.duration : toClip?.start;
    if (!Number.isFinite(edge)) return;
    const duration = Math.min(transition.duration, fromClip?.duration || transition.duration, toClip?.duration || transition.duration);
    if (duration <= EPSILON) return;
    const mode = transition.type === 'dip-to-black' || customModes.get(transition.type) === 'dip' ? 'dip' : 'blend';
    const nextVideo = `vtransout${transitionIndex}`;

    if (mode === 'blend' && fromClip && toClip) {
      const fromAsset = assets.get(fromClip.assetId);
      const toAsset = assets.get(toClip.assetId);
      if (!VISUAL_KINDS.has(fromAsset?.kind) || !VISUAL_KINDS.has(toAsset?.kind)) return;
      const start = Math.max(0, edge - duration);
      const actualDuration = edge - start;
      const fromLabel = `vtransfrom${transitionIndex}`;
      const toLabel = `vtransto${transitionIndex}`;
      const mixedLabel = `vtransmix${transitionIndex}`;
      filters.push(inputVideoFilter({
        inputIndex: inputIndex.get(fromAsset.id), asset: fromAsset,
        start: fromClip.sourceStart + start - fromClip.start, duration: actualDuration,
        width: manifest.width, height: manifest.height, fps: manifest.fps, label: fromLabel,
      }));
      filters.push(inputVideoFilter({
        inputIndex: inputIndex.get(toAsset.id), asset: toAsset,
        start: toClip.sourceStart, duration: actualDuration, held: true,
        width: manifest.width, height: manifest.height, fps: manifest.fps, label: toLabel,
      }));
      const xfade = BUILT_IN_XFADE[transition.type] || 'fade';
      filters.push(`[${fromLabel}][${toLabel}]xfade=transition=${xfade}:duration=${seconds(actualDuration)}:offset=0,setpts=PTS+${seconds(start)}/TB[${mixedLabel}]`);
      filters.push(`[${currentVideo}][${mixedLabel}]overlay=shortest=0:eof_action=pass:repeatlast=0[${nextVideo}]`);
    } else {
      const start = fromClip && toClip
        ? Math.max(0, edge - duration / 2)
        : fromClip ? Math.max(0, edge - duration) : edge;
      const actualDuration = fromClip && toClip ? duration : Math.min(duration, manifest.duration - start);
      if (actualDuration <= EPSILON) return;
      const blackLabel = `vtransblack${transitionIndex}`;
      if (fromClip && toClip) {
        const half = actualDuration / 2;
        filters.push(`color=c=black@1:s=${manifest.width}x${manifest.height}:r=${manifest.fps}:d=${seconds(actualDuration)},format=yuva420p,fade=t=in:st=0:d=${seconds(half)}:alpha=1,fade=t=out:st=${seconds(half)}:d=${seconds(half)}:alpha=1,setpts=PTS+${seconds(start)}/TB[${blackLabel}]`);
      } else if (fromClip) {
        filters.push(`color=c=black@1:s=${manifest.width}x${manifest.height}:r=${manifest.fps}:d=${seconds(actualDuration)},format=yuva420p,fade=t=in:st=0:d=${seconds(actualDuration)}:alpha=1,setpts=PTS+${seconds(start)}/TB[${blackLabel}]`);
      } else {
        filters.push(`color=c=black@1:s=${manifest.width}x${manifest.height}:r=${manifest.fps}:d=${seconds(actualDuration)},format=yuva420p,fade=t=out:st=0:d=${seconds(actualDuration)}:alpha=1,setpts=PTS+${seconds(start)}/TB[${blackLabel}]`);
      }
      filters.push(`[${currentVideo}][${blackLabel}]overlay=shortest=0:eof_action=pass:repeatlast=0[${nextVideo}]`);
    }
    currentVideo = nextVideo;
    transitionIndex += 1;
  });
  filters.push(`[${currentVideo}]trim=duration=${seconds(manifest.duration)},setpts=PTS-STARTPTS[vout]`);

  const audioParts = [];
  const trackKind = new Map(manifest.tracks.map((track) => [track.id, track.kind]));
  const addAudioPart = (clip, start, duration, sourceStart, prefix) => {
    if (!streamInfo[clip.assetId]?.audio) return;
    const label = `${prefix}${audioParts.length}`;
    const delayMs = Math.max(0, Math.round(start * 1000));
    filters.push(`[${inputIndex.get(clip.assetId)}:a]atrim=start=${seconds(sourceStart)}:duration=${seconds(duration)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,adelay=${delayMs}:all=1[${label}]`);
    audioParts.push(label);
  };
  manifest.clips.filter((clip) => trackKind.get(clip.trackId) === 'audio').forEach((clip) => {
    addAudioPart(clip, clip.start, Math.min(clip.duration, manifest.duration - clip.start), clip.sourceStart, 'atrack');
  });
  segments.filter((segment) => segment.clip && segment.asset?.kind === 'video' && !segment.clip.audioDetached).forEach((segment) => {
    addAudioPart(segment.clip, segment.start, segment.end - segment.start, segment.clip.sourceStart + segment.start - segment.clip.start, 'aembed');
  });
  if (audioParts.length) {
    filters.push(`${audioParts.map((label) => `[${label}]`).join('')}amix=inputs=${audioParts.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,apad,atrim=duration=${seconds(manifest.duration)}[aout]`);
  } else {
    filters.push(`anullsrc=r=48000:cl=stereo:d=${seconds(manifest.duration)}[aout]`);
  }

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(manifest.fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', '-t', seconds(manifest.duration), '-y', outputPath,
  );
  return {args, filterComplex: filters.join(';'), manifest, segments};
};

const runProcess = (command, args, {maxOutputBytes = 2_000_000} = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
  const stdout = [];
  const stderr = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  child.stdout.on('data', (chunk) => {
    stdoutSize += chunk.length;
    if (stdoutSize <= maxOutputBytes) stdout.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrSize += chunk.length;
    if (stderrSize <= maxOutputBytes) stderr.push(chunk);
  });
  child.on('error', reject);
  child.on('close', (code) => {
    const output = Buffer.concat(stdout).toString('utf8');
    const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
    if (code === 0) resolve({stdout: output, stderr: errorOutput});
    else reject(new Error(errorOutput || `${command} exited with code ${code}.`));
  });
});

const extensionFor = (asset, fileName) => {
  const requested = extname(fileName || '').toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(requested)) return requested;
  const byMime = {
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg',
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  };
  return byMime[asset.mimeType] || (asset.kind === 'image' ? '.png' : asset.kind === 'audio' ? '.wav' : '.mp4');
};

export const createTimelineExportService = ({
  rootDir,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe',
  temporaryRoot = tmpdir(),
  maxUploadBytes = MAX_UPLOAD_BYTES,
} = {}) => {
  if (!rootDir) throw new Error('Timeline export requires a root directory.');
  const sessions = new Map();

  const sessionFor = (sessionId) => {
    const session = sessions.get(assertSafeId(sessionId, 'Export session id'));
    if (!session) throw new Error('Export session was not found.');
    return session;
  };
  const cleanup = async (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    sessions.delete(sessionId);
    await rm(session.directory, {recursive: true, force: true});
    return true;
  };

  return {
    async createSession(rawManifest) {
      const manifest = normalizeTimelineExportManifest(rawManifest);
      const id = randomUUID();
      const directory = await mkdtemp(join(temporaryRoot, 'prismflow-export-'));
      sessions.set(id, {id, directory, manifest, assetPaths: new Map(), rendering: false});
      return {sessionId: id, assetIds: manifest.assets.map((asset) => asset.id)};
    },

    async uploadAsset(sessionId, assetId, readable, {fileName = '', mimeType = ''} = {}) {
      const session = sessionFor(sessionId);
      assertSafeId(assetId, 'Export asset id');
      const asset = session.manifest.assets.find((candidate) => candidate.id === assetId);
      if (!asset) throw new Error('This asset is not used by the export timeline.');
      if (session.rendering) throw new Error('This export is already rendering.');
      const decodedName = (() => { try { return decodeURIComponent(fileName); } catch { return fileName; } })();
      const filePath = join(session.directory, `${asset.id}${extensionFor({...asset, mimeType: mimeType || asset.mimeType}, decodedName)}`);
      let size = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          callback(size > maxUploadBytes ? new Error(`Export asset ${asset.name} is too large.`) : null, chunk);
        },
      });
      try {
        await pipeline(readable, limit, createWriteStream(filePath));
      } catch (error) {
        await rm(filePath, {force: true});
        throw error;
      }
      if (!size) throw new Error(`Export asset ${asset.name} is empty.`);
      session.assetPaths.set(asset.id, filePath);
      return {assetId, size};
    },

    async render(sessionId) {
      const session = sessionFor(sessionId);
      if (session.rendering) throw new Error('This export is already rendering.');
      const missing = session.manifest.assets.filter((asset) => !session.assetPaths.has(asset.id));
      if (missing.length) throw new Error(`Upload ${missing.map((asset) => asset.name).join(', ')} before rendering.`);
      session.rendering = true;
      try {
        const streamInfo = {};
        await Promise.all(session.manifest.assets.map(async (asset) => {
          const {stdout} = await runProcess(ffprobePath, [
            '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', session.assetPaths.get(asset.id),
          ]);
          const probe = JSON.parse(stdout || '{}');
          const types = new Set((probe.streams || []).map((stream) => stream.codec_type));
          streamInfo[asset.id] = {video: types.has('video'), audio: types.has('audio')};
          if (VISUAL_KINDS.has(asset.kind) && !types.has('video')) throw new Error(`${asset.name} does not contain a video or image stream.`);
          if (asset.kind === 'audio' && !types.has('audio')) throw new Error(`${asset.name} does not contain an audio stream.`);
        }));
        const sessionOutput = join(session.directory, 'output.mp4');
        const {args} = buildTimelineFfmpegArgs({manifest: session.manifest, assetPaths: session.assetPaths, streamInfo, outputPath: sessionOutput});
        await runProcess(ffmpegPath, args, {maxOutputBytes: 8_000_000});
        const stagedOutput = join(rootDir, `.output-${session.id}.mp4`);
        await copyFile(sessionOutput, stagedOutput);
        await rename(stagedOutput, join(rootDir, 'output.mp4'));
        const fileStat = await stat(sessionOutput);
        return {path: sessionOutput, stream: () => createReadStream(sessionOutput), size: fileStat.size, fileName: 'output.mp4', duration: session.manifest.duration};
      } catch (error) {
        session.rendering = false;
        throw error;
      }
    },

    cleanup,
  };
};
