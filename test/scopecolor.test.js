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

test('visibleInBlock: own locals first, then borrowed; nested sub-scopes excluded', () => {
  const byName = new Map([
    ['nested', info('block', { proximity: 2, freq: 9 })], // nested scope, high freq
    ['borrowed', info('fn', { proximity: 1, freq: 3 })],
    ['own1', info('block', { proximity: 0, freq: 2, block: 1 })],
    ['own2', info('block', { proximity: 0, freq: 5, block: 2 })],
  ]);
  const vis = sc.visibleInBlock(byName, 5);
  // Own locals first (higher freq first within the tier), then borrowed. A name
  // owned by a NESTED sub-scope is not this block's data at all: ranking it last
  // was not enough, because spare budget still painted it — so focusing a function
  // body lit up closure internals that mean nothing at that level. It becomes
  // visible when the caret enters the sub-scope, where it is proximity 0.
  assert.deepEqual(vis, ['own2', 'own1', 'borrowed']);
  assert.ok(!vis.includes('nested'), 'excluded outright, even with the highest freq');
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

test('topLevelBlock: module top level is a focusable scope, not Survey', () => {
  const focus = require('../out/focus');
  const text = 'const A = 1;\nconst B = 2;\nfunction f() {\n  return A;\n}';
  const blocks = focus.scanBraceBlocks(text);
  // caret on line 0 (a top-level const) is outside every brace-block
  assert.equal(focus.innermostBlock(blocks, 0, 3), null, 'without text: null (old behaviour)');
  const tl = focus.innermostBlock(blocks, 0, 3, text);
  assert.ok(tl, 'with text: resolves to the synthetic top-level scope');
  assert.ok(focus.isTopLevelBlock(tl), 'flagged as top level');
  assert.equal(tl.depth, -1, 'depth -1 so it never beats a real block');
  // a caret inside the function still gets the real block, not top level
  const inFn = focus.innermostBlock(blocks, 3, text.indexOf('return A') + 2, text);
  assert.ok(!focus.isTopLevelBlock(inFn), 'real blocks still win');
});

test('visibleInBlock: top-level own declarations are exempt from the >=2-use floor', () => {
  // A module-level const is declared once at the top and used further down
  // INSIDE functions, so counting only its top-level uses would hide it.
  const byName = new Map([
    ['ONCE', info('block', { freq: 1, proximity: 0 })],
    ['nested', info('block', { freq: 5, proximity: 2 })],
  ]);
  assert.ok(!sc.visibleInBlock(byName, 5, false).includes('ONCE'), 'floor applies in a normal block');
  assert.ok(sc.visibleInBlock(byName, 5, true).includes('ONCE'), 'exempt at top level');
  // the exemption is scoped to proximity 0 — nested names keep the floor
  const nestedOnce = new Map([['x', info('block', { freq: 1, proximity: 2 })]]);
  assert.ok(!sc.visibleInBlock(nestedOnce, 5, true).includes('x'), 'nested once-used still held back');
});

test('colorScope: top-level flag flows through BlockNames', () => {
  const blocks = [{
    focusKey: '0#-1',
    isTopLevel: true,
    byName: new Map([['CONST_A', info('block', { freq: 1, proximity: 0 })]]),
  }];
  const { visible, hue } = sc.colorScope(blocks, 5);
  assert.deepEqual(visible.get('0#-1'), ['CONST_A']);
  assert.equal(hue.get('CONST_A'), 0, 'gets a hue despite a single top-level use');
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

// ── tie-breaks: each step of both orderings decides a visible outcome ────────

test('visibleInBlock: frequency, then block offset, then name decide the last slot', () => {
  const byFreq = new Map([6, 5, 4, 3, 2, 2].map((f, i) => [`n${i}`, info('block', { freq: f, block: i * 10 })]));
  assert.deepEqual(sc.visibleInBlock(byFreq, 5), ['n0', 'n1', 'n2', 'n3', 'n4'], 'the later of the two freq-2 names drops');
  const byOffset = new Map([['b', info('block', { block: 0 })], ['a', info('block', { block: 5 })]]);
  assert.deepEqual(sc.visibleInBlock(byOffset, 1), ['b'], 'the earlier block offset wins over name order');
  const byNameOnly = new Map([['b', info('block')], ['a', info('block')]]);
  assert.deepEqual(sc.visibleInBlock(byNameOnly, 1), ['a'], 'name order decides a full tie, not insertion order');
});

test('visibleInBlock: at top level only own declarations skip the use floor', () => {
  const byName = new Map([
    ['own', info('block', { freq: 1, proximity: 0 })],
    ['borrowed', info('block', { freq: 1, proximity: 1 })],
  ]);
  assert.deepEqual(sc.visibleInBlock(byName, 5, true), ['own']);
});

test('colorScope: degree, then file offset, then name order the greedy pass', () => {
  // y sits in two blocks (degree 2) and colours first even though x appears earlier.
  const chain = sc.colorScope([
    blk('b1', [['x', info('fn', { file: 0 })], ['y', info('fn', { file: 10 })]]),
    blk('b2', [['y', info('fn', { file: 10 })], ['z', info('fn', { file: 20 })]]),
  ], 5);
  assert.deepEqual(Object.fromEntries(chain.hue), { y: 0, x: 1, z: 1 });
  // Equal degree: the earlier file offset takes hue 0, whatever the names say.
  const byOffset = sc.colorScope([blk('b', [['b', info('fn', { file: 0 })], ['a', info('fn', { file: 10 })]])], 5);
  assert.deepEqual(Object.fromEntries(byOffset.hue), { b: 0, a: 1 });
  // Equal degree and offset: name order, not the order the vertices were first seen.
  const byName = sc.colorScope([
    blk('first', [['b', info('fn')]]),
    blk('both', [['a', info('fn')], ['b', info('fn')]]),
  ], 5);
  assert.deepEqual(Object.fromEntries(byName.hue), { a: 0, b: 1 });
});

test('colorScope: a name seen in several blocks orders by its earliest file offset', () => {
  const { hue } = sc.colorScope([
    blk('late', [['a', info('fn', { file: 50 })], ['b', info('fn', { file: 30 })]]),
    blk('early', [['a', info('fn', { file: 5 })]]),
  ], 5);
  // a has degree 1 like b; its minimum offset (5) puts it before b (30).
  assert.deepEqual(Object.fromEntries(hue), { a: 0, b: 1 });
});

test('colorScope: a vertex whose neighbours hold every hue goes neutral, never index K', () => {
  const { hue } = sc.colorScope([
    blk('ab', [['a', info('fn', { file: 0 })], ['b', info('fn', { file: 1 })]]),
    blk('bc', [['b', info('fn', { file: 1 })], ['c', info('fn', { file: 2 })]]),
    blk('ac', [['a', info('fn', { file: 0 })], ['c', info('fn', { file: 2 })]]),
  ], 2);
  assert.deepEqual(Object.fromEntries(hue), { a: 0, b: 1 });
});

test('colorScope: a full block gets every hue, and only its own names are vertices', () => {
  const { hue } = sc.colorScope([blk('one', [['a', info('fn', { file: 0 })], ['b', info('fn', { file: 1 })]])], 2);
  assert.deepEqual([...hue.keys()].sort(), ['a', 'b']);
  assert.deepEqual([...hue.values()].sort(), [0, 1]);
});
