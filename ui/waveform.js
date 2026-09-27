// The episode's waveform: dots where audio hasn't been decoded yet, grey bars for decoded
// audio waiting for the model, colour for transcribed audio, and a playhead. After the
// transcript is done it becomes a scrubber for playback.
import { secondLevels, barHeights } from '../lib/levels.js';
import { fmtTime } from '../lib/text.js';

export class Waveform {
  constructor(wrap, canvas, tip, { onSeek } = {}) {
    this.wrap = wrap;
    this.canvas = canvas;
    this.tip = tip;
    this.onSeek = onSeek;
    this.ctx = canvas.getContext('2d');
    this.total = 0;
    this.levels = new Uint8Array(0);
    this.done = 0;
    this.download = null;
    this.position = null;
    this.seekable = false;
    this.finished = false;
    this.raf = 0;
    new ResizeObserver(() => this.schedule()).observe(wrap);
    wrap.addEventListener('pointermove', (e) => this.hover(e));
    wrap.addEventListener('pointerleave', () => wrap.classList.remove('hovering'));
    wrap.addEventListener('click', (e) => {
      if (this.seekable && this.total) this.onSeek?.(this.timeAt(e.clientX));
    });
    wrap.addEventListener('keydown', (e) => {
      if (!this.seekable || !this.total) return;
      const step = e.shiftKey ? 30 : 5;
      const now = this.position ?? 0;
      if (e.key === 'ArrowRight') { e.preventDefault(); this.onSeek?.(Math.min(this.total, now + step)); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.onSeek?.(Math.max(0, now - step)); }
    });
  }

  reset(total = 0, levels = null) {
    this.total = total;
    this.levels = levels ? Uint8Array.from(levels) : new Uint8Array(Math.ceil(total));
    this.done = 0;
    this.download = null;
    this.position = null;
    this.finished = false;
    this.schedule();
  }

  setTotal(total) {
    if (!total || Math.abs(total - this.total) < 0.5 && this.levels.length >= Math.ceil(total)) return;
    const lv = new Uint8Array(Math.ceil(total));
    lv.set(this.levels.subarray(0, lv.length));
    this.levels = lv;
    this.total = total;
    this.schedule();
  }

  addPiece(startSec, samples) {
    const lv = secondLevels(samples);
    const at = Math.floor(startSec);
    if (at + lv.length > this.levels.length) {
      const grown = new Uint8Array(at + lv.length);
      grown.set(this.levels);
      this.levels = grown;
    }
    this.levels.set(lv, at);
    this.schedule();
  }

  setDone(sec) { this.done = sec; this.schedule(); }
  setDownload(fraction) { this.download = fraction; this.schedule(); }
  setPosition(sec) { this.position = sec; this.schedule(); }
  setFinished(on) { this.finished = on; this.schedule(); }

  setSeekable(on) {
    this.seekable = on;
    this.wrap.classList.toggle('seekable', on);
    this.wrap.tabIndex = on ? 0 : -1;
    this.wrap.setAttribute('role', on ? 'slider' : 'progressbar');
    this.wrap.setAttribute('aria-label', on ? 'Playback position' : 'Progress');
    if (!on) this.wrap.classList.remove('hovering');
  }

  timeAt(clientX) {
    const r = this.wrap.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * this.total;
  }

  hover(e) {
    if (!this.seekable || !this.total || e.pointerType === 'touch') return;
    const r = this.wrap.getBoundingClientRect();
    this.tip.textContent = fmtTime(this.timeAt(e.clientX));
    this.tip.style.left = `${Math.max(24, Math.min(r.width - 24, e.clientX - r.left))}px`;
    this.wrap.classList.add('hovering');
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  draw() {
    const { canvas, ctx, wrap } = this;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(wrap);
    const color = (name) => css.getPropertyValue(name).trim();
    const idle = color('--wave-idle');
    const decoded = color('--wave-decoded');
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, color('--wave-done'));
    grad.addColorStop(1, color('--wave-done-2'));

    const step = w < 420 ? 4 : 5;
    const barW = step - (w < 420 ? 1.6 : 2);
    const count = Math.max(1, Math.floor(w / step));
    const offset = (w - count * step) / 2;
    const mid = h / 2;
    const maxH = h * 0.9;
    const bars = this.total ? barHeights(this.levels, count) : new Float32Array(count).fill(-1);
    const head = this.position ?? (this.finished ? null : this.done || null);
    const headX = head != null && this.total ? (head / this.total) * w : null;

    for (let i = 0; i < count; i++) {
      const x = offset + i * step + (step - barW) / 2;
      const t = ((i + 0.5) / count) * this.total;
      const v = bars[i];
      let fill;
      let alpha = 1;
      let bh;
      if (v < 0) {
        bh = 2;
        const received = this.download != null && !this.total && (i + 0.5) / count <= this.download;
        fill = received ? decoded : idle;
      } else {
        bh = Math.max(2, v * maxH);
        if (this.finished) {
          fill = grad;
          if (this.position != null && t > this.position) alpha = 0.38;
        } else if (t <= this.done) {
          fill = grad;
        } else {
          fill = decoded;
        }
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      roundRect(ctx, x, mid - bh / 2, barW, bh, Math.min(barW / 2, bh / 2));
    }
    ctx.globalAlpha = 1;

    if (headX != null) {
      const x = Math.max(1, Math.min(w - 1, headX));
      ctx.fillStyle = color('--wave-head');
      ctx.fillRect(x - 1, 4, 2, h - 8);
      ctx.beginPath();
      ctx.arc(x, 5, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    const pct = this.total ? Math.round(((this.position ?? this.done) / this.total) * 100) : 0;
    wrap.setAttribute('aria-valuenow', String(Math.min(100, pct)));
    if (this.seekable) wrap.setAttribute('aria-valuetext', `${fmtTime(this.position ?? 0)} of ${fmtTime(this.total)}`);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}
