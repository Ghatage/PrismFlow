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

const createFixture = (origin) => ({
  schemaVersion: 1,
  updatedAt: '2026-07-18T20:00:00.000Z',
  project: {id: 'project-score', name: 'Score smoke', createdAt: '2026-07-18T20:00:00.000Z', metadata: {aspectRatio: '16:9', frameRate: 30, theme: 'a quiet homecoming'}},
  scenes: [
    {id: 'scene-one', name: 'Act 1', duration: 4, metadata: {actNumber: 1}},
    {id: 'scene-two', name: 'Act 2', duration: 4, metadata: {actNumber: 2}},
  ],
  characters: [],
  mediaAssets: [
    {id: 'visual-a', name: 'First shot', kind: 'image', mimeType: 'image/svg+xml', duration: 4, remoteUrl: `${origin}/test-media/top.svg`},
    {id: 'visual-b', name: 'Second shot', kind: 'image', mimeType: 'image/svg+xml', duration: 4, remoteUrl: `${origin}/test-media/lower.svg`},
  ],
  timeline: {
    revision: 0,
    activeSceneId: 'scene-one',
    duration: 8,
    tracks: [
      {id: 'V1', name: 'Video', kind: 'video', order: 0},
      {id: 'A1', name: 'Audio', kind: 'audio', order: 1},
    ],
    clips: [
      {id: 'clip-a', assetId: 'visual-a', sceneId: 'scene-one', trackId: 'V1', start: 0, duration: 4},
      {id: 'clip-b', assetId: 'visual-b', sceneId: 'scene-two', trackId: 'V1', start: 0, duration: 4},
    ],
    transitions: [],
  },
  timelineDiffs: {schemaVersion: 1, items: []},
});

test('generates a background score onto the audio track with the fake adapter', {timeout: 45_000}, async (context) => {
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
  await page.addInitScript((project) => {
    localStorage.setItem('prismflow.project', JSON.stringify(project));
  }, createFixture(origin));
  await page.goto(`${origin}/?view=editor&musicAdapter=fake`, {waitUntil: 'networkidle'});
  await page.locator('[data-media-hydrated="true"]').waitFor();

  const scoreButton = page.locator('[data-action="generate-score"]');
  assert.match(await scoreButton.innerText(), /Score/);
  await scoreButton.click();

  // The fake adapter runs direction synchronously, then completes on the
  // second 2.5s poll; the landing dispatch adds one audio clip per act.
  await page.waitForFunction(() => {
    const lane = document.querySelector('[data-track-id="A1"]');
    return lane && lane.querySelectorAll('.timeline-clip.audio').length >= 1;
  }, {timeout: 20_000});

  // The "All" view concatenates the acts, so both score windows appear.
  await page.locator('[data-action="select-act"]').selectOption('all');
  await page.waitForFunction(() => {
    const lane = document.querySelector('[data-track-id="A1"]');
    return lane && lane.querySelectorAll('.timeline-clip.audio').length === 2;
  });

  // The session-persisted project carries the asset, cue sheet, and both
  // scene-local score clips windowed into the same audio file.
  const stored = await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('prismflow.project');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const read = open.result.transaction('projects', 'readonly').objectStore('projects').get('project-score');
      read.onerror = () => reject(read.error);
      read.onsuccess = () => resolve(read.result?.project || null);
    };
  }));
  const scoreAsset = stored.mediaAssets.find((asset) => asset.name === 'Background score');
  assert.ok(scoreAsset, 'the score audio asset was imported');
  assert.equal(scoreAsset.kind, 'audio');
  assert.equal(scoreAsset.duration, 8);
  assert.ok(scoreAsset.metadata.cueSheet, 'the cue sheet is stored on the asset');
  assert.equal(scoreAsset.metadata.cueSheet.durationMs, 8000);
  const scoreClips = stored.timeline.clips.filter((clip) => clip.assetId === scoreAsset.id);
  assert.deepEqual(
    scoreClips.map((clip) => [clip.sceneId, clip.start, clip.sourceStart, clip.duration]),
    [['scene-one', 0, 0, 4], ['scene-two', 0, 4, 4]]);

  // The button returns to idle and the flow surfaced no page errors.
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-action="generate-score"]');
    return button && !button.disabled;
  });
  assert.deepEqual(browserErrors, []);
});
