/**
 * Band-1 restores for documents no semantic provider colours: the USES of
 * imported modules and types, in the theme's namespace / type slate, and the
 * non-call uses of a shadowed Python builtin, in the page colour. Lexical, on the
 * shared lexer; see docs/import-restore.md and docs/shadow-restore.md.
 */

import { LexId, LexResult, blankGap, commaGap, lex } from './lex';
import { OffsetRange, isArgLabel, pyScopeAt } from './classify';
import { PY_STDLIB, PY_STDLIB_TOP } from './pystdlib';

const CAPWORDS = /^_*[A-Z][A-Za-z0-9_]*[a-z][A-Za-z0-9_]*$/;
const PY_COMPOUND = new Set(['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'def', 'class', 'async', 'match', 'case']);
const PY_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);

interface PyBinding {
  name: string;
  module: string;
  /** Leading dots of a from-import; -1 for `import a.b`. */
  level: number;
  original: string;
}

interface Stmt extends OffsetRange {
  binds: PyBinding[];
}

/**
 * The names both Python grammars scope as builtins wherever they stand, called or
 * not: `support.function.builtin.python` and `support.type.python`. Exception
 * names (`support.type.exception.python`) are left out: docs/shadow-restore.md.
 */
export const PY_BUILTINS: ReadonlySet<string> = new Set([
  '__import__', 'abs', 'aiter', 'all', 'any', 'anext', 'ascii', 'bin', 'breakpoint', 'callable', 'chr', 'compile',
  'copyright', 'credits', 'delattr', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'exit', 'filter', 'format',
  'getattr', 'globals', 'hasattr', 'hash', 'help', 'hex', 'id', 'input', 'isinstance', 'issubclass', 'iter', 'len',
  'license', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'oct', 'open', 'ord', 'pow', 'print', 'quit',
  'range', 'reload', 'repr', 'reversed', 'round', 'setattr', 'sorted', 'sum', 'vars', 'zip',
  'bool', 'bytearray', 'bytes', 'classmethod', 'complex', 'dict', 'float', 'frozenset', 'int', 'list', 'object',
  'property', 'set', 'slice', 'staticmethod', 'str', 'tuple', 'type', 'super',
]);

interface Resolved {
  imports: OffsetRange[];
  shadows: OffsetRange[];
  /** Python: see pyImportOffsets. */
  offsets: Set<number>;
  /** JavaScript and TypeScript: the name each import span paints, in span order. */
  names?: string[];
}

const NONE: Resolved = { imports: [], shadows: [], offsets: new Set() };
const cache = new WeakMap<LexResult, Resolved>();

function resolved(lx: LexResult): Resolved {
  let hit = cache.get(lx);
  if (!hit) {
    hit = lx.syntax.family === 'python' ? pythonResolve(balanced(lx))
      : lx.syntax.family === 'go' ? { imports: goUses(lx), shadows: [], offsets: new Set() }
        : lx.syntax.family === 'js' ? jsNamespaceResolve(lx) : NONE;
    cache.set(lx, hit);
  }
  return hit;
}

/**
 * `lx`, or while a bracket is still open at the end of the text (mid-edit), a lex
 * of the same text with each unclosed opener blanked. Offsets are unchanged, and
 * the lines after the bracket keep their statements and scopes.
 */
function balanced(lx: LexResult): LexResult {
  if (lx.enclosingOpen(lx.text.length) < 0) return lx;
  const text = lx.text;
  const open: number[] = [];
  for (const p of lx.punct) {
    const c = text[p];
    if (c === '(' || c === '[' || c === '{') open.push(p);
    else if ((c === ')' || c === ']' || c === '}') && open.length > 0) open.pop();
  }
  let out = '';
  let from = 0;
  for (const p of open) {
    out += `${text.slice(from, p)} `;
    from = p + 1;
  }
  return lex(out + text.slice(from), 'python');
}

/** Import-restore spans, cached per lex. */
export function importUseSpans(lx: LexResult): OffsetRange[] {
  return resolved(lx).imports;
}

/** JavaScript and TypeScript: the namespace-import name each `importUseSpans` span paints. */
export function importUseNames(lx: LexResult): string[] {
  return resolved(lx).names ?? [];
}

/** JavaScript and TypeScript: the `import * as NS` names no other word in the file reuses. */
export function jsNamespaceNames(lx: LexResult): ReadonlySet<string> {
  return new Set(resolved(lx).names ?? []);
}

/** Shadow-restore spans (Python): non-call uses of a builtin name bound as data. Cached per lex. */
export function shadowUseSpans(lx: LexResult): OffsetRange[] {
  return resolved(lx).shadows;
}

/**
 * Python: offsets of every identifier inside an import statement, and of every
 * use that resolves to an import binding, whatever it claims. None of them is data.
 */
export function pyImportOffsets(lx: LexResult): Set<number> {
  return resolved(lx).offsets;
}

// ── Python ────────────────────────────────────────────────────────────────────

function pyStatementStart(lx: LexResult, offset: number): boolean {
  const text = lx.text;
  if (lx.enclosingOpen(offset) >= 0) return false;
  const p = lx.prevSignificant(offset);
  if (p < 0 || text[p] === ';') return true;
  if (text.slice(p + 1, offset).includes('\n')) return text[p] !== '\\';
  if (text[p] === ':') {
    const ls = lx.lineStarts[lx.lineOf(p)];
    const first = lx.identsIn(ls, p)[0];
    return !!first && PY_COMPOUND.has(first.name) && text.slice(ls, first.offset).trim() === '';
  }
  return false;
}

function pyStatementEnd(lx: LexResult, from: number): number {
  const text = lx.text;
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (!lx.isCode(i)) {
      const s = lx.spanAt(i);
      if (s) {
        i = s.end - 1;
        continue;
      }
    }
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '\\' && (text[i + 1] === '\n' || text[i + 1] === '\r')) i += text[i + 1] === '\r' ? 2 : 1;
    else if ((ch === '\n' || ch === ';') && depth === 0) return i;
  }
  return text.length;
}

const closeCache = new WeakMap<LexResult, Map<number, number>>();

/** Offset of the bracket that closes `open`, else text length. Cached per lex. */
function closeOf(lx: LexResult, open: number): number {
  let m = closeCache.get(lx);
  if (!m) closeCache.set(lx, (m = new Map()));
  const hit = m.get(open);
  if (hit !== undefined) return hit;
  const text = lx.text;
  let depth = 0;
  let close = text.length;
  for (let q = lx.punctFrom(open); q < lx.punct.length; q++) {
    const c = text[lx.punct[q]];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) {
      close = lx.punct[q];
      break;
    }
  }
  m.set(open, close);
  return close;
}

const COMP_CLAUSE = new Set(['for', 'async', 'if']);

/** A comprehension's own scope: its brackets minus the first iterable, which runs in the enclosing scope. */
function comprehensionScope(lx: LexResult, open: number): OffsetRange[] {
  const close = closeOf(lx, open);
  let forKw = false;
  let inKw: LexId | undefined;
  let iterEnd = close;
  for (const x of lx.identsIn(open, close)) {
    if (x.name !== 'in' && !COMP_CLAUSE.has(x.name)) continue;
    if (lx.enclosingOpen(x.offset) !== open) continue;
    if (!forKw) forKw = x.name === 'for';
    else if (!inKw) {
      if (x.name === 'in') inKw = x;
    } else if (COMP_CLAUSE.has(x.name)) {
      iterEnd = x.offset;
      break;
    }
  }
  if (!inKw) return [{ start: open, end: close + 1 }];
  return [{ start: open, end: inKw.offset + inKw.length }, { start: iterEnd, end: close + 1 }];
}

/** A lambda's parameters and its own scope: parameters and body, minus the defaults, which run in the enclosing scope. */
function lambdaScope(lx: LexResult, kw: LexId): { params: LexId[]; ranges: OffsetRange[] } | null {
  const text = lx.text;
  const enc = lx.enclosingOpen(kw.offset);
  // An unclosed bracket (mid-edit) ends the body at the line, as at statement level.
  const lineEnds = enc < 0 || closeOf(lx, enc) >= text.length;
  const defaults: OffsetRange[] = [];
  let depth = 0;
  let eq = -1;
  let colon = -1;
  let end = text.length;
  for (let i = kw.offset + kw.length; i < text.length; i++) {
    if (!lx.isCode(i)) {
      const s = lx.spanAt(i);
      if (s) i = s.end - 1;
      continue;
    }
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth < 0) {
        end = i;
        break;
      }
    } else if (c === '\\' && (text[i + 1] === '\n' || text[i + 1] === '\r')) i += text[i + 1] === '\r' ? 2 : 1;
    else if (depth > 0) continue;
    else if (c === '\n' && lineEnds) {
      end = i;
      break;
    } else if (colon < 0) {
      if (c === '=' && eq < 0) eq = i;
      else if (c === ',' || c === ':') {
        if (eq >= 0) defaults.push({ start: eq, end: i });
        eq = -1;
        if (c === ':') colon = i;
      }
    } else if (c === ',' || c === ';') {
      end = i;
      break;
    }
  }
  if (colon < 0) return null;
  for (const x of lx.identsIn(colon, end)) {
    if ((x.name === 'for' || x.name === 'async') && lx.enclosingOpen(x.offset) === enc) {
      end = x.offset;
      break;
    }
  }
  const ranges: OffsetRange[] = [];
  let from = kw.offset;
  for (const d of defaults) {
    ranges.push({ start: from, end: d.start });
    from = d.end;
  }
  ranges.push({ start: from, end });
  const params = lx.identsIn(kw.offset + kw.length, colon).filter((x) => !defaults.some((d) => d.start <= x.offset && x.offset < d.end));
  return { params, ranges };
}

/**
 * Bare names of the target list that starts at `from`: `a`, `b` and `c` in
 * `a, (b, *c)`, not `d` or `x` in `d.x`, nor `d` or `k` in `d[k]`.
 */
function targetNames(lx: LexResult, from: number, to: number): LexId[] {
  const text = lx.text;
  const listed = (q: number): boolean => {
    if (q >= from && text[q] === '*') q = lx.prevSignificant(q);
    return q < from || text[q] === ',' || text[q] === '(' || text[q] === '[';
  };
  const out: LexId[] = [];
  for (const t of lx.identsIn(from, to)) {
    if (!listed(lx.prevSignificant(t.offset))) continue;
    let n = t.offset + t.length;
    while (text[n] === ' ' || text[n] === '\t') n++;
    if (text[n] === '.' || text[n] === '(' || text[n] === '[') continue;
    let bare = true;
    for (let o = lx.enclosingOpen(t.offset); bare && o >= from; o = lx.enclosingOpen(o)) {
      bare = text[o] !== '{' && listed(lx.prevSignificant(o));
    }
    if (bare) out.push(t);
  }
  return out;
}

/** Bare names a `del` statement unbinds: `a` in `del a, (b)`, not in `del a.b` or `del a[k]`. */
function delTargets(lx: LexResult, kw: LexId): LexId[] {
  return targetNames(lx, kw.offset + kw.length, pyStatementEnd(lx, kw.offset));
}

/** Bare names a `for` binds, between the keyword (`lx.idents[k]`) and its `in`. */
function forTargets(lx: LexResult, k: number): LexId[] {
  const ids = lx.idents;
  for (let j = k + 1; j < ids.length; j++) {
    if (!PY_KEYWORDS.has(ids[j].name)) continue;
    return ids[j].name === 'in' ? targetNames(lx, ids[k].offset + ids[k].length, ids[j].offset) : [];
  }
  return [];
}

const PY_PATTERN_WORDS = new Set(['_', 'as', 'or', 'None', 'True', 'False']);

/**
 * Names a `case` clause's pattern captures: `x` in `case x:`, `case [x, *y]:`,
 * `case {"k": x, **y}:` and `case P(x, k=y)`, not a class name, a dotted value
 * or a keyword-pattern label. Empty when `case` is not a clause.
 */
function caseCaptures(lx: LexResult, kw: LexId): LexId[] {
  const text = lx.text;
  let i = kw.offset + kw.length;
  while (text[i] === ' ' || text[i] === '\t') i++;
  if (i === kw.offset + kw.length && !'([{'.includes(text[i])) return [];
  if ('=.:,)];'.includes(text[i] ?? '') || !pyStatementStart(lx, kw.offset)) return [];
  const end = pyStatementEnd(lx, kw.offset);
  const level = lx.enclosingOpen(kw.offset);
  let stop = -1;
  for (let q = lx.punctFrom(i); q < lx.punct.length && lx.punct[q] < end; q++) {
    const p = lx.punct[q];
    if (text[p] === ':' && lx.enclosingOpen(p) === level) {
      stop = p;
      break;
    }
  }
  if (stop < 0) return [];
  const out: LexId[] = [];
  for (const x of lx.identsIn(i, stop)) {
    if (x.name === 'if' && lx.enclosingOpen(x.offset) === level) break;
    if (PY_PATTERN_WORDS.has(x.name)) continue;
    const p = lx.prevSignificant(x.offset);
    if (p >= 0 && text[p] === '.') continue;
    let n = x.offset + x.length;
    while (text[n] === ' ' || text[n] === '\t') n++;
    if (text[n] === '.' || text[n] === '(' || (text[n] === '=' && text[n + 1] !== '=')) continue;
    out.push(x);
  }
  return out;
}

function pythonImports(lx: LexResult): Stmt[] {
  const text = lx.text;
  const ids = lx.idents;
  const out: Stmt[] = [];
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    if ((id.name !== 'import' && id.name !== 'from') || !pyStatementStart(lx, id.offset)) continue;
    const end = pyStatementEnd(lx, id.offset);
    const inStmt = lx.identsIn(id.offset, end);
    const binds: PyBinding[] = [];
    if (id.name === 'import') {
      let i = 1;
      while (i < inStmt.length) {
        const first = inStmt[i];
        let last = first;
        let j = i + 1;
        while (j < inStmt.length && /^\s*\.\s*$/.test(text.slice(last.offset + last.length, inStmt[j].offset))) last = inStmt[j++];
        let bound = first;
        if (inStmt[j]?.name === 'as' && inStmt[j + 1]) {
          bound = inStmt[j + 1];
          j += 2;
        }
        binds.push({ name: bound.name, module: text.slice(first.offset, last.offset + last.length).replace(/\s+/g, ''), level: -1, original: bound.name });
        i = j;
      }
    } else {
      const imp = inStmt.findIndex((x, n) => n > 0 && x.name === 'import');
      if (imp < 0) continue;
      const head = text.slice(id.offset + 4, inStmt[imp].offset).replace(/\s+|\\/g, '');
      const level = /^\.*/.exec(head)![0].length;
      let i = imp + 1;
      while (i < inStmt.length) {
        const name = inStmt[i];
        let bound = name;
        let j = i + 1;
        if (inStmt[j]?.name === 'as' && inStmt[j + 1]) {
          bound = inStmt[j + 1];
          j += 2;
        }
        binds.push({ name: bound.name, module: head.slice(level), level, original: name.name });
        i = j;
      }
    }
    out.push({ start: id.offset, end, binds });
    while (k + 1 < ids.length && ids[k + 1].offset < end) k++;
  }
  return out;
}

const scopeKey = (lx: LexResult, offset: number): number => pyScopeAt(lx, offset)?.line ?? -1;

function inSorted(stmts: OffsetRange[], off: number): boolean {
  let lo = 0;
  let hi = stmts.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (stmts[m].end <= off) lo = m + 1;
    else if (stmts[m].start > off) hi = m - 1;
    else return true;
  }
  return false;
}

/** `NAME = None` as the whole statement, directly in an `except ImportError` / `ModuleNotFoundError` suite. */
function isImportErrorFallback(lx: LexResult, offset: number): boolean {
  const text = lx.text;
  const line = lx.lineOf(offset);
  const ls = lx.lineStarts[line];
  const le = line + 1 < lx.lineStarts.length ? lx.lineStarts[line + 1] : text.length;
  const body = text.slice(ls, le).replace(/\r?\n$/, '');
  if (!/^\s*[\p{ID_Start}_][\p{ID_Continue}]*\s*=\s*None\s*(#.*)?$/u.test(body)) return false;
  const indent = /^[ \t]*/.exec(body)![0].length;
  for (let l = line - 1; l >= 0 && l > line - 8; l--) {
    const s = text.slice(lx.lineStarts[l], lx.lineStarts[l + 1]);
    if (!s.trim() || s.trim().startsWith('#')) continue;
    if (/^[ \t]*/.exec(s)![0].length < indent) return /^\s*except\s*\(?\s*(ImportError|ModuleNotFoundError)\b/.test(s);
  }
  return false;
}

/** A parameter name in a `def` signature: directly in its parentheses, after `(`, `,`, `*` or `**`. */
function isDefParam(lx: LexResult, offset: number): boolean {
  const text = lx.text;
  const open = lx.enclosingOpen(offset);
  if (open < 0 || text[open] !== '(') return false;
  let p = lx.prevSignificant(offset);
  while (p >= 0 && text[p] === '*') p = lx.prevSignificant(p);
  if (p < 0 || (text[p] === '(' ? p !== open : text[p] !== ',' || lx.enclosingOpen(p) !== open)) return false;
  let q = lx.prevSignificant(open);
  if (q >= 0 && text[q] === ']') q = lx.prevSignificant(lx.enclosingOpen(q)); // `def f[T](…)`
  const before = lx.identsIn(lx.lineStarts[lx.lineOf(q)], q + 1);
  const name = before[before.length - 1];
  const kw = before[before.length - 2];
  return !!name && !!kw && kw.name === 'def' && name.offset + name.length === q + 1
    && blankGap(text, kw.offset + kw.length, name.offset);
}

function mergeRanges(ranges: OffsetRange[]): OffsetRange[] {
  ranges.sort((a, b) => a.start - b.start);
  const merged: OffsetRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ start: r.start, end: r.end });
  }
  return merged;
}

interface OtherBindings {
  /** Per def / class suite, keyed as `scopeKey` (-1 = module). */
  byScope: Map<number, Set<string>>;
  /** The subset of `byScope` bound by a `def` or `class` statement. */
  decl: Map<number, Set<string>>;
  /** Comprehension targets and lambda parameters: the ranges their own scope covers, sorted and merged. */
  local: Map<string, OffsetRange[]>;
  /** Per scope and name, the first offset a binding holds from; -1 for `global` / `nonlocal`. */
  from: Map<number, Map<string, number>>;
  /** Offsets of the bound names themselves. */
  targets: Set<number>;
  /** Is `offset` in a comprehension's or lambda's own scope? */
  nested(offset: number): boolean;
}

/**
 * Names bound other than by import. Neither direction is free: a shadow too many
 * paints less here and hands the use to band 2 as data.
 */
function pythonOtherBindings(lx: LexResult, stmts: Stmt[], names: Set<string>): OtherBindings {
  const text = lx.text;
  const ids = lx.idents;
  const byScope = new Map<number, Set<string>>();
  const decl = new Map<number, Set<string>>();
  const local = new Map<string, OffsetRange[]>();
  const from = new Map<number, Map<string, number>>();
  const targets = new Set<number>();
  const lambdas: OffsetRange[] = [];
  const comps = new Map<number, OffsetRange[] | null>();
  const compAt = (open: number): OffsetRange[] | null => {
    let sc = comps.get(open);
    if (sc === undefined) {
      const isComp = lx.identsIn(open, closeOf(lx, open)).some((x) => x.name === 'for' && lx.enclosingOpen(x.offset) === open);
      comps.set(open, (sc = isComp ? comprehensionScope(lx, open) : null));
    }
    return sc;
  };
  const lambdaParams = new Set<number>();
  const add = (key: number, name: string, at: number, map = byScope): void => {
    if (!names.has(name)) return;
    let s = map.get(key);
    if (!s) map.set(key, (s = new Set()));
    s.add(name);
    let f = from.get(key);
    if (!f) from.set(key, (f = new Map()));
    if (!(f.get(name)! <= at)) f.set(name, at);
  };
  const bind = (key: number, x: LexId, at = x.offset): void => {
    add(key, x.name, at);
    targets.add(x.offset);
  };
  const addLocal = (name: string, ranges: OffsetRange[]): void => {
    const l = local.get(name);
    if (l) l.push(...ranges);
    else local.set(name, [...ranges]);
  };
  const sig = (i: number): number => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
    return i;
  };
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    if (id.name === 'global' || id.name === 'nonlocal') {
      for (let j = k + 1; j < ids.length; j++) {
        const ge = ids[j - 1].offset + ids[j - 1].length;
        if (!(j === k + 1 ? blankGap(text, ge, ids[j].offset) : commaGap(text, ge, ids[j].offset, true))) break;
        if (id.name === 'global') add(-1, ids[j].name, -1);
        add(scopeKey(lx, ids[j].offset), ids[j].name, -1);
        targets.add(ids[j].offset);
      }
      continue;
    }
    if (id.name === 'for' && !inSorted(stmts, id.offset)) {
      const bound = forTargets(lx, k).filter((t) => names.has(t.name));
      if (bound.length === 0) continue;
      const open = lx.enclosingOpen(id.offset);
      if (open < 0) {
        for (const t of bound) bind(scopeKey(lx, id.offset), t);
        continue;
      }
      let sc = comps.get(open);
      if (!sc) comps.set(open, (sc = comprehensionScope(lx, open)));
      for (const t of bound) addLocal(t.name, sc);
      continue;
    }
    if (id.name === 'lambda') {
      const sc = lambdaScope(lx, id);
      if (sc) lambdas.push(...sc.ranges);
      for (const p of sc?.params ?? []) {
        lambdaParams.add(p.offset);
        if (names.has(p.name)) addLocal(p.name, sc!.ranges);
      }
      continue;
    }
    if (id.name === 'del') {
      for (const t of delTargets(lx, id)) bind(scopeKey(lx, t.offset), t);
      continue;
    }
    if (id.name === 'case') {
      const caps = caseCaptures(lx, id);
      for (const t of caps) bind(scopeKey(lx, id.offset), t);
      if (caps.length > 0) continue;
    }
    if (id.name === 'as') {
      // `with ctx() as (a, b):`
      const o = sig(id.offset + id.length);
      if ((text[o] === '(' || text[o] === '[') && !inSorted(stmts, id.offset)) {
        for (const t of targetNames(lx, id.offset + id.length, closeOf(lx, o) + 1)) {
          if (names.has(t.name)) bind(scopeKey(lx, t.offset), t);
        }
      }
      continue;
    }
    if (!names.has(id.name) || inSorted(stmts, id.offset) || lambdaParams.has(id.offset)) continue;
    const prev = ids[k - 1];
    const blank = !!prev && blankGap(text, prev.offset + prev.length, id.offset);
    if (prev && (prev.name === 'class' || prev.name === 'def') && blank) {
      bind(scopeKey(lx, prev.offset), id, prev.offset);
      add(scopeKey(lx, prev.offset), id.name, prev.offset, decl);
      continue;
    }
    if (isDefParam(lx, id.offset)) {
      bind(scopeKey(lx, id.offset), id);
      continue;
    }
    const p = lx.prevSignificant(id.offset);
    const pc = p >= 0 ? text[p] : '';
    if (pc === '.') continue;
    const n = sig(id.offset + id.length);
    const c = text[n] ?? '';
    const c2 = text[n + 1] ?? '';
    const key = scopeKey(lx, id.offset);
    // First in a target list, or after a comma; a star counts as its name: `*a, b = o`.
    const lead = (): boolean => pc === ',' || pyStatementStart(lx, id.offset)
      || (pc === '*' && (text[lx.prevSignificant(p)] === ',' || pyStatementStart(lx, p)));
    // A walrus or `as` target holds from the name, an assignment's from the end of its statement.
    if (c === ':' && c2 === '=') bind(key, id);
    else if (prev && blank && prev.name === 'as') bind(key, id);
    else if (lx.enclosingOpen(id.offset) < 0 && lead()
      && ((c === '=' && c2 !== '=') || (c === ':' && !PY_KEYWORDS.has(id.name) && pyStatementStart(lx, id.offset))
        || (/[+\-*/%&|^@]/.test(c) && c2 === '=') || (/[*/<>]/.test(c) && c2 === c && text[n + 2] === '='))) {
      if (!isImportErrorFallback(lx, id.offset)) bind(key, id, pyStatementEnd(lx, id.offset));
    } else if (c === ',' && lx.enclosingOpen(id.offset) < 0 && lead()
      && /^[\w\s,.*()[\]]*=(?!=)/.test(text.slice(id.offset, pyStatementEnd(lx, id.offset)))) bind(key, id, pyStatementEnd(lx, id.offset));
    else if (c === '=' && c2 !== '=' && pc === '=' && !/[=!<>+\-*/%&|^@:]/.test(text[p - 1] ?? '') && lx.enclosingOpen(id.offset) < 0) {
      bind(key, id, pyStatementEnd(lx, id.offset));
    }
  }
  // Bracketed targets at statement start: `(a, b) = o`, `[a, *b] = o`.
  for (const open of lx.punct) {
    const ch = text[open];
    if ((ch !== '(' && ch !== '[') || /[\p{ID_Continue})\]]/u.test(text[open - 1] ?? '') || !pyStatementStart(lx, open)) continue;
    let depth = 0;
    let j = open;
    let ok = true;
    for (; j < text.length; j++) {
      if (!lx.isCode(j)) {
        const sp = lx.spanAt(j);
        if (sp) j = sp.end - 1;
        continue;
      }
      const cj = text[j];
      if (cj === '(' || cj === '[') {
        if (j > open && /[\p{ID_Continue})\]]/u.test(text[j - 1])) {
          ok = false;
          break;
        }
        depth++;
      } else if (cj === ')' || cj === ']') depth--;
      else if (depth === 0 && cj === '=') break;
      else if (depth === 0 && cj === '\n') {
        ok = false;
        break;
      } else if (!/[\p{ID_Continue}\s,*.\\]/u.test(cj)) {
        ok = false;
        break;
      }
    }
    if (!ok || text[j] !== '=' || text[j + 1] === '=') continue;
    const end = pyStatementEnd(lx, open);
    for (const t of lx.identsIn(open, j)) {
      const q = lx.prevSignificant(t.offset);
      if (q < 0 || text[q] !== '.') bind(scopeKey(lx, t.offset), t, end);
    }
  }
  for (const [name, ranges] of local) local.set(name, mergeRanges(ranges));
  const lambdaRanges = mergeRanges(lambdas);
  const nested = (offset: number): boolean => {
    if (inSorted(lambdaRanges, offset)) return true;
    for (let o = lx.enclosingOpen(offset); o >= 0; o = lx.enclosingOpen(o)) {
      const sc = compAt(o);
      if (sc && inSorted(sc, offset)) return true;
    }
    return false;
  };
  return { byScope, decl, local, from, targets, nested };
}

type Claim = 'module' | 'type' | null;

function claimFor(b: PyBinding): Claim {
  if (b.level < 0) return 'module';
  const name = b.original;
  if (b.level === 0 && PY_STDLIB_TOP.has(b.module.split('.')[0])) {
    const k = PY_STDLIB[b.module]?.[name];
    if (k === 'm') return 'module';
    if (k === 'c') return 'type';
    if (k) return null;
  }
  if (b.level > 0 && !b.module && /^(?!__.*__$)[a-z_][a-z0-9_]*$/.test(name)) return 'module';
  return CAPWORDS.test(name) ? 'type' : null;
}

interface Blocks {
  /** Per line: the statement line it belongs to, else -1. */
  stmt: Int32Array;
  /** Per statement line: the nearest statement line above it with less indent, else -1. */
  up: Int32Array;
  /** Per statement line: the offset its block ends at. */
  end: number[];
  /** Per statement line: `def`, `class`, `for` or `while` when it is one, else ''. */
  kind: string[];
}

const blockTables = new WeakMap<LexResult, Blocks>();
const BLOCK_HEAD = /(?:async[ \t]+)?(def|class|for|while)(?![\p{ID_Continue}])/uy;

/**
 * The statement-line tree, one pass per lex. A line starts a statement when its
 * first character is code outside any bracket and no `\` continues the line above.
 */
function blocksOf(lx: LexResult): Blocks {
  const hit = blockTables.get(lx);
  if (hit) return hit;
  const text = lx.text;
  const n = lx.lineStarts.length;
  const b: Blocks = { stmt: new Int32Array(n).fill(-1), up: new Int32Array(n).fill(-1), end: new Array<number>(n).fill(text.length), kind: new Array<string>(n).fill('') };
  const stack: { line: number; indent: number }[] = [];
  let last = -1;
  let sp = 0;
  let q = 0;
  let depth = 0;
  for (let l = 0; l < n; l++) {
    const s = lx.lineStarts[l];
    let i = s;
    for (let c = text.charCodeAt(i); c === 32 || c === 9; c = text.charCodeAt(++i));
    for (; q < lx.punct.length && lx.punct[q] < i; q++) {
      const c = text.charCodeAt(lx.punct[q]);
      if (c === 40 || c === 91 || c === 123) depth++; // ( [ {
      else if ((c === 41 || c === 93 || c === 125) && depth > 0) depth--;
    }
    while (sp < lx.spans.length && lx.spans[sp].end <= i) sp++;
    const bs = text[s - 2] === '\r' ? s - 3 : s - 2;
    if (i >= text.length || text[i] === '\n' || text[i] === '\r' || depth > 0 || (sp < lx.spans.length && lx.spans[sp].start <= i)
      || (l > 0 && text[bs] === '\\' && lx.isCode(bs))) {
      b.stmt[l] = last;
      continue;
    }
    const ind = i - s;
    while (stack.length > 0 && stack[stack.length - 1].indent >= ind) b.end[stack.pop()!.line] = s;
    b.up[l] = stack.length > 0 ? stack[stack.length - 1].line : -1;
    stack.push({ line: l, indent: ind });
    b.stmt[l] = last = l;
    if ('acdfw'.includes(text[i])) {
      BLOCK_HEAD.lastIndex = i;
      b.kind[l] = BLOCK_HEAD.exec(text)?.[1] ?? '';
    }
  }
  blockTables.set(lx, b);
  return b;
}

/**
 * Does a loop's back edge carry `at` (a later binding) to `use`, in one function
 * or module? True when a `for` / `while` body holds both, or `use` is in a
 * `while` condition. A `for` iterable runs once, before the loop.
 */
function loopCarries(lx: LexResult, use: number, at: number): boolean {
  const b = blocksOf(lx);
  const l = b.stmt[lx.lineOf(use)];
  if (l < 0) return false;
  if (b.kind[l] === 'while' && at <= b.end[l]) return true;
  if (b.kind[l] === 'for' && at <= b.end[l]) {
    // `for x in xs: body` on one line: is `use` past the suite's colon?
    for (let q = lx.punctFrom(lx.lineStarts[l]); q < lx.punct.length && lx.punct[q] < use; q++) {
      if (lx.text[lx.punct[q]] === ':' && lx.enclosingOpen(lx.punct[q]) < 0) return true;
    }
  }
  for (let h = b.up[l]; h >= 0; h = b.up[h]) {
    if (b.kind[h] === 'def') return false;
    if ((b.kind[h] === 'for' || b.kind[h] === 'while') && at <= b.end[h]) return true;
  }
  return false;
}

/** From a `def` / `class` name to the colon that opens its suite. */
function pyHeader(lx: LexResult, kw: LexId, name: LexId | undefined): OffsetRange {
  const text = lx.text;
  if (!name) return { start: kw.offset, end: kw.offset };
  let i = name.offset + name.length;
  for (;;) {
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] !== '(' && text[i] !== '[') break;
    i = closeOf(lx, i) + 1;
  }
  const level = lx.enclosingOpen(kw.offset);
  let line = lx.lineOf(i - 1);
  for (let q = lx.punctFrom(i); q < lx.punct.length && lx.lineOf(lx.punct[q]) === line; q++) {
    const p = lx.punct[q];
    if (text[p] === '(' || text[p] === '[' || text[p] === '{') {
      // A bracketed return annotation can span lines: `-> (\n    T\n):`.
      const close = closeOf(lx, p);
      line = lx.lineOf(close);
      q = lx.punctFrom(close + 1) - 1;
    } else if (text[p] === ':' && lx.enclosingOpen(p) === level) return { start: name.offset + name.length, end: p };
  }
  return { start: name.offset + name.length, end: i };
}

function pythonResolve(lx: LexResult): Resolved {
  const text = lx.text;
  const stmts = pythonImports(lx);
  const offsets = new Set<number>();
  for (const s of stmts) {
    for (const id of lx.identsIn(s.start, s.end)) offsets.add(id.offset);
  }
  // One claim per name and scope: bindings that disagree (a module here, a function there) claim nothing.
  const imports = new Map<number, Map<string, Claim>>();
  // Per scope and name, the first import statement that binds it.
  const importAt = new Map<number, Map<string, number>>();
  const names = new Set<string>();
  for (const s of stmts) {
    const key = scopeKey(lx, s.start);
    let m = imports.get(key);
    if (!m) imports.set(key, (m = new Map()));
    let a = importAt.get(key);
    if (!a) importAt.set(key, (a = new Map()));
    for (const b of s.binds) {
      names.add(b.name);
      const c = claimFor(b);
      m.set(b.name, m.has(b.name) && m.get(b.name) !== c ? null : c);
      if (!a.has(b.name)) a.set(b.name, s.start);
    }
  }
  const builtins = lx.idents.some((id) => PY_BUILTINS.has(id.name));
  if (names.size === 0 && !builtins) return { imports: [], shadows: [], offsets };
  const others = pythonOtherBindings(lx, stmts, builtins ? new Set([...names, ...PY_BUILTINS]) : names);
  // Parent of each def / class suite, keyed by header line; class suites are not
  // visible from the functions nested in them. `header` spans the name to the
  // suite's colon: defaults, annotations and bases there run in the parent.
  const parent = new Map<number, { kind: string; parent: number; header: OffsetRange }>();
  for (let k = 0; k < lx.idents.length; k++) {
    const id = lx.idents[k];
    if (id.name !== 'def' && id.name !== 'class') continue;
    const own = pyScopeAt(lx, id.offset + id.length + 1);
    if (own && own.line === lx.lineOf(id.offset) && !parent.has(own.line)) {
      const name = lx.idents[k + 1];
      parent.set(own.line, { kind: id.name, parent: scopeKey(lx, id.offset), header: pyHeader(lx, id, name) });
    }
  }
  const out: OffsetRange[] = [];
  const shadows: OffsetRange[] = [];
  for (const id of lx.idents) {
    const imported = names.has(id.name);
    const builtin = PY_BUILTINS.has(id.name);
    if ((!imported && !builtin) || inSorted(stmts, id.offset)) continue;
    const p = lx.prevSignificant(id.offset);
    if (p >= 0 && text[p] === '.') continue;
    let n = id.offset + id.length;
    while (text[n] === ' ' || text[n] === '\t') n++;
    const call = text[n] === '(';
    if (builtin && call && !imported) continue;
    if (isArgLabel(lx, id.offset, id.length)) continue;
    const ls = lx.lineStarts[lx.lineOf(id.offset)];
    const head = text.slice(ls, id.offset);
    const inDecorator = /^[ \t]*@/.test(head) && lx.enclosingOpen(id.offset) < 0;
    const paintable = builtin && !call && !inDecorator && !/^[ \t]*(?:async[ \t]+)?(?:def|class)[ \t]+$/.test(head);
    const span = { start: id.offset, end: id.offset + id.length };
    const own = others.local.get(id.name);
    if (own && inSorted(own, id.offset)) {
      if (paintable) shadows.push(span);
      continue;
    }
    const target = text[n] === '=' && text[n + 1] !== '=' && pyStatementStart(lx, id.offset);
    if (target && !builtin) continue;
    let key: number | undefined = scopeKey(lx, id.offset);
    const h = parent.get(key);
    if (h && h.header.start < id.offset && id.offset < h.header.end && !isDefParam(lx, id.offset)) key = h.parent;
    // A comprehension or lambda in a class body does not see the class's names.
    let first = !(parent.get(key)?.kind === 'class' && others.nested(id.offset));
    // Pyright's flow rule (docs/import-restore.md#python): only for a use in a module
    // or class suite, not in a comprehension or lambda, and only in the first scope
    // that binds the name, if that is the use's own suite or the one it runs in.
    let flow = key === -1 || parent.get(key)?.kind === 'class';
    let exec = key;
    while (exec !== -1 && parent.get(exec)?.kind === 'class') exec = parent.get(exec)!.parent;
    const useKey = key;
    let claim: Claim = null;
    let isImport = false;
    let shadowed = false;
    while (key !== undefined) {
      const sc = parent.get(key);
      let next: number | undefined = key === -1 ? undefined : sc ? sc.parent : -1;
      if (first || sc?.kind !== 'class') {
        const m = imports.get(key);
        const bound = others.byScope.get(key)?.has(id.name);
        if (bound || m?.has(id.name)) {
          const at = others.from.get(key)?.get(id.name);
          if (m?.has(id.name)) {
            // An import keeps the scope's symbol whatever the flow, and Pylance colours a
            // symbol by its first declaration. With another binding in the scope, the
            // import is claimed when it comes first, for uses in the same execution
            // scope above that binding.
            if (!bound || ((key === useKey || key === exec) && importAt.get(key)!.get(id.name)! < at!
              && id.offset < at! && !others.targets.has(id.offset))) {
              claim = m.get(id.name)!;
              isImport = true;
            }
            break;
          }
          const early = flow && (key === useKey || key === exec) && at !== undefined && at > id.offset
            && !others.targets.has(id.offset) && !others.nested(id.offset) && !loopCarries(lx, id.offset, at);
          if (!early) {
            shadowed = !others.decl.get(key)?.has(id.name);
            break;
          }
          // No binding reached the use: a class suite hands it to the module, a function leaves it unbound.
          if (sc?.kind === 'def') break;
          if (sc?.kind === 'class') next = -1;
          flow = false;
        }
      }
      first = false;
      key = next;
    }
    if (paintable && shadowed) shadows.push(span);
    if (target || !imported) continue;
    if (isImport) offsets.add(id.offset);
    if (call || !claim || inDecorator) continue;
    out.push(span);
  }
  return { imports: out, shadows, offsets };
}

// ── Go ────────────────────────────────────────────────────────────────────────

/** golang.org/x/tools/internal/imports ImportPathToAssumedName. */
export function goAssumedName(importPath: string): string {
  const parts = importPath.split('/');
  let base = parts[parts.length - 1];
  if (/^v\d+$/.test(base) && parts.length > 1) base = parts[parts.length - 2];
  if (base.startsWith('go-')) base = base.slice(3);
  return /^[\p{L}_][\p{L}\p{Nd}_]*/u.exec(base)?.[0] ?? '';
}

function goUses(lx: LexResult): OffsetRange[] {
  const text = lx.text;
  const names = new Set<string>();
  const stmts: OffsetRange[] = [];
  const spec = (j: number): void => {
    while (text[j] === ' ' || text[j] === '\t') j++;
    let alias: string | null = null;
    const m = /^([\p{L}_][\p{L}\p{Nd}_]*|\.)[ \t]+(?=["`])/u.exec(text.slice(j, j + 200));
    if (m) {
      alias = m[1];
      j += m[0].length;
    }
    const s = lx.spanAt(j);
    if (!s || s.region !== 'string') return;
    const name = alias ?? goAssumedName(text.slice(s.start + 1, s.end - 1));
    if (name && name !== '_' && name !== '.') names.add(name);
  };
  for (const id of lx.idents) {
    if (id.name !== 'import') continue;
    let i = id.offset + id.length;
    while (/\s/.test(text[i] ?? '')) i++;
    if (text[i] !== '(') {
      spec(i);
      stmts.push({ start: id.offset, end: lx.spanAt(i)?.end ?? i });
      continue;
    }
    let close = i;
    for (let k = lx.punctFrom(i); k < lx.punct.length; k++) {
      if (text[lx.punct[k]] === ')') {
        close = lx.punct[k];
        break;
      }
    }
    for (let l = lx.lineOf(i); l <= lx.lineOf(close); l++) {
      let s = Math.max(lx.lineStarts[l], i + 1);
      while (text[s] === ' ' || text[s] === '\t' || text[s] === ';') s++;
      if (s < close) spec(s);
    }
    stmts.push({ start: id.offset, end: close + 1 });
  }
  if (names.size === 0) return [];
  // Function ranges from `func` to its body's closing brace; headers to the `{`.
  const fns: { start: number; head: number; end: number }[] = [];
  for (const id of lx.idents) {
    if (id.name !== 'func') continue;
    let depth = 0;
    let j = id.offset + id.length;
    for (; j < text.length; j++) {
      if (!lx.isCode(j)) {
        const s = lx.spanAt(j);
        if (s) j = s.end - 1;
        continue;
      }
      const c = text[j];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') {
        if (--depth < 0) break;
      } else if ((c === '{' || c === '\n' || c === ',' || c === ';') && depth === 0) break;
    }
    if (text[j] !== '{') continue; // a func type
    let d = 0;
    let k = j;
    for (let q = lx.punctFrom(j); q < lx.punct.length; q++) {
      const c = text[lx.punct[q]];
      if (c === '{') d++;
      else if (c === '}' && --d === 0) {
        k = lx.punct[q];
        break;
      }
    }
    fns.push({ start: id.offset, head: j, end: k + 1 });
  }
  const shadowed = new Map<string, { start: number; end: number }[]>();
  const shadow = (name: string, off: number): void => {
    for (const f of fns) {
      if (f.start <= off && off < f.end) shadowed.set(name, [...(shadowed.get(name) ?? []), f]);
    }
  };
  const ids = lx.idents;
  for (let k = 0; k < ids.length; k++) {
    const id = ids[k];
    if (!names.has(id.name) || inSorted(stmts, id.offset)) continue;
    const p = lx.prevSignificant(id.offset);
    if (p >= 0 && text[p] === '.') continue;
    let n = id.offset + id.length;
    while (text[n] === ' ' || text[n] === '\t') n++;
    if (text[n] === '.') continue;
    const open = lx.enclosingOpen(id.offset);
    const inHeader = fns.some((f) => f.start < id.offset && id.offset < f.head && open > f.start && text[open] === '(');
    if ((text[n] === ':' && text[n + 1] === '=')
      || (text[n] === ',' && /^,[\s\p{L}\p{Nd}_,]*:=/u.test(text.slice(n, n + 200)))
      || (inHeader && (text[p] === '(' || text[p] === ','))) {
      shadow(id.name, id.offset);
    }
  }
  const declared = (list: LexId[], from: number): void => {
    for (let j = from; j < list.length; j++) {
      if (names.has(list[j].name)) shadow(list[j].name, list[j].offset);
      if (j + 1 >= list.length || !commaGap(text, list[j].offset + list[j].length, list[j + 1].offset)) break;
    }
  };
  for (let k = 0; k < ids.length; k++) {
    const kw = ids[k];
    if (kw.name !== 'var' && kw.name !== 'const') continue;
    let i = kw.offset + kw.length;
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] !== '(') {
      if (ids[k + 1]?.offset === i) declared(ids, k + 1);
      continue;
    }
    // A spec starts each line whose previous line ends where Go inserts a semicolon.
    const close = closeOf(lx, i);
    for (let l = lx.lineOf(i); l <= lx.lineOf(close); l++) {
      let s = Math.max(lx.lineStarts[l], i + 1);
      while (text[s] === ' ' || text[s] === '\t' || text[s] === ';') s++;
      const list = lx.identsIn(s, Math.min(close, lx.lineStarts[l + 1] ?? text.length));
      if (list[0]?.offset !== s || lx.enclosingOpen(s) !== i) continue;
      const q = lx.prevSignificant(s);
      if (q === i || /[\p{L}\p{Nd}_)\]}"'`]/u.test(text[q])) declared(list, 0);
    }
  }
  const out: OffsetRange[] = [];
  for (const id of ids) {
    if (!names.has(id.name) || inSorted(stmts, id.offset)) continue;
    const p = lx.prevSignificant(id.offset);
    if (p >= 0 && text[p] === '.') continue;
    const n = id.offset + id.length;
    if (text[n] !== '.' || !/[\p{L}_]/u.test(text[n + 1] ?? '')) continue;
    if (shadowed.get(id.name)?.some((f) => f.start <= id.offset && id.offset < f.end)) continue;
    out.push({ start: id.offset, end: n });
  }
  return out;
}

// ── JavaScript and TypeScript ─────────────────────────────────────────────────

function nextCode(lx: LexResult, i: number): number {
  const text = lx.text;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    const r = lx.regionAt(i);
    if (r !== 'comment' && r !== 'doc') return i;
    i = lx.spanAt(i)!.end;
  }
  return -1;
}

/**
 * `import * as NS from "…"`, `import type * as NS from "…"` and
 * `import d, * as NS from "…"`: the uses `NS.x` and `NS?.x`, a line break or comment
 * before the member included. A name the file writes anywhere else as a bare word
 * (a parameter, a local, a shorthand, `f(NS)`, `NS[k]`) is left out whole, so no
 * shadow needs resolving. docs/import-restore.md#javascript-and-typescript.
 */
function jsNamespaceResolve(lx: LexResult): Resolved {
  const text = lx.text;
  const ids = lx.idents;
  const after = (id: LexId): number => nextCode(lx, id.offset + id.length);
  const binds = new Map<string, number>();
  const stmts: OffsetRange[] = [];
  for (let k = 0; k < ids.length; k++) {
    if (ids[k].name !== 'import') continue;
    const p = lx.prevSignificant(ids[k].offset);
    if (p >= 0 && text[p] === '.') continue;
    let star = after(ids[k]);
    let j = k + 1;
    if (ids[j]?.offset === star && text[after(ids[j])] === ',') {
      star = nextCode(lx, after(ids[j]) + 1);
      j++;
    } else if (ids[j]?.offset === star && ids[j].name === 'type') {
      star = after(ids[j]);
      j++;
    }
    const as = ids[j];
    const name = ids[j + 1];
    const from = ids[j + 2];
    if (star < 0 || text[star] !== '*' || as?.name !== 'as' || nextCode(lx, star + 1) !== as.offset
      || !name || after(as) !== name.offset || from?.name !== 'from' || after(name) !== from.offset) continue;
    const q = after(from);
    const s = q >= 0 ? lx.spanAt(q) : undefined;
    if (!s || s.region !== 'string' || s.start !== q) continue;
    if (binds.has(name.name)) binds.set(name.name, -1);
    else binds.set(name.name, name.offset);
    stmts.push({ start: ids[k].offset, end: s.end });
  }
  if (binds.size === 0) return NONE;
  const uses = new Map<string, OffsetRange[]>();
  for (const id of ids) {
    const at = binds.get(id.name);
    if (at === undefined || at < 0 || id.offset === at || inSorted(stmts, id.offset)) continue;
    const p = lx.prevSignificant(id.offset);
    if (p >= 0 && text[p] === '.' && text[p - 1] !== '.') continue;
    // A JSX tag name waits for the React step; the lexer reads one from the character right after `<` or `</`.
    if (lx.syntax.jsx && (text[id.offset - 1] === '<' || (text[id.offset - 1] === '/' && text[id.offset - 2] === '<'))) continue;
    const n = id.offset + id.length;
    const c = nextCode(lx, n);
    const dot = c < 0 ? -1 : text[c] === '.' ? c : text[c] === '?' && text[c + 1] === '.' ? c + 1 : -1;
    const member = dot < 0 ? -1 : nextCode(lx, dot + 1);
    if (member < 0 || !/[\p{ID_Start}_$]/u.test(text[member])) {
      binds.set(id.name, -1);
      continue;
    }
    const list = uses.get(id.name);
    if (list) list.push({ start: id.offset, end: n });
    else uses.set(id.name, [{ start: id.offset, end: n }]);
  }
  const all: { r: OffsetRange; name: string }[] = [];
  for (const [name, list] of uses) {
    if ((binds.get(name) ?? -1) < 0) continue;
    for (const r of list) all.push({ r, name });
  }
  all.sort((a, b) => a.r.start - b.r.start);
  return { imports: all.map((x) => x.r), shadows: [], offsets: new Set(), names: all.map((x) => x.name) };
}
