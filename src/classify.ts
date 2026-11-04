/**
 * Band-2 classification — spec §5.4 and the "how far you must look to find
 * where a name is bound" rule.
 *
 *   block-local — declared inside the focused block.
 *   fn-local    — declared in the enclosing function (incl. params) but outside
 *                 the block: "borrowed in". Rendered --id-*, normal weight.
 *   out-of-fn   — module globals, captures, or names with no visible
 *                 declaration. Rendered --idg-*, bold.
 *   self        — this / self / @-prefixed. Gold slot 2, never a variable.
 *
 * Two layers, sharply separated so the hot logic is testable without a VS Code
 * host:
 *   - PURE core (this file's exported functions): given already-fetched data
 *     (decoded semantic tokens, function ranges, text, block), produce a
 *     Classification. No vscode imports, all offset-based.
 *   - IMPURE Classifier (classify-lsp.ts): fetches symbols + semantic tokens via
 *     the LSP commands, converts to the offset structures, and delegates here.
 *
 * The hybrid strategy (user decision 1): the impure layer tries LSP first and
 * falls back to a heuristic lexical scan; both feed the same pure classifier
 * shapes. Misclassification of capture-vs-global affects only trace WIDTH, never
 * colour correctness (spec-sanctioned approximation to avoid per-name
 * definition-provider round trips).
 */

import { lexIdentifiers } from './focus';

export type Cls = 'block' | 'fn' | 'out' | 'self';
export type ClassSource = 'lsp' | 'heuristic' | 'mixed';

export interface OffsetRange {
  start: number;
  end: number;
}

/** A semantic token after decoding + legend resolution, offset-based. */
export interface DecodedToken {
  name: string;
  offset: number;
  length: number;
  /** Resolved token type from the legend, e.g. "variable", "parameter". */
  type: string;
  /** Resolved modifier names, e.g. ["declaration", "readonly"]. */
  modifiers: string[];
}

export interface NameInfo {
  cls: Cls;
  /** Occurrences of this name INSIDE the focused block. */
  freqInBlock: number;
  /** Absolute offset of the name's first occurrence anywhere in the file (stability anchor). */
  firstFileOffset: number;
  /** Absolute offset of the name's first occurrence inside the block (assignment ordering). */
  firstBlockOffset: number;
  /** out-of-fn only: a capture (home-fn trace) vs a true global (file-wide trace). */
  isCapture: boolean;
  /** For a capture, the home function range its declaration sits in. */
  homeFn?: OffsetRange;
  /**
   * Attention proximity — how directly this name belongs to the FOCUSED block,
   * used to prioritise hue slots when a block has more locals than hues (the
   * deepest/closest data wins, per the attention-priority principle):
   *   0 — declared directly in the focused block (its own local)
   *   1 — borrowed in: declared in an enclosing scope (fn-local / capture)
   *   2 — declared in a NESTED sub-block the caret sits above (belongs to a
   *       child scope you're not inside — lowest priority)
   */
  proximity: 0 | 1 | 2;
}

export interface Classification {
  docVersion: number;
  focusKey: string;
  /** Only names USED in the focused block that resolved to a class. */
  byName: Map<string, NameInfo>;
  /** File-wide occurrence ranges per name (feeds both classification and traces). */
  occurrences: Map<string, OffsetRange[]>;
  /**
   * Every true global (out-of-fn, non-capture) in the file, ordered by first
   * appearance. Lets the decorator seed the colour ledger deterministically so a
   * global's hue is fixed by FILE order, not the order blocks happen to be
   * visited (spec stability rule). Block-independent by construction.
   */
  fileGlobalsInOrder: string[];
  /**
   * Local data identities (fn-locals, block-locals, captures — everything that
   * is neither a true global nor self) used ANYWHERE in the enclosing function,
   * ordered by first appearance IN THE FUNCTION. This is what makes a local's
   * hue stable across every sub-block of its function: colour is assigned by
   * function-order, not per focused block, so `cfg` keeps one hue whether the
   * caret is in the function body, an `if`, or a `for`. Function-scoped and
   * block-independent by construction.
   */
  fnLocalsInOrder: string[];
  /** True globals that appear in the enclosing function (their hues are skipped when assigning locals). */
  fnGlobals: string[];
  /**
   * The colour scope — the OUTERMOST function containing the caret. Its span is
   * the key for the local colour ledger, so a variable's hue is stable across
   * the whole top-level function and every nested closure.
   */
  colorScopeFn: OffsetRange | undefined;
  /** The INNERMOST enclosing function, used for block/fn/out classification and traces. */
  enclosingFn: OffsetRange | undefined;
  /**
   * Function ranges that REDECLARE each name (see FileIndex.shadowScopes). The
   * trace layer subtracts the ones that are not the focused identity's own scope,
   * so a global `cfgs` does not tint a same-named parameter in another function.
   */
  shadowScopes: Map<string, OffsetRange[]>;
  source: ClassSource;
}

/** this / self are always the gold self-slot; @-prefixed handled by the caller. */
const SELF_NAMES = new Set(['this', 'self']);

/**
 * File-wide analysis, computed ONCE per document version and shared by every
 * block classified in that version.
 *
 * Without this, each per-block classify redid the whole-file token scan, the
 * whole-file self-occurrence lex, and the file-globals computation — so
 * classifying an N-block scope was N× the file-wide work, and cost grew with
 * total file size even though the scope size was fixed. Hoisting it makes the
 * per-block pass depend only on the block, and the scope pass linear in blocks.
 */
export interface FileIndex {
  /** Tintable occurrence ranges per name, file-wide (insertion order = first appearance). */
  occurrences: Map<string, OffsetRange[]>;
  /** Declaration offsets per name (shorthand reads excluded — they declare a property, not a binding). */
  declOffsets: Map<string, number[]>;
  /** First file offset per name. */
  firstFileOffset: Map<string, number>;
  /** Names whose every declaration is outside any function → true globals, file order. */
  fileGlobalsInOrder: string[];
  /**
   * Per name, the function ranges that DECLARE it — i.e. the regions where that
   * name is bound to a different identity than an outer one.
   *
   * Shadowing is the reason this exists. Occurrences are keyed by name, so a
   * module-level `const cfgs` and a `function summarize(cfgs)` parameter were one
   * identity sharing one hue — the highlighting asserted a data-flow link that
   * does not exist, which is the exact bug class shadowing causes in the first
   * place. `shadowedRanges` lets the trace layer subtract the inner binding's
   * region from an outer name's trace. See traces.ts.
   */
  shadowScopes: Map<string, OffsetRange[]>;
}

/**
 * For each name, the function ranges containing one of its declarations.
 *
 * Only the NARROWEST declaring range per declaration is kept: if `summarize`
 * declares `cfgs` and an inner closure does not, the closure is already covered
 * by `summarize`'s range.
 */
function computeShadowScopes(
  declOffsets: Map<string, number[]>,
  fnRanges: OffsetRange[],
): Map<string, OffsetRange[]> {
  const out = new Map<string, OffsetRange[]>();
  for (const [name, offsets] of declOffsets) {
    const scopes: OffsetRange[] = [];
    for (const o of offsets) {
      const fn = enclosingFnOf(fnRanges, o);
      if (fn && !scopes.some((s) => s.start === fn.start && s.end === fn.end)) {
        scopes.push(fn);
      }
    }
    if (scopes.length > 0) {
      out.set(name, scopes);
    }
  }
  return out;
}

/**
 * Offset ranges of PYTHON CLASS-BODY FIELD DECLARATIONS — the lines directly
 * inside a `class` that declare attributes rather than locals.
 *
 *   @dataclass
 *   class Config:
 *       name: str                                   <-- attribute, not data
 *       retries: int = MAX_RETRIES                  <-- attribute, not data
 *       tags: dict[str, str] = field(...)           <-- attribute, not data
 *
 *       def with_retries(self, retries: int): ...   <-- a method; its body IS data
 *
 * Pylance reports these as `variable [declaration]`, indistinguishable on the
 * wire from a real local, so the classifier tinted them as the class's own data
 * identities. They are the Python spelling of a struct field: attribute names are
 * band-1 in every other language here (`variable.other.property` in Go and TS),
 * and the theme now paints Python's the same way, so the dynamic layer tinting
 * them contradicted the resting register directly.
 *
 * The same reasoning as `typeDeclRanges`, which this feeds: a name that declares
 * a FIELD rather than a binding holds no data at this point in the program.
 *
 * Detection is lexical and deliberately narrow — only lines at exactly one indent
 * step inside a `class` header, stopping at the first line that dedents out of the
 * body. A method's `def` line ends the run of fields; its body is never included,
 * so locals inside methods keep tinting normally. An assignment with no
 * annotation (`count = 0`) is included too: in a class body that is still a class
 * attribute.
 */
function pyClassFieldRanges(text: string): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  const lines = text.split('\n');
  const starts: number[] = [0];
  for (let i = 0; i < lines.length - 1; i++) {
    starts.push(starts[i] + lines[i].length + 1);
  }
  const indentOf = (s: string): number => (/^([ \t]*)/.exec(s)?.[1].length ?? 0);

  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*)class\b[^\n]*:\s*(#.*)?$/.exec(lines[i]);
    if (!m) {
      continue;
    }
    const classIndent = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (raw.trim() === '' || raw.trimStart().startsWith('#')) {
        continue;
      }
      if (indentOf(raw) <= classIndent) {
        break; // dedented out of the class body
      }
      // A nested `def`/`class` opens its own scope; its contents are not fields.
      // Skip its whole suite rather than treating its body lines as fields.
      if (/^[ \t]*(async[ \t]+)?(def|class)\b/.test(raw)) {
        const bodyIndent = indentOf(raw);
        while (
          j + 1 < lines.length &&
          (lines[j + 1].trim() === '' || indentOf(lines[j + 1]) > bodyIndent)
        ) {
          j++;
        }
        continue;
      }
      // A field declaration: `name: T`, `name: T = v`, or a bare `name = v`.
      if (/^[ \t]*[A-Za-z_]\w*[ \t]*(:|=)/.test(raw)) {
        // Only the NAME is furniture. The right-hand side is real code — a call,
        // a reference to a module constant — and those names still hold data.
        const eq = /^[ \t]*[A-Za-z_]\w*[ \t]*/.exec(raw)![0].length;
        ranges.push({ start: starts[j], end: starts[j] + eq });
      }
    }
  }
  return ranges;
}

/**
 * Offset ranges of TYPE DECLARATIONS — `type X = …`, `interface X { … }`.
 *
 * Parameter names inside a type signature are pure documentation: they name
 * nothing at runtime and hold no data.
 *
 *   type Reducer<T> = (acc: T, item: Job) => T;     // TS
 *   type Handler func(ctx *Context, in []byte)      // Go
 *
 * Both servers report those as `parameter [declaration]`, identical to a real
 * one. Because a type alias is not a function range, they classified as
 * top-level globals and then traced FILE-WIDE — so the `acc` on the type alias
 * gave every unrelated `acc` in the file a global's hue.
 *
 * Detection is lexical (one linear scan, no parser): from a line-initial `type`
 * or `interface` keyword to the end of its declaration — the matching close of
 * the first bracket if one opens before the line ends, else end of line. Go's
 * `type ( … )` grouped block is covered by the bracket case.
 */
function typeDeclRanges(text: string): OffsetRange[] {
  const ranges: OffsetRange[] = [...pyClassFieldRanges(text)];
  const re = /(^|\n)[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(type|interface)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[1].length;
    const lineEnd = text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start);
    // Does a bracket open on this line? If so the declaration runs to its match.
    let end = lineEnd;
    let open = -1;
    for (let i = start; i < lineEnd; i++) {
      if (text[i] === '{' || text[i] === '(') {
        open = i;
        break;
      }
    }
    if (open !== -1) {
      const closer = text[open] === '{' ? '}' : ')';
      let depth = 0;
      for (let i = open; i < text.length; i++) {
        if (text[i] === text[open]) {
          depth++;
        } else if (text[i] === closer) {
          depth--;
          if (depth === 0) {
            end = i + 1;
            break;
          }
        }
      }
    }
    ranges.push({ start, end });
    re.lastIndex = end; // skip past — no nested type decls to find inside
  }
  // The consumer walks these with a MONOTONIC cursor (`while typeDecls[td].end <=
  // tok.offset`), so document order is a precondition, not a nicety. The Python
  // class-field ranges are prepended above and interleave with the type-decl
  // ranges in a mixed file, which would leave the cursor past ranges it never
  // checked — silently un-excluding them.
  return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Build the file-wide index from decoded semantic tokens. Pure; cache by
 * document version.
 */
export function buildFileIndex(
  text: string,
  tokens: DecodedToken[],
  fnRanges: OffsetRange[],
): FileIndex {
  const occurrences = new Map<string, OffsetRange[]>();
  const declOffsets = new Map<string, number[]>();
  const firstFileOffset = new Map<string, number>();
  // Type declarations, in offset order. Tokens are too — the LSP wire format is
  // DELTA-encoded (Δline, Δchar, …), so ascending offset is guaranteed by the
  // protocol, not by luck. That lets a single advancing cursor decide containment
  // in O(tokens + ranges) instead of a `.some()` scan per token, which cost ~5ms
  // on a 100KB file.
  const typeDecls = typeDeclRanges(text);
  let td = 0;

  for (const tok of tokens) {
    // Parameter names in a type signature are documentation, not data.
    while (td < typeDecls.length && typeDecls[td].end <= tok.offset) {
      td++;
    }
    if (td < typeDecls.length && tok.offset >= typeDecls[td].start) {
      continue;
    }
    // Data identities are variable/parameter. `property` is normally band-1, but
    // object-shorthand (`{ name }`) is a real read of a binding and tints like it.
    const tintable =
      TINTABLE_TYPES.has(tok.type) ||
      (tok.type === 'property' && isShorthandPropertyRead(text, tok.offset, tok.length, tok.modifiers));
    if (!tintable) {
      continue;
    }
    // `self` / `this` own the gold self-slot and are lexed separately below; band 1
    // paints them. Kept as a guard because in a toolchain-less rust-analyzer a `self`
    // USE degrades to bare `const` (its declaration is `selfKeyword`), and `const`
    // is tintable — so without this skip every `self.field` read could be pulled
    // into the hue palette and drop off band 1, the "self renders white" report.
    if (isSelfName(tok.name)) {
      continue;
    }
    // Builtins (console, Math…) are library surface, not this file's data.
    if (tok.modifiers.some((m) => NON_DATA_MODIFIERS.has(m))) {
      continue;
    }
    // A name in MEMBER or KEYWORD-ARGUMENT position is not a data identity, even
    // when the server types it `variable`.
    if (isMemberOrLabelPosition(text, tok.offset, tok.length)) {
      continue;
    }
    const range: OffsetRange = { start: tok.offset, end: tok.offset + tok.length };
    const list = occurrences.get(tok.name);
    if (list) {
      list.push(range);
    } else {
      occurrences.set(tok.name, [range]);
      firstFileOffset.set(tok.name, tok.offset);
    }
    // A shorthand-read (`{ name }`) carries a `declaration` modifier because it
    // syntactically declares the object PROPERTY — but it READS the variable, it
    // does not declare it. Counting it as a declaration would (wrongly) make the
    // variable block-local to whatever object literal it appears in, dropping it
    // to neutral. So never treat a shorthand read as a binding declaration.
    const isShorthand = tok.type === 'property';
    if (!isShorthand && tok.modifiers.some((m) => DECL_MODIFIERS.has(m))) {
      const d = declOffsets.get(tok.name);
      if (d) {
        d.push(tok.offset);
      } else {
        declOffsets.set(tok.name, [tok.offset]);
      }
    }
  }

  // self names are keywords the token stream skips; lex them once here so the
  // trace layer has ranges for them (band 1 paints them, but escape-risk needs
  // the classification).
  const selfWanted = new Set<string>();
  for (const name of SELF_NAMES) {
    selfWanted.add(name);
  }
  for (const id of lexIdentifiers(text)) {
    if (selfWanted.has(id.name)) {
      const range: OffsetRange = { start: id.offset, end: id.offset + id.length };
      const list = occurrences.get(id.name);
      if (list) {
        list.push(range);
      } else {
        occurrences.set(id.name, [range]);
        firstFileOffset.set(id.name, id.offset);
      }
    }
  }

  // MACRO ARGUMENTS are a semantic-token DESERT. rust-analyzer (and every server
  // that does not expand macros for highlighting) emits NO tokens for the
  // identifiers inside `println!(…)`, `write!(…)`, `format!(…)` and friends — the
  // callee and the format string are tokenized, the arguments are not. So a binding
  // used ONLY inside a macro call had no occurrence there:
  //   - `cfg` in `load_config` is read as `cfg.name` inside `println!`, so it went
  //     dead the moment the caret entered the loop that only uses it there;
  //   - `label` is built on one line and consumed solely by `write!(f, "{}", label)`,
  //     so it never tinted at all.
  // Lex the macro-argument regions and add occurrences — but ONLY for names that are
  // ALREADY data identities from a real token elsewhere. That is the safety rail: it
  // extends the trace of a known binding into the macro, and never invents an
  // identity from a bare word (a type, a macro name, a path segment) that happens to
  // sit in the arguments. Member and label positions (`cfg.name`, `name=`) are
  // skipped for the same reason they are in the token loop.
  for (const region of macroArgRanges(text)) {
    for (const id of lexIdentifiers(text, region.start, region.end)) {
      if (!occurrences.has(id.name) || isSelfName(id.name)) {
        continue; // only extend a KNOWN binding; never mint one from a macro arg
      }
      if (isMemberOrLabelPosition(text, id.offset, id.length)) {
        continue; // `cfg.name` — the member is band-1, the receiver `cfg` is not
      }
      occurrences.get(id.name)!.push({ start: id.offset, end: id.offset + id.length });
    }
  }
  // The occurrence lists per name are no longer in offset order after the macro
  // pass appended to them. Downstream consumers (trace clipping, first-offset) do
  // not require order, but keep each list sorted so a range never precedes an
  // earlier one — cheap, and it makes the index deterministic to inspect.
  for (const ranges of occurrences.values()) {
    ranges.sort((a, b) => a.start - b.start);
  }

  const fileGlobalsInOrder = computeFileGlobals(occurrences, declOffsets, fnRanges);
  const shadowScopes = computeShadowScopes(declOffsets, fnRanges);
  return { occurrences, declOffsets, firstFileOffset, fileGlobalsInOrder, shadowScopes };
}

/**
 * Argument regions of Rust MACRO calls: the span inside the `(`, `[` or `{` that
 * follows a `name!`. Returns `[start, end)` offsets of the interior, excluding the
 * brackets themselves.
 *
 * Why a dedicated scan rather than reusing the block scanner: a macro call is
 * `ident! ( … )`, and the delimiter can be any of the three bracket kinds
 * (`vec![…]`, `println!(…)`, `quote!{…}`). The scan skips strings, chars and
 * comments so a `)` inside a format string does not close the span early, and it
 * handles the lifetime apostrophe the same way `scanBraceBlocks` does.
 *
 * Language-neutral callers pass any text; only Rust source contains `name!`
 * followed by a bracket, so on other languages this simply finds nothing.
 */
function macroArgRanges(text: string): OffsetRange[] {
  const out: OffsetRange[] = [];
  const bang = /(?<![.\w])([A-Za-z_]\w*)!\s*([([{])/g;
  const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  let m: RegExpExecArray | null;
  while ((m = bang.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const closer = CLOSER[m[2]];
    let depth = 0;
    let state: 'code' | 'str' | 'chr' | 'line' | 'block' = 'code';
    let i = open;
    for (; i < text.length; i++) {
      const c = text[i];
      if (state === 'str') { if (c === '\\') i++; else if (c === '"') state = 'code'; continue; }
      if (state === 'chr') { if (c === '\\') i++; else if (c === "'") state = 'code'; continue; }
      if (state === 'line') { if (c === '\n') state = 'code'; continue; }
      if (state === 'block') { if (c === '*' && text[i + 1] === '/') { i++; state = 'code'; } continue; }
      if (c === '"') { state = 'str'; continue; }
      if (c === "'" && !isRustLifetimeChar(text, i)) { state = 'chr'; continue; }
      if (c === '/' && text[i + 1] === '/') { state = 'line'; i++; continue; }
      if (c === '/' && text[i + 1] === '*') { state = 'block'; i++; continue; }
      if ('([{'.includes(c)) { depth++; continue; }
      if (')]}'.includes(c)) {
        depth--;
        if (depth === 0) break; // matched the macro's own closer
      }
    }
    if (depth === 0 && text[i] === closer) {
      out.push({ start: open + 1, end: i });
      bang.lastIndex = i + 1; // resume after the span, so a nested `name!` inside is still found next pass
    }
  }
  return out;
}

/**
 * A char-literal apostrophe vs a Rust lifetime `'a`, mirroring focus.ts's
 * `isRustLifetime`. Duplicated small and local rather than exported across the
 * module boundary: this file must not depend on focus.ts's internals.
 */
function isRustLifetimeChar(text: string, offset: number): boolean {
  const next = text[offset + 1];
  if (next === undefined) return false;
  if (next === '\\') return text[offset + 3] !== "'";
  if (!/[A-Za-z_]/.test(next)) return false;
  return text[offset + 2] !== "'";
}

/**
 * Semantic token types we treat as tintable DATA identities. Band 2 is about
 * data flow, so only bindings you can trace — variables and parameters — get an
 * identity tint. Functions, methods, properties, classes, namespaces, types etc.
 * keep their band-1 theme colour: a function/method name is a transformer with
 * its own stable visual identity (bold blue), not a data value; a property is a
 * field access, not a binding. Excluding them also frees the 6-slot budget for
 * the variables that actually carry data.
 */
const TINTABLE_TYPES = new Set(['variable', 'parameter', 'const']);

/**
 * `const` is tintable for RUST because it means exactly one thing: a genuine
 * constant (`const MAX_RETRIES: u32 = 3;` and its reads). rust-analyzer types it
 * `const` at both its declaration and its uses, with a `constant` modifier. A
 * module constant is precisely the identity the reader wants traced — declared
 * once at the top, read far away inside functions — which is why the top-level
 * scope already exempts it from the use-count floor (see scopecolor.ts `eligible`,
 * `isTopLevel`). Leaving `const` out meant `MAX_RETRIES` rendered page-white at its
 * declaration while its reads elsewhere took a colour: one identity, two looks.
 *
 * IMPORTANT — a correction to an earlier draft of this file. It claimed ordinary
 * LOCALS come back as `const` at their uses and only `variable` at declaration, and
 * skipped `const.declaration` to keep "real constants" band-1. That was measured
 * against a rust-analyzer running WITHOUT cargo/rustc on PATH, where name
 * resolution is degraded. With a real toolchain and a cleanly-loading workspace,
 * a local is `variable` at BOTH its declaration and its uses; only a true constant
 * is ever `const`. So the discriminator is the type itself — no modifier check, no
 * skip. `self` is still guarded separately above, because a toolchain-less server
 * degrades a `self` use to bare `const`.
 */

/**
 * Modifiers that disqualify a token from identity tinting even when its type is
 * variable/parameter. `defaultLibrary` marks builtins (console, Math, nil,
 * true/false…) — library surface, not the file's own data. `signature` (gopls)
 * marks FUNCTION-TYPED values (a func param `h Handler`, a func-typed local):
 * calls through them are transformers, not data — they keep band-1's bold blue
 * like any other function. `readonly`/`static` are NOT excluded: a readonly
 * local is still data.
 */
// `classMember` / `dynamicAttribute` are Pylance's: it types an instance
// attribute `variable` (not `property`, as TS and gopls would) and distinguishes
// it ONLY by this modifier. Without it every `self.seen` and `cfg.retries` was a
// tintable data identity, which both fought the member-steel resting register and
// let an attribute share a hue with a same-named local. The positional guard in
// `isMemberOrLabelPosition` catches these too, but the modifier is the server's own
// answer and does not depend on a dot being adjacent — `getattr`-style dynamic
// attributes carry it with no dot at all.
const NON_DATA_MODIFIERS = new Set([
  'defaultLibrary', 'signature', 'classMember', 'dynamicAttribute',
]);

const DECL_MODIFIERS = new Set(['declaration', 'definition']);

/** A minimal keyword denylist for the heuristic path (no semantic types to lean on). */
const HEURISTIC_KEYWORDS = new Set([
  // JS/TS
  'const', 'let', 'var', 'function', 'class', 'return', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'new', 'delete', 'typeof', 'instanceof',
  'in', 'of', 'void', 'this', 'super', 'null', 'undefined', 'true', 'false', 'async',
  'await', 'yield', 'try', 'catch', 'finally', 'throw', 'import', 'export', 'from',
  'default', 'extends', 'implements', 'interface', 'type', 'enum', 'namespace', 'as',
  'is', 'keyof', 'readonly', 'public', 'private', 'protected', 'static', 'get', 'set',
  // Go / C-family extras
  'func', 'package', 'defer', 'go', 'chan', 'map', 'struct', 'range', 'select',
  'int', 'string', 'bool', 'float', 'double', 'char', 'long', 'short', 'unsigned',
  'nil', 'true', 'false',
  // Python. The list was JS/Go-only, so `lambda` was ranked as a DATA IDENTITY —
  // it took a hue in every scope containing a lambda, and consumed one of the
  // palette's few slots. `self`/`cls` are handled separately (the gold self-slot),
  // and the words this list shares with JS (`class`, `return`, `if`, …) are already
  // above.
  'lambda', 'def', 'elif', 'pass', 'raise', 'except', 'with', 'global', 'nonlocal',
  'assert', 'del', 'None', 'True', 'False', 'and', 'or', 'not', 'match',
  // Rust. Same failure mode as `lambda` above, at a much larger scale: only `let`
  // was already here, so `fn`, `mut`, `impl`, `pub` and `where` each ranked as a
  // data identity and took one of the palette's few slots in every block that
  // mentioned them — `mut` and `pub` appear on more lines than most real bindings
  // do. `self`/`Self` are deliberately absent: they go through isSelfName() and get
  // the gold self-slot, exactly as in Python.
  'fn', 'mut', 'impl', 'trait', 'pub', 'crate', 'mod', 'dyn', 'ref', 'move',
  'unsafe', 'where', 'loop', 'extern', 'union', 'box',
  // The primitive types. These are `entity.name.type` in the grammar and type slate
  // at rest, so tinting them as data would contradict band 1.
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'i8', 'i16', 'i32', 'i64', 'i128',
  'isize', 'f32', 'f64', 'str',
]);

/** Declaration keywords that introduce a binding on the following identifier. */
const DECL_KEYWORDS = new Set(['const', 'let', 'var', 'function', 'class', 'func', 'def', 'type', 'enum', 'interface', 'struct']);

/** Compute the start offset of each line, so (line,char) → absolute offset. */
export function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Decode a VS Code SemanticTokens data array (5-tuple delta stream:
 * deltaLine, deltaStartChar, length, tokenTypeIndex, tokenModifiersBitset) into
 * absolute-offset tokens with legend-resolved type + modifier names.
 */
export function decodeSemanticTokens(
  data: ArrayLike<number>,
  tokenTypes: string[],
  tokenModifiers: string[],
  lineStarts: number[],
  text: string,
): DecodedToken[] {
  const out: DecodedToken[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const dLine = data[i];
    const dChar = data[i + 1];
    const length = data[i + 2];
    const typeIdx = data[i + 3];
    const modBits = data[i + 4];

    if (dLine > 0) {
      line += dLine;
      char = dChar;
    } else {
      char += dChar;
    }

    const lineStart = lineStarts[line];
    if (lineStart === undefined) {
      continue;
    }
    const offset = lineStart + char;
    const name = text.slice(offset, offset + length);
    const type = tokenTypes[typeIdx] ?? '';
    const modifiers: string[] = [];
    for (let b = 0; b < tokenModifiers.length; b++) {
      if (modBits & (1 << b)) {
        modifiers.push(tokenModifiers[b]);
      }
    }
    out.push({ name, offset, length, type, modifiers });
  }
  return out;
}

function inRange(offset: number, range: OffsetRange): boolean {
  return offset >= range.start && offset < range.end;
}

function insideAnyFn(offset: number, fnRanges: OffsetRange[]): boolean {
  return fnRanges.some((r) => inRange(offset, r));
}

/**
 * True globals (out-of-fn, non-capture) across the whole file, in order of
 * first appearance. A name is a true global when none of its declarations sit
 * inside any function range — i.e. declared at module scope, or with no visible
 * declaration at all. `occurrences` is iterated in insertion order, which is
 * first-appearance order, so the returned list is file-ordered. This is
 * block-independent, so it seeds the colour ledger identically regardless of
 * which block is focused first (fixes navigation-order hue drift).
 */
function computeFileGlobals(
  occurrences: Map<string, OffsetRange[]>,
  declOffsets: Map<string, number[]>,
  fnRanges: OffsetRange[],
): string[] {
  const globals: string[] = [];
  for (const name of occurrences.keys()) {
    if (isSelfName(name)) {
      continue;
    }
    const decls = declOffsets.get(name) ?? [];
    const declaredInFn = decls.some((o) => insideAnyFn(o, fnRanges));
    if (!declaredInFn) {
      globals.push(name);
    }
  }
  return globals;
}

/**
 * Split the data names appearing in `enclosingFn` into local identities and
 * true globals, each ordered by first appearance IN THE FUNCTION. Local hue
 * assignment keys off `locals` so a variable keeps one colour across every
 * sub-block of its function (data-flow identity is function-stable, not
 * block-stable). `globals` names are the file-globals visible in the function,
 * whose hues the local assignment must skip to avoid collisions.
 *
 * A name is a local identity here if it has a declaration inside ANY function
 * (its own or an outer one it captures); a name with no in-function declaration
 * is a true global. self names are excluded (they own the gold slot).
 */
function computeFnLocals(
  occurrences: Map<string, OffsetRange[]>,
  declOffsets: Map<string, number[]>,
  fnRanges: OffsetRange[],
  enclosingFn: OffsetRange | undefined,
): { locals: string[]; globals: string[] } {
  if (!enclosingFn) {
    return { locals: [], globals: [] };
  }
  // First in-function offset per name, over occurrences that fall in the fn.
  const firstInFn = new Map<string, number>();
  for (const [name, ranges] of occurrences) {
    if (isSelfName(name)) {
      continue;
    }
    let earliest = Infinity;
    for (const r of ranges) {
      if (inRange(r.start, enclosingFn) && r.start < earliest) {
        earliest = r.start;
      }
    }
    if (earliest !== Infinity) {
      firstInFn.set(name, earliest);
    }
  }
  const localNames: string[] = [];
  const globalNames: string[] = [];
  for (const name of firstInFn.keys()) {
    const decls = declOffsets.get(name) ?? [];
    const declaredInSomeFn = decls.some((o) => insideAnyFn(o, fnRanges));
    (declaredInSomeFn ? localNames : globalNames).push(name);
  }
  const byFirst = (a: string, b: string): number => (firstInFn.get(a) ?? 0) - (firstInFn.get(b) ?? 0);
  localNames.sort(byFirst);
  globalNames.sort(byFirst);
  return { locals: localNames, globals: globalNames };
}

/**
 * The innermost function range containing `offset`. Ties break to the tightest
 * span. Returns undefined at top level.
 */
export function enclosingFnOf(fnRanges: OffsetRange[], offset: number): OffsetRange | undefined {
  let best: OffsetRange | undefined;
  for (const r of fnRanges) {
    if (inRange(offset, r)) {
      if (!best || r.end - r.start < best.end - best.start) {
        best = r;
      }
    }
  }
  return best;
}

/**
 * The OUTERMOST (widest) function range containing `offset`. This is the colour
 * scope: a variable's hue is stable across the whole top-level function and all
 * its nested closures (`.map`/`.filter`/callbacks). Keying colour on the
 * innermost function would recolour a captured name every time the caret enters
 * a closure — which is exactly the "c goes purple → orange" glitch. Returns
 * undefined at module top level.
 */
export function outermostFnOf(fnRanges: OffsetRange[], offset: number): OffsetRange | undefined {
  let best: OffsetRange | undefined;
  for (const r of fnRanges) {
    if (inRange(offset, r)) {
      if (!best || r.end - r.start > best.end - best.start) {
        best = r;
      }
    }
  }
  return best;
}

function isSelfName(name: string): boolean {
  return SELF_NAMES.has(name) || name.startsWith('@');
}

/**
 * Is this token in MEMBER position (`self.retries`) or KEYWORD-ARGUMENT LABEL
 * position (`Config(name=…)`)? Neither is a data identity.
 *
 * `TINTABLE_TYPES` already restricts tinting to `variable`/`parameter` on the
 * assumption that a server types a member access as `property`. TS and gopls do —
 * across both captured fixtures there is not one `variable`/`parameter` token
 * sitting after a dot. Pylance does not, consistently: on
 *
 *   self.retries = retries
 *
 * both halves came back as one tintable name, so the attribute and the parameter
 * got the same hue and the attribute stopped reading as a member. The check is
 * POSITIONAL rather than a Python special case, because "the right-hand side of a
 * dot is a member" holds in every language here, and a server that gets it right
 * simply never reaches this code (its token is already `property`).
 *
 * Two positions, both decided on the immediately adjacent non-space character:
 *
 *   prev is `.`  → member access. Excludes `?.` and `->` too, since both end in a
 *                  character that makes the name a member of something.
 *   next is `=`  → a keyword-argument LABEL (`f(name=name)`) or the left side of
 *      and prev    an assignment. Restricted to the case where the previous
 *      is `(`/`,`  character opens or separates an argument list, so a plain
 *                  `total = 0` statement is untouched — that IS a data binding.
 *                  `==` is excluded: `if name == x` is a comparison, not a label.
 */
function isMemberOrLabelPosition(text: string, offset: number, length: number): boolean {
  let p = offset - 1;
  while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) {
    p--;
  }
  const prev = p >= 0 ? text[p] : '';
  if (prev === '.') {
    return true;
  }

  let n = offset + length;
  while (n < text.length && (text[n] === ' ' || text[n] === '\t')) {
    n++;
  }
  if (text[n] !== '=' || text[n + 1] === '=') {
    return false;
  }
  // `name=` inside an argument list is a label; `name =` at statement level is a
  // binding. The opening `(` or a separating `,` is what distinguishes them.
  return prev === '(' || prev === ',';
}

/**
 * A `property`-typed token is normally band-1 (field access / key literal / a
 * field or member DEFINITION), NOT a data identity — that is why `TINTABLE_TYPES`
 * omits it. The one exception is OBJECT-SHORTHAND: in `{ name }` the token is a
 * genuine READ of the `name` binding, equivalent to `{ name: name }`. Servers
 * type it `property`, but it flows data and should tint like the variable it
 * refers to.
 *
 * Grounded in REAL semantic-token output from both TS (getEncodedSemantic-
 * Classifications) and gopls (`gopls semtok`):
 *   TS   `{ name }`            → property [declaration]            → shorthand ✓
 *   TS   `cfg.name`            → property [] (after `.`)           → field access ✗
 *   TS   `{ name: v }`         → property [declaration] (`:` next) → key literal ✗
 *   Go   struct field `Name`   → property [definition string]      → field DEF ✗
 *   Go   composite key `Name:` → property [string] (`:` next)      → key literal ✗
 *   Go   `cfg.Name`            → property [string] (after `.`)     → field access ✗
 *
 * So the rule is: a `property` token is a shorthand read when it is NOT preceded
 * by `.`, NOT followed by `:`, AND does NOT carry a `definition` modifier (Go
 * struct/field definitions carry `definition`; TS shorthand carries only
 * `declaration`, which is kept).
 */
function isShorthandPropertyRead(
  text: string,
  offset: number,
  length: number,
  modifiers: string[],
): boolean {
  // A field/member DEFINITION is band-1, never a data read (Go struct fields).
  if (modifiers.includes('definition')) {
    return false;
  }

  // previous non-whitespace char
  let p = offset - 1;
  while (p >= 0 && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n' || text[p] === '\r')) {
    p--;
  }
  const prev = p >= 0 ? text[p] : '';

  // next non-whitespace char
  let n = offset + length;
  while (n < text.length && (text[n] === ' ' || text[n] === '\t' || text[n] === '\n' || text[n] === '\r')) {
    n++;
  }
  const next = n < text.length ? text[n] : '';

  // A shorthand read sits INSIDE AN OBJECT LITERAL: opened by `{` or separated
  // by `,`, and terminated by `,` or `}`. Requiring both sides is what separates
  // it from a class/interface MEMBER DECLARATION, which TS reports with the same
  // `property [declaration]` token but never has that bracketing:
  //   `{ name }` / `{ name, x }`  → prev `{`/`,`  next `,`/`}`  → shorthand ✓
  //   `get summary(): string`     → prev `t`      next `(`      → declaration ✗
  //   `private seen = 0`          → prev `e`      next `=`      → declaration ✗
  //   `interface I { field: … }`  → prev `{`      next `:`      → key literal  ✗
  //   `cfg.name`                  → prev `.`                    → field access ✗
  return (prev === '{' || prev === ',') && (next === ',' || next === '}');
}

/**
 * this/self are keywords, so the semantic decoder and the heuristic occurrence
 * scan both skip them — leaving self names with no occurrence ranges to tint.
 * Lex them explicitly (in code, not strings/comments) and record file-wide
 * occurrences so the trace layer can clip them to the enclosing function like
 * any other name. Only word-shaped self names (this/self) are lexable here;
 * @-prefixed sigils are left to the caller's block use.
 */
function addSelfOccurrences(
  text: string,
  byName: Map<string, NameInfo>,
  occurrences: Map<string, OffsetRange[]>,
): void {
  const wanted = new Set<string>();
  for (const [name, info] of byName) {
    if (info.cls === 'self' && SELF_NAMES.has(name)) {
      wanted.add(name);
    }
  }
  if (wanted.size === 0) {
    return;
  }
  for (const id of lexIdentifiers(text)) {
    if (wanted.has(id.name)) {
      const range: OffsetRange = { start: id.offset, end: id.offset + id.length };
      const list = occurrences.get(id.name);
      if (list) {
        list.push(range);
      } else {
        occurrences.set(id.name, [range]);
      }
    }
  }
}

/**
 * PURE classifier driven by decoded semantic tokens. Builds file-wide
 * occurrences, then classifies every distinct name that is USED in the block.
 */
export function classifyFromSemantic(
  text: string,
  block: OffsetRange,
  enclosingFn: OffsetRange | undefined,
  fnRanges: OffsetRange[],
  tokens: DecodedToken[],
  docVersion: number,
  focusKey: string,
  // The colour scope: the OUTERMOST function whose palette this block shares.
  // Defaults to enclosingFn (innermost) when not supplied — callers that want
  // closure-stable hues pass the outermost function here.
  colorScopeFn: OffsetRange | undefined = enclosingFn,
  // The declaration region for block-local detection: the block PLUS its header
  // line, so loop/if header bindings (`for _, c := range xs {`) count as
  // block-local. Defaults to `block` when not supplied. Tint/trace ranges still
  // use `block` (body-scoped) — only classification widens.
  declRegion: OffsetRange = block,
  // Ranges of brace-blocks nested strictly INSIDE the focused block. A block
  // local whose declaration sits in one of these belongs to a child scope the
  // caret is above → lower attention priority (proximity 2).
  subBlocks: OffsetRange[] = [],
  // File-wide index, computed once per document version. Built on demand when
  // absent (keeps the pure signature usable standalone in tests).
  fileIndex: FileIndex = buildFileIndex(text, tokens, fnRanges),
  // Regions carved OUT of `block`. For the synthetic top-level scope (whole
  // file) these are the nested brace-blocks, so function-local names do not leak
  // into the top-level view.
  excludeRanges: OffsetRange[] = [],
): Classification {
  const { occurrences, declOffsets, firstFileOffset } = fileIndex;

  const byName = new Map<string, NameInfo>();

  // `excludeRanges` carves regions OUT of the block. Used for the synthetic
  // module top-level scope, whose range is the whole file: without carving out
  // the nested blocks, every local in every function would count as "used at
  // top level" and leak into the top-level view. With them carved out, the
  // top-level scope sees only genuinely top-level code.
  const inExcluded = (offset: number): boolean =>
    excludeRanges.some((r) => offset >= r.start && offset < r.end);

  // A name only counts as used-in-this-block if it has a TINTABLE occurrence
  // inside it. Lexing alone is not enough: `c.Name` is a field access (rejected
  // by the tintable gate), but `Name` may still be in the file-wide occurrence
  // map from a shorthand read elsewhere — without this check the field access
  // would inherit that eligibility and tint.
  const tintableInBlock = new Set<string>();
  for (const [name, ranges] of occurrences) {
    for (const r of ranges) {
      if (r.start >= block.start && r.end <= block.end && !inExcluded(r.start)) {
        tintableInBlock.add(name);
        break;
      }
    }
  }

  // Names used in the block, via the lexer (gives per-block frequency/order for
  // the names the tintable gate admitted).
  const blockIds = lexIdentifiers(text, block.start, block.end);
  const blockAgg = new Map<string, { freq: number; first: number }>();
  for (const id of blockIds) {
    if (inExcluded(id.offset)) {
      continue;
    }
    const agg = blockAgg.get(id.name);
    if (agg) {
      agg.freq++;
    } else {
      blockAgg.set(id.name, { freq: 1, first: id.offset });
    }
  }

  for (const [name, agg] of blockAgg) {
    if (isSelfName(name)) {
      byName.set(name, {
        cls: 'self',
        freqInBlock: agg.freq,
        firstFileOffset: firstFileOffset.get(name) ?? agg.first,
        firstBlockOffset: agg.first,
        isCapture: false,
        proximity: 1,
      });
      continue;
    }
    // `_` is a discard (Go/Python blank identifier) or a module facade (lodash)
    // — either way it is not a data identity and must not compete for a hue.
    if (name === '_') {
      continue;
    }
    // Only names with a tintable occurrence IN THIS BLOCK proceed. (File-wide
    // eligibility is not enough — see tintableInBlock above.)
    if (!tintableInBlock.has(name)) {
      continue; // keyword, field access, string content, non-tintable → neutral
    }

    const decls = declOffsets.get(name) ?? [];
    // Block-local if declared in the block body OR its header (loop/if binding).
    const declInBlock = decls.some((o) => inRange(o, declRegion));
    const declInFn = enclosingFn ? decls.some((o) => inRange(o, enclosingFn) && !inRange(o, declRegion)) : false;

    let cls: Cls;
    let isCapture = false;
    let homeFn: OffsetRange | undefined;

    if (declInBlock) {
      cls = 'block';
    } else if (declInFn) {
      cls = 'fn';
    } else {
      cls = 'out';
      // Capture vs true global: does a declaration sit inside SOME other function?
      const declFn = decls
        .map((o) => enclosingFnOf(fnRanges, o))
        .find((r) => r && !(enclosingFn && r.start === enclosingFn.start && r.end === enclosingFn.end));
      if (declFn) {
        isCapture = true;
        homeFn = declFn;
      }
    }

    // Attention proximity: a block-local declared inside a NESTED sub-block is a
    // child scope the caret sits above (proximity 2). A direct block-local is
    // proximity 0 (the focused block's own data). Everything borrowed in
    // (fn-local, capture, global) is proximity 1.
    let proximity: 0 | 1 | 2 = 1;
    if (cls === 'block') {
      const declInSub = decls.some((o) => subBlocks.some((sb) => inRange(o, sb)));
      proximity = declInSub ? 2 : 0;
    } else if (cls === 'fn') {
      // A PARAMETER of the focused function is that function's own data, not
      // something borrowed from an outer scope. Its declaration sits in the
      // block's header — inside `block` (header-inclusive) but outside
      // `declRegion` (body-only for functions, so params stay fn-scoped and trace
      // across nested closures). Leaving it at proximity 1 let nested sub-scope
      // locals fill the budget ahead of it, so focusing a function body showed
      // closure internals while the function's own argument stayed neutral.
      const declInOwnHeader = decls.some((o) => inRange(o, block) && !inRange(o, declRegion));
      if (declInOwnHeader) {
        proximity = 0;
      }
    }

    byName.set(name, {
      cls,
      freqInBlock: agg.freq,
      firstFileOffset: firstFileOffset.get(name) ?? agg.first,
      firstBlockOffset: agg.first,
      isCapture,
      homeFn,
      proximity,
    });
  }

  // fileGlobalsInOrder + self occurrences come from the shared file index — no
  // per-block whole-file rescan. Local ordering is per COLOUR SCOPE, so every
  // closure inside it shares one first-appearance order.
  const { locals: fnLocalsInOrder, globals: fnGlobals } = computeFnLocals(
    occurrences,
    declOffsets,
    fnRanges,
    colorScopeFn,
  );
  return {
    docVersion,
    focusKey,
    byName,
    occurrences,
    fileGlobalsInOrder: fileIndex.fileGlobalsInOrder,
    fnLocalsInOrder,
    fnGlobals,
    colorScopeFn,
    enclosingFn,
    shadowScopes: fileIndex.shadowScopes,
    source: 'lsp',
  };
}

/**
 * PURE heuristic classifier — no LSP. Detects declarations by keyword patterns
 * over the lexer stream, resolves occurrences lexically. Language-approximate
 * but synchronous; the correct fallback when no semantic-tokens provider exists.
 */
export function classifyFromHeuristic(
  text: string,
  block: OffsetRange,
  enclosingFn: OffsetRange | undefined,
  fnRanges: OffsetRange[],
  docVersion: number,
  focusKey: string,
  colorScopeFn: OffsetRange | undefined = enclosingFn,
  declRegion: OffsetRange = block,
  subBlocks: OffsetRange[] = [],
): Classification {
  const allIds = lexIdentifiers(text);

  // File-wide occurrences of non-keyword identifiers.
  const occurrences = new Map<string, OffsetRange[]>();
  const firstFileOffset = new Map<string, number>();
  for (const id of allIds) {
    if (HEURISTIC_KEYWORDS.has(id.name) || isSelfName(id.name)) {
      continue;
    }
    const range: OffsetRange = { start: id.offset, end: id.offset + id.length };
    const list = occurrences.get(id.name);
    if (list) {
      list.push(range);
    } else {
      occurrences.set(id.name, [range]);
      firstFileOffset.set(id.name, id.offset);
    }
  }

  // Declaration offsets: an identifier immediately preceded by a decl keyword,
  // or appearing in a parameter-ish position. We approximate params as any
  // identifier on the enclosing function's header line handled generically —
  // here we only catch `<declKw> name`, which covers the common cases.
  const declOffsets = new Map<string, number[]>();
  for (let i = 0; i < allIds.length; i++) {
    const id = allIds[i];
    const prev = i > 0 ? allIds[i - 1] : undefined;
    if (prev && DECL_KEYWORDS.has(prev.name) && !HEURISTIC_KEYWORDS.has(id.name)) {
      const d = declOffsets.get(id.name);
      if (d) {
        d.push(id.offset);
      } else {
        declOffsets.set(id.name, [id.offset]);
      }
    }
  }

  const blockIds = lexIdentifiers(text, block.start, block.end);
  const blockAgg = new Map<string, { freq: number; first: number }>();
  for (const id of blockIds) {
    // this/self are keywords but must reach the self-class check below, so let
    // them through the keyword filter.
    if (HEURISTIC_KEYWORDS.has(id.name) && !isSelfName(id.name)) {
      continue;
    }
    const agg = blockAgg.get(id.name);
    if (agg) {
      agg.freq++;
    } else {
      blockAgg.set(id.name, { freq: 1, first: id.offset });
    }
  }

  const byName = new Map<string, NameInfo>();
  for (const [name, agg] of blockAgg) {
    if (isSelfName(name)) {
      byName.set(name, {
        cls: 'self',
        freqInBlock: agg.freq,
        firstFileOffset: agg.first,
        firstBlockOffset: agg.first,
        isCapture: false,
        proximity: 1,
      });
      continue;
    }
    // discard / blank identifier — not a data identity (see semantic path).
    if (name === '_') {
      continue;
    }
    if (!occurrences.has(name)) {
      continue;
    }
    const decls = declOffsets.get(name) ?? [];
    const declInBlock = decls.some((o) => inRange(o, declRegion));
    const declInFn = enclosingFn ? decls.some((o) => inRange(o, enclosingFn) && !inRange(o, declRegion)) : false;

    let cls: Cls;
    let isCapture = false;
    let homeFn: OffsetRange | undefined;
    if (declInBlock) {
      cls = 'block';
    } else if (declInFn) {
      cls = 'fn';
    } else {
      cls = 'out';
      const declFn = decls
        .map((o) => enclosingFnOf(fnRanges, o))
        .find((r) => r && !(enclosingFn && r.start === enclosingFn.start && r.end === enclosingFn.end));
      if (declFn) {
        isCapture = true;
        homeFn = declFn;
      }
    }

    let proximity: 0 | 1 | 2 = 1;
    if (cls === 'block') {
      const declInSub = decls.some((o) => subBlocks.some((sb) => inRange(o, sb)));
      proximity = declInSub ? 2 : 0;
    }

    byName.set(name, {
      cls,
      freqInBlock: agg.freq,
      firstFileOffset: firstFileOffset.get(name) ?? agg.first,
      firstBlockOffset: agg.first,
      isCapture,
      homeFn,
      proximity,
    });
  }

  addSelfOccurrences(text, byName, occurrences);
  const fileGlobalsInOrder = computeFileGlobals(occurrences, declOffsets, fnRanges);
  const { locals: fnLocalsInOrder, globals: fnGlobals } = computeFnLocals(
    occurrences,
    declOffsets,
    fnRanges,
    colorScopeFn,
  );
  return {
    docVersion,
    focusKey,
    byName,
    occurrences,
    fileGlobalsInOrder,
    fnLocalsInOrder,
    fnGlobals,
    colorScopeFn,
    enclosingFn,
    shadowScopes: computeShadowScopes(declOffsets, fnRanges),
    source: 'heuristic',
  };
}
