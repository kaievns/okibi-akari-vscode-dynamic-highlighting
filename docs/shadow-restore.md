# Shadow restore

A band-1 mark for Python, Lua and Ruby. It paints the non-call uses of a builtin
name that the code binds as data (a parameter `id`, a module-level
`input = sys.stdin.readline`, a Lua `local type = node.type`, a Ruby
`def f(p, format)`) at the page colour (Okibi `#e1e3e5`, Akari `#13110e`,
normal weight), in documents that no semantic provider colours, and comes off
once one answers; in Lua and Ruby it stays ([Lua](#lua), [Ruby](#ruby)).
Code: `shadowUseSpans` in `src/imports.ts`, `luaRestoreSpans` in `src/lua.ts`,
`rubyShadowSpans` in `src/ruby.ts`, `Decorator.renderImports`. Tests:
`test/shadows.test.js`, `test/lua.test.js`, `test/ruby.test.js`.

## Why the theme cannot do it

Both Python grammars (MagicPython and Pylance's copy) scope a bare builtin name
wherever it stands, called or not and bound or not: `support.function.builtin.python`
for `id`, `input`, `len`, `max` and 54 more, which the theme paints bold call blue,
and `support.type.python` for `list`, `type`, `object` and 16 more, at type
slate. A grammar sees one line at a time, so it cannot tell `id` the parameter
from `id` the builtin. In

```python
def cancel_trade(self, time: Time, id: ID):
    if id not in self.cancelled_trades and self.queue:
        min_id, max_id = self.queue[0][0], self.queue[-1][0]
        if min_id <= id <= max_id:
            self.cancelled_trades.add(id)
```

every `id` in the body rendered bold call blue at rest. Pylance sends `parameter`
for them, which the theme paints page colour; with `python.languageServer: None`
nothing does. Band 2 tints them in Focus, which is why only Survey showed it.

## Rules

**Names.** The 77 names the two grammars scope as builtin functions and types,
listed in `PY_BUILTINS`. Both grammars use the same lists. Left out:

- `support.type.exception.python` names. A data binding of an exception name is
  an alias of a class (`TimeoutError = futures.TimeoutError` in
  `concurrent/futures/_base.py`), which Pylance types `class`. The grammar's
  slate is already right.
- `variable.legacy.builtin.python` (`file`, `reduce`, `unicode` and 7 more): the
  theme paints them page colour already.

**Bindings and resolution** are the import restore's
([import-restore.md](import-restore.md#python)): one resolver serves both marks.
A use is painted when it resolves to a data binding: a parameter, an assignment
target, a `for` / `with` / `except` / `match` capture / walrus / `del` target, a
comprehension target or lambda parameter in its own scope, or a `global` name.
`nonlocal` resolves through its function chain.

**Not painted:**

- calls (next character `(`), which keep the call colour, as any local called
  `f()` does;
- keyword-argument labels (`f(id=1)`), attributes after a dot (`self.id`), and
  anything on a decorator line outside call parentheses;
- `def` and `class` names, and uses that resolve to one: Pylance types them
  `function` (call blue) or `class` (slate), the grammar's colours;
- uses that resolve to an import, in any scope of the chain. `import os as id`
  binds a module, so its uses belong to the import restore. Where an import and
  another binding share a scope, the shadow restore paints nothing;
- at module level and in a class body, uses no binding has reached yet. A
  binding holds from the end of its statement, so in
  `print = partial(print, flush=True)` the right-hand `print` is the builtin and
  the target is data. Python agrees at runtime. A `for` or `while` body that holds
  both the use and the binding counts as a path, and so does a `while`
  condition; a `for` iterable runs once, before its loop, and does not. The rule
  is pyright's, and holds only there
  ([import-restore.md](import-restore.md#python)).

In a function, comprehension or lambda every use of a local resolves to it,
above its binding too. Python raises `UnboundLocalError` there; pyright does not
filter by flow in those scopes, so Pylance still sends `variable`, and the
restore paints it (`def f(xs): y = id; id = xs` paints both `id`).

Class-body fields are painted page colour, the same as every other class-body
field without a server. Pylance sends them `variable` with `classMember`, which
the theme paints member steel ([import-restore.md](import-restore.md#not-covered)).

## Precedence

| Where both apply | Wins | Why |
|---|---|---|
| band-2 tint and shadow restore | band 2 | Decoration colour is `!important`; the type created first wins, and the band-2 types are created first (`buildDecorationPool`). |
| import restore and shadow restore | neither paints the other's range | A use resolves to one binding: an import goes to the import restore, data to the shadow restore. Tested on a mixed file. |
| shadow restore and the grammar | shadow restore | A decoration colour outranks every token colour ([import-restore.md](import-restore.md#handover)). |

The lifecycle is the import restore's: computed in the first render, recomputed
after the typing debounce, cleared once `Classifier.semanticOk(doc)` turns true,
except in Lua and Ruby. Both marks come from one cache entry per document version.

## Lua

VS Code's Lua grammar scopes 28 builtin names `support.function.lua` wherever
they are not assigned or after `.` / `:`, so `if type == "x"` after
`local type = node.type` reads call blue. lua-language-server sends `variable`
for that `type`, which Okibi and Akari paint the page colour: with the layer
switched off, the theme repo's harness launcher reads `#13110e` there in Akari,
under the current theme and under the one before its Lua keys (2026-11-08). An
earlier reading of call blue came from a capture taken before the editor had painted
that viewport's tokens (the theme repo's `e2e/README.md` § Lua coverage). The
restore stays on with the server: nothing repaints when the server answers, and
the grammar's call blue never shows before it does. It paints non-call uses that
resolve to a local, parameter or loop variable, never a local function, a
`local type = type` alias or an assignment target: 260 spans on the measured
corpus, every one a data use
([lua.md](lua.md#band-1-restores)).

## Ruby

VS Code's Ruby grammar scopes 44 Kernel method names
`support.function.kernel.ruby` wherever they stand (`p`, `puts`, `format`,
`test`, `select`, `open`, `print`, …), so a parameter `p` reads call blue in
`print = p + puts`; the harness copy measured it so with no server
([ruby.md](ruby.md#real-editor)). ruby-lsp types those reads `parameter` or
`variable`, the page colour, but leaves declarations and writes without a token.
The restore paints every data use `rubyFacts` binds to a local or parameter of
such a name, declarations included, never a call (`p x`, `format(…)`) or a
hash shorthand, and stays on in every server state: 960 spans on the public
corpus with no server and 924 with ruby-lsp tokens, every one a data use by
Prism ([ruby.md](ruby.md#band-1-restores)).

## Go

The builtin functions need nothing. The Go grammar scopes them only at a call
site: `\b(append|cap|close|…|clear)\b(?=\()` and the `new(` / `make(` begin rules
in `go.tmLanguage.json`. Tokenized with the theme, a local named after each of
the 18 (`len`, `cap`, `new`, `make`, `copy`, `append`, `min`, `max`, `clear`,
`close`, `delete`, `print`, `println`, `panic`, `recover`, `real`, `imag`,
`complex`) renders page colour as a parameter, a `:=` target and a later use. Only
`len(xs)` and the other calls are call blue, which is right.

The predeclared types are another matter, and are not restored (below). The
grammar scopes `string`, `error`, `byte`, `rune`, `bool`, `any` and the numeric
types wherever they stand (`storage.type.string.go`, `entity.name.type.any.go`
and so on), so in `func f(s string, any bool)` with `rune := 3` inside, the
parameter `any` and every use of `rune` and `any` render type slate.

## Measurements

Ground truth is CPython 3.13's `symtable` for def, lambda, class and module
scopes, plus the `ast` for comprehension scopes, which 3.12+ `symtable` inlines.
A builtin-named token should be painted when it is not a call, label, `def` /
`class` name or import, and resolves to a data binding. Bindings hold from the
end of their statement, in every scope; no token of either set depends on that
(below). Before is the real VS Code TextMate colour (theme commit `d1ab2df`);
after is the page colour where the restore paints.

| Set | Files | Lines | Should change | Changed | Right | Page, Pylance steel | Wrong | Missed |
|---|---|---|---|---|---|---|---|---|
| Corpus | 75 | 69,471 | 548 | 548 | 545 | 3 | 0 | 0 |
| Holdout | 60 | 51,618 | 309 | 309 | 309 | 0 | 0 | 0 |

Both grammars and both themes give the same counts. The 3 are class-body fields
(above). The theme's binding-position rule (`py-bindings.injection.json`, added
after `d1ab2df`) already paints assignment, `for` and `as` targets page colour, so
with it the spans the restore visibly changes drop to 465 (corpus) and 257
(holdout); the rest are reads, which only the restore can resolve. The restore also paints 107 (corpus) and 160 (holdout) parameters the
grammar already shows page colour; those paints change nothing.

The corpus is the import restore's 69 files
([import-restore.md](import-restore.md#measurements)), the 5 Python test
fixtures that predate this mark, and the screenshot above
(`test/fixtures/imports/shadow-shot.py`). The 11 interview-prep solutions were copied
before measuring, because one changed during the run. The holdout is 60 stdlib
3.13 modules outside the corpus, drawn at random (seed 7) from the 243 that have
a builtin-named parameter or statement-level assignment.

```
Changed spans by name, corpus (548)          holdout (309)
object  ████████████████████ 222             input  ████████████ 118
dir     ████ 49                              dir    █████ 46
type    ████ 40                              type   ████ 44
id      ████ 39                              str    ██ 19
help    ███ 30                               dict   █ 14
other   ███████████████ 168 (21 names)       other  ███████ 68 (15 names)
```

A second ground truth follows pyright's lookup instead: the flow rule only for a
use in a module or class suite, a class handing an unreached use to the module,
loop back edges into a body and a `while` condition but not a `for` iterable.
Every builtin-named load, store and parameter is judged, called or decorator
uses aside. The flow-rule, target and bracket rules ([Rules](#rules),
[import-restore.md](import-restore.md#python)) change no span of the corpus, the
holdout or the first three sets below; against this truth:

| Set | Files | Lines | Should paint | Right | Wrong | Missed |
|---|---|---|---|---|---|---|
| Corpus files (samples, fixtures, `shot.py`, 11 solutions) | 19 | 1,306 | 37 | 37 | 0 | 0 |
| Stdlib 3.13 modules | 400 | 180,652 | 1,861 | 1,861 | 0 | 0 |
| Interview-prep (54) and stdlib (30) copies | 84 | 52,064 | 1,005 | 1,005 | 0 | 0 |
| The cases each rule was written for | 13 | 266 | 145 | 145 | 0 | 0 |

The 193 tokens the build before missed (119, 70 and 4) were all parameters with a
default (`def run(self, cmd, globals=None)`), read as a keyword label because
`isArgLabel` took the `def` parameter list for a call. It no longer does. Both
grammars already scope such a parameter page colour, so the paint changes
nothing on screen. The truth does not list three
of the last set's painted names, all bindings: `**dict` and `*list` in `case`
patterns and the `len` of `global len`. Before these rules that set read 126
right, 4 wrong and 15 visible misses. The 5 files of unclosed-bracket cases do not
parse, so the truth cannot judge them; `test/shadows.test.js` pins them.

## Cost

One pass computes both marks; its cost is in
[import-restore.md](import-restore.md#cost).

## Not covered

- **Markdown fences**, as for the import restore.
- **Class-body fields** stay page colour, not member steel.
- **A use below its binding on a path the binding never reaches**, at module
  level or in a class body, such as the `else` branch of the `if` that binds it.
  The pass orders bindings by position and handles loops, not branches, so it
  paints that use; Pylance resolves it further out. In a function both resolve
  it to the local.
- **Notebooks.** Each cell is its own document and is resolved alone, so a name
  an earlier cell binds keeps the grammar's colour in later cells, where Pylance
  chains the cells into one module: `max = 0` paints both `max` in its cell and
  none in the next. The import restore has the same gap.
- **Go predeclared types** named as locals (`string`, `error`, `rune`, `byte`,
  `any`) stay type slate. `goUses` already parses every binding site such a
  restore needs; it is not built.
