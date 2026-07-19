import {
  DEFAULT_STYLE_IMAGE_MODEL,
  DEFAULT_STYLE_TRIM_MODEL,
  DEFAULT_STYLE_VIDEO_MODEL,
} from '../src/style-application.js';
import {resolveFalResultCost} from './fal-adapter.mjs';

const providerStatus = (value) => String(value?.status || value || '').toUpperCase();
const httpsUrl = (value, field) => {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value)) throw new Error(`${field} must be an HTTPS URL.`);
  return value;
};
const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};
const imageUrls = (value) => [...new Set((Array.isArray(value) ? value : []).map((url) => httpsUrl(url, 'Style reference URL')))].slice(0, 4);

const extractAsset = (result) => {
  const candidate = result?.video || result?.image || result?.images?.[0] || result?.files?.[0];
  if (!candidate?.url) throw new Error('fal completed without a supported media result.');
  return {
    url: candidate.url,
    mimeType: candidate.content_type || candidate.mime_type || candidate.mimeType
      || (result?.video ? 'video/mp4' : 'image/png'),
    fileName: candidate.file_name || candidate.fileName || null,
    size: candidate.file_size || candidate.size,
    width: candidate.width,
    height: candidate.height,
    duration: candidate.duration || result?.trimmed_duration,
  };
};

export const createFalStyleApplicationAdapter = ({
  fal,
  videoModelId = process.env.PRISMFLOW_STYLE_VIDEO_MODEL || DEFAULT_STYLE_VIDEO_MODEL,
  imageModelId = process.env.PRISMFLOW_STYLE_IMAGE_MODEL || DEFAULT_STYLE_IMAGE_MODEL,
  trimModelId = process.env.PRISMFLOW_STYLE_TRIM_MODEL || DEFAULT_STYLE_TRIM_MODEL,
} = {}) => {
  if (!fal?.submit || !fal?.status || !fal?.result) throw new TypeError('Style application requires the queued fal adapter.');
  const allowedModels = new Set([videoModelId, imageModelId, trimModelId]);

  const submitStyleJob = async ({stage, input = {}} = {}) => {
    let modelId;
    let payload;
    if (stage === 'trim') {
      modelId = trimModelId;
      const duration = Number(input.duration);
      const startTime = Number(input.startTime || 0);
      if (!Number.isFinite(duration) || duration < 3 || duration > 15) throw new Error('Trim duration must be from 3–15 seconds.');
      if (!Number.isFinite(startTime) || startTime < 0) throw new Error('Trim start time must be non-negative.');
      payload = {video_url: httpsUrl(input.videoUrl, 'Video URL'), start_time: startTime, duration};
    } else if (stage === 'video-style') {
      modelId = videoModelId;
      const references = imageUrls(input.referenceImageUrls);
      if (!references.length) throw new Error('Video styling requires at least one reference image.');
      payload = {
        prompt: requiredText(input.prompt, 'Style prompt'),
        video_url: httpsUrl(input.videoUrl, 'Video URL'),
        image_urls: references,
        keep_audio: input.keepAudio !== false,
        shot_type: 'customize',
      };
    } else if (stage === 'image-style') {
      modelId = imageModelId;
      const references = imageUrls(input.referenceImageUrls);
      if (!references.length) throw new Error('Image styling requires at least one reference image.');
      payload = {
        prompt: requiredText(input.prompt, 'Style prompt'),
        image_urls: [httpsUrl(input.sourceImageUrl, 'Source image URL'), ...references],
        num_images: 1,
        aspect_ratio: 'auto',
        output_format: 'png',
        resolution: '1K',
        limit_generations: true,
      };
    } else {
      throw new Error(`Unknown style application stage: ${String(stage)}`);
    }
    const result = await fal.submit(modelId, payload);
    const requestId = result?.request_id || result?.requestId;
    if (!requestId) throw new Error('fal did not return a style application request id.');
    return {requestId, modelId};
  };

  const getStyleJob = async ({modelId, requestId}) => {
    if (!allowedModels.has(modelId)) throw new Error('Style application model is not allowed.');
    try {
      const status = providerStatus(await fal.status(modelId, requestId));
      if (status === 'IN_QUEUE' || status === 'QUEUED') return {status: 'queued'};
      if (status === 'IN_PROGRESS' || status === 'RUNNING') return {status: 'running'};
      if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
        return {status: 'failed', error: `fal style application ${status.toLowerCase()}.`};
      }
      if (status !== 'COMPLETED') return {status: 'queued'};
      const result = await fal.result(modelId, requestId);
      const cost = await resolveFalResultCost({fal, modelId, result});
      return {
        status: 'completed',
        asset: extractAsset(result),
        modelId,
        seed: result?.seed ?? null,
        ...(cost ? {cost} : {}),
        source: {provider: 'fal', requestId, modelId},
      };
    } catch (error) {
      return {status: 'failed', error: error instanceof Error ? error.message : String(error)};
    }
  };

  return {videoModelId, imageModelId, trimModelId, submitStyleJob, getStyleJob};
};
