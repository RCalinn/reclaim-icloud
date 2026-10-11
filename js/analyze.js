// Downloads a photo's thumbnail and computes its signature in a small pool of workers, each
// running the DINOv2 model (embed.js). Falls back to the main thread if workers can't start:
// the same classic signature, but no embedding (the model would freeze the page).

import { analyzePixels, quality, Q_SIZE, SIZE } from './signature.js';
import { fetchRetry } from './images.js';
import { renewLinks } from './icloud.js';
import { isExpired } from './util.js';

const WORKERS = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
const JOB_TIMEOUT = 60000; // a worker killed without an error event must not hang the scan (a job may wait behind the model loading)

let workers = null; // Worker[] once started, false if unavailable
let next = 0;
const pending = new Map(); // id -> { resolve, reject }
let lastId = 0;

class WorkerDown extends Error {}

function startWorkers() {
  try {
    workers = Array.from({ length: WORKERS }, () => {
      const w = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = ({ data }) => {
        const job = pending.get(data.id);
        if (!job) return;
        pending.delete(data.id);
        clearTimeout(job.timer);
        if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
      };
      // Fires if the worker script fails to load or crashes: give up on workers for good
      // and let every waiting job redo its work on the main thread.
      w.onerror = (e) => {
        e.preventDefault?.();
        console.warn('analysis worker failed, using main thread', e.message || e.type);
        stopWorkers();
      };
      return w;
    });
  } catch (e) {
    console.warn('analysis workers unavailable, using main thread', e);
    workers = false;
  }
}

function stopWorkers() {
  if (workers) for (const w of workers) w.terminate();
  workers = false;
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new WorkerDown()); }
  pending.clear();
}

function inWorker(msg, w = workers[next++ % workers.length]) {
  const id = ++lastId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      console.warn('analysis worker stopped answering, using main thread');
      stopWorkers();
    }, JOB_TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, ...msg });
  });
}

// Main-thread fallback: shared canvases, safe because draw + read are synchronous.
const canvases = new Map();
function pixels(bmp, side) {
  let ctx = canvases.get(side);
  if (!ctx) {
    const c = Object.assign(document.createElement('canvas'), { width: side, height: side });
    ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    canvases.set(side, ctx);
  }
  ctx.drawImage(bmp, 0, 0, side, side);
  return ctx.getImageData(0, 0, side, side).data;
}
async function onMainThread(blob) {
  const bmp = await createImageBitmap(blob);
  try {
    return { ...analyzePixels(pixels(bmp, SIZE)), ...quality(pixels(bmp, Q_SIZE)) };
  } finally {
    bmp.close();
  }
}

// Loads the model in every worker. Resolves true if it runs, false if photos will be compared
// the classic way this scan (no workers, or the model failed to load: CSP, memory, old CPU).
let modelOK = null;
export function modelReady() {
  if (workers === null) startWorkers();
  if (!workers) return Promise.resolve(false);
  return (modelOK ||= Promise.all(workers.map((w) => inWorker({ init: true }, w)))
    .then(() => true, (e) => {
      console.warn('similarity model unavailable, comparing photos the classic way', e);
      modelOK = null; // try again next scan
      return false;
    }));
}

// embed: also compute the DINOv2 embedding (only after modelReady() said yes).
export async function analyzeBlob(blob, embed = false) {
  if (workers === null) startWorkers();
  if (workers) {
    try {
      return await inWorker({ blob, embed });
    } catch (e) {
      if (!(e instanceof WorkerDown)) throw e;
    }
  }
  return onMainThread(blob);
}

// Download a photo's thumbnail (retrying throttling, renewing expired links) and
// compute its signature. onThrottle() fires when iCloud asks us to slow down.
export async function analyze(p, onThrottle, embed = false) {
  let res;
  try {
    res = await fetchRetry(p.thumb, onThrottle, 4);
  } catch (e) {
    if (!isExpired(e) || !(await renewLinks(p))) throw e;
    res = await fetchRetry(p.thumb, onThrottle, 4);
  }
  return analyzeBlob(await res.blob(), embed);
}
