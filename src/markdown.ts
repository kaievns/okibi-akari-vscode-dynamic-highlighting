/**
 * Markdown band-1 marks that a colour theme physically cannot express.
 *
 * None of these is an attention-phase behaviour, so none is phase-bound: they
 * are part of the resting register, and they live here only because
 * `tokenColors` cannot reach them.
 *
 *   1. ==highlight== wash — a `background` in `tokenColors` is parsed and
 *      indexed but NEVER rendered in the DOM editor. VS Code's
 *      `getClassNameFromMetadata` emits `mtk<foreground>` plus four font-style
 *      bits (italic / bold / underline / strikethrough) and nothing else. A
 *      decoration is the only way to fill behind text.
 *
 *   2. link underline — the `editor.links` contrib decorates every
 *      provider-reported link range with `inlineClassName: "detected-link"`, and
 *      the workbench stylesheet declares
 *      `.monaco-editor .detected-link { text-decoration: underline }`. It is not
 *      a token style, so no theme rule can reach it. `editor.links: false` in a
 *      `[markdown]` override would remove it — the option is
 *      LANGUAGE_OVERRIDABLE — but it also disables link *following*, which is a
 *      functional loss for a cosmetic complaint. A competing decoration keeps
 *      ctrl+click working.
 *
 *   3. prose restores — a TextMate rule sees one line and no definitions, so it
 *      paints every `[x]` as a link, a setext heading's text as prose and a
 *      block quote's lazy line as unquoted, among others. `proseMarks` repaints
 *      those from a CommonMark parse of the whole document (src/commonmark.ts).
 *
 * The first two scanners are plain lexers over the document text rather than queries
 * against the tokenizer, because the extension host has no access to the
 * TextMate token stream. They therefore have to reproduce one thing the
 * injection grammar gets for free: never matching inside code. The exclusions
 * here mirror `syntaxes/md-prose.injection.json`'s injection selector
 * (`-markup.fenced_code -markup.inline.raw -markup.raw -meta.embedded -comment`).
 */

import { docOffset, Inline, joinSegs, parseBlocks, parseInline } from './commonmark';
import { bareLinks, detectedUrls } from './linkify';

/** A half-open offset span. */
export interface Span {
  start: number;
  end: number;
}

/**
 * Offsets covered by fenced code, indented code, inline code spans and YAML
 * frontmatter — every region where a `==` is an operator and a bare URL is a
 * string literal, not prose.
 *
 * Fence tracking follows CommonMark closely enough for the purpose: a fence is
 * opened by 3+ backticks or tildes, and closed only by a run of the SAME
 * character that is at least as long. Inside a list item a fence may be indented
 * up to the item's content indent plus 3. Getting this wrong in the lenient
 * direction would paint marks inside code; in the strict direction it would
 * merely miss a mark, so the tie-breaks below all favour "treat as code".
 */
export function codeSpans(text: string): Span[] {
  const spans: Span[] = [];
  const lines = text.split('\n');

  let offset = 0;
  let fenceChar = '';
  let fenceLen = 0;
  let fenceStart = -1;
  let fenceIndent = 3;
  let inFrontmatter = false;
  // Content indent of the list item the current lines belong to, 0 outside a list.
  let listIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    const indent = indentWidth(line);

    // Frontmatter: only when `---` is the very first line of the document.
    if (i === 0 && /^-{3,}\s*$/.test(line)) {
      inFrontmatter = true;
      fenceStart = lineStart;
      continue;
    }
    if (inFrontmatter) {
      if (/^(-{3,}|\.{3})\s*$/.test(line)) {
        spans.push({ start: fenceStart, end: lineStart + line.length });
        inFrontmatter = false;
        fenceStart = -1;
      }
      continue;
    }

    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceChar) {
      // Inside a fence: close only on the same character, at least as long, and
      // with no info string after it.
      if (fence && indent <= fenceIndent && fence[1][0] === fenceChar && fence[1].length >= fenceLen
          && /^\s*([`~]{3,})\s*$/.test(line)) {
        spans.push({ start: fenceStart, end: lineStart + line.length });
        fenceChar = '';
        fenceLen = 0;
        fenceStart = -1;
      }
      continue;
    }
    if (line.trim() !== '') {
      const item = /^(\s*)([-*+]|\d{1,9}[.)])( {1,4}|\t|$)/.exec(line);
      if (item) {
        listIndent = indentWidth(item[1]) + item[2].length + Math.max(1, indentWidth(item[3]));
      } else if (indent < listIndent && !fence) {
        listIndent = 0;
      }
    }
    if (fence && indent <= listIndent + 3) {
      fenceChar = fence[1][0];
      fenceLen = fence[1].length;
      fenceStart = lineStart;
      fenceIndent = listIndent + 3;
      continue;
    }

    // A four-space / one-tab indented block. Only counts as code when it is not
    // a lazy continuation of a list item, which this cheap check approximates by
    // requiring the previous line to be blank.
    if (/^(\s{4}|\t)\S/.test(line) && (i === 0 || lines[i - 1].trim() === '')) {
      spans.push({ start: lineStart, end: lineStart + line.length });
      continue;
    }

    // Inline code spans. A run of N backticks is closed by the next run of
    // exactly N, per CommonMark; anything unclosed is literal, so it is skipped.
    const re = /`+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const open = m[0].length;
      const contentStart = m.index + open;
      const closer = new RegExp('`{' + open + '}(?!`)', 'g');
      closer.lastIndex = contentStart;
      const c = closer.exec(line);
      if (!c) break;
      spans.push({ start: lineStart + m.index, end: lineStart + c.index + open });
      re.lastIndex = c.index + open;
    }
  }

  // An unterminated fence or frontmatter runs to the end of the document.
  if (fenceStart >= 0) {
    spans.push({ start: fenceStart, end: text.length });
  }
  return spans;
}

const inAny = (spans: Span[], start: number, end: number): boolean =>
  spans.some((s) => start < s.end && end > s.start);

/**
 * `spans` merged, and a test for whether `[start, end)` overlaps one, by binary search. `at`
 * gives the span holding an offset, or null.
 */
function spanIndex(spans: Span[]): { hits: (start: number, end: number) => boolean; at: (o: number) => Span | null } {
  const list = mergeSpans(spans);
  // The last span starting before `o`, or -1.
  const before = (o: number): number => {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start < o) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };
  return {
    hits: (start, end) => {
      const k = before(end);
      return k >= 0 && list[k].end > start;
    },
    at: (o) => {
      const k = before(o + 1);
      return k >= 0 && list[k].end > o ? list[k] : null;
    },
  };
}

/** Columns of leading whitespace, a tab counting to the next multiple of 4. */
function indentWidth(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4 - (n % 4);
    else break;
  }
  return n;
}

/**
 * `<!-- … -->` HTML comments outside code, multi-line; an unclosed one runs to
 * the end of the document. The grammar paints them as comments.
 */
export function htmlCommentSpans(text: string, code: Span[] = codeSpans(text)): Span[] {
  const out: Span[] = [];
  for (let i = text.indexOf('<!--'); i >= 0; i = text.indexOf('<!--', i + 4)) {
    if (inAny(code, i, i + 4)) continue;
    const close = text.indexOf('-->', i + 4);
    const end = close < 0 ? text.length : close + 3;
    out.push({ start: i, end });
    i = end - 4;
  }
  return out;
}

/**
 * The `==highlighted==` ranges, EXCLUDING the `==` sigils themselves — those
 * stay n7 furniture, which the theme already paints, and washing them would make
 * the mark read as four characters wider than the text it marks.
 *
 * The opener mirrors the injection grammar's, including the trap that cost
 * three attempts there: the content must not START with `=`, or a setext H1
 * underline (`=========`) parses as a chain of empty highlights. The closer is the
 * grammar's too, the next `==` on the line that no code span holds, so a mark may
 * hold code. An opener in code or an HTML comment is no mark, and neither is a `==`
 * inside a link target (`?a==b==c`); a mark may still contain a whole link.
 */
export function highlightSpans(text: string, code: Span[] = codeSpans(text), links: Span[] = linkSpans(text, code)): Span[] {
  const skip = spanIndex([...code, ...htmlCommentSpans(text, code)]);
  const inCode = spanIndex(code);
  const inLink = spanIndex(links);
  const out: Span[] = [];
  const open = /==(?=[^=\s](?:[^=\n]|=(?!=))*==)/g;
  let lineEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = open.exec(text))) {
    const p = m.index;
    if (skip.hits(p, p + 2) || inLink.hits(p, p + 2)) {
      open.lastIndex = p + 2;
      continue;
    }
    if (lineEnd < p) {
      lineEnd = text.indexOf('\n', p);
      if (lineEnd < 0) lineEnd = text.length;
    }
    let q = text.indexOf('==', p + 2);
    while (q >= 0 && q < lineEnd) {
      const c = inCode.at(q) ?? inCode.at(q + 1);
      if (!c) break;
      q = text.indexOf('==', c.end);
    }
    if (q < 0 || q >= lineEnd || inLink.hits(q, q + 2)) {
      open.lastIndex = p + 2;
      continue;
    }
    out.push({ start: p + 2, end: q });
    open.lastIndex = q + 2;
  }
  return mergeSpans(out);
}

/**
 * Link ranges whose underline should be cancelled: the URL half of an inline
 * link or image, an autolink's URL or email, a bare URL the editor's link computer
 * underlines, and a reference definition's URL, all of which the link providers
 * report. Code is skipped: an autolink or a bare URL in it keeps the underline.
 *
 * Scoped deliberately narrowly. The provider also reports things the underline
 * is genuinely useful on — a `<https://…>` autolink is the one case where the
 * underline is the only cue that the text is clickable — but the spec is
 * explicit that a URL is furniture, so consistency wins over that hint.
 */
export function linkSpans(text: string, code: Span[] = codeSpans(text)): Span[] {
  const skip = spanIndex(code);
  const out: Span[] = [];
  const push = (start: number, end: number): void => {
    if (end > start && !skip.hits(start, end)) out.push({ start, end });
  };

  // [text](url "title") and ![alt](url): the target only, as
  // /!?\[(?:[^\]\\]|\\.)*\]\(((?:[^()\s]|\([^()\s]*\))*)/g finds it, in one pass. The text
  // runs to the first unescaped `]`; a backslash before a line break stops it. The URL
  // allows ONE level of balanced parens, because a Wikipedia link (`…/Foo_(bar)`) is
  // common enough that stopping at the first `(` left the tail underlined.
  const close = closeFinder(text);
  for (let i = text.indexOf('['); i >= 0; i = text.indexOf('[', i)) {
    const j = close(i + 1);
    if (j < 0 || text.charCodeAt(j + 1) !== 40) {
      i++;
      continue;
    }
    let k = j + 2;
    for (;;) {
      if (k < text.length && !isUrlStop(text.charCodeAt(k))) {
        k++;
      } else if (text.charCodeAt(k) === 40) {
        let e = k + 1;
        while (e < text.length && !isUrlStop(text.charCodeAt(e))) e++;
        if (text.charCodeAt(e) !== 41) break;
        k = e + 1;
      } else break;
    }
    push(j + 2, k);
    i = k;
  }

  // <scheme:…> and <email> autolinks, CommonMark's; one whose `<` is in code is none.
  const autolink = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/g;
  let m: RegExpExecArray | null;
  while ((m = autolink.exec(text))) {
    if (!skip.hits(m.index, m.index + 1)) out.push({ start: m.index + 1, end: m.index + 1 + m[1].length });
  }
  for (const u of detectedUrls(text)) push(u.start, u.end);

  // [ref]: https://… definitions. The `[^^]` guard excludes a FOOTNOTE
  // definition (`[^1]: prose…`), which has the same shape but whose body is
  // sentences, not a target — without it the first word of every footnote had its
  // underline suppressed, and worse, was being treated as a link at all. As
  // /^[ \t]*\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*(\S+)/gm finds them, in one pass.
  const closeDef = closeFinder(text);
  for (let ls = 0; ls < text.length;) {
    let p = ls;
    while (text[p] === ' ' || text[p] === '\t') p++;
    let next = text.indexOf('\n', ls);
    if (text[p] === '[' && text[p + 1] !== '^') {
      const j = closeDef(p + 1);
      if (j > p + 1 && text[j + 1] === ':') {
        let u = j + 2;
        while (text[u] === ' ' || text[u] === '\t') u++;
        let e = u;
        while (e < text.length && !isSpace(text.charCodeAt(e))) e++;
        if (e > u) {
          push(u, e);
          if (next >= 0 && next < e) next = text.indexOf('\n', e);
        }
      }
    }
    if (next < 0) break;
    ls = next + 1;
  }

  return mergeSpans(out);
}

/** JavaScript's `\s`. */
function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
const isUrlStop = (c: number): boolean => c === 40 || c === 41 || isSpace(c);
const isLineBreak = (c: number): boolean => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

/**
 * For offsets asked in increasing order, each a character boundary of the text's escape
 * pairs (`\x` is one unit), the first `]` from there that is no escape's: the end of
 * `(?:[^\]\\]|\\.)*`. -1 when a backslash before a line break or the end comes first.
 * One forward pass over the text for all the queries.
 */
function closeFinder(text: string): (p: number) => number {
  let k = 0;
  let found = -1;
  let bracket = false;
  return (p) => {
    if (found >= p) return bracket ? found : -1;
    if (k < p) k = p;
    for (; k < text.length; k++) {
      const c = text.charCodeAt(k);
      if (c === 93) {
        found = k++;
        bracket = true;
        return found;
      }
      if (c === 92) {
        if (k + 1 >= text.length || isLineBreak(text.charCodeAt(k + 1))) {
          found = k++;
          bracket = false;
          return -1;
        }
        k++;
      }
    }
    found = text.length;
    bracket = false;
    return -1;
  };
}

/**
 * Sort and union overlapping spans.
 *
 * The four branches above are not mutually exclusive — a reference definition's
 * target also matches the bare-URL pattern, for instance — and handing VS Code
 * two decoration ranges over the same text applies the style twice. For an
 * opacity-bearing wash that visibly doubles the tint, so the lists are unioned
 * rather than concatenated.
 */
export function mergeSpans(spans: Span[]): Span[] {
  if (spans.length < 2) return spans;
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  // Copy the seed: `[...spans]` is a shallow clone, so pushing sorted[0] straight
  // in would leave `out[0]` aliasing a CALLER's object, and widening it below
  // would mutate the argument.
  const out: Span[] = [{ ...sorted[0] }];
  for (const s of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** `a` with every range of `b` cut out; both sorted and disjoint. */
export function subtractSpans(a: Span[], b: Span[]): Span[] {
  if (!b.length) return a;
  const out: Span[] = [];
  let k = 0;
  for (const s of a) {
    let start = s.start;
    while (k < b.length && b[k].end <= start) k++;
    for (let j = k; j < b.length && b[j].start < s.end; j++) {
      if (b[j].start > start) out.push({ start, end: b[j].start });
      start = Math.max(start, b[j].end);
    }
    if (start < s.end) out.push({ start, end: s.end });
  }
  return out;
}

// ── prose restores: where the grammar's link, heading and quote parse is not CommonMark's ──

/**
 * The paint a prose restore puts back, as the theme's register names it (docs/markdown.md in
 * the theme): sigils n7, struck text n8, quotes n9, prose n10, headings and emphasis n11,
 * link text sora, inline code member steel.
 */
export type Tone = 'sigil' | 'struck' | 'quote' | 'prose' | 'emphasis' | 'link' | 'code';

export interface ToneSpan extends Span {
  tone: Tone;
}

export interface ProseMarks {
  /** Colour restores, sorted and disjoint. */
  tones: ToneSpan[];
  /** Restored text that is bold: a setext heading's text, strong emphasis, a heading's literal `\`. */
  bold: Span[];
  /** Restored text inside CommonMark emphasis. */
  italic: Span[];
  /** More ranges for mdLinkPlain: reference link labels, definition labels, restored brackets. */
  linkPlain: Span[];
  /**
   * The same inside struck text, where the cancel must keep the line-through: link ranges,
   * `linkSpans`' among them, and a struck task's literal `\`, which the grammar leaves unstruck.
   */
  linkStruck: Span[];
}

/** One of the bundled grammar's escapes, `escape` in markdown.tmLanguage.json. */
const GRAMMAR_ESCAPE = /[-`*_#+.!(){}[\]\\>]/;
// The grammar's link-def, verbatim but for the `x` flag.
const GRAMMAR_LINK_DEF = /^\s*(\[)([^\]]+?)(\])(:)[ \t]*(?:(<)((?:\\[<>]|[^<>\n])*)(>)|(\S+?))[ \t]*(?:((\().+?(\)))|((").+?("))|((').+?(')))?\s*$/;
const GRAMMAR_INET = /<(?:https?|ftp):\/\/.*?>/y;
const GRAMMAR_EMAIL = /<(?:mailto:)?[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*>/y;
const GRAMMAR_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^\s<>]+)*\s*\/?>/y;

/**
 * Where on one line the bundled markdown grammar matches a link or an image: its link-def,
 * link-inline, link-ref, link-ref-literal, link-ref-shortcut, image-inline and image-ref
 * rules, tried in its order after its escapes, code spans, autolinks and tags. Offsets are
 * into `s`.
 */
export function grammarLinks(s: string): Span[] {
  if (GRAMMAR_LINK_DEF.test(s)) return [{ start: 0, end: s.length }];
  const out: Span[] = [];
  const n = s.length;
  const close = new Int32Array(n).fill(-1);
  const stack: number[] = [];
  for (let k = 0; k < n; k++) {
    if (s[k] === '\\') k++;
    else if (s[k] === '[') stack.push(k);
    else if (s[k] === ']' && stack.length) close[stack.pop()!] = k;
  }

  // `(url "title")` from `p`, the grammar's link-inline tail: the end past `)`, or -1.
  const inlineTail = (p: number, image: boolean): number => {
    if (s[p] !== '(') return -1;
    let q = p + 1;
    while (q < n && (s[q] === ' ' || s[q] === '\t')) q++;
    const ends: number[] = [];
    if (s[q] === '<') {
      let k = q + 1;
      while (k < n && s[k] !== '>' && s[k] !== '<') k += s[k] === '\\' && (s[k + 1] === '<' || s[k + 1] === '>') ? 2 : 1;
      if (s[k] === '>') ends.push(k + 1);
    }
    // (?<url>(?>[^\s()]+)|\(\g<url>*\))* — every iteration boundary, longest first.
    const bounds = [q];
    let k = q;
    for (;;) {
      if (k < n && !/[\s()]/.test(s[k])) {
        while (k < n && !/[\s()]/.test(s[k])) k++;
        bounds.push(k);
      } else if (s[k] === '(') {
        let depth = 0;
        let j = k;
        for (; j < n; j++) {
          if (s[j] === '(') depth++;
          else if (s[j] === ')') { if (--depth === 0) break; } else if (/\s/.test(s[j])) { j = n; break; }
        }
        if (j >= n) break;
        k = j + 1;
        bounds.push(k);
      } else break;
    }
    ends.push(...bounds.reverse());
    for (const e of ends) {
      let t = e;
      while (t < n && (s[t] === ' ' || s[t] === '\t')) t++;
      const tries = [t];
      const open = s[t];
      const closeCh = open === '(' ? ')' : open === '"' || open === "'" ? open : '';
      if (closeCh) {
        for (let j = t + 1; j < n; j++) {
          if (!image && open === '(' && s[j] === '(') break;
          if (s[j] === closeCh) { tries.unshift(j + 1); if (!image) break; }
        }
      }
      for (const a of tries) {
        let z = a;
        while (z < n && /\s/.test(s[z])) z++;
        if (s[z] === ')') return z + 1;
      }
    }
    return -1;
  };

  for (let i = 0; i < n;) {
    const c = s[i];
    if (c === '\\') {
      i += GRAMMAR_ESCAPE.test(s[i + 1] ?? '') ? 2 : 1;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (s[j] === '`') j++;
      const len = j - i;
      let k = j;
      let end = -1;
      while (k < n) {
        const a = s.indexOf('`', k);
        if (a < 0) break;
        let b = a;
        while (s[b] === '`') b++;
        if (b - a === len) { end = b; break; }
        k = b;
      }
      i = end > 0 ? end : j;
      continue;
    }
    if (c === '<') {
      let end = -1;
      for (const re of [GRAMMAR_EMAIL, GRAMMAR_INET, GRAMMAR_TAG]) {
        re.lastIndex = i;
        if (re.test(s)) { end = re.lastIndex; break; }
      }
      i = end > 0 ? end : i + 1;
      continue;
    }
    const image = c === '!' && s[i + 1] === '[';
    if (c === '[' || image) {
      const o = image ? i + 1 : i;
      const ce = close[o];
      let end = -1;
      if (ce >= 0) {
        end = inlineTail(ce + 1, image);
        if (end < 0 && image) {
          let p = ce + 1;
          if (s[p] === ' ') p++;
          if (s[p] === '[') {
            const k = s.indexOf(']', p + 1);
            if (k >= 0) end = k + 1;
          }
        }
        const after = i > 0 ? s[i - 1] : '';
        if (end < 0 && !image && after !== ']' && after !== '\\') {
          if (s[ce + 1] === '[') {
            const k = s.indexOf(']', ce + 2);
            if (k >= 0) end = k + 1;
          }
          if (end < 0) {
            let p = ce + 1;
            if (s[p] === ' ') p++;
            if (s[p] === '[' && s[p + 1] === ']') end = p + 2;
          }
        }
      }
      if (end < 0 && !image && !(i > 0 && (s[i - 1] === ']' || s[i - 1] === '\\'))) {
        let k = i + 1;
        while (k < n) {
          if (s[k] === ']') { if (k > i + 1) end = k + 1; break; }
          if (s[k] === '\\' && (s[k + 1] === '[' || s[k + 1] === ']')) k += 2;
          else if (/[\s[\]\\]/.test(s[k])) break;
          else k++;
        }
      }
      if (end > 0) {
        out.push({ start: i, end });
        i = end;
        continue;
      }
      i += image ? 2 : 1;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * The bare links the theme's grammar paints in one block's inline content `v`: its scan of
 * each line, and of each `~~…~~`'s content, which the grammar's strikethrough rule scans
 * as text that ends at the closing `~~` (markdown-it's text runs end there too).
 */
export function proseBareLinks(v: string, inl: Inline): Span[] {
  const out = bareLinks(v);
  for (const e of inl.emph) {
    if (e.kind !== 'del') continue;
    for (const b of bareLinks(v.slice(e.start, e.end))) out.push({ start: e.start + b.start, end: e.start + b.end });
  }
  return mergeSpans(out);
}

/**
 * Colour, weight and underline restores for the markdown a TextMate grammar reads wrong
 * because it sees one line at a time and no definitions: a `[label]` with no matching
 * definition is plain text, a reference link's label carries no underline, a setext
 * heading's text is a heading and its underline a sigil, a block quote's lazy line is
 * quoted, a `===` line that heads no heading is text, emphasis across lines is emphasis,
 * a `\` that ends a paragraph or a heading is literal, and a link in struck text is struck.
 *
 * Bracket restores paint only where the grammar's link matches and CommonMark's links
 * disagree, so a link both read the same way gets no decoration. Footnote markers, task
 * boxes, wikilinks and callout types are the theme's and are left alone. `links` is
 * `linkSpans`' output, whose ranges in struck text move to `linkStruck`.
 */
export function proseMarks(text: string, highlights?: Span[], links?: Span[]): ProseMarks {
  if (!links) links = linkSpans(text);
  if (!highlights) highlights = highlightSpans(text, codeSpans(text), links);
  const blocks = parseBlocks(text);
  const tones: ToneSpan[] = [];
  const bold: Span[] = [];
  const italic: Span[] = [];
  const linkPlain: Span[] = [...blocks.defLabels];
  const linkStruck: Span[] = [];
  let hi = 0;
  let li = 0;
  const atLineEnd = (o: number): boolean => o >= text.length || text[o] === '\n' || text[o] === '\r';
  const lineStart = (o: number): boolean => o === 0 || text[o - 1] === '\n';

  for (const r of blocks.regions) {
    const whole = r.kind === 'setext';
    const anyLazy = r.quote && r.segs.some((g) => g.lazy);
    const first = r.segs[0].start;
    const last = r.segs[r.segs.length - 1].end;
    const base: Tone = r.kind === 'atx' || r.kind === 'setext' || r.kind === 'th' ? 'emphasis' : r.quote || r.footnote ? 'quote' : 'prose';
    const heavy = r.kind === 'atx' || r.kind === 'th';

    // The underline, where the grammar's `^(={3,}|-{3,})` cannot see it.
    const u = r.underline;
    if (u && !(lineStart(u.start) && u.end - u.start >= 3)) tones.push({ start: u.start, end: u.end, tone: 'sigil' });

    // A literal `\` at the end of the last line: the grammar paints every line-end `\` a hard break.
    let literalEnd = false;
    if (!whole && text[last - 1] === '\\' && atLineEnd(last)) {
      let k = last - 1;
      while (k > first && text[k - 1] === '\\') k--;
      literalEnd = (last - k) % 2 === 1;
    }
    if (literalEnd) {
      tones.push({ start: last - 1, end: last, tone: r.done ? 'struck' : base });
      if (heavy) bold.push({ start: last - 1, end: last });
      if (r.done) linkStruck.push({ start: last - 1, end: last });
    }

    // `===` lines the grammar paints as an underline, in a paragraph CommonMark gives no heading.
    const eqLines = r.kind === 'paragraph' ? r.segs.filter((g) => text[g.start] === '=' && lineStart(g.start) && /^={3,}$/.test(text.slice(g.start, g.end))) : [];

    // linkSpans' ranges here, which keep the line-through in struck text.
    while (li < links.length && links[li].end <= first) li++;
    let lj = li;
    while (lj < links.length && links[lj].start < last) lj++;
    const struckLinks = lj > li && (r.done || r.segs.some((g) => text.slice(g.start, g.end).includes('~~')));

    if (!whole && !anyLazy && !eqLines.length && !struckLinks && !r.segs.some((g) => text.slice(g.start, g.end).includes('['))) continue;
    const { v, at } = joinSegs(text, r.segs);
    const n = v.length;
    if (!n) continue;
    const inl = parseInline(v, blocks.defs);
    const doc = (i: number): number => docOffset(r.segs, at, i);
    const toV = (o: number): number => {
      for (let k = r.segs.length - 1; k >= 0; k--) {
        if (o >= r.segs[k].start) return at[k] + Math.min(o, r.segs[k].end) - r.segs[k].start;
      }
      return 0;
    };

    // Per index of `v`: what CommonMark makes of it, and whether it is in the paint domain.
    const f = new Uint16Array(n);
    const mark = (a: number, b: number, bit: number): void => {
      for (let k = Math.max(0, a); k < Math.min(n, b); k++) f[k] |= bit;
    };
    for (const o of inl.opaque) mark(o.start, o.end, SKIP);
    for (const c of inl.codes) {
      mark(c.start, c.end, CODE);
      for (let k = c.start; v[k] === '`'; k++) f[k] |= DELIM;
      for (let k = c.end - 1; k >= c.start && v[k] === '`' && !(f[k] & DELIM); k--) f[k] |= DELIM;
    }
    for (const a of inl.autolinks) {
      mark(a.start + 1, a.end - 1, AUTO);
      f[a.start] |= DELIM | AUTO;
      f[a.end - 1] |= DELIM | AUTO;
    }
    for (const e of inl.escapes) f[e] |= ESC;
    for (const d of inl.delims) f[d] |= DELIM;
    for (const e of inl.emph) mark(e.start, e.end, e.kind === 'del' ? DEL : e.kind === 'em' ? EMPH | ITALIC : EMPH | BOLD);
    for (const l of inl.links) {
      if (l.image) { mark(l.open, l.end, SKIP); continue; }
      mark(l.open, l.textStart, SYNTAX);
      mark(l.textEnd, l.end, SYNTAX);
      mark(l.textStart, l.textEnd, LINK);
      if (l.label) mark(l.label.start, l.label.end, LABEL);
    }
    for (const b of proseBareLinks(v, inl)) mark(b.start, b.end, KEEP);
    while (hi < highlights.length && highlights[hi].end <= first) hi++;
    for (let k = hi; k < highlights.length && highlights[k].start < last; k++) {
      const a = toV(highlights[k].start);
      const b = toV(highlights[k].end);
      mark(a, b, EMPH);
      mark(a - 2, a, DELIM);
      mark(b, b + 2, DELIM);
    }

    // The paint domain: grammar link matches and CommonMark links that are not the same span.
    const grammar = new Set<string>();
    for (let k = 0; k < r.segs.length; k++) {
      for (const g of grammarLinks(text.slice(r.segs[k].start, r.segs[k].end))) grammar.add(`${at[k] + g.start}:${at[k] + g.end}`);
    }
    const cm = new Set(inl.links.map((l) => `${l.open}:${l.end}`));
    for (const g of grammar) {
      if (cm.has(g)) continue;
      const [a, b] = g.split(':').map(Number);
      mark(a, b, DOMAIN);
    }
    for (const l of inl.links) if (!l.image && !grammar.has(`${l.open}:${l.end}`)) mark(l.open, l.end, DOMAIN);
    // A code span, autolink, tag or link that a disagreement reaches into is restored whole.
    for (const o of [...inl.opaque, ...inl.links.filter((l) => !l.image).map((l) => ({ start: l.open, end: l.end }))]) {
      let touched = false;
      for (let k = o.start; k < o.end && !touched; k++) touched = (f[k] & DOMAIN) !== 0;
      if (touched) mark(o.start, o.end, DOMAIN);
    }

    // The theme's own bracket marks: footnote markers, wikilinks, a callout type, a task box.
    for (const re of [/\[\^[^\]\s]+\]/g, /\[\[[^\]\n]*\]\]/g]) {
      for (let m: RegExpExecArray | null; (m = re.exec(v));) mark(m.index, m.index + m[0].length, SKIP);
    }
    if (r.quote) {
      const callout = /^\[![A-Za-z][A-Za-z-]*\]/.exec(v);
      if (callout) mark(0, callout[0].length, SKIP);
    }
    if (r.task) mark(0, 3, SKIP);

    const struck = (i: number): boolean => r.done || (f[i] & DEL) !== 0;
    const toneAt = (i: number): Tone => (struck(i) ? 'struck' : f[i] & EMPH ? 'emphasis' : base);
    const linkTone: Tone = r.done ? 'struck' : 'link';

    // Lines painted whole: a block quote's lazy lines, and `===` lines that are text.
    const line = new Uint8Array(n);
    for (let k = 0; k < r.segs.length; k++) {
      if ((anyLazy && r.segs[k].lazy) || eqLines.includes(r.segs[k])) line.fill(1, at[k], at[k] + r.segs[k].end - r.segs[k].start);
    }

    const paint: (Tone | null)[] = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const x = f[i];
      if (v[i] === '\n') continue;
      if (x & DOMAIN && x & (CODE | AUTO)) {
        paint[i] = x & DELIM ? 'sigil' : x & CODE ? 'code' : linkTone;
      } else if (x & SKIP) {
        continue;
      } else if (x & DOMAIN) {
        if (x & KEEP && !(x & LINK)) continue;
        paint[i] = x & LABEL ? linkTone : x & (SYNTAX | DELIM | ESC) ? 'sigil' : x & LINK ? linkTone : toneAt(i);
      } else if (x & ESC && x & LINK) {
        // The grammar's link text has no escapes: the backslash would read as link text.
        paint[i] = 'sigil';
      } else if (whole || line[i]) {
        if (x & DELIM) paint[i] = 'sigil';
        else if (!(x & (SYNTAX | ESC | LINK | LABEL | KEEP))) paint[i] = toneAt(i);
      }
    }
    if (literalEnd) paint[n - 1] = null;
    for (let i = 0; i < n;) {
      const t = paint[i];
      if (t === null) { i++; continue; }
      let j = i + 1;
      while (j < n && paint[j] === t && v[j] !== '\n') j++;
      tones.push({ start: doc(i), end: doc(j - 1) + 1, tone: t });
      i = j;
    }

    // A `v` range as document ranges, split where lines join.
    const emit = (list: Span[], a: number, b: number): void => {
      let s0 = a;
      for (let i = a; i <= b; i++) {
        if (i < b && v[i] !== '\n') continue;
        if (i > s0) list.push({ start: doc(s0), end: doc(i - 1) + 1 });
        s0 = i + 1;
      }
    };
    // Each run of restored text where `test` holds, into `list`.
    const runs = (list: Span[], test: (i: number) => boolean): void => {
      for (let i = 0; i < n;) {
        if (!test(i)) { i++; continue; }
        let j = i + 1;
        while (j < n && test(j)) j++;
        emit(list, i, j);
        i = j;
      }
    };
    const styled = (i: number): boolean => paint[i] !== null && paint[i] !== 'sigil' && paint[i] !== 'code';
    runs(italic, (i) => styled(i) && (f[i] & ITALIC) !== 0);
    runs(bold, (i) => styled(i) && (f[i] & BOLD) !== 0);

    const plain = (i: number): boolean => (f[i] & DOMAIN) !== 0 && v[i] !== '\n' && (!(f[i] & SKIP) || (f[i] & (CODE | AUTO)) !== 0);
    for (let i = 0; i < n;) {
      if (!plain(i)) { i++; continue; }
      const st = struck(i);
      let j = i + 1;
      while (j < n && plain(j) && struck(j) === st) j++;
      emit(st ? linkStruck : linkPlain, i, j);
      i = j;
    }
    for (const l of inl.links) {
      if (l.kind === 'inline' || f[l.open] & DOMAIN) continue;
      for (const [a, b] of [[l.textStart, l.textEnd], l.label ? [l.label.start, l.label.end] : [0, 0]]) {
        if (b > a && !(f[a] & SKIP)) emit(struck(a) ? linkStruck : linkPlain, a, b);
      }
    }
    if (struckLinks) {
      // Struck in the grammar: all of `~~…~~`, and a done task's text but for its links' targets.
      const inLink = new Uint8Array(n);
      for (let k = li; k < lj; k++) inLink.fill(1, toV(links[k].start), toV(links[k].end));
      runs(linkStruck, (i) => inLink[i] === 1 && v[i] !== '\n' && ((f[i] & DEL) !== 0 || (r.done && !(f[i] & SYNTAX))));
    }
    if (whole) {
      // Emphasis sigils stay light, as the theme keeps them in an ATX heading; backticks do not.
      runs(bold, (i) => v[i] !== '\n' && !((f[i] & DELIM) !== 0 && !(f[i] & (CODE | AUTO))));
    }
  }
  tones.sort((a, b) => a.start - b.start);
  return { tones, bold: mergeSpans(bold), italic: mergeSpans(italic), linkPlain: mergeSpans(linkPlain), linkStruck: mergeSpans(linkStruck) };
}

// proseMarks' per-character flags.
const SKIP = 1;
const SYNTAX = 2;
const LINK = 4;
const EMPH = 8;
const DEL = 16;
const DOMAIN = 32;
const KEEP = 64;
const LABEL = 128;
const ESC = 256;
const DELIM = 512;
const CODE = 1024;
const AUTO = 2048;
const ITALIC = 4096;
const BOLD = 8192;
