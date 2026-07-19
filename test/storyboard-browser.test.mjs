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
  openRequest.onerror = () => reject(openRequest.error || new Error('Could not open PrismFlow database.'));
  openRequest.onsuccess = () => {
    const database = openRequest.result;
    const request = database.transaction('projects', 'readonly').objectStore('projects').get('project-storyboard-browser');
    request.onerror = () => reject(request.error || new Error('Could not read PrismFlow project.'));
    request.onsuccess = () => {
      database.close();
      resolve(request.result?.project || null);
    };
  };
}));

const fixture = (origin) => ({
  schemaVersion: 1,
  updatedAt: '2026-07-18T20:00:00.000Z',
  project: {
    id: 'project-storyboard-browser',
    name: 'Act workspace smoke',
    createdAt: '2026-07-18T20:00:00.000Z',
    metadata: {aspectRatio: '16:9', frameRate: 30},
  },
  scenes: [
    {id: 'scene-act-1', name: 'Act One', duration: 12, metadata: {actNumber: 1}},
    {id: 'scene-act-2', name: 'Act Two', duration: 12, metadata: {actNumber: 2}},
  ],
  characters: [],
  styles: [],
  mediaAssets: [
    {id: 'asset-act-1', name: 'Act One plate', kind: 'image', mimeType: 'image/svg+xml', duration: 2, sceneId: 'scene-act-1', remoteUrl: `${origin}/test-media/act-1.svg`},
    {id: 'asset-act-2', name: 'Act Two plate', kind: 'image', mimeType: 'image/svg+xml', duration: 3, sceneId: 'scene-act-2', remoteUrl: `${origin}/test-media/act-2.svg`},
  ],
  agentWorkspace: {
    schemaVersion: 1,
    updatedAt: '2026-07-18T20:00:00.000Z',
    messages: [
      {id: 'message-global', role: 'assistant', text: 'Global production note', sceneId: null, resultIds: [], frameIds: [], createdAt: '2026-07-18T20:00:00.000Z'},
      {id: 'message-act-1', role: 'assistant', text: 'Act one note', sceneId: 'scene-act-1', resultIds: [], frameIds: [], createdAt: '2026-07-18T20:00:00.000Z'},
      {id: 'message-act-2', role: 'assistant', text: 'Act two note', sceneId: 'scene-act-2', resultIds: [], frameIds: [], createdAt: '2026-07-18T20:00:00.000Z'},
    ],
    script: {title: 'Act workspace smoke', metadata: {}, beats: []},
  },
  storyboard: {
    schemaVersion: 1,
    styleId: 'browser-test-style',
    styleTitle: 'Browser Test Structure',
    pan: {x: 0, y: 0},
    zoom: 1,
    nextZ: 10,
    nodes: [
      {id: 'node-act-1', kind: 'act', actNumber: 1, sceneId: 'scene-act-1', title: 'Act One', summary: 'The story begins.', beats: [], stills: [], x: 300, y: 170, w: 380, z: 11},
      {id: 'node-act-2', kind: 'act', actNumber: 2, sceneId: 'scene-act-2', title: 'Act Two', summary: 'The story turns.', beats: [], stills: [], x: 760, y: 170, w: 380, z: 12},
    ],
  },
  timeline: {
    revision: 0,
    activeSceneId: 'scene-act-1',
    duration: 12,
    tracks: [
      {id: 'V1', name: 'Video', kind: 'video', order: 0},
      {id: 'A1', name: 'Audio', kind: 'audio', order: 1},
    ],
    clips: [
      {id: 'clip-act-1', assetId: 'asset-act-1', sceneId: 'scene-act-1', trackId: 'V1', start: 0, duration: 2},
      {id: 'clip-act-2', assetId: 'asset-act-2', sceneId: 'scene-act-2', trackId: 'V1', start: 0, duration: 3},
    ],
    transitions: [],
  },
  timelineDiffs: {schemaVersion: 1, items: []},
});

const logicalX = async (locator) => locator.evaluate((element) => {
  const match = element.style.transform.match(/translate\(([-\d.]+)px/);
  return Number(match?.[1]);
});

test('storyboard work persists and the editor scopes and concatenates acts', {timeout: 45_000}, async (context) => {
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
  const browserErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`); });
  page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => browserErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText || ''}`));
  page.on('response', (response) => { if (response.status() >= 400) browserErrors.push(`response: ${response.status()} ${response.url()}`); });
  await page.route(`${origin}/test-media/**`, (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#667799"/></svg>',
  }));
  await page.route(`**/api/search/video**`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({results: [
      {id: 'frame-act-1', videoAssetId: 'asset-act-1', videoName: 'Act One plate', time: 1, annotation: 'first act frame'},
      {id: 'frame-act-2', videoAssetId: 'asset-act-2', videoName: 'Act Two plate', time: 1, annotation: 'second act frame'},
    ]}),
  }));
  await page.addInitScript((project) => {
    if (sessionStorage.getItem('storyboard-fixture-seeded')) return;
    sessionStorage.setItem('storyboard-fixture-seeded', '1');
    localStorage.setItem('prismflow.project', JSON.stringify(project));
  }, fixture(origin));

  await page.goto(`${origin}/?view=storyboard&characterAdapter=fake&storyboardAdapter=fake&timelineAdapter=fake`, {waitUntil: 'networkidle'});
  await page.locator('.storyboard').waitFor();
  await page.waitForFunction(() => localStorage.getItem('prismflow.project') === null);

  // Create a reusable cast identity from the storyboard's fixed cast rail.
  await page.locator('[data-action="cast-create"]').click();
  await page.locator('#composerName').fill('Marlow');
  await page.locator('#composerPrompt').fill('A curious red fox in a blue field jacket');
  await page.locator('[data-character-composer-form]').evaluate((form) => form.requestSubmit());
  await page.getByRole('heading', {name: 'Marlow'}).waitFor();
  await page.locator('[data-action="close-character-modal"].small-icon-button').click();
  await page.locator('[data-cast-character-id]').filter({hasText: 'Marlow'}).waitFor();

  // Mention autocomplete records the character id in the persisted beat map.
  const firstAct = page.locator('[data-node-id="node-act-1"]');
  const beatInput = firstAct.locator('[data-beat-input]');
  await beatInput.fill('Marlow enters @Mar');
  await page.locator('.mention-menu button').filter({hasText: 'Marlow'}).waitFor();
  await beatInput.press('Enter');
  await beatInput.press('Enter');
  await firstAct.locator('.board-beat').filter({hasText: '@Marlow'}).waitFor();

  // Cursor-anchored zoom updates the scale, and node motion is divided by it.
  await page.locator('#boardViewport').dispatchEvent('wheel', {
    deltaY: -20,
    deltaX: 0,
    ctrlKey: true,
    clientX: 700,
    clientY: 450,
  });
  await page.waitForFunction(() => document.querySelector('#storyboardZoom')?.textContent !== '100%');
  const zoom = Number((await page.locator('#storyboardZoom').textContent()).replace('%', '')) / 100;
  assert.ok(zoom > 1);
  const xBefore = await logicalX(firstAct);
  const dragHandle = firstAct.locator('.board-act-header');
  const handleBox = await dragHandle.boundingBox();
  await page.mouse.move(handleBox.x + 20, handleBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 100, handleBox.y + 12, {steps: 5});
  await page.mouse.up();
  const xAfter = await logicalX(firstAct);
  assert.ok(Math.abs((xAfter - xBefore) - (80 / zoom)) < 4);

  // A click (not a drag) opens an almost-full-screen act workspace without
  // disturbing the storyboard canvas behind it.
  await firstAct.locator('.board-act-header').click();
  const actWorkspace = page.locator('.act-workspace-modal');
  await actWorkspace.waitFor();
  const workspaceBox = await actWorkspace.boundingBox();
  assert.ok(workspaceBox.width > 1300);
  assert.ok(workspaceBox.height > 900);

  // Mention suggestions are portalled to document.body and must remain above
  // the act workspace instead of being visually buried beneath its scrim.
  const modalMentionInput = actWorkspace.locator('[data-beat-description]').first();
  await modalMentionInput.fill('Marlow enters @Mar');
  const modalMentionOption = page.locator('.mention-menu button').filter({hasText: 'Marlow'});
  await modalMentionOption.waitFor();
  assert.equal(await modalMentionOption.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(topmost?.closest('.mention-menu'));
  }), true);
  await modalMentionOption.click();
  assert.equal(await modalMentionInput.inputValue(), 'Marlow enters @Marlow ');

  // Linked beats behave like a small ComfyUI graph. Inserting on a link
  // splits it; deleting the inserted node removes both incident links and
  // deliberately leaves the remaining beats disjointed.
  assert.equal(await actWorkspace.locator('.act-beat-node').count(), 1);
  await actWorkspace.locator('[data-action="append-linked-beat"]').click();
  assert.equal(await actWorkspace.locator('.act-beat-node').count(), 2);
  assert.equal(await actWorkspace.locator('.act-beat-connection').count(), 1);
  await actWorkspace.locator('[data-action="insert-beat-on-connection"]').click();
  assert.equal(await actWorkspace.locator('.act-beat-node').count(), 3);
  assert.equal(await actWorkspace.locator('.act-beat-connection').count(), 2);
  await actWorkspace.locator('.act-beat-node').nth(1).locator('[data-action="delete-workspace-beat"]').click();
  assert.equal(await actWorkspace.locator('.act-beat-node').count(), 2);
  assert.equal(await actWorkspace.locator('.act-beat-connection').count(), 0);
  await actWorkspace.locator('.act-beat-node').first().locator('[data-action="append-linked-beat"]').click();
  assert.equal(await actWorkspace.locator('.act-beat-node').count(), 3);
  assert.equal(await actWorkspace.locator('.act-beat-connection').count(), 1);

  const movableBeat = actWorkspace.locator('.act-beat-node').nth(1);
  const leftBefore = Number.parseFloat(await movableBeat.evaluate((element) => element.style.left));
  const modalDragHandle = movableBeat.locator('.act-beat-drag-handle');
  const modalDragBox = await modalDragHandle.boundingBox();
  await page.mouse.move(modalDragBox.x + 8, modalDragBox.y + 8);
  await page.mouse.down();
  await page.mouse.move(modalDragBox.x + 68, modalDragBox.y + 38, {steps: 4});
  await page.mouse.up();
  const leftAfter = Number.parseFloat(await movableBeat.evaluate((element) => element.style.left));
  assert.ok(Math.abs(leftAfter - leftBefore - 60) < 3);

  const modalBeatText = actWorkspace.locator('[data-beat-description]').last();
  await modalBeatText.fill('Marlow crosses the impossible tide with @Marlow');
  await page.getByText('Unsaved changes', {exact: true}).waitFor();
  await actWorkspace.locator('[data-action="save-act-workspace"]').click();
  await page.getByText('Saved', {exact: true}).waitFor();
  await actWorkspace.locator('[data-action="close-act-workspace"]').click();
  await actWorkspace.waitFor({state: 'detached'});
  await firstAct.locator('.board-act-header').click();
  await actWorkspace.waitFor();
  assert.equal(await actWorkspace.locator('[data-beat-description]').last().inputValue(), 'Marlow crosses the impossible tide with @Marlow');

  // X and Escape share the explicit-draft guard. Dismissing keeps the draft;
  // accepting discards it and reopening restores the last saved snapshot.
  await actWorkspace.locator('[data-act-summary]').fill('Unsaved summary draft');
  page.once('dialog', async (dialog) => {
    assert.match(dialog.message(), /Discard unsaved changes/);
    await dialog.dismiss();
  });
  await actWorkspace.locator('[data-action="close-act-workspace"]').click();
  await actWorkspace.waitFor();
  assert.equal(await actWorkspace.locator('[data-act-summary]').inputValue(), 'Unsaved summary draft');
  page.once('dialog', async (dialog) => dialog.accept());
  await page.keyboard.press('Escape');
  await actWorkspace.waitFor({state: 'detached'});
  await firstAct.locator('.board-act-header').click();
  await actWorkspace.waitFor();
  assert.equal(await actWorkspace.locator('[data-act-summary]').inputValue(), 'The story begins.');

  // Generate one earlier still so the last beat's context exposes the prior
  // image anchor that can otherwise make a very different screenplay look alike.
  const priorBeat = actWorkspace.locator('.act-beat-node').first();
  assert.equal(await priorBeat.locator('[data-action="modify-beat-still-context"]').textContent(), 'Modify context');
  assert.equal(await priorBeat.locator('[data-action="generate-beat-still"]').textContent(), 'Generate still');
  await priorBeat.locator('[data-action="generate-beat-still"]').click();
  await priorBeat.locator('.act-beat-hero img').waitFor();

  const reopenedBeat = actWorkspace.locator('.act-beat-node').last();
  await reopenedBeat.locator('[data-beat-screenplay]').fill('INT. ORBITAL OBSERVATORY — NIGHT\n\nMarlow floats between unfamiliar stars.');
  await reopenedBeat.locator('[data-action="modify-beat-still-context"]').click();
  const stillContextModal = page.locator('.still-context-modal');
  await stillContextModal.waitFor();
  assert.match(await stillContextModal.textContent(), /NANO BANANA INPUT/);
  assert.equal(await stillContextModal.locator('[data-context-item-id="target:screenplay"] textarea').inputValue(), 'INT. ORBITAL OBSERVATORY — NIGHT\n\nMarlow floats between unfamiliar stars.');
  assert.equal(await stillContextModal.locator('[data-context-item-id="previous-still"] img').count(), 1);
  await stillContextModal.locator('[data-context-item-id="target:screenplay"] textarea').fill('INT. ZERO-G GLASS OBSERVATORY — NIGHT\n\nMarlow tumbles through a field of violet stars.');
  await stillContextModal.locator('[data-context-item-id^="character:"] [data-action="toggle-still-context-item"]').click();
  await stillContextModal.locator('[data-context-item-id="previous-still"] [data-action="toggle-still-context-item"]').click();
  assert.match(await stillContextModal.locator('[data-context-item-id="previous-still"]').textContent(), /Hidden/);
  await stillContextModal.getByRole('button', {name: 'Done'}).click();
  await stillContextModal.waitFor({state: 'detached'});

  await reopenedBeat.locator('[data-action="generate-beat-still"]').click();
  await reopenedBeat.locator('.act-beat-hero img').waitFor();
  assert.equal(await reopenedBeat.locator('[data-action="generate-beat-still"]').textContent(), 'Regenerate still');
  await reopenedBeat.locator('[data-action="generate-beat-script"]').click();
  const screenplay = reopenedBeat.locator('[data-beat-screenplay]');
  await screenplay.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-beat-screenplay]')]
    .some((textarea) => textarea.value.includes('EXT. HARBOR')));
  await screenplay.fill('EXT. HARBOR — DAWN\n\nMarlow crosses the impossible tide.');
  await actWorkspace.locator('[data-action="save-act-workspace"]').click();
  await page.getByText('Saved', {exact: true}).waitFor();
  await actWorkspace.locator('[data-action="close-act-workspace"]').click();

  assert.match(await firstAct.locator('.board-act-progress').textContent(), /2\/3 stills.*1\/3 scripts/s);

  await page.locator('[data-action="jump-to-editor"]').click();
  await page.locator('[data-media-hydrated="true"]').waitFor();
  assert.equal(await page.locator('[data-action="select-act"]').inputValue(), 'scene-act-1');
  await page.locator('[data-tab="script"]').click();
  assert.match(await page.locator('.script-beat-list').textContent(), /Marlow crosses the impossible tide/);
  const canonicalScriptForm = page.locator('[data-storyboard-script-form]').filter({hasText: 'Marlow crosses the impossible tide'});
  await canonicalScriptForm.locator('textarea[name="text"]').fill('EXT. HARBOR — DAWN\n\nEDITOR REVISION: Marlow crosses the impossible tide.');
  await canonicalScriptForm.evaluate((form) => form.requestSubmit());
  assert.match(await page.locator('[data-storyboard-script-form]').filter({hasText: 'Marlow crosses the impossible tide'}).locator('textarea[name="text"]').inputValue(), /EDITOR REVISION/);
  await page.locator('[data-tab="media"]').click();
  const actSelect = page.locator('[data-action="select-act"]');
  assert.deepEqual(await actSelect.locator('option').allTextContents(), ['All', 'Act One', 'Act Two']);

  // All concatenates the second act after the first act's two-second extent.
  await actSelect.selectOption('all');
  assert.equal(await page.locator('.timeline-clip[data-clip-id="clip-act-1"]').evaluate((element) => parseFloat(element.style.left)), 0);
  assert.equal(await page.locator('.timeline-clip[data-clip-id="clip-act-2"]').evaluate((element) => parseFloat(element.style.left)), 176);

  // Act two hides act-one clips/media/history; the act-one-only character is not global.
  await actSelect.selectOption('scene-act-2');
  assert.equal(await page.locator('.timeline-clip[data-clip-id="clip-act-1"]').count(), 0);
  assert.equal(await page.locator('.timeline-clip[data-clip-id="clip-act-2"]').count(), 1);
  assert.equal(await page.locator('.media-card[data-media-id="asset-act-1"]').count(), 0);
  assert.equal(await page.locator('.media-card[data-media-id="asset-act-2"]').count(), 1);
  await page.locator('[data-video-search-form] input').fill('plate');
  await page.locator('[data-video-search-form]').evaluate((form) => form.requestSubmit());
  await page.locator('.video-search-result').waitFor();
  assert.deepEqual(await page.locator('.video-search-result strong').allTextContents(), ['Act Two plate']);
  await page.locator('[data-tab="characters"]').click();
  assert.equal(await page.locator('.character-card[data-character-id]').count(), 0);
  await page.getByRole('button', {name: 'Agent', exact: true}).click();
  const agentText = await page.locator('.agent-messages').textContent();
  assert.match(agentText, /Global production note/);
  assert.match(agentText, /Act two note/);
  assert.doesNotMatch(agentText, /Act one note/);

  // Dragging in All maps the absolute position back to the owning act's local time.
  await page.locator('[data-action="select-act"]').selectOption('all');
  await page.locator('.timeline-clip[data-clip-id="clip-act-2"]').dragTo(page.locator('.video-lane'), {targetPosition: {x: 396, y: 35}});
  await page.waitForTimeout(100);
  const afterDrag = await readPersistedProject(page);
  const movedClip = afterDrag.timeline.clips.find((clip) => clip.id === 'clip-act-2');
  assert.ok(Math.abs(movedClip.start - 1) < 0.15, `expected act-local start near 1s, got ${movedClip.start}`);

  // The selected act exposes its beat stills as a horizontally scrollable,
  // linked strip. A still opens the large Seedance prompt workspace.
  await page.locator('[data-action="select-act"]').selectOption('scene-act-1');
  const beatStrip = page.locator('.editor-beat-strip');
  await beatStrip.waitFor();
  assert.equal(await beatStrip.evaluate((element) => getComputedStyle(element.querySelector('.editor-beat-strip-scroll')).overflowX), 'auto');
  assert.equal(await beatStrip.locator('[data-editor-beat-id]').count(), 3);
  assert.equal(await beatStrip.locator('.editor-beat-connector').count(), 1);
  await beatStrip.locator('[data-editor-beat-id]').last().click();

  const beatVideoModal = page.locator('.beat-video-modal');
  await beatVideoModal.waitFor();
  const beatVideoBox = await beatVideoModal.boundingBox();
  assert.ok(beatVideoBox.width > 1250);
  assert.ok(beatVideoBox.height > 850);
  assert.match(await beatVideoModal.locator('.beat-video-screenplay').textContent(), /EDITOR REVISION/);
  await beatVideoModal.locator('[data-beat-video-duration]').selectOption('6');
  assert.deepEqual(await beatVideoModal.locator('[data-beat-video-duration] option').allTextContents(), [
    '4 seconds', '5 seconds', '6 seconds', '7 seconds', '8 seconds', '9 seconds',
    '10 seconds', '11 seconds', '12 seconds', '13 seconds', '14 seconds', '15 seconds',
  ]);
  await beatVideoModal.locator('[data-action="generate-beat-video-prompt"]').click();
  await page.waitForFunction(() => document.querySelector('[data-beat-video-prompt]')?.value.includes('00:04 - 00:06'));
  const generatedVideoPrompt = beatVideoModal.locator('[data-beat-video-prompt]');
  assert.match(await generatedVideoPrompt.inputValue(), /@Image1/);
  assert.match(await generatedVideoPrompt.inputValue(), /HARD CUT/);
  assert.equal((await generatedVideoPrompt.inputValue()).match(/DIALOGUE \(/g)?.length, 3);
  assert.match(await beatVideoModal.locator('.beat-video-audio-note').textContent(), /Every cut.*dialogue under 3 seconds/i);
  assert.match(await generatedVideoPrompt.inputValue(), /No music or musical score/i);
  await generatedVideoPrompt.fill(`${await generatedVideoPrompt.inputValue()}\nKeep the final camera move gentle.`);
  await beatVideoModal.locator('[data-action="generate-beat-video"]').click();
  await beatVideoModal.waitFor({state: 'detached'});
  const pendingBeatVideo = page.locator('.generation-pending');
  await pendingBeatVideo.waitFor();
  // The generated prompt remains internally relative to 00:00, but the clip
  // appends externally after the accepted two-second act-one plate.
  assert.equal(await pendingBeatVideo.evaluate((element) => parseFloat(element.style.left)), 176);
  assert.match(await pendingBeatVideo.textContent(), /Generating beat video/);
  await pendingBeatVideo.waitFor({state: 'detached', timeout: 8_000});

  const afterBeatVideo = await readPersistedProject(page);
  const generatedBeatVideo = afterBeatVideo.mediaAssets.find((asset) => asset.metadata?.providerModelId === 'bytedance/seedance-2.0/reference-to-video');
  assert.ok(generatedBeatVideo);
  const generatedBeatClip = afterBeatVideo.timeline.clips.find((clip) => clip.assetId === generatedBeatVideo.id);
  assert.equal(generatedBeatClip.start, 2);
  assert.equal(generatedBeatClip.duration, 6);
  assert.match(generatedBeatClip.provenance.prompt, /Keep the final camera move gentle/);

  // Both timeline regeneration paths inherit @Image1 from the storyboard beat
  // instead of submitting Seedance with an empty reference list.
  const generatedBeatTimelineClip = page.locator(`.timeline-clip[data-clip-id="${generatedBeatClip.id}"]`);
  await generatedBeatTimelineClip.click({button: 'right'});
  await page.locator('.context-menu button').filter({hasText: 'Modify prompt + regen'}).click();
  const regenerationModal = page.locator('.generate-modal');
  await regenerationModal.waitFor();
  assert.match(await regenerationModal.locator('.generate-attached-reference').textContent(), /AUTO-ATTACHED BEAT STILL.*@IMAGE1/s);
  assert.equal(await regenerationModal.locator('.generate-attached-reference img').count(), 1);
  await regenerationModal.locator('#generateVideoPrompt').fill('00:00 - 00:03 HARD CUT Marlow studies a violet star map. DIALOGUE (Marlow, 2s): "A different way home."\n00:03 - 00:06 HARD CUT overhead as the map unfolds. DIALOGUE (Marlow, 2s): "Now I see it."');
  await regenerationModal.getByRole('button', {name: 'Regenerate', exact: true}).click();
  await regenerationModal.waitFor({state: 'detached'});
  await page.waitForFunction((clipId) => document.querySelector(`.timeline-clip[data-clip-id="${clipId}"]`)?.classList.contains('regenerating'), generatedBeatClip.id);
  await page.waitForFunction((clipId) => !document.querySelector(`.timeline-clip[data-clip-id="${clipId}"]`)?.classList.contains('regenerating'), generatedBeatClip.id);
  const afterModifiedRegeneration = await readPersistedProject(page);
  assert.match(afterModifiedRegeneration.timeline.clips.find((clip) => clip.id === generatedBeatClip.id).provenance.prompt, /different way home/i);

  await page.locator(`.timeline-clip[data-clip-id="${generatedBeatClip.id}"]`).click({button: 'right'});
  await page.locator('.context-menu button').filter({hasText: 'Regenerate clip'}).click();
  await page.waitForFunction((clipId) => document.querySelector(`.timeline-clip[data-clip-id="${clipId}"]`)?.classList.contains('regenerating'), generatedBeatClip.id);
  await page.waitForFunction((clipId) => !document.querySelector(`.timeline-clip[data-clip-id="${clipId}"]`)?.classList.contains('regenerating'), generatedBeatClip.id);

  // Returning to the beat restores the exact editable prompt that was sent.
  await beatStrip.locator('[data-editor-beat-id]').last().click();
  await beatVideoModal.waitFor();
  assert.match(await beatVideoModal.locator('[data-beat-video-prompt]').inputValue(), /Keep the final camera move gentle/);
  assert.equal(await beatVideoModal.locator('[data-beat-video-duration]').inputValue(), '6');
  await beatVideoModal.getByRole('button', {name: 'Close', exact: true}).click();
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));

  // Reload returns to the storyboard URL and restores zoom, movement, beat, still, and cast from IDB.
  await page.reload({waitUntil: 'networkidle'});
  await page.locator('.storyboard').waitFor();
  assert.notEqual(await page.locator('#storyboardZoom').textContent(), '100%');
  assert.ok(await logicalX(page.locator('[data-node-id="node-act-1"]')) > 300);
  await page.locator('[data-node-id="node-act-1"] .board-beat').filter({hasText: '@Marlow'}).last().waitFor();
  await page.locator('[data-cast-character-id]').filter({hasText: 'Marlow'}).waitFor();
  await page.locator('[data-node-id="node-act-1"] .board-act-header').click();
  await page.locator('.act-workspace-modal .act-beat-hero img').last().waitFor();
  assert.match(await page.locator('.act-workspace-modal [data-beat-screenplay]').last().inputValue(), /EDITOR REVISION/);

  const persisted = await readPersistedProject(page);
  const persistedBeat = persisted.storyboard.nodes.find((node) => node.id === 'node-act-1').beats.at(-1);
  assert.equal(persistedBeat.mentions.Marlow, persisted.characters[0].id);
  assert.ok(persistedBeat.hero.assetId);
  assert.deepEqual(persistedBeat.stillContext.hiddenItemIds.sort(), [
    `character:${persisted.characters[0].id}`,
    'previous-still',
  ].sort());
  assert.match(persistedBeat.stillContext.overrides['target:screenplay'], /ZERO-G GLASS OBSERVATORY/);
  assert.match(persistedBeat.videoPrompt.text, /Keep the final camera move gentle/);
  assert.equal(persistedBeat.videoPrompt.duration, 6);
  assert.equal(persisted.mediaAssets.find((asset) => asset.metadata?.storyboardBeatId === persistedBeat.id).sceneId, 'scene-act-1');
  assert.equal(persisted.mediaAssets.find((asset) => asset.metadata?.providerModelId === 'local/fake-character-sheet-v1').sceneId, null);
  assert.deepEqual(browserErrors, []);
});
