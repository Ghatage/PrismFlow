const FAL_RUN_ORIGIN = 'https://fal.run';

const isSafeModelId = (modelId) =>
  typeof modelId === 'string' && /^[a-zA-Z0-9._/-]+$/.test(modelId);

export const createFalAdapter = ({
  apiKey = process.env.FAL_API_KEY || process.env.FAL_KEY,
} = {}) => ({
  configured: Boolean(apiKey),

  async run(modelId, input) {
    if (!apiKey) {
      throw new Error('FAL_API_KEY is not configured on the local server.');
    }

    if (!isSafeModelId(modelId)) {
      throw new Error('modelId must be a valid fal endpoint id.');
    }

    const response = await fetch(`${FAL_RUN_ORIGIN}/${modelId}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input ?? {}),
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = {raw: text};
    }

    if (!response.ok) {
      const detail = data?.detail || data?.message || text || response.statusText;
      throw new Error(`fal request failed (${response.status}): ${detail}`);
    }

    return data;
  },
});
