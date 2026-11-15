'use strict';
// C, C++, Java, Kotlin and Groovy: data identities with no server and on each server's tokens,
// function scopes, band-1 receivers, danger marks, and the build files read as static
// content. Rules: docs/c-jvm.md.
//   constructs.c.cpptools.json   ms-vscode.cpptools 1.35.6 in VS Code 1.144.1 (theme e2e harness, --dump)
//   constructs.cpp.clangd.json   clangd 22.1.8 over stdio
//   Constructs.java.jdtls.json   jdtls from redhat.java 1.58.0 over stdio
//   constructs.kt.kls.json       kotlin-language-server 1.3.13 (Homebrew) over stdio
//   ctor.kt.kls.json             the same
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');
const focus = require('../out/focus');
const { lexicalRisk } = require('../out/risk');

const FIX = path.join(__dirname, 'fixtures/cjvm');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const json = (f) => JSON.parse(read(f));

async function harness(text, languageId, { tokens, uri } = {}) {
  stub.clearLspResponses();
  if (tokens) {
    const served = stub.encodeTokens(text, tokens);
    stub.setLspResponses({ 'vscode.provideDocumentSemanticTokensLegend': served.legend, 'vscode.provideDocumentSemanticTokens': { data: served.data } });
  }
  stub.setLspResponses({ 'vscode.executeDocumentSymbolProvider': [] });
  const doc = new stub.TextDocument(text, languageId, uri ?? `file:///cjvm-${Math.random()}`);
  const ed = new stub.TextEditor(doc, 0, 0);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  d.classifier.confirmSchedule = [];
  d.engaged.add(doc.uri.toString());
  const show = (type) => (live.get(type) ?? []).map((r) => `${r.start.line + 1}:${doc.lineAt(r.start.line).text.slice(r.start.character, r.end.character)}`).sort();
  const lines = text.split('\n');
  return {
    d, show, doc,
    async at(needle, tok, phase = Phase.Focus) {
      const line = lines.findIndex((l) => l.includes(needle));
      assert.ok(line >= 0, needle);
      const ch = lines[line].indexOf(tok, lines[line].indexOf(needle));
      ed.selection = new vs.Selection(line, ch, line, ch);
      d.machine.phase = phase;
      await d.runClassify(doc);
      d.render();
      return {
        tints: [...d.pool.id, ...d.pool.idg].flatMap((t) => show(t)),
        escape: show(d.pool.riskEscape),
        danger: show(d.pool.riskDanger),
        self: show(d.pool.self),
        constants: show(d.pool.constantRestore),
        placeholders: show(d.pool.placeholder),
      };
    },
  };
}

const names = (paint) => [...new Set(paint.map((p) => p.split(':')[1]))].sort();
const lines = (paint, name) => paint.filter((p) => p.endsWith(`:${name}`)).map((p) => +p.split(':')[0]);

test('C heuristic: a macro body, a typedef and a struct member are not data', async () => {
  const h = await harness(read('constructs.c'), 'c');
  assert.deepEqual((await h.at('    t tmp_ = (x);', 'tmp_')).tints, []);
  const top = await h.at('static int counter = 0;', 'counter');
  assert.deepEqual(names(top.tints), ['counter', 'debug_level', 'names']);
  const loop = await h.at('    total += p->x + p->y;', 'total');
  assert.ok(!names(loop.tints).includes('x'), 'the member x of struct point is not data');
  h.d.dispose();
});

test('C on cpptools: lexical declarations stand in for the modifier cpptools never sends', async () => {
  const text = read('constructs.c');
  const h = await harness(text, 'c', { tokens: json('constructs.c.cpptools.json').tokens });
  const loop = await h.at('    total += p->x + p->y;', 'total', Phase.Edit);
  assert.deepEqual(loop.escape, ['50:total', '52:counter'], 'only the writes to names declared outside the loop');
  assert.ok(lines(loop.tints, 'i').every((l) => l >= 45 && l <= 57), 'i stays in sum_points, not fill');
  const main = await h.at('  fill(pts, MAX_ITEMS);', 'pts', Phase.Edit);
  assert.deepEqual(main.escape, [], 'a declaration with an initializer is no write');
  h.d.dispose();
});

// cpptools rejects a waiting request as cancelled when another for the file arrives
// (docs/c-jvm.md#server-shapes); `cancels` rejections first, then the tokens.
function cancellingServer(text, tokens, cancels, onAsk = () => {}) {
  const served = stub.encodeTokens(text, tokens);
  const asked = { tokens: 0 };
  stub.setLspHandler((cmd) => {
    if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return served.legend;
    if (cmd === 'vscode.executeDocumentSymbolProvider') return [];
    if (cmd !== 'vscode.provideDocumentSemanticTokens') return undefined;
    asked.tokens++;
    onAsk(asked.tokens);
    if (asked.tokens <= cancels) return Promise.reject(Object.assign(new Error('Canceled'), { name: 'Canceled' }));
    return { data: served.data };
  });
  return asked;
}

test('cpptools: a request rejected as cancelled is asked again; its answer paints with no hold and no cold retry', async () => {
  const text = read('constructs.c');
  const tokens = json('constructs.c.cpptools.json').tokens;
  const want = await harness(text, 'c', { tokens });
  const expected = await want.at('    total += p->x + p->y;', 'total', Phase.Edit);
  want.d.dispose();
  const h = await harness(text, 'c');
  h.d.classifier.cancelRetrySchedule = [5, 5, 5];
  const asked = cancellingServer(text, tokens, 2);
  const got = await h.at('    total += p->x + p->y;', 'total', Phase.Edit);
  assert.equal(asked.tokens, 3, 'two cancels, then the answer');
  assert.deepEqual(got.tints, expected.tints, 'the tokens\' plan, not the heuristic one');
  assert.ok(got.tints.length > 0);
  assert.deepEqual(got.escape, ['50:total', '52:counter'], 'the escape marks need the tokens the retry got');
  assert.equal(h.d.classifier.coldRetryDelay(h.doc), null, 'an answer with tokens: no cold retry');
  assert.ok([...h.d.classCache.values()].every((e) => !e.hold && e.semantic === 'ok'));
  h.d.dispose();
});

test('cpptools: a version\'s first answer may miss later IntelliSense batches; the one that confirms it paints', async () => {
  const text = read('constructs.c');
  const tokens = json('constructs.c.cpptools.json').tokens;
  const want = await harness(text, 'c', { tokens });
  const expected = await want.at('    total += p->x + p->y;', 'total');
  want.d.dispose();
  const first = stub.encodeTokens(text, tokens.filter((t) => t.type !== 'variable' && t.type !== 'parameter'));
  const full = stub.encodeTokens(text, tokens);
  const served = [];
  const h = await harness(text, 'c');
  stub.setLspHandler((cmd) => {
    if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return full.legend;
    if (cmd !== 'vscode.provideDocumentSemanticTokens') return [];
    served.push(served.length === 0 ? 'first' : 'full');
    const answer = served.length === 1 ? first : full;
    return { data: remap(answer, full.legend) };
  });
  h.d.classifier.confirmSchedule = [20, 20, 20];
  const cold = await h.at('    total += p->x + p->y;', 'total');
  assert.deepEqual(cold.tints, [], 'the first batch types no local');
  await new Promise((r) => setTimeout(r, 200));
  h.d.render();
  assert.deepEqual([...h.d.pool.id, ...h.d.pool.idg].flatMap((t) => h.show(t)), expected.tints, 'asked again, the full answer paints');
  assert.deepEqual(served, ['first', 'full', 'full'], 'asked until two answers for the version match');
  assert.equal(h.d.classifier.coldRetryDelay(h.doc), null, 'settled: no more requests');
  h.d.dispose();
});

test('cpptools: a settled answer that changes for the same version, as after a reopen, is confirmed again', async () => {
  const text = read('constructs.c');
  const tokens = json('constructs.c.cpptools.json').tokens;
  const full = stub.encodeTokens(text, tokens);
  const part = stub.encodeTokens(text, tokens.filter((t) => t.type !== 'variable'));
  let answer = full;
  const h = await harness(text, 'c');
  stub.setLspHandler((cmd) => {
    if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return full.legend;
    if (cmd !== 'vscode.provideDocumentSemanticTokens') return [];
    return { data: remap(answer, full.legend) };
  });
  h.d.classifier.confirmSchedule = [20, 30, 40];
  await h.at('    total += p->x + p->y;', 'total');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.d.classifier.coldRetryDelay(h.doc), null, 'two matching answers: settled');
  answer = part;
  h.d.classifier.invalidate(h.doc);
  h.d.dropPlansFor(h.doc);
  await h.at('    total += p->x + p->y;', 'total');
  assert.equal(h.d.classifier.coldRetryDelay(h.doc), 20, 'the changed answer is provisional, its waits from the start');
  answer = full;
  await new Promise((r) => setTimeout(r, 150));
  h.d.render();
  assert.ok([...h.d.pool.id, ...h.d.pool.idg].flatMap((t) => h.show(t)).some((p) => p.endsWith(':total')), 'the full answer paints again');
  h.d.dispose();
});

// The legend of `full`, with `answer`'s type and modifier indexes moved onto it.
function remap(answer, legend) {
  const data = [...answer.data];
  for (let i = 0; i < data.length; i += 5) {
    data[i + 3] = legend.tokenTypes.indexOf(answer.legend.tokenTypes[data[i + 3]]);
    let bits = 0;
    answer.legend.tokenModifiers.forEach((m, b) => { if (data[i + 4] & (1 << b)) bits |= 1 << legend.tokenModifiers.indexOf(m); });
    data[i + 4] = bits;
  }
  return data;
}

test('cpptools: still cancelled after the waits, the answer reads as empty and band 2 holds', async () => {
  const text = read('constructs.c');
  const h = await harness(text, 'c');
  h.d.classifier.cancelRetrySchedule = [5, 5];
  h.d.classifier.retrySchedule = [60000];
  const asked = cancellingServer(text, json('constructs.c.cpptools.json').tokens, Infinity);
  const got = await h.at('    total += p->x + p->y;', 'total');
  assert.equal(asked.tokens, 3, 'the first request and one per wait');
  assert.deepEqual(got.tints, []);
  assert.ok([...h.d.classCache.values()].some((e) => e.hold && e.semantic === 'empty'));
  h.d.dispose();
});

test('cpptools: a cancelled request for a version the document left is not asked again', async () => {
  const text = read('constructs.c');
  const h = await harness(text, 'c');
  h.d.classifier.cancelRetrySchedule = [5, 5, 5];
  const asked = cancellingServer(text, json('constructs.c.cpptools.json').tokens, Infinity, (n) => {
    if (n === 1) h.doc.applyEdit(0, 0, ' ');
  });
  await h.at('    total += p->x + p->y;', 'total');
  assert.equal(asked.tokens, 1);
  h.d.dispose();
});

test('C: `self` is a name and band 1 paints no receiver; C++ paints `this`', async () => {
  const c = await harness('int f(struct obj *self, int n) {\n  return self->n + n;\n}\n', 'c');
  const r = await c.at('  return self->n + n;', 'self');
  assert.deepEqual(r.self, []);
  assert.deepEqual(names(r.tints), ['n', 'self']);
  c.d.dispose();
  const cpp = await harness(read('constructs.cpp'), 'cpp');
  const m = await cpp.at('    area_ += by;', 'by');
  assert.deepEqual(m.self, ['34:this']);
  cpp.d.dispose();
});

test('band 1: C-family NULL, true and false paint constant red and bool keyword grey, with or without a server, but the name a #define or #undef defines', async () => {
  const text = '#include <stdbool.h>\n#define CHECK(p) ((p) == NULL)\n#define NULL ((void*)0)\n#undef true\n#if defined(bool) || defined NULL\n#endif\nstatic bool on = false;\nint f(int *p) {\n  return p == NULL ? false : true;\n}\n';
  const macros = [];
  for (const m of text.matchAll(/\b(?:NULL|true|false|bool)\b/g)) macros.push({ offset: m.index, length: m[0].length, type: 'macro', modifiers: [] });
  for (const [label, tokens] of [['no server', undefined], ['cpptools', macros]]) {
    for (const lang of ['c', 'cpp']) {
      const h = await harness(text, lang, { tokens });
      for (const phase of [Phase.Survey, Phase.Focus]) {
        const r = await h.at('  return p == NULL', 'p', phase);
        assert.deepEqual(r.constants, ['2:NULL', '5:NULL', '7:false', '9:NULL', '9:false', '9:true'], `${lang}, ${label}, phase ${phase}`);
        assert.deepEqual(r.self.filter((x) => x.endsWith(':bool')), ['7:bool'], `${lang}, ${label}: \`defined(bool)\` keeps the call`);
      }
      h.d.dispose();
    }
  }
  const java = await harness('class A { boolean f(Object o) { return o == null || true; } }\n', 'java');
  const j = await java.at('return o', 'o');
  assert.deepEqual(j.constants, [], 'Java\'s literals are the grammar\'s, no server repaints them');
  java.d.dispose();
});

test('band 1: the constant restore is the theme\'s builtin red at normal weight, in both themes', () => {
  const { buildDecorationPool, TOKENS } = require('../out/tokens');
  assert.deepEqual([TOKENS.constant.dark, TOKENS.constant.light], ['#f2716c', '#be222d'], 'the theme constant colours');
  for (const dark of [true, false]) {
    const { options } = buildDecorationPool(dark).constantRestore;
    assert.deepEqual([options.color, options.fontWeight], [dark ? '#f2716c' : '#be222d', 'normal']);
  }
});

test('band 1: a Kotlin `$name` template is a placeholder, `$` and name, with or without kotlin-language-server; `${…}` and an escaped `\\$` are not', async () => {
  const text = read('constructs.kt');
  const want = ['104:$item', '108:$LIMIT', '34:$amount', '76:$age', '76:$name', '98:$id'];
  for (const tokens of [undefined, json('constructs.kt.kls.json').tokens]) {
    const h = await harness(text, 'kotlin', { tokens });
    const r = await h.at('        balance += amount', 'amount', Phase.Survey);
    assert.deepEqual(r.placeholders, want, tokens ? 'kls' : 'no server');
    h.d.dispose();
  }
  const h = await harness('val a = "\\$x and ${y} and $z"\nval b = """$w"""\n', 'kotlin');
  const r = await h.at('val a', 'a', Phase.Survey);
  assert.deepEqual(r.placeholders, ['1:$z', '2:$w']);
  h.d.dispose();
});

test('memberTest reads a block\'s header only when an offset in it is asked about; a new lex reuses each unchanged header\'s verdict', () => {
  const { lex } = require('../out/lex');
  const { memberTest, isTypeHeader } = require('../out/cjvm');
  const tag = `Cost${process.hrtime.bigint()}`;
  const make = (rename) => Array.from({ length: 50 }, (_, i) => `class ${tag}${i} {\n  int ${rename && i === 40 ? 'g' : 'f'}${i}() {\n    int x${i} = ${i};\n    return x${i};\n  }\n}\n`).join('');
  let calls = 0;
  const judge = (h, f) => { calls++; return isTypeHeader(h, f); };
  const ask = (src, needle) => {
    const lx = lex(src, 'java');
    return memberTest(lx, focus.scanBlocks(src, 'java'), judge)(src.indexOf(needle));
  };
  const src = make(false);
  assert.equal(ask(src, 'int x10'), false, 'a method body');
  assert.equal(calls, 1, 'one header read: the innermost block\'s');
  assert.equal(ask(src, 'int f10'), true, 'a class body');
  assert.equal(calls, 2);
  const edited = src.replace('int x40 = 40', 'int x40 = 400');
  assert.equal(ask(edited, 'int x10'), false);
  assert.equal(ask(edited, 'int x40'), false);
  assert.equal(calls, 3, 'after the edit only the header never read before is read: f40\'s');
  assert.equal(ask(make(true), 'int x40'), false);
  assert.equal(calls, 4, 'a changed header is read again');
  for (const [src, needle, want] of [
    ['@A(";") class B /* ; { */ {\n  int n;\n}\n', 'int n', true],
    ['void f(int[] a /* ) */, String s) {\n  int n;\n}\n', 'int n', false],
    [`class C ${' '.repeat(700)}{\n  int n;\n}\n`, 'int n', false],
    ['class D extends E<F> {\n  void g() { new Runnable() {\n    int n;\n  }; }\n}\n', 'int n', true],
  ]) assert.equal(ask(src, needle), want, src.slice(0, 40));
});

test('C++ heuristic: template parameters and members are not data; a const method has parameters', async () => {
  const h = await harness('template <typename T, int N>\nstruct Buf {\n  T data[N];\n  int used = 0;\n  int room(int extra) const {\n    int left = N - used + extra;\n    return left;\n  }\n};\n', 'cpp');
  const r = await h.at('    int left = N - used + extra;', 'left');
  assert.deepEqual(names(r.tints), ['extra', 'left']);
  h.d.dispose();
});

test('C++: a method wrapped onto a `const noexcept {` line is a function, its parameters are data and the field is not, with or without clangd', async () => {
  const text = read('constructs.cpp');
  for (const tokens of [undefined, json('constructs.cpp.clangd.json').tokens]) {
    const h = await harness(text, 'cpp', { tokens });
    const r = await h.at('    return area_ * k + bias;', 'k');
    assert.deepEqual(r.tints.sort(), ['36:k', '37:bias', '38:bias', '38:k'], tokens ? 'clangd' : 'no server');
    assert.deepEqual(lines((await h.at('    area_ += by;', 'by')).tints, 'by'), [32, 33]);
    h.d.dispose();
  }
});

test('C++ heuristic: every name of a structured binding is declared, as clangd declares it', async () => {
  const h = await harness('int tally(const Table& table) {\n  int total = 0;\n  for (const auto& [key, count] : table) {\n    total += count + key.size();\n  }\n  auto [lo, hi] = bounds(table);\n  return total + lo + hi;\n}\n', 'cpp');
  assert.deepEqual(names((await h.at('    total += count + key.size();', 'count')).tints), ['count', 'key', 'table', 'total']);
  const top = names((await h.at('  return total + lo + hi;', 'lo')).tints);
  assert.ok(top.includes('lo') && top.includes('hi'), top.join(' '));
  h.d.dispose();
});

test('C++ heuristic: a range-for over `const auto&` declares its variable', async () => {
  const h = await harness('int fold(const std::vector<int>& xs, int seed) {\n  int acc = seed;\n  for (const auto& x : xs) {\n    acc = acc + x;\n  }\n  auto* p = &acc;\n  return *p;\n}\n', 'cpp');
  assert.deepEqual(names((await h.at('    acc = acc + x;', 'acc')).tints), ['acc', 'x', 'xs']);
  assert.ok(names((await h.at('  return *p;', 'p')).tints).includes('p'));
  h.d.dispose();
});

test('Kotlin and Groovy heuristic: a parenthesised for-in declares its variable, a Kotlin destructuring one each name', async () => {
  const kt = await harness('fun scan(users: List<User>, lookup: Map<String, Int>): Int {\n    var sum = 0\n    for (user in users) {\n        for ((key, value) in lookup) {\n            sum += value + key.length + user.age\n        }\n    }\n    return sum\n}\n', 'kotlin');
  assert.deepEqual(names((await kt.at('            sum += value', 'value')).tints), ['key', 'lookup', 'sum', 'user', 'value']);
  kt.d.dispose();
  const gv = await harness('class A {\n    int f(int n) {\n        int t = 0\n        for (idx in 0..<n) {\n            t += idx\n        }\n        return t\n    }\n}\n', 'groovy');
  assert.deepEqual(names((await gv.at('            t += idx', 'idx')).tints), ['idx', 'n', 't']);
  gv.d.dispose();
});

test('C and C++ heuristic: a function returning a struct pointer and a `template <class T>` function have locals; a struct body has members', async () => {
  const text = '#include <stddef.h>\nstruct node { int v; struct node *next; };\nstatic struct node *find(struct node *head, int v) {\n  struct node *p = head;\n  while (p && p->v != v) p = p->next;\n  return p;\n}\n';
  const h = await harness(text, 'c');
  assert.deepEqual(names((await h.at('  struct node *p = head;', 'p')).tints), ['head', 'p', 'v']);
  h.d.dispose();
  const cpp = await harness('template <class T>\nT biggest(const T* xs, int n) {\n  T best = xs[0];\n  for (int i = 1; i < n; ++i) best = xs[i] > best ? xs[i] : best;\n  return best;\n}\n', 'cpp');
  assert.deepEqual(names((await cpp.at('  T best = xs[0];', 'best')).tints), ['best', 'i', 'n', 'xs']);
  cpp.d.dispose();
});

test('danger: reinterpret_cast, const_cast and C-style pointer casts; value casts convert', () => {
  const cpp = read('constructs.cpp');
  const at = (t, lang) => lexicalRisk(t, { start: 0, end: t.length }, lang).danger.map((r) => t.slice(r.start, r.end));
  assert.deepEqual(at(cpp, 'cpp'), ['reinterpret_cast', 'const_cast']);
  const c = read('constructs.c');
  assert.deepEqual(at(c, 'c'), ['(const point_t *)', '(const point_t *)', '(void *)']);
  const java = read('Constructs.java');
  assert.deepEqual(at(java, 'java'), ['@SuppressWarnings', '(List<String>)', '(String)', '(List<?>)']);
  const kt = read('constructs.kt');
  assert.deepEqual(at(kt, 'kotlin'), ['as', 'as', 'as', '!!', '@Suppress', 'as']);
});

test('Java heuristic: fields are members; lambda, pattern and `throws` method parameters are data', async () => {
  const h = await harness(read('Constructs.java'), 'java');
  const cls = await h.at('    private int seen;', 'seen');
  assert.deepEqual(cls.tints, [], 'a field is a member, at every depth');
  const lambda = await h.at('        words.forEach(w -> out.merge', 'w');
  assert.ok(names(lambda.tints).includes('w'));
  const pattern = await h.at('            return String.format("point %d > %d", x, y);', 'x');
  assert.deepEqual(names(pattern.tints), ['o', 'x', 'y']);
  const str = await h.at('            return "string of %d chars".formatted(str.length());', 'str');
  assert.ok(names(str.tints).includes('str'));
  const thr = await harness('class A {\n  String read(String text)\n      throws IOException {\n    return text;\n  }\n}\n', 'java');
  assert.deepEqual(names((await thr.at('    return text;', 'text')).tints), ['text']);
  thr.d.dispose();
  h.d.dispose();
});

test('heuristic: a name after a Java, Groovy or Kotlin `->` is a read; after a C `->` a member', async () => {
  const java = await harness('class A {\n  int f(java.util.List<Integer> xs) {\n    int out = 0;\n    xs.forEach(w -> out.hashCode());\n    return xs.stream().filter(n -> n > out).count() > 0 ? out : 0;\n  }\n}\n', 'java');
  const j = await java.at('    int out = 0;', 'out');
  assert.equal(lines(j.tints, 'out').length, 4, 'every read of out, the one after `w ->` too');
  assert.deepEqual(lines(j.tints, 'n'), [5, 5], 'a lambda parameter read right after its arrow');
  java.d.dispose();
  const groovy = await harness('def f(int t) {\n  def add = { a, b -> a + b + t }\n  return add(t, t)\n}\n', 'groovy');
  assert.deepEqual(lines((await groovy.at('  return add(t, t)', 't')).tints, 't'), [1, 2, 3, 3]);
  groovy.d.dispose();
  const c = await harness('struct p { int x; };\nint g(struct p *q) {\n  int x = q->x;\n  return x + q->x;\n}\n', 'c');
  assert.deepEqual(lines((await c.at('  int x = q->x;', 'x')).tints, 'x'), [3, 4], 'q->x is the member, not the local');
  c.d.dispose();
});

test('Java on jdtls: a field read bare between commas is no shorthand read', async () => {
  const text = 'class A {\n  int size;\n  int f(int a) {\n    return g(a, size, a);\n  }\n}\n';
  const tokens = [
    { offset: text.indexOf('size;'), length: 4, type: 'property', modifiers: ['declaration'] },
    { offset: text.indexOf('a) {'), length: 1, type: 'parameter', modifiers: ['declaration'] },
    { offset: text.indexOf('a, size'), length: 1, type: 'parameter', modifiers: [] },
    { offset: text.indexOf('size, a'), length: 4, type: 'property', modifiers: [] },
    { offset: text.lastIndexOf('a);'), length: 1, type: 'parameter', modifiers: [] },
  ];
  const h = await harness(text, 'java', { tokens });
  assert.deepEqual(names((await h.at('    return g(a, size, a);', 'a')).tints), ['a']);
  h.d.dispose();
});

// The captures keep the servers' order; VS Code hands the deltas over in a Uint32Array.
function wire(text, toks) {
  const types = [...new Set(toks.map((t) => t.type))];
  const mods = [...new Set(toks.flatMap((t) => t.modifiers))];
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const lineOf = (o) => { let l = 0; while (l + 1 < starts.length && starts[l + 1] <= o) l++; return l; };
  const data = [];
  let pl = 0;
  let pc = 0;
  for (const t of toks) {
    const l = lineOf(t.offset);
    const c = t.offset - starts[l];
    data.push(l - pl, l === pl ? c - pc : c, t.length, types.indexOf(t.type), t.modifiers.reduce((b, m) => b | (1 << mods.indexOf(m)), 0));
    pl = l;
    pc = c;
  }
  return { legend: { tokenTypes: types, tokenModifiers: mods }, data: new Uint32Array(data) };
}

test('jdtls and kls send some tokens before the one ahead of them; the decoder keeps every token, in order', async () => {
  const { decodeSemanticTokens } = require('../out/classify');
  for (const [src, cap, needle, tok, want] of [
    ['Constructs.java', 'Constructs.java.jdtls.json', '        if (o instanceof Point(int x, int y) && x > y) {', 'o', { x: 3, y: 3 }],
    ['constructs.kt', 'constructs.kt.kls.json', 'fun String.shout(times: Int = 1)', 'times', { times: 2 }],
  ]) {
    const text = read(src);
    const captured = json(cap).tokens;
    assert.ok(captured.some((t, i) => i > 0 && t.offset < captured[i - 1].offset), `${cap} holds a token behind the one before it`);
    const served = wire(text, captured);
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const decoded = decodeSemanticTokens(served.data, served.legend.tokenTypes, served.legend.tokenModifiers, starts, text);
    assert.deepEqual(decoded.map((t) => t.offset), captured.map((t) => t.offset).sort((a, b) => a - b), `${cap}: every token at its offset`);
    const h = await harness(text, src.endsWith('.kt') ? 'kotlin' : 'java');
    stub.setLspResponses({ 'vscode.provideDocumentSemanticTokensLegend': served.legend, 'vscode.provideDocumentSemanticTokens': { data: served.data } });
    const { tints } = await h.at(needle, tok);
    for (const [name, n] of Object.entries(want)) assert.equal(lines(tints, name).length, n, `${src}: ${name} at each occurrence`);
    h.d.dispose();
  }
});

test('Kotlin on kls: a template adds no `$name` identity, a local val is declared, a constructor val is a member', async () => {
  const text = read('constructs.kt');
  const h = await harness(text, 'kotlin', { tokens: json('constructs.kt.kls.json').tokens });
  const dep = await h.at('        balance += amount', 'amount', Phase.Edit);
  assert.ok(!dep.tints.some((p) => p.includes('$')), dep.tints.join(' '));
  assert.deepEqual(names(dep.tints), ['amount']);
  const scan = await h.at('            total += value', 'value', Phase.Edit);
  assert.ok(!scan.escape.includes('56:total'), 'the declaration of total is no write');
  const ctor = await h.at('        balance = owner.length', 'owner');
  assert.ok(!names(ctor.tints).includes('owner'), 'owner is the class\'s property');
  h.d.dispose();
});

test('Kotlin: an expression body is a function scope; constructor parameters are data, constructor and top-level vals are properties, on both paths', async () => {
  const text = read('ctor.kt');
  const kls = json('ctor.kt.kls.json').tokens;
  for (const tokens of [undefined, kls]) {
    const path = tokens ? 'kls' : 'no server';
    const h = await harness(text, 'kotlin', { tokens });
    const at = async (needle, tok) => (await h.at(needle, tok)).tints.sort();
    assert.deepEqual(await at('        println(x + top)', 'x'), ['6:x', '7:x', '9:x'], path);
    assert.deepEqual(await at('        return q + w', 'q'), ['16:q', '18:q'], path);
    assert.deepEqual(await at('    val k = x + top', 'k'), ['27:x', '28:k', '28:x', '29:k'], path);
    assert.deepEqual(lines((await h.at('    fun f(x: Int) = x * y', 'x * y')).tints, 'x'), [11, 11], path);
    h.d.dispose();
  }
});

test('Kotlin heuristic: lambda parameters and locals, no class properties', async () => {
  const h = await harness(read('constructs.kt'), 'kotlin');
  assert.deepEqual(names((await h.at('        total += u.age', 'u')).tints), ['total', 'u', 'users'], 'the top-level LIMIT is a property, as kls types it');
  assert.deepEqual((await h.at('        balance = owner.length', 'owner')).tints, []);
  h.d.dispose();
});

test('Groovy heuristic: `def` locals, closure parameters and GString holes are data; fields and `def` methods are not', async () => {
  const h = await harness(read('Constructs.groovy'), 'groovy');
  assert.deepEqual(names((await h.at('        stock[name] = ', 'name')).tints), ['count', 'name'], 'touched is a field');
  const report = await h.at('        def lines = ', 'lines');
  assert.deepEqual(names(report.tints), ['dollar', 'header', 'lines', 'multi', 'pattern']);
  assert.ok(lines(report.tints, 'header').includes(29), 'the $header hole in a dollar-slashy string is a read');
  const each = await h.at('    total += count', 'count');
  assert.deepEqual(names(each.tints), ['count', 'inv', 'name', 'total']);
  assert.ok(!names(each.tints).includes('add'), '`def add(` names a method');
  h.d.dispose();
});

test('static content: CMake, Gradle build scripts in either DSL', () => {
  assert.equal(focus.isNonFlowLanguage('cmake'), true);
  assert.equal(focus.effectiveLanguageId('groovy', '/w/build.gradle'), 'gradle');
  assert.equal(focus.effectiveLanguageId('kotlin', '/w/app/build.gradle.kts'), 'gradle-kts');
  assert.equal(focus.effectiveLanguageId('kotlin', '/w/src/Main.kt'), 'kotlin');
  assert.equal(focus.effectiveLanguageId('groovy', '/w/Jenkinsfile'), 'groovy');
  for (const id of ['gradle', 'gradle-kts', 'gradle-kotlin-dsl', 'cmake', 'makefile', 'dts', 'xml']) assert.equal(focus.isNonFlowLanguage(id), true, id);
  assert.equal(focus.effectiveLanguageId('gradle-kotlin-dsl', '/w/build.gradle.kts'), 'gradle-kotlin-dsl', 'redhat.java\'s own id for a .gradle.kts file');
  assert.equal(focus.band1LanguageId('gradle-kts'), 'kotlin');
  assert.equal(focus.band1LanguageId('gradle'), 'groovy');
});
