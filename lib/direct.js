// Many shows hand out their audio through counting services: the address in the feed goes to
// the service, which notes the download and passes it on to where the file is. Content blockers
// stop those services, and then the episode doesn't play. The file's own address is in the
// service's, after its own part: https://dts.podtrac.com/redirect.mp3/traffic.megaphone.fm/x.mp3
// is traffic.megaphone.fm/x.mp3. The player tries it when the address from the feed fails.

const SERVICES = new Set([
  'dts.podtrac.com', 'www.podtrac.com', 'podtrac.com', 'chtbl.com', 'chrt.fm', 'pdst.fm', 'op3.dev', 'mgln.ai',
  'prfx.byspotify.com', 'pscrb.fm', 'verifi.podscribe.com', 'claritaspod.com', 'clrtpod.com', 'arttrk.com', 'swap.fm',
  'tracking.swap.fm', 'growx.podkite.com', 'pfx.vpixl.com', 'pdcn.co', 'gum.fm', '2.gum.fm', 'rss.pdrl.fm', 'p.podderapp.com',
]);
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const FILE = /\.(mp3|m4a|mp4|aac|ogg|oga|opus|wav|flac)$/i;

// The address behind the counting services in `url`, or `url` itself when there are none (or it
// can't be read out of it).
export function directUrl(url) {
  let out = String(url || '');
  for (let i = 0; i < 6; i++) {
    let u;
    try { u = new URL(out); } catch { return out; }
    if (!SERVICES.has(u.hostname.toLowerCase())) return out;
    const parts = u.pathname.split('/').filter(Boolean);
    // The first part of the path that is a host's name (and not a file's, as in redirect.mp3).
    const at = parts.findIndex((p, k) => k < parts.length - 1 && HOST.test(p) && !FILE.test(p));
    if (at < 0) return out;
    out = `https://${parts.slice(at).join('/')}${u.search}`;
  }
  return out;
}
