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
import {createLocalVideoVlmAdapter} from './server/video-vlm.mjs';
import {createVideoSearchAdapter} from './server/video-search.mjs';
import {createLlmAdapter} from './server/llm-adapter.mjs';
import {createFalStyleApplicationAdapter} from './server/style-application-adapter.mjs';
import {createFalStoryboardGenerationAdapter} from './server/storyboard-generation-adapter.mjs';
import {createFalMusicGenerationAdapter} from './server/music-generation-adapter.mjs';
import {createTimelineExportService} from './server/timeline-export.mjs';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const fal = createFalAdapter();
const characterSheets = createFalCharacterSheetAdapter({fal});
const modelInputs = await readFile(join(rootDir, 'fal-model-inputs.json'), 'utf8')
  .then((text) => JSON.parse(text).models || {})
  .catch(() => ({}));
const timelineGenerations = createFalTimelineGenerationAdapter({fal, modelInputs});
const modelPricing = createFalModelPricingAdapter();
const modelSearch = createModelSearchAdapter({
  catalogPath: join(rootDir, 'fal-model-pricing.json'),
  indexPath: join(rootDir, 'model-search-index.json'),
});
const videoVlm = createLocalVideoVlmAdapter({modelId: process.env.PRISMFLOW_VIDEO_VLM_MODEL || undefined});
const videoSearch = createVideoSearchAdapter({
  indexPath: join(rootDir, 'video-search-index.json'),
});
const llm = createLlmAdapter();
const styleApplications = createFalStyleApplicationAdapter({fal});
const storyboardGenerations = createFalStoryboardGenerationAdapter({fal});
const musicGenerations = createFalMusicGenerationAdapter({fal});
const timelineExports = createTimelineExportService({rootDir});

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

const sendJson = (response, status, payload) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
};

const readJson = async (request, maxBytes = 1_000_000) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error('Request body is too large.');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const readBytes = async (request, maxBytes = 200_000_000) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Uploaded media is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
      storyboardStillModelId: storyboardGenerations.stillModelId,
      storyboardStillEditModelId: storyboardGenerations.stillEditModelId,
      storyboardScriptModelId: storyboardGenerations.scriptModelId,
      styleVideoModelId: styleApplications.videoModelId,
      styleImageModelId: styleApplications.imageModelId,
      musicModelId: musicGenerations.musicModelId,
      scoreDirectionModelId: musicGenerations.scoreDirectionModelId,
    });
    return;
  }

  if (url.pathname === '/api/export/sessions' && request.method === 'POST') {
    try {
      const body = await readJson(request, 4_000_000);
      sendJson(response, 201, await timelineExports.createSession(body.manifest));
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  const exportAssetMatch = url.pathname.match(/^\/api\/export\/sessions\/([^/]+)\/assets\/([^/]+)$/);
  if (exportAssetMatch && request.method === 'PUT') {
    try {
      const sessionId = decodeURIComponent(exportAssetMatch[1]);
      const assetId = decodeURIComponent(exportAssetMatch[2]);
      const result = await timelineExports.uploadAsset(sessionId, assetId, request, {
        fileName: String(request.headers['x-file-name'] || ''),
        mimeType: String(request.headers['content-type'] || 'application/octet-stream').split(';')[0],
      });
      sendJson(response, 201, result);
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  const exportRenderMatch = url.pathname.match(/^\/api\/export\/sessions\/([^/]+)\/render$/);
  if (exportRenderMatch && request.method === 'POST') {
    const sessionId = decodeURIComponent(exportRenderMatch[1]);
    try {
      const result = await timelineExports.render(sessionId);
      response.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Disposition': 'attachment; filename="output.mp4"',
        'Content-Length': result.size,
        'Cache-Control': 'no-store',
      });
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        void timelineExports.cleanup(sessionId);
      };
      response.once('finish', cleanup);
      response.once('close', cleanup);
      result.stream().pipe(response);
    } catch (error) {
      await timelineExports.cleanup(sessionId).catch(() => {});
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  const exportSessionMatch = url.pathname.match(/^\/api\/export\/sessions\/([^/]+)$/);
  if (exportSessionMatch && request.method === 'DELETE') {
    await timelineExports.cleanup(decodeURIComponent(exportSessionMatch[1])).catch(() => {});
    response.writeHead(204, {'Cache-Control': 'no-store'});
    response.end();
    return;
  }

  if (url.pathname === '/api/fal/upload' && request.method === 'POST') {
    try {
      const mimeType = String(request.headers['content-type'] || 'application/octet-stream').split(';')[0];
      if (!/^(image|video)\//i.test(mimeType)) throw new Error('Only image and video assets can be uploaded.');
      const encodedName = String(request.headers['x-file-name'] || 'asset.bin');
      const fileName = decodeURIComponent(encodedName).replace(/[^a-zA-Z0-9._ -]+/g, '-').slice(0, 160) || 'asset.bin';
      const bytes = await readBytes(request);
      const uploadedUrl = await fal.upload(bytes, {fileName, mimeType});
      sendJson(response, 201, {url: uploadedUrl});
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (url.pathname === '/api/style-applications/jobs' && request.method === 'POST') {
    try {
      const body = await readJson(request, 2_000_000);
      sendJson(response, 202, await styleApplications.submitStyleJob(body));
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  const styleJobMatch = url.pathname.match(/^\/api\/style-applications\/jobs\/([^/]+)$/);
  if (styleJobMatch && request.method === 'GET') {
    try {
      const result = await styleApplications.getStyleJob({
        modelId: url.searchParams.get('modelId') || '',
        requestId: decodeURIComponent(styleJobMatch[1]),
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
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

  if (url.pathname === '/api/video/vlm/status' && request.method === 'GET') {
    sendJson(response, 200, videoVlm.status());
    return;
  }

  if (url.pathname === '/api/video/annotate' && request.method === 'POST') {
    try {
      const body = await readJson(request, 8_000_000);
      const result = await videoVlm.annotateFrame(body);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (url.pathname === '/api/video/index' && request.method === 'POST') {
    try {
      const body = await readJson(request, 2_000_000);
      const result = await videoSearch.upsert(body.records);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (url.pathname === '/api/search/video' && request.method === 'GET') {
    try {
      const result = await videoSearch.search(url.searchParams.get('q') || '', {
        limit: url.searchParams.get('limit'),
        projectId: url.searchParams.get('projectId') || null,
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (url.pathname === '/api/search/video/status' && request.method === 'GET') {
    try {
      sendJson(response, 200, await videoSearch.status({
        projectId: url.searchParams.get('projectId') || null,
      }));
    } catch (error) {
      sendJson(response, 500, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (url.pathname === '/api/characters/generate' && request.method === 'POST') {
    try {
      const body = await readJson(request, 16_000_000);
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

  if (url.pathname === '/api/storyboard/stills' && request.method === 'POST') {
    try {
      const body = await readJson(request, 16_000_000);
      sendJson(response, 202, await storyboardGenerations.submitStill(body));
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  const storyboardStillJobMatch = url.pathname.match(/^\/api\/storyboard\/stills\/([^/]+)$/);
  if (storyboardStillJobMatch && request.method === 'GET') {
    const result = await storyboardGenerations.getStillJob(decodeURIComponent(storyboardStillJobMatch[1]));
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === '/api/storyboard/scripts/generate' && request.method === 'POST') {
    try {
      const body = await readJson(request, 4_000_000);
      sendJson(response, 200, await storyboardGenerations.generateScreenplay(body));
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (url.pathname === '/api/storyboard/video-prompts/generate' && request.method === 'POST') {
    try {
      const body = await readJson(request, 4_000_000);
      sendJson(response, 200, await storyboardGenerations.generateVideoPrompt(body));
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (url.pathname === '/api/music/score-direction' && request.method === 'POST') {
    try {
      const body = await readJson(request, 4_000_000);
      sendJson(response, 200, await musicGenerations.generateScoreDirection(body));
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  if (url.pathname === '/api/music/generate' && request.method === 'POST') {
    try {
      const body = await readJson(request, 4_000_000);
      sendJson(response, 202, await musicGenerations.submitScore(body));
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
    return;
  }

  const musicJobMatch = url.pathname.match(/^\/api\/music\/jobs\/([^/]+)$/);
  if (musicJobMatch && request.method === 'GET') {
    const result = await musicGenerations.getScoreJob(decodeURIComponent(musicJobMatch[1]));
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname === '/api/timeline/generate' && request.method === 'POST') {
    try {
      const body = await readJson(request, 16_000_000);
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

  if (url.pathname === '/api/agent/status' && request.method === 'GET') {
    sendJson(response, 200, {
      provider: 'openai-compatible',
      configured: llm.configured,
      model: llm.model,
    });
    return;
  }

  if (url.pathname === '/api/agent/llm' && request.method === 'POST') {
    try {
      const body = await readJson(request, 4_000_000);
      if (!Array.isArray(body.messages)) throw new Error('messages must be an array.');
      const result = await llm.chat({
        messages: body.messages,
        tools: body.tools,
        temperature: body.temperature,
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, {error: error instanceof Error ? error.message : String(error)});
    }
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
