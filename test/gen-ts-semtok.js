// Dump REAL TypeScript semantic tokens (the same engine VS Code's TS provider
// uses) as JSON DecodedToken[]. Ground-truth fixtures for classification tests.
//   node test/gen-ts-semtok.js <file.js|ts> > test/fixtures/<file>.tokens.json
const ts = require('typescript');
const fs = require('fs');
const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const svc = ts.createLanguageService({
  getScriptFileNames: () => [file],
  getScriptVersion: () => '1',
  getScriptSnapshot: (f) => ts.ScriptSnapshot.fromString(f === file ? text : (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')),
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => ({ allowJs: true, target: ts.ScriptTarget.Latest }),
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
});
const cls = svc.getEncodedSemanticClassifications(file, { start: 0, length: text.length }, ts.SemanticClassificationFormat.TwentyTwenty);
const TT = ['class', 'enum', 'interface', 'namespace', 'typeParameter', 'type', 'parameter', 'variable', 'enumMember', 'property', 'function', 'member'];
const TM = ['declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local'];
const out = [];
for (let i = 0; i < cls.spans.length; i += 3) {
  const offset = cls.spans[i], length = cls.spans[i + 1], enc = cls.spans[i + 2];
  const type = TT[(enc >> 8) - 1] ?? '';
  const modifiers = [];
  const mbits = enc & 0xff;
  for (let b = 0; b < TM.length; b++) if (mbits & (1 << b)) modifiers.push(TM[b]);
  out.push({ name: text.slice(offset, offset + length), offset, length, type, modifiers });
}
console.log(JSON.stringify(out, null, 0));
