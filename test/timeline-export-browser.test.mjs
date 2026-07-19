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
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Local PrismFlow server did not start: ${url}`);
};

test('Export uploads current timeline assets and downloads output.mp4', {timeout: 30_000}, async (context) => {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(), env: {...process.env, PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(() => server.kill('SIGTERM'));
  await waitForServer(origin);

  const browser = await chromium.launch({headless: true});
  context.after(() => browser.close());
  const page = await browser.newPage({acceptDownloads: true});
  const browserErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));

  const project = {
    schemaVersion: 1,
    updatedAt: '2026-07-19T18:00:00.000Z',
    project: {id: 'project-export-browser', name: 'Export smoke', createdAt: '2026-07-19T18:00:00.000Z', metadata: {}},
    scenes: [{id: 'scene-export', name: 'Scene', duration: 1, metadata: {}}],
    characters: [], styles: [],
    mediaAssets: [{
      id: 'still', name: 'Still.svg', kind: 'image', mimeType: 'image/svg+xml', duration: 1,
      remoteUrl: `${origin}/test-media/still.svg`,
    }],
    timeline: {
      revision: 0, activeSceneId: 'scene-export', duration: 1,
      tracks: [{id: 'V1', name: 'Video', kind: 'video', order: 0}, {id: 'A1', name: 'Audio', kind: 'audio', order: 1}],
      clips: [{id: 'still-clip', assetId: 'still', sceneId: 'scene-export', trackId: 'V1', start: 0, duration: 1, sourceStart: 0}],
      transitions: [],
    },
    timelineDiffs: {schemaVersion: 1, items: []},
  };
  await page.addInitScript((value) => localStorage.setItem('prismflow.project', JSON.stringify(value)), project);
  await page.route(`${origin}/test-media/still.svg`, (route) => route.fulfill({
    status: 200, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#345"/></svg>',
  }));

  let manifest = null;
  let uploadCount = 0;
  await page.route(`${origin}/api/export/sessions`, async (route) => {
    manifest = route.request().postDataJSON().manifest;
    await route.fulfill({status: 201, contentType: 'application/json', body: JSON.stringify({sessionId: 'browser-session'})});
  });
  await page.route(`${origin}/api/export/sessions/browser-session/assets/**`, async (route) => {
    uploadCount += 1;
    await route.fulfill({status: 201, contentType: 'application/json', body: JSON.stringify({ok: true})});
  });
  await page.route(`${origin}/api/export/sessions/browser-session/render`, (route) => route.fulfill({
    status: 200, contentType: 'video/mp4', body: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]),
  }));
  await page.route(`${origin}/api/export/sessions/browser-session`, (route) => route.fulfill({status: 204, body: ''}));

  await page.goto(`${origin}/?view=editor`, {waitUntil: 'networkidle'});
  await page.locator('[data-media-hydrated="true"]').waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Export'}).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'output.mp4');
  await page.getByText('Exported output.mp4 with timeline video and mixed audio.').waitFor();
  assert.equal(uploadCount, 1);
  assert.equal(manifest.projectId, 'project-export-browser');
  assert.deepEqual(manifest.clips.map((clip) => clip.id), ['still-clip']);
  assert.deepEqual(browserErrors, []);
});
