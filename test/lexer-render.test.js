'use strict';
// Render-path regressions for the shared lexer: a real Decorator, an engaged
// document, real Focus and Edit phases. No decoration may land inside a comment
// or docstring — clay numbers, async / danger / escape marks, identity tints or
// the band-1 `self` mark. Positive controls make each run prove it painted.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const stub = require('./vscode-stub');
const vs = stub.install();
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');
const { lexFor } = require('../out/lex');

const settle = () => new Promise((r) => setTimeout(r, 250));

const PY = [
  'MAX_RETRIES = 3',
  '',
  '',
  'def retry(job, total):',
  '    """Retry job up to 3 times as needed; any error is async-safe.',
  '',
  '    total = the running count, await later; self.flush is fine',
  '    """',
  '    # retry 3 times as needed, any error is async-safe; total += 1',
  '    count = 0',
  '    while count < MAX_RETRIES:',
  '        count += 1',
  '        total += job(count)  # total is written here, 2 as any',
  '    return total',
  '',
  '',
  'class Box:',
  '    def flush(self):',
  '        """self.flush docs mention self and 10 as any"""',
  '        return self  # self in a comment',
  '',
].join('\n');

/** Pylance-shaped tokens for every code identifier, in the LSP delta wire format. */
function pylanceTokens(src) {
  const legend = { tokenTypes: ['variable', 'parameter', 'function', 'class'], tokenModifiers: ['declaration'] };
  const lines = src.split('\n');
  const want = [
    [0, 'MAX_RETRIES', 0, 1], [3, 'retry', 2, 1], [3, 'job', 1, 1], [3, 'total', 1, 1],
    [9, 'count', 0, 1], [10, 'count', 0, 0], [10, 'MAX_RETRIES', 0, 0], [11, 'count', 0, 0],
    [12, 'total', 1, 0], [12, 'job', 1, 0], [12, 'count', 0, 0], [13, 'total', 1, 0],
    [16, 'Box', 3, 1], [17, 'flush', 2, 1],
  ];
  const data = [];
  let prevLine = 0;
  let prevChar = 0;
  for (const [line, name, type, mods] of want) {
    const char = lines[line].indexOf(name);
    assert.ok(char >= 0, `${name} on line ${line}`);
    const dLine = line - prevLine;
    data.push(dLine, dLine === 0 ? char - prevChar : char, name.length, type, mods);
    prevLine = line;
    prevChar = char;
  }
  return { legend, data };
}

/** Drive the real open → click → type lifecycle; return per-phase snapshots of every decoration type. */
async function drive(src, languageId, caretLine, caretChar) {
  const doc = new stub.TextDocument(src, languageId, `file:///lexer-render-${languageId}-${Math.random()}`);
  const ed = new stub.TextEditor(doc, caretLine, caretChar);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  const d = new Decorator();
  const snap = () => new Map([...live].map(([t, r]) => [t, [...r]]));

  d.refresh();
  await settle();
  d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 });
  await settle();
  assert.equal(d.machine.current, Phase.Focus, 'a click enters Focus');
  const focus = snap();
  d.onEdit(stub.typing(ed));
  await settle();
  assert.equal(d.machine.current, Phase.Edit, 'typing enters Edit');
  const edit = snap();
  d.dispose();
  return { d, doc, focus, edit };
}

/** Every painted range that intersects a comment or doc span, labelled by type. */
function inComments(src, languageId, doc, d, snapshot) {
  const spans = lexFor(src, languageId).spans.filter((s) => s.region === 'comment' || s.region === 'doc');
  const names = new Map([
    [d.pool.numberEngaged, 'clay'], [d.pool.riskAsync, 'async'], [d.pool.riskDanger, 'danger'],
    [d.pool.riskEscape, 'escape'], [d.pool.self, 'self'],
    ...d.pool.id.map((t, i) => [t, `id${i}`]), ...d.pool.idg.map((t, i) => [t, `idg${i}`]),
  ]);
  const bad = [];
  for (const [type, ranges] of snapshot) {
    const label = names.get(type);
    if (!label) continue;
    for (const r of ranges) {
      const a = doc.offsetAt(r.start);
      const b = doc.offsetAt(r.end);
      if (spans.some((s) => a < s.end && b > s.start)) bad.push(`${label} L${r.start.line}:${r.start.character} "${src.slice(a, b)}"`);
    }
  }
  return bad;
}

const count = (snapshot, types) => types.reduce((n, t) => n + (snapshot.get(t) ?? []).length, 0);

for (const mode of ['heuristic (no semantic provider)', 'Pylance-shaped semantic tokens']) {
  test(`python comments and docstrings get no marks or tints in Focus and Edit — ${mode}`, async () => {
    stub.clearLspResponses();
    if (mode.startsWith('Pylance')) {
      const { legend, data } = pylanceTokens(PY);
      stub.setLspResponses({
        'vscode.provideDocumentSemanticTokensLegend': legend,
        'vscode.provideDocumentSemanticTokens': { data },
        'vscode.executeDocumentSymbolProvider': [],
      });
    }
    const { d, doc, focus, edit } = await drive(PY, 'python', 11, 10);
    assert.deepEqual(inComments(PY, 'python', doc, d, focus), [], 'Focus paints nothing inside comments/docstrings');
    assert.deepEqual(inComments(PY, 'python', doc, d, edit), [], 'Edit paints nothing inside comments/docstrings');

    // Positive controls: the same run DID paint code.
    assert.ok(count(focus, [d.pool.numberEngaged]) > 0, 'clay numbers paint in code');
    if (mode.startsWith('Pylance')) {
      assert.ok(count(edit, [d.pool.riskEscape]) > 0, 'the escaping write `total +=` is marked in code');
    } else {
      assert.equal(count(edit, [d.pool.riskEscape]), 0, 'a heuristic classification makes no escape claim');
    }
    assert.ok(count(focus, [...d.pool.id, ...d.pool.idg]) > 0, 'identity tints paint in code');
    assert.equal(count(focus, [d.pool.self]), 2, 'self paints its two code uses only');
  });
}

test('rust nested comments, lifetimes and raw strings get no marks in Edit', async () => {
  stub.clearLspResponses();
  const src = [
    "fn longest<'a>(x: &'a str, total: &mut u32) -> &'a str { // it's 3x faster as any",
    '    /* outer /* inner */ still 42 comment as any; *total = 0 */',
    '    let s = r#"',
    '        count = 7 as any',
    '    "#;',
    '    *total += 1;',
    '    x',
    '}',
    '',
  ].join('\n');
  const { d, doc, focus, edit } = await drive(src, 'rust', 5, 6);
  const strings = lexFor(src, 'rust').spans.filter((s) => s.region === 'string');
  const inString = (snapshot, types) => types.flatMap((t) => snapshot.get(t) ?? [])
    .filter((r) => strings.some((s) => doc.offsetAt(r.start) < s.end && doc.offsetAt(r.end) > s.start));
  assert.deepEqual(inComments(src, 'rust', doc, d, edit), []);
  assert.deepEqual(inString(edit, [d.pool.numberEngaged, d.pool.riskDanger, d.pool.riskAsync, d.pool.riskEscape]), []);
  assert.ok(count(focus, [d.pool.numberEngaged]) > 0, 'the code literal `1` is clay');
});

// ── every sample, every block ────────────────────────────────────────────────
//
// The invariant over the real samples rather than a crafted snippet: focus each
// block in turn (and the module top level), paint Focus and Edit, and require
// that no tint or mark intersects a comment or doc span. Real server tokens where
// a capture exists, the heuristic everywhere.

const fs = require('fs');
const path = require('path');
const { scanBlocks } = require('../out/focus');

const SAMPLES = path.join(__dirname, '../samples');
const FIXTURES = path.join(__dirname, 'fixtures');
const SAMPLE_LANGS = [
  ['sample.c', 'c'], ['sample.cpp', 'cpp'], ['sample.go', 'go'], ['Sample.java', 'java'],
  ['sample.js', 'javascript'], ['sample.kt', 'kotlin'], ['sample.py', 'python'],
  ['sample.rs', 'rust'], ['sample.ts', 'typescript'], ['sample.lua', 'lua'],
];

/** The captured server answer for a sample, in wire format, or undefined. */
function capturedTokens(file, src) {
  const lsp = path.join(FIXTURES, `${file}.lsp.json`);
  if (fs.existsSync(lsp)) {
    const { legend, data } = JSON.parse(fs.readFileSync(lsp, 'utf8'));
    return { legend, data };
  }
  const decoded = path.join(FIXTURES, `${file}.tokens.json`);
  return fs.existsSync(decoded) ? stub.encodeTokens(src, JSON.parse(fs.readFileSync(decoded, 'utf8'))) : undefined;
}

async function sweep(src, languageId) {
  const doc = new stub.TextDocument(src, languageId, `file:///sweep-${languageId}-${Math.random()}`);
  const ed = new stub.TextEditor(doc, 0, 0);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  const d = new Decorator();
  const bad = new Set();
  let tints = 0;
  const carets = [doc.positionAt(0), ...scanBlocks(src, languageId).map((b) => doc.positionAt(b.openOffset + 1))];
  for (const at of carets) {
    ed.selection = new vs.Selection(at.line, at.character, at.line, at.character);
    d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 });
    await d.runClassify(doc);
    for (const phase of [Phase.Focus, Phase.Edit]) {
      d.machine.phase = phase;
      d.render();
      for (const hit of inComments(src, languageId, doc, d, live)) bad.add(`${phase} ${hit}`);
      tints += count(live, [...d.pool.id, ...d.pool.idg]);
    }
  }
  d.dispose();
  return { bad: [...bad], tints, carets: carets.length };
}

for (const [file, languageId] of SAMPLE_LANGS) {
  test(`${file}: no tint or mark inside a comment, any block, Focus and Edit`, async () => {
    const src = fs.readFileSync(path.join(SAMPLES, file), 'utf8');
    const served = capturedTokens(file, src);
    for (const mode of served ? ['heuristic', 'semantic'] : ['heuristic']) {
      stub.clearLspResponses();
      if (mode === 'semantic') {
        stub.setLspResponses({
          'vscode.provideDocumentSemanticTokensLegend': served.legend,
          'vscode.provideDocumentSemanticTokens': { data: served.data },
          'vscode.executeDocumentSymbolProvider': [],
        });
      }
      const r = await sweep(src, languageId);
      assert.deepEqual(r.bad, [], `${mode}: ranges inside comments`);
      assert.ok(r.carets > 3 && r.tints > 0, `${mode}: positive control, ${r.carets} carets painted ${r.tints} tints`);
    }
  });
}
