// Turning the cleaned audio into a file: 16-bit WAV, or MP3 through lamejs. Both take the audio
// a block at a time and hand back bytes as they go, so a whole episode never sits in memory.

export function toInt16(x) {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = x[i] < -1 ? -1 : x[i] > 1 ? 1 : x[i];
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

// The 44-byte header of a mono 16-bit PCM WAV with `samples` samples.
export function wavHeader(samples, rate) {
  const b = new ArrayBuffer(44);
  const v = new DataView(b);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  const bytes = samples * 2;
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, bytes, true);
  return new Uint8Array(b);
}

export class WavWriter {
  constructor(rate) { this.rate = rate; this.samples = 0; }
  push(x) { this.samples += x.length; return new Uint8Array(toInt16(x).buffer); }
  end() { return new Uint8Array(0); }
  // The header goes in front once the length is known.
  header() { return wavHeader(this.samples, this.rate); }
}

export class Mp3Writer {
  constructor(lamejs, rate, kbps = 192) {
    this.enc = new lamejs.Mp3Encoder(1, rate, kbps);
    this.rest = new Int16Array(0);
  }

  push(x) {
    const pcm = toInt16(x);
    const all = new Int16Array(this.rest.length + pcm.length);
    all.set(this.rest);
    all.set(pcm, this.rest.length);
    const parts = [];
    let i = 0;
    const step = 1152 * 8;
    for (; i + step <= all.length; i += step) parts.push(this.enc.encodeBuffer(all.subarray(i, i + step)));
    this.rest = all.slice(i);
    return concat(parts);
  }

  end() {
    const parts = [];
    if (this.rest.length) parts.push(this.enc.encodeBuffer(this.rest));
    parts.push(this.enc.flush());
    return concat(parts);
  }

  header() { return new Uint8Array(0); }
}

function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(new Uint8Array(p.buffer, p.byteOffset, p.length), o); o += p.length; }
  return out;
}
