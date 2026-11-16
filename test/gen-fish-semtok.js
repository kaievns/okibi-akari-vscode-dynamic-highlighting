// Capture REAL fish-lsp semantic tokens and document symbols for one file, in the
// wire format the stub serves ({ server, legend, data, symbols }):
//   node test/gen-fish-semtok.js test/fixtures/transitions/walk.fish > test/fixtures/shell/walk.fish.lsp.json
// FISH_LSP=/path/to/fish-lsp overrides the one on PATH (brew install fish-lsp; 1.1.5
// measured). The answer is taken once it has not changed for 2 s.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const server = process.env.FISH_LSP || 'fish-lsp';
const file = path.resolve(process.argv[2]);
const src = fs.readFileSync(file, 'utf8');
const version = execFileSync(server, ['--version'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
const p = spawn(server, ['start'], { stdio: ['pipe', 'pipe', 'ignore'], cwd: path.dirname(file) });
let buf = Buffer.alloc(0);
const pending = new Map();
let nextId = 1;
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
    const hEnd = buf.indexOf('\r\n\r\n');
    if (hEnd < 0) return;
    const len = Number(/Content-Length: (\d+)/.exec(buf.slice(0, hEnd).toString())[1]);
    if (buf.length < hEnd + 4 + len) return;
    const msg = JSON.parse(buf.slice(hEnd + 4, hEnd + 4 + len).toString());
    buf = buf.slice(hEnd + 4 + len);
    if (msg.id !== undefined && msg.method) {
      const result = msg.method === 'workspace/configuration' ? msg.params.items.map(() => null) : null;
      send({ jsonrpc: '2.0', id: msg.id, result });
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toSymbol = (s) => ({
  name: s.name, kind: s.kind - 1, range: s.range, selectionRange: s.selectionRange, children: (s.children || []).map(toSymbol),
});

(async () => {
  const root = `file://${path.dirname(file)}`;
  const init = await request('initialize', {
    processId: process.pid,
    rootUri: root,
    workspaceFolders: [{ uri: root, name: 'fixtures' }],
    capabilities: {
      workspace: { configuration: true, workspaceFolders: true },
      textDocument: {
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        semanticTokens: { requests: { full: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'], multilineTokenSupport: false },
      },
    },
  });
  const legend = init.result.capabilities.semanticTokensProvider.legend;
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  const uri = `file://${file}`;
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'fish', version: 1, text: src } } });
  let data = null;
  let since = Date.now();
  for (const deadline = Date.now() + 60000; Date.now() < deadline;) {
    const r = await request('textDocument/semanticTokens/full', { textDocument: { uri } });
    const now = r.result?.data ?? null;
    if (now === null || data === null || now.join() !== data.join()) {
      data = now;
      since = Date.now();
    } else if (Date.now() - since >= 2000) {
      break;
    }
    await sleep(250);
  }
  const sym = await request('textDocument/documentSymbol', { textDocument: { uri } });
  process.stdout.write(`${JSON.stringify({
    server: `fish-lsp ${version}`,
    legend,
    data: data ?? [],
    symbols: Array.isArray(sym.result) ? sym.result.map(toSymbol) : [],
  })}\n`);
  await request('shutdown', null);
  send({ jsonrpc: '2.0', method: 'exit' });
  setTimeout(() => process.exit(0), 200);
})();
