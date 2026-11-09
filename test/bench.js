'use strict';
// Per-operation cost on one real sample (samples/sample.go, real gopls tokens).
// The per-version steps run once per edit; the per-block steps run on every
// focus change. Large files: test/bench-scale.js.
const focus = require('../out/focus');
const classify = require('../out/classify');
const sc = require('../out/scopecolor');
const { lex } = require('../out/lex');
const fs = require('fs');

const L = 'go';
const text = fs.readFileSync(`${__dirname}/../samples/sample.go`, 'utf8');
const tokens = require('./fixtures/sample.go.tokens.json');
const N = 200;
const t = (label, fn) => {
  const s = process.hrtime.bigint();
  for (let i = 0; i < N; i++) fn();
  console.log(label.padEnd(42), `${(Number(process.hrtime.bigint() - s) / 1e6 / N).toFixed(3)} ms/op`);
};

const blocks = focus.scanBlocks(text, L);
const fnRanges = blocks.map((b) => focus.functionScopeOf(text, b, L)).filter(Boolean);
const sorted = [...blocks].sort((a, b) => a.openOffset - b.openOffset);

console.log('per version');
t('  lex (unmemoised)', () => lex(text, L));
t('  scanBlocks (lex memoised)', () => focus.scanBlocks(text, L));
t('  buildFileIndex', () => classify.buildFileIndex(text, tokens, fnRanges.slice(), L));

const index = classify.buildFileIndex(text, tokens, fnRanges, L);
const classifyBlock = (bl, scope) => classify.classifyFromSemantic(
  text, focus.lexRegionFor(text, bl, L), classify.enclosingFnOf(fnRanges, bl.openOffset), fnRanges, tokens, 1,
  focus.focusKeyOf(bl), scope, focus.declRegionFor(text, bl, L),
  sorted.filter((x) => x.openOffset > bl.openOffset && x.closeOffset < bl.closeOffset).map((x) => focus.scopeRegionFor(text, x, L)),
  index,
);
const b = blocks.find((x) => x.openOffset === text.indexOf('{', text.indexOf('func summarize')));
const scopeFn = classify.outermostFnOf(fnRanges, b.openOffset);
const scopeBlocks = blocks.filter((x) => x.openOffset >= scopeFn.start && x.closeOffset < scopeFn.end);

console.log('per focus change (cached index)');
t('  classifyFromSemantic (1 block)', () => classifyBlock(b, scopeFn));
t(`  classify + colour one scope (${scopeBlocks.length} blocks)`, () => {
  sc.colorScope(scopeBlocks.map((bl) => {
    const c = classifyBlock(bl, scopeFn);
    return { focusKey: c.focusKey, byName: c.byName };
  }), 5);
});
const top = focus.topLevelBlock(text);
const excludes = focus.topLevelExcludes(text, blocks, L);
t('  classify the module top level', () => classify.classifyFromSemantic(
  text, focus.lexRegionFor(text, top, L), undefined, fnRanges, tokens, 1, 'top', undefined,
  focus.declRegionFor(text, top, L), sorted.map((x) => focus.scopeRegionFor(text, x, L)), index, excludes,
));
console.log(`\nfile: ${text.length} chars | ${blocks.length} blocks | ${tokens.length} tokens`);
