// Small DOM helpers shared by the podcast screens and the player (ui/pod.js, ui/playerui.js):
// building elements, the sheet that slides over the page, the menu behind a row's three dots.

// h('button.btn.ghost', { type: 'button', onclick }, icon('play'), 'Play')
export function h(tag, attrs = {}, ...kids) {
  const [name, ...cls] = tag.split('.');
  const e = document.createElement(name || 'div');
  if (cls.length) e.className = cls.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean') e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid);
  return e;
}

export function icon(name, cls = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export const setIcon = (button, name) => button.querySelector('use')?.setAttribute('href', `#i-${name}`);

// "Today", "Yesterday", "Tuesday", "3 Nov", "3 Nov 2025"
export function whenText(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: days > 300 || days < 0 ? 'numeric' : undefined });
}

export const fmtBytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

/* ---------- the sheet ----------
 * One at a time, over the page: the player, an episode. As an iPhone's card sheets: it comes up
 * from the bottom on a spring while the page behind gives way (smaller, its corners rounded,
 * dimmed), and goes back down as the page comes forward again; a finger on it moves both, and a
 * flick down closes it. On a wider screen it comes in from the right, on the same springs. The
 * player's sheet grows out of the player bar instead, its cover, title and play button
 * travelling from the bar to their places, and shrinks back into it (`grow`). Under reduced
 * motion all of it happens at once. (The curves and times are tokens in style.css.) */

const pane = () => document.getElementById('sheet');
const back = () => document.getElementById('sheet-back');
let onClose = null;
let lastFocus = null;
let leaving = null; // while a closed sheet is on its way out: what stops waiting for it to be there
let ownBack = false; // the history step back is this page's own (a close), not the browser's
let grows = null; // the open sheet's pairs of [in the bar, in the sheet], when it grew from the bar
let waiting = []; // what waits for a closing sheet to be gone
let growing = []; // the motions of a sheet growing out of the player bar

const stillMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const phone = () => matchMedia('(max-width: 640px)').matches;
// (No motion on a phone while a transcript is being made: style.css says why.)
const busyPhone = () => document.body.classList.contains('busy') && matchMedia('(hover: none), (max-width: 640px)').matches;
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// A time token in milliseconds; the spring curves as written in style.css.
const msOf = (name, d) => { const v = token(name); const n = parseFloat(v); return Number.isFinite(n) ? (v.endsWith('ms') ? n : n * 1000) : d; };
export const spring = (small = false) => token(small ? '--spring-small' : '--spring') || 'cubic-bezier(0.2, 0.8, 0.2, 1)';
export const motionOff = () => stillMotion() || busyPhone();

/* The page behind a sheet on a phone. Each piece of it (the top bar, the page, the bars along
 * the bottom) is scaled about the same point, the middle of the top of the screen, so together
 * they move as one page; the page is clipped where the screen's top was, so nothing scrolled
 * away above it shows. */
const PIECES = '.topbar, .shell, .footer, .playbar, .tabbar';
const SCALE = 0.94;
const FALL = 6; // px the page's top comes down, out from under the status bar
let behind = null; // { x, y, els } while the page is (or is coming back from) given way
let behindDone = null;

// fn once el's transform has finished moving (its transition, or the animation given), or a
// while after it should have, should the end never be reported. Returns what calls it off.
function whenStill(el, ms, fn, anim = null) {
  let off = false;
  const end = (e) => {
    if (off || (e && e.type === 'transitionend' && (e.target !== el || e.propertyName !== 'transform'))) return;
    stop();
    fn();
  };
  const timer = setTimeout(end, ms * 3 + 500);
  const stop = () => { off = true; clearTimeout(timer); el.removeEventListener('transitionend', end); };
  if (anim) anim.finished.then(() => end(), () => {}); else el.addEventListener('transitionend', end);
  return stop;
}

function giveWay(on, { ms = 0, ease = '', now = false } = {}) {
  const body = document.body;
  behindDone?.();
  behindDone = null;
  if (on) {
    if (!phone() || motionOff()) return;
    if (!behind) {
      const top = Math.max(0, document.querySelector('.topbar')?.getBoundingClientRect().top || 0);
      const x = innerWidth / 2;
      const els = [...document.querySelectorAll(PIECES)];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        el.style.transformOrigin = `${x - r.left}px ${top - r.top}px`;
        if (el.classList.contains('shell')) el.style.clipPath = `inset(${Math.max(0, top - r.top)}px 0 0 0 round 10px 10px 0 0)`;
      }
      behind = { x, y: top, els };
      body.classList.add('receding');
    }
    for (const el of behind.els) { el.style.transitionDuration = ms ? `${ms}ms` : ''; el.style.transitionTimingFunction = ease; el.style.transform = ''; }
    body.classList.add('receded');
    return;
  }
  if (!behind) return;
  const { els } = behind;
  const instant = now || motionOff();
  for (const el of els) { el.style.transitionDuration = instant ? '0s' : ms ? `${ms}ms` : ''; el.style.transitionTimingFunction = ease; el.style.transform = ''; }
  body.classList.remove('receded');
  const settle = () => {
    for (const el of els) { el.style.transformOrigin = ''; el.style.clipPath = ''; el.style.transitionDuration = ''; el.style.transitionTimingFunction = ''; }
    body.classList.remove('receding');
    behind = null;
  };
  if (instant) { void body.offsetWidth; settle(); } else behindDone = whenStill(els[0], ms || msOf('--t-sheet-out', 360), settle);
}

// A finger on the sheet: f is how far it has gone, 0 open to 1 closed.
function follow(f) {
  if (!behind) return;
  const k = Math.min(1, Math.max(0, f));
  for (const el of behind.els) {
    el.style.transitionDuration = '0s';
    el.style.transform = `translateY(${FALL * (1 - k)}px) scale(${SCALE + (1 - SCALE) * k})`;
  }
}

// A rect measured on the page while it has given way, as it is when it has not.
function unbehind(r) {
  if (!behind || !document.body.classList.contains('receded')) return r;
  const { x, y } = behind;
  const left = x + (r.left - x) / SCALE;
  const top = y + (r.top - FALL - y) / SCALE;
  return { left, top, width: r.width / SCALE, height: r.height / SCALE };
}

// The sheet on its way out is gone: hidden, emptied, ready for the next.
function gone() {
  leaving?.();
  leaving = null;
  const p = pane();
  for (const a of p.getAnimations?.({ subtree: true }) || []) a.cancel();
  p.classList.add('hidden');
  p.classList.remove('closing', 'open');
  p.inert = false;
  p.style.transform = p.style.transition = p.style.opacity = '';
  p.replaceChildren();
  back().classList.add('hidden');
  back().classList.remove('closing', 'open');
  back().style.opacity = back().style.transition = '';
  grows = null;
  growing = [];
  const w = waiting;
  waiting = [];
  for (const done of w) done();
}

// When a closing sheet is gone (at once when there is none).
export const sheetGone = () => (leaving ? new Promise((done) => waiting.push(done)) : Promise.resolve());
export const sheetLeaving = () => !!leaving;

// Its pieces, where they are now and where they go: [[in the bar, in the sheet], ...]; and
// everything else in the sheet, which fades.
function travellers(pairs) {
  const ok = pairs.filter(([a, b]) => a && b && a.getClientRects().length && b.getClientRects().length);
  const moving = new Set(ok.map(([, b]) => b));
  const rest = [];
  const walk = (el) => {
    for (const kid of el.children) {
      if (moving.has(kid)) continue;
      if ([...moving].some((m) => kid.contains(m))) walk(kid); else rest.push(kid);
    }
  };
  walk(pane());
  return { ok, rest };
}

// Where el's first line of words starts, from the top left of its box; null for no words.
function wordsAt(el) {
  const t = el.firstChild;
  if (!t || t.nodeType !== 3 || !t.data.trim()) return null;
  const range = document.createRange();
  range.selectNodeContents(el);
  const line = range.getClientRects()[0];
  const box = el.getBoundingClientRect();
  return line ? { x: line.left - box.left, y: line.top - box.top } : null;
}

// The transform (about b's top left) that puts b, laid out at rect bAt, where a is (rect aAt),
// in a frame moved by dy. Words keep their shape: scaled by the ratio of the two type sizes,
// their first lines starting at the same point; anything else is stretched onto a's box.
function onto(a, aAt, b, bAt, dy) {
  const wa = wordsAt(a);
  const wb = wa && wordsAt(b);
  if (wa && wb) {
    const k = parseFloat(getComputedStyle(a).fontSize) / parseFloat(getComputedStyle(b).fontSize) || 1;
    return `translate(${aAt.left + wa.x - bAt.left - k * wb.x}px, ${aAt.top + wa.y - bAt.top - k * wb.y - dy}px) scale(${k})`;
  }
  return `translate(${aAt.left - bAt.left}px, ${aAt.top - bAt.top - dy}px) scale(${aAt.width / bAt.width}, ${aAt.height / bAt.height})`;
}

// The player bar grows into its sheet: the sheet comes up from the bar's top edge, the cover,
// title and play button go from the bar to their places in it, the rest fades in.
function growFrom(pairs, bar) {
  const p = pane();
  const ms = msOf('--t-sheet', 420);
  const easing = spring();
  p.style.transition = 'none';
  p.classList.add('open');
  // (all of it measured before anything moves: a started animation moves what is measured)
  const paneTop = p.getBoundingClientRect().top;
  const dy = bar.top - paneTop;
  const { ok, rest } = travellers(pairs.map(([a, b]) => [a, b]));
  const from = new Map(pairs.map(([a, , r]) => [a, r]));
  const moves = ok.map(([a, b]) => [b, onto(a, from.get(a), b, b.getBoundingClientRect(), dy)]);
  growing = [
    p.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: ms, easing }),
    // (the bar under it, then the sheet: a cross-fade while the two are in the same place)
    p.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1 }], { duration: ms }),
    ...moves.map(([b, t]) => b.animate([{ transform: t, transformOrigin: '0 0' }, { transform: 'none', transformOrigin: '0 0' }], { duration: ms, easing })),
    ...rest.map((el) => el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.15 }, { opacity: 1 }], { duration: ms * 0.75, easing: 'ease-out' })),
  ];
  void p.offsetWidth;
  p.style.transition = '';
}

// ...and shrinks back into it. (Returns the sheet's own motion, to wait for.)
function shrinkInto(pairs, ms) {
  const p = pane();
  const easing = spring();
  const bar = unbehind(pairs.bar.getBoundingClientRect());
  const paneTop = p.getBoundingClientRect().top;
  const dy = bar.top - paneTop;
  const { ok, rest } = travellers(pairs.list);
  const moves = ok.map(([a, b]) => [b, onto(a, unbehind(a.getBoundingClientRect()), b, b.getBoundingClientRect(), dy)]);
  p.style.transition = 'none';
  const way = p.animate([{ transform: 'none' }, { transform: `translateY(${dy}px)` }], { duration: ms, easing, fill: 'forwards' });
  // (it fades once its pieces are all but on the bar's, so what is left is the bar, and the
  // sections along the bottom under it come back with no step at the end)
  p.animate([{ opacity: 1 }, { opacity: 1, offset: 0.55 }, { opacity: 0, offset: 0.9 }, { opacity: 0 }], { duration: ms, fill: 'forwards' });
  for (const [b, t] of moves) b.animate([{ transform: 'none', transformOrigin: '0 0' }, { transform: t, transformOrigin: '0 0' }], { duration: ms, easing, fill: 'forwards' });
  for (const el of rest) el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.4, easing: 'ease-out', fill: 'forwards' });
  return way;
}

// grow: () => ({ bar, list: [[in the bar, in the sheet], ...] }), for a sheet that comes out of
// the player bar and goes back into it.
export function openSheet(content, { name = '', closed = null, grow = null } = {}) {
  const p = pane();
  const turned = !!leaving; // closed and on its way out: it turns and comes back
  if (leaving) {
    leaving();
    leaving = null;
    for (const a of p.getAnimations?.({ subtree: true }) || []) a.cancel();
    p.classList.remove('closing');
    back().classList.remove('closing');
    p.inert = false;
    p.style.transition = p.style.opacity = '';
  }
  const wasOpen = !p.classList.contains('hidden') && !turned;
  if (wasOpen) onClose?.();
  else lastFocus = document.activeElement;
  onClose = closed;
  const fresh = p.classList.contains('hidden');
  // The bar as it is before the page gives way: where a sheet that grows from it starts.
  const growing = grow && fresh && phone() && !motionOff() ? grow() : null;
  const start = growing && growing.bar.getClientRects().length ? { bar: growing.bar.getBoundingClientRect(), pairs: growing.list.map(([a, b]) => [a, b, a?.getBoundingClientRect()]) } : null;
  grows = grow;
  p.replaceChildren(content);
  p.dataset.sheet = name;
  p.classList.remove('hidden');
  back().classList.remove('hidden');
  document.body.classList.add('sheet-open');
  if (!wasOpen && !history.state?.sheet) history.pushState({ ...history.state, sheet: true }, '');
  p.scrollTop = 0;
  p.style.transform = '';
  p.style.transitionDuration = p.style.transitionTimingFunction = '';
  back().style.opacity = back().style.transitionDuration = '';
  // (from its edge: laid out there first, then moved; under reduced motion, in place at once)
  if (fresh) void p.offsetWidth;
  if (motionOff()) p.style.transition = back().style.transition = 'none';
  giveWay(true);
  back().classList.add('open');
  // Growing out of the bar waits for its owner to fill it (the same task, before it is drawn),
  // so its pieces are measured where they end up.
  if (start) queueMicrotask(() => { if (pane() === p && p.contains(content)) growFrom(start.pairs, start.bar); else p.classList.add('open'); });
  else p.classList.add('open');
  p.focus({ preventScroll: true });
}

// On a phone the sheet is pulled down to close it: by its top edge, or from anywhere once it
// is scrolled to the top. It follows the finger, and the page behind with it, from wherever it
// was (one still on its way up is caught where it is); let go, it goes on the way it was going
// if that was down fast enough or far enough, back up otherwise. Pulled up where it has nothing
// more to show, it gives a little and springs back.
function dragToClose(p) {
  let y0 = null;
  let dy = 0;
  let base = 0; // where the finger caught it
  let h = 1;
  let pulled = false;
  let trail = [];
  const rubber = (x) => (1 - 1 / ((x * 0.55) / 60 + 1)) * 60;
  p.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !phone() || leaving) return;
    const fromTop = e.touches[0].clientY - p.getBoundingClientRect().top < 120;
    y0 = p.scrollTop <= 0 && !e.target.closest('.score') && (fromTop || !e.target.closest('input, .notes, .mini-seg')) ? e.touches[0].clientY : null;
    dy = 0;
    pulled = false;
    h = p.offsetHeight || 1;
    trail = [{ y: e.touches[0].clientY, t: performance.now() }];
  }, { passive: true });
  p.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const y = e.touches[0].clientY;
    dy = y - y0;
    trail.push({ y, t: performance.now() });
    if (trail.length > 6) trail.shift();
    if (p.scrollTop > 0) { y0 = null; if (pulled) settle(); pulled = false; return; }
    // Up, in a sheet that scrolls: it scrolls.
    if (dy < 0 && p.scrollHeight > p.clientHeight + 1) { if (dy < -4) { y0 = null; if (pulled) settle(); pulled = false; } return; }
    if (e.cancelable) e.preventDefault();
    if (!pulled) {
      // (the grow out of the bar is let finish; a slide still under way is taken where it is)
      for (const a of growing.splice(0)) a.finish();
      base = Math.max(0, new DOMMatrix(getComputedStyle(p).transform).m42 || 0);
      pulled = true;
    }
    const want = base + dy;
    const at = want >= 0 ? want : -rubber(-want);
    p.style.transition = 'none';
    p.style.transform = `translateY(${at}px)`;
    back().style.transition = 'none';
    back().style.opacity = String(1 - Math.max(0, at) / h);
    follow(Math.max(0, at) / h);
  }, { passive: false });
  // Back up, on the livelier spring.
  const settle = () => {
    const ms = 320;
    const ease = spring(true);
    p.style.transition = `transform ${ms}ms ${ease}`;
    p.style.transform = '';
    back().style.transition = `opacity ${ms}ms ${ease}`;
    back().style.opacity = '';
    giveWay(true, { ms, ease });
  };
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    if (!pulled) return;
    pulled = false;
    const at = base + dy;
    // How fast it was going, over the last moment of the touch (px a millisecond, down positive).
    const last = trail.at(-1);
    const first = trail.find((x) => last.t - x.t <= 90) || trail[0];
    const v = Math.max(-5, Math.min(5, (last.y - first.y) / Math.max(1, last.t - first.t)));
    if (at > 0 && (v > 0.5 || at + v * 160 > Math.min(h * 0.35, 240))) {
      // On down: as fast as the finger was going, on the settled spring (whose start is about
      // 1.6 times its average speed), but no slower than a close and no faster than a flick.
      const left = Math.max(0, h - at);
      const ms = Math.round(Math.max(170, Math.min(msOf('--t-sheet-out', 360), (1.6 * left) / Math.max(v, 0.1))));
      closeSheet({ ms });
    } else settle();
    dy = 0;
  };
  p.addEventListener('touchend', end);
  p.addEventListener('touchcancel', end);
}

export const sheetOpen = (name) => !pane().classList.contains('hidden') && !leaving && (!name || pane().dataset.sheet === name);

// Closed: done with at once (its owner told, focus back where it was), then it goes back to its
// edge, or into the player bar it came from, from wherever a finger left it, and is emptied when
// it is there. ms: how long that takes (a flick's speed); glide: false for at once.
function hideSheet({ glide = true, ms = 0 } = {}) {
  const p = pane();
  if (p.classList.contains('hidden') || leaving) return;
  document.body.classList.remove('sheet-open');
  const done = onClose;
  onClose = null;
  const into = glide && !ms && grows && phone() && !motionOff() ? grows() : null;
  const time = ms || msOf('--t-sheet-out', 360);
  const ease = spring();
  p.classList.add('closing');
  back().classList.add('closing');
  p.inert = true;
  if (!glide || motionOff()) {
    giveWay(false, { now: true });
    done?.();
    gone();
  } else {
    let way = null;
    if (into && into.bar.getClientRects().length) way = shrinkInto(into, time);
    else {
      p.style.transition = `transform ${time}ms ${ease}`;
      p.style.transform = '';
    }
    back().style.transition = `opacity ${time}ms ${ease}`;
    back().style.opacity = '';
    giveWay(false, { ms: time, ease });
    p.classList.remove('open');
    back().classList.remove('open');
    // (gone when it is there: its own end, not a timer, which a slow phone's frames can outrun)
    leaving = whenStill(p, time, gone, way);
    done?.();
  }
  lastFocus?.focus?.({ preventScroll: true });
}

// then: what to do once it is closed, when that goes somewhere else in the app. It waits for
// the step back in history the close takes: going somewhere before that step is taken, the step
// would land after it and undo it. ms: how long its way down takes (a flick).
let afterBack = null;
export function closeSheet({ then = null, ms = 0 } = {}) {
  if (!sheetOpen()) { then?.(); return; }
  hideSheet({ ms }); // at once, not a few frames later when the step back has been taken
  if (history.state?.sheet) {
    ownBack = true;
    if (then) {
      afterBack = then;
      // (Should the step never be reported, it is done anyway in a moment.)
      setTimeout(() => { if (afterBack === then) { afterBack = null; then(); } }, 400);
    }
    history.back();
  } else then?.();
}

// Whether the browser animated a step back itself (iOS Safari's edge swipe, Chrome's predictive
// back): then the page changes at once under it. Where the browser does not say, an iPhone's
// Safari outside a home-screen app is taken to have; a home-screen app, which has no such
// animation, and every other browser, not.
const IOS = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
export const browserAnimated = (e) => e?.hasUAVisualTransition ?? (IOS && !(navigator.standalone || matchMedia('(display-mode: standalone)').matches));

// (Nothing here touches the page until it is there: the tests load this file without one.)
const inPage = typeof window !== 'undefined' && typeof document !== 'undefined';
if (inPage) {
  if (pane()) dragToClose(pane());
  window.addEventListener('popstate', (e) => {
    const ours = ownBack;
    ownBack = false;
    const next = afterBack;
    afterBack = null;
    if (next) setTimeout(next, 0);
    // The step back a close took: the sheet is already on its way (or another was opened since,
    // which then gets its own step to be closed by).
    if (ours) { if (sheetOpen() && !history.state?.sheet) history.pushState({ ...history.state, sheet: true }, ''); return; }
    // The back gesture or button: down it goes, unless the browser has drawn its own way back.
    if (!history.state?.sheet) hideSheet({ glide: !browserAnimated(e) });
  });
  // (Without a listener for touches an iPhone shows no :active state, the press feedback.)
  document.addEventListener('touchstart', () => {}, { passive: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen() && !menuOpen()) { e.preventDefault(); closeSheet(); } });
  document.addEventListener('click', (e) => { if (e.target === back()) closeSheet(); });
  // (A finger on the shade does not scroll the page under it.)
  back()?.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
}

/* ---------- the menu behind a row's three dots ----------
 * It grows out of the button that opened it on a spring and shrinks back into it (style.css
 * .menu-pop.floating); its items give under the finger as buttons do (ui/motion.js). */

const menuEl = () => document.getElementById('row-menu');
const menuOpen = () => menuEl().classList.contains('open');

export function closeMenu() {
  const m = menuEl();
  m.classList.remove('open');
  m._anchor?.setAttribute('aria-expanded', 'false');
  m._anchor = null;
}

// items: [{ label, hint, icon, danger, action }] (falsy entries are left out)
export function openMenu(anchor, items) {
  const m = menuEl();
  if (m._anchor === anchor) { closeMenu(); return; }
  closeMenu();
  m.replaceChildren(...items.filter(Boolean).map((it) => h('button', {
    type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '',
    onclick: () => { closeMenu(); it.action(); },
  }, h('b', { text: it.label }), it.hint ? h('span', { text: it.hint }) : null)));
  m._anchor = anchor;
  m._at = performance.now();
  m._y = window.scrollY;
  anchor.setAttribute('aria-expanded', 'true');
  // Under the button, or above it near the bottom of the screen; never off the side. (Measured
  // while still closed: closed, it is laid out and only clipped away.)
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth;
  const hgt = m.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  const below = r.bottom + 6 + hgt <= window.innerHeight - 8;
  m.style.left = `${left}px`;
  m.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - hgt - 6)}px`;
  // It grows out of its button, from the corner nearest it (a long-pressed row: under the middle
  // of the row): settled there first, without a motion. (style.css .menu-pop.floating)
  m.style.setProperty('--from-x', `${Math.max(0, Math.min(w, (r.width > 120 ? r.left + r.width / 2 : r.right - 6) - left))}px`);
  m.style.setProperty('--from-y', below ? '0px' : `${hgt}px`);
  m.style.transition = 'none';
  m.classList.toggle('up', !below);
  void m.offsetWidth;
  m.style.transition = '';
  m.classList.add('open');
  m.querySelector('button')?.focus({ preventScroll: true });
}

if (inPage) {
  document.addEventListener('click', (e) => {
    const m = menuEl();
    if (m && menuOpen() && !m.contains(e.target) && !m._anchor?.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (!menuOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); const a = menuEl()._anchor; closeMenu(); a?.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = [...menuEl().querySelectorAll('button')];
      const i = list.indexOf(document.activeElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    }
  });
  // Scrolling away closes it, but not the tail of a scroll that was still settling when it
  // opened (a tap during a flick).
  window.addEventListener('scroll', () => {
    const m = menuEl();
    if (!menuOpen()) return;
    if (performance.now() - m._at < 350) { m._y = window.scrollY; return; }
    if (Math.abs(window.scrollY - m._y) > 12) closeMenu();
  }, { passive: true });
  window.addEventListener('resize', () => { if (menuOpen()) closeMenu(); });
}

/* ---------- show notes ----------
 * Feeds carry HTML written by anyone. Only its structure is kept: paragraphs, lists, links
 * (opened in a new tab), emphasis; everything else, scripts and images included, is dropped to
 * its text. Times in the notes ("12:30") become buttons that go there. */

const KEEP = { P: 'p', DIV: 'p', UL: 'ul', OL: 'ol', LI: 'li', B: 'strong', STRONG: 'strong', BLOCKQUOTE: 'blockquote', H1: 'h4', H2: 'h4', H3: 'h4', H4: 'h4', H5: 'h4', H6: 'h4' };
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'VIDEO', 'AUDIO', 'SVG', 'FORM', 'INPUT', 'BUTTON', 'LINK', 'META', 'TEMPLATE', 'NOSCRIPT']);
const TIME = /(\(?\b\d{1,2}:\d{2}(?::\d{2})?\b\)?)/;

export function notesNode(html, { timeOf, onTime } = {}) {
  const out = h('div.notes');
  const source = /<[a-z][\s\S]*>/i.test(html || '') ? html : (html || '').split(/\n{2,}/).map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('');
  const doc = new DOMParser().parseFromString(`<body>${source}</body>`, 'text/html');
  const text = (value, into) => {
    for (const piece of value.split(TIME)) {
      const t = timeOf && TIME.test(piece) ? timeOf(piece) : null;
      if (t != null) into.append(h('button.note-time', { type: 'button', text: piece, onclick: () => onTime?.(t) }));
      else if (piece) into.append(piece);
    }
  };
  const walk = (node, into) => {
    for (const kid of node.childNodes) {
      if (kid.nodeType === 3) { text(kid.nodeValue, into); continue; }
      if (kid.nodeType !== 1 || DROP.has(kid.tagName.toUpperCase())) continue;
      const tag = kid.tagName.toUpperCase();
      if (tag === 'BR') { into.append(document.createElement('br')); continue; }
      if (tag === 'A') {
        let href = '';
        try { const u = new URL(kid.getAttribute('href') || '', 'https://invalid.invalid/'); if (/^(https?|mailto):$/.test(u.protocol) && u.hostname !== 'invalid.invalid') href = u.href; } catch {}
        if (!href) { walk(kid, into); continue; }
        const a = h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' });
        walk(kid, a);
        if (!a.textContent.trim()) a.textContent = href;
        into.append(a);
        continue;
      }
      if (KEEP[tag]) {
        const e = document.createElement(KEEP[tag]);
        walk(kid, e);
        if (e.childNodes.length) into.append(e);
      } else walk(kid, into);
    }
  };
  walk(doc.body, out);
  return out;
}
