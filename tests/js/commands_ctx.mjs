// A fake command context for the slash-command tests: fixed "today" (Wed 2026-11-11), a few projects, cards, follow-ups,
// notes and a Today.md, and a runTool that records calls instead of changing anything.
import { parseCommand } from '../../keystone_worklog/static/commands/syntax.js';
import { find } from '../../keystone_worklog/static/commands/registry.js';

export const TODAY = '2026-11-11';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const heading = iso => { const [y, m, d] = iso.split('-').map(Number), dt = new Date(y, m - 1, d); return `${DAYS[dt.getDay()]}, ${MONTHS[m - 1]} ${d}, ${y}`; };

export const TODAY_MD = `# Today

Quick captures.

## ${heading('2026-11-11')}
- 09:00 Called the county about drainage #bridge
- [ ] Send site photos 📅 2026-11-13
- [x] Review calcs
- [ ] Reply to Maria: Bearing pad submittal

## ${heading('2026-11-09')}
- [ ] Order pads
- [ ] Check bearings → carried
- [x] Done thing
`;

export function fakeCtx(over = {}) {
  const calls = [], shown = [], files = {
    'Today.md': TODAY_MD,
    'Projects/Bridge/Bridge rehab.md': '# Bridge rehab\n\n## Log\n- old\n',
    'Work/County meeting.md': '# County meeting\n\n- [ ] Send minutes\nAction: Sam to check pads\nTODO: update the schedule\n```\n- [ ] not this\n```\n',
    'Templates/Meeting.md': '# {{title}}\n\nDate: {{date}}\n',
    ...(over.files || {}),
  };
  const projects = [
    { id: 'p1', name: 'Girder Bridge rehab', network: '4021', activity: '0010', budget: '400' },
    { id: 'p2', name: 'CR 12 widening', network: '4022', activity: '0020', budget: '' },
    { id: 'p3', name: 'Bridge deck inspection', network: '4030', activity: '0010', budget: '' },
    { id: 'p4', name: 'Admin', network: '9000', activity: '0001', budget: '' },
  ];
  const deliverables = [
    { id: 'd1', title: 'Pad design memo', projectId: 'p1', status: 'doing', due: '2026-11-09', notes: '' },
    { id: 'd2', title: '60% plans', projectId: 'p1', status: 'todo', due: '2026-11-20', notes: '' },
    { id: 'd3', title: 'Drainage report', projectId: 'p2', status: 'todo', due: '', notes: '' },
    { id: 'd4', title: 'Old card', projectId: '', status: 'done', due: '2026-11-01', notes: '' },
  ];
  const followups = [{ id: 'f1', from: 'Maria', subject: 'Bearing pad submittal', due: '2026-11-10', status: 'open', projectId: 'p1' },
    { id: 'f2', from: 'County', subject: 'Drainage comments', due: '2026-11-14', status: 'waiting', projectId: 'p2' }];
  let n = 0;
  const ctx = {
    calls, shown, files,
    today: () => TODAY, fmt: iso => iso, fmtTime: () => 'time', isoOfTime: () => TODAY,
    settings: () => ({}), commandSettings: () => ({ confirm: 'writes', fileHeading: 'Log', ...(over.commandSettings || {}) }),
    routines: () => over.routines || { eod: { label: 'End of day', lines: ['?/log day {1|usual}', '/today'] }, two: { label: 'Two', lines: ['/todo A', '/todo B'] } },
    tabs: () => [['today', 'Today'], ['board', 'Board'], ['plan', 'Plan']],
    projects: () => projects, projectLabel: p => p.name, projectName: id => (projects.find(p => p.id === id) || {}).name || '',
    projectNote: p => (p.id === 'p1' ? 'Projects/Bridge/Bridge rehab.md' : ''),
    cards: () => deliverables, stageLabel: s => s, followups: () => followups,
    notes: async () => Object.keys(files).map(path => ({ path, type: path.endsWith('.md') ? 'note' : 'doc' })),
    people: async () => [{ name: 'Maria Lopez' }, { name: 'Sam Lee' }],
    plans: async () => [{ id: 'pl1', name: 'Girder Bridge', tasks: 12 }, { id: 'pl2', name: 'CR 12', tasks: 5 }],
    openPlanName: () => ('openPlan' in over ? over.openPlan : 'Girder Bridge'),
    captureFile: () => 'Today.md', dayHeading: heading, readNote: async p => (p in files ? files[p] : null),
    templates: async () => [{ path: 'Templates/Meeting.md', name: 'Meeting' }], keystoneTemplate: async () => null,
    applyTemplate: (t, title) => t.replace('{{title}}', title).replace('{{date}}', TODAY),
    ensureToday: async () => ({}),
    captureLine: (text, kind) => (kind === 'todo' ? `- [ ] ${text}` : `- 10:00 ${text}`),
    openNote: () => over.open || null,
    planHours: entries => (entries.some(e => e.hours > 24) ? { error: 'too many hours' } : { lines: entries.map(e => `${e.date} ${e.project || e.network || e.code} ${e.hours}`), totals: [] }),
    dayInfo: iso => ({ scheduled: [0, 6].includes(new Date(iso + 'T12:00').getDay()) ? 0 : 8, logged: iso === TODAY ? 3 : 0, holiday: iso === '2026-11-11' && over.holiday ? 'Veterans Day' : '' }),
    usualFor: () => [{ network: '4021', activity: '0010', code: 'RG', hours: 6 }, { network: '9000', activity: '0001', code: 'RG', hours: 2 }],
    periodStart: iso => (iso < '2026-11-08' ? '2026-10-25' : '2026-11-08'), periodLen: 14,
    quarterSplit: (vals, total) => { const r = vals.map(v => Math.round(v * 4) / 4); r[r.length - 1] += Math.round((total - r.reduce((a, b) => a + b, 0)) * 4) / 4; return r; },
    hoursBy: () => ({ rows: [{ label: 'Girder Bridge rehab', code: 'RG', ts: false, hours: 30 }], total: 30, byDay: [] }),
    periodInfo: () => ({ start: '2026-11-08', end: '2026-11-21', target: 80, entered: 27, submitted: false }),
    leaveBalances: () => ({ annual: { now: 100, yearEnd: 250 }, sick: { now: 40, yearEnd: 48 }, carryLimit: 240 }),
    budgetRows: () => [{ id: 'p1', label: 'Girder Bridge rehab', budget: 400, used: 410, left: -10, rate: 20, runOut: '' }],
    warnings: () => ['Girder Bridge rehab is 10 h over its 400 h budget.'],
    read: async (name, args) => (over.read ? over.read(name, args) : { result: `${name} ok`, data: [] }),
    planRead: async (name, args) => `${name} ${JSON.stringify(args)}\n1. Design | 2026-11-02 → 2026-11-06\n7. Pads | 2026-11-09 → 2026-11-13\n12. Review | 2026-11-16 → 2026-11-20`,
    planTaskIds: async () => [7, 12], taskStart: async (plan, id) => ({ 7: '2026-11-09', 12: '2026-11-16' }[id] || ''),
    runTool: async (name, args) => { calls.push({ name, args, apply: ctx._apply }); if (name === 'create_note') files[args.path] = args.content; const r = over.runTool ? over.runTool(name, args) : null; return r || { text: `Done: ${name}`, state: ctx._apply === false && over.reject ? 'rejected' : 'applied', id: 'id' + ++n, undoable: true }; },
    _apply: null,
    withApply: async (flag, fn) => { const old = ctx._apply; ctx._apply = flag; try { return await fn(); } finally { ctx._apply = old; } },
    embedQuery: null, embedMany: null, embedModel: () => 'test',
    hasLLM: () => !!over.llm, ask: () => {}, undoLast: async () => 'Undone',
    chat: {
      user: () => {}, card: c => { shown.push(c); return c; }, decide: async c => { c.decided = true; return over.decide !== false; }, record: () => {},
    },
    ui: new Proxy({}, { get: (_, k) => (...a) => { calls.push({ ui: k, args: a }); return over.ui && over.ui[k] ? over.ui[k](...a) : undefined; } }),
  };
  return ctx;
}

/** Parses and builds one command against ctx: → the plan ({ describe, steps } or { error, choices }). */
export async function build(text, ctx = fakeCtx(), input) {
  const p = parseCommand(text), c = p && find(p.cmd, ctx);
  if (!c) throw new Error('no command ' + text);
  return c.build(p, ctx, input);
}
/** The tool calls a plan would make: [[name, args], …]. */
export const toolsOf = plan => (plan.steps || []).filter(s => s.tool).map(s => [s.tool, s.args]);
