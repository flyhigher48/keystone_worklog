// Dates, federal holidays, schedules, the pay-period check and the submitted lock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, withState } from './load_app.mjs';

const app = loadApp();

test('federal holidays for 2026, with weekend dates moved to the observed day', () => {
  assert.deepEqual(Object.keys(app.federalHolidays(2026)), ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19',
    '2026-07-03' /* Jul 4 is a Saturday */, '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']);
});

test('observed holidays across a year boundary', () => {
  const h27 = app.federalHolidays(2027);
  assert.equal(h27['2027-12-24'], 'Christmas Day');      // Dec 25 2027 is a Saturday
  assert.equal(h27['2027-12-31'], "New Year's Day");     // Jan 1 2028 is a Saturday
  assert.equal(h27['2027-06-18'], 'Juneteenth');
});

test('every schedule preset adds up to 80 hours', () => {
  for (const [key, [, arr]] of Object.entries(app.SCHEDULES)) if (arr) assert.equal(arr.reduce((a, b) => a + b, 0), 80, key);
});

test('date helpers and moment-style formats', () => {
  assert.equal(app.addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(app.diffDays('2026-03-07', '2026-03-09'), 2);  // across the DST change
  const d = new Date(2026, 9, 23, 14, 5, 9);
  assert.equal(app.fmtMoment(d, 'dddd, MMMM D, YYYY'), 'Friday, October 23, 2026');
  assert.equal(app.fmtMoment(d, 'h:mm A'), '2:05 PM');
  assert.equal(app.fmtMoment(d, '[Week of] MMM D'), 'Week of Oct 23');
  assert.equal(app.fmtMoment(d, 'YYYYMMDDHHmmss'), '20261023140509');
});

test('templates fill in title, date and time', () => {
  withState(app);
  const out = app.applyTemplate('# {{title}} – {{date:YYYY}}', 'Kickoff');
  assert.match(out, /^# Kickoff – \d{4}$/);
});

const project = { id: 'a', network: '1', activity: '10', name: 'Bridge', budget: '20' };

test('a new pay period starts with its holidays as LH', () => {
  withState(app, { settings: { anchor: '2026-10-11' }, projects: [project] });
  app.loadPeriod('2026-10-11');                           // contains Columbus Day, Mon Oct 12
  const lh = app.view.period.weeks[0].rows.find(r => r.code === 'LH');
  assert.deepEqual([...lh.h], ['', '8', '', '', '', '', '']);
});

test('the pay-period check finds short totals, empty workdays and budgets', () => {
  const s = withState(app, { settings: { anchor: '2026-10-11' }, projects: [project] });
  app.loadPeriod('2026-10-11');
  const w = app.view.period.weeks;
  Object.assign(w[0].rows[0], { network: '1', activity: '10', h: ['', '', '8', '8', '8', '8', ''] });
  w[1].rows[0] = { ...w[0].rows[0], id: 'x', h: ['', '8', '8', '8', '8', '', ''] };
  s.periods['2026-10-11'] = app.view.period;
  const texts = app.periodIssues('2026-10-11').map(i => i.text);
  assert.ok(texts.includes('Total is 72 h, 8 h short of 80 h.'));
  assert.ok(texts.includes('Fri Oct 23: no hours on a 8 h workday.'));
  assert.ok(texts.some(t => t.startsWith('Bridge is 44 h over its 20 h budget')));
  assert.ok(!texts.some(t => t.includes('Columbus')));  // the holiday was filled in
});

test('planning hours, and the submitted lock', () => {
  const s = withState(app, { settings: { anchor: '2026-10-11' }, projects: [project] });
  app.loadPeriod('2026-10-11');
  const plan = app.planHours([{ date: '2026-10-23', project: 'Bridge', hours: 8 }]);
  assert.equal(plan.error, undefined);
  assert.equal(plan.lines[0], 'Fri Oct 23 · Bridge · RG: 0 → 8 h (new row)');  // no Bridge row yet in this period
  assert.match(app.planHours([{ date: '2026-10-23', project: 'Nope', hours: 1 }]).error, /no project matches/);
  assert.match(app.planHours([{ date: '2026-10-23', project: 'Bridge', hours: 30 }]).error, /would make 30 h/);
  assert.match(app.planHours([{ date: 'friday', project: 'Bridge', hours: 1 }]).error, /YYYY-MM-DD/);
  s.periods['2026-10-11'] = app.view.period;
  s.periods['2026-10-11'].submitted = { at: '2026-10-24T10:00:00Z', total: 80 };
  assert.match(app.planHours([{ date: '2026-10-23', project: 'Bridge', hours: 1 }]).error, /marked Submitted/);
});

test('custom schedules and extra holidays', () => {
  const s = withState(app, { settings: { schedule: '980a', extraHolidays: '2026-12-24 Christmas Eve\nnot a date' } });
  assert.equal(app.scheduleArr()[12], 0);                // 9/80: second Friday off
  assert.equal(app.holidayOn('2026-12-24'), 'Christmas Eve');
  s.settings.holidays = false;
  assert.equal(app.holidayOn('2026-12-25'), null);
});
