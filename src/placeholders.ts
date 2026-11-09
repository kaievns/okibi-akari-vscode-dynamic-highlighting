/**
 * FORMAT PLACEHOLDER spans — a band-1 mark the theme cannot always express.
 *
 * A placeholder is a slot in a string that reaches out to an argument: `%d` in Go,
 * `{}`/`{name}`/`{:>8}` in Rust, `%s` and an f-string hole in Python, `${…}` in a
 * TS/JS template. That makes it the string's window onto the program's data rather
 * than string CONTENT, so the theme paints it member steel — the register used for
 * reaching into data.
 *
 * For Go, TS and Python `%`-formats the theme handles it alone: each grammar emits a
 * distinct scope for the placeholder (Go via `syntaxes/go-format.injection.json`)
 * inside a string scope, and the language server either agrees or says nothing.
 *
 * PYTHON F-STRINGS are the first exception. The grammar scopes a field's braces
 * `constant.character.format.placeholder.other.python` under `meta.fstring.python`
 * with no `string` scope at that point, so VS Code's bracket-pair colorization
 * counts them as brackets and paints them bracket grey over the theme.
 *
 * RUST IS THE OTHER EXCEPTION. rust-analyzer emits ONE
 * `string` semantic token spanning the entire literal — quotes, text and `{}`
 * together:
 *
 *   println!("attempt {} for {} (backoff={}ms)", i, cfg.name, backoff);
 *            └────────────── one `string` token ──────────────┘
 *
 * A semantic token overrides TextMate for its whole span, so the grammar's
 * `meta.interpolation.rust` scope — which is correct, and which the theme does
 * select — is annihilated, and the placeholders render string green. No theme rule
 * can win that fight: the winning token is the one covering them, and it is a single
 * flat span. A DECORATION renders above both layers, so this is the only mechanism
 * that reaches it.
 *
 * LUA under `Lua.semantic.keyword` is the same case: lua-language-server sends one
 * `string` token over each literal, hiding the theme's `string.format` placeholders.
 * The decorator paints `luaPlaceholderSpans` only while the answer does that.
 *
 * Phase-independent by design. This is band 1 — the resting register — so it does
 * not wait for Focus or Edit and does not blink when the phase relaxes.
 */

import { LexResult, LexSpan, bangCalls, errorAttributes, lexFor } from './lex';

export interface Span {
  start: number;
  end: number;
}

/**
 * Rust format placeholders in a document: the `{…}` holes inside FORMAT STRINGS.
 *
 * A Rust format string is always a literal argument of a formatting macro —
 * `format!`, `println!`, `write!(f, …)`, `assert_eq!(a, b, …)`, the `log` and
 * `tracing` macros — or of a thiserror `#[error("…")]` attribute; `format!(FMT)`
 * with a `const` does not compile. So only those literals are read, and a `{…}`
 * in any other string (a JSON body, a regex quantifier like `{2,4}`) is content.
 * Within a format string:
 *
 *   - `{{` and `}}` are ESCAPED literal braces and are not placeholders;
 *   - outside a raw string a backslash escape is one character, so the braces of
 *     `\u{2603}` are not a placeholder;
 *   - raw strings (`r#"…"#`) count; comments, char literals and lifetimes are never
 *     strings, so a `{}` in them is left alone.
 */
export function rustPlaceholderSpans(text: string): Span[] {
  const out: Span[] = [];
  for (const f of formatStrings(text)) {
    const body = bodyOf(text, f.span);
    if (body) {
      collectHoles(text, body, out);
    }
  }
  return out;
}

/**
 * Every bracket in a Rust string or char literal whose colour at rest is the
 * theme's string colour, one character each. See
 * docs/runtime.md#brackets-in-rust-comments-and-strings.
 *
 * Left out: format-string holes (the placeholder mark), and a bracket inside a
 * `{…}` the grammar scopes as an interpolation unless a `string` semantic token
 * covers it: with `semantic` false, or on an escape rust-analyzer types with no
 * theme style (`{{` / `}}` in a format string, `b"\u{41}"`).
 */
export function rustStringBracketSpans(text: string, semantic: boolean): Span[] {
  const lx = lexFor(text, 'rust');
  const format = new Map<number, { holes: Span[]; pairs: Span[] }>();
  for (const f of formatStrings(text)) {
    const body = bodyOf(text, f.span);
    if (body) {
      const holes: Span[] = [];
      const pairs: Span[] = [];
      collectHoles(text, body, holes, pairs);
      format.set(f.span.start, { holes, pairs });
    }
  }
  const out: Span[] = [];
  for (const s of lx.spans) {
    if (s.region !== 'string') {
      continue;
    }
    const body = bodyOf(text, s);
    if (!body) {
      // A char literal: the grammar gives it no interpolation scope.
      for (let i = s.start; i < s.end; i++) {
        if (isBracket(text.charCodeAt(i))) out.push({ start: i, end: i + 1 });
      }
      continue;
    }
    const f = format.get(s.start);
    const holes = f?.holes ?? [];
    const tm = body.raw ? [] : grammarInterpolations(text, body.start, body.end, body.byte);
    const esc = body.raw ? [] : mergeSorted(escapeSpans(text, body.start, body.end), f?.pairs ?? []);
    let h = 0;
    let t = 0;
    let e = 0;
    for (let i = body.start; i < body.end; i++) {
      if (!isBracket(text.charCodeAt(i))) {
        continue;
      }
      while (h < holes.length && holes[h].end <= i) h++;
      while (t < tm.length && tm[t].end <= i) t++;
      while (e < esc.length && esc[e].end <= i) e++;
      if (h < holes.length && holes[h].start <= i) {
        continue;
      }
      const inTm = t < tm.length && tm[t].start <= i;
      const inEsc = e < esc.length && esc[e].start <= i;
      if (!inTm || (semantic && !inEsc)) {
        out.push({ start: i, end: i + 1 });
      }
    }
  }
  return out;
}

const isBracket = (c: number): boolean => c === 40 || c === 41 || c === 91 || c === 93 || c === 123 || c === 125;

/** The end of the backslash escape at `i`, as Rust reads it: `\u{…}`, `\x41`, else one character. */
function escapeEnd(text: string, i: number, end: number): number {
  const e = text[i + 1];
  if (e === 'u' && text[i + 2] === '{') {
    let j = i + 3;
    while (j < end && text[j] !== '}') j++;
    return j < end ? j + 1 : end;
  }
  return Math.min(end, i + (e === 'x' ? 4 : 2));
}

/** Backslash escapes in a non-raw string body, as rust-analyzer types them `escapeSequence`. */
function escapeSpans(text: string, start: number, end: number): Span[] {
  const out: Span[] = [];
  let i = start;
  while (i < end) {
    if (text.charCodeAt(i) !== 92) {
      i++;
      continue;
    }
    const j = escapeEnd(text, i, end);
    out.push({ start: i, end: j });
    i = j;
  }
  return out;
}

/**
 * The `{…}` spans the Rust grammar scopes `meta.interpolation.rust` in a non-raw
 * string body: `({)[^"{}]*(})` on one line, after the escapes. rust-syntax 0.6.1
 * reads `\\(x[0-7][0-7a-fA-F]|u\{[\da-fA-F]{4,6}\}|.)`, and VS Code 1.144.1's
 * built-in grammar `\x` with any second digit. The theme repo's
 * `syntaxes/rs-strings.injection.json` reopens every string with no `b` prefix
 * and reads Rust's own unicode escape first, 1 to 6 hex digits each followed by
 * any `_`; a byte string keeps the base rule.
 */
const STRING_ESCAPE = /\\(?:u\{(?:[\da-fA-F]_*){1,6}\}|x[0-7][0-7a-fA-F]|[^\n])/y;
const BYTE_ESCAPE = /\\(?:x[0-7][0-7a-fA-F]|u\{[\da-fA-F]{4,6}\}|[^\n])/y;

function grammarInterpolations(text: string, start: number, end: number, byte: boolean): Span[] {
  const out: Span[] = [];
  let i = start;
  while (i < end) {
    const c = text[i];
    if (c === '\\') {
      const re = byte ? BYTE_ESCAPE : STRING_ESCAPE;
      re.lastIndex = i;
      const x = re.exec(text);
      i = x ? Math.min(end, i + x[0].length) : i + 1;
      continue;
    }
    if (c === '{') {
      let j = i + 1;
      while (j < end && text[j] !== '"' && text[j] !== '{' && text[j] !== '}' && text[j] !== '\n') j++;
      if (j < end && text[j] === '}') {
        out.push({ start: i, end: j + 1 });
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

function mergeSorted(a: Span[], b: Span[]): Span[] {
  return b.length === 0 ? a : [...a, ...b].sort((x, y) => x.start - y.start);
}

/**
 * Rust inline format args: the identifiers a format string reads directly, `label`
 * in `write!(f, "{label}")` and `width` in `{:>width$}`. A name given as a named
 * argument of the same call (`name = expr`) is that argument, not a capture, and a
 * `#[error("…")]` attribute names fields, so neither is listed.
 */
export function rustInlineArgs(text: string): { name: string; offset: number; length: number }[] {
  const out: { name: string; offset: number; length: number }[] = [];
  for (const f of formatStrings(text)) {
    const body = f.macro ? bodyOf(text, f.span) : undefined;
    if (!body) {
      continue;
    }
    const named = new Set<string>();
    for (const a of f.rest) {
      const m = NAMED_ARG.exec(text.slice(a.start, a.end));
      if (m) named.add(m[1]);
    }
    const add = (name: string, offset: number): void => {
      if (name !== '_' && !named.has(name)) out.push({ name, offset, length: name.length });
    };
    const holes: Span[] = [];
    collectHoles(text, body, holes);
    for (const h of holes) {
      const inner = text.slice(h.start + 1, h.end - 1);
      const colon = inner.indexOf(':');
      const arg = colon < 0 ? inner : inner.slice(0, colon);
      if (CAPTURE.test(arg)) add(arg, h.start + 1);
      if (colon >= 0) {
        for (const m of inner.slice(colon + 1).matchAll(COUNT_ARG)) {
          add(m[1], h.start + 2 + colon + m.index!);
        }
      }
    }
  }
  return out;
}

const CAPTURE = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const COUNT_ARG = /([\p{L}_][\p{L}\p{N}_]*)\$/gu;
const NAMED_ARG = /^\s*([\p{L}_][\p{L}\p{N}_]*)\s*=(?!=)/u;

interface Body extends Span {
  raw: boolean;
  byte: boolean;
}

/** The body of a string literal span, past its prefix, raw-string hashes and quotes. */
function bodyOf(text: string, s: LexSpan): Body | undefined {
  let i = s.start;
  let raw = false;
  let byte = false;
  while (i < s.end && text[i] >= 'a' && text[i] <= 'z') {
    raw ||= text[i] === 'r';
    byte ||= text[i] === 'b';
    i++;
  }
  let hashes = 0;
  while (text[i] === '#') { hashes++; i++; }
  if (text[i] !== '"') {
    return undefined;
  }
  const start = i + 1;
  const closer = `"${'#'.repeat(hashes)}`;
  const closed = s.end - closer.length >= start && text.startsWith(closer, s.end - closer.length);
  return { start, end: closed ? s.end - closer.length : s.end, raw, byte };
}

/**
 * Which argument of each formatting macro is the format string. -1: the first
 * argument that is a bare string literal, after `target: …` or tracing fields.
 */
const FORMAT_ARG: Record<string, number> = {
  format: 0, format_args: 0, print: 0, println: 0, eprint: 0, eprintln: 0, panic: 0,
  unreachable: 0, todo: 0, unimplemented: 0, anyhow: 0, bail: 0, eyre: 0,
  write: 1, writeln: 1, assert: 1, debug_assert: 1, ensure: 1,
  assert_eq: 2, assert_ne: 2, debug_assert_eq: 2, debug_assert_ne: 2,
  trace: -1, debug: -1, info: -1, warn: -1, error: -1, log: -1, event: -1,
};

interface FormatString {
  span: LexSpan;
  rest: Span[];
  macro: boolean;
}

/** Per lex: the placeholder, inline-arg and string-bracket scans of one version share it. */
const formatMemo = new WeakMap<LexResult, FormatString[]>();

/**
 * The string-literal spans that are format strings (see rustPlaceholderSpans), each
 * with the call's arguments after it and whether the call is a macro.
 */
function formatStrings(text: string): FormatString[] {
  const lx = lexFor(text, 'rust');
  const memo = formatMemo.get(lx);
  if (memo) {
    return memo;
  }
  const out: FormatString[] = [];
  formatMemo.set(lx, out);
  const calls = bangCalls(text);
  const attrs = errorAttributes(text);
  let a = 0;
  let b = 0;
  let resume = 0;
  while (a < calls.length || b < attrs.length) {
    const m: { index: number; open: number; name?: string } = b >= attrs.length || (a < calls.length && calls[a].index < attrs[b].index) ? calls[a++] : attrs[b++];
    if (m.index < resume) {
      continue;
    }
    resume = m.open + 1;
    const open = m.open;
    const macro = m.name !== undefined;
    if ((macro && !Object.prototype.hasOwnProperty.call(FORMAT_ARG, m.name!)) || !lx.isCode(m.index) || !lx.isCode(open)) {
      continue;
    }
    const index = macro ? FORMAT_ARG[m.name!] : 0;
    const args = topLevelArgs(lx, open);
    const from = Math.max(index, 0);
    for (let k = from; k < (index >= 0 ? Math.min(index + 1, args.length) : args.length); k++) {
      const s = soleString(lx, args[k].start, args[k].end);
      if (s) {
        out.push({ span: s, rest: args.slice(k + 1), macro });
        break;
      }
    }
  }
  return out;
}

/** The comma-separated argument ranges inside the bracket at `open`. */
function topLevelArgs(lx: LexResult, open: number): { start: number; end: number }[] {
  const text = lx.text;
  const P = lx.punct;
  const args: { start: number; end: number }[] = [];
  let depth = 0;
  let from = open + 1;
  for (let k = lx.punctFrom(open); k < P.length; k++) {
    const c = text[P[k]];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) {
        args.push({ start: from, end: P[k] });
        break;
      }
    } else if (c === ',' && depth === 1) {
      args.push({ start: from, end: P[k] });
      from = P[k] + 1;
    }
  }
  return args;
}

/** The string span that is the whole of [start, end) apart from blanks, else undefined. */
function soleString(lx: LexResult, start: number, end: number): LexSpan | undefined {
  const text = lx.text;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  const s = lx.spanAt(start);
  return s && s.region === 'string' && s.start === start && s.end === end ? s : undefined;
}

/**
 * The `{…}` holes inside one string body, appended to `out`, and the `{{` / `}}`
 * pairs to `pairs`.
 *
 * `{{` is an escaped literal brace and is skipped as a pair, and outside a raw
 * string so is a backslash escape. An unclosed `{` (the string ends first) is not
 * a placeholder and is dropped rather than run past the end of the body.
 */
function collectHoles(text: string, body: Body, out: Span[], pairs?: Span[]): void {
  const end = body.end;
  let i = body.start;
  while (i < end) {
    if (text[i] === '\\' && !body.raw) {
      i = escapeEnd(text, i, end);
      continue;
    }
    if (text[i] === '{') {
      if (text[i + 1] === '{') { pairs?.push({ start: i, end: i + 2 }); i += 2; continue; } // `{{` — literal brace
      let j = i + 1;
      while (j < end && text[j] !== '}') {
        // A nested `{` cannot appear in a format spec; if one does, the outer `{`
        // was not a placeholder after all.
        if (text[j] === '{') break;
        j += 1;
      }
      if (j < end && text[j] === '}') {
        out.push({ start: i, end: j + 1 });
        i = j + 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (text[i] === '}' && text[i + 1] === '}') { pairs?.push({ start: i, end: i + 2 }); i += 2; continue; } // `}}`
    i += 1;
  }
}

/**
 * Ruby interpolation delimiters: the `#{` and `}` around every hole in a string,
 * symbol, regex, command or heredoc. Bracket-pair colorization paints those braces
 * over the theme's `punctuation.section.embedded` rule; the expression inside keeps
 * its own colours. A hole still open where the literal or the file ends is not painted.
 */
export function rubyPlaceholderSpans(text: string): Span[] {
  const lx = lexFor(text, 'ruby');
  const out: Span[] = [];
  for (const h of lx.holes) {
    if (text[h.start - 1] !== '{' || text[h.start - 2] !== '#' || h.end >= text.length || text[h.end] !== '}') continue;
    if (lx.regionAt(h.start - 1) !== 'string' || lx.regionAt(h.end) !== 'string') continue;
    out.push({ start: h.start - 2, end: h.start }, { start: h.end, end: h.end + 1 });
  }
  return out;
}

/**
 * JavaScript template delimiters: the `${` and `}` around every hole. The JavaScript
 * language configuration lists `${` `}` as a bracket pair and sets no
 * `colorizedBracketPairs`, so bracket-pair colorization paints them over the theme's
 * rule; TypeScript's configuration leaves them out. A hole still open is not painted.
 */
export function jsPlaceholderSpans(text: string): Span[] {
  const lx = lexFor(text, 'javascript');
  const out: Span[] = [];
  for (const h of lx.holes) {
    if (text[h.start - 1] !== '{' || text[h.start - 2] !== '$' || h.end >= text.length || text[h.end] !== '}') continue;
    if (lx.regionAt(h.start - 1) !== 'string' || lx.regionAt(h.end) !== 'string') continue;
    out.push({ start: h.start - 2, end: h.start }, { start: h.end, end: h.end + 1 });
  }
  return out;
}

/**
 * Python f-string replacement-field syntax: every field's `{` and `}`, its `!r`
 * conversion, its `:spec` (nested fields' braces included) and a self-documenting
 * `=` written directly before them. The expression inside a field is code and keeps
 * its own colour, and `{{` / `}}` are escaped text. A field still open where the
 * string or line ends is not painted.
 */
export function pythonPlaceholderSpans(text: string): Span[] {
  const lx = lexFor(text, 'python');
  const holes = lx.holes;
  const holeAt = new Map<number, number>();
  holes.forEach((h, k) => holeAt.set(h.start, k));
  const closes = new Map<number, number>();
  const inString = (at: number): boolean => lx.regionAt(at) === 'string';

  // The offset of hole k's closing `}`, or -1; appends the field's marks when `marks` is given.
  const field = (k: number, marks?: Span[]): number => {
    const known = closes.get(k);
    if (known !== undefined && !marks) return known;
    const h = holes[k];
    const open = h.start - 1;
    let close = -1;
    const own: Span[] = [{ start: open, end: open + 1 }];
    if (text[open] === '{' && inString(open) && h.end < text.length) {
      const prev = text[h.end - 2];
      if (text[h.end - 1] === '=' && h.end - 1 > h.start && prev !== '=' && prev !== '!' && prev !== '<' && prev !== '>') {
        own.push({ start: h.end - 1, end: h.end });
      }
      let m = h.end;
      let seg = m;
      if (text[m] === '!') {
        m++;
        while (m < text.length && /\w/.test(text[m]) && text.charCodeAt(m) < 128) m++;
      }
      if (text[m] === ':') {
        m++;
        while (m < text.length && inString(m) && text[m] !== '}') {
          const nested = text[m] === '{' ? holeAt.get(m + 1) : undefined;
          if (nested === undefined) {
            m++;
            continue;
          }
          own.push({ start: seg, end: m });
          const end = field(nested);
          if (end < 0) break;
          m = end + 1;
          seg = m;
        }
      }
      if (text[m] === '}' && inString(m)) {
        own.push({ start: seg, end: m + 1 });
        close = m;
      }
    }
    closes.set(k, close);
    if (close >= 0 && marks) marks.push(...own);
    return close;
  };

  const marks: Span[] = [];
  for (let k = 0; k < holes.length; k++) field(k, marks);
  return mergeSpans(marks);
}

const LUA_PLACEHOLDER = /%[-+ #0]{0,5}\d{0,2}(?:\.\d{0,2})?[aAcdeEfgGioqsuxX%]/y;

/** The last offset before `i` that is not a space or tab, or -1. */
function blankBefore(text: string, i: number): number {
  let j = i - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
  return j;
}

/** Does `string.format` end at `q`, with `string` not a member (`a.string`, `a:string`)? */
function stringFormatEndsAt(text: string, q: number): boolean {
  const b = q - 13;
  if (b < -1 || !text.startsWith('string.format', b + 1)) return false;
  const c = text[b] ?? '';
  return !/\w/.test(c) && c !== ':' && !(c === '.' && text[b - 1] !== '.');
}

/** `[ \t]*)[ \t]*:[ \t]*format` and a word boundary from `i`. */
function formatMethodAt(text: string, i: number): boolean {
  const m = /[ \t]*\)[ \t]*:[ \t]*format\b/y;
  m.lastIndex = i;
  return m.test(text);
}

/**
 * Lua `string.format` placeholders, in the call shapes the theme's
 * `syntaxes/lua-gaps.injection.json` reads: the literal right after
 * `string.format(`, the literal opening the line after a `string.format(` that
 * ends its line, and `("…"):format(`. Lua patterns (`gsub`, `match`) use the
 * same `%d` and `%s`, so no other literal is read. A backslash escape is one
 * character; a long bracket has no escapes and counts only closed on its line,
 * as does any literal before `):format`.
 */
export function luaPlaceholderSpans(text: string): Span[] {
  const lx = lexFor(text, 'lua');
  const out: Span[] = [];
  for (const s of lx.spans) {
    if (s.region !== 'string') continue;
    const long = text[s.start] === '[';
    let from = s.start + 1;
    let to = s.end;
    let closed: boolean;
    if (long) {
      while (text[from] === '=') from++;
      const level = from - s.start - 1;
      from++;
      to = s.end - level - 2;
      closed = to >= from && text.startsWith(`]${'='.repeat(level)}]`, to);
    } else {
      closed = s.end - s.start >= 2 && text[s.end - 1] === text[s.start];
      if (closed) to = s.end - 1;
    }
    const nl = text.indexOf('\n', s.start);
    const oneLine = nl < 0 || nl >= s.end;
    if (long && !(closed && oneLine)) continue;
    const open = blankBefore(text, s.start);
    let format = false;
    if (text[open] === '(') {
      format = stringFormatEndsAt(text, blankBefore(text, open)) || (closed && oneLine && formatMethodAt(text, s.end));
    } else if (!long && text[open] === '\n') {
      let q = blankBefore(text, open);
      if (text[q] === '\r') q = blankBefore(text, q);
      format = text[q] === '(' && lx.regionAt(q) === 'code' && stringFormatEndsAt(text, blankBefore(text, q));
    }
    if (!format) continue;
    for (let i = from; i < to;) {
      if (!long && text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === '%') {
        LUA_PLACEHOLDER.lastIndex = i;
        if (LUA_PLACEHOLDER.test(text) && LUA_PLACEHOLDER.lastIndex <= to) {
          out.push({ start: i, end: LUA_PLACEHOLDER.lastIndex });
          i = LUA_PLACEHOLDER.lastIndex;
          continue;
        }
      }
      i++;
    }
  }
  return out;
}

/** Sorted, with empty spans dropped and touching or overlapping spans joined. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ start: s.start, end: s.end });
    }
  }
  return out;
}
