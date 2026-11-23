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
  ground: { dark: '#0f1113', light: '#f9f6f2' }, // editor.background: Okibi n0, Akari n2
  n11: { dark: '#e1e3e5', light: '#13110e' }, // foreground (fill is a % of this)

  // band 2 · identity tints, one set for all data identities: globals take the
  // same hex in bold. One OKLCH chroma per theme, per-hue L for even
  // perceived lightness. Order is the hand-out order (lowest free index first).
  // Values, method and invariants: docs/palette.md, test/palette.test.js.
  id: [
    { dark: '#d88c60', light: '#9e572c' }, // spec slot 1 · kohaku 50
    { dark: '#968ed9', light: '#5f5aa0' }, // spec slot 3 · fuji 288 / 285
    { dark: '#bf9e4a', light: '#8e6804' }, // spec slot 2 · yamabuki 88 / 83
    { dark: '#bb86c7', light: '#84528f' }, // spec slot 7 · ayame 320
    { dark: '#d481a4', light: '#9b4e6f' }, // spec slot 5 · akabeni 354
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
  // only for the cases a theme rule cannot reach: rust-analyzer's single `string`
  // token over a whole literal, and bracket-pair colorization on Python f-string
  // field braces. See src/placeholders.ts.
  placeholder: { dark: '#a2bedb', light: '#516f8e' },
  // The theme's namespace / type slate, for imported modules and types in a
  // document no semantic provider colours. See src/imports.ts.
  typeSlate: { dark: '#a5b6c8', light: '#52657a' },
  // --id-outer — designer token, role not yet specified in the dynamic spec;
  // carried here unwired until its behaviour is defined.
  idOuter: { dark: '#ff9c7c', light: '#bb461e' },

  // band 3 · risk
  riskAsync: { dark: '#4bc8d5', light: '#007481' },
  riskMut: { dark: '#eeb64f', light: '#a86d00' }, // designer token, not yet wired
  // Off-spec: held 30° or more of hue from editorError. docs/risk-marks.md#style-and-colour.
  riskEscape: { dark: '#e0a26f', light: '#a06024' },
  riskDanger: { dark: '#f66e60', light: '#be241f' },

  // number-clay — engaged scope only
  numberEngaged: { dark: '#c9a18d', light: '#9f7661' },

  // The theme's `comment` colour (italic), for band-1 marks that put comment text
  // painted as code (a code-typed semantic token, a bracket-pair level) back.
  comment: { dark: '#646a70', light: '#8b857d' },
  // The theme's `string` colour, for brackets in Rust strings painted at a
  // bracket-pair level. See docs/runtime.md#brackets-in-rust-comments-and-strings.
  string: { dark: '#8ecd92', light: '#257231' },
  // The theme's builtin / constant red, for C-family `NULL`, `true` and `false` that a
  // server types `macro`. See docs/c-jvm.md#band-1-restores.
  constant: { dark: '#f2716c', light: '#be222d' },
  // The theme's operator grey and attribute violet, for Swift operators that sourcekit-lsp
  // types as calls and the attribute it types as a type or a macro. See docs/swift.md#band-1-restores.
  operator: { dark: '#9fa5ac', light: '#585e65' },
  attribute: { dark: '#998cb3', light: '#705e91' },
  // The theme's call blue (bold), for a named static call sourcekit-lsp types as the standard
  // library's operators. See docs/swift.md#band-1-restores.
  call: { dark: '#6eaff7', light: '#005eac' },

  // --sel — the themes' editor.selectionBackground, ember 22%/28% over the editor ground.
  // Identity-on-demand for OVERFLOWED (neutral) bindings: caret on a neutral name lights
  // its occurrences in the block.
  sel: { dark: '#442920', light: '#ebc1ae' },

  // --warn — yamabuki. Backing colour for the markdown ==highlight== wash. The
  // spec's `.hlt` is `color-mix(in srgb, var(--warn) 16%, transparent)`; the 16%
  // is applied as an alpha suffix rather than pre-flattened against the ground,
  // so the mark composes over whatever is under the line (selection, find match).
  warn: { dark: '#e6af2b', light: '#956000' },

  // The theme's markdown register, for the prose restores (src/markdown.ts proseMarks): sigils
  // n7, struck text n8, quotes n9, prose n10, link text sora (Akari's is not `call`); inline
  // code is `placeholder`'s member steel.
  n7: { dark: '#585b5f', light: '#b5b0a9' },
  n8: { dark: '#707376', light: '#8d8982' },
  n9: { dark: '#8f9296', light: '#6c6863' },
  n10: { dark: '#bbbec1', light: '#403d38' },
  mdLink: { dark: '#6eaff7', light: '#015ba6' },
} as const;

/** The spec's `.u-escape`: dashed, 1.5px, offset 3px, never broken around descenders. */
export function riskEscapeDecoration(color: string): string {
  return `underline dashed ${color}; text-decoration-thickness: 1.5px; text-underline-offset: 3px; text-decoration-skip-ink: none`;
}

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
 *   id[0..4]      — locals and captures, normal weight
 *   idg[0..4]     — globals: the same five hexes, bold
 *   self          — this/self in band 1's keyword colour, normal weight
 *   riskAsync     — await/async cyan
 *   riskDanger    — as/any, bold
 *   riskEscape    — dashed underline (colour in the CSS so it composes over a tint)
 *   numberEngaged — clay numeric literals
 *   placeholder   — Rust format placeholders and Python f-string fields (band 1, always on)
 *   commentRestore — comment colour over Go doc links and brackets in Rust comments (band 1, always on)
 *   stringRestore — string colour over brackets in Rust strings (band 1, always on)
 *   constantRestore — constant red over C-family NULL, true and false (band 1, always on)
 *   operatorRestore — operator grey over Swift operators (band 1, always on)
 *   bracketRestore — normal weight over Swift subscript brackets, colour left to bracket-pair colourization (band 1, always on)
 *   attributeRestore — attribute violet over the name in a Swift `@attribute` (band 1, always on)
 *   callRestore   — bold call blue over a named Swift static call sourcekit-lsp types as an operator (band 1, while it answers)
 *   importRestore — type slate over imported modules and types (band 1, until a provider answers)
 *   shadowRestore — page colour over non-call uses of a shadowed Python builtin (band 1, same lifetime)
 *   mdHighlight   — markdown ==highlight== wash (band 1, always on; see below)
 *   mdSigil … mdLinkText — markdown prose restores, one per register step (band 1, always on)
 *   mdBold        — restored bold: setext heading text, strong emphasis (band 1, always on)
 *   mdItalic      — restored italic: emphasis across lines (band 1, always on)
 *   mdLinkStruck  — mdLinkPlain inside struck text, keeping the line (band 1, always on)
 *   mdLinkPlain   — cancels VS Code's link underline (band 1, always on)
 *
 * The band-1 marks are deliberately NOT phase-bound: they exist because a
 * colour theme physically cannot express them, not because they carry
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
  commentRestore: vscode.TextEditorDecorationType;
  stringRestore: vscode.TextEditorDecorationType;
  constantRestore: vscode.TextEditorDecorationType;
  operatorRestore: vscode.TextEditorDecorationType;
  bracketRestore: vscode.TextEditorDecorationType;
  attributeRestore: vscode.TextEditorDecorationType;
  callRestore: vscode.TextEditorDecorationType;
  importRestore: vscode.TextEditorDecorationType;
  shadowRestore: vscode.TextEditorDecorationType;
  mdHighlight: vscode.TextEditorDecorationType;
  mdSigil: vscode.TextEditorDecorationType;
  mdStruck: vscode.TextEditorDecorationType;
  mdQuote: vscode.TextEditorDecorationType;
  mdProse: vscode.TextEditorDecorationType;
  mdEmphasis: vscode.TextEditorDecorationType;
  mdLinkText: vscode.TextEditorDecorationType;
  mdCode: vscode.TextEditorDecorationType;
  mdBold: vscode.TextEditorDecorationType;
  mdItalic: vscode.TextEditorDecorationType;
  mdLinkStruck: vscode.TextEditorDecorationType;
  mdLinkPlain: vscode.TextEditorDecorationType;
  /** Every type in the pool, for bulk dispose. */
  all(): vscode.TextEditorDecorationType[];
  /**
   * The PHASE-BOUND types only — bands 2 and 3.
   *
   * The clear helpers must use this rather than `all()`: bands 2/3 belong to the
   * focused block of the active editor and have to come off everything else, but
   * the markdown marks are band 1 and belong to every visible editor showing
   * that document. Clearing them alongside the bands made a split's second
   * markdown pane lose its highlight wash.
   */
  banded(): vscode.TextEditorDecorationType[];
}

const behaviors = new WeakMap<vscode.TextEditorDecorationType, vscode.DecorationRangeBehavior>();

/** createTextEditorDecorationType, remembering the type's range behaviour for rangeBehaviorOf. */
export function decorationType(options: vscode.DecorationRenderOptions): vscode.TextEditorDecorationType {
  const type = vscode.window.createTextEditorDecorationType(options);
  behaviors.set(type, options.rangeBehavior ?? vscode.DecorationRangeBehavior.OpenOpen);
  return type;
}

/** How VS Code moves this type's ranges when text is typed at their edges; OpenOpen is its default. */
export function rangeBehaviorOf(type: vscode.TextEditorDecorationType): vscode.DecorationRangeBehavior {
  return behaviors.get(type) ?? vscode.DecorationRangeBehavior.OpenOpen;
}

export function buildDecorationPool(isDark: boolean): DecorationPool {
  const closed = vscode.DecorationRangeBehavior.ClosedClosed;
  const colorType = (color: string, bold: boolean): vscode.TextEditorDecorationType =>
    decorationType({
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
  // VS Code writes `textDecoration` verbatim into `text-decoration:{0};`, so the
  // spec's .u-escape geometry rides in the same string.
  const riskEscape = decorationType({
    textDecoration: riskEscapeDecoration(pick(TOKENS.riskEscape, isDark)),
    rangeBehavior: closed,
  });
  const numberEngaged = colorType(pick(TOKENS.numberEngaged, isDark), false);
  const commentRestore = decorationType({
    color: pick(TOKENS.comment, isDark),
    fontStyle: 'italic',
    fontWeight: 'normal',
    rangeBehavior: closed,
  });
  const stringRestore = colorType(pick(TOKENS.string, isDark), false);
  const constantRestore = colorType(pick(TOKENS.constant, isDark), false);
  const operatorRestore = colorType(pick(TOKENS.operator, isDark), false);
  // No colour: the editor's bracket-pair colour wins over the colour sourcekit-lsp gives a
  // bracket, but not its weight (docs/swift.md#band-1-restores).
  const bracketRestore = decorationType({ fontWeight: 'normal', rangeBehavior: closed });
  const attributeRestore = colorType(pick(TOKENS.attribute, isDark), false);
  const callRestore = colorType(pick(TOKENS.call, isDark), true);
  // After id / idg on purpose: VS Code inserts each type's CSS rule at the front of
  // the sheet and decoration colour is `!important`, so the earlier type wins an overlap.
  const importRestore = colorType(pick(TOKENS.typeSlate, isDark), false);
  // The page colour, normal weight: the grammar paints a builtin bold call blue.
  const shadowRestore = colorType(pick(TOKENS.n11, isDark), false);

  // The ==highlight== wash. `backgroundColor` is an 8-digit hex (--warn at 16%)
  // so it composes over the selection rather than replacing it, and the radius
  // plus a hair of horizontal padding reproduce the spec's chip without shifting
  // the glyphs — VS Code lays decorations out inline, so vertical padding here
  // would change the line box.
  const mdHighlight = decorationType({
    backgroundColor: `${pick(TOKENS.warn, isDark)}${alphaHex(0.16)}`,
    borderRadius: '2px',
    rangeBehavior: closed,
  });

  // Prose restores: colour only, so the grammar's weight, italic and line stay; before
  // mdLinkPlain, so the earlier-created type wins an overlap.
  const tone = (pair: TokenPair): vscode.TextEditorDecorationType => decorationType({ color: pick(pair, isDark), rangeBehavior: closed });
  const mdSigil = tone(TOKENS.n7);
  const mdStruck = tone(TOKENS.n8);
  const mdQuote = tone(TOKENS.n9);
  const mdProse = tone(TOKENS.n10);
  const mdEmphasis = tone(TOKENS.n11);
  const mdLinkText = tone(TOKENS.mdLink);
  const mdCode = tone(TOKENS.placeholder);
  const mdBold = decorationType({ fontWeight: 'bold', rangeBehavior: closed });
  const mdItalic = decorationType({ fontStyle: 'italic', rangeBehavior: closed });
  const mdLinkStruck = decorationType({
    textDecoration: 'line-through !important',
    rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
  });

  // Cancels the `.detected-link` underline. `text-decoration: none` alone loses
  // to it on specificity — both land as single-class selectors under
  // `.monaco-editor`, and the link rule is inserted by the workbench stylesheet,
  // so `!important` is what actually settles it. Decoration style values are
  // substituted into the CSS template verbatim (no sanitising pass), so the flag
  // survives. `Open` range behaviour: this tracks a provider range, not a mark
  // being typed, so it should follow edits at the edges.
  const mdLinkPlain = decorationType({
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
    commentRestore,
    stringRestore,
    constantRestore,
    operatorRestore,
    bracketRestore,
    attributeRestore,
    callRestore,
    importRestore,
    shadowRestore,
    mdHighlight,
    mdSigil,
    mdStruck,
    mdQuote,
    mdProse,
    mdEmphasis,
    mdLinkText,
    mdCode,
    mdBold,
    mdItalic,
    mdLinkStruck,
    mdLinkPlain,
    all(): vscode.TextEditorDecorationType[] {
      return [...this.banded(), self, placeholder, commentRestore, stringRestore, constantRestore, operatorRestore, bracketRestore, attributeRestore, callRestore, importRestore, shadowRestore, mdHighlight, mdSigil, mdStruck, mdQuote, mdProse, mdEmphasis, mdLinkText, mdCode, mdBold, mdItalic, mdLinkStruck, mdLinkPlain];
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
