/**
 * Resolved Okibi/Akari token values (sRGB hex), from the design-system spec
 * `# TOKENS · resolved values`. Only the tokens the dynamic layer needs are
 * carried here. Dark = Okibi, light = Akari.
 *
 * The theme (band 1) already paints the resting register; this extension paints
 * the ember-line (focused-block gutter bar), the band-2 identity tints, and the
 * band-3 risk marks on top.
 */

import * as vscode from 'vscode';

export interface TokenPair {
  /** Okibi (dark) */
  dark: string;
  /** Akari (light) */
  light: string;
}

export const TOKENS = {
  // ember — owns focus/action. The focused-block gutter bar uses the solid
  // ember; its softness (spec --ember-line = ember @ 50%) is applied via the
  // SVG stripe's fill-opacity, not baked into the hex.
  ember: { dark: '#ff7c50', light: '#c63a00' },

  // spine steps referenced by the fill computation
  n2: { dark: '#1b1e20', light: '#f9f6f2' }, // editor ground
  n11: { dark: '#e1e3e5', light: '#13110e' }, // foreground (fill is a % of this)

  // band 2 · identity tints — ONE tint set for all data identities. The former
  // idg-* chroma-boosted tier is retired from the spec: out-of-fn data uses the
  // same hue and carries the distinction in WEIGHT alone (bold, bold-as-law).
  // Designer palette (calibrated): slots {1,2,3,5,7}. Yamabuki gold (2) is in
  // rotation now that this/self moved to keyword grey; wakaba (6) and moegi (4)
  // are retired. Array is in ROTATION order [1,3,2,7,5] — greedy max-separation
  // (hue gaps 125°,163°,136°,42°): the closest pair only when all five in play.
  id: [
    { dark: '#db9065', light: '#bc662f' }, // slot 1 · kohaku amber 50
    { dark: '#9d8eff', light: '#6b5ecc' }, // slot 3 · fuji periwinkle 285
    { dark: '#ddbd6e', light: '#9d7300' }, // slot 2 · yamabuki gold 88
    { dark: '#ea94ff', light: '#8f4bb4' }, // slot 7 · ayame violet 312
    { dark: '#f685b6', light: '#b34378' }, // slot 5 · akabeni rose 354
  ] as TokenPair[],
  // this/self — --id-self = var(--syn-keyword): identical to band 1's resting
  // keyword colour, so painting it is a NO-OP wherever band 1 already got it right.
  // It is painted anyway, because band 1 cannot always get it right: when
  // rust-analyzer runs on a file outside a cargo workspace (no Cargo.toml — which is
  // every loose `.rs` file), a `self` USE degrades to the semantic type `const`,
  // indistinguishable from an ordinary local. A semantic token overrides the
  // grammar, and `const` is unmapped-with-no-fallback, so `self.retries` rendered at
  // `editor.foreground` — plain white. No theme rule can fix that, because the
  // degraded `self` and a real local carry the SAME type; only this layer knows
  // which is which. Weight stays normal so there is still no flip on focus change.
  idSelf: { dark: '#7c8894', light: '#6b7681' },
  // Format placeholders — member steel, the register for reaching into data. Same
  // value as the theme's FORMAT PLACEHOLDERS rule, because this decoration exists
  // only to reach the ONE case a theme rule cannot: rust-analyzer emits a single
  // `string` semantic token over a whole literal, which outranks the grammar's
  // `meta.interpolation.rust` and turns the holes green. See src/placeholders.ts.
  placeholder: { dark: '#a2bedb', light: '#516f8e' },
  // --id-outer — designer token, role not yet specified in the dynamic spec;
  // carried here unwired until its behaviour is defined.
  idOuter: { dark: '#ff9c7c', light: '#bb461e' },

  // band 3 · risk
  riskAsync: { dark: '#4bc8d5', light: '#007481' },
  riskMut: { dark: '#eeb64f', light: '#a86d00' }, // designer token, not yet wired
  riskEscape: { dark: '#f57c5f', light: '#be3a16' },
  riskDanger: { dark: '#f66e60', light: '#be241f' },

  // number-clay — engaged scope only
  numberEngaged: { dark: '#c9a18d', light: '#9f7661' },

  // --sel — ember 34%/28% wash. Identity-on-demand for OVERFLOWED (neutral)
  // bindings: caret on a neutral name lights its occurrences in the block.
  sel: { dark: '#693e30', light: '#ebc1ae' },

  // --warn — yamabuki. Backing colour for the markdown ==highlight== wash. The
  // spec's `.hlt` is `color-mix(in srgb, var(--warn) 16%, transparent)`; the 16%
  // is applied as an alpha suffix rather than pre-flattened against the ground,
  // so the mark composes over whatever is under the line (selection, find match).
  warn: { dark: '#e6af2b', light: '#956000' },
} as const;

/** VS Code reports the active theme kind; pick the matching side of a token. */
export function pick(pair: TokenPair, isDark: boolean): string {
  return isDark ? pair.dark : pair.light;
}

/** 0..1 opacity → two-digit hex alpha suffix (e.g. 0.5 → "80"). */
export function alphaHex(opacity: number): string {
  const o = Math.max(0, Math.min(1, opacity));
  return Math.round(o * 255)
    .toString(16)
    .padStart(2, '0');
}

/**
 * A translucent fill = foreground colour at `opacity`, over the editor ground.
 * Returned as an 8-digit hex so it composes as a genuine overlay regardless of
 * what actually sits under the line.
 */
export function fillColor(isDark: boolean, opacity: number): string {
  const fg = isDark ? TOKENS.n11.dark : TOKENS.n11.light;
  const clamped = Math.max(0, Math.min(1, opacity));
  const alpha = Math.round(clamped * 255)
    .toString(16)
    .padStart(2, '0');
  return `${fg}${alpha}`;
}

/**
 * An ember fill as an SVG data URI, for use as a decoration's `gutterIconPath`.
 * This is the one public-API way to draw in the gutter: the icon renders in the
 * glyph-margin slot on each line the decoration covers, in the gutter's own
 * reserved space — so it never shifts or clips the code.
 *
 * `widthPct` is the fraction of the icon slot the fill covers, left-aligned:
 *   - 100 → a full block filling the whole glyph-margin slot (with `cover`,
 *     edge-to-edge and gapless down the block — the seamless-band look).
 *   - <100 → a left-anchored stripe of that width.
 *
 * Opacity is baked in via fill-opacity to get the --ember-line softness
 * (ember @ 50%) without an alpha hex.
 *
 * @param color    solid ember hex (no alpha)
 * @param opacity  0..1 — spec --ember-line is 0.5
 * @param widthPct 1..100 — fill width as a percentage of the icon slot
 */
export function gutterStripeUri(color: string, opacity: number, widthPct = 100): string {
  const o = Math.max(0, Math.min(1, opacity));
  const w = Math.max(1, Math.min(100, widthPct));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="none">` +
    `<rect x="0" y="0" width="${w}" height="100" fill="${color}" fill-opacity="${o}"/>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/**
 * The band-2 + band-3 decoration-type pool. Created once per theme kind and
 * rebuilt only on a dark↔light flip. All types use ClosedClosed range behaviour
 * so a mark doesn't grow while typing at its edge (prevents smear).
 *
 *   id[0..5]      — fn-local tints, normal weight (foreground colour)
 *   idg[0..5]     — out-of-fn tints, bold
 *   self          — this/self gold, bold
 *   riskAsync     — await/async cyan
 *   riskDanger    — as/any, bold
 *   riskEscape    — dashed underline (colour in the CSS so it composes over a tint)
 *   numberEngaged — clay numeric literals
 *   mdHighlight   — markdown ==highlight== wash (band 1, always on; see below)
 *   mdLinkPlain   — cancels VS Code's link underline (band 1, always on)
 *
 * The last two are band-1 marks and deliberately NOT phase-gated: they exist
 * because a colour theme physically cannot express them, not because they carry
 * attention state.
 *
 *   - A `background` in `tokenColors` is parsed and indexed but never rendered
 *     in the DOM editor: `getClassNameFromMetadata` emits only `mtk<foreground>`
 *     plus four font-style bits (italic/bold/underline/strikethrough). A
 *     decoration is the only way to fill behind text.
 *   - The link underline comes from the `editor.links` contrib, which decorates
 *     every provider-reported link range with `inlineClassName: "detected-link"`,
 *     and the workbench stylesheet says
 *     `.monaco-editor .detected-link { text-decoration: underline }`. That is not
 *     a token style, so no theme rule can reach it. Setting `editor.links: false`
 *     would remove it, but that also stops links being clickable — a functional
 *     loss for a cosmetic fix, so it is done with a competing decoration instead.
 */
export interface DecorationPool {
  id: vscode.TextEditorDecorationType[];
  idg: vscode.TextEditorDecorationType[];
  self: vscode.TextEditorDecorationType;
  riskAsync: vscode.TextEditorDecorationType;
  riskDanger: vscode.TextEditorDecorationType;
  riskEscape: vscode.TextEditorDecorationType;
  numberEngaged: vscode.TextEditorDecorationType;
  placeholder: vscode.TextEditorDecorationType;
  mdHighlight: vscode.TextEditorDecorationType;
  mdLinkPlain: vscode.TextEditorDecorationType;
  /** Every type in the pool, for bulk dispose. */
  all(): vscode.TextEditorDecorationType[];
  /**
   * The PHASE-GATED types only — bands 2 and 3.
   *
   * The clear helpers must use this rather than `all()`: bands 2/3 belong to the
   * focused block of the active editor and have to come off everything else, but
   * the two markdown marks are band 1 and belong to every visible editor showing
   * that document. Clearing them alongside the bands made a split's second
   * markdown pane lose its highlight wash.
   */
  banded(): vscode.TextEditorDecorationType[];
}

export function buildDecorationPool(isDark: boolean): DecorationPool {
  const closed = vscode.DecorationRangeBehavior.ClosedClosed;
  const colorType = (color: string, bold: boolean): vscode.TextEditorDecorationType =>
    vscode.window.createTextEditorDecorationType({
      color,
      fontWeight: bold ? 'bold' : 'normal',
      rangeBehavior: closed,
    });

  const id = TOKENS.id.map((p) => colorType(pick(p, isDark), false));
  // Out-of-fn tier: same tints, bold weight — weight alone carries the
  // distinction (the separate idg-* hue set is retired from the spec).
  const idg = TOKENS.id.map((p) => colorType(pick(p, isDark), true));
  // NOT bold: --id-self equals band 1's keyword colour, so this decoration must be
  // visually identical to the resting render — its only job is to restore that
  // colour when a degraded semantic token has overridden it. See TOKENS.idSelf.
  const self = colorType(pick(TOKENS.idSelf, isDark), false);
  const placeholder = colorType(pick(TOKENS.placeholder, isDark), false);
  const riskAsync = colorType(pick(TOKENS.riskAsync, isDark), false);
  const riskDanger = colorType(pick(TOKENS.riskDanger, isDark), true);
  const riskEscape = vscode.window.createTextEditorDecorationType({
    textDecoration: `underline dashed ${pick(TOKENS.riskEscape, isDark)}`,
    rangeBehavior: closed,
  });
  const numberEngaged = colorType(pick(TOKENS.numberEngaged, isDark), false);

  // The ==highlight== wash. `backgroundColor` is an 8-digit hex (--warn at 16%)
  // so it composes over the selection rather than replacing it, and the radius
  // plus a hair of horizontal padding reproduce the spec's chip without shifting
  // the glyphs — VS Code lays decorations out inline, so vertical padding here
  // would change the line box.
  const mdHighlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: `${pick(TOKENS.warn, isDark)}${alphaHex(0.16)}`,
    borderRadius: '2px',
    rangeBehavior: closed,
  });

  // Cancels the `.detected-link` underline. `text-decoration: none` alone loses
  // to it on specificity — both land as single-class selectors under
  // `.monaco-editor`, and the link rule is inserted by the workbench stylesheet,
  // so `!important` is what actually settles it. Decoration style values are
  // substituted into the CSS template verbatim (no sanitising pass), so the flag
  // survives. `Open` range behaviour: this tracks a provider range, not a mark
  // being typed, so it should follow edits at the edges.
  const mdLinkPlain = vscode.window.createTextEditorDecorationType({
    textDecoration: 'none !important',
    rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
  });

  return {
    id,
    idg,
    self,
    riskAsync,
    riskDanger,
    riskEscape,
    numberEngaged,
    placeholder,
    mdHighlight,
    mdLinkPlain,
    all(): vscode.TextEditorDecorationType[] {
      return [...this.banded(), self, placeholder, mdHighlight, mdLinkPlain];
    },
    // The PHASE bands: withdrawn when the caret leaves the editor, restored when it
    // comes back. `self` is deliberately NOT here — it is a band-1 mark this layer
    // paints (--id-self equals band 1's resting keyword colour), so it must look
    // identical in Survey, Focus and Edit and must not blink when focus moves to a
    // panel. It lives in `all()` instead, so only switching the extension off
    // removes it. Keeping it banded made `self` flash white on every relaxation to
    // Survey, because the semantic `const` token it corrects is still in force.
    banded(): vscode.TextEditorDecorationType[] {
      return [...id, ...idg, riskAsync, riskDanger, riskEscape, numberEngaged];
    },
  };
}
