// Dump REAL TypeScript semantic tokens (the same engine VS Code's TS provider
// uses) as JSON DecodedToken[]. Ground-truth fixtures for classification tests.
//   node test/gen-ts-semtok.js [--types <@types dir>] <file.js|ts> > test/fixtures/<file>.tokens.json
// `--types` resolves modules as Node does and loads that directory's `node` types,
// as VS Code does for a loose file once automatic type acquisition has fetched
// them (macOS: ~/Library/Caches/typescript/<version>/node_modules/@types).
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const at = args.indexOf('--types');
const types = at < 0 ? undefined : path.resolve(args.splice(at, 2)[1]);
const file = args[0];
const text = fs.readFileSync(file, 'utf8');
const settings = types
  ? {
    allowJs: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    typeRoots: [types],
    types: ['node'],
  }
  : { allowJs: true, target: ts.ScriptTarget.Latest };
const svc = ts.createLanguageService({
  getScriptFileNames: () => [file],
  getScriptVersion: () => '1',
  getScriptSnapshot: (f) => ts.ScriptSnapshot.fromString(f === file ? text : (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')),
  getCurrentDirectory: () => process.cwd(),
  getCompilationSettings: () => settings,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
});
const cls = svc.getEncodedSemanticClassifications(file, { start: 0, length: text.length }, ts.SemanticClassificationFormat.TwentyTwenty);
// VS Code's legend names the twelfth type `method`; fixtures made before used `member`.
const TT = ['class', 'enum', 'interface', 'namespace', 'typeParameter', 'type', 'parameter', 'variable', 'enumMember', 'property', 'function', 'method'];
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
