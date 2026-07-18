const ACTIVE_STATES = new Set(['generating', 'retrying']);

const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const requiredText = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
};

const stableSeed = (value) => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export const normalizeCharacterGenerationInput = (input = {}) => ({
  kind: input.kind === 'scene-still' ? 'scene-still' : 'character-sheet',
  name: requiredText(input.name, 'Character name'),
  prompt: requiredText(input.prompt, 'Visual prompt'),
  referenceAssetIds: [...new Set((Array.isArray(input.referenceAssetIds) ? input.referenceAssetIds : [])
    .filter((assetId) => typeof assetId === 'string' && assetId.trim())
    .map((assetId) => assetId.trim()))],
  styleNotes: typeof input.styleNotes === 'string' ? input.styleNotes.trim() : '',
});

const fakeSheetUrl = ({name, prompt}) => {
  const safeName = name.replace(/[<>&]/g, '');
  const safePrompt = prompt.replace(/[<>&]/g, '').slice(0, 90);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#6845c6"/><stop offset="1" stop-color="#1f8079"/></linearGradient></defs><rect width="1024" height="768" fill="#11131a"/><rect x="28" y="28" width="968" height="712" rx="24" fill="url(#g)" opacity=".72"/><circle cx="246" cy="315" r="142" fill="#f1d0a3"/><circle cx="758" cy="315" r="142" fill="#d7c4fa"/><text x="512" y="584" text-anchor="middle" fill="white" font-family="sans-serif" font-size="54" font-weight="700">${safeName}</text><text x="512" y="638" text-anchor="middle" fill="#eee9ff" font-family="sans-serif" font-size="24">${safePrompt}</text><text x="512" y="690" text-anchor="middle" fill="#b8f4eb" font-family="monospace" font-size="18">LOCAL CHARACTER SHEET</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

export const createFakeCharacterGenerationAdapter = ({
  createId = (() => { let id = 0; return () => `fake-character-job-${++id}`; })(),
} = {}) => {
  const jobs = new Map();

  return {
    kind: 'fake',

    async generateCharacterSheet(input) {
      const normalized = normalizeCharacterGenerationInput(input);
      const jobId = createId();
      jobs.set(jobId, {
        input: normalized,
        polls: 0,
        shouldFail: /\[fail\]/i.test(`${normalized.prompt} ${normalized.styleNotes}`),
      });
      return {jobId};
    },

    async getCharacterSheetJob(jobId) {
      const job = jobs.get(jobId);
      if (!job) return {status: 'failed', error: 'The local generation job was not found.'};
      job.polls += 1;
      if (job.polls === 1) return {status: 'running'};
      if (job.shouldFail) return {status: 'failed', error: 'Deterministic local generation failure. Remove [fail] and retry.'};
      const seed = stableSeed(`${job.input.name}\n${job.input.prompt}\n${job.input.styleNotes}`);
      return {
        status: 'completed',
        asset: {
          url: fakeSheetUrl(job.input),
          mimeType: 'image/svg+xml',
          width: 1024,
          height: 768,
        },
        modelId: 'local/fake-character-sheet-v1',
        seed,
        params: {styleNotes: job.input.styleNotes, mode: 'deterministic'},
        source: {provider: 'local-fake', jobId},
      };
    },
  };
};

export const createServerCharacterGenerationAdapter = ({
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
    if (!response.ok) throw new Error(data.error || `Character generation request failed (${response.status}).`);
    return data;
  };

  return {
    kind: 'fal',

    async generateCharacterSheet(input) {
      const normalized = normalizeCharacterGenerationInput(input);
      const resolvedUrls = await Promise.all(normalized.referenceAssetIds
        .map((assetId) => resolveReferenceUrl(assetId))
        .map((url) => Promise.resolve(toUploadableUrl(url)).catch(() => null)));
      const referenceUrls = resolvedUrls
        .filter((url) => typeof url === 'string' && /^(https:\/\/|data:image\/)/i.test(url));
      return requestJson('/api/characters/generate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({...normalized, referenceUrls}),
      });
    },

    async getCharacterSheetJob(jobId) {
      return requestJson(`/api/characters/jobs/${encodeURIComponent(requiredText(jobId, 'Generation job id'))}`);
    },
  };
};

export const createCharacterGenerationController = ({adapter, onCompleted = async () => {}}) => {
  if (!adapter || typeof adapter.generateCharacterSheet !== 'function' || typeof adapter.getCharacterSheetJob !== 'function') {
    throw new TypeError('Character generation requires a submit-and-poll adapter.');
  }

  let state = {
    status: 'idle',
    providerStatus: null,
    jobId: null,
    error: null,
    input: null,
    attempt: 0,
    result: null,
  };

  const snapshot = () => clone(state);

  const submit = async (input, retry = false) => {
    if (ACTIVE_STATES.has(state.status)) throw new Error('A character sheet is already generating.');
    const normalized = normalizeCharacterGenerationInput(input);
    const attempt = state.attempt + 1;
    state = {
      status: retry || attempt > 1 ? 'retrying' : 'generating',
      providerStatus: 'queued',
      jobId: null,
      error: null,
      input: normalized,
      attempt,
      result: null,
    };
    try {
      const {jobId} = await adapter.generateCharacterSheet(normalized);
      state.jobId = requiredText(jobId, 'Generation job id');
    } catch (error) {
      state.status = 'failed';
      state.providerStatus = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
    }
    return snapshot();
  };

  const poll = async () => {
    if (!ACTIVE_STATES.has(state.status) || !state.jobId) return snapshot();
    try {
      const result = await adapter.getCharacterSheetJob(state.jobId);
      if (result.status === 'queued' || result.status === 'running') {
        state.providerStatus = result.status;
      } else if (result.status === 'completed') {
        await onCompleted(clone(result), clone(state.input));
        state.status = 'ready';
        state.providerStatus = 'completed';
        state.result = clone(result);
      } else {
        state.status = 'failed';
        state.providerStatus = 'failed';
        state.error = result.error || 'Character generation failed.';
      }
    } catch (error) {
      state.status = 'failed';
      state.providerStatus = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
    }
    return snapshot();
  };

  const retry = async (input = state.input) => {
    if (state.status !== 'failed' || !state.input) throw new Error('Only failed character jobs can be retried.');
    return submit(input, true);
  };

  return {snapshot, submit, poll, retry};
};

export const recordCharacterSheetVersion = ({dispatch, library, characterId, input, result}) => {
  if (!result?.asset?.url || !result.asset.mimeType) throw new Error('Generation completed without a usable character sheet.');
  const imported = dispatch({
    type: 'asset/import',
    asset: {
      name: `${input.name} character sheet`,
      kind: 'image',
      mimeType: result.asset.mimeType,
      size: 0,
      duration: 5,
      url: result.asset.url,
      source: {type: 'generated', fileName: `${input.name}-character-sheet`, lastModified: 0},
      metadata: {
        width: result.asset.width,
        height: result.asset.height,
        provider: result.source?.provider || 'local',
        providerJobId: result.source?.jobId || null,
        providerModelId: result.source?.modelId || result.modelId || null,
        providerFileName: result.source?.fileName || null,
        providerDescription: result.source?.description || '',
      },
    },
  });
  const version = library.recordVersion(characterId, {
    sheetAssetId: imported.affectedId,
    referenceAssetIds: input.referenceAssetIds,
    prompt: input.prompt,
    modelId: result.modelId,
    seed: result.seed,
    params: result.params,
    parentAssetIds: input.referenceAssetIds,
  });
  return {assetId: imported.affectedId, versionId: version.affectedId};
};
