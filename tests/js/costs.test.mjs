// Team costs: reading ERP values, guessing columns, matching people and projects, rates and cost models,
// planned and actual cost on tasks, earned value and the RAG rules. 2026-10-19 is a Monday.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../keystone_worklog/static/planner/engine.js';
import * as C from '../../keystone_worklog/static/planner/costs.js';

const near = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('numbers the way ERPs and Excel write them', () => {
  assert.equal(C.parseNumber('1,234.50'), 1234.5);
  assert.equal(C.parseNumber('$1,234.50'), 1234.5);
  assert.equal(C.parseNumber('(1,234.50)'), -1234.5);
  assert.equal(C.parseNumber('1,234.50-'), -1234.5);   // SAP's trailing minus
  assert.equal(C.parseNumber('-8'), -8);
  assert.equal(C.parseNumber('1.234,50', true), 1234.5);
  assert.equal(C.parseNumber('USD 99'), 99);
  assert.equal(C.parseNumber(7.25), 7.25);
  for (const bad of ['', 'abc', '#N/A', '-', '1.2.3']) assert.equal(C.parseNumber(bad), null, bad);
});

test('dates in every common form, including Excel serial numbers', () => {
  assert.equal(C.parseDate('2026-10-19'), '2026-10-19');
  assert.equal(C.parseDate('10/19/2026'), '2026-10-19');
  assert.equal(C.parseDate('10/19/26'), '2026-10-19');
  assert.equal(C.parseDate('19/10/2026', 'dmy'), '2026-10-19');
  assert.equal(C.parseDate('19.10.2026', 'dmy'), '2026-10-19');
  assert.equal(C.parseDate('19-Oct-2026'), '2026-10-19');
  assert.equal(C.parseDate('Oct 19, 2026'), '2026-10-19');
  assert.equal(C.parseDate('Monday, October 19, 2026'), '2026-10-19');
  assert.equal(C.parseDate(46314), '2026-10-19');          // Excel's day number for 2026-10-19
  assert.equal(C.parseDate('46314'), '2026-10-19');
  assert.equal(C.parseDate('2/30/2026'), null);
  assert.equal(C.parseDate('Total'), null);
});

const HEAD = ['Posting Date', 'Work Date', 'Last Name', 'First Name', 'Employee ID', 'Hours', 'Pay Amount', 'Fringe Amount', 'Network', 'Activity', 'Pay Type', 'Cost Element', 'Doc No'];
const ROWS = [
  ['Labor distribution report – run 10/21/2026'], [],
  HEAD,
  ['10/18/2026', '10/14/2026', 'LOPEZ', 'MARIA', '00412873', '8', '520.00', '161.20', '4001234', '0010', 'RG', 'Labor', '1'],
  ['10/18/2026', '10/15/2026', 'Shah', 'Priya', '', '4', '230.00', '71.30', '4001234', '10', 'OT', 'Labor', '2'],
  ['10/18/2026', '10/14/2026', 'LOPEZ', 'MARIA', '00412873', '-8', '(520.00)', '161.20-', '4001234', '0010', 'RG', 'Labor', '3'],
  ['10/18/2026', '10/16/2026', '', '', '', '', '412.80', '', '4001234', '0010', '', 'Travel', '4'],
  ['', '', '', '', '', '4', '230', '', '', '', '', 'Total', ''],
  ['10/18/2026', 'soon', 'X', 'Y', '', '1', '1', '', '4001234', '0010', '', '', '5'],
];

test('the header row and columns are guessed; a layout survives reordered columns', () => {
  const hr = C.guessHeaderRow(ROWS);
  assert.equal(hr, 2);
  const map = C.guessMapping(ROWS[hr]);
  assert.deepEqual(map.date, [1]);
  assert.deepEqual(map.post, [0]);
  assert.deepEqual(map.person, [2, 3]);
  assert.deepEqual(map.emp, [4]);
  assert.deepEqual(map.hours, [5]);
  assert.deepEqual(map.pay, [6]);
  assert.deepEqual(map.fringe, [7]);
  assert.deepEqual(map.nwa, [8, 9]);
  assert.deepEqual(map.payType, [10]);
  assert.deepEqual(map.category, [11]);
  assert.deepEqual(map.doc, [12]);
  const layout = { fields: C.layoutFields(map, ROWS[hr]) };
  const shuffled = [...HEAD].reverse();
  const { map: m2, missing } = C.applyLayout(layout, shuffled);
  assert.deepEqual(missing, []);
  assert.deepEqual(m2.hours, [shuffled.indexOf('Hours')]);
  assert.ok(C.layoutFits(layout, shuffled));
  assert.ok(!C.layoutFits(layout, HEAD.slice(1)));
});

test('rows become charge lines: reversals kept, totals skipped, bad rows reported', () => {
  const map = C.guessMapping(ROWS[2]);
  const { lines, errors, skipped } = C.extractLines(ROWS, 2, map);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0], { row: 4, date: '2026-10-14', post: '2026-10-18', hours: 8, pay: 520, fringe: 161.2, name: 'LOPEZ MARIA', emp: '00412873', nwa: '4001234|0010', payType: 'RG', category: 'Labor', doc: '1' });
  assert.equal(lines[2].hours, -8); assert.equal(lines[2].pay, -520); assert.equal(lines[2].fringe, -161.2);
  assert.ok(!C.isLabor(lines[3]) && lines[3].pay === 412.8);
  assert.equal(skipped, 1);
  assert.deepEqual(errors, [{ row: 9, text: '“soon” isn\'t a date' }]);
});

const DIR = {
  people: [
    { id: 'pe_m', name: 'Maria Lopez', aliases: [], employeeId: '412873', category: 'Engineer III' },
    { id: 'pe_p', name: 'Priya Shah', aliases: ['SHAH P'], category: 'Engineer II' },
    { id: 'pe_s', name: 'Sam Ortiz' },
    { id: 'pe_me', name: 'Me', me: true },
  ],
  rates: [
    { who: 'pe_m', base: 62.5, from: '2026-01-04' }, { who: 'pe_m', base: 65, from: '2026-07-05' },
    { who: 'cat:Engineer II', base: 50, from: '2026-01-01' }, { who: 'default', base: 40 },
  ],
};

test('people are matched by employee ID, name in any order, or alias', () => {
  const ix = C.personIndex(DIR);
  assert.equal(C.matchPerson(ix, 'Somebody', '00412873').id, 'pe_m');
  assert.equal(C.matchPerson(ix, 'LOPEZ, MARIA').id, 'pe_m');
  assert.equal(C.matchPerson(ix, 'shah p').id, 'pe_p');
  assert.equal(C.matchPerson(ix, 'Nobody Here'), null);
});

test('projects are matched by network and activity, however they are written', () => {
  const P = [{ id: 'a', network: '4001234', activity: '0010' }, { id: 'b', network: '4001234', activity: '0020' }, { id: 'c', network: '4005678', activity: '0020' }];
  assert.equal(C.matchProject(P, '4001234|0010').id, 'a');
  assert.equal(C.matchProject(P, '4001234-10').id, 'a');
  assert.equal(C.matchProject(P, '4001234 / 0020').id, 'b');
  assert.equal(C.matchProject(P, '4005678').id, 'c');       // the network alone is enough when it's unique
  assert.equal(C.matchProject(P, '4001234'), null);         // …but not when two projects share it
  assert.equal(C.matchProject(P, '9999999|0010'), null);
});

test('rates are dated, with category, ERP-observed and default fallbacks', () => {
  const ix = C.personIndex(DIR), m = ix.byId.get('pe_m');
  assert.equal(C.rateFor(DIR, m, '2026-06-30').rate, 62.5);
  assert.equal(C.rateFor(DIR, m, '2026-07-05').rate, 65);   // the July raise
  assert.equal(C.rateFor(DIR, ix.byId.get('pe_p'), '2026-10-01').src, 'category');
  const obs = C.observedRates([{ name: 'Sam Ortiz', hours: 10, pay: 450, fringe: 135, date: '2026-10-01' }], ix);
  assert.deepEqual(C.rateFor(DIR, ix.byId.get('pe_s'), '2026-10-01', obs), { rate: 45, src: 'erp', fringeRatio: 0.3 });
  assert.deepEqual(C.rateFor(DIR, ix.byId.get('pe_s'), '2026-10-01'), { rate: 40, src: 'default' });
  assert.deepEqual(C.rateFor({ rates: [] }, null, '2026-10-01'), { rate: 0, src: null });
});

test('cost models: ERP pay + fringe + charges, or hours × rate', () => {
  const ix = C.personIndex(DIR), m = ix.byId.get('pe_m');
  const erp = { base: 'erp', fringePct: 30, adders: [{ name: 'Overhead', kind: 'pctBase', value: 100 }, { name: 'Service', kind: 'pctRunning', value: 10 }, { name: 'IT', kind: 'perHour', value: 2 }], payTypes: { OT: 1.5 }, nonLaborPct: 5 };
  const line = { date: '2026-10-14', hours: 8, pay: 500, fringe: 150, name: 'Maria Lopez' };
  const c = C.lineCost(line, { dir: DIR, model: erp, person: m });
  // 500 + 150 = 650; overhead 650 → 1300; service 10% → 1430; IT 8 × 2 → 1446
  near(c.total, 1446); assert.equal(c.adds.length, 3);
  near(C.lineCost({ ...line, fringe: undefined }, { dir: DIR, model: erp, person: m }).total, ((500 + 150) * 2 * 1.1) + 16);  // fringe % when there's no fringe column
  const rate = { ...erp, base: 'rate' };
  near(C.lineCost({ ...line, payType: 'OT' }, { dir: DIR, model: rate, person: m }).total, ((8 * 65 * 1.5) * 1.3 * 2 * 1.1) + 16);
  near(C.lineCost({ date: '2026-10-16', pay: 400 }, { dir: DIR, model: erp }).total, 420);   // travel: +5% non-labor
  const missing = C.lineCost({ date: '2026-10-14', hours: 2, name: 'X' }, { dir: { rates: [] }, model: rate, person: null });
  assert.ok(missing.missing && missing.pay === 0);   // flagged; only the per-hour charge is left
  near(C.hourlyCost({ dir: DIR, model: rate }, m, '2026-10-14').cost, (65 * 1.3 * 2 * 1.1) + 2);
  near(C.multiplier({ fringePct: 30, adders: [{ kind: 'pctBase', value: 100 }, { kind: 'pctRunning', value: 10 }] }), 2.86);
});

// a small plan on the standard calendar: A (3d, Maria) then B (2d, Priya + Maria half time); baseline saved
function bridge() {
  const cal = E.standardCalendar();
  const plan = {
    start: '2026-10-19T08:00', calendar: cal, units: E.DEFAULT_UNITS,
    tasks: [
      { uid: 1, name: 'Phase', parentUid: null },
      { uid: 2, name: 'A', parentUid: 1, duration: { minutes: 3 * 480, format: 'd' }, wbs: '1.1' },
      { uid: 3, name: 'B', parentUid: 1, duration: { minutes: 2 * 480, format: 'd' }, links: [{ pred: 2, type: 'FS', lag: { minutes: 0, format: 'd' } }] },
    ],
    resources: [{ uid: 1, name: 'Maria Lopez', personId: 'pe_m' }, { uid: 2, name: 'Priya Shah' }],
    assignments: [{ taskUid: 2, resourceUid: 1, units: 1 }, { taskUid: 3, resourceUid: 2, units: 1 }, { taskUid: 3, resourceUid: 1, units: 0.5 }],
  };
  return plan;
}
const RATE_MODEL = { base: 'rate', fringePct: 0, adders: [] };

test('planned cost is time-phased per person; a baseline keeps it', () => {
  const plan = bridge(), s = E.schedule(plan), ctx = C.planContext(plan, DIR, RATE_MODEL);
  const pc = C.plannedCost(plan, s, ctx);
  near(pc.byTask.get(2), 24 * 65);               // 3 days × 8 h × $65
  near(pc.byTask.get(3), 16 * 50 + 8 * 65);      // Priya 16 h × $50 (category) + Maria 8 h × $65
  near(pc.hoursByTask.get(3), 24);
  const sum = [...pc.byDay.values()].reduce((a, b) => a + b, 0);
  near(sum, 24 * 65 + 16 * 50 + 8 * 65);
  plan.tasks = E.setBaseline(plan, s, 0).tasks;
  C.baselineCosts(plan, s, ctx, 0);
  assert.equal(plan.tasks[1].baselines[0].cost, 1560);
  const roll = C.rollup(plan, s, pc.byTask);
  near(roll.get(1), 1560 + 1320);
});

test('actual charges go to the tasks that person was scheduled on that day', () => {
  const plan = bridge(), s = E.schedule(plan), ctx = C.planContext(plan, DIR, RATE_MODEL);
  const lines = [
    { date: '2026-10-19', hours: 8, name: 'LOPEZ, MARIA' },                // Maria on A
    { date: '2026-10-22', hours: 8, name: 'Maria Lopez' },                 // Maria (half time) on B
    { date: '2026-10-22', hours: 4, name: 'Shah Priya', task: '1.1' },     // the task column wins: A
    { date: '2026-10-21', hours: 2, name: 'Sam Ortiz' },                   // not on the plan: the NWA's tasks that day (A)
    { date: '2026-11-30', hours: 1, name: 'Sam Ortiz' },                   // nothing planned that day
  ];
  const a = C.allocateActuals(plan, s, ctx, lines);
  near(a.byTask.get(2).hours, 8 + 4 + 2);
  near(a.byTask.get(3).hours, 8);
  assert.equal(a.unassigned.length, 1);
  near(a.hours, 23);
  near(a.total, (16 * 65) + (4 * 50) + (3 * 40));  // Maria $65; Priya by category $50; Sam has no rate → default $40
});

test('earned value matches the textbook', () => {
  // BAC 1000, PV 500, EV 400, AC 450
  const m = C.evMetrics({ bac: 1000, pv: 500, ev: 400, ac: 450, etc: 700 });
  near(m.sv, -100); near(m.cv, -50); near(m.spi, 0.8); near(m.cpi, 400 / 450);
  near(m.eac, 450 + 600 / (400 / 450));   // 1125
  near(m.eacPlan, 1050); near(m.eacBottomUp, 1150); near(m.vac, -125); near(m.tcpi, 600 / 550);
});

test('earned value on a plan: baseline cost, % complete and the status date', () => {
  const plan = bridge(), ctx = C.planContext(plan, DIR, RATE_MODEL);
  let s = E.schedule(plan);
  plan.tasks = E.setBaseline(plan, s, 0).tasks;
  C.baselineCosts(plan, s, ctx, 0);
  plan.tasks[1].percent = 50;
  s = E.schedule(plan);
  const status = E.toMin('2026-10-20T17:00');   // 2 of A's 3 days
  const ev = C.earnedValue(plan, s, 0, status, 1200, 1500);
  assert.ok(ev.usedBaseline);
  near(ev.bac, 2880); near(ev.pv, 1040); near(ev.ev, 780); near(ev.spi, 0.75); near(ev.cpi, 0.65);
  const curve = C.baselineCurve(plan, s, 0);
  const cum = C.cumulative(curve, Math.floor(E.toMin('2026-10-19') / E.DAY), Math.floor(E.toMin('2026-10-23') / E.DAY));
  near(cum[1], 1040); near(cum[cum.length - 1], 2880);
  const runOut = C.runOut(2000, 1200, new Map([[100, 500], [101, 500]]), 99);
  assert.equal(runOut, 101);
  assert.equal(C.runOut(5000, 1200, new Map([[100, 500]]), 99), null);
});

test('RAG suggestions from the numbers', () => {
  assert.deepEqual(C.suggestRag({ spi: 1, cpi: 1 }).overall, 'green');
  const r = C.suggestRag({ spi: 0.9, cpi: 0.8, slipDays: 2 });
  assert.equal(r.schedule, 'amber'); assert.equal(r.cost, 'red'); assert.equal(r.overall, 'red');
  assert.match(r.why.cost, /CPI 0.80/);
  assert.equal(C.suggestRag({ spi: 1, slipDays: 6 }).schedule, 'amber');
  assert.equal(C.suggestRag({ spi: 1, slipDays: 20 }).schedule, 'red');
  assert.equal(C.suggestRag({ cpi: 1, eac: 105, budget: 100 }).cost, 'amber');
  assert.equal(C.suggestRag({ openChanges: 2 }).scope, 'amber');
});

test('typed hours set the duration from the people on the task (effort-driven)', () => {
  assert.equal(C.durationForWork(120 * 60, [{ units: 1 }, { units: 0.5 }]), 80 * 60);   // 120 h ÷ 1.5 people
  assert.equal(C.durationForWork(40 * 60, [{ units: 0.5 }]), 80 * 60);                   // half-time: twice as long
  assert.equal(C.durationForWork(16 * 60, []), 16 * 60);                                  // nobody assigned: the hours are the duration
  assert.equal(C.durationForWork(-5, [{ units: 1 }]), 0);
});

test('each task against its estimate and budget: remaining, forecast and heading over', () => {
  const plan = bridge(), ctx = C.planContext(plan, DIR, RATE_MODEL);
  let s = E.schedule(plan);
  plan.tasks = E.setBaseline(plan, s, 0).tasks;
  C.baselineCosts(plan, s, ctx, 0);                         // A: 24 h, $1,560 · B: 24 h, $1,320
  plan.tasks[1].percent = 50;                               // A half done…
  plan.tasks[1].budget = 1500;                              // …with a $1,500 budget
  plan.tasks[2].budget = 2000;
  s = E.schedule(plan);
  const pc = C.plannedCost(plan, s, ctx);
  const actual = C.allocateActuals(plan, s, ctx, [{ date: '2026-10-19', hours: 10, name: 'Maria Lopez' }, { date: '2026-10-20', hours: 8, name: 'Maria Lopez' }]);
  const x = C.taskChecks(plan, s, pc, actual.byTask, 0);
  const a = x.get(2);
  near(a.baselineH, 24); near(a.plannedH, 24); near(a.actualH, 18); near(a.remainingH, 12); near(a.forecastH, 30);   // 18 h used and half still to do
  assert.ok(a.overHours);                                   // 30 h forecast > 24 h planned
  near(a.actualC, 18 * 65); near(a.forecastC, 18 * 65 + 1560 / 2);
  assert.ok(a.overBudget); near(a.budgetForecast, a.forecastC);   // $1,950 forecast against $1,500
  near(a.budgetLeft, 1500 - 18 * 65);
  const b = x.get(3);
  assert.ok(!b.overBudget && !b.overHours);
  near(b.forecastC, 1320);
  const phase = x.get(1);                                   // the summary adds up its tasks and their budgets
  near(phase.budget, 3500); assert.ok(phase.budgetFromTasks);
  near(phase.budgetForecast, a.forecastC + b.forecastC);    // only the tasks that have budgets
  near(phase.forecastH, 30 + 24); near(phase.actualC, 18 * 65);
  plan.tasks[0].budget = 3000;                              // its own budget wins over the sum
  const y = C.taskChecks(plan, s, pc, actual.byTask, 0).get(1);
  near(y.budget, 3000); assert.ok(!y.budgetFromTasks);
  plan.tasks[2].budget = null;                              // an unbudgeted task isn't counted against the tasks' budgets
  plan.tasks[0].budget = null;
  const z = C.taskChecks(plan, s, pc, actual.byTask, 0).get(1);
  near(z.budget, 1500); near(z.budgetForecast, a.forecastC);
});
