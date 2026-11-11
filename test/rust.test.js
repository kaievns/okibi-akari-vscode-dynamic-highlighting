'use strict';
// Rust coverage. Rust is brace-scoped, so the block scanner worked on it from day
// one — which is exactly why the gaps were easy to miss. Three assumptions the
// brace-based design had baked in are wrong for Rust:
//
//   1. A function header ENDS in `)`. The fallback in `isFunctionHeader` keys on
//      `\)\s*$`, and a Rust signature almost never ends there: `-> Self`,
//      `-> String` or a `where` clause follows the parameter list. Only the one
//      bare `fn main()` in the sample was recognised, so the parameters of every
//      other function classified as block-locals rather than fn-locals and
//      stopped tracing across the body.
//   2. Every scope has a brace. A Rust closure with a bare expression body
//      (`|c| c.name`) is a scope with parameters and captures and NO `{`, so the
//      caret inside `.map(|c| ...)` fell through to the enclosing function. An
//      iterator chain of these is the most common shape in idiomatic Rust, and
//      `samples/sample.rs` promises the behaviour in its own header: "closures:
//      captured `prefix` + iterator params keep stable hues".
//   3. The keyword list is complete. `HEURISTIC_KEYWORDS` was JS/Go/Python-only,
//      so `fn`, `mut`, `impl`, `pub` and `where` each ranked as a DATA IDENTITY
//      and consumed one of the palette's few hue slots — `mut` and `pub` appear
//      on more lines than most real bindings do. Same failure mode `lambda` had.
//
// Unlike Python, Rust HAS obtainable semantic ground truth: rust-analyzer ships a
// plain binary that speaks LSP, and `scripts/rs_verify.js` in the theme repo
// drives it. The one caveat is that without `cargo` and `rustc` on PATH its name
// resolution is degraded (locals come back as `const`), so only the syntactic
// classes are trustworthy. The tests below assert on the SCANNER, whose ground
// truth is the language rule, so they do not depend on a server at all.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const focus = require('../out/focus');
const classify = require('../out/classify');

const SAMPLE = path.join(__dirname, '../samples/sample.rs');

/** 1-based line number containing `offset`. */
function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

/**
 * The block whose text STARTS on the first line containing `needle`.
 *
 * Located by content and by substring — both learned the hard way on the Python
 * suite, where hard-coded line numbers broke the moment the sample gained two
 * lines, and whole-line equality broke when the user edited a call's arguments.
 * Pass the shortest needle that identifies the line.
 */
function blockAt(text, blocks, needle) {
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.includes(needle));
  assert.ok(idx >= 0, `no line contains ${JSON.stringify(needle)} in sample.rs`);
  const hit = blocks.filter((b) => lineOf(text, b.openOffset) === idx + 1);
  assert.ok(hit.length > 0, `no block opens on ${JSON.stringify(needle)}`);
  return hit;
}

// ── function headers ──────────────────────────────────────────────────────────

test('isFunctionHeader: a Rust fn with a return type IS a function header', () => {
  // The bug: `\)\s*$` cannot match `fn new(name: &str) -> Self {`, so all but the
  // bare `fn main()` were missed. Every form in the sample is checked, because it
  // was the RETURN TYPE that broke it and each of these carries one.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const blocks = focus.scanBlocks(src, 'rust');
  for (const needle of [
    'fn new(name: &str) -> Self',
    'fn with_retries(mut self',
    'fn summary(&self) -> String {',
    'fn fmt(&self, f: &mut fmt::Formatter',
    'fn load_config(name: &str) -> Config',
    'fn summarize(cfgs: &[Config]) -> String',
    'fn main()',
  ]) {
    const [block] = blockAt(src, blocks, needle);
    assert.equal(focus.isFunctionHeader(src, block, 'rust'), true,
      `${JSON.stringify(needle)} should be a function header`);
  }
});

test('isFunctionHeader: visibility and qualifier prefixes do not hide a fn', () => {
  // `pub fn`, `pub(crate) fn`, `pub async fn` and `const fn` are all one
  // construct. An earlier draft anchored on `^\s*fn` and missed all of them.
  for (const header of [
    'pub fn a() -> u32 {',
    'pub(crate) fn b() {',
    'pub async fn c() -> Result<(), ()> {',
    'const fn d() -> u32 {',
    'pub unsafe fn e() {',
    'async fn g() {',
  ]) {
    const src = `${header}\n    let x = 1;\n}\n`;
    const [block] = blockAt(src, focus.scanBlocks(src, 'rust'), 'fn ');
    assert.equal(focus.isFunctionHeader(src, block), true, `${header} should be a fn`);
  }
});

test('isFunctionHeader: a TYPE body is not a function', () => {
  // `impl` is the dangerous one: the fallback's `\)\s*$` arm can match an impl
  // header carrying generics, which would pull the type names in as parameters.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const blocks = focus.scanBlocks(src, 'rust');
  for (const needle of ['struct Config {', 'enum Status {', 'trait Summarize {',
    'impl Config {', 'impl Summarize for Config', 'impl fmt::Display for Status']) {
    const [block] = blockAt(src, blocks, needle);
    assert.equal(focus.isFunctionHeader(src, block), false,
      `${JSON.stringify(needle)} is a type body, not a function`);
  }
});

// ── braceless closures ────────────────────────────────────────────────────────

test('scanBlocks: a braceless closure is its own scope', () => {
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const braced = new Set(focus.scanBraceBlocks(src, 'rust').map((b) => b.openOffset));
  const extra = focus.scanBlocks(src, 'rust').filter((b) => !braced.has(b.openOffset));
  const texts = extra.map((b) => src.slice(b.openOffset, b.closeOffset + 1));
  // Exactly the closures in the sample's iterator chains, and nothing else. The
  // count is asserted so a rule that starts matching bitwise-or shows up here
  // rather than silently adding scopes.
  assert.equal(extra.length, 5, `expected 5 closures, got ${extra.length}: ${texts.join(' | ')}`);
  assert.ok(texts.includes('|c| !c.name.is_empty()'));
  assert.ok(texts.includes('|name| load_config(name)'));
  assert.ok(texts.includes('|acc, item| acc + item.timeout'));
  // Every closure block MUST carry line numbers: innermostBlock filters by caret
  // LINE, so a block with an undefined openLine can never be selected — the bug
  // that left every closure caret resolving to its enclosing function, so the
  // closure's own params read as page white.
  for (const b of extra) {
    assert.equal(typeof b.openLine, 'number', `closure ${JSON.stringify(texts)} has no openLine`);
    assert.equal(typeof b.closeLine, 'number', 'closure has no closeLine');
    assert.equal(b.openLine, lineOf(src, b.openOffset) - 1, 'openLine matches the offset');
  }
});

test('innermostBlock selects a braceless closure the caret sits inside', () => {
  // The end-to-end of the line-number fix: a caret inside `.map(|name| …)` must
  // resolve to the closure, not the enclosing `main`.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const blocks = focus.scanBlocks(src, 'rust');
  const inside = src.indexOf('load_config(name)') + 3; // inside the |name| closure
  const b = focus.innermostBlock(blocks, lineOf(src, inside) - 1, inside, src);
  assert.ok(b && src.slice(b.openOffset, b.closeOffset + 1).startsWith('|name|'),
    'caret in a closure resolves to the closure, not the outer fn');
});

test('a control-flow block used as an expression does not swallow its binding', () => {
  // `let label = match self { … }` — the match is a sub-scope, but `let label` is
  // the ENCLOSING scope's own local. scopeRegionFor must start the match's region
  // at the `match` keyword, not the line's `let`, or `label` scores proximity 2 and
  // is excluded from the attention budget — it never tints. Regression guard for the
  // "label is not highlighted" report.
  const src = 'fn f() -> u32 {\n  let label = match x {\n    0 => 1,\n    _ => 2,\n  };\n  label\n}\n';
  const blocks = focus.scanBraceBlocks(src, 'rust');
  const match = blocks.find((b) => src.slice(b.headerStart, b.openOffset).includes('match'));
  const region = focus.scopeRegionFor(src, match);
  assert.equal(region.start, src.indexOf('match'), 'match region starts at the keyword');
  assert.ok(src.indexOf('let label') < region.start, 'the `let label` binding is outside the match region');
});

test('scanBlocks: a closure body ends at the enclosing call, not the first bracket', () => {
  // `.map(|c| format!("{}", c.name))` — the body ends at the `)` closing `map`,
  // not the one closing `format!`. Brackets have to be counted, and the `)` inside
  // the format STRING must not count at all.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const braced = new Set(focus.scanBraceBlocks(src, 'rust').map((b) => b.openOffset));
  const extra = focus.scanBlocks(src, 'rust').filter((b) => !braced.has(b.openOffset));
  const fmt = extra.find((b) => src.slice(b.openOffset).startsWith('|c| format!'));
  assert.ok(fmt, 'the format! closure was not found');
  const body = src.slice(fmt.openOffset, fmt.closeOffset + 1);
  assert.equal(body, '|c| format!("{}:{} x{}", prefix, c.name, c.retries)',
    'the whole closure body, including the nested macro call');
});

test('scanBlocks: a closure with a BRACED body is left to the brace scanner', () => {
  // Otherwise the two passes produce overlapping blocks for one scope.
  const src = 'fn f(v: &[u32]) {\n    v.iter().map(|x| { x + 1 }).count();\n}\n';
  const braced = new Set(focus.scanBraceBlocks(src, 'rust').map((b) => b.openOffset));
  const extra = focus.scanBlocks(src, 'rust').filter((b) => !braced.has(b.openOffset));
  assert.equal(extra.length, 0, 'a braced closure must not be found twice');
});

test('scanBlocks: `|` that is not a closure is not a scope', () => {
  // Every one of these opened a spurious block in some draft of the rule. The
  // match arm is the important one: `1 | 2 => 0` has both an or-pattern and an
  // `=` (inside `=>`), which is what the naive opener keyed on.
  const src = [
    'fn f(a: u32, b: u32) -> u32 {',
    '    let m = a | b;',                       // bitwise or after `=`
    '    let n = (a | b) | (a | b);',           // bitwise or after `(`
    '    let p = match a { 1 | 2 => 0, _ => 1 };', // or-pattern + `=>`
    '    let t = "|not| a closure";',           // inside a string
    '    // |also| not a closure',              // inside a comment
    '    m | n | p',
    '}',
    '',
  ].join('\n');
  const braced = new Set(focus.scanBraceBlocks(src, 'rust').map((b) => b.openOffset));
  const extra = focus.scanBlocks(src, 'rust').filter((b) => !braced.has(b.openOffset));
  assert.equal(extra.length, 0,
    `no closures here, got: ${extra.map((b) => JSON.stringify(src.slice(b.openOffset, b.closeOffset + 1))).join(' | ')}`);
});

test('isFunctionHeader: a closure block IS a function header', () => {
  // A closure's parameters are its own bindings. The block starts ON the opening
  // `|`, so headerStart === openOffset and the header slice is EMPTY — the same
  // synthetic-block case Python lambdas needed an explicit branch for.
  const src = 'fn f(v: &[u32]) {\n    v.iter().map(|x| x + 1).count();\n}\n';
  const braced = new Set(focus.scanBraceBlocks(src, 'rust').map((b) => b.openOffset));
  const [closure] = focus.scanBlocks(src, 'rust').filter((b) => !braced.has(b.openOffset));
  assert.ok(closure, 'closure not found');
  assert.equal(focus.isFunctionHeader(src, closure), true);
});

// ── the keyword list ──────────────────────────────────────────────────────────

test('Rust keywords are not data identities', () => {
  // Each of these was ranked as a binding and took a hue slot. `mut` and `pub`
  // are the costly ones: they appear on more lines than most real bindings, so
  // they crowded genuine locals out of the palette.
  const src = [
    'pub struct S { pub a: u32 }',
    'impl S {',
    '    pub fn get(&self) -> u32 { self.a }',
    '}',
    'fn f<T>(x: T) -> T where T: Copy {',
    '    let mut y = x;',
    '    let z: u32 = 1;',
    '    y',
    '}',
    '',
  ].join('\n');
  // Feed a semantic token for each REAL binding. Without tokens the heuristic
  // path finds nothing at all, so a test asserting only absences would pass even
  // with the keyword list empty — it has to prove the filter is what excludes
  // them, not that the classifier is inert.
  const tok = (name) => ({
    name, type: 'variable', modifiers: ['declaration'],
    offset: src.indexOf(name, src.indexOf('let mut')), length: name.length,
  });
  const index = classify.buildFileIndex(src, [tok('y'), tok('z')], [], 'rust');
  const names = [...index.occurrences.keys()];
  // `self` is deliberately absent from this list: it goes through isSelfName() and
  // DOES appear in occurrences, because it gets the gold self-slot rather than a
  // palette hue — exactly as in Python.
  for (const kw of ['fn', 'mut', 'impl', 'pub', 'where', 'struct', 'u32']) {
    assert.ok(!names.includes(kw), `${kw} is a keyword, not a data identity`);
  }
  // The control: real bindings still register, so the absences above mean the
  // keyword filter fired rather than the classifier finding nothing.
  assert.ok(names.includes('y'), 'a real local must still be found');
  assert.ok(names.includes('z'), 'a real local must still be found');
});

test('the primitive types stay band-1', () => {
  // `u32`, `usize`, `f64` and friends are `entity.name.type` in the grammar and
  // type slate at rest, so tinting them as data would contradict band 1.
  const src = 'fn f(a: u32, b: usize, c: f64, d: i8, e: str) -> u32 { a }\n';
  const index = classify.buildFileIndex(src, [], [], 'rust');
  const names = [...index.occurrences.keys()];
  for (const t of ['u32', 'usize', 'f64', 'i8', 'str']) {
    assert.ok(!names.includes(t), `${t} is a primitive type, not data`);
  }
});

// ── rust-analyzer's overloaded `const` ────────────────────────────────────────

/**
 * Real rust-analyzer output for `samples/sample.rs`, captured with a live cargo and
 * rustc on PATH so name resolution is complete. Unlike Python — where Pylance's
 * licence blocks any run outside Microsoft products — Rust ground truth is
 * obtainable, so these are captured rather than constructed.
 *
 * Regenerate with `scripts/ra_semtok.js` in the theme repo when the sample changes.
 * The freshness test below is what stops a stale fixture from quietly passing.
 */
function raTokens() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample.rs.tokens.json'), 'utf8'));
}

test('the rust-analyzer fixture is not stale', () => {
  // A stale fixture does not error — its offsets resolve to the WRONG characters,
  // so every downstream assertion tests nothing while still passing. This exact
  // failure mode cost a false 178-vs-59 reading in the flicker check once already.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const drift = raTokens().filter((t) => src.slice(t.offset, t.offset + t.length) !== t.name);
  assert.equal(drift.length, 0,
    `${drift.length} offsets no longer match sample.rs — regenerate the fixture`);
});

test('a Rust local tints at every use, declaration and body alike', () => {
  // A binding is `variable` at both its declaration and its uses (with a real
  // toolchain), so the occurrence map must hold ALL of them. An earlier draft of
  // this file believed uses came back as bare `const` — that was a degraded-mode
  // artifact of running rust-analyzer without cargo/rustc, corrected here.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const index = classify.buildFileIndex(src, raTokens(), [], 'rust');
  // `cfg`: declared once in load_config, read three more times (one via println!).
  const cfg = index.occurrences.get('cfg') ?? [];
  assert.ok(cfg.length >= 4, `cfg should have its declaration AND its reads, got ${cfg.length}`);
  // `acc`: the strongest case — declared once, read across the fold loop.
  const acc = index.occurrences.get('acc') ?? [];
  assert.ok(acc.length >= 5, `acc should trace through the loop, got ${acc.length}`);
});

test('a module const IS a traced data identity', () => {
  // A `const MAX_RETRIES: u32 = 3;` declared once at the top and read far away
  // inside functions is EXACTLY the identity the reader wants traced — the design
  // exempts it from the use-count floor (scopecolor `isTopLevel`). rust-analyzer
  // types it `const` at both declaration and use, and `const` is the ONE thing
  // that type ever means, so it is tintable. Regression guard for the "root-level
  // consts don't highlight" report; also the correction to an earlier draft that
  // skipped `const.declaration` to keep it band-1.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const occ = classify.buildFileIndex(src, raTokens(), [], 'rust').occurrences;
  assert.ok(occ.has('MAX_RETRIES'), 'a module const is a data identity');
  assert.ok(occ.has('DEFAULT_TIMEOUT'), 'a module const is a data identity');
});

test('Rust fields and methods stay band-1', () => {
  // `property` and `method` must not leak into band 2 now that `const` is accepted:
  // a field access is not a binding, and the theme already gives it member steel.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const index = classify.buildFileIndex(src, raTokens(), [], 'rust');
  const names = [...index.occurrences.keys()];
  for (const n of ['timeout', 'summary', 'with_retries', 'to_string', 'insert']) {
    assert.ok(!names.includes(n), `${n} is a field or method, not a data identity`);
  }
});

/**
 * Real rust-analyzer output for `samples/sample.rs` captured with the file OUTSIDE a
 * cargo workspace — no Cargo.toml anywhere above it, which is the situation for
 * every loose `.rs` file and for this sample as it actually sits in the repo.
 *
 * This capture is kept ALONGSIDE the in-workspace one because the two disagree, and
 * the disagreement is a bug source rather than a curiosity: detached, rust-analyzer
 * degrades a `self` USE and every local read to the semantic type `const`. A
 * semantic token overrides the grammar, so anything relying on the grammar's
 * `variable.language.self.rust` silently loses. The "self renders white" report was
 * only reproducible with this fixture — measuring inside a cargo project showed
 * `selfKeyword` and looked fine.
 */
function raDetachedTokens() {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures/sample.rs.detached.tokens.json'), 'utf8'));
}

test('the detached rust-analyzer fixture is not stale', () => {
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const drift = raDetachedTokens().filter((t) => src.slice(t.offset, t.offset + t.length) !== t.name);
  assert.equal(drift.length, 0, `${drift.length} offsets no longer match — regenerate`);
});

test('the detached fixture really does degrade self to `const`', () => {
  // Pins the PREMISE of the test below. If a future rust-analyzer stops degrading,
  // this fails and says so, rather than the guard silently testing nothing.
  const types = new Set(raDetachedTokens().filter((t) => t.name === 'self').map((t) => t.type));
  assert.ok(types.has('const'),
    `expected some self tokens typed const, saw: ${[...types].join(',')}`);
});

test('self is the self-slot outside a cargo workspace, where it degrades to const', () => {
  // The "self is still coloured default white on 54, 55, 67" report. Those are
  // exactly the `self` USES — the declarations on 37/53/60/66 kept `selfKeyword` and
  // looked right, which is why the bug read as "only some self are wrong".
  // `const` is tintable (module constants need it), so without the isSelfName skip
  // `self` would compete for a hue; and because `const` is unmapped in the theme with
  // no declared fallback scope, it rendered at editor.foreground — plain white.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const toks = raDetachedTokens();
  const fileIndex = classify.buildFileIndex(src, toks, [], 'rust');
  const occ = fileIndex.occurrences.get('self') ?? [];
  const lines = occ.map((r) => lineOf(src, r.start));
  for (const want of [54, 55, 67]) {
    assert.ok(lines.includes(want), `self on line ${want} must be tracked, got [${lines}]`);
  }
  // And it must classify as the SELF-SLOT, never a data hue.
  const impl = focus.scanBlocks(src, 'rust').find((b) => b.openLine === 52); // with_retries
  const c = classify.classifyFromSemantic(
    src, focus.lexRegionFor(src, impl), classify.enclosingFnOf([], impl.openOffset),
    [], toks, 1, focus.focusKeyOf(impl), undefined,
    focus.declRegionFor(src, impl), [], fileIndex, []);
  const selfInfo = c.byName.get('self');
  assert.ok(selfInfo && selfInfo.cls === 'self', 'self is the gold self-slot, not a data hue');
  // The control: a real local in the same block is still data, so the skip above is
  // not simply excluding everything.
  const retries = c.byName.get('retries');
  assert.ok(retries && retries.cls !== 'self', 'a real local is still data');
});

// ── macro arguments: no tokens until rust-analyzer expands the macro ──────────

test('a binding used only inside a macro call still traces there', () => {
  // A detached file gets no tokens for identifiers inside `println!(…)`, `write!(…)`
  // etc. So `cfg`, read only as `cfg.name` inside a println! in its loop, went dead
  // the moment the caret entered that loop; `label`, consumed solely by
  // `write!(f, "{}", label)`, never tinted. buildFileIndex lexes macro-arg regions
  // and extends KNOWN bindings into them.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const occ = classify.buildFileIndex(src, raTokens(), [], 'rust').occurrences;
  const macroLine = (name, needle) => {
    const ranges = occ.get(name) ?? [];
    const wantLine = src.split('\n').findIndex((l) => l.includes(needle)) + 1;
    return ranges.some((r) => lineOf(src, r.start) === wantLine);
  };
  assert.ok(macroLine('cfg', 'cfg.name, backoff'), 'cfg traces into the println! that reads it');
  assert.ok(macroLine('label', '"{}", label'), 'label traces into the write! that consumes it');
});

test('a macro-arg pass never invents an identity from a bare word', () => {
  // The safety rail: only names ALREADY known as data identities are extended into
  // macro args. A macro NAME, a type or a path segment sitting in the arguments must
  // not become a binding.
  const src = 'fn f() {\n  let x = 1;\n  println!("{}", SomeType::CONST + x);\n}\n';
  const toks = [
    { name: 'x', type: 'variable', modifiers: ['declaration'], offset: src.indexOf('x = 1'), length: 1 },
  ];
  const occ = classify.buildFileIndex(src, toks, [], 'rust').occurrences;
  assert.ok(occ.has('x'), 'the known local is present');
  assert.ok(occ.get('x').length >= 2, 'x traces into the macro (decl + use)');
  assert.ok(!occ.has('SomeType'), 'a type in a macro arg is not minted as data');
  assert.ok(!occ.has('CONST'), 'a path segment in a macro arg is not minted as data');
  assert.ok(!occ.has('println'), 'the macro name is not a data identity');
});

test('macroArgRanges: a `)` inside a format string does not close the span early', () => {
  // The scan skips strings, so the `)` in `"(backoff={}ms)"` must not end the
  // println! argument span before `backoff` after it.
  const src = 'fn f() {\n  let backoff = 1;\n  println!("attempt (backoff={}ms)", backoff);\n}\n';
  const toks = [
    { name: 'backoff', type: 'variable', modifiers: ['declaration'], offset: src.indexOf('backoff = 1'), length: 7 },
  ];
  const occ = classify.buildFileIndex(src, toks, [], 'rust').occurrences;
  assert.ok((occ.get('backoff') ?? []).length >= 2,
    'backoff after the paren-containing string still traces');
});

test('a macro call needs a bare name: after `.` or a digit it opens no argument region', () => {
  const src = 'fn f() {\n  let x = 1;\n  s.m!(x);\n  1m!(x);\n  m!(x);\n  n!\u3000[x];\n}\n';
  const toks = [{ name: 'x', type: 'variable', modifiers: ['declaration'], offset: src.indexOf('x = 1'), length: 1 }];
  const occ = classify.buildFileIndex(src, toks, [], 'rust').occurrences;
  assert.deepEqual(occ.get('x').map((r) => lineOf(src, r.start)), [2, 5, 6]);
  const { rustPlaceholderSpans } = require('../out/placeholders');
  const fmt = 'fn f() { s.println!("{}", a); println!("{} {}", a, b); }';
  assert.deepEqual(rustPlaceholderSpans(fmt).map((r) => r.start), [fmt.indexOf('"{} {}"') + 1, fmt.indexOf('"{} {}"') + 4]);
});

test('an attributed, wrapped fn keeps its parameters in scope', () => {
  for (const attrs of ['#[inline]\n#[cfg(test)]\n', '#[cfg_attr(feature = "x", derive(Debug))]\n#[inline]\n']) {
    const text = `${attrs}pub fn long_name(\n    a: u32,\n    b: u32,\n) -> u32 {\n    a + b\n}\n`;
    const block = focus.scanBlocks(text, 'rust').find((b) => b.depth === 0);
    assert.equal(focus.isFunctionHeader(text, block, 'rust'), true, attrs);
    assert.equal(focus.functionScopeOf(text, block, 'rust').start, text.indexOf('(', text.indexOf('long_name')), attrs);
  }
});

test('a braceless closure ends at a line comment, mid-file and at the end of the file', () => {
  const bodies = (text) => focus.scanBlocks(text, 'rust').filter((b) => text[b.openOffset] === '|').map((b) => text.slice(b.openOffset, b.closeOffset + 1));
  assert.deepEqual(bodies('fn f() {\n    let g = |x| x + 1 // tail\n    let y = 2;\n}\n'), ['|x| x + 1 // tail']);
  assert.deepEqual(bodies('fn f() {\n    let g = |x| x + 1 // tail'), ['|x| x + 1 // tail']);
});

// ── static content / data-format files get no focus ───────────────────────────

test('static content languages produce no focusable blocks', () => {
  // json/yaml/toml/kdl/css have braces and identifiers but no data flow — nothing
  // to trace — so the layer must stay in Survey and never tint. Returning no blocks
  // is the check: focusedBlock finds nothing, runClassify returns early.
  const cases = {
    json: '{ "a": { "b": 1 }, "c": [1, 2, 3] }',
    yaml: 'a:\n  b: 1\n  c: 2',
    toml: '[section]\nkey = "value"',
    css: '.selector { color: red; margin: 0; }',
    tailwindcss: '@layer base { .btn { @apply px-4; } }',
    xml: '<root><child a="1"/></root>',
    kdl: 'node "arg" key=1 {\n    child #true\n}',
  };
  for (const [lang, text] of Object.entries(cases)) {
    assert.equal(focus.scanBlocks(text, lang).length, 0, `${lang} must yield no blocks`);
    assert.equal(focus.isNonFlowLanguage(lang), true, `${lang} is a non-flow language`);
  }
  // HTML is markup around scripts: no script, no block (test/html.test.js).
  assert.equal(focus.scanBlocks('<div class="x"><span>{ a }</span></div>', 'html').length, 0, 'html without a script');
  // The control: a real code language still produces blocks.
  assert.ok(focus.scanBlocks('fn f() { let x = 1; }', 'rust').length > 0, 'rust still scans');
  assert.equal(focus.isNonFlowLanguage('rust'), false, 'rust is a flow language');
});

test('every static content id names the extension that registers it', () => {
  const { registered } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/static-languages.json'), 'utf8'));
  assert.deepEqual(focus.staticContentLanguages().sort(), Object.keys(registered).sort());
});

test('every config file VS Code opens gets a non-flow language id', () => {
  const { assigned } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/config-languages.json'), 'utf8'));
  for (const [file, id] of Object.entries(assigned)) assert.equal(focus.isNonFlowLanguage(id), true, `${file}: ${id}`);
});

// ── the scanner on the real sample ────────────────────────────────────────────

test('scanBlocks: the sample yields real nested scopes, not one file-sized block', () => {
  // The Python failure mode, guarded for Rust: if the scanner degrades, every
  // caret falls through to a synthetic module-level scope and the layer tints the
  // whole file at once.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const blocks = focus.scanBlocks(src, 'rust');
  assert.ok(blocks.length > 15, `expected many blocks, got ${blocks.length}`);
  const total = src.split('\n').length;
  const fileSized = blocks.filter((b) =>
    lineOf(src, b.closeOffset) - lineOf(src, b.openOffset) > total * 0.8);
  assert.equal(fileSized.length, 0, 'no block may span almost the whole file');
  assert.ok(blocks.some((b) => b.depth >= 2), 'nesting depth is tracked');
});

test('scanBlocks: a method body closes before the next method opens', () => {
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const blocks = focus.scanBlocks(src, 'rust');
  const [newFn] = blockAt(src, blocks, 'fn new(name: &str) -> Self');
  const [withRetries] = blockAt(src, blocks, 'fn with_retries(mut self');
  assert.ok(newFn.closeOffset < withRetries.openOffset,
    '`new` must end before `with_retries` starts');
  const [impl] = blockAt(src, blocks, 'impl Config {');
  assert.ok(impl.closeOffset > withRetries.closeOffset,
    'the impl block still spans both methods');
});

// ── match arms, closures and signatures ───────────────────────────────────────

const stub = require('./vscode-stub');
const vs = stub.install();
const { Classifier } = require('../out/classify-lsp');
const colors = require('../out/colors');
const traces = require('../out/traces');
const { rustPlaceholderSpans } = require('../out/placeholders');

/** Synthetic blocks the brace scanner did not produce, as their source text. */
function syntheticBlocks(src) {
  const braced = new Set(focus.scanBraceBlocks(src, 'rust').map((b) => b.openOffset));
  return focus.scanBlocks(src, 'rust').filter((b) => !braced.has(b.openOffset))
    .map((b) => src.slice(b.openOffset, b.closeOffset + 1));
}

test('a `Pat => expr,` match arm is not a scope', () => {
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const arms = syntheticBlocks(src).filter((t) => t.includes('=>'));
  assert.deepEqual(arms, [], 'no arrow scope in Rust');
  const caret = src.indexOf('"pending"');
  const b = focus.innermostBlock(focus.scanBlocks(src, 'rust'), lineOf(src, caret) - 1, caret, src);
  assert.ok(src.slice(b.headerStart, b.openOffset).includes('match self'), 'the caret focuses the whole match');
  // The arrow pass still runs for JS, and only there.
  assert.equal(focus.scanBlocks('xs.map(x => x + 1);\n', 'javascript').length, 1);
  assert.equal(focus.scanBlocks('var f = xs.Select(x => x + 1);\n', 'csharp').length, 0);
});

const ARMS = [
  'fn run(a: Result<u32, E>, b: Result<u32, E>) -> u32 {',
  '    let x = match a {',
  '        Ok(v) => {',
  '            v + v',
  '        }',
  '        Err(e) => 0,',
  '    };',
  '    let y = match b {',
  '        Ok(v) => {',
  '            v * 2',
  '        }',
  '        Err(e) => 1,',
  '    };',
  '    x + y',
  '}',
  '',
].join('\n');

test('a braced match arm owns its pattern bindings', async () => {
  const blocks = focus.scanBlocks(ARMS, 'rust');
  const arm = blocks.find((b) => ARMS.slice(b.headerStart, b.openOffset).includes('Ok(v) =>'));
  assert.equal(focus.isFunctionHeader(ARMS, arm, 'rust'), false, 'an arm is not a function');
  assert.equal(focus.functionScopeOf(ARMS, arm, 'rust'), null);
  assert.equal(focus.declRegionFor(ARMS, arm, 'rust').start, arm.headerStart, 'the pattern is inside the arm');

  // rust-analyzer-shaped tokens: parameters, and `variable [declaration]` at each binding.
  const toks = focus.lexIdentifiers(ARMS, 0, ARMS.length, 'rust')
    .filter((i) => ['a', 'b', 'v', 'e', 'x', 'y'].includes(i.name))
    .map((i) => {
      const before = ARMS.slice(ARMS.lastIndexOf('\n', i.offset) + 1, i.offset);
      const decl = /^fn run\(|Ok\($|Err\($|let $/.test(before);
      return { ...i, type: ['a', 'b'].includes(i.name) ? 'parameter' : 'variable', modifiers: decl ? ['declaration'] : [] };
    });
  stub.clearLspResponses();
  const doc = new stub.TextDocument(ARMS, 'rust', 'file:///arms.rs');
  const { legend, data } = stub.encodeTokens(ARMS, toks);
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': legend,
    'vscode.provideDocumentSemanticTokens': { data },
    'vscode.executeDocumentSymbolProvider': [{ kind: 11, name: 'run', range: new vs.Range(doc.positionAt(0), doc.positionAt(ARMS.length - 1)), children: [] }],
  });
  const r = await new Classifier().classifyScope(doc, arm, 5, { isCancellationRequested: false }, { text: ARMS, blocks });
  const plan = colors.planFromColoring(r.focused, r.coloring);
  const lines = traces.computeTraceRanges(r.focused, plan, focus.lexRegionFor(ARMS, arm, 'rust'))
    .filter((t) => t.name === 'v').flatMap((t) => t.ranges.map((x) => lineOf(ARMS, x.start)));
  assert.equal(r.focused.byName.get('v').cls, 'block');
  assert.deepEqual(lines, [3, 4, 4], 'the second match\'s `v` (lines 9-10) is another binding');
});

test('a braced closure is a function scope from its bars', () => {
  const src = 'fn f(v: Vec<u32>) {\n    v.iter().for_each(move |x| {\n        use_it(x);\n    });\n}\n';
  const clo = focus.scanBlocks(src, 'rust').find((b) => b.depth === 1);
  assert.equal(focus.isFunctionHeader(src, clo, 'rust'), true);
  const scope = focus.functionScopeOf(src, clo, 'rust');
  assert.equal(scope.start, src.indexOf('|x|'), 'the scope starts at the parameter bars, not `v.iter()`');
  assert.equal(focus.lexRegionFor(src, clo, 'rust').start, src.indexOf('|x|'));
  // `a || b {` is control flow, not a no-argument closure.
  const cond = 'fn f(a: bool, b: bool) {\n    if a || b {\n        go();\n    }\n}\n';
  const ifBlock = focus.scanBlocks(cond, 'rust').find((b) => b.depth === 1);
  assert.equal(focus.functionScopeOf(cond, ifBlock, 'rust'), null);
});

test('`move`, `return` and `=>` open a closure', () => {
  assert.deepEqual(syntheticBlocks('fn f() { v.iter().map(move |x| x + off).count(); }'), ['|x| x + off']);
  assert.deepEqual(syntheticBlocks('fn f() -> F { return |x| x + 1; }'), ['|x| x + 1']);
  assert.deepEqual(syntheticBlocks('fn f() { let g = match k { _ => |x| x * 2, }; }'), ['|x| x * 2']);
});

test('the parameters, not a tuple in the return type or a fn-pointer type', () => {
  const cases = [
    ['fn save(path: &str, data: &[u8]) -> Result<(), Error> {\n    write(path, data)\n}\n', '(path: &str'],
    ['fn apply(f: fn(i32) -> i32, x: i32) -> i32 {\n    f(x)\n}\n', '(f: fn(i32)'],
    ['fn g<F: Fn(i32) -> i32>(f: F) -> i32 {\n    f(1)\n}\n', '(f: F)'],
  ];
  for (const [src, want] of cases) {
    const b = focus.scanBlocks(src, 'rust')[0];
    assert.equal(focus.lexRegionFor(src, b, 'rust').start, src.indexOf(want), src.split('\n')[0]);
  }
});

test('a `where` clause with the brace on its own line keeps the parameters', () => {
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const blocks = focus.scanBlocks(src, 'rust');
  const fold = blocks.find((b) => src.slice(b.openOffset, b.openOffset + 30).includes('let mut acc'));
  assert.equal(src.slice(fold.headerStart, fold.openOffset), '', 'the `{` is alone on its line');
  assert.equal(focus.isFunctionHeader(src, fold, 'rust'), true);
  assert.equal(focus.lexRegionFor(src, fold, 'rust').start, src.indexOf('(cfgs: &[Config], seed: T'));
  assert.equal(focus.declRegionFor(src, fold, 'rust').start, fold.openOffset, 'parameters stay fn-scoped');
});

test('the top-level scope leaves out a Rust signature with a `-> T` return', () => {
  const src = 'const LIMIT: u32 = 3;\n\nfn save(path: &str) -> Result<(), Error> {\n    write(path, LIMIT)\n}\n';
  const ex = focus.topLevelExcludes(src, focus.scanBlocks(src, 'rust'), 'rust');
  const at = src.indexOf('path:');
  assert.ok(focus.inSortedRanges(ex, at), 'the parameter is not top-level code');
  assert.ok(!focus.inSortedRanges(ex, src.indexOf('LIMIT')), 'the module const is');
});

test('placeholders only in format strings', () => {
  const cases = [
    ['let v = serde_json::from_str("{\\"retries\\": 3}");', []],
    ['let v = from_str(r#"{"name": "x"}"#);', []],
    ['let re = Regex::new("^[a-z]{2,4}$");', []],
    ['println!("{count} of {}", n);', ['{count}', '{}']],
    ['write!(f, "{}", label)?;', ['{}']],
    ['assert_eq!(a, "{}", "got {a}");', ['{a}']],
    ['info!(target: "app", "retry {n}");', ['{n}']],
    ['#[error("bad header {0}")]\nstruct E(u8);', ['{0}']],
    ['let s = format!("{a}", a = format!("{b}"));', ['{a}', '{b}']],
  ];
  for (const [src, want] of cases) {
    assert.deepEqual(rustPlaceholderSpans(src).map((s) => src.slice(s.start, s.end)), want, src);
  }
});

test('a closure parameter keeps its uses when the enclosing function also binds the name', async () => {
  // `for c in &cfgs` in main, then `.map(|c| c.with_retries(5))`: real rust-analyzer tokens.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const { legend, data } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample.rs.lsp.json'), 'utf8'));
  stub.clearLspResponses();
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': legend,
    'vscode.provideDocumentSemanticTokens': { data },
    'vscode.executeDocumentSymbolProvider': [],
  });
  const doc = new stub.TextDocument(src, 'rust', 'file:///shadow.rs');
  const blocks = focus.scanBlocks(src, 'rust');
  const clo = blocks.find((b) => src.startsWith('|c| c.with_retries', b.openOffset));
  const r = await new Classifier().classifyScope(doc, clo, 5, { isCancellationRequested: false }, { text: src, blocks });
  const plan = colors.planFromColoring(r.focused, r.coloring);
  const c = traces.computeTraceRanges(r.focused, plan, focus.lexRegionFor(src, clo, 'rust')).find((t) => t.name === 'c');
  assert.ok(c, 'the closure parameter paints');
  assert.deepEqual(c.ranges.map((x) => src.slice(x.start, x.start + 16)), ['c| c.with_retrie', 'c.with_retries(5']);
});

// ── inline format args ────────────────────────────────────────────────────────

/** rust-analyzer-shaped tokens for `[name, type, modifiers, needle, nth]`, located by substring. */
function tokensAt(src, specs) {
  return specs.map(([name, type, modifiers, needle, nth = 0]) => {
    let at = -1;
    for (let k = 0; k <= nth; k++) at = src.indexOf(needle, at + 1);
    assert.ok(at >= 0, `no ${JSON.stringify(needle)} #${nth}`);
    return { name, type, modifiers, offset: at + needle.indexOf(name), length: name.length };
  });
}

async function paintedIn(src, toks, needle) {
  stub.clearLspResponses();
  const { legend, data } = stub.encodeTokens(src, toks);
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': legend,
    'vscode.provideDocumentSemanticTokens': { data },
    'vscode.executeDocumentSymbolProvider': [],
  });
  const doc = new stub.TextDocument(src, 'rust', `file:///fmt-${src.length}.rs`);
  const blocks = focus.scanBlocks(src, 'rust');
  const block = blocks.find((b) => src.slice(b.headerStart, b.openOffset + 1).includes(needle));
  const r = await new Classifier().classifyScope(doc, block, 5, { isCancellationRequested: false }, { text: src, blocks });
  const plan = colors.planFromColoring(r.focused, r.coloring);
  const out = new Map();
  for (const t of traces.computeTraceRanges(r.focused, plan, focus.lexRegionFor(src, block, 'rust'))) {
    out.set(t.name, t.ranges.map((x) => src.slice(x.start, x.end) + '@' + lineOf(src, x.start)));
  }
  return { focused: r.focused, out };
}

test('an inline format arg is a use: a local read only as `{label}` still tints', async () => {
  // The tokens rust-analyzer 0.3.3105 sent in VS Code 1.144.1 for this shape. The
  // capture is a `variable` inside the string span; the lexer's identifiers skip
  // strings, so the block counted one use of `label` and the use-count floor
  // dropped it, while `write!(f, "{}", label)` tinted.
  const src = [
    'impl fmt::Display for Status {',
    "    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {",
    '        let label = match self {',
    '            Status::A => "a",',
    '            _ => "b",',
    '        };',
    '        write!(f, "{label}")',
    '    }',
    '}',
    '',
  ].join('\n');
  const toks = tokensAt(src, [
    ['f', 'parameter', ['declaration', 'mutable', 'reference'], 'f: &mut'],
    ['label', 'variable', ['declaration', 'reference'], 'let label'],
    ['f', 'parameter', ['macro', 'mutable', 'reference'], 'write!(f'],
    ['label', 'variable', [], '{label}'],
  ]);
  const { focused, out } = await paintedIn(src, toks, 'fn fmt(');
  assert.equal(focused.byName.get('label').freqInBlock, 2);
  assert.deepEqual(out.get('label'), ['label@3', 'label@7']);
});

test('a name a nested block reads only through an inline format arg is in that block', async () => {
  const src = [
    'fn show(n: u32, m: u32) {',
    '    if m > 0 {',
    '        println!("{n} {n:>4}");',
    '    }',
    '    println!("{}", m);',
    '}',
    '',
  ].join('\n');
  const toks = tokensAt(src, [
    ['n', 'parameter', ['declaration'], 'n: u32'],
    ['m', 'parameter', ['declaration'], 'm: u32'],
    ['m', 'parameter', [], 'm > 0'],
    ['n', 'parameter', [], '{n}'],
    ['n', 'parameter', [], '{n:>4}'],
    ['m', 'parameter', [], ', m)'],
  ]);
  const { focused, out } = await paintedIn(src, toks, 'if m > 0');
  assert.equal(focused.byName.get('n').cls, 'fn');
  assert.equal(focused.byName.get('n').freqInBlock, 2);
  assert.deepEqual(out.get('n'), ['n@1', 'n@3', 'n@3']);
});

test('without a capture token the lexer finds `{label}`: a detached file still tints it', async () => {
  // A file outside any cargo package, and a package whose workspace is still
  // loading, get one `string` token over the literal (rust-analyzer 0.3.3105):
  // no macro expansion, so no token for the capture.
  const src = [
    'fn show(cfg: u32) -> String {',
    '    let label = cfg + 1;',
    '    format!("{label}")',
    '}',
    '',
  ].join('\n');
  const toks = tokensAt(src, [
    ['cfg', 'parameter', ['declaration'], 'cfg: u32'],
    ['label', 'variable', ['declaration'], 'let label'],
    ['cfg', 'parameter', [], 'cfg + 1'],
    ['"{label}"', 'string', [], '"{label}"'],
  ]);
  const { focused, out } = await paintedIn(src, toks, 'fn show(');
  assert.equal(focused.byName.get('label').freqInBlock, 2);
  assert.deepEqual(out.get('label'), ['label@2', 'label@3']);
});

test('the lexical inline-arg pass extends known bindings only, once per capture', () => {
  const src = 'fn f(x: u32) {\n    let w = 4;\n    println!("{x} {x:>w$} {ghost} {name}", name = x);\n}\n';
  const line3 = src.indexOf('println!');
  const toks = [
    { name: 'x', type: 'parameter', modifiers: ['declaration'], offset: src.indexOf('x: u32'), length: 1 },
    { name: 'w', type: 'variable', modifiers: ['declaration'], offset: src.indexOf('w = 4'), length: 1 },
    { name: 'x', type: 'parameter', modifiers: [], offset: src.indexOf('{x}') + 1, length: 1 },
  ];
  const idx = classify.buildFileIndex(src, toks, [], 'rust');
  const at = (name) => (idx.occurrences.get(name) ?? []).map((r) => r.start - line3);
  assert.deepEqual(at('x'), [src.indexOf('x: u32') - line3, 11, 15, src.indexOf('= x);') + 2 - line3],
    'the typed `{x}` once, `{x:>w$}` lexed, the named argument value as a macro arg');
  assert.deepEqual(at('w'), [src.indexOf('w = 4') - line3, 18]);
  assert.ok(!idx.occurrences.has('ghost'), 'an unknown name is never minted');
  assert.ok(!idx.occurrences.has('name'), 'a named argument is not a capture');
  assert.deepEqual(idx.stringReads.map((r) => r.offset - line3), [11, 15, 18]);
});

test('a macro argument the server typed is one occurrence, as the lexer would add it', () => {
  // rust-analyzer 0.3.3105 with a loaded workspace types `f` in `write!(f, …)` as
  // `parameter [macro, mutable, reference]`; the lexical pass added it again.
  const src = [
    "fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {",
    '    write!(f, "{}", 1)',
    '}',
    '',
  ].join('\n');
  const decl = { name: 'f', type: 'parameter', modifiers: ['declaration', 'mutable', 'reference'], offset: src.indexOf('f: &mut'), length: 1 };
  const use = { name: 'f', type: 'parameter', modifiers: ['macro', 'mutable', 'reference'], offset: src.indexOf('write!(f') + 7, length: 1 };
  const starts = (toks) => classify.buildFileIndex(src, toks, [], 'rust').occurrences.get('f').map((r) => r.start);
  assert.deepEqual(starts([decl, use]), [decl.offset, use.offset], 'typed: once');
  assert.deepEqual(starts([decl]), [decl.offset, use.offset], 'untyped: the lexer adds the same position');

  // Real replies for one file: detached (no macro tokens) and a loaded cargo workspace.
  const paths = fs.readFileSync(path.join(__dirname, 'fixtures/rust-paths.rs'), 'utf8');
  const caps = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/rust-paths.tokens.json'), 'utf8'));
  assert.ok(caps.cargo.some((t) => t.name === 'label' && t.modifiers.includes('macro')), 'sanity: the loaded reply types a macro argument');
  const occ = (cap) => classify.buildFileIndex(paths, caps[cap], [], 'rust').occurrences;
  for (const cap of ['detached', 'cargo']) {
    for (const [name, ranges] of occ(cap)) {
      const s = ranges.map((r) => r.start);
      assert.equal(new Set(s).size, s.length, `${cap}: ${name} at ${s.join(',')}`);
    }
  }
  for (const name of ['label', 'c']) {
    assert.deepEqual(occ('cargo').get(name), occ('detached').get(name), `${name}: the same occurrences either way`);
  }
});

test('rustInlineArgs: captures and count args in format strings only', () => {
  const { rustInlineArgs } = require('../out/placeholders');
  const src = [
    'fn f() {',
    '    write!(f, "{label} {} {0} {{lit}} {_} {v:>w$.p$} {name}", 1, name = 2);',
    '    let s = "{nope}";',
    '    println!(r#"{raw}"#);',
    '}',
    '#[error("bad {field}")]',
    'struct E;',
    '',
  ].join('\n');
  assert.deepEqual(rustInlineArgs(src).map((c) => [c.name, src.slice(c.offset, c.offset + c.length)]),
    [['label', 'label'], ['v', 'v'], ['w', 'w'], ['p', 'p'], ['raw', 'raw']]);
});
