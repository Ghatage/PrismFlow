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

const waitForHydration = (page) => page.locator('[data-media-hydrated="true"]').waitFor();

const readPersistedProject = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const openRequest = indexedDB.open('prismflow.project');
  openRequest.onerror = () => reject(openRequest.error || new Error('Could not open PrismFlow database.'));
  openRequest.onsuccess = () => {
    const database = openRequest.result;
    const request = database.transaction('projects', 'readonly').objectStore('projects').get('current');
    request.onerror = () => reject(request.error || new Error('Could not read PrismFlow project.'));
    request.onsuccess = () => {
      database.close();
      resolve(request.result?.project || null);
    };
  };
}));

const hasModelPricingStore = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const openRequest = indexedDB.open('prismflow.project');
  openRequest.onerror = () => reject(openRequest.error || new Error('Could not open PrismFlow database.'));
  openRequest.onsuccess = () => {
    const database = openRequest.result;
    const present = database.objectStoreNames.contains('modelPricing');
    database.close();
    resolve(present);
  };
}));

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
  await waitForHydration(page);
  assert.equal(await hasModelPricingStore(page), true);
  await page.locator('[data-action="select-first-diff"]').click();
  assert.equal(await page.locator('[data-review-position]').textContent(), '1 of 2');
  await page.getByRole('button', {name: 'Next proposal'}).click();
  assert.equal(await page.locator('[data-review-position]').textContent(), '2 of 2');
  await page.getByRole('button', {name: 'Preview proposal'}).click();
  assert.equal(await page.locator('[data-player-status]').textContent(), 'Proposal preview');
  const acceptedBeforeExit = JSON.stringify((await readPersistedProject(page)).timeline.clips);
  await page.getByRole('button', {name: 'Exit preview'}).click();
  assert.equal(await page.locator('[data-player-status]').textContent(), 'Accepted preview');
  assert.equal(JSON.stringify((await readPersistedProject(page)).timeline.clips), acceptedBeforeExit);
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

  const saved = await readPersistedProject(page);
  assert.equal(saved.timeline.revision, 1);
  assert.deepEqual(saved.timelineDiffs.items.map((diff) => diff.status), ['rejected', 'accepted']);
  assert.deepEqual(browserErrors, []);
});

test('selecting a clip does not render a context panel over the player', {timeout: 30_000}, async (context) => {
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
  await waitForHydration(page);
  const before = await page.locator('.preview-frame').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {width: box.width, height: box.height};
  });
  await page.locator('[data-clip-id="clip-browser"]').click();
  assert.equal(await page.locator('.clip-context-panel').count(), 0);
  assert.equal(await page.locator('.context-panel').count(), 0);
  const after = await page.locator('.preview-frame').evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {width: box.width, height: box.height};
  });
  assert.deepEqual(after, before);
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
  await waitForHydration(page);
  const acceptedBeforeDrag = JSON.stringify((await readPersistedProject(page)).timeline.clips);
  await page.locator('[data-ghost-key]').first().dragTo(page.locator('.video-lane'), {targetPosition: {x: 300, y: 30}});

  const saved = await readPersistedProject(page);
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
  await waitForHydration(page);
  await page.locator('[data-action="select-first-diff"]').click();
  await page.getByRole('button', {name: 'Rebase proposal'}).click();
  await page.getByRole('button', {name: 'Accept', exact: true}).click();

  const saved = await readPersistedProject(page);
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
  await waitForHydration(page);
  await page.locator('[data-action="select-first-diff"]').click();
  await page.getByRole('button', {name: 'Rebase proposal'}).click();
  await page.getByRole('alert').getByText('Cannot rebase this proposal').waitFor();
  assert.equal(await page.locator('[data-action="rebase-diff"]').isDisabled(), true);
  await page.locator('[data-action="reject-diff"]').click();
  await page.locator('[data-review-position]').waitFor({state: 'detached'});

  const saved = await readPersistedProject(page);
  assert.equal(saved.timelineDiffs.items[0].status, 'rejected');
  assert.equal(saved.timeline.clips[0].start, 2);
  assert.deepEqual(browserErrors, []);
});

test('keeps the player blank until a playable timeline clip is active', {timeout: 30_000}, async (context) => {
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

  await page.goto(origin, {waitUntil: 'networkidle'});
  await waitForHydration(page);
  assert.equal(await page.locator('#emptyPreview').count(), 0);
  assert.equal(await page.locator('.media-dropzone').count(), 0);
  assert.equal(await page.locator('.media-add-card').count(), 1);
  assert.equal(await page.locator('.media-add-card').evaluate((element) => element.getBoundingClientRect().width === element.getBoundingClientRect().height), true);
  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.locator('.media-add-card').click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'prismflow-sample.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#6d4bd5"/></svg>'),
  });
  const mediaCards = page.locator('.media-card');
  await mediaCards.first().waitFor();
  assert.equal(await mediaCards.count(), 1);
  await page.evaluate(() => {
    const target = document.querySelector('[data-dropzone="media"]');
    const transfer = new DataTransfer();
    transfer.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><circle cx="90" cy="90" r="80" fill="#42b9af"/></svg>'], 'dragged.svg', {type: 'image/svg+xml'}));
    target.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: transfer}));
  });
  await mediaCards.filter({hasText: 'dragged.svg'}).waitFor();
  assert.equal(await mediaCards.count(), 2);
  await mediaCards.first().dragTo(page.locator('.video-lane'), {targetPosition: {x: 0, y: 30}});
  assert.equal(await page.locator('.timeline-clip').count(), 1);
  const clip = page.locator('.timeline-clip').first();
  const clipBox = await clip.boundingBox();
  const grabX = clipBox.x + clipBox.width * 0.65;
  const targetX = grabX + 140;
  const grabY = clipBox.y + clipBox.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(targetX, grabY, {steps: 8});
  const previewLeft = await clip.evaluate((element) => Number.parseFloat(element.style.left));
  assert.ok(previewLeft > 0);
  await page.mouse.up();
  const committedLeft = await page.locator('.timeline-clip').first().evaluate((element) => Number.parseFloat(element.style.left));
  assert.ok(Math.abs(committedLeft - previewLeft) < 1);
  assert.equal(await page.locator('.clip-handle.right').evaluate((element) => getComputedStyle(element).cursor), 'ew-resize');
  const widthBeforeTrim = await page.locator('.timeline-clip').first().evaluate((element) => Number.parseFloat(element.style.width));
  const rightHandleBox = await page.locator('.clip-handle.right').boundingBox();
  await page.mouse.move(rightHandleBox.x + rightHandleBox.width / 2, rightHandleBox.y + rightHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rightHandleBox.x - 88, rightHandleBox.y + rightHandleBox.height / 2, {steps: 6});
  await page.mouse.up();
  const widthAfterRightTrim = await page.locator('.timeline-clip').first().evaluate((element) => Number.parseFloat(element.style.width));
  assert.ok(widthAfterRightTrim < widthBeforeTrim);
  const leftHandleBox = await page.locator('.clip-handle.left').boundingBox();
  await page.mouse.move(leftHandleBox.x + leftHandleBox.width / 2, leftHandleBox.y + leftHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(leftHandleBox.x + 44, leftHandleBox.y + leftHandleBox.height / 2, {steps: 6});
  await page.mouse.up();
  const widthAfterLeftTrim = await page.locator('.timeline-clip').first().evaluate((element) => Number.parseFloat(element.style.width));
  assert.ok(widthAfterLeftTrim < widthAfterRightTrim);
  await page.waitForTimeout(100);
  await page.evaluate(() => localStorage.clear());

  await page.reload({waitUntil: 'networkidle'});
  await waitForHydration(page);
  assert.equal(await page.locator('.timeline-clip').count(), 1);
  assert.match(await page.locator('.media-card-copy span').first().textContent(), /image · still/);
  const reloadedClipStart = await page.locator('.timeline-clip').first().evaluate((element) => Number.parseFloat(element.style.left));
  const reloadedClipWidth = await page.locator('.timeline-clip').first().evaluate((element) => Number.parseFloat(element.style.width));
  await page.locator('.video-lane').click({position: {x: reloadedClipStart + reloadedClipWidth / 2, y: 70}});
  await page.locator('[data-action="split"]').click();
  assert.equal(await page.locator('.timeline-clip').count(), 2);
  await page.locator('.video-lane').click({position: {x: reloadedClipStart + 2, y: 70}});
  await page.locator('[data-action="toggle-play"]').click();
  await page.waitForTimeout(180);

  assert.equal(await page.locator('#emptyPreview').count(), 0);
  assert.equal(await page.locator('#previewImage').evaluate((element) => getComputedStyle(element).display), 'block');

  assert.equal(await page.locator('.track-lane').count(), 2);
  await page.locator('[data-action="add-track"]').click();
  assert.equal(await page.getByRole('menu').count(), 1);
  await page.getByRole('menuitem', {name: 'Video'}).click();
  assert.equal(await page.locator('.track-lane').count(), 3);
  assert.equal(await page.locator('.track-lane').first().getAttribute('data-track-id'), 'V2');

  await page.locator('[data-action="add-track"]').click();
  await page.getByRole('menuitem', {name: 'Audio'}).click();
  assert.equal(await page.locator('.track-lane').count(), 4);
  assert.equal(await page.locator('.track-lane').last().getAttribute('data-track-id'), 'A2');

  assert.deepEqual(browserErrors, []);
});
