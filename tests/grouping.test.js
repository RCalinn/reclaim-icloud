import { test } from 'node:test';
import assert from 'node:assert/strict';
import { group, groupKey, suggestDelete, threshold } from '../js/grouping.js';
import { simThreshold } from '../js/signature.js';
import { item, library, makeScene, regrade, render } from './fixtures.js';

const T = simThreshold(10);
const W = 300;
const MIN = 60e3;

test('a burst of retakes becomes one set; the best photo is kept', () => {
  const scene = makeScene(11);
  const t0 = Date.UTC(2026, 3, 1);
  const best = item(render(scene, { seed: 1 }), { date: t0, w: 4032, h: 3024 });
  const low = item(render(scene, { dx: 1, noise: 4, seed: 2 }), { date: t0 + 5e3, w: 1600, h: 1200 });
  const other = item(render(scene, { dy: 1, gain: 1.05, noise: 4, seed: 3 }), { date: t0 + 9e3, w: 1600, h: 1200 });
  const [g, ...rest] = group([low, best, other], T, W);
  assert.equal(rest.length, 0);
  assert.equal(g.sets.length, 1);
  assert.equal(g[0], best);
  assert.deepEqual(g.map(suggestDelete), [false, true, true]);
});

test('a darker, greyer retake joins the burst at the default similarity', () => {
  const scene = makeScene(17); // scores 24.7 under the old colour term, 12.4 now
  const t0 = Date.UTC(2026, 3, 1, 10);
  const a = item(render(scene, { seed: 1 }), { date: t0 });
  const dark = item(regrade(render(scene, { dx: 1, noise: 4, seed: 2 }), { gain: 0.6, sat: 0.5 }), { date: t0 + 20e3 });
  const gs = group([a, dark], T, W);
  assert.equal(gs.length, 1);
  assert.equal(gs[0].sets.length, 1);
});

test('frames of one iCloud burst are one set, however different they look', () => {
  const t0 = Date.UTC(2026, 3, 1, 11);
  const frames = [0, 1, 2].map((k) => item(render(makeScene(320 + k)), { date: t0 + k * 300, burst: 'B1' }));
  const stranger = item(render(makeScene(330)), { date: t0 + 400 });
  const gs = group([...frames, stranger], T, W);
  assert.equal(gs.length, 1);
  assert.equal(gs[0].sets.length, 1);
  assert.deepEqual(new Set(gs[0]), new Set(frames));
  assert.equal(stranger.set, null);
});

test('favorites are never suggested for deletion', () => {
  const scene = makeScene(12);
  const t0 = Date.UTC(2026, 3, 2);
  const a = item(render(scene, { seed: 1 }), { date: t0, w: 4032, h: 3024 });
  const fav = item(render(scene, { dx: 1, seed: 2 }), { date: t0 + 3e3, w: 1600, h: 1200, fav: true });
  const b = item(render(scene, { dx: -1, seed: 3 }), { date: t0 + 6e3, w: 1600, h: 1200 });
  const [g] = group([a, fav, b], T, W);
  assert.equal(g[0], fav, 'favorite ranks first');
  assert.equal(suggestDelete(fav), false);
});

test('unrelated photos taken at the same time are not grouped', () => {
  const t0 = Date.UTC(2026, 3, 3);
  const xs = Array.from({ length: 8 }, (_, i) => item(render(makeScene(300 + i)), { date: t0 + i * 2e3 }));
  assert.equal(group(xs, T, W).length, 0);
});

test('the same scene far apart in time needs to be near-identical', () => {
  const scene = makeScene(13);
  const a = item(render(scene, { seed: 1 }), { date: Date.UTC(2026, 3, 4) });
  const retake = item(render(scene, { dx: 2, gain: 1.08, noise: 8, seed: 2 }), { date: a.date + 3 * 86400e3 });
  assert.equal(group([a, retake], T, W).length, 0, 'loose retake days apart is not grouped');
  const copy = item(render(scene, { seed: 1 }), { date: 0 }); // undated re-save
  const gs = group([a, copy], T, W);
  assert.equal(gs.length, 1, 'exact copy is grouped even without a date');
});

test('threshold relaxes from T inside the window to the near-dup floor', () => {
  assert.equal(threshold(10, T, W), T);
  assert.equal(threshold(W, T, W), T);
  const mid = threshold(1800, T, W);
  assert.ok(mid < T && mid > 6);
  assert.equal(threshold(7200, T, W), 6);
  assert.equal(threshold(Infinity, T, W), 6);
});

test('complete linkage keeps every pair in a set within the cap', async () => {
  const { distance } = await import('../js/signature.js');
  const groups = group(library(3, 80), T, W);
  for (const g of groups) for (const set of g.sets) {
    for (const p of set) for (const q of set) assert.ok(distance(p, q) <= T + 6);
  }
});

test('grouping is deterministic and sets p.set on members only', () => {
  const xs = library(5, 40);
  const a = group(xs, T, W).map((g) => g.sets.map(groupKey));
  const b = group([...xs], T, W).map((g) => g.sets.map(groupKey));
  assert.deepEqual(a, b);
  const grouped = new Set(group(xs, T, W).flat());
  for (const p of xs) assert.equal(!!p.set, grouped.has(p));
});

test('stricter similarity never produces more grouped photos', () => {
  const xs = library(9, 60);
  const count = (s) => group(xs, simThreshold(s), W).flat().length;
  assert.ok(count(2) <= count(10));
  assert.ok(count(10) <= count(16));
});

test('a copy saved years later does not pull everything in between into one card', () => {
  const t0 = Date.UTC(2020, 0, 1);
  const scene = makeScene(21);
  const original = item(render(scene, { seed: 1 }), { date: t0 });
  const copy = item(render(scene, { seed: 1 }), { date: t0 + 5 * 365 * 86400e3 }); // re-saved 5 years on
  const bursts = [];
  for (let b = 0; b < 30; b++) {
    const s = makeScene(400 + b), t = t0 + (b + 1) * 30 * 86400e3;
    for (let k = 0; k < 3; k++) bursts.push(item(render(s, { dx: k, noise: 3, seed: b * 7 + k }), { date: t + k * 4e3 }));
  }
  const groups = group([original, copy, ...bursts], T, W);
  const withCopy = groups.find((g) => g.includes(copy));
  assert.ok(withCopy && withCopy.includes(original), 'the copy is still matched with its original');
  assert.equal(withCopy.length, 2, `the copy's card holds ${withCopy.length} photos`);
  assert.ok(Math.max(...groups.map((g) => g.length)) <= 3, 'every burst keeps its own card');
});
