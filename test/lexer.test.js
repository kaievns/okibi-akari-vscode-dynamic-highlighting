'use strict';
// The shared lexer (src/lex.ts): per-language code / comment / doc / string
// tables, region queries, line counting, the per-version memo, and the
// code-vs-comment cases every scanner that reads it depends on. Rules:
// docs/lexer.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { lex, lexFor, syntaxFor } = require('../out/lex');
const focus = require('../out/focus');
const classify = require('../out/classify');
const risk = require('../out/risk');
const { rustPlaceholderSpans } = require('../out/placeholders');

const spansOf = (src, lang) => lex(src, lang).spans.map((s) => [s.region, src.slice(s.start, s.end)]);
const identsOf = (src, lang) => lex(src, lang).idents.map((i) => i.name);
const numbersOf = (src, lang) => lex(src, lang).numbers.map((r) => src.slice(r.start, r.end));

/**
 * [languageId, source, expected spans as [region, text], expected identifiers,
 *  expected numbers (optional)]
 */
const TABLE = [
  // ── python ──
  ['python', 'x = 1  # 3 as any await', [['comment', '# 3 as any await']], ['x'], ['1']],
  ['python', 'def f(self):\n    """doc self 10\n    more"""\n    return 1',
    [['doc', '"""doc self 10\n    more"""']], ['def', 'f', 'self', 'return'], ['1']],
  ['python', "'''module\ndoc'''\nx = '''v'''", [['doc', "'''module\ndoc'''"], ['string', "'''v'''"]], ['x']],
  ['python', 'x = """v"""', [['string', '"""v"""']], ['x']],
  ['python', 'def f(): """one-line doc"""', [['doc', '"""one-line doc"""']], ['def', 'f']],
  ['python', "'count total'; total = count", [['string', "'count total'"]], ['total', 'count']],
  ['python', 'f"{a} {{b}} {c!r:>{w}}"',
    [['string', 'f"{'], ['string', '} {{b}} {'], ['string', '!r:>{'], ['string', '}}"']], ['a', 'c', 'w']],
  ['python', "rf'{x}' + Rb'raw' + u'u'", [['string', "rf'{"], ['string', "}'"], ['string', "Rb'raw'"], ['string', "u'u'"]], ['x']],
  ['python', 'f"{a != b} {d[\'k\']} {x=}"',
    [['string', 'f"{'], ['string', '} {'], ['string', "'k'"], ['string', '} {'], ['string', '}"']], ['a', 'b', 'd', 'x']],
  ['python', 'f"\\N{EM DASH} {x}"', [['string', 'f"\\N{EM DASH} {'], ['string', '}"']], ['x']],
  ['python', 'x = "abc\\\ndef"; y = 1', [['string', '"abc\\\ndef"']], ['x', 'y'], ['1']],
  // an unterminated f-string hole ends at the line, so the next line is code again
  ['python', 's = f"{x\nnext_line = 2', [['string', 'f"{']], ['s', 'x', 'next_line'], ['2']],
  ['python', 'x = 1 # c\r\ny = "a\r\nz = 2', [['comment', '# c'], ['string', '"a']], ['x', 'y', 'z'], ['1', '2']],
  ['python', 'a // b  # floor division, then a comment', [['comment', '# floor division, then a comment']], ['a', 'b']],
  ['python', 'def f(naïve, π):\n    return naïve * π', [], ['def', 'f', 'naïve', 'π', 'return', 'naïve', 'π']],
  ['python', 'f"\\t{x}"', [['string', 'f"\\t{'], ['string', '}"']], ['x']],
  ['python', 'x = "abc\\\r\ndef"; y = 1', [['string', '"abc\\\r\ndef"']], ['x', 'y'], ['1']],
  ['python', 'f"""{\n x\n}"""', [['string', 'f"""{'], ['string', '}"""']], ['x']],
  ['python', 'f"""{x:\n>{w}}"""; y', [['string', 'f"""{'], ['string', ':\n>{'], ['string', '}}"""']], ['x', 'w', 'y']],
  ['python', 'x = """abc', [['string', '"""abc']], ['x']],

  // ── rust ──
  ['rust', '/* a /* b */ c 42 as any */ x', [['comment', '/* a /* b */ c 42 as any */']], ['x'], []],
  ['rust', 'r#"one "quote"\n two"#; br##"a"#b"##; "multi\nline"; c"cstr"; x',
    [['string', 'r#"one "quote"\n two"#'], ['string', 'br##"a"#b"##'], ['string', '"multi\nline"'], ['string', 'c"cstr"']], ['x']],
  ['rust', "fn f<'a>(x: &'a str) -> &'static str { // it's 3x as any",
    [['comment', "// it's 3x as any"]], ['fn', 'f', 'x', 'str', 'str'], []],
  ['rust', "let c = 'x'; let q = '\\''; let e = '\\u{1F600}'; let h = '\\x41'; let b = b'x'; let u = '😀';",
    [['string', "'x'"], ['string', "'\\''"], ['string', "'\\u{1F600}'"], ['string', "'\\x41'"], ['string', "b'x'"], ['string', "'😀'"]],
    ['let', 'c', 'let', 'q', 'let', 'e', 'let', 'h', 'let', 'b', 'let', 'u']],
  ["rust", "'outer: loop { break 'outer; }", [], ['loop', 'break']],
  ['rust', 'r#type; #[derive(Debug)]\n/// doc\n//! inner\nx',
    [['comment', '/// doc'], ['comment', '//! inner']], ['r#type', 'derive', 'Debug', 'x']],
  ['rust', 'let n = 1_000u32 + 0x1Fu8 + 1.5e3f64 + t.0;', [], ['let', 'n', 't'], ['1_000u32', '0x1Fu8', '1.5e3f64']],

  // ── typescript / javascript ──
  ['typescript', 'this.#count++; total = x', [], ['this', '#count', 'total', 'x']],
  ['typescript', "/[/*]/g; a = b / c / d; /'/; /\\/\\//; z = 'a{'",
    [['string', '/[/*]/g'], ['string', "/'/"], ['string', '/\\/\\//'], ['string', "'a{'"]], ['a', 'b', 'c', 'd', 'z']],
  ['typescript', "if (x) return /re{/.test(s); y = a ? /b/ : c",
    [['string', '/re{/'], ['string', '/b/']], ['if', 'x', 'return', 'test', 's', 'y', 'a', 'c']],
  ['typescript', "`a ${ b ? `x ${c}` : 'y' } // not a comment`; z",
    [['string', '`a ${'], ['string', '`x ${'], ['string', '}`'], ['string', "'y'"], ['string', '} // not a comment`']], ['b', 'c', 'z']],
  ['typescript', 'x = obj.return / 2; y = a.in / b / c', [], ['x', 'obj', 'return', 'y', 'a', 'in', 'b', 'c'], ['2']],
  ['typescript', 'const s = "a // b"; // real\nnext', [['string', '"a // b"'], ['comment', '// real']], ['const', 's', 'next']],
  ['javascript', '#!/usr/bin/env node\nlet x = 1', [['comment', '#!/usr/bin/env node']], ['let', 'x'], ['1']],
  ['typescriptreact', "const p = <p className=\"a\">Don't count 3 {n}</p>; m = 2",
    [['string', '"a"'], ['string', "Don't count 3 "]], ['const', 'p', 'n', 'm'], ['2']],
  ['typescriptreact', 'const f = <T,>(x: T) => x < y', [], ['const', 'f', 'T', 'x', 'T', 'x', 'y']],
  ['typescript', 'const v = <T>x; a < b', [], ['const', 'v', 'T', 'x', 'a', 'b']],
  ['typescript', 'x = "abc\\\r\ndef"; y = 1', [['string', '"abc\\\r\ndef"']], ['x', 'y'], ['1']],
  ['typescript', 'const p = `C:\\\\`; let z', [['string', '`C:\\\\`']], ['const', 'p', 'let', 'z']],
  ['typescript', 'x = /a\nb/', [], ['x', 'a', 'b']],
  ['typescript', 'x = /a/g', [['string', '/a/g']], ['x']],
  ['typescript', 'a = 1n$b', [], ['a', '$b'], ['1n']],
  ['typescript', 'x #', [], ['x']],
  ['typescriptreact', 'const e = <A.B x={y}><C/>{/*c*/}</A.B>;', [['comment', '/*c*/']], ['const', 'e', 'y']],
  ['typescriptreact', 'const e = <svg:rect/>; const f = <my-el/>;', [], ['const', 'e', 'const', 'f']],
  ['typescriptreact', 'x = <svg:g>hi</svg:g>', [['string', 'hi']], ['x']],
  ['typescriptreact', 'x = <A z={w}>hi</A>', [['string', 'hi']], ['x', 'w']],
  ['typescriptreact', 'x = <A>{y', [], ['x', 'A', 'y']],

  // ── go ──
  ['go', '`raw // not comment\n\\n line2`; r := \'"\'; s := "a\\"b"; x',
    [['string', '`raw // not comment\n\\n line2`'], ['string', "'\"'"], ['string', '"a\\"b"']], ['r', 's', 'x']],

  // ── c / c++ ──
  ['cpp', '#include <x.h> // c\n#define N 10\n#if 0\n count = 99; it\'s dead\n#endif\nint y;',
    [['string', '<x.h>'], ['comment', '// c'], ['comment', " count = 99; it's dead\n"]], ['N', 'int', 'y'], ['10', '0']],
  ['cpp', '#if 0\n#if 1\nx\n#endif\n#else\nlive\n#endif', [['comment', '#if 1\nx\n#endif\n']], ['live'], ['0']],
  ['cpp', 'auto s = R"x(a )" b\n)x"; auto n = 1\'000\'000; char c = \'q\'; auto u = u8"u";',
    [['string', 'R"x(a )" b\n)x"'], ['string', "'q'"], ['string', 'u8"u"']], ['auto', 's', 'auto', 'n', 'char', 'c', 'auto', 'u'], ["1'000'000"]],
  ['c', '// a \\\nstill comment\nnext', [['comment', '// a \\\nstill comment']], ['next']],
  ['c', '  #  define X 1\n#\tdefine Y 2\nint z;', [], ['X', 'Y', 'int', 'z'], ['1', '2']],
  ['c', '#if 0\n#ifdef A\nint a;\n#endif\nint b;\n#endif\nint c;', [['comment', '#ifdef A\nint a;\n#endif\nint b;\n']], ['int', 'c'], ['0']],
  ['c', 'int a;\n#if 0\nint b;', [['comment', 'int b;']], ['int', 'a'], ['0']],
  ['c', '#include\t<x.h>\n#if\t0\nint dead;\n#endif\nint live;', [['string', '<x.h>'], ['comment', 'int dead;\n']], ['int', 'live'], ['0']],
  ['cpp', "int n = 1'000;int m = 2;", [], ['int', 'n', 'int', 'm'], ["1'000", '2']],

  // ── java / kotlin ──
  ['java', 'String s = """\n  text "x" \\""" \n  """; int y;', [['string', '"""\n  text "x" \\""" \n  """']], ['String', 's', 'int', 'y']],
  ['kotlin', '/* a /* b */ c 5 as any */ val s = "${a} $b.c $$"; x',
    [['comment', '/* a /* b */ c 5 as any */'], ['string', '"${'], ['string', '} $'], ['string', '.c $$"']], ['val', 's', 'a', 'b', 'x']],
  ['kotlin', 'val r = """\n$c ${d} "q" """"; fun `my test`() {}',
    [['string', '"""\n$'], ['string', ' ${'], ['string', '} "q" """"']], ['val', 'r', 'c', 'd', 'fun', '`my test`']],
  ['kotlin', 'val s = "a\\"$b"; x', [['string', '"a\\"$'], ['string', '"']], ['val', 's', 'b', 'x']],
  ['kotlin', 'val s = "abc', [['string', '"abc']], ['val', 's']],
  ['kotlin', 'val s = """abc', [['string', '"""abc']], ['val', 's']],
  ['kotlin', 'val s = """$', [['string', '"""$']], ['val', 's']],
  ['java', 'String s = """abc', [['string', '"""abc']], ['String', 's']],

  // ── groovy ──
  ['groovy', "def a = '$x' + '''\nb $y'''; z", [['string', "'$x'"], ['string', "'''\nb $y'''"]], ['def', 'a', 'z']],
  ['groovy', 'def s = "n $a.b.c! ${d + 1} $$ $"', [['string', '"n $'], ['string', '! ${'], ['string', '} $$ $"']], ['def', 's', 'a', 'b', 'c', 'd'], ['1']],
  ['groovy', 'def g = """\n${h}\n$i"""', [['string', '"""\n${'], ['string', '}\n$'], ['string', '"""']], ['def', 'g', 'h', 'i']],
  ['groovy', 'def r = /a\\/b $c/; def q = n / 2 / k', [['string', '/a\\/b $'], ['string', '/']], ['def', 'r', 'c', 'def', 'q', 'n', 'k'], ['2']],
  ['groovy', 'def p = $/x $$ $/ /y $e/$; f', [['string', '$/x $$ $/ /y $'], ['string', '/$']], ['def', 'p', 'e', 'f']],
  ['groovy', '#!/usr/bin/env groovy\nreturn /{/', [['comment', '#!/usr/bin/env groovy'], ['string', '/{/']], ['return']],
  ['groovy', 'def s = "abc\nx', [['string', '"abc']], ['def', 's', 'x']],

  // ── default / other families ──
  ['plaintext', "# not a comment; it's 'one' here\nx", [['string', "'s '"], ['string', "' here"]], ['not', 'a', 'comment', 'it', 'one', 'x']],
  ['shellscript', 'echo a#b # real comment\nx=${#arr}', [['comment', '# real comment']], ['echo', 'a', 'b', 'x', '$', 'arr']],
  ['shellscript', 'curl https://example.com # fetch', [['comment', '# fetch']], ['curl', 'https', 'example', 'com']],
  ['ruby', 'x = a // b # c', [['string', '//'], ['comment', '# c']], ['x', 'a', 'b']],
  ['ruby', 'x = a / b # c', [['comment', '# c']], ['x', 'a', 'b']],
];

test('lexer tables: comment / doc / string spans and code identifiers per language', () => {
  for (const [lang, src, wantSpans, wantIdents, wantNumbers] of TABLE) {
    const label = `${lang}: ${JSON.stringify(src)}`;
    if (wantSpans !== null) assert.deepEqual(spansOf(src, lang), wantSpans, `spans for ${label}`);
    if (wantIdents) assert.deepEqual(identsOf(src, lang), wantIdents, `identifiers for ${label}`);
    if (wantNumbers) assert.deepEqual(numbersOf(src, lang), wantNumbers, `numbers for ${label}`);
  }
});

// A tag is markup: its name segments are kept apart from the identifiers, and a rolled-back element keeps none.
test('JSX tag names are tags, not identifiers', () => {
  const { jsxTags } = require('../out/lex');
  const tags = (src) => jsxTags(lex(src, 'typescriptreact')).map((t) => t.name);
  assert.deepEqual(tags('const e = <A.B x={y}><C/>{/*c*/}</A.B>;'), ['A', 'B', 'C', 'A', 'B']);
  assert.deepEqual(tags('const e = <svg:rect/>; const f = <my-el/>;'), ['svg', 'rect', 'my', 'el']);
  assert.deepEqual(tags('x = <A>{y'), [], 'an element never closed rolls back with its tags');
  assert.deepEqual(tags('const f = <T,>(x: T) => x'), [], 'a generic is no tag');
});

test('default syntax: no `#` comments, no lifetime rule, quotes are single-line', () => {
  const src = "# heading\nx = 'it\ny = 2";
  assert.deepEqual(spansOf(src, undefined), [['string', "'it"]]);
  assert.deepEqual(identsOf(src, undefined), ['heading', 'x', 'y']);
  assert.equal(syntaxFor('no-such-language').key, syntaxFor(undefined).key);
});

test('every span is sorted, non-overlapping and inside the text', () => {
  for (const [lang, src] of TABLE) {
    const r = lex(src, lang);
    let prev = 0;
    for (const s of r.spans) {
      assert.ok(s.start >= prev && s.end > s.start && s.end <= src.length, `${lang} span order in ${JSON.stringify(src)}`);
      prev = s.end;
    }
    for (const id of r.idents) assert.ok(r.isCode(id.offset), `${lang} identifier ${id.name} sits in code`);
  }
});

// ── region queries ─────────────────────────────────────────────────────────────

test('region queries: isCode / regionAt / identsIn / numbersIn / holeEndAt / lineOf', () => {
  const src = 'a = 1 # c 2\nb = f"{x} 3"\n"""d"""\n';
  const r = lex(src, 'python');
  assert.equal(r.regionAt(src.indexOf('# c')), 'comment');
  assert.equal(r.regionAt(src.indexOf('3"')), 'string');
  assert.equal(r.regionAt(src.indexOf('"""d')), 'doc');
  assert.equal(r.regionAt(src.indexOf('x}')), 'code', 'an f-string hole is code');
  assert.equal(r.isCode(src.indexOf('b =')), true);
  assert.deepEqual(r.identsIn(src.indexOf('b'), src.length).map((i) => i.name), ['b', 'x']);
  assert.deepEqual(r.numbersIn(0, src.length).map((n) => src.slice(n.start, n.end)), ['1']);
  assert.equal(r.holeEndAt(src.indexOf('x}')), src.indexOf('} 3'));
  assert.equal(r.holeEndAt(0), src.length, 'outside any hole the limit is the text end');
  assert.equal(r.lineOf(src.indexOf('b =')), 1);
  assert.equal(r.lineOf(src.length), 3);
  assert.equal(r.punctFrom(src.indexOf('b')), r.punct.length, 'the hole has no punctuation');
});

test('identsIn equals a filter over the whole-file lex for any region (no rescan from 0)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../samples/sample.rs'), 'utf8');
  const all = lex(src, 'rust').idents;
  const r = lexFor(src, 'rust');
  for (let k = 0; k < 50; k++) {
    const a = Math.floor((k * 7919) % src.length);
    const b = Math.min(src.length, a + ((k * 104729) % 900));
    const want = all.filter((i) => i.offset >= a && i.offset < b).map((i) => `${i.name}@${i.offset}`);
    assert.deepEqual(r.identsIn(a, b).map((i) => `${i.name}@${i.offset}`), want);
    assert.deepEqual(focus.lexIdentifiers(src, a, b, 'rust').map((i) => `${i.name}@${i.offset}`), want);
  }
});

// ── line counting ──────────────────────────────────────────────────────────────

test('line starts count every newline, including escaped ones and CRLF', () => {
  const src = 'a = "x\\\ny"\r\nb = 2\n\nc';
  const r = lex(src, 'python');
  const want = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') want.push(i + 1);
  assert.deepEqual(r.lineStarts, want);
});

test('scanBraceBlocks: block lines do not drift after a backslash-newline in a string', () => {
  const src = 'fn a() {\n    let s = "x\\\n    y";\n}\nfn b() {\n    let t = "p\\\nq";\n}\n';
  const lineOf = (o) => src.slice(0, o).split('\n').length - 1;
  for (const b of focus.scanBlocks(src, 'rust')) {
    assert.equal(b.openLine, lineOf(b.openOffset), 'openLine');
    assert.equal(b.closeLine, lineOf(b.closeOffset), 'closeLine');
  }
  assert.equal(focus.scanBlocks(src, 'rust').length, 2);
});

// ── the memo: one lex per version ─────────────────────────────────────────────

test('lexFor memoises per (text, syntax) and every consumer shares that one result', () => {
  const src = 'fn f(x: u32) {\n    println!("{}", x);\n}\n';
  const a = lexFor(src, 'rust');
  assert.equal(lexFor(src, 'rust'), a, 'same text + language → the same object');
  assert.equal(lexFor(String(src.split('').join('')), 'rust'), a, 'an equal string hits too');
  assert.notEqual(lexFor(src, 'python'), a, 'another language is another lex');
  assert.equal(classify.buildFileIndex(src, [], [], 'rust').lex, a, 'the file index carries the shared lex');
  assert.equal(syntaxFor('javascriptreact').key, syntaxFor('typescriptreact').key, 'JSX dialects share a syntax');
});

// ── scanners that read the shared lexer ──────────────────────────────────────

test('single-quoted strings in TS/Python are strings, not lifetimes', () => {
  assert.deepEqual(identsOf("throw new Error('this should not happen'); this.go();", 'typescript'),
    ['throw', 'new', 'Error', 'this', 'go']);
  assert.deepEqual(identsOf("print('self test', self.x)", 'python'), ['print', 'self', 'x']);
  assert.deepEqual(identsOf("import x from 'react'; const total = count + 1;", 'typescript'),
    ['import', 'x', 'from', 'const', 'total', 'count']);
  const blocks = focus.scanBlocks("function f() { const s = 'a{'; }\nfunction g() { }\n", 'typescript');
  assert.deepEqual(blocks.map((b) => [b.openLine, b.depth]), [[0, 0], [1, 0]]);
});

test('a brace or backtick inside /…/ does not touch blocks or identifiers', () => {
  const src = 'function a() {\n  const re = /[{]/g;\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n';
  assert.deepEqual(focus.scanBlocks(src, 'typescript').map((b) => [b.openLine, b.closeLine, b.depth]),
    [[0, 3, 0], [4, 6, 0]]);
  assert.deepEqual(identsOf('const q = /`/; const after = 1;', 'typescript'), ['const', 'q', 'const', 'after']);
});

test('\\u{…} and \\x.. char literals are chars, not lifetimes', () => {
  const src = "fn f() {\n    let c = '\\u{41}'; if c == x { y(); }\n    let d = '\\x41';\n}\n";
  const blocks = focus.scanBlocks(src, 'rust').sort((a, b) => a.openOffset - b.openOffset);
  assert.deepEqual(blocks.map((b) => src.slice(b.openOffset, b.openOffset + 1) + b.depth), ['{0', '{1'],
    'only the fn body and the if body are blocks — no block from `{41}`');
  assert.ok(identsOf(src, 'rust').includes('y'), 'code after the char literal is still lexed');
  assert.ok(!identsOf(src, 'rust').includes('x41'));
});

test('a dedented closing triple quote does not close the enclosing suite', () => {
  for (const q of ['"""', "'''"]) {
    const src = `def f():\n    s = ${q}x\nfine${q}\n    if s:\n        return 1\n`;
    const blocks = focus.scanIndentBlocks(src).map((b) => [b.openLine, b.closeLine, b.depth]);
    assert.deepEqual(blocks, [[0, 4, 0], [3, 4, 1]], `with ${q}`);
  }
});

test('a backslash-continued Python header is recognised under CRLF', () => {
  const lf = 'def f(a, b):\n    if a and \\\n       b:\n        return 1\n';
  const crlf = lf.replace(/\n/g, '\r\n');
  const shape = (src) => focus.scanIndentBlocks(src).map((b) => [b.openLine, b.closeLine, b.depth]);
  assert.deepEqual(shape(crlf), shape(lf));
  assert.deepEqual(shape(lf), [[0, 3, 0], [1, 3, 1]]);
});

test('non-ASCII names lex whole, including astral code points', () => {
  assert.deepEqual(identsOf('let 𝑥 = naïve + Ωmega_2;', 'rust'), ['let', '𝑥', 'naïve', 'Ωmega_2']);
});

test('macro argument regions: nested comments and char literals do not close them early; macros in comments add nothing', () => {
  const src = 'fn f() {\n    let x = 1;\n    println!("{}", /* a /* b */ ) */ c == \')\', x);\n    // println!("{}", x);\n}\n';
  const decl = src.indexOf('x = 1');
  const tok = { name: 'x', type: 'variable', modifiers: ['declaration'], offset: decl, length: 1 };
  const occ = classify.buildFileIndex(src, [tok], [], 'rust').occurrences.get('x').map((r) => r.start);
  assert.deepEqual(occ, [decl, src.lastIndexOf('x);\n    //')], 'the macro use is found; the commented-out one is not');
});

test('typeDeclRanges: a `type` line inside a template string is not a type declaration', () => {
  const src = 'function f(item) {\n  return `\ntype ${item}\n`;\n}\n';
  const tok = (o, mods) => ({ name: 'item', type: 'parameter', modifiers: mods, offset: o, length: 4 });
  const toks = [tok(src.indexOf('item'), ['declaration']), tok(src.lastIndexOf('item'), [])];
  assert.equal(classify.buildFileIndex(src, toks, [], 'typescript').occurrences.get('item').length, 2,
    'the hole read is counted; the template text is not a type alias swallowing it');
});

test('Python comments and docstrings carry no number, async, danger or escape marks', () => {
  const src = [
    'def retry(job, total):',
    '    """Retries up to 3 times as needed; any error is async-safe.',
    '    total = the running count, await later"""',
    "    # retry 3 times as needed, any error is async-safe; total += 1",
    '    x = 2',
    '    return x',
    '',
  ].join('\n');
  const block = { start: 0, end: src.length };
  const r = risk.lexicalRisk(src, block, 'python');
  assert.deepEqual(r.async, [], 'no async in a comment or docstring');
  assert.deepEqual(r.danger, [], 'no as/any in a comment or docstring');
  assert.deepEqual(r.numberEngaged.map((n) => src.slice(n.start, n.end)), ['2'], 'only the code number is clay');
  const c = { byName: new Map([['total', { cls: 'out' }]]) };
  assert.deepEqual(risk.escapeRisk(src, block, c, 'python'), [], 'no escape mark on a commented or documented write');
});

test('no risk marks inside nested block comments, after Rust lifetimes or inside multi-line strings', () => {
  const cases = [
    ['rust', '/* outer /* inner */ still 42 comment as any; count = 0 */'],
    ['kotlin', '/* outer /* inner */ still 5 as any */'],
    ['rust', "fn longest<'a>(x: &'a str, y: &str) -> &'a str { // it's 3x faster as any\n}"],
    ['rust', 'let s = r#"\n  count = 42 as any\n  total = 1\n"#;'],
    ['rust', 'let s = "line one\n  7 as any\n";'],
    ['kotlin', 'val s = """\n  9 as any\n"""'],
    ['cpp', 'auto s = R"(\n  3 as any\n  count = 1\n)";'],
    ['java', 'String s = """\n  4 as any\n  """;'],
  ];
  const c = { byName: new Map([['count', { cls: 'out' }], ['total', { cls: 'out' }]]) };
  for (const [lang, src] of cases) {
    const block = { start: 0, end: src.length };
    const r = risk.lexicalRisk(src, block, lang);
    const marks = [...r.danger, ...r.async, ...r.numberEngaged].map((x) => src.slice(x.start, x.end));
    assert.deepEqual(marks, [], `${lang}: ${JSON.stringify(src)}`);
    assert.deepEqual(risk.escapeRisk(src, block, c, lang), [], `${lang} escape: ${JSON.stringify(src)}`);
  }
});

test('docstring words are not identifiers, so the heuristic never makes them identities', () => {
  const src = 'def flush(self, count):\n    """Flush count items; self.total is the out total."""\n    self.total += count\n    return count\n';
  const ids = focus.lexIdentifiers(src, 0, src.length, 'python').map((i) => i.name);
  assert.deepEqual(ids, ['def', 'flush', 'self', 'count', 'self', 'total', 'count', 'return', 'count']);
  const block = focus.scanBlocks(src, 'python')[0];
  const region = focus.lexRegionFor(src, block);
  const c = classify.classifyFromHeuristic(src, region, undefined, [], 1, 'k', undefined, region, [], 'python');
  for (const word of ['Flush', 'items', 'is', 'the', 'out']) {
    assert.ok(!c.byName.has(word), `docstring word ${word} must not be a candidate`);
  }
  const docStart = src.indexOf('"""');
  const docEnd = src.indexOf('"""', docStart + 3) + 3;
  for (const [name, ranges] of c.occurrences) {
    for (const r of ranges) assert.ok(r.start < docStart || r.start >= docEnd, `${name} occurrence inside the docstring`);
  }
});

test('`#` is a TS identifier sigil and a Rust raw-string prefix, not a comment', () => {
  assert.deepEqual(identsOf('class A { #n = 0; inc() { this.#n++; total = count; } }', 'typescript'),
    ['class', 'A', '#n', 'inc', 'this', '#n', 'total', 'count']);
  assert.deepEqual(identsOf('let s = r#"\ncount as any\n"#; let t = s;', 'rust'), ['let', 's', 'let', 't', 's']);
});

test('rustPlaceholderSpans: nested comments are not strings; raw format strings are', () => {
  const src = '/* {} /* {} */ {} */ println!("{} {x}", a); let b = b"{}"; print!(r#"{y}"#); let c = \'{\';';
  assert.deepEqual(rustPlaceholderSpans(src).map((s) => src.slice(s.start, s.end)), ['{}', '{x}', '{y}']);
});

test('pyExprEnd: a comma inside a trailing comment does not cut a lambda body', () => {
  const src = 'f = lambda a: a + 1  # a, b\nx = 2\n';
  const lam = focus.scanBlocks(src, 'python').find((b) => src.startsWith('lambda', b.openOffset));
  assert.equal(src.slice(lam.openOffset, lam.closeOffset + 1), 'lambda a: a + 1');
});

test('py-comprehension: a `for` inside an f-string argument is not a comprehension', () => {
  assert.equal(focus.scanBlocks('print(f"attempt {i} for {name}")\n', 'python').length, 0);
});

test('rust closures: a char literal comma does not end the body', () => {
  const src = "fn f() { v.iter().map(|c| c == ',').count(); }\n";
  const closure = focus.scanBlocks(src, 'rust').find((b) => src[b.openOffset] === '|');
  assert.equal(src.slice(closure.openOffset, closure.closeOffset + 1), "|c| c == ','");
});

test('lineOf puts a newline on the line it ends; a leading newline is line 0', () => {
  const r = lex('\nx\ny', 'typescript');
  assert.deepEqual(r.lineStarts, [0, 1, 3]);
  assert.equal(r.lineOf(0), 0);
  assert.equal(r.lineOf(2), 1, 'the `\\n` after x');
  assert.equal(r.lineOf(3), 2);
});

test('lexFor keeps the four most recently used texts', () => {
  const texts = [1, 2, 3, 4].map((k) => `let memo_${k} = ${k};`);
  const first = texts.map((t) => lexFor(t, 'rust'));
  texts.forEach((t, k) => assert.equal(lexFor(t, 'rust'), first[k], `text ${k + 1} is still memoised`));
  lexFor('let memo_5 = 5;', 'rust');
  assert.equal(lexFor(texts[3], 'rust'), first[3], 'the most recent survives a fifth text');
  assert.notEqual(lexFor(texts[0], 'rust'), first[0], 'the least recent is evicted');
});

test('JSX and holes nest at most 64 deep; deeper ones lex as code', () => {
  const nested = (d) => `x = ${'<a>{'.repeat(d)}<b>word</b>${'}</a>'.repeat(d)};`;
  const words = (d) => lex(nested(d), 'typescriptreact').idents.filter((i) => i.name === 'word').length;
  assert.equal(words(64), 0, 'inside 64 `{` levels word is still JSX text');
  assert.equal(words(65), 1, 'a 65th level is past the limit, so word lexes as code');
});

// ── Scans that stand in for whole-text regexes (docs/lexer.md#caching-and-cost) ──

const { bangCalls, errorAttributes, blankGap, commaGap, blankOrHashLine } = require('../out/lex');

const seeded = (seed) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const randomText = (rnd, alphabet, max) => {
  let s = '';
  for (let n = 1 + Math.floor(rnd() * max); n > 0; n--) s += alphabet[Math.floor(rnd() * alphabet.length)];
  return s;
};
const regexMatches = (re, text) => {
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length - 1, m[1] ?? null]);
  return out;
};
const callsAsRegexSees = (text) => {
  const out = [];
  let resume = 0;
  for (const m of bangCalls(text)) {
    if (m.index < resume) continue;
    resume = m.open + 1;
    out.push([m.index, m.open, m.name]);
  }
  return out;
};
const callsAndAttrsAsRegexSees = (text) => {
  const calls = bangCalls(text);
  const attrs = errorAttributes(text);
  const out = [];
  let a = 0;
  let b = 0;
  let resume = 0;
  while (a < calls.length || b < attrs.length) {
    const m = b >= attrs.length || (a < calls.length && calls[a].index < attrs[b].index) ? calls[a++] : attrs[b++];
    if (m.index < resume) continue;
    resume = m.open + 1;
    out.push([m.index, m.open, m.name ?? null]);
  }
  return out;
};
const BANG_ALPHABET = ['a', 'b', 'Z', '_', '1', '9', '!', '!', '!', '(', '[', '{', ' ', '\t', '\n', '　', '﻿',
  '​', ' ', '\v', '.', '#', '#', '[', ']', 'error', 'é', 'x!', '!=', '#![', '#[', ' error ', '0x', 'r#'];

test('bangCalls and errorAttributes find exactly what the regexes they replace find', () => {
  const rnd = seeded(7);
  for (let i = 0; i < 20000; i++) {
    const text = randomText(rnd, BANG_ALPHABET, 24);
    assert.deepEqual(callsAsRegexSees(text), regexMatches(/(?<![.\w])([A-Za-z_]\w*)!\s*([([{])/g, text), JSON.stringify(text));
    assert.deepEqual(callsAndAttrsAsRegexSees(text),
      regexMatches(/(?<![.\w])([A-Za-z_]\w*)!\s*([([{])|#!?\[\s*(error)\s*(\()/g, text), JSON.stringify(text));
  }
});

test('bangCalls: an ASCII name ending at `!`, not after `.`, then an opening bracket', () => {
  const names = (t) => bangCalls(t).map((m) => [m.name, t[m.open]]);
  assert.deepEqual(names('a!(x)'), [['a', '(']]);
  assert.deepEqual(names('a.b!(x)'), [], 'a name after a member dot is not a call');
  assert.deepEqual(names('1abc!(x)'), [], 'a name cannot start with a digit');
  assert.deepEqual(names('é!(x)'), [], '\\w is ASCII');
  assert.deepEqual(names('foo!　[x]'), [['foo', '[']], 'JS \\s spans U+3000');
  assert.deepEqual(names('foo! \n {x}'), [['foo', '{']]);
  assert.deepEqual(names('foo != (x)'), []);
  assert.deepEqual(names('#![error(x)]'), []);
  assert.deepEqual(errorAttributes('#![error(x)] #[ error ("y")] #[errors(z)]').map((m) => m.index), [0, 13]);
});

test('a `.name!(` is not a macro call: no macro-argument occurrences, no placeholders', () => {
  const text = 'let v = 1;\nprintln!("{}", v);\nobj.println!("{}", v);';
  const idx = classify.buildFileIndex(text, [{ name: 'v', offset: 4, length: 1, type: 'variable', modifiers: ['declaration'] }], [], 'rust');
  assert.deepEqual(idx.occurrences.get('v').map((r) => r.start), [4, text.indexOf('v);')], 'only the macro call extends v');
  const holes = rustPlaceholderSpans(text).map((s) => s.start);
  assert.deepEqual(holes, [text.indexOf('{}')], 'only the macro call has a format string');
});

test('blankGap, commaGap and blankOrHashLine answer what the sliced regex tests answer', () => {
  const rnd = seeded(11);
  const alphabet = [' ', ' ', '\t', ',', ',', '\n', '\r', ' ', '　', '﻿', 'a', '#', '\v'];
  for (let i = 0; i < 20000; i++) {
    const t = randomText(rnd, alphabet, 8);
    const a = Math.floor(rnd() * (t.length + 4)) - 2;
    const b = Math.floor(rnd() * (t.length + 4)) - 2;
    const at = JSON.stringify([t, a, b]);
    assert.equal(blankGap(t, a, b), /^[ \t]+$/.test(t.slice(a, b)), at);
    assert.equal(commaGap(t, a, b), /^\s*,\s*$/.test(t.slice(a, b)), at);
    assert.equal(commaGap(t, a, b, true), /^[ \t]*,[ \t]*$/.test(t.slice(a, b)), at);
    assert.equal(blankOrHashLine(t), t.trim() === '' || t.trimStart().startsWith('#'), at);
  }
});

// ── Incremental re-lex (docs/lexer.md#incremental-re-lex) ──

const { relex } = require('../out/lex');
const fsx = require('fs');
const pathx = require('path');

const lexKey = (x) => JSON.stringify([x.spans, x.holes, x.idents, x.numbers, x.punct, x.lineStarts, x.cpOff, x.cpState, x.longReads]);
const edited = (text, at, del, ins) => text.slice(0, at) + ins + text.slice(at + del);
const relexOf = (lang, text, at, del, ins) => relex(lex(text, lang), edited(text, at, del, ins), at, at + del, at + ins.length);

test('relex equals a full lex over chained random edits in every language family', () => {
  const SNIPS = ['a', 'x', '_', '1', '0x', '.5', ' ', '\t', '\n', '\n\n', '(', ')', '[', ']', '{', '}', '"', "'", '`', '"""',
    "'''", '#', '//', '/*', '*/', '\\', '\\\n', 'r#"', '"#', 'f"', "b'", '${', '$x', '=>', '<', '>', ':', ',', ';', '!',
    '/', '*', 'é', '💡', '\r\n', 'lambda ', 'def ', 'fn ', 'let ', 'r"', '.', '|x|', '{{', '}}', "'\\u{", "'\\u{41}'",
    '}\'', '/re/g', '// c\n', '# c\n', '"s"', "'c'", '#if 0\n', '#endif\n', '<b>', '</b>',
    '--', '--[[', '--[==[', ']]', ']==]', '[[', '[=[', ']=]', '\\z', 'end', 'then', 'function '];
  const LANG = { c: 'c', cpp: 'cpp', go: 'go', java: 'java', kt: 'kotlin', groovy: 'groovy', py: 'python', rs: 'rust', ts: 'typescript', md: 'markdown', lua: 'lua', rb: 'ruby', php: 'php' };
  const files = [
    ...fsx.readdirSync(pathx.join(__dirname, '../samples')).map((f) => pathx.join(__dirname, '../samples', f)),
    ...fsx.readdirSync(pathx.join(__dirname, 'fixtures/transitions')).map((f) => pathx.join(__dirname, 'fixtures/transitions', f)),
  ].filter((f) => LANG[pathx.extname(f).slice(1).toLowerCase()]);
  const rnd = seeded(99);
  const ri = (n) => Math.floor(rnd() * n);
  let relexed = 0;
  let edits = 0;
  for (const f of files) {
    const lang = LANG[pathx.extname(f).slice(1).toLowerCase()];
    let text = fsx.readFileSync(f, 'utf8');
    let prev = lex(text, lang);
    for (let e = 0; e < 250; e++) {
      const at = ri(text.length + 1);
      const del = rnd() < 0.5 ? 0 : Math.min(text.length - at, ri(rnd() < 0.1 ? 40 : 4));
      let ins = '';
      for (let q = ri(3); q > 0; q--) ins += SNIPS[ri(SNIPS.length)];
      const next = edited(text, at, del, ins);
      const got = relex(prev, next, at, at + del, at + ins.length);
      const want = lex(next, lang);
      edits++;
      if (got) {
        relexed++;
        assert.equal(lexKey(got), lexKey(want), `${pathx.basename(f)} edit ${e}: ${JSON.stringify({ at, del, ins })}`);
      }
      prev = got ?? want;
      text = next;
    }
  }
  assert.ok(relexed > edits * 0.8, `most edits re-lex incrementally: ${relexed} of ${edits}`);
});

test('relex re-makes a decision that read up to the edit, and leaves JSX to a full lex', () => {
  // `'\u{41` is not a char literal because the first `}` after it is not followed by `'`;
  // that read reaches three lines down, so typing the `'` there makes it one.
  const rs = 'use a;\nuse b;\nuse c;\nfn f() {\n    let c = \'\\u{41\n    let d = 1;\n    if x {\n        y\n    }\n    z\n}\n';
  const at = rs.indexOf('    }') + 5;
  const got = relexOf('rust', rs, at, 0, "'");
  assert.ok(got, 'there is a line start before the char to resume from');
  assert.equal(lexKey(got), lexKey(lex(edited(rs, at, 0, "'"), 'rust')));
  assert.ok(got.spans.some((s) => s.region === 'string' && s.end === at + 1), 'positive control: the edit makes a char span');

  // An unclosed element rolls back after reading to the end of the file, so closing it
  // far below changes the lex of every line in between.
  const tsx = 'const a = 1;\nconst x = <div>\nfoo\nbar\nbaz\nqux\n';
  assert.equal(relexOf('typescriptreact', tsx, tsx.indexOf('baz'), 0, '</div>'), null);
  const closed = lex(edited(tsx, tsx.indexOf('baz'), 0, '</div>'), 'typescriptreact');
  assert.ok(closed.spans.some((s) => s.start < tsx.indexOf('foo')), 'positive control: the lines above become JSX text');
});

test('a memo hit on an equal text held as another string costs a pointer compare from then on', () => {
  const { growth } = require('./cpu-time');
  // A reopened file's text equals the memoised one but is a new string: without
  // adopting it, every later lookup compared all characters, seconds per classify at 50k lines.
  let seq = 0;
  const setupFor = (n) => {
    const text = `let v${seq++} = 1;\n`.repeat(n);
    lexFor(text, 'rust');
    return (' ' + text).slice(1);
  };
  const ratio = growth(setupFor, (again) => {
    for (let i = 0; i < 2000; i++) lexFor(again, 'rust');
  }, 4000);
  assert.ok(ratio < 3, `lookups grow with the text: ${ratio.toFixed(1)}x for 8x the text`);
});
