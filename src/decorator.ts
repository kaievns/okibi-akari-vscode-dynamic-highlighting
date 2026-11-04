/**
 * The decorator — the orchestrator that binds the phase machine, focus
 * resolver, classifier, colour planner, trace expander and risk detector to the
 * active editor, and paints the result.
 *
 * Two clocks, physically separated, are the whole performance story:
 *   - EXPENSIVE (classification / LSP): DEBOUNCED. Typing coalesces at 140ms;
 *     discrete navigation at 60ms. Runs at most once per document version.
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
import { scanBlocks, innermostBlock, focusKeyOf, lexRegionFor, lexIdentifiers, isNonFlowLanguage, BraceBlock } from './focus';
import { PhaseMachine, Phase, PHASE_KANJI, DwellConfig, DEFAULT_DWELL } from './phases';
import { TOKENS, pick, gutterStripeUri, buildDecorationPool, DecorationPool } from './tokens';
import { Classifier } from './classify-lsp';
import { Classification, OffsetRange } from './classify';
import { ColorPlan, planFromColoring } from './colors';
import { ScopeColoring } from './scopecolor';
import { computeTraceRanges } from './traces';
import { lexicalRisk, escapeRisk } from './risk';
import { highlightSpans, linkSpans } from './markdown';
import { rustPlaceholderSpans } from './placeholders';

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
const RETRY_COLD_MS = 500; // one-shot cold-server semantic retry

interface CacheEntry {
  classification: Classification;
  plan: ColorPlan;
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
  // Text + blocks per document version. Caching the TEXT matters as much as the
  // blocks: doc.getText() rebuilds the whole document string, and it was being
  // called several times per caret move.
  private blockCache = new WeakMap<
    vscode.TextDocument,
    { version: number; text: string; blocks: BraceBlock[] }
  >();
  // Markdown band-1 mark ranges per document version. Both scanners walk the
  // whole document, and renderMarkdownMarks runs on every render (every caret
  // move), so without this a large .md file would re-lex on each keystroke.
  private mdCache = new WeakMap<
    vscode.TextDocument,
    { version: number; highlight: vscode.Range[]; link: vscode.Range[] }
  >();
  // Rust format-placeholder ranges per document version. Same reasoning as mdCache:
  // the scan walks the whole document and render runs on every caret move.
  private placeholderCache = new WeakMap<
    vscode.TextDocument,
    { version: number; ranges: vscode.Range[] }
  >();
  // Bounded LRU keyed `${docVersion}::${focusKey}`.
  private classCache = new Map<string, CacheEntry>();
  private static CACHE_LIMIT = 16;

  // Which range list is currently applied to each type, for dirty-checking.
  // Decorations are per-editor, so the dirty-check is only valid for the editor
  // it was recorded against; `lastAppliedEditor` tracks that, and the state is
  // reset when the active editor changes (see render()).
  private lastApplied = new Map<vscode.TextEditorDecorationType, string>();
  private lastAppliedEditor: vscode.TextEditor | undefined;
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
  private classifyToken: vscode.CancellationTokenSource | undefined;

  private relaxTimer: ReturnType<typeof setTimeout> | undefined;
  private classifyTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
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
      // A new editor becoming visible (split, tab restore after reload) must not
      // inherit stale decorations from whatever was painted before.
      vscode.window.onDidChangeVisibleTextEditors(() => {
        const active = vscode.window.activeTextEditor;
        if (active) {
          this.clearOtherEditors(active);
        }
        this.scheduleRender();
      }),
      // Closing a document forgets its engagement, so reopening it starts in Survey
      // like any freshly opened file — and the maps do not grow unbounded.
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.engaged.delete(doc.uri.toString());
      }),
      vscode.window.onDidChangeActiveColorTheme(() => this.onThemeChanged()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('okibiDynamic')) {
          this.config = readConfig();
          this.machine.setDwell(this.config.dwell);
          // Honour a debug toggle without a window reload. Creating the channel only
          // in the constructor meant flipping the setting appeared to do nothing —
          // the channel was not even listed in the Output dropdown.
          this.syncDebugChannel();
          this.buildDecorations();
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
    this.lastApplied.clear();
    this.lastAppliedEditor = undefined;
    this.renderedBand2Key = null;

    const ember = pick(TOKENS.ember, this.isDark);
    // The focus indicator: a thin 2px ember stripe at 50% opacity, left-aligned
    // in the glyph-margin slot (the only public way to paint the gutter).
    const stripe = gutterStripeUri(ember, 0.5, 4);
    this.gutterDecoration = vscode.window.createTextEditorDecorationType({
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
  private docStateFor(doc: vscode.TextDocument): { text: string; blocks: BraceBlock[] } {
    const cached = this.blockCache.get(doc);
    if (cached && cached.version === doc.version) {
      return cached;
    }
    const text = doc.getText();
    const state = { version: doc.version, text, blocks: scanBlocks(text, doc.languageId) };
    this.blockCache.set(doc, state);
    return state;
  }

  /** Cached document text for the current version (see docStateFor). */
  private textFor(doc: vscode.TextDocument): string {
    return this.docStateFor(doc).text;
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
    const { text, blocks } = this.docStateFor(doc);
    // `text` is what enables the synthetic MODULE TOP LEVEL scope, so a caret among
    // top-level declarations still focuses something. Prose must NOT get it: that
    // fallback spans the whole document, which in a markdown file made every English
    // word a candidate data identity — the layer tinted `the`, `a` and `The`.
    // Withholding it returns null, so the phase stays Survey and bands 2-3 never
    // paint. See `isProseLanguage`.
    const fallback = isNonFlowLanguage(doc.languageId) ? undefined : text;
    return innermostBlock(blocks, caret.line, doc.offsetAt(caret), fallback);
  }

  /**
   * The classification cache key. MUST include the document URI: `focusKey` is
   * only `openLine#depth`, and a freshly-reloaded window has every document at
   * version 1 — so `sample.js` and `sample.go` both keyed to `1::0#-1` and the
   * second file rendered the FIRST file's occurrence offsets against its own
   * text. That was the "garbled highlighting on files not focused at reload":
   * ranges landing mid-word and inside comments.
   */
  private cacheKey(doc: vscode.TextDocument, focusKey: string): string {
    return `${doc.uri.toString()}::${doc.version}::${focusKey}`;
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
    if (editor !== vscode.window.activeTextEditor) {
      return;
    }
    // Most selection-change events are a discrete, intentional caret placement —
    // a click or an arrow key. Scroll fires onDidChangeVisibleRanges (not
    // subscribed) and hover fires nothing, so neither reaches here (spec §3.3:
    // "changes only on discrete intentional input, never scroll/hover/time").
    // A mouse click MUST advance Survey→Focus and refresh the activity clock the
    // same as a keystroke — onCaret only ever upgrades one-way, so there is no
    // strobe to guard against. (Earlier we gated this on Keyboard/Command kind,
    // which left clicks unable to enter Focus — that was the "stuck until I
    // arrow-key" bug.)
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
    }
  }

  private onEdit(e: vscode.TextDocumentChangeEvent): void {
    if (!this.config.enabled || e.contentChanges.length === 0) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== e.document) {
      return;
    }
    const now = Date.now();
    // Typing is unambiguous engagement — it also covers the case where an edit
    // repositions the caret without a separate selection event.
    this.engaged.add(e.document.uri.toString());
    this.machine.onType(now);
    // Version bumped → block scan + classification are stale.
    this.classifier.invalidate(e.document);
    this.scheduleClassify(e.document, DEBOUNCE_EDIT_MS);
    this.scheduleRender(); // renders lexical band-3 now, holds stale band-2
    this.scheduleRelax();
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
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== doc) {
      return;
    }
    const block = this.focusedBlock(editor);
    if (!block) {
      return; // Survey — nothing to classify
    }
    const focusKey = focusKeyOf(block);
    const key = this.cacheKey(doc, focusKey);
    if (this.classCache.has(key)) {
      // Fresh plan already cached for this version+block; just (re)render.
      this.scheduleRender();
      return;
    }

    this.classifyToken?.cancel();
    this.classifyToken = new vscode.CancellationTokenSource();
    const token = this.classifyToken.token;

    let scoped: { focused: Classification; coloring: ScopeColoring } | null;
    try {
      scoped = await this.classifier.classifyScope(
        doc,
        block,
        TOKENS.id.length,
        token,
        this.docStateFor(doc), // reuse the cached text + block scan
      );
    } catch {
      return;
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
      `classify OK key=${focusKey} byName=[${[...classification.byName].map(([n, i]) => n + ':' + i.cls).join(',')}]`,
    );

    // Build the render plan from the SCOPE colouring: a name's hue comes from the
    // co-visibility graph (deterministic, navigation-independent), and only the
    // names in this block's visible set are painted at all.
    const plan = planFromColoring(classification, scoped.coloring);
    this.putCache(key, { classification, plan });
    this.scheduleRender();

    // Cold-server empty semantic recovery: one retry for this version only. The
    // just-cached plan is a lexical-fallback (empty semantic result), so the
    // retry must evict BOTH the classifier's LSP bundle cache and this decorator
    // cache entry — otherwise runClassify short-circuits on the stale plan and
    // never re-queries the now-warm server.
    if (this.classifier.wasEmptySemantic(doc) && this.classifier.canRetry(doc)) {
      this.classifier.markRetried(doc);
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
      }
      this.retryTimer = setTimeout(() => {
        this.classifier.invalidate(doc);
        this.classCache.delete(key);
        void this.runClassify(doc);
      }, RETRY_COLD_MS);
    }
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
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      // No active text editor — focus is in a webview, panel or another split.
      // The bands must still come off the editors that are STILL VISIBLE: a Focus
      // → Survey relaxation firing while the caret is elsewhere used to leave the
      // tints painted forever, because clearAll(undefined) only reset bookkeeping.
      this.clearAllVisible();
      this.updateStatus();
      return;
    }
    if (!this.config.enabled) {
      // Disabled means disabled: band 1 marks come off too.
      this.clearAllVisible(true);
      this.statusItem.hide();
      return;
    }

    // The dirty-check tracks ranges per decoration TYPE, but decorations are
    // per-EDITOR. When the active editor changes, the recorded state describes a
    // different editor and must be dropped, or an identical range set would be
    // skipped and the newly-focused editor left unpainted.
    if (this.lastAppliedEditor !== editor) {
      this.lastApplied.clear();
      this.lastAppliedEditor = editor;
      this.renderedBand2Key = null;
      // Band 2/3 belong to the FOCUSED block, so only the active editor may show
      // them. Other visible editors (split view, or restored-but-unfocused tabs
      // after a window reload) must be cleared: their decorations came from a
      // different document's classification and read as garbled highlighting on
      // random text. Decorations are per-editor, so this has to be explicit.
      this.clearOtherEditors(editor);
    }

    const doc = editor.document;

    // 0. Markdown band-1 marks. Painted BEFORE the phase gate and independent of
    //    it: these are part of the resting register, and they live in this
    //    extension only because `tokenColors` physically cannot express them (see
    //    src/markdown.ts). Gating them on Focus would make the highlight wash
    //    appear and disappear as attention moved, which is the opposite of band 1.
    this.renderMarkdownMarks(editor, doc);

    const block = this.focusedBlock(editor);
    const phase = this.machine.current;
    // FINAL GATE, enforced at the only place decorations are ever applied.
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

    // 1. Gutter stripe — Focus + Edit, focused block's lines.
    if (showBand2 && block) {
      const ranges: vscode.Range[] = [];
      for (let line = block.openLine; line <= block.closeLine; line++) {
        ranges.push(new vscode.Range(line, 0, line, 0));
      }
      this.applyGutter(editor, ranges);
    } else {
      this.applyGutter(editor, []);
    }

    // 2. Band 2 — identity tints (cached plan for this version+block, or stale-hold).
    if (showBand2 && block) {
      this.renderBand2(editor, doc, block);
    } else {
      this.clearBand2(editor);
    }

    // 3. Band 3 — risk marks, Edit only, focused block.
    if (showBand3 && block) {
      this.renderBand3(editor, doc, block);
    } else {
      this.clearBand3(editor);
    }

    // 4. Clay numeric literals — the ENGAGED half of the spec's number pair.
    //
    // `--syn-number` / `--syn-number-engaged` are both `--syn-*` (band 1), not
    // `--risk-*`, and the token comments read "literal numbers REST receded" /
    // "clay — focused scope, engaged phases only". A scope becomes *engaged* at
    // Focus (band 2's word for it), so clay arrives with Focus and persists through
    // Edit — it was previously gated on Edit alone, so numbers stayed slate for the
    // whole of Focus.
    if (showBand2 && block) {
      this.renderEngagedNumbers(editor, doc, block);
    } else {
      this.applyType(editor, this.pool.numberEngaged, []);
    }

    // 5. BAND 1 — `self` / `this`, file-wide and phase-independent.
    //
    // Not gated on the phase or on there being a focused block, because it is not a
    // phase mark: --id-self equals band 1's resting keyword colour, so this paint is
    // a no-op wherever band 1 already rendered correctly. It exists to correct the
    // one case band 1 cannot: on a `.rs` file outside a cargo workspace,
    // rust-analyzer types a `self` USE as `const`, and a semantic token outranks the
    // grammar — so `self.retries` renders at editor.foreground, plain white.
    //
    // It was previously painted inside renderBand2, clipped to the focused block and
    // cleared by clearBand2. That produced exactly the reported artefact: correct on
    // first paint, white as soon as the phase relaxed to Survey, slate again on
    // Focus. A correction for a phase-independent defect has to be phase-independent
    // too.
    this.renderSelf(editor, doc);

    // 6. BAND 1 — Rust format placeholders. Also phase-independent, and also a
    // correction for a semantic token the theme cannot outrank: rust-analyzer emits
    // ONE `string` token spanning a whole literal, so the grammar's
    // `meta.interpolation.rust` — which the theme does select — is annihilated and
    // the holes render string green. Go, Python and TS need nothing here; their
    // grammars scope placeholders separately and the theme reaches them. See
    // src/placeholders.ts.
    this.renderPlaceholders(editor, doc);

    this.updateStatus();
  }

  /**
   * Paint `self` / `this` file-wide, at band 1's keyword colour.
   *
   * Deliberately a plain lex rather than a classification: it needs no scope
   * analysis (every `self` in a file is the same identity to band 1), it must work
   * in Survey where there is no classification at all, and it must not wait on the
   * language server. `lexIdentifiers` already skips strings and comments, so a
   * `self` inside a doc comment is not painted.
   */
  private renderSelf(editor: vscode.TextEditor, doc: vscode.TextDocument): void {
    const text = this.textFor(doc);
    const ranges: vscode.Range[] = [];
    for (const id of lexIdentifiers(text)) {
      if (id.name === 'self' || id.name === 'this') {
        ranges.push(this.toRange(doc, { start: id.offset, end: id.offset + id.length }));
      }
    }
    this.dbg(`  band1 self: ${ranges.length} ranges (phase-independent)`);
    this.applyType(editor, this.pool.self, ranges);
  }

  /**
   * Paint Rust format placeholders at member steel, file-wide and phase-independent.
   *
   * Rust only: the other languages' grammars emit a distinct scope for a placeholder
   * and the theme handles them, so painting here would be redundant work on every
   * render. Cached per document version because the scan walks the whole file and
   * render runs on every caret move.
   */
  private renderPlaceholders(editor: vscode.TextEditor, doc: vscode.TextDocument): void {
    if (doc.languageId !== 'rust') {
      this.applyType(editor, this.pool.placeholder, []);
      return;
    }
    const cached = this.placeholderCache.get(doc);
    let ranges: vscode.Range[];
    if (cached && cached.version === doc.version) {
      ranges = cached.ranges;
    } else {
      ranges = rustPlaceholderSpans(this.textFor(doc)).map((s) => this.toRange(doc, s));
      this.placeholderCache.set(doc, { version: doc.version, ranges });
    }
    this.dbg(`  band1 placeholders: ${ranges.length} ranges (${doc.languageId})`);
    this.applyType(editor, this.pool.placeholder, ranges);
  }

  private renderBand2(editor: vscode.TextEditor, doc: vscode.TextDocument, block: BraceBlock): void {
    const focusKey = focusKeyOf(block);
    const key = this.cacheKey(doc, focusKey);
    const entry = this.classCache.get(key);
    if (!entry) {
      // No fresh classification for this version+block yet.
      if (this.renderedBand2Key === focusKey) {
        // STALE-HOLD: same block, mid-typing — keep the existing tints on screen
        // so typing doesn't flicker to neutral. The pending classify repaints.
        return;
      }
      // Different block (real navigation) with nothing cached yet: clear the old
      // block's tints now, then the pending classify cuts in the new ones.
      this.clearBand2(editor);
      return;
    }

    // Header-inclusive for control-flow blocks, so header-line bindings tint too
    // (matches the range used at classify time). See focus.ts.
    const blockRange: OffsetRange = lexRegionFor(this.textFor(doc), block);
    const targets = computeTraceRanges(entry.classification, entry.plan, blockRange);
    if (this.debugChan) {
      this.dbg(
        `  band2 block=L${block.openLine}#d${block.depth} ` +
          `byName=[${[...entry.classification.byName].map(([n, i]) => n + ':' + i.cls).join(',')}] ` +
          `targets=[${targets.map((t) => t.name + '(' + t.ranges.length + ')').join(',')}]`,
      );
    }

    // Bucket ranges by decoration type.
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

    this.pool.id.forEach((type, i) => this.applyType(editor, type, idRanges[i]));
    this.pool.idg.forEach((type, i) => this.applyType(editor, type, idgRanges[i]));
    this.renderedBand2Key = focusKey;
  }

  /**
   * Clay numeric literals in the focused block.
   *
   * The spec pairs `--syn-number` (receded, at rest) with `--syn-number-engaged`
   * (clay, "focused scope, engaged phases only"). Both are band-1 `--syn-*`
   * tokens, so this is a resting-register swap inside the focused scope rather
   * than a risk mark — which is why it rides Focus, not Edit.
   */
  private renderEngagedNumbers(
    editor: vscode.TextEditor,
    doc: vscode.TextDocument,
    block: BraceBlock,
  ): void {
    const text = this.textFor(doc);
    const lex = lexicalRisk(text, lexRegionFor(text, block));
    this.applyType(
      editor,
      this.pool.numberEngaged,
      lex.numberEngaged.map((r) => this.toRange(doc, r)),
    );
  }

  /**
   * The two markdown marks a colour theme cannot express: the ==highlight== wash
   * and the cancellation of VS Code's link underline. See src/markdown.ts for why
   * each has to be a decoration.
   *
   * Band 1, so no phase or engagement gate — but still cached per document
   * version, because both scanners walk the whole document and this runs on every
   * render (i.e. every caret move). Non-markdown documents clear and return, so a
   * `.ts` file never carries a stale wash from a previously active `.md`.
   */
  private renderMarkdownMarks(editor: vscode.TextEditor, doc: vscode.TextDocument): void {
    if (doc.languageId !== 'markdown') {
      this.applyType(editor, this.pool.mdHighlight, []);
      this.applyType(editor, this.pool.mdLinkPlain, []);
      return;
    }

    const cached = this.mdCache.get(doc);
    let marks = cached && cached.version === doc.version ? cached : undefined;
    if (!marks) {
      const text = this.textFor(doc);
      marks = {
        version: doc.version,
        highlight: highlightSpans(text).map((s) => this.toRange(doc, s)),
        link: linkSpans(text).map((s) => this.toRange(doc, s)),
      };
      this.mdCache.set(doc, marks);
    }

    this.applyType(editor, this.pool.mdHighlight, marks.highlight);
    this.applyType(editor, this.pool.mdLinkPlain, marks.link);
  }

  private renderBand3(editor: vscode.TextEditor, doc: vscode.TextDocument, block: BraceBlock): void {
    const text = this.textFor(doc);
    const blockRange: OffsetRange = lexRegionFor(text, block);
    const lex = lexicalRisk(text, blockRange);

    this.applyType(editor, this.pool.riskAsync, lex.async.map((r) => this.toRange(doc, r)));
    this.applyType(editor, this.pool.riskDanger, lex.danger.map((r) => this.toRange(doc, r)));
    // numberEngaged is NOT painted here — it belongs to Focus+Edit, not Edit alone.
    // See renderEngagedNumbers().

    // Escape marks need the classification; use the cached one if present, else
    // leave escape empty until classify resolves (it will trigger a re-render).
    const entry = this.classCache.get(this.cacheKey(doc, focusKeyOf(block)));
    if (entry) {
      const esc = escapeRisk(text, blockRange, entry.classification);
      this.applyType(editor, this.pool.riskEscape, esc.map((r) => this.toRange(doc, r)));
    } else {
      this.applyType(editor, this.pool.riskEscape, []);
    }
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

  /** setDecorations only if this type's target ranges actually changed. */
  private applyType(editor: vscode.TextEditor, type: vscode.TextEditorDecorationType, ranges: vscode.Range[]): void {
    const key = this.rangeKey(ranges);
    if (this.lastApplied.get(type) === key) {
      return;
    }
    editor.setDecorations(type, ranges);
    this.lastApplied.set(type, key);
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
      // Bypass the dirty-check (it tracks only `keep`'s state) and clear directly.
      // `banded()`, not `all()`: the markdown band-1 marks are correct in every
      // visible editor showing that document and must survive — clearing them here
      // stripped the highlight wash from a split's second markdown pane.
      other.setDecorations(this.gutterDecoration, []);
      for (const type of this.pool.banded()) {
        other.setDecorations(type, []);
      }
    }
  }

  private clearAll(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      this.lastApplied.clear();
      return;
    }
    this.applyGutter(editor, []);
    this.clearBand2(editor);
    this.clearBand3(editor);
  }

  /**
   * Strip the bands from EVERY visible editor.
   *
   * Used when there is no active text editor (focus in a webview/panel/another
   * split) or the layer is disabled. `clearAll(undefined)` cannot do this:
   * decorations are per-editor, and with no active editor there is nothing to
   * paint through — it only reset the dirty-check map, so a Focus → Survey
   * relaxation that fired while the caret was elsewhere left the tints on screen
   * indefinitely.
   */
  private clearAllVisible(includeBand1 = false): void {
    // `includeBand1` separates the two callers. Focus moving to a webview or panel
    // must withdraw the phase bands but NOT the markdown band-1 marks — those are
    // resting register, and blinking the highlight wash off because the caret left
    // the editor would be exactly the flicker this layer exists to avoid. Turning
    // the extension off, by contrast, must leave no trace of it on screen.
    const types = includeBand1 ? this.pool.all() : this.pool.banded();
    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(this.gutterDecoration, []);
      for (const type of types) {
        ed.setDecorations(type, []);
      }
    }
    this.lastApplied.clear();
    this.lastAppliedEditor = undefined;
    this.renderedBand2Key = null;
  }

  /**
   * The phase as the SCREEN shows it: Survey in a document the user has not
   * engaged, since render() refuses to paint bands there.
   */
  private effectivePhase(): Phase {
    const editor = vscode.window.activeTextEditor;
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
    // final gate in render()), so showing 流/異 there would misreport the screen.
    const phase = this.effectivePhase();
    this.statusItem.text = `${PHASE_KANJI[phase]} ${phase}`;
    this.statusItem.tooltip = 'Okibi dynamic phase — click to toggle the layer';
    this.statusItem.show();
  }

  /** Recompute + repaint for the active editor from scratch. */
  refresh(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.statusItem.hide();
      return;
    }
    if (!this.config.enabled) {
      this.clearAll(editor);
      this.statusItem.hide();
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
    this.classifyToken?.cancel();
    this.gutterDecoration?.dispose();
    this.pool?.all().forEach((t) => t.dispose());
    // Not in `disposables` — syncDebugChannel() creates and replaces it dynamically.
    this.debugChan?.dispose();
    this.classifier.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
