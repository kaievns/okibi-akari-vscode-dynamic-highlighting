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
  buildFileIndex,
  FileIndex,
} from './classify';
import {
  BraceBlock,
  focusKeyOf,
  declRegionFor,
  lexRegionFor,
  scopeRegionFor,
  scanBlocks,
  isTopLevelBlock,
} from './focus';
import { BlockNames, ScopeColoring, colorScope } from './scopecolor';

interface LspBundle {
  version: number;
  tokens: DecodedToken[] | null; // null = no semantic provider
  fnRanges: OffsetRange[];
  /** File-wide analysis, built once per version and shared by every block. */
  fileIndex?: FileIndex;
  lineStarts: number[];
}

/**
 * Does this block header declare a function (so its parameter list is not
 * top-level code)? A `const X = { … }` object literal is also a depth-0 block,
 * but its "header" holds the declaration name we DO want at top level.
 */
function isFunctionHeaderText(header: string): boolean {
  return /\b(func|function)\b|=>\s*$|\)\s*(:[^)]*)?\s*$/.test(header);
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
   * Classify the focused block AND colour its whole scope in one pass.
   *
   * The colouring needs every block in the colour scope (see scopecolor.ts:
   * co-visibility graph), so we classify each of them from the same cached LSP
   * bundle — no extra server round-trips — and greedy-colour the result. The
   * output is deterministic: same document → same colours, whatever order the
   * user navigated.
   */
  async classifyScope(
    doc: vscode.TextDocument,
    block: BraceBlock,
    paletteSize: number,
    token: vscode.CancellationToken,
    /**
     * Text + blocks the caller already has for this document version. Both are
     * expensive to recompute (`getText()` rebuilds the whole string; the block scan
     * is a full lex), and the decorator caches them per version — so recomputing
     * here doubled the cost of every classify for nothing.
     */
    cached?: { text: string; blocks: BraceBlock[] },
  ): Promise<{ focused: Classification; coloring: ScopeColoring } | null> {
    const text = cached?.text ?? doc.getText();
    const bundle = await this.bundleFor(doc, text, token);
    if (token.isCancellationRequested) {
      return null;
    }

    const colorScopeFn = outermostFnOf(bundle.fnRanges, block.openOffset);
    const allBlocks = cached?.blocks ?? scanBlocks(text, doc.languageId);

    // Every block whose focus would share this colour scope. At module top level
    // (no enclosing fn) the scope is just the focused block itself.
    const scopeBlocks = colorScopeFn
      ? allBlocks.filter(
          (b) => b.openOffset >= colorScopeFn.start && b.closeOffset < colorScopeFn.end,
        )
      : [block];

    const focusKey = focusKeyOf(block);
    const perBlock: BlockNames[] = [];
    let focused: Classification | undefined;

    // Sort once by open offset so each block's nested sub-blocks are a
    // contiguous forward run — avoids an O(blocks) filter per block (O(n²) per
    // scope) inside classifyBlock.
    const sorted = [...allBlocks].sort((a, b) => a.openOffset - b.openOffset);

    for (const b of scopeBlocks) {
      const c = this.classifyBlock(text, b, sorted, bundle, doc.version, true);
      perBlock.push({ focusKey: c.focusKey, byName: c.byName, isTopLevel: isTopLevelBlock(b) });
      if (c.focusKey === focusKey) {
        focused = c;
      }
    }
    if (!focused) {
      // The focused block wasn't in the scope set (top-level edge case) — classify
      // it directly so the caller always gets its classification.
      focused = this.classifyBlock(text, block, allBlocks, bundle, doc.version);
      perBlock.push({
        focusKey: focused.focusKey,
        byName: focused.byName,
        isTopLevel: isTopLevelBlock(block),
      });
    }

    const coloring = colorScope(perBlock, paletteSize);
    return { focused, coloring };
  }

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
    const bundle = await this.bundleFor(doc, text, token);
    if (token.isCancellationRequested) {
      return null;
    }
    return this.classifyBlock(text, block, scanBlocks(text, doc.languageId), bundle, doc.version);
  }

  /**
   * Classify one block against an already-fetched LSP bundle. Synchronous, so a
   * whole colour scope can be classified in a single pass with no extra server
   * calls.
   *
   * The block range used for BOTH lexing (which names are "in the block") and
   * trace-clipping is header-inclusive for control-flow blocks — so a loop/if
   * header binding (`for _, c := range xs {`) and the identifiers on that header
   * line tint, not just the body. Function headers stay body-only (params are
   * fn-local, traced across the whole function anyway). See focus.ts.
   */
  private classifyBlock(
    text: string,
    block: BraceBlock,
    allBlocks: BraceBlock[],
    bundle: LspBundle,
    docVersion: number,
    /** True when allBlocks is pre-sorted by openOffset (lets sub-block collection early-exit). */
    sortedByOpen = false,
  ): Classification {
    // Two ranges, two jobs:
    //   blockRange (lexing/visibility/traces) — always header-inclusive, so a
    //     block's own header bindings (loop vars AND closure params) are seen
    //     inside their own scope.
    //   declRegion (classification) — header-inclusive only for control flow, so
    //     function params stay fn-local instead of block-local.
    const blockRange: OffsetRange = lexRegionFor(text, block);
    const declRegion: OffsetRange = declRegionFor(text, block);
    const focusKey = focusKeyOf(block);

    // Brace-blocks nested strictly inside this block — a local declared in one of
    // them belongs to a child scope the caret sits above, so it ranks lower in
    // the attention budget.
    //
    // scopeRegionFor, NOT declRegionFor: a nested block owns its header bindings
    // (a closure's params, a loop's iteration vars). declRegionFor keeps FUNCTION
    // headers body-only — correct for block-vs-fn classification, wrong here,
    // because it left `sort.Slice(names, func(i, j int) …)`'s params outside every
    // sub-scope, so they read as the OUTER block's own locals at proximity 0.
    const subBlocks: OffsetRange[] = [];
    if (sortedByOpen) {
      // Sorted: nested blocks form a forward run bounded by this block's close.
      // Skip ahead to the first candidate, then stop at the first block that
      // starts after we close — no full-array scan.
      let i = 0;
      while (i < allBlocks.length && allBlocks[i].openOffset <= block.openOffset) {
        i++;
      }
      for (; i < allBlocks.length && allBlocks[i].openOffset < block.closeOffset; i++) {
        if (allBlocks[i].closeOffset < block.closeOffset) {
          subBlocks.push(scopeRegionFor(text, allBlocks[i]));
        }
      }
    } else {
      for (const b of allBlocks) {
        if (b.openOffset > block.openOffset && b.closeOffset < block.closeOffset) {
          subBlocks.push(scopeRegionFor(text, b));
        }
      }
    }

    // For the synthetic top-level scope (whole file) carve out the OUTERMOST
    // brace-blocks, so function bodies are not part of "top level". Without this
    // every local in every function counts as used at top level and leaks into
    // the view — and a top-level `const X = { ... }` reads as nested because its
    // own initialiser braces enclose the declaration.
    const excludeRanges: OffsetRange[] = isTopLevelBlock(block)
      ? [
          // depth-0 block bodies (function/type bodies)
          ...allBlocks
            .filter((b) => b.depth === 0)
            .map((b) => ({ start: b.openOffset, end: b.closeOffset + 1 })),
          // and FUNCTION signatures, which sit OUTSIDE the braces — otherwise a
          // parameter list reads as top-level code. Restricted to headers that
          // actually declare a function: a `const X = {` object literal is also a
          // depth-0 block, and excluding its "signature" would hide the very
          // declaration we want (X itself).
          ...allBlocks
            .filter((b) => b.depth === 0 && isFunctionHeaderText(text.slice(b.headerStart, b.openOffset)))
            .map((b) => ({ start: b.headerStart, end: b.openOffset })),
        ]
      : [];

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
        docVersion,
        focusKey,
        colorScopeFn,
        declRegion,
        subBlocks,
        bundle.fileIndex,
        excludeRanges,
      );
    }

    // No semantic tokens → heuristic. (Cold-server empty result is handled by the
    // caller's one-shot retry; a genuinely brace-only language just uses this.)
    return classifyFromHeuristic(
      text,
      blockRange,
      enclosingFn,
      bundle.fnRanges,
      docVersion,
      focusKey,
      colorScopeFn,
      declRegion,
      subBlocks,
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
    // A LAMBDA IS NOT A SYMBOL. `executeDocumentSymbolProvider` reports functions,
    // methods and constructors — a lambda has no name, so no server reports one, and
    // `fnRanges` had a hole exactly where a lambda's parameters live.
    // `enclosingFnOf` then resolved a caret inside the lambda to the SURROUNDING
    // function, so `acc`/`item` were classified against the wrong scope and traced
    // across the whole enclosing body. The block scanner already located every
    // lambda, so the ranges come from there rather than from a second scanner.
    for (const b of scanBlocks(text, doc.languageId)) {
      const isLambda = b.headerStart === b.openOffset
        && /^\s*lambda\b/.test(text.slice(b.openOffset, b.openOffset + 12));
      if (isLambda) {
        fnRanges.push({ start: b.openOffset, end: b.closeOffset + 1 });
      }
    }
    // `enclosingFnOf`/`outermostFnOf` search for the tightest and widest containing
    // range, so order is not load-bearing — but document order keeps a debug dump
    // readable and matches what the symbol walk already produces.
    fnRanges.sort((a, b) => a.start - b.start || b.end - a.end);
    // Build the file-wide index once per version, so classifying an N-block
    // scope costs one file pass + N block passes (not N file passes).
    const fileIndex = tokens && tokens.length > 0 ? buildFileIndex(text, tokens, fnRanges) : undefined;
    const bundle: LspBundle = { version: doc.version, tokens, fnRanges, lineStarts, fileIndex };
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
