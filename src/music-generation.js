import {normalizeCueSheet, quantizeSectionsToBars} from './score-direction.js';

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};

const bytesToBase64 = (bytes) => {
  if (globalThis.Buffer) return globalThis.Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
};

// A tiny playable 8-bit mono WAV so fake score jobs land a real audio asset.
export const silentWavDataUrl = (durationMs = 1000, sampleRate = 8000) => {
  const sampleCount = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const bytes = new Uint8Array(44 + sampleCount);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, text) => { for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index); };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + sampleCount, true);
  writeAscii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeAscii(36, 'data');
  view.setUint32(40, sampleCount, true);
  bytes.fill(0x80, 44);
  return `data:audio/wav;base64,${bytesToBase64(bytes)}`;
};

// Deterministic local cue sheet: one section per act (or the whole score),
// with the climax hit at the start of the final section.
const fakeCueSheet = (context) => {
  const durationMs = context.durationMs;
  const acts = (context.acts || []).filter((act) => act.sceneId);
  const sceneStarts = new Map();
  for (const segment of context.segments || []) {
    if (segment.sceneId && !sceneStarts.has(segment.sceneId)) sceneStarts.set(segment.sceneId, segment.startMs);
  }
  const sections = acts
    .filter((act) => sceneStarts.has(act.sceneId))
    .map((act) => ({
      name: act.title,
      startMs: sceneStarts.get(act.sceneId),
      intensity: Math.min(10, 2 + act.actNumber * 2),
      description: act.summary || act.title,
      transition: act.actNumber === act.actCount ? 'decay' : 'swell',
    }));
  const lastStart = sections.length > 1 ? sections[sections.length - 1].startMs : Math.round(durationMs * 0.75);
  return quantizeSectionsToBars(normalizeCueSheet({
    global: {
      genre: 'cinematic instrumental underscore',
      bpm: 96,
      key: 'D minor',
      instrumentation: ['felt piano', 'analog pads', 'strings'],
      moodArc: 'quiet curiosity rising to a resolved finish',
    },
    sections,
    hitPoints: [{timeMs: Math.min(durationMs, Math.max(1, lastStart)), kind: 'climax', treatment: 'full ensemble hit'}],
  }, {durationMs}));
};

export const createFakeMusicGenerationAdapter = ({
  createId = (() => { let id = 0; return () => `fake-score-job-${++id}`; })(),
} = {}) => {
  const jobs = new Map();
  return {
    kind: 'fake',

    async generateScoreDirection({context} = {}) {
      if (!Array.isArray(context?.segments) || !context.segments.length) {
        throw new Error('Score direction requires timeline segments.');
      }
      if (/\[fail\]/i.test(context.theme || '')) {
        throw new Error('Deterministic local score-direction failure. Remove [fail] and retry.');
      }
      return {
        cueSheet: fakeCueSheet(context),
        provider: 'local-fake',
        modelId: 'local/fake-score-direction-v1',
        usage: {cost: 0},
      };
    },

    async submitScore({cueSheet, durationMs} = {}) {
      const normalized = normalizeCueSheet(cueSheet, {durationMs: durationMs || cueSheet?.durationMs});
      const jobId = createId();
      jobs.set(jobId, {cueSheet: normalized, polls: 0});
      return {jobId, modelId: 'local/fake-elevenlabs-music'};
    },

    async getScoreJob(jobId) {
      const job = jobs.get(jobId);
      if (!job) return {status: 'failed', error: 'The local score job was not found.'};
      job.polls += 1;
      if (job.polls === 1) return {status: 'running'};
      return {
        status: 'completed',
        asset: {
          url: silentWavDataUrl(Math.min(job.cueSheet.durationMs, 2000)),
          mimeType: 'audio/wav',
          fileName: 'local-background-score.wav',
        },
        cueSheet: job.cueSheet,
        source: {provider: 'local-fake', modelId: 'local/fake-elevenlabs-music', jobId},
      };
    },
  };
};

export const createServerMusicGenerationAdapter = ({fetchImpl = globalThis.fetch} = {}) => {
  const requestJson = async (url, options = {}) => {
    const response = await fetchImpl(url, options);
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) throw new Error(data.error || `Score generation request failed (${response.status}).`);
    return data;
  };

  return {
    kind: 'fal',

    async generateScoreDirection({context} = {}) {
      if (!Array.isArray(context?.segments) || !context.segments.length) {
        throw new Error('Score direction requires timeline segments.');
      }
      return requestJson('/api/music/score-direction', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({context}),
      });
    },

    async submitScore({cueSheet, durationMs, modelId = null, videoUrl = null} = {}) {
      return requestJson('/api/music/generate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({cueSheet, durationMs, modelId, videoUrl}),
      });
    },

    async getScoreJob(jobId) {
      return requestJson(`/api/music/jobs/${encodeURIComponent(requiredText(jobId, 'Score job id'))}`);
    },
  };
};
