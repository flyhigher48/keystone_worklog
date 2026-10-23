// Out of office: planned entries and timesheet leave shown on the Board calendar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, withState } from './load_app.mjs';

const app = loadApp();

test('awayOn covers every day of a range, and single days without an end', () => {
  const s = withState(app);
  s.away = [{ id: 'a', kind: 'travel', start: '2026-03-09', end: '2026-03-11', note: 'Site visit' },
    { id: 'b', kind: 'sick', start: '2026-03-20', end: '', note: '' }];
  assert.deepEqual(['2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12'].map(d => app.awayOn(d).length), [0, 1, 1, 1, 0]);
  assert.equal(app.awayOn('2026-03-20')[0].id, 'b');
  assert.equal(app.awayKind('nope')[1], 'Out of office');
});

test('leaveByDate reads LA/LS hours from the timesheet onto their dates', () => {
  const blank = () => ['', '', '', '', '', '', ''];
  withState(app, { periods: { '2026-01-04': { weeks: [
    { rows: [{ code: 'RG', network: '1', activity: '1', ts: false, h: ['', '8', '8', '8', '8', '8', ''] },
      { code: 'LA', network: '', activity: '', ts: false, h: ['', '', '', '', '', '8', ''] }] },
    { rows: [{ code: 'LS', network: '', activity: '', ts: false, h: ['', '4', '', '', '', '', ''] },
      { code: 'LA', network: '', activity: '', ts: false, h: ['', '2', '', '', '', '', ''] },
      { code: 'LH', network: '', activity: '', ts: false, h: blank() }] }] } } });
  assert.deepEqual(JSON.parse(JSON.stringify(app.leaveByDate())), { '2026-01-09': { LA: 8 }, '2026-01-12': { LS: 4, LA: 2 } });
});

test('tracker_summary tells the assistant about recent and upcoming out-of-office days', () => {
  const s = withState(app);
  s.away = [{ id: 'a', kind: 'annual', start: '2099-07-01', end: '2099-07-03', note: 'Vacation' }, { id: 'old', kind: 'travel', start: '2000-01-01', end: '', note: '' }];
  assert.deepEqual(JSON.parse(app.trackerSummary()).outOfOffice, [{ type: 'Annual leave', from: '2099-07-01', to: '2099-07-03', note: 'Vacation' }]);
});
