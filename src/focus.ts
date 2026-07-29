/**
 * Focus resolution — spec §1 (Vocabulary) and §3.2.
 *
 *   Brace-block   — any {…} span, header line through closing line.
 *   Focus         — the *innermost* brace-block containing the caret line.
 *                   Deepest scope wins, plain and predictable. (Spec §1: the
 *                   smarter hysteresis version was scrapped as confusing.)
 *
 * This module also hosts the shared lexical tokenizer used by both focus
 * resolution and band-2 classification: a single string/comment-skipping scan
 * that the higher layers reuse so identifiers inside strings or comments never
 * count. The scanner is intentionally language-neutral (§7): focus is purely
 * structural — "the innermost {…} around the caret" — and a brace scan resolves
 * it identically while staying synchronous (no await on every caret move).
 *
 * §8.4 flags that the prototype's if-block detection had nested/else edge bugs;
 * the settled logic is simply "deepest {…} containing the line", which is what
 * this scanner computes — no special-casing of control-flow headers.
 */

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
}

type ScanState = 'code' | 'line-comment' | 'block-comment' | 'sq' | 'dq' | 'bq';

/**
 * Scan the whole document once and return every brace-block, each as a
 * (openLine, closeLine, depth, offsets) tuple. A single pass is O(chars); we
 * re-run it on document change and cache per version (see decorator).
 *
 * The scanner is intentionally lexical and language-neutral. It understands the
 * common string/comment shapes (//, block comments, ', ", `) well enough that
 * their braces don't count. It is not a parser — it does not know that Python
 * has no braces, or that Rust lifetimes use `'`. Those are acceptable: on a
 * braceless language the block list is simply empty and the layer stays in
 * Survey, which is the correct at-rest behaviour anyway.
 */
export function scanBraceBlocks(text: string): BraceBlock[] {
  const blocks: BraceBlock[] = [];
  const stack: { openLine: number; openOffset: number; headerStart: number }[] = [];
  let state: ScanState = 'code';
  let line = 0;
  let lineStart = 0; // offset of the first char of the current line

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    if (c === '\n') {
      line++;
      lineStart = i + 1;
      // line comments end at newline; strings other than templates don't span lines
      if (state === 'line-comment' || state === 'sq' || state === 'dq') {
        state = 'code';
      }
      continue;
    }

    switch (state) {
      case 'code':
        if (c === '/' && next === '/') {
          state = 'line-comment';
          i++;
        } else if (c === '/' && next === '*') {
          state = 'block-comment';
          i++;
        } else if (c === "'") {
          state = 'sq';
        } else if (c === '"') {
          state = 'dq';
        } else if (c === '`') {
          state = 'bq';
        } else if (c === '{') {
          stack.push({ openLine: line, openOffset: i, headerStart: lineStart });
        } else if (c === '}') {
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
        break;

      case 'line-comment':
        // consumed until newline (handled above)
        break;

      case 'block-comment':
        if (c === '*' && next === '/') {
          state = 'code';
          i++;
        }
        break;

      case 'sq':
        if (c === '\\') {
          i++;
        } else if (c === "'") {
          state = 'code';
        }
        break;

      case 'dq':
        if (c === '\\') {
          i++;
        } else if (c === '"') {
          state = 'code';
        }
        break;

      case 'bq':
        // template literal — spans lines; ignore ${} interpolation braces for
        // this slice (they'd only ever open a block that closes on the same
        // conceptual line, and treating the whole template as opaque is calmer).
        if (c === '\\') {
          i++;
        } else if (c === '`') {
          state = 'code';
        }
        break;
    }
  }

  // Concise arrow bodies (`x => expr`) are scopes too, but have no braces to find.
  // Appended after, then the whole list is sorted by open offset so downstream
  // consumers that assume document order still hold.
  const arrows = scanArrowBlocks(text, blocks);
  if (arrows.length === 0) {
    return blocks;
  }
  return [...blocks, ...arrows].sort((a, b) => a.openOffset - b.openOffset);
}

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
function scanArrowBlocks(text: string, braceBlocks: BraceBlock[]): BraceBlock[] {
  const out: BraceBlock[] = [];
  const lineStarts = lineStartOffsetsLocal(text);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return lo;
  };

  // `=>` occurrences in real code (not strings/comments), from the shared lexer's
  // notion of "code": lexIdentifiers already skips strings and comments, but it
  // reports identifiers, not operators. So scan for `=>` and reject any that a
  // lexed identifier could not sit beside — cheaper and simpler: reuse the string
  // state by checking the char is inside no lexed string. We instead do a light
  // scan with the same rules.
  for (const arrowAt of findArrowOffsets(text)) {
    // Skip braced arrows — scanBraceBlocks already owns those.
    let j = arrowAt + 2;
    while (j < text.length && /\s/.test(text[j])) {
      j++;
    }
    if (j >= text.length || text[j] === '{') {
      continue;
    }
    // Parameter list start: `(`-group before the arrow, else the bare identifier.
    const start = paramStartBefore(text, arrowAt);
    if (start === -1) {
      continue;
    }
    const end = conciseBodyEnd(text, j);
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
  // not tell which one the caret was in.
  for (const a of out) {
    let parentDepth = -1;
    for (const b of braceBlocks) {
      if (b.openOffset < a.openOffset && b.closeOffset > a.closeOffset && b.depth > parentDepth) {
        parentDepth = Math.max(parentDepth, b.depth);
      }
    }
    // Arrow ancestors: count how many other arrows strictly contain this one, so a
    // chain of N gets depths parent+1 … parent+N regardless of iteration order.
    let arrowAncestors = 0;
    for (const o of out) {
      if (o !== a && o.openOffset <= a.openOffset && o.closeOffset >= a.closeOffset &&
          !(o.openOffset === a.openOffset && o.closeOffset === a.closeOffset)) {
        arrowAncestors++;
      }
    }
    a.depth = parentDepth + 1 + arrowAncestors;
  }
  return out;
}

/** Line-start offsets; local copy so focus.ts stays free of classify.ts imports. */
function lineStartOffsetsLocal(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** Offsets of every `=>` that is real code (not inside a string, template or comment). */
function findArrowOffsets(text: string): number[] {
  const found: number[] = [];
  let state: ScanState = 'code';
  const interp: { braceDepth: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (c === '\n') {
      if (state === 'line-comment' || state === 'sq' || state === 'dq') {
        state = 'code';
      }
      continue;
    }
    switch (state) {
      case 'code':
        if (c === '/' && next === '/') {
          state = 'line-comment';
          i++;
        } else if (c === '/' && next === '*') {
          state = 'block-comment';
          i++;
        } else if (c === "'") {
          state = 'sq';
        } else if (c === '"') {
          state = 'dq';
        } else if (c === '`') {
          state = 'bq';
        } else if (c === '{' && interp.length > 0) {
          interp[interp.length - 1].braceDepth++;
        } else if (c === '}' && interp.length > 0) {
          const f = interp[interp.length - 1];
          if (f.braceDepth === 0) {
            interp.pop();
            state = 'bq';
          } else {
            f.braceDepth--;
          }
        } else if (c === '=' && next === '>') {
          found.push(i);
          i++;
        }
        break;
      case 'line-comment':
        break;
      case 'block-comment':
        if (c === '*' && next === '/') {
          state = 'code';
          i++;
        }
        break;
      case 'sq':
        if (c === '\\') {
          i++;
        } else if (c === "'") {
          state = 'code';
        }
        break;
      case 'dq':
        if (c === '\\') {
          i++;
        } else if (c === '"') {
          state = 'code';
        }
        break;
      case 'bq':
        if (c === '\\') {
          i++;
        } else if (c === '$' && next === '{') {
          interp.push({ braceDepth: 0 });
          state = 'code';
          i++;
        } else if (c === '`') {
          state = 'code';
        }
        break;
    }
  }
  return found;
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
 * — that is where the argument or statement it belongs to ends. Strings, templates
 * and comments are skipped so a `,` inside them cannot terminate it early, which is
 * exactly the case in `` (acc, line, idx) => `${acc}${idx}:${line}; ` ``.
 */
function conciseBodyEnd(text: string, from: number): number {
  let depth = 0;
  let state: ScanState = 'code';
  const interp: { braceDepth: number }[] = [];
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (c === '\n') {
      if (state === 'line-comment' || state === 'sq' || state === 'dq') {
        state = 'code';
      }
      continue;
    }
    switch (state) {
      case 'code':
        if (c === '/' && next === '/') {
          state = 'line-comment';
          i++;
        } else if (c === '/' && next === '*') {
          state = 'block-comment';
          i++;
        } else if (c === "'") {
          state = 'sq';
        } else if (c === '"') {
          state = 'dq';
        } else if (c === '`') {
          state = 'bq';
        } else if (c === '{' && interp.length > 0) {
          // A `{` while inside a template interpolation belongs to that
          // interpolation's nesting, tracked on the frame — NOT to our bracket
          // depth, or the matching `}` would look like the end of our body.
          interp[interp.length - 1].braceDepth++;
        } else if (c === '}' && interp.length > 0) {
          const f = interp[interp.length - 1];
          if (f.braceDepth === 0) {
            interp.pop();
            state = 'bq'; // back to the template text
          } else {
            f.braceDepth--;
          }
        } else if (c === '(' || c === '[' || c === '{') {
          depth++;
        } else if (c === ')' || c === ']' || c === '}') {
          if (depth === 0) {
            return i; // closes the call/array/object we are an argument of
          }
          depth--;
        } else if ((c === ',' || c === ';') && depth === 0) {
          return i;
        }
        break;
      case 'line-comment':
        break;
      case 'block-comment':
        if (c === '*' && next === '/') {
          state = 'code';
          i++;
        }
        break;
      case 'sq':
        if (c === '\\') {
          i++;
        } else if (c === "'") {
          state = 'code';
        }
        break;
      case 'dq':
        if (c === '\\') {
          i++;
        } else if (c === '"') {
          state = 'code';
        }
        break;
      case 'bq':
        if (c === '\\') {
          i++;
        } else if (c === '$' && next === '{') {
          interp.push({ braceDepth: 0 });
          state = 'code';
          i++;
        } else if (c === '`') {
          state = 'code';
        }
        break;
    }
  }
  return text.length;
}

/**
 * The synthetic block representing MODULE TOP LEVEL — the region outside every
 * brace-block. Top-level `const`/`var`/`let` declarations are data identities
 * like any other, so the file itself has to be a focusable scope; otherwise the
 * caret sitting among them resolves to no block, the phase machine drops to
 * Survey, and nothing paints.
 *
 * Depth is -1 so it never beats a real block, and the focus key is distinct from
 * any real block's (`openLine#depth`).
 */
export function topLevelBlock(text: string): BraceBlock {
  const lines = text.split('\n').length;
  return {
    openLine: 0,
    closeLine: Math.max(0, lines - 1),
    depth: -1,
    openOffset: 0,
    closeOffset: Math.max(0, text.length - 1),
    headerStart: 0,
  };
}

/** True for the synthetic top-level scope (see `topLevelBlock`). */
export function isTopLevelBlock(block: BraceBlock): boolean {
  return block.depth === -1;
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
): BraceBlock | null {
  let best: BraceBlock | null = null;
  for (const b of blocks) {
    if (!blockContainsCaret(b, caretLine, caretOffset)) {
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
function blockContainsCaret(b: BraceBlock, caretLine: number, caretOffset?: number): boolean {
  if (caretLine < b.openLine || caretLine > b.closeLine) {
    return false;
  }
  const singleLine = b.openLine === b.closeLine;
  if (singleLine && caretOffset !== undefined) {
    // Caret must sit between the braces (inclusive of the closing brace so a
    // click just inside still counts).
    return caretOffset > b.openOffset && caretOffset <= b.closeOffset;
  }
  return true;
}

/**
 * A stable identity for a focus block across re-scans. Lets the decorator's
 * reducer detect the dominant "same block, only phase changed" case and do zero
 * reclassification work. Keyed on the header line + depth: within one document
 * version those uniquely identify a block, and across edits the key drifting is
 * exactly what should force a re-tint (a cut).
 */
export function focusKeyOf(block: BraceBlock): string {
  return `${block.openLine}#${block.depth}`;
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
 * function signature.
 */
export function declRegionFor(text: string, block: BraceBlock): { start: number; end: number } {
  const body = { start: block.openOffset, end: block.closeOffset + 1 };
  if (isControlFlowHeader(text, block)) {
    return { start: block.headerStart, end: block.closeOffset + 1 };
  }
  return body;
}

/** Does this block's header read as control flow (rather than a function signature)? */
function isControlFlowHeader(text: string, block: BraceBlock): boolean {
  const header = text.slice(block.headerStart, block.openOffset);
  // Control-flow keywords are unambiguous and take precedence — `for (...) {`,
  // `if (...) {`, `while (...) {` all have parens too, so paren-based function
  // detection must not override them.
  return /\b(if|for|while|switch|else|do|range|select|case)\b/.test(header);
}

/** Does this block's header declare a function (so its params belong to it)? */
export function isFunctionHeader(text: string, block: BraceBlock): boolean {
  const header = text.slice(block.headerStart, block.openOffset);
  return /\b(func|function)\b|=>\s*$|\)\s*(:[^)]*)?\s*$/.test(header);
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
export function scopeRegionFor(text: string, block: BraceBlock): { start: number; end: number } {
  if (isControlFlowHeader(text, block)) {
    return { start: block.headerStart, end: block.closeOffset + 1 };
  }
  if (isFunctionHeader(text, block)) {
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
    return { start: paramListStart(text, block), end: block.closeOffset + 1 };
  }
  return { start: block.openOffset, end: block.closeOffset + 1 };
}

/**
 * Offset of the `(` opening this function block's parameter list, or `openOffset`
 * if none is found (e.g. a bare `x => {`, or a Go method value).
 *
 * Scans back from the `{` for the matching `(` of the LAST balanced paren group in
 * the header, so nested parens in defaults (`(a = f(1)) => {`) do not confuse it.
 */
function paramListStart(text: string, block: BraceBlock): number {
  let depth = 0;
  for (let i = block.openOffset - 1; i >= block.headerStart; i--) {
    const c = text[i];
    if (c === ')') {
      depth++;
    } else if (c === '(') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  // No paren group: a single-identifier arrow (`name => {`). Walk back over the
  // identifier and any `async` so the param itself is still inside the region.
  let i = block.openOffset - 1;
  while (i >= block.headerStart && /[\s=>]/.test(text[i])) {
    i--;
  }
  while (i >= block.headerStart && /[A-Za-z0-9_$]/.test(text[i])) {
    i--;
  }
  return Math.max(block.headerStart, i + 1);
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
export function lexRegionFor(text: string, block: BraceBlock): { start: number; end: number } {
  const start = isFunctionHeader(text, block) && !isControlFlowHeader(text, block)
    ? paramListStart(text, block)
    : block.headerStart;
  return { start, end: block.closeOffset + 1 };
}

export interface LexId {
  /** The identifier text. */
  name: string;
  /** Absolute character offset of the first char. */
  offset: number;
  /** Length in characters. */
  length: number;
}

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;

/**
 * Emit every identifier occurrence in `text` within [start, end), skipping any
 * that fall inside strings or comments. Reuses the same lexical state machine as
 * the brace scanner so the two never disagree about what is "code".
 *
 * Keywords are NOT filtered here — the caller decides (band-2 classification
 * filters language keywords; risk detection wants some of them). Word shape is
 * the JS/TS-ish `[A-Za-z_$][A-Za-z0-9_$]*`, which also covers most C-family and
 * Go identifiers; leading `@`/`#` sigils are handled by the caller.
 */
export function lexIdentifiers(text: string, start = 0, end = text.length): LexId[] {
  const ids: LexId[] = [];
  let state: ScanState = 'code';
  // Template-literal interpolation stack: each `${` opens a frame that tracks
  // its brace depth so identifiers inside `${…}` ARE lexed (they're real code)
  // while the surrounding template text stays opaque. Handles nesting:
  //   `a ${ obj.f(`b ${x}`) } c`.
  const interp: { braceDepth: number }[] = [];

  for (let i = 0; i < text.length && i < end; i++) {
    const c = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    if (c === '\n') {
      if (state === 'line-comment' || state === 'sq' || state === 'dq') {
        state = 'code';
      }
      continue;
    }

    switch (state) {
      case 'code':
        if (c === '/' && next === '/') {
          state = 'line-comment';
          i++;
        } else if (c === '/' && next === '*') {
          state = 'block-comment';
          i++;
        } else if (c === "'") {
          state = 'sq';
        } else if (c === '"') {
          state = 'dq';
        } else if (c === '`') {
          state = 'bq';
        } else if (c === '{' && interp.length > 0) {
          interp[interp.length - 1].braceDepth++;
        } else if (c === '}' && interp.length > 0) {
          const frame = interp[interp.length - 1];
          if (frame.braceDepth === 0) {
            // closes the `${…}` — return to the enclosing template body
            interp.pop();
            state = 'bq';
          } else {
            frame.braceDepth--;
          }
        } else if (ID_START.test(c)) {
          const from = i;
          i++;
          while (i < text.length && ID_PART.test(text[i])) {
            i++;
          }
          const name = text.slice(from, i);
          i--; // the for-loop ++ will re-advance past the last consumed char
          if (from >= start && from < end) {
            ids.push({ name, offset: from, length: name.length });
          }
        }
        break;

      case 'line-comment':
        break;

      case 'block-comment':
        if (c === '*' && next === '/') {
          state = 'code';
          i++;
        }
        break;

      case 'sq':
        if (c === '\\') {
          i++;
        } else if (c === "'") {
          state = 'code';
        }
        break;

      case 'dq':
        if (c === '\\') {
          i++;
        } else if (c === '"') {
          state = 'code';
        }
        break;

      case 'bq':
        if (c === '\\') {
          i++;
        } else if (c === '$' && next === '{') {
          // enter an interpolation: the `${…}` body is code
          interp.push({ braceDepth: 0 });
          state = 'code';
          i++; // consume the `{`
        } else if (c === '`') {
          state = 'code';
        }
        break;
    }
  }

  return ids;
}
