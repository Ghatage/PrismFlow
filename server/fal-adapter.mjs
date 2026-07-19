import {File} from 'node:buffer';
import {fal as falClient} from '@fal-ai/client';

const FAL_RUN_ORIGIN = 'https://fal.run';
const FAL_QUEUE_ORIGIN = 'https://queue.fal.run';
const FAL_PLATFORM_ORIGIN = 'https://api.fal.ai';

const isSafeModelId = (modelId) =>
  typeof modelId === 'string' && /^[a-zA-Z0-9._/-]+$/.test(modelId);

// Queue submits accept the full endpoint path (owner/app/subpath), but status and
// result URLs only route on the root app id — polling with the subpath returns 405.
const queueAppId = (modelId) => modelId.split('/').slice(0, 2).join('/');

export const normalizeFalCost = (value, {basis = 'reported'} = {}) => {
  const amount = Number.isFinite(value)
    ? value
    : Number.isFinite(value?.estimatedUsd) ? value.estimatedUsd
      : Number.isFinite(value?.cost) ? value.cost
        : Number.isFinite(value?.total_cost) ? value.total_cost
          : null;
  if (amount === null || amount < 0) return null;
  return {
    estimatedUsd: amount,
    credits: Number.isFinite(value?.credits) ? Math.max(0, value.credits) : amount * 100,
    unit: typeof value?.unit === 'string' && value.unit.trim() ? value.unit.trim() : 'request',
    quantity: Number.isFinite(value?.quantity) ? Math.max(0, value.quantity) : 1,
    currency: typeof value?.currency === 'string' && value.currency.trim() ? value.currency.trim() : 'USD',
    basis: typeof value?.basis === 'string' && value.basis.trim() ? value.basis.trim() : basis,
  };
};

export const resolveFalResultCost = async ({fal, modelId, result} = {}) => {
  const reported = normalizeFalCost(result?.cost ?? result?.usage?.cost, {basis: 'reported'});
  if (reported) return reported;
  if (typeof fal?.estimateCost !== 'function') return null;
  try {
    return await fal.estimateCost(modelId);
  } catch {
    // Cost telemetry must never turn a successful generation into a failure.
    return null;
  }
};

export const createFalAdapter = ({
  apiKey = process.env.FAL_API_KEY || process.env.FAL_KEY,
  fetchImpl = globalThis.fetch,
  runOrigin = FAL_RUN_ORIGIN,
  queueOrigin = FAL_QUEUE_ORIGIN,
  platformOrigin = FAL_PLATFORM_ORIGIN,
} = {}) => {
  const costEstimates = new Map();
  const requestJson = async (url, options = {}) => {
    if (!apiKey) throw new Error('FAL_API_KEY is not configured on the local server.');
    const response = await fetchImpl(url, {
      ...options,
      headers: {
        Authorization: `Key ${apiKey}`,
        ...options.headers,
      },
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = {raw: text};
    }
    if (!response.ok) {
      const detail = data?.detail || data?.message || data?.error || text || response.statusText;
      throw new Error(`fal request failed (${response.status}): ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
    return data;
  };

  const requireModelId = (modelId) => {
    if (!isSafeModelId(modelId)) throw new Error('modelId must be a valid fal endpoint id.');
    return modelId;
  };

  const requireRequestId = (requestId) => {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(requestId)) {
      throw new Error('requestId must be a valid fal queue request id.');
    }
    return requestId;
  };

  return {
    configured: Boolean(apiKey),

    async upload(bytes, {fileName = 'asset.bin', mimeType = 'application/octet-stream'} = {}) {
      if (!apiKey) throw new Error('FAL_API_KEY is not configured on the local server.');
      falClient.config({credentials: apiKey});
      const file = new File([bytes], fileName, {type: mimeType});
      const url = await falClient.storage.upload(file);
      if (typeof url !== 'string' || !/^https:\/\//i.test(url)) throw new Error('fal storage did not return an HTTPS URL.');
      return url;
    },

    async run(modelId, input) {
      return requestJson(`${runOrigin}/${requireModelId(modelId)}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(input ?? {}),
      });
    },

    async submit(modelId, input) {
      return requestJson(`${queueOrigin}/${requireModelId(modelId)}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(input ?? {}),
      });
    },

    async status(modelId, requestId) {
      return requestJson(`${queueOrigin}/${queueAppId(requireModelId(modelId))}/requests/${requireRequestId(requestId)}/status`);
    },

    async result(modelId, requestId) {
      return requestJson(`${queueOrigin}/${queueAppId(requireModelId(modelId))}/requests/${requireRequestId(requestId)}`);
    },

    async estimateCost(modelId) {
      const endpointId = requireModelId(modelId);
      if (!costEstimates.has(endpointId)) {
        costEstimates.set(endpointId, requestJson(`${platformOrigin}/v1/models/pricing/estimate`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            estimate_type: 'historical_api_price',
            endpoints: {[endpointId]: {call_quantity: 1}},
          }),
        }).then((result) => normalizeFalCost(result, {basis: 'historical-api-price'}))
          .catch((error) => {
            costEstimates.delete(endpointId);
            throw error;
          }));
      }
      return costEstimates.get(endpointId);
    },
  };
};
