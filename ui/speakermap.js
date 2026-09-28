// Draws the speaker map (lib/speakermap.js) as a grid of cells: one row per voice, one column
// per time slice, shaded by how much that voice talks. Click a cell to play from there; drag
// across cells to select an interval.
import { fmtTime } from '../lib/text.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export class SpeakerMap {
  constructor(root, { onPlay, onSelect } = {}) {
    this.root = root;
    this.onPlay = onPlay;
    this.onSelect = onSelect;
    this.map = null;
    this.sel = null; // { c0, c1 } in columns
    this.drag = null;
    root.addEventListener('pointerdown', (e) => this.down(e));
    root.addEventListener('pointermove', (e) => this.move(e));
    root.addEventListener('pointerup', (e) => this.up(e));
    root.addEventListener('pointercancel', () => { this.drag = null; });
  }

  // label(speaker) -> display name
  render(map, label) {
    this.map = map;
    if (this.sel && this.sel.c1 >= map.cols) this.sel = null;
    const box = el('div', 'map');
    box.style.setProperty('--cols', map.cols);
    const ticks = el('div', 'map-ticks');
    ticks.append(el('span', 'map-corner', `${map.cell >= 60 ? `${map.cell / 60} min` : `${map.cell} s`} cells`));
    const scale = el('div', 'map-scale');
    const every = Math.max(1, Math.ceil(map.cols / 8));
    for (let c = 0; c < map.cols; c += every) {
      const t = el('span', '', fmtTime(c * map.cell));
      t.style.gridColumn = `${c + 1} / span ${every}`;
      scale.append(t);
    }
    ticks.append(scale);
    box.append(ticks);
    const rows = map.rows.length ? map.rows : [{ speaker: null, share: new Array(map.cols).fill(0) }];
    for (const r of rows) {
      const row = el('div', 'map-row');
      row.append(el('span', 'map-label', r.speaker == null ? 'Speech' : label(r.speaker)));
      if (r.speaker != null) row.lastChild.dataset.hue = Number(r.speaker) % 6;
      const cells = el('div', 'map-cells');
      r.share.forEach((v, c) => {
        const i = el('i');
        if (v > 0.02) i.style.setProperty('--v', Math.max(0.18, v).toFixed(2));
        i.dataset.c = c;
        cells.append(i);
      });
      row.append(cells);
      box.append(row);
    }
    const area = el('div', 'map-area');
    this.lasso = el('div', 'map-lasso');
    this.head = el('div', 'map-head');
    area.append(this.lasso, this.head);
    box.append(area);
    this.root.replaceChildren(box);
    this.box = box;
    this.paintSelection();
    this.setPlayhead(this.playhead);
  }

  col(e) {
    const cells = this.box?.querySelector('.map-cells');
    if (!cells || !this.map) return null;
    const r = cells.getBoundingClientRect();
    if (e.clientX < r.left - 2 || e.clientX > r.right + 2) return null;
    return Math.max(0, Math.min(this.map.cols - 1, Math.floor(((e.clientX - r.left) / r.width) * this.map.cols)));
  }

  down(e) {
    const c = this.col(e);
    if (c == null || e.button > 0) return;
    this.drag = { c0: c, c1: c, moved: false };
    this.root.setPointerCapture?.(e.pointerId);
  }

  move(e) {
    if (!this.drag) return;
    const c = this.col(e);
    if (c == null || c === this.drag.c1) return;
    this.drag.c1 = c;
    this.drag.moved = true;
    this.sel = { c0: Math.min(this.drag.c0, c), c1: Math.max(this.drag.c0, c) };
    this.paintSelection();
  }

  up() {
    const d = this.drag;
    this.drag = null;
    if (!d || !this.map) return;
    if (!d.moved) {
      this.onPlay?.(d.c0 * this.map.cell);
      return;
    }
    this.emit();
  }

  emit() {
    if (!this.sel) { this.onSelect?.(null); return; }
    const { cell, total } = this.map;
    this.onSelect?.({ from: this.sel.c0 * cell, to: Math.min(total, (this.sel.c1 + 1) * cell) });
  }

  clear() {
    this.sel = null;
    this.paintSelection();
  }

  paintSelection() {
    if (!this.box) return;
    const on = this.sel;
    this.box.classList.toggle('selecting', !!on);
    for (const i of this.box.querySelectorAll('.map-cells i')) {
      const c = Number(i.dataset.c);
      i.classList.toggle('in', !!on && c >= on.c0 && c <= on.c1);
    }
    if (on) {
      this.lasso.style.left = `${(on.c0 / this.map.cols) * 100}%`;
      this.lasso.style.width = `${((on.c1 - on.c0 + 1) / this.map.cols) * 100}%`;
    }
  }

  setPlayhead(t) {
    this.playhead = t;
    if (!this.head || !this.map) return;
    const show = t != null && t >= 0 && t <= this.map.total;
    this.head.hidden = !show;
    if (show) this.head.style.left = `${(t / (this.map.cols * this.map.cell)) * 100}%`;
  }
}
