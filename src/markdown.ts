/**
 * Markdown band-1 marks that a colour theme physically cannot express.
 *
 * Neither of these is an attention-phase behaviour, so neither is phase-gated:
 * they are part of the resting register, and they live here only because
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
 * Both scanners are plain lexers over the document text rather than queries
 * against the tokenizer, because the extension host has no access to the
 * TextMate token stream. They therefore have to reproduce one thing the
 * injection grammar gets for free: never matching inside code. The exclusions
 * here mirror `syntaxes/md-prose.injection.json`'s injection selector
 * (`-markup.fenced_code -markup.inline.raw -markup.raw -meta.embedded`).
 */

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
 * character that is at least as long. Getting this wrong in the lenient
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
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;

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

    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceChar) {
      // Inside a fence: close only on the same character, at least as long, and
      // with no info string after it.
      if (fence && fence[1][0] === fenceChar && fence[1].length >= fenceLen
          && /^\s{0,3}([`~]{3,})\s*$/.test(line)) {
        spans.push({ start: fenceStart, end: lineStart + line.length });
        fenceChar = '';
        fenceLen = 0;
        fenceStart = -1;
      }
      continue;
    }
    if (fence) {
      fenceChar = fence[1][0];
      fenceLen = fence[1].length;
      fenceStart = lineStart;
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
 * The `==highlighted==` ranges, EXCLUDING the `==` sigils themselves — those
 * stay n7 furniture, which the theme already paints, and washing them would make
 * the mark read as four characters wider than the text it marks.
 *
 * The pattern mirrors the injection grammar's, including the trap that cost
 * three attempts there: the content must not START with `=`, or a setext H1
 * underline (`=========`) parses as a chain of empty highlights.
 */
export function highlightSpans(text: string): Span[] {
  const skip = codeSpans(text);
  const out: Span[] = [];
  // Non-`=` first char, no blank first char, closer on the same line.
  const re = /==([^=\s](?:[^=\n]|=(?!=))*)==/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + 2;
    const end = start + m[1].length;
    if (inAny(skip, m.index, end + 2)) continue;
    out.push({ start, end });
  }
  return mergeSpans(out);
}

/**
 * Link ranges whose underline should be cancelled: the URL half of an inline
 * link or image, plus bare autolinks. Reference-style definitions are included
 * because the link provider reports those too.
 *
 * Scoped deliberately narrowly. The provider also reports things the underline
 * is genuinely useful on — a `<https://…>` autolink is the one case where the
 * underline is the only cue that the text is clickable — but the spec is
 * explicit that a URL is furniture, so consistency wins over that hint.
 */
export function linkSpans(text: string): Span[] {
  const skip = codeSpans(text);
  const out: Span[] = [];
  const push = (start: number, end: number): void => {
    if (!inAny(skip, start, end)) out.push({ start, end });
  };

  // [text](url "title") and ![alt](url) — the target only.
  //
  // The URL alternation allows ONE level of balanced parens, because a Wikipedia
  // link (`…/Foo_(bar)`) is common enough that stopping at the first `(` left the
  // tail underlined — caught by running this over samples/sample.md, not by the
  // unit tests.
  const inline = /(!?\[)(?:[^\]\\]|\\.)*(\]\()((?:[^()\s]|\([^()\s]*\))*)/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(text))) {
    const urlStart = m.index + m[0].length - m[3].length;
    push(urlStart, urlStart + m[3].length);
  }

  // <https://…> autolinks, and bare URLs the provider picks up on its own.
  const autolink = /<(https?:\/\/[^>\s]+|[^\s@<>]+@[^\s@<>]+)>/g;
  while ((m = autolink.exec(text))) {
    push(m.index + 1, m.index + 1 + m[1].length);
  }
  const bare = /(?<![(<\]])\bhttps?:\/\/[^\s<>()[\]"'`]+/g;
  while ((m = bare.exec(text))) {
    push(m.index, m.index + m[0].length);
  }

  // [ref]: https://… definitions. The `[^^]` guard excludes a FOOTNOTE
  // definition (`[^1]: prose…`), which has the same shape but whose body is
  // sentences, not a target — without it the first word of every footnote had its
  // underline suppressed, and worse, was being treated as a link at all.
  const refdef = /^[ \t]*\[(?!\^)(?:[^\]\\]|\\.)+\]:[ \t]*(\S+)/gm;
  while ((m = refdef.exec(text))) {
    const urlStart = m.index + m[0].length - m[1].length;
    push(urlStart, urlStart + m[1].length);
  }

  return mergeSpans(out);
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
