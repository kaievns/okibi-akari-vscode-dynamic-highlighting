'use strict';
// A second runClassify for the block a classification is already computing joins it.
// Every harness awaits runClassify while the constructor's refresh, or onSelection, has
// a 60 ms classify of the same block pending; when that timer fired mid-flight it
// cancelled the awaited call, which returned before caching, and the render that
// followed painted nothing (test/javascript.test.js, under load).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const stub = require('./vscode-stub');
const vs = stub.install();
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');

const SRC = 'function f(args) {\n  const out = [];\n  for (const a of args) out.push(a);\n  return out;\n}\n';

function open() {
  stub.clearLspResponses();
  stub.setLspResponses({ 'vscode.executeDocumentSymbolProvider': [] });
  const doc = new stub.TextDocument(SRC, 'javascript', `file:///join-${Math.random()}.js`);
  const ed = new stub.TextEditor(doc, 2, 30);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  d.engaged.add(doc.uri.toString());
  d.machine.phase = Phase.Focus;
  const tints = () => [...d.pool.id, ...d.pool.idg].flatMap((t) => live.get(t) ?? []).length;
  return { d, doc, tints };
}

test('a classify of the same block and version joins the one in flight, so its caller sees the plan', async () => {
  const { d, doc, tints } = open();
  const first = d.runClassify(doc);
  const second = d.runClassify(doc);
  await first;
  d.render();
  assert.ok(tints() > 0, 'the awaited classify cached its plan');
  await second;
  d.dispose();
});

test('a classify for another version still supersedes the one in flight', async () => {
  const { d, doc, tints } = open();
  const first = d.runClassify(doc);
  doc.applyEdit?.(0, 0, ' ');
  await Promise.all([first, d.runClassify(doc)]);
  d.render();
  assert.ok(tints() > 0);
  d.dispose();
});
