// Leave → timesheet, usual pay period, timer log, pay-period nudges and history, calendar (.ics) import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, withState } from './load_app.mjs';

const app = loadApp();
const plain = x => JSON.parse(JSON.stringify(x));
const eq = (actual, expected) => assert.deepEqual(plain(actual), expected);  // arrays from the sandbox are another realm's
const row = (code, h, network = '', activity = '') => ({ id: Math.random().toString(36).slice(2), code, network, activity, ts: false, h });

/* ---------- leave on the calendar → timesheet ---------- */
test('annual leave fills scheduled workdays, less what is already logged, and shows the balance it leaves', () => {
  withState(app, { settings: { annualRate: 4, annualStart: 0 }, periods: { '2026-01-04': { weeks: [
    { rows: [row('RG', ['', '', '', '', '4', '', ''], '4001', '10')] }, { rows: [] }] } } });
  app.setView({ start: null, period: null });
  // Wed Jan 7 – Tue Jan 13 on a 5×8 schedule: Wed, Thu (4 h already logged), Fri, Mon, Tue
  const a = { id: 'a', kind: 'annual', start: '2026-01-07', end: '2026-01-13', note: '', fill: true };
  const p = app.planLeave(a, null);
  assert.equal(p.plan.error, undefined);
  eq((p.add.filled), { '2026-01-07': 8, '2026-01-08': 4, '2026-01-09': 8, '2026-01-12': 8, '2026-01-13': 8 });
  assert.equal(p.added, 36);
  assert.equal(p.after.balance, 4 - 36);  // one period accrued at 4 h
});

test('editing a leave entry takes back only what it added, and travel never touches the timesheet', () => {
  const s = withState(app, { periods: { '2026-01-04': { weeks: [
    { rows: [row('LA', ['', '', '', '8', '8', '', ''])] }, { rows: [] }] } } });
  app.setView({ start: null, period: null });
  const old = { id: 'a', kind: 'annual', start: '2026-01-07', end: '2026-01-08', fill: true, filled: { '2026-01-07': 8, '2026-01-08': 8 }, filledCode: 'LA' };
  // shrink it to one day: Thursday's 8 h come off, Wednesday stays
  const p = app.planLeave({ ...old, end: '' }, old);
  assert.equal(p.removed, 16);
  assert.equal(p.added, 8);
  const week = p.plan.work.get('2026-01-04').weeks[0];
  eq(week.rows.filter(r => r.code === 'LA').map(r => r.h.slice(3, 5)), [['8', '']]);
  assert.equal(app.planLeave({ id: 't', kind: 'travel', start: '2026-01-07', end: '2026-01-09', fill: true }, null).plan.work.size, 0);
  assert.equal(s.periods['2026-01-04'].weeks[0].rows[0].h[3], '8');  // nothing is applied until saved
});

test('leave skips holidays and days off, and refuses submitted pay periods', () => {
  withState(app, { periods: { '2026-01-18': { submitted: { at: '2026-01-30T10:00:00Z', total: 80 }, weeks: [{ rows: [] }, { rows: [] }] } } });
  app.setView({ start: null, period: null });
  const f = app.leaveFillEntries({ kind: 'sick', start: '2026-01-15', end: '2026-01-21' });  // Thu 15 – Wed 21; Mon 19 is MLK Day
  eq(f.entries.map(e => e.date), ['2026-01-15', '2026-01-16']);
  eq(f.skipped, ['2026-01-20', '2026-01-21']);  // the Jan 18 period is locked
  assert.equal(f.code, 'LS');
});

/* ---------- my usual pay period ---------- */
test('fill from my usual pay period skips holidays, leave and days that already have hours', () => {
  const usual = { weeks: [[{ network: '4001', activity: '10', code: 'RG', ts: false, h: ['', '8', '8', '8', '8', '8', ''] }],
    [{ network: '4001', activity: '10', code: 'RG', ts: true, h: ['', '8', '8', '8', '8', '8', ''] }]], from: '2026-01-04' };
  const s = withState(app, { settings: { usual } });
  s.away = [{ id: 'x', kind: 'annual', start: '2026-01-22', end: '', note: '' }];
  const per = { weeks: [{ rows: [row('RG', ['', '', '6', '', '', '', ''], '4002', '20')] }, { rows: [] }] };
  app.setView({ start: '2026-01-18', period: per });
  app.fillUsual();
  const [w1, w2] = per.weeks;
  // Mon 19 is MLK Day (LH instead), Tue 20 already had hours, Thu 22 is annual leave
  eq(w1.rows.find(r => r.network === '4001').h, ['', '', '', '8', '', '8', '']);
  eq(w1.rows.find(r => r.code === 'LH').h, ['', '8', '', '', '', '', '']);
  eq(w2.rows.find(r => r.network === '4001').h, ['', '8', '8', '8', '8', '8', '']);
  assert.equal(w2.rows.find(r => r.network === '4001').ts, true);
});

/* ---------- timer log ---------- */
test('quarterSplit rounds to quarter hours and keeps the total', () => {
  eq((app.quarterSplit([1.1, 2.3, 0.4], 3.8)), [1, 2.25, 0.5]);
  const scaled = app.quarterSplit([1, 2, 1].map(v => v / 4 * 7.5), 7.5);
  assert.equal(scaled.reduce((a, b) => a + b, 0), 7.5);
});
test('timerGroups sums a day’s sessions per project', () => {
  const s = withState(app);
  s.timerLog = [{ id: '1', date: '2026-03-02', network: 'N', activity: 'A', code: 'RG', ts: false, ms: 36e5 },
    { id: '2', date: '2026-03-02', network: 'N', activity: 'A', code: 'RG', ts: false, ms: 18e5 },
    { id: '3', date: '2026-03-02', network: 'M', activity: 'B', code: 'RG', ts: false, ms: 9e5 },
    { id: '4', date: '2026-03-03', network: 'N', activity: 'A', code: 'RG', ts: false, ms: 6e5 }];
  eq(app.timerGroups('2026-03-02').map(g => [g.network, g.ms, g.ids.length]), [['N', 54e5, 2], ['M', 9e5, 1]]);
});

/* ---------- pay period nudges and history ---------- */
test('history lists recent pay periods with what was submitted', () => {
  const cur = '2026-01-04';
  const s = withState(app, { settings: { anchor: '2025-12-21' }, periods: {
    '2025-12-21': { submitted: { at: '2026-01-02T15:00:00Z', total: 80 }, lastSubmitted: { at: '2026-01-02T15:00:00Z', snapshot: '' }, weeks: [{ rows: [row('RG', ['', '8', '8', '8', '8', '8', ''], 'N', 'A')] }, { rows: [row('RG', ['', '8', '8', '8', '8', '8', ''], 'N', 'A')] }] },
    '2025-12-07': { weeks: [{ rows: [row('RG', ['', '8', '', '', '', '', ''], 'N', 'A')] }, { rows: [] }] } } });
  app.setView({ start: null, period: null });
  const hist = app.periodHistory(5).map(x => [x.start, x.total, x.st[1]]);
  assert.ok(hist[0][0] >= '2026-01-04' || hist.length);
  const byStart = Object.fromEntries(hist.map(x => [x[0], x]));
  eq(byStart['2025-12-21'], ['2025-12-21', 80, 'Submitted']);
  eq(byStart['2025-12-07'], ['2025-12-07', 8, 'Not marked submitted']);
  void s; void cur;
});

/* ---------- calendar import ---------- */
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0',
  'BEGIN:VEVENT', 'UID:standup', 'SUMMARY:Daily stand-up', 'DTSTART:20260302T090000', 'DTEND:20260302T091500',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5', 'EXDATE:20260304T090000',
  'BEGIN:VALARM', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:standup', 'RECURRENCE-ID:20260306T090000', 'SUMMARY:Daily stand-up (moved)', 'DTSTART:20260306T130000', 'DTEND:20260306T131500', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:review', 'SUMMARY:Girder Bridge design review\\, phase 2', 'LOCATION:Room 4', 'DTSTART:20260303T150000Z', 'DURATION:PT1H30M', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:conf', 'SUMMARY:Conference', 'DTSTART;VALUE=DATE:20260310', 'DTEND;VALUE=DATE:20260313', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:gone', 'SUMMARY:Cancelled thing', 'STATUS:CANCELLED', 'DTSTART:20260305T100000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:monthly', 'SUMMARY:Team lunch', 'DTSTART:20260115T120000', 'DTEND:20260115T130000', 'RRULE:FREQ=MONTHLY;BYDAY=3TH', 'END:VEVENT',
  'END:VCALENDAR'].join('\r\n');

test('parseIcs: repeats, exceptions, moved instances, all-day spans, UTC times, cancelled events', () => {
  withState(app);
  const evs = app.parseIcs(ICS, '2026-03-01', '2026-03-31');
  const ups = evs.filter(e => e.title.startsWith('Daily'));
  // Mon 2, (Wed 4 excluded), Fri 6 moved to 1 pm, Mon 9, Wed 11 – COUNT=5 counts the excluded one too
  eq(ups.map(e => [e.date, e.start, e.title]), [
    ['2026-03-02', '09:00', 'Daily stand-up'], ['2026-03-06', '13:00', 'Daily stand-up (moved)'],
    ['2026-03-09', '09:00', 'Daily stand-up'], ['2026-03-11', '09:00', 'Daily stand-up']]);
  assert.equal(ups[0].mins, 15);
  const review = evs.find(e => e.title.startsWith('Girder'));
  assert.equal(review.title, 'Girder Bridge design review, phase 2');
  assert.equal(review.mins, 90);
  assert.equal(review.date, '2026-03-03');
  const conf = evs.find(e => e.title === 'Conference');
  eq([conf.allDay, conf.days], [true, 3]);
  assert.ok(!evs.some(e => e.title === 'Cancelled thing'));
  eq(evs.filter(e => e.title === 'Team lunch').map(e => e.date), ['2026-03-19']);  // 3rd Thursday
});

test('imported events land on each day they cover, and a project in the title is suggested', () => {
  const s = withState(app, { projects: [{ id: 'p1', network: '4001234', activity: '0010', name: 'Girder Bridge', budget: '' }, { id: 'p2', network: '4005678', activity: '0020', name: 'Drainage', budget: '' }] });
  s.events = app.parseIcs(ICS, '2026-03-01', '2026-03-31');
  eq(app.eventsOn('2026-03-11').map(e => e.title), ['Conference', 'Daily stand-up']);  // all-day first
  assert.equal(app.eventsOn('2026-03-13').length, 0);  // DTEND is exclusive
  assert.equal(app.matchEventProject(s.events.find(e => e.title.startsWith('Girder'))).id, 'p1');
  assert.equal(app.matchEventProject({ title: 'Lunch', location: '' }), null);
});

/* ---------- reports ---------- */
test('hours by project can show a whole year', () => {
  withState(app, { periods: { '2026-01-04': { weeks: [{ rows: [row('RG', ['', '8', '8', '', '', '', ''], 'N', 'A'), row('LA', ['', '', '', '8', '', '', ''])] }, { rows: [] }] } } });
  app.setView({ start: null, period: null, repRange: '2026' });
  const t = app.monthTable();
  assert.equal(t.ms.length, 12);
  eq((t.years), ['2026']);
  eq(t.rows.map(([n, v]) => [n, v['2026-01']]), [['Annual leave', 8], ['N/A', 16]]);
  app.setView({ repRange: '' });
});
