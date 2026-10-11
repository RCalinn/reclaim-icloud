// Check accuracy: pick pairs from the library for the user to label "same shot" / "different",
// and measure each Similarity level against those answers. Pure: no DOM, no app state.

import { threshold } from './grouping.js';
import { cosine } from './embed.js';
import { distance, EMB_SCALE, labToStr, SIM_OFFSET, simThreshold } from './signature.js';

export const ROUND = 40;          // pairs per labelling round
export const MIN_EACH = 10;       // answers of each kind needed before suggesting a level
export const WRONG_COST = 3;      // a wrong group (leads to a delete suggestion) vs. a missed one
export const LEVELS = [...Array(17).keys()]; // Similarity slider 0..16
const PAIR_WINDOW_MS = 3600e3;    // pairs come from photos taken this close together
const MAX_NEIGHBOURS = 300;       // per photo, so a bulk import within one hour can't stall the page
// Scores worth asking about: from clearly similar to just past the loosest level (and past
// retakes that only exposure keeps apart), in buckets sampled evenly so hard cases aren't drowned
// out by the many easy ones.
const LOW = 6, HIGH = SIM_OFFSET + 16 + 16, BUCKET = 3;

export const pairKey = (a, b) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);

function shuffle(xs, rand) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

// Up to n unlabelled pairs { a, b } of photos taken <= 1 h apart, spread evenly over scores
// LOW..HIGH, each photo at most once. Skips undated photos and frames of the same burst.
export function samplePairs(items, labelled, n = ROUND, rand = Math.random) {
  const xs = items.filter((p) => p.hash && p.date > 0).sort((a, b) => a.date - b.date);
  const buckets = Array.from({ length: Math.ceil((HIGH - LOW) / BUCKET) }, () => ({ seen: 0, pool: [] }));
  const keep = n * 2; // reservoir size per bucket
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length && j <= i + MAX_NEIGHBOURS && xs[j].date - xs[i].date <= PAIR_WINDOW_MS; j++) {
      const a = xs[i], b = xs[j];
      if (a.burst && a.burst === b.burst) continue;
      const d = distance(a, b, HIGH);
      if (d < LOW || d > HIGH || labelled.has(pairKey(a, b))) continue;
      const bucket = buckets[Math.min(buckets.length - 1, Math.floor((d - LOW) / BUCKET))];
      bucket.seen++;
      if (bucket.pool.length < keep) bucket.pool.push({ a, b });
      else {
        const r = Math.floor(rand() * bucket.seen);
        if (r < keep) bucket.pool[r] = { a, b };
      }
    }
  }
  for (const bucket of buckets) shuffle(bucket.pool, rand);
  const out = [];
  const used = new Set();
  while (out.length < n && buckets.some((bucket) => bucket.pool.length)) {
    for (const bucket of buckets) {
      while (bucket.pool.length) {
        const pair = bucket.pool.pop();
        if (used.has(pair.a.id) || used.has(pair.b.id)) continue;
        used.add(pair.a.id).add(pair.b.id);
        out.push(pair);
        break;
      }
      if (out.length >= n) break;
    }
  }
  return shuffle(out, rand); // not ordered by score, so answers aren't primed
}

// pairs: [{ a, b, same }] with current signatures; W = time window (s).
// -> per level { level, found, same, wrong, diff }: same-shot pairs it groups, different pairs it groups.
export function levelStats(pairs, W) {
  const scored = pairs.map(({ a, b, same }) => ({ same, d: distance(a, b), dt: Math.abs(a.date - b.date) / 1000 }));
  const same = scored.filter((x) => x.same).length;
  const diff = scored.length - same;
  return LEVELS.map((level) => {
    const T = simThreshold(level);
    let found = 0, wrong = 0;
    for (const x of scored) {
      if (x.d > threshold(x.dt, T, W)) continue;
      if (x.same) found++; else wrong++;
    }
    return { level, found, same, wrong, diff };
  });
}

// The level with the best balance (a wrong group counts WRONG_COST times a missed pair), the
// strictest on ties; null until there are MIN_EACH answers of each kind.
export function suggestLevel(stats) {
  const { same, diff } = stats[0] || {};
  if (!(same >= MIN_EACH && diff >= MIN_EACH)) return null;
  let best = null, bestScore = -Infinity;
  for (const s of stats) {
    const score = s.found / same - (WRONG_COST * s.wrong) / diff;
    if (score > bestScore) { best = s.level; bestScore = score; }
  }
  return best;
}

// What "Download labels" saves: signatures and answers only, no ids, names, dates or links. Of the
// embeddings only each pair's cosine similarity is saved, not the vectors themselves.
// fields: { CPLAsset: Set, CPLMaster: Set } of field names seen in the listing.
export function exportLabels(pairs, W, fields) {
  const sig = (p) => ({ hash: p.hash, lab: labToStr(p.lab), sharp: p.sharp, expo: p.expo, mp: Math.round((p.w * p.h) / 1e5) / 10 });
  const cos = (a, b) => (a.emb && b.emb ? Math.round(cosine(a.emb, b.emb) * 1e4) / 1e4 : null);
  return {
    format: 'similar-photos-labels',
    version: 2,
    simOffset: SIM_OFFSET,
    embScale: EMB_SCALE,
    windowSeconds: W,
    recordFields: Object.fromEntries(Object.entries(fields).map(([type, names]) => [type, [...names].sort()])),
    pairs: pairs.map(({ a, b, same }) => ({ same, dt: Math.round(Math.abs(a.date - b.date) / 1000), cos: cos(a, b), a: sig(a), b: sig(b) })),
  };
}
