---
title: "Okibi — field notes"
tags: [okibi, theme, markdown]
rev: 1.8
draft: false
weight: 0x1f
missing: null
---

# Field notes 燠火

Markdown is a **band-1 only** sample. The dynamic focus layer needs brace blocks
or a symbol tree to resolve a scope, and prose has neither, so there are no
identity tints here and the phase stays Survey 構 while the caret moves through
text. That is deliberate: prose is not data flow.

Read the register off this file rather than off the rule list. Every sigil
recedes to n7 ghost, and emphasis carries by WEIGHT: headings, **bold** and table
headers are the prose colour plus weight, never another hue. The only hues prose
is allowed are sora for links and footnotes, ~~the~~ one yamabuki ==highlight==,
and violet for a #tag.

The spec's specimen sets prose one step below primary (n10). This ships at n11
instead, because `editor.foreground` has no per-language override and the
mismatch repainted the whole page when tokenization landed.

The reference render this file is checked against lives in the spec at
`scripts/spec/doc-markdown.html`; `node scripts/md_spec_diff.js` asserts the two
agree token for token.

## Inline vocabulary

Regular prose sits at the primary foreground. *Italic* and **bold** and
***both at once***, plus ~~strikethrough~~ and `inline code`.

A [link with a title](https://example.com "hover me") and a bare autolink
<https://example.com>. A reference-style [link][ref] resolves at the bottom.
A vault link via [[dynamic highlighting]] and an aliased one via
[[phases|the three phases]].

Escapes stay literal: \*not italic\*, \`not code\`, \_not emphasis\_.

Entities render: &amp; &lt; &copy; &mdash; and numeric &#8212;.

Footnote reference[^1] and a second one[^why] resolve at the bottom of the file.

Tags read as nominal categories, not keywords: #okibi #design/system #band-1.
A bare #1 stays prose, and `#define` inside code is never a tag.

The one warm mark in prose is ==a yamabuki highlight==, used sparingly. Two of
them ==on one line== is already ==too many==.

## Headings, all six

# H1 — the largest
## H2
### H3
#### H4
##### H5
###### H6

Setext form, which uses a different scope than `#`:

Alternate H1
============

Alternate H2
------------

## Lists

- unordered, dash
* unordered, asterisk
+ unordered, plus
- nested:
  - second level
    - third level, and a `code span` inside a list item
      1. ordered inside unordered
      2. second

1. ordered
2. second
   1. nested ordered
   10. non-sequential numbering is legal
3. third

Task list — the tick takes ok green, the finished text is struck n8:

- [ ] unchecked, plain prose
- [x] checked, so the text is struck through
- [X] capital X also counts

Definition-style (extension):

Term
: The definition.

## Block quotes

> A single-level quote, receded to n9 — quotation is not focus.
>
> With a second paragraph, **bold inside a quote**, and `code inside a quote`.
>
> > Nested one level deeper.
> >
> > > And deeper still.

> [!note] Callouts stay quiet too
> The type glyph takes the info hue and the title reads as a heading; the body
> stays quote-grey. No filled banners.

> [!warning] A second callout type
> Any `[!word]` is recognised, so warning, tip, caution and danger all work.

## Fenced code

Fenced code keeps the SAME highlighting it would have in its own file — a `.ts`
fence resolves exactly like `sample.ts`. The focus layer engages inside these
too, because each block is a real scope with real semantic tokens.

```go
// Type-shaped words are ALL type slate here: map/struct/chan/interface and the
// predeclared string/int/error/bool. Only func/type/var/const stay keyword grey.
package main

type Config struct {
	Name    string
	Retries int
	Tags    map[string]string
}

func load(name string) (Config, error) {
	cfg := Config{Name: name, Retries: 3}
	if cfg.Retries < 0 {
		return Config{}, errors.New("negative")
	}
	ch := make(chan Config, 1)
	ch <- cfg
	return cfg, nil
}
```

```typescript
// Numbers rest RECEDED in code, because there the identifiers are the content —
// note the literal 1 below versus the clay numbers in the JSON block.
interface Job {
  id: string;
  attempts: number;
}

class Worker {
  private seen = 0;
  private readonly phases = new Map<string, number>();

  async process(job: Job): Promise<void> {
    this.seen += 1;
    this.phases.set(job.id, this.seen);
  }

  get summary(): string {
    return `${this.seen} seen, ${this.phases.size} tracked`;
  }
}
```

```python
def summarize(configs: list[dict], *, limit: int = 10) -> str:
    """Braceless language — scopes come from the symbol tree, not { }."""
    names = [c["name"] for c in configs if c.get("name")]
    return ", ".join(sorted(names)[:limit])
```

```jsonc
{
  // In a data format the numbers ARE the content, so they take clay, not the
  // receded grey a code literal gets.
  "retries": 3,
  "ratio": 0.5,
  "enabled": true,
  "missing": null,
  "nested": { "list": [1, 2, 3] }
}
```

```yaml
# Same rule as JSON: data numerics are clay, booleans stay builtin.
retries: 3
ratio: 0.5
enabled: true
missing: null
```

```diff
--- a/before.txt
+++ b/after.txt
@@ -1,3 +1,3 @@
 unchanged context line
-deleted line
+inserted line
```

```sh
# shell: variables, strings, subshells. The # here is a comment, not a tag.
NAME="okibi"
for f in ./themes/*.json; do
  echo "checking ${f}" && python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$f"
done
```

An indented code block (four spaces) instead of a fence:

    plain preformatted text
    no grammar is applied here

A fence with no language tag:

```
unlabelled fence — plain text, no embedded grammar
```

A fence with a language the editor does not know:

```notalanguage
still renders as a code block, just unhighlighted
```

## Tables

The header row is bold; body cells are plain prose and the rails recede. Inline
markup still works inside a cell.

| left | centred | right | code in cell |
|:-----|:-------:|------:|--------------|
| a | b | 1 | `inline` |
| longer cell | x | 22 | `map[string]int` |
| **bold** | *italic* | 333 | [link](https://example.com) |

Malformed-but-common table (no leading pipe):

column one | column two
---------- | ----------
value      | value

## Horizontal rules

Three forms, all valid:

---

***

___

## HTML passthrough

<div align="center">
  <strong>Raw HTML</strong> is passed through and scoped as HTML.
</div>

<details>
<summary>Collapsed section</summary>

Content inside a `<details>` block, including a fence:

```go
func hidden() {}
```

</details>

An inline <em>HTML element</em> and a self-closing <br/> tag.

## Front matter

The YAML front matter at the top of this file is data, not prose: keys take
member steel, strings wakaba, numbers clay and `false`/`null` the builtin red.
The `---` fences and the `:` separators are furniture like every other sigil.

## Edge cases worth eyeballing

Pipes inside code spans must not break tables: `a | b | c`.

Underscores_inside_words are not emphasis, but *these are*.

A URL with parens in it: [wiki](https://en.wikipedia.org/wiki/Foo_(bar)).

An `==` that is not a highlight: `a == b` in code, and a lone == in prose.

A setext underline must not be eaten by the highlight rule:

Still A Heading
===============

Trailing double-space forces a hard break —  
this line follows the break.

A line ending in a backslash also breaks\
like this.

Unicode and emoji: 構 流 異 — 日本語 — ✓ ✗ → ⇒ ⇐ and :sparkles: shortcodes.

Very long inline code that may wrap:
`this.phases.set(job.id, Phase.Running) /* and a comment inside the span */`.

![an image, whose alt text is a caption and stays prose](assets/seal.png)

[ref]: https://example.com "Reference-style link target"

[^1]: Hierarchy rides lightness and weight; hue marks a few nominal categories.
[^why]: A footnote body recedes to n9, the same step as a blockquote — it is an
    aside, so it should not compete with the sentence that pointed at it.
