/**
 * Focus resolution — spec §1 (Vocabulary) and §3.2.
 *
 *   Brace-block   — any {…} span, header line through closing line.
 *   Focus         — the *innermost* brace-block containing the caret line.
 *                   Deepest scope wins, plain and predictable. (Spec §1: the
 *                   smarter hysteresis version was scrapped as confusing.)
 *
 * This slice uses a brace scanner rather than LSP scopes. That's deliberate:
 * the spec's production path keys classification off LSP references (§7), but
 * focus itself is purely structural — "the innermost {…} around the caret" —
 * and a brace scan resolves it identically while staying language-agnostic and
 * synchronous (no await on every caret move). Strings, comments and char
 * literals are skipped so their braces don't open phantom blocks.
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
}

type ScanState = 'code' | 'line-comment' | 'block-comment' | 'sq' | 'dq' | 'bq';

/**
 * Scan the whole document once and return every brace-block, each as a
 * (openLine, closeLine, depth) triple. A single pass is O(chars); we re-run it
 * on document change and cache per version (see decorator).
 *
 * The scanner is intentionally lexical and language-neutral. It understands the
 * common string/comment shapes (//, /* *​/, ', ", `) well enough that their
 * braces don't count. It is not a parser — it does not know that Python has no
 * braces, or that Rust lifetimes use `'`. Those are acceptable: on a braceless
 * language the block list is simply empty and the layer stays in Survey, which
 * is the correct at-rest behaviour anyway.
 */
export function scanBraceBlocks(text: string): BraceBlock[] {
  const blocks: BraceBlock[] = [];
  const stack: { openLine: number }[] = [];
  let state: ScanState = 'code';
  let line = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';

    if (c === '\n') {
      line++;
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
          stack.push({ openLine: line });
        } else if (c === '}') {
          const open = stack.pop();
          if (open) {
            blocks.push({
              openLine: open.openLine,
              closeLine: line,
              depth: stack.length, // depth after popping = this block's depth
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
export function innermostBlock(blocks: BraceBlock[], caretLine: number): BraceBlock | null {
  let best: BraceBlock | null = null;
  for (const b of blocks) {
    if (b.openLine <= caretLine && caretLine <= b.closeLine) {
      if (
        best === null ||
        b.depth > best.depth ||
        (b.depth === best.depth && b.closeLine - b.openLine < best.closeLine - best.openLine)
      ) {
        best = b;
      }
    }
  }
  return best;
}
