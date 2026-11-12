# Components: JSX, Vue, Svelte and Astro

A Vue, Svelte or Astro component is read as its code view (`flowText`,
`src/html.ts`): the script blocks, the Astro frontmatter and every template
expression are code, the rest is markup and outside every scope, as in an HTML
page ([html.md](html.md)). `src/sfc.ts` finds the regions. JSX and TSX are code
already; their tags are markup inside it. Tests: `test/components.test.js`, the
component walks in `test/transitions.test.js`, the JSX rows in
`test/lexer.test.js` and the React restores in `test/javascript.test.js`.

## Ids

| Id | Names | Registered by | The layer |
|---|---|---|---|
| `javascriptreact` | `.jsx` | `vscode.javascript` | code; tags are markup ([JSX](#jsx)) |
| `typescriptreact` | `.tsx` | `vscode.typescript-basics` | code; tags are markup |
| `vue` | `.vue` | `Vue.volar` 3.3.14 | its code view |
| `svelte` | `.svelte` | `svelte.svelte-vscode` 110.3.2 | its code view |
| `astro` | `.astro` | `astro-build.astro-vscode` 2.17.4 | its code view |
| `markdown` | ```` ```jsx ````, ```` ```tsx ````, ```` ```vue ````, ```` ```svelte ````, ```` ```astro ```` fences | `vscode.markdown` | prose: the two markdown marks only |

`vue-html` (Vue's own template id) stays static content.

## Code regions

| Framework | Code | Pattern: binds the names it holds |
|---|---|---|
| Vue | every `<script>` whose `lang` is empty, `js`, `ts`, `jsx` or `tsx` and that has no `src`; in a `<template>` without `lang` (or `lang="html"`): `{{ … }}` up to the first `}}`, the value of every `v-*`, `:x`, `@x`, `.x` attribute, a dynamic argument's `[key]` | `v-for`'s alias (`(item, i)` before ` in ` or ` of `), the value of `v-slot`, `v-slot:x` and `#x` |
| Svelte | every `<script>` of a JavaScript `lang`; `{…}` in text and in attribute positions, quoted values included (`class="a {b}"`); a block head's expressions: `{#if e}`, `{:else if e}`, `{#each e as …, i (key)}`'s `e` and `key`, `{#await e}`, `{#key e}`, `{@html e}`, `{@render e}`, `{@const …}` from `const`; a value-less `bind:x`, `class:x`, `style:x`'s name | `{#each}`'s alias and index, `{:then v}`, `{:catch e}`, `{#await e then v}`, `{#snippet name(params)}`, name and parameters as one region, `let:x` |
| Astro | the frontmatter, `---` at the file's start to the next line starting `---`; every `<script>` of a JavaScript type (`is:inline` included); `{…}` in text and attribute positions and a template-literal attribute value; JSX inside an expression is lexed as JSX | none |

Not code: comments, `<style>` (its `lang` is step 6b's), a `v-pre` element's
content, a `lang="pug"` template, a CoffeeScript script, `is:raw` content, and
a Svelte block keyword (`#each`, `as`, `:then`). An expression ends where the
JavaScript lexer closes its `{` (`braceExpressionEnd`, `src/lex.ts`): a `}` in a
string, a template or nested JSX does not end it. An expression the scan never
closes is markup until its `}` or `}}` is typed: a `{` typed before a word in
Svelte or Astro, where the editor adds no `}` (svelte.svelte-vscode's
`autoCloseBefore` lists no letter), and a Vue `{{` with no `}}` after it.

**A Vue template ends at the `</template>` its own scan closes**: tags, comments,
quoted values and mustaches are parsed, so a `<template>` inside a comment, an
attribute value or a mustache string counts for nothing, and an end tag matches its
start tag in any case, as `@vue/compiler-sfc` reads both. A `lang="pug"` template is
raw text to its first `</template`, as the compiler reads it. A template the scan
cannot close, a start tag still being typed or a nested `<template>` never closed,
ends at the file's last `</template`, as Vue - Official's grammar reads it, so the
`<script setup>` after it stays code; the compiler reads such a template to the end
of the file.

A snippet's name and its parameters are one pattern region: `row` in
`{#snippet row({ a })}` ends at the `(`, where the parameters' own region would
need its mark. The name, followed by `(`, declares nothing.

**Agreement with each framework's parser** (@vue/compiler-sfc 3.5.45, svelte
5.57.3, @astrojs/compiler-rs 0.5.3), per identifier the lexer finds in the view:

| Corpus | Files | Identifiers in code | In markup | Code identifiers missed |
|---|---|---|---|---|
| Vue | 19 | 247 | 0 | 0 |
| Svelte | 51 [1] | 724 | 0 [2] | 1 (a CoffeeScript script) |
| Astro | 60 | 1,777 | 0 | 0 [3] |

[1] 54 listed; the parser rejects 3 of the grammar samples.
[2] 6 the parser puts in markup: `const` of `{@const}` 4 times (a keyword,
never a candidate) and 2 value-less `style:` directive names, which read the
variable.
[3] 14 reported, all reader artefacts: `#private` names and `{' '}` spacers.

## The code view

The view of [html.md](html.md#the-script-view), with three more marks: a
vertical tab starts a pattern region, `\x0e` and `\x0f` sit on a template block's
opening `{` or `<` and its closing `}` or `>` (`viewBlocks`), and `\x10` takes
`\x0e`'s place for a module block, an Astro client `<script>`. No mark sits on a
line break: a region that starts after one or ends before one takes it in. Each
region is lexed as `javascript` on its own.

## Blocks and focus

| Caret in | Scope |
|---|---|
| markup: text, a tag, an attribute name or string, a comment, `<style>` | none: the phase stays or drops to Survey, typing there enters no Edit |
| a script's or the frontmatter's top level, or a template expression outside a template block | the component's top level: every region's top level together |
| a function, arrow or brace block in a region | that block, as in JavaScript |
| an expression or a pattern inside `{#each}`, `{#await}`, `{#snippet}`, or an element with `v-for`, `v-slot` or `#x` | that template block |
| an Astro client `<script>`'s top level | that script, a module of its own ([Data identities](#data-identities)) |

A focused template block's stripe runs from its opening line to its closing line,
markup lines included (`<p>waiting</p>` in `{#await}`). A script binding and its
template uses are one identity: `count` in `let count = $state(0)` and in `{count}`
share a hue. `{#if}` and `{#key}` bind nothing,
so they are no block. A region block is one level deeper per template block
around it. A pattern region's braces destructure (`{#each rows as { id }}`,
`#header="{ title }"`), so they are no block: read as one, the names they bind
sat in a nested scope at proximity 2 and never painted.

## Data identities

The JavaScript rules ([javascript.md](javascript.md#data-identities)), and:

- **A pattern region declares** its names without a server: `item` and `i` in
  `{#each items as item, i}` or `v-for="(item, i) in items"`, `title` in
  `#header="{ title }"`, `rest` in `{ a, ...rest }`. A key, a default's value and
  a type annotation declare nothing, up to the `,` or bracket that ends them at
  their own depth: `b` in `{ a = f(x, y), b }` binds, `y` does not.
- **A component is not data**: a name used as a capitalised JSX tag, or as the
  capitalised root of a member tag (`<UI.Button>`), on both paths.
- **`Astro`** joins the module surface in `astro`.
- **A shorthand attribute reads its binding**: `<C {open}>` and a value-less
  `bind:open` in `svelte` and `astro`. The servers type both `property
  [declaration]`; the region holds the name alone, so the object-shorthand
  exception ([classification-rules.md](classification-rules.md#the-object-shorthand-exception))
  reads the form feed on each side as its braces. Without a server they were
  reads already.
- **An Astro client script is a module of its own.** It runs in the browser,
  apart from the frontmatter, so a frontmatter `count` and the script's `let
  count` are two identities. Its top level weighs as a top level: a name declared
  there and seen from a handler inside it renders bold, as in the same script
  opened as a `.js` file. Read as a plain template block, it rendered at a
  local's weight.

## JSX

| Before | Now |
|---|---|
| tag-name segments were identifiers, so `<p>` and `<b>` tinted with a local `p` or `b`, and `<Message>` tinted when `Message` was a data binding | tag names are tags (`jsxTags`), not identifiers |
| a JSX expression's `{…}` was a block, so a caret in `{count}` focused one name | its braces delimit markup (`jsxBraces`); the caret focuses the component function |

## Marks

| Mark | Rule |
|---|---|
| clay numbers, escape and async marks | in code regions only: no number in text, CSS or an attribute string paints clay, and `{#await}` is no async mark |
| danger | `vue`, `svelte` and `astro` take TypeScript's rule (`x as T`, `: any`) in every region; Svelte's each `as` is markup |

A write through a top-level ref from a function, `count.value = next` in Vue,
marks: the root is `out`, as for any chained write
([risk-marks.md](risk-marks.md#when-a-write-marks)).

## Band-1 restores

| Restore | `javascriptreact` | `typescriptreact` | `vue` | `svelte` | `astro` |
|---|---|---|---|---|---|
| `this`, keyword grey | yes | yes | in regions | in regions | in regions |
| `import * as NS` uses, type slate | yes, not at a tag | yes, not at a tag | in regions, template expressions included | the same | the same |
| template holes `${` `}` | yes: `javascript`'s language configuration | no | no: the grammar registers no `tokenTypes`, so holes are String tokens | in a JavaScript `<script>` only: the grammar embeds `source.js` there and `source.ts` in every expression | no |
| JSDoc brackets | yes | yes | no: Comment tokens | yes: the grammar's `tokenTypes` match `javascript`'s | no |

The `{` `}` and `{{` `}}` around a template expression render at the bracket
colour in all five ids: bracket-pair colorization paints them from each id's
language configuration, over any TextMate rule. The layer leaves them there, as
JSX's braces have always rendered.

## Measurements

The corpora are public: Vite's `react`, `react-ts`, `preact`, `preact-ts`,
`solid-ts`, `vue`, `vue-ts`, `svelte` and `svelte-ts` templates, `create-vue`
with every option, `create-astro`'s `basics`, `blog`, `portfolio`, `starlight`,
`ssr`, `hackernews`, `with-nanostores` and six `framework-*` examples, the
SvelteKit demo, `create-next-app` and `create-react-router`, all generated
2026-11-11, the 37 grammar samples svelte.svelte-vscode 110.3.2 ships, and the
synthetic fixtures of the theme repo's real-editor cells. 6 private files were
counted only. Rows per corpus and build in
[components-measurements.csv](components-measurements.csv).

The probe drives the layer under the stub: a click at up to 150 identifier
starts per file (200 in JSX), a classify, renders in Focus and Edit, with the
servers' live answers from VS Code 1.145.2 and with none. The reference is each
framework's parser.

| Corpus | Paints outside code before → now, server / none | Requests per click before → now |
|---|---|---|
| Vue, 19 files | 75 / 197 → 0 / 0 | 3.0 → 0.36 |
| Svelte, 51 files | 272 / 541 → 0 / 0 | 3.0 → 0.68 |
| Astro, 60 files | 749 / 1,626 → 0 / 0 | 3.0 → 0.96 |
| JSX and TSX, 27 files | 0 / 2 → 0 / 0 | 3.0 → 3.0 |
| private, 6 files, none | 294 → 0 | 3.0 → 2.3 |

Before, every click in a component focused something, so Survey never held in
markup; now 1,281 of 1,314 Vue, 1,525 of 1,603 Svelte and 3,928 of 4,618 Astro
clicks outside code stay in Survey, and the rest sit in a string or a comment in
code, or in JSX inside an Astro expression.

Tints without a server, by the server's type at each:

| Corpus | Before: data / untyped / not data | Now |
|---|---|---|
| Vue | 38 / 124 / 9 | 61 / 3 / 2 |
| Svelte | 151 / 316 / 13 | 165 / 87 / 5 |
| Astro | 369 / 884 / 60 | 390 / 4 / 1 |
| JSX and TSX | 212 / 5 / 4 | 206 / 3 / 4 |

Svelte's 87 untyped are 62 in the SvelteKit demo, whose `{const …}` tags
svelte-language-server leaves untyped from line 80 on, 21 in the grammar samples,
which it does not type at all, and 4 in the Astro examples.

**Template uses are identities, not noise.** Of the template's data uses the
servers type, 19 of 30 in Vue, 28 of 42 in Svelte and 160 of 214 in Astro read
a script binding; the rest read a template binding (`v-for`, `{#each}`, a `map`
callback's parameter) or a name no token declares.

## Real editor

The theme repo's `e2e/` harness, on a copy with `tsx`, `jsx`, `vue`, `svelte` and
`astro` cells, drove the tree before this change on 2026-11-11 and this tree on
2026-11-12, in VS Code 1.145.2, Okibi only, each server on and off
(`vscode.typescript-language-features` disabled for `tsx` and Vue's `off`, an
unreadable server path for Svelte's and Astro's). The cells' `node_modules` are
links to the public scaffolds above. Failures per cell, Survey, Focus, Edit and
reopen:

| Cell | Before | Now | Left now |
|---|---|---|---|
| `vue`, server / off | 262 / 171 | 1 / 0 | an escape mark on `count.value = next`, a write through a top-level ref ([Marks](#marks)), which the spec leaves out |
| `svelte`, server / off | 15 / 35 | 8 / 4 | 6 and 4 on reopen, `<script module>`'s `<` and `>` on line 1, the same before: the harness's, which exempted the caret's bracket-match colour in the later capture only, where the caret sat at 1:0 in the first; 2 the hue budget (`doubled`) |
| `astro`, server / off | 5 / 27 | 2 / 2 | the hue budget (`html`) |
| `jsx`, tsserver | 70 | 62 | 60 local tints outside a nested function and 2 hue differences, the same kinds before |
| `tsx`, tsserver / off | 36 / 20 | 34 / 18 | the same kinds as before |

Before, the failures were the markup's: `fmt` in a template at the page colour,
`${` `}` and JSDoc braces at the bracket colour in `jsx`, a tint on a `<p>` tag,
attribute names and an interface's members tinted with no server, a `v-for` or
`{#each}` caret focusing the whole file.

Transitions, this tree only: 122 scenario runs, every scenario the harness has
in each of the 8 `tsx`, `vue`, `svelte` and `astro` launches, 1,040,538
characters compared, 2 failed. Both are Svelte's `split`: the harness types
End, space and Backspace at a caret whose line ends in markup, and this tree
holds Survey there, as [Blocks and focus](#blocks-and-focus) says.

The theme repo's own cells (its `e2e/README.md` § Component frameworks coverage)
fix those in the harness and the specs: the reopen check exempts the caret's
match in either capture, `bump` lists the escape, `tinted` only names that win a
hue, and `split`'s target sits in a script. On this tree, 2026-11-12, both
themes, every server on and off, VS Code 1.145.2, the `jsx`, `tsx`, `vue`, `svelte`,
`astro` and `markdown` cells ran 378 runs (50 Survey, 44 Focus, 44 Edit, 30 reopen
and 210 transition scenarios) over 1,779,572 values, and 4 failed: Svelte's and
Astro's `reclose-brace`, server and off, whose specs wanted Edit once a markup
expression's last `}` was deleted. No `}` follows it there, so the expression is now
markup ([Code regions](#code-regions)); with the specs at Survey the 4 runs pass.

## Cost

The view, the per-region lex and the block scan run once per version. Median of
9 calls on fresh strings, the range over 3 runs, load average 4.5 to 5, on the
test fixtures with their templates repeated:

| File | Before: lex + blocks | Now: view + lex + blocks |
|---|---|---|
| Vue, 99 kB, 2,241 lines, one template | 1.5 to 1.7 + 1.4 to 1.6 ms | 2.8 to 3.5 + 1.2 to 2.8 + 4.3 to 5.4 ms |
| Svelte, 115 kB, 5,078 lines | 1.1 to 1.4 + 1.5 to 2.1 ms | 4.0 to 4.7 + 1.2 to 1.3 + 5.1 to 5.6 ms |
| Astro, 153 kB, 4,651 lines | 1.1 to 1.6 + 1.6 to 2.2 ms | 3.3 to 4.3 + 1.9 to 2.5 + 5.9 to 6.7 ms |

`test/components.test.js` holds the region finder, the view and the block scan
linear in the markup: 8 times the markup costs under 24 times as much CPU time
([testing.md](testing.md#timing)). One unit is an unkeyed `{#each}` with no `(` in
the markup after the script: its key search ran back to the file's last `(`, so
`componentRegions` took 3.3, 8.2, 30.6 and 120.1 ms at 1,506, 3,006, 6,006 and
12,006 lines, 4 times per doubling; matched from the head's own `)`, it takes 0.8,
1.2, 1.9 and 3.6 ms (median of 5, 2026-11-12).

## Known limits

- **An each key with no space before its `(`** (`as x(x.id)`) shares the
  alias's region, where `x`, followed by `(`, declares nothing without a server.
- **A `{` typed before a word that a later `}` closes** reads the markup between
  as its expression until its own `}` is typed; a Vue `{{` likewise runs to the
  next `}}`, as Vue's parser reads it.
- **Svelte's quoted `on:click="{…}"`** is read as Svelte 4 reads it; a `}` in a
  string inside a quoted value ends the value's expression.
- **Vue `{{` delimiters** are the defaults; a component's `delimiters` option is
  not read.
- **Svelte module and instance scripts are one top level**, as Svelte scopes
  them, and so are Vue's `<script>` and `<script setup>`.
- **`{@const}` inside `{#if}`**, or directly in a component, belongs to the top
  level: only `{#each}`, `{#await}` and `{#snippet}` are blocks. 0 in the
  corpora, whose 5 `{@const}` tags sit in `{#each}`.
- **A store and its `$store` read are two names**: the lexer reads `$count` as
  one identifier, though Svelte reads `count` through it.
- **A `<script>` inside a Svelte element** (`<svelte:head><script>`) is read as
  a component script, so its top level joins the component's.
- **A Vue prop read in a template** (`{{ title }}`): Volar types it `property`,
  so it gets no tint with the server, and without one it is undeclared and gets
  none either.
- **svelte-language-server 110.3.2 stops typing** the SvelteKit demo's
  `{const}` tags after line 80, so those tints are the heuristic's.
