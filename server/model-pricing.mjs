import {writeFile} from 'node:fs/promises';

const FAL_PLATFORM_ORIGIN = 'https://api.fal.ai';
const PAGE_LIMIT = 50;
const PRICING_BATCH_SIZE = 50;

const endpointIdFromModel = (model) => typeof model?.endpoint_id === 'string' && model.endpoint_id.trim()
  ? model.endpoint_id.trim()
  : null;

const errorMessage = (data, text, statusText) => {
  const detail = data?.detail || data?.message || data?.error || text || statusText;
  return typeof detail === 'string' ? detail : JSON.stringify(detail);
};

const chunk = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};

const csvValue = (value) => {
  const text = value === null || value === undefined
    ? ''
    : typeof value === 'string' ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
};

const MODEL_PRICING_CSV_HEADERS = [
  'endpoint_id',
  'display_name',
  'category',
  'status',
  'description',
  'tags',
  'model_url',
  'thumbnail_url',
  'unit_price',
  'unit',
  'currency',
  'model_json',
  'price_json',
  'synced_at',
];

export const writeModelPricingCsv = async (records, outputPath) => {
  const rows = (Array.isArray(records) ? records : []).flatMap((record) => {
    const metadata = record.model?.metadata || {};
    const prices = record.prices?.length ? record.prices : [null];
    return prices.map((price) => [
      record.endpointId,
      metadata.display_name,
      metadata.category,
      metadata.status,
      metadata.description,
      metadata.tags,
      metadata.model_url,
      metadata.thumbnail_url,
      price?.unit_price,
      price?.unit,
      price?.currency,
      record.model,
      price,
      record.syncedAt,
    ].map(csvValue).join(','));
  });
  await writeFile(outputPath, `${MODEL_PRICING_CSV_HEADERS.map(csvValue).join(',')}\n${rows.join('\n')}\n`, 'utf8');
  return rows.length;
};

export const createFalModelPricingAdapter = ({
  apiKey = process.env.FAL_ADMIN_KEY || process.env.FAL_API_KEY || process.env.FAL_KEY,
  fetchImpl = globalThis.fetch,
  origin = FAL_PLATFORM_ORIGIN,
} = {}) => {
  const requestJson = async (path, params, attempt = 0) => {
    if (!apiKey) throw new Error('FAL_ADMIN_KEY or FAL_API_KEY is not configured on the local server.');
    const query = params?.toString();
    const response = await fetchImpl(`${origin}${path}${query ? `?${query}` : ''}`, {
      headers: {Authorization: `Key ${apiKey}`},
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = {raw: text};
    }
    if (response.status === 429 && attempt < 5) {
      const retryAfter = Number.parseFloat(response.headers?.get?.('retry-after') || '');
      const delayMs = Math.min(60_000, Math.max(2_000, Number.isFinite(retryAfter) ? retryAfter * 1_000 : 10_000));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return requestJson(path, params, attempt + 1);
    }
    if (!response.ok) {
      const error = new Error(`fal request failed (${response.status}): ${errorMessage(data, text, response.statusText)}`);
      error.status = response.status;
      throw error;
    }
    return data || {};
  };

  const listModels = async ({status} = {}) => {
    const models = [];
    let cursor = null;
    const seenCursors = new Set();
    do {
      const params = new URLSearchParams({limit: String(PAGE_LIMIT)});
      if (status) params.set('status', status);
      if (cursor) params.set('cursor', cursor);
      const response = await requestJson('/v1/models', params);
      models.push(...(Array.isArray(response.models) ? response.models : []));
      const nextCursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : null;
      if (!response.has_more || !nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return models;
  };

  const fetchPricingBatch = async (endpointBatch) => {
    const prices = [];
    let cursor = null;
    const seenCursors = new Set();
    do {
      const params = new URLSearchParams();
      endpointBatch.forEach((endpointId) => params.append('endpoint_id', endpointId));
      if (cursor) params.set('cursor', cursor);
      const response = await requestJson('/v1/models/pricing', params);
      prices.push(...(Array.isArray(response.prices) ? response.prices : []));
      const nextCursor = typeof response.next_cursor === 'string' && response.next_cursor ? response.next_cursor : null;
      if (!response.has_more || !nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return prices;
  };

  const listPricing = async (endpointIds) => {
    const prices = [];
    for (const endpointBatch of chunk(endpointIds, PRICING_BATCH_SIZE)) {
      try {
        prices.push(...await fetchPricingBatch(endpointBatch));
      } catch (error) {
        if (error.status !== 404 || endpointBatch.length === 1) continue;
        const midpoint = Math.ceil(endpointBatch.length / 2);
        prices.push(...await listPricing(endpointBatch.slice(0, midpoint)));
        prices.push(...await listPricing(endpointBatch.slice(midpoint)));
      }
    }
    return prices;
  };

  return {
    configured: Boolean(apiKey),

    async sync({status} = {}) {
      const fetchedAt = new Date().toISOString();
      const rawModels = await listModels({status});
      const models = [...new Map(rawModels
        .map((model) => [endpointIdFromModel(model), model])
        .filter(([endpointId]) => endpointId)).values()];
      const endpointIds = models.map(endpointIdFromModel);
      const prices = await listPricing(endpointIds);
      const pricesByEndpoint = new Map();
      prices.forEach((price) => {
        const endpointId = typeof price?.endpoint_id === 'string' ? price.endpoint_id : null;
        if (!endpointId) return;
        const entries = pricesByEndpoint.get(endpointId) || [];
        entries.push(price);
        pricesByEndpoint.set(endpointId, entries);
      });
      const records = models.map((model) => {
        const endpointId = endpointIdFromModel(model);
        return {
          id: endpointId,
          endpointId,
          model,
          prices: pricesByEndpoint.get(endpointId) || [],
          syncedAt: fetchedAt,
        };
      });
      return {
        records,
        syncedAt: fetchedAt,
        modelCount: records.length,
        priceCount: prices.length,
      };
    },
  };
};
