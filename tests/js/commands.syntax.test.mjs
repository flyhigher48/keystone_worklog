// Slash commands: the syntax (dates, ranges, hours, money, splitting, tokens) and the name resolver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, parseRange, parseHours, parseMoney, parsePercent, splitChain, splitPipe, splitOn, tokenize, parseCommand, takeDate, takeRange } from '../../keystone_worklog/static/commands/syntax.js';
import { resolve, score } from '../../keystone_worklog/static/commands/resolve.js';

const T = '2026-11-11';  // a Wednesday

test('dates: words, offsets, weekdays (past or future), month-days and year rollover', () => {
  const cases = [
    ['today', '2026-11-11'], ['yesterday', '2026-11-10'], ['tmrw', '2026-11-12'], ['+3d', '2026-11-14'], ['-2d', '2026-11-09'], ['+1w', '2026-11-18'],
    ['2026-11-03', '2026-11-03'], ['2026-02-30', ''], ['11/3', '2026-11-03'], ['nov 3', '2026-11-03'], ['3 nov', '2026-11-03'], ['november 20', '2026-11-20'],
    ['fri', '2026-11-13'], ['wed', '2026-11-18'], ['friday', '2026-11-13'], ['last fri', '2026-11-06'], ['next mon', '2026-11-16'], ['this mon', '2026-11-09'],
    ['jan 5', '2027-01-05'], ['bogus', ''], ['', ''], ['12', ''],
  ];
  for (const [v, want] of cases) assert.equal(parseDate(v, T), want, v);
  assert.equal(parseDate('mon', T, { prefer: 'past' }), '2026-11-09');
  assert.equal(parseDate('wed', T, { prefer: 'past' }), '2026-11-11', 'the past includes today');
  assert.equal(parseDate('dec 5', T, { prefer: 'past' }), '2026-12-05', 'within a month either way stays this year');
  assert.equal(parseDate('dec 20', T, { prefer: 'past' }), '2025-12-20', 'further ahead than that is last year');
  assert.equal(parseDate('dec 5', '2027-01-03', { prefer: 'past' }), '2026-12-05');
  assert.equal(parseDate('dec 30', '2026-01-10', { prefer: 'past' }), '2025-12-30');
});

test('ranges: a..b, weekday ends, this/last week and pay periods', () => {
  const ps = d => (d < '2026-11-08' ? '2026-10-25' : '2026-11-08');
  assert.deepEqual(parseRange('mon..fri', T), { from: '2026-11-09', to: '2026-11-13' });
  assert.deepEqual(parseRange('fri..mon', T, { prefer: 'future' }), { from: '2026-11-13', to: '2026-11-16' });
  assert.deepEqual(parseRange('nov 17..nov 28', T), { from: '2026-11-17', to: '2026-11-28' });
  assert.deepEqual(parseRange('this week', T), { from: '2026-11-08', to: '2026-11-14' });
  assert.deepEqual(parseRange('last week', T), { from: '2026-11-01', to: '2026-11-07' });
  assert.deepEqual(parseRange('this period', T, { periodStart: ps, periodLen: 14 }), { from: '2026-11-08', to: '2026-11-21' });
  assert.deepEqual(parseRange('last period', T, { periodStart: ps, periodLen: 14 }), { from: '2026-10-25', to: '2026-11-07' });
  assert.equal(parseRange('nov 28..nov 17', T), null);
  assert.equal(parseRange('whenever', T), null);
});

test('hours, money and percent', () => {
  for (const [v, want] of [['2h', 2], ['1.5h', 1.5], ['90m', 1.5], ['2:30', 2.5], ['2h30', 2.5], ['2h30m', 2.5], ['3 hours', 3], ['2', null], ['2x', null]]) assert.equal(parseHours(v), want, v);
  assert.equal(parseHours('2.25', { bare: true }), 2.25);
  for (const [v, want] of [['$4k', 4000], ['$4,000', 4000], ['4000$', 4000], ['$1.2m', 1200000], ['4000', null]]) assert.equal(parseMoney(v), want, v);
  assert.equal(parsePercent('50%'), 50); assert.equal(parsePercent('150%'), null);
});

test('splitting: chains, pipes and separators respect quotes and [[links]]', () => {
  assert.deepEqual(splitChain('/todo a ; /todo "b; c"\n/log 2h #x then /today'), ['/todo a', '/todo "b; c"', '/log 2h #x', '/today']);
  assert.deepEqual(splitChain('/note we will then go'), ['/note we will then go'], '"then" only splits before another command');
  assert.deepEqual(splitPipe('/find "a|b" | append [[x|y]]'), ['/find "a|b"', 'append [[x|y]]']);
  assert.deepEqual(splitOn('note :: text with :: inside', '::'), ['note ', ' text with ', ' inside']);
});

test('tokens: quotes, links, key:value, #tags, @people, ::text and -> changes', () => {
  assert.deepEqual(tokenize('a "b c" [[d e]] x\\ y'), [{ v: 'a', q: false }, { v: 'b c', q: true }, { v: '[[d e]]', q: false }, { v: 'x y', q: false }]);
  const p = parseCommand('/task 12 50% plan:"Girder Bridge" @Maria[50%] @"Sam Lee" #bridge #"CR 12" due:nov 20 reason:"two words" :: tail text -> due:+7d done');
  assert.equal(p.cmd, 'task');
  assert.deepEqual(p.words.map(w => w.v), ['12', '50%']);
  assert.deepEqual(p.kv, { plan: 'Girder Bridge', due: 'nov 20', reason: 'two words' });
  assert.deepEqual(p.people, ['Maria[50%]', 'Sam Lee']);
  assert.deepEqual(p.tags, ['bridge', 'CR 12']);
  assert.equal(p.tail, 'tail text');
  assert.deepEqual(p.changes.kv, { due: '+7d' });
  assert.deepEqual(p.changes.words.map(w => w.v), ['done']);
  assert.equal(parseCommand('no slash'), null);
  assert.deepEqual(parseCommand('/note 10:30 call http://x.y').words.map(w => w.v), ['10:30', 'call', 'http://x.y'], 'times and links are not keys');
});

test('takeDate and takeRange pull dates out of words', () => {
  const w = s => tokenize(s);
  const d = takeDate(w('2h girder last fri'), T, { prefer: 'past' });
  assert.equal(d.date, '2026-11-06'); assert.deepEqual(d.words.map(x => x.v), ['2h', 'girder']);
  assert.equal(takeDate(w('8 hours'), T).date, '', 'a bare number is not a date');
  const r = takeRange(w('8h mon..fri all'), T);
  assert.deepEqual(r.range, { from: '2026-11-09', to: '2026-11-13' }); assert.deepEqual(r.words.map(x => x.v), ['8h', 'all']);
  assert.deepEqual(takeRange(w('nov 17 .. nov 28'), T).range, { from: '2026-11-17', to: '2026-11-28' });
});

test('resolver: exact, prefix, words, spelling; a tie is never guessed', () => {
  const items = ['Girder Bridge rehab', 'Bridge deck inspection', 'CR 12 widening', 'Admin'];
  assert.deepEqual(resolve('admin', items), { item: 'Admin' });
  assert.deepEqual(resolve('cr12', items), { item: 'CR 12 widening' });
  assert.deepEqual(resolve('girder', items), { item: 'Girder Bridge rehab' });
  assert.deepEqual(resolve('deck insp', items), { item: 'Bridge deck inspection' });
  assert.deepEqual(resolve('girdr', items).item, 'Girder Bridge rehab', 'a typo in one word');
  assert.deepEqual(resolve('bridge', items).choices.sort(), ['Bridge deck inspection', 'Girder Bridge rehab']);
  assert.ok(resolve('zzz', items).none);
  const demo = ['Girder Bridge rehab', 'Runway lighting', 'Culvert C-12 replacement'];
  assert.deepEqual(resolve('r', demo).choices.sort(), ['Culvert C-12 replacement', 'Girder Bridge rehab', 'Runway lighting'], 'one letter that starts a later word is as good as the first');
  assert.deepEqual(resolve('run', demo), { item: 'Runway lighting' });
  assert.deepEqual(resolve('a', ['A', 'A']).choices, ['A', 'A'], 'two exact matches are a tie');
  assert.ok(score('Girder', 'Girder Bridge rehab') > score('Girder', 'Bridge deck inspection'));
});
