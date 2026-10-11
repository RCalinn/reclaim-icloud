// iCloud Photos (CloudKit web API), relayed by background.js through the logged-in icloud.com tab.

import { DELETE_RETRY_DELAYS, LIST_RETRY_DELAYS, MAX_SKIPPED_IN_A_ROW, PAGE, ZONE } from './config.js';
import { sleep } from './util.js';

const ck = (path, body) => browser.runtime.sendMessage({ type: 'ck', path, body });

export const connectionStatus = () => browser.runtime.sendMessage({ type: 'status' });

const field = (rec, k) => rec?.fields?.[k]?.value;
const isVideo = (type) => /movie|video|mpeg|avi/i.test(type || '');

function decodeName(b64) {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

// Download links for an asset's thumbnail and medium-size preview.
// Prefer the asset's own (edited) renditions, fall back to the original's.
function imageUrls(a, m, name) {
  const fileName = encodeURIComponent(name || 'photo.jpg');
  const url = (k) => (field(a, k) || field(m, k))?.downloadURL?.replace('${f}', fileName) || null;
  return { thumb: url('resJPEGThumbRes'), med: url('resJPEGMedRes') };
}

// How many assets (photos and videos) the library holds, as iCloud's own index counts them,
// or null if iCloud won't say. Only used to show progress, so any failure just means no total.
export async function countLibrary() {
  try {
    const res = await ck('internal/records/query/batch', {
      batch: [{
        resultsLimit: 1,
        query: {
          recordType: 'HyperionIndexCountLookup',
          filterBy: {
            fieldName: 'indexCountID',
            comparator: 'IN',
            fieldValue: { type: 'STRING_LIST', value: ['CPLAssetByAssetDateWithoutHiddenOrDeleted'] },
          },
        },
        zoneWide: true,
        zoneID: ZONE,
      }],
    });
    const n = res?.batch?.[0]?.records?.[0]?.fields?.itemCount?.value;
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch (e) {
    console.warn('could not count the library', e);
    return null;
  }
}

// iCloud sometimes answers a listing page with a 500 INTERNAL_ERROR (or a 429). Most are one-offs that a
// retry fixes; others come back every time for the same stretch of the library (a record iCloud can't serve).
const isServerError = (e) => /^iCloud 5\d\d\b/.test(e?.message || '');
const isTransient = (e) => isServerError(e) || /^iCloud 429\b|NetworkError/.test(e?.message || '');

async function queryPage(rank, size, onRetry) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ck('records/query', {
        query: {
          recordType: 'CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted',
          filterBy: [
            { fieldName: 'startRank', comparator: 'EQUALS', fieldValue: { type: 'INT64', value: rank } },
            { fieldName: 'direction', comparator: 'EQUALS', fieldValue: { type: 'STRING', value: 'ASCENDING' } },
          ],
        },
        resultsLimit: size * 2, // an asset plus its master each
        zoneID: ZONE,
      });
    } catch (e) {
      if (!isTransient(e) || attempt >= LIST_RETRY_DELAYS.length) throw e;
      console.warn(`listing at ${rank} failed, retrying`, e);
      onRetry();
      await sleep(LIST_RETRY_DELAYS[attempt]);
    }
  }
}

// Names (never values) of the fields seen on listed records, so an exported label file shows
// which metadata iCloud offers (e.g. what its burst field is called).
export const seenFields = { CPLAsset: new Set(), CPLMaster: new Set() };
const noteFields = (r) => { for (const k of Object.keys(r.fields || {})) seenFields[r.recordType]?.add(k); };

// onProgress(read, total, retrying): assets listed so far, the library's size (null until known, or if
// unknown), and whether iCloud just failed and is being asked again.
// -> { photos, videos, skipped }: skipped = assets iCloud kept failing on, left out of the listing.
export async function listLibrary(onProgress) {
  const photos = [];
  const videos = { count: 0, bytes: 0 };
  let rank = 0;
  let total = null;
  countLibrary().then((n) => { total = n; }); // runs alongside the first pages
  const progress = (retrying = false) => onProgress(rank, total && Math.max(total, rank), retrying); // photos added mid-scan can outgrow the count

  // A page that keeps failing is read again in smaller pages, down to one asset, to find the asset(s)
  // iCloud can't serve. Those are skipped; the rest of the library is still listed.
  let pageSize = PAGE;
  let smallUntil = 0; // rank where the failing stretch ends; full pages again from there
  let skipped = 0, skippedInARow = 0;
  for (;;) {
    let res;
    try {
      res = await queryPage(rank, pageSize, () => progress(true));
    } catch (e) {
      const stop = () => new Error(`Reading the library stopped after ${rank.toLocaleString()} items. ${e.message}`);
      if (!isServerError(e)) throw stop();
      if (total && rank >= total) break; // failing past the last asset: the listing is complete
      if (pageSize > 1) {
        smallUntil = Math.max(smallUntil, rank + pageSize);
        pageSize = Math.max(1, Math.floor(pageSize / 4));
        continue;
      }
      // A run of single assets failing is iCloud being down, not a bad record.
      if (++skippedInARow > MAX_SKIPPED_IN_A_ROW) throw stop();
      console.warn(`skipping the asset at ${rank}: iCloud keeps failing on it`, e);
      skipped++;
      rank++;
      pageSize = PAGE; // past the bad asset; a second one nearby is narrowed down again
      smallUntil = rank;
      continue;
    }

    const masters = new Map();
    const assets = [];
    for (const r of res.records || []) {
      noteFields(r);
      if (r.recordType === 'CPLMaster') masters.set(r.recordName, r);
      else if (r.recordType === 'CPLAsset') assets.push(r);
    }
    if (!assets.length) break;
    skippedInARow = 0;

    for (const a of assets) {
      const m = masters.get(field(a, 'masterRef')?.recordName);
      if (!m) continue;
      const size = field(m, 'resOriginalRes')?.size || 0;
      if (isVideo(field(m, 'itemType'))) {
        videos.count++;
        videos.bytes += size;
        continue;
      }
      const name = decodeName(field(m, 'filenameEnc'));
      const urls = imageUrls(a, m, name);
      if (!urls.thumb) continue;
      photos.push({
        id: a.recordName,
        masterId: m.recordName,
        changeTag: a.recordChangeTag,
        name,
        date: field(a, 'assetDate') || 0,
        fav: field(a, 'isFavorite') === 1,
        burst: field(a, 'burstId') || null, // frames of one iCloud burst share it
        size,
        w: field(m, 'resOriginalWidth') || 0,
        h: field(m, 'resOriginalHeight') || 0,
        ...urls,
        linksAt: Date.now(),
        hash: null,
        sharp: 0,
      });
    }

    rank += assets.length;
    if (rank >= smallUntil) pageSize = PAGE;
    progress();
  }
  return { photos, videos, skipped };
}

// iCloud's download links are signed and expire. A photo's links can be renewed whenever
// they stop working (a long review session outlives several renewals), but at most once per
// RENEW_GAP so a photo that fails for another reason doesn't hammer iCloud.
const RENEW_GAP = 20000;
export function renewLinks(p) { // -> true if p now has new links worth retrying
  if (Date.now() - (p.linksAt || 0) < RENEW_GAP) return Promise.resolve(false);
  return refreshUrls(p).then(() => true);
}

// Batch expired-link refreshes into one iCloud lookup.
let refreshBatch = null;
function refreshUrls(p) {
  if (!refreshBatch) {
    const batch = (refreshBatch = { items: new Map(), promise: null });
    batch.promise = sleep(150).then(async () => {
      refreshBatch = null;
      const items = [...batch.items.values()];
      for (let i = 0; i < items.length; i += 100) {
        const chunk = items.slice(i, i + 100);
        const res = await ck('records/lookup', {
          records: chunk.flatMap((x) => [{ recordName: x.id }, { recordName: x.masterId }]),
          zoneID: ZONE,
        });
        const byName = new Map((res.records || []).map((r) => [r.recordName, r]));
        for (const x of chunk) {
          x.linksAt = Date.now();
          const a = byName.get(x.id), m = byName.get(x.masterId);
          if (!a?.fields && !m?.fields) continue;
          const urls = imageUrls(a, m, x.name);
          if (urls.thumb) x.thumb = urls.thumb;
          if (urls.med) x.med = urls.med;
        }
      }
    });
  }
  refreshBatch.items.set(p.id, p);
  return refreshBatch.promise;
}

// A busy iCloud (503 SERVER_OVERLOADED) says how many seconds to wait in its retryAfter.
const retryAfterMs = (e) => 1000 * +((e?.message || '').match(/"retryAfter"\s*:\s*(\d+)/)?.[1] || 0);

// One batch of deletes. iCloud failing the whole request with a 5xx / 429 (often "overloaded, retry
// in 10 s") is waited out and retried; onWait(seconds left) ticks once a second while waiting.
async function modifyBatch(chunk, onWait) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ck('records/modify', {
        operations: chunk.map((p) => ({
          operationType: 'update',
          record: {
            recordName: p.id,
            recordType: 'CPLAsset',
            recordChangeTag: p.changeTag,
            fields: { isDeleted: { value: 1 } },
          },
        })),
        zoneID: ZONE,
        atomic: false,
      });
    } catch (e) {
      if (!isTransient(e) || attempt >= DELETE_RETRY_DELAYS.length) throw e;
      const ms = Math.min(60000, Math.max(DELETE_RETRY_DELAYS[attempt], retryAfterMs(e)));
      console.warn(`delete batch failed, retrying in ${ms / 1000} s`, e);
      for (let left = Math.round(ms / 1000); left > 0; left--) { onWait(left); await sleep(1000); } // a live countdown
    }
  }
}

// Flags photos as deleted (iCloud moves them to Recently Deleted), 50 per request.
// onProgress(moved, waitSeconds): waitSeconds is set while waiting to retry a batch iCloud was busy for.
// Returns { deleted: Set<id>, errors: string[] (per-photo failures), notSent, busy }: if a batch still
// fails after its retries, it and the rest aren't sent (notSent photos, still marked), and busy says
// whether iCloud was overloaded rather than refusing outright.
export async function moveToRecentlyDeleted(photos, onProgress) {
  const deleted = new Set();
  const errors = [];
  for (let i = 0; i < photos.length; i += 50) {
    const chunk = photos.slice(i, i + 50);
    let res;
    try {
      res = await modifyBatch(chunk, (s) => onProgress(deleted.size, s));
    } catch (e) {
      console.warn('delete stopped', e);
      return { deleted, errors, notSent: photos.length - i, busy: isTransient(e), stopError: e.message || String(e) };
    }
    for (const r of res.records || []) {
      if (r.serverErrorCode) errors.push(`${r.recordName}: ${r.serverErrorCode} ${r.reason || ''}`);
      else deleted.add(r.recordName);
    }
    onProgress(deleted.size);
  }
  return { deleted, errors, notSent: 0, busy: false };
}
