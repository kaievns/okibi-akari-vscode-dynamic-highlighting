# Testing

`npm test` compiles and runs every listed file; the README's Tests table says
what each covers. This page records how far the suite pins the code, how its
timing checks stay valid under load, and what the perf-golden sessions hash.

## Mutation audit

**Method.** Mutants are edits to the compiled `out/*.js`, found by walking the
TypeScript AST: a swapped comparison or `&&`/`||`, one operand of `&&`/`||`
dropped, a numeric literal off by one, a `!` dropped, a boolean return flipped,
an `if` condition forced false, a `break` or `continue` dropped. Each mutant runs
the fast files in turn until the first named failure, then `lexer-render`,
`escape`, `runtime` and `render` together. A mutant killed only by
`perf-golden` counts as hash-only: the hash says something moved, not what.

**The pass.** An earlier audit sampled 532 of 6309 mutants over `lex`, `risk`,
`imports`, `classify`, `decorator`, `scopecolor` and `colors`: 178 survived and
14 were hash-only. Those 192 were mapped onto the current build by their
surrounding text and run again, once against the tests before this change and
once after. Per mutant results and the reason each survivor is left are in
[mutation-audit.csv](mutation-audit.csv).

Before is the suite at the start of this change, which already held the
transition walks; after is the suite now.

| Module | Mutants | Before: killed / hash-only / survived | After: killed / hash-only / survived / removed |
|---|---|---|---|
| classify | 45 | 0 / 4 / 41 | 15 / 2 / 26 / 2 |
| colors | 16 | 0 / 0 / 16 | 0 / 0 / 1 / 15 |
| decorator | 28 | 6 / 1 / 21 | 21 / 0 / 7 / 0 |
| imports | 30 | 1 / 0 / 29 | 17 / 0 / 12 / 1 |
| lex | 36 | 0 / 0 / 36 | 23 / 0 / 13 / 0 |
| risk | 21 | 0 / 0 / 21 | 14 / 0 / 7 / 0 |
| scopecolor | 16 | 0 / 7 / 9 | 11 / 0 / 5 / 0 |
| **total** | **192** | **7 / 12 / 173** | **101 / 2 / 71 / 18** |

"Removed" mutants sit in code this change deleted: `assignColors`, both colour
ledgers, `planEntryClass` and `tokens.ts` `fillColor` had no caller in `src/`, and
one rewritten condition in `imports.ts` (below). Two more went with the
pairwise range compare in `computeShadowScopes`, which a later speed-up replaced
with a set of the scope objects; the test that killed them still passes.

**Survivors.** Every one left has a reason in the CSV:

```
Left after (71 survived, 2 hash-only)
equivalent: no input changes the output   ███████████████████████████████████████████ 43
edge input only (end of file, invalid     ███████████████ 15
  code, no space, a 192-char name)
cache or fast path: same output           █████ 5
debug channel output                      █████ 5
unreachable from the lexer                ████ 4
dead output (no reader in src)            █ 1
```

The dead output is `fnLocalsInOrder`, `fnGlobals` and `fileGlobalsInOrder` on a
classification: only `assignColors` read them, so nothing in `src/` does now;
`perf-golden` still hashes them.

**Bugs the new tests exposed**, fixed in the same change:

- A Python statement `x <= y` or `x >= y` bound `x` as an augmented assignment,
  so the shadow restore painted later builtin uses of `x` as data.
- `def f(x=1)` read as a call with a keyword label (`isArgLabel`). Without a
  server the parameter had no declaration and never painted; the shadow restore
  skipped its header token. Against the pyright-scoping oracle of
  [shadow-restore.md](shadow-restore.md#measurements) that was all 193 missed
  tokens; none is missed now and none is wrong.
- `int a[3], b = 1;` declared `a` but not `b` without a server: an array
  declarator did not start the declarator-list walk.

### Lua

The Lua code (`src/lua.ts`, `scanLuaBlocks` and `untilEnd` in `src/focus.ts`,
the Lua lexer methods, `luaInitializerTest`) was sampled the same way, on the
compiled `out/*.js` with the same operators: 150 of its 718 mutants, each run
against `lua.test.js`, then `lexer.test.js` with `lexer-render.test.js`, then
the Lua walks, then the Lua perf-golden inputs. With the first version of
`test/lua.test.js`, 74 were killed, 5 hash-only and 71 survived. The tests
added for the survivors kill 118; per mutant, with the line of the compiled
file, in [mutation-audit-lua.csv](mutation-audit-lua.csv). None of them was a
bug.

```
Left after (32 survived)
equivalent: no input changes the output   ████████████████ 16
equivalent for valid Lua                  █████████ 9
fast path: same output                    ███ 3
chunk-level list targets (a known limit)  ███ 3
edge input only (end of file)             █ 1
```

### Ruby

The Ruby code (`src/ruby.ts`, `scanRubyBlocks` and its helpers in
`src/focus.ts`, the Ruby lexer methods, `rubyPlaceholderSpans`) was sampled
the same way: 150 of its 2,416 mutants, each run against `ruby.test.js`, then
`lexer.test.js` with `lexer-render.test.js`, then the Ruby walks, then the Ruby
perf-golden inputs. With the first version of `test/ruby.test.js`, 51 were
killed, 25 hash-only and 74 survived. The tests added for the survivors kill
120; per mutant, with the line of the compiled file, in
[mutation-audit-ruby.csv](mutation-audit-ruby.csv). The sample ran on the build
before the scanner's unused parameters went and before the label fix below;
neither moves a sampled mutant's meaning. The lexer's local-variable table and the
hash after a ternary `?` or `!` came later and were not sampled; the tests that
hold them fail on the build without them.

```
Left after (30 survived)
equivalent: no input changes the output   ███████████████████ 19
edge input only                           ██████ 6
equivalent for valid Ruby                 ███ 3
fast path: same output                    ██ 2
```

**The bug a new test exposed**, fixed in the same change: a quoted label in a
paren-less call (`foo "k": 1`) kept its colon out of the string, where Prism
ends the label there. A ternary branch (`c ? "a": "b"`) stays a string and a
colon, as Prism reads it.

### JavaScript

The JavaScript and TypeScript code (`jsNamespaceResolve` and its helpers in
`src/imports.ts`; `jsNonData`, `isBraceKey`, `jsNonDataInit`, `isSelfName` and
the destructured-parameter and module-initializer lines of the heuristic in
`src/classify.ts`; `typedNamespaceKey` and its answer handling in
`src/classify-lsp.ts`; `isParamPattern`, `innermostBlock`,
`blockContainsCaret`, `effectiveLanguageId`, `band1LanguageId` and
`isNonFlowLanguage` in `src/focus.ts`; the ES5 constructor and `this`-only
lines in `src/risk.ts`; `jsPlaceholderSpans`; `commentBracketSpans`;
`focusedBlock`, `restoresImports`, `importRangesFor` and the new lines of
`renderImports`, `renderSelf` and `runClassify` in `src/decorator.ts`) was
sampled the same way: 150 of its 761 mutants, each run against
`javascript.test.js`, then `runtime.test.js` without its walks, then
`golden`, `escape`, `imports`, `render`, `lexer-render`, `edge`, `pure` and
`lexer`, then the JavaScript walks, then the TS and JS perf-golden inputs. With
the first version of `test/javascript.test.js`, 75 were killed, 2 hash-only and
73 survived. The tests added for the survivors kill 102; per mutant, with the
line of the first build's compiled file, in
[mutation-audit-javascript.csv](mutation-audit-javascript.csv). The run after
them, on the final build, added a stage with the rest of the suite, the other
walks excepted. 9 mutants sit in code the fixes below rewrote, and one, the
`ruby` operand of `restoresImports`, is killed only by the Ruby walks.

```
Left after (39 survived)
equivalent: no input changes the output   █████████████████████████████ 29
equivalent for valid JavaScript           █████ 5
edge input only                           █████ 5
```

**Bugs the new tests exposed**, fixed in the same change:

- `import d, * as NS from "…"` bound nothing, and a use whose `.` or member
  sat on the next line (`NS\n  .read()`) dropped the name.
- A TypeScript class field `key!: T` was a heuristic candidate.
- `const v = async` followed by a line break read as an async arrow, so `v`
  was no data.

### Zig

The Zig code (`src/zig.ts`, `zigPlaceholderSpans`, the lexer's `zigAt`, and the
lines naming Zig in `src/lex.ts`, `src/focus.ts`, `src/classify.ts`,
`src/classify-lsp.ts`, `src/risk.ts` and `src/decorator.ts`) was sampled the same
way: 150 of its 760 mutants, each run against `zig.test.js`, then `lexer.test.js`
with `lexer-render.test.js`, then the Zig walks, then the rest of the fast suite,
then the Zig perf-golden inputs. Three workers ran side by side; three mutants
of `src/zig.ts` that JavaScript tests killed under that load passed every stage
run alone, and count as survivors. With the first version of `test/zig.test.js`,
81 were killed, 6 hash-only and 63 survived. The survivors were mapped onto the
final build by file, function, operator and line text and run again with the
final tests: the tests added for them kill 28, and 4 sit in code the fixes below
rewrote. Per mutant, with the line of the first build's compiled file, in
[mutation-audit-zig.csv](mutation-audit-zig.csv).

```
Left after (37 survived)
equivalent: no input changes the output   ██████████████ 14
equivalent for valid Zig                  █████████████ 13
edge input only                           ███████ 7
fast path: same output                    ███ 3
```

**The bug a new test exposed**, fixed in the same change: an enum member named
`self` (`enum { self, other }`) took the `self` paint over zls's member steel.
Two checks the audit showed could never fail went too: a `::` after a name,
which Zig has no token for, and a `const` / `var` before a container field,
where the word before a field is none or `comptime`.

## Timing

A test that checks an algorithm stays linear compares the CPU time of an input
8 times larger with the smaller one (`test/cpu-time.js`): this thread's CPU,
best of 3, the ratio below 24. Linear work gives about 8, a scan per use about
64. CPU time does not include time spent waiting for a core, so other processes
do not inflate it the way they inflate wall-clock time.

The wall-clock bounds these replace (500 ms and 1000 ms in `imports.test.js`, a
wall-clock ratio in `shadows.test.js`) failed 3 of 6 runs at load average 150
with no code change, in the earlier audit. During this pass, at load average 41
on 12 cores, neither version failed in 3 runs; the load-150 case was not run
again.

Runtime and render tests that wait for debounces, relax timers or cold-server
retries run on `node:test`'s fake clock (`setTimeout` and `Date`), stepping
10 ms with a `setImmediate` between steps so promises settle.

## perf-golden sessions

`test/perf-golden.test.js` hashes six sections per generated input:
`structure`, `semantic`, `heuristic`, `render` (an open, navigate and type
session with a server), and `edits` / `editsNoServer`. The two edit sessions
snapshot the first paint before any classify answers, a new line, an unclosed
`g(` and 40 keys at mixed gaps inside it, the bracket closed, and the relax to
Focus, with and without a server.

A session's caret goes 4 characters into the first body line that the block
itself holds, not a nested block. A Lua body opens at the line break after `)`,
and its first line is often a loop header; before this rule the Lua carets
landed one line further down, in a 2-line `if` branch holding one name, and
`lua-2000` / `lua-10000` hashed `edits` and `editsNoServer` alike. Now they
focus the whole function, where the server's tokens mark `M.last = …` and the
heuristic does not. The TS, Go, Rust and Python carets did not move, and their
hashes stayed byte-identical. `structure` hashes the Rust, Python, Lua, Ruby
and Zig placeholder scans.

The TS, Go, Rust and Python inputs bind no builtin names, so the shadow restore
painted nothing they hash. The Python edit sessions append a few such bindings
(`EDIT_TAIL`): with the shadow restore switched off, `py-2000` and `py-10000`
`edits` fail; without the tail they passed. The Lua inputs keep the standard
globals' names in every copy and bind `type` and two modules in each, so every
Lua session hashes both Lua restores: 28 module uses and 28 shadowed names at
2k lines, 136 of each at 10k.

The Ruby inputs repeat `samples/sample.rb` without its `__END__` section, which
would make every later copy data. ruby-lsp marks no declaration, so each copy
renames the names the capture types `variable` or `parameter` (4 characters or
more, not a Kernel name, and not two that would rename alike, such as `fmt2`
and `fmt3`), and the method symbols come from the capture's document symbols.
Every Ruby session hashes the `#{` / `}`, `self` and shadow restores: 266, 28
and 42 ranges at 2k lines, 1,292, 136 and 204 at 10k.

The Zig inputs repeat `samples/sample.zig` with its zls `partial` capture, and
the function and test symbols come from the capture's document symbols. Their
`structure` also hashes `zigFacts`, the namespace spans and the placeholder
scan. Every Zig session hashes the `self` paint, 88 ranges at 2k lines and 407
at 10k, and `editsNoServer` the namespace restore, 160 and 740 spans. The
capture holds no `string` token, so the sessions paint no placeholder; the scan
finds 152 and 703.

`PERF_GOLDEN_DUMP=<dir>` writes each section's lines. Run it once on each build
into the same directory: the second run prints the labels whose lines moved,
which is what to read before re-recording with `PERF_GOLDEN_RECORD=1`.

Transition walks are described in [runtime.md](runtime.md#transitions).
