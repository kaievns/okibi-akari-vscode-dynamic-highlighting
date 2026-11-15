# Classification rules

Why a given token does or does not get a band-2 identity tint. The rules were
derived from **real language-server output**, not guesswork — TypeScript via
`getEncodedSemanticClassifications`, Go via `gopls semtok`, Rust via
rust-analyzer. Python tokens are constructed to Pylance's legend, because Pylance
does not run outside VS Code (README, "Python has no captured token fixture").
Regenerate the captured fixtures with the commands in the README's Tests section,
for example:

```bash
node test/gen-ts-semtok.js samples/sample.js > test/fixtures/sample.js.tokens.json
~/go/bin/gopls semtok samples/sample.go | node test/gen-go-semtok.js samples/sample.go > test/fixtures/sample.go.tokens.json
```

The golden tests (`test/golden.test.js`) run the classifier against those real
tokens, which is what catches "the server tokenizes differently than we assumed"
— a class of bug hand-written fixtures structurally cannot find.

---

## What counts as a data identity

Band 2 is about **data flow**, so only bindings you can trace get a hue.

| Token type | Tinted? | Why |
|---|---|---|
| `variable` | yes | a data binding |
| `parameter` | yes | a data binding |
| `property` | **only object-shorthand** | see below |
| `function`, `method`, `member` | no | transformers — band-1 bold blue |
| `class`, `interface`, `struct`, `enum`, `type`, `typeParameter` | no | structure, not data |
| `namespace` | no | module surface |
| `keyword`, `string`, `number`, `comment`, `operator` | no | band-1 |
| any type, starting inside a comment or doc comment | no | prose, not data: gopls types `[Name]` doc links as `variable`, rust-analyzer types doctest code inside `///` |

### Modifier exclusions

| Modifier | Effect | Rationale |
|---|---|---|
| `defaultLibrary` | excluded | builtins (`console`, `Math`, `nil`, `true`) are library surface, not this file's data |
| `signature` | excluded | gopls marks **func-typed values** (`h Handler`); calls through them are transformers, so they keep band-1 |
| `definition` (on `property`) | excluded | a field/member **definition** (Go struct fields) is structure |
| `classMember`, `dynamicAttribute` | excluded | Pylance's attribute marks (`self.seen`, `getattr`-style) |
| `keywordArgument` | excluded | Pylance's kwarg label (`f(name=…)`) |
| `injected`, `documentation`, `intraDocLink` | excluded | rust-analyzer's marks on doctest code, doc text and `[Foo]` links inside comments |

### Name exclusions

| Name | Why |
|---|---|
| `_` | discard/blank identifier (Go, Python); also the lodash module facade in JS |
| `this`, `self`, `@…` | painted by band 1 only (`--id-self` = `--syn-keyword`), so no weight flip on focus change. In JavaScript and TypeScript only `this`: `self` is an ordinary name (`var self = this`) |
| `module`, `exports`, `require`, `process`, `Buffer`, `global`, `__dirname`, `__filename` (JS / TS) | Node's module surface: tsserver types them plain `variable`, since `@types/node` is no default library. Data again when a token in the file declares the name ([javascript.md](javascript.md#data-identities)) |
| an `import * as NS` name (JS / TS) | a module, whatever the server types it: Deno says `variable.readonly` |
| a JSX component, a capitalised tag (`<Message>`) or a member tag's capitalised root (`<UI.Button>`) | a function or a class wherever the file names it; tags themselves are not identifiers ([components.md](components.md#data-identities)) |
| `Astro` (`astro`) | the frontmatter's global joins the module surface: the Astro server types it `variable.readonly` without `defaultLibrary` |

### Position exclusions

`isMemberOrLabelPosition` drops a token in two positions, whatever its type:

| Position | Rule |
|---|---|
| member | the previous char is `.` (`self.retries`, `cfg?.name`), but not the end of a spread or range: `...args` and `0..n` read `args` and `n` |
| named argument label | `isArgLabel`: next char `=`, previous code char `(` or `,`, innermost open bracket a `(` after a callee that is not a `def` name, in a language with named arguments |

Neither a `def` parameter list nor a token carrying `declaration` or
`definition` is a label, so `def f(a, retries=5)` keeps its parameter on both
paths, and `a, b = 1, 2` (no enclosing `(`) keeps its targets. Read as labels,
those declarations vanished: the parameter classified `out`, shared a hue with a
same-named global, and traced across another function. Without a server,
`retries` was no declaration at all and never painted. In JavaScript, C, Java
and Go `f(x = 1)` is an assignment, so the label rule does not apply there.

A Lua token also needs a binding position from `luaFacts`: a method name after
`:`, a table-constructor key and a label have none. A module, a local function
and a namespace global are dropped whatever the server types them, and a
`<const>` / `<close>` local counts as a declaration though lua-language-server
leaves `declaration` off it ([lua.md](lua.md#data-identities)).

A Ruby token needs a binding from `rubyFacts`: ruby-lsp types reads only, so
`rubyTokens` keeps its `variable` and `parameter` tokens where a local or user
global is bound, and adds the declarations (with `declaration`), the writes and
the reads it left untyped. A method call, `@x`, `@@x`, a label and a symbol have
no binding ([ruby.md](ruby.md#data-identities)).

A Zig `property` token is never data: Zig has no `{ name }` shorthand. zls
types `self` `parameter`; it is the receiver, and a parameter named `this` is
data ([zig.md](zig.md#data-identities)).

### Python rebinding

Python has no block scope, so a later store to a name is a write to the
function's one variable. `buildFileIndex` keeps only the first depth-0
`declaration` per name per `def` / `class` suite; bindings inside brackets
(parameters, comprehension targets, lambda parameters) always count, and a
`global` / `nonlocal` name is never declared in its suite. Suites come from
indentation (`pyScopeAt`), not from the symbol provider, so the rule holds with no
symbols, and whether Pylance tags every store or only the first. Escape marks
depend on it: [risk-marks.md](risk-marks.md#python-declarations).

---

## The object-shorthand exception

TypeScript reports `{ name }` shorthand as `property [declaration]` — but it is a
genuine **read** of the `name` binding, equivalent to `{ name: name }`, so it
should tint like the variable it refers to.

The problem: **class and interface member declarations carry the identical
token**. Position is the only discriminator. A shorthand read sits inside an
object literal, so it is bracketed — preceded by `{` or `,`, followed by `,` or
`}`. Both sides are required:

| Construct | prev / next | Verdict |
|---|---|---|
| `{ name }` | `{` / `}` | shorthand read → **tints** |
| `{ name, x }` | `{` / `,` | shorthand read → **tints** |
| `get summary(): string` | `t` / `(` | getter declaration → band-1 |
| `set blah(v)` | `t` / `(` | setter declaration → band-1 |
| `private seen = 0` | `e` / `=` | class field declaration → band-1 |
| `interface I { field: … }` | `{` / `:` | key literal → band-1 |
| `cfg.name` | `.` / — | field access → band-1 |

Note that a setter's **parameter** (`val`) and a constructor parameter property
(`private readonly name`) *do* tint — they are parameters, i.e. real data.

C, C++, Java, Kotlin and Zig have no `{ name }` shorthand, so there a `property`
token is never read as one: jdtls and kls type a field read bare between commas,
`g(a, size, b)`, `property`, and it painted as data (Java 19, Kotlin 140 tints;
[c-jvm.md](c-jvm.md#server-shapes)).

In `svelte` and `astro` a `property` token that fills a code region alone, a
shorthand attribute `<C {open}>` or a value-less `bind:open`, reads `open` too:
the servers type both `property [declaration]`, and in the code view a form feed
stands on each side where the braces were. `vue` keeps the rule above: Volar
types a prop read in a template (`{{ title }}`) `property`, and it has no
binding in the script.

---

## Block and scope regions

Two different ranges, because they answer two different questions.

### `lexRegionFor` — visibility

**Always header-inclusive**, every block kind. A block's header line carries its
most important bindings, and they sit *before* the `{`:

- control flow: `for _, c := range xs {`, `if v, ok := m[k]; ok {`
- functions: `go func(cfg Config) {`, `echo := func(ctx *Context) {`

With a body-only region those names are invisible **in their own scope** — which
caused closure params to tint only from the *parent* block.

### `declRegionFor` — classification

Header-inclusive **only for control flow**. A function's header holds its
*parameters*, which are function-scoped (`fn`-local), not block-local; widening
there would misclassify them as block-local and trip the ≥2-use floor.

Control-flow keywords take precedence over paren-based function detection,
because `for (...) {` and `if (...) {` have parens too. A braced Rust match arm,
`Ok(v) => {`, is control flow: `v` is the arm's own binding, so two matches that
both bind `v` give two identities. Before, `=> {` read as a JS arrow header, `v`
classified as a function local, and the trace painted the other match's `v`.

### Wrapped headers

The header is normally the `{` line up to the brace (`headerStart … openOffset`).
When that line only finishes a statement begun earlier, the header is the whole
statement (`headerOf` in focus.ts):

| `{` line | Header starts at |
|---|---|
| closes a `(` opened on an earlier line (`): void {`, `    b) {`) | the line of that `(`, repeatedly |
| empty, an Allman brace | the previous code line, then as above, unless it ends in `;`, `{`, `}`, `,`, `(`, `[`, `=` or `:` |
| Rust: empty, or starts with `)`, `->` or `where` | the item start: back to a code `;`, `{` or `}` at depth 0, past attributes |
| C family and Java: starts with `->`, `throws`, `const`, `noexcept`, `override`, `final`, `volatile` or `&`, after a `)` | the line of that `)`, then as the first row |

The wider header is kept only when it reads as a function or control-flow header,
so a brace in an expression never claims the statement before it. Without it, a
signature wrapped over lines had no parameters in its own scope, and
`fn fold<T>(…) -> T` with a `where` clause and the `{` alone on its line was not a
function at all.

### The module top-level scope

The caret is often outside every brace-block — sitting on a top-level `const`,
`var` or `type`. That is a real scope, not Survey, so `innermostBlock` falls back
to a **synthetic** block (`topLevelBlock`, `depth: -1`) spanning the whole file.
`isTopLevelBlock(block)` identifies it.

Two consequences follow from "spans the whole file":

**1. `excludeRanges` carves out the nested code.** Without it every local in
every function is lexically inside the top-level region, so focusing line 1
tints random locals throughout the file. The carve-out (`topLevelExcludes` in
`focus.ts`) is:

- every depth-0 block **body** (`openOffset … closeOffset`) — function and type
  bodies, and
- every depth-0 **function signature** (`headerStart … openOffset`), which sits
  *outside* the braces and would otherwise read as top-level code.

The signature exclusion applies only when `isFunctionHeaderText` matches, because a top-level
`const DEFAULTS = { … }` is *also* a depth-0 block, and its "header" holds the
one name we most want at top level. Excluding it hid `DEFAULTS` entirely.

The decorator applies the same carve-out to everything else it paints for the
top-level scope. The gutter stripe covers only lines with code outside the
excluded ranges, plus blank lines between them (`topLevelLines`), and clay
numbers and the async and danger marks inside an excluded body are dropped.
Before, a caret on a blank line between two functions striped the whole file and
turned every number in every function clay.

For the same reason the top-level block's `subBlocks` use `declRegionFor`, not
`lexRegionFor`: the header-inclusive variant would put `DEFAULTS` inside its own
initialiser's sub-block and demote it to proximity 2.

**2. The ≥2-use floor is relaxed** for `proximity === 0` names (`isTopLevel` flag
on `BlockNames`). A module const is typically declared once at the top and read
inside functions, so counting only its *top-level* uses would hide it. The
exemption does not extend to nested names.

---

## Classification classes

| Class | Meaning | Trace range |
|---|---|---|
| `block` | declared in the focused block (incl. its header) | the block |
| `fn` | declared in the enclosing function, outside the block — "borrowed in" | the function |
| `out` | no in-function declaration: module global, or a capture | file-wide / home fn |
| `self` | `this` / `self` / `@…` | never painted by band 2 |

A `block` local needs **≥2 uses** in the block to qualify; once-used ones stay
neutral so dense blocks stay calm. A use is a lexer identifier or, with a
provider, a Rust inline format arg: `label` in `write!(f, "{label}")` and `w` in
`{x:>w$}` (`FileIndex.stringReads`). The lexer leaves format strings whole, so
counting identifiers alone gave `let label = …; write!(f, "{label}")` one use and
left `label` neutral, while `write!(f, "{}", label)` tinted it. The same count
admits a name that a nested block reads only through such an arg.

rust-analyzer 0.3.3105 types a capture `variable` only once it expands the macro.
A file outside any cargo package, and a package whose workspace is still loading,
get one `string` token over the literal instead, and no token for the macro's
arguments. So in Rust `buildFileIndex` lexes both: the identifiers inside every
`name!(…)` call (the macro-argument pass), and the captures (`rustInlineArgs`,
`src/placeholders.ts`), in format strings only, skipping a name the same call
passes as a named argument (`name = expr`) and the `#[error("…")]` attribute,
whose names are fields. Both only extend a binding that a token already made a
data identity, and a position the server typed counts once: a loaded workspace
types macro arguments with modifier `macro` (`f` in `write!(f, …)` as `parameter
[macro, mutable, reference]`). Before, the macro-argument pass added such a
position a second time. Without any provider, the heuristic classifier does not
read captures. Other languages get no macro-argument pass: a Ruby `name!(…)` is
a method call, and the pass made the label in
`system_command!("ditto", args: [path], verbose: true)` a use of a parameter
`verbose` declared in another method.

`out` non-captures render **bold** (weight = reaches beyond the local frame);
captures render like locals. A module block (an Astro client `<script>`,
[components.md](components.md#blocks-and-focus)) scopes like a function but
weighs like a file: a name declared at its top level and seen from a block
below it renders bold, as in the same script opened as a `.js` file
(`NameInfo.moduleTop`). A capture's home is the innermost function that
declares the name **and encloses the block**. Taking the first declaring function
instead traced a callback's `name` across an unrelated `loadConfig(name)` on
`samples/sample.js`, and a top-level `cfgs` across `summarize(cfgs)`; a name whose
declaring functions all lie elsewhere is a true global.

---

## Attention proximity

When a block has more eligible names than the palette has hues, `proximity`
decides who wins a slot:

| Value | Meaning |
|---|---|
| `0` | declared directly in the focused block, **or a parameter of the focused function** — its own data |
| `1` | borrowed in (fn-local from an outer scope, capture, global) |
| `2` | declared in a **nested** sub-block the caret sits above — **excluded, never painted** |

A declaration inside a nested sub-block belongs to that sub-scope. When a name is
also declared outside every sub-block, only those declarations classify it: a
parameter `c` stays the function's own (`fn`, proximity 0) even when a closure inside
redeclares `c`, and a module `const cfgs` stays top-level data even when a function
takes a `cfgs` parameter. Before, any declaration in a sub-block demoted the name to
proximity 2, so the outer binding vanished.

Only declarations the block can see count (`visibleDecls`, `declScopesFor` in
classify.ts): those inside the block, and those whose tightest scope contains the
block. The scopes are the function ranges, every block's `scopeRegionFor`, and a
braceless `for (let i …) stmt;`; Python has function scope only. A declaration in
an unrelated function or a sibling block is a different binding. Counting it made
`for (let i …)` in one function read as `out` whenever another function also
declared `i`, so `i++` got the escape mark: 25 of the 87 marks on a snapshot of
this repo's `src/classify.ts`. When no declaration is visible, all of them classify the name,
as before.

Ranking is proximity ascending, then frequency descending, then
function-appearance order as a deterministic tiebreak.

### Proximity 2 is excluded, not merely deprioritised

A name owned by a nested sub-scope is not the focused block's data. Ranking it
last was not enough: with spare budget it still painted, so focusing a function
body lit up closure internals (`sort.Slice(names, func(i, j int) …)`) that mean
nothing at that level — while, worse, the function's *own* parameter stayed
neutral. Those names become visible when the caret enters the sub-scope, where
they are proximity 0. `eligible()` in scopecolor.ts drops them.

### A function's own parameters are proximity 0

A parameter of the focused function classifies as `fn` (correctly — it traces
across the whole function, including nested closures), but it is that function's
own data, not something borrowed from an outer scope. Detection: its declaration
sits inside `block` (from the parameter list, see below) but outside `declRegion`
(body-only for functions). That holds for Go result lists, Rust `-> Result<(), E>`
returns, `where` clauses, wrapped signatures and typed arrows, because
`paramListStart` finds the parameter list itself rather than the last paren group.

### Three regions, three questions

| Function | Question | Function headers |
|---|---|---|
| `lexRegionFor` | which names are *used* here? | **parameter list only** |
| `declRegionFor` | is this name block-local or fn-local? | **excluded** (params stay fn-scoped) |
| `scopeRegionFor` | does this name belong to a nested sub-scope? | **parameter list only** |

`scopeRegionFor` exists because `declRegionFor` was wrong for sub-scope
detection: keeping function headers body-only left a closure's params outside
every sub-scope, so they read as the *outer* block's own locals at proximity 0.
It excludes composite/object-literal headers (`const DEFAULTS = {`,
`cfg := Config{`) because those declare a name owned by the **enclosing** scope.

### Concise arrow bodies are scopes

`scanBraceBlocks` finds `{}` pairs, so a **braceless** arrow was not a scope at all:

```js
.reduce((acc, line, idx) => `${acc}${idx}:${line}; `, "")
```

The caret inside it resolved to the enclosing function, which then treated
`acc`/`line`/`idx` as its *own* block-locals — competing for the outer function's
hues — and the arrow could never be focused in its own right.

A second pass (`scanArrowBlocks`) synthesises a block spanning **parameter list →
end of expression**. Finding that end is the hard part: the body runs to the first
code `,`, `;` or closing bracket at nesting depth 0, or to the end of the template
hole it sits in. Hole delimiters are string, not code, so the `}` in `${acc}` cannot
end the body after four characters.

Depth counts brace-block *and* arrow ancestors, so curried arrows (`a => b => a + b`)
nest properly — otherwise they tie and `innermostBlock` cannot tell which one holds
the caret. The combined list is re-sorted by open offset, since sub-block collection
assumes document order.

Without semicolons the statement ends at a newline: a depth-0 newline ends the body
unless the line before ends in an operator or the line after starts with one
(`.map(…)`, `+ 1`, `?`, `as`, a closing bracket), and a blank line always ends it.
Before, `export const double = (x: number) => x * 2` with no `;` ran to the end of
the file: the arrow became the colour scope of every later function, a top-level
`let hits` read as its capture, and a focus change on a 12k-line file cost 175 ms.

An `=>` in **type position** writes a function type, not a function, and makes no
block (`typeArrowsOf` in focus.ts): after `type X =`, after an annotation colon
(`cb: (x) => void`, `(): () => void {`, `name?:`, a class or interface member), in
a union, intersection or generic argument, after `as` / `satisfies` / `extends` /
`new`, and the inner arrows of a curried type. A function type always parenthesizes
its parameters, so `(n: number): string => n` stays a value arrow. A colon after a
ternary `?` or an object-literal key is not an annotation.

Braced arrows are left to the brace scanner (no double-counting), and an `=>` inside
a string or comment invents nothing. The pass runs only for JavaScript and
TypeScript. In Rust, C# and Scala `=>` also ends a match or switch arm: every
`Status::Pending => "pending",` arm became a one-arm scope one level deeper than its
match, focus collapsed onto it, and Go, Rust, C and Java paid a full extra pass. In
TypeScript a return annotation sits between the parameters and the arrow
(`(n: number): string => …`), so the block starts at the `(` before the `:`; a `:`
after anything but `)` is an object key.

### A function header is not one region — the parameter list is

"Header-inclusive" is too coarse for functions. An inline callback's header carries
**two** things with different owners:

```
  const jobs = names.map(async (name) => {
  ^^^^^^^^^^ enclosing scope     ^^^^^^ the callback's own
```

Taking the whole header from `headerStart` produced both halves of one bug:

- **`scopeRegionFor`** put `jobs`'s declaration inside the callback's sub-scope, so
  from the enclosing function body it scored proximity 2 and was **excluded**.
- **`lexRegionFor`** counted `jobs` as a *use inside* the callback, so focusing the
  callback **painted** it — a name that never appears in that scope — and traced it
  back onto the outer declaration line.

Both now start at `paramListStart()`:

- after a function keyword (`fn`, `func`, `function`, `fun`, `def`, per language),
  the first `(` outside generic angle brackets, so a Go method's receiver counts
  and a Go result list `(int, error)`, a Rust `-> Result<(), E>` or a
  `fn(i32) -> i32` parameter type does not;
- a Rust closure's list starts at its opening `|` (`.map(|x| {`, `move |x| {`);
- otherwise (arrows, methods) the matching `(` of the last balanced code paren
  group before the `{`, so nested parens in defaults (`(a = h(1), b) => {`) do not
  confuse it; a bare single-identifier arrow (`name => {`) falls back to walking
  back over the identifier.

Control-flow blocks keep the full header, since `for idx, n := range names {`
binds on the header itself.

---

## Identity colouring (two passes)

See `src/scopecolor.ts`. The colouring is a **pure function of the document** —
there is no navigation-history state, so the same code always yields the same
hues.

1. **Visibility** — per block, take the top *K* names by attention priority
   (*K* = palette size).
2. **Identity** — build a graph over the colour scope where an edge means two
   names are **co-visible in some block**, then greedy-colour it.

Consequences:

- A shared parent variable is one vertex → **one hue everywhere**, stable as you
  move between sibling blocks.
- Two names never on screen together share no edge, so they may **safely reuse a
  hue**. The "never recycle" rule guards against a shared tint reading as the
  same binding, and that misread is only possible when both are visible at once.
  This is what lets *K* hues cover a function with far more than *K* locals.
- Over-constrained names fall to neutral rather than recycling a visible hue.

Colour scope is the **outermost** function containing the caret, so nested
closures share their parent's palette.

---

## Performance

File-wide analysis (`buildFileIndex`) runs **once per document version** and is
shared by every block in the scope, and the document is lexed once per version
(`lexFor`, see [lexer.md](lexer.md)). A block's identifiers are a binary-searched
slice of that lex, so the per-block pass costs the block, not its offset in the
file.

No lookup on the classification path is linear in the file:

| Lookup | How |
|---|---|
| innermost and outermost function at an offset, "declared in some function" | an interval index per `fnRanges` array (`src/intervals.ts`), built on first use; ties go to the first range in array order, as the linear scans did; 16 ranges or fewer still scan |
| is an offset in the top-level scope's excluded bodies | the excludes merged once, then a binary search |
| does a name occur, tintable, in the block | a binary search into the name's occurrence list, sorted by start |
| the colour scope's first-use order (`fnLocalsInOrder`, `fnGlobals`) | once per colour scope and file index, not once per block |
| the heuristic's file globals and shadow scopes | once per heuristic base and `fnRanges` array |
| trace clipping against shadowing scopes | per name, a prefix maximum of scope ends over scopes sorted by start |

Block headers are cached per lex and block, the top-level excludes and the
open-sorted block list per block list, and the band-2 editor ranges per cached
plan. `test/perf-golden.test.js` checks that this changes no output. Costs per
input size: [runtime.md](runtime.md#cost-on-large-files). Classification stays
debounced behind typing: 140 ms up to 10k lines, growing to 400 ms at 50k
(`editDebounceMs`).

---

## Type declarations are not data

Parameter names inside a **type signature** name nothing at runtime and hold no
data:

```ts
type Reducer<T> = (acc: T, item: Job) => T;      // TS
```
```go
type Handler func(ctx *Context, in []byte)       // Go
```

Both servers report those as `parameter [declaration]` — byte-identical to a real
parameter. And because a type alias is **not** a function range, they classified
as top-level *globals* and traced **file-wide**, so the type alias's `acc` gave
every unrelated `acc` in the file a global's bold hue.

`typeDeclRanges` (classify.ts) excludes them in `buildFileIndex`, so they never
enter the occurrence map at all. Detection is lexical — one linear scan, no
parser: from a line-initial `type`/`interface` in declaration shape (optionally
after `export`, `declare`, `pub`, `public` and similar) to the matching close of
the first bracket opening on that line, else end of line. The shape is
`type Name` followed by `=`, `<`, `[`, `(`, `*` or a type (`type Config struct`,
`type ID int`), Go's grouped `type (` at the end of a line, or `interface Name`.
That covers `type X = …;`, `interface X { … }`, `pub type F = fn(…);`,
`type Config struct { … }` and Go's `type ( … )`. A variable named `type`
(`type = event.get("type", fallback)`) is not one: read as a declaration, it
dropped every token through the call's closing `)`, lines later.

The parameter lists of inline function types (`commaRun: (i: number) => number`,
`(): () => void`; see `typeArrowsOf` in focus.ts) are excluded the same way, on
both the semantic and the heuristic path. Counted, the type's `i` read as a
parameter of the function itself, and the loop's own `i` in its body classified
against it.

In C, C++, Objective-C, Java and Kotlin a `parameter` token outside every
function range names nothing at run time either: a prototype's, a function-pointer
member's (`int (*xRead)(sqlite3_file*, void*, int iAmt)`), an abstract or
interface method's, a Kotlin function type's (`f: (value: Int) -> Int`). It is
dropped (`signatureParameter`); a Java lambda's and a Kotlin constructor's stay
([c-jvm.md](c-jvm.md#server-shapes)).

A whole TypeScript declaration file (`.d.ts`) is static content: no Focus
scope, so nothing in it tints ([javascript.md](javascript.md#declaration-files)).

---

## Function ranges

`fnRanges` decide which function a name belongs to (`enclosingFnOf`) and which
palette it shares (`outermostFnOf`). They are the document symbols of kind
Function, Method and Constructor, plus `functionScopeOf` for every block
(parameter list → closing brace): Go func literals, Rust closures, JS callbacks,
Python lambdas and defs, methods, Kotlin expression bodies (`fun f(x: Int) = x * 2`,
`(` to the end of the expression). A C++ or Java header ending in a qualifier
(`) const`, `) noexcept`, `) -> T`, `) throws E`) is a function; a Kotlin
`public class B(…) {`, `data class` or `enum class` is a type
([c-jvm.md](c-jvm.md#blocks)). A `catch`, `when` or `using` header is a statement
block, and a match arm is control flow, so neither is a function.

Servers report named functions only, so before the block ranges two
`sort.Slice(x, func(i, j int) bool { … })` calls in one function shared one `i`:
it classified against the outer function and traced across both closures. A named
function gets a second range starting at its parameters; `enclosingFnOf` picks
that tighter one and `outermostFnOf` the symbol, so classification and colour
scope are unchanged.

---

## The heuristic fallback

With no semantic tokens (a cold server, or a language with no provider),
`classifyFromHeuristic` reads declarations from the lexer and **paints less**
rather than guess. A name is a data identity only when a declaration for it is
found:

| Declaration | Languages |
|---|---|
| `let` / `const` / `var` / `val` + name (`let mut x`; Go `var x int`) | `var` only in C and Java, where `const` qualifies a type; `def` and `var` in Groovy; in Kotlin only inside a block that is not a type body, since a top-level or member `val` is a property |
| targets of `:=` (`a, b := f()`, Python's walrus) | all |
| `for x in`, `for k, v in` | Python, Rust, Swift |
| statement-start `name =`, `a, b =`, `name: T =`; `with … as x`, `except … as e` | Python (and `#`-comment languages, without annotations) |
| `Type name =` / `Type name;` / `Type[] name` | C, C++, Java, C#, and the default syntax |
| the rest of a declarator list (`int a, b = 0;`, `int a = 1, b = 2;`, `int a[3], b = 1;`), `*` / `&` declarators (`int *p = &n;`), generic types (`List<String> xs =`); the type must start the statement | C, C++, Java, C#, and the default syntax |
| a name in a function block's parameter list | all; first in each group in Go (`a, b int`) and every name in Lua, last in C and Java (`int a`), else followed by `:`, `,`, `)`, `=` or a closure's `\|` and not after a `:` |
| `local a <const>, b`, `local function f`, `for i =`, `for k, v in`; a statement-start `name =` outside every function, which defines the global | Lua (`luaFacts`, [lua.md](lua.md#data-identities)) |
| a scope's first assignment `x =`, `a, b =`; method, block and lambda parameters, block-locals, `for` and `rescue => e` variables, pattern captures, named regex captures; `$x =` outside every method and block, which defines the global | Ruby (`rubyFacts`, [ruby.md](ruby.md#data-identities)) |
| the names of a capture `\|x\|`, `\|*x\|`, `\|x, i\|` after an `if`, `while` or `for` header, `=>`, `catch`, `else` or `errdefer` | Zig (`zigFacts`, [zig.md](zig.md#data-identities)) |
| a destructuring pattern after the keyword: `const { a, b: c } = o`, `const [a, b] = o`, `let (a, b) = o`, `val (a, b) = p`, `let P { x, y } = p`, `if let Some(v) = o`, `while let …` | all with those keywords |
| a match-arm pattern on its line: `Some(v) =>`, `Ok(x) \| Err(x) =>`, `n if n > 3 =>` | Rust |
| `catch (err)`, `catch (e: Exception)`, `catch (IOException e)` | first name in JS / TS, Kotlin, Swift / Scala / Dart; else the last |
| none in a `#` directive line and its `\` continuations, a `typedef`, a C++ `template <…>` list, or a struct, union, enum, class, interface, record or object body (`memberTest`) | C, C++, Objective-C, Java, Kotlin, Groovy ([c-jvm.md](c-jvm.md#data-identities)) |
| lambda parameters `w ->`, `(a, b) ->`, `(String s) ->`; pattern bindings `instanceof T x`, `case T x ->`, `Point(int x, var y)` | Java, Groovy |
| a primary-constructor parameter without `val` / `var` (`class A(x: Int) {`), unless a member `val` / `var` shares its name | Kotlin |
| closure parameters `{ a, b -> }`, `{ String s, int n = 1 -> }` | Groovy |
| a bare arrow parameter (`args =>`), and the names of a destructured parameter (`({ a, b = 1 }, [c, d]) =>`) | JS / TS |
| lambda parameters: `{ a, b -> }`, `{ (k, v) -> }`; `{ a, b in }`, `{ [weak self] a in }` | Kotlin; Swift / Scala / Dart |
| the leading names of each line of `var ( … )` / `const ( … )` | Go |
| bracketed, starred and nested targets: `(a, b) = o`, `a, *rest = o`, `for i, (k, v) in …` | Python |
| `$name =` at statement start; `as $v`, `as $k => $v` | the default syntax (PHP) |
| a template's pattern region: `{#each xs as { id }, i}`, `{:then v}`, `{#snippet row(a, b)}`, `let:x`, `v-for="(item, i) in xs"`, `#header="{ title }"` (`patternDeclarations`) | Vue, Svelte (pattern regions, [components.md](components.md#code-regions)) |

Inside a pattern a key before `:` in `{…}`, a type after `:` in `(…)`, a default
value after `=`, a type or variant before `{` / `(` / `::`, a subscript or
attribute target, and in Rust any capitalised name (a constant or unit variant)
are not bindings. A `{…}` followed by `=` or `=>`, or right after `const` / `let`
/ `var`, is a pattern rather than a scope (`isPatternBrace`), on both paths: its
names belong to the enclosing block. Read as a nested scope, a destructured
`const { a, b } = o` put `a` and `b` at proximity 2, so they never painted. In
JavaScript and TypeScript a caret inside such a pattern, or inside a
destructured parameter (`isParamPattern`), focuses the scope that owns the
names, not the pattern's brace ([javascript.md](javascript.md#blocks-and-focus)).

In JavaScript and TypeScript a `const` / `let` / `var` whose initializer is an
arrow, a `function`, a `class` or a module (`require("…")`, `await
import("…")`, with only member accesses after it) declares no data, and a key
first in a `{…}` item (`key:`, `key?:`, `key!:`, a label) is no candidate
([javascript.md](javascript.md#data-identities)).

In Lua a candidate is a name in a binding position (not a member, key or
label) that is no callee, standard global, module, local function or namespace
global; its keywords are Lua's 22 reserved words, so `type`, `map` and `default`
stay data ([lua.md](lua.md#data-identities)). In Ruby a candidate is an
occurrence `rubyFacts` binds to a local, parameter or user global, by Ruby's own
lexical rule: a name before its first assignment, or followed by an argument,
is a method call ([ruby.md](ruby.md#data-identities)). In Zig the keywords are
Zig's and its primitive types, and a TitleCase or one-letter capital name, a
`@builtin`, a label, a field or enum member written in a container body, a type
parameter, `self`, and a `const` bound to a type, namespace or function (or a
container-level alias of one) are not candidates (`zigFacts`,
[zig.md](zig.md#data-identities)). In C, C++, Java, Kotlin and Groovy the keywords
are each language's own reserved words, so `function`, `from`, `in`, `match`,
`str`, `type` and `val` are data where they are names
([c-jvm.md](c-jvm.md#data-identities)). Elsewhere a candidate occurrence is
a code identifier that is not a keyword, self, `_` or Python `cls`; not a member (`item.size`, a C or PHP `p->x`; in Java, Groovy and Kotlin `->` opens a lambda or arm body, so `w -> out.merge(w)` reads `out`), path segment (`Config::new`), callee
(`fetch(`, an optional call's `cb?.(`), macro (`println!(`) or argument label; and not a name declared by
`function`, `class`, `def`, `fn`, `type`, `struct`, `import` and similar. Python
imports are the exception to that last rule: they are resolved per occurrence,
not per name. No identifier inside an import statement is a candidate, nor is a
use that resolves to an import binding (`pyImportOffsets`, the resolver of the
[import restore](import-restore.md#python)). A parameter or local that shares an
import's name, `def connect(host, ssl)` next to `import ssl`, is still data
(measured in [import-restore.md](import-restore.md#band-2)). Classes
then follow the semantic path, with two differences: a name with no declaration is
never painted (types, imports, functions), and a name whose only declarations are
in functions that do not enclose the block is left neutral rather than painted as
a global. Declarations the block cannot see (another function's, a sibling
block's) are ignored when a visible one exists, as on the semantic path. The
top-level scope carves out function bodies and signatures exactly as on the
semantic path (`excludeRanges`).

The per-lex part (candidates and declarations) is cached per lex and language and
costs 30 to 48 ms once per version on a 1.3 MB Rust file. The file globals and
shadow scopes are cached with it per `fnRanges` array, so after that a 5-block
scope classifies in about 2 ms (stage table in
[runtime.md](runtime.md#cost-on-large-files)).

---

## Shadowing

Occurrences are keyed by **name**, so a module-level `const cfgs` and a
`function summarize(cfgs)` parameter arrive as one list and would share one hue.
That is worse than merely wrong: it asserts a data flow that does not exist, and
visually merges the two identities shadowing already makes easy to confuse — the
highlighting would invite the exact bug class it should expose.

`FileIndex.shadowScopes` maps each name to the **function ranges that declare
it**. An occurrence belongs to the innermost declaring scope around it, and
`dropShadowed` (traces.ts) removes it when that scope is *not* the traced
identity's own:

| Traced identity | Own scope | Effect |
|---|---|---|
| true global (`out`, non-capture) | none | every fn-declaring scope subtracted |
| capture (`out`, `isCapture`) | `homeFn` | other fns' bindings subtracted |
| `fn` / `block` | `enclosingFn` | a nested closure that redeclares the name is subtracted |

Innermost matters once closures are function ranges. Subtracting every foreign
scope removed a closure parameter's own uses whenever the enclosing function also
declared the name (`for c in &cfgs` around `.map(|c| c.with_retries(5))` in
`samples/sample.rs`), because the enclosing function contains the closure.

Verified on `samples/sample.js`: the top-level `cfgs` traces lines 123, 126, 130
and no longer paints `summarize`'s parameter on lines 47-48.

---

## The classification cache key names the document object

`cacheKey()` is `uri#instance::version::focusKey`, and `focusKey` is
`openLine#depth`, plus `#slot` for the second and later blocks that open on one
line at one depth (`.map((x) => …).filter((y) => …)`). `instance` numbers each
`TextDocument` object. The slot counts blocks rather than columns, so typing on a
block's header line keeps its key and band 2 holds its tints. Without it, two
same-line arrows shared a key: the second one's classification painted in both,
and moving between them never reclassified.

- **The URI** separates files: a freshly reloaded window has every document at
  version 1, so without it `sample.js` top level and `sample.go` top level both
  keyed to `1::0#-1`, and switching tabs rendered the first file's occurrence
  offsets against the second file's text.
- **The instance** separates two texts of one file. VS Code builds a new
  `TextDocument` at version 1 when a file is reopened or its language mode
  changes. A file edited while closed (a checkout, a pull, codegen) therefore
  came back as `uri::1::focusKey`, hit the old entry, and painted the old offsets
  on the new text — decorations inside a newly added comment — until the first
  edit.

---

## Opening a file is Survey, not Focus

A file you have not touched yet is Survey by definition (spec §3.2). Only
*intentional* input — a keystroke or a click — advances to Focus.

`refresh()` runs at activation and on every editor switch, and it used to call
`machine.onCaret(block !== null, …)`. But the caret at that moment is wherever VS
Code *restored* it, not somewhere the user put it, so `onCaret` auto-advanced
Survey → Focus and a freshly opened file rendered with band 2 already painted at
the root scope.

`refresh()` now calls `PhaseMachine.reset()`, which drops to Survey and
deliberately bypasses the `minHold` floor — a new viewing context is not a timed
relaxation. Classification is still scheduled, so the first real caret placement
paints from cache with no debounce wait.

### The restored-caret event

`reset()` alone was not enough. Activating an editor makes VS Code **re-report
that editor's restored caret** as an `onDidChangeTextEditorSelection` event. It
arrives around the time `refresh()` sets Survey, so `onCaret()` immediately
re-upgraded — every tab you switched to entered Focus, even though a window reload
correctly started in Survey.

The actual event sequence, captured from the extension's own debug channel after
three failed fixes:

```
refresh     at=0:0                    ← editor activates with caret at 0:0
onSelection kind=undefined at=31:0    ← saved caret restored, ASYNCHRONOUSLY
            → moved 0:0→31:0, engaged, Focus
```

VS Code activates the editor at **0:0**, then restores the saved caret in a separate
**programmatic** selection change with **no `kind`**. So the caret genuinely moves
without any user action.

Three fixes failed before that trace existed, and each failure is instructive:

1. **`kind !== undefined || caretMoved`** — the right first clause, defeated by the
   `||`. The restored event *does* move the caret, so the second clause let it
   through.
2. **Caret position alone** — cannot work at all: the caret really does move.
3. **Position-based engagement** — same flaw, one layer up.

The fix: engagement requires an **attributed input kind**. `decorator.ts` keeps an
`engaged` set of document URIs, added to only by

- a selection change with `e.kind` set — `Keyboard` (1), `Mouse` (2), `Command` (3), or
- an edit the user typed (`onEdit`; typing is unambiguous intent). Format on save,
  rename and an auto-import neither engage nor enter Edit; see
  [runtime.md](runtime.md#typing-versus-other-edits). Nor does an edit in a static
  content or prose file, which has no scope: a typed character there used to enter Edit
  and drop back to Survey on the caret event after it, but an undo that restores the
  caret where it was reports none, and the theme repo's real-editor `dockerbake` cell
  showed 異 for 10 s after Cmd+Shift+K and an undo (2026-11-10). An edit in an HTML
  document's markup, outside every script, is the same ([html.md](html.md#blocks-and-focus)).

`kind` is absent precisely when VS Code cannot attribute the change to input, which
is exactly the restored-caret case.

| situation | `kind` | engaged? | phase |
|---|---|---|---|
| cold open / tab switch, caret restored | `undefined` | no | **Survey** |
| any further programmatic reveal | `undefined` | no | **Survey** |
| arrow key | `Keyboard` | yes | Focus |
| click that moves the caret or collapses a selection | `Mouse` | yes | Focus |
| click on the caret's own position, nothing selected | no event | unchanged | unchanged |
| go-to-definition, find | `Command` | yes | Focus |
| typing | — | yes | Edit |
| typing or an undo in a static content or prose file (`isNonFlowLanguage`) | — | no | **Survey** |
| a click or arrow key in an HTML document's markup, outside every script | `Mouse`, `Keyboard` | yes | **Survey**: no scope |
| typing or an undo in an HTML document's markup | — | no | **Survey** |
| format on save, rename, auto-import | — | unchanged | unchanged |
| return to a tab you had worked in | `undefined` | yes (already) | Focus |
| reopen a file after closing its last tab | `undefined` | no | **Survey** |

Every attributed kind engages, `Mouse` included. An earlier version accepted only
`Keyboard` and `Command`, so a click could not enter Focus ("stuck until I
arrow-key"). Requiring `kind` rather than movement keeps a click that collapses a
selection at the caret working: the caret does not move, the event still says
`Mouse`.

A click that changes nothing reports nothing. VS Code 1.144.1 emits a selection
change only when the cursor state differs: `_emitStateChangedIfNecessary` returns
early on an equal `CursorModelState` (`workbench.desktop.main.js`). No extension
sees a click on the caret's own position with nothing selected. A reopened file
restores its caret where you last left it, so a click on that spot leaves the file
in **Survey**; a click anywhere else, or an arrow key, enters Focus. The theme
repo's real-editor `reopen` scenario measures it: 0 selection events on that
click.

Returning to a tab is deliberate: you chose that caret position earlier, so it is
not a fresh viewing context. Closing the document's last tab clears the entry
(`window.tabGroups.onDidChangeTabs`), so reopening starts fresh; a tab in another
group, or either side of a diff, keeps it. `onDidCloseTextDocument` alone did not
do this. It fires when the model is disposed, and VS Code 1.144.1 holds a model
that any extension opened with `openTextDocument` for up to 3 minutes after its
editor closes (`BoundModelReferenceCollection`, `maxAge` 1e3\*60\*3, in
`workbench.desktop.main.js`). Reopening inside that window handed back the same
document, still engaged, and its restored caret entered Focus with band 2 painted.
In VS Code 1.144.1 a file opened through `openTextDocument`, clicked, closed with
Cmd+W and reopened came back in 流 Focus before the tab check and in 構 Survey after
it; opened through Quick Open alone it came back in Survey either way.
`onDidCloseTextDocument` still clears the entry, so the set does not grow
unbounded.

### Defence in depth: the paint check

`render()` also requires engagement before applying bands 2 or 3, independently of
the phase. Three fixes had tried to keep the *phase* right and a fresh tab still lit
up, so the invariant is asserted where decorations are actually applied — every
non-empty paint flows through one `applyType` call site. Any path that leaves the
phase wrong is therefore harmless. `updateStatus()` reports the same effective
phase, so the status bar cannot show 流 over a blank screen.

---

## Decorations are per-editor

Bands 2 and 3 describe the **focused block**, so only the active editor may show
them. VS Code scopes decorations per `TextEditor` and never clears them for us:
an editor we painted and then navigated away from keeps its old ranges, computed
from a *different* document's classification.

`clearOtherEditors(keep)` therefore strips the gutter and every band-2/3 type
from all other `visibleTextEditors` on every render. Band 1 is the opposite: it
is painted on **every** visible source editor, so an inactive split shows `self`
and the format placeholders the same as the active one. The dirty-check is per
editor and per type, so neither calls `setDecorations` again once its ranges are
in place, until an edit moves them
([runtime.md](runtime.md#decorations-move-with-edits)).

`clearAllVisible()` handles the case where there is **no** active source editor —
focus in a webview, a preview, the settings UI or a panel such as Output. It
clears bands 2 and 3 from every visible editor and keeps band 1. `refresh()`
schedules that render as soon as the active editor goes away; before, the tints
stayed until the next relaxation repainted, up to 24 s later.

Worst case without it: a window reload restores several editors visible at once,
and the unfocused ones show highlighting scattered over comments, strings and
unrelated identifiers.

---

## Keyword tiers (theme, not this extension)

For completeness, since it interacts: jump keywords (`return`, `break`,
`continue`, `throw`, `yield`, `await`, `async`, `defer`, `go`, `goto`,
`fallthrough`) render **keyword grey + bold**; block-openers (`if`, `for`,
`switch`, `case`, `try`, `catch`, `finally`) render **keyword grey, normal**.

Neither Go's nor TypeScript's built-in grammar separates those groups by scope,
so the theme ships injection grammars (`syntaxes/*-flow.injection.json`) that add
`keyword.control.flow.*`. The theme also leaves semantic `keyword` and `member`
**unmapped**, because semantic tokens override TextMate and would otherwise
flatten distinctions the grammars do make. Semantic `property` is mapped, to the
member colour (`#a2bedb` in Okibi).
