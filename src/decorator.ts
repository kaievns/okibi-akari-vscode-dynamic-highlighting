/**
 * The decorator — the orchestrator that binds the phase machine, focus
 * resolver, classifier, colour planner, trace expander and risk detector to the
 * active editor, and paints the result.
 *
 * Two clocks, physically separated, are the whole performance story:
 *   - EXPENSIVE (classification / LSP): DEBOUNCED. Typing coalesces at 140ms
 *     (up to 400ms past 10k lines); discrete navigation at 60ms. Runs at most once
 *     per document version.
 *   - CHEAP (render): COALESCED to a microtask so a burst of events collapses to
 *     one applyDecorations pass.
 *
 * What each phase shows (cumulative supersets, spec §3):
 *   - Survey 構: gutter stripe withdrawn, no tints, no risk. Calm at rest.
 *   - Focus 流: gutter stripe + band-2 identity tints on the focused block
 *     (plus traces).
 *   - Edit 異: everything Focus shows + band-3 risk marks. Relaxes back to Focus
 *     after editToFocus (2000ms) of no typing — a single clean cut.
 *
 * All visual changes are CUTS — set on selection/edit/phase change, never
 * animated (§3.4). Smoothness comes from debouncing + a stale-hold that keeps
 * band-2 on screen while a fresh classification is computed mid-typing, and a
 * per-type dirty-check that only repaints what actually changed.
 */

import * as vscode from 'vscode';
import { flowText, isRegionLanguage, regionAt, viewRegions } from './html';
import {
  scanBlocks,
  innermostBlock,
  functionScopeOf,
  isParamPattern,
  isPatternBrace,
  focusKeyOf,
  lexRegionFor,
  isNonFlowLanguage,
  isMarkdownLanguage,
  isLinkMarkLanguage,
  effectiveLanguageId,
  band1LanguageId,
  isTopLevelBlock,
  topLevelExcludes,
  topLevelLines,
  inSortedRanges,
  BraceBlock,
} from './focus';
import { LexId, LexResult, forgetLex, lexFor, relex, rememberLex, selfWords, syntaxFor } from './lex';
import { cMacroRestores, kotlinTemplateSpans } from './cjvm';
import { PhaseMachine, Phase, PHASE_KANJI, DwellConfig, DEFAULT_DWELL, isTypingEdit } from './phases';
import { TOKENS, pick, gutterStripeUri, buildDecorationPool, DecorationPool, decorationType, rangeBehaviorOf } from './tokens';
import { mayForceMove, rangesMovedBy } from './tracking';
import { Classifier, PathKeywords, RUST_PATH_KEYWORDS, SemanticState } from './classify-lsp';
import { Classification, OffsetRange } from './classify';
import { ColorPlan, planFromColoring } from './colors';
import { ScopeColoring } from './scopecolor';
import { computeTraceRanges } from './traces';
import { lexicalRisk, escapeRisk } from './risk';
import { codeSpans, highlightSpans, linkSpans } from './markdown';
import { mdxCodeSpans } from './mdx';
import {
  Span, jsPlaceholderSpans, luaPlaceholderSpans, pythonPlaceholderSpans, rubyPlaceholderSpans, rustPlaceholderSpans, rustStringBracketSpans,
  sveltePlaceholderSpans, zigPlaceholderSpans,
} from './placeholders';
import { COMPONENT_LANGUAGES } from './sfc';
import { commentBracketSpans, goDocLinkSpans } from './doclinks';
import { importUseNames, importUseSpans, shadowUseSpans } from './imports';
import { luaRestoreSpans } from './lua';
import { rubyKeywordSelf, rubyShadowSpans } from './ruby';
import { zigImportSpans, zigKeywordSelf } from './zig';

interface Config {
  enabled: boolean;
  showPhaseInStatusBar: boolean;
  dwell: DwellConfig;
}

function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('okibiDynamic');
  return {
    enabled: c.get('enabled', true),
    showPhaseInStatusBar: c.get('showPhaseInStatusBar', true),
    dwell: {
      editToFocus: c.get('dwell.editToFocus', DEFAULT_DWELL.editToFocus),
      focusToSurvey: c.get('dwell.focusToSurvey', DEFAULT_DWELL.focusToSurvey),
      minHold: c.get('dwell.minHold', DEFAULT_DWELL.minHold),
    },
  };
}

/** Debounce windows tuned to the character of each event source. */
const DEBOUNCE_EDIT_MS = 140; // typing: bursty, coalesce harder
const DEBOUNCE_FOCUS_MS = 60; // discrete nav: snappier

/** The typing debounce: longer past 10k lines, where one reclassify outlasts a gap between keys. */
export function editDebounceMs(lineCount: number): number {
  return lineCount <= 10_000 ? DEBOUNCE_EDIT_MS : Math.min(400, Math.round(DEBOUNCE_EDIT_MS + (lineCount - 10_000) / 150));
}
// Save participants (format on save, organise imports) run between onWillSave and
// onDidSave. A failed save never fires onDidSave, so the window also expires.
const SAVE_WINDOW_MS = 5000;

/**
 * URI schemes of documents the layer paints. Everything else is an editor that
 * is not a source file: output and debug channels, the SCM commit box, comment
 * inputs, search editors. The Output channel is the dangerous one: it reports
 * every debug line as an edit, so painting it would feed itself.
 */
const DECORATABLE_SCHEMES = new Set(['file', 'untitled', 'vscode-remote', 'vscode-vfs', 'vscode-notebook-cell']);

export function isDecoratable(doc: { uri: { scheme: string } }): boolean {
  return DECORATABLE_SCHEMES.has(doc.uri.scheme);
}

const langOf = (doc: vscode.TextDocument): string => effectiveLanguageId(doc.languageId, doc.fileName);
/** Band 1 reads a TypeScript declaration file as TypeScript; only bands 2–3 treat it as static. */
const band1LangOf = (doc: vscode.TextDocument): string => band1LanguageId(langOf(doc));

interface Band1Inputs {
  readonly paths: PathKeywords | undefined;
  readonly ok: boolean;
  readonly strings: boolean;
  readonly typed: string;
}

/** The `import * as` restore (docs/import-restore.md#javascript-and-typescript). A JSX tag is not a use: the theme paints tags. */
const NAMESPACE_RESTORE_LANGUAGES = new Set(['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'html', 'vue', 'svelte', 'astro']);

/** The document URIs a tab shows: a text tab's, or both sides of a diff. */
function tabUris(tab: { input: unknown }): string[] {
  const input = tab.input as { uri?: vscode.Uri; original?: vscode.Uri; modified?: vscode.Uri } | undefined;
  return [input?.uri, input?.original, input?.modified]
    .filter((u): u is vscode.Uri => u !== undefined)
    .map((u) => u.toString());
}

const PLACEHOLDER_SCANS: Record<string, ((text: string, lex: LexResult) => Span[]) | undefined> = {
  kotlin: (_text, lex) => kotlinTemplateSpans(lex),
  rust: rustPlaceholderSpans,
  python: pythonPlaceholderSpans,
  lua: luaPlaceholderSpans,
  ruby: rubyPlaceholderSpans,
  javascript: jsPlaceholderSpans,
  javascriptreact: jsPlaceholderSpans,
  svelte: sveltePlaceholderSpans,
  zig: zigPlaceholderSpans,
};
/** Languages whose theme paints the placeholders unless the server's answer types string literals. */
const STRING_TOKEN_LANGUAGES = new Set(['lua', 'zig']);

const COMMENT_RESTORE_SCANS: Record<string, ((text: string, lex: LexResult) => Span[]) | undefined> = {
  go: (text, lex) => goDocLinkSpans(text, lex),
  rust: (text, lex) => commentBracketSpans(text, lex),
  javascript: (text, lex) => commentBracketSpans(text, lex, true),
  typescript: (text, lex) => commentBracketSpans(text, lex, true),
  javascriptreact: (text, lex) => commentBracketSpans(text, lex, true),
  typescriptreact: (text, lex) => commentBracketSpans(text, lex, true),
  svelte: (text, lex) => commentBracketSpans(text, lex, true),
};

interface CacheEntry {
  classification: Classification;
  plan: ColorPlan;
  semantic: SemanticState;
  /**
   * A heuristic plan built while a registered provider answered nothing. Band 2
   * does not paint it and keeps only semantic tints already on screen: the
   * provider's answer replaces it within the retry schedule. False once the
   * schedule is spent.
   */
  hold: boolean;
}

interface DocState {
  version: number;
  text: string;
  lex: LexResult;
  blocks?: BraceBlock[];
  topLevel?: { excludes: OffsetRange[]; gutter: vscode.Range[] };
}

interface AppliedRanges {
  ranges: vscode.Range[];
  key: string;
  moved?: boolean;
}

/** Band-3 lexical marks and clay numbers for one block, as editor ranges. */
interface RiskRanges {
  async: vscode.Range[];
  danger: vscode.Range[];
  numbers: vscode.Range[];
}

export class Decorator implements vscode.Disposable {
  private config: Config;
  private machine: PhaseMachine;
  private statusItem: vscode.StatusBarItem;

  private isDark: boolean;
  private gutterDecoration!: vscode.TextEditorDecorationType;
  private pool!: DecorationPool;

  private classifier = new Classifier();
  // No colour ledgers: hues come from the per-scope co-visibility colouring
  // (scopecolor.ts), which is a pure function of the document — so there is no
  // navigation-history state that could make colours order-dependent.
  // Text + lex + blocks per document version. Caching the TEXT matters as much as
  // the blocks: doc.getText() rebuilds the whole document string, and it was being
  // called several times per caret move.
  private blockCache = new WeakMap<vscode.TextDocument, DocState>();
  // The previous version's lex and the one change that replaced it, for a document a
  // visible editor shows: the render that follows re-lexes only around the change.
  private relexFrom = new WeakMap<
    vscode.TextDocument,
    { version: number; lex: LexResult; start: number; oldEnd: number; newEnd: number }
  >();
  // Markdown band-1 mark ranges per document version. Both scanners walk the
  // whole document, and renderMarkdownMarks runs on every render (every caret
  // move), so without this a large .md file would re-lex on each keystroke.
  private mdCache = new WeakMap<
    vscode.TextDocument,
    { version: number; highlight: vscode.Range[]; link: vscode.Range[] }
  >();
  // Rust, Python and Lua format-placeholder ranges per document version. Same reasoning as
  // mdCache: the scan walks the whole document and render runs on every caret move.
  private placeholderCache = new WeakMap<
    vscode.TextDocument,
    { version: number; ranges: vscode.Range[] }
  >();
  // `self` / `this` ranges per document version, for the same reason, and whether they
  // include the Rust path keywords.
  private selfCache = new WeakMap<
    vscode.TextDocument,
    { version: number; paths: boolean; ranges: vscode.Range[] }
  >();
  // C-family NULL / true / false ranges per document version, for the same reason.
  private constantCache = new WeakMap<
    vscode.TextDocument,
    { version: number; ranges: vscode.Range[] }
  >();
  // Comment-restore ranges (Go doc links, brackets in Rust comments) per document version, for the same reason.
  private commentRestoreCache = new WeakMap<
    vscode.TextDocument,
    { version: number; ranges: vscode.Range[] }
  >();
  // Brackets in Rust strings per document version and semantic state, for the same reason.
  private stringRestoreCache = new WeakMap<
    vscode.TextDocument,
    { version: number; semantic: boolean; ranges: vscode.Range[] }
  >();
  // Import- and shadow-restore ranges per document version. Unlike the other band-1
  // marks they are recomputed after the typing debounce, not per keystroke: see renderImports.
  private importCache = new WeakMap<
    vscode.TextDocument,
    { version: number; typed: string; ranges: vscode.Range[]; shadows: vscode.Range[] }
  >();
  private importTimers = new Map<vscode.TextDocument, ReturnType<typeof setTimeout>>();
  // Bounded LRU keyed by cacheKey().
  private classCache = new Map<string, CacheEntry>();
  // Band-2 editor ranges per plan: an entry belongs to one version and block, and
  // band 2 repaints on every render.
  private band2Ranges = new WeakMap<
    CacheEntry,
    { region: OffsetRange; id: vscode.Range[][]; idg: vscode.Range[][] }
  >();
  private static CACHE_LIMIT = 16;
  // A number per TextDocument object. VS Code builds a new object at version 1 when
  // a file is reopened or its language changes, so uri + version alone can name two
  // different texts.
  private instanceIds = new WeakMap<vscode.TextDocument, number>();
  private nextInstanceId = 1;

  // Which range list each editor currently shows per type, for dirty-checking.
  // Decorations are per-editor, and band 1 paints every visible editor. The array
  // is kept too: the per-version caches hand back the same array, which skips
  // building the key. `moved`: an edit has since moved these ranges on screen.
  private applied = new WeakMap<
    vscode.TextEditor,
    Map<vscode.TextEditorDecorationType, AppliedRanges>
  >();
  // The editor band 2/3 were last rendered for; a change resets the stale-holds.
  private lastActiveEditor: vscode.TextEditor | undefined;
  // Documents inside a save, with the time onWillSave fired (see SAVE_WINDOW_MS).
  private saving = new WeakMap<vscode.TextDocument, number>();
  // Documents the user has intentionally engaged: a selection change carrying an
  // input `kind`, or an edit. Only an engaged document may enter Focus or paint
  // bands, so activating a tab can never do it.
  //
  // Necessary because VS Code restores a tab's saved caret ASYNCHRONOUSLY, as a
  // programmatic selection change with `kind === undefined`. The debug trace was
  // unambiguous:
  //   refresh     at=0:0                   ← editor activates at 0:0
  //   onSelection kind=undefined at=31:0   ← saved caret restored afterwards
  // So the caret really does move with no user action, which is why comparing
  // positions could not distinguish it, and why a window reload behaved differently
  // from a tab switch.
  private engaged = new Set<string>();

  private currentFocusKey: string | null = null;
  // The focusKey whose band-2 tints are currently painted. Lets the stale-hold
  // distinguish "same block, awaiting reclassify" (hold) from "moved to a new
  // block" (clear then cut).
  private renderedBand2Key: string | null = null;
  // Whether those tints came from semantic tokens. A provider-silent hold keeps
  // only these: heuristic tints painted before the provider registered are not
  // its answer.
  private renderedBand2Semantic = false;
  // The focusKey whose escape underlines are on screen; same stale-hold rule as band 2.
  private renderedEscapeKey: string | null = null;
  // The block the last render painted the gutter and bands for. A render between an
  // edit and its caret update reads the old caret against the new text, so it can
  // paint a block the caret is not in; undefined when nothing was painted.
  private renderedBlockKey: string | null | undefined;
  // Band-3 and clay ranges for the focused block at one document version. A render
  // runs on every caret move and keystroke; the ranges only change with the text,
  // the block or the classification.
  private riskCache: {
    key: string;
    lexical: { async: vscode.Range[]; danger: vscode.Range[]; numbers: vscode.Range[] };
    escapeFor?: CacheEntry;
    escape?: vscode.Range[];
  } | undefined;
  private classifyToken: vscode.CancellationTokenSource | undefined;
  /** The classification in flight: a second request for its cache key awaits it instead of restarting it. */
  private classifying: { key: string; token: vscode.CancellationToken; done: Promise<void> } | undefined;
  // The classifier state each document's last band-1 render read. A classify compares the
  // state after its answer with this, not with the state when it started: answers to
  // overlapping classifies land out of order, and each started from the same state.
  private band1Seen = new WeakMap<vscode.TextDocument, Band1Inputs>();

  private relaxTimer: ReturnType<typeof setTimeout> | undefined;
  private classifyTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDoc: vscode.TextDocument | undefined;
  private renderQueued = false;

  private disposables: vscode.Disposable[] = [];

  // Temporary diagnostic channel. Toggle with the config flag okibiDynamic.debug.
  private debugChan: vscode.OutputChannel | undefined;
  private dbg(msg: string): void {
    if (this.debugChan) {
      this.debugChan.appendLine(msg);
    }
  }

  /**
   * Create or tear down the debug output channel to match `okibiDynamic.debug`.
   * Called from the constructor AND on config change, so toggling the setting takes
   * effect without a window reload. It also reveals the channel on enable — the
   * Output dropdown does not list a channel until something writes to it.
   */
  private syncDebugChannel(): void {
    const want = vscode.workspace.getConfiguration('okibiDynamic').get('debug', false);
    if (want && !this.debugChan) {
      this.debugChan = vscode.window.createOutputChannel('Okibi Dynamic Debug');
      this.debugChan.appendLine('Okibi dynamic debug enabled. Switch tabs to capture events.');
      this.debugChan.show(true); // preserveFocus: do not steal the caret
    } else if (!want && this.debugChan) {
      this.debugChan.dispose();
      this.debugChan = undefined;
    }
  }

  constructor() {
    this.config = readConfig();
    this.machine = new PhaseMachine(this.config.dwell);
    this.isDark = this.currentlyDark();
    this.syncDebugChannel();

    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = 'okibiDynamic.toggle';
    this.disposables.push(this.statusItem);

    this.buildDecorations();

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onEdit(e)),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      // A newly visible editor (split, tab restore after reload) gets band 1, and
      // never inherits band 2/3: render() clears them off every non-active editor.
      vscode.window.onDidChangeVisibleTextEditors(() => this.scheduleRender()),
      // Closing a document forgets its engagement, so reopening it starts in Survey
      // like any freshly opened file — and the maps do not grow unbounded.
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.engaged.delete(doc.uri.toString());
        this.saving.delete(doc);
      }),
      // The close event waits for the model to be disposed, which a reference held
      // by any extension's openTextDocument delays by up to 3 minutes. The last tab
      // closing is when the user closed the file.
      vscode.window.tabGroups.onDidChangeTabs((e) => this.onTabsClosed(e.closed)),
      vscode.workspace.onWillSaveTextDocument((e) => this.onWillSave(e.document)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onDidSave(doc)),
      vscode.window.onDidChangeActiveColorTheme(() => this.onThemeChanged()),
      vscode.workspace.onDidChangeNotebookDocument((e) => this.onNotebookChanged(e)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('okibiDynamic')) {
          this.config = readConfig();
          this.machine.setDwell(this.config.dwell);
          // Honour a debug toggle without a window reload. Creating the channel only
          // in the constructor meant flipping the setting appeared to do nothing —
          // the channel was not even listed in the Output dropdown.
          this.syncDebugChannel();
          // No setting changes a colour, so the pool is kept: a rebuild strips band
          // 1 from every editor until each one is repainted.
          this.refresh();
        }
      }),
    );

    this.refresh();
  }

  private currentlyDark(): boolean {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
  }

  private buildDecorations(): void {
    this.gutterDecoration?.dispose();
    this.pool?.all().forEach((t) => t.dispose());
    this.applied = new WeakMap();
    this.lastActiveEditor = undefined;
    this.renderedBand2Key = null;
    this.renderedEscapeKey = null;

    const ember = pick(TOKENS.ember, this.isDark);
    // The focus indicator: a thin 2px ember stripe at 50% opacity, left-aligned
    // in the glyph-margin slot (the only public way to paint the gutter).
    const stripe = gutterStripeUri(ember, 0.5, 4);
    this.gutterDecoration = decorationType({
      gutterIconPath: vscode.Uri.parse(stripe),
      gutterIconSize: 'cover',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    this.pool = buildDecorationPool(this.isDark);
  }

  private onThemeChanged(): void {
    const nowDark = this.currentlyDark();
    if (nowDark !== this.isDark) {
      this.isDark = nowDark;
      this.classCache.clear(); // plans are colour-agnostic but the pool changed; rebuild cleanly
      this.buildDecorations();
      this.refresh();
    }
  }


  /**
   * Blocks AND text for a document, cached together per version.
   *
   * `doc.getText()` materialises the whole document into a fresh string — it is not
   * a cheap accessor. It was being called on every caret move (twice: once here,
   * once for the top-level fallback) and again in every render, which is what made
   * navigation feel laggy on large files. One cache serves all of them.
   */
  private docStateFor(doc: vscode.TextDocument): DocState & { blocks: BraceBlock[] } {
    const state = this.textStateFor(doc);
    if (!state.blocks) {
      state.blocks = scanBlocks(state.text, langOf(doc));
    }
    return state as DocState & { blocks: BraceBlock[] };
  }

  /**
   * Text + lex for the current version, without the block scan. Band 1 paints
   * every visible editor and needs no blocks.
   */
  private textStateFor(doc: vscode.TextDocument): DocState {
    const cached = this.blockCache.get(doc);
    if (cached && cached.version === doc.version) {
      return cached;
    }
    if (cached) {
      forgetLex(cached.text);
    }
    const text = flowText(doc.getText(), langOf(doc));
    const from = this.relexFrom.get(doc);
    this.relexFrom.delete(doc);
    const lx = from && from.version === doc.version && from.lex.syntax === syntaxFor(langOf(doc))
      ? relex(from.lex, text, from.start, from.oldEnd, from.newEnd)
      : null;
    if (lx) {
      rememberLex(text, lx);
    }
    const state: DocState = { version: doc.version, text, lex: lx ?? lexFor(text, langOf(doc)) };
    this.blockCache.set(doc, state);
    return state;
  }

  /** Cached document text for the current version (see docStateFor). */
  private textFor(doc: vscode.TextDocument): string {
    return this.textStateFor(doc).text;
  }

  /** What the top-level scope excludes, and the gutter over the lines it owns, per version. */
  private topLevelFor(doc: vscode.TextDocument): { excludes: OffsetRange[]; gutter: vscode.Range[] } {
    const state = this.docStateFor(doc);
    if (!state.topLevel) {
      const excludes = topLevelExcludes(state.text, state.blocks, langOf(doc));
      const gutter = this.gutterRanges(doc, topLevelLines(state.text, state.lex.lineStarts, excludes));
      state.topLevel = { excludes, gutter };
    }
    return state.topLevel;
  }

  /**
   * One range per run of consecutive lines (ascending input). VS Code draws a
   * gutter icon on every line a decoration's range covers, wrapped rows included,
   * so a run ends at its last line's end. See docs/runtime.md#gutter-stripe.
   */
  private gutterRanges(doc: vscode.TextDocument, lines: number[]): vscode.Range[] {
    const out: vscode.Range[] = [];
    for (let i = 0; i < lines.length; ) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
      out.push(new vscode.Range(lines[i], 0, lines[j], doc.lineAt(lines[j]).range.end.character));
      i = j + 1;
    }
    return out;
  }

  /** The active editor when it shows a document the layer paints. */
  private activeEditor(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    return editor && isDecoratable(editor.document) ? editor : undefined;
  }


  /**
   * The focused block for an editor's caret, using both line and offset so a
   * single-line block (e.g. an inline map/object literal) is only focused when
   * the caret is actually between its braces — not merely on the same line.
   *
   * Passing the document text makes MODULE TOP LEVEL a focusable scope: a caret
   * among top-level `const`/`var` declarations resolves to the synthetic
   * whole-file block instead of nothing, so those declarations tint too.
   */
  private focusedBlock(editor: vscode.TextEditor): BraceBlock | null {
    const caret = editor.selection.active;
    const doc = editor.document;
    const state = this.docStateFor(doc);
    const { text, blocks } = state;
    const lang = langOf(doc);
    // `text` is what enables the synthetic MODULE TOP LEVEL scope, so a caret among
    // top-level declarations still focuses something. Prose must NOT get it: that
    // fallback spans the whole document, which in a markdown file made every English
    // word a candidate data identity — the layer tinted `the`, `a` and `The`.
    // Withholding it returns null, so the phase stays Survey and bands 2-3 never
    // paint. See `isProseLanguage`.
    const fallback = isNonFlowLanguage(lang) ? undefined : text;
    const offset = doc.offsetAt(caret);
    // In HTML and a component only a code region is code: a caret in the markup has no scope.
    if (isRegionLanguage(lang) && !regionAt(viewRegions(text), offset)) return null;
    if (state.lex.syntax.family !== 'js') {
      return innermostBlock(blocks, caret.line, offset, fallback);
    }
    // JS / TS: a one-line function holds a caret in its parameters, and a destructuring
    // pattern focuses the scope that owns its names (docs/javascript.md#blocks-and-focus).
    const starts = new Map<BraceBlock, number>();
    for (const b of blocks) {
      if (b.openLine !== caret.line || b.closeLine !== caret.line || offset > b.openOffset) continue;
      const scope = functionScopeOf(text, b, lang);
      if (scope && scope.start < b.openOffset && scope.start >= b.headerStart) starts.set(b, scope.start);
    }
    let pool = blocks;
    for (;;) {
      const b = innermostBlock(pool, caret.line, offset, fallback, starts);
      if (!b || b.depth < 0 || !(isPatternBrace(text, b, lang) || isParamPattern(text, b, lang))) return b;
      pool = pool.filter((x) => x !== b);
    }
  }

  /**
   * The classification cache key. It names the TextDocument OBJECT, not just the
   * URI: a reopened document restarts at version 1 and its blocks get the same
   * focus keys, so the key must tell the two texts apart. See
   * docs/classification-rules.md.
   */
  private cacheKey(doc: vscode.TextDocument, focusKey: string): string {
    return `${this.docPrefix(doc)}${doc.version}::${focusKey}`;
  }

  private docPrefix(doc: vscode.TextDocument): string {
    let id = this.instanceIds.get(doc);
    if (id === undefined) {
      id = this.nextInstanceId++;
      this.instanceIds.set(doc, id);
    }
    return `${doc.uri.toString()}#${id}::`;
  }

  /** Drop every cached plan for the document's current version. */
  private dropPlansFor(doc: vscode.TextDocument): void {
    const prefix = `${this.docPrefix(doc)}${doc.version}::`;
    for (const key of [...this.classCache.keys()]) {
      if (key.startsWith(prefix)) {
        this.classCache.delete(key);
      }
    }
  }

  /** Drops the other cells' answers when a notebook's cells change (docs/tooling.md#notebooks). */
  private onNotebookChanged(e: vscode.NotebookDocumentChangeEvent): void {
    const edited = new Set(e.cellChanges.filter((c) => c.document !== undefined).map((c) => c.cell.document));
    if (!this.config.enabled || (e.contentChanges.length === 0 && edited.size === 0)) {
      return;
    }
    const active = vscode.window.activeTextEditor?.document;
    let mine = false;
    for (const cell of e.notebook.getCells()) {
      const doc = cell.document;
      if (doc === active) mine = true;
      if (edited.has(doc)) continue;
      this.classifier.invalidate(doc);
      const prefix = this.docPrefix(doc);
      for (const key of [...this.classCache.keys()]) {
        if (key.startsWith(prefix)) this.classCache.delete(key);
      }
      if (this.riskCache?.key.startsWith(prefix)) this.riskCache = undefined;
    }
    if (mine && active && !edited.has(active)) {
      this.scheduleClassify(active, DEBOUNCE_FOCUS_MS);
      this.scheduleRender();
    }
  }

  /**
   * Drop what belongs to the document's earlier versions: the text and lex, their
   * plans (keys carry the version, so none can match again) and the band-3 ranges.
   */
  private dropSupersededFor(doc: vscode.TextDocument): void {
    const state = this.blockCache.get(doc);
    this.relexFrom.delete(doc);
    if (state && state.version !== doc.version) {
      forgetLex(state.text);
      this.blockCache.delete(doc);
    }
    const prefix = this.docPrefix(doc);
    const current = `${prefix}${doc.version}::`;
    for (const key of [...this.classCache.keys()]) {
      if (key.startsWith(prefix) && !key.startsWith(current)) {
        this.classCache.delete(key);
      }
    }
    if (this.riskCache?.key.startsWith(prefix) && !this.riskCache.key.startsWith(current)) {
      this.riskCache = undefined;
    }
  }

  private putCache(key: string, entry: CacheEntry): void {
    // Simple LRU: delete+set moves to the end; evict oldest past the limit.
    if (this.classCache.has(key)) {
      this.classCache.delete(key);
    }
    this.classCache.set(key, entry);
    while (this.classCache.size > Decorator.CACHE_LIMIT) {
      const oldest = this.classCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.classCache.delete(oldest);
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.config.enabled) {
      return;
    }
    const editor = e.textEditor;
    if (editor !== vscode.window.activeTextEditor || !isDecoratable(editor.document)) {
      return;
    }
    // Most selection-change events are a discrete, intentional caret placement —
    // a click or an arrow key. Scroll fires onDidChangeVisibleRanges (not
    // subscribed) and hover fires nothing, so neither reaches here (spec §3.3:
    // "changes only on discrete intentional input, never scroll/hover/time").
    // A mouse click MUST advance Survey→Focus and refresh the activity clock the
    // same as a keystroke — onCaret only ever upgrades one-way, so there is no
    // strobe to guard against. Limiting it to Keyboard/Command kind leaves clicks
    // unable to enter Focus.
    //
    // The exception is a TAB SWITCH: activating an editor makes VS Code re-report
    // that editor's restored caret as a selection change, landing just after
    // refresh() has set Survey — so routing it through onCaret() put every newly
    // opened tab straight into Focus.
    //
    // `kind` cannot discriminate it: clicking a tab IS a mouse action, so the
    // restored-caret event can arrive with kind === Mouse, indistinguishable from
    // a real click.
    //
    // What DOES discriminate is the caret POSITION, remembered per document across
    // switches. Switching to a tab restores the caret exactly where you left it, so
    // it matches what we stored — nothing moved, no intent. Clicking into another
    // split puts the caret somewhere new, so it differs. A file seen for the first
    // time has nothing stored, which also means we never observed a move.
    const block = this.focusedBlock(editor);
    const now = Date.now();
    // Engagement requires an attributed INPUT KIND.
    //
    // Opening a tab produces this sequence (captured from the debug channel):
    //
    //   refresh     at=0:0                      ← editor activates with caret at 0:0
    //   onSelection kind=undefined at=31:0      ← THEN the saved caret is restored
    //
    // VS Code restores the caret ASYNCHRONOUSLY, as a programmatic selection change
    // with no `kind`. So the caret genuinely moves (0:0 → 31:0) without any user
    // action, which is why comparing positions could not work — and why a window
    // reload behaved differently from a tab switch.
    //
    // `kind` is set for every real placement — Keyboard(1), Mouse(2), Command(3) —
    // and absent only when VS Code cannot attribute the change to input. That is
    // exactly the discriminator. Editing engages via onEdit, so a caret moved by an
    // edit is covered too.
    const docKey = editor.document.uri.toString();
    const userInput = e.kind !== undefined;
    if (userInput) {
      this.engaged.add(docKey);
    }
    const engaged = this.engaged.has(docKey);
    const phaseChanged = engaged ? this.machine.onCaret(block !== null, now) : false;
    if (this.debugChan) {
      const at = editor.selection.active;
      this.dbg(
        `onSelection doc=${editor.document.fileName.split('/').pop()} kind=${e.kind} ` +
          `at=${at.line}:${at.character} userInput=${userInput} engaged=${engaged} ` +
          `block=${block ? `L${block.openLine}#d${block.depth}` : 'null'} phase=${this.machine.current}`,
      );
    }

    const newKey = block ? focusKeyOf(block) : null;
    const focusChanged = newKey !== this.currentFocusKey;

    if (focusChanged) {
      this.currentFocusKey = newKey;
      this.scheduleClassify(editor.document, DEBOUNCE_FOCUS_MS);
    }
    if (focusChanged || phaseChanged) {
      this.scheduleRender();
      this.scheduleRelax();
    } else if (newKey !== this.renderedBlockKey) {
      this.scheduleRender();
    }
  }

  private onEdit(e: vscode.TextDocumentChangeEvent): void {
    this.markMoved(e);
    if (!this.config.enabled || e.contentChanges.length === 0 || !isDecoratable(e.document)) {
      return;
    }
    // Version bumped: the bundle and plans of the old text are dead in any editor.
    this.classifier.invalidate(e.document);
    const prev = this.blockCache.get(e.document);
    this.dropSupersededFor(e.document);
    const c = e.contentChanges.length === 1 ? e.contentChanges[0] : undefined;
    const shown = vscode.window.activeTextEditor?.document === e.document ||
      vscode.window.visibleTextEditors.some((ed) => ed.document === e.document);
    // A PHP page's view changes past an edit that moves a region's end, so its lex is redone whole.
    if (c && prev && prev.version === e.document.version - 1 && shown && !isRegionLanguage(langOf(e.document))) {
      this.relexFrom.set(e.document, {
        version: e.document.version, lex: prev.lex, start: c.rangeOffset, oldEnd: c.rangeOffset + c.rangeLength, newEnd: c.rangeOffset + c.text.length,
      });
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== e.document) {
      // A rename, formatter or reload in a split that is not active: its band-1 marks follow the text.
      if (shown) {
        this.scheduleRender();
      }
      return;
    }
    const now = Date.now();
    // Typing is unambiguous engagement — it also covers the case where an edit
    // repositions the caret without a separate selection event. An edit the user
    // did not type (format on save, rename, an auto-import) still reclassifies but
    // neither engages nor enters Edit. A static content or prose file has no scope to
    // edit in, and an undo there may report no caret change to drop it back to Survey.
    if (!isNonFlowLanguage(langOf(e.document)) && this.isTypingEdit(editor, e, now)
      && (!isRegionLanguage(langOf(e.document)) || this.focusedBlock(editor) !== null)) {
      this.engaged.add(e.document.uri.toString());
      this.machine.onType(now);
    }
    // A classify still in flight belongs to the old text.
    this.classifyToken?.cancel();
    this.scheduleClassify(e.document, editDebounceMs(e.document.lineCount));
    if (this.importCache.has(e.document) && !this.classifier.semanticOk(e.document)) {
      this.scheduleImports(e.document);
    }
    this.scheduleRender(); // renders lexical band-3 now, holds stale band-2
    this.scheduleRelax();
  }

  /**
   * VS Code has already moved every decoration in the document's editors with
   * the edit. A record whose ranges moved no longer says what the editor shows,
   * so the next apply of that type cannot be skipped as unchanged.
   */
  private markMoved(e: vscode.TextDocumentChangeEvent): void {
    const editors = new Set(vscode.window.visibleTextEditors);
    if (vscode.window.activeTextEditor) {
      editors.add(vscode.window.activeTextEditor);
    }
    let forced: boolean[] | undefined;
    for (const ed of editors) {
      const records = ed.document === e.document ? this.applied.get(ed) : undefined;
      if (!records) {
        continue;
      }
      const f = (forced ??= this.forcedChanges(e));
      for (const [type, rec] of records) {
        if (!rec.moved && rec.ranges.length > 0 &&
          e.contentChanges.some((c, i) => rangesMovedBy(c, rec.ranges, rangeBehaviorOf(type), f[i]))) {
          rec.moved = true;
        }
      }
    }
  }

  /** Per change, whether VS Code may have applied it with forceMoveMarkers. */
  private forcedChanges(e: vscode.TextDocumentChangeEvent): boolean[] {
    // Undo and redo, the only change reasons, apply without it.
    if (e.reason !== undefined) {
      return e.contentChanges.map(() => false);
    }
    const ed = vscode.window.activeTextEditor;
    const carets = ed && ed.document === e.document && !this.inSave(e.document, Date.now()) ? ed.selections : [];
    return e.contentChanges.map((c) => mayForceMove(c, carets));
  }

  private inSave(doc: vscode.TextDocument, now: number): boolean {
    const saveStarted = this.saving.get(doc);
    return saveStarted !== undefined && now - saveStarted < SAVE_WINDOW_MS;
  }

  private isTypingEdit(editor: vscode.TextEditor, e: vscode.TextDocumentChangeEvent, now: number): boolean {
    if (this.inSave(e.document, now)) {
      return false;
    }
    return isTypingEdit(
      e.contentChanges.map((c) => ({ start: c.range.start, end: c.range.end, text: c.text })),
      editor.selections,
    );
  }

  /** Forget the engagement of every closed tab's document that no other tab shows. */
  private onTabsClosed(closed: readonly vscode.Tab[]): void {
    if (closed.length === 0) {
      return;
    }
    const shown = new Set(vscode.window.tabGroups.all.flatMap((g) => g.tabs.flatMap(tabUris)));
    for (const uri of closed.flatMap(tabUris)) {
      if (!shown.has(uri)) {
        this.engaged.delete(uri);
      }
    }
  }

  private onWillSave(doc: vscode.TextDocument): void {
    this.saving.set(doc, Date.now());
  }

  private onDidSave(doc: vscode.TextDocument): void {
    this.saving.delete(doc);
  }

  // ── Scheduling ───────────────────────────────────────────────────────────────

  /** Coalesce many same-tick render requests into one apply. */
  private scheduleRender(): void {
    if (this.renderQueued) {
      return;
    }
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private scheduleClassify(doc: vscode.TextDocument, delay: number): void {
    if (this.classifyTimer) {
      clearTimeout(this.classifyTimer);
    }
    this.classifyTimer = setTimeout(() => {
      this.classifyTimer = undefined;
      void this.runClassify(doc);
    }, delay);
  }

  /** Schedule the next phase relaxation (Edit→Focus→Survey). */
  private scheduleRelax(): void {
    if (this.relaxTimer) {
      clearTimeout(this.relaxTimer);
      this.relaxTimer = undefined;
    }
    const delay = this.machine.nextRelaxDelay(Date.now());
    if (delay === null) {
      return;
    }
    this.relaxTimer = setTimeout(() => this.onRelaxTick(), delay + 20);
  }

  private onRelaxTick(): void {
    const now = Date.now();
    const changed = this.machine.tick(now);
    if (changed) {
      this.scheduleRender();
    } else {
      this.updateStatus();
    }
    this.scheduleRelax();
  }

  // ── Classification (expensive clock) ─────────────────────────────────────────

  private async runClassify(doc: vscode.TextDocument): Promise<void> {
    const editor = this.activeEditor();
    if (!editor || editor.document !== doc) {
      return;
    }
    const block = this.focusedBlock(editor);
    if (!block) {
      return; // Survey — nothing to classify
    }
    const focusKey = focusKeyOf(block);
    // An edit can change the caret's block with no selection change; the epoch guard compares against this.
    this.currentFocusKey = focusKey;
    const key = this.cacheKey(doc, focusKey);
    const hit = this.classCache.get(key);
    if (hit) {
      // Fresh plan already cached for this version+block; just (re)render.
      this.scheduleRender();
      if (hit.semantic !== 'ok' || this.classifier.awaitsLoad(doc)) {
        this.scheduleColdRetry(doc);
      }
      return;
    }

    if (this.classifying?.key === key && !this.classifying.token.isCancellationRequested) {
      return this.classifying.done;
    }
    this.classifyToken?.cancel();
    this.classifyToken = new vscode.CancellationTokenSource();
    const token = this.classifyToken.token;
    const done = this.classifyInto(doc, block, focusKey, key, token);
    this.classifying = { key, token, done };
    try {
      await done;
    } finally {
      if (this.classifying?.done === done) this.classifying = undefined;
    }
  }

  private async classifyInto(
    doc: vscode.TextDocument,
    block: BraceBlock,
    focusKey: string,
    key: string,
    token: vscode.CancellationToken,
  ): Promise<void> {
    let scoped: { focused: Classification; coloring: ScopeColoring; semantic: SemanticState } | null;
    try {
      scoped = await this.classifier.classifyScope(
        doc,
        block,
        TOKENS.id.length,
        token,
        this.docStateFor(doc), // the cached text + block scan, and the version they belong to
      );
    } catch {
      scoped = null;
    }
    if (!this.band1Current(doc)) {
      this.scheduleRender(); // band 1 follows the answer even when band 2 discards it
    }
    if (!scoped || token.isCancellationRequested) {
      return;
    }
    const classification = scoped.focused;
    // Epoch guard: discard if the document moved on or focus jumped away.
    if (classification.docVersion !== doc.version || classification.focusKey !== this.currentFocusKey) {
      this.dbg(
        `classify DISCARDED: ver ${classification.docVersion}vs${doc.version} ` +
          `key ${classification.focusKey}vs${this.currentFocusKey}`,
      );
      return;
    }
    this.dbg(
      `classify OK key=${focusKey} semantic=${scoped.semantic} paths=${this.classifier.pathKeywordsOf(doc) ?? '-'} ` +
        `byName=[${[...classification.byName].map(([n, i]) => n + ':' + i.cls).join(',')}]`,
    );

    // Build the render plan from the SCOPE colouring: a name's hue comes from the
    // co-visibility graph (deterministic, navigation-independent), and only the
    // names in this block's visible set are painted at all.
    const plan = planFromColoring(classification, scoped.coloring);
    const semantic = scoped.semantic;
    const hold = semantic === 'empty' && this.classifier.coldRetryDelay(doc) !== null;
    this.putCache(key, { classification, plan, semantic, hold });
    this.scheduleRender();
    if (semantic !== 'ok' || this.classifier.awaitsLoad(doc)) {
      this.scheduleColdRetry(doc);
    }
  }

  /**
   * Re-ask a server that answered nothing, or rust-analyzer when its answer was
   * degraded, on the classifier's backoff schedule, with no edit needed: a server
   * is cold for seconds after a window reload, and a cargo workspace still loading
   * answers like a detached file. The retry evicts both the LSP bundle and this
   * version's plans, or runClassify would short-circuit on them. One chain at a
   * time, for the active document; it stops at the first answer with tokens that
   * is not degraded, or when the schedule is spent.
   */
  private scheduleColdRetry(doc: vscode.TextDocument): void {
    if (this.retryTimer) {
      if (this.retryDoc === doc) {
        return;
      }
      clearTimeout(this.retryTimer);
    }
    const delay = this.classifier.coldRetryDelay(doc);
    if (delay === null) {
      this.retryTimer = undefined;
      this.retryDoc = undefined;
      return;
    }
    this.retryDoc = doc;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryDoc = undefined;
      const editor = this.activeEditor();
      if (!editor || editor.document !== doc) {
        return; // resumes on this document's next classify
      }
      this.dbg(`retry: re-ask the server about ${doc.fileName.split('/').pop()} after ${delay} ms`);
      this.classifier.noteColdRetry(doc);
      this.dropPlansFor(doc);
      this.classifying = undefined;
      void this.runClassify(doc);
    }, delay);
  }

  // ── Render (cheap clock) ─────────────────────────────────────────────────────

  private render(): void {
    const t0 = this.debugChan ? performance.now() : 0;
    try {
      this.renderInner();
    } finally {
      if (this.debugChan) {
        const ms = performance.now() - t0;
        if (ms > 2) {
          this.dbg(`  render took ${ms.toFixed(1)} ms`);
        }
      }
    }
  }

  private renderInner(): void {
    if (!this.config.enabled) {
      // Disabled means disabled: band 1 marks come off too.
      this.clearAllVisible(true);
      this.statusItem.hide();
      return;
    }

    // BAND 1 on every visible editor: phase-independent, so an inactive split shows
    // the same marks as the active one, and a pool rebuild repaints all of them.
    const shown = new Set(vscode.window.visibleTextEditors);
    if (vscode.window.activeTextEditor) {
      shown.add(vscode.window.activeTextEditor);
    }
    for (const ed of shown) {
      if (isDecoratable(ed.document)) {
        this.renderBand1(ed);
      }
    }

    const editor = this.activeEditor();
    if (!editor) {
      // No active source editor — focus is in a webview, panel, the Output channel
      // or a settings UI. The bands must still come off the editors that are STILL
      // VISIBLE, or they stay painted until some later event repaints.
      this.clearAllVisible();
      this.updateStatus();
      return;
    }

    if (this.lastActiveEditor !== editor) {
      this.lastActiveEditor = editor;
      this.renderedBand2Key = null;
      this.renderedEscapeKey = null;
    }
    // Band 2/3 belong to the FOCUSED block, so only the active editor may show
    // them. Other visible editors (split view, or restored-but-unfocused tabs
    // after a window reload) must be cleared: their decorations came from a
    // different document's classification and read as garbled highlighting on
    // random text. The per-editor dirty-check makes this free once they are clear.
    this.clearOtherEditors(editor);

    const doc = editor.document;
    const block = this.focusedBlock(editor);
    this.renderedBlockKey = block ? focusKeyOf(block) : null;
    const phase = this.machine.current;
    // THE PAINT CHECK, enforced at the only place decorations are ever applied.
    //
    // Bands 2 and 3 may not paint in a document the user has not engaged — no
    // matter how the phase got where it is. Three earlier fixes tried to keep the
    // PHASE correct on a tab switch (suppress the restored-caret event by `kind`,
    // then by caret position, then by an engagement check inside onSelection) and a
    // newly shown file still lit up. Rather than keep guessing which path sets the
    // phase, the invariant is asserted here: paint requires engagement, so any path
    // that leaves the phase wrong is harmless.
    const engaged = this.engaged.has(doc.uri.toString());
    const showBand2 = engaged && block !== null && (phase === Phase.Focus || phase === Phase.Edit);
    const showBand3 = engaged && block !== null && phase === Phase.Edit;
    if (this.debugChan) {
      const caret = editor.selection.active;
      const key = block ? this.cacheKey(doc, focusKeyOf(block)) : '(none)';
      const cached = block ? this.classCache.has(this.cacheKey(doc, focusKeyOf(block))) : false;
      this.dbg(
        `render caret=${caret.line}:${caret.character} phase=${phase} engaged=${engaged} ` +
          `block=${block ? `L${block.openLine}-${block.closeLine}#d${block.depth}` : 'null'} ` +
          `showBand2=${showBand2} cacheKey=${key} cached=${cached} renderedKey=${this.renderedBand2Key}`,
      );
    }

    // 1. Gutter stripe — Focus + Edit, focused block's lines. The top-level scope
    //    covers only the lines outside the function and type bodies it excludes.
    if (showBand2 && block && isTopLevelBlock(block)) {
      this.applyGutter(editor, this.topLevelFor(doc).gutter);
    } else if (showBand2 && block) {
      const end = doc.lineAt(block.closeLine).range.end.character;
      this.applyGutter(editor, [new vscode.Range(block.openLine, 0, block.closeLine, end)]);
    } else {
      this.applyGutter(editor, []);
    }

    // 2. Band 2 — identity tints (cached plan for this version+block, or stale-hold).
    if (showBand2 && block) {
      this.renderBand2(editor, doc, block);
    } else {
      this.clearBand2(editor);
    }

    // One lexical-risk pass per version and block, shared by band 3 and the clay numbers.
    const lexRisk = showBand2 && block ? this.lexicalRiskFor(doc, block) : undefined;

    // 3. Band 3 — risk marks, Edit only, focused block.
    if (showBand3 && block && lexRisk) {
      this.renderBand3(editor, doc, block, lexRisk);
    } else {
      this.clearBand3(editor);
    }

    // 4. Clay numeric literals — the ENGAGED half of the spec's number pair.
    //
    // `--syn-number` / `--syn-number-engaged` are both `--syn-*` (band 1), not
    // `--risk-*`, and the token comments read "literal numbers REST receded" /
    // "clay — focused scope, engaged phases only". A scope becomes *engaged* at
    // Focus (band 2's word for it), so clay arrives with Focus and persists through
    // Edit.
    if (showBand2 && block && lexRisk) {
      this.renderEngagedNumbers(editor, lexRisk);
    } else {
      this.applyType(editor, this.pool.numberEngaged, []);
    }

    this.updateStatus();
  }

  /** What band 1 reads of the classifier for `doc`. */
  private band1Inputs(doc: vscode.TextDocument): Band1Inputs {
    return {
      paths: this.classifier.pathKeywordsOf(doc),
      ok: this.classifier.semanticOk(doc),
      strings: this.classifier.typesStrings(doc),
      typed: this.classifier.typedNamespacesOf(doc),
    };
  }

  /** The last band-1 render of `doc` read the classifier as it stands now. */
  private band1Current(doc: vscode.TextDocument): boolean {
    const seen = this.band1Seen.get(doc);
    const now = this.band1Inputs(doc);
    return seen !== undefined && seen.paths === now.paths && seen.ok === now.ok && seen.strings === now.strings && seen.typed === now.typed;
  }

  /**
   * The band-1 marks for one editor: markdown washes, `self` / `this`, Rust, Python, Lua,
   * Ruby and JavaScript format placeholders, the comment restores and the import and shadow restores. Each corrects something the
   * theme cannot reach, so none is phase-bound and each is cached per document version.
   *
   * `self` stays out of renderBand2: band 2 is cleared when the phase relaxes to
   * Survey, and a correction for a phase-independent defect has to be
   * phase-independent too.
   */
  private renderBand1(editor: vscode.TextEditor): void {
    const doc = editor.document;
    this.band1Seen.set(doc, this.band1Inputs(doc));
    this.renderMarkdownMarks(editor, doc);
    this.renderSelf(editor, doc);
    this.renderConstantRestore(editor, doc);
    this.renderPlaceholders(editor, doc);
    this.renderCommentRestore(editor, doc);
    this.renderStringRestore(editor, doc);
    this.renderImports(editor, doc);
  }

  /**
   * Paint the uses of imported modules and types at the theme's type slate, and the
   * non-call uses of a shadowed builtin at the page colour, in Python, Go, Lua, Ruby,
   * JavaScript, TypeScript and Zig while `restoresImports` holds. The grammars cannot see
   * the import list or a binding, so with `python.languageServer: None`, gopls off or
   * a server still starting, `heapq.heapify` and `fmt.Println` read as plain locals
   * and a parameter named `id` reads as the builtin; tsserver sends no token for a
   * project file's `import * as util`, so `util.read` reads as a local. See
   * src/imports.ts and src/lua.ts.
   */
  private renderImports(editor: vscode.TextEditor, doc: vscode.TextDocument): void {
    if (!this.restoresImports(doc)) {
      this.applyType(editor, this.pool.importRestore, []);
      this.applyType(editor, this.pool.shadowRestore, []);
      return;
    }
    const cached = this.importCache.get(doc);
    if (cached && cached.version === doc.version && cached.typed === this.classifier.typedNamespacesOf(doc)) {
      this.applyRestores(editor, cached);
      return;
    }
    // At the same version only the answer's typed namespaces changed.
    if (!cached || cached.version === doc.version || this.appliedFor(editor).get(this.pool.importRestore)?.ranges !== cached.ranges) {
      this.applyRestores(editor, this.importRangesFor(doc));
      return;
    }
    // An edit. The ranges on screen moved with the text, so they stay until typing
    // pauses: the recompute is a whole-file pass (docs/import-restore.md#cost).
    if (!this.importTimers.has(doc)) {
      this.scheduleImports(doc);
    }
  }

  /** (Re)start the import-restore recompute for `doc`; each edit pushes it back. */
  private scheduleImports(doc: vscode.TextDocument): void {
    const pending = this.importTimers.get(doc);
    if (pending) {
      clearTimeout(pending);
    }
    this.importTimers.set(doc, setTimeout(() => {
      this.importTimers.delete(doc);
      if (this.restoresImports(doc)) {
        this.importRangesFor(doc);
        this.scheduleRender();
      }
    }, editDebounceMs(doc.lineCount)));
  }

  /**
   * Python and Go until a semantic provider answers. Lua always: lua-language-server
   * types a module `variable` or `class`, never `namespace`, so the slate would go when it
   * answers; the shadow restore agrees with its `variable` paint (docs/lua.md#band-1-restores).
   * JavaScript and TypeScript always, per name: `importRangesFor` leaves out a namespace
   * whose uses the last answer typed (docs/import-restore.md#javascript-and-typescript).
   */
  private restoresImports(doc: vscode.TextDocument): boolean {
    const lang = langOf(doc);
    return lang === 'lua' || lang === 'ruby' || NAMESPACE_RESTORE_LANGUAGES.has(lang)
      || ((lang === 'python' || lang === 'go' || lang === 'zig') && !this.classifier.semanticOk(doc));
  }

  private applyRestores(editor: vscode.TextEditor, r: { ranges: vscode.Range[]; shadows: vscode.Range[] }): void {
    this.applyType(editor, this.pool.importRestore, r.ranges);
    this.applyType(editor, this.pool.shadowRestore, r.shadows);
  }

  private importRangesFor(doc: vscode.TextDocument): { version: number; ranges: vscode.Range[]; shadows: vscode.Range[] } {
    const lx = this.textStateFor(doc).lex;
    const lua = lx.syntax.family === 'lua' ? luaRestoreSpans(lx) : undefined;
    const ruby = lx.syntax.family === 'ruby';
    const typed = this.classifier.typedNamespacesOf(doc);
    let imports = lua ? lua.imports : ruby ? [] : lx.syntax.family === 'zig' ? zigImportSpans(lx) : importUseSpans(lx);
    if (typed !== '') {
      const skip = new Set(typed.split(','));
      const names = importUseNames(lx);
      imports = imports.filter((_, i) => !skip.has(names[i]));
    }
    const entry = {
      version: doc.version,
      typed,
      ranges: imports.map((s) => this.toRange(doc, s)),
      shadows: (lua ? lua.shadows : ruby ? rubyShadowSpans(lx) : shadowUseSpans(lx)).map((s) => this.toRange(doc, s)),
    };
    this.importCache.set(doc, entry);
    return entry;
  }

  /**
   * Paint `self` / `this` file-wide, at band 1's keyword colour, and in Rust `Self`,
   * `crate` and `super` too until rust-analyzer types them as keywords.
   *
   * --id-self equals band 1's resting keyword colour, so this paint is a no-op
   * wherever band 1 already rendered correctly. It exists for the case band 1
   * cannot hold: on a `.rs` file outside a cargo workspace, rust-analyzer types a
   * `self` USE as `const`, `Self` as `struct` and `crate` / `super` as `namespace`,
   * and a semantic token outranks the grammar. A cargo workspace sends the same
   * degraded answer while it loads. docs/runtime.md#rust-path-keywords.
   *
   * Deliberately a plain lex rather than a classification: it needs no scope
   * analysis (every `self` in a file is the same identity to band 1), it must work
   * in Survey where there is no classification at all, and it must not wait on the
   * language server. The lexer's identifiers are code only, so a `self` inside a
   * comment, string or docstring is not painted, and a prose or data file paints
   * none. Ruby has no `this`, and `x.self` / `self:` are a method and a hash key
   * (docs/ruby.md#band-1-restores); JavaScript's `self` is an ordinary name
   * (docs/javascript.md#band-1-restores); zls types Zig's `self` `parameter`, and its
   * `this` and a member, field or enum member named `self` are ordinary names
   * (docs/zig.md#band-1-restores). A C-family `bool` takes it too: cpptools and clangd
   * send it `macro`, a bold call (docs/c-jvm.md#band-1-restores). Cached per document version.
   */
  private renderSelf(editor: vscode.TextEditor, doc: vscode.TextDocument): void {
    if (isNonFlowLanguage(band1LangOf(doc)) || langOf(doc) === 'php') {
      this.applyType(editor, this.pool.self, []);
      return;
    }
    const paths = langOf(doc) === 'rust' && this.classifier.pathKeywordsOf(doc) !== 'keyword';
    const cached = this.selfCache.get(doc);
    let ranges: vscode.Range[];
    if (cached && cached.version === doc.version && cached.paths === paths) {
      ranges = cached.ranges;
    } else {
      ranges = [];
      const lx = this.textStateFor(doc).lex;
      const family = lx.syntax.family;
      const words = selfWords(lx.syntax);
      const keyword = (id: LexId): boolean => family === 'ruby' ? id.name === 'self' && rubyKeywordSelf(lx, id)
        : family === 'zig' ? id.name === 'self' && zigKeywordSelf(lx, id)
          : words.has(id.name);
      const typeMacros = new Set(family === 'c' ? cMacroRestores(lx).keywords.map((r) => r.start) : []);
      for (const id of lx.idents) {
        if (keyword(id) || (paths && RUST_PATH_KEYWORDS.has(id.name)) || typeMacros.has(id.offset)) {
          ranges.push(this.toRange(doc, { start: id.offset, end: id.offset + id.length }));
        }
      }
      this.selfCache.set(doc, { version: doc.version, paths, ranges });
    }
    this.dbg(`  band1 self: ${ranges.length} ranges (phase-independent)`);
    this.applyType(editor, this.pool.self, ranges);
  }

  /**
   * Paint C-family `NULL`, `true` and `false` constant red, file-wide and
   * phase-independent: cpptools and clangd send `macro` over each, a bold call, and no
   * theme key tells them from another macro. The paint is the grammar's, so with no
   * server it changes nothing (docs/c-jvm.md#band-1-restores); `bool` is renderSelf's.
   * Cached per document version.
   */
  private renderConstantRestore(editor: vscode.TextEditor, doc: vscode.TextDocument): void {
    const lx = isNonFlowLanguage(band1LangOf(doc)) ? undefined : this.textStateFor(doc).lex;
    if (!lx || lx.syntax.family !== 'c') {
      this.applyType(editor, this.pool.constantRestore, []);
      return;
    }
    const cached = this.constantCache.get(doc);
    let ranges: vscode.Range[];
    if (cached && cached.version === doc.version) {
      ranges = cached.ranges;
    } else {
      ranges = cMacroRestores(lx).constants.map((r) => this.toRange(doc, r));
      this.constantCache.set(doc, { version: doc.version, ranges });
    }
    this.dbg(`  band1 constants: ${ranges.length} ranges (phase-independent)`);
    this.applyType(editor, this.pool.constantRestore, ranges);
  }

  /**
   * Paint format placeholders at member steel, file-wide and phase-independent, in
   * Kotlin (kotlin-language-server types a `$name` template `variable`), Rust
   * (rust-analyzer's one `string` token covers the holes), Python f-strings
   * (bracket-pair colorization paints the field braces), Lua and Zig while
   * lua-language-server or zls types their string literals, Ruby interpolation and JavaScript
   * template holes (bracket-pair colorization paints `#{` `}` and `${` `}`). Go and
   * Python `%` formats and TypeScript template holes sit inside a scope bracket-pair
   * colorization leaves alone, and the theme reaches them. Cached per
   * document version because the scan walks the whole file and render runs on every
   * caret move. See src/placeholders.ts.
   */
  private renderPlaceholders(editor: vscode.TextEditor, doc: vscode.TextDocument): void {
    const scan = PLACEHOLDER_SCANS[band1LangOf(doc)];
    if (!scan || (STRING_TOKEN_LANGUAGES.has(band1LangOf(doc)) && !this.classifier.typesStrings(doc))) {
      this.applyType(editor, this.pool.placeholder, []);
      return;
    }
    const cached = this.placeholderCache.get(doc);
    let ranges: vscode.Range[];
    if (cached && cached.version === doc.version) {
      ranges = cached.ranges;
    } else {
      // A component's scan reads its scripts' languages off the document itself.
      const state = this.textStateFor(doc);
      ranges = scan(COMPONENT_LANGUAGES.has(langOf(doc)) ? doc.getText() : state.text, state.lex).map((s) => this.toRange(doc, s));
      this.placeholderCache.set(doc, { version: doc.version, ranges });
    }
    this.dbg(`  band1 placeholders: ${ranges.length} ranges (${langOf(doc)})`);
    this.applyType(editor, this.pool.placeholder, ranges);
  }

  /**
   * Paint Go doc links and the brackets in Rust comments and JavaScript and TypeScript
   * JSDoc in comment colour, file-wide and phase-independent. See src/doclinks.ts.
   */
  private renderCommentRestore(editor: vscode.TextEditor, doc: vscode.TextDocument): void {
    const scan = COMMENT_RESTORE_SCANS[band1LangOf(doc)];
    if (!scan) {
      this.applyType(editor, this.pool.commentRestore, []);
      return;
    }
    const cached = this.commentRestoreCache.get(doc);
    let ranges: vscode.Range[];
    if (cached && cached.version === doc.version) {
      ranges = cached.ranges;
    } else {
      const { text, lex } = this.textStateFor(doc);
      ranges = scan(text, lex).map((s) => this.toRange(doc, s));
      this.commentRestoreCache.set(doc, { version: doc.version, ranges });
    }
    this.applyType(editor, this.pool.commentRestore, ranges);
  }

  /**
   * Paint the brackets in Rust strings and char literals in string colour,
   * file-wide and phase-independent. Which ones depends on whether a semantic
   * provider has answered. See src/placeholders.ts rustStringBracketSpans.
   */
  private renderStringRestore(editor: vscode.TextEditor, doc: vscode.TextDocument): void {
    if (langOf(doc) !== 'rust') {
      this.applyType(editor, this.pool.stringRestore, []);
      return;
    }
    const semantic = this.classifier.semanticOk(doc);
    const cached = this.stringRestoreCache.get(doc);
    let ranges: vscode.Range[];
    if (cached && cached.version === doc.version && cached.semantic === semantic) {
      ranges = cached.ranges;
    } else {
      ranges = rustStringBracketSpans(this.textFor(doc), semantic).map((s) => this.toRange(doc, s));
      this.stringRestoreCache.set(doc, { version: doc.version, semantic, ranges });
    }
    this.applyType(editor, this.pool.stringRestore, ranges);
  }

  private renderBand2(editor: vscode.TextEditor, doc: vscode.TextDocument, block: BraceBlock): void {
    const focusKey = focusKeyOf(block);
    const key = this.cacheKey(doc, focusKey);
    const entry = this.classCache.get(key);
    if (!entry || entry.hold) {
      // No paintable classification for this version+block yet.
      if (this.renderedBand2Key === focusKey && (!entry || this.renderedBand2Semantic)) {
        // STALE-HOLD: same block, mid-typing — keep the existing tints on screen
        // so typing doesn't flicker to neutral. The pending classify repaints.
        return;
      }
      // A different block (real navigation), or heuristic tints under a provider
      // hold: clear now, then the pending classify cuts in the new ones.
      this.clearBand2(editor);
      return;
    }

    // Header-inclusive for control-flow blocks, so header-line bindings tint too
    // (matches the range used at classify time). See focus.ts.
    const region: OffsetRange = lexRegionFor(this.textFor(doc), block, langOf(doc));
    let ranges = this.band2Ranges.get(entry);
    if (!ranges || ranges.region.start !== region.start || ranges.region.end !== region.end) {
      ranges = { region, ...this.band2RangesFor(doc, block, entry, region) };
      this.band2Ranges.set(entry, ranges);
    }
    const { id: idRanges, idg: idgRanges } = ranges;
    this.pool.id.forEach((type, i) => this.applyType(editor, type, idRanges[i]));
    this.pool.idg.forEach((type, i) => this.applyType(editor, type, idgRanges[i]));
    this.renderedBand2Key = focusKey;
    this.renderedBand2Semantic = entry.semantic === 'ok';
  }

  /** A plan's trace ranges as editor ranges, bucketed by decoration type. */
  private band2RangesFor(
    doc: vscode.TextDocument,
    block: BraceBlock,
    entry: CacheEntry,
    blockRange: OffsetRange,
  ): { id: vscode.Range[][]; idg: vscode.Range[][] } {
    const targets = computeTraceRanges(entry.classification, entry.plan, blockRange);
    if (this.debugChan) {
      this.dbg(
        `  band2 block=L${block.openLine}#d${block.depth} ` +
          `byName=[${[...entry.classification.byName].map(([n, i]) => n + ':' + i.cls).join(',')}] ` +
          `targets=[${targets.map((t) => t.name + '(' + t.ranges.length + ')').join(',')}]`,
      );
    }

    const idRanges: vscode.Range[][] = TOKENS.id.map(() => []);
    const idgRanges: vscode.Range[][] = TOKENS.id.map(() => []);

    for (const t of targets) {
      const vranges = t.ranges.map((r) => this.toRange(doc, r));
      switch (t.entry.kind) {
        case 'id':
          idRanges[t.entry.poolIndex].push(...vranges);
          break;
        case 'idg':
          idgRanges[t.entry.poolIndex].push(...vranges);
          break;
        case 'self':
          // Not painted here: `self` is band 1 and phase-independent, so renderSelf()
          // owns it file-wide. Painting it from the block plan clipped it to the
          // focused block and tied it to clearBand2, which is what made it flash
          // white on every relaxation to Survey.
          break;
        case 'neutral':
          break;
      }
    }
    return { id: idRanges, idg: idgRanges };
  }

  /**
   * Clay numeric literals in the focused block.
   *
   * The spec pairs `--syn-number` (receded, at rest) with `--syn-number-engaged`
   * (clay, "focused scope, engaged phases only"). Both are band-1 `--syn-*`
   * tokens, so this is a resting-register swap inside the focused scope rather
   * than a risk mark — which is why it rides Focus, not Edit.
   */
  private renderEngagedNumbers(editor: vscode.TextEditor, lex: RiskRanges): void {
    this.applyType(editor, this.pool.numberEngaged, lex.numbers);
  }

  /**
   * The two markdown marks a colour theme cannot express: the ==highlight== wash
   * and the cancellation of VS Code's link underline. See src/markdown.ts for why
   * each has to be a decoration.
   *
   * Band 1, so no phase or engagement check — but still cached per document
   * version, because both scanners walk the whole document and this runs on every
   * render (i.e. every caret move). Documents outside `isLinkMarkLanguage` clear and
   * return, so a `.ts` file never carries a stale wash from a previously active `.md`.
   */
  private renderMarkdownMarks(editor: vscode.TextEditor, doc: vscode.TextDocument): void {
    if (!isLinkMarkLanguage(langOf(doc))) {
      this.applyType(editor, this.pool.mdHighlight, []);
      this.applyType(editor, this.pool.mdLinkPlain, []);
      return;
    }

    const cached = this.mdCache.get(doc);
    let marks = cached && cached.version === doc.version ? cached : undefined;
    if (!marks) {
      const text = this.textFor(doc);
      const code = langOf(doc) === 'mdx' ? mdxCodeSpans(text) : codeSpans(text);
      marks = {
        version: doc.version,
        highlight: isMarkdownLanguage(langOf(doc)) ? highlightSpans(text, code).map((s) => this.toRange(doc, s)) : [],
        link: linkSpans(text, code).map((s) => this.toRange(doc, s)),
      };
      this.mdCache.set(doc, marks);
    }

    this.applyType(editor, this.pool.mdHighlight, marks.highlight);
    this.applyType(editor, this.pool.mdLinkPlain, marks.link);
  }

  /** Async/danger keywords and numeric literals in the focused block's lex region, cached per version and block. */
  private lexicalRiskFor(doc: vscode.TextDocument, block: BraceBlock): RiskRanges {
    const key = this.cacheKey(doc, focusKeyOf(block));
    if (this.riskCache?.key === key) {
      return this.riskCache.lexical;
    }
    const text = this.textFor(doc);
    const r = lexicalRisk(text, lexRegionFor(text, block, langOf(doc)), langOf(doc));
    // The top-level scope owns no code inside the bodies it excludes.
    const excludes = isTopLevelBlock(block) ? this.topLevelFor(doc).excludes : [];
    const keep = (x: OffsetRange): boolean => !inSortedRanges(excludes, x.start);
    const lexical = {
      async: r.async.filter(keep).map((x) => this.toRange(doc, x)),
      danger: r.danger.filter(keep).map((x) => this.toRange(doc, x)),
      numbers: r.numberEngaged.filter(keep).map((x) => this.toRange(doc, x)),
    };
    this.riskCache = { key, lexical };
    return lexical;
  }

  private renderBand3(
    editor: vscode.TextEditor,
    doc: vscode.TextDocument,
    block: BraceBlock,
    lex: RiskRanges,
  ): void {
    this.applyType(editor, this.pool.riskAsync, lex.async);
    this.applyType(editor, this.pool.riskDanger, lex.danger);
    // numberEngaged is NOT painted here — it belongs to Focus+Edit, not Edit alone.
    // See renderEngagedNumbers().

    // Escape marks need the classification for this version.
    const focusKey = focusKeyOf(block);
    const entry = this.classCache.get(this.cacheKey(doc, focusKey));
    if (!entry || entry.hold) {
      if (this.renderedEscapeKey === focusKey) {
        // STALE-HOLD, as band 2: same block mid-typing. The editor moves the
        // painted ranges with the edit, and markMoved voids the record of any it
        // moved, so the repaint sends whatever differs from what is on screen.
        return;
      }
      this.applyType(editor, this.pool.riskEscape, []);
      this.renderedEscapeKey = null;
      return;
    }
    const cache = this.riskCache;
    let ranges: vscode.Range[];
    if (cache && cache.key === this.cacheKey(doc, focusKey) && cache.escapeFor === entry && cache.escape) {
      ranges = cache.escape;
    } else {
      const text = this.textFor(doc);
      ranges = escapeRisk(text, lexRegionFor(text, block, langOf(doc)), entry.classification, langOf(doc))
        .map((r) => this.toRange(doc, r));
      if (cache && cache.key === this.cacheKey(doc, focusKey)) {
        cache.escapeFor = entry;
        cache.escape = ranges;
      }
    }
    this.applyType(editor, this.pool.riskEscape, ranges);
    this.renderedEscapeKey = focusKey;
  }

  // ── Apply helpers with dirty-check ───────────────────────────────────────────

  private toRange(doc: vscode.TextDocument, r: OffsetRange): vscode.Range {
    return new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end));
  }

  private rangeKey(ranges: vscode.Range[]): string {
    if (ranges.length === 0) {
      return '';
    }
    return ranges
      .map((r) => `${r.start.line},${r.start.character}-${r.end.line},${r.end.character}`)
      .join(';');
  }

  private appliedFor(editor: vscode.TextEditor): Map<vscode.TextEditorDecorationType, AppliedRanges> {
    let m = this.applied.get(editor);
    if (!m) {
      m = new Map();
      this.applied.set(editor, m);
    }
    return m;
  }

  /** setDecorations only if this editor's ranges for the type actually changed. */
  private applyType(editor: vscode.TextEditor, type: vscode.TextEditorDecorationType, ranges: vscode.Range[]): void {
    const applied = this.appliedFor(editor);
    const prev = applied.get(type)?.moved ? undefined : applied.get(type);
    if (prev && prev.ranges === ranges) {
      return;
    }
    const key = this.rangeKey(ranges);
    if (prev && prev.key === key) {
      prev.ranges = ranges;
      return;
    }
    editor.setDecorations(type, ranges);
    applied.set(type, { ranges, key });
  }

  private applyGutter(editor: vscode.TextEditor, ranges: vscode.Range[]): void {
    this.applyType(editor, this.gutterDecoration, ranges);
  }

  private clearBand2(editor: vscode.TextEditor): void {
    this.pool.id.forEach((t) => this.applyType(editor, t, []));
    this.pool.idg.forEach((t) => this.applyType(editor, t, []));
    // `self` is NOT cleared here. It is a BAND-1 mark that this layer happens to
    // paint: --id-self equals band 1's resting keyword colour, so it must look the
    // same in Survey, Focus and Edit alike. Clearing it with band 2 made `self`
    // render correctly at first paint, flash white the moment the phase relaxed to
    // Survey, and come back on Focus — because the thing it is correcting is a
    // SEMANTIC token (`const`, outside a cargo workspace) that band 1 cannot
    // outrank on its own. A phase-independent mark has to survive the phase change.
    // It is cleared by clearAllVisible(true) when the layer is switched off or the
    // editor goes away, which is the only time it genuinely should disappear.
    this.renderedBand2Key = null;
  }

  private clearBand3(editor: vscode.TextEditor): void {
    this.applyType(editor, this.pool.riskAsync, []);
    this.applyType(editor, this.pool.riskDanger, []);
    this.applyType(editor, this.pool.riskEscape, []);
    this.renderedEscapeKey = null;
    // numberEngaged is deliberately NOT cleared here: it rides Focus, and
    // clearBand3 runs on every Focus render (Edit → Focus relaxation included), so
    // clearing it would strip the clay the moment typing stopped. render() owns its
    // lifecycle alongside band 2.
  }

  /**
   * Strip every band-2/3 decoration from all visible editors except `keep`.
   *
   * Decorations are per-editor and VS Code does not clear them for us, so an
   * editor we painted and then navigated away from keeps its ranges — computed
   * from a DIFFERENT document's classification. After a window reload, several
   * editors are restored visible at once, which is when it shows up worst:
   * highlighting scattered over comments, strings and unrelated identifiers.
   */
  private clearOtherEditors(keep: vscode.TextEditor): void {
    for (const other of vscode.window.visibleTextEditors) {
      if (other === keep) {
        continue;
      }
      // `banded()`, not `all()`: the band-1 marks are correct in every visible
      // editor showing that document and must survive — clearing them here
      // stripped the highlight wash from a split's second markdown pane.
      this.applyType(other, this.gutterDecoration, []);
      for (const type of this.pool.banded()) {
        this.applyType(other, type, []);
      }
    }
  }

  /**
   * Strip the bands from EVERY visible editor.
   *
   * Used when there is no active source editor (focus in a webview, panel or
   * settings UI) or the layer is disabled. Decorations are per-editor, so with no
   * active editor every visible one has to be cleared explicitly.
   */
  private clearAllVisible(includeBand1 = false): void {
    // `includeBand1` separates the two callers. Focus moving to a webview or panel
    // must withdraw the phase bands but NOT the band-1 marks — those are
    // resting register, and blinking the highlight wash off because the caret left
    // the editor would be exactly the flicker this layer exists to avoid. Turning
    // the extension off, by contrast, must leave no trace of it on screen.
    const types = includeBand1 ? this.pool.all() : this.pool.banded();
    for (const ed of vscode.window.visibleTextEditors) {
      this.applyType(ed, this.gutterDecoration, []);
      for (const type of types) {
        this.applyType(ed, type, []);
      }
    }
    this.lastActiveEditor = undefined;
    this.renderedBand2Key = null;
    this.renderedEscapeKey = null;
    this.renderedBlockKey = undefined;
  }

  /**
   * The phase as the SCREEN shows it: Survey in a document the user has not
   * engaged, since render() refuses to paint bands there.
   */
  private effectivePhase(): Phase {
    const editor = this.activeEditor();
    if (!editor || !this.engaged.has(editor.document.uri.toString())) {
      return Phase.Survey;
    }
    return this.machine.current;
  }

  private updateStatus(): void {
    if (!this.config.enabled || !this.config.showPhaseInStatusBar) {
      this.statusItem.hide();
      return;
    }
    // Report the EFFECTIVE phase. An unengaged document cannot paint bands (see the
    // paint check in render()), so showing 流/異 there would misreport the screen.
    const phase = this.effectivePhase();
    this.statusItem.text = `${PHASE_KANJI[phase]} ${phase}`;
    this.statusItem.tooltip = 'Okibi dynamic phase — click to toggle the layer';
    this.statusItem.show();
  }

  /** Recompute + repaint for the active editor from scratch. */
  refresh(): void {
    const editor = this.activeEditor();
    if (!editor || !this.config.enabled) {
      // Focus left the source editors (webview, preview, settings, a panel), or the
      // layer is off: render() withdraws the bands from every visible editor now,
      // rather than whenever the next relaxation happens to repaint.
      this.currentFocusKey = null;
      if (this.relaxTimer) {
        clearTimeout(this.relaxTimer);
        this.relaxTimer = undefined;
      }
      this.scheduleRender();
      return;
    }
    const block = this.focusedBlock(editor);
    this.currentFocusKey = block ? focusKeyOf(block) : null;
    if (this.debugChan) {
      const at = editor.selection.active;
      this.dbg(
        `refresh doc=${editor.document.fileName.split('/').pop()} at=${at.line}:${at.character} ` +
          `block=${block ? `L${block.openLine}#d${block.depth}` : 'null'} phaseWas=${this.machine.current}`,
      );
    }
    // Survey, NOT onCaret(). Activation and tab switches are not intentional
    // caret placements: the caret is wherever VS Code restored it. Routing them
    // through onCaret() auto-advanced Survey → Focus, so a file opened in a fresh
    // window rendered with band 2 already painted at the root scope. The first
    // real keystroke or click enters Focus.
    this.machine.reset(Date.now());
    // Classify anyway, so the first intentional caret placement paints instantly
    // instead of waiting a debounce — the plan is cached but not rendered while
    // the phase is Survey.
    if (block) {
      this.scheduleClassify(editor.document, DEBOUNCE_FOCUS_MS);
    }
    this.scheduleRender();
    this.scheduleRelax();
  }

  dispose(): void {
    if (this.relaxTimer) {
      clearTimeout(this.relaxTimer);
    }
    if (this.classifyTimer) {
      clearTimeout(this.classifyTimer);
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    this.importTimers.forEach((t) => clearTimeout(t));
    this.classifyToken?.cancel();
    this.gutterDecoration?.dispose();
    this.pool?.all().forEach((t) => t.dispose());
    // Not in `disposables` — syncDebugChannel() creates and replaces it dynamically.
    this.debugChan?.dispose();
    this.classifier.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
