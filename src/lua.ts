/**
 * Lua bindings over the shared lexer and the keyword block scan: which
 * identifier declares a local, which declaration each name resolves to, and the
 * names that are modules or namespaces rather than data. Rules: docs/lua.md.
 */

import { LexId, LexResult } from './lex';
import { BraceBlock, functionScopeOf, scanLuaBlocks } from './focus';
import { IntervalIndex, bestAt, buildIntervalIndex } from './intervals';

export const LUA_KEYWORDS: ReadonlySet<string> = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);

/** Lua 5.1-5.4 and LuaJIT standard globals. */
export const LUA_STD: ReadonlySet<string> = new Set([
  '_G', '_VERSION', 'arg', 'assert', 'bit', 'collectgarbage', 'coroutine', 'debug', 'dofile', 'error', 'gcinfo',
  'getfenv', 'getmetatable', 'io', 'ipairs', 'jit', 'load', 'loadfile', 'loadstring', 'math', 'module', 'newproxy',
  'next', 'os', 'package', 'pairs', 'pcall', 'print', 'rawequal', 'rawget', 'rawlen', 'rawset', 'require', 'select',
  'setfenv', 'setmetatable', 'string', 'table', 'tonumber', 'tostring', 'type', 'unpack', 'utf8', 'warn', 'xpcall',
]);

/** The 28 names VS Code's Lua grammar scopes `support.function.lua` wherever they are not assigned or a member. */
export const LUA_GRAMMAR_BUILTINS: ReadonlySet<string> = new Set([
  'assert', 'collectgarbage', 'dofile', 'error', 'getfenv', 'getmetatable', 'ipairs', 'load', 'loadfile',
  'loadstring', 'module', 'next', 'pairs', 'pcall', 'print', 'rawequal', 'rawget', 'rawlen', 'rawset', 'require',
  'select', 'setfenv', 'setmetatable', 'tonumber', 'tostring', 'type', 'unpack', 'xpcall',
]);

export interface LuaDecl {
  offset: number;
  name: string;
  /** First offset the binding is visible at. */
  from: number;
  /** Last offset of its scope. */
  to: number;
  kind: 'local' | 'param' | 'for' | 'function';
  /** The code of a one-name `local x = …` right-hand side, trimmed. */
  rhs?: string;
}

export interface LuaFunction {
  headerStart: number;
  /** The `(` of the parameter list. */
  params: number;
  body: BraceBlock;
}

export interface LuaFacts {
  /** Offsets of identifiers that declare a local, parameter or loop variable. */
  declSites: Set<number>;
  /** `local function f`, `local f = function`, and `local type = type` aliases of a standard global. */
  functionSites: Set<number>;
  /** Per identifier in a binding position: the declaration offset it resolves to, -1 for a global. */
  binding: Map<number, number>;
  decls: Map<number, LuaDecl>;
  /** Declarations bound by `local m = require <string>`. */
  modules: Set<number>;
  /** Globals the file never assigns whose every use is `name.`, `name:` or `name[`. */
  namespaces: Set<string>;
  /** Statement-start assignments to an undeclared name outside every function: they define the global. */
  globalSites: Set<number>;
  globalNames: Set<string>;
  /** The innermost function whose parameter list or body holds `offset`. */
  functionAt(offset: number): LuaFunction | undefined;
}

const memo = new WeakMap<LexResult, LuaFacts>();

export function luaFacts(lx: LexResult, blocks?: BraceBlock[]): LuaFacts {
  let facts = memo.get(lx);
  if (!facts) {
    facts = compute(lx, blocks ?? scanLuaBlocks(lx.text));
    memo.set(lx, facts);
  }
  return facts;
}

/** A member (`a.b`, `a:b`) or a label (`goto x`, `::x::`): no binding. */
export function luaNonBindingPosition(lx: LexResult, id: LexId): boolean {
  return nonBinding(lx.text, prevCode(lx, id.offset), nextCode(lx, id.offset + id.length));
}

/** A table-constructor key: `{ name = …`, `, name = …` or `; name = …` directly inside `{`. */
export function luaTableKey(lx: LexResult, id: LexId): boolean {
  return tableKey(lx, id, prevCode(lx, id.offset), nextCode(lx, id.offset + id.length));
}

/** `nonBinding` and `tableKey` take the code chars around the identifier: `p` before it, `n` after it. */
function nonBinding(text: string, p: number, n: number): boolean {
  if (p >= 0) {
    const c = text[p];
    if ((c === '.' || c === ':') && text[p - 1] !== c) return true;
    if (p >= 3 && text.startsWith('goto', p - 3) && !WORD.test(text[p - 4] ?? '')) return true;
  }
  return text[n] === ':' && text[n + 1] === ':';
}

function tableKey(lx: LexResult, id: LexId, p: number, n: number): boolean {
  const text = lx.text;
  if (text[n] !== '=' || text[n + 1] === '=') return false;
  if (p < 0 || (text[p] !== '{' && text[p] !== ',' && text[p] !== ';')) return false;
  const open = lx.enclosingOpen(id.offset);
  return open >= 0 && text[open] === '{';
}

/** A callee: `f(`, `f "s"`, `f 's'`, `f {`, `f [[s]]`. */
export function luaCallee(lx: LexResult, id: LexId): boolean {
  const text = lx.text;
  const n = nextCode(lx, id.offset + id.length);
  const c = text[n];
  return c === '(' || c === '{' || ((c === '"' || c === "'" || c === '[') && lx.spanAt(n)?.start === n);
}

/**
 * The first offset at or after `i`, a code offset, that is neither blank nor in a
 * comment, else the text length. From code, only `--` starts a comment.
 */
function nextCode(lx: LexResult, i: number): number {
  const text = lx.text;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c !== '-' || text[i + 1] !== '-') return i;
    const s = lx.spanAt(i);
    if (s?.region !== 'comment') return i;
    i = s.end;
  }
  return text.length;
}

/**
 * `lx.prevSignificant(offset)` for `offset` at a code identifier. A comment that
 * ends on the identifier's own line is a long one, ending in `]`.
 */
function prevCode(lx: LexResult, offset: number): number {
  const text = lx.text;
  let p = offset - 1;
  while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) p--;
  return p >= 0 && text[p] !== '\n' && text[p] !== '\r' && text[p] !== ']' ? p : lx.prevSignificant(offset);
}

const WORD = /\w/;
/** A whole `<name>` on one line; a half-typed one ends the name list. */
const ATTRIBUTE = /<[ \t]*[A-Za-z_]\w*[ \t]*>/y;
const OPERATOR_BEFORE = /[=,(+\-*/%^<>~&|.{[#]/;
const EXPRESSION_BEFORE = new Set(['and', 'or', 'not', 'local', 'return', 'in', 'until', 'if', 'elseif', 'while', 'function', 'goto']);
const STATEMENT_BEFORE = new Set(['then', 'do', 'else', 'end', 'repeat']);

/** The word ending at `p`, or ''. */
function wordEndingAt(text: string, p: number): string {
  let w = p;
  while (w >= 0 && WORD.test(text[w])) w--;
  return text.slice(w + 1, p + 1);
}

/** Does a statement start at `id`, whose previous code char is at `p`? */
function statementStart(lx: LexResult, id: LexId, p: number): boolean {
  const text = lx.text;
  if (p < 0 || text[p] === ';' || (text[p] === ':' && text[p - 1] === ':')) return true;
  const word = wordEndingAt(text, p);
  if (STATEMENT_BEFORE.has(word)) return true;
  if (!text.slice(p, id.offset).includes('\n') || OPERATOR_BEFORE.test(text[p])) return false;
  return !EXPRESSION_BEFORE.has(word);
}

/** Intervals [starts[i], ends[i]) where the latest-starting one covering an offset wins. */
function innermost(starts: number[], ends: number[]): IntervalIndex {
  return buildIntervalIndex(starts, ends, (a, b) => starts[b] - starts[a] || a - b);
}

/** `require "m"`, `require("m")` or `require [[m]]`, and nothing else, in [start, end). */
function requiresModule(lx: LexResult, start: number, end: number): boolean {
  const text = lx.text;
  let i = nextCode(lx, start);
  if (!text.startsWith('require', i) || WORD.test(text[i + 7] ?? '')) return false;
  i = nextCode(lx, i + 7);
  const paren = text[i] === '(';
  if (paren) i = nextCode(lx, i + 1);
  const s = lx.spanAt(i);
  if (s?.region !== 'string' || s.start !== i) return false;
  i = nextCode(lx, s.end);
  if (paren) {
    if (text[i] !== ')') return false;
    i = nextCode(lx, i + 1);
  }
  return i >= end;
}

function compute(lx: LexResult, blocks: BraceBlock[]): LuaFacts {
  const text = lx.text;
  const ids = lx.idents;
  const declSites = new Set<number>();
  const functionSites = new Set<number>();
  const decls = new Map<number, LuaDecl>();
  const modules = new Set<number>();
  const globalSites = new Set<number>();
  const globalNames = new Set<string>();

  const sorted = [...blocks].sort((a, b) => a.openOffset - b.openOffset);
  const scopes = innermost(sorted.map((b) => b.openOffset), sorted.map((b) => b.closeOffset + 1));
  const scopeEnd = (offset: number): number => {
    const k = bestAt(scopes, offset);
    return k < 0 ? text.length : sorted[k].closeOffset;
  };
  const fns: LuaFunction[] = [];
  for (const b of sorted) {
    const fn = functionScopeOf(text, b, 'lua');
    if (fn) fns.push({ headerStart: b.headerStart, params: fn.start, body: b });
  }
  const fnIndex = innermost(fns.map((f) => f.params), fns.map((f) => f.body.closeOffset + 1));
  const functionAt = (offset: number): LuaFunction | undefined => {
    const k = bestAt(fnIndex, offset);
    return k < 0 ? undefined : fns[k];
  };
  const loops = new Map<number, BraceBlock>();
  for (const b of sorted) loops.set(b.headerStart, b);
  const byHeader = [...sorted].sort((a, b) => a.headerStart - b.headerStart);

  /** Does the expression list go on past the line end at `nl`: nothing after `=` yet, or a trailing operator? */
  const continues = (from: number, nl: number): boolean => {
    const p = lx.prevSignificant(nl);
    if (p < from) return true;
    if (lx.spanAt(p) !== undefined) return false;
    const c = text[p];
    if (c === '.') return text[p - 1] === '.';
    const word = wordEndingAt(text, p);
    return word === '' ? OPERATOR_BEFORE.test(c) : word === 'and' || word === 'or' || word === 'not';
  };

  /** End of the expression list a `local … =` assigns: its line, extended over open brackets, blocks and trailing operators. */
  const statementEnd = (from: number): number => {
    const P = lx.punct;
    let end = from;
    let depth = 0;
    let k = lx.punctFrom(from);
    for (;;) {
      let nl = text.indexOf('\n', end);
      if (nl < 0) nl = text.length;
      for (; k < P.length && P[k] < nl; k++) {
        const c = text[P[k]];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      }
      let lo = 0;
      let hi = byHeader.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (byHeader[mid].headerStart < end) lo = mid + 1;
        else hi = mid;
      }
      let blockEnd = -1;
      for (let j = lo; j < byHeader.length && byHeader[j].headerStart < nl; j++) {
        if (byHeader[j].closeOffset >= nl) blockEnd = Math.max(blockEnd, byHeader[j].closeOffset);
      }
      if (blockEnd >= 0) {
        end = blockEnd + 1;
        k = lx.punctFrom(end);
        continue;
      }
      if (nl >= text.length || (depth === 0 && !continues(from, nl))) return nl;
      end = nl + 1;
    }
  };

  const add = (id: LexId, kind: LuaDecl['kind'], from: number, to: number, rhs?: string): boolean => {
    if (LUA_KEYWORDS.has(id.name) || decls.has(id.offset)) return false;
    declSites.add(id.offset);
    decls.set(id.offset, { offset: id.offset, name: id.name, from, to, kind, rhs });
    return true;
  };

  for (const f of fns) {
    for (const id of lx.identsIn(f.params, f.body.openOffset)) {
      if (lx.enclosingOpen(id.offset) === f.params) add(id, 'param', f.body.openOffset, f.body.closeOffset);
    }
  }

  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    if (id.name === 'local') {
      if (ids[k + 1]?.name === 'function') {
        const name = ids[k + 2];
        if (name && add(name, 'function', name.offset, scopeEnd(name.offset))) functionSites.add(name.offset);
        continue;
      }
      // `local a <const>, b <close> = …`
      const names: LexId[] = [];
      let end = id.offset + id.length;
      let j = k + 1;
      while (j < ids.length) {
        names.push(ids[j]);
        end = ids[j].offset + ids[j].length;
        let after = nextCode(lx, end);
        if (text[after] === '<') {
          ATTRIBUTE.lastIndex = after;
          if (!ATTRIBUTE.test(text)) break;
          end = ATTRIBUTE.lastIndex;
          after = nextCode(lx, end);
          while (j + 1 < ids.length && ids[j + 1].offset < end) j++;
        }
        if (text[after] !== ',') break;
        j++;
      }
      const eq = nextCode(lx, end);
      const hasRhs = text[eq] === '=' && text[eq + 1] !== '=';
      const from = hasRhs ? statementEnd(eq + 1) : end;
      const to = scopeEnd(id.offset);
      const rhsEnd = hasRhs ? Math.max(eq + 1, lx.prevSignificant(from) + 1) : eq;
      const rhs = hasRhs && names.length === 1 ? text.slice(eq + 1, rhsEnd).trim() : undefined;
      const required = rhs !== undefined && requiresModule(lx, eq + 1, rhsEnd);
      for (const n of names) {
        if (!add(n, 'local', from, to, rhs)) continue;
        if (rhs !== undefined && (/^function\b/.test(rhs) || (rhs === n.name && LUA_STD.has(rhs)))) functionSites.add(n.offset);
        if (required) modules.add(n.offset);
      }
      k = j;
      continue;
    }
    if (id.name === 'for') {
      const loop = loops.get(id.offset);
      let j = k + 1;
      while (j < ids.length) {
        if (loop) add(ids[j], 'for', loop.openOffset, loop.closeOffset);
        if (text[nextCode(lx, ids[j].offset + ids[j].length)] !== ',') break;
        j++;
      }
      k = j;
    }
  }

  // One sweep in document order: per name, the declarations visible so far, the
  // latest on top; one whose scope has ended is dropped when it surfaces.
  const order = [...decls.values()].sort((a, b) => a.from - b.from || a.offset - b.offset);
  const visible = new Map<string, LuaDecl[]>();
  let next = 0;
  const binding = new Map<number, number>();
  const uses = new Map<string, { n: number; member: number; assigned: boolean }>();
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    if (LUA_KEYWORDS.has(id.name) || id.name === 'self') continue;
    const p = prevCode(lx, id.offset);
    const n = nextCode(lx, id.offset + id.length);
    if (nonBinding(text, p, n) || tableKey(lx, id, p, n)) continue;
    for (; next < order.length && order[next].from <= id.offset; next++) {
      const d = order[next];
      const stack = visible.get(d.name);
      if (stack) stack.push(d);
      else visible.set(d.name, [d]);
    }
    if (declSites.has(id.offset)) {
      binding.set(id.offset, id.offset);
      continue;
    }
    const stack = visible.get(id.name);
    while (stack && stack.length > 0 && stack[stack.length - 1].to < id.offset) stack.pop();
    if (stack && stack.length > 0) {
      binding.set(id.offset, stack[stack.length - 1].offset);
      continue;
    }
    binding.set(id.offset, -1);
    let u = uses.get(id.name);
    if (!u) {
      u = { n: 0, member: 0, assigned: false };
      uses.set(id.name, u);
    }
    u.n++;
    const c = text[n];
    if (((c === '.' || c === ':') && text[n + 1] !== c) || (c === '[' && lx.spanAt(n)?.start !== n)) u.member++;
    if (c === '=' && text[n + 1] !== '=' && statementStart(lx, id, p)) {
      u.assigned = true;
      if (functionAt(id.offset) === undefined) {
        globalSites.add(id.offset);
        globalNames.add(id.name);
      }
    }
    if (c === '(' && ids[k - 1]?.name === 'function') u.assigned = true;
  }
  const namespaces = new Set<string>();
  for (const [name, u] of uses) {
    if (!u.assigned && u.member === u.n) namespaces.add(name);
  }
  return { declSites, functionSites, binding, decls, modules, namespaces, globalSites, globalNames, functionAt };
}

type Spans = { start: number; end: number }[];

/** Band-1 spans: uses of `local m = require …` (type slate), and non-call data uses of a local named like a grammar builtin (page). */
export function luaRestoreSpans(lx: LexResult): { imports: Spans; shadows: Spans } {
  const text = lx.text;
  const f = luaFacts(lx);
  const imports: Spans = [];
  const shadows: Spans = [];
  for (const id of lx.idents) {
    const d = f.binding.get(id.offset);
    if (d === undefined || d < 0) continue;
    if (f.modules.has(d)) {
      if (d !== id.offset) imports.push({ start: id.offset, end: id.offset + id.length });
      continue;
    }
    if (!LUA_GRAMMAR_BUILTINS.has(id.name) || f.functionSites.has(d) || f.decls.get(d)?.kind === 'function') continue;
    const n = nextCode(lx, id.offset + id.length);
    if ((text[n] === '=' && text[n + 1] !== '=') || luaCallee(lx, id)) continue;
    shadows.push({ start: id.offset, end: id.offset + id.length });
  }
  return { imports, shadows };
}
