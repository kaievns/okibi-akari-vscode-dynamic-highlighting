// Capture REAL sourcekit-lsp semantic tokens for one fixture, in the shapes the Swift tests read:
//   node test/gen-swift-semtok.js test/fixtures/swift/constructs.swift > test/fixtures/swift/constructs.swift.sk.json
//   node test/gen-swift-semtok.js test/fixtures/swift/Widget.m > test/fixtures/swift/Widget.m.sk.json
// A `.swift` file is copied into a scratch SwiftPM package and its answer decoded to
// [{ offset, length, type, modifiers }]. A `.m` file and its sibling `.h` get a scratch
// compile_commands.json, and the answer is kept raw, { legend, data }, with the legend
// the server registers for Objective-C (docs/c-jvm.md#objective-c).
// SOURCEKIT_LSP overrides the Command Line Tools' server. The answer is taken once it repeats.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const server = process.env.SOURCEKIT_LSP || '/Library/Developer/CommandLineTools/usr/bin/sourcekit-lsp';
const SDK = '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk';
const src = path.resolve(process.argv[2]);
const objc = src.endsWith('.m');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcekit-'));
let file;
if (objc) {
  file = path.join(root, path.basename(src));
  fs.copyFileSync(src, file);
  const header = src.replace(/\.m$/, '.h');
  if (fs.existsSync(header)) fs.copyFileSync(header, path.join(root, path.basename(header)));
  fs.writeFileSync(path.join(root, 'compile_commands.json'), JSON.stringify([{ directory: root, file,
    arguments: ['clang', '-x', 'objective-c', '-fobjc-arc', '-isysroot', SDK, '-c', path.basename(file)] }]));
} else {
  fs.mkdirSync(path.join(root, 'Sources/Fixture'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Package.swift'), '// swift-tools-version: 6.0\nimport PackageDescription\n\n'
    + 'let package = Package(name: "Fixture", platforms: [.macOS(.v14)], targets: [.target(name: "Fixture")])\n');
  file = path.join(root, 'Sources/Fixture', path.basename(src));
  fs.copyFileSync(src, file);
}
const text = fs.readFileSync(file, 'utf8');
process.stderr.write(`${execFileSync('/usr/bin/xcrun', ['swift', '--version'], { encoding: 'utf8' }).split('\n')[0]}\n`);

const p = spawn(server, [], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, TMPDIR: root } });
let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
let registered = null;
const send = (msg) => {
  const s = JSON.stringify(msg);
  p.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
};
const request = (method, params) => new Promise((res) => {
  const id = nextId++;
  pending.set(id, res);
  send({ jsonrpc: '2.0', id, method, params });
});
p.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const len = +/Content-Length: (\d+)/i.exec(buf.slice(0, end).toString())[1];
    if (buf.length < end + 4 + len) return;
    const msg = JSON.parse(buf.slice(end + 4, end + 4 + len).toString());
    buf = buf.slice(end + 4 + len);
    if (msg.method === undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    } else if (msg.method === 'client/registerCapability') {
      for (const r of msg.params.registrations) if (r.method === 'textDocument/semanticTokens') registered = r.registerOptions.legend;
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    } else if (msg.id !== undefined && msg.method) {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    }
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const init = await request('initialize', {
    processId: process.pid, rootUri: `file://${root}`, workspaceFolders: [{ uri: `file://${root}`, name: 'fixture' }],
    initializationOptions: { backgroundIndexing: false },
    capabilities: { textDocument: { semanticTokens: { dynamicRegistration: true, requests: { full: true }, formats: ['relative'],
      tokenTypes: [], tokenModifiers: [] } }, workspace: { configuration: true } },
  });
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  const lang = objc ? 'objective-c' : 'swift';
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: `file://${file}`, languageId: lang, version: 1, text } } });
  let prev = '';
  let data = [];
  for (const deadline = Date.now() + 120000; Date.now() < deadline; await sleep(1500)) {
    const r = await request('textDocument/semanticTokens/full', { textDocument: { uri: `file://${file}` } });
    data = r?.data ?? [];
    if (data.length && data.join() === prev) break;
    prev = data.join();
  }
  const legend = registered ?? init.capabilities.semanticTokensProvider.legend;
  if (objc) {
    process.stdout.write(JSON.stringify({ legend, data }) + '\n');
  } else {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const out = [];
    for (let i = 0, line = 0, ch = 0; i < data.length; i += 5) {
      line += data[i];
      ch = data[i] ? data[i + 1] : ch + data[i + 1];
      out.push({ offset: starts[line] + ch, length: data[i + 2], type: legend.tokenTypes[data[i + 3]],
        modifiers: legend.tokenModifiers.filter((_, b) => data[i + 4] & (1 << b)) });
    }
    process.stdout.write(JSON.stringify(out) + '\n');
  }
  await request('shutdown', null);
  send({ jsonrpc: '2.0', method: 'exit' });
  setTimeout(() => p.kill('SIGKILL'), 2000).unref();
})();
