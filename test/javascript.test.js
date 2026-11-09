'use strict';
// JavaScript: the lexer against TypeScript's own parser, the heuristic's declarations,
// the semantic path on tsserver and Deno token captures, escape marks, band-1 restores
// and focus. Rules: docs/javascript.md.
//   edges.js.tokens.json, ns.js.tokens.json  tsserver   node test/gen-ts-semtok.js --types <@types dir> <file>
//   edges.js.deno.json, ns.js.deno.json      deno lsp   node test/gen-deno-semtok.js <file>
// (docs/javascript.md#regenerating-the-token-fixtures)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const stub = require('./vscode-stub');
const vs = stub.install();
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');
const { lex } = require('../out/lex');
const focus = require('../out/focus');
const { importUseSpans } = require('../out/imports');
const { jsPlaceholderSpans } = require('../out/placeholders');
const { typedNamespaceKey } = require('../out/classify-lsp');

const FIX = path.join(__dirname, 'fixtures/javascript');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const json = (f) => JSON.parse(read(f));

/** Each character's region by TypeScript's parser: 0 code, 1 comment, 2 string, regex or template text. */
function parserRegions(text) {
  const sf = ts.createSourceFile('x.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const reg = new Uint8Array(text.length);
  const mark = (a, b, v) => reg.fill(v, a, b);
  const seen = new Set();
  const comments = (pos) => {
    if (seen.has(pos)) return;
    seen.add(pos);
    ts.forEachLeadingCommentRange(text, pos, (a, b) => mark(a, b, 1));
    ts.forEachTrailingCommentRange(text, pos, (a, b) => mark(a, b, 1));
  };
  const sh = ts.getShebang(text);
  if (sh) mark(0, sh.length, 1);
  const S = ts.SyntaxKind;
  const LITERALS = new Set([S.StringLiteral, S.NoSubstitutionTemplateLiteral, S.TemplateHead, S.TemplateMiddle,
    S.TemplateTail, S.RegularExpressionLiteral, S.JsxText]);
  const visit = (node) => {
    if (node.kind >= S.FirstJSDocNode && node.kind <= S.LastJSDocNode) return;
    comments(node.pos);
    if (LITERALS.has(node.kind)) {
      mark(node.getStart(sf), node.end, 2);
      return;
    }
    const kids = node.getChildren(sf);
    if (kids.length === 0) comments(node.end);
    kids.forEach(visit);
  };
  visit(sf);
  comments(sf.end);
  return reg;
}

test('lexer: regions match the TypeScript parser on edges.js but for the documented `if (x) /re/`', () => {
  const text = read('edges.js');
  const ref = parserRegions(text);
  const got = new Uint8Array(text.length);
  for (const s of lex(text, 'javascript').spans) got.fill(s.region === 'string' ? 2 : 1, s.start, s.end);
  const diffs = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]) || ref[i] === got[i]) continue;
    let j = i;
    while (j < text.length && ref[j] === ref[i] && got[j] === got[i]) j++;
    diffs.push(`${text.slice(0, i).split('\n').length}:${text.slice(i, j)}`);
    i = j;
  }
  assert.deepEqual(diffs, ['33:/re/']);
});

test('lexer: every regex-or-division position against the TypeScript parser; the forms that differ are the documented ones', () => {
  const diffs = (text) => {
    const ref = parserRegions(text);
    const got = new Uint8Array(text.length);
    for (const s of lex(text, 'javascript').spans) got.fill(s.region === 'string' ? 2 : 1, s.start, s.end);
    const out = [];
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i]) || ref[i] === got[i]) continue;
      let j = i;
      while (j < text.length && ref[j] === ref[i] && got[j] === got[i]) j++;
      out.push(text.slice(i, j));
      i = j;
    }
    return out;
  };
  const agree = [
    'x = a / b / c; y = (a) / 2; z = a[0] / b[1] / c;', 'const r = x => /re/g.test(x);', 'const t = `a${`b${c}`}d${ {a: 1}.a }e`;',
    "const t = `${ '}' }` + `${ \"`\" }` + /`/.source;", 'const o = { a: 1 } / 2;', 'function f() {} /re/.test(x);', 'let x = a\n/re/g.exec(b)',
    'x = y++ / 2; z = y-- / 3;', 'function f() { return /re/; }', 'a = typeof /re/; b = void /x/; c = delete /y/.z;', 'function* g() { yield /re/; }',
    'async function f() { x = await /re/; }', 'switch (k) { case /re/: break; default: a / 2; }', 'class B extends A { m() { x = this / 2; y = super.x / 2; } }',
    'a = b ? /c/ : /d/;', 'a = [/x/, /y/]; b = {k: /z/};', 'a = (b) => /c/;', 'a = b\n++c', 'const re = /[/]/; const re2 = /\\//; const re3 = /a[\\]/]b/;',
    'x = a.return / 2; y = a.typeof / b;', '`${a}${b}`.length / 2;', 'x = 1 /*c*/ / 2; y = a //c\n/ 3;', '<div>{x / 2}</div>; const y = 1 / 2;',
    'label: /re/.test(x);', 'x = a?.b / c; y = a?.[0] / 2;', 'for (const x of /re/g.exec(s)) {}', 'x = 10n / 2n; y = 1_000 / 2; z = .5 / 2;',
    'class A { static { this.x = /re/; } #m() { return /r/ / 1; } }', 'x = a ?? /re/; y ||= /z/;', 'if (/re/.test(x)) {}', '`x\n${ `y\n${z}` }\n`',
    'x = "a\\\\nb" / 2;', "x = '\\'' / 2; y = \"\\\"\" / 3;", 'html`<a href="${u}">${t}</a>` / 2;', 'export default /re/;', 'x = o.default / 2 / 1;',
    'y = function () {} / 2;', 'new.target / 2; import.meta.x / 2;', 'do /re/.test(s); while (0);', 'export default <App />;',
  ];
  for (const text of agree) assert.deepEqual(diffs(text), [], text);
  // docs/javascript.md § Known limits: a `/` after a header's `)` and after `of` used as a name.
  assert.deepEqual(diffs('if (a) /re/.test(b);'), ['/re/']);
  assert.deepEqual(diffs('while (x) /a/.exec(y);'), ['/a/']);
  assert.deepEqual(diffs('for (;;) /re/.test(s);'), ['/re/']);
  assert.deepEqual(diffs('with (o) /re/.test(s);'), ['/re/']);
  assert.deepEqual(diffs('x = in2 / 3; y = of / 2; z = let / 4;'), ['/ 2; z = let /']);
});

/** Band-2 ranges per focused caret, as `line:text`. */
async function harness(text, languageId, { tokens, symbols = [], uri } = {}) {
  stub.clearLspResponses();
  if (tokens) {
    const served = stub.encodeTokens(text, tokens);
    stub.setLspResponses({ 'vscode.provideDocumentSemanticTokensLegend': served.legend, 'vscode.provideDocumentSemanticTokens': { data: served.data } });
  }
  stub.setLspResponses({ 'vscode.executeDocumentSymbolProvider': symbols });
  const doc = new stub.TextDocument(text, languageId, uri ?? `file:///js-${Math.random()}.${languageId === 'javascript' ? 'js' : 'ts'}`);
  const ed = new stub.TextEditor(doc, 0, 0);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  d.engaged.add(doc.uri.toString());
  const show = (type) => (live.get(type) ?? []).map((r) => `${r.start.line + 1}:${doc.lineAt(r.start.line).text.slice(r.start.character, r.end.character)}`).sort();
  return {
    d, doc, ed, live, show,
    async at(needle, tok, phase = Phase.Focus) {
      const lines = text.split('\n');
      const line = lines.findIndex((l) => l.includes(needle));
      ed.selection = new vs.Selection(line, lines[line].indexOf(tok, lines[line].indexOf(needle)), line, lines[line].indexOf(tok, lines[line].indexOf(needle)));
      d.machine.phase = phase;
      await d.runClassify(doc);
      d.render();
      return [...d.pool.id, ...d.pool.idg].flatMap((t) => show(t)).sort();
    },
  };
}

const names = (paint) => [...new Set(paint.map((p) => p.split(':')[1]))].sort();

test('heuristic: bare and destructured arrow parameters are declarations', async () => {
  const h = await harness(read('heuristic.js'), 'javascript');
  assert.deepEqual(names(await h.at('for (const a of args)', 'out')), ['a', 'args', 'out']);
  assert.deepEqual(names(await h.at('return name + size', 'name')), ['first', 'name', 'second', 'size']);
  h.d.dispose();
});

test('heuristic: a function value, a require binding, an object key and a label are not data', async () => {
  const h = await harness(read('heuristic.js'), 'javascript');
  assert.deepEqual(names(await h.at('return fs.readFileSync', 'fs')), ['debug', 'p']);
  const build = await h.at('const opts = {', 'opts');
  assert.deepEqual(names(build), ['name', 'opts']);
  assert.equal(build.filter((p) => p === '18:name').length, 1, 'the key `name:` stays band 1, its value tints');
  h.d.dispose();
});

test('semantic: module, exports and process are library surface unless the file declares them', async () => {
  const text = read('edges.js');
  const h = await harness(text, 'javascript', { tokens: json('edges.js.tokens.json') });
  const top = await h.at('let a = 1', 'a', Phase.Edit);
  assert.ok(!top.some((p) => /:(module|exports)$/.test(p)), top.join(' '));
  assert.deepEqual(h.show(h.d.pool.riskEscape).filter((p) => /module|exports/.test(p)), []);
  h.d.dispose();
  const local = 'function f() {\n  const process = 1;\n  return process + process;\n}\n';
  const tok = [
    { offset: 23, length: 7, type: 'variable', modifiers: ['declaration', 'readonly', 'local'] },
    { offset: 46, length: 7, type: 'variable', modifiers: ['readonly', 'local'] },
    { offset: 56, length: 7, type: 'variable', modifiers: ['readonly', 'local'] },
  ];
  const h2 = await harness(local, 'javascript', { tokens: tok });
  assert.deepEqual(names(await h2.at('return process', 'process')), ['process']);
  h2.d.dispose();
});

test('escape: a UMD wrapper\'s `exports` parameter is declared, so its member writes mark', async () => {
  const text = '(function (exports) {\n  exports.x = 1;\n})(this);\n';
  const tok = [
    { offset: 11, length: 7, type: 'parameter', modifiers: ['declaration'] },
    { offset: 24, length: 7, type: 'parameter', modifiers: [] },
  ];
  const h = await harness(text, 'javascript', { tokens: tok });
  await h.at('exports.x', 'x', Phase.Edit);
  assert.deepEqual(h.show(h.d.pool.riskEscape), ['2:exports.x']);
  h.d.dispose();
});

test('semantic: `self` is a plain name in JavaScript; only `this` gets the self restore', async () => {
  const text = read('ns.js');
  for (const capture of ['ns.js.tokens.json', 'ns.js.deno.json']) {
    const h = await harness(text, 'javascript', { tokens: json(capture) });
    assert.ok(names(await h.at('const a = util', 'a')).includes('self'), capture);
    assert.deepEqual(h.show(h.d.pool.self), ['6:this'], capture);
    h.d.dispose();
  }
});

test('import restore: `import * as` uses tsserver leaves untyped, with and without a server', async () => {
  const text = read('ns.js');
  const lx = lex(text, 'javascript');
  assert.deepEqual(importUseSpans(lx).map((s) => `${lx.lineOf(s.start) + 1}:${text.slice(s.start, s.end)}`), ['7:util', '8:path', '11:util']);
  const none = await harness(text, 'javascript');
  none.d.render();
  assert.deepEqual(none.show(none.d.pool.importRestore), ['11:util', '7:util', '8:path']);
  none.d.dispose();
  // tsserver types `path` (an ambient module) `namespace` and sends nothing for `util` (a project file).
  const tsserver = await harness(text, 'javascript', { tokens: json('ns.js.tokens.json') });
  await tsserver.at('const a = util', 'a');
  assert.deepEqual(tsserver.show(tsserver.d.pool.importRestore), ['11:util', '7:util']);
  tsserver.d.dispose();
  // Deno types `path` `variable`: the server's token stands, and band 2 does not take it for data.
  const deno = await harness(text, 'javascript', { tokens: json('ns.js.deno.json') });
  const tints = await deno.at('const b = path', 'b');
  assert.deepEqual(deno.show(deno.d.pool.importRestore), ['11:util', '7:util']);
  assert.ok(!tints.some((p) => /:(path|util|process)$/.test(p)), tints.join(' '));
  deno.d.dispose();
});

test('import restore: an answer types a namespace when any of its uses has a token', () => {
  const text = "import * as a from './a.js';\nimport * as b from './b.js';\nconst v = 1;\na.x(b.y, a.z);\n";
  const lx = lex(text, 'javascript');
  const at = (needle, from = 0) => text.indexOf(needle, from);
  const v = { offset: at('v'), length: 1, type: 'variable', modifiers: ['declaration'] };
  const ns = (off) => ({ offset: off, length: 1, type: 'namespace', modifiers: [] });
  assert.equal(typedNamespaceKey(lx, []), '');
  assert.equal(typedNamespaceKey(lx, [v]), '', 'every use after the last token');
  assert.equal(typedNamespaceKey(lx, [v, ns(at('a.z'))]), 'a');
  assert.equal(typedNamespaceKey(lx, [ns(at('a.x')), ns(at('b.y'))]), 'a,b');
  assert.equal(typedNamespaceKey(lx, [{ ...ns(at('a.x') + 1), length: 2 }]), '', 'a token must start at the use');
  assert.equal(typedNamespaceKey(lex('const a = 1;\n', 'javascript'), [v]), '');
});

test('import restore: a namespace name the file reuses as a bare word is left alone', () => {
  const text = "import * as cfg from './cfg.js';\nexport function f(cfg) {\n  return cfg.x;\n}\ncfg.y;\n";
  assert.deepEqual(importUseSpans(lex(text, 'javascript')), []);
  const text2 = "import * as m from './m.js';\nimport type * as T from './t.js';\nm.run(m?.x);\nconst v: T.Shape = m.y;\n";
  const lx = lex(text2, 'typescript');
  assert.deepEqual(importUseSpans(lx).map((s) => text2.slice(s.start, s.end) + '@' + (lx.lineOf(s.start) + 1)), ['m@3', 'm@3', 'T@4', 'm@4']);
});

test('import restore: which statements bind a namespace, and which uses keep it', () => {
  const spans = (text, lang = 'javascript') => {
    const lx = lex(text, lang);
    return importUseSpans(lx).map((s) => `${text.slice(s.start, s.end)}@${lx.lineOf(s.start) + 1}`);
  };
  const binds = [
    "import * as ns from 'm';\nns.a;\n",
    "import*as ns from'm';\nns.a;\n",
    "import /* a */ * /* b */ as /* c */ ns /* d */ from /* e */ 'm';\nns.a;\n",
    "import d, * as ns from 'm';\nns.a + d;\n",
    "import type, * as ns from 'm';\nns.a + type;\n",
  ];
  for (const text of binds) assert.deepEqual(spans(text), ['ns@2'], text);
  assert.deepEqual(spans("import type * as ns from 'm';\nlet v: ns.A;\n", 'typescript'), ['ns@2']);
  const none = [
    "import { ns } from 'm';\nns.a;\n",
    "import { a as ns } from 'm';\nns.a;\n",
    "import * as ns from m;\nns.a;\n",
    "import * as ns;\nns.a;\n",
    "import * ns from 'm';\nns.a;\n",
    "import * as ns, x from 'm';\nns.a;\n",
    "export * as ns from 'm';\nns.a;\n",
    "const ns = await import('m');\nns.a;\n",
    "x.import * as ns from 'm';\nns.a;\n",
    "import * as ns from 'a';\nimport * as ns from 'b';\nns.a;\n",
  ];
  for (const text of none) assert.deepEqual(spans(text), [], text);
  // A member on the next line or after a comment is still a use; a bare word anywhere drops the name.
  assert.deepEqual(spans("import * as ns from 'm';\nns\n  .a()\n  ?.b;\nns?.c;\nns /* x */ . d;\nobj.ns.e;\nobj?.ns;\n"), ['ns@2', 'ns@5', 'ns@6']);
  for (const tail of ['ns[k];', 'f(...ns);', 'ns?.[0];', 'x = ns ? .5 : 1;', 'ns', 'ns.']) {
    assert.deepEqual(spans(`import * as ns from 'm';\nns.a;\n${tail}`), [], tail);
  }
  assert.deepEqual(spans("import * as ns from 'm';\n// ns.a\nconst s = 'ns.a';\nns.b;\n"), ['ns@4']);
});

test('import restore: a JSX tag name in a `javascript` file is the React step\'s; a use in its attributes and a comparison are restored', () => {
  const spans = (text, lang) => {
    const lx = lex(text, lang);
    return importUseSpans(lx).map((s) => `${lx.lineOf(s.start) + 1}:${lx.text.slice(0, s.start).split('\n').pop().length}:${text.slice(s.start, s.end)}`);
  };
  const text = "import * as UI from './ui';\nexport const App = () => <UI.Button onClick={() => UI.track()}>UI.label text</UI.Button>;\nconst B = <UI.Icon.Large />;\nif (a < UI.max) UI.run();\n";
  assert.deepEqual(spans(text, 'javascript'), ['2:51:UI', '4:8:UI', '4:16:UI']);
  // TypeScript has no JSX: `<UI.T>x` is a type assertion, whose qualifier the grammar already paints slate.
  assert.deepEqual(spans("import * as UI from './ui';\nconst v = <UI.T>x;\nUI.run();\n", 'typescript'), ['2:11:UI', '3:0:UI']);
});

test('heuristic: which initializers make a binding a function or a module, not data', async () => {
  const cases = [
    ['async x => x', false], ['async (y) => y', false], ['async function () {}', false], ['function () {}', false],
    ['class {}', false], ['z => z', false], ['(a, b) => a', false], ["require('m')", false], ["require('m').a.b", false],
    ["require('m'), w = 1", false], ["await import('m')", false], ["await import('m').then", false],
    ['(u, 1)', true], ['u >= 1', true], ['u == 1', true], ['u', true], ['async', true], ['u.v', true],
    ["require('m')('x')", true], ['require(u)', true], ["require('m') + 1", true], ["require('m')[0]", true],
    ['await fetch(u)', true], ['await import(u)', true], ["await require('m')", true], ['require', true],
    ['(u) >> 1', true], ['(u) > 1', true],
  ];
  for (const [init, data] of cases) {
    for (const end of [';', '']) {
      const text = `function f(u) {\n  const v = ${init}${end}\n  return v + v + u;\n}\n`;
      const h = await harness(text, 'javascript');
      assert.equal(names(await h.at('return v', 'v')).includes('v'), data, `const v = ${init}${end}`);
      h.d.dispose();
    }
  }
  const text = "function f(u) {\n  const { sep } = require('path');\n  const { d } = u;\n  return sep + d + d + sep + u;\n}\n";
  const h = await harness(text, 'javascript');
  assert.deepEqual(names(await h.at('return sep', 'sep')), ['d', 'u']);
  h.d.dispose();
  const packed = "function f(u){const v=x=>x;const w=require('m');const d=u;return v(d)+w.a+d+u}\n";
  const p = await harness(packed, 'javascript');
  assert.deepEqual(names(await p.at('return v', 'd')), ['d', 'u'], 'no blanks around `=`');
  p.d.dispose();
});

test('heuristic: a destructured parameter declares its own names, not a shorthand in its default value', async () => {
  const text = 'let y = 1;\nconst g = (a = [1, { y }], { b }) => {\n  return a + b + y + y;\n};\n';
  const h = await harness(text, 'javascript');
  const paint = await h.at('return a', 'a');
  const plain = [...h.d.pool.id].flatMap((t) => h.show(t));
  assert.deepEqual(names(paint), ['a', 'b', 'y']);
  assert.deepEqual(plain.filter((p) => p.endsWith(':y')), [], 'every y is the top-level y, bold');
  h.d.dispose();
});

test('heuristic: keys, type members and class fields are not candidates; values and shorthands are', async () => {
  const text = [
    'function f(a: number, b: number) {',
    '  class C { m() {} a!: number; b?: number }',
    '  const t: { a: number; b: number } = { a, b: a };',
    '  outer: for (const x of [a]) { if (x) continue outer; }',
    '  return t.a + a + b + a + b;',
    '}',
    '',
  ].join('\n');
  const h = await harness(text, 'typescript');
  const paint = await h.at('return t', 't');
  assert.deepEqual(paint.filter((p) => /^[234]:/.test(p)).sort(), ['3:a', '3:a', '3:t', '4:a']);
  h.d.dispose();
});

test('escape: an ES5 constructor function is an initializer; a prototype method is not', async () => {
  const text = [
    'function Point(x) {',
    '  this.x = x;',
    '}',
    'Point.prototype.move = function (dx) {',
    '  this.x += dx;',
    '};',
    '',
  ].join('\n');
  const tok = [
    { offset: 9, length: 5, type: 'class', modifiers: ['declaration'] },
    { offset: 15, length: 1, type: 'parameter', modifiers: ['declaration'] },
    { offset: 32, length: 1, type: 'parameter', modifiers: [] },
    { offset: 37, length: 5, type: 'class', modifiers: [] },
    { offset: 53, length: 4, type: 'method', modifiers: ['declaration'] },
    { offset: 70, length: 2, type: 'parameter', modifiers: ['declaration'] },
    { offset: 88, length: 2, type: 'parameter', modifiers: [] },
  ];
  const h = await harness(text, 'javascript', { tokens: tok });
  await h.at('this.x = x', 'x', Phase.Edit);
  assert.deepEqual(h.show(h.d.pool.riskEscape), []);
  await h.at('this.x += dx', 'dx', Phase.Edit);
  assert.deepEqual(h.show(h.d.pool.riskEscape), ['5:this.x']);
  h.d.dispose();
  const expr = 'const Point = function (x) {\n  this.x = x;\n};\nconst move = function (dx) {\n  this.x += dx;\n};\n';
  const tok2 = [
    { offset: 6, length: 5, type: 'class', modifiers: ['declaration', 'readonly'] },
    { offset: 24, length: 1, type: 'parameter', modifiers: ['declaration'] },
    { offset: 40, length: 1, type: 'parameter', modifiers: [] },
    { offset: 52, length: 4, type: 'function', modifiers: ['declaration', 'readonly'] },
    { offset: 69, length: 2, type: 'parameter', modifiers: ['declaration'] },
    { offset: 87, length: 2, type: 'parameter', modifiers: [] },
  ];
  const e = await harness(expr, 'javascript', { tokens: tok2 });
  await e.at('this.x = x', 'x', Phase.Edit);
  assert.deepEqual(e.show(e.d.pool.riskEscape), [], 'a capitalised function expression');
  await e.at('this.x += dx', 'dx', Phase.Edit);
  assert.deepEqual(e.show(e.d.pool.riskEscape), ['5:this.x'], 'a lower-case one');
  e.d.dispose();
});

test('focus: a caret in a destructuring pattern focuses the scope that owns its names', async () => {
  const text = 'function f(opts) {\n  const { name, size } = opts;\n  return name + size + name + size;\n}\n';
  const h = await harness(text, 'javascript');
  assert.deepEqual(names(await h.at('const { name', 'name')), ['name', 'opts', 'size']);
  h.d.dispose();
});

test('focus: a caret in a destructured parameter focuses its function', async () => {
  const text = 'export function load({ name, size = 1 }, rest) {\n  return name + size + rest + name;\n}\nf({ a: 1 });\n';
  const h = await harness(text, 'javascript');
  assert.deepEqual(names(await h.at('load({ name', 'name')), ['name', 'rest', 'size']);
  assert.equal(focus.isParamPattern(text, focus.scanBlocks(text, 'javascript').find((b) => text[b.openOffset - 1] === '('), 'javascript'), true);
  assert.equal(focus.isParamPattern(text, focus.scanBlocks(text, 'javascript').find((b) => text.slice(b.openOffset - 2, b.openOffset) === 'f('), 'javascript'), false);
  h.d.dispose();
});

test('placeholders: every closed `${` and `}`, nested holes included, in band 1', async () => {
  const text = 'const t = `a${x}b${`in ${y + `deep ${z}`}`}c`;\nconst open = `x${y\n';
  assert.deepEqual(jsPlaceholderSpans(text).map((s) => `${s.start}:${text.slice(s.start, s.end)}`).sort((a, b) => parseInt(a) - parseInt(b)),
    ['12:${', '15:}', '17:${', '23:${', '35:${', '38:}', '40:}', '42:}']);
  const h = await harness('/** @param {string} [name] the (file) */\n// see f(x)\nconst s = `${1}`;\n', 'javascript');
  for (const phase of [Phase.Survey, Phase.Focus]) {
    h.d.machine.phase = phase;
    h.d.render();
    assert.deepEqual(h.show(h.d.pool.placeholder), ['3:${', '3:}'], phase);
    assert.deepEqual(h.show(h.d.pool.commentRestore), ['1:(', '1:)', '1:[', '1:]', '1:{', '1:}'], phase);
  }
  h.d.dispose();
  // TypeScript leaves `${` out of its colorized pairs, so only the JSDoc brackets need it.
  const t = await harness('/** @param {Config} cfg [name] */\nconst s = `${1}`;\n', 'typescript');
  t.d.render();
  assert.deepEqual(t.show(t.d.pool.placeholder), []);
  assert.deepEqual(t.show(t.d.pool.commentRestore), ['1:[', '1:]', '1:{', '1:}']);
  t.d.dispose();
});

test('focus: a caret in a one-line function\'s parameters focuses that function', async () => {
  const text = 'function outer(start) {\n  const self = start;\n  self.step = (n) => { self.count += n + n; };\n  return self + start;\n}\n';
  const h = await harness(text, 'javascript');
  assert.deepEqual(names(await h.at('self.step = (n)', 'n')), ['n', 'self']);
  assert.deepEqual(names(await h.at('self.step = (n)', 'step')), ['self', 'start']);
  h.d.dispose();
});

test('focus: which braces are a destructured parameter, and where a one-line arrow holds the caret', async () => {
  const pattern = (text, lang = 'javascript') => {
    const brace = text.indexOf('{ a }');
    return focus.isParamPattern(text, focus.scanBlocks(text, lang).find((b) => b.openOffset === brace), lang);
  };
  for (const text of ['function f({ a }) {}', 'function f(x, { a }) {}', 'const g = ({ a }) => a;', 'const g = ({ a })  =>  a;',
    'const g = ([x], { a }) => a;', 'const g = (y = (1), { a }) => a;', 'class C { m(x, { a }) {} }']) {
    assert.equal(pattern(text), true, text);
  }
  assert.equal(pattern('function f({ a }: T) {}', 'typescript'), true);
  for (const text of ['f({ a });', 'f(x, { a });', 'x = f({ a }) === 1;', 'x = f({ a }) == 1;', 'f(x = { a }) => 1;', 'f({ a }']) {
    assert.equal(pattern(text), false, text);
  }
  assert.equal(pattern('function f({ a }) {}', 'rust'), false, 'JavaScript and TypeScript only');
  const text = 'function outer(o) {\n  o.step = (n) => { o.c += n + n; };\n  return o;\n}\n';
  const h = await harness(text, 'javascript');
  const line = text.split('\n')[1];
  // From the caret touching the parameter list's first character to the caret before the `}`.
  for (const [col, want] of [[line.indexOf('(n)') - 1, ['o']], [line.indexOf('(n)'), ['n', 'o']], [line.lastIndexOf('}'), ['n', 'o']], [line.lastIndexOf('}') + 1, ['o']]]) {
    h.ed.selection = new vs.Selection(1, col, 1, col);
    h.d.machine.phase = Phase.Focus;
    await h.d.runClassify(h.doc);
    h.d.render();
    assert.deepEqual(names([...h.d.pool.id, ...h.d.pool.idg].flatMap((t) => h.show(t))), want, `column ${col}`);
  }
  h.d.dispose();
});

test('focus: other languages keep their one-line and pattern containment', async () => {
  const cases = [
    // The pattern brace itself, which paints nothing.
    ['rust', 'fn f(p: P) {\n    let P { x, y } = p;\n    x + y + x + y\n}\n', 'let P { x', 'x', []],
    // The enclosing function, which leaves the closure's own names untinted.
    ['rust', 'fn f(a: i32) {\n    let g = |x| { x + 1 };\n    g(a) + a\n}\n', '|x|', 'x', ['a']],
    ['ruby', 'def f(xs)\n  ys = xs.map { |l| l * 2 }\n  ys + xs\nend\n', '|l|', 'l', ['xs', 'ys']],
    ['go', 'func f(a int) int {\n\tg := func(x int) int { return x + x }\n\treturn g(a) + a\n}\n', 'func(x', 'x', ['a']],
  ];
  for (const [lang, text, needle, tok, want] of cases) {
    const h = await harness(text, lang, { uri: `file:///other-${Math.random()}` });
    assert.deepEqual(names(await h.at(needle, tok)), want, `${lang} ${needle}`);
    h.d.dispose();
  }
});

test('a TypeScript declaration file keeps band 1 and gets no Focus', async () => {
  const text = [
    "import * as ns from './ns';",
    '/** @param {string} [name] */',
    'export declare function f(this: Window, name?: ns.Name): void;',
    'declare global {',
    '  interface Window { f(this: Window, n: number): void; }',
    '}',
    '',
  ].join('\n');
  const h = await harness(text, 'typescript', { uri: 'file:///p/types/index.d.ts' });
  const lines = text.split('\n');
  for (const phase of [Phase.Survey, Phase.Focus]) {
    h.d.machine.phase = phase;
    h.d.render();
    assert.deepEqual(h.show(h.d.pool.self), ['3:this', '5:this'], phase);
    assert.deepEqual(h.show(h.d.pool.commentRestore), ['2:[', '2:]', '2:{', '2:}'], phase);
    assert.deepEqual(h.show(h.d.pool.importRestore), [], 'the namespace restore waits on an answer a declaration file never asks for');
  }
  for (const [line, col] of [[2, 35], [4, 25]]) {
    h.ed.selection = new vs.Selection(line, col, line, col);
    await h.d.runClassify(h.doc);
    h.d.render();
    assert.deepEqual([...h.d.pool.id, ...h.d.pool.idg].flatMap((t) => h.show(t)), [], lines[line]);
  }
  h.d.dispose();
});

test('the React ids keep their behaviour: no template, JSDoc or namespace restore yet', async () => {
  const text = "import * as React from 'react';\n/** @param {string} [name] */\nconst s = `${React.version}`;\n";
  for (const lang of ['javascriptreact', 'typescriptreact']) {
    const h = await harness(text, lang, { uri: `file:///r-${Math.random()}.${lang === 'javascriptreact' ? 'jsx' : 'tsx'}` });
    h.d.render();
    for (const pool of ['placeholder', 'commentRestore', 'importRestore']) assert.deepEqual(h.show(h.d.pool[pool]), [], `${lang} ${pool}`);
    h.d.dispose();
  }
});

test('a TypeScript declaration file is static content', () => {
  for (const f of ['/p/index.d.ts', '/p/lib.es2022.d.ts', '/p/a.d.mts', '/p/a.d.cts', '/p/styles.d.css.ts']) {
    const id = focus.effectiveLanguageId('typescript', f);
    assert.equal(focus.isNonFlowLanguage(id), true, f);
    assert.deepEqual(focus.scanBlocks('declare module "x" {\n  export function f(a: string): void;\n}\n', id), [], f);
  }
  assert.equal(focus.effectiveLanguageId('typescript', '/p/d.ts'), 'typescript');
  assert.equal(focus.effectiveLanguageId('javascript', '/p/a.d.js'), 'javascript');
  assert.equal(focus.effectiveLanguageId('plaintext', '/p/a.d.ts'), 'plaintext');
  assert.equal(focus.effectiveLanguageId('html', '/p/a.erb'), 'html');
});

test('a jsconfig.json and a deno.json(c) are static content', () => {
  for (const id of ['jsonc', 'json']) assert.equal(focus.isNonFlowLanguage(id), true, id);
});
