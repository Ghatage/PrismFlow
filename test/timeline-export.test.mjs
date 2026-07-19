import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

import {createTimelineExportService, buildTimelineFfmpegArgs} from '../server/timeline-export.mjs';
import {buildTimelineExportManifest, createTimelineExporter} from '../src/timeline-export.js';

const execFileAsync = promisify(execFile);

const projectFixture = () => ({
  project: {id: 'project-export'},
  mediaAssets: [
    {id: 'video-low', name: 'Low.mp4', kind: 'video', mimeType: 'video/mp4'},
    {id: 'image-top', name: 'Top.png', kind: 'image', mimeType: 'image/png'},
    {id: 'dialogue', name: 'Dialogue.wav', kind: 'audio', mimeType: 'audio/wav'},
    {id: 'unused', name: 'Unused.mp4', kind: 'video', mimeType: 'video/mp4'},
  ],
  timeline: {
    duration: 5,
    tracks: [
      {id: 'V2', kind: 'video', order: 0},
      {id: 'V1', kind: 'video', order: 1},
      {id: 'A1', kind: 'audio', order: 2},
    ],
    clips: [
      {id: 'low', assetId: 'video-low', trackId: 'V1', start: 0, duration: 4, sourceStart: 1},
      {id: 'top', assetId: 'image-top', trackId: 'V2', start: 1, duration: 2, sourceStart: 0},
      {id: 'voice', assetId: 'dialogue', trackId: 'A1', start: 0.5, duration: 3, sourceStart: 0.25},
    ],
    transitions: [],
  },
  customTransitions: [],
});

test('builds an accepted-timeline export manifest with only used media', () => {
  const manifest = buildTimelineExportManifest(projectFixture(), {width: 1281, height: 721, fps: 30});
  assert.equal(manifest.projectId, 'project-export');
  assert.equal(manifest.duration, 5);
  assert.equal(manifest.width % 2, 0);
  assert.equal(manifest.height % 2, 0);
  assert.deepEqual(manifest.assets.map((asset) => asset.id), ['video-low', 'image-top', 'dialogue']);
  assert.deepEqual(manifest.tracks.map((track) => track.id), ['V2', 'V1', 'A1']);
  assert.equal(manifest.clips[0].sourceStart, 1);
});

test('builds FFmpeg filters for top-track video selection, gaps, embedded audio, and audio tracks', () => {
  const manifest = buildTimelineExportManifest(projectFixture(), {width: 640, height: 360, fps: 24});
  const built = buildTimelineFfmpegArgs({
    manifest,
    assetPaths: new Map([
      ['video-low', '/tmp/low.mp4'],
      ['image-top', '/tmp/top.png'],
      ['dialogue', '/tmp/dialogue.wav'],
    ]),
    streamInfo: {
      'video-low': {video: true, audio: true},
      'image-top': {video: true, audio: false},
      dialogue: {video: false, audio: true},
    },
    outputPath: '/tmp/output.mp4',
  });
  assert.deepEqual(built.segments.map((segment) => [segment.start, segment.end, segment.clip?.id || null]), [
    [0, 1, 'low'], [1, 3, 'top'], [3, 4, 'low'], [4, 5, null],
  ]);
  assert.match(built.filterComplex, /concat=n=4:v=1:a=0/);
  assert.match(built.filterComplex, /atrim=start=0\.25:duration=3/);
  assert.match(built.filterComplex, /aembed/);
  assert.match(built.filterComplex, /amix=inputs=3/);
  assert.ok(built.args.includes('libx264'));
  assert.equal(built.args.at(-1), '/tmp/output.mp4');
});

test('uploads timeline media, renders, and downloads the response as output.mp4', async () => {
  const project = projectFixture();
  const requests = [];
  let downloaded = null;
  const exporter = createTimelineExporter({
    resolveAssetBlob: async (asset) => new Blob([asset.id], {type: asset.mimeType}),
    download: (blob, fileName) => { downloaded = {blob, fileName}; },
    fetchImpl: async (url, options = {}) => {
      requests.push({url, method: options.method || 'GET', body: options.body});
      if (url === '/api/export/sessions') return new Response(JSON.stringify({sessionId: 'session-1'}), {status: 201, headers: {'Content-Type': 'application/json'}});
      if (url.endsWith('/render')) return new Response(new Uint8Array([0, 0, 0, 24]), {status: 200, headers: {'Content-Type': 'video/mp4'}});
      if (options.method === 'PUT') return new Response(JSON.stringify({ok: true}), {status: 201, headers: {'Content-Type': 'application/json'}});
      if (options.method === 'DELETE') return new Response(null, {status: 204});
      throw new Error(`Unexpected request: ${options.method} ${url}`);
    },
  });
  const progress = [];
  const result = await exporter.exportProject(project, {onProgress: (entry) => progress.push(entry.phase)});
  assert.equal(result.fileName, 'output.mp4');
  assert.equal(downloaded.fileName, 'output.mp4');
  assert.equal(downloaded.blob.type, 'video/mp4');
  assert.equal(requests.filter((request) => request.method === 'PUT').length, 3);
  assert.equal(requests.at(-1).method, 'DELETE');
  assert.deepEqual([...new Set(progress)], ['preparing', 'uploading', 'rendering', 'completed']);
});

test('renders a real H.264/AAC output.mp4 and keeps a copy at the project root', {timeout: 30_000}, async (context) => {
  const scratch = await mkdtemp(join(tmpdir(), 'prismflow-export-test-'));
  context.after(() => rm(scratch, {recursive: true, force: true}));
  const sourceVideo = join(scratch, 'source.mp4');
  const sourceAudio = join(scratch, 'music.wav');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x336699:s=160x90:r=24:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', sourceVideo,
  ]);
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=1', '-c:a', 'pcm_s16le', '-y', sourceAudio,
  ]);

  const manifest = {
    schemaVersion: 1, projectId: 'integration', width: 320, height: 180, fps: 24, duration: 2,
    tracks: [{id: 'V1', kind: 'video', order: 0}, {id: 'A1', kind: 'audio', order: 1}],
    assets: [
      {id: 'video', name: 'source.mp4', kind: 'video', mimeType: 'video/mp4'},
      {id: 'music', name: 'music.wav', kind: 'audio', mimeType: 'audio/wav'},
    ],
    clips: [
      {id: 'video-clip-a', assetId: 'video', trackId: 'V1', start: 0, duration: 1, sourceStart: 0, audioDetached: false},
      {id: 'video-clip-b', assetId: 'video', trackId: 'V1', start: 1, duration: 1, sourceStart: 0, audioDetached: false},
      {id: 'music-clip', assetId: 'music', trackId: 'A1', start: 0, duration: 1, sourceStart: 0, audioDetached: false},
    ],
    transitions: [{id: 'crossfade', type: 'crossfade', fromClipId: 'video-clip-a', toClipId: 'video-clip-b', duration: 0.25}],
    customTransitions: [],
  };
  const service = createTimelineExportService({rootDir: scratch, temporaryRoot: scratch});
  const {sessionId} = await service.createSession(manifest);
  await service.uploadAsset(sessionId, 'video', createReadStream(sourceVideo), {fileName: 'source.mp4', mimeType: 'video/mp4'});
  await service.uploadAsset(sessionId, 'music', createReadStream(sourceAudio), {fileName: 'music.wav', mimeType: 'audio/wav'});
  const result = await service.render(sessionId);
  assert.ok(result.size > 1000);
  assert.ok((await stat(join(scratch, 'output.mp4'))).size > 1000);
  const {stdout} = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', join(scratch, 'output.mp4')]);
  const streams = JSON.parse(stdout).streams;
  assert.deepEqual(streams.map((stream) => stream.codec_type).sort(), ['audio', 'video']);
  assert.equal(streams.find((stream) => stream.codec_type === 'video').codec_name, 'h264');
  assert.equal(streams.find((stream) => stream.codec_type === 'audio').codec_name, 'aac');
  assert.ok((await readFile(join(scratch, 'output.mp4'))).length > 1000);
  await service.cleanup(sessionId);
});
