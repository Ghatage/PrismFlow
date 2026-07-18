import {createReadStream} from 'node:fs';
import {stat, readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, join, normalize, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFalAdapter} from './server/fal-adapter.mjs';
import {createFalCharacterSheetAdapter} from './server/character-sheet-adapter.mjs';
import {createFalTimelineGenerationAdapter} from './server/timeline-generation-adapter.mjs';
import {createFalModelPricingAdapter, writeModelPricingCsv} from './server/model-pricing.mjs';
import {createModelSearchAdapter} from './server/model-search.mjs';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const fal = createFalAdapter();
const characterSheets = createFalCharacterSheetAdapter({fal});
const timelineGenerations = createFalTimelineGenerationAdapter({fal});
const modelPricing = createFalModelPricingAdapter();
const modelSearch = createModelSearchAdapter({
  catalogPath: join(rootDir, 'fal-model-pricing.json'),
  indexPath: join(rootDir, 'model-search-index.json'),
});

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const sendJson = (response, status, payload) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
};

const readJson = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new Error('Request body is too large.');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const serveStatic = async (requestPath, response) => {
  const requestedPath = requestPath === '/' ? '/index.html' : requestPath;
  const filePath = normalize(join(rootDir, requestedPath));
  const relativePath = relative(rootDir, filePath);

  if (relativePath.startsWith('..') || relativePath.includes('..' + '\\')) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error('Not a file');

    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
    response.end('Not found');
  }
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (url.pathname === '/api/fal/status' && request.method === 'GET') {
    sendJson(response, 200, {
      provider: 'fal',
      adapter: 'ready',
      configured: fal.configured,
      characterModelId: characterSheets.modelId,
    });
    return;
  }

  if (url.pathname === '/api/fal/model-pricing' && request.method === 'POST') {
    try {
      const status = url.searchParams.get('status') || undefined;
      const result = await modelPricing.sync({status});
      if (url.searchParams.get('export') === '1') {
        result.csvRows = await writeModelPricingCsv(result.records, join(rootDir, 'fal-model-pricing.csv'));
        result.csvPath = 'fal-model-pricing.csv';
      }
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (url.pathname === '/api/search/models' && request.method === 'GET') {
    try {
      const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
      const result = await modelSearch.search(query, {limit: url.searchParams.get('limit')});
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (url.pathname === '/api/search/models/index' && request.method === 'POST') {
    try {
      const result = await modelSearch.buildIndex();
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (url.pathname === '/api/search/models/status' && request.method === 'GET') {
    try {
      sendJson(response, 200, await modelSearch.status());
    } catch (error) {
      sendJson(response, 500, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (url.pathname === '/api/characters/generate' && request.method === 'POST') {
    try {
      const body = await readJson(request);
      const result = await characterSheets.submitCharacterSheet(body);
      sendJson(response, 202, result);
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  const characterJobMatch = url.pathname.match(/^\/api\/characters\/jobs\/([^/]+)$/);
  if (characterJobMatch && request.method === 'GET') {
    const result = await characterSheets.getCharacterSheetJob(decodeURIComponent(characterJobMatch[1]));
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === '/api/timeline/generate' && request.method === 'POST') {
    try {
      const body = await readJson(request);
      const result = await timelineGenerations.submitTimelineGeneration(body);
      sendJson(response, 202, result);
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  const timelineJobMatch = url.pathname.match(/^\/api\/timeline\/jobs\/([^/]+)$/);
  if (timelineJobMatch && request.method === 'GET') {
    const result = await timelineGenerations.getTimelineGenerationJob(decodeURIComponent(timelineJobMatch[1]));
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === '/api/fal/run' && request.method === 'POST') {
    try {
      const body = await readJson(request);
      const result = await fal.run(body.modelId, body.input);
      sendJson(response, 200, {result});
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  await serveStatic(url.pathname, response);
});

server.listen(port, () => {
  console.log(`PrismFlow editor: http://localhost:${port}`);
  console.log(`FAL adapter: ${fal.configured ? 'configured' : 'not configured'}`);
});
