// Budget burn rate: average of the last 4 completed weeks, counting only weeks since the project started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, withState } from './load_app.mjs';

const app = loadApp();
const ANCHOR = '2026-01-04';  // a Sunday; pay periods every 14 days from here

// weekly hours relative to this week: { 0: hours this week, 1: last week, ... }
function burnFor(budget, weeksAgo) {
  const thisWeek = app.sundayOf(new Date()), periods = {};
  for (const [ago, hours] of Object.entries(weeksAgo)) {
    const ws = app.addDays(thisWeek, -7 * Number(ago)), off = app.diffDays(ANCHOR, ws);
    const ps = app.addDays(ANCHOR, Math.floor(off / 14) * 14), wi = (off - Math.floor(off / 14) * 14) / 7;
    periods[ps] ||= { weeks: [{ rows: [] }, { rows: [] }] };
    const h = ['', '', '', '', '', '', '']; let left = hours;
    for (let d = 1; d <= 5 && left > 0; d++) { const x = Math.min(left, 8); h[d] = String(x); left -= x; }
    periods[ps].weeks[wi].rows.push({ id: 'r' + ago, network: '9', activity: '1', code: 'RG', ts: false, h });
  }
  const s = withState(app, { settings: { anchor: ANCHOR }, projects: [{ id: 'p', network: '9', activity: '1', name: 'P', budget: String(budget) }], periods });
  app.loadPeriod(app.addDays(ANCHOR, Math.floor(app.diffDays(ANCHOR, thisWeek) / 14) * 14));
  return app.burnInfo(s.projects[0]);
}

test('a brand-new project uses this week so far (10 h/wk, 120 h budget → 11 weeks left)', () => {
  const i = burnFor(120, { 0: 10 });
  assert.equal(i.rate, 10);
  assert.match(i.basis, /this week so far/);
  assert.equal(i.weeksLeft, 11);
});

test('steady 10 h a week → 10 h/wk, and weeks left = budget left ÷ rate', () => {
  const i = burnFor(120, { 3: 10, 2: 10, 1: 10, 0: 10 });
  assert.equal(i.used, 40);
  assert.equal(i.rate, 10);           // only the 3 full weeks since the start count
  assert.equal(i.weeksLeft, 8);
  assert.equal(i.outDate, app.addDays(app.fmt(new Date()), 56));
});

test('the window is the last 4 completed weeks; zero weeks count once the project has started', () => {
  assert.equal(burnFor(120, { 6: 10, 5: 10, 4: 10, 3: 10, 2: 10, 1: 10 }).rate, 10);
  assert.equal(burnFor(120, { 3: 20, 2: 20, 1: 0 }).rate, 40 / 3);
});

test('no recent hours → no run-out date; over budget → no weeks left', () => {
  const idle = burnFor(120, { 5: 20 });
  assert.equal(idle.rate, 0);
  assert.equal(idle.outDate, null);
  const over = burnFor(20, { 2: 30, 1: 10 });
  assert.equal(over.left, -20);
  assert.equal(over.weeksLeft, null);
});
