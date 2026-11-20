# Lua

Lua (`lua`, VS Code's built-in `source.lua` grammar; lua-language-server through
`sumneko.lua`) is a code language: keyword-delimited blocks, data identities,
escape marks and band-1 restores. `src/lua.ts` holds the bindings, `src/lex.ts`
the lexer family, `scanLuaBlocks` in `src/focus.ts` the blocks. Tests:
`test/lua.test.js`, plus Lua in the relex parity, the comment sweep, the
perf-golden inputs and the transition walks.

VS Code 1.144.1 and `sumneko.lua` 3.19.2 associate only `.lua` (`sumneko.lua`
adds `.luarc.json` and `config.json`, as `jsonc`). The Okibi and Akari theme
associates `*.rockspec`, `.luacheckrc` and `.busted` with Lua, so with it
installed they open as `lua` and the layer engages as in any Lua file: a
rockspec is a chunk of global assignments, each its own data, with no escape
mark. Without the theme they open as `plaintext`, and the layer paints nothing
there. A ```` ```lua ```` fence in markdown is prose.

## Measurements

The reference is lua-language-server 3.19.2's own parser, run on 1,188 files:
the Neovim runtime (169), LuaJIT `jit/*.lua` (19), lpeg `re.lua`, the server's
`script/` (247) and `meta/` (674), 4 synthetic files, and 74 private files
counted only. LuaJIT and Neovim files parse as `LuaJIT`. 10 LuaJIT files use
the rolling build's C-style operators, which the parser rejects, so the scores
cover 1,178. The runs drive the real `Decorator` under the stub: carets
at the first reference inside each function and block, then Focus and Edit,
with captured server tokens and with none.

| What | Before | Now |
|---|---|---|
| comments, strings, numerals with the parser's bounds | 0 of 123,623 comments; 1,989 strings missed, 22,514 invented; 6,495 extra numerals | 123,622 of 123,623; 32,102 of 32,102; 11,246 of 11,246 |
| scopes with the parser's first and last line | 16 of 31,709 | 31,688 of 31,709 |
| carets in a function or block that focus its scope | 161 of 3,665 | 3,663 of 3,665 |
| tints right / wrong, server tokens | 18,715 / 73,351 | 72,471 / 2 |
| tints right / wrong, no server | 53,365 / 360,837 | 63,127 / 2 |
| escape marks right / wrong, server tokens | 5,240 / 4,895 | 2,297 / 55 |
| expected writes marked, server tokens | 342 of 2,242 | 2,188 of 2,242 |
| clay / `self` paint in comments and strings | 18,071 / 9,855 | 0 / 0 |
| async marks | 5,967 | 0 |

The one comment differs only in the measurement's byte-to-UTF-16 mapping over
a Latin-1 byte. The 21 scopes end in a comment-only line the parser counts and
the scan does not; one of the 2 carets is such a branch, the other sits on the
header line of a nested function, which the scan focuses. The 2 tints are one
chunk-level global, `counter`, painted inside a closure while the top level is
focused.

## Lexer

| Form | Region |
|---|---|
| `--` to the line end, `---` LuaCATS lines included | comment |
| `--[[ … ]]`, `--[==[ … ]==]` (the `=` count must match) | comment |
| `'…'`, `"…"`: escapes; `\` + line break and `\z` + blanks continue the literal | string |
| `[[ … ]]`, `[==[ … ]==]`, no escapes | string |
| `#!` at offset 0 | comment |

`//` is floor division and `#` the length operator; neither starts a comment.
Numerals take hex fractions and exponents (`0xA.8p-1`, `0xA.8`), a trailing dot
(`100.`) and LuaJIT suffixes (`0xffULL`, `12LL`, `3i`). No interpolation holes.

## Blocks

`function … end`, `do … end`, `for` / `while … do … end`, each branch of
`if … then … elseif … else … end`, and `repeat … until cond`. A table
constructor is an expression, not a scope.

| Field | Value |
|---|---|
| `headerStart` | the opener keyword (`local` for `local function`), so an anonymous function's header never carries the statement around it |
| `openOffset` | just past the parameter list's `)`, or past `do`, `then`, `else`, `repeat` |
| `closeOffset` | the `d` of `end`; the last code character before `elseif` / `else`; the last code character of the `until` condition's line once its brackets close, since the condition sees the body's locals |

Loop variables are block-local (the header is in `declRegionFor`); parameters
are function-local. An opener without its closer makes no block and every
later block nests one deeper, as an unmatched `{` does. A keyword after `.` or
`:` opens nothing.

## Data identities

Locals, parameters, loop variables and globals. Not data:

- members after `.` or `:`, table-constructor keys (`{ name = … }`), labels
  (`goto x`, `::x::`);
- callees, with or without parentheses (`f(`, `f "s"`, `f {`, `f [[s]]`);
- `local function f`, `local f = function`, and aliases of a standard global
  (`local type = type`);
- modules: `local m = require "m"`, `require("m")` or `require [[m]]` with
  nothing after the call but a comment. `require("m").f`, `require("m")()`
  and `require("m")[k]` bind a value, which is data, as Python's
  `api = vim.api` is;
- namespace globals: a global the file never assigns whose every use is
  `name.`, `name:` or `name[` (`vim`, `love`);
- standard globals (`string`, `table`, `pairs`, …) and `self`.

Resolution is lexical (`luaFacts`). A `local` name is visible after its
statement, so `local x = x` reads the outer `x` and
`local g = function() return g end` reads a global `g`; a `local function f`
is visible in its own body. The statement runs to its line end, extended over
open brackets, blocks that start on the line, and a line that ends after `=`,
`,`, an operator, `..`, `and`, `or` or `not`. Parameters are visible in the
function body, loop variables in the loop body.

The heuristic declares `local` name lists with `<const>` / `<close>`, `for`
variables, parameters, `local function`, and statement-start assignments to an
undeclared name outside every function (`globalSites`), which define a global.
An attribute counts only whole on its own line, `<` name `>`: a half-typed
`local limit <c` ends the list at `limit`, so the `>` of a `"<leader>"` string
further down never swallows the declarations in between.
A statement starts after `;`, a label's closing `::`, `then`, `do`, `else`,
`end` or `repeat`, or after a line break that follows no operator or
expression keyword. The server path adds those sites to lua-language-server's
`declaration` modifier, which it leaves off `<const>` and `<close>` locals. A
chunk-level list, `a, b = 1, 2`, declares neither global; the escape rules leave
both unmarked all the same.

lua-language-server types a `---@param x` name inside a comment `parameter`;
the lexer's comment span drops it. It types a module's uses `variable` (4,510
on the corpus) or `class` (931), and namespace globals `variable`; `luaFacts`
drops both, on both paths.

## Escape marks

The shared rules, with these Lua specifics:

- No `++` / `--`: `x -- note` is a comment.
- `a, b.c = …` marks every target; inside `{` it is a table constructor.
- A `self` write is exempt in a function whose header names it `new`, `init`,
  `initialize`, `_init`, `__init` or `ctor` (so not `M.new = function`), and
  after the function's own `local self`.
- At chunk level, an assignment to a name declared nowhere defines the global,
  and a member write into a global the chunk assigns fills it in; neither
  marks.
- A write into a local lua-language-server types `class` (an annotated module
  table) marks when the table is declared outside the block.
- Writes into modules and namespace globals never mark.
- No async or danger words: Lua has neither keyword nor cast.

## Band-1 restores

| Restore | Spans | With lua-language-server |
|---|---|---|
| module, type slate | uses of a `local m = require …` module, not its declaration | stays: the server types them `variable` or `class`, never `namespace` |
| shadowed builtin, page colour | non-call uses of a local, parameter or loop variable named like one of the 28 names the grammar scopes `support.function.lua` wherever they are not assigned or a member (`type`, `next`, `select`, …); not a local function or a `local type = type` alias, and not an assignment target | stays, and agrees: the server's `variable` token paints the same page colour ([shadow-restore.md](shadow-restore.md#lua)) |
| `string.format` placeholder, member steel | the `%…` conversions (`%d`, `%5.2f`, `%-3d`, `%q`, `%%`) in the literal right after `string.format(`, in the literal opening the line after a `string.format(` that ends its line, and in `("…"):format(…)`: the theme's `lua-gaps` call shapes and pattern. A backslash escape is one character; a long bracket, and any literal before `):format`, counts only closed on its line. Never a `gsub` or `match` pattern, a later argument, `a.string.format` | paints only while the document's last answer with tokens typed its string literals: a `string` token with no modifier, which lua-language-server 3.19.2 sends over each literal only under `Lua.semantic.keyword`. Its LuaCATS strings (`---@param m "a"\|"b"`) carry `static`, `abstract` or `defaultLibrary` and leave it off. Under the default settings, and with no server, the theme paints them and the restore stays off |

The first two run through the import restore's path in `src/decorator.ts`: cached per
version, kept on screen while typing, recomputed once typing pauses
([import-restore.md](import-restore.md#cost)). On the corpus they paint 5,790
module uses and 260 shadowed names, every one a module use or a data use by the
reference.

The placeholder restore runs with the Rust and Python ones
(`luaPlaceholderSpans` in `src/placeholders.ts`): scanned per version on every
keystroke, and repainted when an answer changes whether literals are typed
(`Classifier.typesStrings`).

`self` needs no restore: the grammar scopes it `variable.language.self.lua`
and `sumneko.lua` maps the server's `variable.definition` to the same scope.

## Server states

`Lua.semantic.enable: false` keeps the provider registered and answers with no
tokens, so each document holds band 2 through the ~30 s cold-retry schedule
([runtime.md](runtime.md#cold-servers)). With no server binary there is no
provider, and the heuristic paints at once.

## Real editor

The theme repo's harness has a `lua` cell (`e2e/fixtures/lua/`, its
`e2e/docs/coverage/lua.md`): VS Code 1.144.1 and `sumneko.lua` 3.19.2 from an isolated
extensions dir, in two modes, `luals` (the bundled server) and `off` (no server
binary, no provider). On 2026-11-08, against this tree, its 9 Focus and 8 Edit
items per mode, a rockspec's chunk item, and its transition scenarios (18 in
`luals`, 17 in `off`) showed no difference the companion causes. A copy of the
harness on its first Lua fixture, before this support, counted 577 (server) and
837 (no server) such differences in its Focus and Edit cells.

`0x1p4`, `1e+10` and LuaJIT's `12LL` are one numeral in the theme's grammar
too, so the companion's clay covers number-grey text only.

`Lua.semantic.enable: false` is not a mode of the cell: the provider answers
empty, so each document holds band 2 through the cold-retry schedule
([Server states](#server-states)). Measured once on the cell's fixture: the
first two Focus items, inside the first ~30 s, left 7 names untinted in 3
cells; the later items, and the `walk` and `blocks` scenarios run after the
schedule ran out, held.

`Lua.semantic.keyword: true` is not a mode either: lua-language-server then
types every keyword, operator and string, and the Survey misses on 27 tokens
per theme: the 21 `luals` residuals, the 2 diagnostics decorations `luals`
expects, and 4 of the `ffi.cdef` C under a whole-string token. Measured
once with a temporary `keyword` run (2026-11-08, Survey, both themes): every
`%…` of the fixture's `string.format("…")`, `("…"):format` and
`([[…]]):format` lay under the server's `string` token and rendered member
steel through the placeholder restore, the rest of each literal string green.

## Regenerating the token fixtures

```bash
node test/gen-lua-semtok.js samples/sample.lua > test/fixtures/sample.lua.lsp.json
node test/gen-lua-semtok.js test/fixtures/format.lua > test/fixtures/format.lua.lsp.json
node test/gen-lua-semtok.js --keyword test/fixtures/format.lua > test/fixtures/format.lua.keyword.lsp.json
```

`test/fixtures/format.lua` is synthetic: every placeholder call shape and the
literals that are not format strings. Under `--keyword` lua-language-server
3.19.2 sends `string` over its 25 literals and `string.modification` over its 2
escapes; under the defaults only `string.static` over the 2 LuaCATS literals.

## Cost

`luaFacts` runs once per version, after typing pauses. Its block lookups go
through interval indexes, and names resolve in one sweep in document order. On
50k lines of the sample repeated, and of lua-language-server's
`parser/compile.lua` repeated (8,380 blocks), it costs 19 to 24 ms of CPU,
best of 9 (19 to 20 at load average 2, 23 to 24 at 5), against 7 to 10 ms for
the lex and 4 to 5 ms for the block scan, which reads only the block keywords'
neighbours.
The first version scanned the block list per declaration: 159 to 260 ms on the
same inputs. `test/lua.test.js` holds it linear: 8 times the lines cost under
24 times the CPU. `node test/bench-scale.js lua --stages` prints the stages.
