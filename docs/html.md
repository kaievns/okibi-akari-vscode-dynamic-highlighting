# HTML, CSS and XML

An HTML document's `<script>` elements are JavaScript to the layer: blocks,
Focus, Edit, data identities, escape and async marks, clay numbers and the
band-1 restores, by the rules of [javascript.md](javascript.md). Everything
else in the document is markup, outside every scope. CSS, Tailwind CSS, XML,
XSL, DTD, RELAX NG compact and web manifests are static content
(`STATIC_CONTENT_LANGUAGES`, `src/focus.ts`): no blocks, no bands, no band-1
restore, no server request, the phase held in Survey. Their colours are the
theme's alone. `src/html.ts` finds the scripts; tests: `test/html.test.js`,
the HTML walks in `test/transitions.test.js`, and the static ids in
`test/render.test.js` and `test/rust.test.js`.

## Ids

The ids VS Code 1.145.2 and the extensions below register (`contributes.languages`,
2026-11-11):

| Id | Names | Registered by | The layer |
|---|---|---|---|
| `html` | `.html .htm .shtml .xhtml .xht` | `vscode.html` | code in its scripts ([Script regions](#script-regions)); the markup has no scope |
| `html-template` | `.jsp .asp .aspx .ejs .volt .jshtm .rhtml .mdoc`, which VS Code opens as `html` | the layer (`effectiveLanguageId`) | static content: a server template's `<%= %>` inside a script would derail the JavaScript lexer |
| `css` | `.css` | `vscode.css` | static content |
| `tailwindcss` | `.css` under `"files.associations": {"*.css": "tailwindcss"}`, the setting Tailwind CSS IntelliSense's README recommends | `bradlc.vscode-tailwindcss` 0.16.0 | static content |
| `xml` | `.xml .xsd .svg .rss .atom` and 58 more, `.dtd .ent .mod` among them, and any file whose first line matches `<?xml`, `<svg` or `<!doctype svg`, so `.plist` and `.tmTheme` too | `vscode.xml` | static content |
| `xsl` | `.xsl .xslt` | `vscode.xml` | static content |
| `dtd`, `rnc` | `.dtd .ent .mod`, which `vscode.xml` lists too, and `.rnc` | `redhat.vscode-xml` 0.29.3 (its public `package.json`; not installed here) | static content |
| `json` | `.webmanifest` | `vscode.json` | static content |
| `handlebars` | `.handlebars .hbs .hjs`, whose grammar embeds `text.html.basic` | `vscode.handlebars` | static content: a logic-less template, whose `{{ }}` tags have no lexer family |
| `razor`, `php` | `.cshtml .razor`; `.php .php4 .php5 .phtml .ctp` | `vscode.razor`, `vscode.php` | code, read whole by the default lexer: a click in markup enters Focus, and a number in text paints clay. Their C# and PHP are real code, so the templates step takes them, not this one |
| `markdown` | ```` ```html ````, ```` ```css ````, ```` ```xml ```` and ```` ```svg ```` fences, raw HTML in prose | `vscode.markdown` | prose: the two markdown marks only |

`scss`, `less`, `sass` and `stylus` stay static as before; their own audit is the
next step's.

Before `handlebars` was listed, a `.hbs` page was read as code, as `razor` and
`php` still are: in the stub, a click on the `<p>` line of a six-line
`{{#if}}` page entered Focus with a 3-line stripe, and `42` in its text painted
clay; the same text as `html` stayed Survey and painted nothing.

### Before `tailwindcss` was listed

Under Tailwind's association a `.css` file was read as code: the default
family's brace scan found 25 blocks in the synthetic stylesheet, a click entered
Focus with the stripe and clay numbers, typing entered Edit, and each classify
asked the server 3 times. In the real editor the `tailwind-mode` cell failed
all 5 of its static scenarios on that tree ([Real editor](#real-editor)). `dtd`
and `rnc` took the same path, the stub showing Focus and Edit on a click and a
keystroke in each.

## Script regions

A script region is the content of a `<script>` element VS Code's HTML grammar
(`text.html.derivative`, the root a `.html` file opens with) paints as
`source.js`. `scriptRegions` reads the document once per version:

- A `<script>` with no `type`, an empty one, or a `type` that starts with a
  JavaScript type followed by a space or the value's end: `text/javascript`,
  `text/javascript1.0` to `1.5`, `text/x-javascript`, `text/jscript`,
  `text/livescript`, `text/ecmascript`, `text/x-ecmascript`, `text/babel`,
  `application/javascript`, `application/x-javascript`,
  `application/ecmascript`, `application/x-ecmascript`, `module`. Case is
  ignored. The first `type` that is not one decides, a second `type` included.
- `text/x-handlebars`, `text/template`, `text/x-template`,
  `text/x-handlebars-template`, `text/ng-template` and `text/html`: the content is
  markup again, so a `<script>` inside it is a script.
- Anything else, `application/json`, `importmap`, `speculationrules`,
  `text/plain`, `text/typescript` and `type=" module "` among them: not a script.
  An unquoted `type=text/javascript>`, a `/` with the `>` right after it, is not
  one either, and neither is `<script/>` or any start tag with a `/` outside its
  attribute values.
- Comments, CDATA sections, `<style>` up to its first `</style`, and `<svg>` and
  `<math>` up to their own close tag, nested ones counted, are skipped: the
  grammar reads a `<script>` there as CSS or plain text. An `<svg …/>` start tag
  opens an element the grammar keeps open to its `</svg>`, and so does the finder.
- A script inside `<template>`, `<textarea>`, `<title>` or `<noscript>` counts, as
  the grammar paints it.
- A start tag with no `>` before the end of the document opens nothing.

A script ends at its first `</script`, case-insensitive, as the HTML parser and
the HTML language server end it. The grammar disagrees in one case: after a
`'</script>'` inside a string it keeps painting JavaScript to the next one. The
finder follows the parser, so no band 2 or 3 lands on that text, which a browser
reads as markup.

On VS Code 1.145.2's grammar the finder agrees on every non-space character of
1,819 public HTML files except that case: 2,716,564 characters agree, 23 in one
file (Go's trace viewer) are JavaScript to the grammar only, and 0 are
JavaScript to the finder only ([html-measurements.csv](html-measurements.csv)).
178 private files agree on all 12,100 of their script characters.
`test/fixtures/html/edges.html`, `types.html` and `foreign.html` hold every rule
above, and agree with the grammar line by line except the `'</script>'` line.

## The script view

The scanners and classifiers read an HTML document as its script view
(`scriptView`, `flowText`): every character outside a script is a space, line
breaks kept, so every offset and line is the document's. A form feed sits on the
start tag's `>` and on the `<` of `</script`, and a form feed inside a script
reads as a space. The lexer splits the view at the marks and lexes each script
as `javascript` on its own (`lexScripts`), so no string, comment, template or
brace runs from one script into the next. The view's lex has no incremental
re-lex, as `javascript`'s has none ([javascript.md](javascript.md#known-limits)).
`scriptView` is `codeView` over the scripts; a Vue, Svelte or Astro component is
read through `codeView` too, over its scripts and template expressions, with two
more marks, for a pattern region and a template block's ends
([components.md](components.md#the-code-view)).

## Blocks and focus

Each script is block-scanned as JavaScript on its own and the blocks shifted to
the document (`scanScriptBlocks`). The top level is one scope for every script:
classic scripts share their globals, and a module's top level is folded in with
them. The markup is outside the top level, so its stripe covers script lines only.

A caret in the markup has no scope: the phase stays or drops to Survey and band 2
withdraws. A keystroke there neither engages nor enters Edit, and neither does an
edit with no caret event after it, an undo that restores the caret where it was
([classification-rules.md](classification-rules.md#the-restored-caret-event)).
The region's end counts as inside, so a caret right after a script's last
character, before `</script>`, focuses it. An edit is read against the text it
leaves: with the `/` of a `</script>` deleted the script runs on to the next end
tag, over the caret, so the deletion enters Edit; typed back, the caret is in the
markup again and the phase drops to Survey. The theme repo's real-editor `html`
cell holds both steps, with the HTML server and without it.

## Data identities and marks

The JavaScript rules, unchanged. With the HTML server's tokens and without, the
same code paints the same in a page and in a `.js` file: over 18 public pages
with scripts, 273 carets, 2,061 tints with no server and 9,503 with the HTML
server's tokens, and 1,084 escape marks, every count identical between the page
and its script view opened as `javascript`; 8 tints in each mode land on a
non-data name (TypeScript 5.9.3's checker over the view as one program), and none
outside a script. On 6 private pages with scripts, 474 tints, all on data names
and all inside a script.

An event-handler attribute (`onclick="…"`) is markup. The HTML server types its
names, but its tokens fall on blanked text in the view and match nothing. 6
handlers in the 1,819 public files.

A CSS custom property is not a data identity. Of 54,961 `var(--x)` uses in
public stylesheets, 756 (1.4%) sit in a rule that declares `--x` itself, and
45,076 (82%) use a property the file declares nowhere: the value comes from the
cascade, which a stylesheet's structure does not show.

## Band-1 restores

| Restore | In HTML | Why |
|---|---|---|
| `this`, keyword grey | every code `this` in a script | as in `javascript` |
| `import * as NS` uses, type slate | as in `javascript` | the HTML server sends no token for a namespace binding or its uses, as tsserver sends none; 0 in the public and private pages |
| template holes | not restored | VS Code's HTML grammar registration gives the embedded `source.js` none of `javascript`'s `tokenTypes`, so `${` and `}` are String tokens and bracket-pair colorization leaves them to the theme |
| JSDoc brackets | not restored | the same: a `/**` comment is one Comment token |

The theme repo's real-editor `html` cell checks `this`, a template's `${` and
`}`, a JSDoc comment and the uses of an `import * as` namespace against its
register table in both themes, with the HTML server and without it. No page in
the corpora holds an `import * as`; `test/html.test.js` pins that restore too.

## Servers

| Server | What it sends |
|---|---|
| `vscode.html-language-features` | semantic tokens for the JavaScript in scripts and in handler attributes, through its own `html/semanticTokens` request, with TypeScript's legend (12 types, 6 modifiers) and document positions |
| `vscode.css-language-features` | no semantic tokens: its server advertises no `semanticTokensProvider` (vscode-langservers-extracted 4.10.0, the same servers, probed over stdio) |
| `bradlc.vscode-tailwindcss` 0.16.0 | no semantic tokens; grammar injections into `source.css` and `text.html` for its own at-rules |
| `redhat.vscode-xml` 0.29.3 (lemminx 0.31.2) | no semantic tokens: no class in the lemminx jar it bundles refers to them (read 2026-11-11); not installed here. The layer asks no `xml`, `xsl`, `dtd` or `rnc` server anything |

## Real editor

The theme repo's `e2e/` harness (its README § HTML, CSS and XML coverage) drove
this tree in VS Code 1.145.2 on 2026-11-11: 17 launches, 38 min 26 s with the
compiles, every check held. With `handlebars` listed it ran again the same day,
17 launches in 38 min 31 s, with the same counts; no cell opens a `.hbs` page,
which `test/render.test.js` and the HTML walks hold.

| Cell, mode | Survey checks per theme | Focus, Edit and reopen captures | Transition scenarios |
|---|---|---|---|
| `html`, `page.html`, `html-server` | 181 of 181 | 11 of 11 (`tally`, `tally-loop`, `bump`, `module`) | 23 of 23 hold: every code scenario, `markup`, 7 closers (4 in the markup) and a `kill` restart |
| `html`, `page.html`, `off` (`--disable-extension=vscode.html-language-features`) | 181 of 181 | 8 of 8 (`tally`, `bump-off`, `module`) | 22 of 22 hold |
| `html`, `markup.html`, with the server, without it and without Tailwind | 1,634 of 1,634 | none | none |
| `htmltpl`, `view.ejs`, read as `html-template` | 38 of 38 | none: static | 5 of 5 hold |
| `css`, `css-server` and `tailwind-mode` | 2,276 of 2,276 | none: static | 23 of 23 hold in each: the still scenarios in the stylesheet, then the static ones |
| `css`, `no-tailwind` and `off` | 2,276 of 2,276 | none | none |
| `xml`: `feed.xml`, `icon.svg` (opens as `xml`), `feed.xsl` (opens as `xsl`) | 855, 716 and 347 | none: static | 25 of 25 hold in `feed.xml` |

A prototype `tailwind-mode` cell, its static scenarios only, failed all 5 against
the tree before `tailwindcss` was listed, with 11 `phase-differs`: Focus and Edit
where Survey was documented.

## Cost

The view, the per-script lex and the block scan run once per version, on the
synchronous path. Median of 9 calls on fresh strings, three runs, at a load
average of 7 to 8, so a few ms either way is noise:

| File | Static before | Now: view + lex + blocks | The same view as one `.js` file: lex + blocks |
|---|---|---|---|
| Go's `trace_viewer_full.html`, 2,619 kB, one 2,488 kB script | 25 to 30 ms | 7.5 to 8 + 48 to 54 + 12 to 15 ms | 33 to 36 + 8 to 11 ms |
| Zig's `langref.html`, 985 kB, no script | 8 to 13 ms | 8 + 0.5 + 0 ms | — |

The page costs 1.6 times the same code in a `.js` file: the view is built, and
each script's spans and identifiers are copied once more, shifted to the
document. The view blanks the markup run by run; a replace per character took
27 ms on the 985 kB page.

## Known limits

- **A `'</script>'` inside a string** ends the script there, as a browser ends
  it, while the theme's grammar keeps painting JavaScript after it
  ([Script regions](#script-regions)). 23 characters in 1 of 1,819 public files.
- **Module top levels are folded together** with the classic scripts', so a
  focus on a top-level name of one script tints the same name in another, though
  a module's top level is its own scope.
- **A `<script>` inside `<svg>`** is plain text to the grammar and to the layer,
  though a browser runs it and the HTML server types it; 0 in the corpora.
- **Event handlers and `style=""`** get no bands: a handler is a few calls, and
  6 exist in 1,819 public files.
