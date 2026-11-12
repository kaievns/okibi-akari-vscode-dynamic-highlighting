/**
 * Band-2 classification — spec §5.4 and the "how far you must look to find
 * where a name is bound" rule.
 *
 *   block-local — declared inside the focused block.
 *   fn-local    — declared in the enclosing function (incl. params) but outside
 *                 the block: "borrowed in". Rendered --id-*, normal weight.
 *   out-of-fn   — module globals, captures, or names with no visible
 *                 declaration. Globals render in the same --id-* hex, bold;
 *                 captures at normal weight.
 *   self        — this / self / @-prefixed. Band 1's keyword colour, never a variable.
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

import { LexId, LexResult, bangCalls, blankGap, commaGap, jsxTags, lexFor } from './lex';
import { MODULE_OPEN, REGION_MARK, viewRegions } from './html';
import { jsNamespaceNames, pyImportOffsets } from './imports';
import { BraceBlock, functionScopeOf, inSortedRanges, isPatternBrace, scanBlocks, scopeRegionFor, typeArrowsOf } from './focus';
import { IntervalIndex, bestAt, buildIntervalIndex } from './intervals';
import { rustInlineArgs } from './placeholders';
import { LUA_KEYWORDS, LUA_STD, luaCallee, luaFacts } from './lua';
import { rubyFacts, rubyTokens } from './ruby';
import { isZigReserved, isZigTypeName, zigFacts } from './zig';

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
  /** Declared at the top level of a module block (an Astro client script) and seen from below it: a global there. */
  moduleTop?: boolean;
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
   * appearance. Block-independent by construction.
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
   * The colour scope — the OUTERMOST function containing the caret, so a
   * variable's hue is stable across the whole top-level function and every
   * nested closure.
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
  /** Offsets of binding declarations file-wide (see FileIndex.declSites). Escape risk skips them. */
  declSites: Set<number>;
  /** Rust `static` items (not tintable, so absent from byName); a write to one escapes. */
  staticNames: Set<string>;
  /** Regions carved out of the block, sorted and merged (the top-level scope's nested bodies). */
  excludeRanges: OffsetRange[];
  source: ClassSource;
}

/** this / self are never data identities; @-prefixed handled by the caller. */
const SELF_NAMES = new Set(['this', 'self']);

/**
 * Node's module-scope names and process globals. @types/node declares them in no
 * default library, so tsserver types `process` and `module` plain `variable` where
 * `window` carries `defaultLibrary`. Library surface unless the file declares them.
 */
const JS_MODULE_SURFACE = new Set(['module', 'exports', 'require', 'process', 'Buffer', 'global', '__dirname', '__filename']);

/** JS / TS names that are never data in this file: the module surface it does not declare, and its `import * as` namespaces. */
function jsNonData(lx: LexResult, tokens: readonly DecodedToken[], languageId?: string): Set<string> {
  const declared = new Set<string>();
  const surface = languageId === 'astro' ? ASTRO_SURFACE : JS_MODULE_SURFACE;
  for (const t of tokens) {
    if (surface.has(t.name) && t.modifiers.includes('declaration')) declared.add(t.name);
  }
  const out = new Set(jsNamespaceNames(lx));
  for (const name of surface) if (!declared.has(name)) out.add(name);
  for (const name of jsxComponentNames(lx)) out.add(name);
  return out;
}

/** Astro's frontmatter global joins Node's module surface. */
const ASTRO_SURFACE = new Set([...JS_MODULE_SURFACE, 'Astro']);

/**
 * The components a JSX tag names: a capitalised tag, or the capitalised root of a
 * member tag (`<UI.Button>`). A component is a function or a class, not data, wherever
 * the file names it. A lowercase root (`<item.Icon>`) is an object and stays data.
 */
export function jsxComponentNames(lx: LexResult): Set<string> {
  const out = new Set<string>();
  const text = lx.text;
  for (const t of jsxTags(lx)) {
    const c = text.charCodeAt(t.offset - 1);
    if (c === 0x2e || c === 0x3a || c === 0x2d) continue;
    if (/^[A-Z]/.test(t.name)) out.add(t.name);
  }
  return out;
}

/**
 * The names a component's pattern regions bind: an each alias, `v-for`'s alias, a
 * slot's props, a snippet's parameters (src/sfc.ts). A key (`{ a: b }` binds `b`), a
 * default's value and a type annotation bind nothing.
 */
function patternDeclarations(lx: LexResult, declare: (id: LexId) => void): void {
  const text = lx.text;
  for (const r of viewRegions(text)) {
    if (r.kind !== 'pattern') continue;
    const opens: string[] = [];
    // The bracket depth of the `=` or `:` that opened a default value or a type annotation; it ends at a `,` or bracket there.
    let skipFrom = -1;
    let k = 0;
    const ids = lx.identsIn(r.start, r.end);
    for (let i = r.start; i < r.end && k < ids.length; i++) {
      if (i === ids[k].offset) {
        const id = ids[k++];
        i += id.length - 1;
        const n = nextNonBlank(text, id.offset + id.length);
        const p = lx.prevSignificant(id.offset);
        const inBrace = opens[opens.length - 1] === '{';
        const member = text[p] === '.' && text[p - 1] !== '.';
        if (skipFrom >= 0 || text[n] === '(' || text[n] === '.' || (text[n] === ':' && inBrace) || member) continue;
        declare(id);
        continue;
      }
      if (!lx.isCode(i)) continue;
      const c = text[i];
      if (c === '(' || c === '[' || c === '{') opens.push(c);
      else if (c === ')' || c === ']' || c === '}') {
        opens.pop();
        if (opens.length < skipFrom) skipFrom = -1;
      } else if (c === ',') {
        if (opens.length <= skipFrom) skipFrom = -1;
      } else if (skipFrom < 0 && ((c === '=' && text[i + 1] !== '>') || (c === ':' && opens[opens.length - 1] !== '{'))) skipFrom = opens.length;
    }
  }
}

const nextNonBlank = (text: string, i: number): number => {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  return i;
};

/**
 * File-wide analysis, computed ONCE per document version and shared by every
 * block classified in that version.
 *
 * Without this, each per-block classify redid the whole-file token scan, the
 * whole-file self-occurrence lex, and the file-globals computation — so
 * classifying an N-block scope was N× the file-wide work. The per-block pass now
 * reads its identifiers as a binary-searched slice of `lex`.
 */
export interface FileIndex {
  /** The version's shared lex; per-block identifier queries slice it. */
  lex: LexResult;
  /** Tintable occurrence ranges per name, file-wide (insertion order = first appearance), each list sorted by start. */
  occurrences: Map<string, OffsetRange[]>;
  /** Declaration offsets per name (shorthand reads excluded — they declare a property, not a binding). */
  declOffsets: Map<string, number[]>;
  /** Every offset in `declOffsets`, for O(1) "is this occurrence a declaration" checks. */
  declSites: Set<number>;
  /** Names the server types `static` (rust-analyzer statics). */
  staticNames: Set<string>;
  /** First file offset per name. */
  firstFileOffset: Map<string, number>;
  /** Names whose every declaration is outside any function → true globals, file order. */
  fileGlobalsInOrder: string[];
  /**
   * Reads inside a string span, in offset order: Rust inline format args (`{label}`
   * in `write!`), typed by the server or lexed. The lexer's identifiers skip
   * strings, so the per-block use count adds these.
   */
  stringReads: LexId[];
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
    const seen = new Set<OffsetRange>();
    for (const o of offsets) {
      const fn = enclosingFnOf(fnRanges, o);
      // enclosingFnOf returns one object per distinct range, so identity is equality.
      if (fn && !seen.has(fn)) {
        seen.add(fn);
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
function pyClassFieldRanges(text: string, lx: LexResult): OffsetRange[] {
  const ranges: OffsetRange[] = [];
  const lines = text.split('\n');
  const starts: number[] = [0];
  for (let i = 0; i < lines.length - 1; i++) {
    starts.push(starts[i] + lines[i].length + 1);
  }
  const indentOf = (s: string): number => (/^([ \t]*)/.exec(s)?.[1].length ?? 0);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let k = 0;
    while (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9) k++;
    const m = line.startsWith('class', k) ? /^([ \t]*)class\b[^\n]*:\s*(#.*)?$/.exec(line) : null;
    if (!m || !lx.isCode(starts[i] + m[1].length)) {
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
      const fieldName = /^[ \t]*[A-Za-z_]\w*[ \t]*(:|=)/.exec(raw);
      if (fieldName && lx.isCode(starts[j] + fieldName[0].length - 1)) {
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
 * or `interface` keyword in DECLARATION shape to the end of its declaration — the
 * matching close of the first bracket if one opens before the line ends, else end
 * of line. Go's `type ( … )` grouped block is covered by the bracket case. A
 * variable named `type` (`type = event.get(…)`) does not have the shape.
 */
const TYPE_DECL =
  /(^|\n)([ \t]*(?:(?:export|declare|pub(?:\([^)\n]*\))?|public|private|protected|internal|abstract|sealed|static)[ \t]+)*)(?:type[ \t]+[\p{ID_Start}_$][\p{ID_Continue}$]*[ \t]*(?:[<[=*(]|[\p{ID_Start}_])|type[ \t]*\([ \t]*(?:\/\/[^\n]*)?(?=\n)|interface[ \t]+[\p{ID_Start}_$])/gu;

function typeDeclRanges(text: string, lx: LexResult): OffsetRange[] {
  const ranges: OffsetRange[] = lx.syntax.family === 'python' ? pyClassFieldRanges(text, lx) : [];
  const P = lx.punct;
  let m: RegExpExecArray | null;
  TYPE_DECL.lastIndex = 0;
  while ((m = TYPE_DECL.exec(text)) !== null) {
    const start = m.index + m[1].length;
    if (!lx.isCode(start + m[2].length)) {
      continue;
    }
    const lineEnd = text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start);
    // Does a code bracket open on this line? If so the declaration runs to its match.
    let end = lineEnd;
    let k = lx.punctFrom(start);
    while (k < P.length && P[k] < lineEnd && text[P[k]] !== '{' && text[P[k]] !== '(') {
      k++;
    }
    if (k < P.length && P[k] < lineEnd) {
      const opener = text[P[k]];
      const closer = opener === '{' ? '}' : ')';
      let depth = 0;
      for (; k < P.length; k++) {
        const c = text[P[k]];
        if (c === opener) {
          depth++;
        } else if (c === closer) {
          depth--;
          if (depth === 0) {
            end = P[k] + 1;
            break;
          }
        }
      }
    }
    ranges.push({ start, end });
    TYPE_DECL.lastIndex = end; // skip past — no nested type decls to find inside
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
  languageId?: string,
): FileIndex {
  const lx = lexFor(text, languageId);
  const occurrences = new Map<string, OffsetRange[]>();
  const declOffsets = new Map<string, number[]>();
  const firstFileOffset = new Map<string, number>();
  // Type declarations, in offset order. Tokens are too — the LSP wire format is
  // DELTA-encoded (Δline, Δchar, …), so ascending offset is guaranteed by the
  // protocol, not by luck. That lets a single advancing cursor decide containment
  // in O(tokens + ranges) instead of a `.some()` scan per token, which cost ~5ms
  // on a 100KB file.
  const typeDecls = typeDeclRanges(text, lx);
  let td = 0;
  const typeParams = mergeRanges(typeArrowsOf(lx, languageId).params);
  let tp = 0;
  const declSites = new Set<number>();
  const staticNames = new Set<string>();
  const stringReads: LexId[] = [];
  const pyRebinding = lx.syntax.family === 'python' ? pythonRebindingFilter(lx) : undefined;
  const lua = lx.syntax.family === 'lua' ? luaFacts(lx) : undefined;
  const jsSurface = lx.syntax.family === 'js' ? jsNonData(lx, tokens, languageId) : undefined;
  // A Svelte or Astro `<C {open}>` or value-less `bind:open` is the region alone: the servers type it `property`.
  const shorthandRegions = languageId === 'svelte' || languageId === 'astro';
  // ruby-lsp types reads only; declarations and writes come from the bindings (docs/ruby.md).
  if (lx.syntax.family === 'ruby') tokens = rubyTokens(lx, tokens);

  for (const tok of tokens) {
    // gopls types `[Name]` doc links inside `//` comments as plain variables, so the
    // lexer's comment spans are the check; the modifiers cover rust-analyzer. Not
    // `!isCode`: Rust inline format args (`{x}` in `println!`) sit in a string span
    // and are real reads.
    const region = lx.regionAt(tok.offset);
    if (region === 'comment' || region === 'doc' || tok.modifiers.some((m) => COMMENT_MODIFIERS.has(m))) {
      continue;
    }
    if (tok.type === 'static') {
      staticNames.add(tok.name);
    }
    // Parameter names in a type signature are documentation, not data.
    while (td < typeDecls.length && typeDecls[td].end <= tok.offset) {
      td++;
    }
    if (td < typeDecls.length && tok.offset >= typeDecls[td].start) {
      continue;
    }
    while (tp < typeParams.length && typeParams[tp].end <= tok.offset) {
      tp++;
    }
    if (tp < typeParams.length && tok.offset >= typeParams[tp].start) {
      continue;
    }
    // Data identities are variable/parameter. `property` is normally band-1, but
    // object-shorthand (`{ name }`) is a real read of a binding and tints like it.
    const tintable =
      TINTABLE_TYPES.has(tok.type) ||
      (tok.type === 'property' && lx.syntax.family !== 'zig' && isShorthandPropertyRead(text, tok.offset, tok.length, tok.modifiers, shorthandRegions));
    if (!tintable) {
      continue;
    }
    // `self` / `this` are lexed separately below; band 1 paints them. Outside a
    // cargo workspace rust-analyzer types a `self` USE as tintable `const`.
    if (isSelfName(tok.name, lx.syntax.family) || jsSurface?.has(tok.name)) {
      continue;
    }
    // Builtins (console, Math…) are library surface, not this file's data.
    if (tok.modifiers.some((m) => NON_DATA_MODIFIERS.has(m))) {
      continue;
    }
    // A name in MEMBER or KEYWORD-ARGUMENT position is not a data identity, even
    // when the server types it `variable`.
    if (isMemberOrLabelPosition(lx, tok.offset, tok.length, tok.modifiers)) {
      continue;
    }
    // Modules, local functions and namespace globals are not data whatever the
    // server types them; members, keys and labels have no binding (docs/lua.md).
    if (lua) {
      const b = lua.binding.get(tok.offset);
      if (b === undefined || (b >= 0 ? lua.modules.has(b) || lua.functionSites.has(b) : lua.namespaces.has(tok.name))) {
        continue;
      }
    }
    const range: OffsetRange = { start: tok.offset, end: tok.offset + tok.length };
    const list = occurrences.get(tok.name);
    if (list) {
      list.push(range);
    } else {
      occurrences.set(tok.name, [range]);
      firstFileOffset.set(tok.name, tok.offset);
    }
    if (region === 'string') {
      stringReads.push({ name: tok.name, offset: tok.offset, length: tok.length });
    }
    // A shorthand-read (`{ name }`) carries a `declaration` modifier because it
    // syntactically declares the object PROPERTY — but it READS the variable, it
    // does not declare it. Counting it as a declaration would (wrongly) make the
    // variable block-local to whatever object literal it appears in, dropping it
    // to neutral. So never treat a shorthand read as a binding declaration.
    const isShorthand = tok.type === 'property';
    // lua-language-server leaves `declaration` off `<const>` and `<close>` locals.
    const declared = tok.modifiers.some((m) => DECL_MODIFIERS.has(m))
      || (lua !== undefined && (lua.declSites.has(tok.offset) || lua.globalSites.has(tok.offset)));
    if (!isShorthand && declared && !pyRebinding?.(tok.name, tok.offset)) {
      const d = declOffsets.get(tok.name);
      if (d) {
        d.push(tok.offset);
      } else {
        declOffsets.set(tok.name, [tok.offset]);
      }
      declSites.add(tok.offset);
    }
  }

  // self names are keywords the token stream skips; lex them once here so the
  // trace layer has ranges for them (band 1 paints them, but escape-risk needs
  // the classification).
  const selfWanted = new Set<string>();
  for (const name of SELF_NAMES) {
    if (isSelfName(name, lx.syntax.family)) selfWanted.add(name);
  }
  for (const id of lx.idents) {
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

  // Macro arguments carry no tokens where rust-analyzer does not expand the macro (a
  // detached file, a workspace still loading); a loaded workspace types them with
  // modifier `macro`. So the lexer fills in only positions with no token, and only
  // for names a token already made data identities.
  // docs/classification-rules.md#classification-classes.
  let typed = 0;
  for (const region of lx.syntax.family === 'rust' ? macroArgRanges(text, lx) : []) {
    for (const id of lx.identsIn(region.start, region.end)) {
      while (typed < tokens.length && tokens[typed].offset < id.offset) {
        typed++;
      }
      if (typed < tokens.length && tokens[typed].offset === id.offset) {
        continue;
      }
      if (!occurrences.has(id.name) || isSelfName(id.name)) {
        continue; // only extend a KNOWN binding; never mint one from a macro arg
      }
      if (isMemberOrLabelPosition(lx, id.offset, id.length)) {
        continue; // `cfg.name` — the member is band-1, the receiver `cfg` is not
      }
      occurrences.get(id.name)!.push({ start: id.offset, end: id.offset + id.length });
    }
  }
  // Inline format args, by the same rail: rust-analyzer types `{label}` only once it
  // expands the macro, which a detached file and a workspace still loading never do.
  if (lx.syntax.family === 'rust') {
    const typed = new Set(stringReads.map((r) => r.offset));
    for (const arg of rustInlineArgs(text)) {
      const list = occurrences.get(arg.name);
      if (list && !typed.has(arg.offset) && !isSelfName(arg.name)) {
        list.push({ start: arg.offset, end: arg.offset + arg.length });
        stringReads.push(arg);
      }
    }
    stringReads.sort((a, b) => a.offset - b.offset);
  }
  // The occurrence lists per name are no longer in offset order after the macro
  // pass appended to them. classifyFromSemantic binary-searches them, so restore it.
  for (const ranges of occurrences.values()) {
    ranges.sort((a, b) => a.start - b.start);
  }

  const fileGlobalsInOrder = computeFileGlobals(occurrences, declOffsets, fnRanges);
  const shadowScopes = computeShadowScopes(declOffsets, fnRanges);
  return { lex: lx, occurrences, declOffsets, declSites, staticNames, firstFileOffset, fileGlobalsInOrder, stringReads, shadowScopes };
}

/** A Python `def` or `class` suite, by its header line. */
export interface PyScope {
  line: number;
  name: string;
  kind: 'def' | 'class';
}

interface PyScopeTable {
  /** Per line: the innermost suite containing it; a header line maps to its parent. */
  byLine: (PyScope | null)[];
  /** Header line → offset just past `def` / `class`; code after it is inside the suite. */
  headerAt: Map<number, { after: number; scope: PyScope }>;
}

const pyScopeTables = new WeakMap<LexResult, PyScopeTable>();

/**
 * The innermost Python `def` / `class` whose suite contains `offset`, by
 * indentation, else null (module level). Lexical, so it needs no symbol provider.
 * Blank, comment, docstring and bracket- or backslash-continued lines stay in the
 * current suite; a signature's parameters belong to its def.
 */
export function pyScopeAt(lx: LexResult, offset: number): PyScope | null {
  let table = pyScopeTables.get(lx);
  if (!table) {
    table = buildPyScopeTable(lx);
    pyScopeTables.set(lx, table);
  }
  const line = lx.lineOf(offset);
  const header = table.headerAt.get(line);
  if (header && offset >= header.after) {
    return header.scope;
  }
  return table.byLine[line] ?? null;
}

function buildPyScopeTable(lx: LexResult): PyScopeTable {
  const text = lx.text;
  const byLine: (PyScope | null)[] = [];
  const headerAt = new Map<number, { after: number; scope: PyScope }>();
  const stack: { indent: number; scope: PyScope }[] = [];
  const top = (): PyScope | null => (stack.length > 0 ? stack[stack.length - 1].scope : null);
  for (let l = 0; l < lx.lineStarts.length; l++) {
    const s = lx.lineStarts[l];
    let i = s;
    while (text[i] === ' ' || text[i] === '\t') i++;
    const blank = i >= text.length || text[i] === '\n' || text[i] === '\r' || text[i] === '#';
    const nl = s - 1;
    const bs = text[nl - 1] === '\r' ? nl - 2 : nl - 1;
    const continued = l > 0 && text[bs] === '\\' && lx.isCode(bs);
    if (blank || !lx.isCode(i) || continued || lx.enclosingOpen(i) >= 0) {
      byLine.push(top());
      continue;
    }
    const indent = i - s;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    byLine.push(top());
    const c = text.charCodeAt(i);
    const m = (c === 97 || c === 99 || c === 100) && (text.startsWith('def', i) || text.startsWith('class', i) || text.startsWith('async', i))
      ? /^((?:async[ \t]+)?(def|class))[ \t]+([\p{ID_Start}_][\p{ID_Continue}]*)/u.exec(text.slice(i, i + 160))
      : null;
    if (m) {
      const scope: PyScope = { line: l, name: m[3], kind: m[2] as 'def' | 'class' };
      headerAt.set(l, { after: i + m[1].length, scope });
      stack.push({ indent, scope });
    }
  }
  return { byLine, headerAt };
}

/**
 * Python has no block scope: every assignment binds the function's one variable,
 * and Pylance may tag each store `declaration`. Only the first depth-0 binding per
 * def / class suite counts; later ones are writes. Bindings inside brackets
 * (parameters, comprehension targets, lambda params) always count. A name listed
 * in the suite's `global` / `nonlocal` statement is never declared there.
 * Returns a predicate that is true for a declaration token to DROP.
 */
function pythonRebindingFilter(lx: LexResult): (name: string, offset: number) => boolean {
  const keyOf = (offset: number): number => {
    const scope = pyScopeAt(lx, offset);
    return scope ? scope.line : -1;
  };
  const outer = new Map<number, Set<string>>();
  const ids = lx.idents;
  for (let k = 0; k < ids.length; k++) {
    if (ids[k].name !== 'global' && ids[k].name !== 'nonlocal') {
      continue;
    }
    const key = keyOf(ids[k].offset);
    const names = outer.get(key) ?? new Set<string>();
    outer.set(key, names);
    let end = ids[k].offset + ids[k].length;
    for (let j = k + 1; j < ids.length; j++) {
      if (!(j === k + 1 ? blankGap(lx.text, end, ids[j].offset) : commaGap(lx.text, end, ids[j].offset, true))) {
        break;
      }
      names.add(ids[j].name);
      end = ids[j].offset + ids[j].length;
    }
  }
  const seen = new Map<number, Set<string>>();
  return (name: string, offset: number): boolean => {
    const key = keyOf(offset);
    if (outer.get(key)?.has(name)) {
      return true;
    }
    let names = seen.get(key);
    if (!names) {
      names = new Set<string>();
      seen.set(key, names);
    }
    if (lx.enclosingOpen(offset) >= 0) {
      names.add(name);
      return false;
    }
    if (names.has(name)) {
      return true;
    }
    names.add(name);
    return false;
  };
}

/** Words that open a Python compound statement; code after its `:` on the same line is an inline suite. */
const PY_COMPOUND = new Set(['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'def', 'class', 'async', 'match', 'case']);

interface PySuites {
  /** Is `later` inside the suite that holds the statement at `earlier`? */
  encloses(earlier: number, later: number): boolean;
}

const pySuiteTables = new WeakMap<LexResult, PySuites>();

/**
 * Suite extents by indentation. A logical line's suite runs until the first later
 * logical line indented less; blank, comment and continuation lines carry no
 * indentation. A store after a compound header's `:` on the same line
 * (`else: x = 2`) sits in an inline suite of that line alone.
 */
export function pySuiteTable(lx: LexResult): PySuites {
  const cached = pySuiteTables.get(lx);
  if (cached) {
    return cached;
  }
  const text = lx.text;
  const n = lx.lineStarts.length;
  const head = new Int32Array(n);
  const dedent = new Int32Array(n).fill(n);
  const stack: { line: number; indent: number }[] = [];
  let last = 0;
  for (let l = 0; l < n; l++) {
    const s = lx.lineStarts[l];
    let i = s;
    while (text[i] === ' ' || text[i] === '\t') i++;
    const blank = i >= text.length || text[i] === '\n' || text[i] === '\r' || text[i] === '#';
    const nl = s - 1;
    const bs = text[nl - 1] === '\r' ? nl - 2 : nl - 1;
    const continued = l > 0 && text[bs] === '\\' && lx.isCode(bs);
    if (blank || !lx.isCode(i) || continued || lx.enclosingOpen(i) >= 0) {
      head[l] = last;
      continue;
    }
    const indent = i - s;
    while (stack.length > 0 && stack[stack.length - 1].indent > indent) {
      dedent[stack.pop()!.line] = l;
    }
    stack.push({ line: l, indent });
    head[l] = last = l;
  }
  const inlineColon = new Map<number, number>();
  const inlineAfter = (line: number): number => {
    let at = inlineColon.get(line);
    if (at === undefined) {
      at = -1;
      const start = lx.lineStarts[line];
      const first = lx.identsIn(start, start + 400)[0];
      if (first && PY_COMPOUND.has(first.name) && text.slice(start, first.offset).trim() === '') {
        let next = line + 1;
        while (next < n && head[next] === line) next++;
        const end = next < n ? lx.lineStarts[next] : text.length;
        const P = lx.punct;
        let depth = 0;
        for (let k = lx.punctFrom(first.offset); k < P.length && P[k] < end; k++) {
          const c = text[P[k]];
          if (c === '(' || c === '[' || c === '{') depth++;
          else if (c === ')' || c === ']' || c === '}') depth--;
          else if (c === ':' && depth === 0) {
            at = P[k];
            break;
          }
        }
      }
      inlineColon.set(line, at);
    }
    return at;
  };
  const table: PySuites = {
    encloses(earlier: number, later: number): boolean {
      const ls = head[lx.lineOf(earlier)];
      const lo = head[lx.lineOf(later)];
      if (lo < ls) {
        return false;
      }
      const colon = inlineAfter(ls);
      if (colon >= 0 && earlier > colon) {
        return lo === ls && later > earlier;
      }
      return dedent[ls] > lo;
    },
  };
  pySuiteTables.set(lx, table);
  return table;
}

/**
 * Argument regions of Rust MACRO calls: the span inside the `(`, `[` or `{` that
 * follows a code `name!`. Returns `[start, end)` offsets of the interior, excluding
 * the brackets themselves.
 *
 * The delimiter can be any of the three bracket kinds (`vec![…]`, `println!(…)`,
 * `quote!{…}`), and the match walks the lexer's code punctuation, so a `)` inside
 * a format string, char literal or comment does not close the span early.
 *
 * Language-neutral callers pass any text; only Rust source contains `name!`
 * followed by a bracket, so on other languages this simply finds nothing.
 */
function macroArgRanges(text: string, lx: LexResult): OffsetRange[] {
  const out: OffsetRange[] = [];
  const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const P = lx.punct;
  let resume = 0;
  for (const m of bangCalls(text)) {
    if (m.index < resume) {
      continue;
    }
    const open = m.open;
    resume = open + 1;
    if (!lx.isCode(m.index) || !lx.isCode(open)) {
      continue;
    }
    const closer = CLOSER[text[open]];
    let depth = 0;
    let close = -1;
    for (let k = lx.punctFrom(open); k < P.length; k++) {
      const c = text[P[k]];
      if (c === '(' || c === '[' || c === '{') {
        depth++;
      } else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) {
          close = P[k]; // matched the macro's own closer
          break;
        }
      }
    }
    if (close >= 0 && text[close] === closer) {
      out.push({ start: open + 1, end: close });
      resume = close + 1; // resume after the span; nested macro args are already inside it
    }
  }
  return out;
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
// attributes carry it with no dot at all. `keywordArgument` is Pylance's mark on a
// kwarg label (`f(name=…)`).
const NON_DATA_MODIFIERS = new Set([
  'defaultLibrary', 'signature', 'classMember', 'dynamicAttribute', 'keywordArgument',
]);

const DECL_MODIFIERS = new Set(['declaration', 'definition']);

/**
 * Modifiers a server puts on tokens it found inside a comment: rust-analyzer's
 * doctest code (`injected`), doc text (`documentation`) and `[Foo]` links
 * (`intraDocLink`). A comment is prose, so none of these is a data occurrence.
 */
const COMMENT_MODIFIERS = new Set(['injected', 'documentation', 'intraDocLink']);

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
  // palette's few slots. `self` is handled separately (isSelfName), `cls`
  // is skipped by the heuristic candidate check, and the words this list shares
  // with JS (`class`, `return`, `if`, …) are already above.
  'lambda', 'def', 'elif', 'pass', 'raise', 'except', 'with', 'global', 'nonlocal',
  'assert', 'del', 'None', 'True', 'False', 'and', 'or', 'not', 'match',
  // Rust. Same failure mode as `lambda` above, at a much larger scale: only `let`
  // was already here, so `fn`, `mut`, `impl`, `pub` and `where` each ranked as a
  // data identity and took one of the palette's few slots in every block that
  // mentioned them — `mut` and `pub` appear on more lines than most real bindings
  // do. `self`/`Self` are deliberately absent: they go through isSelfName(), exactly
  // as in Python.
  'fn', 'mut', 'impl', 'trait', 'pub', 'crate', 'mod', 'dyn', 'ref', 'move',
  'unsafe', 'where', 'loop', 'extern', 'union', 'box',
  // Kotlin, Java, Dart.
  'fun', 'val', 'final', 'when', 'object',
  // The primitive types. These are `entity.name.type` in the grammar and type slate
  // at rest, so tinting them as data would contradict band 1.
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'i8', 'i16', 'i32', 'i64', 'i128',
  'isize', 'f32', 'f64', 'str',
]);


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
 * True when every token in a SemanticTokens data array indexes into the legend.
 * VS Code answers the legend and the tokens commands from possibly different
 * providers when several share a document, so a mismatch means the data cannot
 * be decoded with this legend.
 */
export function tokensFitLegend(data: ArrayLike<number>, typeCount: number, modifierCount: number): boolean {
  const modLimit = 2 ** Math.min(modifierCount, 32);
  for (let i = 0; i + 4 < data.length; i += 5) {
    if (data[i + 3] >= typeCount || data[i + 4] >= modLimit) {
      return false;
    }
  }
  return data.length % 5 === 0;
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
  if (fnRanges.length <= LINEAR_FN_LIMIT) {
    return fnRanges.some((r) => inRange(offset, r));
  }
  return bestAt(fnIndexFor(fnRanges).inner, offset) >= 0;
}

/**
 * Below this many function ranges a linear scan is cheaper than building an
 * index. Both give the same answer.
 */
const LINEAR_FN_LIMIT = 16;

interface FnIndex {
  length: number;
  /** Tightest covering range; ties go to the first in array order. */
  inner: IntervalIndex;
  /** Widest covering range; ties go to the first in array order. */
  outer: IntervalIndex;
}

/**
 * Interval indexes per fnRanges array. An array is built once per document
 * version and never mutated after its first query; the length check rebuilds
 * an array that grew.
 */
const fnIndexes = new WeakMap<OffsetRange[], FnIndex>();

function fnIndexFor(fnRanges: OffsetRange[]): FnIndex {
  const cached = fnIndexes.get(fnRanges);
  if (cached && cached.length === fnRanges.length) {
    return cached;
  }
  const n = fnRanges.length;
  const starts = new Float64Array(n);
  const ends = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    starts[i] = fnRanges[i].start;
    ends[i] = fnRanges[i].end;
  }
  const len = (i: number): number => ends[i] - starts[i];
  const index: FnIndex = {
    length: n,
    inner: buildIntervalIndex(starts, ends, (a, b) => len(a) - len(b) || a - b),
    outer: buildIntervalIndex(starts, ends, (a, b) => len(b) - len(a) || a - b),
  };
  fnIndexes.set(fnRanges, index);
  return index;
}

/**
 * True globals (out-of-fn, non-capture) across the whole file, in order of
 * first appearance. A name is a true global when none of its declarations sit
 * inside any function range — i.e. declared at module scope, or with no visible
 * declaration at all. `occurrences` is iterated in insertion order, which is
 * first-appearance order, so the returned list is file-ordered and
 * block-independent.
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
 * is a true global. self names are excluded (band 1 paints them).
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
 * computeFnLocals per colour scope, for one file index or heuristic base. Every
 * block of a scope asks for the same answer, and it scans every occurrence in
 * the file.
 */
const fnLocalsMemo = new WeakMap<
  object,
  Map<string, { fnRanges: OffsetRange[]; fnCount: number; locals: string[]; globals: string[] }>
>();

function fnLocalsFor(
  owner: object,
  occurrences: Map<string, OffsetRange[]>,
  declOffsets: Map<string, number[]>,
  fnRanges: OffsetRange[],
  colorScopeFn: OffsetRange | undefined,
): { locals: string[]; globals: string[] } {
  if (!colorScopeFn) {
    return { locals: [], globals: [] };
  }
  let perScope = fnLocalsMemo.get(owner);
  if (!perScope) {
    perScope = new Map();
    fnLocalsMemo.set(owner, perScope);
  }
  const key = `${colorScopeFn.start}:${colorScopeFn.end}`;
  let hit = perScope.get(key);
  if (!hit || hit.fnRanges !== fnRanges || hit.fnCount !== fnRanges.length) {
    hit = { fnRanges, fnCount: fnRanges.length, ...computeFnLocals(occurrences, declOffsets, fnRanges, colorScopeFn) };
    perScope.set(key, hit);
  }
  return { locals: [...hit.locals], globals: [...hit.globals] };
}

/**
 * The innermost function range containing `offset`. Ties break to the tightest
 * span. Returns undefined at top level.
 */
export function enclosingFnOf(fnRanges: OffsetRange[], offset: number): OffsetRange | undefined {
  if (fnRanges.length > LINEAR_FN_LIMIT) {
    const i = bestAt(fnIndexFor(fnRanges).inner, offset);
    return i < 0 ? undefined : fnRanges[i];
  }
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
  if (fnRanges.length > LINEAR_FN_LIMIT) {
    const i = bestAt(fnIndexFor(fnRanges).outer, offset);
    return i < 0 ? undefined : fnRanges[i];
  }
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

function isSelfName(name: string, family?: string): boolean {
  if (family === 'js') return name === 'this';
  if (family === 'zig') return name === 'self';
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
 *   prev is `.`  → member access. Covers `?.` too. A spread or range (`...args`,
 *                  `0..n`) ends in `..`, and the name after it is a read.
 *   label        → see `isArgLabel`. A token carrying `declaration`/`definition`
 *                  is never a label: `def f(a, retries=5)` declares `retries`.
 */
function isMemberOrLabelPosition(lx: LexResult, offset: number, length: number, modifiers?: string[]): boolean {
  if (isMemberPosition(lx.text, offset)) {
    return true;
  }
  if (modifiers && modifiers.some((m) => DECL_MODIFIERS.has(m))) {
    return false;
  }
  return isArgLabel(lx, offset, length);
}

/** The previous non-blank char on the line is a member `.`, not the end of `..` / `...`. */
function isMemberPosition(text: string, offset: number): boolean {
  let p = offset - 1;
  while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) {
    p--;
  }
  return p >= 0 && text[p] === '.' && text[p - 1] !== '.';
}

/** Families where `name=` inside a call's parentheses is a named-argument label. Elsewhere it is an assignment. */
const LABEL_FAMILIES = new Set(['python', 'kotlin', 'nested', 'rust', 'hash', 'default']);

/** Words that put a `(` in statement or operator position rather than after a callee. */
const NON_CALLEE_WORDS = new Set([
  'if', 'elif', 'while', 'for', 'switch', 'when', 'catch', 'with', 'return', 'yield', 'await',
  'and', 'or', 'not', 'in', 'is', 'else', 'do', 'case', 'match', 'until', 'unless',
]);

/**
 * `name=` as a named argument: `f(a, retries=3)`, `connect(host = "x")`,
 * `format!("{x}", x = v)`, wrapped across lines. All of:
 *   - the next char is `=` (not `==` / `=>`);
 *   - the previous non-blank char, newlines included, is `(` or `,`;
 *   - the innermost unclosed bracket is a `(` right after a callee (an identifier
 *     that is not a control word or a `def` name, `)`, `]`, `>`, or Rust's macro `!`).
 * Tuple targets (`a, b = 1, 2`) have no enclosing `(`, so they stay bindings. In
 * JS, C, Java and Go `f(x = 1)` is an assignment, so the rule does not apply.
 */
export function isArgLabel(lx: LexResult, offset: number, length: number): boolean {
  if (!LABEL_FAMILIES.has(lx.syntax.family)) {
    return false;
  }
  const text = lx.text;
  let n = offset + length;
  while (n < text.length && (text[n] === ' ' || text[n] === '\t')) {
    n++;
  }
  if (text[n] !== '=' || text[n + 1] === '=' || text[n + 1] === '>') {
    return false;
  }
  const p = lx.prevSignificant(offset);
  if (p < 0 || (text[p] !== '(' && text[p] !== ',')) {
    return false;
  }
  const open = lx.enclosingOpen(offset);
  if (open < 0 || text[open] !== '(') {
    return false;
  }
  const q = lx.prevSignificant(open);
  const c = text[q] ?? '';
  if (c === ')' || c === ']' || c === '>' || (c === '!' && lx.syntax.family === 'rust')) {
    return true;
  }
  if (!/[\p{ID_Continue}$]/u.test(c)) {
    return false;
  }
  let w = q;
  while (w > 0 && /[\p{ID_Continue}$]/u.test(text[w - 1])) {
    w--;
  }
  if (NON_CALLEE_WORDS.has(text.slice(w, q + 1))) {
    return false;
  }
  const k = lx.prevSignificant(w);
  return !(k >= 2 && text.slice(k - 2, k + 1) === 'def' && !/[\p{ID_Continue}$]/u.test(text[k - 3] ?? ''));
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
  wholeRegion = false,
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
  if (wholeRegion && prev === REGION_MARK && next === REGION_MARK) return true;
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
  lx: LexResult,
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
  for (const id of lx.idents) {
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
  // Which declarations the block can see. Function ranges only by default; the
  // classifier passes declScopesFor(...) so sibling blocks count too.
  scopes: DeclScopes = fnOnlyScopes(fnRanges),
): Classification {
  const { occurrences, declOffsets, firstFileOffset } = fileIndex;

  const byName = new Map<string, NameInfo>();

  const subUnion = mergeRanges(subBlocks);

  // `excludeRanges` carves regions OUT of the block. Used for the synthetic
  // module top-level scope, whose range is the whole file: without carving out
  // the nested blocks, every local in every function would count as "used at
  // top level" and leak into the top-level view. With them carved out, the
  // top-level scope sees only genuinely top-level code.
  const excluded = mergeRanges(excludeRanges);
  const inExcluded = (offset: number): boolean => excluded.length > 0 && inSortedRanges(excluded, offset);

  // A name only counts as used-in-this-block if it has a TINTABLE occurrence
  // inside it. Lexing alone is not enough: `c.Name` is a field access (rejected
  // by the tintable check), but `Name` may still be in the file-wide occurrence
  // map from a shorthand read elsewhere — without this check the field access
  // would inherit that eligibility and tint. Each list is sorted by start, so
  // only the occurrences from block.start on are looked at.
  const tintableInBlock = (name: string): boolean => {
    const ranges = occurrences.get(name);
    if (!ranges) {
      return false;
    }
    for (let k = firstStartingAt(ranges, block.start); k < ranges.length && ranges[k].start <= block.end; k++) {
      const r = ranges[k];
      if (r.end <= block.end && !inExcluded(r.start)) {
        return true;
      }
    }
    return false;
  };

  // Names used in the block, via the lexer (gives per-block frequency/order for
  // the names the tintable check admitted).
  const blockIds = fileIndex.lex.identsIn(block.start, block.end);
  const blockAgg = new Map<string, { freq: number; first: number }>();
  const count = (id: LexId): void => {
    if (inExcluded(id.offset)) {
      return;
    }
    const agg = blockAgg.get(id.name);
    if (agg) {
      agg.freq++;
      agg.first = Math.min(agg.first, id.offset);
    } else {
      blockAgg.set(id.name, { freq: 1, first: id.offset });
    }
  };
  for (const id of blockIds) {
    count(id);
  }
  const reads = fileIndex.stringReads;
  for (let k = firstReadAt(reads, block.start); k < reads.length && reads[k].offset < block.end; k++) {
    count(reads[k]);
  }

  for (const [name, agg] of blockAgg) {
    if (isSelfName(name, fileIndex.lex.syntax.family)) {
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
    if (!tintableInBlock(name)) {
      continue; // keyword, field access, string content, non-tintable → neutral
    }

    // A declaration inside a nested sub-scope belongs to that scope. When the name
    // is also declared outside every sub-scope, those are the bindings this block
    // sees: a parameter `c` stays the function's own even if a closure inside
    // redeclares `c`.
    const all = declOffsets.get(name) ?? [];
    const seen = visibleDecls(all, block, scopes);
    const outside = seen.filter((o) => !inSortedRanges(subUnion, o));
    const decls = outside.length > 0 ? outside : seen.length > 0 ? seen : all;
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
      // Capture vs true global: is the name declared in a function that encloses
      // this block? The innermost such function is its home. A declaration in an
      // unrelated function is a different binding, so it does not make a capture.
      homeFn = enclosingDeclFn(decls, fnRanges, block, enclosingFn);
      isCapture = homeFn !== undefined;
    }

    // Attention proximity: a block-local declared inside a NESTED sub-block is a
    // child scope the caret sits above (proximity 2). A direct block-local is
    // proximity 0 (the focused block's own data). Everything borrowed in
    // (fn-local, capture, global) is proximity 1.
    let proximity: 0 | 1 | 2 = 1;
    if (cls === 'block') {
      proximity = outside.length > 0 ? 0 : 2;
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
      ...(isModuleTop(text, cls, enclosingFn, homeFn) && { moduleTop: true }),
    });
  }

  // fileGlobalsInOrder + self occurrences come from the shared file index — no
  // per-block whole-file rescan. Local ordering is per COLOUR SCOPE, so every
  // closure inside it shares one first-appearance order.
  const { locals: fnLocalsInOrder, globals: fnGlobals } = fnLocalsFor(
    fileIndex,
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
    declSites: fileIndex.declSites,
    staticNames: fileIndex.staticNames,
    excludeRanges: excluded,
    source: 'lsp',
  };
}

/** Index of the first range with start >= offset, in a list sorted by start. */
function firstStartingAt(ranges: OffsetRange[], offset: number): number {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].start < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function firstReadAt(ids: LexId[], offset: number): number {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid].offset < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether a name's binding sits at the top level of a module block that holds the focused block, but not in that block. */
function isModuleTop(text: string, cls: Cls, enclosingFn: OffsetRange | undefined, homeFn: OffsetRange | undefined): boolean {
  const home = cls === 'fn' ? enclosingFn : cls === 'out' ? homeFn : undefined;
  return home !== undefined && text[home.start] === MODULE_OPEN;
}

/**
 * The innermost function, other than `enclosingFn`, that both holds one of `decls`
 * and encloses `block`, else undefined.
 */
function enclosingDeclFn(
  decls: number[],
  fnRanges: OffsetRange[],
  block: OffsetRange,
  enclosingFn: OffsetRange | undefined,
): OffsetRange | undefined {
  let best: OffsetRange | undefined;
  for (const o of decls) {
    const r = enclosingFnOf(fnRanges, o);
    if (!r || (enclosingFn && r.start === enclosingFn.start && r.end === enclosingFn.end)) {
      continue;
    }
    if (r.start <= block.start && block.end <= r.end && (!best || r.end - r.start < best.end - best.start)) {
      best = r;
    }
  }
  return best;
}

/**
 * The lexical scopes a declaration can sit in: function ranges plus, outside
 * Python, block scope regions and braceless `for` statements. A declaration is
 * visible from a block when the tightest scope around it also contains the block.
 */
export interface DeclScopes {
  /** Is a declaration at `offset` visible from `block`: does its tightest scope contain the block? */
  visible(offset: number, block: OffsetRange): boolean;
}

const contains = (outer: OffsetRange | undefined, inner: OffsetRange): boolean =>
  !outer || (outer.start <= inner.start && inner.end <= outer.end);

function fnOnlyScopes(fnRanges: OffsetRange[]): DeclScopes {
  return { visible: (offset, block) => contains(enclosingFnOf(fnRanges, offset), block) };
}

const declScopesMemo = new WeakMap<
  BraceBlock[],
  { text: string; languageId: string | undefined; fnRanges: OffsetRange[]; fnCount: number; scopes: DeclScopes }
>();

/**
 * DeclScopes for one document version's block list and function ranges, cached.
 * Each query resolves only the blocks around its offset (the one whose body
 * holds it, the next one to open after it, a braceless `for` header), so a
 * version pays for the declarations it is asked about, not for every block.
 */
export function declScopesFor(
  text: string,
  blocks: BraceBlock[],
  fnRanges: OffsetRange[],
  languageId?: string,
): DeclScopes {
  const hit = declScopesMemo.get(blocks);
  if (hit && hit.text === text && hit.languageId === languageId && hit.fnRanges === fnRanges && hit.fnCount === fnRanges.length) {
    return hit.scopes;
  }
  const lx = lexFor(text, languageId);
  const scopes = lx.syntax.family === 'python' ? fnOnlyScopes(fnRanges) : blockScopes(lx, blocks, fnRanges, languageId);
  declScopesMemo.set(blocks, { text, languageId, fnRanges, fnCount: fnRanges.length, scopes });
  return scopes;
}

function blockScopes(lx: LexResult, blocks: BraceBlock[], fnRanges: OffsetRange[], languageId?: string): DeclScopes {
  const text = lx.text;
  let atOpen: Map<number, BraceBlock> | undefined;
  const regions = new Map<BraceBlock, OffsetRange>();
  const memo = new Map<number, OffsetRange | undefined>();
  const regionOf = (b: BraceBlock): OffsetRange => {
    let r = regions.get(b);
    if (!r) {
      r = scopeRegionFor(text, b, languageId);
      regions.set(b, r);
    }
    return r;
  };
  const innermostAt = (offset: number, fn: OffsetRange | undefined): OffsetRange | undefined => {
    if (memo.has(offset)) {
      return memo.get(offset);
    }
    atOpen ??= new Map(blocks.map((b) => [b.openOffset, b]));
    let best = fn;
    const consider = (r: OffsetRange | undefined): void => {
      if (r && r.start <= offset && offset < r.end && (!best || r.end - r.start < best.end - best.start)) best = r;
    };
    // A body binding: the innermost enclosing block that is a scope, not a pattern.
    for (let open = lx.enclosingOpen(offset); open >= 0; open = lx.enclosingOpen(open)) {
      const b = atOpen.get(open);
      if (b && !isPatternBrace(text, b, languageId)) {
        consider(regionOf(b));
        break;
      }
    }
    // A header binding (`for (let i …) {`, a callback's parameters): the next block to open.
    const P = lx.punct;
    for (let k = lx.punctFrom(offset), n = 0; k < P.length && n < 32; k++, n++) {
      if (text[P[k]] === '{') {
        const b = atOpen.get(P[k]);
        if (b) consider(regionOf(b));
        break;
      }
    }
    consider(bracelessForAt(lx, offset));
    memo.set(offset, best);
    return best;
  };
  return {
    visible(offset: number, block: OffsetRange): boolean {
      // A block scope lies inside its function, so another function's declaration
      // is settled by the function index alone.
      const fn = enclosingFnOf(fnRanges, offset);
      return contains(fn, block) && contains(innermostAt(offset, fn), block);
    },
  };
}

/**
 * `for (let i = …; …) stmt;` with no braces scopes `i` to the statement, which
 * no block records: the `for` keyword to the first depth-0 `;` after the header,
 * or to the close of a braced statement that comes first. Undefined unless
 * `offset` sits directly in such a header.
 */
function bracelessForAt(lx: LexResult, offset: number): OffsetRange | undefined {
  const text = lx.text;
  const open = lx.enclosingOpen(offset);
  if (open < 0 || text[open] !== '(') {
    return undefined;
  }
  const kw = lx.prevSignificant(open);
  if (kw < 2 || text.slice(kw - 2, kw + 1) !== 'for' || !lx.isCode(kw) || /[\p{ID_Continue}$]/u.test(text[kw - 3] ?? '')) {
    return undefined;
  }
  const P = lx.punct;
  let k = lx.punctFrom(open);
  let depth = 0;
  let close = -1;
  for (; k < P.length; k++) {
    const c = text[P[k]];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) {
      close = P[k];
      break;
    }
  }
  if (close < 0 || text[nextSignificant(lx, close + 1)] === '{') {
    return undefined;
  }
  let end = text.length;
  depth = 0;
  for (k++; k < P.length; k++) {
    const c = text[P[k]];
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        end = P[k];
        break;
      }
      if (--depth === 0 && c === '}') {
        end = P[k] + 1;
        break;
      }
    } else if (c === ';' && depth === 0) {
      end = P[k] + 1;
      break;
    }
  }
  return { start: kw - 2, end };
}

/**
 * The declarations of a name that `block` can see: those inside it, and those
 * whose tightest scope contains it. A declaration in an unrelated function or a
 * sibling block is a different binding.
 */
function visibleDecls(all: number[], block: OffsetRange, scopes: DeclScopes): number[] {
  return all.filter((o) => {
    return inRange(o, block) || scopes.visible(o, block);
  });
}

/** Sort and merge overlapping or touching ranges. */
function mergeRanges(ranges: OffsetRange[]): OffsetRange[] {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: OffsetRange[] = [{ ...sorted[0] }];
  for (let k = 1; k < sorted.length; k++) {
    const last = out[out.length - 1];
    if (sorted[k].start <= last.end) {
      last.end = Math.max(last.end, sorted[k].end);
    } else {
      out.push({ ...sorted[k] });
    }
  }
  return out;
}

/**
 * Keywords whose next identifier names a function, type, module or import:
 * band-1 furniture, never a data identity, wherever else the name appears.
 */
const NON_DATA_KEYWORDS = new Set([
  'function', 'class', 'func', 'def', 'fn', 'fun', 'type', 'enum', 'interface', 'struct', 'trait',
  'mod', 'union', 'object', 'typealias', 'protocol', 'namespace', 'module', 'package', 'import',
]);

/** Keywords whose next identifier is a data binding, per lexer family. */
function dataDeclKeywords(family: string): Set<string> {
  switch (family) {
    case 'lua':
    case 'ruby':
      return NO_DECL_KEYWORDS;
    case 'c':
    case 'java':
      return C_DECL_KEYWORDS;
    case 'nested':
      return NESTED_DECL_KEYWORDS;
    default:
      return DECL_KEYWORDS;
  }
}
const DECL_KEYWORDS = new Set(['const', 'let', 'var', 'val']);
/** Lua declarations come from `luaFacts`. */
const NO_DECL_KEYWORDS = new Set<string>();
/** `const` qualifies a type in C and C++, so only `var` (Java, C#) introduces a name. */
const C_DECL_KEYWORDS = new Set(['var']);
const NESTED_DECL_KEYWORDS = new Set(['const', 'let', 'var', 'val', 'final']);
/** Words that put an expression, not a declared name, after a type-like identifier. */
const C_EXPR_WORDS = new Set([
  'return', 'case', 'new', 'throw', 'else', 'goto', 'sizeof', 'typeof', 'delete', 'in', 'instanceof',
  'yield', 'await', 'default', 'not', 'and', 'or', 'co_return', 'co_yield', 'typedef', 'using',
]);

interface HeuristicBase {
  occurrences: Map<string, OffsetRange[]>;
  firstFileOffset: Map<string, number>;
  declOffsets: Map<string, number[]>;
  declSites: Set<number>;
  /** Offsets of the identifiers that are data candidates (see heuristicCandidate). */
  candidateAt: Set<number>;
}

const heuristicBases = new WeakMap<LexResult, Map<string, HeuristicBase>>();

/** The heuristic's block-independent orders and shadow scopes, per base and fnRanges array. */
const heuristicFileWides = new WeakMap<
  HeuristicBase,
  { fnRanges: OffsetRange[]; fnCount: number; fileGlobalsInOrder: string[]; shadowScopes: Map<string, OffsetRange[]> }
>();

function heuristicFileWide(
  base: HeuristicBase,
  fnRanges: OffsetRange[],
): { fileGlobalsInOrder: string[]; shadowScopes: Map<string, OffsetRange[]> } {
  const hit = heuristicFileWides.get(base);
  if (hit && hit.fnRanges === fnRanges && hit.fnCount === fnRanges.length) {
    return hit;
  }
  const declared = (name: string): boolean => base.declOffsets.has(name);
  const entry = {
    fnRanges,
    fnCount: fnRanges.length,
    fileGlobalsInOrder: computeFileGlobals(base.occurrences, base.declOffsets, fnRanges).filter(declared),
    shadowScopes: computeShadowScopes(base.declOffsets, fnRanges),
  };
  heuristicFileWides.set(base, entry);
  return entry;
}

/** Index of the first char at or after `i` that is neither blank nor in a comment. */
function nextSignificant(lx: LexResult, i: number): number {
  const text = lx.text;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    const region = lx.regionAt(i);
    if (region === 'comment' || region === 'doc') {
      i = lx.spanAt(i)!.end;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Can this code identifier be a data occurrence at all? Not a keyword, self or
 * `_`; not a member (`cfg.name`), path segment (`Config::new`), callee (`f(`),
 * macro (`println!(`) or named-argument label.
 */
function heuristicCandidate(lx: LexResult, id: LexId, nonData: Set<string>): boolean {
  if (lx.syntax.family === 'ruby') {
    return id.name !== '_' && rubyFacts(lx).binding.has(id.offset);
  }
  if (lx.syntax.family === 'lua') {
    if (LUA_KEYWORDS.has(id.name) || id.name === '_' || isSelfName(id.name) || nonData.has(id.name)) {
      return false;
    }
    const b = luaFacts(lx).binding.get(id.offset);
    return b !== undefined && !(b < 0 && LUA_STD.has(id.name)) && !luaCallee(lx, id);
  }
  const zig = lx.syntax.family === 'zig';
  if (zig ? isZigReserved(id.name) || isZigTypeName(id.name) || zigFacts(lx).nonDataAt.has(id.offset) || zigFacts(lx).nonDataUse(id.name, id.offset)
    : HEURISTIC_KEYWORDS.has(id.name)) {
    return false;
  }
  if (id.name === '_' || isSelfName(id.name, lx.syntax.family) || nonData.has(id.name)) {
    return false;
  }
  if (lx.syntax.family === 'python' && id.name === 'cls') {
    return false;
  }
  const text = lx.text;
  if (isMemberPosition(text, id.offset)) {
    return false;
  }
  let p = id.offset - 1;
  while (p >= 0 && (text[p] === ' ' || text[p] === '\t')) p--;
  if (p >= 1 && ((text[p] === ':' && text[p - 1] === ':') || (text[p] === '>' && text[p - 1] === '-'))) {
    return false;
  }
  let n = id.offset + id.length;
  while (n < text.length && (text[n] === ' ' || text[n] === '\t')) n++;
  const c = text[n];
  if (c === '(' || (c === ':' && text[n + 1] === ':') || (c === '!' && /[([{]/.test(text[n + 1] ?? ''))) {
    return false;
  }
  if (lx.syntax.family === 'js' && c === '?' && text[n + 1] === '.' && text[n + 2] === '(') {
    return false;
  }
  if (lx.syntax.family === 'js' && isBraceKey(lx, id, n)) {
    return false;
  }
  return !isArgLabel(lx, id.offset, id.length);
}

/**
 * JS / TS: `key:`, `key?:` or `key!:` first in an item of a `{…}`: an object-literal
 * key, a type member, a class field or a label.
 */
function isBraceKey(lx: LexResult, id: LexId, n: number): boolean {
  const text = lx.text;
  if (!((text[n] === ':' && text[n + 1] !== ':') || ((text[n] === '?' || text[n] === '!') && text[n + 1] === ':'))) return false;
  const open = lx.enclosingOpen(id.offset);
  if (open < 0 || text[open] !== '{') return false;
  const p = lx.prevSignificant(id.offset);
  return p === open || text[p] === ',' || text[p] === ';' || text[p] === '}';
}

/**
 * JS / TS: does the initializer after the `=` at `eq` make the binding a function or
 * a module, not data? An arrow, `function`, `class`, `async` arrow or function, which
 * tsserver types `function` or `class`; and `require("…")` or `await import("…")` with
 * only member accesses after it, which it types `namespace` or not at all.
 */
function jsNonDataInit(lx: LexResult, eq: number): boolean {
  const text = lx.text;
  if (eq < 0 || !plainEquals(text, eq)) return false;
  let i = nextSignificant(lx, eq + 1);
  if (i < 0) return false;
  const word = (at: number): string => {
    let e = at;
    while (e < text.length && isWordChar(text[e])) e++;
    return text.slice(at, e);
  };
  let w = word(i);
  if (w === 'async') {
    // No line break may follow `async` in an async function or arrow.
    const j = nextSignificant(lx, i + 5);
    if (j >= 0 && (text[j] === '(' || isWordChar(text[j])) && !text.slice(i + 5, j).includes('\n')) return true;
  }
  if (w === 'function' || w === 'class') return true;
  if (text[i] === '(') {
    const close = closeAfter(lx, i);
    const j = close > 0 ? nextSignificant(lx, close) : -1;
    return j >= 0 && text[j] === '=' && text[j + 1] === '>';
  }
  if (w && w !== 'require' && w !== 'await') {
    const j = nextSignificant(lx, i + w.length);
    return j >= 0 && text[j] === '=' && text[j + 1] === '>';
  }
  if (w === 'await') {
    i = nextSignificant(lx, i + 5);
    w = i >= 0 ? word(i) : '';
    if (w !== 'import') return false;
  } else if (w !== 'require') {
    return false;
  }
  const open = nextSignificant(lx, i + w.length);
  if (open < 0 || text[open] !== '(') return false;
  const arg = nextSignificant(lx, open + 1);
  const str = arg >= 0 ? lx.spanAt(arg) : undefined;
  if (!str || str.region !== 'string' || str.start !== arg) return false;
  let k = closeAfter(lx, open);
  for (;;) {
    const j = k > 0 ? nextSignificant(lx, k) : -1;
    if (j < 0) return true;
    if (text[j] === '.' && isWordChar(text[j + 1] ?? '')) {
      k = j + 1;
      while (k < text.length && isWordChar(text[k])) k++;
      continue;
    }
    return text[j] === ';' || text[j] === ',' || text[j] === ')' || text[j] === '}' || text.slice(k, j).includes('\n');
  }
}

/**
 * The block-independent half of the heuristic classifier, once per lex and
 * language: candidate occurrences and data declarations. A name is declared by
 * `let`/`const`/`var` (per family), `:=`, a `for` target, a Python statement-start
 * assignment or `with`/`except … as`, a C-family `Type name =`, or a parameter of
 * a function block. Names after `function`/`class`/`type`/`import`/… are never
 * data. Callers must not mutate the maps or their range lists.
 */
function heuristicBaseFor(lx: LexResult, languageId: string | undefined, blocks: BraceBlock[] | undefined): HeuristicBase {
  let perLang = heuristicBases.get(lx);
  if (!perLang) {
    perLang = new Map();
    heuristicBases.set(lx, perLang);
  }
  const cached = perLang.get(languageId ?? '');
  if (cached) {
    return cached;
  }
  const text = lx.text;
  const family = lx.syntax.family;
  const ids = lx.idents;

  // Python resolves imports per occurrence (src/imports.ts), so a parameter that
  // shares an import's name is still data.
  const importOffsets = family === 'python' ? pyImportOffsets(lx) : undefined;
  const nonData = new Set<string>();
  for (let i = 1; i < ids.length; i++) {
    if (importOffsets && ids[i - 1].name === 'import') {
      continue;
    }
    if (NON_DATA_KEYWORDS.has(ids[i - 1].name) && blankGap(text, ids[i - 1].offset + ids[i - 1].length, ids[i].offset)) {
      nonData.add(ids[i].name);
    }
  }

  if (family === 'js') for (const name of jsxComponentNames(lx)) nonData.add(name);
  if (languageId === 'astro') nonData.add('Astro');
  const zig = family === 'zig' ? zigFacts(lx) : undefined;
  const lua = family === 'lua' ? luaFacts(lx, blocks) : undefined;
  if (lua) {
    for (const o of [...lua.modules, ...lua.functionSites]) nonData.add(lua.decls.get(o)!.name);
    for (const name of lua.namespaces) nonData.add(name);
  }
  const occurrences = new Map<string, OffsetRange[]>();
  const firstFileOffset = new Map<string, number>();
  const candidateAt = new Set<number>();
  const typeParams = mergeRanges(typeArrowsOf(lx, languageId).params);
  for (const id of ids) {
    if (!heuristicCandidate(lx, id, nonData) || inSortedRanges(typeParams, id.offset) || importOffsets?.has(id.offset)) {
      continue;
    }
    candidateAt.add(id.offset);
    // A Ruby global's tint covers its name; the `$` sigil keeps its own register.
    const sigil = family === 'ruby' && id.name.startsWith('$') ? 1 : 0;
    const range: OffsetRange = { start: id.offset + sigil, end: id.offset + id.length };
    const list = occurrences.get(id.name);
    if (list) {
      list.push(range);
    } else {
      occurrences.set(id.name, [range]);
      firstFileOffset.set(id.name, id.offset);
    }
  }

  const declOffsets = new Map<string, number[]>();
  const declSites = new Set<number>();
  const declare = (id: LexId): void => {
    if (!candidateAt.has(id.offset) || declSites.has(id.offset)) {
      return;
    }
    declSites.add(id.offset);
    const d = declOffsets.get(id.name);
    if (d) {
      d.push(id.offset);
    } else {
      declOffsets.set(id.name, [id.offset]);
    }
  };
  const nextChar = (id: LexId): { c: string; c2: string; at: number } => {
    const at = nextSignificant(lx, id.offset + id.length);
    return { c: at >= 0 ? text[at] : '', c2: at >= 0 ? text[at + 1] ?? '' : '', at };
  };
  /** Followed by a plain `=` (not `==`, `=>`, `+=` …). */
  const assigns = (id: LexId): boolean => {
    const { c, c2 } = nextChar(id);
    return c === '=' && c2 !== '=' && c2 !== '>';
  };
  /** The idents of `a, b, c` starting at index i, while separated by commas only. */
  const commaRun = (i: number): number => {
    let j = i;
    while (j + 1 < ids.length && commaGap(text, ids[j].offset + ids[j].length, ids[j + 1].offset)) j++;
    return j;
  };

  const keywords = dataDeclKeywords(family);
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const next = ids[i + 1];
    const adjacent = next !== undefined && blankGap(text, id.offset + id.length, next.offset);
    // `let x`, `const x`, `let mut x`, Go `var x int`.
    if (keywords.has(id.name) && adjacent) {
      let target = next;
      let k = i + 1;
      if (target.name === 'mut' && ids[k + 1] && blankGap(text, target.offset + target.length, ids[k + 1].offset)) {
        k++;
        target = ids[k];
      }
      const { c, c2 } = nextChar(target);
      const shaped = family === 'go'
        || (c === ':' && c2 !== ':') || c === '=' || c === ',' || c === ';' || c === ')'
        || ids[k + 1]?.name === 'in' || ids[k + 1]?.name === 'of';
      if (shaped && !(family === 'js' && c === '=' && jsNonDataInit(lx, nextSignificant(lx, target.offset + target.length)))) {
        declare(target);
      }
    }
    // `for i in`, `for k, v in`.
    if (id.name === 'for' && adjacent) {
      const last = commaRun(i + 1);
      if (ids[last + 1]?.name === 'in') {
        for (let j = i + 1; j <= last; j++) declare(ids[j]);
      }
    }
    // Go `a, b := f()`, Python's walrus.
    let after = id.offset + id.length;
    while (text[after] === ' ' || text[after] === '\t') after++;
    if (text[after] === ':' && text[after + 1] === '=') {
      for (let j = i; j >= 0; j--) {
        declare(ids[j]);
        if (j === 0 || !commaGap(text, ids[j - 1].offset + ids[j - 1].length, ids[j].offset)) break;
      }
    }
  }
  if (family === 'python' || family === 'hash') {
    declarePyStatements(lx, ids, declare, assigns, commaRun);
  }
  if (lua) {
    for (const id of ids) {
      if (lua.declSites.has(id.offset) || lua.globalSites.has(id.offset)) declare(id);
    }
  }
  if (family === 'ruby') {
    const ruby = rubyFacts(lx, blocks);
    for (const id of ids) if (ruby.declSites.has(id.offset) || ruby.globalSites.has(id.offset)) declare(id);
    const base = { occurrences, firstFileOffset, declOffsets, declSites, candidateAt };
    perLang.set(languageId ?? '', base);
    return base;
  }
  declareShapes(lx, keywords, declare);
  if (lx.syntax.key === 'view') patternDeclarations(lx, declare);
  if (zig) {
    for (const id of zig.captures) declare(id);
  }
  if (family === 'c' || family === 'java' || family === 'default') {
    for (let i = 1; i < ids.length; i++) {
      const id = ids[i];
      const p = lx.prevSignificant(id.offset);
      const pc = p >= 0 ? text[p] : '';
      const typed = (p === ids[i - 1].offset + ids[i - 1].length - 1 && !C_EXPR_WORDS.has(ids[i - 1].name)
        && !keywords.has(ids[i - 1].name)) || pc === ']';
      const { c, c2 } = nextChar(id);
      if (typed && ((c === '=' && c2 !== '=') || c === ';' || c === '[' || (c === ':' && c2 !== ':'))) {
        declare(id);
      }
    }
  }
  for (const span of paramSpans(lx, languageId, blocks ?? scanBlocks(text, languageId))) {
    for (const id of lx.identsIn(span.start, span.end)) {
      if (lx.enclosingOpen(id.offset) === span.depthOpen && isParamName(lx, id, span)) {
        declare(id);
      }
    }
    if (family === 'js' && span.open >= 0) {
      // A destructured parameter: `({ a, b = 1 }, [c, d]) =>`.
      for (let k = lx.punctFrom(span.start); k < lx.punct.length && lx.punct[k] < span.end; k++) {
        const at = lx.punct[k];
        if ((text[at] !== '{' && text[at] !== '[') || lx.enclosingOpen(at) !== span.open) continue;
        const p = lx.prevSignificant(at);
        if (p !== span.open && text[p] !== ',') continue;
        const end = closeAfter(lx, at);
        if (end > at) for (const b of patternBindings(lx, at, end, false)) declare(b);
      }
    }
  }

  const base = { occurrences, firstFileOffset, declOffsets, declSites, candidateAt };
  perLang.set(languageId ?? '', base);
  return base;
}

/** Code char at `i`, or '' outside code. */
function codeAt(lx: LexResult, i: number): string {
  return i >= 0 && i < lx.text.length && lx.isCode(i) ? lx.text[i] : '';
}

/** Offset just past the code bracket opened at `open`, else -1. */
function closeAfter(lx: LexResult, open: number): number {
  const text = lx.text;
  const P = lx.punct;
  let depth = 0;
  for (let k = lx.punctFrom(open); k < P.length; k++) {
    const c = text[P[k]];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) return P[k] + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Is the `=` at `i` a plain assignment (not `==`, `=>`, `<=`, `>=`, `!=`, `+=` …)? */
function plainEquals(text: string, i: number): boolean {
  return text[i] === '=' && text[i + 1] !== '=' && text[i + 1] !== '>' && !/[=!<>+\-*/%&|^~?:.]/.test(text[i - 1] ?? '');
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{ID_Continue}$]/u.test(c);

/**
 * The binding names of a destructuring, target or match pattern in [start, end):
 * `{ a, b: c, d = 1, ...rest }`, `[a, b]`, `(mut a, ref b)`, `P { x, y }`,
 * `Some((k, v))`, `x @ 1..=5`, `a, *rest`. Not a binding: a key before `:` in
 * `{…}`, a type after `:` in `(…)`, a default value after `=`, a type or variant
 * before `{` / `(` / `::`, a subscript or attribute target, and in Rust any
 * capitalised name (a constant or unit variant).
 */
function patternBindings(lx: LexResult, start: number, end: number, rust: boolean): LexId[] {
  const text = lx.text;
  const out: LexId[] = [];
  for (const id of lx.identsIn(start, end)) {
    if (id.name === 'mut' || id.name === 'ref' || id.name === 'box' || id.name === '_') continue;
    if (rust && /^\p{Lu}/u.test(id.name)) continue;
    const n = nextSignificant(lx, id.offset + id.length);
    const nc = n >= 0 && n < end ? text[n] : '';
    if (nc === '{' || nc === '(' || nc === '[' || nc === '!' || (nc === '.' && text[n + 1] !== '.') || (nc === ':' && text[n + 1] === ':')) continue;
    const p = lx.prevSignificant(id.offset);
    if (p >= 0 && ((text[p] === '.' && text[p - 1] !== '.') || (text[p] === ':' && text[p - 1] === ':'))) continue;
    const open = lx.enclosingOpen(id.offset);
    const inBrace = open >= start && text[open] === '{';
    if (inBrace && nc === ':') continue;
    // The nearest `,` / `:` / `=` at this bracket level decides the position.
    let depth = 0;
    let role = 'bind';
    for (let i = id.offset - 1; i >= start && i > open; i--) {
      const c = codeAt(lx, i);
      if (c === ')' || c === ']' || c === '}') depth++;
      else if (c === '(' || c === '[' || c === '{') depth--;
      else if (depth === 0 && c === ',') break;
      else if (depth === 0 && c === ':' && text[i - 1] !== ':' && text[i + 1] !== ':') {
        role = inBrace ? 'bind' : 'type';
        break;
      } else if (depth === 0 && c === '=' && plainEquals(text, i)) {
        role = 'default';
        break;
      }
    }
    if (role === 'bind') out.push(id);
  }
  return out;
}

/**
 * Declaration shapes that bind more than one name, or whose name is not right
 * after a keyword: destructuring after `let` / `const` / `var` / `val`, Rust
 * `if let` / `while let` and match-arm patterns, `catch` parameters, Kotlin
 * `{ a, b -> }` and Swift `{ a, b in }` lambda parameters, Go `var ( … )`
 * groups, C-family declarator lists and `*` / `&` / generic-typed declarators,
 * Python bracketed and starred targets, and PHP `$name =` statements.
 */
function declareShapes(lx: LexResult, keywords: Set<string>, declare: (id: LexId) => void): void {
  const text = lx.text;
  const family = lx.syntax.family;
  const ids = lx.idents;
  const rust = family === 'rust';

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    // `const { a, b } = o`, `let (a, b) = o`, `val (a, b) = p`, `let P { x, y } = p`, `if let Some(v) = o`.
    if (keywords.has(id.name) && family !== 'go') {
      let from = nextSignificant(lx, id.offset + id.length);
      if (from >= 0 && text.startsWith('mut', from) && !isWordChar(text[from + 3])) {
        from = nextSignificant(lx, from + 3);
      }
      let open = from;
      if (rust && from >= 0 && isWordChar(text[from])) {
        // A struct or tuple-struct pattern: `P { x }`, `Some(v)`, `a::B(v)`.
        while (open < text.length && (isWordChar(text[open]) || (text[open] === ':' && text[open + 1] === ':'))) {
          open += text[open] === ':' ? 2 : 1;
        }
        open = nextSignificant(lx, open);
      }
      if (open >= 0 && (text[open] === '(' || text[open] === '[' || text[open] === '{') && lx.isCode(open)) {
        const end = closeAfter(lx, open);
        if (end > open && !(family === 'js' && jsNonDataInit(lx, nextSignificant(lx, end)))) {
          for (const b of patternBindings(lx, from, end, rust)) declare(b);
        }
      }
    }
    // `catch (err)`, `catch (e: Exception)`, `catch (IOException e)`.
    if (id.name === 'catch') {
      const open = nextSignificant(lx, id.offset + id.length);
      const close = open >= 0 && text[open] === '(' ? closeAfter(lx, open) : -1;
      if (close > open) {
        const inner = lx.identsIn(open + 1, close - 1).filter((x) => lx.enclosingOpen(x.offset) === open);
        let pick: LexId | undefined;
        if (family === 'js' || family === 'kotlin' || family === 'nested') {
          pick = inner[0];
        } else {
          pick = inner.filter((x) => text[nextSignificant(lx, x.offset + x.length)] === ')').pop();
        }
        if (pick) declare(pick);
      }
    }
    // PHP `$a = 1;` and `foreach ($xs as $k => $v)`.
    if (family === 'default' && id.name.startsWith('$')) {
      const p = lx.prevSignificant(id.offset);
      const n = nextSignificant(lx, id.offset + id.length);
      const atStatement = p < 0 || text[p] === ';' || text[p] === '{' || text[p] === '}'
        || (text.slice(p, id.offset).includes('\n') && !/[=(,.+\-*/&|]/.test(text[p]));
      const afterAs = ids[i - 1]?.name === 'as' || (text[p] === '>' && text[p - 1] === '=' && ids[i - 2]?.name === 'as');
      if ((atStatement && n >= 0 && plainEquals(text, n)) || afterAs) {
        declare(id);
      }
    }
  }

  if (rust) {
    declareRustArms(lx, declare);
  }
  if (family === 'kotlin' || family === 'nested') {
    declareLambdaParams(lx, family === 'kotlin' ? '->' : 'in', declare);
  }
  if (family === 'go') {
    declareGoGroups(lx, declare);
  }
  if (family === 'c' || family === 'java' || family === 'default') {
    declareCDeclarators(lx, keywords, declare);
  }
  if (family === 'python') {
    declarePyTargets(lx, declare);
  }
}

/** Rust match-arm patterns on one line: `Some(v) =>`, `Ok(x) | Err(x) =>`, `n @ 1..=9 if n > 3 =>`. */
function declareRustArms(lx: LexResult, declare: (id: LexId) => void): void {
  const text = lx.text;
  for (let a = text.indexOf('=>'); a >= 0; a = text.indexOf('=>', a + 2)) {
    if (!lx.isCode(a)) continue;
    let depth = 0;
    let start = a;
    for (let i = a - 1; i >= 0 && a - i < 400; i--) {
      if (text[i] === '\n' && depth === 0) break;
      const c = codeAt(lx, i);
      if (c === ')' || c === ']' || c === '}') depth++;
      else if (c === '(' || c === '[' || c === '{') {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
      start = i;
    }
    const level = lx.enclosingOpen(a);
    const guard = lx.identsIn(start, a).find((x) => x.name === 'if' && lx.enclosingOpen(x.offset) === level);
    for (const b of patternBindings(lx, start, guard ? guard.offset : a, true)) declare(b);
  }
}

/** Kotlin `{ a, b -> … }` / `{ (k, v) -> … }` and Swift `{ a, b in … }` / `{ [weak self] a in … }` parameters. */
function declareLambdaParams(lx: LexResult, arrow: '->' | 'in', declare: (id: LexId) => void): void {
  const text = lx.text;
  for (const open of lx.punct) {
    if (text[open] !== '{') continue;
    let i = open + 1;
    const limit = Math.min(text.length, open + 300);
    let found = -1;
    while (i < limit) {
      if (!lx.isCode(i)) {
        const r = lx.regionAt(i);
        if (r !== 'comment' && r !== 'doc') break;
        i = lx.spanAt(i)!.end;
        continue;
      }
      const c = text[i];
      if (arrow === '->' && c === '-' && text[i + 1] === '>') {
        found = i;
        break;
      }
      if (arrow === 'in' && text.startsWith('in', i) && !isWordChar(text[i - 1]) && !isWordChar(text[i + 2])) {
        found = i;
        break;
      }
      if (!/[\p{ID_Continue}$\s,:()<>?.[\]]/u.test(c)) break;
      i++;
    }
    if (found < 0 || /\bwhen\b/.test(text.slice(lx.lineStarts[lx.lineOf(open)], open))) continue;
    let from = open + 1;
    const s = nextSignificant(lx, from);
    if (arrow === 'in' && text[s] === '[') {
      const close = closeAfter(lx, s);
      if (close < 0 || close > found) continue;
      from = close;
    }
    for (const b of patternBindings(lx, from, found, false)) declare(b);
  }
}

/** Go `var ( a = 1; b, c int )` and `const ( … )`: the leading names of each line in the group. */
function declareGoGroups(lx: LexResult, declare: (id: LexId) => void): void {
  const text = lx.text;
  const ids = lx.idents;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i].name !== 'var' && ids[i].name !== 'const') continue;
    const open = nextSignificant(lx, ids[i].offset + ids[i].length);
    if (open < 0 || text[open] !== '(') continue;
    const close = closeAfter(lx, open);
    for (let k = i + 1; close > 0 && k < ids.length && ids[k].offset < close; k++) {
      const p = lx.prevSignificant(ids[k].offset);
      const startsLine = p === open || text[p] === ';' || text.slice(p, ids[k].offset).includes('\n');
      if (!startsLine || lx.enclosingOpen(ids[k].offset) !== open) continue;
      declare(ids[k]);
      while (k + 1 < ids.length && commaGap(text, ids[k].offset + ids[k].length, ids[k + 1].offset)) {
        declare(ids[++k]);
      }
    }
  }
}

/**
 * C-family declarators the single-name rule misses: the rest of a declarator
 * list (`int a = 1, b = 2;`), pointer and reference declarators (`int *p = &n;`,
 * `Foo& r = x;`) and generic types (`List<String> xs = …`). The type must start
 * the statement, so `x = a * b;` and `a > b;` declare nothing.
 */
function declareCDeclarators(lx: LexResult, keywords: Set<string>, declare: (id: LexId) => void): void {
  const text = lx.text;
  const ids = lx.idents;
  /** Start of a statement-initial type ending just before `at` (names, `::`, `<…>`, `*`, `&`, `[]`), else -1. */
  const typeStart = (at: number): number => {
    let i = at;
    let angle = 0;
    let words = 0;
    for (let steps = 0; steps < 64; steps++) {
      while (i > 0 && (text[i - 1] === ' ' || text[i - 1] === '\t')) i--;
      const c = codeAt(lx, i - 1);
      if (c === '>') {
        angle++;
        i--;
      } else if (c === '<' && angle > 0) {
        angle--;
        i--;
      } else if (angle > 0 && (c === ',' || c === '?' || c === '.')) {
        i--;
      } else if (c === '*' || c === '&' || c === ']' || c === '[' || (c === ':' && text[i - 2] === ':')) {
        i -= c === ':' ? 2 : 1;
      } else if (isWordChar(c)) {
        let s = i - 1;
        while (s > 0 && isWordChar(text[s - 1])) s--;
        const w = text.slice(s, i);
        if (C_EXPR_WORDS.has(w) || keywords.has(w)) return -1;
        words++;
        i = s;
      } else {
        break;
      }
    }
    if (angle !== 0 || words === 0) return -1;
    const p = lx.prevSignificant(i);
    const pc = p >= 0 ? text[p] : '';
    return p < 0 || pc === ';' || pc === '{' || pc === '}' || pc === '(' || (pc === ':' && text[p - 1] !== ':') ? i : -1;
  };
  const declarator = (at: number): boolean => {
    const c = text[at];
    return (c === '=' && plainEquals(text, at)) || c === ';' || c === '[' || c === ',';
  };
  for (const id of ids) {
    const p = lx.prevSignificant(id.offset);
    const pc = p >= 0 ? text[p] : '';
    if (!((pc === '*' || pc === '&' || pc === '>') && !(pc === '>' && text[p - 1] === '-'))) continue;
    const n = nextSignificant(lx, id.offset + id.length);
    if (n >= 0 && declarator(n) && typeStart(id.offset) >= 0) declare(id);
  }
  // The rest of a declarator list, after a first declarator a statement-initial type introduces.
  for (const id of ids) {
    const n = nextSignificant(lx, id.offset + id.length);
    if (n < 0 || !((text[n] === '=' && plainEquals(text, n)) || text[n] === ',' || text[n] === '[') || typeStart(id.offset) < 0) continue;
    declare(id);
    let depth = 0;
    for (let j = n; j < text.length && j - n < 2000; j++) {
      const c = codeAt(lx, j);
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (--depth < 0) break;
      } else if (depth === 0 && c === ';') break;
      else if (depth === 0 && c === ',') {
        let s = nextSignificant(lx, j + 1);
        while (s >= 0 && (text[s] === '*' || text[s] === '&')) s = nextSignificant(lx, s + 1);
        const next = s >= 0 ? lx.identsIn(s, s + 1)[0] : undefined;
        const after = next ? nextSignificant(lx, next.offset + next.length) : -1;
        if (!next || after < 0 || !declarator(after)) break;
        declare(next);
        j = next.offset + next.length - 1;
      }
    }
  }
}

/**
 * Python targets the name-run rule misses: `(a, b) = o`, `[a, b] = o`,
 * `a, *rest = o`, `for i, (k, v) in …`. A target list is the start of a logical
 * line up to its first depth-0 `=`, holding only names, `,`, `*` and brackets.
 */
function declarePyTargets(lx: LexResult, declare: (id: LexId) => void): void {
  const text = lx.text;
  // Candidate statements: a line whose first `=` (or a `for` line's `:`) has a
  // bracket or star before it. Plain names and comma runs are declarePyStatements'.
  const starts: number[] = [];
  const shapedBefore = (from: number, to: number): boolean => {
    for (let k = from; k < to; k++) {
      const ch = text.charCodeAt(k);
      if (ch === 40 || ch === 91 || ch === 42) return true;
    }
    return false;
  };
  const firstCode = (line: number): number => {
    let i = lx.lineStarts[line];
    while (text[i] === ' ' || text[i] === '\t') i++;
    return i;
  };
  const ls = lx.lineStarts;
  // Both walks move forward, so the line index only advances.
  let line = 0;
  let lastLine = -1;
  for (let q = text.indexOf('='); q >= 0; q = text.indexOf('=', q + 1)) {
    while (line + 1 < ls.length && ls[line + 1] <= q) line++;
    if (line === lastLine) continue;
    lastLine = line;
    const i = firstCode(line);
    if (!(text.startsWith('for', i) && !isWordChar(text[i + 3])) && shapedBefore(i, q)) starts.push(i);
  }
  line = 0;
  for (const id of lx.idents) {
    if (id.name !== 'for') continue;
    while (line + 1 < ls.length && ls[line + 1] <= id.offset) line++;
    if (firstCode(line) !== id.offset) continue;
    const eol = text.indexOf('\n', id.offset);
    const colon = text.indexOf(':', id.offset);
    if (colon >= 0 && (eol < 0 || colon < eol) && shapedBefore(id.offset, colon)) starts.push(id.offset);
  }
  starts.sort((x, y) => x - y);
  for (const i of starts) {
    if (!lx.isCode(i) || lx.enclosingOpen(i) >= 0) continue;
    const p = lx.prevSignificant(i);
    if (p >= 0 && text[p] === '\\') continue;
    const forTarget = text.startsWith('for', i) && !isWordChar(text[i + 3]);
    let depth = 0;
    let end = -1;
    for (let j = forTarget ? i + 3 : i; j < text.length && j - i < 400; j++) {
      const c = codeAt(lx, j);
      if (text[j] === '\n' && depth === 0) break;
      if (c === '(' || c === '[') {
        if (isWordChar(text[j - 1]) || text[j - 1] === ')' || text[j - 1] === ']') break; // a call or subscript
        depth++;
      } else if (c === ')' || c === ']') {
        depth--;
      } else if (depth === 0 && !forTarget && c === '=') {
        if (plainEquals(text, j)) end = j;
        break;
      } else if (depth === 0 && forTarget && text.startsWith('in', j) && !isWordChar(text[j - 1]) && !isWordChar(text[j + 2])) {
        end = j;
        break;
      } else if (c && !/[\p{ID_Continue}\s,*.]/u.test(c)) {
        break;
      }
    }
    if (end > i) {
      for (const b of patternBindings(lx, forTarget ? i + 3 : i, end, false)) declare(b);
    }
  }
}

/**
 * Python (and `#`-comment family) bindings: a name, or a comma run of names, at
 * the start of a statement and followed by `=` or an annotation `:`; and the
 * target of `with … as` / `except … as`.
 */
function declarePyStatements(
  lx: LexResult,
  ids: LexId[],
  declare: (id: LexId) => void,
  assigns: (id: LexId) => boolean,
  commaRun: (i: number) => number,
): void {
  const text = lx.text;
  const python = lx.syntax.family === 'python';
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (lx.enclosingOpen(id.offset) >= 0) {
      continue;
    }
    const p = lx.prevSignificant(id.offset);
    const lineStart = p < 0 || text[p] === ';' || (text.slice(p, id.offset).includes('\n') && text[p] !== '\\');
    if (lineStart) {
      const j = commaRun(i);
      let n = ids[j].offset + ids[j].length;
      while (text[n] === ' ' || text[n] === '\t') n++;
      if (assigns(ids[j]) || (python && j === i && text[n] === ':' && text[n + 1] !== '=')) {
        for (let k = i; k <= j; k++) declare(ids[k]);
      }
    }
    if (python && id.name === 'as' && ids[i + 1]) {
      const first = lx.identsIn(lx.lineStarts[lx.lineOf(id.offset)], id.offset)[0]?.name;
      if (first === 'with' || first === 'except' || first === 'async' || first === 'case') {
        declare(ids[i + 1]);
      }
    }
  }
}

interface ParamSpan {
  start: number;
  end: number;
  /** The bracket a parameter name sits directly inside: the list's `(`, or what encloses a `|…|` or lambda list. */
  depthOpen: number;
  /** Offset of the list's own opening delimiter. */
  open: number;
}

/** The parameter lists of every function-like block: `(…)`, a Rust closure's `|…|`, a lambda's `lambda …:`. */
function paramSpans(lx: LexResult, languageId: string | undefined, blocks: BraceBlock[]): ParamSpan[] {
  const text = lx.text;
  const P = lx.punct;
  const out: ParamSpan[] = [];
  for (const b of blocks) {
    const scope = functionScopeOf(text, b, languageId);
    if (!scope) {
      continue;
    }
    const open = scope.start;
    if (text[open] === '(') {
      let depth = 0;
      for (let k = lx.punctFrom(open); k < P.length && P[k] < b.closeOffset; k++) {
        const c = text[P[k]];
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) {
          out.push({ start: open + 1, end: P[k], depthOpen: open, open });
          break;
        }
      }
    } else if (text[open] === '|') {
      const close = text.indexOf('|', open + 1);
      if (close > open) out.push({ start: open + 1, end: close, depthOpen: lx.enclosingOpen(open), open });
    } else if (text.startsWith('lambda', open)) {
      let depth = 0;
      for (let k = lx.punctFrom(open); k < P.length && P[k] <= b.closeOffset; k++) {
        const c = text[P[k]];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ':' && depth === 0) {
          out.push({ start: open + 6, end: P[k], depthOpen: lx.enclosingOpen(open), open });
          break;
        }
      }
    } else if (/[\p{ID_Start}_$]/u.test(text[open] ?? '')) {
      // A bare arrow parameter: `name => …`.
      out.push({ start: open, end: open + 1, depthOpen: lx.enclosingOpen(open), open: -1 });
    }
  }
  return out;
}

/**
 * Is this identifier, directly inside a parameter list, a parameter NAME rather
 * than a type or a default value? Go names come first in each comma group
 * (`a, b int`); C and Java names come last (`int a`); everywhere else a name is
 * followed by `:`, `,`, `)`, `=` or `|` and is not itself after a `:` (a type).
 */
function isParamName(lx: LexResult, id: LexId, span: ParamSpan): boolean {
  const text = lx.text;
  const p = lx.prevSignificant(id.offset);
  const pc = p >= 0 ? text[p] : '';
  const at = nextSignificant(lx, id.offset + id.length);
  const nc = at >= 0 ? text[at] : '';
  const nc2 = at >= 0 ? text[at + 1] ?? '' : '';
  if (nc === '.' || nc === '(' || (nc === ':' && nc2 === ':')) {
    return false;
  }
  if (span.open === -1) {
    return true;
  }
  switch (lx.syntax.family) {
    case 'go':
    case 'lua':
      return pc === '(' || pc === ',';
    case 'c':
    case 'java':
      return (/[\p{ID_Continue}$*&\]>]/u.test(pc) || (pc === '.' && text[p - 1] === '.'))
        && p !== span.open && (nc === ',' || nc === ')' || nc === '=' || nc === '[');
    default: {
      if (p !== span.open && (pc === ':' || pc === '<' || pc === '|' || pc === '&' || pc === '=')) {
        return false;
      }
      if (pc === '.' && text[p - 1] !== '.') {
        return false;
      }
      return (nc === ':' && nc2 !== ':') || nc === ',' || nc === ')' || nc === '|' || nc === '?'
        || (nc === '=' && nc2 !== '=');
    }
  }
}

/**
 * PURE heuristic classifier — no LSP. The fallback for a cold server or a
 * language with no semantic-token provider, so it prefers painting less: a name
 * is a data identity only when a declaration for it is found (see
 * heuristicBaseFor), it is classified against that declaration, and a name
 * declared only in functions that do not enclose the block is left neutral.
 * `excludeRanges` carves the top-level scope's nested bodies out, as on the
 * semantic path.
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
  languageId?: string,
  excludeRanges: OffsetRange[] = [],
  blocks?: BraceBlock[],
): Classification {
  const lx = lexFor(text, languageId);
  const scanned = blocks ?? scanBlocks(text, languageId);
  const base = heuristicBaseFor(lx, languageId, scanned);
  const scopes = declScopesFor(text, scanned, fnRanges, languageId);
  // Copied per block: addSelfOccurrences extends it with this block's self names.
  const occurrences = new Map(base.occurrences);
  const { firstFileOffset, declOffsets } = base;
  const excluded = mergeRanges(excludeRanges);
  const subUnion = mergeRanges(subBlocks);

  const blockAgg = new Map<string, { freq: number; first: number }>();
  for (const id of lx.identsIn(block.start, block.end)) {
    if (inSortedRanges(excluded, id.offset) || (!isSelfName(id.name, lx.syntax.family) && !base.candidateAt.has(id.offset))) {
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
    if (isSelfName(name, lx.syntax.family)) {
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
    const all = declOffsets.get(name);
    if (!all) {
      continue;
    }
    const seen = visibleDecls(all, block, scopes);
    const outside = seen.filter((o) => !inSortedRanges(subUnion, o));
    const decls = outside.length > 0 ? outside : seen.length > 0 ? seen : all;
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
      homeFn = enclosingDeclFn(decls, fnRanges, block, enclosingFn);
      isCapture = homeFn !== undefined;
      if (!isCapture && decls.every((o) => insideAnyFn(o, fnRanges))) {
        continue; // declared only in functions that do not enclose this block
      }
    }

    let proximity: 0 | 1 | 2 = 1;
    if (cls === 'block') {
      proximity = outside.length > 0 ? 0 : 2;
    } else if (cls === 'fn' && decls.some((o) => inRange(o, block) && !inRange(o, declRegion))) {
      proximity = 0; // the focused function's own parameter
    }

    byName.set(name, {
      cls,
      freqInBlock: agg.freq,
      firstFileOffset: firstFileOffset.get(name) ?? agg.first,
      firstBlockOffset: agg.first,
      isCapture,
      homeFn,
      proximity,
      ...(isModuleTop(text, cls, enclosingFn, homeFn) && { moduleTop: true }),
    });
  }

  addSelfOccurrences(lx, byName, occurrences);
  // Undeclared names are never painted, so they hold no hue in either order.
  // Self names are the only ones addSelfOccurrences adds, and the file-wide
  // orders skip them, so they come from the shared base.
  const declared = (name: string): boolean => declOffsets.has(name);
  const fileWide = heuristicFileWide(base, fnRanges);
  const fnNames = fnLocalsFor(base, base.occurrences, declOffsets, fnRanges, colorScopeFn);
  return {
    docVersion,
    focusKey,
    byName,
    occurrences,
    fileGlobalsInOrder: fileWide.fileGlobalsInOrder,
    fnLocalsInOrder: fnNames.locals,
    fnGlobals: fnNames.globals.filter(declared),
    colorScopeFn,
    enclosingFn,
    shadowScopes: fileWide.shadowScopes,
    declSites: base.declSites,
    staticNames: new Set(),
    excludeRanges: excluded,
    source: 'heuristic',
  };
}
