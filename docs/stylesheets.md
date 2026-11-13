# Stylesheets, GraphQL and templates

SCSS, LESS, Sass, Stylus, PostCSS, Tailwind CSS, GraphQL, Handlebars and Razor are
static content (`STATIC_CONTENT_LANGUAGES`, `src/focus.ts`): no blocks, no bands,
no band-1 restore, no server request, the phase held in Survey. A selector, a
property, a preprocessor variable, a mixin, a GraphQL field or variable is no data
identity that flows through a block. Tests: the static ids in
`test/render.test.js` and `test/rust.test.js`, and the sheet walks in
`test/transitions.test.js`. Per-corpus counts:
[stylesheets-measurements.csv](stylesheets-measurements.csv).

## Ids

| Id | Names | Registered by | Server tokens |
|---|---|---|---|
| `scss` | `.scss` | `vscode.scss` | none: the CSS server advertises no provider ([html.md](html.md#servers)) |
| `less` | `.less` | `vscode.less` | none, the same server |
| `sass` | none installed | — | — |
| `stylus` | `.styl .stylus` | `sysoev.language-stylus` 1.16.0 (the theme e2e harness's extensions dir) | none: no semantic tokens code in the client |
| `postcss` | `.css .pcss .postcss` | `csstools.postcss` 1.0.9 (the harness's dir), whose grammar is a second `source.css` | none |
| `tailwindcss` | `.css` under Tailwind's association | `bradlc.vscode-tailwindcss` 0.16.0 | none |
| `graphql` | `.graphql .graphqls .gql` | `GraphQL.vscode-graphql-syntax` 1.3.13, `kumar-harsh.graphql-for-vscode` 1.15.3 | none: graphql-language-service-server, bundled by `GraphQL.vscode-graphql` 1.0.1, advertises symbols, completion, definition and hover only |
| `handlebars` | `.handlebars .hbs .hjs` | `vscode.handlebars` | the HTML server types the JavaScript of a `<script>` (6 tokens on the theme repo's `page.hbs`); asked nothing |
| `razor`, `aspnetcorerazor` | `.cshtml .razor` | [php.md](php.md#ids) | — |

The theme repo's real-editor cells `scss`, `less`, `stylus`, `postcss`,
`tailwind`, `graphql` and `hbs` saw 0 live semantic tokens in every run but
`hbs`, 2026-11-12.

## Before `postcss` was listed

`csstools.postcss` registers `postcss` for `.css` as well, so with it installed a
plain stylesheet can open as `postcss`, which was read as code. Over 150 public
stylesheets, every one of 1,080 clicks entered Focus and every keystroke Edit,
with 1,468 tints on selectors, properties and values, 1,965 clay numbers, hex
colours and units among them, and the `self` mark on a `--self` property. In the
real editor the `postcss` cell painted the `self` mark on `--self` and on a
`.this` class in Survey and failed 11 static steps with `phase-differs`. Listed,
the cell's survey and its 5 static transition scenarios fail 0 checks (VS Code
1.145.2, 2026-11-13).

## In other files

- **A component's `<style lang="scss">`, `"less"`, `"stylus"` or `"postcss"`** is
  markup to the code view ([components.md](components.md#the-code-view)):
  nothing paints there, and a click or a keystroke there stays Survey, in Vue,
  Svelte and Astro alike (`test/components.test.js`). A start tag broken by an edit (`<xstyle lang="less">`)
  turns its body into markup, where a Svelte `{…}` is an expression again, as the
  grammar reads it.
- **A `gql` or `graphql` template in JavaScript or TypeScript** is a template
  literal: its text is a string to the lexer, its `${…}` holes are code, and in
  JavaScript the holes' `${` and `}` take the placeholder restore
  ([javascript.md](javascript.md#band-1-restores)). The 1,080 public documents
  below, each in a `gql` template inside a function, took 0 paints in the GraphQL
  text over 5,250 clicks and keystrokes, beside 8,640 tints and 1,080 clay numbers
  on the function's own code.
- **A markdown fence** (```` ```scss ````, `less`, `stylus`, `postcss`, `mdx`,
  `graphql`, `handlebars`, `hbs`) is code to the markdown marks and nothing else.

## GraphQL variables

A `$id` is a value an operation passes on, so it was measured as a data identity.
In 1,013 public operations (graphql-js's tests and @apollo/client's sources,
every template literal that parses as an executable document, graphql-js 17.1.0) 172
declare variables, 231 in all, and 150 uses follow: 138 variables are used once,
5 two or three times, and 88 never (test documents). 164 of the 172 operations
are 10 lines or fewer. A tint would pair a declaration with one use a few lines
below it; the theme already paints every `$name` alike. Static.

## Tailwind CSS

`tailwindcss` stays static. Tailwind CSS IntelliSense 0.16.0 injects grammar into
`source.css`, `source.css.scss` (its at-rules only), `source.css.postcss`,
`text.html` and the component roots for its at-rules, `@apply`, `theme()` and
`screen()`, and in v4 its own mode reads `@theme`, `@utility`, `@variant`,
`@custom-variant`, `@source`, `@plugin` and `--theme()`; none of it changes what
the layer reads. Class strings in HTML and JSX are strings to the lexer. In the
`tailwind` cell a v4 `@variant` line was struck through with no `ced-` class on
it, so not by the layer (inferred: IntelliSense's `deprecatedAtRule` lint).
