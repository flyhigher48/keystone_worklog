// Keystone Planner – the other views of a plan: Team planner, Workload, Issues & risks (RAID), Dashboard,
// plus the milestone strip above the Gantt and the people dialog. `A` is the API handed over by ui.js.

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function render(kind, A) {
  if (kind === 'team') return teamView(A);
  if (kind === 'workload') return workloadView(A);
  if (kind === 'raid') return raidView(A);
  return dashboardView(A);
}

// ---------- milestone strip ----------
export function timelineStrip(A, go) {
  const { S, E, taskOf, fmtDate } = A;
  const ms = S.sched.order.filter(u => S.sched.byUid.get(u).milestone);
  if (!ms.length) return h('div', { class: 'pl-strip empty' });
  const a = S.sched.start, b = Math.max(S.sched.finish, a + E.DAY), today = E.toMin(fmt(new Date()));
  const pos = t => `${Math.max(0, Math.min(100, (t - a) / (b - a) * 100))}%`;
  return h('div', { class: 'pl-strip', 'aria-label': 'Milestones' },
    h('div', { class: 'pl-line' }),
    today >= a && today <= b ? h('div', { class: 'pl-now', style: `left:${pos(today)}`, title: 'Today' }) : null,
    ms.slice(0, 40).map((u, i) => {
      const r = S.sched.byUid.get(u), t = taskOf(u), cls = r.pct >= 100 ? 'done' : r.late || r.missesDeadline ? 'late' : '';
      return h('button', { class: `pl-ms ${cls} ${i % 2 ? 'dn' : 'up'}${(r.ef - a) / (b - a) > 0.75 ? ' r' : ''}`, style: `left:${pos(r.ef)}`, title: `${t.name} · ${fmtDate(r.ef)}`, onclick: () => go(u) },
        h('span', { class: 'pl-dm' }, '◆'), h('span', { class: 'pl-ml' }, h('b', {}, t.name), ' ', fmtDate(r.ef, false)));
    }));
}

// ---------- shared: work per person per day ----------
/** Minutes of work per resource per day in [from, to): Map resUid → Float64Array(days). */
function loadByDay(A, from, days) {
  const { S, E } = A, out = new Map();
  for (const r of S.plan.resources) out.set(r.uid, new Float64Array(days));
  for (const as of S.plan.assignments) {
    const r = S.sched.byUid.get(as.taskUid), arr = out.get(as.resourceUid);
    if (!r || r.summary || !arr || r.ef <= from || r.es >= from + days * E.DAY) continue;
    const total = E.workBetween(S.sched.calendar, r.es, r.ef) || 1, work = as.workMinutes ?? r.dur * (as.units ?? 1);
    const d0 = Math.max(0, Math.floor((r.es - from) / E.DAY)), d1 = Math.min(days - 1, Math.floor((r.ef - 1 - from) / E.DAY));
    for (let d = d0; d <= d1; d++) {
      const w = E.workIn(S.sched, as.taskUid, from + d * E.DAY, from + (d + 1) * E.DAY);
      arr[d] += w * work / total;
    }
  }
  return out;
}
/** Days off for a resource: the Keystone away list for "me", the resource's own exceptions otherwise. */
function awayDays(A, res) {
  const out = new Set();
  if (res.me) for (const a of state.away || []) if (a.kind !== 'travel' && a.start) for (let d = a.start; d <= (a.end || a.start); d = addDays(d, 1)) out.add(d);
  for (const d of res.away || []) out.add(d);
  return out;
}
const startOfWeek = d => { const x = new Date(d + 'T00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return fmt(x); };

// ---------- team planner ----------
function teamView(A) {
  const { S, E, taskOf, change, fmtDate, select } = A;
  const weeks = S.teamWeeks || 6, from = E.toMin(S.teamFrom || startOfWeek(fmt(new Date()))), days = weeks * 7, ppd = 26;
  const people = S.plan.resources;
  const head = h('div', { class: 'tp-head', style: `width:${days * ppd}px` }, Array.from({ length: days }, (_, d) => {
    const iso = E.dateOf(from + d * E.DAY), wd = new Date(iso + 'T00:00').getDay();
    return h('div', { class: 'tp-d' + (wd === 0 || wd === 6 ? ' we' : '') + (iso === fmt(new Date()) ? ' today' : ''), style: `width:${ppd}px` }, wd === 1 ? h('b', {}, iso.slice(5).replace('-', '/')) : DAYS[wd]);
  }));
  const load = loadByDay(A, from, days), per = S.plan.units.minutesPerDay;
  const lane = (res, items, label) => {
    const away = res ? awayDays(A, res) : new Set(), L = res ? load.get(res.uid) : null;
    const packed = [];  // stack the bars so they don't overlap
    for (const it of items.sort((a, b) => a.r.es - b.r.es)) {
      let row = packed.findIndex(end => end <= it.r.es);
      if (row < 0) { row = packed.length; packed.push(0); }
      packed[row] = it.r.ef; it.row = row;
    }
    const hgt = Math.max(1, packed.length) * 24 + 8;
    const body = h('div', { class: 'tp-lane', style: `width:${days * ppd}px;height:${hgt}px`, 'data-res': res ? res.uid : '',
      ondragover: e => { e.preventDefault(); e.currentTarget.classList.add('drop'); }, ondragleave: e => e.currentTarget.classList.remove('drop'),
      ondrop: e => {
        e.preventDefault(); e.currentTarget.classList.remove('drop');
        const [uid, fromRes] = (e.dataTransfer.getData('text/plain') || '').split(':').map(Number);
        if (!taskOf(uid)) return;
        const toRes = res ? res.uid : null;
        if (toRes === (Number.isNaN(fromRes) ? null : fromRes)) return;
        change(res ? `Give “${taskOf(uid).name}” to ${res.name}` : `Unassign “${taskOf(uid).name}”`, p => {
          const old = p.assignments.find(a => a.taskUid === uid && a.resourceUid === fromRes);
          p.assignments = p.assignments.filter(a => !(a.taskUid === uid && (a.resourceUid === fromRes || a.resourceUid === toRes)));
          if (toRes != null) p.assignments.push({ taskUid: uid, resourceUid: toRes, units: old ? old.units : 1 });
        });
      } },
      Array.from({ length: days }, (_, d) => {
        const iso = E.dateOf(from + d * E.DAY), wd = new Date(iso + 'T00:00').getDay(), over = L && L[d] > per * (res.maxUnits ?? 1) + 1;
        return h('div', { class: 'tp-bg' + (wd === 0 || wd === 6 ? ' we' : '') + (away.has(iso) ? ' away' : '') + (over ? ' over' : ''), style: `left:${d * ppd}px;width:${ppd}px`, title: away.has(iso) ? 'Out of office' : over ? `Overbooked: ${Math.round(L[d] / 6) / 10} h` : '' });
      }),
      items.map(it => {
        const x0 = Math.max(0, (it.r.es - from) / E.DAY * ppd), x1 = Math.min(days * ppd, (it.r.ef - from) / E.DAY * ppd);
        if (x1 <= 0 || x0 >= days * ppd) return null;
        return h('div', { class: 'tp-bar' + (it.r.critical ? ' crit' : '') + (it.r.pct >= 100 ? ' done' : '') + (it.r.milestone ? ' ms' : ''), draggable: 'true',
          style: `left:${x0}px;width:${Math.max(it.r.milestone ? 14 : 8, x1 - x0)}px;top:${4 + it.row * 24}px`, title: `${it.t.name} · ${fmtDate(it.r.es)} → ${fmtDate(it.r.ef)} · ${it.r.pct || 0}%`,
          ondragstart: e => e.dataTransfer.setData('text/plain', `${it.t.uid}:${res ? res.uid : ''}`), ondblclick: () => A.openTask(it.t.uid), onclick: () => select(it.t.uid) },
          h('span', { style: `width:${it.r.pct || 0}%`, class: 'tp-pct' }), h('span', { class: 'tp-txt' }, it.r.milestone ? '◆ ' + it.t.name : it.t.name));
      }));
    return h('div', { class: 'tp-row' }, h('div', { class: 'tp-who' }, label), body);
  };
  const itemsFor = ru => S.plan.assignments.filter(a => a.resourceUid === ru).map(a => ({ t: taskOf(a.taskUid), r: S.sched.byUid.get(a.taskUid) })).filter(x => x.t && x.r && !x.r.summary);
  const assigned = new Set(S.plan.assignments.map(a => a.taskUid));
  const unassigned = S.sched.order.filter(u => !assigned.has(u)).map(u => ({ t: taskOf(u), r: S.sched.byUid.get(u) })).filter(x => !x.r.summary && (x.r.pct || 0) < 100);
  const nav = d => { S.teamFrom = E.dateOf(from + d * 7 * E.DAY); A.redraw(); };
  return h('section', { class: 'card pl-view' },
    h('div', { class: 'pl-tools' },
      h('h2', { style: 'margin:0' }, 'Team planner'),
      h('span', { class: 'hint' }, 'Drag a bar to another person to reassign it. Red days are overbooked; striped days are out of office.'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onclick: () => nav(-weeks) }, '‹'),
      h('button', { class: 'btn ghost', onclick: () => { S.teamFrom = null; A.redraw(); } }, 'This week'),
      h('button', { class: 'btn ghost', onclick: () => nav(weeks) }, '›'),
      h('button', { class: 'btn', onclick: () => peopleDialog(A) }, 'People…')),
    h('div', { class: 'tp-scroll' },
      h('div', { class: 'tp-row tp-hrow' }, h('div', { class: 'tp-who' }), head),
      people.map(res => {
        const its = itemsFor(res.uid), L = load.get(res.uid), tot = L.reduce((s, v) => s + v, 0);
        return lane(res, its, [h('b', {}, res.name), h('small', { class: 'hint' }, `${Math.round(tot / 60)} h in ${weeks} weeks${res.me ? ' · you' : ''}`)]);
      }),
      lane(null, unassigned, [h('b', {}, 'Unassigned'), h('small', { class: 'hint' }, `${unassigned.length} task${unassigned.length === 1 ? '' : 's'}`)])));
}

// ---------- workload heatmap ----------
function workloadView(A) {
  const { S, E } = A;
  const weeks = 12, from = E.toMin(S.loadFrom || startOfWeek(fmt(new Date()))), days = weeks * 7, load = loadByDay(A, from, days), per = S.plan.units.minutesPerDay;
  const cell = (res, w) => {
    let mins = 0, cap = 0, away = 0;
    const off = awayDays(A, res);
    for (let d = 0; d < 7; d++) {
      const day = from + (w * 7 + d) * E.DAY, iso = E.dateOf(day);
      mins += load.get(res.uid)[w * 7 + d];
      const avail = E.dayWork(S.sched.calendar, day / E.DAY) * (res.maxUnits ?? 1);
      if (off.has(iso)) away += avail; else cap += avail;
    }
    const ratio = cap ? mins / cap : mins ? 2 : 0;
    const cls = ratio > 1.02 ? 'over' : ratio > 0.8 ? 'full' : ratio > 0.4 ? 'mid' : ratio > 0 ? 'low' : '';
    return h('td', { class: 'wl ' + cls, title: `${Math.round(mins / 6) / 10} h planned of ${Math.round(cap / 6) / 10} h available${away ? ` · ${Math.round(away / 6) / 10} h out of office` : ''}` },
      mins ? `${Math.round(mins / 60)}` : '', away ? h('small', { class: 'wl-away' }, ' ✈') : null);
  };
  const nav = d => { S.loadFrom = E.dateOf(from + d * 7 * E.DAY); A.redraw(); };
  return h('section', { class: 'card pl-view' },
    h('div', { class: 'pl-tools' }, h('h2', { style: 'margin:0' }, 'Workload'),
      h('span', { class: 'hint' }, 'Planned hours per person per week, against their working hours (holidays and time off taken out).'),
      h('div', { class: 'spacer' }), h('button', { class: 'btn ghost', onclick: () => nav(-weeks) }, '‹'), h('button', { class: 'btn ghost', onclick: () => { S.loadFrom = null; A.redraw(); } }, 'Now'), h('button', { class: 'btn ghost', onclick: () => nav(weeks) }, '›')),
    h('div', { class: 'tablewrap' }, h('table', { class: 'rep wl-tbl' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Person'), Array.from({ length: weeks }, (_, w) => h('th', {}, E.dateOf(from + w * 7 * E.DAY).slice(5).replace('-', '/'))))),
      h('tbody', {}, S.plan.resources.map(res => h('tr', {}, h('th', {}, res.name), Array.from({ length: weeks }, (_, w) => cell(res, w))))))),
    h('div', { class: 'wl-key hint' }, h('span', { class: 'wl low' }, '≤40%'), h('span', { class: 'wl mid' }, '≤80%'), h('span', { class: 'wl full' }, '≤100%'), h('span', { class: 'wl over' }, 'overbooked'), h('span', {}, '✈ time off that week'), ` · ${Math.round(per / 60 * 10) / 10} h working day`));
}

// ---------- RAID log ----------
const KINDS = [['risk', 'Risk'], ['issue', 'Issue'], ['action', 'Action'], ['decision', 'Decision']];
const STAT = [['open', 'Open'], ['monitoring', 'Monitoring'], ['closed', 'Closed']];
function raidView(A) {
  const { S, rowIds } = A, ids = rowIds();
  const f = S.raidFilter || 'open', k = S.raidKind || 'all';
  const items = (S.plan.raid || []).filter(x => (f === 'all' || (f === 'open' ? x.status !== 'closed' : x.status === f)) && (k === 'all' || x.kind === k));
  const score = x => (x.probability || 0) * (x.impact || 0);
  items.sort((a, b) => (a.status === 'closed') - (b.status === 'closed') || score(b) - score(a) || String(a.due || '9').localeCompare(String(b.due || '9')));
  const risks = (S.plan.raid || []).filter(x => x.kind === 'risk' && x.status !== 'closed');
  const matrix = h('div', { class: 'rm' }, h('div', { class: 'rm-y' }, 'Impact →'),
    h('div', { class: 'rm-grid' }, [5, 4, 3, 2, 1].flatMap(im => [1, 2, 3, 4, 5].map(pr => {
      const n = risks.filter(x => (x.impact || 0) === im && (x.probability || 0) === pr);
      const sev = im * pr >= 15 ? 'rm-hi' : im * pr >= 6 ? 'rm-md' : 'rm-lo';
      return h('div', { class: `rm-c ${sev}`, title: `Probability ${pr} × impact ${im}: ${n.map(x => x.title).join(', ') || 'none'}` }, n.length || '');
    }))), h('div', { class: 'rm-x' }, 'Probability →'));
  const seg = (cur, opts, set) => h('div', { class: 'seg' }, opts.map(([v, l]) => h('button', { class: cur === v ? 'on' : '', onclick: () => { set(v); A.redraw(); } }, l)));
  return h('section', { class: 'card pl-view' },
    h('div', { class: 'pl-tools' }, h('h2', { style: 'margin:0' }, 'Issues & risks'),
      seg(k, [['all', 'All'], ...KINDS], v => { S.raidKind = v; }), seg(f, [['open', 'Not closed'], ['closed', 'Closed'], ['all', 'Everything']], v => { S.raidFilter = v; }),
      h('div', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => raidDialog(A, null, { kind: k === 'all' ? 'issue' : k }) }, icon('plus'), 'Add')),
    h('div', { class: 'raid-wrap' },
      h('div', { class: 'tablewrap', style: 'flex:1' }, items.length ? h('table', { class: 'rep raid' },
        h('thead', {}, h('tr', {}, ['Kind', 'Title', 'Owner', 'Due', 'P×I', 'Tasks', 'Status', ''].map(x => h('th', {}, x)))),
        h('tbody', {}, items.map(x => h('tr', { class: x.status === 'closed' ? 'muted' : '', ondblclick: () => raidDialog(A, x) },
          h('td', {}, h('span', { class: 'chip raid-' + x.kind }, x.kind)), h('td', {}, h('b', {}, x.title), x.description ? h('div', { class: 'hint' }, x.description.slice(0, 140)) : null),
          h('td', {}, x.owner || ''), h('td', { class: x.due && x.due < fmt(new Date()) && x.status !== 'closed' ? 'neg' : '' }, x.due || ''),
          h('td', {}, x.kind === 'risk' ? `${x.probability || 0}×${x.impact || 0}` : ''),
          h('td', {}, (x.taskUids || []).map(u => ids.get(u) ? h('button', { class: 'btn ghost sm', onclick: () => A.select(u), title: A.taskOf(u)?.name }, String(ids.get(u))) : null)),
          h('td', {}, x.status), h('td', {}, h('button', { class: 'btn ghost sm', onclick: e => showMenu(e, raidMenu(A, x)) }, '⋯')))))) : h('p', { class: 'hint' }, 'Nothing here yet. Log risks before they happen, issues when they do, actions to take and decisions made.')),
      risks.length ? h('div', { class: 'rm-box' }, h('b', {}, 'Open risks'), matrix) : null));
}
function raidMenu(A, x) {
  return [
    { icon: 'edit', label: 'Edit…', run: () => raidDialog(A, x) },
    x.status !== 'closed' ? { icon: 'stop', label: 'Close', run: () => A.change('Close ' + x.kind, p => { const y = p.raid.find(r => r.id === x.id); y.status = 'closed'; y.closed = fmt(new Date()); }) } : { icon: 'repeat', label: 'Reopen', run: () => A.change('Reopen ' + x.kind, p => { p.raid.find(r => r.id === x.id).status = 'open'; }) },
    { icon: 'plus', label: 'Put it on the Board', run: () => { state.deliverables.push({ id: uid(), title: x.title, projectId: A.S.plan.projectId || '', status: 'todo', due: x.due || '', notes: `${x.kind} from the plan “${A.S.plan.name}”\n${x.description || ''}` }); save(); toast('Added to the Board'); } },
    { icon: 'bell', label: 'Make it a follow-up', run: () => { addFollowup({ subject: x.title, due: x.due || '', projectId: A.S.plan.projectId || '', notes: `${x.kind} in the plan “${A.S.plan.name}”` }); toast('Added to Follow-ups'); } },
    { icon: 'spark', label: 'Ask Keystone about it', run: () => askKeystone(`In the plan “${A.S.plan.name}”, help me with this ${x.kind}: “${x.title}”. ${x.description || ''} Which tasks does it affect and what should I do?`) },
    '-',
    { icon: 'trash', label: 'Delete', danger: true, run: () => { if (confirm(`Delete “${x.title}”?`)) A.change('Delete ' + x.kind, p => { p.raid = p.raid.filter(r => r.id !== x.id); }); } }];
}
export function raidDialog(A, item, preset = {}) {
  const { S, rowIds, change } = A, ids = rowIds();
  const x = item ? { ...item } : { id: uid(), kind: 'issue', title: '', description: '', owner: '', due: '', status: 'open', probability: 3, impact: 3, mitigation: '', taskUids: [], created: fmt(new Date()), ...preset };
  const kind = h('select', {}, KINDS.map(([v, l]) => h('option', { value: v }, l))); kind.value = x.kind;
  const title = h('input', { value: x.title, required: '' });
  const desc = h('textarea', { rows: 3 }); desc.value = x.description || '';
  const owner = h('input', { value: x.owner || '', list: 'pl-people' });
  const people = h('datalist', { id: 'pl-people' }, S.plan.resources.map(r => h('option', { value: r.name })));
  const due = h('input', { type: 'date', value: x.due || '' });
  const status = h('select', {}, STAT.map(([v, l]) => h('option', { value: v }, l))); status.value = x.status;
  const prob = h('input', { type: 'number', min: 1, max: 5, value: x.probability || 3 });
  const imp = h('input', { type: 'number', min: 1, max: 5, value: x.impact || 3 });
  const mit = h('textarea', { rows: 2, placeholder: 'What you will do about it' }); mit.value = x.mitigation || '';
  const tasks = h('input', { value: (x.taskUids || []).map(u => ids.get(u)).filter(Boolean).join(', '), placeholder: 'Task numbers, e.g. 4, 7' });
  const riskRow = h('div', { class: 'row3' }, h('div', {}, h('label', {}, 'Probability (1–5)'), prob), h('div', {}, h('label', {}, 'Impact (1–5)'), imp), h('div', {}, h('label', {}, 'Status'), status));
  // decisions: the decision log (shown in the brief and the deck)
  const dstat = h('select', {}, [['proposed', 'Proposed – needs a decision'], ['decided', 'Decided'], ['superseded', 'Superseded']].map(([v, l]) => h('option', { value: v }, l)));
  dstat.value = x.decisionStatus || (x.status === 'closed' ? 'decided' : 'proposed');
  const decided = h('input', { type: 'date', value: x.decided || '' }), decidedBy = h('input', { value: x.decidedBy || '', list: 'pl-people', placeholder: 'Who decided' });
  const options = h('textarea', { rows: 2, placeholder: 'Options considered, one per line' }); options.value = (x.options || []).join('\n');
  const rationale = h('textarea', { rows: 2, placeholder: 'Why this option' }); rationale.value = x.rationale || '';
  const impDays = h('input', { type: 'number', step: 'any', value: (x.decisionImpact || {}).days ?? '', placeholder: 'days' });
  const impCost = h('input', { type: 'number', step: 'any', value: (x.decisionImpact || {}).cost ?? '', placeholder: '$' });
  const impScope = h('input', { value: (x.decisionImpact || {}).scope || '', placeholder: 'scope change, if any' });
  const decRows = h('div', { class: 'dec-rows' },
    h('div', { class: 'row3' }, h('div', {}, h('label', {}, 'Decision'), dstat), h('div', {}, h('label', {}, 'Decided on'), decided), h('div', {}, h('label', {}, 'Decided by'), decidedBy)),
    h('div', { class: 'row2' }, h('div', {}, h('label', {}, 'Options considered'), options), h('div', {}, h('label', {}, 'Rationale'), rationale)),
    h('div', { class: 'row3' }, h('div', {}, h('label', {}, 'Schedule impact (working days)'), impDays), h('div', {}, h('label', {}, 'Cost impact'), impCost), h('div', {}, h('label', {}, 'Scope'), impScope)));
  const internal = h('input', { type: 'checkbox', checked: x.internal ? '' : false });
  const showKind = () => { riskRow.querySelectorAll('div')[0].hidden = riskRow.querySelectorAll('div')[1].hidden = kind.value !== 'risk'; decRows.hidden = kind.value !== 'decision'; };
  kind.addEventListener('change', showKind);
  const dlg = h('dialog', { class: 'dlg', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', onsubmit: e => {
      e.preventDefault();
      if (!title.value.trim()) return title.focus();
      const byId = new Map([...ids].map(([u, i]) => [i, u]));
      const tu = tasks.value.split(/[,\s]+/).filter(Boolean).map(n => byId.get(+n)).filter(u => u != null);
      const out = { ...x, kind: kind.value, title: title.value.trim(), description: desc.value.trim(), owner: owner.value.trim(), due: due.value, status: status.value,
        probability: +prob.value || 0, impact: +imp.value || 0, mitigation: mit.value.trim(), taskUids: tu, internal: internal.checked };
      if (out.kind === 'decision') {
        Object.assign(out, { decisionStatus: dstat.value, decided: decided.value || (dstat.value === 'decided' ? fmt(new Date()) : ''), decidedBy: decidedBy.value.trim(),
          options: options.value.split('\n').map(o => o.trim()).filter(Boolean), rationale: rationale.value.trim(), probability: 0, impact: 0,
          decisionImpact: impDays.value || impCost.value || impScope.value.trim() ? { days: impDays.value === '' ? null : +impDays.value, cost: impCost.value === '' ? null : +impCost.value, scope: impScope.value.trim() } : null });
        if (dstat.value !== 'proposed' && out.status !== 'closed') { out.status = 'closed'; out.closed = out.closed || out.decided; }
      }
      if (out.status === 'closed' && !out.closed) out.closed = fmt(new Date());
      change(item ? `Edit ${out.kind}` : `Log ${out.kind}`, p => { p.raid ||= []; const i = p.raid.findIndex(r => r.id === out.id); if (i >= 0) p.raid[i] = out; else p.raid.push(out); });
      dlg.close();
    } },
      h('h3', {}, item ? `Edit ${x.kind}` : 'Log an issue, risk, action or decision'), people,
      h('div', { class: 'row2' }, h('div', {}, h('label', {}, 'Kind'), kind), h('div', {}, h('label', {}, 'Due'), due)),
      h('div', {}, h('label', {}, 'Title'), title),
      h('div', {}, h('label', {}, 'Description'), desc),
      h('div', { class: 'row2' }, h('div', {}, h('label', {}, 'Owner'), owner), h('div', {}, h('label', {}, 'Affects tasks'), tasks)),
      riskRow, decRows,
      h('div', {}, h('label', {}, 'Response / mitigation'), mit),
      h('label', { class: 'sw' }, internal, 'Internal – left out when sharing with the sponsor'),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Save'))));
  document.body.append(dlg); showKind(); dlg.showModal(); title.focus();
}

// ---------- dashboard ----------
function dashboardView(A) {
  const { S, E, taskOf, fmtDate, actualHours, plannedMinutes, select } = A;
  const s = S.sched, leaves = s.order.filter(u => !s.byUid.get(u).summary), today = E.toMin(fmt(new Date()));
  const rs = leaves.map(u => s.byUid.get(u));
  const done = rs.filter(r => r.pct >= 100).length, late = leaves.filter(u => { const r = s.byUid.get(u); return (r.late || r.missesDeadline) && r.pct < 100; });
  const crit = leaves.filter(u => s.byUid.get(u).critical && s.byUid.get(u).pct < 100);
  // percent complete weighted by duration
  const tot = rs.reduce((a, r) => a + (r.dur || 0), 0), pct = tot ? Math.round(rs.reduce((a, r) => a + (r.dur || 0) * (r.pct || 0), 0) / tot) : 0;
  const expected = tot ? Math.round(leaves.reduce((a, u) => a + (s.byUid.get(u).dur || 0) * E.expectedPct(s.calendar, s.byUid.get(u), E.toMin(S.plan.statusDate) ?? today), 0) / tot) : 0;
  const bl = S.plan.tasks.map(t => (t.baselines || {})[S.baselineN]).filter(Boolean);
  const blFinish = bl.length ? Math.max(...bl.map(b => E.toMin(b.finish) || 0)) : null;
  const slip = blFinish ? s.finish - blFinish : null;
  const act = actualHours(), roots = (s.outline.kids.get(null) || []);
  const planH = roots.reduce((a, u) => a + plannedMinutes(u), 0) / 60, actH = [...act.entries()].filter(([u]) => !s.byUid.get(u)?.summary).reduce((a, [, v]) => a + v, 0);
  const tile = (label, value, sub, cls = '') => h('div', { class: 'card tile' }, h('div', { class: 'lbl' }, label), h('div', { class: 'big ' + cls }, value), sub ? h('div', { class: 'foot' }, sub) : null);
  const ms = s.order.filter(u => s.byUid.get(u).milestone && s.byUid.get(u).pct < 100).slice(0, 8);
  const open = (S.plan.raid || []).filter(x => x.status !== 'closed');
  const list = (us, empty) => us.length ? h('div', { class: 'list' }, us.slice(0, 8).map(u => { const r = s.byUid.get(u); return h('button', { class: 'li', onclick: () => select(u) }, h('span', { class: 'nm' }, taskOf(u).name), h('span', { class: 'hint' }, fmtDate(r.ef))); })) : h('p', { class: 'hint' }, empty);
  return h('section', { class: 'pl-view' },
    h('div', { class: 'tiles pl-tiles' },
      tile('Finish', fmtDate(s.finish), slip == null ? 'No baseline yet' : slip > 0 ? `${E.formatDuration({ minutes: slip, format: 'd' }, S.plan.units)} later than baseline` : slip < 0 ? `${E.formatDuration({ minutes: -slip, format: 'd' }, S.plan.units)} ahead of baseline` : 'On the baseline', slip > 0 ? 'neg' : ''),
      tile('Complete', `${pct}%`, `${expected}% expected by ${S.plan.statusDate ? 'the status date' : 'today'}`, pct + 5 < expected ? 'neg' : ''),
      tile('Tasks', `${done} / ${leaves.length}`, `${late.length} late · ${crit.length} critical left`, late.length ? 'neg' : ''),
      ...(() => {  // dollars when the plan has costs; hours otherwise
        const pc = A.costs && A.costs(), m = A.money;
        if (!pc || !(pc.actual.total || pc.ev.bac)) return [tile('Hours', `${Math.round(actH)} h`, `charged so far of ${Math.round(planH)} h planned`)];
        const ev = pc.ev, eac = ev.eac ?? ev.eacBottomUp;
        return [tile('Cost to date', m(pc.actual.total), pc.budget ? `${Math.round(pc.projectTotal / pc.budget * 100)}% of the ${m(pc.budget)} budget used` : `${Math.round(pc.actual.hours)} h charged`, pc.budget && pc.projectTotal > pc.budget ? 'neg' : ''),
          tile('Forecast cost', m(eac), ev.cpi != null ? `CPI ${ev.cpi.toFixed(2)} · SPI ${ev.spi != null ? ev.spi.toFixed(2) : '–'}` : 'needs a baseline with costs', (pc.budget || ev.bac) && eac > (pc.budget || ev.bac) ? 'neg' : '')];
      })(),
      ...(() => { const sn = A.lastSnap && A.lastSnap(); return sn ? [tile('Status', ({ green: 'On track', amber: 'At risk', red: 'Off track' })[sn.rag.overall] || '–', `${sn.statusDate}${sn.rag.reasons && sn.rag.reasons.overall ? ' · ' + sn.rag.reasons.overall : ''}`, 'rag-t rag-' + sn.rag.overall)] : []; })(),
      tile('Issues & risks', String(open.length), (([r, i]) => `${r} risk${r === 1 ? '' : 's'} · ${i} issue${i === 1 ? '' : 's'} open`)([open.filter(x => x.kind === 'risk').length, open.filter(x => x.kind === 'issue').length]))),
    h('div', { class: 'grid2' },
      h('div', { class: 'card' }, h('h3', {}, 'Next milestones'), list(ms, 'No milestones left.')),
      h('div', { class: 'card' }, h('h3', {}, 'Late or missing deadlines'), list(late, 'Nothing is late.')),
      h('div', { class: 'card' }, h('h3', {}, 'Critical path (not done)'), list(crit, 'Nothing left on the critical path.')),
      h('div', { class: 'card' }, h('h3', {}, 'Recent changes'), (S.plan.changeLog || []).length ? h('ul', { class: 'mv-done' }, (S.plan.changeLog || []).slice(-10).reverse().map(c => h('li', {}, `${c.at.slice(0, 16).replace('T', ' ')} · ${c.by} · ${c.summary}`))) : h('p', { class: 'hint' }, 'No changes yet.'))));
}

// ---------- people ----------
export function peopleDialog(A) {
  const { S, change } = A;
  const rows = S.plan.resources.map(r => ({ ...r, away: (r.away || []).join(', ') }));
  const body = h('tbody');
  const paint = () => body.replaceChildren(...rows.map((r, i) => h('tr', {},
    h('td', {}, h('input', { value: r.name, oninput: e => { r.name = e.target.value; } })),
    h('td', {}, h('input', { value: r.initials || '', style: 'width:60px', oninput: e => { r.initials = e.target.value; } })),
    h('td', {}, h('input', { type: 'number', min: 10, max: 300, step: 10, value: Math.round((r.maxUnits ?? 1) * 100), style: 'width:70px', oninput: e => { r.maxUnits = (+e.target.value || 100) / 100; } })),
    h('td', {}, h('input', { value: r.away, placeholder: r.me ? 'From your Keystone calendar' : 'YYYY-MM-DD, …', oninput: e => { r.away = e.target.value; } })),
    h('td', {}, h('input', { type: 'radio', name: 'pl-me', checked: r.me ? '' : false, title: 'This is me', onchange: () => rows.forEach((x, j) => { x.me = j === i; }) })),
    h('td', {}, h('button', { type: 'button', class: 'btn ghost sm', title: 'Remove', onclick: () => {
      if (S.plan.assignments.some(a => a.resourceUid === r.uid) && !confirm(`${r.name} has tasks. Remove them from those tasks?`)) return;
      rows.splice(i, 1); paint();
    } }, '✕')))));
  paint();
  const dlg = h('dialog', { class: 'dlg wide', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', onsubmit: e => {
      e.preventDefault();
      change('Edit people', p => {
        const keep = new Set(rows.map(r => r.uid));
        p.resources = rows.filter(r => r.name.trim()).map(r => ({ ...r, name: r.name.trim(), away: String(r.away || '').split(/[,\s]+/).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) }));
        p.assignments = p.assignments.filter(a => keep.has(a.resourceUid));
      });
      dlg.close();
    } },
      h('h3', {}, 'People'),
      h('p', { class: 'hint', style: 'margin:0' }, 'Max is how much of their time they can give (100% = full time). Your own time off comes from the Keystone calendar.'),
      h('table', { class: 'rep' }, h('thead', {}, h('tr', {}, ['Name', 'Initials', 'Max %', 'Days off', 'Me', ''].map(x => h('th', {}, x)))), body),
      h('button', { type: 'button', class: 'btn', onclick: () => { rows.push({ uid: rows.reduce((m, r) => Math.max(m, r.uid), 0) + 1, name: '', initials: '', maxUnits: 1, away: '' }); paint(); body.lastChild.querySelector('input').focus(); } }, icon('plus'), 'Add a person'),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), h('button', { type: 'submit', class: 'btn primary' }, 'Save'))));
  document.body.append(dlg); dlg.showModal();
}
