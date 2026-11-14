// How the small things move (DESIGN.md, principle 3): a press gives way under the finger and
// springs back; a list changes in place (rows that go close up, new ones open, rows that change
// places move past each other); a value slides; a segmented control's highlight slides to the
// option now on. Transforms and opacity wherever it can be, so an iPhone keeps 60 frames a second,
// and nothing runs while nothing changes. With motion turned down, everything is where it ends,
// at once.

const inPage = typeof window !== 'undefined' && typeof document !== 'undefined';
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

// No motion: asked for on the device, or (on a phone) while a transcript is being made, when
// the CPU goes to the model (as style.css stops animations then).
export const still = () => !inPage || matchMedia('(prefers-reduced-motion: reduce)').matches
  || (!!document.body?.classList.contains('busy') && matchMedia('(hover: none), (max-width: 640px)').matches);

// The curves in style.css (:root): --spring settles without overshoot, --spring-snappy with a
// touch of it, for small things; both `linear()` springs, or --ease where there is no linear().
const curves = {};
export function curve(name) {
  if (!/^(spring|spring-snappy|ease)$/.test(name)) return name;
  curves[name] ||= getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || EASE;
  return curves[name];
}

// el.animate with a curve by name (a browser whose animations won't take linear() gets --ease).
export function animate(el, frames, { duration, easing = 'spring', ...rest } = {}) {
  if (!el?.animate) return null;
  try { return el.animate(frames, { duration, easing: curve(easing), ...rest }); } catch {}
  try { return el.animate(frames, { duration, easing: EASE, ...rest }); } catch { return null; }
}
const done = (a) => (a ? a.finished.then(() => {}, () => {}) : Promise.resolve());

/* ---------- a spring from a finger's speed ----------
 * Where a gesture lets go, the spring starts at the finger's speed: the positions it goes
 * through, sampled as keyframes, played by the compositor like any other animation.
 * response: seconds for a swing (as SwiftUI's springs); damping 1: no overshoot. */
export function springFrames(from, to, v = 0, { response = 0.38, damping = 0.9 } = {}) {
  const w = (2 * Math.PI) / response;
  const k = w * w;
  const c = 2 * damping * w;
  let x = from - to;
  let vel = v;
  let t = 0;
  const dt = 1 / 600;
  const out = [[0, from]];
  while (t < 1.5) {
    vel += (-k * x - c * vel) * dt;
    x += vel * dt;
    t += dt;
    if (t - out.at(-1)[0] >= 1 / 60) out.push([t, x + to]);
    if (Math.abs(x) < 0.25 && Math.abs(vel) < 8) break;
  }
  out.push([t, to]);
  return { duration: t * 1000, frames: out.map(([at, value]) => ({ offset: Math.min(1, at / t), value })) };
}

// el slides along x from `from` to `to` (px), starting at v px/s. Its transform is set to where
// it ends first, so whatever happens to the animation, that is where it is.
export function springX(el, from, to, v = 0, opts) {
  el.style.transform = to ? `translateX(${to}px)` : '';
  if (still() || Math.abs(from - to) < 0.5 || !el.animate) return Promise.resolve();
  const { duration, frames } = springFrames(from, to, v, opts);
  return done(el.animate(frames.map(({ offset, value }) => ({ offset, transform: `translateX(${value}px)` })), { duration, easing: 'linear' }));
}

// Where an element is along x now, in the middle of whatever moves it.
export const xOf = (el) => new DOMMatrix(getComputedStyle(el).transform === 'none' ? undefined : getComputedStyle(el).transform).m41;

/* ---------- a press ----------
 * What is under the finger gives way at once (a little: 0.96, a wide row 0.98) and springs back
 * when let go (DESIGN.md: 100 ms down, 220 ms up). In a list that scrolls it waits a moment
 * first (60 ms, as iOS does), so a finger that starts a scroll leaves nothing pressed; a scroll
 * or a move lets go of it. The element is marked data-pressed while it is held, for the
 * highlight style.css gives it. */

const ROWS = '.ep, .found, .chapter, .menu-pop button';
const TILES = '.tile, .show-tile';
const CONTROLS = '.btn, .icon-btn, .play, .chip-btn, .np-tool, .segmented label, .mini-seg button, .tabbar a, .nav a, .tab, .paste, .note-time, .back-link, .search-entry, .tx-tabs a, .swipe-actions button, .switch';
const PRESSABLE = `${CONTROLS}, ${ROWS}, ${TILES}`;
const LATE = '.ep, .found, .tile, .show-tile, .show-grid, .tiles-row, .chapter-list';
// (Not scaled: a switch, whose knob does the giving, and an action behind a swiped row.)
const FLAT = '.switch, .swipe-actions button';
const DOWN = 100;
const UP = 220;

const scales = new WeakMap();
function scaleTo(el, to, duration, easing) {
  const was = scales.get(el);
  const from = parseFloat(getComputedStyle(el).scale) || 1;
  was?.cancel();
  scales.delete(el);
  if (still() || Math.abs(from - to) < 0.001) return;
  const a = animate(el, [{ scale: String(from) }, { scale: String(to) }], { duration, easing, fill: 'forwards' });
  if (!a) return;
  scales.set(el, a);
  if (to === 1) a.finished.then(() => { if (scales.get(el) === a) { a.cancel(); scales.delete(el); } }, () => {});
}
const depth = (el) => (el.matches(ROWS) ? 0.98 : 0.96);

let held = null; // { el, id, x, y, at (its middle), timer, on }
const middle = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
function show(p) {
  p.on = true;
  clearTimeout(p.timer);
  p.el.dataset.pressed = '';
  if (!p.el.matches(FLAT)) scaleTo(p.el, depth(p.el), DOWN, 'ease');
}
// Let go: springs back. (Also when a long press has done what it does.)
export function release() {
  const p = held;
  held = null;
  if (!p) return;
  clearTimeout(p.timer);
  delete p.el.dataset.pressed;
  if (p.on && !p.el.matches(FLAT)) scaleTo(p.el, 1, UP, 'spring-snappy');
}
// Pressed in further until `end` (a performance.now() time), as a long press is held
// (ui/gestures.js): once the press has given way, from there on.
export function holdIn(el, end) {
  if (held?.el !== el || el.matches(FLAT)) return;
  if (!held.on) show(held);
  const p = held;
  const deeper = () => { if (held === p) scaleTo(el, el.matches(ROWS) ? 0.965 : 0.94, Math.max(80, end - performance.now()), 'cubic-bezier(0.3, 0, 0.6, 1)'); };
  const down = scales.get(el);
  if (down?.playState === 'running') down.finished.then(deeper, () => {}); else deeper();
}

if (inPage) {
  document.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !e.isPrimary) return;
    release();
    const el = e.target.closest?.(PRESSABLE);
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert], .leaving')) return;
    const p = { el, id: e.pointerId, x: e.clientX, y: e.clientY, at: middle(el), timer: 0, on: false };
    held = p;
    if (e.pointerType !== 'mouse' && el.closest(LATE)) p.timer = setTimeout(() => { if (held === p) show(p); }, 60);
    else show(p);
  }, { capture: true, passive: true });
  document.addEventListener('pointermove', (e) => {
    if (held && e.pointerId === held.id && Math.hypot(e.clientX - held.x, e.clientY - held.y) > 10) release();
  }, { capture: true, passive: true });
  document.addEventListener('pointerup', (e) => {
    const p = held;
    if (!p || e.pointerId !== p.id) return;
    // A tap quicker than the wait still shows, for a moment.
    if (!p.on) { show(p); setTimeout(() => { if (held === p) release(); }, DOWN); } else release();
  }, { capture: true, passive: true });
  document.addEventListener('pointercancel', () => release(), { capture: true, passive: true });
  // (A scroll that moves what is pressed, under the finger or not: one elsewhere on the page, as
  // the transcript following what is played, leaves it.)
  window.addEventListener('scroll', () => {
    if (!held) return;
    const [x, y] = middle(held.el);
    if (Math.abs(x - held.at[0]) + Math.abs(y - held.at[1]) > 3) release();
  }, { capture: true, passive: true });
  window.addEventListener('blur', () => release());
}

/* ---------- a list that changes in place ----------
 * const flip = snapshot(list); ...the list changes...; flip.play(list)
 * Each child keyed by data-id (or data-key) moves from where it was to where it is now; one that
 * went is put back where it was a moment, and closes up (its height going to nothing) before it is
 * gone; a new one opens. Only what is on screen moves, and a list where much changed at once
 * simply is as it is now. The list may be a new element in the old one's place. */

const keyOf = (el) => el.dataset?.key || el.dataset?.id || '';
const MOVE = 380;
const CLOSE = 320;
const OPEN = 360;

export function snapshot(list) {
  const before = new Map();
  const order = [];
  const leaving = [];
  if (list?.isConnected && !still() && list.getClientRects().length) {
    let prev = '';
    for (const el of list.children) {
      if (el.classList.contains('leaving')) { leaving.push([el, prev]); continue; }
      const k = keyOf(el);
      if (!k) continue;
      before.set(k, { el, r: el.getBoundingClientRect() });
      order.push(k);
      prev = k;
    }
  }
  return { play: (to = list, opts) => play(to, before, order, leaving, scrollY, opts) };
}

// lift: the key of the one moved on purpose, which goes over the others it passes.
function play(list, before, order, leaving, y0, { enter = true, most = 8, lift = '' } = {}) {
  if (!before.size || still() || !list?.isConnected) return;
  const now = new Map();
  for (const el of list.children) { const k = keyOf(el); if (k && !el.classList.contains('leaving')) now.set(k, el); }
  const shift = scrollY - y0;
  const seen = (r) => r.bottom > -40 && r.top < innerHeight + 40 && r.height > 0;
  const gone = order.filter((k) => !now.has(k));
  const added = [...now.keys()].filter((k) => !before.has(k));
  if (gone.length + added.length > most) return;
  // Put back what went, after what was before it, to close up from there.
  const after = (k) => { for (let i = order.indexOf(k) - 1; i >= 0; i--) { const el = now.get(order[i]) || before.get(order[i]).el; if (el.parentNode === list) return el; } return null; };
  const putBack = (el, prevKey) => {
    const prev = prevKey ? now.get(prevKey) || before.get(prevKey)?.el : null;
    if (prev?.parentNode === list) prev.after(el); else list.prepend(el);
  };
  for (const [el, prev] of leaving) putBack(el, prev);
  for (const k of gone) {
    const { el, r } = before.get(k);
    if (!seen(r)) continue;
    const prev = after(k);
    if (prev) prev.after(el); else list.prepend(el);
    closeUp(el, { gap: parseFloat(getComputedStyle(list).rowGap) || 0 });
  }
  for (const [k, el] of now) {
    const b = before.get(k);
    const r = el.getBoundingClientRect();
    if (!b) { if (enter && added.length && seen(r)) openUp(el, { gap: parseFloat(getComputedStyle(list).rowGap) || 0 }); continue; }
    const dx = b.r.left - r.left;
    const dy = b.r.top - shift - r.top;
    if (Math.abs(dx) + Math.abs(dy) < 1 || (!seen(b.r) && !seen(r))) continue;
    // (Moving, a row is opaque and over what it passes: style.css .moving.)
    el.classList.add('moving');
    el.classList.toggle('lifted', k === lift);
    const a = animate(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: MOVE, easing: 'spring' });
    done(a).then(() => { if (!el.getAnimations().some((x) => x !== a && x.playState === 'running' && x.effect?.getKeyframes().some((f) => f.transform != null))) el.classList.remove('moving', 'lifted'); });
  }
}

// The box of a row as it closes or opens: its height, and what makes up its height.
function boxOf(el, gap) {
  const cs = getComputedStyle(el);
  return {
    open: { height: `${el.offsetHeight}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth, marginTop: cs.marginTop, marginBottom: cs.marginBottom, opacity: 1 },
    shut: { height: '0px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', marginTop: cs.marginTop, marginBottom: `${(parseFloat(cs.marginBottom) || 0) - gap}px`, opacity: 0 },
  };
}

// It closes up: its height goes to nothing, and what is under it comes up with it. Then it is
// taken out (or, with keep, hidden and left in its place).
export function closeUp(el, { gap = 0, keep = false } = {}) {
  const end = () => { if (keep) { el.classList.add('hidden'); el.classList.remove('leaving'); el.inert = false; el.style.overflow = ''; } else el.remove(); };
  if (still() || !el.isConnected || !el.getClientRects().length) { end(); return Promise.resolve(); }
  const { open, shut } = boxOf(el, gap);
  el.classList.add('leaving');
  el.inert = true;
  el.style.overflow = 'hidden';
  const a = animate(el, [open, shut], { duration: CLOSE, easing: 'spring', fill: 'forwards' });
  if (!a) { end(); return Promise.resolve(); }
  // (Called off half way, by whoever wants it back, it stays.)
  return a.finished.then(() => { end(); a.cancel(); }, () => {});
}

// It opens: from nothing to its height, pushing what is under it down.
export function openUp(el, { gap = 0 } = {}) {
  if (still() || !el.getClientRects().length) return Promise.resolve();
  const { open, shut } = boxOf(el, gap);
  el.style.overflow = 'hidden';
  return done(animate(el, [shut, open], { duration: OPEN, easing: 'spring' })).then(() => { el.style.overflow = ''; });
}

/* ---------- small changes in place ---------- */

// A button's icon changes (play to pause): the old one turns away and fades as the new one turns
// in. (The two share the button's grid cell: style.css .play > .icon.)
export function swapIcon(button, name) {
  const use = button?.querySelector(':scope > svg.icon:not(.icon-out) use');
  if (!use) return;
  const href = `#i-${name}`;
  if (use.getAttribute('href') === href) return;
  const svg = use.parentNode;
  for (const old of button.querySelectorAll(':scope > .icon-out')) old.remove();
  if (still() || !svg.getClientRects().length) { use.setAttribute('href', href); return; }
  const out = svg.cloneNode(true);
  out.classList.add('icon-out');
  svg.before(out);
  use.setAttribute('href', href);
  animate(out, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'rotate(90deg) scale(0.4)' }], { duration: 200, easing: 'ease', fill: 'forwards' })?.finished.then(() => out.remove(), () => out.remove());
  animate(svg, [{ opacity: 0, transform: 'rotate(-90deg) scale(0.4)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'spring-snappy' });
}

// A value changes on a button: the old text slides up and away as the new comes up from below,
// each clipped to the line. (The old one is a copy laid over the line, beside it, so the element
// itself holds only the new text: style.css .text-out.)
export function swapText(el, text) {
  if (!el || el.textContent === text) return;
  const had = el.textContent;
  const box = el.offsetParent;
  for (const old of box?.querySelectorAll(':scope > .text-out') || []) old.remove();
  if (still() || !had || !box || !el.getClientRects().length) { el.textContent = text; return; }
  const out = document.createElement('span');
  out.className = `${el.className} text-out`;
  out.setAttribute('aria-hidden', 'true');
  Object.assign(out.style, { left: `${el.offsetLeft}px`, top: `${el.offsetTop}px`, width: `${el.offsetWidth}px`, height: `${el.offsetHeight}px` });
  const was = document.createElement('span');
  was.textContent = had;
  out.append(was);
  box.append(out);
  const now = document.createElement('span');
  now.className = 'text-in';
  now.textContent = text;
  el.replaceChildren(now);
  animate(was, [{ transform: 'none', opacity: 1 }, { transform: 'translateY(-100%)', opacity: 0 }], { duration: 180, easing: 'ease', fill: 'forwards' })?.finished.then(() => out.remove(), () => out.remove());
  animate(now, [{ transform: 'translateY(100%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 280, easing: 'spring' });
}

/* ---------- a segmented control's highlight ----------
 * The option on is drawn by its ::before (style.css); when another is chosen, the new one's
 * starts where the old one's was and slides over. Works for the radios of a .segmented (a
 * control the page draws anew, as the screens' tabs are, is found again by its id) and for the
 * buttons of a .mini-seg (aria-pressed). */

const onOf = (g) => g.querySelector(':scope input:checked + span, :scope > button[aria-pressed="true"]');
function slideFrom(g, from) {
  const group = g.isConnected ? g : g.id && document.getElementById(g.id);
  const on = group && onOf(group);
  if (!on || !from || still()) return;
  const to = on.getBoundingClientRect();
  if (!to.width || (Math.abs(to.left - from.left) < 1 && Math.abs(to.top - from.top) < 1)) return;
  on.classList.add('seg-from');
  on.style.setProperty('--seg-x', `${from.left - to.left}px`);
  on.style.setProperty('--seg-y', `${from.top - to.top}px`);
  on.style.setProperty('--seg-sx', String(from.width / to.width));
  on.style.setProperty('--seg-sy', String(from.height / to.height));
  void getComputedStyle(on, '::before').transform;
  on.classList.remove('seg-from');
  for (const p of ['--seg-x', '--seg-y', '--seg-sx', '--seg-sy']) on.style.removeProperty(p);
}

if (inPage) {
  const remember = (e) => {
    const g = e.target.closest?.('.segmented, .mini-seg');
    if (!g) return;
    const on = onOf(g);
    g._from = on ? on.getBoundingClientRect() : null;
    // (After the change is drawn, before it is painted.)
    if (g.classList.contains('mini-seg') && e.type === 'click') requestAnimationFrame(() => slideFrom(g, g._from));
  };
  document.addEventListener('pointerdown', remember, true);
  document.addEventListener('keydown', remember, true);
  document.addEventListener('click', (e) => { if (e.target.closest?.('.mini-seg > button')) remember(e); }, true);
  document.addEventListener('change', (e) => {
    const g = e.target.type === 'radio' && e.target.closest('.segmented');
    if (g) { const from = g._from; requestAnimationFrame(() => slideFrom(g, from)); }
  }, true);
}
