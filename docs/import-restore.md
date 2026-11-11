# Import restore

A band-1 mark for Python, Go, Lua, JavaScript (an HTML document's scripts included), TypeScript and Zig. It paints the uses
of imported modules and types at the theme's type slate (Okibi `#a5b6c8`, Akari
`#52657a`) in documents that no semantic provider colours, and comes off once
one answers; in Lua it stays, and in JavaScript and TypeScript it hands over
per name ([Handover](#handover)). Code: `src/imports.ts`, `src/pystdlib.ts`,
`src/lua.ts` (`luaRestoreSpans`), `src/zig.ts` (`zigImportSpans`), `Decorator.renderImports`. Tests: `test/imports.test.js`, and
`test/shadows.test.js` for the resolver rules the
[shadow restore](shadow-restore.md) brought, which shares this resolver,
`test/javascript.test.js`, `test/html.test.js` and `test/zig.test.js`.

## Why the theme cannot do it

TextMate matches one line at a time, carrying only a rule stack, so it cannot
know which names an import bound. A module or an imported class used in code gets
no scope: `heapq` in `heapq.heapify(h)`, `sys`
in `sys.argv`, `deque` in `defaultdict(deque)` and `isinstance(x, deque)`, `fmt`
in `fmt.Println`. Both Python grammars (Pylance's and MagicPython) leave them at
the page colour. The theme's semantic mappings for `module`, `namespace` and
`class` are right, but they only apply when a server sends tokens. Nothing does
when:

- `python.languageServer` is `None`. VS Code's Python log then says "Editor
  support is inactive since language server is set to None";
- gopls runs with `ui.semanticTokens` off, or is not installed;
- a server is still starting, between the file opening and its first answer.

Markdown fences are never semantic and are not covered: the restore would need a
lex per fence.

## Python

**Bindings.** `import a.b` binds `a`, `import a.b as c` binds `c`, and
`from m import x as y` binds `y`. Parenthesised and multi-line from-imports,
`\` continuations and inline suites (`try: import x`) are parsed. Each binding
belongs to the `def` or `class` suite it sits in (`pyScopeAt`).

**Shadows.** Collecting too many is not free: a shadowed use is not painted, and
band 2 then takes it for data ([below](#band-2)). Per suite:

- assignment targets: plain, chained (`a = b = None`), augmented (`+=`, `<<=`,
  `//=`, not a comparison such as `x <= y`), annotated at statement start, and
  every target of a tuple (`a, re, b = f()`), bracketed (`(a, b) = o`) or
  starred one (`*a, b = o`);
- statement `for` targets, bare names only, however many: `for self.x in` and
  `for d[k] in` bind neither `x` nor `k`; `with … as` a name or a bracketed
  tuple (`as (a, b)`); `except … as`; walrus; `match` captures
  (`case [x, *rest]:`, `case {"k": x}:`, `case P(k=x)`), not class names or dotted
  values;
- `del` of a bare name (`del os`, `del a, (b)`), not of an attribute or item
  (`del sys.argv[1]`);
- `def` and `class` names, `def` parameters, after a PEP 695 type-parameter list
  too (`def first[T](items, id)`);
- `global` names, charged to the module too, and `nonlocal` names, charged to
  their own suite only.

A binding holds from the end of its statement for an assignment, and from the
bound name otherwise. A use in a module or class suite that no binding has
reached yet resolves further out: from a class to the module, from the module to
the builtins, and from a function (only a class body inside it gets there)
nowhere. A `for` or `while` body that holds both the use and the binding
counts as reached, and so does a `while` condition; a `for` iterable runs once,
before its loop, and does not. Python does the same at runtime, and so does
pyright, which filters a scope's declarations by flow only when the use's own
scope is a module or class (`lookUpSymbolRecursive` in `pyright.bundle.js`,
Pylance 2026.4.1, read from the source and not checked against a running
Pylance). The rule is checked in the first suite that binds the name, when that
suite is the use's own or the one it runs in. In a function, comprehension or
lambda a use resolves to the local wherever it sits; above the binding Python
raises `UnboundLocalError`. Without the rule, `del _thread` at the end of
`threading.py` hid the 14 module-level uses above it, and `class SelectSelector`
in `selectors.py` hid `_select = select.select`, which runs before the
class-level `def select`.

An import is never dropped that way: pyright keeps an import declaration
whatever the flow, and Pylance colours a name by its symbol's first declaration
(`decls[0]` in `_getNameNodeToken`, `server.bundle.js`, also read from the
source). So in a suite that both
imports a name and binds it otherwise, a use is claimed when the import comes
first and the use sits above the other binding, in the same function or module:
`line = linecache.getline(…)` in the `try` of `warnings.py` that imports
`linecache`, whose `except` sets `linecache = None`.

While a bracket is still open at the end of the text (mid-edit), the pass runs on
a copy of the lex with each unclosed opener blanked, at the same offsets. Read as
open, `def b(type` made the rest of the file its header's continuation, and every
later function saw the parameter.

Comprehension targets and lambda parameters shadow only inside their own scope,
as in Python 3: a comprehension's brackets minus its first iterable, and a
lambda's parameters and body minus its defaults. `[os for os in os.environ]`
paints the `os` of `os.environ`, and `lambda os=os: os.getcwd()` paints the
default. Charged to the enclosing suite instead, the module-level
`{raw: email for email, raw in _EMAIL_TO_RAW_MAPPING.items()}` in the holdout's
`packaging/metadata.py` hid all 10 uses of its `import email.*` modules: the
restore painted none of them and band 2 tinted every one. Read as unbinding
`sys`, `del sys.argv[1]` hid 33 module uses in six holdout files.

`NAME = None` directly inside `except ImportError` or `ModuleNotFoundError` is a
fallback, not a shadow.

**Resolution** walks the suites outward from the use, skipping class suites
unless innermost, as Python does. A use inside a comprehension or lambda range
that binds the name resolves there, and one in a class body skips the class
suite. Defaults, annotations and bases in a `def` or `class` header resolve in
the enclosing suite, where Python evaluates them: in `rich/table.py`,
`box: Optional[box.Box] = box.HEAVY_HEAD` paints both qualifiers past the
parameter `box`. A shadow in a suite stops the walk, so a parameter named `os`
is data inside its function.

**Claims.** A plain `import` claims a module. A from-import consults the stdlib
table first (below): `c` claims a type, `m` a module, and `t`, `f` and `v` claim
nothing. Then a dots-only relative import of a lowercase name (`from . import
utils`) claims a module, unless it is a dunder (`from . import __version__` is
the package's data), and a CapWords name (`^_*[A-Z]\w*[a-z]\w*$`) claims a
type. Anything else claims nothing, and so does a name whose bindings in one
suite disagree.

**Never painted:** text after a `.`; a callee (next character `(`), because call
sites stay call blue and bold; a statement-start `NAME =`; keyword-argument
labels (`isArgLabel`); comments, strings and docstrings (the lexer); names inside
an import statement, which the theme already scopes; and anything on a decorator
line outside call parentheses.

The decorator rule differs from what Pylance shows today. Pylance types
`functools` in `@functools.wraps(f)` as a module with the `decorator` modifier,
the theme has no `module.decorator:python` key, so it renders slate. The theme
documents a decorator as violet and plain in both layers, so the restore leaves
the qualifier at the grammar's violet. Arguments are code and are painted:
`@mock.patch.object(os, "sep")` paints `os`. 57 tokens of the corpus below sit
in a decorator.

### The Pylance model

Pylance cannot run outside VS Code, so its rules come from its shipped code,
`_getNameNodeToken` in `ms-python.vscode-pylance-2026.4.1/dist/server.bundle.js`:

| Declaration the name resolves to | Token | Theme |
|---|---|---|
| an alias of a module | `module` | slate |
| a class, special built-in class (`Optional`, `List`) or type alias | `class` | slate |
| a function | `function` | call blue |
| a variable | `variable`, or `class` when its type is an instantiable class | page or slate |

A variable whose type is a module is still a `variable`: the instantiable-class
test (`isInstantiableClass` in `pyright.bundle.js`) fails for a module. Typeshed
binds `os.path` as `path = _path`, so `from os import path` claims nothing. This
is read from the bundle, not verified against a running Pylance.

### The stdlib table

The shape rule cannot tell `deque` (a class) from `heappush` (a function) or `pi`
(data), and painting every lowercase from-import slate measured 49 wrong on the
corpus below (40 data such as `logger` and `pi`, 9 functions). `src/pystdlib.ts` lists what the shape rule gets wrong: lowercase classes
and modules, and CapWords names that are not classes. 1,376 entries over 222
modules, plus the 281 top-level stdlib module names, 30 KB. A from-import of a
top-level module not in that set (`numpy`, a local package) falls straight to the
shape rule.

It is generated from the typeshed stubs bundled with Pylance, resolving each
exported name the way the model above does:

```bash
python3 -I scripts/gen-py-stdlib.py > src/pystdlib.ts                     # newest installed Pylance
python3 -I scripts/gen-py-stdlib.py path/to/typeshed/stdlib > src/pystdlib.ts
```

The current table comes from Pylance 2026.4.1, typeshed commit `289e5d3`, under
Python 3.13 (the generator uses `ast.TypeAlias`, 3.12 or later). `test/imports.test.js`
pins a few entries: `collections.deque` `c`, `os.path` `v`, `turtle.Screen` `f`,
`xml.etree` `m`, `typing.AnyStr` `t`.

## Go

The bound name is the alias, else Go's assumed name for the path
(`ImportPathToAssumedName`: drop a `vN` element, a `go-` prefix, and cut at the
first character that cannot be in an identifier). `_` and `.` imports bind
nothing. Only qualifiers are painted, `X` in `X.Name`, and a function that
declares `X` as data paints none of its `X`. Declarations are `X :=`,
`X, Y :=`, the names after `var` or `const` (`var n, X = 1, f()`), each spec of
a `var ( … )` or `const ( … )` block, and a parameter, receiver or result name.
Struct field names and composite-literal keys do not shadow. Type positions such
as `http.Handler` are already slate in the grammar; the restore paints them too,
the same colour.

The shadow covers the whole function, not Go's scope for the name, which starts
after the declaration and ends with its block. In
`var ( inspect = pass.ResultOf[inspect.Analyzer] )` gopls colours the
right-hand `inspect` as the package, and the restore leaves it white. Over 6,000
Go files from GOROOT and the module cache, the `var` / `const` list and block
rules take 20 spans off: 10 uses of the local variable, and 10 package uses that
sit before the declaration ends or outside its block. Checked against gopls in
`go/analysis/passes/assign/assign.go`; the rest by Go's scoping rules.

## JavaScript and TypeScript

Only `import * as NS from "…"`, `import type * as NS from "…"` and
`import d, * as NS from "…"` bind, and only qualifier uses are painted: `NS` in
`NS.x` and `NS?.x`, with a line break or a comment allowed before the `.` or
the member. `NS.Type` in a type position is a use too. A name the file also
writes as a bare word anywhere, a parameter, a local, a key, `f(NS)`, `NS[k]`,
`...NS`, or imports twice, is left out whole, so no shadow needs resolving. A
default or named import (`import fs from 'fs'`, `import { join } from 'path'`)
is not painted ([Not covered](#not-covered)). Over 2,123 public files
([javascript.md](javascript.md#measurements)), 21 hold a namespace import with
uses, 124 uses in all.

An HTML document's scripts get the same restore: the HTML server sends no token
for the binding or its uses either ([html.md](html.md#band-1-restores)).

`javascriptreact` and `typescriptreact` are not covered yet: `<NS.Tag>` in JSX
needs checking against the tag colour first. A `javascript` file can hold JSX
too, so there a tag name, `NS` right after `<` or `</`, is not painted; the
grammar paints `NS.Tag` as one component token. A use in the tag's attributes or
children is.

## Zig

`const x = @import("…")` and `@cImport(…)` bind, as do a lowercase `const`
bound to a type (`const parking_futex = struct {…}`) and a container-level
alias of one that some use reads a member of and no use calls
(`const mem = std.mem;` with `mem.eql(…)`). The declaration and every use are
painted, never a name after `.`, a callee, a field, an enum member or a label.
Zig forbids shadowing only an enclosing scope's name, so a namespace binds in
the scope that declares it (the file, a container body, a block) and a sibling
scope's parameter of that name is data. TitleCase names are the
theme's: it paints them type slate as types. Rules and the corpus counts:
[zig.md](zig.md#band-1-restores).

## Handover

`Classifier.semanticOk(doc)` is true once a provider has answered the document
with tokens. Edits and later `empty` answers keep it (the provider is still
registered); a `none` answer, no provider at all, clears it. An answer for a
version older than the newest one answered changes nothing
([runtime.md](runtime.md#transitions)). While it is false
the restore paints in every phase and every visible editor of the document, like
the other band-1 marks. It is cleared the moment it turns true, so with a server
running the restore lives from the first render to the document's first
classification.

Lua does not hand over. lua-language-server types a `local m = require "m"`
module's uses `variable` (4,510 on the measured corpus) or `class` (931), never
`namespace`, so a handover would turn them from slate to the page colour as the
server loads. The Lua restore paints with or without a provider, through the same
cache and typing debounce ([lua.md](lua.md#band-1-restores)).

Ruby paints no import restore: `require` and `require_relative` name files, not
bindings. Its shadow restore runs through this path in every server state
([shadow-restore.md](shadow-restore.md#ruby)).

JavaScript and TypeScript hand over per name. tsserver sends no token for a
project file's namespace (`import * as util from './util.js'`), only for an
ambient module's (`namespace` on `path` after `import * as path from
'node:path'` with `@types/node`), and Deno types an ambient one's uses
`variable.readonly`. So the restore paints in every server state, and an answer
with tokens records which namespace names got a token at any of their uses
(`typedNamespaceKey`, read through `Classifier.typedNamespacesOf`); those names
are left to the server until a `none` answer clears the record. A change in the
record repaints band 1, as a change in `semanticOk` does. A declaration file
gets no restore: the layer never asks its server
([javascript.md](javascript.md#declaration-files)).

A decoration's colour is written as `color:{0} !important;` (the decoration CSS
template in `workbench.desktop.main.js`, VS Code 1.144.1), so it outranks every
token colour, semantic included. Where two decoration types overlap, the one created first
wins, because VS Code inserts each type's rule at the front of the sheet. That
order is read from the bundle, not checked in a live editor DOM. The band-2 types
are created before `importRestore` and `shadowRestore`, so a tint would win;
after the band-2 change below the two never overlap in Python.

## Band 2

The heuristic classifier used to drop every name that followed `import ` from
band 2, file-wide and by name. That hid real data, `def set_charset(self,
charset)` next to `from email import charset as _charset`, and let names after a
comma (`from x import a, b`) and `except ImportError: c_make_encoder = None`
fallbacks through. Python imports are now resolved per occurrence with the
restore's resolver (`pyImportOffsets`): no identifier inside an import statement
is a candidate, nor is a use that resolves to an import binding.

Driving the real decorator with no provider over every `def` suite (up to 40
per file) plus each file's top level, for the corpus and the holdout below.
Import-bound means the Python truth resolves the name to an import there:

| | Corpus, 1,687 blocks | Holdout, 2,877 blocks |
|---|---|---|
| tints, before → after | 14,154 → 14,183 | 30,014 → 30,095 |
| tints on an import-bound name, before → after | 2 → 0 | 0 → 0 |

In the corpus the 48 new tints are parameters, locals and module variables that
share an import's name: `charset` (14), `posix` (10, `posix = nt = None` before a
conditional `import posix`, a variable to Pylance), `result` (6), `locale` (5),
`time` (4), `exceptions` (3), and `scanstring` / `encode_basestring` /
`encode_basestring_ascii` (6). Of the 19 removed, 3 are `c_make_encoder` (import,
fallback and use; the truth counts the fallback and the use as import-bound), 4
are names on an import line in `asyncio/tasks.py`, and 12 were displaced by the
five-hue cap. The holdout's 0 depends on comprehension and lambda shadows staying
in their own scope ([Python](#python)).

## Measurements

Ground truth for Python is a Pylance-shaped resolver: CPython `symtable` and `ast`
for scoping, the typeshed bundled with Pylance for stdlib kinds, and package
source for the rest. The corpus is 69 files, 69,271 lines: 44 stdlib 3.13 modules,
12 from pip (`_internal` and `_vendor`), 11 interview-prep solutions (copied
before measuring, because one changed during the run), the screenshot fixture
and `samples/sample.py`. Before is the real VS Code TextMate colour (theme commit
`5c72a16`); after is slate where the restore paints.

| Grammar | Import-bound uses wrong today | Changed | Right | Wrong | Unjudged |
|---|---|---|---|---|---|
| Pylance's | 2,940 | 2,559 | 2,552 | 4 | 3 |
| MagicPython | 3,805 | 3,423 | 3,416 | 4 | 3 |

Akari gives the same counts. The resolver rules the shadow restore brought
([Python](#python)) added 22 spans to both rows. 18 are right by the truth. The 4
wrong are the `selectors.py` class-body uses above `def select`: the truth reads
`symtable`, which has no flow and calls them the method; Python resolves them to
the module, checked by running the pattern. Before those rules the rows read
2,537 changed, 2,534 right and 0 wrong. The 3 unjudged are names the truth could
not resolve (`_StringGlobber`, and `RLock` re-exported from an attribute).

The corpus has no wrong span; a holdout does. The holdout is 93 more files,
165,196 lines: 53 stdlib 3.13 modules and 40 files bundled with the VS Code Python
extensions (`packaging`, `cattrs`, `jedi`, `isort`, `pydevd` and others). Judged per painted span
rather than per colour change, the restore paints 10,439 spans there and 13 are
wrong (0.12%), all one pattern: a **singleton instance with a CapWords name**,
`Infinity = InfinityType()` and `NegativeInfinity` imported into the two vendored
copies of `packaging/version.py` (12), and `Empty = _EmptyIO()` in
`isort/api.py` (1). Pylance types such a name as a variable, because its type is
an instance, not an instantiable class. The shape rule cannot see that without
reading the source module, so the restore accepts it. The truth's resolver labels
212 more spans variables; they are type aliases, `NewType`s, typing special forms,
a functional `Enum` and class-valued variables (`NoneType = type(None)`), which
the model above types as `class`. 16 painted spans are names the truth
counts as both imported and rebound in one scope: each is a use above a later
`del` or rebinding of the import in the same scope, 13 in `_pydecimal.py`, 2 in
`os.py` and 1 in `warnings.py`.

```
Left wrong after the restore, Pylance's grammar (388)
class constructor call     ████████████████████████████ 289   call blue, by design
decorator qualifier        ██████ 57                          violet, by design
module use not painted     ██ 23                              conservative shadow skips
function used as a value   █ 12                               not claimed
other                      █ 7
```

Go, against `gopls semtok` v0.23.0 on 8 files, 7,508 lines (7 stdlib packages and
`samples/sample.go`): 734 namespace tokens, 417 white today. The restore changes
417, all right, and misses none.

The screenshot fixture (`test/fixtures/imports/shot.py`) paints `heapq`, `sys` and
the four `deque` uses that are not calls. `tuple[` is a builtin, not an import, and
belongs to the theme.

## Cost

Computing the spans is a whole-file pass, cached per lex (warm, median of 7, ms).
In Python the same pass computes the [shadow restore](shadow-restore.md); the
first Python figure is the pass before it and its resolver rules:

| Lines | 2k | 10k | 50k |
|---|---|---|---|
| Python | 1.2 → 1.6 | 3.8 → 6.1 | 19.3 → 28.7 |
| Go | 0.7 | 2.2 | 8.1 |

The loop test reads a statement-line tree built once per lex, and only a module
or class use above a binding asks it. A walk per use was quadratic: a 1,000-line
`while` body rebinding `type, id` at its end took 84 ms, a 5,000-line
`if __name__ == "__main__":` block with a late `type = 1` 462 ms, and a 20,000-line
function 37 s. They now take 3, 7 and 39 ms.

A Go method whose last parameter is a func type (`fn func(ctx context.Context)
error`) costs the same as any other: the header scan stops at the `)` that closes
the parameter list the func type sits in. A scan that ran on to the next `{`
instead took 4,674 ms on 14,011 lines of such mock setters; it now takes 6 ms.

On open it runs in the first render, so the restore is on screen at first paint.
That costs 10 ms (Go) and 32 ms (Python) of CPU on a 50k-line file, 1 to 8 ms
at 2k to 10k lines, and with a server that answers it comes off at the first
answer. Waiting for that answer instead would show the grammar's colours on the
restored ranges until it arrives, the 60 ms focus debounce plus the server, so
the open path keeps paying it.
After an edit the ranges already on screen stay (VS Code moves them with the
text), and the recompute waits for typing to pause (`editDebounceMs`: 140 ms up
to 10k lines, growing to 400 ms at 50k), so a keystroke's synchronous path does
not pay it.

`node test/bench-scale.js`, the commit before the import restore (`10ca83e`) →
the import restore (`a4f7d3f`) → this build with the shadow restore, run
interleaved, median of 5, ms per cell as in
[runtime.md](runtime.md#cost-on-large-files):

| Input | Open | One keystroke, synchronous part |
|---|---|---|
| Go 10k / 50k, with tokens | 31.9 → 40.1 → 40.9 / 95.4 → 102 → 101 | 6.4 → 5.9 → 6.4 / 10.4 → 9.9 → 10.6 |
| Python 10k / 50k, with tokens | 34.6 → 44.4 → 46.6 / 97.4 → 110 → 122 | 12.9 → 11.2 → 8.7 / 30.1 → 32.6 → 32.4 |
| Go 10k / 50k, no provider | 25.2 → 31.6 → 31.5 / 58.0 → 78.9 → 78.2 | 6.0 → 6.0 → 5.9 / 9.3 → 8.8 → 8.7 |
| Python 10k / 50k, no provider | 28.6 → 40.9 → 44.0 / 77.9 → 99.2 → 105 | 11.3 → 11.1 → 10.7 / 23.1 → 20.9 → 21.0 |

Nothing of either restore runs on that path, so its differences are run-to-run
noise. Computed synchronously per keystroke instead, the 50k-line Python
keystroke rose from 43 to 72 ms and a burst of 10 from 251 to 474 ms (median of
3, no provider).

The resolver fixes since (the flow rule's scopes, the loop tree, the target
forms, unclosed brackets) were run interleaved with the build before them:
opening the 50k-line Python file moved +1.9 ms with tokens and +0.8 ms without
(median of 5), inside run-to-run noise.

## Not covered

- **JavaScript and TypeScript default and named imports**, and a namespace
  under Deno's `variable.readonly`, which stays the page colour
  ([javascript.md](javascript.md#server-states)).
- **Zig aliases inside a function** (`const testing = std.testing;` in a
  test): data with no server, and no restore; 1,071 of zls's namespace uses on
  the Zig corpus ([zig.md](zig.md#band-1-restores)).
- **Submodule attributes** (`os.path.join`): the right of a dot is never painted,
  and by the model above Pylance types `os.path` as a variable.
- **Class-body members** (`queues:` in a class) are a member-colour question, not
  an import one.
- **The rest of a name a suite both imports and rebinds.** Pylance colours every
  use by the first declaration, so after `import os` and a later `os = None` it
  still shows the module, below the rebinding and from nested functions too. The
  restore claims only the uses above the rebinding in the same function or
  module ([Python](#python)).
- **Notebooks.** Each cell is a document of its own and is resolved alone: an
  `import numpy as np` in one cell leaves `np` in the next at the grammar's
  colour, where Pylance chains the cells into one module.
