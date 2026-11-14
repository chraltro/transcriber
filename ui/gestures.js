// Touch gestures on episodes: a long press opens what a row's three dots open, and on Carry on a
// swipe to the left shows what can be done with it (or, swiped all the way, does the first).
// Pointer events throughout, so a mouse does the same; the page still scrolls up and down under
// a finger (touch-action: pan-y), and a tap is still a tap.

const HOLD = 480; // ms: a press this long is a long press
const SLOP = 10; // px a finger may wander before it is a move, not a press

// fn(event) after a press held still for HOLD ms, or a right click. The click that ends a long
// press is swallowed, so it does not also open what was under the finger.
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
    timer = setTimeout(() => {
      timer = 0;
      if (!start || el.dataset.swiping) return;
      fired = true;
      fn(e);
    }, HOLD);
  });
  el.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(type, cancel);
  el.addEventListener('click', (e) => { if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); } }, true);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); fn(e); });
  window.addEventListener('scroll', cancel, { passive: true });
}

// The element slides left under a finger, showing `actions` ([{ label, run }], first is what a
// full swipe does) behind it. Let go past half the actions' width and they stay open; past most
// of the element's width the first is done; anything less slides back. A tap anywhere else, or a
// scroll, closes them.
let openOne = null;
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
    b.addEventListener('click', () => { close(); a.run(); });
    behind.append(b);
  }
  wrap.append(behind, el);
  el.classList.add('swipe-front');

  let x0 = null;
  let y0 = 0;
  let dx = 0;
  let base = 0; // where it sat when the finger came down (0, or open)
  let going = false; // decided to be a sideways move
  const reveal = () => behind.offsetWidth;
  const place = (x, glide) => {
    el.style.transition = glide ? '' : 'none';
    el.style.transform = x ? `translateX(${x}px)` : '';
    wrap.classList.toggle('open', x < 0);
  };
  const close = () => { place(0, true); if (openOne === close) openOne = null; };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || !e.isPrimary) return;
    if (openOne && openOne !== close) openOne();
    x0 = e.clientX;
    y0 = e.clientY;
    dx = 0;
    going = false;
    base = wrap.classList.contains('open') ? -reveal() : 0;
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
      try { el.setPointerCapture(e.pointerId); } catch {}
    }
    dx = mx;
    place(Math.min(0, base + dx), false);
  });
  const end = () => {
    if (x0 == null) return;
    x0 = null;
    delete el.dataset.swiping;
    if (!going) return;
    const at = base + dx;
    const w = el.offsetWidth;
    if (at < -w * 0.6) { place(-w, true); setTimeout(() => { close(); actions[0].run(); }, 180); }
    else if (at < -reveal() / 2) { place(-reveal(), true); openOne = close; }
    else close();
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
