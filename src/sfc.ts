/**
 * The code inside a Vue, Svelte or Astro component, as the layer reads it: its
 * script blocks, the Astro frontmatter and every template expression. The rest is
 * markup. `componentRegions` finds them; `src/html.ts` builds the view. Rules per
 * framework: docs/components.md#code-regions.
 */

import { braceExpressionEnd } from './lex';

/** `code` is lexed and classified; a `pattern` also declares the names it binds (an each alias, a slot's props). */
export type RegionKind = 'code' | 'pattern';

export interface CodeRegion {
  start: number;
  end: number;
  kind: RegionKind;
  /** A `<script>` whose content is JavaScript, not TypeScript: the grammar embeds `source.js` there. */
  js?: boolean;
}

/** A template construct that scopes the names a pattern binds: `{#each}`…`{/each}`, an element with `v-for`. */
export interface TemplateBlock {
  /** Offset of the opening `{` or `<`. */
  open: number;
  /** Offset of the closing `}` or `>`. */
  close: number;
  /** An Astro client `<script>`: a module of its own, whose top level is a top level. */
  module?: boolean;
}

export interface Component {
  regions: CodeRegion[];
  blocks: TemplateBlock[];
}

export const COMPONENT_LANGUAGES: ReadonlySet<string> = new Set(['vue', 'svelte', 'astro']);

/** `t.indexOf(s, from)` for a `from` that never decreases: a hit still ahead is reused, so a scan stays linear. */
function searcher(t: string, s: string): (from: number) => number {
  let hit = -2;
  return (from) => (hit === -1 || hit >= from ? hit : (hit = t.indexOf(s, from)));
}

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
/** The `lang` values whose script content is JavaScript or TypeScript. */
const SCRIPT_LANG = /^(?:js|ts|jsx|tsx|javascript|typescript|)$/i;
const JS_TYPE = /^(?:module|text\/(?:javascript|babel|typescript)|application\/(?:javascript|typescript))$/i;

interface Attr {
  name: string;
  nameStart: number;
  /** Value content offsets (inside the quotes), or -1 when the attribute has no value. */
  valueStart: number;
  valueEnd: number;
  quote: string;
  /** For a Svelte or Astro `{…}` value or a bare `{…}` attribute: the expression. */
  expr?: { start: number; end: number };
}

interface StartTag {
  name: string;
  /** Offset after the tag's `>`, or the text's length. */
  end: number;
  closed: boolean;
  selfClosing: boolean;
  attrs: Attr[];
}

type Flavour = 'vue' | 'svelte' | 'astro';

/**
 * A start tag's attributes from `at`, the offset after its name. In Svelte and
 * Astro a `{` starts an expression wherever an attribute or a value can; a quoted Svelte
 * value may hold several.
 */
function startTag(t: string, at: number, name: string, flavour: Flavour, exprs: CodeRegion[]): StartTag {
  const n = t.length;
  const attrs: Attr[] = [];
  let i = at;
  const braced = flavour !== 'vue';
  while (i < n) {
    while (i < n && isSpace(t[i])) i++;
    if (i >= n) break;
    if (t[i] === '>') return { name, end: i + 1, closed: true, selfClosing: false, attrs };
    if (t[i] === '/' && t[i + 1] === '>') return { name, end: i + 2, closed: true, selfClosing: true, attrs };
    if (t[i] === '/') {
      i++;
      continue;
    }
    if (braced && t[i] === '{') {
      const close = braceExpressionEnd(t, i + 1, flavour === 'astro');
      attrs.push({ name: '', nameStart: i, valueStart: -1, valueEnd: -1, quote: '', expr: { start: i + 1, end: close } });
      exprs.push({ start: i + 1, end: close, kind: 'code' });
      i = close + 1;
      continue;
    }
    const ns = i;
    while (i < n && !isSpace(t[i]) && t[i] !== '=' && t[i] !== '>' && !(t[i] === '/' && t[i + 1] === '>')) i++;
    const attr: Attr = { name: t.slice(ns, i), nameStart: ns, valueStart: -1, valueEnd: -1, quote: '' };
    attrs.push(attr);
    let j = i;
    while (j < n && isSpace(t[j])) j++;
    if (t[j] !== '=') continue;
    j++;
    while (j < n && isSpace(t[j])) j++;
    if (braced && t[j] === '{') {
      const close = braceExpressionEnd(t, j + 1, flavour === 'astro');
      attr.expr = { start: j + 1, end: close };
      i = close + 1;
      continue;
    }
    if (flavour === 'astro' && t[j] === '`') {
      // An Astro template-literal value is an expression.
      const close = braceExpressionEnd(t, j, true, '`');
      attr.expr = { start: j, end: close };
      i = close;
      continue;
    }
    if (t[j] === '"' || t[j] === "'") {
      const k = t.indexOf(t[j], j + 1);
      attr.quote = t[j];
      attr.valueStart = j + 1;
      attr.valueEnd = k < 0 ? n : k;
      i = k < 0 ? n : k + 1;
      if (flavour === 'svelte') quotedMustaches(t, attr.valueStart, attr.valueEnd, exprs);
      continue;
    }
    const vs = j;
    while (j < n && !isSpace(t[j]) && t[j] !== '>' && !(t[j] === '/' && t[j + 1] === '>')) j++;
    attr.valueStart = vs;
    attr.valueEnd = j;
    i = j;
  }
  return { name, end: n, closed: false, selfClosing: false, attrs };
}

/** `{expr}` inside a quoted Svelte attribute value: `class="a {b} c"`. */
function quotedMustaches(t: string, start: number, end: number, out: CodeRegion[]): void {
  for (let i = start; i < end; i++) {
    if (t[i] !== '{') continue;
    const close = Math.min(braceExpressionEnd(t, i + 1, false), end);
    out.push({ start: i + 1, end: close, kind: 'code' });
    i = close;
  }
}

/** Offset of the first `</name` (case-insensitive) at or after `from`, else the text's length. */
function rawEnd(t: string, lower: string, name: string, from: number): number {
  const e = lower.indexOf(`</${name}`, from);
  return e < 0 ? t.length : e;
}

const attrOf = (tag: StartTag, name: string): Attr | undefined => tag.attrs.find((a) => a.name.toLowerCase() === name);
const attrValue = (t: string, a: Attr | undefined): string => (a && a.valueStart >= 0 ? t.slice(a.valueStart, a.valueEnd).trim() : '');

/** Whether a `<script>`'s content is JavaScript or TypeScript to the framework. */
function isCodeScript(t: string, tag: StartTag): boolean {
  if (attrOf(tag, 'src')) return false;
  if (!SCRIPT_LANG.test(attrValue(t, attrOf(tag, 'lang')))) return false;
  const type = attrOf(tag, 'type');
  return !type || attrValue(t, type) === '' || JS_TYPE.test(attrValue(t, type));
}

// ── Vue ───────────────────────────────────────────────────────────────────────

const VUE_FOR = /^([\s\S]*?)\s+(?:in|of)\s+([\s\S]*)$/;

/** A Vue directive value: `v-for`'s alias is a pattern, a slot's props are a pattern, the rest is code. */
function vueDirective(t: string, a: Attr, out: CodeRegion[]): boolean {
  const name = a.name;
  const dynamic = /^(?:v-[\w-]+:|[:@#.])\[([^\]]*)\]/.exec(name);
  if (dynamic) {
    const s = a.nameStart + name.indexOf('[') + 1;
    out.push({ start: s, end: s + dynamic[1].length, kind: 'code' });
  }
  if (!/^(?:v-|[:@#.])/.test(name) || a.valueStart < 0 || name === 'v-pre') return false;
  const s = a.valueStart;
  const e = a.valueEnd;
  if (name === 'v-for') {
    const m = VUE_FOR.exec(t.slice(s, e));
    if (m) {
      const lead = m[1].length - m[1].trimStart().length;
      out.push({ start: s + lead, end: s + m[1].length, kind: 'pattern' });
      const src = s + m[0].length - m[2].length;
      out.push({ start: src, end: e, kind: 'code' });
      return true;
    }
  }
  const slot = name === 'v-slot' || name.startsWith('v-slot:') || name.startsWith('#');
  out.push({ start: s, end: e, kind: slot ? 'pattern' : 'code' });
  return name === 'v-for' || slot;
}

/**
 * A template's markup from `from`, its regions and blocks into `out`; returns the
 * offset of the `</template` that closes it before `to`, else -1.
 */
function vueTemplate(t: string, lower: string, from: number, to: number, out: Component): number {
  const stack: { name: string; scopes: boolean; open: number }[] = [];
  const nextTag = searcher(t, '<');
  const nextMustache = searcher(t, '{{');
  let i = from;
  while (i < to) {
    const lt = nextTag(i);
    const mo = nextMustache(i);
    if (mo >= 0 && mo < to && (lt < 0 || mo < lt)) {
      const close = t.indexOf('}}', mo + 2);
      if (close < 0 || close >= to) {
        // Unclosed, as `{{` typed before a word is: text until its `}}` is typed.
        i = mo + 2;
        continue;
      }
      out.regions.push({ start: mo + 2, end: close, kind: 'code' });
      i = close + 2;
      continue;
    }
    if (lt < 0 || lt >= to) break;
    if (t.startsWith('<!--', lt)) {
      const e = t.indexOf('-->', lt + 4);
      i = e < 0 ? to : e + 3;
      continue;
    }
    if (t[lt + 1] === '/') {
      const m = /^<\/([A-Za-z][\w:.-]*)\s*>?/.exec(t.slice(lt, lt + 80));
      if (!m) {
        i = lt + 1;
        continue;
      }
      // Vue matches an end tag to its start tag case-insensitively.
      const name = m[1].toLowerCase();
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== name) k--;
      if (k < 0 && name === 'template') return lt;
      const gt = t.indexOf('>', lt);
      const end = gt < 0 ? to : gt;
      if (k >= 0 && stack[k].scopes) out.blocks.push({ open: stack[k].open, close: end });
      if (k >= 0) stack.length = k;
      i = end + 1;
      continue;
    }
    const m = /^<([A-Za-z][\w:.-]*)/.exec(t.slice(lt, lt + 80));
    if (!m) {
      i = lt + 1;
      continue;
    }
    const regions: CodeRegion[] = [];
    const tag = startTag(t, lt + m[0].length, m[1], 'vue', regions);
    if (!tag.closed) break;
    let scopes = false;
    const pre = tag.attrs.some((a) => a.name === 'v-pre');
    if (!pre) for (const a of tag.attrs) scopes = vueDirective(t, a, regions) || scopes;
    out.regions.push(...regions);
    i = tag.end;
    if (pre) {
      // `v-pre`: the element's content is not compiled.
      i = Math.min(to, rawEnd(t, lower, m[1].toLowerCase(), tag.end));
      continue;
    }
    if (tag.selfClosing || VOID.has(m[1].toLowerCase())) {
      if (scopes) out.blocks.push({ open: lt, close: tag.end - 1 });
      continue;
    }
    stack.push({ name: m[1].toLowerCase(), scopes, open: lt });
  }
  return -1;
}

function vueComponent(t: string): Component {
  const out: Component = { regions: [], blocks: [] };
  const lower = t.toLowerCase();
  const n = t.length;
  let i = 0;
  while (i < n) {
    const lt = t.indexOf('<', i);
    if (lt < 0) break;
    if (t.startsWith('<!--', lt)) {
      const e = t.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    const m = /^<([A-Za-z][\w-]*)/.exec(t.slice(lt, lt + 64));
    if (!m) {
      i = lt + 1;
      continue;
    }
    const name = m[1].toLowerCase();
    const tag = startTag(t, lt + m[0].length, name, 'vue', []);
    if (!tag.closed) break;
    if (tag.selfClosing) {
      i = tag.end;
      continue;
    }
    if (name === 'template') {
      i = vueTemplateBlock(t, lower, tag, out);
      continue;
    }
    const end = rawEnd(t, lower, name, tag.end);
    if (name === 'script' && isCodeScript(t, tag)) out.regions.push({ start: tag.end, end, kind: 'code' });
    i = end + 1;
  }
  return out;
}

/**
 * The SFC's top-level template, its regions and blocks into `out`; returns its
 * `</template` offset. Where it ends: docs/components.md#code-regions.
 */
function vueTemplateBlock(t: string, lower: string, tag: StartTag, out: Component): number {
  const lang = attrValue(t, attrOf(tag, 'lang'));
  if (lang && !/^html$/i.test(lang)) return rawEnd(t, lower, 'template', tag.end);
  const found: Component = { regions: [], blocks: [] };
  let end = vueTemplate(t, lower, tag.end, t.length, found);
  if (end < 0) {
    end = lower.lastIndexOf('</template');
    if (end < tag.end) end = t.length;
    found.regions.length = 0;
    found.blocks.length = 0;
    vueTemplate(t, lower, tag.end, end, found);
  }
  out.regions.push(...found.regions);
  out.blocks.push(...found.blocks);
  return end;
}

// ── Svelte ────────────────────────────────────────────────────────────────────

/** The index of ` word ` at bracket depth 0 in [s, e), else -1. */
function topLevelWord(t: string, s: number, e: number, word: string): number {
  let depth = 0;
  for (let i = s; i < e; i++) {
    const c = t[i];
    if (c === '"' || c === "'" || c === '`') {
      const k = t.indexOf(c, i + 1);
      i = k < 0 || k > e ? e : k;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && isSpace(t[i - 1]) && t.startsWith(word, i) && (isSpace(t[i + word.length]) || i + word.length === e)) return i;
  }
  return -1;
}

const trimmed = (t: string, s: number, e: number): [number, number] => {
  while (s < e && isSpace(t[s])) s++;
  while (e > s && isSpace(t[e - 1])) e--;
  return [s, e];
};

function push(out: CodeRegion[], t: string, s: number, e: number, kind: RegionKind): void {
  const [a, b] = trimmed(t, s, e);
  if (b > a) out.push({ start: a, end: b, kind });
}

/** The `(` that the `)` at `close` closes, scanning back no further than `from`, else -1. */
function openParen(t: string, from: number, close: number): number {
  let depth = 0;
  for (let i = close; i >= from; i--) {
    if (t[i] === ')') depth++;
    else if (t[i] === '(' && --depth === 0) return i;
  }
  return -1;
}

/** A Svelte block tag's head, `{#each items as item, i (item.id)}` from the `#`; `close` is its `}`. */
function svelteTag(t: string, at: number, close: number, out: Component, stack: { kind: string; open: number }[]): void {
  const m = /^([#:/@])([a-z]+)/.exec(t.slice(at, at + 12));
  if (!m) return;
  const [, sigil, word] = m;
  let s = at + m[0].length;
  if (sigil === '/') {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].kind !== word) continue;
      for (const b of stack.splice(k)) if (b.kind === word && (word === 'each' || word === 'await' || word === 'snippet')) out.blocks.push({ open: b.open, close });
      break;
    }
    return;
  }
  if (sigil === '#') stack.push({ kind: word, open: at - 1 });
  if (sigil === '@' && word === 'const') {
    push(out.regions, t, at + 1, close, 'code');
    return;
  }
  const elseIf = sigil === ':' && word === 'else' && /^\s+if\b/.test(t.slice(s, s + 8));
  if (elseIf) s = t.indexOf('if', s) + 2;
  if (word === 'each') {
    const as = topLevelWord(t, s, close, 'as');
    if (as < 0) {
      push(out.regions, t, s, close, 'code');
      return;
    }
    push(out.regions, t, s, as, 'code');
    const rest = as + 2;
    const tail = trimmed(t, rest, close)[1];
    let end = close;
    const paren = t[tail - 1] === ')' ? openParen(t, rest, tail - 1) : -1;
    if (paren > rest) {
      push(out.regions, t, paren + 1, tail - 1, 'code');
      end = paren;
    }
    push(out.regions, t, rest, end, 'pattern');
    return;
  }
  if (word === 'await') {
    const then = topLevelWord(t, s, close, 'then');
    const ctch = topLevelWord(t, s, close, 'catch');
    const k = then >= 0 ? then : ctch;
    if (k < 0) {
      push(out.regions, t, s, close, 'code');
      return;
    }
    push(out.regions, t, s, k, 'code');
    push(out.regions, t, k + (then >= 0 ? 4 : 5), close, 'pattern');
    return;
  }
  if (word === 'then' || word === 'catch') {
    push(out.regions, t, s, close, 'pattern');
    return;
  }
  if (word === 'snippet') {
    const paren = t.indexOf('(', s);
    if (paren < 0 || paren > close) {
      push(out.regions, t, s, close, 'code');
      return;
    }
    // One pattern, name and parameters: the name ends where the parameters' region would need its mark.
    push(out.regions, t, s, close, 'pattern');
    return;
  }
  // if, else if, key, html, render, debug, attach; a bare `{:else}` holds nothing.
  push(out.regions, t, s, close, 'code');
}

function svelteComponent(t: string): Component {
  const out: Component = { regions: [], blocks: [] };
  const lower = t.toLowerCase();
  const n = t.length;
  const stack: { kind: string; open: number }[] = [];
  const nextTag = searcher(t, '<');
  const nextBrace = searcher(t, '{');
  let i = 0;
  while (i < n) {
    const lt = nextTag(i);
    const br = nextBrace(i);
    if (br >= 0 && (lt < 0 || br < lt)) {
      const sigil = t[br + 1];
      const tagged = sigil === '#' || sigil === ':' || sigil === '/' || sigil === '@';
      const close = braceExpressionEnd(t, br + (tagged ? 2 : 1), false);
      if (close >= n) {
        // Unclosed: `{` typed before a word, which svelte's autoCloseBefore leaves alone.
        i = br + 1;
        continue;
      }
      if (tagged) svelteTag(t, br + 1, close, out, stack);
      else push(out.regions, t, br + 1, close, 'code');
      i = close + 1;
      continue;
    }
    if (lt < 0) break;
    if (t.startsWith('<!--', lt)) {
      const e = t.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (t[lt + 1] === '/') {
      const gt = t.indexOf('>', lt);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    const m = /^<([A-Za-z][\w:.-]*)/.exec(t.slice(lt, lt + 80));
    if (!m) {
      i = lt + 1;
      continue;
    }
    const regions: CodeRegion[] = [];
    const tag = startTag(t, lt + m[0].length, m[1], 'svelte', regions);
    if (!tag.closed) break;
    for (const a of tag.attrs) {
      if (a.expr && a.name !== '') {
        // `let:item={pattern}` binds; every other directive or attribute value reads.
        regions.push({ start: a.expr.start, end: a.expr.end, kind: a.name.startsWith('let:') ? 'pattern' : 'code' });
      } else if (!a.expr && a.valueStart < 0 && /^(?:bind|class|style|let):[A-Za-z_$][\w$]*$/.test(a.name)) {
        // A directive with no value names the binding: `bind:value` reads and writes `value`.
        const at = a.nameStart + a.name.indexOf(':') + 1;
        regions.push({ start: at, end: a.nameStart + a.name.length, kind: a.name.startsWith('let:') ? 'pattern' : 'code' });
      }
    }
    regions.sort((a, b) => a.start - b.start);
    for (const r of regions) push(out.regions, t, r.start, r.end, r.kind);
    const name = m[1].toLowerCase();
    if ((name === 'script' || name === 'style') && !tag.selfClosing) {
      const end = rawEnd(t, lower, name, tag.end);
      if (name === 'script' && isCodeScript(t, tag)) out.regions.push({ start: tag.end, end, kind: 'code', js: !/^(?:ts|typescript|tsx)$/i.test(attrValue(t, attrOf(tag, 'lang'))) });
      i = end + 1;
      continue;
    }
    i = tag.end;
  }
  return out;
}

// ── Astro ─────────────────────────────────────────────────────────────────────

/** `---` … `---` at the file's start, its content as one region from the first fence's last `-`. */
function astroFrontmatter(t: string): CodeRegion | undefined {
  const m = /^\s*---/.exec(t);
  if (!m) return undefined;
  const start = m[0].length;
  const close = /\n[ \t]*---/g;
  close.lastIndex = start;
  const c = close.exec(t);
  const end = c ? c.index + c[0].length - 3 : t.length;
  return { start, end, kind: 'code' };
}

function astroComponent(t: string): Component {
  const out: Component = { regions: [], blocks: [] };
  const lower = t.toLowerCase();
  const n = t.length;
  const fm = astroFrontmatter(t);
  const nextTag = searcher(t, '<');
  const nextBrace = searcher(t, '{');
  let i = 0;
  if (fm) {
    out.regions.push(fm);
    i = fm.end + 3;
  }
  while (i < n) {
    const lt = nextTag(i);
    const br = nextBrace(i);
    if (br >= 0 && (lt < 0 || br < lt)) {
      const close = braceExpressionEnd(t, br + 1, true);
      if (close >= n) {
        i = br + 1;
        continue;
      }
      push(out.regions, t, br + 1, close, 'code');
      i = close + 1;
      continue;
    }
    if (lt < 0) break;
    if (t.startsWith('<!--', lt)) {
      const e = t.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (t[lt + 1] === '/') {
      const gt = t.indexOf('>', lt);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    const m = /^<([A-Za-z][\w:.-]*)/.exec(t.slice(lt, lt + 80));
    if (!m) {
      i = lt + 1;
      continue;
    }
    const regions: CodeRegion[] = [];
    const tag = startTag(t, lt + m[0].length, m[1], 'astro', regions);
    if (!tag.closed) break;
    for (const a of tag.attrs) if (a.expr && a.name !== '') regions.push({ start: a.expr.start, end: a.expr.end, kind: 'code' });
    regions.sort((a, b) => a.start - b.start);
    for (const r of regions) push(out.regions, t, r.start, r.end, r.kind);
    const name = m[1].toLowerCase();
    const raw = tag.attrs.some((a) => a.name === 'is:raw');
    if ((name === 'script' || name === 'style' || raw) && !tag.selfClosing) {
      const end = rawEnd(t, lower, name, tag.end);
      if (name === 'script' && isCodeScript(t, tag)) {
        out.regions.push({ start: tag.end, end, kind: 'code' });
        // A script runs in the browser, a module apart from the frontmatter: its own scope.
        const gt = t.indexOf('>', end);
        if (gt > end) out.blocks.push({ open: lt, close: gt, module: true });
      }
      i = end + 1;
      continue;
    }
    i = tag.end;
  }
  return out;
}

const cache: { text: string | undefined; lang: string | undefined; component: Component } = { text: undefined, lang: undefined, component: { regions: [], blocks: [] } };

/**
 * A component's code regions in document order, none overlapping and none touching
 * another (a region's marks need the character on each side), and its scoping blocks.
 */
export function componentRegions(text: string, languageId: string): Component {
  if (cache.text === text && cache.lang === languageId) return cache.component;
  const raw = languageId === 'vue' ? vueComponent(text) : languageId === 'svelte' ? svelteComponent(text) : astroComponent(text);
  raw.regions.sort((a, b) => a.start - b.start);
  const regions: CodeRegion[] = [];
  const lineBreak = (c: string | undefined): boolean => c === '\n' || c === '\r';
  for (const raw0 of raw.regions) {
    const r = { ...raw0 };
    if (r.end <= r.start) continue;
    // A mark never replaces a line break: the region takes it in.
    while (r.start > 1 && lineBreak(text[r.start - 1])) r.start--;
    while (r.end < text.length && lineBreak(text[r.end])) r.end++;
    if (r.start < 1) continue;
    const last = regions[regions.length - 1];
    if (last && r.start - 1 <= last.end) {
      if (r.end > last.end) last.end = r.end;
      continue;
    }
    if (r.js === undefined) delete r.js;
    regions.push(r);
  }
  raw.blocks.sort((a, b) => a.open - b.open);
  cache.text = text;
  cache.lang = languageId;
  cache.component = { regions, blocks: raw.blocks };
  return cache.component;
}
