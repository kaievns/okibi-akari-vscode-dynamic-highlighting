'use strict';
// Ruby: the lexer, the keyword block scan, the bindings, both classifiers, escape marks
// and the shadow restore, on samples/sample.rb and ruby-lsp 0.26.11 tokens for it.
// Rules: docs/ruby.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
const { lexFor } = require('../out/lex');
const focus = require('../out/focus');
const risk = require('../out/risk');
const { Classifier } = require('../out/classify-lsp');
const { rubyFacts, rubyShadowSpans, rubyEscapeRisk } = require('../out/ruby');
const { rubyPlaceholderSpans } = require('../out/placeholders');
const { Decorator } = require('../out/decorator');
const { growth } = require('./cpu-time');

const SRC = fs.readFileSync(path.join(__dirname, '../samples/sample.rb'), 'utf8');
const RUBY_LSP = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample.rb.lsp.json'), 'utf8'));
const lineOf = (text, needle, nth = 1) => {
  let at = -1;
  for (let i = 0; i < nth; i++) at = text.indexOf(needle, at + 1);
  assert.ok(at >= 0, `needle ${needle}`);
  return text.slice(0, at).split('\n').length - 1;
};
const regions = (text) => lexFor(text, 'ruby').spans.map((s) => `${s.region}:${text.slice(s.start, s.end)}`);
const idents = (text) => lexFor(text, 'ruby').idents.map((i) => i.name);

test('ruby lexer: # and =begin comments, __END__ data; # inside literals is text', () => {
  const t = ['x = 1 # note', '=begin', 'def not_code; end', '=end', 'y = "a # b" + %w[c #d] + ?#', ' =begin not a comment', '__END__', 'data "q" #{z}'].join('\n');
  assert.deepEqual(regions(t), [
    'comment:# note', 'comment:=begin\ndef not_code; end\n=end', 'string:"a # b"', 'string:%w[c #d]', 'string:?#', 'comment:data "q" #{z}',
  ]);
  assert.deepEqual(idents(t), ['x', 'y', 'begin', 'not', 'a', 'comment', '__END__']);
});

test('ruby lexer: interpolation holes in "…", `…`, %Q, %W, %r, :"…" and heredocs; #@x, #$x; none in \'…\', %q, %w', () => {
  const t = 'a = "#{b} #@c #$d" + `#{e}` + %Q{#{f} {n}} + %r{#{g}}x + :"#{h}" + \'#{no}\' + %q(#{no}) + %w[#{no}]';
  const lx = lexFor(t, 'ruby');
  assert.deepEqual(lx.holes.map((h) => t.slice(h.start, h.end)), ['b', '@c', '$d', 'e', 'f', 'g', 'h']);
  assert.deepEqual(idents(t), ['a', 'b', '@c', '$d', 'e', 'f', 'g', 'h']);
});

test('ruby lexer: heredocs, several per line, squiggly, dash and quoted, bodies read from the next line', () => {
  const t = 'a, b = <<~A, <<-\'B\'\n  #{x} end\nA\n  #{not_code}\n  B\nfoo(<<~SQL.strip)\n  SELECT\nSQL\nz = 1\n';
  assert.deepEqual(regions(t), [
    'string:<<~A', "string:<<-'B'", 'string:\n  #{', 'string:} end\nA', 'string:\n  #{not_code}\n  B', 'string:<<~SQL', 'string:\n  SELECT\nSQL',
  ].map((r) => r.replace('string:\n', 'string:')));
  assert.deepEqual(idents(t), ['a', 'b', 'x', 'foo', 'strip', 'z']);
});

test('ruby lexer: regex where an expression starts or as a command argument, division after an operand', () => {
  const t = 'a = b / c / d\ne = x.split /,/\nf = [/re/, 2]\nk %= 3\nm = n % 2\nputs %w[q]\nr = s ? 1 : 2';
  assert.deepEqual(regions(t), ['string:/,/', 'string:/re/', 'string:%w[q]']);
});

test('ruby lexer: symbols, labels, $-globals, @ivars and method names with ? and !', () => {
  const t = 'h = { a: :b, "c": :"d", e => :+, f: :[]= }\nx.empty? ? $" : $0\n@y = @@z\nsave! unless a::B\nx ? y : z';
  assert.deepEqual(regions(t), ['string::b', 'string:"c":', 'string::"d"', 'string::+', 'string::[]=']);
  assert.deepEqual(idents(t), ['h', 'a', 'e', 'f', 'x', 'empty?', '$"', '$0', '@y', '@@z', 'save!', 'unless', 'a', 'B', 'x', 'y', 'z']);
});

test('ruby lexer: operator method names after def are names, not literals', () => {
  assert.deepEqual(regions('def `(cmd) = cmd\ndef %(x) = x\ndef self./(o) = o\ndef fmt.%(x) = x\n'), []);
});

test('ruby lexer edges: operator names with @, CRLF and =endless in =begin, ?-method command args, char and ternary', () => {
  assert.deepEqual(idents('def -@\nend\ndef +@ = self\n'), ['def', 'end', 'def', 'self']);
  assert.deepEqual(regions('x = 1\r\n=begin\r\nnot code\r\n=end\r\ny\r\n'), ['comment:=begin\r\nnot code\r\n=end']);
  assert.deepEqual(regions('=begin\n=endless\nstill\n=end\nx\n'), ['comment:=begin\n=endless\nstill\n=end']);
  assert.deepEqual(regions('x = valid? %w[a b]\ny = save! /re/\n'), ['string:%w[a b]', 'string:/re/']);
  assert.deepEqual(regions('c = ?\\n + ?a\n'), ['string:?\\n', 'string:?a']);
  assert.deepEqual(regions('x = flag ?yes : no\nh = {a:b, c:d}\n'), [], 'a ternary and bare labels open nothing');
});

test('ruby lexer edges: %x holes, nested delimiters, a bare #@ or #$, labels after { ( and a line break, a bare <<ID heredoc', () => {
  assert.deepEqual(lexFor('o = %x(ls #{dir})\n', 'ruby').holes.map((h) => 'o = %x(ls #{dir})\n'.slice(h.start, h.end)), ['dir']);
  assert.deepEqual(regions('a = %q(a (b) c) + %w<x <y> z> + %Q{p {q} r}\n'), ['string:%q(a (b) c)', 'string:%w<x <y> z>', 'string:%Q{p {q} r}']);
  assert.deepEqual(regions('s = "a #@ b #$ c"\n'), ['string:"a #@ b #$ c"']);
  assert.deepEqual(regions('h = { "a": 1 }\nf("k": 2)\ng = {\n  "m": 3,\n}\nfoo "n": 4\n'), ['string:"a":', 'string:"k":', 'string:"m":', 'string:"n":']);
  assert.deepEqual(regions('x = c ? "a": "b"\n'), ['string:"a"', 'string:"b"'], 'a ternary branch is no label');
  assert.deepEqual(regions('a = <<EOS\n  x\nEOS\nb = 1 <<2\n'), ['string:<<EOS', 'string:  x\nEOS']);
});

test('ruby lexer: after a local or a parameter, / ? % and <<ID are operators, as the local-variable table reads them', () => {
  const lx2 = 'def f(width, n)\n  half = width /2\n  items.each do |item|\n    item.size\n  end\n  third = half / 4\n  flag = n ?1 : 0\n  mod = n %(3)\nend\n\ndef g(list)\n  list.map { |x| x }\nend\n';
  assert.deepEqual(regions(lx2), [], 'no regex runs from /2 to the / of line 6, no ?1 char, no %(3) literal');
  const forms = [
    'items.each { |a, (b, c), *d, **e, &f; g| a /2; b /2; c /2; d /2; e /2; f /2; g /2 }',
    'h = ->(i, j = 1) { i /2 + j /2 }; k = -> l { l ?1 : 0 }',
    'm, (o, *q) = 1, 2; m /2; o /2; q /2',
    'r ||= 1; r %(3); s += 1; s <<EOS',
    'def t(u) = u /2',
    'def v w, x: 1\n  w /2; x /2\nend',
    'def u(n)\n  h = { def: 1 }\n  n /2\nend',
    '@iv /2; @@cv /2; $gv /2',
  ];
  for (const t of forms) assert.deepEqual(regions(t), [], t);
  assert.deepEqual(regions('a = 1\nx.a /re/\nsplit /,/\nputs ?a\np %w[q]\nempty? /x/\n'),
    ['string:/re/', 'string:/,/', 'string:?a', 'string:%w[q]', 'string:/x/'], 'a method name stays a command, after a dot too');
  assert.deepEqual(regions('class V\n  def self.rule(k)\n    rule = k\n    [1].each { |item| item }\n  end\n  rule %w[a]\n  item %w[b]\nend\n'),
    ['string:%w[a]', 'string:%w[b]'], "a def's locals end with its scope");
  assert.deepEqual(regions('def w(n)\n  n\nrescue\n  n /2\nensure\n  n /2\nend\nn /2/\n'), ['string:/2/'], 'rescue and ensure stay in the def');
});

test('ruby relex equals a full lex over random edits that open and close heredocs, %-literals and =begin', () => {
  const { lex, relex } = require('../out/lex');
  const SNIPS = ['a', ' ', '\n', '"', "'", '`', '#', '#{', '}', '{', '/', '%w[', ']', '<<~EOS\n', 'EOS\n', '=begin\n', '=end\n', '?a', ':s', '$x', '@y', ' do', ' end', '__END__\n',
    ' = 1', ' /2', ' ?1 : 0', ' %(3)', 'def f(a, n)\n', 'end\n', '  ', ' { |a| ', ', b = 1, 2', '->(n) '];
  let s = 99;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let text = SRC;
  let prev = lex(text, 'ruby');
  let relexed = 0;
  for (let e = 0; e < 300; e++) {
    const at = Math.floor(rnd() * (text.length + 1));
    const del = rnd() < 0.5 ? 0 : Math.min(text.length - at, Math.floor(rnd() * 4));
    const ins = SNIPS[Math.floor(rnd() * SNIPS.length)];
    const next = text.slice(0, at) + ins + text.slice(at + del);
    const got = relex(prev, next, at, at + del, at + ins.length);
    const want = lex(next, 'ruby');
    if (got) {
      relexed++;
      const all = (x) => JSON.stringify([x.spans, x.holes, x.idents, x.numbers, x.punct, x.cpOff, x.cpState, x.longReads, x.localOffsets, x.localNames, x.defStarts]);
      assert.equal(all(got), all(want), `edit ${e}: ${JSON.stringify({ at, del, ins })}`);
    }
    prev = want;
    text = next;
  }
  assert.ok(relexed > 150, `relexed ${relexed} of 300`);
});

test('ruby blocks: def, endless def, class, module, class << self, do and brace blocks, lambdas; a hash is no scope', () => {
  const blocks = focus.scanBlocks(SRC, 'ruby');
  const at = (needle) => blocks.find((b) => b.openLine === lineOf(SRC, needle) && SRC.slice(b.headerStart).startsWith(needle.trim().split(' ')[0]));
  const span = (b) => b && [b.openLine, b.closeLine];
  assert.deepEqual(span(at('    def scale!(factor)')), [lineOf(SRC, 'def scale!(factor)'), lineOf(SRC, 'def scale!(factor)') + 4]);
  assert.deepEqual(span(at('    def self.origin = new(0, 0)')), [lineOf(SRC, 'def self.origin'), lineOf(SRC, 'def self.origin')]);
  assert.ok(at('    class << self'), 'singleton class');
  assert.ok(blocks.some((b) => b.openLine === lineOf(SRC, '  items.each do |item|') && SRC.startsWith('do |item|', b.headerStart)), 'a do block opens at do');
  assert.ok(blocks.some((b) => b.openLine === lineOf(SRC, 'doubler = ->(n)') && SRC.startsWith('->', b.headerStart)), 'lambda');
  assert.ok(!blocks.some((b) => b.openLine === lineOf(SRC, '  pairs = { a: 1, b: 2 }')), 'a hash literal is no block');
  const scale = at('    def scale!(factor)');
  assert.ok(focus.functionScopeOf(SRC, scale, 'ruby'), 'a def binds its parameters');
  assert.equal(focus.functionScopeOf(SRC, at('  while i < n'), 'ruby'), null, 'a loop is control flow');
});

test('ruby blocks: each branch of if / case / begin and the rescue sections of a def; modifiers open nothing', () => {
  const t = [
    'def f(x)', '  y = 1 if x', '  y += 1 while y < 3', '  z = x rescue nil', '  if x', '    1', '  elsif y', '    2', '  else', '    3', '  end',
    '  case x', '  when 1 then :a', '  in [a]', '    a', '  end', '  begin', '    y', '  rescue E => e', '    e', '  ensure', '    z', '  end',
    'rescue => err', '  err', 'end',
  ].join('\n');
  const blocks = focus.scanBlocks(t, 'ruby');
  const lines = blocks.map((b) => `${b.openLine}-${b.closeLine}:${t.slice(b.headerStart).split(/\s/)[0]}`).sort();
  assert.deepEqual(lines, [
    '0-25:def', '12-12:when', '13-15:in', '16-17:begin', '18-19:rescue', '20-22:ensure', '23-24:rescue', '4-5:if', '6-7:elsif', '8-10:else',
  ].sort());
});

test('ruby blocks: end inside a heredoc, a string, a %-literal, a regex or a comment closes nothing', () => {
  const t = 'def f\n  s = <<~EOS\n    end\n  EOS\n  t = "end" + %w[end] + /end/.source # end\n  s\nend\n';
  const blocks = focus.scanBlocks(t, 'ruby');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].closeLine, 6);
});

const blockRows = (t) => focus.scanBlocks(t, 'ruby').map((b) => `d${b.depth} ${b.headerStart}-${b.openOffset}-${b.closeOffset}`);

test('ruby blocks edges: a modifier at offset 0, if inside a hole, header ends over && / and / ;, ? methods and brackets', () => {
  assert.deepEqual(blockRows('x if y\ndef f\nend\n'), ['d0 7-12-15']);
  assert.deepEqual(blockRows('def f\n  "#{if x then 1 else 2 end}"\nend\n'), ['d0 0-5-38', 'd1 11-20-21', 'd1 23-27-32']);
  assert.deepEqual(blockRows('if a &&\n   b\n  x\nend\n'), ['d0 0-12-19']);
  assert.deepEqual(blockRows('if a and\n   b\n  x\nend\n'), ['d0 0-13-20']);
  assert.deepEqual(blockRows('if a.empty?\n  x\nend\n'), ['d0 0-11-18']);
  assert.deepEqual(blockRows('if (x = 1; x > 0) then\n  x\nend\n'), ['d0 0-22-29']);
  assert.deepEqual(blockRows('if x; y; end\n'), ['d0 0-5-11']);
  assert.deepEqual(blockRows('while x do\n  y\nend\n'), ['d0 0-10-17'], "the loop's do opens no block of its own");
});

test('ruby blocks edges: block parameters with a | in a string, lambdas, call braces, BEGIN / END, depth, ~ in an endless def', () => {
  assert.deepEqual(blockRows('[1].each { |a, b = "|"| a }\n'), ['d0 9-23-26']);
  assert.deepEqual(blockRows('[1].map { |x| x }\n'), ['d0 8-13-16']);
  assert.deepEqual(blockRows('f = -> { 1 }\n'), ['d0 4-8-11']);
  assert.deepEqual(blockRows('foo(1) { |y| y }\nh = { a: 1 }\n'), ['d0 7-12-15']);
  assert.deepEqual(blockRows('BEGIN { $t = 1 }\nEND { $t }\n'), ['d0 0-7-15', 'd0 17-22-26']);
  assert.deepEqual(blockRows('module M\n  class C\n    def f\n    end\n  end\nend\n'), ['d0 0-8-45', 'd1 11-18-41', 'd2 23-28-35']);
  assert.deepEqual(blockRows('def inv(x) = ~x\ndef g\nend\n'), ['d0 0-12-14', 'd0 16-21-24']);
  const t = 'def add a, b\n  a + b\nend\n';
  assert.equal(focus.lexRegionFor(t, focus.scanBlocks(t, 'ruby')[0], 'ruby').start, t.indexOf('a, b'), 'paren-less parameters start the region');
});

test('ruby blocks edges: a { after a ternary ? or a unary ! is a hash, so Focus stays on the def around it', () => {
  for (const t of ['opts = cond ? { a: 1 } : {}\n', 'x = a.empty? ? { b: 1 } : nil\n', 'x = !{ a: 1 }.empty?\n']) assert.deepEqual(blockRows(t), [], t);
  assert.deepEqual(blockRows('x = a.empty? { 1 }\ny = save! { 2 }\n'), ['d0 13-14-17', 'd0 29-30-33'], 'a ? or ! method still takes a block');
  const t = 'def build(cond, a)\n  b = a + 1\n  opts = cond ? {\n    key: a,\n    other: b,\n  } : nil\n  opts\nend\n';
  const at = t.indexOf('key: a') + 5;
  const block = focus.innermostBlock(focus.scanBlocks(t, 'ruby'), 3, at, t);
  assert.deepEqual([block.openLine, block.closeLine], [0, 7]);
});

test('ruby facts: a name is a local from its first assignment on; before it, and with arguments, it is a call', () => {
  const t = 'def f(a, b = a, *c, d:, e: 1, **g, &h)\n  x\n  x = 1\n  x\n  y, (z, w) = 1, [2, 3]\n  p x\n  [1].each { |x; v| v = x }\n  { d:, x: 2 }\nend\n';
  const lx = lexFor(t, 'ruby');
  const f = rubyFacts(lx);
  const names = (pred) => lx.idents.filter((id) => pred(id.offset)).map((id) => `${id.name}@${t.slice(0, id.offset).split('\n').length}`);
  assert.deepEqual(names((o) => f.declSites.has(o)), ['a@1', 'b@1', 'c@1', 'd@1', 'e@1', 'g@1', 'h@1', 'x@3', 'y@5', 'z@5', 'w@5', 'x@7', 'v@7']);
  assert.ok(!f.binding.has(lx.idents.find((id) => id.name === 'x').offset), 'x before its assignment is a call');
  assert.ok(!f.binding.has(lx.idents.find((id) => id.name === 'p').offset), 'p x is a call');
  const shorthand = lx.idents.filter((id) => id.name === 'd').pop();
  assert.ok(f.shorthands.has(shorthand.offset), '{ d: } reads d');
  assert.ok(!f.binding.has(lx.idents.filter((id) => id.name === 'x').pop().offset), 'the label x: is a key');
});

test('ruby facts: blocks see outer locals, their own die at their end; def is a hard scope; captures, it and _1', () => {
  const t = 'n = 1\ndef m\n  n\nend\nxs.each do |v|\n  n += v\n  w = v\nend\nw\nxs.map { it * 2 }\nxs.map { _1 }\ncase q\nin [first, *rest] if first\n  rest\nend\n';
  const lx = lexFor(t, 'ruby');
  const f = rubyFacts(lx);
  const at = (name, nth = 1) => lx.idents.filter((id) => id.name === name)[nth - 1].offset;
  assert.ok(!f.binding.has(at('n', 2)), 'a def does not see the file local');
  assert.equal(f.binding.get(at('n', 3)), at('n', 1), 'the block writes the outer local');
  assert.ok(!f.binding.has(at('w', 2)), 'the block local is gone after the block');
  assert.ok(f.declSites.has(at('it')) && f.declSites.has(at('_1')));
  assert.equal(f.binding.get(at('rest', 2)), at('rest', 1));
});

test('ruby facts: user globals are data, Ruby\'s are not; members, constants, symbols and def names are not', () => {
  const t = '$count = 0\ndef bump(by)\n  $count += by\n  $stdout.puts $0\n  self.total = by\n  Foo::Bar.baz(:by)\nend\nalias bump2 bump\n';
  const lx = lexFor(t, 'ruby');
  const f = rubyFacts(lx);
  const data = lx.idents.filter((id) => f.binding.has(id.offset)).map((id) => id.name);
  assert.deepEqual(data, ['$count', 'by', '$count', 'by', 'by']);
});

const declsOf = (t) => {
  const lx = lexFor(t, 'ruby');
  const f = rubyFacts(lx);
  return lx.idents.filter((id) => f.declSites.has(id.offset)).map((id) => `${id.name}@${t.slice(0, id.offset).split('\n').length}`);
};

test('ruby facts edges: every parameter shape, and no default expression or keyword-default call as a parameter', () => {
  assert.deepEqual(declsOf([
    'def m1(a, b, c) = a', 'def m2(d:, e: g(h, i), **o, &blk) = d', 'xs.each { |(k, v), idx; tmp| tmp = k }',
    'l1 = ->(p1, p2 = q(r, s)) { p1 }', 'l2 = -> u, w do u end', 'l3 = ->x { x }', '',
  ].join('\n')), ['a@1', 'b@1', 'c@1', 'd@2', 'e@2', 'o@2', 'blk@2', 'k@3', 'v@3', 'idx@3', 'tmp@3', 'l1@4', 'p1@4', 'p2@4', 'l2@5', 'u@5', 'w@5', 'l3@6', 'x@6']);
});

test('ruby facts edges: multiple assignment after every statement start, =~ is no write, for / rescue / pattern / rightward bindings', () => {
  assert.deepEqual(declsOf('a, h[0] = 1, 2\n'), ['a@1']);
  assert.deepEqual(declsOf('x = 1; c, d = 2, 3\n[1].each { e, f = 1, 2 }\n[1].each { |z| g, i = z, z }\n(j, l = 1, 2)\n'),
    ['x@1', 'c@1', 'd@1', 'e@2', 'f@2', 'z@3', 'g@3', 'i@3', 'j@4', 'l@4']);
  assert.deepEqual(declsOf('begin m, q = 1, 2 end\n'), ['m@1', 'q@1']);
  assert.deepEqual(declsOf('t =~ /x/\nt\n'), []);
  assert.deepEqual(declsOf('for i in rows do i end\n'), ['i@1'], 'rows is a call');
  assert.deepEqual(declsOf('begin\n  go\nrescue IOError => err\n  err\nend\n'), ['err@3']);
  assert.deepEqual(declsOf('case h\nin {name: String => n, age:}\n  n + age\nend\n'), ['n@2', 'age@2']);
  assert.deepEqual(declsOf('config => {name:}\nh =>{size:}\ns = "x => {y:}"\n'), ['name@1', 'size@2', 's@3']);
});

test('ruby facts edges: named regex captures, a top-level global definition, reads before a comment or a modifier keyword', () => {
  const rt = 'if /(?<year>\\d+)/ =~ s\n  year\nend\nif %r{(?<day>\\d+)} =~ s\n  day\nend\n';
  const lx = lexFor(rt, 'ruby');
  const f = rubyFacts(lx);
  const read = (name) => lx.idents.find((id) => id.name === name).offset;
  assert.equal(f.binding.get(read('year')), rt.indexOf('year'));
  assert.equal(f.binding.get(read('day')), rt.indexOf('day'));
  assert.deepEqual([...rubyFacts(lexFor('$count = 0\n', 'ruby')).globalSites], [0]);
  for (const t of ['y = 1\nputs y # note\ny # tail\n', 'y = 1\ny if ok\ny unless ok\ny and ok\n']) {
    const l = lexFor(t, 'ruby');
    const ff = rubyFacts(l);
    assert.ok(l.idents.filter((id) => id.name === 'y').every((id) => ff.binding.get(id.offset) === 0), t);
  }
});

const escapes = (t, needle, header) => {
  const lx = lexFor(t, 'ruby');
  const blocks = focus.scanBlocks(t, 'ruby');
  const at = t.indexOf(needle);
  const block = header ? blocks.find((b) => t.startsWith(header, b.headerStart))
    : focus.innermostBlock(blocks, t.slice(0, at).split('\n').length - 1, at, t);
  const region = focus.lexRegionFor(t, block, 'ruby');
  return rubyEscapeRisk(lx, region, [region], blocks).map((e) => `${t.slice(0, e.start).split('\n').length}:${t.slice(e.start, e.end)}`);
};

test('ruby escape edges: parameters, subscripts, no-space writes, closure multiple assignment, class-body ivars, sibling branches', () => {
  const t = 'def f(n, opts, m, h, x)\n  n += 1\n  opts.limit = 7\n  m[1][2] = 3\n  h[:a]=1\n  x[n[1]] = 2\n  local = 1\n  local += 2\nend\n';
  assert.deepEqual(escapes(t, 'n += 1'), ['3:opts.limit', '4:m', '5:h', '6:x'], 'an own parameter and a local are bookkeeping');
  assert.deepEqual(escapes('x = y = 0\n[1].each { x, y = 1, 2 }\n', 'x, y = 1'), ['2:x', '2:y']);
  assert.deepEqual(escapes('class C\n  @count = 0\n  def bump\n    @count += 1\n  end\nend\n', '', 'class'), ['4:@count']);
  assert.deepEqual(escapes('def f(c)\n  if c\n    v = 1\n  else\n    v = 2\n  end\n  v\nend\n', 'v = 2'), []);
  assert.deepEqual(escapes('def f(c)\n  v = 0\n  if c\n    w = 1\n  else\n    v = 2\n  end\nend\n', 'v = 2'), ['6:v']);
});

test('ruby band 1 edges: the shadow restore skips a shorthand and keeps a binding at offset 0', () => {
  const t = 'def f(p)\n  { p: }\nend\np = 1\nputs p\n';
  assert.deepEqual(rubyShadowSpans(lexFor(t, 'ruby')).map((x) => `${t.slice(0, x.start).split('\n').length}:${t.slice(x.start, x.end)}`), ['1:p', '4:p', '5:p']);
  const z = 'p = 1\nputs p\n';
  assert.deepEqual(rubyShadowSpans(lexFor(z, 'ruby')).map((x) => x.start), [0, 11]);
});

async function classify(text, served, caretNeedle, tok) {
  stub.clearLspResponses();
  if (served) {
    stub.setLspResponses({
      'vscode.provideDocumentSemanticTokensLegend': served.legend,
      'vscode.provideDocumentSemanticTokens': { data: served.data },
      'vscode.executeDocumentSymbolProvider': [],
    });
  }
  const doc = new stub.TextDocument(text, 'ruby', `file:///rb-${Math.random()}.rb`);
  const blocks = focus.scanBlocks(text, 'ruby');
  const line = lineOf(text, caretNeedle);
  const lineText = text.split('\n')[line];
  const offset = text.split('\n').slice(0, line).join('\n').length + (line > 0 ? 1 : 0) + lineText.indexOf(tok, lineText.indexOf(caretNeedle.trim()));
  const block = focus.innermostBlock(blocks, line, offset, text);
  const r = await new Classifier().classifyScope(doc, block, 5, { isCancellationRequested: false }, { text, blocks });
  const escapes = risk.escapeRisk(text, focus.lexRegionFor(text, block, 'ruby'), r.focused, 'ruby').map((e) => text.slice(e.start, e.end));
  return { byName: r.focused.byName, escapes, block };
}

for (const [mode, served] of [['no server', null], ['ruby-lsp tokens', RUBY_LSP]]) {
  test(`ruby classification, ${mode}: locals and parameters; ivars, members, symbols, labels and calls are not`, async () => {
    const m = await classify(SRC, served, '    sum += item.price', 'item');
    for (const n of ['sum', 'item', 'count']) assert.ok(m.byName.has(n), `${n} is data`);
    for (const n of ['price', 'each', 'items.each', 'nil?']) assert.ok(!m.byName.has(n), `${n} is not`);
    const ctor = await classify(SRC, served, '      @label = label', 'label');
    assert.ok(ctor.byName.has('label'));
    for (const n of ['@label', '@x', '@@count']) assert.equal(ctor.byName.get(n)?.cls, 'self', `${n} is a member, painted by band 1 only`);
  });
}

test('ruby: a name!( call is a method, not a Rust macro, so a label in its arguments stays out of the data', async () => {
  const t = [
    'def extract(path, unpack_dir)',
    '  system_command!("ditto", args: ["-x", path, unpack_dir], verbose: true)',
    'end',
    '',
    'def report(verbose)',
    '  puts verbose',
    '  path = verbose',
    '  path',
    'end',
    '',
  ].join('\n');
  const served = { legend: RUBY_LSP.legend, data: [1, 40, 4, 7, 0, 0, 6, 10, 7, 0, 4, 7, 7, 7, 0, 1, 9, 7, 7, 0, 1, 2, 4, 8, 0] };
  const m = await classify(t, served, '  system_command!', 'path');
  assert.deepEqual([...m.byName.keys()], ['path', 'unpack_dir']);
});

test('ruby escape marks with ruby-lsp tokens: closure captures, ivars outside initialize, cvars, globals, parameter members; never declarations', async () => {
  const at = async (needle, tok) => (await classify(SRC, RUBY_LSP, needle, tok)).escapes;
  assert.deepEqual(await at('    sum += item.price', 'item'), ['sum', 'count']);
  assert.deepEqual(await at('      @x *= factor', 'factor'), ['@x', '@y']);
  assert.deepEqual(await at('      @label = label', 'label'), ['@@count', '$registry'], 'initialize sets up its own ivars');
  assert.deepEqual(await at('    total += v', 'v'), ['total', '$last', '@last']);
  assert.deepEqual(await at('  $counter += 1', 'counter'), ['$counter', '$counter']);
  assert.deepEqual((await classify(SRC, null, '    sum += item.price', 'item')).escapes, [], 'the heuristic makes no claim');
});

test('ruby lexical risk: no async marks for names spelled async or await', () => {
  const t = 'def f(async)\n  await = async\n  1\nend\n';
  const r = risk.lexicalRisk(t, { start: 0, end: t.length }, 'ruby');
  assert.deepEqual(r.async, []);
  assert.equal(r.numberEngaged.length, 1);
});

test('ruby band 1: data uses of a local named like a Kernel method the grammar paints, at the page colour', () => {
  const t = 'def f(p, format)\n  puts p\n  format = p.to_s\n  format\nend\np 1\n';
  const lx = lexFor(t, 'ruby');
  const spans = rubyShadowSpans(lx).map((s) => `${t.slice(s.start, s.end)}@${t.slice(0, s.start).split('\n').length}`);
  assert.deepEqual(spans, ['p@1', 'format@1', 'p@2', 'format@3', 'p@3', 'format@4']);
});

test('ruby band 1: the #{ and } of every closed hole; single quotes, comments and an unclosed hole paint none', () => {
  const t = 'a = "x #{b} y" + `#{c}` + %Q{#{d}} + :"#{e}" + \'#{no}\' # #{no}\nz = <<~E\n  #{f[1]}\nE\nq = "#{open';
  const at = rubyPlaceholderSpans(t).map((x) => `${t.slice(0, x.start).split('\n').length}:${t.slice(x.start, x.end)}`);
  assert.deepEqual(at, ['1:#{', '1:}', '1:#{', '1:}', '1:#{', '1:}', '1:#{', '1:}', '3:#{', '3:}']);
});

async function editor(text, file) {
  stub.clearLspResponses();
  const doc = new stub.TextDocument(text, 'ruby', `file:///rb/${file}`);
  const ed = new stub.TextEditor(doc, 0, 0);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  d.render();
  const shown = (type) => (live.get(type) ?? []).map((r) => `${r.start.line + 1}:${doc.lineAt(r.start.line).text.slice(r.start.character, r.end.character)}`);
  return { d, ed, shown };
}

test('ruby band 1: self at the keyword colour, except a method named self and a self: key; this is a plain name', async () => {
  const t = [
    'class Box',
    '  def self.build(tp, this)',
    '    h = { self: tp.self, kind: self::KIND }',
    '    (0..self.size).map { self } + [this]',
    '  end',
    'end',
  ].join('\n');
  const h = await editor(t, 'box.rb');
  assert.deepEqual(h.shown(h.d.pool.self), ['2:self', '3:self', '4:self', '4:self']);
  h.d.dispose();
});

test('an .erb template opened as ruby (no Shopify.ruby-lsp) is static content: no scope, no band-1 restores', async () => {
  assert.equal(focus.effectiveLanguageId('ruby', '/a/view.html.erb'), 'erb');
  assert.equal(focus.effectiveLanguageId('ruby', '/a/Legacy.RHTML'), 'erb');
  assert.equal(focus.effectiveLanguageId('ruby', '/a/view.rb'), 'ruby');
  assert.equal(focus.effectiveLanguageId('html', '/a/view.erb'), 'html');
  const t = '<% items.each do |p| %>\n  <li><%= p %> <%= "#{self}" %></li>\n<% end %>\n<script>const n = 1; n + n</script>\n';
  const asRuby = await editor(t, 'view.rb');
  assert.ok(asRuby.d.focusedBlock(asRuby.ed), 'read as Ruby, the template gets the whole-file scope');
  assert.deepEqual([asRuby.shown(asRuby.d.pool.self), asRuby.shown(asRuby.d.pool.placeholder)], [['2:self'], ['2:#{', '2:}']]);
  asRuby.d.dispose();
  const h = await editor(t, 'view.html.erb');
  assert.equal(h.d.focusedBlock(h.ed), null);
  for (const pool of ['self', 'shadowRestore', 'importRestore', 'placeholder']) assert.deepEqual(h.shown(h.d.pool[pool]), [], pool);
  h.d.dispose();
});

test('ruby facts cost grows linearly with the file', () => {
  const unit = (i) => [
    `def f${i}(a, b = 1, *rest, key:, &blk)`, '  x = a + b', '  [1, 2].each do |j|', '    x += j if j.odd?', '  end',
    '  y = <<~EOS', '    #{x} end', '  EOS', '  { x:, y: }', 'end',
  ].join('\n');
  const setup = (n) => {
    const text = '$total = 0\n' + Array.from({ length: n }, (_, i) => unit(i)).join('\n');
    const { lex } = require('../out/lex');
    return { lx: lex(text, 'ruby'), blocks: focus.scanBlocks(text, 'ruby') };
  };
  const ratio = growth(setup, ({ lx, blocks }) => rubyFacts(lx, blocks), 300);
  assert.ok(ratio < 24, `8x the lines cost ${ratio.toFixed(1)}x`);
});
