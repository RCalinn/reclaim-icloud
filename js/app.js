// Review page entry point: scan, regroup, delete, connection status.

import { SCAN_CONCURRENCY, SETTINGS_KEY, WINDOWS } from './config.js';
import { $, setProgress, setStatus } from './dom.js';
import { analyze, modelReady } from './analyze.js';
import { group } from './grouping.js';
import { connectionStatus, listLibrary, moveToRecentlyDeleted } from './icloud.js';
import { simThreshold } from './signature.js';
import {
  applyCache, forgetDeleted, isDeleted, pruneTo, ready, remember, sanitizeChoices, saveCache, state,
} from './store.js';
import { openTune } from './tune.js';
import { onDeleteBlock, render, updateSummary } from './ui.js';
import { adaptivePool, fmtBytes, fmtWindow } from './util.js';

function regroup() {
  const T = simThreshold(+$('#dist').value);
  const W = WINDOWS[+$('#win').value];
  const groups = group(state.items, T, W);
  sanitizeChoices(groups);
  groups.sort((a, b) => a.start - b.start); // oldest first; undated (Infinity) last
  state.groups = groups;
  render();
}

async function scan() {
  if (state.busy) return; // a delete is running; its results would be overwritten
  state.busy = true;
  $('#scan').disabled = true;
  updateSummary();
  try {
    await ready;
    setProgress('indeterminate');
    const { photos, videos, skipped } = await listLibrary((n, total, retrying) => {
      setStatus(`Reading library… ${n.toLocaleString()}${total ? ` of ${total.toLocaleString()}` : ''} items` +
        (retrying ? ' · iCloud error, trying again' : ''));
      if (total) setProgress(n / total);
    });
    state.items = photos;
    if (!skipped) pruneTo(photos); // a skipped photo isn't gone; keep its saved data
    const photoBytes = photos.reduce((sum, p) => sum + p.size, 0);
    $('#statPhotos').textContent = `${photos.length.toLocaleString()} photo${photos.length === 1 ? '' : 's'} · ${fmtBytes(photoBytes)}`;
    $('#statVideos').textContent = `${videos.count.toLocaleString()} video${videos.count === 1 ? '' : 's'} · ${fmtBytes(videos.bytes)} (not scanned)`;

    let todo = applyCache(photos, true), ai = true;
    if (todo.length) {
      setStatus('Loading the similarity model…');
      ai = await modelReady();
      if (!ai) todo = applyCache(photos, false); // keep basic signatures we already have
    }
    let done = 0, failed = 0, shown = 0;
    const started = performance.now();
    // A long analysis (the first scan with the model) says it's one-off and safe to interrupt.
    const long = ai && todo.length >= 1000 ? ' · one-time, progress is saved: you can stop and scan again later' : '';
    const showProgress = () => {
      shown = performance.now();
      const rate = done / ((shown - started) / 1000);
      const left = rate > 0 ? (todo.length - done) / rate : 0;
      setStatus(`Analysing photos… ${done.toLocaleString()} of ${todo.length.toLocaleString()}` +
        (done >= 20 ? ` · ${rate < 10 ? rate.toFixed(1) : Math.round(rate)}/s · ${fmtDuration(left)} left` : '') +
        (failed ? ` · ${failed} failed` : '') + long);
      setProgress(done / todo.length);
    };
    if (todo.length) showProgress();
    const run = await adaptivePool(todo, SCAN_CONCURRENCY, async (p, throttle) => {
      try {
        const r = await analyze(p, throttle, ai);
        if (r.embError) console.warn('similarity model failed on a photo, compared the basic way', p.name, r.embError);
        remember(p, r);
      } catch (e) {
        failed++;
        console.warn('analyze failed', p.name, e);
      }
      done++;
      if (performance.now() - shown > 250 || done === todo.length) showProgress();
      if (done % 200 === 0) saveCache().catch((e) => console.warn('could not save signatures', e));
    });
    await saveCache();
    if (todo.length) {
      const secs = (performance.now() - started) / 1000;
      console.info(`analysed ${todo.length} photos in ${secs.toFixed(1)} s (${(todo.length / secs).toFixed(1)}/s, up to ${run.peak} downloads at once)`);
    }

    const classic = photos.filter((p) => p.hash && !p.emb).length;
    setStatus(`Scanned ${photos.length} photos${failed ? `, ${failed} thumbnails failed` : ''}` +
      `${skipped ? `; iCloud failed to list ${skipped} item${skipped === 1 ? '' : 's'}, left out` : ''}.` +
      (!ai ? ' The similarity model could not load, so photos were compared the basic way (less accurate).'
        : classic ? ` ${classic.toLocaleString()} photo${classic === 1 ? ' was' : 's were'} compared the basic way; scan again to retry ${classic === 1 ? 'it' : 'them'}.` : ''));
    regroup();
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  } finally {
    state.busy = false;
    $('#scan').disabled = false;
    setProgress(null);
    updateSummary();
  }
}

// Deletes what's marked in `groups` (everything by default, or one month's block).
async function deleteSelected(groups = state.groups, label = '') {
  if (state.busy) return;
  const sel = groups.flatMap((g) => g.filter(isDeleted));
  if (!sel.length) return;
  const bytes = sel.reduce((s, p) => s + p.size, 0);
  const wholeGroups = groups.flatMap((g) => g.sets).filter((set) => set.every(isDeleted)).length;
  $('#cTitle').textContent = `Move ${sel.length.toLocaleString()} photo${sel.length === 1 ? '' : 's'}${label ? ` from ${label}` : ''} to Recently Deleted?`;
  $('#cBody').textContent = `This frees ${fmtBytes(bytes)} once Recently Deleted is emptied. Until then, you can recover them for 30 days.`;
  $('#cWarn').textContent = wholeGroups ? `${wholeGroups} group${wholeGroups === 1 ? ' has' : 's have'} no photo marked to keep.` : '';
  if (!(await askConfirm())) return;

  state.busy = true;
  $('#scan').disabled = true;
  updateSummary();
  const { deleted, errors, notSent, busy, stopError } = await moveToRecentlyDeleted(sel, (n, wait) => {
    setStatus(wait
      ? `iCloud is busy, trying again in ${wait} s… (${n} of ${sel.length} moved)`
      : `Moving to Recently Deleted… ${n} of ${sel.length}`);
    setProgress(n / sel.length);
  });

  forgetDeleted(deleted);
  if (errors.length) console.warn('delete errors', errors);
  if (stopError) console.warn('delete stopped early', stopError);
  const plural = (k) => `${k.toLocaleString()} photo${k === 1 ? '' : 's'}`;
  const were = (k) => (k === 1 ? 'wasn’t' : 'weren’t');
  const notMoved = notSent && (busy
    ? `iCloud is too busy, so ${plural(notSent)} ${were(notSent)} moved. Still marked: wait a minute, then press Move to Recently Deleted again.`
    : `${plural(notSent)} ${were(notSent)} moved because iCloud returned an error. Still marked: press Move to Recently Deleted to try again.`);
  const refused = errors.length && `iCloud refused ${plural(errors.length)}; scan again, then retry.`;
  setStatus(
    [deleted.size || (!notSent && !refused) ? `Moved ${plural(deleted.size)} to Recently Deleted.` : '', notMoved, refused]
      .filter(Boolean).join(' '),
    notSent > 0 || errors.length > 0
  );
  state.busy = false;
  $('#scan').disabled = false;
  setProgress(null);
  regroup();
}

function askConfirm() {
  const dlg = $('#confirm');
  return new Promise((resolve) => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
    dlg.querySelector('button[value=cancel]').focus();
  });
}

async function refreshConnection() {
  const text = $('#conn');
  const dot = $('#connDot');
  let ok = false;
  try {
    const st = await connectionStatus();
    if (!st.tab) text.textContent = 'Open icloud.com/photos in a tab';
    else if (!st.endpoint) text.textContent = 'Reload the iCloud Photos tab';
    else { text.textContent = 'Connected to iCloud'; ok = true; }
  } catch {
    text.textContent = 'Extension error';
  }
  dot.className = `dot ${ok ? 'ok' : 'bad'}`;
}

const fmtDuration = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`);

// ---------- init ----------

function syncLabels() {
  $('#distOut').textContent = $('#dist').value;
  $('#winOut').textContent = fmtWindow(WINDOWS[+$('#win').value]);
}

let regroupFrame = 0;
function scheduleRegroup() {
  syncLabels();
  cancelAnimationFrame(regroupFrame);
  regroupFrame = requestAnimationFrame(() => { if (state.items.length) regroup(); });
}
$('#dist').addEventListener('input', scheduleRegroup);
$('#win').addEventListener('input', scheduleRegroup);
// Slider positions survive a reload (Check accuracy can set Similarity to a suggested level).
const saveSettings = () => browser.storage.local.set({ [SETTINGS_KEY]: { dist: +$('#dist').value, win: +$('#win').value } })
  .catch((e) => console.warn('could not save settings', e));
$('#dist').addEventListener('change', saveSettings);
$('#win').addEventListener('change', saveSettings);
browser.storage.local.get(SETTINGS_KEY).then((r) => {
  const s = r[SETTINGS_KEY];
  if (!s) return;
  for (const [id, v] of [['dist', s.dist], ['win', s.win]]) {
    const el = $('#' + id);
    if (Number.isInteger(v) && v >= +el.min && v <= +el.max) el.value = v;
  }
  scheduleRegroup();
}).catch((e) => console.warn('could not load settings', e));
$('#tuneOpen').addEventListener('click', openTune);
$('#scan').addEventListener('click', scan);
$('#delete').addEventListener('click', () => deleteSelected());
onDeleteBlock(deleteSelected);

syncLabels();
render();
refreshConnection();
setInterval(refreshConnection, 3000);

// Don't leave buttons focused after a click, or Space would also "press" them.
document.addEventListener('click', (e) => e.target.closest?.('button')?.blur());
