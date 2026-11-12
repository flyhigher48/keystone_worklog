// Keystone slash commands – plain text (no leading /) → a command, without an LLM:
//   1. rules: each command's regular expressions rewrite the text into its slash form
//   2. meaning (only without an assistant model): the text is compared with example sentences per command using the
//      in-browser embedding model (all-MiniLM-L6-v2), and the closest commands are offered – never run
//   3. otherwise: the assistant model if there is one, else "here is what I can do".
// Only a rule match runs anything by itself, and only a look-up; writes always wait for a click. The slash form is
// always shown so it can be learned. /why <text> shows the ranking, for tuning the examples and thresholds below.
import { all } from './registry.js';
import { parseHours, takeDate, tokenize, splitOn } from './syntax.js';
import { resolve } from './resolve.js';

// Measured with all-MiniLM-L6-v2 on phrasings that are not in PHRASES: right answers scored 0.43–0.96, unrelated text
// 0.1–0.36, but questions only a model can answer can score high too ("explain why the finish date moved" → /critical 0.85),
// which is why this stage suggests and never runs, and is skipped when there is a model.
export const HIGH = 0.6, LOW = 0.45, LEAD = 0.05, NEAR = 0.35;

/** Example sentences per command for the meaning stage. */
export const PHRASES = {
  today: ["what's in today's note", 'show my notes from today', 'what did I capture yesterday', 'open my daily note', 'what have I written down today'],
  note: ['jot down that the county called', 'make a note that the crane arrives monday', 'write down that Sam is out next week', 'capture this thought'],
  todo: ['remind me to send the photos', 'I need to call the county tomorrow', 'add a todo to check the pads', 'put review the calcs on my list', 'I have to email Sam later', 'must remember to book the crane'],
  done: ['I finished sending the photos', 'tick off the county call', 'mark the photos todo as done', 'check off item 3'],
  carry: ['bring yesterday’s unfinished todos to today', 'carry over my open tasks', 'move what I didn’t finish to today'],
  find: ['find my notes on bearing replacement', 'search for the drainage memo', 'where did I write about deck joints', 'look up load rating', 'anything in my notes about corrosion', 'search everything for pile driving'],
  grep: ['find every line that says TBD', 'which notes mention exactly "deck joint"', 'search for the exact text RFI-12'],
  open: ['open the load check note', 'show me the county meeting notes', 'go to the bridge spec'],
  recent: ['what notes did I change this week', 'what have I been working on', 'show recently edited notes'],
  new: ['create a new note called pad design memo', 'start a note for the site visit', 'make a new note'],
  meeting: ['new meeting note for the bridge project', 'start a meeting note', 'take minutes for this meeting'],
  inbox: ['file my inbox', 'sort the files in the inbox folder', 'where do these new files go'],
  actions: ['pull the action items out of this note', 'what are the action items in this meeting note', 'list the todos in this note'],
  related: ['find notes related to this one', 'what else is similar to this note'],
  backlinks: ['which notes link to this one', 'what links here'],
  todos: ['what is due this month in my notes', 'show overdue checkboxes', 'list my open tasks in the vault'],
  log: ['log two hours to the bridge project', 'I worked 3 hours on CR 12 yesterday', 'put 8 hours on bridge for monday to friday', 'charge an hour to admin', 'book time to the girder project', 'spent the afternoon on the runway job', 'two hours went to the drainage design'],
  hours: ['how many hours did I log this week', 'show my timesheet for this pay period', 'what did I charge yesterday', 'what have I billed so far this period', 'hours by project for last week'],
  left: ['how many hours do I still need', 'how much time is left to log this pay period', 'am I short on hours', 'how far behind is my timesheet', 'hours still missing this period'],
  card: ['add a card for the pad design memo', 'put the drainage memo on the board', 'mark the pad design card done', 'push the memo card to next week'],
  cards: ["what's overdue", 'what is due this week', 'show the board for bridge', 'which deliverables are blocked'],
  fu: ['I need to reply to Maria about the submittal', 'remind me to answer the county email', 'mark the bearing pad email as answered'],
  fus: ['which emails do I need to answer', 'what replies are overdue', 'show my follow-ups'],
  reply: ['draft a reply to my oldest follow-up', 'help me answer the email from Maria'],
  leave: ['how much annual leave do I have', 'what is my sick leave balance', 'how much leave will I have at year end', 'how many vacation days are left', 'PTO balance'],
  budget: ['which projects are close to their budget', 'how many hours are left on bridge', 'is any project over budget', 'how is the budget holding up', 'burn rate of my projects'],
  timer: ['start the timer on bridge', 'stop the timer', 'switch the timer to CR 12', 'start timing the culvert work', 'clock in on the runway job'],
  away: ['I am on leave from dec 22 to dec 31', 'plan a site visit trip next week', 'book annual leave', 'I will be out of the office next friday', 'taking vacation over the holidays'],
  briefme: ['brief me on today', "what's on my plate today", 'give me my morning briefing', 'what do I need to know today'],
  weekly: ['write my weekly status report', 'make the weekly report', 'summarize my week'],
  plans: ['list my project plans', 'what plans do I have'],
  late: ['which tasks are late', 'what is behind schedule', 'show late tasks'],
  critical: ['what is on the critical path', 'what drives the finish date'],
  task: ['set task 12 to 50 percent', 'move task 7 two days later', 'task 12 finishes friday'],
  whatif: ['what if task 12 slips five days', 'what happens if the design takes a week longer'],
  addtask: ['add a task for pad design after task 7', 'insert a new task agency review'],
  milestone: ['add a milestone for 60% plans on december 12'],
  risk: ['log a risk that pad delivery slips', 'add a risk'],
  issue: ['log an issue: county comments are late', 'raise an issue'],
  cost: ['how much has the project cost so far', 'show the earned value and forecast'],
  free: ['who is free next week', 'who has time between nov 17 and nov 28'],
  portfolio: ['how are all my projects doing', 'show the portfolio'],
  status: ["draft this week's status", 'is the project red amber or green'],
  update: ['log a win: the county approved the plans', 'add a project update', 'record a problem with the supplier', 'the client signed off on the design', 'news for the project log'],
  help: ['what can you do', 'what commands are there', 'help', 'what can I type in this box', 'how do the slash commands work'],
};

/** Stage 1: the first command whose rules match. → '/log 2h #bridge yesterday' or null. */
export function ruleMatch(text, ctx) {
  const t = String(text || '').trim().replace(/[.!]+$/, '');
  for (const c of all(ctx)) for (const [rx, to] of c.intents || []) {
    const m = t.match(rx);
    if (m) return to(m);
  }
  return null;
}

/** Best-guess slots for a command picked by meaning, so the suggestion is as complete as possible. */
export function guessCommand(name, text, ctx) {
  const t = String(text || '').trim(), words = tokenize(t), today = ctx.today();
  const proj = () => {
    const tags = (t.match(/#[\w-]+/g) || []).map(x => x.slice(1));
    for (const w of [...tags, ...words.map(w => w.v)]) {
      const r = resolve(w, ctx.projects(), { labels: x => [ctx.projectLabel(x), x.name, x.network].filter(Boolean), min: 0.85 });
      if (r.item) return ' #' + (/\s/.test(ctx.projectLabel(r.item)) ? `"${ctx.projectLabel(r.item)}"` : ctx.projectLabel(r.item));
    }
    return '';
  };
  const date = (prefer = 'past') => { const d = takeDate(words, today, { prefer }).date; return d && d !== today ? ' ' + d : ''; };
  const rest = () => ' ' + t.replace(/^(please |can you |could you )?(remind me to|i need to|add a todo to|make a note that|jot down that|note that|write down that|add a card for|put|log|find|search for|look up|open)\s+/i, '');
  switch (name) {
    case 'log': { const h = words.map(w => parseHours(w.v) ?? (/^\d+(\.\d+)?$/.test(w.v) ? Number(w.v) : null)).find(x => x != null); return `/log ${h != null ? h + 'h' : '?h'}${proj()}${date()}`; }
    case 'todo': case 'note': case 'card': case 'find': case 'grep': case 'open': case 'new': return `/${name}${rest()}`;
    case 'cards': case 'fus': case 'todos': return `/${name}${/overdue/i.test(t) ? ' overdue' : /today/i.test(t) ? ' today' : /week/i.test(t) ? ' week' : ''}${proj()}`;
    case 'hours': return `/hours${/week/i.test(t) ? ' week' : /period/i.test(t) ? ' period' : date()}`;
    case 'timer': return /stop/i.test(t) ? '/timer stop' : `/timer start${proj()}`;
    case 'budget': case 'meeting': return `/${name}${proj()}`;
    default: return '/' + name;
  }
}

const VEC_KEY = 'nwa.cmd.vectors';
let vectors = null;
const cos = (a, b) => { let s = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return s / Math.sqrt(x * y || 1); };
/** The example sentences' vectors: computed once with the embedding model, cached in this browser. */
async function exampleVectors(ctx) {
  const items = Object.entries(PHRASES).flatMap(([name, list]) => list.map(text => ({ name, text })));
  const sig = ctx.embedModel() + ':' + items.length + ':' + items.map(x => x.text).join('|').length;
  if (vectors && vectors.sig === sig) return vectors.items;
  try { const c = JSON.parse(localStorage.getItem(VEC_KEY) || 'null'); if (c && c.sig === sig) { vectors = c; return c.items; } } catch {}
  const vecs = await ctx.embedMany(items.map(x => x.text));
  if (!vecs || vecs.length !== items.length) return null;
  vectors = { sig, items: items.map((x, k) => ({ ...x, v: Array.from(vecs[k], n => Math.round(n * 1e4) / 1e4) })) };
  try { localStorage.setItem(VEC_KEY, JSON.stringify(vectors)); } catch {}
  return vectors.items;
}
/** Stage 2: commands ranked by how close the text is to their example sentences. → [{ name, score }] */
export async function meaningMatch(text, ctx, embedOne = ctx.embedQuery) {
  if (!embedOne || !ctx.embedMany) return [];
  const ex = await exampleVectors(ctx), q = await embedOne(text);
  if (!ex || !q) return [];
  const best = new Map();
  for (const x of ex) { const s = cos(q, x.v); if (!best.has(x.name) || s > best.get(x.name)) best.set(x.name, s); }
  return [...best].map(([name, score]) => ({ name, score })).sort((a, b) => b.score - a.score);
}

/**
 * Plain text → what to do with it.
 * { kind: 'run', cmd } a confident read (runs straight away when allowed) · { kind: 'suggest', cmd } one suggestion ·
 * { kind: 'choices', cmds } a few · { kind: 'chain', cmds } several requests, each understood · { kind: 'none', near }
 */
export async function route(text, ctx, opts = {}) {  // opts.llm: there is a model to hand the rest to
  const parts = splitParts(text);
  if (parts.length > 1) {  // "log 2h to bridge and then add a todo to call Sam": only if every part is understood by the rules
    const cmds = parts.map(x => ruleMatch(x, ctx));
    if (cmds.every(Boolean)) return { kind: 'chain', cmds };
  }
  const rule = ruleMatch(text, ctx);
  if (rule) return { kind: isRead(rule, ctx) ? 'run' : 'suggest', cmd: rule, via: 'rule' };
  if (opts.llm) return { kind: 'none', near: [] };
  const ranked = await meaningMatch(text, ctx, opts.embedOne);
  if (!ranked.length) return { kind: 'none', near: [] };
  const [a, b] = ranked, top = ranked.slice(0, 3);
  if (a.score >= HIGH && (!b || a.score - b.score >= LEAD)) return { kind: 'suggest', cmd: guessCommand(a.name, text, ctx), via: 'meaning', score: a.score, ranked: top };
  if (a.score >= LOW) return { kind: 'choices', cmds: ranked.filter(x => x.score >= LOW).slice(0, 3).map(x => guessCommand(x.name, text, ctx)), ranked: top };
  return { kind: 'none', near: ranked.filter(x => x.score >= NEAR).slice(0, 3).map(x => guessCommand(x.name, text, ctx)), ranked: top };
}
const READS = new Set(['today', 'find', 'grep', 'recent', 'hours', 'left', 'cards', 'fus', 'todos', 'leave', 'budget', 'briefme', 'plans', 'late', 'critical', 'next', 'cost', 'free', 'portfolio', 'status', 'help', 'actions', 'related', 'backlinks', 'templates', 'routines', 'tasks', 'ls', 'map', 'why']);
export const isRead = cmd => READS.has(String(cmd).replace(/^\//, '').split(/\s/)[0].toLowerCase()) && !/->/.test(cmd) && !/\|/.test(cmd);
/** "do X and then Y", "X; Y", one per line. */
export function splitParts(text) {
  return splitOn(String(text || ''), ';').flatMap(s => s.split('\n')).flatMap(s => s.split(/\s*,?\s+and then\s+|\s*,\s*then\s+/i)).map(s => s.trim()).filter(Boolean);
}
