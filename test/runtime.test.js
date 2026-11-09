'use strict';
// Runtime and LSP lifecycle: what reaches the screen when the server is slow,
// cold, or answers for text that has since changed; which documents and editors
// the layer paints; which edits count as typing. Rules: docs/runtime.md.
//
// Fixtures in test/fixtures/comments/ are real captures:
//   doctest.rs   rust-analyzer 0.3.3105 in a cargo workspace (legend, data, documentSymbol)
//   doclinks.go  gopls v0.23.0 `semtok`, decoded

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
const { Decorator, isDecoratable, editDebounceMs } = require('../out/decorator');
const { Phase, isTypingEdit } = require('../out/phases');
const { Classifier, coldRetryDelay, answerStateOf, rustPathKeywords } = require('../out/classify-lsp');
const classify = require('../out/classify');
const focus = require('../out/focus');
const { commentBracketSpans, goDocLinkSpans } = require('../out/doclinks');
const { lexFor } = require('../out/lex');
const { TOKENS } = require('../out/tokens');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAMPLE_RS = fs.readFileSync(path.join(__dirname, '../samples/sample.rs'), 'utf8');
const RS_LSP = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample.rs.lsp.json'), 'utf8'));
const FIX = path.join(__dirname, 'fixtures/comments');

let seq = 0;
function open(text, languageId, line = 0, character = 0, uri = `file:///runtime-${seq++}.${languageId}`) {
  const doc = new stub.TextDocument(text, languageId, uri);
  const ed = new stub.TextEditor(doc, line, character);
  ed.live = new Map();
  ed.setDecorations = (t, r) => ed.live.set(t, r);
  return { doc, ed };
}
function show(...editors) {
  vs.window.activeTextEditor = editors[0];
  vs.window.visibleTextEditors = editors;
}
const count = (ed, type) => (ed.live.get(type) ?? []).length;
const band2 = (d, ed) => [...d.pool.id, ...d.pool.idg].flatMap((t) => ed.live.get(t) ?? []);
const textOf = (doc, r) => doc.getText().slice(doc.offsetAt(r.start), doc.offsetAt(r.end));
const fmt = (d, ed) => band2(d, ed).map((r) => `${r.start.line}:${r.start.character}=${textOf(ed.document, r)}`).sort();
const click = (d, ed) => d.onSelection({ textEditor: ed, selections: ed.selections, kind: 2 });
const moveTo = (d, ed, line, character) => {
  ed.selection = new vs.Selection(line, character, line, character);
  d.onSelection({ textEditor: ed, selections: ed.selections, kind: 1 });
};

/** Decode → shift lines at or below `from` by `by` → re-encode an LSP data array. */
function shiftLines(data, from, by) {
  const abs = [];
  let l = 0;
  let c = 0;
  for (let i = 0; i < data.length; i += 5) {
    l += data[i];
    c = data[i] ? data[i + 1] : c + data[i + 1];
    abs.push([l >= from ? l + by : l, c, data[i + 2], data[i + 3], data[i + 4]]);
  }
  const out = [];
  let pl = 0;
  let pc = 0;
  for (const [al, ac, n, t, m] of abs) {
    out.push(al - pl, al === pl ? ac - pc : ac, n, t, m);
    pl = al;
    pc = ac;
  }
  return out;
}

/** Answer like a language server: tokens for the version current when the request arrived, after `latency`. */
function serveByVersion(doc, latency, dataFor) {
  stub.clearLspResponses();
  stub.setLspHandler(async (cmd) => {
    const v = doc.version;
    await sleep(latency);
    if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return RS_LSP.legend;
    if (cmd === 'vscode.provideDocumentSemanticTokens') return { data: dataFor(v) };
    if (cmd === 'vscode.executeDocumentSymbolProvider') return [];
    return undefined;
  });
}
const tokenRequests = () => stub.lspCalls.filter(([c]) => c === 'vscode.provideDocumentSemanticTokens').length;

// ── An answer for old text never paints on new text ──────────────────────────

test('an edit while the token fetch is in flight never paints the old offsets', async () => {
  const lines = SAMPLE_RS.split('\n');
  const L = lines.findIndex((s) => s.includes('let backoff'));
  const T2 = [...lines.slice(0, L), '', ...lines.slice(L)].join('\n');
  const data2 = shiftLines(RS_LSP.data, L, 1);

  // RACED: hold the v1 answers until after the Enter.
  const raced = open(SAMPLE_RS, 'rust', L, 14);
  show(raced.ed);
  const held = [];
  let holding = true;
  stub.clearLspResponses();
  stub.setLspHandler((cmd) => {
    const v = raced.doc.version;
    const answer = () => {
      if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return RS_LSP.legend;
      if (cmd === 'vscode.provideDocumentSemanticTokens') return { data: v === 1 ? RS_LSP.data : data2 };
      return [];
    };
    return holding ? new Promise((r) => held.push(() => r(answer()))) : answer();
  });
  const d = new Decorator();
  click(d, raced.ed);
  await sleep(100);
  assert.ok(held.length > 0, 'the v1 fetch is in flight');
  const lineStart = raced.doc.offsetAt(new vs.Position(L, 0));
  d.onEdit(raced.doc.applyEdit(lineStart, lineStart, '\n'));
  const cancelled = d.classifyToken.token.isCancellationRequested;
  moveTo(d, raced.ed, L + 1, 14);
  holding = false;
  held.forEach((r) => r());
  await sleep(600);
  const got = fmt(d, raced.ed);
  d.dispose();

  // FRESH: the same final text, never raced.
  const fresh = open(T2, 'rust', L + 1, 14);
  fresh.doc.version = 2;
  show(fresh.ed);
  stub.clearLspResponses();
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': RS_LSP.legend,
    'vscode.provideDocumentSemanticTokens': { data: data2 },
    'vscode.executeDocumentSymbolProvider': [],
  });
  const f = new Decorator();
  click(f, fresh.ed);
  await sleep(400);
  const want = fmt(f, fresh.ed);
  f.dispose();

  assert.ok(want.length > 0, 'positive control: the fresh run paints band 2');
  for (const s of got) assert.match(s, /=[A-Za-z_]\w*$/, `painted off an identifier: ${s}`);
  assert.deepEqual(got, want);
  assert.ok(cancelled, 'the edit cancels the in-flight classify');
});

/** A server whose answers wait for release(); `none` answers no legend, like a language with no provider. */
function heldServer({ none = false } = {}) {
  const held = [];
  stub.clearLspResponses();
  stub.setLspHandler((cmd) => new Promise((r) => held.push(() => r(none ? undefined
    : cmd === 'vscode.provideDocumentSemanticTokensLegend' ? RS_LSP.legend
      : cmd === 'vscode.provideDocumentSemanticTokens' ? { data: RS_LSP.data } : []))));
  return { held, release: () => held.splice(0).forEach((r) => r()) };
}
/** Count calls of a classify.ts export while `fn` runs; classify-lsp reads it through the module. */
async function counting(name, fn) {
  const orig = classify[name];
  let calls = 0;
  classify[name] = (...a) => (calls++, orig(...a));
  try {
    await fn();
  } finally {
    classify[name] = orig;
  }
  return calls;
}
function classifyStart(doc, line) {
  const c = new Classifier();
  const text = doc.getText();
  const blocks = focus.scanBlocks(text, doc.languageId);
  const block = focus.innermostBlock(blocks, line, doc.offsetAt(new vs.Position(line, 0)), text);
  const token = new vs.CancellationTokenSource().token;
  return { c, run: () => c.classifyScope(doc, block, TOKENS.id.length, token, { text, blocks, version: doc.version }) };
}
const RS_LINE = SAMPLE_RS.split('\n').findIndex((s) => s.includes('let backoff'));
const rsPathKeywords = rustPathKeywords(classify.decodeSemanticTokens(RS_LSP.data, RS_LSP.legend.tokenTypes,
  RS_LSP.legend.tokenModifiers, lexFor(SAMPLE_RS, 'rust').lineStarts, SAMPLE_RS));

test('an answer for text that has since changed is not decoded, and still sets the provider state', async () => {
  for (const edited of [false, true]) {
    const doc = new stub.TextDocument(SAMPLE_RS, 'rust', `file:///stale-${edited}.rs`);
    const server = heldServer();
    const { c, run } = classifyStart(doc, RS_LINE);
    let result;
    const decodes = await counting('decodeSemanticTokens', async () => {
      const p = run();
      await sleep(0);
      if (edited) doc.applyEdit(0, 0, ' ');
      server.release();
      result = await p;
    });
    assert.equal(decodes, edited ? 0 : 1, edited ? 'the outdated answer is not decoded' : 'positive control: a current answer is');
    assert.equal(result === null, edited);
    assert.equal(c.semanticOk(doc), true, 'the outdated answer still says the provider answers');
    assert.equal(c.pathKeywordsOf(doc), rsPathKeywords, 'and still sets the path keywords');
  }
  assert.ok(rsPathKeywords, 'the capture types Self, crate or super');
});

test('answerStateOf reads what decoding would: any token on a line, and the Rust path keywords', () => {
  let seed = 5;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const types = ['keyword', 'struct', 'namespace', 'selfTypeKeyword', 'variable'];
  const words = ['Self', 'crate', 'super', 'self', 'xs', 'Selfy', 'cratee'];
  for (let n = 0; n < 3000; n++) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => Array.from({ length: Math.floor(rnd() * 4) },
      () => words[Math.floor(rnd() * words.length)]).join(' '));
    const text = lines.join('\n');
    const lineStarts = lexFor(text, 'rust').lineStarts;
    const data = [];
    for (let k = Math.floor(rnd() * 6); k > 0; k--) {
      data.push(Math.floor(rnd() * 3), Math.floor(rnd() * 12), Math.floor(rnd() * 7), Math.floor(rnd() * types.length), 0);
    }
    const decoded = classify.decodeSemanticTokens(data, types, [], lineStarts, text);
    for (const rust of [false, true]) {
      const got = answerStateOf(data, types, lineStarts, text, rust);
      assert.equal(got.any, decoded.length > 0, JSON.stringify([text, data]));
      assert.equal(got.paths, rust ? rustPathKeywords(decoded) : undefined, JSON.stringify([text, data]));
    }
  }
});

test('a keystroke queued behind the answer skips the whole-file work it would outdate', async () => {
  for (const edited of [false, true]) {
    const doc = new stub.TextDocument(SAMPLE_RS, 'rust', `file:///queued-${edited}.rs`);
    const server = heldServer();
    const { run } = classifyStart(doc, RS_LINE);
    const builds = await counting('buildFileIndex', async () => {
      const p = run();
      await sleep(0);
      server.release();
      if (edited) setImmediate(() => doc.applyEdit(0, 0, ' '));
      await p;
    });
    assert.equal(builds, edited ? 0 : 1, edited ? 'the index of the old text is not built' : 'positive control');
  }
  for (const edited of [false, true]) {
    const doc = new stub.TextDocument(SAMPLE_RS, 'rust', `file:///queued-none-${edited}.rs`);
    const server = heldServer({ none: true });
    const { run } = classifyStart(doc, RS_LINE);
    const passes = await counting('classifyFromHeuristic', async () => {
      const p = run();
      await sleep(0);
      server.release();
      // One turn later: the answer is cached for this version, then the keystroke lands.
      if (edited) setImmediate(() => setImmediate(() => doc.applyEdit(0, 0, ' ')));
      await p;
    });
    assert.equal(passes > 0, !edited, edited ? 'no heuristic pass over the old text' : 'positive control');
  }
});

// ── One fetch per version, whoever cancels ────────────────────────────────────

test('fast navigation under a slow server issues one token request and still paints', async () => {
  const { doc, ed } = open(SAMPLE_RS, 'rust', 82, 12);
  show(ed);
  serveByVersion(doc, 300, () => RS_LSP.data);
  const d = new Decorator();
  // The capture is a detached file's (degraded), which also re-asks on a schedule:
  // render.test.js 'a degraded answer is asked again…'. Navigation alone is counted here.
  d.classifier.retrySchedule = [];
  const lines = SAMPLE_RS.split('\n');
  const stops = [82, 80, 78, 94, 95, 107, 120, 129, 82];
  for (const line of stops) {
    moveTo(d, ed, line, lines[line].search(/\S/) + 1);
    await sleep(100);
  }
  assert.equal(tokenRequests(), 1, `one request for version 1, got ${tokenRequests()}`);
  await sleep(500);
  assert.ok(band2(d, ed).length > 0, 'band 2 paints once the shared fetch lands');
  assert.equal(tokenRequests(), 1, 'navigating a cached version asks nothing more');
  d.dispose();
});

// ── Cold servers ─────────────────────────────────────────────────────────────

test('coldRetryDelay: backoff by attempt, null once spent', () => {
  assert.equal(coldRetryDelay(0, [1000, 2000]), 1000);
  assert.equal(coldRetryDelay(1, [1000, 2000]), 2000);
  assert.equal(coldRetryDelay(2, [1000, 2000]), null);
  assert.deepEqual(new Classifier().retrySchedule, [1000, 2000, 4000, 8000, 15000]);
});

test('a server that warms up after the first retries is picked up without an edit', async () => {
  const { doc, ed } = open(SAMPLE_RS, 'rust', 82, 12);
  show(ed);
  let warm = false;
  stub.clearLspResponses();
  stub.setLspHandler(async (cmd) => {
    if (!warm) return undefined; // no provider registered yet
    if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return RS_LSP.legend;
    if (cmd === 'vscode.provideDocumentSemanticTokens') return { data: RS_LSP.data };
    return [];
  });
  const d = new Decorator();
  d.classifier.retrySchedule = [100, 200, 400, 800];
  const sources = () => [...d.classCache.values()].map((e) => e.classification.source);
  click(d, ed);
  await sleep(300);
  const coldPaint = fmt(d, ed);
  assert.deepEqual([...new Set(sources())], ['heuristic'], 'the cold plan is the heuristic');
  setTimeout(() => { warm = true; }, 450);
  await sleep(1100);
  const warmPaint = fmt(d, ed);
  const warmSources = sources();
  d.dispose();
  assert.equal(doc.version, 1, 'no edit happened');
  assert.ok(warmSources.includes('lsp'), 'the heuristic plan was replaced by the semantic one');
  // The semantic plan for this caret: only the for-block's data identities.
  const names = new Set(warmPaint.map((s) => s.split('=')[1]));
  assert.deepEqual([...names].sort(), ['backoff', 'cfg', 'i']);
  // The heuristic painted nothing the server's tokens do not.
  for (const hit of coldPaint) assert.ok(warmPaint.includes(hit), `heuristic-only paint ${hit}`);
});

test('while a registered provider answers nothing, band 2 holds instead of painting the heuristic', async () => {
  const { doc, ed } = open(SAMPLE_RS, 'rust', 82, 12);
  show(ed);
  let tokens = false;
  stub.clearLspResponses();
  stub.setLspHandler(async (cmd) => {
    if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return RS_LSP.legend;
    if (cmd === 'vscode.provideDocumentSemanticTokens') return tokens ? { data: RS_LSP.data } : undefined;
    return [];
  });
  const d = new Decorator();
  d.classifier.retrySchedule = [150, 150, 150];
  click(d, ed);
  await sleep(120);
  assert.equal(d.machine.current, Phase.Focus);
  assert.equal(band2(d, ed).length, 0, 'no heuristic tints while the provider is loading');
  tokens = true;
  await sleep(300);
  assert.ok(band2(d, ed).length > 0, 'the provider answer paints');
  d.dispose();

  // A provider that never answers: once the schedule is spent the heuristic paints.
  const late = open(SAMPLE_RS, 'rust', 82, 12);
  show(late.ed);
  stub.clearLspResponses();
  stub.setLspHandler(async (cmd) => (cmd === 'vscode.provideDocumentSemanticTokensLegend' ? RS_LSP.legend : undefined));
  const e = new Decorator();
  e.classifier.retrySchedule = [40, 40];
  click(e, late.ed);
  await sleep(400);
  assert.ok(band2(e, late.ed).length > 0, 'heuristic paints after the schedule');
  e.dispose();
  assert.equal(doc.version, 1);
});

test('a hold keeps semantic tints on screen, never heuristic ones', async () => {
  const { doc, ed } = open(SAMPLE_RS, 'rust', 82, 12);
  show(ed);
  let state = 'none';
  stub.clearLspResponses();
  stub.setLspHandler(async (cmd) => {
    if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return state === 'none' ? undefined : RS_LSP.legend;
    if (cmd === 'vscode.provideDocumentSemanticTokens') return state === 'ok' ? { data: RS_LSP.data } : undefined;
    return [];
  });
  const d = new Decorator();
  d.classifier.retrySchedule = [100, 100, 100, 100, 100, 100];
  click(d, ed);
  await sleep(90);
  const heuristic = fmt(d, ed);
  assert.ok(heuristic.length > 0, 'before the provider registers, the heuristic paints');

  state = 'empty'; // registered, still indexing
  await sleep(150);
  assert.deepEqual(fmt(d, ed), [], 'the heuristic tints come off while the provider is silent');

  state = 'ok';
  await sleep(150);
  const semantic = fmt(d, ed);
  assert.deepEqual([...new Set(semantic.map((s) => s.split('=')[1]))].sort(), ['backoff', 'cfg', 'i']);

  // Mid-typing the server answers the new version with nothing: the semantic tints stay.
  state = 'empty';
  const at = doc.offsetAt(ed.selection.active);
  d.onEdit(doc.applyEdit(at, at, ' '));
  await sleep(250);
  assert.ok(band2(d, ed).length > 0, 'semantic tints held through an empty answer');
  d.dispose();
});

test('once a language spends a schedule with no provider, its other documents are not retried', async () => {
  stub.clearLspResponses();
  const src = 'fun main() {\n    val a = 1\n    val b = a + 2\n    println(a + b)\n}\n';
  const first = open(src, 'kotlin', 2, 8);
  show(first.ed);
  const d = new Decorator();
  d.classifier.retrySchedule = [30, 30];
  click(d, first.ed);
  await sleep(300);
  assert.equal(tokenRequests(), 3, 'first document: one fetch and two retries');

  const second = open(src, 'kotlin', 2, 8);
  show(second.ed);
  d.refresh();
  click(d, second.ed);
  await sleep(300);
  assert.equal(tokenRequests(), 4, 'second document: one fetch, no retries');
  assert.ok(band2(d, second.ed).length > 0, 'and the heuristic paints at once');

  // A provider that shows up later takes the language off the list.
  stub.setLspResponses({ 'vscode.provideDocumentSemanticTokensLegend': { tokenTypes: ['variable'], tokenModifiers: [] } });
  const third = open(src, 'kotlin', 2, 8);
  show(third.ed);
  d.refresh();
  click(d, third.ed);
  await sleep(300);
  assert.equal(tokenRequests(), 7, 'a registered but silent provider gets the schedule again');
  d.dispose();
});

test('a language with no provider costs one fetch per version once the schedule is spent', async () => {
  const src = 'fun main() {\n    val a = 1\n    val b = a + 2\n    println(a + b)\n}\n';
  const { doc, ed } = open(src, 'kotlin', 2, 8);
  show(ed);
  stub.clearLspResponses();
  const d = new Decorator();
  d.classifier.retrySchedule = [30, 30];
  click(d, ed);
  await sleep(400);
  const before = tokenRequests();
  assert.equal(before, 3, `first fetch plus two retries, got ${before}`);
  for (let i = 0; i < 3; i++) {
    const at = doc.offsetAt(ed.selection.active);
    d.onEdit(doc.applyEdit(at, at, ' '));
    await sleep(300);
  }
  assert.equal(tokenRequests() - before, 3, `3 edit pauses, 3 fetches; got ${tokenRequests() - before}`);
  d.dispose();
});

// ── A reopened document is a new document ────────────────────────────────────

test('reopening a changed file at version 1 never reuses the old plan', async () => {
  stub.clearLspResponses();
  const v1 = 'function load(path) {\n  const retries = 3;\n  const cfg = read(path);\n  return cfg.retries + retries + cfg;\n}\n';
  // Changed while closed: a comment line inside the function, so the block keeps its key.
  const v2 = v1.replace('{\n', '{\n  // retries come from the config file; see docs for the format\n');
  const uri = 'file:///w/load.js';
  const first = open(v1, 'javascript', 2, 8, uri);
  show(first.ed);
  const d = new Decorator();
  click(d, first.ed);
  await sleep(200);
  assert.ok(band2(d, first.ed).length > 0, 'positive control: the first open paints');

  stub.events.closeDocument.fire(first.doc);
  const again = open(v2, 'javascript', 3, 8, uri);
  show(again.ed);
  d.refresh();
  click(d, again.ed);
  await sleep(200);
  const got = fmt(d, again.ed);
  d.dispose();

  const fresh = open(v2, 'javascript', 3, 8, 'file:///w/fresh.js');
  show(fresh.ed);
  const f = new Decorator();
  click(f, fresh.ed);
  await sleep(200);
  const want = fmt(f, fresh.ed);
  f.dispose();
  for (const s of got) assert.match(s, /=[A-Za-z_]\w*$/, `painted off an identifier: ${s}`);
  assert.deepEqual(got, want);
});

// ── Self is a code mark ──────────────────────────────────────────────────────

test('this/self in prose files are never painted', async () => {
  stub.clearLspResponses();
  for (const [lang, text] of [
    ['markdown', '# Notes\n\nThis section explains how this works.\nIn this case the parser calls itself.\n'],
    ['git-commit', 'Fix the bug where this crashed\n\nself-check now runs first.\n'],
    ['plaintext', 'self and this, as words.\n'],
  ]) {
    const { ed } = open(text, lang, 1, 0);
    show(ed);
    const d = new Decorator();
    await sleep(0);
    assert.equal(count(ed, d.pool.self), 0, `${lang}: no self marks`);
    d.dispose();
  }
  const { ed } = open('class A {\n  f() { return this.x; }\n}\n', 'typescript', 0, 0);
  show(ed);
  const d = new Decorator();
  await sleep(0);
  assert.equal(count(ed, d.pool.self), 1, 'positive control: code paints its `this`');
  d.dispose();
});

// ── The top-level scope is the code outside the bodies ───────────────────────

const TOP = [
  'const LIMIT = 10;',
  'async function load(p: string) {',
  '  const n = 25;',
  '  const r = await fetch(p) as any;',
  '  return r + n;',
  '}',
  '',
  'const PAD = 100;',
  '',
].join('\n');

async function engagedAt(text, lang, line, character) {
  const { doc, ed } = open(text, lang, line, character);
  show(ed);
  const d = new Decorator();
  d.engaged.add(doc.uri.toString());
  await d.runClassify(doc);
  return { d, doc, ed, paint: (phase) => { d.machine.phase = phase; d.render(); } };
}

test('a top-level caret paints no gutter, clay or band-3 mark inside function bodies', async () => {
  stub.clearLspResponses();
  const top = await engagedAt(TOP, 'typescript', 0, 6);
  top.paint(Phase.Edit);
  const gutter = (h) => (h.ed.live.get(h.d.gutterDecoration) ?? []).map((r) => [r.start.line, r.start.character, r.end.line, r.end.character]);
  // One range per run of lines, ending at the run's last line end (VS Code draws the
  // icon on every line, and every wrapped row, a range covers).
  assert.deepEqual(gutter(top), [[0, 0, 0, 17], [6, 0, 8, 0]], 'gutter: top-level lines only');
  assert.deepEqual((top.ed.live.get(top.d.pool.numberEngaged) ?? []).map((r) => textOf(top.doc, r)), ['10', '100']);
  assert.equal(count(top.ed, top.d.pool.riskAsync), 0, 'the await inside load() is not top level');
  assert.equal(count(top.ed, top.d.pool.riskDanger), 0, 'nor the `as any`');
  top.d.dispose();

  const inner = await engagedAt(TOP, 'typescript', 3, 6);
  inner.paint(Phase.Edit);
  assert.deepEqual(gutter(inner), [[1, 0, 5, 1]], 'gutter: the whole block, closing brace included');
  assert.deepEqual((inner.ed.live.get(inner.d.pool.numberEngaged) ?? []).map((r) => textOf(inner.doc, r)), ['25']);
  assert.ok(count(inner.ed, inner.d.pool.riskAsync) > 0 && count(inner.ed, inner.d.pool.riskDanger) > 0,
    'positive control: inside the function the marks paint');
  inner.d.dispose();
});

test('topLevelLines: code lines outside the excludes, and blank lines between them', () => {
  const blocks = focus.scanBlocks(TOP, 'typescript');
  const ex = focus.topLevelExcludes(TOP, blocks);
  assert.deepEqual(focus.topLevelLines(TOP, lexFor(TOP, 'typescript').lineStarts, ex), [0, 6, 7, 8]);
  assert.ok(focus.inSortedRanges(ex, TOP.indexOf('25')));
  assert.ok(!focus.inSortedRanges(ex, TOP.indexOf('100')));
});

// ── Only source documents are painted ────────────────────────────────────────

test('isDecoratable: source schemes only', () => {
  for (const s of ['file', 'untitled', 'vscode-remote', 'vscode-vfs', 'vscode-notebook-cell']) {
    assert.ok(isDecoratable({ uri: { scheme: s } }), s);
  }
  for (const s of ['output', 'debug', 'vscode-scm', 'comment', 'search-editor', 'git']) {
    assert.ok(!isDecoratable({ uri: { scheme: s } }), s);
  }
});

test('focusing the debug Output channel neither paints it nor feeds itself', async () => {
  stub.clearLspResponses();
  const out = open('', 'Log', 0, 0, 'output:extension-output-kaievns.okibi-#1-Okibi%20Dynamic%20Debug');
  const code = open(SAMPLE_RS, 'rust', 82, 12);
  let appended = 0;
  let d;
  const realChannel = vs.window.createOutputChannel;
  vs.window.createOutputChannel = () => ({
    appendLine: (msg) => {
      appended++;
      // VS Code reports every appended line as an edit of the channel's document.
      queueMicrotask(() => d?.onEdit(out.doc.applyEdit(out.doc.getText().length, out.doc.getText().length, `${msg}\n`)));
    },
    show() {},
    dispose() {},
  });
  stub.setConfig('debug', true);
  try {
    show(code.ed, out.ed);
    d = new Decorator();
    click(d, code.ed);
    await sleep(150);
    assert.ok(appended > 0, 'positive control: the debug channel is live');
    show(out.ed, code.ed);
    stub.events.activeEditor.fire(out.ed);
    click(d, out.ed);
    const before = appended;
    await sleep(300);
    assert.ok(appended - before < 20, `no feedback loop: ${appended - before} lines in 300 ms`);
    assert.equal(d.pool.banded().reduce((n, t) => n + count(out.ed, t), 0), 0, 'the channel is not painted');
    assert.equal(count(code.ed, d.pool.id[0]) + count(code.ed, d.gutterDecoration), 0, 'focus left the code editor');
    assert.notEqual(d.machine.current, Phase.Edit, 'appended lines are not typing');
  } finally {
    d?.dispose();
    stub.setConfig('debug', false);
    vs.window.createOutputChannel = realChannel;
  }
});

// ── Focus leaving the editors withdraws the bands now ────────────────────────

test('focus moving to a webview withdraws band 2 and the gutter at once, keeps band 1', async () => {
  const { doc, ed } = open(SAMPLE_RS, 'rust', 82, 12);
  show(ed);
  serveByVersion(doc, 0, () => RS_LSP.data);
  const d = new Decorator();
  click(d, ed);
  await sleep(200);
  assert.ok(band2(d, ed).length > 0 && count(ed, d.gutterDecoration) > 0, 'positive control: Focus painted');
  vs.window.activeTextEditor = undefined; // webview, preview or settings UI
  stub.events.activeEditor.fire(undefined);
  await sleep(0);
  assert.equal(band2(d, ed).length, 0, 'tints withdrawn');
  assert.equal(count(ed, d.gutterDecoration), 0, 'gutter withdrawn');
  assert.ok(count(ed, d.pool.self) > 0, 'band 1 stays');
  d.dispose();
});

// ── Band 1 on every visible editor ───────────────────────────────────────────

test('band 1 paints every visible split and survives a pool rebuild; config changes keep the pool', async () => {
  stub.clearLspResponses();
  const a = open(SAMPLE_RS, 'rust', 82, 12);
  const b = open(SAMPLE_RS, 'rust', 53, 10);
  show(a.ed, b.ed);
  const d = new Decorator();
  await sleep(0);
  assert.ok(count(b.ed, d.pool.self) > 0 && count(b.ed, d.pool.placeholder) > 0, 'the inactive split has band 1');
  assert.equal(count(b.ed, d.pool.self), count(a.ed, d.pool.self));

  const pool = d.pool;
  stub.events.configuration.fire({ affectsConfiguration: (k) => k.startsWith('okibiDynamic') });
  await sleep(0);
  assert.equal(d.pool, pool, 'a dwell or debug change does not rebuild the decoration types');

  vs.window.activeColorTheme.kind = 1;
  try {
    stub.events.colorTheme.fire({ kind: 1 });
    await sleep(0);
    assert.notEqual(d.pool, pool, 'a theme flip rebuilds the pool');
    assert.ok(count(b.ed, d.pool.self) > 0 && count(b.ed, d.pool.placeholder) > 0, 'and repaints the inactive split');
  } finally {
    vs.window.activeColorTheme.kind = 2;
    d.dispose();
  }
});

// ── Edits the user did not type ──────────────────────────────────────────────

test('isTypingEdit: every change must touch a cursor line', () => {
  const r = (a, b = a) => ({ start: { line: a }, end: { line: b } });
  assert.equal(isTypingEdit([r(4)], [r(4)]), true, 'a keystroke');
  assert.equal(isTypingEdit([r(3, 4)], [r(4)]), true, 'backspace joining lines');
  const enter = { ...r(4), text: '\n    ' };
  assert.equal(isTypingEdit([enter], [r(4)]), true, 'Enter, selection read before the edit');
  assert.equal(isTypingEdit([enter], [r(5)]), true, 'Enter, selection read after the edit');
  assert.equal(isTypingEdit([{ ...r(4), text: 'a\nb\nc' }], [r(6)]), true, 'a multi-line paste');
  assert.equal(isTypingEdit([{ ...r(4), text: 'x' }], [r(5)]), false, 'one line below a one-line change');
  assert.equal(isTypingEdit([r(2), r(7)], [r(2), r(7)]), true, 'multi-cursor typing');
  assert.equal(isTypingEdit([r(4), r(0)], [r(4)]), false, 'a completion with an auto-import');
  assert.equal(isTypingEdit([r(4), r(9), r(12)], [r(4)]), false, 'rename');
  assert.equal(isTypingEdit([r(9)], [r(4)]), false, 'an edit elsewhere');
  assert.equal(isTypingEdit([], [r(4)]), false);
});

test('format on save, rename and edits off the cursor neither engage nor enter Edit', async () => {
  stub.clearLspResponses();
  const src = 'function f(a) {\n  const b = a + 1;\n  return b + a;\n}\n\nconst z = 1;\n';
  const { doc, ed } = open(src, 'javascript', 1, 4);
  show(ed);
  const d = new Decorator();
  await sleep(100);

  // Unengaged: a formatter edit does not engage the document.
  d.onEdit(doc.applyEdit(0, 0, ' '));
  assert.ok(!d.engaged.has(doc.uri.toString()), 'a programmatic edit does not engage');

  click(d, ed);
  assert.equal(d.machine.current, Phase.Focus);
  stub.events.willSave.fire({ document: doc });
  const at = doc.offsetAt(ed.selection.active);
  d.onEdit(doc.applyEdit(at, at, ' ')); // the formatter touches the caret line too
  assert.equal(d.machine.current, Phase.Focus, 'format on save stays in Focus');
  stub.events.didSave.fire(doc);

  const far = doc.offsetAt(new vs.Position(5, 0));
  d.onEdit(doc.applyEdit(far, far, '  '));
  assert.equal(d.machine.current, Phase.Focus, 'an edit on a line no cursor is on stays in Focus');

  const here = doc.offsetAt(ed.selection.active);
  d.onEdit(doc.applyEdit(here, here, 'x'));
  assert.equal(d.machine.current, Phase.Edit, 'positive control: typing enters Edit');
  d.dispose();
});

// ── Legend and tokens from different providers ───────────────────────────────

test('tokensFitLegend: rejects type indexes and modifier bits the legend lacks', () => {
  assert.equal(classify.tokensFitLegend([0, 0, 3, 1, 0b11], 2, 2), true);
  assert.equal(classify.tokensFitLegend([0, 0, 3, 2, 0], 2, 2), false, 'type index out of range');
  assert.equal(classify.tokensFitLegend([0, 0, 3, 1, 0b100], 2, 2), false, 'modifier bit out of range');
  assert.equal(classify.tokensFitLegend([0, 0, 3, 1], 2, 2), false, 'truncated tuple');
});

test('tokens from another provider are not decoded with this legend', async () => {
  const { doc } = open(SAMPLE_RS, 'rust', 82, 12);
  const blocks = focus.scanBlocks(SAMPLE_RS, 'rust');
  const block = focus.innermostBlock(blocks, 82, doc.offsetAt(new vs.Position(82, 12)), SAMPLE_RS);
  stub.clearLspResponses();
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': { tokenTypes: ['variable'], tokenModifiers: [] },
    'vscode.provideDocumentSemanticTokens': { data: RS_LSP.data },
    'vscode.executeDocumentSymbolProvider': [],
  });
  const r = await new Classifier().classifyScope(doc, block, 5, { isCancellationRequested: false });
  assert.equal(r.semantic, 'empty');
  assert.equal(r.focused.source, 'heuristic');
});

// ── Tokens inside comments, Go doc links ─────────────────────────────────────

function commentHits(src, lang, ed, types) {
  const spans = lexFor(src, lang).spans.filter((s) => s.region === 'comment' || s.region === 'doc');
  return types.flatMap((t) => ed.live.get(t) ?? []).filter((r) => {
    const a = ed.document.offsetAt(r.start);
    const b = ed.document.offsetAt(r.end);
    return spans.some((s) => a < s.end && b > s.start);
  }).map((r) => `${r.start.line}:${r.start.character} ${textOf(ed.document, r)}`);
}

test('rust-analyzer doctest tokens never tint inside a doc comment', async () => {
  const src = fs.readFileSync(path.join(FIX, 'doctest.rs'), 'utf8');
  const lsp = JSON.parse(fs.readFileSync(path.join(FIX, 'doctest.rs.lsp.json'), 'utf8'));
  // LSP SymbolKind is VS Code's plus one.
  const symbols = lsp.symbols.map((s) => ({ name: s.name, kind: s.kind - 1,
    location: { range: new vs.Range(s.location.range.start.line, s.location.range.start.character, s.location.range.end.line, s.location.range.end.character) } }));
  stub.clearLspResponses();
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': lsp.legend,
    'vscode.provideDocumentSemanticTokens': { data: lsp.data },
    'vscode.executeDocumentSymbolProvider': symbols,
  });
  const { ed } = open(src, 'rust', 11, 18);
  show(ed);
  const d = new Decorator();
  click(d, ed);
  await sleep(200);
  assert.deepEqual(commentHits(src, 'rust', ed, [...d.pool.id, ...d.pool.idg]), []);
  assert.deepEqual([...new Set(band2(d, ed).map((r) => textOf(ed.document, r)))].sort(), ['count', 'total'],
    'positive control: the body tints its data');
  d.dispose();
});

test('gopls doc-link tokens never tint inside a comment', async () => {
  const src = fs.readFileSync(path.join(FIX, 'doclinks.go'), 'utf8');
  const served = stub.encodeTokens(src, JSON.parse(fs.readFileSync(path.join(FIX, 'doclinks.go.tokens.json'), 'utf8')));
  const fnLine = src.split('\n').findIndex((l) => l.startsWith('func Retry'));
  stub.clearLspResponses();
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': served.legend,
    'vscode.provideDocumentSemanticTokens': { data: served.data },
    'vscode.executeDocumentSymbolProvider': [{ name: 'Retry', kind: 11, location: { range: new vs.Range(fnLine, 0, fnLine + 4, 1) } }],
  });
  const { ed } = open(src, 'go', fnLine + 3, 10);
  show(ed);
  const d = new Decorator();
  click(d, ed);
  await sleep(200);
  assert.deepEqual(commentHits(src, 'go', ed, [...d.pool.id, ...d.pool.idg]), []);
  assert.ok(band2(d, ed).some((r) => textOf(ed.document, r) === 'MaxRetries'), 'positive control: the code read tints');
  d.dispose();
});

test('buildFileIndex: a data token in a comment or with a comment modifier is not an occurrence', () => {
  const src = 'fn f(count: u32) -> u32 {\n    // count is bumped\n    count + count\n}\n';
  const uses = [...src.matchAll(/count/g)].map((m) => m.index); // decl, comment, use, use
  const tok = (offset, modifiers = []) => ({ name: 'count', offset, length: 5, type: 'parameter', modifiers });
  const idx = classify.buildFileIndex(src, [
    tok(uses[0], ['declaration']),
    tok(uses[1]),
    tok(uses[2], ['injected']),
    tok(uses[3]),
  ], [], 'rust');
  assert.deepEqual(idx.occurrences.get('count').map((r) => r.start), [uses[0], uses[3]]);
});

test('goDocLinkSpans: the names inside [links] in comments only', () => {
  const src = fs.readFileSync(path.join(FIX, 'doclinks.go'), 'utf8');
  const got = goDocLinkSpans(src, lexFor(src, 'go')).map((s) => src.slice(s.start, s.end));
  assert.deepEqual(got, ['MaxRetries', 'strings.Repeat', 'MaxRetries']);
  const code = 'package p\nvar x = m[key] // see [*bytes.Buffer] and [naïve]\n';
  assert.deepEqual(goDocLinkSpans(code, lexFor(code, 'go')).map((s) => code.slice(s.start, s.end)), ['bytes.Buffer', 'naïve']);
});

test('doc links repaint in comment colour, in every phase, Go only (other brackets: Rust, JavaScript, TypeScript)', async () => {
  stub.clearLspResponses();
  const src = fs.readFileSync(path.join(FIX, 'doclinks.go'), 'utf8');
  const h = await engagedAt(src, 'go', 13, 10);
  const counts = [Phase.Survey, Phase.Focus, Phase.Edit].map((p) => { h.paint(p); return count(h.ed, h.d.pool.commentRestore); });
  assert.deepEqual(counts, [3, 3, 3]);
  assert.ok(!h.d.pool.banded().includes(h.d.pool.commentRestore) && h.d.pool.all().includes(h.d.pool.commentRestore), 'band 1');
  h.d.dispose();
  const ts = await engagedAt('// see [Name]\nval Name = 1\n', 'kotlin', 1, 0);
  ts.paint(Phase.Focus);
  assert.equal(count(ts.ed, ts.d.pool.commentRestore), 0, 'not for other languages');
  ts.d.dispose();
  const opts = (dark) => {
    const before = stub.createdTypes.length;
    require('../out/tokens').buildDecorationPool(dark);
    return stub.createdTypes.slice(before).find((t) => t.options.fontStyle === 'italic').options;
  };
  assert.deepEqual([opts(true).color, opts(false).color], [TOKENS.comment.dark, TOKENS.comment.light]);
  assert.deepEqual([TOKENS.comment.dark, TOKENS.comment.light], ['#646a70', '#8b857d'], 'the theme comment colours');
});

// The leftover the theme repo's real-editor `theme-closed` scenario measured in VS
// Code 1.144.1: after a theme change with no editor showing the file, bracket-pair
// colorization painted these brackets at their level colour (docs/runtime.md).
const RS_COMMENT_BRACKETS = [
  '//! See [`add`] and [`Config::name`].',
  '// plain f(y) {z}',
  '/* block g(1) [2] */',
  '/// ```',
  '/// let mut v: Vec<u32> = Vec::new();',
  '/// assert_eq!(v.len(), 1);',
  '/// ```',
  'pub fn add(a: u32, b: [u8; 2]) -> u32 {',
  '    let s = "(a) [b] {c}"; // tail (x)',
  '    a + b[0] as u32',
  '}',
  '',
].join('\n');

test('commentBracketSpans: every bracket in a comment or doc span, none in code or strings', () => {
  const got = commentBracketSpans(RS_COMMENT_BRACKETS, lexFor(RS_COMMENT_BRACKETS, 'rust'))
    .map((s) => `${RS_COMMENT_BRACKETS.slice(0, s.start).split('\n').length}:${RS_COMMENT_BRACKETS[s.start]}`);
  assert.deepEqual(got, [
    '1:[', '1:]', '1:[', '1:]', '2:(', '2:)', '2:{', '2:}', '3:(', '3:)', '3:[', '3:]',
    '5:(', '5:)', '6:(', '6:(', '6:)', '6:)', '9:(', '9:)',
  ]);
  assert.ok(got.every((g) => g.length === 3), 'one character per span');
});

test('brackets in Rust comments repaint in comment colour, in every phase, Rust, Go, JavaScript and TypeScript only', async () => {
  stub.clearLspResponses();
  const h = await engagedAt(RS_COMMENT_BRACKETS, 'rust', 8, 9);
  const painted = () => (h.ed.live.get(h.d.pool.commentRestore) ?? []).map((r) => `${r.start.line + 1}:${textOf(h.ed.document, r)}`);
  const want = commentBracketSpans(RS_COMMENT_BRACKETS, lexFor(RS_COMMENT_BRACKETS, 'rust'))
    .map((s) => `${RS_COMMENT_BRACKETS.slice(0, s.start).split('\n').length}:${RS_COMMENT_BRACKETS[s.start]}`);
  for (const p of [Phase.Survey, Phase.Focus, Phase.Edit]) {
    h.paint(p);
    assert.deepEqual(painted(), want, `phase ${p}`);
  }
  h.d.dispose();
  const ts = await engagedAt('// see f(x) [y]\nval x = listOf(1)\n', 'kotlin', 1, 0);
  ts.paint(Phase.Focus);
  assert.equal(count(ts.ed, ts.d.pool.commentRestore), 0, 'not for other languages');
  ts.d.dispose();
  const go = await engagedAt('package p\n\n// Run calls f(x) and [Start].\nfunc Run() {}\n', 'go', 3, 0);
  go.paint(Phase.Survey);
  assert.deepEqual((go.ed.live.get(go.d.pool.commentRestore) ?? []).map((r) => textOf(go.ed.document, r)), ['Start'],
    'Go keeps the doc-link names only');
  go.d.dispose();
});

// The theme repo's real-editor `theme-closed` probe (rust-analyzer 0.3.3105 in a
// cargo workspace, VS Code 1.144.1): every bracket below took a bracket-pair level
// after the theme changed with no editor showing the file. The positions are those
// the editor painted string green at rest, in Okibi and Akari alike.
const RS_STRING_BRACKETS = [
  'static PAREN: &str = "(a) [b] {c}";',
  'static ESC: &str = "\\u{2603} \\\\(e) \\"[q]\\" {{d}}";',
  'static RAW: &str = r#"(r) [s] {t} "{u}""#;',
  'static BYTES: &[u8] = b"(b) {c}";',
  "static CH: char = '(';",
  'fn probe_fmt() -> String { format!("({}) {{lit}} [{:?}] {x} \\u{2603}", 1, 2, x = 3) }',
  '',
].join('\n');
const lineCols = (text, spans) => spans.map((s) => {
  const line = text.slice(0, s.start).split('\n').length;
  return `${line}:${s.start - text.lastIndexOf('\n', s.start - 1)}${text[s.start]}`;
});

test('rustStringBracketSpans: the brackets in strings that rest in string colour', () => {
  const { rustStringBracketSpans } = require('../out/placeholders');
  const got = (semantic) => lineCols(RS_STRING_BRACKETS, rustStringBracketSpans(RS_STRING_BRACKETS, semantic)).join(' ');
  const plain = '1:23( 1:25) 1:27[ 1:29] 2:23{ 2:28} 2:32( 2:34) 2:38[ 2:40] 2:44{ 2:48} '
    + '3:23( 3:25) 3:27[ 3:29] 3:31{ 3:33} 3:36{ 3:38} 4:25( 4:27) 5:20( 6:37( 6:40) 6:42{ 6:48} 6:50[ 6:55] 6:63{ 6:68}';
  // With rust-analyzer's `string` token over a non-format string, a `{…}` the grammar
  // scopes as an interpolation rests string green too: `{c}`, the inner `{d}`.
  assert.equal(got(true), plain.replace('2:44{ 2:48}', '2:44{ 2:45{ 2:47} 2:48}')
    .replace('1:29]', '1:29] 1:31{ 1:33}').replace('4:27)', '4:27) 4:29{ 4:31}'));
  // Without a server the grammar's interpolation scope (placeholder steel) shows.
  assert.equal(got(false), plain);
  // Never painted: the format holes `{}` `{:?}` `{x}`, and `{{lit}}`'s inner braces,
  // which rust-analyzer types `escapeSequence` in a loaded workspace (no theme style,
  // so the grammar's steel) and leaves inside one `string` token before it loads.
  assert.ok(!/6:38|6:39|6:43|6:47|6:51|6:57/.test(got(true)));
  assert.deepEqual(rustStringBracketSpans('fn f() { let v = [1]; } // "(x)"\n', true), [], 'code and comments are not strings');
});

test('rustStringBracketSpans: a unicode escape the grammar reads rests in string colour', () => {
  const { rustStringBracketSpans } = require('../out/placeholders');
  // Line 1 is the e2e fixture's line 15. The theme's string injection reads Rust's
  // unicode escape, 1 to 6 digits each followed by any `_`, in every string but a
  // byte string, which keeps rust-syntax's 4 to 6 digits. What neither reads
  // (7 digits, `b"\u{41}"`) leaves a `{…}` the grammar's interpolation, and
  // rust-analyzer 0.3.3105 types it `invalidEscapeSequence`, no theme style. The
  // painted set is the set the theme's TextMate paint gives string green.
  const src = [
    'static ESCAPES: &str = "\\u{2603} \\u{41}";',
    'static MORE: &str = "\\u{1F600} \\u{1_F6} \\u{1_0_F_6_0_0} \\u{1234567}";',
    'static BYTES: &[u8] = b"\\u{41} \\u{1F600}";',
    'static CSTR: &CStr = c"\\u{41}";',
    'fn f() { println!("\\u{41} {}", 1); }',
    '',
  ].join('\n');
  for (const semantic of [false, true]) {
    assert.equal(lineCols(src, rustStringBracketSpans(src, semantic)).join(' '),
      '1:27{ 1:32} 1:36{ 1:39} 2:24{ 2:30} 2:34{ 2:39} 2:43{ 2:55} 3:34{ 3:40} 4:26{ 4:29} 5:22{ 5:25}',
      `semantic ${semantic}`);
  }
});

test('rustStringBracketSpans: linear in the file', () => {
  const { growth } = require('./cpu-time');
  const { rustStringBracketSpans } = require('../out/placeholders');
  const line = '    let s = "(a) [b] {c}"; println!("({}) {{x}}", n);';
  const src = (n) => `fn f(n: u32) {\n${Array.from({ length: n }, () => line).join('\n')}\n}\n`;
  assert.equal(rustStringBracketSpans(src(10), true).length, 10 * 10);
  const ratio = growth(src, (t) => rustStringBracketSpans(t, true), 2000);
  assert.ok(ratio < 24, `8x the lines cost ${ratio.toFixed(1)}x (a scan to the end of the file per string costs 64x)`);
});

test('a backslash escape is one character of a format string, not a placeholder', () => {
  const { rustPlaceholderSpans, rustInlineArgs } = require('../out/placeholders');
  const holes = (src) => rustPlaceholderSpans(src).map((s) => src.slice(s.start, s.end));
  assert.deepEqual(holes('fn f() { println!("\\u{2603} {x}"); }'), ['{x}']);
  assert.deepEqual(holes('fn f() { println!("\\\\{x} \\x41{y}"); }'), ['{x}', '{y}'], 'an escaped backslash ends before the brace');
  assert.deepEqual(holes('fn f() { println!(r"\\u{0} {x}"); }'), ['{0}', '{x}'], 'a raw string has no escapes');
  assert.deepEqual(rustInlineArgs('fn f(beef: u8) { println!("\\u{beef}"); }'), [], '`\\u{beef}` reads no binding');
});

test('brackets in Rust strings repaint in string colour, in every phase, Rust only', async () => {
  stub.clearLspResponses();
  const { rustStringBracketSpans } = require('../out/placeholders');
  const h = await engagedAt(RS_STRING_BRACKETS, 'rust', 5, 30);
  const painted = (x) => (x.ed.live.get(x.d.pool.stringRestore) ?? []).map((r) => `${r.start.line + 1}:${r.start.character + 1}${textOf(x.ed.document, r)}`);
  const want = (semantic) => lineCols(RS_STRING_BRACKETS, rustStringBracketSpans(RS_STRING_BRACKETS, semantic));
  for (const p of [Phase.Survey, Phase.Focus, Phase.Edit]) {
    h.paint(p);
    assert.deepEqual(painted(h), want(false), `no server, phase ${p}`);
  }
  assert.ok(!h.d.pool.banded().includes(h.d.pool.stringRestore) && h.d.pool.all().includes(h.d.pool.stringRestore), 'band 1');
  h.d.dispose();

  const toks = [{ name: '"(a) [b] {c}"', type: 'string', modifiers: [], offset: RS_STRING_BRACKETS.indexOf('"(a)'), length: 13 }];
  const enc = stub.encodeTokens(RS_STRING_BRACKETS, toks);
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': enc.legend,
    'vscode.provideDocumentSemanticTokens': { data: enc.data },
    'vscode.executeDocumentSymbolProvider': [],
  });
  const s = await engagedAt(RS_STRING_BRACKETS, 'rust', 5, 30);
  s.paint(Phase.Survey);
  assert.deepEqual(painted(s), want(true), 'a provider answered: interpolation-scoped brackets too');
  s.d.dispose();
  stub.clearLspResponses();

  const ts = await engagedAt('const s = "(a) [b]";\n', 'typescript', 0, 0);
  ts.paint(Phase.Focus);
  assert.equal(count(ts.ed, ts.d.pool.stringRestore), 0, 'not for other languages');
  ts.d.dispose();
  const opts = (dark) => {
    const before = stub.createdTypes.length;
    require('../out/tokens').buildDecorationPool(dark);
    return stub.createdTypes.slice(before).filter((t) => t.options.color === TOKENS.string[dark ? 'dark' : 'light']);
  };
  assert.equal(opts(true).length, 1, 'one decoration type in string colour');
  assert.deepEqual([opts(true)[0].options.fontWeight, opts(true)[0].options.fontStyle], ['normal', undefined]);
  assert.deepEqual([TOKENS.string.dark, TOKENS.string.light], ['#8ecd92', '#257231'], 'the theme string colours');
});

test('moving between two arrows on one line reclassifies: each paints its own parameter', async () => {
  const src = 'export function pick(items: number[], limit: number): number[] {\n  return items.map((x) => x * 2 + x).filter((y) => y > limit && y < 99);\n}\n';
  const seen = new Set();
  const toks = focus.lexIdentifiers(src, 0, src.length, 'typescript')
    .filter((i) => ['items', 'limit', 'x', 'y'].includes(i.name))
    .map((i) => ({ ...i, type: 'parameter', modifiers: seen.has(i.name) ? [] : (seen.add(i.name), ['declaration']) }));
  const { legend, data } = stub.encodeTokens(src, toks);
  stub.clearLspResponses();
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': legend,
    'vscode.provideDocumentSemanticTokens': { data },
    'vscode.executeDocumentSymbolProvider': [{ kind: 11, name: 'pick', range: new vs.Range(0, 0, 2, 1), children: [] }],
  });
  const line = src.split('\n')[1];
  const { ed } = open(src, 'typescript', 1, line.indexOf('x * 2'));
  show(ed);
  const d = new Decorator();
  d.refresh();
  await sleep(50);
  const painted = () => [...new Set(band2(d, ed).map((r) => textOf(ed.document, r)))].sort();
  click(d, ed);
  await sleep(250);
  assert.deepEqual(painted(), ['x']);
  moveTo(d, ed, 1, line.indexOf('y > limit') + 1);
  await sleep(250);
  assert.deepEqual(painted(), ['limit', 'y']);
  d.dispose();
});

// ── Closing the last tab ends engagement ─────────────────────────────────────

const ENGAGE_SRC = 'function load(path) {\n  const retries = 3;\n  return read(path) + retries;\n}\n';

/** A fresh editor on `doc`, recording its paint like `open`. */
function editorOn(doc, line, character) {
  const ed = new stub.TextEditor(doc, line, character);
  ed.live = new Map();
  ed.setDecorations = (t, r) => ed.live.set(t, r);
  return ed;
}

/** VS Code reopening `doc`: a new editor activates, then its saved caret comes back with no `kind`. */
function reopen(d, doc, ...otherTabs) {
  const ed = editorOn(doc, 1, 8);
  stub.setTabs([stub.textTab(doc), ...otherTabs]);
  show(ed);
  stub.events.activeEditor.fire(ed);
  d.onSelection({ textEditor: ed, selections: ed.selections, kind: undefined });
  return ed;
}

test('closing the last tab ends engagement while the document stays loaded', async () => {
  // VS Code fires onDidCloseTextDocument when the model is disposed. A model any
  // extension opened with openTextDocument is held up to 3 minutes after its editor
  // closes, and reopening within that window hands back the same TextDocument. Its
  // restored caret then re-entered Focus and band 2 painted on a file just opened.
  stub.clearLspResponses();
  const { doc, ed } = open(ENGAGE_SRC, 'javascript', 1, 8);
  const tab = stub.textTab(doc);
  stub.setTabs([tab]);
  show(ed);
  const d = new Decorator();
  click(d, ed);
  await sleep(150);
  assert.equal(d.machine.current, Phase.Focus, 'positive control: engaged in Focus');
  assert.ok(band2(d, ed).length > 0, 'positive control: band 2 painted');

  stub.closeTab(tab);
  show();
  stub.events.activeEditor.fire(undefined);
  await sleep(0);
  const again = reopen(d, doc);
  await sleep(150);
  assert.equal(d.machine.current, Phase.Survey, 'reopened: Survey');
  assert.equal(band2(d, again).length, 0, 'reopened: no band 2');
  assert.equal(count(again, d.gutterDecoration), 0, 'reopened: no gutter');
  click(d, again);
  await sleep(150);
  assert.ok(band2(d, again).length > 0, 'a click engages it again');
  d.dispose();
});

test('a tab closing while another tab still shows the document keeps it engaged', async () => {
  // Returning to a tab you worked in is not a fresh viewing context: another group's
  // tab or either side of a diff still shows the file.
  stub.clearLspResponses();
  for (const other of [(doc) => stub.textTab(doc), (doc) => ({ input: { original: vs.Uri.parse('git:/x'), modified: doc.uri } })]) {
    const { doc, ed } = open(ENGAGE_SRC, 'javascript', 1, 8);
    const tab = stub.textTab(doc);
    const kept = other(doc);
    stub.setTabs([tab], [kept]);
    show(ed);
    const d = new Decorator();
    click(d, ed);
    await sleep(150);
    stub.closeTab(tab);
    show();
    stub.events.activeEditor.fire(undefined);
    const again = reopen(d, doc, kept);
    await sleep(150);
    assert.equal(d.machine.current, Phase.Focus, 'still engaged: the restored caret enters Focus');
    assert.ok(band2(d, again).length > 0);
    d.dispose();
  }
});

// ── A superseded version is collected ─────────────────────────────────────────

require('v8').setFlagsFromString('--expose-gc');
const gc = require('vm').runInNewContext('gc');

test('a superseded version is collected: its lex, file index and plans', async () => {
  // 100 keystrokes into a 50k-line file kept 98 MB: every earlier version's plans
  // stayed in the plan LRU (each holding that version's file index), its lex in the
  // lexer memo, and the bundle kept the decoded tokens the index was built from.
  // Three edits, then a full GC: only the current version may survive. The same for
  // a document edited while another one is active, and without a server.
  const { generate } = require('./perf-inputs');
  const input = generate('py', 2000, focus.scanBlocks);
  for (const server of [true, false]) {
    const { doc, ed } = open(input.text, input.languageId, 0, 0, `file:///runtime-mem-${server}.py`);
    const tokens = input.tokens.map((t) => ({ ...t }));
    stub.clearLspResponses();
    stub.setLspHandler((cmd) => {
      if (!server) return undefined;
      const enc = stub.encodeTokens(doc.getText(), tokens);
      if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return enc.legend;
      if (cmd === 'vscode.provideDocumentSemanticTokens') return { data: enc.data };
      if (cmd === 'vscode.executeDocumentSymbolProvider') return [];
      return undefined;
    });
    show(ed);
    const d = new Decorator();
    d.classifier.retrySchedule = [];
    const text = doc.getText();
    const fn = focus.scanBlocks(text, 'python').find((b) => b.depth === 0 && b.openOffset > text.length / 2);
    const lineEnd = text.indexOf('\n', text.indexOf('\n', fn.openOffset) + 1);
    moveTo(d, ed, doc.positionAt(lineEnd).line, 4);
    await sleep(150);

    const prefix = d.docPrefix(doc);
    const old = [];
    const remember = () => {
      const bundle = d.classifier.cache.get(doc);
      old.push(new WeakRef(d.blockCache.get(doc).lex));
      if (server) {
        assert.ok(bundle?.fileIndex, 'positive control: the version was classified from tokens');
        old.push(new WeakRef(bundle.fileIndex), new WeakRef(bundle.fileIndex.occurrences));
      }
      const plans = [...d.classCache].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
      assert.ok(plans.length > 0, 'positive control: the version has a plan');
      old.push(...plans.map((p) => new WeakRef(p)));
    };
    const typeAt = (off) => {
      for (const t of tokens) if (t.offset >= off) t.offset += 1;
      const ev = doc.applyEdit(off, off, ' ');
      ed.selection = new vs.Selection(doc.positionAt(off + 1).line, doc.positionAt(off + 1).character, doc.positionAt(off + 1).line, doc.positionAt(off + 1).character);
      d.onEdit(ev);
    };
    for (let i = 0; i < 3; i++) {
      remember();
      typeAt(lineEnd + i);
      await sleep(250);
    }
    // An edit landing while another document is active: a rename or a formatter.
    remember();
    const other = open('x = 1\n', 'python', 0, 0, `file:///runtime-mem-other-${server}.py`);
    show(other.ed);
    stub.events.activeEditor.fire(other.ed);
    await sleep(100);
    typeAt(lineEnd + 3);
    await sleep(50);

    await new Promise((r) => setImmediate(r));
    gc();
    const alive = old.filter((w) => w.deref() !== undefined).length;
    assert.equal(alive, 0, `server=${server}: ${alive} of ${old.length} objects of earlier versions are still reachable`);
    assert.ok([...d.classCache.keys()].filter((k) => k.startsWith(prefix)).every((k) => k.startsWith(`${prefix}${doc.version}::`)),
      'no plan of an earlier version is cached');
    show(ed);
    stub.events.activeEditor.fire(ed);
    await sleep(150);
    const bundle = d.classifier.cache.get(doc);
    assert.ok(d.blockCache.get(doc).lex, 'the current version is kept');
    if (server) {
      assert.ok(bundle.fileIndex, 'the current version is classified again');
      assert.equal(bundle.tokens, null, 'the decoded tokens go once the index is built');
    }
    d.dispose();
  }
  stub.clearLspResponses();
});

test('a superseded version is collected: re-lexed at increasing lines, its text goes too', async () => {
  // A re-lex kept the previous lex's identifiers before the edit, and a name of 13 or
  // more characters keeps alive the text it was cut from: 40 edits at increasing
  // lines of a 50k-line Rust file kept 107 MB. Strings take no WeakRef, so the heap
  // after a full GC may grow by less than one more text, not by ten. The event-loop
  // turns let the sweeper finish; without them the reading varies by 9 MB.
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      gc();
      await new Promise((r) => setImmediate(r));
    }
    gc();
  };
  const lexMod = require('../out/lex');
  const lines = [];
  for (let i = 0; i < 20000; i++) lines.push(`    let some_long_identifier_${i} = compute_something_long(another_long_name_${i});`);
  let text = `fn main() {\n${lines.join('\n')}\n}\n`;
  let cur = lexMod.lex(text, 'rust');
  await settle();
  const base = process.memoryUsage().heapUsed;
  const edits = 10;
  for (let k = 1; k <= edits; k++) {
    const at = text.indexOf('\n', Math.floor((text.length * k) / (edits + 1)));
    const next = `${text.slice(0, at)} ${text.slice(at)}`;
    cur = lexMod.relex(cur, next, at, at, at + 1);
    assert.ok(cur, 'positive control: the edit re-lexes');
    text = next;
  }
  await settle();
  const grown = process.memoryUsage().heapUsed - base;
  assert.ok(grown < text.length, `${(grown / 1e6).toFixed(1)} MB more after ${edits} edits of a ${(text.length / 1e6).toFixed(1)} MB text`);
  assert.equal(cur.idents.length, 80002);
});

test('a single change to a shown document re-lexes around it; the result is the full lex', async () => {
  const lexMod = require('../out/lex');
  const orig = lexMod.relex;
  const results = [];
  lexMod.relex = (...a) => {
    const r = orig(...a);
    results.push(r);
    return r;
  };
  try {
    const { doc, ed } = open(SAMPLE_RS, 'rust', 10, 0, 'file:///runtime-relex.rs');
    show(ed);
    stub.clearLspResponses();
    const d = new Decorator();
    await sleep(0);
    const at = doc.offsetAt(new vs.Position(40, 0));
    d.onEdit(doc.applyEdit(at, at, 'let z = "}"; // {\n'));
    await sleep(0);
    assert.equal(results.length, 1, 'the render after the edit re-lexes');
    assert.ok(results[0], 'from the previous version');
    assert.equal(d.blockCache.get(doc).lex, results[0]);
    const full = lexMod.lex(doc.getText(), 'rust');
    for (const k of ['spans', 'holes', 'idents', 'numbers', 'punct', 'lineStarts']) {
      assert.deepEqual(results[0][k], full[k], k);
    }
    assert.equal(lexFor(doc.getText(), 'rust'), results[0], 'every scanner of this version reads the same lex');

    // Two changes in one event, or two edits before a render: a full lex.
    d.onEdit(doc.applyEdit(at, at, 'a'));
    d.onEdit(doc.applyEdit(at, at, 'b'));
    await sleep(0);
    assert.equal(results.length, 1, 'no re-lex from a version that was never lexed');

    // A document no editor shows keeps no previous version for it.
    const other = open('fn g() {}\n', 'rust', 0, 0, 'file:///runtime-relex-other.rs');
    show(other.ed);
    stub.events.activeEditor.fire(other.ed);
    await sleep(0);
    d.onEdit(doc.applyEdit(at, at, 'c'));
    assert.equal(d.relexFrom.has(doc), false);
    d.dispose();
  } finally {
    lexMod.relex = orig;
  }
});

// ── Settings at runtime, timers and caches, on the fake clock ───────────────

/** Advance the fake clock in 10 ms steps, letting promises and microtasks run between them. */
async function flush(t, ms) {
  for (let left = ms; left > 0; left -= 10) {
    t.mock.timers.tick(Math.min(10, left));
    await new Promise((r) => setImmediate(r));
  }
}
const fakeClock = (t) => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
const configChanged = () => stub.events.configuration.fire({ affectsConfiguration: (k) => k.startsWith('okibiDynamic') });
const typeAtCaret = (d, ed, text = 'x') => {
  const at = ed.document.offsetAt(ed.selection.active);
  d.onEdit(ed.document.applyEdit(at, at, text));
};
const SAMPLE_PY = fs.readFileSync(path.join(__dirname, '../samples/sample.py'), 'utf8');
const JS_FN = 'function f(a) {\n  const n = 42;\n  return a + n;\n}\n';

test('okibiDynamic.enabled=false at runtime takes every mark off, band 1 included, and hides the status item', async (t) => {
  fakeClock(t);
  stub.clearLspResponses();
  const line = SAMPLE_PY.split('\n').findIndex((l) => l.includes('self.'));
  const { ed } = open(SAMPLE_PY, 'python', line, 8);
  show(ed);
  const d = new Decorator();
  t.after(() => d.dispose());
  click(d, ed);
  await flush(t, 300);
  const key = (r) => `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}`;
  const selfBefore = (ed.live.get(d.pool.self) ?? []).map(key);
  assert.ok(selfBefore.length > 0 && band2(d, ed).length > 0 && d.statusItem.visible, 'positive control');
  const types = [...d.pool.all(), d.gutterDecoration];
  try {
    stub.setConfig('enabled', false);
    configChanged();
    await flush(t, 50);
    assert.deepEqual(types.map((ty, k) => [k, count(ed, ty)]).filter(([, n]) => n > 0), [], 'no type keeps a range');
    assert.equal(d.statusItem.visible, false);
  } finally {
    stub.setConfig('enabled', true);
  }
  configChanged();
  await flush(t, 300);
  assert.deepEqual((ed.live.get(d.pool.self) ?? []).map(key), selfBefore, 're-enabling repaints band 1');
  d.dispose();
});

test('the status item shows the effective phase; showPhaseInStatusBar=false keeps it hidden through every phase', async (t) => {
  fakeClock(t);
  stub.clearLspResponses();
  const run = async () => {
    const { ed } = open(JS_FN, 'javascript', 2, 4);
    show(ed);
    const d = new Decorator();
    t.after(() => d.dispose());
    await flush(t, 100);
    const seen = [[d.statusItem.visible, d.statusItem.text]];
    click(d, ed);
    await flush(t, 100);
    seen.push([d.statusItem.visible, d.statusItem.text]);
    typeAtCaret(d, ed);
    await flush(t, 50);
    seen.push([d.statusItem.visible, d.statusItem.text]);
    d.dispose();
    return seen;
  };
  const shown = await run();
  assert.deepEqual(shown.map(([v, text]) => [v, text.split(' ').pop()]), [[true, Phase.Survey], [true, Phase.Focus], [true, Phase.Edit]]);
  stub.setConfig('showPhaseInStatusBar', false);
  try {
    assert.deepEqual((await run()).map(([v]) => v), [false, false, false]);
  } finally {
    stub.setConfig('showPhaseInStatusBar', true);
  }
});

test('a dwell setting changed at runtime applies without a reload', async (t) => {
  fakeClock(t);
  stub.clearLspResponses();
  const { ed } = open(JS_FN, 'javascript', 2, 4);
  show(ed);
  const d = new Decorator();
  t.after(() => d.dispose());
  try {
    stub.setConfig('dwell.editToFocus', 600);
    configChanged();
    click(d, ed);
    typeAtCaret(d, ed);
    assert.equal(d.machine.current, Phase.Edit);
    await flush(t, 500);
    assert.equal(d.machine.current, Phase.Edit, 'held until the new dwell');
    await flush(t, 200);
    assert.equal(d.machine.current, Phase.Focus, 'relaxed after 600 ms, not the default 2000');
  } finally {
    stub.setConfig('dwell.editToFocus', 2000);
    d.dispose();
  }
});

test('a save that never completes stops holding off typing after 5 s', async (t) => {
  fakeClock(t);
  stub.clearLspResponses();
  const { doc, ed } = open(JS_FN, 'javascript', 2, 4);
  show(ed);
  const d = new Decorator();
  t.after(() => d.dispose());
  click(d, ed);
  stub.events.willSave.fire({ document: doc }); // no onDidSave follows: the save failed
  await flush(t, 100);
  typeAtCaret(d, ed, ' ');
  assert.equal(d.machine.current, Phase.Focus, 'inside the save window an edit is a save participant');
  await flush(t, 5000);
  typeAtCaret(d, ed);
  assert.equal(d.machine.current, Phase.Edit, 'after the window, typing is typing again');
  d.dispose();
});

test('the Edit → Focus relaxation repaints on the timer alone: band 3 comes off', async (t) => {
  fakeClock(t);
  stub.clearLspResponses();
  const { ed } = open('function f(a) {\n  const n = a as any;\n  return n;\n}\n', 'typescript', 2, 4);
  show(ed);
  const d = new Decorator();
  t.after(() => d.dispose());
  click(d, ed);
  await flush(t, 200);
  typeAtCaret(d, ed, ' ');
  await flush(t, 300);
  assert.ok(count(ed, d.pool.riskDanger) > 0, 'positive control: Edit marks the cast');
  await flush(t, 2500);
  assert.equal(d.machine.current, Phase.Focus);
  assert.equal(count(ed, d.pool.riskDanger), 0);
  d.dispose();
});

test('caret moves inside the debounce window classify once', async (t) => {
  fakeClock(t);
  stub.clearLspResponses();
  const src = `${JS_FN}\nfunction g(b) {\n  return b + 1;\n}\n`;
  const { ed } = open(src, 'javascript', 2, 4);
  show(ed);
  const d = new Decorator();
  t.after(() => d.dispose());
  click(d, ed);
  await flush(t, 200);
  let runs = 0;
  const real = d.runClassify.bind(d);
  d.runClassify = (x) => {
    runs++;
    return real(x);
  };
  moveTo(d, ed, 6, 4);
  await flush(t, 20);
  moveTo(d, ed, 2, 4);
  await flush(t, 200);
  assert.equal(runs, 1);
  d.dispose();
});

test('editDebounceMs: 140 ms up to 10k lines, then growing to 400 ms at 50k', () => {
  assert.deepEqual([1, 10000, 10001, 25000, 40000, 49000, 50000, 1e6].map(editDebounceMs), [140, 140, 140, 240, 340, 400, 400, 400]);
});

test('typing in a large file waits the scaled debounce before reclassifying and recomputing the restores', async (t) => {
  fakeClock(t);
  stub.clearLspResponses();
  const body = Array.from({ length: 12000 }, (_, i) => `v${i} = len([${i}])`).join('\n');
  const src = `import os\n\ndef f(id):\n    return os.sep + id\n\n${body}\n`;
  const { doc, ed } = open(src, 'python', 3, 4);
  show(ed);
  const d = new Decorator();
  t.after(() => d.dispose());
  d.classifier.retrySchedule = [];
  click(d, ed);
  await flush(t, 300);
  const wait = editDebounceMs(doc.lineCount);
  assert.ok(wait > 140 && wait < 400, `a 12k-line file waits ${wait} ms`);
  let runs = 0;
  const real = d.runClassify.bind(d);
  d.runClassify = (x) => {
    runs++;
    return real(x);
  };
  const before = d.importCache.get(doc).version;
  typeAtCaret(d, ed);
  await flush(t, wait - 20);
  assert.equal(runs, 0, 'no reclassify inside the window');
  assert.equal(d.importCache.get(doc).version, before, 'the restores keep the ranges on screen');
  await flush(t, 40);
  assert.equal(runs, 1);
  assert.equal(d.importCache.get(doc).version, doc.version, 'the restores recompute once the window passes');
});

test('same-tick render requests coalesce into one render', async (t) => {
  fakeClock(t);
  stub.clearLspResponses();
  const { ed } = open(JS_FN, 'javascript', 2, 4);
  show(ed);
  const d = new Decorator();
  t.after(() => d.dispose());
  await flush(t, 200);
  let renders = 0;
  const real = d.render.bind(d);
  d.render = () => {
    renders++;
    real();
  };
  for (let k = 0; k < 3; k++) stub.events.visibleEditors.fire([ed]);
  await flush(t, 10);
  assert.equal(renders, 1);
  d.dispose();
});

test('renders of an unchanged version reuse the risk and doc-link scans; an edit rescans once', async (t) => {
  fakeClock(t);
  stub.clearLspResponses();
  const riskMod = require('../out/risk');
  const linksMod = require('../out/doclinks');
  const realRisk = riskMod.lexicalRisk;
  const realLinks = linksMod.goDocLinkSpans;
  let riskScans = 0;
  let linkScans = 0;
  riskMod.lexicalRisk = (...a) => (riskScans++, realRisk(...a));
  linksMod.goDocLinkSpans = (...a) => (linkScans++, realLinks(...a));
  const src = 'package p\n\n// Run calls [Start].\nfunc Run() {\n\tx := 42\n\t_ = x\n}\n';
  const { ed } = open(src, 'go', 4, 2);
  show(ed);
  const d = new Decorator();
  t.after(() => d.dispose());
  try {
    click(d, ed);
    await flush(t, 200);
    d.machine.phase = Phase.Edit;
    d.render();
    assert.ok(riskScans >= 1 && linkScans >= 1, 'positive control');
    riskScans = 0;
    linkScans = 0;
    for (let k = 0; k < 3; k++) d.render();
    assert.deepEqual([riskScans, linkScans], [0, 0], 'the same version and block');
    typeAtCaret(d, ed, ' ');
    d.machine.phase = Phase.Edit;
    for (let k = 0; k < 3; k++) d.render();
    assert.deepEqual([riskScans, linkScans], [1, 1], 'one scan for the new version');
  } finally {
    riskMod.lexicalRisk = realRisk;
    linksMod.goDocLinkSpans = realLinks;
    d.dispose();
  }
});

test('the plan cache keeps at most its limit, evicting the least recent', (t) => {
  stub.clearLspResponses();
  const d = new Decorator();
  t.after(() => d.dispose());
  for (let k = 0; k < 40; k++) d.putCache(`k${k}`, { classification: null, plan: new Map(), semantic: 'ok', hold: false });
  assert.equal(d.classCache.size, 16);
  assert.deepEqual([...d.classCache.keys()][0], 'k24');
  d.dispose();
});

/** A server that is up but has no tokens yet: the legend, and an empty answer. */
function serveCold() {
  stub.clearLspResponses();
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': RS_LSP.legend,
    'vscode.provideDocumentSemanticTokens': { data: [] },
    'vscode.executeDocumentSymbolProvider': [],
  });
}

test('a cold server is re-asked on one backoff chain, however many classifies ask', async (t) => {
  fakeClock(t);
  serveCold();
  const { doc, ed } = open(SAMPLE_RS, 'rust', 82, 12);
  show(ed);
  const d = new Decorator();
  t.after(() => d.dispose());
  click(d, ed);
  await flush(t, 200);
  const first = tokenRequests();
  assert.ok(first >= 1, 'positive control');
  await d.runClassify(doc);
  await d.runClassify(doc);
  await flush(t, 1100);
  assert.equal(tokenRequests() - first, 1, 'one retry after the first delay');
  d.dispose();
  stub.clearLspResponses();
});

test('dispose cancels every timer: nothing paints and nothing is requested after it', async (t) => {
  fakeClock(t);
  serveCold();
  const { ed } = open(SAMPLE_RS, 'rust', 82, 12);
  show(ed);
  const d = new Decorator();
  t.after(() => d.dispose());
  click(d, ed);
  await flush(t, 200);
  let painted = 0;
  ed.setDecorations = () => painted++;
  const asked = tokenRequests();
  d.dispose();
  await flush(t, 30000);
  assert.equal(painted, 0, 'no relax or retry render');
  assert.equal(tokenRequests(), asked, 'no retry request');
  stub.clearLspResponses();
});

test('a high-contrast dark theme gets the dark pool', (t) => {
  const { buildDecorationPool } = require('../out/tokens');
  const dark = buildDecorationPool(true);
  const light = buildDecorationPool(false);
  assert.notDeepEqual(dark.self.options, light.self.options, 'positive control');
  vs.window.activeColorTheme.kind = vs.ColorThemeKind.HighContrast;
  try {
    const d = new Decorator();
    t.after(() => d.dispose());
    assert.deepEqual(d.pool.self.options, dark.self.options);
    d.dispose();
  } finally {
    vs.window.activeColorTheme.kind = vs.ColorThemeKind.Dark;
  }
});

test('no debug output channel exists unless okibiDynamic.debug is on', (t) => {
  const real = vs.window.createOutputChannel;
  let made = 0;
  let disposed = 0;
  vs.window.createOutputChannel = () => (made++, { appendLine() {}, show() {}, dispose: () => disposed++ });
  try {
    const off = new Decorator();
    t.after(() => off.dispose());
    configChanged();
    assert.equal(made, 0);
    off.dispose();
    stub.setConfig('debug', true);
    const on = new Decorator();
    t.after(() => on.dispose());
    assert.equal(made, 1);
    stub.setConfig('debug', false);
    configChanged();
    assert.equal(disposed, 1, 'turning it off removes the channel');
    on.dispose();
  } finally {
    stub.setConfig('debug', false);
    vs.window.createOutputChannel = real;
  }
});

// ── Provider failures and the extension entry point ──────────────────────────

test('providers that throw degrade to the heuristic: classify resolves, band 1 paints', async (t) => {
  stub.clearLspResponses();
  stub.setLspHandler(async () => {
    throw new Error('provider crashed');
  });
  const { doc, ed } = open(SAMPLE_RS, 'rust', 82, 12);
  const blocks = focus.scanBlocks(SAMPLE_RS, 'rust');
  const block = focus.innermostBlock(blocks, 82, doc.offsetAt(new vs.Position(82, 12)), SAMPLE_RS);
  const r = await new Classifier().classifyScope(doc, block, 5, { isCancellationRequested: false }, { text: SAMPLE_RS, blocks });
  assert.equal(r.focused.source, 'heuristic');
  show(ed);
  const d = new Decorator();
  t.after(() => d.dispose());
  await sleep(0);
  assert.ok(count(ed, d.pool.self) > 0 && count(ed, d.pool.placeholder) > 0);
  d.dispose();
  stub.clearLspResponses();
});

test('a malformed document symbol leaves the function ranges to the block scan', async () => {
  stub.clearLspResponses();
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': RS_LSP.legend,
    'vscode.provideDocumentSemanticTokens': { data: RS_LSP.data },
    'vscode.executeDocumentSymbolProvider': [{ kind: vs.SymbolKind.Function, name: 'broken', range: null, children: [] }],
  });
  const { doc } = open(SAMPLE_RS, 'rust', 82, 12);
  const blocks = focus.scanBlocks(SAMPLE_RS, 'rust');
  const block = focus.innermostBlock(blocks, 82, doc.offsetAt(new vs.Position(82, 12)), SAMPLE_RS);
  const r = await new Classifier().classifyScope(doc, block, 5, { isCancellationRequested: false }, { text: SAMPLE_RS, blocks });
  assert.equal(r.focused.source, 'lsp');
  assert.ok(r.focused.enclosingFn, 'the block scan still finds the enclosing function');
  stub.clearLspResponses();
});

test('activate registers the toggle, which flips okibiDynamic.enabled globally; deactivate disposes the layer once', async () => {
  stub.clearLspResponses();
  const ext = require('../out/extension');
  const ctx = { subscriptions: [] };
  ext.activate(ctx);
  assert.equal(ctx.subscriptions.length, 2);
  const layer = ctx.subscriptions[0];
  assert.ok(layer instanceof Decorator);
  let disposed = 0;
  const real = layer.dispose.bind(layer);
  layer.dispose = () => {
    disposed++;
    real();
  };
  try {
    await stub.runCommand('okibiDynamic.toggle');
    assert.deepEqual(stub.configUpdates.at(-1), ['enabled', false, vs.ConfigurationTarget.Global]);
    assert.match(stub.statusMessages.at(-1), /off$/);
    assert.equal(layer.statusItem.visible, false, 'the layer follows the setting');
    await stub.runCommand('okibiDynamic.toggle');
    assert.deepEqual(stub.configUpdates.at(-1), ['enabled', true, vs.ConfigurationTarget.Global]);
    assert.match(stub.statusMessages.at(-1), /on$/);
  } finally {
    stub.setConfig('enabled', true);
  }
  ext.deactivate();
  ext.deactivate();
  assert.equal(disposed, 1);
});

// The transition walks run in this file's process until package.json lists test/transitions.test.js.
require('./transitions.test.js');
