import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportLabels, levelStats, MIN_EACH, pairKey, ROUND, samplePairs, suggestLevel } from '../js/accuracy.js';
import { distance } from '../js/signature.js';
import { library, rng } from './fixtures.js';

const W = 300;

test('a round: pairs taken <= 1 h apart, each photo once, spread over scores, not labelled yet', () => {
  const items = library(5, 120);
  const pairs = samplePairs(items, new Set(), ROUND, rng(1));
  assert.equal(pairs.length, ROUND);
  const ids = pairs.flatMap(({ a, b }) => [a.id, b.id]);
  assert.equal(new Set(ids).size, ids.length, 'a photo appears twice in one round');
  for (const { a, b } of pairs) {
    assert.ok(a.date > 0 && b.date > 0 && Math.abs(a.date - b.date) <= 3600e3);
    const d = distance(a, b);
    assert.ok(d >= 6 && d <= 44, `score ${d}`);
  }
  const scores = pairs.map(({ a, b }) => distance(a, b));
  assert.ok(scores.filter((d) => d <= 22).length >= 8 && scores.filter((d) => d > 22).length >= 8, `scores not spread: ${scores.map(Math.round)}`);

  const labelled = new Set(pairs.map(({ a, b }) => pairKey(a, b)));
  const next = samplePairs(items, labelled, ROUND, rng(2));
  assert.ok(next.every(({ a, b }) => !labelled.has(pairKey(a, b))), 'labelled pair asked again');
});

test('frames of one burst and undated photos are never asked about', () => {
  const items = library(6, 60);
  const dated = items.filter((p) => p.date > 0);
  for (const p of dated) p.burst = 'B'; // all one burst
  assert.equal(samplePairs(items, new Set(), ROUND, rng(3)).length, 0);
});

test('a small library gives a short round, an empty one none', () => {
  assert.equal(samplePairs([], new Set()).length, 0);
  const few = library(7, 3).filter((p) => p.date > 0);
  assert.ok(samplePairs(few, new Set(), ROUND, rng(4)).length < ROUND);
});

test('level stats count grouped pairs per level; looser never groups fewer', () => {
  const items = library(8, 120);
  const pairs = samplePairs(items, new Set(), ROUND, rng(5)).map(({ a, b }) => ({ a, b, same: distance(a, b) <= 20 }));
  const stats = levelStats(pairs, W);
  assert.equal(stats.length, 17);
  for (let i = 1; i < stats.length; i++) {
    assert.ok(stats[i].found >= stats[i - 1].found && stats[i].wrong >= stats[i - 1].wrong);
  }
  const s = stats[0];
  assert.equal(s.same + s.diff, pairs.length);
});

test('a level is suggested only with enough answers of each kind, strictest on ties', () => {
  const mk = (level, found, same, wrong, diff) => ({ level, found, same, wrong, diff });
  assert.equal(suggestLevel(Array.from({ length: 17 }, (_, l) => mk(l, 0, MIN_EACH - 1, 0, 30))), null);
  // Grouping more same-shot pairs pays until wrong groups start costing 3x.
  const stats = Array.from({ length: 17 }, (_, l) => mk(l, Math.min(20, l * 2), 20, Math.max(0, l - 12), 20));
  assert.equal(suggestLevel(stats), 10);
});

test('the download holds signatures and answers, no ids, names, dates or links', () => {
  const items = library(9, 30).map((p) => ({ ...p, thumb: 'https://cvws.icloud-content.com/x', name: 'IMG_1.JPG' }));
  const pairs = samplePairs(items, new Set(), 10, rng(6)).map(({ a, b }, i) => ({ a, b, same: i % 2 === 0 }));
  const fields = { CPLAsset: new Set(['burstId', 'assetDate']), CPLMaster: new Set(['filenameEnc']) };
  const out = exportLabels(pairs, W, fields);
  const text = JSON.stringify(out);
  assert.equal(out.pairs.length, pairs.length);
  assert.deepEqual(out.recordFields, { CPLAsset: ['assetDate', 'burstId'], CPLMaster: ['filenameEnc'] });
  for (const p of items) assert.ok(!text.includes(`"${p.id}"`) && !(p.date > 0 && text.includes(String(p.date))), `id or date of ${p.id} leaked`);
  assert.ok(!/icloud-content|IMG_1|"date"|"name"|"id"/.test(text));
  assert.deepEqual(Object.keys(out.pairs[0]).sort(), ['a', 'b', 'cos', 'dt', 'same']);
  assert.equal(out.pairs[0].cos, null, 'no embeddings, no cosine');
  // With embeddings only their cosine is exported, never the vectors.
  const emb = Int8Array.from({ length: 384 }, (_, i) => (i * 37) % 255 - 127);
  const withEmb = exportLabels(pairs.map((x) => ({ ...x, a: { ...x.a, emb }, b: { ...x.b, emb } })), W, fields);
  assert.equal(withEmb.pairs[0].cos, 1);
  assert.ok(!JSON.stringify(withEmb).includes('emb"'), 'no embedding vectors in the file');
});
