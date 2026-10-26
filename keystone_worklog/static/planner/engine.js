// Keystone Planner – scheduling engine. Pure functions, no DOM: plan in, schedule out.
//
// Times are "naive" local plan times (no time zone), like MS Project: stored as "YYYY-MM-DDTHH:MM" and
// handled here as whole minutes since 1970-01-01 00:00. Durations and lags are working minutes on the
// plan calendar (or elapsed minutes when marked elapsed), exactly as MS Project's XML stores them.
//
// schedule(plan) runs the critical path method: a forward pass (early dates) honouring links (FS/SS/FF/SF
// with working, elapsed or % lag), constraints and actual progress, then a backward pass (late dates)
// honouring links, constraints and deadlines; then total/free slack, the critical path and summary rollups.

export const DAY = 1440;
const MAX_SEARCH_DAYS = 366 * 20;

// ---------- time ----------
export function toMin(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(String(s));
  if (!m) return null;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) / 60000);
}
export function fromMin(t) {
  if (t == null) return null;
  const d = new Date(t * 60000), p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
export const dateOf = t => fromMin(t).slice(0, 10);
export const weekday = t => new Date(Math.floor(t / DAY) * DAY * 60000).getUTCDay();  // 0 = Sunday

// ---------- calendars ----------
// { week: [periods for Sun..Sat], exceptions: { "YYYY-MM-DD": periods } } – periods are [[startMin, endMin], …] within the day
export const STANDARD_DAY = [[8 * 60, 12 * 60], [13 * 60, 17 * 60]];
export function standardCalendar() {
  return { name: 'Standard', week: [[], STANDARD_DAY, STANDARD_DAY, STANDARD_DAY, STANDARD_DAY, STANDARD_DAY, []], exceptions: {} };
}
export function dayPeriods(cal, day) {  // day = whole days since epoch
  const key = fromMin(day * DAY).slice(0, 10);
  if (cal.exceptions && Object.prototype.hasOwnProperty.call(cal.exceptions, key)) return cal.exceptions[key] || [];
  return cal.week[new Date(day * DAY * 60000).getUTCDay()] || [];
}
function assertWorking(cal) {
  if (!cal.week.some(p => p && p.length) && !Object.values(cal.exceptions || {}).some(p => p && p.length))
    throw new Error('The calendar has no working time');
}
/** The first working moment at or after t. */
export function nextWorking(cal, t) {
  let day = Math.floor(t / DAY), m = t - day * DAY;
  for (let i = 0; i < MAX_SEARCH_DAYS; i++, day++, m = 0) {
    for (const [a, b] of dayPeriods(cal, day)) if (m < b) return day * DAY + Math.max(a, m);
  }
  throw new Error('No working time found in the calendar');
}
/** The last working moment at or before t (period ends count: a finish of 17:00 stays 17:00). */
export function prevWorking(cal, t) {
  let day = Math.floor(t / DAY), m = t - day * DAY;
  if (m === 0) { day -= 1; m = DAY; }
  for (let i = 0; i < MAX_SEARCH_DAYS; i++, day--, m = DAY) {
    const ps = dayPeriods(cal, day);
    for (let k = ps.length - 1; k >= 0; k--) { const [a, b] = ps[k]; if (m > a) return day * DAY + Math.min(b, m); }
  }
  throw new Error('No working time found in the calendar');
}
/** t plus `mins` working minutes. Ends exactly where the work ends (e.g. 17:00, never the next morning). */
export function addWorking(cal, t, mins) {
  if (mins < 0) return subWorking(cal, t, -mins);
  if (mins === 0) return t;
  let day = Math.floor(t / DAY), m = t - day * DAY, left = mins;
  for (let i = 0; i < MAX_SEARCH_DAYS * 2; i++, day++, m = 0) {
    for (const [a, b] of dayPeriods(cal, day)) {
      if (m >= b) continue;
      const s = Math.max(a, m), avail = b - s;
      if (avail >= left) return day * DAY + s + left;
      left -= avail;
    }
  }
  throw new Error('Duration runs past the end of the calendar');
}
/** t minus `mins` working minutes (lands on the start of work, e.g. 08:00). */
export function subWorking(cal, t, mins) {
  if (mins < 0) return addWorking(cal, t, -mins);
  if (mins === 0) return t;
  let day = Math.floor(t / DAY), m = t - day * DAY, left = mins;
  if (m === 0) { day -= 1; m = DAY; }
  for (let i = 0; i < MAX_SEARCH_DAYS * 2; i++, day--, m = DAY) {
    const ps = dayPeriods(cal, day);
    for (let k = ps.length - 1; k >= 0; k--) {
      const [a, b] = ps[k];
      if (m <= a) continue;
      const e = Math.min(b, m), avail = e - a;
      if (avail >= left) return day * DAY + e - left;
      left -= avail;
    }
  }
  throw new Error('Duration runs before the start of the calendar');
}
/** Working minutes from a to b (negative when b is before a). */
export function workBetween(cal, a, b) {
  if (a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('A date is missing or out of range');  // never loop forever
  if (b < a) return -workBetween(cal, b, a);
  let total = 0;
  for (let day = Math.floor(a / DAY), last = Math.floor(b / DAY); day <= last; day++) {
    const lo = day === Math.floor(a / DAY) ? a - day * DAY : 0, hi = day === last ? b - day * DAY : DAY;
    for (const [s, e] of dayPeriods(cal, day)) { const x = Math.max(s, lo), y = Math.min(e, hi); if (y > x) total += y - x; }
  }
  return total;
}
/** Working minutes in one calendar day. */
export const dayWork = (cal, day) => dayPeriods(cal, day).reduce((s, [a, b]) => s + b - a, 0);

// ---------- durations & lags ----------
// duration: { minutes, format: 'm'|'h'|'d'|'w'|'mo'|'em'|'eh'|'ed'|'ew'|'emo', estimated }
export const UNIT_MIN = units => ({ m: 1, h: 60, d: units.minutesPerDay, w: units.minutesPerWeek, mo: units.minutesPerDay * units.daysPerMonth });
const ELAPSED_MIN = { em: 1, eh: 60, ed: DAY, ew: 7 * DAY, emo: 30 * DAY };
export const DEFAULT_UNITS = { minutesPerDay: 480, minutesPerWeek: 2400, daysPerMonth: 20 };
const UNIT_WORDS = { m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm', h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd', w: 'w', wk: 'w', wks: 'w', week: 'w', weeks: 'w', mo: 'mo', mon: 'mo', month: 'mo', months: 'mo',
  em: 'em', eh: 'eh', ed: 'ed', ew: 'ew', emo: 'emo', edays: 'ed', eweeks: 'ew' };

/** "3d", "2 weeks", "4h", "1.5w", "3ed" (elapsed), "5d?" (estimated), "0" (milestone) → { minutes, format, estimated } */
export function parseDuration(text, units = DEFAULT_UNITS, fallback = 'd') {
  const s = String(text ?? '').trim().toLowerCase();
  const m = /^(-?\d+(?:\.\d+)?)\s*([a-z]*)\s*(\?)?$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]), word = m[2] || fallback, fmt = UNIT_WORDS[word];
  if (!fmt) return null;
  const per = ELAPSED_MIN[fmt] || UNIT_MIN(units)[fmt];
  return { minutes: Math.round(n * per), format: fmt, estimated: !!m[3] };
}
export function formatDuration(d, units = DEFAULT_UNITS) {
  if (!d) return '';
  const per = ELAPSED_MIN[d.format] || UNIT_MIN(units)[d.format] || units.minutesPerDay;
  const n = Math.round(d.minutes / per * 100) / 100;
  return `${n}${d.format}${d.estimated ? '?' : ''}`;
}
export const isElapsed = fmt => !!ELAPSED_MIN[fmt];

// lag: { minutes, format } – format '%' means minutes is a percentage of the predecessor's duration
export function parseLag(text, units = DEFAULT_UNITS) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return { minutes: 0, format: 'd' };
  const pm = /^([+-]?\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (pm) return { minutes: parseFloat(pm[1]), format: '%' };
  const d = parseDuration(s.replace(/^\+/, ''), units);
  return d ? { minutes: d.minutes, format: d.format } : null;
}
export function formatLag(lag, units = DEFAULT_UNITS) {
  if (!lag || !lag.minutes) return '';
  if (lag.format === '%') return `${lag.minutes > 0 ? '+' : ''}${lag.minutes}%`;
  const s = formatDuration({ minutes: lag.minutes, format: lag.format }, units);
  return lag.minutes > 0 ? '+' + s : s;
}
/** "4", "4FS+2d", "7SS-25%, 9FF" with row IDs → [{ id, type, lag }] (null if invalid) */
export function parsePredecessors(text, units = DEFAULT_UNITS) {
  const out = [];
  for (const part of String(text || '').split(/[,;]/).map(x => x.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*(FS|SS|FF|SF)?\s*([+-].*)?$/i.exec(part);
    if (!m) return null;
    const lag = parseLag(m[3] || '', units);
    if (!lag) return null;
    out.push({ id: +m[1], type: (m[2] || 'FS').toUpperCase(), lag });
  }
  return out;
}
export function formatPredecessors(links, idOf, units = DEFAULT_UNITS) {
  return (links || []).map(l => {
    const lag = formatLag(l.lag, units), id = idOf(l.pred);
    return id == null ? null : `${id}${l.type !== 'FS' || lag ? l.type : ''}${lag}`;
  }).filter(Boolean).join(', ');
}

// ---------- outline ----------
/** Children lists, depths and WBS numbers from the task order + parentUid. */
export function outline(plan) {
  const kids = new Map([[null, []]]), byUid = new Map();
  for (const t of plan.tasks) { byUid.set(t.uid, t); kids.set(t.uid, []); }
  for (const t of plan.tasks) (kids.get(byUid.has(t.parentUid) ? t.parentUid : null)).push(t.uid);
  const depth = new Map(), wbs = new Map(), order = [];
  const walk = (parent, d, prefix) => kids.get(parent).forEach((uid, i) => {
    const n = prefix ? `${prefix}.${i + 1}` : String(i + 1);
    depth.set(uid, d); wbs.set(uid, n); order.push(uid);
    walk(uid, d + 1, n);
  });
  walk(null, 0, '');
  return { kids, depth, wbs, order, byUid, isSummary: uid => (kids.get(uid) || []).length > 0 };
}

// ---------- the scheduler ----------
const ASAP = 'ASAP';
function lagMinutes(link, predDur) {
  const l = link.lag || { minutes: 0, format: 'd' };
  if (l.format === '%') return { mins: Math.round(predDur * l.minutes / 100), elapsed: false };
  return { mins: l.minutes, elapsed: isElapsed(l.format) };
}
const shift = (cal, t, lag) => (lag.elapsed ? t + lag.mins : addWorking(cal, t, lag.mins));
const unshift = (cal, t, lag) => (lag.elapsed ? t - lag.mins : subWorking(cal, t, lag.mins));

/**
 * schedule(plan) → { byUid: Map(uid → info), finish, start, errors, order, critical: Set }
 * info: { es, ef, ls, lf, dur, totalSlack, freeSlack, critical, summary, milestone, pct, conflict, late }
 */
export function schedule(plan, opts = {}) {
  const cal = plan.calendar || standardCalendar();
  assertWorking(cal);
  const units = { ...DEFAULT_UNITS, ...(plan.units || {}) };
  const ol = outline(plan), { kids, byUid } = ol;
  const errors = [], info = new Map();
  const projStart = nextWorking(cal, toMin(plan.start) ?? toMin(new Date().toISOString().slice(0, 10)) + 480);
  const status = toMin(plan.statusDate) ?? opts.now ?? null;  // no status date: lateness is measured against now (if given)
  const threshold = opts.criticalSlack || 0;

  const ancestors = uid => { const a = []; let p = byUid.get(uid)?.parentUid; while (p != null && byUid.has(p)) { a.push(p); p = byUid.get(p).parentUid; } return a; };
  const leavesUnder = uid => { const out = []; const go = u => { const k = kids.get(u) || []; if (!k.length) out.push(u); else k.forEach(go); }; go(uid); return out; };

  // dependency graph: links (pred → succ, pushed down to the successor's leaves) + rollups (child → parent)
  const edges = new Map(), indeg = new Map();
  for (const t of plan.tasks) { edges.set(t.uid, new Set()); indeg.set(t.uid, 0); }
  const addEdge = (a, b) => { if (a === b || !edges.has(a) || !edges.has(b) || edges.get(a).has(b)) return; edges.get(a).add(b); indeg.set(b, indeg.get(b) + 1); };
  const succLinks = new Map(plan.tasks.map(t => [t.uid, []]));
  for (const t of plan.tasks) {
    if (t.parentUid != null && byUid.has(t.parentUid)) addEdge(t.uid, t.parentUid);
    for (const l of t.links || []) {
      if (!byUid.has(l.pred)) { errors.push({ uid: t.uid, text: `links to a task that doesn't exist (${l.pred})` }); continue; }
      if (l.pred === t.uid || ancestors(t.uid).includes(l.pred) || ancestors(l.pred).includes(t.uid)) {
        errors.push({ uid: t.uid, text: 'a summary task and its own subtask can\'t be linked' }); continue;
      }
      succLinks.get(l.pred).push({ ...l, succ: t.uid });
      for (const leaf of leavesUnder(t.uid)) addEdge(l.pred, leaf);
      if (kids.get(t.uid).length) addEdge(l.pred, t.uid);
    }
  }
  // topological order (Kahn); anything left over is in a cycle
  const order = [], queue = plan.tasks.filter(t => !indeg.get(t.uid)).map(t => t.uid), deg = new Map(indeg);
  while (queue.length) {
    const u = queue.shift(); order.push(u);
    for (const v of edges.get(u)) { deg.set(v, deg.get(v) - 1); if (!deg.get(v)) queue.push(v); }
  }
  if (order.length < plan.tasks.length) {
    const placed = new Set(order), depth = u => ancestors(u).length;
    const stuck = plan.tasks.filter(t => !placed.has(t.uid)).map(t => t.uid).sort((a, b) => depth(b) - depth(a));  // subtasks before their summaries
    errors.push({ uid: stuck[0], text: `circular links between ${stuck.length} tasks – remove one of the links`, cycle: stuck });
    order.push(...stuck);  // schedule them anyway, ignoring the links that close the loop
  }
  const done = new Set();

  const durOf = t => (t.duration ? t.duration.minutes : 0);
  const elapsedDur = t => !!(t.duration && isElapsed(t.duration.format));
  const finishFrom = (t, s) => (elapsedDur(t) ? s + durOf(t) : addWorking(cal, s, durOf(t)));
  const startFrom = (t, f) => (elapsedDur(t) ? f - durOf(t) : subWorking(cal, f, durOf(t)));
  const snapStart = (t, s) => (durOf(t) > 0 && !elapsedDur(t) ? nextWorking(cal, s) : s);

  // ---------- forward pass ----------
  for (const uid of order) {
    const t = byUid.get(uid), isSum = kids.get(uid).length > 0, rec = { summary: isSum, milestone: !isSum && (t.milestone || durOf(t) === 0), conflict: '' };
    info.set(uid, rec);
    if (isSum) {
      const ch = kids.get(uid).map(k => info.get(k)).filter(Boolean);
      rec.es = ch.length ? Math.min(...ch.map(c => c.es)) : projStart; rec.ef = ch.length ? Math.max(...ch.map(c => c.ef)) : projStart;
      rec.dur = workBetween(cal, rec.es, rec.ef);
      const w = kids.get(uid).map(k => [info.get(k), byUid.get(k)]).filter(([c]) => c);
      const tot = w.reduce((s, [c]) => s + Math.max(c.dur, 0), 0);
      rec.pct = tot ? Math.round(w.reduce((s, [c]) => s + Math.max(c.dur, 0) * (c.pct || 0), 0) / tot) : Math.round(w.reduce((s, [c]) => s + (c.pct || 0), 0) / (w.length || 1));
      done.add(uid);
      continue;
    }
    rec.dur = durOf(t); rec.pct = t.percent || 0;
    if (t.manual && toMin(t.start) != null) {  // manually scheduled: dates as typed
      rec.es = toMin(t.start); rec.ef = toMin(t.finish) ?? finishFrom(t, rec.es); rec.dur = workBetween(cal, rec.es, rec.ef);
      done.add(uid); continue;
    }
    // earliest start allowed by links (own + every ancestor's) and the project start
    let es = projStart, driver = null;
    const consider = (s, why) => { if (s > es) { es = s; driver = why; } };
    for (const owner of [uid, ...ancestors(uid)]) {
      for (const l of byUid.get(owner).links || []) {
        const p = info.get(l.pred);
        if (!p || !done.has(l.pred)) continue;
        const lag = lagMinutes(l, p.dur);
        if (l.type === 'SS') consider(shift(cal, p.es, lag), l.pred);
        else if (l.type === 'FF') consider(startFrom(t, shift(cal, p.ef, lag)), l.pred);
        else if (l.type === 'SF') consider(startFrom(t, shift(cal, p.es, lag)), l.pred);
        else consider(shift(cal, p.ef, lag), l.pred);
      }
    }
    // constraints
    const c = t.constraint || { type: ASAP }, cd = toMin(c.date);
    if (c.type === 'SNET' && cd != null) consider(cd, 'constraint');
    if (c.type === 'FNET' && cd != null) consider(startFrom(t, cd), 'constraint');
    if ((c.type === 'MSO' || c.type === 'MFO') && cd != null) {
      const forced = c.type === 'MSO' ? cd : startFrom(t, cd);
      if (es > forced) rec.conflict = `its links need it to start ${dateOf(es)}, after its ${c.type === 'MSO' ? 'Must Start On' : 'Must Finish On'} date`;
      es = forced;
    }
    es = snapStart(t, es);
    // progress already made is fixed in time
    const as = toMin(t.actualStart), af = toMin(t.actualFinish);
    if (as != null) es = as;
    rec.es = es;
    rec.ef = af != null ? af : finishFrom(t, es);
    if (af != null) rec.dur = workBetween(cal, rec.es, rec.ef);
    if (c.type === 'SNLT' && cd != null && es > cd) rec.conflict = `starts ${dateOf(es)}, after its Start No Later Than date`;
    if (c.type === 'FNLT' && cd != null && rec.ef > cd) rec.conflict = `finishes ${dateOf(rec.ef)}, after its Finish No Later Than date`;
    rec.driver = driver;
    done.add(uid);
  }

  const leafRecs = [...info.entries()].filter(([, r]) => !r.summary);
  const finish = leafRecs.length ? Math.max(...leafRecs.map(([, r]) => r.ef)) : projStart;
  const start = leafRecs.length ? Math.min(...leafRecs.map(([, r]) => r.es)) : projStart;

  // ---------- backward pass ----------
  const lateOf = uid => {  // late dates of a task (summaries: rolled up from their leaves, which are already done)
    const r = info.get(uid);
    if (!r.summary) return r;
    const ls = leavesUnder(uid).map(u => info.get(u));
    return { ls: Math.min(...ls.map(x => x.ls)), lf: Math.max(...ls.map(x => x.lf)) };
  };
  for (const uid of [...order].reverse()) {
    const t = byUid.get(uid), r = info.get(uid);
    if (r.summary) continue;
    let lf = finish;
    const consider = f => { if (f < lf) lf = f; };
    for (const owner of [uid, ...ancestors(uid)]) {
      for (const l of succLinks.get(owner)) {
        const s = lateOf(l.succ);
        if (s.ls == null) continue;
        const lag = lagMinutes(l, info.get(owner).dur);
        if (owner !== uid && (l.type === 'SS' || l.type === 'SF')) {
          // a summary's start is its earliest task's start: only those tasks carry a start-based link
          if (r.es !== Math.min(...leavesUnder(owner).map(u => info.get(u).es))) continue;
        }
        if (l.type === 'FS') consider(unshift(cal, s.ls, lag));
        else if (l.type === 'FF') consider(unshift(cal, s.lf, lag));
        else if (l.type === 'SS') consider(finishFrom(t, unshift(cal, s.ls, lag)));
        else consider(finishFrom(t, unshift(cal, s.lf, lag)));  // SF
      }
    }
    const c = t.constraint || { type: ASAP }, cd = toMin(c.date);
    if ((c.type === 'FNLT' || c.type === 'MFO') && cd != null) consider(cd);
    if ((c.type === 'SNLT' || c.type === 'MSO') && cd != null) consider(finishFrom(t, cd));
    const dl = toMin(t.deadline);
    if (dl != null) consider(dl);
    r.lf = lf;
    r.ls = elapsedDur(t) ? lf - r.dur : subWorking(cal, lf, r.dur);
    if (r.dur === 0) r.ls = lf;
    const finishSlack = workBetween(cal, r.ef, r.lf), startSlack = workBetween(cal, r.es, r.ls);
    r.totalSlack = Math.min(finishSlack, startSlack);
  }
  // As Late As Possible: move to the late dates (successors are already placed)
  for (const uid of order) {
    const t = byUid.get(uid), r = info.get(uid);
    if (!r.summary && (t.constraint || {}).type === 'ALAP' && !t.actualStart && !t.manual && r.ls > r.es) { r.es = r.ls; r.ef = r.lf; r.totalSlack = 0; }
  }
  // free slack, summary late dates and slack, critical flags, lateness
  for (const uid of order) {
    const t = byUid.get(uid), r = info.get(uid);
    if (r.summary) {
      const ch = leavesUnder(uid).map(u => info.get(u));
      r.ls = Math.min(...ch.map(c => c.ls)); r.lf = Math.max(...ch.map(c => c.lf));
      r.totalSlack = Math.min(...ch.map(c => c.totalSlack));
      r.freeSlack = r.totalSlack;
      continue;
    }
    let fs = r.totalSlack;
    for (const l of succLinks.get(uid)) {
      const s = info.get(l.succ), lag = lagMinutes(l, r.dur);
      if (!s || s.summary) continue;
      const v = l.type === 'FS' ? workBetween(cal, shift(cal, r.ef, lag), s.es) : l.type === 'SS' ? workBetween(cal, shift(cal, r.es, lag), s.es)
        : l.type === 'FF' ? workBetween(cal, shift(cal, r.ef, lag), s.ef) : workBetween(cal, shift(cal, r.es, lag), s.ef);
      fs = Math.min(fs, v);
    }
    r.freeSlack = Math.max(Math.min(fs, r.totalSlack), Math.min(0, r.totalSlack));
  }
  const critical = new Set();
  for (const uid of order) {
    const r = info.get(uid), t = byUid.get(uid);
    r.critical = r.totalSlack <= threshold && (r.pct || 0) < 100;
    if (r.critical) critical.add(uid);
    const dl = toMin(t.deadline);
    r.missesDeadline = dl != null && r.ef > dl;
    r.late = status != null && !r.summary && (r.pct || 0) < 100 && expectedPct(cal, r, status) > (r.pct || 0) + 0.5;
  }
  for (const uid of order) {  // a summary is critical if any of its tasks is
    if (info.get(uid).summary && leavesUnder(uid).some(u => critical.has(u))) { info.get(uid).critical = true; critical.add(uid); }
  }
  return { byUid: info, start, finish, errors, order: ol.order, outline: ol, critical, calendar: cal, units };
}

/** % of a task's duration that should be done by `status`. */
export function expectedPct(cal, r, status) {
  if (status <= r.es) return 0;
  if (status >= r.ef) return 100;
  const total = r.dur || workBetween(cal, r.es, r.ef);
  return total ? Math.min(100, workBetween(cal, r.es, status) / total * 100) : 100;
}

// ---------- commands ----------
/** Copy the current schedule into baseline n (0–10). Returns a new plan. */
export function setBaseline(plan, sched, n = 0) {
  const tasks = plan.tasks.map(t => {
    const r = sched.byUid.get(t.uid);
    if (!r) return t;
    const work = (plan.assignments || []).filter(a => a.taskUid === t.uid).reduce((s, a) => s + (a.workMinutes ?? r.dur * (a.units ?? 1)), 0);
    return { ...t, baselines: { ...(t.baselines || {}), [n]: { start: fromMin(r.es), finish: fromMin(r.ef), minutes: r.dur, work } } };
  });
  return { ...plan, tasks };
}
/** MS Project's "Update Project": work scheduled before the status date is marked done. Returns a new plan. */
export function updateToStatus(plan, sched) {
  const cal = sched.calendar, status = toMin(plan.statusDate);
  if (status == null) return plan;
  const tasks = plan.tasks.map(t => {
    const r = sched.byUid.get(t.uid);
    if (!r || r.summary || r.es >= status || (t.percent || 0) >= 100) return t;
    const pct = Math.round(expectedPct(cal, r, status));
    if (pct <= (t.percent || 0)) return t;
    const out = { ...t, percent: pct, actualStart: t.actualStart || fromMin(r.es) };
    if (pct >= 100) out.actualFinish = fromMin(r.ef);
    return out;
  });
  return { ...plan, tasks };
}
/** Variance against baseline n, in working minutes (positive = later than planned). */
export function variance(sched, task, n = 0) {
  const b = (task.baselines || {})[n], r = sched.byUid.get(task.uid);
  if (!b || !r) return null;
  const cal = sched.calendar;
  return { start: workBetween(cal, toMin(b.start), r.es), finish: workBetween(cal, toMin(b.finish), r.ef), duration: r.dur - (b.minutes || 0) };
}

/** Planned working minutes of a task in [a, b) – used for workload and for splitting timesheet hours. */
export function workIn(sched, uid, a, b) {
  const r = sched.byUid.get(uid);
  if (!r || r.summary || r.ef <= a || r.es >= b) return 0;
  return workBetween(sched.calendar, Math.max(r.es, a), Math.min(r.ef, b));
}

/** A calendar from Keystone's settings: a 14-day schedule (hours per day) + holidays (YYYY-MM-DD → name). */
export function calendarFromSchedule(hours14, anchor, holidays = {}, from, to) {
  const periodsFor = h => (h <= 0 ? [] : h <= 4 ? [[480, 480 + h * 60]] : [[480, 720], [780, 780 + (h - 4) * 60]]);
  const week = Array.from({ length: 7 }, (_, d) => periodsFor(hours14[d] || 0));
  const exceptions = {};
  const a = toMin(anchor) ?? toMin('2026-01-04'), f = toMin(from), t = toMin(to);
  if (f != null && t != null) {
    for (let day = Math.floor(f / DAY); day <= Math.floor(t / DAY); day++) {
      const idx = ((day - Math.floor(a / DAY)) % 14 + 14) % 14, h = hours14[idx] || 0, base = hours14[idx % 7] || 0;
      if (h !== base) exceptions[fromMin(day * DAY).slice(0, 10)] = periodsFor(h);  // e.g. the 9/80 Friday off
    }
  }
  for (const d of Object.keys(holidays)) exceptions[d] = [];
  return { name: 'Keystone schedule', week, exceptions };
}
