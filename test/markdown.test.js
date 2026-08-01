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
// the sample sweep is part of the gate now.

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
