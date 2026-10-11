// Photo signature: pHash + 4x4 Lab colour + sharpness, plus (normally) a DINOv2 embedding from
// embed.js. Pure maths, no DOM, so it runs in the analysis worker, on the main thread (fallback)
// and in Node tests alike.
//
// Signature per photo (cached as [hi, lo, sharp, lab] with lab base64-encoded):
//   hash: [hi, lo]  64-bit pHash (32x32 DCT -> 8x8 low-freq, median threshold), 8 bytes
//   lab:  Uint8Array(48)  4x4 grid of mean colour in CIE Lab (L*2.55, a+128, b+128), 48 bytes
//   emb:  Int8Array(384)  DINOv2 embedding (embed.js), missing if the model couldn't run
// Pair score (distance): from the embeddings when both photos have one (embScore), otherwise the
// classic score = hamming(pHash) + 0.3 * colour difference. Both are on one scale, lower = more
// similar. The colour difference is mean |ΔLab| per cell, or less if the two only differ by a
// whole-picture exposure / saturation / white-balance change (see colourDiff).
// Similar if score <= T. Default T = 14; slider s (0..16) -> T = 12 + s.

import { cosine } from './embed.js';

export const SIZE = 64; // images are squashed to 64x64 before analysis
export const Q_SIZE = 224; // ... and to 224x224 to judge sharpness and exposure (picks the photo to keep)

// cos table for a 32-point DCT, first 8 frequencies.
const DCT_COS = (() => {
  const c = new Float32Array(8 * 32);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 32; x++) c[u * 32 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 64);
  return c;
})();

const srgbLin = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
  return t;
})();

// d: RGBA bytes of a 64x64 image (ImageData.data).
export function analyzePixels(d) {
  // Grayscale 64x64.
  const g = new Float32Array(64 * 64);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];

  // Sharpness: variance of the Laplacian.
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < 63; y++) {
    for (let x = 1; x < 63; x++) {
      const i = y * 64 + x;
      const l = g[i - 1] + g[i + 1] + g[i - 64] + g[i + 64] - 4 * g[i];
      sum += l; sumSq += l * l; n++;
    }
  }
  const sharp = sumSq / n - (sum / n) ** 2;

  // pHash: 2x2 box-average to 32x32 (do NOT let canvas do tiny downscales: it aliases),
  // 2-D DCT, keep the 8x8 lowest frequencies, threshold at the median of the 63 AC terms.
  const s = new Float32Array(32 * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const i = y * 128 + x * 2;
    s[y * 32 + x] = (g[i] + g[i + 1] + g[i + 64] + g[i + 65]) * 0.25;
  }
  const rows = new Float32Array(32 * 8); // rows[y*8+u]
  for (let y = 0; y < 32; y++) for (let u = 0; u < 8; u++) {
    let a = 0; for (let x = 0; x < 32; x++) a += s[y * 32 + x] * DCT_COS[u * 32 + x];
    rows[y * 8 + u] = a;
  }
  const coef = new Float32Array(64); // coef[v*8+u]
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
    let a = 0; for (let y = 0; y < 32; y++) a += rows[y * 8 + u] * DCT_COS[v * 32 + y];
    coef[v * 8 + u] = a;
  }
  const ac = Array.from(coef.subarray(1)).sort((a, b) => a - b);
  const med = ac[31]; // median of 63 values
  let hi = 0, lo = 0;
  for (let k = 1; k < 64; k++) { // bit 0 (DC) is always 0
    if (coef[k] > med) { if (k < 32) hi = (hi | (1 << k)) >>> 0; else lo = (lo | (1 << (k - 32))) >>> 0; }
  }

  // Colour: 4x4 grid of mean sRGB (16x16 blocks) -> CIE Lab, quantised to bytes.
  const lab = new Uint8Array(48);
  for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) {
    let r = 0, gg = 0, b = 0;
    for (let y = by * 16; y < by * 16 + 16; y++) for (let x = bx * 16; x < bx * 16 + 16; x++) {
      const j = (y * 64 + x) * 4; r += d[j]; gg += d[j + 1]; b += d[j + 2];
    }
    const R = srgbLin[Math.round(r / 256)], G = srgbLin[Math.round(gg / 256)], B = srgbLin[Math.round(b / 256)];
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const X = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
    const Y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
    const Z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    const o = (by * 4 + bx) * 3;
    lab[o] = Math.round((116 * Y - 16) * 2.55);
    lab[o + 1] = Math.max(0, Math.min(255, Math.round(500 * (X - Y) + 128)));
    lab[o + 2] = Math.max(0, Math.min(255, Math.round(200 * (Y - Z) + 128)));
  }
  return { hash: [hi, lo], lab, sharp };
}

// Keeper hints on a Q_SIZE² RGBA image. sharp: variance of the Laplacian of the luma (blur and
// shake lower it). expo: share of pixels crushed to black or blown to white.
export function quality(d, size = Q_SIZE) {
  const n = size * size;
  const g = new Float32Array(n);
  let clipped = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const y = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    g[i] = y;
    if (y < 12 || y > 243) clipped++;
  }
  let sum = 0, sumSq = 0, m = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const l = g[i - 1] + g[i + 1] + g[i - size] + g[i + size] - 4 * g[i];
      sum += l; sumSq += l * l; m++;
    }
  }
  return { sharp: sumSq / m - (sum / m) ** 2, expo: clipped / n };
}

export function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Colour after undoing a whole-picture change: the same scene shot darker, greyer or warmer
// differs in every cell by about the same scale and offset. Per direction, fit q ≈ s·p + o over the
// 16 cells (L* on its own; a* and b* share one s, as a saturation change scales both) with s
// clamped to what exposure / saturation edits plausibly do, and charge the leftover per cell
// (× GRADE_WEIGHT) plus the overall change itself, capped at GRADE_CAP. A recoloured scene doesn't
// fit one scale, so its leftover stays large. Tuned on synthetic retakes graded darker/greyer/tinted:
// at the default threshold those group ~83% of the time instead of ~46%, with no more false matches
// among same-layout scenes in other colours.
const GRADE_WEIGHT = 2.5;
const GRADE_CAP = 6;
const L_SCALE = [0.6, 1.67]; // L* gain: roughly 0.2x .. 4.6x exposure
const C_SCALE = [0.3, 1.6];  // chroma: desaturated to 30% .. saturated 160%

// Mean over cells of |q - (s·p + o)| summed over channels k0..k1 (one least-squares s, clamped to
// [lo, hi]; an offset o per channel). Channels are stored as bytes; `unit` converts to Lab units.
function leftover(p, q, k0, k1, lo, hi, unit) {
  let sxy = 0, sxx = 0, mp0 = 0, mq0 = 0, mp1 = 0, mq1 = 0;
  for (let i = 0; i < 48; i += 3) { mp0 += p[i + k0]; mq0 += q[i + k0]; mp1 += p[i + k1]; mq1 += q[i + k1]; }
  mp0 /= 16; mq0 /= 16; mp1 /= 16; mq1 /= 16;
  const two = k1 !== k0;
  for (let i = 0; i < 48; i += 3) {
    let dp = p[i + k0] - mp0;
    sxy += dp * (q[i + k0] - mq0); sxx += dp * dp;
    if (two) { dp = p[i + k1] - mp1; sxy += dp * (q[i + k1] - mq1); sxx += dp * dp; }
  }
  const s = sxx > 0 ? Math.min(hi, Math.max(lo, sxy / sxx)) : 1;
  let r = 0;
  for (let i = 0; i < 48; i += 3) {
    r += Math.abs(q[i + k0] - mq0 - s * (p[i + k0] - mp0));
    if (two) r += Math.abs(q[i + k1] - mq1 - s * (p[i + k1] - mp1));
  }
  return (r * unit) / 16;
}

// Colour difference of two 4x4 Lab grids, in Lab units per cell (L* + a* + b*). Exact when it is
// <= max; past max it may stop early and return any value above max.
export function colourDiff(a, b, max = Infinity) {
  let c = 0;
  for (let i = 0; i < 48; i += 3) {
    c += Math.abs(a[i] - b[i]) / 2.55 + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  c /= 16;
  // regraded = GRADE_CAP (as c > it) + GRADE_WEIGHT × leftover averaged over both fit directions.
  // Each term only adds, so stop once it can't beat c, or once the result is past max anyway
  // (most unrelated pairs stop early). Both directions are summed first, so a↔b is exactly symmetric.
  if (c <= GRADE_CAP) return c;
  const w = GRADE_WEIGHT / 2;
  let r = GRADE_CAP;
  if (r > max) return r;
  r += w * (leftover(a, b, 0, 0, L_SCALE[0], L_SCALE[1], 1 / 2.55) + leftover(b, a, 0, 0, L_SCALE[0], L_SCALE[1], 1 / 2.55));
  if (r >= c) return c;
  if (r > max) return r;
  r += w * (leftover(a, b, 1, 2, C_SCALE[0], C_SCALE[1], 1) + leftover(b, a, 1, 2, C_SCALE[0], C_SCALE[1], 1));
  return Math.min(c, r);
}

// a/b: { hash: [hi, lo], lab: Uint8Array(48) | number[] }.
// Score ~ "hamming bits"; 0 = identical. Never below the pHash distance.
// With a limit, the score is exact up to it; above it, any value > limit.
export const hashDistance = (a, b) => popcount(a.hash[0] ^ b.hash[0]) + popcount(a.hash[1] ^ b.hash[1]);
export function classicDistance(a, b, limit = Infinity) {
  const h = hashDistance(a, b);
  return h + 0.3 * colourDiff(a.lab, b.lab, (limit - h) / 0.3);
}

// Embedding score: EMB_SCALE × (1 − cosine), on the classic scale so the Similarity slider, the
// near-duplicate floor and the moment slacks keep working. Slider 0 / 10 / 16 need cosine 0.89 /
// 0.80 / 0.75; near-duplicates at any time gap need 0.945. Calibrated on 812 real holiday photos
// (INRIA Holidays): at the default level it finds 53% of same-scene pairs (often other angles,
// harder than retakes) and joins 1.5% of pairs from neighbouring scenes; the classic score found 8%.
// On the user's own 80 labelled pairs, level 10 wrongly grouped 8 of 35 "different" pairs and level 2
// (cosine 0.873) none, so the slider now starts at 2 (review.html).
export const EMB_SCALE = 110;
export const embScore = (a, b) => EMB_SCALE * (1 - cosine(a.emb, b.emb));

// The pair score used everywhere: compare with simThreshold(slider).
export function distance(a, b, limit = Infinity) {
  return a.emb && b.emb ? embScore(a, b) : classicDistance(a, b, limit);
}

// Slider 0..16 (default 2) -> score threshold. 2 -> 14 (default), 10 -> 22 (loose), 16 -> 28 (loosest).
export const SIM_OFFSET = 12;
export const simThreshold = (slider) => SIM_OFFSET + slider;

// Cache helpers: Uint8Array(48) <-> 64-char base64 string.
export const labToStr = (lab) => btoa(String.fromCharCode(...lab));
export const labFromStr = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
