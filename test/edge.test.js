'use strict';
// Edge-case coverage found by auditing exports against test references:
//   - PhaseMachine had NO tests at all (the state machine driving Survey/Focus/
//     Edit, including the dwell timeouts)
//   - buildFileIndex (the new shared file-wide pass)
//   - planFromColoring (coloring → render plan)
//   - degenerate inputs: empty file, no blocks, unbalanced braces, no tokens

const { test } = require('node:test');
const assert = require('node:assert/strict');

const focus = require('../out/focus');
const classify = require('../out/classify');
const colors = require('../out/colors');
const traces = require('../out/traces');
const risk = require('../out/risk');
const sc = require('../out/scopecolor');
const phases = require('../out/phases');

// ── PhaseMachine ─────────────────────────────────────────────────────────────

test('PhaseMachine: starts in Survey', () => {
  const m = new phases.PhaseMachine(phases.DEFAULT_DWELL);
  assert.equal(m.current, phases.Phase.Survey);
});

test('PhaseMachine: caret in a block advances Survey → Focus; out of block → Survey', () => {
  const m = new phases.PhaseMachine(phases.DEFAULT_DWELL);
  assert.equal(m.onCaret(true, 1000), true, 'phase changed');
  assert.equal(m.current, phases.Phase.Focus);
  // caret to top level → immediate Survey (not a timed relaxation)
  assert.equal(m.onCaret(false, 1100), true);
  assert.equal(m.current, phases.Phase.Survey);
});

test('PhaseMachine: typing cuts to Edit from any phase', () => {
  const m = new phases.PhaseMachine(phases.DEFAULT_DWELL);
  m.onType(1000);
  assert.equal(m.current, phases.Phase.Edit);
});

test('PhaseMachine: Edit relaxes to Focus after editToFocus, held before it', () => {
  const d = { editToFocus: 2000, focusToSurvey: 24000, minHold: 350 };
  const m = new phases.PhaseMachine(d);
  m.onCaret(true, 0);
  m.onType(1000);
  assert.equal(m.current, phases.Phase.Edit);
  m.tick(1000 + 1999);
  assert.equal(m.current, phases.Phase.Edit, 'still Edit just before the dwell');
  m.tick(1000 + 2000);
  assert.equal(m.current, phases.Phase.Focus, 'relaxes at the dwell');
});

test('PhaseMachine: Focus relaxes to Survey after focusToSurvey (24s default)', () => {
  const m = new phases.PhaseMachine(phases.DEFAULT_DWELL);
  assert.equal(phases.DEFAULT_DWELL.focusToSurvey, 24000, 'doubled timeout is the default');
  m.onCaret(true, 0);
  assert.equal(m.current, phases.Phase.Focus);
  m.tick(23999);
  assert.equal(m.current, phases.Phase.Focus, 'still Focus just before 24s');
  m.tick(24000);
  assert.equal(m.current, phases.Phase.Survey);
});

test('PhaseMachine: caret activity refreshes the Focus clock (no premature drop)', () => {
  const m = new phases.PhaseMachine(phases.DEFAULT_DWELL);
  m.onCaret(true, 0);
  m.onCaret(true, 20000); // still reading, moving around
  m.tick(23000); // 23s absolute, but only 3s since activity
  assert.equal(m.current, phases.Phase.Focus, 'clock restarted on caret activity');
});

test('PhaseMachine: minHold blocks a downgrade immediately after an upgrade', () => {
  const d = { editToFocus: 0, focusToSurvey: 0, minHold: 350 };
  const m = new phases.PhaseMachine(d);
  m.onType(1000); // → Edit, stamps hold clock
  m.tick(1100); // 100ms later: inside minHold
  assert.equal(m.current, phases.Phase.Edit, 'held despite zero dwell');
  m.tick(1400); // past minHold
  assert.notEqual(m.current, phases.Phase.Edit);
});

test('PhaseMachine: nextRelaxDelay is null in Survey (resting floor)', () => {
  const m = new phases.PhaseMachine(phases.DEFAULT_DWELL);
  assert.equal(m.nextRelaxDelay(0), null);
  m.onCaret(true, 0);
  assert.ok(typeof m.nextRelaxDelay(0) === 'number');
});

test('PhaseMachine: caret within Edit stays Edit (superset, no downgrade)', () => {
  const m = new phases.PhaseMachine(phases.DEFAULT_DWELL);
  m.onType(1000);
  m.onCaret(true, 1100);
  assert.equal(m.current, phases.Phase.Edit, 'caret move inside an edit does not drop the phase');
});

// ── buildFileIndex ───────────────────────────────────────────────────────────

const tok = (name, offset, type, modifiers = []) => ({ name, offset, length: name.length, type, modifiers });

test('buildFileIndex: collects tintable occurrences, skips builtins and non-data types', () => {
  const text = 'const x = 1; console.log(x); function f() {}';
  const tokens = [
    tok('x', 6, 'variable', ['declaration']),
    tok('console', 13, 'variable', ['defaultLibrary']), // builtin → skipped
    tok('log', 21, 'member', ['defaultLibrary']), // member → skipped
    tok('x', 25, 'variable', []),
    tok('f', 38, 'function', ['declaration']), // function → skipped
  ];
  const idx = classify.buildFileIndex(text, tokens, []);
  assert.deepEqual([...idx.occurrences.keys()], ['x'], 'only the data variable');
  assert.equal(idx.occurrences.get('x').length, 2);
  assert.deepEqual(idx.declOffsets.get('x'), [6]);
  assert.equal(idx.firstFileOffset.get('x'), 6);
});

test('buildFileIndex: a name declared outside any function is a file global', () => {
  const text = 'var g = 1;\nfunction f() { use(g); }';
  const fnRanges = [{ start: 11, end: text.length }];
  const tokens = [tok('g', 4, 'variable', ['declaration']), tok('g', 29, 'variable', [])];
  const idx = classify.buildFileIndex(text, tokens, fnRanges);
  assert.ok(idx.fileGlobalsInOrder.includes('g'));
});

test('buildFileIndex: a name declared inside a function is NOT a file global', () => {
  const text = 'function f() { var loc = 1; use(loc); }';
  const fnRanges = [{ start: 0, end: text.length }];
  const tokens = [tok('loc', 19, 'variable', ['declaration']), tok('loc', 32, 'variable', [])];
  const idx = classify.buildFileIndex(text, tokens, fnRanges);
  assert.ok(!idx.fileGlobalsInOrder.includes('loc'));
});

test('buildFileIndex: injects self occurrences (keywords the token stream skips)', () => {
  const text = 'class A { m() { this.x = 1; return this.x; } }';
  const idx = classify.buildFileIndex(text, [], []);
  const occ = idx.occurrences.get('this');
  assert.ok(occ && occ.length === 2, 'both `this` occurrences lexed in');
});

test('buildFileIndex: equivalent to the inline path (refactor is behaviour-preserving)', () => {
  const text = 'function f(p) {\n  const a = p;\n  use(a); use(a);\n}';
  const fnRanges = [{ start: 0, end: text.length }];
  const tokens = [
    tok('f', 9, 'function', ['declaration']),
    tok('p', 11, 'parameter', ['declaration']),
    tok('a', 24, 'variable', ['declaration']),
    tok('p', 28, 'parameter', []),
    tok('a', 37, 'variable', []),
    tok('a', 45, 'variable', []),
  ];
  const blocks = focus.scanBraceBlocks(text);
  const b = blocks[0];
  const L = focus.lexRegionFor(text, b);
  const D = focus.declRegionFor(text, b);
  const withIdx = classify.classifyFromSemantic(
    text, L, fnRanges[0], fnRanges, tokens, 1, 'k', fnRanges[0], D, [],
    classify.buildFileIndex(text, tokens, fnRanges),
  );
  const without = classify.classifyFromSemantic(text, L, fnRanges[0], fnRanges, tokens, 1, 'k', fnRanges[0], D, []);
  assert.deepEqual([...withIdx.byName.keys()].sort(), [...without.byName.keys()].sort());
  for (const [n, i] of withIdx.byName) {
    assert.equal(i.cls, without.byName.get(n).cls, `${n} class matches`);
  }
});

test('buildFileIndex: class members are NOT data identities (getter/field vs shorthand)', () => {
  // TS reports `property [declaration]` for object-literal shorthand AND for
  // class/interface member declarations. Only the shorthand is a data READ; a
  // getter/field declaration is band-1 structure. The discriminator is the
  // object-literal bracketing: prev `{`/`,` and next `,`/`}`.
  const text = 'class W {\n  seen = 0;\n  get summary(): string { return "x" }\n}\n' +
               'const o = { name, id };';
  const at = (s) => text.indexOf(s);
  const tok = (name, offset, type, mods = []) => ({ name, offset, length: name.length, type, modifiers: mods });
  const tokens = [
    tok('seen', at('seen'), 'property', ['declaration']),           // class field decl
    tok('summary', at('summary'), 'property', ['declaration']),     // getter decl
    tok('name', at('name'), 'property', ['declaration']),           // shorthand read
    tok('id', at('id,') !== -1 ? at('id,') : at('id'), 'property', ['declaration']),
  ];
  const idx = classify.buildFileIndex(text, tokens, []);
  assert.ok(!idx.occurrences.has('seen'), 'class field decl is not a data identity');
  assert.ok(!idx.occurrences.has('summary'), 'getter decl is not a data identity');
  assert.ok(idx.occurrences.has('name'), 'object shorthand read IS a data identity');
});

test('buildFileIndex: function-typed values (`signature`) are band-1, not data', () => {
  // gopls marks a func-typed param/local with the `signature` modifier. Calls
  // through them are transformers, so they keep band-1's function colour rather
  // than competing for a data hue.
  const text = 'func process(h Handler) { out := h(ctx) }';
  const tok = (name, offset, type, mods = []) => ({ name, offset, length: name.length, type, modifiers: mods });
  const tokens = [
    tok('h', text.indexOf('h Handler'), 'parameter', ['definition', 'signature']),
    tok('h', text.indexOf('h(ctx)'), 'parameter', ['signature']),
    tok('out', text.indexOf('out'), 'variable', ['definition']),
  ];
  const idx = classify.buildFileIndex(text, tokens, []);
  assert.ok(!idx.occurrences.has('h'), 'func-typed param is not a data identity');
  assert.ok(idx.occurrences.has('out'), 'plain local still is');
});

test('buildFileIndex: setters and generator names are band-1 (member declarations)', () => {
  const text = 'class W {\n  set blah(val: string) { }\n  async *gen() { yield 1 }\n}';
  const tok = (name, offset, type, mods = []) => ({ name, offset, length: name.length, type, modifiers: mods });
  const tokens = [
    tok('blah', text.indexOf('blah'), 'property', ['declaration']),   // setter
    tok('val', text.indexOf('val'), 'parameter', ['declaration']),
    tok('gen', text.indexOf('gen'), 'member', ['declaration', 'async']),
  ];
  const idx = classify.buildFileIndex(text, tokens, []);
  assert.ok(!idx.occurrences.has('blah'), 'setter name is not data');
  assert.ok(!idx.occurrences.has('gen'), 'generator/method name is not data');
  assert.ok(idx.occurrences.has('val'), 'setter PARAMETER is data');
});

test('classify: `_` discard/blank identifier never competes for a hue', () => {
  // Go `for _, c := range` and Python `_` are discards, not data. They also
  // appear as a module facade in JS (lodash), so `_` is excluded outright.
  const text = 'func f() {\n\tfor _, c := range xs {\n\t\tuse(c)\n\t}\n}';
  const blocks = focus.scanBraceBlocks(text);
  const inner = blocks.reduce((a, b) => (b.depth > a.depth ? b : a));
  const L = focus.lexRegionFor(text, inner);
  const tok = (name, offset, type, mods = []) => ({ name, offset, length: name.length, type, modifiers: mods });
  const tokens = [
    tok('_', text.indexOf('_'), 'variable', ['definition']),
    tok('c', text.indexOf('c :='), 'variable', ['definition']),
    tok('c', text.indexOf('c)'), 'variable', []),
  ];
  const c = classify.classifyFromSemantic(text, L, undefined, [], tokens, 1, 'k', undefined, L, []);
  assert.ok(!c.byName.has('_'), 'discard excluded from data identities');
  assert.ok(c.byName.has('c'), 'the real loop var is included');
});

// ── planFromColoring ─────────────────────────────────────────────────────────

function nameInfo(cls, opts = {}) {
  return {
    cls,
    freqInBlock: opts.freq ?? 2,
    firstFileOffset: opts.file ?? 0,
    firstBlockOffset: opts.block ?? 0,
    isCapture: opts.isCapture ?? false,
    proximity: opts.proximity ?? (cls === 'block' ? 0 : 1),
  };
}

test('planFromColoring: only the block\'s visible names get entries', () => {
  const classification = {
    focusKey: 'B',
    byName: new Map([['a', nameInfo('block')], ['b', nameInfo('block')]]),
  };
  const coloring = { hue: new Map([['a', 0], ['b', 1]]), visible: new Map([['B', ['a']]]) };
  const plan = colors.planFromColoring(classification, coloring);
  assert.ok(plan.has('a'));
  assert.ok(!plan.has('b'), 'not visible in this block → absent from the plan');
});

test('planFromColoring: out-of-fn non-capture is bold (idg); captures and locals are id', () => {
  const classification = {
    focusKey: 'B',
    byName: new Map([
      ['glob', nameInfo('out', { isCapture: false })],
      ['cap', nameInfo('out', { isCapture: true })],
      ['loc', nameInfo('block')],
    ]),
  };
  const coloring = {
    hue: new Map([['glob', 0], ['cap', 1], ['loc', 2]]),
    visible: new Map([['B', ['glob', 'cap', 'loc']]]),
  };
  const plan = colors.planFromColoring(classification, coloring);
  assert.equal(plan.get('glob').kind, 'idg', 'true global → bold tier');
  assert.equal(plan.get('cap').kind, 'id', 'capture renders like a local');
  assert.equal(plan.get('loc').kind, 'id');
});

test('planFromColoring: visible-but-uncoloured → explicit neutral; self never painted', () => {
  const classification = {
    focusKey: 'B',
    byName: new Map([['x', nameInfo('block')], ['this', nameInfo('self')]]),
  };
  const coloring = { hue: new Map(), visible: new Map([['B', ['x', 'this']]]) };
  const plan = colors.planFromColoring(classification, coloring);
  assert.equal(plan.get('x').kind, 'neutral');
  assert.ok(!plan.has('this'), 'self is band-1 only');
});

// ── degenerate inputs ────────────────────────────────────────────────────────

test('degenerate: empty file yields no blocks and no crash anywhere', () => {
  assert.deepEqual(focus.scanBraceBlocks(''), []);
  assert.deepEqual(focus.lexIdentifiers(''), []);
  assert.equal(focus.innermostBlock([], 0), null);
  const idx = classify.buildFileIndex('', [], []);
  assert.equal(idx.occurrences.size, 0);
  assert.deepEqual(sc.colorScope([], 5), { hue: new Map(), visible: new Map() });
});

test('degenerate: file with no braces (braceless language) → empty block list', () => {
  const text = 'x = 1\ny = 2\nprint(x + y)\n';
  assert.deepEqual(focus.scanBraceBlocks(text), []);
  assert.equal(focus.innermostBlock([], 1), null, 'no block → Survey');
});

test('degenerate: unbalanced braces do not throw and drop the unmatched opener', () => {
  const open = 'f {\n  g {\n  }\n'; // outer never closes
  const blocks = focus.scanBraceBlocks(open);
  assert.equal(blocks.length, 1, 'only the closed inner block is reported');
  const close = '}\n} extra closers\n';
  assert.deepEqual(focus.scanBraceBlocks(close), [], 'stray closers ignored');
});

test('degenerate: no semantic tokens → classification yields no data identities', () => {
  const text = 'function f() {\n  const a = 1;\n  use(a);\n}';
  const b = focus.scanBraceBlocks(text)[0];
  const L = focus.lexRegionFor(text, b);
  const c = classify.classifyFromSemantic(text, L, undefined, [], [], 1, 'k', undefined, L, []);
  assert.equal(c.byName.size, 0, 'nothing tintable without tokens (heuristic path is separate)');
});

test('degenerate: block with zero eligible names → empty visible set, no crash', () => {
  const { hue, visible } = sc.colorScope([{ focusKey: 'empty', byName: new Map() }], 5);
  assert.deepEqual(visible.get('empty'), []);
  assert.equal(hue.size, 0);
});

test('degenerate: palette of 0 hues → everything neutral, no infinite loop', () => {
  const blocks = [{ focusKey: 'B', byName: new Map([['a', nameInfo('block')]]) }];
  const { hue, visible } = sc.colorScope(blocks, 0);
  assert.deepEqual(visible.get('B'), [], 'budget of 0 shows nothing');
  assert.equal(hue.size, 0);
});

test('degenerate: traces with no occurrences produce no ranges', () => {
  const classification = {
    byName: new Map([['x', nameInfo('block')]]),
    occurrences: new Map(),
    enclosingFn: undefined,
  };
  const plan = new Map([['x', { kind: 'id', poolIndex: 0 }]]);
  assert.deepEqual(traces.computeTraceRanges(classification, plan, { start: 0, end: 10 }), []);
});

test('degenerate: risk scanners on empty/odd input', () => {
  assert.deepEqual(risk.lexicalRisk('', { start: 0, end: 0 }), { async: [], danger: [], numberEngaged: [] });
  const esc = risk.escapeRisk('{ }', { start: 0, end: 3 }, { byName: new Map() });
  assert.deepEqual(esc, []);
});
