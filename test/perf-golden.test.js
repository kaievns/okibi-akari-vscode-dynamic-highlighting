'use strict';
// Output equivalence for performance work. Over large generated inputs (see
// perf-inputs.js) this records everything the layer computes and paints: the
// lex, blocks and regions, the file index, per-block classifications, scope
// colourings, plans, trace ranges and risk ranges on both the semantic and the
// heuristic path, the band-1 marks, and the decorator's setDecorations state
// after each step of an open, navigate and type session, and of an edit session
// (first paint, a new line, an unclosed bracket, 40 keys) with and without a
// server. Each section is hashed and compared with test/fixtures/perf-golden.json.
//
// An optimisation must leave every hash unchanged. A behaviour fix that changes
// output re-records the hashes in the same change:
//   PERF_GOLDEN_RECORD=1 node --test test/perf-golden.test.js
// PERF_GOLDEN_DUMP=<dir> also writes each section's JSON; run it once per build into
// the same directory and the second run prints the labels that moved.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const stub = require('./vscode-stub');
const vs = stub.install();
const focus = require('../out/focus');
const { Classifier } = require('../out/classify-lsp');
const { planFromColoring } = require('../out/colors');
const { computeTraceRanges } = require('../out/traces');
const { lexicalRisk, escapeRisk } = require('../out/risk');
const { luaPlaceholderSpans, pythonPlaceholderSpans, rubyPlaceholderSpans, rustPlaceholderSpans, zigPlaceholderSpans } = require('../out/placeholders');
const { goDocLinkSpans } = require('../out/doclinks');
const { lex } = require('../out/lex');
const { zigFacts, zigImportSpans } = require('../out/zig');
const { Decorator } = require('../out/decorator');
const { generate } = require('./perf-inputs');

const HASH_FILE = path.join(__dirname, 'fixtures', 'perf-golden.json');
const RECORD = process.env.PERF_GOLDEN_RECORD === '1';
const DUMP = process.env.PERF_GOLDEN_DUMP;
const INPUTS = ['ts', 'js', 'go', 'rs', 'py', 'lua', 'rb', 'zig'].flatMap((ext) => [2000, 10000].map((lines) => [ext, lines]));
const SAMPLED_BLOCKS = 24;

const recorded = fs.existsSync(HASH_FILE) ? JSON.parse(fs.readFileSync(HASH_FILE, 'utf8')) : {};
const results = {};

const r2a = (r) => [r.start, r.end];
const sortedEntries = (m) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

class Section {
  constructor(name) {
    this.name = name;
    this.hash = crypto.createHash('sha256');
    this.parts = DUMP ? [] : null;
  }
  add(label, value) {
    const s = JSON.stringify([label, value]);
    this.hash.update(s);
    this.hash.update('\n');
    if (this.parts) this.parts.push(s);
  }
  digest(key) {
    if (this.parts) {
      fs.mkdirSync(DUMP, { recursive: true });
      const file = path.join(DUMP, `${key}.${this.name}.jsonl`);
      if (fs.existsSync(file)) reportMoved(`${key} ${this.name}`, fs.readFileSync(file, 'utf8').split('\n'), this.parts);
      fs.writeFileSync(file, this.parts.join('\n'));
    }
    return this.hash.digest('hex');
  }
}

/** Print the labels whose dumped line differs from the previous dump in the same directory. */
function reportMoved(where, before, now) {
  const byLabel = (lines) => new Map(lines.filter(Boolean).map((l) => [JSON.stringify(JSON.parse(l)[0]), l]));
  const a = byLabel(before);
  const b = byLabel(now);
  const moved = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
  if (moved.length > 0) console.log(`perf golden: ${where} moved at ${moved.join(', ')}`);
}

/** The stub document with a binary-search positionAt, so 10k-line inputs stay cheap. */
function makeDoc(input) {
  return new stub.TextDocument(input.text, input.languageId, `file:///perf/${input.key}.${input.ext}`);
}

function lspHandler(doc, state) {
  return (cmd) => {
    switch (cmd) {
      case 'vscode.provideDocumentSemanticTokensLegend':
        return state.encoded().legend;
      case 'vscode.provideDocumentSemanticTokens':
        return { data: state.encoded().data };
      case 'vscode.executeDocumentSymbolProvider':
        return state.symbols.map((s, i) => ({
          name: `f${i}`,
          kind: vs.SymbolKind.Function,
          range: new vs.Range(doc.positionAt(s.start), doc.positionAt(s.end)),
          children: [],
        }));
      default:
        return undefined;
    }
  };
}

/** Tokens and symbols that follow edits to the document, re-encoded per version. */
function lspState(doc, input) {
  const state = {
    tokens: input.tokens.map((t) => ({ ...t })),
    symbols: input.symbols.map((s) => ({ ...s })),
    cache: null,
    encoded() {
      if (!this.cache || this.cache.version !== doc.version) {
        this.cache = { version: doc.version, ...stub.encodeTokens(doc.getText(), this.tokens) };
      }
      return this.cache;
    },
    /** Shift everything at or after `offset` by `delta` (an insertion that touches no token). */
    shift(offset, delta) {
      for (const t of this.tokens) if (t.offset >= offset) t.offset += delta;
      for (const s of this.symbols) {
        if (s.start >= offset) s.start += delta;
        if (s.end >= offset) s.end += delta;
      }
    },
  };
  return state;
}

function sampleBlocks(blocks) {
  const sorted = [...blocks].sort((a, b) => a.openOffset - b.openOffset);
  const picked = new Set();
  for (let j = 0; j < SAMPLED_BLOCKS; j++) {
    picked.add(Math.floor((j * (sorted.length - 1)) / (SAMPLED_BLOCKS - 1)));
  }
  for (let j = Math.max(0, sorted.length - 4); j < sorted.length; j++) picked.add(j);
  return [...picked].sort((a, b) => a - b).map((i) => sorted[i]);
}

const blockRow = (b) => [b.openLine, b.closeLine, b.depth, b.openOffset, b.closeOffset, b.headerStart];

function classificationRow(c) {
  return {
    docVersion: c.docVersion,
    focusKey: c.focusKey,
    byName: sortedEntries(c.byName).map(([n, i]) => [
      n, i.cls, i.freqInBlock, i.firstFileOffset, i.firstBlockOffset, i.isCapture, i.homeFn ? r2a(i.homeFn) : null, i.proximity,
    ]),
    fileGlobalsInOrder: c.fileGlobalsInOrder,
    fnLocalsInOrder: c.fnLocalsInOrder,
    fnGlobals: c.fnGlobals,
    colorScopeFn: c.colorScopeFn ? r2a(c.colorScopeFn) : null,
    enclosingFn: c.enclosingFn ? r2a(c.enclosingFn) : null,
    excludeRanges: c.excludeRanges.map(r2a),
    source: c.source,
  };
}

/** Everything the file-wide occurrence/declaration maps say, in a stable order. */
function occurrenceRows(c) {
  return {
    occurrences: [...c.occurrences.entries()].map(([n, rs]) => [n, rs.map(r2a)]),
    shadowScopes: sortedEntries(c.shadowScopes).map(([n, rs]) => [n, rs.map(r2a)]),
    declSites: [...c.declSites].sort((a, b) => a - b),
    staticNames: [...c.staticNames].sort(),
  };
}

function riskRows(text, c, region, languageId) {
  const r = lexicalRisk(text, region, languageId);
  return {
    async: r.async.map(r2a),
    danger: r.danger.map(r2a),
    numbers: r.numberEngaged.map(r2a),
    escape: escapeRisk(text, region, c, languageId).map(r2a),
  };
}

async function classifySample(sec, input, doc, blocks, sample, semantic) {
  const classifier = new Classifier();
  classifier.retrySchedule = [];
  const token = new vs.CancellationTokenSource().token;
  const text = doc.getText();
  const cached = { text, blocks, version: doc.version };
  let occurrencesSeen = null;
  for (const block of sample) {
    const scoped = await classifier.classifyScope(doc, block, 5, token, cached);
    assert.ok(scoped, `classifyScope returned null for ${input.key} L${block.openLine}`);
    const { focused, coloring } = scoped;
    const plan = planFromColoring(focused, coloring);
    const region = focus.lexRegionFor(text, block, input.languageId);
    sec.add(`block ${focusKeyLabel(block)}`, {
      semantic: scoped.semantic,
      focused: classificationRow(focused),
      hue: sortedEntries(coloring.hue),
      visible: sortedEntries(coloring.visible),
      plan: sortedEntries(plan),
      traces: computeTraceRanges(focused, plan, region).map((t) => [t.name, t.entry, t.ranges.map(r2a)]),
      risk: riskRows(text, focused, region, input.languageId),
    });
    if (focused.occurrences !== occurrencesSeen) {
      occurrencesSeen = focused.occurrences;
      sec.add('occurrences', occurrenceRows(focused));
    }
  }
  if (semantic) {
    const bundle = classifier.cache.get(doc);
    sec.add('fnRanges', bundle.fnRanges.map(r2a));
    const idx = bundle.fileIndex;
    sec.add('fileIndex', {
      declOffsets: [...idx.declOffsets.entries()].map(([n, os]) => [n, os]),
      firstFileOffset: [...idx.firstFileOffset.entries()],
      fileGlobalsInOrder: idx.fileGlobalsInOrder,
    });
  }
}

const focusKeyLabel = (b) => `${b.openLine}#${b.depth}@${b.openOffset}`;

function structureSection(input) {
  const sec = new Section('structure');
  const { text, languageId } = input;
  const lx = lex(text, languageId);
  sec.add('lex.spans', lx.spans.map((s) => [s.start, s.end, s.region]));
  sec.add('lex.holes', lx.holes.map(r2a));
  sec.add('lex.idents', lx.idents.map((i) => [i.offset, i.length, i.name]));
  sec.add('lex.numbers', lx.numbers.map(r2a));
  sec.add('lex.punct', Array.from(lx.punct));
  sec.add('lex.lineStarts', Array.from(lx.lineStarts));
  const blocks = focus.scanBlocks(text, languageId);
  sec.add('blocks', blocks.map(blockRow));
  const excludes = focus.topLevelExcludes(text, blocks, languageId);
  sec.add('topLevelExcludes', excludes.map(r2a));
  sec.add('topLevelLines', focus.topLevelLines(text, lx.lineStarts, excludes));
  sec.add('topLevelBlock', blockRow(focus.topLevelBlock(text)));
  sec.add('regions', blocks.map((b) => {
    const fs = focus.functionScopeOf(text, b, languageId);
    return [
      r2a(focus.lexRegionFor(text, b, languageId)),
      r2a(focus.declRegionFor(text, b, languageId)),
      r2a(focus.scopeRegionFor(text, b, languageId)),
      fs ? r2a(fs) : null,
      focus.isFunctionHeader(text, b, languageId),
    ];
  }));
  // innermostBlock for a caret on every 7th line, both at line start and mid-line.
  const lines = lx.lineStarts.length;
  const carets = [];
  for (let line = 0; line < lines; line += 7) {
    const ls = lx.lineStarts[line];
    for (const off of [ls, ls + 6]) {
      const b = focus.innermostBlock(blocks, line, off, text);
      carets.push(b ? blockRow(b) : null);
    }
  }
  sec.add('innermostBlock', carets);
  sec.add('band1', {
    placeholders: ({
      rust: rustPlaceholderSpans, python: pythonPlaceholderSpans, lua: luaPlaceholderSpans, ruby: rubyPlaceholderSpans, zig: zigPlaceholderSpans,
    }[languageId]?.(text) ?? []).map(r2a),
    goDocLinks: languageId === 'go' ? goDocLinkSpans(text, lx).map(r2a) : [],
  });
  if (languageId === 'zig') {
    const z = zigFacts(lx);
    sec.add('zigFacts', {
      nonDataAt: [...z.nonDataAt].sort((a, b) => a - b),
      nonDataNames: [...z.nonDataNames].sort(),
      captures: z.captures.map((c) => c.offset),
      containerOpens: [...z.containerOpens].sort((a, b) => a - b),
      imports: [...z.imports].sort(),
      importSpans: zigImportSpans(lx).map(r2a),
    });
  }
  return { sec, blocks };
}

/**
 * A Decorator over `input` on fake timers, recording into a section named `name`.
 * With `server`, a language server that follows the edits answers; without, none is registered.
 */
function sessionHarness(t, input, blocks, name, server, tail = '') {
  const sec = new Section(name);
  const doc = makeDoc({ ...input, text: input.text + tail });
  const state = lspState(doc, input);
  stub.clearLspResponses();
  if (server) stub.setLspHandler(lspHandler(doc, state));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const ed = new stub.TextEditor(doc, 0, 0);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  let calls = 0;
  ed.setDecorations = (type, ranges) => {
    calls++;
    live.set(type, ranges);
  };
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  const labels = new Map([[d.gutterDecoration, 'gutter']]);
  for (const [k, v] of Object.entries(d.pool)) {
    if (Array.isArray(v)) v.forEach((type, i) => labels.set(type, `${k}${i}`));
    else if (typeof v === 'object') labels.set(v, k);
  }
  const flush = async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
  };
  const advance = async (ms) => {
    await flush();
    for (let left = ms; left > 0; left -= 20) {
      t.mock.timers.tick(Math.min(20, left));
      await flush();
    }
  };
  // The gutter is compared as the set of lines it covers: VS Code draws a glyph on
  // every line of a decoration's range, so one range per line and one range per run
  // of lines paint the same stripe.
  const gutterLines = (ranges) => {
    const lines = new Set();
    for (const r of ranges) for (let l = r.start.line; l <= r.end.line; l++) lines.add(l);
    return [...lines].sort((a, b) => a - b);
  };
  const snapshot = (label) => {
    const rows = [];
    for (const [type, ranges] of live) {
      const name = labels.get(type) ?? `?${type.id}`;
      rows.push([name, name === 'gutter'
        ? gutterLines(ranges)
        : ranges.map((r) => [r.start.line, r.start.character, r.end.line, r.end.character])]);
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    sec.add(label, { phase: d.machine.current, rows });
  };
  const caretTo = (off) => {
    const p = doc.positionAt(off);
    ed.selection = new vs.Selection(p.line, p.character, p.line, p.character);
    d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 });
  };
  /** Type `text` at `off`, the caret after it; the server's tokens and symbols move with it. */
  const typeAt = (off, text = ' ') => {
    const ev = doc.applyEdit(off, off, text);
    state.shift(off, text.length);
    const p = doc.positionAt(off + text.length);
    ed.selection = new vs.Selection(p.line, p.character, p.line, p.character);
    d.onEdit(ev);
  };

  const text = doc.getText();
  const fns = blocks.filter((b) => b.depth === 0 && focus.isFunctionHeader(text, b, input.languageId));
  const span = (b) => b.closeOffset - b.openOffset;
  const late = fns.filter((b) => b.openOffset > text.length * 0.9);
  const lastFn = [...(late.length > 0 ? late : fns)].sort((a, b) => span(b) - span(a) || a.openOffset - b.openOffset)[0];
  const early = fns.filter((b) => b.openOffset < text.length * 0.1);
  const firstFn = [...(early.length > 0 ? early : fns)].sort((a, b) => span(b) - span(a) || a.openOffset - b.openOffset)[0];
  const nested = blocks
    .filter((b) => b.openOffset > lastFn.openOffset && b.closeOffset < lastFn.closeOffset)
    .sort((a, b) => b.depth - a.depth || a.openOffset - b.openOffset)[0] ?? lastFn;
  // 4 characters into the first body line the block itself holds: a Lua body opens at the
  // line break after `)` or `do`, and often on a nested loop's header.
  const inside = (b) => {
    for (let nl = text[b.openOffset] === '\n' ? b.openOffset : text.indexOf('\n', b.openOffset + 1); nl >= 0; nl = text.indexOf('\n', nl + 1)) {
      const at = nl + 5;
      if (at >= b.closeOffset - 1) break;
      if (focus.innermostBlock(blocks, doc.positionAt(at).line, at, text) === b) return at;
    }
    return b.closeOffset - 1;
  };
  let topOff = 0;
  for (let o = text.indexOf('\n', Math.floor(text.length * 0.95)) + 1; o > 0 && o < text.length; o = text.indexOf('\n', o) + 1) {
    if (!focus.innermostBlock(blocks, doc.positionAt(o).line, o)) {
      topOff = o;
      break;
    }
  }
  const finish = () => {
    sec.add('setDecorations calls', calls);
    d.dispose();
    stub.clearLspResponses();
    t.mock.timers.reset();
    return sec;
  };
  return { sec, doc, d, text, firstFn, lastFn, nested, inside, topOff, flush, advance, snapshot, caretTo, typeAt, finish };
}

/** One open → navigate → type session with a server. */
async function renderSection(t, input, blocks) {
  const h = sessionHarness(t, input, blocks, 'render', true);
  const { d, text, firstFn, lastFn, nested, inside, topOff, flush, advance, snapshot, caretTo, typeAt } = h;
  d.refresh();
  await advance(200);
  snapshot('open');
  caretTo(inside(firstFn));
  await advance(200);
  snapshot('engage first fn');
  caretTo(inside(lastFn));
  await advance(200);
  snapshot('jump to last fn');
  caretTo(inside(lastFn) + 1);
  await advance(200);
  snapshot('move within the block');
  caretTo(inside(nested));
  await advance(200);
  snapshot('nested block');
  caretTo(inside(lastFn));
  await advance(200);
  snapshot('back to last fn');
  caretTo(topOff);
  await advance(200);
  snapshot('module top level');
  caretTo(inside(lastFn));
  await advance(200);
  snapshot('back into last fn');

  // Typing a trailing space at the end of a body line: no token or block changes shape.
  const lineEnd = text.indexOf('\n', inside(lastFn));
  typeAt(lineEnd);
  await flush();
  snapshot('keystroke, before the reclassify');
  await advance(300);
  snapshot('keystroke, reclassified');
  for (let i = 1; i <= 5; i++) {
    typeAt(lineEnd + i);
    await advance(40);
  }
  await advance(300);
  snapshot('burst of 5 keystrokes');
  await advance(2200);
  snapshot('relaxed to Focus');
  return h.finish();
}

/** Appended to the edit session's text: shapes the generated inputs lack (builtin-named bindings). */
const EDIT_TAIL = {
  python: '\n\ndef restore_shapes(id, type=None):\n    len = sorted(id)\n    return id, type, len\n\n\nmax = 3\nprint(max, min)\n',
};

/** Gaps between the 40 keys of the long burst: typing speed varies, some gaps outlast the debounce. */
const KEY_GAPS = [40, 180, 60, 400, 120, 30, 250, 90, 160, 600];

/**
 * First paint, a new line, an unclosed bracket typed and later closed, and 40 keys
 * at mixed speeds; with or without a server, so the restores and the no-server
 * paint are hashed too.
 */
async function editSection(t, input, blocks, server) {
  const h = sessionHarness(t, input, blocks, server ? 'edits' : 'editsNoServer', server, EDIT_TAIL[input.languageId]);
  const { d, doc, lastFn, inside, flush, advance, snapshot, caretTo, typeAt } = h;
  d.refresh();
  await flush();
  snapshot('first paint');
  await advance(200);
  snapshot('open');
  caretTo(inside(lastFn));
  await advance(200);
  snapshot('engaged');
  const at = doc.getText().indexOf('\n', inside(lastFn));
  typeAt(at, '\n    ');
  await flush();
  snapshot('new line, before the reclassify');
  await advance(400);
  snapshot('new line, reclassified');
  const open = at + 5;
  typeAt(open, 'g(');
  await advance(400);
  snapshot('unclosed bracket');
  for (let i = 0; i < 40; i++) {
    typeAt(open + 2 + i, 'x');
    await advance(KEY_GAPS[i % KEY_GAPS.length]);
  }
  snapshot('40 keys');
  typeAt(open + 42, ')');
  await advance(400);
  snapshot('bracket closed');
  await advance(2200);
  snapshot('relaxed to Focus');
  return h.finish();
}

for (const [ext, lines] of INPUTS) {
  const input = generate(ext, lines, focus.scanBlocks);
  test(`perf golden: ${input.key} (${input.text.length} chars) output matches the recorded hashes`, async (t) => {
    const got = {};
    const { sec, blocks } = structureSection(input);
    got.structure = sec.digest(input.key);
    const sample = [...sampleBlocks(blocks), focus.topLevelBlock(input.text)];

    stub.clearLspResponses();
    const doc = makeDoc(input);
    stub.setLspHandler(lspHandler(doc, lspState(doc, input)));
    const semantic = new Section('semantic');
    await classifySample(semantic, input, doc, blocks, sample, true);
    got.semantic = semantic.digest(input.key);

    stub.clearLspResponses();
    const heuristicDoc = makeDoc(input);
    const heuristic = new Section('heuristic');
    await classifySample(heuristic, input, heuristicDoc, blocks, sample.filter((_, i) => i % 3 === 0), false);
    got.heuristic = heuristic.digest(input.key);

    got.render = (await renderSection(t, input, blocks)).digest(input.key);
    got.edits = (await editSection(t, input, blocks, true)).digest(input.key);
    got.editsNoServer = (await editSection(t, input, blocks, false)).digest(input.key);
    results[input.key] = got;

    if (RECORD) {
      return;
    }
    assert.ok(recorded[input.key], `no recorded hashes for ${input.key}; run with PERF_GOLDEN_RECORD=1`);
    for (const name of Object.keys(got)) {
      assert.equal(got[name], recorded[input.key][name], `${input.key} ${name} output changed`);
    }
  });
}

if (RECORD) {
  after(() => {
    const ordered = Object.fromEntries(Object.keys(results).sort().map((k) => [k, results[k]]));
    fs.writeFileSync(HASH_FILE, `${JSON.stringify(ordered, null, 2)}\n`);
  });
}
