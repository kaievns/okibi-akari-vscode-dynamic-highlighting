'use strict';
// Typing on large files in virtual time: the real Decorator, driven through the
// vscode stub, over the generated inputs of test/perf-inputs.js. Mock timers drive
// the clock and every turn of the event loop advances it by the main-thread CPU the
// extension used, so a long classification delays the next keystroke and the
// server's answer as it would in the extension host, and machine load changes
// neither the order of events nor the result. Keystrokes arrive at log-normal gaps
// around 180 ms (60 to 900 ms), at the end of a line inside a function near the
// end of the file. The stub server's own work and the edits are not counted.
//
// Per input it prints the extension's CPU per keystroke, how long keystrokes waited
// behind running work (mean and max), the longest single task, and how many file
// indexes, classifications and setDecorations calls the session made, as the
// median over --reps sessions with different typing gaps. Each session runs in a
// fresh process, so no session finds another's texts in the lexer memo.
// Results: docs/runtime.md#cost-on-large-files.
//
//   node test/bench-typing.js [ts|go|rs|py|lua ...] [lines ...] [--no-lsp] [--latency ms] [--keys n] [--reps n]
//
// Defaults: all five languages at 10000 and 50000 lines, 40 keys, 3 reps, a server
// that answers at once. --latency delays every server answer.

const { mock } = require('node:test');
const stub = require('./vscode-stub');
const vs = stub.install();
const focus = require('../out/focus');
const classify = require('../out/classify');
const { Decorator } = require('../out/decorator');
const { generate } = require('./perf-inputs');

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const NO_LSP = args.includes('--no-lsp');
const LATENCY = opt('--latency', 0);
const KEYS = opt('--keys', 40);
const REPS = opt('--reps', 3);
const valued = new Set(['--latency', '--keys', '--reps'].map((k) => args.indexOf(k) + 1).filter((i) => i > 0));
const langs = args.filter((a, i) => /^[a-z]+$/.test(a) && !valued.has(i));
const sizes = args.filter((a, i) => /^\d+$/.test(a) && !valued.has(i)).map(Number);
const LANGS = langs.length > 0 ? langs : ['ts', 'go', 'rs', 'py', 'lua'];
const SIZES = sizes.length > 0 ? sizes : [10000, 50000];

const cpu = () => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
};
let harnessCpu = 0;
const harness = (fn) => {
  const c0 = cpu();
  try {
    return fn();
  } finally {
    harnessCpu += cpu() - c0;
  }
};
const counts = { fileIndexes: 0, classifies: 0, setDecorations: 0 };
const buildFileIndex = classify.buildFileIndex;
classify.buildFileIndex = (...a) => {
  counts.fileIndexes++;
  return buildFileIndex(...a);
};

/** A document shaped like VS Code's: getText() joins the lines, positionAt is a binary search. */
class Doc {
  constructor(text, languageId, uri) {
    this.languageId = languageId;
    this.version = 1;
    this.uri = { scheme: 'file', toString: () => uri, fsPath: uri };
    this.fileName = uri;
    this.lines = text.split('\n');
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
    const line = this.lines[at.line];
    this.lines[at.line] = line.slice(0, at.character) + s + line.slice(at.character);
    this.starts = null;
    this.version++;
    return { document: this, contentChanges: [{ range: new vs.Range(at, at), rangeOffset: off, rangeLength: 0, text: s }] };
  }
}

async function session(input, seed) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const gap = () => {
    const z = Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
    return Math.min(900, Math.max(60, 180 * Math.exp(0.5 * z)));
  };
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const due = new Map();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...x) => {
    const h = realSet((...y) => {
      due.delete(h);
      fn(...y);
    }, ms, ...x);
    due.set(h, Date.now() + Math.max(0, ms || 0));
    return h;
  };
  globalThis.clearTimeout = (h) => {
    due.delete(h);
    realClear(h);
  };
  // One turn: the due timers, then a setImmediate, with the clock moved on by the CPU used.
  const turnCost = await (async () => {
    const xs = [];
    for (let i = 0; i < 200; i++) {
      const c0 = cpu();
      mock.timers.tick(0);
      await new Promise((r) => setImmediate(r));
      xs.push(cpu() - c0);
    }
    return xs.sort((a, b) => a - b)[100];
  })();
  let extCpu = 0;
  let maxTask = 0;
  const runUntil = async (end) => {
    for (;;) {
      let next = Infinity;
      for (const at of due.values()) if (at < next) next = at;
      if (next > end) {
        if (Date.now() < end) mock.timers.setTime(end);
        return;
      }
      if (next > Date.now()) mock.timers.setTime(next);
      for (let turn = 0; turn < 24; turn++) {
        const h0 = harnessCpu;
        const c0 = cpu();
        mock.timers.tick(0);
        await new Promise((r) => setImmediate(r));
        const used = Math.max(0, cpu() - c0 - turnCost - (harnessCpu - h0));
        extCpu += used;
        maxTask = Math.max(maxTask, used);
        mock.timers.setTime(Date.now() + used);
      }
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const doc = new Doc(input.text, input.languageId, `file:///typing/${input.key}.${input.ext}`);
  const tokens = input.tokens.map((t) => ({ ...t }));
  const symbols = input.symbols.map((x) => ({ ...x }));
  let encoded = null;
  stub.clearLspResponses();
  stub.setLspHandler(async (cmd) => {
    if (NO_LSP) return undefined;
    const res = harness(() => {
      if (cmd === 'vscode.executeDocumentSymbolProvider') {
        return symbols.map((x) => ({ kind: vs.SymbolKind.Function, name: 'f', children: [],
          range: new vs.Range(doc.positionAt(x.start), doc.positionAt(x.end)) }));
      }
      if (!encoded || encoded.version !== doc.version) encoded = { version: doc.version, ...stub.encodeTokens(doc.getText(), tokens) };
      if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return encoded.legend;
      if (cmd === 'vscode.provideDocumentSemanticTokens') return { data: encoded.data };
      return undefined;
    });
    if (LATENCY > 0) await sleep(LATENCY);
    return res;
  });
  const ed = new stub.TextEditor(doc, 0, 0);
  ed.setDecorations = () => {
    counts.setDecorations++;
  };
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  const run = d.runClassify.bind(d);
  d.runClassify = (x) => {
    counts.classifies++;
    return run(x);
  };

  const text = input.text;
  const blocks = focus.scanBlocks(text, input.languageId);
  const fns = blocks.filter((b) => b.depth === 0 && focus.isFunctionHeader(text, b, input.languageId));
  const late = fns.filter((b) => b.openOffset > text.length * 0.9);
  const lastFn = (late.length > 0 ? late : fns).sort((x, y) => (y.closeOffset - y.openOffset) - (x.closeOffset - x.openOffset))[0];
  const inside = Math.min(text.indexOf('\n', lastFn.openOffset + 1) + 5, lastFn.closeOffset - 1);
  setTimeout(() => d.refresh(), 0);
  await runUntil(Date.now() + 1000);
  setTimeout(() => {
    const p = doc.positionAt(inside);
    ed.selection = new vs.Selection(p.line, p.character, p.line, p.character);
    d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 2 });
  }, 0);
  await runUntil(Date.now() + 1000);
  for (const k of Object.keys(counts)) counts[k] = 0;
  extCpu = 0;
  maxTask = 0;
  let at = doc.getText().indexOf('\n', inside);
  let dueAt = Date.now();
  let lateSum = 0;
  let lateMax = 0;
  for (let i = 0; i < KEYS; i++) {
    dueAt += gap();
    const when = dueAt;
    const ch = i % 8 === 0 ? ' ' : 'abcdefghijklmnopqrstuvwxyz'[i % 26];
    setTimeout(() => {
      lateSum += Date.now() - when;
      lateMax = Math.max(lateMax, Date.now() - when);
      const ev = harness(() => {
        const e = doc.insert(at, ch);
        for (const t of tokens) if (t.offset >= at) t.offset += 1;
        for (const x of symbols) {
          if (x.start >= at) x.start += 1;
          if (x.end >= at) x.end += 1;
        }
        at += 1;
        const q = doc.positionAt(at);
        ed.selection = new vs.Selection(q.line, q.character, q.line, q.character);
        return e;
      });
      d.onEdit(ev);
      d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 });
    }, when - Date.now());
  }
  await runUntil(dueAt + 3000 + LATENCY * 3);
  const row = { cpuPerKey: extCpu / KEYS, lateMean: lateSum / KEYS, lateMax, maxTask, ...counts };
  d.dispose();
  globalThis.setTimeout = realSet;
  globalThis.clearTimeout = realClear;
  mock.timers.reset();
  return row;
}

const CHILD = process.env.BENCH_TYPING_SESSION;

(async () => {
  if (CHILD) {
    const [ext, lines, seed] = CHILD.split(':');
    const row = await session(generate(ext, Number(lines), focus.scanBlocks), Number(seed));
    process.stdout.write(JSON.stringify(row));
    process.exit(0);
  }
  const { execFileSync } = require('node:child_process');
  const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const f = (x, w = 7) => x.toFixed(1).padStart(w);
  console.log(`${NO_LSP ? 'no semantic provider' : `server latency ${LATENCY} ms`}, ${KEYS} keys, median of ${REPS}`);
  console.log(`  ${'input'.padEnd(10)} ${'cpu/key'.padStart(7)} ${'late'.padStart(7)} ${'lateMax'.padStart(7)} ${'maxTask'.padStart(7)} indexes classifies setDecorations`);
  for (const ext of LANGS) {
    for (const lines of SIZES) {
      const rows = [];
      for (let r = 1; r <= REPS; r++) {
        const out = execFileSync(process.execPath, [__filename, ...args],
          { env: { ...process.env, BENCH_TYPING_SESSION: `${ext}:${lines}:${r * 7919}` }, maxBuffer: 1 << 20 });
        rows.push(JSON.parse(out.toString()));
      }
      const key = `${ext}-${lines}`;
      const m = (k) => med(rows.map((x) => x[k]));
      console.log(`  ${key.padEnd(10)} ${f(m('cpuPerKey'))} ${f(m('lateMean'))} ${f(m('lateMax'))} ${f(m('maxTask'))} ${String(m('fileIndexes')).padStart(7)} ${String(m('classifies')).padStart(10)} ${String(m('setDecorations')).padStart(14)}`);
    }
  }
  process.exit(0);
})();
