/**
 * CommonMark 0.31.2 block and inline structure, to the depth the markdown band-1 marks
 * need: which lines each paragraph, heading and table cell holds, which of them are lazy
 * continuations of a block quote, which link reference definitions exist, and which
 * brackets become links. A port of cmark's block algorithm and its inline bracket and
 * delimiter passes; where VS Code's preview (markdown-it) differs, it follows the preview:
 * front matter, tables and `~~`. Pure, no vscode. docs/markdown.md.
 */

export interface Span {
  start: number;
  end: number;
}

/** One line of a block's inline content, as document offsets; `lazy` is a block quote's lazy continuation. */
export interface Seg {
  start: number;
  end: number;
  lazy: boolean;
}

export type RegionKind = 'paragraph' | 'atx' | 'setext' | 'th' | 'td';

/** A run of inline content: a paragraph, a heading or a table cell. */
export interface Region {
  kind: RegionKind;
  level: number;
  segs: Seg[];
  quote: boolean;
  /** The `[ ]` / `[x]` box opening a list item's first paragraph. */
  task: Span | null;
  done: boolean;
  /** A `[^x]:` footnote definition paragraph (the theme's register, not CommonMark). */
  footnote: boolean;
  /** A setext heading's underline, its `=` or `-` run. */
  underline: Span | null;
}

export interface Blocks {
  regions: Region[];
  /** Normalised labels of every link reference definition. */
  defs: Set<string>;
  /** The label text of each definition, inside its brackets. */
  defLabels: Span[];
  quotes: number;
  /** Heading levels in document order, empty headings included. */
  headings: number[];
  frontMatter: Span | null;
}

type NodeType = 'document' | 'quote' | 'item' | 'paragraph' | 'atx' | 'setext' | 'hr' | 'fence' | 'code' | 'html' | 'table';

interface Node {
  t: NodeType;
  parent: Node | null;
  children: Node[];
  open: boolean;
  quote: boolean;
  segs: Seg[];
  markerOffset: number;
  padding: number;
  fenceChar: string;
  fenceLen: number;
  fenceOffset: number;
  htmlType: number;
  cols: number;
}

const MAX_LABEL = 999;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const isPunctAscii = (c: string | undefined): boolean => c !== undefined && c.length === 1 && ASCII_PUNCT.test(c);
const isSpaceOrTab = (c: string | undefined): boolean => c === ' ' || c === '\t';

/** CommonMark label matching, as markdown-it does it: trimmed, whitespace collapsed, case folded. */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();
}

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_START: [RegExp, RegExp | null][] = [
  [/^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<![A-Za-z]/, />/],
  [/^<!\[CDATA\[/, /\]\]>/],
  [new RegExp(`^</?(?:${BLOCK_TAGS})(?:[ \\t]|/?>|$)`, 'i'), null],
];
const ATTR = String.raw`(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>\x60]+|'[^']*'|"[^"]*"))?)`;
const HTML_7 = new RegExp(String.raw`^(?:<[A-Za-z][A-Za-z0-9-]*${ATTR}*[ \t]*/?>|</[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$`);
const ATX = /^(#{1,6})(?=[ \t]|$)/;
const FENCE = /^(`{3,}|~{3,})/;
const SETEXT = /^(?:=+|-+)[ \t]*$/;
const HR = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BULLET = /^([*+-])(?=[ \t]|$)/;
const ORDERED = /^(\d{1,9})([.)])(?=[ \t]|$)/;

/** The block structure of a markdown document. */
export function parseBlocks(text: string): Blocks {
  const regions: Region[] = [];
  const defs = new Set<string>();
  const defLabels: Span[] = [];
  let quotes = 0;
  const headings: number[] = [];

  const mk = (t: NodeType, parent: Node | null): Node => ({
    t, parent, children: [], open: true, quote: !!parent && (parent.quote || parent.t === 'quote'), segs: [],
    markerOffset: 0, padding: 0, fenceChar: '', fenceLen: 0, fenceOffset: 0, htmlType: 0, cols: 0,
  });
  const doc = mk('document', null);
  let tip = doc;

  // Per-line scanning state, cmark's: offset into the line, its column (tabs to 4), and
  // whether a tab is half consumed by a container prefix.
  let line = '';
  let lineStart = 0;
  let offset = 0;
  let column = 0;
  let partialTab = false;
  let firstNonspace = 0;
  let firstNonspaceColumn = 0;
  let indent = 0;
  let blank = false;

  const findNextNonspace = (): void => {
    let i = offset;
    let cols = column;
    for (;;) {
      const c = line[i];
      if (c === ' ') { i++; cols++; } else if (c === '\t') { i++; cols += 4 - (cols % 4); } else break;
    }
    firstNonspace = i;
    firstNonspaceColumn = cols;
    indent = firstNonspaceColumn - column;
    blank = i >= line.length;
  };
  const advanceOffset = (count: number, columns: boolean): void => {
    while (count > 0 && offset < line.length) {
      if (line[offset] === '\t') {
        const toTab = 4 - (column % 4);
        if (columns) {
          partialTab = toTab > count;
          const n = Math.min(count, toTab);
          column += n;
          if (!partialTab) offset++;
          count -= n;
        } else {
          partialTab = false;
          column += toTab;
          offset++;
          count--;
        }
      } else {
        partialTab = false;
        offset++;
        column++;
        count--;
      }
    }
  };

  const trimEnd = (s: number, e: number): number => {
    while (e > s && isSpaceOrTab(text[e - 1])) e--;
    return e;
  };
  const contentSeg = (lazy: boolean): Seg => ({ start: lineStart + firstNonspace, end: trimEnd(lineStart + firstNonspace, lineStart + line.length), lazy });

  const region = (kind: RegionKind, segs: Seg[], quote: boolean, level = 0): Region => {
    const r: Region = { kind, level, segs, quote, task: null, done: false, footnote: false, underline: null };
    regions.push(r);
    return r;
  };

  // A paragraph closes: definitions at its start come off, the rest is inline content.
  const closeParagraph = (n: Node): void => {
    const rest = extractDefs(text, n.segs, defs, defLabels);
    n.segs = rest;
    if (!rest.length) return;
    const r = region('paragraph', rest, n.quote);
    const first = text.slice(rest[0].start, rest[0].end);
    const parent = n.parent!;
    if (parent.t === 'item' && parent.children[0] === n) {
      const box = /^\[([ xX])\](?=[ \t]|$)/.exec(first);
      if (box) {
        r.task = { start: rest[0].start, end: rest[0].start + 3 };
        r.done = box[1] !== ' ';
      }
    }
    if (/^\[\^[^\]\s]+\]:/.test(first)) r.footnote = true;
  };
  const close = (n: Node): Node => {
    if (n.open) {
      n.open = false;
      if (n.t === 'paragraph') closeParagraph(n);
    }
    return n.parent!;
  };
  const canContain = (t: NodeType): boolean => t === 'document' || t === 'quote' || t === 'item';
  const addChild = (parent: Node, t: NodeType): Node => {
    while (!canContain(parent.t)) parent = close(parent);
    const child = mk(t, parent);
    parent.children.push(child);
    if (t === 'quote') quotes++;
    return child;
  };

  const htmlStart = (rest: string, inParagraph: boolean): number => {
    if (rest[0] !== '<') return 0;
    for (let k = 0; k < HTML_START.length; k++) if (HTML_START[k][0].test(rest)) return k + 1;
    return !inParagraph && HTML_7.test(rest) ? 7 : 0;
  };

  // markdown-it's delimiter row: | - : and spaces, no `- ` start, cells of :?-+:?.
  const delimiterCells = (s: string): number => {
    const a = s[0];
    const b = s[1];
    if (!(a === '|' || a === '-' || a === ':') || b === undefined) return 0;
    if (!(b === '|' || b === '-' || b === ':' || isSpaceOrTab(b)) || (a === '-' && isSpaceOrTab(b))) return 0;
    if (!/^[-|: \t]*$/.test(s)) return 0;
    const cells = s.split('|');
    let n = 0;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k].trim();
      if (!c) {
        if (k === 0 || k === cells.length - 1) continue;
        return 0;
      }
      if (!/^:?-+:?$/.test(c)) return 0;
      n++;
    }
    return n;
  };

  // A table row's cells, split on unescaped pipes with an empty first and last cell dropped.
  const rowCells = (s: number, e: number): Span[] => {
    const cells: Span[] = [];
    let from = s;
    for (let i = s; i <= e; i++) {
      if (i === e || (text[i] === '|' && text[i - 1] !== '\\')) {
        let a = from;
        let b = i;
        while (a < b && isSpaceOrTab(text[a])) a++;
        while (b > a && isSpaceOrTab(text[b - 1])) b--;
        cells.push({ start: a, end: b });
        from = i + 1;
      }
    }
    if (cells.length && cells[0].start === cells[0].end && text[s] === '|') cells.shift();
    if (cells.length && cells[cells.length - 1].start === cells[cells.length - 1].end && text[e - 1] === '|') cells.pop();
    return cells;
  };
  const addRow = (seg: Seg, kind: 'th' | 'td', cols: number, quote: boolean): void => {
    const cells = rowCells(seg.start, seg.end).slice(0, cols);
    for (const c of cells) if (c.end > c.start) region(kind, [{ start: c.start, end: c.end, lazy: false }], quote);
  };

  // A line that ends a table body: markdown-it's blockquote terminators.
  const interruptsTable = (): boolean => {
    if (indent >= 4) return true;
    const rest = line.slice(firstNonspace);
    return rest[0] === '>' || ATX.test(rest) || FENCE.test(rest) || htmlStart(rest, true) > 0 || HR.test(rest)
      || BULLET.test(rest) || ORDERED.test(rest);
  };

  const listMarker = (interrupts: boolean): { width: number } | null => {
    const rest = line.slice(firstNonspace);
    const m = BULLET.exec(rest) || ORDERED.exec(rest);
    if (!m) return null;
    if (interrupts) {
      if (m[2] !== undefined && Number(m[1]) !== 1) return null;
      if (/^[ \t]*$/.test(rest.slice(m[0].length))) return null;
    }
    return { width: m[0].length };
  };

  const processLine = (): void => {
    offset = 0;
    column = 0;
    partialTab = false;
    let container = doc;
    let allMatched = true;

    for (;;) {
      const last = container.children[container.children.length - 1];
      if (!last || !last.open) break;
      container = last;
      findNextNonspace();
      let ok = false;
      switch (container.t) {
        case 'quote':
          ok = indent <= 3 && line[firstNonspace] === '>';
          if (ok) {
            advanceOffset(indent + 1, true);
            if (isSpaceOrTab(line[offset])) advanceOffset(1, true);
          }
          break;
        case 'item':
          if (indent >= container.markerOffset + container.padding) {
            advanceOffset(container.markerOffset + container.padding, true);
            ok = true;
          } else if (blank && container.children.length > 0) {
            advanceOffset(firstNonspace - offset, false);
            ok = true;
          }
          break;
        case 'fence': {
          const rest = line.slice(firstNonspace);
          const m = indent <= 3 ? /^(`+|~+)[ \t]*$/.exec(rest) : null;
          if (m && m[1][0] === container.fenceChar && m[1].length >= container.fenceLen) {
            tip = close(container);
            return;
          }
          for (let k = container.fenceOffset; k > 0 && isSpaceOrTab(line[offset]); k--) advanceOffset(1, true);
          ok = true;
          break;
        }
        case 'code':
          if (indent >= 4) {
            advanceOffset(4, true);
            ok = true;
          } else if (blank) {
            advanceOffset(firstNonspace - offset, false);
            ok = true;
          }
          break;
        case 'html':
          ok = !(blank && container.htmlType >= 6);
          break;
        case 'paragraph':
          ok = !blank;
          break;
        case 'table':
          ok = !blank && !interruptsTable();
          break;
        default:
          ok = false;
      }
      if (!ok) {
        container = container.parent!;
        allMatched = false;
        break;
      }
    }

    const lastMatched = container;
    const maybeLazy = tip.t === 'paragraph';
    let consumed = false;

    while (container.t !== 'fence' && container.t !== 'code' && container.t !== 'html' && container.t !== 'table') {
      findNextNonspace();
      const indented = indent >= 4;
      const rest = line.slice(firstNonspace);
      const c = rest[0];
      let m: RegExpExecArray | null;

      // A delimiter row under a paragraph's last line with as many cells: a table (markdown-it).
      if (!indented && container.t === 'paragraph' && container.segs.length && !container.segs[container.segs.length - 1].lazy) {
        const cols = delimiterCells(rest.replace(/[ \t]+$/, ''));
        const head = container.segs[container.segs.length - 1];
        if (cols && text.slice(head.start, head.end).includes('|') && rowCells(head.start, head.end).length === cols) {
          container.segs.pop();
          const table = addChild(container, 'table');
          table.cols = cols;
          addRow(head, 'th', cols, table.quote);
          container = table;
          consumed = true;
          break;
        }
      }

      if (!indented && c === '>') {
        advanceOffset(firstNonspace + 1 - offset, false);
        if (isSpaceOrTab(line[offset])) advanceOffset(1, true);
        container = addChild(container, 'quote');
      } else if (!indented && (m = ATX.exec(rest))) {
        const level = m[1].length;
        headings.push(level);
        container = addChild(container, 'atx');
        container.open = false;
        let s = lineStart + firstNonspace + level;
        let e = lineStart + line.length;
        while (s < e && isSpaceOrTab(text[s])) s++;
        e = trimEnd(s, e);
        let h = e;
        while (h > s && text[h - 1] === '#') h--;
        if (h < e && (h === s || isSpaceOrTab(text[h - 1]))) e = trimEnd(s, h);
        if (e > s) region('atx', [{ start: s, end: e, lazy: false }], container.quote, level);
        consumed = true;
        break;
      } else if (!indented && (m = FENCE.exec(rest)) && !(m[1][0] === '`' && rest.slice(m[1].length).includes('`'))) {
        container = addChild(container, 'fence');
        container.fenceChar = m[1][0];
        container.fenceLen = m[1].length;
        container.fenceOffset = firstNonspaceColumn - column;
        consumed = true;
        break;
      } else if (!indented && htmlStart(rest, container.t === 'paragraph') > 0) {
        const type = htmlStart(rest, container.t === 'paragraph');
        container = addChild(container, 'html');
        container.htmlType = type;
        break;
      } else if (!indented && container.t === 'paragraph' && SETEXT.test(rest)
        && (container.segs = extractDefs(text, container.segs, defs, defLabels)).length > 0) {
        const para = container;
        para.t = 'setext';
        para.open = false;
        headings.push(c === '=' ? 1 : 2);
        const s = lineStart + firstNonspace;
        region('setext', para.segs, para.quote, c === '=' ? 1 : 2).underline = { start: s, end: trimEnd(s, lineStart + line.length) };
        container = para;
        consumed = true;
        break;
      } else if (!indented && !(container.t === 'paragraph' && !allMatched) && HR.test(rest)) {
        container = addChild(container, 'hr');
        container.open = false;
        consumed = true;
        break;
      } else if (!indented && listMarker(container.t === 'paragraph')) {
        const marker = listMarker(container.t === 'paragraph')!;
        const markerOffset = indent;
        advanceOffset(firstNonspace + marker.width - offset, false);
        const saveOffset = offset;
        const saveColumn = column;
        const saveTab: boolean = partialTab;
        while (column - saveColumn <= 5 && isSpaceOrTab(line[offset])) advanceOffset(1, true);
        const spaces = column - saveColumn;
        let padding: number;
        if (spaces >= 5 || spaces < 1 || offset >= line.length) {
          padding = marker.width + 1;
          offset = saveOffset;
          column = saveColumn;
          partialTab = saveTab;
          if (spaces > 0) advanceOffset(1, true);
        } else {
          padding = marker.width + spaces;
        }
        container = addChild(container, 'item');
        container.markerOffset = markerOffset;
        container.padding = padding;
      } else if (indented && !maybeLazy && !blank) {
        advanceOffset(4, true);
        container = addChild(container, 'code');
        consumed = true;
        break;
      } else {
        break;
      }
    }

    findNextNonspace();
    if (!consumed && tip !== lastMatched && container === lastMatched && !blank && tip.t === 'paragraph' && tip.open) {
      tip.segs.push(contentSeg(true));
      return;
    }
    while (tip !== lastMatched && tip.parent) tip = close(tip);
    if (!consumed) {
      if (container.t === 'html') {
        const end = HTML_START[container.htmlType - 1]?.[1];
        if (end && end.test(line.slice(offset))) container = close(container);
      } else if (container.t === 'table') {
        if (!blank) addRow(contentSeg(false), 'td', container.cols, container.quote);
      } else if (container.t === 'fence' || container.t === 'code' || blank) {
        // raw lines and blank lines carry nothing the marks need
      } else if (container.t === 'paragraph') {
        container.segs.push(contentSeg(false));
      } else {
        container = addChild(container, 'paragraph');
        container.segs.push(contentSeg(false));
      }
    }
    tip = container.open ? container : container.parent!;
    while (!tip.open && tip.parent) tip = tip.parent;
  };

  let pos = 0;
  let frontMatter: Span | null = null;
  // VS Code's front matter: `---` alone on the first line, closed by the next `---` alone.
  const first = text.indexOf('\n');
  if (first >= 0 && /^---[ \t]*\r?$/.test(text.slice(0, first))) {
    const m = /^---[ \t]*\r?$/m.exec(text.slice(first + 1));
    if (m) {
      const end = first + 1 + m.index + m[0].length;
      frontMatter = { start: 0, end };
      pos = end + 1;
    }
  }
  while (pos <= text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = text.length;
    lineStart = pos;
    line = text.slice(pos, nl);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!(nl === text.length && line === '' && pos > 0)) processLine();
    pos = nl + 1;
  }
  while (tip.parent) tip = close(tip);
  close(doc);
  regions.sort((a, b) => a.segs[0].start - b.segs[0].start);
  return { regions, defs, defLabels, quotes, headings, frontMatter };
}

/** The inline content of segments as one string, lines joined by `\n`, with the offset of each segment in it. */
export function joinSegs(text: string, segs: Seg[]): { v: string; at: number[] } {
  const at: number[] = [];
  let v = '';
  for (let k = 0; k < segs.length; k++) {
    if (k) v += '\n';
    at.push(v.length);
    v += text.slice(segs[k].start, segs[k].end);
  }
  return { v, at };
}

/** The document offset of index `i` of a `joinSegs` string. */
export function docOffset(segs: Seg[], at: number[], i: number): number {
  let lo = 0;
  let hi = at.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (at[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return segs[lo].start + (i - at[lo]);
}

/**
 * Link reference definitions at the start of a paragraph, cmark's parse_reference_inline:
 * each is recorded and its lines dropped; the segments left are the paragraph's text.
 */
function extractDefs(text: string, segs: Seg[], defs: Set<string>, defLabels: Span[]): Seg[] {
  if (!segs.length || text[segs[0].start] !== '[') return segs;
  const { v, at } = joinSegs(text, segs);
  let p = 0;
  for (;;) {
    const d = scanRefDef(v, p);
    if (!d) break;
    const key = normalizeLabel(v.slice(d.labelStart, d.labelEnd));
    defs.add(key);
    if (d.labelEnd > d.labelStart) defLabels.push({ start: docOffset(segs, at, d.labelStart), end: docOffset(segs, at, d.labelEnd - 1) + 1 });
    p = d.end;
    if (p >= v.length || v[p] !== '[') break;
  }
  if (p === 0) return segs;
  if (p >= v.length) return [];
  let k = at.length - 1;
  while (at[k] > p) k--;
  return segs.slice(k);
}

/** One link reference definition at `p`, or null; `end` is just past its line ending. */
function scanRefDef(v: string, p: number): { labelStart: number; labelEnd: number; end: number } | null {
  const label = scanLabel(v, p);
  if (!label || !label.content) return null;
  let i = label.end;
  if (v[i] !== ':') return null;
  i = spnl(v, i + 1);
  const dest = scanDestination(v, i);
  if (dest < 0) return null;
  const destEnd = i + dest;
  const beforeTitle = destEnd;
  let j = spnl(v, beforeTitle);
  const titleLen = j === beforeTitle ? 0 : scanTitle(v, j);
  if (titleLen > 0) {
    j = lineEnd(v, j + titleLen);
    if (j >= 0) return { labelStart: p + 1, labelEnd: label.end - 1, end: j };
  }
  j = lineEnd(v, beforeTitle);
  return j >= 0 ? { labelStart: p + 1, labelEnd: label.end - 1, end: j } : null;
}

/** Past the spaces and tabs at `i` and the line ending after them; -1 when something else follows. */
function lineEnd(v: string, i: number): number {
  while (isSpaceOrTab(v[i])) i++;
  if (i >= v.length) return v.length;
  return v[i] === '\n' ? i + 1 : -1;
}

/** Spaces and tabs, at most one line ending, spaces and tabs. */
function spnl(v: string, i: number): number {
  while (isSpaceOrTab(v[i])) i++;
  if (v[i] === '\n') {
    i++;
    while (isSpaceOrTab(v[i])) i++;
  }
  return i;
}

/** A link label `[...]` at `p`: no unescaped bracket inside, at most 999 characters. */
export function scanLabel(v: string, p: number): { end: number; content: boolean } | null {
  if (v[p] !== '[') return null;
  let i = p + 1;
  let len = 0;
  let content = false;
  while (i < v.length) {
    const c = v[i];
    if (c === '[') return null;
    if (c === ']') return { end: i + 1, content };
    if (c === '\\') {
      i++;
      len++;
      content = true;
      if (isPunctAscii(v[i])) {
        i++;
        len++;
      }
    } else {
      if (!/\s/.test(c)) content = true;
      i++;
      len++;
    }
    if (len > MAX_LABEL) return null;
  }
  return null;
}

/** The length of a link destination at `i`, or -1; an empty one is `<>` or a bare one right before `)`. */
function scanDestination(v: string, i: number): number {
  if (v[i] === '<') {
    let k = i + 1;
    while (k < v.length) {
      const c = v[k];
      if (c === '>') return k + 1 - i;
      if (c === '\\') k += 2;
      else if (c === '\n' || c === '<') return -1;
      else k++;
    }
    return -1;
  }
  let k = i;
  let depth = 0;
  while (k < v.length) {
    const c = v[k];
    const code = c.charCodeAt(0);
    if (c === '\\' && isPunctAscii(v[k + 1])) k += 2;
    else if (c === '(') {
      if (++depth > 32) return -1;
      k++;
    } else if (c === ')') {
      if (depth === 0) break;
      depth--;
      k++;
    } else if (code <= 0x20 || code === 0x7f) {
      if (k === i) return -1;
      break;
    } else k++;
  }
  if (depth !== 0 || (k === i && k >= v.length)) return -1;
  return k - i;
}

/** The length of a link title at `i` ("…", '…' or (…)), or 0. */
function scanTitle(v: string, i: number): number {
  const open = v[i];
  const closeCh = open === '"' ? '"' : open === "'" ? "'" : open === '(' ? ')' : '';
  if (!closeCh) return 0;
  let k = i + 1;
  while (k < v.length) {
    const c = v[k];
    if (c === '\\' && isPunctAscii(v[k + 1])) k += 2;
    else if (c === closeCh) return k + 1 - i;
    else if (open === '(' && c === '(') return 0;
    else k++;
  }
  return 0;
}

const skipWs = (v: string, i: number): number => {
  while (i < v.length && /[ \t\n\r\f\v]/.test(v[i])) i++;
  return i;
};

// ── inline ───────────────────────────────────────────────────────────────────

export type EmphKind = 'em' | 'strong' | 'del';

export interface InlineLink {
  /** Offset of `[` (or `!` for an image). */
  open: number;
  textStart: number;
  textEnd: number;
  /** Just past the whole link: `)`, the label's `]`, or the text's `]`. */
  end: number;
  kind: 'inline' | 'full' | 'collapsed' | 'shortcut';
  image: boolean;
  /** A full reference's label, inside its brackets. */
  label: Span | null;
}

export interface Inline {
  links: InlineLink[];
  /** Code spans, autolinks and raw HTML, backticks and brackets included. */
  opaque: Span[];
  codes: Span[];
  autolinks: Span[];
  /** Backslashes of escapes and of hard breaks. */
  escapes: number[];
  emph: { start: number; end: number; kind: EmphKind }[];
  /** Emphasis and strikethrough delimiter characters that closed a pair. */
  delims: number[];
}

interface Delim {
  ch: string;
  start: number;
  len: number;
  orig: number;
  canOpen: boolean;
  canClose: boolean;
  prev: number;
  next: number;
  removed: boolean;
}

interface Bracket {
  pos: number;
  image: boolean;
  active: boolean;
  delimBottom: number;
  bracketAfter: boolean;
}

const UNICODE_WS = /[\t\n\f\r \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
const AUTOLINK_URI = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*>/y;
const AUTOLINK_EMAIL = /<[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*>/y;
const TAG_WS = String.raw`(?:[ \t]+\n?[ \t]*|\n[ \t]*)`;
const IATTR = String.raw`(?:${TAG_WS}[A-Za-z_:][A-Za-z0-9_.:-]*(?:${TAG_WS}?=${TAG_WS}?(?:[^ \t\n"'=<>\x60]+|'[^']*'|"[^"]*"))?)`;
const OPEN_TAG = new RegExp(String.raw`<[A-Za-z][A-Za-z0-9-]*${IATTR}*${TAG_WS}?/?>`, 'y');
const CLOSE_TAG = new RegExp(String.raw`</[A-Za-z][A-Za-z0-9-]*${TAG_WS}?>`, 'y');
const DECLARATION = /<![A-Za-z][^>]*>/y;

/**
 * The inline structure of one block's content: code spans, autolinks and HTML first, then
 * brackets resolved against `defs` with cmark's bracket stack, then emphasis by the
 * delimiter algorithm (rule of three included). `~~` pairs as markdown-it's strikethrough.
 */
export function parseInline(v: string, defs: Set<string>): Inline {
  const out: Inline = { links: [], opaque: [], codes: [], autolinks: [], escapes: [], emph: [], delims: [] };
  const n = v.length;

  // Maximal backtick runs by length, for code span closers.
  const runs = new Map<number, number[]>();
  for (let i = 0; i < n;) {
    if (v[i] !== '`') { i++; continue; }
    let j = i;
    while (v[j] === '`') j++;
    const list = runs.get(j - i);
    if (list) list.push(i);
    else runs.set(j - i, [i]);
    i = j;
  }
  const closerAfter = (from: number, len: number): number => {
    const list = runs.get(len);
    if (!list) return -1;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length ? list[lo] : -1;
  };
  const noClose: Record<string, number> = {};
  const findLiteral = (needle: string, from: number): number => {
    if (noClose[needle] !== undefined && noClose[needle] <= from) return -1;
    const k = v.indexOf(needle, from);
    if (k < 0) noClose[needle] = from;
    return k;
  };

  const delims: Delim[] = [];
  let lastDelim = -1;
  const pushDelim = (ch: string, start: number, len: number): void => {
    const before = start > 0 ? v[start - 1] : '\n';
    const after = start + len < n ? v[start + len] : '\n';
    const wsBefore = UNICODE_WS.test(before);
    const wsAfter = UNICODE_WS.test(after);
    const pBefore = UNICODE_PUNCT.test(before);
    const pAfter = UNICODE_PUNCT.test(after);
    const left = !wsAfter && (!pAfter || wsBefore || pBefore);
    const right = !wsBefore && (!pBefore || wsAfter || pAfter);
    const canOpen = ch === '_' ? left && (!right || pBefore) : left;
    const canClose = ch === '_' ? right && (!left || pAfter) : right;
    delims.push({ ch, start, len, orig: len, canOpen, canClose, prev: lastDelim, next: -1, removed: false });
    if (lastDelim >= 0) delims[lastDelim].next = delims.length - 1;
    lastDelim = delims.length - 1;
  };
  const removeDelim = (k: number): void => {
    const d = delims[k];
    if (d.removed) return;
    d.removed = true;
    if (d.prev >= 0) delims[d.prev].next = d.next;
    if (d.next >= 0) delims[d.next].prev = d.prev;
    if (lastDelim === k) lastDelim = d.prev;
  };

  // cmark's process_emphasis over the delimiters at index >= bottom.
  const processEmphasis = (bottom: number): void => {
    const bottoms = new Map<string, number>();
    let closer = -1;
    for (let k = lastDelim; k >= bottom && k >= 0; k = delims[k].prev) closer = k;
    while (closer >= 0) {
      const c = delims[closer];
      if (!c.canClose) { closer = c.next; continue; }
      const key = `${c.ch}${c.canOpen ? 1 : 0}${c.orig % 3}`;
      const floor = bottoms.has(key) ? bottoms.get(key)! : bottom - 1;
      let opener = c.prev;
      let found = false;
      while (opener >= 0 && opener >= bottom && opener > floor) {
        const o = delims[opener];
        if (o.canOpen && o.ch === c.ch && (c.ch !== '~' || (o.len >= 2 && c.len >= 2))) {
          const odd = c.ch !== '~' && (c.canOpen || o.canClose) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0);
          if (!odd) { found = true; break; }
        }
        opener = o.prev;
      }
      if (found) {
        const o = delims[opener];
        const use = c.ch === '~' ? 2 : c.len >= 2 && o.len >= 2 ? 2 : 1;
        const contentStart = o.start + o.len;
        const contentEnd = c.start;
        for (let q = 0; q < use; q++) {
          out.delims.push(o.start + o.len - use + q);
          out.delims.push(c.start + q);
        }
        out.emph.push({ start: contentStart, end: contentEnd, kind: c.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em' });
        o.len -= use;
        c.len -= use;
        c.start += use;
        for (let k = c.prev; k >= 0 && k !== opener;) {
          const p = delims[k].prev;
          removeDelim(k);
          k = p;
        }
        if (o.len === 0) removeDelim(opener);
        if (c.len === 0) {
          const next = c.next;
          removeDelim(closer);
          closer = next;
        }
      } else {
        bottoms.set(key, c.prev);
        const next = c.next;
        if (!c.canOpen) removeDelim(closer);
        closer = next;
      }
    }
    for (let k = lastDelim; k >= 0 && k >= bottom;) {
      const p = delims[k].prev;
      removeDelim(k);
      k = p;
    }
  };

  const brackets: Bracket[] = [];
  const pushBracket = (pos: number, image: boolean): void => {
    if (brackets.length) brackets[brackets.length - 1].bracketAfter = true;
    brackets.push({ pos, image, active: true, delimBottom: delims.length, bracketAfter: false });
  };

  const closeBracket = (i: number): number => {
    const b = brackets[brackets.length - 1];
    if (!b) return i + 1;
    if (!b.active) {
      brackets.pop();
      return i + 1;
    }
    const textStart = b.pos + (b.image ? 2 : 1);
    const after = i + 1;
    let end = -1;
    let kind: InlineLink['kind'] = 'inline';
    let label: Span | null = null;
    if (v[after] === '(') {
      const q = skipWs(v, after + 1);
      const d = scanDestination(v, q);
      if (d >= 0) {
        const endUrl = q + d;
        const st = skipWs(v, endUrl);
        const et = st === endUrl ? st : st + scanTitle(v, st);
        const ea = skipWs(v, et);
        if (v[ea] === ')') end = ea + 1;
      }
    }
    if (end < 0) {
      const l = scanLabel(v, after);
      const raw = l ? v.slice(after + 1, l.end - 1) : '';
      let key: string | null = null;
      if (l && raw.trim()) {
        key = raw;
        kind = 'full';
        label = { start: after + 1, end: l.end - 1 };
      } else if (!b.bracketAfter) {
        key = v.slice(textStart, i);
        kind = l ? 'collapsed' : 'shortcut';
      }
      if (key !== null && defs.has(normalizeLabel(key))) end = kind === 'shortcut' ? i + 1 : l!.end;
    }
    if (end < 0) {
      brackets.pop();
      return i + 1;
    }
    out.links.push({ open: b.pos, textStart, textEnd: i, end, kind, image: b.image, label });
    processEmphasis(b.delimBottom);
    brackets.pop();
    if (!b.image) {
      for (let k = brackets.length - 1; k >= 0; k--) {
        if (brackets[k].image) continue;
        if (!brackets[k].active) break;
        brackets[k].active = false;
      }
    }
    return end;
  };

  for (let i = 0; i < n;) {
    const c = v[i];
    if (c === '\\') {
      if (i + 1 < n && (isPunctAscii(v[i + 1]) || v[i + 1] === '\n')) {
        out.escapes.push(i);
        i += 2;
      } else i++;
    } else if (c === '`') {
      let j = i;
      while (v[j] === '`') j++;
      const len = j - i;
      const k = closerAfter(j, len);
      if (k >= 0) {
        out.opaque.push({ start: i, end: k + len });
        out.codes.push({ start: i, end: k + len });
        i = k + len;
      } else i = j;
    } else if (c === '<') {
      let end = -1;
      let auto = false;
      for (const re of [AUTOLINK_URI, AUTOLINK_EMAIL]) {
        re.lastIndex = i;
        if (re.test(v)) { end = re.lastIndex; auto = true; break; }
      }
      if (end < 0) {
        const s = v.slice(i, i + 9);
        if (s.startsWith('<!-->')) end = i + 5;
        else if (s.startsWith('<!--->')) end = i + 6;
        else if (s.startsWith('<!--')) { const k = findLiteral('-->', i + 4); end = k < 0 ? -1 : k + 3; }
        else if (s.startsWith('<?')) { const k = findLiteral('?>', i + 2); end = k < 0 ? -1 : k + 2; }
        else if (s.startsWith('<![CDATA[')) { const k = findLiteral(']]>', i + 9); end = k < 0 ? -1 : k + 3; }
        else {
          for (const re of [OPEN_TAG, CLOSE_TAG, DECLARATION]) {
            re.lastIndex = i;
            if (re.test(v)) { end = re.lastIndex; break; }
          }
        }
      }
      if (end > i) {
        out.opaque.push({ start: i, end });
        if (auto) out.autolinks.push({ start: i, end });
        i = end;
      } else i++;
    } else if (c === '!' && v[i + 1] === '[') {
      pushBracket(i, true);
      i += 2;
    } else if (c === '[') {
      pushBracket(i, false);
      i++;
    } else if (c === ']') {
      i = closeBracket(i);
    } else if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (v[j] === c) j++;
      if (c !== '~' || j - i === 2) pushDelim(c, i, j - i);
      i = j;
    } else i++;
  }
  processEmphasis(0);
  return out;
}
