'use strict';
// Random walks over editor events, each step compared with a fresh Decorator
// given the same final state. Model, oracle and limits: docs/runtime.md#transitions.

const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
const { Decorator, isDecoratable } = require('../out/decorator');
const { lex, lexFor } = require('../out/lex');
const focus = require('../out/focus');
const html = require('../out/html');
const sfc = require('../out/sfc');
const { LUA_KEYWORDS } = require('../out/lua');
const { RUBY_KEYWORDS } = require('../out/ruby');
const { isZigReserved } = require('../out/zig');
const { mayForceMove } = require('../out/tracking');
const { jsNamespaceNames } = require('../out/imports');
const { shellTables } = require('../out/shell');

// ── Fake time ─────────────────────────────────────────────────────────────────

const real = { setTimeout, clearTimeout, setImmediate, now: Date.now };

class Clock {
  constructor(now) {
    this.now = now;
    this.seq = 0;
    this.timers = new Map();
  }
  set(fn, ms, args) {
    const id = ++this.seq;
    const handle = { id, clock: this, ref: () => handle, unref: () => handle, hasRef: () => true };
    this.timers.set(id, { id, at: this.now + Math.max(0, Number(ms) || 0), fn, args });
    return handle;
  }
  next() {
    let best;
    for (const t of this.timers.values()) {
      if (!best || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
    }
    return best;
  }
}

let clock;
function enterFakeTime() {
  globalThis.setTimeout = (fn, ms, ...args) => clock.set(fn, ms, args);
  globalThis.clearTimeout = (h) => (h && h.clock ? h.clock.timers.delete(h.id) : real.clearTimeout(h));
  Date.now = () => clock.now;
}
function exitFakeTime() {
  globalThis.setTimeout = real.setTimeout;
  globalThis.clearTimeout = real.clearTimeout;
  Date.now = real.now;
}

/**
 * Drain every queued microtask, and the ones they queue, plus the classify's
 * setImmediate yields: each takes one turn of the event loop, and a classify
 * takes at most two in a row.
 */
const flush = async () => {
  for (let turn = 0; turn < 3; turn++) await new Promise((r) => real.setImmediate(r));
};

/** Run `c`'s timers in due order up to `ms` from now, draining microtasks between them. */
async function advance(c, ms) {
  const target = c.now + ms;
  await flush();
  for (;;) {
    const t = c.next();
    if (!t || t.at > target) break;
    c.timers.delete(t.id);
    c.now = Math.max(c.now, t.at);
    t.fn(...t.args);
    await flush();
  }
  c.now = target;
  await flush();
}

// ── The screen: what VS Code shows per editor ─────────────────────────────────

/**
 * VS Code's tracked-range update for one replace edit, ported from the editor's
 * interval tree (`nodeAcceptEdit`, VS Code 1.144.1 workbench.desktop.main.js),
 * without collapseOnReplaceEdit, which extension decorations never set.
 * Stickiness is the decoration type's rangeBehavior: 0 OpenOpen, 1 ClosedClosed,
 * 2 OpenClosed, 3 ClosedOpen. `force` is the edit's forceMoveMarkers, which
 * formatters, workspace edits, completion's additional edits and a reload set.
 */
function acceptEdit(nodeStart, nodeEnd, start, end, inserting, stickiness, force = false) {
  const startStick = stickiness === 0 || stickiness === 2;
  const endStick = stickiness === 1 || stickiness === 2;
  const deleting = end - start;
  const common = Math.min(deleting, inserting);
  const MOVE = 1;
  const STAY = 2;
  const DEFINED = 0;
  const before = (marker, stick, check, sem) =>
    marker < check ? true : marker > check || sem === MOVE ? false : sem === STAY ? true : stick;
  let s = nodeStart;
  let e = nodeEnd;
  let sDone = false;
  let eDone = false;
  const sem1 = force ? MOVE : deleting > 0 ? STAY : DEFINED;
  if (before(nodeStart, startStick, start, sem1)) sDone = true;
  if (before(nodeEnd, endStick, start, sem1)) eDone = true;
  if (common > 0 && !force) {
    const sem2 = deleting > inserting ? STAY : DEFINED;
    if (!sDone && before(nodeStart, startStick, start + common, sem2)) sDone = true;
    if (!eDone && before(nodeEnd, endStick, start + common, sem2)) eDone = true;
  }
  const sem3 = force ? MOVE : DEFINED;
  if (!sDone && before(nodeStart, startStick, end, sem3)) {
    s = start + inserting;
    sDone = true;
  }
  if (!eDone && before(nodeEnd, endStick, end, sem3)) {
    e = start + inserting;
    eDone = true;
  }
  const delta = inserting - deleting;
  if (!sDone) s = Math.max(0, nodeStart + delta);
  if (!eDone) e = Math.max(0, nodeEnd + delta);
  return [s, Math.max(s, e)];
}

/** VS Code validates a decoration range against the model: positions clamp to the text. */
function clampOffset(doc, pos) {
  const line = Math.min(Math.max(pos.line, 0), doc.lineCount - 1);
  const len = doc.lineAt(line).text.length;
  return doc.offsetAt(new vs.Position(line, Math.min(Math.max(pos.character, 0), len)));
}

/** An editor whose decorations live as offsets and move with every edit, like VS Code's. */
function makeEditor(doc, offset = 0) {
  const p = doc.positionAt(Math.min(offset, doc.getText().length));
  const ed = new stub.TextEditor(doc, p.line, p.character);
  ed.screen = new Map();
  ed.setDecorations = (type, ranges) => {
    ed.screen.set(type, ranges.map((r) => [clampOffset(doc, r.start), clampOffset(doc, r.end)]));
  };
  return ed;
}

const caretOf = (ed) => ed.document.offsetAt(ed.selection.active);
function setCaret(ed, offset) {
  const p = ed.document.positionAt(Math.max(0, Math.min(offset, ed.document.getText().length)));
  ed.selection = new vs.Selection(p.line, p.character, p.line, p.character);
}

// ── Decoration state, normalised to what is visible ───────────────────────────

const STYLE_KEYS = ['color', 'fontWeight', 'fontStyle', 'textDecoration', 'backgroundColor'];
function styleOf(type) {
  const o = type.options ?? {};
  const parts = STYLE_KEYS.filter((k) => o[k] !== undefined).map((k) => `${k}=${o[k]}`);
  if (o.gutterIconPath) parts.push(`gutter=${o.gutterIconPath.toString().length}:${o.gutterIconPath.toString().slice(-40)}`);
  return parts.join(',');
}

function rolesOf(d) {
  const m = new Map([[d.gutterDecoration, 'gutter']]);
  d.pool.id.forEach((t, i) => m.set(t, `id${i}`));
  d.pool.idg.forEach((t, i) => m.set(t, `idg${i}`));
  for (const k of ['self', 'riskAsync', 'riskDanger', 'riskEscape', 'numberEngaged', 'placeholder',
    'commentRestore', 'stringRestore', 'constantRestore', 'operatorRestore', 'bracketRestore', 'attributeRestore', 'callRestore', 'importRestore', 'shadowRestore', 'mdHighlight', 'mdLinkPlain']) {
    m.set(d.pool[k], k);
  }
  return m;
}

const BAND2_ROLE = /^(id|idg)\d$|^riskEscape$/;
const IMPORT_ROLE = /^(importRestore|shadowRestore)$/;

function merged(iv) {
  const xs = iv.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of xs) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Gutter icons draw on every line a range covers, a collapsed range included. */
function gutterLines(doc, iv) {
  const lines = new Set();
  for (const [s, e] of iv) {
    for (let l = doc.positionAt(s).line; l <= doc.positionAt(e).line; l++) lines.add(l);
  }
  return [...lines].sort((a, b) => a - b).map((l) => [l, l]);
}

/** Every visible editor's decorations by role and style, plus the status bar. */
function snapshot(d, editors) {
  const roles = rolesOf(d);
  const shown = editors.map((ed) => {
    const out = {};
    for (const [type, iv] of ed.screen) {
      if (type.disposed) continue;
      const role = roles.get(type) ?? `stray#${type.id}`;
      const norm = role === 'gutter' ? gutterLines(ed.document, iv) : merged(iv);
      if (norm.length > 0) out[`${role} ${styleOf(type)}`] = norm;
    }
    return { uri: ed.document.uri.toString(), out };
  });
  const s = d.statusItem;
  return { editors: shown, status: s.visible ? s.text : '(hidden)' };
}

function mask(snap, re) {
  for (const e of snap.editors) for (const k of Object.keys(e.out)) if (re.test(k.split(' ')[0])) delete e.out[k];
}

function describe(doc, iv, role) {
  if (role === 'gutter') return `lines ${iv.map(([l]) => l).join(',')}`;
  const text = doc.getText();
  return iv.slice(0, 6).map(([s, e]) => {
    const p = doc.positionAt(s);
    return `${p.line}:${p.character}${e > s ? `=${JSON.stringify(text.slice(s, Math.min(e, s + 24)))}` : ''}`;
  }).join(' ') + (iv.length > 6 ? ` …+${iv.length - 6}` : '');
}

function diffSnapshots(got, want, editors) {
  if (got.status !== want.status) return `status bar: walked "${got.status}", fresh "${want.status}"`;
  if (got.editors.length !== want.editors.length) return `editor count ${got.editors.length} vs ${want.editors.length}`;
  for (let i = 0; i < got.editors.length; i++) {
    const g = got.editors[i].out;
    const w = want.editors[i].out;
    for (const k of [...new Set([...Object.keys(g), ...Object.keys(w)])].sort()) {
      if (JSON.stringify(g[k] ?? []) !== JSON.stringify(w[k] ?? [])) {
        const doc = editors[i].document;
        const role = k.split(' ')[0];
        return `editor ${i} (${doc.uri.toString().split('/').pop()} v${doc.version}) ${role}:\n` +
          `    walked: ${(g[k] && describe(doc, g[k], role)) || '(none)'}\n` +
          `    fresh:  ${(w[k] && describe(doc, w[k], role)) || '(none)'}`;
      }
    }
  }
  return null;
}

const MD_MARKS = new Set(['mdHighlight', 'mdLinkPlain']);
const NO_MARKS = new Set();
const BAND1_SELF = new Set(['self']);
const isDataDoc = (doc) => DATA_LANGS.has(doc.languageId) || doc.fileName.endsWith('.zon') || doc.languageId === 'cmake' || /\.gradle(\.kts)?$/.test(doc.fileName);

/**
 * A data file's editor shows nothing in any state, whatever the fresh Decorator
 * paints, and a prose file's only the markdown marks, if its id takes them. ZON
 * opens under `zig`. A Gradle script is static content whose band 1 is Groovy's or
 * Kotlin's, so it shows `this` and nothing else.
 */
function nonFlowPaint(snap, editors) {
  for (let i = 0; i < editors.length; i++) {
    const doc = editors[i].document;
    const kind = isDataDoc(doc) ? 'data' : PROSE_LANGS.has(doc.languageId) ? 'prose' : null;
    if (!kind) continue;
    const allowed = MARKED_LANGS.has(doc.languageId) ? MD_MARKS : /\.gradle(\.kts)?$/.test(doc.fileName) ? BAND1_SELF : NO_MARKS;
    const roles = Object.keys(snap.editors[i].out).map((k) => k.split(' ')[0]).filter((r) => !allowed.has(r));
    if (roles.length) return `editor ${i} (${doc.uri.toString().split('/').pop()} v${doc.version}) is a ${kind} file and shows ${roles.join(', ')}`;
  }
  return null;
}

const lexKey = (x) => JSON.stringify([x.spans, x.holes, x.idents.map((i) => [i.name, i.offset]), x.numbers, x.punct]);

/**
 * A shown document whose cached lex differs from a fresh lex of its text. The oracle
 * shares the lex memo with the walked Decorator, so a wrong incremental re-lex would
 * reach both and leave their paints equal.
 */
function staleLex(d, editors) {
  for (const ed of editors) {
    const doc = ed.document;
    const state = d.blockCache.get(doc);
    if (!state || state.version !== doc.version) continue;
    const lang = focus.effectiveLanguageId(doc.languageId, doc.fileName);
    if (lexKey(state.lex) !== lexKey(lex(html.flowText(doc.getText(), lang), lang))) return `${doc.fileName} v${doc.version}: the cached lex differs from a fresh one`;
  }
  return null;
}

/** A request for a data or prose document, which the layer never asks a server about. ZON's go to zls. */
function nonFlowAsked(docs) {
  const kinds = new Map();
  for (const d of docs) {
    if (d.fileName.endsWith('.zon')) continue;
    if (isDataDoc(d)) kinds.set(d.uri.toString(), 'data');
    else if (PROSE_LANGS.has(d.languageId)) kinds.set(d.uri.toString(), 'prose');
  }
  const hit = stub.lspCalls.find(([, uri]) => uri && kinds.has(uri.toString()));
  return hit ? `${hit[0]} asked about ${hit[1].toString().split('/').pop()}, a ${kinds.get(hit[1].toString())} file` : null;
}

// ── The language server ───────────────────────────────────────────────────────

const LEGEND = {
  tokenTypes: ['variable', 'parameter', 'property', 'function', 'class', 'struct', 'namespace',
    'keyword', 'selfKeyword', 'selfTypeKeyword', 'const', 'string', 'type', 'typeParameter', 'method'],
  tokenModifiers: ['declaration', 'readonly', 'defaultLibrary', 'static'],
};
const KEYWORDS = new Set(('import from as export class private async await const let var for if return function new ' +
  'def in range len True False None pub struct impl fn use mut self Self crate super Ok package func type ' +
  'nil this string number any int error usize u32 str Result String true false while else elif').split(' '));

/**
 * A server's answer for `text`: every code identifier, typed from its neighbours,
 * and with `strings` every string literal's lines, as lua-language-server types
 * them under `Lua.semantic.keyword`.
 */
function tokensFor(text, languageId, degraded, strings) {
  if (languageId === 'ruby') return encode(text, rubyLspTokens(text));
  if (languageId === 'fish') return encode(text, fishLspTokens(text, degraded));
  if (languageId === 'shellscript') return encode(text, []);
  if (languageId === 'html') return encode(text, htmlServerTokens(text, degraded));
  if (sfc.COMPONENT_LANGUAGES.has(languageId)) return encode(text, componentServerTokens(text, languageId, degraded));
  if (languageId === 'zig') return encode(text, zigLspTokens(text, strings));
  if (CJVM_LANGUAGES.has(languageId)) return encode(text, cjvmServerTokens(text, languageId, degraded));
  if (languageId === 'swift') return encode(text, sourcekitTokens(text, degraded));
  const toks = [];
  const declared = new Set();
  const js = languageId === 'javascript' || languageId === 'javascriptreact';
  const namespaces = js ? jsNamespaceNames(lexFor(text, languageId)) : new Set();
  for (const id of lexFor(text, languageId).idents) {
    let type;
    const mods = [];
    if (languageId === 'rust' && (id.name === 'Self' || id.name === 'crate' || id.name === 'super')) {
      type = degraded ? (id.name === 'Self' ? 'struct' : 'namespace') : (id.name === 'Self' ? 'selfTypeKeyword' : 'keyword');
    } else if (js && namespaces.has(id.name) && text[id.offset - 1] !== '.') {
      // tsserver sends no token for a project file's `import * as` binding; Deno types it `variable`.
      if (!degraded) continue;
      type = 'variable';
    } else if (js && id.name === 'self') {
      type = 'variable';
    } else if (id.name === 'self' || id.name === 'this') {
      type = degraded ? 'const' : 'selfKeyword';
    } else if (KEYWORDS.has(id.name) || (languageId === 'lua' && LUA_KEYWORDS.has(id.name))) {
      continue;
    } else {
      const next = text[id.offset + id.length];
      type = next === '(' || next === '!' ? 'function'
        : text[id.offset - 1] === '.' ? 'property'
          : /^[A-Z]/.test(id.name) ? 'class' : 'variable';
      if (type === 'variable' && !declared.has(id.name)) {
        declared.add(id.name);
        mods.push('declaration');
      }
    }
    toks.push({ offset: id.offset, length: id.length, type, modifiers: mods });
  }
  if (strings) {
    for (const s of lexFor(text, languageId).spans) {
      if (s.region !== 'string') continue;
      for (let at = s.start; at < s.end;) {
        const nl = text.indexOf('\n', at);
        const end = nl < 0 || nl >= s.end ? s.end : nl;
        if (end > at) toks.push({ offset: at, length: end - at, type: 'string', modifiers: [] });
        at = end + 1;
      }
    }
    toks.sort((a, b) => a.offset - b.offset);
  }
  return encode(text, toks);
}

/**
 * fish-lsp's shape: `variable` over every variable name, a declaration and a use
 * alike, and `function` over each command; `degraded` sends the commands only.
 * bash-language-server sends no tokens at all.
 */
function fishLspTokens(text, degraded) {
  const t = shellTables(lexFor(text, 'fish'));
  const toks = t.commands.filter((c) => c.name).map((c) => ({ offset: c.offset, length: c.name.length, type: 'function', modifiers: [] }));
  if (!degraded) for (const v of t.vars) toks.push({ offset: v.offset, length: v.length, type: 'variable', modifiers: [] });
  return toks.sort((a, b) => a.offset - b.offset);
}

const CJVM_LANGUAGES = new Set(['c', 'cpp', 'java', 'kotlin']);
const CJVM_KEYWORDS = new Set(('auto break case char const continue default do double else enum extern float for goto if ' +
  'inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while ' +
  'bool true false nullptr constexpr class namespace template typename this using virtual public private protected ' +
  'new delete throw try catch operator override final noexcept mutable explicit friend static_cast const_cast ' +
  'reinterpret_cast dynamic_cast decltype std abstract boolean byte extends implements import instanceof interface ' +
  'package super synchronized throws transient var record sealed permits yield null fun val is in as when object ' +
  'companion init lateinit data suspend internal it typealias by').split(' '));

/**
 * C, C++, Java and Kotlin servers: `ok` types like clangd and jdtls, with a
 * `declaration` on each first occurrence; `degraded` is each language's other shape.
 * cpptools sends no `declaration` modifier at all; kotlin-language-server adds a
 * `variable` over each `$name` template and types a local `val` as
 * `property.declaration`; jdtls types a field read bare as `property`.
 */
function cjvmServerTokens(text, languageId, degraded) {
  const lx = lexFor(text, languageId);
  const toks = [];
  const declared = new Set();
  const fields = new Set();
  for (const id of lx.idents) {
    if (CJVM_KEYWORDS.has(id.name)) continue;
    const next = text[id.offset + id.length];
    const before = text.slice(Math.max(0, id.offset - 4), id.offset);
    let type = next === '(' ? 'function'
      : text[id.offset - 1] === '.' || before.endsWith('->') ? 'property'
        : /^[A-Z]/.test(id.name) ? 'class' : 'variable';
    const mods = [];
    if (type === 'variable' && languageId === 'java' && fields.has(id.name)) type = 'property';
    if (type === 'variable' && !declared.has(id.name)) {
      declared.add(id.name);
      if (!(degraded && (languageId === 'c' || languageId === 'cpp'))) mods.push('declaration');
      if (degraded && languageId === 'kotlin' && /\bva[lr]\s+$/.test(text.slice(Math.max(0, id.offset - 6), id.offset))) type = 'property';
      if (degraded && languageId === 'java' && /^\s*(?:private|protected|public)\b/.test(text.slice(text.lastIndexOf('\n', id.offset) + 1, id.offset))) {
        type = 'property';
        fields.add(id.name);
      }
    }
    if (degraded && languageId === 'kotlin' && text[id.offset - 1] === '$' && !lx.isCode(id.offset - 1)) {
      toks.push({ offset: id.offset - 1, length: id.length + 1, type: 'variable', modifiers: [] });
    }
    toks.push({ offset: id.offset, length: id.length, type, modifiers: mods });
  }
  return toks;
}

const SWIFT_WORDS = new Set(('import public private fileprivate internal open struct class enum actor protocol extension ' +
  'func init deinit subscript var let static final override mutating async throws await try return if guard else for in ' +
  'while repeat switch case default break continue fallthrough throw do catch defer where as is self Self super nil true ' +
  'false some any inout get set willSet didSet nonisolated unowned weak lazy unsafe').split(' '));

/**
 * sourcekit-lsp 6.4's shape: no token at a declaration, `variable` over every read
 * (parameters too), `property` over members, `method` over calls, and
 * `method.static.defaultLibrary` over operators and a call on a type (`Type.name(`);
 * `degraded` types only the first half of the file, as an answer for a file that does
 * not type-check.
 */
function sourcekitTokens(text, degraded) {
  const lx = lexFor(text, 'swift');
  const toks = [];
  const declared = new Set();
  for (const id of lx.idents) {
    if (SWIFT_WORDS.has(id.name) || id.name.startsWith('#')) continue;
    if (degraded && id.offset > text.length / 2) break;
    const next = text[id.offset + id.length];
    const onType = next === '(' && text[id.offset - 1] === '.' && /[A-Z]\w*$/.test(text.slice(Math.max(0, id.offset - 40), id.offset - 1));
    const type = onType ? 'method' : next === '(' ? 'function' : text[id.offset - 1] === '.' ? 'property' : /^[A-Z]/.test(id.name) ? 'struct' : 'variable';
    if (type === 'variable' && !declared.has(id.name) && !id.name.startsWith('$')) {
      declared.add(id.name);
      continue;
    }
    toks.push({ offset: id.offset, length: id.length, type, modifiers: onType ? ['static', 'defaultLibrary'] : [] });
  }
  for (const m of text.matchAll(/(?<=\s)(?:==|\+=|<|\.\.<|\+|-=)(?=\s)/g)) {
    if (lx.isCode(m.index)) toks.push({ offset: m.index, length: m[0].length, type: 'method', modifiers: ['static', 'defaultLibrary'] });
  }
  return toks.sort((a, b) => a.offset - b.offset);
}

/**
 * The HTML server's shape: its JavaScript service types every script name and the
 * names in event-handler attributes, and sends nothing for `import * as`'s binding.
 */
function htmlServerTokens(text, degraded) {
  const view = html.scriptView(text);
  const lx = lexFor(view, 'html');
  const namespaces = jsNamespaceNames(lx);
  const ids = lx.idents.filter((id) => !KEYWORDS.has(id.name) && !(namespaces.has(id.name) && view[id.offset - 1] !== '.'));
  for (const m of text.matchAll(/\son\w+="([^"]*)"/g)) {
    const at = m.index + m[0].indexOf('"') + 1;
    for (const w of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) ids.push({ name: w[0], offset: at + w.index, length: w[0].length });
  }
  ids.sort((a, b) => a.offset - b.offset);
  const declared = new Set();
  return ids.map((id) => {
    const next = text[id.offset + id.length];
    const type = next === '(' ? 'function' : text[id.offset - 1] === '.' ? 'property' : /^[A-Z]/.test(id.name) && !degraded ? 'class' : 'variable';
    const mods = type === 'variable' && !declared.has(id.name) ? ['declaration'] : [];
    if (type === 'variable') declared.add(id.name);
    return { offset: id.offset, length: id.length, type, modifiers: mods };
  });
}

/**
 * The component servers' shape (tsserver with the Vue plugin, the Svelte and Astro
 * servers): every name in a script or a template expression, nothing for `import * as`'s
 * binding, and Vue's `component` on a capitalised tag in the markup.
 */
function componentServerTokens(text, languageId, degraded) {
  const view = html.flowText(text, languageId);
  const lx = lexFor(view, languageId);
  const namespaces = jsNamespaceNames(lx);
  const ids = lx.idents.filter((id) => !KEYWORDS.has(id.name) && !(namespaces.has(id.name) && view[id.offset - 1] !== '.'));
  const declared = new Set();
  const toks = ids.map((id) => {
    const next = view[id.offset + id.length];
    const type = next === '(' ? 'function' : view[id.offset - 1] === '.' ? 'property' : /^[A-Z]/.test(id.name) && !degraded ? 'class' : 'variable';
    const mods = type === 'variable' && !declared.has(id.name) ? ['declaration'] : [];
    if (type === 'variable') declared.add(id.name);
    return { offset: id.offset, length: id.length, type, modifiers: mods };
  });
  if (languageId === 'vue') {
    for (const m of text.matchAll(/<\/?([A-Z]\w*)/g)) toks.push({ offset: m.index + m[0].length - m[1].length, length: m[1].length, type: 'component', modifiers: [] });
  }
  return toks.sort((a, b) => a.offset - b.offset);
}

/**
 * zls 0.17's shape under vscode-zig's `partial` setting: identifiers only, none on
 * keywords, primitive types or `@builtins`; TitleCase `type`, a member `property`, a
 * callee `function`, a name before `: type` `typeParameter`, `self` `parameter`, the
 * rest `variable`, `declaration` after `const`, `var` and `|`. With `strings`, the
 * `full` setting: one `string` token per literal line as well.
 */
function zigLspTokens(text, strings) {
  const lx = lexFor(text, 'zig');
  const toks = [];
  for (const id of lx.idents) {
    if (isZigReserved(id.name) || (id.name[0] === '@' && id.name[1] !== '"') || id.name === '_') continue;
    const after = text.slice(id.offset + id.length, id.offset + id.length + 8);
    const p = lx.prevSignificant(id.offset);
    const type = text[p] === '.' ? 'property' : /^\s*\(/.test(after) ? 'function' : /^: type\b/.test(after) ? 'typeParameter'
      : /^[A-Z]/.test(id.name) ? 'type' : id.name === 'self' ? 'parameter' : 'variable';
    const before = text.slice(Math.max(0, id.offset - 6), id.offset);
    const mods = /(const |var |\||, )$/.test(before) && type !== 'property' ? ['declaration'] : [];
    toks.push({ offset: id.offset, length: id.length, type, modifiers: mods });
  }
  if (strings) {
    for (const s of lx.spans) if (s.region === 'string') toks.push({ offset: s.start, length: s.end - s.start, type: 'string', modifiers: [] });
    toks.sort((a, b) => a.offset - b.offset);
  }
  return toks;
}

/**
 * ruby-lsp 0.26's shape: `variable` on every read of a name after its first
 * occurrence (a write gets no token), `self` as `variable.defaultLibrary`, nothing
 * on keywords, constants, `@x`, `$x`, members or calls with parentheses.
 */
function rubyLspTokens(text) {
  const toks = [];
  const seen = new Set();
  for (const id of lexFor(text, 'ruby').idents) {
    if (id.name === 'self') {
      toks.push({ offset: id.offset, length: id.length, type: 'variable', modifiers: ['defaultLibrary'] });
      continue;
    }
    if (RUBY_KEYWORDS.has(id.name) || /^[A-Z@$]/.test(id.name) || text[id.offset - 1] === '.' || text[id.offset + id.length] === '(') continue;
    if (seen.has(id.name)) toks.push({ offset: id.offset, length: id.length, type: 'variable', modifiers: [] });
    seen.add(id.name);
  }
  return toks;
}

function encode(text, toks) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const data = [];
  let pl = 0;
  let pc = 0;
  let l = 0;
  for (const t of toks) {
    while (l + 1 < starts.length && starts[l + 1] <= t.offset) l++;
    const c = t.offset - starts[l];
    data.push(l - pl, l === pl ? c - pc : c, t.length, LEGEND.tokenTypes.indexOf(t.type),
      t.modifiers.reduce((b, m) => b | (1 << LEGEND.tokenModifiers.indexOf(m)), 0));
    pl = l;
    pc = c;
  }
  return { data };
}

/** Python document symbols as Pylance nests them: a class or `def` block each, methods inside their class. */
function symbolsFor(text, languageId) {
  if (languageId !== 'python') return [];
  const lines = text.split('\n');
  const top = [];
  const open = [];
  const blocks = [...focus.scanBlocks(text, languageId)].sort((a, b) => a.openOffset - b.openOffset);
  for (const b of blocks) {
    const m = /^\s*(?:async\s+)?(def|class)\s+(\w+)/.exec(lines[b.openLine] ?? '');
    if (!m) continue;
    while (open.length && open[open.length - 1].block.closeOffset < b.openOffset) open.pop();
    const parent = open[open.length - 1];
    const kind = m[1] === 'class' ? 4 : parent?.kind === 4 ? vs.SymbolKind.Method : vs.SymbolKind.Function;
    const sym = { name: m[2], kind, range: new vs.Range(b.openLine, 0, b.closeLine, lines[b.closeLine].length), children: [], block: b };
    (parent ? parent.children : top).push(sym);
    open.push(sym);
  }
  return top;
}

/** clangd's legend, which sourcekit-lsp registers for C-family documents. */
const CLANGD_LEGEND = {
  tokenTypes: ['variable', 'variable', 'parameter', 'function', 'method', 'function', 'property', 'variable', 'class', 'interface', 'enum',
    'enumMember', 'type', 'type', 'unknown', 'namespace', 'typeParameter', 'concept', 'type', 'macro', 'modifier', 'operator', 'bracket', 'label', 'comment'],
  tokenModifiers: ['declaration', 'definition', 'deprecated', 'deduced', 'readonly', 'static', 'abstract', 'virtual', 'dependentName', 'defaultLibrary',
    'usedAsMutableReference', 'usedAsMutablePointer', 'constructorOrDestructor', 'userDefined', 'functionScope', 'classScope', 'fileScope', 'globalScope'],
};
/** sourcekit-lsp's legend indices, which its C-family data carry under clangd's legend. */
const SK_TYPES = ['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property', 'enumMember',
  'event', 'function', 'method', 'macro'];

/** An Objective-C answer as sourcekit-lsp sends it: clangd's legend, its own indices. */
function sourcekitObjcAnswer(text) {
  const toks = cjvmServerTokens(text, 'c', false).map((t) => ({ ...t, type: t.type === 'class' ? 'class' : t.type === 'function' ? 'method' : t.type }));
  for (const t of toks) if (t.type === 'class') t.modifiers = [...t.modifiers, 'defaultLibrary'];
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const data = [];
  let pl = 0, pc = 0, l = 0;
  for (const t of toks) {
    while (l + 1 < starts.length && starts[l + 1] <= t.offset) l++;
    const c = t.offset - starts[l];
    const mods = (t.modifiers.includes('declaration') ? 1 : 0) | (t.modifiers.includes('defaultLibrary') ? 1 << 9 : 0) | (1 << 20);
    data.push(l - pl, l === pl ? c - pc : c, t.length, SK_TYPES.indexOf(t.type), mods);
    pl = l;
    pc = c;
  }
  return { data };
}

function answerFor(cmd, text, languageId, mode, symbols) {
  if (mode === 'none') return undefined;
  if (mode === 'sourcekit-objc') {
    if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return CLANGD_LEGEND;
    if (cmd === 'vscode.provideDocumentSemanticTokens') return sourcekitObjcAnswer(text);
    return [];
  }
  if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return LEGEND;
  if (cmd === 'vscode.provideDocumentSemanticTokens') {
    return mode === 'empty' ? undefined : tokensFor(text, languageId, mode === 'degraded', mode === 'strings');
  }
  if (cmd === 'vscode.executeDocumentSymbolProvider') return symbols ? symbolsFor(text, languageId) : [];
  return undefined;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIX = path.join(__dirname, 'fixtures/transitions');
const FIXTURES = {
  ts: { lang: 'typescript', file: 'walk.ts' },
  js: { lang: 'javascript', file: 'walk.js' },
  html: { lang: 'html', file: 'walk.html' },
  vue: { lang: 'vue', file: 'walk.vue', component: true },
  svelte: { lang: 'svelte', file: 'walk.svelte', component: true },
  astro: { lang: 'astro', file: 'walk.astro', component: true },
  tsx: { lang: 'typescriptreact', file: 'walk.tsx', component: true },
  jsx: { lang: 'javascriptreact', file: 'walk.jsx', component: true },
  py: { lang: 'python', file: 'walk.py' },
  rs: { lang: 'rust', file: 'walk.rs' },
  go: { lang: 'go', file: 'walk.go' },
  md: { lang: 'markdown', file: 'walk.md', prose: true, marks: true },
  kdl: { lang: 'kdl', file: 'walk.kdl', data: true },
  yaml: { lang: 'yaml', file: 'walk.yaml', data: true },
  workflow: { lang: 'github-actions-workflow', file: 'walk.workflow.yml', data: true },
  compose: { lang: 'dockercompose', file: 'walk.compose.yaml', data: true },
  toml: { lang: 'toml', file: 'walk.toml', data: true },
  json: { lang: 'json', file: 'walk.json', data: true },
  jsonc: { lang: 'jsonc', file: 'walk.jsonc', data: true },
  ini: { lang: 'ini', file: 'walk.ini', data: true },
  gitconfig: { lang: 'properties', file: 'walk.gitconfig', data: true },
  env: { lang: 'dotenv', file: 'walk.env', data: true },
  gitignore: { lang: 'ignore', file: 'walk.gitignore', data: true },
  css: { lang: 'css', file: 'walk.css', web: true },
  tailwind: { lang: 'tailwindcss', file: 'walk.css', web: true },
  xml: { lang: 'xml', file: 'walk.xml', web: true },
  hbs: { lang: 'handlebars', file: 'walk.hbs', web: true },
  dockerfile: { lang: 'dockerfile', file: 'walk.Dockerfile', container: true },
  bake: { lang: 'dockerbake', file: 'walk.docker-bake.hcl', container: true },
  helm: { lang: 'helm', file: 'walk.helm.yaml', container: true },
  k8s: { lang: 'yaml', file: 'walk.k8s.yaml', container: true },
  doc: { lang: 'python', file: 'reclose.py' },
  lua: { lang: 'lua', file: 'walk.lua' },
  rb: { lang: 'ruby', file: 'walk.rb' },
  zig: { lang: 'zig', file: 'walk.zig' },
  zon: { lang: 'zig', file: 'walk.zon' },
  c: { lang: 'c', file: 'walk.c' },
  cpp: { lang: 'cpp', file: 'walk.cpp' },
  java: { lang: 'java', file: 'walk.java' },
  kt: { lang: 'kotlin', file: 'walk.kt' },
  cmake: { lang: 'cmake', file: 'walk.cmake', cjvmStatic: true },
  swift: { lang: 'swift', file: 'walk.swift' },
  objc: { lang: 'objective-c', file: 'walk.m' },
  objcpp: { lang: 'objective-cpp', file: 'walk.m' },
  objch: { lang: 'cpp', file: 'walk.h' },
  metal: { lang: 'metal', file: 'walk.metal', noServer: true },
  strings: { lang: 'strings', file: 'walk.strings', cjvmStatic: true },
  pbxproj: { lang: 'project.pbxproj', file: 'walk.pbxproj', cjvmStatic: true },
  xcconfig: { lang: 'xcconfig', file: 'walk.xcconfig', cjvmStatic: true },
  plist: { lang: 'plist', file: 'walk.plist', cjvmStatic: true },
  'plist-xml': { lang: 'xml', file: 'walk.plist', cjvmStatic: true },
  'gradle.kts': { lang: 'kotlin', file: 'walk.gradle.kts', cjvmStatic: true },
  'gradle-kotlin-dsl': { lang: 'gradle-kotlin-dsl', file: 'walk.gradle.kts', cjvmStatic: true },
  groovy: { lang: 'groovy', file: 'walk.groovy', noServer: true },
  gradle: { lang: 'groovy', file: 'walk.gradle', cjvmStatic: true },
  prompt: { lang: 'prompt', file: 'walk.prompt.md', prose: true, marks: true },
  instructions: { lang: 'instructions', file: 'walk.instructions.md', prose: true, marks: true },
  chatagent: { lang: 'chatagent', file: 'walk.agent.md', prose: true, marks: true },
  skill: { lang: 'skill', file: 'walk.skill.md', prose: true, marks: true },
  jmd: { lang: 'juliamarkdown', file: 'walk.jmd', prose: true },
  mdx: { lang: 'mdx', file: 'walk.mdx', prose: true, marks: 'link' },
  php: { lang: 'php', file: 'walk.php' },
  scss: { lang: 'scss', file: 'walk.scss', sheet: true },
  less: { lang: 'less', file: 'walk.less', sheet: true },
  stylus: { lang: 'stylus', file: 'walk.styl', sheet: true },
  postcss: { lang: 'postcss', file: 'walk.pcss', sheet: true },
  tailwind4: { lang: 'tailwindcss', file: 'walk.tw4.css', sheet: true },
  graphql: { lang: 'graphql', file: 'walk.graphql', sheet: true },
  razor: { lang: 'razor', file: 'walk.razor', sheet: true },
  cshtml: { lang: 'razor', file: 'walk.cshtml', sheet: true },
  aspnet: { lang: 'aspnetcorerazor', file: 'walk.razor', sheet: true },
  sh: { lang: 'shellscript', file: 'walk.sh' },
  zsh: { lang: 'shellscript', file: 'walk.zsh' },
  fish: { lang: 'fish', file: 'walk.fish' },
  sql: { lang: 'sql', file: 'walk.sql', tooling: true },
  diff: { lang: 'diff', file: 'walk.diff', tooling: true },
  rebase: { lang: 'git-rebase', file: 'walk.git-rebase-todo', tooling: true },
  proto3: { lang: 'proto3', file: 'walk.proto', tooling: true },
  proto: { lang: 'proto', file: 'walk.proto', tooling: true },
  buf: { lang: 'buf-config', file: 'walk.buf.yaml', tooling: true },
};
for (const f of Object.values(FIXTURES)) f.text = fs.readFileSync(path.join(FIX, f.file), 'utf8');
const DATA_KEYS = Object.keys(FIXTURES).filter((k) => FIXTURES[k].data);
const CONTAINER_KEYS = Object.keys(FIXTURES).filter((k) => FIXTURES[k].container);
/** Static files walked beside walk.html only, so the main walks' data files and seeds stay as they were. */
const WEB_KEYS = Object.keys(FIXTURES).filter((k) => FIXTURES[k].web);
/** Stylesheets, GraphQL and Razor, walked beside a code file by their own generator, so the other walks' seeds stay as they were. */
const SHEET_KEYS = Object.keys(FIXTURES).filter((k) => FIXTURES[k].sheet);
/** SQL, diffs, rebase todos, Protobuf and buf's config, walked beside the shell files by their own generator. */
const TOOLING_KEYS = Object.keys(FIXTURES).filter((k) => FIXTURES[k].tooling);
const DATA_LANGS = new Set([...DATA_KEYS, ...CONTAINER_KEYS, ...WEB_KEYS, ...SHEET_KEYS, ...TOOLING_KEYS].map((k) => FIXTURES[k].lang));
const PROSE_KEYS = Object.keys(FIXTURES).filter((k) => FIXTURES[k].prose && k !== 'md' && k !== 'mdx');
const PROSE_LANGS = new Set(Object.values(FIXTURES).filter((f) => f.prose).map((f) => f.lang));
const MARKED_LANGS = new Set(Object.values(FIXTURES).filter((f) => f.marks).map((f) => f.lang));

// ── The world ─────────────────────────────────────────────────────────────────

const DWELLS = [
  { editToFocus: 2000, focusToSurvey: 24000, minHold: 350 },
  { editToFocus: 400, focusToSurvey: 3000, minHold: 100 },
  { editToFocus: 2000, focusToSurvey: 24000, minHold: 0 },
];

let walkSeq = 0;

class World {
  constructor(cfg) {
    this.cfg = cfg;
    this.clock = new Clock(1_000_000);
    clock = this.clock;
    this.walk = walkSeq++;
    this.entries = cfg.docs.map((key, i) => ({
      key,
      lang: FIXTURES[key].lang,
      uri: `file:///w${this.walk}/${i}.${key}`,
      text: FIXTURES[key].text,
      doc: null,
      alive: false,
      caret: 0,
    }));
    this.docs = [];
    this.undo = new Map();
    this.provider = {};
    for (const e of this.entries) this.provider[e.lang] = { ...(cfg.provider?.[e.lang] ?? { mode: 'ok', latency: 0 }) };
    this.calls = new Map(); // doc → version → { pending, last }
    this.onePending = new Map(); // doc → cpptools' waiting request and answer for one version
    this.cancelled = 0;
    this.held = [];
    this.output = makeEditor(new stub.TextDocument('', 'Log', 'output:okibi-walk'), 0);
    this.panel = false;
    this.groups = [];
    this.focusOn = { kind: 'group', g: 0 };
    this.dark = true;
    this.enabled = true;
    this.dwell = 0;
    this.applyConfig();
    vs.window.activeColorTheme.kind = 2;
    stub.lspCalls.length = 0;
    stub.setLspHandler((cmd, uri) => this.serve(cmd, uri));
  }

  applyConfig() {
    stub.setConfig('enabled', this.enabled);
    stub.setConfig('debug', false);
    stub.setConfig('showPhaseInStatusBar', true);
    const dw = DWELLS[this.dwell];
    stub.setConfig('dwell.editToFocus', dw.editToFocus);
    stub.setConfig('dwell.focusToSurvey', dw.focusToSurvey);
    stub.setConfig('dwell.minHold', dw.minHold);
  }

  // The server: answers for the text as it was when asked, after its latency.
  serve(cmd, uri) {
    const doc = this.docs.find((x) => x.uri.toString() === uri.toString() && this.isLive(x));
    if (!doc) return undefined;
    const { mode, latency, cancels } = this.provider[doc.languageId] ?? { mode: 'none', latency: 0 };
    const value = answerFor(cmd, doc.getText(), doc.languageId, mode, this.cfg.symbols);
    if (cancels && cmd === 'vscode.provideDocumentSemanticTokens' && value !== undefined) return this.serveOnePending(doc, cmd, value, latency, cancels);
    const rec = this.callRecord(doc, doc.version);
    rec.pending++;
    return new Promise((resolve) => {
      const done = () => {
        rec.pending--;
        rec.last[cmd] = value;
        resolve(value);
      };
      if (latency === 'never') this.held.push(done);
      else setTimeout(done, latency);
    });
  }

  /**
   * cpptools' semantic tokens (its SemanticTokensProvider): one request waits per file,
   * and a request while another waits rejects the waiting one as cancelled. A version's
   * answer arrives once, `latency` after its first request, and a later request for it
   * gets that answer at once. `rivals` are the editor's own requests for the version, ms
   * after its first: each cancels whatever waits then.
   */
  serveOnePending(doc, cmd, value, latency, rivals) {
    let st = this.onePending.get(doc);
    if (st && st.version === doc.version && st.answered) return Promise.resolve(st.value);
    if (!st || st.version !== doc.version) {
      st?.waiting?.reject();
      st = { version: doc.version, value, answered: false, waiting: null };
      this.onePending.set(doc, st);
      const rec = this.callRecord(doc, doc.version);
      const deliver = () => {
        if (this.onePending.get(doc) !== st) return;
        st.answered = true;
        rec.last[cmd] = value;
        const w = st.waiting;
        st.waiting = null;
        w?.resolve(value);
      };
      if (latency === 'never') this.held.push(deliver);
      else setTimeout(deliver, latency);
      for (const at of rivals) {
        setTimeout(() => {
          if (this.onePending.get(doc) === st && !st.answered) this.waitOnePending(doc, st).catch(() => {});
        }, at);
      }
    }
    return this.waitOnePending(doc, st);
  }

  waitOnePending(doc, st) {
    if (st.waiting) {
      st.waiting.reject();
      this.cancelled++;
    }
    const rec = this.callRecord(doc, st.version);
    rec.pending++;
    return new Promise((resolve, reject) => {
      st.waiting = {
        resolve: (v) => { rec.pending--; resolve(v); },
        reject: () => { rec.pending--; reject(Object.assign(new Error('Canceled'), { name: 'Canceled' })); },
      };
    });
  }

  callRecord(doc, version) {
    let byVersion = this.calls.get(doc);
    if (!byVersion) this.calls.set(doc, (byVersion = new Map()));
    let rec = byVersion.get(version);
    if (!rec) byVersion.set(version, (rec = { pending: 0, last: {} }));
    return rec;
  }

  isLive(doc) {
    return this.entries.some((e) => e.doc === doc) || doc === this.output.document;
  }

  docFor(entry) {
    if (!entry.alive) {
      entry.doc = new stub.TextDocument(entry.text, entry.lang, entry.uri);
      entry.alive = true;
      this.docs.push(entry.doc);
      this.undo.set(entry.doc, []);
    }
    return entry.doc;
  }

  entryOf(doc) {
    return this.entries.find((e) => e.doc === doc);
  }

  tabFor(entry) {
    return { input: { uri: vs.Uri.parse(entry.uri) }, label: entry.key, entry };
  }

  activeEditor() {
    if (this.focusOn.kind === 'output') return this.panel ? this.output : undefined;
    return this.groups[this.focusOn.g]?.editor ?? undefined;
  }

  visible() {
    return [...this.groups.map((g) => g.editor).filter(Boolean), ...(this.panel ? [this.output] : [])];
  }

  liveEditors() {
    return this.visible();
  }

  sync() {
    vs.window.activeTextEditor = this.activeEditor();
    vs.window.visibleTextEditors = this.visible();
    stub.setTabs(...this.groups.map((g) => g.tabs));
  }

  fireEditors() {
    this.sync();
    stub.events.visibleEditors.fire(vs.window.visibleTextEditors);
    stub.events.activeEditor.fire(vs.window.activeTextEditor);
  }

  /** Show `entry` in group `g`: a new editor at 0:0, then VS Code restores its caret with no `kind`. */
  async show(g, entry) {
    const group = this.groups[g];
    if (group.editor && group.editor.document === entry.doc) return;
    this.stash(group);
    const doc = this.docFor(entry);
    if (!group.tabs.some((t) => t.entry === entry)) group.tabs.push(this.tabFor(entry));
    group.activeTab = group.tabs.findIndex((t) => t.entry === entry);
    group.editor = makeEditor(doc, 0);
    this.focusOn = { kind: 'group', g };
    this.fireEditors();
    await flush();
    if (entry.caret > 0) {
      setCaret(group.editor, entry.caret);
      stub.events.selection.fire({ textEditor: group.editor, selections: group.editor.selections, kind: undefined });
    }
  }

  stash(group) {
    if (group.editor) {
      const entry = this.entryOf(group.editor.document);
      if (entry) entry.caret = caretOf(group.editor);
      group.editor = null;
    }
  }

  async start() {
    this.groups.push({ tabs: [], activeTab: -1, editor: null });
    const [first, second] = this.entries;
    if (second && this.cfg.split) {
      this.groups.push({ tabs: [], activeTab: -1, editor: null });
      this.docFor(second);
      this.groups[1].tabs.push(this.tabFor(second));
      this.groups[1].editor = makeEditor(second.doc, 0);
    }
    this.docFor(first);
    this.groups[0].tabs.push(this.tabFor(first));
    this.groups[0].editor = makeEditor(first.doc, 0);
    if (second && !this.cfg.split) this.groups[0].tabs.push(this.tabFor(second));
    this.sync();
    this.d = new Decorator();
    await advance(this.clock, 0);
  }

  // ── Edits ──

  /**
   * One replace edit, as VS Code delivers it: decorations move with the text at
   * once, the change event fires, and each editor's caret update arrives after it
   * as a selection change with no `kind`. `owner`'s caret is left to the caller.
   * `force` is forceMoveMarkers; `reason` is the event's, 1 for undo.
   */
  async edit(doc, start, end, text, { record = true, owner, force = false, reason } = {}) {
    const editors = this.liveEditors().filter((ed) => ed.document === doc);
    for (const ed of editors) {
      for (const [type, iv] of ed.screen) {
        const stick = type.options?.rangeBehavior ?? 0;
        ed.screen.set(type, iv.map(([s, e]) => acceptEdit(s, e, start, end, text.length, stick, force)));
      }
    }
    const tracked = editors.map((ed) => {
      const at = caretOf(ed);
      return [ed, at >= end ? at + text.length - (end - start) : at > start ? start + text.length : at];
    });
    const old = doc.getText().slice(start, end);
    const ev = { ...doc.applyEdit(start, end, text), reason };
    const entry = this.entryOf(doc);
    if (entry) entry.text = doc.getText();
    if (record) this.undo.get(doc)?.push({ start, length: text.length, text: old });
    stub.events.textDocument.fire(ev);
    await flush();
    for (const [ed, at] of tracked) {
      if (ed === owner) continue;
      const p = doc.positionAt(at);
      if (p.line === ed.selection.active.line && p.character === ed.selection.active.character) continue;
      setCaret(ed, at);
      stub.events.selection.fire({ textEditor: ed, selections: ed.selections, kind: undefined });
    }
  }

  /** Typing at the active editor's caret: the edit, then the caret's selection change. */
  async typeAt(start, end, text, caretAfter = start + text.length, kind = 1) {
    const ed = this.activeEditor();
    if (!ed || !isDecoratable(ed.document)) return;
    await this.edit(ed.document, start, end, text, { owner: ed });
    setCaret(ed, caretAfter);
    stub.events.selection.fire({ textEditor: ed, selections: ed.selections, kind });
  }

  codeEditor() {
    const ed = this.activeEditor();
    return ed && isDecoratable(ed.document) ? ed : undefined;
  }

  // ── Events ──

  async apply(ev) {
    const fn = EVENTS[ev.t];
    if (fn) await fn(this, ev);
  }

  // ── Oracle ──

  /** Whether band 2 and the import restores have settled: nothing they wait on is pending. */
  quiet() {
    const d = this.d;
    let band2 = !d.classifyTimer && !d.renderQueued;
    const ed = this.codeEditor();
    if (ed && band2) {
      const doc = ed.document;
      if ((this.calls.get(doc)?.get(doc.version)?.pending ?? 0) > 0) band2 = false;
      // A fetch waiting to re-ask a provider that cancelled it is still in flight.
      if (d.classifier.inflight.get(doc)) band2 = false;
      const block = d.focusedBlock(ed);
      const id = d.instanceIds.get(doc);
      if (block && id !== undefined) {
        const entry = d.classCache.get(`${doc.uri.toString()}#${id}::${doc.version}::${focus.focusKeyOf(block)}`);
        // The provider-silent hold keeps the previous version's semantic tints by design.
        if (entry?.hold) band2 = false;
      }
    }
    return { band2, imports: d.importTimers.size === 0 };
  }

  async oracle() {
    const walked = this.d;
    const visible = this.visible();
    const active = this.activeEditor();
    const mirrors = visible.map((ed) => {
      const m = makeEditor(ed.document, 0);
      m.selection = ed.selection;
      return m;
    });
    const saved = { clock };
    vs.window.visibleTextEditors = mirrors;
    vs.window.activeTextEditor = active ? mirrors[visible.indexOf(active)] : undefined;
    clock = new Clock(this.clock.now);
    stub.setLspHandler((cmd, uri) => {
      const doc = this.docs.find((x) => x.uri.toString() === uri.toString() && this.isLive(x));
      const rec = doc && this.calls.get(doc)?.get(doc.version);
      if (!rec || rec.pending > 0 || !(cmd in rec.last)) return new Promise(() => {});
      return rec.last[cmd];
    });
    let snap;
    const f = new Decorator();
    try {
      f.engaged = new Set(walked.engaged);
      f.machine.phase = walked.machine.current;
      const wc = walked.classifier;
      const fc = f.classifier;
      for (const doc of this.docs) {
        if (wc.answered.has(doc)) fc.answered.add(doc);
        if (wc.pathKeywords.has(doc)) fc.pathKeywords.set(doc, wc.pathKeywords.get(doc));
        if (wc.stringLiterals.has(doc)) fc.stringLiterals.add(doc);
        if (wc.typedNamespaces.has(doc)) fc.typedNamespaces.set(doc, wc.typedNamespaces.get(doc));
        if (wc.staticCalls.has(doc)) fc.staticCalls.set(doc, wc.staticCalls.get(doc));
        if (wc.coldAttempts.has(doc)) fc.coldAttempts.set(doc, wc.coldAttempts.get(doc));
      }
      fc.providerless = new Set(wc.providerless);
      await advance(clock, 400);
      snap = snapshot(f, mirrors);
      this.onOracle?.(f, mirrors);
    } finally {
      f.dispose();
      clock = saved.clock;
      stub.setLspHandler((cmd, uri) => this.serve(cmd, uri));
      this.sync();
    }
    return snap;
  }

  async check() {
    const q = this.quiet();
    const visible = this.visible();
    const got = snapshot(this.d, visible);
    const nonFlow = nonFlowPaint(got, visible);
    const want = await this.oracle();
    const asked = nonFlowAsked(this.docs);
    if (!q.band2) {
      mask(got, BAND2_ROLE);
      mask(want, BAND2_ROLE);
    }
    if (!q.imports) {
      mask(got, IMPORT_ROLE);
      mask(want, IMPORT_ROLE);
    }
    return { diff: nonFlow ?? asked ?? staleLex(this.d, visible) ?? diffSnapshots(got, want, visible), quiet: q.band2 && q.imports, got };
  }

  dispose() {
    this.d?.dispose();
    this.held = [];
  }
}

// ── Event vocabulary ──────────────────────────────────────────────────────────

const pickOf = (xs, u) => xs[Math.min(xs.length - 1, Math.floor(u * xs.length))];
const KINDS = [1, 1, 2, 2, 3, undefined];
const TYPED = ['x', 'y', '_', '1', ' ', '(', ')', '.', ';', '"', '{', '}', '#', '/', 'self', 'f"{a}"'];
const APPENDED = ['._x', ',', '.clone()', '?', ')'];

function identTarget(doc, u) {
  const ids = lexFor(doc.getText(), doc.languageId).idents;
  return ids.length ? ids[Math.floor(u * ids.length)].offset + 1 : 0;
}
function lineTarget(doc, u) {
  const line = Math.floor(u * doc.lineCount);
  const text = doc.lineAt(line).text;
  return doc.offsetAt(new vs.Position(line, Math.max(0, text.search(/\S/))));
}

const EVENTS = {
  async caret(w, ev) {
    const ed = w.codeEditor();
    if (!ed) return;
    const doc = ed.document;
    const at = caretOf(ed);
    const to = ev.line !== undefined ? doc.offsetAt(new vs.Position(ev.line, ev.character ?? 0))
      : ev.b < 0.55 ? identTarget(doc, ev.a)
        : ev.b < 0.85 ? lineTarget(doc, ev.a)
          : Math.max(0, Math.min(doc.getText().length, at + Math.round((ev.a - 0.5) * 12)));
    setCaret(ed, to);
    const kind = 'kind' in ev ? ev.kind : pickOf(KINDS, ev.c);
    stub.events.selection.fire({ textEditor: ed, selections: ed.selections, kind });
  },
  async type(w, ev) {
    const ed = w.codeEditor();
    if (!ed) return;
    const at = caretOf(ed);
    await w.typeAt(at, at, ev.text ?? pickOf(TYPED, ev.a));
  },
  async burst(w, ev) {
    const n = 2 + Math.floor(ev.a * 6);
    const gap = pickOf([25, 60, 130], ev.b);
    let u = ev.c;
    for (let i = 0; i < n; i++) {
      const ed = w.codeEditor();
      if (!ed) return;
      u = (u * 9301 + 49297) % 233280 / 233280;
      const at = caretOf(ed);
      if (u < 0.15 && at > 0) await w.typeAt(at - 1, at, '');
      else await w.typeAt(at, at, pickOf(TYPED.slice(0, 12), u));
      await advance(w.clock, gap);
    }
  },
  async backspace(w) {
    const ed = w.codeEditor();
    if (!ed) return;
    const at = caretOf(ed);
    if (at > 0) await w.typeAt(at - 1, at, '');
  },
  /** End on `ev.line`, then Backspace: the e2e `reclose` steps' delete of a closer at a line's end. */
  async unclose(w, ev) {
    const ed = w.codeEditor();
    if (!ed) return;
    const line = Math.min(ev.line, ed.document.lineCount - 1);
    const len = ed.document.lineAt(line).text.length;
    setCaret(ed, ed.document.offsetAt(new vs.Position(line, ev.at === undefined ? len : Math.min(ev.at + 1, len))));
    stub.events.selection.fire({ textEditor: ed, selections: ed.selections, kind: 1 });
    await flush();
    await EVENTS.backspace(w);
  },
  async deleteRange(w, ev) {
    const ed = w.codeEditor();
    if (!ed) return;
    const at = caretOf(ed);
    const end = Math.min(ed.document.getText().length, at + (ev.length ?? 1 + Math.floor(ev.a * 30)));
    if (end > at) await w.typeAt(at, end, '');
  },
  async newline(w) {
    const ed = w.codeEditor();
    if (!ed) return;
    const at = caretOf(ed);
    const indent = /^\s*/.exec(ed.document.lineAt(ed.selection.active.line).text)[0];
    await w.typeAt(at, at, `\n${indent}`);
  },
  async undo(w) {
    const ed = w.codeEditor();
    if (!ed) return;
    const u = w.undo.get(ed.document)?.pop();
    if (!u) return;
    await w.edit(ed.document, u.start, u.start + u.length, u.text, { record: false, owner: ed, reason: 1 });
    setCaret(ed, u.start + u.text.length);
    stub.events.selection.fire({ textEditor: ed, selections: ed.selections, kind: undefined });
  },
  async paste(w, ev) {
    const ed = w.codeEditor();
    if (!ed) return;
    const src = FIXTURES[w.entryOf(ed.document)?.key ?? 'ts'].text.split('\n');
    const from = Math.floor(ev.a * src.length);
    const chunk = ev.text ?? `${src.slice(from, from + 1 + Math.floor(ev.b * 3)).join('\n')}\n`;
    const at = caretOf(ed);
    await w.typeAt(at, at, chunk);
  },
  async foreign(w, ev) {
    // A formatter, rename, code action or reload, maybe in another document: VS Code
    // applies each with forceMoveMarkers.
    const others = w.entries.filter((e) => e.alive);
    const ed = w.codeEditor();
    const c = ev.c ?? 0;
    const doc = c < 0.7 && ed ? ed.document : pickOf(others, c)?.doc;
    if (!doc) return;
    const caretLine = ed && ed.document === doc ? ed.selection.active.line : -1;
    if (ev.insert !== undefined) {
      const at = doc.offsetAt(new vs.Position(ev.line, 0));
      await w.edit(doc, at, at, ev.insert, { force: true });
      return;
    }
    const op = ev.op ?? (ev.b < 0.3 ? 'rename' : ev.b < 0.5 ? 'dedent' : ev.b < 0.75 ? 'indent' : 'append');
    if (op === 'append') {
      // Text right after a name, a quick fix's `.clone()` or rustfmt's trailing `,`, on
      // any line; not where the text would cover a caret, which `mayForceMove` reads as
      // typing (docs/runtime.md#limits).
      const text = ev.text ?? pickOf(APPENDED, (ev.a * 7) % 1);
      const sels = ed && ed.document === doc ? ed.selections : [];
      const typing = (o) => {
        const p = doc.positionAt(o);
        return !mayForceMove({ range: { start: p, end: p }, text }, sels);
      };
      const ends = lexFor(doc.getText(), doc.languageId).idents.map((i) => i.offset + i.length).filter((o) => !typing(o));
      const at = ev.line !== undefined ? doc.offsetAt(new vs.Position(ev.line, ev.character ?? 0)) : ends.length ? pickOf(ends, ev.a) : -1;
      if (at >= 0) await w.edit(doc, at, at, text, { force: true });
      return;
    }
    let line = ev.line ?? Math.floor(ev.a * doc.lineCount);
    if (line === caretLine) line = (line + 1) % doc.lineCount;
    if (line === caretLine) return;
    const start = doc.offsetAt(new vs.Position(line, 0));
    const ids = lexFor(doc.getText(), doc.languageId).idents.filter((i) => doc.positionAt(i.offset).line === line);
    if (op === 'rename' && ids.length) {
      const id = ids[0];
      await w.edit(doc, id.offset, id.offset + id.length, `${id.name}2`, { force: true });
    } else if (op === 'dedent' && doc.lineAt(line).text.startsWith('    ')) {
      await w.edit(doc, start, start + 2, '', { force: true });
    } else {
      await w.edit(doc, start, start, '  ', { force: true });
    }
  },
  async save(w, ev) {
    const ed = w.codeEditor();
    if (!ed) return;
    const doc = ed.document;
    stub.events.willSave.fire({ document: doc });
    const line = ed.selection.active.line;
    const start = doc.offsetAt(new vs.Position(line, 0));
    if (ev.a < 0.5) await w.edit(doc, start, start, ' ', { force: true });
    await flush();
    stub.events.didSave.fire(doc);
  },
  async idle() {},
  async focusOther(w, ev) {
    if (w.focusOn.kind !== 'group' || w.groups.length < 2) return;
    const g = 1 - w.focusOn.g;
    if (!w.groups[g].editor) return;
    w.focusOn = { kind: 'group', g };
    w.sync();
    stub.events.activeEditor.fire(vs.window.activeTextEditor);
    if (ev.b < 0.5) {
      await flush();
      const ed = w.groups[g].editor;
      setCaret(ed, identTarget(ed.document, ev.a));
      stub.events.selection.fire({ textEditor: ed, selections: ed.selections, kind: 2 });
    }
  },
  async openTab(w, ev) {
    const g = w.focusOn.kind === 'group' ? w.focusOn.g : 0;
    if (!w.groups[g]) return;
    await w.show(g, pickOf(w.entries, ev.a));
  },
  async split(w, ev) {
    if (w.groups.length > 1 || !w.groups[0]) return;
    const cur = w.groups[0].editor && w.entryOf(w.groups[0].editor.document);
    const entry = ev.b < 0.6 && cur ? cur : pickOf(w.entries, ev.a);
    w.groups.push({ tabs: [], activeTab: -1, editor: null });
    await w.show(1, entry);
  },
  async closeTab(w, ev) {
    if (w.focusOn.kind !== 'group') return;
    const g = w.focusOn.g;
    const group = w.groups[g];
    if (!group || group.activeTab < 0) return;
    const [tab] = group.tabs.splice(group.activeTab, 1);
    w.stash(group);
    stub.setTabs(...w.groups.map((x) => x.tabs));
    stub.events.tabs.fire({ opened: [], closed: [tab], changed: [] });
    let next = group.tabs[Math.max(0, group.activeTab - 1)];
    if (!next) {
      if (w.groups.length > 1) {
        w.groups.splice(g, 1);
        w.focusOn = { kind: 'group', g: 0 };
      } else {
        group.activeTab = -1;
      }
      w.fireEditors();
    } else if (next.entry) {
      group.activeTab = group.tabs.indexOf(next);
      next = next.entry;
      await w.show(w.groups.indexOf(group), next);
    } else {
      group.activeTab = group.tabs.indexOf(next);
      w.fireEditors();
    }
    // The model is disposed only once nothing holds it, sometimes much later.
    const entry = tab.entry;
    if (entry && entry.alive && ev.b < 0.5 && !w.groups.some((x) => x.tabs.some((t) => t.entry === entry))) {
      entry.alive = false;
      stub.events.closeDocument.fire(entry.doc);
    }
  },
  async reopen(w, ev) {
    const closed = w.entries.filter((e) => !w.groups.some((x) => x.tabs.some((t) => t.entry === e)));
    const entry = pickOf(closed, ev.a);
    if (!entry) return;
    if (!entry.alive && ev.b < 0.4) entry.text = `${entry.lang === 'python' ? '#' : '//'} changed while closed\n${entry.text}`;
    if (!w.groups.length) w.groups.push({ tabs: [], activeTab: -1, editor: null });
    const g = w.focusOn.kind === 'group' && w.groups[w.focusOn.g] ? w.focusOn.g : 0;
    await w.show(g, entry);
  },
  async webview(w) {
    if (w.focusOn.kind !== 'group' || !w.groups[w.focusOn.g]) return;
    const group = w.groups[w.focusOn.g];
    w.stash(group);
    group.tabs.push({ input: {}, label: 'webview' });
    group.activeTab = group.tabs.length - 1;
    w.fireEditors();
  },
  async output(w, ev) {
    w.panel = true;
    w.focusOn = { kind: 'output', last: w.focusOn.kind === 'group' ? w.focusOn.g : (w.focusOn.last ?? 0) };
    w.fireEditors();
    if (ev.log ?? ev.b < 0.5) {
      const doc = w.output.document;
      await w.edit(doc, doc.getText().length, doc.getText().length, 'log line\n', { record: false, force: true });
    }
  },
  async back(w, ev) {
    if (w.focusOn.kind === 'output') {
      const g = Math.min(w.focusOn.last ?? 0, w.groups.length - 1);
      if (g < 0) return;
      w.focusOn = { kind: 'group', g };
      w.sync();
      stub.events.activeEditor.fire(vs.window.activeTextEditor);
      const ed = w.groups[g].editor;
      if (ed && ev.b < 0.5) {
        await flush();
        setCaret(ed, identTarget(ed.document, ev.a));
        stub.events.selection.fire({ textEditor: ed, selections: ed.selections, kind: 2 });
      }
      return;
    }
    const group = w.groups[w.focusOn.g];
    if (group && !group.editor) {
      const tab = [...group.tabs].reverse().find((t) => t.entry);
      if (tab) await w.show(w.focusOn.g, tab.entry);
    }
  },
  async closePanel(w) {
    if (!w.panel) return;
    w.panel = false;
    if (w.focusOn.kind === 'output') w.focusOn = { kind: 'group', g: Math.min(w.focusOn.last ?? 0, Math.max(0, w.groups.length - 1)) };
    w.fireEditors();
  },
  async provider(w, ev) {
    const langs = [...new Set(w.entries.map((e) => e.lang))].filter((l) => !PROSE_LANGS.has(l) && !DATA_LANGS.has(l));
    const lang = ev.lang ?? pickOf(langs, ev.a);
    if (!lang) return;
    w.provider[lang] = {
      mode: ev.mode ?? pickOf(lang === 'lua' || lang === 'zig' ? ['none', 'empty', 'ok', 'degraded', 'strings'] : ['none', 'empty', 'ok', 'degraded'], ev.b),
      latency: ev.latency ?? pickOf([0, 0, 90, 300, 'never'], ev.c),
    };
  },
  async release(w) {
    const held = w.held;
    w.held = [];
    for (const done of held) done();
  },
  async theme(w) {
    w.dark = !w.dark;
    vs.window.activeColorTheme.kind = w.dark ? 2 : 1;
    stub.events.colorTheme.fire(vs.window.activeColorTheme);
  },
  async toggle(w) {
    w.enabled = !w.enabled;
    w.applyConfig();
    stub.events.configuration.fire({ affectsConfiguration: (k) => 'okibiDynamic'.startsWith(k) || k.startsWith('okibiDynamic') });
  },
  async dwell(w, ev) {
    w.dwell = Math.floor(ev.a * DWELLS.length);
    w.applyConfig();
    stub.events.configuration.fire({ affectsConfiguration: (k) => 'okibiDynamic'.startsWith(k) || k.startsWith('okibiDynamic') });
  },
};

const WEIGHTS = [
  ['caret', 24], ['type', 9], ['burst', 6], ['backspace', 4], ['deleteRange', 3], ['newline', 4], ['undo', 4],
  ['paste', 2], ['foreign', 3], ['save', 2], ['idle', 9], ['focusOther', 4], ['openTab', 4], ['split', 2],
  ['closeTab', 3], ['reopen', 2], ['webview', 2], ['output', 2], ['back', 4], ['closePanel', 1],
  ['provider', 4], ['release', 2], ['theme', 2], ['toggle', 2], ['dwell', 2],
];
const TOTAL = WEIGHTS.reduce((n, [, w]) => n + w, 0);
const DT = [0, 0, 0, 30, 90, 160, 400, 1200];
const IDLE = [380, 2100, 2600, 3300, 25000, 31000];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r3 = (x) => Math.min(999, Math.round(x * 1000)) / 1000;

/** The walk for `seed`: its documents, providers and `steps` events. */
function generate(seed, steps) {
  const rnd = mulberry32(seed);
  const langs = ['ts', 'py', 'rs', 'go'];
  const first = langs[seed % 4];
  const second = pickOf(['ts', 'py', 'rs', 'go', 'md', first], rnd());
  const docs = [first, second, ...(rnd() < 0.3 ? [pickOf(langs, rnd())] : [])];
  const provider = {};
  for (const key of docs) {
    const lang = FIXTURES[key].lang;
    if (lang !== 'markdown') provider[lang] = { mode: pickOf(['ok', 'ok', 'degraded', 'none', 'empty'], rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  }
  const cfg = { docs, split: rnd() < 0.35, provider };
  // Its own stream, so the walks without a data file replay as docs/runtime.md cites them.
  const data = mulberry32(seed ^ 0x6b646c);
  if (data() < 0.25) {
    const keys = [pickOf(DATA_KEYS, data())];
    if (data() < 0.5) keys.push(pickOf(DATA_KEYS.filter((k) => k !== keys[0]), data()));
    docs.splice(1, 0, ...keys);
    for (const k of keys) provider[FIXTURES[k].lang] = { mode: 'none', latency: 0 };
  }
  const events = [];
  for (let i = 0; i < steps; i++) {
    let x = rnd() * TOTAL;
    let t = WEIGHTS[0][0];
    for (const [k, wt] of WEIGHTS) {
      if ((x -= wt) < 0) {
        t = k;
        break;
      }
    }
    const ev = { t, a: r3(rnd()), b: r3(rnd()), c: r3(rnd()), dt: pickOf(DT, rnd()) };
    if (t === 'idle') ev.dt = pickOf(IDLE, ev.a);
    events.push(ev);
  }
  return { cfg, events };
}

// The reclose walk: reclose.py alone. Deleting its one-line docstring's last `"`
// makes a string of everything to the next `"""`, and of the rest of the file after
// the one that follows.
const RECLOSE_LINES = FIXTURES.doc.text.split('\n');
const atNeedle = (needle, tok) => {
  const line = RECLOSE_LINES.findIndex((l) => l.includes(needle));
  return { line, character: RECLOSE_LINES[line].indexOf(tok, RECLOSE_LINES[line].indexOf(needle)) };
};
const DOCSTRING = atNeedle('"""A single', '"""').line;
const RECLOSE_TARGETS = [
  ['A single', 'single'], ['Keeps the live', 'live'], ['self.size = size', 'size'], ['def push', 'time'],
  ['self.seen[id] += 1', 'id'], ['dropped = 0', 'dropped'], ['dropped += id * 2', 'id'], ['book.push', 'push'],
].map(([needle, tok]) => atNeedle(needle, tok));
const RECLOSE_WEIGHTS = [
  ['unclose', 20], ['closer', 18], ['caret', 24], ['provider', 12], ['release', 8], ['idle', 8], ['undo', 5], ['type', 5],
];
const RECLOSE_TOTAL = RECLOSE_WEIGHTS.reduce((n, [, w]) => n + w, 0);

/** A reclose walk for `seed`: Focus in the docstring, then `steps` events. */
function generateReclose(seed, steps) {
  const rnd = mulberry32(seed);
  const cfg = { docs: ['doc'], symbols: true, provider: { python: { mode: 'ok', latency: pickOf([0, 90, 300], rnd()) } } };
  const events = [{ t: 'caret', ...RECLOSE_TARGETS[0], kind: 2, dt: 300 }];
  for (let i = 0; i < steps; i++) {
    let x = rnd() * RECLOSE_TOTAL;
    let t = RECLOSE_WEIGHTS[0][0];
    for (const [k, wt] of RECLOSE_WEIGHTS) {
      if ((x -= wt) < 0) {
        t = k;
        break;
      }
    }
    const u = rnd();
    const dt = pickOf(DT, rnd());
    if (t === 'unclose') events.push({ t, line: DOCSTRING, dt });
    else if (t === 'closer') events.push({ t: 'type', text: '"', dt });
    else if (t === 'caret') events.push({ t, ...pickOf(RECLOSE_TARGETS, u), kind: pickOf([1, 2, 2, 3], rnd()), dt });
    else if (t === 'provider') events.push({ t, lang: 'python', mode: pickOf(['ok', 'ok', 'empty', 'none'], u), latency: pickOf([0, 90, 300, 'never'], rnd()), dt });
    else if (t === 'idle') events.push({ t, dt: pickOf([380, 2100, 3300, 25000], u) });
    else if (t === 'type') events.push({ t, text: pickOf(['x', ' '], u), dt });
    else events.push({ t, dt });
  }
  return { cfg, events };
}

/** A walk with walk.lua first: the events of `generate(seed)`, its own documents and servers. */
function generateLua(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x6c7561);
  const second = pickOf(['lua', 'ts', 'py', 'md'], rnd());
  const docs = second === 'lua' ? ['lua'] : ['lua', second];
  const provider = {};
  for (const key of docs) {
    const lang = FIXTURES[key].lang;
    const modes = lang === 'lua' ? ['ok', 'ok', 'degraded', 'none', 'empty', 'strings'] : ['ok', 'ok', 'degraded', 'none', 'empty'];
    if (lang !== 'markdown') provider[lang] = { mode: pickOf(modes, rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  }
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/** A walk with walk.js first: the events of `generate(seed)`, its own documents and servers. */
function generateJs(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x6a73);
  const second = pickOf(['js', 'ts', 'py', 'md'], rnd());
  const docs = second === 'js' ? ['js'] : ['js', second];
  const provider = {};
  for (const key of docs) {
    const lang = FIXTURES[key].lang;
    if (lang !== 'markdown') provider[lang] = { mode: pickOf(['ok', 'ok', 'degraded', 'none', 'empty'], rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  }
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/** Typed into walk.html besides the usual keys: a script's end and start tag, half of each, and markup. */
const HTML_TYPED = ['</script>', '<script>', '</scr', '<scr', '<', '>', '<!--', '-->', '`', '/*', '<p onclick="x()">'];

/**
 * A walk with walk.html first: the events of `generate(seed)`, a fifth of the typed
 * keys a script boundary or markup, and beside it walk.js, walk.ts, walk.md, walk.xml,
 * walk.hbs or walk.css, as `css` or as Tailwind's `tailwindcss`, or nothing.
 */
function generateHtml(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x68746d);
  for (const ev of events) if (ev.t === 'type' && rnd() < 0.2) ev.text = pickOf(HTML_TYPED, rnd());
  const second = pickOf(['html', 'js', 'ts', 'md', ...WEB_KEYS], rnd());
  const docs = second === 'html' ? ['html'] : ['html', second];
  const provider = {};
  for (const key of docs) {
    const lang = FIXTURES[key].lang;
    if (FIXTURES[key].web) provider[lang] = { mode: 'none', latency: 0 };
    else if (lang !== 'markdown') provider[lang] = { mode: pickOf(['ok', 'ok', 'degraded', 'none', 'empty'], rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  }
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/** Typed into a component besides the usual keys: region boundaries, template blocks and markup. */
const COMPONENT_TYPED = ['{{', '}}', '{', '}', '<script>', '</script>', '---', '{#each items as item}', '{/each}', ' v-for="x in xs"', '"', '<Child />', '<>', '</>', '<!--', '-->', '`'];
const COMPONENT_KEYS = Object.keys(FIXTURES).filter((k) => FIXTURES[k].component);

/**
 * A walk with a component first (walk.vue, walk.svelte, walk.astro, walk.tsx or walk.jsx): the
 * events of `generate(seed)`, a fifth of the typed keys a region boundary or markup, and
 * beside it another component, walk.ts, walk.html, walk.md or walk.css, or nothing.
 * `keys` picks from fewer components, so a seed found before a component joined replays.
 */
function generateComponents(seed, steps, keys = COMPONENT_KEYS) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x736663);
  for (const ev of events) if (ev.t === 'type' && rnd() < 0.2) ev.text = pickOf(COMPONENT_TYPED, rnd());
  const first = keys[seed % keys.length];
  const second = pickOf([first, ...keys, 'ts', 'html', 'md', 'css'], rnd());
  const docs = second === first ? [first] : [first, second];
  const provider = {};
  for (const key of docs) {
    const lang = FIXTURES[key].lang;
    if (FIXTURES[key].web) provider[lang] = { mode: 'none', latency: 0 };
    else if (lang !== 'markdown') provider[lang] = { mode: pickOf(['ok', 'ok', 'degraded', 'none', 'empty'], rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  }
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/** A walk with walk.rb first: the events of `generate(seed)`, its own documents and servers. */
function generateRuby(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x727562);
  const second = pickOf(['rb', 'ts', 'py', 'md'], rnd());
  const docs = second === 'rb' ? ['rb'] : ['rb', second];
  const provider = {};
  for (const key of docs) {
    const lang = FIXTURES[key].lang;
    if (lang !== 'markdown') provider[lang] = { mode: pickOf(['ok', 'ok', 'degraded', 'none', 'empty'], rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  }
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/**
 * A walk with walk.zig first: the events of `generate(seed)`, its own documents and
 * servers. In 3 of 10, walk.zon too, under `zig` and answered by the same server.
 */
function generateZig(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x7a6967);
  const second = pickOf(['zig', 'ts', 'py', 'md'], rnd());
  const docs = second === 'zig' ? ['zig'] : ['zig', second];
  if (rnd() < 0.3) docs.push('zon');
  const provider = {};
  for (const key of docs) {
    const lang = FIXTURES[key].lang;
    const modes = lang === 'zig' ? ['ok', 'ok', 'degraded', 'none', 'empty', 'strings'] : ['ok', 'ok', 'degraded', 'none', 'empty'];
    if (lang !== 'markdown') provider[lang] = { mode: pickOf(modes, rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  }
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/**
 * A walk with a C, C++, Java, Kotlin or Groovy file first, then the same language,
 * CMake, a Gradle script in either DSL (a `.gradle.kts` as `kotlin` or as redhat.java's
 * `gradle-kotlin-dsl`), TypeScript or Python: the events of
 * `generate(seed)`. Groovy has no semantic tokens provider.
 */
const CJVM_KEYS = ['c', 'cpp', 'java', 'kt', 'groovy'];
function generateCjvm(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x636a766d);
  const first = CJVM_KEYS[seed % CJVM_KEYS.length];
  const second = pickOf([first, first, 'cmake', 'gradle.kts', 'gradle-kotlin-dsl', 'gradle', 'ts', 'py'], rnd());
  const docs = second === first ? [first] : [first, second];
  const provider = {};
  for (const key of docs) {
    if (FIXTURES[key].cjvmStatic || FIXTURES[key].noServer) continue;
    provider[FIXTURES[key].lang] = { mode: pickOf(['ok', 'ok', 'degraded', 'none', 'empty'], rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  }
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/**
 * A walk with a Swift, Objective-C, Objective-C++, Objective-C header (cpp) or Metal file
 * first, its server sourcekit-lsp-shaped (Swift: no declaration tokens; Objective-C and
 * Objective-C++: clangd's legend over sourcekit-lsp's indices), degraded, silent or none;
 * then the same file, an Apple static format, TypeScript or Python.
 */
const SWIFT_KEYS = ['swift', 'objc', 'objcpp', 'objch', 'metal'];
function generateSwift(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x73776674);
  const first = SWIFT_KEYS[seed % SWIFT_KEYS.length];
  const second = pickOf([first, first, 'strings', 'pbxproj', 'xcconfig', 'plist', 'plist-xml', 'ts', 'py'], rnd());
  const docs = second === first ? [first] : [first, second];
  const provider = {};
  for (const key of docs) {
    if (FIXTURES[key].cjvmStatic || FIXTURES[key].noServer) continue;
    const modes = key === 'objc' || key === 'objcpp' ? ['sourcekit-objc', 'sourcekit-objc', 'ok', 'none', 'empty'] : ['ok', 'ok', 'degraded', 'none', 'empty'];
    provider[FIXTURES[key].lang] = { mode: pickOf(modes, rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  }
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/**
 * A walk with a C or C++ file first, its server cpptools-shaped and cancelling (one
 * request waits per file; the editor's own requests for each new version cancel the
 * companion's, up to 3 times before the answer arrives), or clangd-shaped, or none, for
 * the whole walk; then the same file, CMake, TypeScript or Python.
 */
function generateCjvmCancel(seed, steps) {
  const events = generate(seed, steps).events.filter((ev) => ev.t !== 'provider');
  const rnd = mulberry32(seed ^ 0x63707074);
  const first = pickOf(['c', 'cpp'], rnd());
  const second = pickOf([first, first, 'cmake', 'ts', 'py'], rnd());
  const docs = second === first ? [first] : [first, second];
  const server = pickOf(['cpptools', 'cpptools', 'cpptools', 'clangd', 'none'], rnd());
  const latency = pickOf([300, 900, 1600, 2400], rnd());
  const rivals = [60, 400, 1700].filter((at) => at < latency).slice(0, 1 + Math.floor(rnd() * 3));
  const provider = {
    [FIXTURES[first].lang]: server === 'cpptools' ? { mode: 'degraded', latency, cancels: rivals }
      : server === 'clangd' ? { mode: 'ok', latency: pickOf([0, 90, 300], rnd()) } : { mode: 'none', latency: 0 },
  };
  return { cfg: { docs, split: rnd() < 0.35, provider, server }, events };
}

/**
 * A walk with a markdown-derived file first, then a code file, and in half of them
 * another prose file: the events of `generate(seed)`. VS Code registers a semantic
 * tokens provider for the four chat customisation ids, so they get a server.
 */
function generateProse(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x6d64);
  const first = PROSE_KEYS[seed % PROSE_KEYS.length];
  const docs = [first, pickOf(['ts', 'py', 'rs', 'go'], rnd())];
  if (rnd() < 0.5) docs.push(pickOf(['md', ...PROSE_KEYS.filter((k) => k !== first)], rnd()));
  const provider = {};
  for (const key of docs) {
    const lang = FIXTURES[key].lang;
    if (FIXTURES[key].marks) provider[lang] = { mode: 'ok', latency: 0 };
    else if (!FIXTURES[key].prose) provider[lang] = { mode: pickOf(['ok', 'ok', 'degraded', 'none', 'empty'], rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  }
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/**
 * A walk with a code file first, then one or two of the Docker and Kubernetes files,
 * each with no server: the events of `generate(seed)`.
 */
function generateContainers(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x6b3873);
  const code = pickOf(['ts', 'py', 'rs', 'go'], rnd());
  const first = CONTAINER_KEYS[seed % CONTAINER_KEYS.length];
  const docs = [code, first];
  if (rnd() < 0.4) docs.push(pickOf(CONTAINER_KEYS.filter((k) => k !== first), rnd()));
  const provider = { [FIXTURES[code].lang]: { mode: pickOf(['ok', 'ok', 'degraded', 'none', 'empty'], rnd()), latency: pickOf([0, 0, 90, 300], rnd()) } };
  for (const key of docs.slice(1)) provider[FIXTURES[key].lang] = { mode: 'none', latency: 0 };
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/**
 * A walk with a code file first, then one or two of the stylesheets, GraphQL and Razor
 * files, each with no server: the events of `generate(seed)`, a fifth of the typed keys
 * a stylesheet's or a template's opener or closer.
 */
const SHEET_TYPED = ['}', '{', '#{', '@{', '*/', '/*', '"', '@code {', '{{', '}}', '"""', '#'];
function generateSheets(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x737479);
  for (const ev of events) if (ev.t === 'type' && rnd() < 0.2) ev.text = pickOf(SHEET_TYPED, rnd());
  const code = pickOf(['ts', 'py', 'rs', 'go', 'html'], rnd());
  const first = SHEET_KEYS[seed % SHEET_KEYS.length];
  const docs = [code, first];
  if (rnd() < 0.4) docs.push(pickOf(SHEET_KEYS.filter((k) => FIXTURES[k].file !== FIXTURES[first].file), rnd()));
  const provider = { [FIXTURES[code].lang]: { mode: pickOf(['ok', 'ok', 'degraded', 'none', 'empty'], rnd()), latency: pickOf([0, 0, 90, 300], rnd()) } };
  for (const key of docs.slice(1)) provider[FIXTURES[key].lang] = { mode: 'none', latency: 0 };
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/** Typed into walk.php besides the usual keys: PHP's open and close tags, quotes, comment openers and markup. */
const PHP_TYPED = ['?>', '<?php ', '<?= ', '<?', '"', "'", '//', '#', '/*', '*/', '<<<EOT\n', '<p>', '{', '}'];

/**
 * A walk with walk.php first: the events of `generate(seed)`, a fifth of the typed keys
 * from PHP_TYPED, and beside it walk.php again, walk.html, walk.ts, walk.md, walk.scss or
 * walk.cshtml. VS Code's PHP extension sends no semantic tokens.
 */
function generatePhp(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x706870);
  for (const ev of events) if (ev.t === 'type' && rnd() < 0.2) ev.text = pickOf(PHP_TYPED, rnd());
  const second = pickOf(['php', 'html', 'ts', 'md', 'scss', 'cshtml'], rnd());
  const docs = second === 'php' ? ['php'] : ['php', second];
  const provider = { php: { mode: pickOf(['none', 'empty'], rnd()), latency: 0 } };
  for (const key of docs.slice(1)) {
    const lang = FIXTURES[key].lang;
    if (FIXTURES[key].sheet) provider[lang] = { mode: 'none', latency: 0 };
    else if (lang !== 'markdown') provider[lang] = { mode: pickOf(['ok', 'ok', 'degraded', 'none', 'empty'], rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  }
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/** Typed into walk.mdx besides the usual keys: an expression's, a JSX tag's and an ESM line's ends, a fence, a highlight and a link. */
const MDX_TYPED = ['{', '}', '<Note>', '</Note>', '<', '>', 'import x from "y"\n', 'export ', '```', '==', '](', '{/*', '*/}'];

/** A walk with walk.mdx first, then a code file, and in half of them walk.md: the events of `generate(seed)`. */
function generateMdx(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x6d6478);
  for (const ev of events) if (ev.t === 'type' && rnd() < 0.2) ev.text = pickOf(MDX_TYPED, rnd());
  const docs = ['mdx', pickOf(['ts', 'py', 'rs', 'go'], rnd())];
  if (rnd() < 0.5) docs.push('md');
  const provider = { mdx: { mode: 'ok', latency: 0 }, markdown: { mode: 'ok', latency: 0 } };
  provider[FIXTURES[docs[1]].lang] = { mode: pickOf(['ok', 'ok', 'degraded', 'none', 'empty'], rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

/** Typed into the shell files besides the usual keys: quotes, holes, a heredoc opener, block words and comments. */
const SHELL_TYPED = ['"', "'", '$', '${', '}', '$(', ')', '<<EOF\n', 'fi', 'done', 'esac', 'end', '#', '`', ';;', 'local ', 'set -l '];

/**
 * A walk with walk.sh, walk.zsh or walk.fish first: the events of `generate(seed)`, a
 * fifth of the typed keys from SHELL_TYPED, and beside it another shell file, walk.ts,
 * walk.py, walk.md or one of the tooling files that must show nothing.
 */
function generateShell(seed, steps) {
  const { events } = generate(seed, steps);
  const rnd = mulberry32(seed ^ 0x736873);
  for (const ev of events) if (ev.t === 'type' && rnd() < 0.2) ev.text = pickOf(SHELL_TYPED, rnd());
  const first = pickOf(['sh', 'zsh', 'fish'], rnd());
  const second = pickOf(['sh', 'fish', 'ts', 'py', 'md', ...TOOLING_KEYS], rnd());
  const docs = second === first ? [first] : [first, second];
  const provider = {};
  for (const key of docs) {
    const lang = FIXTURES[key].lang;
    if (FIXTURES[key].tooling) provider[lang] = { mode: 'none', latency: 0 };
    else if (lang === 'shellscript') provider[lang] = { mode: pickOf(['none', 'empty'], rnd()), latency: 0 };
    else if (lang !== 'markdown') provider[lang] = { mode: pickOf(['ok', 'ok', 'degraded', 'none', 'empty'], rnd()), latency: pickOf([0, 0, 90, 300], rnd()) };
  }
  return { cfg: { docs, split: rnd() < 0.35, provider }, events };
}

// The shell reclose walks: walk.sh or walk.fish alone. Deleting a heredoc terminator's
// last letter makes a string of the rest of the file; a quote, a block word's last
// letter or a hole's closer unbalances everything below it.
const unclosers = (key, rows) => {
  const lines = FIXTURES[key].text.split('\n');
  return rows.map(([needle, char, nth]) => {
    const line = lines.findIndex((l) => (needle.endsWith('$') ? l === needle.slice(0, -1) : l.includes(needle)));
    if (line < 0) throw new Error(`no line ${needle} in ${key}`);
    let at = -1;
    for (let i = 0; i <= (nth ?? 0); i++) at = lines[line].indexOf(char, at + 1);
    return nth === undefined ? { line, char } : { line, char, at };
  });
};
const targets = (key, rows) => {
  const lines = FIXTURES[key].text.split('\n');
  return rows.map(([needle, tok]) => {
    const line = lines.findIndex((l) => l.includes(needle));
    return { line, character: lines[line].indexOf(tok, lines[line].indexOf(needle)) };
  });
};
const SHELL_RECLOSE = {
  sh: {
    unclose: unclosers('sh', [['EOT$', 'T'], ['echo "copied', '"'], ["printf '%s", "'", 1], ['    fi$', 'i'], ['      done$', 'e'], ['        esac$', 'c'],
      ['timeout=${TIMEOUT', '}'], ['count=$(ls', ')']]),
    targets: targets('sh', [['attempt=$((attempt', 'attempt'], ['local level', 'level'], ['host: ${hosts[0]}', 'hosts'], ['retries=3', 'retries'],
      ['eval "$(ssh', 'eval'], ['case "$f"', 'f'], ['self-test this', 'this']]),
    modes: ['none', 'empty'],
  },
  fish: {
    unclose: unclosers('fish', [['                end$', 'd'], ['end$', 'd'], ['echo "copied', '"'], ["case '*self*'", "'", 1], ['set count (count', ')']]),
    targets: targets('fish', [['set attempt (math', 'attempt'], ['set -l msg', 'msg'], ['for host in $hosts', 'host'], ['eval (ssh', 'eval'],
      ["case '*self*'", 'self'], ['self and this', 'this']]),
    modes: ['ok', 'ok', 'degraded', 'none'],
  },
};

function generateShellReclose(seed, steps) {
  const rnd = mulberry32(seed ^ 0x736863);
  const key = seed % 2 ? 'sh' : 'fish';
  const spec = SHELL_RECLOSE[key];
  const lang = FIXTURES[key].lang;
  const cfg = { docs: [key], provider: { [lang]: { mode: pickOf(spec.modes, rnd()), latency: pickOf([0, 90, 300], rnd()) } } };
  const events = [{ t: 'caret', ...spec.targets[0], kind: 2, dt: 300 }];
  let which = spec.unclose[0];
  for (let i = 0; i < steps; i++) {
    let x = rnd() * RECLOSE_TOTAL;
    let t = RECLOSE_WEIGHTS[0][0];
    for (const [k, wt] of RECLOSE_WEIGHTS) {
      if ((x -= wt) < 0) {
        t = k;
        break;
      }
    }
    const u = rnd();
    const dt = pickOf(DT, rnd());
    if (t === 'unclose') {
      which = pickOf(spec.unclose, rnd());
      events.push({ t, line: which.line, at: which.at, dt });
    } else if (t === 'closer') events.push({ t: 'type', text: which.char, dt });
    else if (t === 'caret') events.push({ t, ...pickOf(spec.targets, u), kind: pickOf([1, 2, 2, 3], rnd()), dt });
    else if (t === 'provider') events.push({ t, lang, mode: pickOf([...spec.modes, 'empty'], u), latency: pickOf([0, 90, 300, 'never'], rnd()), dt });
    else if (t === 'idle') events.push({ t, dt: pickOf([380, 2100, 3300, 25000], u) });
    else if (t === 'type') events.push({ t, text: pickOf(['x', ' '], u), dt });
    else events.push({ t, dt });
  }
  return { cfg, events };
}

// The Zig reclose walk: walk.zig alone. Nothing in Zig spans lines, so the closers
// are a string's `"`, a `\\` line's second backslash and a block's `}`.
const ZIG_LINES = FIXTURES.zig.text.split('\n');
const zigAt = (needle, tok) => {
  const line = ZIG_LINES.findIndex((l) => l.includes(needle));
  return { line, character: ZIG_LINES[line].indexOf(tok, ZIG_LINES[line].indexOf(needle)) };
};
const ZIG_UNCLOSE = [
  { line: ZIG_LINES.findIndex((l) => l.includes('"end")) break')), char: '"', at: ZIG_LINES.find((l) => l.includes('"end")) break')).indexOf('end") ') + 3 },
  { line: ZIG_LINES.findIndex((l) => l.includes('\\\\draining')), char: '\\', at: ZIG_LINES.find((l) => l.includes('\\\\draining')).indexOf('\\') + 1 },
  { line: ZIG_LINES.indexOf('    }', ZIG_LINES.findIndex((l) => l.includes('const job ='))), char: '}' },
];
const ZIG_TARGETS = [
  ['pushed += i', 'pushed'], ['self.size += 1', 'self'], ['total.* += job', 'total'], ['const job =', 'job'],
  ['n += line.len', 'line'], ['not code: total', 'total'], ['pushed_total += pushed', 'pushed_total'], ['break :outer n', 'outer'],
].map(([needle, tok]) => zigAt(needle, tok));

function generateZigReclose(seed, steps) {
  const rnd = mulberry32(seed ^ 0x7a6763);
  const cfg = { docs: ['zig'], provider: { zig: { mode: pickOf(['ok', 'none', 'strings'], rnd()), latency: pickOf([0, 90, 300], rnd()) } } };
  const events = [{ t: 'caret', ...ZIG_TARGETS[0], kind: 2, dt: 300 }];
  let which = ZIG_UNCLOSE[0];
  for (let i = 0; i < steps; i++) {
    let x = rnd() * RECLOSE_TOTAL;
    let t = RECLOSE_WEIGHTS[0][0];
    for (const [k, wt] of RECLOSE_WEIGHTS) {
      if ((x -= wt) < 0) {
        t = k;
        break;
      }
    }
    const u = rnd();
    const dt = pickOf(DT, rnd());
    if (t === 'unclose') {
      which = pickOf(ZIG_UNCLOSE, rnd());
      events.push({ t, line: which.line, at: which.at, dt });
    } else if (t === 'closer') events.push({ t: 'type', text: which.char, dt });
    else if (t === 'caret') events.push({ t, ...pickOf(ZIG_TARGETS, u), kind: pickOf([1, 2, 2, 3], rnd()), dt });
    else if (t === 'provider') events.push({ t, lang: 'zig', mode: pickOf(['ok', 'ok', 'empty', 'none', 'strings'], u), latency: pickOf([0, 90, 300, 'never'], rnd()), dt });
    else if (t === 'idle') events.push({ t, dt: pickOf([380, 2100, 3300, 25000], u) });
    else if (t === 'type') events.push({ t, text: pickOf(['x', ' '], u), dt });
    else events.push({ t, dt });
  }
  return { cfg, events };
}

// The Ruby reclose walk: walk.rb alone. Deleting the heredoc terminator's last
// letter makes a string of the rest of the file; deleting an `end`'s `d` unbalances
// every block below.
const RB_LINES = FIXTURES.rb.text.split('\n');
const rbAt = (needle, tok) => {
  const line = RB_LINES.findIndex((l) => l.includes(needle));
  return { line, character: RB_LINES[line].indexOf(tok, RB_LINES[line].indexOf(needle)) };
};
const RB_UNCLOSE = [{ line: RB_LINES.indexOf('    EOS'), char: 'S' }, { line: RB_LINES.indexOf('  end'), char: 'd' }];
const RB_TARGETS = [
  ['pushed += 1', 'pushed'], ['@size = size', 'size'], ['#{p} jobs', 'p'], ['total += job', 'job'],
  ['count = 0', 'count'], ['count += line', 'line'], ['not_code', 'not_code'], ['$jobs = Queue', 'jobs'], ['half: half', 'half'],
].map(([needle, tok]) => rbAt(needle, tok));

function generateRubyReclose(seed, steps) {
  const rnd = mulberry32(seed ^ 0x72626c);
  const cfg = { docs: ['rb'], provider: { ruby: { mode: pickOf(['ok', 'none'], rnd()), latency: pickOf([0, 90, 300], rnd()) } } };
  const events = [{ t: 'caret', ...RB_TARGETS[0], kind: 2, dt: 300 }];
  for (let i = 0; i < steps; i++) {
    let x = rnd() * RECLOSE_TOTAL;
    let t = RECLOSE_WEIGHTS[0][0];
    for (const [k, wt] of RECLOSE_WEIGHTS) {
      if ((x -= wt) < 0) {
        t = k;
        break;
      }
    }
    const u = rnd();
    const dt = pickOf(DT, rnd());
    const which = pickOf(RB_UNCLOSE, rnd());
    if (t === 'unclose') events.push({ t, line: which.line, dt });
    else if (t === 'closer') events.push({ t: 'type', text: which.char, dt });
    else if (t === 'caret') events.push({ t, ...pickOf(RB_TARGETS, u), kind: pickOf([1, 2, 2, 3], rnd()), dt });
    else if (t === 'provider') events.push({ t, lang: 'ruby', mode: pickOf(['ok', 'ok', 'empty', 'none'], u), latency: pickOf([0, 90, 300, 'never'], rnd()), dt });
    else if (t === 'idle') events.push({ t, dt: pickOf([380, 2100, 3300, 25000], u) });
    else if (t === 'type') events.push({ t, text: pickOf(['x', ' '], u), dt });
    else events.push({ t, dt });
  }
  return { cfg, events };
}

// The Lua reclose walk: walk.lua alone. Deleting the long comment's last `]` makes a
// comment of the rest of the file; deleting an `end`'s `d` unbalances every block below.
const LUA_LINES = FIXTURES.lua.text.split('\n');
const luaAt = (needle, tok) => {
  const line = LUA_LINES.findIndex((l) => l.includes(needle));
  return { line, character: LUA_LINES[line].indexOf(tok, LUA_LINES[line].indexOf(needle)) };
};
const LUA_UNCLOSE = [{ line: LUA_LINES.indexOf(']]'), char: ']' }, { line: LUA_LINES.indexOf('end'), char: 'd' }];
const LUA_TARGETS = [
  ['A queue', 'queue'], ['self.size = size', 'size'], ['type == "urgent"', 'type'], ['pushed = (pushed', 'pushed'],
  ['local count = 0', 'count'], ['count = count + 1', 'count'], ['not code', 'code'], ['queue.items = {}', 'queue'],
].map(([needle, tok]) => luaAt(needle, tok));

function generateLuaReclose(seed, steps) {
  const rnd = mulberry32(seed ^ 0x72636c);
  const cfg = { docs: ['lua'], provider: { lua: { mode: pickOf(['ok', 'none', 'strings'], rnd()), latency: pickOf([0, 90, 300], rnd()) } } };
  const events = [{ t: 'caret', ...LUA_TARGETS[0], kind: 2, dt: 300 }];
  for (let i = 0; i < steps; i++) {
    let x = rnd() * RECLOSE_TOTAL;
    let t = RECLOSE_WEIGHTS[0][0];
    for (const [k, wt] of RECLOSE_WEIGHTS) {
      if ((x -= wt) < 0) {
        t = k;
        break;
      }
    }
    const u = rnd();
    const dt = pickOf(DT, rnd());
    const which = pickOf(LUA_UNCLOSE, rnd());
    if (t === 'unclose') events.push({ t, line: which.line, dt });
    else if (t === 'closer') events.push({ t: 'type', text: which.char, dt });
    else if (t === 'caret') events.push({ t, ...pickOf(LUA_TARGETS, u), kind: pickOf([1, 2, 2, 3], rnd()), dt });
    else if (t === 'provider') events.push({ t, lang: 'lua', mode: pickOf(['ok', 'ok', 'empty', 'none', 'strings'], u), latency: pickOf([0, 90, 300, 'never'], rnd()), dt });
    else if (t === 'idle') events.push({ t, dt: pickOf([380, 2100, 3300, 25000], u) });
    else if (t === 'type') events.push({ t, text: pickOf(['x', ' '], u), dt });
    else events.push({ t, dt });
  }
  return { cfg, events };
}

/**
 * Replay `events` on a fresh world: the first step whose screen differs from the
 * oracle's, if any, step -1 being the files as opened. `trace` sees every step and
 * `setup` the world before it opens, for debugging a shrunk failure.
 */
async function runWalk(cfg, events, trace, setup) {
  const w = new World(cfg);
  setup?.(w);
  let compared = 0;
  let quiet = 0;
  try {
    await w.start();
    const opened = await w.check();
    if (opened.diff) return { failure: { step: -1, diff: opened.diff }, compared, quiet };
    for (let i = 0; i < events.length; i++) {
      await w.apply(events[i]);
      await advance(w.clock, events[i].dt ?? 0);
      const r = await w.check();
      compared++;
      if (r.quiet) quiet++;
      trace?.(i, events[i], r, w);
      if (r.diff) return { failure: { step: i, diff: r.diff }, compared, quiet };
    }
    return { failure: null, compared, quiet };
  } finally {
    w.dispose();
  }
}

/** Delta-debug `events` down to a short list that still fails. */
async function shrink(cfg, events, failStep) {
  let cur = events.slice(0, failStep + 1);
  let n = 2;
  while (cur.length > 1) {
    const size = Math.ceil(cur.length / n);
    let reduced = false;
    for (let i = 0; i < cur.length; i += size) {
      const cand = [...cur.slice(0, i), ...cur.slice(i + size)];
      const r = await runWalk(cfg, cand);
      if (r.failure) {
        cur = cand.slice(0, r.failure.step + 1);
        n = Math.max(2, n - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (size === 1) break;
      n = Math.min(cur.length, n * 2);
    }
  }
  // Then the pauses: a failure that survives dt 0 is easier to read.
  for (const ev of cur) {
    if (ev.dt === 0 || ev.t === 'idle') continue;
    const dt = ev.dt;
    ev.dt = 0;
    if (!(await runWalk(cfg, cur)).failure) ev.dt = dt;
  }
  const last = await runWalk(cfg, cur);
  return { events: cur, diff: last.failure?.diff };
}

const show = (cfg, events) => `cfg: ${JSON.stringify(cfg)}\n` + events.map((e) => `  ${JSON.stringify(e)}`).join('\n');

module.exports = {
  enterFakeTime, exitFakeTime, generate, generateReclose, generateLua, generateShell, generateShellReclose, TOOLING_KEYS, generateJs, generateHtml, generateComponents, COMPONENT_KEYS, generateLuaReclose, generateRuby, generateRubyReclose, generateZig, generateZigReclose, generateCjvm, generateCjvmCancel, generateSwift, generateProse, generateContainers, generateSheets, generatePhp, generateMdx, runWalk, shrink, show, acceptEdit, FIXTURES, DATA_KEYS, CONTAINER_KEYS, WEB_KEYS, SHEET_KEYS, PROSE_KEYS,
};
