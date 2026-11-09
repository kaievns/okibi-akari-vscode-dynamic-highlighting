/**
 * Ruby bindings over the shared lexer and the keyword block scan: which
 * identifier declares a local, which declaration each name resolves to, and
 * which names are method calls, labels or members rather than data. Ruby
 * decides local versus method call lexically, so this is the parser's own rule.
 * Rules: docs/ruby.md.
 */

import { LexId, LexResult } from './lex';
import { BraceBlock, rubyBlockKind, rubyDefName, scanRubyBlocks } from './focus';
import { IntervalIndex, bestAt, buildIntervalIndex } from './intervals';
import type { DecodedToken } from './classify';

export const RUBY_KEYWORDS: ReadonlySet<string> = new Set([
  'BEGIN', 'END', 'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'defined?', 'do', 'else', 'elsif', 'end',
  'ensure', 'false', 'for', 'if', 'in', 'module', 'next', 'nil', 'not', 'or', 'redo', 'rescue', 'retry', 'return',
  'self', 'super', 'then', 'true', 'undef', 'unless', 'until', 'when', 'while', 'yield', '__FILE__', '__LINE__',
  '__ENCODING__', '__END__',
]);

/** Globals Ruby defines: library surface, not this file's data. */
const RUBY_PREDEFINED_GLOBALS: ReadonlySet<string> = new Set([
  '$stdout', '$stderr', '$stdin', '$PROGRAM_NAME', '$LOAD_PATH', '$LOADED_FEATURES', '$DEBUG', '$VERBOSE', '$FILENAME',
  '$ERROR_INFO', '$ERROR_POSITION', '$FIELD_SEPARATOR', '$FS', '$OUTPUT_FIELD_SEPARATOR', '$OFS', '$INPUT_RECORD_SEPARATOR',
  '$RS', '$OUTPUT_RECORD_SEPARATOR', '$ORS', '$INPUT_LINE_NUMBER', '$NR', '$LAST_READ_LINE', '$DEFAULT_OUTPUT',
  '$DEFAULT_INPUT', '$PID', '$PROCESS_ID', '$CHILD_STATUS', '$LAST_MATCH_INFO', '$IGNORECASE', '$ARGV', '$MATCH',
  '$PREMATCH', '$POSTMATCH', '$LAST_PAREN_MATCH', '$SAFE', '$KCODE', '$CLASSPATH',
]);

/** `$foo` written by this file: data, out of every scope. `$0`, `$~`, `$stdout` are Ruby's. */
export function rubyUserGlobal(name: string): boolean {
  return /^\$[A-Za-z_]\w*$/.test(name) && !RUBY_PREDEFINED_GLOBALS.has(name);
}

/** The Kernel names VS Code's Ruby grammar scopes `support.function.kernel.ruby` wherever they appear. */
export const RUBY_GRAMMAR_BUILTINS: ReadonlySet<string> = new Set([
  'abort', 'at_exit', 'autoload', 'binding', 'callcc', 'caller', 'caller_locations', 'chomp', 'chop', 'eval', 'exec',
  'exit', 'fork', 'format', 'gets', 'global_variables', 'gsub', 'lambda', 'load', 'local_variables', 'open', 'p', 'print',
  'printf', 'proc', 'putc', 'puts', 'rand', 'readline', 'readlines', 'select', 'set_trace_func', 'sleep', 'spawn',
  'sprintf', 'srand', 'sub', 'syscall', 'system', 'test', 'trace_var', 'trap', 'untrace_var', 'warn',
]);

export interface RubyDecl {
  offset: number;
  name: string;
  kind: 'param' | 'local' | 'implicit';
  /** The local scope it lives in: a `def` / `class` / `module` body, a block or lambda, or the file. */
  scope: RubyScope;
}

export interface RubyScope {
  kind: 'file' | 'def' | 'class' | 'block';
  start: number;
  /** Last offset of the scope. */
  end: number;
  block?: BraceBlock;
  /** A `def`'s name. */
  name?: string;
  parent?: RubyScope;
}

export interface RubyFacts {
  /** Identifiers that declare a local: a scope's first assignment, parameters, block parameters, captures. */
  declSites: Set<number>;
  /** Identifiers that assign a local (declarations included) or a user global. */
  writeSites: Set<number>;
  /** Per identifier that is data: the declaration offset it resolves to; -1 for a user global. */
  binding: Map<number, number>;
  decls: Map<number, RubyDecl>;
  /** `name:` shorthand for `name: name` in a hash or argument list. */
  shorthands: Set<number>;
  /** Names a multiple assignment writes (`a, @b, $c = …`), any sigil. */
  multi: Set<number>;
  /** Writes to a user global outside every method and block: they define it. */
  globalSites: Set<number>;
  /** The innermost local scope at `offset`. */
  scopeAt(offset: number): RubyScope;
  /** The innermost `def` whose parameters or body hold `offset`, through blocks (they share its `self`). */
  defAt(offset: number): RubyScope | undefined;
}

const memo = new WeakMap<LexResult, RubyFacts>();

export function rubyFacts(lx: LexResult, blocks?: BraceBlock[]): RubyFacts {
  let facts = memo.get(lx);
  if (!facts) {
    facts = compute(lx, blocks ?? scanRubyBlocks(lx.text));
    memo.set(lx, facts);
  }
  return facts;
}

const isBlank = (c: string): boolean => c === ' ' || c === '\t';

/** The first code offset at or after `i` that is not blank (newlines kept), else the text length. */
function nextCodeOnLine(lx: LexResult, i: number): number {
  const text = lx.text;
  while (i < text.length && isBlank(text[i])) i++;
  return i;
}

/** Past blanks, and past one line break when the line ends there. */
function nextCodeOnLineOrNext(lx: LexResult, i: number): number {
  const text = lx.text;
  let j = nextCodeOnLine(lx, i);
  if (text[j] === '\r') j++;
  if (text[j] === '\n') j = nextCodeOnLine(lx, j + 1);
  return j;
}

/** The code bracket closing the one at `open`, else -1. */
function closingBracket(lx: LexResult, open: number): number {
  const text = lx.text;
  const P = lx.punct;
  let depth = 0;
  for (let k = lx.punctFrom(open); k < P.length; k++) {
    const c = text[P[k]];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return P[k];
  }
  return -1;
}

/** The previous non-blank char on the same line, or -1. */
function prevOnLine(text: string, offset: number): number {
  let p = offset - 1;
  while (p >= 0 && isBlank(text[p])) p--;
  return p >= 0 && text[p] !== '\n' ? p : -1;
}

/** `.name`, `&.name`, `::name`, across a line break: a method or constant on a receiver. */
function memberPosition(lx: LexResult, offset: number): boolean {
  const text = lx.text;
  const p = lx.prevSignificant(offset);
  return p >= 0 && lx.spanAt(p) === undefined && ((text[p] === '.' && text[p - 1] !== '.') || (text[p] === ':' && text[p - 1] === ':'));
}

/** Length of an assignment operator at `j`: `=`, `+=`, `||=`, `<<=` …; 0 for `==`, `=~`, `=>`, `<=`, `>=`, `!=`. */
export function assignAt(text: string, j: number): number {
  const c = text[j];
  if (c === '=') return text[j + 1] === '=' || text[j + 1] === '~' || text[j + 1] === '>' ? 0 : 1;
  for (const op of ['**=', '||=', '&&=', '<<=', '>>=', '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=']) {
    if (text.startsWith(op, j)) return op.length;
  }
  return 0;
}

/** A label `name:` (not `name::`), and whether it is shorthand for `name: name` (nothing follows but `,` `}` `)` or a line end). */
function labelAt(lx: LexResult, id: LexId): 'none' | 'key' | 'shorthand' {
  const text = lx.text;
  const n = id.offset + id.length;
  if (text[n] !== ':' || text[n + 1] === ':') return 'none';
  const k = nextCodeOnLine(lx, n + 1);
  const c = text[k];
  return k >= text.length || c === ',' || c === '}' || c === ')' || c === '\n' || c === '\r' || c === '|' || c === ']'
    || (c === '#' && lx.spanAt(k)?.region === 'comment') ? 'shorthand' : 'key';
}

function innermost(starts: number[], ends: number[]): IntervalIndex {
  return buildIntervalIndex(starts, ends, (a, b) => starts[b] - starts[a] || a - b);
}

/**
 * Identifier offsets that are parameter names in a list from `start` to `end`:
 * `a`, `b = expr`, `*c`, `**d`, `&e`, `f:`, `g: expr`, `(h, i)`, and block-locals after `;`.
 */
function paramNames(lx: LexResult, start: number, end: number): number[] {
  const text = lx.text;
  const out: number[] = [];
  const ids = lx.identsIn(start, end);
  let k = 0;
  let expecting = true;
  let exprDepth = -1;
  let depth = 0;
  for (let i = start; i < end; i++) {
    if (!lx.isCode(i)) {
      const s = lx.spanAt(i);
      if (s) {
        i = s.end - 1;
        if (exprDepth < 0 && s.region === 'string') expecting = false;
        continue;
      }
    }
    while (k < ids.length && ids[k].offset < i) k++;
    const c = text[i];
    if (k < ids.length && ids[k].offset === i) {
      const id = ids[k];
      if (exprDepth < 0 && expecting && /^[a-z_]/.test(id.name) && !RUBY_KEYWORDS.has(id.name)) {
        out.push(id.offset);
        const j = nextCodeOnLine(lx, id.offset + id.length);
        if ((text[j] === '=' && assignAt(text, j) === 1) || (text[j] === ':' && text[j + 1] !== ':' && j === id.offset + id.length)) {
          exprDepth = depth;
        }
      }
      expecting = false;
      i = id.offset + id.length - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      if (exprDepth < 0) expecting = c === '(';
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      continue;
    }
    if (exprDepth >= 0) {
      if ((c === ',' || c === ';' || c === '|') && depth === exprDepth) {
        exprDepth = -1;
        expecting = true;
      }
      continue;
    }
    if (c === ',' || c === ';' || c === '|' || c === '*' || c === '&') expecting = true;
  }
  return out;
}

/** The pattern of an `in` branch, `[after in, guard or then)`: its bare names are captures, `^x` reads. */
function patternCaptures(lx: LexResult, start: number, end: number, out: Set<number>, pins: Set<number>): void {
  const text = lx.text;
  for (const id of lx.identsIn(start, end)) {
    if (id.name === 'if' || id.name === 'unless') return;
    if (!/^[a-z_]/.test(id.name) || RUBY_KEYWORDS.has(id.name) || memberPosition(lx, id.offset)) continue;
    const p = prevOnLine(text, id.offset);
    if (p >= 0 && text[p] === '^') {
      pins.add(id.offset);
      continue;
    }
    const lab = labelAt(lx, id);
    if (lab === 'key') continue;
    const open = lx.enclosingOpen(id.offset);
    if (open >= 0 && open >= start && text[open] === '(' && text[open - 1] === '^') continue;
    const j = nextCodeOnLine(lx, id.offset + id.length);
    if (text[j] === '(' || text[j] === '.') continue;
    out.add(id.offset);
  }
}

/** `a, b = …`, `a, (b, c) = …`, `*a, b = …` starting at a statement: the plain names are targets. */
function multiTargets(lx: LexResult, at: number): number[] | null {
  const text = lx.text;
  let le = text.indexOf('\n', at);
  if (le < 0) le = text.length;
  const eq = text.indexOf('=', at);
  if ((eq < 0 || eq > le) && !/,\s*$/.test(text.slice(at, le))) return null;
  let head = '';
  for (const line of text.slice(at, at + 2000).split('\n')) {
    head += line;
    if (!/,\s*$/.test(line)) break;
    head += '\n';
  }
  const m = /^[\w@$*(),.\s\[\]:'"?!]*?(?<![=!<>+\-*/%&|^~])=(?![=~>])/.exec(head);
  if (!m || !m[0].includes(',')) return null;
  const end = at + m[0].length - 1;
  const out: number[] = [];
  let depth = 0;
  for (let i = at; i < end; i++) {
    const c = text[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  if (depth !== 0) return null;
  for (const id of lx.identsIn(at, end)) {
    if (memberPosition(lx, id.offset) || !/^[a-z_$@]/.test(id.name) || RUBY_KEYWORDS.has(id.name)) continue;
    const n = text[id.offset + id.length];
    if (n === '.' || n === '[' || n === '(') continue;
    const open = lx.enclosingOpen(id.offset);
    if (open >= at && text[open] === '[') continue;
    out.push(id.offset);
  }
  return out;
}

/** Does a statement start at `offset` (line start, after `;`, `then`, `do`, `|params|`, `{`)? */
function statementStart(lx: LexResult, offset: number): boolean {
  const text = lx.text;
  const p = lx.prevSignificant(offset);
  if (p < 0) return true;
  const c = text[p];
  if (text.slice(p + 1, offset).includes('\n')) return c !== '\\' && c !== ',';
  if (c === ';' || c === '{' || c === '|' || c === '(') return true;
  if (/\w/.test(c)) {
    let w = p;
    while (w >= 0 && /\w/.test(text[w])) w--;
    const word = text.slice(w + 1, p + 1);
    return word === 'then' || word === 'do' || word === 'else' || word === 'begin' || word === 'ensure';
  }
  return false;
}

function compute(lx: LexResult, blocks: BraceBlock[]): RubyFacts {
  const text = lx.text;
  const ids = lx.idents;
  const declSites = new Set<number>();
  const writeSites = new Set<number>();
  const binding = new Map<number, number>();
  const decls = new Map<number, RubyDecl>();
  const shorthands = new Set<number>();
  const globalSites = new Set<number>();

  const fileScope: RubyScope = { kind: 'file', start: 0, end: text.length };
  const scopes: RubyScope[] = [];
  const params = new Set<number>();
  const defNames = new Set<number>();
  const captures = new Set<number>();
  const pins = new Set<number>();
  const forVars = new Set<number>();
  const sorted = [...blocks].sort((a, b) => a.openOffset - b.openOffset || b.closeOffset - a.closeOffset);
  for (const b of sorted) {
    const kind = rubyBlockKind(text, b);
    const header = text.slice(b.headerStart, b.openOffset);
    if (kind === 'def') {
      const name = rubyDefName(text, b.headerStart);
      if (name) {
        defNames.add(name.offset);
        for (const o of paramNames(lx, name.offset + name.name.length, b.openOffset)) params.add(o);
      }
      scopes.push({ kind: 'def', start: name ? name.offset + name.name.length : b.headerStart, end: b.closeOffset, block: b, name: name?.name });
    } else if (kind === 'class') {
      scopes.push({ kind: 'class', start: b.headerStart, end: b.closeOffset, block: b });
    } else if (kind === 'block') {
      const bar = header.indexOf('|');
      const arrow = header.startsWith('->');
      if (bar >= 0) for (const o of paramNames(lx, b.headerStart + bar + 1, b.openOffset - 1)) params.add(o);
      else if (arrow) {
        const lp = header.indexOf('(');
        const open = header.search(/[{]|\bdo\b/);
        const ps = lp >= 0 && (open < 0 || lp < open) ? b.headerStart + lp + 1 : b.headerStart + 2;
        const pe = lp >= 0 && (open < 0 || lp < open) ? b.headerStart + header.indexOf(')') : b.headerStart + (open < 0 ? header.length : open);
        for (const o of paramNames(lx, ps, pe)) params.add(o);
      }
      scopes.push({ kind: 'block', start: b.headerStart, end: b.closeOffset, block: b });
    } else if (/^in\b/.test(header)) {
      patternCaptures(lx, b.headerStart + 2, b.openOffset, captures, pins);
    } else if (/^for\b/.test(header)) {
      for (const id of lx.identsIn(b.headerStart + 3, b.openOffset)) {
        if (id.name === 'in') break;
        if (/^[a-z_]/.test(id.name)) forVars.add(id.offset);
      }
    } else if (/^rescue\b/.test(header)) {
      const arrow = header.indexOf('=>');
      if (arrow >= 0) {
        const id = lx.identsIn(b.headerStart + arrow + 2, b.openOffset)[0];
        if (id && /^[a-z_]/.test(id.name)) forVars.add(id.offset);
      }
    }
  }
  // `expr => pattern` and `expr in pattern` on one line: the pattern binds.
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    if (id.name !== 'in' || memberPosition(lx, id.offset) || statementStart(lx, id.offset)) continue;
    const head = lx.identsIn(lx.lineStarts[lx.lineOf(id.offset)], id.offset)[0];
    if (!head || head.name === 'for' || head.name === 'when' || head.name === 'in') continue;
    const le = text.indexOf('\n', id.offset);
    patternCaptures(lx, id.offset + 2, le < 0 ? text.length : le, captures, pins);
  }

  for (let i = text.indexOf('=>'); i >= 0; i = text.indexOf('=>', i + 2)) {
    if (!lx.isCode(i) || lx.enclosingOpen(i) >= 0) continue;
    const j = nextCodeOnLineOrNext(lx, i + 2);
    if (text[j] !== '{' && text[j] !== '[') continue;
    const head = lx.identsIn(lx.lineStarts[lx.lineOf(i)], i)[0];
    if (head && (head.name === 'rescue' || head.name === 'when' || head.name === 'in')) continue;
    if (head && commandCall(lx, head, nextCodeOnLine(lx, head.offset + head.length))) continue;
    const close = closingBracket(lx, j);
    if (close > j) patternCaptures(lx, j, close + 1, captures, pins);
  }
  // `/(?<name>…)/ =~ s` binds `name`; a regex with interpolation binds nothing.
  const regexCaptures: { at: number; names: { name: string; offset: number }[] }[] = [];
  for (let k = 0; k < lx.spans.length; k++) {
    const sp = lx.spans[k];
    if (sp.region !== 'string' || (text[sp.start] !== '/' && !text.startsWith('%r', sp.start))) continue;
    if (k + 1 < lx.spans.length && lx.spans[k + 1].start === sp.end) continue;
    const j = nextCodeOnLine(lx, sp.end);
    if (!text.startsWith('=~', j)) continue;
    const body = text.slice(sp.start, sp.end);
    if (body.includes('#{')) continue;
    const names: { name: string; offset: number }[] = [];
    for (const m of body.matchAll(/\(\?<([A-Za-z_]\w*)>/g)) names.push({ name: m[1], offset: sp.start + m.index! + 3 });
    if (names.length > 0) regexCaptures.push({ at: j, names });
  }
  let rc = 0;
  const scopeIndex = innermost(scopes.map((s) => s.start), scopes.map((s) => s.end + 1));
  const scopeAt = (offset: number): RubyScope => {
    const k = bestAt(scopeIndex, offset);
    return k < 0 ? fileScope : scopes[k];
  };
  const chain: RubyScope[] = [];
  for (const s of [...scopes].sort((a, b) => a.start - b.start || b.end - a.end)) {
    while (chain.length > 0 && chain[chain.length - 1].end < s.start) chain.pop();
    s.parent = chain.length > 0 ? chain[chain.length - 1] : fileScope;
    chain.push(s);
  }
  const defs = scopes.filter((s) => s.kind === 'def');
  const defIndex = innermost(defs.map((s) => s.start), defs.map((s) => s.end + 1));
  const defAt = (offset: number): RubyScope | undefined => {
    let s: RubyScope | undefined = scopeAt(offset);
    while (s && s.kind === 'block') s = s.parent;
    if (s && s.kind === 'def') return s;
    const k = bestAt(defIndex, offset);
    return k < 0 ? undefined : defs[k];
  };

  // Per scope, the names declared so far.
  const tables = new Map<RubyScope, Map<string, number>>();
  const tableOf = (s: RubyScope): Map<string, number> => {
    let t = tables.get(s);
    if (!t) {
      t = new Map();
      tables.set(s, t);
    }
    return t;
  };
  const lookup = (name: string, at: RubyScope): number | undefined => {
    for (let s: RubyScope | undefined = at; s; s = s.parent) {
      const d = tables.get(s)?.get(name);
      if (d !== undefined) return d;
      if (s.kind !== 'block') return undefined;
    }
    return undefined;
  };
  const declare = (id: LexId, scope: RubyScope, kind: RubyDecl['kind']): void => {
    tableOf(scope).set(id.name, id.offset);
    declSites.add(id.offset);
    writeSites.add(id.offset);
    binding.set(id.offset, id.offset);
    decls.set(id.offset, { offset: id.offset, name: id.name, kind, scope });
  };
  const write = (id: LexId, scope: RubyScope): void => {
    const d = lookup(id.name, scope);
    if (d === undefined) {
      declare(id, scope, 'local');
    } else {
      binding.set(id.offset, d);
      writeSites.add(id.offset);
    }
  };
  const multi = new Set<number>();

  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    const name = id.name;
    const c0 = name.charCodeAt(0);
    for (; rc < regexCaptures.length && regexCaptures[rc].at < id.offset; rc++) {
      const sc = scopeAt(regexCaptures[rc].at);
      for (const n of regexCaptures[rc].names) {
        if (lookup(n.name, sc) !== undefined) continue;
        tableOf(sc).set(n.name, n.offset);
        decls.set(n.offset, { offset: n.offset, name: n.name, kind: 'local', scope: sc });
      }
    }
    if (!multi.has(id.offset) && text[nextCodeOnLine(lx, id.offset + id.length)] === ',') {
      const p = prevOnLine(text, id.offset);
      const at = p >= 0 && (text[p] === '*' || text[p] === '(') && statementStart(lx, p) ? p : statementStart(lx, id.offset) ? id.offset : -1;
      const targets = at >= 0 ? multiTargets(lx, at) : null;
      if (targets) for (const o of targets) multi.add(o);
    }
    if (c0 === 36) {
      if (!rubyUserGlobal(name)) continue;
      binding.set(id.offset, -1);
      const j = nextCodeOnLine(lx, id.offset + id.length);
      if (assignAt(text, j) > 0 || multi.has(id.offset)) {
        writeSites.add(id.offset);
        const sk = scopeAt(id.offset).kind;
        if (sk === 'file' || sk === 'class') globalSites.add(id.offset);
      }
      continue;
    }
    if (c0 === 64 || defNames.has(id.offset) || RUBY_KEYWORDS.has(name) || !/^[a-z_\u0080-￿]/.test(name)) continue;
    if (name.endsWith('?') || name.endsWith('!')) continue;
    if (memberPosition(lx, id.offset)) continue;
    const prev = ids[k - 1];
    if (prev && (prev.name === 'alias' || prev.name === 'undef') && !defNames.has(prev.offset) && /^[ \t]+$/.test(text.slice(prev.offset + prev.length, id.offset))) {
      if (prev.name === 'alias') k++;
      continue;
    }
    const scope = scopeAt(id.offset);
    if (params.has(id.offset)) {
      declare(id, scope, 'param');
      continue;
    }
    if (captures.has(id.offset) || forVars.has(id.offset)) {
      write(id, scope);
      continue;
    }
    if (pins.has(id.offset)) {
      const d = lookup(name, scope);
      if (d !== undefined) binding.set(id.offset, d);
      continue;
    }
    const lab = labelAt(lx, id);
    if (lab !== 'none') {
      if (lab === 'shorthand') {
        const d = lookup(name, scope);
        if (d !== undefined) {
          binding.set(id.offset, d);
          shorthands.add(id.offset);
        }
      }
      continue;
    }
    const j = nextCodeOnLine(lx, id.offset + id.length);
    if (text[j] === '(' && j === id.offset + id.length) continue;
    if (multi.has(id.offset) || assignAt(text, j) > 0) {
      write(id, scope);
      continue;
    }
    const d = lookup(name, scope);
    if (d !== undefined && !commandCall(lx, id, j)) {
      binding.set(id.offset, d);
      continue;
    }
    // `_1` … `_9` and a bare `it` read a block's implicit parameter.
    if (scope.kind === 'block' && (/^_[1-9]$/.test(name) || (name === 'it' && implicitIt(lx, id, scope)))) {
      declare(id, scope, 'implicit');
    }
  }

  return { declSites, writeSites, binding, decls, shorthands, multi, globalSites, scopeAt, defAt };
}

/** `name arg`: a blank, then an argument (a literal, a name that is not a keyword, a number). A local is never called so. */
function commandCall(lx: LexResult, id: LexId, j: number): boolean {
  const text = lx.text;
  if (j === id.offset + id.length || j >= text.length || text[j] === '}') return false;
  const s = lx.spanAt(j);
  if (s !== undefined) return s.start === j && s.region === 'string' && !(text[j] === '/' && /\s/.test(text[j + 1] ?? ''));
  const c = text[j];
  if (/[0-9]/.test(c)) return true;
  if (/[A-Za-z_@$]/.test(c)) {
    const w = /^[A-Za-z_@$][\w]*[?!]?/.exec(text.slice(j, j + 64))![0];
    return !RUBY_KEYWORDS.has(w) || w === 'self' || w === 'nil' || w === 'true' || w === 'false';
  }
  return false;
}

/** `it` reads the block's implicit parameter when the block declares none and `it` takes no argument. */
function implicitIt(lx: LexResult, id: LexId, scope: RubyScope): boolean {
  const text = lx.text;
  const b = scope.block;
  if (!b || text.slice(b.headerStart, b.openOffset).includes('|')) return false;
  const j = nextCodeOnLine(lx, id.offset + id.length);
  if (commandCall(lx, id, j)) return false;
  const c = text[j] ?? '';
  if (c === '' || c === '\n' || c === '\r' || c === '.' || c === ')' || c === ',' || c === '}' || c === ']' || c === ';') return true;
  if (j === id.offset + id.length) return !/[("'{]/.test(c);
  return /^(?:[-+*/%<>=!&|^]=?|\*\*|<<|>>|&&|\|\||==|!=|\?|:(?!:))/.test(text.slice(j, j + 3)) && !/^[-+*:]\S/.test(text.slice(j, j + 2));
}

/**
 * The tokens a classification of `lx` reads: ruby-lsp's `variable` and `parameter`
 * reads that are data here, plus every declaration and write site, which ruby-lsp
 * leaves without a token, and the user globals it does not type.
 */
export function rubyTokens(lx: LexResult, tokens: readonly DecodedToken[]): DecodedToken[] {
  const f = rubyFacts(lx);
  const out: DecodedToken[] = [];
  const seen = new Set<number>();
  for (const t of tokens) {
    if ((t.type === 'variable' || t.type === 'parameter') && f.binding.has(t.offset)) {
      seen.add(t.offset);
      out.push(f.declSites.has(t.offset) && !t.modifiers.includes('declaration') ? { ...t, modifiers: [...t.modifiers, 'declaration'] } : t);
    }
  }
  for (const id of lx.idents) {
    if (seen.has(id.offset) || !f.binding.has(id.offset)) continue;
    const decl = f.declSites.has(id.offset) || f.globalSites.has(id.offset);
    // A global's tint covers its name; the theme keeps the `$` sigil at its own register.
    const sigil = id.name.startsWith('$') ? 1 : 0;
    out.push({
      name: id.name,
      offset: id.offset + sigil,
      length: id.length - sigil,
      type: f.decls.get(f.binding.get(id.offset)!)?.kind === 'param' ? 'parameter' : 'variable',
      modifiers: decl ? ['declaration'] : [],
    });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

type Spans = { start: number; end: number }[];

/** `x.self` and `Foo::self` call a method named `self`, and `self:` is a hash key; neither is the keyword. */
export function rubyKeywordSelf(lx: LexResult, id: LexId): boolean {
  return !memberPosition(lx, id.offset) && labelAt(lx, id) === 'none';
}

/** Band 1: the data uses of a local or parameter named like a Kernel method the grammar paints (`p`, `format`, `test`), at the page colour. */
export function rubyShadowSpans(lx: LexResult): Spans {
  const f = rubyFacts(lx);
  const out: Spans = [];
  for (const id of lx.idents) {
    if (!RUBY_GRAMMAR_BUILTINS.has(id.name)) continue;
    const d = f.binding.get(id.offset);
    if (d === undefined || d < 0 || f.shorthands.has(id.offset)) continue;
    out.push({ start: id.offset, end: id.offset + id.length });
  }
  return out;
}

/** `initialize` and the copy hooks set up an object nothing else holds yet. */
const RUBY_INITIALIZERS = new Set(['initialize', 'initialize_copy', 'initialize_dup', 'initialize_clone']);

interface RubyTarget {
  root: LexId;
  /** End of the last member name, or of the root. */
  nameEnd: number;
  /** Offset just past the target. */
  end: number;
  chained: boolean;
}

/** `root`, `root.a.b`, `root&.a`, `root[k]`, `root::a`; a call with arguments in the chain: null. */
function rubyTarget(lx: LexResult, ids: LexId[], k: number): RubyTarget | null {
  const text = lx.text;
  const root = ids[k];
  let end = root.offset + root.length;
  let nameEnd = end;
  let chained = false;
  let next = k + 1;
  for (;;) {
    let j = end;
    while (text[j] === ' ' || text[j] === '\t') j++;
    if (text[j] === '&' && text[j + 1] === '.') j++;
    if (text[j] === '.' && text[j + 1] !== '.') {
      j++;
      while (text[j] === ' ' || text[j] === '\t') j++;
      const id = ids[next];
      if (!id || id.offset !== j || /[?!]$/.test(id.name)) return null;
      end = nameEnd = id.offset + id.length;
      chained = true;
      next++;
      continue;
    }
    if (text[j] === '[' && j === end && lx.isCode(j)) {
      const close = closingBracket(lx, j);
      if (close < 0) return null;
      end = close + 1;
      chained = true;
      while (next < ids.length && ids[next].offset < close) next++;
      continue;
    }
    if (text[j] === '(' && j === end) return null;
    return { root, nameEnd, end, chained };
  }
}

/**
 * Ruby writes that escape the focused block (docs/ruby.md#escape-marks): a local
 * declared outside it, which from a block is a closure capture; a member of a
 * parameter, of an outer local, or of `self` / `@x` outside an initializer; an
 * `@x` outside an initializer; an `@@x` inside a method; a `$x` inside a method,
 * class or block.
 */
export function rubyEscapeRisk(
  lx: LexResult,
  block: { start: number; end: number },
  regions: { start: number; end: number }[],
  blocks: BraceBlock[],
): { start: number; end: number }[] {
  const text = lx.text;
  const f = rubyFacts(lx, blocks);
  const out: { start: number; end: number }[] = [];
  const marked = new Set<number>();
  const initializer = (offset: number): boolean => {
    const d = f.defAt(offset);
    return d !== undefined && RUBY_INITIALIZERS.has(d.name ?? '');
  };
  const inMethod = (offset: number): boolean => f.defAt(offset) !== undefined;
  const outside = (o: number): boolean => o < block.start || o >= block.end;
  const branchSibling = (d: number): boolean => rubySiblingBranch(lx, blocks, d, block);
  const mark = (t: RubyTarget): void => {
    if (marked.has(t.root.offset)) return;
    marked.add(t.root.offset);
    out.push({ start: t.root.offset, end: t.chained ? t.nameEnd : t.root.offset + t.root.length });
  };
  for (const region of regions) {
    const ids = lx.identsIn(region.start, region.end);
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      if (memberPosition(lx, id.offset) || f.shorthands.has(id.offset)) continue;
      const t = rubyTarget(lx, ids, k);
      if (!t) continue;
      const j = nextCodeOnLine(lx, t.end);
      const written = assignAt(text, j) > 0 || (!t.chained && f.multi.has(id.offset));
      if (!written) continue;
      const name = id.name;
      let hit = false;
      if (name.startsWith('@@')) {
        hit = inMethod(id.offset);
      } else if (name.startsWith('@') || name === 'self') {
        hit = inMethod(id.offset) && !initializer(id.offset);
      } else if (name.startsWith('$')) {
        hit = f.scopeAt(id.offset).kind !== 'file';
      } else {
        const d = f.binding.get(id.offset);
        if (d === undefined || d < 0) continue;
        if (t.chained) {
          hit = outside(d) || f.decls.get(d)?.kind === 'param';
        } else {
          hit = !f.declSites.has(id.offset) && outside(d) && !branchSibling(d);
        }
      }
      if (hit) mark(t);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const RUBY_BRANCH = /^(if|elsif|else|unless|when|in|begin|rescue|ensure)\b/;

/** Is the declaration at `d` in an earlier branch of the same conditional as the focused branch `focused`? */
function rubySiblingBranch(lx: LexResult, blocks: BraceBlock[], d: number, focused: { start: number; end: number }): boolean {
  const text = lx.text;
  const own = blocks.find((b) => (b.openOffset === focused.start || b.headerStart === focused.start)
    && RUBY_BRANCH.test(text.slice(b.headerStart, b.headerStart + 7)));
  if (!own) return false;
  // walk back through the branches that chain into this one
  let cur = own;
  for (;;) {
    const p = lx.prevSignificant(cur.headerStart);
    const prev = blocks.find((b) => b.depth === cur.depth && b.closeOffset === p && RUBY_BRANCH.test(text.slice(b.headerStart, b.headerStart + 7)));
    if (!prev) return false;
    if (d >= prev.headerStart && d <= prev.closeOffset) return true;
    cur = prev;
  }
}
