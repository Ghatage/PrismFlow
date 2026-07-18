import {createFalModelPricingAdapter, writeModelPricingCsv} from '../server/model-pricing.mjs';

const outputPath = process.argv[2] || 'fal-model-pricing.csv';

const adapter = createFalModelPricingAdapter();
const result = await adapter.sync({status: 'active'});
const rowCount = await writeModelPricingCsv(result.records, outputPath);
console.log(`Wrote ${rowCount} CSV rows for ${result.modelCount} models to ${outputPath}`);
