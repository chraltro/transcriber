// The score: the position control drawn as the whole episode (DESIGN.md). A bar for each stretch
// of time, its height the loudness and its colour the voice (lib/shape.js), the sponsor reads
// hatched, a tick where each chapter starts, a red line where the listener is. A finger on it
// opens a magnifier above: three minutes at a bar a second, for picking an exact spot.
//
// It is the slider the range input was: dragging previews the time and the audio moves when the
// finger lifts, the keys move by the back and forward amounts, and assistive technology is told
// it is a slider. It is drawn on a canvas, and redrawn only where something changed when the
// player's clock ticks: there is no animation loop, except the one draw-in per episode.
import { h } from './dom.js';
import { fmtTime } from '../lib/text.js';
import { bars, voiceAt, hasVoices, hasLoudness } from '../lib/shape.js';

const PITCH = 3; // a bar every 3 px...
const BAR = 2; // ...2 px wide
const WINDOW = 90; // the magnifier: seconds either side of the finger, a bar a second
const DRAW_IN = 500; // ms, once per episode
const UNPLAYED = 0.7; // not yet played: mixed this far toward the panel behind
const FLOOR = 0.24; // the quietest bar still stands this high (of the strip)
const EVEN = 0.36; // with no loudness known, every bar is this high
const BOX = 0.42; // a sponsor read: a flat box this high
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const drawnIn = new Set(); // where an episode's strip has been drawn in already

// Colours are the tokens in style.css, read from the page; a mix is worked out here (a canvas
// takes no color-mix()), so a played yellow fades toward the panel and never turns olive.
function rgba(css) {
  const c = String(css || '').trim();
  let m = c.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let x = m[1];
    if (x.length <= 4) x = [...x].map((d) => d + d).join('');
    return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)).concat(x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1);
  }
  m = c.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  return [128, 128, 128, 1];
}
const css = ([r, g, b, a]) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
const mix = (a, b, k) => css(rgba(a).map((v, i) => (i < 3 ? v + (rgba(b)[i] - v) * k : v)));

export class Score {
  // root: an empty element to build in. compact: the player bar's (lower, no line of text).
  // onPreview(t): while a finger drags, the time under it (the clock shows it).
  constructor(root, { player, compact = false, onPreview = () => {} }) {
    Object.assign(this, { root, player, compact, onPreview });
    this.top = compact ? 4 : 5; // the bracket for the magnifier above this
    this.base = compact ? 34 : 69; // bars stand on this line; chapter ticks hang under it
    this.dragging = false;
    this.preview = 0;
    this.lastX = null;
    this.raf = 0;
    root.classList.add('score');
    root.replaceChildren(
      this.loupe = h('div.score-loupe', { 'aria-hidden': 'true' },
        h('div.score-loupe-head', {}, this.loupeName = h('span.score-loupe-name'), this.loupeTime = h('span.score-loupe-time')),
        this.loupeCv = h('canvas.score-loupe-cv'),
        h('div.score-loupe-foot', {}, this.loupeFrom = h('span'), this.loupeTo = h('span'))),
      this.strip = h('div.score-strip', { role: 'slider', tabindex: '0', 'aria-label': 'Position in the episode', 'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0' },
        this.cv = h('canvas.score-cv')));
    this.listen();
    this.size = new ResizeObserver(() => { if (this.layout()) this.paint(); });
    this.size.observe(this.strip);
    this.scheme = matchMedia('(prefers-color-scheme: dark)');
    this.onScheme = () => this.refresh();
    this.scheme.addEventListener?.('change', this.onScheme);
    this.refresh();
  }

  destroy() {
    this.size.disconnect();
    this.scheme.removeEventListener?.('change', this.onScheme);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // The time drawn: under the finger while it drags, else where the player is.
  get time() { return this.dragging ? this.preview : this.player.time; }
  get duration() { return this.player.duration || this.player.shape?.total || 0; }

  /* ---------- the finger, the keys ---------- */

  listen() {
    const { strip, player } = this;
    const at = (e) => {
      const r = this.cv.getBoundingClientRect();
      return Math.max(0, Math.min(this.duration, ((e.clientX - r.left) / Math.max(1, r.width)) * this.duration));
    };
    strip.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || !(this.duration > 0)) return;
      e.preventDefault();
      strip.focus({ preventScroll: true });
      try { strip.setPointerCapture(e.pointerId); } catch {}
      this.dragging = true;
      this.preview = at(e);
      this.root.classList.add('scrubbing');
      this.root.dataset.scrubbing = 'true';
      this.loupeFit = false;
      this.moved();
    });
    strip.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.preview = at(e);
      this.moved();
    });
    // Lifting the finger moves the audio; the system taking the touch away does not.
    const end = (seek) => () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.root.classList.remove('scrubbing');
      delete this.root.dataset.scrubbing;
      if (seek) player.seek(this.preview, { user: true });
      this.paint();
      this.onPreview(this.time, false);
    };
    strip.addEventListener('pointerup', end(true));
    strip.addEventListener('pointercancel', end(false));
    strip.addEventListener('lostpointercapture', end(true));
    strip.addEventListener('keydown', (e) => {
      const s = player.store.settings;
      const d = this.duration;
      if (!(d > 0)) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') player.skip(-(e.shiftKey ? 60 : s.back));
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') player.skip(e.shiftKey ? 60 : s.fwd);
      else if (e.key === 'Home') player.seek(0, { user: true });
      else if (e.key === 'End') player.seek(d, { user: true });
      else return;
      e.preventDefault();
    });
  }

  moved() {
    this.onPreview(this.preview, true);
    this.draw();
    this.drawLoupe();
  }

  /* ---------- what it shows ---------- */

  // The shape, the breaks, the chapters or the length changed (or the theme): everything again.
  refresh() {
    const { player } = this;
    const shape = player.shape;
    const d = this.duration;
    this.root.dataset.shows = hasVoices(shape) ? 'voices' : hasLoudness(shape) ? 'loudness' : 'none';
    this.breaks = d > 0 ? (player.breaks || []).filter(([a]) => a < d) : [];
    this.ticks = d > 0 ? player.chapters.map((c) => c.start).filter((t) => t > 0 && t < d) : [];
    this.root.dataset.breaks = String(this.breaks.length);
    this.root.dataset.ticks = String(this.ticks.length);
    this.tokens();
    this.layout(true);
    this.paint();
  }

  tokens() {
    const cs = getComputedStyle(this.root);
    const tok = (k) => cs.getPropertyValue(`--${k}`).trim();
    this.tok = { bg: tok('score-bg') || tok('panel'), faint: tok('faint'), muted: tok('muted'), text: tok('text'), accent: tok('accent'), line: tok('line-strong'), spk: [0, 1, 2, 3, 4, 5].map((i) => tok(`spk-${i}`)) };
    this.colours = new Map();
  }

  // The colour of a bar of voice `v` (-1: nobody, or not known), played or not.
  colour(v, played) {
    const key = `${v}|${played}`;
    let c = this.colours.get(key);
    if (c) return c;
    const { tok } = this;
    const shape = this.player.shape;
    const base = !shape ? tok.faint : v < 0 || v === shape.other ? (hasVoices(shape) ? tok.faint : tok.muted) : tok.spk[shape.hues[v] ?? v % 6];
    c = played ? css(rgba(base)) : mix(base, tok.bg, UNPLAYED);
    this.colours.set(key, c);
    return c;
  }

  // Sizes the canvas to the strip, sharp at the screen's density (to 3x). -> whether it can draw.
  layout(force = false) {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (!(r.width > 0 && r.height > 0)) { this.w = 0; return false; }
    if (!force && r.width === this.w && r.height === this.hgt && dpr === this.dpr) return true;
    Object.assign(this, { w: r.width, hgt: r.height, dpr });
    this.cv.width = Math.round(r.width * dpr);
    this.cv.height = Math.round(r.height * dpr);
    this.g = this.cv.getContext('2d');
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.max(1, Math.floor((r.width + PITCH - BAR) / PITCH));
    this.laidFor = this.duration;
    this.n = n;
    this.x0 = (r.width - (n * PITCH - (PITCH - BAR))) / 2;
    const d = this.duration;
    const shape = this.player.shape;
    this.bars = shape && d > 0 ? bars(shape, { from: 0, to: d, count: n }) : null;
    // A bar under a sponsor read for most of its length is not drawn: the box stands there.
    const step = d / n;
    this.inBox = new Uint8Array(n);
    this.boxes = this.breaks.map(([a, b]) => {
      let i0 = -1;
      let i1 = -1;
      for (let i = 0; i < n; i++) {
        if (Math.min(b, (i + 1) * step) - Math.max(a, i * step) > step / 2) { this.inBox[i] = 1; if (i0 < 0) i0 = i; i1 = i; }
      }
      // (A read shorter than half a bar still gets one.)
      if (i0 < 0) { i0 = i1 = Math.min(n - 1, Math.floor(a / step)); this.inBox[i0] = 1; }
      return { a, i0, i1 };
    });
    this.loupeFit = false;
    return true;
  }

  xOf(t) { const d = this.duration; return d > 0 ? (t / d) * this.w : 0; }

  // Everything again, or the draw-in when this episode's strip first shows here.
  paint() {
    if (!this.w) return;
    if (!this.tok.accent) this.tokens(); // (built before it was on the page)
    // Until the shape is known (a moment), nothing: then it is drawn in, not swapped.
    if (!this.player.shapeReady) { this.g.clearRect(0, 0, this.w, this.hgt); this.lastX = null; return; }
    const id = this.player.item?.id;
    const key = `${this.compact ? 'bar' : 'sheet'}:${id}`;
    if (id && !drawnIn.has(key) && this.duration > 0 && this.player.shapeReady) {
      drawnIn.add(key);
      if (!reduced()) { this.drawIn(); return; }
    }
    if (this.raf) return; // (the draw-in is under way, and ends with the whole strip)
    this.region(0, this.w);
    this.lastX = this.xOf(this.time);
  }

  // Left to right, linear, once.
  drawIn() {
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / DRAW_IN);
      this.raf = 0;
      this.region(0, this.w, k * this.w);
      if (k < 1) this.raf = requestAnimationFrame(step);
      else this.lastX = this.xOf(this.time);
    };
    this.g.clearRect(0, 0, this.w, this.hgt);
    this.raf = requestAnimationFrame(step);
  }

  // The player's clock ticked (or a finger moved): only the stretch between where the line was
  // and where it is now is drawn again.
  draw() {
    const d = this.duration;
    const t = this.time;
    const s = this.strip;
    const now = String(Math.floor(t));
    if (s.getAttribute('aria-valuenow') !== now || s.getAttribute('aria-valuemax') !== String(Math.round(d))) {
      s.setAttribute('aria-valuemax', String(Math.round(d)));
      s.setAttribute('aria-valuenow', now);
      const ch = this.player.chapterAt(t);
      s.setAttribute('aria-valuetext', d > 0 ? `${fmtTime(t)} of ${fmtTime(d)}${ch >= 0 ? `, ${this.player.chapters[ch].title}` : ''}` : '');
      s.setAttribute('aria-disabled', String(!(d > 0)));
    }
    if (!this.w || this.raf || !this.player.shapeReady) return;
    if (d !== this.laidFor) { this.refresh(); return; } // (the audio has said how long it is)
    const x = this.xOf(t);
    if (this.lastX == null) { this.paint(); return; }
    if (Math.abs(x - this.lastX) < 0.25 && !this.dragging && !this.bracket) return;
    // (The magnifier's bracket on top moves with the finger: its old place is cleared too.)
    const span = this.dragging || this.bracket ? this.xOf(WINDOW) + 2 : 0;
    const was = this.bracket || [this.lastX, this.lastX];
    this.region(Math.min(x, was[0]) - span - PITCH, Math.max(x, was[1]) + span + PITCH);
    this.lastX = x;
  }

  // Draws the strip between x0 and x1 (CSS px) and nothing outside it; `reveal`: the draw-in
  // has got this far across.
  region(x0, x1, reveal = Infinity) {
    const { g, w, hgt, top, base, n, tok } = this;
    x0 = Math.max(0, Math.floor(x0));
    x1 = Math.min(w, Math.ceil(x1));
    if (x1 <= x0) return;
    g.save();
    g.beginPath();
    g.rect(x0, 0, x1 - x0, hgt);
    g.clip();
    g.clearRect(x0, 0, x1 - x0, hgt);
    if (reveal < w) { g.beginPath(); g.rect(0, 0, reveal, hgt); g.clip(); }
    const d = this.duration;
    const t = this.time;
    const span = base - top - 2;
    const known = !!this.bars && (hasVoices(this.player.shape) || hasLoudness(this.player.shape));
    const step = d > 0 ? d / n : 0;
    g.globalAlpha = known ? 1 : 0.35;
    for (let i = Math.max(0, Math.floor((x0 - this.x0) / PITCH) - 1); i < n; i++) {
      const x = this.x0 + i * PITCH;
      if (x > x1) break;
      if (this.inBox[i]) continue;
      const hi = known ? this.bars.h[i] : -1;
      const bh = Math.max(2, (hi >= 0 ? FLOOR + (1 - FLOOR) * hi : EVEN) * span);
      g.fillStyle = this.colour(known ? this.bars.v[i] : -1, d > 0 && i * step < t);
      g.fillRect(x, base - bh, BAR, bh);
    }
    g.globalAlpha = 1;
    // The sponsor reads: hollow, hatched, flat; not the conversation.
    for (const box of this.boxes) {
      const bx0 = this.x0 + box.i0 * PITCH;
      const bx1 = this.x0 + box.i1 * PITCH + BAR;
      if (bx1 < x0 || bx0 > x1) continue;
      g.globalAlpha = t >= box.a ? 1 : 0.6;
      hatched(g, bx0, base - span * BOX, bx1 - bx0, span * BOX, tok.faint, 3);
      g.globalAlpha = 1;
    }
    // The baseline, and the chapters' ticks under it.
    g.fillStyle = tok.line;
    g.fillRect(0, base, w, 1);
    g.fillStyle = tok.muted;
    for (const c of this.ticks) g.fillRect(Math.round(this.xOf(c)), base + 3, 1, 6);
    // Which part the magnifier shows.
    this.bracket = null;
    if (this.dragging && d > 0) {
      const a = this.xOf(Math.max(0, t - WINDOW));
      const b = this.xOf(Math.min(d, t + WINDOW));
      g.fillStyle = tok.text;
      g.globalAlpha = 0.55;
      g.fillRect(a, 0, b - a, 1);
      g.fillRect(a, 0, 1, 4);
      g.fillRect(b - 1, 0, 1, 4);
      g.globalAlpha = 1;
      this.bracket = [a, b];
    }
    // Where the listener is.
    if (d > 0) {
      g.fillStyle = tok.accent;
      g.fillRect(Math.round(this.xOf(Math.min(t, d)) * 2) / 2 - 0.75, top - 3, 1.5, base - top + 4);
    }
    g.restore();
  }

  /* ---------- the magnifier ---------- */

  drawLoupe() {
    const { player, tok } = this;
    const d = this.duration;
    const t = this.preview;
    const ch = player.chapterAt(t);
    const shape = player.shape;
    const v = voiceAt(shape, t);
    this.loupeName.textContent = ch >= 0 ? player.chapters[ch].title : v >= 0 ? shape.voices[v] : '';
    this.loupeTime.textContent = fmtTime(t);
    this.loupeFrom.textContent = fmtTime(Math.max(0, t - WINDOW));
    this.loupeTo.textContent = fmtTime(Math.min(d, t + WINDOW));
    const cv = this.loupeCv;
    if (!this.loupeFit) {
      const r = cv.getBoundingClientRect();
      if (!(r.width > 0)) return;
      cv.width = Math.round(r.width * this.dpr);
      cv.height = Math.round(r.height * this.dpr);
      this.lg = cv.getContext('2d');
      this.lg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.lw = r.width;
      this.lh = r.height;
      this.loupeFit = true;
    }
    const { lg: g, lw: w, lh: hgt } = this;
    g.clearRect(0, 0, w, hgt);
    const base = hgt - 2;
    const span = base - 2;
    const from = Math.floor(t) - WINDOW;
    const per = w / (WINDOW * 2);
    const x = (s) => (s - (t - WINDOW)) * per;
    g.fillStyle = tok.line;
    g.fillRect(0, base, w, 1);
    const z = shape ? bars(shape, { from, to: from + WINDOW * 2 + 1, count: WINDOW * 2 + 1 }) : null;
    const known = hasVoices(shape) || hasLoudness(shape);
    g.globalAlpha = known ? 1 : 0.35;
    for (let i = 0; i <= WINDOW * 2; i++) {
      const s = from + i;
      if (s < 0 || s >= d || breakIn(this.breaks, s + 0.5)) continue;
      const hi = z && known ? z.h[i] : -1;
      const bh = Math.max(1, (hi >= 0 ? hi : EVEN) * span);
      g.fillStyle = this.colour(z && known ? z.v[i] : -1, s < t);
      g.fillRect(x(s), base - bh, Math.max(1, per - 0.6), bh);
    }
    g.globalAlpha = 1;
    for (const [a, b] of this.breaks) {
      const ax = Math.max(0, x(a));
      const bx = Math.min(w, x(Math.min(b, d)));
      if (bx > ax) hatched(g, ax, base - span * BOX, bx - ax, span * BOX, tok.faint, 4);
    }
    g.fillStyle = tok.muted;
    for (const c of this.ticks) { const cx = x(c); if (cx > 0 && cx < w) g.fillRect(Math.round(cx), 2, 1, span); }
    g.fillStyle = tok.accent;
    g.fillRect(Math.round(w / 2) - 0.75, 0, 1.5, hgt);
  }
}

const breakIn = (breaks, s) => breaks.some(([a, b]) => s >= a && s < b);

function hatched(g, x, y, w, hgt, colour, gap) {
  g.save();
  g.strokeStyle = colour;
  g.lineWidth = 1;
  g.strokeRect(x + 0.5, y + 0.5, w - 1, hgt - 0.5);
  g.beginPath();
  g.rect(x, y, w, hgt);
  g.clip();
  g.beginPath();
  for (let k = -hgt; k < w + hgt; k += gap) { g.moveTo(x + k, y + hgt); g.lineTo(x + k + hgt, y); }
  g.stroke();
  g.restore();
}
