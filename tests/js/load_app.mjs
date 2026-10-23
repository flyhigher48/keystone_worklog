// Loads the app's script out of static/index.html into a sandbox, so its pure logic
// (dates, holidays, schedules, the pay-period check, burn rate, capture and email parsing)
// can be tested with Node's built-in test runner – no browser, no npm packages.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const EXPORTS = [
  'fmt', 'parse', 'addDays', 'diffDays', 'sundayOf', 'fmtMoment', 'applyTemplate', 'normalize', 'loadPeriod', 'view',
  'SCHEDULES', 'scheduleArr', 'federalHolidays', 'holidayOn', 'fillHolidays', 'periodIssues', 'blocking', 'planHours',
  'burnInfo', 'parseDue', 'parseCapture', 'captureLine', 'dayHeading', 'captureFile', 'sectionOf',
  'parseEml', 'parsePastedEmail', 'findProjectByName', 'periodTotal', 'portalRows', 'portalText', 'PORTAL_HEAD',
];

export function loadApp() {
  const html = readFileSync(new URL('../../keystone_worklog/static/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<script>\nconst DAYS');
  let code = html.slice(start + '<script>'.length, html.indexOf('</script>', start));
  code = code.slice(0, code.indexOf('/* ---------- boot ---------- */'));  // don't start the app

  // just enough of a browser for the script to load
  const stub = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : stub()), set: () => true, apply: () => stub() });
  const sandbox = {
    console, URL, TextDecoder, TextEncoder, atob, btoa, setTimeout, clearTimeout, setInterval: () => 0,
    document: { getElementById: () => stub(), addEventListener() {}, querySelectorAll: () => [], body: stub(), createElement: () => stub(), createElementNS: () => stub() },
    window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} }, navigator: {}, innerWidth: 1200,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${code};\nglobalThis.__app = { ${EXPORTS.join(', ')}, setState: s => { state = s; }, getState: () => state };`, sandbox);
  return sandbox.__app;
}

// state helper: a normalised tracker with the given settings / projects / periods
export function withState(app, data = {}) {
  const s = app.normalize({ settings: { weekStart: 'sun', anchor: '2026-01-04', leaveStart: '2026-01-04', periodHours: 80, ...(data.settings || {}) },
    projects: data.projects || [], deliverables: data.deliverables || [], followups: data.followups || [], periods: data.periods || {} });
  app.setState(s);
  return s;
}
