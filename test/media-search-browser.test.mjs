import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import test from 'node:test';

import {chromium} from 'playwright';

const reservePort = async () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address();
    server.close((error) => error ? reject(error) : resolve(port));
  });
});

const waitForServer = async (url) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Local PrismFlow server did not start: ${url}`);
};

const imageDataUrl = (label) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#e8e8ef"/><text x="8" y="48" font-size="12">${label}</text></svg>`)}`;

const fixture = {
  schemaVersion: 1,
  updatedAt: '2026-07-18T22:00:00.000Z',
  project: {id: 'project-media-search', name: 'Search smoke', createdAt: '2026-07-18T22:00:00.000Z', metadata: {aspectRatio: '16:9', frameRate: 30}},
  scenes: [{id: 'scene-search', name: 'Opening scene', duration: 12, metadata: {actNumber: 1}}],
  characters: [],
  styles: [],
  mediaAssets: Array.from({length: 24}, (_, index) => ({
    id: `image-${index}`,
    name: index === 17 ? 'Storyboard still 18' : `Storyboard still ${index + 1}`,
    kind: 'image',
    mimeType: 'image/svg+xml',
    size: 0,
    duration: 5,
    sceneId: null,
    remoteUrl: imageDataUrl(`Still ${index + 1}`),
    source: {type: 'generated', fileName: `still-${index + 1}.svg`, lastModified: 0},
    metadata: index === 17 ? {description: 'A small black cat watches the moon'} : {},
  })),
  agentWorkspace: {schemaVersion: 1, updatedAt: '2026-07-18T22:00:00.000Z', messages: [], script: {title: 'Search smoke', metadata: {}, beats: []}},
  timeline: {
    revision: 0,
    activeSceneId: 'scene-search',
    duration: 12,
    tracks: [{id: 'V1', name: 'Video', kind: 'video', order: 0}, {id: 'A1', name: 'Audio', kind: 'audio', order: 1}],
    clips: [],
    transitions: [],
  },
  timelineDiffs: {schemaVersion: 1, items: []},
};

test('searches import metadata and keeps crowded imports scrollable above results', {timeout: 30_000}, async (context) => {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {...process.env, PORT: String(port)},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(() => server.kill('SIGTERM'));
  await waitForServer(origin);

  const browser = await chromium.launch({headless: true});
  context.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1200, height: 760}});
  const browserErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  await page.route(`${origin}/api/search/video/status?*`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ready: true, recordCount: 0, videoCount: 0, assets: []}),
  }));
  await page.route(`${origin}/api/search/video?*`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({results: []}),
  }));
  await page.addInitScript((project) => localStorage.setItem('prismflow.project', JSON.stringify(project)), fixture);
  await page.goto(`${origin}/?view=editor`, {waitUntil: 'networkidle'});
  await page.locator('[data-media-hydrated="true"]').waitFor();

  assert.match(await page.locator('[data-video-search-coverage]').textContent(), /Names, prompts, and metadata searched for all 24 imports/);
  const search = page.getByRole('search').getByRole('textbox', {name: 'Search project media'});
  await search.fill('black cat');
  await search.press('Enter');
  const result = page.locator('[data-media-search-asset-id="image-17"]');
  await result.waitFor();
  assert.match(await result.textContent(), /Metadata.*black cat/i);

  const imports = page.locator('.media-imports');
  const results = page.locator('.video-search-results');
  const layout = await imports.evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    bottom: element.getBoundingClientRect().bottom,
  }));
  const resultsTop = await results.evaluate((element) => element.getBoundingClientRect().top);
  assert.equal(layout.overflowY, 'auto');
  assert.ok(layout.scrollHeight > layout.clientHeight);
  assert.ok(resultsTop >= layout.bottom - 1);
  assert.deepEqual(browserErrors, []);
});
