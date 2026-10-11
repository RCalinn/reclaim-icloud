import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { cosine, createEmbedder, EMB_DIM, EMB_SIZE, embFromStr, embToStr, quantise, toTensorData } from '../js/embed.js';
import { distance, embScore, simThreshold } from '../js/signature.js';
import { regrade } from './fixtures.js';

const root = new URL('../', import.meta.url);

// Real photos: four scenes from INRIA Holidays (Jégou, Douze & Schmid, ECCV 2008), two shots each,
// already squashed to the model's input size like the page does. Keys: scene id + shot (00, 01).
// INRIA holds the copyright, so the file isn't published; the model test is skipped without it.
const PHOTOS = new URL('photos/holidays-168.json.gz', import.meta.url);
const photos = existsSync(PHOTOS) ? Object.fromEntries(Object.entries(JSON.parse(gunzipSync(readFileSync(PHOTOS))))
  .map(([k, v]) => [k, new Uint8ClampedArray(Buffer.from(v, 'base64'))])) : null;
const SCENES = ['1020', '1124', '1186', '1291'];

test('quantised embeddings are unit length and round-trip through the cache', () => {
  const v = Float32Array.from({ length: EMB_DIM * 3 }, (_, i) => Math.sin(i * 1.7));
  const q = quantise(v);
  assert.equal(q.length, EMB_DIM);
  assert.ok(Math.abs(cosine(q, q) - 1) < 1e-9);
  const back = embFromStr(embToStr(q));
  assert.deepEqual([...back], [...q]);
  assert.ok(embToStr(q).length <= 512);
});

test('tensor data is CHW and ImageNet-normalised', () => {
  const px = new Uint8ClampedArray(EMB_SIZE * EMB_SIZE * 4).fill(255);
  const t = toTensorData(px);
  const n = EMB_SIZE * EMB_SIZE;
  assert.equal(t.length, 3 * n);
  assert.ok(Math.abs(t[0] - (1 - 0.485) / 0.229) < 1e-6);
  assert.ok(Math.abs(t[2 * n] - (1 - 0.406) / 0.225) < 1e-6);
});

test('the score uses embeddings when both photos have one, the classic score otherwise', () => {
  const a = { hash: [0, 0], lab: new Uint8Array(48), emb: quantise(Float32Array.from({ length: EMB_DIM }, (_, i) => i % 7)) };
  const b = { hash: [0xffff, 0], lab: new Uint8Array(48), emb: a.emb };
  assert.equal(distance(a, b), 0, 'same embedding');
  assert.equal(distance({ ...a, emb: null }, b), 16, 'pHash bits when one has no embedding');
  assert.ok(Math.abs(embScore(a, b)) < 1e-9);
});

test('DINOv2 runs in Node with the bundled runtime and tells retakes from other scenes', { timeout: 120000, skip: !photos && 'tests/photos/holidays-168.json.gz not found' }, async () => {
  assert.equal(photos['102000'].length, EMB_SIZE * EMB_SIZE * 4);
  const ort = await import('../vendor/ort/ort.wasm.bundle.min.mjs');
  const embed = await createEmbedder(ort, {
    wasmBinary: readFileSync(new URL('vendor/ort/ort-wasm-simd-threaded.wasm', root)),
    model: readFileSync(new URL('models/dinov2-small-int8.onnx', root)),
  });
  const T = simThreshold(10);
  const e = {};
  for (const [k, px] of Object.entries(photos)) e[k] = { emb: await embed(px) };
  for (const s of SCENES) {
    const d = embScore(e[s + '00'], e[s + '01']);
    assert.ok(d <= T, `scene ${s}: second shot scores ${d.toFixed(1)} (threshold ${T})`);
  }
  for (const a of SCENES) for (const b of SCENES) {
    if (a >= b) continue;
    const d = embScore(e[a + '00'], e[b + '01']);
    assert.ok(d > T + 6, `scenes ${a} and ${b} score ${d.toFixed(1)}, within the set cap`);
  }
  // The same shot darker and greyer (exposure / white balance) stays in the set.
  for (const s of SCENES) {
    const dark = { emb: await embed(regrade(photos[s + '00'], { gain: 0.6, sat: 0.6, tint: [1.06, 1, 0.94] })) };
    const d = embScore(e[s + '00'], dark);
    assert.ok(d <= T, `scene ${s} regraded scores ${d.toFixed(1)}`);
  }
});
