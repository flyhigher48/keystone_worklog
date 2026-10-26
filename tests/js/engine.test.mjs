// Planner scheduling engine: calendars, links, lags, constraints, summaries, progress, slack – checked by hand
// on the standard calendar (Mon–Fri 08:00–12:00, 13:00–17:00). 2026-10-19 is a Monday.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../keystone_worklog/static/planner/engine.js';

const cal = E.standardCalendar(), M = E.toMin, F = E.fromMin;
const d = n => ({ minutes: n * 480, format: 'd' });
const plan = (tasks, extra = {}) => ({ start: '2026-10-19', calendar: cal, tasks, ...extra });
const T = (uid, name, days, more = {}) => ({ uid, name, duration: d(days), ...more });
const fs = (pred, lag) => ({ pred, type: 'FS', lag: lag || { minutes: 0, format: 'd' } });
const at = (s, uid) => { const r = s.byUid.get(uid); return [F(r.es), F(r.ef)]; };

test('working-time arithmetic', () => {
  assert.equal(F(E.addWorking(cal, M('2026-10-19T08:00'), 480)), '2026-10-19T17:00');
  assert.equal(F(E.addWorking(cal, M('2026-10-19T17:00'), 480)), '2026-10-20T17:00');
  assert.equal(F(E.addWorking(cal, M('2026-10-23T08:00'), 960)), '2026-10-26T17:00');  // over the weekend
  assert.equal(F(E.subWorking(cal, M('2026-10-20T17:00'), 480)), '2026-10-20T08:00');
  assert.equal(F(E.subWorking(cal, M('2026-10-26T08:00'), 480)), '2026-10-23T08:00');
  assert.equal(E.workBetween(cal, M('2026-10-19T08:00'), M('2026-10-20T17:00')), 960);
  assert.equal(E.workBetween(cal, M('2026-10-20T17:00'), M('2026-10-19T08:00')), -960);
  assert.equal(F(E.nextWorking(cal, M('2026-10-24T10:00'))), '2026-10-26T08:00');
  assert.equal(F(E.nextWorking(cal, M('2026-10-19T12:30'))), '2026-10-19T13:00');
  assert.equal(F(E.prevWorking(cal, M('2026-10-20T08:00'))), '2026-10-19T17:00');
});

test('a finish-to-start chain, milestone and critical path', () => {
  const s = E.schedule(plan([T(1, 'A', 3), T(2, 'B', 2, { links: [fs(1)] }), T(3, 'Done', 0, { links: [fs(2)] })]));
  assert.deepEqual(at(s, 1), ['2026-10-19T08:00', '2026-10-21T17:00']);
  assert.deepEqual(at(s, 2), ['2026-10-22T08:00', '2026-10-23T17:00']);
  assert.deepEqual(at(s, 3), ['2026-10-23T17:00', '2026-10-23T17:00']);
  assert.ok(s.byUid.get(3).milestone);
  assert.deepEqual([...s.critical].sort(), [1, 2, 3]);
  assert.equal(F(s.finish), '2026-10-23T17:00');
});

test('lags: working days, leads, percentages and elapsed time', () => {
  const run = lag => at(E.schedule(plan([T(1, 'A', 3), T(2, 'B', 2, { links: [fs(1, lag)] })])), 2)[0];
  assert.equal(run({ minutes: 480, format: 'd' }), '2026-10-23T08:00');   // +1d: A ends Wed 17:00 → Thu 17:00 → Fri 08:00
  assert.equal(run({ minutes: -480, format: 'd' }), '2026-10-21T08:00');  // -1d lead overlaps A's last day
  assert.equal(run({ minutes: 2880, format: 'ed' }), '2026-10-26T08:00'); // +2 elapsed days → Fri 17:00 → Mon
  const s = E.schedule(plan([T(1, 'A', 4), T(2, 'B', 1, { links: [{ pred: 1, type: 'FS', lag: { minutes: 50, format: '%' } }] })]));
  assert.equal(at(s, 2)[0], '2026-10-27T08:00');                         // +50% of 4d = 2d after Thu 17:00
});

test('start-to-start, finish-to-finish and start-to-finish links', () => {
  const s = E.schedule(plan([T(1, 'A', 3),
    T(2, 'SS+1d', 2, { links: [{ pred: 1, type: 'SS', lag: { minutes: 480, format: 'd' } }] }),
    T(3, 'FF', 2, { links: [{ pred: 1, type: 'FF' }] }),
    T(4, 'SF', 1, { links: [{ pred: 1, type: 'SF' }] })]));
  assert.deepEqual(at(s, 2), ['2026-10-20T08:00', '2026-10-21T17:00']);
  assert.deepEqual(at(s, 3), ['2026-10-20T08:00', '2026-10-21T17:00']);
  assert.equal(at(s, 4)[0], '2026-10-19T08:00');  // SF would want it before the project start: held at the start
});

test('constraints, conflicts and deadlines', () => {
  const s = E.schedule(plan([T(1, 'A', 3),
    T(2, 'SNET', 1, { constraint: { type: 'SNET', date: '2026-10-28' } }),
    T(3, 'MSO too early', 1, { links: [fs(1)], constraint: { type: 'MSO', date: '2026-10-20' } }),
    T(4, 'FNLT', 2, { links: [fs(1)], constraint: { type: 'FNLT', date: '2026-10-22T17:00' } }),
    T(5, 'Deadline', 2, { links: [fs(1)], deadline: '2026-10-22T17:00' })]));
  assert.equal(at(s, 2)[0], '2026-10-28T08:00');
  assert.equal(at(s, 3)[0], '2026-10-20T08:00');
  assert.match(s.byUid.get(3).conflict, /Must Start On/);
  assert.match(s.byUid.get(4).conflict, /Finish No Later Than/);
  assert.equal(s.byUid.get(4).totalSlack, -480);  // a day late against FNLT
  assert.ok(s.byUid.get(5).missesDeadline);
  assert.equal(s.byUid.get(5).totalSlack, -480);  // a deadline doesn't move the task, but shows negative slack
  assert.deepEqual(at(s, 5), ['2026-10-22T08:00', '2026-10-23T17:00']);
});

test('slack on a parallel path, and free slack', () => {
  const s = E.schedule(plan([T(1, 'A', 3), T(2, 'B', 1), T(3, 'C', 1, { links: [fs(1), fs(2)] })]));
  assert.equal(s.byUid.get(2).totalSlack, 960);
  assert.equal(s.byUid.get(2).freeSlack, 960);
  assert.equal(s.byUid.get(1).totalSlack, 0);
  assert.ok(!s.critical.has(2) && s.critical.has(1) && s.critical.has(3));
});

test('summary tasks roll up, and links to and from summaries apply to their tasks', () => {
  const s = E.schedule(plan([
    T(1, 'Design', 0), T(2, 'Calcs', 3, { parentUid: 1, percent: 100 }), T(3, 'Drawings', 2, { parentUid: 1, links: [fs(2)] }),
    T(4, 'Kickoff', 1),
    T(5, 'Build', 0, { links: [fs(1)] }), T(6, 'Pour', 2, { parentUid: 5 }),
  ], { start: '2026-10-19' }));
  const des = s.byUid.get(1);
  assert.ok(des.summary);
  assert.deepEqual(at(s, 1), ['2026-10-19T08:00', '2026-10-23T17:00']);
  assert.equal(des.pct, 60);  // 3d done of 5d
  assert.deepEqual(at(s, 6), ['2026-10-26T08:00', '2026-10-27T17:00']);  // after the whole Design summary
  assert.deepEqual(s.outline.wbs.get(3), '1.2');
});

test('circular links and summary-to-own-subtask links are reported, not hung on', () => {
  const s = E.schedule(plan([T(1, 'A', 1, { links: [fs(2)] }), T(2, 'B', 1, { links: [fs(1)] })]));
  assert.match(s.errors[0].text, /circular/);
  const s2 = E.schedule(plan([T(1, 'S', 0), T(2, 'A', 1, { parentUid: 1, links: [fs(1)] })]));
  assert.match(s2.errors[0].text, /summary task and its own subtask/);
});

test('progress: actual dates are fixed, manual tasks keep their dates, ALAP moves late', () => {
  const s = E.schedule(plan([
    T(1, 'Started early', 3, { actualStart: '2026-10-14T08:00', percent: 50 }),
    T(2, 'Manual', 2, { manual: true, start: '2026-11-02T08:00', finish: '2026-11-03T17:00', links: [fs(1)] })]));
  assert.deepEqual(at(s, 1), ['2026-10-14T08:00', '2026-10-16T17:00']);
  assert.deepEqual(at(s, 2), ['2026-11-02T08:00', '2026-11-03T17:00']);  // links don't move a manual task
  const a = E.schedule(plan([T(3, 'Long', 5), T(4, 'ALAP', 1, { constraint: { type: 'ALAP' } }), T(5, 'End', 0, { links: [fs(3), fs(4)] })]));
  assert.deepEqual(at(a, 4), ['2026-10-23T08:00', '2026-10-23T17:00']);  // as late as its successor allows
});

test('update to status date, baseline and variance', () => {
  let p = plan([T(1, 'A', 3), T(2, 'B', 2, { links: [fs(1)] })], { statusDate: '2026-10-21T12:00' });
  let s = E.schedule(p);
  assert.ok(s.byUid.get(1).late);  // nothing marked done yet, but it should be 83% done
  p = E.updateToStatus(p, s);
  assert.equal(p.tasks[0].percent, 83);
  assert.equal(p.tasks[0].actualStart, '2026-10-19T08:00');
  p = E.setBaseline(p, E.schedule(p), 0);
  p.tasks[1].duration = d(4);  // B grows by two days
  s = E.schedule(p);
  assert.deepEqual(E.variance(s, p.tasks[1], 0), { start: 0, finish: 960, duration: 960 });
});

test('parsing durations and predecessors', () => {
  assert.deepEqual(E.parseDuration('3d'), { minutes: 1440, format: 'd', estimated: false });
  assert.deepEqual(E.parseDuration('2 weeks'), { minutes: 4800, format: 'w', estimated: false });
  assert.deepEqual(E.parseDuration('5d?'), { minutes: 2400, format: 'd', estimated: true });
  assert.deepEqual(E.parseDuration('2ed'), { minutes: 2880, format: 'ed', estimated: false });
  assert.equal(E.parseDuration('soon'), null);
  assert.equal(E.formatDuration({ minutes: 1200, format: 'd' }), '2.5d');
  const p = E.parsePredecessors('4, 7SS-25%, 9FF+2d');
  assert.deepEqual(p.map(x => [x.id, x.type, x.lag.minutes, x.lag.format]), [[4, 'FS', 0, 'd'], [7, 'SS', -25, '%'], [9, 'FF', 960, 'd']]);
  assert.equal(E.parsePredecessors('4XX'), null);
  assert.equal(E.formatPredecessors([{ pred: 40, type: 'FS', lag: { minutes: 0 } }, { pred: 41, type: 'SS', lag: { minutes: 480, format: 'd' } }], u => u / 10), '4, 4.1SS+1d');
});

test('Keystone calendar: a 9/80 schedule and holidays', () => {
  const h = [0, 9, 9, 9, 9, 8, 0, 0, 9, 9, 9, 9, 0, 0];
  const c = E.calendarFromSchedule(h, '2026-10-18', { '2026-11-11': 'Veterans Day' }, '2026-10-18', '2026-11-30');
  assert.equal(E.dayWork(c, M('2026-10-19') / 1440), 540);
  assert.equal(E.dayWork(c, M('2026-10-23') / 1440), 480);  // week 1 Friday: 8 h
  assert.equal(E.dayWork(c, M('2026-10-30') / 1440), 0);    // week 2 Friday: off
  assert.equal(E.dayWork(c, M('2026-11-11') / 1440), 0);    // holiday
});

test('fast enough for big plans', () => {
  const tasks = [];
  for (let i = 1; i <= 2000; i++) {
    const links = i > 1 ? [fs(i - 1)] : [];
    if (i > 10 && i % 7 === 0) links.push({ pred: i - 9, type: 'SS', lag: { minutes: 240, format: 'd' } });
    tasks.push(T(i, 'T' + i, 1 + (i % 5), { links, parentUid: i % 50 === 1 ? null : undefined }));
  }
  const t0 = performance.now(), s = E.schedule(plan(tasks));
  const ms = performance.now() - t0;
  assert.equal(s.errors.length, 0);
  assert.ok(ms < 500, `2,000 tasks took ${ms.toFixed(0)} ms`);
});

test('late: against the status date, or against "now" when there is none', () => {
  const tasks = [T(1, 'A', 5, { percent: 20 }), T(2, 'B', 5, { links: [fs(1)] })];
  const none = E.schedule(plan(tasks));
  assert.equal(none.byUid.get(1).late, false);                   // no status date, no "now": nothing is late
  const now = E.schedule(plan(tasks), { now: M('2026-10-22') });   // Thursday 00:00 – 3 of 5 days should be done
  assert.equal(now.byUid.get(1).late, true);
  assert.equal(now.byUid.get(2).late, false);                     // hasn't started yet
  const st = E.schedule(plan(tasks, { statusDate: '2026-10-20T08:00' }), { now: M('2026-10-30') });
  assert.equal(st.byUid.get(1).late, false);                      // the status date wins: 20% expected by Tuesday morning
});

test('a loop through summary tasks is reported, not hung on', () => {
  const tasks = [T(1, 'Phase 1', 0), T(2, 'A', 2, { parentUid: 1, links: [fs(5)] }), T(3, 'B', 2, { parentUid: 1, links: [fs(2)] }),
    T(4, 'Phase 2', 0), T(5, 'C', 2, { parentUid: 4, links: [fs(1)] })];
  const s = E.schedule(plan(tasks));
  assert.ok(s.errors.some(e => /circular/.test(e.text)));
  for (const r of s.byUid.values()) assert.ok(Number.isFinite(r.es) && Number.isFinite(r.ef));
});
