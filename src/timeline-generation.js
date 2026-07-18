const ACTIVE_JOB_STATES = new Set(['queued', 'running', 'retrying']);

const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};

const stringIds = (value) => [...new Set((Array.isArray(value) ? value : [])
  .filter((entry) => typeof entry === 'string' && entry.trim())
  .map((entry) => entry.trim()))];

const sameIds = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);

const safeIdPart = (value) => requiredText(value, 'Generation job id').replace(/[^a-zA-Z0-9_-]+/g, '-');

const stableSeed = (value) => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const fakeAssetUrl = ({prompt, modelId, seed}) => {
  const safePrompt = prompt.replace(/[<>&]/g, '').slice(0, 72);
  const safeModel = modelId.replace(/[<>&]/g, '').slice(0, 48);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#7653d6"/><stop offset="1" stop-color="#1f8f86"/></linearGradient></defs><rect width="1280" height="720" fill="#101218"/><rect x="28" y="28" width="1224" height="664" rx="24" fill="url(#g)" opacity=".72"/><text x="640" y="318" text-anchor="middle" fill="white" font-family="sans-serif" font-size="42" font-weight="700">${safePrompt}</text><text x="640" y="382" text-anchor="middle" fill="#e9e3ff" font-family="monospace" font-size="22">${safeModel}</text><text x="640" y="430" text-anchor="middle" fill="#b8f4eb" font-family="monospace" font-size="18">seed ${seed} · deterministic preview</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

export const normalizeTimelineGenerationInput = (input = {}) => {
  const operation = input.operation === 'add' ? 'add' : 'replace';
  const seed = typeof input.seed === 'string' || Number.isFinite(input.seed) ? input.seed : null;
  return {
    operation,
    sourceClipId: typeof input.sourceClipId === 'string' && input.sourceClipId.trim() ? input.sourceClipId.trim() : null,
    prompt: requiredText(input.prompt, 'Generation prompt'),
    modelId: requiredText(input.modelId, 'Generation model id'),
    seed,
    params: input.params && typeof input.params === 'object' && !Array.isArray(input.params) ? clone(input.params) : {},
    characterVersionIds: stringIds(input.characterVersionIds),
    parentAssetIds: stringIds(input.parentAssetIds),
    sceneId: typeof input.sceneId === 'string' && input.sceneId.trim() ? input.sceneId.trim() : null,
    trackId: typeof input.trackId === 'string' && input.trackId.trim() ? input.trackId.trim() : null,
    start: Number.isFinite(input.start) ? Math.max(0, input.start) : null,
    duration: Number.isFinite(input.duration) ? Math.max(0.1, input.duration) : null,
  };
};

export const normalizeGenerationResult = ({job, output, sourceClip = null, project}) => {
  if (!project?.timeline || !Array.isArray(project.mediaAssets)) throw new Error('A project snapshot is required.');
  const jobId = requiredText(job?.jobId || job?.id, 'Generation job id');
  const input = normalizeTimelineGenerationInput(job?.input || job);
  const acceptedSource = sourceClip || project.timeline.clips.find((clip) => clip.id === input.sourceClipId) || null;
  if (input.operation === 'replace' && !acceptedSource) throw new Error('Replacement generation requires an accepted source clip.');
  if (!output?.asset?.url || !output.asset.mimeType) throw new Error('Generation completed without a playable asset.');

  const sourceCharacterIds = stringIds(acceptedSource?.provenance?.characterVersionIds);
  const inputSpecifiedCharacters = Array.isArray(job?.input?.characterVersionIds) || Array.isArray(job?.characterVersionIds);
  const characterVersionIds = inputSpecifiedCharacters ? input.characterVersionIds : sourceCharacterIds;
  if (acceptedSource && !sameIds(sourceCharacterIds, characterVersionIds)) {
    throw new Error('Generation cannot replace the source clip character versions.');
  }

  const modelId = requiredText(output.modelId || input.modelId, 'Generation model id');
  const seed = output.seed ?? input.seed;
  const parentAssetIds = stringIds([
    ...(acceptedSource ? [acceptedSource.assetId] : []),
    ...stringIds(acceptedSource?.provenance?.parentAssetIds),
    ...(acceptedSource?.provenance?.parentAssetId ? [acceptedSource.provenance.parentAssetId] : []),
    ...input.parentAssetIds,
  ]);
  const safeJobId = safeIdPart(jobId);
  const assetId = typeof output.asset.id === 'string' && output.asset.id.trim()
    ? output.asset.id.trim()
    : `generation-asset-${safeJobId}`;
  const kind = output.asset.mimeType.startsWith('image/')
    ? 'image'
    : output.asset.mimeType.startsWith('audio/') ? 'audio' : 'video';
  const duration = Number.isFinite(output.asset.duration)
    ? Math.max(0.1, output.asset.duration)
    : input.duration || acceptedSource?.duration || (kind === 'image' ? 5 : 5);
  const provenance = {
    prompt: input.prompt,
    modelId,
    seed,
    params: {...input.params, ...(output.params || {})},
    parentAssetId: acceptedSource?.assetId || parentAssetIds[0] || null,
    parentAssetIds,
    derivedMetadata: {
      operation: input.operation,
      generationJobId: jobId,
      provider: output.source?.provider || 'unknown',
      changedFields: job?.changedFields && typeof job.changedFields === 'object' ? clone(job.changedFields) : {},
    },
    characterVersionIds,
  };
  const asset = {
    id: assetId,
    name: output.asset.name || `Generated ${input.operation === 'replace' ? 'replacement' : 'clip'}`,
    kind,
    mimeType: output.asset.mimeType,
    size: Number.isFinite(output.asset.size) ? output.asset.size : 0,
    duration,
    url: output.asset.url,
    source: {
      type: 'generated',
      fileName: output.asset.fileName || `${safeJobId}.${kind === 'image' ? 'png' : kind === 'audio' ? 'wav' : 'mp4'}`,
      lastModified: 0,
    },
    metadata: {
      width: output.asset.width,
      height: output.asset.height,
      provider: output.source?.provider || 'unknown',
      providerJobId: jobId,
      providerModelId: modelId,
    },
  };
  const clipId = input.operation === 'replace' ? acceptedSource.id : `generation-clip-${safeJobId}`;
  const proposedClip = {
    id: clipId,
    assetId,
    sceneId: acceptedSource?.sceneId || input.sceneId || project.timeline.activeSceneId,
    trackId: acceptedSource?.trackId || input.trackId || (kind === 'audio' ? 'A1' : 'V1'),
    start: input.start ?? acceptedSource?.start ?? 0,
    duration,
    provenance,
  };
  const operation = {
    type: input.operation,
    clipId,
    proposedClip,
  };
  return {
    asset,
    diff: {
      id: `generation-diff-${safeJobId}`,
      ...(Number.isInteger(job?.baseRevision) ? {baseRevision: job.baseRevision} : {}),
      source: 'generation',
      summary: input.operation === 'replace' ? 'Review generated replacement' : 'Review generated clip',
      operations: [operation],
      provenance,
    },
  };
};

export const landGenerationResult = ({store, diffs, job, output, sourceClip = null}) => {
  if (!store || typeof store.getProject !== 'function' || typeof store.dispatch !== 'function') {
    throw new TypeError('Landing generation results requires a project store.');
  }
  if (!diffs || typeof diffs.createProposal !== 'function') throw new TypeError('Landing generation results requires timeline diffs.');
  let project = store.getProject();
  const normalized = normalizeGenerationResult({job, output, sourceClip, project});
  const existingDiff = project.timelineDiffs.items.find((diff) => diff.id === normalized.diff.id);
  if (existingDiff) {
    return {assetId: normalized.asset.id, diffId: existingDiff.id, changed: false};
  }
  if (!project.mediaAssets.some((asset) => asset.id === normalized.asset.id)) {
    store.dispatch({type: 'asset/import', asset: normalized.asset});
    project = store.getProject();
  }
  const created = diffs.createProposal(normalized.diff);
  return {assetId: normalized.asset.id, diffId: created.affectedId, changed: true};
};

export const createFakeTimelineGenerationAdapter = ({
  createId = (() => { let id = 0; return () => `fake-timeline-job-${++id}`; })(),
} = {}) => {
  const jobs = new Map();
  return {
    kind: 'fake',
    async submitGeneration(input) {
      const normalized = normalizeTimelineGenerationInput(input);
      const jobId = createId();
      jobs.set(jobId, {input: normalized, polls: 0, shouldFail: /\[fail\]/i.test(normalized.prompt)});
      return {jobId};
    },
    async getGenerationJob(jobId) {
      const job = jobs.get(jobId);
      if (!job) return {status: 'failed', error: 'The local timeline generation job was not found.'};
      job.polls += 1;
      if (job.polls === 1) return {status: 'queued'};
      if (job.polls === 2) return {status: 'running'};
      if (job.shouldFail) return {status: 'failed', error: 'Deterministic timeline generation failure. Remove [fail] and retry.'};
      const seed = job.input.seed ?? stableSeed(`${job.input.prompt}\n${job.input.modelId}`);
      return {
        status: 'completed',
        asset: {
          url: fakeAssetUrl({...job.input, seed}),
          mimeType: 'image/svg+xml',
          width: 1280,
          height: 720,
          duration: job.input.duration || 5,
        },
        modelId: job.input.modelId,
        seed,
        params: {...job.input.params, mode: 'deterministic'},
        source: {provider: 'local-fake', jobId},
      };
    },
  };
};

export const createServerTimelineGenerationAdapter = ({fetchImpl = globalThis.fetch} = {}) => {
  const requestJson = async (url, options = {}) => {
    const response = await fetchImpl(url, options);
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) throw new Error(data.error || `Timeline generation request failed (${response.status}).`);
    return data;
  };
  return {
    kind: 'fal',
    async submitGeneration(input) {
      return requestJson('/api/timeline/generate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(normalizeTimelineGenerationInput(input)),
      });
    },
    async getGenerationJob(jobId) {
      return requestJson(`/api/timeline/jobs/${encodeURIComponent(requiredText(jobId, 'Generation job id'))}`);
    },
  };
};

export const createTimelineGenerationController = ({adapter, onCompleted = async () => {}}) => {
  if (!adapter || typeof adapter.submitGeneration !== 'function' || typeof adapter.getGenerationJob !== 'function') {
    throw new TypeError('Timeline generation requires a submit-and-poll adapter.');
  }
  const completedJobIds = new Set();
  let state = {status: 'idle', providerStatus: null, jobId: null, error: null, input: null, attempt: 0, result: null};
  const snapshot = () => clone(state);

  const submit = async (input, retry = false) => {
    if (ACTIVE_JOB_STATES.has(state.status)) throw new Error('A timeline generation is already active.');
    const normalized = normalizeTimelineGenerationInput(input);
    const attempt = state.attempt + 1;
    state = {
      status: retry ? 'retrying' : 'queued',
      providerStatus: 'queued',
      jobId: null,
      error: null,
      input: normalized,
      attempt,
      result: null,
    };
    try {
      const {jobId} = await adapter.submitGeneration(normalized);
      state.jobId = requiredText(jobId, 'Generation job id');
    } catch (error) {
      state.status = 'failed';
      state.providerStatus = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
    }
    return snapshot();
  };

  const poll = async () => {
    if (!ACTIVE_JOB_STATES.has(state.status) || !state.jobId) return snapshot();
    try {
      const result = await adapter.getGenerationJob(state.jobId);
      if (result.status === 'queued') {
        state.providerStatus = 'queued';
        if (state.status !== 'retrying') state.status = 'queued';
      } else if (result.status === 'running') {
        state.status = 'running';
        state.providerStatus = 'running';
      } else if (result.status === 'completed') {
        if (!completedJobIds.has(state.jobId)) {
          await onCompleted(clone(result), {jobId: state.jobId, input: clone(state.input), attempt: state.attempt});
          completedJobIds.add(state.jobId);
        }
        state.status = 'completed';
        state.providerStatus = 'completed';
        state.result = clone(result);
      } else {
        state.status = 'failed';
        state.providerStatus = 'failed';
        state.error = result.error || 'Timeline generation failed.';
      }
    } catch (error) {
      state.status = 'failed';
      state.providerStatus = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
    }
    return snapshot();
  };

  const retry = async (input = state.input) => {
    if (state.status !== 'failed' || !state.input) throw new Error('Only failed timeline generation jobs can be retried.');
    return submit(input, true);
  };

  return {snapshot, submit, poll, retry};
};
