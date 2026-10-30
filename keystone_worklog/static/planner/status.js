// Keystone Planner – the weekly rhythm: "Close the week" snapshots, red/amber/green status, the status report
// (Obsidian note, email draft, print), the milestone trend chart and "what changed".
import * as C from './costs.js';
import * as E from './engine.js';
import { planner as S, taskOf, rowIds, fmtDate } from './ui.js';
import { planCosts, ensurePlanCosts, money, fill } from './costui.js';

// ---------- snapshots (data/plans/<id>.status.json) ----------
export async function loadStatus(planId, force = false) {
  if (!force && S.statusCache && S.statusCache.planId === planId) return S.statusCache.snaps;
  const j = await api(`/api/plans/${planId}/status`);
  S.statusCache = { planId, snaps: j.snapshots || [] };
  return S.statusCache.snaps;
}
const snaps = () => (S.statusCache && S.plan && S.statusCache.planId === S.plan.id ? S.statusCache.snaps : []);
export const lastSnap = () => snaps()[snaps().length - 1] || null;
const RAG = { green: 'On track', amber: 'At risk', red: 'Off track' };
export const ragChip = (r, label) => h('span', { class: 'rag rag-' + (r || 'none') }, label || RAG[r] || 'No status');
const wd = (a, b) => Math.round(E.workBetween(S.sched.calendar, a, b) / (S.plan.units.minutesPerDay || 480));

/** The numbers a snapshot keeps, as of now. */
export function currentNumbers() {
  const p = S.plan, s = S.sched, statusMin = E.toMin(p.statusDate) ?? E.toMin(fmt(new Date())) + 17 * 60;
  const leaves = s.order.filter(u => !s.byUid.get(u).summary), rs = leaves.map(u => s.byUid.get(u));
  const tot = rs.reduce((a, r) => a + (r.dur || 0), 0);
  const pct = tot ? Math.round(rs.reduce((a, r) => a + (r.dur || 0) * (r.pct || 0), 0) / tot) : 0;
  const expected = tot ? Math.round(rs.reduce((a, r) => a + (r.dur || 0) * E.expectedPct(s.calendar, r, statusMin), 0) / tot) : 0;
  const bl = p.tasks.map(t => (t.baselines || {})[S.baselineN]).filter(Boolean);
  const blFinish = bl.length ? E.fromMin(Math.max(...bl.map(b => E.toMin(b.finish) || 0))) : null;
  const milestones = {}, tasks = {};
  for (const u of s.order) {
    const r = s.byUid.get(u), t = taskOf(u);
    if (r.milestone) milestones[u] = E.dateOf(r.ef);
    tasks[u] = [E.dateOf(r.es), E.dateOf(r.ef), r.pct || 0, t.name];
  }
  const pc = planCosts(), ev = pc && (pc.ev.bac || pc.actual.total) ? {
    bac: round(pc.ev.bac), pv: round(pc.ev.pv), ev: round(pc.ev.ev), ac: round(pc.ev.ac), spi: r2(pc.ev.spi), cpi: r2(pc.ev.cpi), eac: round(pc.ev.eac ?? pc.ev.eacBottomUp),
    evH: round(pc.evH.ev), acH: round(pc.evH.ac), budget: pc.budget || null, projectTotal: round(pc.projectTotal), runOut: pc.runOut != null ? E.dateOf(pc.runOut * E.DAY) : null } : null;
  const overBudget = pc ? [...pc.checks.entries()].filter(([u, x]) => !s.byUid.get(u).summary && x.overBudget).map(([u, x]) => ({ name: taskOf(u).name, budget: round(x.budget), forecast: round(x.budgetForecast) })) : [];
  const raid = (p.raid || []).filter(x => x.status !== 'closed').map(x => ({ id: x.id, kind: x.kind, title: x.title, score: (x.probability || 0) * (x.impact || 0), owner: x.owner || '', due: x.due || '' }));
  return { statusDate: E.dateOf(statusMin), statusMin, finish: E.dateOf(s.finish), baselineFinish: blFinish && blFinish.slice(0, 10), pct, pctExpected: expected, milestones, tasks, ev,
    postedThrough: pc ? pc.posted : null, raid, overBudget, openRisks: raid.filter(x => x.kind === 'risk').length, openIssues: raid.filter(x => x.kind === 'issue').length };
}
const round = n => n == null || !Number.isFinite(n) ? null : Math.round(n);
const r2 = n => n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;

/** Suggested RAG and the drafted lists, from the numbers and the last snapshot. */
export function draft() {
  const n = currentNumbers(), prev = lastSnap(), s = S.sched, p = S.plan;
  const slip = prev && prev.finish ? wd(E.toMin(prev.finish), E.toMin(n.finish)) : n.baselineFinish ? wd(E.toMin(n.baselineFinish + 'T17:00'), s.finish) : null;
  const rag = C.suggestRag({ spi: n.ev ? n.ev.spi : null, cpi: n.ev ? n.ev.cpi : null, eac: n.ev ? n.ev.eac : null, budget: n.ev ? n.ev.budget : null, slipDays: slip, openChanges: 0 });
  if (!n.ev) {  // no costs: schedule from % complete against expected
    const gap = n.pctExpected - n.pct;
    if (gap >= 15) { rag.schedule = 'red'; rag.why.schedule = [rag.why.schedule, `${n.pct}% done, ${n.pctExpected}% expected`].filter(Boolean).join('; '); }
    else if (gap >= 5 && rag.schedule === 'green') { rag.schedule = 'amber'; rag.why.schedule = [rag.why.schedule, `${n.pct}% done, ${n.pctExpected}% expected`].filter(Boolean).join('; '); }
    rag.overall = ['red', 'amber'].find(c => [rag.schedule, rag.cost, rag.scope].includes(c)) || 'green';
  }
  const since = prev ? E.toMin(prev.statusDate || prev.date) : n.statusMin - 7 * E.DAY, ahead = n.statusMin + 7 * E.DAY;
  const done = [], next = [];
  for (const u of s.order) {
    const r = s.byUid.get(u), t = taskOf(u);
    if (r.summary) continue;
    const before = prev && prev.tasks && prev.tasks[u];
    if ((r.pct || 0) >= 100 && (before ? before[2] < 100 : r.ef > since)) done.push((r.milestone ? '◆ ' : '') + t.name);
    else if ((r.pct || 0) < 100 && r.es <= ahead && r.ef >= n.statusMin - E.DAY) next.push(`${r.milestone ? '◆ ' : ''}${t.name} (${(r.pct || 0) > 0 ? `${r.pct}%, ` : ''}due ${fmtDate(r.ef, false)})`);
  }
  const decisions = (p.raid || []).filter(x => x.status !== 'closed' && !['decided', 'superseded'].includes(x.decisionStatus) && (x.kind === 'decision' || (x.kind === 'risk' && (x.probability || 0) * (x.impact || 0) >= 15))).map(x => x.kind === 'decision' ? x.title : `Risk: ${x.title}`);
  // the weekly log since the last status: wins and updates are "done", problems need help
  const sinceIso = E.dateOf(since), first = t => String(t || '').split('\n')[0].slice(0, 160);
  const logged = (S.logCache && S.logCache.planId === p.id ? S.logCache.entries : []).filter(e => e.at.slice(0, 10) >= sinceIso && e.kind !== 'system');
  for (const e of logged) {
    if (['win', 'update', 'site', 'contact'].includes(e.kind)) done.push((e.kind === 'win' ? '★ ' : '') + first(e.text));
    if (e.kind === 'problem') decisions.push('Help needed: ' + first(e.text));
  }
  if (slip) rag.why.schedule = [rag.why.schedule, prev ? `finish ${slip > 0 ? 'moved ' + slip + ' working days later' : 'moved ' + -slip + ' working days earlier'} since ${prev.date}` : ''].filter(Boolean).join('; ');
  return { n, rag, done, next: next.slice(0, 15), decisions, slip, prev, logIds: logged.map(e => e.id) };
}

export async function saveSnapshot(snap) {
  await api(`/api/plans/${S.plan.id}/status`, { snapshot: snap }, 'PUT');
  await loadStatus(S.plan.id, true);
}
export function buildSnapshot(d, choice) {
  const { n } = d;
  return { id: 's_' + n.statusDate, date: fmt(new Date()), statusDate: n.statusDate, rag: { overall: choice.overall, schedule: choice.schedule, cost: choice.cost, scope: choice.scope, reasons: choice.reasons },
    finish: n.finish, baselineFinish: n.baselineFinish, pct: n.pct, pctExpected: n.pctExpected, milestones: n.milestones, tasks: n.tasks, ev: n.ev, postedThrough: n.postedThrough, overBudget: n.overBudget,
    raid: n.raid, openRisks: n.openRisks, openIssues: n.openIssues, logIds: d.logIds || [], done: choice.done, next: choice.next, decisions: choice.decisions, notes: choice.notes || '', by: choice.by || 'you' };
}

// ---------- Close the week ----------
export async function closeWeekDialog(A) {
  await ensurePlanCosts().catch(() => {});
  await loadStatus(S.plan.id).catch(() => {});
  await import('./brief.js').then(m => m.loadLog()).catch(() => {});
  const d = draft(), keys = ['overall', 'schedule', 'cost', 'scope'];
  const exists = snaps().find(x => x.id === 's_' + d.n.statusDate);
  const base = exists ? { ...exists.rag, reasons: exists.rag.reasons || {}, done: exists.done, next: exists.next, decisions: exists.decisions, notes: exists.notes } : { ...d.rag, reasons: { ...d.rag.why }, done: d.done, next: d.next, decisions: d.decisions, notes: '' };
  const sel = {}, why = {};
  const row = k => {
    sel[k] = h('select', { class: 'ragsel', onchange: e => { e.target.className = 'ragsel rag-' + e.target.value; } }, ['green', 'amber', 'red'].map(c => h('option', { value: c }, RAG[c])));
    sel[k].value = base[k] || 'green'; sel[k].className = 'ragsel rag-' + sel[k].value;
    why[k] = h('input', { value: (base.reasons || {})[k] || '', placeholder: k === 'overall' ? 'One line for the report' : 'Why (needed if you change the suggestion)' });
    return h('tr', {}, h('th', {}, k[0].toUpperCase() + k.slice(1)), h('td', {}, sel[k]), h('td', { class: 'hint' }, d.rag[k] !== (base[k] || 'green') ? `suggested: ${RAG[d.rag[k]]}` : 'suggested'), h('td', { style: 'width:100%' }, why[k]));
  };
  const ta = (v, rows = 4) => { const t = h('textarea', { rows }); t.value = (v || []).join('\n'); return t; };
  const done = ta(base.done), next = ta(base.next), dec = ta(base.decisions, 2), notes = h('textarea', { rows: 2 }); notes.value = base.notes || '';
  const n = d.n, ev = n.ev;
  const facts = [
    `Finish ${fmtDate(E.toMin(n.finish))}${n.baselineFinish ? ` (baseline ${fmtDate(E.toMin(n.baselineFinish))})` : ''}${d.slip ? ` · moved ${d.slip > 0 ? '+' : ''}${d.slip} working days${d.prev ? ' since ' + d.prev.date : ''}` : ''}`,
    `${n.pct}% complete · ${n.pctExpected}% expected`,
    ev ? `Cost ${money(ev.ac)} · earned ${money(ev.ev)} · planned ${money(ev.pv)} · CPI ${ev.cpi ?? '–'} · SPI ${ev.spi ?? '–'} · forecast ${money(ev.eac)}` : 'No cost data (link the plan to a project and import ERP costs)',
    `${n.openRisks} open risks · ${n.openIssues} open issues`];
  const dlg = h('dialog', { class: 'dlg wide', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', onsubmit: async e => {
      e.preventDefault();
      const choice = { reasons: {} };
      for (const k of keys) { choice[k] = sel[k].value; choice.reasons[k] = why[k].value.trim(); }
      const bad = keys.filter(k => k !== 'overall' && choice[k] !== d.rag[k] && !choice.reasons[k]);
      if (bad.length) { why[bad[0]].focus(); return toast(`Say why ${bad[0]} is ${RAG[choice[bad[0]]].toLowerCase()} – it differs from the suggestion`); }
      const lines = t => t.value.split('\n').map(x => x.trim()).filter(Boolean);
      Object.assign(choice, { done: lines(done), next: lines(next), decisions: lines(dec), notes: notes.value.trim() });
      try { await saveSnapshot(buildSnapshot(d, choice)); } catch (x) { return toast(x.message); }
      dlg.close(); toast('Status saved'); A.redraw();
      reportMenuDialog(lastSnap());
    } },
      h('h3', {}, `Close the week – ${S.plan.name}`),
      h('div', { class: 'facts' }, facts.map(f => h('div', {}, f))),
      h('table', { class: 'rep ragtbl' }, h('tbody', {}, keys.map(row))),
      h('div', { class: 'row2' }, h('div', {}, h('label', {}, 'Done this week'), done), h('div', {}, h('label', {}, 'Next week'), next)),
      h('div', { class: 'row2' }, h('div', {}, h('label', {}, 'Decisions or help needed'), dec), h('div', {}, h('label', {}, 'Notes'), notes)),
      h('p', { class: 'hint', style: 'margin:0' }, `Saves a snapshot dated ${n.statusDate} (the status date${S.plan.statusDate ? '' : ' – today'}). Saving again the same day updates it.`),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, exists ? 'Update the status' : 'Save the status'))));
  document.body.append(dlg); dlg.showModal();
}
function reportMenuDialog(snap) {
  if (!snap) return;
  const dlg = h('dialog', { class: 'dlg', onclose: () => dlg.remove() },
    h('form', { method: 'dialog' }, h('h3', {}, 'Send the status report'),
      h('p', { class: 'hint', style: 'margin:0' }, 'Built from the snapshot, so the numbers are exact. Rates are never included.'),
      h('div', { class: 'actions', style: 'flex-wrap:wrap' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => writeNote(snap) }, icon('file'), 'Save as a note in Obsidian'),
        h('button', { type: 'button', class: 'btn', onclick: () => emailDraft(snap) }, icon('down'), 'Email draft (.eml)'),
        h('button', { type: 'button', class: 'btn', onclick: () => copyHtml(snap) }, 'Copy for an email'),
        h('button', { type: 'button', class: 'btn', onclick: () => printReport(snap) }, icon('print'), 'Print / PDF')),
      h('div', { class: 'btns' }, h('button', { class: 'btn' }, 'Close'))));
  document.body.append(dlg); dlg.showModal();
}

// ---------- the report ----------
const prevOf = snap => { const all = snaps(), i = all.findIndex(x => x.id === snap.id); return i > 0 ? all[i - 1] : null; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function milestoneRows(snap) {
  const prev = prevOf(snap), ids = rowIds();
  return Object.entries(snap.milestones || {}).map(([u, date]) => {
    const t = taskOf(+u), b = t && (t.baselines || {})[S.baselineN], was = prev && prev.milestones ? prev.milestones[u] : null;
    const pct = snap.tasks && snap.tasks[u] ? snap.tasks[u][2] : 0;
    return { id: ids.get(+u), name: t ? t.name : (snap.tasks && snap.tasks[u] ? snap.tasks[u][3] : 'Milestone'), baseline: b ? b.finish.slice(0, 10) : '', was: was || '', now: date, done: pct >= 100,
      move: was ? Math.round((E.toMin(date) - E.toMin(was)) / E.DAY) : null };
  }).sort((a, b) => a.now.localeCompare(b.now));
}
function summaryText(snap) {
  const r = snap.rag || {}, rs = r.reasons || {};
  const parts = [`${RAG[r.overall] || 'No status'}${rs.overall ? ': ' + rs.overall : '.'}`];
  for (const k of ['schedule', 'cost', 'scope']) if (r[k] && r[k] !== 'green') parts.push(`${k[0].toUpperCase() + k.slice(1)} ${RAG[r[k]].toLowerCase()}${rs[k] ? ' – ' + rs[k] : ''}.`);
  parts.push(`Forecast finish ${snap.finish}${snap.baselineFinish ? ` (baseline ${snap.baselineFinish})` : ''}; ${snap.pct}% complete against ${snap.pctExpected}% expected.`);
  return parts.join(' ');
}
export function reportMarkdown(snap) {
  const p = S.plan, proj = p.projectId && state.projects.find(x => x.id === p.projectId), r = snap.rag || {}, ev = snap.ev;
  const dot = c => ({ green: '🟢', amber: '🟠', red: '🔴' })[c] || '⚪';
  const md = [`# ${p.name} – status ${snap.statusDate}`, '',
    `**Overall:** ${dot(r.overall)} ${RAG[r.overall] || '–'} · **Schedule:** ${dot(r.schedule)} · **Cost:** ${dot(r.cost)} · **Scope:** ${dot(r.scope)}`,
    `${proj ? `**Project:** ${projectLabel(proj)} (${proj.network}/${proj.activity}) · ` : ''}**Status date:** ${snap.statusDate}${snap.postedThrough ? ` · **ERP posted through:** ${snap.postedThrough}` : ''}`, '',
    '## Summary', '', summaryText(snap), '', '## Milestones', '', '| Milestone | Baseline | Last week | Now | Change |', '| --- | --- | --- | --- | --- |'];
  for (const m of milestoneRows(snap)) md.push(`| ${m.done ? '✓ ' : ''}${m.name.replace(/\|/g, '\\|')} | ${m.baseline} | ${m.was} | ${m.now} | ${m.move ? (m.move > 0 ? '+' : '') + m.move + ' d' : ''} |`);
  md.push('', '## Done this week', '', ...(snap.done || []).map(x => '- ' + x), (snap.done || []).length ? '' : '- (nothing finished)', '', '## Next week', '', ...(snap.next || []).map(x => '- ' + x), '');
  if (ev) md.push('## Budget', '', '| Budget | Cost to date | Earned value | Planned value | CPI | SPI | Forecast at completion |', '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${ev.budget ? money(ev.budget) : money(ev.bac)} | ${money(ev.ac)} | ${money(ev.ev)} | ${money(ev.pv)} | ${ev.cpi ?? '–'} | ${ev.spi ?? '–'} | ${money(ev.eac)} |`, '',
    ev.runOut ? `At this rate the budget runs out on ${ev.runOut}.` : '', '');
  if ((snap.overBudget || []).length) md.push('Tasks heading over their budget:', '', ...snap.overBudget.map(x => `- ${x.name}: forecast ${money(x.forecast)} against a ${money(x.budget)} budget`), '');
  const risks = (snap.raid || []).filter(x => x.kind === 'risk' || x.kind === 'issue').sort((a, b) => b.score - a.score);
  if (risks.length) { md.push('## Risks and issues', '', '| | Title | Owner | Due |', '| --- | --- | --- | --- |'); for (const x of risks) md.push(`| ${x.kind}${x.kind === 'risk' ? ` (${x.score})` : ''} | ${x.title.replace(/\|/g, '\\|')} | ${x.owner} | ${x.due} |`); md.push(''); }
  if ((snap.decisions || []).length) md.push('## Decisions or help needed', '', ...snap.decisions.map(x => '- ' + x), '');
  if (snap.notes) md.push('## Notes', '', snap.notes, '');
  md.push(`_Written by Keystone from the status snapshot of ${snap.date}._`);
  return md.filter(x => x != null).join('\n');
}
export function reportHtml(snap) {
  const p = S.plan, r = snap.rag || {}, ev = snap.ev, col = { green: '#15803d', amber: '#b45309', red: '#c81e1e' };
  const chip = c => `<span style="display:inline-block;padding:2px 9px;border-radius:10px;background:${col[c] || '#6c7689'};color:#fff;font-weight:600;font-size:12px">${RAG[c] || 'No status'}</span>`;
  const tr = cells => `<tr>${cells.map(c => `<td style="padding:4px 10px;border-bottom:1px solid #e4e8ef">${c}</td>`).join('')}</tr>`;
  const th = cells => `<tr>${cells.map(c => `<th style="text-align:left;padding:4px 10px;border-bottom:2px solid #c9d0dc;font-size:12px;color:#3b4558">${c}</th>`).join('')}</tr>`;
  const list = xs => xs && xs.length ? `<ul>${xs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p style="color:#6c7689">–</p>';
  const ms = milestoneRows(snap);
  const risks = (snap.raid || []).filter(x => x.kind === 'risk' || x.kind === 'issue').sort((a, b) => b.score - a.score);
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#18202f;max-width:820px">
<h2 style="margin:0 0 4px">${esc(p.name)} – status ${snap.statusDate}</h2>
<p style="margin:0 0 12px">Overall ${chip(r.overall)} &nbsp; Schedule ${chip(r.schedule)} &nbsp; Cost ${chip(r.cost)} &nbsp; Scope ${chip(r.scope)}${snap.postedThrough ? ` &nbsp; <span style="color:#6c7689">ERP posted through ${snap.postedThrough}</span>` : ''}</p>
<h3>Summary</h3><p>${esc(summaryText(snap))}</p>
<h3>Milestones</h3><table style="border-collapse:collapse">${th(['Milestone', 'Baseline', 'Last week', 'Now', 'Change'])}${ms.map(m => tr([(m.done ? '✓ ' : '') + esc(m.name), m.baseline, m.was, `<b>${m.now}</b>`, m.move ? `<span style="color:${m.move > 0 ? '#c81e1e' : '#15803d'}">${m.move > 0 ? '+' : ''}${m.move} d</span>` : ''])).join('')}</table>
${trendSvg(snap ? snaps().filter(x => x.date <= snap.date) : snaps(), { width: 760, inline: true })}
<h3>Done this week</h3>${list(snap.done)}<h3>Next week</h3>${list(snap.next)}
${ev ? `<h3>Budget</h3><table style="border-collapse:collapse">${th(['Budget', 'Cost to date', 'Earned value', 'Planned value', 'CPI', 'SPI', 'Forecast'])}${tr([money(ev.budget || ev.bac), money(ev.ac), money(ev.ev), money(ev.pv), ev.cpi ?? '–', ev.spi ?? '–', money(ev.eac)])}</table>${ev.runOut ? `<p>At this rate the budget runs out on ${ev.runOut}.</p>` : ''}` : ''}
${(snap.overBudget || []).length ? `<p><b>Tasks heading over their budget:</b> ${snap.overBudget.map(x => `${esc(x.name)} (forecast ${money(x.forecast)} against ${money(x.budget)})`).join('; ')}</p>` : ''}
${risks.length ? `<h3>Risks and issues</h3><table style="border-collapse:collapse">${th(['', 'Title', 'Owner', 'Due'])}${risks.map(x => tr([x.kind + (x.kind === 'risk' ? ` (${x.score})` : ''), esc(x.title), esc(x.owner), x.due])).join('')}</table>` : ''}
${(snap.decisions || []).length ? `<h3>Decisions or help needed</h3>${list(snap.decisions)}` : ''}${snap.notes ? `<h3>Notes</h3><p>${esc(snap.notes)}</p>` : ''}
<p style="color:#6c7689;font-size:12px">Written by Keystone from the status snapshot of ${snap.date}.</p></div>`;
}
async function writeNote(snap) {
  if (!state.settings.vaultPath) return toast('Connect your vault in Settings first');
  const folder = (state.settings.vaultFolder || 'Keystone').replace(/^\/+|\/+$/g, '');
  const path = `${folder}/Status/${S.plan.name.replace(/[\\/:*?"<>|]/g, '-')}/${snap.statusDate}.md`;
  try {
    let base = null;
    try { base = (await api('/api/notes/file?path=' + encodeURIComponent(path))).mtime; } catch {}
    await api('/api/notes/file', { path, content: reportMarkdown(snap), base }, 'PUT');
    toast(`Saved ${path}`);
  } catch (e) { toast(e.message); }
}
function emailDraft(snap) {
  const subject = `${S.plan.name} – status ${snap.statusDate} (${RAG[(snap.rag || {}).overall] || 'status'})`;
  const html = `<html><body>${reportHtml(snap)}</body></html>`;
  const eml = ['X-Unsent: 1', `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', html].join('\r\n');
  download(`${S.plan.name} status ${snap.statusDate}.eml`, eml, 'message/rfc822');
  toast('Open the .eml file – Outlook opens it as a draft to send');
}
async function copyHtml(snap) {
  const html = reportHtml(snap), text = reportMarkdown(snap);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
    toast('Copied – paste it into an email');
  } catch { await navigator.clipboard.writeText(text).catch(() => {}); toast('Copied as text'); }
}
function printReport(snap) {
  const w = window.open('', '_blank');
  if (!w) return toast('Allow pop-ups to print');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(S.plan.name)} status ${snap.statusDate}</title><style>body{margin:24px} @page{margin:14mm}</style></head><body>${reportHtml(snap)}<script>setTimeout(()=>print(),300)<\/script></body></html>`);
  w.document.close();
}

// ---------- milestone trend chart ----------
// x: report dates; y: each milestone's forecast date. A flat line is holding; a rising one is slipping each week.
const CAT = ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#d55e00', '#56b4e9', '#6b7280', '#8a6d00'];  // Okabe–Ito: tells apart with colour-blindness; lines are also labelled
export function trendSvg(list, opts = {}) {
  const pts = [...list.map(s => ({ x: s.statusDate || s.date, m: s.milestones || {} }))];
  if (!opts.noLive && S.sched) { const n = currentNumbers(); if (!pts.some(p => p.x === n.statusDate)) pts.push({ x: n.statusDate, m: n.milestones, live: true }); }
  if (pts.length < 2) return opts.inline ? '' : null;
  pts.sort((a, b) => a.x.localeCompare(b.x));
  const ids = [...new Set(pts.flatMap(p => Object.keys(p.m)))];
  const last = pts[pts.length - 1].m;
  const pick = ids.filter(u => last[u] && last[u] >= pts[0].x).sort((a, b) => last[a].localeCompare(last[b])).slice(0, 8);  // milestones done before the history began are flat lines – leave them out
  if (!pick.length) return opts.inline ? '' : null;
  const W = opts.width || 900, H = 300, L0 = 70, R = 170, T = 16, B = 34;
  const xs = pts.map(p => E.toMin(p.x)), ys = pts.flatMap(p => pick.map(u => p.m[u]).filter(Boolean)).map(E.toMin);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys, x0), y1 = Math.max(...ys);
  const X = t => L0 + (t - x0) / Math.max(1, x1 - x0) * (W - L0 - R), Y = t => T + (1 - (t - y0) / Math.max(1, y1 - y0)) * (H - T - B);
  const md = t => E.dateOf(t).slice(5).replace('-', '/');
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${opts.inline ? W : '100%'}" role="img" aria-label="Milestone forecast dates at each status report" style="font:11px Segoe UI,Arial,sans-serif">`;
  const ink = opts.inline ? '#6c7689' : 'var(--muted)', grid = opts.inline ? '#e4e8ef' : 'var(--line)';
  for (let i = 0; i <= 4; i++) { const t = y0 + (y1 - y0) * i / 4; out += `<line x1="${L0}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}" stroke="${grid}"/><text x="${L0 - 6}" y="${Y(t) + 4}" text-anchor="end" fill="${ink}">${md(t)}</text>`; }
  pts.forEach((p, i) => { out += `<text x="${X(xs[i])}" y="${H - B + 16}" text-anchor="middle" fill="${ink}">${md(xs[i])}${p.live ? '*' : ''}</text>`; });
  // the diagonal: a milestone that reaches it is due on that report date
  out += `<line x1="${X(Math.max(x0, y0))}" y1="${Y(Math.max(x0, y0))}" x2="${X(Math.min(x1, y1))}" y2="${Y(Math.min(x1, y1))}" stroke="${ink}" stroke-dasharray="3 4"/>`;
  const labels = [];
  pick.forEach((u, k) => {
    const c = CAT[k % CAT.length], seq = pts.map((p, i) => p.m[u] ? [X(xs[i]), Y(E.toMin(p.m[u]))] : null).filter(Boolean);
    if (!seq.length) return;
    out += `<path d="${seq.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')}" fill="none" stroke="${c}" stroke-width="2"/>`;
    for (const [x, y] of seq) out += `<circle cx="${x}" cy="${y}" r="4" fill="${c}" stroke="${opts.inline ? '#fff' : 'var(--card)'}" stroke-width="2"/>`;
    const [lx, ly] = seq[seq.length - 1], t = taskOf(+u);
    labels.push({ x: lx + 8, y: ly + 4, c, name: (t ? t.name : 'Milestone').slice(0, 24) });
  });
  labels.sort((a, b) => a.y - b.y);  // keep the end labels from overlapping: at least 14px apart, top to bottom
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 14);
  for (const l of labels) out += `<text x="${l.x}" y="${l.y}" fill="${opts.inline ? '#18202f' : 'var(--ink)'}">${esc(l.name)}</text>`;
  out += '</svg>';
  return out;
}

// ---------- the Status view ----------
export function statusView(A) {
  if (!S.statusCache || S.statusCache.planId !== S.plan.id) {
    loadStatus(S.plan.id).then(() => A.redraw()).catch(e => toast(e.message));
    return h('section', { class: 'card pl-view' }, h('p', { class: 'hint' }, 'Loading status history…'));
  }
  if (!planCosts()) ensurePlanCosts().then(() => A.redraw()).catch(() => {});
  const all = snaps(), latest = all[all.length - 1];
  const trend = trendSvg(all);
  const trendBox = h('div', { class: 'trend' });
  if (trend) trendBox.innerHTML = trend; else trendBox.append(h('p', { class: 'hint' }, 'The trend appears after the first status: each report adds a point for every milestone. Flat lines are holding; rising lines are slipping.'));
  const rows = [...all].reverse().map((s, i, arr) => {
    const prev = arr[i + 1], df = prev ? Math.round((E.toMin(s.finish) - E.toMin(prev.finish)) / E.DAY) : null;
    return h('tr', {},
      h('td', {}, s.statusDate), h('td', {}, ragChip(s.rag && s.rag.overall)), h('td', { class: 'hint' }, (s.rag && s.rag.reasons && s.rag.reasons.overall) || ''),
      h('td', {}, s.finish, df ? h('span', { class: df > 0 ? 'neg' : 'pos' }, ` ${df > 0 ? '+' : ''}${df} d`) : null),
      h('td', { class: 'num' }, `${s.pct}% / ${s.pctExpected}%`), h('td', { class: 'num' }, s.ev && s.ev.cpi != null ? String(s.ev.cpi) : '–'), h('td', { class: 'num' }, s.ev && s.ev.spi != null ? String(s.ev.spi) : '–'),
      h('td', { class: 'num' }, s.ev ? money(s.ev.ac) : '–'),
      h('td', {}, h('button', { class: 'btn ghost sm', onclick: () => reportMenuDialog(s) }, 'Report…')));
  });
  const cmpSel = h('select', { onchange: e => { S.cmpWith = e.target.value; A.redraw(); } },
    all.length ? [...all].reverse().map(s => h('option', { value: 's:' + s.id, selected: S.cmpWith === 's:' + s.id ? '' : false }, `Status of ${s.statusDate}`)) : null,
    Array.from({ length: 11 }, (_, i) => i).filter(i => S.plan.tasks.some(t => (t.baselines || {})[i])).map(i => h('option', { value: 'b:' + i, selected: S.cmpWith === 'b:' + i ? '' : false }, `Baseline ${i}`)));
  if (!S.cmpWith && cmpSel.options.length) S.cmpWith = cmpSel.options[0].value;
  return h('section', { class: 'pl-view' },
    h('div', { class: 'card' },
      h('div', { class: 'pl-tools' }, h('h2', { style: 'margin:0' }, 'Status'), latest ? ragChip(latest.rag && latest.rag.overall) : ragChip(null),
        h('span', { class: 'hint' }, latest ? `Last closed ${latest.statusDate}${latest.rag && latest.rag.reasons && latest.rag.reasons.overall ? ' · ' + latest.rag.reasons.overall : ''}` : 'Close the week to save the first status snapshot.'),
        h('div', { class: 'spacer' }),
        latest ? h('button', { class: 'btn', onclick: () => reportMenuDialog(latest) }, icon('file'), 'Report…') : null,
        h('button', { class: 'btn primary', onclick: () => closeWeekDialog(A) }, 'Close the week…')),
      h('h3', {}, 'Milestone trend'), trendBox),
    all.length ? h('div', { class: 'card' }, h('h3', {}, 'Status history'), h('div', { class: 'tablewrap' }, h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Status date', 'Overall', 'Why', 'Finish', '% done / expected', 'CPI', 'SPI', 'Cost', ''].map(x => h('th', {}, x)))), h('tbody', {}, rows)))) : null,
    h('div', { class: 'card' }, h('div', { class: 'pl-tools' }, h('h3', { style: 'margin:0' }, 'What changed since'), cmpSel), changes(A, S.cmpWith)));
}
/** Tasks added, removed, moved; progress; risks – between a snapshot (or baseline) and now. */
function changes(A, ref) {
  if (!ref) return h('p', { class: 'hint' }, 'Set a baseline or close a week to compare against.');
  const ids = rowIds(), s = S.sched, now = {};
  for (const u of s.order) { const r = s.byUid.get(u); now[u] = [E.dateOf(r.es), E.dateOf(r.ef), r.pct || 0, taskOf(u).name, r.summary]; }
  let then = {}, raidThen = null, label = '';
  if (ref.startsWith('s:')) { const sn = snaps().find(x => 's:' + x.id === ref); if (!sn) return h('p', { class: 'hint' }, '–'); then = sn.tasks || {}; raidThen = sn.raid || []; label = `status of ${sn.statusDate}`; }
  else { const n = +ref.slice(2); for (const t of S.plan.tasks) { const b = (t.baselines || {})[n]; if (b) then[t.uid] = [b.start.slice(0, 10), b.finish.slice(0, 10), null, t.name]; } label = `baseline ${n}`; }
  const added = Object.keys(now).filter(u => !then[u] && !now[u][4]), removed = Object.keys(then).filter(u => !now[u]);
  const moved = Object.keys(now).filter(u => then[u] && !now[u][4] && then[u][1] !== now[u][1]).map(u => ({ u, d: Math.round((E.toMin(now[u][1]) - E.toMin(then[u][1])) / E.DAY) })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const prog = Object.keys(now).filter(u => then[u] && then[u][2] != null && !now[u][4] && then[u][2] !== now[u][2]);
  const openNow = (S.plan.raid || []).filter(x => x.status !== 'closed');
  const newRisks = raidThen ? openNow.filter(x => !raidThen.some(y => y.id === x.id)) : [], closed = raidThen ? raidThen.filter(y => !openNow.some(x => x.id === y.id)) : [];
  const li = (txt, cls = '') => h('li', { class: cls }, txt);
  const go = u => h('button', { class: 'btn ghost sm', onclick: () => A.select(+u) }, String(ids.get(+u) || ''));
  return h('div', { class: 'changes' },
    h('p', { class: 'hint' }, `Compared with the ${label}: ${moved.length} tasks moved, ${added.length} added, ${removed.length} removed${raidThen ? `, ${newRisks.length} new and ${closed.length} closed issues/risks` : ''}.`),
    moved.length ? h('div', {}, h('b', {}, 'Moved'), h('ul', {}, moved.slice(0, 25).map(m => li([go(m.u), ` ${now[m.u][3]}: finish ${then[m.u][1]} → ${now[m.u][1]} `, h('span', { class: m.d > 0 ? 'neg' : 'pos' }, `(${m.d > 0 ? '+' : ''}${m.d} d)`)])))) : null,
    prog.length ? h('div', {}, h('b', {}, 'Progress'), h('ul', {}, prog.slice(0, 25).map(u => li([go(u), ` ${now[u][3]}: ${then[u][2]}% → ${now[u][2]}%`])))) : null,
    added.length ? h('div', {}, h('b', {}, 'Added'), h('ul', {}, added.map(u => li([go(u), ' ' + now[u][3]])))) : null,
    removed.length ? h('div', {}, h('b', {}, 'Removed'), h('ul', {}, removed.map(u => li(then[u][3])))) : null,
    newRisks.length ? h('div', {}, h('b', {}, 'New issues and risks'), h('ul', {}, newRisks.map(x => li(`${x.kind}: ${x.title}`)))) : null,
    closed.length ? h('div', {}, h('b', {}, 'Closed'), h('ul', {}, closed.map(x => li(`${x.kind}: ${x.title}`)))) : null);
}
