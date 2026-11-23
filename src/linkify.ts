/**
 * What is a link without markdown syntax, on each side of the editor and the preview.
 *
 *   - `bareLinks`: the URLs and emails the preview links on its own. VS Code's markdown-it runs
 *     linkify-it 5 with `fuzzyLink` off, so this is the theme's `bare-link` injection,
 *     composed from the same linkify-it parts (`scripts/md_linkify.js` in the theme).
 *   - `detectedUrls`: the URLs the editor underlines on its own, VS Code's link computer
 *     (`vs/editor/common/languages/linkComputer.ts`), which it registers for every language.
 *
 * Pure, no vscode. docs/markdown.md § The underline.
 */

export interface Span {
  start: number;
  end: number;
}

const ZPCc = String.raw`[\p{Z}\p{P}\p{Cc}]`;
const ZCc = String.raw`[\p{Z}\p{Cc}]`;
const SEP = '[><｜]';
const LETTER = String.raw`[^\p{Z}\p{P}\p{Cc}><｜]`;
const XN = String.raw`xn--[a-z0-9\-]{1,59}`;
const DOMAIN = `(?:${XN}|${LETTER}|${LETTER}(?:-|${LETTER}){0,61}${LETTER})`;
const DOMAIN_ROOT = `(?:${XN}|${LETTER}{1,63})`;
const HOST = `(?:(?:${DOMAIN}\\.)*${DOMAIN})`;
const PORT = String.raw`(?::(?:6(?:[0-4]\d{3}|5(?:[0-4]\d{2}|5(?:[0-2]\d|3[0-5])))|[1-5]?\d{1,4}))?`;
const HOST_END = `(?=$|${SEP}|${ZPCc})(?!-|_|:\\d|\\.-|\\.(?!$|${ZPCc}))`;
const AUTH = `(?:(?:(?!${ZCc}|[@/\\[\\]()]).){1,50}@)?`;
const PATH = `(?:[/?#](?:(?!${ZCc}|${SEP}|[()\\[\\]{}.,"'?!\\-;]).|\\[(?:(?!${ZCc}|\\]).)*\\]|\\((?:(?!${ZCc}|[)]).)*\\)`
  + `|\\{(?:(?!${ZCc}|[}]).)*\\}|"(?:(?!${ZCc}|["]).)+"|'(?:(?!${ZCc}|[']).)+'|'(?=${LETTER}|[-])|\\.{2,}[a-zA-Z0-9%/&]`
  + `|\\.(?!${ZCc}|[.]|$)|-+|,(?!${ZCc}|$)|;(?!${ZCc}|$)|!+(?!${ZCc}|[!]|$)|\\?(?!${ZCc}|[?]|$))+|/)?`;
const AMP = '&(?!(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});)';
const NAME = `(?:[\\-;:=\\+\\$,\\.a-zA-Z0-9_]|${AMP})(?:[\\-;:=\\+\\$,"\\.a-zA-Z0-9_]|${AMP}){0,63}`;
const IP4 = '(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)';
const TLDS = 'biz|com|edu|gov|net|org|pro|web|xxx|aero|asia|coop|info|museum|name|shop|рф|a[cdefgilmnoqrstuwxz]'
  + '|b[abdefghijmnorstvwyz]|c[acdfghiklmnoruvwxyz]|d[ejkmoz]|e[cegrstu]|f[ijkmor]|g[abdefghilmnpqrstuwy]|h[kmnrtu]'
  + '|i[delmnoqrst]|j[emop]|k[eghimnprwyz]|l[abcikrstuvy]|m[acdeghklmnopqrstuvwxyz]|n[acefgilopruz]|om|p[aefghklmnrstwy]'
  + '|qa|r[eosuw]|s[abcdeghijklmnortuvxyz]|t[cdfghjklmnortvwz]|u[agksyz]|v[aceginu]|w[fs]|y[et]|z[amw]|xn--[a-z0-9\\-]{1,59}';
const AFTER_PUNCT = String.raw`(?<![^\p{Z}\p{P}\p{Cc}><｜])(?<!_)`;

// The theme's four bare-link patterns, in its order. `m`: an Oniguruma `$` is a line end.
const BARE = [
  `(?<![a-zA-Z0-9+])(?:https?|ftp)://${AUTH}${HOST}${PORT}${HOST_END}${PATH}(?<!\\*)`,
  `${AFTER_PUNCT}(?<![:/])//${AUTH}(?:localhost|(?:${DOMAIN}\\.)+${DOMAIN_ROOT})${PORT}${HOST_END}${PATH}`,
  `${AFTER_PUNCT}mailto:${NAME}@${HOST}${HOST_END}`,
  `(?<![^\\p{Z}\\p{Cc}><｜"(*_~])${NAME}@(?:${IP4}|(?:${DOMAIN}\\.)+(?:${TLDS}))${HOST_END}`,
].map((p) => new RegExp(p, 'gimu'));
// What each pattern cannot match without, to skip a pattern that has nothing to find.
const NEEDS = [/:\/\//, /\/\//, /mailto:/i, /@/];

/**
 * The bare URLs and emails in `s`, as a TextMate scan finds them: at each position the
 * earliest match of the four patterns, the first pattern on a tie, then on past it.
 */
export function bareLinks(s: string): Span[] {
  const out: Span[] = [];
  const next: (Span | null | undefined)[] = NEEDS.map((re) => (re.test(s) ? undefined : null));
  for (let p = 0; p < s.length;) {
    let best = -1;
    for (let k = 0; k < BARE.length; k++) {
      let m = next[k];
      if (m === undefined || (m !== null && m.start < p)) {
        BARE[k].lastIndex = p;
        const r = BARE[k].exec(s);
        m = r && r[0].length ? { start: r.index, end: r.index + r[0].length } : null;
        next[k] = m;
      }
      if (m && (best < 0 || m.start < next[best]!.start)) best = k;
    }
    if (best < 0) break;
    const m = next[best]!;
    out.push(m);
    p = m.end;
  }
  return out;
}

// linkComputer's state machine: h|f, t|i, t|l, p|e, s?, ':', '/', '/'. 0 is invalid.
const START = 1;
const END = 12;
const ACCEPT = 13;
const TRANSITIONS: [number, string, number][] = [
  [1, 'h', 2], [1, 'f', 6], [2, 't', 3], [3, 't', 4], [4, 'p', 5], [5, 's', 9], [5, ':', 10],
  [6, 'i', 7], [7, 'l', 8], [8, 'e', 9], [9, ':', 10], [10, '/', 11], [11, '/', END],
];
const NEXT = new Map<number, number>();
for (const [from, ch, to] of TRANSITIONS) {
  for (const c of new Set([ch, ch.toUpperCase()])) NEXT.set(from * 65536 + c.charCodeAt(0), to);
}
const FORCE = 1;
const CANNOT_END = 2;
const CLASS = new Map<number, number>();
for (const ch of ' \t<>\'"、。｡､，．：；‘〈「『〔（［｛｢｣｝］）〕』」〉’｀～…|') CLASS.set(ch.charCodeAt(0), FORCE);
for (const ch of '.,;:') CLASS.set(ch.charCodeAt(0), CANNOT_END);

/** The `http(s)://` and `file://` links VS Code's link computer finds, line by line. */
export function detectedUrls(text: string): Span[] {
  const out: Span[] = [];
  if (!text.includes('://')) return out;
  const cls = (c: number): number => CLASS.get(c) ?? 0;
  let sep = -1;
  for (let base = 0; base <= text.length;) {
    let nl = text.indexOf('\n', base);
    if (nl < 0) nl = text.length;
    const len = nl > base && text.charCodeAt(nl - 1) === 13 ? nl - base - 1 : nl - base;
    const at = (i: number): number => text.charCodeAt(base + i);
    const make = (start: number, end: number): void => {
      let last = end - 1;
      do {
        if (cls(at(last)) !== CANNOT_END) break;
        last--;
      } while (last > start);
      if (start > 0) {
        const a = at(start - 1);
        const b = at(last);
        if ((a === 40 && b === 41) || (a === 91 && b === 93) || (a === 123 && b === 125)) last--;
      }
      out.push({ start: base + start, end: base + last + 1 });
    };
    if (sep < base) sep = text.indexOf('://', base);
    if (sep < 0) break;
    if (sep < base + len) {
      let state = START;
      let linkStart = 0;
      let before = 0;
      let paren = false;
      let bracket = false;
      let inBracket = false;
      let curly = false;
      for (let j = 0; j < len; j++) {
        const c = at(j);
        let reset = false;
        if (state === ACCEPT) {
          let k: number;
          switch (c) {
            case 40: paren = true; k = 0; break;
            case 41: k = paren ? 0 : FORCE; break;
            case 91: inBracket = true; bracket = true; k = 0; break;
            case 93: inBracket = false; k = bracket ? 0 : FORCE; break;
            case 123: curly = true; k = 0; break;
            case 125: k = curly ? 0 : FORCE; break;
            case 39: case 34: case 96:
              k = before === c ? FORCE : before === 39 || before === 34 || before === 96 ? 0 : FORCE;
              break;
            case 42: k = before === 42 ? FORCE : 0; break;
            case 32: k = inBracket ? 0 : FORCE; break;
            default: k = cls(c);
          }
          if (k === FORCE) {
            make(linkStart, j);
            reset = true;
          }
        } else if (state === END) {
          const k = c === 91 ? 0 : cls(c);
          if (c === 91) bracket = true;
          if (k === FORCE) reset = true;
          else state = ACCEPT;
        } else {
          state = NEXT.get(state * 65536 + c) ?? 0;
          if (state === 0) reset = true;
        }
        if (reset) {
          state = START;
          paren = false;
          bracket = false;
          curly = false;
          linkStart = j + 1;
          before = c;
        }
      }
      if (state === ACCEPT) make(linkStart, len);
    }
    base = nl + 1;
  }
  return out;
}
