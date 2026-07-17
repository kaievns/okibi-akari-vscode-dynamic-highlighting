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
import { scanBraceBlocks, innermostBlock, focusKeyOf, BraceBlock } from './focus';
import { PhaseMachine, Phase, PHASE_KANJI, DwellConfig, DEFAULT_DWELL } from './phases';
import { TOKENS, pick, gutterStripeUri, buildDecorationPool, DecorationPool } from './tokens';
import { Classifier } from './classify-lsp';
import { Classification, OffsetRange } from './classify';
import { assignColors, ColorPlan, GlobalColorLedger, LocalColorLedger } from './colors';
import { computeTraceRanges } from './traces';
import { lexicalRisk, escapeRisk } from './risk';

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
  private ledgers = new WeakMap<vscode.TextDocument, GlobalColorLedger>();
  // Per-document local-identity ledger — keeps a variable's hue stable across
  // every sub-block of its enclosing function (resets per function internally).
  private localLedgers = new WeakMap<vscode.TextDocument, LocalColorLedger>();
  private blockCache = new WeakMap<vscode.TextDocument, { version: number; blocks: BraceBlock[] }>();
  // Bounded LRU keyed `${docVersion}::${focusKey}`.
  private classCache = new Map<string, CacheEntry>();
  private static CACHE_LIMIT = 16;

  // Which range list is currently applied to each type, for dirty-checking.
  // Decorations are per-editor, so the dirty-check is only valid for the editor
  // it was recorded against; `lastAppliedEditor` tracks that, and the state is
  // reset when the active editor changes (see render()).
  private lastApplied = new Map<vscode.TextEditorDecorationType, string>();
  private lastAppliedEditor: vscode.TextEditor | undefined;

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

  constructor() {
    this.config = readConfig();
    this.machine = new PhaseMachine(this.config.dwell);
    this.isDark = this.currentlyDark();

    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = 'okibiDynamic.toggle';
    this.disposables.push(this.statusItem);

    this.buildDecorations();

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.onSelection(e)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onEdit(e)),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
      vscode.window.onDidChangeActiveColorTheme(() => this.onThemeChanged()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('okibiDynamic')) {
          this.config = readConfig();
          this.machine.setDwell(this.config.dwell);
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

  private ledgerFor(doc: vscode.TextDocument): GlobalColorLedger {
    let l = this.ledgers.get(doc);
    if (!l) {
      l = new GlobalColorLedger();
      this.ledgers.set(doc, l);
    }
    return l;
  }

  private localLedgerFor(doc: vscode.TextDocument): LocalColorLedger {
    let l = this.localLedgers.get(doc);
    if (!l) {
      l = new LocalColorLedger();
      this.localLedgers.set(doc, l);
    }
    return l;
  }

  private blocksFor(doc: vscode.TextDocument): BraceBlock[] {
    const cached = this.blockCache.get(doc);
    if (cached && cached.version === doc.version) {
      return cached.blocks;
    }
    const blocks = scanBraceBlocks(doc.getText());
    this.blockCache.set(doc, { version: doc.version, blocks });
    return blocks;
  }

  private cacheKey(doc: vscode.TextDocument, focusKey: string): string {
    return `${doc.version}::${focusKey}`;
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
    // Every selection-change event is a discrete, intentional caret placement —
    // a click or an arrow key. Scroll fires onDidChangeVisibleRanges (not
    // subscribed) and hover fires nothing, so neither reaches here (spec §3.3:
    // "changes only on discrete intentional input, never scroll/hover/time").
    // A mouse click MUST advance Survey→Focus and refresh the activity clock the
    // same as a keystroke — onCaret only ever upgrades one-way, so there is no
    // strobe to guard against. (Earlier we gated this on Keyboard/Command kind,
    // which left clicks unable to enter Focus — that was the "stuck until I
    // arrow-key" bug.)
    const caretLine = editor.selection.active.line;
    const block = innermostBlock(this.blocksFor(editor.document), caretLine);
    const now = Date.now();
    const phaseChanged = this.machine.onCaret(block !== null, now);

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
    const block = innermostBlock(this.blocksFor(doc), editor.selection.active.line);
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

    let classification: Classification | null;
    try {
      classification = await this.classifier.classify(doc, block, token);
    } catch {
      return;
    }
    if (!classification || token.isCancellationRequested) {
      return;
    }
    // Epoch guard: discard if the document moved on or focus jumped away.
    if (classification.docVersion !== doc.version || classification.focusKey !== this.currentFocusKey) {
      return;
    }

    // fnKey identifies the COLOUR scope — the outermost function — so the local
    // ledger stays stable across a top-level function AND its nested closures,
    // resetting only when the caret enters an unrelated top-level function. Fall
    // back to a sentinel at module top level so those locals share one scope.
    const fn = classification.colorScopeFn;
    const fnKey = fn ? `${fn.start}-${fn.end}` : 'toplevel';
    const plan = assignColors(classification.byName, this.ledgerFor(doc), this.localLedgerFor(doc), {
      fileGlobalsInOrder: classification.fileGlobalsInOrder,
      fnLocalsInOrder: classification.fnLocalsInOrder,
      fnGlobals: classification.fnGlobals,
      fnKey,
    });
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
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.clearAll(editor);
      this.updateStatus();
      return;
    }
    if (!this.config.enabled) {
      this.clearAll(editor);
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
    }

    const doc = editor.document;
    const block = innermostBlock(this.blocksFor(doc), editor.selection.active.line);
    const phase = this.machine.current;
    const showBand2 = block !== null && (phase === Phase.Focus || phase === Phase.Edit);
    const showBand3 = block !== null && phase === Phase.Edit;

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

    this.updateStatus();
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

    const blockRange: OffsetRange = { start: block.openOffset, end: block.closeOffset + 1 };
    const targets = computeTraceRanges(entry.classification, entry.plan, blockRange);

    // Bucket ranges by decoration type.
    const idRanges: vscode.Range[][] = TOKENS.id.map(() => []);
    const idgRanges: vscode.Range[][] = TOKENS.idg.map(() => []);
    const selfRanges: vscode.Range[] = [];

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
          selfRanges.push(...vranges);
          break;
        case 'neutral':
          break;
      }
    }

    this.pool.id.forEach((type, i) => this.applyType(editor, type, idRanges[i]));
    this.pool.idg.forEach((type, i) => this.applyType(editor, type, idgRanges[i]));
    this.applyType(editor, this.pool.self, selfRanges);
    this.renderedBand2Key = focusKey;
  }

  private renderBand3(editor: vscode.TextEditor, doc: vscode.TextDocument, block: BraceBlock): void {
    const text = doc.getText();
    const blockRange: OffsetRange = { start: block.openOffset, end: block.closeOffset + 1 };
    const lex = lexicalRisk(text, blockRange);

    this.applyType(editor, this.pool.riskAsync, lex.async.map((r) => this.toRange(doc, r)));
    this.applyType(editor, this.pool.riskDanger, lex.danger.map((r) => this.toRange(doc, r)));
    this.applyType(editor, this.pool.numberEngaged, lex.numberEngaged.map((r) => this.toRange(doc, r)));

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
    this.applyType(editor, this.pool.self, []);
    this.renderedBand2Key = null;
  }

  private clearBand3(editor: vscode.TextEditor): void {
    this.applyType(editor, this.pool.riskAsync, []);
    this.applyType(editor, this.pool.riskDanger, []);
    this.applyType(editor, this.pool.riskEscape, []);
    this.applyType(editor, this.pool.numberEngaged, []);
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

  private updateStatus(): void {
    if (!this.config.enabled || !this.config.showPhaseInStatusBar) {
      this.statusItem.hide();
      return;
    }
    const phase = this.machine.current;
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
    const block = innermostBlock(this.blocksFor(editor.document), editor.selection.active.line);
    this.currentFocusKey = block ? focusKeyOf(block) : null;
    this.machine.onCaret(block !== null, Date.now());
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
    this.classifier.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
