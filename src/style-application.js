import {createGenerationUsageEntry} from './quality-tiers.js';

export const DEFAULT_STYLE_VIDEO_MODEL = 'fal-ai/kling-video/o3/standard/video-to-video/edit';
export const DEFAULT_STYLE_IMAGE_MODEL = 'fal-ai/nano-banana-2/edit';
export const DEFAULT_STYLE_TRIM_MODEL = 'fal-ai/workflow-utilities/trim-video';
export const STYLE_APPLICATION_CONCURRENCY = 3;
export const STYLE_APPLICATION_ACTIVE_STATUSES = new Set(['queued', 'uploading', 'trimming', 'generating']);

const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const text = (value) => typeof value === 'string' ? value.trim() : '';
const ids = (value) => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];
const safeId = (value) => text(value).replace(/[^a-zA-Z0-9_-]+/g, '-');
const isVisual = (kind) => kind === 'video' || kind === 'image';

export const defaultStyleInstruction = () =>
  'Match the selected style while preserving subjects, identities, composition, camera, motion, timing, and scene content.';

export const buildStyleApplicationPrompt = ({mediaKind, styleName, referenceCount, instruction}) => {
  const styleRefs = Array.from({length: Math.max(1, referenceCount)}, (_, index) =>
    `@Image${mediaKind === 'image' ? index + 2 : index + 1}`).join(', ');
  const source = mediaKind === 'image'
    ? `Edit @Image1. Use ${styleRefs} only as visual style references.`
    : `Restyle @Video1 using ${styleRefs} as visual style references.`;
  const preservation = text(instruction) || defaultStyleInstruction();
  return `${source} Apply the “${text(styleName) || 'selected'}” style: palette, texture, lighting, line quality, and rendering technique. ${preservation} Do not add cuts, subjects, text, logos, or unrelated objects.`;
};

const activeJobs = (project) => (project.styleApplications?.batches || [])
  .flatMap((batch) => batch.jobs || [])
  .filter((job) => STYLE_APPLICATION_ACTIVE_STATUSES.has(job.status));

export const styleApplicationEligibility = ({clip, asset, project}) => {
  if (!clip || !asset) return {eligible: false, reason: 'Source media is unavailable.'};
  if (!isVisual(asset.kind)) return {eligible: false, reason: 'Only video and image clips can be styled.'};
  if (!asset.url) return {eligible: false, reason: 'Re-import the source media before applying a style.'};
  if (asset.kind === 'video' && (clip.duration < 3 || clip.duration > 15)) {
    return {eligible: false, reason: 'Kling O3 Edit supports video clips from 3–15 seconds.'};
  }
  if (activeJobs(project).some((job) => job.clipId === clip.id)) {
    return {eligible: false, reason: 'An Apply Style job is already active for this clip.'};
  }
  const hasPendingProposal = (project.timelineDiffs?.items || []).some((diff) =>
    (diff.status === 'pending' || diff.status === 'stale')
    && (diff.operations || []).some((operation) => operation.clipId === clip.id));
  if (hasPendingProposal) return {eligible: false, reason: 'Resolve the existing proposal for this clip first.'};
  return {eligible: true, reason: ''};
};

export const createStyleApplicationBatch = ({
  project,
  clips,
  style,
  styleVersion,
  referenceAssetIds,
  instruction = defaultStyleInstruction(),
  preserveAudio = true,
  prices = {},
  createId = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
  now = () => new Date().toISOString(),
} = {}) => {
  if (!project || !style || !styleVersion) throw new Error('Apply Style requires a style version.');
  const selectedReferences = ids(referenceAssetIds).filter((assetId) => styleVersion.referenceAssetIds.includes(assetId)
    && project.mediaAssets.some((asset) => asset.id === assetId && asset.kind === 'image')).slice(0, 4);
  if (!selectedReferences.length) throw new Error('Choose at least one style reference image.');
  const createdAt = now();
  const jobs = [];
  for (const clip of Array.isArray(clips) ? clips : []) {
    const asset = project.mediaAssets.find((candidate) => candidate.id === clip.assetId);
    const eligibility = styleApplicationEligibility({clip, asset, project});
    if (!eligibility.eligible) continue;
    const unitPrice = asset.kind === 'video' ? prices.video : prices.image;
    const quantity = asset.kind === 'video' ? clip.duration : 1;
    jobs.push({
      id: createId('style-job'),
      clipId: clip.id,
      sourceAssetId: asset.id,
      sourceAssetName: asset.name,
      mediaKind: asset.kind,
      sourceClip: clone(clip),
      status: 'queued',
      stage: 'queued',
      providerModelId: null,
      providerRequestId: null,
      sourceUrl: null,
      preparedVideoUrl: null,
      outputAssetId: null,
      diffId: null,
      error: null,
      estimatedUsd: Number.isFinite(unitPrice) ? unitPrice * quantity : null,
      createdAt,
      updatedAt: createdAt,
    });
  }
  if (!jobs.length) throw new Error('None of the selected clips can use this style.');
  return {
    id: createId('style-batch'),
    styleId: style.id,
    styleName: style.name,
    styleVersionId: styleVersion.id,
    referenceAssetIds: selectedReferences,
    referenceUrls: [],
    instruction: text(instruction) || defaultStyleInstruction(),
    preserveAudio: preserveAudio !== false,
    baseRevision: project.timeline.revision,
    status: 'queued',
    jobs,
    createdAt,
    updatedAt: createdAt,
  };
};

const outputAsset = ({batch, job, output}) => {
  const candidate = output?.asset;
  if (!candidate?.url || !candidate.mimeType) throw new Error('Style generation completed without a playable asset.');
  const id = `style-asset-${safeId(job.id)}`;
  const kind = candidate.mimeType.startsWith('image/') ? 'image' : 'video';
  return {
    id,
    name: `Styled ${job.sourceAssetName} — ${batch.styleName}`,
    kind,
    mimeType: candidate.mimeType,
    size: Number.isFinite(candidate.size) ? candidate.size : 0,
    duration: kind === 'image' ? job.sourceClip.duration : (candidate.duration || job.sourceClip.duration),
    sceneId: job.sourceClip.sceneId || null,
    url: candidate.url,
    source: {type: 'generated', fileName: candidate.fileName || `${safeId(job.id)}.${kind === 'image' ? 'png' : 'mp4'}`, lastModified: 0},
    metadata: {
      width: candidate.width,
      height: candidate.height,
      provider: output.source?.provider || 'fal',
      providerJobId: job.providerRequestId,
      providerModelId: output.modelId || job.providerModelId,
      styleApplicationBatchId: batch.id,
    },
  };
};

export const landStyleApplicationResult = ({store, diffs, batch, job, output}) => {
  if (!store?.getProject || !store?.dispatch || !diffs?.createProposal) throw new TypeError('Landing a style result requires project and diff stores.');
  let project = store.getProject();
  const asset = outputAsset({batch, job, output});
  if (!project.mediaAssets.some((candidate) => candidate.id === asset.id)) {
    store.dispatch({type: 'asset/import', asset});
    project = store.getProject();
  }
  const currentClip = project.timeline.clips.find((clip) => clip.id === job.clipId) || null;
  let diffId = null;
  if (currentClip && currentClip.assetId === job.sourceClip.assetId) {
    const sourceProvenance = job.sourceClip.provenance || {};
    const parentAssetIds = ids([job.sourceAssetId, ...(sourceProvenance.parentAssetIds || [])]);
    const modelId = output.modelId || job.providerModelId;
    const provenance = {
      ...clone(sourceProvenance),
      prompt: buildStyleApplicationPrompt({
        mediaKind: job.mediaKind,
        styleName: batch.styleName,
        referenceCount: batch.referenceAssetIds.length,
        instruction: batch.instruction,
      }),
      modelId,
      seed: output.seed ?? null,
      params: {
        ...(sourceProvenance.params || {}),
        operation: 'apply-style',
        preserveAudio: batch.preserveAudio && !job.sourceClip.audioDetached,
        styleReferenceAssetIds: clone(batch.referenceAssetIds),
      },
      parentAssetId: job.sourceAssetId,
      parentAssetIds,
      characterVersionIds: ids(sourceProvenance.characterVersionIds),
      styleVersionIds: [batch.styleVersionId],
      derivedMetadata: {
        ...(sourceProvenance.derivedMetadata || {}),
        operation: 'apply-style',
        provider: output.source?.provider || 'fal',
        generationJobId: job.providerRequestId,
        styleApplicationBatchId: batch.id,
        styleId: batch.styleId,
        styleName: batch.styleName,
      },
      ...(Number.isFinite(job.estimatedUsd) ? {estimatedUsd: job.estimatedUsd} : {}),
    };
    const diff = {
      id: `style-diff-${safeId(job.id)}`,
      baseRevision: batch.baseRevision,
      source: 'style-application',
      summary: `Apply ${batch.styleName} to ${job.sourceAssetName}`,
      operations: [{
        type: 'replace',
        clipId: job.clipId,
        proposedClip: {
          ...clone(job.sourceClip),
          assetId: asset.id,
          sourceStart: 0,
          duration: job.sourceClip.duration,
          audioDetached: Boolean(job.sourceClip.audioDetached),
          provenance,
        },
      }],
      provenance,
    };
    const existing = project.timelineDiffs.items.find((candidate) => candidate.id === diff.id);
    diffId = existing?.id || diffs.createProposal(diff).affectedId;
  }
  const usage = createGenerationUsageEntry({
    job: {
      id: job.id,
      input: {
        modelId: output.modelId || job.providerModelId,
        unitPrice: Number.isFinite(job.estimatedUsd) ? job.estimatedUsd : undefined,
        costQuantity: 1,
        qualityTier: 'final',
      },
    },
    output,
  });
  if (usage) store.dispatch({type: 'usage/record', entry: usage});
  return {assetId: asset.id, diffId, changed: true};
};

export const createServerStyleApplicationAdapter = ({fetchImpl = globalThis.fetch} = {}) => {
  const requestJson = async (url, options = {}) => {
    const response = await fetchImpl(url, options);
    const body = await response.text();
    let data = {};
    try { data = body ? JSON.parse(body) : {}; } catch {}
    if (!response.ok) throw new Error(data.error || `Style application request failed (${response.status}).`);
    return data;
  };
  return {
    async uploadAsset(blob, {fileName = 'asset.bin', mimeType = blob?.type || 'application/octet-stream'} = {}) {
      return requestJson('/api/fal/upload', {
        method: 'POST',
        headers: {'Content-Type': mimeType, 'X-File-Name': encodeURIComponent(fileName)},
        body: blob,
      });
    },
    async submitStage(stage, input) {
      return requestJson('/api/style-applications/jobs', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({stage, input}),
      });
    },
    async getJob(modelId, requestId) {
      return requestJson(`/api/style-applications/jobs/${encodeURIComponent(requestId)}?modelId=${encodeURIComponent(modelId)}`);
    },
  };
};

export const createStyleApplicationController = ({
  store,
  diffs,
  adapter,
  resolveAssetUrl,
  persistAsset = async () => {},
  concurrency = STYLE_APPLICATION_CONCURRENCY,
} = {}) => {
  if (!store?.getProject || !store?.dispatch || !diffs || !adapter || typeof resolveAssetUrl !== 'function') {
    throw new TypeError('Style application controller dependencies are incomplete.');
  }
  const referencePromises = new Map();

  const patchJob = (batchId, jobId, patch) => store.dispatch({type: 'style-application/job-update', batchId, jobId, patch});
  const patchBatch = (batchId, patch) => store.dispatch({type: 'style-application/batch-update', batchId, patch});
  const batches = () => store.getProject().styleApplications?.batches || [];
  const findBatch = (batchId) => batches().find((batch) => batch.id === batchId) || null;

  const ensureReferenceUrls = async (batch) => {
    if (batch.referenceUrls?.length === batch.referenceAssetIds.length) return batch.referenceUrls;
    if (!referencePromises.has(batch.id)) {
      referencePromises.set(batch.id, (async () => {
        const project = store.getProject();
        const urls = [];
        for (const assetId of batch.referenceAssetIds) {
          const asset = project.mediaAssets.find((candidate) => candidate.id === assetId);
          if (!asset) throw new Error('A selected style reference is unavailable.');
          urls.push(await resolveAssetUrl(asset));
        }
        patchBatch(batch.id, {referenceUrls: urls});
        return urls;
      })().finally(() => referencePromises.delete(batch.id)));
    }
    return referencePromises.get(batch.id);
  };

  const fail = (batch, job, error) => patchJob(batch.id, job.id, {
    status: 'failed',
    stage: 'failed',
    error: error instanceof Error ? error.message : String(error),
  });

  const startQueued = async (batch, job) => {
    patchJob(batch.id, job.id, {status: 'uploading', stage: 'uploading', error: null});
    try {
      const project = store.getProject();
      const asset = project.mediaAssets.find((candidate) => candidate.id === job.sourceAssetId);
      if (!asset) throw new Error('The source media was removed before the job started.');
      const [sourceUrl, referenceUrls] = await Promise.all([
        resolveAssetUrl(asset),
        ensureReferenceUrls(findBatch(batch.id) || batch),
      ]);
      if (job.mediaKind === 'video') {
        const submitted = await adapter.submitStage('trim', {
          videoUrl: sourceUrl,
          startTime: job.sourceClip.sourceStart || 0,
          duration: job.sourceClip.duration,
        });
        patchJob(batch.id, job.id, {
          status: 'trimming',
          stage: 'trimming',
          sourceUrl,
          referenceUrls,
          providerModelId: submitted.modelId,
          providerRequestId: submitted.requestId,
        });
      } else {
        const prompt = buildStyleApplicationPrompt({mediaKind: 'image', styleName: batch.styleName, referenceCount: referenceUrls.length, instruction: batch.instruction});
        const submitted = await adapter.submitStage('image-style', {sourceImageUrl: sourceUrl, referenceImageUrls: referenceUrls, prompt});
        patchJob(batch.id, job.id, {
          status: 'generating',
          stage: 'image-style',
          sourceUrl,
          referenceUrls,
          providerModelId: submitted.modelId,
          providerRequestId: submitted.requestId,
        });
      }
    } catch (error) {
      fail(batch, job, error);
    }
  };

  const pollJob = async (batch, job) => {
    try {
      const result = await adapter.getJob(job.providerModelId, job.providerRequestId);
      if (result.status === 'queued' || result.status === 'running') return;
      if (result.status !== 'completed') throw new Error(result.error || 'Style application failed.');
      if (job.status === 'trimming') {
        const prompt = buildStyleApplicationPrompt({mediaKind: 'video', styleName: batch.styleName, referenceCount: job.referenceUrls.length, instruction: batch.instruction});
        const submitted = await adapter.submitStage('video-style', {
          videoUrl: result.asset.url,
          referenceImageUrls: job.referenceUrls,
          prompt,
          keepAudio: batch.preserveAudio && !job.sourceClip.audioDetached,
        });
        patchJob(batch.id, job.id, {
          status: 'generating',
          stage: 'video-style',
          preparedVideoUrl: result.asset.url,
          providerModelId: submitted.modelId,
          providerRequestId: submitted.requestId,
        });
        return;
      }
      const currentBatch = findBatch(batch.id) || batch;
      const currentJob = currentBatch.jobs.find((candidate) => candidate.id === job.id) || job;
      const landed = landStyleApplicationResult({store, diffs, batch: currentBatch, job: currentJob, output: result});
      await persistAsset(landed.assetId);
      patchJob(batch.id, job.id, {
        status: 'completed',
        stage: 'completed',
        outputAssetId: landed.assetId,
        diffId: landed.diffId,
        error: landed.diffId ? null : 'The source clip changed or was removed; the result was kept in Imports.',
      });
    } catch (error) {
      fail(batch, job, error);
    }
  };

  const tick = async () => {
    const snapshot = batches();
    const active = snapshot.flatMap((batch) => batch.jobs.map((job) => ({batch, job})))
      .filter(({job}) => job.status === 'trimming' || job.status === 'generating');
    await Promise.all(active.map(({batch, job}) => pollJob(batch, job)));

    const refreshed = batches();
    const activeCount = refreshed.flatMap((batch) => batch.jobs)
      .filter((job) => job.status === 'uploading' || job.status === 'trimming' || job.status === 'generating').length;
    const queued = refreshed.flatMap((batch) => batch.jobs.map((job) => ({batch, job})))
      .filter(({job}) => job.status === 'queued')
      .slice(0, Math.max(0, concurrency - activeCount));
    await Promise.all(queued.map(({batch, job}) => startQueued(batch, job)));
    return {hasWork: batches().some((batch) => batch.jobs.some((job) => STYLE_APPLICATION_ACTIVE_STATUSES.has(job.status)))};
  };

  return {
    createBatch(batch) { return store.dispatch({type: 'style-application/batch-create', batch}); },
    listBatches: () => clone(batches()),
    resume() {
      for (const batch of batches()) {
        for (const job of batch.jobs) {
          if (job.status === 'uploading') patchJob(batch.id, job.id, {status: 'queued', stage: 'queued'});
        }
      }
    },
    retry(batchId, jobId) {
      const batch = findBatch(batchId);
      const job = batch?.jobs.find((candidate) => candidate.id === jobId);
      if (!job || job.status !== 'failed') throw new Error('Only failed style jobs can be retried.');
      return patchJob(batchId, jobId, {
        status: 'queued', stage: 'queued', providerModelId: null, providerRequestId: null,
        preparedVideoUrl: null, outputAssetId: null, diffId: null, error: null,
      });
    },
    tick,
  };
};
