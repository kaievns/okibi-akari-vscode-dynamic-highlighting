# Zig

Zig (`zig`, the `source.zig` grammar of `ziglang.vscode-zig` 0.7.0; VS Code has
no built-in Zig grammar) is a code language: brace blocks, data identities,
escape and danger marks, and band-1 restores. `src/zig.ts` holds the facts the
heuristic and the namespace restore read, `src/lex.ts` the lexer family, and
`src/focus.ts` the header kinds. Tests: `test/zig.test.js`, plus Zig in the
perf-golden inputs and the transition walks.

`ziglang.vscode-zig` 0.7.0 gives `.zig` and `.zon` one language id, `zig`, so
`build.zig` and `build.zig.zon` both open as `zig`. The layer reads a `.zon`
file as ZON, static content ([ZON](#zon)). A ```` ```zig ```` fence in markdown
is prose.

The facts follow Zig 0.17.1 and zls 0.17.0. In 0.17 `usingnamespace`, `async`
and `await` are no longer keywords, and `@cImport` fails `zig ast-check` as an
invalid builtin. In older files `const c = @cImport(…)` reads as a namespace,
and the `@cInclude("…")` path is a string.

## Measurements

The corpus is 630 non-empty files, 515,258 lines: Zig 0.17.1's `lib/std` (538
files; 25 more ship empty), the zls 0.17.0 source (90), `lib/init/build.zig`
and one synthetic file. The user's own projects hold no `.zig` or `.zon` file.
The references are Zig's own tokenizer (`std.zig.Tokenizer`) for regions,
braces and numerals, and zls 0.17.0's `full` tokens for data: a `variable` or
`parameter` token not after `.`. Classification ran on up to 12 blocks per
file, spread evenly through it, 6,665 blocks, each through `classifyScope`. Per
row: [zig-measurements.csv](zig-measurements.csv).

| What | Before | Now |
|---|---|---|
| characters in a region other than the tokenizer's (13,519,591 non-blank) | 208,355 in 272 files | 0 |
| brace pairs equal to the tokenizer's 87,701 | 87,678, plus 2,258 bogus, 2,254 of them inside `\\` lines | 87,701, 0 bogus |
| numerals equal to the tokenizer's 121,781 | 121,780, plus 3,380 inside strings | 121,781, none outside code |
| tints right / wrong, zls `partial` and `full` | 57,014 / 25 | 60,758 / 0 |
| tints right / wrong, no server | 51,625 / 12,558 | 59,286 / 540 |
| data names left untinted, no server | 6,920 | 3,009, 1,537 of them `self` |
| escape marks with zls tokens | 2,055, 15 on `++` | 2,277, 0 on `++` |
| danger marks | 0 | 3,534 |
| async marks | 142 | 0 |
| namespace restore spans, no server | 0 | 37,180, 35,767 on a zls `namespace`, `struct`, `type` or `enum` token |
| format placeholders equal to the theme's TextMate ones | none painted | 2,404 of 2,404 |

Before, Zig fell to the `default` lexer family and the generic heuristics. The
540 wrong tints with no server are type values in snake_case (189,
`const field_type = field.type`), namespace aliases inside a function (212),
functions passed as values (54) and lowercase struct names zls types `struct`
(73). Of the 3,009 untinted data names, 1,537 are `self`, left out by design
([Data identities](#data-identities)). Reading a type or namespace name by name
across the file, not in its scope, left 26 more untinted: a parameter or local
that shares a sibling scope's `const` (`int` in `std.math`).

## Lexer

| Form | Region |
|---|---|
| `//`, `///` and `//!` to the line end | comment |
| `"…"` and `'…'`, backslash escapes (`'\u{1F600}'`, `'\''`), one line: a backslash before a line break escapes nothing, so an unclosed literal ends there, as in Zig's tokenizer | string |
| `\\` to the line end: each line of a multiline string | string |
| `@"…"`, one line | an identifier, quotes included, as zls's token spans it |
| `@name` | an identifier with its `@` |

Zig has no block comment, so `/*` starts nothing. `'` is a char literal, never
a lifetime. Numerals take `0x`, `0o` and `0b` prefixes, `_` separators,
exponents, hex floats with a `p` exponent (`0x1.8p3`) and hex fractions without
one (`0x103.70`); `0..n` is a numeral and a range. No literal spans a line
break, so every line start is a resume point for the incremental re-lex.

## Blocks

The brace scanner, as for the C family. A header is:

| Kind | Header | Example |
|---|---|---|
| function | `fn` after any of `pub`, `export`, `extern "c"`, `inline`, `noinline`; a `test` block | `pub inline fn bitReset(…) u1 {`, `test "parse" {` |
| plain | ends in `struct`, `enum`, `union`, `opaque` or `error`, with an optional `(…)` | `union(enum) {`, `packed struct(u8) {`, `error{` |
| control flow | holds `if`, `else`, `while`, `for`, `switch`, `catch`, `orelse`, `defer`, `errdefer`, `comptime`, `suspend` or `nosuspend`, and is neither of the above | `if (opt) \|v\| {`, `x catch \|err\| {` |

`try` is not control flow: `try w.print("{}", .{` opens an anonymous literal.
A container header ending in `)` is not a function, so `union(enum)` keeps its
fields out of the parameter list. A capture sits in the control-flow header,
so it belongs to the block it opens; the block's scope starts at the first of
those words, so in `const n = f() catch |err| switch (err) {` `n` is the
enclosing block's and `err` the switch's. A function's parameter list is the
`(` after `fn`, so a return type that ends in a call (`@TypeOf(value)`,
`std.ArrayList(T)`) and a `callconv(.c)` hold no parameters. Before, both took
the header's last `(…)` or its `switch`: with no server `n` in
`fn pick(n: u8, value: anytype) @TypeOf(value)` was no data, and `err` took a
hue from the enclosing function's own data (the e2e `zig` cell, 2026-11-10).

## Data identities

Locals, parameters and captures (`|x|`, `|*x|`, `|x, i|`) are data; a capture
belongs to its own block. Not data:

- keywords, primitive types (`u8`, `usize`, `comptime_int`, any `[iu]\d+`) and
  `true`, `false`, `null`, `undefined`;
- type names by Zig's convention: TitleCase or one capital letter. `ALL_CAPS`
  is a value;
- `@builtins`; a quoted identifier `@"…"` is data like any name;
- members after `.` and enum literals (`.green`, `.{ .x = 1 }`);
- labels: `blk: {`, `outer: while`, `break :blk`, `continue :outer`;
- fields, enum members and error names written in a container body;
- type parameters: `comptime T: type`, `T: type`;
- with no server, `usingnamespace`, `async` and `await`, which earlier Zig
  versions reserve: `const async = 1;` is data only once zls answers;
- a `const` bound to `struct`, `enum`, `union`, `opaque`, `packed`, `extern`,
  `fn` or `error{`, or to a type builtin's call that ends the declaration
  (`@import("std");`, `@This();`, `@Type(…)`, `@TypeOf(…)`, `@Vector(…)`,
  `@Int(…)` and the other type builtins). `error.Overflow`,
  `@TypeOf(x) == T`, `@Vector(4, u8){ … }` and `@import("x").y` are values;
- a container-level `const` that only renames one of those
  (`const mem = std.mem;`);
- each of these inside the scope that declares it, and only there: a later
  function's parameter that shares a container's `const json = @import(…)` is
  data ([Band-1 restores](#band-1-restores));
- `self`: a receiver, as in Rust and Python. A parameter named `this` is data.

zls types all of these itself, so the `partial` and `full` answers need none of
the rules. Two things differ from the other languages on that path: a
`property` token is never data, since Zig has no `{ name }` shorthand, which
JavaScript's exception assumed; and only `self` is a receiver.

`zigFacts` computes the rules once per lex. A capture is a `|…|` after an
`if`, `while` or `for` header's `)`, after `=>`, `catch`, `else` or
`errdefer`; the heuristic declares each name in it.

Of the 1,016 first parameters typed `Self`, `*Self` or `*const Self` on a
one-line header in the corpus, 836 (82%) are named `self`; the rest are `d`,
`v`, `deque`, `ctx` and the like, which are data.

## Escape marks

The shared rules, with these Zig specifics:

- `.*` and `.?` are steps of the target, so `total.* += f`, `p.*.x = v` and
  `opt.?.x = v` write through `total`, `p` and `opt`. With `total: *f64` a
  parameter, the mark covers `total.*`.
- The wrapping and saturating assignments are writes: `+%=`, `-%=`, `*%=`,
  `+|=`, `-|=`, `*|=`, `<<|=`.
- No `++` or `--`: `a ++ b` concatenates arrays.
- The receiver root is `self`; `this` is a plain name.
- A write through a local pointer (`mutable.* = 9`) is not marked: the pointer
  is declared inside the block.

With zls tokens the 6,665 blocks hold 2,277 marks, 1,619 of them on `=`. No
initializer exempts a `self` write: the corpus has 3 `fn init(self: *…)`
methods.

## Danger marks

| Marked | Not marked |
|---|---|
| `@ptrCast`, `@alignCast`, `@constCast`, `@volatileCast`, `@addrSpaceCast`, `@intFromPtr`, `@ptrFromInt`, `@fieldParentPtr` | `@intCast` (2,315 on the corpus), `@truncate` (1,058), `@bitCast` (1,258), `undefined` (11,616, 11,095 of them `= undefined`) |

The marked builtins drop what the type system checked of a pointer, as a
TypeScript `as any` does: 3,534 marks over the corpus, `@ptrCast` 1,290,
`@intFromPtr` 803, `@alignCast` 754, `@ptrFromInt` 448, `@fieldParentPtr` 173,
`@constCast` 65, `@volatileCast` 1. `@intCast` and `@truncate` are checked or
defined value casts, `@bitCast` keeps the size, and `= undefined` is the
standard way to leave a buffer uninitialised. Marking `@bitCast` and
`@truncate` too adds 2,316 marks.

No async marks: `.async(` and `.await(` are `std.Io` methods in 0.17, and were
142 marks before.

## Band-1 restores

| Restore | Spans | With zls |
|---|---|---|
| namespace, type slate | the declaration and uses of a `const` bound to `@import` or `@cImport`, of a lowercase `const` bound to a type (`const control_code = struct {…}`), and of a container-level alias of one that some use reads a member of and no use calls (`mem.eql(…)`, not `assert(…)`); never after `.`, never called | off once zls answers: it types them `namespace`, `struct`, `type` or `enum` |
| format placeholder, member steel | the holes of a `"…"` literal right after `(` or `, ` whose `.{` arguments tuple follows on its line: the theme's `zig-gaps` call shape. A backslash escape is not a hole (`\u{…}` whole, any other two characters), nor are `{{` and `}}`; a `\\` line never is | paints only while the last answer with tokens typed its string literals, which zls 0.17.0 does under `zig.zls.semanticTokens: full`. Under the default `partial`, and with no server, the theme paints them |
| `self`, keyword grey | every `self` but a member (`x.self`, `.{ .self = 1 }`) and a field or enum member of a container body (`self: u8,`, `enum { self }`); never `this`. The theme's `zig-gaps` scopes `self` `variable.language.self.zig` | stays: zls types `self` `parameter`, which the theme paints page colour |

Zig forbids a name that shadows one in an enclosing scope, not one in a sibling
scope: a container's `const json = @import("json.zig")` and a later function's
parameter `json` are two bindings (`zig ast-check` accepts both). So a
namespace, a type and a type parameter bind in the scope that declares them:
the file, a container body, a block, or for a parameter its function's
signature and body. The restore paints a use only inside that scope, and never
a field, an enum member or a label of that name (`path: []const u8,` beside
`const path = std.fs.path;`); the heuristic classifier reads the names the same
way (`ZigFacts.nonDataUse`). Resolving by name across the file painted 230 more spans
on the corpus: 190 on fields, enum members and labels, 40 on a sibling scope's
binding. On the corpus it paints 37,180 spans: 32,438 on a zls `namespace`
token and 3,329 on `struct`, `type` or `enum`, all type slate. 1,383 land on
`variable`: 457 names bound to an `@import` zls leaves unresolved (96 of them
`@import("root")`), 777 aliases whose value zls types as a variable
(`const native_os = builtin.os.tag`), and 149 more. It misses 4,032 of zls's
36,448 namespace uses: 1,637 TitleCase names, which the theme paints type
slate as types, 1,071 consts inside a function (`const testing = std.testing`
in a test), and 1,324 container-level names it does not read as namespaces,
such as an alias that some use calls.

zls `full` sends one `string` token over each literal, 49,064 on the corpus,
and no `escapeSequence` token, which turns the placeholders string green.
`zigPlaceholderSpans` and the theme's TextMate placeholders agree on all 2,404
of the corpus.

The `self` restore runs with the other languages' (`renderSelf`), per version
on every keystroke; its field check reads only the `self` tokens' brackets.

## ZON

`effectiveLanguageId` reads a `.zon` file opened as `zig` as `zon`, a static
id: no blocks, no bands, no band-1 restore, no server request, the phase held
in Survey. A ZON file is data, as KDL and TOML are; its colours are the
theme's alone.

## Server states

zls 0.17.0 registers only a range provider for a client named Visual Studio
Code, so the editor asks it per viewport. VS Code 1.144.1's
`vscode.provideDocumentSemanticTokens`, which the layer calls, falls back to
that provider over the whole document; on the sample the answer equals zls's
full-document one.

Under `partial` (vscode-zig's default) zls sends identifier tokens only;
`full` adds keywords, literals, operators, builtins and labels. zls can answer
a second time with more names typed: in the harness, `std.testing` and `.none`
gain their slate and steel in a later answer, which the layer repaints as any
later answer. `none` is not measured. With no zls the heuristic paints at
once.

## Real editor

The theme repo's harness has `zig` and `zon` cells (its `e2e/README.md` § Zig
coverage: VS Code 1.144.1, `ziglang.vscode-zig` 0.7.0, zls 0.17.0 in `partial`,
`full` and off). On 2026-11-10 they held every expectation in both themes: the
band-1 restores in Survey (`self` keyword grey under zls's `parameter` tokens,
the namespace restore of a `@cImport` binding with no server, the placeholders
under `full`), 12 Focus and Edit items in `partial` and off, every transition
scenario in both, and no paint at all in `build.zig.zon` and a `.zon` data file
through the static scenarios. Their first run found the two scope defects
[Blocks](#blocks) describes.

Before that, a copy of the harness with such cells ran on 2026-11-09 against the
first build of this support, Okibi only. The companion's rows went from 81 (69 of them defects) to
13, each an error in the cell's expectations: one item needs 6 hues of a 5-hue
pool, and with no server the layer makes no escape claim. In the `zon` cell, a
click and typing in `build.zig.zon` entered Focus and Edit and turned the
fingerprint clay; with that build the phase stayed in Survey. That build painted
no `self` and no placeholders.

## Regenerating the token fixtures

```bash
node test/gen-zig-semtok.js samples/sample.zig > test/fixtures/sample.zig.lsp.json
node test/gen-zig-semtok.js --full samples/sample.zig > test/fixtures/sample.zig.full.lsp.json
zig run test/gen-zig-tokens.zig -- samples/sample.zig > test/fixtures/sample.zig.tokens.json
```

`ZLS=/path/to/zls` picks the server (default: the one on `PATH`). It runs with a
scratch cache, and the answer is taken once it repeats unchanged for 2 s. The
tokenizer dump is Zig's own `std.zig.Tokenizer`, in byte offsets, so the sample
stays ASCII. `test/fixtures/transitions/walk.zig` and `walk.zon` are synthetic
and pass `zig ast-check`.

## Cost

`zigFacts` runs once per lex, after typing pauses; the namespace restore reads
it once typing pauses too. `node test/bench-scale.js zig --stages` (warm, mean
of 5 calls, ms; load average 7.5 to 9.5):

| Stage | 2k lines | 10k lines | 50k lines, 1.26 MB |
|---|---|---|---|
| lex | 1.0 | 2.4 | 9.9 |
| `scanBlocks` | 0.3 | 0.8 | 3.7 |
| `zigFacts` | 1.6 | 3.3 | 20.4 |
| `buildFileIndex` | 1.2 | 4.9 | 15.3 |

Binding each type and namespace name to its scope ([Band-1
restores](#band-1-restores)) costs `zigFacts` 5% to 30% in these runs: 1.2, 2.8
and 16.6 ms before it, side by side at the same load, and 20.0 to 23.8 ms
against 21.8 to 25.4 ms over three interleaved 50k-line runs at load average 8
to 21, which is within the noise. On `std/Io/Threaded.zig`, 20,074 lines,
`zigFacts` costs 9.3 ms (median of 15, fresh lexes, five interleaved runs at
load average 8; 8.0 ms before the scopes, and 6.3 ms in a quieter run of that
version) and the namespace spans 2.0 ms more (2.2 before). The first version
mapped every identifier's offset and looked at each one's enclosing bracket:
12.7 ms on that file, 32.7 ms at 50k lines. Each scope is read once per bracket,
and a name bound in 8 scopes or more is found by a binary search over them.
`test/zig.test.js` holds it linear with a namespace
alias per unit: 8 times the lines cost under 24 times the CPU.

## Known limits

- A type value in snake_case is data with no server
  (`const field_type = field.type`).
- A namespace alias inside a function is data with no server, and gets no
  restore.
- An alias whose value is an enum (`const native_os = builtin.os.tag`) and
  whose uses read members (`native_os.isDarwin()`) gets the namespace restore.
- A write through a local pointer is not marked.
- No `self` write is exempt in an initializer.
- Under `full`, an escape sequence reads string green: zls sends no
  `escapeSequence` token, and the layer restores none.
- A function's colour scope is the outermost function around the caret, so a
  method of a generic type (`fn List(comptime T: type) type { return struct {
  … } }`) shares its scope with the whole type: 1,995 of the corpus's 16,580
  functions, 27.8 blocks per scope on average, 377 at most.
