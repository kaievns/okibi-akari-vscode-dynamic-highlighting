/**
 * A PHP page's code regions: the PHP between each open tag and its `?>`. Everything
 * else is markup, outside every scope (docs/php.md).
 */
import { ScriptRegion, codeView } from './html';
import { phpHeredocAt } from './lex';

/** `<?php` (any case) before a blank or the end, `<?=`, or a bare `<?`: the grammar's `php-tag` and PHP's lexer with short tags on. */
const OPEN = /<\?(?:[pP][hH][pP](?=\s|$)|=)?/g;

/** Offset after the quote that closes the `'`, `"` or `` ` `` string opening at `i`; a `{$…}` hole is code. */
function stringEnd(t: string, i: number): number {
  const q = t[i];
  const n = t.length;
  for (let j = i + 1; j < n; j++) {
    const c = t[j];
    if (c === '\\') j++;
    else if (c === q) return j + 1;
    else if (q !== "'" && c === '{' && t[j + 1] === '$') j = codeEnd(t, j + 1, '}') - 1;
  }
  return n;
}

/**
 * Offset of the `?>` that ends the PHP code from `i` (or of `stop` at depth 0), else the
 * text's length. Strings, heredocs and block comments hide a `?>`; a line comment ends at one.
 */
function codeEnd(t: string, i: number, stop?: '}'): number {
  const n = t.length;
  let depth = 0;
  for (let j = i; j < n; j++) {
    const c = t[j];
    if (c === '?' && t[j + 1] === '>') return j;
    if (stop) {
      if (c === '{') depth++;
      else if (c === '}' && depth-- === 0) return j + 1;
    }
    if (c === "'" || c === '"' || c === '`') {
      j = stringEnd(t, j) - 1;
    } else if (c === '<' && t.startsWith('<<<', j)) {
      const h = phpHeredocAt(t, j);
      j = h ? h.end - 1 : j + 2;
    } else if (c === '/' && t[j + 1] === '*') {
      const e = t.indexOf('*/', j + 2);
      j = e < 0 ? n : e + 1;
    } else if ((c === '/' && t[j + 1] === '/') || (c === '#' && t[j + 1] !== '[')) {
      for (j++; j < n && t[j] !== '\n'; j++) {
        if (t[j] === '?' && t[j + 1] === '>') return j;
      }
    }
  }
  return n;
}

const cache: { text: string | undefined; regions: ScriptRegion[]; view: string } = { text: undefined, regions: [], view: '' };

/** The PHP regions of a page, from after each open tag to its `?>`, else the end. */
export function phpRegions(text: string): ScriptRegion[] {
  if (cache.text === text) return cache.regions;
  const out: ScriptRegion[] = [];
  OPEN.lastIndex = 0;
  for (let m = OPEN.exec(text); m; m = OPEN.exec(text)) {
    const start = m.index + m[0].length;
    const end = codeEnd(text, start);
    out.push({ start, end });
    OPEN.lastIndex = end + 2;
  }
  cache.text = text;
  cache.regions = out;
  cache.view = codeView(text, out, []);
  return out;
}

/** The page as the layer reads it: the markup blanked, a mark on each tag's last character before its region and on each `?`. */
export function phpView(text: string): string {
  phpRegions(text);
  return cache.view;
}
