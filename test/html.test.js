'use strict';
// HTML: the scripts are JavaScript, the markup is static (docs/html.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const stub = require('./vscode-stub');
const vs = stub.install();
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');
const html = require('../out/html');
const focus = require('../out/focus');
const { lexFor } = require('../out/lex');
const { Classifier } = require('../out/classify-lsp');

const FIX = path.join(__dirname, 'fixtures/html');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const scriptTexts = (t) => html.scriptRegions(t).map((r) => t.slice(r.start, r.end));

// Every line of edges.html, types.html and foreign.html, checked against VS Code 1.145.2's text.html.derivative.
test('script regions are the elements the HTML grammar paints as JavaScript', () => {
  assert.deepEqual(scriptTexts(read('edges.html')), [
    'const upper = 1;', 'const spaced = 2;', 'const babel = 4;', 'const inTemplate = 6;', 'const withSrc = 7;',
    'const inTemplateEl = 8;', 'const inTextarea = 9;', 'const inTitle = 10;', 'const inNoscript = 11;', "const s = '",
    '<!-- const legacy = 13; -->', "import { x } from './x.js'; const mod = 14;", 'const lang = 15;', 'const emptyType = 16;',
    '\n  // a comment to ',
  ]);
  const types = scriptTexts(read('types.html')).map((s) => /const (\w+)/.exec(s)?.[1] ?? s);
  assert.deepEqual(types, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a9', 'b1', 'b3', 'b4', 'b5', '', 'b6',
    'c1', 'c2', 'c4', 'c5', 'c9', 'd1', 'd2', 'd4', 'd6']);
  // A `<script>` in `<style>`, `<svg>` or `<math>` is CSS or plain text to the grammar; an unclosed start tag opens nothing.
  const foreign = scriptTexts(read('foreign.html')).map((s) => /const (\w+)/.exec(s)?.[1] ?? s);
  assert.deepEqual(foreign, ['styleX', 'afterSvg', 'mathX', 'last']);
});

test('the script view keeps every offset and line, and blanks the markup', () => {
  for (const f of ['edges.html', 'types.html', 'page.html', 'foreign.html']) {
    const t = read(f);
    const v = html.scriptView(t);
    assert.equal(v.length, t.length, f);
    assert.deepEqual([...v].map((c, i) => (c === '\n') === (t[i] === '\n')).every(Boolean), true, `${f}: line breaks`);
    const regions = html.viewRegions(v);
    assert.deepEqual(regions, html.scriptRegions(t), `${f}: the marks give the regions back`);
    for (let i = 0; i < t.length; i++) {
      if (regions.some((r) => i >= r.start && i < r.end)) assert.equal(v[i], t[i] === '\f' ? ' ' : t[i]);
      else assert.ok(v[i] === ' ' || v[i] === '\n' || v[i] === '\r' || v[i] === '\f', `${f}@${i}`);
    }
  }
});

// The form feed is the view's own mark, so one in a script's text must not end the script.
test('a form feed inside a script is a space in the view, and the script stays one region', () => {
  const t = '<p>a</p>\n<script>const a = 1;\fconst b = { c: a };</script>\n<script>let d = 2;</script>\n';
  const v = html.scriptView(t);
  assert.deepEqual(html.viewRegions(v), html.scriptRegions(t));
  assert.equal(v.slice(html.scriptRegions(t)[0].start, html.scriptRegions(t)[0].end), 'const a = 1; const b = { c: a };');
  assert.deepEqual(focus.scanBlocks(v, 'html').map((b) => v.slice(b.openOffset, b.closeOffset + 1)), ['{ c: a }']);
});

test('no string, comment or brace runs from one script into the next', () => {
  const t = '<script>const a = `open\n</script>\n<p>x</p>\n<script>\nfunction f(b) {\n  return b;\n}\n</script>\n<script>if (x) {</script><script>}</script>\n';
  const v = html.scriptView(t);
  const lx = lexFor(v, 'html');
  assert.ok(lx.idents.some((id) => id.name === 'b'), 'the second script lexes as code');
  const blocks = focus.scanBlocks(v, 'html');
  const lines = blocks.map((b) => [b.openLine, b.closeLine]);
  assert.deepEqual(lines, [[4, 6]], 'f is a block; the third script\'s `{` pairs with nothing');
});

test('.ejs, .jsp, .asp and the other template extensions VS Code opens as html are static', () => {
  for (const f of ['a.ejs', 'a.jsp', 'a.asp', 'a.aspx', 'a.volt', 'a.jshtm', 'a.rhtml', 'a.mdoc']) {
    assert.equal(focus.effectiveLanguageId('html', `/p/${f}`), 'html-template', f);
    assert.equal(focus.isNonFlowLanguage('html-template'), true);
  }
  for (const f of ['a.html', 'a.htm', 'a.xhtml', 'a.xht', 'a.shtml']) assert.equal(focus.effectiveLanguageId('html', `/p/${f}`), 'html', f);
  assert.equal(focus.isNonFlowLanguage('html'), false);
});

let seq = 0;

// The real path: VS Code opens a server template as `html`, and the file name decides.
test('a click and typing in an .ejs page opened as html paint nothing and ask nothing; the same text as .html engages', async () => {
  const t = '<% const self = this; %>\n<script>\n  function tally(items) {\n    let total = 0;\n    for (const n of items) total += n * 42;\n    return total;\n  }\n</script>\n<p><%= self %></p>\n';
  const line = 4;
  const character = t.split('\n')[line].indexOf('total');
  for (const [file, engages] of [['page.ejs', false], ['page.html', true]]) {
    stub.clearLspResponses();
    const doc = new stub.TextDocument(t, 'html', `file:///tpl-${seq++}/${file}`);
    const ed = new stub.TextEditor(doc, line, character);
    const live = new Map();
    ed.setDecorations = (type, ranges) => live.set(type, ranges);
    vs.window.activeTextEditor = ed;
    vs.window.visibleTextEditors = [ed];
    const d = new Decorator();
    d.onSelection({ textEditor: ed, selections: ed.selections, kind: 2 });
    const o = doc.offsetAt(ed.selection.active);
    d.onEdit(doc.applyEdit(o, o, 'x'));
    ed.selection = new stub.Selection(line, character + 1, line, character + 1);
    d.onSelection({ textEditor: ed, selections: ed.selections, kind: 1 });
    await d.runClassify(doc);
    d.render();
    const painted = [...d.pool.all(), d.gutterDecoration].reduce((n, ty) => n + (live.get(ty) ?? []).length, 0);
    assert.equal(d.machine.current, engages ? Phase.Edit : Phase.Survey, file);
    assert.equal(painted > 0, engages, `${file}: ${painted} paints`);
    assert.equal(stub.lspCalls.length > 0, engages, `${file}: ${stub.lspCalls.length} requests`);
    d.dispose();
  }
});

function open(text, line, character, tokens) {
  stub.clearLspResponses();
  if (tokens) stub.setLspResponses(tokens);
  const doc = new stub.TextDocument(text, 'html', `file:///html-${seq++}/page.html`);
  const ed = new stub.TextEditor(doc, line, character);
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const d = new Decorator();
  return { doc, ed, d, live, painted: () => [...d.pool.all()].flatMap((t) => live.get(t) ?? []), gutter: () => live.get(d.gutterDecoration) ?? [] };
}

/** The HTML server's shape: TS's legend, a token on every script name and on event-handler attributes. */
function htmlServerTokens(text) {
  const legend = { tokenTypes: ['class', 'enum', 'interface', 'namespace', 'typeParameter', 'type', 'parameter', 'variable', 'enumMember', 'property', 'function', 'method'], tokenModifiers: ['declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local'] };
  const ids = [...lexFor(html.scriptView(text), 'html').idents];
  for (const m of text.matchAll(/\son\w+="([^"]*)"/g)) {
    const at = m.index + m[0].indexOf('"') + 1;
    for (const w of m[1].matchAll(/[A-Za-z_]\w*/g)) ids.push({ name: w[0], offset: at + w.index, length: w[0].length });
  }
  ids.sort((a, b) => a.offset - b.offset);
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const data = [];
  let pl = 0; let pc = 0; let l = 0;
  for (const id of ids) {
    if (/^(const|let|function|return|if|for|of|import|from|export|await|true|false|this)$/.test(id.name)) continue;
    while (l + 1 < starts.length && starts[l + 1] <= id.offset) l++;
    const c = id.offset - starts[l];
    data.push(l - pl, l === pl ? c - pc : c, id.length, text[id.offset + id.length] === '(' ? 10 : 7, 0);
    pl = l; pc = c;
  }
  return { 'vscode.provideDocumentSemanticTokensLegend': legend, 'vscode.provideDocumentSemanticTokens': { data } };
}

test('nothing paints outside a script, in any phase, with the HTML server and without', async () => {
  let checked = 0;
  for (const f of ['page.html', 'edges.html', 'types.html', 'foreign.html']) {
    const t = read(f);
    const regions = html.scriptRegions(t);
    const inside = (o) => regions.some((r) => o >= r.start && o <= r.end);
    const lines = t.split('\n');
    for (const tokens of [undefined, htmlServerTokens(t)]) {
      for (let line = 0; line < lines.length; line++) {
        const character = Math.max(0, lines[line].search(/\S/));
        const h = open(t, line, character, tokens);
        h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
        await h.d.runClassify(h.doc);
        for (const phase of [Phase.Survey, Phase.Focus, Phase.Edit]) {
          h.d.machine.phase = phase;
          h.d.render();
          for (const r of h.painted()) {
            const s = h.doc.offsetAt(r.start);
            const e = h.doc.offsetAt(r.end);
            assert.ok(inside(s) && inside(e), `${f}:${line + 1} ${phase}: a paint at ${r.start.line + 1}:${r.start.character} "${t.slice(s, e)}" is outside every script`);
            checked++;
          }
          for (const g of h.gutter()) {
            for (let k = g.start.line; k <= g.end.line; k++) {
              const ls = h.doc.offsetAt(new stub.Position(k, 0));
              const le = ls + lines[k].length;
              assert.ok(regions.some((r) => r.start <= le && r.end >= ls), `${f}: the stripe on line ${k + 1} has no script on it`);
            }
          }
        }
        h.d.dispose();
      }
    }
  }
  assert.ok(checked > 500, `${checked} paints checked`);
});

test('a caret in the markup is Survey, one in a script focuses it; typing enters Edit only in a script', async () => {
  const t = read('page.html');
  const lines = t.split('\n');
  const at = (needle, tok) => {
    const o = t.indexOf(needle) + needle.indexOf(tok);
    const line = t.slice(0, o).split('\n').length - 1;
    return [line, o - t.lastIndexOf('\n', o - 1) - 1];
  };
  for (const [needle, tok, want] of [
    ['total += n * k;', 'total', Phase.Focus],
    ['const out = list.map', 'out', Phase.Focus],
    ["'use strict';", 'use', Phase.Focus],
    ['<button type="button" onclick', 'button', Phase.Survey],
    ['onclick="bump(1)', 'bump', Phase.Survey],
    ['--gap: 4px', 'gap', Phase.Survey],
    ['{ "self": "this"', 'self', Phase.Survey],
    ['<li class="row">', 'row', Phase.Survey],
  ]) {
    const [line, character] = at(needle, tok);
    const h = open(t, line, character);
    h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
    assert.equal(h.d.machine.current, want, `click ${tok} in ${needle}`);
    const o = h.doc.offsetAt(h.ed.selection.active);
    h.d.onEdit(h.doc.applyEdit(o, o, 'x'));
    h.ed.selection = new stub.Selection(line, character + 1, line, character + 1);
    h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 1 });
    assert.equal(h.d.machine.current, want === Phase.Focus ? Phase.Edit : Phase.Survey, `type at ${tok} in ${needle}`);
    h.d.dispose();
  }
  assert.ok(lines.length > 40);
});

// A region's end is inside: the caret right before `</script>` is where typing at a script's end happens.
test('a caret at a script\'s last character, right before </script>, focuses it, and typing there enters Edit', () => {
  const t = '<p>x</p>\n<script>let total = 0; total += 1;</script>\n<p>y</p>\n';
  const line = 1;
  const character = t.split('\n')[line].indexOf('</script>');
  const h = open(t, line, character);
  h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
  assert.equal(h.d.machine.current, Phase.Focus);
  const o = h.doc.offsetAt(h.ed.selection.active);
  h.d.onEdit(h.doc.applyEdit(o, o, ' '));
  assert.equal(h.d.machine.current, Phase.Edit);
  h.d.dispose();
  const after = open(t, line, character + '</script>'.length);
  after.d.onSelection({ textEditor: after.ed, selections: after.ed.selections, kind: 2 });
  assert.equal(after.d.machine.current, Phase.Survey, 'after </script> is markup');
  after.d.dispose();
});

// An undo that restores the caret reports no selection change, so the edit alone decides the phase.
test('an edit in the markup with no caret event after it leaves the phase in Survey', () => {
  const t = read('page.html');
  const line = t.split('\n').findIndex((l) => l.includes('<title>'));
  const h = open(t, line, 10);
  const o = h.doc.offsetAt(h.ed.selection.active);
  h.d.onEdit(h.doc.applyEdit(o, o, 'x'));
  assert.equal(h.d.machine.current, Phase.Survey);
  h.d.dispose();
});

test('a function in a script tints its data names; the top level stripes the scripts only', async () => {
  const t = read('page.html');
  const tokens = htmlServerTokens(t);
  const line = t.split('\n').findIndex((l) => l.includes('total += n * k;'));
  const h = open(t, line, t.split('\n')[line].indexOf('total'), tokens);
  h.d.onSelection({ textEditor: h.ed, selections: h.ed.selections, kind: 2 });
  await h.d.runClassify(h.doc);
  h.d.render();
  const tinted = new Set([...h.d.pool.id, ...h.d.pool.idg].flatMap((ty) => (h.live.get(ty) ?? []).map((r) => t.slice(h.doc.offsetAt(r.start), h.doc.offsetAt(r.end)))));
  assert.deepEqual([...tinted].sort(), ['k', 'n', 'total']);
  h.d.machine.phase = Phase.Edit;
  h.d.render();
  assert.deepEqual((h.live.get(h.d.pool.riskEscape) ?? []).map((r) => r.start.line), [line], '`total +=` writes a script-level let');
  h.d.dispose();
});

test('band 1 in a script: this and the import * as restore; template holes and JSDoc brackets are the theme\'s', async () => {
  const t = read('page.html');
  const h = open(t, 0, 0);
  h.d.render();
  const text = (ty) => (h.live.get(ty) ?? []).map((r) => t.slice(h.doc.offsetAt(r.start), h.doc.offsetAt(r.end)));
  assert.deepEqual(text(h.d.pool.self), ['this']);
  assert.deepEqual(text(h.d.pool.importRestore), ['util']);
  assert.deepEqual(text(h.d.pool.placeholder), [], 'the HTML root gives a template hole token type String, so bracket-pair colorization leaves it alone');
  assert.deepEqual(text(h.d.pool.commentRestore), [], 'a JSDoc block in a script is one comment token');
  h.d.dispose();
});

// The decorator hands the classifier its cached script view; called without it, the classifier builds the same view.
test('the classifier reads an HTML document through its script view when no text is handed to it', async () => {
  const t = read('page.html');
  const view = html.scriptView(t);
  const doc = new stub.TextDocument(t, 'html', `file:///cls-${seq++}/page.html`);
  const blocks = focus.scanBlocks(view, 'html');
  const block = blocks.find((b) => view.slice(b.openOffset, b.closeOffset).includes('total += n * k;') && !view.slice(b.openOffset, b.closeOffset).includes('LIMIT'));
  const names = (r) => [...r.focused.byName.entries()].map(([n, i]) => `${n}:${i.cls}`).sort();
  stub.clearLspResponses();
  stub.setLspResponses(htmlServerTokens(t));
  const own = await new Classifier().classifyScope(doc, block, 5, { isCancellationRequested: false });
  const handed = await new Classifier().classifyScope(doc, block, 5, { isCancellationRequested: false }, { text: view, blocks });
  assert.deepEqual(names(own), names(handed));
  assert.ok(names(own).some((n) => n.startsWith('total:')), names(own).join(' '));
});

/** Bands 2-3 and the stripe with the caret at `off`, in Edit; band 1 is the theme's or its own test's. */
async function paintAt(text, lang, off, served) {
  stub.clearLspResponses();
  if (served) stub.setLspResponses(served);
  const doc = new stub.TextDocument(text, lang, `file:///parity-${seq++}/x.${lang === 'html' ? 'html' : 'js'}`);
  const p = doc.positionAt(off);
  const ed = new stub.TextEditor(doc, p.line, p.character);
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const d = new Decorator();
  d.onSelection({ textEditor: ed, selections: ed.selections, kind: 2 });
  await d.runClassify(doc);
  d.machine.phase = Phase.Edit;
  d.render();
  const out = {};
  for (const [k, v] of Object.entries(d.pool)) {
    const types = Array.isArray(v) ? v.map((x, i) => [`${k}${i}`, x]) : [[k, v]];
    for (const [name, ty] of types) {
      if (!['self', 'importRestore', 'placeholder', 'commentRestore'].includes(k)) out[name] = (live.get(ty) ?? []).map((r) => `${doc.offsetAt(r.start)}-${doc.offsetAt(r.end)}`).join(',');
    }
  }
  out.gutter = (live.get(d.gutterDecoration) ?? []).map((r) => r.start.line).join(',');
  d.dispose();
  return out;
}

/** A caret on the first name of every block of a page's scripts, and of every script's top level. */
function parityCarets(t) {
  const view = html.scriptView(t);
  const regions = html.scriptRegions(t);
  const firstName = (o) => o + /[A-Za-z_$]|$/.exec(view.slice(o)).index;
  const blockCarets = focus.scanBlocks(view, 'html').map((b) => firstName(b.openOffset + 1));
  const topCarets = new Set(regions.map((r) => firstName(r.start)).filter((o) => html.regionAt(regions, o) && !blockCarets.includes(o)));
  return { view, carets: [...blockCarets, ...topCarets], topCarets };
}

/** Every caret of `parityCarets` paints the same in the page and in its script view opened as a .js file. */
async function assertParity(t, served, what) {
  const { view, carets, topCarets } = parityCarets(t);
  for (const off of carets) {
    const page = await paintAt(t, 'html', off, served);
    const js = await paintAt(view, 'javascript', off, served);
    // At the top level only the stripe differs: a .js file's top level owns its blank lines, the page's markup is outside it.
    if (topCarets.has(off)) delete page.gutter, delete js.gutter;
    assert.deepEqual(page, js, `${what}@${off}`);
  }
  return carets.length;
}

// The same code paints the same: every block of the fixtures, focused in the page and in
// the script view opened as a .js file, with the HTML server's tokens and without.
test('a script paints as the same code in a .js file', async () => {
  let compared = 0;
  for (const f of ['page.html', 'edges.html', '../transitions/walk.html']) {
    const t = read(f);
    for (const tokens of [undefined, htmlServerTokens(t)]) compared += await assertParity(t, tokens, `${f} ${tokens ? 'server' : 'none'}`);
  }
  assert.ok(compared > 20, `${compared} carets compared`);
});

// samples/sample.js inside a page, with tsserver's own tokens for it (test/fixtures/sample.js.tokens.json) moved to the page.
test('samples/sample.js in a script paints as samples/sample.js, with its real tokens and without', async () => {
  const js = fs.readFileSync(path.join(__dirname, '../samples/sample.js'), 'utf8');
  const head = '<!DOCTYPE html>\n<html>\n<head>\n  <title>sample &amp; page</title>\n  <style>.a { --gap: 4px; }</style>\n<script>\n';
  const t = `${head}${js}</script>\n</head>\n<body><p onclick="run(1)">self, this and 42</p>\n<script>const extra = 1;</script>\n</body>\n</html>\n`;
  const shifted = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/sample.js.tokens.json'), 'utf8'))
    .map((k) => ({ ...k, offset: k.offset + head.length }));
  const enc = stub.encodeTokens(t, shifted);
  const served = { 'vscode.provideDocumentSemanticTokensLegend': enc.legend, 'vscode.provideDocumentSemanticTokens': { data: enc.data } };
  let compared = 0;
  for (const tokens of [undefined, served]) compared += await assertParity(t, tokens, `sample.js ${tokens ? 'tsserver' : 'none'}`);
  assert.ok(compared > 40, `${compared} carets compared`);
});
