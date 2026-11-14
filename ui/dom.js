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
 * One at a time, over the page: the player, an episode. The phone's back gesture closes it. */

const pane = () => document.getElementById('sheet');
const back = () => document.getElementById('sheet-back');
let onClose = null;
let lastFocus = null;

export function openSheet(content, { name = '', closed = null } = {}) {
  const p = pane();
  const wasOpen = !p.classList.contains('hidden');
  if (wasOpen) onClose?.();
  else lastFocus = document.activeElement;
  onClose = closed;
  p.replaceChildren(content);
  p.dataset.sheet = name;
  p.classList.remove('hidden');
  back().classList.remove('hidden');
  document.body.classList.add('sheet-open');
  if (!wasOpen && !history.state?.sheet) history.pushState({ sheet: true }, '');
  p.scrollTop = 0;
  p.style.transform = '';
  p.focus({ preventScroll: true });
}

// On a phone the sheet is pulled down to close it: by its top edge, or from anywhere once it
// is scrolled to the top.
function dragToClose(p) {
  let y0 = null;
  let dy = 0;
  let t0 = 0;
  p.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !matchMedia('(max-width: 640px)').matches) return;
    const fromTop = e.touches[0].clientY - p.getBoundingClientRect().top < 120;
    y0 = p.scrollTop <= 0 && !e.target.closest('.score') && (fromTop || !e.target.closest('input, .notes, .mini-seg')) ? e.touches[0].clientY : null;
    dy = 0;
    t0 = performance.now();
  }, { passive: true });
  p.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0 || p.scrollTop > 0) { if (dy < -4) y0 = null; p.style.transform = ''; return; }
    if (e.cancelable) e.preventDefault();
    p.style.transition = 'none';
    p.style.transform = `translateY(${dy}px)`;
  }, { passive: false });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    p.style.transition = '';
    const flick = dy > 40 && performance.now() - t0 < 260;
    if (dy > 130 || flick) closeSheet(); else p.style.transform = '';
    dy = 0;
  };
  p.addEventListener('touchend', end);
  p.addEventListener('touchcancel', end);
}

export const sheetOpen = (name) => !pane().classList.contains('hidden') && (!name || pane().dataset.sheet === name);

function hideSheet() {
  const p = pane();
  if (p.classList.contains('hidden')) return;
  p.classList.add('hidden');
  p.style.transform = '';
  back().classList.add('hidden');
  document.body.classList.remove('sheet-open');
  p.replaceChildren();
  const done = onClose;
  onClose = null;
  done?.();
  lastFocus?.focus?.({ preventScroll: true });
}

export function closeSheet() {
  if (!sheetOpen()) return;
  if (history.state?.sheet) history.back(); // popstate hides it
  else hideSheet();
}

// (Nothing here touches the page until it is there: the tests load this file without one.)
const inPage = typeof window !== 'undefined' && typeof document !== 'undefined';
if (inPage) {
  if (pane()) dragToClose(pane());
  window.addEventListener('popstate', () => { if (!history.state?.sheet) hideSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetOpen() && !menuOpen()) { e.preventDefault(); closeSheet(); } });
  document.addEventListener('click', (e) => { if (e.target === back()) closeSheet(); });
}

/* ---------- the menu behind a row's three dots ---------- */

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
  m.classList.add('open');
  // Under the button, or above it near the bottom of the screen; never off the side.
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth;
  const hgt = m.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  const below = r.bottom + 6 + hgt <= window.innerHeight - 8;
  m.style.left = `${left}px`;
  m.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - hgt - 6)}px`;
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
