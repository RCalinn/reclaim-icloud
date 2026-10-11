// Regression guard for the module split: runs the pre-refactor review.js (from the backup
// folder, with the DOM stubbed out) and the new grouping engine on the same libraries and
// checks they produce exactly the same moments, sets, keepers and order. The pair score has changed
// since (exposure-tolerant colour), so the engine runs here with the score the old one used.
// Skipped when the backup folder isn't there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { group, groupKey, suggestDelete } from '../js/grouping.js';
import { popcount, simThreshold } from '../js/signature.js';
import { WINDOWS } from '../js/config.js';
import { library } from './fixtures.js';

const OLD = fileURLToPath(new URL('../../iCloud Ext (backup 2026-10-04 before refactor)/review.js', import.meta.url));

// A do-nothing object: every property, call and `new` returns another stub.
function stub() {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_, k) => (k === Symbol.toPrimitive ? () => 0 : k === Symbol.iterator ? function* () {} : k === 'then' ? undefined : stub()),
    apply: () => stub(),
    construct: () => stub(),
    set: () => true,
  });
}

function oldEngine(dist, win) {
  const slider = (value) => new Proxy(stub(), { get: (t, k) => (k === 'value' ? value : t[k]) });
  const els = { '#dist': slider(String(dist)), '#win': slider(String(win)) };
  const ctx = vm.createContext({
    document: new Proxy({}, { get: (_, k) => (k === 'querySelector' ? (s) => els[s] || stub() : stub()) }),
    browser: {
      storage: { local: { get: () => new Promise(() => {}), set: async () => {}, remove: async () => {} } },
      runtime: { sendMessage: () => new Promise(() => {}) },
    },
    matchMedia: () => stub(), IntersectionObserver: function () { return stub(); },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, setInterval: () => 0, setTimeout: () => 0,
    navigator: {}, innerHeight: 800, atob, btoa, TextDecoder, Event: function () {},
    console: { ...console, warn() {} },
  });
  vm.runInContext(fs.readFileSync(OLD, 'utf8'), ctx);
  return (items) => { ctx.__items = items; return vm.runInContext('state.items = __items; regroup(); state.groups', ctx); };
}

// JSON round-trip: arrays built inside the vm sandbox have another realm's prototype.
const shape = (groups) => JSON.parse(JSON.stringify(groups.map((g) => ({
  sets: g.sets.map((s) => s.map((p) => p.id)),
  start: g.start,
  del: g.map((p) => suggestDelete(p)),
}))));

// The pre-refactor pair score: pHash Hamming distance + 0.3 × mean |ΔLab| per cell.
function oldDistance(a, b) {
  let c = 0;
  for (let i = 0; i < 48; i += 3) {
    c += Math.abs(a.lab[i] - b.lab[i]) / 2.55 + Math.abs(a.lab[i + 1] - b.lab[i + 1]) + Math.abs(a.lab[i + 2] - b.lab[i + 2]);
  }
  return popcount(a.hash[0] ^ b.hash[0]) + popcount(a.hash[1] ^ b.hash[1]) + 0.3 * (c / 16);
}

const clone = (xs) => xs.map((p) => ({ ...p, hash: [...p.hash], lab: new Uint8Array(p.lab) }));

test('new grouping matches the pre-refactor engine', { skip: !fs.existsSync(OLD) && 'backup folder not found' }, () => {
  let compared = 0;
  for (const seed of [1, 2, 3]) {
    const base = library(seed, 90);
    for (const [dist, win] of [[10, 4], [4, 0], [16, 7], [12, 2]]) {
      const oldGroups = oldEngine(dist, win)(clone(base));
      const savings = (g) => g.reduce((s, p) => s + (suggestDelete(p) ? p.size : 0), 0);
      const newGroups = group(clone(base), simThreshold(dist), WINDOWS[win], oldDistance).sort((a, b) => savings(b) - savings(a));
      assert.deepEqual(shape(newGroups), shape(oldGroups), `seed ${seed}, slider ${dist}, window ${win}`);
      assert.ok(newGroups.length > 0);
      compared += newGroups.length;
    }
  }
  assert.ok(compared > 50, `only ${compared} groups compared`);
});

test('groupKey is order independent', () => {
  assert.equal(groupKey([{ id: 'b' }, { id: 'a' }]), groupKey([{ id: 'a' }, { id: 'b' }]));
});
