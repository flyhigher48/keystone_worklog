// Keystone slash commands – result templates: the cards for /hours, /left, /leave, /budget, /briefme, and the weekly status
// note. Built from Keystone's own data (no LLM). A note in the templates folder named "Keystone – Weekly status" (or
// "Keystone – Brief me") replaces the built-in layout; its {{placeholders}} are filled the same way.
import { addDays } from './syntax.js';
import { sectionLines, sectionItems } from './registry.js';

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const md = s => String(s ?? '').replace(/([\\`*_[\]|])/g, '\\$1');
const link = p => `[[${String(p).split('/').pop().replace(/\.md$/i, '')}]]`;
const list = (rows, empty = '- none') => (rows.length ? rows.join('\n') : empty);

export function hours(ctx, from, to) {
  const { rows, total, byDay } = ctx.hoursBy(from, to);
  const one = from === to;
  const table = rows.length ? ['| Project | Code | Hours |', '|---|---|--:|', ...rows.map(r => `| ${md(r.label)} | ${r.code}${r.ts ? ' TS' : ''} | ${r2(r.hours)} |`), `| **Total** | | **${r2(total)}** |`].join('\n') : '_No hours logged._';
  const days = !one && byDay.length <= 14 ? '\n\n' + byDay.map(d => `${ctx.fmt(d.date, 'ddd D')}: ${r2(d.hours)}${d.scheduled ? '/' + r2(d.scheduled) : ''}`).join(' · ') : '';
  return { title: one ? `Hours on ${ctx.fmt(from, 'ddd MMM D')}` : `Hours ${ctx.fmt(from, 'MMM D')} – ${ctx.fmt(to, 'MMM D')}`, md: table + days };
}
export function left(ctx) {
  const today = ctx.today(), d = ctx.dayInfo(today), per = ctx.periodInfo(today);
  return { title: 'Hours left', md: [
    `- **Today:** ${r2(d.logged)} of ${r2(d.scheduled)} h${d.holiday ? ` (holiday: ${md(d.holiday)})` : ''} → ${r2(Math.max(0, d.scheduled - d.logged))} h to go`,
    `- **Pay period ${ctx.fmt(per.start, 'MMM D')} – ${ctx.fmt(per.end, 'MMM D')}:** ${r2(per.entered)} of ${r2(per.target)} h → ${r2(Math.max(0, per.target - per.entered))} h to go${per.submitted ? ' (submitted)' : ''}`].join('\n'),
    actions: [{ label: 'Fill today', fill: '/log day ' }] };
}
export function leave(ctx) {
  const b = ctx.leaveBalances();
  const row = (k, l) => (b[k] ? `| ${l} | ${r2(b[k].now)} | ${r2(b[k].yearEnd)} |` : `| ${l} | — | — |`);
  return { title: 'Leave balances', md: ['| Leave | Now (h) | Year end (h) |', '|---|--:|--:|', row('annual', 'Annual'), row('sick', 'Sick'),
    b.carryLimit && b.annual && b.annual.yearEnd > b.carryLimit ? `\n⚠ Annual leave is projected ${r2(b.annual.yearEnd - b.carryLimit)} h over the ${r2(b.carryLimit)} h carry-over limit.` : ''].join('\n') };
}
export function budget(ctx, proj) {
  const rows = ctx.budgetRows().filter(r => !proj || r.id === proj.id);
  if (!rows.length) return { title: 'Budgets', md: '_No projects with an hours budget._' };
  return { title: proj ? `Budget · ${ctx.projectLabel(proj)}` : 'Budgets', md: ['| Project | Used | Budget | Left | Burn/wk | Runs out |', '|---|--:|--:|--:|--:|---|',
    ...rows.map(r => `| ${md(r.label)} | ${r2(r.used)} | ${r2(r.budget)} | ${r.left < 0 ? '**' + r2(r.left) + '**' : r2(r.left)} | ${r.rate ? r2(r.rate) : '—'} | ${r.runOut || '—'} |`)].join('\n') };
}

/** The open/ticked items of each day in Today.md between two dates. */
async function capturedDays(ctx, from, to) {
  const text = await ctx.readNote(ctx.captureFile());
  if (text == null) return [];
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const sec = sectionLines(text, ctx.dayHeading(d));
    if (sec) out.push({ date: d, items: sectionItems(sec) });
  }
  return out;
}

export async function brief(ctx) {
  const today = ctx.today(), d = ctx.dayInfo(today), per = ctx.periodInfo(today), soon = addDays(today, 7);
  const open = ctx.cards().filter(c => c.status !== 'done');
  const over = open.filter(c => c.due && c.due < today), due = open.filter(c => c.due && c.due >= today && c.due <= soon).sort((a, b) => a.due.localeCompare(b.due));
  const fus = ctx.followups().filter(f => f.status !== 'done' && f.due && f.due <= addDays(today, 1));
  const lv = ctx.leaveBalances(), warn = ctx.warnings();
  let recent = [];
  try { recent = ((await ctx.read('recent_notes', { days: 2, limit: 8 })).data || []).map(x => x.path); } catch {}
  const cap = (await capturedDays(ctx, today, today))[0];
  const card = c => `${md(c.title)}${c.projectId ? ' · ' + md(ctx.projectName(c.projectId)) : ''}${c.due ? ` · ${c.due < today ? 'was due' : 'due'} ${ctx.fmt(c.due, 'ddd MMM D')}` : ''}`;
  const values = {
    hours_today: `${r2(d.logged)} of ${r2(d.scheduled)} h logged today${d.holiday ? ` (holiday: ${d.holiday})` : ''}`,
    hours_period: `${r2(per.entered)} of ${r2(per.target)} h this pay period (${ctx.fmt(per.start, 'MMM D')} – ${ctx.fmt(per.end, 'MMM D')})`,
    cards_overdue: list(over.map(c => `- ⚠ ${card(c)}`)), cards_due: list(due.map(c => `- ${card(c)}`)),
    followups_due: list(fus.map(f => `- ${md(f.subject)}${f.from ? ' · ' + md(f.from) : ''} · reply by ${f.due}`)),
    leave: `Annual ${lv.annual ? r2(lv.annual.now) : '—'} h · sick ${lv.sick ? r2(lv.sick.now) : '—'} h`,
    warnings: list(warn.map(w => `- ${md(w)}`)), notes_changed: list(recent.map(p => `- ${link(p)}`)),
    today_items: cap ? list(cap.items.map(x => `- ${x.box != null ? `[${x.box}] ` : ''}${md(x.text)}`), '- nothing yet') : '- nothing yet',
  };
  const tpl = await ctx.keystoneTemplate('Brief me');
  const body = tpl ? fill(ctx.applyTemplate(tpl, 'Brief'), values) : [
    `- ${values.hours_today}`, `- ${values.hours_period}`, `- ${values.leave}`,
    `\n**Overdue**\n${values.cards_overdue}`, `\n**Due in the next 7 days**\n${values.cards_due}`, `\n**Replies due**\n${values.followups_due}`,
    warn.length ? `\n**Heads-up**\n${values.warnings}` : '', `\n**Today so far**\n${values.today_items}`, recent.length ? `\n**Notes changed in the last 2 days**\n${values.notes_changed}` : ''].filter(Boolean).join('\n');
  return { title: `Briefing · ${ctx.fmt(today, 'dddd, MMMM D')}`, md: body, actions: [{ label: 'Hours left', cmd: '/left' }, { label: 'Overdue cards', cmd: '/cards overdue' }] };
}

/** Replaces {{key}} with values; unknown placeholders stay as they are, so a typo is visible. */
export const fill = (text, values) => text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in values ? String(values[k]) : m));

export const WEEKLY_DEFAULT = `# Weekly status {{week_start}}

Week of {{week_start}} to {{week_end}}.

## Summary
- {{hours_total}} h logged · {{cards_done_count}} cards done · {{cards_due_count}} due next week · {{cards_overdue_count}} overdue

## Hours by project
{{hours_table}}

## Completed
{{cards_done}}
{{today_done}}

## In progress / next
{{cards_doing}}
{{cards_due}}

## Blockers or risks
{{cards_blocked}}
{{cards_overdue}}

## Notes changed
{{notes_changed}}
`;

export async function weekly(ctx, from, to) {
  const today = ctx.today(), next = addDays(to, 7);
  const { rows, total } = ctx.hoursBy(from, to);
  const cards = ctx.cards(), card = c => `- ${md(c.title)}${c.projectId ? ' · ' + md(ctx.projectName(c.projectId)) : ''}${c.due ? ` · due ${c.due}` : ''}`;
  const done = cards.filter(c => c.status === 'done' && (!c.due || (c.due >= from && c.due <= to)));
  const doing = cards.filter(c => c.status === 'doing'), blocked = cards.filter(c => c.status === 'blocked');
  const due = cards.filter(c => c.status !== 'done' && c.due && c.due > to && c.due <= next), over = cards.filter(c => c.status !== 'done' && c.due && c.due < today);
  const days = await capturedDays(ctx, from, to);
  let notes = [];
  try { notes = ((await ctx.read('recent_notes', { days: Math.max(1, Math.round((Date.parse(today) - Date.parse(from)) / 864e5) + 1), limit: 60 })).data || []).filter(x => { const d = ctx.isoOfTime(x.mtime); return d >= from && d <= to; }).map(x => x.path); } catch {}
  const values = {
    week_start: from, week_end: to, hours_total: r2(total),
    hours_table: rows.length ? ['| Project | Hours |', '|---|--:|', ...rows.map(r => `| ${md(r.label)}${r.code !== 'RG' ? ' (' + r.code + ')' : ''} | ${r2(r.hours)} |`), `| **Total** | **${r2(total)}** |`].join('\n') : '_No hours logged._',
    cards_done: list(done.map(card), '- (no cards marked done)'), cards_done_count: done.length,
    cards_doing: list(doing.map(card), '- (nothing in progress)'), cards_blocked: list(blocked.map(card), '- none'),
    cards_due: list(due.map(card), '- (nothing due next week)'), cards_due_count: due.length,
    cards_overdue: list(over.map(c => card(c) + ' ⚠ overdue'), ''), cards_overdue_count: over.length,
    today_done: days.flatMap(d => d.items.filter(x => x.box === 'x').map(x => `- ${md(x.text.replace(/\s*→ .*$/, ''))} (${ctx.fmt(d.date, 'ddd')})`)).join('\n'),
    today_sections: days.map(d => `### ${ctx.dayHeading(d.date)}\n${d.items.map(x => x.line.trim()).join('\n')}`).join('\n\n'),
    notes_changed: list(notes.map(p => `- ${link(p)}`)), followups_open: list(ctx.followups().filter(f => f.status !== 'done').map(f => `- ${md(f.subject)}${f.from ? ' · ' + md(f.from) : ''}`)),
  };
  const tpl = await ctx.keystoneTemplate('Weekly status');
  const content = fill(ctx.applyTemplate(tpl || WEEKLY_DEFAULT, `Weekly status ${from}`), values).replace(/\n{3,}/g, '\n\n');
  let path = `Reports/Weekly status ${from}.md`;
  for (let n = 2; (await ctx.readNote(path)) != null && n < 50; n++) path = `Reports/Weekly status ${from} (${n}).md`;
  return { path, content };
}
