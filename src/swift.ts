/**
 * Swift facts the classifier reads: which identifiers declare a data binding, and the
 * binding every other identifier resolves to by lexical scope. sourcekit-lsp sends no
 * token at a declaration and types a parameter's reads `variable`, so its tokens are
 * normalised against these facts (`swiftTokens`). Rules: docs/swift.md.
 */

import { LexId, LexRange, LexResult } from './lex';
import type { DecodedToken } from './classify';

export type SwiftDeclKind = 'local' | 'param' | 'closureParam' | 'capture' | 'global' | 'implicit';

export interface SwiftDecl {
  name: string;
  /** Offset of the declaring identifier; for an implicit one (`$0`, `newValue`, `error`), the scope's `{`. */
  offset: number;
  kind: SwiftDeclKind;
  /** Visible in [from, to]. */
  from: number;
  to: number;
}

export interface SwiftFacts {
  /** Identifiers that declare a local, a parameter, a closure parameter or capture, or a file-scope variable. */
  declSites: Set<number>;
  /** Per identifier that is data: the offset of the declaration it resolves to (an implicit one's scope `{`). */
  binding: Map<number, number>;
  decls: Map<number, SwiftDecl>;
  /** `{` offsets whose block is a type body (struct, class, enum, actor, protocol, extension). */
  typeBodies: Set<number>;
  /** `{` offsets whose block is a function-like scope: func, init, deinit, subscript, accessor, computed getter, closure. */
  functionBodies: Set<number>;
  /** Getters and accessors without a parameter list: their scope starts at the brace. */
  inlineParams: Set<number>;
  /** `{` offsets that open a closure. */
  closures: Set<number>;
}

const memo = new WeakMap<LexResult, SwiftFacts>();

export function swiftFacts(lx: LexResult): SwiftFacts {
  let f = memo.get(lx);
  if (!f) {
    f = compute(lx);
    memo.set(lx, f);
  }
  return f;
}

/** Words that are never a data name in Swift code (keywords and contextual keywords in their usual places). */
export const SWIFT_KEYWORDS = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout', 'internal',
  'let', 'open', 'operator', 'private', 'precedencegroup', 'protocol', 'public', 'rethrows', 'static', 'struct',
  'subscript', 'typealias', 'var', 'break', 'case', 'catch', 'continue', 'default', 'defer', 'do', 'else',
  'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return', 'throw', 'switch', 'where', 'while', 'Any', 'as',
  'await', 'false', 'is', 'nil', 'self', 'Self', 'super', 'throws', 'true', 'try', 'async', 'actor', 'some', 'any',
  'each', 'consume', 'borrowing', 'consuming', 'mutating', 'nonmutating', 'override', 'final', 'lazy', 'weak',
  'unowned', 'required', 'convenience', 'dynamic', 'optional', 'indirect', 'nonisolated', 'isolated', 'package',
  'macro', 'get', 'set', 'willSet', 'didSet', 'Type', 'Protocol', 'prefix', 'postfix', 'infix', 'distributed',
  '_', 'sending', 'discard', 'then', 'unsafe',
]);

const TYPE_WORDS = new Set(['struct', 'class', 'enum', 'actor', 'protocol', 'extension']);
const FUNCTION_WORDS = new Set(['func', 'init', 'deinit', 'subscript']);
const ACCESSOR_WORDS = new Set(['get', 'set', 'willSet', 'didSet', '_read', '_modify', 'init', 'read', 'modify']);
const MODIFIERS = new Set([
  'public', 'private', 'fileprivate', 'internal', 'open', 'package', 'static', 'class', 'final', 'override', 'mutating',
  'nonmutating', 'lazy', 'weak', 'unowned', 'required', 'convenience', 'dynamic', 'optional', 'indirect', 'nonisolated',
  'isolated', 'distributed', 'prefix', 'postfix', 'infix', 'consuming', 'borrowing', 'async', 'throws', 'rethrows',
]);
/** Keywords a closure's parameter clause may hold. */
const CLOSURE_HEAD_WORDS = new Set(['_', 'inout', 'async', 'throws', 'some', 'any', 'sending', 'borrowing', 'consuming', 'rethrows']);
const CONTROL_WORDS = new Set(['if', 'guard', 'for', 'while', 'switch', 'do', 'catch', 'else', 'repeat', 'defer']);
/** A `{` after one of these, on its line, opens a closure (an argument or a value), not a statement block. */
const VALUE_WORDS = new Set(['return', 'in', 'try', 'await', 'throw', 'yield', 'then']);

type Kind = 'type' | 'function' | 'accessors' | 'getter' | 'accessorsOrGetter' | 'control' | 'closure' | 'other';

const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{ID_Continue}$`]/u.test(c);

function compute(lx: LexResult): SwiftFacts {
  const text = lx.text;
  const ids = lx.idents;
  const P = lx.punct;

  const close = new Map<number, number>();
  const stack: number[] = [];
  for (const p of P) {
    const c = text[p];
    if (c === '(' || c === '[' || c === '{') stack.push(p);
    else if (c === ')' || c === ']' || c === '}') {
      const o = stack.pop();
      if (o !== undefined) close.set(o, p);
    }
  }
  const braces = P.filter((p) => text[p] === '{');
  const idAt = new Map<number, number>();
  ids.forEach((id, k) => idAt.set(id.offset, k));
  const firstIdFrom = (offset: number): number => {
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ids[mid].offset < offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Only a blank or a comment's closing `/` can stand between code and the code before it.
  const prevChar = (o: number): number => {
    const c = text.charCodeAt(o - 1);
    return c === 32 || c === 9 || c === 10 || c === 13 || c === 47 ? lx.prevSignificant(o) : o - 1;
  };
  // From code, only a `/` can open a comment to skip.
  const nextSig = (o: number): number => {
    let i = o;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        i++;
        continue;
      }
      const s = c === 47 ? lx.spanAt(i) : undefined;
      if (s && s.region !== 'string') {
        i = s.end;
        continue;
      }
      return i;
    }
    return -1;
  };

  // Statement start for a `{`: back over wrapped lines (a line ending in `,`, `(`, an operator, or the
  // next starting with `.`, `,`, `where`, `else`, `->`, `throws`, `async`, `)`), to the line start.
  const lineStart = (o: number): number => lx.lineStarts[lx.lineOf(o)];
  const headerStart = (open: number): number => {
    let s = lineStart(open);
    for (let step = 0; step < 12; step++) {
      const first = nextSig(s);
      const lead = first >= 0 ? text.slice(first, first + 8) : '';
      if (first >= 0 && text[first] === '}') return first + 1;
      const p = prevChar(s);
      if (p < 0) return s;
      const continues = /^(?:\.(?!\.)|,|&&|\|\||->|where\b|throws\b|async\b|\)|\]|\?\?|[+\-*/%]=?\s)/.test(lead)
        || /[,(&|=+\-*/%<>[:]$/.test(text[p]);
      // An unclosed `(` or `[` from an earlier line holds this one.
      const open1 = lx.enclosingOpen(s);
      const held = open1 >= 0 && text[open1] !== '{' && open1 < s;
      if (!continues && !held) return s;
      s = lineStart(held ? open1 : p);
    }
    return s;
  };

  const kinds = new Map<number, Kind>();
  const headers = new Map<number, number>();
  const kindOf = (open: number): Kind => {
    const hit = kinds.get(open);
    if (hit) return hit;
    const hs = headerStart(open);
    headers.set(open, hs);
    let k: Kind = 'other';
    const p = prevChar(open);
    const pc = p >= 0 ? text[p] : '';
    // First word of the statement at bracket depth 0, past attributes and modifiers.
    let first: LexId | undefined;
    let i = firstIdFrom(hs);
    for (; i < ids.length && ids[i].offset < open; i++) {
      const id = ids[i];
      const before = text[id.offset - 1];
      if (before === '@') {
        // `@Attr` and its `(…)` arguments.
        const n = nextSig(id.offset + id.length);
        if (n >= 0 && text[n] === '(' && close.has(n)) i = firstIdFrom(close.get(n)!) - 1;
        continue;
      }
      if (i === firstIdFrom(hs) && text[nextSig(id.offset + id.length)] === ':' && text[nextSig(id.offset + id.length) + 1] !== ':' && CONTROL_WORDS.has(ids[i + 1]?.name ?? '')) {
        continue; // `outer: for row in grid {`
      }
      if (MODIFIERS.has(id.name) && !(id.name === 'class' && !isModifierClass(id))) {
        const n = nextSig(id.offset + id.length);
        if (n >= 0 && text[n] === '(' && close.has(n)) i = firstIdFrom(close.get(n)!) - 1;
        continue;
      }
      first = id;
      break;
    }
    function isModifierClass(id: LexId): boolean {
      const nx = ids[idAt.get(id.offset)! + 1];
      return nx !== undefined && (nx.name === 'func' || nx.name === 'var' || nx.name === 'let' || nx.name === 'subscript' || nx.name === 'override' || nx.name === 'final');
    }
    const enclosing = lx.enclosingOpen(open);
    const enclosingKind = enclosing >= 0 && text[enclosing] === '{' ? kindOf(enclosing) : 'type';
    if (first && first.offset < open) {
      const w = first.name;
      if (TYPE_WORDS.has(w)) k = 'type';
      else if (FUNCTION_WORDS.has(w)) k = w === 'subscript' ? 'accessorsOrGetter' : 'function';
      else if ((w === 'var' || w === 'let') && (accessorBlock(open) || !depth0Equals(first.offset, open))) k = 'accessorsOrGetter';
      else if (ACCESSOR_WORDS.has(w) && enclosingKind === 'accessors' && (open - (first.offset + first.length) < 40)) k = 'function';
      else if (CONTROL_WORDS.has(w)) k = 'control';
      else if (w === 'case' || w === 'default') k = 'other';
    }
    if (k === 'other') {
      if (pc === '(' || pc === ',' || pc === '=' || pc === ':' || pc === '[' || pc === '{' || pc === '?' || (p >= 0 && VALUE_WORDS.has(wordEndingAt(p)))) k = 'closure';
      else if (pc === ')' || pc === ']' || pc === '>' || pc === '!' || (isWord(pc) && (memberWord(p) || (!CONTROL_WORDS.has(wordEndingAt(p)) && !SWIFT_KEYWORDS.has(wordEndingAt(p)))))) k = 'closure';
      else if (pc === '}' && first === undefined) k = 'closure';
    }
    if (k === 'accessorsOrGetter') {
      // `var x: T { get … set … }` / `{ willSet … didSet … }` hold accessors; anything else is a getter body.
      k = accessorBlock(open) ? 'accessors' : 'getter';
    }
    kinds.set(open, k);
    return k;
  };
  /** The block opens with an accessor: `{ get`, `{ willSet {`, `{ didSet(old) {`. */
  function accessorBlock(open: number): boolean {
    const n = nextSig(open + 1);
    const word = n >= 0 ? /^[A-Za-z_]\w*/.exec(text.slice(n, n + 12))?.[0] : undefined;
    if (word === undefined || !ACCESSOR_WORDS.has(word)) return n >= 0 && text[n] === '@';
    const a = nextSig(n + word.length);
    return a >= 0 && (text[a] === '{' || text[a] === '(' || text[a] === '}' || /^(?:async|throws|mutating|nonmutating)\b/.test(text.slice(a)) || lx.lineOf(a) > lx.lineOf(n));
  }
  /** The word ending at `p` follows a member `.`: `.init {`, `x.map {`. */
  function memberWord(p: number): boolean {
    let q = p;
    while (q > 0 && isWord(text[q - 1])) q--;
    return text[q - 1] === '.' && text[q - 2] !== '.';
  }
  function wordEndingAt(p: number): string {
    let s = p;
    while (s > 0 && isWord(text[s - 1])) s--;
    return isWord(text[p]) ? text.slice(s, p + 1) : '';
  }
  // Is there an `=` at bracket depth 0 between a statement's first word and `to`? Each statement is
  // scanned once, however many `{` it holds (`let routes: [Route] = [` and a closure per row).
  const eqScans = new Map<number, { at: number; depth: number; eq: number }>();
  function depth0Equals(from: number, to: number): boolean {
    let st = eqScans.get(from);
    if (!st) eqScans.set(from, (st = { at: from, depth: 0, eq: -1 }));
    if (st.eq >= 0) return st.eq < to;
    for (; st.at < to; st.at++) {
      const c = text[st.at];
      if (c === '(' || c === '[' || c === '<') st.depth++;
      else if (c === ')' || c === ']' || c === '>') st.depth = Math.max(0, st.depth - 1);
      else if (c === '=' && st.depth === 0) {
        st.eq = st.at;
        return true;
      }
    }
    return false;
  }
  for (const b of braces) kindOf(b);

  const typeBodies = new Set<number>();
  const functionBodies = new Set<number>();
  const inlineParams = new Set<number>();
  const closures = new Set<number>();
  for (const b of braces) {
    const k = kinds.get(b)!;
    if (k === 'type') typeBodies.add(b);
    if (k === 'closure') closures.add(b);
    if (k === 'function' || k === 'getter' || k === 'closure') functionBodies.add(b);
    if (k === 'getter' || (k === 'function' && !/[)]\s*(?:async|throws|rethrows|->|where|[^{]*)?$/.test(text.slice(headers.get(b) ?? b, b).replace(/\s+$/, '')))) inlineParams.add(b);
  }
  const blockOf = (o: number): number => {
    for (let e = lx.enclosingOpen(o); e >= 0; e = lx.enclosingOpen(e)) if (text[e] === '{') return e;
    return -1;
  };
  /** The innermost `{` holding `o` and whether that block is a type body or the file. */
  const atTypeOrFile = (o: number): 'type' | 'file' | 'code' => {
    const b = blockOf(o);
    if (b < 0) return 'file';
    const k = kinds.get(b)!;
    if (k === 'type') return 'type';
    if (k === 'accessors') return 'type';
    return 'code';
  };

  const decls = new Map<number, SwiftDecl>();
  const byName = new Map<string, SwiftDecl[]>();
  const declSites = new Set<number>();
  const labels = new Set<number>();
  const notData = new Set<number>();
  const add = (id: LexId, kind: SwiftDeclKind, from: number, to: number): void => {
    if (id.name === '_' || SWIFT_KEYWORDS.has(id.name) || id.name.startsWith('#')) return;
    if (decls.has(id.offset)) return;
    const d: SwiftDecl = { name: id.name, offset: id.offset, kind, from, to };
    decls.set(id.offset, d);
    const list = byName.get(id.name);
    if (list) list.push(d);
    else byName.set(id.name, [d]);
    declSites.add(id.offset);
  };
  const end = text.length;
  const blockEnd = (open: number): number => close.get(open) ?? end;

  /** Identifiers bound by a pattern in [from, to): `(a, b)`, `.some(let x)`, `let .pair(a, b)`, `x?`; not labels, members or types. */
  const patternIds = (from: number, to: number, bindAll: boolean): LexId[] => {
    const out: LexId[] = [];
    let k = firstIdFrom(from);
    let binding = bindAll;
    for (; k < ids.length && ids[k].offset < to; k++) {
      const id = ids[k];
      if (id.name === 'let' || id.name === 'var') {
        binding = true;
        continue;
      }
      if (SWIFT_KEYWORDS.has(id.name) || id.name.startsWith('#')) continue;
      const p = prevChar(id.offset);
      if (p >= 0 && text[p] === '.' && text[p - 1] !== '.') continue;
      const n = nextSig(id.offset + id.length);
      if (n >= 0 && text[n] === ':' && text[n + 1] !== ':') {
        // `left: let l` is a label; `x: Int` after `let` is an annotation of a binding.
        const lp = p >= 0 ? text[p] : '';
        if (lp === '(' || lp === ',') {
          if (!binding || (ids[k + 1] && (ids[k + 1].name === 'let' || ids[k + 1].name === 'var'))) {
            labels.add(id.offset);
            continue;
          }
        }
      }
      if (n >= 0 && (text[n] === '(' || text[n] === '.')) continue;
      if (/^[A-Z]/.test(id.name) && !binding) continue;
      // Past an annotation `: T` or `as T`, names are types.
      const pk = ids[k - 1];
      if (pk && (pk.name === 'as' || pk.name === 'is')) continue;
      if (p >= 0 && text[p] === ':' && text[p - 1] !== ':' && binding) continue;
      if (binding) out.push(id);
    }
    return out;
  };

  /** The `{` that a condition or loop header starting after `from` opens: the first code `{` at depth 0 that is a block, not a closure argument. */
  const bodyAfter = (from: number): number => {
    const scope = lx.enclosingOpen(from);
    const limit = scope >= 0 ? (close.get(scope) ?? end) : end;
    let lo = 0;
    let hi = braces.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (braces[mid] <= from) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < braces.length && braces[k] < limit; k++) {
      const b = braces[k];
      const e = lx.enclosingOpen(b);
      if (e === scope) return b;
      // A brace nested in a bracket after `from` (a closure argument): skip past its block.
      const c = close.get(b);
      if (c !== undefined) while (k + 1 < braces.length && braces[k + 1] < c) k++;
    }
    return -1;
  };

  /** `let`/`var` declarators from the keyword at index i: `let a = 1, b: Int`, `let (a, b) = t`. */
  const declarators = (i: number, kind: SwiftDeclKind, from: number, to: number): void => {
    let k = i + 1;
    const id = ids[i];
    let at = nextSig(id.offset + id.length);
    for (let step = 0; step < 32 && at >= 0; step++) {
      if (text[at] === '(') {
        const c = close.get(at) ?? at;
        for (const b of patternIds(at, c, true)) add(b, kind, from, to);
        at = nextSig(c + 1);
      } else if (ids[k] && ids[k].offset === at) {
        add(ids[k], kind, Math.max(from, ids[k].offset), to);
        at = nextSig(at + ids[k].length);
      } else break;
      // Skip an annotation and an initializer to a depth-0 `,`, the line end or a `{`.
      let j = at;
      let d = 0;
      while (j >= 0 && j < text.length) {
        const c = text[j];
        if (!lx.isCode(j)) {
          j = (lx.spanAt(j)?.end ?? j + 1);
          continue;
        }
        if (c === '(' || c === '[' || c === '{') {
          if (c === '{' && d === 0) {
            j = -1;
            break;
          }
          d++;
        } else if (c === ')' || c === ']' || c === '}') {
          if (d === 0) {
            j = -1;
            break;
          }
          d--;
        } else if (c === '\n' && d === 0) {
          const nx = nextSig(j);
          if (nx < 0 || !/^(?:\.|,|&&|\|\||\?\?|[+\-*/%]|as\b|is\b)/.test(text.slice(nx, nx + 3))) {
            j = -1;
            break;
          }
        } else if (c === ',' && d === 0) break;
        else if (c === ';' && d === 0) {
          j = -1;
          break;
        }
        j++;
      }
      if (j < 0 || j >= text.length) break;
      at = nextSig(j + 1);
      if (at < 0) break;
      // `if let a = x, let b = y`: the next declarator has its own keyword.
      if (ids[firstIdFrom(at)]?.offset === at && (ids[firstIdFrom(at)].name === 'let' || ids[firstIdFrom(at)].name === 'var' || ids[firstIdFrom(at)].name === 'case')) break;
      k = firstIdFrom(at);
    }
  };

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const p = prevChar(id.offset);
    if (p >= 0 && text[p] === '.' && text[p - 1] !== '.') continue;
    if (id.name === 'let' || id.name === 'var') {
      const where = atTypeOrFile(id.offset);
      // In a condition: `if let`, `guard let`, `while let`, `case let`, `, let`.
      const stmt = statementWord(i);
      if (stmt === 'guard') {
        const scope = blockOf(id.offset);
        declarators(i, 'local', id.offset, scope >= 0 ? blockEnd(scope) : end);
        continue;
      }
      if (stmt === 'if' || stmt === 'while') {
        const g = stmtStartIndex(i);
        const body = g >= 0 ? bodyAfter(ids[g].offset) : -1;
        declarators(i, 'local', id.offset, body >= 0 ? blockEnd(body) : id.offset);
        continue;
      }
      if (stmt === 'case' || stmt === 'catch' || stmt === 'for') continue; // patterns, below
      if (where === 'type') {
        // A property: its name is band 1, never data.
        let k = i + 1;
        if (ids[k]) notData.add(ids[k].offset);
        while (ids[k] && ids[k + 1] && /^\s*,\s*$/.test(text.slice(ids[k].offset + ids[k].length, ids[k + 1].offset))) notData.add(ids[++k].offset);
        continue;
      }
      if (where === 'file') {
        declarators(i, 'global', 0, end);
        continue;
      }
      const scope = blockOf(id.offset);
      declarators(i, 'local', id.offset, scope >= 0 ? blockEnd(scope) : end);
      continue;
    }
    if (id.name === 'for') {
      // `for x in`, `for (k, v) in`, `for case let .some(x) in`, `for try await x in`.
      let k = i + 1;
      while (ids[k] && (ids[k].name === 'try' || ids[k].name === 'await')) k++;
      let inAt = -1;
      for (let j = k; j < ids.length && j < k + 40; j++) {
        if (ids[j].name === 'in' && lx.enclosingOpen(ids[j].offset) === lx.enclosingOpen(id.offset)) {
          inAt = j;
          break;
        }
        if (text.slice(id.offset, ids[j].offset).includes('{')) break;
      }
      if (inAt < 0) continue;
      const body = bodyAfter(ids[inAt].offset);
      const caseLet = ids[k]?.name === 'case';
      for (const b of patternIds(ids[caseLet ? k + 1 : k].offset, ids[inAt].offset, !caseLet)) {
        add(b, 'local', id.offset, body >= 0 ? blockEnd(body) : id.offset);
      }
      continue;
    }
    if (id.name === 'case' || id.name === 'catch') {
      // `case .x(let a)`, `case let .x(a, b)`, `case let x as T`: bound to the next case or the block end.
      const isCatch = id.name === 'catch';
      const enclosing = blockOf(id.offset);
      if (!isCatch && enclosing >= 0 && kinds.get(enclosing) === 'type') continue; // an enum case
      let stop = -1;
      if (isCatch) {
        stop = bodyAfter(id.offset);
      } else {
        // The pattern ends at the depth-0 `:` (switch) or at `=` / `,` / `{` (if case, for case).
        for (let j = id.offset + id.length; j < text.length; j++) {
          if (!lx.isCode(j)) {
            j = (lx.spanAt(j)?.end ?? j + 1) - 1;
            continue;
          }
          const c = text[j];
          if (c === '(' || c === '[') {
            j = close.get(j) ?? j;
            continue;
          }
          if ((c === ':' && text[j + 1] !== ':') || c === '=' || c === '{' || c === '\n') {
            stop = j;
            break;
          }
        }
      }
      if (stop < 0) continue;
      const pat = text.slice(id.offset, stop);
      if (!/\b(?:let|var)\b/.test(pat)) {
        if (isCatch && !/\S/.test(text.slice(id.offset + id.length, stop))) {
          // `catch {`: an implicit `error`.
          implicit('error', stop, blockEnd(stop));
        }
        continue;
      }
      let from: number;
      let to: number;
      if (isCatch) {
        from = stop;
        to = blockEnd(stop);
      } else if (text[stop] === ':') {
        from = stop;
        to = nextCaseOrEnd(id.offset, enclosing);
      } else {
        // `if case let`, `guard case let`: as the condition's binding.
        const stmt = statementWord(i);
        const g = stmtStartIndex(i);
        if (g < 0) continue;
        const body = bodyAfter(ids[g].offset);
        if (stmt === 'guard') {
          from = body >= 0 ? blockEnd(body) : stop;
          to = enclosing >= 0 ? blockEnd(enclosing) : end;
        } else {
          from = body >= 0 ? body : stop;
          to = body >= 0 ? blockEnd(body) : stop;
        }
      }
      const letFirst = ids[i + 1] && (ids[i + 1].name === 'let' || ids[i + 1].name === 'var');
      for (const b of patternIds(id.offset + id.length, stop, letFirst)) add(b, 'local', from, to);
      continue;
    }
    if (FUNCTION_WORDS.has(id.name) && id.name !== 'deinit') {
      let at = nextSig(id.offset + id.length);
      if (id.name === 'func') {
        while (at >= 0 && at < text.length && text[at] !== '(' && text[at] !== '{' && text[at] !== '\n') at++;
      } else {
        while (at >= 0 && (text[at] === '?' || text[at] === '!')) at++;
        if (at >= 0 && text[at] === '<') {
          let d = 0;
          for (; at < text.length; at++) {
            if (text[at] === '<') d++;
            else if (text[at] === '>' && --d === 0) {
              at++;
              break;
            }
          }
          at = nextSig(at);
        }
      }
      if (at < 0 || text[at] !== '(') continue;
      const pclose = close.get(at);
      if (pclose === undefined) continue;
      const body = functionBodyAfter(pclose);
      params(at, pclose, body, 'param');
      continue;
    }
    if (ACCESSOR_WORDS.has(id.name) && (id.name === 'set' || id.name === 'willSet' || id.name === 'didSet')) {
      const n = nextSig(id.offset + id.length);
      if (n < 0) continue;
      const b = text[n] === '(' ? nextSig((close.get(n) ?? n) + 1) : n;
      if (b < 0 || text[b] !== '{' || kinds.get(b) !== 'function') continue;
      if (text[n] === '(') {
        const named = ids[firstIdFrom(n)];
        if (named && named.offset < (close.get(n) ?? n)) add(named, 'param', b, blockEnd(b));
      } else {
        implicit(id.name === 'didSet' ? 'oldValue' : 'newValue', b, blockEnd(b));
      }
      continue;
    }
  }

  // Closures: `{ a, b in`, `{ (a: T, b) -> R in`, `{ [weak self, x = y] a in`, `$0`.
  for (const b of braces) {
    if (kinds.get(b) !== 'closure') continue;
    const bend = blockEnd(b);
    let at = nextSig(b + 1);
    if (at < 0) continue;
    let captureEnd = -1;
    if (text[at] === '[') {
      const c = close.get(at);
      if (c === undefined) continue;
      captureEnd = c;
      // `[weak self, x = y, unowned z]`
      for (let k = firstIdFrom(at); k < ids.length && ids[k].offset < c; k++) {
        const id = ids[k];
        if (id.name === 'weak' || id.name === 'unowned' || id.name === 'self' || SWIFT_KEYWORDS.has(id.name)) continue;
        const p = prevChar(id.offset);
        if (text[p] === '(' || (text[p] === '.' && text[p - 1] !== '.')) continue;
        const pq = text[p];
        if (pq === '[' || pq === ',' || isWord(pq)) {
          add(id, 'capture', b, bend);
          const n = nextSig(id.offset + id.length);
          if (n >= 0 && text[n] === '=') {
            while (k + 1 < ids.length && ids[k + 1].offset < c && !/,/.test(text.slice(id.offset, ids[k + 1].offset))) k++;
          }
        }
      }
      at = nextSig(c + 1);
    }
    let inId = -1;
    const headLimit = Math.min(bend, at + 400);
    for (let k = firstIdFrom(at); k < ids.length && ids[k].offset < headLimit; k++) {
      if (lx.enclosingOpen(ids[k].offset) !== b) continue;
      if (ids[k].name === 'in') {
        inId = k;
        break;
      }
      const gap = text.slice(at, ids[k].offset);
      if (/[={};]/.test(gap.replace(/->/g, '')) || /\n\s*\n/.test(gap)) break;
      if (/\n/.test(text.slice(at, ids[k].offset)) && captureEnd < 0 && k > firstIdFrom(at) + 8) break;
    }
    if (inId >= 0) {
      const head = text.slice(at, ids[inId].offset);
      const headWords = lx.identsIn(at, ids[inId].offset).filter((x) => SWIFT_KEYWORDS.has(x.name) && !CLOSURE_HEAD_WORDS.has(x.name));
      if (headWords.length === 0 && /^[\s\w$`,()?:<>\[\].&@\-]*$/u.test(head)) {
        if (text[at] === '(') {
          const c = close.get(at);
          if (c !== undefined && c < ids[inId].offset) params(at, c, b, 'closureParam');
        } else {
          for (let k = firstIdFrom(at); k < inId; k++) {
            const id = ids[k];
            const p = prevChar(id.offset);
            if (text[p] === ':' || (text[p] === '>' && text[p - 1] === '-') || /^[A-Z]/.test(id.name)) break;
            if (lx.enclosingOpen(id.offset) === b) add(id, 'closureParam', b, bend);
          }
        }
      }
    }
  }

  // Bindings: every identifier that is not a declaration site resolves through the scopes.
  const sortedByName = new Map<string, SwiftDecl[]>();
  const sortedDecls = (name: string, list: SwiftDecl[]): SwiftDecl[] => {
    let s = sortedByName.get(name);
    if (!s || s.length !== list.length) {
      s = [...list].sort((a, b) => a.from - b.from || a.offset - b.offset);
      sortedByName.set(name, s);
    }
    return s;
  };
  const binding = new Map<number, number>();
  for (const d of decls.values()) if (d.kind !== 'implicit') binding.set(d.offset, d.offset);
  for (const id of ids) {
    if (binding.has(id.offset) || labels.has(id.offset) || notData.has(id.offset)) continue;
    const list = byName.get(id.name);
    const dollar = /^\$\d+$/.test(id.name);
    if (!list && !dollar) continue;
    if (!candidate(id)) continue;
    if (dollar) {
      // `$0`: the innermost closure.
      for (let e = blockOf(id.offset); e >= 0; e = blockOf(e)) {
        if (kinds.get(e) === 'closure') {
          implicit(id.name, e, blockEnd(e));
          binding.set(id.offset, -(e + 1));
          break;
        }
      }
      continue;
    }
    let best: SwiftDecl | undefined;
    const sorted = sortedDecls(id.name, list!);
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].from <= id.offset) lo = mid + 1;
      else hi = mid;
    }
    // The innermost visible declaration has the latest `from` of those whose scope holds the offset.
    for (let k = lo - 1; k >= 0; k--) {
      const d = sorted[k];
      if (id.offset > d.to || (d.kind === 'local' && d.offset > id.offset)) continue;
      if (!best || d.from > best.from || (d.from === best.from && d.offset > best.offset)) best = d;
      if (best && k > 0 && sorted[k - 1].from < best.from) break;
    }
    if (best) binding.set(id.offset, best.kind === 'implicit' ? -(best.offset + 1) : best.offset);
  }
  // An implicit name's first use in its scope stands in for the declaration it has none of.
  const seenImplicit = new Set<number>();
  for (const id of ids) {
    const b = binding.get(id.offset);
    if (b === undefined || b >= 0 || seenImplicit.has(b)) continue;
    seenImplicit.add(b);
    declSites.add(id.offset);
  }
  return { declSites, binding, decls, typeBodies, functionBodies, inlineParams, closures };

  function candidate(id: LexId): boolean {
    if (SWIFT_KEYWORDS.has(id.name) || id.name.startsWith('#')) return false;
    if ((id.name === 'copy' || id.name === 'consume') && /^[ \t]+[\p{ID_Start}_$`]/u.test(text.slice(id.offset + id.length, id.offset + id.length + 3))) {
      // `copy x`, `consume x`: the ownership operators.
      const pc = text[prevChar(id.offset)];
      if (pc !== undefined && !isWord(pc) && pc !== ')' && pc !== ']') return false;
    }
    const p = prevChar(id.offset);
    if (p >= 0) {
      const c = text[p];
      if (c === '.' && text[p - 1] !== '.') return false;
      if (c === '@') return false;
      if (c === '\\') return false;
    }
    const n = nextSig(id.offset + id.length);
    if (n >= 0 && text[n] === ':' && text[n + 1] !== ':' && p >= 0 && (text[p] === '(' || text[p] === ',')) {
      const open = lx.enclosingOpen(id.offset);
      if (open >= 0 && text[open] === '(') return false;
    }
    return true;
  }

  function implicit(name: string, from: number, to: number): void {
    const key = from;
    if (decls.has(-(key + 1)) || (byName.get(name) ?? []).some((d) => d.kind === 'implicit' && d.from === from)) return;
    const d: SwiftDecl = { name, offset: key, kind: 'implicit', from, to };
    decls.set(-(key + 1), d);
    const list = byName.get(name);
    if (list) list.push(d);
    else byName.set(name, [d]);
  }

  function nextCaseOrEnd(caseAt: number, block: number): number {
    const limit = block >= 0 ? blockEnd(block) : end;
    for (let k = firstIdFrom(caseAt + 4); k < ids.length && ids[k].offset < limit; k++) {
      if ((ids[k].name === 'case' || ids[k].name === 'default') && blockOf(ids[k].offset) === block) {
        const ls = lineStart(ids[k].offset);
        if (!/\S/.test(text.slice(ls, ids[k].offset))) return ids[k].offset - 1;
      }
    }
    return limit;
  }

  /** The word starting the statement that holds ids[i]: `guard`, `if`, `while`, `case`, `catch`, `for`, else ''. */
  function statementWord(i: number): string {
    const g = stmtStartIndex(i);
    return g >= 0 ? ids[g].name : '';
  }
  function stmtStartIndex(i: number): number {
    const scope = lx.enclosingOpen(ids[i].offset);
    for (let k = i - 1; k >= 0 && k > i - 64; k--) {
      const id = ids[k];
      if (lx.enclosingOpen(id.offset) !== scope) {
        if (id.offset < scope) return -1;
        continue;
      }
      if (id.name === 'guard' || id.name === 'if' || id.name === 'while') return k;
      if (id.name === 'case' || id.name === 'catch' || id.name === 'for') return k;
      const between = text.slice(id.offset + id.length, ids[k + 1].offset);
      if (/[{};]/.test(between)) return -1;
      if (/\n/.test(between) && !/,\s*(?:\/\/[^\n]*)?\n/.test(text.slice(id.offset, ids[k + 1].offset)) && !/^\s*\n\s*(?:let|var|case)\b/.test(text.slice(id.offset + id.length))) {
        const prev = prevChar(ids[k + 1].offset);
        if (prev >= 0 && text[prev] !== ',' && !/[&|=]/.test(text[prev])) return -1;
      }
    }
    return -1;
  }

  function functionBodyAfter(pclose: number): number {
    // `) async throws -> T where … {`
    for (let j = pclose + 1; j < text.length; j++) {
      if (!lx.isCode(j)) {
        j = (lx.spanAt(j)?.end ?? j + 1) - 1;
        continue;
      }
      const c = text[j];
      if (c === '{') return j;
      if (c === '(' || c === '[') {
        j = close.get(j) ?? j;
        continue;
      }
      if (c === '}' || c === ';') return -1;
      if (c === '\n') {
        const nx = nextSig(j);
        if (nx < 0) return -1;
        if (!/^(?:->|throws|rethrows|async|where|\{|[,&]|[A-Z(\[])/.test(text.slice(nx, nx + 8)) && text[prevChar(j)] !== ',') return -1;
      }
    }
    return -1;
  }

  /** Parameters in `(…)`: `_ a: T`, `label b: T = d`, `c: T`, closure `(a, b)`, `(a: T)`. */
  function params(open: number, pclose: number, body: number, kind: SwiftDeclKind): void {
    const from = body >= 0 ? body : pclose;
    const to = body >= 0 ? blockEnd(body) : pclose;
    let segStart = open + 1;
    const segments: [number, number][] = [];
    let d = 0;
    for (let j = open + 1; j < pclose; j++) {
      if (!lx.isCode(j)) {
        j = (lx.spanAt(j)?.end ?? j + 1) - 1;
        continue;
      }
      const c = text[j];
      if (c === '(' || c === '[' || c === '{' || c === '<') d++;
      else if (c === ')' || c === ']' || c === '}' || (c === '>' && text[j - 1] !== '-')) d--;
      else if (c === ',' && d === 0) {
        segments.push([segStart, j]);
        segStart = j + 1;
      }
    }
    segments.push([segStart, pclose]);
    for (const [a, b] of segments) {
      let colon = -1;
      let dd = 0;
      for (let j = a; j < b; j++) {
        const c = text[j];
        if (c === '(' || c === '[' || c === '<') dd++;
        else if (c === ')' || c === ']' || c === '>') dd--;
        else if (c === ':' && dd === 0 && lx.isCode(j)) {
          colon = j;
          break;
        }
      }
      const head = lx.identsIn(a, colon >= 0 ? colon : b).filter((x) => x.name !== 'inout' && text[x.offset - 1] !== '@');
      if (head.length === 0) continue;
      const name = head[head.length - 1];
      if (head.length >= 2) labels.add(head[head.length - 2].offset);
      if (colon < 0 && kind !== 'closureParam') continue;
      add(name, kind, from, to);
    }
  }
}

/**
 * sourcekit-lsp's tokens against the facts: its `variable` reads stand where they resolve to a
 * binding, each declaration site gets a `declaration` token (sourcekit-lsp sends none), and a
 * binding the server typed as something else (a property, a function, a type) is dropped.
 */
export function swiftTokens(lx: LexResult, tokens: readonly DecodedToken[]): DecodedToken[] {
  const f = swiftFacts(lx);
  const typed = new Map<number, DecodedToken>();
  for (const t of tokens) typed.set(t.offset, t);
  const out: DecodedToken[] = [];
  for (const id of lx.idents) {
    const b = f.binding.get(id.offset);
    if (b === undefined) continue;
    const t = typed.get(id.offset);
    if (t && t.type !== 'variable' && t.type !== 'parameter') continue;
    const d = b >= 0 ? f.decls.get(b) : undefined;
    const param = d !== undefined && (d.kind === 'param' || d.kind === 'closureParam');
    out.push({
      name: id.name,
      offset: id.offset,
      length: id.length,
      type: param ? 'parameter' : 'variable',
      modifiers: f.declSites.has(id.offset) ? ['declaration'] : [],
    });
  }
  return out;
}

/**
 * The word tokens sourcekit-lsp types `method.static.defaultLibrary`, the type of the standard
 * library's operators that the theme paints operator grey: a named static call (`.target(`,
 * `JSONSerialization.jsonObject(`) the restore paints a bold call again (docs/swift.md#band-1-restores).
 */
export function swiftStaticCalls(text: string, tokens: readonly { offset: number; length: number; type: string; modifiers: readonly string[] }[]): LexRange[] {
  const out: LexRange[] = [];
  for (const tk of tokens) {
    if (tk.type !== 'method' || !tk.modifiers.includes('static') || !tk.modifiers.includes('defaultLibrary')) continue;
    if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(text.slice(tk.offset, tk.offset + tk.length))) out.push({ start: tk.offset, end: tk.offset + tk.length });
  }
  return out;
}

export interface SwiftRestores {
  /** Operators sourcekit-lsp types as functions (`==`, `+=`, `??`, `..<`, `!flag`): the grammar's operator grey. */
  operators: LexRange[];
  /** Subscript brackets `a[i]`, which it types `method.defaultLibrary` or `method`, bold: the grammar's weight. */
  brackets: LexRange[];
  /** An attribute's `@` and name (`@MainActor`, `@State`), whose name it types as a type or a macro: the grammar's attribute violet. */
  attributes: LexRange[];
}

const restoreMemo = new WeakMap<LexResult, SwiftRestores>();
const OPERATOR_CHAR = new Uint8Array(128);
for (const c of '/=-+!*%<>&|^~?') OPERATOR_CHAR[c.charCodeAt(0)] = 1;
const isOperatorChar = (t: string, i: number): boolean => OPERATOR_CHAR[t.charCodeAt(i)] === 1;
/** Swift treats these as whitespace on an operator's left or right (The Swift Programming Language, Lexical Structure, Operators). */
const LEFT_SPACE = /[\s([{,;:]/;
const RIGHT_SPACE = /[\s)\]},;:]/;

/** Band-1 restores for what sourcekit-lsp repaints off the grammar's register (docs/swift.md#band-1-restores). */
export function swiftRestores(lx: LexResult): SwiftRestores {
  const hit = restoreMemo.get(lx);
  if (hit) return hit;
  const t = lx.text;
  const n = t.length;
  const operators: LexRange[] = [];
  // `#if !os(Linux) && DEBUG`: a compilation condition, painted as the directive.
  const directives: LexRange[] = [];
  for (const m of t.matchAll(/^[ \t]*#(?:if|elseif)\b[^\n]*/gm)) directives.push({ start: m.index!, end: m.index! + m[0].length });
  let di = 0;
  const spans = lx.spans;
  let si = 0;
  const nums = lx.numbers;
  let ni = 0;
  let typeUntil = -1;
  for (let i = 0; i < n; i++) {
    while (si < spans.length && spans[si].end <= i) si++;
    if (si < spans.length && spans[si].start <= i) {
      i = spans[si].end - 1;
      continue;
    }
    // `1.5e-3`, `0x1.8p+3`: the exponent's sign is part of the literal.
    while (ni < nums.length && nums[ni].end <= i) ni++;
    if (ni < nums.length && nums[ni].start <= i) {
      i = nums[ni].end - 1;
      continue;
    }
    const dotRun = t.charCodeAt(i) === 46 && t.charCodeAt(i + 1) === 46;
    if (!dotRun && !isOperatorChar(t, i)) continue;
    const c = t[i];
    const start = i;
    let e = i + 1;
    while (e < n && (isOperatorChar(t, e) || (dotRun && t[e] === '.')) && !(t[e] === '/' && (t[e + 1] === '/' || t[e + 1] === '*'))) e++;
    i = e - 1;
    if (start <= typeUntil) continue;
    while (di < directives.length && directives[di].end <= start) di++;
    if (di < directives.length && directives[di].start <= start) continue;
    const run = t.slice(start, e);
    const before = t[start - 1];
    const after = t[e];
    const left = before === undefined || LEFT_SPACE.test(before);
    const right = after === undefined || RIGHT_SPACE.test(after);
    // Generic clauses (`Array<Int>`, `f<T: ~Copyable>(`, `Set<[K: V]>`) hold types, whatever operators they spell.
    if (c === '<' && !left && /[\p{ID_Continue}`]/u.test(before)) {
      const g = genericClose(t, start);
      if (g > 0) {
        typeUntil = g;
        continue;
      }
    }
    if (run === '=' || run === '->' || run === '?') continue;
    // `x!`, `x?`, `x?.y`: postfix; the server types none of them.
    if ((c === '!' || c === '?') && !left) continue;
    const prefix = left && !right;
    const postfix = !left && right;
    // Prefix `&x` (an inout argument), `-1` (a literal), `~Copyable` (a suppressed protocol).
    if (prefix && (run === '&' || (run === '-' && /[0-9.]/.test(after)) || (run === '~' && /[A-Z_]/.test(after)))) continue;
    // A postfix `...` is a one-sided range (`i...`), not a variadic parameter (`Int...`).
    if (postfix && (run !== '...' || /^[A-Z]/.test(wordBefore(t, start)))) continue;
    // `@available(macOS 10.15, *)`, `@available(*, deprecated)`: the platform wildcard.
    if (run === '*' && /[(,]/.test(t[lx.prevSignificant(start)] ?? '') && /^\s*[),]/.test(t.slice(e, e + 40))) continue;
    operators.push({ start, end: e });
  }
  const brackets: LexRange[] = [];
  const stack: (number | -1)[] = [];
  for (const p of lx.punct) {
    const c = t[p];
    if (c === '[') {
      const b = t[p - 1];
      stack.push(b !== undefined && /[\p{ID_Continue}`)\]}?!]/u.test(b) && !SUBSCRIPT_BLOCKERS.has(wordBefore(t, p)) ? p : -1);
    } else if (c === ']') {
      const o = stack.pop();
      if (o !== undefined && o >= 0) brackets.push({ start: o, end: o + 1 }, { start: p, end: p + 1 });
    }
  }
  brackets.sort((a, b) => a.start - b.start);
  const attributes: LexRange[] = [];
  // The `@` too: on a parameter (`@ViewBuilder _ content:`) the grammar paints neither.
  for (const id of lx.idents) if (t[id.offset - 1] === '@') attributes.push({ start: id.offset - 1, end: id.offset + id.length });
  const out = { operators, brackets, attributes };
  restoreMemo.set(lx, out);
  return out;
}

const SUBSCRIPT_BLOCKERS = new Set(['return', 'in', 'case', 'throw', 'yield', 'try', 'await', 'is', 'as', 'where', 'if', 'guard', 'while', 'else']);

function wordBefore(t: string, p: number): string {
  let s = p;
  while (s > 0 && /[\p{ID_Continue}]/u.test(t[s - 1])) s--;
  return t.slice(s, p);
}

/** The `>` closing the generic clause that the `<` at `open` starts, else -1. */
function genericClose(t: string, open: number): number {
  let depth = 0;
  for (let j = open; j < t.length && j < open + 400; j++) {
    const c = t[j];
    if (c === '<') depth++;
    else if (c === '>') {
      if (t[j - 1] === '-') continue;
      if (--depth === 0) return j;
    } else if (c === ';' || c === '{' || c === '}' || (c === '=' && t[j + 1] !== '=' && t[j - 1] !== '=')) return -1;
    else if (!/[\p{ID_Continue}\s.,:&?!~@\[\]()`$-]/u.test(c)) return -1;
  }
  return -1;
}
