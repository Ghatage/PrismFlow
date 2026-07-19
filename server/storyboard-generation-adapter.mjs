import {
  normalizeSeedanceDuration,
  normalizeTimedVideoPrompt,
} from '../src/beat-video.js';

const STILL_MODEL_ID = 'fal-ai/nano-banana-2';
const STILL_EDIT_MODEL_ID = 'fal-ai/nano-banana-2/edit';
const SCRIPT_ENDPOINT_ID = 'openrouter/router';
const SUPPORTED_ASPECT_RATIOS = new Set([
  '21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16',
]);

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};

const referenceUrls = (value) => [...new Set((Array.isArray(value) ? value : [])
  .filter((url) => typeof url === 'string' && /^(https:\/\/|data:image\/)/i.test(url.trim()))
  .map((url) => url.trim()))];

const storyText = (context) => (context.storySoFar || []).map((act) => {
  const beats = (act.beats || []).map((beat) => [
    `Beat: ${beat.text}`,
    beat.screenplay ? `Screenplay: ${beat.screenplay}` : '',
  ].filter(Boolean).join('\n')).join('\n');
  return [`Act ${act.actNumber}: ${act.title}`, act.summary, beats].filter(Boolean).join('\n');
}).join('\n\n');

const styleBible = (context) => String(context.style?.bible || '').trim();

const castLine = (characters, label) => characters.length
  ? `${label}: ${characters.map((character) => `${character.name}: ${character.prompt || 'preserve the established design'}`).join('; ')}.`
  : '';

const referenceImagePlan = ({characterCount = 0, styleCount = 0, hasPreviousStill = false} = {}) => [
  characterCount
    ? `The first ${characterCount === 1 ? 'reference image is a character reference sheet' : `${characterCount} reference images are character reference sheets`}. Preserve the exact identity, face, clothing, proportions, and design language of every character from their sheet.`
    : '',
  styleCount
    ? `The ${characterCount ? 'next' : 'first'} ${styleCount === 1 ? 'reference image is a visual style reference' : `${styleCount} reference images are visual style references`}. Match their rendering style, palette, lighting quality, and color grade exactly.`
    : '',
  hasPreviousStill
    ? 'The final reference image is the previous storyboard frame. Keep the same world: match its environment, production design, lighting, and color grade exactly; change only the staging and camera this beat requires.'
    : '',
].filter(Boolean);

const buildStillPrompt = (context, plan = {}) => {
  const characters = context.characters || [];
  const inFrame = characters.filter((character) => character.mentioned !== false);
  const offFrame = characters.filter((character) => character.mentioned === false);
  return [
    'Create one cinematic single frame for a film storyboard.',
    `Project: ${context.project?.name || 'Untitled project'}.`,
    styleBible(context) ? `Visual style bible — apply to every frame of this film, exactly and without reinterpretation: ${styleBible(context)}` : '',
    context.narrative?.title ? `Narrative structure: ${context.narrative.title}. ${context.narrative.tagline || ''}` : '',
    context.narrative?.notes?.length ? `Narrative direction: ${context.narrative.notes.join(' ')}` : '',
    `Current act: ${context.act?.title || 'Untitled act'}. ${context.act?.summary || ''}`,
    storyText(context) ? `Story so far:\n${storyText(context)}` : '',
    `Target beat: ${requiredText(context.target?.text, 'Target beat')}`,
    context.target?.screenplay ? `Target screenplay:\n${context.target.screenplay}` : '',
    castLine(inFrame, 'Characters in this frame'),
    castLine(offFrame, 'Other established cast — include only when the target beat calls for them'),
    ...referenceImagePlan(plan),
    'Choose expressive but story-appropriate blocking, a deliberate camera angle and lens, strong foreground/midground/background composition, motivated cinematic lighting, coherent production design, and a controlled film color grade.',
    'Show one continuous moment only. No contact sheet, split panel, captions, typography, UI, watermark, or presentation mockup.',
  ].filter(Boolean).join('\n\n');
};

const SCREENPLAY_SYSTEM_PROMPT = [
  'You are a precise cinematic screenwriter expanding one storyboard beat at a time.',
  'Write only the action and dialogue needed for the target beat, in concise screenplay form.',
  'Maintain continuity with the supplied story so far, narrative structure, act intent, and character descriptions.',
  'Return editable plain text without Markdown, code fences, a title, analysis, preamble, or explanation.',
].join(' ');

const VIDEO_PROMPT_SYSTEM_PROMPT = [
  'You are a cinematic shot planner converting one screenplay beat into a compact timecoded Seedance 2.0 prompt.',
  'Every non-empty line must use exactly this format: 00:SS - 00:SS visual action and audio detail.',
  'Use @Image1 as the exact opening-frame visual reference and preserve its identities, wardrobe, setting, and style.',
  'Describe camera movement, blocking, performance, lighting, environmental sound, sound effects, and dialogue where useful.',
  'Never request music, a musical score, a soundtrack, singing, or rhythmic underscore.',
  'Return plain text only with no Markdown, title, analysis, or preamble.',
].join(' ');

const buildScreenplayPrompt = (context) => [
  `Project: ${context.project?.name || 'Untitled project'}`,
  styleBible(context) ? `Visual style bible for this film: ${styleBible(context)}` : '',
  context.narrative?.title ? `Narrative structure: ${context.narrative.title}\n${context.narrative.tagline || ''}` : '',
  context.narrative?.notes?.length ? `Narrative notes: ${context.narrative.notes.join(' ')}` : '',
  `Current act: ${context.act?.title || 'Untitled act'}\n${context.act?.summary || ''}`,
  storyText(context) ? `Story so far:\n${storyText(context)}` : '',
  (context.characters || []).length
    ? `Characters: ${context.characters.map((character) => `${character.name}: ${character.prompt || 'established character'}`).join('; ')}`
    : '',
  `Target beat to write:\n${requiredText(context.target?.text, 'Target beat')}`,
  'Write the screenplay block for this beat only.',
].filter(Boolean).join('\n\n');

const buildVideoPromptPrompt = (context, duration) => [
  `Create a timecoded video prompt lasting exactly ${duration} seconds. Do not write any segment beyond 00:${String(duration).padStart(2, '0')}.`,
  `Project: ${context.project?.name || 'Untitled project'}`,
  styleBible(context) ? `Visual style bible — every segment must stay inside this look: ${styleBible(context)}` : '',
  context.narrative?.title ? `Narrative structure: ${context.narrative.title}\n${context.narrative.tagline || ''}` : '',
  context.narrative?.notes?.length ? `Narrative notes: ${context.narrative.notes.join(' ')}` : '',
  `Current act: ${context.act?.title || 'Untitled act'}\n${context.act?.summary || ''}`,
  storyText(context) ? `Story so far:\n${storyText(context)}` : '',
  (context.characters || []).length
    ? `Characters: ${context.characters.map((character) => `${character.name}: ${character.prompt || 'established character'}`).join('; ')}`
    : '',
  `Target beat: ${requiredText(context.target?.text, 'Target beat')}`,
  context.target?.screenplay ? `Target screenplay:\n${context.target.screenplay}` : 'No screenplay is available; infer action only from the target beat.',
  'Break the action into chronological segments that fit completely inside the selected duration. The first segment must explicitly refer to @Image1.',
].filter(Boolean).join('\n\n');

const plainText = (value) => requiredText(value, 'Generated screenplay')
  .replace(/^```(?:[a-z]+)?\s*/i, '')
  .replace(/\s*```$/, '')
  .trim();

export const createFalStoryboardGenerationAdapter = ({
  fal,
  createSeed = () => Math.floor(Math.random() * 2_147_483_647),
  scriptModelId = process.env.PRISMFLOW_STORYBOARD_SCRIPT_MODEL || 'google/gemini-2.5-flash',
} = {}) => {
  if (!fal?.submit || !fal?.status || !fal?.result || !fal?.run) {
    throw new TypeError('Storyboard generation requires FAL run and queue operations.');
  }
  const jobs = new Map();

  const submitStill = async (input = {}) => {
    const characterRefs = referenceUrls(input.referenceUrls);
    if (characterRefs.length > 14) throw new Error('Nano Banana 2 accepts at most 14 character reference images.');
    // Reference order is part of the prompt contract: character sheets first,
    // style references next, previous storyboard frame always last.
    let previousStill = referenceUrls([input.previousStillUrl])
      .find((url) => !characterRefs.includes(url)) || null;
    if (characterRefs.length >= 14) previousStill = null;
    const styleRefs = referenceUrls(input.styleReferenceUrls)
      .filter((url) => !characterRefs.includes(url) && url !== previousStill)
      .slice(0, Math.max(0, 14 - characterRefs.length - (previousStill ? 1 : 0)));
    const refs = [...characterRefs, ...styleRefs, ...(previousStill ? [previousStill] : [])];
    const context = input.context || {};
    const modelId = refs.length ? STILL_EDIT_MODEL_ID : STILL_MODEL_ID;
    const requestedRatio = context.project?.metadata?.aspectRatio;
    const aspectRatio = SUPPORTED_ASPECT_RATIOS.has(requestedRatio) ? requestedRatio : '16:9';
    const requestedSeed = Number(input.seed);
    const seed = Number.isInteger(requestedSeed) && requestedSeed >= 0 ? requestedSeed : createSeed();
    const prompt = buildStillPrompt(context, {
      characterCount: characterRefs.length,
      styleCount: styleRefs.length,
      hasPreviousStill: Boolean(previousStill),
    });
    const payload = {
      prompt,
      num_images: 1,
      seed,
      aspect_ratio: aspectRatio,
      output_format: 'png',
      safety_tolerance: '4',
      sync_mode: false,
      resolution: '1K',
      limit_generations: true,
      enable_web_search: false,
      ...(refs.length ? {image_urls: refs} : {}),
    };
    const submitted = await fal.submit(modelId, payload);
    const jobId = requiredText(submitted?.request_id || submitted?.requestId, 'FAL request id');
    jobs.set(jobId, {modelId, seed, prompt, aspectRatio, context});
    return {jobId};
  };

  const getStillJob = async (jobId) => {
    const job = jobs.get(jobId);
    if (!job) return {status: 'failed', error: 'Storyboard still job was not found.'};
    try {
      const status = await fal.status(job.modelId, jobId);
      if (status?.status === 'IN_QUEUE' || status?.status === 'QUEUED') return {status: 'queued'};
      if (status?.status === 'IN_PROGRESS' || status?.status === 'RUNNING') return {status: 'running'};
      if (status?.status !== 'COMPLETED') {
        return {status: 'failed', error: status?.error || `Unexpected FAL job status: ${status?.status || 'unknown'}`};
      }
      const result = await fal.result(job.modelId, jobId);
      const image = result?.images?.[0];
      if (!image?.url) return {status: 'failed', error: 'FAL completed without returning a storyboard still image.'};
      return {
        status: 'completed',
        asset: {
          url: image.url,
          mimeType: image.content_type || image.mime_type || 'image/png',
          fileName: image.file_name || null,
          width: Number.isFinite(image.width) ? image.width : null,
          height: Number.isFinite(image.height) ? image.height : null,
        },
        seed: job.seed,
        prompt: job.prompt,
        characterVersionIds: (job.context.characters || []).map((character) => character.versionId).filter(Boolean),
        source: {provider: 'fal', modelId: job.modelId, jobId},
      };
    } catch (error) {
      return {status: 'failed', error: error instanceof Error ? error.message : String(error)};
    }
  };

  const generateScreenplay = async (input = {}) => {
    const context = input.context || {};
    const result = await fal.run(SCRIPT_ENDPOINT_ID, {
      model: scriptModelId,
      system_prompt: SCREENPLAY_SYSTEM_PROMPT,
      prompt: buildScreenplayPrompt(context),
      temperature: 0.7,
      max_tokens: 900,
    });
    return {
      text: plainText(result?.output),
      provider: 'fal',
      modelId: scriptModelId,
      usage: result?.usage && typeof result.usage === 'object' ? {...result.usage} : {},
    };
  };

  const generateVideoPrompt = async (input = {}) => {
    const context = input.context || {};
    const duration = normalizeSeedanceDuration(input.duration);
    const result = await fal.run(SCRIPT_ENDPOINT_ID, {
      model: scriptModelId,
      system_prompt: VIDEO_PROMPT_SYSTEM_PROMPT,
      prompt: buildVideoPromptPrompt(context, duration),
      temperature: 0.55,
      max_tokens: 1200,
    });
    return {
      text: normalizeTimedVideoPrompt(result?.output, duration),
      duration,
      provider: 'fal',
      modelId: scriptModelId,
      usage: result?.usage && typeof result.usage === 'object' ? {...result.usage} : {},
    };
  };

  return {
    configured: Boolean(fal.configured),
    stillModelId: STILL_MODEL_ID,
    stillEditModelId: STILL_EDIT_MODEL_ID,
    scriptModelId,
    submitStill,
    getStillJob,
    generateScreenplay,
    generateVideoPrompt,
  };
};
