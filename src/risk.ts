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
import { LexId, LexResult, lexFor, selfWords } from './lex';
import { LuaFacts, luaFacts } from './lua';
import { rubyEscapeRisk } from './ruby';
import { inObjcRegion, isObjc } from './cjvm';
import { scanBlocks } from './focus';
import { ShellCommand, shellTables } from './shell';

export interface LexicalRisk {
  async: OffsetRange[];
  danger: OffsetRange[];
  numberEngaged: OffsetRange[];
}

const ASYNC_WORDS = new Set(['await', 'async']);
/** Families whose `async` and `await` are plain names: Lua and Ruby have no such keywords, Zig 0.17's list has neither, nor have PHP, shell and fish. */
const NO_ASYNC_FAMILIES = new Set(['lua', 'ruby', 'zig', 'sh', 'fish']);

type DangerRule = (lx: LexResult, id: LexId) => boolean;

/** Async/danger keywords and numeric literals in a block: code only, never inside strings, comments or docstrings. */
export function lexicalRisk(text: string, block: OffsetRange, languageId?: string): LexicalRisk {
  const lx = lexFor(text, languageId);
  const danger = languageId !== undefined ? DANGER_RULES.get(languageId) : undefined;
  const result: LexicalRisk = { async: [], danger: [], numberEngaged: lx.numbersIn(block.start, block.end) };
  for (const id of lx.identsIn(block.start, block.end)) {
    const range: OffsetRange = { start: id.offset, end: id.offset + id.length };
    if (ASYNC_WORDS.has(id.name) && !NO_ASYNC_FAMILIES.has(lx.syntax.family) && lx.syntax.key !== 'php') {
      result.async.push(range);
    } else if (danger && danger(lx, id)) {
      result.danger.push(range);
    }
  }
  const casts = languageId !== undefined ? CAST_LANGUAGES.get(languageId) : undefined;
  if (casts) {
    result.danger.push(...casts(lx, block));
    result.danger.sort((a, b) => a.start - b.start);
  }
  return result;
}

const PRIMITIVE = /^(?:void|char|short|int|long|float|double|bool|_Bool|unsigned|signed|byte|boolean)$/;
const QUALIFIER = /^(?:const|volatile|struct|union|enum|class|typename|unsigned|signed|long|short)$/;

/**
 * `(T *)x`, `(const T *)x`, `(T &)x` in C and C++: a C-style cast to a pointer or
 * reference type, the C spelling of `reinterpret_cast` and `const_cast`. A value
 * cast (`(int)d`) converts, like `static_cast`, and is not marked
 * (docs/risk-marks.md#danger-words).
 */
function cPointerCasts(lx: LexResult, block: OffsetRange): OffsetRange[] {
  const out: OffsetRange[] = [];
  const t = lx.text;
  for (let k = lx.punctFrom(block.start); k < lx.punct.length && lx.punct[k] < block.end; k++) {
    const open = lx.punct[k];
    if (t[open] !== '(') continue;
    const close = closeParen(lx, k);
    if (close < 0 || close - open > 120) continue;
    const inner = t.slice(open + 1, close);
    const m = /^\s*((?:[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*(?:\s*<[^()<>;{}]*>)?\s+)*[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*(?:\s*<[^()<>;{}]*>)?)\s*((?:[*&]\s*(?:const\s*)?)+)$/.exec(inner);
    if (!m || /[^\s*&]/.test(m[2].replace(/const/g, ''))) continue;
    if (!lx.identsIn(open, close).every((id) => lx.isCode(id.offset))) continue;
    const p = lx.prevSignificant(open);
    if (p >= 0 && /[\w)\]]/.test(t[p]) && !/\b(?:return|case|else)$/.test(t.slice(Math.max(0, p - 6), p + 1))) continue;
    const n = nextCodeIndex(lx, close + 1);
    if (n < 0 || !/[A-Za-z_(&*~!"'0-9]/.test(t[n])) continue;
    const words = m[1].split(/[^\w]+/).filter(Boolean);
    if (words.every((w) => QUALIFIER.test(w))) continue;
    out.push({ start: open, end: close + 1 });
  }
  return out;
}

/** Java `(Type) x`: a reference cast, checked at run time like Kotlin's `as`; `(int) d` converts. */
function javaCasts(lx: LexResult, block: OffsetRange): OffsetRange[] {
  const out: OffsetRange[] = [];
  const t = lx.text;
  for (let k = lx.punctFrom(block.start); k < lx.punct.length && lx.punct[k] < block.end; k++) {
    const open = lx.punct[k];
    if (t[open] !== '(') continue;
    const close = closeParen(lx, k);
    if (close < 0 || close - open > 160) continue;
    const inner = t.slice(open + 1, close).trim();
    if (!/^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^()]*>)?(?:\s*\[\s*\])*$/.test(inner)) continue;
    const head = inner.split(/[\s.<\[]/).pop() ?? inner;
    if (PRIMITIVE.test(inner.replace(/\s*\[\s*\]/g, '')) && !/\[/.test(inner)) continue;
    const last = inner.replace(/<.*>|\[\s*\]/g, '').split('.').pop()!.trim();
    if (!/^[A-Z]/.test(last) || /^[A-Z][A-Z0-9_]+$/.test(last) || head === '') continue;
    const p = lx.prevSignificant(open);
    if (p >= 0 && /[\w$)\]]/.test(t[p]) && !/\breturn$/.test(t.slice(Math.max(0, p - 5), p + 1))) continue;
    const n = nextCodeIndex(lx, close + 1);
    if (n < 0 || !/[A-Za-z_$("'0-9!~]/.test(t[n])) continue;
    out.push({ start: open, end: close + 1 });
  }
  return out;
}

/** Kotlin `x!!`: the non-null assertion turns the type system's null check off at that read. */
function kotlinAssertions(lx: LexResult, block: OffsetRange): OffsetRange[] {
  const out: OffsetRange[] = [];
  const t = lx.text;
  for (let i = t.indexOf('!!', block.start); i >= 0 && i < block.end; i = t.indexOf('!!', i + 2)) {
    if (lx.isCode(i) && t[i + 2] !== '=') out.push({ start: i, end: i + 2 });
  }
  return out;
}

/** `@SuppressWarnings("unchecked")` / `@Suppress("UNCHECKED_CAST")`: the compiler's own cast check, switched off. */
function uncheckedSuppressions(lx: LexResult, block: OffsetRange): OffsetRange[] {
  const out: OffsetRange[] = [];
  const t = lx.text;
  for (const id of lx.identsIn(block.start, block.end)) {
    if ((id.name !== 'SuppressWarnings' && id.name !== 'Suppress') || t[id.offset - 1] !== '@') continue;
    const open = nextCodeIndex(lx, id.offset + id.length);
    if (open < 0 || t[open] !== '(') continue;
    const args = t.slice(open, t.indexOf(')', open) + 1);
    if (/"(?:unchecked|rawtypes|UNCHECKED_CAST)"/.test(args)) out.push({ start: id.offset - 1, end: id.offset + id.length });
  }
  return out;
}

function closeParen(lx: LexResult, k: number): number {
  const t = lx.text;
  let depth = 0;
  for (let j = k; j < lx.punct.length && j - k < 64; j++) {
    const c = t[lx.punct[j]];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return lx.punct[j];
    else if (c === ';' || c === '{' || c === '}') return -1;
  }
  return -1;
}

function nextCodeIndex(lx: LexResult, i: number): number {
  const t = lx.text;
  while (i < t.length) {
    if (isBlank(t[i])) {
      i++;
      continue;
    }
    const r = lx.regionAt(i);
    if (r === 'comment' || r === 'doc') {
      i = lx.spanAt(i)!.end;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Swift's checks switched off: `x!` (a force unwrap), `try!`, `as!`, `unowned(unsafe)`,
 * `nonisolated(unsafe)` and `@unchecked`. An implicitly unwrapped type (`var v: T!`),
 * `as?`, `try?` and `!=` are not marked (docs/swift.md#danger-marks).
 */
function swiftDanger(lx: LexResult, block: OffsetRange): OffsetRange[] {
  const out: OffsetRange[] = [];
  const t = lx.text;
  for (let i = t.indexOf('!', block.start); i >= 0 && i < block.end; i = t.indexOf('!', i + 1)) {
    if (!lx.isCode(i) || t[i + 1] === '=') continue;
    const before = t[i - 1];
    if (before === undefined || !/[\p{ID_Continue})\]?`>"]/u.test(before)) continue;
    const word = identEndingAt(lx, i);
    if (word === 'try' || word === 'as') {
      out.push({ start: i - word.length, end: i + 1 });
      continue;
    }
    if (swiftTypePosition(lx, i)) continue;
    out.push({ start: i, end: i + 1 });
  }
  for (const id of lx.identsIn(block.start, block.end)) {
    if ((id.name === 'unowned' || id.name === 'nonisolated') && /^\(\s*unsafe\s*\)/.test(t.slice(id.offset + id.length, id.offset + id.length + 12))) {
      out.push({ start: id.offset, end: t.indexOf(')', id.offset) + 1 });
    } else if (id.name === 'unchecked' && t[id.offset - 1] === '@') {
      out.push({ start: id.offset - 1, end: id.offset + id.length });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The `[` or `(` the bracket at `close` closes, on its line or the 4 above, else -1. */
function bracketOpen(t: string, close: number): number {
  let depth = 0;
  let lines = 0;
  for (let i = close; i >= 0; i--) {
    const c = t[i];
    if (c === ']' || c === ')') depth++;
    else if (c === '[' || c === '(') {
      if (--depth === 0) return i;
    } else if (c === '\n' && ++lines > 4) return -1;
  }
  return -1;
}

/** The identifier that ends at `end`, else ''. */
function identEndingAt(lx: LexResult, end: number): string {
  const t = lx.text;
  let s = end;
  while (s > 0 && WORD_CHAR.test(t[s - 1])) s--;
  return t.slice(s, end);
}

/**
 * `T!` in a type: `var v: T!`, `-> T!`, `(T!, U)`, `[T!]`, `[K: V!]`, `Array<T>!`, `as T!`,
 * and a bracketed type: `[UIButton]!`, `[K: V]!`, `(() -> Void)!`, `-> [T]!`.
 */
function swiftTypePosition(lx: LexResult, bang: number): boolean {
  const t = lx.text;
  let j = bang - 1;
  if (t[j] === ']' || t[j] === ')') {
    const open = bracketOpen(t, j);
    // `dict[k]!`, `f()!`: a subscript or a call reads a value.
    if (open < 0 || /[\p{ID_Continue})\]?!>`]/u.test(t[open - 1] ?? '') || !/^\s*[A-Z([]/.test(t.slice(open + 1, j))) return false;
    j = open - 1;
  } else {
    let depth = 0;
    for (; j >= 0; j--) {
      const c = t[j];
      if (c === '>') depth++;
      else if (c === '<' && depth > 0) depth--;
      else if (!(depth > 0 ? /[\p{ID_Continue}.,\s[\]:?!]/u : /[\p{ID_Continue}.]/u).test(c)) break;
    }
    const head = t.slice(j + 1, bang);
    // A type's last component is capitalised (`Foundation.URL!`); `NSImage.gearshape!` reads a value.
    if (!/^[A-Z]/.test(head) || !/^[A-Z]/.test(head.replace(/<[^]*$/, '').split('.').pop() ?? '')) return false;
  }
  let k = j;
  while (k >= 0 && (t[k] === ' ' || t[k] === '\t')) k--;
  const c = t[k];
  if (c === ':') return t[k - 1] !== ':' && !/\s\?\s/.test(t.slice(lx.lineStarts[lx.lineOf(k)], k));
  if (c === '>') return t[k - 1] === '-';
  if (c === '(' || c === '[' || c === ',') return true;
  return /\b(?:as|is)$/.test(t.slice(Math.max(0, k - 2), k + 1));
}

/**
 * Objective-C: `__bridge`, `__bridge_transfer` and `__bridge_retained` casts hand an object
 * across the ARC boundary unchecked; `performSelector:` sends a selector the compiler cannot
 * check. A method's signature types (`- (NSString *)name:(id)x`) and `@property (…)` are not
 * casts, and a `@selector(performSelector:)` or a method declared `performSelector:` sends nothing.
 */
function objcDanger(lx: LexResult, block: OffsetRange): OffsetRange[] {
  const t = lx.text;
  const out = cPointerCasts(lx, block).filter((r) => !objcSignatureAt(lx, r.start) && !/^\(\s*__bridge/.test(t.slice(r.start, r.end)));
  for (const id of lx.identsIn(block.start, block.end)) {
    if (/^__bridge(?:_transfer|_retained)?$/.test(id.name)) {
      const open = lx.enclosingOpen(id.offset);
      const close = open >= 0 && t[open] === '(' ? t.indexOf(')', id.offset) : -1;
      if (close > 0) out.push({ start: open, end: close + 1 });
    } else if (/^performSelector(?:OnMainThread|InBackground)?$/.test(id.name) && t[id.offset + id.length] === ':' && !selectorLiteralAt(lx, id.offset)
      && !objcSignatureAt(lx, id.offset)) {
      out.push({ start: id.offset, end: id.offset + id.length + 1 });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Inside a `@selector(…)`, which names a selector and sends nothing. */
function selectorLiteralAt(lx: LexResult, offset: number): boolean {
  const open = lx.enclosingOpen(offset);
  return open >= 0 && lx.text[open] === '(' && /@selector\s*$/.test(lx.text.slice(Math.max(0, open - 16), open));
}

/** Inside an Objective-C method's signature (`- (T)a:(T)x b:(T)y` up to its `{` or `;`) or an `@property (…)` list. */
function objcSignatureAt(lx: LexResult, offset: number): boolean {
  if (!inObjcRegion(lx, offset)) return false;
  const t = lx.text;
  const ls = lx.lineStarts[lx.lineOf(offset)];
  const lead = t.slice(ls, offset);
  if (/^\s*@property\s*$/.test(lead)) return true;
  // The method's first line starts with `-` or `+` and a `(`; a wrapped signature continues
  // on lines that hold no `;` and no `{` before this one.
  for (let line = lx.lineOf(offset), k = 0; line >= 0 && k < 8; line--, k++) {
    const s = lx.lineStarts[line];
    const e = line === lx.lineOf(offset) ? offset + 1 : lx.lineStarts[line + 1] ?? t.length;
    const txt = t.slice(s, e);
    if (line !== lx.lineOf(offset) && /[;{}]/.test(txt)) return false;
    if (/^\s*[-+]\s*\(/.test(txt)) return lx.enclosingOpen(s) < 0 || t[lx.enclosingOpen(s)] !== '(';
  }
  return false;
}

type CastRule = (lx: LexResult, block: OffsetRange) => OffsetRange[];
const cCasts: CastRule = cPointerCasts;
const jvmCasts: CastRule = (lx, b) => [...javaCasts(lx, b), ...uncheckedSuppressions(lx, b)];
const ktCasts: CastRule = (lx, b) => [...kotlinAssertions(lx, b), ...uncheckedSuppressions(lx, b)];
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish']);
/** Commands that run their first operand as a command, and their options that take a value. */
const WRAPPERS = new Map<string, Set<string>>([
  ['sudo', new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U', '-R'])], ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C', '-P', '-S'])], ['command', new Set()], ['exec', new Set(['-a'])], ['nohup', new Set()],
  ['time', new Set(['-f', '-o'])],
]);

/** The command a wrapper runs (`sudo -E bash -` runs `bash -`): its word, where it starts, its arguments. */
function unwrap(c: ShellCommand): { name: string; at: number; args: string[]; argAt: number[] } {
  let name = c.name;
  let at = c.offset;
  let args = c.args;
  let argAt = c.argAt;
  const wrapper = (n: string) => WRAPPERS.get(n.slice(n.lastIndexOf('/') + 1));
  for (let opts = wrapper(name); opts; opts = wrapper(name)) {
    if (name === 'command' && args.some((a) => a === '-v' || a === '-V')) break;
    let k = 0;
    while (k < args.length && args[k].startsWith('-') && args[k] !== '-') {
      if (args[k] === '--') { k++; break; }
      k += opts.has(args[k]) ? 2 : 1;
    }
    if (name === 'env') while (k < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[k])) k++;
    if (k >= args.length || args[k] === '') break;
    name = args[k];
    at = argAt[k];
    args = args.slice(k + 1);
    argAt = argAt.slice(k + 1);
  }
  return { name, at, args, argAt };
}

/** A shell that reads its script from standard input: no operand before `-s`, and no `-c`. */
function readsStdin(args: string[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '-o' || a === '-O' || a === '+o' || a === '+O') { k++; continue; }
    if (a === '-s' || a === '--') return true;
    if (a === '' || !a.startsWith('-')) return false;
    if (/^-[a-zA-Z]*c/.test(a)) return false;
  }
  return true;
}

/**
 * A shell's script fetched as it runs: its first operand a process substitution
 * (`bash <(curl …)`, fish `bash (curl … | psub)`), or its `-c` string a
 * `$(curl …)` or `$(wget …)` hole.
 */
function runsFetched(text: string, args: string[], argAt: number[], fish: boolean): boolean {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const word = text.slice(argAt[k], argAt[k] + 256);
    if (/^-[a-zA-Z]*c$/.test(a)) {
      const next = k + 1 < args.length ? text.slice(argAt[k + 1], argAt[k + 1] + 64) : '';
      return /^"?\$\(\s*(?:curl|wget)\b/.test(next) || (fish && /^\(\s*(?:curl|wget)\b/.test(next));
    }
    if (a === '-o' || a === '-O' || a === '+o' || a === '+O') { k++; continue; }
    if (a.startsWith('-') && a !== '-') continue;
    return a.startsWith('<(') || (fish && a === '' && /^\((?:[^()]|\([^()]*\))*\|\s*psub\b[^()]*\)/.test(word));
  }
  return false;
}

/**
 * Code from somewhere else run as this script: `eval`, a pipe into a shell that
 * reads its script from it (`curl … | sh`), a shell whose script is a process
 * substitution or a fetched `-c` string, and `source` / `.` of standard input or
 * a process substitution, through `sudo`, `doas`, `env`, `command`, `exec`,
 * `nohup` or `time`. fish: the same, and `… | source`. Destructive commands
 * (`rm -rf`, `sudo` itself) are not marked (docs/risk-marks.md#danger-words).
 */
const shellDanger: CastRule = (lx, block) => {
  const out: OffsetRange[] = [];
  const fish = lx.syntax.family === 'fish';
  for (const c of shellTables(lx).commands) {
    if (c.offset < block.start || c.offset >= block.end) continue;
    const { name, at, args, argAt } = unwrap(c);
    const base = name.slice(name.lastIndexOf('/') + 1);
    const first = args[0] ?? '';
    const sourced = (name === 'source' || name === '.')
      && (fish ? c.piped && (first === '' || first === '-') : first === '/dev/stdin' || first.startsWith('<(') || (c.piped && first === '-'));
    const shell = SHELLS.has(base) && ((c.piped && readsStdin(args)) || runsFetched(lx.text, args, argAt, fish));
    if (name === 'eval' || sourced || shell) out.push({ start: at, end: at + name.length });
  }
  return out;
};

/**
 * Danger marks that are not one identifier: casts written with parentheses,
 * Kotlin's `!!`, suppressed cast checks, and a shell or fish command that runs
 * code from somewhere else.
 */
const CAST_LANGUAGES = new Map<string, CastRule>([
  ['c', cCasts], ['cpp', (lx, b) => (isObjc(lx) ? objcDanger(lx, b) : cPointerCasts(lx, b))], ['cuda-cpp', cCasts], ['metal', cCasts], ['objective-c', objcDanger], ['objective-cpp', objcDanger], ['swift', swiftDanger],
  ['java', jvmCasts], ['kotlin', ktCasts], ['shellscript', shellDanger], ['fish', shellDanger],
]);

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

/** C++ `reinterpret_cast<T>` and `const_cast<T>`: Zig's `@ptrCast` and `@constCast`. `static_cast`, `dynamic_cast` and `std::bit_cast` are checked. */
const cppCast: DangerRule = (lx, id) => (id.name === 'reinterpret_cast' || id.name === 'const_cast') && lx.text[nextIndex(lx.text, id.offset + id.length)] === '<';

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
  ['zig', (_lx, id) => ZIG_DANGER.has(id.name)],
  ['cpp', cppCast],
  ['cuda-cpp', cppCast],
  ['objective-cpp', cppCast],
  ['metal', cppCast],
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
    return family === 'kotlin' || family === 'nested' || family === 'swift';
  }
  if (family === 'java' || family === 'c' || family === 'default' || family === 'nested' || family === 'swift') {
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
  // No oracle yet for which shell writes escape their function (docs/risk-marks.md#what-never-marks).
  if (family === 'sh' || family === 'fish') {
    return [];
  }
  const declSites: ReadonlySet<number> = c.declSites ?? EMPTY_SET;
  const staticNames: ReadonlySet<string> = c.staticNames ?? EMPTY_SET;
  const regions = c.excludeRanges && c.excludeRanges.length > 0 ? gaps(block, c.excludeRanges) : [block];
  const outerNames: ReadonlySet<string> =
    family === 'python' ? pyOuterNames(lx, block, c.enclosingFn) : EMPTY_SET;
  const selfRoots = family === 'python' ? PY_SELF_ROOTS : family === 'js' ? JS_SELF_ROOTS : family === 'zig' ? ZIG_SELF_ROOTS
    : family === 'c' || family === 'java' || family === 'kotlin' ? selfWords(lx.syntax) : SELF_ROOTS;
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
