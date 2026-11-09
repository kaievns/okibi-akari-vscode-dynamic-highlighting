# The shared lexer

`src/lex.ts` is the only place that decides what is code, comment, docstring or
string. Every scanner reads its result: block scanners, the identifier stream,
risk marks, format placeholders and the classifiers. Before it existed the layer
had 13 private state machines that disagreed with each other. Only one of them
knew what a Python comment looked like, so comments and docstrings collected
clay numbers, `as`/`any` marks, escape underlines, `self` paint and identity
tints.

## Interface

```ts
lex(text, languageId?): LexResult      // pure, one O(n) pass
lexFor(text, languageId?): LexResult   // memoised on (text, syntax)
relex(prev, text, start, oldEnd, newEnd): LexResult | null  // one change; see Incremental re-lex
syntaxFor(languageId?): LangSyntax
```

| Field / method | Meaning |
|---|---|
| `spans` | sorted, non-overlapping non-code spans, region `comment` / `doc` / `string` |
| `holes` | code regions inside strings: `${…}`, f-string `{…}`, Kotlin `$x` / `${…}`, Ruby `#{…}` / `#@x` / `#$x` |
| `idents` | code identifiers in document order, holes included |
| `numbers` | code numeric literals |
| `punct` | offsets of code `{ } ( ) [ ] , ; :` |
| `lineStarts` | the first offset of every line; every `\n` counts, escaped or not |
| `isCode`, `regionAt`, `spanAt` | O(log n) region lookups |
| `identsIn`, `numbersIn`, `punctFrom` | binary-searched slices for a region |
| `holeEndAt(offset)` | end of the innermost hole containing `offset` |
| `enclosingOpen(offset)` | the innermost unclosed code `(`, `[` or `{` before `offset`, else -1; built lazily from `punct` |
| `prevSignificant(offset)` | the last non-blank char before `offset` outside comments and docstrings, else -1 |
| `lineOf(offset)` | 0-based line |

Hole delimiters (`${`, `{`, the closing `}`) sit in the string spans, so they never
count as block braces. The expression inside a hole is code. A Python f-string
field's `!conversion` and `:spec` sit in the string spans too, and a field nested
in a spec is a hole of its own; `pythonPlaceholderSpans` reads each field's marks
from that layout.

## Per-language rules

| languageId | Comments | Strings | `'` | Extras |
|---|---|---|---|---|
| `typescript`, `typescript-declaration` | `//`, `/* */`, `#!` at offset 0 | `'` `"` single-line; `` ` `` multi-line with nested `${}` | string | regex literals in expression position; `#name` is an identifier |
| `javascript`, `javascriptreact`, `typescriptreact` | same | same | string | same, plus JSX: text children and attribute strings are `string`, `{…}` is code |
| `go` | `//`, `/* */` | `"` single-line; `` ` `` raw, multi-line, no escapes | rune | — |
| `python` | `#` | prefixes `[rRbBuUfFtT]{1,2}`; `'` `"` single-line; `'''` `"""` multi-line; `f`/`t` holes with `!conv` and `:spec` (nested fields), `{{` literal, `\N{…}` named escape | string | a triple-quoted, non-f string in statement position is `doc`; `\` + newline in code continues the line |
| `rust` | `//`, `///`, `//!`, nested `/* */` | `"` `b"` `c"` multi-line with escapes; `r#*"…"#*`, `br`, `cr` raw | char or lifetime | `'x'`, `'\''`, `'\u{…}'`, `'\x41'`, `b'x'` are chars; `'a`, `'static`, `'outer` are lifetimes (code, not identifiers); `r#ident` is one identifier |
| `c`, `objective-c` | `//` (a trailing `\` continues it), `/* */` | `"` single-line (`\` + newline continues); `u8` `u` `U` `L` prefixes | char | `#` at line start is a directive: the directive name is not an identifier, `#include <x>` is a string, `#if 0` up to its `#else`/`#elif`/`#endif` is a comment; `1'000` digit separators |
| `cpp`, `cuda-cpp`, `objective-cpp` | same | same, plus `R"d(…)d"` raw (with prefixes) | char | same |
| `java` | `//`, `/* */` | `"` single-line; `"""` text block | char | — |
| `kotlin` | `//`, nested `/* */` | `"` single-line with escapes; `"""` raw (closes on the last 3 of a quote run); both interpolate `$name` and `${…}` | char | `` `name with spaces` `` is one identifier |
| `swift`, `scala`, `dart` | `//`, nested `/* */` | `'` `"` single-line; `"""` multi-line | string | — |
| `shellscript` | `#` at word start | `"` multi-line with escapes; `'` multi-line, no escapes | string | — |
| `perl`, `r`, `julia`, `elixir`, `coffeescript`, `powershell` | `#` | `'` `"` multi-line with escapes | string | — |
| `lua` | `--`; `--[[ ]]`, `--[==[ ]==]` (matching `=` count); `#!` at offset 0 | `'` `"` single-line with escapes, `\` + newline and `\z` + blanks continue it; `[[ ]]`, `[==[ ]==]` multi-line, no escapes | string | `//` and `#` are operators; hex fractions, a trailing dot and LuaJIT suffixes stay in the numeral ([lua.md](lua.md#lexer)) |
| `ruby` | `#`; `=begin` … `=end` at column 0; everything after a top-level `__END__` line | `'` `"` `` ` `` multi-line with escapes, `#{}` / `#@x` / `#$x` holes in `"` and `` ` ``; `%`-literals with any delimiter and nesting; heredocs, bodies read at the line break; `/re/` and `?a` where an expression starts or as a command argument; symbols and `"key":` labels | string | `@x`, `@@x`, `$x`, `name?` / `name!` are one identifier; `//` is an empty regex where an expression starts ([ruby.md](ruby.md#lexer)) |
| anything else | `//`, `/* */` | `'` `"` single-line; `` ` `` multi-line with `${}` | string | no `#` comments, no lifetime rule |

On JavaScript and TypeScript the regions match TypeScript's own parser on every
character of 2,370 files, 14.2 million non-space characters
([javascript.md](javascript.md#measurements)).

A single-line string or char that hits a line break ends there unterminated, so a
stray quote costs one line, not the rest of the file. An unterminated `${` or `{`
hole in a single-line string also ends at the line break. Line comments end before
`\r\n`. Identifiers follow `ID_Start` / `ID_Continue` plus `_`, `$`, ZWNJ and ZWJ,
including astral code points.

Numeric literals: decimals, `0x`/`0b`/`0o`, `_` separators (C/C++ `'` too),
exponents, hex floats (`0x1.8p3`), and a leading-dot float (`.5`): in JS/TS in
expression position, elsewhere unless the code before the dot ends an operand (so
Python `return .5` clays `5`). The literal includes its suffix (`123u32`, `1.0f`,
`10n`, `10L`, `2i`), matching rust-analyzer's single `number` token; Python takes
only a `j` / `l` suffix, so `1if x else 2` keeps its keyword. A digit run right
after a member dot (`pair.0`, `t.0.1`, `f().2`) is a tuple field, not a number:
rust-analyzer types it `property`.

## Caching and cost

`lexFor` keeps the last 4 (text, syntax) results. A string compare on a hit is a
pointer check when the caller passes the string the memo holds, which every
caller does for one version: the decorator's `docStateFor` holds `{ version,
text, lex, blocks }` per document version and hands the same text to the
scanners and the classifier. One version is therefore lexed once, however many
consumers ask. A hit can also come from an equal text held as another string: a
file closed and reopened, or a second document with the same content. The memo
then adopts the caller's string, so its next lookups are pointer checks again.
Before, every lookup compared all 1.4 million characters (0.06 ms each), and the
first classification of such a 50k-line TS file spent 2.4 s in them, through the
per-block `functionScopeOf` loop over 10,098 blocks. Per-version
derived data is cached beside it: `self` and comment-restore ranges and the
top-level carve-out (excludes and gutter lines) in the decorator, the heuristic
classifier's file-wide occurrence and declaration maps per `LexResult`, the
semantic `FileIndex` (which carries `lex`) per LSP bundle, block headers per
`LexResult` and block, and the top-level excludes and the open-sorted block list
per block list. `bundleFor` takes the cached blocks instead of rescanning, and
token decoding reuses the lex's `lineStarts`.

Region queries are binary searches, so their cost is the region's size, not its
offset. Before the shared lexer every region lex rescanned from offset 0, and
Rust's macro pass paid one prefix lex per macro call: `buildFileIndex` took
18.1 s on a 50k-line file. `holeEndAt` answers from an interval index built on
first use (`src/intervals.ts`); a scan back over every earlier hole made each
concise-arrow body end cost O(holes).

On a 50k-line file (1.1 to 1.4 million characters) a full lex costs 5 to 13 ms
and the block scan on top of it 2 to 10 ms, both in the first render of a
version. After a keystroke the lex is a re-lex instead, 1.3 to 3.3 ms
([Incremental re-lex](#incremental-re-lex)). `bangCalls` finds every `name!(`
from each `!` in 0.06 to 0.18 ms, where the regex it replaces,
`/(?<![.\w])([A-Za-z_]\w*)!\s*([([{])/g`, took 3.6 to 4.3 ms over the whole text in
every `buildFileIndex` and every Rust keystroke. Per stage and end to end, per
input size: [runtime.md](runtime.md#cost-on-large-files).

## Incremental re-lex

`relex(prev, text, start, oldEnd, newEnd)` derives a version's lex from the
previous one when a single change separates them, which is what a keystroke is.
The top-level loop records its state at every line start it reaches (`cpOff`,
`cpState`): whether an expression or a statement may start there, the brace depth
and the bracket depth, and in Ruby the indentation of the open `def`, if any. The
re-lex resumes at the line start one line above the
edited line (a decision on the line above can peek a character or two past its
line break), in the state recorded there, and stops at the first line start past
the change whose state equals the previous lex's at the shifted offset. The result
is the previous prefix, the re-lexed middle and the previous suffix moved by the
length change.

That equals a full lex because the recorded state is all the lexer carries across
a top-level line start, and nothing it decides looks further back than its own
line, except Ruby's local-variable table ([ruby.md](ruby.md#lexer)). Its names
outside every `def` are recorded with the offset where each entered
(`localOffsets`, `localNames`), and the re-lex starts with the ones before its
start; a `def`'s own table is not recorded, so inside a `def` the re-lex resumes
at the line start before the `def` that opened it (`defStarts`) and rebuilds it,
and it stops only at a line start outside every `def` where the names added since
its start equal the previous lex's. Anything that spans lines (a block comment, a multi-line string, a hole, a
JSX element) consumes its line breaks itself, so no line start inside it is
recorded and a change inside it re-lexes from before it. Ruby heredoc bodies
are read at the line break that ends their opener's line, before that line
start is recorded, so they count as such a span. Three decisions read more
than a line ahead and leave no span over what they read:

| Decision | What it reads | Re-lex |
|---|---|---|
| JSX (`javascript`, `javascriptreact`, `typescriptreact`) | to the closing tag, or to the end of the file before it rolls back: an unclosed `<div>` lexes every later line as code, and a `</div>` typed far below turns all of them into JSX text | never; always a full lex |
| a Rust `'\u{` that is not a char literal | to the first `}` after it and the character after that | resumes above it when that read reaches the change (`longReads`) |
| a Ruby `def` or lambda parameter list in parentheses, for the local-variable table | to its `)`, at most 4,096 characters | the same |

Random edits rarely build the first case: 16,200 of them over 540 real files,
JSX ones included, never did. `test/lexer.test.js` compares re-lex and full lex
on every array over 4,750 chained random edits to the samples and the transition
fixtures (4,221 re-lexed; for the rest no line start was recorded above the
edited line, mostly once an edit opened a string that runs to the end of the
file), and on the first two cases above. `test/ruby.test.js` does the same for
Ruby over 300 chained edits that also add and remove assignments, parameters,
`def` and `end` lines, the local-variable table included.

The decorator keeps the previous version's lex for a document an editor shows,
and the next render consumes it. Two edits before a render, or one event with
several changes, get a full lex.

At 50k lines a re-lex costs 1.3 to 3.3 ms against 5 to 13 ms for a full lex:
less the later the change, since the suffix's objects are copied with their
offsets moved (CPU time, median of 9, Apple M3 Pro, Node 26.8.2; per language in
[runtime.md](runtime.md#cost-on-large-files)). Recording the line-start states
leaves a full lex within run-to-run noise (0.83 to 1.22 times the time without),
and holds four numbers per top-level line, 1.8 MB per 50k-line document
([runtime.md](runtime.md#memory)).

Every identifier name in a re-lex is cut from the new text. V8 copies a slice
shorter than 13 characters and points a longer one into the string it was cut
from, so a name kept from the previous lex keeps that version's text alive, and
through the names that lex kept, the versions before it. Kept as they were, 40
edits at increasing lines of the 50k-line generated Rust input, each re-lexed,
grew the heap by 107.0 MB; with the prefix's names of 13 or more characters cut
again, by 3.5 MB, against 2.7 MB for a full lex each time (heap after a full GC
and three event-loop turns, Node 26.8.2). The decorator turned most of those
names into internalised strings by using them as object keys, which hid the
growth there. Cutting the long names again costs nothing measurable on the
generated inputs, which have at most 1,002 of them per 50k lines; on a 50k-line
file where every name but `let` is that long, a re-lex 95% into the file costs
3.9 to 4.0 ms instead of 1.8 to 1.9 (CPU time, median of 15).

## Consumers

| Consumer | Reads |
|---|---|
| `scanBraceBlocks` | code `{`/`}` from `punct`; lines from `lineStarts` |
| `scanArrowBlocks` | JS and TS only: `=>` where `isCode`; body end walks `punct`, bounded by `holeEndAt`, and stops at a depth-0 code newline that no operator continues; TS `=>` in type position skipped (`typeArrowsOf`: `prevSignificant`, `enclosingOpen`) |
| `scanIndentBlocks` | per line: bracket depth from `punct`, continuation when the line break is in a string or follows a code `\`, last depth-0 code `:` |
| `scanPyExprBlocks` | code brackets plus code `for` / `lambda` identifiers; a lambda body ends at a code line break, a comment, or a depth-0 `,` / closer |
| `scanRustClosures` | the bar must be code; the body end walks `punct` and stops at a `//` comment |
| `scanLuaBlocks` | code block keywords from `idents` not after a member `.` / `:` (`prevSignificant`); a function's parameter list and an `until` condition's end from `punct` |
| `luaFacts` | `idents` for declarations and one resolution sweep; neighbours by `prevSignificant`, comments skipped by `spanAt`; `require` arguments by their `string` span; table keys by `enclosingOpen`. Once per lex |
| `scanRubyBlocks` | code block keywords from `idents`, not after `.` / `::` or before a label colon; `{` / `}` from `punct`, a block or a hash by `prevSignificant`; header ends walk `punct` and `idents` to `then` / `do` / `;` or the logical line end |
| `rubyFacts` | `idents` for declarations and one resolution sweep over the scopes of `scanRubyBlocks`; parameter lists and patterns by character walks that skip non-code spans (`isCode`, `spanAt`); members by `prevSignificant`; named regex captures from the regex's `string` span. Once per lex |
| `lexIdentifiers` | `identsIn` (thin wrapper, kept for tests and callers) |
| `buildFileIndex` | `idents` for `self`, `macroArgRanges` over code `name!(` (found by `bangCalls`; Rust only) with `punct` matching, `typeDeclRanges` / `pyClassFieldRanges` (Python only) only on code keywords, function-type parameter lists from `typeArrowsOf` |
| `classifyFromSemantic` / `classifyFromHeuristic` | `identsIn` for the block; the heuristic's candidates and declarations once per lex and language, from `prevSignificant`, `enclosingOpen` and `punct` |
| `headerOf` / `paramListStart` | a wrapped header's start from `punct` paren matching or the Rust item walk; the first code `(` after a function keyword from `idents` |
| `lexicalRisk` | `identsIn` ∩ {async, await}, per-language danger rules over `prevSignificant`, `enclosingOpen` and `punct`, `numbersIn` |
| `escapeRisk` | `identsIn` outside excluded ranges; targets via `punct`, `enclosingOpen`, `prevSignificant` |
| `isArgLabel` | `prevSignificant`, `enclosingOpen` |
| `pyScopeAt` | per line: indentation, `isCode`, `enclosingOpen`, a code `\` before the line break; once per lex |
| `importUseSpans` / `pyImportOffsets` | Python: code `import` / `from` at statement start (`prevSignificant`, `enclosingOpen`), the statement end, lambda bodies and `del` targets by character walks that skip non-code spans (`isCode`, `spanAt`), comprehension brackets matched over `punct` with clause keywords at their own depth (`enclosingOpen`), `identsIn` per statement, suites from `pyScopeAt`. Go: `import` idents, each path's `string` span, function headers by a character walk that skips non-code spans, `punct` for the `( … )` list, `var` / `const` blocks and function bodies. Once per lex |
| `rustPlaceholderSpans` | the format-string argument of a code `name!(` or `#[error(` (found by `bangCalls` and `errorAttributes`), split on depth-1 code `,` from `punct`; a `string` span that is the whole argument |

`markdown.ts` keeps its own markdown-specific span scanner.

## Known limits

- Not a parser. Regex detection uses the previous significant token: after `)` a
  `/` is division, so `if (x) /re/.test(s)` lexes the regex as two divisions, and
  so after `while (…)`, `for (…)` and `with (…)`. `of` before `/` starts a regex
  even where it is a name. None of the 2,370 measured files writes either
  ([javascript.md](javascript.md#known-limits)).
- JSX starts at `<` in expression position followed by a name or `>`. `<T,>` and
  `<T extends …>` are left as generics. A tag that does not parse, or an element
  never closed before end of file, rolls back and lexes as code.
- A Python docstring is any triple-quoted, non-f string in statement position, so
  a bare `"""…"""` expression statement anywhere is `doc`. Single-quoted bare
  strings stay `string`.
- C/C++ directive detection treats `#` as the first non-blank char of a physical
  line; a directive started on a `\`-continued line is not recognised. `#if 0`
  ends at the first `#else`, `#elif` or `#endif` at its own nesting depth.
- Rust format placeholders (`{}`, `{name}`) are string content, not holes, so an
  inline format argument is not an identifier here. rust-analyzer still emits a
  token for it once it expands the macro, and `rustInlineArgs` finds the capture
  when it does not; the block use count adds either
  ([classification-rules.md](classification-rules.md#classification-classes)).
- Holes nest at most 64 deep; deeper `${` or `{` are treated as text.
- Shell `$` and `${` lex `$` as an identifier.
