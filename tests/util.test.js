import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptivePool, sleep } from '../js/util.js';

const opts = { start: 4, min: 2, max: 12 };

test('runs every item exactly once and resolves when done', async () => {
  const seen = [];
  await adaptivePool([...Array(50).keys()], opts, async (x) => { await sleep(1); seen.push(x); });
  assert.deepEqual(seen.sort((a, b) => a - b), [...Array(50).keys()]);
});

test('empty input resolves immediately', async () => {
  const ctl = await adaptivePool([], opts, async () => { throw new Error('not called'); });
  assert.equal(ctl.limit, 4);
});

test('parallelism grows while all is well, never above max', async () => {
  let active = 0, peak = 0;
  const ctl = await adaptivePool([...Array(300).keys()], opts, async () => {
    peak = Math.max(peak, ++active);
    await sleep(2);
    active--;
  });
  assert.equal(ctl.peak, 12);
  assert.ok(peak <= 12 && peak > 4, `peak ${peak}`);
});

test('throttling cuts parallelism by 30% (once per burst) and never below min', async () => {
  let active = 0, after = 0;
  const ctl = await adaptivePool([...Array(120).keys()], { start: 8, min: 2, max: 8 }, async (x, throttle) => {
    active++;
    if (x === 20) { throttle(); throttle(); throttle(); } // a burst of 429s
    if (x > 40) after = Math.max(after, active);
    await sleep(2);
    active--;
  });
  assert.ok(after <= 5, `after a burst at most 5 (of 8) run at once (saw ${after})`);
  assert.ok(ctl.limit >= 2);
});

test('a failing job does not stop the pool', async () => {
  let n = 0;
  await adaptivePool([...Array(20).keys()], opts, async (x) => { n++; if (x % 3 === 0) throw new Error('boom'); });
  assert.equal(n, 20);
});
