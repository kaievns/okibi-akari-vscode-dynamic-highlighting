/**
 * Band-2 classification — spec §5.4 and the "how far you must look to find
 * where a name is bound" rule.
 *
 *   block-local — declared inside the focused block.
 *   fn-local    — declared in the enclosing function (incl. params) but outside
 *                 the block: "borrowed in". Rendered --id-*, normal weight.
 *   out-of-fn   — module globals, captures, or names with no visible
 *                 declaration. Rendered --idg-*, bold.
 *   self        — this / self / @-prefixed. Gold slot 2, never a variable.
 *
 * Two layers, sharply separated so the hot logic is testable without a VS Code
 * host:
 *   - PURE core (this file's exported functions): given already-fetched data
 *     (decoded semantic tokens, function ranges, text, block), produce a
 *     Classification. No vscode imports, all offset-based.
 *   - IMPURE Classifier (classify-lsp.ts): fetches symbols + semantic tokens via
 *     the LSP commands, converts to the offset structures, and delegates here.
 *
 * The hybrid strategy (user decision 1): the impure layer tries LSP first and
 * falls back to a heuristic lexical scan; both feed the same pure classifier
 * shapes. Misclassification of capture-vs-global affects only trace WIDTH, never
 * colour correctness (spec-sanctioned approximation to avoid per-name
 * definition-provider round trips).
 */

import { lexIdentifiers } from './focus';

export type Cls = 'block' | 'fn' | 'out' | 'self';
export type ClassSource = 'lsp' | 'heuristic' | 'mixed';

export interface OffsetRange {
  start: number;
  end: number;
}

/** A semantic token after decoding + legend resolution, offset-based. */
export interface DecodedToken {
  name: string;
  offset: number;
  length: number;
  /** Resolved token type from the legend, e.g. "variable", "parameter". */
  type: string;
  /** Resolved modifier names, e.g. ["declaration", "readonly"]. */
  modifiers: string[];
}

export interface NameInfo {
  cls: Cls;
  /** Occurrences of this name INSIDE the focused block. */
  freqInBlock: number;
  /** Absolute offset of the name's first occurrence anywhere in the file (stability anchor). */
  firstFileOffset: number;
  /** Absolute offset of the name's first occurrence inside the block (assignment ordering). */
  firstBlockOffset: number;
  /** out-of-fn only: a capture (home-fn trace) vs a true global (file-wide trace). */
  isCapture: boolean;
  /** For a capture, the home function range its declaration sits in. */
  homeFn?: OffsetRange;
  /**
   * Attention proximity — how directly this name belongs to the FOCUSED block,
   * used to prioritise hue slots when a block has more locals than hues (the
   * deepest/closest data wins, per the attention-priority principle):
   *   0 — declared directly in the focused block (its own local)
   *   1 — borrowed in: declared in an enclosing scope (fn-local / capture)
   *   2 — declared in a NESTED sub-block the caret sits above (belongs to a
   *       child scope you're not inside — lowest priority)
   */
  proximity: 0 | 1 | 2;
}

export interface Classification {
  docVersion: number;
  focusKey: string;
  /** Only names USED in the focused block that resolved to a class. */
  byName: Map<string, NameInfo>;
  /** File-wide occurrence ranges per name (feeds both classification and traces). */
  occurrences: Map<string, OffsetRange[]>;
  /**
   * Every true global (out-of-fn, non-capture) in the file, ordered by first
   * appearance. Lets the decorator seed the colour ledger deterministically so a
   * global's hue is fixed by FILE order, not the order blocks happen to be
   * visited (spec stability rule). Block-independent by construction.
   */
  fileGlobalsInOrder: string[];
  /**
   * Local data identities (fn-locals, block-locals, captures — everything that
   * is neither a true global nor self) used ANYWHERE in the enclosing function,
   * ordered by first appearance IN THE FUNCTION. This is what makes a local's
   * hue stable across every sub-block of its function: colour is assigned by
   * function-order, not per focused block, so `cfg` keeps one hue whether the
   * caret is in the function body, an `if`, or a `for`. Function-scoped and
   * block-independent by construction.
   */
  fnLocalsInOrder: string[];
  /** True globals that appear in the enclosing function (their hues are skipped when assigning locals). */
  fnGlobals: string[];
  /**
   * The colour scope — the OUTERMOST function containing the caret. Its span is
   * the key for the local colour ledger, so a variable's hue is stable across
   * the whole top-level function and every nested closure.
   */
  colorScopeFn: OffsetRange | undefined;
  /** The INNERMOST enclosing function, used for block/fn/out classification and traces. */
  enclosingFn: OffsetRange | undefined;
  source: ClassSource;
}

/** this / self are always the gold self-slot; @-prefixed handled by the caller. */
const SELF_NAMES = new Set(['this', 'self']);

/**
 * File-wide analysis, computed ONCE per document version and shared by every
 * block classified in that version.
 *
 * Without this, each per-block classify redid the whole-file token scan, the
 * whole-file self-occurrence lex, and the file-globals computation — so
 * classifying an N-block scope was N× the file-wide work, and cost grew with
 * total file size even though the scope size was fixed. Hoisting it makes the
 * per-block pass depend only on the block, and the scope pass linear in blocks.
 */
export interface FileIndex {
  /** Tintable occurrence ranges per name, file-wide (insertion order = first appearance). */
  occurrences: Map<string, OffsetRange[]>;
  /** Declaration offsets per name (shorthand reads excluded — they declare a property, not a binding). */
  declOffsets: Map<string, number[]>;
  /** First file offset per name. */
  firstFileOffset: Map<string, number>;
  /** Names whose every declaration is outside any function → true globals, file order. */
  fileGlobalsInOrder: string[];
}

/**
 * Build the file-wide index from decoded semantic tokens. Pure; cache by
 * document version.
 */
export function buildFileIndex(
  text: string,
  tokens: DecodedToken[],
  fnRanges: OffsetRange[],
): FileIndex {
  const occurrences = new Map<string, OffsetRange[]>();
  const declOffsets = new Map<string, number[]>();
  const firstFileOffset = new Map<string, number>();

  for (const tok of tokens) {
    // Data identities are variable/parameter. `property` is normally band-1, but
    // object-shorthand (`{ name }`) is a real read of a binding and tints like it.
    const tintable =
      TINTABLE_TYPES.has(tok.type) ||
      (tok.type === 'property' && isShorthandPropertyRead(text, tok.offset, tok.length, tok.modifiers));
    if (!tintable) {
      continue;
    }
    // Builtins (console, Math…) are library surface, not this file's data.
    if (tok.modifiers.some((m) => NON_DATA_MODIFIERS.has(m))) {
      continue;
    }
    const range: OffsetRange = { start: tok.offset, end: tok.offset + tok.length };
    const list = occurrences.get(tok.name);
    if (list) {
      list.push(range);
    } else {
      occurrences.set(tok.name, [range]);
      firstFileOffset.set(tok.name, tok.offset);
    }
    // A shorthand-read (`{ name }`) carries a `declaration` modifier because it
    // syntactically declares the object PROPERTY — but it READS the variable, it
    // does not declare it. Counting it as a declaration would (wrongly) make the
    // variable block-local to whatever object literal it appears in, dropping it
    // to neutral. So never treat a shorthand read as a binding declaration.
    const isShorthand = tok.type === 'property';
    if (!isShorthand && tok.modifiers.some((m) => DECL_MODIFIERS.has(m))) {
      const d = declOffsets.get(tok.name);
      if (d) {
        d.push(tok.offset);
      } else {
        declOffsets.set(tok.name, [tok.offset]);
      }
    }
  }

  // self names are keywords the token stream skips; lex them once here so the
  // trace layer has ranges for them (band 1 paints them, but escape-risk needs
  // the classification).
  const selfWanted = new Set<string>();
  for (const name of SELF_NAMES) {
    selfWanted.add(name);
  }
  for (const id of lexIdentifiers(text)) {
    if (selfWanted.has(id.name)) {
      const range: OffsetRange = { start: id.offset, end: id.offset + id.length };
      const list = occurrences.get(id.name);
      if (list) {
        list.push(range);
      } else {
        occurrences.set(id.name, [range]);
        firstFileOffset.set(id.name, id.offset);
      }
    }
  }

  const fileGlobalsInOrder = computeFileGlobals(occurrences, declOffsets, fnRanges);
  return { occurrences, declOffsets, firstFileOffset, fileGlobalsInOrder };
}

/**
 * Semantic token types we treat as tintable DATA identities. Band 2 is about
 * data flow, so only bindings you can trace — variables and parameters — get an
 * identity tint. Functions, methods, properties, classes, namespaces, types etc.
 * keep their band-1 theme colour: a function/method name is a transformer with
 * its own stable visual identity (bold blue), not a data value; a property is a
 * field access, not a binding. Excluding them also frees the 6-slot budget for
 * the variables that actually carry data.
 */
const TINTABLE_TYPES = new Set(['variable', 'parameter']);

/**
 * Modifiers that disqualify a token from identity tinting even when its type is
 * variable/parameter. `defaultLibrary` marks builtins (console, Math, nil,
 * true/false…) — library surface, not the file's own data. `signature` (gopls)
 * marks FUNCTION-TYPED values (a func param `h Handler`, a func-typed local):
 * calls through them are transformers, not data — they keep band-1's bold blue
 * like any other function. `readonly`/`static` are NOT excluded: a readonly
 * local is still data.
 */
const NON_DATA_MODIFIERS = new Set(['defaultLibrary', 'signature']);

const DECL_MODIFIERS = new Set(['declaration', 'definition']);

/** A minimal keyword denylist for the heuristic path (no semantic types to lean on). */
const HEURISTIC_KEYWORDS = new Set([
  // JS/TS
  'const', 'let', 'var', 'function', 'class', 'return', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'new', 'delete', 'typeof', 'instanceof',
  'in', 'of', 'void', 'this', 'super', 'null', 'undefined', 'true', 'false', 'async',
  'await', 'yield', 'try', 'catch', 'finally', 'throw', 'import', 'export', 'from',
  'default', 'extends', 'implements', 'interface', 'type', 'enum', 'namespace', 'as',
  'is', 'keyof', 'readonly', 'public', 'private', 'protected', 'static', 'get', 'set',
  // Go / C-family extras
  'func', 'package', 'defer', 'go', 'chan', 'map', 'struct', 'range', 'select',
  'int', 'string', 'bool', 'float', 'double', 'char', 'long', 'short', 'unsigned',
  'nil', 'true', 'false',
]);

/** Declaration keywords that introduce a binding on the following identifier. */
const DECL_KEYWORDS = new Set(['const', 'let', 'var', 'function', 'class', 'func', 'def', 'type', 'enum', 'interface', 'struct']);

/** Compute the start offset of each line, so (line,char) → absolute offset. */
export function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Decode a VS Code SemanticTokens data array (5-tuple delta stream:
 * deltaLine, deltaStartChar, length, tokenTypeIndex, tokenModifiersBitset) into
 * absolute-offset tokens with legend-resolved type + modifier names.
 */
export function decodeSemanticTokens(
  data: ArrayLike<number>,
  tokenTypes: string[],
  tokenModifiers: string[],
  lineStarts: number[],
  text: string,
): DecodedToken[] {
  const out: DecodedToken[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const dLine = data[i];
    const dChar = data[i + 1];
    const length = data[i + 2];
    const typeIdx = data[i + 3];
    const modBits = data[i + 4];

    if (dLine > 0) {
      line += dLine;
      char = dChar;
    } else {
      char += dChar;
    }

    const lineStart = lineStarts[line];
    if (lineStart === undefined) {
      continue;
    }
    const offset = lineStart + char;
    const name = text.slice(offset, offset + length);
    const type = tokenTypes[typeIdx] ?? '';
    const modifiers: string[] = [];
    for (let b = 0; b < tokenModifiers.length; b++) {
      if (modBits & (1 << b)) {
        modifiers.push(tokenModifiers[b]);
      }
    }
    out.push({ name, offset, length, type, modifiers });
  }
  return out;
}

function inRange(offset: number, range: OffsetRange): boolean {
  return offset >= range.start && offset < range.end;
}

function insideAnyFn(offset: number, fnRanges: OffsetRange[]): boolean {
  return fnRanges.some((r) => inRange(offset, r));
}

/**
 * True globals (out-of-fn, non-capture) across the whole file, in order of
 * first appearance. A name is a true global when none of its declarations sit
 * inside any function range — i.e. declared at module scope, or with no visible
 * declaration at all. `occurrences` is iterated in insertion order, which is
 * first-appearance order, so the returned list is file-ordered. This is
 * block-independent, so it seeds the colour ledger identically regardless of
 * which block is focused first (fixes navigation-order hue drift).
 */
function computeFileGlobals(
  occurrences: Map<string, OffsetRange[]>,
  declOffsets: Map<string, number[]>,
  fnRanges: OffsetRange[],
): string[] {
  const globals: string[] = [];
  for (const name of occurrences.keys()) {
    if (isSelfName(name)) {
      continue;
    }
    const decls = declOffsets.get(name) ?? [];
    const declaredInFn = decls.some((o) => insideAnyFn(o, fnRanges));
    if (!declaredInFn) {
      globals.push(name);
    }
  }
  return globals;
}

/**
 * Split the data names appearing in `enclosingFn` into local identities and
 * true globals, each ordered by first appearance IN THE FUNCTION. Local hue
 * assignment keys off `locals` so a variable keeps one colour across every
 * sub-block of its function (data-flow identity is function-stable, not
 * block-stable). `globals` names are the file-globals visible in the function,
 * whose hues the local assignment must skip to avoid collisions.
 *
 * A name is a local identity here if it has a declaration inside ANY function
 * (its own or an outer one it captures); a name with no in-function declaration
 * is a true global. self names are excluded (they own the gold slot).
 */
function computeFnLocals(
  occurrences: Map<string, OffsetRange[]>,
  declOffsets: Map<string, number[]>,
  fnRanges: OffsetRange[],
  enclosingFn: OffsetRange | undefined,
): { locals: string[]; globals: string[] } {
  if (!enclosingFn) {
    return { locals: [], globals: [] };
  }
  // First in-function offset per name, over occurrences that fall in the fn.
  const firstInFn = new Map<string, number>();
  for (const [name, ranges] of occurrences) {
    if (isSelfName(name)) {
      continue;
    }
    let earliest = Infinity;
    for (const r of ranges) {
      if (inRange(r.start, enclosingFn) && r.start < earliest) {
        earliest = r.start;
      }
    }
    if (earliest !== Infinity) {
      firstInFn.set(name, earliest);
    }
  }
  const localNames: string[] = [];
  const globalNames: string[] = [];
  for (const name of firstInFn.keys()) {
    const decls = declOffsets.get(name) ?? [];
    const declaredInSomeFn = decls.some((o) => insideAnyFn(o, fnRanges));
    (declaredInSomeFn ? localNames : globalNames).push(name);
  }
  const byFirst = (a: string, b: string): number => (firstInFn.get(a) ?? 0) - (firstInFn.get(b) ?? 0);
  localNames.sort(byFirst);
  globalNames.sort(byFirst);
  return { locals: localNames, globals: globalNames };
}

/**
 * The innermost function range containing `offset`. Ties break to the tightest
 * span. Returns undefined at top level.
 */
export function enclosingFnOf(fnRanges: OffsetRange[], offset: number): OffsetRange | undefined {
  let best: OffsetRange | undefined;
  for (const r of fnRanges) {
    if (inRange(offset, r)) {
      if (!best || r.end - r.start < best.end - best.start) {
        best = r;
      }
    }
  }
  return best;
}

/**
 * The OUTERMOST (widest) function range containing `offset`. This is the colour
 * scope: a variable's hue is stable across the whole top-level function and all
 * its nested closures (`.map`/`.filter`/callbacks). Keying colour on the
 * innermost function would recolour a captured name every time the caret enters
 * a closure — which is exactly the "c goes purple → orange" glitch. Returns
 * undefined at module top level.
 */
export function outermostFnOf(fnRanges: OffsetRange[], offset: number): OffsetRange | undefined {
  let best: OffsetRange | undefined;
  for (const r of fnRanges) {
    if (inRange(offset, r)) {
      if (!best || r.end - r.start > best.end - best.start) {
        best = r;
      }
    }
  }
  return best;
}

function isSelfName(name: string): boolean {
  return SELF_NAMES.has(name) || name.startsWith('@');
}

/**
 * A `property`-typed token is normally band-1 (field access / key literal / a
 * field or member DEFINITION), NOT a data identity — that is why `TINTABLE_TYPES`
 * omits it. The one exception is OBJECT-SHORTHAND: in `{ name }` the token is a
 * genuine READ of the `name` binding, equivalent to `{ name: name }`. Servers
 * type it `property`, but it flows data and should tint like the variable it
 * refers to.
 *
 * Grounded in REAL semantic-token output from both TS (getEncodedSemantic-
 * Classifications) and gopls (`gopls semtok`):
 *   TS   `{ name }`            → property [declaration]            → shorthand ✓
 *   TS   `cfg.name`            → property [] (after `.`)           → field access ✗
 *   TS   `{ name: v }`         → property [declaration] (`:` next) → key literal ✗
 *   Go   struct field `Name`   → property [definition string]      → field DEF ✗
 *   Go   composite key `Name:` → property [string] (`:` next)      → key literal ✗
 *   Go   `cfg.Name`            → property [string] (after `.`)     → field access ✗
 *
 * So the rule is: a `property` token is a shorthand read when it is NOT preceded
 * by `.`, NOT followed by `:`, AND does NOT carry a `definition` modifier (Go
 * struct/field definitions carry `definition`; TS shorthand carries only
 * `declaration`, which is kept).
 */
function isShorthandPropertyRead(
  text: string,
  offset: number,
  length: number,
  modifiers: string[],
): boolean {
  // A field/member DEFINITION is band-1, never a data read (Go struct fields).
  if (modifiers.includes('definition')) {
    return false;
  }

  // previous non-whitespace char
  let p = offset - 1;
  while (p >= 0 && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n' || text[p] === '\r')) {
    p--;
  }
  const prev = p >= 0 ? text[p] : '';

  // next non-whitespace char
  let n = offset + length;
  while (n < text.length && (text[n] === ' ' || text[n] === '\t' || text[n] === '\n' || text[n] === '\r')) {
    n++;
  }
  const next = n < text.length ? text[n] : '';

  // A shorthand read sits INSIDE AN OBJECT LITERAL: opened by `{` or separated
  // by `,`, and terminated by `,` or `}`. Requiring both sides is what separates
  // it from a class/interface MEMBER DECLARATION, which TS reports with the same
  // `property [declaration]` token but never has that bracketing:
  //   `{ name }` / `{ name, x }`  → prev `{`/`,`  next `,`/`}`  → shorthand ✓
  //   `get summary(): string`     → prev `t`      next `(`      → declaration ✗
  //   `private seen = 0`          → prev `e`      next `=`      → declaration ✗
  //   `interface I { field: … }`  → prev `{`      next `:`      → key literal  ✗
  //   `cfg.name`                  → prev `.`                    → field access ✗
  return (prev === '{' || prev === ',') && (next === ',' || next === '}');
}

/**
 * this/self are keywords, so the semantic decoder and the heuristic occurrence
 * scan both skip them — leaving self names with no occurrence ranges to tint.
 * Lex them explicitly (in code, not strings/comments) and record file-wide
 * occurrences so the trace layer can clip them to the enclosing function like
 * any other name. Only word-shaped self names (this/self) are lexable here;
 * @-prefixed sigils are left to the caller's block use.
 */
function addSelfOccurrences(
  text: string,
  byName: Map<string, NameInfo>,
  occurrences: Map<string, OffsetRange[]>,
): void {
  const wanted = new Set<string>();
  for (const [name, info] of byName) {
    if (info.cls === 'self' && SELF_NAMES.has(name)) {
      wanted.add(name);
    }
  }
  if (wanted.size === 0) {
    return;
  }
  for (const id of lexIdentifiers(text)) {
    if (wanted.has(id.name)) {
      const range: OffsetRange = { start: id.offset, end: id.offset + id.length };
      const list = occurrences.get(id.name);
      if (list) {
        list.push(range);
      } else {
        occurrences.set(id.name, [range]);
      }
    }
  }
}

/**
 * PURE classifier driven by decoded semantic tokens. Builds file-wide
 * occurrences, then classifies every distinct name that is USED in the block.
 */
export function classifyFromSemantic(
  text: string,
  block: OffsetRange,
  enclosingFn: OffsetRange | undefined,
  fnRanges: OffsetRange[],
  tokens: DecodedToken[],
  docVersion: number,
  focusKey: string,
  // The colour scope: the OUTERMOST function whose palette this block shares.
  // Defaults to enclosingFn (innermost) when not supplied — callers that want
  // closure-stable hues pass the outermost function here.
  colorScopeFn: OffsetRange | undefined = enclosingFn,
  // The declaration region for block-local detection: the block PLUS its header
  // line, so loop/if header bindings (`for _, c := range xs {`) count as
  // block-local. Defaults to `block` when not supplied. Tint/trace ranges still
  // use `block` (body-scoped) — only classification widens.
  declRegion: OffsetRange = block,
  // Ranges of brace-blocks nested strictly INSIDE the focused block. A block
  // local whose declaration sits in one of these belongs to a child scope the
  // caret is above → lower attention priority (proximity 2).
  subBlocks: OffsetRange[] = [],
  // File-wide index, computed once per document version. Built on demand when
  // absent (keeps the pure signature usable standalone in tests).
  fileIndex: FileIndex = buildFileIndex(text, tokens, fnRanges),
): Classification {
  const { occurrences, declOffsets, firstFileOffset } = fileIndex;

  const byName = new Map<string, NameInfo>();

  // A name only counts as used-in-this-block if it has a TINTABLE occurrence
  // inside it. Lexing alone is not enough: `c.Name` is a field access (rejected
  // by the tintable gate), but `Name` may still be in the file-wide occurrence
  // map from a shorthand read elsewhere — without this check the field access
  // would inherit that eligibility and tint.
  const tintableInBlock = new Set<string>();
  for (const [name, ranges] of occurrences) {
    for (const r of ranges) {
      if (r.start >= block.start && r.end <= block.end) {
        tintableInBlock.add(name);
        break;
      }
    }
  }

  // Names used in the block, via the lexer (gives per-block frequency/order for
  // the names the tintable gate admitted).
  const blockIds = lexIdentifiers(text, block.start, block.end);
  const blockAgg = new Map<string, { freq: number; first: number }>();
  for (const id of blockIds) {
    const agg = blockAgg.get(id.name);
    if (agg) {
      agg.freq++;
    } else {
      blockAgg.set(id.name, { freq: 1, first: id.offset });
    }
  }

  for (const [name, agg] of blockAgg) {
    if (isSelfName(name)) {
      byName.set(name, {
        cls: 'self',
        freqInBlock: agg.freq,
        firstFileOffset: firstFileOffset.get(name) ?? agg.first,
        firstBlockOffset: agg.first,
        isCapture: false,
        proximity: 1,
      });
      continue;
    }
    // `_` is a discard (Go/Python blank identifier) or a module facade (lodash)
    // — either way it is not a data identity and must not compete for a hue.
    if (name === '_') {
      continue;
    }
    // Only names with a tintable occurrence IN THIS BLOCK proceed. (File-wide
    // eligibility is not enough — see tintableInBlock above.)
    if (!tintableInBlock.has(name)) {
      continue; // keyword, field access, string content, non-tintable → neutral
    }

    const decls = declOffsets.get(name) ?? [];
    // Block-local if declared in the block body OR its header (loop/if binding).
    const declInBlock = decls.some((o) => inRange(o, declRegion));
    const declInFn = enclosingFn ? decls.some((o) => inRange(o, enclosingFn) && !inRange(o, declRegion)) : false;

    let cls: Cls;
    let isCapture = false;
    let homeFn: OffsetRange | undefined;

    if (declInBlock) {
      cls = 'block';
    } else if (declInFn) {
      cls = 'fn';
    } else {
      cls = 'out';
      // Capture vs true global: does a declaration sit inside SOME other function?
      const declFn = decls
        .map((o) => enclosingFnOf(fnRanges, o))
        .find((r) => r && !(enclosingFn && r.start === enclosingFn.start && r.end === enclosingFn.end));
      if (declFn) {
        isCapture = true;
        homeFn = declFn;
      }
    }

    // Attention proximity: a block-local declared inside a NESTED sub-block is a
    // child scope the caret sits above (proximity 2). A direct block-local is
    // proximity 0 (the focused block's own data). Everything borrowed in
    // (fn-local, capture, global) is proximity 1.
    let proximity: 0 | 1 | 2 = 1;
    if (cls === 'block') {
      const declInSub = decls.some((o) => subBlocks.some((sb) => inRange(o, sb)));
      proximity = declInSub ? 2 : 0;
    }

    byName.set(name, {
      cls,
      freqInBlock: agg.freq,
      firstFileOffset: firstFileOffset.get(name) ?? agg.first,
      firstBlockOffset: agg.first,
      isCapture,
      homeFn,
      proximity,
    });
  }

  // fileGlobalsInOrder + self occurrences come from the shared file index — no
  // per-block whole-file rescan. Local ordering is per COLOUR SCOPE, so every
  // closure inside it shares one first-appearance order.
  const { locals: fnLocalsInOrder, globals: fnGlobals } = computeFnLocals(
    occurrences,
    declOffsets,
    fnRanges,
    colorScopeFn,
  );
  return {
    docVersion,
    focusKey,
    byName,
    occurrences,
    fileGlobalsInOrder: fileIndex.fileGlobalsInOrder,
    fnLocalsInOrder,
    fnGlobals,
    colorScopeFn,
    enclosingFn,
    source: 'lsp',
  };
}

/**
 * PURE heuristic classifier — no LSP. Detects declarations by keyword patterns
 * over the lexer stream, resolves occurrences lexically. Language-approximate
 * but synchronous; the correct fallback when no semantic-tokens provider exists.
 */
export function classifyFromHeuristic(
  text: string,
  block: OffsetRange,
  enclosingFn: OffsetRange | undefined,
  fnRanges: OffsetRange[],
  docVersion: number,
  focusKey: string,
  colorScopeFn: OffsetRange | undefined = enclosingFn,
  declRegion: OffsetRange = block,
  subBlocks: OffsetRange[] = [],
): Classification {
  const allIds = lexIdentifiers(text);

  // File-wide occurrences of non-keyword identifiers.
  const occurrences = new Map<string, OffsetRange[]>();
  const firstFileOffset = new Map<string, number>();
  for (const id of allIds) {
    if (HEURISTIC_KEYWORDS.has(id.name) || isSelfName(id.name)) {
      continue;
    }
    const range: OffsetRange = { start: id.offset, end: id.offset + id.length };
    const list = occurrences.get(id.name);
    if (list) {
      list.push(range);
    } else {
      occurrences.set(id.name, [range]);
      firstFileOffset.set(id.name, id.offset);
    }
  }

  // Declaration offsets: an identifier immediately preceded by a decl keyword,
  // or appearing in a parameter-ish position. We approximate params as any
  // identifier on the enclosing function's header line handled generically —
  // here we only catch `<declKw> name`, which covers the common cases.
  const declOffsets = new Map<string, number[]>();
  for (let i = 0; i < allIds.length; i++) {
    const id = allIds[i];
    const prev = i > 0 ? allIds[i - 1] : undefined;
    if (prev && DECL_KEYWORDS.has(prev.name) && !HEURISTIC_KEYWORDS.has(id.name)) {
      const d = declOffsets.get(id.name);
      if (d) {
        d.push(id.offset);
      } else {
        declOffsets.set(id.name, [id.offset]);
      }
    }
  }

  const blockIds = lexIdentifiers(text, block.start, block.end);
  const blockAgg = new Map<string, { freq: number; first: number }>();
  for (const id of blockIds) {
    // this/self are keywords but must reach the self-class check below, so let
    // them through the keyword filter.
    if (HEURISTIC_KEYWORDS.has(id.name) && !isSelfName(id.name)) {
      continue;
    }
    const agg = blockAgg.get(id.name);
    if (agg) {
      agg.freq++;
    } else {
      blockAgg.set(id.name, { freq: 1, first: id.offset });
    }
  }

  const byName = new Map<string, NameInfo>();
  for (const [name, agg] of blockAgg) {
    if (isSelfName(name)) {
      byName.set(name, {
        cls: 'self',
        freqInBlock: agg.freq,
        firstFileOffset: agg.first,
        firstBlockOffset: agg.first,
        isCapture: false,
        proximity: 1,
      });
      continue;
    }
    // discard / blank identifier — not a data identity (see semantic path).
    if (name === '_') {
      continue;
    }
    if (!occurrences.has(name)) {
      continue;
    }
    const decls = declOffsets.get(name) ?? [];
    const declInBlock = decls.some((o) => inRange(o, declRegion));
    const declInFn = enclosingFn ? decls.some((o) => inRange(o, enclosingFn) && !inRange(o, declRegion)) : false;

    let cls: Cls;
    let isCapture = false;
    let homeFn: OffsetRange | undefined;
    if (declInBlock) {
      cls = 'block';
    } else if (declInFn) {
      cls = 'fn';
    } else {
      cls = 'out';
      const declFn = decls
        .map((o) => enclosingFnOf(fnRanges, o))
        .find((r) => r && !(enclosingFn && r.start === enclosingFn.start && r.end === enclosingFn.end));
      if (declFn) {
        isCapture = true;
        homeFn = declFn;
      }
    }

    let proximity: 0 | 1 | 2 = 1;
    if (cls === 'block') {
      const declInSub = decls.some((o) => subBlocks.some((sb) => inRange(o, sb)));
      proximity = declInSub ? 2 : 0;
    }

    byName.set(name, {
      cls,
      freqInBlock: agg.freq,
      firstFileOffset: firstFileOffset.get(name) ?? agg.first,
      firstBlockOffset: agg.first,
      isCapture,
      homeFn,
      proximity,
    });
  }

  addSelfOccurrences(text, byName, occurrences);
  const fileGlobalsInOrder = computeFileGlobals(occurrences, declOffsets, fnRanges);
  const { locals: fnLocalsInOrder, globals: fnGlobals } = computeFnLocals(
    occurrences,
    declOffsets,
    fnRanges,
    colorScopeFn,
  );
  return {
    docVersion,
    focusKey,
    byName,
    occurrences,
    fileGlobalsInOrder,
    fnLocalsInOrder,
    fnGlobals,
    colorScopeFn,
    enclosingFn,
    source: 'heuristic',
  };
}
