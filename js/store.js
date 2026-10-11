// App state plus what survives a reload: photo signatures and the user's Keep/Delete clicks.

import { CACHE_KEY, CHOICES_KEY, OLD_CACHE_KEYS } from './config.js';
import { embFromStr, embToStr } from './embed.js';
import { groupKey, suggestDelete } from './grouping.js';
import { labFromStr, labToStr } from './signature.js';

export const state = {
  items: [],              // photos from the last scan, with signatures
  groups: [],             // moments on screen (see grouping.js)
  overrides: new Map(),   // asset id -> true (delete) / false (keep), set by user clicks
  emptyOK: new Set(),     // groupKeys of sets the user deliberately emptied (nothing kept)
  cache: {},              // asset id -> [pHashHi, pHashLo, sharpness, lab4x4 base64, exposure, embedding base64 | null]
  busy: false,
};

export const ready = Promise.all([
  browser.storage.local.get(CACHE_KEY).then((r) => { state.cache = r[CACHE_KEY] || {}; }),
  browser.storage.local.get(CHOICES_KEY).then((r) => {
    const c = r[CHOICES_KEY];
    if (!c) return;
    state.overrides = new Map(Object.entries(c.overrides || {}));
    state.emptyOK = new Set(c.emptyOK || []);
  }),
  browser.storage.local.remove(OLD_CACHE_KEYS), // older signature formats: every photo is analysed again
]).catch((e) => console.warn('could not load saved data', e));

// ---------- choices ----------

export const isDeleted = (p) => (state.overrides.has(p.id) ? state.overrides.get(p.id) : suggestDelete(p));
export const savings = (g) => g.reduce((s, p) => s + (isDeleted(p) ? p.size : 0), 0);
export const selection = () => state.groups.flatMap((g) => g.filter(isDeleted));

let saveTimer = 0;
function writeChoices() {
  saveTimer = 0;
  browser.storage.local.set({
    [CHOICES_KEY]: { overrides: Object.fromEntries(state.overrides), emptyOK: [...state.emptyOK] },
  }).catch((e) => console.warn('could not save choices', e));
}
function saveChoices() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeChoices, 300);
}
// Don't lose a click made just before the tab is closed or reloaded.
const flushChoices = () => { if (saveTimer) { clearTimeout(saveTimer); writeChoices(); } };
addEventListener('pagehide', flushChoices);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushChoices(); });

export function toggle(p) {
  state.overrides.set(p.id, !isDeleted(p));
  const key = groupKey(p.set);
  if (p.set.every(isDeleted)) state.emptyOK.add(key); else state.emptyOK.delete(key);
  saveChoices();
}

// Keep p and mark the rest of its set for deletion.
export function keepOnly(p) {
  for (const q of p.set) state.overrides.set(q.id, q !== p);
  state.emptyOK.delete(groupKey(p.set));
  saveChoices();
}

// Overrides are keyed by photo id and survive regrouping. Never let them leave a set with
// nothing kept unless the user emptied exactly this set by hand.
export function sanitizeChoices(groups) {
  let changed = false;
  for (const set of groups.flatMap((g) => g.sets)) {
    if (set.every(isDeleted) && !state.emptyOK.has(groupKey(set))) {
      state.overrides.delete(set[0].id);
      changed = true;
    }
  }
  if (changed) saveChoices();
}

export function forgetDeleted(ids) {
  state.items = state.items.filter((p) => !ids.has(p.id));
  for (const id of ids) {
    state.overrides.delete(id);
    delete state.cache[id];
  }
  for (const key of state.emptyOK) if (key.split(',').some((id) => ids.has(id))) state.emptyOK.delete(key);
  saveChoices();
  saveCache().catch((e) => console.warn('could not save signatures', e));
}

// After a complete library listing: drop data for photos that are gone from iCloud.
// A listing far smaller than what we know about is more likely an iCloud hiccup than a
// mass deletion, so then nothing is dropped.
export function pruneTo(photos) {
  const known = Object.keys(state.cache).length;
  if (!photos.length || photos.length < known / 2) {
    console.warn(`listing has ${photos.length} photos but ${known} are cached; not pruning saved data`);
    return;
  }
  const ids = new Set(photos.map((p) => p.id));
  for (const id of Object.keys(state.cache)) if (!ids.has(id)) delete state.cache[id];
  for (const id of state.overrides.keys()) if (!ids.has(id)) state.overrides.delete(id);
  for (const key of state.emptyOK) if (!key.split(',').every((id) => ids.has(id))) state.emptyOK.delete(key);
  saveChoices();
}

// ---------- signature cache ----------

let analysedSinceSave = false; // signatures in memory that storage doesn't have yet

// Fills in cached signatures; returns the photos that still need analysing. With needEmb (the
// model runs), a photo saved without an embedding counts as not analysed yet.
export function applyCache(photos, needEmb = false) {
  const todo = [];
  for (const p of photos) {
    const c = state.cache[p.id];
    if (c?.length === 6 && (c[5] || !needEmb)) {
      p.hash = [c[0], c[1]]; p.sharp = c[2]; p.lab = labFromStr(c[3]); p.expo = c[4];
      p.emb = c[5] ? embFromStr(c[5]) : null;
    } else todo.push(p);
  }
  return todo;
}

export function remember(p, r) {
  p.hash = r.hash;
  p.sharp = r.sharp;
  p.lab = r.lab;
  p.expo = r.expo;
  p.emb = r.emb || null;
  state.cache[p.id] = [...r.hash, r.sharp, labToStr(r.lab), r.expo, r.emb ? embToStr(r.emb) : null];
  analysedSinceSave = true;
}

export const saveCache = () => {
  analysedSinceSave = false;
  return browser.storage.local.set({ [CACHE_KEY]: state.cache });
};
// A scan interrupted by closing the page keeps what it analysed since the last save (best effort).
addEventListener('pagehide', () => {
  if (analysedSinceSave) saveCache().catch(() => {});
});
