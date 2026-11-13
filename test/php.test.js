'use strict';
// PHP pages: the PHP between the tags is code, the markup has no scope (docs/php.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');
const php = require('../out/php');
const html = require('../out/html');

const texts = (t) => php.phpRegions(t).map((r) => t.slice(r.start, r.end));

test('a PHP region runs from its open tag to the ?> outside strings, heredocs and block comments', () => {
  const t = [
    '<p>a</p><?php $a = "?>"; $b = \'?>\'; /* ?> */ $c = 1; ?>',
    '<?= $d ?><? $e ?><?PHP $f ?>',
    '<?php $g = 1; // ends here ?> markup',
    '<?php $h = 2; # and here ?> markup',
    '<?php #[Attr("?>")] $i = 3; ?>',
    '<?php $j = <<<EOT',
    'text ?> still a heredoc',
    'EOT;',
    '$k = <<<\'NOW\'',
    '?> nowdoc',
    '  NOW;',
    '$l = "{$m["?>"]}"; ?>',
    '<?phpx not a tag ?>',
    '<?php $tail = 4;',
  ].join('\n');
  assert.deepEqual(texts(t), [
    ' $a = "?>"; $b = \'?>\'; /* ?> */ $c = 1; ',
    ' $d ', ' $e ', ' $f ',
    ' $g = 1; // ends here ',
    ' $h = 2; # and here ',
    ' #[Attr("?>")] $i = 3; ',
    ' $j = <<<EOT\ntext ?> still a heredoc\nEOT;\n$k = <<<\'NOW\'\n?> nowdoc\n  NOW;\n$l = "{$m["?>"]}"; ',
    'phpx not a tag ',
    ' $tail = 4;',
  ]);
});

test('the PHP view keeps every offset and line and blanks the markup and the tags', () => {
  const t = fs.readFileSync(path.join(__dirname, 'fixtures/transitions/walk.php'), 'utf8');
  const view = html.flowText(t, 'php');
  assert.equal(view.length, t.length);
  assert.deepEqual(view.split('\n').length, t.split('\n').length);
  const regions = php.phpRegions(t);
  for (let i = 0; i < t.length; i++) {
    const inside = regions.some((r) => i >= r.start && i < r.end);
    if (inside) assert.equal(view[i], t[i] === '\f' ? ' ' : t[i], `offset ${i}`);
    else assert.ok(/[ \f\n\r]/.test(view[i]), `offset ${i}: ${JSON.stringify(view[i])} is markup`);
  }
  assert.deepEqual(html.viewRegions(view).map((r) => [r.start, r.end]), regions.map((r) => [r.start, r.end]));
});

let seq = 0;
function open(text, line, character) {
  stub.clearLspResponses();
  const doc = new stub.TextDocument(text, 'php', `file:///php-${seq++}.php`);
  const ed = new stub.TextEditor(doc, line, character);
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const d = new Decorator();
  const painted = () => {
    const out = [];
    for (const [type, ranges] of live) {
      const role = type === d.gutterDecoration ? 'gutter' : [...d.pool.id, ...d.pool.idg].includes(type) ? 'tint'
        : Object.keys(d.pool).find((k) => d.pool[k] === type) ?? 'other';
      for (const r of ranges) out.push([role, doc.offsetAt(r.start), doc.offsetAt(r.end)]);
    }
    return out;
  };
  return { doc, ed, d, painted };
}

const PAGE = [
  '<?php',
  'function total(array $xs): int {',
  '    $sum = 0;',
  '    foreach ($xs as $x) { $sum += $x * 42; }',
  '    return $sum;',
  '}',
  'class Card { public $async = 3; function f() { return self::X . $this->async; } }',
  '?>',
  '<h1 class="title">Hello self, this is 42</h1>',
  '<?php if (count($items) > 2) { ?>',
  '  <p>Many items, this is 3.</p>',
  '<?php } ?>',
  '<script>const items = <?= json_encode($items) ?>; function sum(list) { return list.length + 1; }</script>',
  '',
].join('\n');

test('a click in the markup focuses nothing; a click in PHP focuses its block, and nothing paints in the markup', async () => {
  const lines = PAGE.split('\n');
  const markup = (o) => !php.phpRegions(PAGE).some((r) => o >= r.start && o <= r.end);
  for (const [line, word] of [[8, 'Hello'], [10, 'Many'], [12, 'items']]) {
    const s = open(PAGE, line, lines[line].indexOf(word));
    s.d.onSelection({ textEditor: s.ed, selections: s.ed.selections, kind: 2 });
    await s.d.runClassify(s.doc);
    s.d.render();
    assert.equal(s.d.machine.current, Phase.Survey, `line ${line + 1}: a click on ${word} in the markup`);
    assert.deepEqual(s.painted(), [], `line ${line + 1}: nothing painted`);
    const at = s.doc.offsetAt(s.ed.selection.active);
    s.d.onEdit(s.doc.applyEdit(at, at, 'x'));
    assert.equal(s.d.machine.current, Phase.Survey, `line ${line + 1}: typing in the markup engages nothing`);
    s.d.dispose();
  }
  const s = open(PAGE, 3, lines[3].indexOf('$sum'));
  s.d.onSelection({ textEditor: s.ed, selections: s.ed.selections, kind: 2 });
  await s.d.runClassify(s.doc);
  s.d.machine.phase = Phase.Edit;
  s.d.render();
  const got = s.painted();
  const words = (role) => got.filter(([r]) => r === role).map(([, a, b]) => PAGE.slice(a, b));
  assert.ok(words('tint').includes('sum') && words('tint').includes('x'), `the block's variables are tinted, the $ left to the theme: ${words('tint')}`);
  assert.ok(!words('tint').some((w) => w.startsWith('$')), 'no tint covers a $');
  assert.ok(words('numberEngaged').includes('42'), 'and its number is clay');
  assert.deepEqual(got.filter(([r, a]) => r !== 'gutter' && markup(a)), [], 'no paint in the markup');
  assert.deepEqual(words('riskAsync'), [], 'PHP has no async keyword');
  assert.deepEqual(words('self'), [], 'no self restore: no server mistypes it');
  s.d.dispose();
  const m = open(PAGE, 6, lines[6].indexOf('$this'));
  m.d.onSelection({ textEditor: m.ed, selections: m.ed.selections, kind: 2 });
  await m.d.runClassify(m.doc);
  m.d.machine.phase = Phase.Edit;
  m.d.render();
  const roles = new Set(m.painted().map(([r]) => r));
  assert.ok(roles.has('gutter'), 'control: the method is focused');
  assert.ok(!roles.has('riskAsync') && !roles.has('self'), `no async mark on \`$this->async\`, no self mark on \`self::\`: ${[...roles]}`);
  m.d.dispose();
});

const { lex } = require('../out/lex');
const regionsOf = (t) => {
  const lx = lex(html.flowText(t, 'php'), 'php');
  return (word, nth = 0) => {
    let at = -1;
    for (let k = 0; k <= nth; k++) at = t.indexOf(word, at + 1);
    assert.ok(at >= 0, word);
    return lx.regionAt(at);
  };
};

test('PHP lexing: # and // comments end at ?>, #[ is an attribute, strings span lines, heredocs and nowdocs are text', () => {
  const t = [
    '<?php',
    '# hash 1',
    '#[Attr] $a = 2;',
    '$b = 3; // line ?> <p>markup 4</p> <?php $c = 5;',
    "$d = 'one",
    "two 6 \\' still';",
    '$e = <<<EOT',
    '  heredoc 7 $f {$g} EOT x',
    '  EOT;',
    "$h = <<<'NOW'",
    '  nowdoc 8 $i',
    '  NOW;',
    '$j = `ls 9 $k`;',
    '$l = "a \\" {$m[\'q\']} $n->o 10";',
    '?>',
  ].join('\n');
  const at = regionsOf(t);
  assert.equal(at('hash'), 'comment');
  assert.equal(at('Attr'), 'code', '#[ opens an attribute');
  assert.equal(at('line'), 'comment');
  assert.equal(at('$c'), 'code', 'the // comment ends at ?>');
  assert.equal(at('two'), 'string', "a '…' string spans lines");
  assert.equal(at('still'), 'string', "\\' does not close it");
  assert.equal(at('heredoc'), 'string');
  assert.equal(at('EOT x'), 'string', 'the name inside a line closes nothing');
  assert.equal(at('$f'), 'code', 'a heredoc $name is a hole');
  assert.equal(at('$g'), 'code', 'a heredoc {$…} is a hole');
  assert.equal(at('$h'), 'code', 'the heredoc ends at its indented closer');
  assert.equal(at('nowdoc'), 'string');
  assert.equal(at('$i'), 'string', 'a nowdoc has no holes');
  assert.equal(at('$j'), 'code');
  assert.equal(at('$k'), 'code', 'a backtick $name is a hole');
  assert.equal(at('$m'), 'code');
  assert.equal(at("'q'"), 'string', 'a hole lexes its own strings');
  assert.equal(at('$n'), 'code');
  assert.equal(at('10'), 'string');
  const lx = lex(html.flowText(t, 'php'), 'php');
  const nums = lx.numbers.map((r) => t.slice(r.start, r.end));
  assert.deepEqual(nums, ['2', '3', '5'], 'no number in a comment, the markup, a string, a heredoc or a nowdoc');
  const open = '<?php\n$e = <<<EOT\n  text 11 $x';
  const ox = lex(html.flowText(open, 'php'), 'php');
  assert.equal(ox.regionAt(open.indexOf('text')), 'string', 'an unclosed heredoc runs to the end');
  assert.equal(ox.regionAt(open.indexOf('$x')), 'code', 'its last hole included');
  assert.deepEqual(php.phpRegions(open).map((r) => open.slice(r.start)), ['\n$e = <<<EOT\n  text 11 $x']);
});

test('nothing paints in a PHP comment, heredoc, nowdoc or multi-line string; an interpolated variable takes its tint', async () => {
  const t = fs.readFileSync(path.join(__dirname, 'fixtures/php/strings.php'), 'utf8');
  const lines = t.split('\n');
  const line = lines.findIndex((l) => l.includes('$sum = 0;'));
  const s = open(t, line, lines[line].indexOf('$sum'));
  s.d.onSelection({ textEditor: s.ed, selections: s.ed.selections, kind: 2 });
  await s.d.runClassify(s.doc);
  s.d.machine.phase = Phase.Edit;
  s.d.render();
  const lx = lex(html.flowText(t, 'php'), 'php');
  const got = s.painted().filter(([r]) => r !== 'gutter');
  assert.deepEqual(got.filter(([, a]) => !lx.isCode(a)).map(([r, a, b]) => `${r} ${t.slice(a, b)}`), [], 'every paint is on code');
  const sums = got.filter(([r, a, b]) => r === 'tint' && t.slice(a, b) === 'sum').map(([, a]) => s.doc.positionAt(a).line);
  for (const l of lines.map((x, i) => [x, i]).filter(([x]) => /"\{\$sum\}|Sum of items \$sum|`ls \$sum/.test(x)).map(([, i]) => i)) {
    assert.ok(sums.includes(l), `line ${l + 1}: the hole's $sum is tinted with the variable`);
  }
  assert.ok(!sums.includes(lines.findIndex((x) => x.includes('$sum 13 is literal'))), 'a nowdoc $sum is text');
  const clay = got.filter(([r]) => r === 'numberEngaged').map(([, a, b]) => t.slice(a, b));
  assert.deepEqual(clay.sort(), ['0', '0', '2'], `clay on the code numbers only, \`{$items[0]}\`'s included: ${clay}`);
  s.d.dispose();
});

test('a PHP edit that ends or opens a region leaves the lex equal to a fresh lex of the page', async () => {
  const where = PAGE.indexOf('$sum = 0;');
  let compared = 0;
  for (const typed of ['?>', '<?php ', '"', "'", '/*', '#', '<<<EOT\n']) {
    for (const at of [where, where + 3, PAGE.indexOf('<h1'), PAGE.indexOf('<p>')]) {
      const s = open(PAGE, 2, 4);
      s.d.onSelection({ textEditor: s.ed, selections: s.ed.selections, kind: 2 });
      await s.d.runClassify(s.doc);
      s.d.render();
      s.d.onEdit(s.doc.applyEdit(at, at, typed));
      s.ed.selection = new stub.Selection(2, 4, 2, 4);
      s.d.onSelection({ textEditor: s.ed, selections: s.ed.selections, kind: 2 });
      await s.d.runClassify(s.doc);
      s.d.render();
      const view = html.flowText(s.doc.getText(), 'php');
      const key = (x) => JSON.stringify([x.spans, x.idents.map((i) => [i.name, i.offset]), x.numbers, x.punct]);
      assert.equal(key(s.d.blockCache.get(s.doc).lex), key(lex(view, 'php')), `${JSON.stringify(typed)} at ${at}`);
      compared++;
      s.d.dispose();
    }
  }
  assert.equal(compared, 28);
});

test('the region reader, the view, the lex and the block scan stay linear in a page', () => {
  const { growth } = require('./cpu-time');
  const focus = require('../out/focus');
  let seq = 0;
  for (const [head, unit] of [
    ['<?php\n', '// a note\n# a hash\n'],
    ['<?php\n', '$v = 1; // a note\n# a hash\nif ($v) { $w = "a $v {$v}"; /* c */ }\n'],
    ['<p>a</p>\n', '<li><?php if ($x) { ?><b><?= $x ?></b><?php } // done ?></li>\n'],
  ]) {
    const setup = (n) => `${head}${unit.repeat(n)}<!-- ${seq++} -->`;
    const ratio = growth(setup, (t) => {
      const view = html.flowText(t, 'php');
      lex(view, 'php');
      focus.scanBlocks(view, 'php');
    }, 1000);
    assert.ok(ratio < 24, `${JSON.stringify(unit.slice(0, 24))}: 8x the page cost ${ratio.toFixed(1)}x`);
  }
});
