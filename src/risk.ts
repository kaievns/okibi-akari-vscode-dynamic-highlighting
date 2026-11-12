/**
 * Band-3 risk marks — spec §risk (Edit phase, focused block only).
 *
 * Always "shape + colour, never colour alone":
 *   - async  — await/async keywords → --risk-async (cyan). Colour on a keyword.
 *   - danger — casts and the `any` type, per language → --risk-danger (bold).
 *   - number — numeric literals inside the focused scope → --syn-number-engaged
 *              (clay). Clay engages only in the focused scope of an engaged phase.
 *   - escape — a write to a binding that lives OUTSIDE the block → --risk-escape
 *              dashed underline. Writes to block-local names get nothing.
 *
 * Diagnostics (error undercurl / warning underdotted) are LEFT to VS Code — we
 * never paint them, to avoid double-marking.
 *
 * lexicalRisk is synchronous (renders instantly on entering Edit); escapeRisk
 * needs the debounced classification. Rules per language: docs/risk-marks.md.
 */

import { OffsetRange, Classification, isArgLabel, pyScopeAt, pySuiteTable } from './classify';
import { LexId, LexResult, lexFor } from './lex';
import { LuaFacts, luaFacts } from './lua';
import { rubyEscapeRisk } from './ruby';
import { scanBlocks } from './focus';

export interface LexicalRisk {
  async: OffsetRange[];
  danger: OffsetRange[];
  numberEngaged: OffsetRange[];
}

const ASYNC_WORDS = new Set(['await', 'async']);
/** Families whose `async` and `await` are plain names: Lua and Ruby have no such keywords, and Zig 0.17's list has neither. */
const NO_ASYNC_FAMILIES = new Set(['lua', 'ruby', 'zig']);

type DangerRule = (lx: LexResult, id: LexId) => boolean;

/** Async/danger keywords and numeric literals in a block: code only, never inside strings, comments or docstrings. */
export function lexicalRisk(text: string, block: OffsetRange, languageId?: string): LexicalRisk {
  const lx = lexFor(text, languageId);
  const danger = languageId !== undefined ? DANGER_RULES.get(languageId) : undefined;
  const result: LexicalRisk = { async: [], danger: [], numberEngaged: lx.numbersIn(block.start, block.end) };
  for (const id of lx.identsIn(block.start, block.end)) {
    const range: OffsetRange = { start: id.offset, end: id.offset + id.length };
    if (ASYNC_WORDS.has(id.name) && !NO_ASYNC_FAMILIES.has(lx.syntax.family)) {
      result.async.push(range);
    } else if (danger && danger(lx, id)) {
      result.danger.push(range);
    }
  }
  return result;
}

// ── shared scanning helpers ──────────────────────────────────────────────────

const isBlank = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const WORD_CHAR = /[\p{ID_Continue}$]/u;

function nextIndex(text: string, from: number): number {
  let n = from;
  while (n < text.length && isBlank(text[n])) n++;
  return n;
}

/** The identifier ending just before `end` (blanks and comments skipped), else ''. */
function wordBefore(lx: LexResult, end: number): string {
  const text = lx.text;
  const q = lx.prevSignificant(end);
  let w = q;
  while (w >= 0 && WORD_CHAR.test(text[w])) w--;
  return text.slice(w + 1, q + 1);
}

function wordAt(text: string, at: number): string {
  const m = /^[\p{ID_Start}_$][\p{ID_Continue}$]*/u.exec(text.slice(at, at + 64));
  return m ? m[0] : '';
}

/**
 * Start of the statement or header that ends at `at`: just after the previous
 * `;`, `{` or `}`, or an unclosed `(` / `[`, at bracket depth 0. With
 * `rustStatement`, braces are nested groups (`use a::{b, c as d}`, a block
 * expression) and only `;` or an unclosed block `{` ends the walk.
 */
function headerStart(lx: LexResult, at: number, rustStatement = false): number {
  const text = lx.text;
  let depth = 0;
  for (let k = lx.punctFrom(at) - 1; k >= 0; k--) {
    const p = lx.punct[k];
    const c = text[p];
    if (c === ')' || c === ']' || c === '}') {
      if (c === '}' && depth === 0 && !rustStatement) {
        return p + 1;
      }
      depth++;
    } else if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) {
        depth--;
      } else if (c !== '{' || !rustStatement || !(text[lx.prevSignificant(p)] === ':' || wordBefore(lx, p) === 'use')) {
        return p + 1;
      }
    } else if (c === ';' && depth === 0) {
      return p + 1;
    }
  }
  return 0;
}

// ── danger words ─────────────────────────────────────────────────────────────

const TS_DECL_WORDS = new Set([
  'function', 'let', 'const', 'var', 'class', 'interface', 'type', 'enum', 'namespace', 'import', 'export',
]);

/** `{` of an `import { … }`, `import D, { … }` or `export { … }` clause. */
function isModuleClauseBrace(lx: LexResult, brace: number): boolean {
  const from = Math.max(0, brace - 200);
  const m = /\b(?:import|export)\s+(?:type\s+)?(?:[\p{ID_Start}_$][\p{ID_Continue}$]*\s*,\s*)?$/u.exec(
    lx.text.slice(from, brace),
  );
  return m !== null && lx.isCode(from + m.index);
}

/** TS `x as T`: not `.as`, not `as const`, not an import/export alias, not a name spelled `as`. */
function tsCast(lx: LexResult, id: LexId): boolean {
  const text = lx.text;
  const prev = text[lx.prevSignificant(id.offset)] ?? '';
  if (prev === '.' || prev === '*' || !/[\p{ID_Continue}$)\]}'"`!]/u.test(prev)) {
    return false;
  }
  if (TS_DECL_WORDS.has(wordBefore(lx, id.offset))) {
    return false;
  }
  const n = nextIndex(text, id.offset + id.length);
  if (!/[\p{ID_Start}_$([{'"`\d-]/u.test(text[n] ?? '') || wordAt(text, n) === 'const') {
    return false;
  }
  const open = lx.enclosingOpen(id.offset);
  return !(open >= 0 && text[open] === '{' && isModuleClauseBrace(lx, open));
}

/** TS `any` in type position: not `.any`, not a call `any(…)`, not a key or a binding named `any`. */
function tsAnyType(lx: LexResult, id: LexId): boolean {
  const text = lx.text;
  const prev = text[lx.prevSignificant(id.offset)] ?? '';
  if (prev === '.') {
    return false;
  }
  const before = wordBefore(lx, id.offset);
  if (TS_DECL_WORDS.has(before)) {
    return false;
  }
  const n = nextIndex(text, id.offset + id.length);
  const next = text[n] ?? '';
  if (next === '(') {
    return false;
  }
  if (next === ':' && (prev === '{' || prev === ',' || prev === '(')) {
    return false;
  }
  if (next === '=' && text[n + 1] !== '=' && text[n + 1] !== '>') {
    return prev === ':' || before === 'as' || before === 'extends';
  }
  return true;
}

/** Rust `x as T`: not a `use … as` / `extern crate … as` alias, not a `<T as Trait>::` path. */
function rustCast(lx: LexResult, id: LexId): boolean {
  const text = lx.text;
  if (text[lx.prevSignificant(id.offset)] === '.') {
    return false;
  }
  const end = id.offset + id.length;
  if (/^\s+[\w:]+(?:<[^;{}()]*?>)?\s*>\s*::/.test(text.slice(end, end + 200))) {
    return false;
  }
  const stmt = lx.identsIn(headerStart(lx, id.offset, true), id.offset);
  for (let k = 0; k < stmt.length; k++) {
    if (stmt[k].name === 'use' || (stmt[k].name === 'extern' && stmt[k + 1]?.name === 'crate')) {
      return false;
    }
  }
  return true;
}

/** Kotlin / Dart / Swift `x as T`; an `import … as` alias is not a cast. */
function importAwareCast(lx: LexResult, id: LexId): boolean {
  const text = lx.text;
  if (text[lx.prevSignificant(id.offset)] === '.') {
    return false;
  }
  const lineStart = lx.lineStarts[lx.lineOf(id.offset)];
  return !/^\s*import\b/.test(text.slice(lineStart, id.offset));
}

const onlyAs = (rule: DangerRule): DangerRule => (lx, id) => id.name === 'as' && rule(lx, id);
const tsDanger: DangerRule = (lx, id) =>
  (id.name === 'as' && tsCast(lx, id)) || (id.name === 'any' && tsAnyType(lx, id));

/** Zig's pointer casts and pointer/integer round trips; the value casts are checked (docs/zig.md#danger-marks). */
const ZIG_DANGER = new Set([
  '@ptrCast', '@alignCast', '@constCast', '@volatileCast', '@addrSpaceCast', '@intFromPtr', '@ptrFromInt', '@fieldParentPtr',
]);

/**
 * Per-language danger words. A language without an entry gets none: Python's `as`
 * binds an alias and `any()` is a builtin, JavaScript has no casts, and Go's `any`
 * is the checked `interface{}` alias (docs/risk-marks.md).
 */
const DANGER_RULES = new Map<string, DangerRule>([
  ['typescript', tsDanger],
  ['typescriptreact', tsDanger],
  ['vue', tsDanger],
  ['svelte', tsDanger],
  ['astro', tsDanger],
  ['rust', onlyAs(rustCast)],
  ['kotlin', onlyAs(importAwareCast)],
  ['dart', onlyAs(importAwareCast)],
  ['swift', onlyAs(importAwareCast)],
  ['zig', (_lx, id) => ZIG_DANGER.has(id.name)],
]);

// ── escaping writes ──────────────────────────────────────────────────────────

const EMPTY_SET: ReadonlySet<never> = new Set();
const SELF_ROOTS: ReadonlySet<string> = new Set(['self', 'this']);
const PY_SELF_ROOTS: ReadonlySet<string> = new Set(['self', 'cls']);
/** In JavaScript `self` is a plain name (`var self = this`, a worker's global). */
const JS_SELF_ROOTS: ReadonlySet<string> = new Set(['this']);
/** In Zig `this` is a plain parameter name. */
const ZIG_SELF_ROOTS: ReadonlySet<string> = new Set(['self']);

const ASSIGN_OPS = [
  '<<|=', '+%=', '-%=', '*%=', '+|=', '-|=', '*|=', '>>>=', '<<=', '>>=', '**=', '//=', '??=', '||=', '&&=', '&^=',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=', '=',
];

/** Length of an assignment operator at `j`, else 0. `==`, `=>`, `<=`, `>=`, `!=`, `:=` are not. */
function assignOpLen(text: string, j: number): number {
  for (const op of ASSIGN_OPS) {
    if (text.startsWith(op, j)) {
      if (op === '=' && (text[j + 1] === '=' || text[j + 1] === '>')) {
        return 0;
      }
      return op.length;
    }
  }
  return 0;
}

function skipSpaces(text: string, j: number): number {
  while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
  return j;
}

/** Offset just past the code bracket opened at `open`, else -1. */
function closeOf(lx: LexResult, open: number): number {
  let depth = 0;
  for (let k = lx.punctFrom(open); k < lx.punct.length; k++) {
    const c = lx.text[lx.punct[k]];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        return lx.punct[k] + 1;
      }
    }
  }
  return -1;
}

interface Target {
  /** Index of the root identifier. */
  root: number;
  /** Offset just past the target expression. */
  end: number;
  /** End of the last member name; the root's end when there is none. */
  nameEnd: number;
  /** Index of the first identifier after the target. */
  next: number;
  /** Has a `.m` / `->m` / `[k]` step: judged by the root receiver. */
  chained: boolean;
}

/**
 * The write target starting at ids[k]: `root`, `root.a.b`, `root[k]`, `root?.a`,
 * `root->a`, `root!!.a`, Zig's `root.*` and `root.?.a`. A call in the chain makes
 * the receiver unknown: null.
 */
function parseTarget(lx: LexResult, ids: LexId[], k: number): Target | null {
  const text = lx.text;
  const root = ids[k];
  let end = root.offset + root.length;
  let nameEnd = end;
  let chained = false;
  let next = k + 1;
  for (;;) {
    let j = skipSpaces(text, end);
    while (text[j] === '!' && (text[j + 1] === '!' || text[j + 1] === '.')) j++;
    if (text[j] === '?' && text[j + 1] === '.') j++;
    const arrow = text[j] === '-' && text[j + 1] === '>';
    if (text[j] === '.' && (text[j + 1] === '*' || text[j + 1] === '?') && lx.syntax.family === 'zig') {
      end = nameEnd = j + 2;
      chained = true;
      continue;
    }
    if ((text[j] === '.' && text[j + 1] !== '.') || arrow) {
      j = skipSpaces(text, j + (arrow ? 2 : 1));
      const id = ids[next];
      if (!id || id.offset !== j) {
        return null;
      }
      end = nameEnd = id.offset + id.length;
      chained = true;
      next++;
      continue;
    }
    if (text[j] === '[' && lx.isCode(j)) {
      const close = closeOf(lx, j);
      if (close < 0) {
        return null;
      }
      end = close;
      chained = true;
      while (next < ids.length && ids[next].offset < close) next++;
      continue;
    }
    if (text[j] === '(') {
      return null;
    }
    return { root: k, end, nameEnd, next, chained };
  }
}

/**
 * Names in the `global` / `nonlocal` statements of the def that holds `block`, not
 * of a def nested in it (Python). Read from `fn` (the server's function range) when
 * there is one, else from the block. At module level the statement is a no-op.
 */
function pyOuterNames(lx: LexResult, block: OffsetRange, fn: OffsetRange | undefined): Set<string> {
  const names = new Set<string>();
  const own = pyScopeAt(lx, block.start);
  if (!own || own.kind !== 'def') {
    return names;
  }
  const region = fn ?? block;
  const ids = lx.identsIn(region.start, region.end);
  for (let k = 0; k < ids.length; k++) {
    if ((ids[k].name !== 'global' && ids[k].name !== 'nonlocal') || pyScopeAt(lx, ids[k].offset)?.line !== own.line) {
      continue;
    }
    let end = ids[k].offset + ids[k].length;
    for (let j = k + 1; j < ids.length; j++) {
      const gap = lx.text.slice(end, ids[j].offset);
      if (!(j === k + 1 ? /^[ \t]+$/ : /^[ \t]*,[ \t]*$/).test(gap)) {
        break;
      }
      names.add(ids[j].name);
      end = ids[j].offset + ids[j].length;
    }
  }
  return names;
}

const PY_INITIALIZERS = new Set(['__init__', '__post_init__', '__new__', '__init_subclass__']);
const CTOR_MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'explicit', 'inline', 'constexpr', 'factory', 'const',
]);
const CONTROL_WORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'match', 'when', 'try', 'catch', 'finally', 'loop',
  'unsafe', 'guard', 'defer', 'select', 'case', 'with', 'synchronized', 'async', 'move', 'go',
]);

/**
 * Is the function header `ids` (statement start to its `{`) an initializer?
 * Its `self`/`this` writes set up an object nothing else holds yet.
 */
function headerIsInitializer(lx: LexResult, ids: LexId[]): boolean {
  const text = lx.text;
  const family = lx.syntax.family;
  const plain = ids.filter((id) => text[id.offset - 1] !== '@');
  const callee = plain.findIndex((id) => text[skipSpaces(text, id.offset + id.length)] === '(');
  if (callee < 0) {
    return false;
  }
  const name = plain[callee].name;
  if (name === 'constructor') {
    return family === 'js' || family === 'kotlin';
  }
  if (family === 'js') {
    // An ES5 constructor function: `function Point(x, y) {`, `const Point = function (x) {`.
    if (name === 'function') return /^[A-Z]/.test(plain[callee - 1]?.name ?? '');
    return /^[A-Z]/.test(name) && plain[callee - 1]?.name === 'function';
  }
  if (name === 'init') {
    return family === 'kotlin' || family === 'nested';
  }
  if (family === 'java' || family === 'c' || family === 'default' || family === 'nested') {
    const before = plain.slice(0, callee).map((id) => id.name).filter((w) => !CTOR_MODIFIERS.has(w));
    return /^[A-Z]/.test(name) && (before.length === 0 || (before.length === 1 && before[0] === name));
  }
  return false;
}

/** Is `offset` inside an initializer body? Brace languages walk out through enclosing blocks; Python reads indentation. */
function makeInitializerTest(lx: LexResult): (offset: number) => boolean {
  const text = lx.text;
  const memo = new Map<number, boolean>();
  if (lx.syntax.family === 'python') {
    return (offset: number): boolean => {
      const scope = pyScopeAt(lx, offset);
      return scope?.kind === 'def' && PY_INITIALIZERS.has(scope.name);
    };
  }
  return (offset: number): boolean => {
    for (let open = lx.enclosingOpen(offset); open >= 0; open = lx.enclosingOpen(open)) {
      if (text[open] !== '{') {
        continue;
      }
      const known = memo.get(open);
      if (known !== undefined) {
        return known;
      }
      const ids = lx.identsIn(headerStart(lx, open), open);
      const first = ids.find((id) => text[id.offset - 1] !== '@');
      if (first && CONTROL_WORDS.has(first.name)) {
        continue;
      }
      const last = ids[ids.length - 1];
      if (last && last.name === 'init' && lx.syntax.family === 'kotlin' && lx.prevSignificant(open) === last.offset + last.length - 1) {
        memo.set(open, true);
        return true;
      }
      if (!ids.some((id) => text[skipSpaces(text, id.offset + id.length)] === '(')) {
        if (/[=:,([?]/.test(text[lx.prevSignificant(open)] ?? '')) {
          continue; // an object literal: look through it
        }
        memo.set(open, false);
        return false;
      }
      const result = headerIsInitializer(lx, ids);
      memo.set(open, result);
      return result;
    }
    return false;
  };
}

function isOccurrence(c: Classification, name: string, offset: number): boolean {
  const ranges = c.occurrences?.get(name);
  if (!ranges) {
    return false;
  }
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].start === offset) return true;
    if (ranges[mid].start < offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** The parts of `block` outside `exclude` (sorted, merged). */
function gaps(block: OffsetRange, exclude: OffsetRange[]): OffsetRange[] {
  const out: OffsetRange[] = [];
  let at = block.start;
  for (const r of exclude) {
    if (r.end <= at) continue;
    if (r.start >= block.end) break;
    if (r.start > at) out.push({ start: at, end: r.start });
    at = Math.max(at, r.end);
  }
  if (at < block.end) out.push({ start: at, end: block.end });
  return out;
}

/**
 * Writes that escape the focused block: an assignment target (any assignment
 * operator, `++`/`--`, statement-level tuple targets in Python and Go) whose
 * binding lives outside the block. Rules and evidence: docs/risk-marks.md.
 *
 *   - A heuristic classification makes no claim: without binding resolution most
 *     declarations read as writes.
 *   - Declarations (`c.declSites`), named arguments and defaults are not writes.
 *   - A plain write marks when its name is `out`, `fn` other than the focused
 *     function's own parameter, a Python `global`/`nonlocal`, or a Rust static.
 *   - `root.m`, `root[k]` and `*root` writes are judged by the root: `self`/`this`
 *     outside an initializer, `fn` at any proximity, or `out`.
 */
export function escapeRisk(
  text: string,
  block: OffsetRange,
  c: Classification,
  languageId?: string,
): OffsetRange[] {
  if (c.source === 'heuristic') {
    return [];
  }
  const lx = lexFor(text, languageId);
  const family = lx.syntax.family;
  const declSites: ReadonlySet<number> = c.declSites ?? EMPTY_SET;
  const staticNames: ReadonlySet<string> = c.staticNames ?? EMPTY_SET;
  const regions = c.excludeRanges && c.excludeRanges.length > 0 ? gaps(block, c.excludeRanges) : [block];
  const outerNames: ReadonlySet<string> =
    family === 'python' ? pyOuterNames(lx, block, c.enclosingFn) : EMPTY_SET;
  const selfRoots = family === 'python' ? PY_SELF_ROOTS : family === 'js' ? JS_SELF_ROOTS : family === 'zig' ? ZIG_SELF_ROOTS : SELF_ROOTS;
  if (family === 'ruby') {
    return rubyEscapeRisk(lx, block, regions, scanBlocks(text, languageId));
  }
  const lua = family === 'lua' ? luaFacts(lx) : undefined;
  const postfixIncr = family !== 'python' && family !== 'rust' && family !== 'zig' && !lua;
  const prefixIncr = postfixIncr && family !== 'go';
  const tuples = family === 'python' || family === 'go' || lua !== undefined;
  const derefs = family === 'rust' || family === 'c' || family === 'go';
  const inInitializer = lua ? luaInitializerTest(lx, lua) : makeInitializerTest(lx);

  const plainEscapes = (id: LexId): boolean => {
    if (outerNames.has(id.name) || staticNames.has(id.name)) {
      return true;
    }
    const info = c.byName.get(id.name);
    if (!info || !isOccurrence(c, id.name, id.offset)) {
      return false;
    }
    // At chunk level, an assignment to a name declared nowhere defines the global.
    if (lua && info.cls === 'out' && c.enclosingFn === undefined
      && !(c.occurrences?.get(id.name) ?? []).some((r) => declSites.has(r.start))) {
      return false;
    }
    return info.cls === 'out' || (info.cls === 'fn' && info.proximity !== 0);
  };
  const rootEscapes = (id: LexId): boolean => {
    if (selfRoots.has(id.name)) {
      return !inInitializer(id.offset);
    }
    if (outerNames.has(id.name) || staticNames.has(id.name)) {
      return true;
    }
    const info = c.byName.get(id.name);
    if (lua && info === undefined) {
      // lua-language-server types an annotated table `class`, which is not data;
      // a write into one declared outside the block still escapes.
      const d = lua.binding.get(id.offset);
      return d !== undefined && d >= 0 && !lua.modules.has(d) && (d < block.start || d >= block.end);
    }
    if (lua && info?.cls === 'out' && c.enclosingFn === undefined && lua.globalNames.has(id.name)) {
      return false; // the chunk fills in a global it defines
    }
    return info !== undefined && (info.cls === 'out' || info.cls === 'fn' || info.cls === 'self');
  };

  // Python: a plain `=` rebinds the function's one variable, so it escapes only
  // when the name's declaration sits in a suite that encloses the focused block.
  // Sibling branches (`if` / `else`, `try` / `except`) that each assign it do not.
  const pyBranchStore = (id: LexId): boolean => {
    if (family !== 'python' || outerNames.has(id.name)) {
      return false;
    }
    const decls = (c.occurrences?.get(id.name) ?? []).filter((r) => declSites.has(r.start) && r.start < id.offset);
    const suites = pySuiteTable(lx);
    return decls.length > 0 && !decls.some((r) => suites.encloses(r.start, block.start));
  };

  const escapes: OffsetRange[] = [];
  const marked = new Set<number>();
  const judge = (root: LexId, t: Target, deref: boolean, plainStore: boolean): void => {
    if (marked.has(root.offset)) {
      return;
    }
    let hit: boolean;
    if (t.chained || deref) {
      hit = rootEscapes(root);
    } else if (declSites.has(root.offset) && !outerNames.has(root.name)) {
      hit = false;
    } else if (isArgLabel(lx, root.offset, root.length)) {
      hit = false;
    } else {
      hit = plainEscapes(root) && !(plainStore && pyBranchStore(root));
    }
    if (hit) {
      marked.add(root.offset);
      escapes.push({ start: root.offset, end: t.chained ? t.nameEnd : root.offset + root.length });
    }
  };

  // An f-string hole holds an expression, never a statement: `f"{x=}"` is the
  // self-documenting read and walrus is `:=`.
  const holeIsExpression = family === 'python' && lx.holes.length > 0;
  for (const region of regions) {
    const ids = lx.identsIn(region.start, region.end);
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k];
      if (holeIsExpression && lx.holeEndAt(id.offset) < text.length) {
        continue;
      }
      const p = lx.prevSignificant(id.offset);
      const prev = text[p] ?? '';
      if (prev === '.' || (prev === '>' && text[p - 1] === '-')) {
        continue; // a member name: its chain is judged from the root
      }
      const t = parseTarget(lx, ids, k);
      if (!t) {
        continue;
      }
      const deref = derefs && prev === '*' && !/[\p{ID_Continue}$)\]]/u.test(text[lx.prevSignificant(p)] ?? '');
      const j = skipSpaces(text, t.end);
      const pre = text.slice(Math.max(0, id.offset - 2), id.offset);
      const op = assignOpLen(text, j);
      const isWrite =
        op > 0 ||
        (postfixIncr && (text.startsWith('++', j) || text.startsWith('--', j))) ||
        (prefixIncr && (pre === '++' || pre === '--'));
      if (isWrite) {
        judge(id, t, deref, op === 1);
        continue;
      }
      if (!tuples || text[j] !== ',' || prev === ',') {
        continue;
      }
      const open = lx.enclosingOpen(id.offset);
      if (open >= 0 && (text[open] !== '{' || lua)) {
        continue; // inside ( or [: an argument or element list; inside a Lua `{`, a table constructor
      }
      // `a, b.c, d[k] = …` at statement level: every element is written.
      const list: Target[] = [t];
      let at = j;
      while (text[at] === ',') {
        const n = list[list.length - 1].next;
        if (n >= ids.length || ids[n].offset !== skipSpaces(text, at + 1)) {
          break;
        }
        const el = parseTarget(lx, ids, n);
        if (!el) {
          break;
        }
        list.push(el);
        at = skipSpaces(text, el.end);
      }
      if (list.length > 1 && text[at] === '=' && text[at + 1] !== '=') {
        for (const el of list) {
          judge(ids[el.root], el, false, true);
        }
      }
    }
  }
  return escapes.sort((a, b) => a.start - b.start);
}

const LUA_INITIALIZER = /(?:^|[.:\s])(?:new|init|initialize|_init|__init|ctor)\s*\($/;

/** Lua has no constructor syntax: a `self` write is exempt in a function named like one, and after the function's own `local self`. */
function luaInitializerTest(lx: LexResult, facts: LuaFacts): (offset: number) => boolean {
  const text = lx.text;
  return (offset: number): boolean => {
    const f = facts.functionAt(offset);
    if (!f) return false;
    if (LUA_INITIALIZER.test(text.slice(f.headerStart, f.params + 1))) return true;
    const ids = lx.identsIn(f.body.openOffset, offset);
    return ids.some((id, i) => id.name === 'self' && ids[i - 1]?.name === 'local');
  };
}
