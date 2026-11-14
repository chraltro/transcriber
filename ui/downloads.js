// Episodes kept on this device for listening without a connection (Cache Storage, a file each).
// Which copy is kept matters: the server's copy of an episode it transcribed lines up with the
// transcript (and its ad marks); the podcast's own may carry other ads.
const CACHE = 'pod-audio';
const INDEX = 'pod-downloads';
const keyOf = (id) => `https://transcriber.invalid/pod?id=${encodeURIComponent(id)}`;

export class Downloads extends EventTarget {
  // open(ep) -> { response, from: 'server' | 'origin' }: the audio, fetched however it can be.
  constructor({ open }) {
    super();
    this.open = open;
    this.active = new Map(); // id -> { loaded, total, ctl }
    try { this.index = JSON.parse(localStorage.getItem(INDEX)) || {}; } catch { this.index = {}; }
    // Ids whose stored file turned out to be gone (the browser cleared it): lost, not removed by
    // the listener. What keeps episodes by itself (ui/autosave.js) tells the two apart by this.
    this.lost = new Set();
    this.upgrading = new Set(); // saved copies being swapped for the server's (upgrade)
  }

  has(id) { return !!this.index[id]; }
  info(id) { return this.index[id] || null; }
  progress(id) { const a = this.active.get(id); return a ? (a.total ? a.loaded / a.total : 0) : null; }
  get ids() { return Object.keys(this.index); }
  get bytes() { return Object.values(this.index).reduce((n, d) => n + (d.bytes || 0), 0); }

  save() {
    try { localStorage.setItem(INDEX, JSON.stringify(this.index)); } catch {}
    this.dispatchEvent(new Event('change'));
  }

  // What the list says against what is really stored: the browser may have cleared it.
  async verify() {
    let cache;
    try { cache = await caches.open(CACHE); } catch { return; }
    const stored = new Set((await cache.keys()).map((r) => r.url));
    let changed = false;
    for (const id of Object.keys(this.index)) if (!stored.has(keyOf(id))) { this.lost.add(id); delete this.index[id]; changed = true; }
    for (const url of stored) {
      const id = decodeURIComponent(url.split('id=')[1] || '');
      if (!this.index[id] && !this.active.has(id) && !this.upgrading.has(id.replace(/&next$/, ''))) await cache.delete(url);
    }
    if (changed) this.save();
  }

  async blob(id) {
    if (!this.index[id]) return null;
    try {
      const hit = await (await caches.open(CACHE)).match(keyOf(id));
      if (hit) return await hit.blob();
    } catch {}
    this.lost.add(id);
    delete this.index[id];
    this.save();
    return null;
  }

  // auto: saved by itself (ui/autosave.js), which may also remove it again.
  async start(ep, { auto = false } = {}) {
    if (this.has(ep.id) || this.active.has(ep.id)) return;
    const ctl = new AbortController();
    const job = { loaded: 0, total: 0, ctl };
    this.active.set(ep.id, job);
    this.dispatchEvent(new Event('change'));
    try {
      navigator.storage?.persist?.().catch(() => {});
      const cache = await caches.open(CACHE);
      const { response, from } = await this.open(ep, ctl.signal);
      job.total = Number(response.headers.get('content-length')) || 0;
      let last = 0;
      const counted = response.body.pipeThrough(new TransformStream({
        transform: (chunk, out) => {
          job.loaded += chunk.length;
          if (performance.now() - last > 250) { last = performance.now(); this.dispatchEvent(new CustomEvent('progress', { detail: ep.id })); }
          out.enqueue(chunk);
        },
      }));
      await cache.put(keyOf(ep.id), new Response(counted, { headers: { 'content-type': response.headers.get('content-type') || 'audio/mpeg' } }));
      if (ctl.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const { id, sub = '', title = '', show = '', url = '', published = 0, duration = 0 } = ep;
      this.index[ep.id] = { bytes: job.loaded, from, at: Date.now(), ep: { id, sub, title, show, art: /^https?:/.test(ep.art || '') ? ep.art : '', url, published, duration }, ...(auto ? { auto: true } : {}) };
      this.active.delete(ep.id);
      this.save();
    } catch (err) {
      this.active.delete(ep.id);
      try { await (await caches.open(CACHE)).delete(keyOf(ep.id)); } catch {}
      this.dispatchEvent(new Event('change'));
      if (err.name !== 'AbortError') throw err;
    }
  }

  // A copy saved from the podcast's own host, once the library's server has the copy its
  // transcript was made from: that one is saved in its place, so the transcript lines up with
  // what plays and its ads are skipped (a host puts other ads in each download). The old copy
  // stays until the new one is whole; if the server's cannot be had, nothing changes.
  async upgrade(id) {
    const had = this.index[id];
    if (!had || had.from === 'server' || this.active.has(id) || this.upgrading.has(id)) return false;
    this.upgrading.add(id);
    const next = `${keyOf(id)}&next`;
    let cache;
    try {
      cache = await caches.open(CACHE);
      const { response, from } = await this.open(had.ep, AbortSignal.timeout(20 * 60e3));
      if (from !== 'server') { response.body?.cancel?.().catch(() => {}); return false; }
      let bytes = 0;
      const counted = response.body.pipeThrough(new TransformStream({ transform: (chunk, out) => { bytes += chunk.length; out.enqueue(chunk); } }));
      await cache.put(next, new Response(counted, { headers: { 'content-type': response.headers.get('content-type') || 'audio/mpeg' } }));
      if (!this.index[id]) { await cache.delete(next); return false; } // removed meanwhile
      await cache.put(keyOf(id), await cache.match(next));
      await cache.delete(next);
      this.index[id] = { ...this.index[id], bytes, from: 'server', at: Date.now() };
      this.save();
      return true;
    } catch {
      try { await cache?.delete(next); } catch {}
      return false;
    } finally {
      this.upgrading.delete(id);
    }
  }

  cancel(id) { this.active.get(id)?.ctl.abort(); }

  async remove(id) {
    this.cancel(id);
    delete this.index[id];
    try { await (await caches.open(CACHE)).delete(keyOf(id)); } catch {}
    this.save();
  }

  async clear() {
    for (const id of [...this.active.keys()]) this.cancel(id);
    this.index = {};
    try { await caches.delete(CACHE); } catch {}
    this.save();
  }
}
