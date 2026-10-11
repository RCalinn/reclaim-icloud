// Check accuracy sheet: label pairs from the library as "same shot" / "different", then see how
// each Similarity level does on those answers, apply the suggested level, or download the labels.

import { LABELS_KEY, WINDOWS } from './config.js';
import { $ } from './dom.js';
import { exportLabels, levelStats, MIN_EACH, pairKey, ROUND, samplePairs, suggestLevel } from './accuracy.js';
import { seenFields } from './icloud.js';
import { loadPhoto } from './images.js';
import { state } from './store.js';

let labels = new Map(); // pairKey -> true (same shot) / false (different)
const loaded = browser.storage.local.get(LABELS_KEY)
  .then((r) => { labels = new Map(Object.entries(r[LABELS_KEY] || {}).map(([k, v]) => [k, v === 1])); })
  .catch((e) => console.warn('could not load labels', e));
const saveLabels = () => browser.storage.local.set({ [LABELS_KEY]: Object.fromEntries([...labels].map(([k, v]) => [k, v ? 1 : 0])) })
  .catch((e) => console.warn('could not save labels', e));

const round = { pairs: [], pos: 0 };
let shown = 0; // bumps on every pair shown, so a slow image can't land on the next pair
let download = null; // object URL of the last download, released on the next one

const dlg = $('#tune');
const W = () => WINDOWS[+$('#win').value];
const photos = () => state.items.filter((p) => p.hash);

// Labelled pairs whose photos are still in the library, with their current signatures.
function labelledPairs() {
  const byId = new Map(photos().map((p) => [p.id, p]));
  const out = [];
  for (const [key, same] of labels) {
    const [a, b] = key.split('|').map((id) => byId.get(id));
    if (a && b) out.push({ a, b, same });
  }
  return out;
}

function gapText(ms) {
  const s = Math.round(ms / 1000);
  if (s < 1) return 'Taken at the same moment';
  if (s < 60) return `Taken ${s} s apart`;
  if (s < 3600) return `Taken ${Math.round(s / 60)} min apart`;
  return 'Taken 1 h apart';
}

function showImage(img, p, token) {
  const fig = img.parentElement;
  fig.classList.remove('failed', 'has-img');
  img.removeAttribute('src');
  let sharp = false; // the preview is in: a late thumbnail must not replace it
  const set = (src, isPreview) => {
    if (token !== shown || (sharp && !isPreview)) return;
    sharp ||= isPreview;
    img.src = src;
    fig.classList.add('has-img');
  };
  loadPhoto(p, 'thumb', true).then((src) => set(src, false), () => {});
  loadPhoto(p, p.med ? 'med' : 'thumb', true).then((src) => set(src, true), () => { if (token === shown && !img.getAttribute('src')) fig.classList.add('failed'); });
}

function paintAsk() {
  const pair = round.pairs[round.pos];
  $('#tAsk').hidden = false;
  $('#tResult').hidden = true;
  $('#tTitle').textContent = 'Same shot?';
  $('#tCount').textContent = `${round.pos + 1} of ${round.pairs.length}`;
  $('#tGap').textContent = `Pair ${round.pos + 1} of ${round.pairs.length}. ${gapText(Math.abs(pair.a.date - pair.b.date))}.`;
  $('#tUndo').disabled = round.pos === 0;
  keepFocus();
  const token = ++shown;
  showImage($('#tA'), pair.a, token);
  showImage($('#tB'), pair.b, token);
  // Warm the next pair's previews while this one is being looked at.
  const next = round.pairs[round.pos + 1];
  if (next) for (const p of [next.a, next.b]) loadPhoto(p, p.med ? 'med' : 'thumb').catch(() => {});
}

// A focused button that gets hidden or disabled drops focus to the page; keep it in the sheet.
function keepFocus() {
  if (dlg.open && !dlg.contains(document.activeElement)) dlg.focus();
  else if (document.activeElement?.disabled || document.activeElement?.closest('[hidden]')) dlg.focus();
}

function answer(same) { // true / false, or null for "not sure"
  if ($('#tAsk').hidden || !round.pairs.length) return;
  const pair = round.pairs[round.pos];
  if (same === null) labels.delete(pairKey(pair.a, pair.b));
  else labels.set(pairKey(pair.a, pair.b), same);
  saveLabels();
  round.pos++;
  if (round.pos < round.pairs.length) paintAsk(); else paintResult();
}

function undo() {
  if ($('#tAsk').hidden || round.pos === 0) return;
  round.pos--;
  const pair = round.pairs[round.pos];
  labels.delete(pairKey(pair.a, pair.b));
  saveLabels();
  paintAsk();
}

function startRound() {
  round.pairs = samplePairs(photos(), labels, ROUND);
  round.pos = 0;
  if (round.pairs.length) paintAsk();
  else paintResult('There are no more pairs to label in this library.');
}

function paintResult(note = '') {
  ++shown;
  $('#tAsk').hidden = true;
  $('#tResult').hidden = false;
  $('#tTitle').textContent = 'How each level does';
  const pairs = labelledPairs();
  const stats = levelStats(pairs, W());
  const { same, diff } = stats[0];
  $('#tCount').textContent = `${pairs.length} labelled`;
  const best = suggestLevel(stats);
  const current = +$('#dist').value;
  const sug = $('#tSuggest');
  if (best === null) {
    sug.textContent = `${note ? note + ' ' : ''}Label at least ${MIN_EACH} pairs of each kind to get a suggestion. So far: ${same} same shot, ${diff} different.`;
  } else {
    const s = stats[best];
    sug.innerHTML = '<strong></strong> <span></span>';
    sug.querySelector('strong').textContent = best === current ? `Level ${best} (your current setting) fits best.` : `Suggested: level ${best}.`;
    sug.querySelector('span').textContent = `${note ? note + ' ' : ''}It groups ${s.found} of the ${same} pairs you called the same shot, and wrongly groups ${s.wrong} of the ${diff} you called different.`;
  }
  const use = $('#tUse');
  use.hidden = best === null || best === current;
  if (best !== null) { use.textContent = `Use level ${best}`; use.dataset.level = best; }
  $('#tMore').textContent = `Label ${ROUND} more`;
  $('#tDownload').disabled = !pairs.length;

  const rows = $('#tRows');
  rows.replaceChildren();
  for (const s of stats) {
    const tr = document.createElement('tr');
    tr.classList.toggle('current', s.level === current);
    tr.classList.toggle('best', s.level === best);
    const tag = [s.level === current && 'now', s.level === best && 'suggested'].filter(Boolean).join(' · ');
    tr.innerHTML = '<td><b></b><span class="tag"></span></td><td></td><td></td>';
    tr.querySelector('b').textContent = s.level;
    tr.querySelector('.tag').textContent = tag;
    tr.children[1].textContent = same ? `${s.found} of ${same}` : '–';
    tr.children[2].textContent = diff ? `${s.wrong} of ${diff}` : '–';
    rows.append(tr);
  }
  keepFocus();
}

function downloadLabels() {
  const pairs = labelledPairs();
  if (!pairs.length) return;
  if (download) URL.revokeObjectURL(download);
  const blob = new Blob([JSON.stringify(exportLabels(pairs, W(), seenFields), null, 1)], { type: 'application/json' });
  download = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: download, download: `similar-photos-labels-${pairs.length}.json` });
  a.click();
}

function useLevel() {
  const slider = $('#dist');
  slider.value = $('#tUse').dataset.level;
  slider.dispatchEvent(new Event('input'));
  slider.dispatchEvent(new Event('change'));
  paintResult();
}

export async function openTune() {
  if (!photos().length || dlg.open) return;
  await loaded;
  if (dlg.open) return; // a second click while labels were loading
  dlg.showModal();
  dlg.focus(); // not the first button: Space or Enter must not close the sheet or answer by accident
  if (round.pos < round.pairs.length && round.pairs.every((p) => state.items.includes(p.a) && state.items.includes(p.b))) paintAsk(); // resume
  else if (labels.size) paintResult();
  else startRound();
}

$('#tSame').addEventListener('click', () => answer(true));
$('#tDiff').addEventListener('click', () => answer(false));
$('#tSkip').addEventListener('click', () => answer(null));
$('#tUndo').addEventListener('click', undo);
$('#tMore').addEventListener('click', startRound);
$('#tUse').addEventListener('click', useLevel);
$('#tDownload').addEventListener('click', downloadLabels);
$('#tClose').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // backdrop
dlg.addEventListener('close', () => { ++shown; });
dlg.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 's') answer(true);
  else if (k === 'd') answer(false);
  else if (k === 'n') answer(null);
  else if (k === 'u' || k === 'backspace') undo();
  else return;
  e.preventDefault();
});
