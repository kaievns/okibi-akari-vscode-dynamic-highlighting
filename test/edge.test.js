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

test('PhaseMachine: reset() drops to Survey — opening a file must not enter Focus', () => {
  // Activation and tab switches are not intentional caret placements. Routing
  // them through onCaret() auto-advanced Survey → Focus, so a freshly opened file
  // rendered with band 2 already painted at the root scope.
  const m = new phases.PhaseMachine(phases.DEFAULT_DWELL);
  m.onCaret(true, 1000);
  assert.equal(m.current, phases.Phase.Focus);
  assert.equal(m.reset(2000), true, 'phase changed back down');
  assert.equal(m.current, phases.Phase.Survey);
  // reset bypasses minHold: it is a new viewing context, not a timed relaxation
  m.onType(3000);
  assert.equal(m.current, phases.Phase.Edit);
  m.reset(3050); // 50ms later, well inside minHold (350ms)
  assert.equal(m.current, phases.Phase.Survey, 'not blocked by the hold floor');
  // and a real caret placement still enters Focus afterwards
  m.onCaret(true, 4000);
  assert.equal(m.current, phases.Phase.Focus);
});

// ── The engagement gate ──────────────────────────────────────────────────────
//
// Opening a tab produces this sequence, captured from the extension's own debug
// channel after three failed fixes:
//
//   refresh     at=0:0                    ← editor activates with caret at 0:0
//   onSelection kind=undefined at=31:0    ← saved caret restored, ASYNCHRONOUSLY
//
// VS Code restores the caret as a PROGRAMMATIC selection change with no `kind`. The
// caret therefore genuinely moves (0:0 → 31:0) with no user action, which is why
// comparing positions could not detect it, and why a window reload behaved
// differently from a tab switch. `kind` is the discriminator: set for Keyboard(1),
// Mouse(2) and Command(3), absent only when VS Code cannot attribute the change.
//
// Models decorator.ts's wiring: engagement requires an attributed kind or an edit.
function engagementHarness() {
  const m = new phases.PhaseMachine(phases.DEFAULT_DWELL);
  const engaged = new Set();
  return {
    get phase() {
      return m.current;
    },
    /** onDidChangeTextEditorSelection */
    sel(doc, kind, now) {
      if (kind !== undefined) {
        engaged.add(doc);
      }
      if (engaged.has(doc)) {
        m.onCaret(true, now);
      }
    },
    /** onDidChangeActiveTextEditor → refresh() */
    refresh(now) {
      m.reset(now);
    },
    /** onDidChangeTextDocument → onEdit() */
    type(doc, now) {
      engaged.add(doc);
      m.onType(now);
    },
    isEngaged: (doc) => engaged.has(doc),
  };
}

test('engagement gate: the captured tab-open sequence stays in Survey', () => {
  // Verbatim from the debug trace that finally identified this.
  const h = engagementHarness();
  h.refresh(100); // refresh     at=0:0
  h.sel('sample.go', undefined, 101); // onSelection kind=undefined at=31:0
  assert.equal(h.isEngaged('sample.go'), false, 'a kindless restore is not engagement');
  assert.equal(h.phase, phases.Phase.Survey);
});

test('engagement gate: a kindless caret MOVE is still not engagement', () => {
  // This is the exact case the position-based attempt got wrong: the caret really
  // does move, so "moved" cannot mean "the user did it".
  const h = engagementHarness();
  h.refresh(100);
  h.sel('a.go', undefined, 101); // 0:0 → 31:0, programmatic
  h.sel('a.go', undefined, 102); // and again, e.g. a reveal/scroll-into-view
  assert.equal(h.phase, phases.Phase.Survey);
});

test('engagement gate: every attributed input kind engages', () => {
  for (const [kind, label] of [[1, 'Keyboard'], [2, 'Mouse'], [3, 'Command']]) {
    const h = engagementHarness();
    h.refresh(100);
    h.sel('a.go', undefined, 101); // restored caret — ignored
    assert.equal(h.phase, phases.Phase.Survey, `${label}: still Survey before input`);
    h.sel('a.go', kind, 200);
    assert.equal(h.phase, phases.Phase.Focus, `${label} enters Focus`);
  }
});

test('engagement gate: a same-position click still engages (kind is enough)', () => {
  // Regression guard for the "stuck until I arrow-key" bug: a click that does not
  // move the caret must still work, so engagement must not require movement.
  const h = engagementHarness();
  h.refresh(100);
  h.sel('a.go', undefined, 101);
  h.sel('a.go', 2, 200); // Mouse, caret unchanged
  assert.equal(h.phase, phases.Phase.Focus);
});

test('engagement gate: typing engages a never-clicked document', () => {
  const h = engagementHarness();
  h.refresh(100);
  h.sel('a.go', undefined, 101);
  h.type('a.go', 200);
  assert.equal(h.phase, phases.Phase.Edit);
});

test('engagement gate: switching to a fresh tab drops to Survey; back to an engaged one restores', () => {
  const h = engagementHarness();
  h.refresh(100);
  h.sel('a.ts', 1, 101); // real keystroke → engaged
  assert.equal(h.phase, phases.Phase.Focus);

  h.refresh(200); // switch to b.go
  h.sel('b.go', undefined, 201); // its restored caret
  assert.equal(h.phase, phases.Phase.Survey, 'never-touched file: Survey');

  h.refresh(300); // switch back to a.ts
  h.sel('a.ts', undefined, 301); // restored caret, but a.ts IS engaged
  assert.equal(h.phase, phases.Phase.Focus, 'a document you worked in stays engaged');
});

test('clay numbers ride FOCUS, not Edit — they share band 2\'s gate', () => {
  // The spec pairs --syn-number ("literal numbers REST receded") with
  // --syn-number-engaged ("clay — focused scope, engaged phases only"). BOTH are
  // band-1 `--syn-*` tokens, not `--risk-*`, and a scope becomes *engaged* at
  // Focus. Gating clay on Edit alone left numbers slate for the whole of Focus.
  const showClay = (engaged, phase, block) =>
    engaged && block !== null && (phase === phases.Phase.Focus || phase === phases.Phase.Edit);
  const showRisk = (engaged, phase, block) =>
    engaged && block !== null && phase === phases.Phase.Edit;
  const block = { openLine: 0, closeLine: 9, depth: 0 };

  // The bug: Focus used to paint risk=false AND clay=false.
  assert.equal(showClay(true, phases.Phase.Focus, block), true, 'clay arrives WITH Focus');
  assert.equal(showRisk(true, phases.Phase.Focus, block), false, 'risk marks do not');
  // Edit is a superset, so clay persists.
  assert.equal(showClay(true, phases.Phase.Edit, block), true, 'clay persists into Edit');
  assert.equal(showRisk(true, phases.Phase.Edit, block), true);
  // Survey rests receded, and an unengaged doc never paints.
  assert.equal(showClay(true, phases.Phase.Survey, block), false, 'Survey rests receded');
  assert.equal(showClay(false, phases.Phase.Focus, block), false, 'unengaged paints nothing');
  assert.equal(showClay(true, phases.Phase.Focus, null), false, 'no block, no clay');
});

test('engagement gate: an unengaged document paints NOTHING even if the phase is Focus', () => {
  // The final gate in render(). Three fixes tried to keep the PHASE correct on a
  // tab switch and a newly shown file still lit up, so the invariant is enforced
  // where decorations are actually applied: paint requires engagement. Any path
  // that leaves the phase wrong is then harmless.
  const showBands = (engaged, phase, block) => ({
    band2: engaged && block !== null && (phase === phases.Phase.Focus || phase === phases.Phase.Edit),
    band3: engaged && block !== null && phase === phases.Phase.Edit,
  });
  const block = { openLine: 0, closeLine: 9, depth: 0 };
  // The failing scenario: phase somehow reached Focus in a file never engaged.
  assert.deepEqual(showBands(false, phases.Phase.Focus, block), { band2: false, band3: false });
  assert.deepEqual(showBands(false, phases.Phase.Edit, block), { band2: false, band3: false });
  // Engaged behaves normally.
  assert.deepEqual(showBands(true, phases.Phase.Focus, block), { band2: true, band3: false });
  assert.deepEqual(showBands(true, phases.Phase.Edit, block), { band2: true, band3: true });
  assert.deepEqual(showBands(true, phases.Phase.Survey, block), { band2: false, band3: false });
  // No block (top-level Survey) paints nothing regardless.
  assert.deepEqual(showBands(true, phases.Phase.Focus, null), { band2: false, band3: false });
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

test('proximity: a focused function OWN param outranks nested-closure locals', () => {
  // Caret in summarize's body. `cfgs` is its parameter — the function's own data.
  // The closure params `i`/`j` belong to a child scope. Before the fix `cfgs` sat
  // at proximity 1 while `i`/`j` got 0 (declRegionFor keeps function headers
  // body-only, so they fell outside every sub-scope), and the budget painted the
  // closure internals while the real argument stayed neutral.
  const text = [
    'func summarize(cfgs []Config) string {',
    '\tnames := make([]string, 0, len(cfgs))',
    '\tuse(cfgs)',
    '\tsort.Slice(names, func(i, j int) bool {',
    '\t\treturn names[i] < names[j]',
    '\t})',
    '\treturn names',
    '}',
  ].join('\n');
  const at = (s) => text.indexOf(s);
  const tok = (name, offset, type, mods = []) => ({ name, offset, length: name.length, type, modifiers: mods });
  const tokens = [
    tok('cfgs', at('cfgs []Config'), 'parameter', ['definition']),
    tok('cfgs', at('len(cfgs)') + 4, 'parameter', []),
    tok('cfgs', at('use(cfgs)') + 4, 'parameter', []),
    tok('names', at('names :='), 'variable', ['definition']),
    tok('names', at('names, func'), 'variable', []),
    tok('names', at('names[i]'), 'variable', []),
    tok('names', at('names[j]'), 'variable', []),
    tok('names', at('return names\n'), 'variable', []),
    tok('i', at('i, j int'), 'parameter', ['definition']),
    tok('j', at('j int'), 'parameter', ['definition']),
    tok('i', at('names[i]') + 6, 'parameter', []),
    tok('j', at('names[j]') + 6, 'parameter', []),
  ];
  const blocks = focus.scanBraceBlocks(text);
  const outer = blocks.reduce((a, b) => (b.depth < a.depth ? b : a));
  const fnRanges = blocks
    .filter((b) => /\bfunc\b/.test(text.slice(b.headerStart, b.openOffset)))
    .map((b) => ({ start: b.headerStart, end: b.closeOffset + 1 }));
  const L = focus.lexRegionFor(text, outer);
  const D = focus.declRegionFor(text, outer);
  const subs = blocks
    .filter((b) => b.openOffset > outer.openOffset && b.closeOffset < outer.closeOffset)
    .map((b) => focus.scopeRegionFor(text, b));
  const enc = classify.enclosingFnOf(fnRanges, outer.openOffset);
  const c = classify.classifyFromSemantic(
    text, L, enc, fnRanges, tokens, 1, focus.focusKeyOf(outer), enc, D, subs,
    classify.buildFileIndex(text, tokens, fnRanges), [],
  );
  assert.equal(c.byName.get('cfgs').proximity, 0, "the function's own param is its own data");
  assert.equal(c.byName.get('i').proximity, 2, 'closure param belongs to a nested scope');
  assert.equal(c.byName.get('j').proximity, 2);
  const vis = sc.visibleInBlock(c.byName, 5, false);
  assert.ok(vis.includes('cfgs'), 'cfgs wins a hue');
  assert.ok(!vis.includes('i') && !vis.includes('j'), 'nested closure params stay neutral');
});

test('scopeRegionFor: function + control-flow headers included, literal headers not', () => {
  // A composite literal is also a brace-block, but its header declares a name
  // owned by the ENCLOSING scope — widening there would demote it.
  const text = 'func f() {\n\tcfg := Config{\n\t\tA: 1,\n\t}\n\tfor i := range xs {\n\t\tg(func(q int) { use(q) })\n\t}\n}';
  const blocks = focus.scanBraceBlocks(text);
  const pick = (frag) => blocks.find((b) => text.slice(b.headerStart, b.openOffset).includes(frag));
  const lit = pick('cfg :=');
  const loop = pick('for i');
  const clo = pick('func(q');
  assert.equal(focus.scopeRegionFor(text, lit).start, lit.openOffset, 'literal header excluded');
  // The loop's region starts at the `for` KEYWORD, not the line's leading
  // whitespace — so a `let x = match … {` binding before the keyword stays with the
  // enclosing scope (see scopeRegionFor / controlKeywordStart). What matters is that
  // the loop's own binding `i` is inside the region; the leading tab is not.
  const loopR = focus.scopeRegionFor(text, loop);
  assert.equal(loopR.start, text.indexOf('for i'), 'region starts at the control keyword');
  assert.ok(loopR.start <= text.indexOf('i :=') && text.indexOf('i :=') < loopR.end, 'loop binding included');
  // A function's region starts at its PARAMETER LIST, not headerStart — the text
  // before it (`g(`, or an outer `const jobs =`) belongs to the enclosing scope.
  const cloR = focus.scopeRegionFor(text, clo);
  assert.equal(cloR.start, text.indexOf('(q int)'), 'closure region starts at the param list');
  assert.ok(cloR.start < clo.openOffset, 'params are inside the region');
  assert.ok(text.indexOf('g(func') < cloR.start, 'the enclosing call is outside it');
});

// ── concise (braceless) arrow bodies ─────────────────────────────────────────

test('scanBraceBlocks: a concise arrow body is a scope, spanning params to end of expression', () => {
  // `.reduce((acc, line, idx) => `...`, "")` — no braces, so the brace scanner found
  // nothing and the caret resolved to the ENCLOSING function, which then treated
  // acc/line/idx as its OWN block-locals competing for its hues.
  const text = 'function summarize(cfgs) {\n  const total = cfgs\n' +
               '    .reduce((acc, line, idx) => `${acc}${idx}:${line}; `, "");\n  return total;\n}';
  const blocks = focus.scanBraceBlocks(text);
  const arrow = blocks.find((b) => text.slice(b.openOffset, b.openOffset + 1) === '(');
  assert.ok(arrow, 'the braceless arrow is a block');
  // The body must span the WHOLE template — a `,` or `}` inside `${…}` must not end
  // it early, which is the subtle part.
  assert.equal(
    text.slice(arrow.openOffset, arrow.closeOffset + 1),
    '(acc, line, idx) => `${acc}${idx}:${line}; `',
  );
  // ...and it stops before the next argument.
  assert.ok(text.slice(arrow.closeOffset + 1).startsWith(', ""'), 'ends at the argument comma');
});

test('innermostBlock: the caret inside a concise arrow resolves to the arrow, not its parent', () => {
  const text = 'function f(xs) {\n  const t = xs.reduce((acc, x) => acc + x, 0);\n  return t;\n}';
  const blocks = focus.scanBraceBlocks(text);
  const arrow = blocks.find((b) => text.slice(b.openOffset, b.openOffset + 1) === '(');
  const inside = focus.innermostBlock(blocks, 1, text.indexOf('acc + x') + 2, text);
  assert.equal(inside.openOffset, arrow.openOffset, 'inside the body → the arrow scope');
  // outside it (on the same line) falls back to the function
  const outside = focus.innermostBlock(blocks, 1, text.indexOf('const t') + 2, text);
  assert.notEqual(outside.openOffset, arrow.openOffset, 'before the arrow → the function');
});

test('scanBraceBlocks: concise-arrow detection ignores strings, comments and braced arrows', () => {
  // An `=>` that is not code must not invent a scope, and a braced arrow already
  // belongs to the brace scanner (double-counting it would duplicate the block).
  const bodyOf = (src) =>
    focus.scanBraceBlocks(src).map((b) => src.slice(b.openOffset, b.closeOffset + 1));
  assert.deepEqual(bodyOf('// (a) => a'), [], 'arrow in a line comment');
  assert.deepEqual(bodyOf('const s = "(a) => a";'), [], 'arrow in a string');
  assert.deepEqual(bodyOf('/* (a) => a */'), [], 'arrow in a block comment');
  assert.deepEqual(bodyOf('const f = (a) => { return a; };'), ['{ return a; }'], 'braced: one block');
  // Go function TYPES have no arrow and must stay unaffected.
  assert.deepEqual(bodyOf('type H func(c *C) ([]byte, error)'), []);
});

test('scanBraceBlocks: concise-arrow body ends at the right delimiter', () => {
  const body = (src) => {
    const b = focus.scanBraceBlocks(src).find((x) => src[x.openOffset] === '(' || /[A-Za-z]/.test(src[x.openOffset]));
    return b ? src.slice(b.openOffset, b.closeOffset + 1) : null;
  };
  assert.equal(body('const f = (a) => a ? 1 : 2;'), '(a) => a ? 1 : 2', 'ternary body, stops at ;');
  assert.equal(body('run((a) => a + 1, 2);'), '(a) => a + 1', 'stops at the argument comma');
  assert.equal(body('const f = (a) => [a, 1];'), '(a) => [a, 1]', 'commas inside brackets do not end it');
  assert.equal(body('const f = (a) => "x, y";'), '(a) => "x, y"', 'commas inside strings do not end it');
  assert.equal(body('const f = a => a * 2;'), 'a => a * 2', 'bare single-identifier param');
});

test('scanBraceBlocks: curried arrows nest by depth so the caret can tell them apart', () => {
  // `a => b => a + b` — two scopes with no braces between them. An arrow-blind depth
  // left them tied, and innermostBlock could not resolve which one held the caret.
  const text = 'function g() { return xs.map(a => b => a + b); }';
  const blocks = focus.scanBraceBlocks(text);
  const outer = blocks.find((b) => text.slice(b.openOffset).startsWith('a =>'));
  const inner = blocks.find((b) => text.slice(b.openOffset).startsWith('b =>'));
  assert.ok(outer && inner);
  assert.ok(inner.depth > outer.depth, 'the inner arrow is deeper');
  const at = focus.innermostBlock(blocks, 0, text.indexOf('a + b') + 2, text);
  assert.equal(at.openOffset, inner.openOffset, 'caret in the shared body → innermost arrow');
});

test('scanBraceBlocks: blocks stay sorted by open offset after arrows are appended', () => {
  // Arrow blocks are found in a second pass; downstream code (sub-block collection)
  // relies on document order.
  const text = 'function f(){\n  const a = xs.map(x => x + 1);\n  if (a) { g(); }\n  const b = ys.filter(y => y);\n}';
  const blocks = focus.scanBraceBlocks(text);
  for (let i = 1; i < blocks.length; i++) {
    assert.ok(blocks[i].openOffset >= blocks[i - 1].openOffset, `sorted at ${i}`);
  }
});

test('scopeRegionFor: an inline callback does not claim the declaration it is assigned to', () => {
  // `const jobs = names.map(async (name) => {` — the header carries BOTH the
  // callback's param and an OUTER declaration. Taking the whole header put `jobs`
  // in the callback's sub-scope, so from the enclosing function body it scored
  // proximity 2 and was excluded, while from inside the callback it painted despite
  // never being used there.
  const text = 'async function fetchAll(names) {\n  const jobs = names.map(async (name) => {\n    return name;\n  });\n  return jobs;\n}';
  const blocks = focus.scanBraceBlocks(text);
  const cb = blocks.find((b) => text.slice(b.headerStart, b.openOffset).includes('=>'));
  const region = focus.scopeRegionFor(text, cb);
  const jobsAt = text.indexOf('jobs');
  const nameAt = text.indexOf('(name)');
  assert.ok(jobsAt < region.start, '`jobs` belongs to the ENCLOSING scope');
  assert.ok(nameAt >= region.start && nameAt < region.end, '`name` belongs to the callback');
  // lexRegionFor must agree, or `jobs` reads as used inside the callback
  const lex = focus.lexRegionFor(text, cb);
  assert.ok(jobsAt < lex.start, '`jobs` is not lexed as a use inside the callback');
  assert.ok(nameAt >= lex.start, 'the param still is');
});

test('paramListStart: bare single-identifier arrows and nested parens in defaults', () => {
  // No paren group at all: `name => {`. The param must still be inside the region.
  const bare = 'const f = name => {\n  return name;\n}';
  const bb = focus.scanBraceBlocks(bare)[0];
  const br = focus.scopeRegionFor(bare, bb);
  assert.ok(br.start <= bare.indexOf('name =>'), 'bare arrow param included');
  assert.ok(bare.indexOf('const f') < br.start, 'the outer declaration is not');

  // Nested parens in a default value must not confuse the backward scan.
  const dflt = 'const g = (a = h(1), b) => {\n  return a + b;\n}';
  const db = focus.scanBraceBlocks(dflt)[0];
  const dr = focus.scopeRegionFor(dflt, db);
  assert.equal(dr.start, dflt.indexOf('(a = h(1), b)'), 'matches the OUTER paren group');
  assert.ok(dflt.indexOf('const g') < dr.start, 'outer declaration excluded');
});

test('buildFileIndex: type-signature params are documentation, not data identities', () => {
  // `type Reducer<T> = (acc: T, item: Job) => T` — TS reports `acc` as
  // `parameter [declaration]`, identical to a real one. A type alias is not a
  // function range, so it classified as a top-level GLOBAL and traced file-wide,
  // giving every unrelated `acc` a global's hue. Go's
  // `type Handler func(ctx *Context, in []byte)` is the same bug.
  const text = 'type Reducer = (acc: number, item: Job) => number;\n' +
               'function fold(seed) {\n  let acc = seed;\n  return acc;\n}\n';
  const tok = (name, offset, type, mods = []) => ({ name, offset, length: name.length, type, modifiers: mods });
  const tokens = [
    tok('acc', text.indexOf('acc:'), 'parameter', ['declaration']),      // in the type alias
    tok('item', text.indexOf('item:'), 'parameter', ['declaration']),    // in the type alias
    tok('acc', text.indexOf('acc = seed'), 'variable', ['declaration']), // the real one
    tok('acc', text.lastIndexOf('acc'), 'variable', []),
  ];
  const idx = classify.buildFileIndex(text, tokens, []);
  assert.equal(idx.occurrences.get('acc').length, 2, 'only the two real `acc` occurrences');
  assert.ok(!idx.occurrences.has('item'), 'a type-only param is not a data identity at all');
  assert.ok(
    idx.occurrences.get('acc').every((r) => r.start > text.indexOf(';')),
    'no occurrence inside the type declaration',
  );
});

test('buildFileIndex: a braced type/interface body is excluded whole', () => {
  // Go `type Config struct { … }` and TS `interface Job { … }` span multiple
  // lines, so the exclusion must run to the matching brace, not end-of-line.
  const text = 'interface Job {\n  retries: number;\n  payload: string;\n}\nconst retries = 3;\nuse(retries);';
  const tok = (name, offset, type, mods = []) => ({ name, offset, length: name.length, type, modifiers: mods });
  const tokens = [
    tok('retries', text.indexOf('retries:'), 'property', ['declaration']),
    tok('retries', text.indexOf('retries = 3'), 'variable', ['declaration']),
    tok('retries', text.lastIndexOf('retries'), 'variable', []),
  ];
  const idx = classify.buildFileIndex(text, tokens, []);
  const occ = idx.occurrences.get('retries') ?? [];
  assert.equal(occ.length, 2, 'the interface member is excluded, the real const is not');
  assert.ok(occ.every((r) => r.start > text.indexOf('}')), 'nothing from inside the interface body');
});

test('buildFileIndex: shadowScopes record the fn ranges that redeclare a name', () => {
  // The shadowing case: a module-level `cfgs` and a `summarize(cfgs)` parameter.
  const text = 'function summarize(cfgs) {\n  return cfgs.length;\n}\nconst cfgs = [1, 2];\nuse(cfgs);';
  const summarize = { start: 0, end: text.indexOf('}\nconst') + 1 };
  const tok = (name, offset, type, mods = []) => ({ name, offset, length: name.length, type, modifiers: mods });
  const tokens = [
    tok('cfgs', text.indexOf('cfgs)'), 'parameter', ['declaration']),
    tok('cfgs', text.indexOf('cfgs.length'), 'parameter', []),
    tok('cfgs', text.indexOf('cfgs = '), 'variable', ['declaration']),
    tok('cfgs', text.lastIndexOf('cfgs'), 'variable', []),
  ];
  const idx = classify.buildFileIndex(text, tokens, [summarize]);
  const scopes = idx.shadowScopes.get('cfgs');
  assert.ok(scopes, 'the name has a declaring function scope');
  assert.deepEqual(scopes, [summarize], 'only summarize declares it inside a fn');
  // The module-level declaration contributes no scope, so it stays traceable
  // file-wide minus summarize.
  assert.equal(scopes.length, 1);
});

test('top-level scope: excludeRanges keep function locals out, keep the decl name in', () => {
  // The top-level scope spans the whole file, so without carving out the nested
  // blocks every function local counts as "used at top level" and leaks into the
  // view. But the carve-out must NOT swallow a `const X = { … }` declaration:
  // the object literal is itself a depth-0 block whose header holds `X`.
  const text = 'const CONF = {\n  a: 1,\n};\nlet count = 0;\nfunction f(param) {\n  const local = param;\n  return local;\n}\n';
  const blocks = focus.scanBraceBlocks(text);
  const tl = focus.topLevelBlock(text);
  const L = focus.lexRegionFor(text, tl);
  const isFnHdr = (h) => /\b(func|function)\b|=>\s*$|\)\s*(:[^)]*)?\s*$/.test(h);
  const excl = [
    ...blocks.filter((b) => b.depth === 0).map((b) => ({ start: b.openOffset, end: b.closeOffset + 1 })),
    ...blocks
      .filter((b) => b.depth === 0 && isFnHdr(text.slice(b.headerStart, b.openOffset)))
      .map((b) => ({ start: b.headerStart, end: b.openOffset })),
  ];
  const tok = (name, offset, type, mods = []) => ({ name, offset, length: name.length, type, modifiers: mods });
  const tokens = [
    tok('CONF', text.indexOf('CONF'), 'variable', ['declaration']),
    tok('count', text.indexOf('count'), 'variable', ['declaration']),
    tok('param', text.indexOf('param'), 'parameter', ['declaration']),
    tok('local', text.indexOf('local'), 'variable', ['declaration']),
    tok('local', text.lastIndexOf('local'), 'variable', []),
  ];
  const subs = blocks.map((b) => focus.declRegionFor(text, b));
  const c = classify.classifyFromSemantic(
    text, L, undefined, [], tokens, 1, focus.focusKeyOf(tl), undefined, L, subs, undefined, excl,
  );
  assert.ok(c.byName.has('CONF'), 'the object-literal declaration name IS top-level');
  assert.ok(c.byName.has('count'), 'a plain top-level let IS top-level');
  assert.ok(!c.byName.has('local'), 'a function local does NOT leak into top level');
  assert.ok(!c.byName.has('param'), 'a function parameter does NOT leak into top level');
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

test('planFromColoring: visible-but-uncoloured → explicit neutral; self gets a self entry', () => {
  const classification = {
    focusKey: 'B',
    byName: new Map([['x', nameInfo('block')], ['this', nameInfo('self')]]),
  };
  const coloring = { hue: new Map(), visible: new Map([['B', ['x', 'this']]]) };
  const plan = colors.planFromColoring(classification, coloring);
  assert.equal(plan.get('x').kind, 'neutral');
  // `self`/`this` IS emitted, as `kind: 'self'`. It used to be omitted on the grounds
  // that band 1 owns it — true until a semantic token overrides band 1. Outside a
  // cargo workspace rust-analyzer degrades a `self` USE to type `const`, which has no
  // theme mapping and no fallback scope, so it rendered plain white. The decoration
  // is band 1's own colour at normal weight, so it changes nothing where the grammar
  // already won and restores it where it did not. See planFromColoring.
  assert.equal(plan.get('this').kind, 'self', 'self is emitted so the decorator can restore band 1');
});

test('planFromColoring: self is emitted even when it is NOT in the visible set', () => {
  // `self` never enters `visible` — it is excluded upstream so it cannot consume a hue
  // slot. So reading it from the visible list (as the loop below does for real
  // identities) would never find it; it has to come from byName directly.
  const classification = {
    focusKey: 'B',
    byName: new Map([['self', nameInfo('self')], ['x', nameInfo('block')]]),
  };
  const coloring = { hue: new Map([['x', 0]]), visible: new Map([['B', ['x']]]) };
  const plan = colors.planFromColoring(classification, coloring);
  assert.equal(plan.get('self').kind, 'self', 'self is emitted from byName, not from visible');
  assert.equal(plan.get('x').kind, 'id');
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
