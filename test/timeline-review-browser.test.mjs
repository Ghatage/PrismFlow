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

const createPlaybackFixture = (origin) => {
  const project = structuredClone(regenerationFixture);
  project.project.name = 'Layered playback smoke';
  project.mediaAssets = [
    {id: 'visual-top', name: 'Top visual', kind: 'image', mimeType: 'image/svg+xml', duration: 4, remoteUrl: `${origin}/test-media/top.svg`},
    {id: 'visual-lower', name: 'Lower visual', kind: 'image', mimeType: 'image/svg+xml', duration: 4, remoteUrl: `${origin}/test-media/lower.svg`},
    {id: 'audio-dialogue', name: 'Dialogue', kind: 'audio', mimeType: 'audio/wav', duration: 3, remoteUrl: `${origin}/test-media/dialogue.wav`},
    {id: 'audio-music', name: 'Music', kind: 'audio', mimeType: 'audio/wav', duration: 3, remoteUrl: `${origin}/test-media/music.wav`},
  ];
  project.timeline.tracks = [
    {id: 'V2', name: 'Video 2', kind: 'video', order: 0},
    {id: 'V1', name: 'Video 1', kind: 'video', order: 1},
    {id: 'A1', name: 'Audio 1', kind: 'audio', order: 2},
    {id: 'A2', name: 'Audio 2', kind: 'audio', order: 3},
  ];
  project.timeline.clips = [
    {id: 'clip-lower', assetId: 'visual-lower', sceneId: 'scene-browser', trackId: 'V1', start: 0, duration: 3},
    {id: 'clip-top', assetId: 'visual-top', sceneId: 'scene-browser', trackId: 'V2', start: 0, duration: 1},
    {id: 'clip-dialogue', assetId: 'audio-dialogue', sceneId: 'scene-browser', trackId: 'A1', start: 0, duration: 2},
    {id: 'clip-music', assetId: 'audio-music', sceneId: 'scene-browser', trackId: 'A2', start: 0.5, duration: 2.5},
  ];
  return project;
};

const extendedProposalFixture = (() => {
  const project = structuredClone(regenerationFixture);
  const proposedClip = {...acceptedClip, id: 'clip-proposed-tail', start: 14, duration: 2};
  project.project.name = 'Extended proposal smoke';
  project.timelineDiffs.items = [{
    id: 'diff-proposed-tail',
    baseRevision: 0,
    status: 'pending',
    source: 'agent',
    summary: 'Add an ending beyond the accepted timeline',
    operations: [{type: 'add', clipId: proposedClip.id, proposedClip, before: null, after: proposedClip}],
    provenance: {},
    createdAt: '2026-07-16T20:00:03.000Z',
    updatedAt: '2026-07-16T20:00:03.000Z',
  }];
  return project;
})();

const createSilentWav = (seconds = 4) => {
  const sampleRate = 8000;
  const bytesPerSample = 2;
  const dataSize = sampleRate * bytesPerSample * seconds;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
  wav.writeUInt16LE(bytesPerSample, 32);
  wav.writeUInt16LE(bytesPerSample * 8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
};

const waitForHydration = (page) => page.locator('[data-media-hydrated="true"]').waitFor();

const readPersistedProject = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const openRequest = indexedDB.open('prismflow.project');
  openRequest.onerror = () => reject(openRequest.error || new Error('Could not open PrismFlow database.'));
  openRequest.onsuccess = () => {
    const database = openRequest.result;
    const request = database.transaction('projects', 'readonly').objectStore('projects').get('project-browser');
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

test('keeps the agent rail visible and toggles a run pane from its icon', {timeout: 30_000}, async (context) => {
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
  await page.route(`${origin}/api/agent/status`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({provider: 'openai-compatible', configured: true, model: 'test-model'}),
  }));
  const llmRequests = [];
  await page.route(`${origin}/api/agent/llm`, async (route) => {
    llmRequests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({choices: [{message: {role: 'assistant', content: 'Reviewed the timeline.'}}]}),
    });
  });
  await page.addInitScript((project) => {
    localStorage.setItem('prismflow.project', JSON.stringify(project));
  }, regenerationFixture);

  await page.goto(`${origin}/?view=editor`, {waitUntil: 'networkidle'});
  await waitForHydration(page);
  const rail = page.locator('.agent-rail');
  assert.equal(await rail.isVisible(), true);
  assert.equal(await rail.evaluate((element) => Math.round(element.getBoundingClientRect().width)), 44);
  assert.equal(await page.locator('[data-action="toggle-agent-rail"]').count(), 0);

  await page.locator('.timeline-clip[data-clip-id="clip-browser"]').click();
  await page.getByRole('button', {name: 'Launch AI editing agent'}).click();
  const promptModal = page.locator('.agent-prompt-modal');
  assert.equal(await promptModal.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal(await promptModal.locator('[data-agent-context-clip-id="clip-browser"]').count(), 1);
  assert.match(await promptModal.locator('.agent-clip-context').textContent(), /V1.*00:00\.00–00:02\.00/s);
  const prompt = page.locator('#agentPromptInput');
  await prompt.fill('Review the current cut.');
  await prompt.press('Enter');

  const runIcon = page.locator('[data-agent-run-id]');
  await runIcon.waitFor();
  const runCard = page.locator('.agent-run-card');
  await runCard.waitFor();
  assert.equal(await runCard.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
  assert.equal(await runCard.locator('[data-agent-context-clip-id="clip-browser"]').count(), 1);
  assert.equal(llmRequests.length, 1);
  assert.match(llmRequests[0].messages.find((message) => message.role === 'user').content, /"clipId":"clip-browser"/);
  await runIcon.click();
  await page.locator('.agent-run-card').waitFor({state: 'detached'});
  assert.equal(await rail.isVisible(), true);
  assert.equal(await rail.evaluate((element) => Math.round(element.getBoundingClientRect().width)), 44);
  await runIcon.click();
  await page.locator('.agent-run-card').waitFor();
  assert.deepEqual(browserErrors, []);
});

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

  await page.goto(`${origin}/?view=editor`, {waitUntil: 'networkidle'});
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

test('selecting a clip preserves the player and Backspace deletes it', {timeout: 30_000}, async (context) => {
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

  await page.goto(`${origin}/?timelineAdapter=fake&view=editor`, {waitUntil: 'networkidle'});
  await waitForHydration(page);
  await page.keyboard.press('Backspace');
  assert.equal(await page.locator('.timeline-clip').count(), 1);
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

  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'keyboard-editing-test';
    input.value = 'draft';
    document.body.append(input);
  });
  await page.locator('#keyboard-editing-test').focus();
  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  assert.equal(await page.locator('#keyboard-editing-test').inputValue(), 'draf');
  assert.equal(await page.locator('.timeline-clip').count(), 1);
  await page.locator('#keyboard-editing-test').evaluate((element) => element.remove());

  await page.locator('[data-clip-id="clip-browser"]').click();
  await page.keyboard.press('Backspace');
  await page.locator('[data-clip-id="clip-browser"]').waitFor({state: 'detached'});
  const saved = await readPersistedProject(page);
  assert.deepEqual(saved.timeline.clips, []);
  assert.equal(saved.timeline.revision, 1);
  assert.deepEqual(browserErrors, []);
});

test('plays the topmost visual and mixes every active audio track', {timeout: 30_000}, async (context) => {
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
  await page.route(`${origin}/test-media/**`, async (route) => {
    const url = route.request().url();
    if (url.endsWith('.wav')) {
      await route.fulfill({status: 200, contentType: 'audio/wav', body: createSilentWav()});
      return;
    }
    const color = url.endsWith('top.svg') ? '#ff7d9c' : '#3ee6c2';
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${color}"/></svg>`,
    });
  });
  await page.addInitScript((project) => {
    localStorage.setItem('prismflow.project', JSON.stringify(project));
    const nativePlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play() {
      this.dataset.playRequested = 'true';
      return nativePlay.call(this);
    };
  }, createPlaybackFixture(origin));

  await page.goto(`${origin}/?view=editor`, {waitUntil: 'networkidle'});
  await waitForHydration(page);
  assert.equal(await page.locator('#previewImage').getAttribute('src'), `${origin}/test-media/top.svg`);
  assert.deepEqual(await page.locator('#previewAudioMix audio').evaluateAll((elements) => elements.map((element) => element.dataset.clipId)), ['clip-dialogue']);

  await page.locator('#timelineRuler').click({position: {x: 0.75 * 88, y: 10}});
  assert.equal(await page.locator('#previewImage').getAttribute('src'), `${origin}/test-media/top.svg`);
  assert.deepEqual(await page.locator('#previewAudioMix audio').evaluateAll((elements) => elements.map((element) => element.dataset.clipId)), ['clip-dialogue', 'clip-music']);

  await page.locator('[data-action="toggle-play"]').click();
  assert.deepEqual(await page.locator('#previewAudioMix audio').evaluateAll((elements) => elements.map((element) => element.dataset.playRequested)), ['true', 'true']);
  await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('#previewAudioMix audio')];
    return audio.length === 2 && audio.every((element) => !element.paused);
  });
  await page.waitForFunction((lowerUrl) => document.querySelector('#previewImage')?.src === lowerUrl, `${origin}/test-media/lower.svg`);
  await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('#previewAudioMix audio')];
    return audio.length === 1 && audio[0].dataset.clipId === 'clip-music';
  });
  await page.locator('#timelineRuler').click({position: {x: 5 * 88, y: 10}});
  await page.waitForTimeout(120);
  assert.match(await page.locator('#playerCurrent').textContent(), /^00:05\./);
  await page.locator('[data-action="toggle-play"]').click();

  await page.locator('#timelineRuler').click({position: {x: 1.5 * 88, y: 10}});
  assert.equal(await page.locator('#previewImage').getAttribute('src'), `${origin}/test-media/lower.svg`);
  assert.equal(await page.locator('#previewAudioMix audio').count(), 2);

  await page.locator('#timelineRuler').click({position: {x: 2.25 * 88, y: 10}});
  assert.deepEqual(await page.locator('#previewAudioMix audio').evaluateAll((elements) => elements.map((element) => element.dataset.clipId)), ['clip-music']);

  await page.locator('#timelineRuler').click({position: {x: 3.5 * 88, y: 10}});
  assert.equal(await page.locator('#previewAudioMix audio').count(), 0);
  assert.equal(await page.locator('#previewImage').evaluate((element) => getComputedStyle(element).display), 'none');
  assert.equal(await page.locator('#previewVideo').evaluate((element) => getComputedStyle(element).display), 'none');
  assert.deepEqual(browserErrors, []);
});

test('extends playback duration for a proposal beyond the accepted timeline', {timeout: 30_000}, async (context) => {
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
  await page.addInitScript((project) => localStorage.setItem('prismflow.project', JSON.stringify(project)), extendedProposalFixture);

  await page.goto(`${origin}/?view=editor`, {waitUntil: 'networkidle'});
  await waitForHydration(page);
  await page.locator('[data-action="select-first-diff"]').click();
  await page.getByRole('button', {name: 'Preview proposal'}).click();
  assert.equal(await page.locator('#playerCurrent').textContent(), '00:14.00');
  assert.equal(await page.locator('#playerDuration').textContent(), '00:18.00');

  await page.locator('[data-action="toggle-play"]').click();
  await page.waitForTimeout(120);
  assert.match(await page.locator('#playerCurrent').textContent(), /^00:14\./);
  await page.locator('[data-action="toggle-play"]').click();
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

  await page.goto(`${origin}/?view=editor`, {waitUntil: 'networkidle'});
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

  await page.goto(`${origin}/?view=editor`, {waitUntil: 'networkidle'});
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

  await page.goto(`${origin}/?view=editor`, {waitUntil: 'networkidle'});
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

  await page.goto(`${origin}/?view=editor`, {waitUntil: 'networkidle'});
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
  assert.equal(await page.locator('.timeline-body').evaluate((element) => element.scrollHeight <= element.clientHeight), true);
  await page.locator('[data-action="add-track"]').click();
  assert.equal(await page.getByRole('menu').count(), 1);
  await page.getByRole('menuitem', {name: 'Video'}).click();
  assert.equal(await page.locator('.track-lane').count(), 3);
  assert.equal(await page.locator('.track-lane').first().getAttribute('data-track-id'), 'V2');

  await page.locator('[data-action="add-track"]').click();
  await page.getByRole('menuitem', {name: 'Audio'}).click();
  assert.equal(await page.locator('.track-lane').count(), 4);
  assert.equal(await page.locator('.track-lane').last().getAttribute('data-track-id'), 'A2');
  const trackScroll = await page.locator('.timeline-body').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    const body = element.getBoundingClientRect();
    const label = element.querySelector('.track-label:last-child').getBoundingClientRect();
    const lanes = element.querySelectorAll('.track-lane');
    const lane = lanes[lanes.length - 1].getBoundingClientRect();
    return {
      overflowY: getComputedStyle(element).overflowY,
      hasOverflow: element.scrollHeight > element.clientHeight,
      scrollTop: element.scrollTop,
      lastTrackVisible: label.bottom <= body.bottom + 1 && lane.bottom <= body.bottom + 1,
      aligned: Math.abs(label.top - lane.top) < 1 && Math.abs(label.bottom - lane.bottom) < 1,
    };
  });
  assert.equal(trackScroll.overflowY, 'auto');
  assert.equal(trackScroll.hasOverflow, true);
  assert.equal(trackScroll.lastTrackVisible, true);
  assert.equal(trackScroll.aligned, true);
  assert.ok(trackScroll.scrollTop > 0);

  await page.locator('[data-track-id="A2"]').click({position: {x: 400, y: 30}});
  const restoredScrollTop = await page.locator('.timeline-body').evaluate((element) => element.scrollTop);
  assert.ok(Math.abs(restoredScrollTop - trackScroll.scrollTop) < 1);
  assert.notEqual(await page.locator('#playerCurrent').textContent(), '00:00.00');

  assert.deepEqual(browserErrors, []);
});
