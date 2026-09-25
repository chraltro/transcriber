// WAV files can be cut into pieces too: the samples are one flat block after the header, so a
// piece is just a fresh header plus a slice of that block. Avoids decoding a huge file whole.

const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

// Returns { format, channels, sampleRate, blockAlign, dataStart, dataSize, fmt } or null.
export async function indexWav(blob) {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1 << 16)).arrayBuffer());
  if (head.length < 12 || ascii(head, 0, 4) !== 'RIFF' || ascii(head, 8, 4) !== 'WAVE') return null;
  const view = new DataView(head.buffer);
  let i = 12;
  let fmt = null;
  while (i + 8 <= head.length) {
    const id = ascii(head, i, 4);
    const size = view.getUint32(i + 4, true);
    if (id === 'fmt ') {
      fmt = head.slice(i + 8, i + 8 + size);
    } else if (id === 'data') {
      if (!fmt || fmt.length < 16) return null;
      const f = new DataView(fmt.buffer);
      const blockAlign = f.getUint16(12, true);
      if (!blockAlign) return null;
      // Some writers leave the data size at 0 or 0xFFFFFFFF when streaming; use the rest of the file.
      const rest = blob.size - (i + 8);
      const dataSize = size && size <= rest ? size - (size % blockAlign) : rest - (rest % blockAlign);
      return { format: f.getUint16(0, true), channels: f.getUint16(2, true), sampleRate: f.getUint32(4, true), blockAlign, dataStart: i + 8, dataSize, fmt };
    }
    i += 8 + size + (size & 1);
  }
  return null;
}

// A standalone WAV file holding `bytes` of sample data in the original format.
export function wavPiece(info, bytes) {
  const out = new Uint8Array(20 + info.fmt.length + 8 + bytes.length);
  const v = new DataView(out.buffer);
  const put = (i, s) => { for (let k = 0; k < s.length; k++) out[i + k] = s.charCodeAt(k); };
  put(0, 'RIFF');
  v.setUint32(4, out.length - 8, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, info.fmt.length, true);
  out.set(info.fmt, 20);
  const d = 20 + info.fmt.length;
  put(d, 'data');
  v.setUint32(d + 4, bytes.length, true);
  out.set(bytes, d + 8);
  return out;
}
