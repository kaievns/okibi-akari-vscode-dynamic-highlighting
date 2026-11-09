'use strict';
// Band-1 shadow restore (src/imports.ts shadowUseSpans) and the resolver changes it
// brought to the import restore. Rules and measurements: docs/shadow-restore.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const stub = require('./vscode-stub');
const vs = stub.install();
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');
const { lex } = require('../out/lex');
const { importUseSpans, shadowUseSpans } = require('../out/imports');
const { buildDecorationPool } = require('../out/tokens');
const { growth } = require('./cpu-time');

const FIX = path.join(__dirname, 'fixtures/imports');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const spans = (fn) => (text, lang = 'python') => {
  const lx = lex(text, lang);
  return fn(lx).map((s) => `${lx.lineOf(s.start) + 1}:${text.slice(s.start, s.end)}`);
};
const shadows = spans(shadowUseSpans);
const imports = spans(importUseSpans);

test('the reported screenshot: every id the parameter binds, the argument of .add(id) included', () => {
  assert.deepEqual(shadows(read('shadow-shot.py')), ['2:id', '4:id', '6:id', '7:id', '8:id', '9:id']);
});

test('calls, keyword labels, attributes and unshadowed builtins keep the grammar colour', () => {
  const text = [
    'def f(id, obj):',
    '    g(id=id, type=obj.type)',
    '    return id(1), id, obj.id, len(obj), isinstance(obj, str), type',
  ].join('\n');
  assert.deepEqual(shadows(text), ['1:id', '2:id', '3:id']);
});

test('a module-level rebinding: the call stays, the value and the target are data', () => {
  const text = [
    'import sys',
    'input = sys.stdin.readline',
    'x = input',
    'n = int(input())',
    'def main():',
    '    return input(), input',
  ].join('\n');
  assert.deepEqual(shadows(text), ['2:input', '3:input', '6:input']);
});

test('module level: a use above every binding is the builtin, unless a loop carries the binding back', () => {
  const text = [
    'from functools import partial',
    'print = partial(print, flush=True)',
    'out = print',
    'for x in range(3):',
    '    z = max',
    '    max = x',
    'w = min',
    'min = 0',
    'while iter is not None:',
    '    iter = None',
    'for c in hash:',
    '    hash = c',
    'for c in "ab": n = sum; sum = 1',
    'list: list = []',
  ].join('\n');
  // 9: a `while` condition runs again after its body; 11: a `for` iterable runs once, before it.
  assert.deepEqual(shadows(text), ['2:print', '3:print', '5:max', '6:max', '8:min', '9:iter', '10:iter', '12:hash', '13:sum', '13:sum', '14:list']);
});

test('in a function every use resolves to the local, above its binding too', () => {
  const text = [
    'def f(xs):',
    '    y = id',
    '    id = xs',
    '    if xs:',
    '        return type',
    '    type = xs[0]',
    '    list: list = []',
    '    return y, id, type',
  ].join('\n');
  assert.deepEqual(shadows(text), ['2:id', '3:id', '5:type', '6:type', '7:list', '7:list', '8:id', '8:type']);
});

test('class level: an unreached class binding hands the use to the module, an unreached function binding to nothing', () => {
  const text = [
    'class A:',
    '    x = type',
    '    type = 1',
    '    y = type',
    'class B:',
    '    z = input',
    'input = 1',
    'class C:',
    '    w = input',
    'def g():',
    '    class D:',
    '        v = len',
    '    len = 3',
    '    return len',
  ].join('\n');
  assert.deepEqual(shadows(text), ['3:type', '4:type', '7:input', '9:input', '13:len', '14:len']);
});

test('comprehension targets and lambda parameters shadow only inside their own scope', () => {
  const text = [
    'def f(ids):',
    '    a = [id for id in ids]',
    '    b = [0 for type in type]',
    '    g = lambda dir, repr=repr: (dir, repr)',
    '    return a, b, g, id, type, dir, repr',
  ].join('\n');
  assert.deepEqual(shadows(text), ['2:id', '2:id', '3:type', '4:dir', '4:repr', '4:dir', '4:repr']);
});

test('class bodies: a field shadows in the body, not in methods or the body\'s comprehensions', () => {
  const text = [
    'class Order:',
    '    id: int = 0',
    '    type = "limit"',
    '    copy = type',
    '    ids = [id for _ in range(3)]',
    '    def show(self, hash):',
    '        return id, type, hash',
  ].join('\n');
  assert.deepEqual(shadows(text), ['2:id', '3:type', '4:type', '6:hash', '7:hash']);
});

test('nested functions see an enclosing binding; a sibling does not', () => {
  const text = [
    'def outer(filter):',
    '    def inner():',
    '        return filter',
    '    return inner',
    'def sibling():',
    '    return filter',
  ].join('\n');
  assert.deepEqual(shadows(text), ['1:filter', '3:filter']);
});

test('global binds the module name; nonlocal stays in its function chain', () => {
  const text = [
    'def setup():',
    '    global open',
    '    open = None',
    'def outer():',
    '    zip = 1',
    '    def inner():',
    '        nonlocal zip',
    '        zip += 1',
    '        return zip',
    '    return inner',
    'def user():',
    '    return open, zip',
    'handle = open',
  ].join('\n');
  assert.deepEqual(shadows(text), ['2:open', '3:open', '5:zip', '7:zip', '8:zip', '9:zip', '12:open', '13:open']);
});

test('every other binding form: for, with, except, walrus, augmented, annotated, starred, del, match', () => {
  const text = [
    'def forms(seq, cmd):',
    '    for len, (max, min) in enumerate(seq):',
    '        pass',
    '    with ctx() as hash:',
    '        pass',
    '    try:',
    '        pass',
    '    except OSError as iter:',
    '        pass',
    '    if (any := seq):',
    '        pass',
    '    sum = 0',
    '    sum += 1',
    '    list: list = []',
    '    [*all, next] = seq',
    '    match cmd:',
    '        case [round, *oct]:',
    '            pass',
    '        case {"k": ord, **bin}:',
    '            pass',
    '        case Point(x=hex) as chr:',
    '            pass',
    '    return len, max, min, hash, iter, any, sum, list, all, next, round, oct, ord, bin, hex, chr',
  ].join('\n');
  const names = 'len max min hash iter any sum list all next round oct ord bin hex chr'.split(' ');
  assert.deepEqual(shadows(text).filter((s) => s.startsWith('23:')), names.map((n) => `23:${n}`));
  assert.ok(!shadows(text).includes('21:Point'));
  assert.deepEqual(shadows(text).filter((s) => s.startsWith('14:')), ['14:list', '14:list'], 'in a function the annotation is the local');
});

test('a for target after a dot or inside a subscript binds nothing', () => {
  const text = [
    'class Walker:',
    '    def run(self, xs, d):',
    '        for self.type in xs:',
    '            pass',
    '        for d[id] in xs:',
    '            pass',
    '        for (a, *list), [b] in xs:',
    '            pass',
    '        return type, id, list',
  ].join('\n');
  assert.deepEqual(shadows(text), ['7:list', '9:list']);
});

test('a leading starred target, with-as tuples, long for targets, PEP 695 parameters, a multi-line return annotation', () => {
  const text = [
    'def solve(read):',
    '    *all, next = read()',
    '    with open(f) as fh, ctx() as (id, [map]):',
    '        pass',
    '    for a, b, c, d, e, f, g, h, i, j, k, l, m, hash in read():',
    '        pass',
    '    return all, next, id, map, hash',
    'def first[T](items: list[T], len: int) -> T:',
    '    return items[len]',
    'def g(list) -> (',
    '    list',
    '):',
    '    return list',
  ].join('\n');
  assert.deepEqual(shadows(text), [
    '2:all', '2:next', '3:id', '3:map', '5:hash', '7:all', '7:next', '7:id', '7:map', '7:hash',
    '8:len', '9:len', '10:list', '13:list',
  ]);
});

test('an unclosed bracket (mid-edit) does not pull the rest of the file into its scope', () => {
  const text = [
    'def a(id):',
    '    return id',
    'def b(type',
    '    return id, type',
    'def d():',
    '    return type, id',
    's = [x for x in id',
    'def e(len):',
    '    return len',
  ].join('\n');
  assert.deepEqual(shadows(text), ['1:id', '2:id', '8:len', '9:len']);
});

test('binding edges: chained, continued, bracketed, one-line suites and loops', () => {
  assert.deepEqual(shadows('a = id = 1\nid\n'), ['1:id', '2:id'], 'a chained target binds');
  assert.deepEqual(imports('import os\na = os = 1\nos'), [], 'and rebinds an import');
  assert.deepEqual(imports('import os\nos = \\\n    os.path\nos'), ['3:os'], 'a continued right-hand side still reads the import');
  assert.deepEqual(shadows('id = [\n    id,\n]\nid'), ['1:id', '4:id'], 'the binding holds after the closing bracket');
  assert.deepEqual(shadows('id = {\n    "k": id,\n}\nid'), ['1:id', '4:id']);
  assert.deepEqual(shadows('if x:type = 1\ntype\n'), ['1:type', '2:type'], 'an inline suite starts a statement');
  assert.deepEqual(shadows('print(id)\nwhile x: print(id); id = 2\n'), ['2:id', '2:id'], 'a one-line loop carries its binding');
  assert.deepEqual(shadows('for k in id: k\nid = 1\n'), ['2:id'], 'a one-line for iterable runs before the loop');
  assert.deepEqual(shadows('*id, b = 1, 2\nid\n'), ['1:id', '2:id']);
  assert.deepEqual(shadows('a, *id = 1, 2\nid\n'), ['1:id', '2:id']);
});

test('binding edges: subscripts, calls and attributes in a target bind nothing', () => {
  for (const src of ['f(x)[0] = id\nid\n', '(a,\n b) = id, 2\nid\n', 'id[0] = 1\nid\n', 'for len[0] in x: pass\nlen\n', 'x.id = 1\nid\n']) {
    assert.deepEqual(shadows(src), [], JSON.stringify(src));
  }
});

test('binding edges: a comparison is not an augmented assignment', () => {
  assert.deepEqual(shadows('x = 1\nid <= 2\nid >= 3\nid < 4\nid == 5\nid\n'), []);
  assert.deepEqual(shadows('id <<= 1\nid >>= 1\nid //= 2\nid **= 2\nid @= m\nid -= 1\nid\n'),
    ['1:id', '2:id', '3:id', '4:id', '5:id', '6:id', '7:id']);
});

test('binding edges: comprehensions, lambdas, match captures, class type parameters and ImportError fallbacks', () => {
  assert.deepEqual(imports('import os\nx = [os for y in ys if y for os in y]\nos.path'), ['3:os'], 'the second for binds os');
  assert.deepEqual(imports('import os\nf = lambda a=1, os=None: os.path\nos.sep'), ['3:os'], 'a parameter after a default');
  assert.deepEqual(shadows('f = lambda a=1, len=None: len\n'), ['1:len', '1:len']);
  assert.deepEqual(shadows('def f(v):\n    match v:\n        case id:\n            return id\n'), ['3:id', '4:id']);
  assert.deepEqual(imports('import os\nclass Box[T]:\n    x: os.PathLike\n'), ['3:os'], 'the header skips [T]');
  assert.deepEqual(imports('try:\n    import yaml\n\n# c\nexcept ImportError:\n    yaml = None\nyaml.x'), ['7:yaml']);
  assert.deepEqual(imports('try:\n    import yaml\nexcept ImportError:\n    # c\n\n    yaml = None\nyaml.x'), ['7:yaml']);
});

test('binding edges: half-typed brackets and loops, strings that hold code characters', () => {
  assert.deepEqual(shadows('xs = [1, 2\ndef e(len):\n    return len\n'), ['2:len', '3:len'], 'an unclosed [');
  assert.deepEqual(shadows('x = a[0](\ndef e(len):\n    return len\n'), ['2:len', '3:len'], 'a closed [ before an unclosed (');
  assert.deepEqual(shadows('print(a[0]\nid = 1\nid\n'), ['2:id', '3:id'], 'an unclosed call whose argument indexes');
  assert.deepEqual(shadows('x = [id for y]\nid = 1\n'), ['1:id', '2:id'], 'a comprehension with no `in` yet, above a binding');
  assert.ok(imports('import os\nx = [os for os]\nos').includes('3:os'), 'a comprehension with no `in` yet');
  assert.deepEqual(shadows('for id'), [], 'a `for` with no `in` yet');
  assert.deepEqual(shadows('id = "("\nid\n'), ['1:id', '2:id'], 'a bracket in a string does not continue the statement');
  assert.deepEqual(shadows('x = """\nwhile y:\n    """; print(id); id = 1\n'), ['3:id'], 'a line inside a string is not a loop header');
});

test('flow at module level: comprehensions, lambdas and loop conditions', () => {
  assert.deepEqual(shadows('x = [id for y in z]\nid = 1\n'), ['1:id', '2:id'], 'a comprehension resolves without the flow rule');
  assert.deepEqual(shadows('f = lambda: id\nid = 1\n'), ['1:id', '2:id']);
  assert.deepEqual(imports('import os\nx = [[os for os in a] for os in b]\nos'), ['3:os'], 'nested comprehensions');
  assert.deepEqual(shadows('while id:\n    pass\nid = 1\n'), ['3:id'], 'a binding after the loop does not reach its condition');
  assert.deepEqual(shadows('for k in [id]: id = k\n'), ['1:id'], 'a one-line for iterable runs before its body');
});

test('the pass stays linear in a long module-level block of uses above a binding', () => {
  const block = (n) => ['if __name__ == "__main__":', ...Array.from({ length: n }, (_, k) => `    a${k} = type`), '    type = 1'].join('\n');
  assert.equal(shadowUseSpans(lex(block(16000), 'python')).length, 1);
  const ratio = growth((n) => lex(block(n), 'python'), (lx) => shadowUseSpans(lx), 2000);
  assert.ok(ratio < 24, `8x the lines cost ${ratio.toFixed(1)}x (a walk per use costs 64x)`);
});

test('def and class names and imports are not data: the grammar and the import restore keep them', () => {
  const text = [
    'import os as id',
    'from mylib import type',
    'def input():',
    '    return 1',
    'class list:',
    '    pass',
    'x = (id, type, input, list)',
  ].join('\n');
  assert.deepEqual(shadows(text), []);
  assert.deepEqual(imports(text), ['7:id']);
});

test('defaults and annotations in a def header run in the enclosing scope', () => {
  const text = [
    'def defaults(len=len, *, str: str = str):',
    '    return len, str',
  ].join('\n');
  assert.deepEqual(shadows(text), ['1:len', '1:str', '2:len', '2:str'], 'the parameters are data, the defaults the builtins');
});

test('decorator lines keep the decorator colour', () => {
  const text = [
    'class A:',
    '    property = None',
    '    @property',
    '    def x(self):',
    '        return property',
  ].join('\n');
  assert.deepEqual(shadows(text), ['2:property']);
});

test('go: the grammar scopes builtin functions only at call sites; the shadow restore paints nothing in Go', () => {
  const text = 'package p\n\nfunc f(len int) int {\n\tmin := 3\n\treturn len + min\n}\n';
  assert.deepEqual(shadowUseSpans(lex(text, 'go')), []);
});

// The import restore shares the resolver; each change to it is pinned here.
test('import restore: a def header default or annotation resolves past a parameter of the same name', () => {
  const text = [
    'from . import box',
    'def table(box: box.Box = box.HEAVY):',
    '    return box',
  ].join('\n');
  assert.deepEqual(imports(text), ['2:box', '2:box']);
});

test('import restore: at module and class level a use before the rebinding is still the import; in a function it is the local', () => {
  const text = [
    'import json, _thread',
    'get_ident = _thread.get_ident',
    'del _thread',
    'def f(xs):',
    '    dump = json.dumps',
    '    json = xs',
    '    return dump, json',
    'class K:',
    '    enc = json.dumps',
    '    json = None',
  ].join('\n');
  assert.deepEqual(imports(text), ['2:_thread', '9:json']);
});

test('import restore: a scope that imports and rebinds a name claims it only while the import came first', () => {
  const text = [
    'import os',
    'def f(msg):',
    '    try:',
    '        import linecache',
    '        line = linecache.getline(msg)',
    '    except Exception:',
    '        linecache = None',
    '    return linecache',
    'def g():',
    '    json = None',
    '    import json',
    '    return json',
    'from xml.dom.NodeFilter import NodeFilter',
    'class F:',
    '    show = NodeFilter.SHOW_ALL',
    'del NodeFilter',
    'def h():',
    '    return os.sep',
    'os = None',
  ].join('\n');
  // 18: from a nested function the module's mixed name is left alone (docs/import-restore.md#not-covered).
  assert.deepEqual(imports(text), ['5:linecache', '15:NodeFilter']);
});

test('import restore: nonlocal does not shadow the module, a match capture does shadow its function', () => {
  const text = [
    'import os, re',
    'def outer():',
    '    os = 1',
    '    def inner():',
    '        nonlocal os',
    '        os = 2',
    '    return inner',
    'def f(x):',
    '    match x:',
    '        case re:',
    '            return re',
    'sep = os.sep',
    'pat = re.compile',
  ].join('\n');
  assert.deepEqual(imports(text), ['12:os', '13:re']);
});

test('import restore: a class-body comprehension skips the class scope', () => {
  const text = [
    'import os',
    'class A:',
    '    os = None',
    '    seps = [os.sep for _ in range(2)]',
    '    here = os',
  ].join('\n');
  assert.deepEqual(imports(text), ['4:os']);
});

let seq = 0;
async function harness(text, languageId, { lsp, line = 3, character = 8 } = {}) {
  stub.clearLspResponses();
  if (lsp) stub.setLspResponses(lsp);
  const doc = new stub.TextDocument(text, languageId, `file:///shadows-${seq++}.${languageId}`);
  const ed = new stub.TextEditor(doc, line, character);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  d.engaged.add(doc.uri.toString());
  d.render();
  const atOpen = (live.get(d.pool.shadowRestore) ?? []).length;
  await d.runClassify(doc);
  const text2 = (r) => `${r.start.line + 1}:${doc.lineAt(r.start.line).text.slice(r.start.character, r.end.character)}`;
  return {
    d, doc, live, atOpen,
    restore: () => (live.get(d.pool.shadowRestore) ?? []).map(text2),
    band2: () => [...d.pool.id, ...d.pool.idg].flatMap((t) => live.get(t) ?? []).map(text2).sort(),
    paint(phase) {
      d.machine.phase = phase;
      d.render();
      return live;
    },
  };
}

test('band 1: the same ranges in every phase with no provider', async () => {
  const h = await harness(read('shadow-shot.py'), 'python');
  const counts = [Phase.Survey, Phase.Focus, Phase.Edit, Phase.Survey].map((p) => (h.paint(p).get(h.d.pool.shadowRestore) ?? []).length);
  assert.deepEqual(counts, [6, 6, 6, 6]);
  assert.equal(h.atOpen, 6, 'first paint');
  assert.ok(!h.d.pool.banded().includes(h.d.pool.shadowRestore) && h.d.pool.all().includes(h.d.pool.shadowRestore));
  h.d.dispose();
});

test('the page colour at normal weight, in both themes', () => {
  for (const [isDark, color] of [[true, '#e1e3e5'], [false, '#13110e']]) {
    const { options } = buildDecorationPool(isDark).shadowRestore;
    assert.equal(options.color, color);
    assert.equal(options.fontWeight, 'normal');
  }
});

test('comes off once the server answers with tokens, like the import restore', async () => {
  const text = read('shadow-shot.py');
  const { legend, data } = stub.encodeTokens(text, [{ offset: text.indexOf('id:'), length: 2, type: 'parameter', modifiers: [] }]);
  const h = await harness(text, 'python', {
    lsp: {
      'vscode.provideDocumentSemanticTokensLegend': legend,
      'vscode.provideDocumentSemanticTokens': { data },
      'vscode.executeDocumentSymbolProvider': [],
    },
  });
  assert.equal(h.atOpen, 6, 'first paint, before the server answers');
  h.paint(Phase.Survey);
  assert.deepEqual(h.restore(), []);
  h.d.dispose();
});

test('an edit keeps the painted ranges until typing pauses, then recomputes both restores once', async () => {
  const h = await harness(read('shadow-shot.py'), 'python');
  h.paint(Phase.Edit);
  assert.equal(h.restore().length, 6);
  const sends = new Map();
  const set = h.live.set.bind(h.live);
  h.live.set = (type, ranges) => {
    sends.set(type, (sends.get(type) ?? 0) + 1);
    return set(type, ranges);
  };
  for (const piece of ['\n        x = id', '\n        y = sys']) {
    h.d.onEdit(h.doc.applyEdit(h.doc.getText().length, h.doc.getText().length, piece));
    h.d.render();
  }
  assert.equal(sends.get(h.d.pool.shadowRestore) ?? 0, 0, 'nothing re-sent while typing');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sends.get(h.d.pool.shadowRestore), 1);
  assert.deepEqual(h.restore().slice(-1), ['12:id']);
  h.d.dispose();
});

test('band 2 still wins in Focus: it tints the same ids and is created first', async () => {
  const h = await harness(read('shadow-shot.py'), 'python');
  h.paint(Phase.Focus);
  const tinted = h.band2().filter((s) => s.endsWith(':id'));
  assert.ok(tinted.length > 0 && tinted.every((s) => h.restore().includes(s)), tinted.join(' '));
  assert.ok([...h.d.pool.id, ...h.d.pool.idg].every((t) => t.id < h.d.pool.shadowRestore.id));
  h.d.dispose();
});

test('the import and shadow restores never paint the same range', async () => {
  const text = [
    'import os as id',
    'import sys',
    'input = sys.stdin.readline',
    'def f(type):',
    '    return id.sep, type, input, sys.argv',
  ].join('\n');
  const h = await harness(text, 'python', { line: 4, character: 4 });
  h.paint(Phase.Survey);
  const imp = (h.live.get(h.d.pool.importRestore) ?? []).map((r) => `${r.start.line}:${r.start.character}`);
  const sh = (h.live.get(h.d.pool.shadowRestore) ?? []).map((r) => `${r.start.line}:${r.start.character}`);
  assert.equal(imp.length, 3);
  assert.equal(sh.length, 4);
  assert.ok(sh.every((k) => !imp.includes(k)));
  h.d.dispose();
});

test('other languages get no shadow restore', async () => {
  for (const [text, lang] of [
    ['package p\n\nfunc f(len int) int {\n\treturn len\n}\n', 'go'],
    ['function f(name) { return name; }\n', 'typescript'],
  ]) {
    const h = await harness(text, lang, { line: 3, character: 1 });
    assert.equal((h.paint(Phase.Survey).get(h.d.pool.shadowRestore) ?? []).length, 0, lang);
    h.d.dispose();
  }
});
