import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createModelSearchAdapter} from '../server/model-search.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const search = createModelSearchAdapter({
  catalogPath: join(rootDir, 'fal-model-pricing.json'),
  indexPath: join(rootDir, 'model-search-index.json'),
});

const status = await search.buildIndex();
console.log(`Indexed ${status.recordCount} models with ${status.dimensions}-dimensional ${status.model} embeddings.`);
console.log(`Saved model search index: ${status.indexPath}`);
