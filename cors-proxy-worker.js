// Optional: your own free CORS proxy on Cloudflare Workers (no API key needed).
// Use it if a podcast host blocks browser downloads and the public proxies are down.
//
// 1. dash.cloudflare.com -> Workers & Pages -> Create -> "Hello World" worker
// 2. Replace its code with this file and deploy
// 3. In the app, open "More options" and paste: https://<your-worker>.workers.dev/?url={url}

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const target = new URL(request.url).searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response('Pass ?url=https://...', { status: 400, headers: cors });
    }

    const upstream = await fetch(target, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (podcast-transcriber)' },
    });
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
