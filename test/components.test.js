'use strict';
// Vue, Svelte and Astro components and JSX: code regions, scopes and marks (docs/components.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');
const html = require('../out/html');
const sfc = require('../out/sfc');
const focus = require('../out/focus');
const { lexFor, jsxTags } = require('../out/lex');

const FIX = path.join(__dirname, 'fixtures/components');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const regionTexts = (t, lang) => sfc.componentRegions(t, lang).regions.map((r) => `${r.kind === 'pattern' ? '=' : ''}${t.slice(r.start, r.end).trim().split('\n')[0]}`);

// Each list agrees with the framework's own parser (@vue/compiler-sfc 3.5.45, svelte 5.57.3,
// @astrojs/compiler-rs 0.5.3) on every identifier of the file.
test('code regions: scripts, frontmatter and every template expression, patterns marked', () => {
  assert.deepEqual(regionTexts(read('Counter.vue'), 'vue'), [
    'export const LIMIT = 10;', "import { ref, computed, watch } from 'vue';",
    'LIMIT', '{ hot: count > 5 }', 'props.label', 'count', 'fmt.twice(doubled)', 'count === 0', 'count < LIMIT', 'count',
    '=(item, i)', 'items', 'item.id', 'bump(i + 1)', 'i', 'item.name', 'bump(1)', 'count >= LIMIT', 'count = 0', 'count', '`count ${count}`',
    'count', '$attrs', '(v: number) => bump(v)', '={ title }', 'title.toUpperCase()',
  ]);
  assert.deepEqual(regionTexts(read('Counter.svelte'), 'svelte'), [
    'export const LIMIT = 10;', "import { onMount } from 'svelte';",
    'count > 5', 'label', 'count', 'fmt.twice(doubled)', 'count === 0', 'count < LIMIT', 'count',
    'items', '=item, i', 'item.id', 'const label2 = `${i}: ${item.name}`', '() => bump(i + 1)', 'label2',
    'promise', '=value', 'value', '=error', 'error.message', 'count', 'count',
    '() => bump(1)', 'count >= LIMIT', "'add one'", 'count', 'count', '...$$restProps', '(e) => bump(e.detail)', '`<b>${count}</b>`',
  ]);
  assert.deepEqual(regionTexts(read('Card.astro'), 'astro'), [
    "import Layout from './Layout.astro';", 'title', "['card', { hot: total > LIMIT }]", 'label', 'fmt.twice(total)',
    "items.length === 0 && <p>Nothing yet, it's 0.</p>", 'items.map((item, i) => (', 'total', 'title', 'html',
    "total > LIMIT ? 'big' : 'small'", "const button = document.querySelector('h1');",
  ]);
});

test('the code view keeps every offset and line, and reads its regions and blocks back from the marks', () => {
  for (const [f, lang] of [['Counter.vue', 'vue'], ['Counter.svelte', 'svelte'], ['Card.astro', 'astro']]) {
    const t = read(f);
    const v = html.flowText(t, lang);
    const c = sfc.componentRegions(t, lang);
    assert.equal(v.length, t.length, f);
    assert.ok([...v].every((ch, i) => (ch === '\n') === (t[i] === '\n')), `${f}: line breaks`);
    assert.deepEqual(html.viewRegions(v).map((r) => [r.start, r.end, r.kind ?? 'code']), c.regions.map((r) => [r.start, r.end, r.kind]), f);
    assert.deepEqual(html.viewBlocks(v), c.blocks, f);
    for (let i = 0; i < t.length; i++) {
      if (c.regions.some((r) => i >= r.start && i < r.end)) assert.equal(v[i], t[i], `${f}@${i}`);
      else assert.ok(/[ \n\r\f\v\x0e\x0f\x10]/.test(v[i]), `${f}@${i}: ${JSON.stringify(v[i])}`);
    }
  }
});

test('src/sfc.ts loads on its own, before src/html.ts', () => {
  const out = require('child_process').execFileSync(process.execPath, ['-e', "const s = require('./out/sfc'); console.log(s.componentRegions('<p>{a}</p>', 'svelte').regions.length)"], { cwd: path.join(__dirname, '..') });
  assert.equal(String(out).trim(), '1');
});

test('a region never puts a mark on a line break', () => {
  for (const [t, lang] of [['{\ncount}\n<p>{\n  a\n}</p>', 'svelte'], ['<template><p>{{\nx\n}}</p></template>', 'vue'], ['x---\n{a\n}', 'astro']]) {
    const v = html.flowText(t, lang);
    assert.ok([...v].every((ch, i) => (ch === '\n') === (t[i] === '\n')), JSON.stringify(t));
  }
});

test('Svelte: `as` in an each head is no cast; a block, a non-JS script and a style are not code', () => {
  const t = '<script lang="coffee">\n  a = 1\n</script>\n<style>p { margin: 4px; }</style>\n{#each xs as x (x.id)}<p>{x}</p>{:else}<p>none</p>{/each}\n';
  assert.deepEqual(regionTexts(t, 'svelte'), ['xs', '=x', 'x.id', 'x']);
  assert.deepEqual(sfc.componentRegions(t, 'svelte').blocks.map((b) => t.slice(b.open, b.close + 1)), ['{#each xs as x (x.id)}<p>{x}</p>{:else}<p>none</p>{/each}']);
});

test('Vue: v-pre content, a pug template and a src script are not code; a dynamic argument is', () => {
  assert.deepEqual(regionTexts('<template><p v-pre>{{ raw }}</p><a :[key]="v">{{ k }}</a></template>\n<script src="./x.js"></script>', 'vue'), ['key', 'v', 'k']);
  assert.deepEqual(regionTexts('<template lang="pug">p {{ a }}</template>', 'vue'), []);
});

const blockTexts = (t, lang) => sfc.componentRegions(t, lang).blocks.map((b) => t.slice(b.open, b.close + 1));

test('start tags: a self-closing element, unquoted values, quoted Svelte values and an empty comment', () => {
  const vfor = '<template>\n  <Child v-for="x in xs" :k="x" />\n  <p>{{ y }}</p>\n</template>';
  assert.deepEqual(regionTexts(vfor, 'vue'), ['=x', 'xs', 'x', 'y']);
  assert.deepEqual(blockTexts(vfor, 'vue'), ['<Child v-for="x in xs" :k="x" />'], 'a self-closing v-for element is its own block');
  assert.deepEqual(regionTexts('<script src="a.js" /><p>{a}</p>\n<script>let b;</script>', 'svelte'), ['a', 'let b;'], 'a self-closing script holds nothing');
  assert.deepEqual(regionTexts('<template><p :title=msg :id="key">{{ a }}</p><b :x=y>{{ c }}</b></template>', 'vue'), ['msg', 'key', 'a', 'y', 'c']);
  assert.deepEqual(regionTexts('<p class="a {b} c" title=\'{t}\'>{u}</p>', 'svelte'), ['b', 't', 'u']);
  assert.deepEqual(regionTexts('<template><!---->{{ a }}</template>', 'vue'), ['a']);
  assert.deepEqual(regionTexts('<!---->\n<script>let a;</script>', 'vue'), ['let a;']);
  assert.deepEqual(regionTexts('<template><!-- c -->{{ a }}<p>1 <{{ b }} </ 2 {{ c }}</p></template>', 'vue'), ['a', 'b', 'c']);
  assert.deepEqual(regionTexts('<template>\n  <Child><template #a="{ x }">{{ x }}</template></Child>\n  <p>{{ y }}</p>\n</template>', 'vue'), ['={ x }', 'x', 'y'],
    'a nested template is counted to its own close');
  assert.deepEqual(regionTexts('<template><p>{{ a </p></template>\n<script>const o = {x: {y: 1}};</script>', 'vue'), ['const o = {x: {y: 1}};'],
    'an unclosed mustache, as it is typed, is text, and the script after the template stays code');
  const root = '<template><li v-for="x in xs">{{ x }}</li></template>';
  assert.deepEqual(blockTexts(root, 'vue'), ['<li v-for="x in xs">{{ x }}</li>'], 'a v-for element at the template root');
  assert.deepEqual(regionTexts('<!---->{a}<!-- {b} -->', 'svelte'), ['a']);
  assert.deepEqual(regionTexts('<!---->{a}<!-- {b} -->', 'astro'), ['a']);
  for (const lang of ['svelte', 'astro']) assert.deepEqual(regionTexts('<p>1 <{b} < 2 {c}</p>', lang), ['b', 'c'], `${lang}: a < that opens no tag`);
});

test('Vue: the template ends at the `</template>` its own tags close; one in a comment, a value or a mustache counts for nothing', () => {
  const script = '\n<script setup>\nconst a = 1\n</script>\n';
  for (const [inner, want, why] of [
    ['  <!-- <template v-if="old"> -->\n  <p>{{ a }}</p>', ['a'], 'a commented-out <template>'],
    ['  <p title="<template>">{{ a }}</p>', ['a'], 'a <template> in an attribute value'],
    ["  <p>{{ '<template>' }}</p>", ["'<template>'"], 'a <template> in a mustache string'],
    ['  <p>{{ "</template>" }}</p>', ['"</template>"'], 'a </template> in a mustache string'],
    ['  <TemplateRow>{{ a }}</TemplateRow>', ['a'], 'a tag whose name starts with template'],
    ['  <Template #row>{{ a }}</template>\n  <p>{{ b }}</p>', ['a', 'b'], 'a nested template closed in another case, as Vue matches end tags'],
    ['  <p \n', [], 'a start tag still being typed: the last </template> ends the template'],
    ['  <template v-if="x"><p>{{ a }}</p>', ['x', 'a'], 'a nested template never closed: the last </template> ends the template'],
  ]) {
    const t = `<template>\n${inner}\n</template>${script}`;
    assert.deepEqual(regionTexts(t, 'vue'), [...want, 'const a = 1'], why);
  }
  assert.deepEqual(regionTexts('<template>\n  <p>x</p>\n</TEMPLATE>' + script, 'vue'), ['const a = 1'], 'an upper-case </TEMPLATE>');
  assert.deepEqual(regionTexts('<template lang="pug">\np <template> {{ b }}\n</template>' + script, 'vue'), ['const a = 1'], 'a pug template is raw text to its first </template>');
  assert.deepEqual(regionTexts('<template lang="html"><p>{{ b }}</p></template>' + script, 'vue'), ['b', 'const a = 1'], 'lang="html" is a template');
  assert.deepEqual(regionTexts('<template><p>{{ b }}</p>', 'vue'), ['b'], 'a template never closed runs to the end of the file');
  assert.deepEqual(regionTexts("<template><p/></template>\n<script setup>\nconst s = '</template>'\n</script>\n", 'vue'), ["const s = '</template>'"],
    'a </template> in a later script is the script\'s');
  assert.deepEqual(regionTexts('<template>\n  <template #a><p \n  </template>\n  <p>{{ b }}</p>\n</template>' + script, 'vue'), ['b', 'const a = 1'],
    'a tag typed inside a nested template: the last </template> ends the template');
  assert.deepEqual(regionTexts('<template>\n  <template v-if="x"><p/>\n</template>\n<docs><p v-if="b">{{ c }}</p></docs>\n', 'vue'), ['x'],
    'a nested template never closed: the scan stops at the last </template>, and a custom block after it is not code');
  assert.deepEqual(blockTexts('<template><li v-for="x in xs"></b>{{ x }}</li></template>', 'vue'), ['<li v-for="x in xs"></b>{{ x }}</li>'],
    'an end tag that matches no open element closes nothing');
});

test('Vue: a click in a <script setup> after a template with a commented-out <template> focuses and tints the script', async () => {
  const t = '<template>\n  <!-- <template v-if="legacy"> -->\n  <p>{{ count }}</p>\n</template>\n<script setup>\nimport { ref } from "vue"\nconst count = ref(0)\nfunction bump(n) { const next = count.value + n; count.value = next; return next * 2 }\n</script>\n';
  const [line, character] = at(t, 'const next', 'next');
  const h = open(t, 'vue', line, character);
  h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
  assert.equal(h.d.machine.current, Phase.Focus);
  await h.d.runClassify(h.doc);
  h.d.render();
  const tinted = new Set(h.texts([...h.d.pool.id, ...h.d.pool.idg]));
  for (const n of ['n', 'next', 'count']) assert.ok(tinted.has(n), `${n} in ${[...tinted]}`);
  h.d.dispose();
});

test('a `{` or `{{` typed before a word in markup is text until its close is typed: no tint in text, no clay in CSS', async () => {
  const svelte = '<script>\n  let count = $state(0);\n  let items = $state([]);\n</script>\n<h1>{count is high</h1>\n<p>count is {count}</p>\n<ul>\n  {#each items as item}\n    <li>{item}</li>\n  {/each}\n</ul>\n<style>\n  .count { margin: 0 }\n</style>\n';
  assert.deepEqual(regionTexts(svelte, 'svelte'), ['let count = $state(0);', 'count', 'items', '=item', 'item']);
  assert.deepEqual(regionTexts(svelte.replace('{count is', '{#if count is'), 'svelte'), ['let count = $state(0);', 'count', 'items', '=item', 'item']);
  const astro = '---\nconst name = 1;\n---\n<h1>{name</h1>\n<p>{name} 0</p>\n<style>\n  .name { margin: 0 }\n</style>\n';
  assert.deepEqual(regionTexts(astro, 'astro'), ['const name = 1;', 'name']);
  const vue = '<template>\n  <h1>{{count is high</h1>\n  <p :title="count">0</p>\n</template>\n<script setup>\nconst count = 0\n</script>\n<style>\n.count { margin: 0 }\n</style>\n';
  assert.deepEqual(regionTexts(vue, 'vue'), ['count', 'const count = 0']);
  for (const [t, lang, needle, tok] of [[svelte, 'svelte', '<h1>{count', 'count'], [astro, 'astro', '<h1>{name', 'name'], [vue, 'vue', '<h1>{{count', 'count']]) {
    const regions = sfc.componentRegions(t, lang).regions;
    const inside = (o) => regions.some((r) => o >= r.start && o <= r.end);
    for (const tokens of [undefined, serverTokens(t, lang)]) {
      const [line, character] = at(t, needle, tok);
      const h = open(t, lang, line, character, tokens);
      h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
      await h.d.runClassify(h.doc);
      for (const phase of [Phase.Survey, Phase.Focus, Phase.Edit]) {
        h.d.machine.phase = phase;
        h.d.render();
        for (const [s, e] of h.painted()) assert.ok(inside(s) && inside(e), `${lang} ${phase}: "${t.slice(s, e)}" at ${s} is outside every region`);
      }
      h.d.dispose();
    }
  }
});

test('Svelte: an each head splits at its own `as`, outside brackets and words', () => {
  assert.deepEqual(regionTexts('{#each Object.entries({ a: 1 }) as [k, v]}{k}{/each}', 'svelte'), ['Object.entries({ a: 1 })', '=[k, v]', 'k']);
  assert.deepEqual(regionTexts('{#each (xs as Item[]) as x}{x}{/each}', 'svelte'), ['(xs as Item[])', '=x', 'x']);
  assert.deepEqual(regionTexts('{#each alias as a}{a}{/each}', 'svelte'), ['alias', '=a', 'a']);
  assert.deepEqual(regionTexts('{#each xs as x (fn(x))}{x}{/each}', 'svelte'), ['xs', '=x', 'fn(x)', 'x'], 'a key with a call is the whole parenthesised key');
  assert.deepEqual(regionTexts('{#each xs as { a = f(1) }}{a}{/each}', 'svelte'), ['xs', '={ a = f(1) }', 'a'], 'a call in a pattern is no key');
  assert.deepEqual(regionTexts('<p>{f(1)}</p>{#each xs as x}{x}{/each}', 'svelte'), ['f(1)', 'xs', '=x', 'x'], 'a `(` before an unkeyed head is not its key');
  assert.deepEqual(regionTexts("{#each ['a as b'] as s}{s}{/each}", 'svelte'), ["['a as b']", '=s', 's']);
});

test('a pattern declares its bindings, not its keys: `{ id: key }` binds `key`', async () => {
  const t = '<script>\n  let xs = $state([]);\n</script>\n{#each xs as { id: key, name = id }}\n  <p>{key} {id} {name} {key}</p>\n{/each}\n';
  const [line, character] = at(t, '<p>{key}', 'key');
  const h = open(t, 'svelte', line, character);
  h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
  await h.d.runClassify(h.doc);
  h.d.machine.phase = Phase.Focus;
  h.d.render();
  const tinted = new Set(h.texts([...h.d.pool.id, ...h.d.pool.idg]));
  assert.ok(tinted.has('key') && tinted.has('name'), [...tinted].join(' '));
  assert.ok(!tinted.has('id'), `a key is no binding: ${[...tinted]}`);
  h.d.dispose();
});

test('the view reads back every region and block of nested, void, touching and file-start constructs', () => {
  for (const [t, lang] of [
    ['{a}<p>{b}</p>', 'svelte'],
    ['{#each a as x}{#each x as y}<i>{y}</i>{/each}<b on:click={() => x}>{x}</b>{/each}', 'svelte'],
    ['{#each xs as x(x.id)}{x}{/each}', 'svelte'],
    ['<template><input v-for="x in xs" :value="x"><ul v-for="y in ys"><li v-for="z in y">{{ z }}</li></ul></template>', 'vue'],
    ['---\nconst a = 1;\n---\n<script>let b = 2;</script><script>let c;</script>', 'astro'],
  ]) {
    const v = html.flowText(t, lang);
    const c = sfc.componentRegions(t, lang);
    assert.deepEqual(html.viewRegions(v).map((r) => [r.start, r.end, r.kind ?? 'code']), c.regions.map((r) => [r.start, r.end, r.kind]), t);
    assert.deepEqual(html.viewBlocks(v), c.blocks, t);
    for (let k = 1; k < c.regions.length; k++) assert.ok(c.regions[k].start - 1 > c.regions[k - 1].end, `${t}: regions ${k - 1} and ${k} share a mark`);
  }
  assert.deepEqual(regionTexts('{a}<p>{b}</p>', 'svelte'), ['a', 'b'], 'a region at the file\'s second character');
});

test('template blocks nest: an inner block and a region after it are as deep as the blocks around them', () => {
  const t = '{#each a as x}{#each x as y}<i>{() => y}</i>{/each}<b>{() => x}</b>{/each}';
  const blocks = focus.scanBlocks(html.flowText(t, 'svelte'), 'svelte');
  const depthAt = (needle) => blocks.find((b) => b.openOffset === t.indexOf(needle)).depth;
  assert.equal(depthAt('{#each a'), 0);
  assert.equal(depthAt('{#each x'), 1);
  assert.equal(depthAt('() => y'), 2);
  assert.equal(depthAt('() => x'), 1, 'the inner block closed before it');
});

test('the region cache is per language as well as per text', () => {
  const t = '---\nconst a = 1;\n---\n<p>{b}</p>';
  assert.deepEqual(regionTexts(t, 'astro'), ['const a = 1;', 'b']);
  assert.deepEqual(regionTexts(t, 'svelte'), ['b']);
  assert.deepEqual(regionTexts(t, 'astro'), ['const a = 1;', 'b']);
});

test('Svelte: a start tag unclosed at the end of the file opens nothing; `as` is a word of its own', () => {
  assert.deepEqual(regionTexts('{a}<p title={b}', 'svelte'), ['a']);
  assert.deepEqual(regionTexts('{#each ascending as x}{x}{/each}', 'svelte'), ['ascending', '=x', 'x']);
});

test('patterns: a nested key, a default with a call, a spread and a typed parameter declare only their bindings', async () => {
  const t = '<script>\n  let xs = $state([]);\n</script>\n{#each xs as { a: [b], c: d, e = f(g, h), ...rest }}\n  <p>{b} {d} {e} {rest} {a} {c} {g} {h}</p>\n{/each}\n{#snippet row(p: Map<string, number>, ...more)}\n  <td>{p} {more}</td>\n{/snippet}\n';
  for (const [needle, tok, yes, no] of [['<p>{b}', 'b', ['b', 'd', 'e', 'rest'], ['a', 'c', 'f', 'g', 'h']], ['<td>{p}', 'p', ['p', 'more'], ['Map', 'string', 'number']]]) {
    const [line, character] = at(t, needle, tok);
    const h = open(t, 'svelte', line, character);
    h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
    await h.d.runClassify(h.doc);
    h.d.machine.phase = Phase.Focus;
    h.d.render();
    const tinted = new Set(h.texts([...h.d.pool.id, ...h.d.pool.idg]));
    for (const n of yes) assert.ok(tinted.has(n), `${n} in ${[...tinted]}`);
    for (const n of no) assert.ok(!tinted.has(n), `${n} is no binding: ${[...tinted]}`);
    h.d.dispose();
  }
});

test('patterns: a default\'s calls, arrow and typed parameter, a computed key and a parameter\'s type bind nothing', async () => {
  const t = '<script lang="ts">\n  let rows = $state([]);\n</script>\n{#each rows as { a = f(x) + z, b, [k.v]: c, fmt = (n: number) => n + y }}\n  <p>{a} {b} {c} {z} {k} {v} {n} {y} {fmt} {a}</p>\n{/each}\n{#snippet row({ q }: Props, w, p: typeof rows)}\n  <td>{q} {w} {Props} {p} {q}</td>\n{/snippet}\n';
  for (const [needle, tok, yes, no] of [['<p>{a}', 'a', ['a', 'b', 'c', 'fmt'], ['f', 'x', 'z', 'k', 'v', 'n', 'y']], ['<td>{q}', 'q', ['q', 'w', 'p', 'rows'], ['Props']]]) {
    const [line, character] = at(t, needle, tok);
    const h = open(t, 'svelte', line, character);
    h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
    await h.d.runClassify(h.doc);
    h.d.machine.phase = Phase.Focus;
    h.d.render();
    const tinted = new Set(h.texts([...h.d.pool.id, ...h.d.pool.idg]));
    for (const n of yes) assert.ok(tinted.has(n), `${n} in ${[...tinted]}`);
    for (const n of no) assert.ok(!tinted.has(n), `${n} is no binding: ${[...tinted]}`);
    h.d.dispose();
  }
});

test('Vue: a slot template with no value scopes nothing, and a custom block after the template is not code', () => {
  const t = '<template>\n  <Child>\n    <template #footer>{{ count }}</template>\n    <template v-slot:default>x</template>\n  </Child>\n</template>\n<docs><p v-if="b">{{ c }}</p></docs>\n';
  assert.deepEqual(regionTexts(t, 'vue'), ['count']);
  assert.deepEqual(blockTexts(t, 'vue'), []);
});

test('Astro: the frontmatter is code only at the start; a JSX expression ends at its own brace', () => {
  assert.deepEqual(regionTexts('---\nconst a = 1;\n---\n<p>{a}</p>', 'astro').map((s) => s.trim()), ['const a = 1;', 'a']);
  assert.deepEqual(regionTexts("<p>no fm</p>\n---\n{xs.map((x) => <li>it's {x}</li>)}", 'astro'), ["xs.map((x) => <li>it's {x}</li>)"]);
  assert.deepEqual(regionTexts('<script is:inline>let n = 1;</script><script type="application/json">{"a": 1}</script><style>a{}</style>', 'astro'), ['let n = 1;']);
  assert.deepEqual(regionTexts('<pre is:raw>{a} <b title={b}>{c}</b></pre>{d}', 'astro'), ['d'], 'is:raw content is text');
});

// ── the decorator ─────────────────────────────────────────────────────────────

let seq = 0;

/** The component servers' shape: a token on every view name, `component` on a capitalised tag. */
function serverTokens(text, lang) {
  const view = html.flowText(text, lang);
  const toks = [];
  const declared = new Set();
  for (const id of lexFor(view, lang).idents) {
    if (/^(const|let|function|return|if|for|of|in|import|from|export|await|true|false|this|as|new|typeof)$/.test(id.name)) continue;
    const type = view[id.offset + id.length] === '(' ? 'function' : view[id.offset - 1] === '.' ? 'property' : 'variable';
    toks.push({ offset: id.offset, length: id.length, type, modifiers: type === 'variable' && !declared.has(id.name) ? ['declaration'] : [] });
    if (type === 'variable') declared.add(id.name);
  }
  for (const m of text.matchAll(/<\/?([A-Z]\w*)/g)) toks.push({ offset: m.index + m[0].length - m[1].length, length: m[1].length, type: 'component', modifiers: [] });
  return stub.encodeTokens(text, toks.sort((a, b) => a.offset - b.offset));
}

function open(text, lang, line, character, tokens) {
  stub.clearLspResponses();
  if (tokens) stub.setLspResponses({ 'vscode.provideDocumentSemanticTokensLegend': tokens.legend, 'vscode.provideDocumentSemanticTokens': { data: tokens.data } });
  const ext = { vue: 'vue', svelte: 'svelte', astro: 'astro', typescriptreact: 'tsx', javascriptreact: 'jsx' }[lang];
  const doc = new stub.TextDocument(text, lang, `file:///c-${seq++}/a.${ext}`);
  const ed = new stub.TextEditor(doc, line, character);
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  const texts = (types) => types.flatMap((ty) => (live.get(ty) ?? []).map((r) => text.slice(doc.offsetAt(r.start), doc.offsetAt(r.end))));
  return { doc, ed, d, live, texts, painted: () => [...d.pool.all()].flatMap((ty) => (live.get(ty) ?? []).map((r) => [doc.offsetAt(r.start), doc.offsetAt(r.end)])) };
}

const at = (t, needle, tok, nth = 1) => {
  let o = -1;
  for (let k = 0; k < nth; k++) o = t.indexOf(needle, o + 1);
  o += needle.indexOf(tok);
  const line = t.slice(0, o).split('\n').length - 1;
  return [line, o - t.lastIndexOf('\n', o - 1) - 1];
};

test('nothing paints outside a code region, in any phase, with the server and without', async () => {
  let checked = 0;
  for (const [f, lang] of [['Counter.vue', 'vue'], ['Counter.svelte', 'svelte'], ['Card.astro', 'astro']]) {
    const t = read(f);
    const regions = sfc.componentRegions(t, lang).regions;
    const inside = (o) => regions.some((r) => o >= r.start && o <= r.end);
    const lines = t.split('\n');
    for (const tokens of [undefined, serverTokens(t, lang)]) {
      for (let line = 0; line < lines.length; line++) {
        for (const character of [Math.max(0, lines[line].search(/\S/)), Math.floor(lines[line].length / 2)]) {
          const h = open(t, lang, line, character, tokens);
          h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
          await h.d.runClassify(h.doc);
          for (const phase of [Phase.Survey, Phase.Focus, Phase.Edit]) {
            h.d.machine.phase = phase;
            h.d.render();
            for (const [s, e] of h.painted()) {
              assert.ok(inside(s) && inside(e), `${f}:${line + 1} ${phase}: "${t.slice(s, e)}" at ${s} is outside every region`);
              checked++;
            }
          }
          h.d.dispose();
        }
      }
    }
  }
  assert.ok(checked > 1000, `${checked} paints checked`);
});

test('a caret in the markup is Survey and typing there stays Survey; one in an expression focuses and typing enters Edit', () => {
  for (const [f, lang, cases] of [
    ['Counter.vue', 'vue', [['{{ props.label }}', 'props', true], ['<p v-if="count === 0">', 'count', true], ['<p v-else>Full</p>', 'Full', false], ['.counter h1', 'counter', false], [':data-limit', 'data', false], ['<Child :value', 'Child', false]]],
    ['Counter.svelte', 'svelte', [['{label}: {count}', 'label', true], ['{#each items as item', 'each', false], ['{#each items as item', 'items', true], ['<p>Full</p>', 'Full', false], ['on:click={() => bump(i + 1)}', 'click', false], ['.hot { font', 'hot', false]]],
    ['Card.astro', 'astro', [['const LIMIT = 10;', 'LIMIT', true], ['<Layout title={title}>', 'Layout', false], ['{label} ({fmt', 'label', true], ['<Counter client:load', 'client', false], ['Total is {total', 'Total', false]]],
  ]) {
    const t = read(f);
    for (const [needle, tok, code] of cases) {
      const [line, character] = at(t, needle, tok);
      const h = open(t, lang, line, character);
      h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
      assert.equal(h.d.machine.current, code ? Phase.Focus : Phase.Survey, `${f}: click ${tok} in ${needle}`);
      const o = h.doc.offsetAt(h.ed.selection.active);
      h.d.onEdit(h.doc.applyEdit(o, o, 'x'));
      h.ed.selection = new stub.Selection(line, character + 1, line, character + 1);
      h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 1 });
      assert.equal(h.d.machine.current, code ? Phase.Edit : Phase.Survey, `${f}: type at ${tok} in ${needle}`);
      h.d.dispose();
    }
  }
});

test('a script binding and its template uses are one identity: a caret in the template tints the script', async () => {
  for (const [f, lang, needle] of [['Counter.svelte', 'svelte', '{label}: {count}'], ['Counter.vue', 'vue', '{{ count }} ({{'], ['Card.astro', 'astro', '{label} ({fmt']]) {
    const t = read(f);
    const [line, character] = at(t, needle, lang === 'vue' ? 'count' : 'label');
    for (const tokens of [undefined, serverTokens(t, lang)]) {
      const h = open(t, lang, line, character, tokens);
      h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
      await h.d.runClassify(h.doc);
      h.d.machine.phase = Phase.Focus;
      h.d.render();
      const name = lang === 'vue' ? 'count' : 'label';
      const lines = new Set();
      const types = new Set();
      for (const ty of [...h.d.pool.id, ...h.d.pool.idg]) {
        for (const r of h.live.get(ty) ?? []) {
          if (t.slice(h.doc.offsetAt(r.start), h.doc.offsetAt(r.end)) !== name) continue;
          lines.add(r.start.line);
          types.add(ty);
        }
      }
      assert.ok(lines.has(line) && Math.min(...lines) < line, `${f} ${tokens ? 'server' : 'heuristic'}: ${name} tinted on ${[...lines]}`);
      assert.equal(types.size, 1, `${f}: one hue`);
      h.d.dispose();
    }
  }
});

test('an Astro <script> is a scope of its own: the frontmatter and the client script share no names', async () => {
  const t = '---\nconst count = 1;\n---\n<p>{count}</p>\n<script>\n  let count = 0;\n  count += 1;\n</script>\n';
  const [line, character] = at(t, '<p>{count}', 'count');
  const h = open(t, 'astro', line, character);
  h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
  await h.d.runClassify(h.doc);
  h.d.machine.phase = Phase.Focus;
  h.d.render();
  const lines = [...h.d.pool.id, ...h.d.pool.idg].flatMap((ty) => (h.live.get(ty) ?? []).map((r) => r.start.line));
  assert.deepEqual([...new Set(lines)].sort(), [1, 3], 'the frontmatter and the template only');
  h.d.dispose();
});

test('a caret inside {#each} or a v-for element focuses that block, and its alias is data without a server', async () => {
  for (const [f, lang, needle, tok, names] of [
    ['Counter.svelte', 'svelte', '>{label2}</li>', 'label2', ['i', 'item', 'label2']],
    ['Counter.vue', 'vue', '{{ i }}: {{ item.name }}', 'item', ['i', 'item']],
  ]) {
    const t = read(f);
    const [line, character] = at(t, needle, tok);
    const h = open(t, lang, line, character);
    h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
    await h.d.runClassify(h.doc);
    h.d.machine.phase = Phase.Focus;
    h.d.render();
    const tinted = new Set(h.texts([...h.d.pool.id, ...h.d.pool.idg]));
    for (const n of names) assert.ok(tinted.has(n), `${f}: ${n} in ${[...tinted]}`);
    const block = focus.scanBlocks(html.flowText(t, lang), lang).find((b) => b.openOffset === sfc.componentRegions(t, lang).blocks[0].open);
    assert.ok(block, `${f}: the template block is a block`);
    h.d.dispose();
  }
});

test('a pattern\'s braces destructure: no block of their own, and a caret in the template block tints the names they bind', async () => {
  const sv = '<script>\n  let rows = $state([]);\n</script>\n{#each rows as { id, name }, i (id)}\n  <p>{name} {i} {id}</p>\n{/each}\n{#snippet row({ a, b })}\n  <td>{a}{b}</td>\n{/snippet}\n';
  const vue = '<template>\n  <li v-for="({ id, name }, i) in rows">{{ name }} {{ id }} {{ i }}</li>\n</template>\n<script setup>\nconst rows = [];\n</script>\n';
  for (const [t, lang, needle, tok, names] of [
    [read('Counter.vue'), 'vue', '{{ title.toUpperCase', 'title', ['title']],
    [vue, 'vue', '{{ name }}', 'name', ['id', 'name', 'i']],
    [sv, 'svelte', '{name} {i}', 'name', ['id', 'name', 'i']],
    [sv, 'svelte', '<td>{a}', 'a', ['a', 'b']],
  ]) {
    const view = html.flowText(t, lang);
    const patterns = html.viewRegions(view).filter((r) => r.kind === 'pattern');
    for (const b of focus.scanBlocks(view, lang)) {
      assert.ok(!patterns.some((r) => b.openOffset >= r.start && b.openOffset < r.end), `${lang}: a block opens in the pattern at ${b.openOffset}`);
    }
    const [line, character] = at(t, needle, tok);
    const h = open(t, lang, line, character);
    h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
    await h.d.runClassify(h.doc);
    h.d.machine.phase = Phase.Focus;
    h.d.render();
    const tinted = [...h.d.pool.id, ...h.d.pool.idg].flatMap((ty) => (h.live.get(ty) ?? []).map((r) => `${text(t, h.doc, r)}@${r.start.line}`));
    for (const n of names) {
      const declLine = t.slice(0, patterns.find((r) => new RegExp(`\\b${n}\\b`).test(view.slice(r.start, r.end))).start).split('\n').length - 1;
      assert.ok(tinted.includes(`${n}@${declLine}`) && tinted.includes(`${n}@${line}`), `${lang} ${needle}: ${n} in ${tinted}`);
    }
    h.d.dispose();
  }
});

const text = (t, doc, r) => t.slice(doc.offsetAt(r.start), doc.offsetAt(r.end));
/** `kind name@line` for every tint, the line relative to `from`. */
const tintKinds = (h, t, from) => [['id', h.d.pool.id], ['idg', h.d.pool.idg]].flatMap(([kind, types]) => types.flatMap((ty) => (h.live.get(ty) ?? []).map((r) => `${kind} ${text(t, h.doc, r)}@${r.start.line - from}`))).sort();

// A client script is a browser module apart from the frontmatter, so it is a block; its top level still weighs as one.
test('an Astro client script\'s top level is a top level: the tiers a caret sees are the same script\'s as a .js file', async () => {
  const script = "  const button = document.querySelector('h1');\n  let clicks = 0;\n  button?.addEventListener('click', () => {\n    clicks += 1;\n    for (const n of [1, 2]) clicks += n;\n  });\n  if (clicks) {\n    clicks = button ? 2 : 3;\n  }\n";
  const t = `---\nconst clicks = 1;\n---\n<p>{clicks}</p>\n<script>\n${script}</script>\n`;
  for (const [needle, tok] of [['clicks += 1;', 'clicks'], ['let clicks', 'clicks'], ['clicks += n', 'clicks'], ['clicks = button', 'clicks']]) {
    const kinds = [];
    for (const [src, lang, from] of [[t, 'astro', 5], [script, 'javascript', 0]]) {
      const [line, character] = at(src, needle, tok);
      const h = open(src, lang, line, character);
      h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
      await h.d.runClassify(h.doc);
      h.d.machine.phase = Phase.Focus;
      h.d.render();
      kinds.push(tintKinds(h, src, from).map((k) => k.replace(/ (\w+)@/, (m, n) => ` ${n}@`)));
      h.d.dispose();
    }
    const names = (ks) => ks.map((k) => k.replace(/^(id|idg) /, ''));
    assert.ok(kinds[0].length > 0, needle);
    assert.deepEqual(kinds[0].map((k) => k.split(' ')[0] + ' ' + k.split(' ')[1].split('@')[0]).filter((v, i, a) => a.indexOf(v) === i),
      kinds[1].map((k) => k.split(' ')[0] + ' ' + k.split(' ')[1].split('@')[0]).filter((v, i, a) => a.indexOf(v) === i), `${needle}: the tier of each name`);
    assert.deepEqual(names(kinds[0]), names(kinds[1]), `${needle}: the same occurrences`);
  }
});

/** The servers' shape at a shorthand: `property` with `declaration` on a tag's `{name}` or value-less `bind:name`. */
function shorthandTokens(t, lang) {
  const view = html.flowText(t, lang);
  const toks = [];
  const declared = new Set();
  for (const id of lexFor(view, lang).idents) {
    if (/^(let|const|import|from|export)$/.test(id.name)) continue;
    const inTag = /<\w[^>]*$/.test(t.slice(0, id.offset)) && (view[id.offset - 1] === '\f' || /bind:$/.test(t.slice(0, id.offset)));
    const type = inTag ? 'property' : view[id.offset + id.length] === '(' ? 'function' : 'variable';
    const modifiers = id.name === 'Astro' ? ['readonly'] : inTag || (type === 'variable' && !declared.has(id.name)) ? ['declaration'] : [];
    toks.push({ offset: id.offset, length: id.length, type, modifiers });
    if (type === 'variable') declared.add(id.name);
  }
  return stub.encodeTokens(t, toks);
}

test('a Svelte or Astro shorthand attribute, typed `property` by the server, reads its binding; a Vue prop in a template stays a member', async () => {
  for (const [t, lang, needle, tok, want] of [
    ['<script>\n  let { open, label } = $props();\n  let value = $state(1);\n</script>\n<Child {open} { label } bind:value />\n<p>{open} {label} {value}</p>\n', 'svelte', '<p>{open}', 'open',
      ['open@1', 'open@4', 'open@5', 'label@1', 'label@4', 'label@5', 'value@2', 'value@4', 'value@5']],
    ['---\nconst { open } = Astro.props;\n---\n<Child {open} />\n<p>{open}</p>\n', 'astro', '<p>{open}', 'open', ['open@1', 'open@3', 'open@4']],
    ['<script setup>\nconst props = defineProps(["title"]);\nconst count = 1;\n</script>\n<template>\n  <p>{{ title }} {{ count }} {{ title }}</p>\n</template>\n', 'vue', '{{ count }}', 'count', ['props@1', 'count@2', 'count@5']],
  ]) {
    const tokens = lang === 'vue'
      ? (() => {
        const view = html.flowText(t, lang);
        const toks = lexFor(view, lang).idents.filter((id) => !/^(const|defineProps)$/.test(id.name)).map((id) => ({
          offset: id.offset, length: id.length, type: id.name === 'title' && id.offset > t.indexOf('<template>') ? 'property' : 'variable', modifiers: id.offset < t.indexOf('</script>') ? ['declaration'] : [],
        }));
        return stub.encodeTokens(t, toks);
      })()
      : shorthandTokens(t, lang);
    const [line, character] = at(t, needle, tok);
    const h = open(t, lang, line, character, tokens);
    h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
    await h.d.runClassify(h.doc);
    h.d.machine.phase = Phase.Focus;
    h.d.render();
    const got = [...h.d.pool.id, ...h.d.pool.idg].flatMap((ty) => (h.live.get(ty) ?? []).map((r) => `${text(t, h.doc, r)}@${r.start.line}`));
    assert.deepEqual(got.sort(), [...want].sort(), lang);
    h.d.dispose();
  }
});

test('the region finder, the view and the block scan stay linear in the markup', () => {
  const { growth } = require('./cpu-time');
  let seq = 0;
  for (const [lang, head, unit, tail] of [
    ['svelte', '<script>let a = {x: 1};</script>\n', '<div class="a b"><span title="t">text</span></div>\n{#each xs as {a, b}}<p class="c {b}" on:click={() => f(a)}>{a}</p>{/each}\n', ''],
    ['svelte', '<script>\n  onMount(() => f(a));\n</script>\n', '<section>\n  {#each items as item}\n    <a href="/x/{item.slug}">{item.name}</a>\n  {/each}\n</section>\n', ''],
    ['vue', '<template>\n', '<div class="a"><span>text</span></div>\n<li v-for="({a}, i) in xs" :k="i"><b @click="f(a)">{{ a }}</b></li>\n', '</template>\n<script setup>\nconst a = {x: 1};\n</script>\n'],
    ['astro', '---\nconst a = {x: 1};\n---\n', '<div class="a"><span>text</span></div>\n<li data-x={a}>{xs.map((x) => <b>{x}</b>)}</li>\n<script>let c = 1;</script>\n', ''],
  ]) {
    const setup = (n) => `${head}${unit.repeat(n)}${tail}<!-- ${seq++} -->`;
    const ratio = growth(setup, (t) => focus.scanBlocks(html.flowText(t, lang), lang), 300);
    assert.ok(ratio < 24, `${lang}: 8x the markup cost ${ratio.toFixed(1)}x`);
  }
});

test('JSX: only a tag\'s root names a component; a lone self-closing component tag counts', async () => {
  const t = "export function Row() {\n  const Item = [1];\n  const Rect = [2];\n  const Thing = [3];\n  return [<UI.Item a={Item} />, <svg:Rect b={Rect} />, <x-Thing c={Thing} />, Item, Rect, Thing];\n}\n";
  for (const lang of ['javascriptreact', 'typescriptreact']) {
    const [line, character] = at(t, 'const Item', 'Item');
    const h = open(t, lang, line, character);
    h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
    await h.d.runClassify(h.doc);
    h.d.machine.phase = Phase.Focus;
    h.d.render();
    const tinted = new Set(h.texts([...h.d.pool.id, ...h.d.pool.idg]));
    for (const n of ['Item', 'Rect', 'Thing']) assert.ok(tinted.has(n), `${lang}: ${n} after a dot, a colon or a dash is no component: ${[...tinted]}`);
    h.d.dispose();
    const lone = 'export function Row() {\n  const Message = load();\n  const n = Message.length;\n  return [n, Message, <Message />];\n}\n';
    const h2 = open(lone, lang, ...at(lone, 'const n', 'n'));
    h2.d.onSelection({ textEditor: h2.ed, selections: h2.ed.selections, kind: 2 });
    await h2.d.runClassify(h2.doc);
    h2.d.machine.phase = Phase.Focus;
    h2.d.render();
    const got = new Set(h2.texts([...h2.d.pool.id, ...h2.d.pool.idg]));
    assert.ok(got.has('n') && !got.has('Message'), `${lang}: the file's one tag makes Message a component: ${[...got]}`);
    h2.d.dispose();
  }
});

test('JSX: a tag is not a name, so a local named like a tag stays apart, and a component is not data', async () => {
  const t = "const Message = lazy(() => import('./m'));\nexport function Row({ p, b }) {\n  const i = p + b;\n  return <p className=\"row\"><b>{i}</b><Message>{p}</Message></p>;\n}\n";
  for (const lang of ['javascriptreact', 'typescriptreact']) {
    assert.deepEqual(jsxTags(lexFor(t, lang)).map((x) => x.name), ['p', 'b', 'b', 'Message', 'Message', 'p']);
    const [line, character] = at(t, '{i}', 'i');
    const h = open(t, lang, line, character);
    h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
    await h.d.runClassify(h.doc);
    h.d.machine.phase = Phase.Focus;
    h.d.render();
    const got = h.live;
    const tinted = [...h.d.pool.id, ...h.d.pool.idg].flatMap((ty) => (got.get(ty) ?? []).map((r) => `${r.start.line}:${r.start.character}`));
    const tagLine = t.split('\n')[3];
    for (const k of [tagLine.indexOf('<p') + 1, tagLine.indexOf('<b>') + 1, tagLine.indexOf('</b>') + 2, tagLine.lastIndexOf('</p>') + 2]) {
      assert.ok(!tinted.includes(`3:${k}`), `${lang}: tag at 3:${k} tinted`);
    }
    assert.ok(tinted.includes(`3:${tagLine.indexOf('{p}') + 1}`), `${lang}: {p} is tinted`);
    assert.ok(!h.texts([...h.d.pool.id, ...h.d.pool.idg]).includes('Message'), `${lang}: Message is a component`);
    h.d.dispose();
  }
});

test('Astro: the Astro global is library surface, and a TS cast in a component script is a danger mark', async () => {
  const t = '---\nconst { title } = Astro.props;\nconst n = title as unknown as number;\n---\n<h1>{title}</h1>\n';
  const [line, character] = at(t, 'const n', 'n');
  const h = open(t, 'astro', line, character);
  h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
  await h.d.runClassify(h.doc);
  h.d.machine.phase = Phase.Edit;
  h.d.render();
  assert.ok(!h.texts([...h.d.pool.id, ...h.d.pool.idg]).includes('Astro'));
  assert.deepEqual(h.texts([h.d.pool.riskDanger]), ['as', 'as']);
  h.d.dispose();
  const s = '<script lang="ts">\n  let xs = $state([1]);\n</script>\n{#each xs as x}<p>{x}</p>{/each}\n';
  const h2 = open(s, 'svelte', 1, 6);
  h2.d.onSelection({ textEditor: h2.ed, selections: h2.ed.selections, kind: 2 });
  await h2.d.runClassify(h2.doc);
  h2.d.machine.phase = Phase.Edit;
  h2.d.render();
  assert.deepEqual(h2.texts([h2.d.pool.riskDanger]), [], 'each `as` is markup');
  h2.d.dispose();
});

// VS Code 1.145.2, measured in the real editor: Svelte's grammar embeds `source.js` with `javascript`'s token types in a
// JavaScript <script> only; Vue's and Astro's grammars register no token types, so holes and JSDoc are String and Comment tokens.
test('band 1: holes restored in a Svelte JavaScript script only, its template and TypeScript scripts left to the theme', () => {
  const t = '<script>\n  const a = `x ${1}`;\n</script>\n<script lang="ts" context="module">\n  const b = `y ${2}`;\n</script>\n{`z ${3}`}\n';
  const h = open(t, 'svelte', 0, 0);
  h.d.render();
  assert.deepEqual(h.live.get(h.d.pool.placeholder).map((r) => `${r.start.line}:${t.slice(h.doc.offsetAt(r.start), h.doc.offsetAt(r.end))}`), ['1:${', '1:}']);
  h.d.dispose();
});

test('band 1: the namespace restore reaches template expressions; JSDoc brackets in Svelte only; no hole restore in a component', async () => {
  for (const [f, lang, jsdoc] of [['Counter.vue', 'vue', false], ['Counter.svelte', 'svelte', true], ['Card.astro', 'astro', false]]) {
    const t = read(f).replace('let changes = 0;', '/** @type {number} */\nlet changes = 0;').replace('const LIMIT = 10;', '/** @type {number} */\nconst LIMIT = 10;');
    const h = open(t, lang, 0, 0);
    h.d.render();
    assert.deepEqual(h.texts([h.d.pool.importRestore]), ['fmt'], `${f}: the template's fmt.twice`);
    assert.deepEqual(h.texts([h.d.pool.commentRestore]).length > 0, jsdoc, `${f}: JSDoc`);
    assert.deepEqual(h.texts([h.d.pool.placeholder]), [], `${f}: holes`);
    h.d.dispose();
  }
});

test('a ```jsx, ```tsx, ```vue, ```svelte or ```astro fence in markdown is prose', async () => {
  const t = '# x\n\n```svelte\n<script>let n = 1;</script>\n{n}\n```\n\n```vue\n<template>{{ n }}</template>\n```\n\n```astro\n---\nconst n = 1;\n---\n<p>{n}</p>\n```\n\n```jsx\nconst n = 1;\nconst e = <p>{n}</p>;\n```\n\n```tsx\nconst f = <T,>(n: T) => <p>{n}</p>;\n```\n';
  const lines = t.split('\n');
  for (let line = 0; line < lines.length; line++) {
    if (!/\bn\b/.test(lines[line])) continue;
    const h = open(t, 'markdown', line, lines[line].search(/\bn\b/));
    h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
    await h.d.runClassify(h.doc);
    assert.equal(h.d.machine.current, Phase.Survey, lines[line]);
    h.d.machine.phase = Phase.Edit;
    h.d.render();
    assert.deepEqual([...h.d.pool.banded()].flatMap((ty) => h.live.get(ty) ?? []), [], lines[line]);
    h.d.dispose();
  }
});
