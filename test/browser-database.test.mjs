import assert from 'node:assert/strict';
import test from 'node:test';

import {createBrowserDatabase} from '../src/browser-database.js';

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
