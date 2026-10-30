// Keystone Planner – the project brief: the Brief view (the README part, stored in the vault as
// <tracker folder>/Projects/<project>/Brief.md), the weekly log, and "Review before sharing", which makes the HTML brief
// and the PowerPoint only when asked. The report itself is built in report.js.
import * as R from './report.js';
import * as E from './engine.js';
import { planner as S, taskOf, rowIds, redraw, patchPlan } from './ui.js';
import { planCosts, ensurePlanCosts, D, loadDir, fill, cur } from './costui.js';
import { loadStatus } from './status.js';

// ---------- the note and the log ----------
const projectOf = plan => plan.projectId && state.projects.find(p => p.id === plan.projectId);
export function briefPath(plan = S.plan) {
  const proj = projectOf(plan);
  return `${R.briefFolder(state.settings.vaultFolder || 'Keystone', proj ? projectLabel(proj) : plan.name)}/Brief.md`;
}
/** { path, md, mtime, b (parsed) } – or { path, missing: true }, or { noVault: true }. Cached per plan. */
export async function loadBrief(force = false) {
  const plan = S.plan;
  if (!state.settings.vaultPath) return (S.briefCache = { planId: plan.id, noVault: true });
  const path = briefPath(plan);
  if (!force && S.briefCache && S.briefCache.planId === plan.id && S.briefCache.path === path) return S.briefCache;
  try {
    const j = await api('/api/notes/file?path=' + encodeURIComponent(path));
    S.briefCache = { planId: plan.id, path, md: j.content, mtime: j.mtime, b: R.parseBrief(j.content) };
  } catch (e) {
    if (e.status !== 404) throw e;
    S.briefCache = { planId: plan.id, path, missing: true };
  }
  return S.briefCache;
}
async function saveBrief(b) {
  const c = S.briefCache, content = R.serializeBrief(b);
  try {
    const j = await api('/api/notes/file', { path: c.path, content, base: c.missing ? null : c.mtime }, 'PUT');
    Object.assign(c, { md: content, mtime: j.mtime, b: R.parseBrief(content), missing: false });
    try { indexSoon(1500); } catch {}
    return true;
  } catch (e) {
    if (e.status === 409) { await loadBrief(true); toast('The brief was changed in Obsidian meanwhile – reloaded it. Make your change again.'); redraw(); return false; }
    toast(e.message); return false;
  }
}
export async function loadLog(force = false) {
  const id = S.plan.id;
  if (!force && S.logCache && S.logCache.planId === id) return S.logCache.entries;
  const j = await api(`/api/plans/${id}/log`);
  S.logCache = { planId: id, entries: j.entries || [] };
  return S.logCache.entries;
}
export const logEntries = () => (S.logCache && S.plan && S.logCache.planId === S.plan.id ? S.logCache.entries : []);
async function saveLog(entries) {
  await api(`/api/plans/${S.plan.id}/log`, { entries }, 'PUT');
  S.logCache = { planId: S.plan.id, entries };
}
export async function addLogEntry(e) {
  const entries = [...await loadLog(), { id: 'l_' + E.dateOf(Date.now() / 60000) + '_' + Math.random().toString(36).slice(2, 6), at: nowStamp(), by: 'you', ...e }];
  await saveLog(entries);
  return entries[entries.length - 1];
}
const nowStamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${fmt(d)}T${p(d.getHours())}:${p(d.getMinutes())}`; };
export const KINDS = [['update', 'Update', '📝'], ['win', 'Win', '★'], ['problem', 'Problem', '⚠'], ['decision', 'Decision', '⚖'], ['contact', 'Client contact', '☎'], ['site', 'Site visit', '📍'], ['lesson', 'Lesson learned', '💡']];
const kindIcon = k => (KINDS.find(x => x[0] === k) || [0, 0, '·'])[2];

/** What buildReport needs, gathered from the planner. */
export async function reportInput() {
  await Promise.all([ensurePlanCosts().catch(() => {}), loadStatus(S.plan.id).catch(() => {}), loadLog().catch(() => {}), loadBrief().catch(() => {}), loadDir().catch(() => {})]);
  const bc = S.briefCache;
  return { plan: S.plan, sched: S.sched, ids: rowIds(), pc: planCosts(), snaps: (S.statusCache && S.statusCache.planId === S.plan.id ? S.statusCache.snaps : []), log: logEntries(),
    brief: bc && bc.b ? bc.b : null, project: projectOf(S.plan) || null, now: fmt(new Date()), currency: cur(), baselineN: S.baselineN, people: (D.doc && D.doc.people) || [] };
}

// ---------- the Brief view ----------
const LEFT = ['Background', 'Objectives', 'Scope', 'Success criteria', 'Assumptions and constraints', 'Stakeholders', 'Lessons learned'];
const RIGHT = ['Key facts', 'Key links', 'Contacts'];
const HINT = {
  'Key facts': 'One per line: - **Label:** value (Contract, Location, Funding…)',
  'Key links': 'One per line: - [[path/to/file in the vault]] or - [label](https://…)',
  Contacts: '| Name | Role | Organisation | Email | Phone |',
  Scope: '### In scope / ### Out of scope, each with a bullet list',
  Stakeholders: '| Who | Cares about | How often they hear from us |',
};
export function briefView(A) {
  const bc = S.briefCache;
  if (!bc || bc.planId !== S.plan.id || !S.logCache || S.logCache.planId !== S.plan.id) {
    Promise.all([loadBrief(), loadLog(), N.tree ? null : loadTree()]).then(() => A.redraw()).catch(e => toast(e.message));
    return h('section', { class: 'card pl-view' }, h('p', { class: 'hint' }, 'Loading the brief…'));
  }
  if (!planCosts()) ensurePlanCosts().then(() => A.redraw()).catch(() => {});
  if (!S.statusCache || S.statusCache.planId !== S.plan.id) loadStatus(S.plan.id).then(() => A.redraw()).catch(() => {});
  const input = { plan: S.plan, sched: S.sched, ids: rowIds(), pc: planCosts(), snaps: S.statusCache && S.statusCache.planId === S.plan.id ? S.statusCache.snaps : [], log: logEntries(),
    brief: bc.b || null, project: projectOf(S.plan) || null, now: fmt(new Date()), currency: cur(), baselineN: S.baselineN, people: (D.doc && D.doc.people) || [] };
  const model = R.buildReport(input, { period: 'sinceLast' }), sec = k => model.sections.find(s => s.key === k), m = model.meta;
  const b = bc.b;
  const top = h('div', { class: 'card brief-head' },
    b && b.front.cover ? coverImg(b.front.cover) : null,
    h('div', { class: 'bh' },
      h('div', { class: 'pl-tools' }, h('span', { class: 'rag rag-' + (m.rag || 'none') }, m.ragLabel), h('h2', { style: 'margin:0' }, S.plan.name), h('div', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => updateDialog(A) }, icon('plus'), 'Add an update'),
        bc.noVault ? null : bc.missing ? h('button', { class: 'btn', onclick: () => startBrief(A) }, icon('file'), 'Start the brief') : h('button', { class: 'btn', title: bc.path, onclick: () => openInNotes(bc.path) }, icon('edit'), 'Open in Notes'),
        h('button', { class: 'btn primary', onclick: () => shareDialog(A) }, icon('down'), 'Share…')),
      h('p', { class: 'brief-sum' }, m.summary || (b ? h('span', { class: 'hint' }, 'No summary yet.') : ''), b ? h('button', { class: 'btn ghost sm', title: 'Edit the summary, client and cover photo', onclick: () => frontDialog(A) }, '✎') : null),
      h('p', { class: 'hint', style: 'margin:0' }, [m.client, m.project ? 'NWA ' + m.project : '', bc.path ? h('a', { href: '#', onclick: e => { e.preventDefault(); if (!bc.missing) openInNotes(bc.path); } }, bc.path) : ''].filter(Boolean).flatMap((x, i) => i ? [' · ', x] : [x]))));
  const g = sec('glance');
  const tiles = g ? h('div', { class: 'card' }, h('p', { class: 'brief-lead' }, g.sentence),
    h('div', { class: 'tiles pl-tiles' }, g.tiles.map(t => h('div', { class: 'card tile' }, h('div', { class: 'lbl' }, t.label), h('div', { class: 'big ' + (t.tone === 'bad' ? 'neg' : '') }, t.value), h('div', { class: 'foot' }, t.sub))))) : null;
  const latest = logEntries().slice().sort((x, y) => y.at.localeCompare(x.at))[0];
  const note = bc.noVault ? h('div', { class: 'duebar' }, icon('bell'), h('div', { class: 'txt' }, 'Connect your Obsidian vault in Settings to keep a project brief – it\'s a note in the vault.'))
    : bc.missing ? h('div', { class: 'duebar' }, icon('bell'), h('div', { class: 'txt' }, `This plan has no brief yet. It will be the note ${bc.path}: background, objectives, scope, key facts, links and contacts – you can edit it here or in Obsidian.`), h('button', { class: 'btn primary', onclick: () => startBrief(A) }, 'Start the brief')) : null;
  const card = (title, body, editable = true) => h('div', { class: 'card brief-sec' },
    h('div', { class: 'pl-tools' }, h('h3', { style: 'margin:0' }, title), h('div', { class: 'spacer' }), editable && b ? h('button', { class: 'btn ghost sm', title: `Edit ${title}`, onclick: () => sectionDialog(A, title) }, '✎') : null),
    body);
  const mdBox = text => { const d = h('div', { class: 'md brief-md' }); d.innerHTML = mdRender(text || ''); wire(d); return d; };
  const secBody = t => (R.sectionOf(b, t) || {}).body || '';
  const leftCards = b ? [...LEFT, ...b.sections.filter(x => x.title && !LEFT.concat(RIGHT).map(y => y.toLowerCase()).includes(x.title.toLowerCase()) && !/^log$/i.test(x.title)).map(x => x.title)]
    .filter(t => secBody(t).trim() || LEFT.includes(t)).map(t => card(t, secBody(t).trim() ? mdBox(secBody(t)) : h('p', { class: 'hint' }, 'Nothing yet.'))) : [];
  const pl = sec('plan'), dec = sec('decisions'), as = sec('asks');
  const msList = pl ? h('div', { class: 'list' }, pl.milestones.slice(0, 8).map(x => h('button', { class: 'li', onclick: () => A.select(x.uid) }, h('span', { class: 'chip ' + (x.done ? 'ok' : x.late || x.moved > 0 ? 'bad' : '') }, x.done ? '✓' : '◆'), h('span', { class: 'nm' }, x.name), h('span', { class: 'sub' }, R.fmtDay(x.forecast, false) + (x.moved > 0 ? ` (+${x.moved} d)` : ''))))) : null;
  const logBox = h('div', { class: 'brief-log' }, logEntries().slice().sort((x, y) => y.at.localeCompare(x.at)).slice(0, S.briefLogAll ? 500 : 8).map(e => h('div', { class: 'le' + (e.internal ? ' internal' : '') },
    h('span', { class: 'k', title: e.kind }, kindIcon(e.kind)), h('span', { class: 'hint' }, R.fmtDay(e.at.slice(0, 10), false)),
    (() => { const d = h('span', { class: 'md' }); d.innerHTML = mdRender(e.text || ''); wire(d); return d; })(),
    e.internal ? h('span', { class: 'chip muted', title: 'Left out by the Sponsor preset' }, 'internal') : null,
    h('button', { class: 'btn ghost sm', title: 'Edit', onclick: () => updateDialog(A, e) }, '✎'))));
  const left = h('div', { class: 'brief-col' },
    as && as.items.length ? card('Decisions and help needed', h('div', { class: 'list' }, as.items.map(a => h('div', { class: 'li' }, h('span', { class: 'chip warn' }, a.kind), h('span', { class: 'nm' }, a.text), h('span', { class: 'sub' }, [a.owner, a.due ? 'by ' + R.fmtDay(a.due, false) : ''].filter(Boolean).join(' · '))))), false) : null,
    card('Updates', h('div', {}, latest ? logBox : h('p', { class: 'hint' }, 'No updates yet. Add one whenever something happens – Close the week drafts its report from them.'),
      logEntries().length > 8 ? h('button', { class: 'btn ghost sm', onclick: () => { S.briefLogAll = !S.briefLogAll; A.redraw(); } }, S.briefLogAll ? 'Show fewer' : `Show all ${logEntries().length}`) : null), false),
    ...leftCards,
    pl ? card('Milestones', msList, false) : null,
    dec ? card('Recent decisions', h('div', { class: 'list' }, dec.made.slice(0, 5).map(d => h('div', { class: 'li' }, h('span', { class: 'chip' }, '⚖'), h('span', { class: 'nm' }, d.title, d.rationale ? h('div', { class: 'hint' }, d.rationale) : null), h('span', { class: 'sub' }, [d.date ? R.fmtDay(d.date, false) : '', d.by].filter(Boolean).join(' · '))))), false) : null);
  const facts = b ? R.facts(secBody('Key facts')) : [], links = b ? R.links(secBody('Key links')) : [], contacts = b ? R.table(secBody('Contacts')).filter(c => c.name) : [];
  const right = h('div', { class: 'brief-col' },
    b ? card('Key facts', facts.length ? h('dl', { class: 'facts' }, facts.flatMap(f => [h('dt', {}, f.label), (() => { const d = h('dd'); d.innerHTML = mdRender(f.value).replace(/^<p>|<\/p>\s*$/g, ''); wire(d); return d; })()])) : h('p', { class: 'hint' }, HINT['Key facts'])) : null,
    b ? card('Key links', links.length ? h('div', { class: 'list' }, links.map(l => h('button', { class: 'li', title: l.target, onclick: () => openLink(l) }, icon(l.vault ? 'file' : 'ext'), h('span', { class: 'nm' }, l.label), l.note ? h('span', { class: 'sub' }, l.note) : null))) : h('p', { class: 'hint' }, HINT['Key links'])) : null,
    b ? card('Contacts', contacts.length ? h('div', { class: 'list' }, contacts.map(c => h('div', { class: 'li' }, h('span', { class: 'nm' }, h('b', {}, c.name), h('div', { class: 'hint' }, [c.role, c.organisation || c.organization || c.org].filter(Boolean).join(' · '))), h('span', { class: 'sub' }, c.email ? h('a', { href: 'mailto:' + c.email }, c.email) : '', c.phone ? h('div', {}, c.phone) : null)))) : h('p', { class: 'hint' }, HINT.Contacts)) : null,
    card('Team', h('div', { class: 'list' }, S.plan.resources.map(r => h('div', { class: 'li' }, h('span', { class: 'nm' }, r.name), h('span', { class: 'sub' }, `${S.plan.assignments.filter(a => a.resourceUid === r.uid).length} tasks`)))), false),
    b ? h('button', { class: 'btn ghost', onclick: () => newSectionDialog(A) }, icon('plus'), 'Add a section') : null);
  return h('section', { class: 'pl-view brief' }, top, note, tiles, h('div', { class: 'brief-grid' }, left, right));
}
function coverImg(target) {
  const p = (typeof resolveLink === 'function' && resolveLink(target)) || target;
  return h('img', { class: 'brief-cover', src: rawUrl(p), alt: 'Cover photo', onerror: e => e.target.remove() });
}
function wire(el) {  // [[links]] in the rendered Markdown open the note or file
  el.addEventListener('click', e => {
    const a = e.target.closest('a.wikilink');
    if (!a) return;
    e.preventDefault();
    const p = resolveLink(a.dataset.target);
    p ? openInNotes(p) : toast(`“${a.dataset.target}” isn't in the vault`);
  });
}
function openInNotes(path) { view.tab = 'notes'; render(); openNote(path); }
function openLink(l) {
  if (!l.vault) return window.open(l.target, '_blank', 'noopener');
  const p = resolveLink(l.target) || l.target;
  openInNotes(p);
}
async function startBrief(A) {
  const proj = projectOf(S.plan), roots = (S.sched.outline.kids.get(null) || []).filter(u => S.sched.byUid.get(u).summary).map(u => taskOf(u).name);
  const md = R.briefTemplate({ planId: S.plan.id, name: S.plan.name, client: '', nwa: proj ? `${proj.network}/${proj.activity}` : '', phases: roots });
  Object.assign(S.briefCache, { missing: true });
  if (await saveBrief(R.parseBrief(md))) { toast(`Started ${S.briefCache.path}`); A.redraw(); }
}
function sectionDialog(A, title) {
  const b = S.briefCache.b, ta = h('textarea', { rows: 14, class: 'mono' });
  ta.value = (R.sectionOf(b, title) || {}).body || '';
  const dlg = h('dialog', { class: 'dlg wide', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', onsubmit: async e => {
      e.preventDefault();
      R.setSection(b, title, ta.value.replace(/\s+$/, ''));
      if (await saveBrief(b)) { dlg.close(); A.redraw(); }
    } },
      h('h3', {}, title), h('p', { class: 'hint', style: 'margin:0' }, (HINT[title] ? HINT[title] + ' · ' : '') + 'Markdown, as in Obsidian. [[links]] and ![[images]] work.'), ta,
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'btn primary' }, 'Save'))));
  document.body.append(dlg); dlg.showModal(); ta.focus();
}
function newSectionDialog(A) {
  const name = prompt('Name of the new section (e.g. Permits, Risks to watch, Glossary)');
  if (!name || !name.trim()) return;
  R.setSection(S.briefCache.b, name.trim(), '');
  saveBrief(S.briefCache.b).then(ok => ok && sectionDialog(A, name.trim()));
}
function frontDialog(A) {
  const b = S.briefCache.b, f = b.front;
  const sum = h('textarea', { rows: 2 }); sum.value = f.summary || '';
  const client = h('input', { value: f.client || '' }), cover = h('input', { value: f.cover || '', placeholder: 'Photos/east elevation.jpg (a picture in the vault – optional)', list: 'brief-imgs' });
  const imgs = h('datalist', { id: 'brief-imgs' }, (N.tree || []).filter(x => /\.(png|jpe?g|gif|webp)$/i.test(x.path)).slice(0, 300).map(x => h('option', { value: x.path })));
  const dlg = h('dialog', { class: 'dlg', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', onsubmit: async e => {
      e.preventDefault();
      Object.assign(f, { summary: sum.value.trim().replace(/\s*\n\s*/g, ' '), client: client.value.trim(), cover: cover.value.trim() });
      if (await saveBrief(b)) { dlg.close(); A.redraw(); }
    } },
      h('h3', {}, 'Summary'), h('div', {}, h('label', {}, 'One or two sentences: what this project is'), sum),
      h('div', {}, h('label', {}, 'Client'), client), h('div', {}, h('label', {}, 'Cover photo'), cover, imgs),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'btn primary' }, 'Save'))));
  document.body.append(dlg); dlg.showModal(); sum.focus();
}

// ---------- add an update ----------
export async function updateDialog(A, entry = null) {
  await loadLog();
  const ids = rowIds(), byId = new Map([...ids].map(([u, i]) => [i, u]));
  const kind = h('select', {}, KINDS.map(([v, l, ic]) => h('option', { value: v }, `${ic} ${l}`)));
  kind.value = entry ? entry.kind : 'update';
  const text = h('textarea', { rows: 4, placeholder: 'What happened? Markdown and [[links]] work.' }); text.value = entry ? entry.text : '';
  const tasks = h('input', { placeholder: 'Task IDs, e.g. 8, 13 (optional)', value: entry ? (entry.taskUids || []).map(u => ids.get(u)).filter(Boolean).join(', ') : '' });
  const internal = h('input', { type: 'checkbox', checked: entry && entry.internal ? '' : false });
  const dlg = h('dialog', { class: 'dlg', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', onsubmit: async e => {
      e.preventDefault();
      if (!text.value.trim()) return text.focus();
      const data = { kind: kind.value, text: text.value.trim(), taskUids: tasks.value.split(/[,\s]+/).filter(Boolean).map(n => byId.get(+n)).filter(u => u != null), internal: internal.checked };
      try {
        if (entry) await saveLog(logEntries().map(x => (x.id === entry.id ? { ...x, ...data } : x)));
        else await addLogEntry(data);
      } catch (x) { return toast(x.message); }
      dlg.close(); toast(entry ? 'Update saved' : 'Update added'); A.redraw && A.redraw();
    } },
      h('h3', {}, entry ? 'Edit the update' : `Add an update – ${S.plan.name}`),
      h('div', { class: 'row2' }, h('div', {}, h('label', {}, 'Kind'), kind), h('div', {}, h('label', {}, 'Related tasks'), tasks)),
      h('div', {}, h('label', {}, 'Update'), text),
      h('label', { class: 'sw' }, internal, 'Internal – left out when sharing with the sponsor'),
      h('div', { class: 'btns' },
        entry ? h('button', { type: 'button', class: 'btn danger', style: 'margin-right:auto', onclick: async () => { if (!confirm('Delete this update?')) return; await saveLog(logEntries().filter(x => x.id !== entry.id)); dlg.close(); A.redraw && A.redraw(); } }, 'Delete') : null,
        h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'btn primary' }, entry ? 'Save' : 'Add'))));
  document.body.append(dlg); dlg.showModal(); text.focus();
}

// ---------- Review before sharing ----------
const PERIODS = [['sinceLast', 'Since the last brief'], ['month', 'This month'], ['all', 'The whole project']];
export async function shareDialog(A) {
  const inp = await reportInput();
  const share = S.plan.share || {};
  const presets = { Internal: [], ...Object.fromEntries(Object.entries(share.presets || {}).map(([k, v]) => [k, v.off || []])) };
  let current = share.last && (presets[share.last] || share.last === 'Sponsor') ? share.last : 'Internal';
  let period = share.period || 'sinceLast';
  let removed = current === 'Sponsor' && !share.presets?.Sponsor ? R.sponsorRemoved(S.plan, inp.log) : new Set(presets[current] || []);
  let cover = null;
  if (inp.brief && inp.brief.front.cover) cover = await imageData(inp.brief.front.cover).catch(() => null);
  const frame = h('iframe', { class: 'share-preview', title: 'Preview of the brief', sandbox: 'allow-same-origin' });
  const listBox = h('div', { class: 'share-list' });
  const saveCopy = h('input', { type: 'checkbox', checked: share.keepCopy !== false && state.settings.vaultPath ? '' : false, disabled: state.settings.vaultPath ? false : '' });
  const presetSel = h('select', { onchange: e => {
    current = e.target.value;
    removed = current === 'Sponsor' && !(S.plan.share || {}).presets?.Sponsor ? R.sponsorRemoved(S.plan, inp.log) : new Set(presets[current] || []);
    paint();
  } });
  const periodSel = h('select', { onchange: e => { period = e.target.value; paint(); } }, PERIODS.map(([v, l]) => h('option', { value: v }, l)));
  periodSel.value = period;
  const fillPresets = () => { fill(presetSel, ...['Internal', 'Sponsor', ...Object.keys(presets).filter(k => !['Internal', 'Sponsor'].includes(k))].map(k => h('option', { value: k }, k))); presetSel.value = current; };
  let model = null, timer = null;
  const paint = () => {
    model = R.buildReport(inp, { period, removed });
    const full = R.buildReport(inp, { period });
    const box = (key, label, extra = {}) => h('label', { class: 'share-item' + (extra.sub ? ' sub' : ''), title: label },
      h('input', { type: 'checkbox', checked: removed.has(key) ? false : '', onchange: e => { e.target.checked ? removed.delete(key) : removed.add(key); paint(); } }),
      h('span', {}, label), extra.internal ? h('span', { class: 'chip muted' }, 'internal') : null);
    fill(listBox, R.checklist(full, S.plan, inp.log).map(sec => h('div', { class: 'share-sec' + (removed.has(sec.key) ? ' off' : '') }, box(sec.key, sec.label),
      removed.has(sec.key) ? null : [...sec.sub.map(x => box(x.key, x.label, { sub: true })), ...sec.items.map(it => box(it.key, it.label, { sub: true, internal: it.internal }))])));
    clearTimeout(timer);
    timer = setTimeout(() => { frame.srcdoc = R.renderHtml(model, cover ? { cover } : {}); }, 80);
  };
  const name = `${fmt(new Date())} ${S.plan.name} brief`;
  const finish = async (what, blob) => {
    const s2 = { ...(S.plan.share || {}), last: current, period, lastAt: fmt(new Date()), keepCopy: saveCopy.checked, presets: { ...((S.plan.share || {}).presets || {}), [current]: { off: [...removed] } } };
    if (current === 'Internal') delete s2.presets.Internal;
    patchPlan(p => { p.share = s2; });
    downloadBlob(`${name}.${what}`, blob);
    if (saveCopy.checked) {
      const path = `${R.briefFolder(state.settings.vaultFolder || 'Keystone', projectOf(S.plan) ? projectLabel(projectOf(S.plan)) : S.plan.name)}/Shared/${name}.${what}`;
      try { const j = await api('/api/reports/save', { path, data: await blobB64(blob) }); toast(`Saved – and a copy in ${j.path}`); }
      catch (e) { toast('Downloaded, but the copy in the vault failed: ' + e.message); }
    } else toast('Saved to your downloads');
  };
  const btnHtml = h('button', { type: 'button', class: 'btn primary', onclick: async () => finish('html', new Blob([R.renderHtml(model, cover ? { cover } : {})], { type: 'text/html' })) }, icon('down'), 'HTML brief');
  const btnPpt = h('button', { type: 'button', class: 'btn primary', onclick: async e => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const slides = R.deckSpec(model), plan = model.sections.find(s => s.key === 'plan'), images = {};
      if (plan) { images.gantt = await svgPng(R.ganttSvg(plan, 760)); if (plan.trend.length >= 3) images.trend = await svgPng(R.trendSvg(plan, 760)); }  // drawn small, so the labels read at slide size
      const r = await fetch('/api/reports/pptx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slides, images, name }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The PowerPoint could not be made');
      await finish('pptx', await r.blob());
    } catch (x) { toast(x.message); }
    b.disabled = false;
  } }, icon('down'), 'PowerPoint');
  fillPresets();
  const dlg = h('dialog', { class: 'dlg share-dlg', onclose: () => dlg.remove() },
    h('form', { method: 'dialog', onsubmit: e => e.preventDefault() },
      h('div', { class: 'pl-tools' }, h('h3', { style: 'margin:0' }, `Review before sharing – ${S.plan.name}`), h('div', { class: 'spacer' }), h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg.close() }, icon('x'))),
      h('div', { class: 'share-body' },
        h('div', { class: 'share-side' },
          h('div', { class: 'row2' }, h('div', {}, h('label', {}, 'Preset'), presetSel), h('div', {}, h('label', {}, 'Covers'), periodSel)),
          h('p', { class: 'hint', style: 'margin:4px 0' }, 'Untick anything the sponsor shouldn\'t see. Sponsor leaves out cost by person, hours, problems and items marked internal. Pay rates are never included.'),
          listBox,
          h('div', { class: 'actions', style: 'margin-top:8px' },
            h('button', { type: 'button', class: 'btn sm', onclick: () => { const n = prompt('Save these choices as a preset named', current === 'Internal' ? 'Sponsor' : current); if (!n || !n.trim()) return; presets[n.trim()] = [...removed]; current = n.trim(); patchPlan(p => { p.share = { ...(p.share || {}), presets: { ...((p.share || {}).presets || {}), [current]: { off: [...removed] } } }; }); fillPresets(); toast(`Preset “${current}” saved`); } }, 'Save as preset…'),
            h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { removed = new Set(); paint(); } }, 'Tick everything'))),
        frame),
      h('div', { class: 'btns' },
        h('label', { class: 'sw', style: 'margin-right:auto' }, saveCopy, state.settings.vaultPath ? 'Also keep a copy in the vault (…/Shared/)' : 'Connect a vault to keep copies'),
        btnHtml, btnPpt)));
  document.body.append(dlg); dlg.showModal(); paint();
}
function downloadBlob(name, blob) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name.replace(/[\\/:*?"<>|]/g, '-') });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
const blobB64 = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.readAsDataURL(blob); });
/** An SVG string → a PNG (base64) at 2× for crisp slides. */
function svgPng(svg) {
  if (!svg) return Promise.resolve(null);
  return new Promise((res, rej) => {
    const w = +(/width="(\d+)"/.exec(svg) || [0, 1200])[1], hgt = +(/height="(\d+)"/.exec(svg) || [0, 400])[1];
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = w * 2; c.height = hgt * 2;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.scale(2, 2); g.drawImage(img, 0, 0, w, hgt);
      res(c.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = () => rej(new Error('The chart could not be drawn'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}
/** A vault image → a data URL, downscaled to 1600 px, for the HTML file. */
async function imageData(target) {
  const p = (typeof resolveLink === 'function' && resolveLink(target)) || target;
  const blob = await (await fetch(rawUrl(p))).blob();
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally { URL.revokeObjectURL(url); }
}
