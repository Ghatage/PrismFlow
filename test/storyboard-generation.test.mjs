import assert from 'node:assert/strict';
import test from 'node:test';

import {createFalStoryboardGenerationAdapter} from '../server/storyboard-generation-adapter.mjs';
import {
  CUT_AND_DIALOGUE_DIRECTION,
  MAX_BEAT_VIDEO_SHOT_SECONDS,
  normalizeTimedVideoPrompt,
} from '../src/beat-video.js';
import {
  createFakeStoryboardGenerationAdapter,
  createServerStoryboardGenerationAdapter,
  stableStillSeed,
} from '../src/storyboard-generation.js';

const context = ({aspectRatio = '9:16'} = {}) => ({
  project: {id: 'project-story', name: 'The Glass Harbor', metadata: {aspectRatio}},
  narrative: {
    id: 'story-circle', title: 'The Story Circle', authors: ['Dan Harmon'],
    tagline: 'you · need · go · search · find · take · return · change',
    notes: ['Order descends into chaos and returns changed.'],
  },
  act: {id: 'act-one', sceneId: 'scene-one', actNumber: 1, title: 'Departure', summary: 'Mara leaves the harbor.'},
  storySoFar: [{
    id: 'act-prologue', actNumber: 0, title: 'Prologue', summary: 'The harbor sleeps.',
    beats: [{id: 'beat-old', text: 'A bell rings beneath the sea.', screenplay: 'A submerged bell moves.'}],
  }],
  target: {
    id: 'beat-current',
    text: 'Mara boards the last ferry as the tide rises into the sky.',
    screenplay: 'EXT. HARBOR — DAWN\nMara steps onto the ferry.',
  },
  characters: [
    {
      id: 'character-mara', name: 'Mara', versionId: 'mara-v2', sheetAssetId: 'sheet-v2',
      prompt: 'A young sailor in a red raincoat', mentioned: true,
    },
    {
      id: 'character-pip', name: 'Pip', versionId: 'pip-v1', sheetAssetId: 'sheet-pip',
      prompt: 'A grey harbor mouse in a patched coat', mentioned: false,
    },
  ],
  style: {
    bible: 'Hand-painted 2D animation, dusk palette, soft rim light, 35mm film grain.',
    referenceAssetIds: ['style-ref-1'],
  },
  previousStill: {beatId: 'beat-old', assetId: 'still-beat-old'},
});

test('beat still generation sends story context and character sheets to Nano Banana 2 Edit', async () => {
  const submissions = [];
  const fal = {
    configured: true,
    async submit(modelId, input) {
      submissions.push({modelId, input});
      return {request_id: 'still-job-1'};
    },
    async status() { return {status: 'IN_QUEUE'}; },
    async result() { throw new Error('not completed'); },
    async run() { throw new Error('not used'); },
  };
  const adapter = createFalStoryboardGenerationAdapter({fal, createSeed: () => 42});

  assert.deepEqual(await adapter.submitStill({
    context: context(),
    referenceUrls: ['https://assets.test/mara-sheet.png'],
  }), {jobId: 'still-job-1'});

  assert.equal(submissions[0].modelId, 'fal-ai/nano-banana-2/edit');
  assert.equal(submissions[0].input.aspect_ratio, '9:16');
  assert.equal(submissions[0].input.seed, 42);
  assert.deepEqual(submissions[0].input.image_urls, ['https://assets.test/mara-sheet.png']);
  assert.match(submissions[0].input.prompt, /Mara boards the last ferry/);
  assert.match(submissions[0].input.prompt, /A bell rings beneath the sea/);
  assert.match(submissions[0].input.prompt, /cinematic single frame/i);
  assert.match(submissions[0].input.prompt, /camera|lens/i);
  assert.match(submissions[0].input.prompt, /identity/i);
  assert.match(submissions[0].input.prompt, /Visual style bible/);
  assert.match(submissions[0].input.prompt, /Hand-painted 2D animation/);
  assert.match(submissions[0].input.prompt, /Characters in this frame: Mara/);
  assert.match(submissions[0].input.prompt, /Other established cast[^:]*: Pip/);
  assert.match(submissions[0].input.prompt, /target beat and target screenplay are authoritative/i);
  assert.deepEqual(await adapter.getStillJob('still-job-1'), {status: 'queued'});
});

test('beat still generation orders character, style, and previous-frame references and honors a caller seed', async () => {
  const submissions = [];
  const fal = {
    configured: true,
    async submit(modelId, input) {
      submissions.push({modelId, input});
      return {request_id: 'still-job-3'};
    },
    async status() { return {status: 'IN_QUEUE'}; },
    async result() { throw new Error('not completed'); },
    async run() { throw new Error('not used'); },
  };
  const adapter = createFalStoryboardGenerationAdapter({fal, createSeed: () => { throw new Error('caller seed must win'); }});

  await adapter.submitStill({
    context: context(),
    referenceUrls: ['https://assets.test/mara-sheet.png', 'https://assets.test/pip-sheet.png'],
    styleReferenceUrls: ['https://assets.test/mara-sheet.png', 'https://assets.test/style-1.png'],
    previousStillUrl: 'https://assets.test/previous-frame.png',
    seed: 1234,
  });

  assert.equal(submissions[0].modelId, 'fal-ai/nano-banana-2/edit');
  assert.equal(submissions[0].input.seed, 1234);
  assert.deepEqual(submissions[0].input.image_urls, [
    'https://assets.test/mara-sheet.png',
    'https://assets.test/pip-sheet.png',
    'https://assets.test/style-1.png',
    'https://assets.test/previous-frame.png',
  ]);
  assert.match(submissions[0].input.prompt, /first 2 reference images are character reference sheets/i);
  assert.match(submissions[0].input.prompt, /reference image is a visual style reference/i);
  assert.match(submissions[0].input.prompt, /final reference image is the previous storyboard frame/i);
  assert.match(submissions[0].input.prompt, /target overrides this frame/i);
  assert.match(submissions[0].input.prompt, /never reuse its camera, composition, staging, or pose/i);
});

test('stable still seeds are deterministic per beat and differ between beats', () => {
  assert.equal(stableStillSeed('project-story', 'beat-a'), stableStillSeed('project-story', 'beat-a'));
  assert.notEqual(stableStillSeed('project-story', 'beat-a'), stableStillSeed('project-story', 'beat-b'));
  const seed = stableStillSeed('project-story', 'beat-a');
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 2_147_483_647);
});

test('text-only beat stills fall back to 16:9 and return durable generation provenance', async () => {
  const submissions = [];
  const fal = {
    configured: true,
    async submit(modelId, input) {
      submissions.push({modelId, input});
      return {request_id: 'still-job-2'};
    },
    async status() { return {status: 'COMPLETED'}; },
    async result() {
      return {images: [{
        url: 'https://fal.media/beat.png', content_type: 'image/png', file_name: 'beat.png', width: 1024, height: 576,
      }]};
    },
    async run() { throw new Error('not used'); },
  };
  const adapter = createFalStoryboardGenerationAdapter({fal, createSeed: () => 77});
  await adapter.submitStill({context: context({aspectRatio: 'cinemascope'}), referenceUrls: []});

  assert.equal(submissions[0].modelId, 'fal-ai/nano-banana-2');
  assert.equal(submissions[0].input.aspect_ratio, '16:9');
  assert.equal(submissions[0].input.image_urls, undefined);
  const completed = await adapter.getStillJob('still-job-2');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.asset, {
    url: 'https://fal.media/beat.png',
    mimeType: 'image/png',
    fileName: 'beat.png',
    width: 1024,
    height: 576,
  });
  assert.equal(completed.source.provider, 'fal');
  assert.equal(completed.source.modelId, 'fal-ai/nano-banana-2');
  assert.equal(completed.source.jobId, 'still-job-2');
  assert.equal(completed.seed, 77);
  assert.match(completed.prompt, /Target beat/);
});

test('beat still generation rejects more than fourteen distinct character references before queueing', async () => {
  let submitted = false;
  const fal = {
    configured: true,
    async submit() { submitted = true; },
    async status() { throw new Error('not used'); },
    async result() { throw new Error('not used'); },
    async run() { throw new Error('not used'); },
  };
  const adapter = createFalStoryboardGenerationAdapter({fal});

  await assert.rejects(() => adapter.submitStill({
    context: context(),
    referenceUrls: Array.from({length: 15}, (_, index) => `https://assets.test/character-${index}.png`),
  }), /at most 14 character reference images/i);
  assert.equal(submitted, false);
});

test('screenplay generation uses the server-selected Gemini model and returns editable text with usage', async () => {
  const runs = [];
  const fal = {
    configured: true,
    async submit() { throw new Error('not used'); },
    async status() { throw new Error('not used'); },
    async result() { throw new Error('not used'); },
    async run(modelId, input) {
      runs.push({modelId, input});
      return {
        output: 'EXT. HARBOR — DAWN\n\nMara grips the ferry rail as the ocean climbs into the clouds.',
        usage: {prompt_tokens: 300, completion_tokens: 24, total_tokens: 324, cost: 0.0008},
      };
    },
  };
  const adapter = createFalStoryboardGenerationAdapter({
    fal,
    scriptModelId: 'google/gemini-2.5-flash',
  });

  const generated = await adapter.generateScreenplay({context: context()});
  assert.equal(runs[0].modelId, 'openrouter/router');
  assert.equal(runs[0].input.model, 'google/gemini-2.5-flash');
  assert.equal(runs[0].input.temperature, 0.7);
  assert.equal(runs[0].input.max_tokens, 900);
  assert.match(runs[0].input.system_prompt, /screenwriter/i);
  assert.match(runs[0].input.system_prompt, /without markdown/i);
  assert.match(runs[0].input.prompt, /The Story Circle/);
  assert.match(runs[0].input.prompt, /A bell rings beneath the sea/);
  assert.match(runs[0].input.prompt, /Mara boards the last ferry/);
  assert.deepEqual(generated, {
    text: 'EXT. HARBOR — DAWN\n\nMara grips the ferry rail as the ocean climbs into the clouds.',
    provider: 'fal',
    modelId: 'google/gemini-2.5-flash',
    usage: {prompt_tokens: 300, completion_tokens: 24, total_tokens: 324, cost: 0.0008},
  });
});

test('beat video prompt generation produces bounded timecodes and an immutable no-music direction', async () => {
  const runs = [];
  const fal = {
    configured: true,
    async submit() { throw new Error('not used'); },
    async status() { throw new Error('not used'); },
    async result() { throw new Error('not used'); },
    async run(modelId, input) {
      runs.push({modelId, input});
      return {
        output: [
          '00:00 - 00:02 @Image1 opens as a low-angle close-up on Mara. DIALOGUE (Mara, 1.4s): "The tide is rising."',
          '00:02 - 00:04 HARD CUT to a wide profile as Mara stands. DIALOGUE (Mara, 1.6s): "I cannot wait here."',
          '00:04 - 00:06 HARD CUT to an overhead reaction shot on Pip. DIALOGUE (Pip, 1.2s): "Then we leave now."',
          '00:06 - 00:08 This segment exceeds the requested duration and must be removed.',
        ].join('\n'),
        usage: {prompt_tokens: 410, completion_tokens: 92},
      };
    },
  };
  const adapter = createFalStoryboardGenerationAdapter({fal, scriptModelId: 'google/gemini-2.5-flash'});

  const generated = await adapter.generateVideoPrompt({context: context(), duration: 6});

  assert.equal(runs[0].modelId, 'openrouter/router');
  assert.equal(runs[0].input.model, 'google/gemini-2.5-flash');
  assert.match(runs[0].input.system_prompt, /timecoded/i);
  assert.match(runs[0].input.system_prompt, /hard cut/i);
  assert.match(runs[0].input.system_prompt, /no more than 3 seconds/i);
  assert.match(runs[0].input.system_prompt, /speak to themself/i);
  assert.match(runs[0].input.prompt, /exactly 6 seconds/i);
  assert.match(runs[0].input.prompt, /Do not use a master shot as the whole video/i);
  assert.match(runs[0].input.prompt, /dialogue.*every cut/i);
  assert.match(runs[0].input.prompt, /Mara steps onto the ferry/);
  assert.match(generated.text, /^00:00 - 00:02/m);
  assert.match(generated.text, /^00:04 - 00:06/m);
  assert.doesNotMatch(generated.text, /00:08/);
  assert.match(generated.text, /@Image1/);
  assert.equal(generated.text.match(/DIALOGUE \(/g)?.length, 3);
  assert.match(generated.text, /Treat every timecoded segment as a hard camera cut/i);
  assert.match(generated.text, /No music or musical score/i);
  assert.equal(generated.duration, 6);
});

test('beat video prompt normalization rejects long cuts and missing or long dialogue', () => {
  assert.equal(MAX_BEAT_VIDEO_SHOT_SECONDS, 3);
  assert.match(CUT_AND_DIALOGUE_DIRECTION, /hard camera cut/i);
  assert.throws(() => normalizeTimedVideoPrompt([
    '00:00 - 00:04 @Image1 holds one unbroken master shot. DIALOGUE (Mara, 2s): "I am still here."',
  ].join('\n'), 4), /3 seconds or shorter/i);
  assert.throws(() => normalizeTimedVideoPrompt([
    '00:00 - 00:02 @Image1 cuts close on Mara without speech.',
    '00:02 - 00:04 HARD CUT wider. DIALOGUE (Mara, 1s): "Now."',
  ].join('\n'), 4), /Every generated video prompt cut must include DIALOGUE/i);
  assert.throws(() => normalizeTimedVideoPrompt([
    '00:00 - 00:02 @Image1 cuts close. DIALOGUE (Mara, 3s): "This line runs too long."',
    '00:02 - 00:04 HARD CUT wider. DIALOGUE (Mara, 1s): "Now."',
  ].join('\n'), 4), /Every generated video prompt cut must include DIALOGUE/i);
});

test('browser storyboard adapter sends structured context and uploadable references without provider credentials', async () => {
  const requests = [];
  const responses = [
    new Response(JSON.stringify({jobId: 'browser-still-job'}), {status: 202, headers: {'Content-Type': 'application/json'}}),
    new Response(JSON.stringify({status: 'queued'}), {status: 200, headers: {'Content-Type': 'application/json'}}),
    new Response(JSON.stringify({text: 'INT. FERRY — DAWN\nMara watches the sky.', provider: 'fal', modelId: 'google/gemini-2.5-flash', usage: {cost: 0.001}}), {status: 200, headers: {'Content-Type': 'application/json'}}),
    new Response(JSON.stringify({text: '00:00 - 00:02 @Image1 starts close. DIALOGUE (Mara, 1s): "Wake up."\n00:02 - 00:04 HARD CUT wide. DIALOGUE (Pip, 1s): "I am awake."\n00:04 - 00:06 HARD CUT overhead. DIALOGUE (Mara, 1s): "Then move."\nEDITING DIRECTION: Treat every timecoded segment as a hard camera cut.\nAUDIO DIRECTION: No music or musical score.', duration: 6, provider: 'fal', modelId: 'google/gemini-2.5-flash'}), {status: 200, headers: {'Content-Type': 'application/json'}}),
  ];
  const uploadable = {
    'blob:http://localhost/mara': 'data:image/png;base64,AAAA',
    'blob:http://localhost/style': 'data:image/png;base64,BBBB',
    'blob:http://localhost/previous': 'data:image/png;base64,CCCC',
  };
  const adapter = createServerStoryboardGenerationAdapter({
    resolveReferenceUrl: (assetId) => ({
      'sheet-v2': 'blob:http://localhost/mara',
      'style-ref-1': 'blob:http://localhost/style',
      'still-beat-old': 'blob:http://localhost/previous',
    })[assetId] || null,
    toUploadableUrl: async (url) => uploadable[url] || null,
    fetchImpl: async (url, options = {}) => {
      requests.push({url, options});
      return responses.shift();
    },
  });

  assert.deepEqual(await adapter.submitStill({
    context: context(),
    referenceAssetIds: ['sheet-v2'],
    styleReferenceAssetIds: ['style-ref-1'],
    previousStillAssetId: 'still-beat-old',
    seed: 4242,
  }), {jobId: 'browser-still-job'});
  assert.deepEqual(await adapter.getStillJob('browser-still-job'), {status: 'queued'});
  assert.match((await adapter.generateScreenplay({context: context()})).text, /INT\. FERRY/);
  assert.equal((await adapter.generateVideoPrompt({context: context(), duration: 6})).duration, 6);

  assert.deepEqual(requests.map((request) => request.url), [
    '/api/storyboard/stills',
    '/api/storyboard/stills/browser-still-job',
    '/api/storyboard/scripts/generate',
    '/api/storyboard/video-prompts/generate',
  ]);
  const stillBody = JSON.parse(requests[0].options.body);
  assert.deepEqual(stillBody.referenceUrls, ['data:image/png;base64,AAAA']);
  assert.deepEqual(stillBody.styleReferenceUrls, ['data:image/png;base64,BBBB']);
  assert.equal(stillBody.previousStillUrl, 'data:image/png;base64,CCCC');
  assert.equal(stillBody.seed, 4242);
  assert.equal(stillBody.context.target.id, 'beat-current');
  assert.equal(stillBody.modelId, undefined);
  assert.equal(requests.some((request) => request.options.headers?.Authorization), false);
  assert.equal(JSON.stringify(requests).includes('FAL_KEY'), false);
});

test('fake storyboard adapter completes stills and screenplay without remote requests', async () => {
  const adapter = createFakeStoryboardGenerationAdapter({createId: () => 'fake-storyboard-job'});
  assert.deepEqual(await adapter.submitStill({context: context(), referenceAssetIds: ['sheet-v2']}), {
    jobId: 'fake-storyboard-job',
  });
  assert.deepEqual(await adapter.getStillJob('fake-storyboard-job'), {status: 'running'});
  const completed = await adapter.getStillJob('fake-storyboard-job');
  assert.equal(completed.status, 'completed');
  assert.match(completed.asset.url, /^data:image\/svg\+xml/);
  assert.equal(completed.source.provider, 'local-fake');
  assert.deepEqual(completed.characterVersionIds, ['mara-v2', 'pip-v1']);

  const script = await adapter.generateScreenplay({context: context()});
  assert.match(script.text, /EXT\. HARBOR/);
  assert.equal(script.modelId, 'local/fake-gemini-screenplay-v1');
  const videoPrompt = await adapter.generateVideoPrompt({context: context(), duration: 6});
  assert.match(videoPrompt.text, /^00:00 - 00:02/m);
  assert.match(videoPrompt.text, /HARD CUT/);
  assert.equal(videoPrompt.text.match(/DIALOGUE \(/g)?.length, 3);
  assert.match(videoPrompt.text, /No music or musical score/i);
  assert.equal(videoPrompt.duration, 6);
});

test('fake storyboard failures are explicit and a corrected beat can be retried as a new job', async () => {
  let nextId = 0;
  const adapter = createFakeStoryboardGenerationAdapter({createId: () => `fake-storyboard-job-${++nextId}`});
  const failingContext = context();
  failingContext.target.text = '[fail] Mara misses the ferry.';
  const failedJob = await adapter.submitStill({context: failingContext});
  await adapter.getStillJob(failedJob.jobId);
  assert.deepEqual(await adapter.getStillJob(failedJob.jobId), {
    status: 'failed',
    error: 'Deterministic local storyboard failure. Remove [fail] and retry.',
  });
  await assert.rejects(() => adapter.generateScreenplay({context: failingContext}), /Deterministic local screenplay failure/);

  const retry = await adapter.submitStill({context: context()});
  assert.notEqual(retry.jobId, failedJob.jobId);
  await adapter.getStillJob(retry.jobId);
  assert.equal((await adapter.getStillJob(retry.jobId)).status, 'completed');
});
