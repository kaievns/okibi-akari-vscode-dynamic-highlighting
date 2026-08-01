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
| **Focus 流** | + gutter stripe on the focused block, + **band 2** identity tints |
| **Edit 異** | + **band 3** risk marks (async, danger, number-clay, escaping writes) |

Edit relaxes to Focus after 2 s of no typing; Focus relaxes to Survey after 24 s
of no caret activity. Both are cuts, hysteresis-guarded against flicker.

## Band 2 · identity tints

Data identities in the focused block get a hue from a small pool, so you can
trace a value by colour while reading. Function/method names, type names, struct
fields, builtins and keywords stay band-1 — only **data** is tinted.

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

Edit phase, focused block only. Always shape + colour, never colour alone.

| Mark | Applies to |
|---|---|
| async cyan | `await` / `async` |
| danger bold | `as` casts, `any` |
| number-clay | numeric literals in the focused scope |
| dashed underline | a **write that escapes the block** (assignment to a binding declared outside it) |

Diagnostics (error undercurl, warning underdotted) are left to VS Code — never
double-painted.

## Band 1 · two marks the theme cannot paint

Not phase-gated, and not part of the attention model. These live here only
because a colour theme physically cannot express them — see `src/markdown.ts`.

| Mark | Why `tokenColors` can't do it |
|---|---|
| markdown `==highlight==` wash | `getClassNameFromMetadata` emits only `mtk<foreground>` plus four font-style bits. A token `background` is parsed and indexed, then **never rendered** in the DOM editor. |
| cancelling the link underline | The underline is the `editor.links` contrib decorating each link range with `inlineClassName: "detected-link"`, styled by the workbench stylesheet. It is not a token style, so no theme rule can reach it. |

Both are **resting register**, so they paint in Survey and never blink as
attention moves. That is why `DecorationPool` exposes `banded()` alongside
`all()`: the clear paths strip bands 2–3 from inactive editors while leaving
these two alone. Getting that wrong made a split's second markdown pane lose its
wash.

For the underline there is a one-line alternative — `editor.links` is
`LANGUAGE_OVERRIDABLE`, so a `[markdown]` override could set it `false` — but
that gates the whole contrib and stops links being **clickable**. A competing
decoration with `text-decoration: none !important` keeps ctrl+click. The
`!important` is required: both selectors are single-class under `.monaco-editor`,
so plain `none` loses the tie.

The two scanners are plain lexers over the document text, because the extension
host has no access to the TextMate token stream. They therefore have to
reproduce what the injection grammar gets for free — never matching inside code —
so `codeSpans()` tracks fences, indented blocks, inline spans and frontmatter,
and every tie-break favours "treat as code". Results are cached per document
version; a full scan of a 155 KB markdown file is ~2.3 ms, and only reruns on
edit.

## Develop

```bash
npm install
npm run compile       # or: npm run watch
npm test              # 171 tests
npm run bench         # performance
```

Press **F5** to launch an Extension Development Host. The `samples/` directory has
files for nine languages, each written to exercise the classification cases.

### Tests

| File | Covers |
|---|---|
| `test/pure.test.js` | pure functions — brace scan, lexer, regions, colour assignment, traces, risk |
| `test/golden.test.js` | the classifier against **real** captured LSP tokens (TS + gopls) |
| `test/scopecolor.test.js` | two-pass colouring properties — determinism, sibling stability, safe reuse, no collisions, budget |
| `test/edge.test.js` | phase machine, file index, plan building, degenerate inputs, per-language edge cases |
| `test/python.test.js` | the indentation scanner, comprehension/lambda scopes, f-string lexing, the language dispatcher, Python header classification, class attributes |

The golden fixtures are captured from real language servers, which is what catches
"the server tokenizes differently than we assumed". Regenerate them after editing
the samples:

```bash
node test/gen-ts-semtok.js samples/sample.js > test/fixtures/sample.js.tokens.json
~/go/bin/gopls semtok samples/sample.go | node test/gen-go-semtok.js samples/sample.go > test/fixtures/sample.go.tokens.json
```

## Settings

| Setting | Default | Notes |
|---|---|---|
| `okibiDynamic.enabled` | `true` | Master toggle (also the status-bar click / `Okibi Dynamic: Toggle`). |
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
  `{…}` around the caret"), so a synchronous brace scan resolves it identically to
  LSP scopes while staying language-agnostic and not awaiting on every caret move.
  *Classification* does use LSP semantic tokens, with a heuristic fallback for
  languages that have no server.
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
- **f-strings are code, and the lexer used to treat them as text.** The shared
  identifier lexer knew JS templates — backtick plus `${` — but Python f-strings use
  a quote plus a bare `{`, so every name inside one was invisible. That is not
  cosmetic: names are gated on being used at least **twice**, and `prefix`, `page`
  and `timeout_sum` in `samples/sample.py` each have exactly one plain use plus one
  f-string use. All three silently failed the gate and never tinted anywhere, in any
  scope. The fix tracks which quote opened the current string so the closing
  delimiter is right on the way out, honours `{{` as an escaped brace, and only
  treats `{` as a hole when the string carried an `f` prefix (`f"…"`, `rf'…'`) that
  is not merely the tail of an identifier like `conf`. Lexing `#` as a Python
  comment came with it — words in a comment were being counted as uses.
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
  lambda, so the ranges come from there rather than from a second scanner.

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
  real read. Only `(`/`,` immediately before the name makes a following `=` a
  label.
- **Python has no captured token fixture, and cannot have one.** Go and TS goldens
  come from running the real server. Pylance is the only server that emits Python
  semantic tokens, and its licence restricts it to Microsoft products — driven from
  a test harness it prints its licence to stderr and exits 1. Pyright, the
  open-source engine beneath it, advertises no semantic-token provider at all. So
  the Python token shapes in `test/python.test.js` are constructed to Pylance's
  documented legend rather than captured, and that limitation is stated in the file
  rather than hidden.
- **Two clocks.** Classification (expensive, LSP) is debounced — 140 ms for
  typing, 60 ms for navigation. Rendering (cheap) is coalesced to a microtask,
  with a per-decoration-type dirty check so an unchanged token set costs nothing.
- **Measured, not assumed.** Every classification rule traces to captured
  language-server output. When behaviour in the editor disagreed with a
  simulation, the simulation was wrong — `Developer: Inspect Editor Tokens and
  Scopes` is the arbiter.
