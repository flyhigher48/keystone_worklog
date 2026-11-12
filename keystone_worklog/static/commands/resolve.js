// Keystone slash commands – turning a name the user typed into one item (a project, note, card, plan, person…).
// Exact → same letters → starts with → every word → contains → close spelling. Several near-equal matches are never
// guessed between: the caller gets them back as choices. Pure, no page globals.

export const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const squash = s => norm(s).replace(/ /g, '');

/** Similarity of two short strings by edit distance, 0..1. */
export function similar(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) / 2) return 0;
  // edit distance where swapping two neighbouring letters counts as one edit ("lgo" → "log")
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}

/** How well query q matches a label, 0..1. */
export function score(q, label) {
  const nq = norm(q), nl = norm(label);
  if (!nq || !nl) return 0;
  if (nq === nl) return 1;
  const sq = squash(q), sl = squash(label);
  if (sq === sl) return 0.98;
  const qw = nq.split(' '), lw = nl.split(' ');
  // starts the name or any word of it: "bridge" fits "Bridge deck inspection" and "Girder Bridge rehab" equally, and
  // "r" fits "Runway lighting", "Culvert C-12 replacement" and "Girder Bridge rehab" equally (so it asks, never guesses)
  if (sl.startsWith(sq) || (qw.length === 1 && lw.some(x => x.startsWith(nq)))) return 0.9 + 0.05 * (sq.length / sl.length);
  if (qw.every(w => lw.some(x => x.startsWith(w)))) return 0.8 + 0.1 * (sq.length / sl.length);
  if (sl.includes(sq) && sq.length >= 3) return 0.72 + 0.1 * (sq.length / sl.length);
  // close spelling: the whole thing, or the best word for a one-word query ("brdge" → "Girder Bridge rehab")
  const whole = similar(sq, sl), word = qw.length === 1 ? Math.max(...lw.map(x => similar(nq, x))) : 0;
  return Math.max(whole, word) * 0.8;  // one wrong letter in six (0.83) still counts; below 0.75 similar it doesn't
}

/**
 * Finds the item a query means.
 * opts.labels(item) → [names it can be called by]; min: lowest score that counts; margin: a runner-up this close is a tie.
 * Returns { item } | { choices: [items] } | { none: true, suggestions: [items] }.
 */
export function resolve(q, items, { labels = x => [x.label ?? x], min = 0.6, margin = 0.06, max = 6 } = {}) {
  const ranked = items.map(item => ({ item, s: Math.max(0, ...labels(item).filter(Boolean).map(l => score(q, l))) }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  if (!ranked.length || ranked[0].s < min) return { none: true, suggestions: ranked.filter(x => x.s >= 0.35).slice(0, 3).map(x => x.item) };
  const top = ranked[0].s;
  const near = ranked.filter(x => x.s >= Math.max(min, top - margin));
  if (near.length === 1) return { item: near[0].item };
  const exact = near.filter(x => x.s >= 0.98);
  if (exact.length === 1) return { item: exact[0].item };
  return { choices: near.slice(0, max).map(x => x.item) };
}
