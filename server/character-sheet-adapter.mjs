import {resolveFalResultCost} from './fal-adapter.mjs';

export const NANO_BANANA_2_MODEL_ID = 'fal-ai/nano-banana-2';
export const NANO_BANANA_2_EDIT_MODEL_ID = 'fal-ai/nano-banana-2/edit';

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};

const normalizeUrls = (value) => [...new Set((Array.isArray(value) ? value : [])
  .filter((url) => typeof url === 'string' && /^(https:\/\/|data:image\/)/i.test(url))
  .map((url) => url.trim()))];

const errorMessage = (error) => error instanceof Error ? error.message : String(error);

export const buildNanoBananaCharacterRequest = (input, seed) => {
  const kind = input?.kind === 'scene-still' ? 'scene-still' : 'character-sheet';
  const name = requiredText(input?.name, kind === 'scene-still' ? 'Scene name' : 'Character name');
  const visualPrompt = requiredText(input?.prompt, 'Visual prompt');
  const styleNotes = typeof input?.styleNotes === 'string' ? input.styleNotes.trim() : '';
  const referenceUrls = normalizeUrls(input?.referenceUrls);
  const prompt = (kind === 'scene-still'
    ? [
      'Create one cinematic scene still frame.',
      `Scene: ${name}.`,
      `Visual brief: ${visualPrompt}.`,
      styleNotes ? `Style direction: ${styleNotes}.` : '',
      referenceUrls.length ? 'Keep the referenced characters\' identities and designs consistent with the supplied reference sheets.' : '',
      'Compose a single film frame — no contact sheets, panels, or presentation mockups.',
    ]
    : [
      'Create one polished character reference sheet for consistent future visual generation.',
      `Character name: ${name}.`,
      `Visual brief: ${visualPrompt}.`,
      styleNotes ? `Style direction: ${styleNotes}.` : '',
      'Show the same identity in multiple useful views and expressions on a clean, unified contact sheet.',
      'Do not add unrelated characters or presentation mockups.',
    ]).filter(Boolean).join(' ');
  const modelId = referenceUrls.length ? NANO_BANANA_2_EDIT_MODEL_ID : NANO_BANANA_2_MODEL_ID;
  const aspectRatio = kind === 'scene-still' ? '16:9' : '4:3';
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
    ...(referenceUrls.length ? {image_urls: referenceUrls} : {}),
  };
  return {
    modelId,
    payload,
    provenance: {
      modelId,
      seed,
      params: {
        kind,
        styleNotes,
        numImages: 1,
        aspectRatio,
        outputFormat: 'png',
        safetyTolerance: '4',
        resolution: '1K',
        referenceCount: referenceUrls.length,
      },
    },
  };
};

export const createFalCharacterSheetAdapter = ({
  fal,
  createSeed = () => Math.floor(Math.random() * 2_147_483_647),
} = {}) => {
  if (!fal || typeof fal.submit !== 'function' || typeof fal.status !== 'function' || typeof fal.result !== 'function') {
    throw new TypeError('FAL character adapter requires queue submit, status, and result methods.');
  }
  const jobs = new Map();

  return {
    configured: Boolean(fal.configured),
    modelId: NANO_BANANA_2_MODEL_ID,

    async submitCharacterSheet(input) {
      const request = buildNanoBananaCharacterRequest(input, createSeed());
      const submitted = await fal.submit(request.modelId, request.payload);
      const jobId = requiredText(submitted?.request_id, 'FAL request id');
      jobs.set(jobId, request.provenance);
      return {jobId};
    },

    async getCharacterSheetJob(jobId) {
      const provenance = jobs.get(jobId);
      if (!provenance) return {status: 'failed', error: 'Character generation job was not found on this server.'};
      try {
        const status = await fal.status(provenance.modelId, jobId);
        if (status?.status === 'IN_QUEUE') return {status: 'queued'};
        if (status?.status === 'IN_PROGRESS') return {status: 'running'};
        if (status?.status !== 'COMPLETED') {
          return {status: 'failed', error: status?.error || `Unexpected FAL job status: ${status?.status || 'unknown'}`};
        }
        if (status.error) return {status: 'failed', error: errorMessage(status.error)};

        const result = await fal.result(provenance.modelId, jobId);
        const image = result?.images?.[0];
        if (!image?.url) return {status: 'failed', error: 'FAL completed without returning a character sheet image.'};
        const cost = await resolveFalResultCost({fal, modelId: provenance.modelId, result});
        return {
          status: 'completed',
          asset: {
            url: image.url,
            mimeType: image.content_type || 'image/png',
            width: Number.isFinite(image.width) ? image.width : null,
            height: Number.isFinite(image.height) ? image.height : null,
          },
          modelId: provenance.modelId,
          ...(cost ? {cost} : {}),
          seed: provenance.seed,
          params: provenance.params,
          source: {
            provider: 'fal',
            jobId,
            modelId: provenance.modelId,
            fileName: image.file_name || null,
            description: typeof result.description === 'string' ? result.description : '',
          },
        };
      } catch (error) {
        return {status: 'failed', error: errorMessage(error)};
      }
    },
  };
};
