'use strict';
// Python coverage. Python is the first INDENTATION-scoped language the layer
// supports, and it broke three assumptions the brace-based design had baked in:
//
//   1. Blocks come from `{}`. On a Python file `scanBraceBlocks` found ONE block
//      in 140 lines — a dict literal — so every caret fell through to the
//      synthetic module-level scope, the "focused block" was the whole file, and
//      the layer tinted all of it at once.
//   2. A function header contains `func`/`function`/`=>`. No Python `def`
//      matched, so parameters classified as block-locals instead of fn-locals.
//   3. A class body holds data. In Python its names are ATTRIBUTES — `name: str`
//      in a dataclass is the spelling of a struct field, and Pylance reports it
//      as `variable [declaration]`, indistinguishable on the wire from a local.
//
// Ground truth for the scanner is the language rule ("a suite runs until a line
// indented no deeper than its header"), so these are real assertions rather than
// snapshots. Note there is deliberately NO captured-semantic-token fixture for
// Python as there is for Go/TS: Pylance is the only server that emits Python
// semantic tokens, and its licence restricts it to running inside Microsoft
// products — it prints its licence to stderr and exits 1 under any other host.
// Pyright, the open-source engine beneath it, advertises no semantic-token
// provider at all. So the token shapes below are constructed to Pylance's
// documented legend instead of captured.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const focus = require('../out/focus');
const classify = require('../out/classify');

const SAMPLE = path.join(__dirname, '../samples/sample.py');

/** Offsets of the start of each line, for building token offsets by (line, name). */
function lineStarts(text) {
  const lines = text.split('\n');
  const starts = [0];
  for (let i = 0; i < lines.length - 1; i++) {
    starts.push(starts[i] + lines[i].length + 1);
  }
  return { lines, starts };
}

/**
 * A Pylance-shaped semantic token for `name` on the line whose trimmed text is
 * exactly `lineText`.
 *
 * Located by CONTENT, not by line number: an earlier draft hard-coded 0-based
 * line numbers and every one of them broke the moment two lines were added to the
 * sample's docstring. The failure was loud rather than silent, but the test should
 * not care where in the file its subject lives.
 */
function tokenFor(text, name, lineText, type = 'variable', modifiers = ['declaration']) {
  const { lines, starts } = lineStarts(text);
  const line = lines.findIndex((l) => l.trim() === lineText);
  assert.ok(line >= 0, `no line reads exactly ${JSON.stringify(lineText)} in sample.py`);
  const col = lines[line].indexOf(name);
  assert.ok(col >= 0, `"${name}" is not on ${JSON.stringify(lineText)}`);
  return { name, type, modifiers, offset: starts[line] + col, length: name.length, line };
}

/** 0-based index of the line whose trimmed text is exactly `lineText`. */
function lineWith(text, lineText) {
  const line = text.split('\n').findIndex((l) => l.trim() === lineText);
  assert.ok(line >= 0, `no line reads exactly ${JSON.stringify(lineText)} in sample.py`);
  return line;
}

/** Names the classifier would consider data identities. `self` is added separately. */
function tintedNames(text, tokens) {
  const index = classify.buildFileIndex(text, tokens, []);
  return [...index.occurrences.keys()].filter((n) => n !== 'self').sort();
}

// ── the indentation scanner ───────────────────────────────────────────────────

test('scanIndentBlocks: a colon-headed suite ends at the first line indented no deeper', () => {
  const src = ['def f():', '    a = 1', '    b = 2', 'after = 3', ''].join('\n');
  const blocks = focus.scanIndentBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].openLine, 0);
  assert.equal(blocks[0].closeLine, 2, 'body is lines 2-3, not the dedented `after`');
  assert.equal(blocks[0].depth, 0);
});

test('scanIndentBlocks: a SIBLING at the same indent closes the previous suite', () => {
  // The original `close(indent + 1, …)` threshold left siblings nested inside
  // their predecessor, so the first class in a file appeared to run to the last
  // line and nothing ever closed — the "highlights the entire file" bug.
  const src = ['class A:', '    def one(self):', '        pass', '    def two(self):', '        pass', ''].join('\n');
  const blocks = focus.scanIndentBlocks(src);
  const byLine = new Map(blocks.map((b) => [b.openLine, b]));
  assert.equal(byLine.get(1).closeLine, 2, '`one` ends before `two` starts');
  assert.equal(byLine.get(3).closeLine, 4);
  assert.equal(byLine.get(0).closeLine, 4, 'the class still spans both methods');
  assert.equal(byLine.get(0).depth, 0);
  assert.equal(byLine.get(1).depth, 1);
});

test('scanIndentBlocks: a WRAPPED signature is still a header', () => {
  // The `:` lands on a continuation line, which is not itself a header — keying
  // on the physical line dropped every wrapped signature entirely.
  const src = ['def f(', '    a,', '    b,', ') -> int:', '    return a', ''].join('\n');
  const blocks = focus.scanIndentBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].openLine, 0, 'the block is keyed to the line `def` starts on');
  assert.equal(blocks[0].closeLine, 4);
});

test('scanIndentBlocks: an annotation, a slice and a lambda do NOT open a block', () => {
  const src = [
    'ann: dict = {}',
    'sliced = [1, 2, 3][0:2]',
    'lam = lambda q: q + 1',
    'd = {"key": "value"}',
    '',
  ].join('\n');
  assert.deepEqual(focus.scanIndentBlocks(src), [], 'none of these is a suite header');
});

test('scanIndentBlocks: colons inside strings and comments are inert', () => {
  const src = [
    'def f():',
    '    """Docstring with a colon: here.',
    '',
    '    And an indented section:',
    '        that looks like a block',
    '    """',
    '    s = "if cond:"',
    '    # comment with colon:',
    '    return s',
    '',
  ].join('\n');
  const blocks = focus.scanIndentBlocks(src);
  assert.equal(blocks.length, 1, 'only `def f():` opens a block');
  assert.equal(blocks[0].closeLine, 8);
});

test('scanIndentBlocks: blank lines do not close a suite', () => {
  const src = ['def f():', '', '    a = 1', '', '    return a', ''].join('\n');
  const blocks = focus.scanIndentBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].closeLine, 4, 'the blank line at index 3 is not the end');
});

test('scanIndentBlocks: a trailing comment after the colon still opens a block', () => {
  const src = ['def f():  # note', '    return 1', ''].join('\n');
  assert.equal(focus.scanIndentBlocks(src).length, 1);
});

test('scanIndentBlocks: else/except/finally are their own suites', () => {
  const src = ['try:', '    pass', 'except ValueError:', '    pass', 'finally:', '    pass', ''].join('\n');
  const blocks = focus.scanIndentBlocks(src);
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((b) => b.depth), [0, 0, 0], 'siblings, not nested');
});

test('scanIndentBlocks: tabs and spaces both count as indentation', () => {
  const src = ['def f():', '\ta = 1', '\treturn a', ''].join('\n');
  const blocks = focus.scanIndentBlocks(src);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].closeLine, 2);
});

test('scanIndentBlocks: degenerate inputs do not throw', () => {
  assert.deepEqual(focus.scanIndentBlocks(''), []);
  assert.deepEqual(focus.scanIndentBlocks('\n\n\n'), []);
  assert.deepEqual(focus.scanIndentBlocks('# just a comment\n'), []);
  // An unterminated docstring must not hang or mis-nest.
  assert.doesNotThrow(() => focus.scanIndentBlocks('def f():\n    """open\n'));
});

// ── the language dispatcher ───────────────────────────────────────────────────

test('scanBlocks: python routes to the indent scanner, everything else to braces', () => {
  const py = ['class A:', '    def m(self):', '        pass', ''].join('\n');
  assert.equal(focus.scanBlocks(py, 'python').length, 2, 'indent scanner finds class + method');
  assert.equal(focus.scanBlocks(py, 'go').length, 0, 'brace scanner finds nothing in Python');
  assert.equal(focus.scanBlocks(py, undefined).length, 0, 'no language → braces');

  const ts = 'function f() {\n  return 1;\n}\n';
  assert.equal(focus.scanBlocks(ts, 'typescript').length, 1);
});

test('the real sample.py resolves every caret to its enclosing suite, not the file', () => {
  const text = fs.readFileSync(SAMPLE, 'utf8');
  const blocks = focus.scanBlocks(text, 'python');
  const { lines } = lineStarts(text);

  // A line in the file -> the header its focus block should start with. Both are
  // matched by content so the test survives edits elsewhere in the sample.
  const expected = [
    ['self.retries = retries', 'def with_retries'],
    ['backoff = 1 << i', 'for i in range'],
    ['results = await fetch_all([cfg.name])', 'async def process'],
    ['self.history.append(cfg.name)', 'if num_bytes > 3'],
    ['return self.seen / max(1, len(self.history))', 'def score'],
    ['worker = Worker("w-1")', 'def main'],
    ['total += cfg.retries  # escapes the loop — writes outer `total`', 'for cfg in cfgs'],
  ];
  for (const [caretLine, headerPrefix] of expected) {
    const li = lineWith(text, caretLine);
    const block = focus.innermostBlock(blocks, li, undefined, text);
    assert.ok(block, `${caretLine} resolved to nothing`);
    assert.ok(
      !focus.isTopLevelBlock(block),
      `${JSON.stringify(caretLine)} fell through to module top level — the whole-file-highlight bug`,
    );
    assert.ok(
      lines[block.openLine].trim().startsWith(headerPrefix),
      `${JSON.stringify(caretLine)} focused ${JSON.stringify(lines[block.openLine].trim())}, wanted ${headerPrefix}`,
    );
  }
});

// ── header classification ─────────────────────────────────────────────────────

test('isFunctionHeader: `def` and `lambda` are functions, `class` is not', () => {
  const check = (src) => {
    const blocks = focus.scanIndentBlocks(src);
    assert.equal(blocks.length >= 1, true, `no block in ${JSON.stringify(src)}`);
    return focus.isFunctionHeader(src, blocks[0]);
  };
  assert.equal(check('def f(a, b):\n    return a\n'), true);
  assert.equal(check('async def f(a):\n    return a\n'), true);
  assert.equal(
    check('class C:\n    x = 1\n'),
    false,
    'a class body holds attributes, not parameters — treating it as a function widens its header into the param region',
  );
  assert.equal(check('if x:\n    pass\n'), false);
  assert.equal(check('for i in xs:\n    pass\n'), false);
});

test('a def header is NOT control flow, so its params stay fn-scoped', () => {
  // `declRegionFor` widens a control-flow block to include its header so header
  // bindings count as block-local. A function's params must NOT be widened that
  // way or they stop tracing across the whole function.
  const src = 'def load(name: str) -> int:\n    return 1\n';
  const block = focus.scanIndentBlocks(src)[0];
  const decl = focus.declRegionFor(src, block);
  assert.equal(decl.start, block.openOffset, 'body-only: the header is not widened in');
});

test('a `for`/`with`/`except` header IS control flow, so its bindings are block-local', () => {
  for (const src of [
    'for item in items:\n    pass\n',
    'with open(f) as fh:\n    pass\n',
    'except ValueError as e:\n    pass\n',
  ]) {
    const block = focus.scanIndentBlocks(src)[0];
    const decl = focus.declRegionFor(src, block);
    assert.equal(
      decl.start,
      block.headerStart,
      `${JSON.stringify(src.split('\n')[0])} binds a name in its header, so the header must be included`,
    );
  }
});

// ── class attributes are band-1, not data ─────────────────────────────────────

test('dataclass fields are furniture, not data identities', () => {
  const text = fs.readFileSync(SAMPLE, 'utf8');
  // Pylance reports these as `variable [declaration]` — identical on the wire to
  // a real local, which is why they used to tint.
  const fields = [
    tokenFor(text, 'name', 'name: str'),
    tokenFor(text, 'retries', 'retries: int = MAX_RETRIES'),
    tokenFor(text, 'timeout', 'timeout: int = DEFAULT_TIMEOUT'),
    tokenFor(text, 'tags', 'tags: dict[str, str] = field(default_factory=dict)'),
  ];
  assert.deepEqual(tintedNames(text, fields), [], 'a class attribute holds no local data');
});

test('a field line\'s RIGHT-HAND SIDE is still real code', () => {
  const text = fs.readFileSync(SAMPLE, 'utf8');
  const rhs = [tokenFor(text, 'MAX_RETRIES', 'retries: int = MAX_RETRIES'), tokenFor(text, 'DEFAULT_TIMEOUT', 'timeout: int = DEFAULT_TIMEOUT')];
  assert.deepEqual(
    tintedNames(text, rhs),
    ['DEFAULT_TIMEOUT', 'MAX_RETRIES'],
    'only the field NAME is furniture; what it is assigned from is a real reference',
  );
});

test('method params and locals still tint', () => {
  const text = fs.readFileSync(SAMPLE, 'utf8');
  const inside = [
    tokenFor(text, 'retries', 'def with_retries(self, retries: int) -> "Config":', 'parameter'),
    tokenFor(text, 'cfg', 'cfg = Config(name=name, tags={"env": "dev"})'),
    tokenFor(text, 'backoff', 'backoff = 1 << i'),
    tokenFor(text, 'num_bytes', 'num_bytes = sum(len(r.name) for r in results)'),
  ];
  assert.deepEqual(tintedNames(text, inside), ['backoff', 'cfg', 'num_bytes', 'retries']);
});

// ── f-strings are code, not opaque text ───────────────────────────────────────

test('identifiers inside an f-string hole are lexed', () => {
  // The lexer knew JS templates (backtick + `${`) but not Python f-strings (quote
  // + bare `{`), so the whole f-string was opaque. That is not cosmetic: names are
  // gated on being used at least TWICE, and `prefix`, `page` and `timeout_sum` in
  // sample.py each have one plain use plus one f-string use — so all three fell
  // below the gate and never tinted anywhere.
  const src = 'prefix = "cfg"\nout = f"{prefix}:{c.name}"\n';
  const names = focus.lexIdentifiers(src).map((i) => i.name);
  // No `f`: the string PREFIX is punctuation, not an identifier (see below).
  assert.deepEqual(names, ['prefix', 'out', 'prefix', 'c', 'name']);
});

test('a PLAIN string is still opaque, and `{{` is an escaped brace', () => {
  assert.deepEqual(
    focus.lexIdentifiers('s = "not code here"\n').map((i) => i.name),
    ['s'],
    'a string with no f prefix contributes no identifiers',
  );
  assert.deepEqual(
    focus.lexIdentifiers('s = f"{{literal}} {real}"\n').map((i) => i.name),
    ['s', 'real'],
    '`{{` is a literal brace, so `literal` is text — only `real` is code',
  );
});

test('a string PREFIX is not an identifier', () => {
  // `f"{x}"` put a one-letter name `f` in the stream. In an f-string-heavy file
  // that cleared the two-use gate, won a hue, and consumed one of the palette's
  // few slots — for a token that is punctuation.
  assert.deepEqual(focus.lexIdentifiers('out = f"{prefix}"\n').map((i) => i.name), ['out', 'prefix']);
  assert.deepEqual(focus.lexIdentifiers('x = rf"{a}"\n').map((i) => i.name), ['x', 'a']);
  assert.deepEqual(focus.lexIdentifiers('y = b"bytes"\n').map((i) => i.name), ['y']);
  // The boundaries: only letters DIRECTLY against a quote, and only prefix letters.
  assert.deepEqual(focus.lexIdentifiers('f = 5\n').map((i) => i.name), ['f'],
    'a real variable named `f` is still a name');
  assert.deepEqual(focus.lexIdentifiers('x = f("a")\n').map((i) => i.name), ['x', 'f'],
    '`f(...)` is a call, not a prefix — the next char is a paren');
  assert.deepEqual(focus.lexIdentifiers('conf = "x"\n').map((i) => i.name), ['conf'],
    '`conf` is not a prefix even though it ends in f');
});

test('an f prefix is only a prefix when it is not part of an identifier', () => {
  assert.deepEqual(
    focus.lexIdentifiers('conf = "{notcode}"\n').map((i) => i.name),
    ['conf'],
    'the `f` at the end of `conf` must not turn the next string into an f-string',
  );
  for (const src of ['x = rf"{a}"\n', 'x = F"{a}"\n', 'x = fr"{a}"\n']) {
    assert.ok(
      focus.lexIdentifiers(src).map((i) => i.name).includes('a'),
      `${src.trim()} is an f-string`,
    );
  }
});

test('a `#` comment is not lexed as code', () => {
  assert.deepEqual(
    focus.lexIdentifiers('x = 1  # total calls here\n').map((i) => i.name),
    ['x'],
    'words in a Python comment must not inflate use counts',
  );
});

test('the real sample.py lexes every f-string use', () => {
  // Ground truth is a plain word-boundary grep: the lexer must agree with it for
  // names that appear only in code and f-strings.
  const text = fs.readFileSync(SAMPLE, 'utf8');
  const ids = focus.lexIdentifiers(text);
  for (const name of ['prefix', 'timeout_sum']) {
    const lexed = ids.filter((i) => i.name === name).length;
    assert.ok(lexed >= 2, `${name} lexed ${lexed} times, needs >= 2 to clear the use gate`);
  }
});

// ── comprehensions and lambdas are scopes ─────────────────────────────────────

test('a comprehension is a scope; a plain list/call/dict is not', () => {
  const count = (src) => focus.scanBlocks(`${src}\n`, 'python').length;
  assert.equal(count('x = [1, 2, 3]'), 0, 'a plain list binds nothing');
  assert.equal(count('f(a, b)'), 0, 'a plain call binds nothing');
  assert.equal(count('d = {"a": 1}'), 0, 'a plain dict binds nothing');
  assert.equal(count('x = [i for i in xs]'), 1, 'a list comprehension binds `i`');
  assert.equal(count('x = {k: v for k, v in items}'), 1, 'a dict comprehension');
  assert.equal(count('x = [f(i) for i in xs if i]'), 1, 'a filter does not add a scope');
  assert.equal(count('x = [[j for j in r] for r in rows]'), 2, 'nested comprehensions are two scopes');
  assert.equal(count('x = [g(i, 2) for i in xs]'), 1, 'a call inside the body is not its own scope');
});

test('a lambda is a scope', () => {
  assert.equal(focus.scanBlocks('x = sorted(xs, key=lambda a: a.b)\n', 'python').length, 1);
  const blocks = focus.scanBlocks('f(0, lambda acc, item: acc + item.t)\n', 'python');
  assert.equal(blocks.length, 1);
  // The body ends at the closing paren, not at the end of the line.
  assert.ok(blocks[0].closeOffset < 'f(0, lambda acc, item: acc + item.t)'.length);
});

test('a lambda block spans its PARAMETERS AND its body', () => {
  // A lambda has two comma-separated regions and only the second may be ended by a
  // comma: `lambda acc, item: acc + item.t` — the commas before the `:` are the
  // parameter list. Stopping at the first comma cut the block at `lambda acc`, so
  // it covered half the parameters and none of the body.
  const spanOf = (src) => {
    const block = focus.scanBlocks(src, 'python')
      .find((b) => src.slice(b.openOffset).startsWith('lambda'));
    assert.ok(block, `no lambda block in ${JSON.stringify(src)}`);
    return src.slice(block.openOffset, block.closeOffset + 1);
  };

  assert.equal(
    spanOf('timeout_sum = fold(cfgs, 0, lambda acc, item: acc + item.timeout)\n'),
    'lambda acc, item: acc + item.timeout',
    'the block must cover the whole lambda, parameters included',
  );

  // The case the `inBody` flag exists for, and the only one that distinguishes it:
  // a multi-parameter lambda followed by ANOTHER argument. The commas before the
  // `:` belong to the parameter list; the one after the body ends the lambda. With
  // a single parameter the two rules agree, so this needs both a comma in the
  // params AND a trailing argument to be a real test.
  assert.equal(
    spanOf('x = f(lambda a, b: a + b, other)\n'),
    'lambda a, b: a + b',
    'stops at the comma that separates the lambda from the next argument',
  );
  assert.equal(
    spanOf('x = sorted(xs, key=lambda a: a.b, reverse=True)\n'),
    'lambda a: a.b',
    'a keyword argument after the lambda is not part of its body',
  );
});

test('a lambda counts as a function header, so its params are fn-scoped', () => {
  // A synthetic block has headerStart === openOffset, so the header slice is EMPTY
  // and no pattern could match it — `isFunctionHeader` returned false and a
  // lambda\'s parameters classified as block-locals instead of fn-locals.
  const src = 'x = sorted(xs, key=lambda a: a.b)\n';
  const block = focus.scanBlocks(src, 'python').find((b) => src.slice(b.openOffset).startsWith('lambda'));
  assert.ok(block);
  assert.equal(focus.isFunctionHeader(src, block), true);
});

test('`lambda` and other Python keywords are not data identities', () => {
  // The keyword list was JS/Go-only, so `lambda` was ranked as a name: it took a
  // hue in every scope containing a lambda and consumed one of the palette's few
  // slots.
  const src = 'f(0, lambda acc, item: acc + item.t)\n';
  const block = focus.scanBlocks(src, 'python').find((b) => src.slice(b.openOffset).startsWith('lambda'));
  const cls = classify.classifyFromHeuristic(
    src, focus.scopeRegionFor(src, block), undefined, [], 1,
    focus.focusKeyOf(block), undefined, focus.declRegionFor(src, block), [],
  );
  const names = [...cls.byName.keys()];
  assert.ok(!names.includes('lambda'), `\`lambda\` must not be a candidate: ${names.join(' ')}`);
  assert.ok(names.includes('acc') && names.includes('item'), 'its parameters ARE data');
});

test('a `for` inside a string or comment does not create a comprehension scope', () => {
  assert.equal(focus.scanBlocks('s = "for x in y"\n', 'python').length, 0);
  assert.equal(focus.scanBlocks('# [i for i in xs]\n', 'python').length, 0);
  assert.equal(focus.scanBlocks('d = """\nfor x in y\n"""\n', 'python').length, 0);
});

test('sample.py: the comprehension, closure and lambda each focus themselves', () => {
  const text = fs.readFileSync(SAMPLE, 'utf8');
  const blocks = focus.scanBlocks(text, 'python');
  const lines = text.split('\n');
  const expected = [
    ['for c in cfgs', 'parts = ['],
    ['await asyncio.sleep(0.01)', 'async def one'],
    ['jobs = [one(name) for name in names]', 'jobs = ['],
    ['timeout_sum = fold(cfgs, 0, lambda acc, item: acc + item.timeout)', 'timeout_sum = fold'],
  ];
  for (const [caretLine, headerPrefix] of expected) {
    const li = lineWith(text, caretLine);
    const block = focus.innermostBlock(blocks, li, undefined, text);
    assert.ok(block && !focus.isTopLevelBlock(block), `${caretLine} fell through to top level`);
    assert.ok(
      lines[block.openLine].trim().startsWith(headerPrefix),
      `${JSON.stringify(caretLine)} focused ${JSON.stringify(lines[block.openLine].trim())}, wanted ${headerPrefix}`,
    );
  }
});

test('a module global read only inside an f-string is still a global', () => {
  // `total_calls` is declared at module level and read once inside the f-string on
  // the last line of `main()`. Before the f-string lexer fix that read did not
  // exist as far as the layer was concerned, so the name had ONE occurrence, never
  // reached `computeFileGlobals`, and never painted. This asserts the whole chain:
  // f-string lexing → two occurrences → module-level declaration → global.
  const text = fs.readFileSync(SAMPLE, 'utf8');
  const { lines, starts } = lineStarts(text);
  const readLine = lines.findIndex((l) => l.includes('calls={total_calls}'));
  assert.ok(readLine > 0, 'the f-string read is missing from sample.py');
  const declLine = lines.findIndex((l) => l.trim() === 'total_calls = 0');
  const tok = (line, modifiers) => ({
    name: 'total_calls',
    type: 'variable',
    modifiers,
    offset: starts[line] + lines[line].indexOf('total_calls'),
    length: 'total_calls'.length,
    line,
  });
  // Every function in the file, so "declared outside any function" is meaningful.
  const fnRanges = focus.scanBlocks(text, 'python')
    .filter((b) => b.headerStart !== b.openOffset && focus.isFunctionHeader(text, b))
    .map((b) => ({ start: b.headerStart, end: b.closeOffset + 1 }));
  const index = classify.buildFileIndex(
    text, [tok(declLine, ['declaration']), tok(readLine, [])], fnRanges,
  );
  assert.equal((index.occurrences.get('total_calls') ?? []).length, 2,
    'the f-string read must be counted');
  assert.ok(index.fileGlobalsInOrder.includes('total_calls'),
    'declared outside every function → a file global');
});

// ── member and keyword-argument positions are not data ────────────────────────

test('an ATTRIBUTE and a same-named LOCAL do not share a hue', () => {
  // `self.retries = retries` — Pylance types both halves `variable`, so the
  // attribute and the parameter collapsed into one name and got one hue. The
  // attribute must stay a member.
  const text = fs.readFileSync(SAMPLE, 'utf8');
  const { lines, starts } = lineStarts(text);
  const li = lineWith(text, 'self.retries = retries');
  const tokens = [
    { name: 'retries', type: 'variable', modifiers: [], offset: starts[li] + lines[li].indexOf('retries'), length: 7, line: li },
    { name: 'retries', type: 'parameter', modifiers: [], offset: starts[li] + lines[li].lastIndexOf('retries'), length: 7, line: li },
  ];
  const occurrences = classify.buildFileIndex(text, tokens, []).occurrences.get('retries') ?? [];
  assert.equal(occurrences.length, 1, 'only the parameter read is a data identity');
  assert.equal(
    occurrences[0].start,
    starts[li] + lines[li].lastIndexOf('retries'),
    'the surviving occurrence is the parameter, not the attribute',
  );
});

test('a KEYWORD-ARGUMENT LABEL is not data, but its value is', () => {
  const text = fs.readFileSync(SAMPLE, 'utf8');
  const { lines, starts } = lineStarts(text);
  const li = lineWith(text, 'cfg = Config(name=name, tags={"env": "dev"})');
  const at = (name, col) => ({ name, type: 'variable', modifiers: [], offset: starts[li] + col, length: name.length, line: li });
  const tokens = [
    at('name', lines[li].indexOf('name=')),
    at('name', lines[li].indexOf('=name') + 1),
    at('tags', lines[li].indexOf('tags=')),
  ];
  const index = classify.buildFileIndex(text, tokens, []);
  assert.equal((index.occurrences.get('name') ?? []).length, 1, '`name=` is a label; `=name` is a real read');
  assert.equal((index.occurrences.get('tags') ?? []).length, 0, '`tags=` appears only as a label');
});

test('a `classMember` attribute is furniture even with no dot in front of it', () => {
  // Pylance types an instance attribute `variable` — not `property`, as TS and
  // gopls would — and distinguishes it ONLY by the `classMember` modifier. The
  // positional guard catches `self.seen`, but `dynamicAttribute` (a getattr-style
  // attribute) carries no adjacent dot, so the modifier has to be honoured too.
  const src = 'self.seen = 0\nlocal = 1\n';
  const tokens = [
    { name: 'seen', type: 'variable', modifiers: ['classMember', 'declaration'], offset: 5, length: 4, line: 0 },
    { name: 'local', type: 'variable', modifiers: ['declaration'], offset: 14, length: 5, line: 1 },
  ];
  assert.deepEqual(tintedNames(src, tokens), ['local'], 'the attribute is a member, the local is data');

  const dynamic = [{ name: 'attr', type: 'variable', modifiers: ['dynamicAttribute'], offset: 0, length: 4, line: 0 }];
  assert.deepEqual(
    tintedNames('attr = 1\n', dynamic),
    [],
    'a dynamic attribute has no dot to detect positionally — the modifier is the only signal',
  );
});

test('the member/label guard leaves ordinary bindings alone', () => {
  // The guard is positional and language-neutral, so its boundaries matter more
  // than the Python cases that motivated it.
  const cases = [
    ['total = 0', 'total', 1, 'a statement-level assignment IS a binding'],
    ['total += 1', 'total', 1, 'compound assignment is still a binding'],
    ['if name == other:', 'name', 1, '`==` is a comparison, not a label'],
    ['d[key] = 1', 'key', 1, 'a subscript is a real read'],
    ['kw = dict(a=1, b=2)', 'kw', 1, 'the left side of a call assignment is a binding'],
    ['self.retries = 1', 'retries', 0, 'after a dot is a member'],
    ['obj?.field', 'field', 0, 'optional chaining is still member access'],
    ['x = a.b', 'b', 0, 'after a dot is a member'],
  ];
  for (const [src, name, expected, why] of cases) {
    const tokens = [];
    for (let i = src.indexOf(name); i >= 0; i = src.indexOf(name, i + 1)) {
      const before = i > 0 ? src[i - 1] : ' ';
      const after = src[i + name.length] ?? ' ';
      if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
        tokens.push({ name, type: 'variable', modifiers: [], offset: i, length: name.length, line: 0 });
      }
    }
    const got = (classify.buildFileIndex(src, tokens, []).occurrences.get(name) ?? []).length;
    assert.equal(got, expected, `${JSON.stringify(src)}: ${why}`);
  }
});

test('a nested def inside a class body is not treated as a field run', () => {
  const src = [
    'class C:',
    '    field: int = 1',
    '    def m(self):',
    '        local = 2',
    '        return local',
    '    other: str = "x"',
    '',
  ].join('\n');
  const { starts, lines } = lineStarts(src);
  const at = (name, line, type = 'variable') => ({
    name,
    type,
    modifiers: ['declaration'],
    offset: starts[line] + lines[line].indexOf(name),
    length: name.length,
    line,
  });
  const names = tintedNames(src, [at('field', 1), at('local', 3), at('other', 5)]);
  assert.deepEqual(names, ['local'], 'fields before AND after the method are furniture; the local is data');
});
