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

const irisDefinition = {
  key: 'custom-iris-open',
  label: 'Iris open',
  glyph: '◎',
  defaultDuration: 1,
  mode: 'blend',
  tracks: [
    {target: 'layerB', property: 'opacity', keyframes: [{at: 0, value: '1'}, {at: 1, value: '1'}]},
    {target: 'layerB', property: 'clipPath', keyframes: [{at: 0, value: 'circle(0% at 50% 50%)'}, {at: 1, value: 'circle(75% at 50% 50%)'}]},
  ],
};

const createFixture = (origin) => ({
  schemaVersion: 1,
  updatedAt: '2026-07-16T20:00:00.000Z',
  project: {id: 'project-transitions', name: 'Transitions smoke', createdAt: '2026-07-16T20:00:00.000Z', metadata: {aspectRatio: '16:9', frameRate: 30}},
  scenes: [{id: 'scene-transitions', name: 'Opening scene', duration: 12, metadata: {}}],
  characters: [],
  customTransitions: [irisDefinition],
  mediaAssets: [
    {id: 'visual-a', name: 'First shot', kind: 'image', mimeType: 'image/svg+xml', duration: 4, remoteUrl: `${origin}/test-media/top.svg`},
    {id: 'visual-b', name: 'Second shot', kind: 'image', mimeType: 'image/svg+xml', duration: 4, remoteUrl: `${origin}/test-media/lower.svg`},
  ],
  timeline: {
    revision: 0,
    activeSceneId: 'scene-transitions',
    duration: 12,
    tracks: [
      {id: 'V1', name: 'Video', kind: 'video', order: 0},
      {id: 'A1', name: 'Audio', kind: 'audio', order: 1},
    ],
    clips: [
      {id: 'clip-a', assetId: 'visual-a', sceneId: 'scene-transitions', trackId: 'V1', start: 0, duration: 2},
      {id: 'clip-b', assetId: 'visual-b', sceneId: 'scene-transitions', trackId: 'V1', start: 2, duration: 2},
    ],
    transitions: [
      {id: 'transition-iris', type: 'custom-iris-open', trackId: 'V1', fromClipId: 'clip-a', toClipId: 'clip-b', duration: 1},
    ],
  },
  timelineDiffs: {schemaVersion: 1, items: []},
});

const generatedDefinition = {
  key: 'diagonal-sweep',
  label: 'placeholder',
  glyph: '◩',
  defaultDuration: 0.9,
  mode: 'blend',
  tracks: [
    {target: 'layerB', property: 'opacity', keyframes: [{at: 0, value: '1'}, {at: 1, value: '1'}]},
    {target: 'layerB', property: 'clipPath', keyframes: [{at: 0, value: 'polygon(0% 0%, 0% 0%, 0% 100%, 0% 100%)'}, {at: 1, value: 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)'}]},
  ],
};

test('renders a custom transition in the preview and creates one from a prompt', {timeout: 30_000}, async (context) => {
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
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  await page.route(`${origin}/api/agent/status`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({provider: 'openai-compatible', configured: true, model: 'test-model'}),
  }));
  await page.route(`${origin}/api/agent/llm`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({choices: [{message: {role: 'assistant', content: '```json\n' + JSON.stringify(generatedDefinition) + '\n```'}}]}),
  }));
  await page.addInitScript((project) => {
    localStorage.setItem('prismflow.project', JSON.stringify(project));
  }, createFixture(origin));
  await page.goto(origin, {waitUntil: 'networkidle'});
  await page.locator('[data-media-hydrated="true"]').waitFor();

  // Panel: built-ins, the fixture's custom card, and the AI add card.
  await page.locator('[data-tab="transitions"]').click();
  assert.equal(await page.locator('.transition-card[data-transition-type]').count(), 7);
  assert.equal(await page.locator('.transition-card.custom').count(), 1);
  await page.locator('.transition-card.add-card').waitFor();

  // The timeline marker uses the custom definition's glyph and label.
  const marker = page.locator('[data-transition-id="transition-iris"]');
  assert.match(await marker.getAttribute('aria-label'), /Iris open/);

  // Scrub into the blend window and confirm the generic interpreter drives layer B.
  const tickScale = await page.locator('#timelineRuler .tick:nth-child(2)').evaluate((tick) => parseFloat(tick.style.left));
  const ruler = page.locator('#timelineRuler');
  await ruler.click({position: {x: tickScale * 1.5, y: 5}});
  await page.waitForFunction(() => {
    const layer = document.querySelector('#previewImageB');
    return layer && layer.style.clipPath.startsWith('circle(');
  });
  const clipPath = await page.locator('#previewImageB').evaluate((element) => element.style.clipPath);
  assert.match(clipPath, /circle\(37\.5% at 50% 50%\)/);

  // Create a new AI transition through the composer modal.
  await page.locator('.transition-card.add-card').click();
  await page.locator('#transitionComposerName').fill('Diagonal sweep');
  await page.locator('#transitionComposerPrompt').fill('Reveal the incoming clip along a diagonal from the top-left corner.');
  await page.locator('[data-transition-composer-form] button[type="submit"]').click();
  await page.locator('[data-transition-composer-form]').waitFor({state: 'detached'});
  assert.equal(await page.locator('.transition-card.custom').count(), 2);
  const created = page.locator('[data-transition-type="custom-diagonal-sweep"]');
  assert.match(await created.locator('strong').innerText(), /Diagonal sweep/);

  assert.deepEqual(browserErrors, []);
});
