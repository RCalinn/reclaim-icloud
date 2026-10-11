// Decodes thumbnails and computes their signatures off the main thread, so scanning a
// large library doesn't stall scrolling or thumbnail loading on the review page.
// Each worker loads its own copy of the DINOv2 model on first use (see embed.js).

import { analyzePixels, quality, Q_SIZE, SIZE } from './signature.js';
import { createEmbedder, EMB_SIZE } from './embed.js';

const canvases = new Map(); // side -> 2-D context
function pixels(bmp, side) {
  let ctx = canvases.get(side);
  if (!ctx) {
    ctx = new OffscreenCanvas(side, side).getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    canvases.set(side, ctx);
  }
  ctx.drawImage(bmp, 0, 0, side, side); // squash to a square
  return ctx.getImageData(0, 0, side, side).data;
}

let embedder = null; // Promise<embed function>; rejects if the model can't load here
const model = () => (embedder ||= import('../vendor/ort/ort.wasm.bundle.min.mjs').then((ort) => createEmbedder(ort, {
  wasm: new URL('../vendor/ort/ort-wasm-simd-threaded.wasm', import.meta.url).href,
  model: new URL('../models/dinov2-small-int8.onnx', import.meta.url).href,
})).catch((e) => { embedder = null; throw e; })); // let the next scan try again

self.onmessage = async ({ data: { id, blob, embed, init } }) => {
  try {
    if (init) { await model(); self.postMessage({ id, result: true }); return; }
    const bmp = await createImageBitmap(blob);
    // Draw and read back in one synchronous block: messages interleave at the awaits, and they
    // all share these canvases.
    let small, big, emb = null;
    try {
      small = pixels(bmp, SIZE);
      big = pixels(bmp, Q_SIZE);
      if (embed) emb = pixels(bmp, EMB_SIZE); // getImageData returns a fresh copy
    } finally {
      bmp.close();
    }
    const result = { ...analyzePixels(small), ...quality(big) };
    if (emb) {
      // Without an embedding the photo is compared the classic way and analysed again next scan.
      try { result.emb = await (await model())(emb); } catch (e) { result.embError = String(e?.message || e); }
    }
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
