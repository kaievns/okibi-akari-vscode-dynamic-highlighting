/**
 * The code in an MDX document: ESM blocks, `{…}` expressions and JSX tags, on top
 * of markdown's own code. The markdown marks skip all of it (docs/mdx.md).
 */
import { closedLineBreak, braceExpressionEnd } from './lex';
import { Span, codeSpans, mergeSpans } from './markdown';

const ESM_START = /^(?:import|export)(?![\w$])/;
const BLANK = /^[ \t]*$/;

/** End of the ESM block whose first line starts at `start`: the first blank line where the JavaScript is closed. */
function esmEnd(text: string, start: number): number {
  const rest = text.slice(start);
  const nl = closedLineBreak(rest, (at) => {
    const next = rest.indexOf('\n', at);
    return BLANK.test(rest.slice(at, next < 0 ? rest.length : next));
  });
  return nl < 0 ? text.length : start + nl;
}

/** Offset after the `>` of the JSX tag whose `<` is at `i`, skipping quoted values and `{…}` expressions. */
function tagEnd(text: string, i: number): number {
  const n = text.length;
  for (let j = i + 1; j < n; j++) {
    const c = text[j];
    if (c === '>') return j + 1;
    if (c === '"' || c === "'") {
      const k = text.indexOf(c, j + 1);
      if (k < 0) return n;
      j = k;
    } else if (c === '{') {
      j = braceExpressionEnd(text, j + 1, true);
    }
  }
  return n;
}

const JSX_OPEN = /[A-Za-z>]/;

/** Markdown's code spans plus MDX's ESM, expressions and JSX tags, sorted and merged. */
export function mdxCodeSpans(text: string): Span[] {
  const md = codeSpans(text);
  const out: Span[] = [...md];
  let k = 0;
  const n = text.length;
  let lineStart = true;
  for (let i = 0; i < n; i++) {
    while (k < md.length && md[k].end <= i) k++;
    if (k < md.length && md[k].start <= i) {
      i = md[k].end - 1;
      lineStart = text[i] === '\n';
      continue;
    }
    const c = text[i];
    if (lineStart && ESM_START.test(text.slice(i, i + 7))) {
      const end = esmEnd(text, i);
      out.push({ start: i, end });
      i = end - 1;
      lineStart = false;
      continue;
    }
    lineStart = c === '\n';
    if (c === '\\') {
      i++;
    } else if (c === '{') {
      const close = braceExpressionEnd(text, i + 1, true);
      out.push({ start: i, end: Math.min(n, close + 1) });
      i = close;
    } else if (c === '<' && (JSX_OPEN.test(text[i + 1] ?? '') || (text[i + 1] === '/' && JSX_OPEN.test(text[i + 2] ?? '')))) {
      const end = tagEnd(text, i);
      out.push({ start: i, end });
      i = end - 1;
    }
  }
  return mergeSpans(out);
}
