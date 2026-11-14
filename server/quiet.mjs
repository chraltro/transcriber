// Where an episode's audio goes quiet (lib/quiet.js), from a file or an address ffmpeg can read.
// The transcribing finds it on the way (server/transcribe.mjs); this is for the episodes that
// were transcribed before it did.
import { spawn } from 'node:child_process';
import { QuietFinder } from '../lib/quiet.js';

export async function quietOfAudio(input, { rate = 8000 } = {}) {
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => { err += d; });
  const failed = new Promise((_, reject) => ff.on('error', reject));
  const finder = new QuietFinder(rate);
  let carry = Buffer.alloc(0);
  const read = (async () => {
    for await (const chunk of ff.stdout) {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % 4);
      carry = buf.subarray(usable);
      finder.push(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usable)));
    }
    const code = await new Promise((r) => (ff.exitCode != null ? r(ff.exitCode) : ff.on('close', r)));
    if (code !== 0) throw new Error(`ffmpeg: ${err.trim().split('\n').pop() || `exit ${code}`}`);
  })();
  await Promise.race([read, failed]);
  return finder.finish();
}
