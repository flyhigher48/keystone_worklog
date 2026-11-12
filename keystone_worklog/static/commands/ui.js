// Keystone slash commands – typing them: autocomplete (commands, #projects, @people, [[notes]], plan:, status:, tpl:, in:),
// a live preview line under the box ("→ Log 2 h to Bridge rehab on Tue Nov 10", or what is wrong before you press Enter),
// history with ↑/↓, and the /file-today review table. Uses the page's globals h(), icon() and toast().
import { all, find } from './registry.js';
import { splitChain, splitPipe, parseCommand } from './syntax.js';
import { prepare, expand } from './chain.js';
import { resolve } from './resolve.js';

const HIST_KEY = 'nwa.cmd.history';
const history = () => { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; } };
export function remember(text) {
  try { const h0 = history().filter(x => x !== text); h0.push(text); localStorage.setItem(HIST_KEY, JSON.stringify(h0.slice(-50))); } catch {}
}
const q = s => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** What can complete the word at the caret: [{ label, insert, sub }] plus the command whose signature to show. */
async function suggestions(text, caret, ctx) {
  const before = text.slice(0, caret);
  const line = before.split(/;|\n|\|/).pop().replace(/^\s+/, '');
  const word = (before.match(/(\[\[[^\]]*|"[^"]*|\S*)$/) || [''])[0];
  const cmdName = (line.match(/^\/?([\w-]+)/) || [])[1];
  const cmd = cmdName && find(cmdName, ctx);
  if (/^\/[\w-]*$/.test(line) || (line && !line.startsWith('/') && before.includes('|') && /^[\w-]*$/.test(line))) {  // the command name itself
    const typed = line.replace(/^\//, '').toLowerCase(), slash = line.startsWith('/') ? '/' : '';
    const list = all(ctx).filter(c => !typed || c.name.startsWith(typed) || (c.aliases || []).some(a => a.startsWith(typed)));
    const fuzzy = list.length ? list : resolve(typed, all(ctx), { labels: c => [c.name], min: 0.4 }).suggestions || [];
    return { cmd: null, word: line, items: fuzzy.slice(0, 12).map(c => ({ label: '/' + c.name, insert: slash + c.name + ' ', sub: c.help, sig: c.sig })) };
  }
  let items = [];
  const lc = word.toLowerCase(), has = (s, t) => String(s).toLowerCase().includes(t);
  if (word.startsWith('#')) items = ctx.projects().map(p => ctx.projectLabel(p)).filter(l => has(l, lc.slice(1).replace(/^"/, ''))).map(l => ({ label: '#' + l, insert: '#' + q(l) + ' ' }));
  else if (word.startsWith('@')) items = (await ctx.people()).map(p => p.name).filter(n => has(n, lc.slice(1).replace(/^"/, ''))).map(n => ({ label: '@' + n, insert: '@' + q(n) + ' ' }));
  else if (word.startsWith('[[')) items = (await ctx.notes()).filter(n => n.type === 'note' && has(n.path, lc.slice(2))).slice(0, 40).map(n => { const s = n.path.split('/').pop().replace(/\.md$/i, ''); return { label: s, sub: n.path, insert: `[[${s}]] ` }; });
  else if (/^plan:/i.test(word)) items = (await ctx.plans()).filter(p => has(p.name, lc.slice(5).replace(/^"/, ''))).map(p => ({ label: p.name, insert: 'plan:' + q(p.name) + ' ' }));
  else if (/^status:/i.test(word)) items = (cmdName === 'fu' || cmdName === 'fus' ? ['open', 'waiting', 'done'] : ['todo', 'doing', 'blocked', 'done']).filter(s => s.startsWith(lc.slice(7))).map(s => ({ label: s, insert: 'status:' + s + ' ' }));
  else if (/^code:/i.test(word)) items = ['RG', 'LA', 'LS', 'LH'].map(s => ({ label: s, sub: { RG: 'regular', LA: 'annual leave', LS: 'sick leave', LH: 'holiday' }[s], insert: 'code:' + s + ' ' }));
  else if (/^tpl:/i.test(word)) items = (await ctx.templates()).filter(t => has(t.name, lc.slice(4).replace(/^"/, ''))).map(t => ({ label: t.name, insert: 'tpl:' + q(t.name) + ' ' }));
  else if (/^in:/i.test(word)) {
    const dirs = [...new Set((await ctx.notes()).map(n => n.path.split('/').slice(0, -1).join('/')).filter(Boolean))].sort();
    items = dirs.filter(d => has(d, lc.slice(3).replace(/^"/, ''))).slice(0, 30).map(d => ({ label: d, insert: 'in:' + q(d) + ' ' }));
  } else if (cmd && line.split(/\s+/).length === 2) {  // first word after a command that takes a fixed set
    const opts = { go: ctx.tabs().map(t => t[0]), help: all(ctx).map(c => c.name), theme: ['light', 'dark'], run: Object.keys(ctx.routines()), timer: ['start', 'stop', 'discard'],
      away: ['annual', 'sick', 'travel', 'other'], update: ['win', 'problem', 'decision', 'contact', 'site', 'lesson'], 'close-week': ['green', 'amber', 'red'],
      cards: ['overdue', 'today', 'week', 'all', 'doing', 'blocked'], fus: ['overdue', 'today', 'open', 'waiting', 'all'], todos: ['overdue', 'today', 'week', 'done', 'all'], log: ['day'] }[cmd.name];
    if (opts && word) items = opts.filter(o => o.startsWith(lc) && o !== lc).map(o => ({ label: o, insert: o + ' ' }));
  }
  return { cmd, word, items: items.slice(0, 12) };
}

/** What the line would do, without doing it: "→ …" or "⚠ …". Builds against a ctx that can't run the embedding model. */
export async function previewLine(text, ctx) {
  const ex = expand(text, ctx);
  if (ex.error) return { error: ex.error };
  const out = [];
  for (const seg of ex.segs) {
    const stages = splitPipe(seg);
    if (/(^|\s)\$(\s|$)/.test(seg)) { out.push(seg); continue; }
    const r = await prepare(stages[0], { ...ctx, embedQuery: null });
    if (r.error) return { error: (ex.segs.length > 1 ? `${seg}: ` : '') + r.error, choices: r.choices };
    out.push(r.plan.describe.split('\n').join(' · ') + (stages.length > 1 ? ` → then ${stages.slice(1).join(' → ')}` : ''));
  }
  return { text: out.length > 1 ? `${out.length} commands: ${out.join('  ·  ')}` : out[0] };
}

/**
 * Adds command typing to a text box. opts.ctx() gives the command context; opts.onPick(cmd) runs a suggested fix.
 * Returns { pop, hint, close } – the caller places pop (absolutely, above the box) and hint (below it).
 */
export function attach(input, opts) {
  const pop = h('div', { class: 'cmd-pop', role: 'listbox', hidden: '' }), hint = h('div', { class: 'cmd-hint', 'aria-live': 'polite' });
  let items = [], sel = 0, word = '', hi = -1, timer = 0, seq = 0;
  const close = () => { pop.hidden = true; items = []; };
  const paint = (sig) => {
    pop.replaceChildren(...(sig ? [h('div', { class: 'cmd-sig' }, sig)] : []), ...items.map((it, k) => h('button', { type: 'button', class: 'cmd-item' + (k === sel ? ' on' : ''), role: 'option', 'aria-selected': String(k === sel),
      onmousedown: e => { e.preventDefault(); accept(k); } }, h('b', {}, it.label), it.sub ? h('span', { class: 'sub' }, it.sub) : null)));
    pop.hidden = !items.length && !sig;
    if (items.length) input.setAttribute('aria-activedescendant', '');
  };
  const accept = k => {
    const it = items[k];
    if (!it) return;
    const caret = input.selectionStart, start = caret - word.length;
    input.value = input.value.slice(0, start) + it.insert + input.value.slice(caret);
    input.selectionStart = input.selectionEnd = start + it.insert.length;
    input.dispatchEvent(new Event('input'));
    input.focus();
  };
  const update = async () => {
    const text = input.value, my = ++seq;
    if (!text.trimStart().startsWith('/') && !text.includes('|')) { close(); hint.replaceChildren(); return; }
    const ctx = opts.ctx();
    const s = await suggestions(text, input.selectionStart, ctx);
    if (my !== seq) return;
    items = s.items; sel = 0; word = s.word || '';
    paint(s.cmd && !items.length ? null : s.cmd ? s.cmd.sig : null);
    if (!items.length && s.cmd) { pop.replaceChildren(h('div', { class: 'cmd-sig' }, s.cmd.sig)); pop.hidden = false; }
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (my !== seq) return;
      const pv = await previewLine(text, ctx).catch(e => ({ error: e.message }));
      if (my !== seq) return;
      hint.className = 'cmd-hint' + (pv.error ? ' bad' : '');
      hint.replaceChildren(pv.error ? '⚠ ' + pv.error : '→ ' + pv.text, ...((pv.choices || []).slice(0, 4).map(c => h('button', { type: 'button', class: 'chip', onmousedown: e => { e.preventDefault(); input.value = c.cmd; input.dispatchEvent(new Event('input')); input.focus(); } }, c.label))));
    }, 220);
  };
  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', e => {
    if (!pop.hidden && items.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % items.length; paint(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % items.length; paint(); return; }
      if (e.key === 'Tab') { e.preventDefault(); accept(sel); return; }
      if (e.key === 'Enter' && !e.shiftKey && /^\/[\w-]*$/.test(input.value.trim()) && !find(input.value.trim().slice(1), opts.ctx())) { e.preventDefault(); e.stopImmediatePropagation(); accept(sel); return; }
    }
    if (e.key === 'Escape' && !pop.hidden) { e.preventDefault(); close(); return; }
    const hs = history();
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && hs.length && !input.value.includes('\n') && (input.value === '' || input.value.startsWith('/'))) {
      if (e.key === 'ArrowUp' && hi === -1 && input.value && !hs.includes(input.value)) return;
      e.preventDefault();
      hi = e.key === 'ArrowUp' ? (hi < 0 ? hs.length - 1 : Math.max(0, hi - 1)) : hi < 0 ? -1 : hi + 1;
      if (hi >= hs.length) hi = -1;
      input.value = hi < 0 ? '' : hs[hi];
      input.dispatchEvent(new Event('input'));
    } else if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') hi = -1;
  }, true);
  return { pop, hint, close, clear: () => { close(); hint.replaceChildren(); } };
}

/**
 * /file-today: one table of the day's captures with where each goes. Nothing is filed by guess: lines without a
 * #project start as "leave it", with suggestions from similar notes. Apply files the ticked rows and marks each line
 * "→ [[where it went]]" in Today.md. Resolves to { card, undo } or { stopped }.
 */
export function fileToday(ctx, d, rows) {
  return new Promise(async done => {
    const heading = ctx.commandSettings().fileHeading || 'Log';
    for (const r of rows) {
      r.options = [{ label: 'Leave it', kind: 'leave' }];
      const pn = r.proj && ctx.projectNote(r.proj);
      if (r.kind === 'card') r.options.unshift({ label: `Board card${r.proj ? ' · ' + ctx.projectLabel(r.proj) : ''}${r.due ? ' · due ' + r.due : ''}`, kind: 'card' });
      if (r.kind === 'followup') r.options.unshift({ label: `Follow-up${r.from ? ' · ' + r.from : ''}`, kind: 'followup' });
      if (pn) r.options.splice(r.kind === 'note' ? 0 : r.options.length - 1, 0, { label: `${pn.split('/').pop().replace(/\.md$/, '')} › ${heading}`, kind: 'note', path: pn });
      if (r.kind === 'ask' && ctx.embedQuery) {
        try {
          const j = await ctx.read('search_notes', { query: r.text, limit: 5, vector: await ctx.embedQuery(r.text) });
          (j.data || []).filter(x => /\.md$/i.test(x.path) && x.path !== ctx.captureFile()).slice(0, 3).forEach(x => r.options.push({ label: `${x.path.replace(/\.md$/, '')} › ${heading} (similar)`, kind: 'note', path: x.path }));
        } catch {}
      }
      r.choice = 0;
      r.on = r.options[0].kind !== 'leave';
    }
    const go = h('button', { type: 'button', class: 'btn primary' }, 'File');
    const count = () => { const n = rows.filter(r => r.on && r.options[r.choice].kind !== 'leave').length; go.textContent = n ? `File ${n} line${n > 1 ? 's' : ''}` : 'File'; go.disabled = !n; };
    const table = h('table', { class: 'mv-table' }, h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Line'), h('th', {}, 'Goes to'))),
      h('tbody', {}, rows.map(r => {
        const box = h('input', { type: 'checkbox', checked: r.on || null, onchange: e => { r.on = e.target.checked; count(); } });
        const selEl = h('select', { onchange: e => { r.choice = Number(e.target.value); r.on = r.options[r.choice].kind !== 'leave'; box.checked = r.on; count(); } }, r.options.map((o, k) => h('option', { value: k }, o.label)));
        return h('tr', {}, h('td', {}, box), h('td', {}, r.x.text), h('td', {}, selEl));
      })));
    let finished = false;
    const dlg = h('dialog', { class: 'dlg wide', onclose: () => { dlg.remove(); if (!finished) done({ stopped: 'cancelled' }); } },
      h('form', { method: 'dialog', onsubmit: e => e.preventDefault() }, h('h3', {}, `File ${d.heading}`),
        h('p', { class: 'hint', style: 'margin:0' }, `Lines tagged with a #project go to its note under “${heading}”; todos with a project or date become Board cards; replies become follow-ups. Untagged lines stay unless you pick a note.`),
        table, h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel'), go)));
    go.onclick = async () => {
      go.disabled = true;
      const undo = [], marks = {}, fails = [];
      for (const r of rows.filter(r => r.on && r.options[r.choice].kind !== 'leave')) {
        const o = r.options[r.choice];
        let res, mark;
        try {
          if (o.kind === 'card') { res = await ctx.withApply(true, () => ctx.runTool('add_deliverable', { title: r.text, ...(r.proj ? { project: ctx.projectLabel(r.proj) } : {}), ...(r.due ? { due: r.due } : {}), ...(r.done ? { status: 'done' } : {}) })); mark = 'Board'; }
          else if (o.kind === 'followup') { res = await ctx.withApply(true, () => ctx.runTool('add_followup', { from: r.from, subject: r.subject, ...(r.proj ? { project: ctx.projectLabel(r.proj) } : {}), ...(r.due ? { due: r.due } : {}) })); mark = 'Follow-ups'; }
          else {
            const text = (await ctx.readNote(o.path)) || '', line = `- ${d.heading}: ${r.text}`;
            const hasHead = new RegExp(`^#{1,6}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi').test(text);
            res = await ctx.withApply(true, () => ctx.runTool('append_to_note', hasHead ? { path: o.path, text: line, under_heading: heading } : { path: o.path, text: `## ${heading}\n${line}` }));
            mark = `[[${o.path.split('/').pop().replace(/\.md$/i, '')}]]`;
          }
          if (res.state === 'error' || /^Error/.test(res.text || '')) throw new Error(String(res.text).replace(/^Error:\s*/, ''));
          if (res.undoable) undo.push(res.id);
          marks[r.x.i] = r.x.line.replace(/\s*$/, ` → ${mark}`);
        } catch (e) { fails.push(`${r.text}: ${e.message}`); }
      }
      if (Object.keys(marks).length) {
        const fresh = await ctx.readNote(d.path), { sectionLines, sectionEdit } = await import('./registry.js');
        const sec = fresh === d.text && sectionLines(fresh, d.heading);
        if (!sec) fails.push(`${d.path} changed while this was open, so the filed lines were not marked`);
        else { const res = await ctx.withApply(true, () => ctx.runTool('edit_note', { path: d.path, ...sectionEdit(sec, marks) })); if (res.undoable) undo.push(res.id); }
      }
      finished = true; dlg.close();
      done({ undo, card: { title: `Filed ${Object.keys(marks).length} of ${rows.length} lines from ${d.heading}`, md: fails.length ? fails.map(f => `- ⚠ ${f}`).join('\n') : '' } });
    };
    count();
    document.body.append(dlg); dlg.showModal();
  });
}
