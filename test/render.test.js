'use strict';
// RENDER-PATH tests: what is actually painted, per phase, per language.
//
// This file exists because of a specific gap. Every bug in this layer that had to be
// reported twice — `self` rendering correctly then flashing white on relaxation to
// Survey, Rust format placeholders staying string green — lived in the render path,
// and the render path had NO coverage at all: `decorator.ts` imports `vscode`, which
// only exists inside an editor host, so the suite tested the pure modules (focus,
// classify, colors) and stopped at the boundary. Those modules were right. The thing
// on screen was wrong. The tests passed.
//
// `test/vscode-stub.js` closes that gap: it fakes just enough of the API for the real
// Decorator to be constructed and driven, and records what `setDecorations` receives.
// That turns the question these bugs actually turned on — *which decoration types
// carry ranges, in which phase?* — into an assertion.
//
// The distinction that matters throughout: a BAND-1 mark (self, format placeholders,
// markdown washes) is the resting register and must be phase-INDEPENDENT — identical
// in Survey, Focus and Edit. A BAND-2/3 mark (identity tints, risk) is phase-gated
// and must be withdrawn in Survey. Getting that backwards is what produced the
// flicker, and it is what these tests pin.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
// Required AFTER install(), so `require('vscode')` inside them resolves to the stub.
const { Decorator } = require('../out/decorator');

const SAMPLES = path.join(__dirname, '../samples');

/**
 * Drive the real Decorator over a document and report what is painted.
 *
 * Returns a `paint(phase)` function: it sets the phase, renders, and returns a live
 * view of the decoration state. `live` mirrors what the editor holds rather than what
 * the last call passed, because `applyType` has a dirty-check — re-applying identical
 * ranges is a no-op, so observing only the most recent `setDecorations` call would
 * read "0 ranges" for anything that correctly did not change. That subtlety cost a
 * false failure while writing these tests.
 */
function harness(text, languageId, line = 0, character = 0) {
  const doc = new stub.TextDocument(text, languageId, `file:///t.${languageId}`);
  const ed = new stub.TextEditor(doc, line, character);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];

  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);

  const d = new Decorator();
  return {
    decorator: d,
    doc,
    editor: ed,
    paint(phase) {
      d.machine.phase = phase;
      d.render();
      return {
        count: (type) => (live.get(type) ?? []).length,
        ranges: (type) => live.get(type) ?? [],
        pool: d.pool,
      };
    },
  };
}

const PHASES = ['survey', 'focus', 'edit'];

// ── band 1 is phase-independent ───────────────────────────────────────────────

test('self is painted identically in every phase, and survives relaxation', () => {
  // The reported bug, verbatim: "self renders correctly initially, then switches to
  // blank white during survey and back to proper slate during focus". `self` was
  // painted inside renderBand2 and cleared by clearBand2, so it followed the phase —
  // but what it corrects does not. Outside a cargo workspace rust-analyzer types a
  // `self` USE as `const`, a semantic token that outranks the grammar, so band 1
  // cannot hold the colour on its own and the mark has to persist.
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const h = harness(src, 'rust', 53, 10);

  const counts = PHASES.map((p) => h.paint(p).count(h.decorator.pool.self));
  assert.ok(counts[0] > 0, `self must paint in Survey, got ${counts[0]}`);
  assert.deepEqual(new Set(counts).size, 1,
    `self must be identical in every phase, got survey/focus/edit = ${counts.join('/')}`);

  // And the full round trip, which is the sequence the user described.
  const round = ['focus', 'survey', 'focus'].map((p) => h.paint(p).count(h.decorator.pool.self));
  assert.deepEqual(new Set(round).size, 1, `self must survive focus→survey→focus, got ${round.join('/')}`);
});

test('self covers every occurrence in the file, not just the focused block', () => {
  // It was previously clipped to the focused block, so a `self` elsewhere in the file
  // was unpainted and fell back to whatever the semantic layer said.
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const h = harness(src, 'rust', 53, 10);
  const painted = h.paint('focus').ranges(h.decorator.pool.self);
  // Counted through the lexer, not a regex over the raw text: the sample mentions
  // `self` four times inside COMMENTS, and those must not be painted. A regex count
  // fails for the right reason and the wrong cause — it took a detour to confirm the
  // four were comments and not a gap.
  const { lexIdentifiers } = require('../out/focus');
  const inCode = lexIdentifiers(src).filter((i) => i.name === 'self' || i.name === 'this').length;
  assert.equal(painted.length, inCode,
    `expected ${inCode} self marks (code only, comments excluded), got ${painted.length}`);
  assert.ok(inCode >= 10, 'sanity: the sample really does use self');
  // Spot-check the three lines from the report (1-based 54, 55, 67 → 0-based 53,54,66).
  const lines = new Set(painted.map((r) => r.start.line));
  for (const want of [53, 54, 66]) {
    assert.ok(lines.has(want), `self on 0-based line ${want} must be painted`);
  }
});

test('rust format placeholders are painted, in every phase', () => {
  // The other reported bug: "placeholders are fixed in go and python, but not rust".
  // The theme's `meta.interpolation.rust` rule is correct and does select them — but
  // rust-analyzer emits ONE `string` semantic token spanning the whole literal, and a
  // semantic token overrides TextMate across its entire span. No theme rule can win
  // that; a decoration renders above both layers.
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const h = harness(src, 'rust', 83, 10);
  const counts = PHASES.map((p) => h.paint(p).count(h.decorator.pool.placeholder));
  assert.ok(counts[0] > 5, `placeholders must paint in Survey, got ${counts[0]}`);
  assert.equal(new Set(counts).size, 1,
    `placeholders must be identical in every phase, got ${counts.join('/')}`);
});

test('placeholders are NOT painted by the layer in go/python/ts', () => {
  // Those grammars scope a placeholder distinctly and the theme reaches it, so the
  // decoration would be redundant work on every caret move. This asserts the layer
  // stays out of the theme's way — the parity of the COLOUR is the theme's gate
  // (scripts/placeholder_parity.js).
  for (const [lang, text] of [
    ['go', 'package main\nfunc main() { println("a %d b") }\n'],
    ['python', 'n = 1\nprint("a %d b" % n)\n'],
    ['typescript', 'const n = 1;\nconsole.log(`a ${n} b`);\n'],
  ]) {
    const h = harness(text, lang, 1, 5);
    assert.equal(h.paint('focus').count(h.decorator.pool.placeholder), 0,
      `${lang} placeholders are the theme's job, not the layer's`);
  }
});

// ── band 2/3 remain phase-gated ───────────────────────────────────────────────

test('band 2 identity tints ARE withdrawn in Survey', () => {
  // The control for the tests above. If a fix for band-1 persistence accidentally
  // made the phase bands persistent too, the layer would never be calm at rest —
  // which is the whole point of Survey.
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const h = harness(src, 'rust', 82, 12);
  const tintCount = (snap) => h.decorator.pool.id.reduce((n, t) => n + snap.count(t), 0)
    + h.decorator.pool.idg.reduce((n, t) => n + snap.count(t), 0);
  h.paint('focus');
  const survey = tintCount(h.paint('survey'));
  assert.equal(survey, 0, `Survey must carry no identity tints, got ${survey}`);
});

test('band 3 risk marks are withdrawn outside Edit', () => {
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const h = harness(src, 'rust', 82, 12);
  const riskCount = (snap) => snap.count(h.decorator.pool.riskAsync)
    + snap.count(h.decorator.pool.riskDanger) + snap.count(h.decorator.pool.riskEscape);
  h.paint('edit');
  assert.equal(riskCount(h.paint('survey')), 0, 'Survey carries no risk marks');
  assert.equal(riskCount(h.paint('focus')), 0, 'Focus carries no risk marks');
});

// ── static content and prose never paint ──────────────────────────────────────

test('static content and prose files paint nothing in any phase', () => {
  // The gate the user asked for, verified through the REAL render path rather than by
  // checking that scanBlocks returns []. A JSON file has braces and identifiers, so
  // the block scanner would happily find scopes in it.
  const cases = {
    json: '{ "name": "x", "nested": { "a": 1 } }',
    yaml: 'name: x\nnested:\n  a: 1',
    toml: '[section]\nname = "x"',
    html: '<div class="a"><span>hi</span></div>',
    css: '.a { color: red; }',
    markdown: '# Title\n\nSome prose with `code` in it.\n',
  };
  for (const [lang, text] of Object.entries(cases)) {
    const h = harness(text, lang, 0, 2);
    for (const phase of PHASES) {
      const snap = h.paint(phase);
      const banded = h.decorator.pool.banded().reduce((n, t) => n + snap.count(t), 0);
      assert.equal(banded, 0, `${lang} must paint no phase bands in ${phase}, got ${banded}`);
    }
  }
});

// ── the decoration pool's band split ──────────────────────────────────────────

test('the pool puts phase marks in banded() and band-1 marks outside it', () => {
  // `clearAllVisible(false)` withdraws exactly `banded()` when focus leaves the
  // editor. A band-1 mark in that set would blink whenever the caret moved to a
  // panel — and, for `self`, would also be cleared by clearBand2 on every relaxation
  // to Survey. That membership IS the bug, so it is asserted directly.
  const h = harness('fn f() {}\n', 'rust');
  const pool = h.decorator.pool;
  assert.ok(!pool.banded().includes(pool.self), 'self is band 1, not a phase band');
  assert.ok(!pool.banded().includes(pool.placeholder), 'placeholders are band 1');
  assert.ok(pool.all().includes(pool.self), 'self is still cleared when the layer is switched off');
  assert.ok(pool.all().includes(pool.placeholder), 'placeholders too');
  // The controls: these ARE phase bands.
  assert.ok(pool.banded().includes(pool.id[0]), 'identity tints are phase bands');
  assert.ok(pool.banded().includes(pool.riskEscape), 'risk marks are phase bands');
});

// ── the Rust placeholder scanner ──────────────────────────────────────────────

const { rustPlaceholderSpans } = require('../out/placeholders');

test('rustPlaceholderSpans: finds holes, skips escapes and non-strings', () => {
  const cases = [
    // [source, expected placeholder texts]
    ['println!("{} and {}", a, b);', ['{}', '{}']],
    ['println!("{name} {n:>8} {0:.2}", n);', ['{name}', '{n:>8}', '{0:.2}']],
    // `{{` / `}}` are ESCAPED literal braces, not placeholders.
    ['println!("100{{}} done");', []],
    ['println!("{{literal}} but {} real", x);', ['{}']],
    // A brace OUTSIDE a string is a block brace.
    ['fn f() { let x = 1; }', []],
    // A brace in a comment is prose.
    ['// a {} in a comment\nfn f() {}', []],
    ['/* block {} comment */', []],
    // A lifetime must not open a char literal and swallow the file.
    ["fn f<'a>(x: &'a str) { println!(\"{}\", x); }", ['{}']],
    // A char literal is not a string.
    ["fn f() { let c = '{'; println!(\"{}\", c); }", ['{}']],
    // A raw string is still a format string.
    ['println!(r"{} raw", x);', ['{}']],
    ['println!(r#"{} hashed"#, x);', ['{}']],
    // An unclosed brace is not a placeholder.
    ['println!("{ unclosed", x);', []],
  ];
  for (const [src, want] of cases) {
    const got = rustPlaceholderSpans(src).map((s) => src.slice(s.start, s.end));
    assert.deepEqual(got, want, `for ${JSON.stringify(src)}`);
  }
});

test('rustPlaceholderSpans: covers every placeholder in the real sample', () => {
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const spans = rustPlaceholderSpans(src);
  // Each span must actually be a `{…}` in the source — a drifted offset would slice
  // mid-token and still "pass" a count check, the stale-fixture failure mode.
  for (const s of spans) {
    const text = src.slice(s.start, s.end);
    assert.match(text, /^\{[^{}]*\}$/, `span ${s.start}-${s.end} is not a placeholder: ${JSON.stringify(text)}`);
  }
  assert.ok(spans.length >= 12, `expected the sample's format strings, got ${spans.length}`);
});

// ── the FULL async lifecycle, not just a synchronous render() ─────────────────
//
// The tests above call `render()` directly, which was not enough: the user reported
// both marks "blinking multiple times back and forth" and then settling WRONG, and
// those tests stayed green. A direct `render()` skips the real sequence — refresh →
// onSelection → debounced classify → repaint, plus the relax timer — and it skips the
// language-server round trip entirely, because the stub returned nothing so
// `runClassify` bailed before ever repainting. These drive the real path with real
// rust-analyzer tokens served through the stub.

const lspFixture = () => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/sample.rs.lsp.json'), 'utf8'));

/** Install the canned rust-analyzer responses for `sample.rs`. */
function serveRustLsp() {
  const lsp = lspFixture();
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': lsp.legend,
    'vscode.provideDocumentSemanticTokens': { data: lsp.data },
    'vscode.executeDocumentSymbolProvider': [],
  });
}

const settle = () => new Promise((r) => setTimeout(r, 250));

test('self and placeholders never blink across the real open→focus→relax lifecycle', async () => {
  // Records EVERY setDecorations call, so a value that flaps and settles wrong is
  // visible as a sequence rather than just a final state. "Blinking" is precisely a
  // sequence the end-state check cannot see.
  serveRustLsp();
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const doc = new stub.TextDocument(src, 'rust', 'file:///lifecycle.rs');
  const ed = new stub.TextEditor(doc, 53, 10);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];

  const d = new Decorator();
  const selfSeq = [];
  const phSeq = [];
  ed.setDecorations = (type, ranges) => {
    if (type === d.pool.self) selfSeq.push(ranges.length);
    if (type === d.pool.placeholder) phSeq.push(ranges.length);
  };

  d.refresh();                                                     // file opens
  await settle();
  d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 }); // user clicks
  await settle();
  d.machine.phase = 'survey';                                      // focus times out
  d.onRelaxTick();
  await settle();
  d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 }); // clicks again
  await settle();

  // Every value ever applied must be the same non-zero count: no 0 in the sequence
  // (that is the blink) and no drift (that is the settle-wrong).
  assert.ok(selfSeq.length > 0, 'self must be painted at least once');
  assert.deepEqual([...new Set(selfSeq)], [selfSeq[0]],
    `self flapped across the lifecycle: ${selfSeq.join(' → ')}`);
  assert.ok(selfSeq[0] > 0, 'self must not settle at zero ranges');

  assert.ok(phSeq.length > 0, 'placeholders must be painted at least once');
  assert.deepEqual([...new Set(phSeq)], [phSeq[0]],
    `placeholders flapped across the lifecycle: ${phSeq.join(' → ')}`);
  assert.ok(phSeq[0] > 0, 'placeholders must not settle at zero ranges');
});

test('a completed classification does not disturb the band-1 marks', async () => {
  // The specific mechanism behind "blinks then ends up wrong": runClassify resolves
  // asynchronously and repaints. If that repaint took a path that skipped or cleared
  // the band-1 marks, the mark would appear on first render and vanish once the
  // server answered — which looks exactly like a blink that settles wrong.
  serveRustLsp();
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const doc = new stub.TextDocument(src, 'rust', 'file:///afterclassify.rs');
  const ed = new stub.TextEditor(doc, 82, 12);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];

  const d = new Decorator();
  const live = new Map();
  ed.setDecorations = (t, r) => live.set(t, r);

  d.refresh();
  await settle();
  const beforeSelf = (live.get(d.pool.self) ?? []).length;
  const beforePh = (live.get(d.pool.placeholder) ?? []).length;

  // Engage and let the classify complete, which is what repaints band 2.
  d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 });
  await settle();

  assert.equal((live.get(d.pool.self) ?? []).length, beforeSelf,
    'a completed classification must not change the self marks');
  assert.equal((live.get(d.pool.placeholder) ?? []).length, beforePh,
    'a completed classification must not change the placeholder marks');
  assert.ok(beforeSelf > 0 && beforePh > 0, 'and both must actually be painted');
});
