import {normalizeTimelineGenerationInput} from '../src/timeline-generation.js';

const providerStatus = (value) => String(value?.status || value || '').toUpperCase();

const extractAsset = (result) => {
  const candidate = result?.video || result?.image || result?.audio || result?.images?.[0] || result?.files?.[0];
  if (!candidate?.url) throw new Error('FAL completed without a supported media result.');
  const mimeType = candidate.content_type || candidate.mime_type || candidate.mimeType
    || (result?.video ? 'video/mp4' : result?.audio ? 'audio/mpeg' : 'image/png');
  return {
    url: candidate.url,
    mimeType,
    fileName: candidate.file_name || candidate.fileName || null,
    width: candidate.width,
    height: candidate.height,
    duration: candidate.duration,
    size: candidate.file_size || candidate.size,
  };
};

export const createFalTimelineGenerationAdapter = ({fal}) => {
  if (!fal || typeof fal.submit !== 'function' || typeof fal.status !== 'function' || typeof fal.result !== 'function') {
    throw new TypeError('Timeline generation requires the queued FAL adapter.');
  }
  const jobs = new Map();

  return {
    async submitTimelineGeneration(input) {
      const normalized = normalizeTimelineGenerationInput(input);
      const payload = {...normalized.params, prompt: normalized.prompt};
      if (normalized.seed !== null) payload.seed = normalized.seed;
      const submitted = await fal.submit(normalized.modelId, payload);
      const jobId = submitted?.request_id || submitted?.requestId;
      if (!jobId) throw new Error('FAL did not return a timeline generation job id.');
      jobs.set(jobId, normalized);
      return {jobId};
    },

    async getTimelineGenerationJob(jobId) {
      const input = jobs.get(jobId);
      if (!input) return {status: 'failed', error: 'Timeline generation job was not found.'};
      try {
        const status = providerStatus(await fal.status(input.modelId, jobId));
        if (status === 'IN_QUEUE' || status === 'QUEUED') return {status: 'queued'};
        if (status === 'IN_PROGRESS' || status === 'RUNNING') return {status: 'running'};
        if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
          return {status: 'failed', error: `FAL timeline generation ${status.toLowerCase()}.`};
        }
        if (status !== 'COMPLETED') return {status: 'queued'};
        const result = await fal.result(input.modelId, jobId);
        return {
          status: 'completed',
          asset: extractAsset(result),
          modelId: input.modelId,
          seed: result?.seed ?? input.seed,
          params: input.params,
          cost: result?.cost || result?.usage?.cost || null,
          source: {provider: 'fal', jobId, modelId: input.modelId},
        };
      } catch (error) {
        return {status: 'failed', error: error instanceof Error ? error.message : String(error)};
      }
    },
  };
};
