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
| `0` | declared directly in the focused block — its own data |
| `1` | borrowed in (fn-local, capture, global) |
| `2` | declared in a **nested** sub-block the caret sits above |

Ranking is proximity ascending, then frequency descending, then
function-appearance order as a deterministic tiebreak.

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
