import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexWav, wavPiece } from '../../lib/wav.js';

function wav({ rate = 44100, channels = 2, seconds = 1, extra = [] } = {}) {
  const frames = rate * seconds;
  const data = new Int16Array(frames * channels).map((_, i) => i % 1000);
  const fmt = new Uint8Array(16);
  const f = new DataView(fmt.buffer);
  f.setUint16(0, 1, true); f.setUint16(2, channels, true); f.setUint32(4, rate, true);
  f.setUint32(8, rate * channels * 2, true); f.setUint16(12, channels * 2, true); f.setUint16(14, 16, true);
  const chunk = (id, body) => { const h = new Uint8Array(8); h.set([...id].map((c) => c.charCodeAt(0))); new DataView(h.buffer).setUint32(4, body.length, true); return [h, body, ...(body.length & 1 ? [new Uint8Array(1)] : [])]; };
  const parts = [...chunk('fmt ', fmt), ...extra.flatMap(([id, body]) => chunk(id, body)), ...chunk('data', new Uint8Array(data.buffer))];
  const size = parts.reduce((n, p) => n + p.length, 4);
  const riff = new Uint8Array(12); riff.set([...'RIFF'].map((c) => c.charCodeAt(0))); new DataView(riff.buffer).setUint32(4, size, true); riff.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
  return { blob: new Blob([riff, ...parts]), data: new Uint8Array(data.buffer) };
}

test('reads format, rate and where the samples are', async () => {
  const { blob, data } = wav();
  const info = await indexWav(blob);
  assert.equal(info.format, 1);
  assert.equal(info.channels, 2);
  assert.equal(info.sampleRate, 44100);
  assert.equal(info.blockAlign, 4);
  assert.equal(info.dataSize, data.length);
  assert.deepEqual(new Uint8Array(await blob.slice(info.dataStart, info.dataStart + 8).arrayBuffer()), data.subarray(0, 8));
});

test('skips other chunks (LIST, odd sizes) before the data', async () => {
  const { blob } = wav({ extra: [['LIST', new Uint8Array(33)], ['junk', new Uint8Array(4)]] });
  const info = await indexWav(blob);
  assert.equal(info.dataSize, 44100 * 4);
});

test('pieces are valid WAV files with the same format', async () => {
  const { blob, data } = wav({ channels: 1, rate: 16000 });
  const info = await indexWav(blob);
  const piece = wavPiece(info, data.subarray(0, 3200));
  const again = await indexWav(new Blob([piece]));
  assert.equal(again.sampleRate, 16000);
  assert.equal(again.dataSize, 3200);
});

test('not a WAV', async () => {
  assert.equal(await indexWav(new Blob([new Uint8Array(100)])), null);
  assert.equal(await indexWav(new Blob([new TextEncoder().encode('ID3')])), null);
});
