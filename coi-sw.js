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
  const SHELL = 'transcriber-shell-2';
  const SLOW_MS = 4000;
  const scope = new URL(self.registration.scope).pathname;
  const live = new Map(); // page (client id) -> did it come from the network?

  self.addEventListener('install', () => self.skipWaiting());
  // Copies kept by an earlier version of this worker go: they were kept with headers that
  // described the packed file, not the unpacked one in them.
  self.addEventListener('activate', (e) => e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('transcriber-shell') && k !== SHELL).map((k) => caches.delete(k)))).catch(() => {}).then(() => self.clients.claim())
  ));

  const isolated = (res) => {
    if (res.status === 0) return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    // A packed file arrives here unpacked: headers that still say it is packed, and how long it
    // was while it was, are no longer true of what is handed on.
    if (headers.has('Content-Encoding')) {
      headers.delete('Content-Encoding');
      headers.delete('Content-Length');
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  // The whole file, whatever the page's own cache asked: in Safari the question "has it changed
  // since my copy?" reaches this worker with the request, and an empty "no" for an answer is not
  // something every kind of load there survives.
  const whole = (req) => fetch(req.url, { cache: 'reload', credentials: 'same-origin' });

  async function shell(e, url) {
    const req = e.request;
    const cache = await caches.open(SHELL);
    const page = req.mode === 'navigate';
    // The page is the page whatever was added to its address (?url=...).
    const key = page ? url.origin + url.pathname : req;
    const kept = await cache.match(key);
    const given = { up: false }; // given up on: an answer that comes late is not kept either
    const fresh = () => fetch(req).then((res) => (res.status === 304 ? whole(req) : res)).then((res) => {
      // Keeping a copy must never cost the page its file: the copy is taken from the network's
      // own answer, and whatever goes wrong with it stays here.
      try {
        if (res.status === 200 && !given.up) {
          const copy = isolated(res.clone());
          cache.put(key, copy).catch(() => {});
        }
      } catch {}
      return isolated(res);
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
    // (If keeping copies fails in some way of its own, the file still comes from the network.)
    e.respondWith(ours ? shell(e, url).catch(() => fetch(req).then(isolated)) : fetch(req).then(isolated));
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
