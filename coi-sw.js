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
  // Not kept, and not touched at all: the server's answers (api/), transcripts and audio
  // (library/, enhance/), and anything asked for in byte ranges. Those go to the network as if
  // this worker were not there.
  const SHELL = 'transcriber-shell-3';
  // Safari's engine (every browser on an iPhone) doesn't isolate a page on these headers, so
  // there they would be for nothing: the network's own answers are handed on as they are.
  const PLAIN = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//.test(navigator.userAgent);
  const SLOW_MS = 4000;
  const scope = new URL(self.registration.scope).pathname;
  const live = new Map(); // page (client id) -> did it come from the network?

  self.addEventListener('install', () => self.skipWaiting());
  // Copies kept by an earlier version of this worker go (they were answers this worker had
  // rebuilt; what is kept now is the network's own).
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

  // The file itself, by its address, not the page's request as it came: in Safari that can carry
  // the page's own "has it changed since my copy?", and the empty "no" it gets back can be neither
  // kept nor survived by every kind of load there. Asked for this way, the browser's own cache
  // underneath this worker asks the server that question with its own copy, and hands back the
  // whole file either way: an unchanged file costs a 304 on the network, and this worker still
  // gets a 200 to answer with and to keep. (The server marks its files no-cache, so even an
  // engine that ignored the cache mode here would ask.)
  const ask = (req) => fetch(req.url, { cache: 'no-cache', credentials: 'same-origin', redirect: req.redirect });
  // And should an empty "no" reach this worker all the same, the whole file, fetched again.
  const whole = (req) => fetch(req.url, { cache: 'reload', credentials: 'same-origin', redirect: req.redirect });

  async function shell(e, url) {
    const req = e.request;
    const cache = await caches.open(SHELL);
    const page = req.mode === 'navigate';
    // The page is the page whatever was added to its address (?url=...).
    const key = page ? url.origin + url.pathname : req;
    const kept = await cache.match(key);
    const given = { up: false }; // given up on: an answer that comes late is not kept either
    const out = (res) => (PLAIN ? res : isolated(res));
    const fresh = () => ask(req).then((res) => (res.status === 304 ? whole(req) : res)).then((res) => {
      // Keeping a copy must never cost the page its file: the copy is taken from the network's
      // own answer, and whatever goes wrong with it stays here.
      try {
        if (res.status === 200 && !given.up) cache.put(key, out(res.clone())).catch(() => {});
      } catch {}
      return out(res);
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
    if (!ours) return;
    // (If keeping copies fails in some way of its own, the file still comes from the network.)
    e.respondWith(shell(e, url).catch(() => fetch(req)));
  });
} else {
  (() => {
    if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
    // A worker the app would not start under on this device is left off (index.html decides,
    // when loading it again didn't help), until a newer one comes or three days have passed.
    const VERSION = '3';
    window.__workerVersion = VERSION;
    try {
      const off = JSON.parse(localStorage.getItem('pod-no-worker') || 'null');
      if (off && off.v === VERSION && Date.now() - off.at < 3 * 864e5) {
        navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister())).catch(() => {});
        return;
      }
    } catch {}
    if (window.crossOriginIsolated) return;
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
      window.__leaving = true; // (the files this cuts off mid-load are not a failed start)
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
