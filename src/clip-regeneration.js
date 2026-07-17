import {landGenerationResult, normalizeGenerationResult, normalizeTimelineGenerationInput} from './timeline-generation.js';
import {lockedStyleVersionIds} from './generation-request-builder.js';

const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const stringIds = (value) => [...new Set((Array.isArray(value) ? value : [])
  .filter((entry) => typeof entry === 'string' && entry.trim())
  .map((entry) => entry.trim()))];

const equalIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
const equalJson = (left, right) => JSON.stringify(left || {}) === JSON.stringify(right || {});

const defaultSeed = () => globalThis.crypto?.getRandomValues
  ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0]
  : Math.floor(Math.random() * 0xffffffff);

const changedFieldsFor = (clip, input) => {
  const original = clip.provenance || {};
  const changedFields = {};
  if (input.prompt !== original.prompt) changedFields.prompt = {from: original.prompt, to: input.prompt};
  if (input.modelId !== original.modelId) changedFields.modelId = {from: original.modelId, to: input.modelId};
  if (input.seed !== original.seed) changedFields.seed = {from: original.seed, to: input.seed};
  if (!equalJson(input.params, original.params)) changedFields.params = {from: clone(original.params || {}), to: clone(input.params)};
  if (input.qualityTier !== (original.qualityTier || 'draft')) changedFields.qualityTier = {from: original.qualityTier || 'draft', to: input.qualityTier};
  if (!equalJson(input.qualitySettings, original.qualitySettings || {})) {
    changedFields.qualitySettings = {from: clone(original.qualitySettings || {}), to: clone(input.qualitySettings)};
  }
  if (!equalIds(stringIds(input.styleVersionIds), stringIds(original.styleVersionIds))) {
    changedFields.styleVersionIds = {from: stringIds(original.styleVersionIds), to: stringIds(input.styleVersionIds)};
  }
  return changedFields;
};

export const createClipRegenerationService = ({store, diffs, adapter, createSeed = defaultSeed}) => {
  if (!store || typeof store.getProject !== 'function' || typeof store.dispatch !== 'function') {
    throw new TypeError('Clip regeneration requires a project store.');
  }
  if (!diffs || typeof diffs.createProposal !== 'function') throw new TypeError('Clip regeneration requires timeline diffs.');
  if (!adapter || typeof adapter.submitGeneration !== 'function' || typeof adapter.getGenerationJob !== 'function') {
    throw new TypeError('Clip regeneration requires a submit-and-poll adapter.');
  }
  const jobs = new Map();

  const sourceFor = (clipId) => {
    const project = store.getProject();
    const clip = project.timeline.clips.find((candidate) => candidate.id === clipId);
    if (!clip) throw new Error('The accepted source clip was not found.');
    if (!clip.provenance?.prompt || !clip.provenance?.modelId) {
      throw new Error('Only generated clips with prompt and model provenance can be regenerated.');
    }
    return {project, clip};
  };

  const deriveInput = (clip, overrides = {}) => {
    const project = store.getProject();
    const characterVersionIds = stringIds(clip.provenance.characterVersionIds);
    const persistedStyleVersionIds = stringIds(clip.provenance.styleVersionIds);
    const styleVersionIds = persistedStyleVersionIds.length
      ? persistedStyleVersionIds
      : lockedStyleVersionIds(project);
    if (Array.isArray(overrides.styleVersionIds) && !equalIds(styleVersionIds, stringIds(overrides.styleVersionIds))) {
      throw new Error('A locked style version cannot be replaced during regeneration.');
    }
    if (Array.isArray(overrides.characterVersionIds)
      && !equalIds(characterVersionIds, stringIds(overrides.characterVersionIds))) {
      throw new Error('A locked character version cannot be replaced during regeneration.');
    }
    return normalizeTimelineGenerationInput({
      operation: 'replace',
      sourceClipId: clip.id,
      prompt: overrides.prompt ?? clip.provenance.prompt,
      modelId: overrides.modelId ?? clip.provenance.modelId,
      seed: overrides.seed === undefined ? clip.provenance.seed : overrides.seed,
      params: overrides.params ?? clip.provenance.params,
      qualityTier: overrides.qualityTier ?? clip.provenance.qualityTier,
      qualitySettings: overrides.qualitySettings ?? clip.provenance.qualitySettings,
      characterVersionIds,
      styleVersionIds,
      parentAssetIds: [clip.assetId, ...(clip.provenance.parentAssetIds || [])],
      sceneId: clip.sceneId,
      trackId: clip.trackId,
      start: clip.start,
      duration: clip.duration,
    });
  };

  const regenerateClip = async ({clipId, ...overrides}) => {
    const {project, clip} = sourceFor(clipId);
    const input = deriveInput(clip, overrides);
    const {jobId} = await adapter.submitGeneration(input);
    if (typeof jobId !== 'string' || !jobId.trim()) throw new Error('Generation adapter returned no job id.');
    const job = {
      jobId: jobId.trim(),
      clipId,
      baseRevision: project.timeline.revision,
      sourceClip: clone(clip),
      input,
      changedFields: changedFieldsFor(clip, input),
      status: 'queued',
      error: null,
      output: null,
      normalized: null,
      used: false,
    };
    jobs.set(job.jobId, job);
    return {jobId: job.jobId};
  };

  const rerollSeed = (clipId) => regenerateClip({clipId, seed: createSeed()});
  const changeModel = (clipId, modelId) => regenerateClip({clipId, modelId});

  const compareVariants = async (clipId, {count = 2, modelIds = []} = {}) => {
    const variantCount = Math.max(2, count);
    const submitted = [];
    for (let index = 0; index < variantCount; index += 1) {
      submitted.push(await regenerateClip({
        clipId,
        seed: createSeed(),
        ...(modelIds[index] ? {modelId: modelIds[index]} : {}),
      }));
    }
    return submitted;
  };

  const poll = async (jobId) => {
    const job = jobs.get(jobId);
    if (!job) throw new Error('Regeneration job was not found.');
    if (job.status === 'completed' || job.status === 'failed') return clone(job);
    const result = await adapter.getGenerationJob(jobId);
    if (result.status === 'queued' || result.status === 'running') {
      job.status = result.status;
    } else if (result.status === 'completed') {
      job.status = 'completed';
      job.output = clone(result);
      job.normalized = normalizeGenerationResult({
        job: {
          jobId: job.jobId,
          input: job.input,
          baseRevision: job.baseRevision,
          changedFields: job.changedFields,
        },
        output: result,
        sourceClip: job.sourceClip,
        project: store.getProject(),
      });
    } else {
      job.status = 'failed';
      job.error = result.error || 'Clip regeneration failed.';
    }
    return clone(job);
  };

  const listJobs = (clipId = null) => [...jobs.values()]
    .filter((job) => !clipId || job.clipId === clipId)
    .map(clone);

  const listCandidates = (clipId) => listJobs(clipId).filter((job) => job.status === 'completed');

  const useCandidate = (jobId) => {
    const job = jobs.get(jobId);
    if (!job || job.status !== 'completed' || !job.output) throw new Error('Only completed variants can be selected.');
    const landed = landGenerationResult({
      store,
      diffs,
      job: {
        jobId: job.jobId,
        input: job.input,
        baseRevision: job.baseRevision,
        changedFields: job.changedFields,
      },
      output: job.output,
      sourceClip: job.sourceClip,
    });
    job.used = true;
    return landed;
  };

  return {regenerateClip, rerollSeed, changeModel, compareVariants, poll, listJobs, listCandidates, useCandidate};
};
