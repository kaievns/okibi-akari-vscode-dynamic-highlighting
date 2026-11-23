# Markdown prose restores

A TextMate rule sees one line and no link definitions. The bundled markdown
grammar therefore paints every `[x]` as a link, paints a setext heading's text as
prose, misses an underline its `^={3,}` rule cannot see and paints a block quote's
lazy line as unquoted, among the rest of this page. The preview's markdown-it
parses the whole document and shows each as CommonMark has it. `proseMarks`
(`src/markdown.ts`) repaints them from a CommonMark parse of the document
(`src/commonmark.ts`). They are band 1: never phase-bound, painted in
every visible editor of the document. Tests: `test/commonmark.test.js`,
`test/markdown.test.js`, the markdown tests in `test/render.test.js` and the
`walk.md` steps of the prose walks in `test/transitions.test.js`.

## What changes

| Construct | Editor before | Preview | Editor now |
|---|---|---|---|
| `[WIP]`, `[optional]`, `[1]` with no matching definition | link: `[` `]` n7, label sora | text | the text around it: n10, n9 in a quote, n11 in a heading or `**…**`, n8 struck in `~~…~~` or a done task |
| a reference link's label: `[ref]`, `[ref][]`, `[text][ref]` | sora, underlined by the markdown server's link | sora, no underline | sora, no underline |
| a definition's label: `[ref]: url` | underlined when the server reads it as a link | hidden | no underline |
| a setext heading's text, the line or lines above `===` / `---` | prose n10 | heading | n11, bold; emphasis sigils stay light |
| a setext underline the grammar cannot see: `=`, `==`, indented, in a quote or a list item | prose | hidden | n7 |
| a `===` line that heads no heading (spec 97, 216) | n7, the grammar's underline | text | the text around it |
| a block quote's lazy line (`> a` then `b`) | prose n10 | quote | n9 |
| emphasis across the lines of a setext heading or of lazy lines | no italic, no bold | emphasis | italic or bold |
| a `\` that ends a paragraph, a heading or a table cell | n7, a hard break | literal | the text around it, bold in a heading, struck in a done task |
| a reference link the grammar misses: a label with spaces, a link over two lines | prose | link | link text sora, brackets n7 |
| a URL in `~~…~~` or a done task's text | the line-through dropped with the underline | struck | struck, no underline |

Footnote markers `[^x]`, task boxes `[ ]` / `[x]`, wikilinks `[[x]]` and callout
types `[!note]` are the theme's injections and are left alone. So is a setext
underline at the start of its line, three or more long: the theme paints it.

Labels match as CommonMark matches them: case-folded (`ẞ` matches `SS`),
whitespace collapsed, a backslash escape kept as written (`[foo\!]` does not match
`[foo!]:`), at most 999 characters. A definition counts anywhere CommonMark reads
one: in a block quote or list item, over several lines, never inside a fence,
indented code or a paragraph it would interrupt.

## Register

Each restore is a colour-only decoration, so the grammar's weight, italic and
line-through stay. The values are the theme's markdown rules (`scripts/md_rules.js`
there), equal to its `scripts/spec/tokens.json` on 2026-11-23.

| Tone | Token | Okibi | Akari | Pool type |
|---|---|---|---|---|
| sigil | n7 | `#585b5f` | `#b5b0a9` | `mdSigil` |
| struck | n8 | `#707376` | `#8d8982` | `mdStruck` |
| quote | n9 | `#8f9296` | `#6c6863` | `mdQuote` |
| prose | n10 | `#bbbec1` | `#403d38` | `mdProse` |
| emphasis | n11 | `#e1e3e5` | `#13110e` | `mdEmphasis` |
| link | call | `#6eaff7` | `#015ba6` | `mdLinkText` |
| code | syn-member | `#a2bedb` | `#516f8e` | `mdCode` |

`mdBold` and `mdItalic` add the weight and the slant: a setext heading's text, and
restored text inside CommonMark emphasis. Akari's link sora is not the `call` blue in
`TOKENS` (`#005eac`), hence `TOKENS.mdLink`.

The tone of a restored character follows the theme's register for its CommonMark
parse: n10, then n9 in a quote or footnote definition, then n11 in a heading,
table header, emphasis or `==highlight==`, then n8 in strikethrough or a done task.
Link text is sora, n8 in a done task.

## Where it paints

Only where the grammar and CommonMark disagree. The grammar's link rules are
emulated per line (`grammarLinks`): `link-def`, `link-inline`, `link-ref`,
`link-ref-literal`, `link-ref-shortcut`, `image-inline` and `image-ref`, in its
order, after its escapes, code spans, autolinks and tags. A grammar match and a
CommonMark link over the same span are the same link and get nothing; every other
grammar match and every other CommonMark link is the paint domain. A code span,
autolink, tag or link that the domain reaches into joins it whole. Inside the
domain, CommonMark text takes its tone, syntax (brackets, a URL, an emphasis
delimiter, an escape's backslash) takes n7, link text and a full reference's
label take sora, code takes member steel, and raw HTML and images are left alone.

A setext heading's content lines, a lazy line and a `===` line that is text are
painted whole: their CommonMark text takes the tone, with the italic or bold of its
emphasis, their emphasis delimiters n7; code spans, links, an escape's backslash and
bare links keep the grammar's paint. A bare link is what the theme's `bare-link`
injection paints, found with the same patterns (`src/linkify.ts`, from linkify-it 5's
parts as the theme's `scripts/md_linkify.js` composes them), in each line and in each
`~~…~~`'s content, which the grammar's strikethrough rule scans as a line of its own.
`test/fixtures/markdown-links.json` holds them to VS Code's markdown-it on 28 lines.

The literal `\` at the end of a block needs no inline parse: the last line's end
says it, and the grammar's `\\$` paints every one n7.

## The underline

VS Code underlines a link the markdown server reports and a URL its link computer
(`vs/editor/common/languages/linkComputer.ts`) finds. The markdown server reports,
for VS Code 1.147.0 (measured with its own `MdLinkProvider` on 2026-11-23):

| Source | Link range |
|---|---|
| `[text][ref]` | `ref` |
| `[text][]`, `[text]` | `text` |
| a reference with no definition the server knows | none |
| `[foo]: ` with the URL on the next line | `foo` and an empty href |
| `<irc://…>`, `<ftp://…>`, `<mailto:…>`, `<localhost:5001/…>` | its URL |
| `<me@example.com>`, `<made-up:x>` | none; the cancel covers them, to no effect |
| `[text](url)` | `url` |

The link computer underlines `http://`, `https://` and `file://` URLs in any text,
code included, to its own end: a `)` it has seen opened, a trailing `.` or `,`
dropped. A bare `ftp://`, `//host`, `mailto:` or email, which the preview links, gets
no underline.

`linkSpans` covers each of them outside code: an inline link's or image's target,
every CommonMark autolink whose `<` is in no code span, the link computer's URLs
(`detectedUrls`, its port), and each definition's URL. mdLinkPlain also covers each
CommonMark reference link's text and label, each definition's label and the whole
paint domain: a definition the server accepts and CommonMark does not
(`[foo]: /url "title" ok`) still underlines `[foo]` elsewhere. In struck text the
same ranges take `mdLinkStruck` (`line-through !important`) instead, since `none`
would also drop the line: all of them in `~~…~~`, which the grammar strikes whole,
and in a done task's text all but an inline link's target, which the theme keeps an
unstruck sigil there.

`linkSpans` is one pass. Its inline-link scan reads `[` to the first `]` no escape
holds, as the pattern it replaced, `!?\[(?:[^\]\\]|\\.)*\]\(`, did from every
`[`: a pile of unclosed brackets cost that pattern 767 ms at 16,000.

## CommonMark

`src/commonmark.ts` ports cmark's block algorithm (container matching with tab
columns, lazy continuation, the block starts in cmark's order, definitions taken
off a paragraph's start when it closes or meets a setext underline) and its inline
bracket and delimiter passes (code spans, autolinks and raw HTML first, the
bracket stack with link deactivation, the rule of three). Where the preview
differs from the spec it follows the preview:

- **Front matter**: `---` alone on the first line, closed by the next `---` alone,
  is front matter, as VS Code's plugin reads it. An unclosed one is not.
- **Tables**: markdown-it's, which win over a setext underline: `| a |` over `---`
  is a table, `a | b` over `---` (two cells, one) a heading.
- **Strikethrough**: `~~` pairs only, as markdown-it's.

`test/commonmark.test.js` checks every CommonMark 0.31.2 example and the 10 GFM
table and strikethrough examples (`test/fixtures/commonmark/`, sha256
`d431b29d…` and `7d8e5814…`, the same pins as the theme's
`scripts/md_editor_preview_diff.js`) against the spec's HTML: heading levels,
block quotes, links, images, emphasis, strong, strikethrough and table cells.
All 652 match but example 96, where the front matter rule makes the preview's one
heading of the spec's two.

## Parity audit

The theme's `scripts/md_editor_preview_diff.js` models these marks. Over its
examples (CommonMark, GFM, the theme's extras and five realistic documents), both
working trees of 2026-11-23, before and after the underline, `===`, emphasis style,
trailing `\`, struck link and autolink changes on this page:

| Verdict | Before (770) | After (777) |
|---|---|---|
| match | 583 | 610 |
| editor-misparse | 162 | 149 |
| mismatch | 21 | 9 |
| preview-wrong | 0 | 0 |
| expected-difference | 4 | 9 |

20 examples improved to a match, none regressed, and the 7 added for these changes
match. The theme's audit now counts the label behind a footnote's number as an
expected difference, which moved 6. Per section, as misparse / mismatch / match:

| Section | Before | After |
|---|---|---|
| Setext headings | 6 / 1 / 20 | 0 / 0 / 27 |
| Thematic breaks | 0 / 1 / 18 | 0 / 0 / 19 |
| Autolinks | 4 / 2 / 13 | 4 / 0 / 15 |
| Hard line breaks | 4 / 2 / 9 | 4 / 0 / 11 |
| Code spans | 7 / 2 / 13 | 7 / 1 / 14 |
| Autolinks (GFM) | 1 / 1 / 9 | 1 / 0 / 10 |
| Extras: link | 0 / 2 / 13 | 0 / 0 / 16 |

In Links, 532 and 533 are the audit's alignment: the editor paints the literal `]`
as the preview does, and the audit matches the preview's `]` to the inner link's
closing bracket instead.

## Not covered

- **Emphasis across lines in any other paragraph.** `*foo` then `bar*` (spec 394,
  405, 423, 432, 638, 639) keeps the grammar's paint, delimiters prose and no italic: only a setext
  heading's, a lazy line's and a `===` line's text is painted whole.
- **A definition the grammar cannot read** (over several lines, examples
  193-198, 208, 217): the preview hides it, the editor paints its label sora and
  the rest as prose.
- **Raw HTML inside a restore** (`[foo <bar attr="][ref]">`) keeps the grammar's
  paint.
- **A URL in a code span** keeps the link computer's underline, as `linkSpans`
  leaves code alone.

## Cost

A 155 KB file on an Apple M3 Pro, best of 9, for what `renderMarkdownMarks` computes
once per document version, against the same inputs before this page's last changes:

| Input | Scans (wash, underline) | `proseMarks` | All |
|---|---|---|---|
| `samples/sample.md` repeated | 2.3 → 1.5 ms | 2.7 → 3.3 ms | 5.5 → 5.1 ms |
| `docs/*.md` joined | 3.7 → 1.2 ms | 3.2 → 3.5 ms | 6.5 → 4.5 ms |

The decorator now runs `linkSpans` once rather than twice, in one pass; `proseMarks`
pays for its bare-link scan and the regions it parses for the new restores. Runs moved
by up to 0.6 ms between repeats. A paragraph with no `[`, no setext underline, no lazy
line, no `===` line and no link in struck text skips the inline pass. `parseBlocks`,
`parseInline`, `proseMarks`, `linkSpans` and `highlightSpans` stay linear on pile-ups of
brackets, labels, delimiters, backticks, HTML openers, titles, escapes and marks:
16,000 unclosed `[a ` cost `linkSpans` 0.45 ms, where its old pattern took 865 ms.
