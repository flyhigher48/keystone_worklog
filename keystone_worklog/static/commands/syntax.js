// Keystone slash commands – the syntax: splitting a line into commands, tokens, and slots (dates, ranges, hours, money…).
// Pure functions with no page globals, so they run in Node's test runner as they are. Dates are 'YYYY-MM-DD' strings.

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = n => String(n).padStart(2, '0');
export const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const dateOf = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = dateOf(s); d.setDate(d.getDate() + n); return isoOf(d); };
export const dayOfWeek = s => dateOf(s).getDay();
const validIso = (y, m, d) => { const x = new Date(y, m - 1, d); return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d ? isoOf(x) : ''; };

/** Keys understood as key:value anywhere in a command. Anything else with a colon stays a plain word (times, URLs…). */
export const KEYS = new Set(['due', 'status', 'code', 'in', 'tpl', 'title', 'finish', 'start', 'deadline', 'after', 'under', 'from', 'to', 'plan', 'type',
  'budget', 'kind', 'owner', 'schedule', 'cost', 'scope', 'overall', 'reason', 'name', 'notes', 'duration', 'dur', 'hours', 'depth', 'days', 'limit', 'on',
  'project', 'p', 'i', 'note', 'tag', 'pred']);

/**
 * A date word or phrase → 'YYYY-MM-DD', or '' if it isn't one.
 * prefer 'past' (the last Monday: /log mon) or 'future' (the next Monday: due:mon). Weekdays and month-days follow it.
 */
export function parseDate(v, today, { prefer = 'future' } = {}) {
  v = String(v || '').toLowerCase().trim().replace(/[.,;]+$/, '').replace(/\s+/g, ' ');
  if (!v) return '';
  if (v === 'today' || v === 'tod' || v === 'now') return today;
  if (v === 'yesterday' || v === 'yday' || v === 'yest') return addDays(today, -1);
  if (v === 'tomorrow' || v === 'tmrw' || v === 'tom' || v === 'tmr') return addDays(today, 1);
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return validIso(+m[1], +m[2], +m[3]);
  m = v.match(/^([+-])(\d{1,3})([dw])$/);
  if (m) return addDays(today, (m[1] === '-' ? -1 : 1) * Number(m[2]) * (m[3] === 'w' ? 7 : 1));
  m = v.match(/^(last|this|next)?\s?([a-z]{3,9})$/);
  if (m) {
    const wd = WEEKDAYS.findIndex(w => m[2].startsWith(w) && (m[2].length <= 3 || `${w}day,${w}nesday,${w}sday,${w}rsday,${w}urday`.includes(m[2])));
    if (wd >= 0 && m[2].length >= 3) {
      const cur = dayOfWeek(today), back = (cur - wd + 7) % 7, fwd = (wd - cur + 7) % 7;
      if (m[1] === 'last') return addDays(today, -(back || 7));
      if (m[1] === 'next') return addDays(today, fwd || 7);
      if (m[1] === 'this') return addDays(today, wd - cur);  // within this Sun–Sat week
      return prefer === 'past' ? addDays(today, -back) : addDays(today, fwd || 7);  // past includes today; future never does
    }
  }
  const year = Number(today.slice(0, 4));
  const pick = (mo, d, y) => {
    if (y) return validIso(y < 100 ? 2000 + y : y, mo, d);
    const s = validIso(year, mo, d);
    if (!s) return '';
    if (prefer === 'past' && s > addDays(today, 31)) return validIso(year - 1, mo, d);  // the nearest such date, within a month either way
    if (prefer === 'future' && s < addDays(today, -31)) return validIso(year + 1, mo, d);  // "due:jan 5" in December is next January
    return s;
  };
  m = v.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);  // month/day[/year]
  if (m) return pick(+m[1], +m[2], m[3] && +m[3]);
  const mon = s => MONTHS.findIndex(x => s.startsWith(x));
  m = v.match(/^([a-z]{3,9})[ -]?(\d{1,2})(?:,? (\d{4}))?$/);  // nov 3, nov-3, november 3 2026
  if (m && mon(m[1]) >= 0) return pick(mon(m[1]) + 1, +m[2], m[3] && +m[3]);
  m = v.match(/^(\d{1,2})[ -]?([a-z]{3,9})(?: (\d{4}))?$/);  // 3 nov
  if (m && mon(m[2]) >= 0) return pick(mon(m[2]) + 1, +m[1], m[3] && +m[3]);
  return '';
}

/**
 * A range → { from, to } or null: 'mon..fri', 'nov 17..nov 28', 'this week', 'last week', 'next week',
 * 'this period' / 'last period' (needs opts.periodStart(date) and opts.periodLen).
 */
export function parseRange(v, today, opts = {}) {
  v = String(v || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const prefer = opts.prefer || 'past';
  const wk = v.match(/^(this|last|next) week$/);
  if (wk) { const sun = addDays(today, -dayOfWeek(today)) ; const s = addDays(sun, { this: 0, last: -7, next: 7 }[wk[1]]); return { from: s, to: addDays(s, 6) }; }
  const per = v.match(/^(this|last|next) (?:pay )?period$/);
  if (per && opts.periodStart) {
    const len = opts.periodLen || 14, s = addDays(opts.periodStart(today), { this: 0, last: -len, next: len }[per[1]]);
    return { from: s, to: addDays(s, len - 1) };
  }
  const parts = v.split(/\s*\.\.\s*/);
  if (parts.length !== 2) return null;
  const from = parseDate(parts[0], today, { prefer });
  if (!from) return null;
  // a weekday at the end is the first one on or after the start: "fri..mon" is Friday to the following Monday
  const isWd = /^(last |this |next )?[a-z]{3,9}$/.test(parts[1]) && WEEKDAYS.some(w => parts[1].replace(/^(last|this|next) /, '').startsWith(w));
  const to = isWd ? parseDate(parts[1], addDays(from, -1), { prefer: 'future' }) : parseDate(parts[1], today, { prefer });
  return to && to >= from ? { from, to } : null;
}
export const datesIn = r => { const out = []; for (let d = r.from; d <= r.to && out.length < 400; d = addDays(d, 1)) out.push(d); return out; };

/** Hours: 2h, 1.5h, 2.25 (with bare), 90m, 2:30, 2h30, 2h30m → number, or null. */
export function parseHours(v, { bare = false } = {}) {
  v = String(v || '').toLowerCase().trim();
  let m = v.match(/^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)$/);
  if (m) return Number(m[1]);
  m = v.match(/^(\d+)\s*(?:m|min|mins|minutes)$/);
  if (m) return Math.round(Number(m[1]) / 60 * 100) / 100;
  m = v.match(/^(\d+)(?:h|:)(\d{1,2})m?$/);
  if (m && Number(m[2]) < 60) return Math.round((Number(m[1]) + Number(m[2]) / 60) * 100) / 100;
  if (bare && /^\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}
/** $4k, $4,000, 4000$, $1.2m → number, or null. */
export function parseMoney(v) {
  const m = String(v || '').toLowerCase().trim().match(/^\$?(\d[\d,]*(?:\.\d+)?)([km])?\$?$/);
  if (!m || !/\$|[km]$/.test(String(v).toLowerCase())) return null;
  return Number(m[1].replace(/,/g, '')) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1);
}
export function parsePercent(v) { const m = String(v || '').trim().match(/^(\d{1,3}(?:\.\d+)?)%$/); return m && Number(m[1]) <= 100 ? Number(m[1]) : null; }
export const isDuration = v => /^(\d+(\.\d+)?)(d|w|h|mo|m|ed|ew|eh)$|^0$/i.test(String(v || '').trim());

/* ---------- splitting a line ---------- */

/** Walks text outside "quotes" and [[links]]: calls at(i) for each character that may be a separator. */
function outside(text, at) {
  let q = false, link = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (!link && c === '"') { q = !q; continue; }
    if (q) continue;
    if (text.startsWith('[[', i)) { link++; i++; continue; }
    if (link && text.startsWith(']]', i)) { link--; i++; continue; }
    if (link) continue;
    const skip = at(i);
    if (skip) i += skip - 1;
  }
}

/** A line → separate commands, split on ';', new lines and ' then ' (outside quotes and links). */
export function splitChain(text) {
  const out = [];
  let from = 0;
  outside(text, i => {
    const c = text[i];
    if (c === ';' || c === '\n') { out.push(text.slice(from, i)); from = i + 1; return 1; }
    const m = /^\s+then\s+(?=\/)/i.exec(text.slice(i));
    if (m && /\s/.test(c)) { out.push(text.slice(from, i)); from = i + m[0].length; return m[0].length; }
    return 0;
  });
  out.push(text.slice(from));
  return out.map(s => s.trim()).filter(Boolean);
}

/** One command → its pipe stages, split on '|' (outside quotes and links). */
export function splitPipe(text) {
  const out = [];
  let from = 0;
  outside(text, i => { if (text[i] === '|') { out.push(text.slice(from, i)); from = i + 1; return 1; } return 0; });
  out.push(text.slice(from));
  return out.map(s => s.trim()).filter(Boolean);
}

/** Splits outside quotes and links on a separator string (e.g. '::', '->', '=>', ','); returns the parts. */
export function splitOn(text, sep) {
  const out = [];
  let from = 0;
  outside(text, i => { if (text.startsWith(sep, i)) { out.push(text.slice(from, i)); from = i + sep.length; return sep.length; } return 0; });
  out.push(text.slice(from));
  return out;
}

/** Words of a command: quoted strings and [[links]] stay whole; quotes are removed (q marks a quoted word). */
export function tokenize(text) {
  const out = [];
  let cur = '', quoted = false, inQ = false, link = 0;
  const push = () => { if (cur || quoted) out.push({ v: cur, q: quoted }); cur = ''; quoted = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) { cur += text[++i]; continue; }
    if (!link && c === '"') { if (!inQ && !cur) quoted = true; inQ = !inQ; continue; }  // quoted only when the quote starts the word: key:"a b" stays a key
    if (!inQ && text.startsWith('[[', i)) { link++; cur += '[['; i++; continue; }
    if (!inQ && link && text.startsWith(']]', i)) { link--; cur += ']]'; i++; continue; }
    if (!inQ && !link && /\s/.test(c)) { push(); continue; }
    cur += c;
  }
  push();
  return out;
}

/**
 * One command stage → { cmd, raw, rest, words[], kv{}, tags[], people[], flags Set, tail, changes }.
 * words: what's left after key:value, #tags and @people are taken out (each { v, q }).
 * tail: the text after '::'. changes: the text after '->' (bulk changes), parsed the same way.
 */
export function parseCommand(stage) {
  const raw = stage.trim();
  const m = raw.match(/^\/([a-z][\w-]*)(?:\s+|$)/i);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  let rest = raw.slice(m[0].length);
  let changes = null, tail = null;
  const arrow = splitOn(rest, '->');
  if (arrow.length > 1) { rest = arrow[0]; changes = parseArgs(arrow.slice(1).join('->')); }
  const colons = splitOn(rest, '::');
  if (colons.length > 1) { rest = colons[0]; tail = colons.slice(1).join('::').trim(); }
  return { cmd, raw, rest: rest.trim(), ...parseArgs(rest), tail, changes };
}

const DATE_KEYS = new Set(['due', 'from', 'to', 'on', 'start', 'finish', 'deadline']);
const NOW = () => isoOf(new Date());
export function parseArgs(text) {
  const words = [], kv = {}, tags = [], people = [], flags = new Set();
  const toks = tokenize(text);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.q) { words.push(t); continue; }
    const k = t.v.match(/^([a-z]+):(.*)$/i);
    if (k && KEYS.has(k[1].toLowerCase())) {
      let val = k[2];
      if (!val && toks[i + 1] && toks[i + 1].q) val = toks[++i].v;  // key: "quoted value"
      // date keys take a two-word date: due:nov 20, from:last fri
      if (DATE_KEYS.has(k[1].toLowerCase()) && toks[i + 1] && !toks[i + 1].q && !parseDate(val, NOW()) && parseDate(`${val} ${toks[i + 1].v}`, NOW())) val += ' ' + toks[++i].v;
      kv[k[1].toLowerCase()] = val;
      continue;
    }
    if (/^#[^#]/.test(t.v)) { tags.push(t.v.slice(1)); continue; }  // #bridge, #"Girder Bridge rehab"
    if (/^@./.test(t.v)) {
      let name = t.v.slice(1);
      if (!name && toks[i + 1] && toks[i + 1].q) name = toks[++i].v;  // @"Sam Lee"
      if (/^\[\d+%\]$/.test((toks[i + 1] || {}).v || '')) name += toks[++i].v;  // @"Sam Lee" [50%]
      people.push(name);
      continue;
    }
    words.push(t);
  }
  return { words, kv, tags, people, flags };
}

/**
 * Takes a date (one word or a two-word phrase like "last fri", "nov 3") off the end or anywhere in words.
 * Returns { date, words } with the date's words removed, or { date: '' } when there is none.
 */
export function takeDate(words, today, opts = {}) {
  for (let i = 0; i < words.length; i++) {
    if (words[i].q) continue;
    for (const n of [3, 2, 1]) {
      if (i + n > words.length || words.slice(i, i + n).some(w => w.q)) continue;
      const phrase = words.slice(i, i + n).map(w => w.v).join(' ');
      const date = parseDate(phrase, today, opts);
      if (date && (n > 1 || !/^\d+(\.\d+)?$/.test(phrase))) return { date, words: [...words.slice(0, i), ...words.slice(i + n)] };
    }
  }
  return { date: '', words };
}
/** Takes a range ("mon..fri", "this week", "nov 17 .. nov 28") out of words; { range, words } or { range: null }. */
export function takeRange(words, today, opts = {}) {
  const text = words.map(w => w.v);
  for (let i = 0; i < words.length; i++) {
    for (const n of [5, 4, 3, 2, 1]) {
      if (i + n > words.length || words.slice(i, i + n).some(w => w.q)) continue;
      const phrase = text.slice(i, i + n).join(' ');
      if (!/\.\.|week|period/.test(phrase)) continue;
      const range = parseRange(phrase, today, opts);
      if (range) return { range, words: [...words.slice(0, i), ...words.slice(i + n)] };
    }
  }
  return { range: null, words };
}
/** Pulls flag words (from a known list) out of words into a Set. */
export function takeFlags(words, known) {
  const flags = new Set(), keep = [];
  for (const w of words) (!w.q && known.includes(w.v.toLowerCase()) ? flags.add(w.v.toLowerCase()) : keep.push(w));
  return { flags, words: keep };
}
export const textOf = words => words.map(w => w.v).join(' ').trim();
