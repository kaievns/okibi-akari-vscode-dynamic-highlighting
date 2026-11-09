'use strict';
// Lua: the lexer table, the keyword block scan, both classifiers, escape marks and the
// band-1 restores, on samples/sample.lua and lua-language-server 3.19.2 tokens for it.
// Rules: docs/lua.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
const { lex, lexFor } = require('../out/lex');
const focus = require('../out/focus');
const risk = require('../out/risk');
const { Classifier } = require('../out/classify-lsp');
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');
const { luaFacts, luaRestoreSpans } = require('../out/lua');
const { luaPlaceholderSpans } = require('../out/placeholders');
const { typesStringLiterals } = require('../out/classify-lsp');
const { growth } = require('./cpu-time');

const SRC = fs.readFileSync(path.join(__dirname, '../samples/sample.lua'), 'utf8');
const LUALS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample.lua.lsp.json'), 'utf8'));
const FORMAT = fs.readFileSync(path.join(__dirname, 'fixtures/format.lua'), 'utf8');
const capture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, `fixtures/${name}`), 'utf8'));
const FORMAT_KEYWORD = capture('format.lua.keyword.lsp.json');
const FORMAT_DEFAULT = capture('format.lua.lsp.json');
const lineOf = (text, needle, nth = 1) => {
  let at = -1;
  for (let i = 0; i < nth; i++) at = text.indexOf(needle, at + 1);
  assert.ok(at >= 0, `needle ${needle}`);
  return text.slice(0, at).split('\n').length - 1;
};
const regions = (text) => lexFor(text, 'lua').spans.map((s) => `${s.region}:${text.slice(s.start, s.end)}`);

test('lua lexer: line, doc and long comments; short and long strings; // is floor division', () => {
  const t = [
    '--- doc', '-- line', 'x = 1 // 2', '--[[ long', 'still ]] y = 1', '--[==[ a ]] b ]==] z = 2',
    "s = 'it\\'s' .. \"q\\\"\" .. [[a -- b]] .. [=[c ]] d]=]", 's = "a\\z', '   b"', 's = "a\\', 'b"', 'n = #t',
  ].join('\n');
  assert.deepEqual(regions(t), [
    'comment:--- doc', 'comment:-- line', 'comment:--[[ long\nstill ]]', 'comment:--[==[ a ]] b ]==]',
    "string:'it\\'s'", 'string:"q\\""', 'string:[[a -- b]]', 'string:[=[c ]] d]=]', 'string:"a\\z\n   b"', 'string:"a\\\nb"',
  ]);
  assert.deepEqual(lexFor(t, 'lua').idents.map((i) => i.name), ['x', 'y', 'z', 's', 's', 's', 'n', 't']);
});

test('lua lexer: a shebang on the first line is a comment; `#` elsewhere is the length operator', () => {
  assert.deepEqual(regions('#!/usr/bin/env lua\nlocal n = #t\n'), ['comment:#!/usr/bin/env lua']);
});

test('lua lexer: a long bracket opens only right after `--`; a short string ends at its quote or its line', () => {
  const t = '--x[[ a line comment\ny = 1 ]]\ns = "a\\z"\nu = "open\nv = 2\n';
  assert.deepEqual(regions(t), ['comment:--x[[ a line comment', 'string:"a\\z"', 'string:"open']);
  assert.deepEqual(lexFor(t, 'lua').idents.map((i) => i.name), ['y', 's', 'u', 'v']);
});

test('lua lexer: hex floats, trailing-dot and LuaJIT suffixed numerals are one literal', () => {
  const t = 'a = 0x1p4 + 0xA.8p-1 + 0xA.8 + 100. + .5 + 1e10 + 0xffULL + 12LL + 3i + t..1';
  const lx = lexFor(t, 'lua');
  assert.deepEqual(lx.numbers.map((n) => t.slice(n.start, n.end)), ['0x1p4', '0xA.8p-1', '0xA.8', '100.', '.5', '1e10', '0xffULL', '12LL', '3i', '1']);
});

test('lua blocks: function, loops, each if branch, repeat with its until condition, do; tables are not scopes', () => {
  const blocks = focus.scanBlocks(SRC, 'lua');
  const at = (needle) => blocks.find((b) => b.openLine === lineOf(SRC, needle));
  const lines = (b) => [b.openLine, b.closeLine];
  const scale = at('function Point:scale(k)');
  assert.deepEqual(lines(scale), [lineOf(SRC, 'function Point:scale(k)'), lineOf(SRC, 'function Point:scale(k)') + 5]);
  assert.ok(focus.functionScopeOf(SRC, scale, 'lua'));
  const loop = at('for index, item in ipairs(list) do');
  assert.equal(focus.functionScopeOf(SRC, loop, 'lua'), null);
  assert.equal(focus.declRegionFor(SRC, loop, 'lua').start, loop.headerStart, 'loop variables are block-local');
  const branch = at('elseif type(item) == "table" then');
  assert.deepEqual(lines(branch), [lineOf(SRC, 'elseif type(item)'), lineOf(SRC, 'walk(item, visit)')]);
  const rep = at('  repeat');
  assert.equal(rep.closeLine, lineOf(SRC, 'until n >= 3'), 'the until condition sees the body');
  assert.equal(SRC.slice(rep.closeOffset, rep.closeOffset + 1), '3');
  assert.equal(blocks.filter((b) => SRC[b.openOffset - 1] === '{').length, 0);
  const anon = at('  on_attach = function(client, bufnr)');
  assert.equal(SRC.slice(anon.headerStart, anon.openOffset), 'function(client, bufnr)', 'the header starts at the keyword');
});

test('lua blocks: bodies open past `then` and `repeat`; an until condition runs over its brackets; the function around it closes at its end', () => {
  const t = 'local function f(n)\n  if n then\n    repeat local v = n until g(\n      v, t[\n      1], {\n      })\n  end\n  return n\nend\n';
  const blocks = focus.scanBlocks(t, 'lua');
  const byHeader = (word) => blocks.find((b) => t.startsWith(word, b.headerStart));
  assert.equal(byHeader('if').openOffset, t.indexOf('then') + 4);
  const rep = byHeader('repeat');
  assert.equal(rep.openOffset, t.indexOf('repeat') + 6);
  assert.deepEqual([rep.openLine, rep.closeLine, t[rep.closeOffset]], [2, 5, ')']);
  const fn = byHeader('local function');
  assert.deepEqual([fn.openLine, fn.closeLine], [0, 8]);
  const table = 'repeat local v = 1 until #{\n  v } > 0\nx = 1\n';
  assert.equal(focus.scanBlocks(table, 'lua')[0].closeLine, 1, 'a table in the condition');
});

test('lua blocks: an opener without its end makes no block, and every later end still pairs', () => {
  const t = 'local function f()\n  if x then\n    y()\nend\nlocal function g() return 1 end\n';
  const blocks = focus.scanBlocks(t, 'lua');
  assert.deepEqual(blocks.map((b) => [b.openLine, b.closeLine, b.depth]), [[1, 3, 1], [4, 4, 1]], 'f stays open, so both nest one deeper');
});

test('lua facts: locals with attributes, for variables, parameters, modules, namespace globals, chunk globals', () => {
  const lx = lexFor(SRC, 'lua');
  const f = luaFacts(lx);
  const names = (set) => [...set].map((o) => lx.idents.find((i) => i.offset === o).name).sort();
  assert.deepEqual(names(f.modules), ['fmt', 'json', 'util']);
  assert.ok(names(f.declSites).includes('MAX_RETRIES') && names(f.declSites).includes('file'), '<const> and <close> locals declare');
  assert.ok(f.namespaces.has('vim') && f.namespaces.has('math') && !f.namespaces.has('counter'));
  assert.deepEqual(names(f.globalSites), ['counter']);
});

/** Offset of the `nth` code identifier named `name`. */
const idAt = (lx, name, nth = 1) => lx.idents.filter((i) => i.name === name)[nth - 1].offset;

test('lua facts: labels bind nothing, a statement after a label does; require with a trailing comment or on the next line', () => {
  const t = [
    'local json = require("dkjson") -- JSON',
    'local util =',
    '  require "lib.util"',
    'local pair = require("a"), 1',
    'local field = require("x").y',
    'for i = 1, 3 do',
    '  ::top:: count = i',
    '  goto top',
    'end',
  ].join('\n');
  const lx = lexFor(t, 'lua');
  const f = luaFacts(lx);
  const names = (set) => [...set].map((o) => f.decls.get(o).name).sort();
  assert.deepEqual(names(f.modules), ['json', 'util']);
  assert.equal(f.binding.get(idAt(lx, 'top', 1)), undefined);
  assert.equal(f.binding.get(idAt(lx, 'top', 2)), undefined);
  assert.equal(f.binding.get(idAt(lx, 'i', 2)), idAt(lx, 'i'));
  assert.ok(f.globalSites.has(idAt(lx, 'count')), 'a chunk-level loop body assigns the global');
});

test('lua facts: keys and labels bind nothing, whatever the blanks; a name ending in goto is no goto', () => {
  const t = 'goto done\nlocal w = 0\n::done::\nlocal x = 1\nlocal t = { x, a = x, b\t= 2, c\n= 3; d = x }\nlocal y = xgoto\nz = 2\nu = 1; v = 2\n';
  const lx = lexFor(t, 'lua');
  const f = luaFacts(lx);
  for (const name of ['done', 'a', 'b', 'c', 'd']) assert.equal(f.binding.get(idAt(lx, name)), undefined, name);
  assert.equal(f.binding.get(idAt(lx, 'x', 2)), idAt(lx, 'x'), 'a positional element is a read');
  assert.equal(f.binding.get(idAt(lx, 'x', 3)), idAt(lx, 'x'));
  assert.ok(f.globalSites.has(idAt(lx, 'z')), 'z follows `xgoto`, not a goto');
  assert.ok(f.globalSites.has(idAt(lx, 'u')) && f.globalSites.has(idAt(lx, 'v')), 'a `;` ends a statement');
});

test('lua facts: a local is visible after its statement, a local function inside its own body', () => {
  const t = 'local x = 1\nlocal function f() return f, x end\nlocal g = function() return g end\nlocal x = x + 1\n';
  const lx = lexFor(t, 'lua');
  const f = luaFacts(lx);
  assert.equal(f.binding.get(idAt(lx, 'f', 2)), idAt(lx, 'f'));
  assert.equal(f.binding.get(idAt(lx, 'g', 2)), -1, 'the local is not visible in its own right-hand side');
  assert.equal(f.binding.get(idAt(lx, 'x', 4)), idAt(lx, 'x'), 'the right-hand side reads the earlier x');
  assert.equal(f.binding.get(idAt(lx, 'x', 2)), idAt(lx, 'x'));
});

test('lua facts: statements that span lines bind their locals after the last line', () => {
  const t = [
    'do end', 'local f = function()', '  return f', 'end', 'local t = {', '  t,', '}', 'local c = call(', '  c)',
    'local s = "a" ..', '  s', 'local ok = a and', '  ok', 'local n = 100.', 'print(n, s, ok, t, f, c)',
    'local p = f(g(1)', '  , p)', 'local q = x[1', '  + q]', 'local r = { 1', '  , r }', 'print(p, q, r)', 'do end',
  ].join('\n');
  const lx = lexFor(t, 'lua');
  const f = luaFacts(lx);
  for (const name of ['f', 't', 'c', 's', 'ok', 'p', 'q', 'r']) {
    assert.equal(f.binding.get(idAt(lx, name, 2)), -1, `${name} inside its own statement is the global`);
    assert.equal(f.binding.get(idAt(lx, name, 3)), idAt(lx, name), `${name} after it is the local`);
  }
  assert.equal(f.binding.get(idAt(lx, 'n', 2)), idAt(lx, 'n'), 'a trailing-dot numeral ends the statement');
  const nested = 'local function a()\n  local one = 1\n  return one\nend\nlocal function b()\n  if x then\n    local two = 2\n    return two\n  end\nend\n';
  const nx = lexFor(nested, 'lua');
  const nf = luaFacts(nx);
  for (const name of ['one', 'two']) assert.equal(nf.binding.get(idAt(nx, name, 2)), idAt(nx, name), `${name} inside a block, read on the next line`);
});

test('lua facts: scopes, attributes, a local with no value, aliases, namespaces, modules named like builtins', () => {
  const t = [
    'x = 1', 'do local inner = 1 end', 'print(inner)', 'local a <const>, b <close> = 1, 2', 'local late', 'late = 3',
    'local s = string', 'local type = type', 'print(gl + 1, cat .. "x", s, type)', 'function N.f() end', 'return N.f',
    'local m = require(name)', 'local cat2 = require("a" .. "b")', 'local next = require("next")', 'next.x()', '',
  ].join('\n');
  const lx = lexFor(t, 'lua');
  const f = luaFacts(lx);
  const names = (set) => [...set].map((o) => f.decls.get(o).name).sort();
  assert.ok(f.globalSites.has(0), 'the first identifier of the file');
  assert.equal(f.binding.get(idAt(lx, 'inner', 2)), -1, 'a block local ends with its block');
  assert.ok(f.declSites.has(idAt(lx, 'a')) && f.declSites.has(idAt(lx, 'b')));
  assert.ok(!f.declSites.has(idAt(lx, 'const')) && !f.declSites.has(idAt(lx, 'close')), 'attributes declare nothing');
  assert.equal(f.binding.get(idAt(lx, 'late', 2)), idAt(lx, 'late'));
  assert.deepEqual(names(f.functionSites), ['type'], 'an alias of the same standard name, not any standard value');
  assert.ok(f.namespaces.has('N') && !f.namespaces.has('gl') && !f.namespaces.has('cat'));
  assert.deepEqual(names(f.modules), ['next']);
  assert.deepEqual(luaRestoreSpans(lx).shadows.map((x) => t.slice(x.start, x.end)), [], 'a module, an alias and a call are no shadows');
  assert.deepEqual(luaRestoreSpans(lx).imports.map((x) => t.slice(x.start, x.end)), ['next']);
});

test('lua facts: typing `local` at the end of a file', () => {
  for (const t of ['x = 1\nlocal', 'local', 'local x <', 'for', 'local function']) assert.doesNotThrow(() => luaFacts(lexFor(t, 'lua')), t);
});

test('lua facts: typing `<const>` changes nothing below the line, with a `>` further down', async () => {
  const lines = [
    'local M = {}', 'local json = require("dkjson")', '', 'function M.run(items)', '  local limit', '  local count = 0',
    '  for _, v in ipairs(items) do', '    count = count + v', '  end', '  local type = items.type',
    '  return json.encode({ n = count, max = limit, kind = type })', 'end', '', 'vim.keymap.set("n", "<leader>r", M.run)',
    'print("<x>")', 'return M', '',
  ];
  const base = lines.join('\n');
  const at = base.indexOf('  local limit') + '  local limit'.length;
  const below = (text, delta) => {
    const lx = lexFor(text, 'lua');
    const f = luaFacts(lx);
    const cut = text.indexOf('\n', at + delta);
    const o = (x) => (x > at ? x - delta : x);
    const r = luaRestoreSpans(lx);
    const spans = (s) => s.filter((x) => x.start > cut).map((x) => `${o(x.start)}-${o(x.end)}`);
    return {
      decls: [...f.decls.values()].filter((d) => d.offset > cut).map((d) => `${d.name}@${o(d.offset)} ${d.kind} ${o(d.from)}-${o(d.to)}`),
      bindings: [...f.binding].filter(([id]) => id > cut).map(([id, d]) => `${o(id)}:${d < 0 ? d : o(d)}`),
      modules: [...f.modules].map((m) => f.decls.get(m).name),
      imports: spans(r.imports),
      shadows: spans(r.shadows),
    };
  };
  const want = below(base, 0);
  assert.equal(want.imports.length, 1);
  assert.equal(want.shadows.length, 1);
  const loopData = async (text) => [...(await classify(text, null, '    count = count + v', 'v')).byName.keys()].sort();
  const wantLoop = await loopData(base);
  assert.ok(wantLoop.includes('count'));
  const typed = ' <const> = 1';
  for (let i = 1; i <= typed.length; i++) {
    const text = base.slice(0, at) + typed.slice(0, i) + base.slice(at);
    assert.deepEqual(below(text, i), want, JSON.stringify(typed.slice(0, i)));
    assert.deepEqual(await loopData(text), wantLoop, JSON.stringify(typed.slice(0, i)));
  }
});

test('lua facts cost grows linearly with the file', () => {
  const unit = (i) => [
    `local function f${i}(a, b)`, '  local x <const> = a + b', '  for j = 1, x do',
    '    if j % 2 == 0 then total = total + j else b = b - 1 end', '  end', '  return x', 'end',
  ].join('\n');
  const setup = (n) => {
    const text = 'local json = require("dkjson")\ntotal = 0\n' + Array.from({ length: n }, (_, i) => unit(i)).join('\n');
    return { lx: lex(text, 'lua'), blocks: focus.scanBlocks(text, 'lua') };
  };
  const ratio = growth(setup, ({ lx, blocks }) => luaFacts(lx, blocks), 300);
  assert.ok(ratio < 24, `8x the lines cost ${ratio.toFixed(1)}x (a scan per declaration costs 64x)`);
});

async function classify(text, served, caretNeedle, tok) {
  stub.clearLspResponses();
  if (served) {
    stub.setLspResponses({
      'vscode.provideDocumentSemanticTokensLegend': served.legend,
      'vscode.provideDocumentSemanticTokens': { data: served.data },
      'vscode.executeDocumentSymbolProvider': [],
    });
  }
  const doc = new stub.TextDocument(text, 'lua', `file:///lua-${Math.random()}.lua`);
  const blocks = focus.scanBlocks(text, 'lua');
  const line = lineOf(text, caretNeedle);
  const lineText = text.split('\n')[line];
  const offset = text.split('\n').slice(0, line).join('\n').length + (line > 0 ? 1 : 0) + lineText.indexOf(tok, lineText.indexOf(caretNeedle.trim()));
  const block = focus.innermostBlock(blocks, line, offset, text);
  const r = await new Classifier().classifyScope(doc, block, 5, { isCancellationRequested: false }, { text, blocks });
  const escapes = risk.escapeRisk(text, focus.lexRegionFor(text, block, 'lua'), r.focused, 'lua').map((e) => text.slice(e.start, e.end));
  return { byName: r.focused.byName, escapes, block };
}

for (const [mode, served] of [['no server', null], ['lua-language-server tokens', LUALS]]) {
  test(`lua classification, ${mode}: data in the block; members, keys, callees, modules, namespaces and doc comments are not`, async () => {
    const m = await classify(SRC, served, 'local opts = { buffer = bufnr', 'bufnr');
    for (const n of ['opts', 'bufnr', 'client']) assert.ok(m.byName.has(n), `${n} is data`);
    for (const n of ['buffer', 'silent', 'keymap', 'vim', 'server_capabilities', 'set']) assert.ok(!m.byName.has(n), `${n} is not`);
    const top = await classify(SRC, served, 'local t = table.concat', 't');
    for (const n of ['table', 'concat', 'fmt', 'json', 'string', 'format']) assert.ok(!top.byName.has(n), `${n} is not data`);
    const doc = await classify(SRC, served, 'function Point.new(x, y)', 'x');
    assert.equal(doc.byName.get('x')?.cls, 'fn', 'the parameter, never the ---@param in the comment above');
  });
}

test('lua escape marks with lua-language-server tokens: upvalue, outer, member and method self writes; never constructors, locals or chunk globals', async () => {
  const at = async (needle, tok) => (await classify(SRC, LUALS, needle, tok)).escapes;
  assert.deepEqual(await at('count = count + (step or 1)', 'step'), ['count', 'counter']);
  assert.deepEqual(await at('self.x = self.x * factor', 'factor'), ['self.x', 'self.y'], 'a local before the write is not a local self');
  assert.deepEqual(await at('  self.x = x', 'x'), [], 'Point.new owns its local self');
  assert.deepEqual(await at('total = total + v', 'v'), ['total']);
  assert.deepEqual(await at('client.server_capabilities', 'client'), ['client.server_capabilities.documentFormattingProvider']);
  assert.deepEqual(await at('counter = 0', 'counter'), [], 'a chunk-level assignment defines the global');
  assert.deepEqual((await classify(SRC, null, 'count = count + (step or 1)', 'step')).escapes, [], 'the heuristic makes no claim');
});

test('lua lexical risk: no async marks, clay only on code numbers', () => {
  const t = 'local async = require("a")\nlocal n = 1 -- 2\nasync.run(function() await(3) end)\n';
  const r = risk.lexicalRisk(t, { start: 0, end: t.length }, 'lua');
  assert.deepEqual(r.async, []);
  assert.deepEqual(r.numberEngaged.map((x) => t.slice(x.start, x.end)), ['1', '3']);
});

test('lua band 1: module uses at slate; shadowed builtins at the page colour except calls, aliases and assignment targets', () => {
  const t = 'local json = require("dkjson")\nlocal type = node.type\nif type == "x" then print(type) end\n'
    + 'local tostring = tostring\nprint(tostring(json.encode(type)))\nlocal function next() end\n';
  const r = luaRestoreSpans(lexFor(t, 'lua'));
  assert.deepEqual(r.imports.map((x) => t.slice(x.start, x.end)), ['json']);
  assert.deepEqual(r.shadows.map((x) => `${t.slice(0, x.start).split('\n').length}:${t.slice(x.start, x.end)}`), ['3:type', '3:type', '5:type']);
  assert.deepEqual(luaRestoreSpans(lexFor(SRC, 'lua')).shadows.map((x) => SRC.slice(x.start, x.end)), ['type', 'type']);
  const calls = 'local next, unpack, select = a, b, c\nnext (t)\nunpack { 1 }\nselect "#"\nreturn next, unpack, select\n';
  assert.deepEqual(luaRestoreSpans(lexFor(calls, 'lua')).shadows.map((x) => `${calls.slice(0, x.start).split('\n').length}:${calls.slice(x.start, x.end)}`),
    ['1:next', '1:unpack', '5:next', '5:unpack', '5:select'], 'calls with `(`, `{` or a string are not, nor `select =`, which the grammar leaves alone');
});

let seq = 0;
async function editor(text, served, caret = 'counter_factory()') {
  stub.clearLspResponses();
  if (served) {
    stub.setLspResponses({
      'vscode.provideDocumentSemanticTokensLegend': served.legend,
      'vscode.provideDocumentSemanticTokens': { data: served.data },
      'vscode.executeDocumentSymbolProvider': [],
    });
  }
  const doc = new stub.TextDocument(text, 'lua', `file:///lua-editor-${seq++}.lua`);
  const ed = new stub.TextEditor(doc, lineOf(text, caret), 2);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  d.engaged.add(doc.uri.toString());
  d.render();
  await d.runClassify(doc);
  const shown = (type) => (live.get(type) ?? []).map((r) => doc.lineAt(r.start.line).text.slice(r.start.character, r.end.character));
  return { d, doc, live, shown };
}

test('lua band 1 stays on when lua-language-server answers, in every phase; an edit keeps it until typing pauses', async () => {
  const h = await editor(SRC, LUALS);
  assert.ok(h.d.classifier.semanticOk(h.doc));
  for (const phase of [Phase.Survey, Phase.Focus, Phase.Edit]) {
    h.d.machine.phase = phase;
    h.d.render();
    assert.deepEqual(h.shown(h.d.pool.importRestore), ['json', 'util'], phase);
    assert.deepEqual(h.shown(h.d.pool.shadowRestore), ['type', 'type'], phase);
  }
  let sends = 0;
  const set = h.live.set.bind(h.live);
  h.live.set = (type, ranges) => {
    if (type === h.d.pool.importRestore) sends++;
    return set(type, ranges);
  };
  for (const piece of ['\nprint(', 'json', ')\n']) {
    h.d.onEdit(h.doc.applyEdit(h.doc.getText().length, h.doc.getText().length, piece));
    h.d.render();
  }
  assert.equal(sends, 0, 'nothing re-sent while typing');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sends, 1);
  assert.deepEqual(h.shown(h.d.pool.importRestore), ['json', 'util', 'json']);
  h.d.dispose();
});

test('lua band 1 without a server paints the same restores', async () => {
  const h = await editor(SRC, null);
  assert.ok(!h.d.classifier.semanticOk(h.doc));
  assert.deepEqual(h.shown(h.d.pool.importRestore), ['json', 'util']);
  assert.deepEqual(h.shown(h.d.pool.shadowRestore), ['type', 'type']);
  h.d.dispose();
});

const FORMAT_HOLES = [
  '4:%s', '4:%5.2f', '4:%%', '4:%-3d', '7:%x', '8:%s', '8:%s', '9:%d', '9:%d', '11:%d', '11:%s', '14:%q', '15:%s', '15:%i',
  '16:%d', '16:%c',
];
const holes = (text, spans) => spans.map((x) => `${text.slice(0, x.start).split('\n').length}:${text.slice(x.start, x.end)}`);

test('lua placeholders: the call shapes lua-gaps reads; never a pattern, a later argument, a comment or a long string', () => {
  assert.deepEqual(holes(FORMAT, luaPlaceholderSpans(FORMAT)), FORMAT_HOLES);
  const t = [
    'x = string.format("\\%d \\\\%s")', 'y = a.string.format("%d")', 'z = "" ..string.format("%d")', 'w = string.format("%d',
    'v = string.format(\r', '  "%x")', 'u = ([[%d', ']]):format(1)', 'r = ("%d"', '):format(1)', 'q = string.format([[%d', ']])',
  ].join('\n');
  assert.deepEqual(holes(t, luaPlaceholderSpans(t)), ['1:%s', '3:%d', '4:%d', '6:%x'],
    'an escape takes one character; a member `string` is no library; an unclosed literal runs to its line end; a long or method literal closes on its line');
});

test('lua answers: a `string` token with no modifier marks string literals typed, as only `Lua.semantic.keyword` sends', () => {
  const types = (c) => typesStringLiterals(c.data, c.legend.tokenTypes);
  assert.equal(FORMAT_KEYWORD.keyword, true);
  assert.equal(types(FORMAT_KEYWORD), true);
  assert.equal(types(FORMAT_DEFAULT), false, 'the LuaCATS `"short"|"long"` strings are `string.static`');
  assert.equal(types(LUALS), false);
});

test('lua placeholders paint while lua-language-server types string literals, in every phase, and follow its answers', async () => {
  const h = await editor(FORMAT, FORMAT_KEYWORD, 'local a =');
  const painted = () => holes(h.doc.getText(), (h.live.get(h.d.pool.placeholder) ?? []).map((r) => ({ start: h.doc.offsetAt(r.start), end: h.doc.offsetAt(r.end) })));
  assert.ok(h.d.classifier.typesStrings(h.doc));
  for (const phase of [Phase.Survey, Phase.Focus, Phase.Edit]) {
    h.d.machine.phase = phase;
    h.d.render();
    assert.deepEqual(painted(), FORMAT_HOLES, phase);
  }
  const answer = async (served) => {
    stub.clearLspResponses();
    if (served) {
      stub.setLspResponses({
        'vscode.provideDocumentSemanticTokensLegend': served.legend,
        'vscode.provideDocumentSemanticTokens': { data: served.data },
        'vscode.executeDocumentSymbolProvider': [],
      });
    }
    h.d.onEdit(h.doc.applyEdit(h.doc.getText().length, h.doc.getText().length, '\n'));
    await h.d.runClassify(h.doc);
    await new Promise((r) => setTimeout(r, 50));
    h.d.render();
    return painted();
  };
  assert.deepEqual(await answer(FORMAT_DEFAULT), [], 'an answer without them takes the restore off');
  assert.deepEqual(await answer(FORMAT_KEYWORD), FORMAT_HOLES);
  assert.deepEqual(await answer(null), [], 'no provider: the theme paints them');
  h.d.dispose();
  for (const served of [FORMAT_DEFAULT, null]) {
    const off = await editor(FORMAT, served, 'local a =');
    assert.deepEqual(off.live.get(off.d.pool.placeholder) ?? [], [], served ? 'default settings' : 'no server');
    off.d.dispose();
  }
});
