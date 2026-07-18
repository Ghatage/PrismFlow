import {importModelPricing} from '../src/model-pricing.js';

const result = await importModelPricing();
if (typeof document !== 'undefined') document.body.dataset.modelPricingCount = String(result.storedCount);
console.info(`Imported ${result.storedCount} FAL model pricing records into IndexedDB.modelPricing.`);

export {result};
