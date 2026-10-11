// Fake WebExtension `browser` API + fake iCloud for the review page (classic script, runs first).
(() => {
  const patch = sessionStorage.getItem('patch'); if (patch) (0, eval)(patch);
  window.__errors = [];
  addEventListener('error', (e) => __errors.push(String(e.message || e.error)));
  addEventListener('unhandledrejection', (e) => __errors.push('unhandled: ' + String(e.reason?.message || e.reason)));
  const origErr = console.error;
  console.error = (...a) => { __errors.push(a.map(String).join(' ')); origErr(...a); };

  const W = window.Worker;
  window.__workers = 0;
  if (W) window.Worker = class extends W { constructor(...a) { super(...a); window.__workers++; } };

  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/__h/library.json', false);
  xhr.send();
  const lib = JSON.parse(xhr.responseText);
  const deleted = new Set(JSON.parse(localStorage.getItem('__deleted') || '[]'));
  window.__modifyCalls = [];
  // Track object URLs (each holds a downloaded image in memory until revoked).
  window.__blobs = { created: 0, live: 0 };
  const cOU = URL.createObjectURL, rOU = URL.revokeObjectURL;
  URL.createObjectURL = (b) => { __blobs.created++; __blobs.live++; return cOU(b); };
  URL.revokeObjectURL = (u) => { __blobs.live--; return rOU(u); };
  // Count in-flight thumbnail downloads as the page sees them.
  const realFetch = window.fetch;
  window.__fetch = { active: 0, peak: 0 };
  window.fetch = async (...a) => {
    if (!String(a[0]).includes('/img/')) return realFetch(...a);
    __fetch.peak = Math.max(__fetch.peak, ++__fetch.active);
    try { return await realFetch(...a); } finally { __fetch.active--; }
  };

  // Like iCloud, download links are signed and stop working after a while (window.__ttl ms).
  const expiry = () => (window.__ttl ? Date.now() + window.__ttl : 0);
  window.__lookups = 0;
  const asset = (p) => ({
    recordName: p.id, recordType: 'CPLAsset', recordChangeTag: 'tag-' + p.id,
    fields: {
      masterRef: { value: { recordName: 'm-' + p.id } },
      assetDate: { value: p.date }, isFavorite: { value: p.fav ? 1 : 0 },
      ...(window.__bursts?.[p.id] ? { burstId: { value: window.__bursts[p.id] } } : {}), // set from a test patch
      resJPEGThumbRes: { value: { downloadURL: `/img/${p.id}.png?exp=${expiry()}&f=\${f}` } },
    },
  });
  const master = (p) => ({
    recordName: 'm-' + p.id, recordType: 'CPLMaster',
    fields: {
      filenameEnc: { value: btoa(p.name) }, itemType: { value: 'public.jpeg' },
      resOriginalRes: { value: { size: p.size } }, resOriginalWidth: { value: p.w }, resOriginalHeight: { value: p.h },
      resJPEGMedRes: { value: { downloadURL: `/img/${p.id}.png?med=1&exp=${expiry()}&f=\${f}` } },
    },
  });
  const video = { recordName: 'v1', recordType: 'CPLAsset', recordChangeTag: 't', fields: { masterRef: { value: { recordName: 'mv1' } } } };
  const vmaster = { recordName: 'mv1', recordType: 'CPLMaster', fields: { itemType: { value: 'com.apple.quicktime-movie' }, resOriginalRes: { value: { size: 5e8 } } } };

  // Like iCloud, ranks and counts include every asset, videos too.
  const liveAssets = () => ['video', ...lib.filter((p) => !deleted.has(p.id))];

  function ck(path, body) {
    if (path === 'internal/records/query/batch') {
      if (window.__noCount) throw new Error('iCloud 400: unknown index'); // set from a test patch
      const id = body.batch[0].query.filterBy.fieldValue.value[0];
      if (id !== 'CPLAssetByAssetDateWithoutHiddenOrDeleted') throw new Error('unexpected count index ' + id);
      return { batch: [{ records: [{ recordType: 'HyperionIndexCountLookup', fields: { itemCount: { value: liveAssets().length } } }] }] };
    }
    if (path === 'records/query') {
      if (localStorage.getItem('__empty')) return { records: [] }; // simulate an iCloud hiccup
      const live = liveAssets();
      const start = body.query.filterBy[0].fieldValue.value;
      const n = Math.min(50, body.resultsLimit / 2); // an asset plus its master each; iCloud caps pages too
      if (window.__failQuery?.(start, n)) throw new Error('iCloud 500: { "serverErrorCode" : "INTERNAL_ERROR" }'); // set from a test patch
      const page = live.slice(start, start + n);
      return { records: page.flatMap((p) => (p === 'video' ? [video, vmaster] : [asset(p), master(p)])) };
    }
    if (path === 'records/lookup') {
      __lookups++;
      const byId = new Map(lib.map((p) => [p.id, p]));
      return { records: body.records.map(({ recordName }) => {
        const p = byId.get(recordName.replace(/^m-/, ''));
        return recordName.startsWith('m-') ? master(p) : asset(p);
      }) };
    }
    if (path === 'records/modify') {
      // __modifyFail = n: iCloud rejects the next n requests as overloaded, as it does under load.
      if (window.__modifyFail > 0) {
        window.__modifyFail--;
        throw new Error('iCloud 503: { "retryAfter" : 1, "serverErrorCode" : "TRY_AGAIN_LATER", "error" : "SERVER_OVERLOADED" }');
      }
      __modifyCalls.push(body);
      const out = body.operations.map((op) => {
        deleted.add(op.record.recordName);
        return { recordName: op.record.recordName };
      });
      localStorage.setItem('__deleted', JSON.stringify([...deleted]));
      return { records: out };
    }
    throw new Error('unknown path ' + path);
  }

  const store = {
    async get(k) {
      const keys = typeof k === 'string' ? [k] : k;
      const out = {};
      for (const key of keys) { const v = localStorage.getItem('s:' + key); if (v !== null) out[key] = JSON.parse(v); }
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) localStorage.setItem('s:' + k, JSON.stringify(v)); },
    async remove(k) { for (const x of [].concat(k)) localStorage.removeItem('s:' + x); },
  };

  window.browser = {
    storage: { local: store },
    runtime: {
      async sendMessage(msg) {
        await new Promise((r) => setTimeout(r, 2));
        if (msg.path === 'records/modify' && window.__modifyDelay) await new Promise((r) => setTimeout(r, window.__modifyDelay));
        if (msg.type === 'status') return { endpoint: true, tab: true };
        if (msg.type === 'ck') return ck(msg.path, msg.body);
      },
    },
  };
})();
