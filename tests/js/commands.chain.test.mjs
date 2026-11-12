// Slash commands: running lines – chains, pipes, $, routines, the combined preview, stopping, Undo all – and plain text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx } from './commands_ctx.mjs';
import { run, expand } from '../../keystone_worklog/static/commands/chain.js';
import { ruleMatch, route, guessCommand, splitParts, isRead, PHRASES } from '../../keystone_worklog/static/commands/router.js';
import { all } from '../../keystone_worklog/static/commands/registry.js';

const tools = ctx => ctx.calls.filter(c => c.name).map(c => c.name);

test('a single change asks once (the tool card); Today.md lines go straight in', async () => {
  const ctx = fakeCtx();
  await run('/log 2h #girder', ctx);
  assert.deepEqual(ctx.calls.map(c => [c.name, c.apply]), [['update_timesheet', false]], 'false = the tool shows its own Apply/Reject');
  const ctx2 = fakeCtx();
  await run('/todo Call Sam', ctx2);
  assert.deepEqual(ctx2.calls.filter(c => c.name).map(c => [c.name, c.apply]), [['append_to_note', true]]);
  const ctx3 = fakeCtx({ commandSettings: { confirm: 'never' } });
  await run('/log 2h #girder', ctx3);
  assert.equal(ctx3.calls[0].apply, true);
});

test('a chain is checked first, shown once, then run in order', async () => {
  const ctx = fakeCtx();
  const r = await run('/todo A ; /log 2h #girder\n/card New card #cr12', ctx);
  assert.ok(r.ok);
  const preview = ctx.shown.find(c => c.rows);
  assert.equal(preview.rows.length, 3); assert.ok(preview.decided);
  assert.deepEqual(ctx.calls.filter(c => c.name).map(c => [c.name, c.apply]), [['append_to_note', true], ['update_timesheet', true], ['add_deliverable', true]]);
  assert.ok(ctx.shown.some(c => c.actions && c.actions[0].label === 'Undo all' && c.actions[0].undo.join() === 'id3,id2,id1'), 'Undo all, newest first');
});

test('a mistake anywhere stops the chain before anything is written', async () => {
  const ctx = fakeCtx();
  const r = await run('/todo A ; /log 2h #nowhere ; /todo B', ctx);
  assert.ok(r.error);
  assert.deepEqual(tools(ctx), []);
  assert.match(ctx.shown.at(-1).title, /^Step 2 \(\/log 2h #nowhere\): No project matches/);
  const amb = fakeCtx();
  await run('/todo A ; /log 2h #bridge', amb);
  assert.deepEqual(amb.shown.at(-1).choices.map(c => c.cmd), ['/todo A ; /log 2h #"Girder Bridge rehab"', '/todo A ; /log 2h #"Bridge deck inspection"'], 'the fixes keep the rest of the chain');
});

test('rejecting the preview runs nothing; a failure mid-way stops the rest', async () => {
  const no = fakeCtx({ decide: false });
  await run('/todo A ; /log 2h #girder', no);
  assert.deepEqual(tools(no), []);
  const fail = fakeCtx({ runTool: name => (name === 'update_timesheet' ? { text: 'Error: period is locked', state: 'error' } : null) });
  const r = await run('/todo A ; /log 2h #girder ; /todo B', fail);
  assert.equal(r.error, 'period is locked');
  assert.deepEqual(tools(fail), ['append_to_note', 'update_timesheet']);
  assert.match(fail.shown.find(c => c.error).title, /Step 2 .*period is locked Nothing after it ran/);
});

test('bulk changes always show their rows, even with confirm "never"; unticked rows are skipped', async () => {
  const ctx = fakeCtx({ commandSettings: { confirm: 'never' } });
  ctx.chat.decide = async c => { c.rows[1].on = false; return true; };
  await run('/cards #girder -> done', ctx);
  assert.deepEqual(ctx.calls.filter(c => c.name).map(c => c.args), [{ id: 'd1', status: 'done' }]);
});

test('pipes pass a list on; $ is what the previous command made', async () => {
  const ctx = fakeCtx({ read: (name) => (name === 'search_notes' ? { result: '2 hits', data: [{ path: 'Work/County meeting.md', heading: '', text: '' }, { path: 'Projects/Bridge/Bridge rehab.md', heading: '', text: '' }] } : { data: [] }) });
  await run('/find drainage | append today', ctx);
  const add = ctx.calls.find(c => c.name === 'append_to_note');
  assert.equal(add.args.text, '- [[County meeting]]\n- [[Bridge rehab]]');
  const ctx2 = fakeCtx();
  await run('/new "Pad memo" in:Work ; /append $ :: Started', ctx2);
  assert.deepEqual(ctx2.calls.filter(c => c.name).map(c => [c.name, c.args.path]), [['create_note', 'Work/Pad memo.md'], ['append_to_note', 'Work/Pad memo.md']]);
  const bad = fakeCtx();
  assert.ok((await run('/today | log', bad)).error, '/log takes no list');
  assert.match(bad.shown.at(-1).title, /can't take a list/);
});

test('routines expand (with arguments and optional lines) and run as one chain', async () => {
  const ctx = fakeCtx();
  assert.deepEqual(expand('/eod #girder', ctx).segs, ['?/log day #girder', '/today']);
  assert.deepEqual(expand('/run eod', ctx).segs, ['?/log day usual', '/today']);
  assert.match(expand('/run nope', ctx).error, /no routine called “nope”/);
  await run('/eod', ctx);  // today already has 3 h, so "/log day usual" doesn't apply: skipped, /today still runs
  assert.ok(ctx.shown.some(c => /^Skipped \/log/.test(c.title)));
  assert.deepEqual(tools(ctx), []);
  const loop = fakeCtx({ routines: { ping: { lines: ['/pong'] }, pong: { lines: ['/ping'] } } });
  assert.match(expand('/ping', loop).error, /too deeply/);
  const two = fakeCtx();
  await run('/two', two);
  assert.deepEqual(tools(two), ['append_to_note', 'append_to_note']);
});

test('unknown commands suggest the nearest ones', async () => {
  const ctx = fakeCtx();
  await run('/lgo 2h #girder', ctx);
  assert.match(ctx.shown[0].title, /There is no \/lgo/);
  assert.equal(ctx.shown[0].choices[0].cmd, '/log 2h #girder');
});

test('plain text, stage 1: rules rewrite common phrasings into commands', () => {
  const ctx = fakeCtx();
  const rows = [
    ['log 2 hours to girder yesterday', '/log 2h #girder yesterday'], ['worked 3 hours on cr12', '/log 3h #cr12'], ['brief me', '/briefme'], ["what's overdue?", '/cards overdue'],
    ['remind me to call Sam', '/todo call Sam'], ['find notes about bearing pads', '/find bearing pads'], ['file my inbox', '/inbox'], ['how much annual leave do I have', '/leave'],
    ['mark pad design memo as done', '/card "pad design memo" done'], ['set task 12 to 50%', '/task 12 50%'], ['which tasks are late', '/late'], ['carry over my todos', '/carry'],
    ['open load check', '/open load check'], ['reply to Maria about the submittal', '/fu Maria – the submittal'], ['write my weekly status report', '/weekly'],
  ];
  for (const [text, want] of rows) assert.equal(ruleMatch(text, ctx), want, text);
  assert.equal(ruleMatch('what is the meaning of life', ctx), null);
});

test('plain text: confident reads run, writes are only suggested, several requests become a chain', async () => {
  const ctx = fakeCtx();
  assert.deepEqual(await route('brief me', ctx), { kind: 'run', cmd: '/briefme', via: 'rule' });
  assert.equal((await route('log 2h to girder', ctx)).kind, 'suggest');
  assert.deepEqual(await route('log 2h to girder and then remind me to call Sam', ctx), { kind: 'chain', cmds: ['/log 2h #girder', '/todo call Sam'] });
  assert.equal((await route('what is the meaning of life', ctx)).kind, 'none', 'no model to match meaning with');
  assert.deepEqual(splitParts('a; b\nc and then d, then e'), ['a', 'b', 'c', 'd', 'e']);
  assert.ok(isRead('/cards overdue') && !isRead('/cards overdue -> done') && !isRead('/log 2h #x') && !isRead('/find x | append today'));
});

test('plain text, stage 2: the closest example sentence picks the command (stub embedding)', async () => {
  const vocab = [...new Set(Object.values(PHRASES).flat().join(' ').toLowerCase().match(/[a-z]+/g))];
  const vec = t => { const w = t.toLowerCase().match(/[a-z]+/g) || []; return vocab.map(v => w.filter(x => x === v).length); };
  const ctx = fakeCtx();
  Object.assign(ctx, { embedQuery: async t => vec(t), embedMany: async ts => ts.map(vec) });
  globalThis.localStorage ||= { getItem: () => null, setItem: () => {} };
  const r = await route('tell me my remaining sick leave balance', ctx);
  assert.ok(['suggest', 'choices'].includes(r.kind), 'meaning only ever suggests: ' + r.kind);
  assert.deepEqual(await route('tell me my remaining sick leave balance', ctx, { llm: true }), { kind: 'none', near: [] }, 'with a model, what no rule matches goes to the model');
  assert.equal(r.ranked[0].name, 'leave');
  assert.equal(guessCommand('log', 'put 3 hours on girder yesterday', ctx), '/log 3h #"Girder Bridge rehab" 2026-11-10');
  assert.equal(guessCommand('cards', "anything overdue on cr12?", ctx), '/cards overdue #"CR 12 widening"');
  for (const name of Object.keys(PHRASES)) assert.ok(all(ctx).some(c => c.name === name), `PHRASES names a real command: ${name}`);
});
