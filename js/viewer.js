// Full-screen preview / zoom / compare with keyboard review (← → K D O C Space).

import { $, icon } from './dom.js';
import { keepReason } from './grouping.js';
import { loadPhoto } from './images.js';
import { isDeleted } from './store.js';
import { fmtBytes } from './util.js';
import { keepOnlyTile, showPhoto, toggleTile } from './ui.js';

export const viewer = { group: null, index: 0, card: null, compare: false };
let hovered = null; // tile under the mouse, for Quick Look-style Space
export const setHovered = (h) => { hovered = h; };

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Rect of the tile for the photo currently shown, so the preview grows out of
// (and shrinks back into) the photo you picked.
function tileRect() {
  const box = viewer.card?.querySelectorAll('.tile .img')[viewer.index];
  const r = box?.getBoundingClientRect();
  return r && r.bottom > 0 && r.top < innerHeight ? r : null;
}

function flip(img, from, reverse) {
  const to = img.getBoundingClientRect();
  if (!from || !to.width || reduceMotion.matches) return null;
  const scale = Math.max(from.width / to.width, from.height / to.height);
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const frames = [
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.6 },
    { transform: 'none', opacity: 1 },
  ];
  return img.animate(reverse ? frames.reverse() : frames, {
    duration: reverse ? 380 : 520,
    easing: 'cubic-bezier(.32, .72, 0, 1)',
    fill: reverse ? 'forwards' : 'none',
  });
}

export async function openViewer(g, i, card) {
  Object.assign(viewer, { group: g, index: i, card, compare: false });
  const el = $('#viewer');
  el.hidden = false;
  document.body.style.overflow = 'hidden';
  document.body.classList.add('viewing');
  const strip = $('#vStrip');
  strip.replaceChildren();
  g.forEach((p, j) => {
    const b = document.createElement('button');
    b.innerHTML = '<img alt="">';
    showPhoto(b.querySelector('img'), p, true);
    b.addEventListener('click', () => { viewer.index = j; paintViewer(); });
    strip.append(b);
  });
  const from = tileRect();
  paintViewer();
  requestAnimationFrame(() => el.classList.add('open'));
  const img = $('#vImg');
  await loadPhoto(g[i], 'thumb', true).catch(() => {});
  await img.decode?.().catch(() => {});
  flip(img, from, false);
}

export async function closeViewer(immediate = false) {
  if (!viewer.group) return;
  const el = $('#viewer');
  const img = $('#vImg');
  const anim = immediate ? null : flip(img, img.classList.contains('zoomed') ? null : tileRect(), true);
  el.classList.remove('open');
  viewer.group = null;
  viewer.compare = false;
  document.body.style.overflow = '';
  document.body.classList.remove('viewing');
  if (!immediate) await Promise.race([anim ? anim.finished : null, new Promise((r) => setTimeout(r, 400))]);
  if (viewer.group) return; // reopened meanwhile
  anim?.cancel();
  el.hidden = true;
  img.classList.remove('zoomed');
}

export function paintViewer() {
  const g = viewer.group;
  if (!g) return;
  const p = g[viewer.index];
  const img = $('#vImg');
  img.classList.remove('zoomed');

  // Show the cached thumbnail immediately, then swap in the larger version.
  img.removeAttribute('src');
  showPhoto(img, p, true);
  if (p.med) {
    loadPhoto(p, 'med', true).then((src) => { if (g[viewer.index] === p) img.src = src; }, () => {});
  }
  const multi = p.set.length > 1;
  if (!multi) viewer.compare = false;
  $('#vOnly').hidden = !multi;
  $('#vCompareBtn').hidden = !multi;
  $('#vCompareBtn').classList.toggle('on', viewer.compare);
  if (viewer.compare) paintCompare(p); else $('#vCompare').hidden = true;
  img.hidden = viewer.compare;

  const del = isDeleted(p);
  const cap = $('#vCap');
  cap.innerHTML = '<b></b> · <span></span>';
  cap.querySelector('b').textContent = `${viewer.index + 1} of ${g.length}`;
  cap.querySelector('span').textContent =
    `${p.name} · ${new Date(p.date).toLocaleString()} · ${p.w}×${p.h} · ${fmtBytes(p.size)}` +
    (p.fav ? ' · ★ Favorite' : '') +
    (p === p.set[0] ? ` · Suggested keep (${keepReason(p.set)})` : '');
  const btn = $('#vToggle');
  btn.innerHTML = del ? `${icon('x')}<span>Marked for delete</span>` : `${icon('check')}<span>Keeping</span>`;
  btn.className = `pill ${del ? 'del' : 'keep'}`;
  btn.title = del ? 'Click or press K to keep' : 'Click or press D to delete';
  [...$('#vStrip').children].forEach((b, j) => {
    b.classList.toggle('current', j === viewer.index);
    b.classList.toggle('del', isDeleted(g[j]));
  });
}

// Side-by-side comparison: this photo left of the divider, its set's keeper (or the
// next shot, when this is the keeper) on the right. Drag to move the divider.
const comparePartner = (p) => (p === p.set[0] ? p.set[1] : p.set[0]);

function setCompareImage(img, p) {
  img.removeAttribute('src');
  showPhoto(img, p, true);
  if (p.med) loadPhoto(p, 'med', true).then((src) => { if (viewer.compare && img.dataset.id === p.id) img.src = src; }, () => {});
  img.dataset.id = p.id;
}

function paintCompare(p) {
  const q = comparePartner(p);
  const box = $('#vCompare');
  box.hidden = false;
  // Start from the stored size; the decoded image corrects it (stored size can ignore rotation).
  box.style.aspectRatio = p.w && p.h ? `${p.w} / ${p.h}` : '4 / 3';
  setCompareImage($('#cA'), p);
  setCompareImage($('#cB'), q);
  const tag = (x) => `${isDeleted(x) ? '✕' : '✓'} ${x === x.set[0] ? 'Suggested keep' : x === p ? 'This photo' : 'Next shot'}`;
  $('#cTagA').textContent = tag(p);
  $('#cTagB').textContent = tag(q);
}

function toggleCompare() {
  const p = viewer.group?.[viewer.index];
  if (!p || p.set.length < 2) return;
  viewer.compare = !viewer.compare;
  paintViewer();
}

function keepOnlyCurrent() {
  const p = viewer.group[viewer.index];
  if (p.set.length > 1) keepOnlyTile(p, viewer.group, viewer.card);
}

{
  const box = $('#vCompare');
  const a = $('#cA');
  a.addEventListener('load', () => { if (a.naturalWidth) box.style.aspectRatio = `${a.naturalWidth} / ${a.naturalHeight}`; });
  const move = (e) => {
    const r = box.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    box.style.setProperty('--x', `${x * 100}%`);
  };
  box.addEventListener('pointerdown', (e) => { box.setPointerCapture(e.pointerId); box.classList.add('dragging'); move(e); });
  box.addEventListener('pointermove', (e) => { if (box.hasPointerCapture(e.pointerId)) move(e); });
  box.addEventListener('pointerup', () => box.classList.remove('dragging'));
  box.addEventListener('pointercancel', () => box.classList.remove('dragging'));
}

function step(d) {
  const n = viewer.group.length;
  viewer.index = (viewer.index + d + n) % n;
  paintViewer();
}

function setCurrent(del) {
  const g = viewer.group;
  const p = g[viewer.index];
  if (isDeleted(p) !== del) toggleTile(p, g, viewer.card);
}

$('#vToggle').addEventListener('click', () => toggleTile(viewer.group[viewer.index], viewer.group, viewer.card));
$('#vOnly').addEventListener('click', keepOnlyCurrent);
$('#vCompareBtn').addEventListener('click', toggleCompare);
$('#vPrev').addEventListener('click', () => step(-1));
$('#vNext').addEventListener('click', () => step(1));
$('#vClose').addEventListener('click', () => closeViewer());
$('#vImg').addEventListener('click', (e) => e.currentTarget.classList.toggle('zoomed'));
$('#viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') closeViewer(); });
document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return; // the delete sheet or Check accuracy has the keys
  if (!viewer.group) {
    // Space on a hovered photo opens it big, like Quick Look in Finder.
    if (e.key === ' ' && hovered) { e.preventDefault(); openViewer(hovered.g, hovered.i, hovered.card); }
    return;
  }
  if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); closeViewer(); }
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 'k' || e.key === 'K') setCurrent(false);
  else if (e.key === 'd' || e.key === 'D') setCurrent(true);
  else if (e.key === 'o' || e.key === 'O') keepOnlyCurrent();
  else if (e.key === 'c' || e.key === 'C') toggleCompare();
});
