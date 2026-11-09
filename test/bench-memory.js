'use strict';
// Heap the decorator retains: opens 8 generated documents (2 per language) one after
// another, engages and classifies each, then types 100 keys into the last one. Heap
// is read after a full GC. Results: docs/runtime.md#memory.
//
//   node --expose-gc test/bench-memory.js [lines] [--no-lsp]
//
// Defaults to 50000 lines. --no-lsp answers every provider request with nothing.

const { mock } = require('node:test');
const stub = require('./vscode-stub');
const vs = stub.install();
const focus = require('../out/focus');
const { Decorator } = require('../out/decorator');
const { generate } = require('./perf-inputs');

if (typeof global.gc !== 'function') {
  console.error('run with node --expose-gc');
  process.exit(2);
}
const args = process.argv.slice(2);
const NO_LSP = args.includes('--no-lsp');
const LINES = Number(args.find((a) => /^\d+$/.test(a)) ?? 50000);
const heap = () => {
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed / 1048576;
};

(async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const flush = async () => {
    for (let i = 0; i < 16; i++) await new Promise((r) => setImmediate(r));
  };
  const advance = async (ms) => {
    for (let left = ms; left > 0; left -= 20) {
      mock.timers.tick(Math.min(20, left));
      await flush();
    }
  };
  const sessions = [];
  for (const ext of ['ts', 'go', 'rs', 'py']) {
    for (const k of [0, 1]) {
      const input = generate(ext, LINES, focus.scanBlocks);
      const text = k === 0 ? input.text : `${input.text}\n`;
      const doc = new stub.TextDocument(text, input.languageId, `file:///mem/${ext}${k}.${input.ext}`);
      sessions.push({ input, doc, tokens: input.tokens.map((t) => ({ ...t })), enc: null });
    }
  }
  const byUri = new Map(sessions.map((s) => [s.doc.uri.toString(), s]));
  const encode = (s) => {
    if (!s.enc || s.enc.version !== s.doc.version) s.enc = { version: s.doc.version, ...stub.encodeTokens(s.doc.getText(), s.tokens) };
    return s.enc;
  };
  stub.clearLspResponses();
  stub.setLspHandler((cmd, uri) => {
    const s = byUri.get(uri?.toString?.());
    if (!s || NO_LSP) return undefined;
    if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return encode(s).legend;
    if (cmd === 'vscode.provideDocumentSemanticTokens') return { data: encode(s).data };
    if (cmd === 'vscode.executeDocumentSymbolProvider') {
      return s.input.symbols.map((x) => ({ kind: vs.SymbolKind.Function, name: 'f', children: [], range: new vs.Range(s.doc.positionAt(x.start), s.doc.positionAt(x.end)) }));
    }
    return undefined;
  });
  // The stub's own encodings belong in the baseline.
  for (const s of sessions) encode(s);
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  const h0 = heap();
  let prev = h0;
  const rows = [];
  for (const s of sessions) {
    const ed = new stub.TextEditor(s.doc, 0, 0);
    ed.setDecorations = () => {};
    vs.window.activeTextEditor = ed;
    vs.window.visibleTextEditors = [ed];
    stub.events.activeEditor.fire(ed);
    await advance(300);
    const text = s.doc.getText();
    const blocks = focus.scanBlocks(text, s.doc.languageId);
    const fn = blocks.find((b) => b.depth === 0 && b.openOffset > text.length * 0.5 && focus.isFunctionHeader(text, b, s.doc.languageId)) ?? blocks[0];
    const p = s.doc.positionAt(fn.openOffset + 2);
    ed.selection = new vs.Selection(p.line, p.character, p.line, p.character);
    d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 2 });
    await advance(400);
    const h = heap();
    rows.push([s.doc.uri.toString(), h - prev]);
    prev = h;
  }
  const afterOpen = heap();
  const s = sessions[sessions.length - 1];
  let at = s.doc.getText().indexOf('\n', Math.floor(s.doc.getText().length * 0.6));
  for (let i = 0; i < 100; i++) {
    const ev = s.doc.applyEdit(at, at, 'x');
    for (const t of s.tokens) if (t.offset >= at) t.offset += 1;
    at++;
    d.onEdit(ev);
    await advance(i % 10 === 9 ? 400 : 60);
  }
  await advance(3000);
  const afterTyping = heap();
  console.log(`${LINES} lines, ${NO_LSP ? 'no server' : 'with a server'}; baseline (documents and stub) ${h0.toFixed(1)} MB`);
  for (const [uri, mb] of rows) console.log(`  +${mb.toFixed(1).padStart(6)} MB  ${uri}`);
  console.log(`  retained after 8 documents: ${(afterOpen - h0).toFixed(1)} MB`);
  console.log(`  growth over 100 keystrokes: ${(afterTyping - afterOpen).toFixed(1)} MB`);
  d.dispose();
  mock.timers.reset();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
