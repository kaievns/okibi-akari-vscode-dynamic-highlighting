# PHP and Razor pages

A PHP page's PHP is code to the layer; its markup has no scope. Razor pages are
static content. `src/php.ts` finds the PHP; tests: `test/php.test.js`, the PHP
walks in `test/transitions.test.js`, and the Razor ids in `test/render.test.js`
and `test/rust.test.js`.

## Ids

| Id | Names | Registered by | The layer |
|---|---|---|---|
| `php` | `.php .php4 .php5 .phtml .ctp` | `vscode.php` | code in its PHP regions ([PHP regions](#php-regions)); the markup has no scope |
| `razor` | `.cshtml .razor` | `vscode.razor` | static content |
| `aspnetcorerazor` | `.cshtml .razor` | `ms-dotnettools.csharp` 11.9.40 (its public manifest, 2026-11-12; not installed here) | static content |

Before `php` read its markup as outside every scope, the whole page was one
default-lexer text. In the stub, every click on the 48-line synthetic page entered
Focus, the markup's `items` and `list` took tints, `42` in text took clay, `self`
and `this` in text took the `self` mark, and `$this->async` took the async mark: 11
wrong paints. On the 92 public pages, 5,706 tints covered a variable's `$`, which
the theme paints at the floor, 30 tints and 2 clay numbers landed in the markup, 7
clay numbers in a string and 49 `self` marks on a `self::`. Before `razor` was
listed, the same held for a `.razor` and a `.cshtml` page: `role` and `count` in a
`<p>` tinted, `42` in text clay, `self` and
`this` in text painted. The theme repo's real-editor `php` and `razor` cells showed
it in VS Code 1.145.2 on 2026-11-12: the `self` mark on `self items, this` in a
`<p>`, and Focus and Edit after a click and a keystroke in the markup, 11
`phase-differs` per cell. With `razor` listed, that cell's survey and its 5
static transition scenarios fail 0 checks (2026-11-13).

## PHP regions

A PHP region runs from an open tag to its `?>`, or to the end of the page. The
open tags are the grammar's (`php-tag` in `text.html.php`) and PHP's lexer's with
short tags on: `<?php` before a blank or the end, in any case, `<?=`, and a bare
`<?`, so `<?xml` opens one too. Inside a region a `?>` ends it except in a `'`,
`"` or `` ` `` string (a `{$…}` hole is read as code), a heredoc or nowdoc, or a
`/* */` comment; a `//` or `#` comment ends at a `?>`, and `#[` is an attribute.

On 94 files (the 92 public pages, 91 from `@wordpress/block-library` 12.1.0 and
gettext's `hello.php`, plus `test/fixtures/php/strings.php` and
`test/fixtures/transitions/walk.php`) the regions agree with php-parser 3.7.0's
`tokenGetAll` on every non-space character outside the tags: 472,029 characters,
none in one and not the other.

## The PHP view

`phpView` is `codeView` over the regions: the markup and the tags are blanked,
line breaks kept, and a form feed sits on each open tag's last character and on
each `?` of a `?>`, so `viewRegions` reads the regions back. Unlike a script view,
the view is lexed whole (`lex(view, 'php')`, [lexer.md](lexer.md#per-language-rules)), and
block-scanned whole: a brace opened in one region may close in another, as PHP
reads `<?php if ($x) { ?> … <?php } ?>`. The stripe of such a block covers the
markup between its braces; no tint or mark lands there.

A caret in the markup has no scope: the phase stays or drops to Survey, and a
keystroke there neither engages nor enters Edit, as in HTML
([html.md](html.md#blocks-and-focus)). A `<script>` in a PHP page is markup: a
`<?= ?>` inside it would derail the JavaScript lexer, the reason an `.ejs` page is
static ([html.md](html.md#ids)).

## Data identities and marks

Inside the regions the default family's classification rules hold
([classification-rules.md](classification-rules.md)) over PHP's own comments and
strings, with three changes:

- A tint covers a variable's name; the `$` keeps the theme's floor, as a Ruby
  global's does.
- PHP has no `async` or `await`: no async mark.
- No `self` mark: VS Code's PHP extension sends no semantic tokens, so nothing
  mistypes `self`, and a JavaScript `self` in a script is a plain name.

On the 92 public pages, 2,879 clicks each followed by a keystroke: 5,782 tints,
all on variables (php-parser 3.7.0's `T_VARIABLE`), 76 of them inside a string's
`$name` or `{$…}`; 2 on a `const` name written in one statement and used in
another; 215 clay numbers, all on numbers. No paint lands in the markup, a
comment or a string (0 of 1,702 markup characters; before, 32 in the markup and 7
in a multi-line `'…'` string). The lexer's code, comment and string agree with
`tokenGetAll` on every one of 470,342 non-blank PHP characters of the 94 files
above. VS Code's PHP extension registers no semantic tokens provider; the layer's
requests return nothing and the heuristic paints.

The theme repo's real-editor `php` cell, VS Code 1.145.2, 2026-11-13: a focus item
on the function of `test/fixtures/php/strings.php` painted 0 wrong cells in Focus
and in Edit, and every transition scenario held equal to a fresh render. With the default lexer's rules
inside the regions the same item failed 9 cells in Focus and 7 in Edit: clay on a
number in a `#` comment, a tint on a word in a multi-line `'…'` string, and a
variable in a `"…"` string left untinted.

## Razor

A Razor page interleaves C# and markup by transition rules (`@x`, `@(…)`, `@{ }`,
`@code { }`, `@if (…) { <p>…</p> }`) that no reader here models, so `razor` and
`aspnetcorerazor` are static content. Neither VS Code's Razor grammar nor any
installed server sends tokens for them.

## What full support would need

- **PHP**: PHP's keywords and casts in the classifier and the danger rule,
  `"$x->y"` and `"$x[k]"` holes, `$this` as the self word, the
  `use Foo\Bar;` imports for the import restore, and a server with semantic tokens
  (intelephense or phpactor) for band 2's classes and the escape marks; then
  `<script>` regions with the PHP tags inside them as holes.
- **Razor**: a region reader for Razor's transitions, a C# lexer family, and
  Roslyn's Razor tokens (`ms-dotnettools.csharp` registers `razorTransition`,
  `markupElement` and 60 more types), which mark the regions themselves.
