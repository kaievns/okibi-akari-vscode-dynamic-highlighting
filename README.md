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

## Develop

```bash
npm install
npm run compile       # or: npm run watch
npm test              # 82 tests
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
- **Two clocks.** Classification (expensive, LSP) is debounced — 140 ms for
  typing, 60 ms for navigation. Rendering (cheap) is coalesced to a microtask,
  with a per-decoration-type dirty check so an unchanged token set costs nothing.
- **Measured, not assumed.** Every classification rule traces to captured
  language-server output. When behaviour in the editor disagreed with a
  simulation, the simulation was wrong — `Developer: Inspect Editor Tokens and
  Scopes` is the arbiter.
