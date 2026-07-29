'use strict';
// Tests for the two-pass identity colouring (visibility budget + co-visibility
// graph colouring) that replaced the history-dependent ledger.
//
// The properties under test are the ones the old model violated:
//   1. determinism — colours never depend on navigation/block order
//   2. sibling stability — a shared parent variable keeps one hue everywhere
//   3. safe reuse — non-co-visible names may share a hue (that is what lets K
//      hues cover a function with more than K locals)
//   4. no collisions — names co-visible in ANY block always differ
//   5. budget — each block fills up to K, ranked by attention priority

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../out/scopecolor');

function info(cls, opts = {}) {
  return {
    cls,
    freqInBlock: opts.freq ?? 2,
    firstFileOffset: opts.file ?? 0,
    firstBlockOffset: opts.block ?? 0,
    isCapture: opts.isCapture ?? false,
    proximity: opts.proximity ?? (cls === 'block' ? 0 : 1),
  };
}
const blk = (focusKey, entries) => ({ focusKey, byName: new Map(entries) });

test('colorScope: deterministic — block order cannot change any hue', () => {
  const blocks = [
    blk('a', [['x', info('block')], ['y', info('block')], ['shared', info('fn')]]),
    blk('b', [['z', info('block')], ['w', info('block')], ['shared', info('fn')]]),
    blk('c', [['p', info('block')], ['shared', info('fn')]]),
  ];
  const first = sc.colorScope(blocks, 5);
  const reversed = sc.colorScope([...blocks].reverse(), 5);
  const rotated = sc.colorScope([blocks[1], blocks[2], blocks[0]], 5);
  for (const other of [reversed, rotated]) {
    assert.equal(other.hue.size, first.hue.size);
    for (const [name, h] of first.hue) {
      assert.equal(other.hue.get(name), h, `${name} hue must not depend on block order`);
    }
  }
});

test('colorScope: a shared parent variable keeps ONE hue across sibling blocks', () => {
  const blocks = [
    blk('loop1', [['c', info('block')], ['names', info('fn')]]),
    blk('loop2', [['idx', info('block')], ['names', info('fn')]]),
    blk('closure', [['i', info('block')], ['j', info('block')], ['names', info('fn')]]),
  ];
  const { hue, visible } = sc.colorScope(blocks, 5);
  const h = hue.get('names');
  assert.ok(h !== undefined, 'shared variable gets a hue');
  for (const key of ['loop1', 'loop2', 'closure']) {
    assert.ok(visible.get(key).includes('names'), `visible in ${key}`);
  }
  // one vertex → one hue, by construction
  assert.equal(hue.get('names'), h);
});

test('colorScope: non-co-visible siblings may share a hue (K hues cover >K names)', () => {
  // 9 locals, 3 per sibling block, palette of 3 → every name must still tint.
  const blocks = [
    blk('s1', [['a', info('block')], ['b', info('block')], ['c', info('block')]]),
    blk('s2', [['d', info('block')], ['e', info('block')], ['f', info('block')]]),
    blk('s3', [['g', info('block')], ['h', info('block')], ['i', info('block')]]),
  ];
  const { hue } = sc.colorScope(blocks, 3);
  for (const n of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) {
    assert.ok(hue.get(n) !== undefined, `${n} tints despite only 3 hues for 9 names`);
  }
  // reuse actually happened
  assert.ok(new Set([...hue.values()]).size <= 3);
});

test('colorScope: names co-visible in ANY block never share a hue', () => {
  const blocks = [
    blk('big', [
      ['a', info('block', { block: 1 })],
      ['b', info('block', { block: 2 })],
      ['c', info('block', { block: 3 })],
    ]),
    // a and d co-occur here, so they must differ even though d is elsewhere too
    blk('other', [['a', info('fn', { block: 1 })], ['d', info('block', { block: 2 })]]),
  ];
  const { hue, visible } = sc.colorScope(blocks, 5);
  for (const key of ['big', 'other']) {
    const names = visible.get(key).filter((n) => hue.get(n) !== undefined);
    const hues = names.map((n) => hue.get(n));
    assert.equal(new Set(hues).size, hues.length, `no duplicate hue within block ${key}`);
  }
});

test('visibleInBlock: attention priority — own locals, then borrowed, then nested', () => {
  const byName = new Map([
    ['nested', info('block', { proximity: 2, freq: 9 })], // nested scope, high freq
    ['borrowed', info('fn', { proximity: 1, freq: 3 })],
    ['own1', info('block', { proximity: 0, freq: 2, block: 1 })],
    ['own2', info('block', { proximity: 0, freq: 5, block: 2 })],
  ]);
  const vis = sc.visibleInBlock(byName, 5);
  // own locals first (higher freq first within the tier), then borrowed, then nested
  assert.deepEqual(vis, ['own2', 'own1', 'borrowed', 'nested']);
});

test('visibleInBlock: budget caps at K, and once-used block-locals are excluded', () => {
  const byName = new Map([
    ['a', info('block', { freq: 5, block: 1 })],
    ['b', info('block', { freq: 4, block: 2 })],
    ['once', info('block', { freq: 1, block: 3 })], // once-used → never visible
    ['c', info('block', { freq: 3, block: 4 })],
  ]);
  const vis = sc.visibleInBlock(byName, 2);
  assert.equal(vis.length, 2, 'capped at K');
  assert.deepEqual(vis, ['a', 'b']);
  assert.ok(!sc.visibleInBlock(byName, 5).includes('once'), 'once-used block-local stays neutral');
});

test('visibleInBlock: self never consumes a hue slot', () => {
  const byName = new Map([
    ['this', info('self', { freq: 9 })],
    ['x', info('block', { freq: 2 })],
  ]);
  const vis = sc.visibleInBlock(byName, 5);
  assert.ok(!vis.includes('this'), 'self excluded — band 1 paints it');
  assert.ok(vis.includes('x'));
});

test('colorScope: over-constrained vertex goes neutral, never recycles a visible hue', () => {
  // 6 names all co-visible in one block, palette of 3 → 3 tint, 3 neutral.
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const blocks = [blk('one', names.map((n, i) => [n, info('block', { block: i })]))];
  const { hue, visible } = sc.colorScope(blocks, 3);
  const vis = visible.get('one');
  assert.equal(vis.length, 3, 'visibility budget already trims to K');
  const hues = vis.map((n) => hue.get(n));
  assert.equal(new Set(hues).size, 3, 'all distinct');
  for (const n of names.filter((x) => !vis.includes(x))) {
    assert.equal(hue.get(n), undefined, `${n} is neutral (outside the budget)`);
  }
});
