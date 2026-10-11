import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePixels, distance, labFromStr, labToStr, popcount, simThreshold } from '../js/signature.js';
import { makeScene, regrade, render } from './fixtures.js';

const DEFAULT_T = simThreshold(10);

test('identical images score 0', () => {
  const px = render(makeScene(1));
  assert.equal(distance(analyzePixels(px), analyzePixels(px)), 0);
});

test('a retake (small shift, exposure change, noise) is similar', () => {
  const scene = makeScene(2);
  const a = analyzePixels(render(scene));
  const b = analyzePixels(render(scene, { dx: 2, dy: -1, gain: 1.06, noise: 6, seed: 9 }));
  assert.ok(distance(a, b) <= DEFAULT_T, `retake distance ${distance(a, b)}`);
});

test('different scenes are not similar', () => {
  let close = 0;
  for (let i = 0; i < 40; i++) {
    const a = analyzePixels(render(makeScene(100 + i)));
    const b = analyzePixels(render(makeScene(200 + i)));
    if (distance(a, b) <= DEFAULT_T) close++;
  }
  assert.ok(close <= 1, `${close} of 40 unrelated pairs scored as similar`);
});

test('a retake shot darker, greyer or with another white balance is similar', () => {
  let missed = 0;
  for (let i = 0; i < 20; i++) {
    const scene = makeScene(400 + i);
    const a = analyzePixels(render(scene));
    const retake = render(scene, { dx: 2, dy: -1, noise: 4, seed: i });
    const graded = [
      regrade(retake, { gain: 0.6, sat: 0.5 }),               // like an underexposed, washed-out shot
      regrade(retake, { gain: 0.75, sat: 0.8, tint: [1.08, 1, 0.92] }), // warmer and a bit darker
    ];
    for (const px of graded) if (distance(a, analyzePixels(px)) > DEFAULT_T) missed++;
  }
  assert.ok(missed <= 4, `${missed} of 40 graded retakes scored as not similar`);
});

test('the same layout in other colours is not similar', () => {
  let close = 0;
  for (let i = 0; i < 40; i++) {
    const scene = makeScene(500 + i), other = makeScene(600 + i);
    const recoloured = { bg: other.bg, blobs: scene.blobs.map((b, k) => ({ ...b, c: other.blobs[k % other.blobs.length].c })) };
    if (distance(analyzePixels(render(scene)), analyzePixels(render(recoloured))) <= DEFAULT_T) close++;
  }
  assert.ok(close <= 1, `${close} of 40 recoloured scenes scored as similar`);
});

test('scores are symmetric, never below the pHash distance, and exact up to a limit', () => {
  const sigs = Array.from({ length: 24 }, (_, i) => {
    const px = render(makeScene(700 + (i >> 1)), { dx: i & 1, noise: 3, seed: i });
    return analyzePixels(i % 3 ? px : regrade(px, { gain: 0.55, sat: 0.4 }));
  });
  for (const a of sigs) for (const b of sigs) {
    const d = distance(a, b);
    assert.equal(d, distance(b, a));
    assert.ok(d >= popcount(a.hash[0] ^ b.hash[0]) + popcount(a.hash[1] ^ b.hash[1]));
    for (const limit of [6, 22, 28, 42]) {
      const v = distance(a, b, limit);
      assert.ok(d <= limit ? v === d : v > limit, `limit ${limit}: ${v} vs ${d}`);
    }
  }
});

test('a blurred copy is less sharp', () => {
  const px = render(makeScene(3), { noise: 0 });
  const blurred = new Uint8ClampedArray(px);
  for (let y = 1; y < 63; y++) for (let x = 1; x < 63; x++) for (let k = 0; k < 3; k++) {
    const j = (y * 64 + x) * 4 + k;
    blurred[j] = (px[j - 4] + px[j + 4] + px[j - 256] + px[j + 256] + px[j]) / 5;
  }
  assert.ok(analyzePixels(blurred).sharp < analyzePixels(px).sharp);
});

test('pHash leaves the DC bit clear and sets about half the bits', () => {
  const { hash } = analyzePixels(render(makeScene(4)));
  assert.equal(hash[0] & 1, 0);
  const bits = popcount(hash[0]) + popcount(hash[1]);
  assert.ok(bits >= 24 && bits <= 40, `${bits} bits set`);
});

test('lab cache encoding round-trips', () => {
  const { lab } = analyzePixels(render(makeScene(5)));
  const s = labToStr(lab);
  assert.equal(s.length, 64);
  assert.deepEqual(labFromStr(s), lab);
});
