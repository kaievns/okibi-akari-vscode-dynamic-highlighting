'use strict';
// Unit tests for the markdown band-1 scanners (src/markdown.ts).
//
// These two marks exist because a colour theme cannot express them: VS Code
// never renders a token `background`, and the link underline comes from the
// `editor.links` contrib's own CSS class rather than from any token style. Both
// are therefore painted as decorations over offsets computed here.
//
// The risk that matters is FALSE POSITIVES inside code — an `a == b` repainted
// as a highlight, or a URL in a string losing its underline — so most of the
// coverage is negative.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const md = require('../out/markdown');

/** The substrings a span list selects, for readable assertions. */
const sel = (text, spans) => spans.map((s) => text.slice(s.start, s.end));

// ── codeSpans ───────────────────────────────────────────────────────────────

test('codeSpans: fenced block, inline span and indented block', () => {
  const text = [
    'prose `code` more',
    '',
    '```js',
    'a == b',
    '```',
    '',
    '    indented code',
    '',
    'tail',
  ].join('\n');
  const got = sel(text, md.codeSpans(text));
  assert.ok(got.some((s) => s === '`code`'), `inline span: ${JSON.stringify(got)}`);
  assert.ok(got.some((s) => s.startsWith('```js') && s.includes('a == b')), 'fence');
  assert.ok(got.some((s) => s === '    indented code'), 'indented');
});

test('codeSpans: a tilde fence is not closed by backticks', () => {
  const text = '~~~\na == b\n```\nstill code\n~~~\nprose\n';
  const spans = md.codeSpans(text);
  const covered = spans.some((s) => text.slice(s.start, s.end).includes('still code'));
  assert.ok(covered, 'the ``` must not close a ~~~ fence');
});

test('codeSpans: frontmatter only counts at the very start of the document', () => {
  const atStart = '---\nrev: 1.7\n---\n\nprose\n';
  assert.ok(
    md.codeSpans(atStart).some((s) => atStart.slice(s.start, s.end).includes('rev: 1.7')),
    'leading frontmatter is data',
  );

  const mid = 'prose\n\n---\n\nmore prose\n';
  const spans = md.codeSpans(mid);
  assert.ok(
    !spans.some((s) => mid.slice(s.start, s.end).includes('more prose')),
    'a mid-document --- is a horizontal rule, not frontmatter',
  );
});

test('codeSpans: an unterminated fence swallows the rest of the document', () => {
  const text = 'prose\n\n```js\na == b\nno closer here\n';
  const spans = md.codeSpans(text);
  assert.ok(spans.some((s) => s.end === text.length), 'runs to EOF');
});

test('codeSpans: an unclosed inline backtick is literal, not code', () => {
  const text = 'a ` lone backtick and ==mark== here\n';
  const spans = md.codeSpans(text);
  assert.deepEqual(spans, [], 'nothing is code');
});

// ── highlightSpans ──────────────────────────────────────────────────────────

test('highlightSpans: covers the text only, never the == sigils', () => {
  const text = 'the one warm ==mark== in prose\n';
  const spans = md.highlightSpans(text);
  assert.deepEqual(sel(text, spans), ['mark']);
});

test('highlightSpans: two marks on one line stay separate', () => {
  const text = 'a ==first== b ==second== c\n';
  assert.deepEqual(sel(text, md.highlightSpans(text)), ['first', 'second']);
});

test('highlightSpans: a setext H1 underline is not a chain of empty marks', () => {
  // This exact input broke the injection grammar three times: `(?=\S…)` accepted
  // `=` as the first content char, so `============` parsed as nested empty
  // highlights and corrupted the heading.
  const text = 'Still A Heading\n===============\n';
  assert.deepEqual(md.highlightSpans(text), []);
});

test('highlightSpans: == inside code is an operator, not a mark', () => {
  const inline = 'compare with `a == b` please\n';
  assert.deepEqual(md.highlightSpans(inline), []);

  const fenced = '```ts\nif (a == b) return;\n```\n';
  assert.deepEqual(md.highlightSpans(fenced), []);
});

test('highlightSpans: a lone == and an unclosed == are not marks', () => {
  assert.deepEqual(md.highlightSpans('a lone == in prose\n'), []);
  assert.deepEqual(md.highlightSpans('an ==unclosed mark\n'), []);
});

test('highlightSpans: a mark does not span lines', () => {
  const text = 'open ==here\nand close== there\n';
  assert.deepEqual(md.highlightSpans(text), []);
});

// ── linkSpans ───────────────────────────────────────────────────────────────

test('linkSpans: the URL half of an inline link, not the text', () => {
  const text = 'see [the thesis](https://example.com) for more\n';
  assert.deepEqual(sel(text, md.linkSpans(text)), ['https://example.com']);
});

test('linkSpans: image targets and autolinks', () => {
  const img = '![the seal](assets/seal.png)\n';
  assert.deepEqual(sel(img, md.linkSpans(img)), ['assets/seal.png']);

  const auto = 'bare <https://example.com> autolink\n';
  assert.deepEqual(sel(auto, md.linkSpans(auto)), ['https://example.com']);
});

test('linkSpans: reference definitions', () => {
  const text = '[ref]: https://example.com "Title"\n';
  assert.deepEqual(sel(text, md.linkSpans(text)), ['https://example.com']);
});

test('linkSpans: a URL inside code keeps its underline suppression off', () => {
  const inline = 'call `fetch("https://example.com")` here\n';
  assert.deepEqual(md.linkSpans(inline), []);

  const fenced = '```ts\nconst u = "https://example.com";\n```\n';
  assert.deepEqual(md.linkSpans(fenced), []);
});

test('linkSpans: a bare URL in prose is covered exactly once', () => {
  const text = 'go to https://example.com/x now\n';
  const spans = md.linkSpans(text);
  assert.deepEqual(sel(text, spans), ['https://example.com/x']);
});

test('linkSpans: a parenthesised URL is not double-counted', () => {
  // The inline-link branch and the bare-URL branch could both claim this; the
  // bare pattern's lookbehind excludes a preceding `(` so only one fires.
  const text = 'see [wiki](https://en.wikipedia.org/wiki/Foo) now\n';
  const spans = md.linkSpans(text);
  assert.equal(spans.length, 1, `expected one span, got ${JSON.stringify(sel(text, spans))}`);
});

test('linkSpans: link TEXT is never included', () => {
  const text = 'see [the thesis](https://example.com) now\n';
  for (const s of md.linkSpans(text)) {
    assert.ok(!text.slice(s.start, s.end).includes('thesis'), 'text stays sora');
  }
});

// ── mergeSpans ──────────────────────────────────────────────────────────────

test('mergeSpans: unions overlaps so a wash is never applied twice', () => {
  // Two decoration ranges over the same text apply the style twice, which for an
  // alpha-bearing background visibly doubles the tint. A reference definition's
  // target matches both the refdef and bare-URL branches, which is how this was
  // caught.
  const merged = md.mergeSpans([
    { start: 10, end: 20 },
    { start: 0, end: 5 },
    { start: 15, end: 30 },
    { start: 40, end: 45 },
  ]);
  assert.deepEqual(merged, [
    { start: 0, end: 5 },
    { start: 10, end: 30 },
    { start: 40, end: 45 },
  ]);
});

test('mergeSpans: abutting spans join, disjoint ones do not', () => {
  assert.deepEqual(md.mergeSpans([{ start: 0, end: 5 }, { start: 5, end: 9 }]), [{ start: 0, end: 9 }]);
  assert.deepEqual(md.mergeSpans([{ start: 0, end: 5 }, { start: 6, end: 9 }]), [
    { start: 0, end: 5 },
    { start: 6, end: 9 },
  ]);
});

test('mergeSpans: does not mutate its input', () => {
  const input = [{ start: 10, end: 20 }, { start: 15, end: 30 }];
  const copy = JSON.parse(JSON.stringify(input));
  md.mergeSpans(input);
  assert.deepEqual(input, copy);
});

// ── regressions found by running the scanners over samples/sample.md ─────────
// The unit tests above all passed while both of these were broken, which is why
// the sample sweep is part of the suite.

test('linkSpans: a footnote definition is not a link', () => {
  // `[^1]: prose…` has the same shape as `[ref]: url`, so the refdef branch
  // claimed the first WORD of every footnote body.
  const text = '[^1]: Hierarchy rides lightness and weight.\n';
  assert.deepEqual(md.linkSpans(text), []);
});

test('linkSpans: one level of balanced parens stays inside the URL', () => {
  const text = 'A URL with parens: [wiki](https://en.wikipedia.org/wiki/Foo_(bar)).\n';
  assert.deepEqual(sel(text, md.linkSpans(text)), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
});

test('linkSpans + highlightSpans: the real sample yields only intended marks', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'samples', 'sample.md');
  if (!fs.existsSync(file)) return; // sample is optional in a bare checkout
  const text = fs.readFileSync(file, 'utf8');

  for (const s of md.highlightSpans(text)) {
    const got = text.slice(s.start, s.end);
    assert.ok(!got.includes('='), `highlight must exclude sigils: ${JSON.stringify(got)}`);
    assert.ok(!got.includes('\n'), `highlight must not span lines: ${JSON.stringify(got)}`);
  }
  for (const s of md.linkSpans(text)) {
    const got = text.slice(s.start, s.end);
    assert.ok(
      /^(https?:\/\/|mailto:|[\w./-]+\.\w+)/.test(got),
      `link span must look like a target, got ${JSON.stringify(got)}`,
    );
  }
});

// ── prose is not a data scope ─────────────────────────────────────────────────

test('markdown has NO focusable block, so bands 2-3 cannot paint', () => {
  // The contract is stated in samples/sample.md itself: "there are no identity
  // tints here and the phase stays Survey 構 while the caret moves through text.
  // That is deliberate: prose is not data flow."
  //
  // The bug: a markdown file DOES contain braces — every fenced Go/TS/JSON block in
  // it — so the brace scan found real blocks, and a caret in PROSE fell through to
  // the synthetic whole-file scope. That made the entire document one "function"
  // whose most frequent words are `the`, `a` and `The`, and the layer tinted English
  // articles as data identities.
  const focus = require('../out/focus');
  const classify = require('../out/classify');
  const scopecolor = require('../out/scopecolor');
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(path.join(__dirname, '../samples/sample.md'), 'utf8');

  assert.equal(focus.scanBlocks(text, 'markdown').length, 0, 'prose has no blocks');
  assert.equal(focus.isProseLanguage('markdown'), true);
  assert.equal(focus.isProseLanguage('typescript'), false);

  // The caret in prose must focus NOTHING. Withholding the text fallback is what
  // does it — passing text would hand back the whole-file scope.
  // Any plain prose line will do; locate one by shape rather than by wording so
  // editing the sample's text cannot break the test. A paragraph line here starts
  // with a letter and carries no fence, list, heading or table markup.
  const lines = text.split('\n');
  const li = lines.findIndex((l, i) => /^[A-Za-z]/.test(l) && !/^[#>|`-]/.test(l)
    && l.length > 40 && !l.includes('|')
    // not inside a fenced block: an odd number of ``` fences above means we are in one
    && lines.slice(0, i).filter((p) => p.startsWith('```')).length % 2 === 0);
  assert.ok(li > 0, 'no prose line found in sample.md');
  assert.equal(
    focus.innermostBlock(focus.scanBlocks(text, 'markdown'), li, undefined, undefined),
    null,
    'no block → runClassify returns early → the phase stays Survey',
  );

  // And the regression itself: with the whole file as the scope, English articles
  // were the top-ranked "data identities". The heuristic now paints declared names
  // only, so even without the guard above a prose word cannot become one.
  const whole = focus.topLevelBlock(text);
  const cls = classify.classifyFromHeuristic(
    text, focus.scopeRegionFor(text, whole), undefined, [], 1,
    focus.focusKeyOf(whole), undefined, focus.declRegionFor(text, whole), [],
  );
  const wouldTint = scopecolor.colorScope(
    [{ focusKey: focus.focusKeyOf(whole), byName: cls.byName }], 7,
  ).visible.get(focus.focusKeyOf(whole)) ?? [];
  assert.deepEqual(
    wouldTint.filter((n) => ['the', 'a', 'The', 'A'].includes(n)), [],
    'English articles are not data identities',
  );
});

test('markdown still gets its two BAND-1 marks', () => {
  // Suppressing bands 2-3 must not touch the resting register: the ==highlight==
  // wash and the link-underline cancellation are band 1 and paint in Survey.
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(path.join(__dirname, '../samples/sample.md'), 'utf8');
  assert.ok(md.highlightSpans(text).length > 0, 'the highlight wash survives');
  assert.ok(md.linkSpans(text).length > 0, 'the underline cancellation survives');
});

test('every markdown-derived id VS Code registers is prose, and the ones it serves as markdown take the marks', () => {
  const focus = require('../out/focus');
  const fs = require('node:fs');
  const path = require('node:path');
  const { served, languages } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/markdown-languages.json'), 'utf8'));
  assert.deepEqual(focus.markdownLanguages().sort(), [...served].sort());
  for (const [id, { extension, grammar, files }] of Object.entries(languages)) {
    assert.ok(extension, `${id} names the extension that registers it`);
    const opens = files.length > 0;
    assert.equal(focus.isProseLanguage(id), opens, `${id} (${extension}) is prose exactly when a file opens as it`);
    assert.equal(focus.isNonFlowLanguage(id), opens, `${id}: non-flow`);
    assert.equal(focus.scanBlocks('f(a) {\n  return a;\n}\n', id).length, opens ? 0 : 1, `${id}: blocks`);
    assert.equal(focus.isMarkdownLanguage(id), served.includes(id), `${id}: the markdown marks`);
    if (served.includes(id)) assert.match(grammar, /^text\.html\.markdown(\.|$)/, `${id}: the theme's markdown injections reach its grammar`);
  }
  for (const id of served) assert.ok(id in languages, `${id} is registered`);
  assert.equal(focus.isMarkdownLanguage('quarto'), false, 'control: prose that VS Code does not serve as markdown');
  // MDX's prose links follow markdown's; its grammar is source.mdx, which the theme's ==highlight== scope does not reach.
  assert.deepEqual(Object.keys(languages).filter((id) => focus.isLinkMarkLanguage(id)).sort(), [...served, 'mdx'].sort());
});

test('code languages still resolve blocks normally', () => {
  const focus = require('../out/focus');
  const fs = require('node:fs');
  const path = require('node:path');
  for (const [file, lang] of [['sample.ts', 'typescript'], ['sample.go', 'go'], ['sample.py', 'python']]) {
    const src = fs.readFileSync(path.join(__dirname, '../samples', file), 'utf8');
    assert.ok(
      focus.scanBlocks(src, lang).length > 10,
      `${lang} must still have blocks — the prose guard is per language`,
    );
  }
});

test('a fence indented inside a list item is code', () => {
  const text = '- item\n\n    ```js\n    if (a ==b== c) {}\n    ```\n\n==after==\n';
  assert.deepEqual(md.highlightSpans(text).map((s) => text.slice(s.start, s.end)), ['after']);
  // Outside a list, four spaces after a paragraph is a lazy continuation, not a fence.
  const lazy = 'text\n    ```\n==z==\n';
  assert.deepEqual(md.highlightSpans(lazy).map((s) => lazy.slice(s.start, s.end)), ['z']);
});

test('`==` inside a link target is not a mark; a mark around a link is', () => {
  const text = 'see [x](http://e.com/?a==b==c) and ==see [y](http://e.com)== ok';
  assert.deepEqual(md.highlightSpans(text).map((s) => text.slice(s.start, s.end)), ['see [y](http://e.com)']);
});

test('no ==highlight== wash inside an HTML comment', () => {
  const text = '==real highlight==\n\n<!-- TODO: ==not a highlight== -->\n\n<!--\n==draft note==\n-->\n\n`<!--` ==kept==\n';
  assert.deepEqual(md.highlightSpans(text).map((s) => text.slice(s.start, s.end)), ['real highlight', 'kept']);
  // The underline cancel is `text-decoration: none`, invisible where nothing is
  // underlined, so it still covers a URL in a comment.
  const link = '<!-- https://example.com/hidden -->\n';
  assert.equal(md.linkSpans(link).length, 1);
});

// ── MDX ─────────────────────────────────────────────────────────────────────

const { mdxCodeSpans } = require('../out/mdx');

test('mdxCodeSpans: ESM to its closing blank line, expressions, comments and JSX tags are code; JSX children are prose', () => {
  const text = [
    "import {Chart} from './chart.js'",
    "import confetti from 'https://esm.sh/canvas-confetti'",
    'export const meta = {',
    '',
    "  site: 'https://in-esm.example',",
    '}',
    '',
    '# Title {meta.title}',
    '',
    'A [link](https://prose.example) and {/* https://in-comment.example */} ==mark==.',
    '',
    '<Card href="https://in-attr.example" data={{u: "https://in-expr.example"}}>',
    '  Child prose with [a link](https://child.example) and ==child==.',
    '</Card>',
    '',
    'Escaped \\{ brace and a < b comparison with https://bare.example',
  ].join('\n');
  const code = mdxCodeSpans(text);
  assert.deepEqual(sel(text, md.linkSpans(text, code)), ['https://prose.example', 'https://child.example', 'https://bare.example']);
  assert.deepEqual(sel(text, md.highlightSpans(text, code)), ['mark', 'child']);
  const inCode = (needle) => code.some((s) => text.indexOf(needle) >= s.start && text.indexOf(needle) < s.end);
  for (const n of ['https://esm.sh', 'https://in-esm', 'meta.title', 'https://in-comment', 'https://in-attr', 'https://in-expr', '</Card>']) assert.ok(inCode(n), `${n} is code`);
  for (const n of ['Child prose', 'Escaped', 'a < b']) assert.ok(!inCode(n), `${n} is prose`);
});

test('mdxCodeSpans: markdown code stays code, and an import inside a fence is no ESM', () => {
  const text = ['```js', "import x from 'https://in-fence.example'", '```', '', 'Text `{not: expr}` and {x}.', ''].join('\n');
  const code = mdxCodeSpans(text);
  assert.deepEqual(md.linkSpans(text, code), []);
  assert.ok(code.some((s) => text.slice(s.start, s.end) === '{x}'));
});

test('mdxCodeSpans: an ESM block runs past a blank line inside an open bracket, template or JSX element, and to the end while one stays open', () => {
  const esm = (text) => text.slice(0, mdxCodeSpans(text)[0].end);
  assert.equal(esm('export const a = [\n\n  1,\n]\n\nprose'), 'export const a = [\n\n  1,\n]');
  assert.equal(esm('export const q = `\n\nline`;\n\nprose'), 'export const q = `\n\nline`;');
  assert.equal(esm('export const x = <div>\ntext\n\nmore</div>\n\nprose'), 'export const x = <div>\ntext\n\nmore</div>');
  const open = 'export const meta = {\n\n## Heading\n\nA [link](https://x.example).\n';
  assert.deepEqual(mdxCodeSpans(open), [{ start: 0, end: open.length }]);
});

test('mdxCodeSpans stays linear in a document whose ESM block is open, closed or followed by expressions', () => {
  const { growth } = require('./cpu-time');
  const unit = '## Heading\n\nSome prose with a [link](https://example.com/page), `code` and {x}.\n\n<Note>\n\nInside.\n\n</Note>\n\n';
  let seq = 0;
  for (const head of ['export const meta = {\n\n', 'import {A} from "./a"\nexport const x = f(\n\n', 'export const q = `\n\n', 'export const meta = {a: 1}\n\n']) {
    const ratio = growth((n) => `${head}${unit.repeat(n)}<!-- ${seq++} -->`, mdxCodeSpans, 300);
    assert.ok(ratio < 24, `${JSON.stringify(head)}: 8x the document cost ${ratio.toFixed(1)}x`);
  }
});
