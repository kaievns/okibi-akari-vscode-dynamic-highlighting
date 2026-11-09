'use strict';
// Band-3 escape marks (risk.ts escapeRisk). Rules: docs/risk-marks.md.
//
// The corpus goldens run the real Classifier over every block of each file, the
// way the decorator does, and list each mark with the blocks whose focus shows it.
// Tokens in test/fixtures/escape/:
//   corpus.ts   real TS service    node test/gen-ts-semtok.js test/fixtures/escape/corpus.ts
//   corpus.go   real gopls         ~/go/bin/gopls semtok corpus.go | node test/gen-go-semtok.js corpus.go
//   multi.go    real gopls         (both inside a throwaway `go mod init` module)
//   corpus.rs   real rust-analyzer in a cargo project (scripts/ra_semtok.js in the theme repo)
//   corpus.py   Pylance-shaped     python3 -I test/gen-py-semtok.py corpus.py 1   (and `0` → first-decl)
//   multi.py    Pylance-shaped     python3 -I test/gen-py-semtok.py multi.py 1
//   visibility.ts  real TS service (as corpus.ts); visibility.go  real gopls (as corpus.go)
//   branches.py Pylance-shaped     python3 -I test/gen-py-semtok.py branches.py 1   (and `0` → first-decl)
// Pylance cannot run outside VS Code, so the Python shape is constructed; both
// declaration shapes must give the same marks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
const { Classifier } = require('../out/classify-lsp');
const classify = require('../out/classify');
const focus = require('../out/focus');
const risk = require('../out/risk');
const tokens = require('../out/tokens');

const FIX = path.join(__dirname, 'fixtures/escape');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const json = (f) => JSON.parse(read(f));

/** Decoded tokens → the LSP delta wire format the extension decodes. */
function encode(text, toks) {
  const types = [...new Set(toks.map((t) => t.type))];
  const mods = [...new Set(toks.flatMap((t) => t.modifiers))];
  const starts = classify.lineStartOffsets(text);
  const lineOf = (o) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (starts[m] <= o) lo = m;
      else hi = m - 1;
    }
    return lo;
  };
  const data = [];
  let pl = 0;
  let pc = 0;
  for (const t of [...toks].sort((a, b) => a.offset - b.offset)) {
    const l = lineOf(t.offset);
    const c = t.offset - starts[l];
    data.push(l - pl, l === pl ? c - pc : c, t.length, types.indexOf(t.type), t.modifiers.reduce((b, m) => b | (1 << mods.indexOf(m)), 0));
    pl = l;
    pc = c;
  }
  return { legend: { tokenTypes: types, tokenModifiers: mods }, data };
}

/** Function-like blocks as DocumentSymbols, standing in for the server's symbol provider. */
function functionSymbols(doc, text, blocks, lang) {
  const CTRL = /^\s*(\}\s*)?(if|else|for|while|switch|do|try|catch|finally|match|loop|select|case|with|elif|except|unsafe|when)\b/;
  const out = [];
  for (const b of blocks) {
    const hdr = text.slice(b.headerStart, b.openOffset);
    let p = b.openOffset - 1;
    while (p >= 0 && /\s/.test(text[p])) p--;
    const isFn = lang === 'python'
      ? /^\s*(async\s+)?def\b/.test(hdr)
      : focus.isFunctionHeader(text, b) && !CTRL.test(hdr) && !/[,(=:]/.test(text[p] || '');
    if (isFn) {
      out.push({ kind: 11, name: 'f', range: new vs.Range(doc.positionAt(b.headerStart), doc.positionAt(b.closeOffset + 1)), children: [] });
    }
  }
  return out;
}

/** Every escape mark in the file as `line:col text @focused-block-lines`. */
async function escapeMarks(text, lang, served) {
  stub.clearLspResponses();
  const doc = new stub.TextDocument(text, lang, `file:///escape-${lang}-${Math.random()}`);
  const blocks = focus.scanBlocks(text, lang);
  if (served) {
    stub.setLspResponses({
      'vscode.provideDocumentSemanticTokensLegend': served.legend,
      'vscode.provideDocumentSemanticTokens': { data: served.data },
    });
  }
  stub.setLspResponses({ 'vscode.executeDocumentSymbolProvider': functionSymbols(doc, text, blocks, lang) });
  const classifier = new Classifier();
  const marks = new Map();
  for (const b of [...blocks, focus.topLevelBlock(text)]) {
    const r = await classifier.classifyScope(doc, b, 5, { isCancellationRequested: false }, { text, blocks });
    for (const e of risk.escapeRisk(text, focus.lexRegionFor(text, b), r.focused, lang)) {
      const p = doc.positionAt(e.start);
      const m = marks.get(e.start) ?? { at: `${p.line + 1}:${p.character + 1} ${text.slice(e.start, e.end)}`, blocks: [] };
      m.blocks.push(b.depth === -1 ? 'top' : b.openLine + 1);
      marks.set(e.start, m);
    }
  }
  const order = (x) => (x === 'top' ? Infinity : x);
  return [...marks.entries()].sort((a, b) => a[0] - b[0])
    .map(([, m]) => `${m.at} @${m.blocks.sort((a, b) => order(a) - order(b)).join(',')}`);
}

const decoded = (f) => (text) => encode(text, json(f));
const raw = (f) => () => json(f);

const CORPORA = [
  ['corpus.ts', 'typescript', decoded('corpus.ts.tokens.json'), [
    '19:5 total @18', // write to the function's `total` from inside the loop
    '26:5 count @24,25',
    '27:5 total @24,25',
    '29:3 count @24',
    '40:5 this.count @32,39', // a method, not the constructor
    '42:5 opts.limit @39', // mutating the caller's object through a parameter
    '50:5 retries @49', // own parameter, written from a nested block
    '72:5 flags @71',
    '73:5 count @69,71', // ??=
    '74:5 total @69,71', // ||=
    '75:5 bits @69,71', // >>>=
    '76:5 xs @69,71', // subscript write through a parameter
    '79:8 count @69', // JS: `f(x = 1)` assigns
  ]],
  ['corpus.py', 'python', decoded('corpus.py.tokens.json'), [
    '23:9 attempt @22',
    '25:13 timeout @22,24',
    '40:9 total @29,38', // `global total`
    '41:9 self.retries @29,38',
    '44:13 x @43',
    '57:9 acc @56',
    '66:9 cls.items @61,65', // class state through `cls`
    '72:9 self.a @61,71', // tuple target with member elements
    '72:17 self.b @61,71',
    '80:9 hits @78', // `nonlocal hits`; from `outer` itself it is local
    '87:5 store @86', // subscript through a parameter; the wrapped kwargs below are labels
    '92:5 store @86', // @=
  ]],
  ['multi.py', 'python', decoded('multi.py.tokens.json'), ['4:9 a @3', '4:12 b @3']],
  ['corpus.rs', 'rust', raw('corpus.rs.lsp.json'), [
    '10:9 self.retries @8,9',
    '11:9 self.retries @8,9',
    '20:9 sum @18',
    '30:5 cfg.retries @28',
    '33:9 name @32',
    '34:9 retries @32',
    '37:14 COUNTER @28,37', // `static mut`: not a data identity, still an escaping write
    '49:6 total @48', // `*total +=` through a `&mut` parameter
    '50:5 items @48',
  ]],
  ['corpus.go', 'go', decoded('corpus.go.tokens.json'), [
    '17:2 c.Retries @16',
    '18:2 c.Retries @16',
    '24:3 acc @23',
    '25:3 total @21,23',
    '27:2 counter @21',
    '41:3 retries @40',
    '52:3 p @51', // `*p =`
    '53:2 m @51',
    '56:2 counter @51', // &^=
  ]],
  ['multi.go', 'go', decoded('multi.go.tokens.json'), ['6:3 a @5', '6:6 b @5']],
  // Another function's `i`, a sibling block's `k`, a braceless `for`'s `r` and
  // the methods under a class body are other bindings: no mark on `i++`, `k += 1`, `r++`.
  ['visibility.ts', 'typescript', decoded('visibility.ts.tokens.json'), [
    '11:5 s @10',
    '26:7 total @22,23',
    '32:7 total @30,31',
    '42:7 this.count @38,40,41',
    '47:7 this.count @38,45,46',
  ]],
  // `err = nil` marks from its own `if` only, not from the function body because
  // another function declares `err` too.
  ['visibility.go', 'go', decoded('visibility.go.tokens.json'), ['9:4 err @8', '25:3 total @24', '29:4 total @27,28']],
  // f-string `=` reads and branches that each assign a name are not writes; a
  // loop reassigning an earlier name and an augmented store are.
  ['branches.py', 'python', decoded('branches.py.tokens.json'), ['48:9 total @47', '51:9 count @50']],
];

for (const [file, lang, serve, want] of CORPORA) {
  test(`escape corpus ${file}: marks and the blocks that show them`, async () => {
    const text = read(file);
    assert.deepEqual(await escapeMarks(text, lang, serve(text)), want);
  });
}

test('escape corpus corpus.py: a declaration on every store gives the same marks as on the first only', async () => {
  const text = read('corpus.py');
  const every = await escapeMarks(text, 'python', decoded('corpus.py.tokens.json')(text));
  const first = await escapeMarks(text, 'python', decoded('corpus.py.first-decl.tokens.json')(text));
  assert.deepEqual(first, every);
});

test('escape corpus branches.py: both Pylance declaration shapes give the same marks', async () => {
  const text = read('branches.py');
  const every = await escapeMarks(text, 'python', decoded('branches.py.tokens.json')(text));
  const first = await escapeMarks(text, 'python', decoded('branches.py.first-decl.tokens.json')(text));
  assert.deepEqual(first, every);
});

test('a loop variable declared in another function is still the block\'s own (block, proximity 2)', async () => {
  for (const [file, lang, needle] of [['visibility.ts', 'typescript', 'let s = 0'], ['visibility.go', 'go', 'total := 0']]) {
    const text = read(file);
    const served = decoded(`${file}.tokens.json`)(text);
    stub.clearLspResponses();
    stub.setLspResponses({
      'vscode.provideDocumentSemanticTokensLegend': served.legend,
      'vscode.provideDocumentSemanticTokens': { data: served.data },
      'vscode.executeDocumentSymbolProvider': [],
    });
    const doc = new stub.TextDocument(text, lang, `file:///vis-${Math.random()}`);
    const blocks = focus.scanBlocks(text, lang);
    const at = text.indexOf(needle);
    const block = focus.innermostBlock(blocks, doc.positionAt(at).line, at, text);
    const r = await new Classifier().classifyScope(doc, block, 5, { isCancellationRequested: false }, { text, blocks });
    const i = r.focused.byName.get('i');
    assert.deepEqual([i.cls, i.proximity], ['block', 2], file);
  }
});

test('a heuristic classification (no semantic tokens) makes no escape claim', async () => {
  for (const [file, lang] of [['corpus.ts', 'typescript'], ['corpus.py', 'python'], ['corpus.kt', 'kotlin'], ['corpus.go', 'go']]) {
    assert.deepEqual(await escapeMarks(read(file), lang, null), [], file);
  }
});

test('known false positives stay unmarked', async () => {
  const ts = await escapeMarks(read('corpus.ts'), 'typescript', decoded('corpus.ts.tokens.json')(read('corpus.ts')));
  const py = await escapeMarks(read('corpus.py'), 'python', decoded('corpus.py.tokens.json')(read('corpus.py')));
  const lines = (marks) => new Set(marks.map((m) => +m.split(':')[0]));
  for (const line of [8, 9, 11, 12, 36, 37, 41, 48, 55, 58, 60]) {
    assert.ok(!lines(ts).has(line), `corpus.ts line ${line}: comment, default param, declaration, constructor or own param`);
  }
  for (const line of [8, 9, 11, 18, 19, 34, 35, 36, 69, 76, 89]) {
    assert.ok(!lines(py).has(line), `corpus.py line ${line}: default, comment, kwarg, docstring, __init__, declaration`);
  }
});

// ── rules on constructed classifications ─────────────────────────────────────

function info(cls, proximity = 1) {
  return { cls, proximity, freqInBlock: 1, firstFileOffset: 0, firstBlockOffset: 0, isCapture: false };
}

/** A semantic classification over `src` where every word in `names` is an occurrence. */
function semantic(src, names, extra = {}) {
  const occurrences = new Map();
  for (const [n] of names) {
    occurrences.set(n, [...src.matchAll(new RegExp(`(?<![\\w.])${n}\\b`, 'g'))].map((m) => ({ start: m.index, end: m.index + n.length })));
  }
  return { source: 'lsp', byName: new Map(names.map(([n, cls, prox]) => [n, info(cls, prox)])), occurrences, declSites: new Set(), staticNames: new Set(), excludeRanges: [], ...extra };
}

const marked = (src, c, lang) => risk.escapeRisk(src, { start: 0, end: src.length }, c, lang).map((r) => src.slice(r.start, r.end));

test('escape: every assignment operator is a write; comparisons, arrows and := are not', () => {
  const ops = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=', '**=', '??=', '||=', '&&='];
  for (const op of ops) {
    assert.deepEqual(marked(`{ g ${op} 1; }`, semantic(`{ g ${op} 1; }`, [['g', 'out']]), 'typescript'), ['g'], op);
  }
  for (const src of ['{ g == 1; g === 1; g != 1; g !== 1; g <= 1; g >= 1; f = (g) => g; }']) {
    assert.deepEqual(marked(src, semantic(src, [['g', 'out']]), 'typescript'), []);
  }
  assert.deepEqual(marked('{\n\tg := 1\n}', semantic('{\n\tg := 1\n}', [['g', 'out']]), 'go'), []);
  assert.deepEqual(marked('x //= 2\ny **= 2\n', semantic('x //= 2\ny **= 2\n', [['x', 'out'], ['y', 'out']]), 'python'), ['x', 'y']);
});

test('escape: ++/-- per language (Python and Rust have none; Go has no prefix form)', () => {
  const js = '{ g++; --h; }';
  assert.deepEqual(marked(js, semantic(js, [['g', 'out'], ['h', 'out']]), 'javascript'), ['g', 'h']);
  const py = 'y = --g\n';
  assert.deepEqual(marked(py, semantic(py, [['g', 'out'], ['y', 'block']]), 'python'), []);
  const go = '{\n\tg++\n\tx = --h\n}';
  assert.deepEqual(marked(go, semantic(go, [['g', 'out'], ['h', 'out'], ['x', 'block']]), 'go'), ['g']);
});

test('a declaration site is never a write', () => {
  const src = 'let mut c = Config { retries: 1 };';
  const c = semantic(src, [['c', 'fn']], { declSites: new Set([src.indexOf('c =')]) });
  assert.deepEqual(marked(src, c, 'rust'), []);
});

test('named arguments and defaults are labels, wrapped or not; JS `f(x = 1)` is a write', () => {
  const py = 'cfg = Config(name=name,\n             retries=retries)\nopen_conn(\n    url,\n    retries=3,  # wrapped\n)\nif (name == x): pass\n';
  assert.deepEqual(marked(py, semantic(py, [['name', 'fn'], ['retries', 'out'], ['cfg', 'block']]), 'python'), []);
  const kt = 'connect(host = "x", retries = next)';
  assert.deepEqual(marked(kt, semantic(kt, [['host', 'out'], ['retries', 'out']]), 'kotlin'), []);
  const js = 'sink(count = 3); for (i = 0; i < n; i++) {}';
  assert.deepEqual(marked(js, semantic(js, [['count', 'out'], ['i', 'out']]), 'javascript'), ['count', 'i', 'i']);
});

test('the focused function\'s own parameter (proximity 0) is not escaping; from a nested block it is', () => {
  const src = '{ retries = retries - 1; }';
  assert.deepEqual(marked(src, semantic(src, [['retries', 'fn', 0]]), 'typescript'), []);
  assert.deepEqual(marked(src, semantic(src, [['retries', 'fn', 1]]), 'typescript'), ['retries']);
  assert.deepEqual(marked(src, semantic(src, [['retries', 'block', 0]]), 'typescript'), []);
});

test('member and subscript writes are judged by the root receiver', () => {
  const src = '{ opts.limit = 7; cfg.a.b += 1; local.x = 1; d[k] = v; f().x = 1; a?.b = 2; }';
  const c = semantic(src, [['opts', 'fn', 0], ['cfg', 'out'], ['local', 'block'], ['d', 'fn'], ['a', 'out']]);
  assert.deepEqual(marked(src, c, 'typescript'), ['opts.limit', 'cfg.a.b', 'd', 'a?.b']);
  const go = '{\n\tc.Retries += 1\n\tc.values[key] = value\n}';
  assert.deepEqual(marked(go, semantic(go, [['c', 'fn', 0]]), 'go'), ['c.Retries', 'c.values']);
});

test('self/this writes mark outside initializers only', () => {
  const ts = 'class A {\n  constructor(n) {\n    this.n = n;\n    if (n) { this.m = 1; }\n  }\n  bump() {\n    this.n += 1;\n  }\n}';
  assert.deepEqual(marked(ts, semantic(ts, [['this', 'self']]), 'typescript'), ['this.n']);
  const py = 'class A:\n    def __init__(self, n):\n        self.n = n\n        if n:\n            self.m = 1\n\n    def bump(self):\n        self.n += 1\n';
  assert.deepEqual(marked(py, semantic(py, [['self', 'self']]), 'python'), ['self.n']);
  const kt = 'class A(n: Int) {\n    var n = 0\n    init {\n        this.n = 1\n    }\n    fun bump() {\n        this.n += 1\n    }\n}';
  assert.deepEqual(marked(kt, semantic(kt, [['this', 'self']]), 'kotlin'), ['this.n']);
  const java = 'class A {\n  public A(int n) {\n    this.n = n;\n  }\n  void bump() {\n    this.n += 1;\n  }\n}';
  assert.deepEqual(marked(java, semantic(java, [['this', 'self']]), 'java'), ['this.n']);
  const swift = 'class A {\n  init(n: Int) {\n    self.n = n\n  }\n  func bump() {\n    self.n += 1\n  }\n}';
  assert.deepEqual(marked(swift, semantic(swift, [['self', 'self']]), 'swift'), ['self.n']);
});

test('tuple targets in Python and Go; a JS comma expression is not one', () => {
  const py = 'a, b = b, a\nx, y.z, w[0] = 1, 2, 3\nfor k, v in d: pass\nprint(a, b)\n';
  const c = semantic(py, [['a', 'out'], ['b', 'out'], ['x', 'out'], ['y', 'out'], ['w', 'out'], ['k', 'out'], ['v', 'out']]);
  assert.deepEqual(marked(py, c, 'python'), ['a', 'b', 'x', 'y.z', 'w']);
  const js = '{ a, b = 1; }';
  assert.deepEqual(marked(js, semantic(js, [['a', 'out'], ['b', 'out']]), 'javascript'), ['b']);
});

test('Python global/nonlocal belong to their own def; Rust statics escape', () => {
  const py = 'def bump(delta):\n    global total\n    total += delta\n\n    def inner():\n        nonlocal delta\n        delta = 0\n';
  const body = { start: py.indexOf('('), end: py.length }; // lexRegionFor of a def starts at its parameters
  const c = semantic(py, [], { declSites: new Set([py.indexOf('total +=')]) });
  for (const fn of [{ start: 0, end: py.length }, undefined]) {
    const got = risk.escapeRisk(py, body, { ...c, enclosingFn: fn }, 'python').map((r) => py.slice(r.start, r.end));
    assert.deepEqual(got, ['total'], '`delta` is nonlocal in inner, not in bump; no symbol range needed');
  }
  const rs = 'fn f() { unsafe { COUNTER += 1; } }';
  assert.deepEqual(marked(rs, semantic(rs, [], { staticNames: new Set(['COUNTER']) }), 'rust'), ['COUNTER']);
});

test('the top-level scope skips its excluded nested bodies', () => {
  const src = 'let g = 0;\ng = 1;\nfunction f() {\n  g = 2;\n}\n';
  const body = { start: src.indexOf('{'), end: src.lastIndexOf('}') + 1 };
  const c = semantic(src, [['g', 'out']], { declSites: new Set([4]), excludeRanges: [body] });
  assert.deepEqual(risk.escapeRisk(src, { start: 0, end: src.length }, c, 'typescript').map((r) => r.start), [src.indexOf('g = 1')]);
});

test('escape: a write after a comment ending in `.` is still a write; one inside a comment is not', () => {
  const src = 'function f() {\n  // totals are global.\n  total += 1;\n  // total += 2;\n}';
  assert.deepEqual(marked(src, semantic(src, [['total', 'out']]), 'typescript'), ['total']);
});

test('escape: a name that is not a data occurrence at that offset is not marked', () => {
  const src = '{ total = 1; }';
  const c = semantic(src, [['total', 'out']]);
  c.occurrences.set('total', []);
  assert.deepEqual(marked(src, c, 'typescript'), []);
});

// ── classifier prerequisite: declarations are never labels ───────────────────

const tok = (src, name, nth, type, modifiers) => {
  let at = -1;
  for (let k = 0; k <= nth; k++) at = src.indexOf(name, at + 1);
  return { name, offset: at, length: name.length, type, modifiers };
};

test('escape: a tab before the operator, Kotlin `!!.` chains and a name with no occurrence list', () => {
  assert.deepEqual(marked('{ g\t= 1; }', semantic('{ g\t= 1; }', [['g', 'out']]), 'typescript'), ['g']);
  const kt = 'fun f() {\n    obj!!.field = v\n    obj!!.a.b = v\n}';
  assert.deepEqual(marked(kt, semantic(kt, [['obj', 'out']]), 'kotlin'), ['obj!!.field', 'obj!!.a.b']);
  const src = '{ total = 1; }';
  const c = semantic(src, [['total', 'out']]);
  c.occurrences.delete('total');
  assert.deepEqual(marked(src, c, 'typescript'), []);
});

test('initializers: a no-argument constructor counts, a capitalised method does not', () => {
  const noArgs = 'class A {\n  constructor() {\n    this.n = 0;\n  }\n}';
  assert.deepEqual(marked(noArgs, semantic(noArgs, [['this', 'self']]), 'typescript'), []);
  const ts = 'class A {\n  Reset() {\n    this.n = 1;\n  }\n}';
  assert.deepEqual(marked(ts, semantic(ts, [['this', 'self']]), 'typescript'), ['this.n']);
  // No `;` ends the previous method, so the header walk must stop at its `}`.
  const swift = 'class A {\n  func reset() {\n    Setup()\n  }\n  func bump() {\n    self.n += 1\n  }\n}';
  assert.deepEqual(marked(swift, semantic(swift, [['self', 'self']]), 'swift'), ['self.n']);
});

test('escape regions stop at the block end even when an excluded body lies past it', () => {
  const src = 'g = 1;\nh = 2;\nfunction f() {\n  g = 3;\n}\n';
  const body = { start: src.indexOf('{'), end: src.lastIndexOf('}') + 1 };
  const c = semantic(src, [['g', 'out'], ['h', 'out']], { excludeRanges: [{ start: 0, end: 0 }, body] });
  const block = { start: 0, end: src.indexOf('\n') };
  assert.deepEqual(risk.escapeRisk(src, block, c, 'typescript').map((r) => src.slice(r.start, r.end)), ['g']);
});

test('python: a subscript write through a `global` name escapes without a classification', () => {
  const py = 'def f():\n    global d\n    d["k"] = 1\n';
  const got = risk.escapeRisk(py, { start: py.indexOf('('), end: py.length }, { ...semantic(py, []), enclosingFn: { start: 0, end: py.length } }, 'python');
  assert.deepEqual(got.map((r) => py.slice(r.start, r.end)), ['d']);
});

test('a declaration in `(…, x = …)` position stays a declaration', () => {
  const ts = 'function build(name, retries = 3) {}';
  const idx = classify.buildFileIndex(ts, [tok(ts, 'retries', 0, 'parameter', ['declaration'])], [], 'typescript');
  assert.deepEqual(idx.declOffsets.get('retries'), [ts.indexOf('retries')]);
  const py = 'def connect(host, retries=5):\n    a, b = 1, 2\n';
  const pyIdx = classify.buildFileIndex(py, [
    tok(py, 'retries', 0, 'parameter', ['declaration']),
    tok(py, 'b', 0, 'variable', ['declaration']),
  ], [{ start: 0, end: py.length }], 'python');
  assert.deepEqual(pyIdx.declOffsets.get('retries'), [py.indexOf('retries')]);
  assert.deepEqual(pyIdx.declOffsets.get('b'), [py.indexOf('b =')]);
  assert.ok(pyIdx.declSites.has(py.indexOf('b =')));
});

test('tuple and call-assignment targets keep their occurrence; kwarg labels do not', () => {
  const go = 'val, err = strconv.Atoi(s)';
  assert.equal(classify.buildFileIndex(go, [tok(go, 'err', 0, 'variable', [])], [], 'go').occurrences.get('err').length, 1);
  const js = 'sink(count = 3)';
  assert.equal(classify.buildFileIndex(js, [tok(js, 'count', 0, 'variable', [])], [], 'javascript').occurrences.get('count').length, 1);
  const py = 'cfg = Config(name=name,\n    retries=retries)\n';
  const idx = classify.buildFileIndex(py, [
    tok(py, 'name', 0, 'parameter', ['keywordArgument']),
    tok(py, 'name', 1, 'variable', []),
    tok(py, 'retries', 0, 'variable', []),
    tok(py, 'retries', 1, 'variable', []),
  ], [], 'python');
  assert.deepEqual(idx.occurrences.get('name').map((r) => r.start), [py.indexOf('=name') + 1]);
  assert.deepEqual(idx.occurrences.get('retries').map((r) => r.start), [py.indexOf('=retries') + 1]);
});

test('python rebinding: only the first depth-0 binding per function is a declaration', () => {
  const py = [
    'def f(items, total):',
    '    acc = 0',
    '    for x in items:',
    '        acc += x',
    '        total = acc',
    '    ys = [acc for acc in items]',
    '',
    'def g():',
    '    global hits',
    '    hits = 1',
    '',
  ].join('\n');
  const fns = [{ start: 0, end: py.indexOf('def g') }, { start: py.indexOf('def g'), end: py.length }];
  const decl = (name, nth) => tok(py, name, nth, 'variable', ['declaration']);
  const idx = classify.buildFileIndex(py, [
    tok(py, 'items', 0, 'parameter', ['declaration']), tok(py, 'total', 0, 'parameter', ['declaration']),
    decl('acc', 0), decl('acc', 1), decl('total', 1), decl('acc', 4), decl('hits', 1),
  ], fns, 'python');
  assert.deepEqual(idx.declOffsets.get('acc'), [py.indexOf('acc = 0'), py.indexOf('acc for') + 'acc for '.length],
    'the `+=` rebinding is dropped; the comprehension target is its own binding');
  assert.deepEqual(idx.declOffsets.get('total'), [py.indexOf('total')], 'a store to a parameter is a write');
  assert.equal(idx.declOffsets.get('hits'), undefined, 'a `global` name is never declared in the function');
});

test('python rebinding: suites come from indentation, so a missing symbol provider changes nothing', () => {
  const py = 'def f(x):\n    n = 1\n\n\ndef g(\n        n):\n    n = 2\n\n\nx = 3\nn = 4\nclass C:\n    n = 5\n';
  const decl = (name, nth, type = 'variable') => tok(py, name, nth, type, ['declaration']);
  const idx = classify.buildFileIndex(py, [
    decl('x', 0, 'parameter'), decl('n', 0), decl('n', 1, 'parameter'), decl('n', 2), decl('x', 1), decl('n', 3),
  ], [], 'python');
  const at = (needle) => py.indexOf(needle);
  assert.deepEqual(idx.declOffsets.get('n'), [at('n = 1'), at('n):'), at('n = 4')], "g's `n = 2` rebinds its parameter; f, g and the module are separate suites");
  assert.deepEqual(idx.declOffsets.get('x'), [at('x):'), at('x = 3')], "f's parameter does not swallow the module's `x`");
  assert.equal(classify.pyScopeAt(classify.buildFileIndex(py, [], [], 'python').lex, at('n = 5')).name, 'C');
});

// ── render: style and the stale-hold ─────────────────────────────────────────

/** OKLCH hue of an sRGB hex, degrees. */
function hue(hex) {
  const lin = (i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin(1), lin(3), lin(5)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
}

test('the escape mark carries the spec geometry and sits off the error hue', () => {
  for (const [isDark, color, editorError] of [[true, '#e0a26f', '#f84f52'], [false, '#a06024', '#c71529']]) {
    const pool = tokens.buildDecorationPool(isDark);
    const css = pool.riskEscape.options.textDecoration;
    assert.equal(css, `underline dashed ${color}; text-decoration-thickness: 1.5px; text-underline-offset: 3px; text-decoration-skip-ink: none`);
    // editorError.foreground of the Okibi / Akari themes.
    assert.ok(hue(color) - hue(editorError) >= 30, `${color} is ${(hue(color) - hue(editorError)).toFixed(1)}° from ${editorError}`);
  }
});

const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');

test('escape marks survive typing in the same block with no empty frame, and clear on a block change', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../samples/sample.rs'), 'utf8');
  const lsp = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample.rs.lsp.json'), 'utf8'));
  stub.clearLspResponses();
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': lsp.legend,
    'vscode.provideDocumentSemanticTokens': { data: lsp.data },
    'vscode.executeDocumentSymbolProvider': [],
  });
  const doc = new stub.TextDocument(src, 'rust', 'file:///escape-hold.rs');
  const line = src.split('\n').findIndex((l) => l.includes('total += c.retries'));
  const ed = new stub.TextEditor(doc, line, 8);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const d = new Decorator();
  const frames = [];
  ed.setDecorations = (type, ranges) => {
    if (type === d.pool.riskEscape) frames.push(ranges.length);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  d.refresh();
  await wait(250);
  d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 });
  await wait(250);
  d.onEdit(stub.typing(ed));
  await wait(400);
  assert.equal(d.machine.current, Phase.Edit);
  assert.ok(frames.length > 0 && frames[frames.length - 1] > 0, 'positive control: the escaping write is painted');

  const before = frames.length;
  for (const gap of [60, 700, 30, 400]) {
    doc.version++; // the text is unchanged, so the captured tokens stay valid
    d.onEdit(stub.typing(ed));
    await wait(gap);
  }
  await wait(400);
  const typing = frames.slice(before);
  assert.ok(!typing.includes(0), `no empty escape frame while typing: ${typing.join(',')}`);
  assert.ok(typing.length > 0 && typing[typing.length - 1] > 0, 'each classify repaints the hold');

  // A different block with no escaping write: the hold must not follow the caret there.
  const other = src.split('\n').findIndex((l) => /^\s*let label = /.test(l));
  assert.ok(other > 0, 'sample.rs has the `let label` line');
  ed.selection = new vs.Selection(other, 8, other, 8);
  d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 });
  doc.version++;
  d.onEdit(stub.typing(ed));
  await wait(30);
  assert.equal(frames[frames.length - 1], 0, 'moving to another block clears the old marks at once');
  d.dispose();
});

test('a reclassify while typing re-sends escape marks only when an edit moved them', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../samples/sample.rs'), 'utf8');
  const lsp = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample.rs.lsp.json'), 'utf8'));
  const line = src.split('\n').findIndex((l) => l.includes('total += c.retries'));
  // The captured tokens, with the ones on `line` moved right by `shift` characters.
  const dataWith = (shift) => {
    const out = lsp.data.slice();
    let l = 0;
    for (let i = 0; i < out.length; i += 5) {
      const first = out[i] > 0;
      l += out[i];
      if (l === line && first) out[i + 1] += shift;
    }
    return out;
  };
  let shift = 0;
  stub.clearLspResponses();
  stub.setLspHandler((cmd) => cmd === 'vscode.provideDocumentSemanticTokensLegend' ? lsp.legend
    : cmd === 'vscode.provideDocumentSemanticTokens' ? { data: dataWith(shift) } : []);
  const doc = new stub.TextDocument(src, 'rust', 'file:///escape-resend.rs');
  const ed = new stub.TextEditor(doc, line, 8);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const d = new Decorator();
  const sent = [];
  ed.setDecorations = (type, ranges) => {
    if (type === d.pool.riskEscape) sent.push(ranges.map((r) => `${r.start.line}:${r.start.character}-${r.end.character}`));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const typeAt = (character) => {
    const at = doc.offsetAt(new vs.Position(line, character));
    const ev = doc.applyEdit(at, at, ' ');
    ed.selection = new vs.Selection(line, character + 1, line, character + 1);
    d.onEdit(ev);
  };
  d.refresh();
  await wait(250);
  d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 });
  await wait(250);
  typeAt(doc.lineAt(line).text.length);
  await wait(400);
  assert.equal(d.machine.current, Phase.Edit);
  const painted = sent.at(-1);
  assert.ok(painted?.length > 0 && painted.every((r) => r.startsWith(`${line}:`)), 'positive control: marks on the edited line');

  const before = sent.length;
  typeAt(doc.lineAt(line).text.length);
  await wait(400);
  assert.equal(sent.length, before, 'typing after every mark moves none, and the same marks are not re-sent');

  shift = 1;
  typeAt(0);
  await wait(400);
  assert.equal(sent.length, before + 1, 'typing before the marks moves them, so the reclassify re-sends');
  assert.deepEqual(sent.at(-1), painted.map((r) => r.replace(/:(\d+)-(\d+)$/, (_, a, b) => `:${+a + 1}-${+b + 1}`)));
  d.dispose();
});
