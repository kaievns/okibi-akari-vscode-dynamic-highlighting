'use strict';
// Band-1 import restore (src/imports.ts) and the band-2 import exclusion it feeds.
// Rules and measurements: docs/import-restore.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const stub = require('./vscode-stub');
const vs = stub.install();
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');
const { lex } = require('../out/lex');
const { importUseSpans, pyImportOffsets, goAssumedName } = require('../out/imports');
const { PY_STDLIB, PY_STDLIB_TOP } = require('../out/pystdlib');
const { buildDecorationPool } = require('../out/tokens');
const { growth } = require('./cpu-time');

const FIX = path.join(__dirname, 'fixtures/imports');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const painted = (text, lang) => {
  const lx = lex(text, lang);
  return importUseSpans(lx).map((s) => `${lx.lineOf(s.start) + 1}:${text.slice(s.start, s.end)}`);
};

test('python: module and type uses, not shadows, labels, members, prose or calls', () => {
  assert.deepEqual(painted(read('neg.py'), 'python'), [
    '30:re', '34:re', '39:sqlite3', '46:shutil', '57:os', '57:re', '60:Opt', '60:deque', '60:Any',
    '61:deque', '62:deque', '62:OrderedDict', '63:ET', '64:email', '90:os', '90:OrderedDict', '91:yaml',
  ]);
});

test('python: the reported screenshot', () => {
  assert.deepEqual(painted(read('shot.py'), 'python'), ['7:deque', '13:deque', '15:heapq', '16:sys', '17:deque', '19:deque']);
});

test('python: decorators keep their own colour, their arguments are code', () => {
  const text = [
    'import functools',
    'import os',
    'from unittest import mock',
    '@functools.cache',
    '@functools.wraps(os.sep)',
    '@mock.patch.object(os, "sep")',
    'def f():',
    '    return functools',
  ].join('\n');
  assert.deepEqual(painted(text, 'python'), ['5:os', '6:os', '8:functools']);
});

test('python: every target of a tuple assignment shadows', () => {
  const text = [
    'import re, json, sys',
    'def f(x):',
    '    a, re, b = x',
    '    json, c = x',
    '    d, sys = x',
    '    return re, json, sys',
    'def g():',
    '    return re, json, sys',
  ].join('\n');
  assert.deepEqual(painted(text, 'python'), ['8:re', '8:json', '8:sys']);
});

test('python: comprehension targets and lambda parameters shadow only inside their own scope', () => {
  const text = [
    'import os, json, re',
    'f = lambda os=os: os.getcwd()',
    'g = [os for os in os.environ]',
    'h = [[json for json in r] for r in json.loads(x)]',
    'k = sorted(xs, key=lambda re: re.x), re.compile',
    'd = {"a": lambda os: os, "b": os.sep}',
    'm = [lambda json: json for _ in json.y]',
    'q = lambda a, *re, **json: (re, json); json.x',
    'r = {k: v async for k, re in z}; re.y',
    't = [json in s for json in json.y]',
    'def after():',
    '    return os.sep, json.x, re.y',
  ].join('\n');
  assert.deepEqual(painted(text, 'python'), [
    '2:os', '3:os', '4:json', '5:re', '6:os', '7:json', '8:json', '9:re', '10:json', '12:os', '12:json', '12:re',
  ]);
});

test('python: del unbinds a bare name, not an attribute or item', () => {
  const text = [
    'import sys, os, json',
    'def main():',
    '    del sys.argv[1]',
    '    del os.environ["x"], json',
    '    return sys.argv, os.sep, json.x',
    'def other():',
    '    del (sys), [os]  # gone',
    '    return sys.x, os.x, json.x',
  ].join('\n');
  assert.deepEqual(painted(text, 'python'), ['3:sys', '4:os', '5:sys', '5:os', '8:json']);
});

test('python: comprehension and lambda shadows stay linear', () => {
  const head = 'import os, json\n';
  for (const line of ['x = [json for json in json.y]', 'f = lambda os: os.x']) {
    const lexOf = (n) => lex(head + Array.from({ length: n }, () => line).join('\n'), 'python');
    assert.equal(importUseSpans(lexOf(30000)).length, line.startsWith('x') ? 30000 : 0);
    const ratio = growth(lexOf, (lx) => importUseSpans(lx), 2000);
    assert.ok(ratio < 24, `${line}: 8x the lines cost ${ratio.toFixed(1)}x (a scan per use costs 64x)`);
  }
});

test('python: the stdlib table decides lowercase names, the shape rule the rest', () => {
  const text = [
    'from collections import deque, OrderedDict',
    'from os import path, getcwd',
    'from typing import AnyStr, Optional, TYPE_CHECKING, IO',
    'from turtle import Screen',
    'from . import sibling, __version__',
    'from .pkg import helper, Model',
    'from thirdparty import Widget, make',
    'x = (deque, OrderedDict, path, getcwd, AnyStr, Optional, TYPE_CHECKING, IO, Screen,',
    '     sibling, __version__, helper, Model, Widget, make)',
  ].join('\n');
  assert.deepEqual(painted(text, 'python'), [
    '8:deque', '8:OrderedDict', '8:Optional', '8:IO', '9:sibling', '9:Model', '9:Widget',
  ]);
  assert.equal(PY_STDLIB.collections.deque, 'c');
  assert.equal(PY_STDLIB.os.path, 'v');
  assert.equal(PY_STDLIB.turtle.Screen, 'f');
  assert.equal(PY_STDLIB.xml.etree, 'm');
  assert.equal(PY_STDLIB['xml.etree.ElementTree'].SubElement, 'f');
  assert.equal(PY_STDLIB.typing.AnyStr, 't');
  assert.ok(PY_STDLIB_TOP.has('heapq') && !PY_STDLIB_TOP.has('numpy'));
});

test('python: band 2 sees every import statement name and every use bound to one', () => {
  const text = [
    'import ssl',
    'from json import loads as parse',
    'def f(ssl):',
    '    return ssl, parse',
    'def g():',
    '    return ssl',
  ].join('\n');
  const lx = lex(text, 'python');
  const name = (o) => lx.idents.find((i) => i.offset === o).name;
  const at = [...pyImportOffsets(lx)].sort((a, b) => a - b).map((o) => `${lx.lineOf(o) + 1}:${name(o)}`);
  assert.deepEqual(at, ['1:import', '1:ssl', '2:from', '2:json', '2:import', '2:loads', '2:as', '2:parse', '4:parse', '6:ssl']);
});

test('go: package qualifiers, not params, locals or keys', () => {
  assert.deepEqual(painted(read('neg.go'), 'go'), [
    '15:log', '20:fmt', '24:url', '25:fmt', '31:log', '36:fmt', '36:str', '36:yaml', '36:thing', '50:fmt', '57:fmt',
  ]);
  assert.equal(goAssumedName('gopkg.in/yaml.v3'), 'yaml');
  assert.equal(goAssumedName('example.com/go-thing/v2'), 'thing');
  assert.equal(goAssumedName('net/url'), 'url');
});

test('go: a parameter of a func-typed parameter ends the header scan', () => {
  const head = 'package mock\n\nimport (\n\t"context"\n\t"sync"\n)\n\ntype M struct {\n\tmu sync.Mutex\n}\n\n';
  const body = Array.from({ length: 2000 }, (_, i) =>
    `func (m *M) OnCall${i}(fn func(ctx context.Context) error) {\n\tm.mu.Lock()\n\tdefer m.mu.Unlock()\n\tm.call${i} = fn\n}\n`).join('\n');
  const text = head + body;
  const lx = lex(text, 'go');
  let calls = 0;
  const counted = new Proxy(lx, {
    get(target, key) {
      const v = target[key];
      if (key !== 'isCode' && key !== 'spanAt') return typeof v === 'function' ? v.bind(target) : v;
      return (...args) => {
        calls++;
        return v.apply(target, args);
      };
    },
  });
  assert.equal(importUseSpans(counted).length, 2001);
  assert.ok(calls < text.length, `${calls} lexer lookups for ${text.length} chars`);
});

let seq = 0;
async function harness(text, languageId, { lsp, line = 12, character = 10 } = {}) {
  stub.clearLspResponses();
  if (lsp) stub.setLspResponses(lsp);
  const doc = new stub.TextDocument(text, languageId, `file:///imports-${seq++}.${languageId}`);
  const ed = new stub.TextEditor(doc, line, character);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  d.engaged.add(doc.uri.toString());
  d.render();
  const atOpen = (live.get(d.pool.importRestore) ?? []).length;
  await d.runClassify(doc);
  const restore = () => (live.get(d.pool.importRestore) ?? []).length;
  const band2 = () => [...d.pool.id, ...d.pool.idg].flatMap((t) => live.get(t) ?? [])
    .map((r) => `${r.start.line + 1}:${doc.lineAt(r.start.line).text.slice(r.start.character, r.end.character)}`).sort();
  return {
    d, doc, live, atOpen, restore, band2,
    paint(phase) {
      d.machine.phase = phase;
      d.render();
      return live;
    },
  };
}

test('restore is band 1: same ranges in every phase with no provider', async () => {
  const h = await harness(read('shot.py'), 'python');
  const counts = [Phase.Survey, Phase.Focus, Phase.Edit, Phase.Survey].map((p) => (h.paint(p).get(h.d.pool.importRestore) ?? []).length);
  assert.deepEqual(counts, [6, 6, 6, 6]);
  assert.ok(!h.d.pool.banded().includes(h.d.pool.importRestore) && h.d.pool.all().includes(h.d.pool.importRestore));
  h.d.dispose();
});

test('restore is the theme type slate at normal weight, in both themes', () => {
  for (const [isDark, color] of [[true, '#a5b6c8'], [false, '#52657a']]) {
    const { options } = buildDecorationPool(isDark).importRestore;
    assert.equal(options.color, color);
    assert.equal(options.fontWeight, 'normal');
  }
});

test('restore comes off once the server answers with tokens, and an empty answer later keeps it off', async () => {
  const text = read('shot.py');
  const { legend, data } = stub.encodeTokens(text, [{ offset: text.indexOf('heapq.'), length: 5, type: 'namespace', modifiers: [] }]);
  const h = await harness(text, 'python', {
    lsp: {
      'vscode.provideDocumentSemanticTokensLegend': legend,
      'vscode.provideDocumentSemanticTokens': { data },
      'vscode.executeDocumentSymbolProvider': [],
    },
  });
  assert.equal(h.atOpen, 6, 'first paint, before the server answers');
  h.paint(Phase.Focus);
  assert.equal(h.restore(), 0);

  stub.setLspResponses({ 'vscode.provideDocumentSemanticTokens': { data: [] } });
  h.d.onEdit(h.doc.applyEdit(0, 0, '\n'));
  await h.d.runClassify(h.doc);
  h.paint(Phase.Focus);
  assert.equal(h.restore(), 0, 'empty answer: the provider is still registered');

  stub.clearLspResponses();
  h.d.onEdit(h.doc.applyEdit(0, 0, '\n'));
  await h.d.runClassify(h.doc);
  h.paint(Phase.Focus);
  assert.equal(h.restore(), 6, 'no provider any more');
  h.d.dispose();
});

test('an edit keeps the painted ranges until typing pauses, then recomputes once', async () => {
  const h = await harness(read('shot.py'), 'python');
  h.paint(Phase.Edit);
  const before = h.live.get(h.d.pool.importRestore);
  assert.equal(before.length, 6);
  let sends = 0;
  const set = h.live.set.bind(h.live);
  h.live.set = (type, ranges) => {
    if (type === h.d.pool.importRestore) sends++;
    return set(type, ranges);
  };
  const end = h.doc.getText().length;
  for (const piece of ['\nimport os', '\nos.getcwd', '()\n']) {
    h.d.onEdit(h.doc.applyEdit(h.doc.getText().length, h.doc.getText().length, piece));
    h.d.render();
  }
  assert.ok(h.doc.getText().length > end);
  assert.equal(sends, 0, 'nothing re-sent while typing');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sends, 1);
  assert.equal(h.restore(), 7);
  h.d.dispose();
});

test('band 2 is created first, so it wins where both paint', async () => {
  const h = await harness(read('shot.py'), 'python');
  const ids = [...h.d.pool.id, ...h.d.pool.idg].map((t) => t.id);
  assert.ok(ids.every((id) => id < h.d.pool.importRestore.id));
  h.d.dispose();
});

test('other languages are left alone', async () => {
  for (const [text, lang] of [
    ['use std::fs;\nfn f() { fs::read("x"); }\n', 'rust'],
    ['```python\nimport os\nos.getcwd()\n```\n', 'markdown'],
  ]) {
    const h = await harness(text, lang, { line: 1, character: 0 });
    assert.equal((h.paint(Phase.Focus).get(h.d.pool.importRestore) ?? []).length, 0, lang);
    h.d.dispose();
  }
});

test('band 2: a parameter named like an import is data, the import and its fallback are not', async () => {
  const text = [
    'import ssl',
    'try:',
    '    from _json import make_encoder as c_make_encoder',
    'except ImportError:',
    '    c_make_encoder = None',
    '',
    'def connect(host, ssl):',
    '    if ssl and c_make_encoder is not None:',
    '        return ssl.wrap(host), c_make_encoder',
    '    return host',
    '',
    'def plain(sock):',
    '    return ssl.wrap_socket(sock), ssl.PROTOCOL, sock',
  ].join('\n');
  const inConnect = await harness(text, 'python', { line: 7, character: 4 });
  inConnect.paint(Phase.Focus);
  assert.deepEqual(inConnect.band2(), ['10:host', '7:host', '7:ssl', '8:ssl', '9:host', '9:ssl']);
  inConnect.d.dispose();
  const inPlain = await harness(text, 'python', { line: 12, character: 4 });
  inPlain.paint(Phase.Focus);
  assert.deepEqual(inPlain.band2(), ['12:sock', '13:sock', '13:sock']);
  inPlain.d.dispose();
});

test('band 2: a comprehension target or lambda parameter named like an import leaves the import alone', async () => {
  const email = [
    'import email.message',
    'import email.parser',
    '',
    'MAPPING = {"a": "b"}',
    'REVERSED = {raw: email for email, raw in MAPPING.items()}',
    '',
    '',
    'def parse(data, strict):',
    '    parser = email.parser.Parser()',
    '    msg = parser.parsestr(data)',
    '    if strict and not isinstance(msg, email.message.Message):',
    '        raise ValueError(data)',
    '    return msg, email.message.EmailMessage()',
  ].join('\n');
  const inParse = await harness(email, 'python', { line: 9, character: 4 });
  inParse.paint(Phase.Focus);
  assert.deepEqual(inParse.band2(), ['10:data', '10:msg', '10:parser', '11:msg', '11:strict', '12:data', '13:msg', '8:data', '8:strict', '9:parser']);
  assert.deepEqual(painted(email, 'python'), ['9:email', '11:email', '13:email']);
  inParse.d.dispose();

  const lambdas = [
    'import os',
    'import json',
    '',
    'by_name = lambda os: os.name',
    'names = [json for json in ("a", "b")]',
    '',
    '',
    'def build(base, part):',
    '    full = os.path.join(base, part)',
    '    return json.dumps(full), base',
  ].join('\n');
  const inBuild = await harness(lambdas, 'python', { line: 8, character: 4 });
  inBuild.paint(Phase.Focus);
  assert.deepEqual(inBuild.band2(), ['10:base', '10:full', '8:base', '8:part', '9:base', '9:full', '9:part']);
  assert.deepEqual(painted(lambdas, 'python'), ['9:os', '10:json']);
  inBuild.d.dispose();
});

test('band 2: a name on an import line is never tinted, even when a variable shares it', async () => {
  const text = [
    'from _json import scanstring as c_scanstring',
    'from decoder import py_scanstring',
    'scanstring = c_scanstring or py_scanstring',
    'result = scanstring("a") if scanstring else None',
    'print(result, scanstring)',
  ].join('\n');
  const h = await harness(text, 'python', { line: 3, character: 0 });
  h.paint(Phase.Focus);
  const tinted = h.band2();
  assert.ok(tinted.includes('3:scanstring') && tinted.includes('5:scanstring'), tinted.join(' '));
  assert.ok(!tinted.some((t) => t.startsWith('1:') || t.startsWith('2:')), tinted.join(' '));
  h.d.dispose();
});
