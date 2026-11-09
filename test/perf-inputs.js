'use strict';
// Large, deterministic inputs for test/perf-golden.test.js and the benches.
//
// Each input is one sample repeated until it reaches the requested line count.
// Every copy after the first renames the sample's declared names (4+ chars) to
// the same length, so copies are distinct identities and the captured token
// fixture stays valid when shifted by copy x sample length. Symbols are what a
// server would report: one range per declared function, from its line start to
// the end of its block.
//
// Token fixtures are real captures (TS, JS, Go, Rust, Lua; Lua's in the wire format)
// or Pylance-shaped:
//   python3 -I test/gen-py-semtok.py samples/sample.py 1 > test/fixtures/sample.py.tokens.json
// Lua copies keep the standard globals' names, so each copy calls the same builtins.
// ruby-lsp marks no declaration, so Ruby copies rename the names it types as locals
// and parameters (not two that would rename alike, like `fmt2` and `fmt3`), keep the
// Kernel names, and take method symbols from the capture.
// The Ruby sample loses its `__END__` section, which would turn every later copy into data.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const LANGS = {
  ts: { sample: 'samples/sample.ts', tokens: 'test/fixtures/sample.ts.tokens.json', languageId: 'typescript' },
  js: { sample: 'samples/sample.js', tokens: 'test/fixtures/sample.js.tokens.json', languageId: 'javascript' },
  go: { sample: 'samples/sample.go', tokens: 'test/fixtures/sample.go.tokens.json', languageId: 'go' },
  rs: { sample: 'samples/sample.rs', tokens: 'test/fixtures/sample.rs.tokens.json', languageId: 'rust' },
  py: { sample: 'samples/sample.py', tokens: 'test/fixtures/sample.py.tokens.json', languageId: 'python' },
  lua: { sample: 'samples/sample.lua', lsp: 'test/fixtures/sample.lua.lsp.json', languageId: 'lua', keep: () => require('../out/lua').LUA_STD },
  rb: {
    sample: 'samples/sample.rb', lsp: 'test/fixtures/sample.rb.lsp.json', languageId: 'ruby',
    keep: () => require('../out/ruby').RUBY_GRAMMAR_BUILTINS, locals: true, lspSymbols: true,
    body: (text) => text.slice(0, text.indexOf('\n__END__\n') + 1),
  },
};

const KEEP = new Set(['self', 'this', 'Self', 'super', 'None', 'True', 'False']);

function copySuffix(k) {
  return k.toString(36).padStart(2, '0').slice(-2);
}

function renamedNames(tokens, keep, locals) {
  const names = new Set();
  for (const t of tokens) {
    const declares = t.modifiers.includes('declaration') || t.modifiers.includes('definition') || t.type === 'function'
      || (locals && (t.type === 'variable' || t.type === 'parameter') && !t.modifiers.includes('defaultLibrary'));
    if (declares && t.length >= 4 && /^[A-Za-z_]\w*$/.test(t.name) && !KEEP.has(t.name) && !keep.has(t.name)) {
      names.add(t.name);
    }
  }
  if (locals) {
    const stem = (n) => `${n.slice(0, -2)}/${n.length}`;
    const seen = new Map();
    for (const n of names) seen.set(stem(n), (seen.get(stem(n)) ?? 0) + 1);
    for (const n of [...names]) if (seen.get(stem(n)) > 1) names.delete(n);
  }
  return [...names].sort();
}

function renameCopy(text, names, k) {
  if (k === 0) return text;
  const suffix = copySuffix(k);
  let out = text;
  for (const n of names) {
    out = out.replace(new RegExp(`\\b${n}\\b`, 'g'), n.slice(0, -2) + suffix);
  }
  return out;
}

/** Function symbol ranges for one copy of the sample, from its declared-function tokens and its blocks. */
function baseSymbols(text, tokens, blocks) {
  const lineStart = (o) => text.lastIndexOf('\n', o - 1) + 1;
  const out = [];
  for (const t of tokens) {
    const fn = (t.type === 'function' || t.type === 'method')
      && (t.modifiers.includes('declaration') || t.modifiers.includes('definition'));
    if (!fn) continue;
    const onHeader = blocks.find((b) => b.headerStart <= t.offset && t.offset < b.openOffset);
    const after = onHeader ?? blocks.find((b) => b.openOffset > t.offset);
    if (after) out.push({ start: lineStart(t.offset), end: after.closeOffset + 1 });
  }
  return out;
}

/** Method, constructor and function ranges of a captured document-symbol tree (zero-based kinds 5, 8, 11). */
function wireSymbols(text, symbols) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const out = [];
  const walk = (s) => {
    if (s.kind === 5 || s.kind === 8 || s.kind === 11) {
      out.push({ start: starts[s.range.start.line], end: starts[s.range.end.line] + s.range.end.character });
    }
    for (const c of s.children ?? []) walk(c);
  };
  for (const s of symbols) walk(s);
  return out.sort((a, b) => a.start - b.start);
}

/** A captured `{ legend, data }` answer, decoded against `text` (UTF-16 columns). */
function decodeWire(text, { legend, data }) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const out = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    char = data[i] === 0 ? char + data[i + 1] : data[i + 1];
    const offset = starts[line] + char;
    out.push({
      name: text.slice(offset, offset + data[i + 2]),
      type: legend.tokenTypes[data[i + 3]],
      modifiers: legend.tokenModifiers.filter((_, b) => data[i + 4] & (1 << b)),
      offset,
      length: data[i + 2],
    });
  }
  return out;
}

const memo = new Map();

/**
 * `{ key, ext, languageId, text, tokens, symbols, copies, unit }` for a language
 * key (ts, go, rs, py, lua, rb) and a target line count. `scanBlocks(text, languageId)`
 * locates the symbols' block ends in the base sample.
 */
function generate(ext, lines, scanBlocks) {
  const id = `${ext}-${lines}`;
  if (memo.has(id)) return memo.get(id);
  const spec = LANGS[ext];
  let base = fs.readFileSync(path.join(ROOT, spec.sample), 'utf8');
  if (!base.endsWith('\n')) base += '\n';
  const full = base;
  if (spec.body) base = spec.body(base);
  const wire = spec.lsp ? JSON.parse(fs.readFileSync(path.join(ROOT, spec.lsp), 'utf8')) : null;
  const baseTokens = (spec.tokens ? JSON.parse(fs.readFileSync(path.join(ROOT, spec.tokens), 'utf8')) : decodeWire(full, wire))
    .filter((t) => t.offset + t.length <= base.length);
  for (const t of baseTokens) {
    if (base.slice(t.offset, t.offset + t.length) !== t.name) {
      throw new Error(`${spec.tokens ?? spec.lsp} is out of date with ${spec.sample} at offset ${t.offset} (${t.name})`);
    }
  }
  const names = renamedNames(baseTokens, spec.keep ? spec.keep() : new Set(), spec.locals);
  const baseLines = base.split('\n').length - 1;
  const copies = Math.ceil(lines / baseLines);
  const unit = base.length;
  const sym = spec.lspSymbols
    ? wireSymbols(full, wire.symbols).filter((r) => r.end <= base.length)
    : baseSymbols(base, baseTokens, scanBlocks(base, spec.languageId));
  const parts = [];
  const tokens = [];
  const symbols = [];
  for (let k = 0; k < copies; k++) {
    const copy = renameCopy(base, names, k);
    if (copy.length !== unit) throw new Error(`rename changed the length of ${ext} copy ${k}`);
    parts.push(copy);
    for (const t of baseTokens) tokens.push({ ...t, offset: t.offset + unit * k });
    for (const s of sym) symbols.push({ start: s.start + unit * k, end: s.end + unit * k });
  }
  const text = parts.join('');
  for (const t of tokens) t.name = text.slice(t.offset, t.offset + t.length);
  const input = { key: id, ext, languageId: spec.languageId, text, tokens, symbols, copies, unit };
  memo.set(id, input);
  return input;
}

module.exports = { generate, LANGS };
