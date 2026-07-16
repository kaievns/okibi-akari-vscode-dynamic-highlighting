/**
 * The decorator — binds the phase machine + focus resolver to a text editor and
 * paints the focused-block indicator (spec §3.5):
 *
 *   Focused block renders: faint fill (2% fg), 2px inset --ember-line bar.
 *
 * This is the vertical slice: Survey → Focus → Edit felt in a real editor, with
 * the focused-block fill and inset bar appearing on the innermost brace-block as
 * the caret moves. Bands 2–3 (identity tints, risk marks) are not applied yet —
 * their tokens are already resolved in tokens.ts for the next slice.
 *
 * Composition (§7): band 1 is the theme underneath; these decorations layer on
 * top. The fill is a whole-line background over the block's body; the ember bar
 * is a left border on the block's lines. Both are cuts — set on selection change
 * or phase change, never animated (§3.4).
 */

import * as vscode from 'vscode';
import { scanBraceBlocks, innermostBlock, BraceBlock } from './focus';
import { PhaseMachine, Phase, PHASE_KANJI, DwellConfig } from './phases';
import { TOKENS, pick, gutterStripeUri } from './tokens';

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
      editToFocus: c.get('dwell.editToFocus', 1400),
      focusToSurvey: c.get('dwell.focusToSurvey', 12000),
      minHold: c.get('dwell.minHold', 350),
    },
  };
}

export class Decorator implements vscode.Disposable {
  private config: Config;
  private machine: PhaseMachine;
  private statusItem: vscode.StatusBarItem;

  // Decoration types are recreated when the theme kind flips (dark↔light) so
  // the ember bar / fill use the right side of each token pair.
  private gutterDecoration!: vscode.TextEditorDecorationType;
  private isDark: boolean;

  // Per-document brace-block cache, keyed by document version.
  private blockCache = new WeakMap<vscode.TextDocument, { version: number; blocks: BraceBlock[] }>();

  private relaxTimer: ReturnType<typeof setTimeout> | undefined;
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

    const ember = pick(TOKENS.ember, this.isDark);
    // A thin 2px ember line at 50% opacity, left-aligned in the glyph-margin
    // slot. gutterIconSize 'cover' fills the slot vertically (no gaps between
    // lines); the SVG's rect width of 4% in the 100-unit viewbox gives a ~2px
    // visual line at typical gutter widths.
    const stripe = gutterStripeUri(ember, 0.5, 4);

    this.gutterDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.parse(stripe),
      gutterIconSize: 'cover',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }

  private onThemeChanged(): void {
    const nowDark = this.currentlyDark();
    if (nowDark !== this.isDark) {
      this.isDark = nowDark;
      this.buildDecorations();
      this.refresh();
    }
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

  private onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.config.enabled) {
      return;
    }
    const editor = e.textEditor;
    if (editor !== vscode.window.activeTextEditor) {
      return;
    }
    const caretLine = editor.selection.active.line;
    const block = innermostBlock(this.blocksFor(editor.document), caretLine);
    const now = Date.now();
    const changed = this.machine.onCaret(block !== null, now);
    // Always re-render on caret move: even without a phase change the focused
    // block may have changed (moved from one sibling block to another).
    this.render(editor, block);
    if (changed) {
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
    const caretLine = editor.selection.active.line;
    const block = innermostBlock(this.blocksFor(editor.document), caretLine);
    this.render(editor, block);
    this.scheduleRelax();
  }

  /** Schedule a single timer for the next possible relaxation; re-armed on each event. */
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
    const editor = vscode.window.activeTextEditor;
    const now = Date.now();
    const changed = this.machine.tick(now);
    if (changed && editor) {
      const caretLine = editor.selection.active.line;
      const block = innermostBlock(this.blocksFor(editor.document), caretLine);
      this.render(editor, block);
    } else {
      this.updateStatus();
    }
    // Keep ticking while a further relaxation is pending (Edit→Focus→Survey).
    this.scheduleRelax();
  }

  /** Paint the focused-block indicator per the current phase. */
  private render(editor: vscode.TextEditor, block: BraceBlock | null): void {
    // §3.5 — the focused-block indicator belongs to Focus and Edit. In Survey
    // it withdraws (calm at rest). Cumulative supersets: Edit shows everything
    // Focus shows, plus (future) risk marks.
    const phase = this.machine.current;
    const showIndicator = block !== null && (phase === Phase.Focus || phase === Phase.Edit);

    if (!showIndicator || !block) {
      editor.setDecorations(this.gutterDecoration, []);
      this.updateStatus();
      return;
    }

    // One range per block line — the gutter icon renders per-line, giving a
    // continuous thin ember stripe down the left edge of the gutter.
    const ranges: vscode.Range[] = [];
    for (let line = block.openLine; line <= block.closeLine; line++) {
      ranges.push(new vscode.Range(line, 0, line, 0));
    }
    editor.setDecorations(this.gutterDecoration, ranges);
    this.updateStatus();
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
      editor.setDecorations(this.gutterDecoration, []);
      this.statusItem.hide();
      return;
    }
    const caretLine = editor.selection.active.line;
    const block = innermostBlock(this.blocksFor(editor.document), caretLine);
    this.machine.onCaret(block !== null, Date.now());
    this.render(editor, block);
    this.scheduleRelax();
  }

  dispose(): void {
    if (this.relaxTimer) {
      clearTimeout(this.relaxTimer);
    }
    this.gutterDecoration?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
