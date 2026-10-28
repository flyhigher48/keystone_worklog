// Keystone Planner – the assistant's plan tools. Each write tool returns a preview ({ summary, detail, apply });
// index.html shows it for approval, then calls apply(). Reads and simulate return plain text.
import * as E from './engine.js';
import { planner as S, openPlan, change, rowIds, resourceText, moveTo, finishAt, setPct, setWork, flush, fmtDate, parseDateInput, descendants } from './ui.js';
import * as CU from './costui.js';
import * as ST from './status.js';
import * as PF from './portfolio.js';

export const TOOLS = {
  list_plans: { d: 'List the project plans in the Plan tab (id, name, number of tasks).', p: {}, req: [] },
  get_plan: { d: 'Read a project plan: every task with its ID (the row number the user sees), name, outline level, start, finish, duration, % complete, predecessors, people, slack and whether it is critical or late; plus milestones, people and open issues and risks.',
    p: { plan: ['string', 'Plan id or name (from list_plans); defaults to the open plan'], filter: ['string', 'all (default), critical, late, milestones, incomplete, or a person\'s name'] }, req: [] },
  simulate: { d: 'What-if: apply task changes to a copy of the plan and report how the finish date, critical path and deadlines would move. Nothing is saved.',
    p: { plan: ['string'], changes: { type: 'array', description: 'Same items as update_tasks', items: { type: 'object' } } }, req: ['changes'] },
  update_tasks: { d: 'Change existing tasks in a plan. Refer to tasks by ID (row number from get_plan) or exact name. Fields: name, duration ("3d", "2w", "0" = milestone), hours (total work the task needs; the duration follows from the people on it), budget (dollars, a separate check against the cost; "" clears it), start (YYYY-MM-DD; sets Start No Earlier Than), finish (YYYY-MM-DD; changes the duration), percent (0–100), predecessors (like the grid: "4, 7SS+2d, 9FF-1d"), people ("Maria, Sam[50%]"), notes, deadline (YYYY-MM-DD or empty). The user reviews the schedule impact first.',
    p: { plan: ['string'], changes: { type: 'array', items: { type: 'object', required: ['task'], properties: {
      task: { type: 'string', description: 'ID or exact name' }, name: { type: 'string' }, duration: { type: 'string' }, start: { type: 'string' }, finish: { type: 'string' },
      percent: { type: 'number' }, predecessors: { type: 'string' }, people: { type: 'string' }, notes: { type: 'string' }, deadline: { type: 'string' },
      hours: { type: 'number', description: 'Total hours of work the task needs' }, budget: { type: ['number', 'string'], description: 'Budget in dollars; "" clears it' } } } } }, req: ['changes'] },
  add_tasks: { d: 'Add tasks or milestones to a plan. parent puts them under a summary task (ID or name); after places them after a task; depends_on lists tasks (IDs or names, including tasks added in the same call) they follow finish-to-start. The user reviews it.',
    p: { plan: ['string'], tasks: { type: 'array', items: { type: 'object', required: ['name'], properties: {
      name: { type: 'string' }, duration: { type: 'string', description: '"5d", "2w"; "0" for a milestone (default 1d)' }, parent: { type: 'string' }, after: { type: 'string' },
      depends_on: { type: 'array', items: { type: 'string' } }, people: { type: 'string' }, notes: { type: 'string' }, deadline: { type: 'string' } } } } }, req: ['tasks'] },
  add_raid_item: { d: 'Log a risk, issue, action or decision in a plan\'s Issues & risks list. The user reviews it.',
    p: { plan: ['string'], kind: ['string', 'risk, issue, action or decision'], title: ['string'], description: ['string'], owner: ['string'], due: ['string', 'YYYY-MM-DD'],
      probability: ['number', '1–5, risks only'], impact: ['number', '1–5'], mitigation: ['string'], tasks: { type: 'array', items: { type: 'string' }, description: 'Affected task IDs or names' } }, req: ['kind', 'title'] },
};
Object.assign(TOOLS, {
  cost_summary: { d: 'Costs of a plan: budget, cost to date, earned value, CPI/SPI, forecast at completion, when the money runs out, and hours and cost by person and month. Dollar amounts are only included when the profile allows cost data; pay rates are never included.',
    p: { plan: ['string', 'Plan id or name; defaults to the open plan'] }, req: [] },
  who_is_free: { d: 'People ranked by free hours between two dates, across every plan (their working hours minus planned work and days off).',
    p: { from: ['string', 'YYYY-MM-DD'], to: ['string', 'YYYY-MM-DD'], hours: ['number', 'Hours needed (optional)'] }, req: ['from', 'to'] },
  portfolio_summary: { d: 'One line per plan: last status (red/amber/green), forecast finish against the baseline, % complete against expected, late tasks, next milestone, and cost against budget (dollars only when allowed).', p: {}, req: [] },
  status_draft: { d: 'The draft for this week\'s status of a plan: the suggested red/amber/green for overall, schedule, cost and scope with the reasons, the numbers, what was done, what is next and decisions needed. Use before close_week.',
    p: { plan: ['string'] }, req: [] },
  close_week: { d: 'Save this week\'s status snapshot of a plan (red/amber/green and the report contents). The user reviews it first. Give a reason for any colour that differs from status_draft\'s suggestion.',
    p: { plan: ['string'], overall: ['string', 'green, amber or red'], schedule: ['string'], cost: ['string'], scope: ['string'],
      reasons: { type: 'object', description: 'One line per colour: { overall, schedule, cost, scope }', properties: { overall: { type: 'string' }, schedule: { type: 'string' }, cost: { type: 'string' }, scope: { type: 'string' } } },
      done: { type: 'array', items: { type: 'string' } }, next: { type: 'array', items: { type: 'string' } }, decisions: { type: 'array', items: { type: 'string' } }, notes: ['string'] }, req: ['overall'] },
});
export const WRITE = new Set(['update_tasks', 'add_tasks', 'add_raid_item', 'close_week']);

const undos = new Map();  // undo snapshots stay in memory (they can be large); the chat keeps only the key

async function pickPlan(ref) {
  const list = (await api('/api/plans')).plans.filter(p => !p.template);
  const r = String(ref || '').trim().toLowerCase();
  const meta = !r ? (S.plan ? list.find(p => p.id === S.plan.id) : list.length === 1 ? list[0] : null)
    : list.find(p => p.id.toLowerCase() === r) || list.find(p => p.name.toLowerCase() === r) || (list.filter(p => p.name.toLowerCase().includes(r)).length === 1 ? list.find(p => p.name.toLowerCase().includes(r)) : null);
  if (!meta) throw new Error(list.length ? `no plan matches “${ref || ''}”. Plans: ${list.map(p => p.name).join('; ')}` : 'there are no plans yet');
  if (!S.plan || S.plan.id !== meta.id) await openPlan(meta.id);
  if (!S.plan) throw new Error('could not open the plan');
  return S.plan;
}
function findTask(ref, plan = S.plan, extra = new Map()) {
  const s = String(ref ?? '').trim();
  if (!s) throw new Error('a task reference is empty');
  if (/^\d+$/.test(s)) {
    const byId = new Map([...rowIds()].map(([u, i]) => [i, u]));
    const uid = byId.get(+s);
    if (uid == null) throw new Error(`there is no task ${s}`);
    return plan.tasks.find(t => t.uid === uid);
  }
  if (extra.has(s.toLowerCase())) return extra.get(s.toLowerCase());
  const exact = plan.tasks.filter(t => (t.name || '').toLowerCase() === s.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`${exact.length} tasks are called “${s}” – use the ID`);
  const part = plan.tasks.filter(t => (t.name || '').toLowerCase().includes(s.toLowerCase()));
  if (part.length === 1) return part[0];
  throw new Error(part.length ? `“${s}” matches ${part.length} tasks – use the ID` : `no task called “${s}”`);
}
/** Run fn against a copy of the plan (with its own schedule) and return the copy. */
function onCopy(fn) {
  const saved = [S.plan, S.sched], copy = JSON.parse(JSON.stringify(S.plan));
  try { S.plan = copy; S.sched = E.schedule(copy, { now: E.toMin(fmt(new Date())) }); fn(copy); }
  finally { [S.plan, S.sched] = saved; }
  return copy;
}
function editTask(t, c) {
  const u = S.plan.units, out = [];
  if (c.name != null && String(c.name).trim()) { t.name = String(c.name).trim(); out.push(`name → ${t.name}`); }
  if (c.duration != null) {
    const d = E.parseDuration(String(c.duration), u);
    if (!d || d.minutes < 0) throw new Error(`“${c.duration}” is not a duration`);
    if (S.sched.byUid.get(t.uid)?.summary) throw new Error(`“${t.name}” is a summary – change its tasks instead`);
    t.duration = d; t.milestone = d.minutes === 0; out.push(`duration → ${E.formatDuration(d, u)}`);
  }
  if (c.start) { const ds = parseDateInput(c.start); if (!ds) throw new Error(`“${c.start}” is not a date`); moveTo(t, E.toMin(ds) + 480); out.push(`start no earlier than ${ds}`); }
  if (c.finish) { const ds = parseDateInput(c.finish); if (!ds) throw new Error(`“${c.finish}” is not a date`); finishAt(t, E.toMin(ds) + 17 * 60); out.push(`finish → ${ds}`); }
  if (c.percent != null) { const n = Math.max(0, Math.min(100, Math.round(+c.percent))); if (Number.isNaN(n)) throw new Error('percent must be a number'); setPct(t, n); out.push(`${n}% complete`); }
  if (c.predecessors != null) {
    const links = E.parsePredecessors(String(c.predecessors), u);
    if (!links) throw new Error(`predecessors “${c.predecessors}” – use IDs like 4, 7SS+2d`);
    const byId = new Map([...rowIds()].map(([uu, i]) => [i, uu]));
    t.links = links.map(l => { const p = byId.get(l.id); if (p == null || p === t.uid) throw new Error(`predecessor ${l.id} isn't another task`); return { pred: p, type: l.type, lag: l.lag }; });
    out.push(`predecessors → ${c.predecessors || 'none'}`);
  }
  if (c.people != null) { assign(t.uid, String(c.people)); out.push(`people → ${c.people || 'nobody'}`); }
  if (c.notes != null) { t.notes = String(c.notes); out.push('notes'); }
  if (c.hours != null) {
    const n = +c.hours;
    if (!Number.isFinite(n) || n < 0) throw new Error('hours must be a number');
    if (S.sched.byUid.get(t.uid)?.summary) throw new Error(`“${t.name}” is a summary – give its tasks hours instead`);
    setWork(t, n * 60); out.push(`${n} h of work`);
  }
  if (c.budget != null) {
    if (c.budget === '') { delete t.budget; out.push('budget cleared'); }
    else { const n = +String(c.budget).replace(/[$,\s]/g, ''); if (!Number.isFinite(n) || n < 0) throw new Error('budget must be a dollar amount'); t.budget = n; out.push(`budget $${n.toLocaleString()}`); }
  }
  if (c.deadline != null) { const ds = c.deadline ? parseDateInput(c.deadline) : ''; if (c.deadline && !ds) throw new Error(`“${c.deadline}” is not a date`); t.deadline = ds ? ds + 'T17:00' : null; out.push(`deadline → ${ds || 'none'}`); }
  if (!out.length) throw new Error(`nothing to change on “${t.name}”`);
  return out;
}
function assign(uid, text) {  // like typing in the People column
  const wanted = text.split(',').map(s => s.trim()).filter(Boolean).map(s => { const m = /^(.*?)\s*\[(\d+)\s*%?\]$/.exec(s); return { name: (m ? m[1] : s).trim(), units: m ? Math.max(1, +m[2]) / 100 : 1 }; });
  S.plan.assignments = S.plan.assignments.filter(a => a.taskUid !== uid);
  for (const w of wanted) {
    let r = S.plan.resources.find(x => x.name.toLowerCase() === w.name.toLowerCase() || (x.initials || '').toLowerCase() === w.name.toLowerCase())
      || S.plan.resources.filter(x => x.name.toLowerCase().startsWith(w.name.toLowerCase())).reduce((a, x, _, arr) => arr.length === 1 ? x : a, null);
    if (!r) { r = { uid: S.plan.resources.reduce((m, x) => Math.max(m, x.uid), 0) + 1, name: w.name, initials: w.name.split(/\s+/).map(x => x[0]).join('').slice(0, 3).toUpperCase(), maxUnits: 1 }; S.plan.resources.push(r); }
    S.plan.assignments.push({ taskUid: uid, resourceUid: r.uid, units: w.units });
  }
}
/** What moved between two schedules, in words. */
function impact(before, plan) {
  let after;
  try { after = E.schedule(plan, { now: E.toMin(fmt(new Date())) }); } catch (e) { return { text: 'The plan can\'t be scheduled: ' + e.message, bad: true }; }
  const u = plan.units, lines = [];
  const df = after.finish - before.finish;
  lines.push(`Plan finish: ${fmtDate(before.finish)} → ${fmtDate(after.finish)}${df ? ` (${df > 0 ? '+' : '−'}${E.formatDuration({ minutes: Math.abs(E.workBetween(after.calendar, Math.min(before.finish, after.finish), Math.max(before.finish, after.finish))), format: 'd' }, u)})` : ' (no change)'}`);
  const moved = [];
  for (const t of plan.tasks) {
    const a = before.byUid.get(t.uid), b = after.byUid.get(t.uid);
    if (a && b && !b.summary && (a.ef !== b.ef || a.es !== b.es)) moved.push(`${t.name}: ${fmtDate(a.es, false)}–${fmtDate(a.ef, false)} → ${fmtDate(b.es, false)}–${fmtDate(b.ef, false)}`);
  }
  if (moved.length) lines.push(`${moved.length} task${moved.length > 1 ? 's' : ''} move:`, ...moved.slice(0, 12).map(x => '  ' + x), moved.length > 12 ? `  … and ${moved.length - 12} more` : '');
  const newMiss = plan.tasks.filter(t => after.byUid.get(t.uid)?.missesDeadline && !before.byUid.get(t.uid)?.missesDeadline).map(t => t.name);
  if (newMiss.length) lines.push('Now misses its deadline: ' + newMiss.join(', '));
  const fixed = plan.tasks.filter(t => before.byUid.get(t.uid)?.missesDeadline && after.byUid.get(t.uid) && !after.byUid.get(t.uid).missesDeadline).map(t => t.name);
  if (fixed.length) lines.push('Now meets its deadline: ' + fixed.join(', '));
  const crit = t => [...t.critical].filter(x => !t.byUid.get(x).summary).join(',');
  if (crit(before) !== crit(after)) lines.push('Critical path: ' + plan.tasks.filter(t => after.critical.has(t.uid) && !after.byUid.get(t.uid).summary).map(t => t.name).slice(0, 10).join(' → '));
  const errs = after.errors.filter(e => !before.errors.some(b => b.text === e.text && b.uid === e.uid));
  if (errs.length) lines.push(...errs.map(e => `Problem: ${plan.tasks.find(t => t.uid === e.uid)?.name || ''} – ${e.text}`));
  const loops = errs.filter(e => /circular|own subtask/.test(e.text));
  if (loops.length) return { text: 'that change would make circular links (a task would end up waiting for itself), so nothing was changed. ' + loops.map(e => e.text).join('; '), bad: true };
  return { text: lines.filter(Boolean).join('\n') };
}
function preview(label, copy, edits) {
  const im = impact(S.sched, copy);
  if (im.bad) return 'Error: ' + im.text;
  return {
    summary: `${label} – ${S.plan.name}`, detail: [...edits, '', im.text].join('\n'),
    apply: async () => {
      const key = Math.random().toString(36).slice(2), before = JSON.stringify(S.plan), id = S.plan.id;
      undos.set(key, { id, before });
      change(label, p => { const keep = { id: p.id, rev: p.rev, updated: p.updated }; Object.keys(p).forEach(k => delete p[k]); Object.assign(p, copy, keep); }, { by: 'assistant' });
      await flush();
      return { text: `Done. ${label} in “${S.plan.name}”.\n${im.text}`, undo: { key, id } };
    },
  };
}

const m$ = (prof, n) => prof && prof.costAccess ? CU.money(n) : '(hidden)';
async function costTools(name, args, prof) {
  const today = fmt(new Date());
  if (name === 'who_is_free') {
    const { plans } = await PF.load(true), from = isoDate(args.from) ? args.from : today, to = isoDate(args.to) ? args.to : today;
    const rows = PF.whoIsFree(plans, from, to);
    return [`Free time ${from} to ${to}, across ${plans.length} plans (working hours × Max %, minus days off and planned work):`, ...rows.map(r => `- ${r.person.name}${r.person.category ? ' (' + r.person.category + ')' : ''}: ${Math.round(r.free)} h free of ${Math.round(r.capacity)} h${args.hours && r.free >= args.hours ? ' ✓' : ''}`)].join('\n');
  }
  if (name === 'portfolio_summary') {
    const { plans, totals } = await PF.load(true);
    return plans.map(({ meta, p, s }) => {
      const leaves = s.order.map(u => s.byUid.get(u)).filter(r => !r.summary), tot = leaves.reduce((a, r) => a + (r.dur || 0), 0);
      const pct = tot ? Math.round(leaves.reduce((a, r) => a + (r.dur || 0) * (r.pct || 0), 0) / tot) : 0, late = leaves.filter(r => (r.late || r.missesDeadline) && r.pct < 100).length;
      const nu = s.order.filter(u => s.byUid.get(u).milestone && s.byUid.get(u).pct < 100).sort((a, b) => s.byUid.get(a).ef - s.byUid.get(b).ef)[0], nx = nu != null && s.byUid.get(nu), nt = nx && p.tasks.find(t => t.uid === nu);
      const proj = p.projectId && state.projects.find(x => x.id === p.projectId), c = proj && totals.get(proj.id);
      return `- ${p.name}: ${meta.lastStatus ? `${meta.lastStatus.rag} (status ${meta.lastStatus.date})` : 'no status yet'} · finish ${E.dateOf(s.finish)} · ${pct}% done · ${late} late${nt ? ` · next milestone ${nt.name} ${E.dateOf(nx.ef)}` : ''}${c ? ` · cost ${m$(prof, c.total)}${num(proj.budgetAmount) ? ' of ' + m$(prof, num(proj.budgetAmount)) : ''}` : ''}`;
    }).join('\n') || 'There are no plans yet.';
  }
  return null;
}
export async function run(name, args, prof = {}) {
  try { const r = await costTools(name, args, prof); if (r != null) return r; } catch (e) { return 'Error: ' + e.message; }
  if (name === 'list_plans') {
    const list = (await api('/api/plans')).plans.filter(p => !p.template);
    return list.length ? JSON.stringify(list.map(p => ({ id: p.id, name: p.name, tasks: p.tasks, open: !!(S.plan && S.plan.id === p.id) })), null, 1) : 'There are no plans yet. The user can create one on the Plan tab or open an MS Project file there.';
  }
  let plan;
  try { plan = await pickPlan(args.plan); } catch (e) { return 'Error: ' + e.message; }
  const ids = rowIds(), s = S.sched, u = plan.units;
  try {
    if (name === 'get_plan') {
      const f = String(args.filter || 'all').toLowerCase(), person = plan.resources.find(r => r.name.toLowerCase().includes(f));
      const rows = s.order.filter(uid => {
        const r = s.byUid.get(uid);
        return f === 'all' || !f ? true : f === 'critical' ? r.critical : f === 'late' ? r.late || r.missesDeadline : f === 'milestones' ? r.milestone : f === 'incomplete' ? r.pct < 100
          : person ? plan.assignments.some(a => a.taskUid === uid && a.resourceUid === person.uid) : true;
      });
      await CU.ensurePlanCosts().catch(() => {});
      const chk = (CU.planCosts() || {}).checks;
      const est = uid => { const x = chk && chk.get(uid); if (!x) return ''; return ` | ${x.baselineH != null ? Math.round(x.baselineH) + ' h baseline, ' : ''}${Math.round(x.plannedH)} h planned, ${Math.round(x.actualH)} h actual, ${Math.round(x.forecastH)} h forecast${x.budget != null ? ` | budget ${prof.costAccess ? CU.money(x.budget) : '(hidden)'}${x.overBudget ? ' HEADING OVER BUDGET' : ''}` : ''}`; };
      const head = `Plan “${plan.name}” (id ${plan.id}) · starts ${fmtDate(s.start)} · finishes ${fmtDate(s.finish)}${plan.statusDate ? ' · status date ' + plan.statusDate.slice(0, 10) : ''} · ${plan.tasks.length} tasks`;
      const lines = rows.slice(0, 400).map(uid => {
        const t = plan.tasks.find(x => x.uid === uid), r = s.byUid.get(uid);
        const flags = [r.summary ? 'summary' : '', r.milestone ? 'milestone' : '', r.critical ? 'critical' : '', r.late ? 'LATE' : '', r.missesDeadline ? 'MISSES DEADLINE' : '', r.conflict ? 'conflict: ' + r.conflict : ''].filter(Boolean).join(', ');
        return `${ids.get(uid)}. ${'  '.repeat(s.outline.depth.get(uid) || 0)}${t.name} | ${E.dateOf(r.es)} → ${E.dateOf(r.ef)} | ${E.formatDuration(r.summary ? { minutes: r.dur, format: 'd' } : t.duration, u)} | ${r.pct || 0}% | pred: ${E.formatPredecessors(t.links, p => ids.get(p), u) || '-'} | ${resourceText(uid) || '-'} | slack ${E.formatDuration({ minutes: r.totalSlack || 0, format: 'd' }, u)}${t.deadline ? ' | deadline ' + t.deadline.slice(0, 10) : ''}${est(uid)}${flags ? ' | ' + flags : ''}`;
      });
      const raid = (plan.raid || []).filter(x => x.status !== 'closed').map(x => `- ${x.kind}: ${x.title}${x.owner ? ' (owner ' + x.owner + ')' : ''}${x.due ? ' due ' + x.due : ''}${x.kind === 'risk' ? ` P${x.probability}×I${x.impact}` : ''}${(x.taskUids || []).length ? ' – tasks ' + x.taskUids.map(t => ids.get(t)).filter(Boolean).join(', ') : ''}`);
      return [head, 'ID. name | start → finish | duration | % | predecessors | people | total slack | flags', ...lines, rows.length > 400 ? `… ${rows.length - 400} more rows` : '',
        `People: ${plan.resources.map(r => r.name + (r.me ? ' (the user)' : '')).join(', ')}`, raid.length ? 'Open issues and risks:\n' + raid.join('\n') : 'No open issues or risks.'].filter(Boolean).join('\n');
    }
    if (name === 'simulate' || name === 'update_tasks') {
      const changes = Array.isArray(args.changes) ? args.changes : [];
      if (!changes.length) return 'Error: changes is empty.';
      const edits = [];
      const copy = onCopy(() => { for (const c of changes) { const t = findTask(c.task); edits.push(`${ids.get(t.uid)}. ${t.name}: ${editTask(t, c).join(', ')}`); } });
      if (name === 'simulate') { const im = impact(s, copy); return `What-if (nothing saved):\n${edits.join('\n')}\n\n${im.text}`; }
      return preview(`Update ${changes.length} task${changes.length > 1 ? 's' : ''}`, copy, edits);
    }
    if (name === 'add_tasks') {
      const items = Array.isArray(args.tasks) ? args.tasks : [];
      if (!items.length) return 'Error: tasks is empty.';
      const edits = [];
      const copy = onCopy(p => {
        const added = new Map();
        let next = p.tasks.reduce((m, t) => Math.max(m, t.uid), 0);
        for (const it of items) {
          const name = String(it.name || '').trim();
          if (!name) throw new Error('every task needs a name');
          const d = E.parseDuration(String(it.duration ?? '1d'), u);
          if (!d) throw new Error(`“${it.duration}” is not a duration`);
          const parent = it.parent ? findTask(it.parent, p, added) : null, after = it.after ? findTask(it.after, p, added) : null;
          const t = { uid: ++next, name, parentUid: parent ? parent.uid : after ? after.parentUid ?? null : null, duration: { ...d }, milestone: d.minutes === 0, links: [], percent: 0, priority: 500,
            notes: String(it.notes || ''), constraint: { type: 'ASAP' }, baselines: {}, custom: {}, deadline: it.deadline && parseDateInput(it.deadline) ? parseDateInput(it.deadline) + 'T17:00' : null };
          const anchor = after || parent || null;
          if (anchor) { const blk = [anchor.uid, ...descendants(anchor.uid)], at = Math.max(...blk.map(x => p.tasks.findIndex(y => y.uid === x)), ...[...added.values()].filter(x => x.parentUid === t.parentUid).map(x => p.tasks.indexOf(x))); p.tasks.splice(at + 1, 0, t); }
          else p.tasks.push(t);
          for (const dep of it.depends_on || []) { const pr = findTask(dep, p, added); t.links.push({ pred: pr.uid, type: 'FS', lag: { minutes: 0, format: 'd' } }); }
          if (it.people) assign(t.uid, String(it.people));
          added.set(name.toLowerCase(), t);
          edits.push(`+ ${t.milestone ? '◆ ' : ''}${name} (${E.formatDuration(d, u)})${parent ? ' under ' + parent.name : ''}${t.links.length ? ' after ' + t.links.map(l => p.tasks.find(x => x.uid === l.pred).name).join(', ') : ''}${it.people ? ' · ' + it.people : ''}`);
        }
      });
      return preview(`Add ${items.length} task${items.length > 1 ? 's' : ''}`, copy, edits);
    }
    if (name === 'cost_summary') {
      await CU.ensurePlanCosts();
      const pc = CU.planCosts();
      if (!pc) return 'Error: the costs could not be loaded.';
      const ev = pc.ev, hv = pc.evH, M = n => m$(prof, n);
      const per = new Map();
      for (const x of pc.actual.lines) { const k = x.person ? x.person.name : x.line.name || 'non-labor'; const a = per.get(k) || { h: 0, c: 0 }; a.h += x.line.hours || 0; a.c += x.cost; per.set(k, a); }
      const months = new Map();
      for (const x of pc.actual.lines) { const k = x.line.date.slice(0, 7); const a = months.get(k) || { h: 0, c: 0 }; a.h += x.line.hours || 0; a.c += x.cost; months.set(k, a); }
      return [`Costs of “${plan.name}”${pc.proj ? ` (project ${projectLabel(pc.proj)}, cost model ${pc.model.name})` : ' (not linked to a project: no ERP costs)'}.${prof.costAccess ? '' : ' Dollar amounts are hidden: this AI profile does not allow cost data.'}`,
        `ERP posted through ${pc.posted || '–'}${pc.unposted.length ? `; plus ${Math.round(pc.unposted.reduce((s2, x) => s2 + (x.line.hours || 0), 0))} h of the user's own timesheet not yet posted` : ''}. Status date ${E.dateOf(pc.statusMin)}.`,
        `Budget ${pc.budget ? M(pc.budget) : 'not set'} · cost to date ${M(pc.actual.total)} (${Math.round(pc.actual.hours)} h) · baseline cost (BAC) ${M(ev.bac)} (${Math.round(hv.bac)} h)`,
        `Planned value ${M(ev.pv)} · earned value ${M(ev.ev)} (${Math.round(hv.ev)} h earned of ${Math.round(hv.pv)} h planned by now) · CPI ${ev.cpi != null ? ev.cpi.toFixed(2) : '–'} · SPI ${ev.spi != null ? ev.spi.toFixed(2) : '–'}`,
        `Forecast at completion ${M(ev.eac ?? ev.eacBottomUp)} (if the rest goes to plan: ${M(ev.eacPlan)}; bottom-up: ${M(ev.eacBottomUp)}) · ${pc.runOut != null ? 'money runs out ' + E.dateOf(pc.runOut * E.DAY) : 'the budget lasts to the finish'}`,
        ...pc.warnings.map(w => 'Warning: ' + w.text),
        ...(() => { const over = [...pc.checks.entries()].filter(([u, x]) => !S.sched.byUid.get(u).summary && (x.overBudget || x.overHours));
          return over.length ? ['Tasks heading over their budget or hour estimate:', ...over.map(([u, x]) => `- ${plan.tasks.find(t => t.uid === u).name}: ${Math.round(x.forecastH)} h forecast vs ${Math.round(x.plannedH)} h planned${x.baselineH != null ? ` (${Math.round(x.baselineH)} h in the baseline)` : ''}${x.budget != null ? `; forecast ${M(x.budgetForecast)} vs budget ${M(x.budget)}` : ''}`)] : ['No task is heading over its budget or planned hours.']; })(),
        'By person:', ...[...per].sort((a, b) => b[1].c - a[1].c).map(([n, a]) => `- ${n}: ${Math.round(a.h * 10) / 10} h, ${M(a.c)}`),
        'By month:', ...[...months].sort().map(([k, a]) => `- ${k}: ${Math.round(a.h)} h, ${M(a.c)}`)].join('\n');
    }
    if (name === 'status_draft') {
      await CU.ensurePlanCosts().catch(() => {}); await ST.loadStatus(plan.id, true);
      const d = ST.draft(), n = d.n;
      return [`Draft status of “${plan.name}” as of ${n.statusDate}${d.prev ? ` (last status ${d.prev.statusDate}: ${d.prev.rag.overall})` : ' (first status)'}.`,
        `Suggested: overall ${d.rag.overall}; schedule ${d.rag.schedule}${d.rag.why.schedule ? ' – ' + d.rag.why.schedule : ''}; cost ${d.rag.cost}${d.rag.why.cost ? ' – ' + d.rag.why.cost : ''}; scope ${d.rag.scope}${d.rag.why.scope ? ' – ' + d.rag.why.scope : ''}`,
        `Finish ${n.finish}${n.baselineFinish ? ' (baseline ' + n.baselineFinish + ')' : ''} · ${n.pct}% done, ${n.pctExpected}% expected${n.ev ? ` · CPI ${n.ev.cpi ?? '–'} · SPI ${n.ev.spi ?? '–'}${prof.costAccess ? ` · cost ${CU.money(n.ev.ac)} · forecast ${CU.money(n.ev.eac)}` : ''}` : ''}`,
        'Done this week:', ...(d.done.length ? d.done.map(x => '- ' + x) : ['- nothing finished']), 'Next week:', ...d.next.map(x => '- ' + x),
        d.decisions.length ? 'Decisions or help needed:\n' + d.decisions.map(x => '- ' + x).join('\n') : ''].filter(Boolean).join('\n');
    }
    if (name === 'close_week') {
      await CU.ensurePlanCosts().catch(() => {}); await ST.loadStatus(plan.id, true);
      const d = ST.draft(), ok = c => ['green', 'amber', 'red'].includes(c);
      const choice = { reasons: { ...(args.reasons || {}) }, by: 'assistant' };
      for (const k of ['overall', 'schedule', 'cost', 'scope']) choice[k] = ok(String(args[k] || '').toLowerCase()) ? String(args[k]).toLowerCase() : d.rag[k];
      for (const k of ['schedule', 'cost', 'scope']) if (!choice.reasons[k] && d.rag.why[k]) choice.reasons[k] = d.rag.why[k];
      Object.assign(choice, { done: Array.isArray(args.done) ? args.done.map(String) : d.done, next: Array.isArray(args.next) ? args.next.map(String) : d.next, decisions: Array.isArray(args.decisions) ? args.decisions.map(String) : d.decisions, notes: String(args.notes || '') });
      const snap = ST.buildSnapshot(d, choice), prev = (S.statusCache.snaps || []).find(x => x.id === snap.id) || null;
      return {
        summary: `Close the week (${snap.statusDate}) – ${plan.name}`,
        detail: [`Overall ${choice.overall}${choice.reasons.overall ? ': ' + choice.reasons.overall : ''}`, `Schedule ${choice.schedule} · cost ${choice.cost} · scope ${choice.scope}`,
          `Done: ${choice.done.join('; ') || '–'}`, `Next: ${choice.next.join('; ') || '–'}`, choice.decisions.length ? `Decisions: ${choice.decisions.join('; ')}` : '', prev ? '(replaces the status already saved for this date)' : ''].filter(Boolean).join('\n'),
        apply: async () => {
          await ST.saveSnapshot(snap);
          const key = Math.random().toString(36).slice(2);
          undos.set(key, { kind: 'status', id: plan.id, snapId: snap.id, prev });
          return { text: `Saved the status of “${plan.name}” for ${snap.statusDate}. The user can send the report from Plan → Status → Report.`, undo: { key, id: plan.id } };
        },
      };
    }
    if (name === 'add_raid_item') {
      const kind = String(args.kind || '').toLowerCase();
      if (!['risk', 'issue', 'action', 'decision'].includes(kind)) return 'Error: kind must be risk, issue, action or decision.';
      if (!String(args.title || '').trim()) return 'Error: title is required.';
      const taskUids = (args.tasks || []).map(x => findTask(x).uid);
      const item = { id: Math.random().toString(36).slice(2, 9), kind, title: String(args.title).trim(), description: String(args.description || ''), owner: String(args.owner || ''),
        due: isoDate(args.due) ? args.due : '', status: 'open', probability: Math.max(0, Math.min(5, +args.probability || (kind === 'risk' ? 3 : 0))), impact: Math.max(0, Math.min(5, +args.impact || (kind === 'risk' ? 3 : 0))),
        mitigation: String(args.mitigation || ''), taskUids, created: fmt(new Date()), by: 'assistant' };
      const copy = JSON.parse(JSON.stringify(S.plan)); (copy.raid ||= []).push(item);
      return preview(`Log ${kind} “${item.title}”`, copy, [`${kind}: ${item.title}${item.owner ? ' · owner ' + item.owner : ''}${item.due ? ' · due ' + item.due : ''}${kind === 'risk' ? ` · P${item.probability}×I${item.impact}` : ''}${taskUids.length ? ' · tasks ' + taskUids.map(x => ids.get(x)).join(', ') : ''}`, item.description].filter(Boolean));
    }
  } catch (e) { return 'Error: ' + e.message; }
  return `Error: there is no tool called ${name}.`;
}

/** Undo an applied assistant change: put the plan back as it was (as a new, undoable change). */
export async function undo(u) {
  const snap = undos.get(u.key);
  if (snap && snap.kind === 'status') {
    if (snap.prev) await api(`/api/plans/${snap.id}/status`, { snapshot: snap.prev }, 'PUT');
    else await api(`/api/plans/${snap.id}/status/remove`, { id: snap.snapId });
    await ST.loadStatus(snap.id, true).catch(() => {});
    undos.delete(u.key);
    return;
  }
  if (!snap) throw new Error('That change can no longer be undone here (the page was reloaded). Use Undo on the Plan tab or restore the .bak.json in data/plans.');
  if (!S.plan || S.plan.id !== snap.id) await openPlan(snap.id);
  const old = JSON.parse(snap.before);
  change('Undo the assistant\'s change', p => { const keep = { id: p.id, rev: p.rev, updated: p.updated }; Object.keys(p).forEach(k => delete p[k]); Object.assign(p, old, keep); }, { by: 'you' });
  await flush();
  undos.delete(u.key);
}
