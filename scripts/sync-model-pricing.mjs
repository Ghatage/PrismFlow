import {syncModelPricing} from '../src/model-pricing.js';

// Run from the PrismFlow browser origin with:
//   await import('/scripts/sync-model-pricing.mjs');
// The local server uses FAL_API_KEY; the key never enters browser storage.
const result = await syncModelPricing({status: 'active', exportCsv: true});
console.info(`Stored ${result.modelCount} FAL models and ${result.priceCount} prices in IndexedDB.modelPricing; exported ${result.csvPath || 'no CSV'}.`);

export {result};
