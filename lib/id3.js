// Reads the title, show and cover art podcasts embed in their MP3 files (ID3v2.2 to 2.4).
const latin1 = new TextDecoder('latin1');

export function id3Length(head) {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  return 10 + size + (head[5] & 0x10 ? 10 : 0);
}

const synchsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u24 = (b, i) => (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];

// "Unsynchronisation" inserts a zero after every 0xFF; undo it.
function resync(b) {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

function decodeText(enc, b) {
  let s;
  if (enc === 0) s = latin1.decode(b);
  else if (enc === 3) s = new TextDecoder('utf-8').decode(b);
  else if (enc === 2) s = new TextDecoder('utf-16be').decode(b);
  else if (b[0] === 0xfe && b[1] === 0xff) s = new TextDecoder('utf-16be').decode(b.subarray(2));
  else s = new TextDecoder('utf-16le').decode(b[0] === 0xff && b[1] === 0xfe ? b.subarray(2) : b);
  return s.replace(/\0[\s\S]*$/, '').trim();
}

// Index just past the terminator of a string starting at `i` in encoding `enc`.
function skipString(b, i, enc) {
  if (enc === 1 || enc === 2) {
    for (; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2;
    return b.length;
  }
  while (i < b.length && b[i] !== 0) i++;
  return i + 1;
}

function picture(d, v2) {
  const enc = d[0];
  let i = 1;
  let mime;
  if (v2) {
    const fmt = latin1.decode(d.subarray(1, 4)).toLowerCase();
    mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
    i = 4;
  } else {
    const end = skipString(d, 1, 0);
    mime = latin1.decode(d.subarray(1, end - 1)).toLowerCase() || 'image/jpeg';
    if (!mime.includes('/')) mime = `image/${mime === 'jpg' ? 'jpeg' : mime}`;
    i = end;
  }
  const type = d[i];
  i = skipString(d, i + 1, enc);
  return { type, mime, data: d.subarray(i) };
}

export function parseId3(bytes) {
  const total = id3Length(bytes);
  if (!total) return null;
  const ver = bytes[3];
  const flags = bytes[5];
  let tag = bytes.subarray(10, Math.min(bytes.length, 10 + synchsafe(bytes, 6)));
  if (flags & 0x80 && ver < 4) tag = resync(tag);
  let pos = 0;
  if (flags & 0x40 && ver >= 3) pos = ver === 3 ? 4 + u32(tag, 0) : synchsafe(tag, 0);

  const out = { title: '', artist: '', album: '', picture: null };
  const pics = [];
  const idLen = ver === 2 ? 3 : 4;
  const headLen = ver === 2 ? 6 : 10;
  while (pos + headLen <= tag.length) {
    const id = latin1.decode(tag.subarray(pos, pos + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    const size = ver === 2 ? u24(tag, pos + 3) : ver === 4 ? synchsafe(tag, pos + 4) : u32(tag, pos + 4);
    let data = tag.subarray(pos + headLen, pos + headLen + size);
    if (ver === 4) {
      const f = tag[pos + 9];
      if (f & 0x02) data = resync(data);
      if (f & 0x01) data = data.subarray(4);
    }
    pos += headLen + size;
    if (!data.length) continue;
    if (id === 'TIT2' || id === 'TT2') out.title = decodeText(data[0], data.subarray(1));
    else if (id === 'TPE1' || id === 'TP1') out.artist = decodeText(data[0], data.subarray(1));
    else if (id === 'TALB' || id === 'TAL') out.album = decodeText(data[0], data.subarray(1));
    else if (id === 'APIC' || id === 'PIC') pics.push(picture(data, ver === 2));
  }
  const pic = pics.find((p) => p.type === 3) || pics[0];
  if (pic?.data.length) out.picture = { mime: pic.mime, data: pic.data };
  return out;
}
