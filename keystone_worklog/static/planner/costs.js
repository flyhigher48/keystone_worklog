// Keystone – team costs: reading ERP rows, matching people and projects, rates and cost models, planned and
// actual cost on a plan's tasks, earned value, and the status (RAG) rules. Pure functions, no DOM – tested with node.
import * as E from './engine.js';

// ---------- values ----------
/** "1,234.50", "$1,234.50", "(1,234.50)", "1,234.50-", "1.234,50" (decimalComma) → number, or null. */
export function parseNumber(v, decimalComma = false) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').trim();
  if (!s || /^(#n\/a|n\/a|-|—|null|none)$/i.test(s)) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-\s*$/.test(s)) { neg = !neg; s = s.replace(/-\s*$/, ''); }
  s = s.replace(/[\s$€£¥]|USD|EUR|GBP|CAD/gi, '');
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  s = decimalComma ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  if (!/^\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = n => String(n).padStart(2, '0');
function ymd(y, m, d) {
  if (y < 100) y += 2000;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y > 1950 && y < 2200 ? `${y}-${pad(m)}-${pad(d)}` : null;
}
/** A date cell → "YYYY-MM-DD" or null. order: 'mdy' (10/19/2026), 'dmy' (19/10/2026) or 'ymd'. Excel serial numbers work too. */
export function parseDate(v, order = 'mdy') {
  if (typeof v === 'number') {  // Excel's day count (1900 system; Excel thinks 1900 was a leap year, hence Dec 30)
    if (v < 20000 || v > 80000) return null;
    const t = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return t.toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/.exec(s);
  if (m) return order === 'dmy' ? ymd(+m[3], +m[2], +m[1]) : ymd(+m[3], +m[1], +m[2]);
  m = /^(\d{1,2})[-\s]([a-z]{3})[a-z]*\.?[-\s,]+(\d{2}|\d{4})$/.exec(s);  // 19-Oct-2026, 19 Oct 26
  if (m && MONTHS.includes(m[2])) return ymd(+m[3], MONTHS.indexOf(m[2]) + 1, +m[1]);
  m = /^(?:[a-z]+,?\s+)?([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);  // Oct 19, 2026 · Monday, October 19, 2026
  if (m && MONTHS.includes(m[1])) return ymd(+m[3], MONTHS.indexOf(m[1]) + 1, +m[2]);
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseDate(+s, order);
  return null;
}

// ---------- the columns an export can have ----------
export const FIELDS = [
  { k: 'date', label: 'Date worked', need: true, hint: 'The day the work was done – used for progress, rates and splitting hours over tasks', syn: ['work date', 'date worked', 'worked date', 'workdate', 'date of work', 'service date', 'activity date', 'work day', 'date'] },
  { k: 'post', label: 'Posting date', hint: 'When the ERP posted it – decides which earlier lines an export replaces', syn: ['posting date', 'post date', 'posted', 'posted date', 'gl date', 'entry date', 'document date', 'period date'] },
  { k: 'person', label: 'Person (name)', multi: true, hint: 'Pick both columns if the name is split into last and first name', syn: ['employee name', 'name of employee', 'employee', 'name', 'person', 'resource', 'full name', 'last name', 'first name', 'surname', 'given name'] },
  { k: 'emp', label: 'Employee ID', syn: ['employee id', 'employee number', 'employee no', 'emp id', 'emp no', 'empl id', 'personnel number', 'personnel no', 'pers. no.', 'pers.no', 'badge'] },
  { k: 'hours', label: 'Hours', hint: 'Hours charged', syn: ['hours', 'hrs', 'hours charged', 'labor hours', 'total hours', 'quantity', 'qty', 'total quantity'] },
  { k: 'pay', label: 'Pay amount ($)', hint: 'Raw pay (or the dollar amount of a non-labor line)', syn: ['pay amount', 'pay', 'raw pay', 'labor amount', 'labor cost', 'labor $', 'salary', 'wages', 'amount', 'cost', 'value', 'dollars', 'val/coarea crcy'] },
  { k: 'fringe', label: 'Fringe amount ($)', syn: ['fringe amount', 'fringe', 'fringe $', 'fringe cost', 'benefits', 'burden'] },
  { k: 'nwa', label: 'Network / activity', multi: true, hint: 'Sends each row to the project with that NWA. Pick both columns if they\'re separate', syn: ['network', 'activity', 'nwa', 'network activity', 'wbs element', 'wbs', 'charge code', 'charge number', 'project number', 'order'] },
  { k: 'task', label: 'Task / WBS code', hint: 'Puts the hours on a plan task with that WBS code or name', syn: ['task', 'task code', 'task name', 'work package', 'wbs code'] },
  { k: 'payType', label: 'Pay type', hint: 'RG, OT … (overtime multipliers in the cost model)', syn: ['pay type', 'pay code', 'earning code', 'earnings code', 'hour type', 'labor type', 'att./abs. type', 'time type'] },
  { k: 'category', label: 'Cost element / category', hint: 'Labor, travel, materials …', syn: ['cost element', 'cost element name', 'category', 'cost type', 'expense type', 'cost category'] },
  { k: 'doc', label: 'Document / line no.', syn: ['document number', 'document no', 'doc no', 'doc number', 'ref document', 'reference', 'line id', 'line no'] },
  { k: 'desc', label: 'Description', syn: ['description', 'short text', 'text', 'comment', 'remarks', 'name of offsetting account'] },
];
const norm = s => String(s ?? '').toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The header row: the first of the top 30 rows that is mostly text and has at least 3 filled cells. */
export function guessHeaderRow(rows) {
  let best = 0, bestScore = -1;
  for (let i = 0; i < Math.min(30, rows.length); i++) {
    const r = rows[i] || [], filled = r.filter(c => String(c).trim() !== '');
    if (filled.length < Math.min(3, Math.max(1, ...rows.slice(0, 30).map(x => (x || []).filter(c => String(c).trim() !== '').length)))) continue;
    const text = filled.filter(c => typeof c === 'string' && parseNumber(c) == null && !parseDate(c)).length;
    const score = text * 2 - (filled.length - text) * 3 + (FIELDS.some(f => filled.some(c => f.syn.includes(norm(c)))) ? 4 : 0);
    if (score > bestScore) { best = i; bestScore = score; }
    if (text === filled.length && filled.length >= 3) return i;
  }
  return best;
}

/** Pre-fill the mapping from header names: { field: [column index, …] }. */
export function guessMapping(headers) {
  const H = headers.map(norm), used = new Set(), map = {};
  for (const f of FIELDS) {  // exact names first, in each field's order of preference
    for (const syn of f.syn) {
      const idxs = H.map((h, i) => (h === syn && !used.has(i) ? i : -1)).filter(i => i >= 0);
      if (!idxs.length) continue;
      if (f.multi) {
        const all = H.map((h, i) => (f.syn.includes(h) && !used.has(i) ? i : -1)).filter(i => i >= 0);
        const pick = f.k === 'person' && all.length > 1 && all.some(i => /name/.test(H[i]) && !/last|first|surname|given/.test(H[i]))
          ? all.filter(i => /name/.test(H[i]) && !/last|first|surname|given/.test(H[i])).slice(0, 1) : all.slice(0, 2);
        pick.forEach(i => used.add(i)); map[f.k] = pick;
      } else { used.add(idxs[0]); map[f.k] = [idxs[0]]; }
      break;
    }
  }
  for (const f of FIELDS) {  // then headers that contain a name ("Posting Date (GL)")
    if (map[f.k]) continue;
    const i = H.findIndex((h, j) => !used.has(j) && f.syn.some(syn => syn.length > 3 && h.includes(syn)));
    if (i >= 0) { used.add(i); map[f.k] = [i]; }
  }
  return map;
}

/** A saved layout (column names per field) applied to this export's headers → { map, missing }. */
export function applyLayout(layout, headers) {
  const H = headers.map(norm), map = {}, missing = [];
  for (const [k, names] of Object.entries(layout.fields || {})) {
    const idx = (names || []).map(n => H.indexOf(norm(n)));
    if (idx.some(i => i < 0)) missing.push(...(names || []).filter((_, j) => idx[j] < 0));
    const ok = idx.filter(i => i >= 0);
    if (ok.length) map[k] = ok;
  }
  return { map, missing };
}
/** The mapping as a layout: column names, so it works when the ERP reorders columns. */
export function layoutFields(map, headers) {
  const out = {};
  for (const [k, idx] of Object.entries(map)) if (idx && idx.length) out[k] = idx.map(i => String(headers[i] ?? ''));
  return out;
}
/** Does a layout fit these headers? (every column it names is there) */
export const layoutFits = (layout, headers) => !applyLayout(layout, headers).missing.length && Object.keys(layout.fields || {}).length > 0;

/** Rows → charge lines. Returns { lines, errors: [{row, text}], skipped }. Row numbers are 1-based, as in Excel. */
export function extractLines(rows, headerRow, map, opts = {}) {
  const order = opts.dateOrder || 'mdy', dc = !!opts.decimalComma, lines = [], errors = [];
  let skipped = 0;
  const cells = (r, k) => (map[k] || []).map(i => r[i]).filter(v => v !== '' && v != null);
  const text = (r, k) => cells(r, k).map(v => String(v).trim()).join(' ').trim();
  for (let i = headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some(c => String(c ?? '').trim() !== '')) continue;
    const rowNo = i + 1;
    const date = parseDate(cells(r, 'date')[0], order), post = map.post ? parseDate(cells(r, 'post')[0], order) : null;
    if (!date) {
      if (r.some(c => /total|sum|grand/i.test(String(c)))) { skipped++; continue; }  // a totals line
      if (cells(r, 'date').length) errors.push({ row: rowNo, text: `“${cells(r, 'date')[0]}” isn't a date` });
      else skipped++;
      continue;
    }
    const num = k => { const v = cells(r, k)[0]; if (v == null) return null; const n = parseNumber(v, dc); if (n == null) errors.push({ row: rowNo, text: `${k}: “${v}” isn't a number` }); return n; };
    const hours = num('hours'), pay = num('pay'), fringe = num('fringe');
    if (hours == null && pay == null) { errors.push({ row: rowNo, text: 'no hours or amount' }); continue; }
    const line = { row: rowNo, date, post: post || date };
    if (hours != null) line.hours = hours;
    if (pay != null) line.pay = pay;
    if (fringe != null) line.fringe = fringe;
    const nm = text(r, 'person'), emp = text(r, 'emp');
    if (nm) line.name = nm;
    if (emp) line.emp = emp;
    if (map.nwa) line.nwa = cells(r, 'nwa').map(v => String(v).trim()).join('|');
    for (const k of ['task', 'payType', 'category', 'doc', 'desc']) { const v = text(r, k); if (v) line[k] = v; }
    lines.push(line);
  }
  return { lines, errors, skipped };
}
export const isLabor = l => !!(l.name || l.emp || (l.hours && l.hours !== 0));

// ---------- people ----------
/** "LOPEZ, MARIA", "Maria Lopez", "lopez maria" → the same key. */
export const nameKey = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
export function personIndex(dir) {
  const byEmp = new Map(), byKey = new Map(), byId = new Map();
  for (const p of (dir && dir.people) || []) {
    byId.set(p.id, p);
    if (p.employeeId) byEmp.set(String(p.employeeId).trim().replace(/^0+/, ''), p);
    for (const n of [p.name, ...(p.aliases || [])]) if (n) byKey.set(nameKey(n), p);
  }
  return { byEmp, byKey, byId };
}
/** The directory person for a charge line (employee ID first, then the name or an alias), or null. */
export function matchPerson(index, name, emp) {
  if (emp) { const p = index.byEmp.get(String(emp).trim().replace(/^0+/, '')); if (p) return p; }
  if (name) return index.byKey.get(nameKey(name)) || null;
  return null;
}
/** The directory person behind a plan resource. */
export function personOfResource(dir, index, res) {
  return (res.personId && index.byId.get(res.personId)) || index.byKey.get(nameKey(res.name)) || (res.me ? ((dir && dir.people) || []).find(p => p.me) : null) || null;
}

// ---------- projects ----------
const nwaTokens = s => String(s ?? '').split(/[^0-9A-Za-z]+/).filter(Boolean).map(t => t.replace(/^0+(?=\d)/, '').toLowerCase());
/** The project an NWA cell belongs to ("4001234-0010", "4001234 / 10", or network|activity from two columns). */
export function matchProject(projects, text) {
  const toks = nwaTokens(text);
  if (!toks.length) return null;
  const has = v => v && toks.includes(String(v).trim().replace(/^0+(?=\d)/, '').toLowerCase());
  const full = projects.filter(p => has(p.network) && has(p.activity));
  if (full.length === 1) return full[0];
  if (full.length > 1) return full.find(p => toks[0] === String(p.network).trim().replace(/^0+(?=\d)/, '').toLowerCase()) || full[0];
  const net = projects.filter(p => has(p.network));
  return net.length === 1 && toks.length === 1 ? net[0] : null;
}
export const nwaKey = p => `${String(p.network || '').trim()}|${String(p.activity || '').trim()}`;

// ---------- rates and cost models ----------
export const DEFAULT_MODEL = { id: '', name: 'ERP amounts as they are', base: 'erp', fringePct: 0, adders: [], payTypes: {}, nonLaborPct: 0 };
const pickDated = (list, date) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => String(a.from || '').localeCompare(String(b.from || '')));
  return s.filter(r => !r.from || r.from <= date).pop() || s[0];
};
/** Pay rate per hour for a person on a date: their own card, their category's, what the ERP shows they cost, the default. */
export function rateFor(dir, person, date, observed) {
  const rates = (dir && dir.rates) || [];
  if (person) {
    const own = pickDated(rates.filter(r => r.who === person.id), date);
    if (own) return { rate: +own.base || 0, src: 'person' };
    if (person.category) { const cat = pickDated(rates.filter(r => r.who === 'cat:' + person.category), date); if (cat) return { rate: +cat.base || 0, src: 'category' }; }
    const o = observed && observed.get(person.id);
    if (o && o.rate) return { rate: o.rate, src: 'erp', fringeRatio: o.fringeRatio };
  }
  const def = pickDated(rates.filter(r => r.who === 'default'), date);
  return def ? { rate: +def.base || 0, src: 'default' } : { rate: 0, src: null };
}
/** What each person costs on average according to the ERP lines (pay per hour, fringe per pay dollar). */
export function observedRates(lines, index) {
  const acc = new Map();
  for (const l of lines) {
    const p = matchPerson(index, l.name, l.emp);
    if (!p || !(l.hours > 0) || l.pay == null) continue;
    const a = acc.get(p.id) || { h: 0, pay: 0, fringe: 0, f: 0 };
    a.h += l.hours; a.pay += l.pay; if (l.fringe != null) { a.fringe += l.fringe; a.f += l.pay; }
    acc.set(p.id, a);
  }
  const out = new Map();
  for (const [id, a] of acc) if (a.h > 0 && a.pay > 0) out.set(id, { rate: a.pay / a.h, fringeRatio: a.f ? a.fringe / a.f : null });
  return out;
}
const adderOn = (a, date) => !a.from || a.from <= date;
function addOn(model, date, hours, pay, fringe) {
  let running = pay + fringe;
  const adds = [];
  for (const a of model.adders || []) {
    if (!adderOn(a, date)) continue;
    const v = +a.value || 0;
    const amt = a.kind === 'pctPay' ? pay * v / 100 : a.kind === 'pctBase' ? (pay + fringe) * v / 100 : a.kind === 'perHour' ? (hours || 0) * v : running * v / 100;
    adds.push({ name: a.name || 'Charge', amt });
    running += amt;
  }
  return { adds, total: running };
}
/**
 * The full cost of one charge line.
 * base 'erp': the ERP pay (+ its fringe column, or fringe % when there is none) plus the model's charges.
 * base 'rate': hours × the person's rate (× the pay-type multiplier) + fringe % plus the model's charges.
 * Lines without a person or hours (travel, materials …) take the non-labor %.
 */
export function lineCost(line, ctx) {
  const model = ctx.model || DEFAULT_MODEL, person = ctx.person || null;
  if (!isLabor(line)) {
    const amt = (line.pay || 0) + (line.fringe || 0), extra = amt * (+model.nonLaborPct || 0) / 100;
    return { labor: false, pay: amt, fringe: 0, adds: extra ? [{ name: 'Non-labor charge', amt: extra }] : [], total: amt + extra, src: 'erp' };
  }
  let pay, fringe, src = 'erp', missing = false;
  if (model.base !== 'rate' && line.pay != null) {
    pay = line.pay;
    fringe = line.fringe != null ? line.fringe : pay * (+model.fringePct || 0) / 100;
  } else {
    const r = rateFor(ctx.dir, person, line.date, ctx.observed), mult = +((model.payTypes || {})[String(line.payType || '').toUpperCase()] ?? 1) || 1;
    src = r.src; missing = !r.src;
    pay = (line.hours || 0) * r.rate * mult;
    fringe = pay * (r.src === 'erp' && r.fringeRatio != null && model.base !== 'rate' ? r.fringeRatio * 100 : +model.fringePct || 0) / 100;
  }
  const { adds, total } = addOn(model, line.date, line.hours, pay, fringe);
  return { labor: true, pay, fringe, adds, total, src, missing };
}
/** Full cost of one planned hour for a person on a date (planning always uses rates: the ERP has no future). */
export function hourlyCost(ctx, person, date) {
  const model = ctx.model || DEFAULT_MODEL, r = rateFor(ctx.dir, person, date, ctx.observed);
  if (!r.src) return { cost: 0, src: null };
  const fr = r.src === 'erp' && r.fringeRatio != null ? r.fringeRatio : (+model.fringePct || 0) / 100;
  const pay = r.rate, fringe = pay * fr;
  return { cost: addOn(model, date, 1, pay, fringe).total, src: r.src, rate: r.rate };
}
/** The cost model as one multiplier on pay (for showing "3.19 × base"). Only exact for % charges. */
export function multiplier(model, date = '2100-01-01') {
  return addOn(model, date, 0, 1, (+model.fringePct || 0) / 100).total;
}

// ---------- a plan's costs ----------
const dayOf = t => Math.floor(t / E.DAY);
/** Each leaf task's planned work per person per day: [{ uid, resUid, day, minutes }]. */
export function plannedWork(plan, sched) {
  const out = [];
  const leafs = new Set(plan.tasks.filter(t => { const r = sched.byUid.get(t.uid); return r && !r.summary && !r.milestone; }).map(t => t.uid));
  const assigned = new Set();
  for (const as of plan.assignments || []) {
    const r = sched.byUid.get(as.taskUid);
    if (!r || !leafs.has(as.taskUid)) continue;
    assigned.add(as.taskUid);
    const total = E.workBetween(sched.calendar, r.es, r.ef) || 1, work = as.workMinutes ?? r.dur * (as.units ?? 1);
    for (let d = dayOf(r.es); d <= dayOf(r.ef - 1); d++) {
      const w = E.workIn(sched, as.taskUid, d * E.DAY, (d + 1) * E.DAY);
      if (w > 0) out.push({ uid: as.taskUid, resUid: as.resourceUid, day: d, minutes: w * work / total });
    }
  }
  for (const uid of leafs) {  // tasks nobody is assigned to still take work (costed at the default rate)
    if (assigned.has(uid)) continue;
    const r = sched.byUid.get(uid);
    for (let d = dayOf(r.es); d <= dayOf(r.ef - 1); d++) {
      const w = E.workIn(sched, uid, d * E.DAY, (d + 1) * E.DAY);
      if (w > 0) out.push({ uid, resUid: null, day: d, minutes: w });
    }
  }
  return out;
}
/** Context for a plan: directory, index, model, observed rates, resource → person. */
export function planContext(plan, dir, model, ledgerLines = []) {
  const index = personIndex(dir), observed = observedRates(ledgerLines, index);
  const resPerson = new Map((plan.resources || []).map(r => [r.uid, personOfResource(dir, index, r)]));
  return { dir, index, model: model || DEFAULT_MODEL, observed, resPerson };
}
/** Planned cost and hours: per task (current schedule), and per day (for the forecast). */
export function plannedCost(plan, sched, ctx) {
  const byTask = new Map(), hoursByTask = new Map(), byDay = new Map(), missing = new Set();
  const cache = new Map();
  for (const w of plannedWork(plan, sched)) {
    const person = w.resUid != null ? ctx.resPerson.get(w.resUid) : null, date = E.dateOf(w.day * E.DAY);
    const key = (person ? person.id : '-') + date.slice(0, 7);  // rates change by date; a month is fine-grained enough for planning
    let hc = cache.get(key);
    if (!hc) { hc = hourlyCost(ctx, person, date); cache.set(key, hc); }
    if (!hc.src) missing.add(person ? person.name : '(unassigned)');
    const hrs = w.minutes / 60, c = hrs * hc.cost;
    byTask.set(w.uid, (byTask.get(w.uid) || 0) + c);
    hoursByTask.set(w.uid, (hoursByTask.get(w.uid) || 0) + hrs);
    byDay.set(w.day, (byDay.get(w.day) || 0) + c);
  }
  return { byTask, hoursByTask, byDay, missing: [...missing] };
}
/** Add baseline n's cost to every leaf task (call right after setting baseline n). */
export function baselineCosts(plan, sched, ctx, n) {
  const pc = plannedCost(plan, sched, ctx);
  for (const t of plan.tasks) {
    const b = (t.baselines || {})[n];
    if (b) { b.cost = Math.round((pc.byTask.get(t.uid) || 0) * 100) / 100; b.hours = Math.round((pc.hoursByTask.get(t.uid) || 0) * 100) / 100; }
  }
  return pc;
}

/**
 * Put the ERP lines (and your own not-yet-posted timesheet hours) on the plan's tasks:
 * 1. the task column, when it names a task (WBS code or name);
 * 2. the tasks that person was scheduled on that day, split by their planned hours;
 * 3. the NWA's tasks scheduled that day;
 * 4. otherwise "not assigned to a task".
 * Returns { byTask: Map uid → {hours, cost}, unassigned: [{line, cost}], lines: [{line, cost, person}] , total }.
 */
export function allocateActuals(plan, sched, ctx, lines, opts = {}) {
  const work = plannedWork(plan, sched), status = opts.until || null;
  const byResDay = new Map(), byDay = new Map();
  for (const w of work) {
    if (w.resUid != null) { const k = w.resUid + ':' + w.day; (byResDay.get(k) || byResDay.set(k, []).get(k)).push(w); }
    (byDay.get(w.day) || byDay.set(w.day, []).get(w.day)).push(w);
  }
  const resOfPerson = new Map();
  for (const [ru, p] of ctx.resPerson) if (p) (resOfPerson.get(p.id) || resOfPerson.set(p.id, []).get(p.id)).push(ru);
  const nwaTasks = new Set(plan.tasks.filter(t => t.nwa && (!opts.nwa || t.nwa === opts.nwa)).map(t => t.uid));
  const taskByCode = new Map();
  for (const t of plan.tasks) {
    for (const c of [t.wbs, sched.outline && sched.outline.wbs && sched.outline.wbs.get(t.uid), t.name, ...((t.erpCodes) || [])]) if (c) taskByCode.set(String(c).trim().toLowerCase(), t.uid);
  }
  const byTask = new Map(), unassigned = [], out = [];
  let total = 0, hours = 0;
  const put = (uid, h, c) => { const a = byTask.get(uid) || { hours: 0, cost: 0 }; a.hours += h; a.cost += c; byTask.set(uid, a); };
  for (const line of lines) {
    if (status && line.date > status) continue;
    const person = line.personId ? ctx.index.byId.get(line.personId) : matchPerson(ctx.index, line.name, line.emp);
    const c = lineCost(line, { ...ctx, person }).total, h = line.hours || 0;
    total += c; hours += h;
    out.push({ line, cost: c, person });
    let shares = null;
    const code = line.task && taskByCode.get(String(line.task).trim().toLowerCase());
    if (code != null) shares = [[code, 1]];
    const day = dayOf(E.toMin(line.date));
    if (!shares && person) {
      const ws = (resOfPerson.get(person.id) || []).flatMap(ru => byResDay.get(ru + ':' + day) || []);
      if (ws.length) shares = ws.map(w => [w.uid, w.minutes]);
    }
    if (!shares) {
      const ws = (byDay.get(day) || []).filter(w => !nwaTasks.size || nwaTasks.has(w.uid));
      if (ws.length) shares = ws.map(w => [w.uid, w.minutes]);
    }
    if (!shares) { unassigned.push({ line, cost: c, person }); continue; }
    const tot = shares.reduce((s, [, w]) => s + w, 0) || 1;
    for (const [uid, w] of shares) put(uid, h * w / tot, c * w / tot);
  }
  return { byTask, unassigned, lines: out, total, hours };
}
/** Roll leaf values up to summary tasks. */
export function rollup(plan, sched, map, pick = v => v) {
  const kids = sched.outline.kids, out = new Map();
  const go = uid => {
    const r = sched.byUid.get(uid);
    if (r && r.summary) { let s = 0; for (const k of kids.get(uid) || []) s += go(k); out.set(uid, s); return s; }
    const v = map.get(uid); const n = v == null ? 0 : pick(v); out.set(uid, n); return n;
  };
  for (const u of kids.get(null) || []) go(u);
  return out;
}

// ---------- earned value ----------
/**
 * Earned value as of `status` (minutes). Uses baseline n's cost and dates; with no baseline, the current plan.
 * actual: total actual cost (or hours) as of the costs date. remaining: bottom-up cost still to come.
 */
export function earnedValue(plan, sched, n, status, actual, remaining, unit = 'cost') {
  let bac = 0, pv = 0, ev = 0, usedBaseline = false;
  for (const t of plan.tasks) {
    const r = sched.byUid.get(t.uid);
    if (!r || r.summary) continue;
    const b = (t.baselines || {})[n];
    const val = b && (unit === 'cost' ? b.cost : b.hours);
    if (val == null) continue;
    usedBaseline = true;
    bac += val;
    const bs = E.toMin(b.start), bf = E.toMin(b.finish);
    const frac = status >= bf ? 1 : status <= bs ? 0 : (E.workBetween(sched.calendar, bs, status) / (E.workBetween(sched.calendar, bs, bf) || 1));
    pv += val * frac;
    ev += val * (r.pct || 0) / 100;
  }
  return { usedBaseline, ...evMetrics({ bac, pv, ev, ac: actual, etc: remaining }) };
}
/** The standard formulas. */
export function evMetrics({ bac, pv, ev, ac, etc }) {
  const spi = pv ? ev / pv : null, cpi = ac ? ev / ac : null;
  const eac = cpi ? ac + (bac - ev) / cpi : null;
  return {
    bac, pv, ev, ac, sv: ev - pv, cv: ev - ac, spi, cpi,
    eac, eacPlan: ac + (bac - ev), eacBottomUp: etc != null ? ac + etc : null,
    vac: eac != null ? bac - eac : null, tcpi: bac - ac ? (bac - ev) / (bac - ac) : null,
  };
}
/** Planned value per day from baseline n (for the S-curve): Map day → value added that day. */
export function baselineCurve(plan, sched, n, unit = 'cost') {
  const out = new Map(), cal = sched.calendar;
  for (const t of plan.tasks) {
    const r = sched.byUid.get(t.uid), b = (t.baselines || {})[n];
    const val = b && (unit === 'cost' ? b.cost : b.hours);
    if (!r || r.summary || !val) continue;
    const bs = E.toMin(b.start), bf = E.toMin(b.finish), tot = E.workBetween(cal, bs, bf);
    if (!tot) { out.set(dayOf(bf), (out.get(dayOf(bf)) || 0) + val); continue; }
    for (let d = dayOf(bs); d <= dayOf(bf - 1); d++) {
      const w = E.workBetween(cal, Math.max(bs, d * E.DAY), Math.min(bf, (d + 1) * E.DAY));
      if (w > 0) out.set(d, (out.get(d) || 0) + val * w / tot);
    }
  }
  return out;
}
/** Cumulative series from a Map day → amount, over the days [from, to]. */
export function cumulative(byDay, from, to) {
  const out = [];
  let s = 0;
  for (const [d, v] of byDay) if (d < from) s += v;
  for (let d = from; d <= to; d++) { s += byDay.get(d) || 0; out.push(s); }
  return out;
}
/** The date the money runs out: actual cost so far, then the plan's remaining cost day by day. */
export function runOut(budget, actual, plannedByDay, fromDay) {
  if (!budget) return null;
  if (actual >= budget) return fromDay;
  let s = actual;
  for (const d of [...plannedByDay.keys()].filter(d => d > fromDay).sort((a, b) => a - b)) {
    s += plannedByDay.get(d);
    if (s > budget) return d;
  }
  return null;
}

// ---------- status (RAG) ----------
export const RAG_RULES = { spiAmber: 0.95, spiRed: 0.85, cpiAmber: 0.95, cpiRed: 0.85, slipAmber: 5, slipRed: 15 };
const worst = (...xs) => xs.includes('red') ? 'red' : xs.includes('amber') ? 'amber' : 'green';
/** Suggested red/amber/green from the numbers, with the reason for each. */
export function suggestRag(m, rules = RAG_RULES) {
  const why = {};
  let schedule = 'green', cost = 'green', scope = 'green';
  if (m.spi != null && m.spi < rules.spiRed) { schedule = 'red'; why.schedule = `SPI ${m.spi.toFixed(2)} (below ${rules.spiRed})`; }
  else if (m.spi != null && m.spi < rules.spiAmber) { schedule = 'amber'; why.schedule = `SPI ${m.spi.toFixed(2)} (below ${rules.spiAmber})`; }
  if (m.slipDays != null && m.slipDays >= rules.slipRed) { schedule = 'red'; why.schedule = [why.schedule, `finish moved ${m.slipDays} working days`].filter(Boolean).join('; '); }
  else if (m.slipDays != null && m.slipDays >= rules.slipAmber) { schedule = worst(schedule, 'amber'); why.schedule = [why.schedule, `finish moved ${m.slipDays} working days`].filter(Boolean).join('; '); }
  if (m.cpi != null && m.cpi < rules.cpiRed) { cost = 'red'; why.cost = `CPI ${m.cpi.toFixed(2)} (below ${rules.cpiRed})`; }
  else if (m.cpi != null && m.cpi < rules.cpiAmber) { cost = 'amber'; why.cost = `CPI ${m.cpi.toFixed(2)} (below ${rules.cpiAmber})`; }
  if (m.budget && m.eac != null && m.eac > m.budget) { cost = worst(cost, m.eac > m.budget * 1.1 ? 'red' : 'amber'); why.cost = [why.cost, `forecast ${Math.round(m.eac).toLocaleString()} is over the ${Math.round(m.budget).toLocaleString()} budget`].filter(Boolean).join('; '); }
  if (m.openChanges) { scope = 'amber'; why.scope = `${m.openChanges} open change request${m.openChanges > 1 ? 's' : ''}`; }
  return { overall: worst(schedule, cost, scope), schedule, cost, scope, why };
}

// ---------- estimates per task: typed hours, a budget, remaining and forecast ----------
/** Hours typed for a task → its duration in minutes. Effort-driven, like MS Project with fixed units:
 *  120 h with Maria (100%) and Priya (50%) takes 120 ÷ 1.5 = 80 working hours. */
export function durationForWork(workMinutes, assignments = []) {
  const units = assignments.reduce((s, a) => s + (a.units ?? 1), 0);
  return Math.max(0, Math.round(units > 0 ? workMinutes / units : workMinutes));
}
/**
 * Each task against its estimates. Hours: baseline (the original estimate), planned (the current estimate – what you
 * typed, or duration × people), actual, remaining and forecast (actual + planned × the part not done). The budget is a
 * separate check next to the cost from rates: a summary's budget is its own when set, otherwise the sum of its tasks'
 * budgets – and then it's compared only with the tasks that have one.
 * planned: plannedCost(); actual: allocateActuals().byTask. Returns Map uid → numbers.
 */
export function taskChecks(plan, sched, planned, actual, n = 0) {
  const own = t => t && t.budget != null && t.budget !== '' && Number.isFinite(+t.budget) ? +t.budget : null;
  const byUid = new Map(plan.tasks.map(t => [t.uid, t]));
  const KEYS = ['plannedH', 'actualH', 'remainingH', 'forecastH', 'plannedC', 'actualC', 'remainingC', 'forecastC'];
  const out = new Map(), kids = sched.outline.kids;
  const go = uid => {
    const r = sched.byUid.get(uid), t = byUid.get(uid);
    if (!r) return null;
    let x;
    if (!r.summary) {
      const left = 1 - Math.min(100, r.pct || 0) / 100, a = actual.get(uid) || { hours: 0, cost: 0 }, b = (t.baselines || {})[n] || {};
      const pH = planned.hoursByTask.get(uid) || 0, pC = planned.byTask.get(uid) || 0;
      x = { plannedH: pH, actualH: a.hours, remainingH: pH * left, forecastH: a.hours + pH * left, baselineH: b.hours ?? null,
        plannedC: pC, actualC: a.cost, remainingC: pC * left, forecastC: a.cost + pC * left, baselineC: b.cost ?? null, budget: own(t) };
      x.coveredF = x.budget != null ? x.forecastC : 0; x.coveredA = x.budget != null ? x.actualC : 0;
    } else {
      x = Object.fromEntries(KEYS.map(k => [k, 0]));
      let bsum = null, bl = null, bh = null, cf = 0, ca = 0;
      for (const k of kids.get(uid) || []) {
        const c = go(k);
        if (!c) continue;
        for (const key of KEYS) x[key] += c[key] || 0;
        if (c.budget != null) bsum = (bsum || 0) + c.budget;
        if (c.baselineC != null) bl = (bl || 0) + c.baselineC;
        if (c.baselineH != null) bh = (bh || 0) + c.baselineH;
        cf += c.coveredF; ca += c.coveredA;
      }
      x.baselineC = bl; x.baselineH = bh;
      if (own(t) != null) { x.budget = own(t); x.coveredF = x.forecastC; x.coveredA = x.actualC; }
      else { x.budget = bsum; x.budgetFromTasks = bsum != null; x.coveredF = cf; x.coveredA = ca; }
    }
    x.estimateH = x.plannedH;
    x.budgetLeft = x.budget != null ? x.budget - x.coveredA : null;
    x.budgetForecast = x.budget != null ? x.coveredF : null;   // the forecast of what the budget covers
    x.overBudget = x.budget != null && x.coveredF > x.budget + 0.5;
    x.overHours = x.plannedH > 0 && x.forecastH > x.plannedH * 1.001 + 0.05;
    out.set(uid, x);
    return x;
  };
  for (const u of kids.get(null) || []) go(u);
  return out;
}
