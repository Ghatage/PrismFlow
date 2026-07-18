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

test('style picker uses two full-width columns and colorizes only the selected card', {timeout: 30_000}, async (context) => {
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
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${origin}/?view=picker`, {waitUntil: 'domcontentloaded'});
  const cards = page.locator('.picker-card');
  await cards.first().waitFor();
  assert.ok(await cards.count() > 2);

  const layout = await page.locator('.picker-grid').evaluate((grid) => {
    const [first, second, third] = [...grid.querySelectorAll('.picker-card')].map((card) => card.getBoundingClientRect());
    const style = getComputedStyle(grid);
    return {
      columnCount: style.gridTemplateColumns.split(' ').length,
      gap: Number.parseFloat(style.columnGap),
      gridWidth: grid.getBoundingClientRect().width,
      first: {top: first.top, width: first.width},
      second: {top: second.top, width: second.width},
      third: {top: third.top},
    };
  });
  assert.equal(layout.columnCount, 2);
  assert.ok(Math.abs(layout.first.top - layout.second.top) < 1);
  assert.ok(layout.third.top > layout.first.top);
  assert.ok(Math.abs(layout.first.width + layout.second.width + layout.gap - layout.gridWidth) < 2);

  assert.equal(await page.locator('.picker-act-strip').count(), 0);
  assert.equal(await page.locator('.picker-card-explanation').count(), await cards.count());
  assert.equal(await page.locator('.picker-card-explanation').first().evaluate((node) => getComputedStyle(node).whiteSpace), 'nowrap');

  const firstArt = cards.first().locator('.picker-card-art');
  const initialArt = await firstArt.evaluate((node) => {
    const style = getComputedStyle(node);
    return {backgroundImage: style.backgroundImage, filter: style.filter};
  });
  assert.match(initialArt.backgroundImage, /story-structure-tapestry\.webp/);
  assert.match(initialArt.filter, /grayscale\(1\)/);

  const storyCircle = page.locator('[data-style-id="story-circle"]');
  await storyCircle.hover();
  await page.waitForTimeout(500);
  const hoveredFilter = await storyCircle.locator('.picker-card-art').evaluate((node) => getComputedStyle(node).filter);
  const hoveredGrayscale = Number(hoveredFilter.match(/grayscale\(([\d.]+)\)/)?.[1]);
  assert.ok(hoveredGrayscale < .05, `expected hovered artwork to be colorized, got ${hoveredFilter}`);

  await storyCircle.click();
  await page.waitForTimeout(500);
  assert.equal(await storyCircle.getAttribute('aria-pressed'), 'true');
  assert.equal(await cards.first().getAttribute('aria-pressed'), 'false');
  const selectedFilter = await storyCircle.locator('.picker-card-art').evaluate((node) => getComputedStyle(node).filter);
  const selectedGrayscale = Number(selectedFilter.match(/grayscale\(([\d.]+)\)/)?.[1]);
  assert.ok(selectedGrayscale < .05, `expected selected artwork to be colorized, got ${selectedFilter}`);

  const titleStyle = await storyCircle.locator('.picker-card-title').evaluate((node) => {
    const style = getComputedStyle(node);
    return {family: style.fontFamily, size: Number.parseFloat(style.fontSize), weight: Number(style.fontWeight), fontStyle: style.fontStyle};
  });
  assert.match(titleStyle.family, /Playfair Display/);
  assert.ok(titleStyle.size >= 24);
  assert.ok(titleStyle.weight >= 700);
  assert.equal(titleStyle.fontStyle, 'italic');
  assert.deepEqual(pageErrors, []);
});
