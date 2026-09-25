/*
 * Cross-origin isolation shim for static hosts like GitHub Pages.
 *
 * Multi-threaded WebAssembly needs SharedArrayBuffer, which browsers only
 * enable when the page is served with COOP/COEP headers. GitHub Pages can't
 * set headers, so this file registers itself as a service worker that adds
 * them to our own same-origin responses. Browsers that don't support
 * COEP "credentialless" simply stay single-threaded.
 */
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (new URL(req.url).origin !== self.location.origin) return;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

    e.respondWith(
      fetch(req).then((res) => {
        if (res.status === 0) return res;
        const headers = new Headers(res.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      })
    );
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
