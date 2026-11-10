/**
 * The shared, language-aware lexer. Every scanner in the layer reads code vs
 * comment vs string from here instead of running its own state machine.
 *
 * One pass per (text, languageId), memoised by `lexFor`; region queries are
 * binary searches over the result. Rules per language and known limits:
 * docs/lexer.md.
 */

import { IntervalIndex, bestAt, buildIntervalIndex } from './intervals';

export type Region = 'code' | 'comment' | 'doc' | 'string';

export interface LexSpan {
  start: number;
  end: number;
  region: Exclude<Region, 'code'>;
}

export interface LexRange {
  start: number;
  end: number;
}

export interface LexId {
  /** The identifier text. */
  name: string;
  /** Absolute character offset of the first char. */
  offset: number;
  /** Length in characters. */
  length: number;
}

type Family = 'js' | 'go' | 'python' | 'rust' | 'c' | 'java' | 'kotlin' | 'nested' | 'hash' | 'lua' | 'ruby' | 'zig' | 'default';

export interface LangSyntax {
  readonly family: Family;
  /** Memo key: two languageIds with the same key lex identically. */
  readonly key: string;
  readonly jsx: boolean;
  readonly cppRaw: boolean;
  /** Shell: `#` starts a comment only at the start of a word. */
  readonly shellHash: boolean;
}

const SYNTAX_BY_ID: Record<string, LangSyntax> = {};
const def = (ids: string[], s: LangSyntax): void => {
  for (const id of ids) SYNTAX_BY_ID[id] = s;
};
const base = { jsx: false, cppRaw: false, shellHash: false };
def(['typescript', 'typescript-declaration'], { ...base, family: 'js', key: 'ts' });
def(['javascript', 'javascriptreact', 'typescriptreact'], { ...base, family: 'js', key: 'jsx', jsx: true });
def(['go'], { ...base, family: 'go', key: 'go' });
def(['python'], { ...base, family: 'python', key: 'python' });
def(['rust'], { ...base, family: 'rust', key: 'rust' });
def(['c', 'objective-c'], { ...base, family: 'c', key: 'c' });
def(['cpp', 'cuda-cpp', 'objective-cpp'], { ...base, family: 'c', key: 'cpp', cppRaw: true });
def(['java'], { ...base, family: 'java', key: 'java' });
def(['kotlin'], { ...base, family: 'kotlin', key: 'kotlin' });
def(['swift', 'scala', 'dart'], { ...base, family: 'nested', key: 'nested' });
def(['perl', 'r', 'julia', 'elixir', 'coffeescript', 'powershell'], { ...base, family: 'hash', key: 'hash' });
def(['shellscript'], { ...base, family: 'hash', key: 'sh', shellHash: true });
def(['lua'], { ...base, family: 'lua', key: 'lua' });
def(['ruby'], { ...base, family: 'ruby', key: 'ruby' });
def(['zig', 'zon'], { ...base, family: 'zig', key: 'zig' });
const DEFAULT_SYNTAX: LangSyntax = { ...base, family: 'default', key: 'default' };

export function syntaxFor(languageId?: string): LangSyntax {
  return (languageId !== undefined && SYNTAX_BY_ID[languageId]) || DEFAULT_SYNTAX;
}

export interface LexResult {
  readonly syntax: LangSyntax;
  readonly text: string;
  /** Offset of the first char of every line; every `\n` counts, escaped or not. */
  readonly lineStarts: number[];
  /** Sorted, non-overlapping non-code spans. Interpolation holes are gaps. */
  readonly spans: LexSpan[];
  /** Code regions inside strings (`${…}`, f-string `{…}`, Kotlin `$x`), sorted by start. */
  readonly holes: LexRange[];
  /** Code identifiers in document order (holes included, string prefixes and lifetimes excluded). */
  readonly idents: LexId[];
  /** Code numeric literals in document order. */
  readonly numbers: LexRange[];
  /** Offsets of code `{ } ( ) [ ] , ; :` in document order. */
  readonly punct: number[];
  isCode(offset: number): boolean;
  regionAt(offset: number): Region;
  spanAt(offset: number): LexSpan | undefined;
  /** Index of the first span starting at or after `offset`. */
  spanIndexFrom(offset: number): number;
  identsIn(start: number, end: number): LexId[];
  numbersIn(start: number, end: number): LexRange[];
  /** Index into `punct` of the first entry at or after `offset`. */
  punctFrom(offset: number): number;
  /** End of the innermost interpolation hole containing `offset`, else text length. */
  holeEndAt(offset: number): number;
  /** Offset of the innermost unclosed code `(`, `[` or `{` before `offset`, else -1. */
  enclosingOpen(offset: number): number;
  /** Index of the last non-blank char before `offset` that is not in a comment or doc span, else -1. */
  prevSignificant(offset: number): number;
  lineOf(offset: number): number;
}

// ── char classes ──────────────────────────────────────────────────────────────

const ID_START_ASCII = new Uint8Array(128);
const ID_PART_ASCII = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  if (/[A-Za-z_$]/.test(ch)) ID_START_ASCII[c] = 1;
  if (/[A-Za-z0-9_$]/.test(ch)) ID_PART_ASCII[c] = 1;
}
const ID_START_RE = /\p{ID_Start}/u;
const ID_PART_RE = /[\p{ID_Continue}\u200c\u200d]/u;

/** Width (1 or 2 UTF-16 units) of an identifier-start char at `i`, else 0. */
function idStartWidth(t: string, i: number): number {
  const c = t.charCodeAt(i);
  if (c < 128) return ID_START_ASCII[c];
  if (Number.isNaN(c)) return 0;
  const cp = t.codePointAt(i)!;
  return ID_START_RE.test(String.fromCodePoint(cp)) ? (cp > 0xffff ? 2 : 1) : 0;
}

function idPartWidth(t: string, i: number): number {
  const c = t.charCodeAt(i);
  if (c < 128) return ID_PART_ASCII[c];
  if (Number.isNaN(c)) return 0;
  const cp = t.codePointAt(i)!;
  return ID_PART_RE.test(String.fromCodePoint(cp)) ? (cp > 0xffff ? 2 : 1) : 0;
}

function scanIdent(t: string, i: number, dollar = true): number {
  let w = idStartWidth(t, i);
  if (w === 0 || (!dollar && t.charCodeAt(i) === CH.dollar)) return i;
  i += w;
  while ((w = idPartWidth(t, i)) > 0 && (dollar || t.charCodeAt(i) !== CH.dollar)) i += w;
  return i;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isAsciiWord = (c: number): boolean => c < 128 && ID_PART_ASCII[c] === 1 && c !== 36;

const CH = {
  tab: 9, lf: 10, vt: 11, ff: 12, cr: 13, sp: 32, bang: 33, dq: 34, hash: 35, dollar: 36,
  sq: 39, lparen: 40, rparen: 41, star: 42, plus: 43, comma: 44, minus: 45, dot: 46,
  slash: 47, colon: 58, semi: 59, lt: 60, eq: 61, gt: 62, lbrack: 91, bslash: 92,
  rbrack: 93, bq: 96, lbrace: 123, rbrace: 125, at: 64,
} as const;

/** Keywords after which a JS `/` starts a regex and a `<` starts JSX. */
const JS_EXPR_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'default', 'do', 'else', 'yield', 'await',
]);

const enum Stop { Eof, Hole, HoleLine, JsxExpr, FHole, FHoleLine }

/** Ruby words after which `/`, `%`, `?`, `<<` and `:` start a literal. */
const RUBY_EXPR_KEYWORDS = new Set([
  'if', 'unless', 'while', 'until', 'and', 'or', 'not', 'return', 'when', 'in', 'case', 'then', 'else', 'elsif',
  'do', 'yield', 'break', 'next', 'begin', 'ensure', 'rescue', 'defined?',
]);
/** After `def`: the receiver and the name, up to the parameters. */
const RUBY_DEF_HEAD = /^[ \t]+(?:(?:self|[A-Za-z_]\w*)[ \t]*\.[ \t]*)?(?:[A-Za-z_]\w*(?:[?!]|=(?=\())?|\[\]=?|===?|<=>|=~|!=|!~|\*\*|<<|>>|<=|>=|[+\-]@|[+\-*\/%&|^~<>!`])/;
/** `rubyParams` list ends other than a closing character. */
const LINE_END = -1;
const LAMBDA_BODY = -2;
/** Ruby operator method names, longest first, as a symbol (`:<=>`) or after `def`. */
const RUBY_OPERATOR_NAMES = ['[]=', '===', '<=>', '[]', '**', '==', '=~', '!=', '!~', '<<', '>>', '<=', '>=', '+@', '-@',
  '!', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '~', '`'];
const RUBY_PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
/** `$` + one of these is a special global: `$!`, `$~`, `$"`, `$0`. */
const RUBY_SPECIAL_GLOBAL = new Set('!@~&`\'+;,/\\.<>_*$?:"0123456789='.split(''));

interface Heredoc { id: string; indented: boolean; interp: boolean }

const MAX_NEST = 64;

// ── the lexer ─────────────────────────────────────────────────────────────────

class Lexer {
  readonly n: number;
  readonly spans: LexSpan[] = [];
  readonly holes: LexRange[] = [];
  readonly idents: LexId[] = [];
  readonly numbers: LexRange[] = [];
  readonly punct: number[] = [];
  /** Line starts the top-level loop reached, with its state there: 3 numbers each. */
  readonly cpOff: number[] = [];
  readonly cpState: number[] = [];
  /** Pairs (offset, farthest offset read) for decisions that read past their own line and left no span over it. */
  readonly longReads: number[] = [];
  /**
   * Ruby's local-variable table, as Ruby's own lexer keeps one: `locals` outside a `def`, `inner` in the
   * open `def`, whose line indentation is `defIndent` (-1 outside). `localOffsets` and `localNames` record
   * where each name entered `locals` (the offset of the decision); `defStarts` each `def` that opened a scope.
   */
  readonly locals: Set<string> | undefined;
  readonly localOffsets: number[] = [];
  readonly localNames: string[] = [];
  readonly defStarts: number[] = [];
  defIndent = -1;
  private inner: string[] = [];
  /** Asked at each top-level checkpoint; true ends the lex there. */
  stopAt: ((offset: number, index: number) => boolean) | undefined;
  stoppedAt = -1;
  exprStart = true;
  stmtStart = true;
  private nest = 0;
  private readonly fam: Family;
  /** Ruby heredocs opened on the current line, read from the next line break. */
  private heredocs: Heredoc[] = [];
  private readonly slashComments: boolean;
  private readonly nests: boolean;

  constructor(readonly t: string, readonly syn: LangSyntax) {
    this.n = t.length;
    this.fam = syn.family;
    this.slashComments = this.fam !== 'python' && this.fam !== 'hash' && this.fam !== 'lua' && this.fam !== 'ruby';
    this.nests = this.fam === 'rust' || this.fam === 'kotlin' || this.fam === 'nested';
    this.locals = this.fam === 'ruby' ? new Set() : undefined;
  }

  run(): void {
    let i = 0;
    if (this.t.startsWith('#!') && (this.fam === 'js' || this.fam === 'default' || this.fam === 'lua')) {
      i = this.lineComment(0);
    }
    this.code(i, Stop.Eof);
  }

  private span(start: number, end: number, region: LexSpan['region']): void {
    if (end > start) this.spans.push({ start, end, region });
  }

  private openHole(start: number): number {
    return this.holes.push({ start, end: -1 }) - 1;
  }

  /**
   * Lex code from `i`. Returns the offset of the char that ended the segment: the
   * `}` closing a hole, the `:`/`!` opening an f-string spec or conversion, a line
   * end for a single-line hole, or the text length.
   */
  code(i: number, stop: Stop, depth = 0, bdepth = 0): number {
    const t = this.t;
    const n = this.n;
    const fam = this.fam;
    const lineBound = stop === Stop.HoleLine || stop === Stop.FHoleLine;
    const fhole = stop === Stop.FHole || stop === Stop.FHoleLine;
    const braceStop = stop !== Stop.Eof;
    while (i < n) {
      const c = t.charCodeAt(i);
      if (c === CH.lf) {
        if (lineBound) return i;
        if (stop === Stop.Eof && bdepth <= 0) this.stmtStart = true;
        i++;
        if (fam === 'ruby') {
          this.exprStart = true;
          if (this.heredocs.length > 0) i = this.heredocBodies(i);
        }
        if (stop === Stop.Eof) {
          if (this.defIndent >= 0) this.rubyScopeLine(i);
          this.cpOff.push(i);
          this.cpState.push((this.exprStart ? 1 : 0) | (this.stmtStart ? 2 : 0) | ((this.defIndent + 1) << 2), depth, bdepth);
          if (this.stopAt !== undefined && this.stopAt(i, this.cpOff.length - 1)) {
            this.stoppedAt = i;
            return i;
          }
        }
        continue;
      }
      if (c === CH.sp || c === CH.tab || c === CH.cr || c === CH.ff || c === CH.vt) {
        if (lineBound && c === CH.cr && t.charCodeAt(i + 1) === CH.lf) return i;
        i++;
        continue;
      }
      const next = t.charCodeAt(i + 1);

      if (c === CH.slash && this.slashComments && (next === CH.slash || (next === CH.star && fam !== 'zig'))) {
        i = next === CH.slash ? this.lineComment(i) : this.blockComment(i);
        continue;
      }
      if (fam === 'zig' && (c === CH.at || (c === CH.bslash && next === CH.bslash))) {
        const r = this.zigAt(i, c, next);
        if (r >= 0) {
          i = r;
          continue;
        }
      }
      if (fam === 'ruby') {
        const r = this.rubyLiteral(i, c, next);
        if (r >= 0) {
          i = r;
          continue;
        }
      }
      if (fam === 'lua' && ((c === CH.minus && next === CH.minus) || (c === CH.lbrack && (next === CH.lbrack || next === CH.eq)))) {
        const r = c === CH.minus ? this.luaComment(i) : this.luaLong(i, i, 'string');
        if (r >= 0) {
          i = r;
          continue;
        }
      }
      if (c === CH.hash) {
        const r = this.hash(i);
        if (r >= 0) {
          i = r;
          continue;
        }
      }
      if (c === CH.dq || c === CH.sq || c === CH.bq) {
        const r = this.quote(i, i);
        if (r >= 0) {
          i = r;
          continue;
        }
      }
      if (fam === 'python' && c === CH.bslash && (next === CH.lf || (next === CH.cr && t.charCodeAt(i + 2) === CH.lf))) {
        i += next === CH.lf ? 2 : 3;
        continue;
      }
      if (idStartWidth(t, i) > 0) {
        i = this.identifier(i);
        continue;
      }
      if (isDigit(c) || (c === CH.dot && isDigit(next) && (fam === 'js' ? this.exprStart : !this.operandBefore(i)))) {
        i = this.number(i);
        continue;
      }

      switch (c) {
        case CH.lbrace:
          depth++;
          bdepth++;
          this.punct.push(i);
          this.exprStart = true;
          this.stmtStart = false;
          if (fam === 'ruby') this.rubyBlockParams(i, i + 1);
          break;
        case CH.rbrace:
          if (braceStop && depth === 0) return i;
          depth--;
          bdepth--;
          this.punct.push(i);
          this.exprStart = fam !== 'ruby';
          this.stmtStart = false;
          break;
        case CH.lparen:
        case CH.lbrack:
          bdepth++;
          this.punct.push(i);
          this.exprStart = true;
          this.stmtStart = false;
          break;
        case CH.rparen:
        case CH.rbrack:
          bdepth--;
          this.punct.push(i);
          this.exprStart = false;
          this.stmtStart = false;
          break;
        case CH.comma:
          this.punct.push(i);
          this.exprStart = true;
          this.stmtStart = false;
          break;
        case CH.semi:
          this.punct.push(i);
          this.exprStart = true;
          this.stmtStart = true;
          break;
        case CH.colon:
          if (fhole && bdepth === 0) return i;
          this.punct.push(i);
          this.exprStart = true;
          this.stmtStart = stop === Stop.Eof && bdepth <= 0;
          break;
        case CH.bang:
          if (fhole && bdepth === 0 && next !== CH.eq) return i;
          this.exprStart = true;
          this.stmtStart = false;
          break;
        case CH.slash:
          if (fam === 'js' && this.exprStart) {
            const r = this.regex(i);
            if (r >= 0) {
              i = r;
              continue;
            }
          }
          this.exprStart = true;
          this.stmtStart = false;
          break;
        case CH.lt:
          if (this.syn.jsx && this.exprStart && (idStartWidth(t, i + 1) > 0 || next === CH.gt)) {
            const r = this.tryJsx(i);
            if (r >= 0) {
              i = r;
              this.exprStart = false;
              continue;
            }
          }
          this.exprStart = true;
          this.stmtStart = false;
          break;
        case CH.plus:
        case CH.minus:
          if (next === c) {
            i += 2;
            this.exprStart = false;
            this.stmtStart = false;
            continue;
          }
          if (c === CH.minus && next === CH.gt && fam === 'ruby') this.rubyLambdaParams(i);
          this.exprStart = true;
          this.stmtStart = false;
          break;
        default:
          this.exprStart = true;
          this.stmtStart = false;
          break;
      }
      i++;
    }
    return n;
  }

  // ── comments ────────────────────────────────────────────────────────────────

  /** End of the line starting at or after `i`, before `\r\n` / `\n`. */
  private lineEnd(i: number): number {
    const t = this.t;
    let nl = t.indexOf('\n', i);
    if (nl < 0) return this.n;
    if (nl > i && t.charCodeAt(nl - 1) === CH.cr) nl--;
    return nl;
  }

  private lineComment(i: number): number {
    const t = this.t;
    let end = this.lineEnd(i);
    if (this.fam === 'c') {
      while (end < this.n && end > i && t.charCodeAt(end - 1) === CH.bslash) {
        end = this.lineEnd(t.indexOf('\n', end) + 1);
      }
    }
    this.span(i, end, 'comment');
    return end;
  }

  private blockComment(i: number): number {
    const t = this.t;
    const n = this.n;
    let j = i + 2;
    let depth = 1;
    while (j < n) {
      const c = t.charCodeAt(j);
      if (c === CH.star && t.charCodeAt(j + 1) === CH.slash) {
        j += 2;
        if (--depth === 0) break;
        continue;
      }
      if (this.nests && c === CH.slash && t.charCodeAt(j + 1) === CH.star) {
        depth++;
        j += 2;
        continue;
      }
      j++;
    }
    const end = Math.min(j, n);
    this.span(i, end, 'comment');
    return end;
  }

  /**
   * Zig at `i`: a `\\` multiline string line, to its line end; a `@"…"` quoted
   * identifier or a `@name` builtin, each one identifier with its `@`. Else -1.
   */
  private zigAt(i: number, c: number, next: number): number {
    const t = this.t;
    let end: number;
    if (c === CH.bslash) {
      end = this.lineEnd(i);
      this.span(i, end, 'string');
    } else if (next === CH.dq) {
      end = i + 2;
      while (end < this.n && t.charCodeAt(end) !== CH.dq && this.newlineAt(end) === 0) {
        end += t.charCodeAt(end) === CH.bslash ? this.escapeWidth(end) : 1;
      }
      if (t.charCodeAt(end) === CH.dq) end++;
      this.idents.push({ name: t.slice(i, end), offset: i, length: end - i });
    } else if (idStartWidth(t, i + 1) > 0) {
      end = scanIdent(t, i + 1, false);
      this.idents.push({ name: t.slice(i, end), offset: i, length: end - i });
    } else {
      return -1;
    }
    this.exprStart = false;
    this.stmtStart = false;
    return end;
  }

  /** `#` per language. Returns the next offset, or -1 when `#` is plain punctuation. */
  private hash(i: number): number {
    const t = this.t;
    switch (this.fam) {
      case 'python':
      case 'ruby':
        return this.lineComment(i);
      case 'hash': {
        if (this.syn.shellHash) {
          const p = t.charCodeAt(i - 1);
          if (i > 0 && !(p === CH.sp || p === CH.tab || p === CH.lf || p === CH.cr || p === CH.semi
              || p === 124 || p === 38 || p === CH.lparen || p === CH.rparen)) {
            return -1;
          }
        }
        return this.lineComment(i);
      }
      case 'js': {
        if (idStartWidth(t, i + 1) === 0) return -1;
        const end = scanIdent(t, i + 1);
        this.idents.push({ name: t.slice(i, end), offset: i, length: end - i });
        this.exprStart = false;
        return end;
      }
      case 'c':
        return this.atLineStart(i) ? this.directive(i) : -1;
      default:
        return -1;
    }
  }

  private atLineStart(i: number): boolean {
    const t = this.t;
    for (let j = i - 1; j >= 0; j--) {
      const c = t.charCodeAt(j);
      if (c === CH.lf) return true;
      if (c !== CH.sp && c !== CH.tab && c !== CH.cr) return false;
    }
    return true;
  }

  /** A C preprocessor line. The directive name is not an identifier; the rest lexes as code. */
  private directive(i: number): number {
    const t = this.t;
    let j = i + 1;
    while (t.charCodeAt(j) === CH.sp || t.charCodeAt(j) === CH.tab) j++;
    const nameEnd = scanIdent(t, j);
    const name = t.slice(j, nameEnd);
    j = nameEnd;
    while (t.charCodeAt(j) === CH.sp || t.charCodeAt(j) === CH.tab) j++;
    if ((name === 'include' || name === 'import' || name === 'include_next') && t.charCodeAt(j) === CH.lt) {
      const le = this.lineEnd(j);
      const gt = t.indexOf('>', j);
      const end = gt >= 0 && gt < le ? gt + 1 : le;
      this.span(j, end, 'string');
      return end;
    }
    if (name === 'if' && t.charCodeAt(j) === 48 && !isAsciiWord(t.charCodeAt(j + 1))) {
      return this.ifZero(j);
    }
    return nameEnd;
  }

  /** `#if 0` … `#else`/`#elif`/`#endif`: the dead branch is a comment. */
  private ifZero(zeroAt: number): number {
    const t = this.t;
    const n = this.n;
    this.numbers.push({ start: zeroAt, end: zeroAt + 1 });
    let le = this.lineEnd(zeroAt);
    while (le < n && le > zeroAt && t.charCodeAt(le - 1) === CH.bslash) le = this.lineEnd(t.indexOf('\n', le) + 1);
    const nl = t.indexOf('\n', le);
    if (nl < 0) return n;
    const bodyStart = nl + 1;
    let ls = bodyStart;
    let nestDepth = 0;
    while (ls < n) {
      const m = /^[ \t]*#[ \t]*(\w+)/.exec(t.slice(ls, Math.min(n, ls + 64)));
      if (m) {
        const d = m[1];
        if (d === 'if' || d === 'ifdef' || d === 'ifndef') nestDepth++;
        else if (d === 'endif' && nestDepth > 0) nestDepth--;
        else if (nestDepth === 0 && (d === 'endif' || d === 'else' || d === 'elif' || d === 'elifdef' || d === 'elifndef')) {
          this.span(bodyStart, ls, 'comment');
          return ls;
        }
      }
      const next = t.indexOf('\n', ls);
      if (next < 0) break;
      ls = next + 1;
    }
    this.span(bodyStart, n, 'comment');
    return n;
  }

  /** Lua `--` comment: a long one when a long bracket follows, else to the line end. */
  private luaComment(i: number): number {
    const r = this.luaLong(i, i + 2, 'comment');
    return r >= 0 ? r : this.lineComment(i);
  }

  /**
   * Lua long bracket at `open` (`[[`, `[==[`), closed by `]`, as many `=`, and `]`.
   * The span starts at `start`, the `--` of a long comment. -1 when none opens at `open`.
   */
  private luaLong(start: number, open: number, region: 'comment' | 'string'): number {
    const t = this.t;
    if (t.charCodeAt(open) !== CH.lbrack) return -1;
    let j = open + 1;
    while (t.charCodeAt(j) === CH.eq) j++;
    if (t.charCodeAt(j) !== CH.lbrack) return -1;
    const e = t.indexOf(']' + '='.repeat(j - open - 1) + ']', j + 1);
    const end = e < 0 ? this.n : e + j - open + 1;
    this.span(start, end, region);
    if (region === 'string') {
      this.exprStart = false;
      this.stmtStart = false;
    }
    return end;
  }

  /** Lua `'…'` / `"…"`: single-line; `\` + line break and `\z` + blanks continue it. */
  private luaShort(start: number, q: number): number {
    const t = this.t;
    const n = this.n;
    const quote = t.charCodeAt(q);
    let j = q + 1;
    while (j < n) {
      const c = t.charCodeAt(j);
      if (c === CH.bslash) {
        if (t.charCodeAt(j + 1) === 122 /* z */) {
          j += 2;
          while (j < n && /\s/.test(t[j])) j++;
          continue;
        }
        j += this.escapeWidth(j);
        continue;
      }
      if (c === quote) {
        j++;
        this.span(start, j, 'string');
        return j;
      }
      if (this.newlineAt(j) > 0) break;
      j++;
    }
    const end = Math.min(j, n);
    this.span(start, end, 'string');
    return end;
  }

  // ── Ruby ─────────────────────────────────────────────────────────────────────

  /** A Ruby literal or sigil at `i`: `=begin`, `@x`, `$x`, `?a`, `%w[…]`, `/re/`, `:sym`, `<<~ID`. -1 when none starts there. */
  private rubyLiteral(i: number, c: number, next: number): number {
    const t = this.t;
    switch (c) {
      case CH.eq:
        return next === 98 && t.startsWith('=begin', i) && this.atColumn0(i) && this.blankOrEnd(i + 6) ? this.embdoc(i) : -1;
      case 64: {
        const at = next === 64 ? i + 2 : i + 1;
        if (idStartWidth(t, at) === 0 || t.charCodeAt(at) === CH.dollar) return -1;
        return this.pushIdent(i, scanIdent(t, at, false));
      }
      case CH.dollar:
        return this.rubyGlobal(i);
      case 63:
        return this.rubyChar(i);
      case 37:
        return this.rubyPercent(i);
      case CH.slash:
        return this.rubyRegexStart(i) ? this.rubyDelimited(i, i + 1, '/', '', true, true) : -1;
      case CH.colon:
        return this.rubySymbol(i);
      case CH.lt:
        return next === CH.lt ? this.rubyHeredocOpen(i) : -1;
      default:
        return -1;
    }
  }

  // ── Ruby's local-variable table ─────────────────────────────────────────────

  /** `name` enters the table at `at`. */
  private declareLocal(at: number, name: string): void {
    if (this.defIndent >= 0) {
      this.inner.push(name);
      return;
    }
    const s = this.locals!;
    if (s.has(name)) return;
    s.add(name);
    this.localOffsets.push(at);
    this.localNames.push(name);
  }

  /** The Ruby name at `t[i, end)` read as a local: the table holds it and no `.`, `::`, `@` or `$` comes before it. */
  private isLocal(i: number, end: number): boolean {
    const t = this.t;
    const p = t.charCodeAt(i - 1);
    if (p === CH.dot || p === 64 || p === CH.dollar || (p === CH.colon && t.charCodeAt(i - 2) === CH.colon)) return false;
    const name = t.slice(i, end);
    return this.defIndent >= 0 ? this.inner.includes(name) : this.locals!.has(name);
  }

  /** A `def` at `i` opens a scope of its own, which the first later line indented no deeper closes. */
  private rubyOpenScope(i: number): void {
    const t = this.t;
    let j = t.lastIndexOf('\n', i - 1) + 1;
    const ls = j;
    while (t.charCodeAt(j) === CH.sp || t.charCodeAt(j) === CH.tab) j++;
    this.defIndent = j - ls;
    this.inner = [];
    this.defStarts.push(i);
  }

  /** At the line start `i`: a code line indented no deeper than the open `def` closes its scope; `rescue`, `else` and `ensure` do not. */
  private rubyScopeLine(i: number): void {
    const t = this.t;
    let j = i;
    while (t.charCodeAt(j) === CH.sp || t.charCodeAt(j) === CH.tab) j++;
    const c = t.charCodeAt(j);
    if (j - i > this.defIndent || Number.isNaN(c) || c === CH.lf || c === CH.cr || c === CH.hash || (j === i && t.startsWith('=begin', j))) return;
    if (/^(?:rescue|else|ensure)(?![\w?!:])/.test(t.slice(j, j + 8))) return;
    this.defIndent = -1;
    this.inner = [];
  }

  /** `name =`, `name += …`, `name ||= …` and the other compound assignments, from the end of the name. */
  private assignmentAfter(j: number): boolean {
    const t = this.t;
    while (t.charCodeAt(j) === CH.sp || t.charCodeAt(j) === CH.tab) j++;
    let c = t.charCodeAt(j);
    const d = t.charCodeAt(j + 1);
    if ((c === CH.star && d === CH.star) || (c === 124 && d === 124) || (c === 38 && d === 38) || (c === CH.lt && d === CH.lt) || (c === CH.gt && d === CH.gt)) {
      j += 2;
    } else if (c === CH.plus || c === CH.minus || c === CH.star || c === CH.slash || c === 37 || c === 124 || c === 38 || c === 94) {
      j++;
    } else if (c !== CH.eq) {
      return false;
    }
    c = t.charCodeAt(j);
    const e = t.charCodeAt(j + 1);
    return c === CH.eq && e !== CH.eq && e !== 126 && e !== CH.gt;
  }

  /** `a, b = …` and `a, (b, *c), d.e = …` from a statement's first name at `i`: every plain name before the `=` is a local. */
  private rubyMultipleAssignment(i: number, end: number): void {
    const t = this.t;
    let j = end;
    while (t.charCodeAt(j) === CH.sp || t.charCodeAt(j) === CH.tab) j++;
    if (t.charCodeAt(j) !== CH.comma) return;
    const le = this.lineEnd(i);
    const m = /^[\w\s,*().@$]*?=(?![=~>])/u.exec(t.slice(end, Math.min(le, end + 512)));
    if (!m) return;
    this.declareLocal(i, t.slice(i, end));
    for (const n of m[0].slice(0, -1).matchAll(/(?<=^|[,(*][ \t]*)([a-z_\p{Ll}\p{Lo}][\w\p{L}\p{N}]*)(?=[ \t]*(?:[,)]|$))/gu)) {
      this.declareLocal(i, n[1]);
    }
  }

  /** `def name(a, b = 1, *c, d:, **e, &f)` and `def name a, b`: each parameter is a local. */
  private rubyDefParams(at: number, from: number): void {
    const t = this.t;
    const m = RUBY_DEF_HEAD.exec(t.slice(from, from + 256));
    if (!m) return;
    let j = from + m[0].length;
    if (t.charCodeAt(j) === CH.lparen) {
      const far = this.rubyParams(at, j + 1, CH.rparen);
      if (far > this.lineEnd(at)) this.longReads.push(at, far);
      return;
    }
    if (t.charCodeAt(j) !== CH.sp && t.charCodeAt(j) !== CH.tab) return;
    while (t.charCodeAt(j) === CH.sp || t.charCodeAt(j) === CH.tab) j++;
    if (t.charCodeAt(j) !== CH.eq) this.rubyParams(at, j, LINE_END);
  }

  /** `->(a, b = 1)` and `-> a, b {` at `i`. */
  private rubyLambdaParams(i: number): void {
    const t = this.t;
    let j = i + 2;
    while (t.charCodeAt(j) === CH.sp || t.charCodeAt(j) === CH.tab) j++;
    if (t.charCodeAt(j) !== CH.lparen) {
      this.rubyParams(i, j, LAMBDA_BODY);
      return;
    }
    const far = this.rubyParams(i, j + 1, CH.rparen);
    if (far > this.lineEnd(i)) this.longReads.push(i, far);
  }

  /** The `|a, (b, c), *d|` after a `{` or `do` at `at`; `j` is just past it. */
  private rubyBlockParams(at: number, j: number): void {
    const t = this.t;
    while (t.charCodeAt(j) === CH.sp || t.charCodeAt(j) === CH.tab) j++;
    if (t.charCodeAt(j) === 124 && t.charCodeAt(j + 1) !== 124) this.rubyParams(at, j + 1, 124);
  }

  /**
   * Declares, at `at`, each parameter name of the list from `j` to `close` at depth 0: `)`, `|`,
   * `LINE_END` (the line end, `;` or a comment) or `LAMBDA_BODY` (that, a `{` or `do`). Destructuring
   * groups, sigils and block-locals after `;` count; default values do not. Only a `)` list reads past
   * its line. Returns the farthest offset read.
   */
  private rubyParams(at: number, j: number, close: number): number {
    const t = this.t;
    const limit = Math.min(this.n, j + 4096);
    let group = 0;
    let inValue = false;
    let vdepth = 0;
    let start = true;
    while (j < limit) {
      const c = t.charCodeAt(j);
      if (c === CH.lf || c === CH.cr) {
        if (close !== CH.rparen) return j;
        j++;
        continue;
      }
      if (c === CH.dq || c === CH.sq) {
        const q = t.indexOf(t[j], j + 1);
        const le = this.lineEnd(j);
        if (q < 0 || q > le) return le;
        j = q + 1;
        start = false;
        continue;
      }
      if (c === CH.hash) {
        if (close !== CH.rparen) return j;
        j = this.lineEnd(j);
        continue;
      }
      if (inValue) {
        if (c === CH.lparen || c === CH.lbrack || c === CH.lbrace) vdepth++;
        else if ((c === CH.rparen || c === CH.rbrack || c === CH.rbrace) && vdepth > 0) vdepth--;
        else if (vdepth === 0 && (c === CH.comma || c === CH.rparen || c === close || (close === LINE_END && c === CH.semi) || (close === LAMBDA_BODY && c === CH.lbrace))) inValue = false;
        if (inValue) {
          j++;
          continue;
        }
      }
      if (c === close && group === 0) return j;
      if (close <= LINE_END && (c === CH.semi || (close === LAMBDA_BODY && (c === CH.lbrace || (c === 100 && t.startsWith('do', j) && !isAsciiWord(t.charCodeAt(j + 2))))))) return j;
      const w = idStartWidth(t, j);
      if (w > 0 && c !== CH.dollar) {
        const end = scanIdent(t, j, false);
        if (start) {
          const k = t.charCodeAt(j);
          if ((k >= 97 && k <= 122) || k === 95 || k >= 128) this.declareLocal(at, t.slice(j, end));
        }
        start = false;
        j = end;
        continue;
      }
      switch (c) {
        case CH.sp:
        case CH.tab:
        case CH.star:
        case 38:
          break;
        case CH.lparen:
          if (start) group++;
          else {
            inValue = true;
            vdepth = 1;
          }
          break;
        case CH.rparen:
          if (group > 0) group--;
          start = false;
          break;
        case CH.comma:
        case CH.semi:
          start = true;
          break;
        case CH.eq:
        case CH.colon:
          inValue = true;
          vdepth = 0;
          start = false;
          break;
        default:
          start = false;
      }
      j++;
    }
    return j;
  }

  private pushIdent(start: number, end: number): number {
    this.idents.push({ name: this.t.slice(start, end), offset: start, length: end - start });
    this.exprStart = false;
    this.stmtStart = false;
    return end;
  }

  private atColumn0(i: number): boolean {
    return i === 0 || this.t.charCodeAt(i - 1) === CH.lf;
  }

  private blankOrEnd(j: number): boolean {
    const c = this.t.charCodeAt(j);
    return j >= this.n || c === CH.sp || c === CH.tab || c === CH.lf || c === CH.cr;
  }

  /** `=begin` … `=end`, both at column 0, through the end of the `=end` line. */
  private embdoc(i: number): number {
    const t = this.t;
    let ls = t.indexOf('\n', i);
    while (ls >= 0 && ls + 1 < this.n) {
      ls++;
      if (t.startsWith('=end', ls) && this.blankOrEnd(ls + 4)) {
        const end = this.lineEnd(ls);
        this.span(i, end, 'comment');
        return end;
      }
      ls = t.indexOf('\n', ls);
    }
    this.span(i, this.n, 'comment');
    return this.n;
  }

  /** `$name`, `$0`, `$12`, `$-w`, and the punctuation globals (`$!`, `$~`, `$"`): one identifier. */
  private rubyGlobal(i: number): number {
    const end = this.rubyGlobalEnd(i);
    return end < 0 ? -1 : this.pushIdent(i, end);
  }

  private rubyGlobalEnd(i: number): number {
    const t = this.t;
    const c = t.charCodeAt(i + 1);
    if (idStartWidth(t, i + 1) > 0 && c !== CH.dollar) return scanIdent(t, i + 1, false);
    if (c === CH.minus && isAsciiWord(t.charCodeAt(i + 2))) return i + 3;
    if (isDigit(c)) {
      let end = i + 2;
      while (isDigit(t.charCodeAt(end))) end++;
      return end;
    }
    return RUBY_SPECIAL_GLOBAL.has(t[i + 1] ?? '') ? i + 2 : -1;
  }

  /**
   * A blank before `i` and a method name before the blank: `split /,/`, `puts ?a`, `p %w[a]`, `call <<EOS`.
   * A local, a parameter, `@x`, `@@x` or `$x` there is an operand, as in Ruby's lexer: `width /2`, `n ?1 : 0`.
   */
  private commandArg(i: number): boolean {
    const t = this.t;
    let p = i - 1;
    if (p < 0 || (t.charCodeAt(p) !== CH.sp && t.charCodeAt(p) !== CH.tab)) return false;
    while (p >= 0 && (t.charCodeAt(p) === CH.sp || t.charCodeAt(p) === CH.tab)) p--;
    let c = t.charCodeAt(p);
    const suffixed = c === 63 || c === CH.bang;
    if (suffixed) c = t.charCodeAt(--p);
    if (!isAsciiWord(c)) return false;
    let q = p;
    while (q >= 0 && isAsciiWord(t.charCodeAt(q))) q--;
    if (isDigit(t.charCodeAt(q + 1)) || t.slice(q + 1, p + 1) === 'class') return false;
    const sigil = t.charCodeAt(q);
    if (sigil === 64 || sigil === CH.dollar) return false;
    return suffixed || this.locals === undefined || !this.isLocal(q + 1, p + 1);
  }

  /** `?a`, `?\n`, `?\C-a`: a character literal where an expression starts; `x ? a : b` stays the ternary. */
  private rubyChar(i: number): number {
    const t = this.t;
    const c = t.charCodeAt(i + 1);
    if (Number.isNaN(c) || c === CH.sp || c === CH.tab || c === CH.lf || c === CH.cr) return -1;
    if (!this.exprStart && !this.commandArg(i)) return -1;
    let end: number;
    if (c === CH.bslash) {
      const m = /^\\(?:u\{[0-9a-fA-F ]*\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,2}|[0-7]{1,3}|(?:[CM]-|c)(?:\\(?:[CM]-|c))*(?:\\.|.)|[\s\S])/u.exec(t.slice(i + 1, i + 32));
      if (!m) return -1;
      end = i + 1 + m[0].length;
    } else {
      end = i + 1 + (t.codePointAt(i + 1)! > 0xffff ? 2 : 1);
      if (idPartWidth(t, end) > 0 && idPartWidth(t, i + 1) > 0) return -1;
    }
    this.span(i, end, 'string');
    this.exprStart = false;
    this.stmtStart = false;
    return end;
  }

  /** `%(…)`, `%q[…]`, `%w{…}`, `%r!…!` and friends; `a % b` and `x %= 2` stay operators. */
  private rubyPercent(i: number): number {
    const t = this.t;
    let j = i + 1;
    let kind = '';
    if (/[qQwWiIsrx]/.test(t[j] ?? '') && !/[A-Za-z0-9_\s]/.test(t[j + 1] ?? ' ')) {
      kind = t[j];
      j++;
    }
    const d = t[j] ?? '';
    if (d === '' || /[A-Za-z0-9_\s]/.test(d)) return -1;
    if (!this.exprStart && (!this.commandArg(i) || d === '=')) return -1;
    const open = RUBY_PAIRS[d] !== undefined ? d : '';
    const close = RUBY_PAIRS[d] ?? d;
    const interp = kind === '' || kind === 'Q' || kind === 'W' || kind === 'I' || kind === 'r' || kind === 'x';
    return this.rubyDelimited(i, j + 1, close, open, interp, kind === 'r');
  }

  private rubyRegexStart(i: number): boolean {
    if (this.exprStart) return true;
    const c = this.t.charCodeAt(i + 1);
    return this.commandArg(i) && c !== CH.sp && c !== CH.tab && c !== CH.eq && c !== CH.lf && c !== CH.cr;
  }

  /**
   * A Ruby literal body from `bodyStart` to `close` (nested `open` / `close` pairs count),
   * multi-line, with escapes; `interp` adds `#{…}`, `#@x`, `#@@x` and `#$x` holes, `regex`
   * the trailing flags. The span starts at `start`.
   */
  private rubyDelimited(start: number, bodyStart: number, close: string, open: string, interp: boolean, regex = false): number {
    const t = this.t;
    const n = this.n;
    const cc = close.charCodeAt(0);
    const oc = open ? open.charCodeAt(0) : -1;
    let depth = 0;
    let seg = start;
    let j = bodyStart;
    while (j < n) {
      const c = t.charCodeAt(j);
      if (c === CH.bslash) {
        j += this.escapeWidth(j);
        continue;
      }
      if (c === oc) {
        depth++;
        j++;
        continue;
      }
      if (c === cc) {
        j++;
        if (depth-- > 0) continue;
        if (regex) while (j < n && /[a-z]/.test(t[j])) j++;
        // `"key": v` and `'key': v` are labels; the colon belongs to the literal
        if (start === bodyStart - 1 && (cc === CH.dq || cc === CH.sq) && t.charCodeAt(j) === CH.colon && t.charCodeAt(j + 1) !== CH.colon && this.labelPosition(start)) j++;
        this.span(seg, j, 'string');
        this.exprStart = false;
        this.stmtStart = false;
        return j;
      }
      if (interp && c === CH.hash && this.nest < MAX_NEST) {
        const d = t.charCodeAt(j + 1);
        if (d === CH.lbrace) {
          this.span(seg, j + 2, 'string');
          const end = this.hole(j + 2, Stop.Hole);
          if (end >= n) return n;
          seg = end;
          j = end + 1;
          continue;
        }
        if (d === 64 || d === CH.dollar) {
          const r = this.rubyEmbVar(j + 1);
          if (r > j + 1) {
            this.span(seg, j + 1, 'string');
            seg = r;
            j = r;
            continue;
          }
        }
      }
      j++;
    }
    this.span(seg, n, 'string');
    return n;
  }

  /** Where a hash key or keyword argument can start: after `{`, `(`, `,`, `|`, at the start of a line, or as a command argument (`foo "k": 1`). */
  private labelPosition(i: number): boolean {
    const t = this.t;
    let p = i - 1;
    while (p >= 0 && (t.charCodeAt(p) === CH.sp || t.charCodeAt(p) === CH.tab || t.charCodeAt(p) === CH.cr)) p--;
    const c = t.charCodeAt(p);
    return p < 0 || c === CH.lf || c === CH.lbrace || c === CH.lparen || c === CH.comma || c === 124 || this.commandArg(i);
  }

  /** `#@x`, `#@@x`, `#$x` in an interpolating literal: the name is a hole. Returns its end, or `at`. */
  private rubyEmbVar(at: number): number {
    const t = this.t;
    let end: number;
    if (t.charCodeAt(at) === CH.dollar) {
      end = this.rubyGlobalEnd(at);
      if (end < 0) return at;
    } else {
      const k = t.charCodeAt(at + 1) === 64 ? at + 2 : at + 1;
      if (idStartWidth(t, k) === 0 || t.charCodeAt(k) === CH.dollar) return at;
      end = scanIdent(t, k, false);
    }
    this.holes.push({ start: at, end });
    this.idents.push({ name: t.slice(at, end), offset: at, length: end - at });
    return end;
  }

  /** `:name`, `:name?`, `:name=`, `:@x`, `:$x`, `:+`, `:[]=`, `:"…"`: a string span. A colon after an operand is punctuation. */
  private rubySymbol(i: number): number {
    const t = this.t;
    const next = t.charCodeAt(i + 1);
    const p = t.charCodeAt(i - 1);
    if (next === CH.colon || p === CH.colon) return -1;
    if (isAsciiWord(p) || p === CH.rparen || p === CH.rbrack || p === CH.rbrace || p === CH.dq || p === CH.sq
        || p === 63 || p === CH.bang || (p >= 128 && idPartWidth(t, i - 1) > 0)) {
      return -1;
    }
    if (next === CH.dq) return this.rubyDelimited(i, i + 2, '"', '', true);
    if (next === CH.sq) return this.rubyDelimited(i, i + 2, "'", '', false);
    const at = i + 1;
    let end = -1;
    if (next === CH.dollar) {
      end = this.rubyGlobalEnd(at);
    } else if (next === 64) {
      const k = t.charCodeAt(at + 1) === 64 ? at + 2 : at + 1;
      if (idStartWidth(t, k) > 0 && t.charCodeAt(k) !== CH.dollar) end = scanIdent(t, k, false);
    } else if (idStartWidth(t, at) > 0) {
      end = scanIdent(t, at, false);
      const s = t.charCodeAt(end);
      if ((s === 63 || s === CH.bang) && t.charCodeAt(end + 1) !== CH.eq) end++;
      else if (s === CH.eq && !/[=~>]/.test(t[end + 1] ?? '')) end++;
    } else {
      for (const op of RUBY_OPERATOR_NAMES) {
        if (t.startsWith(op, at)) {
          end = at + op.length;
          break;
        }
      }
    }
    if (end < 0) return -1;
    this.span(i, end, 'string');
    this.exprStart = false;
    this.stmtStart = false;
    return end;
  }

  /** `<<~ID`, `<<-ID`, `<<ID`, quoted ids: the opener is a string span; the body is read at the line break. */
  private rubyHeredocOpen(i: number): number {
    const t = this.t;
    const m = /^<<([~-]?)(?:(["'`])((?:(?!\2)[^\n])+)\2|([A-Za-z_]\w*))/.exec(t.slice(i, i + 128));
    if (!m) return -1;
    if (m[1] === '' && m[2] === undefined && !this.exprStart && !this.commandArg(i)) return -1;
    this.heredocs.push({ id: m[2] !== undefined ? m[3] : m[4], indented: m[1] !== '', interp: m[2] !== "'" });
    const end = i + m[0].length;
    this.span(i, end, 'string');
    this.exprStart = false;
    this.stmtStart = false;
    return end;
  }

  /** The bodies of the heredocs opened on the line that ends just before `i`, in order. Returns the offset after the last terminator line. */
  private heredocBodies(i: number): number {
    const t = this.t;
    const n = this.n;
    const pending = this.heredocs;
    this.heredocs = [];
    for (const h of pending) {
      let seg = i;
      let ls = i;
      let closed = false;
      while (ls < n) {
        let le = t.indexOf('\n', ls);
        if (le < 0) le = n;
        const raw = t.slice(ls, le);
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if ((h.indented ? line.trimStart() : line) === h.id) {
          this.span(seg, le, 'string');
          i = le < n ? le + 1 : n;
          closed = true;
          break;
        }
        let j = ls;
        while (j < le) {
          const c = t.charCodeAt(j);
          if (h.interp && c === CH.bslash) {
            j += this.escapeWidth(j);
            continue;
          }
          if (h.interp && c === CH.hash && this.nest < MAX_NEST) {
            const d = t.charCodeAt(j + 1);
            if (d === CH.lbrace) {
              this.span(seg, j + 2, 'string');
              const end = this.hole(j + 2, Stop.Hole);
              if (end >= n) return n;
              seg = end;
              j = end + 1;
              if (end >= le) {
                le = t.indexOf('\n', end);
                if (le < 0) le = n;
              }
              continue;
            }
            if (d === 64 || d === CH.dollar) {
              const r = this.rubyEmbVar(j + 1);
              if (r > j + 1) {
                this.span(seg, j + 1, 'string');
                seg = r;
                j = r;
                continue;
              }
            }
          }
          j++;
        }
        ls = Math.max(j, le + 1);
      }
      if (!closed) {
        this.span(seg, n, 'string');
        return n;
      }
    }
    return i;
  }

  /** A Ruby identifier: `name?` / `name!` method names, `__END__` data, operator names after `def`. */
  private rubyIdentifier(i: number): number {
    const t = this.t;
    let end = scanIdent(t, i, false);
    if (end === i) return i + 1;
    const s = t.charCodeAt(end);
    const plain = !((s === 63 || s === CH.bang) && t.charCodeAt(end + 1) !== CH.eq);
    if (!plain) end++;
    const name = t.slice(i, end);
    if (name === '__END__' && this.nest === 0 && this.atColumn0(i) && (end >= this.n || this.newlineAt(end) > 0)) {
      this.pushIdent(i, end);
      const nl = t.indexOf('\n', end);
      if (nl >= 0 && nl + 1 < this.n) this.span(nl + 1, this.n, 'comment');
      return this.n;
    }
    const atStatement = this.stmtStart;
    this.pushIdent(i, end);
    const member = t.charCodeAt(i - 1) === CH.dot || (t.charCodeAt(i - 1) === CH.colon && t.charCodeAt(i - 2) === CH.colon);
    if (name === 'def' && !member && !(s === CH.colon && t.charCodeAt(end + 1) !== CH.colon)) {
      if (this.nest === 0) this.rubyOpenScope(i);
      this.rubyDefParams(i, end);
      const m = /^[ \t]+(?:[A-Za-z_]\w*\.)?[`%/]/.exec(t.slice(end, end + 48));
      if (m) return end + m[0].length;
    } else if (name === 'do' && !member) {
      this.rubyBlockParams(i, end);
    } else if (plain && !member) {
      const c0 = t.charCodeAt(i);
      if ((c0 >= 97 && c0 <= 122) || c0 === 95 || c0 >= 128) {
        if (this.assignmentAfter(end)) {
          if (!this.afterDef(i)) this.declareLocal(i, name);
        } else if (atStatement) {
          this.rubyMultipleAssignment(i, end);
        }
      }
    }
    this.exprStart = RUBY_EXPR_KEYWORDS.has(name) && t.charCodeAt(i - 1) !== CH.dot;
    return end;
  }

  /** Is the name at `i` the one a `def` names (`def x = 1`, `def x=(v)`)? */
  private afterDef(i: number): boolean {
    const t = this.t;
    let p = i - 1;
    while (p >= 0 && (t.charCodeAt(p) === CH.sp || t.charCodeAt(p) === CH.tab)) p--;
    return p >= 2 && t.startsWith('def', p - 2) && !isAsciiWord(t.charCodeAt(p - 3));
  }

  // ── strings ─────────────────────────────────────────────────────────────────

  /**
   * A quote char at `q`, possibly carrying a prefix that starts at `start`.
   * Returns the offset after the literal, or -1 when the quote is not a literal
   * opener in this language.
   */
  private quote(start: number, q: number): number {
    const t = this.t;
    const c = t.charCodeAt(q);
    let r: number;
    switch (this.fam) {
      case 'js':
        r = c === CH.bq ? this.template(start, q) : this.plain(start, q, false, true);
        break;
      case 'go':
        r = c === CH.bq ? this.raw(start, q, '`') : this.plain(start, q, false, true);
        break;
      case 'python':
        r = c === CH.bq ? -1 : this.pyString(start, q);
        break;
      case 'rust':
        r = c === CH.bq ? -1 : c === CH.sq ? this.rustQuote(start, q) : this.plain(start, q, true, true);
        break;
      case 'c':
        r = c === CH.bq ? -1 : this.plain(start, q, false, true);
        break;
      case 'java':
      case 'nested':
        if (c === CH.bq) r = -1;
        else if (c === CH.dq && this.triple(q)) r = this.tripleString(start, q, true);
        else r = this.plain(start, q, false, true);
        break;
      case 'kotlin':
        if (c === CH.bq) r = this.backtickIdent(q);
        else if (c === CH.dq) r = this.kotlinString(start, q);
        else r = this.plain(start, q, false, true);
        break;
      case 'hash':
        r = c === CH.bq ? -1 : this.plain(start, q, true, !(this.syn.shellHash && c === CH.sq));
        break;
      case 'lua':
        r = c === CH.bq ? -1 : this.luaShort(start, q);
        break;
      case 'zig':
        r = c === CH.bq ? -1 : this.plain(start, q, false, true);
        break;
      case 'ruby':
        r = c === CH.sq ? this.rubyDelimited(start, q + 1, "'", '', false) : this.rubyDelimited(start, q + 1, t[q], '', true);
        break;
      default:
        r = c === CH.bq ? this.template(start, q) : this.plain(start, q, false, true);
        break;
    }
    if (r >= 0) {
      this.exprStart = false;
      this.stmtStart = false;
    }
    return r;
  }

  private triple(q: number): boolean {
    const t = this.t;
    const c = t.charCodeAt(q);
    return t.charCodeAt(q + 1) === c && t.charCodeAt(q + 2) === c;
  }

  /** Width of a line break at `j` (`\n` or `\r\n`), else 0. */
  private newlineAt(j: number): number {
    const c = this.t.charCodeAt(j);
    if (c === CH.lf) return 1;
    if (c === CH.cr && this.t.charCodeAt(j + 1) === CH.lf) return 2;
    return 0;
  }

  /** Width of an escape at `j` (a backslash): the backslash plus the escaped char or line break. A Zig literal ends at its line break, escaped or not. */
  private escapeWidth(j: number): number {
    const nl = this.newlineAt(j + 1);
    if (nl > 0 && this.fam === 'zig') return 1;
    return 1 + (nl || 1);
  }

  /** A quoted literal closed by the same char. Single-line ones end, unterminated, at a line break. */
  private plain(start: number, q: number, multiline: boolean, escapes: boolean): number {
    const t = this.t;
    const n = this.n;
    const quote = t.charCodeAt(q);
    let j = q + 1;
    while (j < n) {
      const c = t.charCodeAt(j);
      if (escapes && c === CH.bslash) {
        j += this.escapeWidth(j);
        continue;
      }
      if (c === quote) {
        j++;
        this.span(start, j, 'string');
        return j;
      }
      if (!multiline && this.newlineAt(j) > 0) break;
      j++;
    }
    const end = Math.min(j, n);
    this.span(start, end, 'string');
    return end;
  }

  /** A literal with no escapes, closed by `closer` (Go raw strings, Rust raw strings). */
  private raw(start: number, bodyStart: number, closer: string, skipOpen = 1): number {
    const e = this.t.indexOf(closer, bodyStart + skipOpen);
    const end = e < 0 ? this.n : e + closer.length;
    this.span(start, end, 'string');
    return end;
  }

  /** `"""…"""` with escapes (Java text blocks, Swift/Scala/Dart multi-line strings). */
  private tripleString(start: number, q: number, escapes: boolean): number {
    const t = this.t;
    const n = this.n;
    let j = q + 3;
    while (j < n) {
      const c = t.charCodeAt(j);
      if (escapes && c === CH.bslash) {
        j += this.escapeWidth(j);
        continue;
      }
      if (c === CH.dq && this.triple(j)) {
        j += 3;
        this.span(start, j, 'string');
        return j;
      }
      j++;
    }
    this.span(start, n, 'string');
    return n;
  }

  /** JS template literal: multi-line, escapes, nested `${…}` holes. */
  private template(start: number, q: number): number {
    const t = this.t;
    const n = this.n;
    let seg = start;
    let j = q + 1;
    while (j < n) {
      const c = t.charCodeAt(j);
      if (c === CH.bslash) {
        j += this.escapeWidth(j);
        continue;
      }
      if (c === CH.bq) {
        this.span(seg, j + 1, 'string');
        return j + 1;
      }
      if (c === CH.dollar && t.charCodeAt(j + 1) === CH.lbrace && this.nest < MAX_NEST) {
        this.span(seg, j + 2, 'string');
        const end = this.hole(j + 2, Stop.Hole);
        if (end >= n) return n;
        seg = end;
        j = end + 1;
        continue;
      }
      j++;
    }
    this.span(seg, n, 'string');
    return n;
  }

  /** Lex a hole's code; returns the offset of the char that ended it. */
  private hole(start: number, stop: Stop): number {
    const k = this.openHole(start);
    const savedExpr = this.exprStart;
    const savedStmt = this.stmtStart;
    this.exprStart = true;
    this.nest++;
    const end = this.code(start, stop);
    this.nest--;
    this.holes[k].end = end;
    this.exprStart = savedExpr;
    this.stmtStart = savedStmt;
    return end;
  }

  /** Python string with an optional prefix; triple-quoted in statement position is a docstring. */
  private pyString(start: number, q: number): number {
    const t = this.t;
    const n = this.n;
    const prefix = t.slice(start, q);
    const interp = /[fFtT]/.test(prefix);
    const rawStr = /[rR]/.test(prefix);
    const quote = t.charCodeAt(q);
    const triple = this.triple(q);
    const region: LexSpan['region'] = triple && !interp && this.nest === 0 && this.stmtStart ? 'doc' : 'string';
    let seg = start;
    let j = q + (triple ? 3 : 1);
    while (j < n) {
      const c = t.charCodeAt(j);
      if (c === CH.bslash) {
        if (interp && !rawStr && t.charCodeAt(j + 1) === 78 /* N */ && t.charCodeAt(j + 2) === CH.lbrace) {
          const close = t.indexOf('}', j);
          j = close < 0 ? n : close + 1;
          continue;
        }
        j += this.escapeWidth(j);
        continue;
      }
      if (c === quote && (!triple || this.triple(j))) {
        j += triple ? 3 : 1;
        this.span(seg, j, region);
        return j;
      }
      if (!triple && this.newlineAt(j) > 0) break;
      if (interp && c === CH.lbrace) {
        if (t.charCodeAt(j + 1) === CH.lbrace) {
          j += 2;
          continue;
        }
        if (this.nest < MAX_NEST) {
          this.span(seg, j + 1, region);
          const r = this.fHole(j + 1, quote, triple);
          seg = r.seg;
          j = r.j;
          continue;
        }
      }
      j++;
    }
    const end = Math.min(j, n);
    this.span(seg, end, region);
    return end;
  }

  /**
   * An f-string replacement field from just after its `{`: expression, optional
   * `!conv`, optional `:spec` (which may nest fields). Returns where the string
   * body resumes (`seg`) and the scan position (`j`).
   */
  private fHole(i: number, quote: number, triple: boolean): { seg: number; j: number } {
    const t = this.t;
    const n = this.n;
    const k = this.hole(i, triple ? Stop.FHole : Stop.FHoleLine);
    if (k >= n) return { seg: n, j: n };
    let m = k;
    if (t.charCodeAt(m) === CH.bang) {
      m++;
      while (m < n && isAsciiWord(t.charCodeAt(m))) m++;
    }
    if (t.charCodeAt(m) !== CH.colon) {
      return t.charCodeAt(m) === CH.rbrace ? { seg: k, j: m + 1 } : { seg: k, j: m };
    }
    let seg = k;
    m++;
    while (m < n) {
      const c = t.charCodeAt(m);
      if (c === CH.lbrace) {
        this.span(seg, m + 1, 'string');
        const r = this.fHole(m + 1, quote, triple);
        seg = r.seg;
        m = r.j;
        continue;
      }
      if (c === CH.rbrace) return { seg, j: m + 1 };
      if (c === quote && (!triple || this.triple(m))) return { seg, j: m };
      if (!triple && this.newlineAt(m) > 0) return { seg, j: m };
      m++;
    }
    return { seg, j: n };
  }

  /** Rust `'`: a char literal (`'x'`, `'\''`, `'\u{1F600}'`, `b'x'`) or a lifetime / label. */
  private rustQuote(start: number, q: number): number {
    const t = this.t;
    const j = q + 1;
    const c = t.charCodeAt(j);
    if (c === CH.bslash) {
      let k = j + 1;
      const e = t.charCodeAt(k);
      if (e === 117 /* u */ && t.charCodeAt(k + 1) === CH.lbrace) {
        const close = t.indexOf('}', k);
        k = close < 0 ? this.n : close + 1;
      } else if (e === 120 /* x */) {
        k += 3;
      } else {
        k += 1;
      }
      if (t.charCodeAt(k) === CH.sq) {
        this.span(start, k + 1, 'string');
        return k + 1;
      }
      if (e === 117) this.longReads.push(start, k);
      return -1;
    }
    if (Number.isNaN(c) || this.newlineAt(j) > 0) return -1;
    const w = t.codePointAt(j)! > 0xffff ? 2 : 1;
    if (t.charCodeAt(j + w) === CH.sq) {
      this.span(start, j + w + 1, 'string');
      return j + w + 1;
    }
    if (start === q && idStartWidth(t, j) > 0) {
      this.stmtStart = false;
      return scanIdent(t, j);
    }
    return -1;
  }

  /** Kotlin `"…"` (single-line, escapes) or `"""…"""` (raw, multi-line); both interpolate `$x` and `${…}`. */
  private kotlinString(start: number, q: number): number {
    const t = this.t;
    const n = this.n;
    const isRaw = this.triple(q);
    let seg = start;
    let j = q + (isRaw ? 3 : 1);
    while (j < n) {
      const c = t.charCodeAt(j);
      if (!isRaw && c === CH.bslash) {
        j += this.escapeWidth(j);
        continue;
      }
      if (c === CH.dq) {
        if (!isRaw) {
          this.span(seg, j + 1, 'string');
          return j + 1;
        }
        let run = 0;
        while (t.charCodeAt(j + run) === CH.dq) run++;
        if (run >= 3) {
          this.span(seg, j + run, 'string');
          return j + run;
        }
        j += run;
        continue;
      }
      if (!isRaw && this.newlineAt(j) > 0) break;
      if (c === CH.dollar && this.nest < MAX_NEST) {
        if (t.charCodeAt(j + 1) === CH.lbrace) {
          this.span(seg, j + 2, 'string');
          const end = this.hole(j + 2, isRaw ? Stop.Hole : Stop.HoleLine);
          if (end >= n) return n;
          if (t.charCodeAt(end) !== CH.rbrace) {
            seg = end;
            j = end;
            continue;
          }
          seg = end;
          j = end + 1;
          continue;
        }
        if (idStartWidth(t, j + 1) > 0 && t.charCodeAt(j + 1) !== CH.dollar) {
          this.span(seg, j + 1, 'string');
          const end = scanIdent(t, j + 1, false);
          this.holes.push({ start: j + 1, end });
          this.idents.push({ name: t.slice(j + 1, end), offset: j + 1, length: end - j - 1 });
          seg = end;
          j = end;
          continue;
        }
      }
      j++;
    }
    const end = Math.min(j, n);
    this.span(seg, end, 'string');
    return end;
  }

  /** Kotlin `` `name with spaces` `` is an identifier. */
  private backtickIdent(q: number): number {
    const t = this.t;
    const close = t.indexOf('`', q + 1);
    const le = this.lineEnd(q);
    if (close < 0 || close > le) return -1;
    this.idents.push({ name: t.slice(q, close + 1), offset: q, length: close + 1 - q });
    return close + 1;
  }

  // ── identifiers, prefixes, numbers ──────────────────────────────────────────

  private identifier(i: number): number {
    if (this.fam === 'ruby') return this.rubyIdentifier(i);
    const t = this.t;
    const end = scanIdent(t, i);
    const q = t.charCodeAt(end);
    if (q === CH.dq || q === CH.sq || (q === CH.hash && this.fam === 'rust')) {
      const r = this.prefixed(i, end);
      if (r >= 0) {
        this.exprStart = false;
        this.stmtStart = false;
        return r;
      }
    }
    const name = t.slice(i, end);
    this.idents.push({ name, offset: i, length: end - i });
    this.exprStart = this.fam === 'js' && JS_EXPR_KEYWORDS.has(name) && t.charCodeAt(i - 1) !== CH.dot;
    this.stmtStart = false;
    return end;
  }

  /** A string/char prefix `t[i, end)` followed by a quote (or Rust `#`). Returns -1 if it is not one. */
  private prefixed(i: number, end: number): number {
    const t = this.t;
    const p = t.slice(i, end);
    const q = t.charCodeAt(end);
    switch (this.fam) {
      case 'python':
        if (q !== CH.hash && /^[rRbBuUfFtT]{1,2}$/.test(p)) return this.pyString(i, end);
        return -1;
      case 'rust': {
        if (p === 'r' && q === CH.hash && idStartWidth(t, end + 1) > 0) {
          const e = scanIdent(t, end + 1);
          this.idents.push({ name: t.slice(i, e), offset: i, length: e - i });
          this.exprStart = false;
          this.stmtStart = false;
          return e;
        }
        if (p === 'r' || p === 'br' || p === 'cr') {
          let h = end;
          while (t.charCodeAt(h) === CH.hash) h++;
          if (t.charCodeAt(h) !== CH.dq) return -1;
          return this.raw(i, h, '"' + '#'.repeat(h - end));
        }
        if ((p === 'b' || p === 'c') && q === CH.dq) return this.plain(i, end, true, true);
        if (p === 'b' && q === CH.sq) return this.rustQuote(i, end);
        return -1;
      }
      case 'c': {
        if (this.syn.cppRaw && q === CH.dq && /^(u8|u|U|L)?R$/.test(p)) {
          const m = /^[^()\\\s"]{0,16}\(/.exec(t.slice(end + 1, end + 18));
          if (m) {
            const delim = m[0].slice(0, -1);
            return this.raw(i, end, ')' + delim + '"', 1 + m[0].length);
          }
        }
        if (/^(u8|u|U|L)$/.test(p)) return this.plain(i, end, false, true);
        return -1;
      }
      default:
        return -1;
    }
  }

  /** Does the code before `i` end an operand (word char, `)`, `]`, `.`)? Then a `.` there is member access, not a float. */
  private operandBefore(i: number): boolean {
    const t = this.t;
    let p = i - 1;
    while (p >= 0 && (t.charCodeAt(p) === CH.sp || t.charCodeAt(p) === CH.tab)) p--;
    if (p < 0) return false;
    const c = t.charCodeAt(p);
    return isAsciiWord(c) || c === CH.rparen || c === CH.rbrack || c === CH.dot;
  }

  /**
   * A numeric literal, suffix included (`123u32`, `1.0f`, `10n`, `10L`, `2i`):
   * rust-analyzer reports the whole literal as one `number` token. Python only takes
   * a `j`/`l` suffix, so `1if x else 2` keeps its keyword. A digit run right after a
   * member dot (`pair.0`, `t.0.1`) is a tuple field, not a number.
   */
  private number(i: number): number {
    const t = this.t;
    const n = this.n;
    const start = i;
    const c0 = t.charCodeAt(i);
    if (c0 !== CH.dot && t.charCodeAt(i - 1) === CH.dot && t.charCodeAt(i - 2) !== CH.dot && this.operandBefore(i - 1)) {
      while (i < n && isDigit(t.charCodeAt(i))) i++;
      this.exprStart = false;
      this.stmtStart = false;
      return i;
    }
    const digitSep = this.fam === 'c';
    const sep = (j: number): boolean => digitSep && t.charCodeAt(j) === CH.sq && isAsciiWord(t.charCodeAt(j + 1));
    const radix = c0 === 48 ? (t[i + 1] ?? '').toLowerCase() : '';
    if (radix === 'x' || radix === 'b' || radix === 'o') {
      const digit = radix === 'x' ? /[0-9a-fA-F_]/ : /[0-9_]/;
      i += 2;
      while (i < n && (digit.test(t[i]) || sep(i))) i++;
      if (radix === 'x') {
        const m = /^(?:\.[0-9a-fA-F_]*)?[pP][+-]?[0-9]/.exec(t.slice(i, i + 64));
        if (m) {
          i += m[0].length;
          while (i < n && isDigit(t.charCodeAt(i))) i++;
        } else if (t.charCodeAt(i) === CH.dot && (this.fam === 'lua'
          ? t.charCodeAt(i + 1) !== CH.dot
          : this.fam === 'zig' && /[0-9a-fA-F]/.test(t[i + 1] ?? ''))) {
          i++;
          while (i < n && /[0-9a-fA-F]/.test(t[i])) i++;
        }
      }
    } else {
      let sawDot = c0 === CH.dot;
      i++;
      while (i < n) {
        const c = t.charCodeAt(i);
        if (isDigit(c) || c === 95 /* _ */ || sep(i)) {
          i++;
          continue;
        }
        if (c === CH.dot && !sawDot && (isDigit(t.charCodeAt(i + 1)) || (this.fam === 'lua' && t.charCodeAt(i + 1) !== CH.dot))) {
          sawDot = true;
          i++;
          continue;
        }
        if ((c === 101 || c === 69) /* e E */) {
          const k = t[i + 1] === '+' || t[i + 1] === '-' ? i + 2 : i + 1;
          if (isDigit(t.charCodeAt(k))) {
            i = k;
            continue;
          }
        }
        break;
      }
    }
    if (this.fam === 'python') {
      if (/[jJlL]/.test(t[i] ?? '') && !isAsciiWord(t.charCodeAt(i + 1))) i++;
    } else {
      while (i < n && isAsciiWord(t.charCodeAt(i))) i++;
    }
    this.numbers.push({ start, end: i });
    this.exprStart = false;
    this.stmtStart = false;
    return i;
  }

  // ── JS regex and JSX ────────────────────────────────────────────────────────

  private regex(i: number): number {
    const t = this.t;
    const n = this.n;
    let j = i + 1;
    let inClass = false;
    for (;;) {
      if (j >= n) return -1;
      const c = t.charCodeAt(j);
      if (c === CH.lf || c === CH.cr) return -1;
      if (c === CH.bslash) {
        j += 2;
        continue;
      }
      if (inClass) {
        if (c === CH.rbrack) inClass = false;
      } else if (c === CH.lbrack) {
        inClass = true;
      } else if (c === CH.slash) {
        j++;
        break;
      }
      j++;
    }
    while (j < n && /[A-Za-z]/.test(t[j])) j++;
    this.span(i, j, 'string');
    this.exprStart = false;
    return j;
  }

  private mark(): number[] {
    return [this.spans.length, this.holes.length, this.idents.length, this.numbers.length, this.punct.length];
  }

  private reset(m: number[]): void {
    this.spans.length = m[0];
    this.holes.length = m[1];
    this.idents.length = m[2];
    this.numbers.length = m[3];
    this.punct.length = m[4];
  }

  private tryJsx(i: number): number {
    if (this.nest >= MAX_NEST) return -1;
    const saved = this.mark();
    this.nest++;
    const end = this.jsxElement(i);
    this.nest--;
    if (end < 0) {
      this.reset(saved);
      return -1;
    }
    return end;
  }

  private tagName(j: number): number {
    const t = this.t;
    let seg = j;
    while (j < this.n) {
      const c = t.charCodeAt(j);
      if (c === CH.dot || c === CH.colon || c === CH.minus) {
        if (j > seg) this.idents.push({ name: t.slice(seg, j), offset: seg, length: j - seg });
        j++;
        seg = j;
        continue;
      }
      const w = idPartWidth(t, j);
      if (w === 0) break;
      j += w;
    }
    if (j > seg) this.idents.push({ name: t.slice(seg, j), offset: seg, length: j - seg });
    return j;
  }

  /** A JSX element at `<`. Returns its end, or -1 when it does not parse as one (the caller rolls back). */
  private jsxElement(i: number): number {
    const t = this.t;
    const n = this.n;
    let j = i + 1;
    if (t.charCodeAt(j) === CH.gt) return this.jsxChildren(j + 1);
    j = this.tagName(j);
    if (t.charCodeAt(j) === CH.comma || /^\s+extends\b/.test(t.slice(j, j + 12))) return -1;
    while (j < n) {
      const c = t.charCodeAt(j);
      if (c === CH.sp || c === CH.tab || c === CH.lf || c === CH.cr) {
        j++;
        continue;
      }
      if (c === CH.slash && t.charCodeAt(j + 1) === CH.gt) return j + 2;
      if (c === CH.gt) return this.jsxChildren(j + 1);
      if (c === CH.lbrace) {
        const k = this.jsxExpr(j);
        if (k < 0) return -1;
        j = k;
        continue;
      }
      if (c === CH.dq || c === CH.sq) {
        const close = t.indexOf(t[j], j + 1);
        if (close < 0) return -1;
        this.span(j, close + 1, 'string');
        j = close + 1;
        continue;
      }
      if (c === CH.slash && (t.charCodeAt(j + 1) === CH.slash || t.charCodeAt(j + 1) === CH.star)) {
        j = t.charCodeAt(j + 1) === CH.slash ? this.lineComment(j) : this.blockComment(j);
        continue;
      }
      if (c === CH.eq) {
        j++;
        continue;
      }
      const w = idStartWidth(t, j);
      if (w > 0) {
        j += w;
        while (j < n && (idPartWidth(t, j) > 0 || t.charCodeAt(j) === CH.minus || t.charCodeAt(j) === CH.colon)) j++;
        continue;
      }
      return -1;
    }
    return -1;
  }

  /** `{…}` inside JSX: the braces are code punctuation, the inside is code. */
  private jsxExpr(j: number): number {
    this.punct.push(j);
    const saved = this.exprStart;
    this.exprStart = true;
    const k = this.code(j + 1, Stop.JsxExpr);
    this.exprStart = saved;
    if (k >= this.n) return -1;
    this.punct.push(k);
    return k + 1;
  }

  private jsxText(a: number, b: number): void {
    if (/\S/.test(this.t.slice(a, b))) this.span(a, b, 'string');
  }

  private jsxChildren(j: number): number {
    const t = this.t;
    const n = this.n;
    let textStart = j;
    while (j < n) {
      const c = t.charCodeAt(j);
      if (c === CH.lt) {
        this.jsxText(textStart, j);
        if (t.charCodeAt(j + 1) === CH.slash) {
          const gt = t.indexOf('>', j);
          if (gt < 0) return -1;
          this.tagName(j + 2);
          return gt + 1;
        }
        const e = this.jsxElement(j);
        if (e < 0) return -1;
        j = e;
        textStart = j;
        continue;
      }
      if (c === CH.lbrace) {
        this.jsxText(textStart, j);
        const k = this.jsxExpr(j);
        if (k < 0) return -1;
        j = k;
        textStart = j;
        continue;
      }
      j++;
    }
    return -1;
  }
}

// ── result ────────────────────────────────────────────────────────────────────

function lowerBound<T>(arr: T[], key: number, get: (x: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (get(arr[mid]) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const spanStart = (s: LexSpan): number => s.start;
const idOffset = (x: LexId): number => x.offset;
const rangeStart = (r: LexRange): number => r.start;
const self = (x: number): number => x;

class Lexed implements LexResult {
  constructor(
    readonly syntax: LangSyntax,
    readonly text: string,
    readonly lineStarts: number[],
    readonly spans: LexSpan[],
    readonly holes: LexRange[],
    readonly idents: LexId[],
    readonly numbers: LexRange[],
    readonly punct: number[],
    readonly cpOff: number[] = [],
    readonly cpState: number[] = [],
    readonly longReads: number[] = [],
    readonly localOffsets: number[] = [],
    readonly localNames: string[] = [],
    readonly defStarts: number[] = [],
  ) {}

  spanAt(offset: number): LexSpan | undefined {
    const k = lowerBound(this.spans, offset + 1, spanStart) - 1;
    if (k < 0) return undefined;
    const s = this.spans[k];
    return offset < s.end ? s : undefined;
  }

  isCode(offset: number): boolean {
    return this.spanAt(offset) === undefined;
  }

  regionAt(offset: number): Region {
    return this.spanAt(offset)?.region ?? 'code';
  }

  spanIndexFrom(offset: number): number {
    return lowerBound(this.spans, offset, spanStart);
  }

  identsIn(start: number, end: number): LexId[] {
    return this.idents.slice(lowerBound(this.idents, start, idOffset), lowerBound(this.idents, end, idOffset));
  }

  numbersIn(start: number, end: number): LexRange[] {
    return this.numbers
      .slice(lowerBound(this.numbers, start, rangeStart), lowerBound(this.numbers, end, rangeStart))
      .map((r) => ({ start: r.start, end: r.end }));
  }

  punctFrom(offset: number): number {
    return lowerBound(this.punct, offset, self);
  }

  private holeIndex: IntervalIndex | undefined;

  holeEndAt(offset: number): number {
    // The innermost hole is the latest-starting one that contains the offset.
    this.holeIndex ??= buildIntervalIndex(
      this.holes.map((h) => h.start),
      this.holes.map((h) => h.end),
      (a, b) => b - a,
    );
    const k = bestAt(this.holeIndex, offset);
    return k < 0 ? this.text.length : this.holes[k].end;
  }

  prevSignificant(offset: number): number {
    const t = this.text;
    let p = offset - 1;
    for (;;) {
      while (p >= 0 && (t[p] === ' ' || t[p] === '\t' || t[p] === '\n' || t[p] === '\r')) p--;
      if (p < 0) return -1;
      const s = this.spanAt(p);
      if (s === undefined || s.region === 'string') return p;
      p = s.start - 1;
    }
  }

  private openerAfter: Int32Array | undefined;

  enclosingOpen(offset: number): number {
    const k = lowerBound(this.punct, offset, self) - 1;
    if (k < 0) return -1;
    if (!this.openerAfter) {
      const after = new Int32Array(this.punct.length);
      const stack: number[] = [];
      for (let j = 0; j < this.punct.length; j++) {
        const p = this.punct[j];
        const c = this.text.charCodeAt(p);
        if (c === CH.lparen || c === CH.lbrack || c === CH.lbrace) stack.push(p);
        else if ((c === CH.rparen || c === CH.rbrack || c === CH.rbrace) && stack.length > 0) stack.pop();
        after[j] = stack.length > 0 ? stack[stack.length - 1] : -1;
      }
      this.openerAfter = after;
    }
    return this.openerAfter[k];
  }

  lineOf(offset: number): number {
    return Math.max(0, lowerBound(this.lineStarts, offset + 1, self) - 1);
  }
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** Lex `text` as `languageId`. Pure; prefer `lexFor`, which memoises. */
export function lex(text: string, languageId?: string): LexResult {
  const syntax = syntaxFor(languageId);
  const lx = new Lexer(text, syntax);
  lx.run();
  return new Lexed(syntax, text, lineStartsOf(text), lx.spans, lx.holes, lx.idents, lx.numbers, lx.punct, lx.cpOff, lx.cpState, lx.longReads,
    lx.localOffsets, lx.localNames, lx.defStarts);
}

/**
 * The lex of `text`, which is `prev.text` with [start, oldEnd) replaced by the
 * text now at [start, newEnd): re-lexed from a top-level line start before the
 * edit until the lexer reaches a line start after it in the state the previous
 * lex had there, and the previous lex shifted from that point on. Identical to
 * `lex(text, ...)`, or null: see docs/lexer.md#incremental-re-lex.
 */
export function relex(prev: LexResult, text: string, start: number, oldEnd: number, newEnd: number): LexResult | null {
  if (!(prev instanceof Lexed) || prev.syntax.jsx) return null;
  const delta = newEnd - oldEnd;
  if (text.length !== prev.text.length + delta || start < 0 || oldEnd < start || newEnd < start) return null;
  const po = prev.cpOff;
  const ps = prev.cpState;
  const pr = prev.longReads;
  // One line start before the edited line's, and before any decision that read up to the edit.
  let k = lowerBound(po, start + 1, self) - 2;
  for (let q = 0; q < pr.length; q += 2) {
    if (pr[q + 1] >= start) k = Math.min(k, lowerBound(po, pr[q] + 1, self) - 2);
  }
  // Inside a Ruby `def` the table is the def's own, rebuilt from the line of the `def` that opened it.
  const ds = prev.defStarts;
  while (k >= 0 && ps[3 * k] >> 2 > 0) {
    const d = lowerBound(ds, po[k], self) - 1;
    k = d < 0 ? -1 : lowerBound(po, ds[d] + 1, self) - 1;
  }
  if (k < 0) return null;
  const c = po[k];
  const L = new Lexer(text, prev.syntax);
  L.exprStart = (ps[3 * k] & 1) !== 0;
  L.stmtStart = (ps[3 * k] & 2) !== 0;
  // The table outside every `def` at `c`, and the names the previous lex added to it after `c`, up to the stop.
  const lo = prev.localOffsets;
  const ln = prev.localNames;
  const lk = lowerBound(lo, c, self);
  if (L.locals !== undefined) for (let q = 0; q < lk; q++) L.locals.add(ln[q]);
  const prevAdded = new Set<string>();
  let lj = lk;
  let j = lowerBound(po, newEnd + 1 - delta, self);
  L.stopAt = (i, idx) => {
    if (i < newEnd + 1) return false;
    const o = i - delta;
    while (j < po.length && po[j] < o) j++;
    if (j >= po.length || po[j] !== o) return false;
    if (L.cpState[3 * idx] !== ps[3 * j] || L.cpState[3 * idx + 1] !== ps[3 * j + 1] || L.cpState[3 * idx + 2] !== ps[3 * j + 2]) return false;
    if (L.locals === undefined) return true;
    if (L.cpState[3 * idx] >> 2 > 0) return false;
    while (lj < lo.length && lo[lj] < o) prevAdded.add(ln[lj++]);
    return L.localNames.length === prevAdded.size && L.localNames.every((x) => prevAdded.has(x));
  };
  L.code(c, Stop.Eof, ps[3 * k + 1], ps[3 * k + 2]);
  const r = L.stoppedAt;
  const ro = r - delta;
  const spans = prev.spans.slice(0, lowerBound(prev.spans, c, spanStart)).concat(L.spans);
  const holes = prev.holes.slice(0, lowerBound(prev.holes, c, rangeStart)).concat(L.holes);
  const head = prev.idents.slice(0, lowerBound(prev.idents, c, idOffset));
  for (let q = 0; q < head.length; q++) {
    const x = head[q];
    // V8 copies a slice under 13 characters and points a longer one into the text
    // it was cut from, so a kept name would keep an older version's text alive.
    if (x.length >= 13) head[q] = { name: text.slice(x.offset, x.offset + x.length), offset: x.offset, length: x.length };
  }
  const idents = head.concat(L.idents);
  const numbers = prev.numbers.slice(0, lowerBound(prev.numbers, c, rangeStart)).concat(L.numbers);
  const punct = prev.punct.slice(0, lowerBound(prev.punct, c, self)).concat(L.punct);
  const cpOff = po.slice(0, k + 1).concat(L.cpOff);
  const cpState = ps.slice(0, 3 * (k + 1)).concat(L.cpState);
  const longReads: number[] = [];
  for (let q = 0; q < pr.length && pr[q] < c; q += 2) longReads.push(pr[q], pr[q + 1]);
  longReads.push(...L.longReads);
  const localOffsets = lo.slice(0, lk).concat(L.localOffsets);
  const localNames = ln.slice(0, lk).concat(L.localNames);
  const defStarts = ds.slice(0, lowerBound(ds, c, self)).concat(L.defStarts);
  if (r >= 0) {
    cpOff.pop();
    cpState.length -= 3;
    for (let q = lowerBound(prev.spans, ro, spanStart); q < prev.spans.length; q++) {
      const x = prev.spans[q];
      spans.push({ start: x.start + delta, end: x.end + delta, region: x.region });
    }
    for (let q = lowerBound(prev.holes, ro, rangeStart); q < prev.holes.length; q++) {
      const x = prev.holes[q];
      holes.push({ start: x.start + delta, end: x.end + delta });
    }
    for (let q = lowerBound(prev.idents, ro, idOffset); q < prev.idents.length; q++) {
      const x = prev.idents[q];
      const o = x.offset + delta;
      // Sliced from the new text, so no name keeps the old text alive.
      idents.push({ name: text.slice(o, o + x.length), offset: o, length: x.length });
    }
    for (let q = lowerBound(prev.numbers, ro, rangeStart); q < prev.numbers.length; q++) {
      const x = prev.numbers[q];
      numbers.push({ start: x.start + delta, end: x.end + delta });
    }
    for (let q = lowerBound(prev.punct, ro, self); q < prev.punct.length; q++) punct.push(prev.punct[q] + delta);
    for (let q = j; q < po.length; q++) {
      cpOff.push(po[q] + delta);
      cpState.push(ps[3 * q], ps[3 * q + 1], ps[3 * q + 2]);
    }
    for (let q = 0; q < pr.length; q += 2) {
      if (pr[q] >= ro) longReads.push(pr[q] + delta, pr[q + 1] + delta);
    }
    for (let q = lowerBound(lo, ro, self); q < lo.length; q++) {
      localOffsets.push(lo[q] + delta);
      localNames.push(ln[q]);
    }
    for (let q = lowerBound(ds, ro, self); q < ds.length; q++) defStarts.push(ds[q] + delta);
  }
  return new Lexed(prev.syntax, text, lineStartsOf(text), spans, holes, idents, numbers, punct, cpOff, cpState, longReads, localOffsets, localNames,
    defStarts);
}

/** Make `lexFor(text, …)` answer `result`, a lex of exactly that text. */
export function rememberLex(text: string, result: LexResult): void {
  memo.push({ key: result.syntax.key, text, result });
  if (memo.length > MEMO_SIZE) memo.shift();
}

const MEMO_SIZE = 4;
const memo: { key: string; text: string; result: LexResult }[] = [];

/** Drop the memoised lexes of `text`, a document version nothing will ask about again. */
export function forgetLex(text: string): void {
  for (let k = memo.length - 1; k >= 0; k--) {
    if (memo[k].text === text) memo.splice(k, 1);
  }
}

/**
 * `lex`, memoised on (text, syntax). Every scanner calls this with the same
 * document string, so one document version is lexed once however many
 * consumers ask.
 */
export function lexFor(text: string, languageId?: string): LexResult {
  const key = syntaxFor(languageId).key;
  for (let k = memo.length - 1; k >= 0; k--) {
    const e = memo[k];
    if (e.key === key && e.text === text) {
      // Equal text can be another string (a reopened file): keep the caller's, so its
      // next lookups compare pointers instead of every character.
      e.text = text;
      if (k !== memo.length - 1) {
        memo.splice(k, 1);
        memo.push(e);
      }
      return e.result;
    }
  }
  const result = lex(text, languageId);
  memo.push({ key, text, result });
  if (memo.length > MEMO_SIZE) memo.shift();
  return result;
}

/** A `name!` followed by an opening bracket, as `/(?<![.\w])([A-Za-z_]\w*)!\s*([([{])/g` finds it. */
export interface BangCall {
  index: number;
  name: string;
  open: number;
}

const isAsciiWordCode = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

/** The code units JS `\s` matches. */
function isJsSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/**
 * Every match of `/(?<![.\w])([A-Za-z_]\w*)!\s*([([{])/g` in `text`, in order,
 * found from the `!` instead of trying the pattern at every offset. Matches never
 * overlap, so a caller that resumes past a match skips the ones that start before.
 */
export function bangCalls(text: string): BangCall[] {
  const out: BangCall[] = [];
  for (let p = text.indexOf('!'); p >= 0; p = text.indexOf('!', p + 1)) {
    let q = p;
    while (q > 0 && isAsciiWordCode(text.charCodeAt(q - 1))) q--;
    if (q === p) continue;
    const c0 = text.charCodeAt(q);
    if (c0 >= 48 && c0 <= 57) continue;
    if (q > 0 && text.charCodeAt(q - 1) === 46) continue;
    let o = p + 1;
    while (o < text.length && isJsSpace(text.charCodeAt(o))) o++;
    const b = text.charCodeAt(o);
    if (b === 40 || b === 91 || b === 123) out.push({ index: q, name: text.slice(q, p), open: o });
  }
  return out;
}

/** Every match of `/#!?\[\s*(error)\s*(\()/g` in `text`, in order; `open` is the `(`. */
export function errorAttributes(text: string): { index: number; open: number }[] {
  const out: { index: number; open: number }[] = [];
  for (let h = text.indexOf('#'); h >= 0; h = text.indexOf('#', h + 1)) {
    let i = h + 1;
    if (text.charCodeAt(i) === 33) i++;
    if (text.charCodeAt(i) !== 91) continue;
    i++;
    while (i < text.length && isJsSpace(text.charCodeAt(i))) i++;
    if (!text.startsWith('error', i)) continue;
    i += 5;
    while (i < text.length && isJsSpace(text.charCodeAt(i))) i++;
    if (text.charCodeAt(i) === 40) out.push({ index: h, open: i });
  }
  return out;
}

const isBlankCode = (c: number): boolean => c === 32 || c === 9;

/** `/^[ \t]+$/.test(t.slice(a, b))`, without the slice. */
export function blankGap(t: string, a: number, b: number): boolean {
  if (a < 0 || b < 0) return /^[ \t]+$/.test(t.slice(a, b));
  if (b > t.length) b = t.length;
  if (b <= a) return false;
  for (let i = a; i < b; i++) if (!isBlankCode(t.charCodeAt(i))) return false;
  return true;
}

/** `/^\s*,\s*$/` (or `/^[ \t]*,[ \t]*$/` when `blanksOnly`) tested on `t.slice(a, b)`, without the slice. */
export function commaGap(t: string, a: number, b: number, blanksOnly = false): boolean {
  if (a < 0 || b < 0) return (blanksOnly ? /^[ \t]*,[ \t]*$/ : /^\s*,\s*$/).test(t.slice(a, b));
  if (b > t.length) b = t.length;
  const ws = blanksOnly ? isBlankCode : isJsSpace;
  let i = a;
  while (i < b && ws(t.charCodeAt(i))) i++;
  if (i >= b || t.charCodeAt(i) !== 44) return false;
  i++;
  while (i < b && ws(t.charCodeAt(i))) i++;
  return i === b;
}

/** `s.trim() === '' || s.trimStart().startsWith('#')`, without allocating. */
export function blankOrHashLine(s: string): boolean {
  let i = 0;
  while (i < s.length && isJsSpace(s.charCodeAt(i))) i++;
  return i === s.length || s.charCodeAt(i) === 35;
}
