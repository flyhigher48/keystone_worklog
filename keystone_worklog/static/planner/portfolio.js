// Keystone Planner – the portfolio: every plan on one page, every milestone on one timeline, and every person's
// load across all plans (people are the same in every plan through the People & rates directory).
import * as C from './costs.js';
import * as E from './engine.js';
import { keystoneCalendar, fmtDate } from './ui.js';
import { loadDir, D, projectTotals, money, linkPeople, fill } from './costui.js';
import { ragChip } from './status.js';

const P = { data: null, loading: null, at: 0 };
const startOfWeek = d => { const x = new Date(d + 'T00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return fmt(x); };

/** Load and schedule every plan (cached for a minute). */
export async function load(force = false) {
  if (P.data && !force && Date.now() - P.at < 60000) return P.data;
  P.loading ||= (async () => {
    await loadDir();
    const list = (await api('/api/plans')).plans.filter(p => !p.template);
    const plans = [];
    for (const meta of list) {
      const p = await api('/api/plans/' + meta.id);
      if (!p.calendar) p.calendar = keystoneCalendar(p.start);
      await linkPeople(p).catch(() => {});  // links in memory only; the plan file is updated when it's next opened
      let s;
      try { s = E.schedule(p, { now: E.toMin(fmt(new Date())) }); } catch { continue; }
      plans.push({ meta, p, s });
    }
    let totals = new Map();
    try { totals = await projectTotals(); } catch {}
    P.data = { plans, totals }; P.at = Date.now(); P.loading = null;
    return P.data;
  })().catch(e => { P.loading = null; throw e; });
  return P.loading;
}

function planRow({ meta, p, s }, totals, open) {
  const leaves = s.order.filter(u => !s.byUid.get(u).summary).map(u => s.byUid.get(u));
  const tot = leaves.reduce((a, r) => a + (r.dur || 0), 0), now = E.toMin(p.statusDate) ?? E.toMin(fmt(new Date())) + 17 * 60;
  const pct = tot ? Math.round(leaves.reduce((a, r) => a + (r.dur || 0) * (r.pct || 0), 0) / tot) : 0;
  const exp = tot ? Math.round(leaves.reduce((a, r) => a + (r.dur || 0) * E.expectedPct(s.calendar, r, now), 0) / tot) : 0;
  const bl = p.tasks.map(t => (t.baselines || {})[0]).filter(Boolean), blf = bl.length ? Math.max(...bl.map(b => E.toMin(b.finish) || 0)) : null;
  const slip = blf ? Math.round(E.workBetween(s.calendar, blf, s.finish) / (p.units?.minutesPerDay || 480)) : null;
  const nextU = s.order.filter(u => s.byUid.get(u).milestone && (s.byUid.get(u).pct || 0) < 100).sort((a, b) => s.byUid.get(a).ef - s.byUid.get(b).ef)[0];
  const next = nextU != null && s.byUid.get(nextU), nextT = next && p.tasks.find(t => t.uid === nextU);
  const proj = p.projectId && state.projects.find(x => x.id === p.projectId), cost = proj && totals.get(proj.id), budget = proj && num(proj.budgetAmount);
  const late = leaves.filter(r => (r.late || r.missesDeadline) && (r.pct || 0) < 100).length;
  const st = meta.lastStatus;
  return h('tr', { class: 'pf-row', onclick: () => open(p.id) },
    h('td', {}, h('b', {}, p.name), proj ? h('div', { class: 'hint' }, projectLabel(proj)) : null),
    h('td', {}, ragChip(st && st.rag), st ? h('div', { class: 'hint' }, st.date) : null),
    h('td', {}, fmtDate(s.finish), slip ? h('div', { class: slip > 0 ? 'neg' : 'pos' }, `${slip > 0 ? '+' : ''}${slip} d vs baseline`) : h('div', { class: 'hint' }, blf ? 'on baseline' : 'no baseline')),
    h('td', { class: 'num' }, `${pct}%`, h('div', { class: pct + 5 < exp ? 'neg' : 'hint' }, `${exp}% expected`)),
    h('td', { class: 'num' }, late ? h('span', { class: 'neg' }, String(late)) : '0'),
    h('td', { class: 'num' }, cost ? money(cost.total) : '–', budget ? h('div', { class: cost && cost.total > budget ? 'neg' : 'hint' }, `of ${money(budget)}`) : null),
    h('td', {}, nextT ? [nextT.name, h('div', { class: 'hint' }, fmtDate(next.ef))] : h('span', { class: 'hint' }, 'none left')));
}

/** One row per plan with its milestones; weeks with 3+ milestones across plans are shaded. */
function milestoneTimeline(plans, open) {
  const ms = plans.flatMap(({ p, s }) => s.order.filter(u => s.byUid.get(u).milestone).map(u => ({ plan: p, uid: u, r: s.byUid.get(u), t: p.tasks.find(x => x.uid === u) })));
  if (!ms.length) return h('p', { class: 'hint' }, 'No milestones yet.');
  const today = E.toMin(fmt(new Date()));
  const a = Math.min(today - 14 * E.DAY, ...ms.map(m => m.r.ef)), b = Math.max(today + 28 * E.DAY, ...ms.map(m => m.r.ef)) + 7 * E.DAY;
  const W = 1000, L0 = 180, R = 20, rowH = 30, H = plans.length * rowH + 30;
  const X = t => L0 + (t - a) / (b - a) * (W - L0 - R);
  const NS = 'http://www.w3.org/2000/svg', el = (tag, at, txt) => { const n = document.createElementNS(NS, tag); for (const k in at) n.setAttribute(k, at[k]); if (txt != null) n.textContent = txt; return n; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'pf-ms', role: 'img', 'aria-label': 'Milestones of every plan on one timeline' });
  const weeks = new Map();
  for (const m of ms) if ((m.r.pct || 0) < 100) { const w = startOfWeek(E.dateOf(m.r.ef)); weeks.set(w, (weeks.get(w) || 0) + 1); }
  for (const [w, n] of weeks) if (n >= 3) { const t = E.toMin(w); svg.append(el('rect', { x: X(t), y: 0, width: Math.max(2, X(t + 7 * E.DAY) - X(t)), height: H - 24, class: 'busy' }, null), el('title', {}, `${n} milestones the week of ${w}`)); }
  for (let t = Math.ceil(a / E.DAY) * E.DAY; t < b; t += E.DAY) if (E.dateOf(t).endsWith('-01')) svg.append(el('line', { x1: X(t), x2: X(t), y1: 0, y2: H - 24, class: 'grid' }), el('text', { x: X(t) + 3, y: H - 8, class: 'ax' }, E.dateOf(t).slice(0, 7)));
  svg.append(el('line', { x1: X(today), x2: X(today), y1: 0, y2: H - 24, class: 'today' }));
  plans.forEach(({ p, s }, i) => {
    const y = i * rowH + 16;
    svg.append(el('line', { x1: L0, x2: W - R, y1: y, y2: y, class: 'lane' }), el('text', { x: 4, y: y + 4, class: 'pl' }, p.name.slice(0, 26)));
    for (const m of ms.filter(m => m.plan === p)) {
      const x = X(m.r.ef), cls = (m.r.pct || 0) >= 100 ? 'done' : m.r.late || m.r.missesDeadline ? 'late' : '';
      const g = el('g', { class: 'msd ' + cls, transform: `translate(${x},${y})` });
      g.append(el('path', { d: 'M0,-7L7,0L0,7L-7,0Z' }), el('title', {}, `${p.name}: ${m.t.name} · ${fmtDate(m.r.ef)}${cls === 'late' ? ' · late' : cls === 'done' ? ' · done' : ''}`));
      g.addEventListener('click', () => open(p.id, m.uid));
      svg.append(g);
    }
  });
  return h('div', {}, svg, h('div', { class: 'legend' }, h('span', { class: 'lg' }, h('i', { class: 'msd-k' }), 'Milestone'), h('span', { class: 'lg' }, h('i', { class: 'msd-k late' }), 'Late'), h('span', { class: 'lg' }, h('i', { class: 'msd-k done' }), 'Done'), h('span', { class: 'lg' }, h('i', { class: 'busy-k' }), '3 or more due that week')));
}

/** Planned minutes per directory person per day across every plan: Map personId → Map day → [{plan, minutes}]. */
export function peopleLoad(plans) {
  const idx = C.personIndex(D.doc), out = new Map();
  for (const { p, s } of plans) {
    const resPerson = new Map((p.resources || []).map(r => [r.uid, C.personOfResource(D.doc, idx, r)]));
    for (const w of C.plannedWork(p, s)) {
      const person = w.resUid != null ? resPerson.get(w.resUid) : null;
      if (!person) continue;
      const m = out.get(person.id) || out.set(person.id, new Map()).get(person.id);
      const arr = m.get(w.day) || m.set(w.day, []).get(w.day);
      const ex = arr.find(x => x.plan === p.name);
      if (ex) ex.minutes += w.minutes; else arr.push({ plan: p.name, minutes: w.minutes });
    }
  }
  return out;
}
/** Working minutes a person can give on a day: the Keystone calendar × their Max %, minus their days off. */
export function capacity(person, day, cal) {
  const iso = E.dateOf(day * E.DAY);
  if ((person.away || []).includes(iso)) return 0;
  if (person.me) for (const a of state.away || []) if (a.kind !== 'travel' && a.start && iso >= a.start && iso <= (a.end || a.start)) return 0;
  return E.dayWork(cal, day) * (person.maxUnits ?? 1);
}
function workload(plans) {
  const load = peopleLoad(plans), cal = keystoneCalendar(fmt(new Date())), weeks = 12;
  const from = Math.floor(E.toMin(startOfWeek(fmt(new Date()))) / E.DAY);
  const people = D.doc.people.filter(p => p.active !== false && load.has(p.id));
  if (!people.length) return h('p', { class: 'hint' }, 'Nobody is assigned to tasks yet.');
  const cell = (person, w) => {
    let mins = 0, cap = 0;
    const by = new Map();
    for (let d = 0; d < 7; d++) {
      const day = from + w * 7 + d;
      cap += capacity(person, day, cal);
      for (const x of (load.get(person.id).get(day) || [])) { mins += x.minutes; by.set(x.plan, (by.get(x.plan) || 0) + x.minutes); }
    }
    const ratio = cap ? mins / cap : mins ? 2 : 0;
    const cls = ratio > 1.02 ? 'over' : ratio > 0.8 ? 'full' : ratio > 0.4 ? 'mid' : ratio > 0 ? 'low' : '';
    return h('td', { class: 'wl ' + cls, title: `${Math.round(mins / 6) / 10} h planned of ${Math.round(cap / 6) / 10} h\n` + [...by].map(([pl, m]) => `${pl}: ${Math.round(m / 6) / 10} h`).join('\n') }, mins ? String(Math.round(mins / 60)) : '', by.size > 1 ? h('small', { class: 'wl-away' }, ` ·${by.size}`) : null);
  };
  return h('div', {},
    h('div', { class: 'tablewrap' }, h('table', { class: 'rep wl-tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Person'), Array.from({ length: weeks }, (_, w) => h('th', {}, E.dateOf((from + w * 7) * E.DAY).slice(5).replace('-', '/'))))),
      h('tbody', {}, people.map(p => h('tr', {}, h('th', {}, p.name, p.category ? h('div', { class: 'hint' }, p.category) : null), Array.from({ length: weeks }, (_, w) => cell(p, w))))))),
    h('div', { class: 'wl-key hint' }, h('span', { class: 'wl low' }, '≤40%'), h('span', { class: 'wl mid' }, '≤80%'), h('span', { class: 'wl full' }, '≤100%'), h('span', { class: 'wl over' }, 'overbooked'), h('span', {}, '·2 = working on two plans that week; hover for the split')));
}
/** People ranked by free hours in a date range. */
export function whoIsFree(plans, fromIso, toIso) {
  const load = peopleLoad(plans), cal = keystoneCalendar(fromIso);
  const d0 = Math.floor(E.toMin(fromIso) / E.DAY), d1 = Math.floor(E.toMin(toIso) / E.DAY);
  return D.doc.people.filter(p => p.active !== false).map(p => {
    let cap = 0, used = 0;
    for (let d = d0; d <= d1; d++) { cap += capacity(p, d, cal); for (const x of (load.get(p.id)?.get(d) || [])) used += x.minutes; }
    return { person: p, free: Math.max(0, cap - used) / 60, capacity: cap / 60, planned: used / 60 };
  }).sort((a, b) => b.free - a.free);
}

export function view(open) {
  if (!P.data) {
    const box = h('section', { class: 'card pl-view' }, h('p', { class: 'hint' }, 'Loading every plan…'));
    load().then(() => S_redraw && S_redraw()).catch(e => fill(box, h('p', { class: 'neg' }, 'The portfolio could not load: ' + e.message)));
    return box;
  }
  const { plans, totals } = P.data;
  const from = h('input', { type: 'date', value: P.freeFrom || fmt(new Date()) }), to = h('input', { type: 'date', value: P.freeTo || addDays(fmt(new Date()), 13) }), need = h('input', { type: 'number', min: 1, value: P.freeNeed || 40, style: 'width:80px' });
  const freeBox = h('div');
  const runFree = () => {
    P.freeFrom = from.value; P.freeTo = to.value; P.freeNeed = +need.value || 0;
    const rows = whoIsFree(plans, from.value, to.value);
    fill(freeBox, h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Person', 'Category', 'Free', 'Planned', 'Can work'].map(x => h('th', {}, x)))),
      h('tbody', {}, rows.map(r => h('tr', { class: r.free >= P.freeNeed ? '' : 'muted' }, h('td', {}, r.person.name), h('td', {}, r.person.category || ''), h('td', { class: 'num' }, h('b', {}, `${Math.round(r.free)} h`)), h('td', { class: 'num' }, `${Math.round(r.planned)} h`), h('td', { class: 'num' }, `${Math.round(r.capacity)} h`))))));
  };
  [from, to, need].forEach(x => x.addEventListener('change', runFree));
  runFree();
  return h('section', { class: 'pl-view' },
    h('div', { class: 'card' }, h('div', { class: 'pl-tools' }, h('h2', { style: 'margin:0' }, 'All plans'), h('span', { class: 'hint' }, `${plans.length} plans · status from the last “Close the week”`), h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onclick: () => { P.data = null; S_redraw && S_redraw(); } }, 'Refresh')),
      h('div', { class: 'tablewrap' }, h('table', { class: 'rep pf' }, h('thead', {}, h('tr', {}, ['Plan', 'Status', 'Finish', 'Done', 'Late', 'Cost', 'Next milestone'].map(x => h('th', {}, x)))),
        h('tbody', {}, plans.map(x => planRow(x, totals, open)))))),
    h('div', { class: 'card' }, h('h3', {}, 'Milestones across plans'), milestoneTimeline(plans, open)),
    h('div', { class: 'card' }, h('h3', {}, 'People across all plans'), h('p', { class: 'hint', style: 'margin-top:0' }, 'Planned hours per person per week from every plan, against the hours they can work.'), workload(plans)),
    h('div', { class: 'card' }, h('div', { class: 'pl-tools' }, h('h3', { style: 'margin:0' }, 'Who\'s free'), from, h('span', {}, 'to'), to, h('span', {}, 'needing'), need, h('span', {}, 'hours')), freeBox));
}
let S_redraw = null;
export const setRedraw = f => { S_redraw = f; };
export const invalidate = () => { P.data = null; };
