// The clean-up studio: what the analysis found in each voice, a control for every module, an
// A/B preview of a stretch of the episode (re-rendered as you move a control), and the export.
// The audio work happens in enhance-worker.js; this file is the page around it.
import { VOICE_MODULES, MASTER_MODULES, VOICE_PRESETS, applyPreset, voiceDefaults, masterDefaults, RATE } from '../lib/enhance/chain.js';
import { fmtTime } from '../lib/text.js';
import { RealFFT } from '../lib/enhance/dsp.js';

const PREVIEW = 20; // seconds
const PREROLL = 6; // seconds the chain hears before the preview starts (its levels settle)
const KEEP_EPISODES = 4;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const icon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};
const kHz = (hz) => `${(hz / 1000).toFixed(1)} kHz`;
// A duration in words ("11 min", "2 h 20 min"): mm:ss reads like a clock time.
export function inWords(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

// A value as the control shows it.
function fmtParam(p, v) {
  if (v === 'auto') return 'Auto';
  if (p.kind === 'choice') return p.options.find(([k]) => String(k) === String(v))?.[1] ?? String(v);
  const n = Number(v);
  const digits = p.step && p.step < 1 ? (p.step < 0.1 ? 2 : 1) : 0;
  let s = n.toFixed(digits);
  if (p.signed && n > 0) s = `+${s}`;
  if (p.unit === 'Hz' && n >= 1000) return kHz(n);
  return p.unit ? `${s} ${p.unit}` : s;
}

export class Studio {
  constructor(deps) {
    this.deps = deps;
    const $ = (s) => document.querySelector(s);
    this.els = {
      card: $('#studio'), art: $('#studio-art'), show: $('#studio-show'), title: $('#studio-title'), close: $('#studio-close'),
      stage: $('#studio-stage'), detail: $('#studio-detail'), meter: $('#studio-meter'), status: $('#studio-status'),
      findings: $('#studio-findings'), body: $('#studio-body'),
      overview: $('#studio-overview'), canvas: $('#studio-canvas'), tip: $('#studio-tip'),
      play: $('#pv-play'), ab: $('#pv-ab'), where: $('#pv-where'), whereSub: $('#pv-where-sub'), prev: $('#pv-prev'), next: $('#pv-next'),
      match: $('#pv-match'), loud: $('#pv-loud'), pvState: $('#pv-state'),
      tabs: $('#studio-tabs'), panel: $('#studio-panel'),
      format: $('#export-format'), exportBtn: $('#export-go'), exportCancel: $('#export-cancel'), exportMeter: $('#export-meter'), exportNote: $('#export-note'),
      steps: $('#steps-clean'),
    };
    this.ctx = null;
    this.player = null;
    this.analysis = null;
    this.settings = null;
    this.tab = null;
    this.pv = { from: 0, to: PREVIEW, orig: null, proc: null, seq: 0, rendered: '', loud: null };
    this.jobId = 0;
    this.busy = false;
    this.renderTimer = 0;
    this.wire();
  }

  /* ---------- worker ---------- */

  worker() {
    if (!this.w) {
      this.w = new Worker(new URL('../enhance-worker.js', import.meta.url), { type: 'module' });
      this.waiting = new Map();
      this.w.onmessage = ({ data }) => {
        const wait = this.waiting.get(`${data.id}:${data.type}`) || this.waiting.get(`${data.id}:*`);
        if (data.type === 'error') {
          for (const [k, fn] of this.waiting) if (k.startsWith(`${data.id}:`)) { this.waiting.delete(k); fn.reject(new Error(data.message)); }
          return;
        }
        if (wait) { this.waiting.delete(`${data.id}:${data.type}`); wait.resolve(data); }
        if (data.type === 'export-chunk') this.onChunk?.(data);
      };
      this.w.onerror = (e) => {
        for (const fn of this.waiting.values()) fn.reject(new Error(e.message || 'The clean-up worker stopped'));
        this.waiting.clear();
        this.w = null;
      };
    }
    return this.w;
  }

  ask(msg, reply, transfer) {
    const w = this.worker();
    return new Promise((resolve, reject) => {
      this.waiting.set(`${msg.id}:${reply}`, { resolve, reject });
      w.postMessage(msg, transfer || []);
    });
  }

  /* ---------- opening an episode ---------- */

  // source: { key, title, show, art, blob, duration, speakers?, names?, url? }
  async open(source) {
    this.stopPlayback();
    this.source = source;
    this.jobId++;
    const job = this.jobId;
    const { els } = this;
    els.card.classList.remove('hidden');
    els.title.textContent = source.title || 'Episode';
    els.show.textContent = source.show ? `${source.show} · clean up` : 'Clean up';
    this.deps.artInto?.(els.art, source);
    els.body.classList.add('hidden');
    els.findings.replaceChildren();
    this.setStep('listen');
    this.settings = null;
    this.analysis = null;
    this.alt = null;
    this.regen = null;
    clearTimeout(this.regenTimer);

    const cacheKey = `clean:a:${source.key}`;
    let analysis = load(cacheKey);
    const wantSpeakers = !!source.speakers?.length;
    if (analysis && (analysis.v !== 3 || (wantSpeakers && analysis.by !== 'speaker'))) analysis = null;
    try {
      if (analysis) {
        await this.ask({ type: 'setup', id: job, analysis }, 'ack');
      } else {
        analysis = await this.analyse(job);
        if (job !== this.jobId) return;
        analysis.v = 3;
        this.remember(cacheKey, analysis);
      }
    } catch (err) {
      if (job !== this.jobId) return;
      this.status('Stopped', err.message || String(err), null);
      this.deps.toast?.("Couldn't listen to this episode.");
      throw err;
    }
    if (job !== this.jobId) return;
    this.analysis = analysis;
    this.settings = this.loadSettings();
    this.tab = this.firstTab();
    this.renderFindings();
    this.renderTabs();
    this.renderPanel();
    els.body.classList.remove('hidden');
    this.status('Ready', this.readyText(), null);
    this.setStep('tune');
    const v = this.analysis.voices.find((x) => x.id === this.tab);
    this.setPreview(v?.worst?.start ?? 0, 'worst');
    this.drawOverview();
    this.regenResume();
  }

  close() {
    this.jobId++;
    clearTimeout(this.regenTimer);
    this.stopPlayback();
    this.exportCancel();
    this.els.card.classList.add('hidden');
    this.source = null;
  }

  async analyse(job) {
    const { blob } = this.source;
    let total = this.source.duration || 0;
    let done = 0;
    this.status('Listening to the episode', 'Finding the voices and what each one needs', 0);
    this.worker().postMessage({ type: 'analyze-start', id: job });
    for await (const piece of this.deps.decodePieces(blob, (t) => { total = t; }, 0, RATE)) {
      if (job !== this.jobId) throw new DOMException('Cancelled', 'AbortError');
      done += piece.length / RATE;
      await this.ask({ type: 'analyze-push', id: job, samples: piece }, 'ack', [piece.buffer]);
      this.status('Listening to the episode', `${fmtTime(done)} of ${fmtTime(total)}`, total ? done / total : null);
    }
    const speakers = this.source.speakers?.map(({ start, end, speaker }) => ({ start, end, speaker }));
    const r = await this.ask({ type: 'analyze-finish', id: job, speakers, names: this.source.names || {} }, 'analysis');
    return r.result;
  }

  // Keeps the analysis of the last few episodes (it takes a while for a long one).
  remember(key, value) {
    const keys = (load('clean:keys') || []).filter((k) => k !== key);
    keys.unshift(key);
    for (const old of keys.splice(KEEP_EPISODES)) { try { localStorage.removeItem(old); } catch {} }
    save('clean:keys', keys);
    if (!save(key, value)) { try { localStorage.removeItem(key); } catch {} }
  }

  loadSettings() {
    const saved = load(`clean:s:${this.source.key}`);
    const s = { voices: {}, master: saved?.master || masterDefaults() };
    for (const v of this.analysis.voices) s.voices[v.id] = saved?.voices?.[v.id] || clone(v.suggested || voiceDefaults());
    return s;
  }

  saveSettings() {
    if (this.source) save(`clean:s:${this.source.key}`, this.settings);
  }

  // The voice that needs the most help.
  firstTab() {
    const need = (v) => Object.values(v.suggested?.modules || {}).filter((m) => m.on).length + (v.dropoutsPerMin || 0) / 3;
    return [...this.analysis.voices].sort((a, b) => need(b) - need(a))[0]?.id || 'master';
  }

  readyText() {
    const n = this.analysis.voices.length;
    const how = this.analysis.by === 'speaker' ? 'from the transcript' : 'by how they sound';
    return `${n === 1 ? 'One voice' : `${n} voices`} (${how}) · ${fmtTime(this.analysis.duration)}`;
  }

  /* ---------- what it heard ---------- */

  issues(v) {
    const out = [];
    if (v.cutoffHz) out.push({ hot: v.cutoffHz < 12000, text: `Treble stops at ${kHz(v.cutoffHz)}` });
    else if (v.bandHz) out.push({ text: `Full band to ${kHz(Math.min(v.bandHz, 20000))}` });
    if (v.dropoutsPerMin >= 1) out.push({ hot: v.dropoutsPerMin >= 3, text: `${v.dropoutsPerMin.toFixed(v.dropoutsPerMin < 10 ? 1 : 0)} dropouts a minute` });
    if (v.gatedShare >= 0.03) out.push({ hot: v.gatedShare >= 0.06, text: `Gate shuts ${Math.round(v.gatedShare * 100)} % of the time` });
    if (v.noiseDb > -140) out.push({ hot: v.noiseDb > -55, text: `Background ${Math.round(v.noiseDb)} dB` });
    if (v.humHz) out.push({ hot: true, text: `${v.humHz} Hz hum` });
    return out;
  }

  renderFindings() {
    const { findings } = this.els;
    findings.replaceChildren(...this.analysis.voices.map((v, i) => {
      const box = el('button', 'finding');
      box.type = 'button';
      box.dataset.hue = String(i % 6);
      box.append(el('b', '', v.name));
      box.append(el('small', '', `${fmtTime(v.seconds)} · ${this.issues(v).filter((x) => x.hot).length ? 'needs help' : 'sounds clean'}`));
      box.addEventListener('click', () => this.selectTab(v.id, true));
      return box;
    }));
  }

  /* ---------- tabs and panels ---------- */

  renderTabs() {
    const { tabs } = this.els;
    const items = [...this.analysis.voices.map((v, i) => ({ id: v.id, name: v.name, hue: i % 6 })), { id: 'master', name: 'Whole episode', hue: null }];
    tabs.replaceChildren(...items.map((t) => {
      const b = el('button', 'tab');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.id = `tab-${t.id}`;
      b.dataset.id = t.id;
      if (t.hue != null) b.dataset.hue = String(t.hue);
      b.setAttribute('aria-selected', String(t.id === this.tab));
      b.setAttribute('aria-controls', 'studio-panel');
      b.tabIndex = t.id === this.tab ? 0 : -1;
      b.append(el('span', 'tab-name', t.name));
      if (t.id !== 'master') {
        const on = Object.values(this.settings.voices[t.id].modules).filter((m) => m.on).length;
        b.append(el('span', 'tab-count', this.settings.voices[t.id].bypass ? 'untouched' : on ? `${on} on` : 'nothing on'));
      }
      b.addEventListener('click', () => this.selectTab(t.id, true));
      return b;
    }));
  }

  selectTab(id, movePreview = false) {
    this.tab = id;
    this.renderTabs();
    this.renderPanel();
    const v = this.analysis.voices.find((x) => x.id === id);
    if (movePreview && v && this.voiceAt((this.pv.from + this.pv.to) / 2) !== this.analysis.voices.indexOf(v)) this.setPreview(v.worst?.start ?? 0, 'worst');
  }

  renderPanel() {
    const { panel } = this.els;
    panel.setAttribute('aria-labelledby', `tab-${this.tab}`);
    panel.replaceChildren();
    if (this.tab === 'master') {
      panel.append(el('p', 'panel-note', 'These work on the whole episode after each voice has been cleaned: they even out the levels between voices and set the loudness.'));
      panel.append(this.moduleList(MASTER_MODULES, this.settings.master.modules, null));
      return;
    }
    const vi = this.analysis.voices.findIndex((x) => x.id === this.tab);
    const v = this.analysis.voices[vi];
    const vs = this.settings.voices[v.id];

    const head = el('div', 'voice-head');
    const chips = el('ul', 'chips');
    for (const it of this.issues(v)) chips.append(el('li', it.hot ? 'hot' : '', it.text));
    chips.append(el('li', '', `${fmtTime(v.seconds)} of talk`));
    head.append(chips);
    panel.append(head);

    const row = el('div', 'preset-row');
    const presets = el('div', 'presets');
    presets.setAttribute('role', 'group');
    presets.setAttribute('aria-label', 'Presets');
    const add = (name, label, fn) => {
      const b = el('button', 'preset', label);
      b.type = 'button';
      b.dataset.preset = name;
      b.addEventListener('click', () => { fn(); this.changed(true); });
      presets.append(b);
    };
    add('suggested', 'Suggested', () => { this.settings.voices[v.id] = { ...clone(v.suggested || voiceDefaults()), regen: vs.regen }; });
    for (const [name, p] of Object.entries(VOICE_PRESETS)) add(name, p.name, () => { this.settings.voices[v.id] = applyPreset(name, vs); });
    row.append(presets);
    const bypass = this.switchEl('Leave this voice untouched', vs.bypass, (on) => { vs.bypass = on; this.changed(true); });
    bypass.classList.add('bypass');
    row.append(bypass);
    panel.append(row);

    if (this.analysis.voices.length > 1) {
      const copy = el('button', 'btn ghost small copy-all', 'Use these settings for every voice');
      copy.type = 'button';
      copy.addEventListener('click', () => {
        for (const o of this.analysis.voices) if (o.id !== v.id) this.settings.voices[o.id] = { ...clone(vs), regen: this.settings.voices[o.id].regen };
        this.changed(true);
        this.deps.toast?.('Copied to every voice');
      });
      panel.append(copy);
    }

    const regen = this.regenPanel(v, vs);
    if (regen) panel.append(regen);

    const list = this.moduleList(VOICE_MODULES, vs.modules, v);
    list.classList.toggle('bypassed', !!vs.bypass);
    panel.append(list);
  }

  switchEl(label, on, onChange) {
    const wrap = el('label', 'switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !!on;
    input.addEventListener('change', () => onChange(input.checked));
    const track = el('span', 'track');
    track.append(el('span', 'knob'));
    wrap.append(input, track, el('span', 'switch-label', label));
    return wrap;
  }

  moduleList(defs, mods, voice) {
    const list = el('div', 'mods');
    let group = null;
    for (const def of defs) {
      if (def.group !== group && defs === VOICE_MODULES) {
        group = def.group;
        list.append(el('p', 'mods-group', group));
      }
      list.append(this.moduleCard(def, mods[def.id], voice));
    }
    return list;
  }

  moduleCard(def, m, voice) {
    const card = el('article', `mod${m.on ? ' on' : ''}`);
    card.dataset.mod = def.id;
    const head = el('header', 'mod-head');
    const sw = el('label', 'switch mod-switch');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !!m.on;
    input.setAttribute('aria-label', def.name);
    const track = el('span', 'track');
    track.append(el('span', 'knob'));
    sw.append(input, track);
    input.addEventListener('change', () => { m.on = input.checked; card.classList.toggle('on', m.on); this.changed(); this.renderTabs(); });
    const text = el('div', 'mod-text');
    const h = el('h3', '', def.name);
    const suggested = voice?.suggested?.modules?.[def.id]?.on;
    if (suggested) h.append(el('span', 'badge', 'Suggested'));
    text.append(h, el('p', '', this.about(def, voice)));
    head.append(sw, text);
    card.append(head);
    const params = el('div', 'params');
    for (const p of def.params) params.append(this.param(def, p, m, card, input));
    card.append(params);
    return card;
  }

  // Module descriptions, with what the analysis measured where it helps.
  about(def, voice) {
    if (!voice) return def.about;
    if (def.id === 'highs' && voice.cutoffHz) return `${def.about} This voice stops at ${kHz(voice.cutoffHz)}.`;
    if (def.id === 'dropouts' && voice.dropouts) return `${def.about} Heard ${voice.dropouts} in this voice.`;
    if (def.id === 'dehum' && voice.humHz) return `${def.about} Heard ${voice.humHz} Hz hum.`;
    return def.about;
  }

  param(def, p, m, card, onInput) {
    const turnOn = () => { if (!m.on) { m.on = true; onInput.checked = true; card.classList.add('on'); this.renderTabs(); } };
    const wrap = el('div', 'param');
    const label = el('span', 'param-label', p.label);
    const out = el('output', 'param-value', fmtParam(p, m[p.id]));
    if (p.kind === 'choice' || p.kind === 'auto') {
      // A row of small buttons (Auto | value for 'auto').
      const seg = el('div', 'mini-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', p.label);
      const options = p.kind === 'choice' ? p.options : [['auto', this.autoLabel(def, p)], ['manual', 'Set']];
      for (const [val, text] of options) {
        const b = el('button', '', text);
        b.type = 'button';
        const isOn = p.kind === 'choice' ? String(m[p.id]) === String(val) : (val === 'auto') === (m[p.id] === 'auto');
        b.setAttribute('aria-pressed', String(isOn));
        b.addEventListener('click', () => {
          turnOn();
          if (p.kind === 'choice') m[p.id] = val;
          else m[p.id] = val === 'auto' ? 'auto' : Number(this.autoValue(def, p) || p.min);
          seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          if (range) {
            range.hidden = out.hidden = m[p.id] === 'auto';
            if (m[p.id] !== 'auto') { range.value = m[p.id]; range.dispatchEvent(new Event('fill')); }
          }
          out.textContent = fmtParam(p, m[p.id]);
          this.changed();
        });
        seg.append(b);
      }
      wrap.append(label, seg);
      let range = null;
      if (p.kind === 'auto') {
        range = this.range(p, m[p.id] === 'auto' ? (this.autoValue(def, p) || p.min) : m[p.id], (v) => { turnOn(); m[p.id] = v; out.textContent = fmtParam(p, v); this.changed(); });
        range.hidden = m[p.id] === 'auto';
        out.hidden = m[p.id] === 'auto';
        wrap.classList.add('auto-param');
        wrap.append(range, out);
      }
      return wrap;
    }
    const range = this.range(p, m[p.id], (v) => { turnOn(); m[p.id] = v; out.textContent = fmtParam(p, v); this.changed(); });
    range.setAttribute('aria-label', `${def.name}: ${p.label}`);
    wrap.classList.add('with-range');
    wrap.append(label, range, out);
    return wrap;
  }

  range(p, value, onChange) {
    const r = el('input');
    r.type = 'range';
    r.min = p.min;
    r.max = p.max;
    r.step = p.step || 1;
    r.value = value;
    const pct = (v) => ((v - p.min) / (p.max - p.min)) * 100;
    // Filled from 0 for controls that go both ways (a cut or a boost), else from the left.
    const zero = p.min < 0 && p.max > 0 ? pct(0) : 0;
    const fill = () => {
      const v = pct(Number(r.value));
      r.style.setProperty('--from', `${Math.min(zero, v)}%`);
      r.style.setProperty('--pct', `${Math.max(zero, v)}%`);
    };
    fill();
    r.addEventListener('fill', fill);
    r.addEventListener('input', () => { fill(); onChange(Number(r.value)); });
    return r;
  }

  autoValue(def, p) {
    const v = this.analysis.voices.find((x) => x.id === this.tab);
    if (def.id === 'highs' && p.id === 'cutoff') return v?.cutoffHz || 8000;
    return null;
  }

  autoLabel(def, p) {
    const a = this.autoValue(def, p);
    return a && def.id === 'highs' ? `Auto · ${kHz(a)}` : 'Auto';
  }

  // Any change: save, and re-render the preview a moment after the last one.
  changed(rebuild = false) {
    this.saveSettings();
    if (rebuild) { this.renderTabs(); this.renderPanel(); }
    clearTimeout(this.renderTimer);
    this.els.pvState.textContent = 'Updating';
    this.renderTimer = setTimeout(() => this.renderPreview(), 160);
  }

  /* ---------- preview ---------- */

  voiceAt(t) {
    const s = this.analysis?.timeline.find((x) => x.start <= t && x.end > t);
    return s ? s.voice : 0;
  }

  // Stretches worth hearing: each voice's worst, then the densest dropouts elsewhere.
  spots() {
    const a = this.analysis;
    const out = a.voices.map((v) => v.worst?.start ?? 0);
    const d = a.dropouts || [];
    const windows = [];
    for (let t = 0; t + PREVIEW <= d.length; t += 5) {
      let s = 0;
      for (let k = t; k < t + PREVIEW; k++) s += d[k];
      if (s) windows.push([t, s]);
    }
    windows.sort((x, y) => y[1] - x[1]);
    for (const [t] of windows) if (out.every((o) => Math.abs(o - t) >= PREVIEW)) out.push(t);
    return out.slice(0, 8).sort((x, y) => x - y);
  }

  setPreview(start, why = '') {
    const dur = this.analysis.duration;
    const from = Math.max(0, Math.min(Math.max(0, dur - PREVIEW), Math.round(start)));
    this.pv.from = from;
    this.pv.to = Math.min(dur, from + PREVIEW);
    this.pv.orig = null;
    this.pv.why = why;
    this.updateWhere();
    this.drawOverview();
    this.renderPreview();
  }

  updateWhere() {
    const { from, to } = this.pv;
    const v = this.analysis.voices[this.voiceAt((from + to) / 2)];
    this.els.where.textContent = `${fmtTime(from)}–${fmtTime(to)}`;
    this.els.whereSub.textContent = [v?.name, this.pv.why === 'worst' ? 'worst stretch' : ''].filter(Boolean).join(' · ');
  }

  async renderPreview() {
    if (!this.analysis || !this.source) return;
    const seq = ++this.pv.seq;
    const { from, to } = this.pv;
    const pre = Math.min(PREROLL, from);
    const key = JSON.stringify([from, to, this.settings, !!this.alt]);
    if (key === this.pv.rendered && this.pv.proc) { this.els.pvState.textContent = ''; return; }
    this.els.pvState.textContent = 'Rendering';
    try {
      if (!this.pv.orig || this.pv.origFrom !== from) {
        const x = await this.deps.decodeRange(this.source.blob, from - pre, to, RATE);
        if (seq !== this.pv.seq) return;
        this.pv.origFull = x;
        this.pv.orig = x.subarray(Math.round(pre * RATE));
        this.pv.origFrom = from;
        this.pv.altFull = this.alt ? await this.alt.range(from - pre, to) : null;
        if (seq !== this.pv.seq) return;
      }
      const samples = this.pv.origFull.slice();
      const alt = this.pv.altFull ? this.pv.altFull.slice() : null;
      const res = await this.ask({ type: 'preview', id: `p${seq}`, settings: this.settings, samples, alt, from: from - pre, skip: Math.round(pre * RATE) }, 'preview', alt ? [samples.buffer, alt.buffer] : [samples.buffer]);
      if (seq !== this.pv.seq) return;
      this.pv.proc = res.samples;
      this.pv.loud = { input: res.input, output: res.output };
      this.pv.rendered = key;
      this.els.pvState.textContent = '';
      this.showLoudness();
      this.swapBuffers();
    } catch (err) {
      if (seq !== this.pv.seq) return;
      console.error(err);
      this.els.pvState.textContent = "Couldn't render this stretch";
    }
  }

  showLoudness() {
    const l = this.pv.loud;
    if (!l) { this.els.loud.textContent = ''; return; }
    const f = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');
    this.els.loud.textContent = `${f(l.input.lufs)} → ${f(l.output.lufs)} LUFS`;
  }

  ensureCtx() {
    if (!this.ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      try { this.ctx = new C({ sampleRate: RATE }); } catch { this.ctx = new C(); }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  buffer(samples) {
    const b = this.ctx.createBuffer(1, samples.length, RATE);
    b.copyToChannel(samples, 0);
    return b;
  }

  // Gains for A/B: the original is matched to the cleaned loudness when "level-matched" is on,
  // so the louder one doesn't win just for being louder.
  gains() {
    const cleaned = this.els.ab.querySelector('input:checked')?.value !== 'orig';
    let match = 1;
    const l = this.pv.loud;
    if (this.els.match.checked && l && Number.isFinite(l.input.lufs) && Number.isFinite(l.output.lufs)) match = Math.min(4, 10 ** ((l.output.lufs - l.input.lufs) / 20));
    return { orig: cleaned ? 0 : match, proc: cleaned ? 1 : 0 };
  }

  applyGains(ramp = 0.02) {
    if (!this.player) return;
    const g = this.gains();
    const t = this.ctx.currentTime;
    for (const [node, v] of [[this.player.go, g.orig], [this.player.gp, g.proc]]) {
      node.gain.cancelScheduledValues(t);
      node.gain.setValueAtTime(node.gain.value, t);
      node.gain.linearRampToValueAtTime(v, t + ramp);
    }
  }

  async togglePlay() {
    if (this.player) { this.stopPlayback(); return; }
    if (!this.pv.orig || !this.pv.proc) { this.deps.toast?.('Still rendering the preview'); return; }
    this.ensureCtx();
    this.startPlayback(0);
  }

  startPlayback(offset) {
    const ctx = this.ctx;
    const go = ctx.createGain();
    const gp = ctx.createGain();
    go.connect(ctx.destination);
    gp.connect(ctx.destination);
    const g = this.gains();
    go.gain.value = g.orig;
    gp.gain.value = g.proc;
    const when = ctx.currentTime + 0.03;
    const dur = this.pv.orig.length / RATE;
    const src = (samples, gain) => {
      const s = ctx.createBufferSource();
      s.buffer = this.buffer(samples);
      s.loop = true;
      s.connect(gain);
      s.start(when, offset % dur);
      return s;
    };
    this.player = { go, gp, so: src(this.pv.orig, go), sp: src(this.pv.proc, gp), t0: when - (offset % dur), dur };
    this.els.play.classList.add('playing');
    this.els.play.setAttribute('aria-label', 'Pause preview');
    this.setIcon('pause');
    this.tick();
  }

  // New render while playing: carry on from the same spot with the new sound.
  swapBuffers() {
    if (!this.player) return;
    const pos = this.position();
    for (const s of [this.player.so, this.player.sp]) { try { s.stop(); } catch {} }
    this.player.go.disconnect();
    this.player.gp.disconnect();
    this.player = null;
    this.startPlayback(pos);
  }

  position() {
    if (!this.player) return null;
    const p = (this.ctx.currentTime - this.player.t0) % this.player.dur;
    return p < 0 ? p + this.player.dur : p;
  }

  stopPlayback() {
    if (!this.player) return;
    for (const s of [this.player.so, this.player.sp]) { try { s.stop(); } catch {} }
    this.player.go.disconnect();
    this.player.gp.disconnect();
    this.player = null;
    cancelAnimationFrame(this.raf);
    this.els.play.classList.remove('playing');
    this.els.play.setAttribute('aria-label', 'Play preview');
    this.setIcon('play');
    this.drawOverview();
  }

  setIcon(name) {
    const use = this.els.play.querySelector('use');
    if (use) use.setAttribute('href', `#i-${name}`);
  }

  tick() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      if (!this.player) return;
      this.drawOverview();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  /* ---------- overview ---------- */

  drawOverview() {
    const a = this.analysis;
    const { canvas, overview } = this.els;
    const w = overview.clientWidth;
    const h = overview.clientHeight;
    if (!a || !w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(overview);
    const col = (n) => css.getPropertyValue(n).trim();
    const hues = [0, 1, 2, 3, 4, 5].map((i) => col(`--spk-${i}`));
    const dur = a.duration || 1;
    const step = w < 420 ? 3 : 4;
    const count = Math.max(1, Math.floor(w / step));
    const mid = (h - 10) / 2;
    const levels = a.levels || [];
    for (let i = 0; i < count; i++) {
      const t0 = Math.floor((i / count) * dur);
      const t1 = Math.max(t0 + 1, Math.floor(((i + 1) / count) * dur));
      let lv = 0;
      for (let t = t0; t < t1 && t < levels.length; t++) lv = Math.max(lv, levels[t]);
      const bh = Math.max(2, (lv / 255) * (h - 14));
      ctx.fillStyle = hues[this.voiceAt((t0 + t1) / 2) % 6];
      ctx.globalAlpha = 0.85;
      ctx.fillRect(i * step, mid - bh / 2, step - 1, bh);
    }
    ctx.globalAlpha = 1;
    // Dropouts: red ticks along the bottom.
    const d = a.dropouts || [];
    ctx.fillStyle = col('--accent');
    for (let i = 0; i < count; i++) {
      const t0 = Math.floor((i / count) * dur);
      const t1 = Math.max(t0 + 1, Math.floor(((i + 1) / count) * dur));
      let n = 0;
      for (let t = t0; t < t1 && t < d.length; t++) n += d[t];
      if (n) ctx.fillRect(i * step, h - 2 - Math.min(6, 1 + n), step - 1, Math.min(6, 1 + n));
    }
    // The preview window, and the playhead in it.
    const x0 = (this.pv.from / dur) * w;
    const x1 = Math.max(x0 + 3, (this.pv.to / dur) * w);
    ctx.strokeStyle = col('--text');
    ctx.lineWidth = 1.5;
    ctx.fillStyle = col('--accent-soft');
    ctx.fillRect(x0, 1, x1 - x0, h - 2);
    ctx.strokeRect(x0 + 0.75, 1, x1 - x0 - 1.5, h - 2);
    const pos = this.position();
    if (pos != null) {
      const x = ((this.pv.from + pos) / dur) * w;
      ctx.fillStyle = col('--accent');
      ctx.fillRect(x - 1, 0, 2, h);
    }
    overview.setAttribute('aria-valuetext', `Preview ${fmtTime(this.pv.from)} to ${fmtTime(this.pv.to)} of ${fmtTime(dur)}`);
  }

  timeAt(clientX) {
    const r = this.els.overview.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * (this.analysis?.duration || 0);
  }

  /* ---------- export ---------- */

  async exportAll() {
    if (!this.analysis || this.exporting) return;
    const [format, kbps] = (this.els.format.querySelector('input:checked')?.value || 'mp3-192').split('-');
    const id = `x${Date.now()}`;
    const job = this.jobId;
    this.exporting = { id, cancelled: false };
    this.stopPlayback();
    const { els } = this;
    els.exportBtn.disabled = true;
    els.exportCancel.classList.remove('hidden');
    this.setStep('export');
    const parts = [];
    let total = this.analysis.duration;
    let done = 0;
    const started = performance.now();
    const note = (text, frac) => {
      els.exportNote.textContent = text;
      els.exportMeter.parentElement.classList.toggle('hidden', frac == null);
      els.exportMeter.style.width = `${Math.round((frac || 0) * 100)}%`;
    };
    this.deps.setBusy?.(true);
    try {
      await this.ask({ type: 'export-start', id, settings: this.settings, format, kbps: Number(kbps) || 192, hasAlt: !!this.alt }, 'ack');
      this.onChunk = (m) => { if (m.id === id) parts.push(m.bytes); };
      const altPieces = this.alt ? this.alt.pieces() : null;
      for await (const piece of this.deps.decodePieces(this.source.blob, (t) => { total = t; }, 0, RATE)) {
        if (this.exporting?.cancelled || job !== this.jobId) throw new DOMException('Cancelled', 'AbortError');
        const alt = altPieces ? await altPieces.take(piece.length) : null;
        done += piece.length / RATE;
        await this.ask({ type: 'export-push', id, samples: piece, alt }, 'export-chunk', alt ? [piece.buffer, alt.buffer] : [piece.buffer]);
        const el2 = (performance.now() - started) / 1000;
        const left = done ? (el2 / done) * (total - done) : 0;
        note(`Rendering · ${fmtTime(done)} of ${fmtTime(total)}${done > 30 ? ` · about ${inWords(left)} left` : ''}`, total ? done / total : null);
      }
      const end = await this.ask({ type: 'export-end', id }, 'export-done');
      parts.push(end.bytes);
      const blob = new Blob([end.header, ...parts], { type: format === 'mp3' ? 'audio/mpeg' : 'audio/wav' });
      const name = `${(this.source.title || 'episode').replace(/[\\/:*?"<>|]+/g, '').slice(0, 90).trim() || 'episode'} (cleaned).${format === 'mp3' ? 'mp3' : 'wav'}`;
      this.deps.saveBlob(blob, name);
      note(`Done in ${inWords((performance.now() - started) / 1000)} · ${Number.isFinite(end.lufs) ? end.lufs.toFixed(1) : '–'} LUFS · peak ${end.peak.toFixed(1)} dB · ${(blob.size / 1e6).toFixed(1)} MB`, null);
      this.setStep('done');
      this.deps.toast?.('Cleaned episode saved');
    } catch (err) {
      this.w?.postMessage({ type: 'cancel', id });
      if (err.name === 'AbortError') note('Export cancelled', null);
      else { console.error(err); note(`Export failed: ${err.message || err}`, null); }
      this.setStep('tune');
    } finally {
      this.onChunk = null;
      this.exporting = null;
      this.deps.setBusy?.(false);
      els.exportBtn.disabled = false;
      els.exportCancel.classList.add('hidden');
    }
  }

  exportCancel() {
    if (this.exporting) this.exporting.cancelled = true;
  }

  /* ---------- status ---------- */

  status(stage, detail, fraction) {
    this.els.stage.textContent = stage;
    this.els.detail.textContent = detail || '';
    this.els.meter.parentElement.classList.toggle('hidden', fraction == null);
    this.els.meter.style.width = `${Math.round((fraction || 0) * 100)}%`;
    this.deps.onStatus?.(stage, detail);
  }

  setStep(step) {
    const order = ['find', 'download', 'listen', 'tune', 'export'];
    const at = step === 'done' ? order.length : order.indexOf(step);
    this.els.steps?.querySelectorAll('li').forEach((li) => {
      const i = order.indexOf(li.dataset.step);
      li.classList.toggle('done', i < at);
      li.classList.toggle('active', i === at);
    });
  }

  /* ---------- regeneration on the server ----------
   * One job per episode covers every voice asked for so far (asking for one more starts a new
   * job with the union). Its result is the whole episode with those voices rebuilt and the rest
   * untouched, used as the input of each voice that has "use the regenerated voice" on. */

  regenKey() { return `clean:r:${this.source.key}`; }

  // Where the server can download this episode from (it can't reach a file on this device).
  regenUrl() {
    const u = this.source.url || '';
    if (/^https?:\/\//i.test(u)) return u;
    if (/^library\/[\w-]+\.(mp3|m4a)$/.test(this.source.serverAudio || '')) return this.source.serverAudio;
    return '';
  }

  voiceRanges(ids) {
    const idx = new Set(ids.map((id) => this.analysis.voices.findIndex((v) => v.id === id)));
    const out = [];
    for (const s of this.analysis.timeline) {
      if (!idx.has(s.voice) || s.end - s.start < 1) continue;
      const last = out[out.length - 1];
      if (last && s.start - last[1] < 1.5) last[1] = s.end; else out.push([s.start, s.end]);
    }
    return out.map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100]);
  }

  regenPanel(v, vs) {
    if (!this.deps.server?.available) return null;
    const box = el('section', 'regen');
    const text = el('div', 'regen-text');
    const h = el('h3', '', 'Regenerate this voice');
    h.append(el('span', 'badge', 'On the server'));
    const mins = Math.max(1, Math.round(v.seconds / 60));
    text.append(h, el('p', '', `Rebuilds the voice itself with a speech model (Resemble Enhance) on GitHub's computers. It can fix the robotic, over-compressed sound that the tools below can't, but the voice is re-synthesised, so listen for slurred words. ${inWords(mins * 60)} of this voice takes about ${inWords(mins * 60 * 3.5)}; you can close the page meanwhile.`));
    box.append(text);
    const row = el('div', 'regen-row');
    const job = this.regen;
    const covered = job?.voices?.includes(v.id);
    const url = this.regenUrl();
    if (!url) {
      row.append(el('p', 'hint', 'Needs the episode as a link: the server downloads it itself, and a file on this device is out of its reach.'));
    } else if (covered && job.status === 'done') {
      row.append(this.switchEl('Use the regenerated voice', vs.regen, (on) => { vs.regen = on; this.useAlt(); this.changed(true); }));
      row.append(el('span', 'regen-state ok', this.alt ? 'Ready' : vs.regen ? 'Loading' : 'Ready'));
    } else if (covered && (job.status === 'queued' || job.status === 'working')) {
      const pct = job.status === 'working' ? `${Math.round((job.progress || 0) * 100)} %` : '';
      const eta = job.eta && job.eta > Date.now() ? ` · about ${inWords((job.eta - Date.now()) / 1000)} left` : '';
      row.append(el('span', 'regen-state', job.status === 'queued' ? 'Waiting for a runner (they check every ten minutes)' : `Regenerating · ${pct}${eta}${job.message ? ` · ${job.message}` : ''}`));
    } else {
      if (covered && job.status === 'failed') row.append(el('span', 'regen-state bad', `Failed: ${job.message || 'no reason given'}`));
      const b = el('button', 'btn ghost small', covered ? 'Try again' : 'Regenerate on the server');
      b.type = 'button';
      b.addEventListener('click', () => this.regenStart(v.id, b));
      row.append(b);
    }
    box.append(row);
    return box;
  }

  async regenStart(voiceId, button) {
    const prev = this.regen?.status === 'done' || this.regen?.status === 'working' || this.regen?.status === 'queued' ? this.regen.voices : [];
    const voices = [...new Set([...prev, voiceId])];
    button.disabled = true;
    try {
      const res = await fetch(`${this.deps.server.base}api/enhance`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: this.regenUrl(), title: this.source.title, show: this.source.show, ranges: this.voiceRanges(voices) }),
      });
      const job = await res.json();
      if (!res.ok) throw new Error(job.error || `HTTP ${res.status}`);
      this.regen = { ...job, voices };
      save(this.regenKey(), this.regen);
      this.deps.toast?.('Sent to the server');
      this.renderPanel();
      this.regenPoll();
    } catch (err) {
      button.disabled = false;
      this.deps.toast?.(`The server said no: ${err.message}`);
    }
  }

  regenResume() {
    if (!this.deps.server?.available || !this.source) return;
    this.regen = load(this.regenKey());
    if (!this.regen) return;
    if (this.regen.status === 'done') this.useAlt();
    else this.regenPoll(0);
  }

  regenPoll(delay = 20000) {
    clearTimeout(this.regenTimer);
    const job = this.jobId;
    this.regenTimer = setTimeout(async () => {
      if (job !== this.jobId || !this.regen) return;
      try {
        const res = await fetch(`${this.deps.server.base}api/enhance/${this.regen.id}`, { cache: 'no-store' });
        if (res.status === 404) { this.regen = null; try { localStorage.removeItem(this.regenKey()); } catch {} this.renderPanel(); return; }
        const j = await res.json();
        if (job !== this.jobId) return;
        const was = this.regen.status;
        this.regen = { ...this.regen, ...j };
        save(this.regenKey(), this.regen);
        if (this.tab !== 'master') this.renderPanel();
        if (j.status === 'done' && was !== 'done') { this.deps.toast?.('The regenerated voice is ready'); this.useAlt(); }
        if (j.status === 'queued' || j.status === 'working') this.regenPoll();
      } catch {
        this.regenPoll(60000);
      }
    }, delay);
  }

  // Loads the regenerated episode (once) when a voice wants it, lined up with this decoding.
  async useAlt() {
    const job = this.regen;
    const want = job?.status === 'done' && Object.values(this.settings?.voices || {}).some((v) => v.regen);
    if (!want) { if (this.alt) { this.alt = null; this.pv.orig = null; this.renderPreview(); } return; }
    if (this.alt?.id === job.id || this.altLoading === job.id) return;
    this.altLoading = job.id;
    try {
      const blob = await this.deps.fetchCached(`${this.deps.server.base}${job.audio}`);
      const lag = await this.alignment(blob, job.ranges);
      if (this.regen?.id !== job.id) return;
      const deps = this.deps;
      this.alt = {
        id: job.id,
        lag,
        range: (from, to) => deps.decodeRange(blob, from + lag, to + lag, RATE),
        pieces: () => {
          const gen = deps.decodePieces(blob, () => {}, Math.max(0, lag), RATE);
          let buf = new Float32Array(Math.max(0, Math.round(-lag * RATE)));
          let ended = false;
          return {
            async take(n) {
              while (buf.length < n && !ended) {
                const { value, done } = await gen.next();
                if (done) { ended = true; break; }
                const b = new Float32Array(buf.length + value.length);
                b.set(buf);
                b.set(value, buf.length);
                buf = b;
              }
              const out = new Float32Array(n);
              out.set(buf.subarray(0, n));
              buf = buf.slice(Math.min(n, buf.length));
              return out;
            },
          };
        },
      };
      this.pv.orig = null;
      if (this.tab !== 'master') this.renderPanel();
      this.renderPreview();
    } catch (err) {
      console.error(err);
      this.deps.toast?.("Couldn't load the regenerated voice");
    } finally {
      this.altLoading = null;
    }
  }

  // Seconds by which the regenerated file runs late against this decoding: cross-correlation of
  // the two loudness envelopes (1 ms resolution), which survive the voice being re-synthesised,
  // over 8 s, preferring a stretch the model left alone.
  async alignment(blob, ranges) {
    const dur = this.analysis.duration;
    let at = Math.min(30, Math.max(0, dur - 10));
    let prev = 0;
    for (const [a, b] of [...ranges, [dur, dur]]) {
      if (a - prev >= 10 && prev + 1 < dur - 9) { at = prev + 1; break; }
      prev = b;
    }
    const maxLag = Math.round(0.25 * RATE);
    const n = 8 * RATE;
    const x = await this.deps.decodeRange(this.source.blob, at, at + n / RATE, RATE);
    const y = await this.deps.decodeRange(blob, at - maxLag / RATE, at + (n + maxLag) / RATE, RATE);
    return alignEnvelopes(x, y, maxLag) / RATE;
  }

  /* ---------- events ---------- */

  wire() {
    const { els } = this;
    els.close.addEventListener('click', () => this.deps.onClose?.());
    els.play.addEventListener('click', () => this.togglePlay());
    els.ab.addEventListener('change', () => this.applyGains());
    els.match.addEventListener('change', () => this.applyGains());
    els.prev.addEventListener('click', () => this.jump(-1));
    els.next.addEventListener('click', () => this.jump(1));
    els.exportBtn.addEventListener('click', () => this.exportAll());
    els.exportCancel.addEventListener('click', () => this.exportCancel());
    els.overview.addEventListener('click', (e) => { if (this.analysis) this.setPreview(this.timeAt(e.clientX) - PREVIEW / 2); });
    els.overview.addEventListener('keydown', (e) => {
      if (!this.analysis) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); this.setPreview(this.pv.from + (e.shiftKey ? 60 : 10)); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); this.setPreview(this.pv.from - (e.shiftKey ? 60 : 10)); }
    });
    els.overview.addEventListener('pointermove', (e) => {
      if (!this.analysis || e.pointerType === 'touch') return;
      const t = this.timeAt(e.clientX);
      const v = this.analysis.voices[this.voiceAt(t)];
      const r = els.overview.getBoundingClientRect();
      els.tip.textContent = `${fmtTime(t)} · ${v?.name || ''}`;
      els.tip.style.left = `${Math.max(40, Math.min(r.width - 40, e.clientX - r.left))}px`;
      els.overview.classList.add('hovering');
    });
    els.overview.addEventListener('pointerleave', () => els.overview.classList.remove('hovering'));
    els.tabs.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const tabs = [...els.tabs.querySelectorAll('.tab')];
      const i = tabs.findIndex((t) => t.dataset.id === this.tab);
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      e.preventDefault();
      this.selectTab(tabs[j].dataset.id, true);
      els.tabs.querySelector(`[data-id="${CSS.escape(tabs[j].dataset.id)}"]`)?.focus();
    });
    new ResizeObserver(() => this.drawOverview()).observe(els.overview);
    document.addEventListener('keydown', (e) => {
      if (els.card.classList.contains('hidden') || !this.analysis) return;
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && document.activeElement?.type !== 'range' && document.activeElement?.type !== 'checkbox' && document.activeElement?.type !== 'radio';
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        const other = els.ab.querySelector('input:not(:checked)');
        if (other) { other.checked = true; this.applyGains(); }
      }
      if (e.key === ' ' && document.activeElement?.closest?.('#studio') && document.activeElement?.tagName !== 'BUTTON') { e.preventDefault(); this.togglePlay(); }
    });
  }

  jump(dir) {
    const spots = this.spots();
    const now = this.pv.from;
    const next = dir > 0 ? spots.find((t) => t > now + 1) ?? spots[0] : [...spots].reverse().find((t) => t < now - 1) ?? spots[spots.length - 1];
    if (next != null) this.setPreview(next, 'spot');
  }
}

// Lag (samples) of y against x, where y covers x's span plus maxLag either side: the peak of the
// cross-correlation of their 1 ms loudness envelopes.
export function alignEnvelopes(x, y, maxLag) {
  const env = (a) => {
    const w = 44;
    const out = new Float64Array(a.length);
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      s += Math.abs(a[i]);
      if (i >= w) s -= Math.abs(a[i - w]);
      out[i] = s / w;
    }
    let m = 0;
    for (let i = 0; i < out.length; i++) m += out[i];
    m /= out.length || 1;
    for (let i = 0; i < out.length; i++) out[i] -= m;
    return out;
  };
  const ex = env(x);
  const ey = env(y);
  let N = 1;
  while (N < ex.length + ey.length) N *= 2;
  const f = new RealFFT(N);
  const A = new Float64Array(N);
  const B = new Float64Array(N);
  A.set(ex);
  B.set(ey);
  const h = N / 2 + 1;
  const ar = new Float64Array(h); const ai = new Float64Array(h);
  const br = new Float64Array(h); const bi = new Float64Array(h);
  f.forward(A, ar, ai);
  f.forward(B, br, bi);
  const cr = new Float64Array(h); const ci = new Float64Array(h);
  for (let k = 0; k < h; k++) { cr[k] = ar[k] * br[k] + ai[k] * bi[k]; ci[k] = ar[k] * bi[k] - ai[k] * br[k]; }
  const c = new Float64Array(N);
  f.inverse(cr, ci, c);
  let best = 0;
  let bestV = -Infinity;
  for (let d = 0; d <= 2 * maxLag; d++) if (c[d] > bestV) { bestV = c[d]; best = d; }
  return best - maxLag;
}

export { PREVIEW, PREROLL };
