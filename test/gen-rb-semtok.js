// Capture REAL ruby-lsp semantic tokens and document symbols for one file, in the
// wire format the stub serves ({ server, legend, data, symbols }):
//   node test/gen-rb-semtok.js samples/sample.rb > test/fixtures/sample.rb.lsp.json
// RUBY_LSP=/path/to/ruby-lsp overrides the one on PATH. The server runs in a temp
// workspace with no Gemfile, so it composes its bundle there, never beside the file.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const server = process.env.RUBY_LSP || 'ruby-lsp';
const file = path.resolve(process.argv[2]);
const src = fs.readFileSync(file, 'utf8');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-lsp-'));
const p = spawn(server, [], { cwd: ws, stdio: ['pipe', 'pipe', 'ignore'] });
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
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const len = +/Content-Length: (\d+)/.exec(buf.slice(0, end).toString())[1];
    if (buf.length < end + 4 + len) return;
    const msg = JSON.parse(buf.slice(end + 4, end + 4 + len).toString());
    buf = buf.slice(end + 4 + len);
    if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, result: null });
    else if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

(async () => {
  const init = await request('initialize', {
    processId: process.pid,
    rootUri: `file://${ws}`,
    workspaceFolders: [{ uri: `file://${ws}`, name: 'ws' }],
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      textDocument: {
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        semanticTokens: { requests: { full: { delta: true }, range: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'] },
      },
    },
    initializationOptions: { enabledFeatures: { semanticHighlighting: true, documentSymbols: true, diagnostics: false } },
  });
  const { legend } = init.result.capabilities.semanticTokensProvider;
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  const uri = `file://${ws}/${path.basename(file)}`;
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'ruby', version: 1, text: src } } });
  const toks = await request('textDocument/semanticTokens/full', { textDocument: { uri } });
  const sym = await request('textDocument/documentSymbol', { textDocument: { uri } });
  const conv = (x) => ({ name: x.name, kind: x.kind - 1, range: x.range, selectionRange: x.selectionRange, children: (x.children || []).map(conv) });
  const { name, version } = init.result.serverInfo;
  process.stdout.write(JSON.stringify({
    server: `${name} ${version}`, legend, data: toks.result.data, symbols: Array.isArray(sym.result) ? sym.result.map(conv) : [],
  }));
  await request('shutdown', null);
  send({ jsonrpc: '2.0', method: 'exit' });
  setTimeout(() => p.kill(), 300);
})();
