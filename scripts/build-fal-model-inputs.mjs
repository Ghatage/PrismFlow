import {readFile, writeFile} from 'node:fs/promises';

const OPENAPI_BASE = 'https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=';

export const extractModelInputs = (doc) => {
  const schemas = doc?.components?.schemas || {};
  let ref = null;
  for (const operations of Object.values(doc?.paths || {})) {
    for (const operation of Object.values(operations)) {
      const schema = operation?.requestBody?.content?.['application/json']?.schema;
      if (schema?.$ref) ref = schema.$ref;
      if (ref) break;
    }
    if (ref) break;
  }
  let input = ref?.startsWith('#/components/schemas/')
    ? schemas[ref.slice('#/components/schemas/'.length)]
    : null;
  if (!input) {
    const fallback = Object.entries(schemas).find(([name]) => name.endsWith('Input'));
    input = fallback ? fallback[1] : null;
  }
  if (!input) return null;
  const properties = Object.keys(input.properties || {});
  const imageKey = properties.includes('image_urls')
    ? 'image_urls'
    : properties.includes('image_url')
      ? 'image_url'
      : null;
  return {
    imageKey,
    imageKeyIsArray: imageKey === 'image_urls',
    hasPrompt: properties.includes('prompt'),
  };
};

const fetchModelInputs = async (endpointId, fetchImpl) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(`${OPENAPI_BASE}${endpointId}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return extractModelInputs(await response.json());
    } catch (error) {
      if (attempt === 1) {
        console.warn(`skip ${endpointId}: ${error.message}`);
        return null;
      }
    }
  }
  return null;
};

const run = async () => {
  const pricingPath = process.argv[2] || 'fal-model-pricing.json';
  const outputPath = process.argv[3] || 'fal-model-inputs.json';
  const pricing = JSON.parse(await readFile(pricingPath, 'utf8'));
  const ids = [...new Set(pricing.records.map((record) => record.id))];

  let existing = {};
  try {
    existing = JSON.parse(await readFile(outputPath, 'utf8')).models || {};
  } catch {
    existing = {};
  }

  const pending = ids.filter((id) => !(id in existing));
  console.log(`${ids.length} models, ${pending.length} to fetch`);
  const models = {...existing};
  let done = 0;

  let saving = Promise.resolve();
  const save = () => {
    saving = saving.then(() =>
      writeFile(outputPath, `${JSON.stringify({models, syncedAt: new Date().toISOString()}, null, 1)}\n`)
    );
    return saving;
  };

  const workers = Array.from({length: 5}, async () => {
    while (pending.length) {
      const id = pending.shift();
      models[id] = await fetchModelInputs(id, fetch);
      done += 1;
      if (done % 50 === 0) {
        console.log(`${done} fetched`);
        await save();
      }
    }
  });
  await Promise.all(workers);
  await save();
  const withImage = Object.values(models).filter((entry) => entry?.imageKey).length;
  console.log(`done: ${Object.keys(models).length} models, ${withImage} accept image input`);
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) await run();
