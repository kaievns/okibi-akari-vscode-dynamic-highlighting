/**
 * The JavaScript inside an HTML document's `<script>` elements, as the layer reads
 * it: the script view. Every character outside a script's content is blanked (a
 * space, line breaks kept), so offsets and lines are the document's, and the
 * character before each script's content and the one at its end are a form feed,
 * the mark the lexer splits on. Which elements: docs/html.md#script-regions.
 */

/** The `type` values VS Code's HTML grammar (text.html.basic) embeds `source.js` for: the value's start, then a space or its end. */
const JS_TYPE = /^(?:text\/(?:javascript(?:1\.[0-5])?|x-javascript|jscript|livescript|(?:x-)?ecmascript|babel)|application\/(?:(?:x-)?javascript|(?:x-)?ecmascript)|module)(?:\s|$)/i;
/** The `type` values whose content the grammar reads as HTML again. */
const TEMPLATE_TYPE = /^text\/(?:x-handlebars|(?:x-(?:handlebars-)?|ng-)?template|html)(?:\s|$)/i;

export const REGION_MARK = '\f';

export interface ScriptRegion {
  /** Offset of the content's first character, after the start tag's `>`. */
  start: number;
  /** Offset of the `<` of `</script`, or the document's length. */
  end: number;
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

interface Tag {
  /** Offset after the tag's `>`, or the document's length when it has none. */
  end: number;
  closed: boolean;
  /** A `/` outside every attribute value, as in `<script/>`. */
  slash: boolean;
  types: { value: string; quoted: boolean; next: string }[];
}

function startTag(t: string, i: number): Tag {
  const n = t.length;
  const types: Tag['types'] = [];
  let slash = false;
  while (i < n) {
    while (i < n && isSpace(t[i])) i++;
    if (i >= n) break;
    if (t[i] === '>') return { end: i + 1, closed: true, slash, types };
    if (t[i] === '/') {
      slash = true;
      i++;
      continue;
    }
    const ns = i;
    while (i < n && !isSpace(t[i]) && t[i] !== '=' && t[i] !== '>' && !(t[i] === '/' && t[i + 1] === '>')) i++;
    const name = t.slice(ns, i).toLowerCase();
    if (name === '') {
      i++;
      continue;
    }
    let j = i;
    while (j < n && isSpace(t[j])) j++;
    if (t[j] !== '=') continue;
    j++;
    while (j < n && isSpace(t[j])) j++;
    let value: string;
    let quoted = false;
    if (t[j] === '"' || t[j] === "'") {
      const k = t.indexOf(t[j], j + 1);
      value = t.slice(j + 1, k < 0 ? n : k);
      quoted = true;
      i = k < 0 ? n : k + 1;
    } else {
      const vs = j;
      while (j < n && !isSpace(t[j]) && t[j] !== '>') j++;
      value = t.slice(vs, j);
      i = j;
    }
    if (name === 'type') types.push({ value, quoted, next: t[i] ?? '' });
  }
  return { end: n, closed: false, slash, types };
}

/** Whether the grammar paints a `<script>` with this start tag as JavaScript, as HTML, or as neither. */
function scriptKind(tag: Tag): 'js' | 'html' | 'none' {
  if (tag.slash) return 'none';
  // The first `type` the grammar does not read as JavaScript decides.
  for (const ty of tag.types) {
    if (ty.value === '') continue;
    if (TEMPLATE_TYPE.test(ty.value)) return 'html';
    // An unquoted value with a `/` ends the grammar's attribute state at the `>` right after it.
    if (!JS_TYPE.test(ty.value) || (!ty.quoted && ty.value.includes('/') && ty.next === '>')) return 'none';
  }
  return 'js';
}

/** Offset after the `</name` close tag that ends a `<style>`, `<svg>` or `<math>` whose start tag ends at `from`. */
function elementEnd(text: string, lower: string, name: string, from: number): number {
  const n = text.length;
  if (name === 'style') {
    const e = lower.indexOf('</style', from);
    return e < 0 ? n : e;
  }
  // In `<svg>` and `<math>` the grammar reads `<script>` as plain text; the element ends at its own `</name>`, nested ones counted.
  let depth = 1;
  let i = from;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) return n;
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (lower.startsWith(`</${name}`, lt) && /^\s*>/.test(text.slice(lt + name.length + 2, lt + name.length + 66))) {
      i = text.indexOf('>', lt) + 1;
      if (--depth === 0) return i;
      continue;
    }
    const m = /^<([A-Za-z][A-Za-z0-9:_.-]*)/.exec(text.slice(lt, lt + 64));
    if (!m) {
      i = lt + 1;
      continue;
    }
    const tag = startTag(text, lt + m[0].length);
    if (m[1].toLowerCase() === name && tag.closed && text[tag.end - 2] !== '/') depth++;
    i = tag.end;
  }
  return n;
}

const cache: { text: string | undefined; regions: readonly ScriptRegion[] } = { text: undefined, regions: [] };

/**
 * The content of every `<script>` element VS Code's HTML grammar paints as
 * JavaScript, in document order. Comments, CDATA, `<style>`, `<svg>`, `<math>` and
 * other tags are skipped; a template `<script>`'s content is read as markup, so a
 * `<script>` inside it counts. A script ends at the first `</script`,
 * case-insensitive, as an HTML parser and the HTML language server end it.
 */
export function scriptRegions(text: string): readonly ScriptRegion[] {
  if (cache.text === text) return cache.regions;
  const out: ScriptRegion[] = [];
  const lower = text.toLowerCase();
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt);
      i = e < 0 ? n : e + 3;
      continue;
    }
    const m = /^<([A-Za-z][A-Za-z0-9:_.-]*)/.exec(text.slice(lt, lt + 64));
    if (!m) {
      i = lt + 1;
      continue;
    }
    const tag = startTag(text, lt + m[0].length);
    const name = m[1].toLowerCase();
    if (!tag.closed) break;
    if (name === 'style' || name === 'svg' || name === 'math') {
      i = elementEnd(text, lower, name, tag.end);
      continue;
    }
    if (name !== 'script') {
      i = tag.end;
      continue;
    }
    const kind = scriptKind(tag);
    if (kind === 'html') {
      i = tag.end;
      continue;
    }
    const close = lower.indexOf('</script', tag.end);
    const end = close < 0 ? n : close;
    if (kind === 'js') out.push({ start: tag.end, end });
    i = end;
  }
  cache.text = text;
  cache.regions = out;
  return out;
}

/** The document as the layer reads its scripts (see the file comment). */
export function scriptView(text: string): string {
  const regions = scriptRegions(text);
  const parts: string[] = [];
  const blank = (s: string): string => s.replace(/[^\n\r]+/g, (run) => ' '.repeat(run.length));
  let at = 0;
  for (const r of regions) {
    // The mark sits on the start tag's `>`.
    parts.push(blank(text.slice(at, r.start - 1)), REGION_MARK, text.slice(r.start, r.end).replace(/\f/g, ' '));
    if (r.end < text.length) {
      parts.push(REGION_MARK);
      at = r.end + 1;
    } else {
      at = r.end;
    }
  }
  parts.push(blank(text.slice(at)));
  return parts.join('');
}

const viewCache: { view: string | undefined; regions: readonly ScriptRegion[] } = { view: undefined, regions: [] };

/** The script regions of a script view, read back from its marks. */
export function viewRegions(view: string): readonly ScriptRegion[] {
  if (viewCache.view === view) return viewCache.regions;
  const out: ScriptRegion[] = [];
  let i = view.indexOf(REGION_MARK);
  while (i >= 0) {
    const close = view.indexOf(REGION_MARK, i + 1);
    out.push({ start: i + 1, end: close < 0 ? view.length : close });
    if (close < 0) break;
    i = view.indexOf(REGION_MARK, close + 1);
  }
  viewCache.view = view;
  viewCache.regions = out;
  return out;
}

/** The script region holding `offset` (its end included, so a caret right after the last character counts), else undefined. */
export function regionAt(regions: readonly ScriptRegion[], offset: number): ScriptRegion | undefined {
  let lo = 0;
  let hi = regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = regions[mid];
    if (offset < r.start) hi = mid - 1;
    else if (offset > r.end) lo = mid + 1;
    else return r;
  }
  return undefined;
}

/** The text the layer's scanners read for a document: an HTML document's script view, else the text itself. */
export function flowText(text: string, languageId: string): string {
  return languageId === 'html' ? scriptView(text) : text;
}
