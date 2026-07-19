import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MUSIC_MODEL_ID,
  VIDEO_MUSIC_MODEL_ID,
  createFalMusicGenerationAdapter,
} from '../server/music-generation-adapter.mjs';
import {
  createFakeMusicGenerationAdapter,
  createServerMusicGenerationAdapter,
  silentWavDataUrl,
} from '../src/music-generation.js';

const scoreContext = (overrides = {}) => ({
  project: {id: 'p1', name: 'The Glass Harbor'},
  theme: 'loss and return',
  narrative: {title: 'The Story Circle', tagline: 'you · need · go'},
  acts: [
    {actNumber: 1, actCount: 2, sceneId: 'scene-1', title: 'Departure', summary: 'Mara leaves.', beats: [{text: 'Mara at the pier', screenplay: 'EXT. PIER'}]},
    {actNumber: 2, actCount: 2, sceneId: 'scene-2', title: 'Return', summary: 'Mara returns.', beats: []},
  ],
  segments: [
    {startMs: 0, endMs: 8000, sceneId: 'scene-1', label: 'Pier shot', prompt: 'a foggy pier', annotation: 'A woman on a pier.'},
    {startMs: 8000, endMs: 14000, sceneId: 'scene-2', label: 'Return shot', prompt: '', annotation: null},
  ],
  durationMs: 14000,
  ...overrides,
});

const validCueSheetJson = () => JSON.stringify({
  global: {genre: 'noir strings', bpm: 120, key: 'D minor', instrumentation: ['cello'], moodArc: 'rise'},
  sections: [
    {name: 'Open', startMs: 0, intensity: 3, description: 'low cello', transition: 'swell'},
    {name: 'Return', startMs: 8000, intensity: 8, description: 'full strings', transition: 'decay'},
  ],
  hitPoints: [{timeMs: 8000, kind: 'climax', treatment: 'ensemble hit'}],
});

const stubFal = ({runResult, resultPayload, statusSequence = ['COMPLETED']} = {}) => {
  const calls = {run: [], submit: [], status: [], result: []};
  let statusIndex = 0;
  return {
    calls,
    configured: true,
    async run(modelId, input) {
      calls.run.push({modelId, input});
      return runResult ?? {output: validCueSheetJson(), usage: {cost: 0.001}};
    },
    async submit(modelId, input) {
      calls.submit.push({modelId, input});
      return {request_id: 'req-1'};
    },
    async status(modelId, requestId) {
      calls.status.push({modelId, requestId});
      const status = statusSequence[Math.min(statusIndex, statusSequence.length - 1)];
      statusIndex += 1;
      return {status};
    },
    async result(modelId, requestId) {
      calls.result.push({modelId, requestId});
      return resultPayload ?? {audio: {url: 'https://fal.media/score.mp3', content_type: 'audio/mpeg', file_name: 'score.mp3'}};
    },
  };
};

test('generateScoreDirection prompts the router with the full narrative context', async () => {
  const fal = stubFal();
  const adapter = createFalMusicGenerationAdapter({fal});
  const result = await adapter.generateScoreDirection({context: scoreContext()});
  const call = fal.calls.run[0];
  assert.equal(call.modelId, 'openrouter/router');
  assert.match(call.input.system_prompt, /cue sheet/);
  assert.match(call.input.system_prompt, /bar lines/);
  assert.match(call.input.prompt, /The Glass Harbor/);
  assert.match(call.input.prompt, /loss and return/);
  assert.match(call.input.prompt, /Act 1\/2: Departure/);
  assert.match(call.input.prompt, /Frame analysis: A woman on a pier\./);
  assert.match(call.input.prompt, /exactly 14000 milliseconds/);
  assert.equal(result.cueSheet.durationMs, 14000);
  assert.equal(result.cueSheet.sections.at(-1).endMs, 14000);
  // 120 BPM bar = 2000ms; the 8000ms boundary already sits on a bar line.
  assert.equal(result.cueSheet.sections[1].startMs, 8000);
  assert.equal(result.usage.cost, 0.001);
});

test('generateScoreDirection tolerates fenced JSON and rejects non-JSON', async () => {
  const fenced = stubFal({runResult: {output: '```json\n' + validCueSheetJson() + '\n```'}});
  const adapter = createFalMusicGenerationAdapter({fal: fenced});
  const result = await adapter.generateScoreDirection({context: scoreContext()});
  assert.equal(result.cueSheet.global.bpm, 120);

  const broken = createFalMusicGenerationAdapter({fal: stubFal({runResult: {output: 'sorry, no'}})});
  await assert.rejects(broken.generateScoreDirection({context: scoreContext()}), /JSON cue sheet/);
});

test('submitScore sends an ElevenLabs composition plan by default', async () => {
  const fal = stubFal();
  const adapter = createFalMusicGenerationAdapter({fal});
  const direction = await adapter.generateScoreDirection({context: scoreContext()});
  const submitted = await adapter.submitScore({cueSheet: direction.cueSheet, durationMs: 14000});
  assert.equal(submitted.jobId, 'req-1');
  assert.equal(submitted.modelId, DEFAULT_MUSIC_MODEL_ID);
  const {input} = fal.calls.submit[0];
  assert.equal(input.music_length_ms, undefined);
  assert.equal(input.force_instrumental, undefined);
  assert.equal(input.respect_sections_durations, true);
  assert.equal(
    input.composition_plan.sections.reduce((sum, section) => sum + section.duration_ms, 0),
    14000);
});

test('submitScore falls back to a single prompt for prompt-only music models', async () => {
  const fal = stubFal();
  const adapter = createFalMusicGenerationAdapter({fal});
  const direction = await adapter.generateScoreDirection({context: scoreContext()});
  await adapter.submitScore({cueSheet: direction.cueSheet, durationMs: 14000, modelId: 'fal-ai/lyria3/pro'});
  const {modelId, input} = fal.calls.submit[0];
  assert.equal(modelId, 'fal-ai/lyria3/pro');
  assert.match(input.prompt, /120 BPM/);
  assert.equal(input.composition_plan, undefined);
});

test('submitScore requires a video url for the video-to-music model', async () => {
  const fal = stubFal();
  const adapter = createFalMusicGenerationAdapter({fal});
  await assert.rejects(adapter.submitScore({modelId: VIDEO_MUSIC_MODEL_ID}), /videoUrl/);
  await adapter.submitScore({modelId: VIDEO_MUSIC_MODEL_ID, videoUrl: 'https://fal.media/video.mp4'});
  assert.equal(fal.calls.submit[0].input.video_url, 'https://fal.media/video.mp4');
});

test('getScoreJob follows the queue lifecycle and returns the audio asset', async () => {
  const fal = stubFal({statusSequence: ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']});
  const adapter = createFalMusicGenerationAdapter({fal});
  const direction = await adapter.generateScoreDirection({context: scoreContext()});
  const {jobId} = await adapter.submitScore({cueSheet: direction.cueSheet, durationMs: 14000});
  assert.equal((await adapter.getScoreJob(jobId)).status, 'queued');
  assert.equal((await adapter.getScoreJob(jobId)).status, 'running');
  const done = await adapter.getScoreJob(jobId);
  assert.equal(done.status, 'completed');
  assert.equal(done.asset.url, 'https://fal.media/score.mp3');
  assert.equal(done.asset.mimeType, 'audio/mpeg');
  assert.equal(done.cueSheet.durationMs, 14000);
  assert.deepEqual(done.source, {provider: 'fal', modelId: DEFAULT_MUSIC_MODEL_ID, jobId: 'req-1'});
  assert.equal((await adapter.getScoreJob('missing')).status, 'failed');
});

test('getScoreJob fails cleanly when no audio comes back', async () => {
  const fal = stubFal({resultPayload: {}});
  const adapter = createFalMusicGenerationAdapter({fal});
  const direction = await adapter.generateScoreDirection({context: scoreContext()});
  const {jobId} = await adapter.submitScore({cueSheet: direction.cueSheet, durationMs: 14000});
  const job = await adapter.getScoreJob(jobId);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /audio/);
});

test('fake adapter produces a valid cue sheet and a playable wav', async () => {
  const adapter = createFakeMusicGenerationAdapter();
  const direction = await adapter.generateScoreDirection({context: scoreContext()});
  assert.equal(direction.cueSheet.durationMs, 14000);
  assert.ok(direction.cueSheet.sections.length >= 1);
  assert.equal(direction.cueSheet.sections.at(-1).endMs, 14000);
  const {jobId} = await adapter.submitScore({cueSheet: direction.cueSheet, durationMs: 14000});
  assert.equal((await adapter.getScoreJob(jobId)).status, 'running');
  const done = await adapter.getScoreJob(jobId);
  assert.equal(done.status, 'completed');
  assert.match(done.asset.url, /^data:audio\/wav;base64,/);
  assert.equal(done.cueSheet.durationMs, 14000);
});

test('fake adapter fails deterministically on [fail] themes', async () => {
  const adapter = createFakeMusicGenerationAdapter();
  await assert.rejects(
    adapter.generateScoreDirection({context: scoreContext({theme: 'doom [fail] doom'})}),
    /Deterministic/);
});

test('silentWavDataUrl emits a well-formed RIFF header', () => {
  const url = silentWavDataUrl(500, 8000);
  const bytes = Buffer.from(url.split(',')[1], 'base64');
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(bytes.length, 44 + 4000);
});

test('server adapter round-trips the local music routes', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({url, options});
    const payload = url.startsWith('/api/music/jobs/')
      ? {status: 'completed', asset: {url: 'https://fal.media/score.mp3'}}
      : url === '/api/music/generate'
        ? {jobId: 'job-9', modelId: DEFAULT_MUSIC_MODEL_ID}
        : {cueSheet: {durationMs: 14000}, provider: 'fal'};
    return {ok: true, text: async () => JSON.stringify(payload)};
  };
  const adapter = createServerMusicGenerationAdapter({fetchImpl});
  await adapter.generateScoreDirection({context: scoreContext()});
  assert.equal(requests[0].url, '/api/music/score-direction');
  assert.equal(JSON.parse(requests[0].options.body).context.durationMs, 14000);
  const submitted = await adapter.submitScore({cueSheet: {durationMs: 14000}, durationMs: 14000});
  assert.equal(submitted.jobId, 'job-9');
  assert.equal(requests[1].url, '/api/music/generate');
  const job = await adapter.getScoreJob('job-9');
  assert.equal(job.status, 'completed');
  assert.equal(requests[2].url, '/api/music/jobs/job-9');
});

test('server adapter surfaces server errors and validates input', async () => {
  const adapter = createServerMusicGenerationAdapter({
    fetchImpl: async () => ({ok: false, status: 400, text: async () => JSON.stringify({error: 'nope'})}),
  });
  await assert.rejects(adapter.generateScoreDirection({context: scoreContext()}), /nope/);
  await assert.rejects(adapter.generateScoreDirection({context: {segments: []}}), /timeline segments/);
  await assert.rejects(adapter.getScoreJob(''), /Score job id/);
});
