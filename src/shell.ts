/**
 * Shell (`shellscript`: bash, zsh, POSIX sh) and fish over the shared lexer's
 * result shape: regions, variable names as the identifiers, numbers where the
 * grammar paints a numeral, and the command structure the block scan, the
 * bindings and the danger marks read. Rules and measurements: docs/tooling.md.
 */

import type { LangSyntax, LexId, LexRange, LexResult, LexSpan } from './lex';
import { lexResultOf } from './lex';
import { BraceBlock, functionScopeOf, scanFishBlocks, scanShellBlocks } from './focus';
import { IntervalIndex, bestAt, buildIntervalIndex } from './intervals';

/** A variable occurrence: the name, never its `$`. */
export interface ShellVar {
  name: string;
  offset: number;
  length: number;
  /** Assignment, declaration operand, loop variable, or a target of `read`, `mapfile`, `getopts`, `printf -v`. */
  write: boolean;
  /** The command whose operand it is (`local`, `declare`, `export`, `read`, `for`, `set`, `function` …); '' for an assignment or a read. */
  via: string;
  /** The scope option on that command: `declare -g`, fish `set -g` / `-U` (g), `set -l` (l), `set -f` (f). */
  scope: '' | 'g' | 'l' | 'f';
  /** A prefix assignment (`LC_ALL=C sort`): set for the one command only. */
  env?: boolean;
}

/** A simple command: its name word and its first arguments, '' for a word that is not literal text. */
export interface ShellCommand {
  name: string;
  offset: number;
  /** After `|` or `|&`. */
  piped: boolean;
  args: string[];
  /** Where each of `args` starts. */
  argAt: number[];
}

export type ShellMarkKind =
  | 'if' | 'then' | 'elif' | 'else' | 'fi' | 'for' | 'select' | 'while' | 'until' | 'repeat' | 'do' | 'done'
  | 'case' | 'in' | 'esac' | 'pattern' | 'arm' | 'armEnd' | '{' | '}' | '(' | ')' | 'fn' | 'foreach' | 'end'
  | 'function' | 'switch' | 'begin' | 'body';

/** A reserved word or delimiter the block scan reads, in document order. */
export interface ShellMark {
  kind: ShellMarkKind;
  offset: number;
  end: number;
}

export interface ShellTables {
  vars: ShellVar[];
  commands: ShellCommand[];
  marks: ShellMark[];
}

const tables = new WeakMap<LexResult, ShellTables>();
const NO_TABLES: ShellTables = { vars: [], commands: [], marks: [] };

/** The command structure of a shell or fish lex. */
export function shellTables(lx: LexResult): ShellTables {
  return tables.get(lx) ?? NO_TABLES;
}

const isNameStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isNamePart = (c: number): boolean => isNameStart(c) || (c >= 48 && c <= 57);
const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isBlank = (c: number): boolean => c === 32 || c === 9 || c === 13;
/** `$@ $* $# $? $- $$ $!`: the special parameters. */
const isSpecial = (c: number): boolean => c === 64 || c === 42 || c === 35 || c === 63 || c === 45 || c === 36 || c === 33;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMERAL = /^(?:0[xX][0-9a-fA-F]+|[0-9]+#[0-9A-Za-z@_]+|[0-9]+(?:\.[0-9]+)?)$/;

/** bash's metacharacters, and the end of a word. */
function isMeta(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 59 || c === 38 || c === 124 || c === 60 || c === 62 || c === 40 || c === 41
    || Number.isNaN(c);
}

const SH_RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'select', 'while', 'until', 'do', 'done', 'case', 'esac',
  'function', '{', '}', '!', 'time', '[[', 'coproc', 'repeat', 'foreach']);
/** Builtins whose operands declare variables. */
const SH_DECL = new Set(['local', 'declare', 'typeset', 'integer', 'float', 'readonly', 'export']);
/** Options of `read` and `mapfile` that take a value. */
const READ_VALUE_OPTS = new Set(['d', 'i', 'n', 'N', 'p', 't', 'u', 'k']);
const MAPFILE_VALUE_OPTS = new Set(['d', 'n', 'O', 's', 'u', 'C', 'c']);

/**
 * VS Code opens a `.zsh` file as `shellscript` too. A zsh shebang, a zsh-only
 * builtin at a line start, `${(flags)…}`, a `[(r)…]` subscript flag, a `:h` /
 * `:gs/…/` modifier or `$+name` makes the text zsh, whose `$#name`, flags and
 * modifiers the lexer then reads as zsh's.
 */
function zshFlavour(t: string): boolean {
  const first = t.slice(0, t.indexOf('\n') >>> 0);
  if (first.startsWith('#!') && /\bzsh\b/.test(first)) return true;
  return ZSH_SYNTAX.test(t);
}
/** zsh's own associative arrays: `${+commands[git]}` looks a key up. */
const ZSH_ASSOC = ['commands', 'functions', 'aliases', 'galiases', 'saliases', 'builtins', 'parameters', 'options', 'widgets', 'modules',
  'nameddirs', 'userdirs', 'history', 'historywords', 'jobstates', 'jobtexts', 'jobdirs', 'terminfo', 'termcap', 'fg', 'bg', 'fg_bold',
  'bg_bold', 'fg_no_bold', 'bg_no_bold', 'color', 'colour', 'reswords', 'dis_aliases', 'dis_functions', 'dis_builtins', 'keymaps',
  'mapfile', 'sysparams', 'errnos', 'zsh_scheduled_events'];
const ZSH_SYNTAX = /(?:^|\n)[ \t]*(?:setopt|unsetopt|autoload|zstyle|zmodload|compdef|bindkey|emulate|zle|zparseopts|typeset -g[A-Za-z]*)\b|\$\{\(|\$\{?\+[A-Za-z_]|\$\{(?:[A-Za-z_][A-Za-z0-9_]*|\d+)(?:\[[^\]\n]*\])?:(?:[htreAaPQqlu]\d*[:}]|g?s\/)|\[\([A-Za-z]+\)/;

const enum Term { Eof, Paren, Backtick }
const enum Arith { Parens, Bracket, Offset, Word }
type CaseState = 'subject' | 'in' | 'pattern' | 'arm';

interface Heredoc {
  word: string;
  strip: boolean;
  quoted: boolean;
}

/** Per simple command. */
interface Cmd {
  atCmd: boolean;
  cmd: ShellCommand | null;
  /** The declaring or reading builtin whose operands follow. */
  mode: string;
  scope: '' | 'g' | 'l' | 'f';
  /** `declare -f`, `unset -f`: the operands name functions. */
  functions: boolean;
  /** The next word is an option's value. */
  skip: boolean;
  /** `printf -v`, `read -a`: the next word is a variable. */
  nextVar: boolean;
  /** `declare -A`, `typeset -A`: the operands are associative arrays. */
  assocDecl: boolean;
  /** `for`, `select`, `foreach`: reading the loop's names. */
  names: boolean;
  /** `repeat N`: the count, then `do`. */
  repeat: boolean;
  /** After `function`: the next word names it. */
  fnName: boolean;
  piped: boolean;
  redirect: boolean;
  /** Operands seen: a loop's names, `getopts`'s. */
  operands: number;
  /** This command's assignments, prefix assignments once a name follows. */
  assigns: ShellVar[];
}

function freshCmd(): Cmd {
  return { atCmd: true, cmd: null, mode: '', scope: '', functions: false, skip: false, nextVar: false, assocDecl: false, names: false, repeat: false,
    fnName: false, piped: false, redirect: false, operands: 0, assigns: [] };
}

class ShLexer {
  readonly n: number;
  readonly spans: LexSpan[] = [];
  readonly holes: LexRange[] = [];
  readonly numbers: LexRange[] = [];
  readonly punct: number[] = [];
  readonly vars: ShellVar[] = [];
  readonly commands: ShellCommand[] = [];
  readonly marks: ShellMark[] = [];
  private readonly pending: Heredoc[] = [];
  private readonly zsh: boolean;
  /** Names declared associative (`declare -A`): a subscript is a key, not arithmetic. */
  private readonly assoc = new Set<string>();
  /** Open `foreach` loops, which `end` closes. */
  private foreachDepth = 0;
  /** Depth of `"…"` and heredoc bodies around the scan: an expansion there is quoted. */
  private quoted = 0;
  /** Per command list being read, its open `{` groups: zsh closes one with a `}` anywhere a word may stand. */
  private readonly braces: number[] = [];
  /** Inside `` `…` ``: an unescaped backtick closes it wherever it stands, a quote's inside included. */
  private backticks = 0;

  constructor(readonly t: string) {
    this.n = t.length;
    this.zsh = zshFlavour(t);
    if (this.zsh) for (const name of ZSH_ASSOC) this.assoc.add(name);
  }

  run(): void {
    this.list(0, Term.Eof);
  }

  private span(start: number, end: number, region: LexSpan['region']): void {
    if (end > start) this.spans.push({ start, end, region });
  }

  private mark(kind: ShellMarkKind, offset: number, end: number): void {
    this.marks.push({ kind, offset, end });
  }

  private addVar(start: number, end: number, write: boolean, via = '', scope: ShellVar['scope'] = ''): ShellVar {
    const v: ShellVar = { name: this.t.slice(start, end), offset: start, length: end - start, write, via, scope };
    this.vars.push(v);
    return v;
  }

  /** An expansion inside `"…"` or a heredoc body is a hole: code inside a string. */
  private expansion(start: number, end: number): void {
    if (this.quoted > 0) this.holes.push({ start, end });
  }

  private nameEnd(i: number): number {
    const t = this.t;
    if (!isNameStart(t.charCodeAt(i))) return i;
    i++;
    while (i < this.n && isNamePart(t.charCodeAt(i))) i++;
    return i;
  }

  private lineEnd(i: number): number {
    const nl = this.t.indexOf('\n', i);
    return nl < 0 ? this.n : nl;
  }

  /** A `#` that starts a word starts a comment. */
  private wordStart(i: number): boolean {
    if (i === 0) return true;
    const p = this.t.charCodeAt(i - 1);
    return isBlank(p) || p === 10 || p === 59 || p === 38 || p === 124 || p === 40 || p === 41;
  }

  // ── command lists ──────────────────────────────────────────────────────────

  /** A command list from `j` to its terminator; returns the offset after it. */
  private list(j: number, term: Term): number {
    this.braces.push(0);
    const e = this.listBody(j, term);
    this.braces.pop();
    return e;
  }

  private listBody(j: number, term: Term): number {
    const t = this.t;
    const n = this.n;
    let st = freshCmd();
    const cases: CaseState[] = [];
    const top = (): CaseState | undefined => cases[cases.length - 1];
    const reset = (): void => {
      st = freshCmd();
    };
    while (j < n) {
      const c = t.charCodeAt(j);
      if (term === Term.Paren && c === 41 && top() !== 'pattern') return j + 1;
      if (term === Term.Backtick && c === 96) return j + 1;
      if (c === 92 /* \ */ && t.charCodeAt(j + 1) === 10) {
        j += 2;
        continue;
      }
      if (c === 10) {
        j++;
        if (this.pending.length > 0) j = this.heredocs(j);
        const piped = st.piped && st.cmd === null && st.atCmd;
        const subject = top() === 'subject' || top() === 'in';
        if (!subject) {
          reset();
          st.piped = piped;
        }
        continue;
      }
      if (isBlank(c)) {
        j++;
        continue;
      }
      if (c === 35 /* # */ && this.wordStart(j)) {
        const e = this.lineEnd(j);
        this.span(j, e, 'comment');
        j = e;
        continue;
      }
      if (c === 59 /* ; */) {
        const c1 = t.charCodeAt(j + 1);
        if (c1 === 59 || c1 === 38) {
          const len = c1 === 59 && t.charCodeAt(j + 2) === 38 ? 3 : 2;
          if (top() === 'arm') {
            cases[cases.length - 1] = 'pattern';
            this.mark('armEnd', j, j + len);
          }
          j += len;
          reset();
          continue;
        }
        j++;
        reset();
        continue;
      }
      if (c === 38 /* & */) {
        const c1 = t.charCodeAt(j + 1);
        if (c1 === 62) {
          j += t.charCodeAt(j + 2) === 62 ? 3 : 2;
          st.redirect = true;
          continue;
        }
        j += c1 === 38 ? 2 : 1;
        reset();
        continue;
      }
      if (c === 124 /* | */) {
        if (top() === 'pattern') {
          j++;
          continue;
        }
        const c1 = t.charCodeAt(j + 1);
        if (c1 === 124) {
          j += 2;
          reset();
          continue;
        }
        j += c1 === 38 ? 2 : 1;
        reset();
        st.piped = true;
        continue;
      }
      if ((c === 60 || c === 62) && t.charCodeAt(j + 1) !== 40) {
        if (c === 60 && t.charCodeAt(j + 1) === 60 && t.charCodeAt(j + 2) !== 60) {
          j = this.heredocOperator(j);
          continue;
        }
        j++;
        while (j < n) {
          const d = t.charCodeAt(j);
          if (d === 60 || d === 62 || d === 38 || d === 124) j++;
          else break;
        }
        // `>&2`, `<&-`: the descriptor is the target.
        st.redirect = true;
        continue;
      }
      if (c === 40 /* ( */) {
        if (top() === 'pattern') {
          j++;
          continue;
        }
        if ((st.atCmd || st.names) && t.charCodeAt(j + 1) === 40) {
          const e = this.arith(j + 2, Arith.Parens);
          st.atCmd = true;
          st.names = false;
          j = e;
          continue;
        }
        if (st.atCmd) {
          let k = j + 1;
          while (isBlank(t.charCodeAt(k))) k++;
          if (t.charCodeAt(k) === 41) {
            // zsh's anonymous function, `() { … }`.
            this.mark('fn', j, k + 1);
            j = k + 1;
            continue;
          }
          this.mark('(', j, j + 1);
          this.punct.push(j);
          const e = this.list(j + 1, Term.Paren);
          if (t.charCodeAt(e - 1) === 41) {
            this.mark(')', e - 1, e);
            this.punct.push(e - 1);
          }
          st.atCmd = false;
          st.cmd = null;
          j = e;
          continue;
        }
        if (st.names) {
          // zsh `for x (a b c)` and `foreach x (a b c)`: the word list.
          j = this.wordList(j);
          st.names = false;
          st.atCmd = true;
          if (this.foreachDepth > 0) this.mark('do', j - 1, j);
          continue;
        }
        j++;
        continue;
      }
      if (c === 41 /* ) */) {
        if (top() === 'pattern') {
          cases[cases.length - 1] = 'arm';
          this.mark('arm', j, j + 1);
          j++;
          reset();
          continue;
        }
        j++;
        continue;
      }
      j = this.word(j, st, cases, () => reset());
    }
    return j;
  }

  /** An array literal, or zsh's `( a b c )` after a loop name: words until `)`; an array's numeric elements are numbers. */
  private wordList(j: number, array = false): number {
    const t = this.t;
    let k = j + 1;
    while (k < this.n && t.charCodeAt(k) !== 41) {
      const c = t.charCodeAt(k);
      if (c === 35 && this.wordStart(k)) {
        const e = this.lineEnd(k);
        this.span(k, e, 'comment');
        k = e;
      } else if (isBlank(c) || c === 10) {
        k++;
      } else {
        const e = this.wordTail(k, k);
        if (array) this.numeral(k, e);
        k = Math.max(e, k + 1);
      }
    }
    return Math.min(this.n, k + 1);
  }

  /** A word the grammar paints as a numeral: an integer, a decimal, hex or `base#digits`. */
  private numeral(j: number, k: number): void {
    if (k > j && NUMERAL.test(this.t.slice(j, k))) this.numbers.push({ start: j, end: k });
  }

  /**
   * One word at `j`: its quotes and expansions, then what it means where it
   * stands (a reserved word, an assignment, a command name, an operand).
   */
  private word(j: number, st: Cmd, cases: CaseState[], reset: () => void): number {
    const t = this.t;
    const top = cases[cases.length - 1];
    // An assignment at command position or as a declaring builtin's operand: `x=1`, `a[i]+=2`, `arr=(…)`.
    if ((st.atCmd || (st.mode !== '' && SH_DECL.has(st.mode) && !st.functions)) && isNameStart(t.charCodeAt(j)) && top !== 'pattern' && top !== 'subject'
      && !st.names && !st.fnName) {
      const ne = this.nameEnd(j);
      let k = ne;
      let sub = -1;
      if (t.charCodeAt(k) === 91 /* [ */) {
        sub = k;
        k = this.assoc.has(t.slice(j, ne)) ? this.bracketWord(k + 1) : this.arith(k + 1, Arith.Bracket, false);
      }
      const plus = t.charCodeAt(k) === 43 && t.charCodeAt(k + 1) === 61;
      if (t.charCodeAt(k) === 61 || plus) {
        const v = this.addVar(j, ne, true, st.atCmd ? '' : st.mode, st.atCmd ? '' : st.scope);
        if (st.atCmd) st.assigns.push(v);
        else if (st.assocDecl) this.assoc.add(v.name);
        k += plus ? 2 : 1;
        if (t.charCodeAt(k) === 40) return this.wordList(k, true);
        const value = k;
        k = this.wordTail(k, j);
        if (!st.atCmd) this.numeral(value, k);
        return k;
      }
      if (sub >= 0 && !st.atCmd) {
        this.addVar(j, ne, true, st.mode, st.scope);
        return this.wordTail(k, j);
      }
      if (sub >= 0) {
        // `a[1]` at command position with no `=`: a glob command word; the subscript was read as arithmetic.
        st.atCmd = false;
        return this.wordTail(k, j);
      }
    }
    const k = this.wordTail(j, j);
    const literal = this.literal(j, k);
    // A descriptor before a redirection: `2>`, `1>&2`.
    if (literal !== null && /^\d+$/.test(literal) && (t.charCodeAt(k) === 60 || t.charCodeAt(k) === 62)) return k;
    if (st.redirect) {
      st.redirect = false;
      return k;
    }
    if (top === 'subject') {
      cases[cases.length - 1] = 'in';
      return k;
    }
    if (top === 'in') {
      if (literal === 'in') {
        cases[cases.length - 1] = 'pattern';
        this.mark('in', j, k);
      }
      return k;
    }
    if (top === 'pattern') {
      if (literal === 'esac') {
        cases.pop();
        this.mark('esac', j, k);
        reset();
        st.atCmd = false;
        return k;
      }
      const prev = this.marks[this.marks.length - 1];
      if (!prev || prev.kind !== 'pattern' || this.patternOpen(prev.offset, j)) this.patternStart(j);
      return k;
    }
    if (st.names) {
      // `for arg do`: the positional parameters.
      if (literal === 'do' && st.operands > 0) {
        st.names = false;
        return this.reserved('do', j, k, st, cases);
      }
      if (literal === 'in' && st.operands > 0) {
        st.names = false;
        return k;
      }
      if (literal !== null && NAME.test(literal)) {
        this.addVar(j, k, true, 'for');
        st.operands++;
        return k;
      }
      st.names = false;
      return k;
    }
    // zsh's `function a b {` names several.
    if (st.fnName && literal !== '{') {
      st.fnName = this.zsh;
      st.atCmd = true;
      const e = this.skipParens(k);
      if (e > k) st.fnName = false;
      return e;
    }
    st.fnName = false;
    if (st.repeat) {
      st.repeat = false;
      st.atCmd = true;
      return k;
    }
    if (st.atCmd) {
      if (literal !== null && SH_RESERVED.has(literal)) return this.reserved(literal, j, k, st, cases);
      if (literal === 'end' && this.foreachDepth > 0) {
        this.foreachDepth--;
        this.mark('end', j, k);
        st.atCmd = false;
        return k;
      }
      // `name()`: a function definition.
      let q = k;
      while (isBlank(t.charCodeAt(q))) q++;
      if (t.charCodeAt(q) === 40) {
        let r = q + 1;
        while (isBlank(t.charCodeAt(r))) r++;
        if (t.charCodeAt(r) === 41) {
          this.mark('fn', j, r + 1);
          st.atCmd = true;
          return r + 1;
        }
      }
      for (const v of st.assigns) v.env = true;
      st.cmd = { name: literal ?? '', offset: j, piped: st.piped, args: [], argAt: [] };
      this.commands.push(st.cmd);
      st.atCmd = false;
      const name = literal ?? '';
      if (SH_DECL.has(name) || name === 'read' || name === 'mapfile' || name === 'readarray' || name === 'unset' || name === 'getopts'
        || name === 'printf' || name === 'let' || name === 'vared') {
        st.mode = name;
      }
      return k;
    }
    if (literal === '}' && this.zsh && this.braces[this.braces.length - 1] > 0) return this.reserved('}', j, k, st, cases);
    if (st.cmd && st.cmd.args.length < 8) {
      st.cmd.args.push(literal ?? '');
      st.cmd.argAt.push(j);
    }
    if (st.cmd) this.numeral(j, k);
    if (literal === 'always' && this.marks[this.marks.length - 1]?.kind === '}') {
      st.atCmd = true;
      return k;
    }
    this.operand(j, k, literal, st);
    return k;
  }

  /** A case pattern starts at `j` unless one already open runs to it. */
  private patternOpen(from: number, j: number): boolean {
    for (let i = from; i < j; i++) {
      const c = this.t.charCodeAt(i);
      if (c === 41 || c === 59) return true;
    }
    return false;
  }

  private patternStart(j: number): void {
    // An optional `(` before the pattern belongs to it.
    let p = j - 1;
    while (p >= 0 && isBlank(this.t.charCodeAt(p))) p--;
    this.mark('pattern', p >= 0 && this.t.charCodeAt(p) === 40 ? p : j, j);
  }

  /** `name` after `function`, and an optional `()` after it. */
  private skipParens(k: number): number {
    const t = this.t;
    let q = k;
    while (isBlank(t.charCodeAt(q))) q++;
    if (t.charCodeAt(q) !== 40) return k;
    let r = q + 1;
    while (isBlank(t.charCodeAt(r))) r++;
    return t.charCodeAt(r) === 41 ? r + 1 : k;
  }

  private reserved(w: string, j: number, k: number, st: Cmd, cases: CaseState[]): number {
    switch (w) {
      case 'if':
      case 'elif':
      case 'then':
      case 'else':
      case 'do':
      case 'while':
      case 'until':
        this.mark(w, j, k);
        st.atCmd = true;
        return k;
      case 'fi':
      case 'done':
        this.mark(w, j, k);
        st.atCmd = false;
        return k;
      case 'for':
      case 'select':
        this.mark(w, j, k);
        st.atCmd = false;
        st.names = true;
        return k;
      case 'foreach':
        this.mark(w, j, k);
        this.foreachDepth++;
        st.atCmd = false;
        st.names = true;
        return k;
      case 'repeat':
        this.mark(w, j, k);
        st.atCmd = false;
        st.repeat = true;
        return k;
      case 'case':
        this.mark(w, j, k);
        cases.push('subject');
        st.atCmd = false;
        return k;
      case 'esac':
        // The last arm needs no `;;`.
        if (cases[cases.length - 1] === 'arm' || cases[cases.length - 1] === 'pattern') {
          cases.pop();
          this.mark('esac', j, k);
        }
        st.atCmd = false;
        return k;
      case 'function':
        this.mark('fn', j, k);
        st.atCmd = false;
        st.fnName = true;
        return k;
      case '{':
        this.mark('{', j, k);
        this.punct.push(j);
        this.braces[this.braces.length - 1]++;
        st.atCmd = true;
        return k;
      case '}':
        this.mark('}', j, k);
        this.punct.push(j);
        if (this.braces[this.braces.length - 1] > 0) this.braces[this.braces.length - 1]--;
        st.atCmd = false;
        return k;
      case '[[':
        // zsh takes `then`, `do` and `{` straight after `]]`: bash would not parse a word there.
        st.atCmd = true;
        st.cmd = null;
        return this.cond(k);
      default:
        // `!`, `time`, `coproc`
        st.atCmd = true;
        return k;
    }
  }

  /** An argument of the current command, per builtin. */
  private operand(j: number, k: number, w: string | null, st: Cmd): void {
    const mode = st.mode;
    if (mode === 'getopts' && w === null) st.operands++;
    if (mode === '') return;
    if (st.skip) {
      st.skip = false;
      return;
    }
    if (w === null) return;
    if (st.nextVar) {
      st.nextVar = false;
      if (NAME.test(w)) this.addVar(j, k, true, mode);
      return;
    }
    const option = (w.startsWith('-') || w.startsWith('+')) && w.length > 1;
    if (option && w !== '--') {
      const flags = w.slice(1);
      if (SH_DECL.has(mode)) {
        if (/[fF]/.test(flags) && w.startsWith('-')) st.functions = true;
        if (flags.includes('g') && w.startsWith('-')) st.scope = 'g';
        if (flags.includes('A') && w.startsWith('-')) st.assocDecl = true;
      } else if (mode === 'read' || mode === 'vared') {
        const last = flags[flags.length - 1];
        if (mode === 'read' && flags.endsWith('a')) st.nextVar = true;
        if (READ_VALUE_OPTS.has(last) && !(mode === 'read' && this.zsh && last === 'k')) st.skip = true;
      } else if (mode === 'mapfile' || mode === 'readarray') {
        if (MAPFILE_VALUE_OPTS.has(flags[flags.length - 1])) st.skip = true;
      } else if (mode === 'unset') {
        if (flags.includes('f')) st.functions = true;
      } else if (mode === 'printf') {
        if (w === '-v') st.nextVar = true;
      }
      return;
    }
    if (st.functions || mode === 'printf') return;
    if (mode === 'let') {
      this.arith(j, Arith.Word);
      return;
    }
    if (mode === 'getopts') {
      st.operands++;
      if (st.operands === 2 && NAME.test(w)) this.addVar(j, k, true, 'getopts');
      return;
    }
    if (!NAME.test(w)) return;
    if (SH_DECL.has(mode)) {
      if (st.assocDecl) this.assoc.add(w);
      this.addVar(j, k, true, mode, st.scope);
      return;
    }
    if (mode === 'unset') {
      this.addVar(j, k, false, 'unset');
      return;
    }
    this.addVar(j, k, true, mode);
  }

  /** The literal text of [j, k), or null when it holds a quote, an escape or an expansion. */
  private literal(j: number, k: number): string | null {
    const t = this.t;
    for (let i = j; i < k; i++) {
      const c = t.charCodeAt(i);
      if (c === 39 || c === 34 || c === 36 || c === 96 || c === 92) return null;
    }
    return t.slice(j, k);
  }

  /** The rest of a word from `k`: its quotes, escapes and expansions; returns where it ends. */
  private wordTail(k: number, start: number): number {
    const t = this.t;
    const n = this.n;
    while (k < n) {
      const c = t.charCodeAt(k);
      if (c === 40 && k > start) {
        // extglob `@(…)`, `!(…)`, `*(…)`, `+(…)`, `?(…)`, and zsh glob qualifiers.
        const p = t.charCodeAt(k - 1);
        if (p === 64 || p === 33 || p === 42 || p === 43 || p === 63) {
          k = this.parenWord(k);
          continue;
        }
      }
      if ((c === 60 || c === 62) && t.charCodeAt(k + 1) === 40 && k === start) {
        const e = this.list(k + 2, Term.Paren);
        this.expansion(k, e);
        k = e;
        continue;
      }
      if (isMeta(c)) return k;
      if (c === 92) {
        k += 2;
        continue;
      }
      if (c === 39) {
        k = this.single(k);
        continue;
      }
      if (c === 34) {
        k = this.double(k);
        continue;
      }
      if (c === 36) {
        k = this.dollar(k);
        continue;
      }
      if (c === 96) {
        if (this.backticks > 0) return k;
        k = this.backtick(k);
        continue;
      }
      k++;
    }
    return k;
  }

  /** A parenthesised glob group from `(` at `k`, through its `)`. */
  private parenWord(k: number): number {
    const t = this.t;
    let depth = 0;
    while (k < this.n) {
      const c = t.charCodeAt(k);
      if (c === 40) depth++;
      else if (c === 41 && --depth === 0) return k + 1;
      else if (c === 10) return k;
      if (c === 92) k += 2;
      else if (c === 39) k = this.single(k);
      else if (c === 34) k = this.double(k);
      else if (c === 36) k = this.dollar(k);
      else k++;
    }
    return k;
  }

  // ── quotes ─────────────────────────────────────────────────────────────────

  private single(j: number): number {
    const e = this.t.indexOf("'", j + 1);
    const end = e < 0 ? this.n : e + 1;
    this.span(j, end, 'string');
    return end;
  }

  /** `$'…'`: backslash escapes. */
  private ansiC(j: number): number {
    const t = this.t;
    let k = j + 2;
    while (k < this.n && t.charCodeAt(k) !== 39) k += t.charCodeAt(k) === 92 ? 2 : 1;
    const end = Math.min(this.n, k + 1);
    this.span(j, end, 'string');
    return end;
  }

  /** `"…"` from the quote at `q` (the span starts at `start`, the `$` of `$"…"`): holes for its expansions. */
  private double(q: number, start = q): number {
    const t = this.t;
    const n = this.n;
    let k = q + 1;
    let seg = start;
    this.quoted++;
    while (k < n) {
      const c = t.charCodeAt(k);
      if (c === 34 || (c === 96 && this.backticks > 0)) break;
      if (c === 92) {
        k += 2;
        continue;
      }
      if (c === 36 || c === 96) {
        const e = c === 36 ? this.dollar(k) : this.backtick(k);
        if (e > k + 1 || c === 96) {
          this.span(seg, k, 'string');
          seg = e;
        }
        k = Math.max(e, k + 1);
        continue;
      }
      k++;
    }
    this.quoted--;
    const end = t.charCodeAt(k) === 34 ? k + 1 : k;
    this.span(seg, end, 'string');
    return end;
  }

  // ── expansions ─────────────────────────────────────────────────────────────

  /** An expansion at the `$` at `j`; returns the offset after it (`j + 1` for a lone `$`). */
  private dollar(j: number): number {
    const t = this.t;
    const c1 = t.charCodeAt(j + 1);
    if (c1 === 40) {
      if (t.charCodeAt(j + 2) === 40) {
        const e = this.arith(j + 3, Arith.Parens);
        this.expansion(j, e);
        return e;
      }
      const q = this.quoted;
      this.quoted = 0;
      const e = this.list(j + 2, Term.Paren);
      this.quoted = q;
      this.expansion(j, e);
      return e;
    }
    if (c1 === 123) {
      const e = this.param(j + 2);
      this.expansion(j, e);
      return e;
    }
    if (c1 === 91) {
      const e = this.arith(j + 2, Arith.Bracket);
      this.expansion(j, e);
      return e;
    }
    if (this.quoted === 0 && c1 === 39) return this.ansiC(j);
    if (this.quoted === 0 && c1 === 34) return this.double(j + 1, j);
    if (isNameStart(c1)) {
      const e = this.nameEnd(j + 1);
      this.addVar(j + 1, e, false);
      this.expansion(j, e);
      return e;
    }
    if (this.zsh && (c1 === 35 || c1 === 43) && isNameStart(t.charCodeAt(j + 2))) {
      const e = this.nameEnd(j + 2);
      this.addVar(j + 2, e, false);
      this.expansion(j, e);
      return e;
    }
    if (isDigit(c1) || c1 === 64 || c1 === 42 || c1 === 35 || c1 === 63 || c1 === 45 || c1 === 36 || c1 === 33) {
      this.expansion(j, j + 2);
      return j + 2;
    }
    return j + 1;
  }

  /** `$(…)` keeps no quote around it: its own words are code. A backtick does the same. */
  private backtick(j: number): number {
    const q = this.quoted;
    this.quoted = 0;
    this.backticks++;
    const e = this.list(j + 1, Term.Backtick);
    this.backticks--;
    this.quoted = q;
    this.expansion(j, e);
    return e;
  }

  /** A `${…}` body from `k`, after the `${`; returns the offset after its `}`. */
  private param(k: number): number {
    const t = this.t;
    if (this.zsh && t.charCodeAt(k) === 40) {
      const e = t.indexOf(')', k);
      if (e > 0) k = e + 1;
    }
    const c0 = t.charCodeAt(k);
    if ((c0 === 35 || c0 === 33) && t.charCodeAt(k + 1) !== 125) k++;
    if (this.zsh) while (t.charCodeAt(k) === 43 || t.charCodeAt(k) === 61 || t.charCodeAt(k) === 126 || t.charCodeAt(k) === 94) k++;
    let name = '';
    if (t.charCodeAt(k) === 36) {
      k = this.dollar(k);
    } else if (isNameStart(t.charCodeAt(k))) {
      const e = this.nameEnd(k);
      name = t.slice(k, e);
      const assigns = (t.charCodeAt(e) === 58 && t.charCodeAt(e + 1) === 61) || t.charCodeAt(e) === 61;
      this.addVar(k, e, assigns);
      k = e;
    } else if (isDigit(t.charCodeAt(k))) {
      while (isDigit(t.charCodeAt(k))) k++;
    } else if (isSpecial(t.charCodeAt(k))) {
      k++;
    }
    if (t.charCodeAt(k) === 91) k = this.assoc.has(name) ? this.bracketWord(k + 1) : this.arith(k + 1, Arith.Bracket, false);
    if (t.charCodeAt(k) === 58) {
      const c1 = t.charCodeAt(k + 1);
      // zsh modifiers (`:h`, `:gs/a/b/`) and its `:#`, `:|`, `:*`, `:^` array operators.
      const zshOp = this.zsh && (isNameStart(c1) || c1 === 38 || c1 === 35 || c1 === 124 || c1 === 42 || c1 === 94);
      if (c1 !== 45 && c1 !== 61 && c1 !== 63 && c1 !== 43 && !zshOp) {
        k = this.arith(k + 1, Arith.Offset, false);
        if (t.charCodeAt(k) === 58) k = this.arith(k + 1, Arith.Offset, false);
      }
    }
    return this.paramRest(k);
  }

  /** The operator and word of a `${…}` up to its `}`. */
  private paramRest(k: number): number {
    const t = this.t;
    const n = this.n;
    let depth = 0;
    while (k < n) {
      const c = t.charCodeAt(k);
      if (c === 125) {
        if (depth === 0) return k + 1;
        depth--;
        k++;
        continue;
      }
      if (c === 123) depth++;
      if (c === 92) {
        k += 2;
        continue;
      }
      if (c === 39) {
        // A single quote inside a quoted `${…}` is a plain character.
        k = this.quoted > 0 ? k + 1 : this.single(k);
        continue;
      }
      if (c === 34) {
        k = this.double(k);
        continue;
      }
      if (c === 36) {
        k = Math.max(this.dollar(k), k + 1);
        continue;
      }
      if (c === 96) {
        k = this.backtick(k);
        continue;
      }
      k++;
    }
    return k;
  }

  /** An associative array's subscript: a key, through its `]`. */
  private bracketWord(k: number): number {
    const t = this.t;
    while (k < this.n) {
      const c = t.charCodeAt(k);
      if (c === 93) return k + 1;
      if (c === 10) return k;
      if (c === 36) k = Math.max(this.dollar(k), k + 1);
      else if (c === 34) k = this.double(k);
      else if (c === 39) k = this.single(k);
      else if (c === 92) k += 2;
      else k++;
    }
    return k;
  }

  /**
   * Arithmetic from `j`: bare names are variables, numerals are numbers. Ends at
   * `))` (Parens, returning the offset after it), at `]` (Bracket, after it), at
   * `:` or `}` (Offset, at it), or at the end of a word (Word, at it). The grammar
   * paints no numeral in a `${…}` subscript or offset, nor in an assignment's
   * subscript: `nums` false there.
   */
  private arith(j: number, until: Arith, nums = true): number {
    const t = this.t;
    const n = this.n;
    let depth = 0;
    // A zsh subscript flag, `[(r)pattern]`: the pattern is text.
    if (until === Arith.Bracket && this.zsh && t.charCodeAt(j) === 40) return this.bracketWord(j);
    while (j < n) {
      const c = t.charCodeAt(j);
      if (depth === 0) {
        if (until === Arith.Parens && c === 41) return t.charCodeAt(j + 1) === 41 ? j + 2 : j + 1;
        if (until === Arith.Bracket && c === 93) return j + 1;
        if (until === Arith.Offset && (c === 58 || c === 125)) return j;
        if (until === Arith.Word && (isMeta(c))) return j;
      }
      if (c === 40) {
        depth++;
        j++;
        continue;
      }
      if (c === 41) {
        depth--;
        j++;
        continue;
      }
      if (until !== Arith.Parens && c === 10) return j;
      if (c === 36) {
        j = Math.max(this.dollar(j), j + 1);
        continue;
      }
      if (c === 34) {
        j = this.double(j);
        continue;
      }
      if (c === 39) {
        j = this.single(j);
        continue;
      }
      if (c === 96) {
        j = this.backtick(j);
        continue;
      }
      if (c === 92) {
        j += 2;
        continue;
      }
      const p = j > 0 ? t.charCodeAt(j - 1) : 0;
      if (isNameStart(c) && !isNamePart(p) && p !== 35 && p !== 46) {
        const e = this.nameEnd(j);
        let a = e;
        while (isBlank(t.charCodeAt(a))) a++;
        const a0 = t.charCodeAt(a);
        const a1 = t.charCodeAt(a + 1);
        const pre = j >= 2 && ((p === 43 && t.charCodeAt(j - 2) === 43) || (p === 45 && t.charCodeAt(j - 2) === 45));
        const write = pre || (a0 === 61 && a1 !== 61) || ((a0 === 43 || a0 === 45) && a1 === a0)
          || (a1 === 61 && (a0 === 43 || a0 === 45 || a0 === 42 || a0 === 47 || a0 === 37 || a0 === 38 || a0 === 124 || a0 === 94))
          || (a0 === 60 && a1 === 60 && t.charCodeAt(a + 2) === 61) || (a0 === 62 && a1 === 62 && t.charCodeAt(a + 2) === 61);
        this.addVar(j, e, write);
        j = e;
        if (t.charCodeAt(j) === 91) j = this.arith(j + 1, Arith.Bracket, nums);
        continue;
      }
      if (isDigit(c) && !isNamePart(p)) {
        let e = j + 1;
        while (e < n && (isNamePart(t.charCodeAt(e)) || t.charCodeAt(e) === 35 || t.charCodeAt(e) === 64)) e++;
        if (this.zsh && t.charCodeAt(e) === 46 && isDigit(t.charCodeAt(e + 1))) {
          e++;
          while (isDigit(t.charCodeAt(e))) e++;
        }
        if (nums) this.numbers.push({ start: j, end: e });
        j = e;
        continue;
      }
      j++;
    }
    return j;
  }

  /** `[[ … ]]` from after `[[`: words through the closing `]]`; a numeric word is a number. */
  private cond(k: number): number {
    const t = this.t;
    const n = this.n;
    while (k < n) {
      const c = t.charCodeAt(k);
      if (c === 93 && t.charCodeAt(k + 1) === 93 && isBlank(t.charCodeAt(k - 1)) && isMeta(t.charCodeAt(k + 2))) return k + 2;
      if (c === 10) {
        k++;
        if (this.pending.length > 0) k = this.heredocs(k);
        continue;
      }
      if (isDigit(c) && isBlank(t.charCodeAt(k - 1))) {
        let e = k;
        while (e < n && !isMeta(t.charCodeAt(e))) e++;
        this.numeral(k, e);
        k = e;
        continue;
      }
      if (c === 92) k += 2;
      else if (c === 36) k = Math.max(this.dollar(k), k + 1);
      else if (c === 34) k = this.double(k);
      else if (c === 39) k = this.single(k);
      else if (c === 96) k = this.backtick(k);
      else k++;
    }
    return k;
  }

  // ── heredocs ───────────────────────────────────────────────────────────────

  /** `<<` or `<<-` at `j` and its delimiter word; the body is read at the next line break. */
  private heredocOperator(j: number): number {
    const t = this.t;
    let k = j + 2;
    const strip = t.charCodeAt(k) === 45;
    if (strip) k++;
    while (isBlank(t.charCodeAt(k))) k++;
    let word = '';
    let quoted = false;
    while (k < this.n) {
      const c = t.charCodeAt(k);
      if (isMeta(c)) break;
      if (c === 39 || c === 34) {
        const e = t.indexOf(t[k], k + 1);
        const end = e < 0 ? this.lineEnd(k) : e;
        word += t.slice(k + 1, end);
        quoted = true;
        this.span(k, Math.min(this.n, end + 1), 'string');
        k = end + 1;
        continue;
      }
      if (c === 92) {
        quoted = true;
        word += t[k + 1] ?? '';
        k += 2;
        continue;
      }
      word += t[k];
      k++;
    }
    if (word !== '') this.pending.push({ word, strip, quoted });
    return k;
  }

  /** The bodies queued on the line that ended before `j`, in order; returns the offset after the last terminator line. */
  private heredocs(j: number): number {
    const t = this.t;
    const n = this.n;
    const queue = this.pending.splice(0);
    for (const h of queue) {
      let seg = j;
      this.quoted++;
      for (;;) {
        if (j >= n) {
          this.span(seg, n, 'string');
          break;
        }
        const le = this.lineEnd(j);
        let ls = j;
        if (h.strip) while (t.charCodeAt(ls) === 9) ls++;
        let lend = le;
        if (lend > ls && t.charCodeAt(lend - 1) === 13) lend--;
        if (lend - ls === h.word.length && t.startsWith(h.word, ls)) {
          this.span(seg, le, 'string');
          j = le < n ? le + 1 : n;
          break;
        }
        if (!h.quoted) {
          let m = j;
          while (m < le) {
            const c = t.charCodeAt(m);
            if (c === 92) {
              m += 2;
              continue;
            }
            if (c === 36 || c === 96) {
              const e = c === 36 ? this.dollar(m) : this.backtick(m);
              if (e > m + 1 || c === 96) {
                this.span(seg, m, 'string');
                seg = e;
              }
              m = Math.max(e, m + 1);
              continue;
            }
            m++;
          }
          if (m > le) {
            // An expansion ran past the line: the body continues after it.
            j = m;
            continue;
          }
        }
        j = le < n ? le + 1 : n;
      }
      this.quoted--;
    }
    return j;
  }
}

// ── fish ─────────────────────────────────────────────────────────────────────

const FISH_BLOCK = new Set(['function', 'if', 'for', 'while', 'switch', 'begin']);
/** Words after which the next word is a command. */
const FISH_PREFIX = new Set(['and', 'or', 'not', 'command', 'builtin', 'exec', 'time', '!']);
/** Options of `read` that take a value. */
const FISH_READ_VALUE = new Set(['-p', '--prompt', '-P', '--prompt-str', '-R', '--right-prompt', '-c', '--command', '-d', '--delimiter',
  '-n', '--nchars']);
/** `function` options whose value is a word, not a variable. */
const FISH_FN_VALUE = new Set(['-d', '--description', '-w', '--wraps', '-e', '--on-event', '-j', '--on-job-exit', '-p', '--on-process-exit',
  '-s', '--on-signal']);

interface FishCmd {
  atCmd: boolean;
  cmd: ShellCommand | null;
  mode: string;
  scope: '' | 'g' | 'l' | 'f';
  /** `set -e`, `set -q`, `set -S`, `set -n`: the operands are no writes. */
  query: boolean;
  /** The command's name operand is read. */
  named: boolean;
  skip: boolean;
  /** `function` options: `-a` names follow until the next option. */
  argNames: boolean;
  piped: boolean;
  redirect: boolean;
  /** A block keyword whose header this command is: its body starts at the command's end. */
  header: boolean;
}

function freshFish(): FishCmd {
  return { atCmd: true, cmd: null, mode: '', scope: '', query: false, named: false, skip: false, argNames: false, piped: false, redirect: false,
    header: false };
}

class FishLexer {
  readonly n: number;
  readonly spans: LexSpan[] = [];
  readonly holes: LexRange[] = [];
  readonly numbers: LexRange[] = [];
  readonly punct: number[] = [];
  readonly vars: ShellVar[] = [];
  readonly commands: ShellCommand[] = [];
  readonly marks: ShellMark[] = [];
  private quoted = 0;
  /** Open `{ … }` blocks, fish 4's `begin … end`: a `}` word closes one wherever it stands. */
  private braces = 0;

  constructor(readonly t: string) {
    this.n = t.length;
  }

  run(): void {
    this.list(0, false);
  }

  private span(start: number, end: number, region: LexSpan['region']): void {
    if (end > start) this.spans.push({ start, end, region });
  }

  private mark(kind: ShellMarkKind, offset: number, end: number): void {
    this.marks.push({ kind, offset, end });
  }

  private addVar(start: number, end: number, write: boolean, via = '', scope: ShellVar['scope'] = ''): void {
    this.vars.push({ name: this.t.slice(start, end), offset: start, length: end - start, write, via, scope });
  }

  private nameEnd(i: number): number {
    const t = this.t;
    while (i < this.n && isNamePart(t.charCodeAt(i))) i++;
    return i;
  }

  private wordStart(i: number): boolean {
    if (i === 0) return true;
    const p = this.t.charCodeAt(i - 1);
    return isBlank(p) || p === 10 || p === 59 || p === 38 || p === 124 || p === 40 || p === 41;
  }

  /** A command list to EOF, or to the `)` of a command substitution; returns the offset after it. */
  private list(j: number, paren: boolean): number {
    const t = this.t;
    const n = this.n;
    let st = freshFish();
    const end = (at: number): void => {
      if (st.header) this.mark('body', at, at);
      st = freshFish();
    };
    while (j < n) {
      const c = t.charCodeAt(j);
      if (paren && c === 41) {
        end(j);
        return j + 1;
      }
      if (c === 92 && t.charCodeAt(j + 1) === 10) {
        j += 2;
        continue;
      }
      if (c === 10 || c === 59) {
        end(j);
        j++;
        continue;
      }
      if (isBlank(c)) {
        j++;
        continue;
      }
      if (c === 35 && this.wordStart(j)) {
        const e = t.indexOf('\n', j);
        const le = e < 0 ? n : e;
        this.span(j, le, 'comment');
        j = le;
        continue;
      }
      if (c === 124 || c === 38) {
        const c1 = t.charCodeAt(j + 1);
        if (c === 38 && c1 === 62) {
          j += 2;
          st.redirect = true;
          continue;
        }
        const header = st.header;
        if (c1 === c) {
          j += 2;
          st = freshFish();
        } else {
          j += c === 124 && c1 === 38 ? 2 : 1;
          st = freshFish();
          st.piped = c === 124;
        }
        st.header = header;
        continue;
      }
      if (c === 60 || c === 62 || (isDigit(c) && (t.charCodeAt(j + 1) === 62 || t.charCodeAt(j + 1) === 60) && this.wordStart(j))) {
        j++;
        while (j < n && (t.charCodeAt(j) === 60 || t.charCodeAt(j) === 62 || t.charCodeAt(j) === 38 || t.charCodeAt(j) === 124
          || t.charCodeAt(j) === 63)) j++;
        st.redirect = true;
        continue;
      }
      j = this.word(j, st);
    }
    end(j);
    return j;
  }

  private word(j: number, st: FishCmd): number {
    const k = this.wordTail(j);
    if (k === j) return j + 1;
    const literal = this.literal(j, k);
    if (st.redirect) {
      st.redirect = false;
      return k;
    }
    if (literal === '}' && this.braces > 0) {
      this.braces--;
      this.mark('end', j, k);
      st.atCmd = false;
      return k;
    }
    if (st.atCmd) {
      if (literal !== null && FISH_PREFIX.has(literal)) return k;
      if (literal === '{') {
        this.braces++;
        this.mark('begin', j, k);
        this.mark('body', k, k);
        return k;
      }
      // `NAME=value command`: set for the one command.
      const ne = this.nameEnd(j);
      if (ne > j && isNameStart(this.t.charCodeAt(j)) && this.t.charCodeAt(ne) === 61) {
        this.vars.push({ name: this.t.slice(j, ne), offset: j, length: ne - j, write: true, via: '', scope: '', env: true });
        return k;
      }
      if (literal === 'end') {
        this.mark('end', j, k);
        st.atCmd = false;
        return k;
      }
      if (literal === 'else') {
        this.mark('else', j, k);
        st.header = true;
        return k;
      }
      if (literal === 'case') {
        this.mark('case', j, k);
        st.header = true;
        st.atCmd = false;
        st.mode = 'case';
        return k;
      }
      if (literal !== null && FISH_BLOCK.has(literal)) {
        this.mark(literal as ShellMarkKind, j, k);
        st.header = true;
        if (literal === 'begin') {
          this.mark('body', k, k);
          st.header = false;
          return k;
        }
        if (literal === 'if' || literal === 'while') return k;
        st.atCmd = false;
        st.mode = literal;
        return k;
      }
      st.atCmd = false;
      st.cmd = { name: literal ?? '', offset: j, piped: st.piped, args: [], argAt: [] };
      this.commands.push(st.cmd);
      const name = literal ?? '';
      if (name === 'set' || name === 'read' || name === 'argparse') st.mode = name;
      return k;
    }
    if (st.cmd && st.cmd.args.length < 8) {
      st.cmd.args.push(literal ?? '');
      st.cmd.argAt.push(j);
    }
    this.operand(j, k, literal, st);
    return k;
  }

  private operand(j: number, k: number, w: string | null, st: FishCmd): void {
    const mode = st.mode;
    if (mode === '' || mode === 'case' || mode === 'switch') return;
    if (st.skip) {
      st.skip = false;
      return;
    }
    if (w === null) {
      // `set name[$i] value`: the name before a computed index.
      const ne = this.nameEnd(j);
      if (mode === 'set' && ne > j && isNameStart(this.t.charCodeAt(j)) && this.t.charCodeAt(ne) === 91) {
        st.mode = 'values';
        this.addVar(j, ne, !st.query, 'set', st.scope);
      }
      return;
    }
    const option = w.startsWith('-') && w.length > 1 && !/^-\d/.test(w);
    if (mode === 'function') {
      if (option) {
        st.argNames = w === '-a' || w === '--argument-names';
        // `--inherit-variable x` copies the outer `x` into the function: a local of its own.
        st.named = w === '-V' || w === '--inherit-variable';
        if (!st.named && (w === '-v' || w === '--on-variable' || FISH_FN_VALUE.has(w))) st.skip = true;
        return;
      }
      if (st.named) {
        st.named = false;
        if (NAME.test(w)) this.addVar(j, k, true, 'function', 'l');
        return;
      }
      if (st.argNames && NAME.test(w)) this.addVar(j, k, true, 'function', 'l');
      return;
    }
    if (mode === 'for') {
      if (w === 'in') {
        st.mode = 'in';
        return;
      }
      if (NAME.test(w)) this.addVar(j, k, true, 'for', 'l');
      st.mode = 'in';
      return;
    }
    if (mode === 'in' || mode === 'argparse') return;
    if (option) {
      if (w.startsWith('--')) {
        const long = w.slice(2);
        if (long === 'local') st.scope = 'l';
        else if (long === 'function') st.scope = 'f';
        else if (long === 'global' || long === 'universal') st.scope = 'g';
        else if (long === 'erase' || long === 'query' || long === 'show' || long === 'names') st.query = true;
        if (mode === 'read' && FISH_READ_VALUE.has(w)) st.skip = true;
        return;
      }
      for (const f of w.slice(1)) {
        if (f === 'l') st.scope = 'l';
        else if (f === 'f') st.scope = 'f';
        else if (f === 'g' || f === 'U') st.scope = 'g';
        else if (f === 'e' || f === 'q' || f === 'S' || f === 'n') st.query = true;
      }
      if (mode === 'read' && FISH_READ_VALUE.has(w)) st.skip = true;
      return;
    }
    // `set name value…`: only the first operand is a name; `read a b c`: every operand is.
    if (mode === 'set') {
      st.mode = 'values';
      const ne = this.nameEnd(j);
      if (ne > j && isNameStart(this.t.charCodeAt(j)) && (ne === k || this.t.charCodeAt(ne) === 91)) {
        this.addVar(j, ne, !st.query, 'set', st.scope);
      }
      return;
    }
    if (mode === 'read' && NAME.test(w)) this.addVar(j, k, true, 'read', st.scope);
  }

  private literal(j: number, k: number): string | null {
    const t = this.t;
    for (let i = j; i < k; i++) {
      const c = t.charCodeAt(i);
      if (c === 39 || c === 34 || c === 36 || c === 92 || c === 40) return null;
    }
    return t.slice(j, k);
  }

  /** A word from `k`: quotes, `$var[…]`, `(…)` and `$(…)` substitutions, escapes. */
  private wordTail(k: number): number {
    const t = this.t;
    const n = this.n;
    const start = k;
    while (k < n) {
      const c = t.charCodeAt(k);
      if (c === 40) {
        const e = this.list(k + 1, true);
        this.expansion(k, e);
        k = e;
        continue;
      }
      if (isMeta(c) || (c === 35 && k === start)) return k;
      if (c === 92) {
        k += 2;
        continue;
      }
      if (c === 39) {
        k = this.single(k);
        continue;
      }
      if (c === 34) {
        k = this.double(k);
        continue;
      }
      if (c === 36) {
        k = this.dollar(k);
        continue;
      }
      if (isDigit(c) && k === start) {
        let e = k;
        while (isDigit(t.charCodeAt(e))) e++;
        if (t.charCodeAt(e) === 46 && isDigit(t.charCodeAt(e + 1))) {
          e++;
          while (isDigit(t.charCodeAt(e))) e++;
        }
        // A redirection's file descriptor (`2>`, `>&2`, `2>&1`) is no numeral to the grammar.
        const before = t.charCodeAt(k - 1);
        const after = t.charCodeAt(e);
        const fd = after === 60 || after === 62 || before === 60 || before === 62
          || (before === 38 && (t.charCodeAt(k - 2) === 60 || t.charCodeAt(k - 2) === 62));
        if (isMeta(after) && !fd) this.numbers.push({ start: k, end: e });
        k = e;
        continue;
      }
      k++;
    }
    return k;
  }

  /** An expansion inside `"…"` or a heredoc body is a hole: code inside a string. */
  private expansion(start: number, end: number): void {
    if (this.quoted > 0) this.holes.push({ start, end });
  }

  /** `'…'`: only `\'` and `\\` escape. */
  private single(j: number): number {
    const t = this.t;
    let k = j + 1;
    while (k < this.n && t.charCodeAt(k) !== 39) k += t.charCodeAt(k) === 92 ? 2 : 1;
    const end = Math.min(this.n, k + 1);
    this.span(j, end, 'string');
    return end;
  }

  /** `"…"`: `$var`, `$var[…]` and `$(…)` holes. */
  private double(q: number): number {
    const t = this.t;
    const n = this.n;
    let k = q + 1;
    let seg = q;
    this.quoted++;
    while (k < n) {
      const c = t.charCodeAt(k);
      if (c === 34) break;
      if (c === 92) {
        k += 2;
        continue;
      }
      if (c === 36) {
        const e = this.dollar(k);
        if (e > k + 1) {
          this.span(seg, k, 'string');
          seg = e;
        }
        k = Math.max(e, k + 1);
        continue;
      }
      k++;
    }
    this.quoted--;
    const end = Math.min(n, k + 1);
    this.span(seg, end, 'string');
    return end;
  }

  /** `$name`, `$$name`, `$name[…]`, `$(…)`; returns the offset after it. */
  private dollar(j: number): number {
    const t = this.t;
    let k = j + 1;
    while (t.charCodeAt(k) === 36) k++;
    if (t.charCodeAt(k) === 40 && k === j + 1) {
      const q = this.quoted;
      this.quoted = 0;
      const e = this.list(k + 1, true);
      this.quoted = q;
      this.expansion(j, e);
      return e;
    }
    const e = this.nameEnd(k);
    if (e === k) return k;
    this.addVar(k, e, false);
    let end = e;
    while (t.charCodeAt(end) === 91) end = this.index(end + 1);
    this.expansion(j, end);
    return end;
  }

  /** `[…]` after a variable: an index or range, its digits numbers, nested expansions; returns the offset after `]`. */
  private index(k: number): number {
    const t = this.t;
    while (k < this.n) {
      const c = t.charCodeAt(k);
      if (c === 93) return k + 1;
      if (c === 10) return k;
      if (c === 36) {
        k = Math.max(this.dollar(k), k + 1);
        continue;
      }
      if (c === 40) {
        const e = this.list(k + 1, true);
        this.expansion(k, e);
        k = e;
        continue;
      }
      if (isDigit(c) && !isNamePart(t.charCodeAt(k - 1))) {
        let e = k;
        while (isDigit(t.charCodeAt(e))) e++;
        this.numbers.push({ start: k, end: e });
        k = e;
        continue;
      }
      k++;
    }
    return k;
  }
}

function finish(syntax: LangSyntax, text: string, l: ShLexer | FishLexer): LexResult {
  l.spans.sort((a, b) => a.start - b.start);
  l.vars.sort((a, b) => a.offset - b.offset);
  l.numbers.sort((a, b) => a.start - b.start);
  l.holes.sort((a, b) => a.start - b.start);
  l.punct.sort((a, b) => a - b);
  const idents: LexId[] = l.vars.map((v) => ({ name: v.name, offset: v.offset, length: v.length }));
  const lx = lexResultOf(syntax, text, l.spans, l.holes, idents, l.numbers, l.punct);
  tables.set(lx, { vars: l.vars, commands: l.commands, marks: l.marks });
  return lx;
}

export function lexShell(text: string, syntax: LangSyntax): LexResult {
  const l = new ShLexer(text);
  l.run();
  return finish(syntax, text, l);
}

export function lexFish(text: string, syntax: LangSyntax): LexResult {
  const l = new FishLexer(text);
  l.run();
  return finish(syntax, text, l);
}

// ── bindings ─────────────────────────────────────────────────────────────────

/** Builtins whose operands are a function's own variables. */
const SH_LOCAL = new Set(['local', 'declare', 'typeset', 'integer', 'float']);

export interface ShellFacts {
  /** Offsets of the variable occurrences that are data identities: every occurrence of a name the file writes. */
  data: Set<number>;
  /** A function-local's declarations, and every write outside a function: the binding sites. */
  declSites: Set<number>;
  /** Names a function writes without declaring them its own: globals, whatever else declares them. */
  globalWrites: Set<string>;
}

const factsMemo = new WeakMap<LexResult, ShellFacts>();

/**
 * Bindings by each shell's rule. bash and zsh: `local`, `declare`, `typeset`,
 * `integer` and `float` operands without `-g` inside a function are its own;
 * every other write in a function writes a global, so it declares nothing.
 * fish: `set -l` / `-f`, `for`, `--argument-names` and a plain `set` or `read`
 * of a name the file never makes global are the function's own; `set -g` and
 * `-U` are global. Outside every function each write declares. Rules:
 * docs/tooling.md#bindings.
 */
export function shellFacts(lx: LexResult, blocks?: BraceBlock[]): ShellFacts {
  let f = factsMemo.get(lx);
  if (!f) {
    f = computeFacts(lx, blocks);
    factsMemo.set(lx, f);
  }
  return f;
}

function computeFacts(lx: LexResult, blocks?: BraceBlock[]): ShellFacts {
  const fish = lx.syntax.family === 'fish';
  const lang = fish ? 'fish' : 'shellscript';
  const text = lx.text;
  const scanned = blocks ?? (fish ? scanFishBlocks(text) : scanShellBlocks(text));
  const fns: { start: number; end: number }[] = [];
  for (const b of scanned) {
    const r = functionScopeOf(text, b, lang);
    if (r) fns.push(r);
  }
  // The innermost function wins: the latest-starting range that holds the offset.
  const index: IntervalIndex = buildIntervalIndex(fns.map((r) => r.start), fns.map((r) => r.end), (a, b) => fns[b].start - fns[a].start);
  const inFn = (offset: number): boolean => bestAt(index, offset) >= 0;
  /** fish: per function, the names it has declared so far; a plain `set` of one writes it. */
  const declared = new Map<number, Set<string>>();
  const vars = shellTables(lx).vars;
  const written = new Set<string>();
  const global = new Set<string>();
  for (const v of vars) {
    if (!v.write || v.env) continue;
    written.add(v.name);
    if (fish && (v.scope === 'g' || (v.scope === '' && !inFn(v.offset)))) global.add(v.name);
  }
  const data = new Set<number>();
  const declSites = new Set<number>();
  const globalWrites = new Set<string>();
  for (const v of vars) {
    // A name the file never writes is the shell's or the environment's (`$HOME`, `$OPTARG`, `$BASH_REMATCH`).
    if (v.name === '_' || (fish && v.name === 'argv') || !written.has(v.name)) continue;
    data.add(v.offset);
    if (!v.write || v.env) continue;
    if (!inFn(v.offset)) {
      declSites.add(v.offset);
      continue;
    }
    if (!fish) {
      if (SH_LOCAL.has(v.via) && v.scope !== 'g') declSites.add(v.offset);
      else globalWrites.add(v.name);
      continue;
    }
    const fn = bestAt(index, v.offset);
    let names = declared.get(fn);
    if (!names) declared.set(fn, (names = new Set()));
    if (v.scope === 'l' || v.scope === 'f' || v.via === 'for' || v.via === 'function') {
      declSites.add(v.offset);
      names.add(v.name);
    } else if (global.has(v.name)) {
      globalWrites.add(v.name);
    } else if (!names.has(v.name)) {
      // A plain `set` of a name the function has not declared makes it the function's.
      declSites.add(v.offset);
      names.add(v.name);
    }
  }
  return { data, declSites, globalWrites };
}

/**
 * The semantic path's tokens for a shell or fish document: the bindings'
 * variables, whatever the server sent. fish-lsp types a declaration and a use
 * alike and some names inside single-quoted strings; bash-language-server sends
 * none. Both paths then classify the same names the same way.
 */
export function shellTokens<T extends { name: string; offset: number; length: number; type: string; modifiers: string[] }>(lx: LexResult): T[] {
  const f = shellFacts(lx);
  const out: T[] = [];
  for (const v of shellTables(lx).vars) {
    if (!f.data.has(v.offset)) continue;
    out.push({ name: v.name, offset: v.offset, length: v.length, type: 'variable', modifiers: f.declSites.has(v.offset) ? ['declaration'] : [] } as T);
  }
  return out;
}
