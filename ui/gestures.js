// Touch gestures: a long press on an episode opens what a row's three dots open; on Carry on a
// swipe to the left shows what can be done with it (or, swiped all the way, does the first); on
// Listen, pulled down from the top, the page refreshes. Pointer events for the first two, so a
// mouse does the same; the page still scrolls up and down under a finger (touch-action: pan-y),
// and a tap is still a tap. How they move is ui/motion.js.
import { still, springX, xOf, holdIn, release, animate, springFrames } from './motion.js';

const HOLD = 480; // ms: a press this long is a long press
const SLOP = 10; // px a finger may wander before it is a move, not a press

// fn(event) after a press held still for HOLD ms, or a right click. Held, the thing presses in
// further over the time (ui/motion.js holdIn), and lets go as the menu comes out of it. The click
// that ends a long press is swallowed, so it does not also open what was under the finger.
export function longPress(el, fn) {
  let timer = 0;
  let start = null;
  let fired = false;
  const cancel = () => { clearTimeout(timer); timer = 0; start = null; };
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !e.isPrimary) return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    clearTimeout(timer);
    // (After the moment a press in a list waits before it shows.)
    const end = performance.now() + HOLD;
    setTimeout(() => { if (start && !el.dataset.swiping) holdIn(el, end); }, 80);
    timer = setTimeout(() => {
      timer = 0;
      if (!start || el.dataset.swiping) return;
      fired = true;
      release();
      fn(e);
    }, HOLD);
  });
  el.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(type, cancel);
  el.addEventListener('click', (e) => { if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); } }, true);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); release(); fn(e); });
  window.addEventListener('scroll', cancel, { passive: true });
}

// Past an end, a finger's pull gives less and less (as a scroll view's edge does): d px of
// pull over a room of `dim` px moves it this far.
const rubber = (d, dim) => (1 - 1 / ((d * 0.55) / dim + 1)) * dim;

// The element slides left under a finger, exactly with it, showing `actions` ([{ label, run }],
// the first is what a full swipe does) behind it; to the right of closed it gives with a rubber
// band. Let go, it springs open (the actions' width) or closed from the finger's speed, so a
// quick flick opens or closes it however short; let go past most of its width, the first action
// widens to the whole row, the element goes off to the left, the action is done, and the row
// closes up (ui/pod.js, ui/motion.js). A tap anywhere else, or a scroll, closes it.
let openOne = null;
const FULL = 0.6; // of the element's width: let go past here, the first action is done
export function swipeActions(el, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'swipe';
  el.replaceWith(wrap);
  const behind = document.createElement('div');
  behind.className = 'swipe-actions';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.label;
    b.addEventListener('click', () => fly(a, 0));
    behind.append(b);
  }
  wrap.append(behind, el);
  wrap.style.setProperty('--n', String(actions.length));
  el.classList.add('swipe-front');

  let x0 = null;
  let y0 = 0;
  let base = 0; // where it sat when the finger came down
  let at = 0; // where it is
  let going = false; // decided to be a sideways move
  let trail = []; // the finger's last moves: [time, x], for its speed
  let reveal = 168;
  const width = () => el.offsetWidth || 1;
  // (Its own moves, not a press giving way: ui/motion.js animates scale.)
  const moves = () => (el.getAnimations?.() || []).filter((a) => a.effect?.getKeyframes?.().some((k) => k.transform != null));
  const place = (x) => {
    at = x;
    el.style.transform = x ? `translateX(${x}px)` : '';
    wrap.style.setProperty('--dx', `${x}px`);
    if (x < 0) wrap.classList.add('open');
  };
  // While it moves on its own, the actions behind keep to its edge (style.css sizes them by
  // --dx), a frame at a time, until it stops.
  const follow = () => {
    const step = () => {
      if (!moves().length) { wrap.style.setProperty('--dx', `${at}px`); return; }
      wrap.style.setProperty('--dx', `${xOf(el)}px`);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  // Springs to `to` from the finger's speed v (px/s); closed, the actions go once it covers them.
  const settle = (to, v = 0) => {
    const from = at;
    at = to;
    wrap.classList.toggle('full', false);
    if (to < 0) wrap.classList.add('open');
    const moving = springX(el, from, to, v, { response: 0.36, damping: 0.86 });
    follow();
    return moving.then(() => { if (at === to && to === 0) wrap.classList.remove('open'); });
  };
  const close = (v = 0) => { if (openOne === close) openOne = null; if (at !== 0 || wrap.classList.contains('open')) settle(0, v); };
  // Off to the left, then the action. (Whoever draws the list closes the row up behind it; if it
  // is still there after, it comes back.)
  const fly = async (a, v) => {
    if (openOne === close) openOne = null;
    const w = width();
    wrap.classList.add('open', 'full');
    if (!still()) {
      const from = at;
      const go = { response: 0.3, damping: 1 };
      const speed = Math.min(v, -800);
      at = -w;
      springX(el, from, -w, speed, go);
      follow();
      // (The action, and the row closing up, once it is all but gone: not after the spring's
      // last fraction of a pixel.)
      const { duration, frames } = springFrames(from, -w, speed, go);
      const near = frames.find((f) => Math.abs(f.value + w) < 8);
      await new Promise((r) => setTimeout(r, (near ? near.offset : 1) * duration));
    }
    a.run();
    requestAnimationFrame(() => { if (wrap.isConnected && !wrap.classList.contains('leaving')) settle(0); });
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    if (openOne && openOne !== close) openOne();
    // Caught in the middle of a move: from where it is.
    const now = moves().length ? xOf(el) : at;
    for (const a of moves()) a.cancel();
    place(now);
    x0 = e.clientX;
    y0 = e.clientY;
    going = false;
    trail = [[e.timeStamp, e.clientX]];
    base = now;
    wrap.classList.remove('full');
    reveal = [...behind.children].reduce((n, b) => n + b.offsetWidth, 0) || 168;
  });
  el.addEventListener('pointermove', (e) => {
    if (x0 == null) return;
    const mx = e.clientX - x0;
    const my = e.clientY - y0;
    if (!going) {
      if (Math.abs(my) > SLOP && Math.abs(my) > Math.abs(mx)) { x0 = null; return; } // a scroll
      if (Math.abs(mx) < SLOP) return;
      going = true;
      el.dataset.swiping = 'true';
      release();
      try { el.setPointerCapture(e.pointerId); } catch {}
    }
    trail.push([e.timeStamp, e.clientX]);
    while (trail.length > 2 && e.timeStamp - trail[0][0] > 100) trail.shift();
    const w = width();
    const want = base + mx;
    place(want > 0 ? rubber(want, w) : want < -w ? -w - rubber(-w - want, w) : want);
    wrap.classList.toggle('full', at < -w * FULL);
  });
  const end = () => {
    if (x0 == null) return;
    x0 = null;
    delete el.dataset.swiping;
    if (!going) return;
    // The finger's speed over its last tenth of a second (none, if the moves came all at once).
    const [t1, p1] = trail[0];
    const [t2, p2] = trail.at(-1);
    const v = t2 - t1 >= 8 ? Math.max(-4000, Math.min(4000, ((p2 - p1) / (t2 - t1)) * 1000)) : 0;
    const w = width();
    const heading = at + v * 0.15; // where it is going, a moment on
    if (at < -w * FULL && v < 300) fly(actions[0], v);
    else if (heading < -reveal / 2 && v < 300) { settle(-reveal, v); openOne = close; } else close(v);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  // (After a sideways move the click that ends it is not a tap.)
  el.addEventListener('click', (e) => { if (going) { going = false; e.preventDefault(); e.stopPropagation(); } }, true);
  return wrap;
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => { if (openOne && !e.target.closest('.swipe.open')) openOne(); });
  window.addEventListener('scroll', () => openOne?.(), { passive: true });
}

// Pulled down from the top of the page, on a touch screen: `view` follows the finger with more
// and more give, and a spinner comes into the room above it, its spokes filling in and turning
// with the pull. Let go past the mark, it holds there, turning, until refresh() is done, then
// settles back; short of the mark, it settles back. can(): whether a pull is wanted now (the
// screen is showing, no sheet over it).
const MARK = 64; // px the page moves for a refresh
const HELD = 52; // px it stays down while refreshing
const SPOKES = 8;
export function pullToRefresh(view, { refresh, can = () => true }) {
  const spin = document.createElement('div');
  spin.className = 'pull';
  spin.setAttribute('aria-hidden', 'true');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '-14 -14 28 28');
  const spokes = [];
  for (let i = 0; i < SPOKES; i++) {
    const a = (i / SPOKES) * 2 * Math.PI - Math.PI / 2;
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', String(Math.cos(a) * 6));
    l.setAttribute('y1', String(Math.sin(a) * 6));
    l.setAttribute('x2', String(Math.cos(a) * 11));
    l.setAttribute('y2', String(Math.sin(a) * 11));
    l.style.setProperty('--o', String(1 - (0.6 * ((SPOKES - i) % SPOKES)) / SPOKES));
    spokes.push(l);
    svg.append(l);
  }
  spin.append(svg);
  view.prepend(spin);

  let y0 = null;
  let x0 = 0;
  let pulling = false;
  let busy = false;
  let off = 0;
  // The page `d` px down: the spinner in the middle of the room above it.
  const draw = (d) => {
    off = d;
    view.style.translate = d > 0.5 ? `0 ${d}px` : '';
    const p = Math.min(1, d / MARK);
    spin.style.opacity = String(Math.min(1, p * 1.6));
    spin.style.transform = `translateY(${-d / 2 - 14 - 11}px) rotate(${busy ? 0 : d * 3}deg)`;
    if (!busy) spokes.forEach((l, i) => l.classList.toggle('on', p >= (i + 1) / SPOKES));
  };
  // Settles at d on a spring, from wherever it is (in the middle of the last settling, too).
  const to = (d) => {
    const moving = view.getAnimations().filter((a) => a.effect?.getKeyframes().some((k) => k.translate != null));
    const from = moving.length ? parseFloat(getComputedStyle(view).translate.split(' ')[1]) || 0 : off;
    for (const a of [...moving, ...spin.getAnimations()]) a.cancel();
    if (still() || Math.abs(from - d) < 0.5) { draw(d); return Promise.resolve(); }
    const { duration, frames } = springFrames(from, d, 0, { response: 0.4, damping: 0.9 });
    view.style.translate = d > 0.5 ? `0 ${d}px` : '';
    off = d;
    const a = animate(view, frames.map(({ offset, value }) => ({ offset, translate: `0 ${value}px` })), { duration, easing: 'linear' });
    const s = animate(spin, frames.map(({ offset, value }) => ({ offset, transform: `translateY(${-value / 2 - 25}px)`, opacity: Math.min(1, (value / MARK) * 1.6) })), { duration, easing: 'linear' });
    draw(d);
    return Promise.all([a, s].map((x) => (x ? x.finished.catch(() => {}) : null)));
  };

  view.addEventListener('touchstart', (e) => {
    y0 = null;
    if (busy || e.touches.length !== 1 || window.scrollY > 0 || !can()) return;
    y0 = e.touches[0].clientY;
    x0 = e.touches[0].clientX;
    pulling = false;
  }, { passive: true });
  view.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0;
    const dx = e.touches[0].clientX - x0;
    if (!pulling) {
      // Down, more than sideways, from the very top: a pull. Anything else is not.
      if (dy <= 0 || Math.abs(dx) > dy || window.scrollY > 0) { if (dy < 0 || Math.abs(dx) > 4 || window.scrollY > 0) y0 = null; return; }
      pulling = true;
      for (const a of [...view.getAnimations(), ...spin.getAnimations()]) if (a.effect?.getKeyframes().some((k) => k.translate != null || k.opacity != null)) a.cancel();
    }
    if (e.cancelable) e.preventDefault();
    draw(rubber(Math.max(0, dy - 4), innerHeight));
  }, { passive: false });
  const end = async () => {
    if (y0 == null) return;
    y0 = null;
    if (!pulling) return;
    pulling = false;
    if (off < MARK) { to(0); return; }
    busy = true;
    spokes.forEach((l) => l.classList.add('on'));
    spin.classList.add('turning');
    to(HELD);
    const t0 = performance.now();
    try { await refresh(); } catch {}
    // (Long enough to be seen.)
    await new Promise((r) => setTimeout(r, Math.max(0, 600 - (performance.now() - t0))));
    spin.classList.remove('turning');
    busy = false;
    await to(0);
  };
  view.addEventListener('touchend', end);
  view.addEventListener('touchcancel', end);
  return spin;
}
