# Runtime and LSP lifecycle

What the decorator does between a keystroke and a paint: how it asks the
language server, what it does when the server is slow, cold or answers for old
text, which documents and editors it paints, and which edits count as typing.
Tests: `test/runtime.test.js`, and `test/transitions.test.js` for the
[transitions](#transitions) between all of these. Classification rules live in
[classification-rules.md](classification-rules.md).

## One fetch per document version

`Classifier.bundleFor` asks for document symbols, the semantic-token legend and
the semantic tokens in parallel, once per version. The answer (the bundle) feeds
every block classified in that version, so caret moves in an unedited file cost
no server calls.

| Situation | What happens |
|---|---|
| A second classify of the same version starts while the fetch is in flight | It awaits the same promise. Fast caret moves under a 300 ms server send 1 request, not 1 per block. |
| The caller is cancelled (the caret moved on) | The fetch still completes and is cached; only that caller drops its result. |
| A second classify of the same block and version starts while one is in flight | It awaits that one (`Decorator.classifying`) instead of cancelling it. The constructor's refresh and `onSelection` schedule a 60 ms classify of the block a caller is already awaiting; when the first took longer than 60 ms, the second cancelled it before it cached its plan, and the caller's render painted nothing (`test/javascript.test.js`'s `bare and destructured arrow parameters` failed under load, 3 times on record, each run 77 to 97 ms long. Fired at each of the test's first 7 event-loop turns instead of after 60 ms, the timer failed it at HEAD in turns 0 to 2 and never with the join, at any of 21 turns; 89 loaded runs of the file with the join passed). A cold-server retry drops the record and asks again. |
| The document changed before the answer arrived | The bundle is returned uncached, stamped with the version it was asked for. `classifyScope` returns null, so nothing paints. The tokens are not decoded: `answerStateOf` reads from the raw data whether the answer had any, and in Rust the path keywords; in Lua `typesStringLiterals` reads whether it typed string literals. That is all such an answer is used for. If a newer version has already been answered, the old answer also leaves `semanticOk`, the path keywords and the string-literal state as that answer set them. |
| A keystroke is waiting when the answer arrives | Before the whole-file work (`buildFileIndex` with tokens, the heuristic's file-wide base without) the classifier yields one turn of the event loop (`setImmediate`), so the edit runs first and the version check then skips that work. A classification overtaken this way does not paint; the stale-hold keeps the tints on screen until the next one. |
| An edit lands | `onEdit` cancels the classify in flight. In any painted document, active or not, it drops the bundle and what else belongs to the old version ([Memory](#memory)). The next classify fetches for the new version. |

`classifyScope` takes the version together with the text (`docStateFor` caches
both) and stamps every classification with it. Reading `doc.version` after the
await stamped old-text offsets with the new version: tints landed mid-word and
inside the comment just typed, and stayed until the next edit.

The request is for the whole document. VS Code asks the same provider for
tokens (as deltas) to render them, so each version costs the server a second
full request. For TypeScript that second request is cheap, because the language
service has already checked the version for the first:

| Generated TS input | First request for a new version | Second request, same version |
|---|---|---|
| 10k lines, 279 KB | 224 ms | 24 ms |
| 50k lines, 1394 KB | 731 ms | 151 ms |

Measured with the `typescript` package's `getEncodedSemanticClassifications`
(the call behind VS Code's TS provider) on the `test/perf-inputs.js` inputs, one
inserted newline per version, median of 5, Apple M3 Pro, Node 26.8.2. Other
servers are not measured. A range request would not help: the classifier needs
every occurrence in the file for traces, globals and shadowing. The legend is not
cached per language: fetched in parallel with the tokens it adds no round trip,
and a cached legend could belong to a different provider.

VS Code answers the legend command and the tokens command from possibly
different providers when two share a document. `tokensFitLegend` rejects data
whose type index or modifier bits fall outside the legend; that answer counts as
empty.

## Cold servers

After a window reload rust-analyzer, Pylance and gopls take seconds to register
and index. Each answer is one of three states (`SemanticState`):

| State | Meaning | Band 2 |
|---|---|---|
| `ok` | tokens arrived | the semantic plan paints |
| `empty` | a provider is registered (legend present) but sent no usable tokens | holds: semantic tints already on screen for the same block stay, anything else comes off, nothing new paints |
| `none` | no provider registered (no legend) | the heuristic plan paints |

An `empty` or `none` answer starts a retry chain for the active document:
1 s, 2 s, 4 s, 8 s, 15 s (`Classifier.retrySchedule`, about 30 s in all). So
does a Rust `ok` answer whose path keywords are `degraded`
([Rust path keywords](#rust-path-keywords)): a cargo package sends it until its
workspace loads, and band 2 paints it meanwhile. Each retry drops the bundle and
that version's plans, then classifies again, with no edit needed. The chain
stops at the first `ok` answer that is not degraded. The count is per document,
not per version: once the schedule is spent, a language with no provider, or a
detached Rust file, costs one fetch per version and nothing more. An `ok` answer
that is not degraded resets the count, so a server restart later in the session
gets a fresh schedule.

When a document spends its whole schedule on `none`, its language goes on a
provider-less list for the session. Later documents of that language get no
retries: of 10 shell scripts opened in turn, the first spends its schedule
(6 fetches) and the other 9 cost 1 each, 15 in all instead of 60. Any answer
with a legend takes the language off the list.

The `empty` hold lasts while retries remain. When the schedule runs out with
the provider still silent, the heuristic plan paints. The hold keeps only
tints that came from semantic tokens: a heuristic plan painted during `none`,
before the provider registered, comes off at the first `empty` answer instead
of standing in for the server while it indexes. Mid-typing, an `empty` answer
for the new version keeps the previous version's semantic tints.

A request the provider rejects as cancelled (`Canceled`) is no answer of any state:
cpptools rejects a waiting request when another for the file arrives, the editor's
own included. The fetch stays in flight and asks again after 1.5 s, 3 s and 6 s
(`Classifier.cancelRetrySchedule`) while the document version holds, with no hold and
no cold retry; only a provider still cancelling after 10.5 s answers `empty`
([c-jvm.md](c-jvm.md#server-shapes)).

A C or C++ answer with tokens is provisional: cpptools answers a version with its
first IntelliSense batch and adds the rest without a request. It is asked again
after 250 ms, 500 ms, 500 ms, 1 s, 1 s and 2 s (`Classifier.confirmSchedule`) until
two answers in a row carry the same data, with no hold; an answer that differs
from the last starts the waits again, at most 12 requests a version. Band 2 paints
each answer as it comes, and the confirms spend no cold retry.

`none` is not held, because it also means "this language has no provider", and
holding would leave such a file blank for 30 s. The cost is a heuristic paint
between a language extension activating and its server registering the
provider (that window is not measured), and only if the document is engaged
inside it.

The band-1 import and shadow restores read the same answers through
`Classifier.semanticOk(doc)`: they paint until a provider answers the document
with tokens (`ok`) and come off then, in a render of their own when band 2
discards that classification. Later `empty` answers and edits leave them
off; a `none` answer, no provider registered at all, brings them back. Rules:
[import-restore.md](import-restore.md#handover). Lua's two restores paint in
every state: the module colour is wrong under lua-language-server's tokens, and
the shadow restore agrees with them ([lua.md](lua.md#band-1-restores)).

lua-language-server with `Lua.semantic.enable: false` keeps its provider
registered and answers every document `empty`, so each new Lua document holds
band 2 through the whole schedule before the heuristic paints
([lua.md](lua.md#server-states)).

Ruby's shadow restore paints in every state as well: ruby-lsp leaves
declarations and writes without a token, and its reads agree with it. ruby-lsp
answers a file over 100,000 characters with no tokens, so such a file holds
band 2 through the schedule, then gets the heuristic and no escape marks
([ruby.md](ruby.md#server-states)).

## Rust path keywords

rust-analyzer 0.3.3105 types `Self`, `crate` and `super` by layout
(`test/fixtures/rust-paths.tokens.json`, captured with `test/gen-rs-semtok.js`):

| Layout | `Self` | `crate`, `super` |
|---|---|---|
| a `.rs` file outside any cargo package (detached) | `struct` | `namespace` |
| a cargo package, the first reply, before the workspace loads | `struct` | `namespace` |
| a cargo package, loaded | `selfTypeKeyword` | `keyword` |

The theme paints `struct` and `namespace` type slate over the grammar's keyword
grey. The first cargo reply is identical to the detached one, token for token. In
the capture it came 20 ms after `didOpen`, then an empty reply at 475 ms and the
loaded one at 1.5 s (the standalone server, not measured inside the editor). So
the tokens cannot tell a detached file from a package still loading, and both
need the restore.

`Classifier.pathKeywordsOf(doc)` records what the answer for the newest version
answered typed them as:
`degraded` when any of the three is not `keyword`, `selfKeyword` or
`selfTypeKeyword`, otherwise `keyword`. An answer that types none of them leaves
it unchanged; a `none` answer clears it. Unless it is `keyword`, the decorator
adds every code `Self`, `crate` and `super` to the `self` mark, keyword colour at
normal weight. Before the first answer and after a `none` the paint is a no-op
over the grammar, and it covers the gap between VS Code painting the first
degraded reply and the layer's own fetch answering. A change of state repaints
band 1 even when band 2 discards that classification.

A degraded answer starts the [cold-server](#cold-servers) retry chain, so a
cargo file opened while its workspace loads is asked again with no edit, and
the loaded answer replaces the degraded one for band 1 and band 2 alike. Before,
the open-time answer stayed until the first edit: in the theme repo's
real-editor focus run with no edit step, `MAX_RETRIES` read as `struct` in a
struct literal and lost its bold trace, in 2 of 2 runs; with the retry the same
run passes every focus item.

Limits: the state follows the layer's own fetches. If rust-analyzer restarts
and sends degraded tokens again with no edit, `Self` reads type slate until the
next edit's answer. A workspace that loads more than about 30 s after the file
opened, and a file with no `Self`, `crate` or `super` in code (its degraded
answer cannot be told from a loaded one), keep the open-time answer until the
first edit. A detached file spends the schedule: 5 extra fetches in its first
30 s.

## Cache keys name the document object

`Decorator.cacheKey` is `uri#instance::version::focusKey`, where `instance`
numbers each `TextDocument` object. See
[classification-rules.md](classification-rules.md#the-classification-cache-key-names-the-document-object).

## Which documents are painted

Only documents with a source URI scheme: `file`, `untitled`, `vscode-remote`,
`vscode-vfs`, `vscode-notebook-cell` (`isDecoratable`). Every other editor is
ignored by `onSelection`, `onEdit`, `runClassify` and render: Output and debug
channels, the SCM commit box, comment inputs, search editors, and `git:` diff
sides.

The Output channel is the case that forced this. With `okibiDynamic.debug` on,
every debug line is an edit of the channel's own document. Painting it fed
itself: render, log, edit, render. In the stub that ran over 5,000 lines without
yielding.

A notebook's cells are documents of their own, painted as their language's
files; which notebook change drops which cell's answers is in
[tooling.md](tooling.md#notebooks).

When the active editor is not a source document, or there is none (a webview,
a preview, the settings UI), render withdraws bands 2 and 3 and the gutter from
every visible editor at once. `refresh()` schedules that render; it used to wait
for the next relaxation, up to 24 s.

## Which editors are painted

| Marks | Editors |
|---|---|
| Band 1: `self` / `this`, Rust `Self` / `crate` / `super`, C-family `NULL` / `true` / `false` / `bool`, Kotlin `$name` templates, Rust format placeholders, Python f-string fields, Ruby `#{` / `}`, Go doc links, brackets in Rust comments and strings, markdown washes, the Lua module and shadow restores, the Ruby shadow restore | every visible source editor |
| Band 1: Lua and Zig format placeholders | every visible source editor, while the document's last answer types its string literals ([lua.md](lua.md#band-1-restores), [zig.md](zig.md#band-1-restores)) |
| Band 1: the import restore (Python, Go, Zig), the shadow restore (Python) | every visible source editor, until a provider answers for the document |
| Gutter, band 2, clay numbers, band 3 | the active editor only |

In an HTML document every mark lands inside a script, and in a Vue, Svelte or
Astro component inside a code region: the markup is blanked before any scanner
reads it ([html.md](html.md#the-script-view),
[components.md](components.md#the-code-view)).

An edit repaints band 1 in every visible editor showing the document, the active
one or not: a rename, a formatter or a reload can change the text of a split
that does not have focus.

The dirty-check is per editor and per decoration type, and an edit that moves a
type's ranges voids its record ([Decorations move with
edits](#decorations-move-with-edits)). A theme flip rebuilds the decoration types
and repaints band 1 everywhere. No `okibiDynamic` setting changes a colour, so a
setting change does not rebuild them.

## Decorations move with edits

VS Code moves every decoration with the text it covers, in every editor of the
document, before the extension hears of the edit. The rule is the editor's
interval tree (`nodeAcceptEdit` in VS Code's source; the minified copy in
`workbench.desktop.main.js`, VS Code 1.144.1, has the same steps), with each
type's `rangeBehavior` as the stickiness at its edges
(`OpenOpen` when unset). A range whose text is deleted collapses to a point, and
typing the text back does not grow it again.

The stickiness holds only for an edit applied without `forceMoveMarkers`, a flag
of the edit, not of the decoration. With it, a range edge at the start of a
change that inserts text moves past the inserted text whatever the stickiness, so
a mark ending where a quick fix appends `._x` grows over `._x`. In the 1.144.1
bundle these edits set it: formatting (`formatEditsCommand` uses `replaceMove`
unless one edit replaces the whole model), workspace edits (rename, code actions,
an extension's `applyEdit`), completion's `additionalTextEdits`, reindenting, a
model reloaded from disk (`_computeEdits`), comment toggling and the inserts of
`TextEditorEdit.insert`. Typing, paste, deletes and Enter run as cursor commands
and apply without it, and so do undo and redo.

The change event does not carry the flag. `markMoved` takes an undo or redo
(the event's `reason`) as unforced, and any other change as forced unless it
touches a caret of the active editor, with the selections read from before or
after the edit (`mayForceMove`). Inside the save window every change counts as
forced. Taking every edit as forced would also be safe, but typing a `.` or `,`
right after a marked name would then re-send that type's ranges, all of them in
the file, on every such key. A forced edit that touches a caret is still read as
unforced ([Limits](#limits)).

The dirty-check used to compare new ranges with the ranges last sent. After a
delete and an undo with no repaint between them (the stale-hold keeps band 2
until the new classification, the typing debounce plus the server), the new plan
equalled the one sent before the delete, nothing was re-sent, and the restored code stayed
without its tints. `markMoved` now marks a type's record when an edit moves any
of its ranges on screen, and a marked record never skips the next apply.
`rangesMovedBy` (`src/tracking.ts`) answers in positions: exactly outside the
replaced text and at an insertion point, given whether the edit is taken as
forced, and true for anything inside the replaced text. Mostly, when an edit
moves a range, the recomputed range has moved too and its key differs anyway, so
`markMoved` adds a call only where the screen moved and the plan did not: a
range collapsed by a delete and restored by an undo, a mark grown by a forced
insert, and an edit taken as forced that was not. It also lets the escape marks' stale-hold keep its record, which the
hold used to drop so that the repaint after typing always re-sent: a
reclassify now re-sends the marks only when an edit moved them
(`test/escape.test.js`). In the
`test/perf-golden.test.js` edit sessions that took the `setDecorations` count
from 58 to 78 calls per session to 36 to 58, and one call off each `render`
session; nothing they paint changed.

The check costs 0.02 to 0.36 ms per keystroke on the 50k-line `test/perf-inputs.js`
inputs, with 2,001 (Go) to 16,876 (Python) ranges on screen, median of 50, at a
load average near 70 on an Apple M3 Pro with Node 26.8.2. A keystroke at that
size costs 8 to 22 ms of CPU at a typing pace, and 73 to 136 ms when a full
classification follows it ([Cost on large files](#cost-on-large-files)).
`test/transitions.test.js` checks `rangesMovedBy` against the harness's port of
the editor's rule on 20,000 random edits, half of them taken as forced: wherever
it answers false, the editor leaves the range in place, and for an edit taken as
forced it does so with and without `forceMoveMarkers`.

## Gutter stripe

The stripe is one decoration range per run of consecutive lines: one range for a
block, and one per stretch of top-level code for the module scope. Each run
starts at column 0 of its first line and ends at the end of its last line.

VS Code draws a glyph-margin icon on every line a decoration's range covers. In
VS Code 1.144.1 (`workbench.desktop.main.js`), `gutterIconPath` becomes the
decoration's `glyphMarginClassName`, and
`_collectDecorationBasedGlyphRenderRequest` loops from the range's
`startLineNumber` to its `endLineNumber`, clipped to the viewport, adding one
render request per line. The range is in view coordinates, so with word wrap on
the wrapped rows of a covered line get the stripe too. One zero-width range per
line, the earlier shape, put it on the first row of a wrapped line only. Ending
each run at its last line's end keeps that line's wrapped rows covered.

At the top level of the 50k-line inputs the stripe went from one range per line
to one per run: TS 19823 → 2619, Go 13945 → 1993, Rust 14665 → 3761, Python
18705 → 3341. `test/perf-golden.test.js` compares the stripe as the set of lines
it covers, so both shapes count as the same output.

## Typing versus other edits

Only typing engages a document and enters Edit. An edit counts as typing when
every change touches a line a cursor is on (`isTypingEdit`). A change covers the
lines it replaced and the lines its new text occupies, so the check holds
whether `editor.selections` reads from before or after the edit when
`onDidChangeTextDocument` fires; which one VS Code delivers is not verified.
Edits between `onWillSaveTextDocument` and `onDidSaveTextDocument`
never count, which covers format on save and code actions on save. The save
window also closes after 5 s, because a failed save fires no `onDidSave`.

| Edit | Typing? |
|---|---|
| keystroke, paste, backspace, multi-cursor typing | yes |
| rename, organise imports, find-and-replace across the file | no |
| completion that also adds an import | no (the import line has no cursor) |
| format on save | no |

Every edit still invalidates and reclassifies, so band 2 follows the new text.

## Tokens inside comments

`buildFileIndex` drops every token that starts in a lexer comment or doc span,
and every token carrying `injected`, `documentation` or `intraDocLink`.
rust-analyzer types doctest code inside `///` as `variable declaration,injected`,
and gopls types `[Name]` doc links in `//` comments as plain `variable`. Both
used to tint as data. Rust inline format args (`{x}` in `println!`) sit in a
string span and stay data.

## Go doc links

gopls emits `variable [readonly number]`, `namespace` and `function [signature]`
for `[Name]`, `[pkg.Name]` and `[*pkg.Name]` in any comment, with no modifier
that marks them as comment text, and vscode-go offers no switch for them alone.
The theme therefore paints them as code. `goDocLinkSpans` (`src/doclinks.ts`)
finds the name inside every bracketed link in a comment, and the decorator
paints it in the theme's comment colour, italic (Okibi `#646a70`, Akari
`#8b857d`). It is band 1: Go only, every phase, cached per version, and it
needs no server.

## Brackets in Rust comments and strings

Bracket-pair colorization skips brackets in comment and string tokens, except
after one sequence: close a Rust file's last tab, change the colour theme, reopen
the file. The theme repo's real-editor `theme-closed` scenario measured it in VS
Code 1.144.1, in a cargo workspace and a loose file, both themes, with only the
built-in Rust grammar and with semantic highlighting off. Every `( ) [ ] { }` on
screen inside a comment (`//`, `///`, `//!`, `/* */`), a string or a char literal
took `bracket-highlighting-N` and painted its level colour (Okibi `#707376`,
Akari `#8d8982`), or the unexpected-bracket red for an unbalanced one such as
`'('`. It lasted until the theme changed again with the file on screen. Go, with
a `[Name]` doc link in a comment on screen, did not show it.

The editor serves brackets from `initialAstWithoutTokens`, an AST parsed before
the tokens were complete, until background tokenization reports Completed
(`BracketPairsTree` in `workbench.desktop.main.js`). That the sequence above
leaves it in place is inferred, not traced.

Two band-1 marks paint the brackets back with decorations, whose colour is
`!important` and outranks the level class. Each paints only characters that
rest in its colour, so it changes nothing on a healthy render. Both are Rust
only, every phase, cached per version, need no server, and rerun on every
keystroke's version, like the placeholder scan.

- **Comments.** `commentBracketSpans` (`src/doclinks.ts`) lists every bracket in
  a lexer comment or doc span, painted with the Go doc links' comment-colour
  decoration.
- **Strings.** `rustStringBracketSpans` (`src/placeholders.ts`) lists the
  brackets in string and char literals, painted in the theme's string colour
  (`TOKENS.string`: Okibi `#8ecd92`, Akari `#257231`). The colour at rest comes
  from three layers, and the scan follows them:

  | Bracket | At rest | Painted |
  |---|---|---|
  | a format-string hole, `{}` `{x:?}` | the placeholder mark | no, the placeholder mark holds it |
  | in a raw string or a char literal | string | yes |
  | inside a `{…}` the grammar scopes `meta.interpolation.rust` (`"{c}"`), no server | placeholder steel, the grammar's | no |
  | the same, a provider answered | string: rust-analyzer's `string` token covers it | yes |
  | the same, on an escape: `{{` / `}}` in a format string, a unicode escape the grammar does not read (`b"\u{41}"`) | the grammar's, through an `escapeSequence` or `invalidEscapeSequence` token with no theme style, or string before the workspace loads | no |
  | any other | string | yes |

  The grammar rule is `({)[^"{}]*(})` on one line after the escapes. The
  base escape rule reads `\u{…}` only with 4 to 6 hex digits (rust-syntax
  0.6.1; the built-in grammar differs only in the digits of `\x`). The theme
  repo's `syntaxes/rs-strings.injection.json` reopens every string with no `b`
  prefix and reads Rust's own unicode escape there first, 1 to 6 hex digits each
  followed by any `_`, so the braces of `\u{41}` rest string green and are
  painted; a byte string keeps the base rule. With both, `theme-closed` renders
  the braces of `\u{41}` as a fresh render does in every step, cargo and loose,
  Okibi and Akari (2026-11-07).
  The rows with a provider were checked against the rest paint of the lines in
  `test/runtime.test.js` (`RS_STRING_BRACKETS`) in the theme repo's real-editor
  run, cargo workspace, Okibi; the no-server rows follow the grammar and were
  not measured. In a format string a backslash escape is one
  character, so the braces of `"\u{2603}"` are neither a hole nor an inline
  argument; they used to take the placeholder mark.

With the comment mark and the inline-format-arg lex in `buildFileIndex`
([classification-rules.md](classification-rules.md#classification-classes)),
`test/bench-typing.js rs` went from 9.4–9.7 to 9.7–10.3 ms of CPU per key at 10k
lines and from 16.2 to 17.6–18.0 ms at 50k. The string mark adds 0.3 ms at 10k
(8.9–9.1 to 9.2–9.4) and 1.1 ms at 50k (16.5–17.1 to 17.8–18.1). Each: two
interleaved runs, median of 3 sessions each, Apple M3 Pro, Node 26.8.2, load
average near 4 to 5. Left as the leftover: the brackets of the `{{` / `}}` row
and, without a server, the interpolation-scoped brackets of the table, whose
colour the layer cannot tell from the answer it holds; and, inferred from the
same AST, an unbalanced bracket in a comment shifts the levels of the code
brackets after it. With
`editor.semanticHighlighting.enabled` off the editor does not paint the
provider's answer, so the string mark paints `"{c}"` green where the grammar's
steel rests.

## Memory

Per document the layer keeps one version: its text, lex and block scan, its
band-1 ranges, and the classifier's bundle. An edit to any painted document drops
the old version's text and lex (from the `lexFor` memo too), its plans
(`classCache` keys carry the version, so none can match again) and the band-3
ranges, before anything recomputes. The one exception is the old lex of a
document an editor shows: it stays until the render after the edit re-lexes from
it ([lexer.md](lexer.md#incremental-re-lex)). A bundle keeps the file index and
drops the decoded tokens once the index is built, since classification reads
only the index.

Before, every keystroke's plan stayed in the 16-entry plan cache, each holding its
version's file index, and the `lexFor` memo held the 4 latest texts with their
lexes. Measured with `node --expose-gc test/bench-memory.js 50000 [--no-lsp]`:
8 generated 50k-line documents, 2 per language, each opened, engaged and
classified, then 100 keystrokes into the last; heap after a full GC, Apple M3 Pro,
Node 26.8.2:

| | Before | After | With the re-lex line states |
|---|---|---|---|
| retained by 8 documents, with a server | 293.1 MB | 140.2 MB | 154.6 MB |
| growth over 100 keystrokes, with a server | 98.6 MB | 3.2 MB | 1.6 MB |
| retained by 8 documents, no server | 157.6 MB | 159.8 MB | 174.4 MB |
| growth over 100 keystrokes, no server | 95.7 MB | 1.7 MB | 2.1 MB |

The 2.2 MB more with no server in the After column is the f-string field ranges,
7,348 in each of the two 50k-line Python documents: with them switched off the
run retains 157.8 MB. The last column adds the line-start states every lex
records for the re-lex, four numbers per top-level line: 1.8 MB per 50k-line
document. An engaged 50k-line document holds 16 to 23 MB with a server;
dropping the state of documents no editor shows is not done.
`test/runtime.test.js` ('a superseded version is collected') checks the drop with
`WeakRef`s across three edits and an edit while another document is active, with
and without a server. Strings take no `WeakRef`, so a second test reads the heap
after a full GC: ten re-lexes at increasing lines of a 1.7 MB file may grow it by
less than the text, where names kept from older versions grew it by 17.1 MB
([lexer.md](lexer.md#incremental-re-lex)).

## Cost on large files

Typing at a person's pace into a 50k-line file (1.1 to 1.4 million characters)
costs the extension host 8 to 20 ms of CPU per keystroke with a server and 9 to
22 ms with none, and a keystroke waits 0.1 to 1.3 ms on average behind the
layer's work. Before the changes below it was 36 to 60 ms and 40 to 75 ms, with
waits of 3.5 to 8.6 ms (19 ms in Python with no server). At 10k lines a
keystroke costs 6 to 10 ms with a server, from 7 to 12. Before the interval
indexes in [classification-rules.md](classification-rules.md#performance), the
first classification at the top level took 384 to 732 ms, a keystroke in a Rust
file 330 ms, and a focus change with no semantic provider 390 to 493 ms.

What a keystroke pays, at 50k lines:

| When | Work |
|---|---|
| synchronously, every keystroke | the text (`getText()`), a re-lex around the change, the block scan, the band-1 scans that walk the file (Rust, Python, Lua, Ruby, JavaScript and Zig placeholders, JavaScript and TypeScript JSDoc brackets, `self`), the render |
| once typing pauses for `editDebounceMs` | the server's answer (decoded only when it is for the current text), a function scope for every block, `buildFileIndex` and the scope's classification; without a server the heuristic's file-wide base; the import and shadow restores |

The changes, by effect:

| Change | Mechanism | Where |
|---|---|---|
| The typing debounce grows with the file: 140 ms up to 10k lines, then 1 ms per 150 lines, capped at 400 ms from 49k | 140 ms is shorter than the median gap between keys, 180 ms, so on a large file nearly every key paid a full reclassification: 27 file indexes per 40 keys at 50k lines, 3 now. On files over 10k lines the tints, escape marks and restores catch up with a pause up to 260 ms later | `editDebounceMs` |
| One change re-lexes only around itself | [lexer.md](lexer.md#incremental-re-lex) | `relex` |
| `name!(` calls are found from each `!` | a whole-text regex ran in every `buildFileIndex` (every language) and on every Rust keystroke | `bangCalls`, `errorAttributes` |
| An answer for text that has changed is not decoded, and a waiting keystroke runs before the whole-file work | [One fetch per document version](#one-fetch-per-document-version) | `answerStateOf`, `yieldToEvents` |
| Exact rewrites | shadow scopes deduplicated by object instead of a scan per declaration; gap tests without slicing; the Python scope table runs its regex only on lines that start with `def`, `class` or `async`; `withSlots` skips its sort when the blocks are in order | `computeShadowScopes`, `blankGap`, `commaGap`, `blankOrHashLine` |
| Escape marks are not re-sent unchanged | [Decorations move with edits](#decorations-move-with-edits) | `renderBand3` |
| A memo hit on an equal text held as another string adopts it | a reopened file paid a full string compare on every `lexFor` call: 2.4 s in its first classification at 50k lines ([lexer.md](lexer.md#caching-and-cost)) | `lexFor` |

`test/perf-golden.test.js` keeps every hash through these changes except its
`setDecorations` counts, which the escape-mark change lowers. Its inputs stop at
10k lines, so the debounce change, which moves when a repaint happens and not
what it paints, does not reach it.

The C and JVM change re-records the `render`, `edits` and `editsNoServer` hashes
of all 16 inputs, for band 1's new `constantRestore` type alone: each dumped
snapshot gains it, empty, since no input is C-family, and each session one more
`setDecorations` call, its first clear. Every other dumped line holds, and the
`structure`, `semantic` and `heuristic` hashes with them (`PERF_GOLDEN_DUMP`,
HEAD 588ed19 against the change).

### Typing

`node test/bench-typing.js [--no-lsp | --latency 150]`: 40 keys at log-normal
gaps (median 180 ms, 60 to 900 ms) at the end of a line in a function near the end of the file,
in virtual time (the clock advances by the CPU the extension uses, so a long
task delays the next keystroke), each session in a fresh process, median of 3;
Apple M3 Pro, Node 26.8.2. CPU ms per keystroke, before → after; every column,
the waits and the counts are in [typing-cost.csv](typing-cost.csv).

| Input | Server answers at once | Server answers after 150 ms | No server | Keystroke wait, mean, server at once |
|---|---|---|---|---|
| TS, 10k lines | 8.7 → 6.4 | 6.4 → 3.9 | 10.6 → 7.8 | 0.1 → 0.1 |
| TS, 50k lines | 43.1 → 13.9 | 31.4 → 12.0 | 48.6 → 14.2 | 3.5 → 0.6 |
| Go, 10k lines | 7.2 → 5.8 | 4.8 → 2.8 | 8.6 → 6.8 | 0.1 → 0.0 |
| Go, 50k lines | 36.3 → 8.1 | 23.4 → 5.7 | 39.9 → 8.7 | 4.5 → 0.9 |
| Rust, 10k lines | 11.5 → 8.4 | 8.5 → 4.6 | 11.4 → 8.3 | 0.2 → 0.2 |
| Rust, 50k lines | 55.7 → 14.9 | 39.5 → 12.9 | 53.4 → 16.0 | 7.7 → 0.1 |
| Python, 10k lines | 12.1 → 9.5 | 8.0 → 5.7 | 16.5 → 13.8 | 0.3 → 0.2 |
| Python, 50k lines | 59.6 → 20.1 | 38.5 → 17.0 | 75.4 → 22.3 | 8.6 → 1.3 |

At 50k lines a session of 40 keys builds 3 file indexes instead of 27 (1 instead
of 8 with the slower server).

### Single steps

`node test/bench-scale.js [--no-lsp]`, the build before these changes and this
one run alternately, three times each, median of 3. A cell is the
synchronous handler and render time plus the wall time of the classification
that follows, in ms; the stub server answers at once and its own work sits
outside the timed region. `bench-scale.js` types its burst 30 ms apart, so one
classification follows it in both builds and the debounce does not show here;
the keystroke columns show the re-lex and the cheaper file index.

With semantic tokens:

| Input | Open | Jump to the last function | Module top level | One keystroke | 10 keystrokes, 30 ms apart |
|---|---|---|---|---|---|
| TS, 2k lines, 55 KB | 14.0 → 14.4 | 10.9 → 10.9 | 5.7 → 6.0 | 21.9 → 13.6 | 58.7 → 38.2 |
| TS, 10k lines, 273 KB | 24.6 → 26.7 | 3.3 → 4.0 | 8.2 → 11.4 | 41.8 → 31.5 | 106 → 73.7 |
| TS, 50k lines, 1361 KB | 74.5 → 84.0 | 3.2 → 3.4 | 24.0 → 26.0 | 91.7 → 82.0 | 276 → 177 |
| Go, 2k lines, 43 KB | 23.0 → 14.4 | 2.7 → 3.9 | 2.8 → 1.9 | 7.8 → 10.8 | 25.7 → 16.7 |
| Go, 10k lines, 214 KB | 29.2 → 36.9 | 4.5 → 4.3 | 4.2 → 4.8 | 35.5 → 31.0 | 63.1 → 52.7 |
| Go, 50k lines, 1068 KB | 91.5 → 86.9 | 4.9 → 4.1 | 13.0 → 12.2 | 87.1 → 72.5 | 160 → 99.5 |
| Rust, 2k lines, 55 KB | 21.0 → 10.2 | 3.2 → 2.3 | 2.7 → 2.8 | 15.1 → 11.2 | 37.5 → 27.3 |
| Rust, 10k lines, 262 KB | 26.7 → 28.6 | 2.2 → 3.7 | 4.5 → 4.6 | 39.1 → 29.3 | 93.4 → 76.0 |
| Rust, 50k lines, 1297 KB | 110 → 98.6 | 3.2 → 3.2 | 14.4 → 15.7 | 108 → 98.8 | 276 → 180 |
| Python, 2k lines, 57 KB | 20.3 → 11.9 | 2.0 → 2.2 | 1.1 → 2.3 | 14.3 → 17.6 | 48.4 → 38.0 |
| Python, 10k lines, 273 KB | 32.1 → 37.2 | 2.4 → 2.9 | 4.8 → 5.2 | 43.5 → 39.4 | 89.9 → 92.1 |
| Python, 50k lines, 1360 KB | 111 → 106 | 5.6 → 3.4 | 13.7 → 16.1 | 114 → 104 | 300 → 222 |

With no semantic provider (the heuristic classifier):

| Input | Open | Jump to the last function | Module top level | One keystroke | 10 keystrokes, 30 ms apart |
|---|---|---|---|---|---|
| TS, 10k lines | 23.4 → 26.5 | 3.6 → 10.3 | 9.3 → 9.0 | 45.2 → 43.0 | 91.2 → 67.4 |
| TS, 50k lines | 71.0 → 63.8 | 6.4 → 9.2 | 23.5 → 26.9 | 85.6 → 93.5 | 306 → 198 |
| Go, 10k lines | 18.2 → 22.1 | 5.6 → 5.7 | 5.4 → 5.0 | 25.1 → 34.1 | 66.9 → 61.0 |
| Go, 50k lines | 62.3 → 56.4 | 11.2 → 7.4 | 11.2 → 11.5 | 83.4 → 87.3 | 204 → 141 |
| Rust, 10k lines | 19.8 → 26.1 | 5.5 → 4.0 | 4.2 → 5.7 | 37.6 → 35.9 | 111 → 87.8 |
| Rust, 50k lines | 69.8 → 67.0 | 6.9 → 6.7 | 13.7 → 16.0 | 107 → 88.9 | 339 → 207 |
| Python, 10k lines | 28.5 → 31.0 | 4.3 → 4.6 | 4.6 → 5.2 | 56.0 → 47.0 | 113 → 87.9 |
| Python, 50k lines | 95.6 → 91.1 | 6.1 → 6.5 | 13.1 → 13.9 | 147 → 136 | 350 → 271 |

Differences within 25% in the first four columns are run-to-run noise at
these sizes: in CPU time, opening a 10k-line Go or Python file costs the same in
both builds (13.8 and 20.2 ms synchronous, median of 7 fresh processes). A
longer wait before a step makes it slower in both builds: the same jump costs
4.7 ms after 170 ms idle and 8.9 ms after 430 ms, so the bench waits 170 ms
after a caret move and the typing debounce plus 30 ms after an edit, the same in
both.

Lua, Ruby and Zig came after these measurements; their figures are in
[lua.md](lua.md#cost), [ruby.md](ruby.md#cost) and [zig.md](zig.md#cost).

Per stage, `node test/bench-scale.js 50000 --stages` (warm, mean of 5 calls, ms,
before → after):

| Stage, 50k lines | TS | Go | Rust | Python |
|---|---|---|---|---|
| full lex | 13.5 → 13.1 | 5.1 → 6.0 | 7.0 → 6.7 | 7.4 → 8.5 |
| re-lex after one key 5% / 50% / 95% into the file | 3.3 / 1.9 / 1.4 | 3.2 / 2.0 / 1.5 | 2.9 / 1.9 / 1.4 | 3.2 / 1.9 / 1.3 |
| block scan (`scanBlocks`) | 6.5 → 5.5 | 2.1 → 2.3 | 7.0 → 5.6 | 10.4 → 9.7 |
| `buildFileIndex` | 20.9 → 15.1 | 28.5 → 15.9 | 27.5 → 20.2 | 28.6 → 25.3 |
| classify the module top level | 4.9 → 5.4 | 3.5 → 3.2 | 2.4 → 3.0 | 3.1 → 3.7 |
| classify the last function's scope (4 or 5 blocks) | 0.4 → 0.4 | 0.4 → 0.4 | 0.6 → 0.6 | 0.4 → 0.4 |
| heuristic, the same scope | 2.0 → 1.8 | 1.6 → 1.5 | 2.1 → 2.4 | 3.1 → 3.1 |
| heuristic, the module top level | 4.4 → 4.5 | 3.1 → 3.2 | 3.3 → 3.1 | 3.5 → 4.0 |

The re-lex row is CPU time, median of 9, on the build after; the other rows are
the bench's own wall time.

### What remains

The synchronous part of a keystroke is still whole-file in three places: VS Code's
`getText()`, the block scan (2.3 ms in Go, 5.5 to 9.7 ms in the other three at
50k lines) and the band-1 scans. Shifting the previous blocks when an edit
changes only an identifier's text is not done: the scanners read identifier text
in length-dependent windows (`typeArrowsOf`, through `typePositionBefore`, looks
200 characters back for `type`) and with ASCII-only patterns (Rust closure parameters), so "only an
identifier changed" does not imply the same blocks. There is no size cut-off;
the layer paints a 1.4 MB file. Typed-array or monomorphic binary searches in the
lexer were tried: paired CPU ratios of 0.93 to 1.20, within noise.

## Transitions

Each state can render correctly while the step between two states leaves
something behind. `test/transitions.test.js` drives the real `Decorator` through
the stub with seeded random event sequences and, after every step, compares what
every visible editor shows with what a fresh `Decorator` paints for the same
final state. A difference is a leftover. The harness is
`test/transitions-harness.js`.

### The model

The world is two to five of the fixtures in `test/fixtures/transitions/`
(`walk.ts`, `walk.py`, `walk.rs`, `walk.go`, `walk.md` and eleven data files;
`walk.lua`, `walk.rb`, `walk.js`, `walk.html`, `walk.vue`, `walk.svelte`,
`walk.astro`, `walk.tsx`, `walk.jsx`, `walk.zig`, `walk.c`, `walk.cpp`, `walk.java`,
`walk.kt`, `walk.groovy`, `walk.sh`, `walk.zsh`, `walk.fish`, the markdown-derived
files and the Docker and Kubernetes files have walks of their own, below),
one or two editor groups with tabs, an Output panel, one language server per code
language, the colour theme and the `okibiDynamic` settings. In a quarter of the
walks (88 of the default 300) a data file goes in as the second document, and in
43 of them a second one after it, each with no server. The data files are
`walk.kdl`, `walk.yaml`, `walk.workflow.yml`, `walk.compose.yaml`, `walk.toml`,
`walk.json`, `walk.jsonc`, `walk.ini`, `walk.gitconfig`, `walk.env` and
`walk.gitignore`, under the ids VS Code gives them: `kdl`, `yaml`,
`github-actions-workflow`, `dockercompose`, `toml`, `json`, `jsonc`, `ini`,
`properties`, `dotenv` and `ignore`. Each holds `self`, `this`, `async`, numbers
and nested blocks, each of which paints in a code file. `walk.kdl` mixes KDL v2
with v1's bare keywords and `r"…"` strings; `walk.workflow.yml` holds `${{ }}`
expressions with braces inside. No server is modelled because the layer asks a
data file's server nothing; kdl-lsp, as kdl-org.kdl 2.1.3 bundles it, answers
semantic tokens with `-32601 Method not found` (probed 2026-11-07). A second
random stream per seed picks those walks and their files, so every other walk
replays as the seeds cited below were run. The events, with their weights out of 106:

| Events | Weight |
|---|---|
| caret move to an identifier, a line start or a few columns over, kind Keyboard, Mouse, Command or none | 24 |
| one key, or `self` or `f"{a}"` as a completion; a burst of 2 to 7 keys and backspaces 25, 60 or 130 ms apart; backspace; delete up to 30 characters; Enter with indent; undo; paste of 1 to 3 fixture lines | 32 |
| an edit on a line no caret is on (rename, indent, dedent), or a quick fix appending `._x`, `,`, `.clone()`, `?` or `)` right after a name on any line but not at the caret, in the active or another document; save with a formatter edit on the caret line | 5 |
| idle 380 ms, 2.1 s, 2.6 s, 3.3 s, 25 s or 31 s | 9 |
| focus the other group; open a tab; split; close a tab; reopen a closed document; a webview tab; focus Output; focus back; close the panel | 24 |
| server mode (`none`, `empty`, `ok`, `degraded`) and latency (0, 90, 300 ms, never); release the requests held by "never" | 6 |
| theme flip; `enabled` toggled; dwell preset (2000/24000/350, 400/3000/100, 2000/24000/0) | 6 |

Every event except idle is followed by 0 to 1.2 s of quiet. Time is a fake
clock over `setTimeout` and `Date.now`. Between timers the harness drains the
microtasks and three turns of the event loop, which covers the classifier's
`setImmediate` yields ([One fetch per document version](#one-fetch-per-document-version)),
so a seed always replays the same way. Where it matters, the world follows VS
Code:

- A tab coming into view is a new `TextEditor` with no decorations. It activates
  at 0:0, and its saved caret arrives afterwards as a selection change with no
  `kind`.
- An edit moves the decorations of every editor of the document at once, by
  [the editor's rule](#decorations-move-with-edits), with `forceMoveMarkers` for
  the rename, indent, dedent, quick fix, save formatter edit and Output log line.
  The change event fires, an undo's with its `reason`, and the caret updates
  arrive after it: Keyboard for typing, no `kind` for undo and for edits the user
  did not type.
- Closing a document's last tab sometimes disposes its model, so a reopen gives a
  new `TextDocument` at version 1, sometimes with text changed while closed; the
  rest of the time the model is kept and reopening hands back the same object.
- The server answers for the text as it was when asked, after its latency. A
  `degraded` Rust answer types `Self` as `struct` and `crate` and `super` as
  `namespace`; its tokens come from the lexer's identifiers, typed from their
  neighbours. It answers no document symbols, so named functions get their
  ranges from the block scan alone.

**The reclose walk** is a second test, over `reclose.py` alone, with the steps of
the theme repo's e2e `reclose-<name>` scenarios. Its server also answers document
symbols, Python's classes and `def`s nested as Pylance nests them. The first event
is a Mouse caret in the one-line docstring (Focus); the rest, with weights out of
100:

| Events | Weight |
|---|---|
| End and Backspace on the docstring's line | 20 |
| `"` typed | 18 |
| caret move to one of 8 identifiers: the two docstrings, `__init__`, `push`, `trim` and `main`; kind Keyboard, Mouse or Command | 24 |
| server mode (`ok`, `empty`, `none`) and latency (0, 90, 300 ms, never) | 12 |
| release the requests held by "never" | 8 |
| idle 380 ms, 2.1 s, 3.3 s or 25 s | 8 |
| undo | 5 |
| `x` or a space typed | 5 |

Deleting the docstring's last `"` makes a string of the text up to `Book`'s first
`"""`, and of the rest of the file from its second; typing it back restores the
saved text. In the default run, 134 of the 200 walks delete it, and 295 Mouse caret
moves land while in Edit.

Pylance 2026.4.1 answered each version of that e2e scenario for its own text, 6
and 9 ms after the request (traced on 2026-11-07): with the docstring
unterminated, 17 tokens on the file's first 13 lines and the symbols `ID`, `Trade`
and `Fill`, `Fill` running to the end of the file; closed again, the saved text's
122 tokens and whole symbol tree.

**The Lua walks** are two more tests, 120 walks each (`OKIBI_LUA_WALKS`). The
first opens `walk.lua`, alone or with `walk.ts`, `walk.py` or `walk.md`, with
each server's mode drawn from `ok`, `degraded`, `none` and `empty`, and for Lua
also `strings`, which types every string literal `string` as lua-language-server
does under `Lua.semantic.keyword`; latency from 0, 90 and 300 ms. It replays the
events of the main walk with the same seed, a server-mode event on Lua drawing
from the five modes. In the default run `walk.lua` showed identity tints on 517
steps, clay on 1,246, the module restore on 1,352, the shadow restore on 1,859,
escape marks on 115, `self` paint on 2,734 and format placeholders on 345; the
test fails if any of them is never shown. The second walks `walk.lua` alone,
with the reclose walk's weights and `strings` among the server modes: deleting
the long comment's last `]` makes a comment of the rest of the file, deleting an
`end`'s `d` leaves every later block one deeper, and typing either back restores
the text; carets go to 8 identifiers in comments, code and long strings. Without
the render that follows a change in whether the answer types string literals,
it fails at seed 39, shrunk to 4 events.

**The Ruby walks** are two more, 120 walks each (`OKIBI_RUBY_WALKS`). The first
opens `walk.rb`, alone or with `walk.ts`, `walk.py` or `walk.md`, each server's
mode drawn from `ok`, `degraded`, `none` and `empty`, and replays the main
walk's events with the same seed. The Ruby server answers in ruby-lsp 0.26's
shape: `variable` on every read after a name's first occurrence, `self` as
`variable.defaultLibrary`, nothing on a write, a constant, `@x`, `$x`, a member
or a call with parentheses. `walk.rb` holds a division after a local
(`total /2`) and a hash after a ternary `?`, which the lexer's local-variable
table and the brace scan read ([ruby.md](ruby.md#lexer)). In the default run
`walk.rb` showed identity tints on 535 steps, clay on 1,227, the shadow restore on
1,808, escape marks on 44, `self` paint on 2,629 and the `#{` / `}` restore on
2,708; the test fails if any is never shown. The second walks `walk.rb` alone with the reclose walk's
weights: deleting the heredoc terminator's last `S` makes a string of the rest
of the file, deleting an `end`'s `d` leaves every later block one deeper, and
typing either back restores the text; carets go to 9 identifiers in code, a
heredoc hole and the heredoc body.

**The JavaScript walks** are one more test, 120 walks (`OKIBI_JS_WALKS`). It
opens `walk.js`, alone or with `walk.ts`, `walk.py` or `walk.md`, each server's
mode drawn from `ok`, `degraded`, `none` and `empty`, and replays the main
walk's events with the same seed. `ok` answers in tsserver's shape: no token on
an `import * as` binding or its uses, `self` as `variable`; `degraded` in
Deno's, `variable` on both. `walk.js` holds a shebang, a namespace import, a
`require`, an ES5 constructor function with `var self = this`, a one-line
arrow, destructured parameters, a regex with a `/` in a class, template holes
and JSDoc types. In the default run `walk.js` showed identity tints on 597
steps, clay on 1,145, the namespace restore on 1,462, escape marks on 143,
`this` paint on 2,684, async marks on 226, the `${` / `}` restore on 2,670 and
the JSDoc brackets on 2,663; the test fails if any is never shown. 600 walks
from seed 1000 found nothing. An import recompute pending in any document, a
`walk.ts` edit's included, keeps every editor's import and shadow restores out
of that step's comparison and its counts.

**The HTML walks** are one more test, 120 walks (`OKIBI_HTML_WALKS`). It opens
`walk.html`, alone or with `walk.js`, `walk.ts`, `walk.md`, `walk.xml`,
`walk.hbs` or `walk.css`, the last under `css` or under Tailwind's
`tailwindcss`, and replays the main walk's events with the same seed; a fifth of
the typed keys are a script boundary or markup instead (`</script>`,
`<script>`, half of either, `<`, `>`, `<!--`, `-->`, `` ` ``, `/*`,
`<p onclick="x()">`). The HTML server answers in its shape: tsserver's on the
scripts, a token on every name in a handler attribute, none on an `import * as`
binding or its uses. `walk.html` holds a classic and a module script, a JSON
script, a `<style>`, an `onclick` and the words `self`, `this` and `42` in
markup. `walk.css`, `walk.xml` and the Handlebars page `walk.hbs` get no server
and, like a data file, must show nothing and be asked nothing; they are walked here so the
main walks' data files, and the seeds cited for them, stay as they were. At
every step each `walk.html` editor must paint inside the scripts of its current
text only, a stripe line holding script text. In the default run `walk.html`
showed identity tints on 92 steps, clay on 224, the namespace restore on 2,061,
escape marks on 7, `this` paint on 2,657, async marks on 64 and the stripe on
293, and `walk.css` was the active editor at 111 steps as `css` and 314 as
`tailwindcss`, `walk.xml` at 128 and `walk.hbs` at 149; the test fails if any is
never shown. Taking `tailwindcss` out of `STATIC_CONTENT_LANGUAGES` fails it at
seed 13 and `handlebars` at seed 2, each as the file opens (`self` paints), and
leaving the markup in the top level fails the paint-inside check.

**The sheet, PHP and MDX walks** are three more tests, 120 walks each
(`OKIBI_SHEET_WALKS`, `OKIBI_PHP_WALKS`, `OKIBI_MDX_WALKS`), each with its own
generator so the other walks' seeds stay as they were. The sheet walks open
`walk.ts`, `walk.py`, `walk.rs`, `walk.go` or `walk.html`, then one or two of
`walk.scss`, `walk.less`, `walk.styl`, `walk.pcss` (`postcss`), `walk.tw4.css`
(`tailwindcss`), `walk.graphql`, `walk.razor` (as `razor` and `aspnetcorerazor`)
and `walk.cshtml`, with no server for them; a fifth of the typed keys are a
stylesheet's or a template's opener or closer. Each must show nothing and be asked
nothing, as a data file. In the default run each id was the active editor at 119 to
380 steps, and a sheet was on screen beside a painted code file at 425. The PHP
walks open `walk.php`, alone or beside `walk.html`, `walk.ts`, `walk.md`,
`walk.scss` or `walk.cshtml`, a fifth of the typed keys a PHP tag, a quote or a
comment opener; every step each `walk.php` editor must paint inside its PHP regions
only, a stripe line holding PHP or lying inside a block whose braces sit in two
regions, and never the `self` mark or an async mark. In the default run it showed
tints on 139 steps, clay on 567 and the stripe on 683. The MDX walks open
`walk.mdx` beside a code file, and in half of them `walk.md`, a fifth of the typed
keys an expression's, a JSX tag's or an ESM line's end, a fence, `==` or `](`;
`walk.mdx` must show the link cancel only, no wash: 2,509 steps showed it.

**The component walks** are one more test, 120 walks (`OKIBI_COMPONENT_WALKS`).
Each opens `walk.vue`, `walk.svelte`, `walk.astro`, `walk.tsx` or `walk.jsx` by
seed, alone or beside another of them, `walk.ts`, `walk.html`, `walk.md` or `walk.css`, and
replays the main walk's events with the same seed; a fifth of the typed keys are
a region boundary, a template block or markup instead (`{{`, `}}`, `{`, `}`,
`<script>`, `</script>`, `---`, `{#each items as item}`, `{/each}`,
` v-for="x in xs"`, `"`, `<Child />`, `<>`, `</>`, `<!--`, `-->`, `` ` ``). The
servers answer in their shape: a token on every name in a script or a template
expression, none on an `import * as` binding or its uses, and Vue's `component`
on a capitalised tag in the markup; `javascriptreact` gets tsserver's JavaScript
shape, no token on an `import * as` binding. At every step each component editor
must paint inside the code regions of its current text only, a stripe line holding
code or lying inside a template block around the region that holds the caret,
which is focused whole ([components.md](components.md#blocks-and-focus));
`walk.tsx` and `walk.jsx` are one region each. `walk.jsx` holds a namespace
import, a JSDoc type, template literals in an effect and in JSX, a fragment, a
class component on `this` and spread props. In the default run the components
showed identity tints on 322 steps, clay on 858, the namespace restore on 1,310,
escape marks on 42, `this` paint on 2,175 and the stripe on 1,063, and in
`walk.jsx` the `${` `}` restore on 769 and the JSDoc brackets on 776; `vue` was
the active editor at 576 steps, `svelte` at 543, `astro` at 642,
`typescriptreact` at 670 and `javascriptreact` at 687; the test fails if any is
never shown. Taking `javascriptreact` out of the placeholder scans fails it.
A second test replays seed 4753 over the first four components (`vue`, `svelte`,
`astro`, `tsx`, the walks before `walk.jsx` joined): a caret in `{#await
promise}` focuses the await block, whose stripe covers `<p>waiting</p>`; the
check that every stripe line holds code failed it, and 800 walks from seed 4242
under that check failed at seeds 4753 and 4909.

**The Zig walks** are two more tests, 120 walks each (`OKIBI_ZIG_WALKS`). The
first opens `walk.zig`, alone or with `walk.ts`, `walk.py` or `walk.md`, and in
3 of 10 walks `walk.zon` as well, which opens as `zig` and is answered by the
same server, as zls answers it in the editor. Each server's mode is drawn from
`ok`, `degraded`, `none` and `empty`, and for Zig also `strings`, which adds a
`string` token over each literal as zls does under `full`; the main walk's
events replay with the same seed. The Zig server answers in zls 0.17's
`partial` shape: identifiers only, none on keywords, primitive types or
`@builtins`; zls has no degraded shape, so `degraded` answers as `ok`. `walk.zig` holds a namespace import and alias, a struct with
methods on `self`, captures, a `\\` line with braces and a name in it, a
labelled block, a format string, a write through a pointer parameter and a
`@ptrCast`. In the default run `walk.zig` showed identity tints on 548 steps,
clay on 1,209, the namespace restore on 629, escape marks on 138, danger marks
on 180, `self` paint on 2,667 and format placeholders on 556, and `walk.zon` was
the active editor at 229, where it must show nothing at all, as a data file
must; the test fails if any is never shown, and on any async mark. The second
walks `walk.zig` alone with the reclose walk's weights: deleting a string's
closing `"`, a `\\` line's second backslash or a block's `}` and typing it
back; carets go to 8 identifiers in code and in the `\\` line. 600 walks of
each from seed 1000 found nothing.

**The C and JVM walks** are one more test, 120 walks (`OKIBI_CJVM_WALKS`). Each
opens `walk.c`, `walk.cpp`, `walk.java`, `walk.kt` or `walk.groovy` first, picked
by seed, alone or with `walk.cmake`, `walk.gradle`, `walk.gradle.kts`, `walk.ts`
or `walk.py`; the main walk's events replay with the same seed. The C, C++,
Java and Kotlin servers' modes are drawn from `ok`, `degraded`, `none` and
`empty`: `ok` types like clangd and jdtls, with a `declaration` on each first
occurrence, and `degraded` is each language's other shape: cpptools' tokens with
no `declaration` at all, kls's extra `variable` over each `$name` template and
`property.declaration` on a local `val`, jdtls's `property` on a field read bare.
Groovy, CMake and the Gradle scripts get no server. CMake is static content and
must show nothing; a Gradle script shows band 1's `this` and nothing else, and
neither is asked about. The five code files are synthetic, written from the
same constructs as the `test/fixtures/cjvm` sources. In the default run the code
files showed identity tints on 637 steps, clay on 1,256, escape marks on 109, danger
marks on 110, the `this` / `self` paint on 3,269, the `NULL` / `true` / `false`
restore on 1,088 and the Kotlin `$name` restore on 808; the test fails if any is never
shown, and on a keyword-grey restore in C other than `bool`. 600 walks from seed 1000 found one leftover in the oracle:
a `.gradle` editor showing band 1's `this`, which the oracle had treated as a data
file; 600 more from seed 5000 found nothing.

**The cancelling-cpptools walks** are one more test, 80 walks (`OKIBI_CANCEL_WALKS`).
Each opens `walk.c` or `walk.cpp`, alone or with `walk.cmake`, `walk.ts` or `walk.py`,
and keeps one server for the walk: cpptools in 3 of 5, clangd's shape or none in the
rest. The cpptools model is its provider's: one token request waits per file, a
request while another waits rejects the waiting one as `Canceled`, a version's answer
arrives 300 ms to 2.4 s after its first request, and later requests for it get that
answer at once. The editor's own requests for each version (60 ms, 400 ms and 1.7 s
after its first, those before the answer) cancel whatever waits. The test fails on
any leftover and on any step whose plan holds band 2 under cpptools ([Cold
servers](#cold-servers)): with cancellations read as `empty`, 121 steps held. In the
default run cpptools cancelled 446 requests. A step is not quiet while a fetch is in
flight, so band 2 is compared only after the asking-again has ended.

**The prose walks** are one more test, 100 walks (`OKIBI_PROSE_WALKS`). Each
opens a markdown-derived file first, picked by seed: `walk.prompt.md`,
`walk.instructions.md`, `walk.agent.md`, `walk.skill.md` or `walk.jmd`, under
`prompt`, `instructions`, `chatagent`, `skill` and `juliamarkdown`. Then
`walk.ts`, `walk.py`, `walk.rs` or `walk.go`, and in half of them `walk.md` or
another of the five. The main walk's events replay with the same seed. VS Code
registers a semantic tokens provider for the four chat customisation ids, so they
get a server that answers `ok` at once; the code file's mode is drawn from `ok`,
`degraded`, `none` and `empty`. Each file holds frontmatter, a `==mark==`, links
and a fence with nested braces, numbers and `self` or `this`. In the default run the
five ids are the active editor at 381 (`prompt`) to 460 (`skill`) of the 4,000
steps, the four chat ids show a mark at 381 to 551, and a prose file is visible
beside a code editor painted with a stripe or tints at 253; the test fails if any
count is 0. Taking the four chat ids out of `MARKDOWN_LANGUAGES`, and so out of
`PROSE_LANGUAGES`, fails it at seed 1 as the files open, `self` painted on the
`instructions` file. With the paint check off, the request check fails the same
seed (`vscode.executeDocumentSymbolProvider` asked about it). Taking
`juliamarkdown` out fails it at seed 4. Keeping the four prose but taking their
marks off fails the mark counts. The test takes 1.2 to 1.5 s.

**The container walks** are one more test, 100 walks (`OKIBI_CONTAINER_WALKS`).
Each opens `walk.ts`, `walk.py`, `walk.rs` or `walk.go`, then one of
`walk.Dockerfile`, `walk.docker-bake.hcl`, `walk.helm.yaml` and `walk.k8s.yaml`,
picked by seed, under `dockerfile`, `dockerbake`, `helm` and `yaml`, and in 4 of
10 a second one; the main walk's events replay with the same seed. The container
files get no server, the code file a mode drawn from `ok`, `degraded`, `none` and
`empty`. Each holds `self`, `this`, `async`, numbers and nested blocks;
`walk.helm.yaml` holds Go template actions with `$` variables and `range`, `with`
and `if` blocks. They are walks of their own so the main walks' data files, and the
seeds cited for them, stay as they were. In the default run the four are the
active editor at 301 (`walk.k8s.yaml`) to 367 (`walk.helm.yaml`) of the 4,000
steps, and one is visible beside a code editor painted with a stripe or tints at
541; the test fails if any count is 0. Taking `helm` out of
`STATIC_CONTENT_LANGUAGES` fails it at seed 2 as the file opens (`self` paints on
`.Values.self`), `dockerfile` at seed 1 shrunk to 1 event and `dockerbake` at
seed 1 shrunk to 2. The test takes 1.4 to 1.7 s.

**The shell walks** are two more tests, 120 walks each (`OKIBI_SHELL_WALKS`). The
first opens `walk.sh`, `walk.zsh` or `walk.fish`, alone or beside `walk.sh`,
`walk.fish`, `walk.ts`, `walk.py`, `walk.md` or a tooling file (`walk.sql`,
`walk.diff`, `walk.git-rebase-todo`, `walk.proto` as `proto3` and as `proto`,
`walk.buf.yaml`), and replays the main walk's events with the same seed, a fifth
of its typed keys drawn from quotes, `$`, `${`, `}`, `$(`, `)`, a heredoc opener,
`fi`, `done`, `esac`, `end`, `#`, a backtick, `;;`, `local ` and `set -l `.
`shellscript` draws `none` or `empty`, as bash-language-server sends no tokens;
`fish` draws `ok`, `degraded`, `none` or `empty` in fish-lsp's shape (`variable`
over every name, `degraded` the commands only); a tooling file gets no server. In
the default run the shell files showed tints on 391 steps, clay on 750 and danger
marks on 66, and a tooling file was the active editor on 752; the test fails if
any count is 0. The second walks `walk.sh` or `walk.fish` alone with the reclose
walk's weights: it deletes a heredoc terminator's last letter, a quote, the last
letter of `fi`, `done`, `esac` or `end`, or a hole's `}` or `)`, and types it
back. The two take 2.1 s and 1.0 s.

### The oracle

Once the files are open, and after every step, the harness records what each
visible editor shows: per decoration type the covered ranges, merged, with the
type's style; the gutter as the lines it covers; and the status bar text. Then it builds a fresh `Decorator` on mirror
editors with the same documents, versions, carets, active and visible editors,
theme and settings. It hands the fresh one the walked one's phase and engaged
documents, and the classifier state that depends on earlier answers by design:
`semanticOk`, the path keywords, whether a Lua answer typed its string
literals, the namespace names a JavaScript or TypeScript answer typed, the
cold-retry count and the provider-less languages. The fresh one's server replays the last answer the walked one got for
each document version, and never answers a version whose request is still
pending. Its own debounce runs on a separate clock.

Two groups are compared only once they have settled. Band 2 and the escape
marks need no classify pending, no request pending for the active document's
version, and no provider-silent hold, which keeps the previous version's
semantic tints by design ([Cold servers](#cold-servers)). The import and shadow
restores need no recompute pending in any document. Everything else is compared at every step. In
the default run, 300 walks of 40 steps, 65% of steps compare every type; the
test fails below half.

The two share the module-level lex memo, so a wrong incremental re-lex reaches
both and their paints agree. Each step therefore also requires every shown
document's cached lex to equal a fresh `lex` of its text: re-lexing a PHP page's
view after an edit that moves a region's end fails it at seeds 1000 and 5000 of
the PHP walks, shrunk to 7 and 3 events; seed 1 does not reach it, and
`test/php.test.js` holds the case directly.

A data file's editor must also show nothing at all, at every step, whatever the
fresh one paints. The comparison alone would pass a data file both decorators
paint the same wrong way. Taking an id out of `STATIC_CONTENT_LANGUAGES` fails the
walk by seed 72: `github-actions-workflow` at seed 13 and `ini` at seed 4, as the
files open (`self` paints), `kdl` at seed 36, `jsonc` at seed 72 (the stripe and
clay numbers). Keeping the other editors' bands while a data file is active fails
it at seed 4, shrunk to 4 events. In the default run a data file is the active
editor at 801 of the 12,000 steps, each format at 42 (`toml`) to 102 (`json`);
the default run fails if a format is never active, or all of them at 1 in 40 or
fewer. At 394 steps one is visible beside a code editor painted with a stripe or
tints, and the active editor moves between a data file and a code file 115 times,
and between two data files 13 times. A run with other `OKIBI_WALKS`,
`OKIBI_STEPS` or `OKIBI_SEED` values prints the counts and asserts no floor: 19 of
the default run's 88 data walks never make a data file active (seed 7 is the
first), so a rerun of a few seeds would fail one.

In the same way a prose file's editor may show the two markdown marks and
nothing else, and only under an id that takes them, `markdown` and the four chat
customisation ids; a `walk.jmd` editor shows nothing. And no step may have asked
a server anything about a data or prose document, whichever decorator asked; a
`walk.zon` is exempt, since zls answers it.

A failure is shrunk by delta debugging over the event list, then by zeroing the
pauses, and printed as the seed, the world and the remaining events.
`OKIBI_WALKS`, `OKIBI_STEPS` and `OKIBI_SEED` set the run. The default run takes
4.7 s at a load average of 2.5 to 2.7 on an Apple M3 Pro with Node 26.8.2, 2 s of it the
event-loop turns drained between timers. Besides it, 3,000 walks of 40 steps
(seeds 1000 to 3999), 2,000 of 80 (10000 to 11999) and 3,000 of 60 (20000 to
22999) found nothing after the fixes below, again on the build with the
re-lex, the scaled debounce and the classifier's yields (43 s, 53 s and 61 s),
and again with the forced edits modelled (45 s, 54 s and 62 s, the three run side
by side), and again with one or two data files in 759, 467 and 787 of those
walks (59 s, 71 s and 79 s, side by side at a load average of 5 to 6, with a VS Code
window open). Four leftovers
put in by hand (no band-3 clear in Focus, no clear of the other editors, no pool
rebuild on a theme flip, band 1 kept when disabled) each failed within the first
3 seeds and shrank to 1 to 3 events. Taking every edit as unforced fails at seed
51, and taking every change on a caret's line as typing at seed 562, each shrunk
to 2 or 3 events.

The reclose walk runs 200 walks of 16 steps in the default run, 1.4 s, set by
`OKIBI_RECLOSE_WALKS` and `OKIBI_RECLOSE_STEPS`. 38% of its steps compare every
type, since the provider-silent hold and the requests "never" leaves pending keep
band 2 out; the test fails below a quarter. 3,000 walks of 24 steps (seeds 1000 to
3999, 29 s) found nothing. Caching an answer that arrived after an edit under the
document's new version, so that the unterminated docstring's tokens and symbols
classify the re-closed text, fails it at seed 4, shrunk to 3 events, and the main
walk at seed 3, shrunk to 4.

### What the walks found

Each is a named test in `test/transitions.test.js` that fails without its fix.

| Leftover | Mechanism | Fix |
|---|---|---|
| A visible split kept band-1 marks of the old text after a rename or formatter edit while another editor or the Output panel had focus | `onEdit` returned before scheduling a render when the document was not the active editor's | render when any visible editor shows the document |
| The import restore stayed on after the server answered | the answer was for an older version, so band 2 discarded it and nothing repainted; band 1 waited for the next version's answer | render when `semanticOk` changes, as for the path keywords |
| Deleting and undoing before the repaint left the restored code without its tints | [Decorations move with edits](#decorations-move-with-edits) | `markMoved` |
| The gutter and bands painted a block the caret was not in, after typing a brace | the render between an edit and its caret update read the old caret against the new text; the caret then landed in the block `onSelection` had last seen, which it took as no change | render when the caret's block differs from the block last painted (`renderedBlockKey`) |
| The `Self` / `crate` / `super` and import restores followed an answer for older text that arrived after the newer one | `fetchBundle` set `semanticOk` and the path keywords from every answer, whatever its version | only an answer for the newest version answered so far sets them (`answeredVersion`) |
| The placeholders stayed on after the last answer typed no string literals, in Zig and Lua | two classifies started from the same state; the later version's answer arrived last and turned `typesStrings` back off, but its classify compared with the state it started from, which also typed none, so it scheduled no render | `runClassify` compares the classifier state with the state the document's last band-1 render read (`band1Seen`), for the path keywords, `semanticOk`, `typesStrings` and the typed namespaces |
| Band 2 stayed empty after an edit put the caret inside a new block without moving it (indenting the line under a Python `def` header) | the classification of the new block failed the epoch guard against the focus key of the last caret move, and nothing classified again | `runClassify` sets the current focus key to the block it classifies |
| A quick fix appending `._x` to `self` left the `self` mark over `self._x` (found in review; the harness then had no forced edits) | VS Code applies the fix with `forceMoveMarkers`, so the mark's end moved past `._x`; `rangesMovedBy` assumed it stuck, and the recomputed ranges equalled the record, so nothing re-sent them | `markMoved` takes an edit as forced unless it is an undo or redo or touches a caret ([Decorations move with edits](#decorations-move-with-edits)); two tests, the fix away from the caret's line and on it |

### Limits

- The stub has no layout, rendering or IPC: ranges land on the version they were
  computed for. In the editor they can land on a version the user has already
  typed past.
- Band 2 is not compared inside a provider-silent hold or while a classification
  is pending, so a leftover that lives only there is not caught.
- The fresh `Decorator` is handed the walked one's phase and engaged documents,
  so a wrong phase or a stale engagement is invisible as long as what it paints
  is consistent with it.
- A forced edit that touches a caret reads as typing, so a mark ending where it
  inserts keeps the inserted text until its type's ranges change. The quick fix
  event skips, for that reason, any insertion point whose text would touch a
  caret by `mayForceMove`'s own rule, not only the caret's offset: seed 40141
  appended `.clone()` 3 characters before the caret, after `std`, and the
  restore covered `std.clone()`. A fix at the caret is not caught.
- Not modelled: multi-cursor edits, diff editors, notebooks, word wrap, the
  3-minute model hold as a duration, and a server that answers in a different
  order than asked, other than through latency.
- The server is synthetic: the plans exercise the classifier but not the real
  servers' token shapes, which `test/runtime.test.js` and the golden tests cover.
  Only the reclose walk's server answers document symbols, and only for Python.
- The Lua walks' server is the same synthetic one, so lua-language-server's
  shapes (`class` modules, `variable` namespace globals) are covered by
  `test/lua.test.js` on a capture, not here.
- Eleven data files are walked in the main walks, four Docker and Kubernetes
  files in walks of their own, the tooling files (`sql`, `diff`, `git-rebase`,
  `proto3`, `proto`, `buf-config`) beside the shell files, and `walk.css` (as
  `css` and `tailwindcss`), `walk.xml` and `walk.hbs` beside `walk.html`. The other ids of `STATIC_CONTENT_LANGUAGES`
  (`json5`, `jsonl`, `java-properties`, `go.mod` and the rest) take the same
  `isNonFlowLanguage` path; `test/render.test.js` holds the config ones to no
  paint and no server request, but they are not walked.
- Seven prose files are walked, `walk.md`, the five markdown-derived ones and
  `walk.mdx`. The other ids of `PROSE_LANGUAGES` (`plaintext`, `restructuredtext`,
  `quarto` and the rest) take the same `isNonFlowLanguage` path and are not walked.
- A dwell or `enabled` change resets the phase to Survey (`refresh()`), so the
  walks reach Edit again only through more typing.
