# Band-3 risk marks

Band 3 paints in the Edit phase, in the focused block only. At module top level
the block is the code outside the function and type bodies the top-level scope
excludes. `src/risk.ts` computes the marks and `Decorator.renderBand3` paints
them. Every mark is code-only: the shared lexer ([lexer.md](lexer.md)) keeps
comments, docstrings and strings out.

| Mark | Style | Computed by |
|---|---|---|
| async | `--risk-async` cyan | `lexicalRisk`, synchronous |
| danger | `--risk-danger` bold | `lexicalRisk`, per-language rules |
| number-clay | `--syn-number-engaged` | `lexicalRisk`; rides Focus and Edit |
| escaping write | dashed underline | `escapeRisk`, needs the classification |

Tests: `test/escape.test.js` (escape rules, per-language corpora, render
stale-hold, style) and `test/risk-words.test.js` (danger and number tables).

## Escaping writes

A write escapes the block when its binding lives outside the block. Writes to
block-local names are local bookkeeping and get nothing.

### What counts as a write

| Form | Languages |
|---|---|
| `x = …` and `= += -= *= /= %= &= \|= ^= <<= >>= >>>= **= //= ??= \|\|= &&= &^= @=` | all |
| `+%= -%= *%= +\|= -\|= *\|= <<\|=` (wrapping and saturating) | all; only Zig has them |
| `x++`, `x--` | all but Python, Rust, Lua (`x -- note` is a Lua comment), Ruby and Zig (`a ++ b` concatenates arrays) |
| `++x`, `--x` | all but Python, Rust, Go, Lua, Ruby and Zig |
| `a, b = …`, `x, y.z, w[0] = …` at statement level | Python, Go, Lua (inside a Lua `{` it is a table constructor), Ruby |
| `root.a.b`, `root?.a`, `root->a`, `root!!.a`, `root[k]` as the target | all |
| `root.*`, `root.*.a`, `root.?.a` as the target | Zig |
| `*root = …` | Rust, C family, Go |

`==`, `===`, `!=`, `<=`, `>=`, `=>` and `:=` are not writes. A call anywhere in a
target chain (`f().x = 1`) leaves the receiver unknown, so it gets no mark.

### When a write marks

| Target | Marks when |
|---|---|
| plain `x` | `x` is `out`; or `fn` and not the focused function's own parameter (proximity 0); or named in the function's Python `global` / `nonlocal`; or a Rust `static` |
| chained or deref | the root is `self` / `this` (Python: `self`, `cls`; JavaScript and TypeScript: `this` only; Zig: `self` only) outside an initializer; or `fn` at any proximity; or `out` |

A chained write marks `root.member` through the last member name. A pure
subscript write marks the root.

Own parameters are exempt only for plain writes: `retries -= 1` in its own
function is bookkeeping, but `opts.limit = 7` or `*total += 1` mutates the
caller's object.

### What never marks

- **A heuristic classification.** Without semantic tokens the classifier finds
  declarations lexically
  ([classification-rules.md](classification-rules.md#the-heuristic-fallback)) and
  resolves nothing: shadowing is missed and a declaration shape it does not know
  reads as a write, so a write can be judged against the wrong binding. Trusted anyway, it marks 3 to 5
  writes per sample, with every block and the top level focused, where 1 to 3 are
  real. The escape mark needs binding resolution; without it, it makes no claim.
- **A declaration.** `Classification.declSites` holds every declaration token
  offset (`FileIndex.declSites`). That covers `let`, `const`, `var`, `:=`,
  `let mut`, shadowing `let`, parameters and defaults, including a declaration on
  a block's header line (`const stuff = {`, `let mut c = Config {`).
- **A named argument.** `isArgLabel` (classify.ts): the next char is `=`, the
  previous code char is `(` or `,` (newlines and comments skipped), and the
  innermost open bracket is a `(` after a callee that is not a `def` name.
  Applies to Python, Kotlin, Swift / Scala / Dart, Rust macros, `#`-comment and
  unknown languages. In
  JavaScript, C, Java and Go `f(x = 1)` is an assignment and marks.
- **A name that is not a data occurrence at that offset**, i.e. no tintable
  semantic token sits there.
- **Anything inside a Python f-string hole.** A hole holds an expression, never a
  statement: `f"{total=}"` is the self-documenting read, and walrus is `:=`.
- **Code outside the scope.** The synthetic top-level scope skips its nested
  bodies and function signatures (`Classification.excludeRanges`).
- **A Lua chunk-level global.** Outside every function, an assignment to a name
  declared nowhere defines the global, and a member write into a global the
  chunk assigns fills it in. A write into a module or a namespace global
  (`vim.opt.x = 1`) never marks; one into a local the server types `class` marks
  when the local is declared outside the block ([lua.md](lua.md#escape-marks)).
- **A write into Node's module surface.** `module.exports = …`, `exports.x = …`
  and `process.exitCode = …` write through a root that is not data unless the
  file declares it ([javascript.md](javascript.md#escape-marks)); a UMD
  wrapper's `function (exports)` parameter is declared, so its writes mark.
- **A Ruby write the Ruby rules leave alone.** Ruby has its own table
  (`rubyEscapeRisk`, [ruby.md](ruby.md#escape-marks)): a local's write marks
  when the local is declared outside the block and not in an earlier branch of
  the same conditional; `@x` and `self.x` outside an initializer, `@@x` in a
  method and `$x` in a method, class body or block mark too.
- **A Zig write through a local pointer.** `mutable.* = 9` writes through a
  pointer declared in the block, so the root is local and nothing marks, as
  for a C `*p = …` with a local `p` ([zig.md](zig.md#escape-marks)).

### Initializers

`self` / `this` writes inside an initializer set up an object nothing else holds
yet, so they are exempt. Without this, every constructor line is underlined.

| Language | Initializer |
|---|---|
| Python | `__init__`, `__post_init__`, `__new__`, `__init_subclass__`, found by indentation |
| JS / TS, Kotlin | `constructor(…)` |
| JS / TS | an ES5 constructor function: `function Point(…) {` or `Point = function (…) {`, the name capitalised; a `Point.prototype.move = function () {` method is not one |
| Kotlin | `init { … }` |
| Swift | `init(…)` |
| Java, C, C++, C#, Dart | a capitalised callee with only modifiers before it: `public Config(`, `Foo::Foo(` |
| Lua | a function whose header names it `new`, `init`, `initialize`, `_init`, `__init` or `ctor` (`function Point.new(`, `local function init(`); and any function after its own `local self` |
| Ruby | `def initialize`, `initialize_copy`, `initialize_dup`, `initialize_clone`, with the blocks inside them; for `@x` as for `self.x` |

Brace languages walk out through enclosing `{` blocks, past control-flow and
object-literal blocks, to the first function header. A closure inside a
constructor is its own function, so its `this` writes mark.

### Python declarations

Python has no block scope, and Pylance can tag every store `declaration`.
`buildFileIndex` keeps only the first depth-0 binding per `def` / `class` suite;
later stores are writes. Bindings inside brackets (parameters, comprehension
targets, lambda parameters) always count. A name in the suite's `global` /
`nonlocal` statement is never declared there. So the marks are the same whichever
shape Pylance uses; the corpus test runs both. Not verified against a live Pylance
capture: Pylance does not run outside VS Code.

A later plain `=` store marks only when the name's declaration sits in a suite
that encloses the focused block (`pySuiteTable` in classify.ts, by indentation;
`else: x = 2` is an inline suite of its own line). `total = 0` before a loop that
reassigns `total` marks the loop's write. Branches that each assign the name
(`if` / `else`, `try` / `except`, `match` arms) do not mark, whichever comes
first: before this rule the second branch marked and the first did not.
Augmented assignment (`n += 1`) reads the name first, so it always counts.

Suites come from indentation (`pyScopeAt` in classify.ts), not from the symbol
provider. A `global` / `nonlocal` statement belongs to the innermost `def` above
it, so one in a nested function does not leak into its parent.

### Stale-hold

Typing bumps the document version. The classification for the new version
arrives after the typing debounce (140 ms, up to 400 ms past 10k lines) plus the
server round trip, so the mark used to
switch off on every keystroke: `+0ms:KEY +142ms:1 +702ms:KEY +702ms:0 +822ms:KEY
+965ms:1`. `renderBand3` now leaves the painted ranges in place while the caret
stays in the same block (`renderedEscapeKey`, the rule band 2 uses), and the
editor moves them with the edit. A block change clears them at once. The hold
keeps the dirty-check record, and an edit that moves any painted mark voids it
([runtime.md](runtime.md#decorations-move-with-edits)), so the next
classification re-sends the marks exactly when they differ from what is on
screen.

Lexical marks and escape ranges are cached per document version, block and
classification, so a caret move inside the block recomputes nothing.

### Cost

Apple M3 Pro, Node 26.8.2, generated inputs of the sizes below with captured
tokens, one warm call, median of 3 runs:

| Input | `escapeRisk`, top-level scope | `lexicalRisk`, top-level scope | `escapeRisk`, last 40 blocks |
|---|---|---|---|
| TS, 10k lines, 273 KB | 1.5 ms | 1.6 ms | 0.2 ms |
| Rust, 50k lines, 1.3 MB | 3.9 ms | 2.9 ms | 0.1 ms |
| Go, 50k lines, 1.1 MB | 3.3 ms | 3.3 ms | 0.1 ms |

At the top-level scope `escapeRisk` walks only the code outside its excluded
nested bodies. `lexicalRisk` lexes the whole region, and the decorator drops the
marks that start inside an excluded body.

### Style and colour

The decoration string is the spec's `.u-escape`:

```css
underline dashed <c>; text-decoration-thickness: 1.5px; text-underline-offset: 3px; text-decoration-skip-ink: none
```

VS Code 1.144.1 inserts `textDecoration` verbatim into `text-decoration:{0};`
(`workbench.desktop.main.js`), so the geometry rides in the same string.

The colour deviates from the spec's `--risk-escape`:

| Theme | Spec | Here | `editorError.foreground` | Hue gap |
|---|---|---|---|---|
| Okibi | `#f57c5f` oklch(0.719 0.155 34.6) | `#e0a26f` oklch(0.760 0.100 60.0) | `#f84f52` H 23.8 | 10.8° → 36.2° |
| Akari | `#bf3a16` oklch(0.541 0.175 35.1) | `#a06024` oklch(0.550 0.111 59.7) | `#c71529` H 24.0 | 11.1° → 35.7° |

At 11° from the error hue, the dash read as a diagnostic: it was the reported
"rogue red underline" under variables while typing. At H60 and about half the
error chroma it sits 36° away, and the dashed shape still separates it from the
wavy diagnostic squiggle. The vendored spec (`scripts/spec/` in the theme repo)
is unchanged.

### Known limits

- JS destructuring assignment without a declaration (`[a, b] = [b, a]`,
  `({ a } = o)`) is not detected.
- A Python annotated member assignment (`self.x: int = 1`) is not detected.
- Focusing a class body shows the escaping writes of all its methods, because the
  class body region contains them.
- A C++ constructor with a member initializer list (`Foo() : a(1) {`) is not
  recognised as an initializer.
- Writes through a module or namespace root (`os.environ[k] = v`,
  `globalThis.x = 1`) do not mark: the root is not a data identity.

## Danger words

| languageId | Marks | Does not mark |
|---|---|---|
| `typescript`, `typescriptreact` | `as` casts; `any` in type position | `import { a as b }`, `import * as ns`, `export { a as b }`, `export * as ns`, `as const`, `.as` / `.any` members, `any(…)` calls, `{ any: … }` keys, bindings named `any` or `as` |
| `rust` | `as` casts | `use … as`, `extern crate … as`, `<T as Trait>::` |
| `kotlin` | `as` casts, `as?` included; `x!!`; `@Suppress("UNCHECKED_CAST")` | `import … as`, `!=` |
| `swift`, `dart` | `as` casts, `as?` and `as!` included | `import … as` |
| `c`, `objective-c` | a cast to a pointer type, `(T *)x`, `(const T *)x` | value casts, `(int)d`, `(void)x` ([c-jvm.md](c-jvm.md#danger-marks)) |
| `cpp`, `cuda-cpp`, `objective-cpp` | `reinterpret_cast<…>`, `const_cast<…>`; a C cast to a pointer or reference type | `static_cast`, `dynamic_cast`, `std::bit_cast`, value casts |
| `java` | a reference cast, `(List<String>) raw`; `@SuppressWarnings("unchecked")` and `"rawtypes"` | primitive casts, `(int) d` |
| `groovy` | none | |
| `python` | none | `import … as`, `with … as`, `except … as`, `case … as`, `any()` |
| `go` | none | `any` (see below) |
| `vue`, `svelte`, `astro` | TypeScript's, in every code region of the component ([components.md](components.md#marks)) | TypeScript's, and a Svelte `{#each xs as x}`'s `as`, which is markup |
| `javascript`, `javascriptreact` | none | no casts, no `any` type |
| `lua` | none | no casts; no async marks either, since Lua has no `async` / `await` keyword |
| `ruby` | none | no casts; Sorbet's `T.cast`, `T.unsafe` and `T.untyped` are method calls. No async marks: Ruby has no async syntax, so `async: true` and the Async gem's `Async do` are names |
| `zig` | `@ptrCast`, `@alignCast`, `@constCast`, `@volatileCast`, `@addrSpaceCast`, `@intFromPtr`, `@ptrFromInt`, `@fieldParentPtr` | `@intCast`, `@truncate`, `@bitCast`, `undefined`. No async marks: Zig 0.17 has no `async` / `await` keyword, and `.async(` / `.await(` are `std.Io` methods ([zig.md](zig.md#danger-marks)) |
| anything else | none | |

### Go: `any` is not a danger word

- `any` is `interface{}`. Its value cannot be used without a checked type
  assertion or a type switch; the compiler rejects anything else. TS `any` turns
  checking off for every use. The mark means trust erosion, and Go's `any` erodes
  none.
- `[T any]` is the most common generic constraint, and it means "unconstrained".
  Marking it puts bold red on ordinary generic signatures.
- Band 1 paints `any` as a predeclared type (theme rule "Go predeclared types").

The alternative was to mark Go `any` like TS `any`. If Go gets a danger mark
later, the candidate is the single-value type assertion `v.(T)`, which panics on
a mismatch.

## Numbers

Clay covers the whole literal, suffix included (`123u32`, `1.0f`, `10n`, `10L`,
`2i`, `1j`), because rust-analyzer reports the whole literal as one `number`
token. A tuple field (`pair.0`, `t.0.1`) is a field, not a number: rust-analyzer
types it `property`. Lexing rules: [lexer.md](lexer.md).
