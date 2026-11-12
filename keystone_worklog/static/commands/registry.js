// Keystone slash commands – every command: its syntax, help, examples, and build(), which turns the parsed command into
// steps. A step is a tool call (the same tools the assistant uses, with the same preview, approval and undo) or a
// read/UI action. Nothing here touches the page directly: everything goes through ctx (built in index.html → cmdCtx),
// so the commands can be tested with a fake ctx.
import { parseDate, parseRange, parseHours, parseMoney, parsePercent, isDuration, takeDate, takeRange, takeFlags, textOf, splitOn, parseArgs,
  addDays, datesIn, dayOfWeek, dateOf } from './syntax.js';
import { resolve, norm } from './resolve.js';
import * as R from './render.js';

/* ---------- small helpers ---------- */
export const fail = (error, choices) => ({ error, choices });
const plan = (describe, steps, extra = {}) => ({ describe, steps, ...extra });
const write = (tool, args, label, o = {}) => ({ tool, args, label, write: true, ...o });
const act = (label, run, o = {}) => ({ label, run, ...o });
export const quote = s => (/[\s"#@:;|]/.test(String(s)) || !s ? `"${String(s).replace(/["\\]/g, '\\$&')}"` : String(s));
const base = p => String(p || '').split('/').pop();
const stem = p => base(p).replace(/\.md$/i, '');
const link = p => `[[${/\.md$/i.test(p) ? stem(p) : base(p)}]]`;
const plural = (n, w, s = 's') => `${n} ${w}${n === 1 ? '' : s}`;
const md = s => String(s ?? '').replace(/([\\`*_[\]|])/g, '\\$1');
const ACCEPTS_LIST = ['notes', 'lines', 'cards', 'fus', 'tasks', 'todos'];

/** Replaces what the user typed with an exact name, for the "did you mean" buttons. */
function swap(raw, typed, exact) {
  const i = raw.indexOf(typed);
  return i < 0 ? raw : raw.slice(0, i) + exact + raw.slice(i + typed.length);
}
/** Resolves `typed` among items; returns { item } or a fail() with choices that rewrite the command. */
function pick(p, typed, items, { labels, kind, prefix = '', min, exactOf } = {}) {
  const r = resolve(typed, items, { labels, min });
  if (r.item) return r;
  const label = x => labels(x)[0];
  const from = prefix && p.raw.includes(prefix + typed) ? prefix + typed : p.raw.includes(prefix + quote(typed)) ? prefix + quote(typed) : typed;
  const as = x => (from.startsWith(prefix) ? prefix : '') + quote(exactOf ? exactOf(x) : label(x));
  if (r.choices) return fail(`“${typed}” matches ${plural(r.choices.length, kind)}. Which one?`, r.choices.map(x => ({ label: label(x), cmd: swap(p.raw, from, as(x)) })));
  return fail(`No ${kind} matches “${typed}”.`, r.suggestions.map(x => ({ label: `Did you mean ${label(x)}?`, cmd: swap(p.raw, from, as(x)) })));
}
const projectLabels = ctx => x => [ctx.projectLabel(x), x.name, x.network, `${x.network}/${x.activity}`].filter(Boolean);
function findProject(ctx, p, tag) { return pick(p, tag, ctx.projects(), { labels: projectLabels(ctx), kind: 'project', prefix: '#' }); }
const noteLabels = n => [stem(n.path), n.path.replace(/\.md$/i, ''), base(n.path)];
/** A note the user named: [[Name]], "Name", today, this (the open note). */
async function findNote(ctx, p, typed, { files = false } = {}) {
  const t = String(typed || '').trim().replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0];
  if (!t) return fail('Which note?');
  if (/^today$/i.test(t)) return { item: { path: ctx.captureFile() }, today: true };
  if (/^this$/i.test(t)) { const o = ctx.openNote(); return o ? { item: { path: o.path } } : fail('No note is open.'); }
  if (/\//.test(t) || /\.md$/i.test(t)) {  // a full path, e.g. a note an earlier command just made ($)
    const path = /\.[a-z0-9]+$/i.test(t) ? t : t + '.md';
    if ((await ctx.readNote(path)) != null) return { item: { path } };
  }
  const all = (await ctx.notes()).filter(n => files || n.type === 'note');
  const exact = all.find(n => n.path.toLowerCase() === t.toLowerCase() || n.path.toLowerCase() === (t + '.md').toLowerCase());
  if (exact) return { item: exact };
  const r = pick(p, t, all, { labels: noteLabels, kind: files ? 'file' : 'note', exactOf: n => n.path.replace(/\.md$/i, '') });
  if (r.item || r.choices || !ctx.embedQuery) return r;
  const j = await ctx.read('search_notes', { query: t, limit: 3, vector: await ctx.embedQuery(t) });  // nothing by name: try by meaning
  const hits = (j.data || []).filter(x => files || /\.md$/i.test(x.path));
  return hits.length ? fail(`No ${files ? 'file' : 'note'} is called “${t}”. These look related:`, hits.map(x => ({ label: x.path, cmd: swap(p.raw, typed, quote(x.path.replace(/\.md$/i, ''))) }))) : r;
}
/** The words that name something: quoted words first, else all of them. */
const nameOf = words => textOf(words);

/* ---------- Today.md ---------- */
const HEAD = /^(#{1,6})\s+(.*?)\s*#*\s*$/, FENCE = /^\s*(```|~~~)/, ITEM = /^\s*[-*+]\s+/, BOX = /^(\s*[-*+]\s+)\[( |x|X)\]\s?(.*)$/;
/** The section under a heading: { start (the heading's line), end (exclusive), level }, or null. */
export function sectionLines(text, heading) {
  const lines = text.split('\n'), want = heading.trim().toLowerCase();
  let fence = false, at = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) { fence = !fence; continue; }
    const m = fence ? null : lines[i].match(HEAD);
    if (!m) continue;
    if (at < 0) { if (m[2].trim().toLowerCase() === want) { at = i; level = m[1].length; } continue; }
    if (m[1].length <= level) return { lines, start: at, end: i, level };
  }
  return at < 0 ? null : { lines, start: at, end: lines.length, level };
}
/** The list items of a section: [{ i (line index), n (1-based), text, box: ' '|'x'|null, line }]. */
export function sectionItems(sec) {
  const out = [];
  let fence = false;
  for (let i = sec.start + 1; i < sec.end; i++) {
    const line = sec.lines[i];
    if (FENCE.test(line)) { fence = !fence; continue; }
    if (fence || !ITEM.test(line) || /^\s{2,}/.test(line)) continue;
    const b = line.match(BOX);
    out.push({ i, n: out.length + 1, line, box: b ? b[2].toLowerCase() : null, text: (b ? b[3] : line.replace(ITEM, '')).trim() });
  }
  return out;
}
/** An exact, unique edit of lines inside a section: old/new text from the heading line to the last changed line. */
export function sectionEdit(sec, changes) {
  const last = Math.max(...Object.keys(changes).map(Number));
  const oldLines = sec.lines.slice(sec.start, last + 1);
  const newLines = oldLines.map((l, k) => (changes[sec.start + k] != null ? changes[sec.start + k] : l));
  return { old_text: oldLines.join('\n'), new_text: newLines.join('\n') };
}
const itemText = t => t.replace(/^\d{1,2}:\d{2}\s+/, '').replace(/\s*→ carried$/, '');
async function todayDoc(ctx, date = ctx.today()) {
  const path = ctx.captureFile(), text = await ctx.readNote(path), heading = ctx.dayHeading(date);
  const sec = text == null ? null : sectionLines(text, heading);
  return { path, text, heading, sec, items: sec ? sectionItems(sec) : [] };
}
/** Steps that add lines under a day's heading in Today.md (creating the note and heading when needed). */
function todaySteps(ctx, lines, date = ctx.today(), quiet = true) {
  const heading = ctx.dayHeading(date);
  return [act('Today.md', () => ctx.ensureToday(date)),
    write('append_to_note', { path: ctx.captureFile(), under_heading: heading, text: lines.join('\n') }, `Add ${plural(lines.length, 'line')} to ${ctx.captureFile()}`, { quiet })];
}
/** Input from a pipe as Markdown lines. */
function inputLines(input, as = 'item') {
  if (!input) return [];
  const it = input.items || [];
  if (input.type === 'notes') return it.map(n => as === 'todo' ? `Review ${link(n.path)}` : link(n.path));
  if (input.type === 'cards') return it.map(c => c.title);
  if (input.type === 'fus') return it.map(f => `Reply${f.from ? ' to ' + f.from : ''}: ${f.subject}`);
  if (input.type === 'tasks' || input.type === 'todos') return it.map(t => t.text || t.name);
  return it.map(x => String(x.text ?? x));
}

/* ---------- the commands ---------- */
const C = [];
const def = c => { C.push(c); return c; };

/* Today */
def({ name: 'today', group: 'Today', sig: '/today [date]', help: "Show a day's section of your capture note (Today.md). With no date it also opens the note.",
  examples: ['/today', '/today yesterday', '/today mon', '/today 2026-11-03'], output: 'lines', intents: [[/^(show|open)?\s*(my )?today('s)?( note)?$/i, () => '/today']],
  async build(p, ctx) {
    const date = p.words.length ? takeDate(p.words, ctx.today(), { prefer: 'past' }).date : ctx.today();
    if (!date) return fail(`“${textOf(p.words)}” isn't a date I know (try yesterday, mon, nov 3, 2026-11-03).`);
    return plan(`Show ${ctx.fmt(date, 'ddd MMM D')} in ${ctx.captureFile()}`, [act('Read', async () => {
      if (!p.words.length) ctx.ui.openDaily();
      const d = await todayDoc(ctx, date);
      // ☐/☑ rather than [ ]/[x]: a Markdown task item hides its number, and /done needs it
      const body = d.items.length ? d.items.map(x => `${x.n}. ${x.box != null ? (x.box.trim() ? '☑ ' : '☐ ') : ''}${md(x.text)}`).join('\n') : d.sec ? '_Nothing captured yet._' : `_No “${d.heading}” section yet._`;
      return { type: 'lines', items: d.items.map(x => itemText(x.text)), card: { title: `${d.heading}`, md: body, actions: [{ label: 'Open', cmd: '/open today' }] } };
    })]);
  } });
def({ name: 'note', aliases: ['n'], group: 'Today', sig: '/note <text> [#project]', help: 'Add a timestamped line to today in Today.md.', accepts: ACCEPTS_LIST,
  examples: ['/note Called the county about the drainage memo #bridge', '/find bearing | note'], intents: [[/^(note|jot|capture)[: ]\s*(.+)$/i, m => `/note ${m[2]}`]],
  async build(p, ctx, input) {
    const text = p.rest.trim();
    const lines = input ? inputLines(input).map(l => ctx.captureLine(l, 'note')) : text ? [ctx.captureLine(text, 'note')] : [];
    if (!lines.length) return fail('What should I write? e.g. /note Called the county');
    return plan(`Add ${lines.length > 1 ? plural(lines.length, 'line') : `“${lines[0]}”`} under ${ctx.dayHeading(ctx.today())}`, todaySteps(ctx, lines), { main: ctx.captureFile() });
  } });
def({ name: 'todo', aliases: ['t'], group: 'Today', sig: '/todo <text> [due:fri] [#project]', help: 'Add a checkbox to today in Today.md.', accepts: ACCEPTS_LIST,
  examples: ['/todo Send the site photos due:fri #bridge', '/actions this | todo'], intents: [[/^(todo|to do|remind me to)[: ]\s*(.+)$/i, m => `/todo ${m[2]}`]],
  async build(p, ctx, input) {
    const text = p.raw.replace(/^\/\S+\s*/, '').trim();
    const lines = input ? inputLines(input, 'todo').map(l => ctx.captureLine(l, 'todo')) : text ? [ctx.captureLine(text, 'todo')] : [];
    if (!lines.length) return fail('What is the todo? e.g. /todo Send the photos due:fri');
    if (p.kv.due && !parseDate(p.kv.due, ctx.today())) return fail(`“due:${p.kv.due}” isn't a date I know (try fri, tomorrow, +3d, 2026-11-30).`);
    return plan(`Add ${lines.length > 1 ? plural(lines.length, 'todo') : `“${lines[0]}”`} under ${ctx.dayHeading(ctx.today())}`, todaySteps(ctx, lines), { main: ctx.captureFile() });
  } });
async function tick(p, ctx, to) {
  const d = await todayDoc(ctx);
  if (!d.sec) return fail(`There is no “${d.heading}” section in ${d.path} yet.`);
  const boxes = d.items.filter(x => x.box != null && (to === 'x' ? x.box === ' ' : x.box === 'x'));
  const want = textOf(p.words);
  if (!want) return fail(`Which item? Give its number from /today or some of its text.`);
  let hits;
  if (/^\d+(\s*,\s*\d+)*$/.test(want.replace(/\s+/g, ''))) {
    const ns = want.split(/[\s,]+/).filter(Boolean).map(Number);
    hits = ns.map(n => d.items.find(x => x.n === n));
    const bad = ns.filter((n, k) => !hits[k] || hits[k].box == null);
    if (bad.length) return fail(`Item ${bad.join(', ')} ${bad.length > 1 ? "aren't checkboxes" : "isn't a checkbox"} in today's section. See /today.`);
  } else {
    const r = resolve(want, boxes, { labels: x => [itemText(x.text)], min: 0.55 });
    if (r.choices) return fail(`“${want}” matches ${plural(r.choices.length, 'item')}. Which one?`, r.choices.map(x => ({ label: itemText(x.text), cmd: `/${p.cmd} ${x.n}` })));
    if (!r.item) return fail(`No ${to === 'x' ? 'open ' : 'ticked '}item matches “${want}”. See /today.`);
    hits = [r.item];
  }
  const changes = Object.fromEntries(hits.map(x => [x.i, x.line.replace(BOX, (_, a, b, rest) => `${a}[${to}] ${rest}`)]));
  return plan(`${to === 'x' ? 'Tick' : 'Untick'} ${hits.map(x => `“${itemText(x.text)}”`).join(', ')}`, [write('edit_note', { path: d.path, ...sectionEdit(d.sec, changes) }, 'Today.md')]);
}
def({ name: 'done', group: 'Today', sig: '/done <number | text>', help: "Tick a checkbox in today's section (number from /today, or some of its text).",
  examples: ['/done 3', '/done photos', '/done 2, 4'], intents: [[/^(i )?(finished|done with|completed)\s+(.+)$/i, m => `/done ${m[3]}`]], build: (p, ctx) => tick(p, ctx, 'x') });
def({ name: 'undone', group: 'Today', sig: '/undone <number | text>', help: "Untick a checkbox in today's section.", examples: ['/undone 3'], build: (p, ctx) => tick(p, ctx, ' ') });
def({ name: 'carry', group: 'Today', sig: '/carry [from:date]', help: 'Copy the unticked todos from the last day before today (or from:date) to today, and mark the originals “→ carried”.',
  examples: ['/carry', '/carry from:fri'], intents: [[/^carry (over|forward)?\s*(my )?(todos|tasks)?/i, () => '/carry']],
  async build(p, ctx) {
    const today = ctx.today(), path = ctx.captureFile(), text = await ctx.readNote(path);
    if (text == null) return fail(`There is no ${path} yet.`);
    let from = p.kv.from ? parseDate(p.kv.from, today, { prefer: 'past' }) : '', sec = null;
    if (p.kv.from && !from) return fail(`“from:${p.kv.from}” isn't a date I know.`);
    if (from) sec = sectionLines(text, ctx.dayHeading(from));
    else for (let k = 1; k <= 60 && !sec; k++) { from = addDays(today, -k); sec = sectionLines(text, ctx.dayHeading(from)); }
    if (!sec) return fail(p.kv.from ? `There is no “${ctx.dayHeading(from)}” section in ${path}.` : `No earlier day in ${path} in the last 60 days.`);
    if (from === today) return fail('That is today. Use from: with an earlier day.');
    const open = sectionItems(sec).filter(x => x.box === ' ' && !/→ carried$/.test(x.text));
    if (!open.length) return fail(`Nothing left open on ${ctx.dayHeading(from)}.`);
    const changes = Object.fromEntries(open.map(x => [x.i, x.line.replace(/\s*$/, '') + ' → carried']));
    return plan(`Carry ${plural(open.length, 'todo')} from ${ctx.fmt(from, 'ddd MMM D')} to today`, [
      write('edit_note', { path, ...sectionEdit(sec, changes) }, `Mark ${plural(open.length, 'todo')} carried`),
      ...todaySteps(ctx, open.map(x => `- [ ] ${itemText(x.text)}`), today, false)]);
  } });
def({ name: 'day', group: 'Today', sig: '/day <date>', help: "Open Today.md at a day's heading.", examples: ['/day yesterday'],
  async build(p, ctx) {
    const date = takeDate(p.words, ctx.today(), { prefer: 'past' }).date;
    if (!date) return fail('Which day? e.g. /day yesterday');
    return plan(`Open ${ctx.dayHeading(date)}`, [act('Open', () => { ctx.ui.openNote(`${ctx.captureFile()}#${ctx.dayHeading(date)}`); return { text: 'Opened' }; })]);
  } });
def({ name: 'file-today', group: 'Today', sig: '/file-today [date]', help: "File the day's captures: #project notes into the project note, todos with a project or date onto the Board, replies into Follow-ups. Untagged lines get suggestions; nothing is filed by guess.",
  examples: ['/file-today', '/file-today yesterday'],
  async build(p, ctx) {
    const date = p.words.length ? takeDate(p.words, ctx.today(), { prefer: 'past' }).date : ctx.today();
    const d = await todayDoc(ctx, date || ctx.today());
    if (!d.sec) return fail(`There is no “${d.heading}” section in ${d.path}.`);
    const rows = d.items.filter(x => !/→ (\[\[|Board|Follow-ups|carried)/.test(x.text));
    if (!rows.length) return fail(`Everything under “${d.heading}” is filed already.`);
    return plan(`File ${plural(rows.length, 'line')} from ${d.heading}`, [act('File', () => ctx.ui.fileToday(d, rows.map(x => classify(x, ctx))), { write: true, reviews: true })]);
  } });
/** Where a captured line goes, without an LLM. */
export function classify(x, ctx) {
  const text = itemText(x.text), tags = [...text.matchAll(/(?:^|\s)#([\w\-/]+)/g)].map(m => m[1]);
  const proj = tags.map(t => resolve(t, ctx.projects(), { labels: projectLabels(ctx), min: 0.9 }).item).find(Boolean) || null;
  const due = (text.match(/📅\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  const reply = text.match(/^Reply(?: to ([^:]+))?:\s*(.+)$/);
  const clean = text.replace(/(^|\s)#[\w\-/]+/g, '').replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/, '').replace(/\s*\[\[[^\]]+\]\]\s*$/, '').trim();
  if (reply) return { x, kind: 'followup', proj, due, from: (reply[1] || '').trim(), subject: reply[2].replace(/\s*\[\[[^\]]+\]\]\s*$/, '').replace(/\s*📅.*$/, '').trim(), text: clean };
  if (x.box != null && (proj || due)) return { x, kind: 'card', proj, due, text: clean, done: x.box === 'x' };
  if (proj) return { x, kind: 'note', proj, text: clean };
  return { x, kind: 'ask', proj: null, text: clean };
}

/* Notes */
def({ name: 'find', aliases: ['f', 'search'], group: 'Notes', sig: '/find <words> [in:folder]', help: 'Search notes (and documents, when on) by keywords and by meaning.', output: 'notes',
  examples: ['/find bearing replacement', '/find drainage memo in:Projects', '/find "load rating" | append today'], intents: [[/^(find|search( for)?|look for|where('s| is))\s+(my )?(notes? (on|about) )?(.+)$/i, m => `/find ${m[7]}`]],
  async build(p, ctx) {
    const q = textOf(p.words);
    if (!q) return fail('Find what? e.g. /find bearing replacement');
    return plan(`Search for “${q}”${p.kv.in ? ' in ' + p.kv.in : ''}`, [act('Search', async () => {
      const j = await ctx.read('search_notes', { query: q, folder: p.kv.in, limit: Number(p.kv.limit) || 10, vector: ctx.embedQuery ? await ctx.embedQuery(q) : undefined });
      if (j.error) throw new Error(j.error);
      const rows = j.data || [];
      return { type: 'notes', items: rows, main: rows[0] && rows[0].path,
        card: { title: rows.length ? `${plural(rows.length, 'result')} for “${q}”` : `Nothing matched “${q}”`, md: rows.map((r, k) => `${k + 1}. ${link(r.path)}${r.heading ? ' › ' + md(r.heading) : ''}  \n   ${md(r.text.slice(0, 160))}`).join('\n') } };
    })]);
  } });
def({ name: 'grep', aliases: ['g'], group: 'Notes', sig: '/grep <text> [in:folder] [re] [case] [docs]', help: 'Exact text across the vault, line by line. Add re for a regular expression.', output: 'lines',
  examples: ['/grep TBD in:Projects/Bridge', '/grep "deck joint"', '/grep "\\d+ kips" re'],
  async build(p, ctx) {
    const { flags, words } = takeFlags(p.words, ['re', 'case', 'docs']);
    const pat = textOf(words);
    if (!pat) return fail('Grep for what? e.g. /grep TBD');
    return plan(`Find lines with “${pat}”${p.kv.in ? ' in ' + p.kv.in : ''}`, [act('Grep', async () => {
      const j = await ctx.read('grep', { pattern: pat, folder: p.kv.in, regex: flags.has('re'), case: flags.has('case'), documents: flags.has('docs') });
      if (j.error) throw new Error(j.error);
      const rows = j.data || [];
      const byFile = new Map();
      rows.forEach(r => (byFile.get(r.path) || byFile.set(r.path, []).get(r.path)).push(r));
      return { type: 'lines', items: rows.map(r => `${r.text} (${link(r.path)})`), notes: [...byFile.keys()].map(path => ({ path })), main: rows[0] && rows[0].path,
        card: { title: j.result.split('\n')[0], md: [...byFile].map(([path, rs]) => `**${link(path)}**\n${rs.map(r => `- ${r.line}: ${md(r.text)}`).join('\n')}`).join('\n\n') } };
    })]);
  } });
def({ name: 'open', aliases: ['o'], group: 'Notes', sig: '/open <note or file>', help: 'Open a note or document by (part of) its name.', accepts: ['notes'],
  examples: ['/open load check', '/open [[County meeting]]', '/open today'], intents: [[/^open\s+(.+)$/i, m => `/open ${m[1]}`]],
  async build(p, ctx, input) {
    if (input) { const first = (input.items || [])[0]; return first ? plan(`Open ${first.path}`, [act('Open', () => { ctx.ui.openNote(first.path); return { text: 'Opened', main: first.path }; })]) : fail('Nothing to open.'); }
    const r = await findNote(ctx, p, p.rest, { files: true });
    if (r.error) return r;
    return plan(`Open ${r.item.path}`, [act('Open', () => { r.today ? ctx.ui.openDaily() : ctx.ui.openNote(r.item.path); return { text: 'Opened ' + r.item.path, main: r.item.path }; })]);
  } });
const readTool = (name, args, title) => act(name, async ctx => {
  const j = await ctx.read(name, args);
  if (j.error) throw new Error(j.error);
  return { type: 'notes', items: j.data || [], card: { title, pre: j.result } };
});
def({ name: 'ls', group: 'Notes', sig: '/ls [folder]', help: 'List the folders and notes in a folder.', examples: ['/ls', '/ls Projects/Bridge'],
  build: (p) => { const f = p.rest.replace(/^"|"$/g, ''); return plan(`List ${f || 'the vault root'}`, [readTool('list_folder', { path: f }, f || 'Vault root')]); } });
def({ name: 'map', group: 'Notes', sig: '/map [folder] [depth:2]', help: 'How the vault is organised: folders with counts, examples and descriptions.', examples: ['/map', '/map Projects depth:2'],
  build: (p) => { const f = textOf(p.words); return plan(`Map ${f || 'the vault'}`, [readTool('vault_map', { folder: f, depth: Number(p.kv.depth) || 3 }, `Map of ${f || 'the vault'}`)]); } });
def({ name: 'where', group: 'Notes', sig: '/where <file>', help: 'Suggest which folder a file belongs in (similar content and same-name files).', examples: ['/where "Inbox/girder_v3.inp"'],
  async build(p, ctx) {
    const r = await findNote(ctx, p, p.rest, { files: true });
    if (r.error) return r;
    return plan(`Suggest a folder for ${r.item.path}`, [readTool('suggest_folder', { path: r.item.path }, `Where ${base(r.item.path)} could go`)]);
  } });
def({ name: 'recent', group: 'Notes', sig: '/recent [3d]', help: 'Notes changed recently, newest first.', output: 'notes', examples: ['/recent', '/recent 14d', '/recent 3d | append today'],
  intents: [[/^(what )?(notes )?(did i )?(change|edit|work on)(ed)?( this week| recently| today)?\??$/i, () => '/recent']],
  build(p, ctx) {
    const m = textOf(p.words).match(/^(\d+)\s*d?$/), days = m ? Number(m[1]) : Number(p.kv.days) || 7;
    return plan(`Notes changed in the last ${plural(days, 'day')}`, [act('Recent', async () => {
      const j = await ctx.read('recent_notes', { days, limit: 40 });
      if (j.error) throw new Error(j.error);
      const rows = j.data || [];
      return { type: 'notes', items: rows, main: rows[0] && rows[0].path,
        card: { title: rows.length ? `${plural(rows.length, 'note')} changed in the last ${plural(days, 'day')}` : `No notes changed in the last ${plural(days, 'day')}`, md: rows.map(r => `- ${link(r.path)} · ${ctx.fmtTime(r.mtime)}`).join('\n') } };
    })]);
  } });
def({ name: 'templates', group: 'Notes', sig: '/templates', help: 'List your note templates.', examples: ['/templates'],
  build: (p, ctx) => plan('List templates', [act('Templates', async () => {
    const t = await ctx.templates();
    return { type: 'notes', items: t, card: { title: plural(t.length, 'template'), md: t.map(x => `- ${md(x.name)} · /new "Title" tpl:${quote(x.name)}`).join('\n') || '_No templates folder yet._' } };
  })]) });
async function newNote(p, ctx, { title, tplName, folder, project }) {
  let content = '';
  if (tplName) {
    const tpls = await ctx.templates(), r = pick(p, tplName, tpls, { labels: t => [t.name, t.path], kind: 'template' });
    if (r.error) return r;
    content = ctx.applyTemplate((await ctx.readNote(r.item.path)) || '', title);
  } else content = `# ${title}\n\n`;
  if (project) content = content.replace(/\s*$/, '\n') + `\nProject: ${ctx.projectNote(project) ? link(ctx.projectNote(project)) : ctx.projectLabel(project)}\n`;
  const path = `${folder ? folder.replace(/\/+$/, '') + '/' : ''}${title.replace(/[\\/:*?"<>|#^[\]]/g, '-')}.md`;
  return plan(`Create ${path}${tplName ? ` from ${tplName}` : ''}`, [write('create_note', { path, content }, `Create ${path}`)], { main: path });
}
def({ name: 'new', group: 'Notes', sig: '/new <title> [tpl:template] [in:folder] [#project]', help: 'Create a note, from a template if you name one.',
  examples: ['/new "Pad design memo" tpl:Memo in:Projects/Bridge', '/new Ideas for Q1'],
  async build(p, ctx) {
    const title = nameOf(p.words);
    if (!title) return fail('What is the title? e.g. /new "Pad design memo"');
    let project = null;
    if (p.tags.length) { const r = findProject(ctx, p, p.tags[0]); if (r.error) return r; project = r.item; }
    const folder = p.kv.in != null ? p.kv.in : project && ctx.projectNote(project) ? ctx.projectNote(project).split('/').slice(0, -1).join('/') : (ctx.openNote() ? ctx.openNote().path.split('/').slice(0, -1).join('/') : '');
    return newNote(p, ctx, { title, tplName: p.kv.tpl, folder, project });
  } });
def({ name: 'meeting', group: 'Notes', sig: '/meeting [title] [#project] [in:folder]', help: "Create today's meeting note from your meeting template, next to the project's note.",
  examples: ['/meeting #bridge', '/meeting "County coordination" #bridge'], intents: [[/^(new |create (a )?)?meeting note( for (.+))?$/i, m => `/meeting${m[4] ? ' #' + m[4].replace(/\s+/g, '') : ''}`]],
  async build(p, ctx) {
    let project = null;
    if (p.tags.length) { const r = findProject(ctx, p, p.tags[0]); if (r.error) return r; project = r.item; }
    const tpl = (await ctx.templates()).find(t => /meeting/i.test(t.name));
    const title = nameOf(p.words) || `${ctx.today()} ${project ? ctx.projectLabel(project) + ' ' : ''}meeting`.trim();
    const pn = project && ctx.projectNote(project), folder = p.kv.in != null ? p.kv.in : pn ? pn.split('/').slice(0, -1).join('/') : (await ctx.notes()).some(n => n.path.startsWith('Meetings/')) ? 'Meetings' : '';
    return newNote(p, ctx, { title, tplName: tpl && tpl.name, folder, project });
  } });
def({ name: 'append', aliases: ['a'], group: 'Notes', sig: '/append <note> :: <text>', help: 'Add text at the end of a note (or under today in Today.md).', accepts: ACCEPTS_LIST,
  examples: ['/append "Bridge open questions" :: - Who owns the drainage?', '/append today :: Site visit went well', '/find bearing | append "Bearing research"'],
  async build(p, ctx, input) {
    const target = textOf(p.words), lines = input ? inputLines(input).map(l => `- ${l}`) : p.tail ? [p.tail] : [];
    if (!target) return fail('Append to which note? e.g. /append today :: text');
    if (!lines.length) return fail('Append what? Put the text after ::, e.g. /append today :: Site visit went well');
    const r = await findNote(ctx, p, target);
    if (r.error) return r;
    if (r.today) return plan(`Add ${plural(lines.length, 'line')} under ${ctx.dayHeading(ctx.today())}`, todaySteps(ctx, lines, ctx.today(), false), { main: ctx.captureFile() });
    const under = p.kv.under;
    return plan(`Append ${plural(lines.length, 'line')} to ${r.item.path}${under ? ` under “${under}”` : ''}`, [write('append_to_note', { path: r.item.path, text: lines.join('\n'), under_heading: under || undefined }, `Append to ${r.item.path}`)], { main: r.item.path });
  } });
def({ name: 'replace', group: 'Notes', sig: '/replace <note> :: <old text> => <new text>', help: 'Replace an exact passage in a note (it must appear once).',
  examples: ['/replace "Load check" :: w = 18 kN/m => w = 20 kN/m'],
  async build(p, ctx) {
    const parts = p.tail ? splitOn(p.tail, '=>') : [];
    if (parts.length !== 2 || !parts[0].trim()) return fail('Use /replace <note> :: old text => new text');
    const r = await findNote(ctx, p, p.rest);
    if (r.error) return r;
    return plan(`Replace “${parts[0].trim()}” in ${r.item.path}`, [write('edit_note', { path: r.item.path, old_text: parts[0].trim(), new_text: parts[1].trim() }, `Edit ${r.item.path}`)], { main: r.item.path });
  } });
def({ name: 'move', aliases: ['mv'], group: 'Notes', sig: '/move <file> to <folder>', help: 'Move a note or file to a folder (never overwrites).', accepts: ['notes'],
  examples: ['/move "Inbox/girder_v3.inp" to Projects/Bridge/FE', '/grep "#bridge" in:Inbox | move Projects/Bridge'],
  async build(p, ctx, input) {
    const parts = input ? ['', p.rest] : splitOn(p.rest, ' to ');
    if (parts.length < 2 || !parts[parts.length - 1].trim()) return fail('Use /move <file> to <folder>');
    const folder = parts.pop().trim().replace(/^"|"$/g, '').replace(/\/+$/, '');
    let paths;
    if (input) paths = [...new Set((input.notes || input.items || []).map(x => x.path).filter(Boolean))];
    else { const r = await findNote(ctx, p, parts.join(' to '), { files: true }); if (r.error) return r; paths = [r.item.path]; }
    if (!paths.length) return fail('Nothing to move.');
    return plan(`Move ${paths.length === 1 ? paths[0] : plural(paths.length, 'file')} to ${folder || 'the vault root'}/`, [write('move_files', { moves: paths.map(f => ({ from: f, to: (folder ? folder + '/' : '') })) }, 'Move')], { main: folder });
  } });
def({ name: 'rename', group: 'Notes', sig: '/rename <note> to <new name>', help: 'Rename a note in its folder (links to it are listed, not changed).', examples: ['/rename "Load check" to "Load check – girders"'],
  async build(p, ctx) {
    const parts = splitOn(p.rest, ' to ');
    if (parts.length < 2) return fail('Use /rename <note> to <new name>');
    const name = parts.pop().trim().replace(/^"|"$/g, '').replace(/\.md$/i, '');
    const r = await findNote(ctx, p, parts.join(' to '));
    if (r.error) return r;
    const dir = r.item.path.split('/').slice(0, -1).join('/'), to = `${dir ? dir + '/' : ''}${name}.md`;
    return plan(`Rename ${r.item.path} to ${to}`, [write('move_note', { from_path: r.item.path, to_path: to }, 'Rename')], { main: to });
  } });
def({ name: 'inbox', group: 'Notes', sig: '/inbox', help: 'File the inbox folder: suggestions from similar files, reviewed in one table.', examples: ['/inbox'],
  intents: [[/^(file|sort|clean up) (my |the )?inbox/i, () => '/inbox']], build: (p, ctx) => plan('Review the inbox', [act('Inbox', () => { ctx.ui.openInbox(); return { text: 'Opened the inbox review' }; })]) });
def({ name: 'backlinks', group: 'Notes', sig: '/backlinks [note]', help: 'Notes that link to a note (default: the open note).', output: 'notes', examples: ['/backlinks', '/backlinks "Bridge rehab"'],
  async build(p, ctx) {
    const r = await findNote(ctx, p, p.rest || 'this');
    if (r.error) return r;
    return plan(`Notes linking to ${r.item.path}`, [act('Backlinks', async () => {
      const j = await ctx.read('backlinks', { path: r.item.path });
      if (j.error) throw new Error(j.error);
      return { type: 'notes', items: j.data || [], card: { title: (j.data || []).length ? `${plural(j.data.length, 'note')} link to ${link(r.item.path)}` : `Nothing links to ${stem(r.item.path)}`, md: (j.data || []).map(x => `- ${link(x.path)}`).join('\n') } };
    })]);
  } });
def({ name: 'related', group: 'Notes', sig: '/related [note]', help: 'Notes similar in meaning to a note (default: the open note).', output: 'notes', examples: ['/related', '/related "County meeting"'],
  async build(p, ctx) {
    const r = await findNote(ctx, p, p.rest || 'this');
    if (r.error) return r;
    return plan(`Notes related to ${r.item.path}`, [act('Related', async () => {
      const text = ((await ctx.readNote(r.item.path)) || '').slice(0, 2000), q = stem(r.item.path) + '\n' + text;
      const j = await ctx.read('search_notes', { query: stem(r.item.path), limit: 9, vector: ctx.embedQuery ? await ctx.embedQuery(q) : undefined });
      if (j.error) throw new Error(j.error);
      const rows = (j.data || []).filter(x => x.path !== r.item.path).slice(0, 8);
      return { type: 'notes', items: rows, card: { title: `Related to ${stem(r.item.path)}${ctx.embedQuery ? '' : ' (keywords only: the meaning index is off)'}`, md: rows.map(x => `- ${link(x.path)}${x.heading ? ' › ' + md(x.heading) : ''}`).join('\n') || '_Nothing similar found._' } };
    })]);
  } });
const ACTION_RE = /^\s*(?:[-*+]\s+\[ \]\s+(.+)|[-*+]?\s*(?:TODO|Action|AI|Follow[- ]up)\s*[:\-–]\s*(.+))$/i;
export const actionItems = text => { let fence = false; return text.split('\n').filter(l => (FENCE.test(l) ? (fence = !fence, false) : !fence)).map(l => l.match(ACTION_RE)).filter(Boolean).map(m => (m[1] || m[2]).trim()); };
def({ name: 'actions', group: 'Notes', sig: '/actions [note]', help: 'Pull the action items (open checkboxes, TODO:, Action:, AI:) out of a note.', output: 'lines',
  examples: ['/actions', '/actions "County meeting" | todo'], intents: [[/^(pull|get|list|extract)( out)? (the )?action items/i, () => '/actions']],
  async build(p, ctx) {
    const r = await findNote(ctx, p, p.rest || 'this');
    if (r.error) return r;
    return plan(`Action items in ${r.item.path}`, [act('Actions', async () => {
      const items = actionItems((await ctx.readNote(r.item.path)) || '');
      return { type: 'lines', items, card: { title: items.length ? `${plural(items.length, 'action item')} in ${stem(r.item.path)}` : `No action items in ${stem(r.item.path)}`, md: items.map(x => `- [ ] ${md(x)}`).join('\n'),
        actions: items.length ? [{ label: 'Add them to today', cmd: `/actions ${quote(r.item.path.replace(/\.md$/i, ''))} | todo` }] : [] } };
    })]);
  } });
function todoChanges(t, ch, ctx) {  // a vault checkbox line with the bulk changes applied
  let line = t.raw;
  const { flags } = takeFlags(ch.words, ['done', 'open', 'undone']);
  if (flags.has('done')) line = line.replace(/\[ \]/, '[x]');
  if (flags.has('open') || flags.has('undone')) line = line.replace(/\[[xX]\]/, '[ ]');
  if (ch.kv.due != null) {
    const d = ch.kv.due === '' || ch.kv.due === 'none' ? '' : parseDate(ch.kv.due, ctx.today());
    line = line.replace(/\s*(📅\s*\d{4}-\d{2}-\d{2}|due:\d{4}-\d{2}-\d{2})/, '');
    if (d) line = line.replace(/\s*$/, ` 📅 ${d}`);
  }
  return line;
}
def({ name: 'todos', group: 'Notes', sig: '/todos [overdue|today|week] [due:date] [#tag] [in:folder] [done|all] [-> due:fri | done]', help: 'Checkboxes across the vault. Add -> changes to edit them all (each is shown first).', output: 'todos',
  examples: ['/todos overdue', '/todos #bridge in:Projects', '/todos overdue -> due:fri', '/todos due:fri | append today'], intents: [[/^(what('s| is) )?(due|overdue)( this (week|month))? in (my )?(notes|vault)\??$/i, m => `/todos ${m[3] === 'overdue' ? 'overdue' : m[5] === 'month' ? 'due:+31d' : 'week'}`]],
  async build(p, ctx) {
    const { flags, words } = takeFlags(p.words, ['overdue', 'today', 'week', 'done', 'all']);
    const today = ctx.today(), args = { folder: p.kv.in || '', status: flags.has('done') ? 'done' : flags.has('all') ? 'all' : 'open', tag: p.tags[0] || p.kv.tag };
    if (flags.has('overdue')) args.due_before = addDays(today, -1);
    if (flags.has('today')) args.due_before = today;
    if (flags.has('week')) args.due_before = addDays(today, 7);
    if (p.kv.due) { const d = parseDate(p.kv.due, today); if (!d) return fail(`“due:${p.kv.due}” isn't a date I know.`); args.due_before = d; }
    const want = textOf(words);
    const load = async () => {
      const j = await ctx.read('tasks', args);
      if (j.error) throw new Error(j.error);
      return (j.data || []).filter(t => !want || norm(t.text).includes(norm(want)));
    };
    if (p.changes) {
      const rows = await load();
      if (!rows.length) return fail('No matching todos to change.');
      const edits = rows.map(t => ({ t, line: todoChanges(t, p.changes, ctx) })).filter(e => e.line !== e.t.raw);
      if (!edits.length) return fail('Those changes leave every todo as it is.');
      return plan(`Change ${plural(edits.length, 'todo')}`, edits.map(e => write('edit_note', { path: e.t.path, old_text: e.t.raw, new_text: e.line }, `${e.t.text} (${stem(e.t.path)})`)), { bulk: true });
    }
    return plan('List todos', [act('Todos', async () => {
      const rows = await load();
      return { type: 'todos', items: rows, card: { title: rows.length ? plural(rows.length, 'todo') : 'No matching todos', md: rows.slice(0, 200).map(t => `- [${t.done ? 'x' : ' '}] ${md(t.text)} · ${link(t.path)}`).join('\n') } };
    })]);
  } });

/* Timesheet */
const CODES = ['RG', 'LA', 'LS', 'LH'];
/** One "2h #bridge yesterday code:LA ts" group of /log → { hours, project, code, ts, dates[] } or { error }. */
function logGroup(g, ctx, p) {
  const { flags, words: w1 } = takeFlags(g.words, ['ts', 'all']);
  let words = w1, hours = null;
  const hi = words.findIndex(w => !w.q && parseHours(w.v) != null);
  if (hi >= 0) { hours = parseHours(words[hi].v); words = words.filter((_, k) => k !== hi); }
  else { const bi = words.findIndex(w => !w.q && /^\d+(\.\d+)?$/.test(w.v)); if (bi >= 0) { hours = Number(words[bi].v); words = words.filter((_, k) => k !== bi); } }
  const today = ctx.today(), opts = { prefer: 'past', periodStart: ctx.periodStart, periodLen: ctx.periodLen };
  const rr = takeRange(words, today, opts);
  words = rr.words;
  let dates = [];
  if (rr.range) dates = datesIn(rr.range).filter(d => flags.has('all') || (ctx.dayInfo(d).scheduled > 0 && !ctx.dayInfo(d).holiday));
  else { const dd = takeDate(words, today, { prefer: 'past' }); if (dd.date) { dates = [dd.date]; words = dd.words; } }
  const code = (g.kv.code || 'RG').toUpperCase();
  if (!CODES.includes(code)) return { error: `code:${g.kv.code} – use RG, LA, LS or LH.` };
  let project = null;
  const name = g.tags[0] || g.kv.project || (words.length ? textOf(words) : '');
  if (name) {
    const r = findProject(ctx, p, name);
    if (r.error) return r;
    project = r.item;
    if (!g.tags[0]) words = [];
  }
  if (words.length && textOf(words)) return { error: `I don't know what “${textOf(words)}” means here.` };
  if (hours == null) return { error: 'How many hours? e.g. /log 2h #bridge' };
  if (code === 'RG' && !project) return { error: 'Which project? e.g. /log 2h #bridge' };
  return { hours, project, code, ts: flags.has('ts'), dates, ranged: !!rr.range };
}
def({ name: 'log', aliases: ['l'], group: 'Timesheet', sig: '/log <hours> #project [date | range] [code:LA] [ts]  ·  /log day [60% #a 40% #b | usual]',
  help: 'Add hours to the timesheet. Several at once with commas; a range logs each scheduled day; "day" fills what is left of the day.',
  examples: ['/log 2h #bridge', '/log 1.5h #cr12 yesterday', '/log 2h #bridge, 1.5h #cr12, 0.5h #admin yesterday', '/log 8h #bridge mon..fri', '/log 8h code:LA fri', '/log day #bridge', '/log day 60% #bridge 40% #cr12', '/log day usual'],
  intents: [[/^(?:log|put|add|charge|book)\s+(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)\s+(?:to|on|for)?\s*(?:the\s+)?(.+?)(?:\s+(today|yesterday|mon\w*|tue\w*|wed\w*|thu\w*|fri\w*))?$/i, m => `/log ${m[1]}h #${quote(m[2])}${m[3] ? ' ' + m[3] : ''}`],
    [/^(?:i )?worked\s+(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)?\s+on\s+(.+?)(?:\s+(today|yesterday))?$/i, m => `/log ${m[1]}h #${quote(m[2])}${m[3] ? ' ' + m[3] : ''}`]],
  async build(p, ctx) {
    const today = ctx.today(), entries = [];
    if (p.words[0] && /^day$/i.test(p.words[0].v)) {
      const rest = p.words.slice(1), dd = takeDate(rest, today, { prefer: 'past' }), date = dd.date || today, info = ctx.dayInfo(date);
      const left = Math.round((info.scheduled - info.logged) * 100) / 100;
      const pcts = dd.words.map(w => parsePercent(w.v)).filter(x => x != null), usual = dd.words.some(w => /^usual$/i.test(w.v)) || (!p.tags.length && !pcts.length);
      if (usual) {
        if (info.logged > 0) return fail(`${ctx.fmt(date, 'ddd MMM D')} already has ${info.logged} h. Name the project for the rest, e.g. /log day #bridge`);
        const u = ctx.usualFor(date);
        if (!u.length) return fail(`Your usual pay period has no hours on ${ctx.fmt(date, 'ddd')}. Save one on the Timesheet, or name a project.`);
        u.forEach(e => entries.push({ ...e, date, mode: 'add' }));
      } else {
        if (left <= 0) return fail(`${ctx.fmt(date, 'ddd MMM D')} is already full (${info.logged} of ${info.scheduled} h).`);
        const projs = [];
        for (const t of p.tags) { const r = findProject(ctx, p, t); if (r.error) return r; projs.push(r.item); }
        const shares = pcts.length === projs.length && projs.length > 1 ? pcts : projs.map(() => 100 / projs.length);
        ctx.quarterSplit(shares.map(s => s * left / 100), left).forEach((h, k) => h && entries.push({ date, project: ctx.projectLabel(projs[k]), code: 'RG', hours: h, mode: 'add' }));
      }
    } else {
      const groups = splitOn(p.rest, ',').map(s => parseArgs(s)).map(g => logGroup(g, ctx, p));
      const bad = groups.find(g => g.error);
      if (bad) return bad.choices ? bad : fail(bad.error);
      const last = groups[groups.length - 1], shared = last.dates.length && groups.slice(0, -1).every(g => !g.dates.length) ? last.dates : null;
      for (const g of groups) {
        const dates = g.dates.length ? g.dates : shared || [today];
        if (!dates.length && g.ranged) return fail('That range has no scheduled working days (add all to include days off).');
        for (const date of dates) entries.push({ date, ...(g.project ? { project: ctx.projectLabel(g.project) } : {}), code: g.code, ts: g.ts || undefined, hours: g.hours, mode: 'add' });
      }
    }
    if (!entries.length) return fail('Nothing to log.');
    const dry = ctx.planHours(entries);
    if (dry.error) return fail(dry.error);
    return plan(dry.lines.join('\n'), [write('update_timesheet', { entries }, `Log ${entries.length} entr${entries.length > 1 ? 'ies' : 'y'}`)]);
  } });
def({ name: 'hours', group: 'Timesheet', sig: '/hours [date | week | period | last period]', help: 'Hours logged by project for a day, week or pay period.',
  examples: ['/hours', '/hours yesterday', '/hours week', '/hours last period'], intents: [[/^how many hours (did i|have i) (log|logged|work|worked)(.*)\??$/i, m => `/hours${/week/.test(m[3]) ? ' week' : /period/.test(m[3]) ? ' period' : ''}`]],
  build(p, ctx) {
    const today = ctx.today(), t = textOf(p.words).toLowerCase(), opts = { prefer: 'past', periodStart: ctx.periodStart, periodLen: ctx.periodLen };
    let range = t ? parseRange(/^(this|last|next) /.test(t) ? t : t === 'week' ? 'this week' : t === 'period' ? 'this period' : t, today, opts) : null;
    if (!range && t) { const d = parseDate(t, today, { prefer: 'past' }); if (!d) return fail(`“${t}” isn't a date or range I know.`); range = { from: d, to: d }; }
    if (!range) range = parseRange('this period', today, opts);
    return plan(`Hours ${range.from === range.to ? 'on ' + range.from : `${range.from} to ${range.to}`}`, [act('Hours', () => ({ text: '', card: R.hours(ctx, range.from, range.to) }))]);
  } });
def({ name: 'left', group: 'Timesheet', sig: '/left', help: 'Hours still to log today and this pay period.', examples: ['/left'],
  intents: [[/^how many hours (do i )?(still )?(need|left|to go)/i, () => '/left']],
  build: (p, ctx) => plan('Hours left', [act('Left', () => ({ card: R.left(ctx) }))]) });

/* Board */
const STATUS_WORDS = ['todo', 'doing', 'blocked', 'done'];
function cardChanges(ch, p, ctx, { tags = [], flags = new Set() } = {}) {
  const out = {};
  const st = ch.kv.status || [...flags].find(f => STATUS_WORDS.includes(f));
  if (st) { if (!STATUS_WORDS.includes(st)) return fail(`status:${st} – use ${STATUS_WORDS.join(', ')}.`); out.status = st; }
  if (ch.kv.due != null) { const d = /^(|none|-)$/.test(ch.kv.due) ? '' : parseDate(ch.kv.due, ctx.today()); if (d === '' && !/^(|none|-)$/.test(ch.kv.due)) return fail(`“due:${ch.kv.due}” isn't a date I know.`); out.due = d; }
  if (ch.kv.title) out.title = ch.kv.title;
  if (ch.kv.notes != null) out.notes = ch.kv.notes;
  const tag = tags[0] || ch.kv.project;
  if (tag) { const r = findProject(ctx, p, tag); if (r.error) return r; out.project = ctx.projectLabel(r.item); }
  return out;
}
const cardRow = (c, ctx) => `**${md(c.title)}**${c.projectId ? ' · ' + md(ctx.projectName(c.projectId)) : ''} · ${ctx.stageLabel(c.status)}${c.due ? ` · due ${c.due}` : ''}`;
def({ name: 'card', aliases: ['c'], group: 'Board', sig: '/card <title> [#project] [due:fri] [status:doing]  ·  /card <existing> done | due:+3d | title:"…" | remove',
  help: 'Add a Board card, or change one that already exists (named by its title).', accepts: ACCEPTS_LIST,
  examples: ['/card Pad design memo #bridge due:fri', '/card pad design done', '/card pad design due:+3d', '/card old duplicate remove', '/actions this | card #bridge'],
  intents: [[/^(add|create|new) (a )?(board )?card( for)?\s+(.+)$/i, m => `/card ${m[5]}`], [/^mark (.+?) (as )?(done|blocked|doing)$/i, m => `/card ${quote(m[1])} ${m[3]}`]],
  async build(p, ctx, input) {
    const { flags, words } = takeFlags(p.words, [...STATUS_WORDS, 'remove']);
    if (input) {
      const titles = inputLines(input), ch = cardChanges(p, p, ctx, { tags: p.tags, flags });
      if (ch.error) return ch;
      if (!titles.length) return fail('Nothing to add.');
      return plan(`Add ${plural(titles.length, 'card')} to the Board`, titles.map(t => write('add_deliverable', { title: t.replace(/^- (\[ \] )?/, ''), ...ch }, t)), { bulk: titles.length > 1 });
    }
    const title = textOf(words);
    if (!title) return fail('Which card? e.g. /card Pad design memo #bridge due:fri');
    const hit = resolve(title, ctx.cards(), { labels: c => [c.title], min: 0.9 });
    const changing = flags.size || ['status', 'due', 'title', 'notes', 'project'].some(k => p.kv[k] != null);
    if (hit.choices && changing) return fail(`“${title}” matches ${plural(hit.choices.length, 'card')}. Which one?`, hit.choices.map(c => ({ label: cardRow(c, ctx), cmd: swap(p.raw, title, quote(c.title)) })));
    const c = hit.item;
    if (c && flags.has('remove')) return plan(`Remove “${c.title}” from the Board`, [write('remove_deliverable', { id: c.id }, 'Remove card')]);
    if (c && changing) {
      const ch = cardChanges(p, p, ctx, { tags: p.tags, flags });
      if (ch.error) return ch;
      return plan(`Change “${c.title}”: ${Object.entries(ch).map(([k, v]) => `${k} ${v || '(none)'}`).join(', ')}`, [write('update_deliverable', { id: c.id, ...ch }, 'Update card')]);
    }
    if (c && !p.tags.length && !p.kv.due) return plan(`Show “${c.title}”`, [act('Card', () => ({ type: 'cards', items: [c], card: { title: c.title, md: cardRow(c, ctx) + (c.notes ? `\n\n${md(c.notes)}` : ''), actions: [{ label: 'Done', cmd: `/card ${quote(c.title)} done` }, { label: 'Due +7d', cmd: `/card ${quote(c.title)} due:+7d` }] } }))]);
    if (flags.has('remove')) return fail(`No card is called “${title}”.`);
    const ch = cardChanges(p, p, ctx, { tags: p.tags, flags });
    if (ch.error) return ch;
    return plan(`Add “${title}” to the Board${ch.project ? ' · ' + ch.project : ''}${ch.due ? ' · due ' + ch.due : ''}${ch.status ? ' · ' + ch.status : ''}`, [write('add_deliverable', { title, ...ch }, 'Add card')]);
  } });
function selectCards(p, ctx) {
  const { flags, words } = takeFlags(p.words, ['overdue', 'today', 'week', 'all', ...STATUS_WORDS]);
  const today = ctx.today(), want = textOf(words);
  let proj = null;
  if (p.tags[0]) { const r = findProject(ctx, p, p.tags[0]); if (r.error) return r; proj = r.item; }
  const st = p.kv.status || [...flags].find(f => STATUS_WORDS.includes(f));
  const due = p.kv.due ? parseDate(p.kv.due, today) : '';
  if (p.kv.due && !due) return fail(`“due:${p.kv.due}” isn't a date I know.`);
  return { rows: ctx.cards().filter(c => (st ? c.status === st : flags.has('all') || c.status !== 'done')
    && (!proj || c.projectId === proj.id)
    && (!flags.has('overdue') || (c.due && c.due < today))
    && (!flags.has('today') || (c.due && c.due <= today))
    && (!flags.has('week') || (c.due && c.due <= addDays(today, 7)))
    && (!due || (c.due && c.due <= due))
    && (!want || norm(c.title).includes(norm(want)))).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')) };
}
def({ name: 'cards', group: 'Board', sig: '/cards [overdue|today|week|all|doing…] [#project] [due:date] [-> changes]', help: 'List Board cards, or change them all with -> (e.g. -> due:+7d, -> done).', output: 'cards',
  examples: ['/cards overdue', '/cards week #bridge', '/cards overdue -> due:+7d', '/cards #bridge doing -> done'],
  intents: [[/^what('s| is) (overdue|due)( this week| today)?\??$/i, m => `/cards ${m[2] === 'overdue' ? 'overdue' : /today/.test(m[3] || '') ? 'today' : 'week'}`], [/^(show|list) (my )?(board|cards)/i, () => '/cards']],
  async build(p, ctx) {
    const sel = selectCards(p, ctx);
    if (sel.error) return sel;
    if (p.changes) {
      const { flags } = takeFlags(p.changes.words, [...STATUS_WORDS]);
      const ch = cardChanges(p.changes, p, ctx, { tags: p.changes.tags, flags });
      if (ch.error) return ch;
      if (!Object.keys(ch).length) return fail('Which changes? e.g. -> due:+7d or -> done');
      if (!sel.rows.length) return fail('No cards match.');
      return plan(`Change ${plural(sel.rows.length, 'card')}: ${Object.entries(ch).map(([k, v]) => `${k} ${v || '(none)'}`).join(', ')}`, sel.rows.map(c => write('update_deliverable', { id: c.id, ...ch }, c.title)), { bulk: true });
    }
    return plan('List cards', [act('Cards', () => ({ type: 'cards', items: sel.rows, card: { title: sel.rows.length ? plural(sel.rows.length, 'card') : 'No cards match', md: sel.rows.map(c => `- ${cardRow(c, ctx)}`).join('\n') } }))]);
  } });

/* Follow-ups */
const FU_STATUS = ['open', 'waiting', 'done'];
def({ name: 'fu', group: 'Follow-ups', sig: '/fu <from> – <subject> [due:+2d] [#project]  ·  /fu <existing> done | waiting | due:mon',
  help: 'Add an email you must answer, or change one (named by its subject).', examples: ['/fu Maria – Bearing pad submittal due:+2d #bridge', '/fu bearing pad done', '/fu bearing pad waiting'],
  intents: [[/^(i need to )?(reply|respond) to (\w+)( about| re:?)? (.+)$/i, m => `/fu ${m[3]} – ${m[5]}`]],
  build(p, ctx) {
    const { flags, words } = takeFlags(p.words, FU_STATUS);
    const text = textOf(words), today = ctx.today();
    const changing = flags.size || p.kv.due != null || p.kv.notes != null;
    const hit = text ? resolve(text, ctx.followups().filter(f => f.status !== 'done' || flags.has('open')), { labels: f => [f.subject, `${f.from} ${f.subject}`], min: 0.9 }) : {};
    if (hit.choices && changing) return fail(`“${text}” matches ${plural(hit.choices.length, 'follow-up')}. Which one?`, hit.choices.map(f => ({ label: `${f.subject} (${f.from})`, cmd: swap(p.raw, text, quote(f.subject)) })));
    const due = p.kv.due != null ? (/^(|none|-)$/.test(p.kv.due) ? '' : parseDate(p.kv.due, today)) : undefined;
    if (p.kv.due && due === '' && !/^(none|-)$/.test(p.kv.due)) return fail(`“due:${p.kv.due}” isn't a date I know.`);
    let project;
    if (p.tags[0]) { const r = findProject(ctx, p, p.tags[0]); if (r.error) return r; project = ctx.projectLabel(r.item); }
    if (hit.item && changing) {
      const ch = { ...(flags.size ? { status: [...flags][0] } : {}), ...(due !== undefined ? { due } : {}), ...(p.kv.notes != null ? { notes: p.kv.notes } : {}), ...(project ? { project } : {}) };
      return plan(`Change “${hit.item.subject}”: ${Object.entries(ch).map(([k, v]) => `${k} ${v || '(none)'}`).join(', ')}`, [write('update_followup', { id: hit.item.id, ...ch }, 'Update follow-up')]);
    }
    const sp = text.match(/^(.+?)\s+[–—-]\s+(.+)$/) || text.match(/^([^:]{1,60}):\s+(.+)$/);
    if (!sp) return fail('Use /fu <from> – <subject>, e.g. /fu Maria – Bearing pad submittal due:+2d');
    return plan(`Follow-up: reply to ${sp[1].trim()} about “${sp[2].trim()}”${due ? ' by ' + due : ''}`, [write('add_followup', { from: sp[1].trim(), subject: sp[2].trim(), due: due || addDays(today, 2), project }, 'Add follow-up')]);
  } });
def({ name: 'fus', group: 'Follow-ups', sig: '/fus [open|waiting|all|overdue|today] [#project] [-> done | waiting | due:x]', help: 'List follow-ups, or change them all with ->.', output: 'fus',
  examples: ['/fus', '/fus overdue', '/fus today -> due:tomorrow'], intents: [[/^(which|what) (replies|emails|follow-?ups) (are )?(overdue|due)/i, m => `/fus ${m[4] === 'overdue' ? 'overdue' : 'today'}`]],
  build(p, ctx) {
    const { flags } = takeFlags(p.words, ['open', 'waiting', 'all', 'overdue', 'today', 'done']);
    const today = ctx.today();
    let proj = null;
    if (p.tags[0]) { const r = findProject(ctx, p, p.tags[0]); if (r.error) return r; proj = r.item; }
    const due = p.kv.due ? parseDate(p.kv.due, today) : '';
    const rows = ctx.followups().filter(f => (flags.has('all') ? true : flags.has('done') ? f.status === 'done' : flags.has('waiting') ? f.status === 'waiting' : flags.has('open') ? f.status === 'open' : f.status !== 'done')
      && (!proj || f.projectId === proj.id) && (!flags.has('overdue') || (f.due && f.due < today)) && (!flags.has('today') || (f.due && f.due <= today)) && (!due || (f.due && f.due <= due)))
      .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    if (p.changes) {
      const { flags: cf } = takeFlags(p.changes.words, FU_STATUS);
      const ch = { ...(cf.size ? { status: [...cf][0] } : {}) };
      if (p.changes.kv.due != null) { const d = parseDate(p.changes.kv.due, today); if (!d) return fail(`“due:${p.changes.kv.due}” isn't a date I know.`); ch.due = d; }
      if (!Object.keys(ch).length) return fail('Which changes? e.g. -> done or -> due:tomorrow');
      if (!rows.length) return fail('No follow-ups match.');
      return plan(`Change ${plural(rows.length, 'follow-up')}: ${Object.entries(ch).map(([k, v]) => `${k} ${v}`).join(', ')}`, rows.map(f => write('update_followup', { id: f.id, ...ch }, f.subject)), { bulk: true });
    }
    return plan('List follow-ups', [act('Follow-ups', () => ({ type: 'fus', items: rows, card: { title: rows.length ? plural(rows.length, 'follow-up') : 'No follow-ups match',
      md: rows.map(f => `- **${md(f.subject || '(no subject)')}**${f.from ? ' · ' + md(f.from) : ''}${f.due ? ` · reply by ${f.due}` : ''}${f.status === 'waiting' ? ' · waiting on them' : ''}`).join('\n') } }))]);
  } });
def({ name: 'reply', group: 'Follow-ups', sig: '/reply <follow-up>', help: 'Draft a reply: with an assistant model it writes the draft; without one you get a skeleton to fill in.',
  examples: ['/reply bearing pad'],
  build(p, ctx) {
    const text = textOf(p.words), list = ctx.followups().filter(f => f.status !== 'done');
    const r = text ? pick(p, text, list, { labels: f => [f.subject, `${f.from} ${f.subject}`], kind: 'follow-up' }) : list.length ? { item: list.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))[0] } : fail('No open follow-ups.');
    if (r.error) return r;
    const f = r.item;
    if (ctx.hasLLM()) return plan(`Draft a reply to ${f.from || 'them'} with the assistant`, [act('Ask', () => { ctx.ui.draftReply(f); return { text: 'Asked the assistant' }; })]);
    const first = (f.from || '').split(/[\s,<]/)[0];
    const about = (f.subject || '').replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, '').trim();
    const sk = `Hi ${first || 'there'},\n\nThanks for your email about ${about || 'this'}.\n\n[your answer]\n\nBest regards,\n`;
    return plan(`Reply skeleton for “${f.subject}”`, [act('Skeleton', () => ({ type: 'lines', items: [sk], card: { title: `Reply to ${f.from || 'them'}: ${f.subject}`, pre: sk, copy: sk } }))]);
  } });

/* Tracker */
def({ name: 'leave', group: 'Tracker', sig: '/leave', help: 'Leave balances now and projected at year end.', examples: ['/leave'], intents: [[/^how much (annual |sick )?leave/i, () => '/leave']],
  build: (p, ctx) => plan('Leave balances', [act('Leave', () => ({ card: R.leave(ctx) }))]) });
def({ name: 'budget', group: 'Tracker', sig: '/budget [#project]', help: 'Project hours against their budgets, with the burn rate.', examples: ['/budget', '/budget #bridge'],
  intents: [[/^which projects? (are|is) (close to|over|near) (their |its )?budget/i, () => '/budget']],
  build(p, ctx) {
    let proj = null;
    if (p.tags[0]) { const r = findProject(ctx, p, p.tags[0]); if (r.error) return r; proj = r.item; }
    return plan('Budgets', [act('Budget', () => ({ card: R.budget(ctx, proj) }))]);
  } });
def({ name: 'timer', group: 'Tracker', sig: '/timer [start #project [ts] | stop | discard]', help: 'Start, switch or stop the timer.', examples: ['/timer start #bridge', '/timer stop', '/timer'],
  build(p, ctx) {
    const { flags } = takeFlags(p.words, ['start', 'stop', 'discard', 'ts']);
    if (flags.has('stop') || flags.has('discard')) return plan('Stop the timer', [act('Timer', () => { ctx.ui.timerStop(!flags.has('discard')); return { text: 'Stopped' }; })]);
    if (flags.has('start') || p.tags.length) {
      if (!p.tags[0]) return fail('Which project? e.g. /timer start #bridge');
      const r = findProject(ctx, p, p.tags[0]);
      if (r.error) return r;
      return plan(`Start the timer on ${ctx.projectLabel(r.item)}`, [act('Timer', () => { ctx.ui.timerStart(r.item, flags.has('ts')); return { text: 'Started' }; })]);
    }
    return plan('Timer', [act('Timer', () => ({ card: { title: ctx.ui.timerStatus() } }))]);
  } });
def({ name: 'away', group: 'Tracker', sig: '/away <annual|sick|travel|other> <range> ["note"]', help: 'Plan time out of office (opens the dialog, filled in).', examples: ['/away annual dec 22..dec 31 "Holidays"', '/away travel nov 18 "Site visit"'],
  build(p, ctx) {
    const kinds = ['annual', 'sick', 'travel', 'other'], { flags, words } = takeFlags(p.words.filter(w => !w.q), kinds);
    const today = ctx.today(), rr = takeRange(words, today, { prefer: 'future' }), dd = rr.range ? null : takeDate(words, today, { prefer: 'future' });
    const from = rr.range ? rr.range.from : dd.date, to = rr.range ? rr.range.to : dd.date;
    if (!from) return fail('When? e.g. /away annual dec 22..dec 31');
    const note = p.words.filter(w => w.q).map(w => w.v).join(' ');
    return plan(`Out of office ${from}${to !== from ? ' to ' + to : ''}`, [act('Away', () => { ctx.ui.openAway({ kind: [...flags][0] || 'annual', start: from, end: to === from ? '' : to, note }); return { text: 'Opened' }; })]);
  } });
const uiCmd = (name, group, help, fn, extra = {}) => def({ name, group, sig: '/' + name, help, examples: ['/' + name], ...extra, build: (p, ctx) => plan(help, [act(name, () => { fn(ctx, p); return { text: help }; })]) });
uiCmd('period', 'Tracker', 'Check this pay period on the Timesheet', ctx => ctx.ui.openPeriod());
uiCmd('export', 'Tracker', 'Export the timesheet as CSV', ctx => ctx.ui.exportCsv(), { sig: '/export csv' });
uiCmd('costs', 'Plan', 'Import costs from the ERP', ctx => ctx.ui.importCosts(), { sig: '/costs import' });
uiCmd('share', 'Plan', 'Share the project brief (review, then HTML or PowerPoint)', ctx => ctx.ui.shareBrief());
uiCmd('brief', 'Plan', 'Open the project brief', ctx => ctx.ui.openBrief());
def({ name: 'theme', group: 'App', sig: '/theme light|dark', help: 'Switch between light and dark.', examples: ['/theme dark'],
  build: (p, ctx) => { const t = textOf(p.words).toLowerCase(); return ['light', 'dark'].includes(t) ? plan(`Switch to ${t}`, [act('Theme', () => { ctx.ui.theme(t); return { text: t }; })]) : fail('Use /theme light or /theme dark'); } });
def({ name: 'go', group: 'App', sig: '/go <tab>', help: 'Go to a tab: today, timesheet, projects, board, plan, followups, leave, reports, notes, settings.', examples: ['/go board'],
  build(p, ctx) {
    const tabs = ctx.tabs(), r = pick(p, textOf(p.words), tabs, { labels: t => [t[1], t[0]], kind: 'tab' });
    return r.error ? r : plan(`Go to ${r.item[1]}`, [act('Go', () => { ctx.ui.go(r.item[0]); return { text: r.item[1] }; })]);
  } });

/* Reports */
def({ name: 'briefme', group: 'Reports', sig: '/briefme', help: 'A short briefing: hours still needed, cards overdue and due soon, follow-ups, leave, warnings and the notes you changed.',
  examples: ['/briefme'], intents: [[/^(brief me|give me (a|my) (briefing|brief)|what('s| is) on (today|my plate))/i, () => '/briefme']],
  build: (p, ctx) => plan('Brief me on today', [act('Brief', async () => ({ card: await R.brief(ctx) }))]) });
def({ name: 'weekly', group: 'Reports', sig: '/weekly [last]', help: 'Write the weekly status note (hours by project, cards done and due, notes changed, the week in Today.md) from your template.',
  examples: ['/weekly', '/weekly last'], intents: [[/^(write|make|create) (my )?(the )?weekly (status )?(report|note)/i, () => '/weekly']],
  async build(p, ctx) {
    const today = ctx.today(), sun = addDays(today, -dayOfWeek(today) - (/last/i.test(textOf(p.words)) ? 7 : 0));
    const note = await R.weekly(ctx, sun, addDays(sun, 6));
    return plan(`Write ${note.path}`, [write('create_note', { path: note.path, content: note.content }, `Create ${note.path}`)], { main: note.path });
  } });

/* Plan */
const planArg = p => (p.kv.plan ? { plan: p.kv.plan } : {});
const planRead = (name, args, title) => act(name, async ctx => {
  const text = await ctx.planRead(name, args);
  if (/^Error:/.test(text)) throw new Error(text.replace(/^Error:\s*/, ''));
  return { card: { title, pre: text } };
});
/** Adds key:value to a command before its -> or :: part, for the "which one?" buttons. */
const withKv = (raw, kv) => { const m = raw.match(/\s(->|::)\s?/); return m ? `${raw.slice(0, m.index)} ${kv}${raw.slice(m.index)}` : `${raw} ${kv}`; };
/** Plan commands work on plan:name, else the open plan, else the only plan; with several and none open they ask. */
async function planOf(p, ctx) {
  if (p.kv.plan || (ctx.openPlanName && ctx.openPlanName())) return {};
  const list = await ctx.plans();
  if (!list.length) return fail('There are no plans yet. Make one on the Plan tab, or open an MS Project file there.');
  return list.length === 1 ? {} : fail('Which plan?', list.map(x => ({ label: x.name, cmd: withKv(p.raw, 'plan:' + quote(x.name)) })));
}
def({ name: 'plans', group: 'Plan', sig: '/plans', help: 'List your project plans.', examples: ['/plans'],
  build: (p, ctx) => plan('List plans', [act('Plans', async () => {
    const list = await ctx.plans();
    return { type: 'lines', items: list.map(x => x.name), card: { title: list.length ? plural(list.length, 'plan') : 'No plans yet', md: list.map(x => `- **${md(x.name)}** · ${plural(x.tasks || 0, 'task')}`).join('\n'), actions: list.slice(0, 6).map(x => ({ label: `Open ${x.name}`, cmd: `/plan ${quote(x.name)}` })) } };
  })]) });
def({ name: 'plan', group: 'Plan', sig: '/plan [name]', help: 'Open a plan on the Plan tab.', examples: ['/plan', '/plan girder'],
  async build(p, ctx) {
    const list = await ctx.plans(), want = textOf(p.words) || p.kv.plan;
    if (!want) return plan('Open the Plan tab', [act('Plan', () => { ctx.ui.go('plan'); return { text: 'Plan tab' }; })]);
    const r = pick(p, want, list, { labels: x => [x.name, x.id], kind: 'plan' });
    return r.error ? r : plan(`Open ${r.item.name}`, [act('Open', async () => { await ctx.ui.openPlan(r.item.id); return { text: r.item.name }; })]);
  } });
def({ name: 'tasks', group: 'Plan', sig: '/tasks [late|critical|milestones|incomplete|@person] [plan:name] [-> changes]', help: 'Tasks of a plan; change them all with -> (same changes as /task).',
  examples: ['/tasks late', '/tasks critical plan:girder', '/tasks @Maria', '/tasks late -> +2d'],
  async build(p, ctx) {
    const { flags } = takeFlags(p.words, ['late', 'critical', 'milestones', 'incomplete', 'all']);
    const filter = [...flags][0] || (p.people[0] ? p.people[0] : 'all');
    if (p.changes) {
      const ids = await ctx.planTaskIds({ ...planArg(p), filter });
      if (!ids.length) return fail('No tasks match.');
      const changes = [];
      for (const id of ids) { const c = await taskChange(p.changes, ctx, id, p); if (c.error) return c; changes.push(c); }
      return plan(`Change ${plural(ids.length, 'task')} (${ids.join(', ')})`, [write('update_tasks', { ...planArg(p), changes }, 'Update tasks')], { bulk: true });
    }
    return plan(`Tasks: ${filter}`, [planRead('get_plan', { ...planArg(p), filter }, `Tasks · ${filter}`)]);
  } });
def({ name: 'late', group: 'Plan', sig: '/late [plan:name]', help: 'Late tasks and missed deadlines.', examples: ['/late'], intents: [[/^(what|which tasks) (is|are) late/i, () => '/late']],
  build: (p) => plan('Late tasks', [planRead('get_plan', { ...planArg(p), filter: 'late' }, 'Late tasks')]) });
def({ name: 'critical', group: 'Plan', sig: '/critical [plan:name]', help: 'The critical path (what drives the finish date).', examples: ['/critical'],
  build: (p) => plan('Critical path', [planRead('get_plan', { ...planArg(p), filter: 'critical' }, 'Critical path')]) });
def({ name: 'next', group: 'Plan', sig: '/next [plan:name]', help: 'The milestones.', examples: ['/next'], build: (p) => plan('Milestones', [planRead('get_plan', { ...planArg(p), filter: 'milestones' }, 'Milestones')]) });
/** /task changes → an update_tasks change for task `id`. */
async function taskChange(ch, ctx, id, p) {
  const out = { task: String(id) }, today = ctx.today();
  const { flags, words } = takeFlags(ch.words, ['milestone']);
  for (const w of words) {
    const pc = parsePercent(w.v);
    if (pc != null) { out.percent = pc; continue; }
    const sh = w.v.match(/^([+-])(\d+)d$/);
    if (sh) { const start = await ctx.taskStart(p.kv.plan, id); if (!start) return fail(`Task ${id} has no start date to move.`); out.start = addDays(start, (sh[1] === '-' ? -1 : 1) * Number(sh[2])); continue; }
    if (isDuration(w.v)) { out.duration = w.v; continue; }
    if (!w.q && String(id) === w.v) continue;
    return fail(`I don't know what “${w.v}” means for a task (try 50%, +2d, 3d, finish:fri, @Maria).`);
  }
  if (flags.has('milestone')) out.duration = '0';
  for (const k of ['start', 'finish', 'deadline']) if (ch.kv[k] != null) {
    const d = /^(|none|-)$/.test(ch.kv[k]) ? '' : parseDate(ch.kv[k], today);
    if (d === '' && !/^(|none|-)$/.test(ch.kv[k])) return fail(`“${k}:${ch.kv[k]}” isn't a date I know.`);
    out[k] = d;
  }
  if (ch.kv.duration || ch.kv.dur) out.duration = ch.kv.duration || ch.kv.dur;
  if (ch.kv.hours) { const hrs = parseHours(ch.kv.hours, { bare: true }); if (hrs == null) return fail(`hours:${ch.kv.hours} isn't a number of hours.`); out.hours = hrs; }
  if (ch.kv.budget != null) { const b = ch.kv.budget === '' || ch.kv.budget === 'none' ? '' : parseMoney(ch.kv.budget) ?? (Number.isFinite(Number(ch.kv.budget)) ? Number(ch.kv.budget) : null); if (b == null) return fail(`budget:${ch.kv.budget} isn't an amount.`); out.budget = b; }
  if (ch.kv.after || ch.kv.pred) out.predecessors = ch.kv.after || ch.kv.pred;
  if (ch.kv.name) out.name = ch.kv.name;
  if (ch.kv.notes != null) out.notes = ch.kv.notes;
  if (ch.people.length) out.people = ch.people.join(', ');
  return Object.keys(out).length > 1 ? out : fail('Which change? e.g. 50%, +2d, finish:fri, @Maria, after:7SS+2d');
}
def({ name: 'task', group: 'Plan', sig: '/task <ID> [50%] [+2d] [3d] [finish:fri] [deadline:12/20] [@Maria[50%]] [after:7SS+2d] [hours:40] [budget:$4k] [plan:name]',
  help: 'Change a task by its ID (row number). +2d moves it 2 days later; 3d sets the duration.', examples: ['/task 12 50%', '/task 12 +2d', '/task 12 finish:fri', '/task 12 @Maria[50%]', '/task 12 after:7SS+2d'],
  intents: [[/^(set |mark )?task (\d+) (to )?(\d{1,3})%( done| complete)?$/i, m => `/task ${m[2]} ${m[4]}%`]],
  async build(p, ctx) {
    const idw = p.words.find(w => /^\d+$/.test(w.v));
    if (!idw) return fail('Which task? Give its ID, e.g. /task 12 50%');
    const c = await taskChange({ ...p, words: p.words.filter(w => w !== idw) }, ctx, Number(idw.v), p);
    if (c.error) return c;
    return plan(`Task ${idw.v}: ${Object.entries(c).filter(([k]) => k !== 'task').map(([k, v]) => `${k} ${v === '' ? '(none)' : v}`).join(', ')}`, [write('update_tasks', { ...planArg(p), changes: [c] }, `Update task ${idw.v}`)]);
  } });
def({ name: 'whatif', group: 'Plan', sig: '/whatif <ID> <changes like /task>', help: 'What would move if a task changed. Nothing is saved.', examples: ['/whatif 12 +5d', '/whatif 12 finish:2026-12-01'],
  async build(p, ctx) {
    const idw = p.words.find(w => /^\d+$/.test(w.v));
    if (!idw) return fail('Which task? e.g. /whatif 12 +5d');
    const c = await taskChange({ ...p, words: p.words.filter(w => w !== idw) }, ctx, Number(idw.v), p);
    if (c.error) return c;
    return plan(`What if task ${idw.v} changed`, [planRead('simulate', { ...planArg(p), changes: [c] }, `What if task ${idw.v} changed`)]);
  } });
def({ name: 'addtask', group: 'Plan', sig: '/addtask "<name>" [3d] [after:ID] [under:ID] [@people] [deadline:date] [plan:name]', help: 'Add a task (after: also makes it follow that task).',
  examples: ['/addtask "Pad design" 3d after:7 under:4', '/addtask "Agency review" 2w after:12 @Maria'],
  build(p, ctx) {
    const dur = p.words.find(w => !w.q && isDuration(w.v)), name = textOf(p.words.filter(w => w !== dur));
    if (!name) return fail('What is the task called? e.g. /addtask "Pad design" 3d');
    const t = { name, duration: dur ? dur.v : '1d' };
    if (p.kv.after) { t.after = p.kv.after; t.depends_on = [p.kv.after]; }
    if (p.kv.under) t.parent = p.kv.under;
    if (p.people.length) t.people = p.people.join(', ');
    if (p.kv.deadline) { const d = parseDate(p.kv.deadline, ctx.today()); if (!d) return fail(`deadline:${p.kv.deadline} isn't a date I know.`); t.deadline = d; }
    return plan(`Add task “${name}” (${t.duration})${t.after ? ' after ' + t.after : ''}`, [write('add_tasks', { ...planArg(p), tasks: [t] }, 'Add task')]);
  } });
def({ name: 'milestone', group: 'Plan', sig: '/milestone "<name>" <date> [after:ID] [plan:name]', help: 'Add a milestone on a date.', examples: ['/milestone "60% plans" 2026-12-12'],
  build(p, ctx) {
    const dd = takeDate(p.words, ctx.today(), { prefer: 'future' }), name = textOf(dd.words);
    if (!name) return fail('What is the milestone called? e.g. /milestone "60% plans" dec 12');
    const t = { name, duration: '0', ...(p.kv.after ? { after: p.kv.after, depends_on: [p.kv.after] } : {}), ...(p.kv.under ? { parent: p.kv.under } : {}) };
    const steps = [write('add_tasks', { ...planArg(p), tasks: [t] }, 'Add milestone')];
    if (dd.date) steps.push(write('update_tasks', { ...planArg(p), changes: [{ task: name, start: dd.date }] }, `Pin it to ${dd.date}`));
    return plan(`Add milestone “${name}”${dd.date ? ' on ' + dd.date : ''}`, steps);
  } });
for (const kind of ['risk', 'issue', 'action', 'decision']) def({ name: kind, group: 'Plan', sig: `/${kind} <title> [@owner] [due:date]${kind === 'risk' ? ' [p:1-5] [i:1-5]' : ''} [plan:name]`,
  help: `Log ${kind === 'issue' ? 'an' : 'a'} ${kind} in the plan's Issues & risks.`, examples: [`/${kind} ${{ risk: 'Pad delivery slips p:3 i:4 @Sam', issue: 'County comments late @Maria due:fri', action: 'Send revised calcs @Sam due:fri', decision: 'Use elastomeric pads' }[kind]}`],
  build(p, ctx) {
    const title = textOf(p.words);
    if (!title) return fail(`What is the ${kind}? e.g. ${this.examples[0]}`);
    const a = { ...planArg(p), kind, title, ...(p.people[0] ? { owner: p.people[0] } : {}) };
    if (p.kv.due) { const d = parseDate(p.kv.due, ctx.today()); if (!d) return fail(`due:${p.kv.due} isn't a date I know.`); a.due = d; }
    if (p.kv.p) a.probability = Number(p.kv.p);
    if (p.kv.i) a.impact = Number(p.kv.i);
    return plan(`Log ${kind}: “${title}”`, [write('add_raid_item', a, `Log ${kind}`)]);
  } });
def({ name: 'cost', group: 'Plan', sig: '/cost [plan:name]', help: 'Budget, cost to date, earned value and forecast.', examples: ['/cost'], build: p => plan('Costs', [planRead('cost_summary', planArg(p), 'Costs')]) });
def({ name: 'free', group: 'Plan', sig: '/free <range> [hours:n]', help: 'Who has free time between two dates, across every plan.', examples: ['/free nov 17..nov 28', '/free next week hours:20'],
  build(p, ctx) {
    const rr = takeRange(p.words, ctx.today(), { prefer: 'future' });
    if (!rr.range) return fail('Between which dates? e.g. /free nov 17..nov 28');
    return plan(`Who is free ${rr.range.from} to ${rr.range.to}`, [planRead('who_is_free', { from: rr.range.from, to: rr.range.to, ...(p.kv.hours ? { hours: Number(p.kv.hours) } : {}) }, `Free ${rr.range.from} to ${rr.range.to}`)]);
  } });
def({ name: 'portfolio', group: 'Plan', sig: '/portfolio', help: 'One line per plan: status, finish, progress, cost.', examples: ['/portfolio'], build: () => plan('Portfolio', [planRead('portfolio_summary', {}, 'Portfolio')]) });
def({ name: 'status', group: 'Plan', sig: '/status [plan:name]', help: "This week's status draft: suggested red/amber/green with the reasons.", examples: ['/status'], build: p => plan('Status draft', [planRead('status_draft', planArg(p), 'Status draft')]) });
def({ name: 'close-week', group: 'Plan', sig: '/close-week <green|amber|red> [schedule:amber] [cost:green] [scope:green] [reason:"…"] [plan:name]', help: "Save this week's status snapshot.",
  examples: ['/close-week amber reason:"FE model two days late"', '/close-week green'],
  build(p) {
    const { flags } = takeFlags(p.words, ['green', 'amber', 'red']);
    const overall = [...flags][0];
    if (!overall) return fail('Which colour? /close-week green | amber | red');
    const a = { ...planArg(p), overall };
    for (const k of ['schedule', 'cost', 'scope']) if (p.kv[k]) { if (!['green', 'amber', 'red'].includes(p.kv[k])) return fail(`${k}:${p.kv[k]} – use green, amber or red.`); a[k] = p.kv[k]; }
    if (p.kv.reason) a.reasons = { overall: p.kv.reason };
    return plan(`Close the week: ${overall}`, [write('close_week', a, 'Close the week')]);
  } });
const LOG_KINDS = ['update', 'win', 'problem', 'decision', 'contact', 'site', 'lesson'];
def({ name: 'update', group: 'Plan', sig: '/update [win|problem|decision|contact|site|lesson] <text> [internal] [plan:name]', help: "Add an entry to the plan's weekly log (internal keeps it from the sponsor).",
  examples: ['/update win County approved the 30% plans', '/update problem Pad supplier is late internal'],
  build(p) {
    const { flags, words } = takeFlags(p.words, ['internal']);
    const kind = words[0] && LOG_KINDS.includes(words[0].v.toLowerCase()) ? words[0].v.toLowerCase() : 'update', text = textOf(kind === 'update' && !(words[0] && words[0].v.toLowerCase() === 'update') ? words : words.slice(1));
    if (!text) return fail('What happened? e.g. /update win County approved the plans');
    return plan(`Log ${kind}: “${text}”${flags.has('internal') ? ' (internal)' : ''}`, [write('add_log_entry', { ...planArg(p), kind, text, internal: flags.has('internal') }, `Log ${kind}`)]);
  } });

for (const c of C.filter(c => ['tasks', 'late', 'critical', 'next', 'task', 'whatif', 'addtask', 'milestone', 'risk', 'issue', 'action', 'decision', 'cost', 'status', 'close-week', 'update'].includes(c.name))) {
  const inner = c.build;
  c.build = async function (p, ctx, input) { const w = await planOf(p, ctx); return w.error ? w : inner.call(this, p, ctx, input); };
}

/* Meta */
def({ name: 'help', aliases: ['?'], group: 'Help', sig: '/help [command]', help: 'All commands, or one in detail.', examples: ['/help', '/help log'],
  build(p, ctx) {
    const want = textOf(p.words).replace(/^\//, '');
    if (want) {
      const c = find(want, ctx);
      if (!c) return fail(`There is no /${want}.`, resolve(want, all(ctx), { labels: x => [x.name, ...(x.aliases || [])] }).suggestions?.map(x => ({ label: '/help ' + x.name, cmd: '/help ' + x.name })));
      return plan(`Help for /${c.name}`, [act('Help', () => ({ card: { title: c.sig, md: `${md(c.help)}${c.aliases && c.aliases.length ? `\n\nAlso: ${c.aliases.map(a => '/' + a).join(', ')}` : ''}${c.accepts ? '\n\nTakes a list from a pipe: `… | ' + c.name + '`' : ''}`, actions: (c.examples || []).map(e => ({ label: e, fill: e })) } }))]);
    }
    return plan('Help', [act('Help', () => ({ card: { title: 'Commands', help: true, md: helpText(ctx) } }))]);
  } });
export function helpText(ctx) {
  const groups = new Map();
  all(ctx).forEach(c => (groups.get(c.group) || groups.set(c.group, []).get(c.group)).push(c));
  return [...groups].map(([g, cs]) => `**${g}**\n${cs.map(c => `- \`${c.sig.split('  ·  ')[0]}\` – ${md(c.help)}`).join('\n')}`).join('\n\n') +
    '\n\n**Several at once**\n- Chain with `;` or a new line: `/todo Call Sam ; /log 1h #bridge`\n- Pipe a list: `/find bearing | append today`, `/actions this | todo`\n- Change everything a list shows with `->`: `/cards overdue -> due:+7d`\n- `$` is what the previous command made: `/new "Memo" ; /append $ :: Started`\n- Routines run several commands: `/routines`';
}
def({ name: 'undo', group: 'Help', sig: '/undo', help: 'Undo the last change made in this chat.', examples: ['/undo'],
  build: (p, ctx) => plan('Undo the last change', [act('Undo', async () => ({ text: await ctx.undoLast() }))]) });
def({ name: 'ask', group: 'Help', sig: '/ask <question>', help: 'Send the text to the assistant model (needs a profile in Settings).', examples: ['/ask Why is the finish date slipping?'],
  build: (p, ctx) => (ctx.hasLLM() ? plan('Ask the assistant', [act('Ask', () => { ctx.ask(p.rest); return { text: 'Asked' }; })]) : fail('There is no assistant model. Add a profile in Settings → AI assistant.')) });
def({ name: 'why', group: 'Help', sig: '/why <plain text>', help: 'How plain text would be understood: the rule that matches, or the commands closest in meaning with their scores (for tuning).',
  examples: ['/why log two hours to the culvert'],
  build: (p, ctx) => {
    const text = p.raw.replace(/^\/\S+\s*/, '');
    if (!text) return fail('Give some plain text, e.g. /why how much leave do I have');
    return plan(`How “${text}” is understood`, [act('Why', async () => {
      const R = await import('./router.js'), rule = R.ruleMatch(text, ctx), ranked = ctx.embedQuery ? await R.meaningMatch(text, ctx) : [];
      const rows = ranked.slice(0, 6).map(x => `| /${x.name} | ${x.score.toFixed(3)} | ${x.score >= R.HIGH ? 'suggested' : x.score >= R.LOW ? 'offered' : x.score >= R.NEAR ? 'listed' : '—'} |`);
      return { card: { title: rule ? `A rule matches: ${rule}` : 'No rule matches', md: (ctx.embedQuery ? ['| Command | Score | |', '|---|--:|---|', ...rows].join('\n') : '_The meaning index is off, so only rules are used._') +
        `\n\nThresholds: suggest ≥ ${R.HIGH} (and ${R.LEAD} ahead of the next), offer ≥ ${R.LOW}. With an assistant model, text no rule matches goes to the model.`, actions: rule ? [{ label: 'Run ' + rule, cmd: rule }] : [] } };
    })]);
  } });
def({ name: 'routines', group: 'Routines', sig: '/routines', help: 'Your saved routines (edit them in Settings → Commands).', examples: ['/routines'],
  build: (p, ctx) => plan('Routines', [act('Routines', () => {
    const r = Object.entries(ctx.routines());
    return { card: { title: plural(r.length, 'routine'), md: r.map(([k, v]) => `**/${k}** – ${md(v.label || '')}\n${v.lines.map(l => `- \`${l}\``).join('\n')}`).join('\n\n'), actions: r.map(([k, v]) => ({ label: v.label || k, cmd: '/' + k })) } };
  })]) });
def({ name: 'run', group: 'Routines', sig: '/run <routine> [args]', help: 'Run a routine; {1}, {2}… in it are the arguments ({1|usual} has a default).', examples: ['/run eod #bridge'], routineRunner: true,
  build: () => fail('Name a routine, e.g. /run eod. /routines lists them.') });

/* ---------- lookup ---------- */
const ROUTINE_SIG = (k, v) => ({ name: k, group: 'Routines', sig: `/${k} [args]`, help: v.label || `Routine: ${v.lines.join(' ; ')}`, examples: ['/' + k], routine: v });
export function all(ctx) {
  const taken = new Set(C.flatMap(c => [c.name, ...(c.aliases || [])]));
  return [...C, ...Object.entries((ctx && ctx.routines && ctx.routines()) || {}).filter(([k]) => !taken.has(k)).map(([k, v]) => ROUTINE_SIG(k, v))];
}
export function find(name, ctx) {
  const n = String(name || '').toLowerCase();
  return all(ctx).find(c => c.name === n || (c.aliases || []).includes(n)) || null;
}
/** A routine's lines with {1}, {2|default} filled from the arguments. */
export function expandRoutine(r, args) {
  return r.lines.map(l => l.replace(/\{(\d+)(?:\|([^}]*))?\}/g, (_, n, d) => args[Number(n) - 1] ?? d ?? '').replace(/\s+$/, ''));
}
export const COMMANDS = C;
