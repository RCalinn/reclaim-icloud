// Synthetic photos for tests: procedurally drawn 64x64 scenes, plus helpers to derive
// retakes (shifted / brightened / noisy) and build library items with signatures.

import { analyzePixels } from '../js/signature.js';

// Small deterministic PRNG so every run sees the same library.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A "scene": background gradient plus a few coloured blobs. Rendered with an offset
// (dx, dy), brightness gain and noise, so retakes of one scene look alike.
export function makeScene(seed) {
  const r = rng(seed);
  const bg = [r() * 255, r() * 255, r() * 255, r() * 255, r() * 255, r() * 255];
  const blobs = Array.from({ length: 3 + Math.floor(r() * 4) }, () => ({
    x: r() * 64, y: r() * 64, rad: 6 + r() * 18, c: [r() * 255, r() * 255, r() * 255],
  }));
  return { bg, blobs };
}

export function render(scene, { dx = 0, dy = 0, gain = 1, noise = 0, seed = 1 } = {}) {
  const r = rng(seed);
  const d = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const t = y / 63;
    let c = [0, 1, 2].map((k) => scene.bg[k] * (1 - t) + scene.bg[k + 3] * t);
    for (const b of scene.blobs) {
      const dist = Math.hypot(x - b.x - dx, y - b.y - dy);
      if (dist < b.rad) { const a = 1 - dist / b.rad; c = c.map((v, k) => v * (1 - a) + b.c[k] * a); }
    }
    const j = (y * 64 + x) * 4;
    for (let k = 0; k < 3; k++) d[j + k] = c[k] * gain + (r() - 0.5) * 2 * noise;
    d[j + 3] = 255;
  }
  return d;
}

// The same photo edited or shot with other settings: brightness gain, saturation (1 = unchanged,
// 0 = grey) and a white-balance tint (per-channel multipliers).
export function regrade(px, { gain = 1, sat = 1, tint = [1, 1, 1] } = {}) {
  const d = new Uint8ClampedArray(px);
  for (let j = 0; j < d.length; j += 4) {
    const y = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    for (let k = 0; k < 3; k++) d[j + k] = (y + (d[j + k] - y) * sat) * gain * tint[k];
  }
  return d;
}

let nextId = 0;
export function item(pixels, extra = {}) {
  const { hash, lab, sharp } = analyzePixels(pixels);
  return {
    id: `p${++nextId}`, name: `IMG_${nextId}.JPG`, date: 0, fav: false,
    size: 2e6, w: 4032, h: 3024, hash, lab, sharp, px: pixels, ...extra,
  };
}

// A library of bursts: each burst is 2-5 retakes of one scene within a minute, bursts spread
// over a few days (some close together), plus singles and a few undated / bulk-stamped imports.
export function library(seed = 7, bursts = 60) {
  const r = rng(seed);
  const items = [];
  let t = Date.UTC(2026, 0, 1);
  for (let b = 0; b < bursts; b++) {
    const gap = r();
    t += gap < 0.3 ? 90e3 + r() * 200e3 : gap < 0.85 ? 3600e3 * (1 + r() * 20) : 86400e3 * (7 + r() * 30);
    const scene = makeScene(1000 + b);
    const n = r() < 0.25 ? 1 : 2 + Math.floor(r() * 4);
    for (let k = 0; k < n; k++) {
      const px = render(scene, { dx: (r() - 0.5) * 6, dy: (r() - 0.5) * 6, gain: 0.92 + r() * 0.16, noise: r() * 10, seed: b * 10 + k });
      items.push(item(px, {
        date: Math.round(t + k * r() * 15e3), fav: r() < 0.06,
        size: Math.round(1e6 + r() * 4e6), w: r() < 0.2 ? 3024 : 4032, h: r() < 0.2 ? 2268 : 3024,
      }));
    }
  }
  // Undated copies of earlier photos (re-saves) and a bulk import sharing one timestamp.
  for (let k = 0; k < 6; k++) {
    const src = makeScene(1000 + Math.floor(r() * bursts));
    items.push(item(render(src, { noise: 3, seed: 900 + k }), { date: 0 }));
  }
  for (let k = 0; k < 25; k++) items.push(item(render(makeScene(5000 + k), { seed: k }), { date: Date.UTC(2025, 5, 1) }));
  return items;
}
