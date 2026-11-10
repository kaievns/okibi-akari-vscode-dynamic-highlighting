# Okibi & Akari — Dynamic Highlighting

The dynamic layer for the [Okibi / Akari](https://kaievns.github.io/okibi-akiri-design-system-spec/)
design system. The colour theme paints **band 1** (the resting register — always
on). This extension adds the stateful part of the doctrine: the three-phase
attention model.

> **Survey 構** (viewing) → **Focus 流** (reading) → **Edit 異** (writing)
>
> Cumulative supersets: each phase only *adds* a layer. Transitions are cuts,
> never fades. Calm at rest is a hard requirement.

## What each phase shows

| Phase | Shown |
|---|---|
| **Survey 構** | band 1 only — indicator withdrawn, no tints, no risk marks |
| **Focus 流** | + gutter stripe on the focused block, + **band 2** identity tints, + clay numbers |
| **Edit 異** | + **band 3** risk marks (async, danger, escaping writes) |

Edit relaxes to Focus after 2 s of no typing; Focus relaxes to Survey after 24 s
of no caret activity. Both are cuts, hysteresis-guarded against flicker.

## Band 2 · identity tints

Data identities in the focused block get a hue from a pool of five, so you can
trace a value by colour while reading. Function/method names, type names, struct
fields, builtins and keywords stay band-1 — only **data** is tinted. Locals and
captures paint at normal weight; globals paint the same hue in bold. The five tints share
one chroma and an even perceived lightness, and each clears 4.5:1 on the editor
ground: [docs/palette.md](docs/palette.md).

Hues are assigned by a **two-pass, history-free** algorithm (`src/scopecolor.ts`):

1. **Visibility** — per block, rank candidates by attention priority (the block's
   own locals first, then borrowed-in, then nested-scope; frequency within tier)
   and keep the top *K*.
2. **Identity** — build a graph over the colour scope where an edge means two
   names are *co-visible in some block*, then greedy-colour it.

This gives three properties the earlier stateful approach could not:

- **Deterministic** — colours depend only on the document, never on the order you
  navigated. Same code, same colours, always.
- **Stable across siblings** — a shared parent variable is one graph vertex, so it
  holds one hue as you move between sibling blocks.
- **Small palette, big functions** — two names never on screen together share no
  edge, so they may safely reuse a hue. That is what lets *K* hues cover a
  function with far more than *K* locals.

Full rules, including every language-specific edge case:
**[docs/classification-rules.md](docs/classification-rules.md)**.

## Band 3 · risk marks

Edit phase, focused block only (number-clay from Focus on: it is the engaged half
of band 1's number pair). Always shape + colour, never colour alone.

| Mark | Applies to |
|---|---|
| async cyan | `await` / `async`; none in Lua, Ruby or Zig, which have no such keyword (Zig 0.17's `.async(` and `.await(` are methods) |
| danger bold | casts and the `any` type, per language: TS `as` casts and `any` types; Rust, Kotlin, Swift and Dart `as` casts; Zig's pointer casts (`@ptrCast`, `@alignCast`, `@constCast`, `@intFromPtr`, `@ptrFromInt`, `@fieldParentPtr` and two more); nothing in Python, JavaScript, Go, Lua or Ruby |
| number-clay | numeric literals in the focused scope, suffix included (`123u32`, `1.0f`) |
| dashed underline | a **write that escapes the block**: an assignment, `++`/`--`, or member, subscript or deref write to a binding declared outside it. Declarations, named arguments, defaults and constructor `self`/`this` writes never mark. Needs semantic tokens: the heuristic fallback paints none |

The underline stays put while you type in the same block, and repaints when the
new classification lands. Rules, the Go decision and known limits:
[docs/risk-marks.md](docs/risk-marks.md).

Diagnostics (error undercurl, warning underdotted) are left to VS Code — never
double-painted.

## Token values that differ from the spec

The vendored spec in the theme repo (`scripts/spec/`) is an upstream copy and is
left unedited. These values deviate from it:

| Token | Spec (Okibi / Akari) | Here | Why |
|---|---|---|---|
| `--id-1` `--id-3` `--id-2` `--id-7` `--id-5` (band 2, pool order) | `#fa9d67 #a6a2fc #dbbe78 #cb94ec #f38bb7` / `#be642a #6b61c4 #9d7300 #8b50ad #b14577` | `#d88c60 #968ed9 #bf9e4a #bb86c7 #d481a4` / `#9e572c #5f5aa0 #8e6804 #84528f #9b4e6f` | Dimmed to one OKLCH chroma (0.110) with even perceived lightness; every Akari tint clears 4.5:1. Bold globals reuse these hexes, not `--idg-*`. [docs/palette.md](docs/palette.md) |
| `--risk-escape` | `#f57c5f` / `#bf3a16` (H35) | `#e0a26f` / `#a06024` (H60) | 11° from `editorError` read as a diagnostic; H60 sits 36° away. [docs/risk-marks.md](docs/risk-marks.md#style-and-colour) |

## Band 1 · marks the theme cannot paint

Not phase-bound, and not part of the attention model. These live here only
because a colour theme physically cannot express them.

| Mark | Why the theme can't do it |
|---|---|
| markdown `==highlight==` wash | `getClassNameFromMetadata` emits only `mtk<foreground>` plus four font-style bits. A token `background` is parsed and indexed, then **never rendered** in the DOM editor. See `src/markdown.ts`. |
| cancelling the link underline | The underline is the `editor.links` contrib decorating each link range with `inlineClassName: "detected-link"`, styled by the workbench stylesheet. It is not a token style, so no theme rule can reach it. |
| `self` / `this`, and Rust `Self` / `crate` / `super`, at keyword slate | Outside a cargo workspace rust-analyzer types a `self` use as `const`, `Self` as `struct` and `crate` / `super` as `namespace`, and a semantic token outranks the grammar. The three path keywords are painted until rust-analyzer types them as keywords; a cargo package sends the degraded answer too while it loads. ruby-lsp types Ruby's `self` `variable.defaultLibrary`; a Ruby `this` is a plain name, and `x.self` / `self:` are a method and a key. A JavaScript or TypeScript `self` is a plain name too; tsserver types a declaration file's `this` parameter (`f(this: Window)`) `parameter`. zls types Zig's `self` `parameter`, so it is painted in every server state; a Zig `this`, a member `.self` and a field or enum member `self` are names. Code files only, never inside comments, strings or docstrings. See [docs/runtime.md](docs/runtime.md#rust-path-keywords), [docs/ruby.md](docs/ruby.md#band-1-restores), [docs/javascript.md](docs/javascript.md#band-1-restores) and [docs/zig.md](docs/zig.md#band-1-restores). |
| Rust format placeholders | In a detached file, and in a cargo package until its workspace loads, rust-analyzer emits one `string` token over the whole literal, so `meta.interpolation.rust` never applies; a loaded workspace types the holes `formatSpecifier`, which the theme paints the same steel. Outside a raw string a backslash escape is one character, so `\u{2603}` is not a hole. See `src/placeholders.ts`. |
| Python f-string fields | The grammar gives a field's braces no `string` scope, so bracket-pair colorization paints them bracket grey over the theme. The braces, the `!r` conversion, the `:spec` and a self-documenting `=` are painted; the expression inside keeps its own colour. See `src/placeholders.ts`. |
| Ruby `#{` and `}` at member steel | Bracket-pair colorization paints the braces of an interpolation over the theme's rule, with or without ruby-lsp. The `#{` and `}` of every closed hole are painted; the expression inside keeps its own colours. See [docs/ruby.md](docs/ruby.md#band-1-restores). |
| JavaScript `${` and `}` at member steel | JavaScript's language configuration lists `${` `}` as a bracket pair and sets no `colorizedBracketPairs`, so bracket-pair colorization paints a template hole's delimiters over the theme's rule, with or without a server; TypeScript's leaves them out. The `${` and `}` of every closed hole are painted; the expression inside keeps its own colours. See [docs/javascript.md](docs/javascript.md#band-1-restores). |
| Lua format placeholders | Under `Lua.semantic.keyword`, lua-language-server sends one `string` token over each literal, so the theme's `string.format` placeholders turn string green. Painted while the document's last answer types its literals that way; under the default settings, and with no server, the theme paints them alone. The call shapes are the theme's: `string.format("…")`, the literal opening the line after a `string.format(` that ends its line, and `("…"):format(…)`. See [docs/lua.md](docs/lua.md#band-1-restores). |
| Zig format placeholders | Under `zig.zls.semanticTokens: full`, zls sends one `string` token over each literal, so the theme's `{d}` / `{s:>8}` placeholders turn string green. Painted while the document's last answer types its literals that way; under the default `partial`, and with no server, the theme paints them alone. The call shape is the theme's: a `"…"` literal right after `(` or `, ` whose `.{` arguments follow on its line. See [docs/zig.md](docs/zig.md#band-1-restores). |
| Go doc links in comment colour | gopls types `[Name]` in a comment as a code `variable` / `namespace` / `function` with no telling modifier. See [docs/runtime.md](docs/runtime.md#go-doc-links). |
| JSDoc brackets in comment colour (JavaScript, TypeScript) | Both grammars give a JSDoc type and `[name]` the token type `other`, so bracket-pair colorization paints `@param {string} [name]` at its level colours. Every bracket in a `/**` comment is painted. See [docs/javascript.md](docs/javascript.md#band-1-restores). |
| brackets in Rust comments in comment colour, and in Rust strings in string colour | After a theme change made while no editor showed the file, VS Code 1.144.1's bracket-pair colorization paints brackets in comments, strings and char literals at their level colour, over any theme rule. A bracket in a string is painted only where its colour at rest is the string colour: never a format placeholder, and a `{…}` the grammar reads as an interpolation only once a provider has answered. See [docs/runtime.md](docs/runtime.md#brackets-in-rust-comments-and-strings). |
| imported modules and types at type slate (Python, Go, Lua, JavaScript, TypeScript, Zig) | A grammar cannot see the import list, so `heapq.heapify`, `sys.argv`, `defaultdict(deque)`, `fmt.Println` and Zig's `const mem = std.mem` read as plain locals until a server sends tokens, and with `python.languageServer: None`, gopls off or no zls none arrive. Comes off once a provider answers. In Lua it stays: lua-language-server types a `local json = require "dkjson"` module's uses `variable` or `class`, never `namespace`. tsserver and Deno send no token for a project file's `import * as util from './util.js'`, so its uses are painted in every server state, a name at a time: one whose uses the server typed is left to it. See [docs/import-restore.md](docs/import-restore.md), [docs/lua.md](docs/lua.md#band-1-restores), [docs/javascript.md](docs/javascript.md#band-1-restores) and [docs/zig.md](docs/zig.md#band-1-restores). |
| shadowed builtins at the page colour (Python, Lua, Ruby) | Both grammars scope `id`, `input`, `type` and 74 more as builtins wherever they stand, so a parameter `id` or a module-level `input = sys.stdin.readline` reads bold call blue. Non-call uses that resolve to a data binding are painted page colour, with the import restore's resolver and lifetime. Go's builtin functions need nothing, since its grammar scopes them only at call sites; a local named after a predeclared type (`string`, `error`, `rune`) stays type slate. Lua's grammar does the same to 28 names (`type`, `next`, `select`, …): a `local type = node.type` reads call blue until lua-language-server answers and paints the name page. Ruby's grammar does it to 44 Kernel names (`p`, `puts`, `format`, …), and ruby-lsp leaves their declarations untyped. In Lua and Ruby the restore stays on with a server, so nothing repaints when it answers. See [docs/shadow-restore.md](docs/shadow-restore.md). |

All of them are **resting register**: they paint in Survey, never blink as
attention moves, and paint in every visible editor of the document, not just
the active one. The import and shadow restores are the ones that hand over: they
stop when a semantic provider answers for the document, except in Lua, where
the module colour is wrong under lua-language-server's tokens and the shadow
restore agrees with them, in Ruby, whose shadow restore covers the
declarations ruby-lsp leaves untyped, and in JavaScript and TypeScript, where
the namespace restore hands over per name. That is why `DecorationPool` exposes `banded()` alongside
`all()`: the clear paths strip bands 2–3 from inactive editors while leaving
these alone. Getting that wrong made a split's second markdown pane lose its
wash.

For the underline there is a one-line alternative — `editor.links` is
`LANGUAGE_OVERRIDABLE`, so a `[markdown]` override could set it `false` — but
that switches off the whole contrib and stops links being **clickable**. A competing
decoration with `text-decoration: none !important` keeps ctrl+click. The
`!important` is required: both selectors are single-class under `.monaco-editor`,
so plain `none` loses the tie.

The two scanners are plain lexers over the document text, because the extension
host has no access to the TextMate token stream. They therefore have to
reproduce what the injection grammar gets for free — never matching inside code —
so `codeSpans()` tracks fences (also indented inside a list item), indented
blocks, inline spans and frontmatter, and every tie-break favours "treat as code".
The wash also skips `<!-- … -->` comments and a `==` inside a link target. The
underline cancel still covers a URL in a comment: it is `text-decoration: none`,
invisible where nothing is underlined. Results are cached per document
version; a full scan of a 155 KB markdown file is ~2.3 ms, and only reruns on
edit.

## Develop

```bash
npm install
npm run compile       # or: npm run watch
npm test              # full suite
npm run bench         # performance: one sample, navigation, large files
```

`npm run bench` ends with `test/bench-scale.js`, which drives the real decorator
over generated 2k, 10k and 50k-line TS, Go, Rust, Python, Lua, Ruby and Zig files
(`node test/bench-scale.js rs 50000 --no-lsp` runs one input on the heuristic
path; `js` is there on request). Numbers: [docs/runtime.md](docs/runtime.md#cost-on-large-files).
`node --expose-gc test/bench-memory.js` reports the heap the decorator retains
over 8 such files and 100 keystrokes ([docs/runtime.md](docs/runtime.md#memory)).

Press **F5** to launch an Extension Development Host. The `samples/` directory has
files for thirteen languages, markdown included, each written to exercise the classification cases.

### Install

VS Code runs the installed copy in
`~/.vscode/extensions/kaievns.okibi-akari-dynamic-highlighting-0.1.0/`, not
`out/`. A change to `src/` (a palette value included) shows up only after
repackaging and reinstalling:

```bash
npx @vscode/vsce package   # runs vscode:prepublish (npm run compile) first
code --install-extension okibi-akari-dynamic-highlighting-0.1.0.vsix --force
```

Then run **Developer: Reload Window**.

### Tests

| File | Covers |
|---|---|
| `test/pure.test.js` | pure functions — brace scan, lexer, regions, traces, risk |
| `test/golden.test.js` | the classifier against **real** captured LSP tokens (TS + gopls) |
| `test/scopecolor.test.js` | two-pass colouring properties — determinism, sibling stability, safe reuse, no collisions, budget |
| `test/edge.test.js` | phase machine, file index, plan building, degenerate inputs, per-language edge cases |
| `test/markdown.test.js` | the markdown marks' scanners (fences, frontmatter, inline code, comments, link targets), prose as no data scope, and every markdown-derived id VS Code registers against `test/fixtures/markdown-languages.json`: prose exactly when a file opens as it, the marks exactly where markdown-language-features serves it |
| `test/python.test.js` | the indentation scanner, comprehension/lambda scopes, f-string lexing, the language dispatcher, Python header classification, class attributes |
| `test/lexer.test.js` | the shared lexer: per-language comment / doc / string tables, region queries, line counting, the per-version memo, scanner regressions |
| `test/lexer-render.test.js` | the real Decorator in Focus and Edit: nothing paints inside comments or docstrings, on crafted snippets and on every block of every sample (heuristic, and real tokens where captured) |
| `test/escape.test.js` | escape marks on per-language corpora with real (TS, Go, Rust) or Pylance-shaped tokens; each rule; the stale-hold while typing; the underline style |
| `test/risk-words.test.js` | per-language danger words and numeric-literal tables |
| `test/render.test.js` | the real Decorator per phase: band 1 identical in Survey, Focus and Edit; bands 2–3 painted in Focus / Edit and withdrawn in Survey, each next to a positive control; Python f-string fields while a field is typed and taken apart; Rust `Self` / `crate` / `super` through no server, a loading, loaded, restarted and gone server, on real rust-analyzer captures; a loading workspace's answer asked again with no edit, and a detached file's asking bounded; data and prose files paint no bands in any phase; the chat customisation files and Julia Markdown, by the id VS Code gives them, paint at most the two markdown marks, in every phase and through a click and typing, and ask no server; KDL and every config format, by the id VS Code gives it, paint nothing at all, band 1 included, ask no server, and a click or typing in them leaves the phase in Survey |
| `test/runtime.test.js` | the LSP lifecycle and editors: stale answers, shared fetches, cold-server retries, reopened files, closing a document's last tab, URI schemes, focus leaving, splits, typing vs programmatic edits, tokens in comments, Go doc links, brackets in Rust comments and strings, superseded versions collected ([docs/runtime.md](docs/runtime.md)) |
| `test/imports.test.js` | the import restore: Python and Go spans against shadows, labels, members, prose, calls and decorators, comprehension and lambda scopes, `del`, Go `var` / `const` lists and blocks, the stdlib table, the screenshot fixture, linear cost on comprehension, lambda and func-typed-parameter inputs, phase independence, the handover to a provider, the typing debounce; band 2 resolving imports per occurrence ([docs/import-restore.md](docs/import-restore.md)) |
| `test/shadows.test.js` | the shadow restore: the screenshot fixture, calls, labels, attributes, module-level rebinding, the flow rule at module and class level (loops, `while` conditions, `for` iterables) and its absence in functions, comprehension and lambda scopes, class bodies, nested functions, `global` / `nonlocal`, every binding form (`for` targets after a dot or in a subscript, `*a, b`, `as (a, b)`, PEP 695 parameters, multi-line return annotations), unclosed brackets, linear cost on a long module-level block, `def` / `class` names and imports, header defaults, decorators, Go; the resolver rules it brought to the import restore, imported-and-rebound names included; phase independence, colour, handover, typing debounce, band-2 precedence, no overlap with the import restore ([docs/shadow-restore.md](docs/shadow-restore.md)) |
| `test/palette.test.js` | band-2 palette invariants: one chroma, even perceived lightness, WCAG 4.5:1, closest-pair distance; escape and async marks off the error hue ([docs/palette.md](docs/palette.md#invariants)) |
| `test/intervals.test.js` | the indexed lookups (interval index, enclosing and outermost function, shadow clipping, interpolation holes, top-level lines) against the linear scans they replaced, on random inputs |
| `test/lua.test.js` | Lua: the lexer table (long brackets, `\z`, `//`, shebang, numerals), the keyword block scan, bindings and lexical visibility, modules and namespace globals, both classifiers on real lua-language-server tokens, escape marks, no async or comment clay, the module and shadow restores staying on with the server and through typing, half-typed `<const>` attributes, `string.format` placeholders under a keyword-on capture, linear cost ([docs/lua.md](docs/lua.md)) |
| `test/ruby.test.js` | Ruby: the lexer (`=begin`, `__END__`, holes, %-literals, heredocs, regex versus division, the local-variable table, symbols, labels and sigils, operator method names), relex over random edits, the keyword block scan (endless defs, branches, modifiers, hashes after a ternary `?` or `!` too, `end` in literals), bindings by Ruby's lexical rule, both classifiers on real ruby-lsp tokens, a `name!(` call, escape marks, no async marks, the shadow, `self` and `#{` / `}` restores, an `.erb` file opened as Ruby, linear cost ([docs/ruby.md](docs/ruby.md)) |
| `test/javascript.test.js` | JavaScript and TypeScript: the lexer against TypeScript's parser on every edge and every regex-or-division position (a `/` after an `if`, `while`, `for` or `with` header and after `of` as a name the documented differences), heuristic declarations and non-data initializers, keys and labels, the module surface, `self`, the namespace restore's statement shapes, uses, JSX tag names and handover on real tsserver and Deno captures, ES5 constructors and a UMD wrapper, focus in patterns, destructured parameters and one-line arrows (other languages unchanged), template-hole and JSDoc restores, declaration files, the React ids, `jsconfig.json` and `deno.json` ([docs/javascript.md](docs/javascript.md)) |
| `test/zig.test.js` | Zig: the lexer against Zig's own tokenizer (comments, `\\` lines, chars, `@"…"`, `@builtins`, numerals), relex over random edits, the brace scan and header kinds (every `fn` prefix, `test`, containers, captures in control flow), the naming rules, the heuristic's facts (labels, fields, type parameters, type and namespace consts across blanks and comments, captures and bars that are none, aliases), both classifiers on real zls `partial` and `full` tokens, escape marks through `.*`, danger marks on the pointer casts, no async marks, clay in code only, the `self` paint, the namespace restore, its scope (a sibling scope's parameter, a field) and its handover, placeholders under `full`, ZON as static content, linear cost ([docs/zig.md](docs/zig.md)) |
| `test/perf-golden.test.js` | output equivalence on generated 2k and 10k-line TS, JS, Go, Rust, Python, Lua, Ruby and Zig files: lex, blocks, regions, file index, classifications, colourings, plans, traces, risk ranges and a decorator session, each hashed against `test/fixtures/perf-golden.json` |
| `test/transitions.test.js` | transitions between states: seeded random walks over editor, server, theme and settings events, and walks that delete a docstring's closing quote and type it back, walks over `walk.lua` and walks that delete its long comment's last `]` or an `end`'s `d` and type it back, the same over `walk.rb` with its heredoc terminator, walks over `walk.js` with tsserver- and Deno-shaped answers, walks over `walk.zig` and `walk.zon` with zls-shaped answers and walks that delete a Zig string's `"`, a `\\` line's backslash or a `}` and type it back, walks over the four chat customisation files and `walk.jmd` beside a code file, every step compared with a fresh Decorator given the same final state, and one or two data files (KDL and ten config formats), in a quarter of them, required to show nothing at all and a prose file at most the markdown marks, and no request made about either; a code file in Edit switched to each data and markdown-derived file, ZON included, and back; the leftovers they found as shrunk walks; how decorations move with edits, forced and unforced, against a port of VS Code's rule. Runs through the `require` at the end of `test/runtime.test.js` ([docs/runtime.md](docs/runtime.md#transitions)) |

How far the suite pins the code (a mutation audit, per mutant in
[docs/mutation-audit.csv](docs/mutation-audit.csv) and, for Lua, Ruby, JavaScript and Zig,
[docs/mutation-audit-lua.csv](docs/mutation-audit-lua.csv),
[docs/mutation-audit-ruby.csv](docs/mutation-audit-ruby.csv),
[docs/mutation-audit-javascript.csv](docs/mutation-audit-javascript.csv) and
[docs/mutation-audit-zig.csv](docs/mutation-audit-zig.csv)), how its timing checks hold
under load, and what the perf-golden sessions hash: [docs/testing.md](docs/testing.md).

The golden fixtures are captured from real language servers, which is what catches
"the server tokenizes differently than we assumed". Regenerate them after editing
the samples:

```bash
node test/gen-ts-semtok.js samples/sample.js > test/fixtures/sample.js.tokens.json
node test/gen-ts-semtok.js samples/sample.ts > test/fixtures/sample.ts.tokens.json
~/go/bin/gopls semtok samples/sample.go | node test/gen-go-semtok.js samples/sample.go > test/fixtures/sample.go.tokens.json
python3 -I test/gen-py-semtok.py samples/sample.py 1 > test/fixtures/sample.py.tokens.json
node test/gen-lua-semtok.js samples/sample.lua > test/fixtures/sample.lua.lsp.json
node test/gen-lua-semtok.js test/fixtures/format.lua > test/fixtures/format.lua.lsp.json
node test/gen-lua-semtok.js --keyword test/fixtures/format.lua > test/fixtures/format.lua.keyword.lsp.json
node test/gen-rb-semtok.js samples/sample.rb > test/fixtures/sample.rb.lsp.json
node test/gen-zig-semtok.js samples/sample.zig > test/fixtures/sample.zig.lsp.json
node test/gen-zig-semtok.js --full samples/sample.zig > test/fixtures/sample.zig.full.lsp.json
zig run test/gen-zig-tokens.zig -- samples/sample.zig > test/fixtures/sample.zig.tokens.json
```

The JavaScript captures in `test/fixtures/javascript/` come from tsserver with
`@types/node` and from `deno lsp`; their commands are in
[docs/javascript.md](docs/javascript.md#regenerating-the-token-fixtures).

The Rust fixtures (`test/fixtures/sample.rs.*`) are rust-analyzer captures made
with `scripts/ra_semtok.js` in the theme repo. `test/fixtures/rust-paths.tokens.json`
holds a detached, a loading and a loaded cargo capture of one file:

```bash
node test/gen-rs-semtok.js test/fixtures/rust-paths.rs > test/fixtures/rust-paths.tokens.json
```

`test/perf-golden.test.js` builds its inputs from the samples and these fixtures,
so editing either changes its hashes. An optimisation must leave them unchanged;
a deliberate output change re-records them in the same change with
`PERF_GOLDEN_RECORD=1 node --test test/perf-golden.test.js`.

The escape corpora in `test/fixtures/escape/` list their generators at the top of
`test/escape.test.js`; the Go closure fixture in `test/fixtures/classify/` lists its
own in `test/golden.test.js`.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `okibiDynamic.enabled` | `true` | Main toggle (also the status-bar click / `Okibi Dynamic: Toggle`). |
| `okibiDynamic.showPhaseInStatusBar` | `true` | Show 構/流/異 in the status bar. |
| `okibiDynamic.debug` | `false` | Log focus/classify/render decisions to an output channel. Needs a reload. |
| `okibiDynamic.dwell.editToFocus` | `2000` | ms of no typing before Edit → Focus. |
| `okibiDynamic.dwell.focusToSurvey` | `24000` | ms of no caret activity before Focus → Survey. |
| `okibiDynamic.dwell.minHold` | `350` | ms floor before any downgrade (anti-flicker). |

Go needs `"gopls": { "ui.semanticTokens": true }` — the extension contributes it
as a default, but gopls must restart to pick it up.

## Design notes

- **Why a separate extension.** A colour theme is three static maps
  (workbench colours, TextMate scopes, semantic tokens) — a pure
  classification → colour function, with no input for caret, focus or mode. Bands
  2–3 are inherently stateful, so they cannot live in a theme. Decorations layer
  *on top of* the theme, which is exactly the cumulative-superset composition the
  doctrine wants.
- **Brace scan vs LSP for focus.** Focus is purely structural ("the innermost
  `{…}` around the caret"), so a synchronous block scan over the shared lexer
  resolves it identically to LSP scopes, needs no server, and never awaits on a
  caret move.
  *Classification* does use LSP semantic tokens, with a heuristic fallback for
  languages that have no server and for the moment before a server registers
  ([docs/runtime.md](docs/runtime.md#cold-servers)).
- **Prose is not a data scope, and markdown contains braces.** A markdown file is
  full of them — every fenced Go, TS or JSON block — so the brace scan found real
  blocks, and a caret in PROSE fell through to the synthetic whole-file scope. That
  made the entire document one "function" whose most frequent words are `the`, `a`
  and `The`, so the layer tinted English articles as data identities.
  `samples/sample.md` states the contract in its own text: "there are no identity
  tints here and the phase stays Survey 構 while the caret moves through text."
  `scanBlocks` returns nothing for a prose language and `focusedBlock` withholds the
  top-level fallback, so no block is focused, `runClassify` returns early, and bands
  2-3 never paint. The two band-1 markdown marks are unaffected — they are applied
  before the paint check.
- **Markdown has five ids.** VS Code's vscode.prompt opens the chat customisation
  files under ids of their own, with a grammar that only includes markdown's:
  `prompt` (`*.prompt.md`), `instructions` (`*.instructions.md`,
  `copilot-instructions.md`, `**/.claude/rules/**/*.md`), `chatagent` (`*.agent.md`,
  `*.chatmode.md`, `**/.github/agents/*.md`, `**/.claude/agents/*.md`) and `skill`
  (`SKILL.md`). markdown-language-features serves all four as markdown, links
  included, so they are prose and take both markdown marks (`MARKDOWN_LANGUAGES` in
  `src/focus.ts`). Before they were listed, a click in a fence of one made the whole
  file one scope: the stripe on every line, identity tints on frontmatter keys and
  prose words (`tools`, `branches`, `yourself`), `self` paint on a prose `this`, requests
  for its document symbols and semantic tokens, and neither mark. In VS Code
  1.144.1 (probed 2026-11-10) on the same 18 lines as a `*.prompt.md`, a
  `*.instructions.md`, a `*.agent.md` under `.github/agents/`, a `*.chatmode.md`, a
  `SKILL.md` and a file under `.claude/rules/`, the click took the phase to Focus 流 with the stripe on all 18 lines
  and the URL underlined; now the phase stays Survey 構 through the click, typing
  and a click in prose, and the wash, the cancellation and the theme's colours
  match the same text in a `.md` file. Julia
  Markdown (`juliamarkdown`, `*.jmd`) is prose like Quarto and R Markdown, and like
  them takes neither mark: VS Code ships no grammar for it and
  markdown-language-features does not serve it, so it renders as plain text, a URL
  keeping the editor's own link underline.
  `markdown-math` and `markdown_latex_combined` are embedded ids no file opens as.
  Each id, the extensions that register it and its files:
  `test/fixtures/markdown-languages.json`.
- **Data files have braces but no data flow.** JSON, YAML, GitHub Actions
  workflows, TOML, KDL, INI, `.gitignore`-style ignore files, HTML, CSS and the rest
  of `STATIC_CONTENT_LANGUAGES` (`src/focus.ts`; the extension that registers each
  id is in `test/fixtures/static-languages.json`) get prose's treatment: no
  focusable block, so the phase stays Survey 構 and bands 2-3 never paint. No band-1
  mark applies to them either, and the layer asks their servers nothing. A KDL
  children block nests like a JSON object, so it gets no stripe, and its numbers
  never turn clay. The id is VS Code's, not the format's: a workflow under
  `.github/workflows/` is `github-actions-workflow`, a `*.properties` file is
  `java-properties` once redhat.java is installed, `requirements.txt` is
  `pip-requirements`. Before those three and `ignore` were listed, a click in such a
  file made the whole file one scope: in a real workflow `on`, `env` and
  `concurrency` took identity tints and 36 lines took the stripe, and in a
  `.dockerignore` a number in a comment turned clay. A ZON file opens as `zig`,
  the Zig extension's one id; the layer reads a `.zon` file as `zon`, static
  content ([docs/zig.md](docs/zig.md#zon)).
- **Indentation-scoped languages need their own scanner.** Python has no braces, so
  the brace scan found **one** block in 140 lines of `samples/sample.py` — a dict
  literal — and every caret fell through to the synthetic module-level scope. The
  "focused block" was the whole file, so every name in it read as a top-level
  declaration and the layer tinted the lot at once.

  `scanIndentBlocks` implements the actual language rule — a line ending in `:`
  opens a suite that runs until the first later line indented no deeper than the
  header — and `scanBlocks(text, languageId)` picks the scanner. Same `BraceBlock`
  shape either way, so `declRegionFor` / `scopeRegionFor` / `lexRegionFor` /
  `focusKeyOf` work unchanged.

  Four things make it right rather than merely plausible, each pinned by a test in
  `test/python.test.js`: a sibling at the same indent closes its predecessor (the
  bug that made one class appear to span the file); a wrapped signature is keyed to
  the line `def` starts on, not the continuation line the `:` lands on; colons in
  docstrings, comments, slices, annotations and `lambda` do not open blocks; and
  blank lines do not close them.

  The header predicates needed widening too. `isFunctionHeader` matched
  `func`/`function`/`=>` — no Python `def` qualified, so parameters classified as
  block-locals instead of fn-locals and stopped tracing across the function.
  `class` is deliberately **excluded**: a class body holds attributes, not
  parameters.
- **Keyword-delimited blocks need their own scanner too.** Lua's `function … end`,
  `if … then … end` and `repeat … until` have no braces, and the lexer read Lua as
  the default syntax (`//` comments, no `--`), so the brace scan found 16 of the
  31,709 scopes lua-language-server's parser sees in the measured corpus, and
  3,504 of 3,665 carets in a function or block focused the whole file or a `{}`
  table constructor. Lua has its own lexer family and `scanLuaBlocks`, which reads
  the block keywords from it ([docs/lua.md](docs/lua.md)). Ruby was read with
  `#` comments only: heredocs, %-literals, regexes and symbols were code, and the
  brace scan found 21,727 of the 138,787 scopes Prism sees in its measured
  corpus, so 22,346 of 24,513 carets focused the whole file. Its own lexer family
  and `scanRubyBlocks` find 138,782, keeping modifiers (`x if y`) and hashes out
  ([docs/ruby.md](docs/ruby.md)).
- **A string can have no closing delimiter.** A Zig multiline string is a run of
  lines, each opened by `\\` and running to its line end. Read with the default
  syntax they were code: 2,254 brace pairs the scan found sat inside them, and
  3,380 numerals in strings turned clay, over 630 files. The Zig lexer family
  reads each `\\` line as a string, and its regions match Zig's own tokenizer on
  every character. An unclosed `"…\` ends at its line break too: a Zig backslash
  escapes no line break, and reading it as one ran the literal over the next line
  ([docs/zig.md](docs/zig.md)).
- **f-strings are code, and the lexer used to treat them as text.** The shared
  identifier lexer knew JS templates — backtick plus `${` — but Python f-strings use
  a quote plus a bare `{`, so every name inside one was invisible. That is not
  cosmetic: names must be used at least **twice** to tint, and `prefix`, `page`
  and `timeout_sum` in `samples/sample.py` each have exactly one plain use plus one
  f-string use. All three silently fell below that floor and never tinted anywhere, in any
  scope. The fix tracks which quote opened the current string so the closing
  delimiter is right on the way out, honours `{{` as an escaped brace, and only
  treats `{` as a hole when the string carried an `f` prefix (`f"…"`, `rf'…'`) that
  is not merely the tail of an identifier like `conf`. Comments, docstrings and
  string rules are per language in the shared lexer (`src/lex.ts`,
  [docs/lexer.md](docs/lexer.md)): `#` is a comment only where the language says
  so, and every scanner, the risk marks included, reads that one lexer.
- **Comprehensions and lambdas are scopes with neither braces nor a colon suite.**

  ```python
  jobs = [one(name) for name in names]
  timeout_sum = fold(cfgs, 0, lambda acc, item: acc + item.timeout)
  ```

  Both bind names, and `scanIndentBlocks` cannot see either — so `name`, `acc` and
  `item` belonged to the enclosing function, competed for its hues, and putting the
  caret inside one focused the whole function. `scanPyExprBlocks` adds them as
  synthetic blocks, the same shape of fix as `scanArrowBlocks` for JS's concise
  arrow bodies. A bracket span counts as a comprehension only when it contains a
  `for` at its **own** bracket depth, so `[1, 2, 3]`, `f(a, b)` and `{"a": 1}` stay
  plain while `[[j for j in r] for r in rows]` is correctly two scopes.
- **A lambda is not a symbol, so `fnRanges` had a hole.**
  `executeDocumentSymbolProvider` reports functions, methods and constructors — a
  lambda has no name, so no server reports one. `enclosingFnOf` therefore resolved a
  caret inside a lambda to the SURROUNDING function, and its parameters were
  classified against the wrong scope. The block scanner already locates every
  function-like block — lambdas, Go func literals, Rust closures, callbacks — so the
  ranges come from there rather than from a second scanner
  ([docs/classification-rules.md](docs/classification-rules.md#function-ranges)).

  Two smaller defects in the same construct: `isFunctionHeader` read
  `text.slice(headerStart, openOffset)`, which is EMPTY for a synthetic block, so a
  lambda never counted as a function header and its params classified as
  block-locals; and `pyExprEnd` stopped at the first comma, which is wrong because a
  lambda has two comma-separated regions — `lambda acc, item: acc + item.t` — and
  only the body may be ended by one.
- **The keyword list was JS/Go-only.** `lambda` was ranked as a data identity: it
  took a hue in every scope containing a lambda and consumed one of the palette's
  few slots. Python's keywords are now in `HEURISTIC_KEYWORDS`.
- **A Python class body is not a data scope.** `name: str` in a dataclass is the
  spelling of a struct field, and attribute names are band-1 in every other
  language here. But Pylance reports them as `variable [declaration]` —
  indistinguishable on the wire from a real local — so they tinted as the class's
  own data identities, contradicting the resting register. `pyClassFieldRanges`
  excludes the field NAME only; the right-hand side (`= MAX_RETRIES`) is real code
  and still tints. It feeds the same exclusion list as `typeDeclRanges`, for the
  same reason: a name that declares a field rather than a binding holds no data.
- **A name after a dot, or before a `=` in an argument list, is not data.**
  `TINTABLE_TYPES` restricts tinting to `variable`/`parameter` on the assumption
  that a server types a member access as `property`. TS and gopls do — across both
  captured fixtures there is not one `variable`/`parameter` token sitting after a
  dot. Pylance does not, consistently: on `self.retries = retries` both halves came
  back tintable, so the attribute and the parameter collapsed into one name, got
  one hue, and the attribute stopped reading as a member. Same for a keyword
  argument: `Config(name=name)` is a label and a data read, and they have to look
  different.

  The server's own answer is honoured too, via `NON_DATA_MODIFIERS`: Pylance marks
  an attribute with a **`classMember`** modifier, and `dynamicAttribute` (a
  `getattr`-style attribute) carries no adjacent dot at all, so the positional check
  alone cannot see it.

  `isMemberOrLabelPosition` is **positional, not a Python special case** — "the
  right-hand side of a dot is a member" holds in every language here, and a server
  that gets it right never reaches the check. The boundaries are what matter, so
  they are tested directly: `total = 0` and `total += 1` are still bindings,
  `if name == other` is a comparison rather than a label, and `d[key] = 1` is a
  real read. A following `=` makes a name a label only after `(` or `,` inside a
  call's parentheses, in a language with named arguments, and never on a token
  the server marks `declaration`: `def f(a, retries=5)` and `a, b = 1, 2` keep
  their declarations, and JS `f(x = 1)` stays an assignment.
- **Python has no captured token fixture, and cannot have one.** Go and TS goldens
  come from running the real server. Pylance is the only server that emits Python
  semantic tokens, and its licence restricts it to Microsoft products — driven from
  a test harness it prints its licence to stderr and exits 1. Pyright, the
  open-source engine beneath it, advertises no semantic-token provider at all. So
  the Python token shapes in `test/python.test.js` are constructed to Pylance's
  documented legend rather than captured, and the Python fixtures
  (`test/fixtures/sample.py.tokens.json`, the escape corpora) come from
  `test/gen-py-semtok.py`, which emits that legend from the stdlib `ast`.
- **Two clocks.** Classification (expensive, LSP) is debounced — 140 ms for
  typing up to 10k lines, up to 400 ms on larger files, 60 ms for navigation —
  and fetches once per document version, however many blocks ask. Rendering
  (cheap) is coalesced to a microtask, with a dirty check per editor and
  decoration type, so an unchanged range set is not re-sent unless an edit has
  moved it on screen.
  The server's answers, cold starts and which edits count as typing:
  [docs/runtime.md](docs/runtime.md).
- **Measured, not assumed.** Every classification rule traces to captured
  language-server output. When behaviour in the editor disagreed with a
  simulation, the simulation was wrong — `Developer: Inspect Editor Tokens and
  Scopes` is the arbiter.
