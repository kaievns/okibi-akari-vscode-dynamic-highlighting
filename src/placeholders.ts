/**
 * FORMAT PLACEHOLDER spans — a band-1 mark the theme cannot always express.
 *
 * A placeholder is a slot in a string that reaches out to an argument: `%d` in Go,
 * `{}`/`{name}`/`{:>8}` in Rust, `%s` and an f-string hole in Python, `${…}` in a
 * TS/JS template. That makes it the string's window onto the program's data rather
 * than string CONTENT, so the theme paints it member steel — the register used for
 * reaching into data.
 *
 * For Go, Python and TS the theme handles it alone: each grammar emits a distinct
 * scope for the placeholder (Go via `syntaxes/go-format.injection.json`), and the
 * language server either agrees or says nothing.
 *
 * RUST IS THE EXCEPTION, and it is why this module exists. rust-analyzer emits ONE
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
 * Phase-independent by design. This is band 1 — the resting register — so it is not
 * gated on Focus or Edit and does not blink when the phase relaxes.
 */

export interface Span {
  start: number;
  end: number;
}

/**
 * Rust format placeholders in a document: the `{…}` holes inside string literals.
 *
 * Scanned rather than regexed over the whole text, because a `{` means different
 * things inside and outside a string and the two must not be confused:
 *
 *   - only INSIDE a double-quoted string literal (including a raw string) does a
 *     `{` open a placeholder; outside it is a block brace;
 *   - `{{` and `}}` are ESCAPED literal braces and are not placeholders;
 *   - a lifetime apostrophe (`'a`) must not be read as opening a char literal, the
 *     same trap `scanBraceBlocks` has;
 *   - line and block comments are skipped, so a `{}` in prose is left alone.
 *
 * Deliberately NOT restricted to macro calls. A format string can be built anywhere
 * (`let s = format!(…)`, a `const FMT: &str = "{}"`, an argument to a helper that
 * forwards to `write!`), and a `{}` inside a Rust string literal is a placeholder in
 * every case that matters — a literal brace is spelled `{{`.
 */
export function rustPlaceholderSpans(text: string): Span[] {
  const out: Span[] = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    // Comments — skip wholesale.
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }

    // A char literal, or a lifetime. `'a` never closes, so treating it as a quote
    // would swallow the rest of the file.
    if (c === "'") {
      if (isLifetime(text, i)) {
        i += 1;
        continue;
      }
      i = skipCharLiteral(text, i);
      continue;
    }

    // A raw string: r"…", r#"…"#, r##"…"##. The hash count sets the terminator.
    if (c === 'r' && (text[i + 1] === '"' || text[i + 1] === '#')) {
      const raw = matchRawStringStart(text, i);
      if (raw) {
        const closer = `"${'#'.repeat(raw.hashes)}`;
        const end = text.indexOf(closer, raw.bodyStart);
        const bodyEnd = end < 0 ? n : end;
        collectHoles(text, raw.bodyStart, bodyEnd, out);
        i = end < 0 ? n : end + closer.length;
        continue;
      }
    }

    // A normal double-quoted string. A byte string (`b"…"`) has the same body rules.
    if (c === '"') {
      const bodyStart = i + 1;
      let j = bodyStart;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') break;
        j += 1;
      }
      collectHoles(text, bodyStart, Math.min(j, n), out);
      i = j < n ? j + 1 : n;
      continue;
    }

    i += 1;
  }

  return out;
}

/**
 * The `{…}` holes inside one string body, appended to `out`.
 *
 * `{{` is an escaped literal brace and is skipped as a pair. An unclosed `{` (the
 * string ends first) is not a placeholder and is dropped rather than run past the
 * end of the body.
 */
function collectHoles(text: string, start: number, end: number, out: Span[]): void {
  let i = start;
  while (i < end) {
    if (text[i] === '{') {
      if (text[i + 1] === '{') { i += 2; continue; } // `{{` — literal brace
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
    if (text[i] === '}' && text[i + 1] === '}') { i += 2; continue; } // `}}`
    i += 1;
  }
}

/** `'a` / `'_` / `'static` — an apostrophe that opens a lifetime, not a char. */
function isLifetime(text: string, offset: number): boolean {
  const next = text[offset + 1];
  if (next === undefined) return false;
  if (next === '\\') return text[offset + 3] !== "'";
  if (!/[A-Za-z_]/.test(next)) return false;
  return text[offset + 2] !== "'";
}

/** Offset just past a char literal starting at `offset`. */
function skipCharLiteral(text: string, offset: number): number {
  let i = offset + 1;
  if (text[i] === '\\') i += 2;
  else i += 1;
  return text[i] === "'" ? i + 1 : offset + 1;
}

/** `r"`, `r#"`, `r##"` … → the hash count and where the body starts. */
function matchRawStringStart(
  text: string,
  offset: number,
): { hashes: number; bodyStart: number } | null {
  let i = offset + 1;
  let hashes = 0;
  while (text[i] === '#') { hashes += 1; i += 1; }
  if (text[i] !== '"') return null;
  return { hashes, bodyStart: i + 1 };
}
