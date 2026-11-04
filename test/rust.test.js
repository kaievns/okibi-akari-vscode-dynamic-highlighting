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
    assert.equal(focus.isFunctionHeader(src, block), true,
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
  const braced = new Set(focus.scanBraceBlocks(src).map((b) => b.openOffset));
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
  const blocks = focus.scanBraceBlocks(src);
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
  const braced = new Set(focus.scanBraceBlocks(src).map((b) => b.openOffset));
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
  const braced = new Set(focus.scanBraceBlocks(src).map((b) => b.openOffset));
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
  const braced = new Set(focus.scanBraceBlocks(src).map((b) => b.openOffset));
  const extra = focus.scanBlocks(src, 'rust').filter((b) => !braced.has(b.openOffset));
  assert.equal(extra.length, 0,
    `no closures here, got: ${extra.map((b) => JSON.stringify(src.slice(b.openOffset, b.closeOffset + 1))).join(' | ')}`);
});

test('isFunctionHeader: a closure block IS a function header', () => {
  // A closure's parameters are its own bindings. The block starts ON the opening
  // `|`, so headerStart === openOffset and the header slice is EMPTY — the same
  // synthetic-block case Python lambdas needed an explicit branch for.
  const src = 'fn f(v: &[u32]) {\n    v.iter().map(|x| x + 1).count();\n}\n';
  const braced = new Set(focus.scanBraceBlocks(src).map((b) => b.openOffset));
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
  const index = classify.buildFileIndex(src, [tok('y'), tok('z')], []);
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
  const index = classify.buildFileIndex(src, [], []);
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
  // failure mode cost a false 178-vs-59 reading in the flicker gate once already.
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
  const index = classify.buildFileIndex(src, raTokens(), []);
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
  const occ = classify.buildFileIndex(src, raTokens(), []).occurrences;
  assert.ok(occ.has('MAX_RETRIES'), 'a module const is a data identity');
  assert.ok(occ.has('DEFAULT_TIMEOUT'), 'a module const is a data identity');
});

test('Rust fields and methods stay band-1', () => {
  // `property` and `method` must not leak into band 2 now that `const` is accepted:
  // a field access is not a binding, and the theme already gives it member steel.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const index = classify.buildFileIndex(src, raTokens(), []);
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
  const fileIndex = classify.buildFileIndex(src, toks, []);
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

// ── macro arguments are a semantic-token desert ───────────────────────────────

test('a binding used only inside a macro call still traces there', () => {
  // rust-analyzer emits NO tokens for identifiers inside `println!(…)`, `write!(…)`
  // etc. So `cfg`, read only as `cfg.name` inside a println! in its loop, went dead
  // the moment the caret entered that loop; `label`, consumed solely by
  // `write!(f, "{}", label)`, never tinted. buildFileIndex lexes macro-arg regions
  // and extends KNOWN bindings into them.
  const src = fs.readFileSync(SAMPLE, 'utf8');
  const occ = classify.buildFileIndex(src, raTokens(), []).occurrences;
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
  const occ = classify.buildFileIndex(src, toks, []).occurrences;
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
  const occ = classify.buildFileIndex(src, toks, []).occurrences;
  assert.ok((occ.get('backoff') ?? []).length >= 2,
    'backoff after the paren-containing string still traces');
});

// ── static content / data-format files get no focus ───────────────────────────

test('static content languages produce no focusable blocks', () => {
  // json/yaml/toml/html/css have braces and identifiers but no data flow — nothing
  // to trace — so the layer must stay in Survey and never tint. Returning no blocks
  // is the gate: focusedBlock finds nothing, runClassify returns early.
  const cases = {
    json: '{ "a": { "b": 1 }, "c": [1, 2, 3] }',
    yaml: 'a:\n  b: 1\n  c: 2',
    toml: '[section]\nkey = "value"',
    html: '<div class="x"><span>hi</span></div>',
    css: '.selector { color: red; margin: 0; }',
    xml: '<root><child a="1"/></root>',
  };
  for (const [lang, text] of Object.entries(cases)) {
    assert.equal(focus.scanBlocks(text, lang).length, 0, `${lang} must yield no blocks`);
    assert.equal(focus.isNonFlowLanguage(lang), true, `${lang} is a non-flow language`);
  }
  // The control: a real code language still produces blocks.
  assert.ok(focus.scanBlocks('fn f() { let x = 1; }', 'rust').length > 0, 'rust still scans');
  assert.equal(focus.isNonFlowLanguage('rust'), false, 'rust is a flow language');
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
