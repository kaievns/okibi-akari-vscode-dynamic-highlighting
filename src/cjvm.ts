/**
 * C, C++, Java, Kotlin and Groovy facts the classifier reads: preprocessor lines,
 * template parameter lists, type bodies, Java lambda and pattern bindings, Kotlin
 * constructor parameters, Groovy closure parameters, and the shape of
 * kotlin-language-server's tokens. Rules: docs/c-jvm.md.
 */

import { LexId, LexResult } from './lex';
import { buildIntervalIndex, bestAt } from './intervals';
import type { BraceBlock } from './focus';
import type { DecodedToken } from './classify';

interface Range {
  start: number;
  end: number;
}

const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{ID_Continue}$]/u.test(c);

function nextCode(lx: LexResult, i: number): number {
  const t = lx.text;
  while (i < t.length) {
    if (/\s/.test(t[i])) {
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

/** `(`/`[`/`{` or `<` matched forward from `open`, skipping non-code; -1 when unclosed. */
function closeOf(lx: LexResult, open: number, limit = 4000): number {
  const t = lx.text;
  const o = t[open];
  const c = o === '(' ? ')' : o === '[' ? ']' : o === '{' ? '}' : '>';
  let depth = 0;
  for (let i = open; i < t.length && i - open < limit; i++) {
    if (!lx.isCode(i)) continue;
    const ch = t[i];
    if (ch === o) depth++;
    else if (ch === c && !(c === '>' && t[i - 1] === '-')) {
      if (--depth === 0) return i;
    } else if (c === '>' && (ch === ';' || ch === '{' || ch === '}')) return -1;
  }
  return -1;
}

const directiveMemo = new WeakMap<LexResult, Range[]>();

/** Every C-family `#` directive line, `\` continuations included: macro bodies and conditions are not data. */
export function cDirectiveRanges(lx: LexResult): Range[] {
  const hit = directiveMemo.get(lx);
  if (hit) return hit;
  const out: Range[] = [];
  const t = lx.text;
  const ls = lx.lineStarts;
  for (let l = 0; l < ls.length; l++) {
    let i = ls[l];
    while (t[i] === ' ' || t[i] === '\t') i++;
    if (t[i] !== '#' || !lx.isCode(i)) continue;
    let end = l + 1 < ls.length ? ls[l + 1] - 1 : t.length;
    let k = l;
    while (k + 1 < ls.length && /\\\r?$/.test(t.slice(ls[k], end))) {
      k++;
      end = k + 1 < ls.length ? ls[k + 1] - 1 : t.length;
    }
    out.push({ start: i, end });
    l = k;
  }
  directiveMemo.set(lx, out);
  return out;
}

/** C++: the `<…>` of each `template <…>`; the names in it are template parameters. */
export function cppTemplateParams(lx: LexResult): Range[] {
  const out: Range[] = [];
  for (const id of lx.idents) {
    if (id.name !== 'template') continue;
    const open = nextCode(lx, id.offset + id.length);
    if (open < 0 || lx.text[open] !== '<') continue;
    const close = closeOf(lx, open);
    if (close > open) out.push({ start: open, end: close + 1 });
  }
  return out;
}

const ANON_CLASS = /\bnew\s+[\w$.]+(?:\s*<[^;{}]*>)?\s*\([^;{}]*\)\s*$/;
const C_ATTRIBUTE = /\[\[(?:[^\]]|\](?!\]))*\]\]|\b(?:__attribute__|__declspec|alignas)\s*(\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\))/g;
const TYPE_KEYWORDS: Record<string, ReadonlySet<string>> = {
  c: new Set(['class', 'struct', 'union', 'enum', '@interface', '@implementation', '@protocol']),
  java: new Set(['class', 'interface', 'enum', 'record', '@interface']),
  kotlin: new Set(['class', 'interface', 'object']),
};
const KOTLIN_NOT_TYPE_TAIL = new Set(['fun', 'val', 'var', 'get', 'set', 'init']);

/**
 * Does a block header open a type body? The header reaches back to the last `;`,
 * `{` or `}`, so it can carry `#include` lines, export macros, a `package` line or
 * an earlier Kotlin declaration: the last type keyword outside brackets decides,
 * and what follows it must name a type, not a function (`struct node *alloc(int n)`,
 * `data class A(val x: Int)` then `fun main()`).
 */
export function isTypeHeader(header: string, family: string): boolean {
  if (ANON_CLASS.test(header)) return true;
  const keywords = TYPE_KEYWORDS[family];
  if (!keywords) return false;
  const h = family === 'c' ? header.replace(C_ATTRIBUTE, (m) => ' '.repeat(m.length)) : header;
  const words: { word: string; at: number; depth: number }[] = [];
  let depth = 0;
  for (let i = 0; i < h.length; i++) {
    const c = h[i];
    if (c === '(' || c === '[' || c === '<') depth++;
    else if (c === ')' || c === ']' || (c === '>' && h[i - 1] !== '-')) depth = Math.max(0, depth - 1);
    else if (/[@\w$]/.test(c) && !/[\w$]/.test(h[i - 1] ?? '')) {
      const m = /^@?[\w$]+/.exec(h.slice(i, i + 40))!;
      words.push({ word: m[0], at: i, depth });
      i += m[0].length - 1;
    } else if (c === '=' && depth === 0) words.push({ word: '=', at: i, depth });
  }
  let k = -1;
  for (let j = words.length - 1; j >= 0; j--) {
    const w = words[j];
    if (w.depth !== 0 || !keywords.has(w.word)) continue;
    const before = h.slice(Math.max(0, w.at - 2), w.at);
    if (/\.\s*$|::$/.test(before)) continue;
    k = j;
    break;
  }
  if (k < 0) return false;
  const tail = words.slice(k + 1).filter((w) => w.depth === 0);
  if (tail.some((w) => w.word === '=' || (family === 'kotlin' && KOTLIN_NOT_TYPE_TAIL.has(w.word)))) return false;
  if (family === 'kotlin') return true;
  const rest = h.slice(words[k].at + words[k].word.length);
  const open = rest.search(/[(]/);
  if (open < 0) return true;
  // A Java record's components follow its name: `record P<T>(T x) implements Q`.
  return family === 'java' && words[k].word === 'record' && /^\s*[\w$]+\s*(?:<[^()]*>)?\s*$/.test(rest.slice(0, open)) && !/[(]/.test(rest.slice(closeAt(rest, open) + 1));
}

/** The `)` matching the `(` at `open` in plain text, else the text length. */
function closeAt(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return s.length;
}

/**
 * The text before `open` back to the last `;`, `{`, `}` or unmatched `(`/`[`, at most
 * 600 characters, non-code blanked. Walks `punct` and `spans`: per character it cost a
 * span lookup each, which made every keystroke's relex pay for every block (docs/c-jvm.md#cost).
 */
function headerText(lx: LexResult, open: number): string {
  const t = lx.text;
  const p = lx.punct;
  let start = Math.max(-1, open - 600);
  let depth = 0;
  for (let j = lx.punctFrom(open) - 1; j >= 0 && open - p[j] < 600; j--) {
    const c = t[p[j]];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      if (depth === 0) {
        start = p[j];
        break;
      }
      depth--;
    } else if (depth === 0 && (c === ';' || c === '{' || c === '}')) {
      start = p[j];
      break;
    }
  }
  const spans = lx.spans;
  let at = start + 1;
  let s = '';
  for (let k = Math.max(0, lx.spanIndexFrom(at) - 1); k < spans.length && spans[k].start < open; k++) {
    const sp = spans[k];
    if (sp.end <= at) continue;
    const from = Math.max(sp.start, at);
    const to = Math.min(sp.end, open);
    s += t.slice(at, from) + ' '.repeat(to - from);
    at = to;
  }
  return s + t.slice(at, open);
}

const typeBodyMemo = new WeakMap<LexResult, { blocks: BraceBlock[]; member: (offset: number) => boolean }>();
// Header text → isTypeHeader, across lexes: a keystroke's relex keeps every other header.
const headerVerdicts = new Map<string, boolean>();

function typeHeader(header: string, family: string, judge: typeof isTypeHeader): boolean {
  const key = `${family}\0${header}`;
  let v = headerVerdicts.get(key);
  if (v === undefined) {
    v = judge(header, family);
    if (headerVerdicts.size >= 20000) headerVerdicts.clear();
    headerVerdicts.set(key, v);
  }
  return v;
}

/**
 * Is `offset` directly in a type body (class, struct, union, interface, enum,
 * record, object, an anonymous class), not in a function inside it? A declaration
 * there is a member: band 1's steel, never data. A block's header is read only when
 * an offset in it is asked about, and its verdict outlives the lex (docs/c-jvm.md#cost).
 */
export function memberTest(lx: LexResult, blocks: BraceBlock[], judge = isTypeHeader): (offset: number) => boolean {
  const hit = typeBodyMemo.get(lx);
  if (hit && hit.blocks === blocks) return hit.member;
  const t = lx.text;
  const real = blocks.filter((b) => t[b.openOffset] === '{');
  const starts = real.map((b) => b.openOffset + 1);
  const ends = real.map((b) => b.closeOffset);
  const index = buildIntervalIndex(starts, ends, (a, b) => starts[b] - starts[a] || a - b);
  const isType: (boolean | undefined)[] = new Array(real.length);
  const member = (offset: number): boolean => {
    const k = bestAt(index, offset);
    if (k < 0) return false;
    return (isType[k] ??= typeHeader(headerText(lx, real[k].openOffset), lx.syntax.family, judge));
  };
  typeBodyMemo.set(lx, { blocks, member });
  return member;
}

/** Kotlin `class A(val x: Int)` / `constructor(var y: T)`: a property in a constructor's parameter list. */
export function kotlinCtorProperty(lx: LexResult, keywordAt: number): boolean {
  const open = lx.enclosingOpen(keywordAt);
  if (open < 0 || lx.text[open] !== '(') return false;
  const before = headerText(lx, open);
  return /\b(?:class\s+[\w$]+(?:\s*<[^{}]*>)?(?:\s*(?:private|protected|internal|public)?\s*(?:@\w+\s*)*constructor)?|constructor)\s*$/.test(before);
}

const isKotlinValParam = (lx: LexResult, id: LexId): boolean => {
  const k = lx.prevSignificant(id.offset);
  return k >= 2 && /^va[lr]$/.test(lx.text.slice(k - 2, k + 1)) && !isWord(lx.text[k - 3]);
};

/**
 * Kotlin primary-constructor parameters without `val`/`var`, `class A(x: Int) {`:
 * data that the class's initializers read. With `val`/`var` they are properties.
 */
export function kotlinCtorParams(lx: LexResult, declare: (id: LexId) => void): void {
  const t = lx.text;
  for (const kw of lx.idents) {
    if (kw.name !== 'class') continue;
    const k = lx.punctFrom(kw.offset + kw.length);
    const open = lx.punct[k];
    if (open === undefined || t[open] !== '(' || !kotlinCtorProperty(lx, open + 1)) continue;
    const close = closeOf(lx, open);
    if (close < 0) continue;
    const after = nextCode(lx, close + 1);
    if (after < 0 || (t[after] !== '{' && t[after] !== ':')) continue;
    const level = lx.enclosingOpen(open);
    let bodyOpen = -1;
    for (let j = lx.punctFrom(close + 1); j < lx.punct.length; j++) {
      const at = lx.punct[j];
      if (t[at] === '{' && lx.enclosingOpen(at) === level) {
        bodyOpen = at;
        break;
      }
      if ((t[at] === '}' || t[at] === ')') && lx.enclosingOpen(at) === level) break;
    }
    // `class C(names: List<String>) { private val names = names.toList() }`: past its initializer, the name is the property.
    const shadowed = new Set<string>();
    const bodyClose = bodyOpen >= 0 ? closeOf(lx, bodyOpen, 1 << 30) : -1;
    if (bodyClose > bodyOpen) {
      for (const m of lx.identsIn(bodyOpen + 1, bodyClose)) {
        if (lx.enclosingOpen(m.offset) === bodyOpen && isKotlinValParam(lx, m)) shadowed.add(m.name);
      }
    }
    for (const id of lx.identsIn(open + 1, close)) {
      if (lx.enclosingOpen(id.offset) !== open || isKotlinValParam(lx, id) || shadowed.has(id.name)) continue;
      const n = nextCode(lx, id.offset + id.length);
      const p = lx.prevSignificant(id.offset);
      if (n >= 0 && t[n] === ':' && t[n + 1] !== ':' && (p === open || t[p] === ',' || isWord(t[p]))) declare(id);
    }
  }
}

/**
 * Java lambda parameters: `x ->`, `(a, b) ->`, `(String s, int n) ->`. Switch arms
 * (`case A ->`, `default ->`) bind nothing.
 */
export function javaLambdaParams(lx: LexResult, declare: (id: LexId) => void): void {
  const t = lx.text;
  for (let a = t.indexOf('->'); a >= 0; a = t.indexOf('->', a + 2)) {
    if (!lx.isCode(a)) continue;
    const p = lx.prevSignificant(a);
    if (p < 0) continue;
    if (t[p] === ')') {
      let depth = 0;
      let open = -1;
      for (let i = p; i >= 0 && p - i < 2000; i--) {
        if (!lx.isCode(i)) continue;
        if (t[i] === ')') depth++;
        else if (t[i] === '(' && --depth === 0) {
          open = i;
          break;
        }
      }
      if (open < 0) continue;
      const before = lx.prevSignificant(open);
      // `case Point(int x, int y) ->` is a record pattern (javaPatterns).
      if (before >= 0 && isWord(t[before])) continue;
      const inner = lx.identsIn(open + 1, p).filter((x) => lx.enclosingOpen(x.offset) === open);
      for (const id of inner) {
        const n = nextCode(lx, id.offset + id.length);
        if (n >= 0 && (t[n] === ',' || t[n] === ')')) declare(id);
      }
    } else if (isWord(t[p])) {
      const id = lx.identsIn(0, p + 1).pop();
      if (!id || id.offset + id.length !== p + 1) continue;
      const q = lx.prevSignificant(id.offset);
      const qc = q >= 0 ? t[q] : '';
      if (qc === '(' || qc === ',' || qc === '=' || qc === '?' || (qc === ':' && t[q - 1] !== ':') || /\breturn\s*$/.test(t.slice(Math.max(0, id.offset - 8), id.offset))) {
        if (!/\bcase\b[^;{}]*$/.test(t.slice(Math.max(0, id.offset - 200), id.offset))) declare(id);
      }
    }
  }
}

/** Groovy closure parameters, `{ a, b -> }` and `{ String s, int n = 1 -> }`: the name before each `,`, `=` or the `->`. */
export function groovyClosureParams(lx: LexResult, declare: (id: LexId) => void): void {
  const t = lx.text;
  for (let a = t.indexOf('->'); a >= 0; a = t.indexOf('->', a + 2)) {
    if (!lx.isCode(a)) continue;
    const open = lx.enclosingOpen(a);
    if (open < 0 || t[open] !== '{') continue;
    for (const id of lx.identsIn(open + 1, a)) {
      if (lx.enclosingOpen(id.offset) !== open || isInDefault(lx, open, id.offset)) continue;
      const n = nextCode(lx, id.offset + id.length);
      if (n === a || (n >= 0 && (t[n] === ',' || (t[n] === '=' && t[n + 1] !== '=')))) declare(id);
    }
  }
}

/** Is `offset` in a parameter's default value, after a depth-0 `=` and before the next `,`? */
function isInDefault(lx: LexResult, open: number, offset: number): boolean {
  const t = lx.text;
  let inDefault = false;
  let depth = 0;
  for (let i = open + 1; i < offset; i++) {
    if (!lx.isCode(i)) continue;
    const c = t[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && c === ',') inDefault = false;
    else if (depth === 0 && c === '=' && t[i + 1] !== '=') inDefault = true;
  }
  return inDefault;
}

const PATTERN_STOP = new Set(['when', 'instanceof', 'case']);

/**
 * Java pattern bindings: `x instanceof Type name`, `case Type name ->`, record
 * patterns `Point(int x, var y)`, each binding a name after a type.
 */
export function javaPatterns(lx: LexResult, declare: (id: LexId) => void): void {
  const t = lx.text;
  const ids = lx.idents;
  for (let i = 0; i < ids.length; i++) {
    const kw = ids[i];
    if (kw.name !== 'instanceof' && kw.name !== 'case') continue;
    let depth = 0;
    for (let j = i + 1; j < ids.length && j < i + 64; j++) {
      const id = ids[j];
      const gap = t.slice(ids[j - 1].offset + ids[j - 1].length, id.offset);
      for (const c of gap) {
        if (!lx.isCode(ids[j - 1].offset + ids[j - 1].length)) break;
        if (c === '(') depth++;
        else if (c === ')') depth--;
      }
      if (depth < 0 || /[;{}]|->|&&|\|\||[=?]/.test(gap.replace(/\s+/g, '')) && depth === 0 && j > i + 1) break;
      if (PATTERN_STOP.has(id.name)) break;
      const prev = ids[j - 1];
      if (prev === kw) continue;
      const p = lx.prevSignificant(id.offset);
      const pc = p >= 0 ? t[p] : '';
      const n = nextCode(lx, id.offset + id.length);
      const nc = n >= 0 ? t[n] : '';
      const typed = (p === prev.offset + prev.length - 1 && prev.name !== 'case' && prev.name !== 'instanceof' && prev.name !== 'final') || pc === '>' || pc === ']';
      const ends = nc === ')' || nc === ',' || nc === '&' || nc === '|' || nc === ':' || nc === ';' || (nc === '-' && t[n + 1] === '>')
        || (n >= 0 && t.startsWith('when', n) && !isWord(t[n + 4]));
      if (typed && ends) declare(id);
    }
  }
}

/**
 * kotlin-language-server 1.3.13: a `$name` template is one extra `variable` token
 * over `$name` on top of the name's own; a local `val`/`var` is
 * `property.declaration` though its reads are `variable`. Drop the first, retype
 * the second when it is a local (`kotlinLocal`). A constructor `val`/`var` is a
 * property, whatever the server types it.
 */
export function kotlinTokens(lx: LexResult, tokens: readonly DecodedToken[], member: (offset: number) => boolean): DecodedToken[] {
  const t = lx.text;
  const out: DecodedToken[] = [];
  for (const tok of tokens) {
    if (t[tok.offset] === '$' && tok.length > 1) continue;
    if (tok.type === 'property' && tok.modifiers.includes('declaration') && kotlinLocal(lx, tok.offset, member)) {
      out.push({ ...tok, type: 'variable' });
      continue;
    }
    if (tok.type === 'parameter') {
      const k = lx.prevSignificant(tok.offset);
      const word = k >= 2 ? t.slice(k - 2, k + 1) : '';
      if ((word === 'val' || word === 'var') && !isWord(t[k - 3]) && kotlinCtorProperty(lx, k - 2)) {
        out.push({ ...tok, type: 'property' });
        continue;
      }
    }
    out.push(tok);
  }
  return out;
}

/** A Kotlin `val`/`var` inside a block that is not a type body: a local. At top level or in a type body it is a property. */
export function kotlinLocal(lx: LexResult, offset: number, member: (offset: number) => boolean): boolean {
  return lx.enclosingOpen(offset) >= 0 && !member(offset);
}

/** C and C++ `typedef … ;`: every declarator in it names a type. */
export function cTypedefRanges(lx: LexResult): Range[] {
  const out: Range[] = [];
  const t = lx.text;
  for (const id of lx.idents) {
    if (id.name !== 'typedef') continue;
    let depth = 0;
    let i = id.offset + id.length;
    for (; i < t.length && i - id.offset < 20000; i++) {
      if (!lx.isCode(i)) continue;
      const c = t[i];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') {
        if (--depth < 0) break;
      } else if (c === ';' && depth === 0) break;
    }
    out.push({ start: id.offset, end: i });
  }
  return out;
}

/**
 * A parameter of a signature with no body: a prototype, a function-pointer member or
 * typedef, an abstract or interface method. It names nothing at run time, as a type
 * signature's parameter does (docs/classification-rules.md#type-declarations-are-not-data).
 * A Java or Kotlin lambda's parameters sit outside every function when it initialises a field.
 */
export function signatureParameter(lx: LexResult, offset: number, inFunction: (offset: number) => boolean): boolean {
  if (inFunction(offset) || (lx.syntax.family === 'kotlin' && kotlinCtorProperty(lx, offset))) return false;
  const open = lx.enclosingOpen(offset);
  const t = lx.text;
  if (open >= 0 && t[open] === '{') return false;
  if (open < 0 || t[open] !== '(') return !/^\s*->/.test(t.slice(offset).replace(/^[\w$]+/, ''));
  const close = closeOf(lx, open);
  if (close < 0) return true;
  const after = nextCode(lx, close + 1);
  return !(after >= 0 && t.startsWith('->', after) && lx.syntax.family === 'java');
}

const C_CONSTANTS = new Set(['NULL', 'true', 'false']);

/**
 * C-family `NULL`, `true` and `false`, and `bool`: cpptools and clangd send `macro` over
 * each, a bold call, where the grammar paints a constant and a keyword. The name a
 * `#define` or `#undef` defines and a `defined(…)` operand keep the grammar's call
 * (docs/c-jvm.md#band-1-restores).
 */
const macroRestoreMemo = new WeakMap<LexResult, { constants: Range[]; keywords: Range[] }>();

export function cMacroRestores(lx: LexResult): { constants: Range[]; keywords: Range[] } {
  const hit = macroRestoreMemo.get(lx);
  if (hit) return hit;
  const constants: Range[] = [];
  const keywords: Range[] = [];
  const t = lx.text;
  const ids = lx.idents;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const constant = C_CONSTANTS.has(id.name);
    if (!constant && id.name !== 'bool') continue;
    if (/^[ \t]*#[ \t]*(?:define|undef)[ \t]+$/.test(t.slice(lx.lineStarts[lx.lineOf(id.offset)], id.offset))) continue;
    const prev = ids[i - 1];
    if (prev?.name === 'defined' && /^\s*\(\s*$/.test(t.slice(prev.offset + prev.length, id.offset))) continue;
    (constant ? constants : keywords).push({ start: id.offset, end: id.offset + id.length });
  }
  const out = { constants, keywords };
  macroRestoreMemo.set(lx, out);
  return out;
}

/**
 * Kotlin `$name` templates, `$` and name: kotlin-language-server sends `variable` over
 * them, the page colour, where the grammar paints a placeholder.
 */
export function kotlinTemplateSpans(lx: LexResult): Range[] {
  if (lx.syntax.family !== 'kotlin') return [];
  const t = lx.text;
  return lx.holes.filter((h) => t[h.start - 1] === '$' && t[h.start] !== '{').map((h) => ({ start: h.start - 1, end: h.end }));
}
