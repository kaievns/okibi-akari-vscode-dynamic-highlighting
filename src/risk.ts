/**
 * Band-3 risk marks — spec §risk (Edit phase, focused block only).
 *
 * Always "shape + colour, never colour alone":
 *   - async  — await/async keywords → --risk-async (cyan). Colour on a keyword.
 *   - danger — `as` casts and `any` → --risk-danger (bold). Trust erosion.
 *   - number — numeric literals inside the focused scope → --syn-number-engaged
 *              (clay). Clay engages only in the focused scope of an engaged phase.
 *   - escape — mutation that ESCAPES the block → --risk-escape dashed underline.
 *              A write to a binding bound OUTSIDE the block. Local bookkeeping
 *              (writes to block-local names) gets nothing.
 *
 * Diagnostics (error undercurl / warning underdotted) are LEFT to VS Code — we
 * never paint them, to avoid double-marking.
 *
 * Split by cost: lexicalRisk is synchronous (renders instantly on entering
 * Edit); escapeRisk needs the (debounced) classification and catches up when it
 * resolves.
 */

import { OffsetRange, Classification, Cls } from './classify';

export interface LexicalRisk {
  async: OffsetRange[];
  danger: OffsetRange[];
  numberEngaged: OffsetRange[];
}

type ScanState = 'code' | 'line-comment' | 'block-comment' | 'sq' | 'dq' | 'bq';

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

const ASYNC_WORDS = new Set(['await', 'async']);
const DANGER_WORDS = new Set(['as', 'any']);

/**
 * Scan a block's text for async/danger keywords and numeric literals. Offsets
 * are absolute (blockStart is the block's start offset in the document).
 *
 * Keyword marks fire on word-boundary matches in code (never inside strings or
 * comments, never as a substring of a longer identifier). Numeric literals
 * cover ints, decimals, hex/bin/octal prefixes and separators — enough that a
 * literal never gets mistaken for an identifier and vice-versa.
 */
export function lexicalRisk(text: string, block: OffsetRange): LexicalRisk {
  const result: LexicalRisk = { async: [], danger: [], numberEngaged: [] };
  let state: ScanState = 'code';

  for (let i = block.start; i < block.end && i < text.length; i++) {
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
        } else if (ID_START.test(c)) {
          const from = i;
          i++;
          while (i < text.length && ID_PART.test(text[i])) {
            i++;
          }
          const word = text.slice(from, i);
          i--;
          const range: OffsetRange = { start: from, end: from + word.length };
          if (ASYNC_WORDS.has(word)) {
            result.async.push(range);
          } else if (DANGER_WORDS.has(word)) {
            result.danger.push(range);
          }
        } else if (
          DIGIT.test(c) ||
          // A leading-dot float (`.5`) starts a number only if the previous char
          // isn't itself a dot — otherwise the `9` in a `0..9` range would be
          // misread as the float `.9`.
          (c === '.' && DIGIT.test(next) && text[i - 1] !== '.')
        ) {
          const from = i;
          // A hex/binary/octal literal (0x/0b/0o) has no decimal point or e/E
          // exponent — E is a hex digit there. Detect the prefix so we don't
          // misread `0xE+1` as one number, and so `..` never joins two literals.
          const isRadixPrefixed =
            c === '0' && /[xXbBoO]/.test(next);
          let sawDot = false;
          i++;
          while (i < text.length) {
            const ch = text[i];
            if (/[0-9]/.test(ch) || ch === '_' || ch === "'") {
              i++;
              continue;
            }
            if (isRadixPrefixed) {
              // hex/bin/oct body: letters a-f, x/b/o prefix char only. No dot, no exponent sign.
              if (/[a-fA-FxXbBoO]/.test(ch)) {
                i++;
                continue;
              }
              break;
            }
            // decimal/float body: a dot is only part of the number when it is a
            // decimal point — followed by a digit. `0..9` (range operator) and a
            // trailing `.` (member access, `x.foo`) both stop the literal.
            if (ch === '.') {
              const afterDot = i + 1 < text.length ? text[i + 1] : '';
              if (sawDot || !/[0-9]/.test(afterDot)) {
                break;
              }
              sawDot = true;
              i++;
              continue;
            }
            if (/[eEpP]/.test(ch)) {
              i++;
              // optional exponent sign immediately after e/E/p/P
              if (i < text.length && (text[i] === '+' || text[i] === '-')) {
                i++;
              }
              continue;
            }
            break;
          }
          result.numberEngaged.push({ start: from, end: i });
          i--;
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
        } else if (c === '`') {
          state = 'code';
        }
        break;
    }
  }

  return result;
}

/** Classes whose bindings live OUTSIDE the focused block — a write to them escapes. */
const ESCAPING: Set<Cls> = new Set(['fn', 'out', 'self']);

/**
 * Detect writes that escape the focused block: an identifier used as an
 * assignment target (`x =`, `x +=`, `x++`, `++x`) whose binding is classified
 * outside the block (fn / out / self). Writes to block-local names are local
 * bookkeeping and get nothing.
 *
 * This is a lexical approximation over the block, gated by the classification's
 * per-name class — accurate enough for the "escapes the block" signal without a
 * full data-flow pass. Compound operators and pre/post increment are covered;
 * equality (`==`, `===`) and comparison (`<=`, `>=`, `!=`, `=>`) are excluded.
 */
export function escapeRisk(text: string, block: OffsetRange, c: Classification): OffsetRange[] {
  const escapes: OffsetRange[] = [];
  const ids: { name: string; start: number; end: number }[] = [];
  let state: ScanState = 'code';

  // First, collect code-context identifiers within the block (reuse the scanner).
  for (let i = block.start; i < block.end && i < text.length; i++) {
    const ch = text[i];
    const next = i + 1 < text.length ? text[i + 1] : '';
    if (ch === '\n') {
      if (state === 'line-comment' || state === 'sq' || state === 'dq') {
        state = 'code';
      }
      continue;
    }
    switch (state) {
      case 'code':
        if (ch === '/' && next === '/') {
          state = 'line-comment';
          i++;
        } else if (ch === '/' && next === '*') {
          state = 'block-comment';
          i++;
        } else if (ch === "'") {
          state = 'sq';
        } else if (ch === '"') {
          state = 'dq';
        } else if (ch === '`') {
          state = 'bq';
        } else if (ID_START.test(ch)) {
          const from = i;
          i++;
          while (i < text.length && ID_PART.test(text[i])) {
            i++;
          }
          ids.push({ name: text.slice(from, i), start: from, end: i });
          i--;
        }
        break;
      case 'line-comment':
        break;
      case 'block-comment':
        if (ch === '*' && next === '/') {
          state = 'code';
          i++;
        }
        break;
      case 'sq':
        if (ch === '\\') {
          i++;
        } else if (ch === "'") {
          state = 'code';
        }
        break;
      case 'dq':
        if (ch === '\\') {
          i++;
        } else if (ch === '"') {
          state = 'code';
        }
        break;
      case 'bq':
        if (ch === '\\') {
          i++;
        } else if (ch === '`') {
          state = 'code';
        }
        break;
    }
  }

  const isEscaping = (name: string): boolean => {
    const info = c.byName.get(name);
    return info !== undefined && ESCAPING.has(info.cls);
  };

  // Skip whitespace forward from an offset.
  const skipWs = (from: number): number => {
    let j = from;
    while (j < text.length && (text[j] === ' ' || text[j] === '\t')) {
      j++;
    }
    return j;
  };

  for (const id of ids) {
    if (!isEscaping(id.name)) {
      continue;
    }
    // Post-increment / decrement: x++ / x--
    const after = text.slice(id.end, id.end + 2);
    if (after === '++' || after === '--') {
      escapes.push({ start: id.start, end: id.end });
      continue;
    }
    // Assignment: next non-space is `=` (not `==`), or a compound op `+=`, `-=`, etc.
    const j = skipWs(id.end);
    const a = text[j] ?? '';
    const b = text[j + 1] ?? '';
    const isCompound = '+-*/%&|^'.includes(a) && b === '=';
    const isPlainAssign = a === '=' && b !== '=' ; // exclude ==, and => is caught since a would be '='? handle below
    // Exclude arrow `=>` and comparison `>=`/`<=`/`!=` — those never start with a bare identifier target here anyway,
    // but guard `x =>` (param) and `x ==` explicitly.
    const arrow = a === '=' && b === '>';
    if ((isPlainAssign && !arrow) || isCompound) {
      escapes.push({ start: id.start, end: id.end });
      continue;
    }
    // Pre-increment / decrement: ++x / --x
    const beforeTwo = text.slice(Math.max(0, id.start - 2), id.start);
    if (beforeTwo === '++' || beforeTwo === '--') {
      escapes.push({ start: id.start, end: id.end });
    }
  }

  return escapes;
}
