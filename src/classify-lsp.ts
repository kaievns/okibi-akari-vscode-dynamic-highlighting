/**
 * The impure classification layer — the only place that talks to VS Code's LSP
 * commands. It fetches the document's symbol tree + semantic tokens once per
 * document version, converts them to the offset-based shapes in classify.ts,
 * and delegates the actual classification to the pure functions there.
 *
 * Hybrid strategy (user decision 1): try the semantic-tokens provider first;
 * if it is absent or returns nothing, fall back to the pure heuristic scan. A
 * single file-wide fetch feeds every block visited in that version — navigating
 * an unedited file costs zero extra LSP calls.
 */

import * as vscode from 'vscode';
import {
  Classification,
  OffsetRange,
  DecodedToken,
  decodeSemanticTokens,
  lineStartOffsets,
  enclosingFnOf,
  outermostFnOf,
  classifyFromSemantic,
  classifyFromHeuristic,
} from './classify';
import { BraceBlock, focusKeyOf } from './focus';

interface LspBundle {
  version: number;
  tokens: DecodedToken[] | null; // null = no semantic provider
  fnRanges: OffsetRange[];
  lineStarts: number[];
}

const FUNCTION_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

export class Classifier implements vscode.Disposable {
  private cache = new WeakMap<vscode.TextDocument, LspBundle>();
  /** Versions for which a cold-empty retry has already been scheduled (avoid loops). */
  private retriedVersions = new WeakMap<vscode.TextDocument, number>();

  /**
   * Classify the focused block. Returns null only if cancelled. Falls back to
   * the heuristic scan when no semantic provider is available.
   */
  async classify(
    doc: vscode.TextDocument,
    block: BraceBlock,
    token: vscode.CancellationToken,
  ): Promise<Classification | null> {
    const text = doc.getText();
    const blockRange: OffsetRange = { start: block.openOffset, end: block.closeOffset + 1 };
    const focusKey = focusKeyOf(block);

    const bundle = await this.bundleFor(doc, text, token);
    if (token.isCancellationRequested) {
      return null;
    }

    const caretOffset = block.openOffset;
    const enclosingFn = enclosingFnOf(bundle.fnRanges, caretOffset);
    // Colour scope = the outermost function containing the caret, so hues stay
    // stable across a top-level function and all its nested closures.
    const colorScopeFn = outermostFnOf(bundle.fnRanges, caretOffset);

    if (bundle.tokens && bundle.tokens.length > 0) {
      return classifyFromSemantic(
        text,
        blockRange,
        enclosingFn,
        bundle.fnRanges,
        bundle.tokens,
        doc.version,
        focusKey,
        colorScopeFn,
      );
    }

    // No semantic tokens → heuristic. (Cold-server empty result is handled by the
    // caller's one-shot retry; a genuinely brace-only language just uses this.)
    return classifyFromHeuristic(
      text,
      blockRange,
      enclosingFn,
      bundle.fnRanges,
      doc.version,
      focusKey,
      colorScopeFn,
    );
  }

  /** True if the last semantic fetch for this doc/version returned nothing (cold-server candidate). */
  wasEmptySemantic(doc: vscode.TextDocument): boolean {
    const b = this.cache.get(doc);
    return !!b && b.version === doc.version && (b.tokens === null || b.tokens.length === 0);
  }

  /** Record that a cold-empty retry has been fired for this version. */
  markRetried(doc: vscode.TextDocument): void {
    this.retriedVersions.set(doc, doc.version);
  }

  /** Whether a cold-empty retry is still allowed for the current version. */
  canRetry(doc: vscode.TextDocument): boolean {
    return this.retriedVersions.get(doc) !== doc.version;
  }

  /** Invalidate the cache for a document (forces a fresh fetch next classify). */
  invalidate(doc: vscode.TextDocument): void {
    this.cache.delete(doc);
  }

  private async bundleFor(
    doc: vscode.TextDocument,
    text: string,
    token: vscode.CancellationToken,
  ): Promise<LspBundle> {
    const cached = this.cache.get(doc);
    if (cached && cached.version === doc.version) {
      return cached;
    }

    const lineStarts = lineStartOffsets(text);
    const [symbols, tokens] = await Promise.all([
      this.fetchSymbols(doc.uri),
      this.fetchSemanticTokens(doc, lineStarts, text),
    ]);
    if (token.isCancellationRequested) {
      // Return an uncached transient bundle; caller discards on the cancel check.
      return { version: doc.version, tokens, fnRanges: [], lineStarts };
    }

    // Defensive: an unexpected symbol shape must degrade to empty fnRanges (→
    // everything reads as out-of-fn), never reject the whole classify.
    let fnRanges: OffsetRange[];
    try {
      fnRanges = this.collectFunctionRanges(symbols, doc);
    } catch {
      fnRanges = [];
    }
    const bundle: LspBundle = { version: doc.version, tokens, fnRanges, lineStarts };
    this.cache.set(doc, bundle);
    return bundle;
  }

  private async fetchSymbols(
    uri: vscode.Uri,
  ): Promise<(vscode.DocumentSymbol | vscode.SymbolInformation)[]> {
    try {
      const result = await vscode.commands.executeCommand<
        (vscode.DocumentSymbol | vscode.SymbolInformation)[]
      >('vscode.executeDocumentSymbolProvider', uri);
      return result ?? [];
    } catch {
      return [];
    }
  }

  private async fetchSemanticTokens(
    doc: vscode.TextDocument,
    lineStarts: number[],
    text: string,
  ): Promise<DecodedToken[] | null> {
    try {
      const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>(
        'vscode.provideDocumentSemanticTokensLegend',
        doc.uri,
      );
      const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens | undefined>(
        'vscode.provideDocumentSemanticTokens',
        doc.uri,
      );
      if (!legend || !tokens) {
        return null;
      }
      return decodeSemanticTokens(tokens.data, legend.tokenTypes, legend.tokenModifiers, lineStarts, text);
    } catch {
      return null;
    }
  }

  private collectFunctionRanges(
    symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[],
    doc: vscode.TextDocument,
  ): OffsetRange[] {
    const ranges: OffsetRange[] = [];
    // executeDocumentSymbolProvider returns EITHER hierarchical DocumentSymbol[]
    // (range on `.range`, nested `.children`) OR flat SymbolInformation[] (range
    // on `.location.range`, no children). Read the range from whichever exists;
    // skip a symbol that has neither rather than throwing.
    const rangeOf = (s: vscode.DocumentSymbol | vscode.SymbolInformation): vscode.Range | undefined => {
      const ds = s as vscode.DocumentSymbol;
      if (ds.range) {
        return ds.range;
      }
      const si = s as vscode.SymbolInformation;
      return si.location?.range;
    };
    const walk = (nodes: (vscode.DocumentSymbol | vscode.SymbolInformation)[]): void => {
      for (const s of nodes) {
        if (FUNCTION_SYMBOL_KINDS.has(s.kind)) {
          const r = rangeOf(s);
          if (r) {
            ranges.push({ start: doc.offsetAt(r.start), end: doc.offsetAt(r.end) });
          }
        }
        const children = (s as vscode.DocumentSymbol).children;
        if (children && children.length > 0) {
          walk(children);
        }
      }
    };
    walk(symbols);
    return ranges;
  }

  dispose(): void {
    // WeakMaps GC with their documents; nothing to release explicitly.
  }
}
