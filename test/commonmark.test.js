'use strict';
// The CommonMark block and inline scanner (src/commonmark.ts) against the spec's own
// examples: test/fixtures/commonmark/ holds every CommonMark 0.31.2 example and the GFM
// table and strikethrough ones, as data. docs/markdown.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cm = require('../out/commonmark');
const SPEC = require('./fixtures/commonmark/spec-0.31.2.json').examples;
const GFM = require('./fixtures/commonmark/gfm-extensions.json').examples;

const count = (s, re) => (s.match(re) || []).length;

/**
 * What the spec's HTML says about an example, as counts the scanner must reproduce. Tags
 * the markdown itself holds are raw HTML passed through, so they are not counted; a
 * table cell counts only with content.
 */
function fromHtml({ markdown: m, html: h }) {
  const raw = (re) => count(m, re) > 0;
  return {
    headings: raw(/<h[1-6]>/) ? null : [...h.matchAll(/<h([1-6])>/g)].map((x) => +x[1]).join(','),
    quotes: count(h, /<blockquote>/g) - count(m, /<blockquote>/g),
    links: [...h.matchAll(/<a href="([^"]*)"/g)].filter((x) => !m.includes(`<a href="${x[1]}"`)).length,
    images: count(h, /<img src/g) - count(m, /<img src/g),
    em: count(h, /<em>/g) - count(m, /<em>/g),
    strong: count(h, /<strong>/g) - count(m, /<strong>/g),
    del: count(h, /<del>/g) - count(m, /<del>/g),
    th: raw(/<t[hd][ >]/) ? null : count(h, /<th(?: [^>]*)?>[^<]/g),
    td: raw(/<t[hd][ >]/) ? null : count(h, /<td(?: [^>]*)?>[^<]/g),
  };
}

/** The same counts from the scanner. Links and emphasis inside an image's alt text render as text. */
function fromScanner(text) {
  const b = cm.parseBlocks(text);
  const got = { headings: b.headings.join(','), quotes: b.quotes, links: 0, images: 0, em: 0, strong: 0, del: 0, th: 0, td: 0 };
  for (const r of b.regions) {
    if (r.kind === 'th' || r.kind === 'td') got[r.kind]++;
    const inl = cm.parseInline(cm.joinSegs(text, r.segs).v, b.defs);
    const imgs = inl.links.filter((l) => l.image);
    const inImg = (a, z, self) => imgs.some((i) => i !== self && a >= i.textStart && z <= i.textEnd);
    got.images += imgs.filter((l) => !inImg(l.open, l.end, l)).length;
    got.links += inl.links.filter((l) => !l.image && !inImg(l.open, l.end)).length;
    got.links += inl.autolinks.filter((a) => !inImg(a.start, a.end)).length;
    for (const e of inl.emph) if (!inImg(e.start, e.end)) got[e.kind]++;
  }
  return got;
}

// VS Code's front matter plugin takes a closed `---` block at the very start, so example 96
// is a front matter block and one heading in the preview, not the spec's two.
const PREVIEW_DIFFERS = { 96: { headings: '2' } };

test('every CommonMark 0.31.2 example: headings, quotes, links, images, emphasis and table cells as the spec renders them', () => {
  assert.equal(SPEC.length, 652);
  const bad = [];
  for (const ex of SPEC) {
    const want = { ...fromHtml(ex), ...PREVIEW_DIFFERS[ex.example] };
    const got = fromScanner(ex.markdown);
    for (const k of Object.keys(want)) if (want[k] !== null && want[k] !== got[k]) bad.push(`${ex.example} (${ex.section}) ${k}: want ${want[k]}, got ${got[k]}`);
  }
  assert.deepEqual(bad, []);
});

test('the GFM table and strikethrough examples', () => {
  assert.equal(GFM.length, 10);
  for (const ex of GFM) assert.deepEqual(fromScanner(ex.markdown), { ...fromScanner(ex.markdown), ...Object.fromEntries(Object.entries(fromHtml(ex)).filter(([, v]) => v !== null)) }, `gfm ${ex.example}`);
});

// ── setext headings ─────────────────────────────────────────────────────────

const ex = (n) => SPEC.find((e) => e.example === n).markdown;
const regionText = (text, r) => r.segs.map((s) => text.slice(s.start, s.end));
const setexts = (text) => cm.parseBlocks(text).regions.filter((r) => r.kind === 'setext').map((r) => [r.level, ...regionText(text, r)]);

test('setext headings: the content lines above the underline, with their level (spec 80-106)', () => {
  assert.deepEqual(setexts(ex(80)), [[1, 'Foo *bar*'], [2, 'Foo *bar*']]);
  assert.deepEqual(setexts(ex(81)), [[1, 'Foo *bar', 'baz*']], 'multi-line content');
  assert.deepEqual(setexts(ex(82)), [[1, 'Foo *bar', 'baz*']], 'surrounding whitespace is not content');
  assert.deepEqual(setexts(ex(83)), [[2, 'Foo'], [1, 'Foo']], 'any underline length');
  assert.deepEqual(setexts(ex(84)), [[2, 'Foo'], [2, 'Foo'], [1, 'Foo']], 'up to three spaces of indent');
  assert.deepEqual(setexts(ex(85)), [], 'four spaces is code');
  assert.deepEqual(setexts(ex(86)), [[2, 'Foo']], 'an indented underline with trailing spaces');
  assert.deepEqual(setexts(ex(87)), [], 'an underline indented four spaces is a paragraph continuation');
  assert.deepEqual(setexts(ex(88)), [], 'no spaces inside an underline');
  assert.deepEqual(setexts(ex(89)), [[2, 'Foo']], 'trailing spaces are not content');
  assert.deepEqual(setexts(ex(90)), [[2, 'Foo\\']]);
  assert.deepEqual(setexts(ex(91)), [[2, '`Foo'], [2, '<a title="a lot']], 'the underline wins over a code span or a tag');
  assert.deepEqual(setexts(ex(92)), [], '`---` under a block quote line is a thematic break');
  assert.deepEqual(setexts(ex(93)), [], 'a lazy line cannot be underlined');
  assert.deepEqual(setexts(ex(94)), [], '`---` under a list item is a thematic break');
  assert.deepEqual(setexts(ex(95)), [[2, 'Foo', 'Bar']], 'a paragraph continuation is content');
  assert.deepEqual(setexts(ex(96)), [[2, 'Bar']], 'front matter, then a heading (VS Code; the spec has an hr and two)');
  assert.deepEqual(setexts(ex(97)), [], 'no paragraph above `====`');
  assert.deepEqual(setexts(ex(98)), [], '`---` with no paragraph above is a thematic break');
  assert.deepEqual(setexts(ex(99)), [], 'a list item');
  assert.deepEqual(setexts(ex(100)), [], 'indented code');
  assert.deepEqual(setexts(ex(101)), [], 'a block quote');
  assert.deepEqual(setexts(ex(102)), [[2, '\\> foo']], 'an escaped quote marker');
  assert.deepEqual(setexts(ex(103)), [[2, 'bar']], 'only the paragraph right above');
  assert.deepEqual(setexts(ex(104)), [], 'a blank line in between');
  assert.deepEqual(setexts(ex(105)), [], '`* * *` is a thematic break');
  assert.deepEqual(setexts(ex(106)), [], 'an escaped underline');
  assert.deepEqual(setexts('```\nfoo\n```\n---\n'), [], 'under a fence');
});

test('setext headings: refdefs above the underline are not content, and front matter is front matter', () => {
  assert.deepEqual(setexts(ex(215)), [[1, 'bar']]);
  assert.deepEqual(setexts(ex(216)), [], 'nothing but a definition above `===`: a paragraph');
  assert.deepEqual(setexts('---\ntitle: x\n---\nFoo\n---\n'), [[2, 'Foo']]);
  assert.deepEqual(cm.parseBlocks('---\ntitle: x\n---\n').frontMatter, { start: 0, end: 16 });
  assert.equal(cm.parseBlocks('---\ntitle: x\n').frontMatter, null, 'an unclosed fence is no front matter');
  assert.equal(cm.parseBlocks(' ---\nx\n---\n').frontMatter, null, 'only at column 0 of the first line');
});

test('setext headings: inside a block quote and a list item', () => {
  const text = '> Foo\n> ===\n\n- Bar\n  ---\n';
  const got = cm.parseBlocks(text).regions.filter((r) => r.kind === 'setext');
  assert.deepEqual(got.map((r) => [r.level, r.quote, ...regionText(text, r)]), [[1, true, 'Foo'], [2, false, 'Bar']]);
});

test('setext headings: the underline is the marker run, after container prefixes and before trailing space', () => {
  const underlines = (text) => cm.parseBlocks(text).regions.filter((r) => r.kind === 'setext').map((r) => text.slice(r.underline.start, r.underline.end));
  assert.deepEqual(underlines(ex(84)), ['---', '-----', '===']);
  assert.deepEqual(underlines(ex(86)), ['----']);
  assert.deepEqual(underlines('> Foo\n> ---\n\n- Bar\n  ===\n'), ['---', '===']);
  assert.ok(cm.parseBlocks('Foo\n\nbar\n').regions.every((r) => r.underline === null), 'other regions have none');
});

test('a table header with a matching delimiter row is a table, not a setext heading', () => {
  const kinds = (text) => cm.parseBlocks(text).regions.map((r) => `${r.kind}:${regionText(text, r).join('/')}`);
  assert.deepEqual(kinds('| a |\n---\n'), ['th:a']);
  assert.deepEqual(kinds('a | b\n---\n'), ['setext:a | b'], 'two header cells, one delimiter cell');
  assert.deepEqual(kinds('x\n| a | b |\n|---|---|\n| 1 | 2 |\n'), ['paragraph:x', 'th:a', 'th:b', 'td:1', 'td:2']);
  assert.deepEqual(kinds('| a |\n|---|\n| 1 |\n> q\n'), ['th:a', 'td:1', 'paragraph:q'], 'a block quote ends the table');
});

// ── link reference definitions ──────────────────────────────────────────────

const defsOf = (text) => [...cm.parseBlocks(text).defs].sort();

test('link reference definitions per the spec (examples 192-218)', () => {
  assert.deepEqual(defsOf(ex(192)), ['FOO']);
  assert.deepEqual(defsOf(ex(193)), ['FOO'], 'destination and title on later lines');
  assert.deepEqual(defsOf(ex(194)), ['FOO*BAR\\]'], 'a backslash escape stays in the label');
  assert.deepEqual(defsOf(ex(195)), ['FOO BAR'], 'a pointy destination on the next line');
  assert.deepEqual(defsOf(ex(196)), ['FOO'], 'a title over several lines');
  assert.deepEqual(defsOf(ex(197)), [], 'a title cannot hold a blank line');
  assert.deepEqual(defsOf(ex(198)), ['FOO'], 'the destination on the next line');
  assert.deepEqual(defsOf(ex(199)), [], 'no destination');
  assert.deepEqual(defsOf(ex(200)), ['FOO'], 'an empty pointy destination');
  assert.deepEqual(defsOf(ex(201)), [], 'text after a pointy destination');
  assert.deepEqual(defsOf(ex(202)), ['FOO'], 'escapes in destination and title');
  assert.deepEqual(defsOf(ex(206)), ['ΑΓΩ'], 'Unicode case');
  assert.deepEqual(defsOf(ex(208)), ['FOO'], 'a label over several lines');
  assert.deepEqual(defsOf(ex(209)), [], 'text after the title');
  assert.deepEqual(defsOf(ex(210)), ['FOO'], 'a title on the next line with text after it is no title');
  assert.deepEqual(defsOf(ex(211)), [], 'indented code');
  assert.deepEqual(defsOf(ex(212)), [], 'a fence');
  assert.deepEqual(defsOf(ex(213)), [], 'a definition cannot interrupt a paragraph');
  assert.deepEqual(defsOf(ex(217)), ['BAR', 'BAZ', 'FOO'], 'several in a row');
  assert.deepEqual(defsOf(ex(218)), ['FOO'], 'inside a block quote');
  assert.deepEqual(defsOf('[Foo\n  bar]: /url\n'), ['FOO BAR'], 'whitespace collapses');
  assert.deepEqual(defsOf('[ẞ]: /url\n'), ['SS'], 'Unicode case fold');
  assert.equal(defsOf(`[${'a'.repeat(999)}]: /u\n`).length, 1, '999 characters');
  assert.deepEqual(defsOf(`[${'a'.repeat(1000)}]: /u\n`), [], '1000 is too long');
});

// ── links ───────────────────────────────────────────────────────────────────

/** Each link as [kind, its text], from the first region. */
function linksOf(text) {
  const b = cm.parseBlocks(text);
  const r = b.regions[0];
  const { v } = cm.joinSegs(text, r.segs);
  return cm.parseInline(v, b.defs).links.map((l) => [l.kind, v.slice(l.textStart, l.textEnd)]);
}

test('reference links: full, collapsed and shortcut, matched per CommonMark (spec 527-571)', () => {
  assert.deepEqual(linksOf(ex(527)), [['full', 'foo']]);
  assert.deepEqual(linksOf(ex(539)), [['full', 'foo']], 'case-insensitive');
  assert.deepEqual(linksOf(ex(540)), [['shortcut', 'ẞ']], 'Unicode case fold');
  assert.deepEqual(linksOf(ex(541)), [['full', 'Baz']], 'whitespace collapses');
  assert.deepEqual(linksOf(ex(542)), [['shortcut', 'bar']], 'no space between text and label');
  assert.deepEqual(linksOf(ex(545)), [], 'a backslash escape is not unescaped for matching');
  assert.deepEqual(linksOf(ex(546)), [], 'no bracket in a label');
  assert.deepEqual(linksOf(ex(553)), [['collapsed', 'foo']]);
  assert.deepEqual(linksOf(ex(557)), [['shortcut', 'foo']]);
  assert.deepEqual(linksOf(ex(563)), [], 'an escaped opener');
  assert.deepEqual(linksOf(ex(568)), [['shortcut', 'foo']], 'a failed inline link falls back to a shortcut');
  assert.deepEqual(linksOf(ex(569)), [['full', 'bar']]);
  assert.deepEqual(linksOf(ex(570)), [['full', 'foo'], ['shortcut', 'baz']]);
  assert.deepEqual(linksOf(ex(571)), [['full', 'bar']]);
  assert.deepEqual(linksOf(ex(532)), [['inline', 'bar'], ['shortcut', 'ref']], 'links do not nest');
});

test('code spans, autolinks and raw HTML bind tighter than brackets (spec 536-538)', () => {
  assert.deepEqual(linksOf(ex(536)), []);
  assert.deepEqual(linksOf(ex(537)), []);
  assert.deepEqual(linksOf(ex(538)), []);
});

// ── block quotes ────────────────────────────────────────────────────────────

const lazyOf = (text) => cm.parseBlocks(text).regions.flatMap((r) => r.segs.filter((s) => s.lazy).map((s) => text.slice(s.start, s.end)));

test('lazy continuation lines of a block quote (spec 232-250)', () => {
  assert.deepEqual(lazyOf(ex(232)), ['baz']);
  assert.deepEqual(lazyOf(ex(233)), ['baz']);
  assert.deepEqual(lazyOf(ex(234)), [], 'a thematic break is no continuation');
  assert.deepEqual(lazyOf(ex(235)), [], 'nor a list item');
  assert.deepEqual(lazyOf(ex(247)), ['baz']);
  assert.deepEqual(lazyOf(ex(250)), ['bar'], 'nested quotes');
  assert.deepEqual(lazyOf(ex(292)), ['continued here.'], 'inside a list item');
});

// ── cost ────────────────────────────────────────────────────────────────────

test('parseBlocks and parseInline stay linear on documents and on bracket, delimiter and backtick pile-ups', () => {
  const { growth } = require('./cpu-time');
  const doc = '# Title\n\nProse with a [link](https://example.com), a [WIP] tag, *em* and `code`.\n\n> quote\nlazy\n\nSetext\n---\n\n[ref]: /u\n\n';
  const scan = (text) => {
    const b = cm.parseBlocks(text);
    for (const r of b.regions) cm.parseInline(cm.joinSegs(text, r.segs).v, b.defs);
  };
  for (const [name, unit] of [['document', doc], ['brackets', '[a '], ['links', '[a](b) [c] '], ['delimiters', '*a _b '], ['backticks', '`` ` '], ['html', '<!-- <a '], ['titles', '[a](b "c ']]) {
    const ratio = growth((n) => (name === 'document' ? unit.repeat(n) : unit.repeat(n * 20)), scan, 200);
    assert.ok(ratio < 24, `${name}: 8x the input cost ${ratio.toFixed(1)}x`);
  }
});
