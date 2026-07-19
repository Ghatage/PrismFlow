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

const fixture = {
  schemaVersion: 1,
  updatedAt: '2026-07-18T23:00:00.000Z',
  project: {id: 'project-rename-browser', name: 'Rename smoke', createdAt: '2026-07-18T23:00:00.000Z', metadata: {aspectRatio: '16:9', frameRate: 30}},
  scenes: [{id: 'scene-rename', name: 'Opening scene', duration: 12, metadata: {actNumber: 1}}],
  characters: [],
  styles: [],
  mediaAssets: [],
  agentWorkspace: {schemaVersion: 1, updatedAt: '2026-07-18T23:00:00.000Z', messages: [], script: {title: 'Rename smoke', metadata: {}, beats: []}},
  timeline: {
    revision: 0,
    activeSceneId: 'scene-rename',
    duration: 12,
    tracks: [{id: 'V1', name: 'Video', kind: 'video', order: 0}, {id: 'A1', name: 'Audio', kind: 'audio', order: 1}],
    clips: [],
    transitions: [],
  },
  timelineDiffs: {schemaVersion: 1, items: []},
};

const persistedProjectName = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('prismflow.project');
  request.onerror = () => reject(request.error || new Error('Could not open the project database.'));
  request.onsuccess = () => {
    const database = request.result;
    const read = database.transaction('projects', 'readonly').objectStore('projects').get('project-rename-browser');
    read.onerror = () => reject(read.error || new Error('Could not read the project.'));
    read.onsuccess = () => {
      database.close();
      resolve(read.result?.project?.project?.name || null);
    };
  };
}));

test('renames a project from the editor and projects hub', {timeout: 30_000}, async (context) => {
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
  const page = await browser.newPage({viewport: {width: 1280, height: 820}});
  const browserErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  await page.addInitScript((project) => localStorage.setItem('prismflow.project', JSON.stringify(project)), fixture);
  await page.goto(`${origin}/?view=editor`, {waitUntil: 'networkidle'});
  await page.locator('[data-media-hydrated="true"]').waitFor();

  await page.getByRole('button', {name: 'Rename project'}).click();
  const editorName = page.locator('[data-project-name-form] input[name="name"]');
  assert.equal(await editorName.inputValue(), 'Rename smoke');
  await editorName.fill('Moonlit Cat');
  await editorName.press('Enter');
  await page.getByRole('button', {name: 'Rename project'}).waitFor();
  assert.match(await page.locator('.project-switcher').textContent(), /Moonlit Cat/);
  assert.equal(await persistedProjectName(page), 'Moonlit Cat');

  await page.locator('.brand-name').click();
  const tile = page.locator('.hub-tile[data-project-id="project-rename-browser"]');
  await tile.waitFor();
  await tile.getByRole('button', {name: 'Rename Moonlit Cat'}).click();
  const hubName = tile.locator('input[name="name"]');
  await hubName.fill('Cat at Dawn');
  await tile.getByRole('button', {name: 'Save project name'}).click();
  const renamedTile = page.locator('.hub-tile[data-project-id="project-rename-browser"]');
  await renamedTile.getByText('Cat at Dawn', {exact: true}).waitFor();
  assert.equal(await persistedProjectName(page), 'Cat at Dawn');
  assert.deepEqual(browserErrors, []);
});
