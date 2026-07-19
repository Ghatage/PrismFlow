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

test('splash prism uses native high-resolution geometry and a thin edge', {timeout: 30_000}, async (context) => {
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
  const page = await browser.newPage({
    deviceScaleFactor: 2,
    viewport: {width: 1440, height: 1000},
  });
  await page.goto(origin, {waitUntil: 'domcontentloaded'});

  const geometry = await page.locator('.splash-prism').evaluate((prism) => {
    const mark = prism.querySelector('.brand-mark');
    const face = mark.querySelector('span');
    const prismStyle = getComputedStyle(prism);
    const markStyle = getComputedStyle(mark);
    const faceStyle = getComputedStyle(face);
    return {
      prismTransform: prismStyle.transform,
      markWidth: Number.parseFloat(markStyle.width),
      faceWidth: Number.parseFloat(faceStyle.width),
      edgeWidth: Number.parseFloat(faceStyle.borderLeftWidth),
      edgeShadow: faceStyle.boxShadow,
      depth: markStyle.getPropertyValue('--prism-depth').trim(),
    };
  });

  assert.equal(geometry.prismTransform, 'none');
  assert.equal(geometry.markWidth, 154);
  assert.equal(geometry.faceWidth, 96);
  assert.equal(geometry.edgeWidth, 0);
  assert.match(geometry.edgeShadow, /0\.5px inset/);
  assert.equal(geometry.depth, '27.71px');
});
