'use strict';
// RENDER-PATH tests: what is actually painted, per phase, per language.
//
// This file exists because of a specific gap. Every bug in this layer that had to be
// reported twice — `self` rendering correctly then flashing white on relaxation to
// Survey, Rust format placeholders staying string green — lived in the render path,
// and the render path had NO coverage at all: `decorator.ts` imports `vscode`, which
// only exists inside an editor host, so the suite tested the pure modules (focus,
// classify, colors) and stopped at the boundary. Those modules were right. The thing
// on screen was wrong. The tests passed.
//
// `test/vscode-stub.js` closes that gap: it fakes just enough of the API for the real
// Decorator to be constructed and driven, and records what `setDecorations` receives.
// That turns the question these bugs actually turned on — *which decoration types
// carry ranges, in which phase?* — into an assertion.
//
// The distinction that matters throughout: a BAND-1 mark (self, format placeholders,
// markdown washes) is the resting register and must be phase-INDEPENDENT — identical
// in Survey, Focus and Edit. A BAND-2/3 mark (identity tints, risk) is phase-bound
// and must be withdrawn in Survey. Getting that backwards is what produced the
// flicker, and it is what these tests pin.
//
// Every phase-bound assertion has a positive control in the same run: the harness
// engages the document, classifies it with real rust-analyzer tokens, and uses the
// Phase enum, so "withdrawn in Survey" is only claimed next to "painted in Focus".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
// Required AFTER install(), so `require('vscode')` inside them resolves to the stub.
const { Decorator } = require('../out/decorator');

const { Phase } = require('../out/phases');

const SAMPLES = path.join(__dirname, '../samples');
const PHASES = [Phase.Survey, Phase.Focus, Phase.Edit];

const lspFixture = () => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/sample.rs.lsp.json'), 'utf8'));

/** Install the canned rust-analyzer responses for `sample.rs`. */
function serveRustLsp() {
  stub.clearLspResponses();
  const lsp = lspFixture();
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': lsp.legend,
    'vscode.provideDocumentSemanticTokens': { data: lsp.data },
    'vscode.executeDocumentSymbolProvider': [],
  });
}

let docSeq = 0;

/**
 * Drive the real Decorator over an ENGAGED document whose focused block has been
 * classified, and report what is painted.
 *
 * Returns a `paint(phase)` function: it sets the phase, renders, and returns a live
 * view of the decoration state. `live` mirrors what the editor holds rather than what
 * the last call passed, because `applyType` has a dirty-check — re-applying identical
 * ranges is a no-op, so observing only the most recent `setDecorations` call would
 * read "0 ranges" for anything that correctly did not change.
 */
async function harness(text, languageId, line = 0, character = 0) {
  const doc = new stub.TextDocument(text, languageId, `file:///render-${docSeq++}.${languageId}`);
  const ed = new stub.TextEditor(doc, line, character);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];

  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);

  const d = new Decorator();
  d.engaged.add(doc.uri.toString());
  await d.runClassify(doc);
  return {
    decorator: d,
    doc,
    editor: ed,
    paint(phase) {
      d.machine.phase = phase;
      d.render();
      return {
        count: (type) => (live.get(type) ?? []).length,
        ranges: (type) => live.get(type) ?? [],
        pool: d.pool,
      };
    },
  };
}

const tints = (h, snap) => [...h.decorator.pool.id, ...h.decorator.pool.idg].reduce((n, t) => n + snap.count(t), 0);
const risks = (h, snap) => snap.count(h.decorator.pool.riskAsync)
  + snap.count(h.decorator.pool.riskDanger) + snap.count(h.decorator.pool.riskEscape);

// ── band 1 is phase-independent ───────────────────────────────────────────────

test('self is painted identically in every phase, and survives relaxation', async () => {
  // The reported bug, verbatim: "self renders correctly initially, then switches to
  // blank white during survey and back to proper slate during focus". `self` was
  // painted inside renderBand2 and cleared by clearBand2, so it followed the phase —
  // but what it corrects does not. Outside a cargo workspace rust-analyzer types a
  // `self` USE as `const`, a semantic token that outranks the grammar, so band 1
  // cannot hold the colour on its own and the mark has to persist.
  serveRustLsp();
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const h = await harness(src, 'rust', 53, 10);

  const counts = PHASES.map((p) => h.paint(p).count(h.decorator.pool.self));
  assert.ok(counts[0] > 0, `self must paint in Survey, got ${counts[0]}`);
  assert.deepEqual(new Set(counts).size, 1,
    `self must be identical in every phase, got survey/focus/edit = ${counts.join('/')}`);
  assert.ok(tints(h, h.paint(Phase.Focus)) > 0, 'positive control: this run reaches a painted Focus');

  // And the full round trip, which is the sequence the user described.
  const round = [Phase.Focus, Phase.Survey, Phase.Focus].map((p) => h.paint(p).count(h.decorator.pool.self));
  assert.deepEqual(new Set(round).size, 1, `self must survive focus→survey→focus, got ${round.join('/')}`);
});

test('self covers every occurrence in the file, not just the focused block', async () => {
  // It was previously clipped to the focused block, so a `self` elsewhere in the file
  // was unpainted and fell back to whatever the semantic layer said.
  serveRustLsp();
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const h = await harness(src, 'rust', 53, 10);
  const painted = h.paint(Phase.Focus).ranges(h.decorator.pool.self);
  // Counted through the lexer, not a regex over the raw text: the sample mentions
  // `self` four times inside COMMENTS, and those must not be painted. A regex count
  // fails for the right reason and the wrong cause — it took a detour to confirm the
  // four were comments and not a gap.
  // The fixture is a detached-file capture (`Self` typed `struct`), so `Self` is
  // painted too.
  const { lexIdentifiers } = require('../out/focus');
  const marked = new Set(['self', 'this', 'Self', 'crate', 'super']);
  const ids = lexIdentifiers(src, 0, src.length, 'rust');
  const inCode = ids.filter((i) => marked.has(i.name)).length;
  assert.equal(painted.length, inCode,
    `expected ${inCode} self marks (code only, comments excluded), got ${painted.length}`);
  assert.ok(ids.filter((i) => i.name === 'self').length >= 10, 'sanity: the sample really does use self');
  // Spot-check the three lines from the report (1-based 54, 55, 67 → 0-based 53,54,66).
  const lines = new Set(painted.map((r) => r.start.line));
  for (const want of [53, 54, 66]) {
    assert.ok(lines.has(want), `self on 0-based line ${want} must be painted`);
  }
});

test('rust format placeholders are painted, in every phase', async () => {
  // The other reported bug: "placeholders are fixed in go and python, but not rust".
  // The theme's `meta.interpolation.rust` rule is correct and does select them — but
  // rust-analyzer emits ONE `string` semantic token spanning the whole literal, and a
  // semantic token overrides TextMate across its entire span. No theme rule can win
  // that; a decoration renders above both layers.
  serveRustLsp();
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const h = await harness(src, 'rust', 83, 10);
  const counts = PHASES.map((p) => h.paint(p).count(h.decorator.pool.placeholder));
  assert.ok(counts[0] > 5, `placeholders must paint in Survey, got ${counts[0]}`);
  assert.equal(new Set(counts).size, 1,
    `placeholders must be identical in every phase, got ${counts.join('/')}`);
});

test('placeholders are NOT painted by the layer in go, ts or a python %-format', async () => {
  // Those grammars scope a placeholder distinctly inside a string scope and the theme
  // reaches it, so the decoration would be redundant work on every caret move. This
  // asserts the layer stays out of the theme's way — the parity of the COLOUR is the
  // theme's check (scripts/placeholder_parity.js).
  stub.clearLspResponses();
  for (const [lang, text] of [
    ['go', 'package main\nfunc main() { println("a %d b") }\n'],
    ['python', 'n = 1\nprint("a %d b" % n)\n'],
    ['typescript', 'const n = 1;\nconsole.log(`a ${n} b`);\n'],
  ]) {
    const h = await harness(text, lang, 1, 5);
    assert.equal(h.paint(Phase.Focus).count(h.decorator.pool.placeholder), 0,
      `${lang} placeholders are the theme's job, not the layer's`);
  }
});

// ── band 2/3 are phase-bound ──────────────────────────────────────────────────

test('band 2 identity tints and the gutter paint in Focus and Edit, and are withdrawn in Survey', async () => {
  // The control for the tests above. If a fix for band-1 persistence accidentally
  // made the phase bands persistent too, the layer would never be calm at rest —
  // which is the whole point of Survey.
  serveRustLsp();
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const h = await harness(src, 'rust', 82, 12);
  const focus = h.paint(Phase.Focus);
  assert.ok(tints(h, focus) > 0, `Focus must paint identity tints, got ${tints(h, focus)}`);
  assert.ok(focus.count(h.decorator.gutterDecoration) > 0, 'Focus paints the gutter stripe');
  assert.ok(tints(h, h.paint(Phase.Edit)) > 0, 'Edit keeps the identity tints (superset)');
  const survey = h.paint(Phase.Survey);
  assert.equal(tints(h, survey), 0, `Survey must carry no identity tints, got ${tints(h, survey)}`);
  assert.equal(survey.count(h.decorator.gutterDecoration), 0, 'Survey withdraws the gutter stripe');
});

test('an unengaged document paints no phase bands even in Focus', async () => {
  serveRustLsp();
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const h = await harness(src, 'rust', 82, 12);
  assert.ok(tints(h, h.paint(Phase.Focus)) > 0, 'positive control: engaged, Focus paints');
  h.decorator.engaged.clear();
  const snap = h.paint(Phase.Focus);
  assert.equal(h.decorator.pool.banded().reduce((n, t) => n + snap.count(t), 0), 0);
});

test('band 3 risk marks paint in Edit and are withdrawn outside it', async () => {
  serveRustLsp();
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const line = src.split('\n').findIndex((l) => l.includes('total += c.retries'));
  const h = await harness(src, 'rust', line, 8);
  const edit = h.paint(Phase.Edit);
  assert.ok(edit.count(h.decorator.pool.riskEscape) > 0, 'Edit marks the escaping write `total +=`');
  assert.equal(risks(h, h.paint(Phase.Survey)), 0, 'Survey carries no risk marks');
  assert.equal(risks(h, h.paint(Phase.Focus)), 0, 'Focus carries no risk marks');
});

test('clay numbers ride Focus and Edit, not Survey', async () => {
  serveRustLsp();
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const h = await harness(src, 'rust', 82, 12);
  const clay = (p) => h.paint(p).count(h.decorator.pool.numberEngaged);
  assert.ok(clay(Phase.Focus) > 0, 'the `1u32` literal is clay in Focus');
  assert.ok(clay(Phase.Edit) > 0, 'and in Edit');
  assert.equal(clay(Phase.Survey), 0, 'and receded in Survey');
});

// ── static content and prose never paint ──────────────────────────────────────

test('static content and prose files paint nothing in any phase', async () => {
  // Verified through the REAL render path rather than by checking that scanBlocks
  // returns []. A JSON file has braces and identifiers, so the block scanner would
  // happily find scopes in it. The document is engaged and the phases are real, so
  // the code-file control below proves the same harness does paint.
  stub.clearLspResponses();
  const cases = {
    json: '{ "name": "x", "nested": { "a": 1 } }',
    yaml: 'name: x\nnested:\n  a: 1',
    toml: '[section]\nname = "x"',
    html: '<div class="a"><span>hi</span></div>',
    css: '.a { color: red; }',
    markdown: '# Title\n\nSome prose with `code` in it.\n',
  };
  for (const [lang, text] of Object.entries(cases)) {
    const h = await harness(text, lang, 0, 2);
    for (const phase of PHASES) {
      const snap = h.paint(phase);
      const banded = h.decorator.pool.banded().reduce((n, t) => n + snap.count(t), 0);
      assert.equal(banded, 0, `${lang} must paint no phase bands in ${phase}, got ${banded}`);
      assert.equal(snap.count(h.decorator.gutterDecoration), 0, `${lang}: no gutter in ${phase}`);
    }
  }
  const control = await harness('function f(a) {\n  const b = a + 1;\n  return b + a;\n}\n', 'javascript', 1, 4);
  assert.ok(tints(control, control.paint(Phase.Focus)) > 0, 'positive control: a code file paints in Focus');
});

test('KDL paints nothing, band 1 included, with the caret in a children block', async () => {
  stub.clearLspResponses();
  const kdl = [
    'package {',
    '    node /-skipped-arg kept /-skipped=prop kept=prop /-{ skipped }',
    '    numbers 1_000 0xdead_beef 0o755 0b1010_0101 1.5e-3 -12 #inf #nan',
    '    raw #"C:\\path\\with "quotes""# r"C:\\Users\\zkat\\"',
    '    multi """',
    '        a "multi-line" string 42',
    '        """',
    '    mode async; owner self',
    '    /* outer /* nested */ still a comment */',
    '    binds { Mod+1 { focus-workspace 1; } }',
    '}',
    '',
  ].join('\n');
  const painted = (h, snap) => [...h.decorator.pool.all(), h.decorator.gutterDecoration]
    .reduce((n, t) => n + snap.count(t), 0);
  const h = await harness(kdl, 'kdl', 1, 28);
  for (const phase of PHASES) {
    assert.equal(painted(h, h.paint(phase)), 0, `kdl must paint nothing in ${phase}`);
  }
  assert.deepEqual(stub.lspCalls.map(([cmd]) => cmd), [], 'kdl asks the language server nothing');
  // The same text under an unlisted id falls to the default lexer and paints every band.
  const control = await harness(kdl, 'unlisted', 1, 28);
  const focus = control.paint(Phase.Focus);
  assert.ok(focus.count(control.decorator.gutterDecoration) > 0, 'control: gutter stripe');
  assert.ok(tints(control, focus) > 0, 'control: identity tints');
  assert.ok(focus.count(control.decorator.pool.numberEngaged) > 0, 'control: clay numbers');
  assert.ok(focus.count(control.decorator.pool.self) > 0, 'control: self paint');
  assert.ok(risks(control, control.paint(Phase.Edit)) > 0, 'control: async risk mark');
});

test('a click and typing in KDL leave the phase in Survey', async () => {
  stub.clearLspResponses();
  const doc = new stub.TextDocument('layout {\n    gaps 3\n}\n', 'kdl', `file:///render-${docSeq++}.kdl`);
  const ed = new stub.TextEditor(doc, 1, 6);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const d = new Decorator();
  d.onSelection({ textEditor: ed, selections: ed.selections, kind: 2 });
  assert.equal(d.machine.current, Phase.Survey, 'a click in a children block focuses nothing');
  const at = doc.offsetAt(ed.selection.active);
  d.onEdit(doc.applyEdit(at, at, '0'));
  ed.selection = new stub.Selection(1, 7, 1, 7);
  d.onSelection({ textEditor: ed, selections: ed.selections, kind: 1 });
  assert.equal(d.machine.current, Phase.Survey, 'typing ends in Survey');
  d.dispose();
});

// An undo that restores the caret reports no selection change, so the edit alone decides the phase.
test('an edit in a static file with no caret event after it leaves the phase in Survey', async () => {
  for (const [lang, text] of [['dockerbake', 'target "app" {\n  tags = ["a"]\n}\n'], ['helm', 'a: {{ .Values.x }}\nb: 2\n'], ['markdown', '# Notes\n\nsome text\n']]) {
    stub.clearLspResponses();
    const doc = new stub.TextDocument(text, lang, `file:///render-${docSeq++}.${lang}`);
    const ed = new stub.TextEditor(doc, 1, 2);
    vs.window.activeTextEditor = ed;
    vs.window.visibleTextEditors = [ed];
    const d = new Decorator();
    const at = doc.offsetAt(ed.selection.active);
    d.onEdit(doc.applyEdit(at, at, '0'));
    assert.equal(d.machine.current, Phase.Survey, `${lang}: an edit alone does not enter Edit`);
    d.dispose();
  }
});

// Config formats by the id VS Code gives them (test/fixtures/static-languages.json);
// each text holds `self`, `this`, `async`, numbers and nested blocks, which paint in code.
const WALKS = path.join(__dirname, 'fixtures/transitions');
const walkText = (f) => fs.readFileSync(path.join(WALKS, f), 'utf8');
const CONFIG_TEXTS = {
  yaml: walkText('walk.yaml'),
  'github-actions-workflow': walkText('walk.workflow.yml'),
  dockercompose: walkText('walk.compose.yaml'),
  dockerfile: walkText('walk.Dockerfile'),
  helm: walkText('walk.helm.yaml'),
  gotmpl: '{{/* self, this, async and numbers */}}\n{{define "row"}}\n  <td>{{.Self | printf "%q"}}</td>\n{{end}}\n{{range $i, $item := .Items}}\n  {{with $item.self}}{{.}} this {{$i}} of 42{{end}}\n  {{$async := index $item.Tags 0}}{{template "row" $async}}\n{{end}}\n',
  toml: walkText('walk.toml'),
  json: walkText('walk.json'),
  jsonc: walkText('walk.jsonc'),
  json5: "// json5\n{\n  self: 'this',\n  nested: { a: 0x1F, b: +Infinity, c: [1, 2,], },\n  async: true,\n}\n",
  jsonl: '{"id": 1, "self": "this", "nested": {"a": [1, 2]}}\n{"id": 2, "self": "async", "nested": {"a": [3, 4]}}\n',
  snippets: '{\n  "Print self": {\n    "prefix": "self",\n    "body": ["console.log(this.${1:value});", "$0"],\n    "description": "async {x} 42"\n  }\n}\n',
  ini: walkText('walk.ini'),
  properties: walkText('walk.gitconfig'),
  'java-properties': '# self\napp.name=self\napp.retries = 3\napp.message=Hello {0}, this is ${user.name}\n! async\n',
  dotenv: walkText('walk.env'),
  ignore: walkText('walk.gitignore'),
  'pip-requirements': '# pinned\nrequests==2.32.3\nthis-pkg>=1.0,<2 ; python_version >= "3.11"\n-e git+https://github.com/example/self.git#egg=self\nasync-lib[extra]==0.4\n',
  'go.mod': 'module example.com/self\n\ngo 1.23\n\nrequire (\n\tgolang.org/x/sync v0.8.0\n\texample.com/this v1.2.3 // indirect\n)\n\nreplace example.com/async => ../async\n',
  'go.sum': 'example.com/this v1.2.3 h1:abc123=\nexample.com/this v1.2.3/go.mod h1:def456=\n',
  'go.work': 'go 1.23\n\nuse (\n\t./self\n\t./this\n)\n',
  dockerbake: walkText('walk.docker-bake.hcl'),
  'cmake-cache': '# This is the CMakeCache file.\n//Path to self\nCMAKE_BUILD_TYPE:STRING=Release\nBUILD_ASYNC:BOOL=ON\nRETRIES:STRING=3\n',
  dts: '/ {\n    keymap {\n        compatible = "zmk,keymap";\n        default_layer {\n            bindings = <&kp TAB &kp Q &mo 1 &kp ESC>;\n            self = <0x3c 32>;\n        };\n    };\n};\n',
  'csv (pipe)': 'name|self|this\na|1|2\nb|3|async\n',
  css: walkText('walk.css'),
  tailwindcss: walkText('walk.css'),
  handlebars: walkText('walk.hbs'),
  scss: walkText('walk.scss'),
  less: walkText('walk.less'),
  stylus: walkText('walk.styl'),
  postcss: walkText('walk.pcss'),
  graphql: walkText('walk.graphql'),
  razor: walkText('walk.cshtml'),
  aspnetcorerazor: walkText('walk.razor'),
  xml: walkText('walk.xml'),
  xsl: '<?xml version="1.0"?>\n<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">\n  <xsl:template match="/">\n    <xsl:if test="self &gt; 42"><p>{this}</p></xsl:if>\n  </xsl:template>\n</xsl:stylesheet>\n',
  'html-template': '<% const self = this; %>\n<script>\n  function f(async) { const n = 42; return { self: async + n }; }\n</script>\n<p><%= self %></p>\n',
  dtd: '<!ELEMENT note (to, from, body)>\n<!ATTLIST note self CDATA #IMPLIED>\n<!ENTITY async "this">\n<!-- 42 notes { self } -->\n',
  rnc: 'default namespace = "http://example.com/note"\nstart = element note {\n  attribute self { text },\n  element body { xsd:integer { minInclusive = "42" } }\n}\n',
};

/** The caret on the most deeply indented word: the most nested block. */
function nestedCaret(text) {
  let best = { line: 0, character: 0, ind: -1 };
  text.split('\n').forEach((l, line) => {
    const ind = l.length - l.trimStart().length;
    const m = /[A-Za-z_]\w*/.exec(l.slice(ind));
    if (m && ind > best.ind && !/^(#|\/\/|;|!)/.test(l.trim())) best = { line, character: ind + m.index, ind };
  });
  return best;
}

test('every config format paints nothing, band 1 included, asks no server, and stays in Survey', async () => {
  const all = (d) => [...d.pool.all(), d.gutterDecoration];
  for (const [lang, text] of Object.entries(CONFIG_TEXTS)) {
    stub.clearLspResponses();
    const { line, character } = nestedCaret(text);
    const h = await harness(text, lang, line, character);
    for (const phase of PHASES) {
      const snap = h.paint(phase);
      assert.equal(all(h.decorator).reduce((n, t) => n + snap.count(t), 0), 0, `${lang} must paint nothing in ${phase}`);
    }
    // Real input: a click in the nested block, then typing there.
    const doc = new stub.TextDocument(text, lang, `file:///render-${docSeq++}`);
    const ed = new stub.TextEditor(doc, line, character);
    const live = new Map();
    ed.setDecorations = (type, ranges) => live.set(type, ranges);
    vs.window.activeTextEditor = ed;
    vs.window.visibleTextEditors = [ed];
    const d = new Decorator();
    d.onSelection({ textEditor: ed, selections: ed.selections, kind: 2 });
    assert.equal(d.machine.current, Phase.Survey, `${lang}: a click focuses nothing`);
    const at = doc.offsetAt(ed.selection.active);
    d.onEdit(doc.applyEdit(at, at, 'self '));
    ed.selection = new stub.Selection(line, character + 5, line, character + 5);
    d.onSelection({ textEditor: ed, selections: ed.selections, kind: 1 });
    await d.runClassify(doc);
    d.render();
    assert.equal(d.machine.current, Phase.Survey, `${lang}: typing ends in Survey`);
    assert.equal(all(d).reduce((n, t) => n + (live.get(t) ?? []).length, 0), 0, `${lang}: nothing painted after typing`);
    assert.deepEqual(stub.lspCalls.map(([cmd]) => cmd), [], `${lang} asks the language server nothing`);
    d.dispose();
  }
  // The workflow under an unlisted id: the default lexer, a whole-file scope, every band.
  const text = CONFIG_TEXTS['github-actions-workflow'];
  const { line, character } = nestedCaret(text);
  const control = await harness(text, 'unlisted', line, character);
  const focus = control.paint(Phase.Focus);
  assert.ok(focus.count(control.decorator.gutterDecoration) > 0, 'control: gutter stripe');
  assert.ok(tints(control, focus) > 0, 'control: identity tints');
  assert.ok(focus.count(control.decorator.pool.self) > 0, 'control: self paint');
  assert.ok(risks(control, control.paint(Phase.Edit)) > 0, 'control: async risk mark');
});

test('a Helm template and a Go template paint nothing; read as an unlisted id the same text engages', async () => {
  for (const [lang, needle, word] of [['helm', '- name: SELF', 'name'], ['gotmpl', '{{with $item.self}}', 'item']]) {
    const text = CONFIG_TEXTS[lang];
    const line = text.split('\n').findIndex((l) => l.includes(needle));
    const character = text.split('\n')[line].indexOf(word);
    for (const [id, engaged] of [[lang, false], ['unlisted', true]]) {
      stub.clearLspResponses();
      const h = await harness(text, id, line, character);
      const focus = h.paint(Phase.Focus);
      assert.equal(focus.count(h.decorator.pool.self) > 0, engaged, `${lang} as ${id}: self mark on a .self field`);
      assert.equal(tints(h, focus) > 0, engaged, `${lang} as ${id}: identity tints`);
      assert.equal(focus.count(h.decorator.gutterDecoration) > 0, engaged, `${lang} as ${id}: gutter stripe`);
    }
  }
});

// ── the decoration pool's band split ──────────────────────────────────────────

test('the pool puts phase marks in banded() and band-1 marks outside it', async () => {
  // `clearAllVisible(false)` withdraws exactly `banded()` when focus leaves the
  // editor. A band-1 mark in that set would blink whenever the caret moved to a
  // panel — and, for `self`, would also be cleared by clearBand2 on every relaxation
  // to Survey. That membership IS the bug, so it is asserted directly.
  stub.clearLspResponses();
  const h = await harness('fn f() {}\n', 'rust');
  const pool = h.decorator.pool;
  assert.ok(!pool.banded().includes(pool.self), 'self is band 1, not a phase band');
  assert.ok(!pool.banded().includes(pool.placeholder), 'placeholders are band 1');
  assert.ok(pool.all().includes(pool.self), 'self is still cleared when the layer is switched off');
  assert.ok(pool.all().includes(pool.placeholder), 'placeholders too');
  // The controls: these ARE phase bands.
  assert.ok(pool.banded().includes(pool.id[0]), 'identity tints are phase bands');
  assert.ok(pool.banded().includes(pool.riskEscape), 'risk marks are phase bands');
});

// ── the Rust placeholder scanner ──────────────────────────────────────────────

const { rustPlaceholderSpans } = require('../out/placeholders');

test('rustPlaceholderSpans: finds holes, skips escapes and non-strings', () => {
  const cases = [
    // [source, expected placeholder texts]
    ['println!("{} and {}", a, b);', ['{}', '{}']],
    ['println!("{name} {n:>8} {0:.2}", n);', ['{name}', '{n:>8}', '{0:.2}']],
    // `{{` / `}}` are ESCAPED literal braces, not placeholders.
    ['println!("100{{}} done");', []],
    ['println!("{{literal}} but {} real", x);', ['{}']],
    // A brace OUTSIDE a string is a block brace.
    ['fn f() { let x = 1; }', []],
    // A brace in a comment is prose.
    ['// a {} in a comment\nfn f() {}', []],
    ['/* block {} comment */', []],
    // A lifetime must not open a char literal and swallow the file.
    ["fn f<'a>(x: &'a str) { println!(\"{}\", x); }", ['{}']],
    // A char literal is not a string.
    ["fn f() { let c = '{'; println!(\"{}\", c); }", ['{}']],
    // A raw string is still a format string.
    ['println!(r"{} raw", x);', ['{}']],
    ['println!(r#"{} hashed"#, x);', ['{}']],
    // An unclosed brace is not a placeholder.
    ['println!("{ unclosed", x);', []],
  ];
  for (const [src, want] of cases) {
    const got = rustPlaceholderSpans(src).map((s) => src.slice(s.start, s.end));
    assert.deepEqual(got, want, `for ${JSON.stringify(src)}`);
  }
});

test('rustPlaceholderSpans: covers every placeholder in the real sample', () => {
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const spans = rustPlaceholderSpans(src);
  // Each span must actually be a `{…}` in the source — a drifted offset would slice
  // mid-token and still "pass" a count check, the stale-fixture failure mode.
  for (const s of spans) {
    const text = src.slice(s.start, s.end);
    assert.match(text, /^\{[^{}]*\}$/, `span ${s.start}-${s.end} is not a placeholder: ${JSON.stringify(text)}`);
  }
  assert.ok(spans.length >= 12, `expected the sample's format strings, got ${spans.length}`);
});

// ── Python f-string fields ────────────────────────────────────────────────────
//
// The grammar scopes a field's braces `constant.character.format.placeholder.other`
// under `meta.fstring.python` with no `string` scope there, so VS Code's bracket-pair
// colorization takes them and they render bracket grey in the real editor, with or
// without Pylance. The e2e harness found it on `print(f"dropped {id} at {up_to:>4}")`.

const { pythonPlaceholderSpans } = require('../out/placeholders');

test('pythonPlaceholderSpans: braces, conversion and spec; never the expression or an escape', () => {
  const cases = [
    ['print(f"dropped {id} at {up_to:>4}", file=sys.stderr)', ['{', '}', '{', ':>4}']],
    ['f"{x!r}"', ['{', '!r}']],
    ['t"{x!s}"', ['{', '!s}']],
    ['f"{a!r:>8}"', ['{', '!r:>8}']],
    // A self-documenting `=` against the terminator is format syntax, as the grammar has it.
    ['f"{y=}"', ['{', '=}']],
    ['f"{y=!r}"', ['{', '=!r}']],
    ['f"{z = }"', ['{', '}']],
    ['f"{a == b} {a != b} {a <= b}"', ['{', '}', '{', '}', '{', '}']],
    // A top-level `:` opens the spec, so this is fill `=`, width 5; a walrus needs parentheses.
    ['f"{x:=5}"', ['{', ':=5}']],
    ['f"{(x := 5)}"', ['{', '}']],
    // Nested fields in a spec: their braces are marks, their expressions code.
    ['f"{w:{width}.{prec}f}"', ['{', ':{', '}.{', '}f}']],
    ['f"{x!r:{w}}"', ['{', '!r:{', '}}']],
    ['f\'{d["k"]:>{n}}\'', ['{', ':>{', '}}']],
    // A field inside a field's expression is a field of its own.
    ['f"{f"{y}"}"', ['{', '{', '}', '}']],
    ['f"""{x\n:>4}"""', ['{', ':>4}']],
    // `{{` and `}}` are escaped text.
    ['f"{{literal}} {x}"', ['{', '}']],
    ['f"{{{x}}}"', ['{', '}']],
    ['rf"{x}\\d{{2}}"', ['{', '}']],
    // Not f-strings, or not fields.
    ['"{} {name}".format(1, name=2)', []],
    ['b"{x}"', []],
    ['# f"{x}" in a comment\n', []],
    ['"""doc {x}"""', []],
    // Still open where the line or the string ends: not painted.
    ['f"{x"\n', []],
    ['f"{x:>4\n', []],
  ];
  for (const [src, want] of cases) {
    const got = pythonPlaceholderSpans(src).map((s) => src.slice(s.start, s.end));
    assert.deepEqual(got, want, `for ${JSON.stringify(src)}`);
  }
});

const FSTRING = [
  'import sys',
  '',
  'def drop(queue, up_to):',
  '    dropped = 0',
  '    for id in range(dropped):',
  '        print(f"dropped {id} at {up_to:>4}", file=sys.stderr)',
  '    return dropped',
  '',
].join('\n');

const markTexts = (doc, ranges) => ranges
  .map((r) => `${r.start.line}:${r.start.character}=${doc.lineAt(r.start.line).text.slice(r.start.character, r.end.character)}`);

test('python f-string fields are painted in every phase, with and without a server', async () => {
  for (const server of [false, true]) {
    stub.clearLspResponses();
    if (server) {
      const at = FSTRING.indexOf('id at');
      const enc = stub.encodeTokens(FSTRING, [{ offset: at, length: 2, type: 'variable', modifiers: [] }]);
      stub.setLspResponses({
        'vscode.provideDocumentSemanticTokensLegend': enc.legend,
        'vscode.provideDocumentSemanticTokens': { data: enc.data },
        'vscode.executeDocumentSymbolProvider': [],
      });
    }
    const h = await harness(FSTRING, 'python', 5, 10);
    const texts = PHASES.map((p) => markTexts(h.doc, h.paint(p).ranges(h.decorator.pool.placeholder)).join(' '));
    assert.equal(texts[0], '5:24={ 5:27=} 5:32={ 5:38=:>4}', `server=${server}: the braces and the spec, never id or up_to`);
    assert.equal(new Set(texts).size, 1, `server=${server}: identical in every phase, got ${texts.join(' / ')}`);
  }
});

test('typing through an f-string field repaints the field marks at every version, with no leftovers', async () => {
  // Each step is one edit; after it renders, the placeholder ranges on screen are
  // exactly the scan of the new text. Deleting the closing brace must take the
  // opening one off too, and dropping the `f` prefix takes every mark off.
  stub.clearLspResponses();
  const h = await harness(FSTRING, 'python', 5, 10);
  const d = h.decorator;
  const doc = h.doc;
  const painted = () => h.paint(Phase.Edit).ranges(d.pool.placeholder)
    .map((r) => doc.getText().slice(doc.offsetAt(r.start), doc.offsetAt(r.end)));
  const want = () => pythonPlaceholderSpans(doc.getText()).map((s) => doc.getText().slice(s.start, s.end));
  const field = () => doc.getText().indexOf('{id');
  const steps = [
    ['add a conversion', () => doc.applyEdit(field() + 3, field() + 3, '!r'), ['{', '!r}', '{', ':>4}']],
    ['add a spec', () => doc.applyEdit(field() + 5, field() + 5, ':<6'), ['{', '!r:<6}', '{', ':>4}']],
    ['delete the closing brace', () => doc.applyEdit(field() + 8, field() + 9, ''), ['{', ':>4}']],
    ['type it back', () => doc.applyEdit(field() + 8, field() + 8, '}'), ['{', '!r:<6}', '{', ':>4}']],
    ['open a nested field in the spec', () => doc.applyEdit(field() + 7, field() + 7, '{w}'), ['{', '!r:<{', '}6}', '{', ':>4}']],
    ['drop the f prefix', () => { const f = doc.getText().indexOf('f"dropped'); return doc.applyEdit(f, f + 1, ''); }, []],
    ['put it back', () => { const q = doc.getText().indexOf('"dropped'); return doc.applyEdit(q, q, 'f'); }, ['{', '!r:<{', '}6}', '{', ':>4}']],
  ];
  for (const [name, edit, expect] of steps) {
    d.onEdit(edit());
    await Promise.resolve();
    assert.deepEqual(painted(), expect, `${name}: on screen`);
    assert.deepEqual(painted(), want(), `${name}: equals the scan of the new text`);
  }
});

// ── Rust path keywords outside a cargo workspace ──────────────────────────────
//
// Real rust-analyzer 0.3.3105 replies for test/fixtures/rust-paths.rs: `detached` with
// the file alone, `cargoLoading` the first reply in a cargo package (before the
// workspace loads), `cargo` the settled reply there. Detached, `Self` comes as
// `struct` and `crate` / `super` as `namespace`, which the theme paints type slate
// over the grammar's keyword. A cargo package sends exactly that until it loads.

const PATHS_SRC = fs.readFileSync(path.join(__dirname, 'fixtures/rust-paths.rs'), 'utf8');
const PATHS_TOKENS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/rust-paths.tokens.json'), 'utf8'));
const { rustPathKeywords } = require('../out/classify-lsp');
const { lexFor } = require('../out/lex');

/** Code identifiers named in `names`, as `line:col=name`. */
function codeIds(text, names) {
  const lx = lexFor(text, 'rust');
  return lx.idents.filter((i) => names.has(i.name)).map((i) => {
    const line = lx.lineOf(i.offset);
    return `${line}:${i.offset - lx.lineStarts[line]}=${i.name}`;
  });
}
const SELF_ONLY = new Set(['self', 'this']);
const WITH_PATHS = new Set(['self', 'this', 'Self', 'crate', 'super']);
const selfMarks = (h, phase) => markTexts(h.doc, h.paint(phase).ranges(h.decorator.pool.self));

function servePaths(capture) {
  stub.clearLspResponses();
  if (!capture) return;
  const enc = stub.encodeTokens(PATHS_SRC, PATHS_TOKENS[capture]);
  stub.setLspResponses({
    'vscode.provideDocumentSemanticTokensLegend': enc.legend,
    'vscode.provideDocumentSemanticTokens': { data: enc.data },
    'vscode.executeDocumentSymbolProvider': [],
  });
}

test('the path-keyword captures are current and show the degradation they claim', () => {
  for (const [name, toks] of Object.entries(PATHS_TOKENS)) {
    const drift = toks.filter((t) => PATHS_SRC.slice(t.offset, t.offset + t.length) !== t.name);
    assert.equal(drift.length, 0, `${name}: ${drift.length} offsets no longer match — regenerate`);
  }
  assert.deepEqual(PATHS_TOKENS.cargoLoading, PATHS_TOKENS.detached,
    'a cargo package answers exactly like a detached file until its workspace loads');
  assert.equal(rustPathKeywords(PATHS_TOKENS.detached), 'degraded');
  assert.equal(rustPathKeywords(PATHS_TOKENS.cargo), 'keyword');
  assert.equal(rustPathKeywords(PATHS_TOKENS.cargo.filter((t) => !WITH_PATHS.has(t.name))), undefined,
    'an answer that types none of the three says nothing');
  const types = (cap, n) => [...new Set(PATHS_TOKENS[cap].filter((t) => t.name === n).map((t) => t.type))].sort().join(',');
  assert.equal(types('detached', 'Self'), 'struct');
  assert.equal(types('cargo', 'Self'), 'selfTypeKeyword');
  assert.equal(types('cargo', 'crate'), 'keyword');
});

test('Self, crate and super take the keyword mark on a degraded answer, in every phase', async () => {
  for (const capture of ['detached', 'cargoLoading']) {
    servePaths(capture);
    const h = await harness(PATHS_SRC, 'rust', 24, 8);
    const want = codeIds(PATHS_SRC, WITH_PATHS);
    assert.ok(want.filter((x) => /=(Self|crate|super)$/.test(x)).length >= 10, 'sanity: the fixture uses all three');
    const phases = PHASES.map((p) => selfMarks(h, p).join(' '));
    assert.equal(phases[0], want.join(' '), `${capture}: every code Self/crate/super/self, none in the comment or string`);
    assert.equal(new Set(phases).size, 1, `${capture}: identical in every phase`);
  }
});

test('Self, crate and super are left to the theme once rust-analyzer types them as keywords', async () => {
  servePaths('cargo');
  const h = await harness(PATHS_SRC, 'rust', 24, 8);
  assert.deepEqual(selfMarks(h, Phase.Survey), codeIds(PATHS_SRC, SELF_ONLY));
});

test('the path-keyword mark follows every answer: none, loading, loaded, restarted, gone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  // One document through the states a cargo package goes through, each reached by an
  // edit (a comment appended at the end, so earlier offsets hold). After each answer
  // the marks on screen are exactly the set that state needs: nothing left over from
  // the state before, and no gap while the grammar or the cargo answer is right. The
  // caret moves with no selection event, so band 2 discards each classification for
  // a stale focus key; band 1 still follows the answer.
  stub.clearLspResponses();
  const doc = new stub.TextDocument(PATHS_SRC, 'rust', 'file:///render-paths-transitions.rs');
  const ed = new stub.TextEditor(doc, 24, 8);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, r) => live.set(type, r);
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  let state = null;
  stub.setLspHandler((cmd) => {
    if (!state) return undefined;
    const enc = stub.encodeTokens(doc.getText(), PATHS_TOKENS[state]);
    if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return enc.legend;
    if (cmd === 'vscode.provideDocumentSemanticTokens') return { data: enc.data };
    if (cmd === 'vscode.executeDocumentSymbolProvider') return [];
    return undefined;
  });
  const marks = () => markTexts(doc, live.get(d.pool.self) ?? []);
  d.refresh();
  await settle(t);
  assert.deepEqual(marks(), codeIds(doc.getText(), WITH_PATHS), 'no provider yet: painted, a no-op over the grammar');

  const steps = [
    ['cargoLoading', WITH_PATHS, 'the server answers before its workspace loads'],
    ['cargo', SELF_ONLY, 'the workspace loaded: left to the theme'],
    ['detached', WITH_PATHS, 'a restart answers degraded again'],
    [null, WITH_PATHS, 'the provider is gone: back to the grammar'],
  ];
  for (const [next, names, why] of steps) {
    state = next;
    const end = doc.getText().length;
    const ev = doc.applyEdit(end, end, '// edit\n');
    ed.selection = new vs.Selection(doc.lineCount - 1, 0, doc.lineCount - 1, 0);
    d.onEdit(ev);
    await settle(t);
    assert.deepEqual(marks(), codeIds(doc.getText(), names), `${next}: ${why}`);
  }
  d.dispose();
  stub.clearLspResponses();
});

test('a degraded answer is asked again with no edit: the loaded one replaces it, then the asking stops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  // The theme repo's real-editor focus run: a cargo file opened while its workspace
  // loaded kept the first answer, `MAX_RETRIES` typed `struct`, so a const read in a
  // struct literal never traced. Here `super::BASE` in `helper` is that read.
  const base = PATHS_SRC.indexOf('BASE + 1');
  assert.equal(PATHS_TOKENS.cargoLoading.find((tk) => tk.offset === base).type, 'struct', 'sanity: degraded');
  assert.equal(PATHS_TOKENS.cargo.find((tk) => tk.offset === base).type, 'const', 'sanity: loaded');
  const advance = async (ms) => {
    for (let left = ms; left > 0; left -= 50) {
      t.mock.timers.tick(50);
      await new Promise((r) => setImmediate(r));
    }
  };
  const open = (name, line, ch) => {
    const doc = new stub.TextDocument(PATHS_SRC, 'rust', `file:///${name}.rs`);
    const ed = new stub.TextEditor(doc, line, ch);
    vs.window.activeTextEditor = ed;
    vs.window.visibleTextEditors = [ed];
    const live = new Map();
    ed.setDecorations = (type, r) => live.set(type, r);
    const d = new Decorator();
    d.engaged.add(doc.uri.toString());
    return { doc, ed, d, live };
  };
  let state = 'cargoLoading';
  let asked = 0;
  stub.setLspHandler((cmd, uri) => {
    const enc = stub.encodeTokens(PATHS_SRC, PATHS_TOKENS[state]);
    if (cmd === 'vscode.provideDocumentSemanticTokensLegend') return enc.legend;
    if (cmd === 'vscode.provideDocumentSemanticTokens') { asked++; return { data: enc.data }; }
    if (cmd === 'vscode.executeDocumentSymbolProvider') return [];
    return undefined;
  });

  const w = open('render-paths-load', 5, 8);
  const tinted = () => {
    w.d.machine.phase = Phase.Focus;
    w.d.render();
    return w.d.pool.idg.some((type) => (w.live.get(type) ?? []).some((r) => w.doc.offsetAt(r.start) === base));
  };
  w.d.refresh();
  await settle(t);
  assert.equal(asked, 1);
  assert.equal(tinted(), false, 'degraded: BASE is not a data identity there');
  assert.deepEqual(markTexts(w.doc, w.live.get(w.d.pool.self) ?? []), codeIds(PATHS_SRC, WITH_PATHS));

  state = 'cargo'; // the workspace loads; nothing is typed
  await advance(1100);
  assert.equal(asked, 2, 'the first retry asks again');
  assert.equal(tinted(), true, 'loaded: BASE traces bold in helper');
  assert.deepEqual(markTexts(w.doc, w.live.get(w.d.pool.self) ?? []), codeIds(PATHS_SRC, SELF_ONLY), 'band 1 follows');
  await advance(40000);
  assert.equal(asked, 2, 'a loaded answer is final');
  w.d.dispose();

  // A detached file answers degraded for good: the schedule, then one fetch per version.
  state = 'detached';
  asked = 0;
  const x = open('render-paths-detached', 5, 8);
  x.d.refresh();
  await advance(40000);
  assert.equal(asked, 1 + x.d.classifier.retrySchedule.length, 'the open, then each retry once');
  const end = x.doc.getText().length;
  x.d.onEdit(x.doc.applyEdit(end, end, '// edit\n'));
  await advance(40000);
  assert.equal(asked, 2 + x.d.classifier.retrySchedule.length, 'spent: an edit costs one fetch');
  x.d.dispose();
  stub.clearLspResponses();
});

test('Self and super are never the keyword mark outside Rust', async () => {
  stub.clearLspResponses();
  for (const [lang, text] of [
    ['python', 'class A(B):\n    def __init__(self):\n        super().__init__()\n'],
    ['typescript', 'class A extends B {\n  constructor() { super(); this.x = 1; }\n}\n'],
  ]) {
    const h = await harness(text, lang, 1, 4);
    const got = selfMarks(h, Phase.Survey).map((x) => x.split('=')[1]);
    assert.ok(!got.includes('super') && !got.includes('Self'), `${lang}: ${got.join(',')}`);
    assert.ok(got.length > 0, `${lang}: positive control, self/this still painted`);
  }
});

// ── the FULL async lifecycle, not just a synchronous render() ─────────────────
//
// The tests above call `render()` directly, which was not enough: the user reported
// both marks "blinking multiple times back and forth" and then settling WRONG, and
// those tests stayed green. A direct `render()` skips the real sequence — refresh →
// onSelection → debounced classify → repaint, plus the relax timer — and it skips the
// language-server round trip entirely, because the stub returned nothing so
// `runClassify` bailed before ever repainting. These drive the real path with real
// rust-analyzer tokens served through the stub.

/** 250 ms on the fake clock, letting the async work between ticks run. */
async function settle(t) {
  for (let left = 250; left > 0; left -= 10) {
    t.mock.timers.tick(10);
    await new Promise((r) => setImmediate(r));
  }
}

test('self and placeholders never blink across the real open→focus→relax lifecycle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  // Records EVERY setDecorations call, so a value that flaps and settles wrong is
  // visible as a sequence rather than just a final state. "Blinking" is precisely a
  // sequence the end-state check cannot see.
  serveRustLsp();
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const doc = new stub.TextDocument(src, 'rust', 'file:///lifecycle.rs');
  const ed = new stub.TextEditor(doc, 53, 10);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];

  const d = new Decorator();
  const selfSeq = [];
  const phSeq = [];
  ed.setDecorations = (type, ranges) => {
    if (type === d.pool.self) selfSeq.push(ranges.length);
    if (type === d.pool.placeholder) phSeq.push(ranges.length);
  };

  d.refresh();                                                     // file opens
  await settle(t);
  d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 }); // user clicks
  await settle(t);
  d.machine.phase = Phase.Survey;                                  // focus times out
  d.onRelaxTick();
  await settle(t);
  d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 }); // clicks again
  await settle(t);

  // Every value ever applied must be the same non-zero count: no 0 in the sequence
  // (that is the blink) and no drift (that is the settle-wrong).
  assert.ok(selfSeq.length > 0, 'self must be painted at least once');
  assert.deepEqual([...new Set(selfSeq)], [selfSeq[0]],
    `self flapped across the lifecycle: ${selfSeq.join(' → ')}`);
  assert.ok(selfSeq[0] > 0, 'self must not settle at zero ranges');

  assert.ok(phSeq.length > 0, 'placeholders must be painted at least once');
  assert.deepEqual([...new Set(phSeq)], [phSeq[0]],
    `placeholders flapped across the lifecycle: ${phSeq.join(' → ')}`);
  assert.ok(phSeq[0] > 0, 'placeholders must not settle at zero ranges');
});

test('a completed classification does not disturb the band-1 marks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  // The specific mechanism behind "blinks then ends up wrong": runClassify resolves
  // asynchronously and repaints. If that repaint took a path that skipped or cleared
  // the band-1 marks, the mark would appear on first render and vanish once the
  // server answered — which looks exactly like a blink that settles wrong.
  serveRustLsp();
  const src = fs.readFileSync(path.join(SAMPLES, 'sample.rs'), 'utf8');
  const doc = new stub.TextDocument(src, 'rust', 'file:///afterclassify.rs');
  const ed = new stub.TextEditor(doc, 82, 12);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];

  const d = new Decorator();
  const live = new Map();
  ed.setDecorations = (type, r) => live.set(type, r);

  d.refresh();
  await settle(t);
  const beforeSelf = (live.get(d.pool.self) ?? []).length;
  const beforePh = (live.get(d.pool.placeholder) ?? []).length;

  // Engage and let the classify complete, which is what repaints band 2.
  d.onSelection({ textEditor: ed, selections: [ed.selection], kind: 1 });
  await settle(t);

  assert.equal((live.get(d.pool.self) ?? []).length, beforeSelf,
    'a completed classification must not change the self marks');
  assert.equal((live.get(d.pool.placeholder) ?? []).length, beforePh,
    'a completed classification must not change the placeholder marks');
  assert.ok(beforeSelf > 0 && beforePh > 0, 'and both must actually be painted');
});

// ── band 1 follows edits, and markdown marks go through the Decorator ───────

const sliceOf = (doc) => (r) => doc.getText().slice(doc.offsetAt(r.start), doc.offsetAt(r.end));

test('band 1 recomputes after an edit: new placeholder holes and self uses paint in every phase', async () => {
  stub.clearLspResponses();
  const rs = await harness('fn f(a: u32, b: u32) {\n    let s = 1;\n}\n', 'rust', 1, 4);
  const at = rs.doc.getText().indexOf('    let');
  rs.decorator.onEdit(rs.doc.applyEdit(at, at, '    println!("{} {}", a, b);\n'));
  for (const phase of PHASES) {
    assert.deepEqual(rs.paint(phase).ranges(rs.decorator.pool.placeholder).map(sliceOf(rs.doc)), ['{}', '{}'], phase);
  }
  rs.decorator.dispose();

  const py = await harness('class A:\n    def f(self):\n        return 1\n', 'python', 2, 8);
  const before = py.paint(Phase.Focus).count(py.decorator.pool.self);
  const ret = py.doc.getText().indexOf('        return');
  py.decorator.onEdit(py.doc.applyEdit(ret, ret, '        self.x = 1\n'));
  for (const phase of PHASES) {
    assert.equal(py.paint(phase).count(py.decorator.pool.self), before + 1, phase);
  }
  py.decorator.dispose();
});

test('markdown marks paint on a .md editor and come off when a .ts editor takes its place', async () => {
  stub.clearLspResponses();
  const { highlightSpans, linkSpans } = require('../out/markdown');
  const md = 'A ==washed== word and a [link](https://example.com).\n';
  const h = await harness(md, 'markdown');
  const snap = h.paint(Phase.Survey);
  const spans = (fn) => fn(md).map((s) => md.slice(s.start, s.end));
  assert.deepEqual(snap.ranges(h.decorator.pool.mdHighlight).map(sliceOf(h.doc)), spans(highlightSpans));
  assert.deepEqual(snap.ranges(h.decorator.pool.mdLinkPlain).map(sliceOf(h.doc)), spans(linkSpans));
  assert.ok(spans(highlightSpans).length > 0 && spans(linkSpans).length > 0, 'positive control');
  h.editor.document = new stub.TextDocument('const x = 1;\n', 'typescript', `file:///render-${docSeq++}.ts`);
  const after = h.paint(Phase.Survey);
  assert.equal(after.count(h.decorator.pool.mdHighlight) + after.count(h.decorator.pool.mdLinkPlain), 0);
  h.decorator.dispose();
});

// Markdown-derived files by the id VS Code gives them (test/fixtures/markdown-languages.json).
// Each fence holds nested braces, `self` or `this` and numbers, which paint in code.
const MARKDOWN_DERIVED = {
  prompt: walkText('walk.prompt.md'),
  instructions: walkText('walk.instructions.md'),
  chatagent: walkText('walk.agent.md'),
  skill: walkText('walk.skill.md'),
  juliamarkdown: walkText('walk.jmd'),
};

/** The most deeply indented line of the first fence, and the first word of the first `==` mark. */
function markdownCarets(text) {
  const lines = text.split('\n');
  const open = lines.findIndex((l) => l.startsWith('```'));
  let fence = null;
  for (let i = open + 1; !lines[i].startsWith('```'); i++) {
    const ind = lines[i].replace(/\t/g, '    ').search(/\S/);
    if (ind > (fence?.ind ?? -1)) fence = { line: i, character: lines[i].search(/\S/), ind };
  }
  const at = text.indexOf('==') + 2;
  const line = text.slice(0, at).split('\n').length - 1;
  return [fence, { line, character: at - text.lastIndexOf('\n', at - 1) - 1 }];
}

test('a markdown-derived file paints at most the markdown marks, in any phase and through typing, and asks no server', async () => {
  const { highlightSpans, linkSpans } = require('../out/markdown');
  const { isMarkdownLanguage } = require('../out/focus');
  const isMark = (d, t) => t === d.pool.mdHighlight || t === d.pool.mdLinkPlain;
  const unmarked = (d) => [...d.pool.all(), d.gutterDecoration].filter((t) => !isMark(d, t));
  const spans = (lang, fn, text) => (isMarkdownLanguage(lang) ? fn(text).map((s) => text.slice(s.start, s.end)) : []);
  for (const [lang, text] of Object.entries(MARKDOWN_DERIVED)) {
    const want = (fn) => spans(lang, fn, text);
    if (lang !== 'juliamarkdown') assert.ok(want(highlightSpans).length > 0 && want(linkSpans).length > 0, `${lang}: positive control`);
    for (const { line, character } of markdownCarets(text)) {
      const where = `${lang} at ${line}:${character}`;
      stub.clearLspResponses();
      const h = await harness(text, lang, line, character);
      for (const phase of PHASES) {
        const snap = h.paint(phase);
        assert.equal(unmarked(h.decorator).reduce((n, t) => n + snap.count(t), 0), 0, `${where} paints nothing but the marks in ${phase}`);
        assert.deepEqual(snap.ranges(h.decorator.pool.mdHighlight).map(sliceOf(h.doc)), want(highlightSpans), `${where}: the wash in ${phase}`);
        assert.deepEqual(snap.ranges(h.decorator.pool.mdLinkPlain).map(sliceOf(h.doc)), want(linkSpans), `${where}: the link cancellation in ${phase}`);
      }
      h.decorator.dispose();
      // Real input: a click there, then typing `self `.
      const doc = new stub.TextDocument(text, lang, `file:///render-${docSeq++}.md`);
      const ed = new stub.TextEditor(doc, line, character);
      const live = new Map();
      ed.setDecorations = (type, ranges) => live.set(type, ranges);
      vs.window.activeTextEditor = ed;
      vs.window.visibleTextEditors = [ed];
      const d = new Decorator();
      d.onSelection({ textEditor: ed, selections: ed.selections, kind: 2 });
      assert.equal(d.machine.current, Phase.Survey, `${where}: a click focuses nothing`);
      const at = doc.offsetAt(ed.selection.active);
      d.onEdit(doc.applyEdit(at, at, 'self '));
      ed.selection = new stub.Selection(line, character + 5, line, character + 5);
      d.onSelection({ textEditor: ed, selections: ed.selections, kind: 1 });
      await d.runClassify(doc);
      d.render();
      assert.equal(d.machine.current, Phase.Survey, `${where}: typing ends in Survey`);
      assert.equal(unmarked(d).reduce((n, t) => n + (live.get(t) ?? []).length, 0), 0, `${where}: nothing but the marks after typing`);
      const shown = (t) => (live.get(t) ?? []).map(sliceOf(doc));
      assert.deepEqual(shown(d.pool.mdHighlight), spans(lang, highlightSpans, doc.getText()), `${where}: the wash after typing`);
      assert.deepEqual(shown(d.pool.mdLinkPlain), spans(lang, linkSpans, doc.getText()), `${where}: the link cancellation after typing`);
      assert.deepEqual(stub.lspCalls.map(([cmd]) => cmd), [], `${where} asks the language server nothing`);
      d.dispose();
    }
  }
  // The same prompt file under an unlisted id: the default lexer, a whole-file scope, every band.
  const text = MARKDOWN_DERIVED.prompt;
  const [fence] = markdownCarets(text);
  const control = await harness(text, 'unlisted', fence.line, fence.character);
  const focus = control.paint(Phase.Focus);
  assert.ok(focus.count(control.decorator.gutterDecoration) > 0, 'control: gutter stripe');
  assert.ok(tints(control, focus) > 0, 'control: identity tints');
  assert.equal(focus.count(control.decorator.pool.mdHighlight), 0, 'control: no wash outside the markdown ids');
});

test('MDX paints the link-underline cancel on its prose links only, no wash, no bands, and asks no server', async () => {
  stub.clearLspResponses();
  const text = `${walkText('walk.mdx')}\n<Chart src="https://in-attr.example/data.json" note={'https://in-expr.example'} />\n`;
  const lines = text.split('\n');
  const line = lines.findIndex((l) => l.includes('const label'));
  const h = await harness(text, 'mdx', line, lines[line].indexOf('label'));
  for (const phase of PHASES) {
    const snap = h.paint(phase);
    const links = snap.ranges(h.decorator.pool.mdLinkPlain).map((r) => lines[r.start.line].slice(r.start.character, r.end.character));
    assert.deepEqual(links, ['https://example.com'], `${phase}: the prose link only`);
    assert.equal(snap.count(h.decorator.pool.mdHighlight), 0, `${phase}: no wash`);
    assert.equal(h.decorator.pool.banded().reduce((n, t) => n + snap.count(t), 0) + snap.count(h.decorator.gutterDecoration), 0, `${phase}: no bands`);
  }
  assert.deepEqual(stub.lspCalls.map(([cmd]) => cmd), [], 'mdx asks the language server nothing');
});
