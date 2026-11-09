'use strict';
// Band-3 lexical marks: per-language danger words and clay number literals.
// Rules: docs/risk-marks.md (danger), docs/lexer.md (numbers).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const risk = require('../out/risk');

const whole = (src) => ({ start: 0, end: src.length });
const danger = (src, lang) => risk.lexicalRisk(src, whole(src), lang).danger.map((r) => `${src.slice(r.start, r.end)}@${r.start}`);
const numbers = (src, lang) => risk.lexicalRisk(src, whole(src), lang).numberEngaged.map((r) => src.slice(r.start, r.end));

// [language, source, expected `word@offset` danger marks]
const DANGER = [
  // Python: `as` binds an alias and `any()` is a builtin — never a cast.
  ['python', 'import numpy as np\nfrom os import path as p\nwith lock as l:\n    ok = any(xs)\nexcept OSError as e:\n    pass', []],
  // TypeScript: casts and the `any` type only.
  ['typescript', "import { readFile as rf } from 'fs';", []],
  ['typescript', "import * as path from 'path';", []],
  ['typescript', "import def, { a as b, c } from './m';", []],
  ['typescript', "import type { A as B } from './t';", []],
  ['typescript', "export * as utils from './utils';", []],
  ['typescript', 'export { x as y };', []],
  ['typescript', "const t = ['a', 'b'] as const;", []],
  ['typescript', 'const s = z.any(); const p = Promise.any(ps);', []],
  ['typescript', 'const o = { any: 1, as: 2 }; const any = 3; any = 4;', []],
  ['typescript', 'const n = (x as unknown) as number;', ['as@13', 'as@25']],
  ['typescript', 'export const x = y as Config;', ['as@19']],
  ['typescript', 'function f(a: any): any { return a as any; }', ['any@14', 'any@20', 'as@35', 'any@38']],
  ['typescript', 'let v: any = 1; const m = new Map<string, any>(); const xs: any[] = [];', ['any@7', 'any@42', 'any@60']],
  ['typescript', 'type T<U = any> = U extends string ? any : never;', ['any@11', 'any@37']],
  ['typescriptreact', 'const el = <div>{x as any}</div>;', ['as@19', 'any@22']],
  ['typescript', 'x as Y;', ['as@2']],
  ['typescript', 'const x = y as\n  Config;', ['as@12']],
  ['typescript', 'let any: number = 1; type any = 1;', []],
  // JavaScript has no casts and no `any` type.
  ['javascript', "import { a as b } from 'm'; const any = 1;", []],
  // Rust: `as` casts only.
  ['rust', 'use std::io::Result as IoResult;', []],
  ['rust', 'pub use crate::a::{b as c, d::{e}, f as g};', []],
  ['rust', 'extern crate serde_json as json;', []],
  ['rust', 'let k = <Vec<u8> as IntoIterator>::into_iter(v);', []],
  ['rust', 'fn f(a: u32) -> u8 { a as u8 }', ['as@23']],
  ['rust', 'fn g() { use std::fmt::Write as _; let z = q as i64 > y; }', ['as@45']],
  ['rust', 'fn g() {use std::fmt::Write as _;}', []],
  ['rust', 'fn g() { let a = 1;use std::fmt::Write as _; }', []],
  // Kotlin, Swift, Dart: casts, not import aliases.
  ['kotlin', 'import foo.Bar as Baz\nval s = x as String\nval t = y as? Int', ['as@32', 'as@52']],
  ['kotlin', 'val r = x.as(y)', []],
  ['swift', 'let a = b as! Int', ['as@10']],
  ['dart', "import 'package:x/x.dart' as x;\nfinal y = z as int;", ['as@44']],
  // Go: `any` is the checked `interface{}` alias, and `[T any]` means unconstrained.
  ['go', 'func f(v any) any { return v }\nfunc g[T any](x T) {}', []],
  // No entry: no danger words at all.
  ['java', 'Object as = any;', []],
  ['cpp', 'auto any = static_cast<int>(as);', []],
  [undefined, 'x as any', []],
];

test('danger words per language', () => {
  for (const [lang, src, want] of DANGER) {
    assert.deepEqual(danger(src, lang), want, `${lang}: ${JSON.stringify(src)}`);
  }
});

test('async words still mark in every language, code only', () => {
  const src = 'async def f():\n    await g()  # await later\n';
  assert.deepEqual(risk.lexicalRisk(src, whole(src), 'python').async.map((r) => src.slice(r.start, r.end)), ['async', 'await']);
});

// [language, source, expected clay literals]
const NUMBERS = [
  ['rust', 'let a = pair.0 + pair.1;', []], // tuple fields are fields (rust-analyzer types them `property`)
  ['rust', 'let a = t.0.1 + foo().2;', []],
  ['rust', 'for i in 1..=5 {} for j in 0..n {} x[1..];', ['1', '5', '0', '1']],
  ['rust', 'let x = 123u32 + 1.0f32 + 0x1Fu8 + 0xFFi64 + 2.0_f32;', ['123u32', '1.0f32', '0x1Fu8', '0xFFi64', '2.0_f32']],
  ['rust', 'let k = 1.max(2) + 0xFF.abs();', ['1', '2', '0xFF']],
  ['rust', 'let x = 1_000_000 + 0b1010 + 0o17 + 1e-3;', ['1_000_000', '0b1010', '0o17', '1e-3']],
  ['rust', 'let v2 = x1 + _3;', []],
  ['python', 'z = 1j + 2.5j + 10L', ['1j', '2.5j', '10L']],
  ['python', 'x = 1if y else 2', ['1', '2']],
  ['python', 'x = 1. + .5 + a[1:.5]', ['1', '.5', '1', '.5']],
  ['typescript', 'const n = 10n + 1_000n; y = .5 + x.y; return .25;', ['10n', '1_000n', '.5', '.25']],
  ['typescript', '{ y = 0xE + 1 }', ['0xE', '1']],
  ['java', 'long x = 10L; float f = 1.5f; double d = 1e10d;', ['10L', '1.5f', '1e10d']],
  ['c', 'double d = 0x1.8p3 + 0x1p-2; unsigned u = 10u + 7ull;', ['0x1.8p3', '0x1p-2', '10u', '7ull']],
  ['cpp', "int x = 1'000'000;", ["1'000'000"]],
  ['go', 'c := 2i + 1.5i + 0x1F', ['2i', '1.5i', '0x1F']],
  ['kotlin', 'for (i in 1..10) {}; val l = 10L; val u = 1u', ['1', '10', '10L', '1u']],
];

test('literals keep their suffix, tuple fields are not numbers, hex floats are whole', () => {
  for (const [lang, src, want] of NUMBERS) {
    assert.deepEqual(numbers(src, lang), want, `${lang}: ${JSON.stringify(src)}`);
  }
});
