'use strict';
// Unit tests for the markdown band-1 scanners (src/markdown.ts).
//
// These marks exist because a colour theme cannot express them: VS Code never
// renders a token `background`, the link underline comes from the `editor.links`
// contrib's own CSS class rather than from any token style, and a TextMate rule
// sees one line and no definitions. All are painted as decorations over offsets
// computed here.
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

test('highlightSpans: a mark may hold a code span, and closes at the first `==` outside one', () => {
  const t = '==see `parse()` here== now and ==a `b==c` d== too\n';
  assert.deepEqual(sel(t, md.highlightSpans(t)), ['see `parse()` here', 'a `b==c` d']);
  assert.deepEqual(md.highlightSpans('==a `b==` c\n'), [], 'no closer outside the code span on the line');
  assert.deepEqual(sel('`a==b` and ==c==\n', md.highlightSpans('`a==b` and ==c==\n')), ['c'], 'an opener in code starts nothing');
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

test('linkSpans: an autolink of any scheme, or an email, outside code', () => {
  const t = 'Join <irc://irc.example.net/okibi>, <ftp://ftp.example.com/a>, <localhost:5001/foo>, <mailto:a@b.io>, <me@example.com> and <made-up:x>.\n';
  assert.deepEqual(sel(t, md.linkSpans(t)), ['irc://irc.example.net/okibi', 'ftp://ftp.example.com/a', 'localhost:5001/foo', 'mailto:a@b.io', 'me@example.com', 'made-up:x']);
  assert.deepEqual(sel(spec(346), md.linkSpans(spec(346))), ['https://foo.bar.`baz'], 'an autolink holds the backtick a code span would start at');
  assert.deepEqual(md.linkSpans(spec(345)), [], 'a code span holds the `<`: no autolink, and the URL in it keeps its underline');
  assert.deepEqual(md.linkSpans('<x://a b> <x:a\n>\n'), [], 'no whitespace inside');
});

test('linkSpans: a bare URL as far as VS Code\'s link computer underlines it', () => {
  const t = '(Visit https://encrypted.google.com/search?q=Markup+(business))\nOpen file:///etc/hosts, then https://example.com/a.\n';
  assert.deepEqual(sel(t, md.linkSpans(t)), ['https://encrypted.google.com/search?q=Markup+(business))', 'file:///etc/hosts', 'https://example.com/a']);
});

test('linkSpans and highlightSpans stay linear on unclosed brackets, definition labels and marks', () => {
  const { growth } = require('./cpu-time');
  for (const [name, make] of [
    ['brackets', (n) => '[a '.repeat(n * 20)],
    ['brackets before a close', (n) => `${'[a '.repeat(n * 20)}](u)`],
    ['labels on each line', (n) => '[a\n'.repeat(n * 20)],
    ['escapes', (n) => '[\\] '.repeat(n * 20)],
    ['marks around code', (n) => '==a `b` c== '.repeat(n * 10)],
  ]) {
    const ratio = growth((n) => make(n), (t) => md.highlightSpans(t), 200);
    assert.ok(ratio < 24, `${name}: 8x the document cost ${ratio.toFixed(1)}x`);
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

test('markdown still gets its BAND-1 marks', () => {
  // Suppressing bands 2-3 must not touch the resting register: the ==highlight==
  // wash and the link-underline cancellation are band 1 and paint in Survey.
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(path.join(__dirname, '../samples/sample.md'), 'utf8');
  assert.ok(md.highlightSpans(text).length > 0, 'the highlight wash survives');
  assert.ok(md.linkSpans(text).length > 0, 'the underline cancellation survives');
  assert.ok(md.proseMarks(text).bold.length > 0, 'the setext heading weight survives');
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

// ── grammarLinks: where the bundled grammar sees a link ──────────────────────

test('grammarLinks: the grammar link rules, in its order, on one line', () => {
  const g = (s) => md.grammarLinks(s).map((x) => s.slice(x.start, x.end));
  assert.deepEqual(g('[ref]: https://example.com "Title"'), ['[ref]: https://example.com "Title"'], 'link-def is the whole line');
  assert.deepEqual(g('a [text](url "t") b'), ['[text](url "t")'], 'link-inline');
  assert.deepEqual(g('a [x [y] z](url) b'), ['[x [y] z](url)'], 'balanced brackets in the text');
  assert.deepEqual(g('[text][ref] and [text] [] and [WIP]'), ['[text][ref]', '[text] []', '[WIP]'], 'link-ref, link-ref-literal, link-ref-shortcut');
  assert.deepEqual(g('[some words] here'), [], 'a shortcut holds no whitespace');
  assert.deepEqual(g('[foo][bar][baz]'), ['[foo][bar]'], 'a reference right after `]` does not start');
  assert.deepEqual(g('\\[foo] and `[bar]` and <https://x.example/[y]>'), [], 'escapes, code spans and autolinks come first');
  assert.deepEqual(g('![alt](a.png) ![alt][ref]'), ['![alt](a.png)', '![alt][ref]'], 'image-inline and image-ref');
  assert.deepEqual(g('[link](/my uri)'), ['[link]'], 'a space in the URL fails the inline rule; the shortcut still matches');
  assert.deepEqual(g('[a](b "x y") [c](<d e> \'t\')'), ['[a](b "x y")', '[c](<d e> \'t\')'], 'titles and a pointy URL');
  assert.deepEqual(g('[a](b"x y")'), ['[a]'], 'the URL run is atomic, so the title cannot take its quote');
});

// ── proseMarks ───────────────────────────────────────────────────────────────

const SPEC_EX = require('./fixtures/commonmark/spec-0.31.2.json').examples;
const spec = (n) => SPEC_EX.find((e) => e.example === n).markdown;
const tonesOf = (text, marks = md.proseMarks(text)) => marks.tones.map((s) => `${text.slice(s.start, s.end)}=${s.tone}`);

test('proseMarks: a [label] with no matching definition is prose again, in the colour around it', () => {
  const text = [
    'See [WIP], [optional] and [1].',
    '',
    '> A quoted [draft] note.',
    '',
    '## Status [beta]',
    '',
    'Some **[bold]** and ~~[gone]~~ words.',
    '',
    '- [x] done [later]',
    '',
    '| [th] | b |',
    '|---|---|',
    '| [td] | c |',
    '',
    '[^1]: a footnote [aside].',
  ].join('\n');
  assert.deepEqual(tonesOf(text), [
    '[WIP]=prose', '[optional]=prose', '[1]=prose', '[draft]=quote', '[beta]=emphasis', '[bold]=emphasis', '[gone]=struck',
    '[later]=struck', '[th]=emphasis', '[td]=prose', '[aside]=quote',
  ]);
  const p = md.proseMarks(text);
  assert.deepEqual(sel(text, p.linkStruck), ['[gone]', '[later]'], 'struck text keeps its line');
  assert.ok(sel(text, p.linkPlain).includes('[WIP]'), 'and the rest loses any underline a definition the markdown server accepts would give it');
});

test('proseMarks: real links, footnote markers, task boxes, wikilinks and callout types are left alone', () => {
  const text = [
    'A [link](https://example.com), a [ref][r], a [shortcut], a footnote[^1] and [[Wiki Page]].',
    '',
    '- [ ] open',
    '- [x] done',
    '',
    '> [!note] Title',
    '',
    '[r]: https://example.com/r',
    '[shortcut]: https://example.com/s',
  ].join('\n');
  assert.deepEqual(md.proseMarks(text).tones, []);
});

test('proseMarks: labels match per CommonMark: case, whitespace, escapes and the 999-character limit', () => {
  assert.deepEqual(tonesOf('[FOO] [Foo]\n\n[foo]: /u\n'), [], 'case folds');
  assert.deepEqual(tonesOf('[ẞ]\n\n[SS]: /u\n'), [], 'Unicode case folds');
  assert.deepEqual(tonesOf(spec(545)), ['[bar][foo=prose', '\\=sigil', '!]=prose'], 'an escape is not unescaped, and its backslash is a sigil');
  // A label with spaces is a link the grammar cannot see: it is painted as one.
  assert.deepEqual(tonesOf('[foo   bar]\n\n[Foo bar]: /u\n'), ['[=sigil', 'foo   bar=link', ']=sigil']);
  const long = 'a'.repeat(1000);
  assert.deepEqual(tonesOf(`[${long}]\n\n[${long}]: /u\n`), [`[${long}]=prose`, `[${long}]: /u=prose`], 'past 999 characters there is no definition');
  assert.deepEqual(tonesOf(`[${'a'.repeat(999)}]\n\n[${'a'.repeat(999)}]: /u\n`), []);
});

test('proseMarks: the spec examples where a bracket is no link paint it as text, and never paint link text as prose', () => {
  const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  let restored = 0;
  for (const ex of SPEC_EX.filter((e) => /^(Links|Link reference definitions|Images)$/.test(e.section))) {
    const outside = decode(ex.html.replace(/<a [^>]*>[\s\S]*?<\/a>/g, '\u0000').replace(/<[^>]+>/g, ''));
    for (const s of md.proseMarks(ex.markdown).tones) {
      if (!['prose', 'quote', 'emphasis', 'struck'].includes(s.tone)) continue;
      const shown = ex.markdown.slice(s.start, s.end).replace(/\\([!-/:-@[-`{-~])/g, '$1');
      assert.ok(outside.includes(shown), `${ex.example}: ${JSON.stringify(shown)} is outside every link in ${JSON.stringify(ex.html)}`);
      restored++;
    }
  }
  assert.ok(restored >= 30, `${restored} restored runs`);
  assert.deepEqual(tonesOf(spec(542)), ['[foo]=prose']);
  assert.deepEqual(tonesOf(spec(569)), ['[foo]=prose', '[=sigil', 'bar=link', '][=sigil', 'baz=link', ']=sigil']);
  assert.deepEqual(tonesOf(spec(488)), ['[link]=prose'], 'a failed inline link');
  assert.deepEqual(tonesOf(spec(209)), ['[foo]=prose'], 'text after a title: no definition');
  assert.deepEqual(tonesOf(spec(213)), ['[bar]: /baz=prose', '[bar]=prose'], 'a line the grammar reads as a definition and CommonMark as paragraph text');
});

test('proseMarks: a reference link and a definition carry no underline; struck text keeps its line', () => {
  const plain = (text) => sel(text, md.proseMarks(text).linkPlain);
  assert.deepEqual(plain(spec(527)), ['foo', 'bar', 'bar'], 'full: the text, the label and the definition label');
  assert.deepEqual(plain(spec(553)), ['foo', 'foo'], 'collapsed');
  assert.deepEqual(plain(spec(557)), ['foo', 'foo'], 'shortcut');
  assert.deepEqual(plain('## [Unreleased]\n\n## [1.0.0] - 2024-01-01\n\n[Unreleased]: https://example.com/compare\n[1.0.0]: https://example.com/1.0.0\n'),
    ['Unreleased', '1.0.0', 'Unreleased', '1.0.0'], 'a changelog');
  const struck = '~~[foo]~~\n\n[foo]: /u\n';
  assert.deepEqual(sel(struck, md.proseMarks(struck).linkStruck), ['foo']);
  assert.deepEqual(md.proseMarks('[a](https://example.com)\n').linkPlain, [], 'an inline link is linkSpans\' business');
});

test('proseMarks: setext heading text takes the heading register', () => {
  const heading = (text) => sel(text, md.proseMarks(text).bold);
  assert.deepEqual(heading(spec(80)), ['Foo ', 'bar', 'Foo ', 'bar'], 'emphasis sigils keep their weight');
  assert.deepEqual(tonesOf(spec(80)), ['Foo =emphasis', '*=sigil', 'bar=emphasis', '*=sigil', 'Foo =emphasis', '*=sigil', 'bar=emphasis', '*=sigil']);
  assert.deepEqual(heading(spec(95)), ['Foo', 'Bar'], 'multi-line content');
  assert.deepEqual(heading(spec(81)), ['Foo ', 'bar', 'baz'], 'emphasis across the lines');
  assert.deepEqual(heading(spec(215)), ['bar'], 'not the definition above it');
  for (const n of [85, 87, 92, 93, 94, 97, 98, 99, 101, 104, 105, 106]) assert.deepEqual(md.proseMarks(spec(n)).bold, [], `spec ${n}`);
  assert.deepEqual(heading('---\ntitle: x\n---\n\nText\n'), [], 'front matter');
  assert.deepEqual(heading(spec(96)), ['Bar'], 'front matter, then a heading');
  const inline = 'Use `code` and [a link](https://example.com) here\n---\n';
  assert.deepEqual(tonesOf(inline), ['Use =emphasis', ' and =emphasis', ' here=emphasis'], 'code and link text keep the grammar\'s colour');
  assert.deepEqual(heading(inline), ['Use `code` and [a link](https://example.com) here'], 'and take the weight');
  for (const s of md.proseMarks(spec(80)).bold) assert.ok(!spec(80).slice(s.start, s.end).includes('='), 'never the underline');
  assert.deepEqual(tonesOf(spec(102)), ['> foo=emphasis'], 'an escaped character is heading text, its backslash the theme\'s sigil');
});

test('proseMarks: a block quote\'s lazy line is quoted, emphasis included', () => {
  assert.deepEqual(tonesOf(spec(247)), ['baz=quote']);
  assert.deepEqual(tonesOf(spec(232)), ['baz=quote']);
  assert.deepEqual(tonesOf(spec(292)), ['continued here.=quote'], 'inside a list item');
  assert.deepEqual(tonesOf('> quoted\nlazy *em* line\n'), ['lazy =quote', '*=sigil', 'em=emphasis', '*=sigil', ' line=quote']);
  assert.deepEqual(tonesOf(spec(248)), [], 'after a blank line it is a new paragraph');
  assert.deepEqual(tonesOf('- item\nlazy\n'), [], 'a list item\'s lazy line is prose either way');
});

test('proseMarks: a code span, autolink or link that a restore reaches into is restored whole', () => {
  assert.deepEqual(tonesOf(spec(537)), ['[foo=prose', '`=sigil', '][ref]=code', '`=sigil']);
  assert.deepEqual(tonesOf(spec(538)), ['[foo=prose', '<=sigil', 'https://example.com/?search=][ref]=link', '>=sigil']);
  assert.deepEqual(tonesOf(spec(529)), ['\\=sigil'], 'an escape in link text is a sigil, not link text');
});

test('proseMarks over the real sample marks the setext headings only', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const text = fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample.md'), 'utf8');
  const p = md.proseMarks(text);
  assert.deepEqual([...new Set(p.tones.map((s) => s.tone))], ['emphasis']);
  assert.ok(p.bold.length > 0 && p.bold.every((s) => /^[^=\n-]/.test(text.slice(s.start, s.end))), JSON.stringify(sel(text, p.bold)));
  assert.deepEqual([p.italic, p.linkStruck], [[], []]);
});

const toneList = (text, marks = md.proseMarks(text)) => marks.tones.map((s) => [text.slice(s.start, s.end), s.tone]);

test('proseMarks: a setext underline the grammar cannot see is a sigil', () => {
  // The grammar's `^(={3,})` and `^(-{3,})` see an underline at column 0, three long.
  assert.deepEqual(toneList(spec(83)), [['Foo', 'emphasis'], ['Foo', 'emphasis'], ['=', 'sigil']], 'one `=`');
  assert.deepEqual(toneList(spec(84)), [['Foo', 'emphasis'], ['Foo', 'emphasis'], ['Foo', 'emphasis'], ['===', 'sigil']], 'indented');
  assert.deepEqual(toneList(spec(86)), [['Foo', 'emphasis'], ['----', 'sigil']], 'indented, trailing spaces left out');
  assert.deepEqual(toneList('> Quote\n> ---\n'), [['Quote', 'emphasis'], ['---', 'sigil']], 'in a block quote');
  assert.deepEqual(toneList('- Item\n  ===\n'), [['Item', 'emphasis'], ['===', 'sigil']], 'in a list item');
  assert.deepEqual(toneList(spec(80)).filter(([, t]) => t === 'sigil').map(([x]) => x), ['*', '*', '*', '*'], 'the grammar paints the others');
});

test('proseMarks: a `===` line that heads no heading is text', () => {
  assert.deepEqual(toneList(spec(97)), [['====', 'prose']], 'after a blank line');
  assert.deepEqual(toneList(spec(45)), [['===', 'prose']], 'alone');
  assert.deepEqual(toneList(spec(216)), [['===', 'prose']], 'after a definition, which heads nothing');
  assert.deepEqual(toneList('- foo\n===\n'), [['===', 'prose']], 'a list item\'s lazy line');
  assert.deepEqual(toneList('Para\n  ===\n'), [['Para', 'emphasis'], ['===', 'sigil']], 'an indented underline is a sigil');
});

test('proseMarks: emphasis across lines takes its italic or bold', () => {
  const style = (text) => {
    const p = md.proseMarks(text);
    return { italic: sel(text, p.italic), bold: sel(text, p.bold) };
  };
  assert.deepEqual(style(spec(81)), { italic: ['bar', 'baz'], bold: ['Foo ', 'bar', 'baz'] });
  assert.deepEqual(style(spec(82)).italic, ['bar', 'baz']);
  assert.deepEqual(style('> quoted\nlazy **strong\nlazy** too\n'), { italic: [], bold: ['strong', 'lazy'] }, 'lazy lines');
  assert.deepEqual(style('[*x*] and [**y**]\n').italic, ['x'], 'a [label] restore with no definition');
  assert.deepEqual(style('[*x*] and [**y**]\n').bold, ['y']);
  assert.deepEqual(style('*one line*\n'), { italic: [], bold: [] }, 'nothing where the grammar paints it');
});

test('proseMarks: a `\\` that ends a paragraph, a heading or a cell is literal, in its register', () => {
  const lit = (text) => {
    const p = md.proseMarks(text);
    return [tonesOf(text, p), sel(text, p.bold), sel(text, p.linkStruck)];
  };
  assert.deepEqual(lit(spec(644)), [['\\=prose'], [], []]);
  assert.deepEqual(lit(spec(646)), [['\\=emphasis'], ['\\'], []], 'a heading: bold');
  assert.deepEqual(lit('> quoted\\\n'), [['\\=quote'], [], []]);
  assert.deepEqual(lit('| a | b\\\n|---|---|\n| c | d\\\n'), [['\\=emphasis', '\\=prose'], ['\\'], []], 'the last cell of a header and a body row');
  assert.deepEqual(lit('- [x] done\\\n'), [['\\=struck'], [], ['\\']], 'a done task: struck');
  assert.deepEqual(lit('Two\\\nlines\\\n')[0], ['\\=prose'], 'a hard break before the last line stays the grammar\'s');
  assert.deepEqual(lit('foo\\\\\n')[0], [], 'an escaped backslash');
  assert.deepEqual(lit('foo\\\\\\\n')[0], ['\\=prose'], 'an escaped backslash, then a literal one');
  assert.deepEqual(lit('foo\\  \n')[0], [], 'spaces after it: no hard break in the grammar either');
  assert.deepEqual(lit('### foo\\ ###\n')[0], [], 'a closing sequence after it');
  assert.deepEqual(tonesOf('Title\\\n===\n'), ['Title\\=emphasis'], 'a setext heading paints its text once');
});

test('proseMarks: a URL in struck text or a done task keeps the line-through', () => {
  const struck = (text) => sel(text, md.proseMarks(text).linkStruck);
  assert.deepEqual(struck('~~see https://example.com/old and [old](https://example.com/x)~~ now\n'),
    ['https://example.com/old', 'https://example.com/x'], 'in ~~…~~ the grammar strikes the target too');
  assert.deepEqual(struck('- [x] see [the docs](https://example.com/docs) and https://example.com/bare\n'),
    ['https://example.com/bare'], 'in a done task the target is a sigil, unstruck');
  assert.deepEqual(struck('- [x] mail <irc://x.example/y> or <me@example.com>\n'), ['irc://x.example/y', 'me@example.com'], 'autolinks');
  assert.deepEqual(struck('~~https://example.com/old~~ and https://example.com/new\n'), ['https://example.com/old'],
    'the link computer takes the closing tildes, which stay unstruck sigils');
  assert.deepEqual(struck('- [ ] open https://example.com/a\n\nplain https://example.com/b\n'), [], 'nothing outside struck text');
});

test('proseMarks: bare links keep the grammar\'s paint exactly where its bare-link patterns find them', () => {
  const text = 'Title ftp://f.example.com/x and me@example.com\n===\n\n> quoted\nlazy www.example.com and //cdn.example.com/a and mailto:a@b.io\n';
  assert.deepEqual(tonesOf(text), ['Title =emphasis', ' and =emphasis', 'lazy www.example.com and =quote', ' and =quote'],
    'ftp://, an email, //host and mailto: are links; www. is text');
});

test('bareLinks and detectedUrls agree with VS Code line by line (test/fixtures/markdown-links.json)', () => {
  const { lines } = require('./fixtures/markdown-links.json');
  const cm = require('../out/commonmark');
  const lk = require('../out/linkify');
  assert.ok(lines.length >= 28);
  for (const { line, linkify, detected } of lines) {
    const inl = cm.parseInline(line, new Set());
    const taken = [...inl.opaque, ...inl.links.map((l) => ({ start: l.open, end: l.end }))];
    const bare = md.proseBareLinks(line, inl).filter((b) => !taken.some((t) => b.start < t.end && b.end > t.start));
    assert.deepEqual(sel(line, bare), linkify, `linkify: ${line}`);
    assert.deepEqual(sel(line, lk.detectedUrls(line)), detected, `link computer: ${line}`);
  }
  assert.deepEqual(sel('a https://x.example/a\r\nb', lk.detectedUrls('a https://x.example/a\r\nb')), ['https://x.example/a'], 'a CRLF line ends before its \\r');
});

test('proseMarks stays linear in a document and in a pile of brackets', () => {
  const { growth } = require('./cpu-time');
  const unit = '## Notes\n\nA [WIP] item, a [ref][r] link, **[bold]** and `[code]`.\n\n> quote\nlazy *em\nlazy* end\\\n\nSetext\n  ---\n\n===\n\n- [x] ~~https://example.com/a~~\n\n[r]: https://example.com\n\n';
  for (const [name, make] of [['document', (n) => unit.repeat(n)], ['brackets', (n) => '[a '.repeat(n * 20)], ['labels', (n) => '[a][b] '.repeat(n * 10)],
    ['struck links', (n) => '~~a https://example.com/x b~~ '.repeat(n * 10)]]) {
    const ratio = growth((n) => make(n), (t) => md.proseMarks(t), 200);
    assert.ok(ratio < 24, `${name}: 8x the document cost ${ratio.toFixed(1)}x`);
  }
});
