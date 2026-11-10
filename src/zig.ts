/**
 * Zig facts for the heuristic classifier and the band-1 namespace restore: what a
 * name is when no server answers. Rules and measurements: docs/zig.md.
 */

import { LexId, LexResult } from './lex';

/** Zig 0.17's keywords, and `usingnamespace`, `async` and `await`, which earlier versions reserve. */
const ZIG_KEYWORDS = new Set([
  'addrspace', 'align', 'allowzero', 'and', 'anyframe', 'anytype', 'asm', 'break', 'callconv', 'catch',
  'comptime', 'const', 'continue', 'defer', 'else', 'enum', 'errdefer', 'error', 'export', 'extern', 'fn',
  'for', 'if', 'inline', 'noalias', 'noinline', 'nosuspend', 'opaque', 'or', 'orelse', 'packed', 'pub',
  'resume', 'return', 'linksection', 'struct', 'suspend', 'switch', 'test', 'threadlocal', 'try', 'union',
  'unreachable', 'var', 'volatile', 'while', 'usingnamespace', 'async', 'await',
  'true', 'false', 'null', 'undefined',
]);

const ZIG_PRIMITIVES = new Set([
  'isize', 'usize', 'c_char', 'c_short', 'c_ushort', 'c_int', 'c_uint', 'c_long', 'c_ulong', 'c_longlong',
  'c_ulonglong', 'c_longdouble', 'f16', 'f32', 'f64', 'f80', 'f128', 'bool', 'anyopaque', 'void', 'noreturn',
  'type', 'anyerror', 'comptime_int', 'comptime_float',
]);

/** Zig's keywords and primitive types, `u0` … `u65535` and `i0` … `i65535` included. */
export function isZigReserved(name: string): boolean {
  return ZIG_KEYWORDS.has(name) || ZIG_PRIMITIVES.has(name) || /^[iu]\d+$/.test(name);
}

/** A type by Zig's naming convention: TitleCase, or one capital letter. `ALL_CAPS` is a value. */
export function isZigTypeName(name: string): boolean {
  return /^[A-Z]/.test(name) && (name.length === 1 || /[a-z]/.test(name));
}

/** Keywords and builtins after `=` that make a `const` a type, a namespace or a function. */
const TYPE_INIT_WORDS = new Set(['struct', 'enum', 'union', 'opaque', 'packed', 'extern', 'fn', 'error']);
const TYPE_INIT_BUILTINS = new Set([
  '@import', '@cImport', '@This', '@Type', '@TypeOf', '@Vector', '@Int', '@Struct', '@Union', '@Enum', '@Pointer',
  '@Fn', '@Tuple', '@FieldType', '@EnumLiteral', '@Frame',
]);
const CAPTURE_AFTER = new Set(['catch', 'else', 'errdefer']);
const CAPTURE_PARENS = new Set(['if', 'while', 'for']);
const CONTAINER_WORDS = new Set(['struct', 'enum', 'union', 'opaque', 'error']);
const LABELLED = new Set(['while', 'for', 'inline', 'switch']);

export interface ZigFacts {
  /** Identifiers that are never data: labels, builtins, fields, enum members, type parameters. */
  readonly nonDataAt: ReadonlySet<number>;
  /** Names a `const` binds to a type, namespace or function, and type parameters, anywhere in the file. */
  readonly nonDataNames: ReadonlySet<string>;
  /** `name` at `at` is one of those names inside the scope that declares it, the declaration included. */
  nonDataUse(name: string, at: number): boolean;
  /** Capture names (`|x|`, `|*x|`, `|x, i|`): declarations. */
  readonly captures: readonly LexId[];
  /** `{` offsets that open a container body (`struct {`, `union(enum) {`, `error{`). */
  readonly containerOpens: ReadonlySet<number>;
  /** Namespaces: `const` names bound to `@import(…)`, a lowercase name bound to a type, and container-level aliases of one, anywhere in the file. */
  readonly imports: ReadonlySet<string>;
  /** `name` at `at` is a namespace inside the scope that declares it, the declaration included. */
  importUse(name: string, at: number): boolean;
}

type Range = readonly [number, number];

/**
 * Where each name is bound. Zig forbids a name that shadows one in an enclosing scope,
 * not one in a sibling scope: a container's `const json` and a later function's
 * parameter `json` are two bindings.
 */
class Bindings {
  private readonly ranges = new Map<string, Range[]>();
  private sorted: Map<string, { starts: number[]; ends: number[]; maxEnd: number[] }> | undefined;

  bind(name: string, range: Range): void {
    const l = this.ranges.get(name);
    if (l) l.push(range);
    else this.ranges.set(name, [range]);
    this.sorted = undefined;
  }

  /** `name` at `at` is inside a scope that binds it. */
  covers(name: string, at: number): boolean {
    const l = this.ranges.get(name);
    if (!l) return false;
    if (l.length < 8) return l.some(([s, e]) => s <= at && at < e);
    this.sorted ??= new Map();
    let ix = this.sorted.get(name);
    if (!ix) {
      const byStart = [...l].sort((a, b) => a[0] - b[0]);
      const maxEnd: number[] = [];
      for (const [, e] of byStart) maxEnd.push(Math.max(e, maxEnd[maxEnd.length - 1] ?? -1));
      ix = { starts: byStart.map((r) => r[0]), ends: byStart.map((r) => r[1]), maxEnd };
      this.sorted.set(name, ix);
    }
    let lo = 0;
    let hi = ix.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ix.starts[mid] <= at) lo = mid + 1;
      else hi = mid;
    }
    for (let j = lo - 1; j >= 0 && ix.maxEnd[j] > at; j--) if (ix.ends[j] > at) return true;
    return false;
  }
}

const memo = new WeakMap<LexResult, ZigFacts>();

export function zigFacts(lx: LexResult): ZigFacts {
  const hit = memo.get(lx);
  if (hit) return hit;
  const facts = computeZigFacts(lx);
  memo.set(lx, facts);
  return facts;
}

function computeZigFacts(lx: LexResult): ZigFacts {
  const text = lx.text;
  const ids = lx.idents;
  const nonDataAt = new Set<number>();
  const nonDataNames = new Set<string>();
  const captures: LexId[] = [];
  const containerOpens = new Set<number>();
  const imports = new Set<string>();
  const nonDataScopes = new Bindings();
  const importScopes = new Bindings();
  const aliases = new Map<string, { range: Range; member: boolean; called: boolean }[]>();
  const idStartingAt = (at: number, hint: number): LexId | undefined => {
    if (at < 0) return undefined;
    const k = ids[hint]?.offset === at ? hint : lastIdFrom(ids, at);
    return k >= 0 && ids[k].offset === at ? ids[k] : undefined;
  };
  const wordEndingAt = (end: number): LexId | undefined => idEndingAt(ids, end);
  const prevId = (at: number): LexId | undefined => {
    const p = lx.prevSignificant(at);
    return p >= 0 ? wordEndingAt(p) : undefined;
  };
  // A Zig comment starts at `//`; every other span is a literal, which counts.
  const next = (at: number): number => {
    let i = at;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        i++;
        continue;
      }
      if (c === 47 && text.charCodeAt(i + 1) === 47) {
        const s = lx.spanAt(i);
        if (s && s.region !== 'string') {
          i = s.end;
          continue;
        }
      }
      return i;
    }
    return -1;
  };
  for (const at of lx.punct) {
    if (text[at] === '{' && opensContainer(lx, at)) containerOpens.add(at);
  }
  // The scope a declaration at `at` binds in: its block or container body, the file, or for a
  // parameter its function's signature and body.
  const scopes = new Map<number, Range>();
  const scopeOf = (at: number): Range => {
    const open = lx.enclosingOpen(at);
    if (open < 0) return [0, text.length];
    let r = scopes.get(open);
    if (!r) {
      r = scopeAt(open);
      scopes.set(open, r);
    }
    return r;
  };
  const scopeAt = (open: number): Range => {
    const close = closeOf(lx, open);
    const end = close < 0 ? text.length : close;
    if (text[open] !== '(') return [open, end];
    let depth = 0;
    for (let k = lx.punctFrom(end); k < lx.punct.length; k++) {
      const p = lx.punct[k];
      const ch = text[p];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (--depth < 0) break;
      } else if (ch === '{') {
        if (depth === 0 && !opensContainer(lx, p)) {
          const c = closeOf(lx, p);
          return [open, c < 0 ? text.length : c];
        }
        depth++;
      } else if (depth === 0 && (ch === ';' || ch === ',')) break;
    }
    return [open, end];
  };

  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    const end = id.offset + id.length;
    if (id.name[0] === '@' && id.name[1] !== '"') {
      nonDataAt.add(id.offset);
      continue;
    }
    const n = next(end);
    const c = n >= 0 ? text[n] : '';
    const colon = c === ':';
    const after = colon ? next(n + 1) : -1;
    const word = colon ? idStartingAt(after, k + 1) : undefined;
    // `blk: {`, `outer: while`
    if (colon && (text[after] === '{' || (word && LABELLED.has(word.name)))) {
      nonDataAt.add(id.offset);
      continue;
    }
    const before = ids[k - 1]?.name;
    const field = c === ':' || c === ',' || c === '=' || c === '}';
    const p = before === 'break' || before === 'continue' || field ? lx.prevSignificant(id.offset) : -1;
    const pc = p >= 0 ? text[p] : '';
    // `break :blk`, `continue :outer`
    if (pc === ':') {
      const b = prevId(p);
      if (b && (b.name === 'break' || b.name === 'continue')) {
        nonDataAt.add(id.offset);
        continue;
      }
    }
    // A field, enum member or error name written in a container body: `x: f32 = 0,`, `red,`, `comptime k: u8 = 1,`.
    if (field && containerOpens.has(lx.enclosingOpen(id.offset))
      && (pc === '{' || pc === ',' || pc === '}' || pc === ';' || (pc !== '' && wordEndingAt(p)?.name === 'comptime'))) {
      nonDataAt.add(id.offset);
      continue;
    }
    // `comptime T: type`, `T: type`
    if (word && word.name === 'type') {
      const t = next(word.offset + word.length);
      if (text[t] === ',' || text[t] === ')') {
        nonDataNames.add(id.name);
        nonDataScopes.bind(id.name, scopeOf(id.offset));
        nonDataAt.add(id.offset);
        continue;
      }
    }
    if (before === 'const' && (c === '=' || c === ':') && text[n + 1] !== '=') {
      let eq = n;
      if (c === ':') {
        eq = text.indexOf('=', n);
        if (eq < 0 || text.slice(n, eq).includes(';')) continue;
      }
      const v = next(eq + 1);
      const init = idStartingAt(v, k + 1);
      if (!init) continue;
      if (TYPE_INIT_WORDS.has(init.name) || TYPE_INIT_BUILTINS.has(init.name)) {
        const call = next(init.offset + init.length);
        // `error.Overflow` is a value, as are `@TypeOf(x) == T`, `@Vector(4, u8){…}` and `@import("x").y`.
        const value = init.name === 'error' ? text[call] !== '{'
          : init.name[0] === '@' && (text[call] !== '(' || text[next(closeOf(lx, call))] !== ';');
        if (value) continue;
        const range = scopeOf(id.offset);
        nonDataNames.add(id.name);
        nonDataScopes.bind(id.name, range);
        if (init.name !== 'fn' && !isZigTypeName(id.name)) {
          imports.add(id.name);
          importScopes.bind(id.name, range);
        }
        continue;
      }
      const scope = lx.enclosingOpen(id.offset);
      if ((scope < 0 || containerOpens.has(scope)) && nonDataScopes.covers(init.name, init.offset) && aliasChain(lx, init, idStartingAt)) {
        const range = scopeOf(id.offset);
        nonDataNames.add(id.name);
        nonDataScopes.bind(id.name, range);
        if (importScopes.covers(init.name, init.offset) && !isZigTypeName(id.name)) {
          const l = aliases.get(id.name);
          const a = { range, member: false, called: false };
          if (l) l.push(a);
          else aliases.set(id.name, [a]);
        }
      }
    }
  }

  for (let i = text.indexOf('|'); i >= 0; i = text.indexOf('|', i + 1)) {
    if (!lx.isCode(i) || text[i + 1] === '|' || text[i - 1] === '|' || text[i + 1] === '=') continue;
    const p = lx.prevSignificant(i);
    if (p < 0) continue;
    let ok = false;
    if (text[p] === '>' && text[p - 1] === '=') ok = true;
    else if (text[p] === ')') {
      const open = openOf(lx, p);
      const w = open > 0 ? prevId(open) : undefined;
      ok = w !== undefined && CAPTURE_PARENS.has(w.name);
    } else {
      const w = wordEndingAt(p);
      ok = w !== undefined && CAPTURE_AFTER.has(w.name);
    }
    if (!ok) continue;
    const close = text.indexOf('|', i + 1);
    if (close < 0) continue;
    const inner = text.slice(i + 1, close);
    if (!/^\s*\*?\s*[\p{ID_Start}_@][^|]*$/u.test(inner) || inner.includes('\n')) continue;
    for (const id of lx.identsIn(i + 1, close)) captures.push(id);
    i = close;
  }
  // An alias is a namespace when a use in its scope reads a member and none is called: `mem.eql(…)`, not `assert(…)`.
  if (aliases.size > 0) {
    const lengths = new Set([...aliases.keys()].map((a) => a.length));
    for (const id of ids) {
      if (!lengths.has(id.length)) continue;
      const l = aliases.get(id.name);
      const a = l?.find(({ range }) => range[0] <= id.offset && id.offset < range[1]);
      if (!a) continue;
      let n = id.offset + id.length;
      while (text[n] === ' ' || text[n] === '\t') n++;
      if (text[n] === '(') a.called = true;
      else if (text[n] === '.' && text[n + 1] !== '.' && text[n + 1] !== '*' && text[n + 1] !== '?') a.member = true;
    }
    for (const [name, l] of aliases) {
      for (const a of l) {
        if (!a.member || a.called) continue;
        imports.add(name);
        importScopes.bind(name, a.range);
      }
    }
  }
  return {
    nonDataAt, nonDataNames, captures, containerOpens, imports,
    nonDataUse: (name, at) => nonDataScopes.covers(name, at),
    importUse: (name, at) => importScopes.covers(name, at),
  };
}

/** Index of the last identifier starting at or before `at`, else -1. */
function lastIdFrom(ids: readonly LexId[], at: number): number {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid].offset <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function idEndingAt(ids: readonly LexId[], end: number): LexId | undefined {
  const k = lastIdFrom(ids, end);
  return k >= 0 && ids[k].offset + ids[k].length - 1 === end ? ids[k] : undefined;
}

/** Offset of the code bracket the one at `close` closes, else -1. */
function openOf(lx: LexResult, close: number): number {
  let depth = 0;
  for (let k = lx.punctFrom(close); k >= 0; k--) {
    const c = lx.text[lx.punct[k]];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (--depth === 0) return lx.punct[k];
    }
  }
  return -1;
}

/** The `{` at `at` opens a container body: `struct {`, `packed struct(u8) {`, `union(enum) {`, `enum(u8) {`, `error{`. */
function opensContainer(lx: LexResult, at: number): boolean {
  let p = lx.prevSignificant(at);
  if (p >= 0 && lx.text[p] === ')') {
    const open = openOf(lx, p);
    p = open > 0 ? lx.prevSignificant(open) : -1;
  }
  const w = p >= 0 ? idEndingAt(lx.idents, p) : undefined;
  return w !== undefined && CONTAINER_WORDS.has(w.name);
}

/** Offset just past the code bracket opened at `open`, else -1. */
function closeOf(lx: LexResult, open: number): number {
  let depth = 0;
  for (let k = lx.punctFrom(open); k < lx.punct.length; k++) {
    const c = lx.text[lx.punct[k]];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return lx.punct[k] + 1;
  }
  return -1;
}

/** `ns.a.b` up to `;` or `,` with nothing else after the root: an alias, not a computed value. */
function aliasChain(lx: LexResult, root: LexId, idStartingAt: (at: number, hint: number) => LexId | undefined): boolean {
  const text = lx.text;
  let at = root.offset + root.length;
  for (;;) {
    while (text[at] === ' ' || text[at] === '\t') at++;
    if (text[at] === ';' || text[at] === ',') return true;
    if (text[at] !== '.') return false;
    at++;
    const id = idStartingAt(at, -1);
    if (id === undefined) return false;
    at = id.offset + id.length;
  }
}

/** A member `.self` and a field or enum member `self` of a container body are names; anywhere else `self` is the receiver. */
export function zigKeywordSelf(lx: LexResult, id: LexId): boolean {
  const text = lx.text;
  if (text[lx.prevSignificant(id.offset)] === '.') return false;
  let n = id.offset + id.length;
  while (text[n] === ' ' || text[n] === '\t') n++;
  if (!/[:,=}]/.test(text[n] ?? '')) return true;
  const open = lx.enclosingOpen(id.offset);
  return open < 0 || text[open] !== '{' || !opensContainer(lx, open);
}

/**
 * Uses of a namespace `const` (an `@import`, or a container-level alias of one) inside
 * the scope that declares it, the declaration included: not after `.`, not called, not
 * a field, enum member or label.
 */
export function zigImportSpans(lx: LexResult): { start: number; end: number }[] {
  const facts = zigFacts(lx);
  const text = lx.text;
  const out: { start: number; end: number }[] = [];
  if (facts.imports.size === 0) return out;
  for (const id of lx.idents) {
    if (!facts.imports.has(id.name) || !facts.importUse(id.name, id.offset) || facts.nonDataAt.has(id.offset)) continue;
    const p = lx.prevSignificant(id.offset);
    if (p >= 0 && text[p] === '.' && text[p - 1] !== '.') continue;
    let n = id.offset + id.length;
    while (text[n] === ' ' || text[n] === '\t') n++;
    if (text[n] === '(') continue;
    out.push({ start: id.offset, end: id.offset + id.length });
  }
  return out;
}
