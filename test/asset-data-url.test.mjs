import test from 'node:test';
import assert from 'node:assert/strict';
import {toUploadableUrl} from '../src/asset-data-url.js';

const fakeBlobFetch = (bytes, type = 'image/png') => async () => ({
  blob: async () => ({
    size: bytes.length,
    type,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  }),
});

test('passes through https and data image urls untouched', async () => {
  assert.equal(await toUploadableUrl('https://fal.media/sheet.png'), 'https://fal.media/sheet.png');
  assert.equal(await toUploadableUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
});

test('converts blob urls to base64 data uris', async () => {
  const url = await toUploadableUrl('blob:http://localhost/abc', {
    fetchImpl: fakeBlobFetch([137, 80, 78, 71]),
  });
  assert.equal(url, `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString('base64')}`);
});

test('defaults missing blob mime type to image/png', async () => {
  const url = await toUploadableUrl('blob:http://localhost/abc', {
    fetchImpl: fakeBlobFetch([1, 2, 3], ''),
  });
  assert.ok(url.startsWith('data:image/png;base64,'));
});

test('throws when the blob exceeds the size cap', async () => {
  await assert.rejects(
    toUploadableUrl('blob:http://localhost/abc', {
      fetchImpl: fakeBlobFetch([1, 2, 3, 4, 5]),
      maxBytes: 4,
    }),
    /too large/
  );
});

test('returns null for unsupported schemes and empty input', async () => {
  assert.equal(await toUploadableUrl('http://insecure.example/a.png'), null);
  assert.equal(await toUploadableUrl('file:///tmp/a.png'), null);
  assert.equal(await toUploadableUrl(''), null);
  assert.equal(await toUploadableUrl(null), null);
});
