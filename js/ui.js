// Group cards, thumbnails, and the summary / stats.

import { $, icon, setStatus } from './dom.js';
import { keepReason } from './grouping.js';
import { loadPhoto, Skipped } from './images.js';
import { isDeleted, keepOnly, savings, selection, state, toggle } from './store.js';
import { fmtBytes } from './util.js';
import { closeViewer, paintViewer, setHovered, viewer, openViewer } from './viewer.js';

const failedBoxes = new Set();

// Thumbnails follow the viewport: a tile starts loading when it comes within NEAR of the
// screen, and gives its image back once it is more than FAR away, so memory stays flat no
// matter how far down a 20k-photo library you scroll.
const NEAR = '800px';
const FAR = '5000px';
const CHUNK = 40; // cards built at a time; more are added as you approach the end

export function showPhoto(img, p, urgent = false, wanted = null) {
  const box = img.parentElement;
  box.classList.remove('failed');
  failedBoxes.delete(box);
  box.loading = true;
  return loadPhoto(p, 'thumb', urgent, wanted).then(
    (src) => {
      img.onload = () => { img.classList.add('loaded'); box.classList.add('has-img'); };
      img.src = src;
    },
    (e) => {
      if (e instanceof Skipped) return; // scrolled away before its turn; reloads when back
      console.warn('thumbnail failed', p.name, e);
      box.classList.add('failed');
      failedBoxes.add(box);
      showFailures();
    }
  ).finally(() => {
    box.loading = false;
    if (box.near && !img.getAttribute('src') && !box.classList.contains('failed')) box.dispatchEvent(new Event('load-photo'));
  });
}

function showFailures() {
  const el = $('#status');
  const n = [...failedBoxes].filter((b) => b.isConnected).length;
  if (!n) return;
  el.classList.remove('error');
  el.innerHTML = `${n} thumbnail${n === 1 ? '' : 's'} couldn’t load · <button class="link">Retry</button>`;
  el.querySelector('button').addEventListener('click', retryFailed);
}

function retryFailed() {
  setStatus('Retrying…');
  for (const box of [...failedBoxes]) {
    failedBoxes.delete(box);
    if (box.isConnected) box.dispatchEvent(new Event('retry'));
  }
}

const near = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const box = e.target;
    box.near = e.isIntersecting;
    if (box.near && !box.loading && !box.querySelector('img').getAttribute('src') && !box.classList.contains('failed')) {
      box.dispatchEvent(new Event('load-photo'));
    }
  }
}, { rootMargin: NEAR });

const far = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) continue;
    const img = e.target.querySelector('img');
    if (!img.getAttribute('src')) continue;
    img.removeAttribute('src');
    img.classList.remove('loaded');
    e.target.classList.remove('has-img');
  }
}, { rootMargin: FAR });

const revealer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('in');
    revealer.unobserve(e.target);
  }
}, { rootMargin: '0px 0px -40px 0px' });

// Builds the next CHUNK cards when the end of what's built comes into range.
const more = new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting)) renderMore();
}, { rootMargin: '3000px' });

let deleteBlock = null; // set by the app: (groups, label) => void
export const onDeleteBlock = (fn) => { deleteBlock = fn; };

let pending = []; // groups not built yet, in display order
let animate = true;
let lastBlock = null;

export function render() {
  const main = $('#groups');
  if (viewer.group) closeViewer(true);
  setHovered(null);
  for (const o of [near, far, revealer, more]) o.disconnect();
  failedBoxes.clear();
  main.replaceChildren();
  if (!state.groups.length) {
    const scanned = state.items.length > 0;
    main.innerHTML = `
      <div class="empty shell"><div class="core">
        <h3>${scanned ? 'No similar photos at this setting' : 'Your library hasn’t been scanned yet'}</h3>
        <p>${scanned ? 'Try moving Similarity toward Loose or widening the time window.' : 'Keep iCloud Photos open in another tab, then press Scan library.'}</p>
      </div></div>`;
    pending = [];
    updateSummary();
    return;
  }

  // Groups arrive oldest first; each month is a block with its own header and delete button.
  // Blocks are worked out for every group now, so header totals are right before all is built.
  let block = null;
  for (const g of state.groups) {
    const key = Number.isFinite(g.start) ? monthLabel(g.start) : 'No date';
    if (key !== block?.key) block = { key, head: null, groups: [] };
    block.groups.push(g);
    blockOf.set(g, block);
  }

  pending = [...state.groups].reverse(); // pop() from the end = next in order
  animate = true; // only cards on the first screen fade in
  lastBlock = null;
  renderMore();
  updateSummary();
}

function renderMore() {
  const main = $('#groups');
  main.querySelector('.more')?.remove();
  for (let n = 0; n < CHUNK && pending.length; n++) {
    const g = pending.pop();
    const block = blockOf.get(g);
    if (block !== lastBlock) {
      main.append(blockHead(block));
      lastBlock = block;
    }
    const card = buildCard(g);
    main.append(card);
    if (animate && card.getBoundingClientRect().top < innerHeight) revealer.observe(card);
    else { animate = false; card.classList.remove('reveal'); }
  }
  if (pending.length) {
    const sentinel = Object.assign(document.createElement('div'), { className: 'more' });
    sentinel.textContent = `${pending.length.toLocaleString()} more groups…`;
    main.append(sentinel);
    more.observe(sentinel);
  }
}

function blockHead(block) {
  const head = document.createElement('div');
  head.className = 'block-head';
  head.innerHTML = '<h3></h3><span class="block-meta"></span><button class="pill danger block-del"></button>';
  head.querySelector('h3').textContent = block.key;
  head.querySelector('.block-del').addEventListener('click', () => deleteBlock?.(block.groups, block.key));
  block.head = head;
  paintBlock(block);
  return head;
}

function buildCard(g) {
  const card = document.createElement('section');
  card.className = 'group shell reveal';
  card.innerHTML = `
    <div class="core">
      <div class="ghead">
        <h2>${g.sets.length > 1 ? `${g.length} photos from the same moment` : `${g.length} similar photos`}<time></time></h2>
        <div class="chips"><span class="chip free"></span><span class="chip">${g.sets.length > 1 ? `${g.sets.length} sets · best of each kept` : `Keeps the ${keepReason(g)}`}</span><span class="chip warn" hidden>Nothing kept</span></div>
      </div>
      <div class="tiles${g.sets.length > 1 ? ' multi' : ''}"></div>
    </div>`;
  card.querySelector('time').textContent = Number.isFinite(g.start)
    ? new Date(g.start).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'No date';
  const tilesEl = card.querySelector('.tiles');
  // One row per set of near-identical shots; the set's keeper comes first.
  const setEls = new Map(g.sets.map((set) => {
    const el = document.createElement('div');
    el.className = 'set';
    if (g.sets.length > 1) el.innerHTML = `<span class="set-label">${set.length} similar · keeps the ${keepReason(set)}</span>`;
    tilesEl.append(el);
    return [set, el];
  }));

  g.forEach((p, i) => {
    const t = document.createElement('div');
    t.className = 'tile';
    t.title = `${p.name}\n${new Date(p.date).toLocaleString()}\nClick or press Space to preview`;
    t.innerHTML = `
      <div class="img"><img alt=""><span class="retry">Couldn’t load · click to retry</span>${p.fav ? `<span class="fav">${icon('star')}</span>` : ''}</div>
      <div class="meta"><span></span><button class="toggle"></button></div>`;
    const box = t.querySelector('.img');
    const img = box.querySelector('img');
    const wanted = () => box.near && box.isConnected;
    box.addEventListener('load-photo', () => showPhoto(img, p, false, wanted));
    box.addEventListener('retry', () => showPhoto(img, p, true));
    near.observe(box);
    far.observe(box);
    t.querySelector('.meta span').textContent = `${Math.round((p.w * p.h) / 1e6)} MP · ${fmtBytes(p.size)}`;
    box.addEventListener('mouseenter', () => setHovered({ g, i, card }));
    box.addEventListener('mouseleave', () => setHovered(null));
    box.addEventListener('click', () => {
      if (box.classList.contains('failed')) showPhoto(img, p, true);
      else openViewer(g, i, card);
    });
    t.querySelector('.toggle').addEventListener('click', () => toggleTile(p, g, card));
    setEls.get(p.set).append(t);
  });
  paintGroup(card, g);
  return card;
}

export function toggleTile(p, g, card) {
  toggle(p);
  repaint(g, card);
}

export function keepOnlyTile(p, g, card) {
  keepOnly(p);
  repaint(g, card);
}

function repaint(g, card) {
  paintGroup(card, g);
  paintBlock(blockOf.get(g));
  updateSummary();
  if (viewer.group === g) paintViewer();
}

const blockOf = new WeakMap(); // group -> its month block
const monthLabel = (t) => new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

function paintBlock(block) {
  if (!block?.head) return;
  const n = block.groups.length;
  const sel = block.groups.flatMap((g) => g.filter(isDeleted));
  const freed = sel.reduce((s, p) => s + p.size, 0);
  block.head.querySelector('.block-meta').textContent =
    `${n} group${n === 1 ? '' : 's'}` + (freed ? ` · frees ${fmtBytes(freed)}` : '');
  const btn = block.head.querySelector('.block-del');
  btn.textContent = `Delete ${sel.length.toLocaleString()} from ${block.key}`;
  btn.hidden = !sel.length;
  btn.disabled = state.busy;
}

function paintGroup(card, g) {
  const tiles = card.querySelectorAll('.tile');
  g.forEach((p, i) => {
    const del = isDeleted(p);
    tiles[i].classList.toggle('del', del);
    tiles[i].querySelector('.toggle').innerHTML = del ? `${icon('x')}Delete` : `${icon('check')}Keep`;
  });
  const freed = savings(g);
  const free = card.querySelector('.chip.free');
  free.textContent = freed ? `Frees ${fmtBytes(freed)}` : 'Keeping all';
  card.querySelector('.chip.warn').hidden = !g.sets.some((set) => set.every(isDeleted));
}

export function updateSummary() {
  const sel = selection();
  const bytes = sel.reduce((sum, p) => sum + p.size, 0);
  const summary = $('#summary');
  summary.innerHTML = '<strong></strong> · <span></span>';
  summary.querySelector('strong').textContent = `${sel.length} photo${sel.length === 1 ? '' : 's'}`;
  summary.querySelector('span').textContent = fmtBytes(bytes);
  $('#delete').disabled = state.busy || !sel.length;
  $('#actionbar').classList.toggle('show', sel.length > 0);

  $('#statFree').textContent = state.groups.length ? fmtBytes(bytes) : '—';
  $('#statSel').textContent = state.groups.length
    ? `${sel.length} photos marked across ${state.groups.length} groups`
    : state.items.length ? 'No similar groups at this setting' : 'Run a scan to begin';
  $('#statGroups').textContent = state.items.length ? state.groups.length.toLocaleString() : '—';
  $('#tuneOpen').disabled = state.busy || !state.items.some((p) => p.hash);
}
