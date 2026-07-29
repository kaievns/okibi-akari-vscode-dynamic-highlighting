'use strict';
// Unit tests for the pure (vscode-free) modules, run against compiled out/.
//   node --test   (after `npm run compile`)
//
// Coverage is weighted toward the logic the adversarial review flagged:
// colour-assignment ordering/overflow/stability, classification, escape
// detection, numeric lexing, and trace clipping.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const focus = require('../out/focus');
const classify = require('../out/classify');
const colors = require('../out/colors');
const traces = require('../out/traces');
const risk = require('../out/risk');

// ── focus.ts ────────────────────────────────────────────────────────────────

test('scanBraceBlocks: nested blocks with correct depth + offsets', () => {
  const text = 'a {\n  b {\n  }\n}';
  const blocks = focus.scanBraceBlocks(text);
  assert.equal(blocks.length, 2);
  const inner = blocks.find((b) => b.depth === 1);
  const outer = blocks.find((b) => b.depth === 0);
  assert.ok(inner && outer);
  assert.equal(text[inner.openOffset], '{');
  assert.equal(text[inner.closeOffset], '}');
  assert.equal(text[outer.openOffset], '{');
  assert.equal(text[outer.closeOffset], '}');
});

test('scanBraceBlocks: braces in strings/comments do not open blocks', () => {
  const text = 'x = "}{ not real {"; // } { comment\ny {\n}';
  const blocks = focus.scanBraceBlocks(text);
  assert.equal(blocks.length, 1); // only the real y { } block
});

test('innermostBlock: deepest block containing the caret wins', () => {
  const text = 'f {\n  g {\n    h\n  }\n}';
  const blocks = focus.scanBraceBlocks(text);
  const inner = focus.innermostBlock(blocks, 2); // line with `h`
  assert.equal(inner.depth, 1);
  const outerOnly = focus.innermostBlock(blocks, 0); // header line of f
  assert.equal(outerOnly.depth, 0);
  const none = focus.innermostBlock(blocks, 99);
  assert.equal(none, null);
});

test('innermostBlock: single-line block only focuses when caret offset is between its braces', () => {
  // `Tags:    map[...]string{"env": "dev"},`  — the {…} opens+closes on this line.
  // Caret on `Tags:` (before the `{`) must NOT focus the inline map; caret inside must.
  const line = '  outer {\n    Tags:    m{"env": "dev"},\n  }';
  const blocks = focus.scanBraceBlocks(line);
  const inline = blocks.find((b) => b.openLine === b.closeLine); // the m{...} block
  const outer = blocks.find((b) => b.openLine !== b.closeLine);
  assert.ok(inline && outer, 'both blocks scanned');

  const braceOpen = line.indexOf('{', line.indexOf('Tags')); // the m{ brace
  const caretOnTags = line.indexOf('Tags'); // offset well before the brace
  const caretInside = braceOpen + 3; // between the braces

  // On `Tags:` (same line, before brace) → falls through to the OUTER block, not the inline map.
  const atTags = focus.innermostBlock(blocks, inline.openLine, caretOnTags);
  assert.equal(atTags.depth, outer.depth, 'caret before the brace does not focus the inline map');
  // Inside the braces → the inline map.
  const inMap = focus.innermostBlock(blocks, inline.openLine, caretInside);
  assert.equal(inMap.depth, inline.depth, 'caret between braces focuses the inline map');

  // Backward-compat: without an offset, single-line block still matches by line.
  const noOffset = focus.innermostBlock(blocks, inline.openLine);
  assert.equal(noOffset.depth, inline.depth);
});

test('lexIdentifiers: skips strings/comments, keeps $ and _ names, correct offsets', () => {
  const text = 'const _a$ = "str x"; // comment y\nfoo(_a$)';
  const ids = focus.lexIdentifiers(text);
  const names = ids.map((i) => i.name);
  assert.ok(names.includes('_a$'));
  assert.ok(names.includes('foo'));
  assert.ok(!names.includes('str'), 'string content must not lex');
  assert.ok(!names.includes('comment'), 'comment content must not lex');
  // const keyword IS lexed (caller filters keywords)
  assert.ok(names.includes('const'));
  // offset of the first _a$ points at the real character
  const first = ids.find((i) => i.name === '_a$');
  assert.equal(text.slice(first.offset, first.offset + first.length), '_a$');
});

test('lexRegionFor: includes a function PARAMETER LIST, so closure params are visible in their own scope', () => {
  // The bug: `go func(cfg Config) {` — `cfg` lives on the header line, before
  // the `{`. With a body-only lex region it was invisible inside its own
  // closure, and only tinted from the PARENT block (whose range covers the
  // header line).
  const fn = 'x\ngo func(cfg Config) {\n  use(cfg)\n}';
  const fnBlock = focus.scanBraceBlocks(fn)[0];
  const lexR = focus.lexRegionFor(fn, fnBlock);
  assert.ok(lexR.start < fnBlock.openOffset, 'reaches back before the brace');
  // What matters is that the param name falls inside it — not the exact offset.
  const cfgAt = fn.indexOf('cfg');
  assert.ok(cfgAt >= lexR.start && cfgAt < lexR.end, 'param offset inside lex region');
  // ...but NOT the whole header line: an inline callback's header carries a
  // declaration owned by the ENCLOSING scope, and lexing it counted that name as
  // used inside the callback. See the `const jobs = names.map(...)` test below.
  const declAt = fn.indexOf('go');
  assert.ok(declAt < lexR.start, 'text before the parameter list is excluded');
  // but classification still treats it as fn-local (body-only decl region)
  const declR = focus.declRegionFor(fn, fnBlock);
  assert.equal(declR.start, fnBlock.openOffset, 'decl region stays body-only for functions');

  // control flow: both regions include the header
  const cf = 'x\nfor (let i = 0; i < n; i++) {\n  use(i)\n}';
  const cfBlock = focus.scanBraceBlocks(cf)[0];
  assert.equal(focus.lexRegionFor(cf, cfBlock).start, cfBlock.headerStart);
  assert.equal(focus.declRegionFor(cf, cfBlock).start, cfBlock.headerStart);
});

test('declRegionFor: control-flow headers widen to header; function headers do not', () => {
  // control-flow: `for (let i=0; ...) { body }` → region starts at header
  const cf = 'x\nfor (let i = 0; i < n; i++) {\n  use(i)\n}';
  const cfBlocks = focus.scanBraceBlocks(cf);
  const cfBlock = cfBlocks[0];
  const cfRegion = focus.declRegionFor(cf, cfBlock);
  assert.equal(cfRegion.start, cfBlock.headerStart, 'control-flow region includes the header');
  assert.ok(cfRegion.start < cfBlock.openOffset, 'header start precedes the brace');

  // function: `function f(p) { body }` → region is body only (params are fn-local)
  const fn = 'x\nfunction f(param) {\n  use(param)\n}';
  const fnBlocks = focus.scanBraceBlocks(fn);
  const fnBlock = fnBlocks[0];
  const fnRegion = focus.declRegionFor(fn, fnBlock);
  assert.equal(fnRegion.start, fnBlock.openOffset, 'function region is body-only (excludes params)');

  // arrow: `const g = (a) => { ... }` → body only
  const arrow = 'const g = (a) => {\n  return a\n}';
  const aBlock = focus.scanBraceBlocks(arrow)[0];
  const aRegion = focus.declRegionFor(arrow, aBlock);
  assert.equal(aRegion.start, aBlock.openOffset, 'arrow region is body-only');
});

test('lexIdentifiers: descends into template ${...} interpolations, template text stays opaque', () => {
  const text = 'const s = `attempt ${i} for ${cfg.name}`; plain';
  const names = focus.lexIdentifiers(text).map((x) => x.name);
  // interpolation identifiers ARE lexed
  assert.ok(names.includes('i'), 'i inside ${...}');
  assert.ok(names.includes('cfg'), 'cfg inside ${...}');
  assert.ok(names.includes('name'), 'property in ${...}');
  // template literal TEXT is not lexed
  assert.ok(!names.includes('attempt'), 'template text stays opaque');
  assert.ok(!names.includes('for'), 'template text stays opaque');
  // code after the template resumes
  assert.ok(names.includes('plain'));
});

test('lexIdentifiers: nested template ${ `${x}` } handled', () => {
  const text = '`a ${ obj.f(`b ${x} c`) } d`';
  const names = focus.lexIdentifiers(text).map((n) => n.name);
  assert.ok(names.includes('obj'));
  assert.ok(names.includes('f'));
  assert.ok(names.includes('x'));
  assert.ok(!names.includes('a') && !names.includes('b') && !names.includes('c') && !names.includes('d'));
});

test('focusKeyOf: distinct blocks distinct keys, same block stable', () => {
  const text = 'a {\n}\nb {\n}';
  const blocks = focus.scanBraceBlocks(text);
  const keys = new Set(blocks.map(focus.focusKeyOf));
  assert.equal(keys.size, blocks.length);
});

// ── classify.ts ───────────────────────────────────────────────────────────────

test('decodeSemanticTokens: delta stream decodes to absolute offsets + names', () => {
  const text = 'let foo = bar';
  const lineStarts = classify.lineStartOffsets(text);
  // one token: line 0, char 4, len 3 ("foo"), type 0, no mods
  const data = [0, 4, 3, 0, 0];
  const toks = classify.decodeSemanticTokens(data, ['variable'], [], lineStarts, text);
  assert.equal(toks.length, 1);
  assert.equal(toks[0].name, 'foo');
  assert.equal(toks[0].type, 'variable');
  assert.equal(toks[0].offset, 4);
});

test('decodeSemanticTokens: modifier bitset resolves to names', () => {
  const text = 'const x = 1';
  const lineStarts = classify.lineStartOffsets(text);
  const data = [0, 6, 1, 0, 0b101]; // mods bits 0 and 2
  const toks = classify.decodeSemanticTokens(data, ['variable'], ['declaration', 'readonly', 'static'], lineStarts, text);
  assert.deepEqual(toks[0].modifiers.sort(), ['declaration', 'static'].sort());
});

test('classifyFromHeuristic: block/fn/out classification by decl distance', () => {
  //   const g = 1                 → global (out)
  //   function f(p) {             → f is a fn; p is a param... (heuristic detects `const/let` etc.)
  //     const local = 2           → fn-local (declared in fn, outside inner block)
  //     if (x) {                  → inner block
  //       const b = 3             → block-local
  //       use(b); use(b)          → b used ≥2 in block
  //       use(local); use(g)      → borrowed-in fn-local + global
  //     }
  //   }
  const text =
    'const g = 1\n' +
    'function f(p) {\n' +
    '  const local = 2\n' +
    '  if (p) {\n' +
    '    const b = 3\n' +
    '    use(b)\n' +
    '    use(b)\n' +
    '    use(local)\n' +
    '    use(g)\n' +
    '  }\n' +
    '}\n';
  const blocks = focus.scanBraceBlocks(text);
  // innermost block = the if-body
  const inner = blocks.reduce((a, b) => (b.depth > a.depth ? b : a));
  const blockRange = { start: inner.openOffset, end: inner.closeOffset + 1 };
  const fnBlock = blocks.find((b) => b.depth === 0);
  const fnRange = { start: fnBlock.openOffset, end: fnBlock.closeOffset + 1 };
  const c = classify.classifyFromHeuristic(text, blockRange, fnRange, [fnRange], 1, 'k');

  assert.equal(c.byName.get('b')?.cls, 'block');
  assert.equal(c.byName.get('local')?.cls, 'fn');
  assert.equal(c.byName.get('g')?.cls, 'out');
  assert.equal(c.byName.get('b')?.freqInBlock, 3); // decl + 2 uses
  // g declared at module scope → true global (not a capture)
  assert.equal(c.byName.get('g')?.isCapture, false);
  assert.ok(c.fileGlobalsInOrder.includes('g'));
});

test('classifyFromHeuristic: this/self routed to self class', () => {
  const text = 'function f() {\n  this.x = 1\n  self.y = 2\n}';
  const blocks = focus.scanBraceBlocks(text);
  const b = blocks[0];
  const range = { start: b.openOffset, end: b.closeOffset + 1 };
  const c = classify.classifyFromHeuristic(text, range, range, [range], 1, 'k');
  assert.equal(c.byName.get('this')?.cls, 'self');
  assert.equal(c.byName.get('self')?.cls, 'self');
});

test('classify: self names get occurrences injected so they can be tinted', () => {
  const text = 'function f() {\n  this.x = 1\n  this.y = 2\n}';
  const blocks = focus.scanBraceBlocks(text);
  const b = blocks[0];
  const range = { start: b.openOffset, end: b.closeOffset + 1 };
  const c = classify.classifyFromHeuristic(text, range, range, [range], 1, 'k');
  // `this` is a keyword the occurrence scan skips; addSelfOccurrences must inject it.
  const occ = c.occurrences.get('this');
  assert.ok(occ && occ.length === 2, 'both `this` occurrences recorded');
  // And traces must produce non-empty ranges for it (was the dropped-self bug).
  const plan = new Map([['this', { kind: 'self' }]]);
  const targets = traces.computeTraceRanges(c, plan, range);
  const selfTarget = targets.find((t) => t.name === 'this');
  assert.ok(selfTarget && selfTarget.ranges.length === 2, 'self tint traces to its occurrences');
});

test('enclosingFnOf / outermostFnOf: innermost vs outermost function selection', () => {
  // outer fn [0,100), inner closure [40,70), caret at 50
  const fnRanges = [{ start: 0, end: 100 }, { start: 40, end: 70 }];
  const inner = classify.enclosingFnOf(fnRanges, 50);
  const outer = classify.outermostFnOf(fnRanges, 50);
  assert.deepEqual(inner, { start: 40, end: 70 }); // tightest
  assert.deepEqual(outer, { start: 0, end: 100 }); // widest
});

test('classify: colorScopeFn is the outermost fn, so closures share the parent palette', () => {
  // summarize(cfgs) { return cfgs.filter(c => ...).map(c => { const times = c.length }) }
  // Uses semantic tokens (the real runtime path): `c` is a parameter token,
  // `times` a variable token — both declared inside a function → locals.
  const text =
    'function summarize(cfgs) {\n' +
    '  return cfgs\n' +
    '    .filter((c) => c.length > 0)\n' +
    '    .map((c) => {\n' +
    '      const times = c.length\n' +
    '      return times\n' +
    '    })\n' +
    '}\n';
  const blocks = focus.scanBraceBlocks(text);
  const outerFn = blocks.reduce((a, b) => (b.openOffset < a.openOffset ? b : a));
  const mapBlock = blocks.reduce((a, b) => (b.depth > a.depth ? b : a));
  const fnRange = { start: outerFn.openOffset, end: outerFn.closeOffset + 1 };
  const mapRange = { start: mapBlock.openOffset, end: mapBlock.closeOffset + 1 };
  const fnRanges = [fnRange, mapRange];
  const nth = (s, n) => {
    let idx = -1;
    for (let k = 0; k <= n; k++) {
      idx = text.indexOf(s, idx + 1);
    }
    return idx;
  };
  const tok = (name, off, type, mods = []) => ({ name, offset: off, length: name.length, type, modifiers: mods });
  const tokens = [
    tok('summarize', nth('summarize', 0), 'function', ['declaration']),
    tok('cfgs', nth('cfgs', 0), 'parameter', ['declaration']),
    tok('cfgs', nth('cfgs', 1), 'parameter', []),
    tok('c', nth('(c)', 0) + 1, 'parameter', ['declaration']), // .filter param
    tok('c', nth('c.length', 0), 'parameter', []),
    tok('c', nth('(c)', 1) + 1, 'parameter', ['declaration']), // .map param
    tok('times', nth('times', 0), 'variable', ['declaration']),
    tok('c', nth('c.length', 1), 'parameter', []),
    tok('times', nth('times', 1), 'variable', []),
  ];
  const enclosing = classify.enclosingFnOf(fnRanges, mapBlock.openOffset);
  const colorScope = classify.outermostFnOf(fnRanges, mapBlock.openOffset);
  const c = classify.classifyFromSemantic(text, mapRange, enclosing, fnRanges, tokens, 1, 'k', colorScope);
  // colorScopeFn must be the OUTER summarize fn, not the .map arrow
  assert.deepEqual(c.colorScopeFn, fnRange);
  // `c` and `times` both appear in the color scope's local order (stable palette)
  assert.ok(c.fnLocalsInOrder.includes('c'), 'closure param c is a local');
  assert.ok(c.fnLocalsInOrder.includes('times'), 'closure-local times is a local');
});

test('classifyFromSemantic: only variable/parameter tint; methods, properties, builtins excluded', () => {
  // console.log(x) where console is a defaultLibrary variable, log is a method,
  // x is a plain variable. Only x should be tintable.
  const text = 'function f() {\n  const x = 1\n  console.log(x)\n}';
  const blocks = focus.scanBraceBlocks(text);
  const b = blocks[0];
  const range = { start: b.openOffset, end: b.closeOffset + 1 };
  const off = (s) => text.indexOf(s);
  const tokens = [
    { name: 'f', offset: off('f('), length: 1, type: 'function', modifiers: ['declaration'] },
    { name: 'x', offset: off('x ='), length: 1, type: 'variable', modifiers: ['declaration'] },
    { name: 'console', offset: off('console'), length: 7, type: 'variable', modifiers: ['defaultLibrary'] },
    { name: 'log', offset: off('log'), length: 3, type: 'method', modifiers: [] },
    { name: 'x', offset: off('x)'), length: 1, type: 'variable', modifiers: [] },
  ];
  const c = classify.classifyFromSemantic(text, range, range, [range], tokens, 1, 'k');
  assert.ok(c.byName.has('x'), 'plain variable x is a data identity');
  assert.ok(!c.byName.has('console'), 'builtin (defaultLibrary) is NOT tinted');
  assert.ok(!c.byName.has('log'), 'method name is NOT tinted');
  assert.ok(!c.byName.has('f'), 'function name is NOT tinted');
  // occurrences must also exclude the non-data tokens
  assert.ok(!c.occurrences.has('console'));
  assert.ok(!c.occurrences.has('log'));
});

test('classifyFromSemantic: object-shorthand reads tint; field access + key literals do not', () => {
  // function f(name) { const o = { name, id: name, tag: cfg.name } }
  //   { name }      → shorthand read  → tints
  //   { id: name }  → `name` is a value read (variable) → tints; `id` key → no
  //   cfg.name      → field access    → no
  const text = 'function f(name) {\n  const o = { name, id: 1, tag: cfg.name }\n}';
  const blocks = focus.scanBraceBlocks(text);
  const objBlock = blocks.reduce((a, b) => (b.depth > a.depth ? b : a));
  const range = { start: objBlock.openOffset, end: objBlock.closeOffset + 1 };
  const fnBlock = blocks.find((b) => b.depth === 0);
  // Real fn symbol ranges (from documentSymbol) start at the keyword, so the
  // parameter declaration inside the signature is inside the fn range.
  const fnRange = { start: text.indexOf('function'), end: fnBlock.closeOffset + 1 };
  const at = (s, n = 0) => {
    let i = -1;
    for (let k = 0; k <= n; k++) i = text.indexOf(s, i + 1);
    return i;
  };
  const tok = (name, off, type, mods = []) => ({ name, offset: off, length: name.length, type, modifiers: mods });
  const tokens = [
    tok('name', at('name)'), 'parameter', ['declaration']), // the param decl
    tok('name', at('name,'), 'property', []), // { name } shorthand read → tints
    tok('id', at('id:'), 'property', []), // key literal → no
    tok('cfg', at('cfg.name'), 'variable', []), // receiver var
    tok('name', at('name }'), 'property', []), // cfg.name field access → no
  ];
  const c = classify.classifyFromSemantic(text, range, fnRange, [fnRange], tokens, 1, 'k');
  // `name` is tinted (param + shorthand read), classified fn-local (declared in fn header)
  assert.ok(c.byName.has('name'), 'shorthand read tints');
  assert.equal(c.byName.get('name').cls, 'fn');
  assert.ok(!c.byName.has('id'), 'key literal id does not tint');
  // the field-access occurrence of name must NOT be recorded (only the shorthand + decl)
  const nameOccs = c.occurrences.get('name') || [];
  assert.ok(!nameOccs.some((r) => r.start === at('name }')), 'field-access name excluded from occurrences');
});

test('classifyFromSemantic: shorthand read with declaration modifier is NOT a binding decl', () => {
  // TS marks `{ name }` shorthand with a `declaration` modifier (it declares the
  // object property). When that object literal is the FOCUSED block, the token
  // must not be counted as declaring the `name` variable — else `name` becomes
  // block-local, hits the freq≥2 gate on its single use, and goes neutral (white).
  const text = 'function f(name) {\n  const o = {\n    name,\n    x: 1,\n  }\n  return o\n}';
  const blocks = focus.scanBraceBlocks(text);
  const objBlock = blocks.reduce((a, b) => (b.depth > a.depth ? b : a)); // the { name, x } literal
  const objRange = { start: objBlock.openOffset, end: objBlock.closeOffset + 1 };
  const fnRange = { start: text.indexOf('function'), end: blocks.find((b) => b.depth === 0).closeOffset + 1 };
  const at = (s) => text.indexOf(s);
  const tok = (name, off, type, mods = []) => ({ name, offset: off, length: name.length, type, modifiers: mods });
  const tokens = [
    tok('name', at('name)'), 'parameter', ['declaration']),
    tok('name', at('name,'), 'property', ['declaration']), // shorthand read, decl modifier
  ];
  const c = classify.classifyFromSemantic(text, objRange, fnRange, [fnRange], tokens, 1, 'k', fnRange);
  // Must be fn-local (borrowed param), NOT block-local — so it tints on a single use.
  assert.equal(c.byName.get('name').cls, 'fn');
});

// ── colors.ts ─────────────────────────────────────────────────────────────────

function nameInfo(cls, opts = {}) {
  return {
    cls,
    freqInBlock: opts.freq ?? 1,
    firstFileOffset: opts.file ?? 0,
    firstBlockOffset: opts.block ?? 0,
    isCapture: opts.isCapture ?? false,
    homeFn: opts.homeFn,
    // proximity: 0 direct block-local, 1 borrowed-in, 2 nested sub-block.
    proximity: opts.proximity ?? (cls === 'block' ? 0 : 1),
  };
}

// Build an AssignScope; derives the local/global order from byName unless given.
function scope(opts = {}) {
  return {
    fileGlobalsInOrder: opts.fileGlobals ?? [],
    fnLocalsInOrder: opts.fnLocals ?? [],
    fnGlobals: opts.fnGlobals ?? [],
    fnKey: opts.fnKey ?? 'fn0',
  };
}

test('assignColors: attention priority — direct block-locals win hues over nested/borrowed when scarce', () => {
  // 6 locals, 5 hues. Priority: proximity (0 direct > 1 borrowed > 2 nested),
  // then frequency. The two nested (proximity 2) low-freq names should lose.
  const gl = new colors.GlobalColorLedger();
  const ll = new colors.LocalColorLedger();
  const byName = new Map([
    ['direct1', nameInfo('block', { freq: 2, proximity: 0, block: 1 })],
    ['direct2', nameInfo('block', { freq: 2, proximity: 0, block: 2 })],
    ['direct3', nameInfo('block', { freq: 2, proximity: 0, block: 3 })],
    ['borrowed', nameInfo('fn', { freq: 2, proximity: 1, block: 4 })],
    ['nestedHi', nameInfo('block', { freq: 9, proximity: 2, block: 5 })], // high freq but nested
    ['nestedLo', nameInfo('block', { freq: 2, proximity: 2, block: 6 })],
  ]);
  const fnLocals = ['direct1', 'direct2', 'direct3', 'borrowed', 'nestedHi', 'nestedLo'];
  const plan = colors.assignColors(byName, gl, ll, scope({ fnLocals, fnKey: 'fn' }));
  // All three direct + the borrowed + one nested (the higher-freq) get hues; the 6th overflows.
  for (const n of ['direct1', 'direct2', 'direct3', 'borrowed']) {
    assert.notEqual(plan.get(n)?.kind, 'neutral', `${n} (proximity<2) must tint`);
    assert.ok(plan.get(n)?.poolIndex !== undefined);
  }
  // nestedHi beats nestedLo on frequency within the proximity-2 tier → nestedLo overflows.
  assert.ok(plan.get('nestedHi')?.poolIndex !== undefined, 'higher-freq nested wins the last slot');
  assert.ok(plan.get('nestedLo') === undefined || plan.get('nestedLo').kind === 'neutral', 'lower-freq nested overflows');
});

test('assignColors: salience — out-of-fn bold idg, fn/block≥2 id, once-used block neutral', () => {
  const byName = new Map([
    ['g', nameInfo('out', { file: 0 })],
    ['p', nameInfo('fn', { block: 10 })],
    ['b2', nameInfo('block', { freq: 2, block: 20 })],
    ['b1', nameInfo('block', { freq: 1, block: 30 })], // once-used → neutral
  ]);
  const plan = colors.assignColors(
    byName,
    new colors.GlobalColorLedger(),
    new colors.LocalColorLedger(),
    scope({ fileGlobals: ['g'], fnLocals: ['p', 'b2', 'b1'] }),
  );
  assert.equal(plan.get('g').kind, 'idg'); // out-of-fn bold
  assert.equal(plan.get('p').kind, 'id'); // fn-local normal
  assert.equal(plan.get('b2').kind, 'id'); // block ≥2
  const b1 = plan.get('b1');
  assert.ok(b1 === undefined || b1.kind === 'neutral'); // once-used → neutral
});

test('assignColors: self is gold and never consumes a slot', () => {
  const byName = new Map([
    ['this', nameInfo('self')],
    ['a', nameInfo('fn', { block: 1 })],
    ['b', nameInfo('fn', { block: 2 })],
  ]);
  const plan = colors.assignColors(
    byName,
    new colors.GlobalColorLedger(),
    new colors.LocalColorLedger(),
    scope({ fnLocals: ['a', 'b'] }),
  );
  assert.equal(plan.get('this').kind, 'self');
  assert.equal(plan.get('a').poolIndex, 0);
  assert.equal(plan.get('b').poolIndex, 1);
});

test('assignColors: global hue fixed by FILE order regardless of visit order', () => {
  const gl = new colors.GlobalColorLedger();
  const ll = new colors.LocalColorLedger();
  // Focus a block showing only g2 first.
  const plan2 = colors.assignColors(
    new Map([['g2', nameInfo('out', { file: 100 })]]),
    gl,
    ll,
    scope({ fileGlobals: ['g1', 'g2'] }),
  );
  // Then a block showing g1.
  const plan1 = colors.assignColors(
    new Map([['g1', nameInfo('out', { file: 0 })]]),
    gl,
    ll,
    scope({ fileGlobals: ['g1', 'g2'] }),
  );
  assert.equal(plan1.get('g1').poolIndex, 0);
  assert.equal(plan2.get('g2').poolIndex, 1);
});

test('assignColors: LOCAL hue is stable across a function\'s sub-blocks (the cfg fix)', () => {
  const gl = new colors.GlobalColorLedger();
  const ll = new colors.LocalColorLedger();
  const fnLocals = ['cfg', 'label', 'name']; // function-order
  // Sub-block 1 (function body): cfg is a fn-local here.
  const b1 = colors.assignColors(
    new Map([['cfg', nameInfo('fn', { block: 5 })], ['label', nameInfo('block', { freq: 2, block: 9 })]]),
    gl,
    ll,
    scope({ fnLocals, fnKey: 'loadConfig' }),
  );
  // Sub-block 2 (the `if`): cfg now reads as block-local, different block order.
  const b2 = colors.assignColors(
    new Map([['cfg', nameInfo('block', { freq: 3, block: 40 })]]),
    gl,
    ll,
    scope({ fnLocals, fnKey: 'loadConfig' }),
  );
  // Sub-block 3 (the `for`): cfg again, yet another block order.
  const b3 = colors.assignColors(
    new Map([['cfg', nameInfo('block', { freq: 2, block: 70 })]]),
    gl,
    ll,
    scope({ fnLocals, fnKey: 'loadConfig' }),
  );
  // cfg must keep ONE hue across all three sub-blocks.
  assert.equal(b1.get('cfg').poolIndex, b2.get('cfg').poolIndex);
  assert.equal(b2.get('cfg').poolIndex, b3.get('cfg').poolIndex);
});

test('assignColors: local ledger resets across DIFFERENT functions', () => {
  const gl = new colors.GlobalColorLedger();
  const ll = new colors.LocalColorLedger();
  // Function A: `x` is the first local → slot index 0.
  const a = colors.assignColors(
    new Map([['x', nameInfo('fn', { block: 1 })]]),
    gl,
    ll,
    scope({ fnLocals: ['x'], fnKey: 'fnA' }),
  );
  // Function B: `y` is the first local → also slot index 0 (fresh scope).
  const b = colors.assignColors(
    new Map([['y', nameInfo('fn', { block: 1 })]]),
    gl,
    ll,
    scope({ fnLocals: ['y'], fnKey: 'fnB' }),
  );
  assert.equal(a.get('x').poolIndex, 0);
  assert.equal(b.get('y').poolIndex, 0);
});

test('assignColors: slots are a per-BLOCK budget — sibling sub-blocks reuse hues, no overflow', () => {
  // A function with MORE locals than the 5-hue rotation, but split across sibling
  // sub-blocks so no single block needs >5. Every block must tint all its locals.
  const ll = new colors.LocalColorLedger();
  const gl = new colors.GlobalColorLedger();
  // function-appearance order across the whole function (8 locals > 5 slots)
  const fnLocals = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const mk = (names) => new Map(names.map((n, i) => [n, nameInfo('block', { freq: 2, block: i })]));

  // sub-block 1 uses a,b,c
  const p1 = colors.assignColors(mk(['a', 'b', 'c']), gl, ll, scope({ fnLocals, fnKey: 'fn' }));
  // sub-block 2 uses d,e,f (siblings — reuse slots)
  const p2 = colors.assignColors(mk(['d', 'e', 'f']), gl, ll, scope({ fnLocals, fnKey: 'fn' }));
  // sub-block 3 uses g,h
  const p3 = colors.assignColors(mk(['g', 'h']), gl, ll, scope({ fnLocals, fnKey: 'fn' }));

  for (const [p, names] of [[p1, ['a', 'b', 'c']], [p2, ['d', 'e', 'f']], [p3, ['g', 'h']]]) {
    for (const n of names) {
      assert.notEqual(p.get(n)?.kind, 'neutral', `${n} must tint (per-block budget, not per-function)`);
      assert.ok(p.get(n)?.poolIndex !== undefined, `${n} got a hue`);
    }
    // within a block, hues are distinct
    const idxs = names.map((n) => p.get(n).poolIndex);
    assert.equal(new Set(idxs).size, idxs.length, 'distinct hues within a block');
  }

  // Stability: revisiting sub-block 1 keeps a/b/c's original hues.
  const p1again = colors.assignColors(mk(['a', 'b', 'c']), gl, ll, scope({ fnLocals, fnKey: 'fn' }));
  for (const n of ['a', 'b', 'c']) {
    assert.equal(p1again.get(n).poolIndex, p1.get(n).poolIndex, `${n} hue stable across revisit`);
  }
});

test('assignColors: >5 locals in ONE block — the 6th+ overflow to neutral', () => {
  const ll = new colors.LocalColorLedger();
  const gl = new colors.GlobalColorLedger();
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g']; // 7 in one block, 5 slots
  const plan = colors.assignColors(
    new Map(names.map((n, i) => [n, nameInfo('block', { freq: 2, block: i })])),
    gl,
    ll,
    scope({ fnLocals: names, fnKey: 'fn' }),
  );
  const tinted = names.filter((n) => plan.get(n)?.poolIndex !== undefined);
  const neutral = names.filter((n) => plan.get(n) === undefined || plan.get(n).kind === 'neutral');
  assert.equal(tinted.length, colors.INTERLEAVE.length, 'exactly rotation-many tint');
  assert.equal(neutral.length, names.length - colors.INTERLEAVE.length, 'the rest overflow to neutral');
});

test('assignColors: local hues skip slots held by globals in the same function', () => {
  const gl = new colors.GlobalColorLedger();
  const ll = new colors.LocalColorLedger();
  // Global `g` appears in the function → its slot is reserved from locals.
  const plan = colors.assignColors(
    new Map([['g', nameInfo('out', { file: 0 })], ['loc', nameInfo('fn', { block: 5 })]]),
    gl,
    ll,
    scope({ fileGlobals: ['g'], fnGlobals: ['g'], fnLocals: ['loc'], fnKey: 'fn0' }),
  );
  assert.notEqual(plan.get('loc').poolIndex, plan.get('g').poolIndex);
});

test('assignColors: overflow → neutral, never recycles a hue', () => {
  const byName = new Map();
  for (let i = 0; i < 8; i++) {
    byName.set('g' + i, nameInfo('out', { file: i }));
  }
  const globals = [...byName.keys()];
  const plan = colors.assignColors(byName, new colors.GlobalColorLedger(), new colors.LocalColorLedger(), scope({ fileGlobals: globals }));
  const used = [...plan.values()].filter((e) => e.kind === 'idg').map((e) => e.poolIndex);
  assert.equal(used.length, colors.INTERLEAVE.length, 'uses exactly the rotation size (5 after moegi pull)');
  assert.equal(new Set(used).size, used.length); // never recycle
  const neutrals = [...plan.values()].filter((e) => e.kind === 'neutral').length;
  assert.equal(neutrals, byName.size - used.length);
});

test('assignColors: determinism — same input yields same plan', () => {
  const mk = () =>
    new Map([
      ['g', nameInfo('out', { file: 0 })],
      ['p', nameInfo('fn', { block: 5 })],
      ['b', nameInfo('block', { freq: 2, block: 9 })],
    ]);
  const s = () => scope({ fileGlobals: ['g'], fnLocals: ['p', 'b'] });
  const p1 = colors.assignColors(mk(), new colors.GlobalColorLedger(), new colors.LocalColorLedger(), s());
  const p2 = colors.assignColors(mk(), new colors.GlobalColorLedger(), new colors.LocalColorLedger(), s());
  assert.deepEqual([...p1.entries()], [...p2.entries()]);
});

// ── traces.ts ─────────────────────────────────────────────────────────────────

test('computeTraceRanges: block-local clipped to block, global file-wide', () => {
  const block = { start: 10, end: 20 };
  const classification = {
    docVersion: 1,
    focusKey: 'k',
    byName: new Map([
      ['b', nameInfo('block', { freq: 2 })],
      ['g', nameInfo('out', { file: 0 })],
    ]),
    occurrences: new Map([
      ['b', [{ start: 12, end: 13 }, { start: 30, end: 31 }]], // one in-block, one outside
      ['g', [{ start: 1, end: 2 }, { start: 40, end: 41 }]],
    ]),
    fileGlobalsInOrder: ['g'],
    enclosingFn: { start: 5, end: 25 },
    source: 'lsp',
  };
  const plan = new Map([
    ['b', { kind: 'id', poolIndex: 0 }],
    ['g', { kind: 'idg', poolIndex: 1 }],
  ]);
  const targets = traces.computeTraceRanges(classification, plan, block);
  const bT = targets.find((t) => t.name === 'b');
  const gT = targets.find((t) => t.name === 'g');
  assert.equal(bT.ranges.length, 1); // clipped to block, only in-block occurrence
  assert.equal(gT.ranges.length, 2); // global → file-wide, both occurrences
});

test('computeTraceRanges: a global does NOT tint a same-named param in another fn', () => {
  // `const cfgs = [...]` at module level, plus `function summarize(cfgs)`. Those
  // are two identities; painting both one hue asserts a data flow that does not
  // exist, and visually merges exactly what shadowing already makes confusable.
  const block = { start: 200, end: 260 };
  const summarize = { start: 40, end: 120 };
  const classification = {
    docVersion: 1,
    focusKey: 'k',
    byName: new Map([['cfgs', nameInfo('out', { file: 210 })]]),
    occurrences: new Map([
      ['cfgs', [
        { start: 50, end: 54 },   // summarize's PARAMETER — shadowed, must be dropped
        { start: 70, end: 74 },   // its use inside summarize — also dropped
        { start: 210, end: 214 }, // the global declaration
        { start: 240, end: 244 }, // a global read
      ]],
    ]),
    fileGlobalsInOrder: ['cfgs'],
    enclosingFn: undefined, // caret at module top level
    shadowScopes: new Map([['cfgs', [summarize]]]),
    source: 'lsp',
  };
  const plan = new Map([['cfgs', { kind: 'idg', poolIndex: 0 }]]);
  const t = traces.computeTraceRanges(classification, plan, block)[0];
  assert.deepEqual(t.ranges.map((r) => r.start), [210, 240], 'only the global identity tints');
});

test('computeTraceRanges: a name declared in ONE fn still traces its whole own scope', () => {
  // The shadow subtraction must not eat the identity's own declaring scope.
  const fn = { start: 40, end: 120 };
  const classification = {
    docVersion: 1,
    focusKey: 'k',
    byName: new Map([['p', nameInfo('fn', { file: 50 })]]),
    occurrences: new Map([['p', [{ start: 50, end: 51 }, { start: 70, end: 71 }]]]),
    fileGlobalsInOrder: [],
    enclosingFn: fn,
    shadowScopes: new Map([['p', [fn]]]),
    source: 'lsp',
  };
  const plan = new Map([['p', { kind: 'id', poolIndex: 0 }]]);
  const t = traces.computeTraceRanges(classification, plan, { start: 40, end: 120 })[0];
  assert.equal(t.ranges.length, 2, 'own scope is not subtracted from itself');
});

test('computeTraceRanges: neutral plan entries produce no ranges', () => {
  const block = { start: 0, end: 100 };
  const classification = {
    byName: new Map([['x', nameInfo('block', { freq: 1 })]]),
    occurrences: new Map([['x', [{ start: 5, end: 6 }]]]),
    enclosingFn: undefined,
  };
  const plan = new Map([['x', { kind: 'neutral' }]]);
  const targets = traces.computeTraceRanges(classification, plan, block);
  assert.equal(targets.length, 0);
});

// ── risk.ts ───────────────────────────────────────────────────────────────────

test('lexicalRisk: await/async cyan, as/any danger, numbers clay', () => {
  const text = 'async function f() { const x = await g() as any; return 42 }';
  const block = { start: text.indexOf('{'), end: text.length };
  const r = risk.lexicalRisk(text, block);
  const asyncWords = r.async.map((rr) => text.slice(rr.start, rr.end));
  const dangerWords = r.danger.map((rr) => text.slice(rr.start, rr.end));
  const nums = r.numberEngaged.map((rr) => text.slice(rr.start, rr.end));
  assert.ok(asyncWords.includes('await'));
  assert.ok(dangerWords.includes('as'));
  assert.ok(dangerWords.includes('any'));
  assert.ok(nums.includes('42'));
});

test('lexicalRisk: numeric edge cases — hex, decimal, exponent, range dots', () => {
  const text = '{ a=0xFF; b=1.5e-3; c=10; for(i=0;i<9;i++){} }';
  const block = { start: 0, end: text.length };
  const r = risk.lexicalRisk(text, block);
  const nums = r.numberEngaged.map((rr) => text.slice(rr.start, rr.end));
  assert.ok(nums.includes('0xFF'), 'hex literal');
  assert.ok(nums.some((n) => n.startsWith('1.5e')), 'exponent literal');
  assert.ok(nums.includes('10'));
});

test('lexicalRisk: `0..9` range splits into two literals (double-dot fix)', () => {
  const text = '{ for x in 0..9 {} }';
  const block = { start: 0, end: text.length };
  const nums = risk.lexicalRisk(text, block).numberEngaged.map((rr) => text.slice(rr.start, rr.end));
  assert.ok(nums.includes('0'), 'left endpoint');
  assert.ok(nums.includes('9'), 'right endpoint');
  assert.ok(!nums.some((n) => n.includes('..')), 'the .. operator must not be swallowed');
});

test('lexicalRisk: `0xE+1` hex literal stops before + (hex-E exponent fix)', () => {
  const text = '{ y = 0xE + 1 }';
  const block = { start: 0, end: text.length };
  const nums = risk.lexicalRisk(text, block).numberEngaged.map((rr) => text.slice(rr.start, rr.end));
  assert.ok(nums.includes('0xE'), 'hex literal');
  assert.ok(!nums.some((n) => n.includes('+')), 'trailing + after hex E must not be consumed');
});

test('escapeRisk: write to out-of-block binding marked, block-local write ignored', () => {
  // total is fn/out (escapes); local is block-local (bookkeeping, ignored).
  const text = '{ total += 1; local = 2; total++; }';
  const block = { start: 0, end: text.length };
  const classification = {
    byName: new Map([
      ['total', nameInfo('out')],
      ['local', nameInfo('block')],
    ]),
  };
  const esc = risk.escapeRisk(text, block, classification);
  const names = esc.map((r) => text.slice(r.start, r.end));
  assert.ok(names.includes('total'), 'compound assign to global escapes');
  assert.ok(!names.includes('local'), 'block-local write is local bookkeeping');
  // total appears twice as a write (+= and ++)
  assert.equal(names.filter((n) => n === 'total').length, 2);
});

test('escapeRisk: comparisons and arrows are NOT writes', () => {
  const text = '{ if (total == 1) {} const f = (x) => x; total === 2; }';
  const block = { start: 0, end: text.length };
  const classification = { byName: new Map([['total', nameInfo('out')], ['x', nameInfo('fn')]]) };
  const esc = risk.escapeRisk(text, block, classification);
  assert.equal(esc.length, 0, '==, ===, => are not assignments');
});
