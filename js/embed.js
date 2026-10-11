// On-device image embeddings with DINOv2-small (ONNX, run by onnxruntime-web on WASM).
// DINOv2 is trained to recognise the same scene / object across viewpoint, pose, zoom and
// lighting changes, which is exactly what retakes differ by. Everything here except
// createEmbedder() is pure maths, so tests run it in Node too.
//
// Embedding per photo: 384 numbers (the CLS token), L2-normalised and stored as Int8 (×127),
// base64-encoded in the signature cache. Similarity = cosine of two embeddings.

export const EMB_SIZE = 168;    // input side in pixels (12×12 patches of 14 px); see README for the speed/accuracy trade-off
export const EMB_DIM = 384;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

// RGBA bytes of an EMB_SIZE² image -> Float32Array CHW, ImageNet-normalised.
export function toTensorData(d, size = EMB_SIZE) {
  const n = size * size;
  const out = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (d[j] / 255 - MEAN[0]) / STD[0];
    out[n + i] = (d[j + 1] / 255 - MEAN[1]) / STD[1];
    out[2 * n + i] = (d[j + 2] / 255 - MEAN[2]) / STD[2];
  }
  return out;
}

// last_hidden_state [1, tokens, 384] -> Int8Array(384): CLS token, L2-normalised, ×127.
export function quantise(hidden) {
  let ss = 0;
  for (let k = 0; k < EMB_DIM; k++) ss += hidden[k] * hidden[k];
  const inv = ss > 0 ? 127 / Math.sqrt(ss) : 0;
  const q = new Int8Array(EMB_DIM);
  for (let k = 0; k < EMB_DIM; k++) q[k] = Math.max(-127, Math.min(127, Math.round(hidden[k] * inv)));
  return q;
}

// Cosine similarity of two quantised embeddings (1 = same picture).
export function cosine(a, b) {
  let ab = 0, aa = 0, bb = 0;
  for (let k = 0; k < EMB_DIM; k++) { ab += a[k] * b[k]; aa += a[k] * a[k]; bb += b[k] * b[k]; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

export const embToStr = (e) => btoa(String.fromCharCode(...new Uint8Array(e.buffer, e.byteOffset, e.length)));
export const embFromStr = (s) => new Int8Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer);

// Loads the model once. ort: the onnxruntime-web module; files: { wasm, model } as URLs (browser)
// or { wasmBinary, model } as bytes (Node). Returns embed(rgba) -> Promise<Int8Array>.
export async function createEmbedder(ort, files) {
  ort.env.wasm.numThreads = 1; // the page runs several workers instead (no SharedArrayBuffer here anyway)
  ort.env.wasm.proxy = false;
  if (files.wasmBinary) ort.env.wasm.wasmBinary = files.wasmBinary;
  else ort.env.wasm.wasmPaths = { wasm: files.wasm };
  let model = files.model;
  if (typeof model === 'string') {
    const res = await fetch(model);
    if (!res.ok) throw new Error(`model file: HTTP ${res.status}`);
    model = new Uint8Array(await res.arrayBuffer());
  }
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  return async (rgba) => {
    const input = new ort.Tensor('float32', toTensorData(rgba), [1, 3, EMB_SIZE, EMB_SIZE]);
    const out = await session.run({ pixel_values: input });
    const t = out.last_hidden_state;
    const e = quantise(t.data);
    t.dispose?.(); input.dispose?.();
    return e;
  };
}
