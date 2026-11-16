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

### Shell, fish and the tooling ids

The shell and fish lexers, block scans, bindings, danger rule, the notebook
handler and the ids `sql`, `diff`, `git-rebase`, `proto3` and `buf-config`
were audited by hand: 29 source mutants, one per rule, each compiling. Each ran
against `shell.test.js`, `render.test.js`, `lexer.test.js`, `rust.test.js` and
the two shell walks at their default counts; the unmutated tree passes them
all. All 29 are killed. The first run, over 30 mutants, one of them on the
expansion-delimiter restore that the change then dropped, killed 25, and 2 did
not compile. 3 survived: escape marks left on in shell, a block scope for a
shell `local`, and fish's `set -g` in a function. Each is killed by a case added
for it: an answer on the semantic path; a `local` in a brace group read from a
sibling block beside a global of its name; and a `set -g c 5` in a function, of a
name the file writes nowhere else, which the mutant declares as the function's.
Per mutant, with its replacement, in
[mutation-audit-tooling.csv](mutation-audit-tooling.csv).

```
Final (29 mutants), by the tests that kill each
test/shell.test.js             ███████████████████████ 23, 18 of them alone
test/render.test.js            ██████ 6, 1 alone
test/lexer.test.js             █████ 5
test/rust.test.js              █████ 5
the walks (transitions)        █████ 5
```

### PHP, MDX and the static ids

The PHP region reader, the PHP lexer rules, the PHP view's wiring, the MDX code
spans and the ids `postcss`, `razor` and `aspnetcorerazor` were audited by hand:
37 source mutants, one per rule, each compiling. Each ran against `php.test.js`,
`markdown.test.js`, `render.test.js`, `rust.test.js`, `lexer.test.js` and
`transitions.test.js`, every walk at its default count; the unmutated tree
passes all six. All 37 are killed. The first run killed 35, and 2 survived, ESM
read as prose and MDX read as plain markdown: no URL in the tests sat in ESM
outside braces or in a JSX attribute. The two cases added for them, an `import`
from a URL and a JSX attribute URL, kill both. Per mutant, with its replacement,
in [mutation-audit-php-mdx.csv](mutation-audit-php-mdx.csv).

```
Final (37 mutants), by the tests that kill each
test/php.test.js               ██████████████████████████ 26
test/render.test.js            ███████ 7
test/markdown.test.js          █████ 5
test/rust.test.js              ███ 3
the walks (transitions)        █████████ 9, 1 of them alone
```

Cutting walks for an audit has a floor: at 5 walks the Zig reclose test fails on
the unmutated tree ("every decoration type compared at 20 of 85 steps"), so an
audit that cuts it counts every mutant as killed by the walks. Cutting only the
main walks to 10, as the HTML audit below does, leaves the baseline passing.

### HTML

The HTML code (`src/html.ts`, `lexScripts`, `scanScriptBlocks`, the top-level
carve-out and the lines naming `html`, `html-template`, `tailwindcss`, `dtd`,
`rnc` and `handlebars` in `src/focus.ts`, `src/decorator.ts` and
`src/classify-lsp.ts`) was audited by hand rather than sampled: 33 source
mutants, one per rule, each a
change that keeps the build compiling. Each ran against `html.test.js`,
`rust.test.js`, `render.test.js` and `transitions.test.js` with the main walks
cut to 10 and the HTML walks at their default 120. The first run, of the first
32, killed 28;
2 did not compile and were rewritten, and 2 survived: the region end read as
exclusive, and a form feed kept inside a script. The two tests added for them, a
caret right before `</script>` and a form feed in a script, kill both. Mutant 33,
`handlebars` read as code, came with that id and ran on its own, killed by the
static-id fixture test, the config test in `render.test.js` and the HTML walks.
All 33 are killed. Per mutant in [mutation-audit-html.csv](mutation-audit-html.csv).

```
Final (33 mutants), by the killing test the CSV lists
test/html.test.js                    █████████████████████ 21
the HTML walks                       █████████ 9
the static-id fixture test           ███ 3
```

### Components

The component code (`src/sfc.ts`; `codeView`, `viewRegions`, `viewBlocks` and
`flowText`'s component path in `src/html.ts`; the JSX tags and braces,
`braceExpressionEnd` and `lexScripts` in `src/lex.ts`; the template blocks,
`nestingSweep` and the template-block scope in `src/focus.ts`;
`jsxComponentNames`, `patternDeclarations`, the module tier and the shorthand
read in `src/classify.ts` and `src/colors.ts`; `sveltePlaceholderSpans`; the
new lines of `src/decorator.ts`) was sampled the same way: 150 of the 1,227
mutants on the lines this change added to the compiled `out/*.js`, each run
against `components.test.js`, then `lexer`, `javascript`, `html` and
`lexer-render`, then the Vue and HTML walks, then the rest of the fast suite,
then perf-golden. Six workers ran side by side. With the first version of
`test/components.test.js`, 82 were killed and 68 survived. The survivors were
mapped onto the fixed build by line text, and all 70 mutants of the lines the
fix below rewrote were added (`set` `rewritten` in the CSV): with the tests
then, 33 of the 62 mapped and 47 of the 70 were killed. The tests added after
that kill 10 more. 9 mutants sit in lines that went, 2 of them `templateEnd`'s,
which the template scan's own `</template>` replaced. The mutants on lines a later
fix rewrote (`vueTemplate`'s mustache and end-tag lines, the each key's, the Svelte
brace branch) were run again on the new line, and one, the template scan's bound,
is now edge input only. 16 mutants of the lines that fix added, picked by hand and
not in the CSV, were run the same way: 14 are killed, and 2 survive as equivalent, a
`}}` never starting at the template's bound and an each key's scan never reaching a
`(` right after `as`, which a space always follows. 6 mutants of `src/sfc.ts`
that HTML and JavaScript tests killed under the load of six workers and a
real-editor run passed every stage run alone: 5 count as survivors, and one is
killed by a component test. Per mutant, with the line of the compiled file it
first ran on, in [mutation-audit-components.csv](mutation-audit-components.csv).

| Set | Mutants | Before: killed / survived | After: killed / survived / removed |
|---|---|---|---|
| sample | 150 | 82 / 68 | 117 / 24 / 9 |
| rewritten | 70 | 47 / 23 | 54 / 16 / 0 |
| **total** | **220** | **129 / 91** | **171 / 40 / 9** |

```
Left after (40 survived)
equivalent: no input changes the output   ███████████████████████ 23
equivalent for valid code or markup       █████████████ 13
edge input only                           ███ 3
fast path: same output                    █ 1
```

**The bug a new test exposed**, fixed in the same change: a pattern's default
value ended at the first comma, so `h` in `{#each xs as { e = f(g, h) }}`
declared a binding, and a spread declared none: `rest` in `{ ...rest }` read as
a member after its dot. A default or a type annotation now ends at a `,` or a
bracket at its own depth. A per-region tag map no code read went too.

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
