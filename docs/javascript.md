# JavaScript and TypeScript

JavaScript (`javascript`, VS Code's built-in `source.js` grammar) shares the
lexer family, block scanners and classifiers with TypeScript (`typescript`),
and both get the same data identities, escape marks and band-1 restores. The
semantic tokens come from tsserver (built into VS Code) or, with
`deno.enable` on, from the Deno language server through
`denoland.vscode-deno`. `src/lex.ts` holds the `js` family, `src/focus.ts` the
brace and arrow scans, `src/imports.ts` the namespace restore. Tests:
`test/javascript.test.js`, plus JavaScript in the perf-golden inputs and the
transition walks. `javascriptreact` and `typescriptreact` share the family and
every rule here, except the template, JSDoc and namespace restores
([Band-1 restores](#band-1-restores)).

Which files open as what, in VS Code 1.144.1 with denoland.vscode-deno 3.53.1:

| Language id | Names | The layer |
|---|---|---|
| `javascript` | `.js .es6 .mjs .cjs .pac`, `jakefile`, a `#!…node` first line | code |
| `typescript` | `.ts .cts .mts`, a `#!…deno`, `#!…bun` or `#!…ts-node` first line | code; a declaration file is read as `typescript-declaration` ([Declaration files](#declaration-files)) |
| `jsonc` | `jsconfig.json`, `tsconfig.json`, `jsconfig.*.json`, `deno.jsonc` | static content |
| `json` | `deno.json`, `deno.lock` (the Deno extension's) | static content |

A ```` ```js ```` fence in markdown is prose, and a `<script>` block in HTML
is static content: the layer paints neither.

## Measurements

The corpora are public: every `.js`, `.mjs` and `.cjs` under
`/opt/homebrew/lib/node_modules` (npm and other global packages, 1,125
files), the third-party packages in the `node_modules` of local projects (998
files), and 108 TypeScript `lib*.d.ts` files. VS Code's bundled extension
`dist/*.js` files are all minified and were left out. 140 private files were
counted only, and their counts are in this page's prose alone. Numbers per public
corpus and measure are in
[javascript-measurements.csv](javascript-measurements.csv).

**Lexer.** The reference is TypeScript's own parser (VS Code's bundled 6.0.3):
each character as code, comment or string (regex and template text count as
string). Over the 2,370 files that parse (one npm file does not), 14,249,376
non-space characters, the lexer puts 0 in the wrong region; on the private
files too. The synthetic `test/fixtures/javascript/edges.js` holds every edge
named below, and differs in 4 characters, `if (x) /re/`. Of 45 snippets in
`test/javascript.test.js`, one per regex-or-division position, 5 differ: a `/`
after an `if`, `while`, `for` or `with` header and after `of` as a name ([Known
limits](#known-limits)).

**Band 2 and band 3.** The runs drive the real classifier under the stub:
every block of 220 sampled npm files and 200 sampled `node_modules` files, up
to 40 per file, plus the top level, with tsserver's tokens (VS Code's bundled
TypeScript with `@types/node`, as automatic type acquisition provides) and with
none. The reference is the TypeScript checker's symbol for each tinted name.

| What (420 public files) | Before | Now |
|---|---|---|
| tints on non-data names, tsserver tokens | 187 npm, 258 `node_modules` | 38, 138 |
| tints on non-data names, no server | 1,916, 1,221 | 2, 52 |
| tints that change when the server answers | 3,799, 3,689 | 1,255, 2,340 |
| escape marks, tsserver tokens | 1,166, 1,257 | 1,072, 1,185 |

In the 140 private files, tints on non-data names went from 49 to 42 with
tsserver's tokens and from 135 to 21 with none, tints that change when the server
answers from 1,166 to 493, and escape marks from 276 to 275.

The 166 escape marks removed are `module.exports = …` and `exports.x = …`,
writes through `process`, and `this.x =` in ES5 constructor functions; none was
added. The non-data names left with tsserver are ones it types as data:
destructured `require` bindings (`const { EOL } = require('node:os')`), names
in an `export { … }` list or an exported shorthand (`module.exports = {
Arborist }`), and function values with properties assigned
(`cmdShim.ifExists = …`). With no server the 52 in `node_modules` are 31 names
in `export { … }` lists, `exports.X = X` statements and other import forms, 8
bindings of a `require` with a computed path, 8 function values that a later
assignment or a default makes ambiguous, and 5 parameters the checker resolves
to a class.

**Focus.** Over every identifier not after a `.` in the public files
(283,761 npm, 448,522 `node_modules`), 5,831 and 4,506 sat in a destructuring
pattern or a destructured parameter, which focused the pattern's own brace and
painted nothing; now 0 do. In the private files, 559 of 20,232.

## Lexer

| Form | Region |
|---|---|
| `//` to the line end; `/* … */` and `/** … */` | comment |
| `#!` at offset 0 | comment |
| `'…'`, `"…"`, with escapes | string |
| `` `…` ``, with `${…}` holes nested to any depth, tagged (`String.raw`, `` gql`…` ``, `` html`…` ``, `` css`…` ``) or not | string with holes |
| `/…/flags` where an expression starts, `v` flag, named groups and classes (`/[/]/`) included | string |

A `/` starts a regex after an operator, `(`, `[`, `{`, `}`, `,`, `;`, `:`, `!`
or one of `return typeof instanceof in of new delete void throw case default do
else yield await` (not after `.`), and is division after any other identifier, a
literal, `)`, `]`, `++` or `--`. A line break changes nothing, so `a` then
`/2/1` on the next line divides, as JavaScript reads it. Numerals take
separators, BigInt and exponents (`1_000_000n`, `0xff_ff`, `1e-3`, `.5`).
`javascript` also runs the JSX lookahead, which TypeScript files do not; the
cost is in [Cost](#cost).

## Blocks and focus

Every `{…}` is a block, an object literal and a class body included, and a
concise arrow body (`x => x + 1`) is a synthetic one. Two rules are JavaScript
and TypeScript only:

- A caret in a destructuring pattern (`const { a, b } = o`, `for (const { a }
  of xs)`) or a destructured parameter (`function load({ name, size = 1 })`,
  `({ a }) =>`) focuses the scope that owns its names. The pattern's brace is a
  block of its own, and focused it painted nothing.
- A one-line function holds a caret in its parameter list: `(n) => { total
  += n; }` focuses the arrow when the caret is on `n`.

Other languages keep their containment: a Rust `let P { x, y } = p` pattern
and a one-line Ruby, Go or Rust closure's parameters focus as before
(`test/javascript.test.js` holds both).

## Data identities

The shared rules ([classification-rules.md](classification-rules.md)), with
these for the `js` family:

- `self` is an ordinary name: `var self = this` is a local and tints. Only
  `this` is a self name.
- **The module surface is not data**: `module`, `exports`, `require`,
  `process`, `Buffer`, `global`, `__dirname` and `__filename`, unless a token in
  the file declares the name (a UMD wrapper's `function (exports)`, a local
  `const process = …`). tsserver types `module` and `process` plain
  `variable` and `exports` `variable` or `property`, without `defaultLibrary`,
  because `@types/node` is no default library; `window` and `console` carry it
  and were already excluded.
- An `import * as NS` name is not data on either path, so Deno's
  `variable.readonly` on `path.join` tints nothing. A namespace the file also
  uses as a bare word is left to the server (below).

Without a server, these declare a name: a bare arrow parameter (`args =>`), the
names of a destructured parameter (`({ name, size = 1 }, [a, b]) =>`), and the
shared table's forms. These do not:

| Initializer | Why |
|---|---|
| an arrow (`x =>`, `(a) =>`, `async x =>`), `function`, `async function`, `class` | tsserver types the binding `function` or `class`, band 1 |
| `require("…")` or `await import("…")`, with only `.member` accesses after it | a module; tsserver types it `namespace` or leaves it untyped |

A call after `require("…")` (`require('debug')('x')`) is data, and so is
`async` followed by a line break. A key first in a `{…}` item (`{ key: v }`,
`{ key?: T }`, a class field `key!: T`, a label `outer:`) is never a
candidate; its value and a shorthand `{ name }` are.

## Escape marks

The shared rules ([risk-marks.md](risk-marks.md)) with tsserver's or Deno's
tokens; the heuristic path makes no claim. JavaScript specifics:

| Write | Marks when |
|---|---|
| `this.x = …` | outside an initializer: a `constructor(…)`, or an ES5 constructor function, `function Point(…) {` or `Point = function (…) {` with a capitalised name. `Point.prototype.move = function () { this.x += 1 }` marks |
| `self.x = …` | `self` is declared outside the block, as for any name |
| `module.exports = …`, `exports.x = …`, `process.exitCode = …` | never: the root is the module surface, not data |
| `globalThis.x = …`, `window.x = …` | never: tsserver types the root `defaultLibrary` or not at all |

## Band-1 restores

| Restore | Spans | Why |
|---|---|---|
| `this`, keyword grey | every code `this`, `this` parameters of a declaration file included (`f(this: Window)`, which tsserver types `parameter`) | as in every language ([runtime.md](runtime.md#rust-path-keywords)); `self` is not painted |
| template holes, member steel | the `${` and `}` of every closed hole, nested ones included; `javascript` only | JavaScript's language configuration lists `${` `}` as a bracket pair and sets no `colorizedBracketPairs`, so bracket-pair colorization paints both over the theme's rule. TypeScript's sets `colorizedBracketPairs` without it, and the theme reaches them |
| JSDoc brackets, comment colour | every `(` `)` `[` `]` `{` `}` in a `/**` comment: `@param {string} [name]` | both grammars give a JSDoc type and variable the token type `other`, so bracket-pair colorization reaches them; `//` and `/*` comments are left alone |
| `import * as NS` uses, type slate | `NS.x` and `NS?.x`, a line break before the `.` included, after `import * as NS from "…"`, `import type * as NS` and `import d, * as NS` | tsserver and Deno send no token for a project file's namespace (`import * as util from './util.js'`), so `util.read` stays page colour ([import-restore.md](import-restore.md#javascript-and-typescript)) |

The namespace restore leaves out a name the file also writes as a bare word (a
parameter, a local, `f(NS)`, `NS[k]`, `...NS`), and one imported twice, so it
needs no shadow rules. It hands over per name: a name whose uses got a token in
the last answer with tokens is left to the server.

`javascriptreact` and `typescriptreact` get none of the three new restores yet;
their JSX tag positions (`<NS.Tag>`) need checking first. In `javascript`, which
VS Code opens with the JSX-capable `source.js`, the namespace restore skips a tag
name: a use right after `<` or `</` (`<UI.Button>`, `</UI.Button>`), which the
grammar paints as one component token, call blue. A use in the tag's attributes
or children is restored. A comparison written without a space, `a<ns.max`, is
skipped too.

## Server states

| State | What the layer sees |
|---|---|
| tsserver | tokens for every JS and TS file once the project loads. A project file's `import * as` binding and its uses get no token; an ambient module's (`node:path` with `@types/node`) get `namespace` |
| Deno, `deno.enable` on | the Deno extension's own provider, with tsserver's 12-type, 6-modifier legend. It types `Deno` `namespace.defaultLibrary`, its members `variable.readonly.defaultLibrary`, a destructured or imported function `method` where tsserver says `function`, and an ambient namespace's uses `variable.readonly` where tsserver says `namespace` |
| `vscode.typescript-language-features` disabled | no provider: `none`, and the heuristic paints at once |

Deno's `variable.readonly` on `path.join` paints the page colour, where
tsserver's `namespace` paints slate. The restore leaves it: it paints only
where the server sent no token.

## Declaration files

A `.d.ts`, `.d.mts`, `.d.cts` or `.d.<ext>.ts` file opens as `typescript`; the
layer reads it as `typescript-declaration` (`effectiveLanguageId`). It holds
signatures only, so it has no Focus scope and no band 2 or 3. Classified as
code, the blocks of 13 sampled `lib*.d.ts` files tinted 192 signature
parameters and `declare var` globals with tsserver's tokens, and 223 names
without, 126 of them interface members. Band 1 reads it as
TypeScript (`band1LanguageId`): `this` and the JSDoc brackets are restored. The
namespace restore is not, since the layer never asks a declaration file's
server and so cannot know which uses it typed.

## Real editor

The theme repo's `e2e/` harness, on a copy with a `js` cell (a sample file, a
`util.js` beside it, a `jsconfig.json`), drove this tree in VS Code 1.144.1 on
2026-11-09 in three modes: `tsserver`, `deno` (denoland.vscode-deno 3.53.1,
`deno.enable`, brew's deno 2.9.6) and `off`
(`--disable-extension=vscode.typescript-language-features`), and its `ts` cell
with tsserver.

| Cell | Focus, Edit and reopen captures | Survey misses per theme | Transition scenarios |
|---|---|---|---|
| `js`, `tsserver` | 12 of 12 match | 7 of 119 | none in the cell |
| `js`, `deno` | 12 of 12 match | 7 of 119 | none in the cell |
| `js`, `off` | 6 of 6 match | 6 of 119 | none in the cell |
| `ts`, `tsserver` | 2 of 2 match | 0 of 101 | 14 of 14 hold |

The Survey misses are theme rules, none of them this tree's: a constructor
function tsserver types `class`, `1n`, a getter's name, `typeof` and
`instanceof`, `module` and `exports` under the server's tokens, and with no
server a class used as a value. On the cell's first version, before this
support, the `tsserver` and `deno` modes each counted 33 mismatches this tree
caused: per theme in Survey the 3 `self` paints, the 4 template delimiters, the
2 namespace uses and the JSDoc braces; in Focus and Edit `module` and `process`
tinted, escape marks on `module.exports` and in the constructor function, and
the destructured parameters and `self` untinted. A click at the end of a
one-line arrow moves the caret out of it, so Edit items cannot sit in one;
escape items are checked with a server only, since the heuristic never marks.

## Regenerating the token fixtures

```bash
node test/gen-ts-semtok.js --types ~/Library/Caches/typescript/6.0/node_modules/@types test/fixtures/javascript/edges.js > test/fixtures/javascript/edges.js.tokens.json
node test/gen-ts-semtok.js --types ~/Library/Caches/typescript/6.0/node_modules/@types test/fixtures/javascript/ns.js > test/fixtures/javascript/ns.js.tokens.json
node test/gen-deno-semtok.js test/fixtures/javascript/edges.js > test/fixtures/javascript/edges.js.deno.json
node test/gen-deno-semtok.js test/fixtures/javascript/ns.js > test/fixtures/javascript/ns.js.deno.json
```

`--types` points at the `@types/node` VS Code's automatic type acquisition
caches, and resolves modules as Node does; the repo's TypeScript 5.9.3 then
gives the same tokens as VS Code's bundled 6.0.3 on both files.
`gen-deno-semtok.js` runs `deno lsp` (`DENO=` picks the binary) with the file's
directory as the workspace and a fresh temp module cache. The token lists in
`test/javascript.test.js` that are not read from a file are tsserver's answers
for those tests' texts.

## Cost

The new band-1 scans run once per version, on the synchronous path. On the
generated 50k-line inputs (`js-50000`, 1.49 MB; `ts-50000`, 1.39 MB), median
of 7 warm calls: the template-hole scan 0.48 ms, the JSDoc scan 0.25 ms in
JavaScript and 0.04 ms in TypeScript, against 12.7 ms for a full lex. The
namespace restore's pass runs after typing pauses, and on a file with no
`import * as` costs a walk over the `import` identifiers.

`node test/bench-scale.js ts js 50000`, the build before this support and this
one run alternately, median of 5, ms of synchronous work; load average 6 to
7.5, so a few ms either way is noise:

| Input | Open | One keystroke | Burst of 10 keys |
|---|---|---|---|
| TS, 50k lines | 3.3 → 8.0 | 25.4 → 26.2 | 133.2 → 145.9 |
| JS, 50k lines | 2.4 → 10.0 | 33.8 → 37.6 | 205.6 → 233.9 |

A JavaScript burst costs 1.6 times TypeScript's on both builds: the JSX
lookahead turns the incremental re-lex off ([Known limits](#known-limits)).

## Known limits

- **A regex right after a statement header**, `if (x) /re/.test(s)`, and the
  same after `while (…)`, `for (…)` and `with (…)`, lexes as two divisions: a `/`
  after `)` is division, and the lexer does not track which `)` closed a header.
  0 of the 2,370 corpus files write one.
- **`of` as a name before `/`**, `y = of / 2`, starts a regex, since `of` is in the
  keyword list for `for (x of /re/…)`.
- **`yield` and `await` always start an operand**, as in a generator, an async
  function or a module; in a script, where they are names, `await / 2` starts a
  regex.
- **Typing in a large `javascript` file re-lexes the whole file**: the JSX
  lookahead turns the incremental re-lex off ([Cost](#cost)). A re-lex that
  records whether the previous lex tried JSX would keep it, since without a JSX
  attempt nothing reads past its line; not done.
- **A shorthand of an untyped alias**: after `const Arborist = require('x')`,
  tsserver types the `Arborist` in `module.exports = { Arborist }` as a
  `property` declaration, so it tints as a one-occurrence bold global (7 times
  in the 220 npm files).
- **A pattern inside another pattern's brackets** (`function f([a, { b }])`)
  is not taken for a parameter pattern, so a caret in `{ b }` focuses that
  brace, which paints nothing.
- **A write through a global object** (`globalThis.x = 1`, `window.y = 2`,
  `process.exitCode = 1`) never marks: the root is library surface.
- **A typed arrow without a server**: `const f = (a: T): R => …` and
  `const f = <T>(a: T) => …` are data to the heuristic; tsserver types them
  `function`.
- **Deno's `variable.readonly` namespace uses** stay page colour where tsserver
  paints slate ([Server states](#server-states)).
