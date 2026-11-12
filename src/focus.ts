/**
 * Focus resolution — spec §1 (Vocabulary) and §3.2.
 *
 *   Brace-block   — any {…} span, header line through closing line.
 *   Focus         — the *innermost* brace-block containing the caret line.
 *                   Deepest scope wins, plain and predictable. (Spec §1: the
 *                   smarter hysteresis version was scrapped as confusing.)
 *
 * Every scanner here reads code vs comment vs string from the shared,
 * language-aware lexer in lex.ts (rules: docs/lexer.md), so a brace, colon or
 * identifier inside a string or comment never counts. Focus stays purely
 * structural — "the innermost {…} around the caret" — and synchronous (no await
 * on every caret move).
 *
 * §8.4 flags that the prototype's if-block detection had nested/else edge bugs;
 * the settled logic is simply "deepest {…} containing the line", which is what
 * this scanner computes — no special-casing of control-flow headers.
 */

import { LexId, LexResult, blankOrHashLine, forgetLex, jsxBraces, lexFor, rememberLex, scriptLexes } from './lex';
import { bestAt, buildIntervalIndex } from './intervals';
import { BLOCK_OPEN, MODULE_OPEN, isViewLanguage, viewBlocks, viewRegions } from './html';
import type { TemplateBlock } from './sfc';

export type { LexId } from './lex';

export interface BraceBlock {
  /** 0-based line of the `{` (the header line). */
  openLine: number;
  /** 0-based line of the matching `}`. */
  closeLine: number;
  /** Nesting depth of this block (outermost = 0). */
  depth: number;
  /** Absolute character offset of the `{`. */
  openOffset: number;
  /** Absolute character offset of the `}` (the brace itself). */
  closeOffset: number;
  /**
   * Absolute offset of the START of the header line (the line the `{` is on).
   * Loop/if/switch headers declare variables that belong to the block but sit
   * BEFORE the brace (`for _, c := range xs {`, `if v, ok := m[k]; ok {`). For
   * classification we treat a declaration anywhere from headerStart..closeOffset
   * as block-local, so those header bindings tint as block data — without
   * widening the tint/trace range itself, which stays body-scoped.
   */
  headerStart: number;
  /**
   * Position among the blocks that open on the same line at the same depth, in
   * document order; absent for the first. `.map((x) => …).filter((y) => …)` puts
   * two arrows there.
   */
  slot?: number;
}

/**
 * Every brace-block in the document, each as a (openLine, closeLine, depth,
 * offsets) tuple, from the lexer's code `{`/`}` — braces in strings, comments,
 * regex literals and JSX text never count. Cached per version by the decorator.
 *
 * It is not a parser: on a braceless language the block list is simply empty and
 * the layer stays in Survey, the correct at-rest behaviour anyway.
 */
export function scanBraceBlocks(text: string, languageId?: string): BraceBlock[] {
  const lx = lexFor(text, languageId);
  const blocks: BraceBlock[] = [];
  const stack: { openLine: number; openOffset: number; headerStart: number }[] = [];
  const starts = lx.lineStarts;
  // A JSX expression's braces delimit markup, so a caret in `{total}` focuses the component.
  const jsx = jsxBraces(lx);
  let line = 0;
  for (const i of lx.punct) {
    const c = text.charCodeAt(i);
    if ((c !== 123 && c !== 125) || jsx.has(i)) continue;
    while (line + 1 < starts.length && starts[line + 1] <= i) line++;
    if (c === 123) {
      stack.push({ openLine: line, openOffset: i, headerStart: starts[line] });
      continue;
    }
    const open = stack.pop();
    if (open) {
      blocks.push({
        openLine: open.openLine,
        closeLine: line,
        depth: stack.length, // depth after popping = this block's depth
        openOffset: open.openOffset,
        closeOffset: i,
        headerStart: open.headerStart,
      });
    }
  }

  // Concise arrow bodies (`x => expr`) are scopes too, but have no braces to find.
  // Appended after, then the whole list is sorted by open offset so downstream
  // consumers that assume document order still hold.
  if (languageId !== undefined && !ARROW_LANGUAGES.has(languageId)) {
    return withSlots(blocks);
  }
  const arrows = scanArrowBlocks(text, blocks, lx, languageId);
  if (arrows.length === 0) {
    return withSlots(blocks);
  }
  return withSlots([...blocks, ...arrows].sort((a, b) => a.openOffset - b.openOffset));
}

/** Number the blocks that share an open line and depth (`slot`), in open order. */
function withSlots(blocks: BraceBlock[]): BraceBlock[] {
  let sorted = true;
  for (let i = 1; i < blocks.length && sorted; i++) sorted = blocks[i - 1].openOffset <= blocks[i].openOffset;
  const byOpen = sorted ? blocks.map((_, i) => i) : blocks.map((_, i) => i).sort((a, b) => blocks[a].openOffset - blocks[b].openOffset);
  const seen = new Map<number, number>();
  for (const i of byOpen) {
    const b = blocks[i];
    const key = b.openLine * 4096 + b.depth + 1;
    const n = seen.get(key) ?? 0;
    if (n > 0) b.slot = n;
    else delete b.slot;
    seen.set(key, n + 1);
  }
  return blocks;
}

/**
 * Languages whose `=>` is a JS arrow. In Rust, C# and Scala `=>` also ends a match
 * or switch arm, which the arrow scanner would read as a one-arm scope.
 */
const ARROW_LANGUAGES = new Set(['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'html', 'vue', 'svelte', 'astro']);

/** Languages where `(a): T => …` puts a return-type annotation between `)` and `=>`. */
const TYPED_ARROW_LANGUAGES = new Set(['typescript', 'typescriptreact', 'vue', 'svelte', 'astro']);

/**
 * Blocks for CONCISE ARROW BODIES — `(acc, x) => expr` with no braces.
 *
 * A braceless arrow is a real scope: its parameters are bindings, and the
 * expression is their only use. But `scanBraceBlocks` finds `{}` pairs, so these
 * were invisible — the caret inside
 *
 *   .reduce((acc, line, idx) => `${acc}${idx}:${line}; `, "")
 *
 * resolved to the ENCLOSING function, which then treated `acc`/`line`/`idx` as its
 * own block-locals. They competed for the outer function's hues, and the arrow was
 * never focusable in its own right.
 *
 * The synthetic block spans `(` … end of expression. Finding that end is the whole
 * problem: the body runs to the first `,` or `)` that is not nested inside brackets,
 * a string, or a template. Depth is derived from the enclosing brace-blocks, plus 1,
 * so the arrow always out-depths its parent and `innermostBlock` prefers it.
 */
function scanArrowBlocks(text: string, braceBlocks: BraceBlock[], lx: LexResult, languageId?: string): BraceBlock[] {
  const out: BraceBlock[] = [];
  const lineOf = (offset: number): number => lx.lineOf(offset);
  const typed = languageId !== undefined && TYPED_ARROW_LANGUAGES.has(languageId);

  const types = typed ? typeArrowsOf(lx, languageId) : undefined;
  for (const arrowAt of findArrowOffsets(text, lx)) {
    // Skip braced arrows — scanBraceBlocks already owns those.
    let j = arrowAt + 2;
    while (j < text.length && /\s/.test(text[j])) {
      j++;
    }
    if (j >= text.length || text[j] === '{' || types?.arrows.has(arrowAt)) {
      continue;
    }
    // Parameter list start: `(`-group before the arrow, else the bare identifier.
    const start = paramStartBefore(text, typed ? returnTypeStart(text, arrowAt, lx) : arrowAt);
    if (start === -1) {
      continue;
    }
    const end = conciseBodyEnd(text, j, lx);
    if (end <= j) {
      continue;
    }
    out.push({
      openLine: lineOf(start),
      closeLine: lineOf(end - 1),
      depth: 0, // provisional; resolved below once all arrows are known
      openOffset: start,
      closeOffset: end - 1,
      headerStart: start,
    });
  }

  // Depth = one deeper than the tightest enclosing scope, counting brace-blocks AND
  // other arrows. Curried arrows (`a => b => a + b`) nest in each other with no
  // braces at all, so an arrow-blind depth left them tied and `innermostBlock` could
  // not tell which one the caret was in. Arrow ancestors are the other arrows
  // containing this one, so a chain of N gets depths parent+1 … parent+N.
  const parent = deepestStrictlyContaining(out, braceBlocks);
  const ancestors = arrowAncestorCounts(out);
  out.forEach((a, i) => {
    a.depth = parent[i] + 1 + ancestors[i];
  });
  return out;
}

/** Close offsets in descending order, deduplicated, for prefix queries over "close > x". */
function descendingCloses(blocks: BraceBlock[]): number[] {
  return [...new Set(blocks.map((b) => b.closeOffset))].sort((a, b) => b - a);
}

/** Number of entries in a descending array that are > x (strict) or >= x. */
function countAbove(desc: number[], x: number, inclusive: boolean): number {
  let lo = 0;
  let hi = desc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (inclusive ? desc[mid] >= x : desc[mid] > x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Per arrow, the greatest depth of a brace block with open < arrow open and close
 * > arrow close, else -1. Braces enter in open order; a Fenwick tree of maxima
 * over close rank answers each arrow.
 */
function deepestStrictlyContaining(arrows: BraceBlock[], braces: BraceBlock[]): number[] {
  const desc = descendingCloses(braces);
  const tree = new Array<number>(desc.length + 1).fill(-1);
  const byOpen = [...braces].sort((a, b) => a.openOffset - b.openOffset);
  const order = arrows.map((_, i) => i).sort((a, b) => arrows[a].openOffset - arrows[b].openOffset);
  const result = new Array<number>(arrows.length).fill(-1);
  let k = 0;
  for (const i of order) {
    const a = arrows[i];
    for (; k < byOpen.length && byOpen[k].openOffset < a.openOffset; k++) {
      for (let r = countAbove(desc, byOpen[k].closeOffset, false) + 1; r <= desc.length; r += r & -r) {
        tree[r] = Math.max(tree[r], byOpen[k].depth);
      }
    }
    let best = -1;
    for (let r = countAbove(desc, a.closeOffset, false); r > 0; r -= r & -r) best = Math.max(best, tree[r]);
    result[i] = best;
  }
  return result;
}

/**
 * Per arrow, how many other arrows contain it (open <= its open, close >= its
 * close, not the same span). Same scheme as above, with a Fenwick tree of counts.
 */
function arrowAncestorCounts(arrows: BraceBlock[]): number[] {
  const desc = descendingCloses(arrows);
  const tree = new Array<number>(desc.length + 1).fill(0);
  const order = arrows.map((_, i) => i).sort((a, b) => arrows[a].openOffset - arrows[b].openOffset);
  const same = new Map<string, number>();
  for (const a of arrows) {
    const key = `${a.openOffset}:${a.closeOffset}`;
    same.set(key, (same.get(key) ?? 0) + 1);
  }
  const result = new Array<number>(arrows.length).fill(0);
  for (let g = 0; g < order.length; ) {
    let end = g;
    while (end < order.length && arrows[order[end]].openOffset === arrows[order[g]].openOffset) end++;
    for (let j = g; j < end; j++) {
      for (let r = countAbove(desc, arrows[order[j]].closeOffset, false) + 1; r <= desc.length; r += r & -r) tree[r]++;
    }
    for (let j = g; j < end; j++) {
      const a = arrows[order[j]];
      let n = 0;
      for (let r = countAbove(desc, a.closeOffset, true); r > 0; r -= r & -r) n += tree[r];
      result[order[j]] = n - same.get(`${a.openOffset}:${a.closeOffset}`)!;
    }
    g = end;
  }
  return result;
}

/** Offsets of every `=>` that is code (not inside a string, template text or comment). */
function findArrowOffsets(text: string, lx: LexResult): number[] {
  const found: number[] = [];
  for (let i = text.indexOf('=>'); i >= 0; i = text.indexOf('=>', i + 2)) {
    if (lx.isCode(i)) found.push(i);
  }
  return found;
}

/**
 * Offset of the `:` of a return-type annotation between a parameter list and
 * `arrowAt` (`(n: number): string => …`), else `arrowAt`. A `:` after anything
 * but `)` is an object key, and a `?` or `,` at depth 0 means the arrow is not
 * annotated.
 */
function returnTypeStart(text: string, arrowAt: number, lx: LexResult): number {
  let depth = 0;
  for (let i = arrowAt - 1; i >= 0 && arrowAt - i < 400; i--) {
    if (!lx.isCode(i)) continue;
    const c = text[i];
    if (c === '>' && text[i - 1] === '=') {
      i--;
      continue;
    }
    if (c === ')' || c === ']' || c === '}' || c === '>') {
      depth++;
    } else if (c === '(' || c === '[' || c === '{' || c === '<') {
      if (depth === 0) return arrowAt;
      depth--;
    } else if (depth === 0) {
      if (c === ':') {
        let p = i - 1;
        while (p >= 0 && /\s/.test(text[p])) p--;
        return text[p] === ')' ? i : arrowAt;
      }
      if (c === ';' || c === ',' || c === '=' || c === '?') return arrowAt;
    }
  }
  return arrowAt;
}

/** Start of the parameter list immediately before `arrowAt`, or -1 if none reads as one. */
function paramStartBefore(text: string, arrowAt: number): number {
  let i = arrowAt - 1;
  while (i >= 0 && /\s/.test(text[i])) {
    i--;
  }
  if (i < 0) {
    return -1;
  }
  if (text[i] === ')') {
    let depth = 0;
    for (; i >= 0; i--) {
      if (text[i] === ')') {
        depth++;
      } else if (text[i] === '(') {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }
    return -1;
  }
  // Bare single-identifier arrow: `name => …`
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_$]/.test(text[i])) {
    i--;
  }
  return i + 1 < end ? i + 1 : -1;
}

/**
 * End (exclusive) of a concise arrow body starting at `from`.
 *
 * The body ends at the first `,` or closing bracket encountered at nesting depth 0
 * — that is where the argument or statement it belongs to ends — or at the end of
 * the template hole it sits in. Only code punctuation counts, so a `,` inside a
 * string or template text cannot terminate it early, which is exactly the case in
 * `` (acc, line, idx) => `${acc}${idx}:${line}; ` ``.
 *
 * Without semicolons the statement ends at a newline instead: a depth-0 newline
 * ends the body unless the line before ends in an operator or the line after
 * starts with one (`.map(…)`, `+ 1`, `?`, a closing bracket), and a blank line
 * always ends it. See docs/classification-rules.md#concise-arrow-bodies-are-scopes.
 */
function conciseBodyEnd(text: string, from: number, lx: LexResult): number {
  const limit = lx.holeEndAt(from);
  let depth = 0;
  const P = lx.punct;
  let at = from;
  const newlineEnd = (to: number): number => {
    for (let i = text.indexOf('\n', at); i >= 0 && i < to; i = text.indexOf('\n', i + 1)) {
      if (lx.regionAt(i) === 'string') continue;
      if (statementEndsAt(text, i, lx)) return lx.prevSignificant(i) + 1;
    }
    return -1;
  };
  for (let k = lx.punctFrom(from); k < P.length && P[k] < limit; k++) {
    const i = P[k];
    const c = text[i];
    if (depth === 0) {
      const nl = newlineEnd(i);
      if (nl > 0) return nl;
    }
    at = i + 1;
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        return i; // closes the call/array/object we are an argument of
      }
      depth--;
    } else if ((c === ',' || c === ';') && depth === 0) {
      return i;
    }
  }
  if (depth === 0) {
    const nl = newlineEnd(limit);
    if (nl > 0) return nl;
  }
  return limit;
}

/** A line ending in one of these continues on the next. */
const CONTINUES_LINE = new Set(['=', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '<', '>', '?', ':', ',', '(', '[', '{', '.']);
/** A line starting with one of these continues the previous. */
const CONTINUES_FROM = new Set(['.', '?', ':', '=', '+', '-', '*', '/', '%', '&', '|', '^', '<', '>', ',', '(', '[', ')', ']', '}', '`']);
const CONTINUES_WORD = new Set(['as', 'satisfies', 'instanceof', 'in']);

/** Does the code statement at the newline `nl` end there (no `;` style)? */
function statementEndsAt(text: string, nl: number, lx: LexResult): boolean {
  let n = nl + 1;
  let blank = false;
  for (;;) {
    while (n < text.length && (text[n] === ' ' || text[n] === '\t' || text[n] === '\r')) n++;
    if (text[n] !== '\n') break;
    blank = true;
    n++;
  }
  if (blank || n >= text.length) {
    return true;
  }
  const p = lx.prevSignificant(nl);
  if (p >= 0 && CONTINUES_LINE.has(text[p]) && !(text[p] === '+' && text[p - 1] === '+') && !(text[p] === '-' && text[p - 1] === '-')) {
    return false;
  }
  const region = lx.regionAt(n);
  if (region === 'comment' || region === 'doc') {
    return false;
  }
  if (CONTINUES_FROM.has(text[n]) && !(text[n] === '+' && text[n + 1] === '+') && !(text[n] === '-' && text[n + 1] === '-')) {
    return false;
  }
  const word = /^[\p{ID_Start}_$][\p{ID_Continue}$]*/u.exec(text.slice(n, n + 24));
  return !(word && CONTINUES_WORD.has(word[0]));
}

/** Keywords after which a `(…) =>` is a function type. */
const TYPE_ARROW_KEYWORDS = new Set(['as', 'satisfies', 'extends', 'implements', 'keyof', 'typeof', 'new', 'is', 'infer', 'readonly']);
/** Words before `name:` that make the colon a type annotation. */
const ANNOTATED_DECL_WORDS = new Set([
  'let', 'const', 'var', 'readonly', 'public', 'private', 'protected', 'static', 'declare', 'abstract', 'override', 'accessor',
]);

interface TypeArrows {
  /** Offsets of every `=>` that writes a function type, not a function. */
  arrows: Set<number>;
  /** Their parameter lists, `(` to the arrow, sorted. Names there are documentation. */
  params: { start: number; end: number }[];
}

const typeArrowMemo = new WeakMap<LexResult, Map<string, TypeArrows>>();

/**
 * The `=>` arrows of a TypeScript file that sit in type position: a type alias
 * (`type H = (e: Event) => void`), an annotation (`cb: (x) => void`,
 * `(): () => void {`), a union, generic argument or `as` target, or a curried
 * arrow inside one of those. Other languages have none.
 */
export function typeArrowsOf(lx: LexResult, languageId?: string): TypeArrows {
  const key = languageId ?? '';
  let perLang = typeArrowMemo.get(lx);
  if (!perLang) {
    perLang = new Map();
    typeArrowMemo.set(lx, perLang);
  }
  const hit = perLang.get(key);
  if (hit) {
    return hit;
  }
  const result: TypeArrows = { arrows: new Set(), params: [] };
  if (languageId !== undefined && TYPED_ARROW_LANGUAGES.has(languageId)) {
    const text = lx.text;
    for (const arrowAt of findArrowOffsets(text, lx)) {
      // A function type always parenthesizes its parameters, so only a `(…)` right
      // before the arrow can start one; `(n: number): string => n` is a value arrow
      // whose return type happens to sit there.
      const q = lx.prevSignificant(arrowAt);
      const own = q >= 0 && text[q] === ')' ? paramStartBefore(text, arrowAt) : -1;
      let start = own >= 0 && typePositionBefore(lx, own, result.arrows, 0) ? own : -1;
      if (start < 0) {
        const typed = paramStartBefore(text, returnTypeStart(text, arrowAt, lx));
        start = typed >= 0 && typed !== own && typePositionBefore(lx, typed, result.arrows, 0) ? typed : -1;
      }
      if (start >= 0) {
        result.arrows.add(arrowAt);
        result.params.push({ start, end: arrowAt });
      }
    }
    result.params.sort((a, b) => a.start - b.start);
  }
  perLang.set(key, result);
  return result;
}

/** Is the expression starting at `start` (a parameter list) in type position? */
function typePositionBefore(lx: LexResult, start: number, typeArrows: Set<number>, nesting: number): boolean {
  const text = lx.text;
  const q = lx.prevSignificant(start);
  if (q < 0 || !lx.isCode(q)) {
    return false;
  }
  const c = text[q];
  if (c === '>' && text[q - 1] === '=') {
    return typeArrows.has(q - 1);
  }
  if (c === ':') {
    return annotationColon(lx, q, nesting);
  }
  if ((c === '|' && text[q - 1] !== '|') || (c === '&' && text[q - 1] !== '&') || (c === '<' && text[q - 1] !== '<')) {
    return true;
  }
  if (c === '=' && !/[=!<>+\-*/%&|^?]/.test(text[q - 1] ?? '')) {
    return /\btype\s+[\p{ID_Start}_$][\p{ID_Continue}$]*\s*(<[^;{}()]*>)?\s*$/u.test(text.slice(Math.max(0, q - 200), q));
  }
  if (c === '(' && nesting < 4) {
    return typePositionBefore(lx, q, typeArrows, nesting + 1);
  }
  if (c === ',') {
    return inTypeArguments(lx, q);
  }
  if (/[\p{ID_Continue}$]/u.test(c)) {
    return TYPE_ARROW_KEYWORDS.has(wordEndingAt(text, q));
  }
  return false;
}

/** Is the code `:` at `colon` a type annotation (not an object key or a ternary)? */
function annotationColon(lx: LexResult, colon: number, nesting: number): boolean {
  const text = lx.text;
  if (inTernary(lx, colon)) {
    return false;
  }
  const r = lx.prevSignificant(colon);
  if (r < 0) {
    return false;
  }
  if (text[r] === ')' || text[r] === '?') {
    return true;
  }
  if (!/[\p{ID_Continue}$]/u.test(text[r])) {
    return false;
  }
  const word = wordEndingAt(text, r);
  const b = lx.prevSignificant(r - word.length + 1);
  if (b >= 0 && /[\p{ID_Continue}$]/u.test(text[b]) && ANNOTATED_DECL_WORDS.has(wordEndingAt(text, b))) {
    return true;
  }
  const open = lx.enclosingOpen(colon);
  if (open < 0) {
    return false;
  }
  if (text[open] === '(') {
    return true;
  }
  return text[open] === '{' && typeBrace(lx, open, nesting);
}

/** Is the `{` at `open` a class, interface or type-literal body? */
function typeBrace(lx: LexResult, open: number, nesting: number): boolean {
  const text = lx.text;
  let s = open - 1;
  while (s >= 0 && open - s < 300 && !(lx.isCode(s) && (text[s] === ';' || text[s] === '{' || text[s] === '}'))) s--;
  const header = text.slice(s + 1, open);
  if (/\b(class|interface)\b/.test(header) || /\btype\s+[\p{ID_Start}_$][\p{ID_Continue}$]*[^=]*=\s*$/u.test(header)) {
    return true;
  }
  const q = lx.prevSignificant(open);
  return q >= 0 && text[q] === ':' && nesting < 4 && annotationColon(lx, q, nesting + 1);
}

/** Is the `,` at `comma` inside a generic argument list (`Map<string, (x) => void>`)? */
function inTypeArguments(lx: LexResult, comma: number): boolean {
  const text = lx.text;
  let depth = 0;
  let angle = 0;
  for (let i = comma - 1; i >= 0 && comma - i < 400; i--) {
    if (!lx.isCode(i)) continue;
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') {
      depth++;
    } else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) return false;
      depth--;
    } else if (depth === 0) {
      if (c === ';') return false;
      if (c === '>' && text[i - 1] !== '=' && text[i - 1] !== '-') {
        angle++;
      } else if (c === '<') {
        if (angle === 0) return /[\p{ID_Continue}$]/u.test(text[i - 1] ?? '');
        angle--;
      }
    }
  }
  return false;
}

/** Is there a ternary `?` before `colon` in the same bracket and statement? */
function inTernary(lx: LexResult, colon: number): boolean {
  const text = lx.text;
  let depth = 0;
  for (let i = colon - 1; i >= 0 && colon - i < 400; i--) {
    if (!lx.isCode(i)) continue;
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') {
      depth++;
    } else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) return false;
      depth--;
    } else if (depth === 0) {
      if (c === ';' || c === ',') return false;
      if (c === '?' && text[i + 1] !== '.' && text[i + 1] !== '?' && text[i + 1] !== ':' && text[i - 1] !== '?') {
        return true;
      }
    }
  }
  return false;
}

function wordEndingAt(text: string, end: number): string {
  let i = end;
  while (i >= 0 && /[\p{ID_Continue}$]/u.test(text[i])) i--;
  return text.slice(i + 1, end + 1);
}

/**
 * Blocks for INDENTATION-SCOPED languages — Python.
 *
 * `scanBraceBlocks` finds `{…}` pairs, so on a Python file it finds almost
 * nothing: on samples/sample.py it returned ONE block, the dict literal
 * `{"env": "dev"}` on line 56. Every caret therefore fell through to
 * `topLevelBlock`, which spans the whole file — so the "focused block" was the
 * entire module, every name in it was a top-level declaration, and the layer
 * tinted the lot. That is the "it continuously highlights the entire file"
 * symptom, and the dataclass fields reading as data are the same bug: with the
 * module as the scope, `name: str` is a top-level binding.
 *
 * A block here is a COLON-HEADED SUITE: a line ending in `:` opens a block that
 * runs until the first later line whose indentation is less than or equal to the
 * header's. That is the whole of Python's block rule, and it needs no parser.
 *
 * Four things make it correct rather than merely plausible:
 *
 *   - Continuation lines are skipped. A header can span lines
 *     (`def f(\n  a,\n  b\n) -> int:`), and a bracket depth counter is the only
 *     way to know the `:` that matters is the one at depth 0. This also stops a
 *     dict literal's `"key": value` from opening a block.
 *   - Strings and comments are skipped, via the shared lexer, so a `:` inside a
 *     docstring or a `#` comment never opens a block.
 *     Docstrings matter especially: they are conventional on every module,
 *     class and function, and they routinely contain colons.
 *   - Blank lines and comment-only lines do not close a block. They carry no
 *     indentation information, and a blank line between two methods must not
 *     end the class.
 *   - The `depth` field is the NESTING depth, counted from the enclosing suite
 *     stack rather than from the raw indent width, so a file mixing 2- and
 *     4-space indents still nests correctly and `innermostBlock` can compare
 *     depths across the two scanners.
 *
 * `headerStart`/`openOffset`/`closeOffset` keep the same meaning as for a brace
 * block, so every downstream consumer — `declRegionFor`, `scopeRegionFor`,
 * `lexRegionFor`, `focusKeyOf` — works unchanged. `openOffset` is the colon,
 * which is the closest analogue of the `{`: everything after it is body, and
 * everything from `headerStart` to it is the header carrying the parameters.
 */
export function scanIndentBlocks(text: string): BraceBlock[] {
  const lx = lexFor(text, 'python');
  const lines = text.split('\n');
  const lineStarts = lx.lineStarts;

  // Per physical line: is it a continuation of an earlier logical line, and where
  // is its last depth-0 code `:`. A line's continuation flag is the state at its
  // START: inside brackets, inside a multi-line string, or after a code `\`.
  const colonAt: (number | null)[] = new Array(lines.length).fill(null);
  const continuation: boolean[] = new Array(lines.length).fill(false);
  {
    const P = lx.punct;
    let bracket = 0;
    let k = 0;
    for (let li = 0; li < lines.length; li++) {
      if (li > 0) {
        const nl = lineStarts[li] - 1;
        let bs = nl - 1;
        if (text[bs] === '\r') bs--;
        continuation[li] = bracket > 0 || !lx.isCode(nl) || (text[bs] === '\\' && lx.isCode(bs));
      }
      const lineEnd = li + 1 < lines.length ? lineStarts[li + 1] : text.length;
      for (; k < P.length && P[k] < lineEnd; k++) {
        const c = text[P[k]];
        if (c === '(' || c === '[' || c === '{') {
          bracket++;
        } else if (c === ')' || c === ']' || c === '}') {
          bracket = Math.max(0, bracket - 1);
        } else if (c === ':' && bracket === 0) {
          // Only a colon at bracket depth 0 can open a suite. Annotations
          // (`x: int`) also sit at depth 0, so requiring the colon to be the
          // last non-comment character on the line (isHeader below) is what
          // separates `def f():` from `name: str`.
          colonAt[li] = P[k];
        }
      }
    }
  }

  // Fold the colon of a multi-line header onto the line the header STARTS on. A
  // signature that wraps puts its `:` on the last physical line —
  //
  //   def fold(
  //       cfgs: list[Config],
  //   ) -> T:            <-- the colon is here, on a continuation line
  //
  // and a continuation line is not a header, so keying on the physical line
  // dropped every wrapped signature: 3 of the 4 wrapped headers in the traps
  // file, and the block never existed. `logicalStart[li]` is the first physical
  // line of li's logical line, and the colon is attributed there — which is also
  // the line whose indentation governs the suite.
  const logicalStart: number[] = new Array(lines.length).fill(0);
  for (let li = 0, head = 0; li < lines.length; li++) {
    if (!continuation[li]) {
      head = li;
    }
    logicalStart[li] = head;
  }
  const headerColon: (number | null)[] = new Array(lines.length).fill(null);
  const headerEndLine: number[] = new Array(lines.length).fill(0);
  for (let li = 0; li < lines.length; li++) {
    if (colonAt[li] === null) {
      continue;
    }
    const head = logicalStart[li];
    // Last colon of the logical line wins: `def f() -> dict[str, int]:` has the
    // annotation colons inside brackets (already excluded), but `else:` after a
    // one-line `if x: pass` would leave two, and the later one opens the suite.
    headerColon[head] = colonAt[li];
    headerEndLine[head] = li;
  }

  // Trailing content after the colon disqualifies it as a block opener UNLESS it
  // is only a comment — `def f():  # note` is still a header, `x: int = 1` is not.
  const isHeader = (li: number): boolean => {
    const col = headerColon[li];
    if (col === null || continuation[li]) {
      return false;
    }
    const endLine = headerEndLine[li];
    const after = lines[endLine].slice(col - lineStarts[endLine] + 1);
    return after.trim() === '' || after.trimStart().startsWith('#');
  };

  const indentOf = (s: string): number => {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (ch === 32) {
        n++;
      } else if (ch === 9) {
        n += 8 - (n % 8);
      } else {
        break;
      }
    }
    return n;
  };
  // A blank or comment-only line carries no indentation information, so it can
  // neither open nor close a block. Without this a blank line between two
  // methods would close the class.
  const isVoid = blankOrHashLine;

  const blocks: BraceBlock[] = [];
  const stack: { openLine: number; indent: number; openOffset: number; headerStart: number }[] = [];

  const close = (upTo: number, endLine: number): void => {
    while (stack.length > 0 && stack[stack.length - 1].indent >= upTo) {
      const open = stack.pop()!;
      // End at the last non-void line of the body, so trailing blank lines
      // between two functions belong to neither.
      let last = endLine;
      while (last > open.openLine && (last >= lines.length || isVoid(lines[last]))) {
        last--;
      }
      blocks.push({
        openLine: open.openLine,
        closeLine: last,
        depth: stack.length,
        openOffset: open.openOffset,
        closeOffset: Math.max(open.openOffset, lineStarts[last] + lines[last].length - 1),
        headerStart: open.headerStart,
      });
    }
  };

  for (let li = 0; li < lines.length; li++) {
    if (continuation[li] || isVoid(lines[li])) {
      continue;
    }
    const indent = indentOf(lines[li]);
    // A suite headed at indent `h` owns exactly the lines indented DEEPER than
    // `h`, so any line at indent `i` closes every open suite whose header indent
    // is `>= i`. The `>=` is what closes SIBLINGS: a second `def` at indent 4
    // has to end the previous `def` at indent 4, while leaving the enclosing
    // `class` at indent 0 open. Using `> i` instead left every sibling nested
    // inside its predecessor, so the first class in the file appeared to run to
    // the last line and nothing ever closed.
    close(indent, li - 1);
    if (isHeader(li)) {
      stack.push({
        openLine: li,
        indent,
        openOffset: headerColon[li]!,
        headerStart: lineStarts[li],
      });
    }
  }
  close(0, lines.length - 1);

  return blocks.sort((a, b) => a.openOffset - b.openOffset);
}

/**
 * Synthetic blocks for Python's BRACELESS, COLONLESS binding scopes — the
 * comprehension and the lambda.
 *
 *   jobs = [one(name) for name in names]
 *   timeout_sum = fold(cfgs, 0, lambda acc, item: acc + item.timeout)
 *
 * Both bind names (`name`, `acc`, `item`) and both are real scopes at runtime, but
 * neither has a brace OR a colon-headed suite, so `scanIndentBlocks` cannot see
 * them. Their variables therefore belonged to the enclosing function, where they
 * competed for its hues, and putting the caret inside one focused the whole
 * function instead of the comprehension. This is the same problem `scanArrowBlocks`
 * solves for JS's concise arrow bodies, and the same shape of fix.
 *
 * A comprehension spans its opening bracket to the matching close; a lambda spans
 * `lambda` to the end of its body expression — the first `,` or `)` that is not
 * nested inside brackets or a string, exactly as for an arrow.
 *
 * Depth is the enclosing suite's depth plus one, so the comprehension always
 * out-depths its parent and `innermostBlock` prefers it.
 */
function scanPyExprBlocks(text: string, suites: BraceBlock[]): BraceBlock[] {
  const lx = lexFor(text, 'python');
  const out: BraceBlock[] = [];
  const lineOf = (offset: number): number => lx.lineOf(offset);
  // One deeper than the deepest suite with openOffset < offset <= closeOffset.
  const deepest = buildIntervalIndex(
    suites.map((s) => s.openOffset + 1),
    suites.map((s) => s.closeOffset + 1),
    (a, b) => suites[b].depth - suites[a].depth || a - b,
  );
  const depthAt = (offset: number): number => {
    const i = bestAt(deepest, offset);
    return i < 0 ? 0 : suites[i].depth + 1;
  };

  // One ordered walk over code brackets and code `for` / `lambda` keywords. A
  // bracket span is a COMPREHENSION when a `for` sits at its own depth — that
  // keyword is what makes it a scope rather than a plain list/dict/call.
  const brackets: { open: number; close: number }[] = [];
  const lambdas: number[] = [];
  const opens: { at: number; comp: boolean }[] = [];
  const P = lx.punct;
  const ids = lx.idents;
  let k = 0;
  for (let q = 0; q <= ids.length; q++) {
    const idAt = q < ids.length ? ids[q].offset : text.length;
    for (; k < P.length && P[k] < idAt; k++) {
      const c = text[P[k]];
      if (c === '[' || c === '(' || c === '{') {
        opens.push({ at: P[k], comp: false });
      } else if (c === ']' || c === ')' || c === '}') {
        const open = opens.pop();
        if (open !== undefined && open.comp) brackets.push({ open: open.at, close: P[k] });
      }
    }
    if (q === ids.length) break;
    const name = ids[q].name;
    if (name === 'for' && opens.length > 0) {
      opens[opens.length - 1].comp = true;
    } else if (name === 'lambda') {
      lambdas.push(ids[q].offset);
    }
  }

  for (const b of brackets) {
    out.push({
      openLine: lineOf(b.open),
      closeLine: lineOf(b.close),
      depth: depthAt(b.open),
      openOffset: b.open,
      closeOffset: b.close,
      headerStart: b.open,
    });
  }

  for (const at of lambdas) {
    const end = pyExprEnd(text, at, lx);
    out.push({
      openLine: lineOf(at),
      closeLine: lineOf(end),
      depth: depthAt(at),
      openOffset: at,
      closeOffset: end,
      headerStart: at,
    });
  }
  return out;
}

/**
 * End of a lambda: the first `,` or closing bracket at depth 0 AFTER the body has
 * started, or end of line.
 *
 * The subtlety is that a lambda has TWO comma-separated regions and only the
 * second may be terminated by a comma:
 *
 *   fold(cfgs, 0, lambda acc, item: acc + item.timeout)
 *                        ^^^^^^^^^ parameters — commas here are the lambda's own
 *                                   ^^^^^^^^^^^^^^^^^ body — a comma here ends it
 *
 * Stopping at the first comma unconditionally cut the block at `lambda acc`, so
 * its parameter list was half-covered and its body not at all — the block existed
 * but described the wrong text. The `:` that opens the body is the switch, and it
 * has to be found at depth 0 so an annotation or dict inside a default cannot be
 * mistaken for it.
 */
function pyExprEnd(text: string, from: number, lx: LexResult): number {
  let nl = text.indexOf('\n', from);
  while (nl >= 0 && !lx.isCode(nl)) nl = text.indexOf('\n', nl + 1);
  let limit = nl < 0 ? text.length : nl;
  for (let k = lx.spanIndexFrom(from); k < lx.spans.length && lx.spans[k].start < limit; k++) {
    if (lx.spans[k].region === 'comment') {
      limit = lx.spans[k].start;
      while (limit - 1 > from && /\s/.test(text[limit - 1])) limit--;
      break;
    }
  }
  let depth = 0;
  let inBody = false;
  const P = lx.punct;
  for (let k = lx.punctFrom(from); k < P.length && P[k] < limit; k++) {
    const i = P[k];
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i - 1;
      depth--;
      continue;
    }
    if (depth === 0 && c === ':' && !inBody) { inBody = true; continue; }
    if (depth === 0 && c === ',' && inBody) return i - 1;
  }
  return limit - 1;
}

/**
 * Rust CLOSURES whose body is a bare expression: `|c| c.name`, `|a, b| a + b`.
 *
 * A closure IS a scope — its parameters are bindings, and it captures from the
 * enclosing frame — but a braceless one has no `{` for the brace scanner to find.
 * The effect is the same one Python lambdas had before `scanPyExprBlocks`: the
 * caret inside `.map(|c| ...)` fell through to the enclosing function, so `c`
 * classified as a local of the OUTER scope rather than a parameter of the closure.
 * `samples/sample.rs` states the contract in its own header — "closures: captured
 * `prefix` + iterator params keep stable hues" — and an iterator chain of bare
 * closures is the single most common shape in idiomatic Rust.
 *
 * A closure with a braced body (`|c| { ... }`) is already found by the brace
 * scanner and is skipped here, so the two never produce overlapping blocks.
 *
 * The `|` is deliberately hard to match: it is also bitwise-or, `||` is logical
 * or, and an or-PATTERN in a match arm (`A | B => ...`) uses it too. The opener
 * therefore requires the `|` to sit where a VALUE cannot have just ended — after
 * `(`, `,`, `=`, `=>`, `{`, `;`, `:`, `move` or `return` — because `a | b` always
 * has an operand before it. Two shapes that slipped through an earlier draft and
 * are now excluded explicitly:
 *
 *   Status::Pending => "pending",   `=` matched the `=` of `=>`, and the arm's
 *                                   own trailing comma looked like a body end
 *   F: Fn(T, &Config) -> T,         a `where` clause: the `,` before a bound's
 *                                   `|`-free text still opened a candidate
 *
 * so `=` must not be part of `=>`, `>=`, `<=`, `==` or `!=`, and the parameter
 * list must actually look like one — bare identifiers, `mut`, `&` and `_` only.
 */
function scanRustClosures(text: string, braced: BraceBlock[]): BraceBlock[] {
  const lx = lexFor(text, 'rust');
  const out: BraceBlock[] = [];
  // 0-based line of an offset. `innermostBlock` filters by caret LINE, so a block
  // with no openLine/closeLine can never be selected — the bug that left every
  // closure caret resolving to its enclosing function, so `name`/`acc`/`item`
  // inside a `.map(|x| …)` tinted against the wrong scope and read as page white.
  const lineOf = (offset: number): number => lx.lineOf(offset);
  const isBraced = (bodyStart: number): boolean => {
    // `|c| { ... }` — the brace scanner already owns it.
    const m = /^\s*\{/.exec(text.slice(bodyStart, bodyStart + 8));
    return m !== null;
  };
  // `(?<![=!<>])=` rejects the `=` of `==`, `!=`, `<=` and `>=`; `=>` is listed on
  // its own, so `_ => |x| x + 1` opens a closure.
  const re = /(?:[(,{;:]|(?<![=!<>])=|=>|\b(?:move|return))\s*(\|)(?!\|)/g;
  // Blocks with open <= x minus blocks with close < x is the number with
  // open <= x <= close, since every block's open precedes its close.
  const opens = braced.map((b) => b.openOffset).sort((a, b) => a - b);
  const closes = braced.map((b) => b.closeOffset).sort((a, b) => a - b);
  const containing = (x: number): number => countAtMost(opens, x) - countAtMost(closes, x - 1);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const bar = m.index + m[0].length - 1;
    if (!lx.isCode(bar)) continue;
    // The parameter list runs to the closing `|` on the same line. A `|` inside a
    // nested pattern cannot occur in a closure's parameter list, so a plain scan is
    // enough; bailing at the newline keeps a stray bitwise-or from running away.
    let close = -1;
    for (let i = bar + 1; i < text.length; i++) {
      if (text[i] === '\n') break;
      if (text[i] === '|') { close = i; break; }
    }
    if (close < 0) continue;
    // It must LOOK like a parameter list. A closure binds patterns, so only
    // identifiers, `mut`, `ref`, `&`, `_` and separators may appear between the
    // bars; anything else (a type path, an operator, a literal) means the `|`
    // pair was really two bitwise-ors or an or-pattern.
    const params = text.slice(bar + 1, close);
    if (params.length > 0 && !/^[\s&_a-zA-Z0-9,:<>()\[\]]*$/.test(params)) continue;
    const bodyStart = close + 1;
    if (isBraced(bodyStart)) continue;
    const end = rustExprEnd(text, bodyStart, lx);
    if (end <= bodyStart) continue;
    const depth = containing(bar);
    out.push({
      openLine: lineOf(bar),
      closeLine: lineOf(end),
      openOffset: bar,
      closeOffset: end,
      headerStart: bar,
      depth,
    });
  }
  return out;
}

/** Number of entries <= x in an ascending array. */
function countAtMost(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Where a braceless closure body ENDS: at the comma or closing bracket that
 * belongs to the call containing it, whichever comes first at depth 0.
 *
 * `.map(|c| format!("{}", c.name))` — the body ends at the `)` that closes `map`,
 * not at the one closing `format!`, so brackets have to be counted. Only code
 * punctuation counts (a `")"` or `','` literal is not a bracket or separator), and
 * a `//` comment ends the line.
 */
function rustExprEnd(text: string, from: number, lx: LexResult): number {
  const lineCommentEnd = (k: number): number => {
    const nl = text.indexOf('\n', lx.spans[k].start);
    return nl < 0 ? text.length - 1 : nl - 1;
  };
  const isLineComment = (k: number): boolean =>
    lx.spans[k].region === 'comment' && text.startsWith('//', lx.spans[k].start);
  let sk = lx.spanIndexFrom(from);
  let depth = 0;
  const P = lx.punct;
  for (let k = lx.punctFrom(from); k < P.length; k++) {
    const i = P[k];
    for (; sk < lx.spans.length && lx.spans[sk].start < i; sk++) {
      if (isLineComment(sk)) return lineCommentEnd(sk);
    }
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i - 1;
      depth--;
      continue;
    }
    if (depth === 0 && (c === ',' || c === ';')) return i - 1;
  }
  for (; sk < lx.spans.length; sk++) {
    if (isLineComment(sk)) return lineCommentEnd(sk);
  }
  return text.length - 1;
}

/**
 * Languages whose blocks come from INDENTATION, not braces. Lua and Ruby have
 * keyword scanners; everything else uses the brace scanner, including languages
 * with optional braces — a Nim file would need its own entry and its own trap
 * tests before being added here, and guessing costs more than it saves.
 */
const INDENT_SCOPED = new Set(['python']);

/**
 * Lua scopes from the keywords that open and close them: each `if` branch is its
 * own block, a `repeat` body runs to the end of its `until` condition, and a table
 * constructor is no scope. Offsets: docs/lua.md#blocks.
 */
export function scanLuaBlocks(text: string): BraceBlock[] {
  const lx = lexFor(text, 'lua');
  const ids = lx.idents;
  const P = lx.punct;
  type Open = { kind: 'fn' | 'pending' | 'pendingIf' | 'body' | 'repeat'; headerStart: number; openOffset: number };
  const stack: Open[] = [];
  const out: BraceBlock[] = [];
  const emit = (o: Open, closeOffset: number): void => {
    out.push({
      openLine: lx.lineOf(o.headerStart),
      closeLine: lx.lineOf(closeOffset),
      depth: stack.length,
      openOffset: o.openOffset,
      closeOffset: Math.max(o.openOffset, closeOffset),
      headerStart: o.headerStart,
    });
  };
  const member = (at: number): boolean => {
    const p = lx.prevSignificant(at);
    return p >= 0 && (text[p] === '.' || (text[p] === ':' && text[p - 1] !== ':')) && text[p - 1] !== '.';
  };
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    if (!LUA_BLOCK_WORDS.has(id.name) || member(id.offset)) continue;
    const top = stack[stack.length - 1];
    switch (id.name) {
      case 'function': {
        let q = lx.punctFrom(id.offset + id.length);
        while (q < P.length && text[P[q]] === ':') q++;
        if (q >= P.length || text[P[q]] !== '(') break;
        let depth = 0;
        let close = -1;
        for (let j = q; j < P.length; j++) {
          const c = text[P[j]];
          if (c === '(') depth++;
          else if (c === ')' && --depth === 0) {
            close = P[j];
            break;
          }
        }
        if (close < 0) break;
        const prev = ids[k - 1];
        const local = prev && prev.name === 'local' && /^\s*$/.test(text.slice(prev.offset + prev.length, id.offset));
        stack.push({ kind: 'fn', headerStart: local ? prev.offset : id.offset, openOffset: close + 1 });
        while (k + 1 < ids.length && ids[k + 1].offset < close) k++;
        break;
      }
      case 'for':
      case 'while':
        stack.push({ kind: 'pending', headerStart: id.offset, openOffset: -1 });
        break;
      case 'do':
        if (top && top.kind === 'pending') {
          top.kind = 'body';
          top.openOffset = id.offset + 2;
        } else {
          stack.push({ kind: 'body', headerStart: id.offset, openOffset: id.offset + 2 });
        }
        break;
      case 'if':
        stack.push({ kind: 'pendingIf', headerStart: id.offset, openOffset: -1 });
        break;
      case 'then':
        if (top && top.kind === 'pendingIf') {
          top.kind = 'body';
          top.openOffset = id.offset + 4;
        }
        break;
      case 'elseif':
      case 'else':
        if (top && top.kind === 'body' && /^(if|elseif|else)\b/.test(text.slice(top.headerStart, top.headerStart + 7))) {
          stack.pop();
          emit(top, lx.prevSignificant(id.offset));
          stack.push(id.name === 'else'
            ? { kind: 'body', headerStart: id.offset, openOffset: id.offset + 4 }
            : { kind: 'pendingIf', headerStart: id.offset, openOffset: -1 });
        }
        break;
      case 'repeat':
        stack.push({ kind: 'repeat', headerStart: id.offset, openOffset: id.offset + 6 });
        break;
      case 'until':
        if (top && top.kind === 'repeat') {
          stack.pop();
          emit(top, untilEnd(lx, id.offset + id.length));
        }
        break;
      case 'end':
        if (top) {
          stack.pop();
          if (top.openOffset >= 0) emit(top, id.offset + 2);
        }
        break;
    }
  }
  return withSlots(out.sort((a, b) => a.openOffset - b.openOffset));
}

const LUA_BLOCK_WORDS = new Set(['function', 'for', 'while', 'do', 'if', 'then', 'elseif', 'else', 'repeat', 'until', 'end']);

/** Last code char of an `until` condition: the end of its line once its brackets close. */
function untilEnd(lx: LexResult, from: number): number {
  const text = lx.text;
  const P = lx.punct;
  let depth = 0;
  let k = lx.punctFrom(from);
  let i = from;
  for (;;) {
    let nl = text.indexOf('\n', i);
    if (nl < 0) nl = text.length;
    for (; k < P.length && P[k] < nl; k++) {
      const c = text[P[k]];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    }
    if (depth === 0 || nl >= text.length) return Math.max(from - 1, lx.prevSignificant(nl));
    i = nl + 1;
  }
}

/** Lua blocks whose header is control flow; the header starts at the keyword. */
const LUA_CONTROL = /^(if|elseif|else|for|while|repeat|do)\b/;

/** Ruby blocks whose header is control flow: each branch of a conditional, `case`, `begin` / `rescue`, and the loops. */
const RUBY_CONTROL = /^(if|elsif|else|unless|while|until|for|case|when|in|begin|rescue|ensure)\b/;

const RUBY_BLOCK_WORDS = new Set([
  'def', 'class', 'module', 'do', 'begin', 'if', 'unless', 'while', 'until', 'for', 'case', 'when', 'in',
  'elsif', 'else', 'rescue', 'ensure', 'end', 'BEGIN', 'END',
]);
/** Words before `if` / `unless` / `while` / `until` / `rescue` after which it starts an expression rather than a modifier. */
const RUBY_EXPR_BEFORE = new Set(['then', 'else', 'do', 'begin', 'ensure', 'and', 'or', 'not', 'when', 'in', 'elsif', 'if', 'unless', 'while', 'until', 'case']);
/** Words before `{` after which it opens a hash, not a block. */
const RUBY_HASH_AFTER = new Set([
  'return', 'then', 'else', 'do', 'when', 'in', 'and', 'or', 'not', 'if', 'unless', 'while', 'until', 'elsif',
  'yield', 'case', 'begin', 'ensure', 'rescue', 'break', 'next', 'redo', 'puts', 'p', 'print', 'raise',
]);
const RUBY_DEF_NAME = /^[ \t]+(?:(?:self|@{0,2}[A-Za-z_]\w*|\$\w+)[ \t]*(?:\.|::)[ \t]*)?(\[\]=|\[\]|===|<=>|==|=~|!=|!~|\*\*|<<|>>|<=|>=|\+@|-@|[+\-*/%&|^~<>!`]|[A-Za-z_]\w*(?:[?!]|=(?![=~>]))?)/;

/** The word ending at `p` (letters, digits, `_`, a trailing `?` or `!`), or ''. */
function rubyWordEndingAt(text: string, p: number): string {
  let w = p;
  if (text[w] === '?' || text[w] === '!') w--;
  while (w >= 0 && /\w/.test(text[w])) w--;
  return text.slice(w + 1, p + 1);
}

/** A keyword in member (`x.end`, `Foo::new`) or label (`if: x`) position is a name, not a keyword. */
function rubyNotKeyword(lx: LexResult, offset: number, length: number): boolean {
  const text = lx.text;
  let p = offset - 1;
  while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) p--;
  if (text[p] === '.' || (text[p] === ':' && text[p - 1] === ':')) return true;
  const n = offset + length;
  return text[n] === ':' && text[n + 1] !== ':';
}

/** Does a statement or an expression start at `at`, so that `if` / `while` / `rescue` there opens a block? */
function rubyStartsStatement(lx: LexResult, at: number): boolean {
  const text = lx.text;
  const p = lx.prevSignificant(at);
  if (p < 0) return true;
  if (text.slice(p + 1, at).includes('\n')) return text[p] !== '\\';
  const s = lx.spanAt(p);
  if (s !== undefined) return text[p] === '{' && text[p - 1] === '#' && lx.holeEndAt(p + 1) < text.length + 1 && lx.isCode(p + 1);
  const id = rubyIdentEndingAt(lx, p);
  if (id) return RUBY_EXPR_BEFORE.has(id.name) && !rubyNotKeyword(lx, id.offset, id.length);
  const c = text[p];
  if (/[\w]/.test(c)) return false;
  return c !== ')' && c !== ']' && c !== '}';
}

/** The code identifier whose last character is at `p`, if any. */
function rubyIdentEndingAt(lx: LexResult, p: number): LexId | undefined {
  const ids = lx.identsIn(Math.max(0, p - 256), p + 1);
  const id = ids[ids.length - 1];
  return id && id.offset + id.length - 1 === p ? id : undefined;
}

/** Does the code go on past the line break at `nl` (a trailing operator, comma, `\` or open-ended word)? */
function rubyContinues(lx: LexResult, nl: number, from: number): boolean {
  const text = lx.text;
  const p = lx.prevSignificant(nl);
  if (p < from) return false;
  if (lx.spanAt(p) !== undefined) return false;
  const c = text[p];
  if ((c === '?' || c === '!') && /\w/.test(text[p - 1] ?? '')) return false;
  if (/\w/.test(c)) {
    const w = rubyWordEndingAt(text, p);
    return w === 'and' || w === 'or' || w === 'not';
  }
  return /[,\\([{|&+\-*/%=<>^~!?:.]/.test(c) && !(c === '>' && text[p - 1] === '-');
}

/**
 * Where a header that starts at `from` ends: just past a terminator word (`then`, `do`)
 * or `;` at bracket depth 0, else the line break that ends its logical line.
 * `used` gets the terminator's offset.
 */
function rubyHeaderEnd(lx: LexResult, from: number, words: ReadonlySet<string>, used?: Set<number>): number {
  const text = lx.text;
  const P = lx.punct;
  let depth = 0;
  let k = lx.punctFrom(from);
  const q = lx.idents;
  let qi = identIndexFrom(lx, from);
  let pos = from;
  for (;;) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = text.length;
    while (lx.spanAt(nl) !== undefined && nl < text.length) {
      const s = lx.spanAt(nl)!;
      nl = text.indexOf('\n', s.end);
      if (nl < 0) nl = text.length;
    }
    for (;;) {
      const pp = k < P.length && P[k] < nl ? P[k] : Infinity;
      const ip = qi < q.length && q[qi].offset < nl ? q[qi].offset : Infinity;
      if (pp === Infinity && ip === Infinity) break;
      if (pp < ip) {
        const c = text[pp];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
        else if (c === ';' && depth === 0) return pp + 1;
        k++;
      } else {
        const id = q[qi];
        if (depth === 0 && words.has(id.name) && !rubyNotKeyword(lx, id.offset, id.length)) {
          used?.add(id.offset);
          return id.offset + id.length;
        }
        qi++;
      }
    }
    if (nl >= text.length || (depth === 0 && !rubyContinues(lx, nl, from))) return nl;
    pos = nl + 1;
  }
}

const RUBY_THEN = new Set(['then']);
const RUBY_DO = new Set(['do']);
const RUBY_NONE = new Set<string>();

/** Index of the first identifier at or after `offset`. */
function identIndexFrom(lx: LexResult, offset: number): number {
  const ids = lx.idents;
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid].offset < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Just past a block's `|params|` that starts at or after `from` on its line, else `from`. */
function rubyBlockParamsEnd(lx: LexResult, from: number): number {
  const text = lx.text;
  let i = from;
  while (i < text.length && (/\s/.test(text[i]) || lx.spanAt(i)?.region === 'comment')) i++;
  if (text[i] !== '|' || !lx.isCode(i)) return from;
  let depth = 0;
  for (let j = i + 1; j < text.length && j < i + 2000; j++) {
    if (!lx.isCode(j)) continue;
    const c = text[j];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '|' && depth <= 0) return j + 1;
  }
  return from;
}

/** The `->` a block opener at `open` belongs to (`->(x) {`, `-> x do`, `-> {`), else -1. */
function rubyLambdaArrow(lx: LexResult, open: number): number {
  const text = lx.text;
  const ls = lx.lineStarts[lx.lineOf(open)];
  const m = /->[ \t]*(?:\([^()]*\)|[\w, \t*&:=]*)[ \t]*$/.exec(text.slice(ls, open));
  return m && lx.isCode(ls + m.index) ? ls + m.index : -1;
}

/** Is the `{` at `brace` a block (`each {`, `foo(x) {`, `-> {`, `BEGIN {`) rather than a hash (`c ? {`, `!{`)? */
function rubyBraceBlock(lx: LexResult, brace: number): boolean {
  const text = lx.text;
  if (rubyLambdaArrow(lx, brace) >= 0) return true;
  const p = lx.prevSignificant(brace);
  if (p < 0 || lx.spanAt(p) !== undefined) return false;
  const c = text[p];
  if (c === ')' || c === ']') return true;
  if (!/[\w?!]/.test(c)) return false;
  const w = rubyWordEndingAt(text, p);
  if (w === '' || w === '?' || w === '!' || /^\d/.test(w)) return false;
  return !RUBY_HASH_AFTER.has(w) || text[p - w.length] === '.';
}

/**
 * Ruby scopes from the keywords that open and close them, and `{ … }` blocks:
 * `def` (endless ones run to the end of their expression), `class`, `module`,
 * `class << self`, `do … end` and brace blocks, lambdas, each branch of
 * `if` / `unless` / `case` / `begin` (and the `rescue` / `else` / `ensure` sections
 * of a `def` or `do` body), and the loops. Modifiers (`x if y`, `x rescue y`,
 * `x while y`) open nothing; a hash literal is no scope. Offsets: docs/ruby.md#blocks.
 */
export function scanRubyBlocks(text: string): BraceBlock[] {
  const lx = lexFor(text, 'ruby');
  const ids = lx.idents;
  const P = lx.punct;
  type Branch = { headerStart: number; openOffset: number };
  type Frame = {
    kind: 'own' | 'chain' | 'case' | 'begin' | 'hash' | 'endless';
    brace: boolean;
    headerStart: number;
    openOffset: number;
    br?: Branch;
    rescued?: boolean;
    closeAt?: number;
  };
  const stack: Frame[] = [];
  const out: BraceBlock[] = [];
  const used = new Set<number>();
  const depthAt = (i: number): number => {
    let d = 0;
    for (let j = 0; j < i; j++) d += (stack[j].kind === 'own' || stack[j].kind === 'endless' ? 1 : 0) + (stack[j].br ? 1 : 0);
    return d;
  };
  const emit = (headerStart: number, openOffset: number, closeOffset: number, depth: number): void => {
    out.push({
      openLine: lx.lineOf(headerStart),
      closeLine: lx.lineOf(Math.max(openOffset, closeOffset)),
      depth,
      openOffset,
      closeOffset: Math.max(openOffset, closeOffset),
      headerStart,
    });
  };
  const closeBranch = (f: Frame, closeOffset: number): void => {
    if (!f.br) return;
    const i = stack.indexOf(f);
    emit(f.br.headerStart, f.br.openOffset, closeOffset, depthAt(i) + (f.kind === 'own' ? 1 : 0));
    f.br = undefined;
  };
  const pop = (closeOffset: number, branchClose: number): void => {
    const f = stack[stack.length - 1];
    if (f.br) closeBranch(f, f.kind === 'own' ? branchClose : closeOffset);
    stack.pop();
    if (f.kind === 'own' || f.kind === 'endless') emit(f.headerStart, f.openOffset, closeOffset, depthAt(stack.length));
  };
  const settleEndless = (at: number): void => {
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'endless' || at <= top.closeAt!) return;
      pop(top.closeAt!, top.closeAt!);
    }
  };
  const afterClose = (closer: number): void => {
    const top = stack[stack.length - 1];
    if (top && top.kind === 'endless' && closer >= top.closeAt!) {
      top.closeAt = Math.max(closer, lx.prevSignificant(rubyHeaderEnd(lx, closer + 1, RUBY_NONE)));
    }
  };
  const ownBranch = (): Frame | undefined => {
    for (let j = stack.length - 1; j >= 0; j--) {
      const f = stack[j];
      if (f.kind === 'begin' || (f.kind === 'own' && !f.brace)) return f;
      if (f.kind !== 'endless') return undefined;
    }
    return undefined;
  };

  let k = 0;
  let q = 0;
  let skipUntil = -1;
  while (k < ids.length || q < P.length) {
    const pOff = q < P.length ? P[q] : Infinity;
    const iOff = k < ids.length ? ids[k].offset : Infinity;
    if (pOff < iOff) {
      q++;
      const c = text[pOff];
      if (c !== '{' && c !== '}') continue;
      settleEndless(pOff);
      if (c === '{') {
        if (rubyBraceBlock(lx, pOff)) {
          const arrow = rubyLambdaArrow(lx, pOff);
          const pk = lx.prevSignificant(pOff);
          const word = pk >= 0 ? rubyWordEndingAt(text, pk) : '';
          const header = arrow >= 0 ? arrow : word === 'BEGIN' || word === 'END' ? pk - word.length + 1 : pOff;
          stack.push({ kind: 'own', brace: true, headerStart: header, openOffset: rubyBlockParamsEnd(lx, pOff + 1) });
        } else {
          stack.push({ kind: 'hash', brace: true, headerStart: pOff, openOffset: pOff });
        }
      } else {
        while (stack.length > 0 && !stack[stack.length - 1].brace) stack.pop();
        if (stack.length > 0) {
          const f = stack[stack.length - 1];
          if (f.kind === 'own') pop(pOff, pOff);
          else stack.pop();
          afterClose(pOff);
        }
      }
      continue;
    }
    const id = ids[k++];
    if (id.offset < skipUntil || !RUBY_BLOCK_WORDS.has(id.name) || used.has(id.offset)) continue;
    if (rubyNotKeyword(lx, id.offset, id.length)) continue;
    settleEndless(id.offset);
    const top = stack[stack.length - 1];
    const end = id.offset + id.length;
    switch (id.name) {
      case 'def': {
        const m = RUBY_DEF_NAME.exec(text.slice(end, end + 200));
        if (!m) break;
        const nameEnd = end + m[0].length;
        let after = nameEnd;
        let i = nameEnd;
        while (text[i] === ' ' || text[i] === '\t') i++;
        if (text[i] === '(' && lx.isCode(i)) {
          let depth = 0;
          for (let j = lx.punctFrom(i); j < P.length; j++) {
            const ch = text[P[j]];
            if (ch === '(') depth++;
            else if (ch === ')' && --depth === 0) {
              after = P[j] + 1;
              break;
            }
          }
        } else if (text[i] !== '\n' && text[i] !== '\r' && text[i] !== ';' && text[i] !== '=' && text[i] !== '#' && i < text.length) {
          after = rubyHeaderEnd(lx, nameEnd, RUBY_NONE);
        }
        let e = after;
        while (text[e] === ' ' || text[e] === '\t') e++;
        if (text[e] === '=' && !/[=~>]/.test(text[e + 1] ?? '')) {
          const close = lx.prevSignificant(rubyHeaderEnd(lx, e + 1, RUBY_NONE));
          stack.push({ kind: 'endless', brace: false, headerStart: id.offset, openOffset: e + 1, closeAt: Math.max(e + 1, close) });
          skipUntil = e + 1;
        } else {
          stack.push({ kind: 'own', brace: false, headerStart: id.offset, openOffset: after });
          skipUntil = after;
        }
        break;
      }
      case 'class':
      case 'module':
        stack.push({ kind: 'own', brace: false, headerStart: id.offset, openOffset: rubyHeaderEnd(lx, end, RUBY_NONE) });
        break;
      case 'if':
      case 'unless':
        if (!rubyStartsStatement(lx, id.offset)) break;
        stack.push({ kind: 'chain', brace: false, headerStart: id.offset, openOffset: -1,
          br: { headerStart: id.offset, openOffset: rubyHeaderEnd(lx, end, RUBY_THEN, used) } });
        break;
      case 'while':
      case 'until':
        if (!rubyStartsStatement(lx, id.offset)) break;
        stack.push({ kind: 'own', brace: false, headerStart: id.offset, openOffset: rubyHeaderEnd(lx, end, RUBY_DO, used) });
        break;
      case 'for':
        stack.push({ kind: 'own', brace: false, headerStart: id.offset, openOffset: rubyHeaderEnd(lx, end, RUBY_DO, used) });
        break;
      case 'case':
        stack.push({ kind: 'case', brace: false, headerStart: id.offset, openOffset: -1 });
        break;
      case 'when':
      case 'in':
        if (!top || top.kind !== 'case' || !rubyStartsStatement(lx, id.offset)) break;
        closeBranch(top, lx.prevSignificant(id.offset));
        top.br = { headerStart: id.offset, openOffset: rubyHeaderEnd(lx, end, RUBY_THEN, used) };
        break;
      case 'elsif':
        if (!top || top.kind !== 'chain') break;
        closeBranch(top, lx.prevSignificant(id.offset));
        top.br = { headerStart: id.offset, openOffset: rubyHeaderEnd(lx, end, RUBY_THEN, used) };
        break;
      case 'else': {
        const f = top && (top.kind === 'chain' || top.kind === 'case') ? top : ownBranch();
        if (!f || (f.kind === 'own' && !f.rescued)) break;
        closeBranch(f, lx.prevSignificant(id.offset));
        f.br = { headerStart: id.offset, openOffset: end };
        break;
      }
      case 'begin':
        stack.push({ kind: 'begin', brace: false, headerStart: id.offset, openOffset: -1, br: { headerStart: id.offset, openOffset: end } });
        break;
      case 'rescue':
      case 'ensure': {
        if (id.name === 'rescue' && !rubyStartsStatement(lx, id.offset)) break;
        const f = ownBranch();
        if (!f) break;
        closeBranch(f, lx.prevSignificant(id.offset));
        f.br = { headerStart: id.offset, openOffset: id.name === 'rescue' ? rubyHeaderEnd(lx, end, RUBY_THEN, used) : end };
        if (id.name === 'rescue') f.rescued = true;
        break;
      }
      case 'do': {
        const arrow = rubyLambdaArrow(lx, id.offset);
        stack.push({ kind: 'own', brace: false, headerStart: arrow >= 0 ? arrow : id.offset, openOffset: rubyBlockParamsEnd(lx, end) });
        break;
      }
      case 'end': {
        if (!top || top.brace) break;
        pop(id.offset + 2, lx.prevSignificant(id.offset));
        afterClose(id.offset + 2);
        break;
      }
    }
  }
  settleEndless(Infinity);
  return withSlots(out.sort((a, b) => a.openOffset - b.openOffset));
}

/**
 * The ids markdown-language-features serves as markdown, so its links carry the
 * underline the cancellation removes. vscode.prompt gives the four chat
 * customisation ids a grammar that is markdown's alone
 * (test/fixtures/markdown-languages.json).
 */
const MARKDOWN_LANGUAGES = new Set(['markdown', 'prompt', 'instructions', 'chatagent', 'skill']);

export const markdownLanguages = (): string[] => [...MARKDOWN_LANGUAGES];

/**
 * Languages that are PROSE, not data flow: they have no scopes to focus, so bands
 * 2–3 must never paint in them and the phase stays Survey while the caret moves.
 *
 * This is not an optimisation, it is the register. `samples/sample.md` states the
 * contract in its own text — "there are no identity tints here and the phase stays
 * Survey 構 while the caret moves through text. That is deliberate: prose is not
 * data flow." The MARKDOWN_LANGUAGES get exactly two marks from this extension (the
 * `==highlight==` wash and the link-underline cancellation) and both are band 1.
 *
 * The bug this closes: a markdown file DOES contain braces — every fenced Go, TS or
 * JSON block in it — so `scanBraceBlocks` found real blocks, and a caret in prose
 * fell through to the synthetic whole-file scope. That made the entire document one
 * "function" whose most frequent words are `the`, `a` and `The`, so the layer
 * cheerfully tinted English articles as data identities.
 */
const PROSE_LANGUAGES = new Set([
  ...MARKDOWN_LANGUAGES, 'plaintext', 'restructuredtext', 'asciidoc', 'latex', 'tex', 'bibtex',
  'quarto', 'rmarkdown', 'mdx', 'juliamarkdown', 'git-commit', 'log',
]);

/**
 * STATIC CONTENT / DATA-FORMAT languages: config, markup and data files that have
 * braces and identifiers but no DATA FLOW — nothing moves through them, so there is
 * no binding to trace and bands 2–3 have nothing to say. A JSON object's keys are
 * schema, not locals; an XML tag is structure, not a variable. HTML is not here: its
 * scripts are code and its markup is outside every scope (docs/html.md).
 *
 * They are kept SEPARATE from PROSE_LANGUAGES because the two are different claims —
 * prose is "not code", this is "code-shaped but not imperative" — but they take the
 * same action: no focusable scope, so the phase stays Survey and the layer never
 * tints. The difference matters for the block scanner: a JSON/YAML/XML file is full
 * of braces or tags, so unlike prose it would otherwise produce a dense forest of
 * meaningless blocks and light up quoted keys as it was navigated.
 *
 * CSS/SCSS/LESS and Tailwind's `tailwindcss` mode are included: a selector, a
 * property name or a custom property is not a data identity
 * (docs/html.md#data-identities-and-marks).
 * Templates (`erb`, `helm`, `gotmpl`, `handlebars`) are too: their tags have no lexer
 * family yet (docs/ruby.md#erb-templates, docs/containers.md#go-template-variables,
 * docs/html.md#ids).
 * Each id must be one VS Code or the format's own extension registers, so a made-up
 * id cannot silently disable the layer for a real code file.
 * `test/fixtures/static-languages.json` names the extension (null: none installed).
 */
const STATIC_CONTENT_LANGUAGES = new Set([
  'json', 'jsonc', 'json5', 'jsonl', 'snippets', 'yaml', 'github-actions-workflow', 'dockercompose',
  'toml', 'kdl', 'ini', 'properties', 'java-properties', 'dotenv', 'ignore', 'pip-requirements',
  'go.mod', 'go.sum', 'go.work', 'dockerbake', 'cmake-cache', 'dts',
  'xml', 'xsl', 'dtd', 'rnc', 'xhtml', 'vue-html', 'svg',
  'css', 'scss', 'less', 'sass', 'stylus', 'tailwindcss',
  'graphql', 'proto', 'csv', 'tsv', 'csv (pipe)', 'csv (semicolon)', 'csv (whitespace)', 'dynamic csv',
  'dockerfile', 'makefile', 'erb', 'helm', 'gotmpl', 'handlebars',
]);

export const staticContentLanguages = (): string[] => [...STATIC_CONTENT_LANGUAGES];

/**
 * Ids the layer gives a document itself (`effectiveLanguageId`), no extension
 * registers them, each with the language band 1 restores it as. A TypeScript
 * declaration file holds signatures only, so it has no data flow; band 1 still
 * restores it as TypeScript (docs/javascript.md#declaration-files). ZON is data,
 * and band 1 restores nothing in it (docs/zig.md#zon).
 */
const DERIVED_STATIC_LANGUAGES = new Map([['typescript-declaration', 'typescript'], ['zon', 'zon'], ['html-template', 'html-template']]);

/** The language band 1 restores a document as: a derived static id's grammar language, else the id itself. */
export function band1LanguageId(languageId: string): string {
  return DERIVED_STATIC_LANGUAGES.get(languageId) ?? languageId;
}

const RUBY_TEMPLATE = /\.(erb|rhtml|rhtm)$/i;
const TS_DECLARATION = /\.d\.(?:[cm]?ts|[^./\\]+\.ts)$/i;
/** The `html` extensions that hold a server template language, whose tags the grammar paints as text (docs/html.md#ids). */
const HTML_TEMPLATE = /\.(?:jsp|asp|aspx|ejs|volt|jshtm|rhtml|mdoc)$/i;

/**
 * The language id the layer reads a document as. VS Code's built-in Ruby extension
 * claims `.erb`, so without Shopify.ruby-lsp a template opens as `ruby`; it is read
 * as `erb`, static content (docs/ruby.md#erb-templates). VS Code opens a `.d.ts`,
 * `.d.mts`, `.d.cts` or `.d.<ext>.ts` file as `typescript`; it is read as
 * `typescript-declaration`. ziglang.vscode-zig opens a `.zon` file as `zig`; it is
 * read as `zon`.
 */
export function effectiveLanguageId(languageId: string, fileName: string): string {
  if (languageId === 'ruby' && RUBY_TEMPLATE.test(fileName)) return 'erb';
  if (languageId === 'typescript' && TS_DECLARATION.test(fileName)) return 'typescript-declaration';
  if (languageId === 'zig' && /\.zon$/i.test(fileName)) return 'zon';
  if (languageId === 'html' && HTML_TEMPLATE.test(fileName)) return 'html-template';
  return languageId;
}

/** True when a document is prose, so bands 2–3 must not paint in it. */
export function isProseLanguage(languageId?: string): boolean {
  return languageId !== undefined && PROSE_LANGUAGES.has(languageId);
}

/** True when a document takes the two markdown marks. */
export function isMarkdownLanguage(languageId?: string): boolean {
  return languageId !== undefined && MARKDOWN_LANGUAGES.has(languageId);
}

/**
 * True when a document has no data flow to focus at all — prose OR a static
 * content/data-format file. This is the check the layer uses to decide "paint
 * nothing, stay in Survey". Kept as one predicate so every call site treats both
 * families identically; the two sets stay separate because they are distinct
 * claims about the file (see STATIC_CONTENT_LANGUAGES).
 */
export function isNonFlowLanguage(languageId?: string): boolean {
  return isProseLanguage(languageId)
    || (languageId !== undefined && (STATIC_CONTENT_LANGUAGES.has(languageId) || DERIVED_STATIC_LANGUAGES.has(languageId)));
}

/**
 * Blocks for a document, picking the scanner its language actually needs.
 *
 * Every caller should use this rather than `scanBraceBlocks` directly: the two
 * scanners return the same shape, so the only thing that must not be forgotten
 * is choosing between them. `languageId` is VS Code's, so the call sites pass
 * `doc.languageId` straight through.
 */
export function scanBlocks(text: string, languageId?: string): BraceBlock[] {
  // Prose has no focusable scope. Returning nothing here is what keeps the phase in
  // Survey: `focusedBlock` finds no block, `runClassify` returns early, and bands
  // 2–3 never paint. Note it is NOT enough to skip the scan and let the top-level
  // fallback apply — that fallback is the whole file, which is precisely the bug.
  if (isNonFlowLanguage(languageId)) {
    return [];
  }
  if (isViewLanguage(languageId)) {
    return scanScriptBlocks(text, languageId!);
  }
  if (languageId === 'lua') {
    return scanLuaBlocks(text);
  }
  if (languageId === 'ruby') {
    return scanRubyBlocks(text);
  }
  if (languageId !== undefined && INDENT_SCOPED.has(languageId)) {
    const suites = scanIndentBlocks(text);
    const exprs = scanPyExprBlocks(text, suites);
    if (exprs.length === 0) return withSlots(suites);
    return withSlots([...suites, ...exprs].sort((a, b) => a.openOffset - b.openOffset));
  }
  const braced = scanBraceBlocks(text, languageId);
  // Rust closures with a bare expression body have no brace to find, so they are
  // added on top of the brace scan rather than replacing it — same shape as the
  // Python lambda pass above.
  if (languageId === 'rust') {
    const closures = scanRustClosures(text, braced);
    if (closures.length > 0) {
      return withSlots([...braced, ...closures].sort((a, b) => a.openOffset - b.openOffset));
    }
  }
  return braced;
}

/**
 * How many of `blocks` (sorted by open, nested as the template's tags and block
 * tags nest them) hold each offset of a rising sequence.
 */
function nestingSweep(blocks: readonly TemplateBlock[]): (offset: number) => number {
  const closes: number[] = [];
  let k = 0;
  return (o) => {
    for (; k < blocks.length && blocks[k].open < o; k++) {
      while (closes.length && closes[closes.length - 1] <= blocks[k].open) closes.pop();
      closes.push(blocks[k].close);
    }
    while (closes.length && closes[closes.length - 1] <= o) closes.pop();
    return closes.length;
  };
}

/**
 * A view's blocks: each code region scanned on its own, so a brace never pairs
 * across regions, and a component's template blocks (`{#each}`, a `v-for` element)
 * around them, each region block one level deeper per template block that holds it.
 * A pattern region's braces destructure, so they are no block.
 */
function scanScriptBlocks(view: string, languageId: string): BraceBlock[] {
  const lx = lexFor(view, languageId);
  const parts = scriptLexes(lx);
  const out: BraceBlock[] = [];
  const templates = languageId === 'html' ? [] : viewBlocks(view);
  const around = nestingSweep(templates);
  const partLanguage = languageId === 'html' ? 'javascript' : 'typescriptreact';
  viewRegions(view).forEach((r, k) => {
    if (r.kind === 'pattern') return;
    const d = r.start;
    const l = lx.lineOf(d);
    const deeper = templates.length ? around(d) : 0;
    // Remembered just before the scan reads it, so each script is lexed once.
    rememberLex(parts[k].text, parts[k]);
    for (const b of scanBlocks(parts[k].text, partLanguage)) {
      out.push({
        openLine: b.openLine + l, closeLine: b.closeLine + l, depth: b.depth + deeper,
        openOffset: b.openOffset + d, closeOffset: b.closeOffset + d, headerStart: b.headerStart + d,
      });
    }
    forgetLex(parts[k].text);
  });
  const outer = nestingSweep(templates);
  for (const t of templates) {
    out.push({
      openLine: lx.lineOf(t.open), closeLine: lx.lineOf(t.close), depth: outer(t.open),
      openOffset: t.open, closeOffset: t.close, headerStart: t.open,
    });
  }
  if (templates.length) out.sort((a, b) => a.openOffset - b.openOffset);
  return withSlots(out);
}

/**
 * The synthetic block representing MODULE TOP LEVEL — the region outside every
 * brace-block. Top-level `const`/`var`/`let` declarations are data identities
 * like any other, so the file itself has to be a focusable scope; otherwise the
 * caret sitting among them resolves to no block, the phase machine drops to
 * Survey, and nothing paints.
 *
 * Depth is -1 so it never beats a real block, and the focus key is distinct from
 * any real block's (see focusKeyOf).
 */
export function topLevelBlock(text: string): BraceBlock {
  if (lastTopLevel?.text !== text) {
    let lines = 1;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
    lastTopLevel = {
      text,
      block: {
        openLine: 0,
        closeLine: Math.max(0, lines - 1),
        depth: -1,
        openOffset: 0,
        closeOffset: Math.max(0, text.length - 1),
        headerStart: 0,
      },
    };
  }
  return { ...lastTopLevel.block };
}

/** The caret falls back to the top-level block on every event outside a block, for the same text. */
let lastTopLevel: { text: string; block: BraceBlock } | undefined;

/** True for the synthetic top-level scope (see `topLevelBlock`). */
export function isTopLevelBlock(block: BraceBlock): boolean {
  return block.depth === -1;
}

/**
 * Does this block header declare a function (so its parameter list is not
 * top-level code)? A `const X = { … }` object literal is also a depth-0 block,
 * but its "header" holds the declaration name we DO want at top level.
 */
export function isFunctionHeaderText(header: string): boolean {
  return /\b(func|function)\b|=>\s*$|\)\s*(:[^)]*)?\s*$/.test(header);
}

/**
 * What the synthetic top-level scope leaves out, sorted and merged: every
 * depth-0 block body, plus the signature of every depth-0 function (all its
 * lines, when it wraps). Shared by classification and the decorator, so the
 * gutter, the clay numbers and band 3 cover exactly the code the top-level
 * classification sees.
 */
export function topLevelExcludes(
  text: string,
  blocks: BraceBlock[],
  languageId?: string,
): { start: number; end: number }[] {
  const hit = topLevelExcludeMemo.get(blocks);
  if (hit && hit.text === text && hit.languageId === languageId && hit.count === blocks.length) {
    return hit.ranges.map((r) => ({ ...r }));
  }
  const ranges = computeTopLevelExcludes(text, blocks, languageId);
  topLevelExcludeMemo.set(blocks, { text, languageId, count: blocks.length, ranges });
  return ranges.map((r) => ({ ...r }));
}

/** Per block list: the classifier and the decorator both ask on every top-level focus. */
const topLevelExcludeMemo = new WeakMap<
  BraceBlock[],
  { text: string; languageId: string | undefined; count: number; ranges: { start: number; end: number }[] }
>();

function computeTopLevelExcludes(
  text: string,
  blocks: BraceBlock[],
  languageId?: string,
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const b of blocks) {
    if (b.depth !== 0 || isPatternBrace(text, b, languageId)) {
      continue;
    }
    ranges.push({ start: b.openOffset, end: b.closeOffset + 1 });
    const h = headerOf(text, b, languageId);
    const signature = isFunctionHeaderText(h.text)
      || (isFunctionHeader(text, b, languageId) && !isControlFlowHeader(text, b, languageId));
    if (signature) {
      ranges.push({ start: h.start, end: b.openOffset });
    }
  }
  if (isViewLanguage(languageId)) {
    // The top level of an HTML document or a component is its regions' top level: the markup is outside it.
    let at = 0;
    for (const r of viewRegions(text)) {
      if (r.start > at) ranges.push({ start: at, end: r.start });
      at = r.end;
    }
    // One past the end, so the empty line after a final line break is outside too.
    ranges.push({ start: at, end: text.length + 1 });
  }
  ranges.sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** True when `offset` lies in one of `ranges` (sorted, non-overlapping). */
export function inSortedRanges(ranges: { start: number; end: number }[], offset: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < ranges[mid].start) {
      hi = mid - 1;
    } else if (offset >= ranges[mid].end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/**
 * The lines the top-level scope owns, for its gutter stripe. A line with code
 * belongs when any of its non-blank characters lies outside `excludes`; a blank
 * line belongs unless it sits inside an excluded body.
 */
export function topLevelLines(
  text: string,
  lineStarts: number[],
  excludes: { start: number; end: number }[],
): number[] {
  const out: number[] = [];
  // Queries only move forward, so a cursor replaces the binary search: `k` is the
  // first exclude ending after the last offset asked about.
  let k = 0;
  const excludeAt = (i: number): number => {
    while (k < excludes.length && excludes[k].end <= i) k++;
    return k < excludes.length && excludes[k].start <= i ? k : -1;
  };
  for (let line = 0; line < lineStarts.length; line++) {
    const ls = lineStarts[line];
    const le = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
    let sawCode = false;
    let outside = false;
    for (let i = ls; i < le; i++) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 13) {
        continue;
      }
      sawCode = true;
      const x = excludeAt(i);
      if (x < 0) {
        outside = true;
        break;
      }
      i = Math.min(le, excludes[x].end) - 1;
    }
    if (sawCode ? outside : excludeAt(ls) < 0) {
      out.push(line);
    }
  }
  return out;
}

/**
 * The innermost block containing `caretLine` — spec §3.2. Among all blocks
 * whose [openLine, closeLine] span the caret, the one with greatest depth wins;
 * ties (which shouldn't happen for well-formed nesting) break to the tightest
 * span.
 *
 * Returns null when the caret is outside every block AND no `text` is supplied.
 * Pass `text` to get the synthetic top-level scope instead, so module-level
 * declarations are focusable.
 */
export function innermostBlock(
  blocks: BraceBlock[],
  caretLine: number,
  caretOffset?: number,
  text?: string,
  /** Single-line function blocks whose parameter list opens before the `{`: where it opens. */
  paramStarts?: ReadonlyMap<BraceBlock, number>,
): BraceBlock | null {
  let best: BraceBlock | null = null;
  for (const b of blocks) {
    if (!blockContainsCaret(b, caretLine, caretOffset, paramStarts?.get(b))) {
      continue;
    }
    if (
      best === null ||
      b.depth > best.depth ||
      (b.depth === best.depth && b.closeLine - b.openLine < best.closeLine - best.openLine)
    ) {
      best = b;
    }
  }
  if (best === null && text !== undefined) {
    return topLevelBlock(text);
  }
  return best;
}

/**
 * Whether a caret is inside a block. Containment is line-based for MULTI-line
 * blocks — a caret anywhere on the header or closing line counts, so clicking a
 * function's signature focuses its body. But for a SINGLE-line block (opens and
 * closes on one line, e.g. `map[string]string{"env": "dev"}`), line containment
 * is too coarse: a caret earlier on that same line (on `Tags:`, before the `{`)
 * would wrongly count. There we require the caret's OFFSET to fall within the
 * braces. `caretOffset` is optional; without it, single-line blocks fall back to
 * line containment (old behaviour) so callers that lack an offset still work.
 */
function blockContainsCaret(b: BraceBlock, caretLine: number, caretOffset?: number, paramStart?: number): boolean {
  if (caretLine < b.openLine || caretLine > b.closeLine) {
    return false;
  }
  const singleLine = b.openLine === b.closeLine;
  if (singleLine && caretOffset !== undefined) {
    // Caret must sit between the braces (inclusive of the closing brace so a
    // click just inside still counts), or in a one-line function's parameters.
    const from = paramStart !== undefined ? paramStart - 1 : b.openOffset;
    return caretOffset > from && caretOffset <= b.closeOffset;
  }
  return true;
}

/**
 * A stable identity for a focus block across re-scans. Lets the decorator's
 * reducer detect the dominant "same block, only phase changed" case and do zero
 * reclassification work. Keyed on the header line + depth, plus the slot when
 * several blocks open on that line at that depth: within one document version
 * that names one block, typing inside it or on its header line keeps the key,
 * and across edits the key drifting is exactly what should force a re-tint (a cut).
 */
export function focusKeyOf(block: BraceBlock): string {
  return block.slot ? `${block.openLine}#${block.depth}#${block.slot}` : `${block.openLine}#${block.depth}`;
}

/**
 * The declaration region for a block's block-local detection.
 *
 * Normally the body only ([openOffset, closeOffset]). For a CONTROL-FLOW block
 * (if/for/while/switch/range/…) we widen to include the header line, so header
 * bindings — `for _, c := range xs {`, `if v, ok := m[k]; ok {` — count as
 * block-local. But a FUNCTION block's header holds its PARAMETERS, which are
 * function-scoped (fn-local), not block-local; widening there would misclassify
 * params. So we widen only when the header reads as control-flow and NOT as a
 * function signature. A braced Rust match arm (`Ok(v) => {`) is control flow:
 * its pattern bindings belong to the arm.
 */
export function declRegionFor(text: string, block: BraceBlock, languageId?: string): { start: number; end: number } {
  const body = { start: block.openOffset, end: block.closeOffset + 1 };
  if (isControlFlowHeader(text, block, languageId)) {
    return { start: headerOf(text, block, languageId).start, end: block.closeOffset + 1 };
  }
  return body;
}

const CONTROL_HEADER = /\b(if|elif|for|while|switch|else|do|range|select|case|match|with|try|except|finally)\b/;
const CONTROL_KEYWORD = /\b(if|elif|for|while|switch|else|do|range|select|case|match|with|try|except|finally|loop)\b/;
const RUST_FN = /^\s*(pub\s*(\([^)]*\)\s*)?)?(const\s+|async\s+|unsafe\s+|extern\s+("[^"]*"\s+)?)*fn\b/;
const RUST_TYPE_BODY = /^\s*(pub\s*(\([^)]*\)\s*)?)?(struct|enum|trait|impl|mod|union)\b/;
const ZIG_FN = /^\s*(pub\s+)?((export|extern(\s*"[^"]*")?|inline|noinline)\s+)*fn\b|^\s*test\b/;
const ZIG_CONTAINER = /\b(struct|enum|union|opaque|error)\s*(\([^)]*\))?\s*$/;
const ZIG_CONTROL = /\b(if|else|while|for|switch|catch|orelse|defer|errdefer|comptime|suspend|nosuspend)\b/;
/** Headers that end in `(…)` but open a statement block, not a function. */
const NOT_A_FUNCTION = /^\s*\}?\s*(catch|when|synchronized|using|lock|fixed|foreach|unless|until|guard)\b/;

/**
 * Keywords that introduce a named or anonymous function, per lexer family. The
 * parameter list is the first `(` after the keyword, so a result list
 * (`func f(s string) (int, error)`) or a tuple in the return type
 * (`-> Result<(), E>`) is never mistaken for it.
 */
const FUNCTION_KEYWORDS: Record<string, Set<string>> = {
  js: new Set(['function']),
  go: new Set(['func']),
  rust: new Set(['fn']),
  kotlin: new Set(['fun']),
  nested: new Set(['func', 'def']),
  python: new Set(['def']),
  zig: new Set(['fn']),
  default: new Set(['function', 'func', 'fn', 'def']),
};

interface Header {
  /** Offset the header starts at: `headerStart`, or earlier for a wrapped header. */
  start: number;
  /** The header text up to the `{`. Comments are blanked in a wrapped header. */
  text: string;
}

/**
 * A block's header: the `{` line up to the brace, or, when that line only
 * finishes a statement begun on an earlier line, the whole statement.
 *
 *   function f(            fn fold<T>(seed: T) -> T      if (ok &&
 *     a: number,           where                             ready) {
 *   ): void {                  T: Clone,
 *                          {
 *
 * The wider header is kept only when it reads as a function or control-flow
 * header; anything else keeps the `{` line, so a brace in an expression never
 * claims the statement before it.
 */
function headerOf(text: string, block: BraceBlock, languageId?: string): Header {
  if (!isBraceBlock(text, block, languageId)) {
    return { start: block.headerStart, text: text.slice(block.headerStart, block.openOffset) };
  }
  const lx = lexFor(text, languageId);
  let perBlock = headerMemo.get(lx);
  if (!perBlock) {
    perBlock = new WeakMap();
    headerMemo.set(lx, perBlock);
  }
  const hit = perBlock.get(block);
  if (hit && hit.languageId === languageId && hit.headerStart === block.headerStart && hit.openOffset === block.openOffset) {
    return hit.header;
  }
  const header = wrappedHeaderOf(lx, block, languageId);
  perBlock.set(block, { languageId, headerStart: block.headerStart, openOffset: block.openOffset, header });
  return header;
}

/** Every region and header predicate asks for a block's header, several times per version. */
const headerMemo = new WeakMap<
  LexResult,
  WeakMap<BraceBlock, { languageId: string | undefined; headerStart: number; openOffset: number; header: Header }>
>();

function wrappedHeaderOf(lx: LexResult, block: BraceBlock, languageId?: string): Header {
  const line: Header = { start: block.headerStart, text: lx.text.slice(block.headerStart, block.openOffset) };
  const start = lx.syntax.family === 'rust' ? rustItemStart(lx, block) : wrappedHeaderStart(lx, block);
  if (start < 0 || start >= block.headerStart) {
    return line;
  }
  const wide = codeSlice(lx, start, block.openOffset);
  return functionHeaderText(wide, languageId) || CONTROL_HEADER.test(wide) ? { start, text: wide } : line;
}

/** A real `{…}` block, as opposed to a synthetic arrow, lambda, closure or comprehension scope. */
function isBraceBlock(text: string, block: BraceBlock, languageId?: string): boolean {
  return text.charCodeAt(block.openOffset) === 123 && languageId !== 'python' && languageId !== 'lua' && languageId !== 'ruby';
}

/** `text[start, end)` with comment and doc spans blanked (newlines kept). */
function codeSlice(lx: LexResult, start: number, end: number): string {
  const text = lx.text;
  let k = lx.spanIndexFrom(start);
  if (k > 0 && lx.spans[k - 1].end > start) k--;
  let out = '';
  let i = start;
  for (; i < end && k < lx.spans.length && lx.spans[k].start < end; k++) {
    const s = lx.spans[k];
    if (s.start > i) {
      out += text.slice(i, s.start);
      i = s.start;
    }
    const stop = Math.min(s.end, end);
    out += s.region === 'string' ? text.slice(i, stop) : text.slice(i, stop).replace(/[^\n]/g, ' ');
    i = stop;
  }
  return i < end ? out + text.slice(i, end) : out;
}

/**
 * Where a wrapped header starts, for brace languages other than Rust, or -1.
 * The `{` line is a fragment when it is empty (an Allman brace: the header is the
 * previous code line) or closes a `(` opened on an earlier line; the header then
 * starts on the line of that `(`, repeatedly.
 */
function wrappedHeaderStart(lx: LexResult, block: BraceBlock): number {
  const text = lx.text;
  let from = block.headerStart;
  if (text.slice(block.headerStart, block.openOffset).trim() === '') {
    const p = lx.prevSignificant(block.headerStart);
    if (p < 0 || ';{},([=:'.includes(text[p])) {
      return -1;
    }
    from = lx.lineStarts[lx.lineOf(p)];
  }
  for (let guard = 0; guard < 8; guard++) {
    const open = unmatchedCloseOpener(lx, from, block.openOffset);
    if (open < 0) {
      break;
    }
    from = lx.lineStarts[lx.lineOf(open)];
  }
  return from;
}

/** The `(` matching the first `)` in [from, end) that has no `(` after `from`, else -1. */
function unmatchedCloseOpener(lx: LexResult, from: number, end: number): number {
  const P = lx.punct;
  let depth = 0;
  for (let k = lx.punctFrom(from); k < P.length && P[k] < end; k++) {
    const c = lx.text[P[k]];
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (depth === 0) {
        return matchingOpen(lx, k);
      }
      depth--;
    }
  }
  return -1;
}

/** Offset of the `(` matching the `)` at `punct[k]`, else -1. */
function matchingOpen(lx: LexResult, k: number): number {
  const P = lx.punct;
  let depth = 0;
  for (; k >= 0; k--) {
    const c = lx.text[P[k]];
    if (c === ')') {
      depth++;
    } else if (c === '(' && --depth === 0) {
      return P[k];
    }
  }
  return -1;
}

/**
 * Where a Rust item or expression whose `{` line is a fragment (empty, or
 * starting with `)`, `->` or `where`) starts, or -1: back to the nearest code
 * `;`, `{` or `}` at bracket depth 0, then past attributes. Rust statements always
 * end in one of those, so the walk cannot run into the previous statement.
 */
function rustItemStart(lx: LexResult, block: BraceBlock): number {
  const text = lx.text;
  if (!/^(\)|->|where\b|$)/.test(codeSlice(lx, block.headerStart, block.openOffset).trim())) {
    return -1;
  }
  const P = lx.punct;
  let depth = 0;
  let s = 0;
  for (let k = lx.punctFrom(block.openOffset) - 1; k >= 0; k--) {
    const c = text[P[k]];
    if (c === ')' || c === ']') {
      depth++;
    } else if (c === '(' || c === '[') {
      if (depth === 0) {
        s = P[k] + 1;
        break;
      }
      depth--;
    } else if (depth === 0 && (c === ';' || c === '{' || c === '}')) {
      s = P[k] + 1;
      break;
    }
  }
  for (;;) {
    while (s < block.openOffset && (/\s/.test(text[s]) || !lx.isCode(s))) s++;
    if (text[s] !== '#' || !/^#!?\[/.test(text.slice(s, s + 3))) {
      return s;
    }
    const open = text.indexOf('[', s);
    let k = lx.punctFrom(open);
    let d = 0;
    for (; k < P.length && P[k] < block.openOffset; k++) {
      const c = text[P[k]];
      if (c === '[') d++;
      else if (c === ']' && --d === 0) break;
    }
    if (k >= P.length || P[k] >= block.openOffset) {
      return s;
    }
    s = P[k] + 1;
  }
}

/**
 * Index in `header` of the opening `|` of a Rust closure's parameter list that
 * ends the header (`.map(|x| {`, `move |a, b| -> T {`, `|| {`), else -1. The bar
 * must follow something a value cannot end with, so `a || b {` is not a closure.
 */
function rustClosureBar(header: string, languageId?: string): number {
  if (languageId !== undefined && languageId !== 'rust') {
    return -1;
  }
  const m = /(\|[^|\n]*\||\|\|)\s*(->\s*[^{}|;=]+?)?\s*$/.exec(header);
  if (!m) {
    return -1;
  }
  const before = header.slice(0, m.index).replace(/\bmove\s*$/, '').trimEnd();
  return before === '' || /([(,{;:]|(?<![=!<>])=|=>|\breturn)$/.test(before) ? m.index : -1;
}

/** Does this header text (no synthetic block) declare a function? */
function functionHeaderText(header: string, languageId?: string): boolean {
  if (languageId === 'ruby') {
    return /^(def\b|do\b|\{|->)/.test(header);
  }
  if (languageId === 'zig') {
    return ZIG_FN.test(header);
  }
  if (/^\s*(async\s+)?(def|lambda)\b/.test(header)) {
    return true;
  }
  if (/^\s*class\b/.test(header)) {
    return false;
  }
  // A braced match arm, `Ok(v) => {`, binds its pattern like control flow.
  if (languageId === 'rust' && /=>\s*$/.test(header)) {
    return false;
  }
  // Rust. `fn` has to be named explicitly: the generic fallback below keys on a
  // header ENDING in `)`, and a Rust signature almost never does — `-> Self`,
  // `-> String` or a `where` clause sits after the parameter list. The visibility
  // and qualifier prefixes are consumed first because `pub fn`, `pub(crate) fn` and
  // `pub async unsafe fn` are all one construct.
  if (RUST_FN.test(header) || rustClosureBar(header, languageId) >= 0) {
    return true;
  }
  // A Rust TYPE body is not a function: `struct`, `enum`, `trait`, `impl`, `mod`
  // and `union` hold fields and signatures, not bindings. Without this an `impl`
  // header reaches the fallback, whose `\)\s*$` arm matches an `impl Trait for
  // Type` line carrying generics and pulls the type names in as parameters.
  if (RUST_TYPE_BODY.test(header)) {
    return false;
  }
  return /\b(func|function)\b|=>\s*$|\)\s*(:[^)]*)?\s*$/.test(header);
}

/** Does this block's header read as control flow (rather than a function signature)? */
function isControlFlowHeader(text: string, block: BraceBlock, languageId?: string): boolean {
  const header = headerOf(text, block, languageId).text;
  if (languageId === 'lua') {
    return LUA_CONTROL.test(header);
  }
  if (languageId === 'ruby') {
    return RUBY_CONTROL.test(header);
  }
  if (languageId === 'zig') {
    return !ZIG_FN.test(header) && !ZIG_CONTAINER.test(header) && ZIG_CONTROL.test(header);
  }
  // A Python `def`/`class`/`lambda` is a DECLARATION even though its header also
  // contains words this regex would otherwise match (`for` inside a default, say),
  // so it is checked first and short-circuits. Without this, `def load_config(...)`
  // read as control flow, its params were widened into block-locals, and they
  // stopped tracing across the function.
  if (/^\s*(async\s+)?(def|class|lambda)\b/.test(header)) {
    return false;
  }
  if (languageId === 'rust' && /=>\s*$/.test(header)) {
    return true;
  }
  // Control-flow keywords are unambiguous and take precedence — `for (...) {`,
  // `if (...) {`, `while (...) {` all have parens too, so paren-based function
  // detection must not override them. `with`/`except`/`elif`/`try`/`finally`/
  // `match`/`case` are Python's, and each binds names in its header
  // (`with open(f) as fh:`, `except E as e:`) exactly like `for … in …:` does.
  return CONTROL_HEADER.test(header);
}

/**
 * Offset of the control keyword (`match`, `if`, `for`, …) that opens a
 * control-flow block, searched within the header. Falls back to the header start
 * if none is found (a match arm, or a header that is nothing but the keyword).
 * This is what keeps a `let x = match … {` binding OUT of the match's scope
 * region — see scopeRegionFor.
 */
function controlKeywordStart(text: string, block: BraceBlock, languageId?: string): number {
  const h = headerOf(text, block, languageId);
  const m = (languageId === 'zig' ? ZIG_CONTROL : CONTROL_KEYWORD).exec(h.text);
  return m ? h.start + m.index : h.start;
}

/**
 * Does this block's header declare a function (so its params belong to it)?
 *
 * Python's `def`/`lambda` are included, and `class` deliberately is NOT: a class
 * body's names are attributes, not parameters, and a dataclass field like
 * `name: str` is band-1 furniture rather than a data identity. Treating `class`
 * as a function header would widen its header into the param region and pull
 * those fields in as bindings.
 */
export function isFunctionHeader(text: string, block: BraceBlock, languageId?: string): boolean {
  // A synthetic lambda/closure block has headerStart === openOffset, so the header
  // slice is EMPTY and no pattern can match it. Read forward from the start offset
  // instead: `lambda` there means the block IS the lambda, and a Rust closure block
  // starts ON its opening `|`; either way its parameters belong to it.
  if (block.headerStart === block.openOffset && !isBraceBlock(text, block, languageId)) {
    return /^\s*lambda\b/.test(text.slice(block.openOffset, block.openOffset + 12))
      || text[block.openOffset] === '|';
  }
  return functionHeaderText(headerOf(text, block, languageId).text, languageId)
    && paramListCloses(text, block, languageId);
}

/**
 * A function's parameter list closes before its body opens. A `{` inside the
 * list — a destructuring pattern or default in `function f({ a, b = {} }) {` —
 * has a header that names the function, but it is not the body.
 */
function paramListCloses(text: string, block: BraceBlock, languageId?: string): boolean {
  const open = paramListStart(text, block, languageId);
  if (text[open] !== '(') {
    return true;
  }
  const lx = lexFor(text, languageId);
  const P = lx.punct;
  let depth = 0;
  for (let k = lx.punctFrom(open); k < P.length && P[k] < block.openOffset; k++) {
    const c = text[P[k]];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return true;
  }
  return false;
}

/** What a Ruby block is as a scope: a `def`, a `class` / `module` body, a closure (`do`, `{`, `->`), or none (branches, loops). */
export function rubyBlockKind(text: string, block: BraceBlock): 'def' | 'class' | 'block' | 'none' {
  const h = text.slice(block.headerStart, Math.min(block.openOffset, block.headerStart + 8));
  if (/^def\b/.test(h)) return 'def';
  if (/^(class|module)\b/.test(h)) return 'class';
  if (/^(do\b|\{|->|BEGIN\b|END\b)/.test(h)) return 'block';
  return 'none';
}

/** The method name after the `def` at `defAt`, with its offset. */
export function rubyDefName(text: string, defAt: number): { name: string; offset: number } | null {
  const m = RUBY_DEF_NAME.exec(text.slice(defAt + 3, defAt + 260));
  if (!m) return null;
  const end = defAt + 3 + m[0].length;
  return { name: m[1], offset: end - m[1].length };
}

/** Ruby: the `(` or first parameter after a `def` name, the `|` of block parameters, or what follows `->`. */
function rubyParamStart(text: string, h: Header): number {
  if (h.text.startsWith('def')) {
    const m = RUBY_DEF_NAME.exec(h.text.slice(3));
    if (!m) return h.start + 3;
    let i = h.start + 3 + m[0].length;
    while (text[i] === ' ' || text[i] === '\t') i++;
    return i;
  }
  if (h.text.startsWith('->')) return h.start + 2;
  const bar = h.text.indexOf('|');
  return bar >= 0 ? h.start + bar : h.start + h.text.length;
}

/**
 * The range a function-like block binds its parameters in — parameter list to
 * closing brace — or null for anything else. Covers what document symbols leave
 * out: Go func literals, Rust closures, JS callbacks and concise arrows, Python
 * lambdas. A `catch`, `when` or `using` header ends in `(…)` too, but is a
 * statement block.
 */
export function functionScopeOf(text: string, block: BraceBlock, languageId?: string): { start: number; end: number } | null {
  // A component's template block (`{#each}`, a `v-for` element, an Astro script) scopes the names it binds, as a function does.
  if (text[block.openOffset] === BLOCK_OPEN || text[block.openOffset] === MODULE_OPEN) return { start: block.openOffset, end: block.closeOffset + 1 };
  if (block.headerStart === block.openOffset && !isBraceBlock(text, block, languageId)) {
    // Synthetic: a lambda, a Rust closure, or a JS concise arrow (`(c) => …`, `c => …`).
    const arrow = languageId === undefined || ARROW_LANGUAGES.has(languageId);
    const c = text[block.openOffset] ?? '';
    return isFunctionHeader(text, block, languageId) || (arrow && (c === '(' || /[\p{ID_Start}_$]/u.test(c)))
      ? { start: block.openOffset, end: block.closeOffset + 1 }
      : null;
  }
  if (!isFunctionHeader(text, block, languageId) || isControlFlowHeader(text, block, languageId)) {
    return null;
  }
  if (NOT_A_FUNCTION.test(headerOf(text, block, languageId).text)) {
    return null;
  }
  if (languageId !== undefined && TYPED_ARROW_LANGUAGES.has(languageId)) {
    // `type F = () => { a: number }`: the braces are an object type.
    const lx = lexFor(text, languageId);
    const q = lx.prevSignificant(block.openOffset);
    if (q > 0 && text[q] === '>' && text[q - 1] === '=' && typeArrowsOf(lx, languageId).arrows.has(q - 1)) {
      return null;
    }
  }
  return { start: paramListStart(text, block, languageId), end: block.closeOffset + 1 };
}

/**
 * The region a block OWNS as a scope — used to decide whether a name belongs to
 * a NESTED sub-scope (attention proximity 2) rather than to the focused block.
 *
 * Header-inclusive when the header declares bindings belonging to the block
 * itself:
 *   - function signatures: `func(i, j int) bool {`, `(acc, x) => {`
 *   - control flow:        `for idx, n := range names {`
 * Body-only otherwise, and that exclusion is load-bearing: a composite/object
 * literal is also a brace-block, but its header holds a declaration owned by the
 * ENCLOSING scope (`const DEFAULTS = {`, `cfg := Config{`), so widening there
 * would demote the very name we want at the outer level.
 *
 * Distinct from `declRegionFor`, which answers "is this name block-local or
 * fn-local" and therefore keeps FUNCTION headers body-only so params stay
 * fn-scoped and trace across the whole function. Using that region for sub-scope
 * detection is what let a closure's params (`sort.Slice(names, func(i, j int)`)
 * count as the OUTER block's own locals at proximity 0 — competing with, and
 * beating, the enclosing function's real parameters.
 */
export function scopeRegionFor(text: string, block: BraceBlock, languageId?: string): { start: number; end: number } {
  if (isPatternBrace(text, block, languageId)) {
    return { start: block.openOffset, end: block.openOffset };
  }
  if (isControlFlowHeader(text, block, languageId)) {
    // Start the sub-scope at the CONTROL KEYWORD, not the line start. A block used
    // as an EXPRESSION is preceded by a binding on the same line:
    //
    //   let label = match self {
    //   ^^^^^^^^^ enclosing scope's own    ^ the match's own scope starts here
    //
    // Taking the whole header line (`block.headerStart`) swallowed `let label` into
    // the match's scope region, so from the function body `label` scored proximity 2
    // (declared-in-sub-scope) and was excluded from the attention budget — it never
    // tinted, though it is an ordinary fn-body local. `match`/`if`/`while` as
    // expressions are common in Rust; the keyword is the true start of their scope.
    return { start: controlKeywordStart(text, block, languageId), end: block.closeOffset + 1 };
  }
  if (isFunctionHeader(text, block, languageId)) {
    // Only the PARAMETER LIST belongs to the function, not the whole header line.
    // An inline callback's header routinely carries a declaration owned by the
    // ENCLOSING scope:
    //
    //   const jobs = names.map(async (name) => {
    //   ^^^^^^^^^^ outer                ^^^^^^ the callback's own
    //
    // Taking the whole header put `jobs` inside the callback's sub-scope, so from
    // fetchAll's body it scored proximity 2 and was excluded — while from inside the
    // callback it read as fn-local and painted, despite never being used there.
    return { start: paramListStart(text, block, languageId), end: block.closeOffset + 1 };
  }
  return { start: block.openOffset, end: block.closeOffset + 1 };
}

/**
 * A `{…}` that is a destructuring or match pattern, not a scope: `const { a, b } = o`,
 * `for (const { a } of xs)`, `let P { x, y } = p`, `P { x, .. } =>`. Its names
 * are bindings of the enclosing scope. A brace followed by `=` or `=>` can only be
 * a pattern (or a type literal, which is no scope either).
 */
export function isPatternBrace(text: string, block: BraceBlock, languageId?: string): boolean {
  if (!isBraceBlock(text, block, languageId)) {
    return false;
  }
  const lx = lexFor(text, languageId);
  let n = block.closeOffset + 1;
  for (;;) {
    while (n < text.length && /\s/.test(text[n])) n++;
    const r = n < text.length ? lx.regionAt(n) : 'code';
    if (r !== 'comment' && r !== 'doc') break;
    n = lx.spanAt(n)!.end;
  }
  if (text[n] === '=' && text[n + 1] !== '=') {
    return true;
  }
  const p = lx.prevSignificant(block.openOffset);
  if (p < 0 || !/[\p{ID_Continue}$]/u.test(text[p])) {
    return false;
  }
  let w = p;
  while (w > 0 && /[\p{ID_Continue}$]/u.test(text[w - 1])) w--;
  const word = text.slice(w, p + 1);
  return lx.syntax.family === 'js' && (word === 'const' || word === 'let' || word === 'var');
}

/**
 * JS / TS: a `{…}` destructuring one parameter, `function f({ a, b = 1 }, c) {` or
 * `({ a }) =>`. Its names are the function's parameters.
 */
export function isParamPattern(text: string, block: BraceBlock, languageId?: string): boolean {
  const lx = lexFor(text, languageId);
  if (lx.syntax.family !== 'js' || text[block.openOffset] !== '{') return false;
  const open = lx.enclosingOpen(block.openOffset);
  const p = lx.prevSignificant(block.openOffset);
  if (open < 0 || text[open] !== '(' || (p !== open && text[p] !== ',')) return false;
  let depth = 0;
  for (let k = lx.punctFrom(open); k < lx.punct.length; k++) {
    const c = text[lx.punct[k]];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) {
      let n = lx.punct[k] + 1;
      while (n < text.length && /\s/.test(text[n])) n++;
      return text[n] === '{' || (text[n] === '=' && text[n + 1] === '>') || text[n] === ':';
    }
  }
  return false;
}

/**
 * Offset of the `(` (or Rust closure `|`) opening this function block's parameter
 * list, or `openOffset` if none is found (e.g. a Go method value).
 *
 * After a function keyword (`fn`, `func`, `function`, `def`, …) it is the first
 * `(` outside generic angle brackets, so a Go method's receiver counts and a
 * result list or a `()` in the return type does not. Without a keyword (arrows,
 * methods) it is the matching `(` of the LAST balanced paren group before the
 * `{`, so nested parens in defaults (`(a = f(1)) => {`) do not confuse it.
 */
function paramListStart(text: string, block: BraceBlock, languageId?: string): number {
  const h = headerOf(text, block, languageId);
  if (languageId === 'ruby') {
    return rubyParamStart(text, h);
  }
  const bar = rustClosureBar(h.text, languageId);
  if (bar >= 0) {
    return h.start + bar;
  }
  const lx = lexFor(text, languageId);
  const afterKeyword = keywordParamOpen(lx, h.start, block.openOffset);
  if (afterKeyword >= 0) {
    return afterKeyword;
  }
  const P = lx.punct;
  let depth = 0;
  for (let k = lx.punctFrom(block.openOffset) - 1; k >= 0 && P[k] >= h.start; k--) {
    const c = text[P[k]];
    if (c === ')') {
      depth++;
    } else if (c === '(') {
      depth--;
      if (depth === 0) {
        return P[k];
      }
      if (depth < 0) {
        break;
      }
    }
  }
  // No paren group: a single-identifier arrow (`name => {`). Walk back over the
  // identifier and any `async` so the param itself is still inside the region.
  let i = block.openOffset - 1;
  while (i >= h.start && /[\s=>]/.test(text[i])) {
    i--;
  }
  while (i >= h.start && /[A-Za-z0-9_$]/.test(text[i])) {
    i--;
  }
  return Math.max(h.start, i + 1);
}

/**
 * The parameter `(` after the first function keyword in [start, end) that
 * follows the header's last code `}` (so an earlier callback in the same header
 * does not count), else -1.
 */
function keywordParamOpen(lx: LexResult, start: number, end: number): number {
  const words = FUNCTION_KEYWORDS[lx.syntax.family];
  if (!words) {
    return -1;
  }
  const text = lx.text;
  // An object type's `}` in type parameters (`function f<T extends { id: number }>(`) closes no block.
  let after = start;
  let generic = 0;
  for (let i = start; i < end; i++) {
    if (!lx.isCode(i)) continue;
    const c = text[i];
    if (c === '<' && /[\p{ID_Continue}$]/u.test(text[i - 1] ?? '')) generic++;
    else if (c === '>' && generic > 0 && text[i - 1] !== '=' && text[i - 1] !== '-') generic--;
    else if (c === '}' && generic === 0) after = i + 1;
  }
  const kw = lx.identsIn(after, end).find((id) => words.has(id.name));
  if (!kw) {
    return -1;
  }
  let angle = 0;
  for (let i = kw.offset + kw.length; i < end; i++) {
    const c = text[i];
    if (!lx.isCode(i)) continue;
    if (c === '<') {
      angle++;
    } else if (c === '>' && text[i - 1] !== '-' && text[i - 1] !== '=') {
      angle = Math.max(0, angle - 1);
    } else if (c === '(' && angle === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * The region used for LEXING — deciding which names count as "used in this
 * block" and are therefore candidates for a hue.
 *
 * Header-inclusive, because the header carries a block's own bindings:
 *   - control flow: `for _, c := range xs {`, `if v, ok := m[k]; ok {`
 *   - functions:    `go func(cfg Config) {`, `echo := func(ctx *Context) {`
 * Those names live BEFORE the `{`, so a body-only region makes them invisible in
 * their own scope — which is why a closure's params used to tint only from the
 * PARENT block (whose range covers the header line) and never from inside the
 * closure itself.
 *
 * For a FUNCTION block the region starts at the parameter list, not `headerStart`,
 * for the same reason `scopeRegionFor` does: an inline callback's header carries a
 * declaration owned by the enclosing scope.
 *
 *   const jobs = names.map(async (name) => {
 *
 * Lexing from `headerStart` counted `jobs` as USED INSIDE the callback, so focusing
 * the callback painted it — a name that never appears in that scope — and traced it
 * back onto the outer declaration line too.
 *
 * Still deliberately wider than `declRegionFor`, which stays body-only for functions
 * so params classify as fn-local (whole-scope) rather than block-local.
 */
export function lexRegionFor(text: string, block: BraceBlock, languageId?: string): { start: number; end: number } {
  const start = isFunctionHeader(text, block, languageId) && !isControlFlowHeader(text, block, languageId)
    ? paramListStart(text, block, languageId)
    : headerOf(text, block, languageId).start;
  return { start, end: block.closeOffset + 1 };
}

/**
 * Every code identifier whose first char lies in [start, end) — never one inside
 * a string or comment. A slice of the shared per-version lex (see lex.ts), so a
 * region query costs a binary search, not a rescan from offset 0.
 *
 * Keywords are NOT filtered here — the caller decides (band-2 classification
 * filters language keywords; risk detection wants some of them).
 */
export function lexIdentifiers(text: string, start = 0, end = text.length, languageId?: string): LexId[] {
  return lexFor(text, languageId).identsIn(start, end);
}
