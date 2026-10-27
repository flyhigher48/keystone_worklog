// Keystone – team costs in the page: People & rates (Settings), importing an ERP export, a project's costs,
// and the plan's Costs view with earned value. The maths is in costs.js; helpers (h, api, state…) are global.
import * as C from './costs.js';
import * as E from './engine.js';
import { planner as S, nwaHours, rowIds, taskOf, change, redraw, fmtDate, descendants } from './ui.js';

/** replaceChildren, but arrays are flattened and null/false skipped – like h(). */
export const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));

// ---------- the people directory (data/people.json) ----------
export const D = { doc: null, loading: null };
const blankDoc = () => ({ rev: 0, people: [], rates: [], costModels: [], layouts: [], settings: { currency: '$', dateOrder: 'mdy' } });
export async function loadDir(force = false) {
  if (D.doc && !force) return D.doc;
  D.loading ||= api('/api/people').then(d => { D.doc = { ...blankDoc(), ...d, settings: { ...blankDoc().settings, ...(d.settings || {}) } }; D.loading = null; return D.doc; })
    .catch(e => { D.loading = null; throw e; });
  return D.loading;
}
let saveTimer = null, saving = Promise.resolve();
export function saveDir(delay = 400) {
  clearTimeout(saveTimer);
  return new Promise(res => {
    saveTimer = setTimeout(() => {
      saving = saving.then(async () => {
        try { const j = await api('/api/people', { doc: D.doc, baseRev: D.doc.rev }, 'PUT'); D.doc.rev = j.rev; memo = null; }
        catch (e) {
          if (e.status === 409) { D.doc = { ...blankDoc(), ...e.body.doc }; toast('People & rates were changed in another tab – reloaded them. Make your change again.'); }
          else toast('Couldn\'t save people & rates: ' + e.message);
        }
        res();
      });
    }, delay);
  });
}
const newId = p => p + Math.random().toString(16).slice(2, 10);
export const cur = () => (D.doc && D.doc.settings.currency) || '$';
export function money(n, dp = 0) {
  if (n == null || !Number.isFinite(n)) return '–';
  return (n < 0 ? '−' : '') + cur() + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
const hrsTxt = n => n == null ? '–' : `${(Math.round(n * 10) / 10).toLocaleString()} h`;
const pctTxt = n => n == null || !Number.isFinite(n) ? '–' : `${Math.round(n * 100)}%`;
const idx2 = n => n == null || !Number.isFinite(n) ? '–' : n.toFixed(2);
export function modelFor(project) {
  const ms = (D.doc && D.doc.costModels) || [];
  return (project && ms.find(m => m.id === project.costModelId)) || ms.find(m => m.isDefault) || ms[0] || C.DEFAULT_MODEL;
}
export const meInDir = () => ((D.doc && D.doc.people) || []).find(p => p.me) || null;

/** Plan resources point at directory people (by name or alias); unknown names are added to the directory. */
export async function linkPeople(plan) {
  await loadDir();
  const ix = C.personIndex(D.doc);
  let changedPlan = false, changedDir = false;
  for (const r of plan.resources || []) {
    if (r.personId && ix.byId.has(r.personId)) continue;
    let p = C.personOfResource(D.doc, ix, r);
    if (!p) {
      p = { id: newId('pe_'), name: r.name, aliases: [], employeeId: '', category: '', maxUnits: r.maxUnits ?? 1, away: [], me: !!r.me && !meInDir(), active: true };
      D.doc.people.push(p); ix.byId.set(p.id, p); ix.byKey.set(C.nameKey(p.name), p); changedDir = true;
    }
    r.personId = p.id; changedPlan = true;
  }
  if (changedDir) await saveDir(0);
  return changedPlan;
}

// ---------- ledgers (data/costs/<projectId>.json) ----------
const L = new Map();
export async function loadLedger(pid, force = false) {
  if (!pid) return null;
  if (L.has(pid) && !force) return L.get(pid);
  const led = await api('/api/costs/' + encodeURIComponent(pid));
  L.set(pid, led); memo = null;
  return led;
}
export const ledgerOf = pid => L.get(pid) || null;
const projectById = id => state.projects.find(p => p.id === id);

// ---------- a plan's costs (cached per schedule) ----------
let memo = null;
/** Everything the Costs view, the grid and the dashboard need. Null until the directory (and ledger) are loaded. */
export function planCosts() {
  const p = S.plan;
  if (!p || !S.sched || !D.doc) return null;
  const proj = p.projectId ? projectById(p.projectId) : null, led = proj ? L.get(proj.id) : null;
  if (proj && !led) return null;
  const key = [S.sched, D.doc.rev, led && led.rev, S.baselineN, p.statusDate];
  if (memo && memo.key.every((v, i) => v === key[i])) return memo.data;
  const model = modelFor(proj), planStart = E.dateOf(S.sched.start);
  const erp = (led ? led.lines : []).filter(l => l.date >= planStart);
  const before = (led ? led.lines : []).filter(l => l.date < planStart);
  const ctx = C.planContext(p, D.doc, model, led ? led.lines : []);
  const planned = C.plannedCost(p, S.sched, ctx);
  const me = meInDir(), posted = led ? led.postedThrough : null, extra = [];
  if (proj && me) for (const [d, hh] of Object.entries(nwaHours()[C.nwaKey(proj)] || {})) if (d >= planStart && (!posted || d > posted)) extra.push({ date: d, post: d, hours: hh, personId: me.id, name: me.name, unposted: true });
  const actual = C.allocateActuals(p, S.sched, ctx, [...erp, ...extra], { nwa: proj ? C.nwaKey(proj) : null });
  const statusMin = E.toMin(p.statusDate) ?? E.toMin(fmt(new Date())) + 17 * 60;
  let remCost = 0, remHours = 0;
  for (const t of p.tasks) {
    const r = S.sched.byUid.get(t.uid);
    if (!r || r.summary) continue;
    const left = 1 - (r.pct || 0) / 100;
    remCost += (planned.byTask.get(t.uid) || 0) * left; remHours += (planned.hoursByTask.get(t.uid) || 0) * left;
  }
  const ev = C.earnedValue(p, S.sched, S.baselineN, statusMin, actual.total, remCost, 'cost');
  const evH = C.earnedValue(p, S.sched, S.baselineN, statusMin, actual.hours, remHours, 'hours');
  const budget = proj ? num(proj.budgetAmount) || 0 : 0;  // contingency is tracked separately, not spent by default
  const statusDay = Math.floor(statusMin / E.DAY);
  const unposted = actual.lines.filter(x => x.line.unposted);
  // the budget is for the whole NWA: charges from before the plan started count against it (not in earned value)
  const beforeCost = before.reduce((t, l) => t + C.lineCost(l, { ...ctx, person: C.matchPerson(ctx.index, l.name, l.emp) }).total, 0);
  const projectTotal = actual.total + beforeCost;
  const warnings = [];
  // the ERP lags: what matters for earned value is the last day of *work* it covers, not the posting date
  const workThrough = erp.reduce((m, l) => (l.date > m ? l.date : m), '') || null;
  if (workThrough && Math.abs(E.toMin(workThrough) - statusMin) / E.DAY > 7) warnings.push({ kind: 'dates', date: workThrough, text: `The ERP charges cover work up to ${workThrough}${posted && posted !== workThrough ? ` (posted through ${posted})` : ''}, but progress is as of ${E.dateOf(statusMin)} – so CPI and SPI compare different dates.` });
  if (planned.missing.length) warnings.push({ kind: 'rates', text: `No rate for ${planned.missing.slice(0, 4).join(', ')}${planned.missing.length > 4 ? '…' : ''} – planned cost counts them as $0. Add rates in Settings → People & rates.` });
  const data = {
    proj, led, model, ctx, planned, actual, ev, evH, budget, posted, workThrough, before, beforeCost, projectTotal, unposted, statusMin, statusDay, warnings,
    runOut: budget ? C.runOut(budget, projectTotal, planned.byDay, statusDay) : C.runOut(ev.bac, actual.total, planned.byDay, statusDay),
    roll: {
      planned: C.rollup(p, S.sched, planned.byTask), plannedH: C.rollup(p, S.sched, planned.hoursByTask),
      actual: C.rollup(p, S.sched, actual.byTask, v => v.cost), actualH: C.rollup(p, S.sched, actual.byTask, v => v.hours),
      baseline: C.rollup(p, S.sched, new Map(p.tasks.map(t => [t.uid, ((t.baselines || {})[S.baselineN] || {}).cost]).filter(([, v]) => v != null))),
    },
  };
  memo = { key, data };
  return data;
}
/** Load what planCosts() needs, then redraw. */
export async function ensurePlanCosts() {
  const p = S.plan;
  if (!p) return;
  await loadDir();
  if (p.projectId && projectById(p.projectId)) await loadLedger(p.projectId);
}
/** Called right after a baseline is set: store each task's planned cost (and hours) with it. */
export function stampBaselineCost(plan, sched, n) {
  if (!D.doc) return;
  const proj = plan.projectId ? projectById(plan.projectId) : null, led = proj ? L.get(proj.id) : null;
  C.baselineCosts(plan, sched, C.planContext(plan, D.doc, modelFor(proj), led ? led.lines : []), n);
}

// ---------- the Costs view in the Plan tab ----------
export function costsView(A) {
  const pc = planCosts();
  if (!pc) {
    ensurePlanCosts().then(() => A.redraw()).catch(e => toast(e.message));
    return h('section', { class: 'card pl-view' }, h('p', { class: 'hint' }, 'Loading costs…'));
  }
  const p = S.plan, unit = S.costUnit || 'cost', ev = unit === 'cost' ? pc.ev : pc.evH, fmtV = unit === 'cost' ? (n => money(n)) : hrsTxt;
  const tile = (label, value, sub, cls = '') => h('div', { class: 'card tile' }, h('div', { class: 'lbl' }, label), h('div', { class: 'big ' + cls }, value), sub ? h('div', { class: 'foot' }, sub) : null);
  const tone = (x, a = 0.95, r = 0.85) => x == null ? '' : x < r ? 'neg' : x < a ? 'warnc' : 'pos';
  const bars = [];
  if (!pc.proj) bars.push(h('div', { class: 'duebar' }, icon('bell'), h('div', { class: 'txt' }, 'This plan isn\'t linked to a project, so there are no ERP costs yet. Planned cost uses the rates in People & rates.'),
    h('button', { class: 'btn', onclick: () => A.linkProject() }, 'Link to a project…')));
  for (const w of pc.warnings) bars.push(h('div', { class: 'duebar' }, icon('bell'), h('div', { class: 'txt' }, w.text),
    w.kind === 'dates' ? h('button', { class: 'btn', onclick: () => change('Status date = costs date', pl => { pl.statusDate = w.date + 'T17:00'; }) }, `Use ${w.date} as the status date`) : null,
    w.kind === 'rates' ? h('button', { class: 'btn', onclick: () => { view.tab = 'settings'; view.settingsFocus = 'people'; render(); } }, 'People & rates') : null));
  const hasBaseline = p.tasks.some(t => (t.baselines || {})[S.baselineN]);
  if (hasBaseline && !ev.usedBaseline) bars.push(h('div', { class: 'duebar' }, icon('bell'), h('div', { class: 'txt' }, `Baseline ${S.baselineN} was saved before costs were tracked, so earned value can't be worked out yet.`),
    h('button', { class: 'btn', onclick: () => change(`Add costs to baseline ${S.baselineN}`, pl => C.baselineCosts(pl, S.sched, pc.ctx, S.baselineN)) }, `Add costs to baseline ${S.baselineN}`)));
  if (!hasBaseline) bars.push(h('div', { class: 'duebar' }, icon('bell'), h('div', { class: 'txt' }, 'Set a baseline (Plan ▾ → Set baseline) to get planned value, earned value, SPI and CPI.')));
  const budgetLine = pc.budget ? `${pctTxt(pc.projectTotal / pc.budget)} of the ${money(pc.budget)} budget used${pc.beforeCost ? ` (with ${money(pc.beforeCost)} charged before the plan)` : ''}` : pc.proj ? 'No budget set – Ledger & budget…' : '';
  const tiles = h('div', { class: 'tiles pl-tiles' },
    tile(unit === 'cost' ? 'Cost to date' : 'Hours to date', fmtV(unit === 'cost' ? pc.actual.total : pc.actual.hours), unit === 'cost' ? budgetLine : `${hrsTxt(pc.evH.bac)} in the baseline`),
    tile('Forecast at completion', fmtV(ev.eac ?? ev.eacBottomUp), ev.vac != null ? `${ev.vac < 0 ? fmtV(-ev.vac) + ' over' : fmtV(ev.vac) + ' under'} the ${fmtV(ev.bac)} baseline` : 'EAC = actual + remaining ÷ CPI', ev.vac != null && ev.vac < 0 ? 'neg' : ''),
    tile('CPI · cost', idx2(ev.cpi), ev.cpi == null ? 'needs earned value and costs' : ev.cpi < 1 ? `${fmtV(ev.ev)} of work cost ${fmtV(ev.ac)}` : 'work costs less than planned', tone(ev.cpi)),
    tile('SPI · schedule', idx2(ev.spi), ev.spi == null ? 'needs a baseline' : `${fmtV(ev.ev)} earned of ${fmtV(ev.pv)} planned by now`, tone(ev.spi)),
    tile('Money runs out', pc.runOut == null ? (pc.budget || ev.bac ? 'Not before the finish' : '–') : fmtDate(pc.runOut * E.DAY), pc.budget ? `at the ${money(pc.budget)} budget` : ev.bac ? 'at the baseline cost' : '', pc.runOut != null && pc.runOut * E.DAY < S.sched.finish ? 'neg' : ''));
  const tools = h('div', { class: 'pl-tools' },
    h('h2', { style: 'margin:0' }, 'Costs'),
    h('span', { class: 'hint' }, pc.posted ? `ERP posted through ${pc.posted}${pc.unposted.length ? ` · plus ${hrsTxt(pc.unposted.reduce((s, x) => s + (x.line.hours || 0), 0))} of your own not yet posted` : ''}` : pc.proj ? 'No ERP data yet' : ''),
    h('div', { class: 'seg' }, [['cost', cur()], ['hours', 'Hours']].map(([k, l]) => h('button', { class: unit === k ? 'on' : '', onclick: () => { S.costUnit = k; A.redraw(); } }, l))),
    h('div', { class: 'spacer' }),
    pc.proj ? h('button', { class: 'btn primary', onclick: () => importDialog({ projectId: pc.proj.id, onDone: () => A.redraw() }) }, icon('up'), 'Import from ERP…') : null,
    pc.proj ? h('button', { class: 'btn', onclick: () => projectCostsDialog(pc.proj.id, () => A.redraw()) }, 'Ledger & budget…') : null,
    h('button', { class: 'btn', onclick: e => showMenu(e, [
      { icon: 'down', label: 'Costs by task (CSV)', run: () => exportTaskCsv(pc) },
      { icon: 'down', label: 'Charges on this plan (CSV)', run: () => exportLinesCsv(pc) },
      { icon: 'chart', label: 'People & rates…', run: () => { view.tab = 'settings'; view.settingsFocus = 'people'; render(); } }]) }, 'More ▾'));
  // by person
  const per = new Map();
  for (const x of pc.actual.lines) {
    const k = x.person ? x.person.id : x.line.name ? 'raw:' + x.line.name : C.isLabor(x.line) ? 'raw:?' : 'nonlabor';
    const a = per.get(k) || { name: x.person ? x.person.name : x.line.name || (C.isLabor(x.line) ? '(no name)' : 'Non-labor (travel, materials…)'), hours: 0, cost: 0, unmatched: !x.person && C.isLabor(x.line) };
    a.hours += x.line.hours || 0; a.cost += x.cost; per.set(k, a);
  }
  const togo = new Map();  // planned cost still to come, per person
  for (const t of p.tasks) {
    const r = S.sched.byUid.get(t.uid);
    if (!r || r.summary) continue;
    const left = 1 - (r.pct || 0) / 100, as = p.assignments.filter(a => a.taskUid === t.uid), tot = as.reduce((s, a) => s + (a.units ?? 1), 0);
    for (const a of as) { const person = pc.ctx.resPerson.get(a.resourceUid); if (!person) continue; togo.set(person.id, (togo.get(person.id) || 0) + (pc.planned.byTask.get(t.uid) || 0) * left * (a.units ?? 1) / (tot || 1)); }
  }
  for (const [id, v] of togo) if (!per.has(id)) per.set(id, { name: pc.ctx.index.byId.get(id)?.name || id, hours: 0, cost: 0 });
  const totalCost = pc.actual.total || 1;
  const personRows = [...per.entries()].sort((a, b) => b[1].cost - a[1].cost).map(([id, a]) => h('tr', {},
    h('td', {}, a.name, a.unmatched ? h('span', { class: 'chip warn', title: 'Not in People & rates – match it there or in the next import' }, 'unmatched') : null),
    h('td', { class: 'num' }, hrsTxt(a.hours)), h('td', { class: 'num' }, money(a.cost)), h('td', { class: 'num' }, pctTxt(a.cost / totalCost)), h('td', { class: 'num' }, money(togo.get(id) || 0))));
  // by month
  const months = new Map();
  for (const x of pc.actual.lines) { const m = x.line.date.slice(0, 7); const a = months.get(m) || { hours: 0, cost: 0, nonlabor: 0 }; a.hours += x.line.hours || 0; a.cost += x.cost; if (!C.isLabor(x.line)) a.nonlabor += x.cost; months.set(m, a); }
  const plannedMonths = new Map();
  for (const [d, v] of C.baselineCurve(p, S.sched, S.baselineN)) { const m = E.dateOf(d * E.DAY).slice(0, 7); plannedMonths.set(m, (plannedMonths.get(m) || 0) + v); }
  const monthKeys = [...new Set([...months.keys(), ...plannedMonths.keys()])].sort();
  const monthRows = monthKeys.map(m => { const a = months.get(m) || { hours: 0, cost: 0, nonlabor: 0 }; return h('tr', {}, h('td', {}, m), h('td', { class: 'num' }, money(plannedMonths.get(m) || 0)), h('td', { class: 'num' }, money(a.cost)), h('td', { class: 'num' }, hrsTxt(a.hours)), h('td', { class: 'num' }, a.nonlabor ? money(a.nonlabor) : '')); });
  // by task
  const ids = rowIds();
  const taskRows = S.sched.order.slice(0, 300).map(u => {
    const t = taskOf(u), r = S.sched.byUid.get(u), b = pc.roll.baseline.get(u) || 0, a = pc.roll.actual.get(u) || 0, pl = pc.roll.planned.get(u) || 0;
    const evT = r.summary ? null : b * (r.pct || 0) / 100;
    return h('tr', { class: r.summary ? 'sum' : '', ondblclick: () => A.select(u) }, h('td', {}, String(ids.get(u))), h('td', { style: `padding-left:${8 + (S.sched.outline.depth.get(u) || 0) * 14}px` }, t.name),
      h('td', { class: 'num' }, `${r.pct || 0}%`), h('td', { class: 'num' }, b ? money(b) : ''), h('td', { class: 'num' }, money(pl)), h('td', { class: 'num' }, a ? money(a) : ''),
      h('td', { class: 'num ' + (evT != null && a > evT * 1.05 && a - evT > 50 ? 'neg' : '') }, evT != null && (a || evT) ? money(evT - a) : ''));
  });
  const un = pc.actual.unassigned;
  const lineRow = x => h('tr', {}, h('td', {}, x.line.date), h('td', {}, x.person ? x.person.name : x.line.name || ''), h('td', { class: 'num' }, x.line.hours != null ? hrsTxt(x.line.hours) : ''), h('td', { class: 'num' }, money(x.cost)), h('td', {}, x.line.category || x.line.desc || ''));
  return h('section', { class: 'pl-view' }, ...bars,
    h('div', { class: 'card' }, tools, tiles),
    h('div', { class: 'card' }, h('h3', {}, unit === 'cost' ? 'Planned value, earned value and actual cost' : 'Planned, earned and actual hours'), sCurve(pc, unit)),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h3', {}, 'By person'), h('div', { class: 'tablewrap' }, h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Person', 'Hours', 'Cost', 'Share', 'Still to come'].map(x => h('th', {}, x)))), h('tbody', {}, personRows.length ? personRows : h('tr', {}, h('td', { colspan: 5, class: 'hint' }, 'No charges yet.')))))),
      h('div', { class: 'card' }, h('h3', {}, 'By month'), h('div', { class: 'tablewrap' }, h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Month', 'Planned', 'Actual', 'Hours', 'Non-labor'].map(x => h('th', {}, x)))), h('tbody', {}, monthRows))))),
    h('div', { class: 'card' }, h('h3', {}, 'By task'), h('p', { class: 'hint', style: 'margin-top:0' }, `Cost variance = earned value (baseline cost × % complete) − actual cost. Negative means the work cost more than planned.`),
      h('div', { class: 'tablewrap' }, h('table', { class: 'rep cost-tasks' }, h('thead', {}, h('tr', {}, ['ID', 'Task', '%', 'Baseline', 'Planned', 'Actual', 'Cost variance'].map(x => h('th', {}, x)))), h('tbody', {}, taskRows)))),
    un.length ? h('div', { class: 'card' }, h('h3', {}, `Not assigned to a task (${un.length})`),
      h('p', { class: 'hint', style: 'margin-top:0' }, 'Charges on days when that person wasn\'t scheduled on this plan. They count in the totals. Map an ERP task code to a task in Task details, or adjust who is assigned.'),
      h('div', { class: 'tablewrap' }, h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Date', 'Person', 'Hours', 'Cost', 'Category'].map(x => h('th', {}, x)))), h('tbody', {}, un.slice(0, 50).map(lineRow))))) : null,
    pc.before.length ? h('p', { class: 'hint' }, `${pc.before.length} charge${pc.before.length > 1 ? 's' : ''} (${money(pc.beforeCost)}) from before the plan started (${E.dateOf(S.sched.start)}) are left out of earned value and the charts, but count against the project's budget.`) : null);
}

/** The S-curve: cumulative planned value (baseline), earned value (snapshots + today), actual, the forecast and the budget. */
function sCurve(pc, unit) {
  const p = S.plan, W = 900, H = 260, L0 = 64, R = 20, T = 14, B = 30;
  const curve = C.baselineCurve(p, S.sched, S.baselineN, unit === 'cost' ? 'cost' : 'hours');
  const actByDay = new Map();
  for (const x of pc.actual.lines) { const d = Math.floor(E.toMin(x.line.date) / E.DAY); actByDay.set(d, (actByDay.get(d) || 0) + (unit === 'cost' ? x.cost : x.line.hours || 0)); }
  const ev = unit === 'cost' ? pc.ev : pc.evH;
  const d0 = Math.floor(S.sched.start / E.DAY), bl = [...curve.keys()], lastA = [...actByDay.keys()];
  const d1 = Math.max(Math.floor(S.sched.finish / E.DAY), ...bl, ...lastA, pc.statusDay) + 1;
  if (!(d1 > d0)) return h('p', { class: 'hint' }, 'Nothing to draw yet.');
  const pv = C.cumulative(curve, d0, d1), ac = C.cumulative(actByDay, d0, Math.min(d1, Math.max(pc.statusDay, ...lastA, d0)));
  const eac = ev.eac ?? ev.eacBottomUp, budget = unit === 'cost' ? pc.budget : 0;
  const snaps = (S.statusCache && S.statusCache.planId === p.id ? S.statusCache.snaps : []).filter(s => s.ev && s.ev[unit === 'cost' ? 'ev' : 'evH'] != null);
  const evPts = [...snaps.map(s => [Math.floor(E.toMin(s.statusDate || s.date) / E.DAY), s.ev[unit === 'cost' ? 'ev' : 'evH']]), [pc.statusDay, ev.ev]].filter(([d]) => d >= d0 && d <= d1);
  const ymax = Math.max(1, ...pv, ...ac, eac || 0, budget || 0, ...evPts.map(x => x[1])) * 1.06;
  const X = d => L0 + (d - d0) / (d1 - d0) * (W - L0 - R), Y = v => T + (1 - v / ymax) * (H - T - B);
  const path = (arr, off = 0) => arr.map((v, i) => `${i ? 'L' : 'M'}${X(d0 + i + off).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const el = (tag, a, txt) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in a) n.setAttribute(k, a[k]); if (txt != null) n.textContent = txt; return n; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'scurve', role: 'img', 'aria-label': 'Cumulative planned value, earned value and actual cost over time' });
  const fv = unit === 'cost' ? (v => v >= 1e6 ? cur() + (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? cur() + Math.round(v / 1e3) + 'k' : cur() + Math.round(v)) : (v => Math.round(v) + ' h');
  for (let i = 0; i <= 4; i++) { const v = ymax / 1.06 * i / 4, y = Y(v); svg.append(el('line', { x1: L0, x2: W - R, y1: y, y2: y, class: 'grid' }), el('text', { x: L0 - 6, y: y + 4, class: 'ax', 'text-anchor': 'end' }, fv(v))); }
  for (let d = d0; d <= d1; d++) { const iso = E.dateOf(d * E.DAY); if (iso.endsWith('-01')) svg.append(el('line', { x1: X(d), x2: X(d), y1: T, y2: H - B, class: 'grid' }), el('text', { x: X(d) + 3, y: H - B + 16, class: 'ax' }, iso.slice(0, 7))); }
  if (budget) svg.append(el('line', { x1: L0, x2: W - R, y1: Y(budget), y2: Y(budget), class: 'budget' }), el('text', { x: W - R - 4, y: Y(budget) - 5, class: 'ax', 'text-anchor': 'end' }, `Budget ${fv(budget)}`));
  const today = Math.floor(E.toMin(fmt(new Date())) / E.DAY);
  if (today >= d0 && today <= d1) svg.append(el('line', { x1: X(today), x2: X(today), y1: T, y2: H - B, class: 'today' }));
  if (pv.some(v => v > 0)) svg.append(el('path', { d: path(pv), class: 's-pv' }));
  if (ac.some(v => v !== 0)) svg.append(el('path', { d: path(ac), class: 's-ac' }));
  if (eac != null && ac.length) svg.append(el('path', { d: `M${X(d0 + ac.length - 1)},${Y(ac[ac.length - 1])}L${X(Math.floor(S.sched.finish / E.DAY))},${Y(eac)}`, class: 's-fc' }), el('circle', { cx: X(Math.floor(S.sched.finish / E.DAY)), cy: Y(eac), r: 4, class: 's-fcd' }));
  if (evPts.length) {
    svg.append(el('path', { d: evPts.map(([d, v], i) => `${i ? 'L' : 'M'}${X(d)},${Y(v)}`).join(''), class: 's-ev' }));
    for (const [d, v] of evPts) svg.append(el('circle', { cx: X(d), cy: Y(v), r: 4, class: 's-evd' }));
  }
  const hover = el('line', { x1: 0, x2: 0, y1: T, y2: H - B, class: 'hover', visibility: 'hidden' });
  svg.append(hover);
  const tip = h('div', { class: 'chart-tip', hidden: '' });
  svg.addEventListener('mousemove', e => {
    const box = svg.getBoundingClientRect(), x = (e.clientX - box.left) / box.width * W;
    const d = Math.round(d0 + (x - L0) / (W - L0 - R) * (d1 - d0));
    if (d < d0 || d > d1) { hover.setAttribute('visibility', 'hidden'); tip.hidden = true; return; }
    hover.setAttribute('x1', X(d)); hover.setAttribute('x2', X(d)); hover.setAttribute('visibility', 'visible');
    const i = d - d0, fmtv = unit === 'cost' ? (v => money(v)) : hrsTxt;
    fill(tip, h('b', {}, fmtDate(d * E.DAY)), h('div', {}, `Planned value ${fmtv(pv[i] || 0)}`), i < ac.length ? h('div', {}, `Actual ${fmtv(ac[i])}`) : null,
      ...evPts.filter(([dd]) => Math.abs(dd - d) <= 1).map(([, v]) => h('div', {}, `Earned value ${fmtv(v)}`)));
    tip.hidden = false; tip.style.left = Math.min(e.clientX - box.left + 14, box.width - 190) + 'px'; tip.style.top = (e.clientY - box.top + 10) + 'px';
  });
  svg.addEventListener('mouseleave', () => { hover.setAttribute('visibility', 'hidden'); tip.hidden = true; });
  const key = (cls, label) => h('span', { class: 'lg' }, h('i', { class: cls }), label);
  return h('div', { class: 'scurve-wrap' }, svg, tip,
    h('div', { class: 'legend' }, key('s-pv', `Planned value (baseline ${S.baselineN})`), key('s-ev', 'Earned value'), key('s-ac', unit === 'cost' ? 'Actual cost' : 'Actual hours'), key('s-fc', `Forecast ${eac != null ? (unit === 'cost' ? money(eac) : hrsTxt(eac)) : ''}`), budget ? key('budget', 'Budget') : null));
}

function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function exportTaskCsv(pc) {
  const ids = rowIds(), rows = [['ID', 'Task', '% complete', 'Baseline cost', 'Planned cost', 'Actual cost', 'Planned hours', 'Actual hours']];
  for (const u of S.sched.order) { const t = taskOf(u), r = S.sched.byUid.get(u); rows.push([ids.get(u), t.name, r.pct || 0, (pc.roll.baseline.get(u) || 0).toFixed(2), (pc.roll.planned.get(u) || 0).toFixed(2), (pc.roll.actual.get(u) || 0).toFixed(2), (pc.roll.plannedH.get(u) || 0).toFixed(1), (pc.roll.actualH.get(u) || 0).toFixed(1)]); }
  download(`${S.plan.name} - costs by task.csv`, rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
}
function exportLinesCsv(pc) {
  const rows = [['Date worked', 'Posted', 'Person', 'Hours', 'ERP pay', 'ERP fringe', 'Full cost', 'Category', 'Pay type', 'Document', 'Not yet posted']];
  for (const x of pc.actual.lines) rows.push([x.line.date, x.line.post || '', x.person ? x.person.name : x.line.name || '', x.line.hours ?? '', x.line.pay ?? '', x.line.fringe ?? '', x.cost.toFixed(2), x.line.category || '', x.line.payType || '', x.line.doc || '', x.line.unposted ? 'yes' : '']);
  download(`${S.plan.name} - charges.csv`, rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
}

// ---------- a project's ledger, budget and cost model ----------
export async function projectCostsDialog(pid, onClose) {
  await loadDir();
  const proj = projectById(pid);
  if (!proj) return toast('That project no longer exists');
  let led = await loadLedger(pid, true);
  const dlg = h('dialog', { class: 'dlg wide cost-dlg', onclose: () => { dlg.remove(); onClose && onClose(); } });
  const body = h('div');
  const paint = () => {
    const model = modelFor(proj), ix = C.personIndex(D.doc), observed = C.observedRates(led.lines, ix), ctx = { dir: D.doc, model, observed };
    const lines = led.lines.map(l => { const person = C.matchPerson(ix, l.name, l.emp); return { l, person, c: C.lineCost(l, { ...ctx, person }) }; });
    const sum = f => lines.reduce((s, x) => s + (f(x) || 0), 0);
    const total = sum(x => x.c.total), budget = num(proj.budgetAmount);
    const per = new Map();
    for (const x of lines) { const k = x.person ? x.person.name : x.l.name || (C.isLabor(x.l) ? '(no name)' : 'Non-labor'); const a = per.get(k) || { h: 0, pay: 0, fringe: 0, total: 0, matched: !!x.person || !C.isLabor(x.l) }; a.h += x.l.hours || 0; a.pay += x.l.pay || 0; a.fringe += x.l.fringe || 0; a.total += x.c.total; per.set(k, a); }
    const modelSel = h('select', { onchange: e => { proj.costModelId = e.target.value; save(); memo = null; paint(); } }, ((D.doc.costModels || []).length ? D.doc.costModels : [C.DEFAULT_MODEL]).map(m => h('option', { value: m.id }, m.name)));
    modelSel.value = model.id;
    const last = led.batches[led.batches.length - 1];
    // timesheet vs ERP for you, by week
    const me = meInDir(), ts = nwaHours()[C.nwaKey(proj)] || {}, week = d => { const x = new Date(d + 'T00:00'); x.setDate(x.getDate() - x.getDay()); return fmt(x); };
    const cmp = new Map();
    if (me) {
      for (const [d, v] of Object.entries(ts)) if (!led.postedThrough || d <= led.postedThrough) { const w = week(d); const a = cmp.get(w) || { ts: 0, erp: 0 }; a.ts += v; cmp.set(w, a); }
      for (const x of lines) if (x.person && x.person.id === me.id) { const w = week(x.l.date); const a = cmp.get(w) || { ts: 0, erp: 0 }; a.erp += x.l.hours || 0; cmp.set(w, a); }
    }
    const cmpRows = [...cmp.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12).map(([w, a]) => h('tr', { class: Math.abs(a.ts - a.erp) > 0.01 ? 'diff' : '' }, h('td', {}, `Week of ${w}`), h('td', { class: 'num' }, hrsTxt(a.ts)), h('td', { class: 'num' }, hrsTxt(a.erp)), h('td', { class: 'num ' + (Math.abs(a.ts - a.erp) > 0.01 ? 'neg' : '') }, Math.abs(a.ts - a.erp) > 0.01 ? hrsTxt(a.erp - a.ts) : '✓')));
    const q = (body.querySelector('.led-q') || {}).value || '';
    const shown = lines.filter(x => !q || [x.l.date, x.l.name, x.person?.name, x.l.category, x.l.desc, x.l.doc].some(v => String(v || '').toLowerCase().includes(q.toLowerCase()))).slice(-400).reverse();
    fill(body, 
      h('div', { class: 'row3' },
        h('div', {}, h('label', {}, `Budget (${cur()})`), h('input', { type: 'number', step: 'any', value: proj.budgetAmount || '', placeholder: 'e.g. 250000', oninput: e => { proj.budgetAmount = e.target.value; save(); memo = null; } })),
        h('div', {}, h('label', {}, `Contingency (${cur()})`), h('input', { type: 'number', step: 'any', value: proj.contingency || '', placeholder: 'Optional', oninput: e => { proj.contingency = e.target.value; save(); } })),
        h('div', {}, h('label', {}, 'Cost model'), modelSel, h('small', {}, `${model.base === 'rate' ? 'Hours × rate' : 'ERP pay + fringe'} · about ${C.multiplier(model).toFixed(2)} × pay`))),
      h('div', { class: 'tiles' },
        h('div', { class: 'card tile' }, h('div', { class: 'lbl' }, 'Full cost to date'), h('div', { class: 'big' }, money(total)), h('div', { class: 'foot' }, budget ? `${pctTxt(total / budget)} of ${money(budget)}` : 'No budget set')),
        h('div', { class: 'card tile' }, h('div', { class: 'lbl' }, 'Hours'), h('div', { class: 'big' }, hrsTxt(sum(x => x.l.hours))), h('div', { class: 'foot' }, `${lines.length} charge lines`)),
        h('div', { class: 'card tile' }, h('div', { class: 'lbl' }, 'ERP pay + fringe'), h('div', { class: 'big' }, money(sum(x => x.l.pay) + sum(x => x.l.fringe))), h('div', { class: 'foot' }, `${money(total - sum(x => x.l.pay) - sum(x => x.l.fringe))} in charges not in the ERP`)),
        h('div', { class: 'card tile' }, h('div', { class: 'lbl' }, 'Posted through'), h('div', { class: 'big' }, led.postedThrough || '–'), h('div', { class: 'foot' }, last ? `Last import ${last.imported.slice(0, 10)}` : 'Nothing imported yet'))),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => importDialog({ projectId: pid, onDone: async () => { led = await loadLedger(pid, true); paint(); } }) }, icon('up'), 'Import from ERP…'),
        last ? h('button', { type: 'button', class: 'btn', onclick: async () => {
          if (!confirm(`Undo the import of “${last.source || 'pasted rows'}” (${last.rows} lines)? Lines it replaced come back.`)) return;
          try { const j = await api(`/api/costs/${pid}/undo`, { batch: last.id }); led = await loadLedger(pid, true); toast(`Removed ${j.removed} lines, restored ${j.restored}`); paint(); } catch (e) { toast(e.message); }
        } }, 'Undo the last import') : null,
        h('button', { type: 'button', class: 'btn', onclick: () => { const rows = [['Date worked', 'Posted', 'Person', 'Employee ID', 'Hours', 'ERP pay', 'ERP fringe', 'Full cost', 'Category', 'Pay type', 'Document', 'Description']]; for (const x of lines) rows.push([x.l.date, x.l.post, x.person ? x.person.name : x.l.name || '', x.l.emp || '', x.l.hours ?? '', x.l.pay ?? '', x.l.fringe ?? '', x.c.total.toFixed(2), x.l.category || '', x.l.payType || '', x.l.doc || '', x.l.desc || '']); download(`${projectLabel(proj)} - ledger.csv`, rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv'); } }, icon('down'), 'Export (CSV)')),
      h('div', { class: 'grid2' },
        h('div', {}, h('h3', {}, 'By person'), h('div', { class: 'tablewrap' }, h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Person', 'Hours', 'ERP pay', 'ERP fringe', 'Full cost'].map(x => h('th', {}, x)))),
          h('tbody', {}, [...per.entries()].sort((a, b) => b[1].total - a[1].total).map(([n, a]) => h('tr', {}, h('td', {}, n, a.matched ? null : h('span', { class: 'chip warn' }, 'unmatched')), h('td', { class: 'num' }, hrsTxt(a.h)), h('td', { class: 'num' }, money(a.pay)), h('td', { class: 'num' }, money(a.fringe)), h('td', { class: 'num' }, money(a.total)))))))),
        h('div', {}, h('h3', {}, 'Imports'), led.batches.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Imported', 'Source', 'Posting dates', 'Lines', 'Replaced'].map(x => h('th', {}, x)))),
          h('tbody', {}, [...led.batches].reverse().map(b => h('tr', {}, h('td', {}, b.imported.slice(0, 16).replace('T', ' ')), h('td', {}, b.source || 'Pasted rows'), h('td', {}, `${b.covers.from} → ${b.covers.to}`), h('td', { class: 'num' }, String(b.rows)), h('td', { class: 'num' }, String(b.replaced))))))) : h('p', { class: 'hint' }, 'Nothing imported yet.'),
          me ? h('div', {}, h('h3', {}, 'Your timesheet against the ERP'), cmpRows.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Week', 'Timesheet', 'ERP', 'Difference'].map(x => h('th', {}, x)))), h('tbody', {}, cmpRows))) : h('p', { class: 'hint' }, 'No overlapping weeks yet.')) : null)),
      h('h3', {}, 'Charges'),
      h('input', { class: 'led-q', placeholder: 'Filter by date, person, category or document…', value: q, oninput: () => paint() }),
      h('div', { class: 'tablewrap', style: 'max-height:340px' }, h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Date worked', 'Posted', 'Person', 'Hours', 'Pay', 'Fringe', 'Full cost', 'Category'].map(x => h('th', {}, x)))),
        h('tbody', {}, shown.map(x => h('tr', { title: costWorking(x.c) }, h('td', {}, x.l.date), h('td', {}, x.l.post), h('td', {}, x.person ? x.person.name : h('span', { class: 'hint' }, x.l.name || '–')), h('td', { class: 'num' }, x.l.hours != null ? String(x.l.hours) : ''), h('td', { class: 'num' }, x.l.pay != null ? money(x.l.pay, 2) : ''), h('td', { class: 'num' }, x.l.fringe != null ? money(x.l.fringe, 2) : ''), h('td', { class: 'num' }, money(x.c.total, 2)), h('td', {}, x.l.category || '')))))));
    const f = body.querySelector('.led-q');
    if (q && f) { f.focus(); f.setSelectionRange(q.length, q.length); }
  };
  dlg.append(h('form', { method: 'dialog' }, h('h3', {}, `Costs – ${projectLabel(proj)}`), body, h('div', { class: 'btns' }, h('button', { class: 'btn primary' }, 'Close'))));
  document.body.append(dlg); paint(); dlg.showModal();
}
/** "pay $520.00 + fringe $161.20 + Overhead $… = $…" for a tooltip. */
export function costWorking(c) {
  return [`pay ${money(c.pay, 2)}`, c.fringe ? `fringe ${money(c.fringe, 2)}` : '', ...c.adds.map(a => `${a.name} ${money(a.amt, 2)}`)].filter(Boolean).join(' + ') + ` = ${money(c.total, 2)}${c.missing ? ' (no rate!)' : c.src && c.src !== 'erp' ? ` (rate: ${c.src})` : ''}`;
}

// ---------- importing an ERP export ----------
/** The import wizard. opts.projectId: where rows go when the export has no NWA column. */
export async function importDialog(opts = {}) {
  await loadDir();
  const W = { step: 1, projectId: opts.projectId || '', table: null, hdr: 0, map: {}, layout: null, dateOrder: D.doc.settings.dateOrder || 'mdy', decimalComma: false, source: '', people: new Map(), nwas: new Map(), covers: new Map(), saveName: '', saveMaster: false, lines: [], errors: [] };
  const dlg = h('dialog', { class: 'dlg wide erp-dlg', onclose: () => dlg.remove() });
  const body = h('div', { class: 'erp-body' }), foot = h('div', { class: 'btns' });
  const go = step => { W.step = step; paint(); };
  const fileIn = h('input', { type: 'file', accept: '.xlsx,.xlsm,.csv,.txt,.tsv', hidden: '' });
  const readFile = async f => {
    try {
      const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.readAsDataURL(f); });
      W.file = { name: f.name, b64 }; W.source = f.name;
      W.table = await api('/api/costs/parse', { filename: f.name, data: b64 });
      afterRead();
    } catch (e) { toast(e.message); }
  };
  fileIn.onchange = () => fileIn.files[0] && readFile(fileIn.files[0]);
  const afterRead = () => {
    const rows = W.table.rows;
    if (!rows.length) return toast('No rows found in that file');
    // a saved layout whose columns are all here wins – the master first
    const layouts = [...(D.doc.layouts || [])].sort((a, b) => (b.master ? 1 : 0) - (a.master ? 1 : 0));
    W.layout = null;
    for (const lay of layouts) {
      for (let i = 0; i < Math.min(30, rows.length); i++) if (C.layoutFits(lay, rows[i] || [])) { W.layout = lay; W.hdr = i; break; }
      if (W.layout) break;
    }
    if (W.layout) { W.map = C.applyLayout(W.layout, rows[W.hdr]).map; W.dateOrder = W.layout.dateOrder || W.dateOrder; W.decimalComma = !!W.layout.decimalComma; }
    else { W.hdr = C.guessHeaderRow(rows); W.map = C.guessMapping(rows[W.hdr] || []); W.saveMaster = !(D.doc.layouts || []).some(l => l.master); W.saveName = W.saveMaster ? 'My ERP export' : ''; }
    go(2);
  };
  const colName = i => { const hd = (W.table.rows[W.hdr] || [])[i]; return `${colLetter(i)} · ${hd === '' || hd == null ? '(no header)' : hd}`; };
  const extract = () => { const r = C.extractLines(W.table.rows, W.hdr, W.map, { dateOrder: W.dateOrder, decimalComma: W.decimalComma }); W.lines = r.lines; W.errors = r.errors; W.skipped = r.skipped; };

  function step1() {
    const paste = h('textarea', { rows: 8, placeholder: 'Or paste rows copied from the ERP or Excel here – include the header row.' });
    fill(body, 
      h('p', { class: 'hint' }, 'Bring in everyone\'s hours and dollars from an ERP report: an Excel file (.xlsx), a CSV, or rows you copy and paste. You choose which columns hold what once, and Keystone remembers it.'),
      h('div', { class: 'drop', ondragover: e => { e.preventDefault(); e.currentTarget.classList.add('on'); }, ondragleave: e => e.currentTarget.classList.remove('on'),
        ondrop: e => { e.preventDefault(); e.currentTarget.classList.remove('on'); const f = e.dataTransfer.files[0]; if (f) readFile(f); } },
        icon('up'), h('div', {}, h('b', {}, 'Drop the export here'), ' or ', h('a', { href: '#', onclick: e => { e.preventDefault(); fileIn.click(); } }, 'choose a file'))), fileIn,
      paste);
    fill(foot, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        if (!paste.value.trim()) return toast('Choose a file or paste some rows');
        try { W.table = await api('/api/costs/parse', { text: paste.value }); W.source = 'Pasted rows'; afterRead(); } catch (e) { toast(e.message); }
      } }, 'Next'));
  }
  function step2() {
    const rows = W.table.rows, heads = rows[W.hdr] || [], ncol = Math.max(...rows.slice(W.hdr, W.hdr + 50).map(r => (r || []).length), heads.length);
    const colOpts = sel => [h('option', { value: '' }, '—'), ...Array.from({ length: ncol }, (_, i) => h('option', { value: i, selected: sel === i ? '' : false }, colName(i)))];
    const fieldRow = f => {
      const cur = W.map[f.k] || [];
      const pick = (slot) => h('select', { onchange: e => { const arr = [...(W.map[f.k] || [])]; const v = e.target.value === '' ? null : +e.target.value; arr[slot] = v; W.map[f.k] = arr.filter(x => x != null); W.dirtyMap = true; paint(); } }, colOpts(cur[slot]));
      return h('tr', {}, h('td', {}, h('b', {}, f.label), f.need ? h('span', { class: 'req' }, ' *') : null, f.hint ? h('div', { class: 'hint' }, f.hint) : null),
        h('td', {}, pick(0), f.multi && (cur.length || f.k === 'person') ? [' + ', pick(1)] : null));
    };
    extract();
    const sample = W.lines.slice(0, 6);
    const missing = [!W.map.date?.length && 'Date worked', !(W.map.hours?.length || W.map.pay?.length) && 'Hours or Pay amount'].filter(Boolean);
    const sheetSel = W.table.sheets && W.table.sheets.length > 1 ? h('div', {}, h('label', {}, 'Sheet'), h('select', { onchange: async e => { try { W.table = await api('/api/costs/parse', { filename: W.file.name, data: W.file.b64, sheet: e.target.value }); afterRead(); } catch (x) { toast(x.message); } } },
      W.table.sheets.map(s => h('option', { value: s, selected: s === W.table.sheet ? '' : false }, s)))) : null;
    const layoutSel = h('select', { onchange: e => { const lay = D.doc.layouts.find(l => l.id === e.target.value); if (!lay) { W.layout = null; W.map = C.guessMapping(heads); } else { W.layout = lay; W.map = C.applyLayout(lay, heads).map; W.dateOrder = lay.dateOrder || W.dateOrder; W.decimalComma = !!lay.decimalComma; } W.dirtyMap = false; paint(); } },
      h('option', { value: '' }, 'Guess from the headers'), (D.doc.layouts || []).map(l => h('option', { value: l.id, selected: W.layout && W.layout.id === l.id ? '' : false }, l.name + (l.master ? ' (master)' : ''))));
    fill(body, 
      W.layout && !W.dirtyMap ? h('div', { class: 'okbar' }, '✓', ` Using your ${W.layout.master ? 'master ' : ''}layout “${W.layout.name}”. Check the preview, then Next.`) : null,
      h('div', { class: 'row3' },
        h('div', {}, h('label', {}, 'Column layout'), layoutSel),
        h('div', {}, h('label', {}, 'Header row'), h('input', { type: 'number', min: 1, max: Math.min(30, rows.length), value: W.hdr + 1, onchange: e => { W.hdr = Math.max(0, (+e.target.value || 1) - 1); if (!W.layout) W.map = C.guessMapping(rows[W.hdr] || []); paint(); } })),
        h('div', {}, h('label', {}, 'Dates are written'), h('select', { onchange: e => { W.dateOrder = e.target.value; paint(); } }, [['mdy', 'Month/day/year'], ['dmy', 'Day/month/year'], ['ymd', 'Year-month-day']].map(([v, l]) => h('option', { value: v, selected: W.dateOrder === v ? '' : false }, l))),
          h('label', { class: 'sw', style: 'margin-top:4px' }, h('input', { type: 'checkbox', checked: W.decimalComma ? '' : false, onchange: e => { W.decimalComma = e.target.checked; paint(); } }), 'Decimal comma (1.234,50)')),
        sheetSel),
      h('div', { class: 'erp-cols' },
        h('table', { class: 'rep map' }, h('thead', {}, h('tr', {}, h('th', {}, 'Keystone needs'), h('th', {}, 'Column in your export'))), h('tbody', {}, FIELDS_UI.map(fieldRow))),
        h('div', {}, h('b', {}, 'Preview'), h('span', { class: 'hint' }, ` · ${W.lines.length} charge lines read${W.errors.length ? `, ${W.errors.length} rows with problems` : ''}${W.skipped ? `, ${W.skipped} skipped (totals or blank dates)` : ''}`),
          h('div', { class: 'tablewrap' }, h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Row', 'Worked', 'Posted', 'Person', 'Hours', 'Pay', 'Fringe', 'NWA'].map(x => h('th', {}, x)))),
            h('tbody', {}, sample.map(l => h('tr', {}, h('td', {}, String(l.row)), h('td', {}, l.date), h('td', {}, l.post), h('td', {}, l.name || l.emp || ''), h('td', { class: 'num' }, l.hours ?? ''), h('td', { class: 'num' }, l.pay != null ? l.pay.toFixed(2) : ''), h('td', { class: 'num' }, l.fringe != null ? l.fringe.toFixed(2) : ''), h('td', {}, l.nwa || '')))))),
          W.errors.length ? h('details', {}, h('summary', {}, `${W.errors.length} rows can't be read`), h('ul', {}, W.errors.slice(0, 30).map(e => h('li', {}, `Row ${e.row}: ${e.text}`)))) : null)),
      h('div', { class: 'savelay' },
        h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: W.saveName ? '' : false, onchange: e => { W.saveName = e.target.checked ? (W.layout ? W.layout.name : 'My ERP export') : ''; paint(); } }),
          W.layout ? `Save these columns to “${W.layout.name}”` : 'Save these columns as a layout'),
        W.saveName ? [h('input', { value: W.saveName, style: 'max-width:240px', oninput: e => { W.saveName = e.target.value; } }),
          h('label', { class: 'sw' }, h('input', { type: 'checkbox', checked: W.saveMaster || (W.layout && W.layout.master) ? '' : false, onchange: e => { W.saveMaster = e.target.checked; } }), 'Master layout – used automatically for every import')] : null),
      missing.length ? h('p', { class: 'neg' }, 'Still needed: ' + missing.join(', ')) : null);
    fill(foot, h('button', { type: 'button', class: 'btn', onclick: () => go(1) }, 'Back'),
      h('button', { type: 'button', class: 'btn primary', disabled: missing.length || !W.lines.length ? '' : false, onclick: () => { prepareMatch(); go(3); } }, 'Next'));
  }
  function prepareMatch() {
    const ix = C.personIndex(D.doc);
    W.people = new Map();
    for (const l of W.lines) {
      if (!C.isLabor(l) || C.matchPerson(ix, l.name, l.emp)) continue;
      const k = l.emp ? 'emp:' + l.emp : 'name:' + C.nameKey(l.name);
      const a = W.people.get(k) || { name: l.name || '', emp: l.emp || '', n: 0, hours: 0, choice: 'new' };
      a.n++; a.hours += l.hours || 0; W.people.set(k, a);
    }
    W.nwas = new Map();
    if (W.map.nwa && W.map.nwa.length) for (const l of W.lines) {
      const p = C.matchProject(state.projects, l.nwa);
      const k = p ? 'p:' + p.id : 'x:' + (l.nwa || '');
      const a = W.nwas.get(k) || { text: l.nwa || '(blank)', project: p, n: 0, hours: 0, choice: p ? p.id : (W.projectId && !state.projects.length ? W.projectId : '') };
      a.n++; a.hours += l.hours || 0; W.nwas.set(k, a);
    }
  }
  function step3() {
    const people = D.doc.people.filter(p => p.active !== false);
    const pr = [...W.people.entries()].map(([k, a]) => h('tr', {}, h('td', {}, h('b', {}, a.name || '(no name)'), a.emp ? h('span', { class: 'hint' }, ` · ID ${a.emp}`) : null), h('td', { class: 'hint' }, `${a.n} lines · ${hrsTxt(a.hours)}`),
      h('td', {}, h('select', { onchange: e => { a.choice = e.target.value; } }, h('option', { value: 'new', selected: a.choice === 'new' ? '' : false }, 'Add as a new person'), h('option', { value: 'skip', selected: a.choice === 'skip' ? '' : false }, 'Leave unmatched for now'),
        h('optgroup', { label: 'Same person as' }, people.map(p => h('option', { value: p.id, selected: a.choice === p.id ? '' : false }, p.name)))))));
    const projOpts = sel => [h('option', { value: '' }, 'Ignore these rows'), h('option', { value: '__new', selected: sel === '__new' ? '' : false }, 'Add to Projects as a new project'), ...state.projects.map(p => h('option', { value: p.id, selected: sel === p.id ? '' : false }, projectLabel(p)))];
    const nr = [...W.nwas.values()].map(a => h('tr', {}, h('td', {}, h('b', {}, a.project ? projectLabel(a.project) : a.text), a.project ? null : h('span', { class: 'chip warn' }, 'not in Projects')), h('td', { class: 'hint' }, `${a.n} lines · ${hrsTxt(a.hours)}`),
      h('td', {}, a.project ? '✓' : h('select', { onchange: e => { a.choice = e.target.value; } }, projOpts(a.choice)))));
    const target = h('select', { onchange: e => { W.projectId = e.target.value; } }, h('option', { value: '' }, 'Choose a project…'), state.projects.map(p => h('option', { value: p.id, selected: W.projectId === p.id ? '' : false }, projectLabel(p))));
    fill(body, 
      h('h4', {}, 'Projects'),
      W.nwas.size ? h('table', { class: 'rep' }, h('tbody', {}, nr)) : h('div', {}, h('p', { class: 'hint' }, 'The export has no network/activity column, so every row goes to one project:'), target),
      h('h4', {}, 'People'),
      pr.length ? h('div', {}, h('p', { class: 'hint' }, 'These names aren\'t in People & rates yet. Whatever you choose is remembered for the next import.'), h('table', { class: 'rep people-match' }, h('tbody', {}, pr))) : h('p', { class: 'hint' }, '✓ Everyone in the export is already in People & rates.'));
    fill(foot, h('button', { type: 'button', class: 'btn', onclick: () => go(2) }, 'Back'),
      h('button', { type: 'button', class: 'btn primary', onclick: async () => {
        if (!W.nwas.size && !W.projectId) return toast('Choose the project these rows belong to');
        await buildGroups(); go(4);
      } }, 'Next'));
  }
  async function buildGroups() {
    const groups = new Map();
    const route = l => {
      if (!W.nwas.size) return W.projectId;
      const p = C.matchProject(state.projects, l.nwa);
      if (p) return p.id;
      const a = W.nwas.get('x:' + (l.nwa || ''));
      return a && a.choice && a.choice !== '__new' ? a.choice : a && a.choice === '__new' ? '__new:' + (l.nwa || '') : null;
    };
    for (const l of W.lines) { const pid = route(l); if (!pid) continue; (groups.get(pid) || groups.set(pid, []).get(pid)).push(l); }
    W.groups = [];
    const all = W.lines.map(l => l.post).sort();  // the export was run for a period: every project gets the whole range
    for (const [pid, lines] of groups) {
      const prev = W.covers.get(pid) || { from: all[0], to: all[all.length - 1] };
      W.covers.set(pid, prev);
      let led = null;
      if (!pid.startsWith('__new')) try { led = await loadLedger(pid, true); } catch {}
      W.groups.push({ pid, lines, led });
    }
  }
  function step4() {
    const ix = C.personIndex(D.doc);
    const rows = W.groups.map(g => {
      const proj = projectById(g.pid), model = modelFor(proj), cv = W.covers.get(g.pid);
      const observed = C.observedRates(g.lines, ix), ctx = { dir: D.doc, model, observed };
      const tot = g.lines.reduce((s, l) => s + C.lineCost(l, { ...ctx, person: C.matchPerson(ix, l.name, l.emp) }).total, 0);
      const hours = g.lines.reduce((s, l) => s + (l.hours || 0), 0), pay = g.lines.reduce((s, l) => s + (l.pay || 0), 0), fr = g.lines.reduce((s, l) => s + (l.fringe || 0), 0);
      const rep = (g.led ? g.led.lines : []).filter(l => (l.post || l.date) >= cv.from && (l.post || l.date) <= cv.to);
      const repH = rep.reduce((s, l) => s + (l.hours || 0), 0);
      return h('div', { class: 'card erp-grp' },
        h('h4', { style: 'margin:0 0 6px' }, proj ? projectLabel(proj) : `New project ${g.pid.slice(6).replace('|', ' / ')}`),
        h('div', { class: 'hint' }, `${g.lines.length} lines · ${hrsTxt(hours)} · ERP pay ${money(pay)} + fringe ${money(fr)} → full cost ${money(tot)} (${model.name})`),
        h('div', { class: 'row2', style: 'margin-top:8px' },
          h('div', {}, h('label', {}, 'Covers posting dates from'), h('input', { type: 'date', value: cv.from, onchange: e => { cv.from = e.target.value; paint(); } })),
          h('div', {}, h('label', {}, 'to'), h('input', { type: 'date', value: cv.to, onchange: e => { cv.to = e.target.value; paint(); } }))),
        h('p', { class: rep.length ? 'warnc' : 'hint', style: 'margin:6px 0 0' }, rep.length ? `Replaces ${rep.length} lines (${hrsTxt(repH)}) from earlier imports posted in this range – the export is the truth for that period, corrections included.` : 'Adds new lines; nothing earlier is replaced.'));
    });
    const tagged = [...W.people.values()].filter(a => a.choice === 'new').length;
    fill(body, h('p', { class: 'hint' }, 'Check the totals before anything is saved. You can undo the most recent import of each project afterwards.'), ...rows,
      tagged ? h('p', { class: 'hint' }, `${tagged} new ${tagged > 1 ? 'people' : 'person'} will be added to People & rates. Add their rates there to plan with them.`) : null,
      W.errors.length ? h('p', { class: 'warnc' }, `${W.errors.length} rows couldn't be read and will be left out.`) : null);
    fill(foot, h('button', { type: 'button', class: 'btn', onclick: () => go(3) }, 'Back'),
      h('button', { type: 'button', class: 'btn primary', onclick: e => doImport(e.currentTarget) }, 'Import'));
  }
  async function doImport(btn) {
    btn.disabled = true;
    try {
      // people: new ones, and aliases for matched names
      for (const a of W.people.values()) {
        if (a.choice === 'skip') continue;
        if (a.choice === 'new') D.doc.people.push({ id: newId('pe_'), name: titleName(a.name) || `Employee ${a.emp}`, aliases: a.name ? [a.name] : [], employeeId: a.emp || '', category: '', maxUnits: 1, away: [], me: false, active: true });
        else { const p = D.doc.people.find(x => x.id === a.choice); if (p) { if (a.name && !p.aliases.includes(a.name)) (p.aliases ||= []).push(a.name); if (a.emp && !p.employeeId) p.employeeId = a.emp; } }
      }
      // new projects
      for (const g of W.groups) if (g.pid.startsWith('__new:')) {
        const [net, act] = g.pid.slice(6).split(/[|\s/-]+/);
        const p = { id: uid(), network: net || g.pid.slice(6), activity: act || '', name: '', budget: '' };
        state.projects.push(p); save(); W.covers.set(p.id, W.covers.get(g.pid)); g.pid = p.id;
      }
      if (W.saveName.trim()) {
        const fields = C.layoutFields(W.map, W.table.rows[W.hdr] || []);
        let lay = W.layout && W.layout.name === W.saveName.trim() ? W.layout : (D.doc.layouts || []).find(l => l.name === W.saveName.trim());
        if (!lay) { lay = { id: newId('ly_') }; (D.doc.layouts ||= []).push(lay); }
        Object.assign(lay, { name: W.saveName.trim(), fields, dateOrder: W.dateOrder, decimalComma: W.decimalComma, master: !!(W.saveMaster || lay.master) });
        if (lay.master) D.doc.layouts.forEach(l => { if (l !== lay) l.master = false; });
        W.layout = lay;
      }
      await saveDir(0);
      const j = await api('/api/costs/import', { source: W.source, layout: W.layout ? W.layout.name : '', groups: W.groups.map(g => ({ projectId: g.pid, covers: W.covers.get(g.pid), lines: g.lines.map(({ row, ...l }) => l) })) });
      for (const b of j.batches) await loadLedger(b.projectId, true);
      memo = null;
      toast(`Imported ${j.batches.reduce((s, b) => s + b.rows, 0)} lines into ${j.batches.length} project${j.batches.length > 1 ? 's' : ''}${j.batches.some(b => b.replaced) ? ` (replaced ${j.batches.reduce((s, b) => s + b.replaced, 0)})` : ''}`);
      dlg.close();
      opts.onDone && opts.onDone(j);
    } catch (e) { toast(e.message); btn.disabled = false; }
  }
  function paint() {
    ({ 1: step1, 2: step2, 3: step3, 4: step4 })[W.step]();
    title.textContent = ['', 'Import from the ERP', 'Choose the columns', 'Match projects and people', 'Check and import'][W.step] + (W.source ? ` · ${W.source}` : '');
    steps.querySelectorAll('span').forEach((s, i) => s.classList.toggle('on', i + 1 === W.step));
  }
  const title = h('h3', {}), steps = h('div', { class: 'steps' }, [1, 2, 3, 4].map(n => h('span', {}, String(n))));
  dlg.append(h('form', { method: 'dialog', onsubmit: e => e.preventDefault() }, h('div', { class: 'erp-h' }, title, steps), body, foot));
  document.body.append(dlg); paint(); dlg.showModal();
}
const FIELDS_UI = C.FIELDS;
const colLetter = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const titleName = s => { const t = String(s || '').trim(); if (!t) return ''; const m = /^([^,]+),\s*(.+)$/.exec(t); const n = m ? `${m[2]} ${m[1]}` : t; return n === n.toUpperCase() || n === n.toLowerCase() ? n.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()) : n; };

// ---------- Settings → People & rates ----------
export function peopleCard() {
  const host = h('section', { class: 'card', id: 'people-rates' }, h('div', { class: 'card-h' }, h('h2', {}, 'People & rates')), h('p', { class: 'hint' }, 'Loading…'));
  loadDir().then(() => paintPeople(host)).catch(e => fill(host, h('p', { class: 'neg' }, e.message)));
  return host;
}
function paintPeople(host) {
  const doc = D.doc, tab = S.prTab || 'people';
  const changed = (repaint = false) => { memo = null; saveDir(); if (repaint) paintPeople(host); };
  const inp = (obj, k, attrs = {}) => h('input', { value: obj[k] ?? '', ...attrs, oninput: e => { obj[k] = attrs.type === 'number' ? (e.target.value === '' ? '' : +e.target.value) : e.target.value; changed(); } });
  const cats = [...new Set(doc.people.map(p => p.category).filter(Boolean))].sort();
  let pane;
  if (tab === 'people') {
    pane = h('div', {},
      h('p', { class: 'hint' }, 'One list for every plan and import. Aliases are how the ERP writes a name (LOPEZ, MARIA). The import adds them for you when you match a name once.'),
      h('div', { class: 'tablewrap' }, h('table', { class: 'rep pr' }, h('thead', {}, h('tr', {}, ['Name', 'ERP aliases', 'Employee ID', 'Labor category', 'Max %', 'Me', 'Active', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, doc.people.map((p, i) => h('tr', { class: p.active === false ? 'muted' : '' },
          h('td', {}, inp(p, 'name')),
          h('td', {}, h('input', { value: (p.aliases || []).join('; '), placeholder: 'LOPEZ, MARIA; MLOPEZ', oninput: e => { p.aliases = e.target.value.split(';').map(s => s.trim()).filter(Boolean); changed(); } })),
          h('td', {}, inp(p, 'employeeId', { style: 'width:110px' })),
          h('td', {}, inp(p, 'category', { list: 'pr-cats', style: 'width:140px' })),
          h('td', {}, h('input', { type: 'number', min: 10, max: 300, step: 10, style: 'width:70px', value: Math.round((p.maxUnits ?? 1) * 100), oninput: e => { p.maxUnits = (+e.target.value || 100) / 100; changed(); } })),
          h('td', {}, h('input', { type: 'radio', name: 'pr-me', checked: p.me ? '' : false, onchange: () => { doc.people.forEach(x => { x.me = x === p; }); changed(); } })),
          h('td', {}, h('input', { type: 'checkbox', checked: p.active !== false ? '' : false, onchange: e => { p.active = e.target.checked; changed(true); } })),
          h('td', {}, h('button', { class: 'x', title: 'Remove', onclick: () => { if (confirm(`Remove ${p.name}? Their rates go too. (Charges in the ledgers are kept; they show as unmatched.)`)) { doc.people.splice(i, 1); doc.rates = doc.rates.filter(r => r.who !== p.id); changed(true); } } }, icon('x')))))))),
      h('datalist', { id: 'pr-cats' }, cats.map(c => h('option', { value: c }))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { doc.people.push({ id: newId('pe_'), name: '', aliases: [], employeeId: '', category: '', maxUnits: 1, away: [], me: !doc.people.some(x => x.me), active: true }); changed(true); host.querySelector('tbody tr:last-child input')?.focus(); } }, icon('plus'), 'Add a person')));
  } else if (tab === 'rates') {
    const whoOpts = sel => [h('option', { value: 'default', selected: sel === 'default' ? '' : false }, 'Default (anyone without a rate)'),
      h('optgroup', { label: 'Labor categories' }, cats.map(c => h('option', { value: 'cat:' + c, selected: sel === 'cat:' + c ? '' : false }, c))),
      h('optgroup', { label: 'People' }, doc.people.map(p => h('option', { value: p.id, selected: sel === p.id ? '' : false }, p.name || '(no name)')))];
    const sorted = [...doc.rates].sort((a, b) => String(a.who).localeCompare(String(b.who)) || String(a.from || '').localeCompare(String(b.from || '')));
    pane = h('div', {},
      h('p', { class: 'hint' }, `Base pay per hour. A rate applies from its date on, so a raise doesn't change earlier charges. Keystone uses the person's rate, then their category's, then what the ERP shows they cost, then the default.`),
      h('div', { class: 'tablewrap' }, h('table', { class: 'rep pr' }, h('thead', {}, h('tr', {}, ['Who', `Pay per hour (${cur()})`, 'From', 'Full cost per hour', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, sorted.map(r => {
          const person = doc.people.find(p => p.id === r.who), m = modelFor(null), full = C.hourlyCost({ dir: { rates: [r] }, model: { ...m, base: 'rate' } }, null, r.from || '2100-01-01');
          return h('tr', {},
            h('td', {}, h('select', { onchange: e => { r.who = e.target.value; changed(); } }, whoOpts(r.who))),
            h('td', {}, inp(r, 'base', { type: 'number', step: '0.01', style: 'width:100px' })),
            h('td', {}, inp(r, 'from', { type: 'date' })),
            h('td', { class: 'hint', title: `With the default cost model (${m.name})` }, r.base ? money((+r.base) * C.multiplier({ ...m, base: 'rate' }, r.from || '2100-01-01'), 2) : ''),
            h('td', {}, h('button', { class: 'x', title: 'Remove', onclick: () => { doc.rates.splice(doc.rates.indexOf(r), 1); changed(true); } }, icon('x'))));
        })))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { doc.rates.push({ who: doc.people[0] ? doc.people[0].id : 'default', base: '', from: fmt(new Date()) }); changed(true); } }, icon('plus'), 'Add a rate')));
  } else if (tab === 'models') {
    const kinds = [['pctBase', '% of pay + fringe'], ['pctPay', '% of pay'], ['pctRunning', '% of the total so far'], ['perHour', `${cur()} per hour`]];
    pane = h('div', {},
      h('p', { class: 'hint' }, 'How the full cost is worked out. Pick one per project (Plan → Costs → Ledger & budget, or the Projects tab). The ERP gives each person\'s pay and fringe; add what it leaves out – overhead, G&A, service charges, fee.'),
      ...doc.costModels.map(m => h('div', { class: 'card model' },
        h('div', { class: 'row3' },
          h('div', {}, h('label', {}, 'Name'), inp(m, 'name')),
          h('div', {}, h('label', {}, 'Start from'), h('select', { onchange: e => { m.base = e.target.value; changed(true); } }, h('option', { value: 'erp', selected: m.base !== 'rate' ? '' : false }, 'ERP pay + fringe (rates only for planning)'), h('option', { value: 'rate', selected: m.base === 'rate' ? '' : false }, 'Hours × rate from People & rates'))),
          h('div', {}, h('label', {}, 'Fringe % of pay'), inp(m, 'fringePct', { type: 'number', step: 'any' }), h('small', {}, m.base === 'rate' ? 'Added to every hour' : 'For planning, and lines without a fringe amount'))),
        h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Then add', 'Amount', 'How', 'From (optional)', ''].map(x => h('th', {}, x)))),
          h('tbody', {}, (m.adders || []).map((a, i) => h('tr', {}, h('td', {}, inp(a, 'name', { placeholder: 'Overhead' })), h('td', {}, inp(a, 'value', { type: 'number', step: 'any', style: 'width:90px' })),
            h('td', {}, h('select', { onchange: e => { a.kind = e.target.value; changed(true); } }, kinds.map(([v, l]) => h('option', { value: v, selected: a.kind === v ? '' : false }, l)))),
            h('td', {}, inp(a, 'from', { type: 'date' })), h('td', {}, h('button', { class: 'x', onclick: () => { m.adders.splice(i, 1); changed(true); } }, icon('x'))))))),
        h('div', { class: 'actions' },
          h('button', { class: 'btn sm', onclick: () => { (m.adders ||= []).push({ name: '', kind: 'pctBase', value: '' }); changed(true); } }, icon('plus'), 'Add a charge'),
          h('label', {}, 'Overtime multipliers ', h('input', { style: 'width:150px', placeholder: 'OT=1.5, PR=1.25', value: Object.entries(m.payTypes || {}).map(([k, v]) => `${k}=${v}`).join(', '),
            oninput: e => { m.payTypes = Object.fromEntries(e.target.value.split(',').map(s => s.split('=').map(x => x.trim())).filter(([k, v]) => k && +v > 0).map(([k, v]) => [k.toUpperCase(), +v])); changed(); } })),
          h('label', {}, 'Non-labor % ', inp(m, 'nonLaborPct', { type: 'number', step: 'any', style: 'width:70px' })),
          h('label', { class: 'sw' }, h('input', { type: 'radio', name: 'cm-def', checked: m.isDefault ? '' : false, onchange: () => { doc.costModels.forEach(x => { x.isDefault = x === m; }); changed(); } }), 'Default'),
          h('div', { class: 'spacer' }),
          h('span', { class: 'hint' }, `≈ ${C.multiplier(m).toFixed(2)} × pay`),
          h('button', { class: 'x', title: 'Remove', onclick: () => { if (confirm(`Remove “${m.name}”?`)) { doc.costModels.splice(doc.costModels.indexOf(m), 1); changed(true); } } }, icon('trash'))))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { doc.costModels.push({ id: newId('cm_'), name: 'New cost model', base: 'erp', fringePct: 0, adders: [{ name: 'Overhead', kind: 'pctBase', value: 100 }], payTypes: { OT: 1.5 }, nonLaborPct: 0, isDefault: !doc.costModels.length }); changed(true); } }, icon('plus'), 'Add a cost model')));
  } else {
    pane = h('div', {},
      h('p', { class: 'hint' }, 'Column layouts saved by the import. The master layout is used automatically whenever an export has its columns, so the next import goes straight to the preview.'),
      doc.layouts.length ? h('div', { class: 'tablewrap' }, h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Layout', 'Columns', 'Dates', 'Master', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, doc.layouts.map((l, i) => h('tr', {}, h('td', {}, inp(l, 'name')),
          h('td', { class: 'hint' }, C.FIELDS.filter(f => l.fields[f.k]).map(f => `${f.label}: ${l.fields[f.k].join(' + ')}`).join(' · ')),
          h('td', {}, l.dateOrder || 'mdy'),
          h('td', {}, h('input', { type: 'radio', name: 'ly-m', checked: l.master ? '' : false, onchange: () => { doc.layouts.forEach(x => { x.master = x === l; }); changed(); } })),
          h('td', {}, h('button', { class: 'x', onclick: () => { if (confirm(`Remove the layout “${l.name}”?`)) { doc.layouts.splice(i, 1); changed(true); } } }, icon('x')))))))) : h('p', { class: 'hint' }, 'None yet – the first import saves one.'),
      h('div', { class: 'form' }, h('div', {}, h('label', {}, 'Currency symbol'), h('input', { value: doc.settings.currency || '$', style: 'width:70px', oninput: e => { doc.settings.currency = e.target.value || '$'; changed(); } }))),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => importDialog({ onDone: () => paintPeople(host) }) }, icon('up'), 'Import an ERP export…')));
  }
  fill(host, 
    h('div', { class: 'card-h' }, h('h2', {}, 'People & rates'), h('span', { class: 'sub' }, 'Pay data stays on this computer (owner-only files) and is never sent to a cloud AI model'), h('div', { class: 'spacer' }),
      h('div', { class: 'seg' }, [['people', `People (${doc.people.length})`], ['rates', `Rates (${doc.rates.length})`], ['models', `Cost models (${doc.costModels.length})`], ['layouts', 'ERP layouts']].map(([k, l]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { S.prTab = k; paintPeople(host); } }, l)))),
    pane);
}

// ---------- the Projects tab and Today ----------
/** Cost to date of every project (for the Projects tab), computed in the page from the ledgers. */
export async function projectTotals() {
  await loadDir();
  const sum = await api('/api/costs');
  const out = new Map();
  for (const s of sum.projects) {
    const proj = projectById(s.projectId);
    if (!proj || !s.lines) continue;
    const led = await loadLedger(s.projectId);
    const ix = C.personIndex(D.doc), model = modelFor(proj), observed = C.observedRates(led.lines, ix);
    const total = led.lines.reduce((t, l) => t + C.lineCost(l, { dir: D.doc, model, observed, person: C.matchPerson(ix, l.name, l.emp) }).total, 0);
    out.set(s.projectId, { total, hours: s.hours, postedThrough: s.postedThrough });
  }
  return out;
}
/** Heads-up lines for Today: stale ERP data and budgets running ahead of progress. */
export async function costAlerts() {
  const out = [], today = fmt(new Date());
  const totals = await projectTotals();
  for (const [pid, t] of totals) {
    const proj = projectById(pid), budget = num(proj.budgetAmount);
    if (t.postedThrough && (E.toMin(today) - E.toMin(t.postedThrough)) / E.DAY > 21) out.push({ lvl: 'info', text: `ERP data for ${projectLabel(proj)} is ${Math.round((E.toMin(today) - E.toMin(t.postedThrough)) / E.DAY / 7)} weeks old – import a new export.`, pid });
    if (budget && t.total > budget) out.push({ lvl: 'err', text: `${projectLabel(proj)} has cost ${money(t.total)} – over its ${money(budget)} budget.`, pid });
    else if (budget && t.total > budget * 0.8) out.push({ lvl: 'warn', text: `${projectLabel(proj)} has used ${Math.round(t.total / budget * 100)}% of its ${money(budget)} budget.`, pid });
  }
  return out;
}
