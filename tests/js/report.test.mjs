// The project brief: the Brief.md note, the report model, what "Review before sharing" removes, the plain-language
// sentences, the self-contained HTML and the PowerPoint slide list. 2026-10-19 is a Monday.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../keystone_worklog/static/planner/engine.js';
import * as C from '../../keystone_worklog/static/planner/costs.js';
import * as R from '../../keystone_worklog/static/planner/report.js';

const NOTE = `---
keystone: brief
plan: p_0000b01d
summary: Rehabilitate the three-span girder bridge on County Road 12.
client: "County of Example: Public Works"
cover: Photos/east elevation.jpg
mine: keep me
---
# Girder Bridge rehab – project brief

## Background
The bearings at pier 3 have **failed**.

## Objectives
- Replace the pier 3 bearings
- Load rating memo
1. Deck repair

## Scope
### In scope
- Bearings
- Deck joints
### Out of scope
- Painting

## Key facts
- **Contract:** 26-114
- **Location:** CR 12 over Mill Creek
- Funding: County bond
- **Empty:**

## Key links
- [[Contracts/26-114 signed.pdf]]
- [[Specs/Special provisions.pdf|Special provisions]]
- [County site](https://example.gov/cr12)

## Contacts
| Name | Role | Organisation | Email | Phone |
| --- | --- | --- | --- | --- |
| Maria Lopez | County PM | County | mlopez@example.gov | 555-0100 |
|  |  |  |  |  |
| Sam Ortiz | Fabricator | Ortiz Steel | sam@ortiz.example |  |

## Permits
County encroachment permit applied for.

\`\`\`
## not a heading inside code
\`\`\`
`;

test('the Brief.md note: frontmatter, sections, lists, facts, links, contacts – and a round trip that keeps everything', () => {
  const b = R.parseBrief(NOTE);
  assert.equal(b.front.summary, 'Rehabilitate the three-span girder bridge on County Road 12.');
  assert.equal(b.front.client, 'County of Example: Public Works');
  assert.equal(b.front.mine, 'keep me');
  assert.deepEqual(b.sections.map(s => s.title), ['', 'Background', 'Objectives', 'Scope', 'Key facts', 'Key links', 'Contacts', 'Permits']);
  assert.match(R.sectionOf(b, 'permits').body, /## not a heading inside code/);
  assert.deepEqual(R.bullets(R.sectionOf(b, 'Objectives').body), ['Replace the pier 3 bearings', 'Load rating memo', 'Deck repair']);
  assert.deepEqual(R.scope(R.sectionOf(b, 'Scope').body), { in: ['Bearings', 'Deck joints'], out: ['Painting'] });
  assert.deepEqual(R.facts(R.sectionOf(b, 'Key facts').body), [{ label: 'Contract', value: '26-114' }, { label: 'Location', value: 'CR 12 over Mill Creek' }, { label: 'Funding', value: 'County bond' }]);
  const l = R.links(R.sectionOf(b, 'Key links').body);
  assert.deepEqual(l.map(x => [x.label, x.vault]), [['26-114 signed.pdf', true], ['Special provisions', true], ['County site', false]]);
  const c = R.table(R.sectionOf(b, 'Contacts').body);
  assert.deepEqual(c.map(x => x.name), ['Maria Lopez', 'Sam Ortiz']);
  assert.equal(c[0].email, 'mlopez@example.gov');
  const again = R.parseBrief(R.serializeBrief(b));
  assert.deepEqual(again, b);   // nothing lost or changed
  R.setSection(b, 'Background', 'Replaced.');
  R.setSection(b, 'Lessons learned', '- Ask early');
  const t = R.serializeBrief(b);
  assert.match(t, /## Background\n\nReplaced\./);
  assert.match(t, /## Lessons learned\n\n- Ask early/);
  assert.match(t, /^---\nkeystone: brief\n/);
  assert.match(t, /client: "County of Example: Public Works"/);
});

test('a new brief from the template, and where it lives', () => {
  const t = R.briefTemplate({ planId: 'p_1', name: 'Runway lighting', client: 'Airport', nwa: '4005678/0020', phases: ['Design', 'Coordination'] });
  const b = R.parseBrief(t);
  assert.equal(b.front.plan, 'p_1');
  assert.match(b.front.summary, /Runway lighting: design, coordination/);
  for (const s of ['Background', 'Objectives', 'Scope', 'Key facts', 'Key links', 'Contacts']) assert.ok(R.sectionOf(b, s), s);
  assert.equal(R.briefFolder('Keystone', 'Girder Bridge: rehab?'), 'Keystone/Projects/Girder Bridge- rehab-');
  assert.equal(R.briefFolder('/Work/Keystone/', 'A/B'), 'Work/Keystone/Projects/A-B');
});

// a small plan: Design (A 3d Maria, B 2d Priya, milestone M), baseline then A finished late
function setup() {
  const plan = {
    name: 'Girder Bridge rehab', start: '2026-10-19T08:00', calendar: E.standardCalendar(), units: E.DEFAULT_UNITS,
    tasks: [
      { uid: 1, name: 'Design', parentUid: null },
      { uid: 2, name: 'A', parentUid: 1, duration: { minutes: 3 * 480, format: 'd' } },
      { uid: 3, name: 'B', parentUid: 1, duration: { minutes: 2 * 480, format: 'd' }, links: [{ pred: 2, type: 'FS', lag: { minutes: 0, format: 'd' } }] },
      { uid: 4, name: 'Plans submitted', parentUid: 1, duration: { minutes: 0, format: 'd' }, milestone: true, links: [{ pred: 3, type: 'FS', lag: { minutes: 0, format: 'd' } }] },
    ],
    resources: [{ uid: 1, name: 'Maria Lopez', personId: 'pe_m' }, { uid: 2, name: 'Priya Shah', personId: 'pe_p' }],
    assignments: [{ taskUid: 2, resourceUid: 1, units: 1 }, { taskUid: 3, resourceUid: 2, units: 1 }],
    raid: [
      { id: 'r1', kind: 'risk', title: 'County review takes longer', probability: 4, impact: 4, owner: 'Maria', status: 'open', mitigation: 'Pre-meeting', created: '2026-10-20' },
      { id: 'r2', kind: 'risk', title: 'Fee dispute with the fabricator', probability: 2, impact: 3, status: 'open', internal: true, created: '2026-10-10' },
      { id: 'r3', kind: 'issue', title: 'Pads late', status: 'open', due: '2026-10-28' },
      { id: 'r4', kind: 'decision', title: 'Pier 3 first', status: 'closed', decisionStatus: 'decided', decided: '2026-10-21', decidedBy: 'County', rationale: 'Worst bearings', options: ['Pier 3 first', 'All at once'] },
      { id: 'r5', kind: 'decision', title: 'Approve night closures', status: 'open', owner: 'Airport ops', due: '2026-10-30' },
    ],
  };
  const DIR = { people: [{ id: 'pe_m', name: 'Maria Lopez', category: 'Senior Engineer' }, { id: 'pe_p', name: 'Priya Shah' }], rates: [{ who: 'default', base: 50 }] };
  let s = E.schedule(plan);
  const ctx = C.planContext(plan, DIR, { base: 'rate', fringePct: 0, adders: [] });
  plan.tasks = E.setBaseline(plan, s, 0).tasks;
  C.baselineCosts(plan, s, ctx, 0);
  plan.tasks[1].duration = { minutes: 4 * 480, format: 'd' };   // A took a day longer
  plan.tasks[1].percent = 100; plan.tasks[1].actualFinish = '2026-10-22T17:00';
  s = E.schedule(plan, { now: E.toMin('2026-10-23') });
  const planned = C.plannedCost(plan, s, ctx);
  const actual = C.allocateActuals(plan, s, ctx, [{ date: '2026-10-19', hours: 32, name: 'Maria Lopez', pay: 0 }]);
  const pc = { ev: C.earnedValue(plan, s, 0, E.toMin('2026-10-23T17:00'), actual.total, 0), evH: {}, actual, planned, budget: 5000, projectTotal: actual.total, runOut: null, proj: { contingency: 500 }, statusMin: E.toMin('2026-10-23T17:00'),
    roll: { baseline: C.rollup(plan, s, new Map(plan.tasks.map(t => [t.uid, ((t.baselines || {})[0] || {}).cost]).filter(([, v]) => v != null))), actual: C.rollup(plan, s, actual.byTask, v => v.cost) },
    checks: C.taskChecks(plan, s, planned, actual.byTask, 0) };
  const log = [
    { id: 'l1', at: '2026-10-21T10:00', kind: 'win', text: 'County approved the pier 3 detail' },
    { id: 'l2', at: '2026-10-22T10:00', kind: 'problem', text: 'Fabricator wants more money' },
    { id: 'l3', at: '2026-10-22T11:00', kind: 'update', text: 'Internal note about staffing', internal: true },
  ];
  const ids = new Map(s.order.map((u, i) => [u, i + 1]));
  return { plan, sched: s, ids, pc, snaps: [], log, brief: R.parseBrief(NOTE), project: { network: '4001234', activity: '0010' }, now: '2026-10-23', people: DIR.people };
}

test('the report model: glance, changes, asks, plan, funding, risks, decisions, team, facts', () => {
  const inp = setup();
  const m = R.buildReport(inp, { period: 'all' });
  const sec = k => m.sections.find(s => s.key === k);
  assert.deepEqual(m.sections.map(s => s.key), ['glance', 'changes', 'asks', 'about', 'period', 'lookahead', 'plan', 'funding', 'risks', 'decisions', 'team', 'facts', 'appendix']);
  assert.equal(m.meta.client, 'County of Example: Public Works');
  const g = sec('glance');
  assert.match(g.sentence, /^Behind schedule|^On schedule/);
  assert.match(g.sentence, /the biggest risk is county review takes longer/);
  assert.equal(sec('plan').slip, 1);
  assert.equal(sec('plan').milestones[0].moved, 1);
  assert.deepEqual(sec('asks').items.map(a => a.kind + ':' + a.text), ['Decision:Approve night closures', 'Help needed:Fabricator wants more money']);
  assert.deepEqual(sec('decisions').made.map(d => d.title), ['Pier 3 first']);
  assert.deepEqual(sec('period').done.map(d => d.text), ['A']);
  assert.deepEqual(sec('risks').risks.map(r => r.title), ['County review takes longer', 'Fee dispute with the fabricator']);
  assert.equal(sec('risks').matrix[1][3], 1);   // impact 4 (row 2 from the top), probability 4
  assert.deepEqual(sec('team').contacts.map(c => c.name), ['Maria Lopez', 'Sam Ortiz']);
  assert.equal(sec('team').team[0].role, 'Senior Engineer');
  assert.deepEqual(sec('facts').links.map(l => l.label), ['26-114 signed.pdf', 'Special provisions', 'County site']);
  assert.deepEqual(sec('about').about.extra.map(x => x.title), ['Permits']);
  const f = sec('funding');
  assert.equal(f.budget, 5000);
  assert.match(f.sentence, /of the \$5,000 budget spent/);
  assert.deepEqual(f.byPerson.map(p => p.name), ['Maria Lopez']);
});

test('the period: since the last brief, this month, or everything', () => {
  const inp = setup();
  inp.plan.share = { lastAt: '2026-10-22' };
  const m = R.buildReport(inp, { period: 'sinceLast' });
  const p = m.sections.find(s => s.key === 'period');
  assert.deepEqual(p.highlights.map(x => x.key), ['log:l3', 'log:l2']);   // the Oct 21 win was in the last brief
  assert.equal(m.meta.since, '2026-10-22');
  assert.equal(R.buildReport(inp, { period: 'month' }).meta.since, '2026-10-01');
});

test('Review before sharing: removed sections and items are gone from every output', () => {
  const inp = setup();
  const full = R.buildReport(inp, { period: 'all' });
  const list = R.checklist(full, inp.plan, inp.log);
  const risks = list.find(x => x.key === 'section:risks');
  assert.ok(risks.items.find(i => i.key === 'raid:r2').internal);
  assert.deepEqual(list.find(x => x.key === 'section:funding').sub.map(x => x.key), ['section:fundingByPerson']);
  const sponsor = R.sponsorRemoved(inp.plan, inp.log);
  assert.deepEqual([...sponsor].sort(), ['log:l2', 'log:l3', 'raid:r2', 'section:appendix', 'section:fundingByPerson', 'section:teamHours']);
  const removed = new Set([...sponsor, 'contact:1', 'section:decisions', 'link:2']);
  const m = R.buildReport(inp, { period: 'all', removed });
  const html = R.renderHtml(m), slides = JSON.stringify(R.deckSpec(m));
  for (const gone of ['Fee dispute', 'Fabricator wants more money', 'Internal note about staffing', 'Sam Ortiz', 'Worst bearings', 'County site', 'Appendix']) {
    assert.ok(!html.includes(gone), `HTML still has ${gone}`);
    assert.ok(!slides.includes(gone), `slides still have ${gone}`);
  }
  assert.equal(m.sections.find(s => s.key === 'funding').byPerson, null);
  assert.equal(m.sections.find(s => s.key === 'team').hoursLabel, '');
  assert.match(html, /some items were left out of this copy/);
  assert.ok(!R.renderHtml(full).includes('left out'));
  assert.ok(html.includes('Maria Lopez') && html.includes('County review takes longer'));
});

test('the HTML brief is one self-contained file: no scripts, nothing fetched, readable charts', () => {
  const inp = setup();
  const html = R.renderHtml(R.buildReport(inp, { period: 'all' }), { cover: 'data:image/png;base64,AAAA' });
  assert.match(html, /^<!doctype html>/);
  assert.ok(!/<script/i.test(html), 'no scripts');
  assert.ok(!/(src|href)="https?:/i.test(html.replace(/<a href="https:\/\/example\.gov\/cr12">/, '')), 'nothing loaded from the internet');
  assert.ok(!/@import|url\(http/i.test(html));
  assert.match(html, /<img class="cover" src="data:image\/png/);
  assert.equal((html.match(/<svg /g) || []).length, 3);   // timeline, gantt, S-curve
  assert.match(html, /aria-label="Milestones: baseline and forecast dates"/);
  for (const h of ['At a glance', 'Decisions and help needed', 'About the project', 'The plan', 'Funding', 'Issues and risks', 'Key decisions', 'Team and contacts']) assert.ok(html.includes(`>${h}</h2>`), h);
  assert.ok(!/rate|\/h\b/i.test(html.replace(/ratio|rating|separate|Rehabilitate|rehabilitate/gi, '')), 'no pay rates anywhere');
});

test('plain-language sentences', () => {
  assert.equal(R.glanceSentence({ slip: 5, pctDone: 40, pctExp: 44, f: { budget: 100000, eac: 94000 }, highRisks: [{ title: 'County review takes longer' }], M: n => R.money(n, '$', true) }),
    'Behind schedule by 5 working days; spending is forecast to finish $6,000 under budget; the biggest risk is county review takes longer.');
  assert.equal(R.glanceSentence({ slip: 0, pctDone: 40, pctExp: 40, f: null, openIssues: [], nextMs: { name: '60% plans', forecast: '2026-11-16' } }), 'On schedule; next up: 60% plans on Nov 16.');
  assert.equal(R.glanceSentence({ slip: null, pctDone: 20, pctExp: 40, f: { cpi: 0.8 } }), 'Behind on progress (20% done, 40% expected); work is costing more than planned.');
  assert.equal(R.fundingSentence({ budget: 156000, spent: 58000, eac: 124000, runOut: null }, 40, n => R.money(n, '$', true)), '$58k of the $156k budget spent (37%) with 40% of the work done; forecast $124k, $32k under budget.');
  assert.equal(R.money(1234567, '$', true), '$1.2M');
  assert.equal(R.money(-2500), '−$2,500');
});

test('the slide list uses PowerPoint\'s standard layouts, with every slide titled', () => {
  const inp = setup();
  const slides = R.deckSpec(R.buildReport(inp, { period: 'all' }));
  assert.equal(slides[0].layout, 'title');
  assert.ok(slides.every(s => ['title', 'content', 'two', 'titleOnly'].includes(s.layout) && s.title));
  assert.deepEqual(slides.map(s => s.title), ['Girder Bridge rehab', 'At a glance', 'What changed since the start', 'About the project', 'Progress since the start', 'Schedule', 'Milestones', 'Funding', 'Funding summary', 'Cost by phase', 'Cost by person', 'Issues and risks', 'Decisions', 'Contacts', 'Next steps']);
  const funding = slides.find(s => s.title === 'Funding');
  assert.equal(funding.chart.type, 'line');
  assert.deepEqual(funding.chart.series.map(x => x.name), ['Planned (baseline)', 'Actual', 'Budget']);
  assert.ok(slides.find(s => s.title === 'Schedule').image === 'gantt');
  assert.ok(slides.every(s => !s.bullets || s.bullets.length <= 9));
});
