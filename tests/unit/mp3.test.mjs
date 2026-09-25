import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mp3FrameAt, indexMp3 } from '../../lib/mp3.js';

// Builds an MP3 frame header. version: 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5; layer: 3 = I, 2 = II, 1 = III.
function header(version, layer, brIndex, srIndex, pad = 0) {
  return [0xff, 0xe0 | (version << 3) | (layer << 1) | 1, (brIndex << 4) | (srIndex << 2) | (pad << 1), 0xc4];
}
function frames(n, { version = 3, layer = 1, br = 9, sr = 0, pad = 0 } = {}) {
  const len = mp3FrameAt(new Uint8Array(header(version, layer, br, sr, pad)), 0).len;
  const out = new Uint8Array(len * n);
  for (let k = 0; k < n; k++) out.set(header(version, layer, br, sr, pad), k * len);
  return out;
}
function id3(size, footer = false) {
  const b = new Uint8Array(10 + size + (footer ? 10 : 0));
  b.set([0x49, 0x44, 0x33, 4, 0, footer ? 0x10 : 0, (size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
  return b;
}
const blob = (...parts) => new Blob(parts);

test('frame length and samples for every MPEG version and layer', () => {
  const at = (...h) => mp3FrameAt(new Uint8Array(h), 0);
  assert.deepEqual(at(...header(3, 1, 9, 0)), { len: 417, spf: 1152, sr: 44100 });   // MPEG1 L3 128k 44.1k
  assert.deepEqual(at(...header(3, 1, 9, 0, 1)), { len: 418, spf: 1152, sr: 44100 }); // with padding
  assert.deepEqual(at(...header(2, 1, 8, 0)), { len: 208, spf: 576, sr: 22050 });     // MPEG2 L3 64k 22.05k
  assert.deepEqual(at(...header(0, 1, 1, 2)), { len: 72, spf: 576, sr: 8000 });       // MPEG2.5 L3 8k 8k
  assert.deepEqual(at(...header(3, 2, 10, 1)), { len: 576, spf: 1152, sr: 48000 });   // MPEG1 L2 192k 48k
  assert.deepEqual(at(...header(3, 3, 4, 0)), { len: 136, spf: 384, sr: 44100 });     // MPEG1 L1 128k 44.1k
});

test('rejects invalid headers', () => {
  const at = (...h) => mp3FrameAt(new Uint8Array(h), 0);
  assert.equal(at(0xff, 0xf1, 0x50, 0x80), null);        // AAC ADTS (layer bits 0)
  assert.equal(at(...header(1, 1, 9, 0)), null);          // reserved version
  assert.equal(at(...header(3, 1, 0, 0)), null);          // free bitrate
  assert.equal(at(...header(3, 1, 15, 0)), null);         // bad bitrate
  assert.equal(at(...header(3, 1, 9, 3)), null);          // reserved sample rate
  assert.equal(at(0xff, 0xfb), null);                     // truncated
});

test('indexes a plain MP3', async () => {
  const idx = await indexMp3(blob(frames(200)));
  assert.equal(idx.offsets.length, 200);
  assert.equal(idx.offsets[1], 417);
  assert.equal(idx.sr, 44100);
  assert.equal(idx.spf, 1152);
});

test('skips an ID3 tag, including one with a footer', async () => {
  const tag = id3(1000, true);
  const idx = await indexMp3(blob(tag, frames(100)));
  assert.equal(idx.offsets.length, 100);
  assert.equal(idx.offsets[0], tag.length);
});

test('drops the Xing/Info header frame', async () => {
  const f = frames(100);
  f.set([...'Xing'].map((c) => c.charCodeAt(0)), 36);
  const idx = await indexMp3(blob(f));
  assert.equal(idx.offsets.length, 99);
  assert.equal(idx.offsets[0], 417);
});

test('tolerates junk bytes before the first frame and between frames', async () => {
  const f = frames(100);
  const idx = await indexMp3(blob(new Uint8Array(300).fill(0x55), f.subarray(0, 417 * 50), new Uint8Array([0, 0xff, 0]), f.subarray(417 * 50)));
  assert.equal(idx.offsets.length, 100);
});

test('large cover art followed by padding is still an MP3 (review finding #3)', async () => {
  const idx = await indexMp3(blob(id3(1_500_000), new Uint8Array(64), frames(3000)));
  assert.ok(idx, 'indexed');
  assert.equal(idx.offsets.length, 3000);
});

test('cover art bigger than a fifth of a short file is still an MP3 (review finding #3)', async () => {
  const idx = await indexMp3(blob(id3(4_000_000), frames(4000)));
  assert.ok(idx, 'indexed');
  assert.equal(idx.offsets.length, 4000);
});

test('frames across the 4 MB read windows are all found', async () => {
  const n = Math.ceil((9 << 20) / 417);
  const idx = await indexMp3(blob(frames(n)));
  assert.equal(idx.offsets.length, n);
  for (let k = 1; k < n; k++) assert.equal(idx.offsets[k] - idx.offsets[k - 1], 417);
});

test('non-MP3 data is rejected', async () => {
  assert.equal(await indexMp3(blob(new Uint8Array(3 << 20).map((_, i) => (i * 7919) & 0xff))), null);
  assert.equal(await indexMp3(blob(new TextEncoder().encode('RIFF....WAVEfmt '), new Uint8Array(1 << 20))), null);
  assert.equal(await indexMp3(blob(frames(10))), null); // too short to trust
});

test('a real encoded MP3 indexes to its true duration', async () => {
  const require = createRequire(import.meta.url);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(require.resolve('lamejs/lame.min.js'), 'utf8'), ctx);
  const enc = new ctx.lamejs.Mp3Encoder(2, 44100, 128);
  const secs = 20;
  const parts = [];
  const block = 1152;
  const L = new Int16Array(block);
  for (let n = 0; n < 44100 * secs; n += block) {
    for (let k = 0; k < block; k++) L[k] = Math.round(8000 * Math.sin(((n + k) * 2 * Math.PI * 440) / 44100));
    parts.push(new Uint8Array(enc.encodeBuffer(L, L)));
  }
  parts.push(new Uint8Array(enc.flush()));
  const idx = await indexMp3(blob(id3(500), ...parts));
  const duration = (idx.offsets.length * idx.spf) / idx.sr;
  assert.ok(Math.abs(duration - secs) < 0.1, `duration ${duration}`);
});
