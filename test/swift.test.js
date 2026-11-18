'use strict';
// Swift, Objective-C and Metal: the Swift lexer, the facts the classifier reads with no server
// and over sourcekit-lsp's tokens, danger marks, Objective-C method scopes, selectors and
// sourcekit-lsp's legend, Metal's lexer key, and the Apple build and data formats read as
// static content. Rules: docs/swift.md, docs/c-jvm.md#objective-c.
//   constructs.swift.sk.json   sourcekit-lsp 6.4 (Command Line Tools) over stdio, in a SwiftPM package
//   Widget.m.sk.json           the same server's wire answer for Widget.m (with Widget.h): legend and raw data
// Both come from test/gen-swift-semtok.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');
const focus = require('../out/focus');
const { lexFor } = require('../out/lex');
const { swiftFacts, swiftTokens, swiftRestores } = require('../out/swift');
const { lexicalRisk } = require('../out/risk');
const { sourcekitClangLegend, SOURCEKIT_LEGEND } = require('../out/classify-lsp');

const FIX = path.join(__dirname, 'fixtures/swift');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

async function focusAt(text, languageId, needle, { tokens, raw } = {}) {
  stub.clearLspResponses();
  if (tokens) {
    const served = stub.encodeTokens(text, tokens);
    stub.setLspResponses({ 'vscode.provideDocumentSemanticTokensLegend': served.legend, 'vscode.provideDocumentSemanticTokens': { data: served.data } });
  }
  if (raw) stub.setLspResponses({ 'vscode.provideDocumentSemanticTokensLegend': raw.legend, 'vscode.provideDocumentSemanticTokens': { data: raw.data } });
  stub.setLspResponses({ 'vscode.executeDocumentSymbolProvider': [] });
  const doc = new stub.TextDocument(text, languageId, `file:///swift-${Math.random()}`);
  const ed = new stub.TextEditor(doc, 0, 0);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  d.engaged.add(doc.uri.toString());
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `needle ${needle}`);
  const pos = doc.positionAt(at);
  ed.selection = new vs.Selection(pos.line, pos.character, pos.line, pos.character);
  d.machine.phase = Phase.Focus;
  await d.runClassify(doc);
  d.render();
  const words = (types) => types.flatMap((t) => live.get(t) ?? []).map((r) => text.slice(doc.offsetAt(r.start), doc.offsetAt(r.end)));
  const tints = words([...d.pool.id, ...d.pool.idg]);
  d.machine.phase = Phase.Edit;
  await d.runClassify(doc);
  d.render();
  const out = {
    tints, danger: words([d.pool.riskDanger]), escape: words([d.pool.riskEscape]), self: words([d.pool.self]),
    operators: words([d.pool.operatorRestore]), brackets: words([d.pool.bracketRestore]), attributes: words([d.pool.attributeRestore]),
    constants: words([d.pool.constantRestore]), calls: words([d.pool.callRestore]),
  };
  d.dispose();
  return out;
}

// ── lexer ────────────────────────────────────────────────────────────────────

test('Swift strings: interpolation holes, raw strings with pounds, multi-line strings, nested literals', () => {
  const text = [
    'let a = "x \\(name) y \\(count + 1)"',
    'let b = #"raw \\(kept) \\#(hole)"#',
    'let c = ##"a "#quote"# b"##',
    'let d = """',
    '  \\(inner) and \\"""',
    '  """',
    'let e = "outer \\("in \\(deep)") done"',
  ].join('\n');
  const lx = lexFor(text, 'swift');
  const holes = lx.holes.map((h) => text.slice(h.start, h.end));
  assert.deepEqual(holes, ['name', 'count + 1', 'hole', 'inner', '"in \\(deep)"', 'deep']);
  assert.ok(!lx.isCode(text.indexOf('kept')), '`\\(` inside `#"…"#` is text');
  assert.ok(!lx.isCode(text.indexOf('quote')), '`"#` inside `##"…"##` does not close it');
  assert.ok(lx.isCode(text.indexOf('let e')), 'the multi-line string closed at its own line');
});

test('Swift regex literals: `/…/` in expression position and `#/…/#`, division elsewhere', () => {
  const text = 'let r = /\\d+/\nlet x = #/(?<w>[a-z]+)/#\nlet y = #/\n  a / b\n  /#\nlet q = 10 / 2 / 5\nf(a / 2, b / 3)\n';
  const lx = lexFor(text, 'swift');
  const strings = lx.spans.filter((s) => s.region === 'string').map((s) => text.slice(s.start, s.end));
  assert.deepEqual(strings, ['/\\d+/', '#/(?<w>[a-z]+)/#', '#/\n  a / b\n  /#']);
});

test('Swift `#` words and backtick names are single identifiers, never data candidates', () => {
  const lx = lexFor('#if os(macOS)\nlet `default` = 3\n#endif\nif #available(macOS 14, *) {}\n', 'swift');
  const names = lx.idents.map((i) => i.name);
  assert.ok(names.includes('#if') && names.includes('#endif') && names.includes('#available') && names.includes('`default`'), names.join(' '));
  assert.ok(!names.includes('if') || names.indexOf('if') > names.indexOf('#endif'), 'the directive is not the keyword');
});

// ── facts ────────────────────────────────────────────────────────────────────

test('Swift facts: parameters by their internal name, labels and properties are not data', () => {
  const text = read('constructs.swift');
  const lx = lexFor(text, 'swift');
  const f = swiftFacts(lx);
  const declared = (name, near) => [...f.decls.values()].some((d) => d.name === name && d.kind !== 'implicit' && text.slice(Math.max(0, d.offset - 80), d.offset).includes(near));
  assert.ok(declared('count', 'times '), '`times count: Int` declares count');
  assert.ok(declared('factor', 'by '), '`by factor` declares factor');
  assert.ok(!declared('total', 'private var '), 'a stored property is band 1');
  assert.ok(!declared('times', 'add(_ amount: Int, '), 'an external label is not data');
  const radius = text.indexOf('radius: radius * factor');
  assert.equal(f.binding.has(radius), false, 'an argument label is not data');
  assert.equal(f.binding.has(radius + 'radius: '.length), false, 'a read of the property `radius` through implicit self resolves to nothing');
});

test('Swift facts: closures, `$0`, guard and if-let shorthand, case patterns, for-in, implicit names', () => {
  const text = read('constructs.swift');
  const f = swiftFacts(lexFor(text, 'swift'));
  const kinds = {};
  for (const d of f.decls.values()) kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
  for (const k of ['param', 'local', 'closureParam', 'global', 'implicit']) assert.ok(kinds[k] > 0, `${k}: ${JSON.stringify(kinds)}`);
  const at = (s, k = 0) => text.indexOf(s) + k;
  assert.ok(f.binding.has(at('$0.area')), '`$0` is the closure\'s data');
  assert.ok(f.declSites.has(at('guard let input') + 'guard let '.length), 'guard-let shorthand declares');
  assert.ok(f.declSites.has(at('case .number(let n) where') + 'case .number(let '.length), 'a case pattern binds');
  assert.ok(f.declSites.has(at('for row in grid') + 4), 'a labelled for-in binds');
  assert.ok(f.binding.has(at('print("will", newValue)') + 'print("will", '.length), '`newValue` in willSet');
  assert.equal(f.binding.has(at('copy + copy other') + 'copy + '.length), false, '`copy other` is the ownership operator');
});

test('Swift: a binding before a trailing closure belongs to the enclosing function, the call it trails to the closure', async () => {
  const text = [
    'func f(items: [Int]) -> String {',
    '    let names = items.map { String($0) }',
    '    let first = VStack(items) { v in v }',
    '    return names.joined() + first',
    '}',
  ].join('\n');
  const fn = await focusAt(text, 'swift', 'return names');
  for (const n of ['names', 'first', 'items']) assert.ok(fn.tints.includes(n), `${n}: ${fn.tints.join(' ')}`);
  const closure = await focusAt(text, 'swift', 'v in v');
  assert.ok(closure.tints.includes('v') && !closure.tints.includes('first') && !closure.tints.includes('names'), closure.tints.join(' '));
});

test('sourcekit-lsp tokens: declarations come from the facts, its reads stand, nothing leaks across functions', async () => {
  const text = read('constructs.swift');
  const tokens = JSON.parse(read('constructs.swift.sk.json'));
  const lx = lexFor(text, 'swift');
  const merged = swiftTokens(lx, tokens.map((t) => ({ ...t, name: text.slice(t.offset, t.offset + t.length) })));
  assert.ok(merged.some((t) => t.modifiers.includes('declaration')), 'declaration tokens are synthesised');
  const counter = [text.indexOf('public final class Counter'), text.indexOf('public actor Bank')];
  assert.ok(!merged.some((t) => t.offset > counter[0] && t.offset < counter[1] && t.name === 'total'), 'a read of the stored property `total` stays band 1');
  const h = await focusAt(text, 'swift', 'for _ in 0..<count');
  const s = await focusAt(text, 'swift', 'for _ in 0..<count', { tokens });
  assert.deepEqual(s.tints.sort(), h.tints.sort(), 'no repaint when the server answers');
  assert.ok(h.tints.includes('amount') && h.tints.includes('count'), h.tints.join(' '));
  assert.ok(!s.escape.includes('found'), 'a local write is not escaping');
});

// ── danger marks ─────────────────────────────────────────────────────────────

test('Swift danger: force unwraps, try!, as!, unowned(unsafe), nonisolated(unsafe), @unchecked; not as?, as:, try?, != or T!, [T]!, (() -> T)!', () => {
  const text = [
    'class C: @unchecked Sendable {',
    '  func url() -> URL! { nil }',
    '  var pair: (URL!, [Int!]) = (nil, [])',
    '  nonisolated(unsafe) static var s = 0',
    '  unowned(unsafe) var o: AnyObject?',
    '  @IBOutlet var label: NSTextField!',
    '  @IBOutlet var buttons: [UIButton]!',
    '  var completion: (() -> Void)!',
    '  var map: [String: Int]!',
    '  func items() -> [Item]! { nil }',
    '  let w: (Int, String)! = nil',
    '  func f(x: Any?) -> Int {',
    '    let a = x!',
    '    let b = try! g()',
    '    let c = x as! Int',
    '    let d = x as? Int',
    '    let e = try? g()',
    '    let s = String(decoding: data, as: UTF8.self)',
    '    if a != b { }',
    '    icon(label: NSImage.gear!)',
    '    let k = dict["k"]!.count + (x)! + f()!',
    '    return a',
    '  }',
    '}',
  ].join('\n');
  const marks = lexicalRisk(text, { start: 0, end: text.length }, 'swift').danger.map((r) => text.slice(r.start, r.end));
  assert.deepEqual(marks, ['@unchecked', 'nonisolated(unsafe)', 'unowned(unsafe)', '!', 'try!', 'as!', '!', '!', '!', '!']);
});

// ── band 1 ───────────────────────────────────────────────────────────────────

test('Swift band 1: operators the server types as functions, subscript brackets and attribute names; not `=`, `->`, postfix `!` `?`, generics, literals, inout or directives', () => {
  const text = [
    '@MainActor final class M: ~Copyable {',
    '  @available(*, deprecated) @Published var xs: [String: Int] = [:]',
    '  func f<T: Equatable, U: ~Copyable>(_ a: inout T, _ rest: Int...) -> Set<[Int]>? {',
    '    let ok = !flag && a == b || c != d',
    '    total += xs[k]! ?? -1',
    '    for i in 0..<n where i...  { }',
    '    let v = info?["key"] as? String ?? x?.y![0]',
    '    let w = [1, 2] + ys.map { [weak self] in $0 }[0]',
    '    swap(&a, &b); return [a]',
    '    if xs.isEmpty { return[a] }',
    '  }',
    '}',
    '#if !os(Linux) && DEBUG',
    '#endif',
  ].join('\n');
  const r = swiftRestores(lexFor(text, 'swift'));
  const w = (xs) => xs.map((x) => text.slice(x.start, x.end));
  assert.deepEqual(w(r.operators), ['!', '&&', '==', '||', '!=', '+=', '??', '..<', '...', '??', '+']);
  assert.deepEqual(r.brackets.filter((x) => text[x.start] === '[').map((x) => text.slice(x.start - 4, x.end)), ['= xs[', 'nfo?[', '?.y![', '$0 }['], 'subscripts, not literals, types, capture lists or `return [a]`');
  assert.equal(r.brackets.length, 8, 'and their closers');
  assert.deepEqual(w(r.attributes), ['@MainActor', '@available', '@Published']);
});

test('Swift band 1: a float\'s exponent sign belongs to its literal, the operators around it are restored', () => {
  const text = 'let a = 1.5e-3 + 0x1.8p-3 - b * 2E+2\nlet c = xs[1e-2]\n';
  const r = swiftRestores(lexFor(text, 'swift'));
  assert.deepEqual(r.operators.map((x) => `${x.start}:${text.slice(x.start, x.end)}`), ['15:+', '26:-', '30:*']);
});

test('sourcekit-lsp tokens: a binding the facts find but the server types as a member, a call or a type is dropped at that read', () => {
  const text = 'func f() {\n  let total = 1\n  print(total, total)\n}\n';
  const lx = lexFor(text, 'swift');
  const reads = [...text.matchAll(/total/g)].slice(1).map((m) => m.index);
  const served = [{ name: 'total', offset: reads[0], length: 5, type: 'property', modifiers: [] }, { name: 'total', offset: reads[1], length: 5, type: 'variable', modifiers: [] }];
  const merged = swiftTokens(lx, served).filter((t) => t.name === 'total');
  assert.deepEqual(merged.map((t) => [t.offset, t.type, t.modifiers.join()]), [[text.indexOf('total'), 'variable', 'declaration'], [reads[1], 'variable', '']]);
});

test('Swift band 1: the restores paint with or without sourcekit-lsp, in every phase, at the theme\'s operator, floor and attribute colours', async () => {
  const text = read('constructs.swift');
  const tokens = JSON.parse(read('constructs.swift.sk.json'));
  const h = await focusAt(text, 'swift', 'for _ in 0..<count');
  const s = await focusAt(text, 'swift', 'for _ in 0..<count', { tokens });
  for (const k of ['operators', 'brackets', 'attributes']) assert.deepEqual(s[k], h[k], k);
  assert.ok(h.operators.includes('..<') && h.operators.includes('+=') && h.attributes.includes('@MainActor'), h.operators.join(' '));
  const served = tokens.filter((t) => /^[^\w\s]/.test(text.slice(t.offset, t.offset + t.length)) && !/^[$#@`\\]/.test(text[t.offset]));
  const painted = new Set([...h.operators, ...h.brackets]);
  assert.ok(served.length > 0 && served.every((t) => painted.has(text.slice(t.offset, t.offset + t.length))), 'every operator token the server sends is restored');
  const objc = await focusAt(text, 'objective-c', 'for _ in 0..<count');
  assert.deepEqual([objc.operators, objc.brackets, objc.attributes], [[], [], []], 'Swift\'s alone');
  const { buildDecorationPool, TOKENS } = require('../out/tokens');
  assert.deepEqual([TOKENS.operator, TOKENS.attribute].map((p) => [p.dark, p.light]),
    [['#9fa5ac', '#585e65'], ['#998cb3', '#705e91']], 'the theme\'s keyword.operator and attribute colours');
  for (const dark of [true, false]) {
    const pool = buildDecorationPool(dark);
    for (const [k, p] of [['operatorRestore', TOKENS.operator], ['attributeRestore', TOKENS.attribute]]) {
      assert.deepEqual([pool[k].options.color, pool[k].options.fontWeight], [dark ? p.dark : p.light, 'normal'], k);
    }
    assert.deepEqual([pool.bracketRestore.options.color, pool.bracketRestore.options.fontWeight], [undefined, 'normal'],
      'a subscript bracket keeps the bracket-pair colour, which wins over the server\'s colour, and loses its bold');
  }
});

test('Swift band 1: a named static call sourcekit-lsp types as the standard library\'s operators paints a bold call, only while its answer stands', async () => {
  const text = read('constructs.swift');
  const tokens = JSON.parse(read('constructs.swift.sk.json'));
  const { swiftStaticCalls } = require('../out/swift');
  assert.deepEqual(swiftStaticCalls(text, tokens).map((r) => text.slice(r.start, r.end)), ['jsonObject', 'allocate'], 'the word tokens of `method.static.defaultLibrary`, not its operators');
  const s = await focusAt(text, 'swift', 'for _ in 0..<count', { tokens });
  const h = await focusAt(text, 'swift', 'for _ in 0..<count');
  assert.deepEqual([s.calls, h.calls], [['jsonObject', 'allocate'], []], 'with the answer, and none without: the grammar paints them a bold call');
  const { buildDecorationPool, TOKENS } = require('../out/tokens');
  assert.deepEqual([TOKENS.call.dark, TOKENS.call.light], ['#6eaff7', '#005eac'], 'the theme\'s call blue');
  for (const dark of [true, false]) {
    const pool = buildDecorationPool(dark);
    assert.deepEqual([pool.callRestore.options.color, pool.callRestore.options.fontWeight], [dark ? TOKENS.call.dark : TOKENS.call.light, 'bold']);
  }
});

test('Objective-C band 1: nil, Nil, YES, NO, TRUE and FALSE paint constant red and the ARC and nullability macros keyword grey; C keeps NULL, true, false and bool', async () => {
  const text = '- (BOOL)f:(id)x {\n  __weak id w = x; __block BOOL b = NO; Class k = Nil; id __nullable n = nil;\n  NSArray *a = @[@YES, @(TRUE), @(FALSE), @(true)];\n  return w != nil ? YES : b;\n}\n';
  const macros = [];
  for (const m of text.matchAll(/\b(?:nil|Nil|YES|NO|TRUE|FALSE|true|__weak|__block|__nullable)\b/g)) macros.push({ offset: m.index, length: m[0].length, type: 'macro', modifiers: [] });
  for (const lang of ['objective-c', 'objective-cpp']) {
    for (const tokens of [undefined, macros]) {
      const r = await focusAt(text, lang, 'return w', { tokens });
      assert.deepEqual(r.constants, ['NO', 'Nil', 'nil', 'YES', 'TRUE', 'FALSE', 'true', 'nil', 'YES'], `${lang} ${tokens ? 'clangd' : 'no server'}`);
      assert.deepEqual(r.self.filter((x) => x.startsWith('__')), ['__weak', '__block', '__nullable'], lang);
    }
  }
  const c = await focusAt('int f(void) {\n  int nil = 0, YES = 1;\n  return nil + YES;\n}\n', 'c', 'return nil');
  assert.deepEqual(c.constants, [], 'in C they are names');
});

test('Swift facts and band-1 restores are linear in the file', () => {
  const { growth } = require('./cpu-time');
  const unit = (i) => `@MainActor struct S${i}: Sendable {\n  var total${i} = 0\n  func add${i}(_ x: Int, by step: Int = 1) -> Int {\n`
    + `    guard let v = map[x] else { return -1 }\n    let ys = xs.map { $0 + v } ?? []\n    for (k, w) in pairs where k == x { total${i} += w * step }\n`
    + `    return ys.isEmpty ? v : ys[0] ..< v\n  }\n}\n`;
  const { lex } = require('../out/lex');
  const setup = (n) => lex(Array.from({ length: n }, (_, i) => unit(i)).join(''), 'swift');
  for (const [name, run] of [['facts', swiftFacts], ['restores', swiftRestores]]) {
    const ratio = growth(setup, run, 300);
    assert.ok(ratio < 24, `${name}: 8x the lines cost ${ratio.toFixed(1)}x`);
  }
  // One statement holding a closure per row: each `{` reads the same `let … = [` header.
  const table = (n) => lex(`let routes: [Route] = [\n${Array.from({ length: n }, (_, i) => `    Route("r${i}") { req in req.ok(${i}) },`).join('\n')}\n]\n`, 'swift');
  const ratio = growth(table, swiftFacts, 250);
  assert.ok(ratio < 24, `a table of closures: 8x the rows cost ${ratio.toFixed(1)}x`);
});

// ── Objective-C ──────────────────────────────────────────────────────────────

test('Objective-C methods are function scopes; selector parts and unary selectors are not data', async () => {
  const text = read('Widget.m');
  const r = await focusAt(text, 'objective-c', '_count = count;');
  assert.ok(r.tints.includes('count') && r.tints.includes('name'), r.tints.join(' '));
  assert.ok(!r.tints.includes('initWithName'), 'a selector part');
  const copy = await focusAt(text, 'objective-c', '_name = [name copy];');
  assert.equal(copy.tints.filter((w) => w === 'copy').length, 0, '`[name copy]` sends a unary selector');
  const other = await focusAt(text, 'objective-c', 'if (index > self.items.count)');
  assert.ok(!other.tints.includes('name'), 'another method\'s parameter does not tint here');
});

test('Objective-C danger: bridge casts and performSelector:, not a method signature\'s types', () => {
  const text = read('Widget.m');
  const marks = lexicalRisk(text, { start: 0, end: text.length }, 'objective-c').danger.map((r) => text.slice(r.start, r.end));
  assert.ok(marks.includes('(__bridge CFStringRef)') && marks.includes('(__bridge_transfer NSString *)') && marks.includes('performSelector:'), marks.join(' | '));
  assert.ok(!marks.includes('(NSString *)') || text.includes('(NSString *)unknown'), 'no signature type marks');
  assert.ok(!marks.includes('(NSZone *)') && !marks.includes('(Widget *)'), marks.join(' | '));
  const more = [
    '- (void)performSelector:(SEL)s;',
    '- (void)run {',
    '    if ([o respondsToSelector:@selector(performSelector:)]) {}',
    '    [self performSelector:@selector(go)];',
    '    NSString *t = (NSString *)obj;',
    '}',
  ].join('\n');
  const m2 = lexicalRisk(more, { start: 0, end: more.length }, 'objective-c').danger.map((r) => `${more.slice(r.start, r.end)}@${more.slice(0, r.start).split('\n').length}`);
  assert.deepEqual(m2, ['performSelector:@4', '(NSString *)@5'], 'a declared `performSelector:` and a selector literal send nothing; the first line of a body is no signature');
});

test('An Objective-C header opens as cpp and takes the Objective-C facts inside its interfaces: selector parts are not data, a signature\'s types are no casts', async () => {
  const text = [
    '@interface Cache : NSObject',
    '- (void)storeObject:(id)object forKey:(NSString *)key cost:(NSUInteger)cost;',
    '- (instancetype)initWithName:(NSString *)name NS_DESIGNATED_INITIALIZER;',
    '@property (nonatomic) NSUInteger limit;',
    '@end',
    'static inline NSString *Describe(id x) { return (NSString *)x; }',
    'static inline long Gap(char *a, void *b) {',
    '  return a',
    '    - (char *)b;',
    '}',
  ].join('\n');
  const h = await focusAt(text, 'cpp', 'storeObject');
  const m = await focusAt(text, 'objective-c', 'storeObject');
  assert.deepEqual(h.tints, m.tints, 'Focus tints the header as the same text in a .m file');
  assert.ok(!h.tints.some((w) => w === 'forKey' || w === 'NS_DESIGNATED_INITIALIZER' || w === 'initWithName'), h.tints.join(' '));
  assert.ok(h.danger.length === 0, `no danger on a signature line: ${h.danger.join(' ')}`);
  const all = lexicalRisk(text, { start: 0, end: text.length }, 'cpp').danger.map((r) => text.slice(r.start, r.end));
  assert.deepEqual(all, ['(NSString *)', '(char *)'], 'the inline functions\' casts, a `- (char *)b` continuation outside the interface too, not a signature\'s types');
  const plain = 'long f(char *a, void *b) {\n  long x = a\n    - (char *)b;\n  return x;\n}\n';
  const p = lexicalRisk(plain, { start: 0, end: plain.length }, 'cpp').danger.map((r) => plain.slice(r.start, r.end));
  assert.deepEqual(p, ['(char *)'], 'C++ with no interface: a `- (char *)b` continuation line is a cast');
});

test('A header whose `@end` is half-typed away still classifies: a bare `@` before the next declaration is no word', async () => {
  const { isTypeHeader } = require('../out/cjvm');
  assert.equal(isTypeHeader('@\n_nd\n\nstatic inline int f(int a) ', 'c'), false);
  const text = '@interface Cache : NSObject\n- (void)cache:(id)cache didEvict:(NSUInteger)count;\n@\nnd\nstatic inline int f(int a) {\n  int b = a;\n  return b;\n}\n';
  const h = await focusAt(text, 'cpp', 'b = a');
  assert.ok(h.tints.includes('b'), `the function's local tints: ${h.tints.join(' ')}`);
});

test('sourcekit-lsp\'s Objective-C answer: clangd\'s legend over its own indices is read with its own legend', async () => {
  const text = read('Widget.m');
  const raw = JSON.parse(read('Widget.m.sk.json'));
  assert.equal(sourcekitClangLegend(raw.legend, raw.data), true);
  assert.equal(sourcekitClangLegend(raw.legend, [0, 0, 1, 2, 0]), false, 'a clangd answer with plain parameters is clangd\'s');
  assert.equal(SOURCEKIT_LEGEND.tokenTypes[2], 'class');
  // The same answer decoded with sourcekit-lsp's legend and served under a legend that matches it.
  const ls = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') ls.push(i + 1);
  const decoded = [];
  for (let i = 0, line = 0, ch = 0; i < raw.data.length; i += 5) {
    line += raw.data[i];
    ch = raw.data[i] ? raw.data[i + 1] : ch + raw.data[i + 1];
    decoded.push({ offset: ls[line] + ch, length: raw.data[i + 2], type: SOURCEKIT_LEGEND.tokenTypes[raw.data[i + 3]],
      modifiers: SOURCEKIT_LEGEND.tokenModifiers.filter((_, b) => raw.data[i + 4] & (1 << b)) });
  }
  const want = await focusAt(text, 'objective-c', 'NSInteger total = 0;', { tokens: decoded });
  const k = await focusAt(text, 'objective-c', 'NSInteger total = 0;', { raw });
  assert.deepEqual(k.tints.sort(), want.tints.sort());
  assert.ok(!k.tints.includes('NSInteger') && !k.tints.includes('NSString'), k.tints.join(' '));
});

// ── Metal and static content ─────────────────────────────────────────────────

test('Metal lexes as C++ with its address spaces as keywords', async () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures/transitions/walk.metal'), 'utf8');
  const r = await focusAt(text, 'metal', 'float4 sum = 0;');
  assert.ok(r.tints.includes('sum') && r.tints.includes('gid'), r.tints.join(' '));
  for (const w of ['device', 'constant', 'kernel', 'texture2d']) assert.ok(!r.tints.includes(w), w);
});

test('Apple build and data formats have no focusable scope', () => {
  for (const id of ['strings', 'project.pbxproj', 'pbxproj', 'xcconfig', 'plist', 'swift-gyb', 'tutorial']) {
    assert.equal(focus.isNonFlowLanguage(id), true, id);
    assert.equal(focus.scanBlocks('{ isa = PBXBuildFile; let x = 1 }', id).length, 0, id);
  }
  assert.equal(focus.isNonFlowLanguage('swift'), false);
  assert.equal(focus.isNonFlowLanguage('metal'), false);
});
