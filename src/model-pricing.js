import {createBrowserDatabase} from './browser-database.js';

export const syncModelPricing = async ({
  fetchImpl = globalThis.fetch,
  database = createBrowserDatabase(),
  status,
  exportCsv = false,
} = {}) => {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (exportCsv) params.set('export', '1');
  const query = params.toString();
  const response = await fetchImpl(`/api/fal/model-pricing${query ? `?${query}` : ''}`, {
    method: 'POST',
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || `Model pricing sync failed (${response.status}).`);
  await database.replaceModelPricing(payload.records || []);
  return payload;
};

export const importModelPricing = async ({
  fetchImpl = globalThis.fetch,
  database = createBrowserDatabase(),
} = {}) => {
  const response = await fetchImpl('/fal-model-pricing.json');
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || `Model pricing import failed (${response.status}).`);
  await database.replaceModelPricing(payload.records || []);
  const storedRecords = await database.loadModelPricing();
  return {...payload, storedCount: storedRecords.length};
};
