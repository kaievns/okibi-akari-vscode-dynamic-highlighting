# Okibi & Akari — Dynamic Highlighting

The dynamic layer for the [Okibi / Akari](https://kaievns.github.io/okibi-akiri-design-system-spec/) design system. The color theme paints **band 1** (the resting register — always on). This extension adds the stateful part of the doctrine: the three-phase attention model.

> **Survey 構** (viewing) → **Focus 流** (reading) → **Edit 異** (writing)
>
> Cumulative supersets: each phase only *adds* a layer. Transitions are cuts, never fades. Calm at rest is a hard requirement.

## Status — first slice

This is the smallest useful vertical slice, so the Survey → Focus → Edit transition can be felt in a real editor before the tint and risk layers are built (the spec says the dwell timings can only be tuned live).

**Implemented:**

- **Phase machine** (§3) — Survey/Focus/Edit with immediate upgrades on intentional input and timed, hysteresis-guarded relaxations. Dwell values are the spec's validated-in-browser starting points, all configurable.
- **Focus resolution** (§1, §3.2) — the innermost brace-block containing the caret. Deepest-block-wins, via a language-neutral brace scanner that skips strings and comments.
- **Focused-block indicator** (§3.5) — faint fill (2% fg) + 2px inset ember bar on the focused block, appearing in Focus/Edit and withdrawing in Survey.
- **Phase readout** in the status bar (構 / 流 / 異) to help dial in the dwell timings.

**Not yet (next slices):**

- **Band 2 · identity tints** (§4–§5) — classify each variable by binding distance (block-local / fn-local / out-of-fn) via LSP references, then assign the pre-vetted six-tint pool by salience order. Tokens already resolved in `src/tokens.ts`.
- **Band 3 · risk** (§6) — escaping-write dashed underlines, `await` async cyan, `as`/`any` danger, diagnostics grammar.

## Develop

```
npm install
npm run watch      # or: npm run compile
```

Then press **F5** ("Run Extension") to launch an Extension Development Host with the layer active. Open any brace-language file and move the caret / type to feel the phases. The status bar (bottom-right) shows the current phase.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `okibiDynamic.enabled` | `true` | Master toggle (also the status-bar click / `Okibi Dynamic: Toggle` command). |
| `okibiDynamic.showPhaseInStatusBar` | `true` | Show 構/流/異 in the status bar. |
| `okibiDynamic.focusFillOpacity` | `0.02` | Focused-block fill as a fraction of fg. Spec value 2%. |
| `okibiDynamic.dwell.editToFocus` | `1400` | ms of no typing before Edit → Focus. |
| `okibiDynamic.dwell.focusToSurvey` | `12000` | ms of no activity before Focus → Survey. |
| `okibiDynamic.dwell.minHold` | `350` | ms floor before any downgrade (anti-flicker). |

## Design notes

- **Why a separate extension.** A VS Code color theme is three static maps (workbench colors, TextMate scopes, semantic tokens) — a pure classification → color function with no input for caret, focus, or mode. Bands 2–3 are inherently stateful, so they cannot live in a theme. The spec's §9 says the deliverable is "a theme + an extension for the dynamic layer." Decorations layer *on top of* the theme, which is exactly the cumulative-superset composition the doctrine wants.
- **Brace scan vs LSP for focus.** Focus is purely structural ("the innermost `{…}` around the caret"), so a synchronous brace scan resolves it identically to LSP scopes while staying language-agnostic and not awaiting on every caret move. Classification (band 2) *will* use LSP references per §7 — that's where symbol keying matters for shadowing (§8.3).
