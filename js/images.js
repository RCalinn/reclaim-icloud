// Thumbnails are fetched by the extension, a few at a time, instead of letting
// hundreds of <img> tags hit Apple's servers at once and get throttled.
// - Newest requests go first (LIFO), so what's on screen now loads before
//   whatever you scrolled past; requests for tiles that scrolled away are skipped.
// - Every request has a timeout, so a hung download can't block the queue.
// - Expired download links are renewed from iCloud and retried.
// - Downloaded images are kept in a bounded cache: with tens of thousands of photos,
//   keeping every one in memory would eventually make images fail to load.

import { IMG_CONCURRENCY, IMG_TIMEOUT } from './config.js';
import { HttpError, isExpired, sleep } from './util.js';
import { renewLinks } from './icloud.js';

const CACHE_LIMIT = { thumb: 600, med: 24 }; // object URLs kept per kind; oldest are released
const caches = { thumb: new Map(), med: new Map() }; // url -> { promise, objectUrl } in LRU order
const urgentQueue = [];
const imgQueue = [];
let imgActive = 0;

// Thrown for a queued request whose tile scrolled out of range before its turn.
export class Skipped extends Error {}

export async function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMG_TIMEOUT);
  try { return await fetch(url, { signal: ctrl.signal }); } finally { clearTimeout(timer); }
}

// Fetches with a timeout, retrying throttling (429), server errors and network failures with
// backoff. Other HTTP errors (e.g. an expired link) throw an HttpError at once.
// onThrottle() is called whenever the server pushes back, so callers can slow down.
export async function fetchRetry(url, onThrottle = () => {}, attempts = 3) {
  for (let attempt = 0; ; attempt++) {
    let err;
    try {
      const res = await fetchWithTimeout(url);
      if (res.ok) return res;
      err = new HttpError(res.status);
      if (res.status !== 429 && res.status < 500) throw err; // won't fix itself by retrying
      onThrottle();
    } catch (e) {
      if (e instanceof HttpError && e === err && err.status !== 429 && err.status < 500) throw e;
      err = e;
    }
    if (attempt >= attempts - 1) throw err;
    await sleep(700 * 2 ** attempt * (0.75 + Math.random() / 2));
  }
}

function evict(kind) {
  const cache = caches[kind];
  for (const [url, entry] of cache) {
    if (cache.size <= CACHE_LIMIT[kind]) break;
    if (!entry.objectUrl) continue; // still downloading
    URL.revokeObjectURL(entry.objectUrl);
    cache.delete(url);
  }
}

// wanted(): checked when the request reaches the front of the queue; false skips it.
function loadImage(url, kind, urgent, wanted) {
  const cache = caches[kind];
  let entry = cache.get(url);
  if (entry) {
    cache.delete(url); // move to the most-recently-used end
    cache.set(url, entry);
    return entry.promise;
  }
  entry = {};
  entry.promise = new Promise((resolve, reject) => {
    (urgent ? urgentQueue : imgQueue).push({ url, wanted, resolve, reject });
    pumpImages();
  }).then(
    (objectUrl) => { entry.objectUrl = objectUrl; evict(kind); return objectUrl; },
    (e) => { if (cache.get(url) === entry) cache.delete(url); throw e; }
  );
  cache.set(url, entry);
  return entry.promise;
}

function pumpImages() {
  while (imgActive < IMG_CONCURRENCY && (urgentQueue.length || imgQueue.length)) {
    const job = urgentQueue.length ? urgentQueue.shift() : imgQueue.pop();
    if (job.wanted && !job.wanted()) { job.reject(new Skipped()); continue; }
    imgActive++;
    fetchRetry(job.url)
      .then((res) => res.blob())
      .then((blob) => job.resolve(URL.createObjectURL(blob)), job.reject)
      .finally(() => { imgActive--; pumpImages(); });
  }
}

// Load one of a photo's images (kind = 'thumb' | 'med') as an object URL,
// renewing its links if they expired.
export async function loadPhoto(p, kind = 'thumb', urgent = false, wanted = null) {
  if (!p[kind]) throw new Error('no image');
  try {
    return await loadImage(p[kind], kind, urgent, wanted);
  } catch (e) {
    if (!isExpired(e) || !(await renewLinks(p))) throw e;
    return loadImage(p[kind], kind, urgent, wanted);
  }
}
