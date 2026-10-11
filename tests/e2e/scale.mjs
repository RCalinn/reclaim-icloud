// Large-library check: ~20k photos, download links that expire (like iCloud's), some 429s.
// Scans, then reviews the page the way a person would over a long session and reports what
// failed to load. Usage: node tests/e2e/scale.mjs [bursts=5700] [ttlSeconds=60]
import { execSync } from 'node:child_process';
import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { start } from './server.mjs';

const [bursts = 5700, ttlS = 60] = process.argv.slice(2).map(Number);
const t0 = Date.now();
const PORT = 8766;
const { server, count, stats } = await start(PORT, { latency: 20, throttle: 0.02, bursts, ttl: ttlS * 1000 });
console.log(`library: ${count} photos (built in ${((Date.now() - t0) / 1000).toFixed(0)} s), links expire after ${ttlS} s`);

const opts = new firefox.Options().addArguments('-headless').windowSize({ width: 1400, height: 1000 });
opts.setBinary(process.env.FIREFOX || '/Applications/Firefox.app/Contents/MacOS/firefox');
const d = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
const js = (s, ...a) => d.executeScript(s, ...a);
const status = () => js(`return document.getElementById('status').textContent`);
const firefoxMB = () => {
  try {
    return Math.round(execSync(`ps -axo rss,command | grep -i 'firefox' | grep -v grep | awk '{s+=$1} END {print s}'`).toString() / 1024);
  } catch { return NaN; }
};
const report = [];
const log = (m) => { console.log(m); report.push(m); };

// Thumbnails in (or near) the viewport: loaded / failed / still loading.
const tilesHere = () => js(`
  const r = [...document.querySelectorAll('.tile .img')].filter(b => { const x = b.getBoundingClientRect(); return x.bottom > 0 && x.top < innerHeight; });
  return { total: r.length, ok: r.filter(b => b.classList.contains('has-img')).length, failed: r.filter(b => b.classList.contains('failed')).length };`);
async function settle(ms = 15000) {
  const end = Date.now() + ms;
  let t;
  do { t = await tilesHere(); if (t.ok + t.failed >= t.total) break; await d.sleep(250); } while (Date.now() < end);
  return t;
}
// Scrolls the way a person would until group k exists (cards are built as you scroll), then to it.
async function goToGroup(k) {
  for (let guard = 0; guard < 2000; guard++) {
    const n = await js(`return document.querySelectorAll('section.group').length`);
    if (n > k) break;
    await js('window.scrollTo(0, document.documentElement.scrollHeight)');
    await d.sleep(60);
  }
  await js(`const c = document.querySelectorAll('section.group')[arguments[0]]; c && c.scrollIntoView({ block: 'start' })`, k);
}
async function sweep(label, points) {
  let total = 0, ok = 0, failed = 0;
  for (const k of points) {
    await goToGroup(k);
    const t = await settle();
    total += t.total; ok += t.ok; failed += t.failed;
  }
  log(`${label}: ${ok}/${total} visible thumbnails loaded, ${failed} failed, ${total - ok - failed} still loading`);
  return { total, ok, failed };
}

try {
  await d.get(`http://localhost:${PORT}/__h/test.html`);
  await js('localStorage.clear()');
  await d.navigate().refresh();
  await d.findElement(By.css('.empty'));

  let t = Date.now();
  await d.findElement(By.id('scan')).click();
  await d.wait(async () => /^Scanned/.test(await status()), 30 * 60e3, undefined, 1000);
  log(`scan: "${await status()}" in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  const scanDone = Date.now();

  const dom = await js(`return { cards: document.querySelectorAll('section.group').length, tiles: document.querySelectorAll('.tile').length,
    nodes: document.getElementsByTagName('*').length, height: document.documentElement.scrollHeight,
    groups: document.getElementById('statGroups').textContent, marked: document.getElementById('statSel').textContent }`);
  log(`page: ${dom.groups} groups, ${dom.marked}; ${dom.cards} cards / ${dom.tiles} tiles in the DOM, ${dom.nodes} elements, ${Math.round(dom.height / 1000)}k px tall`);

  // Time a regroup (slider move) on the full library.
  t = Date.now();
  await js(`const s = document.getElementById('dist'); s.value = 9; s.dispatchEvent(new Event('input'));`);
  await d.sleep(50);
  await js(`return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  log(`slider move -> re-render: ${Date.now() - t} ms`);
  await js(`const s = document.getElementById('dist'); s.value = 10; s.dispatchEvent(new Event('input'));`);
  await d.sleep(500);

  const nGroups = +(await js(`return document.getElementById('statGroups').textContent`)).replace(/\D/g, '');
  const points = Array.from({ length: 15 }, (_, i) => Math.round((nGroups - 1) * (i / 14)));
  log(`firefox memory after scan: ${firefoxMB()} MB`);

  // Links issued during the scan have all expired by now.
  const wait1 = Math.max(0, scanDone + (ttlS + 5) * 1000 - Date.now());
  log(`waiting ${Math.round(wait1 / 1000)} s for every link to expire…`);
  await d.sleep(wait1);
  await sweep('after links expired', points);

  // ...and expire again: a long review session outlives refreshed links too.
  await d.sleep((ttlS + 5) * 1000);
  await sweep('after a second expiry', points);

  // Big preview deep in the list.
  await goToGroup(points[12]);
  await settle();
  await js(`[...document.querySelectorAll('.tile .img')].find(b => b.getBoundingClientRect().top > 0).click()`);
  await d.sleep(4000);
  const v = await js(`const i = document.getElementById('vImg'); const strip = [...document.querySelectorAll('#vStrip img')];
    return { big: i.complete && i.naturalWidth > 0, src: (i.currentSrc || '').slice(0, 5), strip: strip.filter(x => x.complete && x.naturalWidth > 0).length + '/' + strip.length }`);
  log(`preview deep in the list: big image ${v.big ? 'shown' : 'MISSING'}, strip ${v.strip} loaded`);
  await d.actions().sendKeys('').perform();

  const mem = await js('return window.__blobs');
  const built = await js(`return { cards: document.querySelectorAll('section.group').length, withImage: document.querySelectorAll('.tile .img.has-img').length, nodes: document.getElementsByTagName('*').length }`);
  log(`after scrolling to the end: ${built.cards} cards built, ${built.withImage} tiles holding an image, ${built.nodes} elements`);
  log(`object URLs alive: ${mem ? mem.live : 'n/a'} (created ${mem ? mem.created : 'n/a'}); firefox memory now: ${firefoxMB()} MB`);
  log(`server: ${stats.expired} requests refused as expired; page made ${await js('return window.__lookups')} link-refresh lookups`);
  const errors = await js('return window.__errors');
  log(`page errors: ${errors.length ? errors.slice(0, 5).join(' | ') : 'none'}`);
} catch (e) {
  log('crashed: ' + (e.stack || e));
} finally {
  await d.quit();
  server.close();
}
