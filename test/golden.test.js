'use strict';
// GOLDEN tests: run the classifier against REAL semantic tokens captured from
// the actual language servers (TypeScript's getEncodedSemanticClassifications
// and `gopls semtok`), not hand-built fixtures. This is what catches
// "the server tokenizes differently than we guessed" — the class of bug that
// hand-fixtures structurally cannot find.
//
// Regenerate fixtures after changing the samples:
//   node test/gen-ts-semtok.js samples/sample.js > test/fixtures/sample.js.tokens.json
//   ~/go/bin/gopls semtok samples/sample.go | node test/gen-go-semtok.js samples/sample.go > test/fixtures/sample.go.tokens.json

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const focus = require('../out/focus');
const classify = require('../out/classify');
const colors = require('../out/colors');
const traces = require('../out/traces');

const ROOT = path.join(__dirname, '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readTokens = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

/**
 * Approximate function ranges from a token stream, so tests don't need a real
 * documentSymbol provider: a `function`/`method` token opens a range that runs
 * to the matching close brace of the block starting after it. Good enough for
 * these samples; the point of the test is the tint decision per token, and the
 * real extension gets fnRanges from documentSymbol.
 */
function functionRangesFromTokens(text, tokens) {
  void tokens;
  // Approximate fn-ranges structurally: any brace-block whose header contains a
  // function/method/arrow signal. Covers `function f(...) {`, `func (...) {`,
  // `method(...) {`, and arrows `(...) => {` / `=> {` — which token-type
  // detection misses (arrows aren't `function`-typed tokens). The real extension
  // gets these from documentSymbol; this is close enough for the tint decision.
  const blocks = focus.scanBraceBlocks(text);
  const ranges = [];
  for (const b of blocks) {
    const header = text.slice(b.headerStart, b.openOffset);
    if (/\b(function|func)\b|=>\s*$|\)\s*(:[^)]*)?\s*$|\)\s*\w[\w<>\[\], ]*\s*$/.test(header)) {
      ranges.push({ start: b.headerStart, end: b.closeOffset + 1 });
    }
  }
  return ranges;
}

/** Which names would tint anywhere in the file, focusing each brace block once. */
function tintedNames(text, tokens) {
  const blocks = focus.scanBraceBlocks(text);
  const fnRanges = functionRangesFromTokens(text, tokens);
  const tinted = new Set();
  const neutralCandidates = new Set();
  for (const block of blocks) {
    // The extension uses ONE header-inclusive range for both lexing and
    // classification (see classify-lsp.ts) — mirror that here.
    const blockRange = focus.declRegionFor(text, block);
    const declRegion = blockRange;
    const enclosing = classify.enclosingFnOf(fnRanges, block.openOffset);
    const outer = classify.outermostFnOf(fnRanges, block.openOffset);
    const c = classify.classifyFromSemantic(text, blockRange, enclosing, fnRanges, tokens, 1, 'k', outer, declRegion);
    for (const [name, info] of c.byName) {
      neutralCandidates.add(name);
      // fn/out/self always tint; block needs freq>=2 — approximate "would tint"
      if (info.cls !== 'block' || info.freqInBlock >= 2) {
        tinted.add(name);
      }
    }
  }
  return { tinted, seen: neutralCandidates };
}

// ── TypeScript (sample.js) ────────────────────────────────────────────────────

test('golden TS: data variables tint, structural/library tokens do not', () => {
  const text = readText('samples/sample.js');
  const tokens = readTokens('test/fixtures/sample.js.tokens.json');
  const { tinted } = tintedNames(text, tokens);

  // Data identities that SHOULD tint:
  for (const n of ['cfg', 'name', 'label', 'i', 'times', 'cfgs']) {
    assert.ok(tinted.has(n), `expected data identity "${n}" to tint`);
  }
  // Things that must NOT tint (functions, methods, builtins):
  for (const n of ['loadConfig', 'summarize', 'console', 'log', 'repeat']) {
    assert.ok(!tinted.has(n), `"${n}" must not tint`);
  }
  // DEFAULTS is a true module global (out-of-fn) and DOES tint as an identity —
  // it is data, not library surface. Documented so the expectation is explicit.
  assert.ok(tinted.has('DEFAULTS'), 'module-global data DEFAULTS tints (out-of-fn identity)');
});

test('golden TS: object-shorthand `{ name }` tints (property+declaration, no definition)', () => {
  const text = readText('samples/sample.js');
  const tokens = readTokens('test/fixtures/sample.js.tokens.json');
  // The shorthand token exists and is admitted as tintable.
  const shorthand = tokens.find((t) => t.name === 'name' && t.type === 'property');
  assert.ok(shorthand, 'fixture has the shorthand property token');
  assert.ok(shorthand.modifiers.includes('declaration'));
  assert.ok(!shorthand.modifiers.includes('definition'), 'TS shorthand has no definition modifier');
  const { tinted } = tintedNames(text, tokens);
  assert.ok(tinted.has('name'), 'shorthand read tints');
});

// ── Go (sample.go) ────────────────────────────────────────────────────────────

test('golden Go: struct fields + field access do NOT tint; data vars do', () => {
  const text = readText('samples/sample.go');
  const tokens = readTokens('test/fixtures/sample.go.tokens.json');
  const { tinted } = tintedNames(text, tokens);

  // Struct field DEFINITIONS (property [definition ...]) must not tint —
  // this was the bug: they were painted file-wide as data.
  for (const n of ['Name', 'Retries', 'Tags']) {
    assert.ok(!tinted.has(n), `Go struct field "${n}" must not tint (it is a field definition/access, not data)`);
  }
  // Type names and library surface must not tint.
  assert.ok(!tinted.has('Config'), 'type name Config must not tint');
  assert.ok(!tinted.has('fmt'), 'namespace fmt must not tint');
  assert.ok(!tinted.has('Printf'), 'function Printf must not tint');

  // Real data identities SHOULD tint.
  for (const n of ['cfg', 'name', 'label', 'i', 'c', 'cfgs']) {
    assert.ok(tinted.has(n), `Go data identity "${n}" should tint`);
  }
});

test('golden Go: struct field tokens carry the `definition` modifier (the distinguishing signal)', () => {
  const tokens = readTokens('test/fixtures/sample.go.tokens.json');
  const field = tokens.find((t) => t.name === 'Name' && t.type === 'property' && t.modifiers.includes('definition'));
  assert.ok(field, 'gopls marks struct field defs with property [definition ...]');
  // and the composite-literal key `Name:` is a plain property (excluded by the `:` rule)
  const key = tokens.find(
    (t) => t.name === 'Name' && t.type === 'property' && !t.modifiers.includes('definition'),
  );
  assert.ok(key, 'composite-literal key is a plain property token');
});

test('golden Go: loop/if header bindings classify as block-local (headerStart fix)', () => {
  const text = readText('samples/sample.go');
  const tokens = readTokens('test/fixtures/sample.go.tokens.json');
  const blocks = focus.scanBraceBlocks(text);
  const fnRanges = functionRangesFromTokens(text, tokens);

  // `for _, c := range cfgs {` — `c` is declared in the header, before the brace.
  const forHdr = text.indexOf('for _, c := range cfgs');
  const forBlock = blocks.find((b) => b.openOffset === text.indexOf('{', forHdr));
  assert.ok(forBlock, 'found the for-body block');

  const blockRange = { start: forBlock.openOffset, end: forBlock.closeOffset + 1 };
  const declRegion = focus.declRegionFor(text, forBlock); // control-flow → header-inclusive
  const enclosing = classify.enclosingFnOf(fnRanges, forBlock.openOffset);
  const outer = classify.outermostFnOf(fnRanges, forBlock.openOffset);

  const withFix = classify.classifyFromSemantic(text, blockRange, enclosing, fnRanges, tokens, 1, 'k', outer, declRegion);
  assert.equal(withFix.byName.get('c')?.cls, 'block', 'header-declared loop var is block-local with the fix');

  // Without the header-inclusive region, it misclassifies (proves the fix matters).
  const noFix = classify.classifyFromSemantic(text, blockRange, enclosing, fnRanges, tokens, 1, 'k', outer);
  assert.notEqual(noFix.byName.get('c')?.cls, 'block', 'without headerStart, the loop var is NOT block-local');
  // Note: a header binding used ONLY in the header condition (e.g. `ok` in
  // `if _, ok := m[k]; !ok {`) is correctly absent from body classification —
  // there is nothing to tint in the body. `c` above is used in the body, so it
  // is the right witness for the header-inclusive declRegion fix.
});

test('golden Go: TINT TARGETS include header-line occurrences (the white-inside bug)', () => {
  // The real bug: when a sub-block is focused, the tint RANGE was body-only, so
  // identifiers on the header line (`for _, c := range cfgs {` — `c`, `cfgs`)
  // never painted. The fix uses a header-inclusive range for lexing + trace.
  const text = readText('samples/sample.go');
  const tokens = readTokens('test/fixtures/sample.go.tokens.json');
  const blocks = focus.scanBraceBlocks(text);
  const fnRanges = functionRangesFromTokens(text, tokens);

  const forHdr = text.indexOf('for _, c := range cfgs');
  const forBody = blocks.find((b) => b.openOffset === text.indexOf('{', forHdr));
  const range = focus.declRegionFor(text, forBody); // header-inclusive
  const enc = classify.enclosingFnOf(fnRanges, forBody.openOffset);
  const outer = classify.outermostFnOf(fnRanges, forBody.openOffset);
  const c = classify.classifyFromSemantic(text, range, enc, fnRanges, tokens, 1, 'k', outer, range);
  const plan = colors.assignColors(c.byName, new colors.GlobalColorLedger(), new colors.LocalColorLedger(), {
    fileGlobalsInOrder: c.fileGlobalsInOrder,
    fnLocalsInOrder: c.fnLocalsInOrder,
    fnGlobals: c.fnGlobals,
    fnKey: 'x',
  });
  const targets = traces.computeTraceRanges(c, plan, range);
  const byName = Object.fromEntries(targets.map((t) => [t.name, t.ranges]));

  // `cfgs` is used ONLY in the for-header — it must still tint.
  assert.ok(byName.cfgs && byName.cfgs.length >= 1, 'header-only var cfgs tints');
  // `c` must include its header-line occurrence (3 total: header + 2 body uses),
  // not just the 2 body uses.
  assert.ok(byName.c && byName.c.length >= 3, `loop var c includes header occurrence (got ${byName.c?.length})`);
  // The header occurrence of `c` must fall on the header line, before the brace.
  const headerC = byName.c.some((r) => r.start < forBody.openOffset);
  assert.ok(headerC, 'a `c` tint range sits on the header line, before the {');
});
