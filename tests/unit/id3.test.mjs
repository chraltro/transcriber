import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id3Length, parseId3 } from '../../lib/id3.js';

const bytes = (...parts) => {
  const arrs = parts.map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const safe = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
const be = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const frame3 = (id, data) => bytes(id, be(data.length), [0, 0], data);
const frame4 = (id, data) => bytes(id, safe(data.length), [0, 0], data);
const tag = (ver, frames) => bytes('ID3', [ver, 0, 0], safe(frames.length + 16), frames, new Uint8Array(16));
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

test('ID3v2.3: title, artist, album (UTF-16 with BOM) and the front cover', () => {
  const utf16 = (s) => bytes([1, 0xff, 0xfe], new Uint8Array(new Uint16Array([...s].map((c) => c.charCodeAt(0))).buffer), [0, 0]);
  const t = tag(3, bytes(
    frame3('TIT2', utf16('Ærlig talt, del 2')),
    frame3('TPE1', bytes([0], 'NRK', [0])),
    frame3('TALB', bytes([3], 'Abels tårn')),
    frame3('APIC', bytes([0], 'image/png', [0], [0x01], 'icon', [0], Uint8Array.from([9, 9]))),
    frame3('APIC', bytes([0], 'image/jpeg', [0], [0x03], 'cover', [0], JPEG)),
  ));
  assert.equal(id3Length(t), t.length);
  const r = parseId3(t);
  assert.equal(r.title, 'Ærlig talt, del 2');
  assert.equal(r.artist, 'NRK');
  assert.equal(r.album, 'Abels tårn');
  assert.equal(r.picture.mime, 'image/jpeg');
  assert.deepEqual([...r.picture.data], [...JPEG]);
});

test('ID3v2.4: synchsafe frame sizes and UTF-8', () => {
  const r = parseId3(tag(4, bytes(frame4('TIT2', bytes([3], 'Episode 12: Ødegaard')), frame4('APIC', bytes([3], 'image/jpeg', [0], [3], 'c', [0], JPEG)))));
  assert.equal(r.title, 'Episode 12: Ødegaard');
  assert.equal(r.picture.data.length, JPEG.length);
});

test('ID3v2.2 three-letter frames', () => {
  const f = (id, data) => bytes(id, [(data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff], data);
  const r = parseId3(tag(2, bytes(f('TT2', bytes([0], 'Old tag')), f('PIC', bytes([0], 'PNG', [3], 'd', [0], Uint8Array.from([7, 7, 7]))))));
  assert.equal(r.title, 'Old tag');
  assert.equal(r.picture.mime, 'image/png');
  assert.deepEqual([...r.picture.data], [7, 7, 7]);
});

test('no tag, or a truncated one, is handled', () => {
  assert.equal(parseId3(Uint8Array.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0])), null);
  const t = tag(3, frame3('TIT2', bytes([0], 'Cut off')));
  assert.equal(parseId3(t.subarray(0, 14)).title, '');
});
