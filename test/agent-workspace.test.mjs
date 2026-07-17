import assert from 'node:assert/strict';
import test from 'node:test';

import {createAgentWorkspace} from '../src/agent-workspace.js';
import {createProjectStore} from '../src/project-store.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
}

test('persists agent messages and an editable scene-linked script', () => {
  const storage = new MemoryStorage();
  let id = 0;
  const store = createProjectStore({
    storage,
    createId: (prefix) => `${prefix}-agent-${++id}`,
    now: () => '2026-07-17T14:00:00.000Z',
  });
  const workspace = createAgentWorkspace(store);
  const sceneId = store.getProject().scenes[0].id;

  workspace.addMessage({role: 'user', text: 'Find the fox jump shot.'});
  workspace.addMessage({role: 'assistant', text: 'Found one clip.', resultIds: ['clip:fox-1']});
  workspace.updateScript({title: 'Fox adventure'});
  const beatId = workspace.addBeat({text: 'The fox jumps over the puddle.', sceneId, clipIds: ['clip-1']}).affectedId;
  workspace.updateBeat(beatId, {text: 'The fox clears the puddle in one clean leap.', status: 'locked'});

  const project = store.getProject();
  assert.equal(project.agentWorkspace.messages.length, 2);
  assert.equal(project.agentWorkspace.messages[1].resultIds[0], 'clip:fox-1');
  assert.equal(project.agentWorkspace.script.title, 'Fox adventure');
  assert.equal(project.agentWorkspace.script.beats[0].sceneId, sceneId);
  assert.equal(project.agentWorkspace.script.beats[0].status, 'locked');

  const reloaded = createProjectStore({storage, now: () => '2026-07-17T14:01:00.000Z'}).getProject();
  assert.equal(reloaded.agentWorkspace.script.beats[0].text, 'The fox clears the puddle in one clean leap.');
});

test('rejects empty agent messages and script beats', () => {
  const workspace = createAgentWorkspace(createProjectStore({storage: new MemoryStorage()}));
  assert.throws(() => workspace.addMessage({text: ' '}), /Agent message is required/);
  assert.throws(() => workspace.addBeat({text: ''}), /Script beat is required/);
});
