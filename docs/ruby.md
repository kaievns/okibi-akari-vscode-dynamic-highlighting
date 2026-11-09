# Ruby

Ruby (`ruby`, VS Code's built-in `source.ruby` grammar, or Shopify.ruby-lsp's;
ruby-lsp through Shopify.ruby-lsp) is a code language: keyword-delimited
blocks, data identities, escape marks and band-1 restores. `src/ruby.ts` holds
the bindings, `src/lex.ts` the lexer family, `scanRubyBlocks` in `src/focus.ts`
the blocks. Tests: `test/ruby.test.js`, plus Ruby in the relex parity, the
perf-golden inputs and the transition walks.

Which files open as `ruby`, in VS Code 1.144.1:

| Extension | Names |
|---|---|
| built-in `ruby` | `.rb .rbx .rjs .gemspec .rake .ru .erb .podspec .rbi`; `Rakefile`, `Gemfile`, `Guardfile`, `Podfile`, `Capfile`, `Vagrantfile`, `Brewfile`, `Berksfile`, `Thorfile`, `Puppetfile`, `Dangerfile`, `Fastfile` and 11 more; a `#!…ruby` first line |
| Shopify.ruby-lsp 0.10.8 | adds `.irbrc`, `.pryrc`, `.simplecov`, `Steepfile`, `Jarfile`, `.jbuilder`, `.builder`, `.thor` and 14 more; claims `.erb`, `.rhtml`, `.rhtm` for its own `erb` language, so a template opens as `erb` |

Without Shopify.ruby-lsp, `.irbrc` and `.pryrc` are not Ruby to VS Code, and a
template opens as `ruby` ([ERB templates](#erb-templates)). A ```` ```ruby ````
fence in markdown is prose.

## Measurements

The reference is Prism 1.8.1, Ruby's own parser (Ruby 4.0.7): its lexer for
regions and numerals, its tree for scopes, locals and writes. The public corpus
is 4,174 files: Homebrew's `Library/Homebrew` (1,976), the gems it vendors
(1,451), the gems of brew's ruby-lsp 0.26.11 (709), local taps (25) and 13
synthetic files: `samples/sample.rb`, a helper it requires, a Gemfile,
Rakefile, `.rake`, gemspec, `config.ru`, Brewfile, Podfile, Vagrantfile,
Guardfile, `.irbrc` and `.pryrc`.
86 private files were counted only. The runs drive the real `Decorator` under
the stub: carets at the first local reference inside each scope, then Focus
and Edit, with ruby-lsp 0.26.11's captured tokens and with none. ruby-lsp sends
no tokens for 15 public files over 100,000 characters
([Server states](#server-states)), so its runs place 24,344 carets, against
24,513 with no server.

| What (public corpus) | Before | Now |
|---|---|---|
| characters in the wrong region | 1,699,002: 482,067 code read as text; 600,047 string, 610,414 symbol, 6,438 comment and 36 `__END__` data read as code | 7, the `__END__` keyword itself |
| comments with Prism's bounds | 133,352 of 134,581 | 134,581 of 134,581 |
| numerals with Prism's bounds | 32,228; 4,234 extra, 1,080 missed | 33,290; 18 extra, 18 missed |
| scopes with Prism's first and last line | 21,727 of 138,787 | 138,782 of 138,787 |
| carets that focus their scope, no server | 2,167 of 24,513 | 24,443 of 24,513 |
| Prism locals the bindings find | no bindings | 337,877 of 337,886 |
| tints right / wrong, no server | 251,745 / 843,019 | 181,159 / 33 |
| tints right / wrong, ruby-lsp tokens | 250,382 / 692,627 | 179,830 / 51 |
| escape marks right / wrong, ruby-lsp tokens | 55,952 / 21,342 | 5,572 / 2 |
| expected writes marked, ruby-lsp tokens | 1,383 of 4,455 | 4,430 of 4,449 |
| clay in strings or comments | 26,867 | 0 |
| `self` paint wrong | 187 | 0 |
| async marks | 97 | 0 |

On the private corpus the region errors went from 68,104 characters to 0, the
scopes from 276 to 3,711 of 3,712, Prism's locals found 14,834 of 14,834, and
the escape marks from 2,943 right and 789 wrong (70 of 192 expected writes) to
242 right and 0 wrong (182 of 189).

Before, every caret fell to the whole-file scope, so the old "right" tints are
mostly names tinted file-wide.

The residuals:

- **Numerals:** Prism puts a unary `+` in the literal (`+1`); the lexer leaves
  it an operator, so the 18 are the same literals one character apart.
- **Scopes:** 61 public and 6 private scopes match only once a branch's
  trailing comment lines are dropped: the scan ends a branch at its last code
  character. 5 public and 1 private do not match.
- **Locals:** 3 parameters and 6 reads are missed; 2 names bound as locals are a
  call and a label to Prism.
- **Tints:** 51 (ruby-lsp) and 33 (none) land outside the Prism scope that holds
  the caret, and are not a captured name's trace back to its declaration. The
  first three per caret are on 25 lines in 10 files, among them a top-level
  `rescue StandardError => e` read in a nested `{ |l| … }`, and
  `/(?<name>…)/ =~ line` captures inside an `unless` in a loop body. Not
  analysed further.
- **Escape marks:** the 2 wrong ones are `hash["a"], hash["b"] = …`: index
  targets of a multiple assignment, which mark under the parameter-member rule
  and which the reference does not count as writes. The 19 missed are 16 writes
  to an outer local and 3 closure writes, among them pattern captures
  (`in [remainder, separator, String => value]`) and `rescue => ex`; not
  analysed further.

## Lexer

| Form | Region |
|---|---|
| `#` to the line end, magic comments and YARD tags included | comment |
| `=begin` … `=end`, both at column 0, through the `=end` line | comment |
| `__END__` alone on a line at the top level: everything after its line | comment |
| `'…'`, `%q(…)`, `%w[…]`, `%i[…]`, `%s(…)`; `"…"`, `` `…` ``, `%(…)`, `%Q{…}`, `%W[…]`, `%I[…]`, `%x(…)`: multi-line, escapes; any delimiter, `()[]{}<>` nesting | string; holes in the second group only |
| `/…/flags`, `%r{…}flags` | string with holes |
| `<<~ID`, `<<-ID`, `<<ID`, `<<~'ID'`, `<<~"ID"`, `` <<~`ID` `` | the opener is a string; the body, from the next line through the terminator line, is a string with holes unless the id is single-quoted |
| `:name`, `:name?`, `:name=`, `:@x`, `:$x`, `:+`, `:[]=`, `:"…"` (holes), `:'…'` | string |
| `"key": v`, `'key': v` in a hash or argument list, paren-less calls included (`foo "k": 1`); not a ternary branch (`c ? "a": b`) | string, the colon included |
| `?a`, `?\n`, `?\C-a` | string |

**Holes.** `#{…}` is a code hole, and `#@x`, `#@@x`, `#$x` make the name a hole
of its own. `rubyPlaceholderSpans` paints the `#{` and `}` of each closed hole.

**Where a literal starts.** `/`, `%`, `?` and a bare `<<ID` open a literal only
where an expression starts: after an operator, `(`, `,`, a line break, or one of
`if unless while until and or not return when in case then else elsif do yield
break next begin ensure rescue defined?` (not after `.`). They also open one as a
command argument, after a method name and a blank (`split /,/`, `puts ?a`,
`p %w[a]`, `x.split /,/`), unless the name is `class` or starts with a digit. So
`a / b`, `x %= 2`, `n % 2` and `a ? b : c` stay operators. `<<~`, `<<-` and a
quoted id always open a heredoc.

A local is an operand, not a command, as in Ruby's own lexer, which keeps a
local-variable table: in `half = width /2`, `n ?1 : 0`, `n %(3)` and `s <<EOS`
after `width`, `n` or `s` is a local, they are operators. So are they after
`@x`, `@@x` and `$x`. The lexer's table takes a name from an assignment
(`x = 1`, `x += 1`, `x ||= 1`), a multiple assignment that starts a statement
(`a, (b, *c) = …`), and the parameters of a `def`, a block (`|a, (b, c), *d; e|`)
and a lambda (`->(a)`, `-> a {`). A `def` opens a table of its own, as Ruby's
hard scope does; the first later code line indented no deeper than the `def`'s
line closes it, except `rescue`, `else` and `ensure`. Over the public corpora
(Homebrew, its vendored gems, ruby-lsp's bundled gems, the Ruby 4.0.7 standard
library, local tap formulae: 3,836 files, 714,288 lines) the table changes no
line's regions against the lexer without it; a table for the whole file instead
would have read 3 command calls in a class body as locals, after a `def` above
them assigned that name (`rule %w[a b], …` in Bundler's settings validator).

Not in the table, so still a command argument after them: names bound by
`for`, `rescue => e`, a pattern (`in [a]`, `=> x`) or a named regex capture, and
`it` and `_1`. A block's parameters and locals stay in the table after the
block ends, and those of a class body or the top level stay for the rest of the
file outside a `def`. A `def` whose body is indented no deeper than its own line
closes its table at its first body line.

**Heredocs.** Openers queue on their line; at the line break the bodies are read
in order, each up to the line that is its id (leading blanks allowed for `~` and
`-`). This happens before the line start is recorded for the re-lex, so a body
consumes its own line breaks as a multi-line string does and the re-lex stays
exact ([lexer.md](lexer.md#incremental-re-lex)).

**Identifiers.** `@x`, `@@x`, `$name`, `$0`, `$-w` and the punctuation globals
(`$!`, `$~`, `$"`) are one identifier each. A trailing `?` or `!` belongs to the
name (`empty?`, `save!`) unless `=` follows. After `def`, an operator name
(`def +(other)`, `def /(x)`, `` def `(cmd) ``) is a name, not a literal.

**Numerals** take Prism's bounds: `1_000`, `0x1F`, `0b1`, `0o17`, `1e3`, and the
rational and imaginary suffixes (`1r`, `2i`, `1.5r`, `3ri`).

## Blocks

`def … end` (endless `def f(x) = …` runs to the end of its expression), `class`,
`module`, `class << self`, `do … end` and `{ … }` blocks, lambdas
(`->(x) { … }`, `-> x do … end`), `BEGIN { }` / `END { }`, each branch of
`if` / `elsif` / `else`, `unless`, `case` / `when` / `in` / `else`,
`begin` / `rescue` / `else` / `ensure`, the `rescue` / `else` / `ensure`
sections of a `def` or `do` body, and `while`, `until`, `for` (their `do`
belongs to the loop).

| Field | Value |
|---|---|
| `headerStart` | the opener keyword; for a block its `do` or `{`, for a lambda its `->`, for `BEGIN { }` the `BEGIN` |
| `openOffset` | past a `def`'s `)`, its paren-less parameters' line end, or its name; past an endless `def`'s `=`; past a block's `\|params\|`, `do` or `{`; past a branch or loop header's `then`, `do` or `;`, else its logical line end |
| `closeOffset` | the `d` of `end`; the `}`; for a branch, the last code character before the next branch keyword; for an endless `def`, the last code character of its expression |

What opens nothing:

- modifiers, `x if y`, `x unless y`, `x while y`, `x rescue y`, `begin … end while c`,
  and `then`;
- a keyword after `.` or `::` (`x.end`, `Foo::class`) or before a label colon
  (`if: true`, `end:`);
- `end`, `if` or `def` inside a heredoc, string, %-literal, regex, symbol or
  comment;
- a hash: a `{` is a block after a name (`empty? {` and `save! {` included), `)`,
  `]`, `->`, `BEGIN` or `END`, and a hash after anything else, a ternary `?`
  (`c ? { a: 1 } : {}`) and a unary `!` (`!{ a: 1 }.empty?`) included, and after
  `return then else do when in and or not if unless while until elsif yield case
  begin ensure rescue break next redo puts p print raise`.

Braces always pair with braces and `end` with keywords, so a keyword the scan
misreads leaves the brace blocks around it intact. A keyword opener without its
`end` makes no block: inside braces the closing `}` drops it, elsewhere every
later block nests one deeper.

## Data identities

Locals, method and block parameters (block-locals after `;` included), the
implicit `it` and `_1` … `_9`, `for` and `rescue => e` variables,
multiple-assignment targets, pattern captures (`in [a, *rest]`, `in {x:}`,
`=> name`, rightward `expr => {x:}`), and named regex captures
(`/(?<year>\d+)/ =~ s`, with no interpolation in the regex). User globals
(`$registry`) are data, out of every scope, so they tint bold; the tint covers
the name, not the `$`. Without semantic tokens a user global is a candidate only
where the top level or a class body writes it (`globalSites`), so one written
only inside a method or a block (`$last = v`) stays untinted; with ruby-lsp's
tokens it tints wherever it appears (measured in the theme repo's `e2e/` `ruby`
cell).

Not data:

- method names, calls with or without parentheses (`foo`, `foo(x)`, `p x`), and
  a name followed by an argument even when a local of that name exists;
- `@x` and `@@x` (members: band 1 only), constants and `A::B` paths, symbols,
  labels and keyword-argument names (`key:`, `f(tax: 1)`);
- names after `.`, `&.` or `::`, `alias` and `undef` operands, `def` names;
- Ruby's globals: `$stdout`, `$0`, `$~`, `$1`, `$PROGRAM_NAME`, the `English`
  names;
- keywords, `self`, `_`.

Resolution follows Ruby's own lexical rule (`rubyFacts`). A name is a local
from its first assignment on; before that, the same name is a method call.
`def`, `class` and `module` bodies are hard scopes: nothing outside is visible.
A block sees the locals of the scopes around it, and its own locals and
parameters end with it. A pin (`^x`) reads; a hash shorthand `{ sum: }` reads
`sum`, and its tint covers the name, not the colon.

ruby-lsp 0.26.11 types reads only: `variable` and `parameter` on reads,
`variable.defaultLibrary` on `self`, `method` on calls, no `declaration`
modifier, and no token on a plain write or a parameter's declaration.
`rubyTokens` keeps its `variable` and `parameter` tokens where a binding
exists, and adds a token on every other bound identifier: declarations (with
`declaration`), writes, user globals and reads ruby-lsp left untyped. The
heuristic declares the same sites (`declSites`, `globalSites`) and takes a name
as a candidate only where the bindings bind it.

## Escape marks

The shared rules ([risk-marks.md](risk-marks.md)), with ruby-lsp's tokens only;
the heuristic path makes no claim. Ruby specifics:

| Write | Marks when |
|---|---|
| `x = …`, `x += …`, `a, b = …` | `x` is declared outside the focused block (from a block: a closure capture), and not in an earlier branch of the same conditional |
| `x.y = …`, `x[k] = …` | `x` is a parameter (its object is the caller's), or declared outside the block |
| `@x = …`, `self.y = …`, `@x.y = …` | inside a method other than an initializer; blocks inside an initializer share its exemption |
| `@@x = …` | inside any method |
| `$x = …` | inside a method, class body or block; at the top level it defines the global |

Initializers: `initialize`, `initialize_copy`, `initialize_dup`,
`initialize_clone`. `=~`, `==`, `===`, `=>`, `<=`, `>=` and `!=` are not
writes, nor is a declaration, a label or a shorthand.

A configuration block's member writes mark: `config.vm.box = …` in
`Vagrant.configure("2") do |config|` and `spec.name = …` in a gemspec write into
the block's parameter, as `opts.limit = 7` does elsewhere.

No async or danger words: Ruby has no async syntax and no cast. Sorbet's
`T.cast` (368 uses in the public corpus), `T.unsafe` (29) and `T.untyped` (916)
are left unmarked.

## Band-1 restores

| Restore | Spans | With ruby-lsp |
|---|---|---|
| `self`, keyword grey | every code `self`, but not a method named `self` (`tp.self`, `Foo::self`) or a `self:` key; never `this`, an ordinary name in Ruby | needed: ruby-lsp types `self` `variable.defaultLibrary`, which outranks the grammar's `variable.language.self.ruby` |
| interpolation, member steel | the `#{` and `}` of every closed hole in a string, symbol, regex, command or heredoc; the expression inside keeps its own colours | needed in both: bracket-pair colorization paints the braces over the theme's rule |
| shadowed Kernel name, page colour | data uses of a local or parameter named like one of the 44 Kernel methods the grammar scopes `support.function.kernel.ruby` wherever they stand (`p`, `puts`, `format`, `test`, `select`, `open`, …; the rule's `autoload?` and `exit!` cannot be locals); not shorthands | stays: ruby-lsp leaves declarations and writes without a token, and its `parameter` / `variable` reads agree |

Ruby has no import restore: `require` and `require_relative` name files, not
bindings. The shadow restore runs through the import restore's path (cached per
version, recomputed once typing pauses) in every server state. On the public
corpus it paints 960 uses with no server and 924 with ruby-lsp tokens, every
one a data use by the reference.

## Server states

| State | What the layer sees |
|---|---|
| Shopify.ruby-lsp activates | on any `ruby` or `erb` document: it declares `workspaceContains:Gemfile.lock` and `gems.locked`, and VS Code 1.144.1 adds `onLanguage:` for each language an extension contributes with a configuration. ruby-lsp outside a bundle composes its own and answers (`test/gen-rb-semtok.js` runs it so). In the editor it answers in a workspace with no Gemfile or lockfile too: the theme repo's `e2e/` `ruby` cell, whose client settings point the bundle at a scratch Gemfile, got 181 tokens 4.2 s after the file opened |
| a file over 100,000 characters | ruby-lsp answers with no tokens (`MAXIMUM_CHARACTERS_FOR_EXPENSIVE_FEATURES`, 15 public files): `empty`, so band 2 holds through the ~30 s cold-retry schedule and then the heuristic paints, without escape marks ([runtime.md](runtime.md#cold-servers)) |
| `rubyLsp.enabledFeatures.semanticHighlighting: false`, or no extension | ruby-lsp advertises no semantic tokens provider: `none`, and the heuristic paints at once |

## ERB templates

`erb` is static content: Survey only, no Focus scope, no band-1 restores.
Shopify.ruby-lsp registers `erb` with its `text.html.erb` grammar, which
embeds Ruby, HTML, CSS and JavaScript. Without it VS Code's built-in Ruby
extension claims `.erb`, so a template opens as `ruby`; `effectiveLanguageId`
reads a `ruby` document whose path ends in `.erb`, `.rhtml` or `.rhtm` as
`erb`. Read as Ruby, a template got the whole-file scope, `self` and
interpolation paint inside HTML, and tints on JavaScript `const` names.

Focus on the Ruby inside `<% %>` tags (loop variables in templates) would need
an `erb` lexer family whose tags are Ruby holes; not done.

## Real editor

The theme repo's `e2e/` `ruby` and `erb` cells (its `e2e/README.md` § Ruby
coverage) run this tree in VS Code 1.144.1 with Shopify.ruby-lsp 0.10.8 and
brew's ruby-lsp 0.26.11, in three modes: `rubylsp` (181 live tokens), `off`
(`semanticHighlighting: false`, no provider) and `builtin` (no client, as in an
editor without it). On 2026-11-08 every Focus, Edit and reopen capture matched
(38 per mode on `usecases.rb`: 14 Focus items, 11 of them with Edit), and every
transition step held: 134 steps in `rubylsp`, `restart` included, and 130 in
`builtin`. A `.erb` template opened as `ruby` without the client kept the
TextMate paint on every character, and Survey on every click and keystroke in
it. What the cell's expectations rest on, from this tree's rules:

- a one-line block holds the caret only between its header and its `}`
  (`blockContainsCaret`), so a click on its `|params|` focuses the enclosing
  scope, whose Focus leaves the block's own names untinted;
- a block local needs two uses to tint, so `{ it * 2 }` tints nothing;
- the shorthand `{ sum: }` tints in its binding's hue, member steel at rest;
- without semantic tokens a global written only in a method stays untinted
  ([Data identities](#data-identities)).

A prototype of the cell on a copy of the harness, before this tree's Ruby
support, counted 3,395 Focus and Edit mismatches.

## Regenerating the token fixtures

```bash
node test/gen-rb-semtok.js samples/sample.rb > test/fixtures/sample.rb.lsp.json
```

`RUBY_LSP=/path/to/ruby-lsp` picks the server (default: the one on `PATH`). It
runs in a temp workspace with no Gemfile, so ruby-lsp composes its bundle there.
The token list in the `name!(` test of `test/ruby.test.js` is the same server's
answer for that test's text.

## Cost

`rubyFacts` runs once per version, after typing pauses. `node test/bench-scale.js
rb --stages` (warm, mean of 5 calls, ms; load average 3 to 5):

| Stage | 2k lines | 10k lines | 50k lines, 0.96 MB |
|---|---|---|---|
| lex | 1.6 | 3.6 | 14.2 |
| `scanBlocks` | 1.0 | 2.6 | 10.7 |
| `rubyFacts` | 2.1 | 8.3 | 42.3 |
| `buildFileIndex` | 1.6 | 5.5 | 22.3 |
| classify the top level | 0.2 | 0.7 | 2.7 |
| heuristic, the top level | 0.2 | 0.5 | 2.7 |

The lex row is from a later run (load average 2.5 to 3.3, median of 3): the
local-variable table ([Lexer](#lexer)) costs a fifth of it, 1.3, 3.1 and 11.6 ms
without the table in the same runs. Lua's `luaFacts` costs 28.4 ms on its
50k-line input in the same run as the other rows. The block
scan's header ends look up identifiers by binary search (`identIndexFrom`);
scanning from the start of the list cost 62 ms at 50k lines.
`test/ruby.test.js` holds `rubyFacts` linear: 8 times the lines cost under 24
times the CPU.

A 50k-line session (`node test/bench-scale.js rb`, ms of synchronous work /
classification): open 53.5 / 49.1, a keystroke 24.8 / 139.7, ten keys 159.2 /
42.7; with no provider (`--no-lsp`) 51.5 / 38.6, 28.7 / 120.0 and 182.4 /
107.4.
