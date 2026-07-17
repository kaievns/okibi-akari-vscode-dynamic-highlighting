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
  const stack: { openLine: number; openOffset: number }[] = [];
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
          stack.push({ openLine: line, openOffset: i });
        } else if (c === '}') {
          const open = stack.pop();
          if (open) {
            blocks.push({
              openLine: open.openLine,
              closeLine: line,
              depth: stack.length, // depth after popping = this block's depth
              openOffset: open.openOffset,
              closeOffset: i,
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
