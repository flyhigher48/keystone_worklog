// Keystone – the project brief: the Brief.md note (read and written), one report model built from the plan, costs,
// status snapshots and the weekly log, the plain-language sentences, the self-contained HTML brief and the slide list
// for PowerPoint. Pure functions, no DOM – tested with node. What the user removed in "Review before sharing" is taken
// out of the model here, once, so every output (HTML, PowerPoint) says the same thing.
import * as E from './engine.js';
import * as C from './costs.js';

// ---------- the Brief.md note ----------
/** Brief.md → { front: {key: value}, sections: [{ title, body }] }. Frontmatter is simple `key: value` lines. */
export function parseBrief(md) {
  const text = String(md || '').replace(/\r\n/g, '\n');
  const front = {};
  let rest = text;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (kv) front[kv[1]] = unquote(kv[2].trim());
    }
    rest = text.slice(m[0].length);
  }
  const sections = [], lines = rest.split('\n');
  let cur = { title: '', body: [] }, fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const hm = !fence && /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (hm) { sections.push(cur); cur = { title: hm[1].trim(), body: [] }; continue; }
    cur.body.push(line);
  }
  sections.push(cur);
  return { front, sections: sections.map(s => ({ title: s.title, body: s.body.join('\n').replace(/^\n+|\s+$/g, '') })).filter((s, i) => i > 0 || s.body) };
}
const unquote = v => (/^"(.*)"$/.test(v) ? v.slice(1, -1).replace(/\\"/g, '"') : /^'(.*)'$/.test(v) ? v.slice(1, -1).replace(/''/g, "'") : v);
const quote = v => (/^[\w .,/()&+-]*$/.test(v) && v.trim() === v && !/^(true|false|null|\d.*)$/i.test(v) ? v : `"${String(v).replace(/"/g, '\\"')}"`);
/** The parsed brief → Brief.md text. Unknown frontmatter keys and sections are kept, in their order. */
export function serializeBrief(b) {
  const front = Object.entries(b.front || {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${quote(String(v))}`);
  const parts = [front.length ? `---\n${front.join('\n')}\n---\n` : ''];
  for (const s of b.sections || []) parts.push(s.title ? `## ${s.title}\n\n${s.body.trim()}\n` : `${s.body.trim()}\n`);
  return parts.filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n');
}
export const sectionOf = (b, title) => ((b && b.sections) || []).find(s => s.title.toLowerCase() === title.toLowerCase());
/** Set (or add) one section's body. */
export function setSection(b, title, body) {
  const s = sectionOf(b, title);
  if (s) s.body = body; else b.sections.push({ title, body });
  return b;
}
/** The sections the brief starts with, in order; others the user adds are kept after them. */
export const BRIEF_SECTIONS = ['Background', 'Objectives', 'Scope', 'Success criteria', 'Assumptions and constraints', 'Stakeholders', 'Key facts', 'Key links', 'Contacts', 'Lessons learned'];
export function briefTemplate({ planId, name, client, summary, nwa, phases = [] }) {
  return serializeBrief({
    front: { keystone: 'brief', plan: planId, summary: summary || `${name}${phases.length ? ': ' + phases.slice(0, 4).join(', ').toLowerCase() : ''}.`, client: client || '', cover: '' },
    sections: [
      { title: '', body: `# ${name} – project brief\n\nThe living summary of this project. Edit it here or in Keystone (Plan → Brief). The numbers – status, schedule, costs, risks – are added by Keystone when you share the brief.` },
      { title: 'Background', body: 'Why this project exists.' },
      { title: 'Objectives', body: '- ' },
      { title: 'Scope', body: '### In scope\n- \n\n### Out of scope\n- ' },
      { title: 'Success criteria', body: '- ' },
      { title: 'Assumptions and constraints', body: '- ' },
      { title: 'Stakeholders', body: '| Who | Cares about | How often they hear from us |\n| --- | --- | --- |\n|  |  |  |' },
      { title: 'Key facts', body: `- **Client:** ${client || ''}\n- **NWA:** ${nwa || ''}\n- **Contract:** \n- **Location:** \n- **Funding:** ` },
      { title: 'Key links', body: '- [[ ]]' },
      { title: 'Contacts', body: '| Name | Role | Organisation | Email | Phone |\n| --- | --- | --- | --- | --- |\n|  |  |  |  |  |' },
      { title: 'Lessons learned', body: '' },
    ] });
}
/** "- a\n- b" → ['a', 'b'] (also numbered lists); empty items dropped. */
export function bullets(body) {
  return String(body || '').split('\n').map(l => /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l)).filter(Boolean).map(m => m[1].trim()).filter(Boolean);
}
/** "- **Label:** value" lines → [{ label, value }] */
export function facts(body) {
  return String(body || '').split('\n').map(l => /^\s*[-*]\s+(?:\*\*)?([^:*]+?)(?::\*\*|\*\*:|:)\s*(.*)$/.exec(l)).filter(Boolean)
    .map(m => ({ label: m[1].trim(), value: m[2].trim() })).filter(f => f.value);
}
/** A Markdown table → [{ header: value }] (the separator row and empty rows dropped). */
export function table(body) {
  const rows = String(body || '').split('\n').filter(l => /^\s*\|.*\|\s*$/.test(l)).map(l => l.trim().slice(1, -1).split('|').map(c => c.trim()));
  if (rows.length < 2) return [];
  const head = rows[0].map(h => h.toLowerCase());
  return rows.slice(1).filter(r => !r.every(c => /^:?-*:?$/.test(c))).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] || '']))).filter(o => Object.values(o).some(Boolean));
}
/** "- [[path|label]]", "- [label](url)", "- path" → [{ label, target, vault }] */
export function links(body) {
  return bullets(body).map(t => {
    let m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]\s*(.*)$/.exec(t);
    if (m) return m[1].trim() ? { label: (m[2] || m[1].split('/').pop()).trim(), target: m[1].trim(), vault: true, note: m[3] || '' } : null;
    m = /^\[([^\]]+)\]\(([^)]+)\)\s*(.*)$/.exec(t);
    if (m) return { label: m[1].trim(), target: m[2].trim(), vault: !/^[a-z]+:/i.test(m[2]), note: m[3] || '' };
    return { label: t.split('/').pop(), target: t, vault: !/^[a-z]+:/i.test(t), note: '' };
  }).filter(Boolean);
}
/** "### In scope … ### Out of scope …" → { in: [], out: [] } */
export function scope(body) {
  const out = { in: [], out: [] };
  let cur = null;
  for (const line of String(body || '').split('\n')) {
    const h = /^###\s+(.*)$/.exec(line);
    if (h) { cur = /out/i.test(h[1]) ? 'out' : 'in'; continue; }
    const b = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (b && b[1].trim()) out[cur || 'in'].push(b[1].trim());
  }
  return out;
}
const safeName = s => String(s || '').replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/^[ .]+|[ .]+$/g, '').slice(0, 80).trim() || 'Untitled';
/** Where a plan's brief lives in the vault: <tracker folder>/Projects/<project name>/Brief.md */
export const briefFolder = (folder, label) => `${(folder || 'Keystone').replace(/^\/+|\/+$/g, '')}/Projects/${safeName(label)}`;

// ---------- small helpers ----------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDay = (iso, year = true) => { if (!iso) return ''; const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return `${MON[m - 1]} ${d}${year ? ', ' + y : ''}`; };
const dayMin = iso => E.toMin(String(iso).slice(0, 10));
const wdays = (cal, a, b, per) => Math.round(E.workBetween(cal, a, b) / (per || 480));
const RAG = { green: 'On track', amber: 'At risk', red: 'Off track' };
export const ragLabel = r => RAG[r] || 'No status';
export function money(n, cur = '$', short = false) {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (short && a >= 1e6) return `${s}${cur}${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (short && a >= 1e4) return `${s}${cur}${Math.round(a / 1e3)}k`;
  return `${s}${cur}${Math.round(a).toLocaleString('en-US')}`;
}
const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);

// ---------- the report model ----------
/**
 * Everything the brief can show, as plain data. `removed` holds what the user unticked in the review: section keys
 * ('section:funding', 'section:fundingByPerson', …) and item keys ('raid:r1', 'log:l_…', 'contact:2', 'link:0', 'task:7', 'person:Maria Lopez').
 * in: { plan, sched, ids, pc (planCosts or null), snaps, log, brief (parsed), project, now (YYYY-MM-DD), currency, baselineN }
 * opts: { period: 'sinceLast' | 'month' | 'all', removed: Set }
 */
export function buildReport(inp, opts = {}) {
  const { plan, sched: s, ids = new Map(), pc = null, snaps = [], log = [], brief = null, project = null, currency = '$', baselineN = 0 } = inp;
  const removed = opts.removed instanceof Set ? opts.removed : new Set(opts.removed || []);
  const now = inp.now || E.dateOf(Date.now() / 60000), nowMin = dayMin(now) + 17 * 60, cal = s.calendar, per = (plan.units || {}).minutesPerDay || 480;
  const on = k => !removed.has('section:' + k), keep = k => !removed.has(k);
  const M = n => money(n, currency), Ms = n => money(n, currency, true);
  const task = u => plan.tasks.find(t => t.uid === u), rec = u => s.byUid.get(u);
  // the period this brief covers
  const lastShare = (plan.share || {}).lastAt || null;
  const firstOfMonth = now.slice(0, 8) + '01', planStart = E.dateOf(s.start);
  const since = opts.period === 'all' ? planStart : opts.period === 'month' ? firstOfMonth : (lastShare && lastShare < now ? lastShare : (snaps.length > 1 ? snaps[snaps.length - 2].statusDate : E.dateOf(dayMin(now) - 14 * E.DAY)));
  const sinceMin = dayMin(since), periodLabel = opts.period === 'all' ? 'since the start' : `since ${fmtDay(since, false)}`;
  const last = snaps[snaps.length - 1] || null, rag = last ? last.rag : null;
  const leaves = s.order.filter(u => !rec(u).summary), lr = leaves.map(rec);
  const tot = lr.reduce((a, r) => a + (r.dur || 0), 0);
  const pctDone = tot ? Math.round(lr.reduce((a, r) => a + (r.dur || 0) * (r.pct || 0), 0) / tot) : 0;
  const pctExp = tot ? Math.round(lr.reduce((a, r) => a + (r.dur || 0) * E.expectedPct(cal, r, nowMin), 0) / tot) : 0;
  const blTasks = plan.tasks.map(t => (t.baselines || {})[baselineN]).filter(Boolean);
  const blFinish = blTasks.length ? Math.max(...blTasks.map(b => E.toMin(b.finish) || 0)) : null;
  const slip = blFinish ? wdays(cal, blFinish, s.finish, per) : null;
  const milestones = s.order.filter(u => rec(u).milestone).map(u => {
    const t = task(u), r = rec(u), b = (t.baselines || {})[baselineN];
    const was = snapAt(snaps, since);
    const before = was && was.milestones ? was.milestones[u] : null;
    return { key: 'task:' + u, uid: u, id: ids.get(u), name: t.name, baseline: b ? b.finish.slice(0, 10) : '', forecast: E.dateOf(r.ef),
      moved: b ? wdays(cal, E.toMin(b.finish), r.ef, per) : null, movedSince: before ? Math.round((r.ef - dayMin(before)) / E.DAY) : null,
      done: (r.pct || 0) >= 100, late: !!(r.late || r.missesDeadline) && (r.pct || 0) < 100 };
  }).filter(m => keep(m.key));
  const nextMs = milestones.filter(m => !m.done).sort((a, b) => a.forecast.localeCompare(b.forecast))[0] || null;
  const raid = (plan.raid || []).filter(x => keep('raid:' + x.id));
  const openRisks = raid.filter(x => x.kind === 'risk' && x.status !== 'closed'), openIssues = raid.filter(x => x.kind === 'issue' && x.status !== 'closed');
  const highRisks = openRisks.filter(x => (x.probability || 0) * (x.impact || 0) >= 15);
  const model = { meta: {}, sections: [] };
  const add = (key, title, body) => { if (on(key) && body) model.sections.push({ key, title, ...body }); };

  // ----- cover -----
  const facts0 = brief ? facts((sectionOf(brief, 'Key facts') || {}).body) : [];
  model.meta = {
    name: plan.name, client: (brief && brief.front.client) || (facts0.find(f => /client/i.test(f.label)) || {}).value || '', summary: (brief && brief.front.summary) || '',
    cover: (brief && brief.front.cover) || '', date: now, period: periodLabel, since, rag: rag ? rag.overall : null, ragLabel: ragLabel(rag && rag.overall),
    reason: rag && rag.reasons ? rag.reasons.overall || '' : '', project: project ? `${project.network}/${project.activity}` : '', removedAny: removed.size > 0,
  };
  // ----- at a glance -----
  const f = fundingNumbers(pc);
  const sentence = glanceSentence({ slip, pctDone, pctExp, f, highRisks, openIssues, nextMs, M: Ms });
  add('glance', 'At a glance', {
    sentence,
    tiles: [
      { label: 'Finish', value: fmtDay(E.dateOf(s.finish), false), sub: slip == null ? 'no baseline yet' : slip > 0 ? `${slip} working day${slip > 1 ? 's' : ''} later than planned` : slip < 0 ? `${-slip} working day${slip < -1 ? 's' : ''} early` : 'on the baseline', tone: slip > 0 ? 'bad' : 'ok' },
      { label: 'Progress', value: `${pctDone}%`, sub: `${pctExp}% expected by now`, tone: pctDone + 5 < pctExp ? 'bad' : 'ok' },
      ...(f && on('funding') ? [{ label: 'Cost to date', value: Ms(f.spent), sub: f.budget ? `${pct(f.spent, f.budget)}% of the ${Ms(f.budget)} budget` : 'no budget set', tone: f.budget && f.spent > f.budget ? 'bad' : 'ok' }] : []),
      { label: 'Next milestone', value: nextMs ? nextMs.name : 'None left', sub: nextMs ? fmtDay(nextMs.forecast, false) + (nextMs.late ? ' · late' : '') : '', tone: nextMs && nextMs.late ? 'bad' : 'ok' },
      { label: 'Risks & issues', value: `${openRisks.length} · ${openIssues.length}`, sub: `${highRisks.length} high risk${highRisks.length === 1 ? '' : 's'} · ${openIssues.length} issue${openIssues.length === 1 ? '' : 's'}`, tone: highRisks.length ? 'bad' : 'ok' },
    ],
  });
  // ----- what changed -----
  const changes = [];
  for (const m of milestones) if (m.movedSince) changes.push({ key: m.key, text: `${m.name} moved ${Math.abs(m.movedSince)} day${Math.abs(m.movedSince) === 1 ? '' : 's'} ${m.movedSince > 0 ? 'later' : 'earlier'} (now ${fmtDay(m.forecast, false)})`, tone: m.movedSince > 0 ? 'bad' : 'ok' });
  if (f && on('funding')) {
    const spentIn = (pc.actual.lines || []).filter(x => x.line.date >= since).reduce((a, x) => a + x.cost, 0);
    if (spentIn) changes.push({ key: 'change:spent', text: `${Ms(spentIn)} spent ${periodLabel}`, tone: '' });
  }
  for (const x of raid) {
    if (x.created && x.created >= since && x.kind !== 'decision') changes.push({ key: 'raid:' + x.id, text: `New ${x.kind}: ${x.title}`, tone: x.kind === 'issue' || x.kind === 'risk' ? 'bad' : '' });
    if (x.closed && x.closed >= since && x.kind !== 'decision') changes.push({ key: 'raid:' + x.id, text: `Closed ${x.kind}: ${x.title}`, tone: 'ok' });
    if (x.kind === 'decision' && x.decided && x.decided >= since) changes.push({ key: 'raid:' + x.id, text: `Decided: ${x.title}`, tone: '' });
  }
  const doneTasks = leaves.filter(u => { const t = task(u), r = rec(u); const fin = (t.actualFinish || E.fromMin(r.ef)).slice(0, 10); return (r.pct || 0) >= 100 && fin >= since && fin <= now; })
    .map(u => ({ key: 'task:' + u, text: (rec(u).milestone ? '◆ ' : '') + task(u).name, date: (task(u).actualFinish || E.fromMin(rec(u).ef)).slice(0, 10) })).filter(x => keep(x.key));
  if (doneTasks.length) changes.push({ key: 'change:done', text: `${doneTasks.length} task${doneTasks.length > 1 ? 's' : ''} finished`, tone: 'ok' });
  add('changes', `What changed ${periodLabel}`, changes.filter(c => keep(c.key)).length ? { items: changes.filter(c => keep(c.key)).slice(0, 12) } : { items: [], empty: 'Nothing has changed since the last brief.' });
  // ----- asks: decisions and help needed -----
  const asks = [
    ...raid.filter(x => x.kind === 'decision' && x.status !== 'closed' && !['decided', 'superseded'].includes(x.decisionStatus)).map(x => ({ key: 'raid:' + x.id, text: x.title, kind: 'Decision', owner: x.owner || '', due: x.due || '' })),
    ...raid.filter(x => x.kind === 'action' && x.status !== 'closed' && x.due && x.due <= E.dateOf(dayMin(now) + 14 * E.DAY)).map(x => ({ key: 'raid:' + x.id, text: x.title, kind: 'Action', owner: x.owner || '', due: x.due })),
    ...log.filter(e => e.kind === 'problem' && e.at.slice(0, 10) >= since).map(e => ({ key: 'log:' + e.id, text: firstLine(e.text), kind: 'Help needed', owner: '', due: '' })),
  ].filter(a => keep(a.key));
  add('asks', 'Decisions and help needed', asks.length ? { items: asks } : null);
  // ----- about -----
  if (brief) {
    const sec = t => (sectionOf(brief, t) || {}).body || '';
    const sc = scope(sec('Scope'));
    const extra = brief.sections.filter(x => x.title && !BRIEF_SECTIONS.map(t => t.toLowerCase()).includes(x.title.toLowerCase()) && x.body.trim() && !/^log$/i.test(x.title));
    const about = {
      background: clean(sec('Background')), objectives: bullets(sec('Objectives')), inScope: sc.in, outScope: sc.out,
      success: bullets(sec('Success criteria')), assumptions: bullets(sec('Assumptions and constraints')), stakeholders: table(sec('Stakeholders')),
      lessons: bullets(sec('Lessons learned')), extra: extra.map(x => ({ title: x.title, body: x.body })),
    };
    if (Object.values(about).some(v => (Array.isArray(v) ? v.length : v))) add('about', 'About the project', { about });
  }
  // ----- this period -----
  const highlights = log.filter(e => e.kind !== 'system' && e.at.slice(0, 10) >= since && keep('log:' + e.id)).sort((a, b) => b.at.localeCompare(a.at))
    .map(e => ({ key: 'log:' + e.id, kind: e.kind, date: e.at.slice(0, 10), text: e.text }));
  const ahead = dayMin(now) + 14 * E.DAY;
  const next = leaves.filter(u => { const r = rec(u); return (r.pct || 0) < 100 && r.es <= ahead && r.ef >= dayMin(now); })
    .sort((a, b) => rec(a).ef - rec(b).ef).map(u => ({ key: 'task:' + u, text: (rec(u).milestone ? '◆ ' : '') + task(u).name, due: E.dateOf(rec(u).ef), pct: rec(u).pct || 0, people: peopleOn(plan, u) })).filter(x => keep(x.key));
  add('period', `Progress ${periodLabel}`, { done: doneTasks, highlights, next: next.slice(0, 12) });
  // ----- two-week look-ahead by person -----
  const byPerson = new Map();
  for (const n of next) for (const p of (n.people.length ? n.people : ['Unassigned'])) { if (!keep('person:' + p)) continue; (byPerson.get(p) || byPerson.set(p, []).get(p)).push(n); }
  add('lookahead', 'Next two weeks', byPerson.size ? { people: [...byPerson.entries()].map(([name, items]) => ({ name, items })) } : null);
  // ----- the plan -----
  const top = (s.outline.kids.get(null) || []).filter(u => keep('task:' + u));
  const phases = top.map(u => { const t = task(u), r = rec(u), b = (t.baselines || {})[baselineN]; return { name: t.name, start: E.dateOf(r.es), finish: E.dateOf(r.ef), pct: r.pct || 0, summary: !!r.summary, milestone: !!r.milestone, blStart: b ? b.start.slice(0, 10) : '', blFinish: b ? b.finish.slice(0, 10) : '', critical: !!r.critical }; });
  add('plan', 'The plan', {
    start: planStart, finish: E.dateOf(s.finish), baselineFinish: blFinish ? E.dateOf(blFinish) : '', slip, milestones, phases,
    trend: snaps.length >= 2 ? snaps.slice(-10).map(x => ({ date: x.statusDate || x.date, milestones: x.milestones || {} })) : [],
    sentence: slip == null ? `The plan runs ${fmtDay(planStart, false)} to ${fmtDay(E.dateOf(s.finish))}.` : slip > 0 ? `Forecast to finish ${fmtDay(E.dateOf(s.finish))}, ${slip} working day${slip > 1 ? 's' : ''} later than the baseline (${fmtDay(E.dateOf(blFinish), false)}).` : `Forecast to finish ${fmtDay(E.dateOf(s.finish))}${slip < 0 ? `, ${-slip} working days ahead of the baseline` : ', on the baseline'}.`,
  });
  // ----- funding -----
  if (f) {
    const phaseRows = top.filter(u => rec(u).summary || !rec(u).milestone).map(u => ({ key: 'task:' + u, name: task(u).name, baseline: pc.roll.baseline.get(u) || 0, actual: pc.roll.actual.get(u) || 0, forecast: (pc.checks && pc.checks.get(u) || {}).forecastC || 0 }));
    const people = new Map();
    for (const x of pc.actual.lines) { const n = x.person ? x.person.name : x.line.name || (C.isLabor(x.line) ? 'Unmatched' : 'Non-labor'); const a = people.get(n) || { hours: 0, cost: 0 }; a.hours += x.line.hours || 0; a.cost += x.cost; people.set(n, a); }
    const over = pc.checks ? [...pc.checks.entries()].filter(([u, x]) => !rec(u).summary && x.overBudget && keep('task:' + u)).map(([u, x]) => ({ name: task(u).name, budget: x.budget, forecast: x.budgetForecast })) : [];
    const curve = sCurve(plan, s, pc, baselineN);
    add('funding', 'Funding', {
      sentence: fundingSentence(f, pctDone, Ms), budget: f.budget, spent: f.spent, forecast: f.eac, contingency: f.contingency, runOut: f.runOut, cpi: f.cpi, spi: f.spi, beforeCost: f.beforeCost,
      phases: phaseRows, overBudget: over, curve, currency,
      byPerson: on('fundingByPerson') ? [...people.entries()].filter(([n]) => keep('person:' + n)).sort((a, b) => b[1].cost - a[1].cost).map(([name, a]) => ({ key: 'person:' + name, name, hours: a.hours, cost: a.cost })) : null,
    });
  }
  // ----- issues and risks -----
  const score = x => (x.probability || 0) * (x.impact || 0);
  add('risks', 'Issues and risks', {
    matrix: [5, 4, 3, 2, 1].map(im => [1, 2, 3, 4, 5].map(pr => openRisks.filter(x => (x.impact || 0) === im && (x.probability || 0) === pr).length)),
    risks: openRisks.sort((a, b) => score(b) - score(a)).map(x => ({ key: 'raid:' + x.id, title: x.title, score: score(x), p: x.probability || 0, i: x.impact || 0, owner: x.owner || '', due: x.due || '', mitigation: x.mitigation || '', status: x.status })),
    issues: openIssues.map(x => ({ key: 'raid:' + x.id, title: x.title, owner: x.owner || '', due: x.due || '', description: x.description || '' })),
    sentence: openRisks.length || openIssues.length ? `${openRisks.length} open risk${openRisks.length === 1 ? '' : 's'} (${highRisks.length} high) and ${openIssues.length} open issue${openIssues.length === 1 ? '' : 's'}.${highRisks[0] ? ` The biggest risk: ${highRisks[0].title}.` : ''}` : 'No open risks or issues.',
  });
  // ----- decisions -----
  const decisions = raid.filter(x => x.kind === 'decision');
  const made = decisions.filter(x => x.decisionStatus === 'decided' || x.status === 'closed').sort((a, b) => String(b.decided || b.closed || '').localeCompare(String(a.decided || a.closed || '')))
    .map(x => ({ key: 'raid:' + x.id, title: x.title, date: x.decided || x.closed || '', by: x.decidedBy || x.owner || '', rationale: x.rationale || x.description || '', options: x.options || [], impact: x.decisionImpact || null, superseded: x.decisionStatus === 'superseded' }));
  add('decisions', 'Key decisions', made.length ? { made, needed: asks.filter(a => a.kind === 'Decision') } : null);
  // ----- team and contacts -----
  const hours = new Map();
  if (pc && on('teamHours')) for (const x of pc.actual.lines) if (x.line.date >= since && x.person) hours.set(x.person.name, (hours.get(x.person.name) || 0) + (x.line.hours || 0));
  const team = (plan.resources || []).filter(r => keep('person:' + r.name)).map(r => ({ name: r.name, role: (inp.people || []).find(p => p.id === r.personId)?.category || '', hours: on('teamHours') ? Math.round((hours.get(r.name) || 0) * 10) / 10 : null, tasks: plan.assignments.filter(a => a.resourceUid === r.uid).length }));
  const contacts = brief ? table((sectionOf(brief, 'Contacts') || {}).body).map((c, i) => ({ key: 'contact:' + i, name: c.name || '', role: c.role || '', org: c.organisation || c.organization || c.org || '', email: c.email || '', phone: c.phone || '' })).filter(c => c.name && keep(c.key)) : [];
  add('team', 'Team and contacts', team.length || contacts.length ? { team, contacts, hoursLabel: on('teamHours') ? `Hours ${periodLabel}` : '' } : null);
  // ----- key facts and documents -----
  const factRows = facts0.map((x, i) => ({ key: 'fact:' + i, ...x })).filter(x => keep(x.key));
  const linkRows = brief ? links((sectionOf(brief, 'Key links') || {}).body).map((l, i) => ({ key: 'link:' + i, ...l })).filter(l => keep(l.key)) : [];
  add('facts', 'Key facts and documents', factRows.length || linkRows.length ? { facts: factRows, links: linkRows } : null);
  // ----- status history -----
  add('history', 'Status history', snaps.length ? { snaps: snaps.slice(-8).map(x => ({ date: x.statusDate || x.date, rag: x.rag ? x.rag.overall : null, reason: x.rag && x.rag.reasons ? x.rag.reasons.overall || '' : '' })) } : null);
  // ----- appendix (off by default for the sponsor) -----
  add('appendix', 'Appendix: all tasks', {
    tasks: s.order.filter(u => keep('task:' + u)).map(u => ({ id: ids.get(u), depth: s.outline.depth.get(u) || 0, name: task(u).name, start: E.dateOf(rec(u).es), finish: E.dateOf(rec(u).ef), pct: rec(u).pct || 0, summary: !!rec(u).summary, milestone: !!rec(u).milestone })),
  });
  return model;
}
const clean = t => String(t || '').trim() === 'Why this project exists.' ? '' : String(t || '').trim();
const firstLine = t => String(t || '').split('\n')[0].slice(0, 160);
function peopleOn(plan, uid) {
  return plan.assignments.filter(a => a.taskUid === uid).map(a => (plan.resources.find(r => r.uid === a.resourceUid) || {}).name).filter(Boolean);
}
/** The status snapshot in force on a date (the last one on or before it). */
function snapAt(snaps, iso) {
  let best = null;
  for (const x of snaps) if ((x.statusDate || x.date) <= iso) best = x;
  return best;
}
function fundingNumbers(pc) {
  if (!pc || !(pc.actual.total || pc.ev.bac || pc.budget)) return null;
  const ev = pc.ev;
  const eac = ev.eac ?? ev.eacBottomUp ?? null;  // the budget covers the whole NWA, so charges from before the plan count in the forecast too
  return { budget: pc.budget || 0, spent: pc.projectTotal ?? pc.actual.total, eac: eac == null ? null : eac + (pc.beforeCost || 0), contingency: pc.proj ? Number(pc.proj.contingency) || 0 : 0,
    runOut: pc.runOut != null ? E.dateOf(pc.runOut * E.DAY) : null, cpi: ev.cpi, spi: ev.spi, bac: ev.bac, beforeCost: pc.beforeCost || 0 };
}
function sCurve(plan, s, pc, n) {
  const curve = C.baselineCurve(plan, s, n), act = new Map();
  for (const x of pc.actual.lines) { const d = Math.floor(E.toMin(x.line.date) / E.DAY); act.set(d, (act.get(d) || 0) + x.cost); }
  const d0 = Math.floor(s.start / E.DAY), d1 = Math.max(Math.floor(s.finish / E.DAY), ...curve.keys(), d0 + 1);
  const pv = C.cumulative(curve, d0, d1), acDays = Math.max(...[...act.keys()].filter(d => d <= d1), d0), ac = C.cumulative(act, d0, Math.min(d1, acDays));
  const step = Math.max(1, Math.round((d1 - d0) / 60)), pts = [];  // ~60 points: plenty for a chart, small in a file
  for (let d = d0; d <= d1; d += step) pts.push({ date: E.dateOf(d * E.DAY), pv: Math.round(pv[d - d0] || 0), ac: d - d0 < ac.length ? Math.round(ac[d - d0]) : null });
  const ev = pc.ev;
  return { points: pts, budget: pc.budget || 0, eac: ev.eac ?? ev.eacBottomUp ?? null, finish: E.dateOf(s.finish), ev: ev.ev != null ? { date: E.dateOf(pc.statusMin), value: Math.round(ev.ev) } : null };
}

// ---------- plain-language sentences (rules, no AI) ----------
export function glanceSentence({ slip, pctDone, pctExp, f, highRisks = [], openIssues = [], nextMs, M = n => money(n) }) {
  const parts = [];
  if (slip != null) parts.push(slip > 2 ? `Behind schedule by ${slip} working days` : slip < -2 ? `Ahead of schedule by ${-slip} working days` : 'On schedule');
  else parts.push(pctDone + 5 < pctExp ? `Behind on progress (${pctDone}% done, ${pctExp}% expected)` : `Progress on track (${pctDone}% done)`);
  if (f && f.budget && f.eac != null) parts.push(f.eac > f.budget ? `spending is forecast to finish ${M(f.eac - f.budget)} over budget` : `spending is forecast to finish ${M(f.budget - f.eac)} under budget`);
  else if (f && f.cpi != null) parts.push(f.cpi < 0.95 ? 'work is costing more than planned' : 'spending is on track');
  if (highRisks.length) parts.push(`the biggest risk is ${lc(highRisks[0].title)}`);
  else if (openIssues.length) parts.push(`${openIssues.length} open issue${openIssues.length > 1 ? 's' : ''} to resolve`);
  else if (nextMs) parts.push(`next up: ${nextMs.name} on ${fmtDay(nextMs.forecast, false)}`);
  const t = parts.join('; ');
  return t.charAt(0).toUpperCase() + t.slice(1) + '.';
}
const lc = t => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);
export function fundingSentence(f, pctDone, M = n => money(n)) {
  const a = [];
  if (f.budget) a.push(`${M(f.spent)} of the ${M(f.budget)} budget spent (${pct(f.spent, f.budget)}%) with ${pctDone}% of the work done`);
  else a.push(`${M(f.spent)} spent so far with ${pctDone}% of the work done`);
  if (f.eac != null) a.push(f.budget ? `forecast ${M(f.eac)}, ${f.eac > f.budget ? M(f.eac - f.budget) + ' over' : M(f.budget - f.eac) + ' under'} budget` : `forecast ${M(f.eac)} at completion`);
  if (f.runOut) a.push(`at this rate the money runs out on ${fmtDay(f.runOut)}`);
  const t = a.join('; ');
  return t.charAt(0).toUpperCase() + t.slice(1) + '.';
}

// ---------- what the review can remove ----------
/** Every section and item in a full model, for the checklist: [{ key, label, items: [{ key, label, internal }] }]. */
export function checklist(model, plan, log) {
  const internal = new Set([...(plan.raid || []).filter(x => x.internal).map(x => 'raid:' + x.id), ...(log || []).filter(e => e.internal).map(e => 'log:' + e.id)]);
  const it = (key, label) => ({ key, label, internal: internal.has(key) });
  const out = [];
  for (const sec of model.sections) {
    const items = [];
    if (sec.key === 'changes') sec.items.forEach(c => items.push(it(c.key, c.text)));
    if (sec.key === 'asks') sec.items.forEach(a => items.push(it(a.key, `${a.kind}: ${a.text}`)));
    if (sec.key === 'period') sec.highlights.forEach(x => items.push(it(x.key, `${x.kind}: ${firstLine(x.text)}`)));
    if (sec.key === 'plan') sec.milestones.forEach(m => items.push(it(m.key, `◆ ${m.name}`)));
    if (sec.key === 'risks') [...sec.risks, ...sec.issues].forEach(x => items.push(it(x.key, x.title)));
    if (sec.key === 'decisions') sec.made.forEach(x => items.push(it(x.key, x.title)));
    if (sec.key === 'team') sec.contacts.forEach(c => items.push(it(c.key, `${c.name}${c.org ? ' · ' + c.org : ''}`)));
    if (sec.key === 'facts') { sec.facts.forEach(x => items.push(it(x.key, `${x.label}: ${x.value}`))); sec.links.forEach(l => items.push(it(l.key, `📄 ${l.label}`))); }
    const sub = sec.key === 'funding' ? [{ key: 'section:fundingByPerson', label: 'Cost by person' }] : sec.key === 'team' ? [{ key: 'section:teamHours', label: 'Hours per person' }] : [];
    out.push({ key: 'section:' + sec.key, label: sec.title, items, sub });
  }
  return out;
}
/** The sponsor preset: what usually stays internal. */
export function sponsorRemoved(plan, log) {
  return new Set(['section:fundingByPerson', 'section:teamHours', 'section:appendix',
    ...(plan.raid || []).filter(x => x.internal).map(x => 'raid:' + x.id),
    ...(log || []).filter(e => e.internal || e.kind === 'problem').map(e => 'log:' + e.id)]);
}

// ---------- charts (SVG strings: inline in the HTML, rendered to PNG for PowerPoint) ----------
const CAT = ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#d55e00', '#56b4e9', '#6b7280', '#8a6d00'];
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const svgOpen = (W, H, label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}" style="font:12px Segoe UI,Helvetica,Arial,sans-serif;max-width:100%;height:auto">`;
/** Milestones on a line: baseline hollow, forecast filled, today marked. */
export function timelineSvg(plan, W = 900) {
  const ms = plan.milestones;
  if (!ms.length) return '';
  const all = [...ms.map(m => m.forecast), ...ms.map(m => m.baseline).filter(Boolean), plan.start, plan.finish].map(dayMin);
  const a = Math.min(...all), b = Math.max(...all) + E.DAY, H = 64 + ms.length * 26, L = 200, R = 30;
  const X = t => L + (t - a) / (b - a) * (W - L - R);
  let out = svgOpen(W, H, 'Milestones: baseline and forecast dates');
  for (let t = a; t <= b; t += E.DAY) { const iso = E.dateOf(t); if (iso.endsWith('-01')) out += `<line x1="${X(t)}" x2="${X(t)}" y1="22" y2="${H - 8}" stroke="#e4e8ef"/><text x="${X(t) + 3}" y="16" fill="#6c7689">${MON[+iso.slice(5, 7) - 1]} ${iso.slice(2, 4)}</text>`; }
  ms.forEach((m, i) => {
    const y = 40 + i * 26, f = X(dayMin(m.forecast)), col = m.done ? '#15803d' : m.late || m.moved > 0 ? '#c81e1e' : '#18202f';
    out += `<text x="${L - 10}" y="${y + 4}" text-anchor="end" fill="#18202f">${esc(m.name.slice(0, 30))}</text><line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="#eef1f6"/>`;
    if (m.baseline) { const bx = X(dayMin(m.baseline)); out += `<path d="M${bx},${y - 6}L${bx + 6},${y}L${bx},${y + 6}L${bx - 6},${y}Z" fill="none" stroke="#6c7689" stroke-width="1.5"/>`; if (Math.abs(bx - f) > 6) out += `<line x1="${bx}" x2="${f}" y1="${y}" y2="${y}" stroke="${col}" stroke-dasharray="3 3"/>`; }
    out += `<path d="M${f},${y - 7}L${f + 7},${y}L${f},${y + 7}L${f - 7},${y}Z" fill="${col}"/>`;
  });
  const tx = X(Date.now() / 60000);
  if (tx > L && tx < W - R) out += `<line x1="${tx}" x2="${tx}" y1="22" y2="${H - 8}" stroke="#4f46e5" stroke-dasharray="4 3"/>`;
  return out + '</svg>';
}
/** The top-level phases as bars: baseline thin grey, forecast with progress. */
export function ganttSvg(plan, W = 900) {
  const ph = plan.phases;
  if (!ph.length) return '';
  const all = [...ph.flatMap(p => [p.start, p.finish, p.blStart, p.blFinish]).filter(Boolean)].map(dayMin);
  const a = Math.min(...all), b = Math.max(...all) + E.DAY, H = 34 + ph.length * 30, L = 200, R = 30;
  const X = t => L + (t - a) / (b - a) * (W - L - R);
  let out = svgOpen(W, H, 'Summary Gantt of the phases');
  for (let t = a; t <= b; t += E.DAY) { const iso = E.dateOf(t); if (iso.endsWith('-01')) out += `<line x1="${X(t)}" x2="${X(t)}" y1="20" y2="${H - 4}" stroke="#e4e8ef"/><text x="${X(t) + 3}" y="14" fill="#6c7689">${MON[+iso.slice(5, 7) - 1]} ${iso.slice(2, 4)}</text>`; }
  ph.forEach((p, i) => {
    const y = 26 + i * 30, x0 = X(dayMin(p.start)), x1 = X(dayMin(p.finish) + E.DAY);
    out += `<text x="${L - 10}" y="${y + 13}" text-anchor="end" fill="#18202f">${esc(p.name.slice(0, 30))}</text>`;
    if (p.blStart) out += `<rect x="${X(dayMin(p.blStart))}" y="${y + 20}" width="${Math.max(2, X(dayMin(p.blFinish) + E.DAY) - X(dayMin(p.blStart)))}" height="4" fill="#c9d0dc"/>`;
    if (p.milestone) out += `<path d="M${x0},${y + 3}L${x0 + 8},${y + 11}L${x0},${y + 19}L${x0 - 8},${y + 11}Z" fill="#18202f"/>`;
    else out += `<rect x="${x0}" y="${y + 4}" width="${Math.max(3, x1 - x0)}" height="14" rx="3" fill="#dfe3ff"/><rect x="${x0}" y="${y + 4}" width="${Math.max(0, (x1 - x0) * p.pct / 100)}" height="14" rx="3" fill="#4f46e5"/><text x="${x1 + 6}" y="${y + 15}" fill="#6c7689">${p.pct}%</text>`;
  });
  const tx = X(Date.now() / 60000);
  if (tx > L && tx < W - R) out += `<line x1="${tx}" x2="${tx}" y1="20" y2="${H - 4}" stroke="#4f46e5" stroke-dasharray="4 3"/>`;
  return out + '</svg>';
}
/** Planned value, actual cost, earned value today, the forecast and the budget. */
export function sCurveSvg(f, W = 900) {
  const c = f.curve;
  if (!c || !c.points.length) return '';
  const H = 300, L = 70, R = 24, T = 16, B = 50, pts = c.points, n = pts.length;
  const ymax = Math.max(1, ...pts.map(p => p.pv), ...pts.map(p => p.ac || 0), c.budget || 0, c.eac || 0) * 1.08;
  const X = i => L + i / Math.max(1, n - 1) * (W - L - R), Y = v => T + (1 - v / ymax) * (H - T - B);
  const cur = f.currency || '$', fv = v => money(v, cur, true);
  let out = svgOpen(W, H, 'Cumulative planned value, actual cost and forecast against the budget');
  for (let i = 0; i <= 4; i++) { const v = ymax / 1.08 * i / 4; out += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eef1f6"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" fill="#6c7689">${fv(v)}</text>`; }
  pts.forEach((p, i) => { if (p.date.endsWith('-01') || (i > 0 && p.date.slice(5, 7) !== pts[i - 1].date.slice(5, 7))) out += `<text x="${X(i)}" y="${H - B + 16}" fill="#6c7689">${MON[+p.date.slice(5, 7) - 1]}</text>`; });
  if (c.budget) out += `<line x1="${L}" x2="${W - R}" y1="${Y(c.budget)}" y2="${Y(c.budget)}" stroke="#6c7689" stroke-dasharray="2 3"/><text x="${W - R}" y="${Y(c.budget) - 5}" text-anchor="end" fill="#6c7689">Budget ${fv(c.budget)}</text>`;
  out += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.pv).toFixed(1)}`).join('')}" fill="none" stroke="#6c7689" stroke-width="2" stroke-dasharray="6 4"/>`;
  const acPts = pts.map((p, i) => [i, p.ac]).filter(([, v]) => v != null);
  if (acPts.length) {
    out += `<path d="${acPts.map(([i, v], k) => `${k ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('')}" fill="none" stroke="${CAT[4]}" stroke-width="2.5"/>`;
    const [li, lv] = acPts[acPts.length - 1];
    if (c.eac != null) out += `<path d="M${X(li)},${Y(lv)}L${X(n - 1)},${Y(c.eac)}" stroke="${CAT[4]}" stroke-width="2" stroke-dasharray="5 5" fill="none"/><circle cx="${X(n - 1)}" cy="${Y(c.eac)}" r="4" fill="#fff" stroke="${CAT[4]}" stroke-width="2"/>`;
  }
  if (c.ev) { const i = pts.findIndex(p => p.date >= c.ev.date); if (i >= 0) out += `<circle cx="${X(i)}" cy="${Y(c.ev.value)}" r="5" fill="${CAT[0]}" stroke="#fff" stroke-width="2"/>`; }
  const ky = H - 8, key = (x, col, dash, label) => `<line x1="${x}" x2="${x + 18}" y1="${ky - 4}" y2="${ky - 4}" stroke="${col}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ''}/><text x="${x + 22}" y="${ky}" fill="#3b4558">${label}</text>`;
  out += key(L + 4, '#6c7689', '6 4', 'Planned') + key(L + 94, CAT[4], '', 'Actual') + key(L + 174, CAT[4], '5 5', `Plan forecast ${c.eac != null ? fv(c.eac) : ''}`) + `<circle cx="${L + 354}" cy="${ky - 4}" r="4" fill="${CAT[0]}"/><text x="${L + 362}" y="${ky}" fill="#3b4558">Earned value</text>`;
  return out + '</svg>';
}
/** Each milestone's forecast date at each weekly status (flat = holding, rising = slipping). */
export function trendSvg(plan, W = 900) {
  const t = plan.trend;
  if (!t || t.length < 2) return '';
  const names = new Map(plan.milestones.map(m => [String(m.uid), m.name]));
  const pick = [...names.keys()].filter(u => t[t.length - 1].milestones[u] && t[t.length - 1].milestones[u] >= t[0].date).slice(0, 8);
  if (!pick.length) return '';
  const H = 260, L = 64, R = 180, T = 14, B = 28;
  const xs = t.map(p => dayMin(p.date)), ys = t.flatMap(p => pick.map(u => p.milestones[u]).filter(Boolean)).map(dayMin);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys) + E.DAY;
  const X = v => L + (v - x0) / Math.max(1, x1 - x0) * (W - L - R), Y = v => T + (1 - (v - y0) / Math.max(1, y1 - y0)) * (H - T - B);
  const md = v => E.dateOf(v).slice(5).replace('-', '/');
  let out = svgOpen(W, H, 'Milestone forecast dates at each weekly status');
  for (let i = 0; i <= 3; i++) { const v = y0 + (y1 - y0) * i / 3; out += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eef1f6"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" fill="#6c7689">${md(v)}</text>`; }
  xs.forEach(v => { out += `<text x="${X(v)}" y="${H - 8}" text-anchor="middle" fill="#6c7689">${md(v)}</text>`; });
  const labels = [];
  pick.forEach((u, k) => {
    const col = CAT[k % CAT.length], seq = t.map((p, i) => p.milestones[u] ? [X(xs[i]), Y(dayMin(p.milestones[u]))] : null).filter(Boolean);
    out += `<path d="${seq.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')}" fill="none" stroke="${col}" stroke-width="2"/>` + seq.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.5" fill="${col}"/>`).join('');
    const [lx, ly] = seq[seq.length - 1];
    labels.push({ x: lx + 8, y: ly + 4, name: names.get(u) });
  });
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 14);
  return out + labels.map(l => `<text x="${l.x}" y="${l.y}" fill="#18202f">${esc(l.name.slice(0, 26))}</text>`).join('') + '</svg>';
}

// ---------- the HTML brief (one self-contained file) ----------
const RAGC = { green: '#15803d', amber: '#b45309', red: '#c81e1e' };
const md = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (m, a, b) => esc(b || a.split('/').pop())).replace(/\n/g, '<br>');
const list = xs => xs && xs.length ? `<ul>${xs.map(x => `<li>${md(x)}</li>`).join('')}</ul>` : '';
const KIND = { update: '📝', win: '★', problem: '⚠', decision: '⚖', contact: '☎', site: '📍', lesson: '💡', system: '·' };
/** The model → a complete HTML document. images: { cover: dataURL } (optional). */
export function renderHtml(model, images = {}) {
  const m = model.meta, sec = k => model.sections.find(s => s.key === k);
  const ragc = RAGC[m.rag] || '#6c7689';
  const body = [];
  body.push(`<header class="band" style="--rag:${ragc}">${images.cover ? `<img class="cover" src="${images.cover}" alt="Cover photo">` : ''}<div class="hd">
<div class="chip">${esc(m.ragLabel)}</div><h1>${esc(m.name)}</h1>${m.summary ? `<p class="sum">${esc(m.summary)}</p>` : ''}
<p class="meta">${[m.client, m.project ? 'NWA ' + m.project : '', 'Brief of ' + fmtDay(m.date)].filter(Boolean).map(esc).join(' · ')}</p>${m.reason ? `<p class="reason">${esc(m.reason)}</p>` : ''}</div></header>`);
  for (const s of model.sections) {
    const h = `<h2 id="${s.key}">${esc(s.title)}</h2>`;
    if (s.key === 'glance') body.push(`<section class="glance">${h}<p class="lead">${esc(s.sentence)}</p><div class="tiles">${s.tiles.map(t => `<div class="tile ${t.tone}"><div class="lbl">${esc(t.label)}</div><div class="val">${esc(t.value)}</div><div class="sub">${esc(t.sub)}</div></div>`).join('')}</div></section>`);
    else if (s.key === 'changes') body.push(`<section>${h}${s.items.length ? `<ul class="changes">${s.items.map(c => `<li class="${c.tone}">${esc(c.text)}</li>`).join('')}</ul>` : `<p class="muted">${esc(s.empty)}</p>`}</section>`);
    else if (s.key === 'asks') body.push(`<section class="asks">${h}<table><thead><tr><th></th><th>What</th><th>Owner</th><th>Needed by</th></tr></thead><tbody>${s.items.map(a => `<tr><td><span class="tag">${esc(a.kind)}</span></td><td>${esc(a.text)}</td><td>${esc(a.owner)}</td><td>${a.due ? fmtDay(a.due, false) : ''}</td></tr>`).join('')}</tbody></table></section>`);
    else if (s.key === 'about') {
      const a = s.about;
      body.push(`<section>${h}${a.background ? `<p>${md(a.background)}</p>` : ''}${a.objectives.length ? `<h3>Objectives</h3>${list(a.objectives)}` : ''}
${a.inScope.length || a.outScope.length ? `<div class="two"><div><h3>In scope</h3>${list(a.inScope)}</div><div><h3>Out of scope</h3>${list(a.outScope)}</div></div>` : ''}
${a.success.length ? `<h3>Success criteria</h3>${list(a.success)}` : ''}${a.assumptions.length ? `<h3>Assumptions and constraints</h3>${list(a.assumptions)}` : ''}
${a.stakeholders.length ? `<h3>Stakeholders</h3><table><thead><tr>${Object.keys(a.stakeholders[0]).map(k => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${a.stakeholders.map(r => `<tr>${Object.values(r).map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''}
${a.extra.map(x => `<h3>${esc(x.title)}</h3><p>${md(x.body)}</p>`).join('')}${a.lessons.length ? `<h3>Lessons learned</h3>${list(a.lessons)}` : ''}</section>`);
    } else if (s.key === 'period') body.push(`<section>${h}<div class="two"><div><h3>Done</h3>${s.done.length ? `<ul class="done">${s.done.map(d => `<li>✓ ${esc(d.text)} <span class="muted">${fmtDay(d.date, false)}</span></li>`).join('')}</ul>` : '<p class="muted">No tasks finished in this period.</p>'}</div>
<div><h3>Next</h3>${s.next.length ? `<ul>${s.next.map(n => `<li>${esc(n.text)} <span class="muted">due ${fmtDay(n.due, false)}${n.pct ? ` · ${n.pct}%` : ''}</span></li>`).join('')}</ul>` : '<p class="muted">Nothing due in the next two weeks.</p>'}</div></div>
${s.highlights.length ? `<h3>Updates</h3><ul class="log">${s.highlights.map(x => `<li><span class="k">${KIND[x.kind] || '·'}</span><span class="muted">${fmtDay(x.date, false)}</span> ${md(x.text)}</li>`).join('')}</ul>` : ''}</section>`);
    else if (s.key === 'lookahead') body.push(`<section>${h}<div class="cols">${s.people.map(p => `<div><h3>${esc(p.name)}</h3><ul>${p.items.map(n => `<li>${esc(n.text)} <span class="muted">${fmtDay(n.due, false)}</span></li>`).join('')}</ul></div>`).join('')}</div></section>`);
    else if (s.key === 'plan') body.push(`<section>${h}<p class="lead">${esc(s.sentence)}</p>${timelineSvg(s)}${ganttSvg(s)}${s.trend.length ? `<h3>Milestone trend</h3><p class="muted">Each milestone's forecast at each weekly status: flat is holding, rising is slipping.</p>${trendSvg(s)}` : ''}
<table><thead><tr><th>Milestone</th><th>Baseline</th><th>Forecast</th><th>Change</th><th>Status</th></tr></thead><tbody>${s.milestones.map(x => `<tr><td>${esc(x.name)}</td><td>${x.baseline ? fmtDay(x.baseline, false) : ''}</td><td>${fmtDay(x.forecast, false)}</td><td class="${x.moved > 0 ? 'bad' : ''}">${x.moved ? (x.moved > 0 ? '+' : '') + x.moved + ' d' : ''}</td><td>${x.done ? '✓ Done' : x.late ? '<span class="bad">Late</span>' : 'On track'}</td></tr>`).join('')}</tbody></table></section>`);
    else if (s.key === 'funding') {
      const cur = s.currency, M = n => money(n, cur);
      body.push(`<section>${h}<p class="lead">${esc(s.sentence)}</p><div class="tiles">${[['Budget', s.budget ? M(s.budget) : '–'], ['Spent', M(s.spent)], ['Forecast at completion', s.forecast != null ? M(s.forecast) : '–'], ['Contingency', s.contingency ? M(s.contingency) : '–']].map(([l, v]) => `<div class="tile"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join('')}</div>
${sCurveSvg(s)}${s.beforeCost ? `<p class="muted">The chart covers the work since the plan started. The totals above also include ${M(s.beforeCost)} charged to the NWA before it.</p>` : ''}${s.phases.length ? `<h3>By phase</h3><table><thead><tr><th>Phase</th><th class="n">Baseline</th><th class="n">Actual</th><th class="n">Forecast</th></tr></thead><tbody>${s.phases.map(p => `<tr><td>${esc(p.name)}</td><td class="n">${M(p.baseline)}</td><td class="n">${M(p.actual)}</td><td class="n ${p.baseline && p.forecast > p.baseline * 1.05 ? 'bad' : ''}">${M(p.forecast)}</td></tr>`).join('')}</tbody></table>` : ''}
${s.overBudget.length ? `<p class="bad">Tasks heading over their budget: ${s.overBudget.map(o => `${esc(o.name)} (forecast ${M(o.forecast)} against ${M(o.budget)})`).join('; ')}.</p>` : ''}
${s.byPerson && s.byPerson.length ? `<h3>By person</h3><table><thead><tr><th>Person</th><th class="n">Hours</th><th class="n">Cost</th></tr></thead><tbody>${s.byPerson.map(p => `<tr><td>${esc(p.name)}</td><td class="n">${Math.round(p.hours * 10) / 10}</td><td class="n">${M(p.cost)}</td></tr>`).join('')}</tbody></table>` : ''}</section>`);
    } else if (s.key === 'risks') body.push(`<section>${h}<p class="lead">${esc(s.sentence)}</p><div class="two"><div>${s.risks.length ? `<table><thead><tr><th>Risk</th><th>P×I</th><th>Owner</th><th>Response</th></tr></thead><tbody>${s.risks.map(x => `<tr><td>${esc(x.title)}</td><td class="${x.score >= 15 ? 'bad' : ''}">${x.p}×${x.i}</td><td>${esc(x.owner)}</td><td>${esc(x.mitigation)}</td></tr>`).join('')}</tbody></table>` : ''}
${s.issues.length ? `<h3>Open issues</h3><table><thead><tr><th>Issue</th><th>Owner</th><th>Due</th></tr></thead><tbody>${s.issues.map(x => `<tr><td>${esc(x.title)}${x.description ? `<div class="muted">${esc(x.description)}</div>` : ''}</td><td>${esc(x.owner)}</td><td>${x.due ? fmtDay(x.due, false) : ''}</td></tr>`).join('')}</tbody></table>` : ''}</div>
<div class="matrix" aria-label="Open risks by probability and impact">${s.matrix.map((row, r) => row.map((n, c) => { const sc = (5 - r) * (c + 1); return `<div class="${sc >= 15 ? 'hi' : sc >= 6 ? 'md' : 'lo'}">${n || ''}</div>`; }).join('')).join('')}<span class="ax y">Impact →</span><span class="ax x">Probability →</span></div></div></section>`);
    else if (s.key === 'decisions') body.push(`<section>${h}${s.made.map(d => `<div class="decision${d.superseded ? ' old' : ''}"><b>${esc(d.title)}</b>${d.superseded ? ' <span class="tag">superseded</span>' : ''}<div class="muted">${[d.date ? fmtDay(d.date) : '', d.by].filter(Boolean).map(esc).join(' · ')}</div>${d.rationale ? `<p>${md(d.rationale)}</p>` : ''}${d.options.length ? `<p class="muted">Options considered: ${d.options.map(esc).join(' · ')}</p>` : ''}</div>`).join('')}</section>`);
    else if (s.key === 'team') body.push(`<section>${h}<div class="two"><div>${s.team.length ? `<table><thead><tr><th>Team</th><th>Role</th><th class="n">Tasks</th>${s.hoursLabel ? `<th class="n">${esc(s.hoursLabel)}</th>` : ''}</tr></thead><tbody>${s.team.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.role)}</td><td class="n">${t.tasks}</td>${s.hoursLabel ? `<td class="n">${t.hours ?? ''}</td>` : ''}</tr>`).join('')}</tbody></table>` : ''}</div>
<div>${s.contacts.length ? `<table><thead><tr><th>Contact</th><th>Role</th><th>Email / phone</th></tr></thead><tbody>${s.contacts.map(c => `<tr><td>${esc(c.name)}${c.org ? `<div class="muted">${esc(c.org)}</div>` : ''}</td><td>${esc(c.role)}</td><td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.phone ? `<div>${esc(c.phone)}</div>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}</div></div></section>`);
    else if (s.key === 'facts') body.push(`<section>${h}<div class="two"><div>${s.facts.length ? `<dl>${s.facts.map(x => `<dt>${esc(x.label)}</dt><dd>${md(x.value)}</dd>`).join('')}</dl>` : ''}</div><div>${s.links.length ? `<ul class="docs">${s.links.map(l => `<li>📄 <b>${esc(l.label)}</b>${l.vault ? `<div class="muted">${esc(l.target)}</div>` : ` <a href="${esc(l.target)}">${esc(l.target)}</a>`}</li>`).join('')}</ul>` : ''}</div></div></section>`);
    else if (s.key === 'history') body.push(`<section>${h}<div class="hist">${s.snaps.map(x => `<div title="${esc(x.reason)}"><span class="dot" style="background:${RAGC[x.rag] || '#c9d0dc'}"></span><b>${fmtDay(x.date, false)}</b><span>${esc(ragLabel(x.rag))}</span><span class="muted">${esc(x.reason)}</span></div>`).join('')}</div></section>`);
    else if (s.key === 'appendix') body.push(`<section class="appendix">${h}<table><thead><tr><th>ID</th><th>Task</th><th>Start</th><th>Finish</th><th class="n">%</th></tr></thead><tbody>${s.tasks.map(t => `<tr class="${t.summary ? 'sumrow' : ''}"><td>${t.id ?? ''}</td><td style="padding-left:${8 + t.depth * 14}px">${t.milestone ? '◆ ' : ''}${esc(t.name)}</td><td>${fmtDay(t.start, false)}</td><td>${fmtDay(t.finish, false)}</td><td class="n">${t.pct}%</td></tr>`).join('')}</tbody></table></section>`);
  }
  const foot = `<footer>Made with Keystone on ${fmtDay(m.date)} · covers ${esc(m.period)}${m.removedAny ? ' · some items were left out of this copy' : ''}</footer>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(m.name)} – project brief ${m.date}</title><style>${CSS}</style></head><body><main>${body.join('\n')}${foot}</main></body></html>`;
}
const CSS = `:root{--ink:#18202f;--ink2:#3b4558;--muted:#6c7689;--line:#e4e8ef;--bg:#fff;--card:#f6f7fa;--bad:#c81e1e;--ok:#15803d}
@media (prefers-color-scheme:dark){:root{--ink:#e7eaf2;--ink2:#c3c9d8;--muted:#8c96ad;--line:#2a3142;--bg:#11151f;--card:#181d2a;--bad:#f87171;--ok:#4ade80}svg text{fill:var(--ink2)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Segoe UI",system-ui,-apple-system,Helvetica,Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:0 24px 40px}h1{font-size:30px;margin:6px 0 4px;line-height:1.2}h2{font-size:20px;margin:36px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--line)}h3{font-size:15px;margin:18px 0 6px;color:var(--ink2)}
.band{border-top:8px solid var(--rag);margin:0 -24px;padding:22px 24px 6px;display:flex;gap:20px;align-items:flex-start}.band .cover{width:220px;max-height:160px;object-fit:cover;border-radius:10px}.hd{flex:1}
.chip{display:inline-block;background:var(--rag);color:#fff;font-weight:700;font-size:12px;letter-spacing:.04em;text-transform:uppercase;padding:3px 10px;border-radius:999px}
.sum{font-size:17px;margin:4px 0}.meta,.muted{color:var(--muted)}.meta{margin:4px 0}.reason{margin:6px 0;font-style:italic}.lead{font-size:16px;margin:6px 0 14px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:10px 0}.tile{background:var(--card);border-radius:10px;padding:12px 14px;border-left:4px solid var(--line)}.tile.bad{border-left-color:var(--bad)}.tile.ok{border-left-color:var(--ok)}
.tile .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}.tile .val{font-size:22px;font-weight:700;margin:2px 0}.tile .sub{font-size:13px;color:var(--muted)}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:14px}th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border-bottom:2px solid var(--line);padding:6px 8px}td{border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}.n{text-align:right;font-variant-numeric:tabular-nums}
.two{display:grid;grid-template-columns:1fr 1fr;gap:24px}.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}ul{margin:4px 0;padding-left:20px}li{margin:3px 0}
.bad{color:var(--bad)}.ok{color:var(--ok)}.changes li.bad::marker{color:var(--bad)}.done{list-style:none;padding:0}.log{list-style:none;padding:0}.log .k{display:inline-block;width:22px}
.tag{display:inline-block;font-size:11px;font-weight:700;text-transform:uppercase;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.asks{background:var(--card);border-radius:12px;padding:2px 16px 10px}.asks h2{border:0}.decision{border-left:3px solid var(--line);padding:2px 0 2px 12px;margin:10px 0}.decision.old{opacity:.6}
.matrix{display:grid;grid-template-columns:repeat(5,34px);grid-auto-rows:34px;gap:3px;position:relative;margin:10px 0 30px 22px;align-self:start}.matrix div{display:grid;place-items:center;border-radius:5px;font-weight:700}
.matrix .lo{background:#e6f6eb}.matrix .md{background:#fff3df}.matrix .hi{background:#fdeaea}.matrix .ax{position:absolute;font-size:11px;color:var(--muted)}.matrix .y{left:-24px;top:60px;transform:rotate(-90deg)}.matrix .x{bottom:-22px;left:50px}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:6px 0}dt{color:var(--muted)}dd{margin:0}.docs{list-style:none;padding:0}
.hist{display:grid;gap:6px}.hist>div{display:grid;grid-template-columns:14px 70px 90px 1fr;gap:8px;align-items:center}.dot{width:12px;height:12px;border-radius:50%}
.sumrow td{font-weight:650}svg{display:block;margin:8px 0}footer{margin-top:40px;padding-top:10px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media (max-width:700px){.two{grid-template-columns:1fr}.band{flex-direction:column}.band .cover{width:100%}table{display:block;overflow-x:auto}}
@media print{body{font-size:12px}main{max-width:none}h2{break-after:avoid}section{break-inside:avoid-page}.appendix{break-before:page}a{color:inherit}}`;

// ---------- the slide list for PowerPoint ----------
/** The model → slides on PowerPoint's standard layouts. deck.py turns each into a slide; text goes in placeholders. */
export function deckSpec(model) {
  const m = model.meta, sec = k => model.sections.find(s => s.key === k), slides = [];
  const cap = (xs, n) => (xs.length > n ? [...xs.slice(0, n - 1), `… and ${xs.length - n + 1} more`] : xs);
  slides.push({ layout: 'title', title: m.name, subtitle: [m.summary, [m.client, fmtDay(m.date)].filter(Boolean).join(' · ')].filter(Boolean).join('\n'), status: { label: m.ragLabel, rag: m.rag }, notes: m.reason, image: m.cover ? 'cover' : null });
  const g = sec('glance');
  if (g) slides.push({ layout: 'content', title: 'At a glance', bullets: [{ text: g.sentence }, ...g.tiles.map(t => ({ text: `${t.label}: ${t.value}${t.sub ? ' – ' + t.sub : ''}`, level: 1 }))], status: { label: m.ragLabel, rag: m.rag }, notes: g.sentence });
  const ch = sec('changes');
  if (ch && ch.items.length) slides.push({ layout: 'content', title: ch.title, bullets: cap(ch.items.map(c => c.text), 8).map(text => ({ text })), notes: ch.items.map(c => c.text).join('\n') });
  const ab = sec('about');
  if (ab) {
    const a = ab.about;
    slides.push({ layout: 'two', title: 'About the project', left: { heading: 'Objectives', bullets: cap(a.objectives.length ? a.objectives : [a.background].filter(Boolean), 7) }, right: { heading: 'Scope', bullets: [...cap(a.inScope, 5), ...(a.outScope.length ? ['Out of scope: ' + a.outScope.slice(0, 4).join('; ')] : [])] }, notes: a.background });
    if (a.success.length || a.assumptions.length) slides.push({ layout: 'two', title: 'Success criteria and assumptions', left: { heading: 'Success criteria', bullets: cap(a.success, 7) }, right: { heading: 'Assumptions and constraints', bullets: cap(a.assumptions, 7) }, notes: '' });
  }
  const p = sec('period');
  if (p) slides.push({ layout: 'two', title: p.title, left: { heading: 'Done', bullets: cap(p.done.map(d => d.text).concat(p.highlights.filter(x => x.kind === 'win').map(x => '★ ' + firstLine(x.text))), 8) }, right: { heading: 'Next two weeks', bullets: cap(p.next.map(n => `${n.text} – ${fmtDay(n.due, false)}`), 8) }, notes: p.highlights.map(x => `${fmtDay(x.date, false)} ${x.kind}: ${x.text}`).join('\n') });
  const pl = sec('plan');
  if (pl) {
    slides.push({ layout: 'titleOnly', title: 'Schedule', image: 'gantt', notes: pl.sentence + '\n' + pl.milestones.map(x => `${x.name}: ${fmtDay(x.forecast)}${x.baseline ? ` (baseline ${fmtDay(x.baseline, false)})` : ''}`).join('\n') });
    slides.push({ layout: 'content', title: 'Milestones', table: { cols: ['Milestone', 'Baseline', 'Forecast', 'Change', 'Status'], rows: pl.milestones.slice(0, 12).map(x => [x.name, x.baseline ? fmtDay(x.baseline, false) : '', fmtDay(x.forecast, false), x.moved ? (x.moved > 0 ? '+' : '') + x.moved + ' d' : '', x.done ? 'Done' : x.late ? 'Late' : 'On track']) }, notes: pl.sentence });
    if (pl.trend.length >= 3) slides.push({ layout: 'titleOnly', title: 'Milestone trend', image: 'trend', notes: 'Each milestone\'s forecast date at each weekly status. Flat lines are holding; rising lines are slipping.' });
  }
  const f = sec('funding');
  if (f) {
    const pts = f.curve.points;
    slides.push({ layout: 'content', title: 'Funding', chart: pts.length ? { type: 'line', categories: pts.map((x, i) => (i === 0 || x.date.slice(5, 7) !== pts[i - 1].date.slice(5, 7) ? MON[+x.date.slice(5, 7) - 1] + ' ' + x.date.slice(2, 4) : ' '.repeat(i % 7 + 1))), series: [{ name: 'Planned (baseline)', values: pts.map(x => x.pv) }, { name: 'Actual', values: pts.map(x => x.ac) }, ...(f.budget ? [{ name: 'Budget', values: pts.map(() => f.budget) }] : [])], number: f.currency + '#,##0' } : null, notes: f.sentence });
    const rows = [['Budget', f.budget ? money(f.budget, f.currency) : '–'], ['Spent', money(f.spent, f.currency)], ['Forecast at completion', f.forecast != null ? money(f.forecast, f.currency) : '–'], ...(f.contingency ? [['Contingency', money(f.contingency, f.currency)]] : []), ...(f.runOut ? [['Money runs out', fmtDay(f.runOut)]] : [])];
    slides.push({ layout: 'two', title: 'Funding summary', left: { heading: 'Where we are', bullets: [f.sentence, ...f.overBudget.slice(0, 3).map(o => `Heading over budget: ${o.name}`)] }, right: { table: { cols: ['', ''], rows } }, notes: f.sentence });
    if (f.phases.length) slides.push({ layout: 'content', title: 'Cost by phase', chart: { type: 'bar', categories: f.phases.map(x => x.name), series: [{ name: 'Baseline', values: f.phases.map(x => Math.round(x.baseline)) }, { name: 'Actual', values: f.phases.map(x => Math.round(x.actual)) }, { name: 'Forecast', values: f.phases.map(x => Math.round(x.forecast)) }], number: f.currency + '#,##0' }, notes: '' });
    if (f.byPerson && f.byPerson.length) slides.push({ layout: 'content', title: 'Cost by person', table: { cols: ['Person', 'Hours', 'Cost'], rows: f.byPerson.slice(0, 12).map(x => [x.name, String(Math.round(x.hours * 10) / 10), money(x.cost, f.currency)]) }, notes: '' });
  }
  const r = sec('risks');
  if (r && (r.risks.length || r.issues.length)) slides.push({ layout: 'content', title: 'Issues and risks', table: { cols: ['', 'Title', 'P×I', 'Owner', 'Response / due'], rows: [...r.risks.slice(0, 6).map(x => ['Risk', x.title, `${x.p}×${x.i}`, x.owner, x.mitigation]), ...r.issues.slice(0, 4).map(x => ['Issue', x.title, '', x.owner, x.due ? fmtDay(x.due, false) : ''])] }, notes: r.sentence });
  const as = sec('asks'), d = sec('decisions');
  if (as || d) slides.push({ layout: 'two', title: 'Decisions', left: { heading: 'Needed', bullets: cap((as ? as.items : []).map(a => `${a.text}${a.owner ? ' – ' + a.owner : ''}${a.due ? ' by ' + fmtDay(a.due, false) : ''}`), 7) }, right: { heading: 'Made', bullets: cap((d ? d.made : []).filter(x => !x.superseded).map(x => `${x.title}${x.date ? ' (' + fmtDay(x.date, false) + ')' : ''}`), 7) }, notes: (d ? d.made : []).map(x => `${x.title}: ${x.rationale}`).join('\n') });
  const t = sec('team');
  if (t && t.contacts.length) slides.push({ layout: 'content', title: 'Contacts', table: { cols: ['Name', 'Role', 'Organisation', 'Email', 'Phone'], rows: t.contacts.slice(0, 10).map(c => [c.name, c.role, c.org, c.email, c.phone]) }, notes: '' });
  const la = sec('lookahead');
  slides.push({ layout: 'content', title: 'Next steps', bullets: [...(la ? la.people.slice(0, 5).map(x => ({ text: `${x.name}: ${x.items.slice(0, 3).map(i => i.text).join('; ')}` })) : []), ...((as ? as.items : []).slice(0, 3).map(a => ({ text: `${a.kind}: ${a.text}${a.due ? ' by ' + fmtDay(a.due, false) : ''}` })))].slice(0, 8), notes: '' });
  return slides;
}
