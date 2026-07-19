import assert from 'node:assert/strict';
import test from 'node:test';

import {createBrowserDatabase, PROJECT_DATABASE_NAME} from '../src/browser-database.js';

// Minimal in-memory IndexedDB stand-in covering the code paths the app uses:
// versioned open/upgrade, keyPath-'id' stores, get/put/delete/getAll, and one
// index. Requests settle in microtasks so upgrade-time request callbacks run
// before open() resolves, like the real API.
const createFakeIndexedDb = () => {
  const databases = new Map();

  const makeRequest = () => ({onsuccess: null, onerror: null, result: undefined});
  const succeed = (request, result) => {
    request.result = result;
    queueMicrotask(() => request.onsuccess?.({target: request}));
  };

  const storeHandle = (db, storeName) => ({
    get indexNames() {
      return {contains: (name) => Boolean(db.indexes.get(storeName)?.has(name))};
    },
    createIndex(name, keyPath) {
      if (!db.indexes.has(storeName)) db.indexes.set(storeName, new Map());
      db.indexes.get(storeName).set(name, keyPath);
    },
    index(name) {
      const keyPath = db.indexes.get(storeName)?.get(name);
      return {
        getAll: (value) => {
          const request = makeRequest();
          succeed(request, [...db.stores.get(storeName).values()].filter((record) => record[keyPath] === value));
          return request;
        },
      };
    },
    get(key) {
      const request = makeRequest();
      succeed(request, db.stores.get(storeName).get(key));
      return request;
    },
    getAll() {
      const request = makeRequest();
      succeed(request, [...db.stores.get(storeName).values()]);
      return request;
    },
    put(record) {
      db.stores.get(storeName).set(record.id, structuredClone(record));
      const request = makeRequest();
      succeed(request, record.id);
      return request;
    },
    delete(key) {
      db.stores.get(storeName).delete(key);
      const request = makeRequest();
      succeed(request, undefined);
      return request;
    },
    clear() {
      db.stores.get(storeName).clear();
      const request = makeRequest();
      succeed(request, undefined);
      return request;
    },
  });

  const makeTransaction = (db) => {
    const transaction = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: null,
      objectStore: (name) => storeHandle(db, name),
    };
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => transaction.oncomplete?.())));
    return transaction;
  };

  const makeConnection = (db) => ({
    objectStoreNames: {contains: (name) => db.stores.has(name)},
    createObjectStore(name) {
      db.stores.set(name, new Map());
      return storeHandle(db, name);
    },
    transaction: () => makeTransaction(db),
    close() {},
  });

  return {
    _seed(name, version, stores = {}) {
      const db = {version, stores: new Map(), indexes: new Map()};
      for (const [storeName, records] of Object.entries(stores)) {
        db.stores.set(storeName, new Map(records.map((record) => [record.id, structuredClone(record)])));
      }
      databases.set(name, db);
    },
    open(name, version) {
      const request = makeRequest();
      request.transaction = null;
      queueMicrotask(() => {
        let db = databases.get(name);
        if (!db) {
          db = {version: 0, stores: new Map(), indexes: new Map()};
          databases.set(name, db);
        }
        const oldVersion = db.version;
        request.result = makeConnection(db);
        if (version > oldVersion) {
          db.version = version;
          request.transaction = makeTransaction(db);
          request.onupgradeneeded?.({target: request, oldVersion, newVersion: version});
          queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => request.onsuccess?.({target: request}))));
        } else {
          queueMicrotask(() => request.onsuccess?.({target: request}));
        }
      });
      return request;
    },
  };
};

const projectPayload = (id, overrides = {}) => ({
  schemaVersion: 1,
  updatedAt: '2026-07-18T10:00:00.000Z',
  project: {id, name: `Project ${id}`, createdAt: '2026-07-18T09:00:00.000Z', metadata: {}},
  scenes: [],
  characters: [],
  mediaAssets: [],
  timeline: {clips: [], tracks: [], transitions: []},
  ...overrides,
});

test('requests persistent browser storage when supported', async () => {
  let calls = 0;
  const database = createBrowserDatabase({
    indexedDBApi: null,
    storageApi: {
      persist: async () => {
        calls += 1;
        return true;
      },
    },
  });

  assert.equal(await database.requestPersistence(), true);
  assert.equal(calls, 1);
});

test('treats denied or unavailable storage persistence as a non-fatal result', async () => {
  const denied = createBrowserDatabase({
    indexedDBApi: null,
    storageApi: {persist: async () => false},
  });
  const rejected = createBrowserDatabase({
    indexedDBApi: null,
    storageApi: {persist: async () => { throw new Error('permission denied'); }},
  });
  const unavailable = createBrowserDatabase({indexedDBApi: null, storageApi: null});

  assert.equal(await denied.requestPersistence(), false);
  assert.equal(await rejected.requestPersistence(), false);
  assert.equal(await unavailable.requestPersistence(), false);
});

test('migrates the legacy single-project record to a per-project key on upgrade', async () => {
  const fake = createFakeIndexedDb();
  const legacy = projectPayload('project-alpha');
  fake._seed(PROJECT_DATABASE_NAME, 3, {projects: [{id: 'current', project: legacy}]});
  const database = createBrowserDatabase({indexedDBApi: fake, storageApi: null});

  const migrated = await database.loadProject('project-alpha');
  assert.equal(migrated.project.id, 'project-alpha');
  assert.equal(await database.loadProject('current'), null);
  const listed = await database.listProjects();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].project.id, 'project-alpha');
});

test('stores one record per project keyed by the payload project id', async () => {
  const database = createBrowserDatabase({indexedDBApi: createFakeIndexedDb(), storageApi: null});
  await database.saveProject(projectPayload('project-one'));
  await database.saveProject(projectPayload('project-two', {updatedAt: '2026-07-18T11:00:00.000Z'}));
  await database.saveProject({schemaVersion: 1, project: {name: 'No id'}}); // ignored

  assert.equal((await database.loadProject('project-one')).project.id, 'project-one');
  assert.equal((await database.loadProject('project-two')).project.id, 'project-two');
  assert.equal(await database.loadProject(null), null);
  const listed = await database.listProjects();
  assert.deepEqual(listed.map((entry) => entry.project.id).toSorted(), ['project-one', 'project-two']);
});

test('deleteProject removes the record, its media blobs, and its video frames only', async () => {
  const database = createBrowserDatabase({indexedDBApi: createFakeIndexedDb(), storageApi: null});
  await database.saveProject(projectPayload('project-keep', {mediaAssets: [{id: 'asset-keep'}]}));
  await database.saveProject(projectPayload('project-drop', {mediaAssets: [{id: 'asset-drop'}]}));
  await database.putAsset('asset-keep', {bytes: 'keep'});
  await database.putAsset('asset-drop', {bytes: 'drop'});
  await database.putVideoFrame({id: 'frame-1', videoAssetId: 'asset-drop'});
  await database.putVideoFrameManifest({id: 'asset-drop', frameCount: 1});

  await database.deleteProject('project-drop');

  assert.equal(await database.loadProject('project-drop'), null);
  assert.equal(await database.getAsset('asset-drop'), null);
  assert.deepEqual(await database.getVideoFrames('asset-drop'), []);
  assert.equal(await database.getVideoFrameManifest('asset-drop'), null);
  assert.equal((await database.loadProject('project-keep')).project.id, 'project-keep');
  assert.deepEqual(await database.getAsset('asset-keep'), {bytes: 'keep'});
});
