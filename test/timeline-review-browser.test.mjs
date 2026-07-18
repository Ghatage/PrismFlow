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
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The local process may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Local PrismFlow server did not start: ${url}`);
};

const provenance = {
  prompt: 'A fox studies a glowing map',
  modelId: 'local/fake-video-v1',
  seed: 42,
  params: {quality: 'draft'},
  parentAssetId: 'asset-parent',
  derivedMetadata: null,
  characterVersionIds: ['fox-v1'],
};

const acceptedClip = {
  id: 'clip-browser',
  assetId: 'asset-browser',
  sceneId: 'scene-browser',
  trackId: 'V1',
  start: 0,
  duration: 2,
  provenance,
};

const fixture = {
  schemaVersion: 1,
  updatedAt: '2026-07-16T20:00:00.000Z',
  project: {id: 'project-browser', name: 'Review smoke', createdAt: '2026-07-16T20:00:00.000Z', metadata: {aspectRatio: '16:9', frameRate: 30}},
  scenes: [{id: 'scene-browser', name: 'Opening scene', duration: 12, metadata: {}}],
  characters: [],
  mediaAssets: [{
    id: 'asset-browser',
    name: 'Generated fox shot',
    kind: 'image',
    mimeType: 'image/png',
    size: 0,
    duration: 5,
    createdAt: '2026-07-16T20:00:00.000Z',
    source: {type: 'generated', fileName: 'fox.png', lastModified: 0},
    metadata: {},
  }],
  timeline: {
    revision: 0,
    activeSceneId: 'scene-browser',
    duration: 12,
    tracks: [
      {id: 'V1', name: 'Video', kind: 'video', order: 0},
      {id: 'A1', name: 'Audio', kind: 'audio', order: 1},
    ],
    clips: [acceptedClip],
  },
  timelineDiffs: {
    schemaVersion: 1,
    items: [
      {
        id: 'diff-browser-move',
        baseRevision: 0,
        status: 'pending',
        source: 'agent',
        summary: 'Move the opening later',
        operations: [{
          type: 'move',
          clipId: acceptedClip.id,
          proposedClip: null,
          before: acceptedClip,
          after: {...acceptedClip, start: 1},
        }],
        provenance: {},
        createdAt: '2026-07-16T20:00:01.000Z',
        updatedAt: '2026-07-16T20:00:01.000Z',
      },
      {
        id: 'diff-browser-trim',
        baseRevision: 0,
        status: 'pending',
        source: 'user',
        summary: 'Tighten the opening',
        operations: [{
          type: 'trim',
          clipId: acceptedClip.id,
          proposedClip: null,
          before: acceptedClip,
          after: {...acceptedClip, duration: 1},
        }],
        provenance: {},
        createdAt: '2026-07-16T20:00:02.000Z',
        updatedAt: '2026-07-16T20:00:02.000Z',
      },
    ],
  },
};

const regenerationFixture = {
  ...structuredClone(fixture),
  project: {...fixture.project, name: 'Regeneration smoke'},
  timelineDiffs: {schemaVersion: 1, items: []},
};

const staleFixture = {
  ...structuredClone(fixture),
  project: {...fixture.project, name: 'Stale review smoke'},
  timeline: {...fixture.timeline, revision: 1},
  timelineDiffs: {schemaVersion: 1, items: [
    {...fixture.timelineDiffs.items[0], status: 'stale'},
  ]},
};

const staleConflictFixture = {
  ...structuredClone(staleFixture),
  project: {...staleFixture.project, name: 'Stale conflict smoke'},
  timeline: {
    ...staleFixture.timeline,
    clips: [{...staleFixture.timeline.clips[0], start: 2}],
  },
};

const dragFixture = {
  ...structuredClone(fixture),
  project: {...fixture.project, name: 'Ghost drag smoke'},
  timelineDiffs: {schemaVersion: 1, items: [structuredClone(fixture.timelineDiffs.items[0])]},
};

test('reviews, rejects, and accepts ghosts without browser errors', {timeout: 30_000}, async (context) => {
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
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', (response) => {
    if (response.status() >= 400) browserErrors.push(`response: ${response.status()} ${response.url()}`);
  });
  await page.addInitScript((project) => {
    localStorage.setItem('prismflow.project', JSON.stringify(project));
  }, fixture);

  await page.goto(origin, {waitUntil: 'networkidle'});
  await page.locator('[data-action="select-first-diff"]').click();
  assert.equal(await page.locator('[data-review-position]').textContent(), '1 of 2');
  await page.getByRole('button', {name: 'Next proposal'}).click();
  assert.equal(await page.locator('[data-review-position]').textContent(), '2 of 2');
  await page.getByRole('button', {name: 'Preview proposal'}).click();
  assert.equal(await page.locator('[data-player-status]').textContent(), 'Proposal preview');
  const acceptedBeforeExit = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('prismflow.project')).timeline.clips));
  await page.getByRole('button', {name: 'Exit preview'}).click();
  assert.equal(await page.locator('[data-player-status]').textContent(), 'Accepted preview');
  assert.equal(await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('prismflow.project')).timeline.clips)), acceptedBeforeExit);
  await page.getByRole('button', {name: 'Previous proposal'}).click();
  assert.equal(await page.locator('[data-review-position]').textContent(), '1 of 2');
  await page.getByRole('button', {name: 'Preview proposal'}).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-player-status]').textContent(), 'Accepted preview');
  await page.reload({waitUntil: 'networkidle'});
  assert.equal(await page.locator('[data-review-position]').textContent(), '1 of 2');
  await page.locator('[data-ghost-key]').first().focus();
  await page.keyboard.press('Enter');
  await page.getByText('Before provenance').waitFor();
  await page.getByText('After provenance').waitFor();
  await page.locator('[data-action="reject-diff"]').click();
  await assert.doesNotReject(page.locator('[data-ghost-key]').first().waitFor());
  await page.locator('[data-ghost-key]').first().click();
  await page.locator('[data-action="accept-diff"]').click();
  await page.locator('[data-ghost-key]').waitFor({state: 'detached'});

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('prismflow.project')));
  assert.equal(saved.timeline.revision, 1);
  assert.deepEqual(saved.timelineDiffs.items.map((diff) => diff.status), ['rejected', 'accepted']);
  assert.deepEqual(browserErrors, []);
});

test('compares fake variants and selects one through a replacement diff', {timeout: 30_000}, async (context) => {
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
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', (response) => {
    if (response.status() >= 400) browserErrors.push(`response: ${response.status()} ${response.url()}`);
  });
  await page.addInitScript((project) => {
    localStorage.setItem('prismflow.project', JSON.stringify(project));
  }, regenerationFixture);

  await page.goto(`${origin}/?timelineAdapter=fake`, {waitUntil: 'networkidle'});
  await page.locator('[data-clip-id="clip-browser"]').click();
  await page.locator('[data-action="compare-clip-variants"]').click();
  await page.locator('.variant-card').nth(1).waitFor({timeout: 5000});
  assert.equal(await page.locator('.variant-card').count(), 2);
  let saved = await page.evaluate(() => JSON.parse(localStorage.getItem('prismflow.project')));
  assert.equal(saved.mediaAssets.length, 1);
  assert.equal(saved.timelineDiffs.items.length, 0);

  await page.getByRole('button', {name: 'Use this version'}).first().click();
  await page.locator('[data-ghost-key]').first().click();
  await page.locator('[data-action="reject-diff"]').click();
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('prismflow.project')));
  assert.equal(saved.timeline.clips[0].assetId, 'asset-browser');
  assert.equal(saved.timeline.clips[0].provenance.prompt, provenance.prompt);

  await page.locator('[data-clip-id="clip-browser"]').click();
  await page.getByRole('button', {name: 'Use this version'}).first().click();
  await page.locator('[data-ghost-key]').first().click();
  await page.locator('[data-action="accept-diff"]').click();
  saved = await page.evaluate(() => JSON.parse(localStorage.getItem('prismflow.project')));
  assert.notEqual(saved.timeline.clips[0].assetId, 'asset-browser');
  assert.equal(saved.timeline.clips[0].provenance.prompt, provenance.prompt);
  assert.deepEqual(saved.timeline.clips[0].provenance.parentAssetIds, ['asset-browser', 'asset-parent']);
  assert.deepEqual(saved.timeline.clips[0].provenance.characterVersionIds, ['fox-v1']);
  assert.equal(saved.mediaAssets.length, 3);
  assert.deepEqual(browserErrors, []);
});

test('revises a dragged ghost into a new proposal without moving accepted clips', {timeout: 30_000}, async (context) => {
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
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', (response) => { if (response.status() >= 400) browserErrors.push(`response: ${response.status()} ${response.url()}`); });
  await page.addInitScript((project) => localStorage.setItem('prismflow.project', JSON.stringify(project)), dragFixture);

  await page.goto(origin, {waitUntil: 'networkidle'});
  const acceptedBeforeDrag = await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('prismflow.project')).timeline.clips));
  await page.locator('[data-ghost-key]').first().dragTo(page.locator('.video-lane'), {targetPosition: {x: 300, y: 30}});

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('prismflow.project')));
  assert.equal(JSON.stringify(saved.timeline.clips), acceptedBeforeDrag);
  assert.deepEqual(saved.timelineDiffs.items.map((diff) => diff.status), ['rejected', 'pending']);
  assert.equal(saved.timelineDiffs.items[1].provenance.revisedFromDiffId, 'diff-browser-move');
  assert.deepEqual(browserErrors, []);
});

test('rebases a compatible stale proposal and preserves its review history', {timeout: 30_000}, async (context) => {
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
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', (response) => { if (response.status() >= 400) browserErrors.push(`response: ${response.status()} ${response.url()}`); });
  await page.addInitScript((project) => localStorage.setItem('prismflow.project', JSON.stringify(project)), staleFixture);

  await page.goto(origin, {waitUntil: 'networkidle'});
  await page.locator('[data-action="select-first-diff"]').click();
  await page.getByRole('button', {name: 'Rebase proposal'}).click();
  await page.getByRole('button', {name: 'Accept', exact: true}).click();

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('prismflow.project')));
  assert.deepEqual(saved.timelineDiffs.items.map((diff) => diff.status), ['stale', 'accepted']);
  assert.equal(saved.timelineDiffs.items[1].baseRevision, 1);
  assert.equal(saved.timelineDiffs.items[1].provenance.reconciliation.rebasedFromDiffId, 'diff-browser-move');
  assert.equal(saved.timeline.revision, 2);
  assert.deepEqual(browserErrors, []);
});

test('explains an incompatible stale proposal and allows rejection', {timeout: 30_000}, async (context) => {
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
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', (response) => { if (response.status() >= 400) browserErrors.push(`response: ${response.status()} ${response.url()}`); });
  await page.addInitScript((project) => localStorage.setItem('prismflow.project', JSON.stringify(project)), staleConflictFixture);

  await page.goto(origin, {waitUntil: 'networkidle'});
  await page.locator('[data-action="select-first-diff"]').click();
  await page.getByRole('button', {name: 'Rebase proposal'}).click();
  await page.getByRole('alert').getByText('Cannot rebase this proposal').waitFor();
  assert.equal(await page.locator('[data-action="rebase-diff"]').isDisabled(), true);
  await page.locator('[data-action="reject-diff"]').click();
  await page.locator('[data-review-position]').waitFor({state: 'detached'});

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('prismflow.project')));
  assert.equal(saved.timelineDiffs.items[0].status, 'rejected');
  assert.equal(saved.timeline.clips[0].start, 2);
  assert.deepEqual(browserErrors, []);
});
