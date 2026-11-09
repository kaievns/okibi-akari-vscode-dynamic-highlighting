# Band-2 identity palette

Five tints per theme, in `TOKENS.id` (`src/tokens.ts`). Globals use the same hex
in bold (`pool.idg`). `test/palette.test.js` checks the invariants below.

| Pool index | Spec slot | Name | Okibi | OKLCH | Akari | OKLCH |
|---|---|---|---|---|---|---|
| 0 | 1 | kohaku | `#d88c60` | 0.708 0.110 50.3 | `#9e572c` | 0.532 0.110 49.7 |
| 1 | 3 | fuji | `#968ed9` | 0.683 0.109 288.0 | `#5f5aa0` | 0.505 0.109 285.0 |
| 2 | 2 | yamabuki | `#bf9e4a` | 0.713 0.110 87.9 | `#8e6804` | 0.542 0.110 83.0 |
| 3 | 7 | ayame | `#bb86c7` | 0.695 0.110 320.0 | `#84528f` | 0.518 0.109 320.2 |
| 4 | 5 | akabeni | `#d481a4` | 0.701 0.111 353.5 | `#9b4e6f` | 0.528 0.109 354.5 |

The values differ from the vendored spec's `--id-*` (theme repo,
`scripts/spec/tokens-syntax.css`). The README records the deviation.

## Method

- **One chroma per theme:** OKLCH C 0.110 for all five hues.
- **Per-hue lightness:** each hue's L is solved so that its perceived lightness
  matches the others. Perceived lightness is the mean of three
  Helmholtz-Kohlrausch models: Fairchild-Pirrotta 1991, Nayatani 1997 (VAC) and
  Hellwig-Stolitzka-Fairchild 2022. The base level is L 0.70 (Okibi) and
  L 0.525 (Akari).
- **Nayatani VCC is left out.** It is the outlier: it puts yamabuki at L 0.79
  and the violets at L 0.64, which brings the unevenness back.
- **Not checked by eye.** If yamabuki reads dull or brown on screen, VCC
  predicted it; the single-value fix is yamabuki L +0.02.
- **Hues:** Okibi fuji 288 and ayame 320 are where the previous `#9d8eff` and
  `#ea94ff` rendered after sRGB clipping. Akari ayame moved from 312 to 320 to
  sit between fuji (285) and akabeni (354).

## Invariants

Formulas, all in `test/palette.test.js`: OKLab (Ottosson), WCAG 2 contrast,
ΔE_OK (Euclidean in OKLab), and Fairchild-Pirrotta
`L** = L* + (2.5 − 0.025 L*)(0.116 |sin((h − 90)/2)| + 0.085) C*` on CIELAB
(D65). The test uses Fairchild-Pirrotta alone because it is the one closed-form
model of the three.

| Invariant | Limit | Okibi before → now | Akari before → now |
|---|---|---|---|
| each tint's OKLCH C within ±0.003 of the theme mean | mean ≤ 0.12 | mean 0.139 (0.105–0.171) → 0.110 | mean 0.147 (0.120–0.168) → 0.109 |
| Fairchild-Pirrotta L** spread | ≤ 2.5 | 10.80 → 0.81 | 5.96 → 1.80 |
| lowest WCAG contrast on the editor ground (`TOKENS.n2`) | ≥ 4.5 | 6.18 → 5.72 (fuji) | **3.84** (kohaku) → 4.72 (yamabuki) |
| closest pair, ΔE_OK | ≥ 0.06 | 0.103 → 0.061 (fuji / ayame) | 0.073 → 0.064 (kohaku / yamabuki) |
| escape and async marks, hue gap to `editorError.foreground` | ≥ 30° | escape 36.2°, async 178.9° | escape 35.7°, async 175.6° |

The danger mark is not in the hue check. It is bold red text by design, not an
underline that a diagnostic squiggle could be mistaken for.

## Hand-out order

`scopecolor.ts` gives each name the lowest pool index its co-visible
neighbours leave free. A block with *n* co-visible tints therefore shows indices
0 to *n* − 1, and the closest pair in play depends on *n*:

| Tints in the block | Okibi closest pair | Akari closest pair |
|---|---|---|
| 2 | 0.194 kohaku / fuji | 0.196 kohaku / fuji |
| 3 | 0.071 kohaku / yamabuki | 0.064 kohaku / yamabuki |
| 4 | 0.061 fuji / ayame | 0.064 kohaku / yamabuki |
| 5 | 0.061 fuji / ayame | 0.064 kohaku / yamabuki |

The order [kohaku, fuji, akabeni, yamabuki, ayame] would raise the 3-tint
closest pair to 0.105 (Okibi) and 0.102 (Akari). It also changes the hue of every
name in every file, so it is a separate decision and is not applied.

## Trade-offs

- **Closest pair.** Okibi's closest pair drops from 0.103 to 0.061. Fuji and
  ayame were 0.124 apart, mostly from their lightness gap (L 0.709 and 0.791),
  which even lightness removes. At equal L the distance is 2·C·sin(Δh/2), so
  keeping 0.124 would need C ≥ 0.22.
- **Caret line.** The lowest contrast on the caret line (`#222527` / `#ebe7e2`)
  is 5.26:1 (Okibi fuji) and 4.13:1 (Akari yamabuki). It was 5.69:1 and 3.36:1.
- **Selection.** On the selection (`#693e30` / `#ebc1ae`) contrast is 3.07 to
  3.52:1 (Okibi) and 3.09 to 3.69:1 (Akari). The selection is transient.
- **Decorator violet.** Fuji sits ΔE_OK 0.056 (Okibi) and 0.040 (Akari) from the
  theme's decorator colour (`#998cb3` / `#705e91`). If that reads ambiguous, the
  fix belongs in the theme's decorator rule, not here.
- **Escape underline on kohaku.** The escape colour (`#e0a26f` / `#a06024`) sits
  ΔE_OK 0.056 (Okibi) and 0.027 (Akari) from kohaku. Under a kohaku name the
  dashed line is close to the text colour; the dash shape still marks it.
