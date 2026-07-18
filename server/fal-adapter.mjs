import {File} from 'node:buffer';
import {fal as falClient} from '@fal-ai/client';

const FAL_RUN_ORIGIN = 'https://fal.run';
const FAL_QUEUE_ORIGIN = 'https://queue.fal.run';

const isSafeModelId = (modelId) =>
  typeof modelId === 'string' && /^[a-zA-Z0-9._/-]+$/.test(modelId);

// Queue submits accept the full endpoint path (owner/app/subpath), but status and
// result URLs only route on the root app id — polling with the subpath returns 405.
const queueAppId = (modelId) => modelId.split('/').slice(0, 2).join('/');

export const createFalAdapter = ({
  apiKey = process.env.FAL_API_KEY || process.env.FAL_KEY,
  fetchImpl = globalThis.fetch,
  runOrigin = FAL_RUN_ORIGIN,
  queueOrigin = FAL_QUEUE_ORIGIN,
} = {}) => {
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
  };
};
