// Slash commands: what each command turns into. The golden table lists input → the tool calls it makes; a changed row is
// a deliberate change of behaviour. Today is Wed 2026-11-11 (see commands_ctx.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeCtx, build, toolsOf, heading, TODAY_MD } from './commands_ctx.mjs';
import { sectionLines, sectionItems, sectionEdit, actionItems, classify, all, expandRoutine } from '../../keystone_worklog/static/commands/registry.js';

const TODAY_H = heading('2026-11-11');
const GOLDEN = [
  // timesheet
  ['/log 2h #girder', [['update_timesheet', { entries: [{ date: '2026-11-11', project: 'Girder Bridge rehab', code: 'RG', hours: 2, mode: 'add' }] }]]],
  ['/log 1.5h #cr12 yesterday', [['update_timesheet', { entries: [{ date: '2026-11-10', project: 'CR 12 widening', code: 'RG', hours: 1.5, mode: 'add' }] }]]],
  ['/log 90m girder mon', [['update_timesheet', { entries: [{ date: '2026-11-09', project: 'Girder Bridge rehab', code: 'RG', hours: 1.5, mode: 'add' }] }]]],
  ['/log 2h #girder, 1.5h #cr12 yesterday', [['update_timesheet', { entries: [
    { date: '2026-11-10', project: 'Girder Bridge rehab', code: 'RG', hours: 2, mode: 'add' }, { date: '2026-11-10', project: 'CR 12 widening', code: 'RG', hours: 1.5, mode: 'add' }] }]]],
  ['/log 2h #girder mon, 1h #admin', [['update_timesheet', { entries: [
    { date: '2026-11-09', project: 'Girder Bridge rehab', code: 'RG', hours: 2, mode: 'add' }, { date: '2026-11-11', project: 'Admin', code: 'RG', hours: 1, mode: 'add' }] }]]],
  ['/log 8h #girder sat..mon', [['update_timesheet', { entries: [{ date: '2026-11-09', project: 'Girder Bridge rehab', code: 'RG', hours: 8, mode: 'add' }] }]]],
  ['/log 8h #girder sat..mon all', [['update_timesheet', { entries: ['2026-11-07', '2026-11-08', '2026-11-09'].map(date => ({ date, project: 'Girder Bridge rehab', code: 'RG', hours: 8, mode: 'add' })) }]]],
  ['/log 8h code:LA fri', [['update_timesheet', { entries: [{ date: '2026-11-06', code: 'LA', hours: 8, mode: 'add' }] }]]],
  ['/log 2h #admin ts', [['update_timesheet', { entries: [{ date: '2026-11-11', project: 'Admin', code: 'RG', ts: true, hours: 2, mode: 'add' }] }]]],
  ['/log day #girder', [['update_timesheet', { entries: [{ date: '2026-11-11', project: 'Girder Bridge rehab', code: 'RG', hours: 5, mode: 'add' }] }]]],
  ['/log day 60% #girder 40% #cr12', [['update_timesheet', { entries: [{ date: '2026-11-11', project: 'Girder Bridge rehab', code: 'RG', hours: 3, mode: 'add' }, { date: '2026-11-11', project: 'CR 12 widening', code: 'RG', hours: 2, mode: 'add' }] }]]],
  ['/log day usual yesterday', [['update_timesheet', { entries: [{ network: '4021', activity: '0010', code: 'RG', hours: 6, date: '2026-11-10', mode: 'add' }, { network: '9000', activity: '0001', code: 'RG', hours: 2, date: '2026-11-10', mode: 'add' }] }]]],
  // Today.md
  ['/note Called Sam', [['append_to_note', { path: 'Today.md', under_heading: TODAY_H, text: '- 10:00 Called Sam' }]]],
  ['/todo Send photos due:fri', [['append_to_note', { path: 'Today.md', under_heading: TODAY_H, text: '- [ ] Send photos due:fri' }]]],
  ['/append today :: Site visit went well', [['append_to_note', { path: 'Today.md', under_heading: TODAY_H, text: 'Site visit went well' }]]],
  ['/undone 3', [['edit_note', { path: 'Today.md', old_text: `## ${TODAY_H}\n- 09:00 Called the county about drainage #bridge\n- [ ] Send site photos 📅 2026-11-13\n- [x] Review calcs`,
    new_text: `## ${TODAY_H}\n- 09:00 Called the county about drainage #bridge\n- [ ] Send site photos 📅 2026-11-13\n- [ ] Review calcs` }]]],
  // notes
  ['/new "Pad memo" tpl:meeting in:Work', [['create_note', { path: 'Work/Pad memo.md', content: '# Pad memo\n\nDate: 2026-11-11\n' }]]],
  ['/new Ideas for Q1', [['create_note', { path: 'Ideas for Q1.md', content: '# Ideas for Q1\n\n' }]]],
  ['/meeting #girder', [['create_note', { path: 'Projects/Bridge/2026-11-11 Girder Bridge rehab meeting.md', content: '# 2026-11-11 Girder Bridge rehab meeting\n\nDate: 2026-11-11\n\nProject: [[Bridge rehab]]\n' }]]],
  ['/append "County meeting" :: - Who owns drainage?', [['append_to_note', { path: 'Work/County meeting.md', text: '- Who owns drainage?' }]]],
  ['/append "Bridge rehab" under:Log :: - new', [['append_to_note', { path: 'Projects/Bridge/Bridge rehab.md', text: '- new', under_heading: 'Log' }]]],
  ['/replace "County meeting" :: Send minutes => Send the minutes', [['edit_note', { path: 'Work/County meeting.md', old_text: 'Send minutes', new_text: 'Send the minutes' }]]],
  ['/move "County meeting" to Archive/2026', [['move_files', { moves: [{ from: 'Work/County meeting.md', to: 'Archive/2026/' }] }]]],
  ['/rename [[County meeting]] to County mtg', [['move_note', { from_path: 'Work/County meeting.md', to_path: 'Work/County mtg.md' }]]],
  // board
  ['/card Write the memo #cr12 due:fri', [['add_deliverable', { title: 'Write the memo', due: '2026-11-13', project: 'CR 12 widening' }]]],
  ['/card Survey status:doing', [['add_deliverable', { title: 'Survey', status: 'doing' }]]],
  ['/card pad design done', [['update_deliverable', { id: 'd1', status: 'done' }]]],
  ['/card "Pad design memo" due:+3d title:"Pad memo v2"', [['update_deliverable', { id: 'd1', due: '2026-11-14', title: 'Pad memo v2' }]]],
  ['/card 60% plans due:none', [['update_deliverable', { id: 'd2', due: '' }]]],
  ['/card old card remove', [['remove_deliverable', { id: 'd4' }]]],
  ['/cards overdue -> due:+7d', [['update_deliverable', { id: 'd1', due: '2026-11-18' }]]],
  ['/cards #girder -> blocked', [['update_deliverable', { id: 'd1', status: 'blocked' }], ['update_deliverable', { id: 'd2', status: 'blocked' }]]],
  // follow-ups
  ['/fu Maria – Pad drawings due:mon #girder', [['add_followup', { from: 'Maria', subject: 'Pad drawings', due: '2026-11-16', project: 'Girder Bridge rehab' }]]],
  ['/fu County: Drainage memo', [['add_followup', { from: 'County', subject: 'Drainage memo', due: '2026-11-13' }]]],
  ['/fu bearing pad done', [['update_followup', { id: 'f1', status: 'done' }]]],
  ['/fu drainage comments due:fri', [['update_followup', { id: 'f2', due: '2026-11-13' }]]],
  ['/fus overdue -> due:tomorrow', [['update_followup', { id: 'f1', due: '2026-11-12' }]]],
  ['/fus all -> waiting', [['update_followup', { id: 'f1', status: 'waiting' }], ['update_followup', { id: 'f2', status: 'waiting' }]]],
  // plan
  ['/task 12 50%', [['update_tasks', { changes: [{ task: '12', percent: 50 }] }]]],
  ['/task 12 +2d', [['update_tasks', { changes: [{ task: '12', start: '2026-11-18' }] }]]],
  ['/task 7 -1d plan:girder', [['update_tasks', { plan: 'girder', changes: [{ task: '7', start: '2026-11-08' }] }]]],
  ['/task 12 3d finish:fri deadline:12/20', [['update_tasks', { changes: [{ task: '12', duration: '3d', finish: '2026-11-13', deadline: '2026-12-20' }] }]]],
  ['/task 12 @Maria[50%] @"Sam Lee" after:7SS+2d', [['update_tasks', { changes: [{ task: '12', predecessors: '7SS+2d', people: 'Maria[50%], Sam Lee' }] }]]],
  ['/task 12 hours:40 budget:$4k', [['update_tasks', { changes: [{ task: '12', hours: 40, budget: 4000 }] }]]],
  ['/task 12 milestone', [['update_tasks', { changes: [{ task: '12', duration: '0' }] }]]],
  ['/tasks late -> 100%', [['update_tasks', { changes: [{ task: '7', percent: 100 }, { task: '12', percent: 100 }] }]]],
  ['/addtask "Pad design" 3d after:7 under:4 @Maria', [['add_tasks', { tasks: [{ name: 'Pad design', duration: '3d', after: '7', depends_on: ['7'], parent: '4', people: 'Maria' }] }]]],
  ['/addtask Agency review', [['add_tasks', { tasks: [{ name: 'Agency review', duration: '1d' }] }]]],
  ['/milestone "60% plans" dec 12', [['add_tasks', { tasks: [{ name: '60% plans', duration: '0' }] }], ['update_tasks', { changes: [{ task: '60% plans', start: '2026-12-12' }] }]]],
  ['/risk Pad delivery slips p:3 i:4 @Sam', [['add_raid_item', { kind: 'risk', title: 'Pad delivery slips', owner: 'Sam', probability: 3, impact: 4 }]]],
  ['/action Send revised calcs @Sam due:fri', [['add_raid_item', { kind: 'action', title: 'Send revised calcs', owner: 'Sam', due: '2026-11-13' }]]],
  ['/decision Use elastomeric pads', [['add_raid_item', { kind: 'decision', title: 'Use elastomeric pads' }]]],
  ['/close-week amber schedule:red reason:"FE model late"', [['close_week', { overall: 'amber', schedule: 'red', reasons: { overall: 'FE model late' } }]]],
  ['/update win County approved the plans', [['add_log_entry', { kind: 'win', text: 'County approved the plans', internal: false }]]],
  ['/update Supplier is late internal', [['add_log_entry', { kind: 'update', text: 'Supplier is late', internal: true }]]],
];

test('golden table: each command → the tool calls it makes', async () => {
  for (const [input, want] of GOLDEN) {
    const plan = await build(input);
    assert.ok(!plan.error, `${input}: ${plan.error}`);
    assert.deepEqual(JSON.parse(JSON.stringify(toolsOf(plan))), want, input);
  }
});

test('reads make no tool calls; they read and show a card', async () => {
  for (const input of ['/today', '/today yesterday', '/find bearing', '/grep TBD', '/recent 3d', '/hours week', '/left', '/leave', '/budget', '/briefme', '/cards overdue', '/fus', '/todos overdue',
    '/plans', '/late', '/critical', '/cost', '/portfolio', '/status', '/free nov 17..nov 28', '/whatif 12 +5d', '/help', '/help log', '/routines', '/actions "County meeting"', '/backlinks "Bridge rehab"']) {
    const plan = await build(input);
    assert.ok(!plan.error, `${input}: ${plan.error}`);
    assert.deepEqual(toolsOf(plan), [], input);
  }
});

test('mistakes are caught before anything runs, with fixes to click', async () => {
  const cases = [
    ['/log 2h #bridge', /matches 2 projects/], ['/log #girder', /How many hours/], ['/log 2h', /Which project/], ['/log 2h #zzz', /No project matches/],
    ['/log 2h #girder code:XX', /RG, LA, LS or LH/], ['/log 30h #girder', /too many hours/], ['/log day usual', /already has 3 h/],
    ['/todo', /What is the todo/], ['/todo x due:someday', /isn't a date/], ['/done 1', /isn't a checkbox/], ['/done zebra', /No open item/], ['/done', /Which item/],
    ['/carry from:2026-11-11', /That is today/], ['/append "County meeting"', /Append what/], ['/replace x :: a', /old text => new text/],
    ['/card', /Which card/], ['/cards overdue -> ', /Which changes/], ['/fu just a subject', /\/fu <from> – <subject>/], ['/task 12', /Which change/], ['/task 50%', /Which task/],
    ['/task 12 sideways', /don't know what “sideways”/], ['/close-week purple', /Which colour/], ['/go nowhere', /No tab matches/], ['/theme blue', /light or \/theme dark/], ['/open zzzz qqq', /No file matches/],
  ];
  for (const [input, rx] of cases) {
    const plan = await build(input);
    assert.ok(plan.error, `${input} should fail`);
    assert.match(plan.error, rx, input);
  }
  const amb = await build('/log 2h #bridge');
  assert.deepEqual(amb.choices.map(c => c.cmd), ['/log 2h #"Girder Bridge rehab"', '/log 2h #"Bridge deck inspection"']);
  assert.deepEqual(JSON.parse(JSON.stringify(toolsOf(await build(amb.choices[0].cmd))))[0][1].entries[0].project, 'Girder Bridge rehab', 'the fix runs');
});

test('plan commands ask which plan when several exist and none is open', async () => {
  const ctx = fakeCtx({ openPlan: '' });
  const r = await build('/tasks late -> +2d', ctx);
  assert.equal(r.error, 'Which plan?');
  assert.deepEqual(r.choices.map(c => c.cmd), ['/tasks late plan:"Girder Bridge" -> +2d', '/tasks late plan:"CR 12" -> +2d']);
  assert.deepEqual(toolsOf(await build(r.choices[1].cmd, ctx))[0][1].plan, 'CR 12');
  assert.ok(!(await build('/task 12 50% plan:girder', ctx)).error);
});

test('Today.md: sections, items and exact edits from the heading down', () => {
  const sec = sectionLines(TODAY_MD, TODAY_H);
  assert.equal(sec.lines[sec.start], `## ${TODAY_H}`);
  const items = sectionItems(sec);
  assert.deepEqual(items.map(x => [x.n, x.box, x.text]), [[1, null, '09:00 Called the county about drainage #bridge'], [2, ' ', 'Send site photos 📅 2026-11-13'], [3, 'x', 'Review calcs'], [4, ' ', 'Reply to Maria: Bearing pad submittal']]);
  const e = sectionEdit(sec, { [items[1].i]: '- [x] Send site photos 📅 2026-11-13' });
  assert.equal(e.old_text.split('\n').length, 3);
  assert.ok(TODAY_MD.includes(e.old_text) && TODAY_MD.indexOf(e.old_text) === TODAY_MD.lastIndexOf(e.old_text), 'the edit matches exactly once');
  assert.equal(sectionLines(TODAY_MD, 'Nope'), null);
  const fenced = sectionLines('## A\n```\n## B\n- x\n```\n- y\n## C\n- z', 'A');
  assert.deepEqual(sectionItems(fenced).map(x => x.text), ['y'], 'headings and items inside code fences are ignored');
});

test('/done ticks by number, several numbers, or text; /carry marks and copies', async () => {
  const one = toolsOf(await build('/done 2'))[0][1];
  assert.match(one.new_text, /- \[x\] Send site photos/);
  const two = toolsOf(await build('/done 2, 4'))[0][1];
  assert.match(two.new_text, /- \[x\] Send site photos[\s\S]*- \[x\] Reply to Maria/);
  assert.match(toolsOf(await build('/done maria'))[0][1].new_text, /- \[x\] Reply to Maria/);
  const carry = toolsOf(await build('/carry'));
  assert.deepEqual(carry.map(c => c[0]), ['edit_note', 'append_to_note']);
  assert.equal(carry[0][1].new_text, `## ${heading('2026-11-09')}\n- [ ] Order pads → carried`, 'already-carried items are not carried again');
  assert.equal(carry[1][1].text, '- [ ] Order pads');
});

test('/file-today sorts lines without guessing', () => {
  const ctx = fakeCtx(), items = sectionItems(sectionLines(TODAY_MD, TODAY_H)), rows = items.map(x => classify(x, ctx));
  assert.deepEqual(rows.map(r => r.kind), ['ask', 'card', 'ask', 'followup'], '#bridge matches two projects, so that line is not filed by guess');
  assert.equal(rows[1].due, '2026-11-13');
  assert.deepEqual([rows[3].from, rows[3].subject], ['Maria', 'Bearing pad submittal']);
  const tagged = classify({ text: 'Called the county #girder', box: null }, ctx);
  assert.equal(tagged.kind, 'note'); assert.equal(tagged.proj.id, 'p1');
});

test('action items, pipes into /todo, /append and /card, and routines', async () => {
  assert.deepEqual(actionItems('- [ ] Send minutes\nAction: Sam to check pads\n- [x] done\nTODO: update\n```\n- [ ] no\n```'), ['Send minutes', 'Sam to check pads', 'update']);
  const notes = { type: 'notes', items: [{ path: 'Work/County meeting.md' }, { path: 'Projects/Bridge/Bridge rehab.md' }] };
  assert.equal(toolsOf(await build('/todo', fakeCtx(), notes))[0][1].text, '- [ ] Review [[County meeting]]\n- [ ] Review [[Bridge rehab]]');
  assert.equal(toolsOf(await build('/append "County meeting"', fakeCtx(), notes))[0][1].text, '- [[County meeting]]\n- [[Bridge rehab]]');
  const lines = { type: 'lines', items: ['Send minutes', 'Check pads'] };
  assert.deepEqual(toolsOf(await build('/card #girder due:fri', fakeCtx(), lines)).map(c => c[1]), [
    { title: 'Send minutes', due: '2026-11-13', project: 'Girder Bridge rehab' }, { title: 'Check pads', due: '2026-11-13', project: 'Girder Bridge rehab' }]);
  assert.deepEqual(toolsOf(await build('/move Archive', fakeCtx(), notes))[0][1].moves.map(m => m.from), ['Work/County meeting.md', 'Projects/Bridge/Bridge rehab.md']);
  assert.deepEqual(expandRoutine({ lines: ['/log day {1|usual}', '/x {2}'] }, ['#girder']), ['/log day #girder', '/x']);
  assert.deepEqual(expandRoutine({ lines: ['/log day {1|usual}'] }, []), ['/log day usual']);
  const names = all(fakeCtx()).map(c => c.name);
  assert.ok(names.includes('eod') && names.includes('log'), 'routines are listed with the commands');
  assert.equal(new Set(names).size, names.length, 'command names are unique');
});

test('every command has a signature, help and examples that parse', async () => {
  for (const c of all(fakeCtx())) {
    assert.ok(c.sig && c.help && (c.examples || []).length, c.name);
    for (const e of c.examples) assert.match(e.split('|')[0].trim(), /^\/[\w-]/, `${c.name}: ${e}`);
  }
});
