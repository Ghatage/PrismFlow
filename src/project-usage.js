import {createGenerationUsageEntry} from './quality-tiers.js';

const text = (value) => typeof value === 'string' ? value.trim() : '';
const safeId = (value) => text(value).replace(/[^a-zA-Z0-9_-]+/g, '-');

export const createProjectFalUsageEntry = ({
  id = null,
  generationJobId = null,
  modelId,
  provider = 'fal',
  operation = 'generation',
  cost = null,
  usage = null,
  now,
} = {}) => {
  if (provider !== 'fal' || !text(modelId)) return null;
  const usageCost = cost ?? usage?.cost ?? null;
  const entry = createGenerationUsageEntry({
    job: {
      jobId: generationJobId || id,
      input: {modelId: text(modelId), qualityTier: 'final'},
    },
    output: {modelId: text(modelId), cost: usageCost},
    ...(typeof now === 'function' ? {now} : {}),
  });
  if (!entry) return null;
  const stableId = safeId(id || generationJobId);
  return {
    ...entry,
    ...(stableId ? {id: `usage-${stableId}`} : {}),
    operation: text(operation) || 'generation',
  };
};

export const recordProjectFalUsage = ({dispatch, ...input} = {}) => {
  if (typeof dispatch !== 'function') throw new TypeError('Recording project FAL usage requires a project dispatch function.');
  const entry = createProjectFalUsageEntry(input);
  return entry ? dispatch({type: 'usage/record', entry}) : null;
};
