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

  return blocks;
}

/**
 * The innermost block containing `caretLine` — spec §3.2. Among all blocks
 * whose [openLine, closeLine] span the caret, the one with greatest depth wins;
 * ties (which shouldn't happen for well-formed nesting) break to the tightest
 * span. Returns null when the caret is at module top level (→ Survey).
 */
export function innermostBlock(
  blocks: BraceBlock[],
  caretLine: number,
  caretOffset?: number,
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

/**
 * The region used for LEXING — deciding which names count as "used in this
 * block" and are therefore candidates for a hue.
 *
 * ALWAYS header-inclusive, for every block kind. The header line carries a
 * block's most important bindings:
 *   - control flow: `for _, c := range xs {`, `if v, ok := m[k]; ok {`
 *   - functions:    `go func(cfg Config) {`, `echo := func(ctx *Context) {`
 * Those names live BEFORE the `{`, so a body-only region makes them invisible
 * in their own scope — which is why a closure's params used to tint only from
 * the PARENT block (whose range covers the header line) and never from inside
 * the closure itself.
 *
 * This is deliberately wider than `declRegionFor`: classification still needs
 * the narrower region so a function's params classify as fn-local (whole-scope)
 * rather than block-local (which would trip the ≥2-use gate).
 */
export function lexRegionFor(_text: string, block: BraceBlock): { start: number; end: number } {
  return { start: block.headerStart, end: block.closeOffset + 1 };
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
