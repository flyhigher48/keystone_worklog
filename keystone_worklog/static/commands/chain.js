// Keystone slash commands – running a line: routines expanded, chains (;  new line  then), pipes (|), $ (what the previous
// command made), one combined preview for several changes, stop at the first failure, and "Undo all".
import { splitChain, splitPipe, parseCommand, tokenize } from './syntax.js';
import { find, all, expandRoutine, quote } from './registry.js';
import { resolve } from './resolve.js';

const MAX_SEGMENTS = 40, MAX_DEPTH = 4;

/** Words after the command, as they were typed (quotes kept), for routine arguments. */
const argsOf = p => tokenize(p.rest).map(t => (t.q ? quote(t.v) : t.v));

/** A line → the commands to run, with routines replaced by their lines. Returns { segs } or { error }. */
export function expand(text, ctx, depth = 0) {
  const segs = [];
  for (const seg of splitChain(text)) {
    const p = parseCommand(splitPipe(seg.replace(/^\?/, ''))[0]);  // a leading ? (in routines) means "skip it if it doesn't apply"
    const c = p && find(p.cmd, ctx);
    let routine = c && c.routine, args = p ? argsOf(p) : [];
    if (c && c.routineRunner) {
      const name = String(args[0] || '').replace(/^\//, ''), r = (ctx.routines() || {})[name];
      if (!r) return { error: name ? `There is no routine called “${name}”. /routines lists them.` : 'Name a routine, e.g. /run eod' };
      routine = r; args = args.slice(1);
    }
    if (routine) {
      if (depth >= MAX_DEPTH) return { error: 'Routines call each other too deeply (a loop?).' };
      const inner = expand(expandRoutine(routine, args).join('\n'), ctx, depth + 1);
      if (inner.error) return inner;
      segs.push(...inner.segs);
    } else segs.push(seg);
    if (segs.length > MAX_SEGMENTS) return { error: `That is more than ${MAX_SEGMENTS} commands at once.` };
  }
  return { segs };
}

/** Parses and builds one pipe stage. Returns { p, cmd, plan } or { error, choices }. */
export async function prepare(stage, ctx, input) {
  const p = parseCommand(stage.startsWith('/') ? stage : '/' + stage);
  if (!p) return { error: `“${stage}” isn't a command. Commands start with /, e.g. /help` };
  const cmd = find(p.cmd, ctx);
  if (!cmd) {
    const r = resolve(p.cmd, all(ctx), { labels: c => [c.name, ...(c.aliases || [])], min: 0.5 });
    const near = r.item ? [r.item] : r.choices || r.suggestions || [];
    return { error: `There is no /${p.cmd}.`, choices: near.map(c => ({ label: `/${c.name}`, cmd: stage.replace(/^\/?\S+/, '/' + c.name) })).concat([{ label: 'All commands', cmd: '/help' }]) };
  }
  if (input && !cmd.accepts) return { error: `/${cmd.name} can't take a list from a pipe. These can: ${all(ctx).filter(c => c.accepts).map(c => '/' + c.name).join(', ')}` };
  try {
    const plan = await cmd.build(p, ctx, input);
    return plan.error ? plan : { p, cmd, plan };
  } catch (e) { return { error: e.message }; }
}

/** Runs one plan's steps. apply: true = no approval needed, false = ask for each change. */
async function execPlan(plan, ctx, apply, input) {
  let out = null;
  const undo = [], calls = [];
  for (const st of plan.steps) {
    if (st.tool) {
      const r = await ctx.withApply(st.quiet ? true : apply, () => ctx.runTool(st.tool, st.args));
      calls.push({ name: st.tool, args: st.args, result: r.text });
      if (r.undoable) undo.push(r.id);
      if (r.state === 'rejected') return { stopped: 'rejected', undo, calls };
      if (r.state === 'error' || /^Error/.test(r.text || '')) throw Object.assign(new Error(String(r.text || 'failed').replace(/^Error:\s*/, '')), { undo, calls });
      out = { text: r.text, data: r.data };
    } else {
      out = await st.run(ctx, out || input);
      if (out && out.undo) undo.push(...out.undo);
      if (out && out.stopped) return { stopped: out.stopped, undo, calls };
    }
  }
  return { out: { ...(out || {}), main: (out && out.main) || plan.main }, undo, calls };
}

const writes = plan => plan.steps.filter(s => s.write && !s.quiet).length;

/**
 * Runs a line of commands. ctx.chat shows what happens; returns { ok, error }.
 * Every command is built (parsed, names looked up) before anything runs, so a typo in step 3 stops before step 1 writes.
 */
export async function run(text, ctx, { echo = true } = {}) {
  text = String(text || '').trim();
  if (echo) ctx.chat.user(text);
  const ex = expand(text, ctx);
  if (ex.error) { ctx.chat.card({ title: ex.error, error: true }); return { error: ex.error }; }
  const segs = ex.segs, n = segs.length, label = i => (n > 1 ? `Step ${i + 1} (${segs[i]}): ` : '');
  const confirm = (ctx.commandSettings().confirm) || 'writes';

  // dry run: parse and build every command that doesn't depend on an earlier one ($, or input from a pipe)
  const prepared = [];
  for (let i = 0; i < n; i++) {
    const optional = segs[i].startsWith('?');
    if (optional) segs[i] = segs[i].slice(1).trim();
    const stages = splitPipe(segs[i]), later = /(^|\s)\$(\s|$)/.test(segs[i]);
    for (const st of stages.slice(1)) {  // the pipe's receivers must exist and take a list
      const q = parseCommand(st.startsWith('/') ? st : '/' + st), c = q && find(q.cmd, ctx);
      if (!c) { const e = `${label(i)}there is no /${q ? q.cmd : st} to pipe into.`; ctx.chat.card({ title: e, error: true }); return { error: e }; }
      if (!c.accepts) { const e = `${label(i)}/${c.name} can't take a list from a pipe.`; ctx.chat.card({ title: e, error: true }); return { error: e }; }
    }
    let first = null;
    if (!later) {
      first = await prepare(stages[0], ctx);
      if (first.error && optional) { prepared.push({ seg: segs[i], stages, skip: first.error }); continue; }
      if (first.error) {
        ctx.chat.card({ title: label(i) + first.error, error: true, choices: (first.choices || []).map(c => ({ ...c, cmd: n > 1 ? segs.map((s, k) => (k === i ? c.cmd : s)).join(' ; ') : c.cmd })) });
        return { error: first.error };
      }
    }
    prepared.push({ seg: segs[i], stages, first, later });
  }

  // one combined preview when several things change at once; bulk changes always ask
  const skipped = prepared.filter(x => x.skip);
  if (skipped.length) ctx.chat.card({ title: `Skipped ${skipped.map(x => x.seg.split(/\s/)[0]).join(', ')}`, md: skipped.map(x => `- ${x.seg}: ${x.skip}`).join('\n') });
  const active = prepared.filter(x => !x.skip);
  const many = active.length > 1 || active.some(x => x.stages.length > 1);
  const bulk = active.some(x => x.first && x.first.plan.bulk);
  const changeCount = active.reduce((t, x) => t + (x.first ? writes(x.first.plan) : 1), 0);
  const combined = changeCount > 0 && (bulk || ((many || changeCount > 1) && confirm !== 'never'));
  let apply = confirm === 'never';
  let rows = null;
  if (combined) {
    rows = prepared.flatMap((x, i) => {
      if (x.skip) return [];
      const pl = x.first && x.first.plan, w = pl ? pl.steps.filter(s => s.write) : [];
      if (pl && pl.bulk) return w.map((s, k) => ({ seg: i, step: k, label: s.label, on: true }));
      return [{ seg: i, label: (pl ? pl.describe : x.seg) + (x.stages.length > 1 ? `  →  then ${x.stages.slice(1).join(' → ')}` : ''), on: true }];
    });
    const card = ctx.chat.card({ title: bulk && active.length === 1 ? active[0].first.plan.describe : `Run ${plural(active.length, 'command')}`, rows, pending: true });
    if (!(await ctx.chat.decide(card))) return { error: 'rejected' };
    apply = true;
  } else if (changeCount && confirm === 'bulk') apply = true;

  // run, in order
  let prev = null;
  const undo = [], calls = [];
  for (let i = 0; i < prepared.length; i++) {
    const x = prepared[i];
    if (x.skip) continue;
    if (rows && !rows.some(r => r.seg === i && r.on)) continue;
    try {
      let cur = x.first;
      if (x.later) {
        const seg = x.seg.replace(/(^|\s)\$(?=\s|$)/g, (_, a) => a + quote((prev && prev.main) || ''));
        cur = await prepare(splitPipe(seg)[0], ctx);
        if (cur.error) throw new Error(cur.error);
      }
      if (rows && cur.plan.bulk) {  // the rows the user unticked in the preview are left out
        const ws = cur.plan.steps.filter(s => s.write), on = s => (rows.find(r => r.seg === i && r.step === ws.indexOf(s)) || { on: true }).on;
        cur = { ...cur, plan: { ...cur.plan, steps: cur.plan.steps.filter(s => !s.write || on(s)) } };
      }
      let res = await execPlan(cur.plan, ctx, apply);
      undo.push(...res.undo); calls.push(...res.calls);
      if (res.stopped) { ctx.chat.card({ title: `${label(i)}stopped: the change was ${res.stopped}.${i + 1 < prepared.length ? ' Nothing after it ran.' : ''}`, error: true }); return finish(); }
      let out = res.out;
      for (const st of x.stages.slice(1)) {  // the pipe: each receiver gets the list the previous stage made
        if (out.card) ctx.chat.card(out.card);
        const input = out.type ? { type: out.type, items: out.items || [], notes: out.notes } : out.notes ? { type: 'notes', items: out.notes, notes: out.notes } : null;
        if (!input || !(input.items || []).length) throw new Error(`/${cur.cmd.name} gave nothing to pass on to ${st}.`);
        const nxt = await prepare(st, ctx, input);
        if (nxt.error) throw new Error(nxt.error);
        res = await execPlan(nxt.plan, ctx, apply, input);
        undo.push(...res.undo); calls.push(...res.calls);
        if (res.stopped) { ctx.chat.card({ title: `${label(i)}stopped: the change was ${res.stopped}.`, error: true }); return finish(); }
        out = res.out; cur = nxt;
      }
      if (out.card) ctx.chat.card(out.card);
      else if (!res.calls.length && out.text) ctx.chat.card({ title: '✓ ' + cur.plan.describe });
      prev = out;
    } catch (e) {
      undo.push(...(e.undo || [])); calls.push(...(e.calls || []));
      ctx.chat.card({ title: `${label(i)}${e.message}${i + 1 < prepared.length ? ' Nothing after it ran.' : ''}`, error: true });
      return finish(e.message);
    }
  }
  return finish();

  function finish(error) {
    if (undo.length > 1) ctx.chat.card({ title: `${plural(undo.length, 'change')} made`, actions: [{ label: 'Undo all', undo: [...undo].reverse() }] });
    ctx.chat.record(text, calls, prev && prev.card ? `${prev.card.title}\n${prev.card.md || prev.card.pre || ''}` : '');
    return error ? { error } : { ok: true };
  }
}
const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
