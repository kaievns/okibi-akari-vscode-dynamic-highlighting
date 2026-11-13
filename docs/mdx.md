# MDX

An MDX document is prose: no blocks, no bands, no server request, the phase held
in Survey. Its prose links lose `editor.links`' underline, as a markdown file's do;
it takes no `==highlight==` wash. `src/mdx.ts` finds its code; tests:
`test/markdown.test.js`, the MDX test in `test/render.test.js` and the MDX walks in
`test/transitions.test.js`.

## Id

`mdx` (`.mdx`), registered by `unifiedjs.vscode-mdx` 1.8.18, whose grammar is
`source.mdx`, and by `xyc.vscode-mdx-preview` 0.3.3. It is in `PROSE_LANGUAGES`
and `LINK_MARK_LANGUAGES`, not `MARKDOWN_LANGUAGES` (`src/focus.ts`).

## Why prose

The code in 349 public MDX files (263 from the tailwindcss.com repo, 50 from
graphql-js's site, 36 from mdx-js's docs; @mdx-js/mdx 3's own parse with
remark-frontmatter):

| Region | Count | With a function body |
|---|---|---|
| ESM, imports only | 319 | 0 |
| ESM with an export | 298 | 1 (2 lines) |
| `{…}` holding JSX | 597 | 0 |
| `{/* … */}` | 116 | 0 |
| other `{…}` | 18 | 7 (253 lines, 7 files) |

Band 2 traces data through a block; 8 of 1,348 regions hold one. The MDX
server (Volar) sends semantic tokens for the ESM and expressions (28 on the
theme repo's synthetic `doc.mdx`, VS Code 1.145.2, 2026-11-12); the layer asks it
nothing.

## Marks

The link cancel reads the document past markdown's code
(`codeSpans`) and MDX's (`mdxCodeSpans`): an ESM block from an `import` or
`export` at a line start to the first blank line where its JavaScript is closed
(one lex from the block's first line, stopped there: `closedLineBreak`),
a `{…}` expression to its matching `}` (`braceExpressionEnd`, JSX inside), and a
JSX tag from `<` before a letter, `>` or `/` to its `>`, quoted values and `{…}`
skipped. A tag's children are prose. A `\` escapes the next character.

The wash stays off: the theme scopes `==highlight==` by injecting into
`text.html.markdown` (`md-prose.injection.json`), which `source.mdx` does not
include, so in MDX the theme paints it as prose. The underline is the editor's
link detector, which reads every language, so the cancel applies. The theme
repo's real-editor `mdx` cell (VS Code 1.145.2, 2026-11-13) shows the cancel on
the prose link, and its 24 transition scenarios, 5 of them static, fail 0 checks;
the rerun with the one-lex ESM scan held its 400 survey values and all 24.

On the 349 files the MDX tree holds 1,579 links. Read as markdown, the cancel
would land on 1,587 prose link targets and 803 targets in code: 474 in
expressions, 284 in JSX attributes, 42 in ESM and 3 in fences. Read with
`mdxCodeSpans`, 1,587 in prose and 2 in code, both in a fence indented 10 spaces
inside a `<td>` (`docs/table-of-components.mdx`), which markdown's fence rule
does not see. Every tree link gets its cancel in both. No file holds a
`==highlight==`.

## Known limits

- **A fence indented inside a JSX element** past markdown's list rule is prose
  to the scanner: 2 link targets in 1 of 349 files.
- **Indented code** does not exist in MDX; markdown's 4-space rule still reads it
  as code, so a mark there is missed, never misplaced.
- **An ESM statement left open** (a `}` deleted, a partial paste, a `{` typed
  before text where autoclose does not fire) makes the rest of the document ESM,
  as MDX's own parser reads it: it takes lines until the JavaScript parses. The
  prose marks drop until the bracket closes. The cost stays one lex: graphql-js's
  `api-v17/type.mdx` (339 KB, 2,905 blank lines) takes 3.0 ms as it is and 3.7 ms
  with `export const meta = {` on top, where a lex per blank line took 4,563 ms.
  The 349 public files take 19.6 ms in all, the slowest 1.4 ms (best of 5, Apple
  M3 Pro, Node 26.13). `test/markdown.test.js` holds the growth check.
- **A JSX element in an ESM statement** that spans a blank line keeps the block
  open to its closing tag, which is MDX's reading. None of the 349 files has one:
  every span they produce is the same as under the earlier lex per blank line.
