# Classification rules

Why a given token does or does not get a band-2 identity tint. Every rule here
was derived from **real language-server output**, not guesswork — TypeScript via
`getEncodedSemanticClassifications`, Go via `gopls semtok`. Regenerate the
captured fixtures with:

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

### Modifier exclusions

| Modifier | Effect | Rationale |
|---|---|---|
| `defaultLibrary` | excluded | builtins (`console`, `Math`, `nil`, `true`) are library surface, not this file's data |
| `signature` | excluded | gopls marks **func-typed values** (`h Handler`); calls through them are transformers, so they keep band-1 |
| `definition` (on `property`) | excluded | a field/member **definition** (Go struct fields) is structure |

### Name exclusions

| Name | Why |
|---|---|
| `_` | discard/blank identifier (Go, Python); also the lodash module facade in JS |
| `this`, `self`, `@…` | painted by band 1 only (`--id-self` = `--syn-keyword`), so no weight flip on focus change |

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
there would misclassify them as block-local and trip the ≥2-use gate.

Control-flow keywords take precedence over paren-based function detection,
because `for (...) {` and `if (...) {` have parens too.

### The module top-level scope

The caret is often outside every brace-block — sitting on a top-level `const`,
`var` or `type`. That is a real scope, not Survey, so `innermostBlock` falls back
to a **synthetic** block (`topLevelBlock`, `depth: -1`) spanning the whole file.
`isTopLevelBlock(block)` identifies it.

Two consequences follow from "spans the whole file":

**1. `excludeRanges` carves out the nested code.** Without it every local in
every function is lexically inside the top-level region, so focusing line 1
tints random locals throughout the file. The carve-out is:

- every depth-0 block **body** (`openOffset … closeOffset`) — function and type
  bodies, and
- every depth-0 **function signature** (`headerStart … openOffset`), which sits
  *outside* the braces and would otherwise read as top-level code.

The signature exclusion is gated on `isFunctionHeaderText`, because a top-level
`const DEFAULTS = { … }` is *also* a depth-0 block, and its "header" holds the
one name we most want at top level. Excluding it hid `DEFAULTS` entirely.

For the same reason the top-level block's `subBlocks` use `declRegionFor`, not
`lexRegionFor`: the header-inclusive variant would put `DEFAULTS` inside its own
initialiser's sub-block and demote it to proximity 2.

**2. The ≥2-use gate is relaxed** for `proximity === 0` names (`isTopLevel` flag
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
neutral so dense blocks stay calm.

`out` non-captures render **bold** (weight = reaches beyond the local frame);
captures render like locals.

---

## Attention proximity

When a block has more eligible names than the palette has hues, `proximity`
decides who wins a slot:

| Value | Meaning |
|---|---|
| `0` | declared directly in the focused block, **or a parameter of the focused function** — its own data |
| `1` | borrowed in (fn-local from an outer scope, capture, global) |
| `2` | declared in a **nested** sub-block the caret sits above — **excluded, never painted** |

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
sits inside `block` (header-inclusive) but outside `declRegion` (body-only for
functions).

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
`,`, `;` or closing bracket at nesting depth 0, skipping strings, comments and
template interpolations. Without interpolation tracking the `}` in `${acc}` ended the
body after four characters.

Depth counts brace-block *and* arrow ancestors, so curried arrows (`a => b => a + b`)
nest properly — otherwise they tie and `innermostBlock` cannot tell which one holds
the caret. The combined list is re-sorted by open offset, since sub-block collection
assumes document order.

Braced arrows are left to the brace scanner (no double-counting), and an `=>` inside
a string or comment invents nothing. Go is unaffected — no arrows, and `func` *types*
are already excluded as type declarations.

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

Both now start at `paramListStart()`: the matching `(` of the last balanced paren
group before the `{`. Balanced scanning handles nested parens in defaults
(`(a = h(1), b) => {`); a bare single-identifier arrow (`name => {`) falls back to
walking back over the identifier. Control-flow blocks keep the full header, since
`for idx, n := range names {` binds on the header itself.

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
shared by every block in the scope. Before that hoist, each per-block classify
redid the whole-file token scan, so an *N*-block scope cost *N* file passes and
time grew with total file size even when scope size was fixed.

On a 100 KB file: **~0.6 ms per focus change** (was ~12 ms), with a ~5.6 ms index
build once per edit, debounced 140 ms behind typing. Run `npm run bench`.

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
parser: from a line-initial `type`/`interface` (optionally after
`export`/`declare`) to the matching close of the first bracket opening on that
line, else end of line. That covers `type X = …;`, `interface X { … }`,
`type Config struct { … }` and Go's grouped `type ( … )`.

---

## Shadowing

Occurrences are keyed by **name**, so a module-level `const cfgs` and a
`function summarize(cfgs)` parameter arrive as one list and would share one hue.
That is worse than merely wrong: it asserts a data flow that does not exist, and
visually merges the two identities shadowing already makes easy to confuse — the
highlighting would invite the exact bug class it should expose.

`FileIndex.shadowScopes` maps each name to the **function ranges that declare
it**. `dropShadowed` (traces.ts) then removes any occurrence sitting inside a
declaring scope that is *not* the traced identity's own:

| Traced identity | Own scope | Effect |
|---|---|---|
| true global (`out`, non-capture) | none | every fn-declaring scope subtracted |
| capture (`out`, `isCapture`) | `homeFn` | other fns' bindings subtracted |
| `fn` / `block` | `enclosingFn` | already clipped there; no-op in practice |

Verified on `samples/sample.js`: the top-level `cfgs` traces lines 123, 126, 130
and no longer paints `summarize`'s parameter on lines 47-48.

---

## The classification cache key MUST include the document URI

`cacheKey()` is `uri::version::focusKey`, and `focusKey` is only
`openLine#depth`. Dropping the URI is not a theoretical hazard: a freshly
reloaded window has **every document at version 1**, so `sample.js` top level and
`sample.go` top level both keyed to `1::0#-1`. Switching tabs then rendered the
first file's occurrence *offsets* against the second file's text — decorations
landing mid-word and inside comments. That was the "garbled highlighting on files
not focused at window reload" bug.

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
- an edit (`onEdit`, unconditional — typing is unambiguous intent).

`kind` is absent precisely when VS Code cannot attribute the change to input, which
is exactly the restored-caret case.

| situation | `kind` | engaged? | phase |
|---|---|---|---|
| cold open / tab switch, caret restored | `undefined` | no | **Survey** |
| any further programmatic reveal | `undefined` | no | **Survey** |
| arrow key | `Keyboard` | yes | Focus |
| click, even at the same position | `Mouse` | yes | Focus |
| go-to-definition, find | `Command` | yes | Focus |
| typing | — | yes | Edit |
| return to a tab you had worked in | `undefined` | yes (already) | Focus |

Requiring `kind` rather than movement is what keeps a **same-position click** working
— that was an earlier bug ("stuck until I arrow-key").

The last row is deliberate: you chose that caret position earlier, so returning is
not a fresh viewing context. `onDidCloseTextDocument` clears the entry, so reopening
starts fresh and the set does not grow unbounded.

### Defence in depth: the paint gate

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

`clearOtherEditors(keep)` therefore strips every decoration type from all other
`visibleTextEditors` whenever the active editor changes, and on
`onDidChangeVisibleTextEditors`. It bypasses the `lastApplied` dirty-check, which
tracks only the active editor's state.

`clearAllVisible()` handles the case where there is **no** active text editor —
focus in a webview, panel or another split. `clearAll(undefined)` could not: with
no editor there is nothing to paint through, so it only reset the dirty-check map.
A Focus → Survey relaxation firing while the caret was outside the document
therefore left the tints on screen indefinitely.

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
`keyword.control.flow.*`. The theme also leaves semantic `keyword`, `property`
and `member` **unmapped**, because semantic tokens override TextMate and would
otherwise flatten distinctions the grammars do make (e.g. getter vs field).
