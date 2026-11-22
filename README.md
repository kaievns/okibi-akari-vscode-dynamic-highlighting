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
| async cyan | `await` / `async`; none in Lua, Ruby, Zig, shell or fish, which have no such keyword (Zig 0.17's `.async(` and `.await(` are methods) |
| danger bold | casts and the `any` type, per language: TS `as` casts and `any` types, in TSX and in Vue, Svelte and Astro components too; Rust, Kotlin and Dart `as` casts; Kotlin's `!!`; Swift's force unwraps, `try!`, `as!`, `unowned(unsafe)`, `nonisolated(unsafe)` and `@unchecked` ([docs/swift.md](docs/swift.md#danger-marks)); C pointer casts (`(T *)x`), Objective-C `__bridge` casts and `performSelector:`, C++ and Metal `reinterpret_cast` and `const_cast`, Java reference casts (`(List<String>) raw`), and `@SuppressWarnings("unchecked")` / `@Suppress("UNCHECKED_CAST")`; Zig's pointer casts (`@ptrCast`, `@alignCast`, `@constCast`, `@intFromPtr`, `@ptrFromInt`, `@fieldParentPtr` and two more); in shell, code run from elsewhere: `eval`, a pipe into a shell that reads its script (`curl … \| sh`), a shell given `<(curl …)` or `-c "$(curl …)"`, `source <(…)`, each through a wrapper such as `sudo`, `env` or `exec`, and fish's `eval` and `\| source` ([docs/tooling.md](docs/tooling.md#band-3)); nothing in Python, JavaScript, Go, Lua, Ruby or Groovy, and no value cast anywhere ([docs/c-jvm.md](docs/c-jvm.md#danger-marks)) |
| number-clay | numeric literals in the focused scope, suffix included (`123u32`, `1.0f`) |
| dashed underline | a **write that escapes the block**: an assignment, `++`/`--`, or member, subscript or deref write to a binding declared outside it. Declarations, named arguments, defaults and constructor `self`/`this` writes never mark. Needs semantic tokens: the heuristic fallback paints none, and shell and fish none at all ([docs/tooling.md](docs/tooling.md#band-3)) |

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
| cancelling the link underline (markdown, and MDX's prose) | The underline is the `editor.links` contrib decorating each link range with `inlineClassName: "detected-link"`, styled by the workbench stylesheet. It is not a token style, so no theme rule can reach it. In MDX it skips ESM, `{…}` expressions and JSX tags ([docs/mdx.md](docs/mdx.md)). |
| `self` / `this`, and Rust `Self` / `crate` / `super`, at keyword grey | Outside a cargo workspace rust-analyzer types a `self` use as `const`, `Self` as `struct` and `crate` / `super` as `namespace`, and a semantic token outranks the grammar. The three path keywords are painted until rust-analyzer types them as keywords; a cargo package sends the degraded answer too while it loads. ruby-lsp types Ruby's `self` `variable.defaultLibrary`; a Ruby `this` is a plain name, and `x.self` / `self:` are a method and a key. A JavaScript, TypeScript, C++, Java, Kotlin or Groovy `self` is a plain name too, and in C both `self` and `this` are ([docs/c-jvm.md](docs/c-jvm.md#receivers)); tsserver types a declaration file's `this` parameter (`f(this: Window)`) `parameter`. zls types Zig's `self` `parameter`, so it is painted in every server state; a Zig `this`, a member `.self` and a field or enum member `self` are names. Shell and fish have no receiver: a `self` or `this` there is a word or a variable. Code files only, never inside comments, strings or docstrings. See [docs/runtime.md](docs/runtime.md#rust-path-keywords), [docs/ruby.md](docs/ruby.md#band-1-restores), [docs/javascript.md](docs/javascript.md#band-1-restores) and [docs/zig.md](docs/zig.md#band-1-restores). |
| C-family `NULL`, `true` and `false` at builtin red, and `bool` at keyword grey; Objective-C's `nil`, `Nil`, `YES`, `NO`, `TRUE` and `FALSE` too, and its ARC and nullability qualifiers (`__weak`, `__block`, `__nullable`, …) at keyword grey | cpptools and clangd send `macro` over each, with no modifier that tells them from `MAX(a, b)`, and the theme paints `macro` a bold call. Painted file-wide in `c`, `cpp`, `cuda-cpp`, `metal`, `objective-c` and `objective-cpp`, with or without a server: the paint is the grammar's. The name a `#define` or `#undef` defines and a `defined(…)` operand keep the call ([docs/c-jvm.md](docs/c-jvm.md#band-1-restores)). |
| Swift operators at operator grey, subscript brackets at normal weight, an attribute's `@` and name at attribute violet, and a named standard-library static call at bold call blue | sourcekit-lsp types `==`, `+=`, `??`, `..<` `method.static.defaultLibrary` or `operator.defaultLibrary`, a user operator `method.static`, and a subscript's `[` `]` `method.defaultLibrary` or `method`, and an attribute's name (`@MainActor`, `@State`) as a type or a macro; no theme key tells them from a call or a type. A bracket keeps the editor's bracket-pair colour, which the server's colour does not reach, so only its weight is restored. Painted file-wide with or without the server: the paint is the grammar's. Assignment, `->`, postfix `!` and `?`, generic clauses, literals and their exponent signs, and `#if` lines are left alone. The theme keys `method.static.defaultLibrary` operator grey for the operators, so a named call of that type (`.target(`, `.macOS(`, `JSONSerialization.jsonObject(`) is painted a bold call again, over the server's last answer ([docs/swift.md](docs/swift.md#band-1-restores)). |
| Kotlin `$name` templates at member steel | kotlin-language-server sends `variable` over `$name`, the page colour; the grammar paints it a placeholder. `$` and name are painted, with or without the server; a `${…}` hole's delimiters are the grammar's and the server sends nothing over them ([docs/c-jvm.md](docs/c-jvm.md#band-1-restores)). |
| Rust format placeholders | In a detached file, and in a cargo package until its workspace loads, rust-analyzer emits one `string` token over the whole literal, so `meta.interpolation.rust` never applies; a loaded workspace types the holes `formatSpecifier`, which the theme paints the same steel. Outside a raw string a backslash escape is one character, so `\u{2603}` is not a hole. See `src/placeholders.ts`. |
| Python f-string fields | The grammar gives a field's braces no `string` scope, so bracket-pair colorization paints them bracket grey over the theme. The braces, the `!r` conversion, the `:spec` and a self-documenting `=` are painted; the expression inside keeps its own colour. See `src/placeholders.ts`. |
| Ruby `#{` and `}` at member steel | Bracket-pair colorization paints the braces of an interpolation over the theme's rule, with or without ruby-lsp. The `#{` and `}` of every closed hole are painted; the expression inside keeps its own colours. See [docs/ruby.md](docs/ruby.md#band-1-restores). |
| JavaScript `${` and `}` at member steel | JavaScript's language configuration lists `${` `}` as a bracket pair and sets no `colorizedBracketPairs`, so bracket-pair colorization paints a template hole's delimiters over the theme's rule, with or without a server; TypeScript's leaves them out. `javascriptreact` shares JavaScript's, and a Svelte `<script>` without a TypeScript `lang` embeds JavaScript's grammar. The `${` and `}` of every closed hole are painted; the expression inside keeps its own colours. See [docs/javascript.md](docs/javascript.md#band-1-restores) and [docs/components.md](docs/components.md#band-1-restores). |
| Lua format placeholders | Under `Lua.semantic.keyword`, lua-language-server sends one `string` token over each literal, so the theme's `string.format` placeholders turn string green. Painted while the document's last answer types its literals that way; under the default settings, and with no server, the theme paints them alone. The call shapes are the theme's: `string.format("…")`, the literal opening the line after a `string.format(` that ends its line, and `("…"):format(…)`. See [docs/lua.md](docs/lua.md#band-1-restores). |
| Zig format placeholders | Under `zig.zls.semanticTokens: full`, zls sends one `string` token over each literal, so the theme's `{d}` / `{s:>8}` placeholders turn string green. Painted while the document's last answer types its literals that way; under the default `partial`, and with no server, the theme paints them alone. The call shape is the theme's: a `"…"` literal right after `(` or `, ` whose `.{` arguments follow on its line. See [docs/zig.md](docs/zig.md#band-1-restores). |
| Go doc links in comment colour | gopls types `[Name]` in a comment as a code `variable` / `namespace` / `function` with no telling modifier. See [docs/runtime.md](docs/runtime.md#go-doc-links). |
| JSDoc brackets in comment colour (JavaScript, TypeScript, JSX, TSX, Svelte) | Both grammars give a JSDoc type and `[name]` the token type `other`, so bracket-pair colorization paints `@param {string} [name]` at its level colours; the React ids and Svelte's grammar register the same token types. Every bracket in a `/**` comment is painted. See [docs/javascript.md](docs/javascript.md#band-1-restores) and [docs/components.md](docs/components.md#band-1-restores). |
| brackets in Rust comments in comment colour, and in Rust strings in string colour | After a theme change made while no editor showed the file, VS Code 1.144.1's bracket-pair colorization paints brackets in comments, strings and char literals at their level colour, over any theme rule. A bracket in a string is painted only where its colour at rest is the string colour: never a format placeholder, and a `{…}` the grammar reads as an interpolation only once a provider has answered. See [docs/runtime.md](docs/runtime.md#brackets-in-rust-comments-and-strings). |
| imported modules and types at type slate (Python, Go, Lua, JavaScript, TypeScript, JSX, TSX, Vue, Svelte and Astro components, Zig) | A grammar cannot see the import list, so `heapq.heapify`, `sys.argv`, `defaultdict(deque)`, `fmt.Println` and Zig's `const mem = std.mem` read as plain locals until a server sends tokens, and with `python.languageServer: None`, gopls off or no zls none arrive. Comes off once a provider answers. In Lua it stays: lua-language-server types a `local json = require "dkjson"` module's uses `variable` or `class`, never `namespace`. tsserver and Deno send no token for a project file's `import * as util from './util.js'`, nor do the Vue, Svelte and Astro servers, so its uses are painted in every server state, template expressions included, a name at a time: one whose uses the server typed is left to it; a JSX tag is no use. See [docs/import-restore.md](docs/import-restore.md), [docs/lua.md](docs/lua.md#band-1-restores), [docs/javascript.md](docs/javascript.md#band-1-restores) and [docs/zig.md](docs/zig.md#band-1-restores). |
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
`~/.vscode/extensions/kaievns.okibi-akari-dynamic-highlighting-1.0.0/`, not
`out/`. A change to `src/` (a palette value included) shows up only after
repackaging and reinstalling:

```bash
npx @vscode/vsce package   # runs vscode:prepublish (npm run compile) first
code --install-extension okibi-akari-dynamic-highlighting-1.0.0.vsix --force
```

Then run **Developer: Reload Window**.

### Tests

| File | Covers |
|---|---|
| `test/pure.test.js` | pure functions — brace scan, lexer, regions, traces, risk |
| `test/golden.test.js` | the classifier against **real** captured LSP tokens (TS + gopls) |
| `test/scopecolor.test.js` | two-pass colouring properties — determinism, sibling stability, safe reuse, no collisions, budget |
| `test/edge.test.js` | phase machine, file index, plan building, degenerate inputs, per-language edge cases |
| `test/markdown.test.js` | the markdown marks' scanners (fences, frontmatter, inline code, comments, link targets), MDX's ESM, expressions and JSX tags as code and a tag's children as prose, an ESM block open past a blank line or to the end, linear cost with an ESM statement left open, prose as no data scope, and every markdown-derived id VS Code registers against `test/fixtures/markdown-languages.json`: prose exactly when a file opens as it, the marks exactly where markdown-language-features serves it |
| `test/python.test.js` | the indentation scanner, comprehension/lambda scopes, f-string lexing, the language dispatcher, Python header classification, class attributes |
| `test/lexer.test.js` | the shared lexer: per-language comment / doc / string tables, region queries, line counting, the per-version memo, scanner regressions |
| `test/lexer-render.test.js` | the real Decorator in Focus and Edit: nothing paints inside comments or docstrings, on crafted snippets and on every block of every sample (heuristic, and real tokens where captured) |
| `test/escape.test.js` | escape marks on per-language corpora with real (TS, Go, Rust) or Pylance-shaped tokens; each rule; the stale-hold while typing; the underline style |
| `test/risk-words.test.js` | per-language danger words and numeric-literal tables |
| `test/render.test.js` | the real Decorator per phase: band 1 identical in Survey, Focus and Edit; bands 2–3 painted in Focus / Edit and withdrawn in Survey, each next to a positive control; Python f-string fields while a field is typed and taken apart; Rust `Self` / `crate` / `super` through no server, a loading, loaded, restarted and gone server, on real rust-analyzer captures; a loading workspace's answer asked again with no edit, and a detached file's asking bounded; data and prose files paint no bands in any phase; MDX paints the link cancel on its prose links only, no wash and no bands, and asks no server; the chat customisation files and Julia Markdown, by the id VS Code gives them, paint at most the two markdown marks, in every phase and through a click and typing, and ask no server; KDL, every config format, CSS, Tailwind CSS, SCSS, LESS, Stylus, PostCSS, GraphQL, the Razor ids, XML, XSL, DTD, RELAX NG compact, an HTML server template, SQL, a diff, a rebase todo, Protobuf under either extension and buf's config, by the id VS Code gives it, paint nothing at all, band 1 included, ask no server, and a click or typing in them leaves the phase in Survey; a Helm and a Go template paint nothing, and the same texts under an unlisted id take the `self` mark, tints and the stripe ([docs/containers.md](docs/containers.md)) |
| `test/runtime.test.js` | the LSP lifecycle and editors: stale answers, shared fetches, cold-server retries, reopened files, closing a document's last tab, URI schemes, focus leaving, splits, typing vs programmatic edits, tokens in comments, Go doc links, brackets in Rust comments and strings, superseded versions collected ([docs/runtime.md](docs/runtime.md)) |
| `test/imports.test.js` | the import restore: Python and Go spans against shadows, labels, members, prose, calls and decorators, comprehension and lambda scopes, `del`, Go `var` / `const` lists and blocks, the stdlib table, the screenshot fixture, linear cost on comprehension, lambda and func-typed-parameter inputs, phase independence, the handover to a provider, the typing debounce; band 2 resolving imports per occurrence ([docs/import-restore.md](docs/import-restore.md)) |
| `test/shadows.test.js` | the shadow restore: the screenshot fixture, calls, labels, attributes, module-level rebinding, the flow rule at module and class level (loops, `while` conditions, `for` iterables) and its absence in functions, comprehension and lambda scopes, class bodies, nested functions, `global` / `nonlocal`, every binding form (`for` targets after a dot or in a subscript, `*a, b`, `as (a, b)`, PEP 695 parameters, multi-line return annotations), unclosed brackets, linear cost on a long module-level block, `def` / `class` names and imports, header defaults, decorators, Go; the resolver rules it brought to the import restore, imported-and-rebound names included; phase independence, colour, handover, typing debounce, band-2 precedence, no overlap with the import restore ([docs/shadow-restore.md](docs/shadow-restore.md)) |
| `test/palette.test.js` | band-2 palette invariants: one chroma, even perceived lightness, WCAG 4.5:1, closest-pair distance; escape and async marks off the error hue ([docs/palette.md](docs/palette.md#invariants)) |
| `test/intervals.test.js` | the indexed lookups (interval index, enclosing and outermost function, shadow clipping, interpolation holes, top-level lines) against the linear scans they replaced, on random inputs |
| `test/lua.test.js` | Lua: the lexer table (long brackets, `\z`, `//`, shebang, numerals), the keyword block scan, bindings and lexical visibility, modules and namespace globals, both classifiers on real lua-language-server tokens, escape marks, no async or comment clay, the module and shadow restores staying on with the server and through typing, half-typed `<const>` attributes, `string.format` placeholders under a keyword-on capture, linear cost ([docs/lua.md](docs/lua.md)) |
| `test/ruby.test.js` | Ruby: the lexer (`=begin`, `__END__`, holes, %-literals, heredocs, regex versus division, the local-variable table, symbols, labels and sigils, operator method names), relex over random edits, the keyword block scan (endless defs, branches, modifiers, hashes after a ternary `?` or `!` too, `end` in literals), bindings by Ruby's lexical rule, both classifiers on real ruby-lsp tokens, a `name!(` call, escape marks, no async marks, the shadow, `self` and `#{` / `}` restores, an `.erb` file opened as Ruby, linear cost ([docs/ruby.md](docs/ruby.md)) |
| `test/javascript.test.js` | JavaScript and TypeScript: the lexer against TypeScript's parser on every edge and every regex-or-division position (a `/` after an `if`, `while`, `for` or `with` header and after `of` as a name the documented differences), heuristic declarations and non-data initializers, keys and labels, the module surface, `self`, the namespace restore's statement shapes, uses, JSX tag names and handover on real tsserver and Deno captures, ES5 constructors and a UMD wrapper, focus in patterns, destructured parameters and one-line arrows (other languages unchanged), template-hole and JSDoc restores, declaration files, the React ids, `jsconfig.json` and `deno.json` ([docs/javascript.md](docs/javascript.md)) |
| `test/html.test.js` | HTML: script regions against VS Code's HTML grammar (types, templates, comments, `<style>`, `<svg>`, `<math>`, an unclosed start tag), the script view's offsets and lines, no string or brace across scripts, the template extensions as static content, nothing painted outside a script in any phase with the HTML server's tokens and without, Survey in the markup and Focus and Edit in a script, tints and escape marks, `this` and the namespace restore, the classifier's own view, and every block painting as the same code in a `.js` file, `samples/sample.js` with its real tsserver tokens included ([docs/html.md](docs/html.md)) |
| `test/components.test.js` | JSX, Vue, Svelte and Astro: each fixture's code regions, checked by identifier against each framework's parser, the code view's offsets, lines and marks read back, no mark on a line break, each framework's edge rules (`v-pre`, `lang="pug"`, a `src` script, a dynamic argument, a non-JavaScript script, `is:inline`, `is:raw`, a `<` that opens no tag, the frontmatter only at the start, a Vue template's end past a `<template>` in a comment, a value or a mustache, a `{` or `{{` typed before a word as text, an each key with a call), nothing painted outside a code region in any phase with server-shaped tokens and without, Survey in the markup and Focus and Edit in an expression, one identity across script and template, `{#each}` and `v-for` blocks and their aliases, destructuring patterns and what their keys, defaults and types leave out, an Astro client script as a module of its own, JSX tags and components, the `Astro` global, danger marks, shorthand attributes, linear cost in the markup, a `<style lang>` body in SCSS, LESS, Stylus or PostCSS as markup, the band-1 restores per id and markdown fences ([docs/components.md](docs/components.md)) |
| `test/php.test.js` | PHP pages: regions from each open tag to its `?>` past strings, `{$…}` holes, heredocs, nowdocs and block comments, a line comment ending at `?>`, `#[` as an attribute, the view's offsets, lines and marks read back, PHP's lexing (`#` comments, multi-line strings, heredocs and nowdocs, `$name` and `{$…}` holes), Survey in the markup and on its scripts, tints on a block's variables with the `$` left to the theme and on a string's holes, clay numbers, no paint in the markup, a comment or a string, no async or `self` mark, the lex after an edit that moves a region's end equal to a fresh one, an unclosed heredoc's last hole, linear cost on comment-dense and tag-dense pages ([docs/php.md](docs/php.md)) |
| `test/swift.test.js` | Swift, Objective-C and Metal: the Swift lexer (holes, raw strings, regex literals, `#` words, backtick names), the facts with no server and over real sourcekit-lsp tokens (labels, properties, closures, `$0`, `guard`, `case` patterns, implicit names), nothing leaking across functions and no repaint when the server answers, danger marks, the operator, subscript, attribute and static-call restores and their linear cost, Objective-C method scopes, selectors, bridge casts and `performSelector:`, an Objective-C header as `cpp`, the constant and qualifier restores, sourcekit-lsp's Objective-C legend, Metal's keywords, and the Apple build and data formats as static content ([docs/swift.md](docs/swift.md), [docs/c-jvm.md](docs/c-jvm.md#objective-c)) |
| `test/cjvm.test.js` | C, C++, Java, Kotlin and Groovy: data identities with no server and on real cpptools, clangd, jdtls and kls tokens (macro bodies, typedefs and members; template parameters; `const noexcept` and wrapped method tails; Java fields, lambdas and patterns; Kotlin expression bodies, constructor parameters and properties; Groovy `def`, closures and GString holes), cpptools' missing `declaration`, its cancelled requests and its first-batch answers asked again, jdtls's and kls's tokens sent out of order, a read after a Java, Groovy or Kotlin `->`, kls's `$name` tokens and local properties, no shorthand read in these languages, the `this` / `self` paint per language, the `NULL` / `true` / `false` / `bool` and Kotlin `$name` restores, the type-body test's header reads per keystroke, danger marks on the casts, CMake and Gradle as static content ([docs/c-jvm.md](docs/c-jvm.md)) |
| `test/shell.test.js` | shell and fish: the lexers against shfmt 3.14.1 (`walk.sh` and a constructs fixture, every variable at shfmt's offsets) and fish-lsp 1.1.5 (`walk.fish`), heredocs, quotes, holes, comments at a word start, numbers where the grammar paints a numeral, zsh's flags, modifiers and closing `}`, the writes and their builtins and scope options, the keyword block scans (branches and case arms as siblings, reserved words only at command position, a function named like a keyword), the bindings by each shell's rule, both classifiers agreeing on fish-lsp's tokens, the danger marks, no async or escape mark and no `self` or delimiter paint, notebooks dropping the other cells' answers on a structural or text change and not on an output, linear cost ([docs/tooling.md](docs/tooling.md)) |
| `test/classify-join.test.js` | a second classify of the block and version in flight joins it, so the caller that awaited it sees its plan; a new version still supersedes it ([docs/runtime.md](docs/runtime.md#one-fetch-per-document-version)) |
| `test/zig.test.js` | Zig: the lexer against Zig's own tokenizer (comments, `\\` lines, chars, `@"…"`, `@builtins`, numerals), relex over random edits, the brace scan and header kinds (every `fn` prefix, `test`, containers, captures in control flow), the naming rules, the heuristic's facts (labels, fields, type parameters, type and namespace consts across blanks and comments, captures and bars that are none, aliases), both classifiers on real zls `partial` and `full` tokens, escape marks through `.*`, danger marks on the pointer casts, no async marks, clay in code only, the `self` paint, the namespace restore, its scope (a sibling scope's parameter, a field) and its handover, placeholders under `full`, ZON as static content, linear cost ([docs/zig.md](docs/zig.md)) |
| `test/perf-golden.test.js` | output equivalence on generated 2k and 10k-line TS, JS, Go, Rust, Python, Lua, Ruby and Zig files: lex, blocks, regions, file index, classifications, colourings, plans, traces, risk ranges and a decorator session, each hashed against `test/fixtures/perf-golden.json` |
| `test/transitions.test.js` | transitions between states: seeded random walks over editor, server, theme and settings events, and walks that delete a docstring's closing quote and type it back, walks over `walk.lua` and walks that delete its long comment's last `]` or an `end`'s `d` and type it back, the same over `walk.rb` with its heredoc terminator, walks over `walk.js` with tsserver- and Deno-shaped answers, walks over `walk.zig` and `walk.zon` with zls-shaped answers and walks that delete a Zig string's `"`, a `\\` line's backslash or a `}` and type it back, walks over `walk.c`, `walk.cpp`, `walk.java`, `walk.kt` and `walk.groovy` with clangd-, cpptools-, jdtls- and kls-shaped answers beside CMake, a Gradle script in either DSL, `walk.ts` or `walk.py`, walks over the four chat customisation files and `walk.jmd` beside a code file, walks over `walk.sh`, `walk.zsh` and `walk.fish` beside another shell file, a code file, `walk.md` or SQL, a diff, a rebase todo, Protobuf or buf's config, and walks that delete a heredoc terminator's last letter, a quote, the last letter of `fi`, `done`, `esac` or `end`, or a hole's `}` or `)` and type it back, walks over a Dockerfile, a Bake file, a Helm template and Kubernetes manifests beside a code file, walks over `walk.html` that type script tags and markup, beside `walk.js`, `walk.ts`, `walk.md`, `walk.xml`, `walk.hbs` or `walk.css` as `css` or `tailwindcss`, with nothing painted outside a script, walks over `walk.php` that type PHP tags, quotes and comment openers, with nothing painted outside a PHP region but a stripe over a block bridging two regions, walks over the stylesheets, `walk.graphql` and the Razor pages beside a code file, walks over `walk.mdx` with the link cancel only, walks over `walk.vue`, `walk.svelte`, `walk.astro`, `walk.tsx` and `walk.jsx` that type region boundaries, template blocks and markup, beside another component, `walk.ts`, `walk.html`, `walk.md` or `walk.css`, with nothing painted outside a code region but a focused template block's stripe, and the `{#await}` walk of seed 4753 that found that case, every step compared with a fresh Decorator given the same final state, and one or two data files (KDL and ten config formats), in a quarter of them, required to show nothing at all and a prose file at most the markdown marks, and no request made about either; a code file in Edit switched to each data and markdown-derived file, ZON included, and back; the leftovers they found as shrunk walks; how decorations move with edits, forced and unforced, against a port of VS Code's rule. Runs through the `require` at the end of `test/runtime.test.js` ([docs/runtime.md](docs/runtime.md#transitions)) |

How far the suite pins the code (a mutation audit, per mutant in
[docs/mutation-audit.csv](docs/mutation-audit.csv) and, for Lua, Ruby, JavaScript, Zig, HTML, components, PHP, MDX and the static ids,
[docs/mutation-audit-lua.csv](docs/mutation-audit-lua.csv),
[docs/mutation-audit-ruby.csv](docs/mutation-audit-ruby.csv),
[docs/mutation-audit-javascript.csv](docs/mutation-audit-javascript.csv),
[docs/mutation-audit-zig.csv](docs/mutation-audit-zig.csv),
[docs/mutation-audit-html.csv](docs/mutation-audit-html.csv),
[docs/mutation-audit-components.csv](docs/mutation-audit-components.csv),
[docs/mutation-audit-php-mdx.csv](docs/mutation-audit-php-mdx.csv) and, for shell, fish and the tooling ids,
[docs/mutation-audit-tooling.csv](docs/mutation-audit-tooling.csv)), how its timing checks hold
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
python3 -I test/gen-sh-ref.py bash test/fixtures/shell/constructs.sh > test/fixtures/shell/constructs.sh.ref.json
python3 -I test/gen-sh-ref.py bash test/fixtures/transitions/walk.sh > test/fixtures/shell/walk.sh.ref.json
node test/gen-fish-semtok.js test/fixtures/transitions/walk.fish > test/fixtures/shell/walk.fish.lsp.json
```

The shell references are shfmt's syntax tree, not a language server's tokens:
bash-language-server sends none ([docs/tooling.md](docs/tooling.md#language-servers)).

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
  workflows, TOML, KDL, INI, `.gitignore`-style ignore files, Dockerfiles, Compose
  and Bake files, Helm, Go and Handlebars templates, Razor pages, CSS (Tailwind's
  `tailwindcss` mode too), SCSS, LESS, Stylus, PostCSS, GraphQL, XML and the rest
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
  `.dockerignore` a number in a comment turned clay. Before `helm` was listed, a
  click in a chart template did the same: over 112 templates (109 from public charts
  and `helm create`, 3 synthetic), 517 tints all landed on YAML keys and words
  (`value`, `metadata`, `mountPath`), none on a Go template variable, and
  `.Values.self` took the self mark ([docs/containers.md](docs/containers.md#helm)).
  A ZON file opens as `zig`, the Zig extension's one id; the layer reads a `.zon`
  file as `zon`, static content ([docs/zig.md](docs/zig.md#zon)). CMake is
  static content, and so is a Gradle build script in either DSL: `build.gradle`
  opens as `groovy` and reads as `gradle`, `build.gradle.kts` opens as `kotlin` and
  reads as `gradle-kts`, each keeping its language's band 1; with redhat.java
  installed it opens as `gradle-kotlin-dsl`, static too, with no band-1 restore.
  Before, a click in `CMakeLists.txt` took Focus and asked the server for symbols,
  and a click in a `gradle-kotlin-dsl` build script took Focus
  ([docs/c-jvm.md](docs/c-jvm.md#static-content)). Before
  `tailwindcss` was listed, a stylesheet under Tailwind's recommended `*.css`
  association took Focus, the stripe and clay numbers on a click, and before
  `handlebars` was, a click in a `.hbs` page's markup did the same
  ([docs/html.md](docs/html.md#ids)); before `postcss` and `razor` were, a
  stylesheet csstools.postcss opened and a Razor page did too
  ([docs/stylesheets.md](docs/stylesheets.md), [docs/php.md](docs/php.md)). SQL,
  a diff, a rebase todo, Protobuf (`proto3` under zxh404.vscode-proto3, `proto`
  under bufbuild.vscode-buf) and buf's config are static content too: a table's
  columns are schema, a diff and a todo hold another file's text, and buf's
  server types no Protobuf name as data. Before, a click in a `.sql` file made the
  whole file one scope, with 24 tints on columns, tables and the keyword `IF`;
  a diff's `self` and `this` took the receiver paint over the inserted and deleted
  colours, and a rebase todo's hashes turned clay ([docs/tooling.md](docs/tooling.md#static-content)).
  The Apple build and data formats (`.strings`, `.xcconfig`, Xcode projects, property
  lists, gyb templates and DocC tutorials) are static content too
  ([docs/swift.md](docs/swift.md#static-content)).
- **A PHP page is markup around PHP.** The PHP between each open tag and its `?>`
  is code, lexed and block-scanned as one text with the markup blanked, so a
  brace pairs across `?>` and `<?php`; the markup has no scope, and its
  `<script>` elements are markup. A tint leaves the `$` to the theme; no async or
  `self` mark ([docs/php.md](docs/php.md)).
- **MDX is prose.** Its prose links lose the underline as a markdown file's do,
  its ESM, expressions and JSX tags excepted; it takes no wash, since the theme's
  `==highlight==` scope does not reach `source.mdx` ([docs/mdx.md](docs/mdx.md)).
- **An HTML document is markup around scripts.** Each `<script>` the HTML grammar
  paints as JavaScript is JavaScript to the layer, lexed and scanned on its own
  with the markup blanked around it, so offsets and lines stay the document's. The
  markup has no scope: a caret or a keystroke there is Survey. Over 18 public pages
  with scripts the same code paints the same as in a `.js` file, with the HTML
  server's tokens and without, and nothing paints outside a script
  ([docs/html.md](docs/html.md)).
- **A component is markup around code.** A Vue, Svelte or Astro component's
  scripts, Astro frontmatter and template expressions are code, read through the
  same view; the rest is markup, outside every scope. Before, the whole file was
  code: in 130 public components a click anywhere entered Focus, and 1,096
  paints with the servers' tokens and 2,364 without landed on text, attribute
  names, CSS and comments. Now none does. A JSX tag is markup inside the code, so
  `<p>` no longer tints with a local `p` ([docs/components.md](docs/components.md)).
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
  ([docs/ruby.md](docs/ruby.md)). Shell was read with `#` comments and one
  string rule: 36,071 of 55,621 heredoc characters were code, every word was an
  identifier, and the brace scan found 1,076 of 3,262 compound commands over 420
  public scripts. Shell and fish have lexers of their own, whose identifiers are
  variable names only, and `scanShellBlocks` and `scanFishBlocks`, which read
  the reserved words at command position: 3,262 of 3,262, and fish's 1,963
  blocks where the brace scan found none of them ([docs/tooling.md](docs/tooling.md)).
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
