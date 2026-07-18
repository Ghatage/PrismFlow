import assert from 'node:assert/strict';
import test from 'node:test';

import {AudioExtractError, audioBufferToWavBlob, extractAudioFromBlob, resampleToMono} from '../src/audio-extract.js';

const fakeBuffer = ({channels = 1, sampleRate = 8000, samples = [[0, 0.5, -0.5, 1]]} = {}) => ({
  numberOfChannels: channels,
  sampleRate,
  length: samples[0].length,
  duration: samples[0].length / sampleRate,
  getChannelData: (channel) => Float32Array.from(samples[channel]),
});

test('encodes a 16-bit PCM WAV with a valid RIFF header', async () => {
  const blob = audioBufferToWavBlob(fakeBuffer());
  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, 44 + 4 * 2);
  const view = new DataView(await blob.arrayBuffer());
  const tag = (offset) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(36), 'data');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 8000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), Math.trunc(0.5 * 0x7fff));
  assert.equal(view.getInt16(48, true), Math.trunc(-0.5 * 0x8000));
  assert.equal(view.getInt16(50, true), 0x7fff);
});

test('interleaves stereo channels', async () => {
  const blob = audioBufferToWavBlob(fakeBuffer({channels: 2, samples: [[1, 1], [-1, -1]]}));
  const view = new DataView(await blob.arrayBuffer());
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getInt16(44, true), 0x7fff);
  assert.equal(view.getInt16(46, true), -0x8000);
  assert.equal(view.getInt16(48, true), 0x7fff);
  assert.equal(view.getInt16(50, true), -0x8000);
});

test('extracts audio through a Web Audio context and closes it', async () => {
  const closed = [];
  class FakeContext {
    async decodeAudioData() { return fakeBuffer({sampleRate: 44100}); }
    async close() { closed.push(true); }
  }
  const result = await extractAudioFromBlob(new Blob(['media']), {audioContextClass: FakeContext});
  assert.equal(result.numberOfChannels, 1);
  assert.equal(result.sampleRate, 44100);
  assert.equal(result.wavBlob.type, 'audio/wav');
  assert.equal(closed.length, 1);
});

test('reports a typed no-audio error when decode fails or is silent', async () => {
  class RejectingContext {
    async decodeAudioData() { throw new DOMException('no audio'); }
    async close() {}
  }
  await assert.rejects(
    extractAudioFromBlob(new Blob(['media']), {audioContextClass: RejectingContext}),
    (error) => error instanceof AudioExtractError && error.code === 'no-audio',
  );
  class EmptyContext {
    async decodeAudioData() { return {...fakeBuffer(), numberOfChannels: 0}; }
    async close() {}
  }
  await assert.rejects(
    extractAudioFromBlob(new Blob(['media']), {audioContextClass: EmptyContext}),
    (error) => error instanceof AudioExtractError && error.code === 'no-audio',
  );
});

test('resample passes through mono audio already at the target rate', async () => {
  const buffer = fakeBuffer({sampleRate: 16000});
  const samples = await resampleToMono(buffer, {targetRate: 16000});
  assert.deepEqual([...samples], [0, 0.5, -0.5, 1]);
});

test('resample renders through an offline context otherwise', async () => {
  const rendered = fakeBuffer({sampleRate: 16000, samples: [[0.25, 0.25]]});
  class FakeOfflineContext {
    constructor(channels, length, rate) {
      assert.equal(channels, 1);
      assert.equal(rate, 16000);
      this.destination = {};
    }
    createBufferSource() { return {connect: () => {}, start: () => {}}; }
    async startRendering() { return rendered; }
  }
  const samples = await resampleToMono(fakeBuffer({channels: 2, sampleRate: 48000, samples: [[0, 1], [1, 0]]}), {
    targetRate: 16000,
    offlineAudioContextClass: FakeOfflineContext,
  });
  assert.deepEqual([...samples], [0.25, 0.25]);
});
