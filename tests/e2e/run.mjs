// End-to-end check of the review page in headless Firefox against a fake iCloud.
// Setup once: npm install   ·   Run: npm run e2e
// Covers: boot, scan with worker analysis (classic signatures must equal Node's, every photo gets a
// DINOv2 embedding), choices surviving a reload, viewer keyboard review (incl. keep-only and compare),
// the delete flow (scan locked meanwhile), the classic fallback when the model can't load, and the
// main-thread fallback when workers fail.
import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { start } from './server.mjs';
import { group } from '../../js/grouping.js';
import { simThreshold } from '../../js/signature.js';

const BASE = 'http://localhost:8765/__h/test.html';
const FIREFOX = process.env.FIREFOX || '/Applications/Firefox.app/Contents/MacOS/firefox';

const { server } = await start(8765, { latency: 60, throttle: 0.05 }); // slow CDN with 5% 429s
const lib = await (await fetch('http://localhost:8765/__h/library.json')).json();
const opts = new firefox.Options().addArguments('-headless').windowSize({ width: 1400, height: 1000 });
opts.setBinary(FIREFOX);
const d = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();

const ok = [], bad = [];
const check = (cond, msg) => { (cond ? ok : bad).push(msg); if (process.env.VERBOSE) console.log(cond ? "  ok" : "  FAIL", msg); };
const js = (s, ...a) => d.executeScript(s, ...a);
const status = () => js(`return document.getElementById('status').textContent`);
const waitStatus = (re, ms = 120000) => d.wait(async () => re.test(await status()), ms); // a full scan runs the model: ~1 min
const delTitles = () => js(`return [...document.querySelectorAll('.tile.del')].map(t => t.title.split('\\n')[0]).sort()`);
const tileTitle = async (el) => (await el.findElement(By.xpath('../..')).getAttribute('title')).split('\n')[0];

// Records every status text (and whether the progress bar sweeps or fills) from now on.
const logStatus = () => js(`window.__statusLog = [];
  const el = document.getElementById('status'), bar = document.getElementById('progress');
  new MutationObserver(() => __statusLog.push({ text: el.textContent,
    bar: bar.classList.contains('indeterminate') ? 'sweeping' : bar.classList.contains('on') ? 'determinate' : 'hidden' }))
    .observe(el, { childList: true, characterData: true, subtree: true });`);

// A clean page. Saved signatures survive unless keepSigs is false, so only tests about analysing
// photos pay for running the model on the whole library again.
async function fresh(patch = '', keepSigs = true) {
  await d.get(BASE);
  await js(`const sigs = arguments[1] && localStorage.getItem('s:signatures-v3');
    localStorage.clear(); sessionStorage.clear();
    if (sigs) localStorage.setItem('s:signatures-v3', sigs);
    if (arguments[0]) sessionStorage.setItem("patch", arguments[0])`, patch, keepSigs);
  await d.navigate().refresh();
  await d.wait(until.elementLocated(By.css('.empty')), 10000);
}

try {
  await fresh();
  const conn = await d.wait(async () => {
    const t = await js(`return document.getElementById('conn').textContent`);
    return t !== 'Checking connection…' && t;
  }, 5000);
  check(conn === 'Connected to iCloud', `page boots (${conn})`);

  // ---- first scan: every photo analysed in workers
  const t0 = Date.now();
  await logStatus();
  await d.findElement(By.id('scan')).click();
  await waitStatus(/^Scanned/);
  const workers = await js('return window.__workers');
  check((await status()) === `Scanned ${lib.length} photos.`, `scan: ${await status()} (${Date.now() - t0} ms, ${workers} worker(s))`);
  const assets = lib.length + 1; // the mock library also holds one video
  const reading = (await js('return window.__statusLog')).filter((s) => s.text.startsWith('Reading library'));
  const last = reading.at(-1);
  check(last?.text === `Reading library… ${assets} of ${assets} items` && last.bar === 'determinate' &&
    reading.every((s) => /^Reading library… [\d,]+ of [\d,]+ items$/.test(s.text) || /^Reading library… [\d,]+ items$/.test(s.text)),
    `reading shows the library total (${reading.map((s) => `${s.text} [${s.bar}]`).join(' → ')})`);
  check(workers >= 1, 'analysis ran in a worker');
  const groups = (await d.findElements(By.css('section.group'))).length;
  check(groups > 5, `${groups} groups rendered`);
  const order = await js(`return [...document.querySelectorAll('#groups > *')].map(el =>
    el.classList.contains('block-head') ? 'H:' + el.querySelector('h3').textContent : el.querySelector('time').textContent)`);
  const heads = order.filter((x) => x.startsWith('H:')).map((x) => x.slice(2));
  const times = order.filter((x) => !x.startsWith('H:') && x !== 'No date').map((x) => Date.parse(x.replace(' at ', ' ')));
  check(order[0].startsWith('H:') && heads.length === new Set(heads).size && heads.length >= 2,
    `month blocks: ${heads.join(', ')}`);
  check(times.every((t, i) => !i || Number.isNaN(t) || Number.isNaN(times[i - 1]) || t >= times[i - 1]), 'groups run oldest first');
  const meta0 = await js(`return document.querySelector('.block-meta').textContent`);
  check((await js(`return document.getElementById('statVideos').textContent`)).startsWith('1 video'), 'video counted, not scanned');

  // ---- worker signatures == Node signatures (thumbnails are 64x64 PNGs: no resampling at 64 px;
  // sharpness and the embedding come from upscaled copies, so only their presence is checked)
  const cache = JSON.parse(await js(`return localStorage.getItem('s:signatures-v3')`));
  const diff = lib.filter((p) => {
    const c = cache[p.id];
    return !(c && c[0] === p.hash[0] && c[1] === p.hash[1] &&
      JSON.stringify([...Buffer.from(c[3], 'base64')]) === JSON.stringify(p.lab) &&
      c[2] > 0 && c[4] >= 0 && c[4] <= 1);
  }).map((p) => p.id);
  check(!diff.length, `worker signatures equal Node's for ${lib.length - diff.length}/${lib.length} photos${diff.length ? ` (differ: ${diff.slice(0, 5)})` : ''}`);
  const embedded = lib.filter((p) => typeof cache[p.id]?.[5] === 'string' && Buffer.from(cache[p.id][5], 'base64').length === 384).length;
  check(embedded === lib.length, `DINOv2 embedding for ${embedded}/${lib.length} photos`);

  // ---- choices survive a reload
  const before = await delTitles();
  const keeper = await d.findElement(By.css('section.group .tile:not(.del) .toggle'));
  const keeperTitle = await tileTitle(keeper);
  await keeper.click(); // Keep -> Delete
  const marked = await d.findElement(By.css('section.group .tile.del .toggle'));
  if ((await tileTitle(marked)) !== keeperTitle) await marked.click(); // another photo: Delete -> Keep
  const after = await delTitles();
  check(JSON.stringify(after) !== JSON.stringify(before), 'clicks change the selection');
  const meta1 = await js(`return document.querySelector('.block-meta').textContent`);
  check(meta1 !== meta0, `block total updates on click ("${meta0}" -> "${meta1}")`);
  await d.sleep(600); // save is debounced
  check(!!(await js(`return localStorage.getItem('s:choices-v1')`)), 'choices saved');

  await d.navigate().refresh();
  await d.wait(until.elementLocated(By.css('.empty')), 10000);
  const t1 = Date.now();
  await d.findElement(By.id('scan')).click();
  await waitStatus(/^Scanned/);
  const restored = await delTitles();
  check(JSON.stringify(restored) === JSON.stringify(after), `choices restored after reload (${restored.length} marked; cached rescan ${Date.now() - t1} ms)`);

  // ---- a click right before reloading is not lost (save is debounced; flushed on pagehide)
  const quick = await d.findElement(By.css('section.group .tile:not(.del) .toggle'));
  const quickTitle = await tileTitle(quick);
  await quick.click();
  await d.navigate().refresh();
  await d.wait(until.elementLocated(By.css('.empty')), 10000);
  await d.findElement(By.id('scan')).click();
  await waitStatus(/^Scanned/);
  check((await delTitles()).includes(quickTitle), 'click immediately before reload is kept');

  // ---- viewer + keyboard
  await d.findElement(By.css('section.group .tile:not(.del) .img')).click();
  await d.wait(async () => (await d.findElement(By.id('viewer')).getAttribute('class')).includes('open'), 3000);
  const vText = () => js(`return document.getElementById('vToggle').textContent`);
  const vBefore = await vText();
  await d.actions().sendKeys('d').perform();
  const vAfter = await vText();
  check(vBefore.includes('Keeping') && vAfter.includes('Marked for delete'), `viewer: D marks for delete ("${vBefore}" -> "${vAfter}")`);
  await d.actions().sendKeys('k').perform();

  // O on the second shot keeps it and marks the rest of its set (incl. the suggested keeper)
  const strip = () => js(`return [...document.querySelectorAll('#vStrip button')].map(b => b.classList.contains('del'))`);
  await d.actions().sendKeys('').perform(); // ArrowRight
  await d.actions().sendKeys('o').perform();
  const afterO = await strip();
  check((await vText()).includes('Keeping') && afterO[0] === true && afterO[1] === false,
    `viewer: O keeps only this photo (strip ${JSON.stringify(afterO)})`);

  // C toggles the side-by-side comparison against the set's keeper
  const cmp = () => js(`return [document.getElementById('vCompare').hidden, document.getElementById('vImg').hidden,
    document.getElementById('cTagA').textContent, document.getElementById('cTagB').textContent]`);
  await d.actions().sendKeys('c').perform();
  const [cHidden, iHidden, tagA, tagB] = await cmp();
  check(!cHidden && iHidden && tagA.includes('This photo') && tagB.includes('Suggested keep'),
    `viewer: C opens compare ("${tagA}" | "${tagB}")`);
  await d.actions().sendKeys('c').perform();
  const [cHidden2, iHidden2] = await cmp();
  check(cHidden2 && !iHidden2, 'viewer: C again closes compare');

  // restore the suggestion: keeper only
  await d.actions().sendKeys('').perform(); // ArrowLeft
  await d.actions().sendKeys('o').perform();
  await d.actions().sendKeys('').perform(); // Escape
  await d.sleep(600);

  // ---- delete one month only (from its block header)
  const sentOps = () => js('return window.__modifyCalls.flatMap(c => c.operations).length');
  const blockBtn = await d.findElement(By.css('.block-del:not([hidden])'));
  const [, nBlock, month] = (await blockBtn.getText()).match(/Delete ([\d,]+) from (.+)/);
  const totalMarked = (await delTitles()).length;
  const sent0 = await sentOps();
  await blockBtn.click();
  check((await js(`return document.getElementById('cTitle').textContent`)).includes(`from ${month}`), `month delete asks about ${month}`);
  await js('window.__modifyDelay = 800');
  await d.findElement(By.css('#confirm button[value=ok]')).click();
  check(await js(`return document.getElementById('scan').disabled`), 'scan is locked while a delete runs');
  await waitStatus(/^Moved/);
  await js('window.__modifyDelay = 0');
  check(!(await js(`return document.getElementById('scan').disabled`)), 'scan is unlocked after the delete');
  const sentBlock = (await sentOps()) - sent0;
  check(sentBlock === +nBlock && (await delTitles()).length === totalMarked - +nBlock,
    `month delete sent ${sentBlock} of ${nBlock} from ${month}; ${totalMarked - +nBlock} still marked elsewhere`);

  // ---- delete everything that's left
  const n = (await delTitles()).length;
  const sent1 = await sentOps();
  await d.wait(async () => { try { await d.findElement(By.id('delete')).click(); return true; } catch { return false; } }, 5000);
  await d.findElement(By.css('#confirm button[value=ok]')).click();
  await waitStatus(/^Moved/);
  const sent = (await sentOps()) - sent1;
  check(sent === n && (await status()).startsWith(`Moved ${n} photos`), `delete: ${sent} sent, "${await status()}"`);
  check((await delTitles()).length < n, 'deleted photos leave the view');
  // ---- an empty listing (iCloud hiccup) must not wipe saved signatures or choices
  const saved = () => js(`return [Object.keys(JSON.parse(localStorage.getItem('s:signatures-v3'))).length, localStorage.getItem('s:choices-v1')]`);
  await d.sleep(600);
  const [sigs, choices] = await saved();
  await js(`localStorage.setItem('__empty', '1')`);
  await d.findElement(By.id('scan')).click();
  await waitStatus(/^Scanned 0/);
  await d.sleep(600);
  const [sigs2, choices2] = await saved();
  check(sigs2 === sigs && choices2 === choices, `empty listing keeps saved data (${sigs2}/${sigs} signatures, choices ${choices2 === choices ? 'unchanged' : 'CHANGED'})`);
  await js(`localStorage.removeItem('__empty')`);

  const errors = await js('return window.__errors');
  check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

  await fresh();
  await d.findElement(By.id('scan')).click();
  await waitStatus(/^Scanned/);
  await d.sleep(1200);
  (await import('node:fs')).writeFileSync(process.env.SHOT || '/dev/null', await d.takeScreenshot(), 'base64');

  // ---- iCloud won't count the library: reading falls back to a running count, scan still works
  await fresh('window.__noCount = true;');
  await logStatus();
  await d.findElement(By.id('scan')).click();
  await waitStatus(/^Scanned/);
  {
    const reading = (await js('return window.__statusLog')).filter((s) => s.text.startsWith('Reading library'));
    const errs = await js('return window.__errors');
    check((await status()) === `Scanned ${lib.length} photos.` && reading.length > 0 &&
      reading.every((s) => /^Reading library… [\d,]+ items$/.test(s.text) && s.bar === 'sweeping') && !errs.length,
      `no library total: ${reading.at(-1)?.text} [${reading.at(-1)?.bar}] → ${await status()}${errs.length ? ' errors: ' + errs : ''}`);
  }

  // ---- iCloud fails listing pages: one-off errors are retried, an asset it always fails on is skipped,
  // an outage stops the scan with a clear message, and a failure past the last asset ends the listing.
  for (const [label, patch, want, ms] of [
    ['one-off 500s', 'let n = 0; window.__failQuery = (start) => start === 100 && n++ < 2;', `Scanned ${lib.length} photos.`],
    ['asset iCloud always fails on', 'window.__failQuery = (start, n) => start <= 120 && 120 < start + n;',
      `Scanned ${lib.length - 1} photos; iCloud failed to list 1 item, left out.`, 90000],
    ['iCloud down mid-listing', 'window.__failQuery = (start) => start >= 150;', /^Reading the library stopped after 15\d items\. iCloud 500/, 90000],
    ['500 past the last asset', `window.__failQuery = (start) => start >= ${lib.length + 1};`, `Scanned ${lib.length} photos.`],
  ]) {
    await fresh(patch);
    await logStatus();
    await d.findElement(By.id('scan')).click();
    await waitStatus(/^Scanned|^Reading the library stopped/, ms);
    const st = await status();
    const retried = (await js('return window.__statusLog')).some((s) => s.text.endsWith('· iCloud error, trying again'));
    const errs = (await js('return window.__errors')).filter((e) => !/Reading the library stopped/.test(e));
    const okStatus = typeof want === 'string' ? st === want : want.test(st);
    check(okStatus && (label.includes('past') || retried) && !errs.length,
      `listing (${label}): ${st}${retried ? ' [showed retrying]' : ''}${errs.length ? ' errors: ' + errs : ''}`);
  }
  {
    // the page must still work after a listing failure: a normal rescan succeeds
    await js('sessionStorage.removeItem("patch")');
    await d.navigate().refresh();
    await d.wait(until.elementLocated(By.css('.empty')), 10000);
    await d.findElement(By.id('scan')).click();
    await waitStatus(/^Scanned/);
    check((await status()) === `Scanned ${lib.length} photos.`, `rescan after a listing failure: ${await status()}`);
  }

  // ---- Check accuracy: label a round, see per-level results, apply the suggestion, download
  await fresh();
  check(await js(`return document.getElementById('tuneOpen').disabled`), 'Check accuracy is off before a scan');
  await d.findElement(By.id('scan')).click();
  await waitStatus(/^Scanned/);
  {
    const text = (id) => js(`return document.getElementById('${id}').textContent`);
    const hidden = (id) => js(`return document.getElementById('${id}').hidden`);
    const press = (k) => d.actions().sendKeys(k).perform();
    const labelCount = async () => Object.keys(JSON.parse((await js(`return localStorage.getItem('s:labels-v1')`)) || '{}')).length;
    await d.findElement(By.id('tuneOpen')).click();
    await d.wait(async () => /^1 of \d+$/.test(await text('tCount')), 5000);
    const total = +(await text('tCount')).split(' of ')[1];
    await d.wait(() => js(`return document.querySelectorAll('.tune-pair figure.has-img').length === 2`), 10000);
    await press('s');
    const advanced = await text('tCount');
    await press('u');
    check(advanced === `2 of ${total}` && (await text('tCount')) === `1 of ${total}` && (await labelCount()) === 0,
      `labelling: S advances (${advanced}), U goes back and forgets the answer`);
    // Viewer keys stay quiet while the sheet is open.
    await press(' ');
    const viewerOpen = !(await js(`return document.getElementById('viewer').hidden`));
    const half = Math.ceil(total / 2);
    for (let i = 0; i < total; i++) await press(i === 1 ? 'n' : i < half ? 's' : 'd');
    const rows = await js(`return document.querySelectorAll('#tRows tr').length`);
    check(total >= 21 && !viewerOpen && (await hidden('tAsk')) && !(await hidden('tResult')) && rows === 17 && (await labelCount()) === total - 1,
      `round of ${total} pairs answered: ${await labelCount()} labels saved, ${rows} level rows, viewer stayed closed`);
    const suggestion = await text('tSuggest');
    const level = await js(`return document.getElementById('tUse').hidden ? null : +document.getElementById('tUse').dataset.level`);
    if (level !== null) await d.findElement(By.id('tUse')).click();
    const dist = +(await js(`return document.getElementById('dist').value`));
    check(/Suggested: level \d+|fits best/.test(suggestion) && (level === null || (dist === level && (await text('distOut')) === String(level))),
      `suggestion: "${suggestion}" → slider at ${dist}`);
    // Download: catch the file instead of saving it.
    await js(`HTMLAnchorElement.prototype.click = function () { window.__dl = this.href; }`);
    await d.findElement(By.id('tDownload')).click();
    const file = JSON.parse(await d.executeAsyncScript(`fetch(window.__dl).then((r) => r.text()).then(arguments[0])`));
    const leaks = lib.filter((p) => p.date > 0).some((p) => JSON.stringify(file).includes(String(p.date)) || JSON.stringify(file).includes(`"${p.id}"`));
    check(file.pairs.length === total - 1 && file.recordFields.CPLAsset.includes('assetDate') && !leaks,
      `download: ${file.pairs.length} pairs, fields ${file.recordFields.CPLAsset.join(',')}, no ids or dates`);
    await press('\uE00C'); // Esc
    check(!(await js(`return document.getElementById('tune').open`)), 'Esc closes Check accuracy');

    await d.navigate().refresh();
    await d.wait(until.elementLocated(By.css('.empty')), 10000);
    await d.wait(async () => +(await js(`return document.getElementById('dist').value`)) === dist, 3000).catch(() => {});
    const kept = +(await js(`return document.getElementById('dist').value`));
    await d.findElement(By.id('scan')).click();
    await waitStatus(/^Scanned/);
    await d.findElement(By.id('tuneOpen')).click();
    await d.wait(async () => !(await hidden('tResult')), 5000);
    check(kept === dist && (await text('tCount')) === `${total - 1} labelled`, `after reload: Similarity ${kept}, ${await text('tCount')}`);
    await press('\uE00C');
  }

  // ---- iCloud bursts: frames sharing a burst id are one set, even when they don't look alike
  {
    const copy = lib.map((p) => ({ ...p }));
    group(copy, simThreshold(10), 300);
    const loose = copy.filter((p) => p.date > 0 && !p.set).sort((a, b) => a.date - b.date);
    const [a, b] = loose;
    await fresh(`window.__bursts = ${JSON.stringify({ [a.id]: 'B1', [b.id]: 'B1' })};`);
    await d.findElement(By.id('scan')).click();
    await waitStatus(/^Scanned/);
    const together = await js(`return [...document.querySelectorAll('.set')].some((s) => {
      const names = [...s.querySelectorAll('.tile')].map((t) => t.title.split('\\n')[0]);
      return names.includes(arguments[0]) && names.includes(arguments[1]); })`, a.name, b.name);
    check(together, `burst: ${a.name} and ${b.name} (not similar) shown as one set`);
  }

  // ---- classic fallbacks: the model can't load (workers still run), or workers fail (main thread).
  // Either way photos get the classic signature, so the page groups exactly like Node does.
  const classicGroups = (level) => group(lib.map((p) => ({ ...p })), simThreshold(level), 300).length;
  const basic = `Scanned ${lib.length} photos. The similarity model could not load, so photos were compared the basic way (less accurate).`;
  for (const [label, patch, ms, noModel] of [
    ['model file missing', '', 60000, true],
    ['worker script fails to load', `const W = window.Worker; window.Worker = class extends W { constructor(u, o) { super('/missing.js', o); } };`],
    ['no Worker support', 'window.Worker = undefined;'],
    ['worker never answers (60 s timeout)', 'window.Worker = class { postMessage() {} terminate() {} };', 180000],
  ]) {
    if (noModel) await fetch('http://localhost:8765/__h/model?block=1');
    await fresh(patch, false);
    await d.findElement(By.id('scan')).click();
    await waitStatus(/^Scanned/, ms || 120000);
    if (noModel) await fetch('http://localhost:8765/__h/model?block=0');
    const g = (await d.findElements(By.css('section.group'))).length;
    const want = classicGroups(+(await js(`return document.getElementById('dist').value`)));
    const errs = await js('return window.__errors');
    check((await status()) === basic && g === want && !errs.length, `fallback (${label}): ${await status()} ${g}/${want} groups${errs.length ? ' errors: ' + errs : ''}`);
  }
} catch (e) {
  bad.push('crashed: ' + (e.stack || e));
  try { bad.push('page errors: ' + JSON.stringify(await js('return window.__errors'))); } catch {}
} finally {
  await d.quit();
  server.close();
}
for (const m of ok) console.log('PASS', m);
for (const m of bad) console.log('FAIL', m);
process.exit(bad.length ? 1 : 0);
