'use strict';
// Navigation on a 25-copy Go file with the index cached per version (what the
// classifier does): classify and colour one function scope, at the START of the
// file and at its END. A scan that costs O(offset) shows up as the gap between
// the two rows.
const focus = require('../out/focus');
const classify = require('../out/classify');
const sc = require('../out/scopecolor');
const { generate } = require('./perf-inputs');

const L = 'go';
const input = generate('go', 5000, focus.scanBlocks);
const { text, tokens } = input;
const blocks = focus.scanBlocks(text, L);
const sorted = [...blocks].sort((a, b) => a.openOffset - b.openOffset);
const fnRanges = input.symbols.map((s) => ({ ...s }));
for (const b of blocks) {
  const r = focus.functionScopeOf(text, b, L);
  if (r) fnRanges.push(r);
}
fnRanges.sort((a, b) => a.start - b.start || b.end - a.end);

const t0 = process.hrtime.bigint();
const index = classify.buildFileIndex(text, tokens, fnRanges, L);
console.log(`buildFileIndex (once per version): ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(2)} ms`);

const scopeOf = (b) => classify.outermostFnOf(fnRanges, b.openOffset);
const fns = blocks.filter((b) => b.depth === 0 && focus.isFunctionHeader(text, b, L));
const span = (b) => b.closeOffset - b.openOffset;
const widest = (list) => [...list].sort((a, b) => span(b) - span(a) || a.openOffset - b.openOffset)[0];
const cases = [
  ['first copy', widest(fns.filter((b) => b.openOffset < input.unit))],
  ['last copy', widest(fns.filter((b) => b.openOffset >= input.unit * (input.copies - 1)))],
];

const N = 200;
for (const [label, fn] of cases) {
  const scope = scopeOf(fn);
  const scopeBlocks = blocks.filter((x) => x.openOffset >= scope.start && x.closeOffset < scope.end);
  const s = process.hrtime.bigint();
  for (let r = 0; r < N; r++) {
    const per = scopeBlocks.map((bl) => {
      const subs = sorted
        .filter((x) => x.openOffset > bl.openOffset && x.closeOffset < bl.closeOffset)
        .map((x) => focus.scopeRegionFor(text, x, L));
      const c = classify.classifyFromSemantic(
        text, focus.lexRegionFor(text, bl, L), classify.enclosingFnOf(fnRanges, bl.openOffset), fnRanges, tokens, 1,
        focus.focusKeyOf(bl), scope, focus.declRegionFor(text, bl, L), subs, index,
      );
      return { focusKey: c.focusKey, byName: c.byName };
    });
    sc.colorScope(per, 5);
  }
  const ms = Number(process.hrtime.bigint() - s) / 1e6 / N;
  console.log(`scope classify + colour, ${label.padEnd(10)} (${scopeBlocks.length} blocks): ${ms.toFixed(2)} ms per focus change`);
}
console.log(`file: ${text.length} chars, ${blocks.length} blocks, ${input.copies} copies of samples/sample.go`);

// A function-typed return annotation (`on(name: string): () => void {`) on the
// first function of a no-semicolon TS file. Read as a concise arrow it ran to the
// end of the file, became every later function's colour scope, and each focus
// change classified all of them. Both rows should match.
{
  const T = 'typescript';
  const fns = Array.from({ length: 1500 }, (_, k) => `export function f${k}(a: number) {\n  const b = a + ${k}\n  return b\n}\n`).join('\n');
  const heads = [
    ['annotated', 'export function on(name: string): () => void {\n  return () => console.log(name)\n}\n\n'],
    ['plain', 'export function on(name: string) {\n  return () => console.log(name)\n}\n\n'],
  ];
  for (const [label, head] of heads) {
    const src = head + fns;
    const bl = focus.scanBlocks(src, T);
    const ranges = bl.map((b) => focus.functionScopeOf(src, b, T)).filter(Boolean);
    const last = bl[bl.length - 1];
    const scope = classify.outermostFnOf(ranges, last.openOffset);
    const scopeBlocks = bl.filter((x) => x.openOffset >= scope.start && x.closeOffset < scope.end);
    classify.classifyFromHeuristic(src, focus.lexRegionFor(src, last, T), scope, ranges, 1, 'warm', scope,
      focus.declRegionFor(src, last, T), [], T, [], bl);
    const s = process.hrtime.bigint();
    for (const b of scopeBlocks) {
      classify.classifyFromHeuristic(src, focus.lexRegionFor(src, b, T), classify.enclosingFnOf(ranges, b.openOffset), ranges, 1,
        focus.focusKeyOf(b), scope, focus.declRegionFor(src, b, T), [], T, [], bl);
    }
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    console.log(`TS no-semicolon, last fn, ${label.padEnd(9)}: ${scopeBlocks.length} blocks in its colour scope, ${ms.toFixed(2)} ms`);
  }
}
