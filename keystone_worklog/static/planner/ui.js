// Keystone Planner – the Plan tab: plans, the task grid, the Gantt timeline, task details, import/export.
// Uses the page's helpers (h, icon, api, toast, state, view, render, …) – they're global in index.html.
import * as E from './engine.js';
import { Gantt, ganttColors, ROW, HEAD, ZOOMS } from './gantt.js';
import * as V from './views.js';
import * as CU from './costui.js';
import * as ST from './status.js';
import * as PF from './portfolio.js';

const S = {  // planner state – survives re-renders of the page
  list: null, plan: null, sched: null, sel: new Set(), cursor: null, undo: [], redo: [], dirty: false, saving: null, conflict: null,
  view: recall('nwa.plan.view') || 'gantt', zoom: recall('nwa.plan.zoom') || 'week', filter: 'all', q: '', collapsed: new Set(),
  cols: JSON.parse(recall('nwa.plan.cols') || 'null') || {}, gridW: Number(recall('nwa.plan.gridW')) || Math.round(Math.min(870, Math.max(420, innerWidth * 0.5))), scrollTop: 0, scrollLeft: null,
  baselineN: 0, gantt: null, els: {}, previewSched: null, loading: false,
};
export const planner = S;

const pad = n => String(n).padStart(2, '0');
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function fmtDate(t, withYear = true) {
  if (t == null) return '';
  const d = new Date(t * 60000);
  return `${WD[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}${withYear ? '/' + String(d.getUTCFullYear()).slice(2) : ''}`;
}
/** "2026-10-19", "10/19/26", "10/19", "Oct 19", "oct 19 2026" → "YYYY-MM-DD" */
export function parseDateInput(text, ref = new Date()) {
  const s = String(text || '').trim().toLowerCase().replace(/^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s*/, '');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s);
  if (m) { const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : ref.getFullYear(); return `${y}-${pad(+m[1])}-${pad(+m[2])}`; }
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s);
  const mo = m ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1]) : -1;
  if (m && mo >= 0) return `${m[3] || ref.getFullYear()}-${pad(mo + 1)}-${pad(+m[2])}`;
  return null;
}
const hrs = mins => Math.round(mins / 6) / 10;
const schedOpts = () => ({ now: E.toMin(fmt(new Date())) });  // with no status date, "late" means behind as of this morning

// ---------- calendars from Keystone's settings ----------
export function keystoneCalendar(startIso) {
  const y = Number((startIso || fmt(new Date())).slice(0, 4)), hol = {};
  for (let yy = y - 1; yy <= y + 5; yy++) {
    if (state.settings.holidays !== false) Object.assign(hol, federalHolidays(yy));
  }
  Object.assign(hol, extraHolidays());
  return E.calendarFromSchedule(scheduleArr(), state.settings.anchor, hol, `${y - 1}-01-01`, `${y + 5}-12-31`);
}
const meName = () => (state.settings.userName || '').trim() || 'Me';
export function newPlan({ name, projectId, start }) {
  return { version: 1, name: name || 'New plan', projectId: projectId || null, start: (start || nextMonday()) + 'T08:00', statusDate: null,
    units: { ...E.DEFAULT_UNITS }, calendar: keystoneCalendar(start), calendarSource: 'keystone',
    tasks: [], resources: [{ uid: 1, name: meName(), initials: meName().slice(0, 2).toUpperCase(), me: true, maxUnits: 1 }], assignments: [], raid: [], changeLog: [] };
}
function nextMonday() { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return fmt(d); }

// ---------- loading & saving ----------
async function loadList() { try { S.list = (await api('/api/plans')).plans; } catch (e) { S.list = []; toast(e.message); } }
export async function openPlan(id) {
  if (S.dirty) await flush();
  S.loading = true;
  try {
    const p = await api('/api/plans/' + id);
    Object.assign(S, { plan: p, sel: new Set(), cursor: null, undo: [], redo: [], dirty: false, conflict: null, scrollTop: 0, scrollLeft: null, collapsed: new Set() });
    remember('nwa.plan.open', id);
    try { planName = p.name; } catch {}  // index.html: the assistant's page context
    resched();
    try { if (await CU.linkPeople(p)) queueSave(); } catch {}  // plan people → the People & rates directory
    await Promise.all([CU.ensurePlanCosts(), ST.loadStatus(id)]).catch(() => {});
  } catch (e) { toast(e.message); S.plan = null; remember('nwa.plan.open', ''); }
  S.loading = false;
}
export function resched() {
  const p = S.plan;
  if (!p) return;
  if (!p.calendar) p.calendar = keystoneCalendar(p.start);
  try { S.sched = E.schedule(p, schedOpts()); } catch (e) { toast('Scheduling problem: ' + e.message); return; }
  for (const t of p.tasks) {  // keep the computed dates on the tasks: export and the assistant read them
    const r = S.sched.byUid.get(t.uid);
    if (r && !(t.manual && t.start)) { t.start = E.fromMin(r.es); t.finish = E.fromMin(r.ef); }
    t.kind = r && r.summary ? 'summary' : r && r.milestone ? 'milestone' : 'task';
  }
}
let saveTimer;
function queueSave() { S.dirty = true; S.edits = (S.edits || 0) + 1; clearTimeout(saveTimer); saveTimer = setTimeout(flush, 700); paintStatus(); }
export async function flush() {
  clearTimeout(saveTimer);
  if (!S.plan || !S.dirty || S.conflict) return;
  if (S.saving) return S.saving.then(flush);  // one save at a time – the next one needs the new rev
  const p = S.plan, sent = S.edits;
  let done;
  S.saving = new Promise(r => { done = r; }); paintStatus();
  try {
    const j = await api('/api/plans/' + p.id, { plan: p, baseRev: p.rev }, 'PUT');
    S.plan.rev = j.rev; S.plan.updated = j.updated;  // S.plan may be a new object by now (undo), so set it there
    if (S.edits === sent) S.dirty = false;
  } catch (e) {
    if (e.status === 409) S.conflict = e.body.plan; else toast('Couldn\'t save the plan: ' + e.message);
  }
  S.saving = null; done(); paintStatus();
  if (S.conflict) redraw();
  else if (S.dirty) saveTimer = setTimeout(flush, 700);
}
window.addEventListener('beforeunload', () => { if (S.dirty && S.plan) fetch('/api/plans/' + S.plan.id, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: S.plan, baseRev: S.plan.rev }) }); });

/** Change the plan with undo: fn mutates S.plan. */
export function change(label, fn, opts = {}) {
  if (!S.plan) return;
  S.undo.push(JSON.stringify(S.plan));
  if (S.undo.length > 60) S.undo.shift();
  S.redo = [];
  fn(S.plan);
  (S.plan.changeLog ||= []).push({ at: new Date().toISOString(), by: opts.by || 'you', summary: label });
  if (S.plan.changeLog.length > 500) S.plan.changeLog.splice(0, S.plan.changeLog.length - 500);
  resched();
  queueSave();
  if (opts.quiet !== true) redraw();
}
function restore(json) {  // back to a snapshot – but keep the saved revision, or the next save would look like a conflict
  const { rev, updated } = S.plan;
  S.plan = Object.assign(JSON.parse(json), { rev, updated });
  resched();
}
function undo() { if (!S.undo.length) return toast('Nothing to undo'); S.redo.push(JSON.stringify(S.plan)); restore(S.undo.pop()); queueSave(); redraw(); }
function redo() { if (!S.redo.length) return toast('Nothing to redo'); S.undo.push(JSON.stringify(S.plan)); restore(S.redo.pop()); queueSave(); redraw(); }

// ---------- plan helpers ----------
export const taskOf = uid => S.plan.tasks.find(t => t.uid === uid);
const nextUid = () => S.plan.tasks.reduce((m, t) => Math.max(m, t.uid), 0) + 1;
const childrenOf = uid => S.plan.tasks.filter(t => t.parentUid === uid);
export function rowIds() {  // row number (ID) of every task, in outline order
  const ids = new Map();
  (S.sched ? S.sched.order : S.plan.tasks.map(t => t.uid)).forEach((u, i) => ids.set(u, i + 1));
  return ids;
}
export const resourceOf = uid => S.plan.resources.find(r => r.uid === uid);
export function assignmentsOf(uid) { return S.plan.assignments.filter(a => a.taskUid === uid); }
export function resourceText(uid) {
  return assignmentsOf(uid).map(a => { const r = resourceOf(a.resourceUid); return r ? r.name + (a.units !== 1 ? `[${Math.round(a.units * 100)}%]` : '') : ''; }).filter(Boolean).join(', ');
}
export const descendants = uid => { const out = []; const go = u => childrenOf(u).forEach(c => { out.push(c.uid); go(c.uid); }); go(uid); return out; };
export function openIssueTasks() {
  const s = new Set();
  for (const r of S.plan.raid || []) if (r.status !== 'closed' && (r.kind === 'issue' || r.kind === 'risk')) (r.taskUids || []).forEach(u => s.add(u));
  return s;
}
const meUid = () => (S.plan.resources.find(r => r.me) || {}).uid;

/** Hours charged on the timesheet to an NWA, by date. */
export function nwaHours() {
  const out = {};
  const periods = { ...state.periods, ...(view.start && view.period ? { [view.start]: view.period } : {}) };
  for (const [start, p] of Object.entries(periods)) (p.weeks || []).forEach((w, wi) => w.rows.forEach(r => {
    if (r.code !== 'RG' || !r.network.trim()) return;
    const key = `${r.network.trim()}|${r.activity.trim()}`;
    r.h.forEach((v, di) => { const n = num(v); if (n) { const d = addDays(start, wi * 7 + di); (out[key] ||= {})[d] = (out[key][d] || 0) + n; } });
  }));
  return out;
}
/** Actual hours per task from the timesheet: hours on each day go to the tasks linked to that NWA, split by planned work that day. */
export function actualHours() {
  const pc = CU.planCosts();
  if (pc && pc.led && pc.led.lines.length) return new Map(pc.roll.actualH);  // ERP charges (+ your unposted timesheet hours), per person
  const res = new Map(), byNwa = {};
  if (!S.sched) return res;
  for (const t of S.plan.tasks) if (t.nwa) (byNwa[t.nwa] ||= []).push(t);
  const hours = nwaHours(), status = E.toMin(S.plan.statusDate) ?? E.toMin(fmt(new Date())) + E.DAY;
  for (const [key, tasks] of Object.entries(byNwa)) {
    for (const [d, h] of Object.entries(hours[key] || {})) {
      const day = E.toMin(d);
      if (day > status || day + E.DAY <= S.sched.start) continue;  // only hours charged while the plan runs
      const leaf = tasks.filter(t => !S.sched.byUid.get(t.uid)?.summary);
      const shares = leaf.map(t => [t.uid, E.workIn(S.sched, t.uid, day, day + E.DAY)]);
      let tot = shares.reduce((s, [, w]) => s + w, 0);
      let list = shares;
      if (!tot) {  // nothing planned that day: the task whose dates are closest takes it
        const near = (leaf.length ? leaf : tasks).map(t => [t.uid, Math.abs(((S.sched.byUid.get(t.uid) || {}).es || 0) - day)]).sort((a, b) => a[1] - b[1])[0];
        if (!near) continue;
        list = [[near[0], 1]]; tot = 1;
      }
      for (const [u, w] of list) res.set(u, (res.get(u) || 0) + h * w / tot);
    }
  }
  for (const t of S.plan.tasks) {  // summaries add up their tasks (plus anything charged to their own NWA)
    const r = S.sched.byUid.get(t.uid);
    if (r && r.summary) res.set(t.uid, (res.get(t.uid) || 0) + descendants(t.uid).reduce((s, u) => s + (S.sched.byUid.get(u)?.summary ? 0 : res.get(u) || 0), 0));
  }
  return res;
}
export function plannedMinutes(uid) {
  const r = S.sched.byUid.get(uid);
  if (!r) return 0;
  if (r.summary) return descendants(uid).reduce((s, u) => s + (S.sched.byUid.get(u)?.summary ? 0 : plannedMinutes(u)), 0);
  const as = assignmentsOf(uid);
  return as.length ? as.reduce((s, a) => s + (a.workMinutes ?? r.dur * (a.units ?? 1)), 0) : r.dur;
}

// ---------- visible rows ----------
function visibleRows() {
  if (!S.sched) return [];
  const { outline: ol, byUid } = S.sched, q = S.q.trim().toLowerCase(), mine = meUid(), issues = openIssueTasks();
  const t = uid => taskOf(uid);
  const match = uid => {
    const r = byUid.get(uid), task = t(uid);
    if (q && !(task.name || '').toLowerCase().includes(q)) return false;
    switch (S.filter) {
      case 'critical': return r.critical;
      case 'late': { const v = E.variance(S.sched, task, S.baselineN); return r.late || r.missesDeadline || !!r.conflict || (v && v.finish > 0); }
      case 'milestones': return r.milestone;
      case 'incomplete': return (r.pct || 0) < 100;
      case 'mine': return assignmentsOf(uid).some(a => a.resourceUid === mine);
      case 'issues': return issues.has(uid);
      default: return true;
    }
  };
  const filtering = q || S.filter !== 'all';
  const keep = new Set();
  if (filtering) {
    for (const uid of ol.order) if (match(uid)) { keep.add(uid); let p = t(uid).parentUid; while (p != null) { keep.add(p); p = t(p)?.parentUid; } }
  }
  const rows = [];
  const walk = parent => (ol.kids.get(parent) || []).forEach(uid => {
    if (filtering && !keep.has(uid)) return;
    rows.push(uid);
    if (!S.collapsed.has(uid)) walk(uid);
  });
  walk(null);
  return rows;
}

// ---------- columns ----------
const COLS = [
  { k: 'id', t: 'ID', w: 42, fixed: true },
  { k: 'ind', t: '', w: 30, fixed: true },
  { k: 'name', t: 'Task name', w: 250, fixed: true, edit: true },
  { k: 'dur', t: 'Duration', w: 74, edit: true },
  { k: 'start', t: 'Start', w: 96, edit: true },
  { k: 'finish', t: 'Finish', w: 96, edit: true },
  { k: 'pred', t: 'Predecessors', w: 104, edit: true },
  { k: 'res', t: 'Resources', w: 120, edit: true },
  { k: 'pct', t: '%', w: 50, edit: true },
  { k: 'wbs', t: 'WBS', w: 56, opt: true },
  { k: 'slack', t: 'Total slack', w: 78, opt: true },
  { k: 'bfinish', t: 'Baseline finish', w: 104, opt: true },
  { k: 'fvar', t: 'Finish var.', w: 76, opt: true },
  { k: 'planned', t: 'Planned h', w: 72, opt: true },
  { k: 'actual', t: 'Actual h', w: 72, opt: true },
  { k: 'cost', t: 'Cost', w: 90, opt: true },
  { k: 'bcost', t: 'Baseline cost', w: 100, opt: true },
  { k: 'acost', t: 'Actual cost', w: 96, opt: true },
  { k: 'nwa', t: 'NWA', w: 130, opt: true },
  { k: 'deadline', t: 'Deadline', w: 96, opt: true },
  { k: 'constraint', t: 'Constraint', w: 120, opt: true },
];
const shownCols = () => COLS.filter(c => !c.opt ? S.cols[c.k] !== false : S.cols[c.k] === true);
function cellText(c, uid, idx, ids, actual) {
  const t = taskOf(uid), r = S.sched.byUid.get(uid), u = S.plan.units;
  switch (c.k) {
    case 'id': return String(idx);
    case 'name': return t.name || '';
    case 'dur': return r.summary ? E.formatDuration({ minutes: r.dur, format: 'd' }, u) : E.formatDuration(t.duration || { minutes: 0, format: 'd' }, u);
    case 'start': return fmtDate(r.es);
    case 'finish': return fmtDate(r.ef);
    case 'pred': return E.formatPredecessors(t.links, p => ids.get(p), u);
    case 'res': return resourceText(uid);
    case 'pct': return `${r.pct || 0}%`;
    case 'wbs': return t.wbs || S.sched.outline.wbs.get(uid) || '';
    case 'slack': return E.formatDuration({ minutes: r.totalSlack || 0, format: 'd' }, u);
    case 'bfinish': { const b = (t.baselines || {})[S.baselineN]; return b && b.finish ? fmtDate(E.toMin(b.finish)) : ''; }
    case 'fvar': { const v = E.variance(S.sched, t, S.baselineN); return v ? E.formatDuration({ minutes: v.finish, format: 'd' }, u) : ''; }
    case 'planned': return String(hrs(plannedMinutes(uid)));
    case 'actual': { const a = actual.get(uid); return a ? String(Math.round(a * 10) / 10) : ''; }
    case 'cost': case 'bcost': case 'acost': { const pc = CU.planCosts(); if (!pc) return ''; const v = pc.roll[{ cost: 'planned', bcost: 'baseline', acost: 'actual' }[c.k]].get(uid); return v ? CU.money(v) : ''; }
    case 'nwa': { const p = t.nwa && state.projects.find(x => `${x.network.trim()}|${x.activity.trim()}` === t.nwa); return p ? projectLabel(p) : t.nwa ? t.nwa.replace('|', ' / ') : ''; }
    case 'deadline': return t.deadline ? fmtDate(E.toMin(t.deadline)) : '';
    case 'constraint': { const k = (t.constraint || {}).type || 'ASAP'; return k === 'ASAP' ? '' : `${k} ${t.constraint.date ? fmtDate(E.toMin(t.constraint.date), false) : ''}`; }
    default: return '';
  }
}

// ---------- editing a cell ----------
function setCell(uid, k, text) {
  const t = taskOf(uid), r = S.sched.byUid.get(uid), u = S.plan.units;
  const v = String(text ?? '').trim();
  if (k === 'name') return change('Rename task', () => { t.name = v; });
  if (k === 'dur') {
    if (r.summary) return toast('A summary task\'s duration comes from its tasks');
    const d = E.parseDuration(v, u);
    if (!d || d.minutes < 0) return toast('Type a duration like 3d, 2w, 4h or 0 for a milestone');
    return change('Change duration', () => { t.duration = d; t.milestone = d.minutes === 0; });
  }
  if (k === 'start' || k === 'finish') {
    const ds = parseDateInput(v);
    if (!ds) return toast('Type a date like 10/19/26, Oct 19 or 2026-10-19');
    if (k === 'start') return change('Move task', () => moveTo(t, E.toMin(ds) + (E.toMin(E.fromMin(r.es)) % E.DAY || 480)));
    return change('Change finish', () => finishAt(t, E.toMin(ds) + 17 * 60));
  }
  if (k === 'pred') {
    const ids = rowIds(), byId = new Map([...ids].map(([u2, i]) => [i, u2]));
    const links = E.parsePredecessors(v, u);
    if (!links) return toast('Predecessors look like 4, 7SS+2d or 9FF-25%');
    const out = [];
    for (const l of links) {
      const pu = byId.get(l.id);
      if (pu == null) return toast(`There's no task ${l.id}`);
      if (pu === uid) return toast('A task can\'t depend on itself');
      out.push({ pred: pu, type: l.type, lag: l.lag });
    }
    return linkChange(() => { t.links = out; }, 'Change predecessors');
  }
  if (k === 'res') return change('Assign people', () => assignFromText(uid, v));
  if (k === 'pct') {
    const n = Math.max(0, Math.min(100, Math.round(parseFloat(v))));
    if (Number.isNaN(n)) return toast('Type a number from 0 to 100');
    return change('Update progress', () => setPct(t, n));
  }
  if (k === 'deadline') { const ds = v ? parseDateInput(v) : ''; if (v && !ds) return toast('Type a date'); return change('Set deadline', () => { t.deadline = ds ? ds + 'T17:00' : null; }); }
}
function linkChange(fn, label) {  // refuse changes that create a loop
  const before = JSON.stringify(S.plan);
  change(label, fn, { quiet: true });
  const loop = S.sched.errors.find(e => /circular|own subtask/.test(e.text));
  if (loop) { restore(before); S.undo.pop(); toast('That would make a loop: ' + loop.text); }
  redraw();
}
export function moveTo(t, startMin) {
  if (t.manual) { const r = S.sched.byUid.get(t.uid), d = r.ef - r.es; t.start = E.fromMin(startMin); t.finish = E.fromMin(startMin + d); return; }
  t.constraint = { type: 'SNET', date: E.fromMin(E.nextWorking(S.sched.calendar, startMin)) };  // like MS Project: dragging or typing a start sets Start No Earlier Than
}
export function finishAt(t, finishMin) {
  const r = S.sched.byUid.get(t.uid);
  if (t.manual) { t.finish = E.fromMin(Math.max(finishMin, r.es)); return; }
  const mins = Math.max(0, E.workBetween(S.sched.calendar, r.es, E.prevWorking(S.sched.calendar, finishMin)));
  const per = S.plan.units.minutesPerDay;
  t.duration = { minutes: Math.max(0, Math.round(mins / per) * per), format: (t.duration || {}).format || 'd' };
  t.milestone = t.duration.minutes === 0;
}
export function setPct(t, n) {
  const r = S.sched.byUid.get(t.uid);
  t.percent = n;
  if (n > 0 && !t.actualStart) t.actualStart = E.fromMin(r.es);
  if (n === 0) { t.actualStart = null; t.actualFinish = null; }
  if (n >= 100) t.actualFinish = t.actualFinish || E.fromMin(r.ef); else t.actualFinish = null;
}
function assignFromText(uid, text) {
  const wanted = String(text || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = /^(.*?)\s*\[(\d+)\s*%?\]$/.exec(s);
    return { name: (m ? m[1] : s).trim(), units: m ? Math.max(1, +m[2]) / 100 : 1 };
  });
  const keep = S.plan.assignments.filter(a => a.taskUid !== uid);
  const mine = [];
  for (const w of wanted) {
    let r = S.plan.resources.find(x => x.name.toLowerCase() === w.name.toLowerCase() || (x.initials || '').toLowerCase() === w.name.toLowerCase());
    if (!r) { r = { uid: S.plan.resources.reduce((m, x) => Math.max(m, x.uid), 0) + 1, name: w.name, initials: w.name.split(/\s+/).map(x => x[0]).join('').slice(0, 3).toUpperCase(), maxUnits: 1 }; S.plan.resources.push(r); }
    const old = S.plan.assignments.find(a => a.taskUid === uid && a.resourceUid === r.uid);
    mine.push({ ...(old || {}), taskUid: uid, resourceUid: r.uid, units: w.units, workMinutes: old && old.units === w.units ? old.workMinutes : undefined });
  }
  S.plan.assignments = [...keep, ...mine];
}

// ---------- structure commands ----------
export function addTask(opts = {}) {
  const p = S.plan, uid = nextUid(), after = opts.after ?? [...S.sel].pop();
  const ref = after != null ? taskOf(after) : null;
  const t = { uid, name: opts.name || (opts.milestone ? 'New milestone' : 'New task'), parentUid: ref ? ref.parentUid ?? null : null,
    duration: { minutes: opts.milestone ? 0 : p.units.minutesPerDay, format: 'd', estimated: !opts.milestone }, milestone: !!opts.milestone,
    links: [], percent: 0, priority: 500, notes: '', constraint: { type: 'ASAP' }, baselines: {}, custom: {} };
  change(opts.milestone ? 'Add milestone' : 'Add task', () => {
    if (ref) {  // after the selected task and everything under it
      const idx = Math.max(...[after, ...descendants(after)].map(u => p.tasks.findIndex(x => x.uid === u)));
      p.tasks.splice(idx + 1, 0, t);
    } else p.tasks.push(t);
  });
  S.sel = new Set([uid]); S.cursor = { uid, k: 'name' };
  redraw();
  if (opts.edit !== false) setTimeout(() => startEdit(uid, 'name', ''), 30);
  return t;
}
function deleteSelected() {
  const sel = [...S.sel];
  if (!sel.length) return;
  const all = new Set(sel.flatMap(u => [u, ...descendants(u)]));
  if (all.size > sel.length && !confirm(`Delete ${sel.length} task${sel.length > 1 ? 's' : ''} and the ${all.size - sel.length} task${all.size - sel.length > 1 ? 's' : ''} under ${sel.length > 1 ? 'them' : 'it'}?`)) return;
  change(`Delete ${all.size} task${all.size > 1 ? 's' : ''}`, p => {
    p.tasks = p.tasks.filter(t => !all.has(t.uid));
    p.tasks.forEach(t => { t.links = (t.links || []).filter(l => !all.has(l.pred)); });
    p.assignments = p.assignments.filter(a => !all.has(a.taskUid));
    (p.raid || []).forEach(r => { r.taskUids = (r.taskUids || []).filter(u => !all.has(u)); });
  });
  S.sel = new Set(); redraw();
}
function indent() {
  const rows = visibleRows(), sel = [...S.sel].sort((a, b) => rows.indexOf(a) - rows.indexOf(b));
  if (!sel.length) return;
  linkChange(() => {
    for (const uid of sel) {
      const t = taskOf(uid), sibs = S.sched.outline.kids.get(t.parentUid ?? null) || [], i = sibs.indexOf(uid);
      if (i <= 0) continue;
      t.parentUid = sibs[i - 1];
      S.collapsed.delete(sibs[i - 1]);
      t.links = (t.links || []).filter(l => l.pred !== t.parentUid);
    }
  }, 'Indent');
}
function outdent() {
  const sel = [...S.sel];
  if (!sel.length) return;
  linkChange(() => {
    for (const uid of sel) {
      const t = taskOf(uid);
      if (t.parentUid == null) continue;
      const parent = taskOf(t.parentUid), sibs = S.sched.outline.kids.get(t.parentUid), i = sibs.indexOf(uid);
      sibs.slice(i + 1).forEach(u => { taskOf(u).parentUid = uid; });  // like MS Project: the tasks below become its subtasks
      t.parentUid = parent.parentUid ?? null;
      // keep it right after its old parent's block in the list
      const p = S.plan, from = p.tasks.findIndex(x => x.uid === uid);
      p.tasks.splice(from, 1);
      const end = Math.max(...[parent.uid, ...descendants(parent.uid)].map(u2 => p.tasks.findIndex(x => x.uid === u2)));
      p.tasks.splice(end + 1, 0, t);
    }
  }, 'Outdent');
}
function linkSelected() {
  const rows = visibleRows(), sel = [...S.sel].sort((a, b) => rows.indexOf(a) - rows.indexOf(b));
  if (sel.length < 2) return toast('Select two or more tasks (Ctrl+click) to link them in order');
  linkChange(() => { for (let i = 1; i < sel.length; i++) { const t = taskOf(sel[i]); if (!(t.links || []).some(l => l.pred === sel[i - 1])) (t.links ||= []).push({ pred: sel[i - 1], type: 'FS', lag: { minutes: 0, format: 'd' } }); } }, 'Link tasks');
}
function unlinkSelected() {
  const sel = new Set(S.sel);
  if (!sel.size) return;
  change('Unlink tasks', p => p.tasks.forEach(t => { if (sel.has(t.uid)) t.links = (t.links || []).filter(l => !sel.has(l.pred)); }));
}

// ---------- the Gantt's drag changes ----------
function applyDrag(plan, ch) {
  const t = plan.tasks.find(x => x.uid === (ch.uid ?? ch.to));
  const saved = S.plan; S.plan = plan;
  try {
    if (ch.kind === 'move') moveTo(t, ch.start);
    else if (ch.kind === 'resize') finishAt(t, ch.finish);
    else if (ch.kind === 'progress') setPct(t, ch.pct);
  } finally { S.plan = saved; }
}
function previewDrag(ch) {
  if (!ch) { S.previewSched = null; return null; }
  const copy = JSON.parse(JSON.stringify({ ...S.plan, changeLog: [] }));
  applyDrag(copy, ch);
  try { S.previewSched = E.schedule(copy, schedOpts()); } catch { S.previewSched = null; }
  paintTip(null);
  return S.previewSched;
}
function commitDrag(ch) {
  if (ch.kind === 'link') {
    const t = taskOf(ch.to);
    if ((t.links || []).some(l => l.pred === ch.from)) return toast('Those tasks are already linked');
    return linkChange(() => { (t.links ||= []).push({ pred: ch.from, type: 'FS', lag: { minutes: 0, format: 'd' } }); }, 'Link tasks');
  }
  change(ch.kind === 'move' ? 'Move task' : ch.kind === 'resize' ? 'Change duration' : 'Update progress', p => applyDrag(p, ch));
}

// ---------- rendering ----------
export function redraw() {
  if (!S.els.root || !S.els.root.isConnected) return;
  const focused = S.els.grid && S.els.grid.contains(document.activeElement) && document.activeElement.tagName !== 'INPUT';
  mount(S.els.root);
  if (focused && S.els.grid) S.els.grid.focus({ preventScroll: true });  // keep keyboard shortcuts working after a change
}
function paintStatus() {
  const el = S.els.status;
  if (!el) return;
  el.textContent = S.saving ? 'Saving…' : S.dirty ? 'Unsaved changes' : S.plan ? `Saved${S.plan.updated ? ' · ' + S.plan.updated.slice(11, 16) : ''}` : '';
}
function paintTip(tip) {
  const el = S.els.tip;
  if (!el) return;
  if (!tip) { el.hidden = true; return; }
  const t = taskOf(tip.uid), r = (S.previewSched || S.sched).byUid.get(tip.uid);
  if (!t || !r) { el.hidden = true; return; }
  const u = S.plan.units, v = E.variance(S.sched, t, S.baselineN);
  el.replaceChildren(h('b', {}, t.name || '(no name)'),
    h('div', {}, `${fmtDate(r.es)} → ${fmtDate(r.ef)} · ${E.formatDuration({ minutes: r.dur, format: 'd' }, u)}`),
    h('div', {}, `${r.pct || 0}% complete · slack ${E.formatDuration({ minutes: r.totalSlack || 0, format: 'd' }, u)}${r.critical ? ' · critical' : ''}`),
    resourceText(t.uid) ? h('div', {}, resourceText(t.uid)) : '',
    v && v.finish ? h('div', {}, `Finish ${v.finish > 0 ? E.formatDuration({ minutes: v.finish, format: 'd' }, u) + ' later' : E.formatDuration({ minutes: -v.finish, format: 'd' }, u) + ' earlier'} than baseline`) : '',
    r.conflict ? h('div', { class: 'neg' }, '⚠ ' + r.conflict) : '', r.missesDeadline ? h('div', { class: 'neg' }, '⚠ misses its deadline') : '');
  el.hidden = false;
  const host = S.els.chart.getBoundingClientRect();
  el.style.left = Math.min(tip.x + 16, host.width - 280) + 'px';
  el.style.top = Math.min(tip.y + 16, host.height - 120) + 'px';
}

/** The Plan tab. */
export function mount(root) {
  S.els = { root };
  if (S.list == null && !S.loadingList) {
    S.loadingList = true;
    loadList().then(async () => {
      S.loadingList = false;
      const want = recall('nwa.plan.open'), pick = (S.list || []).find(p => p.id === want && !p.template) || (S.list || []).find(p => !p.template);
      if (pick && !S.plan) await openPlan(pick.id);
      redraw();
    });
    root.replaceChildren(h('p', { class: 'hint' }, 'Loading plans…'));
    return;
  }
  if (S.loading) { root.replaceChildren(h('p', { class: 'hint' }, 'Opening the plan…')); return; }
  const plans = (S.list || []).filter(p => !p.template);
  if (S.portfolio) { mountPortfolio(root, plans); return; }
  if (!S.plan) {
    root.replaceChildren(h('section', { class: 'card', style: 'text-align:center;padding:40px 18px' },
      h('h2', { style: 'margin:0 0 6px' }, 'Plan a project'),
      h('p', { class: 'hint' }, 'Tasks, milestones and dependencies on a Gantt timeline you can drag, who is working on what, progress against a baseline, and issues and risks. Opens and saves Microsoft Project files.'),
      h('div', { class: 'actions', style: 'justify-content:center' },
        h('button', { class: 'btn primary', onclick: () => newPlanDialog() }, icon('plus'), 'New plan'),
        h('button', { class: 'btn', onclick: () => importDialog() }, icon('down'), 'Open an MS Project file'))));
    return;
  }
  const p = S.plan, proj = p.projectId && projectById(p.projectId);
  // toolbar
  const pick = h('select', { class: 'pl-pick', 'aria-label': 'Plan', onchange: async e => {
    const v = e.target.value;
    if (v === '__new') { e.target.value = p.id; return newPlanDialog(); }
    if (v === '__import') { e.target.value = p.id; return importDialog(); }
    if (v === '__all') { e.target.value = p.id; return showPortfolio(); }
    await openPlan(v); redraw();
  } }, plans.map(x => h('option', { value: x.id }, x.name)), h('option', { value: '__all' }, '▦ All plans (portfolio)'), h('option', { value: '__new' }, '+ New plan…'), h('option', { value: '__import' }, '↥ Open an MS Project file…'));
  pick.value = p.id;
  const statusIn = h('input', { type: 'date', value: (p.statusDate || '').slice(0, 10), title: 'Status date: progress is measured as of this date',
    onchange: e => change('Set status date', pl => { pl.statusDate = e.target.value ? e.target.value + 'T17:00' : null; }) });
  const views = [['gantt', 'Gantt'], ['team', 'Team'], ['workload', 'Workload'], ['costs', 'Costs'], ['raid', 'Issues & risks'], ['status', 'Status'], ['dashboard', 'Dashboard']];
  const tb = h('div', { class: 'pl-top' },
    h('div', { class: 'pl-title' }, pick, proj ? pchip(proj) : null, h('span', { class: 'pl-save', ref: null }, '')),
    h('div', { class: 'seg' }, views.map(([k, l]) => h('button', { class: S.view === k ? 'on' : '', onclick: () => { S.view = k; remember('nwa.plan.view', k); redraw(); } }, l))),
    h('div', { class: 'spacer' }),
    h('label', { class: 'pl-status', title: 'Status date: progress is measured as of this date' }, h('span', { class: 'pl-st-l' }, 'Status date'), statusIn),
    h('button', { class: 'btn ghost', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: undo, disabled: S.undo.length ? false : '' }, '↶'),
    h('button', { class: 'btn ghost', title: 'Redo (Ctrl+Y)', 'aria-label': 'Redo', onclick: redo, disabled: S.redo.length ? false : '' }, '↷'),
    h('button', { class: 'btn', onclick: e => showMenu(e, planMenu()) }, 'Plan ▾'),
    h('button', { class: 'btn', onclick: e => showMenu(e, exportMenu()) }, icon('down'), 'Export ▾'));
  S.els.status = tb.querySelector('.pl-save');
  const banner = S.conflict ? h('div', { class: 'duebar' }, icon('bell'), h('div', { class: 'txt' }, 'This plan was changed somewhere else (another tab or window) since you opened it.'),
    h('button', { class: 'btn', onclick: () => { S.plan = S.conflict; S.conflict = null; S.dirty = false; S.undo = []; resched(); redraw(); } }, 'Load theirs'),
    h('button', { class: 'btn', onclick: () => { S.plan.rev = S.conflict.rev; S.conflict = null; queueSave(); flush(); redraw(); } }, 'Keep mine')) : null;
  const errs = S.sched && S.sched.errors.length ? h('div', { class: 'duebar' }, icon('bell'), h('div', { class: 'txt' }, ...S.sched.errors.slice(0, 3).map(e => h('div', {}, `Task ${rowIds().get(e.uid) || '?'}: ${e.text}`)))) : null;
  let body;
  if (S.view === 'gantt') body = ganttView();
  else if (S.view === 'costs') body = CU.costsView(api_());
  else if (S.view === 'status') body = ST.statusView(api_());
  else body = V.render(S.view, api_());
  root.replaceChildren(tb, banner || '', errs || '', body);
  paintStatus();
  if (S.view === 'gantt') requestAnimationFrame(layoutGantt);
}
function showPortfolio() { S.portfolio = true; PF.invalidate(); redraw(); }
function mountPortfolio(root, plans) {
  PF.setRedraw(redraw);
  const back = async (id, uid) => { S.portfolio = false; if (!S.plan || S.plan.id !== id) await openPlan(id); if (uid != null) selectAndShow(uid); else redraw(); };
  const pick = h('select', { class: 'pl-pick', 'aria-label': 'Plan', onchange: e => { if (e.target.value !== '__all') back(e.target.value); } },
    h('option', { value: '__all' }, '▦ All plans (portfolio)'), plans.map(x => h('option', { value: x.id }, x.name)));
  root.replaceChildren(h('div', { class: 'pl-top' }, h('div', { class: 'pl-title' }, pick), h('div', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: () => CU.importDialog({ onDone: () => { PF.invalidate(); redraw(); } }) }, icon('up'), 'Import from ERP…')), PF.view(back));
}
function api_() { return { S, E, taskOf, change, redraw, rowIds, resourceOf, assignmentsOf, resourceText, descendants, openIssueTasks, actualHours, plannedMinutes, fmtDate, parseDateInput, openTask, setPct, select: selectAndShow, meUid, costs: CU.planCosts, money: CU.money, linkProject: projectDialog, lastSnap: ST.lastSnap }; }
function selectAndShow(uid) { S.sel = new Set([uid]); S.view = 'gantt'; remember('nwa.plan.view', 'gantt'); const rows = visibleRows(), i = rows.indexOf(uid); if (i >= 0) S.scrollTop = Math.max(0, i * ROW - 120); const r = S.sched.byUid.get(uid); if (r) S.scrollLeft = null, S.focusTime = r.es; redraw(); }

function planMenu() {
  const p = S.plan;
  return [
    { header: p.name },
    { icon: 'plus', label: 'Set baseline…', run: baselineDialog },
    { icon: 'check', label: 'Close the week…', run: () => ST.closeWeekDialog(api_()) },
    { icon: 'sync', label: 'Update progress to the status date', run: () => {
      if (!p.statusDate) return toast('Set a status date first (top right)');
      change('Update progress to the status date', pl => Object.assign(pl, E.updateToStatus(pl, S.sched)));
      toast('Work scheduled before the status date is marked done');
    } },
    { icon: 'edit', label: 'Rename plan…', run: () => { const n = prompt('Plan name', p.name); if (n && n.trim()) change('Rename plan', pl => { pl.name = n.trim(); }); loadList().then(redraw); } },
    { icon: 'folder', label: 'Link to a project…', run: projectDialog },
    { icon: 'chart', label: 'People and calendars…', run: () => V.peopleDialog(api_()) },
    { icon: 'history', label: 'Use my work schedule and holidays as the calendar', run: () => change('Use the Keystone calendar', pl => { pl.calendar = keystoneCalendar(pl.start); pl.calendarSource = 'keystone'; }) },
    { icon: 'template', label: 'Save as a template…', run: saveTemplate },
    { icon: 'down', label: 'Update from an MS Project file…', run: () => importDialog(true) },
    p.projectId ? { icon: 'up', label: 'Import costs from the ERP…', run: () => CU.importDialog({ projectId: p.projectId, onDone: () => redraw() }) } : null,
    { icon: 'chart', label: 'All plans (portfolio)', run: showPortfolio },
    '-',
    { icon: 'trash', label: 'Delete this plan…', danger: true, run: async () => {
      if (!confirm(`Delete the plan “${p.name}”? It is moved to data/plans/.trash and can be restored from there.`)) return;
      await api(`/api/plans/${p.id}/delete`, {}); S.plan = null; remember('nwa.plan.open', ''); await loadList(); redraw();
    } }];
}
function exportMenu() {
  return [
    { header: 'Export' },
    { icon: 'down', label: 'MS Project XML (opens in MS Project)', run: async () => { await flush(); location.href = `/api/plans/${S.plan.id}/export.xml`; } },
    { icon: 'down', label: 'Excel / CSV', run: exportCsv },
    { icon: 'calendar', label: 'Milestones as a calendar file (.ics)', run: () => exportIcs(null) },
    { icon: 'calendar', label: 'One person\'s tasks (.ics)…', run: () => { const n = prompt('Whose tasks? (name)', meName()); if (n) exportIcs(n); } },
    { icon: 'file', label: 'Obsidian note with a Mermaid Gantt', run: exportNote },
    { icon: 'print', label: 'Print / PDF', run: () => window.print() }];
}

// ---------- the Gantt view ----------
function ganttView() {
  const rows = visibleRows();
  const filters = [['all', 'All tasks'], ['critical', 'Critical'], ['late', 'Late or slipping'], ['milestones', 'Milestones'], ['incomplete', 'Incomplete'], ['mine', 'My tasks'], ['issues', 'With open issues']];
  const sel = h('select', { style: 'width:auto', 'aria-label': 'Filter', onchange: e => { S.filter = e.target.value; redraw(); } }, filters.map(([k, l]) => h('option', { value: k }, l)));
  sel.value = S.filter;
  const search = h('input', { type: 'search', placeholder: 'Find a task…', value: S.q, style: 'width:170px', oninput: e => { S.q = e.target.value; clearTimeout(S.qt); S.qt = setTimeout(redraw, 200); } });
  const zoom = h('div', { class: 'seg' }, Object.keys(ZOOMS).map(z => h('button', { class: S.zoom === z ? 'on' : '', onclick: () => setZoom(z) }, z[0].toUpperCase() + z.slice(1))));
  const tools = h('div', { class: 'pl-tools' },
    h('button', { class: 'btn primary', title: 'Add a task below the selected one (Insert)', onclick: () => addTask() }, icon('plus'), 'Task'),
    h('button', { class: 'btn', title: 'Add a milestone', onclick: () => addTask({ milestone: true }) }, '◆ Milestone'),
    h('button', { class: 'btn ghost', title: 'Indent (Alt+Shift+→)', onclick: indent }, '→'),
    h('button', { class: 'btn ghost', title: 'Outdent (Alt+Shift+←)', onclick: outdent }, '←'),
    h('button', { class: 'btn ghost', title: 'Link the selected tasks in order (Ctrl+F2)', onclick: linkSelected }, icon('link')),
    h('button', { class: 'btn ghost', title: 'Unlink the selected tasks', onclick: unlinkSelected }, '⛓̸'),
    h('button', { class: 'btn ghost', title: 'Task details (Shift+F2)', onclick: () => { const u = [...S.sel][0]; if (u != null) openTask(u); } }, icon('edit')),
    h('button', { class: 'btn ghost', title: 'Delete the selected tasks (Delete)', onclick: deleteSelected }, icon('trash')),
    h('span', { class: 'pl-sep' }), sel, search, h('div', { class: 'spacer' }),
    h('button', { class: 'btn ghost', title: 'Choose columns', onclick: e => showMenu(e, COLS.filter(c => !c.fixed).map(c => ({ icon: shownCols().includes(c) ? 'eye' : 'x', label: c.t, run: () => { S.cols[c.k] = !shownCols().includes(c); remember('nwa.plan.cols', JSON.stringify(S.cols)); redraw(); } }))) }, 'Columns ▾'),
    h('button', { class: 'btn ghost', title: 'Scroll to today', onclick: () => { S.scrollLeft = null; S.focusTime = E.toMin(fmt(new Date())); layoutGantt(); } }, 'Today'),
    h('button', { class: 'btn ghost', title: 'Fit the whole plan', onclick: fitPlan }, 'Fit'), zoom);
  const strip = V.timelineStrip(api_(), id => selectAndShow(id));
  // grid + chart
  const cols = shownCols(), gridMin = cols.reduce((s, c) => s + (S.cols['w_' + c.k] || c.w), 0);
  const gridHead = h('div', { class: 'pl-ghead', style: `width:${gridMin}px` }, cols.map(c => h('div', { class: 'pl-hc', style: `width:${S.cols['w_' + c.k] || c.w}px` }, c.t)));
  const gridRows = h('div', { class: 'pl-grows', style: `width:${gridMin}px;height:${rows.length * ROW + ROW * 3}px` });
  const gridInner = h('div', { class: 'pl-ginner' }, gridHead, gridRows);
  const grid = h('div', { class: 'pl-grid', style: `width:${S.gridW}px`, tabindex: 0, onkeydown: gridKey }, gridInner);
  const canvas = h('canvas', { class: 'pl-canvas' });
  const tip = h('div', { class: 'pl-tip', hidden: '' });
  const vbar = h('div', { class: 'pl-vbar' }, h('div', { style: `height:${rows.length * ROW + HEAD + ROW * 3}px` }));
  const hbar = h('div', { class: 'pl-hbar' }, h('div', { class: 'pl-hfill' }));
  const chart = h('div', { class: 'pl-chart' }, canvas, tip, hbar);
  const split = h('div', { class: 'pl-split', title: 'Drag to resize', onmousedown: e => startSplit(e) });
  const wrap = h('div', { class: 'pl-wrap' }, grid, split, chart, vbar);
  Object.assign(S.els, { rows, gridRows, grid, gridHead, canvas, tip, chart, vbar, hbar, wrap, gridInner });
  // wheel: vertical scroll everywhere, Shift = horizontal, Ctrl = zoom
  const wheel = e => {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); setZoom(e.deltaY > 0 ? zoomStep(1) : zoomStep(-1), e); return; }
    e.preventDefault();
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) hbar.scrollLeft += e.shiftKey ? e.deltaY : e.deltaX;
    else vbar.scrollTop += e.deltaY;
  };
  chart.addEventListener('wheel', wheel, { passive: false });
  grid.addEventListener('wheel', e => { if (!e.shiftKey && Math.abs(e.deltaX) <= Math.abs(e.deltaY) && !e.ctrlKey) { e.preventDefault(); vbar.scrollTop += e.deltaY; } }, { passive: false });
  vbar.addEventListener('scroll', () => { S.scrollTop = vbar.scrollTop; paintGrid(); drawChart(); });
  hbar.addEventListener('scroll', () => { S.scrollLeft = hbar.scrollLeft; drawChart(); });
  if (!S.ro) S.ro = new ResizeObserver(() => { if (S.view === 'gantt' && S.els.wrap && S.els.wrap.isConnected) layoutGantt(); });
  S.ro.disconnect(); S.ro.observe(wrap);
  return h('div', { class: 'pl-gantt' }, tools, strip, wrap);
}
function zoomStep(dir) { const ks = Object.keys(ZOOMS), i = ks.indexOf(S.zoom); return ks[Math.max(0, Math.min(ks.length - 1, i + dir))]; }
function setZoom(z, e) {
  const g = S.gantt, centre = g && S.els.chart ? g.t(e ? e.clientX - S.els.chart.getBoundingClientRect().left : (S.els.chart.clientWidth || 600) / 2) : null;
  S.zoom = z; remember('nwa.plan.zoom', z);
  if (centre != null) { S.focusTime = centre; S.scrollLeft = null; }
  redraw();
}
function fitPlan() {
  if (!S.sched || !S.els.chart) return;
  const days = (S.sched.finish - S.sched.start) / E.DAY + 4, w = S.els.chart.clientWidth || 800;
  const z = Object.entries(ZOOMS).find(([, ppd]) => days * ppd <= w - 40)?.[0] || 'year';
  S.zoom = z; remember('nwa.plan.zoom', z); S.focusTime = S.sched.start - E.DAY; S.scrollLeft = null; S.alignLeft = true; redraw();
}
function startSplit(e) {
  e.preventDefault();
  const x0 = e.clientX, w0 = S.gridW;
  const mv = ev => { S.gridW = Math.max(200, Math.min(1400, w0 + ev.clientX - x0)); S.els.grid.style.width = S.gridW + 'px'; layoutGantt(); };
  const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); remember('nwa.plan.gridW', String(S.gridW)); };
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
}
function layoutGantt() {
  const { chart, canvas, vbar, hbar } = S.els;
  if (!chart || !chart.isConnected || !S.sched) return;
  if (!S.gantt || S.gantt.c !== canvas) {
    if (S.gantt) S.gantt.destroy();
    S.gantt = new Gantt(canvas, {
      select: (uid, add, range) => selectRow(uid, add, range), open: uid => openTask(uid), menu: (e, uid) => { selectRow(uid); showMenu(e, rowMenu(uid)); },
      preview: ch => previewDrag(ch), commit: ch => commitDrag(ch), tip: t => paintTip(t),
      label: uid => resourceText(uid).replace(/\[\d+%\]/g, ''),
    });
  }
  const w = chart.clientWidth, hgt = chart.clientHeight - 14;
  const g = S.gantt;
  const origin = Math.floor((Math.min(S.sched.start, E.toMin(fmt(new Date()))) - 14 * E.DAY) / E.DAY) * E.DAY;
  const end = Math.max(S.sched.finish, E.toMin(fmt(new Date()))) + 90 * E.DAY;
  g.set({ rows: S.els.rows, sched: S.sched, byUid: new Map(S.plan.tasks.map(t => [t.uid, t])), zoom: S.zoom, origin, end,
    status: E.toMin(S.plan.statusDate), today: E.toMin(fmt(new Date())) + new Date().getHours() * 60 + new Date().getMinutes(),
    baseline: S.baselineN, colors: ganttColors(chart), selected: S.sel, issues: openIssueTasks() });
  g.resize(w, hgt);
  hbar.firstChild.style.width = g.width() + 'px';
  if (S.scrollLeft == null) {
    const focus = S.focusTime ?? E.toMin(fmt(new Date()));
    S.scrollLeft = Math.max(0, (focus - origin) / E.DAY * g.ppd - (S.alignLeft ? 20 : w * 0.25));
    S.focusTime = null; S.alignLeft = false;
  }
  hbar.scrollLeft = S.scrollLeft; S.scrollLeft = hbar.scrollLeft;
  vbar.style.top = HEAD + 'px';
  vbar.scrollTop = S.scrollTop; S.scrollTop = vbar.scrollTop;
  paintGrid(); drawChart();
}
function drawChart() {
  const g = S.gantt;
  if (!g || !S.els.canvas.isConnected) return;
  g.scrollTop = S.scrollTop; g.scrollLeft = S.scrollLeft || 0; g.rows = S.els.rows; g.selected = S.sel;
  g.draw();
}
function selectRow(uid, add, range) {
  if (uid == null) { S.sel = new Set(); }
  else if (range && S.cursor) {
    const rows = S.els.rows, a = rows.indexOf(S.cursor.uid), b = rows.indexOf(uid);
    S.sel = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else if (add) { S.sel.has(uid) ? S.sel.delete(uid) : S.sel.add(uid); }
  else S.sel = new Set([uid]);
  if (uid != null) S.cursor = { uid, k: (S.cursor && S.cursor.k) || 'name' };
  paintSel(); drawChart();
}
function paintSel() {  // only the classes change, so a double-click still lands on the same row element
  const { gridRows } = S.els;
  if (!gridRows) return;
  gridRows.querySelectorAll('.pl-row[data-uid]').forEach(r => r.classList.toggle('sel', S.sel.has(Number(r.dataset.uid))));
  paintCursor();
}
function paintGrid() {
  const { gridRows, rows, grid } = S.els;
  if (!gridRows) return;
  const cols = shownCols(), ids = rowIds(), actual = cols.some(c => c.k === 'actual') ? actualHours() : new Map();
  const h0 = grid.clientHeight || 600, first = Math.max(0, Math.floor(S.scrollTop / ROW) - 2), last = Math.min(rows.length, first + Math.ceil(h0 / ROW) + 4);
  const issues = openIssueTasks(), out = [];
  for (let i = first; i < last; i++) {
    const uid = rows[i], t = taskOf(uid), r = S.sched.byUid.get(uid);
    if (!t || !r) continue;
    const depth = S.sched.outline.depth.get(uid) || 0;
    const cells = cols.map(c => {
      const w = S.cols['w_' + c.k] || c.w;
      if (c.k === 'name') {
        return h('div', { class: 'pl-c pl-name' + (r.summary ? ' sum' : ''), style: `width:${w}px;padding-left:${8 + depth * 16}px`, 'data-k': 'name' },
          r.summary ? h('button', { class: 'pl-tog', 'aria-label': S.collapsed.has(uid) ? 'Expand' : 'Collapse', onclick: e => { e.stopPropagation(); S.collapsed.has(uid) ? S.collapsed.delete(uid) : S.collapsed.add(uid); redraw(); } }, S.collapsed.has(uid) ? '▸' : '▾') : h('span', { class: 'pl-tog' }),
          r.milestone ? h('span', { class: 'pl-dia' }, '◆') : null, h('span', { class: 'pl-txt' }, t.name || ''));
      }
      if (c.k === 'ind') {
        const marks = [];
        if (r.conflict) marks.push(h('span', { class: 'pl-i bad', title: r.conflict }, '!'));
        else if ((t.constraint || {}).type && t.constraint.type !== 'ASAP') marks.push(h('span', { class: 'pl-i', title: `${t.constraint.type} ${t.constraint.date ? fmtDate(E.toMin(t.constraint.date)) : ''}` }, '⌖'));
        if (r.pct >= 100) marks.push(h('span', { class: 'pl-i ok', title: 'Done' }, '✓'));
        else if (r.late || r.missesDeadline) marks.push(h('span', { class: 'pl-i bad', title: r.missesDeadline ? 'Misses its deadline' : 'Behind schedule' }, '●'));
        if (issues.has(uid)) marks.push(h('span', { class: 'pl-i warn', title: 'Open issue or risk' }, '⚑'));
        if (t.notes) marks.push(h('span', { class: 'pl-i', title: t.notes }, '✎'));
        if (t.manual) marks.push(h('span', { class: 'pl-i', title: 'Manually scheduled' }, '✋'));
        return h('div', { class: 'pl-c pl-ind', style: `width:${w}px` }, marks.slice(0, 2));
      }
      return h('div', { class: 'pl-c' + (['dur', 'pct', 'id', 'slack', 'fvar', 'planned', 'actual'].includes(c.k) ? ' num' : '') + (c.k === 'id' ? ' pl-id' : ''), style: `width:${w}px`, 'data-k': c.k }, cellText(c, uid, ids.get(uid), ids, actual));
    });
    const cls = 'pl-row' + (S.sel.has(uid) ? ' sel' : '') + (r.summary ? ' sum' : '') + (r.critical && !r.summary ? ' crit' : '') + (r.pct >= 100 ? ' done' : '');
    const row = h('div', { class: cls, style: `top:${i * ROW}px`, 'data-uid': uid,
      onmousedown: e => { if (e.target.closest('.pl-tog') || e.target.closest('input')) return; selectRow(uid, e.ctrlKey || e.metaKey, e.shiftKey); const k = e.target.closest('[data-k]'); if (k) S.cursor = { uid, k: k.dataset.k }; paintCursor(); },
      ondblclick: e => { const k = e.target.closest('[data-k]'); if (k && COLS.find(c => c.k === k.dataset.k)?.edit) startEdit(uid, k.dataset.k); else openTask(uid); },
      oncontextmenu: e => { selectRow(uid); showMenu(e, rowMenu(uid)); } }, cells);
    out.push(row);
  }
  // the empty row at the bottom: type to add a task
  const addRow = h('div', { class: 'pl-row pl-add', style: `top:${rows.length * ROW}px`, onclick: () => addTask({ after: rows[rows.length - 1] }) },
    h('div', { class: 'pl-c', style: `width:${(S.cols.w_id || 42) + (S.cols.w_ind || 30)}px` }), h('div', { class: 'pl-c', style: 'width:240px;color:var(--muted)' }, '+ Add a task'));
  if (last >= rows.length - 1) out.push(addRow);
  gridRows.replaceChildren(...out);
  gridRows.style.transform = `translateY(${-S.scrollTop}px)`;
  paintCursor();
}
function paintCursor() {
  const { gridRows } = S.els;
  if (!gridRows) return;
  gridRows.querySelectorAll('.pl-c.cur').forEach(x => x.classList.remove('cur'));
  if (!S.cursor) return;
  const row = gridRows.querySelector(`.pl-row[data-uid="${S.cursor.uid}"]`), cell = row && row.querySelector(`[data-k="${S.cursor.k}"]`);
  if (cell) cell.classList.add('cur');
}
function startEdit(uid, k, initial) {
  const col = COLS.find(c => c.k === k);
  if (!col || !col.edit) return;
  ensureVisible(uid);
  paintGrid();
  const row = S.els.gridRows.querySelector(`.pl-row[data-uid="${uid}"]`), cell = row && row.querySelector(`[data-k="${k}"]`);
  if (!cell) return;
  const ids = rowIds(), cur = cellText(col, uid, ids.get(uid), ids, new Map());
  const inp = h('input', { class: 'pl-edit', value: initial != null ? initial : (k === 'pct' ? cur.replace('%', '') : cur) });
  let done = false;
  const finish = (save, move) => {
    if (done) return; done = true;
    const v = inp.value;
    inp.remove();
    if (save && v !== cur) setCell(uid, k, v); else paintGrid();
    if (move) moveCursor(move);
    S.els.grid && S.els.grid.focus({ preventScroll: true });
  };
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true, [1, 0]); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Tab') { e.preventDefault(); finish(true, [0, e.shiftKey ? -1 : 1]); }
    e.stopPropagation();
  });
  inp.addEventListener('blur', () => finish(true));
  cell.replaceChildren(inp);
  inp.focus();
  if (initial == null) inp.select(); else inp.setSelectionRange(inp.value.length, inp.value.length);
}
function ensureVisible(uid) {
  const i = S.els.rows.indexOf(uid);
  if (i < 0) return;
  const hgt = S.els.grid.clientHeight - HEAD - ROW;
  if (i * ROW < S.scrollTop) S.scrollTop = i * ROW;
  else if ((i + 1) * ROW > S.scrollTop + hgt) S.scrollTop = (i + 1) * ROW - hgt;
  if (S.els.vbar) S.els.vbar.scrollTop = S.scrollTop;
  drawChart();
}
function moveCursor([dr, dc]) {
  const rows = S.els.rows, cols = shownCols().filter(c => c.edit || c.k === 'id');
  if (!S.cursor) { if (rows.length) S.cursor = { uid: rows[0], k: 'name' }; return paintCursor(); }
  let ri = rows.indexOf(S.cursor.uid), ci = cols.findIndex(c => c.k === S.cursor.k);
  ri = Math.max(0, Math.min(rows.length - 1, ri + dr)); ci = Math.max(0, Math.min(cols.length - 1, (ci < 0 ? 0 : ci) + dc));
  S.cursor = { uid: rows[ri], k: cols[ci].k };
  S.sel = new Set([rows[ri]]);
  ensureVisible(rows[ri]); paintGrid(); drawChart();
}
function gridKey(e) {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key, c = S.cursor;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); return undo(); }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
  if (e.altKey && e.shiftKey && k === 'ArrowRight') { e.preventDefault(); return indent(); }
  if (e.altKey && e.shiftKey && k === 'ArrowLeft') { e.preventDefault(); return outdent(); }
  if ((e.ctrlKey || e.metaKey) && k === 'F2') { e.preventDefault(); return linkSelected(); }
  if (e.shiftKey && k === 'F2') { e.preventDefault(); if (c) openTask(c.uid); return; }
  const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (moves[k]) { e.preventDefault(); return moveCursor(moves[k]); }
  if (k === 'Insert') { e.preventDefault(); return addTask(); }
  if (k === 'Delete') { e.preventDefault(); return deleteSelected(); }
  if (!c) return;
  if (k === 'F2' || k === 'Enter') { e.preventDefault(); return startEdit(c.uid, c.k); }
  if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && COLS.find(x => x.k === c.k)?.edit) { e.preventDefault(); startEdit(c.uid, c.k, k); }
}
document.addEventListener('keydown', e => {  // undo/redo anywhere on the Plan tab
  if (view.tab !== 'plan' || e.target.closest('input,textarea,select,dialog')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
});
function rowMenu(uid) {
  const t = taskOf(uid), r = S.sched.byUid.get(uid);
  return [
    { icon: 'edit', label: 'Task details…', run: () => openTask(uid) },
    { icon: 'plus', label: 'Insert a task below', run: () => addTask({ after: uid }) },
    { icon: 'plus', label: 'Insert a milestone below', run: () => addTask({ after: uid, milestone: true }) },
    '-',
    { icon: 'right', label: 'Indent', run: indent }, { icon: 'left', label: 'Outdent', run: outdent },
    S.sel.size > 1 ? { icon: 'link', label: 'Link the selected tasks', run: linkSelected } : null,
    (t.links || []).length ? { icon: 'x', label: 'Remove its links', run: () => change('Remove links', () => { t.links = []; }) } : null,
    !r.summary ? { icon: 'stop', label: r.pct >= 100 ? 'Mark not done' : 'Mark 100% complete', run: () => change('Update progress', () => setPct(t, r.pct >= 100 ? 0 : 100)) } : null,
    !r.summary ? { icon: 'repeat', label: t.manual ? 'Auto schedule' : 'Manually schedule', run: () => change('Change scheduling mode', () => { t.manual = !t.manual; if (t.manual) { t.start = E.fromMin(r.es); t.finish = E.fromMin(r.ef); } }) } : null,
    '-',
    { icon: 'plus', label: 'Log an issue for this task…', run: () => V.raidDialog(api_(), null, { kind: 'issue', taskUids: [uid] }) },
    { icon: 'plus', label: 'Put it on the Board', run: () => toBoard(uid) },
    '-',
    { icon: 'trash', label: S.sel.size > 1 ? `Delete ${S.sel.size} tasks` : 'Delete', danger: true, run: deleteSelected }].filter(Boolean);
}
function toBoard(uid) {
  const t = taskOf(uid), r = S.sched.byUid.get(uid);
  if (t.deliverableId && state.deliverables.some(d => d.id === t.deliverableId)) return toast('It is already on the Board');
  const d = { id: Math.random().toString(36).slice(2, 9), title: t.name, projectId: S.plan.projectId || '', status: r.pct >= 100 ? 'done' : r.pct > 0 ? 'doing' : 'todo', due: E.dateOf(r.ef), notes: `From the plan “${S.plan.name}”` };
  state.deliverables.push(d);
  save();
  change('Link to a Board card', () => { t.deliverableId = d.id; });
  toast('Added to the Board');
}

// ---------- task details ----------
export function openTask(uid) {
  const t = taskOf(uid), r = S.sched.byUid.get(uid), u = S.plan.units, ids = rowIds();
  if (!t) return;
  const name = h('input', { value: t.name || '' });
  const dur = h('input', { value: E.formatDuration(t.duration || { minutes: 0, format: 'd' }, u), disabled: r.summary ? '' : false });
  const pct = h('input', { type: 'number', min: 0, max: 100, value: r.pct || 0, disabled: r.summary ? '' : false });
  const pri = h('input', { type: 'number', min: 0, max: 1000, value: t.priority ?? 500 });
  const manual = h('input', { type: 'checkbox', checked: t.manual ? '' : false });
  const ctype = h('select', {}, [['ASAP', 'As soon as possible'], ['ALAP', 'As late as possible'], ['SNET', 'Start no earlier than'], ['SNLT', 'Start no later than'], ['FNET', 'Finish no earlier than'], ['FNLT', 'Finish no later than'], ['MSO', 'Must start on'], ['MFO', 'Must finish on']].map(([k, l]) => h('option', { value: k }, l)));
  ctype.value = (t.constraint || {}).type || 'ASAP';
  const cdate = h('input', { type: 'date', value: ((t.constraint || {}).date || '').slice(0, 10) });
  const deadline = h('input', { type: 'date', value: (t.deadline || '').slice(0, 10) });
  const notes = h('textarea', { rows: 3 }); notes.value = t.notes || '';
  const nwa = h('select', {}, h('option', { value: '' }, 'Not linked'), state.projects.filter(p => p.network.trim()).map(p => h('option', { value: `${p.network.trim()}|${p.activity.trim()}` }, `${projectLabel(p)} (${p.network} / ${p.activity})`)));
  nwa.value = t.nwa || '';
  const files = h('input', { value: (t.files || []).join(', '), placeholder: 'Vault paths, e.g. Specs/Bridge spec.pdf#page=3' });
  const preds = h('input', { value: E.formatPredecessors(t.links, p => ids.get(p), u), placeholder: 'e.g. 4, 7SS+2d' });
  const res = h('input', { value: resourceText(uid), placeholder: 'e.g. Hiren, Maria[50%]' });
  const succs = S.plan.tasks.filter(x => (x.links || []).some(l => l.pred === uid)).map(x => `${ids.get(x.uid)} ${x.name}`);
  const v = E.variance(S.sched, t, S.baselineN);
  const bl = Object.entries(t.baselines || {}).sort((a, b) => a[0] - b[0]);
  const raid = (S.plan.raid || []).filter(x => (x.taskUids || []).includes(uid));
  const actual = actualHours().get(uid);
  const dlg = h('dialog', { class: 'dlg wide', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', onsubmit: e => {
      e.preventDefault();
      const d = E.parseDuration(dur.value, u);
      if (!r.summary && (!d || d.minutes < 0)) return toast('Type a duration like 3d, 2w or 0');
      const pl = E.parsePredecessors(preds.value, u);
      if (!pl) return toast('Predecessors look like 4, 7SS+2d');
      const byId = new Map([...ids].map(([u2, i]) => [i, u2]));
      if (pl.some(l => !byId.has(l.id) || byId.get(l.id) === uid)) return toast('A predecessor number doesn\'t match a task');
      const before = JSON.stringify(S.plan);
      change('Edit task', () => {
        t.name = name.value.trim();
        if (!r.summary) { t.duration = d; t.milestone = d.minutes === 0; setPct(t, Math.max(0, Math.min(100, +pct.value || 0))); }
        t.priority = Math.max(0, Math.min(1000, +pri.value || 500));
        if (!!t.manual !== manual.checked) { t.manual = manual.checked; if (t.manual) { t.start = E.fromMin(r.es); t.finish = E.fromMin(r.ef); } }
        t.constraint = { type: ctype.value, date: ['ASAP', 'ALAP'].includes(ctype.value) ? null : (cdate.value ? cdate.value + (ctype.value.startsWith('F') || ctype.value === 'MFO' ? 'T17:00' : 'T08:00') : null) };
        if (!['ASAP', 'ALAP'].includes(ctype.value) && !cdate.value) t.constraint = { type: 'ASAP', date: null };
        t.deadline = deadline.value ? deadline.value + 'T17:00' : null;
        t.notes = notes.value;
        t.nwa = nwa.value || null;
        t.files = files.value.split(',').map(s => s.trim()).filter(Boolean);
        t.links = pl.map(l => ({ pred: byId.get(l.id), type: l.type, lag: l.lag }));
        assignFromText(uid, res.value);
      }, { quiet: true });
      const loop = S.sched.errors.find(x => /circular|own subtask/.test(x.text));
      if (loop) { restore(before); S.undo.pop(); return toast('That would make a loop: ' + loop.text); }
      dlg.close(); redraw();
    } },
      h('h3', {}, `Task ${ids.get(uid)}${r.summary ? ' · summary' : r.milestone ? ' · milestone' : ''}`),
      h('div', {}, h('label', {}, 'Name'), name),
      h('div', { class: 'row3' }, h('div', {}, h('label', {}, 'Duration'), dur), h('div', {}, h('label', {}, '% complete'), pct), h('div', {}, h('label', {}, 'Priority (0–1000)'), pri)),
      h('p', { class: 'hint', style: 'margin:0' }, `Scheduled ${fmtDate(r.es)} → ${fmtDate(r.ef)} · total slack ${E.formatDuration({ minutes: r.totalSlack || 0, format: 'd' }, u)} · free slack ${E.formatDuration({ minutes: r.freeSlack || 0, format: 'd' }, u)}${r.critical ? ' · on the critical path' : ''}`,
        v ? ` · finish ${v.finish > 0 ? E.formatDuration({ minutes: v.finish, format: 'd' }, u) + ' later than' : v.finish < 0 ? E.formatDuration({ minutes: -v.finish, format: 'd' }, u) + ' earlier than' : 'same as'} baseline ${S.baselineN}` : ''),
      r.conflict ? h('p', { class: 'neg', style: 'margin:0' }, '⚠ ' + r.conflict) : '',
      h('div', { class: 'row2' }, h('div', {}, h('label', {}, 'Predecessors'), preds, succs.length ? h('small', { class: 'hint' }, 'Successors: ' + succs.join(', ')) : ''), h('div', {}, h('label', {}, 'People'), res)),
      h('div', { class: 'row3' }, h('div', {}, h('label', {}, 'Constraint'), ctype), h('div', {}, h('label', {}, 'Constraint date'), cdate), h('div', {}, h('label', {}, 'Deadline'), deadline)),
      h('label', { class: 'sw' }, manual, 'Manually scheduled (links and the calendar don\'t move it)'),
      h('div', { class: 'row2' }, h('div', {}, h('label', {}, 'Charges to (timesheet NWA)'), nwa,
        h('small', { class: 'hint' }, actual ? `${Math.round(actual * 10) / 10} h charged so far · ${hrs(plannedMinutes(uid))} h planned` : `${hrs(plannedMinutes(uid))} h planned`)),
        h('div', {}, h('label', {}, 'Files in the vault'), files)),
      h('div', {}, h('label', {}, 'Notes'), notes),
      bl.length ? h('div', {}, h('label', {}, 'Baselines'), h('table', { class: 'rep' }, h('tbody', {}, bl.map(([n, b]) => h('tr', {}, h('td', {}, `Baseline ${n}`), h('td', {}, b.start ? fmtDate(E.toMin(b.start)) : ''), h('td', {}, b.finish ? fmtDate(E.toMin(b.finish)) : ''), h('td', {}, E.formatDuration({ minutes: b.minutes || 0, format: 'd' }, u))))))) : '',
      Object.keys(t.custom || {}).length ? h('div', {}, h('label', {}, 'Custom fields (from MS Project)'), h('div', { class: 'hint' }, Object.entries(t.custom).map(([k, val]) => `${k}: ${val}`).join(' · '))) : '',
      raid.length ? h('div', {}, h('label', {}, 'Issues and risks'), h('div', { class: 'list' }, raid.map(x => h('button', { type: 'button', class: 'li', onclick: () => { dlg.close(); V.raidDialog(api_(), x); } }, h('span', { class: 'chip' + (x.status === 'closed' ? ' muted' : '') }, x.kind), h('span', { class: 'nm' }, x.title))))) : '',
      h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'btn danger', style: 'margin-right:auto', onclick: () => { dlg.close(); S.sel = new Set([uid]); deleteSelected(); } }, 'Delete'),
        h('button', { type: 'button', class: 'btn', onclick: () => { dlg.close(); V.raidDialog(api_(), null, { kind: 'issue', taskUids: [uid] }); } }, 'Log an issue'),
        h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, 'Save'))));
  document.body.append(dlg); dlg.showModal(); name.focus();
}

// ---------- new plan, templates, import ----------
export async function newPlanDialog() {
  await loadList();
  const templates = (S.list || []).filter(p => p.template);
  const name = h('input', { placeholder: 'e.g. Girder Bridge rehab', required: '' });
  const proj = h('select', {}, h('option', { value: '' }, 'No project'), state.projects.map(p => h('option', { value: p.id }, projectLabel(p))));
  const start = h('input', { type: 'date', value: nextMonday() });
  const tpl = h('select', {}, h('option', { value: '' }, 'Blank plan'), templates.map(t => h('option', { value: t.id }, `Template: ${t.name}`)));
  proj.onchange = () => { if (!name.value && proj.value) name.value = projectLabel(projectById(proj.value)); };
  const dlg = h('dialog', { class: 'dlg', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', onsubmit: async e => {
      e.preventDefault();
      if (!name.value.trim()) return name.focus();
      let plan = newPlan({ name: name.value.trim(), projectId: proj.value || null, start: start.value });
      if (tpl.value) {
        const t = await api('/api/plans/' + tpl.value);
        plan = { ...plan, tasks: t.tasks.map(x => ({ ...x, constraint: { type: 'ASAP' }, percent: 0, actualStart: null, actualFinish: null, baselines: {}, start: null, finish: null, msp: null })),
          resources: t.resources && t.resources.length ? t.resources : plan.resources, assignments: t.assignments || [], units: t.units || plan.units };
      }
      const made = await api('/api/plans', { plan });
      dlg.close(); await loadList(); await openPlan(made.id); redraw();
      if (!plan.tasks.length) setTimeout(() => addTask(), 60);
    } },
      h('h3', {}, 'New plan'),
      h('div', {}, h('label', {}, 'Project'), proj),
      h('div', {}, h('label', {}, 'Plan name'), name),
      h('div', { class: 'row2' }, h('div', {}, h('label', {}, 'Starts'), start), h('div', {}, h('label', {}, 'Start from'), tpl)),
      h('p', { class: 'hint', style: 'margin:0' }, 'The calendar comes from your work schedule and holidays (Settings). You can also open an MS Project file instead.'),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', style: 'margin-right:auto', onclick: () => { dlg.close(); importDialog(); } }, icon('down'), 'Open an MS Project file'),
        h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Create'))));
  document.body.append(dlg); dlg.showModal(); proj.focus();
}
async function saveTemplate() {
  const n = prompt('Template name', S.plan.name + ' template');
  if (!n) return;
  const p = JSON.parse(JSON.stringify(S.plan));
  delete p.id; delete p.rev;
  Object.assign(p, { name: n.trim(), template: true, statusDate: null, raid: [], changeLog: [], projectId: null });
  p.tasks.forEach(t => Object.assign(t, { percent: 0, actualStart: null, actualFinish: null, baselines: {}, constraint: { type: 'ASAP' }, deliverableId: null }));
  await api('/api/plans', { plan: p });
  await loadList();
  toast(`Saved the template “${n.trim()}” – pick it under New plan`);
}
function projectDialog() {
  const sel = h('select', {}, h('option', { value: '' }, 'No project'), state.projects.map(p => h('option', { value: p.id }, projectLabel(p))));
  sel.value = S.plan.projectId || '';
  const dlg = h('dialog', { class: 'dlg', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', onsubmit: e => { e.preventDefault(); change('Link to a project', p => { p.projectId = sel.value || null; }); dlg.close(); loadList(); } },
      h('h3', {}, 'Link the plan to a project'), sel,
      h('p', { class: 'hint', style: 'margin:0' }, 'Link individual tasks to network/activity numbers in Task details to see the hours charged on the timesheet.'),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Save'))));
  document.body.append(dlg); dlg.showModal();
}
function baselineDialog() {
  const n = h('select', {}, Array.from({ length: 11 }, (_, i) => h('option', { value: i }, `Baseline ${i}${Object.values(S.plan.tasks).some(t => (t.baselines || {})[i]) ? ' (set – will be replaced)' : ''}`)));
  n.value = S.baselineN;
  const show = h('select', {}, Array.from({ length: 11 }, (_, i) => h('option', { value: i }, `Compare with baseline ${i}`)));
  show.value = S.baselineN;
  const dlg = h('dialog', { class: 'dlg', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', onsubmit: e => {
      e.preventDefault();
      change(`Set baseline ${n.value}`, p => { p.tasks = E.setBaseline(p, S.sched, +n.value).tasks; CU.stampBaselineCost(p, S.sched, +n.value); });
      S.baselineN = +show.value; dlg.close(); redraw(); toast(`Baseline ${n.value} saved`);
    } },
      h('h3', {}, 'Baselines'),
      h('p', { class: 'hint', style: 'margin:0' }, 'A baseline saves every task\'s current start, finish, duration, work and planned cost, so you can see what slipped later – and work out earned value.'),
      h('div', {}, h('label', {}, 'Save the current schedule as'), n),
      h('div', {}, h('label', {}, 'Gantt and variance columns use'), show),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', style: 'margin-right:auto', onclick: () => { S.baselineN = +show.value; dlg.close(); redraw(); } }, 'Only change the comparison'),
        h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Set baseline'))));
  document.body.append(dlg); dlg.showModal();
}
export function importDialog(intoCurrent = false) {
  const inp = h('input', { type: 'file', accept: '.xml,.mpp,.mpx,.mpt', hidden: '' });
  inp.onchange = async () => {
    const f = inp.files[0]; inp.remove();
    if (!f) return;
    const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.readAsDataURL(f); });
    let j;
    try { j = await api('/api/plans/import', { filename: f.name, data: b64 }); } catch (e) { return toast(e.message); }
    importPreview(j, f.name, intoCurrent && S.plan);
  };
  document.body.append(inp); inp.click();
}
function importPreview(j, filename, target) {
  const st = j.stats, plan = j.plan;
  const proj = h('select', {}, h('option', { value: '' }, 'No project'), state.projects.map(p => h('option', { value: p.id }, projectLabel(p))));
  if (target) proj.value = target.projectId || '';
  let diff = null;
  if (target) {
    const old = new Map(target.tasks.map(t => [t.uid, t])), neu = new Map(plan.tasks.map(t => [t.uid, t]));
    const added = plan.tasks.filter(t => !old.has(t.uid)), removed = target.tasks.filter(t => !neu.has(t.uid));
    const changed = plan.tasks.filter(t => old.has(t.uid)).filter(t => { const o = old.get(t.uid); return o.name !== t.name || (o.start || '').slice(0, 10) !== (t.start || '').slice(0, 10) || (o.finish || '').slice(0, 10) !== (t.finish || '').slice(0, 10) || (o.percent || 0) !== (t.percent || 0) || JSON.stringify(o.links || []) !== JSON.stringify(t.links || []); });
    diff = { added, removed, changed, old };
  }
  const dlg = h('dialog', { class: 'dlg wide', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', onsubmit: async e => {
      e.preventDefault();
      if (target) {
        const keepFields = ['nwa', 'deliverableId', 'files'];
        change(`Update from ${filename}`, p => {
          const old = new Map(p.tasks.map(t => [t.uid, t]));
          p.tasks = plan.tasks.map(t => { const o = old.get(t.uid); const out = { ...t }; if (o) keepFields.forEach(k => { if (o[k] != null) out[k] = o[k]; }); return out; });
          Object.assign(p, { resources: plan.resources.length ? plan.resources : p.resources, assignments: plan.assignments, units: plan.units, calendar: plan.calendar || p.calendar, calendarSource: plan.calendarSource, msp: plan.msp, start: plan.start || p.start, statusDate: plan.statusDate || p.statusDate });
          p.projectId = proj.value || null;
        });
        dlg.close(); toast('Plan updated from the MS Project file – Undo is available');
        return;
      }
      if (!plan.resources.some(r => r.me)) {
        const me = plan.resources.find(r => r.name.toLowerCase() === meName().toLowerCase());
        if (me) me.me = true;
      }
      const made = await api('/api/plans', { plan: { ...plan, projectId: proj.value || null, raid: [], changeLog: [{ at: new Date().toISOString(), by: 'import', summary: `Imported ${filename}` }] } });
      dlg.close(); await loadList(); await openPlan(made.id); redraw();
      toast(`Opened ${st.tasks} tasks from ${filename}`);
    } },
      h('h3', {}, target ? `Update “${target.name}” from ${filename}` : `Open ${filename}`),
      h('p', {}, h('b', {}, plan.name), ` · ${st.tasks} tasks (${st.summaries} summaries, ${st.milestones} milestones) · ${st.links} links · ${st.resources} people · ${st.assignments} assignments · ${st.calendars} calendar${st.calendars === 1 ? '' : 's'}${st.baselines ? ` · ${st.baselines} baseline${st.baselines > 1 ? 's' : ''}` : ''}${st.customFields ? ` · ${st.customFields} custom field${st.customFields > 1 ? 's' : ''}` : ''}`),
      j.warnings.length ? issueList(j.warnings.map(w => ({ lvl: 'warn', text: w }))) : '',
      diff ? h('div', {}, h('label', {}, 'Changes'), h('p', { class: 'hint', style: 'margin:0' }, `${diff.added.length} added · ${diff.removed.length} removed · ${diff.changed.length} changed. Links to timesheet NWAs, Board cards and files are kept; everything else comes from the file.`),
        h('ul', { class: 'mv-done' }, [...diff.added.slice(0, 8).map(t => h('li', {}, `+ ${t.name}`)), ...diff.removed.slice(0, 8).map(t => h('li', {}, `− ${t.name}`)),
          ...diff.changed.slice(0, 12).map(t => { const o = diff.old.get(t.uid); return h('li', {}, `~ ${t.name}${(o.finish || '').slice(0, 10) !== (t.finish || '').slice(0, 10) ? `: finish ${(o.finish || '').slice(0, 10)} → ${(t.finish || '').slice(0, 10)}` : ''}`); })])) : '',
      h('div', {}, h('label', {}, 'Project'), proj),
      h('p', { class: 'hint', style: 'margin:0' }, 'Everything in the file is kept – including what Keystone doesn\'t show – and written back when you export to MS Project XML.'),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, target ? 'Update the plan' : 'Open as a new plan'))));
  document.body.append(dlg); dlg.showModal();
}

// ---------- exports ----------
function exportCsv() {
  const ids = rowIds(), u = S.plan.units, q = s => `"${String(s ?? '').replace(/"/g, '""')}"`, actual = actualHours();
  const head = ['ID', 'WBS', 'Outline level', 'Name', 'Duration', 'Start', 'Finish', 'Predecessors', 'Resource names', '% complete', 'Milestone', 'Total slack (d)', 'Critical', 'Baseline finish', 'Deadline', 'Planned h', 'Actual h', 'Notes'];
  const lines = [head.join(',')];
  for (const uid of S.sched.order) {
    const t = taskOf(uid), r = S.sched.byUid.get(uid), b = (t.baselines || {})[S.baselineN];
    lines.push([ids.get(uid), q(t.wbs || S.sched.outline.wbs.get(uid)), (S.sched.outline.depth.get(uid) || 0) + 1, q(t.name), q(E.formatDuration(r.summary ? { minutes: r.dur, format: 'd' } : t.duration, u)),
      E.fromMin(r.es).replace('T', ' '), E.fromMin(r.ef).replace('T', ' '), q(E.formatPredecessors(t.links, p => ids.get(p), u)), q(resourceText(uid)), r.pct || 0, r.milestone ? 'Yes' : 'No',
      Math.round((r.totalSlack || 0) / u.minutesPerDay * 100) / 100, r.critical ? 'Yes' : 'No', b && b.finish ? b.finish.replace('T', ' ') : '', t.deadline ? t.deadline.replace('T', ' ') : '',
      hrs(plannedMinutes(uid)), Math.round((actual.get(uid) || 0) * 10) / 10, q(t.notes)].join(','));
  }
  download(`${S.plan.name}.csv`, lines.join('\n'), 'text/csv');
}
function exportIcs(person) {
  const r0 = person ? S.plan.resources.find(r => r.name.toLowerCase() === person.toLowerCase() || (r.initials || '').toLowerCase() === person.toLowerCase()) : null;
  if (person && !r0) return toast(`No one called ${person} in this plan`);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const d8 = t => E.fromMin(t).slice(0, 10).replace(/-/g, '');
  const esc = s => String(s || '').replace(/[\\,;]/g, m => '\\' + m).replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Keystone//Planner//EN', 'CALSCALE:GREGORIAN'];
  for (const uid of S.sched.order) {
    const t = taskOf(uid), r = S.sched.byUid.get(uid);
    if (r.summary) continue;
    if (r0 ? !assignmentsOf(uid).some(a => a.resourceUid === r0.uid) : !r.milestone) continue;
    const endDay = E.toMin(E.dateOf(r.ef)) + E.DAY;
    lines.push('BEGIN:VEVENT', `UID:${S.plan.id}-${uid}@keystone`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d8(r.milestone ? r.ef : r.es)}`, `DTEND;VALUE=DATE:${d8(endDay)}`,
      `SUMMARY:${esc((r.milestone ? '◆ ' : '') + t.name)}`, `DESCRIPTION:${esc(`${S.plan.name}${r.milestone ? ' milestone' : ''} · ${r.pct || 0}% complete${t.notes ? '\n' + t.notes : ''}`)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  download(`${S.plan.name}${r0 ? ' - ' + r0.name : ' milestones'}.ics`, lines.join('\r\n'), 'text/calendar');
}
async function exportNote() {
  if (!state.settings.vaultPath) return toast('Connect your vault in Settings first');
  const ids = rowIds(), md = [];
  const d = t => E.dateOf(t);
  md.push(`# ${S.plan.name} – plan`, '', `_Generated by Keystone on ${fmt(new Date())}. Edit the plan in Keystone; this note is rewritten when you export again._`, '');
  md.push(`**Finish:** ${d(S.sched.finish)}${S.plan.statusDate ? ` · **Status date:** ${S.plan.statusDate.slice(0, 10)}` : ''}`, '');
  md.push('## Milestones', '', '| Milestone | Date | Status |', '| --- | --- | --- |');
  for (const uid of S.sched.order) { const t = taskOf(uid), r = S.sched.byUid.get(uid); if (r.milestone) md.push(`| ${t.name.replace(/\|/g, '\\|')} | ${d(r.ef)} | ${r.pct >= 100 ? 'Done' : r.late || r.missesDeadline ? 'At risk' : 'On track'} |`); }
  md.push('', '## Timeline', '', '```mermaid', 'gantt', `  title ${S.plan.name.replace(/[:#]/g, ' ')}`, '  dateFormat YYYY-MM-DD', '  axisFormat %b %d');
  let section = null;
  for (const uid of S.sched.order) {
    const t = taskOf(uid), r = S.sched.byUid.get(uid), name = (t.name || 'Task').replace(/[:#;]/g, ' ');
    if (r.summary) { section = name; md.push(`  section ${name}`); continue; }
    if (!section) { section = 'Tasks'; md.push('  section Tasks'); }
    const tags = [r.pct >= 100 ? 'done' : r.pct > 0 ? 'active' : '', r.critical ? 'crit' : '', r.milestone ? 'milestone' : ''].filter(Boolean).join(', ');
    md.push(`  ${name} :${tags ? tags + ', ' : ''}t${uid}, ${d(r.es)}, ${r.milestone ? '0d' : Math.max(1, Math.round((r.ef - r.es) / E.DAY + 0.5)) + 'd'}`);
  }
  md.push('```', '');
  const open = (S.plan.raid || []).filter(x => x.status !== 'closed');
  if (open.length) {
    md.push('## Open issues and risks', '', '| Kind | Title | Owner | Due | Tasks |', '| --- | --- | --- | --- | --- |');
    for (const x of open) md.push(`| ${x.kind} | ${x.title.replace(/\|/g, '\\|')} | ${x.owner || ''} | ${x.due || ''} | ${(x.taskUids || []).map(u => ids.get(u)).filter(Boolean).join(', ')} |`);
    md.push('');
  }
  const folder = (state.settings.vaultFolder || 'Keystone').replace(/^\/+|\/+$/g, '');
  const path = `${folder}/Plans/${S.plan.name.replace(/[\\/:*?"<>|]/g, '-')}.md`;
  try {
    let base = null;
    try { base = (await api('/api/notes/file?path=' + encodeURIComponent(path))).mtime; } catch {}
    await api('/api/notes/file', { path, content: md.join('\n'), base }, 'PUT');
    toast(`Saved ${path}`);
  } catch (e) { toast(e.message); }
}

// ---------- for the Today page and the assistant ----------
let digestCache = null;
export async function digest() {
  if (digestCache && Date.now() - digestCache.at < 60000) return digestCache.data;
  const list = (await api('/api/plans')).plans.filter(p => !p.template);
  const today = E.toMin(fmt(new Date())), weekEnd = today + 7 * E.DAY, soon = today + 14 * E.DAY;
  const out = { mine: [], milestones: [], late: [], closeWeek: [] };
  const dow = new Date().getDay();
  for (const meta of list) {  // Friday (or later in the week) with no status for 5+ days, or any day after 9 days
    const endOfWeek = dow >= 5 || dow === 0, age = meta.lastStatus ? (E.toMin(fmt(new Date())) - E.toMin(meta.lastStatus.date)) / E.DAY : null;
    if (age == null ? endOfWeek : endOfWeek ? age >= 5 : age >= 9) out.closeWeek.push({ planId: meta.id, plan: meta.name, last: meta.lastStatus && meta.lastStatus.date });
  }
  for (const meta of list.slice(0, 12)) {
    const p = S.plan && S.plan.id === meta.id ? S.plan : await api('/api/plans/' + meta.id);
    let s;
    try { s = S.plan && S.plan.id === meta.id && S.sched ? S.sched : E.schedule(p, schedOpts()); } catch { continue; }
    const me = (p.resources || []).find(r => r.me);
    for (const t of p.tasks) {
      const r = s.byUid.get(t.uid);
      if (!r || r.summary) continue;
      const item = { plan: p.name, planId: p.id, uid: t.uid, name: t.name, es: r.es, ef: r.ef, pct: r.pct || 0 };
      if (me && (p.assignments || []).some(a => a.taskUid === t.uid && a.resourceUid === me.uid) && r.es < weekEnd && r.ef >= today && (r.pct || 0) < 100) out.mine.push(item);
      if (r.milestone && (r.pct || 0) < 100 && r.ef >= today - 7 * E.DAY && r.ef < soon) out.milestones.push(item);
      if ((r.late || r.missesDeadline) && (r.pct || 0) < 100) out.late.push(item);
    }
  }
  out.mine.sort((a, b) => a.ef - b.ef); out.milestones.sort((a, b) => a.ef - b.ef);
  digestCache = { at: Date.now(), data: out };
  return out;
}
export async function show(planId, uid) {
  if (!S.plan || S.plan.id !== planId) { await loadList(); await openPlan(planId); }
  view.tab = 'plan'; render();
  if (uid != null) setTimeout(() => selectAndShow(uid), 50);
}
export { E as engine, CU as costs, ST as status };
