// Grouping engine. Pure: photos in, groups out; no DOM, no app state, so it runs in Node tests.
//
// Algorithm: "capped complete-linkage over a time-relaxed candidate graph".
//  1. Candidate edges (precomputed once per library, ~70-100 ms for 7k photos):
//       - every pair taken <= 1 h apart with distance <= MAX_EDGE_D (the loosest slider), and
//       - every pair with distance <= NEAR_DUP at ANY time gap, including undated photos, among
//         pairs whose 64-bit pHashes differ in <= NEAR_DUP bits, found by LSH (NEAR_DUP+1 bands
//         => exact by pigeonhole). Copies and re-saves keep their pHash, so this finds them; with
//         the classic score it finds every such pair, as that score is never below the pHash distance.
//  2. On every slider change (~5 ms): walk edges in ascending distance. An edge is usable if
//       d <= threshold(dt): T inside the time window W, relaxing (log-time) towards NEAR_DUP
//       as the gap grows; NEAR_DUP beyond 1 h or when a date is unknown.
//     Two groups merge only if EVERY cross pair is within CAP = T + 6 (complete linkage),
//     so a group can never chain into photos that don't look alike (max diameter = CAP).
//     Frames sharing an iCloud burst id (p.burst) start out as one set, whatever their scores.
//  3. Sets shot minutes apart that the uncapped (single-linkage) pass joined, or that look like
//     the same scene, share a card ("moment"). Each set still keeps its own best photo.
//
// T = simThreshold(slider) (CAP = T + 6 follows it), W = full-strength time window in seconds.

import { distance, hashDistance, SIM_OFFSET } from './signature.js';

const NEAR_DUP = 6;           // copies / re-saves are matched at any time gap up to this score
const CAP_SLACK = 6;          // group diameter cap = T + CAP_SLACK
const MAX_WIN_S = 3600;       // largest time window on the slider
const MAX_EDGE_D = SIM_OFFSET + 16; // score at the loosest Similarity setting
const RELAX_HORIZON_S = 86400;
const BULK_STAMP = 20;        // > this many photos sharing one exact timestamp => treat as undated (imports)
// Moments are mostly about WHEN photos were taken: sets shot within MOMENT_TIGHT_S of each other
// share a card unless they look completely different; up to the time window they need to look
// like the same scene. Display only — each set still keeps its own best photo.
const MOMENT_TIGHT_S = 120;
const TIGHT_SLACK = 20;       // within 2 min: anything but a totally different picture
const SCENE_SLACK = 12;       // within the time window: recognisably the same scene
const MOMENT_GAP_S = 300;     // time-window floor for moments

// Pairs whose pHashes differ in <= NEAR_DUP bits share at least one band.
function bandKeys(p, bands) {
  const keys = [];
  for (let k = 0; k < bands; k++) {
    const lo = Math.round((k * 64) / bands), hi = Math.round(((k + 1) * 64) / bands);
    let key = k * 1e6;
    for (let b = lo; b < hi; b++) key = key * 2 + (b < 32 ? (p.hash[0] >>> b) & 1 : (p.hash[1] >>> (b - 32)) & 1);
    keys.push(`${k}:${key}`);
  }
  return keys;
}

export function buildGraph(items, score = distance) {
  const xs = items.filter((p) => p.hash).sort((a, b) => a.date - b.date);
  const n = xs.length;
  const stampCount = new Map();
  for (const p of xs) stampCount.set(p.date, (stampCount.get(p.date) || 0) + 1);
  const when = xs.map((p) => (p.date > 0 && stampCount.get(p.date) <= BULK_STAMP ? p.date : NaN));

  const edges = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(when[i])) continue;
    for (let j = i + 1; j < n && xs[j].date - xs[i].date <= MAX_WIN_S * 1000; j++) {
      if (Number.isNaN(when[j])) continue;
      const d = score(xs[i], xs[j], MAX_EDGE_D);
      if (d <= MAX_EDGE_D) { edges.push([i, j, d, (when[j] - when[i]) / 1000]); seen.add(i * n + j); }
    }
  }
  const buckets = new Map();
  xs.forEach((p, i) => {
    for (const key of bandKeys(p, NEAR_DUP + 1)) {
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(i);
    }
  });
  for (const b of buckets.values()) {
    for (let x = 0; x < b.length; x++) {
      for (let y = x + 1; y < b.length; y++) {
        const i = b[x], j = b[y], key = i * n + j;
        if (seen.has(key)) continue;
        seen.add(key);
        if (hashDistance(xs[i], xs[j]) > NEAR_DUP) continue;
        const d = score(xs[i], xs[j], NEAR_DUP);
        const dt = Math.abs(when[j] - when[i]) / 1000; // NaN if either is undated
        if (d <= NEAR_DUP) edges.push([i, j, d, Number.isNaN(dt) ? Infinity : dt]);
      }
    }
  }
  edges.sort((a, b) => a[2] - b[2] || a[3] - b[3]);
  const m = edges.length;
  const g = { src: items, len: items.length, hashed: n, score, n, xs,
    ei: new Int32Array(m), ej: new Int32Array(m), ed: new Float32Array(m), et: new Float64Array(m) };
  edges.forEach(([i, j, d, dt], k) => { g.ei[k] = i; g.ej[k] = j; g.ed[k] = d; g.et[k] = dt; });
  return g;
}

// Max distance allowed for a pair taken dt seconds apart.
export function threshold(dt, T, W) {
  const G = Math.min(NEAR_DUP, T);
  if (dt <= W) return T;
  if (dt > MAX_WIN_S) return G; // also undated (Infinity)
  return T - ((T - G) * Math.log(dt / W)) / Math.log(RELAX_HORIZON_S / W);
}

// Best photo first: favorite, then resolution (within ~15% counts as equal), then exposure (share of
// crushed / blown pixels, in 10% steps), then sharpness, then size.
const resBucket = (p) => Math.round(Math.log(Math.max(1, p.w * p.h)) / Math.log(1.15));
const expoBucket = (p) => Math.floor((p.expo || 0) * 10);
export function rank(a, b) {
  return (b.fav - a.fav) || (resBucket(b) - resBucket(a)) || (expoBucket(a) - expoBucket(b)) ||
    (b.sharp - a.sharp) || (b.size - a.size);
}

export function keepReason(g) {
  const [a, b] = g;
  if (a.fav !== b.fav) return 'favorite';
  if (resBucket(a) !== resBucket(b)) return 'highest resolution';
  if (expoBucket(a) !== expoBucket(b)) return 'best exposed';
  if (a.sharp !== b.sharp) return 'sharpest';
  return a.size !== b.size ? 'largest file' : 'first shot';
}

export const groupKey = (g) => g.map((p) => p.id).sort().join(',');

// Suggestion before any clicks: each set keeps its best photo and every favorite, so a different
// pose is never marked for deletion just because it shares a card.
export const suggestDelete = (p) => p !== p.set[0] && !p.fav;

let graph = null; // reused while the library (and its analysed photos) is unchanged

// score(a, b, limit): pair score, signature.js distance() unless a test swaps in another formula.
// Returns moments: arrays of photos (sets concatenated, each set keeper first) with
// g.sets = the sets and g.start = earliest timestamp. Sets p.set on every grouped photo.
export function group(items, T, W, score = distance) {
  const cap = T + CAP_SLACK;
  if (!graph || graph.src !== items || graph.len !== items.length || graph.score !== score ||
      graph.hashed !== items.reduce((c, p) => c + (p.hash ? 1 : 0), 0)) graph = buildGraph(items, score);
  const { n, xs, ei, ej, ed, et } = graph;

  // Capped complete linkage (sets) + plain union-find (related sets), same usable edges.
  const parent = new Int32Array(n), fam = new Int32Array(n);
  for (let i = 0; i < n; i++) { parent[i] = i; fam[i] = i; }
  const members = xs.map((_, i) => [i]);
  const find = (a, i) => { while (a[i] !== i) { a[i] = a[a[i]]; i = a[i]; } return i; };
  const failed = new Map();
  const merge = (a, b) => {
    if (members[a].length < members[b].length) [a, b] = [b, a];
    parent[b] = a;
    for (const m of members[b]) members[a].push(m);
    members[b] = null;
  };
  // Frames of one iCloud burst are a set by definition, however different they look.
  const burstOf = new Map();
  xs.forEach((p, i) => {
    if (!p.burst) return;
    if (!burstOf.has(p.burst)) { burstOf.set(p.burst, i); return; }
    const a = find(parent, burstOf.get(p.burst)), b = find(parent, i);
    if (a !== b) merge(a, b);
    fam[find(fam, i)] = find(fam, burstOf.get(p.burst));
  });
  for (let k = 0; k < ei.length; k++) {
    const d = ed[k];
    if (d > T) break; // edges are sorted by distance
    if (d > threshold(et[k], T, W)) continue;
    const fa = find(fam, ei[k]), fb = find(fam, ej[k]);
    if (fa !== fb) fam[fb] = fa;
    let a = find(parent, ei[k]), b = find(parent, ej[k]);
    if (a === b) continue;
    const A = members[a], B = members[b];
    const key = a < b ? a * n + b : b * n + a, size = A.length + B.length;
    if (failed.get(key) === size) continue;
    let ok = true;
    outer: for (const x of A) for (const y of B) if (score(xs[x], xs[y], cap) > cap) { ok = false; break outer; }
    if (!ok) { failed.set(key, size); continue; }
    merge(a, b);
  }

  // Sets of near-identical shots (complete linkage keeps each set tight).
  for (const p of xs) p.set = null;
  const sets = [];
  for (let i = 0; i < n; i++) {
    if (parent[i] !== i || members[i].length < 2) continue;
    const set = members[i].map((k) => xs[k]).sort(rank);
    set.family = find(fam, i);
    const dated = set.filter((p) => p.date > 0).map((p) => p.date);
    set.start = dated.length ? Math.min(...dated) : NaN;
    set.end = dated.length ? Math.max(...dated) : NaN;
    for (const p of set) p.set = set;
    sets.push(set);
  }

  // Moments: join sets that the loose (uncapped) pass linked, or that were taken within a few
  // minutes of each other and still look like the same scene.
  const momentOf = sets.map((_, i) => i);
  const root = (i) => { while (momentOf[i] !== i) { momentOf[i] = momentOf[momentOf[i]]; i = momentOf[i]; } return i; };
  const join = (a, b) => { a = root(a); b = root(b); if (a !== b) momentOf[b] = a; };
  const gapMs = Math.max(MOMENT_GAP_S, W) * 1000;
  // Only sets shot within a bounded span take part in time-based joining. A set can hold a
  // photo and its copy saved years later (near-duplicates match at any gap); its time range
  // would then overlap everything in between and swallow thousands of photos into one card.
  const anchored = (set) => !Number.isNaN(set.start) && set.end - set.start <= Math.max(gapMs, MAX_WIN_S * 1000);
  // Family links (the loose pass) likewise only join sets taken close together.
  const byFamily = new Map();
  sets.forEach((set, i) => {
    if (!anchored(set)) return;
    const fam = byFamily.get(set.family);
    if (!fam) { byFamily.set(set.family, [i]); return; }
    for (const j of fam) {
      const other = sets[j];
      if (set.start - other.end <= gapMs && other.start - set.end <= gapMs) { join(j, i); break; }
    }
    fam.push(i);
  });
  const timed = sets.map((set, i) => i).filter((i) => anchored(sets[i])).sort((a, b) => sets[a].start - sets[b].start);
  for (let x = 0; x < timed.length; x++) {
    const A = sets[timed[x]];
    for (let y = x + 1; y < timed.length && sets[timed[y]].start - A.end <= gapMs; y++) {
      const B = sets[timed[y]];
      if (root(timed[x]) === root(timed[y])) continue;
      const gap = B.start - A.end; // can be negative when sets interleave in time
      const sceneMax = T + (gap <= MOMENT_TIGHT_S * 1000 ? TIGHT_SLACK : SCENE_SLACK);
      if (A.some((p) => B.some((q) => score(p, q, sceneMax) <= sceneMax))) join(timed[x], timed[y]);
    }
  }
  const moments = new Map();
  sets.forEach((set, i) => {
    const r = root(i);
    if (!moments.has(r)) moments.set(r, []);
    moments.get(r).push(set);
  });

  return [...moments.values()].map((parts) => {
    parts.sort((a, b) => (a.start || 0) - (b.start || 0));
    const g = parts.flat();
    g.sets = parts;
    g.start = Math.min(...g.map((p) => p.date || Infinity));
    return g;
  });
}
