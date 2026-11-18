/**
 * The impure classification layer — the only place that talks to VS Code's LSP
 * commands. It fetches the document's symbol tree + semantic tokens once per
 * document version, converts them to the offset-based shapes in classify.ts,
 * and delegates the actual classification to the pure functions there.
 *
 * Hybrid strategy (user decision 1): try the semantic-tokens provider first;
 * if it is absent or returns nothing, fall back to the pure heuristic scan. A
 * single file-wide fetch feeds every block visited in that version — navigating
 * an unedited file costs zero extra LSP calls, and concurrent classifies of one
 * version share one request. A fetch answered after the document moved on is
 * never cached, and its result carries the version its text belongs to, so the
 * decorator discards it. Lifecycle details: docs/runtime.md.
 */

import * as vscode from 'vscode';
import { flowText } from './html';
import {
  Classification,
  OffsetRange,
  DecodedToken,
  decodeSemanticTokens,
  tokensFitLegend,
  enclosingFnOf,
  outermostFnOf,
  classifyFromSemantic,
  classifyFromHeuristic,
  buildFileIndex,
  declScopesFor,
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
  topLevelExcludes,
  functionScopeOf,
} from './focus';
import { BlockNames, ScopeColoring, colorScope } from './scopecolor';
import { LexResult, lexFor } from './lex';
import { swiftStaticCalls } from './swift';
import { importUseNames, importUseSpans } from './imports';

/**
 * What the semantic-token provider gave for a version: `ok` (tokens), `empty`
 * (a provider answered with a legend but no usable tokens — a server still
 * loading) or `none` (no provider registered, so no legend).
 */
export type SemanticState = 'ok' | 'empty' | 'none';

interface LspBundle {
  version: number;
  /** Null once `fileIndex` is built: classification reads only the index. */
  tokens: DecodedToken[] | null;
  semantic: SemanticState;
  /** Rust: how this answer typed `Self` / `crate` / `super`. */
  paths?: PathKeywords;
  /** C family: the first answer for this version, or one that differs from the last; cpptools may add to it. */
  provisional?: boolean;
  fnRanges: OffsetRange[];
  /** File-wide analysis, built once per version and shared by every block. */
  fileIndex?: FileIndex;
  lineStarts: number[];
}

/**
 * What rust-analyzer's last answer typed `Self`, `crate` and `super` as: `keyword`
 * (`selfTypeKeyword` / `keyword`, a cargo workspace that has loaded) or `degraded`
 * (`struct` / `namespace`: a detached file, or a workspace still loading). See
 * docs/runtime.md#rust-path-keywords.
 */
export type PathKeywords = 'keyword' | 'degraded';

export const RUST_PATH_KEYWORDS: ReadonlySet<string> = new Set(['Self', 'crate', 'super']);
const KEYWORD_TYPES = new Set(['keyword', 'selfKeyword', 'selfTypeKeyword']);

/** The PathKeywords an answer shows, or undefined when it types none of the three. */
export function rustPathKeywords(tokens: readonly DecodedToken[]): PathKeywords | undefined {
  let seen: PathKeywords | undefined;
  for (const t of tokens) {
    if (RUST_PATH_KEYWORDS.has(t.name)) {
      if (!KEYWORD_TYPES.has(t.type)) return 'degraded';
      seen = 'keyword';
    }
  }
  return seen;
}

/**
 * Does an answer type a string literal, with a `string` token and no modifier?
 * lua-language-server 3.19.2 sends one over each literal only under
 * `Lua.semantic.keyword`; its LuaCATS strings carry `static`, `abstract` or
 * `defaultLibrary`. zls 0.17.0 sends one only under `semantic_tokens: full`.
 */
export function typesStringLiterals(data: ArrayLike<number>, tokenTypes: readonly string[]): boolean {
  const string = tokenTypes.indexOf('string');
  if (string < 0) {
    return false;
  }
  for (let i = 0; i + 4 < data.length; i += 5) {
    if (data[i + 3] === string && data[i + 4] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * What decoding `data` would tell about an answer without building the tokens:
 * whether any token lands on a line (`ok` vs `empty`), and with `rust`, its
 * `rustPathKeywords`.
 */
export function answerStateOf(
  data: ArrayLike<number>,
  tokenTypes: readonly string[],
  lineStarts: readonly number[],
  text: string,
  rust: boolean,
): { any: boolean; paths: PathKeywords | undefined } {
  let any = false;
  let paths: PathKeywords | undefined;
  let line = 0;
  let char = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    if (data[i] > 0) {
      line += data[i];
      char = data[i + 1];
    } else {
      char += data[i + 1];
    }
    const lineStart = lineStarts[line];
    if (lineStart === undefined) {
      continue;
    }
    any = true;
    if (!rust) {
      break;
    }
    const offset = lineStart + char;
    // The decoded name is the text the token covers, cut short at the end of the text.
    const length = Math.min(offset + data[i + 2], text.length) - offset;
    if (length !== 4 && length !== 5) {
      continue;
    }
    if (RUST_PATH_KEYWORDS.has(text.slice(offset, offset + length))) {
      if (!KEYWORD_TYPES.has(tokenTypes[data[i + 3]] ?? '')) {
        paths = 'degraded';
        break;
      }
      paths = 'keyword';
    }
  }
  return { any, paths };
}

const yieldToEvents = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The `import * as` names with a token at any of their restore spans, sorted and joined by `,`. */
export function typedNamespaceKey(lx: LexResult, tokens: readonly DecodedToken[]): string {
  const spans = importUseSpans(lx);
  if (spans.length === 0) return '';
  const names = importUseNames(lx);
  const typed = new Set<string>();
  let t = 0;
  spans.forEach((s, i) => {
    while (t < tokens.length && tokens[t].offset < s.start) t++;
    if (t < tokens.length && tokens[t].offset === s.start) typed.add(names[i]);
  });
  return [...typed].sort().join(',');
}

/** The length and an FNV-1a hash of a token answer's data. */
function dataKey(data: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h = Math.imul(h ^ data[i], 0x01000193) >>> 0;
  }
  return `${data.length}:${h}`;
}

/** A request the provider rejected as cancelled (`vscode.CancellationError`, `Canceled` across the API command). */
function isCancellation(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | undefined;
  return err?.name === 'Canceled' || err?.message === 'Canceled';
}

/** The backoff for re-asking a server that answered nothing, in ms; null once spent. */
export function coldRetryDelay(attempts: number, schedule: readonly number[]): number | null {
  return attempts < schedule.length ? schedule[attempts] : null;
}

const FUNCTION_SYMBOL_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
]);

const sortedBlocks = new WeakMap<BraceBlock[], { count: number; sorted: BraceBlock[] }>();

function blocksByOpen(blocks: BraceBlock[]): BraceBlock[] {
  const hit = sortedBlocks.get(blocks);
  if (hit && hit.count === blocks.length) {
    return hit.sorted;
  }
  const sorted = [...blocks].sort((a, b) => a.openOffset - b.openOffset);
  sortedBlocks.set(blocks, { count: blocks.length, sorted });
  return sorted;
}

export class Classifier implements vscode.Disposable {
  private cache = new WeakMap<vscode.TextDocument, LspBundle>();
  /** The one fetch per document version that every concurrent classify awaits. */
  private inflight = new WeakMap<vscode.TextDocument, { version: number; promise: Promise<LspBundle> }>();
  /** Retries spent per document, reset by the first answer with tokens that is not degraded. */
  private coldAttempts = new WeakMap<vscode.TextDocument, number>();
  /** Retry delays after an empty or degraded answer: about 30 s in all, then that answer is final. */
  retrySchedule: readonly number[] = [1000, 2000, 4000, 8000, 15000];
  /**
   * Waits before re-asking a provider that rejected the request as cancelled: superseded,
   * not answered. cpptools keeps one request pending per file (docs/c-jvm.md#server-shapes).
   * Still cancelled after these, the answer reads as `empty`.
   */
  cancelRetrySchedule: readonly number[] = [1500, 3000, 6000];
  /**
   * Waits before asking again about a provisional C-family answer, until two in a row
   * match: cpptools adds IntelliSense batches to a version's answer within about a second.
   */
  confirmSchedule: readonly number[] = [250, 500, 500, 1000, 1000, 2000];
  /**
   * Languages where a document spent the whole schedule with no provider
   * registered. Their later documents are not retried; any answer with a legend
   * takes the language off the list.
   */
  private providerless = new Set<string>();
  /**
   * Documents a provider has answered with tokens. Edits and later empty answers
   * keep the entry (the provider is still registered); an answer with no provider
   * at all drops it.
   */
  private answered = new WeakSet<vscode.TextDocument>();
  private pathKeywords = new WeakMap<vscode.TextDocument, PathKeywords>();
  /** Lua and Zig documents whose last answer with tokens typed string literals (`typesStringLiterals`). */
  private stringLiterals = new WeakSet<vscode.TextDocument>();
  /** JS / TS: the namespace-import names whose uses the last answer with tokens typed, sorted and joined. */
  private typedNamespaces = new WeakMap<vscode.TextDocument, string>();
  /** Swift: the named static calls the last answer with tokens typed as the standard library's operators, for its version. */
  private staticCalls = new WeakMap<vscode.TextDocument, { version: number; ranges: OffsetRange[]; key: string }>();
  /** The newest version whose answer set `answered`, `pathKeywords` and `stringLiterals`: a slower answer for older text does not. */
  private answeredVersion = new WeakMap<vscode.TextDocument, number>();
  /** C family: the last answer's version and data, to tell a settled answer from one still growing. */
  private lastAnswer = new WeakMap<vscode.TextDocument, { version: number; key: string }>();
  /** Confirming requests since the answer in `lastAnswer` last changed (`n`), and for its version (`total`). */
  private confirms = new WeakMap<vscode.TextDocument, { n: number; total: number }>();

  /** Does a semantic provider colour this document? Band-1 restores defer to it. */
  semanticOk(doc: vscode.TextDocument): boolean {
    return this.answered.has(doc);
  }

  /** How the last Rust answer typed `Self` / `crate` / `super`; undefined before one has. */
  pathKeywordsOf(doc: vscode.TextDocument): PathKeywords | undefined {
    return this.pathKeywords.get(doc);
  }

  /** JS / TS: the `import * as` names the last answer typed at a use; the import restore leaves those to it. */
  typedNamespacesOf(doc: vscode.TextDocument): string {
    return this.typedNamespaces.get(doc) ?? '';
  }

  /** Swift: the named static calls the last answer typed `method.static.defaultLibrary`, and the version it answered. */
  swiftStaticCallsOf(doc: vscode.TextDocument): { version: number; ranges: OffsetRange[]; key: string } | undefined {
    return this.staticCalls.get(doc);
  }

  /** Did the last Lua or Zig answer with tokens cover its string literals with `string` tokens? */
  typesStrings(doc: vscode.TextDocument): boolean {
    return this.stringLiterals.has(doc);
  }

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
     * here doubled the cost of every classify for nothing. `version` is the
     * version `text` belongs to; without it the version is read before any await.
     */
    cached?: { text: string; blocks: BraceBlock[]; version?: number },
  ): Promise<{ focused: Classification; coloring: ScopeColoring; semantic: SemanticState } | null> {
    const version = cached?.version ?? doc.version;
    const text = cached?.text ?? flowText(doc.getText(), doc.languageId);
    const allBlocks = cached?.blocks ?? scanBlocks(text, doc.languageId);
    const bundle = await this.bundleFor(doc, text, version, allBlocks);
    if (token.isCancellationRequested || doc.version !== version) {
      return null;
    }
    if (!bundle.fileIndex) {
      // The heuristic builds a whole-file base next; a queued keystroke would outdate it.
      await yieldToEvents();
      if (token.isCancellationRequested || doc.version !== version) {
        return null;
      }
    }

    const colorScopeFn = outermostFnOf(bundle.fnRanges, block.openOffset);

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

    // Sorted by open offset so each block's nested sub-blocks are a contiguous
    // forward run — avoids an O(blocks) filter per block (O(n²) per scope) inside
    // classifyBlock. Once per block list, not per classify.
    const sorted = blocksByOpen(allBlocks);

    for (const b of scopeBlocks) {
      const c = this.classifyBlock(text, b, sorted, bundle, version, doc.languageId, true, allBlocks);
      perBlock.push({ focusKey: c.focusKey, byName: c.byName, isTopLevel: isTopLevelBlock(b) });
      if (c.focusKey === focusKey) {
        focused = c;
      }
    }
    if (!focused) {
      // The focused block wasn't in the scope set (top-level edge case) — classify
      // it directly so the caller always gets its classification.
      focused = this.classifyBlock(text, block, allBlocks, bundle, version, doc.languageId);
      perBlock.push({
        focusKey: focused.focusKey,
        byName: focused.byName,
        isTopLevel: isTopLevelBlock(block),
      });
    }

    const coloring = colorScope(perBlock, paletteSize);
    return { focused, coloring, semantic: bundle.semantic };
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
    languageId: string,
    /** True when allBlocks is pre-sorted by openOffset (lets sub-block collection early-exit). */
    sortedByOpen = false,
    /** The document's block list as scanned; the top-level excludes are cached per list. */
    scanned: BraceBlock[] = allBlocks,
  ): Classification {
    // Two ranges, two jobs:
    //   blockRange (lexing/visibility/traces) — always header-inclusive, so a
    //     block's own header bindings (loop vars AND closure params) are seen
    //     inside their own scope.
    //   declRegion (classification) — header-inclusive only for control flow, so
    //     function params stay fn-local instead of block-local.
    const blockRange: OffsetRange = lexRegionFor(text, block, languageId);
    const declRegion: OffsetRange = declRegionFor(text, block, languageId);
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
          subBlocks.push(scopeRegionFor(text, allBlocks[i], languageId));
        }
      }
    } else {
      for (const b of allBlocks) {
        if (b.openOffset > block.openOffset && b.closeOffset < block.closeOffset) {
          subBlocks.push(scopeRegionFor(text, b, languageId));
        }
      }
    }

    // For the synthetic top-level scope (whole file) carve out the OUTERMOST
    // brace-blocks, so function bodies are not part of "top level". Without this
    // every local in every function counts as used at top level and leaks into
    // the view — and a top-level `const X = { ... }` reads as nested because its
    // own initialiser braces enclose the declaration.
    const excludeRanges: OffsetRange[] = isTopLevelBlock(block) ? topLevelExcludes(text, scanned, languageId) : [];

    const caretOffset = block.openOffset;
    const enclosingFn = enclosingFnOf(bundle.fnRanges, caretOffset);
    // Colour scope = the outermost function containing the caret, so hues stay
    // stable across a top-level function and all its nested closures.
    const colorScopeFn = outermostFnOf(bundle.fnRanges, caretOffset);

    if (bundle.fileIndex || (bundle.tokens && bundle.tokens.length > 0)) {
      return classifyFromSemantic(
        text,
        blockRange,
        enclosingFn,
        bundle.fnRanges,
        bundle.tokens ?? [],
        docVersion,
        focusKey,
        colorScopeFn,
        declRegion,
        subBlocks,
        bundle.fileIndex,
        excludeRanges,
        declScopesFor(text, scanned, bundle.fnRanges, languageId),
      );
    }

    // No semantic tokens → heuristic. A cold server is re-asked on the decorator's
    // retry schedule; a language with no provider just uses this.
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
      languageId,
      excludeRanges,
      allBlocks,
    );
  }

  /**
   * How long to wait before re-asking the server about `doc`, or null when its
   * last answer had tokens, the retries are spent, or its language is known to
   * have no provider. A Rust answer with degraded path keywords is not final
   * either: a cargo workspace still loading sends it (docs/runtime.md#cold-servers).
   * Counted per document, not per version, so a language with no provider, or a
   * detached Rust file, stops costing a second fetch per edit once the schedule
   * runs out.
   */
  coldRetryDelay(doc: vscode.TextDocument): number | null {
    const b = this.cache.get(doc);
    if (b?.semantic === 'ok' && b.provisional) {
      const c = this.confirms.get(doc) ?? { n: 0, total: 0 };
      return c.n < this.confirmSchedule.length && c.total < 2 * this.confirmSchedule.length ? this.confirmSchedule[c.n] : null;
    }
    const settled = b?.semantic === 'ok' && b.paths !== 'degraded';
    if (b && (settled || (b.semantic === 'none' && this.providerless.has(doc.languageId)))) {
      return null;
    }
    return coldRetryDelay(this.coldAttempts.get(doc) ?? 0, this.retrySchedule);
  }

  /** The cached answer is Rust's degraded one, or a C-family one not yet confirmed, and retries remain to ask again. */
  awaitsLoad(doc: vscode.TextDocument): boolean {
    const b = this.cache.get(doc);
    return b?.semantic === 'ok' && (b.paths === 'degraded' || b.provisional === true) && this.coldRetryDelay(doc) !== null;
  }

  /** Spend one retry and drop the cached answer, so the next classify asks again. */
  noteColdRetry(doc: vscode.TextDocument): void {
    if (this.cache.get(doc)?.provisional) {
      const c = this.confirms.get(doc) ?? { n: 0, total: 0 };
      this.confirms.set(doc, { n: c.n + 1, total: c.total + 1 });
    } else {
      this.coldAttempts.set(doc, (this.coldAttempts.get(doc) ?? 0) + 1);
    }
    this.invalidate(doc);
  }

  /** Invalidate the cache for a document (forces a fresh fetch next classify). */
  invalidate(doc: vscode.TextDocument): void {
    this.cache.delete(doc);
  }

  /**
   * The bundle for `version`. Fetched at most once per version: callers that
   * arrive while a fetch is in flight share it, and a caller's cancellation never
   * discards it. When the document has moved past `version` by the time the
   * server answers, the bundle is returned uncached, still stamped `version`.
   */
  private bundleFor(
    doc: vscode.TextDocument,
    text: string,
    version: number,
    blocks: BraceBlock[],
  ): Promise<LspBundle> {
    const cached = this.cache.get(doc);
    if (cached && cached.version === version) {
      return Promise.resolve(cached);
    }
    const pending = this.inflight.get(doc);
    if (pending && pending.version === version) {
      return pending.promise;
    }
    const promise = this.fetchBundle(doc, text, version, blocks);
    this.inflight.set(doc, { version, promise });
    const clear = (): void => {
      if (this.inflight.get(doc)?.promise === promise) {
        this.inflight.delete(doc);
      }
    };
    promise.then(clear, clear);
    return promise;
  }

  private async fetchBundle(
    doc: vscode.TextDocument,
    text: string,
    version: number,
    blocks: BraceBlock[],
  ): Promise<LspBundle> {
    const lineStarts = lexFor(text, doc.languageId).lineStarts;
    const [symbols, fetched] = await Promise.all([
      this.fetchSymbols(doc.uri),
      this.fetchSemanticTokens(doc, lineStarts, text, version),
    ]);
    const { tokens, semantic, paths, strings, key } = fetched;
    // cpptools answers a version with its first IntelliSense batch and adds later
    // ones without a request (docs/c-jvm.md#server-shapes): an answer counts once a
    // second one for the same version matches it.
    let provisional: boolean | undefined;
    if (key !== undefined) {
      const last = this.lastAnswer.get(doc);
      provisional = !(last && last.version === version && last.key === key);
      // A new version starts the count; a changed answer for the same one (a reopen) restarts the waits.
      if (last?.version !== version) this.confirms.delete(doc);
      else if (provisional) this.confirms.set(doc, { n: 0, total: this.confirms.get(doc)?.total ?? 0 });
      this.lastAnswer.set(doc, { version, key });
    }
    if (version >= (this.answeredVersion.get(doc) ?? 0)) {
      this.answeredVersion.set(doc, version);
      if (semantic === 'ok') {
        this.answered.add(doc);
        const lx = lexFor(text, doc.languageId);
        if (lx.syntax.family === 'js') this.typedNamespaces.set(doc, typedNamespaceKey(lx, tokens ?? []));
        if (lx.syntax.family === 'swift') {
          const ranges = swiftStaticCalls(text, tokens ?? []);
          this.staticCalls.set(doc, { version, ranges, key: `${version}:${ranges.map((r) => r.start).join(',')}` });
        }
        if (strings) {
          this.stringLiterals.add(doc);
        } else {
          this.stringLiterals.delete(doc);
        }
      } else if (semantic === 'none' && doc.version === version) {
        this.answered.delete(doc);
        this.typedNamespaces.delete(doc);
        this.staticCalls.delete(doc);
        this.pathKeywords.delete(doc);
        this.stringLiterals.delete(doc);
      }
      if (paths) {
        this.pathKeywords.set(doc, paths);
      }
    }
    if (semantic !== 'none') {
      this.providerless.delete(doc.languageId);
    } else if ((this.coldAttempts.get(doc) ?? 0) >= this.retrySchedule.length) {
      this.providerless.add(doc.languageId);
    }
    // Let a keystroke queued behind the answer in before the whole-file work it would outdate.
    await yieldToEvents();
    if (doc.version !== version) {
      // Symbol ranges resolve through the live document, so they would be wrong too.
      return { version, tokens, semantic, paths, fnRanges: [], lineStarts };
    }

    // Defensive: an unexpected symbol shape must degrade to empty fnRanges (→
    // everything reads as out-of-fn), never reject the whole classify.
    let fnRanges: OffsetRange[];
    try {
      fnRanges = this.collectFunctionRanges(symbols, doc);
    } catch {
      fnRanges = [];
    }
    // Document symbols cover named functions only. Anonymous ones (Go func
    // literals, Rust closures, JS callbacks, Python lambdas) come from the block
    // scan; a named function also gets a tighter range from its parameters.
    // docs/classification-rules.md#function-ranges.
    const seen = new Set(fnRanges.map((r) => `${r.start}:${r.end}`));
    for (const b of blocks) {
      const r = functionScopeOf(text, b, doc.languageId);
      if (r && !seen.has(`${r.start}:${r.end}`)) {
        seen.add(`${r.start}:${r.end}`);
        fnRanges.push(r);
      }
    }
    // `enclosingFnOf`/`outermostFnOf` search for the tightest and widest containing
    // range, so order is not load-bearing — but document order keeps a debug dump
    // readable and matches what the symbol walk already produces.
    fnRanges.sort((a, b) => a.start - b.start || b.end - a.end);
    // Build the file-wide index once per version, so classifying an N-block
    // scope costs one file pass + N block passes (not N file passes).
    const fileIndex = tokens && tokens.length > 0 ? buildFileIndex(text, tokens, fnRanges, doc.languageId) : undefined;
    const bundle: LspBundle = { version, tokens: fileIndex ? null : tokens, semantic, paths, provisional, fnRanges, lineStarts, fileIndex };
    this.cache.set(doc, bundle);
    if (semantic === 'ok' && paths !== 'degraded') {
      this.coldAttempts.delete(doc);
    }
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
    version: number,
  ): Promise<{ tokens: DecodedToken[] | null; semantic: SemanticState; paths?: PathKeywords; strings?: boolean; key?: string }> {
    const ask = async <T>(cmd: string): Promise<T | undefined> => {
      try {
        return await vscode.commands.executeCommand<T>(cmd, doc.uri);
      } catch {
        return undefined;
      }
    };
    const askTokens = async (): Promise<vscode.SemanticTokens | undefined> => {
      for (let i = 0; ; i++) {
        try {
          return await vscode.commands.executeCommand<vscode.SemanticTokens>('vscode.provideDocumentSemanticTokens', doc.uri);
        } catch (e) {
          if (!isCancellation(e) || i >= this.cancelRetrySchedule.length || doc.version !== version) {
            return undefined;
          }
          await new Promise((resolve) => setTimeout(resolve, this.cancelRetrySchedule[i]));
          if (doc.version !== version) return undefined;
        }
      }
    };
    const [legend, tokens] = await Promise.all([
      ask<vscode.SemanticTokensLegend>('vscode.provideDocumentSemanticTokensLegend'),
      askTokens(),
    ]);
    if (!legend) {
      return { tokens: null, semantic: 'none' };
    }
    const read = tokens && sourcekitClangLegend(legend, tokens.data) ? SOURCEKIT_LEGEND : legend;
    if (!tokens || !tokensFitLegend(tokens.data, read.tokenTypes.length, read.tokenModifiers.length)) {
      return { tokens: null, semantic: 'empty' };
    }
    const rust = doc.languageId === 'rust';
    const strings = (doc.languageId === 'lua' || doc.languageId === 'zig') && typesStringLiterals(tokens.data, read.tokenTypes);
    const key = lexFor(text, doc.languageId).syntax.family === 'c' ? dataKey(tokens.data) : undefined;
    if (doc.version !== version) {
      // Tokens for old text are never classified; only the answer's state is read.
      const { any, paths } = answerStateOf(tokens.data, read.tokenTypes, lineStarts, text, rust);
      return { tokens: null, semantic: any ? 'ok' : 'empty', paths, strings };
    }
    const decoded = decodeSemanticTokens(tokens.data, read.tokenTypes, read.tokenModifiers, lineStarts, text);
    const semantic = decoded.length > 0 ? 'ok' : 'empty';
    return { tokens: decoded, semantic, paths: rust ? rustPathKeywords(decoded) : undefined, strings, key: semantic === 'ok' ? key : undefined };
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

/**
 * sourcekit-lsp's own legend (6.4, Command Line Tools). For C-family documents it registers
 * clangd's legend but encodes the tokens in this one (docs/c-jvm.md#objective-c).
 */
export const SOURCEKIT_LEGEND = {
  tokenTypes: ['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property',
    'enumMember', 'event', 'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator',
    'decorator', 'bracket', 'label', 'concept', 'unknown', 'identifier'],
  tokenModifiers: ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification',
    'documentation', 'defaultLibrary', 'deduced', 'virtual', 'dependentName', 'usedAsMutableReference', 'usedAsMutablePointer',
    'constructorOrDestructor', 'userDefined', 'functionScope', 'classScope', 'fileScope', 'globalScope', 'parameterLabel'],
};
const CLANGD_TYPES = 'variable,variable,parameter,function,method,function,property,variable,class,interface,enum,enumMember,type,type,unknown,namespace';

/**
 * clangd's legend over data in sourcekit-lsp's: a `parameter` with `defaultLibrary`, which
 * clangd never sends and sourcekit-lsp's `class` index (2) with it is (`NSString`).
 */
export function sourcekitClangLegend(legend: { tokenTypes: string[]; tokenModifiers: string[] }, data: ArrayLike<number>): boolean {
  if (legend.tokenTypes.slice(0, 16).join(',') !== CLANGD_TYPES || legend.tokenModifiers[9] !== 'defaultLibrary') return false;
  for (let i = 3; i < data.length; i += 5) if (data[i] === 2 && (data[i + 1] & (1 << 9)) !== 0) return true;
  return false;
}
