'use strict';
// Full-pipeline cost on large files: the real Decorator, driven through the
// vscode stub, over the generated inputs of test/perf-inputs.js. Each session
// opens the file, jumps to a function at the END of the file (the case a
// prefix lex or a linear scan pays most for), moves inside it, focuses the
// module top level, goes back, types one key and then a burst of ten.
//
// Per step it prints the synchronous handler + render time and the wall time of
// the classification that follows. The stub applies each edit and encodes the
// server's tokens outside the timed region, and answers instantly, so editor and
// server time are excluded. Results: docs/runtime.md#cost-on-large-files.
//
//   node test/bench-scale.js [ts|js|go|rs|py|lua|rb ...] [lines ...] [--no-lsp] [--stages]
//
// Defaults: all six languages at 2000, 10000 and 50000 lines. --no-lsp answers
// every provider request with nothing, so the heuristic classifier runs.
// --stages times the pure stages instead (warm, mean of 5 calls each).

const stub = require('./vscode-stub');
const vs = stub.install();
const focus = require('../out/focus');
const classify = require('../out/classify');
const { lex } = require('../out/lex');
const { luaFacts } = require('../out/lua');
const { rubyFacts } = require('../out/ruby');
const { Decorator, editDebounceMs } = require('../out/decorator');
const { generate } = require('./perf-inputs');

const args = process.argv.slice(2);
const NO_LSP = args.includes('--no-lsp');
const STAGES = args.includes('--stages');
const langs = args.filter((a) => /^[a-z]+$/.test(a));
const sizes = args.filter((a) => /^\d+$/.test(a)).map(Number);
const LANGS = langs.length > 0 ? langs : ['ts', 'go', 'rs', 'py', 'lua', 'rb'];
const SIZES = sizes.length > 0 ? sizes : [2000, 10000, 50000];

/** A document shaped like VS Code's: getText() joins the lines, positionAt is a binary search. */
class Doc {
  constructor(text, languageId, uri) {
    this.languageId = languageId;
    this.version = 1;
    this.uri = { scheme: 'file', toString: () => uri, fsPath: uri };
    this.fileName = uri;
    this.setText(text);
  }
  setText(t) {
    this.lines = t.split('\n');
    this.starts = null;
  }
  lineStarts() {
    if (!this.starts) {
      this.starts = new Array(this.lines.length);
      for (let i = 0, o = 0; i < this.lines.length; i++) {
        this.starts[i] = o;
        o += this.lines[i].length + 1;
      }
    }
    return this.starts;
  }
  get lineCount() {
    return this.lines.length;
  }
  getText() {
    return this.lines.join('\n');
  }
  positionAt(off) {
    const ls = this.lineStarts();
    let lo = 0;
    let hi = ls.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (ls[m] <= off) lo = m;
      else hi = m - 1;
    }
    return new vs.Position(lo, off - ls[lo]);
  }
  offsetAt(p) {
    return this.lineStarts()[p.line] + p.character;
  }
  lineAt(l) {
    return { text: this.lines[l], range: new vs.Range(l, 0, l, this.lines[l].length) };
  }
  insert(off, s) {
    const at = this.positionAt(off);
    const t = this.getText();
    this.setText(t.slice(0, off) + s + t.slice(off));
    this.version++;
    return { document: this, contentChanges: [{ range: new vs.Range(at, at), rangeOffset: off, rangeLength: 0, text: s }] };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(input) {
  const doc = new Doc(input.text, input.languageId, `file:///bench/${input.key}.${input.ext}`);
  const ed = new stub.TextEditor(doc, 0, 0);
  ed.setDecorations = () => {};
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const tokens = input.tokens.map((t) => ({ ...t }));
  const symbols = input.symbols.map((s) => ({ ...s }));
  let encoded = null;
  const encode = () => {
    if (!encoded || encoded.version !== doc.version) {
      encoded = { version: doc.version, ...stub.encodeTokens(doc.getText(), tokens) };
    }
  };
  stub.clearLspResponses();
  stub.setLspHandler((cmd) => {
    if (NO_LSP) return undefined;
    encode();
    if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return encoded.legend;
    if (cmd === 'vscode.provideDocumentSemanticTokens') return { data: encoded.data };
    if (cmd === 'vscode.executeDocumentSymbolProvider') {
      return symbols.map((s) => ({ kind: vs.SymbolKind.Function, name: 'f', children: [],
        range: new vs.Range(doc.positionAt(s.start), doc.positionAt(s.end)) }));
    }
    return undefined;
  });
  const shift = (off, n) => {
    for (const t of tokens) if (t.offset >= off) t.offset += n;
    for (const s of symbols) {
      if (s.start >= off) s.start += n;
      if (s.end >= off) s.end += n;
    }
  };

  const d = new Decorator();
  d.classifier.retrySchedule = [];
  let pending = [];
  let classifyMs = 0;
  const run = d.runClassify.bind(d);
  d.runClassify = (x) => {
    const t0 = performance.now();
    const p = run(x).finally(() => {
      classifyMs += performance.now() - t0;
    });
    pending.push(p);
    return p;
  };
  // A wait after a caret move outlasts its 60 ms debounce, after an edit the typing debounce.
  const afterEdit = editDebounceMs(doc.lineCount) + 30;
  const idle = async (ms = 170) => {
    await sleep(ms);
    while (pending.length > 0) {
      const p = pending;
      pending = [];
      await Promise.all(p);
      await sleep(5);
    }
  };
  const flushRender = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const rows = [];
  const step = async (label, fn, wait) => {
    classifyMs = 0;
    const t0 = performance.now();
    fn();
    await flushRender();
    const sync = performance.now() - t0;
    await idle(wait);
    rows.push({ label, sync, classify: classifyMs });
  };
  const caretTo = (off) => {
    const p = doc.positionAt(off);
    ed.selection = new vs.Selection(p.line, p.character, p.line, p.character);
    d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 });
  };
  /** Apply a one-space edit the way the editor would, before the extension sees it. */
  const edit = (off) => {
    const ev = doc.insert(off, ' ');
    shift(off, 1);
    const p = doc.positionAt(off + 1);
    ed.selection = new vs.Selection(p.line, p.character, p.line, p.character);
    if (!NO_LSP) encode();
    return ev;
  };

  const text = input.text;
  const blocks = focus.scanBlocks(text, input.languageId);
  const fns = blocks.filter((b) => b.depth === 0 && focus.isFunctionHeader(text, b, input.languageId));
  const span = (b) => b.closeOffset - b.openOffset;
  const late = fns.filter((b) => b.openOffset > text.length * 0.9);
  const lastFn = [...(late.length > 0 ? late : fns)].sort((a, b) => span(b) - span(a) || a.openOffset - b.openOffset)[0];
  const inside = (b) => Math.min(text.indexOf('\n', b.openOffset + 1) + 5, b.closeOffset - 1);
  let topOff = 0;
  for (let o = text.indexOf('\n', Math.floor(text.length * 0.95)) + 1; o > 0 && o < text.length; o = text.indexOf('\n', o) + 1) {
    if (!focus.innermostBlock(blocks, doc.positionAt(o).line, o)) {
      topOff = o;
      break;
    }
  }

  await step('open', () => d.refresh());
  await step('jump to last fn', () => caretTo(inside(lastFn)));
  await step('move inside it', () => caretTo(inside(lastFn) + 1));
  await step('module top level', () => caretTo(topOff));
  await step('back to last fn', () => caretTo(inside(lastFn)));
  const at = text.indexOf('\n', inside(lastFn));
  const first = edit(at);
  await step('keystroke', () => d.onEdit(first), afterEdit);
  {
    classifyMs = 0;
    let sync = 0;
    for (let i = 1; i <= 10; i++) {
      const ev = edit(at + i);
      const t0 = performance.now();
      d.onEdit(ev);
      await flushRender();
      sync += performance.now() - t0;
      await sleep(30);
    }
    await idle(afterEdit);
    rows.push({ label: 'burst of 10 keys (sum)', sync, classify: classifyMs });
  }
  d.dispose();
  return rows;
}

/** Per-version and per-focus stage costs, each the mean of `runs` warm calls. */
function stages(input, runs = 5) {
  const { text, languageId: L, tokens } = input;
  const time = (fn) => {
    fn();
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) fn();
    return (performance.now() - t0) / runs;
  };
  const rows = [];
  rows.push(['lex', time(() => lex(text, L))]);
  rows.push(['scanBlocks', time(() => focus.scanBlocks(text, L))]);
  const blocks = focus.scanBlocks(text, L);
  if (L === 'lua') rows.push(['luaFacts', time(() => luaFacts(lex(text, L), blocks)) - rows[0][1]]);
  if (L === 'ruby') rows.push(['rubyFacts', time(() => rubyFacts(lex(text, L), blocks)) - rows[0][1]]);
  const fnRanges = input.symbols.map((s) => ({ ...s }));
  for (const b of blocks) {
    const r = focus.functionScopeOf(text, b, L);
    if (r) fnRanges.push(r);
  }
  fnRanges.sort((a, b) => a.start - b.start || b.end - a.end);
  rows.push(['buildFileIndex', time(() => classify.buildFileIndex(text, tokens, fnRanges.slice(), L))]);
  const index = classify.buildFileIndex(text, tokens, fnRanges, L);
  const sorted = [...blocks].sort((a, b) => a.openOffset - b.openOffset);
  const subsOf = (b) => sorted.filter((x) => x.openOffset > b.openOffset && x.closeOffset < b.closeOffset).map((x) => focus.scopeRegionFor(text, x, L));
  const top = focus.topLevelBlock(text);
  const excludes = focus.topLevelExcludes(text, blocks, L);
  const topSubs = subsOf(top);
  rows.push(['classify top level', time(() => classify.classifyFromSemantic(text, focus.lexRegionFor(text, top, L), undefined,
    fnRanges, tokens, 1, 'top', undefined, focus.declRegionFor(text, top, L), topSubs, index, excludes))]);
  const fns = blocks.filter((b) => b.depth === 0 && focus.isFunctionHeader(text, b, L));
  const scope = classify.outermostFnOf(fnRanges, fns[fns.length - 1].openOffset);
  const scopeBlocks = blocks.filter((b) => b.openOffset >= scope.start && b.closeOffset < scope.end);
  const each = (fn) => () => scopeBlocks.map((b) => fn(b, subsOf(b)));
  rows.push([`classify last scope (${scopeBlocks.length} blocks)`, time(each((b, subs) => classify.classifyFromSemantic(text,
    focus.lexRegionFor(text, b, L), classify.enclosingFnOf(fnRanges, b.openOffset), fnRanges, tokens, 1, 'k', scope,
    focus.declRegionFor(text, b, L), subs, index)))]);
  rows.push([`heuristic, last scope`, time(each((b, subs) => classify.classifyFromHeuristic(text, focus.lexRegionFor(text, b, L),
    classify.enclosingFnOf(fnRanges, b.openOffset), fnRanges, 1, 'k', scope, focus.declRegionFor(text, b, L), subs, L, [], blocks)))]);
  rows.push(['heuristic, top level', time(() => classify.classifyFromHeuristic(text, focus.lexRegionFor(text, top, L), undefined,
    fnRanges, 1, 'top', undefined, focus.declRegionFor(text, top, L), topSubs, L, excludes, blocks))]);
  return rows;
}

(async () => {
  const fmt = (ms) => ms.toFixed(1).padStart(8);
  for (const ext of LANGS) {
    for (const lines of SIZES) {
      const input = generate(ext, lines, focus.scanBlocks);
      if (STAGES) {
        console.log(`\n${input.key}: ${input.text.length} chars, stages`);
        for (const [label, ms] of stages(input)) console.log(`  ${label.padEnd(34)} ${fmt(ms)}`);
        continue;
      }
      const rows = await session(input);
      console.log(`\n${input.key}: ${input.text.length} chars${NO_LSP ? ', no semantic provider' : ''}`);
      console.log(`  ${'step'.padEnd(24)} ${'sync ms'.padStart(8)} ${'classify'.padStart(8)}`);
      for (const r of rows) console.log(`  ${r.label.padEnd(24)} ${fmt(r.sync)} ${fmt(r.classify)}`);
    }
  }
  process.exit(0);
})();
