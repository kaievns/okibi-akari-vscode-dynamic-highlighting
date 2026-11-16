# Tooling formats

Shell (`shellscript`: bash, zsh and POSIX sh, VS Code's built-in `source.shell`)
and fish (`fish`, bmalehorn.vscode-fish's `source.fish`; fish-lsp through
ndonfris.fish-lsp) are code languages: keyword-delimited blocks, data identities
by each shell's scoping rule, danger marks and clay numbers. SQL, diffs, rebase
todos and Protobuf are static content. `src/shell.ts` holds both lexers, their
command tables and the bindings; `scanShellBlocks` and `scanFishBlocks` in
`src/focus.ts` the blocks. Tests: `test/shell.test.js`, the shell and fish rows
of `test/lexer.test.js`, the static ids in `test/render.test.js`, and the shell
walks in `test/transitions.test.js`. Counts per measure:
[tooling-measurements.csv](tooling-measurements.csv).

## Ids

What the editor opens, VS Code 1.145.2 with the user's extensions and the e2e
harness's clients:

| Files | Language id | The layer reads it as |
|---|---|---|
| `.sh`, `.bash`, `.zsh`, `.bashrc`, `.zshrc`, `.profile`, `zshenv`, `PKGBUILD`, a `#!…sh` first line | `shellscript` | shell code; a zsh file is zsh by its own syntax ([zsh](#zsh)) |
| `.fish` | `fish` (bmalehorn.vscode-fish 1.0.49) | fish code |
| `.fish` with no fish extension | `shellscript`: the built-in extension lists `.fish` | shell code, read as bash: no fish block is bash's, so a click focuses the whole file, a `for` variable tints and numeric words take clay |
| `.sql` | `sql` | static content |
| `.diff`, `.patch`, `.rej` | `diff` | static content |
| `git-rebase-todo` | `git-rebase` | static content |
| `.proto` | `proto3` (zxh404.vscode-proto3 0.5.5, which wins over vscode-buf) or `proto` (bufbuild.vscode-buf 0.8.19 alone) | static content |
| `buf.yaml`, `buf.gen.yaml`, `buf.lock` | `buf-config` (bufbuild.vscode-buf) | static content |
| `COMMIT_EDITMSG`, `MERGE_MSG` | `git-commit` | prose, as before |
| `.gitignore`, `.dockerignore`, `.npmignore`, `.prettierignore` | `ignore`; `.gitattributes` `properties`; `setup.cfg` `ini`; `Cargo.lock` `toml`; `requirements.txt` `pip-requirements`; `go.mod`, `go.sum`, `go.work` their own ids | static content, as before (`test/fixtures/config-languages.json`) |
| `.ipynb` cells | `python`, `markdown` | per cell, as a `.py` and a `.md` file ([Notebooks](#notebooks)) |

A ```` ```sh ````, ```` ```fish ````, ```` ```sql ````, ```` ```diff ```` or
```` ```proto ```` fence in markdown is prose, as every fence is.

### Static content

SQL's tables and columns are schema, as a GraphQL type's fields are: no value
moves through them. A PL/pgSQL `$$` body is procedural, but such bodies are
7,928 of 461,780 lines (1.7%) of the public SQL corpus (297 files: PostgreSQL's
regression and PL/pgSQL tests, 258; Sakila's eight dialects, 28, without the six
insert-data files over 5 MB; Chinook's 11). A `DELETE` or `UPDATE` without a
`WHERE` is destructive, not trust erosion, so SQL gets no danger mark
([risk-marks.md](risk-marks.md#danger-words)). A diff and a rebase todo hold
another file's text and commit subjects; `drop` in a todo is band 1's to
weigh. buf's language server types a field `property`, a message `struct`, an
enum `enum`, a service `interface` and an rpc `method`, and sends no `variable`
or `parameter`: a Protobuf file has no data identity.

Before they were listed, the default lexer read them as code. On one synthetic
file each, with a click and a keystroke per file through the stub:

| id | `self` / `this` marks in Survey | a click | clay |
|---|---|---|---|
| `sql` | 2, in a `--` comment | the whole file one scope, a 43-line stripe; 24 tints on `id`, `total`, `spent`, `orders` and the keyword `IF` | 13, `42` in a comment included |
| `diff` | 6, in added and removed lines | brace blocks across hunks; `total` and `retries` tinted over the inserted and deleted colours; an async mark on a `+` line's `await` | 15, a hash range and `100644` included |
| `git-rebase` | 5, in commit subjects | a 19-line stripe | 12, the hashes |
| `proto3` | none | Focus on message blocks | 12, the field numbers |
| `buf-config` | none | the default lexer's blocks | its numbers |

Now none of them paints, a click or a keystroke leaves the phase in Survey, and
the layer asks their servers nothing.

## Measurements

The shell reference is shfmt 3.14.1's syntax tree (mvdan/sh), walked by
`test/gen-sh-ref.py`, over the 420 of 446 public files shfmt parses, 84,741 lines:
git's top-level scripts, its `t0*`, `t1*` and `lib-*` tests and `contrib/` (244),
Homebrew's `Library/Homebrew` `.sh` files (45) and 131 of 157 oh-my-zsh files from
`lib/`, `tools/`, `oh-my-zsh.sh` and 128 plugin files (123 zsh and 8 sh; shfmt
parses the other 26 not at all). The fish reference is fish-lsp 1.1.5's `variable`
tokens and `fish_indent --dump-parse-tree` from fish 4.9.3, over fish's 275 own
`share/functions` files, 11,669 lines. The theme README's § Shell, SQL, diffs and
other tooling formats measures its grammars on other cuts of the same projects (872
shell files, 816 of them shfmt's; 277 SQL files, SQLite's tests among them) and on
the same 275 fish files. The runs drive the real `Decorator` under the stub: a
click on the first variable of each block (60 per shell file, 40 per fish file)
and one at the top level, then Focus. A tint is right when shfmt or fish-lsp has a variable at its offset. A
clay mark is right on a numeral the grammar paints as one ([Numbers](#numbers)).

| What (shell, 420 files) | Before | Now |
|---|---|---|
| shfmt's variables at its offsets | none: the identifiers were every word | 14,150 of 14,303; 44 extra |
| heredoc characters read as code | 36,071 of 55,621 | 0 |
| single-quoted characters read as code | 28,531 of 1,178,994 | 0 |
| comment characters read as code | 2,830 of 202,915 | 0 |
| compound commands with shfmt's first and last line | 1,076 of 3,262 | 3,262 of 3,262 |
| function bodies found | 1,004 of 1,051 | 1,051 of 1,051 |
| tints right / wrong, no server (419 files) | 1,968 / 449, 276 of the wrong ones in comments, strings and heredocs | 9,634 / 17 |
| clay on a numeral / elsewhere | 994 / 1,537, 662 in comments and strings | 774 / 0 |
| `self` paint | 50 | 0 |

| What (fish, 275 files) | Before | Now |
|---|---|---|
| fish-lsp's variables at its offsets | none | 6,221 of 6,328; 17 extra |
| blocks | 94, none of them fish's | 1,952 |
| lines striped by a top-level click | 11,580 of 11,669 | 1,205 |
| tints right / wrong, no server | 981 / 431, 132 of the wrong ones in comments | 4,036 / 6 |
| tints right / wrong, fish-lsp's tokens | 3,584 / 0 | 4,036 / 6, the same as with no server |
| clay elsewhere than on a numeral | 665, 119 in comments | 0 |
| `self` paint | 80 | 0 |

The residuals:

- **Shell variables.** Of the 153 shfmt has and the lexer does not, 131 are
  keys of an associative subscript (`$fg[red]`, `_comps[op]=_op`,
  `${commands[git]}`), which zsh reads as text and the walker as arithmetic; 21
  are words of a command inside `$(…)` within arithmetic (`$(( $(test_oid
  rawsz) + 13 ))`), which the walker reads as arithmetic names; 1 is `SHELL=`
  inside zsh's `=( … )` substitution. The 44 extra are variables the walker
  does not reach: zsh's nested `${${…}}`, `integer`'s operands, an offset
  (`${@:OPTIND}`) and names inside zsh's `(flags)`. The 17 wrong tints are 17
  of those 44.
- **fish variables.** Of the 107 fish-lsp has and the lexer does not, 29 sit
  inside single quotes (an `argparse` spec, a regex's `(?<name>…)`), 62 are
  `argparse` option specs (`h/help`, `name=`), which fish-lsp types as the
  `_flag_` variables they create, and 16 are a name before `$` in a dynamic
  name (`_flag_$flag`) or with a `-` (`$maincmd-$args`). The 17 extra are names
  fish-lsp does not type: `set $scope name`'s name, `set opt -uno`, `read
  -P"…" name`. The 6 wrong tints are real variables fish-lsp types otherwise:
  `set $scope fish_key_bindings`'s name, `$maincmd-…`, `$ahead-…`, `$arg-128`
  and `function $funcname`'s read.
- **fish blocks.** `fish_indent`'s dump leaves out what sits inside a command
  substitution (`(if …; end)`) and fish 4's `{ … }`; the scan finds them, so it
  has 28 more blocks than the dump's 1,924.

The lex and the block scan take 70 ms over the 84,741 shell lines;
`test/shell.test.js` checks that both lexers and block scans grow linearly.

## Shell lexer

| Form | Region |
|---|---|
| `#` at a word start (after a blank, `;`, `&`, `\|`, `(` or `)`), to the line end | comment; `a#b` is a word |
| `'…'` | string, no escapes, multi-line |
| `$'…'` | string, `\` escapes |
| `"…"`, `$"…"` | string, `\` escapes; `$name`, `${…}`, `$(…)`, `$((…))` and `` `…` `` are holes |
| `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD` | the body, from the next line through the terminator line, is a string; holes only when no part of the delimiter is quoted; `<<-` strips tabs before the terminator; several on one line are read in order |
| `` `…` `` | code, closed by the first unescaped backtick, a quote's inside included |
| `$(…)`, `<(…)`, `>(…)` | code: a command list of their own |
| `$((…))`, `((…))`, `for ((…))`, `$[…]`, `let` operands, subscripts | arithmetic: bare names are variables |

**Identifiers are variable names**, never a command or a word, so nothing
else can take a tint. A name in `$name` or `${name…}` (the name only, never
its `$`); an assignment's name at command position (`x=1`, `a[i]+=2`,
`arr=(…)`); an operand of `local`, `declare`, `typeset`, `integer`, `float`,
`readonly` and `export`; a `for`, `select` or `foreach` name; an operand of
`read`, `mapfile` and `readarray` (option values skipped), `unset`,
`getopts`'s second and `printf -v`'s; a bare name in arithmetic, unless it is
the subscript of an associative array (`declare -A`, zsh's own).

**Command position.** A word is a reserved word (`if` `then` `elif` `else`
`fi` `for` `select` `while` `until` `do` `done` `case` `esac` `function` `{`
`}` `[[` `!` `time`, zsh's `repeat` and `foreach … end`) only where a command
may start: after a line break, `;`, `&`, `&&`, `||`, `|`, `(`, a case arm's
`)`, `then`, `do`, `else`, `{` or an assignment. So `echo done` and
`x="for y in z; do"` open and close nothing. `name()` and `function name`
define a function. A case pattern's `)` is the arm's, not a subshell's.

**The command table** (`shellTables(lx).commands`) holds each simple command's
name, whether it follows `|` or `|&`, and its first 8 words ('' when not
literal text) with the offset each starts at, which the danger rule reads a
`-c` string's opening hole from. A prefix assignment (`LC_ALL=C sort`) is set for the one
command, so it writes nothing (`ShellVar.env`).

### Numbers

Clay goes where `source.shell` paints a numeral, measured with the theme's
grammars and injections through `scripts/vscode_app.js`:

| Paints a numeral | Does not |
|---|---|
| arithmetic: `$((x + 1))`, `(( i < 6 ))`, `for ((i=0; …))`, `let j=7` | a `${…}` subscript or offset (`${a[0]}`, `${s:1:2}`): the whole expansion is the placeholder |
| a numeric argument: `sleep 5`, `exit 0`, `head -n 5`, `1.5`, `0x1f`, `2#101` | an option (`-9`), `+4`, a descriptor (`2>`, `3>&1`) |
| a numeric word in `[[ … ]]` | a case pattern, a `for … in` word |
| a declaration's value, `local n=3`, `export N=6` | a plain assignment's value, `retries=3`: the page colour |
| an array element, `arr=(1 2)` | an assignment's subscript, `arr[1]=x` |

### zsh

VS Code opens a `.zsh` file as `shellscript`, and the lexer sees no file name.
The text is zsh when its first line is a zsh shebang, a line starts with a
zsh-only builtin (`setopt`, `autoload`, `zstyle`, `zmodload`, `compdef`,
`bindkey`, `emulate`, `zle`, `zparseopts`, `typeset -g…`), or it holds
`${(flags)…}`, `$+name` or `${+name}`, a `:h` / `:t` / `:gs/…/` modifier or a
`[(r)…]` subscript flag. Then `${(f)x}` flags, `${x:h}` modifiers, `:#` `:|`
`:*` `:^` operators and a subscript's `(flags)` are zsh's, `$#name` and
`$+name` read `name`, a `}` closes a group wherever a word stands, `function a
b {` names several functions, and zsh's associative arrays (`commands`,
`functions`, `fg`, …) take keys. In bash `${s:i:1}` reads `i`.

## Fish lexer

| Form | Region |
|---|---|
| `#` at a word start | comment |
| `'…'` | string; only `\'` and `\\` escape |
| `"…"` | string; `$name`, `$name[…]` and `$(…)` are holes |
| `(…)`, `$(…)` | code, a command list of their own |

Identifiers are variable names: `$name` and `$$name`'s `name`; `set`'s name
(`set -l x`, `set x[1] v`, `set name[$i] v`); `read`'s operands; a `for` name;
`function`'s `--argument-names` / `-a` and `--inherit-variable` / `-V`
operands; a prefix assignment's (`A=1 cmd`, set for the one command). Numbers
are numeric words (`set n 3`, `return 1`, `1.5`) and an index's digits
(`$argv[2..-1]`), where bmalehorn's grammar and the theme paint numerals; a
redirection's file descriptor (`>&2`, `2>&1`, `<&0`) is not one, since the grammar
paints it with its redirection (the theme's e2e fish cell found clay on `>&2`'s `2`).

## Blocks

| Field | Shell | fish |
|---|---|---|
| a block | a function's `{ … }` or `( … )` body; a brace group; a subshell; each `if` / `elif` / `else` branch; a `for`, `select`, `while`, `until` or `repeat` body; zsh's `foreach … end`; a `case` and each arm | `function`, `if`, `for`, `while`, `switch`, `begin` and `{ … }`, each to its `end` or `}`; `else`, `else if` and each `case` a sibling |
| `headerStart` | the keyword; a function's name or `function` | the keyword |
| `openOffset` | the `{` or `(`; past `then`, `do`, `else`, `in`; past an arm's `)` | where the header command ends: its `;` or line break |
| `closeOffset` | the `}` or `)`; the last letter of `fi`, `done`, `esac`, `end`; the last code character before `elif` / `else` / the next pattern; an arm's `;;`, `;&` or `;;&` | the `d` of `end`; the last code character before `else` / `case` |

A function's scope runs from its header, so fish's `--argument-names` belong to
it. An opener without its closer makes no block. A keyword in a string, a
comment, a heredoc or as an argument opens nothing.

## Bindings

**bash and zsh** (`shellFacts`): inside a function, an operand of `local`,
`declare`, `typeset`, `integer` or `float` without `-g` declares the
function's own variable, wherever in the function it stands (a brace group
scopes nothing). Every other write in a function — an assignment, `for`,
`read`, `export`, `readonly`, `declare -g`, arithmetic — writes a global, by
bash's rule, so it declares nothing there: the heuristic gives such a name one
top-level declaration (offset -1), and it paints bold. Outside every function,
each write declares. Dynamic scope is not followed: a function reading a
caller's `local` reads a global to the layer.

**fish**: `set -l`, `set -f`, `for`, `--argument-names` and `--inherit-variable`
declare the function's own; a plain `set` or `read` of a name the function has
not declared makes it the function's, unless the file makes the name global
(`set -g`, `set -U`, or a plain write outside every function), as
`fish -c` shows. `set -g` and `set -U` in a function write a global. `set -l`
in a block is the function's to the layer, though fish ends it with the block.

**Data** is every occurrence of a name the file writes. A name it never writes
is the shell's or the environment's (`$HOME`, `$OPTARG`, `$BASH_REMATCH`,
fish's `$status`), and is no identity. `$1`, `$@` and fish's `$argv` never are.
A variable named `self` is data: neither shell has a receiver.

## Classification

bash-language-server 5.8.1 registers no semantic-token provider, so shell
classifies on the heuristic path alone. fish-lsp 1.1.5 types a declaration and
a use alike (`variable` with `local` or `global`, no `declaration`), and some
names inside single quotes. `shellTokens` replaces any server's tokens with the
bindings' variables, so both paths classify the same names the same way, and
an answer arriving changes no tint.

## Band 1

Neither shell has a receiver keyword: a `self` or `this` is a word, a case
glob, heredoc text or a variable, and takes no paint.

Outside quotes the editor's bracket-pair colorization paints the braces of a
`${…}` and the parentheses of a `$(…)`, a `$((…))` and fish's `(…)` its grey
over the theme's member steel (the e2e shell cell's dump: `{=bracket`,
`(=bracket`). The theme registers that grey for the braces, as in a `.env` file,
a Dockerfile and CMake, and a Makefile's `$(CC)` takes it on its parentheses
(the theme's README § Shell and § C, C++, Java, Kotlin and their build files). A
restore painting them member steel would split shell from those formats, so
there is none.

## Band 3

Danger marks a command that runs code from somewhere else as this script: the
command word `eval`; a shell that reads its script from a pipe (`curl … | sh`,
`| bash -s -- --yes`: a `sh`, `bash`, `zsh`, `dash`, `ksh`, `mksh`, `ash` or
`fish` after `|` with no operand before `-s` and no `-c`, an `-o` option's value
skipped); a shell whose first operand is a process substitution (`bash <(curl
…)`, fish `bash (curl … | psub)`) or whose `-c` string is a `$(curl …)` or
`$(wget …)` hole (`sh -c "$(curl -fsSL …)"`, fish `sh -c (curl …)`); `source` or
`.` of `/dev/stdin` or a process substitution (`source <(kubectl completion
bash)`); fish's `eval` and `… | source`. Each holds behind `sudo`, `doas`, `env`
(its options and `NAME=value` words skipped), `command` (not `command -v`),
`exec`, `nohup` and `time`: `curl … | sudo -E bash -` marks `bash`. Not `rm -rf`
or `sudo` itself: destructive, not trust erosion. Not `eval` as an argument or in
a string, a shell given a script file, a process substitution as a later
argument (`bash x.sh <(…)`), a `-c` string that does not start with the fetch.
Over the 420 shell files, shfmt's command words hold 49 `eval` in 23 files, 26
`rm -rf` in 22 and 17 `sudo`; no fetched script runs as a command. The corpora's
9 `sh -c "$(curl …)"` and `"$(wget …)"` (oh-my-zsh's install line) and 1 `curl
… | sudo sh` are in comments and READMEs, so the marks over the 446 shell and
275 fish files are the same with the wrapper and substitution forms as without:
55 `eval` and 1 `source` in shell, 9 `eval` and 4 `source` in fish.

No async marks: neither shell has the keyword, so a variable named `async` is
data.

No escape marks. By bash's rule a write to a non-local inside a function is a
global write, but which binding it reaches depends on the caller's `local`s at
run time. No oracle runs each corpus function to check a claim yet, so the
layer makes none, on either path.

## Notebooks

Each cell is a document of its own (`vscode-notebook-cell:`), classified as a
`.py` or `.md` file. Pylance answers per cell and resolves names across cells
(`df:variable`, `pd:module`): its 1,281 tokens over 5 public notebooks' 195 code
cells (the theme README's § Jupyter notebooks) equal those of their `.py` twins in
position and type, and 45 of them add a `declaration` or `library` modifier the
twin lacks. A cell added, removed or moved, or another cell's text, changes what a
cell's names resolve to with no edit to that cell: `Decorator.onNotebookChanged`
drops every other cell's answers and plans and classifies the active cell again.
An output, an execution summary or metadata changes no cell's text, and nothing
happens.

Without Pylance, the import and shadow restores and the heuristic read one
cell at a time: an `import pandas as pd` in cell 0 restores no `pd` in cell 2,
and a `df` assigned in cell 0 is no data in cell 2. Reading the notebook's code
cells as one view is not built.

## In the editor

The theme's e2e cells (its `e2e/README.md` § Shell, SQL, diffs and other tooling
formats coverage), VS Code 1.145.2, Okibi and Akari, this tree and the theme's:

- **Shell** (`shellscript`, with bash-ide and without): after a click in the
  `while` loop `attempt`, `host`, `ROOT`, `f` and `count` carry tints; a name the
  loop reads once (`timeout`, `retries`) carries none, by the ≥2-use floor. Edit
  marks `eval`, the `sh` a pipe feeds and `source <(…)` in `cleanup` and nothing
  else. A variable rests at member steel, the theme's register for an expansion;
  the harness reads a `$name`, a `${name}`'s bare name and an arithmetic name the
  survey expects as a placeholder as a hole that reads its binding, so every tint
  lands on data. Every transition scenario holds, `restart` by stopping
  bash-language-server included.
- **fish** (bmalehorn alone, bmalehorn with ndonfris.fish-lsp): a click in
  `deploy_host`'s `while` loop tints `attempt`, `host` and `retries`, and `$HOME`
  and `$argv` stay untinted; Edit marks `eval` and the `sh` a pipe feeds in
  `cleanup` and nothing else; the tints on `$name` at member steel. With fish-lsp,
  `set -l host` rests at member steel too: the theme's `variable:fish` key paints a
  declaration and a use alike, and the harness reads the survey's `known` entry
  there as data. Its Focus check found clay on the `2` of `>&2`, which the lexer
  read as a numeral ([Fish lexer](#fish-lexer)).
- **SQL, a diff, a commit message, a rebase todo, go.mod, a requirements file,
  Protobuf** (`proto3` under zxh404, `proto` under vscode-buf alone): no failure in
  either theme; a click and a keystroke never enter Focus.
- **A notebook** (Pylance and none): each cell's paint, a click and a keystroke
  in one cell leaving every other cell's paint as it was, and a cell inserted,
  deleted, moved and run against fresh renders ([Notebooks](#notebooks)).

## Language servers

| Server | What it sends |
|---|---|
| bash-language-server 5.8.1 (brew), through mads-hartmann.bash-ide-vscode 1.43.2 | no semantic tokens (`semanticTokens/full` answers -32601); document symbols; shellcheck 0.11.0's diagnostics, 3 on `walk.sh` (SC2029, SC2012, SC2329); formatting through shfmt when it is on `PATH` |
| fish-lsp 1.1.5 (brew), through ndonfris.fish-lsp 0.1.25 | `function`, `variable` (`local`, `global`), `keyword`, `number`, `operator`, `decorator` (the shebang), `string`, `event`; 97 tokens on `walk.fish` |
| buf 1.75.0 (brew), through bufbuild.vscode-buf 0.8.19 | Protobuf tokens for `proto` only; with zxh404.vscode-proto3 installed `.proto` opens as `proto3` and buf's server never starts |
| gopls 0.23.0 and 0.24.0 | a provider for `go.mod`, `go.sum` and `go.work` that answers `data: []` |

## Regenerating the fixtures

```bash
python3 -I test/gen-sh-ref.py bash test/fixtures/shell/constructs.sh > test/fixtures/shell/constructs.sh.ref.json
python3 -I test/gen-sh-ref.py bash test/fixtures/transitions/walk.sh > test/fixtures/shell/walk.sh.ref.json
node test/gen-fish-semtok.js test/fixtures/transitions/walk.fish > test/fixtures/shell/walk.fish.lsp.json
```

`gen-sh-ref.py` needs shfmt on `PATH`, `gen-fish-semtok.js` fish-lsp. shfmt's
zsh mode does not parse `walk.zsh` (`for k v in`), so its variables are listed
in the test.
