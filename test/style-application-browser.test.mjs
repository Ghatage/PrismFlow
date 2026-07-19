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

const readPersistedProject = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const openRequest = indexedDB.open('prismflow.project');
  openRequest.onerror = () => reject(openRequest.error);
  openRequest.onsuccess = () => {
    const database = openRequest.result;
    const request = database.transaction('projects', 'readonly').objectStore('projects').get('project-style-browser');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { database.close(); resolve(request.result?.project || null); };
  };
}));

const createFixture = (origin) => ({
  schemaVersion: 1,
  updatedAt: '2026-07-18T19:00:00.000Z',
  project: {id: 'project-style-browser', name: 'Style application smoke', createdAt: '2026-07-18T19:00:00.000Z', metadata: {aspectRatio: '16:9', frameRate: 30}},
  scenes: [{id: 'scene-style-browser', name: 'Opening scene', duration: 12, metadata: {}}],
  characters: [],
  styles: [{
    id: 'style-ink', name: 'Ink wash', status: 'ready', activeVersionId: 'style-ink-v1', lockedVersionId: null,
    versions: [{id: 'style-ink-v1', referenceAssetIds: ['asset-style-reference'], prompt: '', modelId: 'local/manual', seed: null, params: {}, parentAssetIds: ['asset-style-reference'], createdAt: '2026-07-18T19:00:00.000Z'}],
  }],
  mediaAssets: [
    {id: 'asset-source-a', name: 'Source A', kind: 'image', mimeType: 'image/svg+xml', duration: 4, remoteUrl: `${origin}/test-media/source-a.svg`},
    {id: 'asset-source-b', name: 'Source B', kind: 'image', mimeType: 'image/svg+xml', duration: 4, remoteUrl: `${origin}/test-media/source-b.svg`},
    {id: 'asset-style-reference', name: 'Ink reference', kind: 'image', mimeType: 'image/svg+xml', duration: 4, remoteUrl: `${origin}/test-media/style.svg`},
  ],
  timeline: {
    revision: 0,
    activeSceneId: 'scene-style-browser',
    duration: 12,
    tracks: [{id: 'V1', name: 'Video', kind: 'video', order: 0}, {id: 'A1', name: 'Audio', kind: 'audio', order: 1}],
    clips: [
      {id: 'clip-style-a', assetId: 'asset-source-a', sceneId: 'scene-style-browser', trackId: 'V1', start: 0, duration: 4},
      {id: 'clip-style-b', assetId: 'asset-source-b', sceneId: 'scene-style-browser', trackId: 'V1', start: 5, duration: 4},
    ],
    transitions: [],
  },
  timelineDiffs: {schemaVersion: 1, items: []},
});

test('multi-selects clips, applies a style, reviews stacked ghosts, and preserves imports on rejection', {timeout: 40_000}, async (context) => {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.mjs'], {cwd: process.cwd(), env: {...process.env, PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe']});
  context.after(() => server.kill('SIGTERM'));
  await waitForServer(origin);

  const browser = await chromium.launch({headless: true});
  context.after(() => browser.close());
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', (response) => { if (response.status() >= 400) browserErrors.push(`response: ${response.status()} ${response.url()}`); });

  await page.route(`${origin}/test-media/**`, (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#667788"/></svg>',
  }));
  let uploadId = 0;
  await page.route(`${origin}/api/fal/upload`, (route) => route.fulfill({
    status: 201, contentType: 'application/json', body: JSON.stringify({url: `https://uploads.example.test/asset-${++uploadId}.png`}),
  }));
  let requestId = 0;
  await page.route(`${origin}/api/style-applications/jobs**`, async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      assert.equal(body.stage, 'image-style');
      assert.equal(body.input.referenceImageUrls.length, 1);
      await route.fulfill({status: 202, contentType: 'application/json', body: JSON.stringify({requestId: `styled-${++requestId}`, modelId: 'fal-ai/nano-banana-2/edit'})});
      return;
    }
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({
      status: 'completed', modelId: 'fal-ai/nano-banana-2/edit',
      asset: {url: `https://fal.media/${id}.png`, mimeType: 'image/png', duration: 4},
      source: {provider: 'fal'},
    })});
  });
  await page.route('https://fal.media/**', (route) => route.fulfill({
    status: 200, contentType: 'image/png', body: Buffer.from('89504e470d0a1a0a', 'hex'),
  }));
  await page.addInitScript((project) => localStorage.setItem('prismflow.project', JSON.stringify(project)), createFixture(origin));

  await page.goto(`${origin}/?view=editor`, {waitUntil: 'networkidle'});
  await page.locator('[data-media-hydrated="true"]').waitFor();
  await page.locator('.timeline-clip[data-clip-id="clip-style-a"]').click();
  await page.locator('.timeline-clip[data-clip-id="clip-style-b"]').click({modifiers: ['Shift']});
  assert.equal(await page.locator('.timeline-clip.selected').count(), 2);
  await page.locator('.timeline-clip[data-clip-id="clip-style-a"]').click();
  assert.equal(await page.locator('.timeline-clip.selected').count(), 1);
  await page.locator('.timeline-clip[data-clip-id="clip-style-b"]').click({modifiers: ['Meta']});
  assert.equal(await page.locator('.timeline-clip.selected').count(), 2);

  await page.locator('.timeline-clip[data-clip-id="clip-style-b"]').click({button: 'right'});
  await page.getByRole('menuitem', {name: 'Apply Style to 2 clips'}).click();
  await page.getByRole('heading', {name: 'Restyle 2 selected clips'}).waitFor();
  assert.equal(await page.locator('.style-clip-list.compact .style-clip-row').count(), 2);
  assert.match(await page.locator('.style-model-summary').textContent(), /Kling O3 Edit · Standard/);
  await page.getByRole('button', {name: 'Apply Ink wash'}).click();

  await page.locator('.style-application-ghost').first().waitFor({timeout: 12_000});
  assert.equal(await page.locator('.style-application-ghost').count(), 2);
  assert.equal(await page.locator('.media-card').count(), 5);
  const stacked = await page.evaluate(() => {
    const ghost = document.querySelector('.style-application-ghost').getBoundingClientRect();
    const clip = document.querySelector('.timeline-clip[data-clip-id="clip-style-a"]').getBoundingClientRect();
    const lane = document.querySelector('[data-track-id="V1"]').getBoundingClientRect();
    return {ghostAbove: ghost.bottom < clip.top, laneHeight: lane.height};
  });
  assert.equal(stacked.ghostAbove, true);
  assert.equal(stacked.laneHeight, 139);

  await page.locator('[data-action="close-style-application-modal"]').last().click();
  await page.locator('.style-application-ghost').first().click();
  await page.getByRole('button', {name: 'Accept', exact: true}).click();
  await page.locator('.style-application-ghost').first().click();
  await page.getByRole('button', {name: 'Reject', exact: true}).click();
  assert.equal(await page.locator('.style-application-ghost').count(), 0);
  assert.equal(await page.locator('.media-card').count(), 5);

  await page.getByRole('button', {name: /Styles/}).click();
  await page.locator('[data-style-id="style-ink"]').click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', {name: 'Delete'}).click();
  const saved = await readPersistedProject(page);
  assert.equal(saved.styles.length, 0);
  assert.equal(saved.mediaAssets.length, 5);
  assert.deepEqual(saved.timeline.clips[0].provenance.styleVersionIds, []);
  assert.deepEqual(browserErrors, []);
});
