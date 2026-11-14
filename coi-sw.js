/*
 * Cross-origin isolation shim for static hosts like GitHub Pages.
 *
 * Multi-threaded WebAssembly needs SharedArrayBuffer, which browsers only
 * enable when the page is served with COOP/COEP headers. GitHub Pages can't
 * set headers, so this file registers itself as a service worker that adds
 * them to our own same-origin responses. Browsers that don't support
 * COEP "credentialless" simply stay single-threaded.
 *
 * It also keeps a copy of the app's own files, so the app opens offline.
 */
if (typeof window === 'undefined') {
  // The app's own files are also kept as they are fetched, so the app starts without a
  // connection (to play what was saved for offline) and on a bad one doesn't hang. The page
  // itself decides: when it comes from the network, so does everything it loads (the kept copy
  // only stands in for a file the network fails on); when the network fails or takes more than a
  // few seconds, the page and everything it loads come from the kept copies, so a start is
  // never half one version of the app and half another.
  // Not kept: the server's answers (api/), transcripts and audio (library/, enhance/), and
  // anything asked for in byte ranges.
  const SHELL = 'transcriber-shell';
  const SLOW_MS = 4000;
  const scope = new URL(self.registration.scope).pathname;
  const live = new Map(); // page (client id) -> did it come from the network?

  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

  const isolated = (res) => {
    if (res.status === 0) return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  async function shell(e, url) {
    const req = e.request;
    const cache = await caches.open(SHELL);
    const page = req.mode === 'navigate';
    // The page is the page whatever was added to its address (?url=...).
    const key = page ? url.origin + url.pathname : req;
    const kept = await cache.match(key);
    const given = { up: false }; // given up on: an answer that comes late is not kept either
    const fresh = () => fetch(req).then((res) => {
      const out = isolated(res);
      if (res.status === 200 && !given.up) cache.put(key, out.clone()).catch(() => {});
      return out;
    });
    if (page) {
      if (live.size > 40) live.delete(live.keys().next().value);
      if (!kept) { live.set(e.resultingClientId, true); return fresh(); }
      const got = await Promise.race([
        fresh().then((res) => ({ res, ok: true }), () => ({ res: kept, ok: false })),
        new Promise((resolve) => setTimeout(() => resolve({ res: kept, ok: false }), SLOW_MS)),
      ]);
      given.up = !got.ok;
      live.set(e.resultingClientId, got.ok);
      return got.res;
    }
    if (kept && live.get(e.clientId) === false) return kept;
    return kept ? fresh().catch(() => kept) : fresh();
  }

  self.addEventListener('fetch', (e) => {
    const req = e.request;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
    const rel = url.pathname.startsWith(scope) ? url.pathname.slice(scope.length) : url.pathname;
    const ours = req.method === 'GET' && !req.headers.has('range') && !/^(api|library|enhance)\//.test(rel);
    e.respondWith(ours ? shell(e, url) : fetch(req).then(isolated));
  });
} else {
  (() => {
    if (window.crossOriginIsolated || !window.isSecureContext || !('serviceWorker' in navigator)) return;
    // Already controlled but still not isolated: the browser doesn't support it. Don't loop.
    if (navigator.serviceWorker.controller) return;
    // sessionStorage throws in some privacy modes; without it there is no loop guard, so do nothing.
    let store;
    try { store = window.sessionStorage; store.getItem('x'); } catch { return; }
    if (store.getItem('coi-reloaded')) return;

    const reload = () => {
      // Never throw away work in progress; isolation then kicks in on the next visit.
      if (window.__transcriberBusy) return;
      store.setItem('coi-reloaded', '1');
      location.reload();
    };
    navigator.serviceWorker.register(document.currentScript.src).then((reg) => {
      if (!reg) return;
      if (reg.active) return reload();
      const sw = reg.installing || reg.waiting;
      sw?.addEventListener('statechange', () => sw.state === 'activated' && reload());
    }).catch((err) => console.warn('COI service worker failed to register:', err));
  })();
}
