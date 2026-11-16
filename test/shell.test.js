'use strict';
// Shell (bash, zsh) and fish: the lexers against shfmt 3.14.1 and fish-lsp 1.1.5, the
// keyword block scans, the bindings by each shell's scoping rule, both classifiers,
// the danger marks, band 1 left to the theme, and notebooks' cell answers.
// Rules and measurements: docs/tooling.md.

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
const { Decorator } = require('../out/decorator');
const { Phase } = require('../out/phases');
const { shellTables, shellFacts } = require('../out/shell');
const { growth } = require('./cpu-time');

const DIR = path.join(__dirname, 'fixtures/shell');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const walk = (f) => fs.readFileSync(path.join(__dirname, 'fixtures/transitions', f), 'utf8');
const WALK_SH = walk('walk.sh');
const WALK_ZSH = walk('walk.zsh');
const WALK_FISH = walk('walk.fish');
const CONSTRUCTS = read('constructs.sh');
const FISH_LSP = JSON.parse(read('walk.fish.lsp.json'));

const lineNo = (text, offset) => text.slice(0, offset).split('\n').length;
const regions = (text, lang = 'shellscript') => lexFor(text, lang).spans.map((s) => `${s.region}:${text.slice(s.start, s.end)}`);
const vars = (text, lang = 'shellscript') => shellTables(lexFor(text, lang)).vars.map((v) => v.name);
const numbers = (text, lang = 'shellscript') => lexFor(text, lang).numbers.map((r) => text.slice(r.start, r.end));

// ── shell lexer ──────────────────────────────────────────────────────────────

test('shell lexer: quotes, holes, comments at a word start, heredocs by their delimiter', () => {
  const t = [
    "a='$b # c' $'d\\'$e' \"f $g ${h:-'i'} $(j \"$k\") `l $m`\" n#o # p $q",
    'cat <<EOF <<-\'RAW\' | tr a-z A-Z',
    'body $r \\$s',
    'EOF',
    '\t$t `u`',
    '\tRAW',
    'v=1',
  ].join('\n');
  assert.deepEqual(regions(t), [
    "string:'$b # c'", "string:$'d\\'$e'", 'string:"f ', 'string: ', 'string: ', 'string:"', 'string:"', 'string: ', 'string:"',
    'comment:# p $q', 'string:\'RAW\'', 'string:body ', 'string: \\$s\nEOF', 'string:\t$t `u`\n\tRAW',
  ]);
  assert.deepEqual(vars(t), ['a', 'g', 'h', 'k', 'm', 'r', 'v'], 'a quoted delimiter keeps its body literal; `n#o` is a word; `\'i\'` in a quoted `${…}` is text');
  assert.equal(lexFor(t, 'shellscript').isCode(t.indexOf('v=1')), true, 'the code after the last terminator line is code');
});

test('shell lexer: the variables shfmt sees, at its offsets, on the fixtures', () => {
  for (const f of ['walk.sh', 'constructs.sh']) {
    const text = f === 'walk.sh' ? WALK_SH : read(f);
    const ref = JSON.parse(read(`${f}.ref.json`));
    const mine = shellTables(lexFor(text, 'shellscript')).vars.map((v) => [v.offset, v.length, v.name]);
    assert.deepEqual(mine, ref.vars, f);
  }
});

test('shell lexer: writes, the command they belong to and their scope option', () => {
  const t = 'f() {\n  local a=1 b; declare -g c=2; typeset -A m; declare -A q=([x]=1); echo ${q[key]} ${m[k2]}\n  d=3 e=4 cmd\n  read -r -p "x" g h; for i j in 1; do :; done\n  getopts "ab" k; getopts ab: k; printf -v l %s 1; mapfile -t n; unset o\n}\n';
  const got = shellTables(lexFor(t, 'shellscript')).vars.map((v) => `${v.name}${v.write ? '=' : ''}${v.via ? `:${v.via}` : ''}${v.scope}${v.env ? '!' : ''}`);
  assert.deepEqual(got, ['a=:local', 'b=:local', 'c=:declareg', 'm=:typeset', 'q=:declare', 'q', 'm', 'd=!', 'e=!', 'g=:read', 'h=:read', 'i=:for', 'j=:for', 'k=:getopts', 'k=:getopts', 'l=:printf',
    'n=:mapfile', 'o:unset']);
});

test('shell lexer: numbers where the grammar paints a numeral, and nowhere else', () => {
  const t = [
    'x=1; local n=2; arr=(3 four); echo ${a[4]} ${s:5:6} "$((7 + y))" 8 -9 +10 0x1f 1.5 2#101',
    '(( i < 11 )); let j=12; [[ $a -lt 13 ]]; for ((k=14; k<15; k++)); do :; done',
    'case $v in 16) sleep 17 ;; esac; cmd 2>/dev/null 3>&1; echo "18" a19',
  ].join('\n');
  assert.deepEqual(numbers(t), ['2', '3', '7', '8', '0x1f', '1.5', '2#101', '11', '12', '13', '14', '15', '17']);
});

test('shell lexer: zsh flags, modifiers and subscript flags are zsh\'s once the text is zsh', () => {
  assert.deepEqual(vars(WALK_ZSH), ['aliases_map', 'aliases_map', 'branch', 'branch', 'branch', 'self', 'k', 'v', 'aliases_map', 'k', 'v', 'aliases_map', 'self', 'PROMPT']);
  const z = 'setopt extended_glob\nprint ${f:h:t} ${(j:,:)list} $#arr $+commands[git] ${tools[(Ie)$want]} ${p:#$skip}\n';
  assert.deepEqual(vars(z), ['f', 'list', 'arr', 'commands', 'tools', 'want', 'p', 'skip']);
  assert.deepEqual(vars('if (( ${+commands[fd]} )); then :; fi\n'), ['commands'], '`${+name}` alone makes the text zsh');
  const bash = 'echo ${s:i:1} ${s:n}\n';
  assert.deepEqual(vars(bash), ['s', 'i', 's', 'n'], 'in bash an offset is arithmetic');
  const brace = 'setopt x\nf() { { echo a } always { echo b } }\n';
  assert.deepEqual(focus.scanBlocks(brace, 'shellscript').map((b) => `${b.depth}:${brace.slice(b.openOffset, b.closeOffset + 1)}`),
    ['0:{ { echo a } always { echo b } }', '1:{ echo a }', '1:{ echo b }'], 'zsh closes a group with `}` anywhere a word stands');
});

// ── shell blocks ─────────────────────────────────────────────────────────────

const blockList = (text, lang = 'shellscript') => focus.scanBlocks(text, lang).map((b) => {
  const head = text.slice(b.headerStart, b.openOffset).trim().split(/\s/)[0] || text[b.openOffset];
  return `${b.openLine + 1}-${b.closeLine + 1}/${b.depth} ${head}${focus.functionScopeOf(text, b, lang) ? ' fn' : ''}`;
});

test('shell blocks: functions, branches as siblings, loops, a case and each arm, groups and subshells', () => {
  assert.deepEqual(blockList(WALK_SH), [
    '9-12/0 log() fn', '14-33/0 deploy_host() fn', '17-31/1 while', '19-29/2 if', '20-25/3 for', '21-24/4 case', '22-22/5 *self*)', '23-23/5 *)',
    '35-40/0 cleanup() fn', '47-49/0 for',
  ]);
  assert.deepEqual(blockList(CONSTRUCTS), [
    '12-21/0 greet() fn', '16-18/1 for', '23-32/0 function fn', '24-30/1 while', '25-29/2 case', '26-26/3 h)', '27-27/3 v)', '28-28/3 (*)',
    '34-45/0 until', '38-39/1 if', '40-41/1 elif', '42-44/1 else', '47-50/0 select', '52-54/0 for', '62-62/0 {', '63-63/0 (',
  ]);
  assert.deepEqual(blockList(WALK_ZSH), ['5-9/0 function fn', '11-17/0 () fn', '13-15/1 for']);
});

test('shell blocks: reserved words only at command position; never in a string, a comment, a heredoc or as an argument', () => {
  const t = 'echo if then fi done esac { }\n# if x; then\ncat <<E\nwhile x; do\nE\nx="for y in z; do"\nlock() {\n  echo done\n}\nswitch-to-dir () { :; }\n';
  assert.deepEqual(blockList(t), ['7-9/0 lock() fn', '10-10/0 switch-to-dir fn'], 'a function named like a keyword is still a function');
  const open = 'if a; then\n  b\n';
  assert.deepEqual(blockList(open), [], 'a branch with no `fi` closes nothing');
  assert.deepEqual(blockList('case $x in\n  a) b\nesac\n'), ['1-3/0 case', '2-2/1 a)'], 'the last arm needs no `;;`');
  assert.deepEqual(blockList('for a do\n  b\ndone\n'), ['1-3/0 for'], '`for name do` loops over the arguments');
});

// ── bindings and classification ─────────────────────────────────────────────

async function classify(text, lang, needle, tok, served) {
  stub.clearLspResponses();
  if (served) {
    stub.setLspResponses({
      'vscode.provideDocumentSemanticTokensLegend': served.legend,
      'vscode.provideDocumentSemanticTokens': { data: served.data },
      'vscode.executeDocumentSymbolProvider': [],
    });
  }
  const doc = new stub.TextDocument(text, lang, `file:///shell-${Math.random()}`);
  const blocks = focus.scanBlocks(text, lang);
  const at = text.indexOf(needle) + needle.indexOf(tok);
  assert.ok(text.indexOf(needle) >= 0, needle);
  const block = focus.innermostBlock(blocks, lineNo(text, at) - 1, at, text);
  const r = await new Classifier().classifyScope(doc, block, 5, { isCancellationRequested: false }, { text, blocks });
  const out = {};
  for (const [n, i] of r.focused.byName) out[n] = i.cls === 'out' && !i.isCapture ? 'global' : i.cls;
  return { names: out, source: r.focused.source };
}

test('shell bindings: a function\'s `local`, `declare` and `typeset` are its own; every other write in it is a global', () => {
  const lx = lexFor(WALK_SH, 'shellscript');
  const f = shellFacts(lx);
  const decl = shellTables(lx).vars.filter((v) => f.declSites.has(v.offset)).map((v) => `${v.name}@${lineNo(WALK_SH, v.offset)}`);
  assert.deepEqual(decl, ['ROOT@5', 'retries@6', 'hosts@7', 'level@10', 'host@15', 'attempt@15', 'timeout@16', 'host@47']);
  assert.deepEqual([...f.globalWrites].sort(), ['attempt', 'count', 'f']);
  const data = shellTables(lx).vars.filter((v) => f.data.has(v.offset)).map((v) => v.name);
  for (const n of ['HOME', 'TIMEOUT']) assert.ok(!data.includes(n), `${n}: the file never writes it`);
});

test('shell classification: locals at normal weight, globals bold, names the file never writes neutral', async () => {
  const m = await classify(WALK_SH, 'shellscript', 'attempt=$((attempt + 1))', 'attempt');
  assert.equal(m.source, 'heuristic');
  assert.deepEqual(m.names, { attempt: 'fn', retries: 'global', host: 'fn', ROOT: 'global', f: 'global', count: 'global', timeout: 'fn' });
  const top = await classify(WALK_SH, 'shellscript', 'retries=3', 'retries');
  assert.deepEqual(Object.keys(top.names).sort(), ['ROOT', 'host', 'hosts', 'retries'], 'the heredoc\'s text and the comment hold none');
  const z = await classify(WALK_ZSH, 'shellscript', 'alias $k=$v', 'k');
  assert.deepEqual(z.names, { k: 'global', v: 'global', aliases_map: 'global' }, 'zsh\'s `for k v` without `local` writes globals');
  const anon = await classify(WALK_ZSH, 'shellscript', 'local self=this', 'self');
  assert.equal(anon.names.self, 'block', 'a variable named `self` is data');
  const group = 'x=0\nf() {\n  { local x=1; }\n  if true; then echo "$x $x"; fi\n}\n';
  assert.equal((await classify(group, 'shellscript', 'echo "$x', 'echo')).names.x, 'fn', 'a brace group scopes nothing: the function\'s `local` hides the global');
});

// ── fish ─────────────────────────────────────────────────────────────────────

const decode = (text, served) => {
  const ls = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') ls.push(i + 1);
  const out = [];
  let l = 0;
  let c = 0;
  for (let i = 0; i < served.data.length; i += 5) {
    l += served.data[i];
    c = served.data[i] ? served.data[i + 1] : c + served.data[i + 1];
    out.push({ offset: ls[l] + c, length: served.data[i + 2], type: served.legend.tokenTypes[served.data[i + 3]] });
  }
  return out;
};

test('fish lexer: `#` at a word start, `\\\'` in single quotes, `$var[…]` and `$(…)` holes, `(…)` as code, numerals as words', () => {
  const t = "set -l x 'it\\'s $y' \"$z[1] $(w $q)\" (v $u) a#b # $t\nfor i in 1 2.5 3x; echo $i $argv[2..-1]; end";
  assert.deepEqual(regions(t, 'fish'), ["string:'it\\'s $y'", 'string:"', 'string: ', 'string:"', 'comment:# $t']);
  assert.deepEqual(vars(t, 'fish'), ['x', 'z', 'q', 'u', 'i', 'i', 'argv']);
  assert.deepEqual(numbers(t, 'fish'), ['1', '1', '2.5', '2', '1'], 'an index\'s digits, in a string too, and numeric words; `3x` is a word');
  assert.deepEqual(numbers('printf %s $x >&2\nseq 1 3 >out.txt 2>&1\ncat <&0 2>> log 3', 'fish'), ['1', '3', '3'], 'a redirection\'s file descriptor is no numeral: the grammar paints it with the redirection');
});

test('fish lexer: the variables fish-lsp types, but those it reads inside single quotes', () => {
  const lsp = new Set(decode(WALK_FISH, FISH_LSP).filter((t) => t.type === 'variable').map((t) => t.offset));
  const mine = new Set(shellTables(lexFor(WALK_FISH, 'fish')).vars.map((v) => v.offset));
  assert.deepEqual([...mine].filter((o) => !lsp.has(o)), []);
  assert.deepEqual([...lsp].filter((o) => !mine.has(o)), []);
});

test('fish blocks: function, if, else if and else as siblings, for, while, switch with its cases, begin, braces', () => {
  assert.deepEqual(blockList(WALK_FISH, 'fish'), [
    '6-9/0 function fn', '11-33/0 function fn', '14-31/1 while', '16-29/2 if', '17-25/3 for', '18-24/4 switch', '19-21/5 case', '22-23/5 case',
    '35-40/0 function fn', '42-46/0 begin', '43-45/1 for',
  ]);
  const t = 'if a\n  b\nelse if c\n  d\nelse\n  e\nend\nf || { set ok false; break }\necho end; echo "if"\n';
  assert.deepEqual(blockList(t, 'fish'), ['1-2/0 if', '3-4/0 else', '5-7/0 else', '8-8/0 {']);
});

test('fish bindings: `set -l`, `for`, `--argument-names` and a first plain `set` are the function\'s; `set -g` and the top level are global', async () => {
  const t = 'set -g level 1\nfunction f --argument-names who\n  set -l a 1\n  set b 2\n  set b 3\n  set level 4\n  set -g c 5\n  for i in $a $b; echo $who $i $c $level; end\nend\n';
  const lx = lexFor(t, 'fish');
  const f = shellFacts(lx);
  assert.deepEqual(shellTables(lx).vars.filter((v) => f.declSites.has(v.offset)).map((v) => `${v.name}@${lineNo(t, v.offset)}`),
    ['level@1', 'who@2', 'a@3', 'b@4', 'i@8']);
  for (const served of [null, FISH_LSP]) {
    const m = await classify(WALK_FISH, 'fish', 'set attempt (math', 'attempt', served);
    assert.equal(m.source, served ? 'lsp' : 'heuristic');
    assert.deepEqual(m.names, { attempt: 'fn', retries: 'global', host: 'fn', f: 'block', count: 'block' }, served ? 'fish-lsp' : 'no server');
  }
});

// ── marks ────────────────────────────────────────────────────────────────────

test('danger: eval, a shell running its script from a pipe, a process substitution or a fetch, through a wrapper, and source of a process substitution; not rm -rf, sudo or eval as a word', () => {
  const marks = (text, lang) => risk.lexicalRisk(text, { start: 0, end: text.length }, lang).danger.map((r) => `${lineNo(text, r.start)}:${text.slice(r.start, r.end)}`);
  assert.deepEqual(marks(CONSTRUCTS, 'shellscript'), ['64:eval', '65:bash', '66:source']);
  const not = 'echo eval; x=eval; curl u | sh script.sh; curl u | bash -c "x"; rm -rf /; sudo x; cat "$(eval)"\n';
  assert.deepEqual(marks(not, 'shellscript'), ['1:eval'], 'only the eval run as a command');
  assert.deepEqual(marks(WALK_FISH, 'fish'), ['38:eval', '39:sh']);
  assert.deepEqual(marks('curl u | source\nsource conf.fish\n', 'fish'), ['1:source']);
  const wrapped = [
    'curl -fsSL https://get.docker.com | sudo sh', 'curl u | sudo -E bash -', 'curl u | sudo -u root -- bash', 'curl u | env -i FOO=1 bash',
    'curl u | /usr/bin/env bash', 'curl u | bash -o pipefail', 'bash <(curl -sSL u)', 'nohup bash -x <(curl u)', 'sh -c "$(curl -fsSL u)"',
    'sudo bash -c "$(wget -qO- u)"', 'exec sh -c "$(curl u)"',
  ];
  assert.deepEqual(marks(wrapped.join('\n'), 'shellscript'), ['1:sh', '2:bash', '3:bash', '4:bash', '5:bash', '6:bash', '7:bash', '8:bash', '9:sh', '10:bash', '11:sh'],
    'a shell behind sudo, env or nohup, a process substitution as its script, a fetched -c string');
  const plain = 'command -v sh; sudo rm -rf /tmp/x; sudo -s; env bash script.sh; bash script.sh <(curl u); diff <(curl a) <(curl b); sh -c "$(cat x)"; sh -c "echo $(curl u)"\n';
  assert.deepEqual(marks(plain, 'shellscript'), [], 'a wrapper alone, a script file, a substitution that is an argument, a -c string that fetches nothing first');
  const fishWrapped = 'curl -sL u | sudo sh\ncurl -sL u | env bash\nbash (curl -sL u | psub)\nsh -c (curl -fsSL u)\nsh -c "$(curl -fsSL u)"\nbash (cat x)\nsudo sh script.sh\n';
  assert.deepEqual(marks(fishWrapped, 'fish'), ['1:sh', '2:bash', '3:bash', '4:sh', '5:sh'], 'fish: the same forms, psub as its process substitution');
  for (const [text, lang] of [[WALK_SH, 'shellscript'], [WALK_FISH, 'fish']]) {
    assert.deepEqual(risk.lexicalRisk(`async=1; await=2; echo $async\n${text}`, { start: 0, end: text.length }, lang).async, [], `${lang}: no async marks`);
  }
});

// ── the real Decorator ───────────────────────────────────────────────────────

let seq = 0;
async function editor(text, lang, needle, served) {
  stub.clearLspResponses();
  if (served) {
    stub.setLspResponses({
      'vscode.provideDocumentSemanticTokensLegend': served.legend,
      'vscode.provideDocumentSemanticTokens': { data: served.data },
      'vscode.executeDocumentSymbolProvider': [],
    });
  }
  const doc = new stub.TextDocument(text, lang, `file:///shell-editor-${seq++}`);
  const at = text.indexOf(needle);
  const ed = new stub.TextEditor(doc, lineNo(text, at) - 1, at - text.lastIndexOf('\n', at - 1) - 1);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const live = new Map();
  ed.setDecorations = (type, ranges) => live.set(type, ranges);
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  d.engaged.add(doc.uri.toString());
  d.render();
  await d.runClassify(doc);
  const shown = (type) => (live.get(type) ?? []).map((r) => doc.lineAt(r.start.line).text.slice(r.start.character, r.end.character));
  const paint = (phase) => {
    d.machine.phase = phase;
    d.render();
    return {
      tints: [...d.pool.id, ...d.pool.idg].flatMap(shown).sort(),
      bold: d.pool.idg.flatMap(shown).sort(),
      clay: shown(d.pool.numberEngaged),
      danger: shown(d.pool.riskDanger),
      escape: shown(d.pool.riskEscape),
      self: shown(d.pool.self),
      placeholder: shown(d.pool.placeholder),
    };
  };
  return { d, doc, paint };
}

test('shell in the editor: band 1 in every phase, tints on names only, clay where the grammar paints numerals, danger in Edit', async () => {
  const h = await editor(WALK_SH, 'shellscript', 'eval "$(ssh-agent');
  const survey = h.paint(Phase.Survey);
  assert.deepEqual(survey.tints, []);
  assert.deepEqual(survey.self, [], 'no receiver keyword in shell');
  assert.deepEqual(survey.placeholder, [], 'an unquoted hole\'s brackets keep the bracket-pair grey the theme registers');
  const edit = h.paint(Phase.Edit);
  assert.deepEqual(edit.placeholder, []);
  assert.deepEqual(edit.escape, [], 'no escape marks without an answer');
  assert.deepEqual(edit.danger, ['eval', 'sh']);
  assert.deepEqual(edit.tints, Array(6).fill('ROOT'), 'a global traces file-wide');
  assert.deepEqual(edit.bold, edit.tints, 'in bold');
  h.d.dispose();
  // Any answer at all puts the classification on the semantic path, where other languages' writes mark.
  const served = { legend: FISH_LSP.legend, data: [0, 0, 1, 1, 0] };
  const s = await editor(WALK_SH, 'shellscript', 'count=$(ls', served);
  assert.deepEqual(s.paint(Phase.Edit).escape, [], 'no oracle yet for a shell write that escapes its function');
  s.d.dispose();
  const w = await editor(WALK_SH, 'shellscript', 'attempt=$((attempt');
  const focusPaint = w.paint(Phase.Focus);
  assert.ok(focusPaint.tints.includes('attempt') && !focusPaint.tints.some((x) => x.startsWith('$')), 'a tint covers the name, never its `$`');
  assert.deepEqual(focusPaint.clay, ['1', '1'], 'the `1`s of `$((attempt + 1))` and `return 1`; neither `3` of `retries=3` nor `30` of `${TIMEOUT:-30}`');
  w.d.dispose();
});

test('fish in the editor: the same tints with fish-lsp\'s tokens and without, no self, the index brackets restored', async () => {
  const paints = [];
  for (const served of [null, FISH_LSP]) {
    const h = await editor(WALK_FISH, 'fish', 'set attempt (math', served);
    const p = h.paint(Phase.Edit);
    assert.deepEqual(p.self, []);
    assert.deepEqual(p.placeholder, []);
    assert.deepEqual(p.escape, [], 'no escape marks with fish-lsp\'s answer or without');
    paints.push(p.tints);
    h.d.dispose();
  }
  assert.deepEqual(paints[0], paints[1]);
  assert.ok(paints[0].includes('attempt') && paints[0].includes('retries'));
});

// ── notebooks ────────────────────────────────────────────────────────────────

test('notebooks: a cell added, removed or moved, or another cell\'s text, drops the other cells\' answers; outputs do not', async () => {
  const cellText = ['import pandas as pd\ndf = pd.DataFrame()\n', 'for row in df:\n    total = row + 1\n    print(total)\n'];
  const cells = cellText.map((t, i) => ({ index: i, kind: 2, document: new stub.TextDocument(t, 'python', `vscode-notebook-cell:/nb.ipynb#W${i}`) }));
  const notebook = { uri: { scheme: 'file', toString: () => 'file:///nb.ipynb' }, getCells: () => cells, cellCount: cells.length };
  vs.workspace.notebookDocuments = [notebook];
  stub.clearLspResponses();
  const doc = cells[1].document;
  const ed = new stub.TextEditor(doc, 1, 6);
  vs.window.activeTextEditor = ed;
  vs.window.visibleTextEditors = [ed];
  const d = new Decorator();
  d.classifier.retrySchedule = [];
  d.engaged.add(doc.uri.toString());
  await d.runClassify(doc);
  const asks = () => stub.lspCalls.filter(([c, uri]) => c === 'vscode.provideDocumentSemanticTokens' && uri === doc.uri).length;
  const before = asks();
  await d.runClassify(doc);
  assert.equal(asks(), before, 'the answer for this version is cached');
  const fire = async (change) => {
    stub.events.notebook.fire({ notebook, metadata: undefined, contentChanges: [], cellChanges: [], ...change });
    await d.runClassify(doc);
  };
  await fire({ cellChanges: [{ cell: cells[1], outputs: [], executionSummary: { success: true }, document: undefined, metadata: undefined }] });
  assert.equal(asks(), before, 'an output or an execution summary changes no answer');
  await fire({ cellChanges: [{ cell: cells[0], document: cells[0].document, outputs: undefined, executionSummary: undefined, metadata: undefined }] });
  assert.equal(asks(), before + 1, 'another cell\'s text: asked again');
  await fire({ contentChanges: [{ range: { start: 0, end: 0 }, addedCells: [], removedCells: [cells[0]] }] });
  assert.equal(asks(), before + 2, 'a cell removed: asked again');
  d.dispose();
  vs.workspace.notebookDocuments = [];
});

// ── cost ─────────────────────────────────────────────────────────────────────

test('shell and fish lex and block scans grow linearly', () => {
  const sh = (n) => Array.from({ length: n }, (_, i) => `f${i}() {\n  local a=$((i + 1)) b="x $a \${c:-d}"\n  case $a in ${i}) echo "$b" ;; esac\n}\n`).join('');
  const fish = (n) => Array.from({ length: n }, (_, i) => `function f${i} -a x\n  set -l y (math $x + ${i})\n  if test $y -gt 1; echo "$y[1]"; end\nend\n`).join('');
  for (const [lang, gen] of [['shellscript', sh], ['fish', fish]]) {
    const ratio = growth((n) => gen(n), (text) => {
      focus.scanBlocks(text, lang);
      shellFacts(lexFor(text, lang));
    }, 300);
    assert.ok(ratio < 24, `${lang}: 8x the lines cost ${ratio.toFixed(1)}x`);
  }
});
