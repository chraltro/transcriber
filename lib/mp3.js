// MP3 frame parsing, so an episode can be decoded a piece at a time instead of whole.

export const MP3_KBPS = {
  V1L1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  V1L2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  V1L3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  V2L1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  V2L23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
export const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export function mp3FrameAt(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = (b[i + 1] >> 1) & 3;   // 3 = I, 2 = II, 1 = III
  const brIndex = b[i + 2] >> 4;
  const srIndex = (b[i + 2] >> 2) & 3;
  const pad = (b[i + 2] >> 1) & 1;
  if (version === 1 || layer === 0 || brIndex === 0 || brIndex === 15 || srIndex === 3) return null;
  const v1 = version === 3;
  const table = v1 ? ['', 'V1L3', 'V1L2', 'V1L1'][layer] : layer === 3 ? 'V2L1' : 'V2L23';
  const bitrate = MP3_KBPS[table][brIndex] * 1000;
  const sr = MP3_RATES[version][srIndex];
  if (layer === 3) return { len: (Math.floor((12 * bitrate) / sr) + pad) * 4, spf: 384, sr };
  if (layer === 2) return { len: Math.floor((144 * bitrate) / sr) + pad, spf: 1152, sr };
  return { len: Math.floor(((v1 ? 144 : 72) * bitrate) / sr) + pad, spf: v1 ? 1152 : 576, sr };
}

// Byte offset of every audio frame, or null if this isn't a (clean) MP3. Reads the file
// 4 MB at a time so it never has to be in memory whole.
export async function indexMp3(blob) {
  const size = blob.size;
  const WINDOW = 4 << 20;
  const OVERLAP = 8192; // larger than any MP3 frame, so a frame and the next header always fit
  let win = new Uint8Array(await blob.slice(0, WINDOW + OVERLAP).arrayBuffer());
  let winStart = 0;
  let i = 0;
  if (win[0] === 0x49 && win[1] === 0x44 && win[2] === 0x33) {
    i = 10 + (((win[6] & 127) << 21) | ((win[7] & 127) << 14) | ((win[8] & 127) << 7) | (win[9] & 127)) + (win[5] & 0x10 ? 10 : 0);
  }
  // Cover art in the ID3 tag can be megabytes; everything below is measured from where audio starts.
  const audioStart = Math.min(i, size);
  const offsets = [];
  let spf = 0;
  let sr = 0;
  let covered = 0;
  let first = '';
  let synced = false;
  while (i < size - 4) {
    if (i - winStart + OVERLAP > win.length && winStart + win.length < size) {
      winStart = i;
      win = new Uint8Array(await blob.slice(i, i + WINDOW + OVERLAP).arrayBuffer());
    }
    const j = i - winStart;
    const f = mp3FrameAt(win, j);
    // While searching for sync, the next frame has to line up as well, so stray 0xFF bytes
    // aren't taken for frames. Once locked on, every valid header counts, like a decoder does.
    if (f && f.len > 4 && (synced || i + f.len >= size - 4 || mp3FrameAt(win, j + f.len))) {
      synced = true;
      if (!sr) {
        ({ sr, spf } = f);
        first = String.fromCharCode(...win.subarray(j, j + Math.min(f.len, 64)));
      }
      if (f.sr === sr && f.spf === spf) {
        offsets.push(i);
        covered += f.len;
      }
      i += f.len;
    } else {
      synced = false;
      i++;
      if (!offsets.length && i - audioStart > 1 << 20) return null;
    }
  }
  if (offsets.length < 50 || covered < (size - audioStart) * 0.8) return null;
  // Skip the Xing/Info/VBRI header frame: it holds metadata, and some decoders size their output from it.
  if (/Xing|Info|VBRI/.test(first)) offsets.shift();
  return { offsets, spf, sr };
}
