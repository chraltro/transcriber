// Optional: your own free CORS proxy on Cloudflare Workers (no API key needed).
// Use it if a podcast host blocks browser downloads.
//
// 1. dash.cloudflare.com -> Workers & Pages -> Create -> "Hello World" worker
// 2. Replace its code with this file, set ALLOWED_ORIGIN below to your site, and deploy
// 3. In the app, open "More options" and paste: https://<your-worker>.workers.dev/?url={url}

// Only pages on this origin may use the proxy, so strangers can't run traffic through it.
// Use '*' to allow any site.
const ALLOWED_ORIGIN = 'https://YOUR-USERNAME.github.io';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGIN === '*' || origin === ALLOWED_ORIGIN;
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Range, Accept-Ranges',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!allowed) return new Response('Origin not allowed', { status: 403, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response('Pass ?url=https://...', { status: 400, headers: cors });
    }

    const forward = { 'User-Agent': 'Mozilla/5.0 (podcast-transcriber)' };
    const range = request.headers.get('Range');
    if (range) forward.Range = range;
    const upstream = await fetch(target, { method: request.method, redirect: 'follow', headers: forward });
    const headers = new Headers(upstream.headers);
    for (const h of ['set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials']) headers.delete(h);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
