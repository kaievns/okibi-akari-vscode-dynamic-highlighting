/**
 * Comment-colour restores, painted by the decorator's `commentRestore`. Band 1:
 * phase-independent, cached per version, no server needed.
 *
 * Go doc links (`[Name]`, `[pkg.Name]`, `[*pkg.Name]`) inside comments: gopls
 * types each one like code — `variable`, `namespace`, `function` — with no
 * modifier that marks it as a comment, so the theme paints it as code and no
 * selector can single it out. See docs/runtime.md#go-doc-links.
 *
 * Brackets in Rust comments: bracket-pair colorization can colour them by level
 * after a theme change. See docs/runtime.md#brackets-in-rust-comments-and-strings.
 */

import { LexResult } from './lex';

const DOC_LINK = /\[\*?([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)\]/gu;

/** The name inside every doc link in a comment or doc span; brackets excluded. */
export function goDocLinkSpans(text: string, lex: LexResult): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const s of lex.spans) {
    if (s.region !== 'comment' && s.region !== 'doc') {
      continue;
    }
    const body = text.slice(s.start, s.end);
    DOC_LINK.lastIndex = 0;
    for (let m = DOC_LINK.exec(body); m !== null; m = DOC_LINK.exec(body)) {
      const start = s.start + m.index + m[0].indexOf(m[1]);
      out.push({ start, end: start + m[1].length });
    }
  }
  return out;
}

/**
 * Every `(` `)` `[` `]` `{` `}` in a comment or doc span, one character each. With
 * `jsdoc`, only in `/**` comments: the JavaScript and TypeScript grammars give a
 * JSDoc type and a `[name]` token type other, so only those reach bracket-pair
 * colorization.
 */
export function commentBracketSpans(text: string, lex: LexResult, jsdoc = false): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const s of lex.spans) {
    if ((s.region !== 'comment' && s.region !== 'doc') || (jsdoc && !text.startsWith('/**', s.start))) {
      continue;
    }
    for (let i = s.start; i < s.end; i++) {
      const c = text.charCodeAt(i);
      if (c === 40 || c === 41 || c === 91 || c === 93 || c === 123 || c === 125) {
        out.push({ start: i, end: i + 1 });
      }
    }
  }
  return out;
}
