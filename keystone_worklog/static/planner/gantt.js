// Keystone Planner – the Gantt timeline, drawn on a canvas so thousands of rows stay smooth.
// Only the visible rows are drawn. Interaction: drag a bar to move it, its right edge to change the duration,
// the progress handle to set % complete, or drag up/down onto another bar to link the two (finish-to-start).
import { DAY, dayPeriods, fromMin } from './engine.js';

export const ROW = 28, HEAD = 44;
export const ZOOMS = { day: 56, week: 22, month: 6, quarter: 2.2, year: 0.75 };  // pixels per day
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = t => { const d = new Date(t * 60000); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCDay()]; };
const dayStart = (y, m, d) => Math.round(Date.UTC(y, m, d) / 60000);

export class Gantt {
  constructor(canvas, opts) {
    this.c = canvas; this.o = opts; this.ctx = canvas.getContext('2d');
    this.rows = []; this.scrollTop = 0; this.scrollLeft = 0; this.drag = null; this.hover = null;
    canvas.addEventListener('mousedown', e => this.down(e));
    canvas.addEventListener('mousemove', e => this.move(e));
    canvas.addEventListener('mouseleave', () => { if (!this.drag) { this.hover = null; this.o.tip(null); this.c.style.cursor = ''; } });
    canvas.addEventListener('dblclick', e => { const h = this.hit(e); if (h && h.uid) this.o.open(h.uid); });
    canvas.addEventListener('contextmenu', e => { const h = this.hit(e); if (h && h.uid) { e.preventDefault(); this.o.menu(e, h.uid); } });
    this.up = e => this.release(e);
    this.key = e => { if (e.key === 'Escape' && this.drag) { this.drag = null; this.o.preview(null); this.draw(); } };
    window.addEventListener('mouseup', this.up);
    window.addEventListener('keydown', this.key);
  }
  destroy() { window.removeEventListener('mouseup', this.up); window.removeEventListener('keydown', this.key); }

  /** model: { rows: [uid], plan, sched, byUid (tasks), zoom, origin (min), end (min), status, baseline, colors, selected:Set, issues:Set } */
  set(model) { Object.assign(this, model); this.ppd = ZOOMS[this.zoom] || ZOOMS.week; }
  width() { return Math.ceil((this.end - this.origin) / DAY * this.ppd); }
  x(t) { return (t - this.origin) / DAY * this.ppd - this.scrollLeft; }
  t(x) { return (x + this.scrollLeft) / this.ppd * DAY + this.origin; }
  resize(w, h) {
    const r = window.devicePixelRatio || 1;
    this.w = w; this.h = h;
    this.c.width = Math.round(w * r); this.c.height = Math.round(h * r);
    this.c.style.width = w + 'px'; this.c.style.height = h + 'px';
    this.ctx.setTransform(r, 0, 0, r, 0, 0);
  }
  sched_() { return this.previewSched || this.sched; }

  // ---------- drawing ----------
  draw() {
    const g = this.ctx, C = this.colors, w = this.w, h = this.h;
    if (!w || !h) return;
    g.clearRect(0, 0, w, h);
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h);
    const first = Math.max(0, Math.floor(this.scrollTop / ROW)), last = Math.min(this.rows.length - 1, Math.ceil((this.scrollTop + h - HEAD) / ROW));
    const y0 = r => HEAD + r * ROW - this.scrollTop;
    // non-working days, weekends and holidays
    const d0 = Math.floor(this.t(0) / DAY), d1 = Math.ceil(this.t(w) / DAY);
    if (this.ppd >= 4) {
      for (let d = d0; d <= d1; d++) {
        if (!dayPeriods(this.sched.calendar, d).length) { g.fillStyle = C.off; g.fillRect(this.x(d * DAY), HEAD, Math.max(1, this.ppd), h); }
      }
    }
    // rows
    for (let r = first; r <= last; r++) {
      const uid = this.rows[r], y = y0(r);
      if (this.selected && this.selected.has(uid)) { g.fillStyle = C.sel; g.fillRect(0, y, w, ROW); }
      g.fillStyle = C.line; g.fillRect(0, y + ROW - 1, w, 1);
    }
    // today and status date
    const line = (t, color, dash) => { const x = this.x(t); if (x < 0 || x > w) return; g.save(); g.strokeStyle = color; g.lineWidth = 1.5; if (dash) g.setLineDash(dash); g.beginPath(); g.moveTo(x + 0.5, HEAD); g.lineTo(x + 0.5, h); g.stroke(); g.restore(); };
    line(this.today, C.accent, [4, 3]);
    if (this.status != null) line(this.status, C.warn, [2, 2]);
    // arrows (under the bars)
    const S = this.sched_(), rowOf = new Map(this.rows.map((u, i) => [u, i]));
    g.lineWidth = 1; g.strokeStyle = C.arrow; g.fillStyle = C.arrow;
    for (let r = 0; r < this.rows.length; r++) {
      const uid = this.rows[r], t = this.byUid.get(uid);
      for (const l of (t && t.links) || []) {
        const pr = rowOf.get(l.pred);
        if (pr == null || (Math.max(pr, r) < first - 1) || (Math.min(pr, r) > last + 1)) continue;
        const a = S.byUid.get(l.pred), b = S.byUid.get(uid);
        if (!a || !b) continue;
        const fromEnd = l.type === 'FS' || l.type === 'FF', toStart = l.type === 'FS' || l.type === 'SS';
        const x1 = this.x(fromEnd ? a.ef : a.es), x2 = this.x(toStart ? b.es : b.ef), ya = y0(pr) + ROW / 2, yb = y0(r) + ROW / 2;
        const crit = S.critical.has(l.pred) && S.critical.has(uid);
        g.strokeStyle = g.fillStyle = crit ? C.critical : C.arrow;
        g.beginPath();
        const out = fromEnd ? x1 + 6 : x1 - 6, dir = toStart ? 1 : -1;
        g.moveTo(x1, ya);
        if ((toStart && x2 - 8 >= out) || (!toStart && x2 + 8 <= out)) { g.lineTo(out, ya); g.lineTo(out, yb); g.lineTo(x2 - dir * 2, yb); }
        else { const ym = ya + (yb > ya ? ROW / 2 : -ROW / 2); g.lineTo(out, ya); g.lineTo(out, ym); g.lineTo(x2 - dir * 10, ym); g.lineTo(x2 - dir * 10, yb); g.lineTo(x2 - dir * 2, yb); }
        g.stroke();
        g.beginPath(); g.moveTo(x2, yb); g.lineTo(x2 - dir * 5, yb - 3.5); g.lineTo(x2 - dir * 5, yb + 3.5); g.closePath(); g.fill();
      }
    }
    // bars
    g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (let r = first; r <= last; r++) {
      const uid = this.rows[r], info = S.byUid.get(uid), t = this.byUid.get(uid), y = y0(r);
      if (!info || !t) continue;
      const xs = this.x(info.es), xe = this.x(info.ef), crit = info.critical, cy = y + ROW / 2;
      // baseline
      const b = (t.baselines || {})[this.baseline];
      if (b && b.start && b.finish && !info.summary) {
        const bs = this.x(Math.round(Date.parse(b.start + 'Z') / 60000)), bf = this.x(Math.round(Date.parse(b.finish + 'Z') / 60000));
        g.fillStyle = C.baseline;
        if (bf - bs < 2) { this.diamond(g, bf, y + ROW - 6, 4); } else g.fillRect(bs, y + ROW - 7, Math.max(2, bf - bs), 4);
      }
      if (info.summary) {
        g.fillStyle = crit ? C.critical : C.summary;
        g.fillRect(xs, cy - 4, Math.max(2, xe - xs), 6);
        g.beginPath(); g.moveTo(xs, cy + 2); g.lineTo(xs + 6, cy + 2); g.lineTo(xs, cy + 8); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(xe, cy + 2); g.lineTo(xe - 6, cy + 2); g.lineTo(xe, cy + 8); g.closePath(); g.fill();
        if (info.pct) { g.fillStyle = C.progress; g.fillRect(xs, cy - 4, (xe - xs) * info.pct / 100, 3); }
      } else if (info.milestone) {
        g.fillStyle = crit ? C.critical : C.milestone;
        this.diamond(g, xe, cy, 7);
        if (info.pct >= 100) { g.fillStyle = C.bg; this.diamond(g, xe, cy, 2.5); }
      } else {
        const bw = Math.max(3, xe - xs);
        g.fillStyle = crit ? C.criticalSoft : C.barSoft;
        this.rect(g, xs, cy - 7, bw, 14, 3); g.fill();
        g.fillStyle = crit ? C.critical : C.bar;
        if (info.pct) { this.rect(g, xs, cy - 7, bw * Math.min(100, info.pct) / 100, 14, 3); g.fill(); }
        g.strokeStyle = crit ? C.critical : C.bar; g.lineWidth = 1;
        this.rect(g, xs + 0.5, cy - 6.5, bw - 1, 13, 3); g.stroke();
        if (t.manual) { g.fillStyle = C.text; g.fillRect(xs, cy - 9, 2, 18); g.fillRect(xs + bw - 2, cy - 9, 2, 18); }
        if (info.late) { g.fillStyle = C.bad; g.beginPath(); g.arc(xs - 6, cy, 3, 0, Math.PI * 2); g.fill(); }
      }
      if (t.deadline) {
        const xd = this.x(Math.round(Date.parse(t.deadline + 'Z') / 60000));
        g.fillStyle = info.missesDeadline ? C.bad : C.ok;
        g.beginPath(); g.moveTo(xd - 5, y + 3); g.lineTo(xd + 5, y + 3); g.lineTo(xd, y + 10); g.closePath(); g.fill();
      }
      if (this.issues && this.issues.has(uid)) { g.fillStyle = C.warn; g.beginPath(); g.arc(Math.max(xs, xe) + 8, y + 7, 3, 0, Math.PI * 2); g.fill(); }
      const label = this.labelOf(uid);
      if (label) { g.fillStyle = C.muted; g.fillText(label, Math.max(xe, xs) + (info.milestone ? 12 : 8) + (this.issues && this.issues.has(uid) ? 8 : 0), cy); }
    }
    // drag preview of a link
    if (this.drag && this.drag.mode === 'link' && this.drag.cur) {
      g.save(); g.strokeStyle = C.accent; g.setLineDash([4, 3]); g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(this.drag.x0, this.drag.y0); g.lineTo(this.drag.cur.x, this.drag.cur.y); g.stroke(); g.restore();
    }
    this.header(g, w);
  }
  diamond(g, x, y, s) { g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath(); g.fill(); }
  rect(g, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  header(g, w) {
    const C = this.colors;
    g.fillStyle = C.head; g.fillRect(0, 0, w, HEAD);
    g.fillStyle = C.line; g.fillRect(0, HEAD - 1, w, 1); g.fillRect(0, HEAD / 2, w, 1);
    g.font = '600 11px system-ui, sans-serif'; g.textBaseline = 'middle';
    const tA = this.t(0), tB = this.t(w), z = this.zoom;
    const ticks = (unit, step = 1) => {  // boundaries of days / weeks / months / quarters / years in view
      const out = [];
      let [y, m, d, wd] = ymd(Math.floor(tA / DAY) * DAY);
      if (unit === 'day') { for (let t = Math.floor(tA / DAY) * DAY; t <= tB; t += DAY * step) out.push(t); return out; }
      if (unit === 'week') { let t = dayStart(y, m, d - ((wd + 6) % 7)); for (; t <= tB; t += 7 * DAY) out.push(t); return out; }
      if (unit === 'month' || unit === 'quarter') { const s = unit === 'quarter' ? 3 : 1; m = Math.floor(m / s) * s; for (let k = 0; k < 600; k++) { const t = dayStart(y, m + k * s, 1); if (t > tB) break; out.push(t); } return out; }
      for (let k = 0; k < 100; k++) { const t = dayStart(y + k, 0, 1); if (t > tB) break; out.push(t); }
      return out;
    };
    const tier = (unit, top, fmt) => {
      const ts = ticks(unit);
      for (let i = 0; i < ts.length; i++) {
        const xa = this.x(ts[i]), xb = i + 1 < ts.length ? this.x(ts[i + 1]) : this.x(ts[i]) + (unit === 'day' ? this.ppd : 400);
        g.fillStyle = C.line; g.fillRect(Math.round(xa), top, 1, HEAD / 2);
        const label = fmt(ts[i]);
        if (xb - xa > g.measureText(label).width + 6) { g.fillStyle = C.muted; g.fillText(label, Math.max(xa, 0) + 4, top + HEAD / 4); }
      }
    };
    const fmtDay = t => { const [, , d, wd] = ymd(t); return this.ppd >= 40 ? `${'SMTWTFS'[wd]} ${d}` : String(d); };
    const fmtWeek = t => { const [, m, d] = ymd(t); return `${MON[m]} ${d}`; };
    const fmtMonth = t => { const [y, m] = ymd(t); return this.ppd >= 4 ? `${MON[m]} ${y}` : MON[m]; };
    const fmtQ = t => { const [y, m] = ymd(t); return `Q${Math.floor(m / 3) + 1} ${y}`; };
    const fmtY = t => String(ymd(t)[0]);
    if (z === 'day') { tier('week', 0, fmtWeek); tier('day', HEAD / 2, fmtDay); }
    else if (z === 'week') { tier('month', 0, fmtMonth); tier('day', HEAD / 2, fmtDay); }
    else if (z === 'month') { tier('month', 0, fmtMonth); tier('week', HEAD / 2, t => String(ymd(t)[2])); }
    else if (z === 'quarter') { tier('quarter', 0, fmtQ); tier('month', HEAD / 2, t => MON[ymd(t)[1]]); }
    else { tier('year', 0, fmtY); tier('quarter', HEAD / 2, t => `Q${Math.floor(ymd(t)[1] / 3) + 1}`); }
  }

  // ---------- interaction ----------
  pos(e) { const r = this.c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  hit(e) {
    const { x, y } = this.pos(e);
    if (y < HEAD) return null;
    const r = Math.floor((y - HEAD + this.scrollTop) / ROW), uid = this.rows[r];
    if (uid == null) return { row: r };
    const info = this.sched.byUid.get(uid);
    if (!info) return { row: r, uid };
    const xs = this.x(info.es), xe = this.x(info.ef), cy = HEAD + r * ROW - this.scrollTop + ROW / 2;
    const near = Math.abs(y - cy) <= 9;
    let part = null;
    if (info.milestone) { if (near && Math.abs(x - xe) <= 8) part = 'move'; }
    else if (info.summary) { if (near && x >= xs - 3 && x <= xe + 3) part = 'summary'; }
    else if (near && x >= xs - 3 && x <= xe + 4) {
      const xp = xs + (xe - xs) * (info.pct || 0) / 100;
      if (x >= xe - 5) part = 'resize';
      else if (Math.abs(x - xp) <= 4 && y > cy + 1) part = 'progress';
      else part = 'move';
    }
    return { row: r, uid, part, x, y, xs, xe, cy };
  }
  down(e) {
    if (e.button !== 0) return;
    const hit = this.hit(e);
    if (!hit) return;
    if (hit.uid != null) this.o.select(hit.uid, e.ctrlKey || e.metaKey, e.shiftKey);
    else this.o.select(null);
    if (!hit.part || hit.part === 'summary') return;
    const info = this.sched.byUid.get(hit.uid);
    this.drag = { ...hit, mode: hit.part, start: hit, info, moved: false };
    e.preventDefault();
  }
  move(e) {
    const p = this.pos(e);
    if (!this.drag) {
      const hit = this.hit(e);
      this.c.style.cursor = !hit || !hit.part ? '' : hit.part === 'resize' ? 'ew-resize' : hit.part === 'progress' ? 'col-resize' : hit.part === 'summary' ? 'default' : 'grab';
      const key = hit && hit.uid != null && hit.part ? hit.uid : null;
      if (key !== this.hover) { this.hover = key; this.o.tip(key == null ? null : { uid: key, x: p.x, y: p.y }); }
      else if (key != null) this.o.tip({ uid: key, x: p.x, y: p.y });
      return;
    }
    const d = this.drag, dx = p.x - d.x, dy = p.y - d.y;
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    if (!d.moved && d.mode === 'move' && Math.abs(dy) > Math.abs(dx) * 1.5) d.mode = 'link';  // mostly up/down: drawing a link
    d.moved = true;
    this.o.tip(null);
    const snap = e.shiftKey ? 60 : (this.zoom === 'day' ? 60 : DAY);
    if (d.mode === 'link') {
      d.x0 = d.xe; d.y0 = d.cy; d.cur = p;
      const h = this.hit(e);
      d.target = h && h.uid != null && h.uid !== d.uid ? h.uid : null;
      this.c.style.cursor = d.target ? 'alias' : 'no-drop';
      this.draw();
      return;
    }
    const delta = Math.round(dx / this.ppd * DAY / snap) * snap;
    let change;
    if (d.mode === 'move') change = { kind: 'move', uid: d.uid, start: d.info.es + delta };
    else if (d.mode === 'resize') change = { kind: 'resize', uid: d.uid, finish: Math.max(d.info.es, d.info.ef + delta) };
    else change = { kind: 'progress', uid: d.uid, pct: Math.max(0, Math.min(100, Math.round((p.x - d.xs) / Math.max(1, d.xe - d.xs) * 100))) };
    d.change = change;
    this.previewSched = this.o.preview(change);
    this.c.style.cursor = d.mode === 'move' ? 'grabbing' : this.c.style.cursor;
    this.draw();
  }
  release() {
    const d = this.drag;
    if (!d) return;
    this.drag = null; this.previewSched = null;
    this.o.preview(null);
    if (d.mode === 'link' && d.target) this.o.commit({ kind: 'link', from: d.uid, to: d.target });
    else if (d.moved && d.change) this.o.commit(d.change);
    this.draw();
  }
  labelOf(uid) { return this.o.label ? this.o.label(uid) : ''; }
}

/** Colours from the page's CSS variables (light and dark mode). */
export function ganttColors(el) {
  const cs = getComputedStyle(el), v = n => cs.getPropertyValue(n).trim();
  const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
  return {
    bg: v('--card') || '#fff', head: v('--line2') || '#f1f3f7', line: v('--line2') || '#eef1f6', text: v('--ink') || '#111', muted: v('--muted') || '#667',
    off: dark ? 'rgba(255,255,255,.035)' : 'rgba(15,23,42,.04)', sel: v('--accent-soft') || '#eef0ff', accent: v('--accent') || '#4f46e5',
    bar: v('--c-rg') || '#4f46e5', barSoft: dark ? 'rgba(129,140,248,.28)' : 'rgba(79,70,229,.18)', critical: v('--bad') || '#c81e1e',
    criticalSoft: dark ? 'rgba(248,113,113,.28)' : 'rgba(200,30,30,.16)', summary: v('--ink2') || '#334', milestone: v('--ink') || '#111',
    progress: v('--ok') || '#15803d', baseline: dark ? 'rgba(255,255,255,.35)' : 'rgba(15,23,42,.28)', arrow: v('--muted') || '#667',
    warn: v('--warn') || '#b45309', bad: v('--bad') || '#c81e1e', ok: v('--ok') || '#15803d',
  };
}
export { fromMin };
