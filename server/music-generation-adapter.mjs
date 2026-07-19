import {
  buildElevenLabsMusicInput,
  buildSingleMusicPrompt,
  normalizeCueSheet,
  quantizeSectionsToBars,
} from '../src/score-direction.js';
import {resolveFalResultCost} from './fal-adapter.mjs';

export const DEFAULT_MUSIC_MODEL_ID = 'fal-ai/elevenlabs/music';
export const VIDEO_MUSIC_MODEL_ID = 'sonilo/v1.1/video-to-music';
const SCRIPT_ENDPOINT_ID = 'openrouter/router';

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};

const formatMs = (ms) => {
  const totalSeconds = Math.max(0, Math.round(ms / 100) / 10);
  const minutes = Math.floor(totalSeconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(Math.round((totalSeconds - minutes * 60) * 10) / 10).padStart(4, '0')}`;
};

const SCORE_DIRECTION_SYSTEM_PROMPT = [
  'You are a film composer\'s assistant writing a machine-readable cue sheet directing one continuous background score for a video.',
  'Return exactly one JSON object and nothing else — no Markdown, code fences, comments, or prose.',
  'Schema: {"global":{"genre":string,"bpm":integer,"key":string,"instrumentation":[string],"moodArc":string},',
  '"sections":[{"name":string,"startMs":integer,"intensity":integer,"description":string,"transition":"cut"|"swell"|"drop"|"decay"|"sustain"}],',
  '"hitPoints":[{"timeMs":integer,"kind":"reveal"|"climax"|"turn"|"resolution","treatment":string}]}.',
  'Sections are contiguous: each startMs is where the previous section ends, the first startMs is 0, and every section must run between 3 and 120 seconds.',
  'The score is purely instrumental underscore that sits beneath dialogue; never write vocals, singing, or lyrics into any description.',
  'Pick one bpm between 50 and 200 for the whole score such that the most important hitPoints fall close to 4/4 bar lines (one bar = 240000/bpm milliseconds), then place section boundaries on those same moments.',
  'Derive each hitPoint from the narrative: reveals and turns get accents, the climax gets the biggest musical event, the resolution releases tension.',
  'Set intensity 1-10 from narrative position: establishing scenes low, rising action climbing, the climax highest, the resolution falling.',
].join(' ');

const actLines = (context) => (context.acts || []).map((act) => [
  `Act ${act.actNumber}/${act.actCount}: ${act.title}${act.summary ? ` — ${act.summary}` : ''}`,
  ...(act.beats || []).map((beat) => `  Beat: ${beat.text}${beat.screenplay ? `\n    Screenplay: ${beat.screenplay}` : ''}`),
].join('\n')).join('\n');

const segmentLines = (context) => (context.segments || []).map((segment) => [
  `[${formatMs(segment.startMs)}–${formatMs(segment.endMs)}] ${segment.label}`,
  segment.prompt ? `  Shot prompt: ${segment.prompt}` : '',
  segment.annotation ? `  Frame analysis: ${segment.annotation}` : '',
].filter(Boolean).join('\n')).join('\n');

const buildScoreDirectionPrompt = (context) => [
  `Project: ${context.project?.name || 'Untitled project'}`,
  context.theme ? `Overall theme: ${context.theme}` : '',
  context.narrative?.title ? `Narrative structure: ${context.narrative.title}. ${context.narrative.tagline || ''}` : '',
  (context.acts || []).length ? `Narrative acts and beats:\n${actLines(context)}` : '',
  `Timeline segments (video clips in playback order, with what is on screen):\n${segmentLines(context)}`,
  `Total score duration: exactly ${context.durationMs} milliseconds (${formatMs(context.durationMs)}). Sections must cover this full range.`,
  'Write the cue sheet JSON for this video now.',
].filter(Boolean).join('\n\n');

const parseCueSheetText = (output) => {
  const text = requiredText(output, 'Score direction response')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Score direction did not return a JSON cue sheet.');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('Score direction returned unparseable cue sheet JSON.');
  }
};

export const createFalMusicGenerationAdapter = ({
  fal,
  musicModelId = process.env.PRISMFLOW_MUSIC_MODEL || DEFAULT_MUSIC_MODEL_ID,
  scoreDirectionModelId = process.env.PRISMFLOW_SCORE_DIRECTION_MODEL || 'google/gemini-2.5-flash',
} = {}) => {
  if (!fal?.submit || !fal?.status || !fal?.result || !fal?.run) {
    throw new TypeError('Music generation requires FAL run and queue operations.');
  }
  const jobs = new Map();

  const generateScoreDirection = async (input = {}) => {
    const context = input.context || {};
    if (!Array.isArray(context.segments) || !context.segments.length) {
      throw new Error('Score direction requires timeline segments.');
    }
    const result = await fal.run(SCRIPT_ENDPOINT_ID, {
      model: scoreDirectionModelId,
      system_prompt: SCORE_DIRECTION_SYSTEM_PROMPT,
      prompt: buildScoreDirectionPrompt(context),
      temperature: 0.4,
      max_tokens: 2200,
    });
    const cueSheet = quantizeSectionsToBars(
      normalizeCueSheet(parseCueSheetText(result?.output), {durationMs: context.durationMs}));
    return {
      cueSheet,
      provider: 'fal',
      modelId: scoreDirectionModelId,
      usage: result?.usage && typeof result.usage === 'object' ? {...result.usage} : {},
    };
  };

  const submitScore = async (input = {}) => {
    const modelId = typeof input.modelId === 'string' && input.modelId.trim() ? input.modelId.trim() : musicModelId;
    let payload;
    if (modelId === VIDEO_MUSIC_MODEL_ID) {
      const videoUrl = requiredText(input.videoUrl, 'videoUrl');
      const cueSheet = input.cueSheet
        ? normalizeCueSheet(input.cueSheet, {durationMs: input.durationMs || input.cueSheet.durationMs})
        : null;
      payload = {video_url: videoUrl, ...(cueSheet ? {prompt: buildSingleMusicPrompt(cueSheet)} : {})};
    } else {
      const cueSheet = normalizeCueSheet(input.cueSheet, {durationMs: input.durationMs || input.cueSheet?.durationMs});
      payload = modelId === DEFAULT_MUSIC_MODEL_ID
        ? buildElevenLabsMusicInput(cueSheet)
        : {prompt: buildSingleMusicPrompt(cueSheet)};
    }
    const submitted = await fal.submit(modelId, payload);
    const jobId = requiredText(submitted?.request_id || submitted?.requestId, 'FAL request id');
    jobs.set(jobId, {modelId, cueSheet: input.cueSheet || null});
    return {jobId, modelId};
  };

  const getScoreJob = async (jobId) => {
    const job = jobs.get(jobId);
    if (!job) return {status: 'failed', error: 'Score generation job was not found.'};
    try {
      const status = await fal.status(job.modelId, jobId);
      if (status?.status === 'IN_QUEUE' || status?.status === 'QUEUED') return {status: 'queued'};
      if (status?.status === 'IN_PROGRESS' || status?.status === 'RUNNING') return {status: 'running'};
      if (status?.status !== 'COMPLETED') {
        return {status: 'failed', error: status?.error || `Unexpected FAL job status: ${status?.status || 'unknown'}`};
      }
      const result = await fal.result(job.modelId, jobId);
      const audio = result?.audio || result?.audio_file || (Array.isArray(result?.audios) ? result.audios[0] : null);
      if (!audio?.url) return {status: 'failed', error: 'FAL completed without returning a score audio file.'};
      const cost = await resolveFalResultCost({fal, modelId: job.modelId, result});
      return {
        status: 'completed',
        asset: {
          url: audio.url,
          mimeType: audio.content_type || audio.mime_type || 'audio/mpeg',
          fileName: audio.file_name || null,
        },
        cueSheet: job.cueSheet,
        ...(cost ? {cost} : {}),
        source: {provider: 'fal', modelId: job.modelId, jobId},
      };
    } catch (error) {
      return {status: 'failed', error: error instanceof Error ? error.message : String(error)};
    }
  };

  return {
    configured: Boolean(fal.configured),
    musicModelId,
    scoreDirectionModelId,
    generateScoreDirection,
    submitScore,
    getScoreJob,
  };
};
