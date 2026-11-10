'use strict';
// Zig: the lexer against Zig's own tokenizer, the brace scan, function and container
// headers, both classifiers on real zls 0.17.0 tokens, escape and danger marks, no
// async marks, the `self` paint, placeholders under zls `full`, the namespace
// restore, and ZON as static content. Rules: docs/zig.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
const { lex, lexFor, relex } = require('../out/lex');
const focus = require('../out/focus');
const risk = require('../out/risk');
const { Classifier } = require('../out/classify-lsp');
const { isZigReserved, isZigTypeName, zigFacts, zigImportSpans } = require('../out/zig');
const { zigPlaceholderSpans } = require('../out/placeholders');
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');
const { growth } = require('./cpu-time');

const SRC = fs.readFileSync(path.join(__dirname, '../samples/sample.zig'), 'utf8');
const PARTIAL = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample.zig.lsp.json'), 'utf8'));
const FULL = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample.zig.full.lsp.json'), 'utf8'));
const TOKENS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample.zig.tokens.json'), 'utf8'));
const regions = (text) => lexFor(text, 'zig').spans.map((s) => `${s.region}:${text.slice(s.start, s.end)}`);
const idents = (text) => lexFor(text, 'zig').idents.map((i) => i.name);
const lineOf = (text, needle) => {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `needle ${needle}`);
  return text.slice(0, at).split('\n').length - 1;
};

test('zig lexer: // /// //! comments, no block comments, \\\\ lines to their end, chars, @"…" and @builtins', () => {
  const t = [
    '//! container doc', '/// doc', 'const a = b /*c*/ / d; // tail', 'const s =', '    \\\\x "y" {z} // w', ';',
    "const c = 'a' + '\\'' + '\\u{1F600}';", 'const @"while" = @intCast(x);', 'const e = "q\\"r";',
  ].join('\n');
  assert.deepEqual(regions(t), [
    'comment://! container doc', 'comment:/// doc', 'comment:// tail', 'string:\\\\x "y" {z} // w',
    "string:'a'", "string:'\\''", "string:'\\u{1F600}'", 'string:"q\\"r"',
  ]);
  assert.deepEqual(idents(t), ['const', 'a', 'b', 'c', 'd', 'const', 's', 'const', 'c', 'const', '@"while"', '@intCast', 'x', 'const', 'e']);
});

test('zig lexer: numerals as Zig reads them, ranges and hex fractions included', () => {
  const t = 'const n = .{ 0xFF_FF, 0o755, 0b1100, 1_000_000, 1e3, 0x1.8p3, -0x103.70, 2.5e-3 }; for (0..n) |i| {} _ = x[1..];';
  assert.deepEqual(lexFor(t, 'zig').numbers.map((r) => t.slice(r.start, r.end)), ['0xFF_FF', '0o755', '0b1100', '1_000_000', '1e3', '0x1.8p3', '0x103.70', '2.5e-3', '0', '1']);
});

test("zig lexer regions equal Zig's tokenizer on every character of the sample", () => {
  const lx = lexFor(SRC, 'zig');
  const want = new Uint8Array(SRC.length);
  let prev = 0;
  const gap = (a, b) => {
    for (let i = a; i < b; i++) if (SRC.startsWith('//', i)) while (i < b && SRC[i] !== '\n') want[i++] = 1;
  };
  for (const [tag, a, b] of TOKENS) {
    gap(prev, a);
    if (/string_literal|char_literal|multiline_string/.test(tag)) want.fill(2, a, b);
    else if (/doc_comment/.test(tag)) want.fill(1, a, b);
    prev = b;
  }
  gap(prev, SRC.length);
  const code = { code: 0, comment: 1, doc: 1, string: 2 };
  const bad = [];
  for (let i = 0; i < SRC.length; i++) if (!/\s/.test(SRC[i]) && code[lx.regionAt(i)] !== want[i]) bad.push(i);
  assert.deepEqual(bad, []);
  const braces = [];
  const stack = [];
  for (const [tag, a] of TOKENS) {
    if (tag === 'l_brace') stack.push(a);
    else if (tag === 'r_brace') braces.push(`${stack.pop()}:${a}`);
  }
  assert.deepEqual(focus.scanBlocks(SRC, 'zig').map((b) => `${b.openOffset}:${b.closeOffset}`).sort(), braces.sort());
});

test("zig lexer: a literal that ends in `\\` at a line break stops there, as Zig's tokenizer does", () => {
  // `zig run test/gen-zig-tokens.zig` over each text: the unclosed literal is one `invalid` token up to the line break.
  const cases = [
    ['fn f() void {\n    const a = "abc\\\n    const b = 1;\n    const s = "x";\n}\n',
      [['keyword_fn', 0, 2], ['identifier', 3, 4], ['l_paren', 4, 5], ['r_paren', 5, 6], ['identifier', 7, 11], ['l_brace', 12, 13],
        ['keyword_const', 18, 23], ['identifier', 24, 25], ['equal', 26, 27], ['invalid', 28, 33], ['keyword_const', 38, 43],
        ['identifier', 44, 45], ['equal', 46, 47], ['number_literal', 48, 49], ['semicolon', 49, 50], ['keyword_const', 55, 60],
        ['identifier', 61, 62], ['equal', 63, 64], ['string_literal', 65, 68], ['semicolon', 68, 69], ['r_brace', 70, 71]]],
    ["const c = 'x\\\nconst d = 2;\nconst q = @\"ab\\\nconst e = 3;\n",
      [['keyword_const', 0, 5], ['identifier', 6, 7], ['equal', 8, 9], ['invalid', 10, 13], ['keyword_const', 14, 19], ['identifier', 20, 21],
        ['equal', 22, 23], ['number_literal', 24, 25], ['semicolon', 25, 26], ['keyword_const', 27, 32], ['identifier', 33, 34],
        ['equal', 35, 36], ['invalid', 37, 42], ['keyword_const', 43, 48], ['identifier', 49, 50], ['equal', 51, 52],
        ['number_literal', 53, 54], ['semicolon', 54, 55]]],
  ];
  for (const [t, toks] of cases) {
    const lx = lexFor(t, 'zig');
    const literal = (a) => t[a] === '"' || t[a] === "'";
    assert.deepEqual(lx.spans.filter((s) => s.region === 'string').map((s) => [s.start, s.end]),
      toks.filter(([tag, a]) => /string_literal|char_literal/.test(tag) || (tag === 'invalid' && literal(a))).map(([, a, b]) => [a, b]));
    assert.deepEqual(lx.idents.map((i) => [i.offset, i.offset + i.length]),
      toks.filter(([tag, a]) => tag === 'identifier' || tag.startsWith('keyword_') || (tag === 'invalid' && t[a] === '@')).map(([, a, b]) => [a, b]));
    assert.deepEqual(lx.numbers.map((r) => [r.start, r.end]), toks.filter(([tag]) => tag === 'number_literal').map(([, a, b]) => [a, b]));
  }
});

test('zig relex equals a full lex over random edits that open and close strings, chars and \\\\ lines', () => {
  const SNIPS = ['a', ' ', '\n', '"', "'", '\\', '\\\\', '//', '{', '}', '@"', '@x', '.*', ' = 1;', 'const z = ', '|v|'];
  let s = 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let text = SRC;
  let prev = lex(text, 'zig');
  let relexed = 0;
  for (let e = 0; e < 300; e++) {
    const at = Math.floor(rnd() * (text.length + 1));
    const del = rnd() < 0.4 ? Math.floor(rnd() * 4) : 0;
    const ins = rnd() < 0.8 ? SNIPS[Math.floor(rnd() * SNIPS.length)] : '';
    const next = text.slice(0, at) + ins + text.slice(at + del);
    const r = relex(prev, next, at, at + del, at + ins.length);
    const full = lex(next, 'zig');
    if (r) {
      relexed++;
      for (const k of ['spans', 'idents', 'numbers', 'punct', 'lineStarts']) assert.deepEqual(r[k], full[k], `${k} after edit ${e}`);
    }
    text = next;
    prev = full;
  }
  assert.ok(relexed > 200, `${relexed} of 300 re-lexed`);
});

test('zig headers: fn with every prefix and test blocks are functions; containers and control flow are not', () => {
  const t = [
    'pub fn a(x: u8) !void {', '}', 'pub inline fn b(y: u8) u8 {', '}', 'export fn c(z: i32) i32 {', '}', 'noinline fn d() void {', '}',
    'test "e" {', '}', 'const P = struct {', '}', 'const U = union(enum) {', '}', 'const F = packed struct(u8) {', '}',
    'fn g(comptime T: type) type {', '    return struct {', '    };', '}', 'fn h(o: ?u8) void {', '    if (o) |v| {', '    }', '    x catch |err| {', '    };',
    '    const pt = Point{', '    };', '}',
  ].join('\n');
  const blocks = focus.scanBlocks(t, 'zig');
  const kind = (needle) => {
    const b = blocks.find((x) => x.openLine === lineOf(t, needle));
    return focus.isFunctionHeader(t, b, 'zig') ? 'fn' : focus.declRegionFor(t, b, 'zig').start < b.openOffset ? 'control' : 'plain';
  };
  for (const n of ['pub fn a', 'pub inline fn b', 'export fn c', 'noinline fn d', 'test "e"', 'fn g(']) assert.equal(kind(n), 'fn', n);
  for (const n of ['const P', 'const U', 'const F', 'return struct', 'const pt = Point{']) assert.equal(kind(n), 'plain', n);
  for (const n of ['if (o) |v|', 'catch |err|']) assert.equal(kind(n), 'control', n);
});

test('zig facts: labels, builtins, fields, enum members, type parameters, type and namespace consts, captures', () => {
  const t = [
    'const std = @import("std");', 'const mem = std.mem;', 'const Point = struct { x: f32, y: f32 = 0 };', 'const Color = enum { red, green };',
    'fn f(comptime T: type, a: T) void {', '    const v = blk: { break :blk a; };', '    outer: while (true) : (i += 1) { continue :outer; }',
    '    if (opt) |x| {} else |err| {}', '    for (xs, 0..) |*p, i| {}', '    _ = s catch |e| e;', '    switch (u) { .a => |n| n, else => {} }', '}',
  ].join('\n');
  const z = zigFacts(lexFor(t, 'zig'));
  const at = (set) => [...set].map((o) => t.slice(o, o + 12).match(/^@?[\w"]+/)[0]).sort();
  assert.deepEqual(at(z.nonDataAt), ['@import', 'T', 'blk', 'blk', 'green', 'outer', 'outer', 'red', 'x', 'y'].sort());
  assert.deepEqual([...z.nonDataNames].sort(), ['Color', 'Point', 'T', 'mem', 'std']);
  assert.deepEqual([...z.imports].sort(), ['std'], 'an alias no use reads a member of is not known to be a namespace');
  assert.deepEqual(z.captures.map((c) => c.name), ['x', 'err', 'p', 'i', 'e', 'n']);
});

test('zig facts: a const is a type or namespace only when its initializer is one; error values, comparisons and literals are values', () => {
  const t = [
    'const std = @import("std");', 'const sub = @import("x.zig").sub;', 'const Self = @This();', 'const Err = error{A};',
    'const err_value = error.A;', 'const typed: anyerror = error.A;', 'const have_flock = @TypeOf(std.posix.flock) != void;',
    'const zero = @Vector(2, u64){ 0, 0 };', 'const Vec = @Vector(4, f32);', 'const handler = fn (u8) void;', 'const unclosed = @TypeOf(',
  ].join('\n');
  const z = zigFacts(lexFor(t, 'zig'));
  assert.deepEqual([...z.nonDataNames].sort(), ['Err', 'Self', 'Vec', 'handler', 'std']);
  assert.deepEqual([...z.imports].sort(), ['std']);
});

test('zig names: keywords, primitive types and any [iu]N are reserved; TitleCase and one capital letter are types, ALL_CAPS is a value', () => {
  for (const n of ['const', 'errdefer', 'usingnamespace', 'async', 'undefined', 'u8', 'i128', 'u0', 'usize', 'c_int', 'comptime_int', 'anyerror', 'type']) {
    assert.ok(isZigReserved(n), n);
  }
  for (const n of ['self', 'this', 'u8x', 'uint', 'value', 'Self']) assert.ok(!isZigReserved(n), n);
  for (const n of ['T', 'Point', 'ArrayList', 'Self', 'U8x']) assert.ok(isZigTypeName(n), n);
  for (const n of ['MAX_LEN', 'KV', 'point', 'x', '_T']) assert.ok(!isZigTypeName(n), n);
});

test('zig facts: a declaration read across blanks, tabs, line breaks and comments; typed consts; comptime fields', () => {
  const t = [
    'const std = @import("std");', 'const a_ns =\n    @import("a.zig");', 'const b_ns =\r\n    @import("b.zig");', 'const c_ns =\t@import("c.zig");',
    'const d_ns = // why\n    @import("d.zig");', 'const e_ns: type = @import("e.zig");', 'const S = struct {', '    comptime k: u8 = 1,', '    /// doc', '    v: u8,', '};',
    'const lanes = @Vector(@sizeOf(u32), u8);', 'const U = union(enum) { w: u8, z };', 'fn g(n: usize, comptime elem: type) void {}',
  ].join('\n');
  const z = zigFacts(lexFor(t, 'zig'));
  assert.deepEqual([...z.imports].sort(), ['a_ns', 'b_ns', 'c_ns', 'd_ns', 'e_ns', 'lanes', 'std']);
  const at = [...z.nonDataAt].map((o) => t.slice(o, o + 1));
  for (const f of ['k', 'v', 'w', 'z']) assert.ok(at.includes(f), `field ${f}: ${at.join(' ')}`);
  assert.ok(z.nonDataNames.has('elem') && !at.includes('n'), 'a type parameter last in its list');
});

test('zig facts: only an alias of an import can be a namespace; a value alias, a type alias and a TitleCase alias are not', () => {
  const t = [
    'const std = @import("std");', 'const Point = struct { const zero = 0; };', 'const max_len = 64;', 'const limit = max_len;',
    'const point_type = Point;', 'const Io = std.Io;', 'const mem = std.mem;',
    'test "t" {', '    _ = point_type.zero;', '    _ = Io.Writer;', '    _ = mem.eql;', '    _ = limit;', '}',
  ].join('\n');
  const z = zigFacts(lexFor(t, 'zig'));
  assert.deepEqual([...z.imports].sort(), ['mem', 'std']);
  assert.ok(!z.nonDataNames.has('limit'), 'an alias of a value is a value');
  assert.ok(z.nonDataNames.has('point_type') && z.nonDataNames.has('Io'));
});

test('zig facts: a bar that opens no capture: bitwise or after a group, `||` error-set merges, and a half-typed capture', () => {
  const t = [
    'const E = error{A} || error{B};', 'fn f(a: u8, b: u8, opt: ?u8) u8 {', '    const m = (a) | b;', '    if (opt) |', '    _ = m;', '    return m | 1;', '}',
  ].join('\n');
  assert.deepEqual(zigFacts(lexFor(t, 'zig')).captures, []);
});

test('zig facts: an alias of a namespace is not data at container level; inside a function it is a value', () => {
  const t = 'const std = @import("std");\nconst testing = std.testing;\ntest "t" {\n    const a = testing.allocator;\n    _ = a;\n}\n';
  const z = zigFacts(lexFor(t, 'zig'));
  assert.ok(z.nonDataNames.has('testing'));
  assert.ok(!z.nonDataNames.has('a'));
});

async function classify(text, served, needle, tok) {
  stub.clearLspResponses();
  if (served) {
    stub.setLspResponses({
      'vscode.provideDocumentSemanticTokensLegend': served.legend,
      'vscode.provideDocumentSemanticTokens': { data: served.data },
      'vscode.executeDocumentSymbolProvider': [],
    });
  }
  const doc = new stub.TextDocument(text, 'zig', `file:///zig-${Math.random()}.zig`);
  const blocks = focus.scanBlocks(text, 'zig');
  const line = lineOf(text, needle);
  const start = text.split('\n').slice(0, line).join('\n').length + (line > 0 ? 1 : 0);
  const offset = start + text.split('\n')[line].indexOf(tok, text.split('\n')[line].indexOf(needle.trim()));
  const block = focus.innermostBlock(blocks, line, offset, text);
  const r = await new Classifier().classifyScope(doc, block, 5, { isCancellationRequested: false }, { text, blocks });
  const region = focus.lexRegionFor(text, block, 'zig');
  const escapes = risk.escapeRisk(text, region, r.focused, 'zig').map((e) => text.slice(e.start, e.end));
  const lexical = risk.lexicalRisk(text, region, 'zig');
  return { byName: r.focused.byName, escapes, lexical, text };
}

for (const [mode, served] of [['no server', null], ['zls partial', PARTIAL], ['zls full', FULL]]) {
  test(`zig classification, ${mode}: locals, parameters and captures are data; types, namespaces, labels, fields, builtins and self are not`, async () => {
    const at = async (needle, tok, data, not) => {
      const m = await classify(SRC, served, needle, tok);
      for (const n of data) assert.ok(m.byName.has(n), `${needle}: ${n} is data`);
      for (const n of not) assert.ok(!m.byName.has(n) || m.byName.get(n).cls === 'self', `${needle}: ${n} is not`);
    };
    await at('seen += s.len + i;', 'seen', ['seen', 's', 'i'], ['len', 'Value', 'text']);
    await at('.float => |f| total.* += f,', 'f', ['total', 'n', 'f', 'v'], ['int', 'float', 'floatFromInt', '@floatFromInt']);
    await at('acc += @intCast(j);', 'acc', ['acc', 'j'], ['blk', 'outer', '@intCast', 'intCast']);
    await at('self.x *= k;', 'k', ['k'], ['self', 'Self', 'x', 'y']);
    await at('total += @sizeOf(field.type);', 'total', ['total', 'field'], ['T', 'std', 'meta', 'fields', 'type']);
    await at('const buf = try allocator.alloc(u8, 16);', 'buf', ['buf', 'allocator'], ['Allocator', 'u8', 'alloc']);
    await at('std.debug.print(text, .{ width, text });', 'width', ['width', 'text'], ['and', 'inside', 'string', 'more', 'std', 'debug']);
    await at('if (self.len == 0) return null;', 'len', [], ['self', 'T', 'Self', 'items', 'len']);
    await at('@"quoted name" += @"while";', '@"quoted', ['@"quoted name"', '@"while"', 'greeting'], ['Hello', 'world', 'braces', 'variable']);
  });
}

test('zig scopes: a capture after `catch` or `orelse` belongs to the block its header opens; the parameter list is the `(` after `fn`', async () => {
  const t = [
    'fn load(a: u8, b: u8) !u8 {', '    const n = parse(a) catch |err| switch (err) {', '        error.X => 0,', '        else => return err,', '    };',
    '    return n + b + n;', '}',
    'fn pick(n: u8, value: anytype) @TypeOf(value) {', '    if (n > 0) return value;', '    return value;', '}',
    'export fn bump(x: i32, y: i32) callconv(.c) i32 {', '    return x + y + x;', '}',
  ].join('\n');
  for (const served of [null, stub.encodeTokens(t, [])]) {
    const body = (await classify(t, served, '    return n + b + n;', 'b')).byName;
    assert.ok(!body.has('err') || body.get('err').proximity === 2, `${served ? 'tokens' : 'no server'}: the capture is the switch block's, not the function body's: ${JSON.stringify(body.get('err'))}`);
    for (const n of ['a', 'b', 'n']) assert.equal(body.get(n)?.proximity, 0, n);
    const inner = (await classify(t, served, '        else => return err,', 'err')).byName;
    assert.equal(inner.get('err')?.proximity, 0, 'inside the switch the capture is its own');
    const pick = (await classify(t, served, '    if (n > 0) return value;', 'n')).byName;
    for (const n of ['n', 'value']) assert.equal(pick.get(n)?.cls, 'fn', `${n}: a parameter, not the return type's \`@TypeOf(value)\``);
    const bump = (await classify(t, served, '    return x + y + x;', 'x')).byName;
    for (const n of ['x', 'y']) assert.equal(bump.get(n)?.cls, 'fn', `${n}: a parameter, not \`callconv(.c)\``);
  }
});

test('zig classification, no server: a TitleCase or one-letter capital local is a type by convention, an ALL_CAPS one is data', async () => {
  const t = 'fn f(a: u8) u8 {\n    const Max = 3;\n    const N = 4;\n    const LIMIT = 5;\n    return a + Max + N + LIMIT + Max + N + LIMIT;\n}\n';
  const m = await classify(t, null, 'return a + Max', 'a');
  assert.ok(m.byName.has('a') && m.byName.has('LIMIT'));
  assert.ok(!m.byName.has('Max') && !m.byName.has('N'));
});

test('zig escape marks with zls tokens: writes through a parameter pointer, a self field, an outer local and a container var', async () => {
  const at = async (needle, tok) => (await classify(SRC, PARTIAL, needle, tok)).escapes;
  assert.deepEqual(await at('.float => |f| total.* += f,', 'f'), ['total.*', 'total.*', 'seen']);
  assert.deepEqual(await at('self.x *= k;', 'k'), ['self.x', 'self.y']);
  assert.deepEqual(await at('acc += @intCast(j);', 'acc'), ['acc']);
  assert.deepEqual(await at('const buf = try allocator.alloc(u8, 16);', 'buf'), ['counter']);
  assert.deepEqual(await at('mutable.* = 9;', 'mutable'), [], 'writes through local pointers and to locals stay unmarked');
  assert.deepEqual((await classify(SRC, null, '.float => |f| total.* += f,', 'f')).escapes, [], 'the heuristic makes no claim');
});

test('zig escape marks through `.*` and `.?` and a long member, with zls-shaped tokens', async () => {
  const t = 'const P = struct { items: u32, x: u32 };\nfn f(opt: ?*P, p: *P, q: *P) void {\n    opt.?.items = 1;\n    p.* = .{ .items = 0, .x = 0 };\n    q.items += 1;\n}\n';
  const toks = [];
  for (const m of t.matchAll(/\b(opt|p|q)\b/g)) {
    const decl = t[m.index + m[0].length] === ':';
    toks.push({ offset: m.index, length: m[0].length, type: 'parameter', modifiers: decl ? ['declaration'] : [] });
  }
  const m = await classify(t, stub.encodeTokens(t, toks), 'opt.?.items = 1;', 'opt');
  assert.deepEqual(m.escapes, ['opt.?.items', 'p.*', 'q.items']);
});

test('zig lexical risk: the pointer casts are danger, value casts and undefined are not; no async marks', async () => {
  const m = await classify(SRC, PARTIAL, 'mutable.* = 9;', 'mutable');
  assert.deepEqual(m.lexical.danger.map((r) => SRC.slice(r.start, r.end)), ['@ptrCast', '@intFromPtr', '@ptrCast', '@alignCast', '@constCast']);
  const t = 'fn f(io: Io, g: *Group) !void {\n    g.async(io, work, .{});\n    try g.await(io);\n    const x: u8 = @intCast(@truncate(@bitCast(y)));\n    var b: [4]u8 = undefined;\n}\n';
  const r = risk.lexicalRisk(t, { start: 0, end: t.length }, 'zig');
  assert.deepEqual(r.async, []);
  assert.deepEqual(r.danger, []);
});

test('zig numbers clay in code only: never in a \\\\ line, a string or a comment', () => {
  const t = 'fn f() void {\n    const s =\n        \\\\42 and 7\n    ;\n    const n = 3; // 9\n    _ = "5";\n}\n';
  assert.deepEqual(risk.lexicalRisk(t, { start: 0, end: t.length }, 'zig').numberEngaged.map((r) => t.slice(r.start, r.end)), ['3']);
});

let seq = 0;
async function editor(text, served, caret, fileName = `/zig-editor-${seq++}.zig`) {
  stub.clearLspResponses();
  if (served) {
    stub.setLspResponses({
      'vscode.provideDocumentSemanticTokensLegend': served.legend,
      'vscode.provideDocumentSemanticTokens': { data: served.data },
      'vscode.executeDocumentSymbolProvider': [],
    });
  }
  const doc = new stub.TextDocument(text, 'zig', `file://${fileName}`);
  const ed = new stub.TextEditor(doc, lineOf(text, caret), 6);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  d.engaged.add(doc.uri.toString());
  d.render();
  await d.runClassify(doc);
  const count = (type) => (live.get(type) ?? []).length;
  return { d, doc, live, count };
}

test('zig band 1: `self` at keyword grey in every phase and server state; `this`, a member `.self` and a field `self` are names', async () => {
  const t = [
    'const T = struct {', '    self: u8,', '    pub fn m(self: *T, this: u8) void {', '        self.self = this;', '        _ = .{ .self = 1 };',
    '        const v = self;', '        _ = v;', '        // self', '        _ = "self";', '    }', '};', 'fn g(', '    self: *T,', ') void {', '    _ = self.self;', '}',
    'const E = enum { self, other };', 'const F = enum { other, self };', 'fn h(self: E) void {', '    _ = .{ self, 1 };', '}',
  ].join('\n');
  const want = ['3:13', '4:8', '6:18', '13:4', '15:8', '19:5', '20:11'];
  const shown = (h) => (h.live.get(h.d.pool.self) ?? []).map((r) => `${r.start.line + 1}:${r.start.character}`);
  for (const served of [null, PARTIAL]) {
    const h = await editor(t, served, 'const v = self;');
    for (const phase of [Phase.Survey, Phase.Focus, Phase.Edit]) {
      h.d.machine.phase = phase;
      h.d.render();
      assert.deepEqual(shown(h), want, `${served ? 'zls' : 'no server'}, phase ${phase}`);
    }
    h.d.dispose();
  }
  const sample = await editor(SRC, PARTIAL, 'self.x *= k;');
  const selfs = lexFor(SRC, 'zig').idents.filter((i) => i.name === 'self').length;
  assert.equal(sample.count(sample.d.pool.self), selfs, 'every `self` of the sample is a receiver');
  sample.d.dispose();
});

test('zig ZON: a .zon file opens as zig and reads as static content: no blocks, no bands in any phase', async () => {
  assert.equal(focus.effectiveLanguageId('zig', '/p/build.zig.zon'), 'zon');
  assert.equal(focus.effectiveLanguageId('zig', '/p/build.zig'), 'zig');
  assert.ok(focus.isNonFlowLanguage('zon'));
  assert.equal(focus.band1LanguageId('zon'), 'zon', 'band 1 restores nothing in ZON');
  const zon = '.{\n    .name = .demo,\n    .version = "0.1.0",\n    .fingerprint = 0x1234,\n    .paths = .{ "src", "build.zig" },\n    .x = self,\n}\n';
  assert.deepEqual(focus.scanBlocks(zon, 'zon'), []);
  const h = await editor(zon, null, '.fingerprint', '/p/build.zig.zon');
  for (const phase of [Phase.Survey, Phase.Focus, Phase.Edit]) {
    h.d.machine.phase = phase;
    h.d.render();
    const painted = [...h.live.entries()].filter(([, r]) => r.length > 0).map(([type]) => type);
    assert.deepEqual(painted, [], `phase ${phase}`);
  }
  h.d.dispose();
});

test('zig facts are linear in the file', () => {
  const unit = (i) => `const m${i} = std.mem;\nfn f${i}(a${i}: u8, comptime T: type) T {\n    const v = blk: { break :blk m${i}.len(a${i}); };\n`
    + `    if (o) |x| { _ = x; }\n    return v;\n}\n`;
  const setup = (n) => lex(`const std = @import("std");\n${Array.from({ length: n }, (_, i) => unit(i)).join('')}`, 'zig');
  assert.deepEqual([...zigFacts(setup(2)).imports].sort(), ['m0', 'm1', 'std'], 'every unit holds a namespace alias');
  const ratio = growth(setup, (lx) => zigFacts(lx), 300);
  assert.ok(ratio < 24, `8x the lines cost ${ratio.toFixed(1)}x`);
});

test('zig band 1: namespace consts at type slate with no server, declaration and uses; never members or calls; off once zls answers', async () => {
  const t = 'const std = @import("std");\nconst mem = std.mem;\nconst assert = std.debug.assert;\nfn f(a: []const u8) bool {\n    assert(a.len > 0);\n    return mem.eql(u8, a, "x") and std.mem.eql(u8, a, a);\n}\n';
  const shown = (h) => (h.live.get(h.d.pool.importRestore) ?? []).map((r) => `${r.start.line + 1}:${h.doc.lineAt(r.start.line).text.slice(r.start.character, r.end.character)}`);
  const none = await editor(t, null, 'return mem.eql');
  for (const phase of [Phase.Survey, Phase.Focus, Phase.Edit]) {
    none.d.machine.phase = phase;
    none.d.render();
    assert.deepEqual(shown(none), ['1:std', '2:mem', '2:std', '3:std', '6:mem', '6:std'], `phase ${phase}`);
  }
  none.d.dispose();
  const lines = t.split('\n');
  const toks = [];
  for (const [l, word, type] of [[0, 'std', 'namespace'], [1, 'mem', 'namespace'], [5, 'mem', 'namespace']]) {
    toks.push({ offset: t.split('\n').slice(0, l).join('\n').length + (l ? 1 : 0) + lines[l].indexOf(word), length: word.length, type, modifiers: [] });
  }
  const zls = await editor(t, stub.encodeTokens(t, toks), 'return mem.eql');
  assert.deepEqual(shown(zls), [], 'zls types the namespaces itself');
  zls.d.dispose();
  const one = 'const std = @import("std");\ntest "t" {\n    _ = std.mem;\n}\n';
  assert.deepEqual(zigImportSpans(lexFor(one, 'zig')).map((r) => one.slice(r.start, r.end)), ['std', 'std'], 'a file with one import');
});

test('zig band 1: a namespace restore stays in the scope that declares it and off fields; a sibling scope\'s parameter of that name is data', async () => {
  const offsetOf = (t, line, word, nth = 0) => {
    const l = t.split('\n')[line - 1];
    let c = -1;
    for (let k = 0; k <= nth; k++) c = l.indexOf(word, c + 1);
    return t.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0) + c;
  };
  const spans = (t) => zigImportSpans(lexFor(t, 'zig')).map((r) => `${t.slice(0, r.start).split('\n').length}:${t.slice(r.start, r.end)}`);
  const fields = 'const std = @import("std");\npub const path = std.fs.path;\npub const Entry = struct {\n    path: []const u8,\n    depth: usize,\n};\n'
    + 'const U = extern union { path: u8, std: u16 };\nconst E = enum { std, path };\npub fn f(e: Entry) bool {\n    return path.isAbsolute(e.path);\n}\n';
  assert.deepEqual(spans(fields), ['1:std', '2:path', '2:std', '10:path'], 'a field, a one-line field and an enum member keep the theme\'s member steel');
  const sibling = 'const A = struct {\n    const json = @import("json.zig");\n    pub fn f() void {\n        _ = json.parse;\n    }\n};\n'
    + 'fn parse(json: []const u8) usize {\n    const n = json.len;\n    return n;\n}\n';
  assert.deepEqual(spans(sibling), ['2:json', '4:json']);
  const z = zigFacts(lexFor(sibling, 'zig'));
  assert.ok(z.nonDataUse('json', offsetOf(sibling, 4, 'json')));
  assert.ok(!z.nonDataUse('json', offsetOf(sibling, 7, 'json')) && !z.nonDataUse('json', offsetOf(sibling, 8, 'json')));
  const m = await classify(sibling, null, 'const n = json.len;', 'json');
  const alone = 'fn parse(json: []const u8) usize {\n    const n = json.len;\n    return n;\n}\n';
  const m2 = await classify(alone, null, 'const n = json.len;', 'json');
  assert.ok(m.byName.has('json') && m.byName.has('n'), 'the parameter and the local are data, as in the function alone');
  assert.deepEqual([...m.byName.keys()].sort(), [...m2.byName.keys()].sort());
  const params = 'fn f(comptime ctx_type: type, x: ctx_type) ctx_type {\n    return x;\n}\nfn g(ctx_type: u8) u8 {\n    return ctx_type;\n}\n';
  const zp = zigFacts(lexFor(params, 'zig'));
  assert.ok(zp.nonDataUse('ctx_type', offsetOf(params, 1, 'ctx_type', 1)) && zp.nonDataUse('ctx_type', offsetOf(params, 1, 'ctx_type', 2)),
    'a type parameter covers its signature');
  assert.ok(!zp.nonDataUse('ctx_type', offsetOf(params, 4, 'ctx_type')) && !zp.nonDataUse('ctx_type', offsetOf(params, 5, 'ctx_type')), 'not the next function');
  // Twelve sibling containers bind the same name, past the linear scan of a few scopes.
  const many = Array.from({ length: 12 }, (_, i) => `const Box${i} = struct {\n    const json = @import("json.zig");\n    pub fn f() void {\n        _ = json.parse;\n    }\n};\n`
    + `fn parse${i}(json: []const u8) usize {\n    return json.len;\n}\n`).join('');
  assert.deepEqual(spans(many), Array.from({ length: 12 }, (_, i) => [`${9 * i + 2}:json`, `${9 * i + 4}:json`]).flat());
  const zm = zigFacts(lexFor(many, 'zig'));
  for (let i = 0; i < 12; i++) assert.ok(!zm.nonDataUse('json', offsetOf(many, 9 * i + 8, 'json')), `parse${i}'s parameter is data`);
});

test('zig placeholders: the holes of a literal after `(` or `, ` with its `.{` arguments on the line; escapes, `{{`, `}}` and other literals are text', () => {
  const t = [
    'std.debug.print("a {} b {d} c {s:>8} {x:0>4} {[k]d} {any}\\n", .{ n, n, "s", n, .{ .k = n }, n });',
    'try w.print("{{x}} \\u{1F600} \\{d} \\\\{e} {s}", .{x});',
    'const s = try std.fmt.bufPrint(&buf, "{d}.{d}" , .{ 1, 2 });',
    'const plain = "a {} b";',
    'std.debug.print("next line {d}",',
    '    .{n});',
    'std.debug.print( "spaced {d}", .{n});',
    'std.debug.print("cat {d}" ++ "x", .{n});',
    'const lit = .{ "in a tuple {d}" };',
    'const m =',
    '    \\\\multiline {d}',
    ';',
    '// std.debug.print("comment {d}", .{n});',
    'std.debug.print("unclosed {d}, .{n});',
    'std.debug.print("{{a}}{d}", .{n});',
  ].join('\n');
  assert.deepEqual(zigPlaceholderSpans(t).map((r) => t.slice(r.start, r.end)), ['{}', '{d}', '{s:>8}', '{x:0>4}', '{[k]d}', '{any}', '{e}', '{s}', '{d}', '{d}', '{d}']);
});

test('zig band 1: placeholders while zls types string literals (full), none under partial or with no server', async () => {
  const want = zigPlaceholderSpans(SRC).length;
  assert.ok(want >= 15, `${want} holes in the sample`);
  for (const [served, n] of [[FULL, want], [PARTIAL, 0], [null, 0]]) {
    const h = await editor(SRC, served, 'self.x *= k;');
    for (const phase of [Phase.Survey, Phase.Focus, Phase.Edit]) {
      h.d.machine.phase = phase;
      h.d.render();
      assert.equal(h.count(h.d.pool.placeholder), n, `${served?.mode ?? 'no server'}, phase ${phase}`);
    }
    h.d.dispose();
  }
  const zon = await editor('.{\n    .name = .demo,\n    .x = .{ "a {d}", .{} },\n}\n', FULL, '.name', '/p/build.zig.zon');
  zon.d.render();
  assert.equal(zon.count(zon.d.pool.placeholder), 0, 'ZON paints nothing');
  zon.d.dispose();
});
