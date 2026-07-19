import {
  createFakeTimedVideoPrompt,
  normalizeSeedanceDuration,
} from './beat-video.js';

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};

// Deterministic seed for a beat's first still so every beat of a project is
// sampled from one anchor; regeneration passes no seed and stays random.
export const stableStillSeed = (...parts) => {
  let hash = 5381;
  for (const character of parts.join('|')) {
    hash = ((hash * 33) ^ character.codePointAt(0)) >>> 0;
  }
  return hash % 2_147_483_647;
};

const fakeStillUrl = (text) => {
  const safe = String(text || 'Storyboard beat').replace(/[<>&]/g, '').slice(0, 110);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#293f72"/><stop offset="1" stop-color="#8b5275"/></linearGradient></defs><rect width="1280" height="720" fill="url(#g)"/><circle cx="970" cy="175" r="118" fill="#f1c982" opacity=".82"/><path d="M0 560 Q310 430 620 565 T1280 510 V720 H0Z" fill="#16253f" opacity=".8"/><text x="64" y="92" fill="white" font-family="sans-serif" font-size="30" font-weight="700">LOCAL STORYBOARD STILL</text><text x="64" y="650" fill="white" font-family="sans-serif" font-size="25">${safe}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

export const createFakeStoryboardGenerationAdapter = ({
  createId = (() => { let id = 0; return () => `fake-storyboard-job-${++id}`; })(),
} = {}) => {
  const jobs = new Map();
  return {
    kind: 'fake',

    async submitStill({context} = {}) {
      if (!context?.target?.text) throw new Error('Storyboard still generation requires a target beat.');
      const jobId = createId();
      jobs.set(jobId, {context, polls: 0});
      return {jobId};
    },

    async getStillJob(jobId) {
      const job = jobs.get(jobId);
      if (!job) return {status: 'failed', error: 'The local storyboard job was not found.'};
      job.polls += 1;
      if (job.polls === 1) return {status: 'running'};
      if (/\[fail\]/i.test(job.context.target.text)) {
        return {status: 'failed', error: 'Deterministic local storyboard failure. Remove [fail] and retry.'};
      }
      return {
        status: 'completed',
        asset: {
          url: fakeStillUrl(job.context.target.text),
          mimeType: 'image/svg+xml',
          fileName: 'local-storyboard-still.svg',
          width: 1280,
          height: 720,
        },
        seed: 1,
        prompt: job.context.target.text,
        characterVersionIds: (job.context.characters || []).map((character) => character.versionId).filter(Boolean),
        source: {provider: 'local-fake', modelId: 'local/fake-nano-banana-2', jobId},
      };
    },

    async generateScreenplay({context} = {}) {
      if (!context?.target?.text) throw new Error('Screenplay generation requires a target beat.');
      if (/\[fail\]/i.test(context.target.text)) throw new Error('Deterministic local screenplay failure.');
      return {
        text: `EXT. HARBOR — DAWN\n\n${context.target.text}`,
        provider: 'local-fake',
        modelId: 'local/fake-gemini-screenplay-v1',
        usage: {cost: 0},
      };
    },

    async generateVideoPrompt({context, duration} = {}) {
      if (!context?.target?.text) throw new Error('Video prompt generation requires a target beat.');
      if (/\[fail\]/i.test(context.target.text)) throw new Error('Deterministic local video prompt failure.');
      const normalizedDuration = normalizeSeedanceDuration(duration);
      return {
        text: createFakeTimedVideoPrompt({context, duration: normalizedDuration}),
        duration: normalizedDuration,
        provider: 'local-fake',
        modelId: 'local/fake-gemini-video-prompt-v1',
        usage: {cost: 0},
      };
    },
  };
};

export const createServerStoryboardGenerationAdapter = ({
  fetchImpl = globalThis.fetch,
  resolveReferenceUrl = () => null,
  toUploadableUrl = async (url) => url,
} = {}) => {
  const requestJson = async (url, options = {}) => {
    const response = await fetchImpl(url, options);
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!response.ok) throw new Error(data.error || `Storyboard generation request failed (${response.status}).`);
    return data;
  };

  return {
    kind: 'fal',

    async submitStill({
      context,
      referenceAssetIds = [],
      styleReferenceAssetIds = [],
      previousStillAssetId = null,
      seed = null,
    } = {}) {
      if (!context?.target?.text) throw new Error('Storyboard still generation requires a target beat.');
      const resolveAll = async (assetIds) => {
        const resolved = await Promise.all([...new Set(assetIds)]
          .map((assetId) => resolveReferenceUrl(assetId))
          .map((url) => Promise.resolve(toUploadableUrl(url)).catch(() => null)));
        return resolved.filter((url) => typeof url === 'string' && /^(https:\/\/|data:image\/)/i.test(url));
      };
      const [referenceUrls, styleReferenceUrls, previousStillUrls] = await Promise.all([
        resolveAll(referenceAssetIds),
        resolveAll(styleReferenceAssetIds),
        resolveAll(previousStillAssetId ? [previousStillAssetId] : []),
      ]);
      return requestJson('/api/storyboard/stills', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          context,
          referenceUrls,
          styleReferenceUrls,
          previousStillUrl: previousStillUrls[0] || null,
          seed: Number.isInteger(seed) && seed >= 0 ? seed : null,
        }),
      });
    },

    async getStillJob(jobId) {
      return requestJson(`/api/storyboard/stills/${encodeURIComponent(requiredText(jobId, 'Storyboard still job id'))}`);
    },

    async generateScreenplay({context} = {}) {
      if (!context?.target?.text) throw new Error('Screenplay generation requires a target beat.');
      return requestJson('/api/storyboard/scripts/generate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({context}),
      });
    },

    async generateVideoPrompt({context, duration} = {}) {
      if (!context?.target?.text) throw new Error('Video prompt generation requires a target beat.');
      return requestJson('/api/storyboard/video-prompts/generate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({context, duration: normalizeSeedanceDuration(duration)}),
      });
    },
  };
};
