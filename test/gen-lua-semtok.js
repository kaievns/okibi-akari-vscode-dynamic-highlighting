// Capture REAL lua-language-server semantic tokens and document symbols for one
// file, in the wire format the stub serves ({ server, legend, data, symbols }):
//   node test/gen-lua-semtok.js samples/sample.lua > test/fixtures/sample.lua.lsp.json
//   node test/gen-lua-semtok.js --keyword test/fixtures/format.lua > test/fixtures/format.lua.keyword.lsp.json
// LUALS=/path/to/lua-language-server overrides the one on PATH. Settings are
// sumneko.lua's defaults, with `Lua.semantic.keyword` on under --keyword; the
// answer is taken once it has not changed for 2 s.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const server = process.env.LUALS || 'lua-language-server';
const args = process.argv.slice(2);
const keyword = args.includes('--keyword');
const file = path.resolve(args.filter((a) => a !== '--keyword')[0]);
const src = fs.readFileSync(file, 'utf8');
const version = execFileSync(server, ['--version'], { encoding: 'utf8' }).trim();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'luals-'));
const settings = {
  Lua: {
    runtime: { version: 'Lua 5.4' },
    semantic: { enable: true, variable: true, annotation: true, keyword },
    diagnostics: { enable: false },
    workspace: { checkThirdParty: false, library: [] },
    telemetry: { enable: false },
  },
};

const p = spawn(server, [`--logpath=${scratch}`, `--metapath=${scratch}/meta`], { stdio: ['pipe', 'pipe', 'ignore'] });
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
const setting = (section) => {
  let v = settings;
  for (const k of (section || '').split('.').filter(Boolean)) v = v?.[k];
  return v ?? null;
};
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
      const result = msg.method === 'workspace/configuration' ? msg.params.items.map((it) => setting(it.section)) : null;
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
  const init = await request('initialize', {
    processId: process.pid,
    rootUri: null,
    capabilities: {
      workspace: { configuration: true },
      textDocument: {
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        semanticTokens: { requests: { full: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'], multilineTokenSupport: true },
      },
    },
  });
  const legend = init.result.capabilities.semanticTokensProvider.legend;
  send({ jsonrpc: '2.0', method: 'initialized', params: {} });
  send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings } });
  const uri = `file://${file}`;
  send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'lua', version: 1, text: src } } });
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
    server: `lua-language-server ${version}`,
    keyword,
    legend,
    data: data ?? [],
    symbols: Array.isArray(sym.result) ? sym.result.map(toSymbol) : [],
  })}\n`);
  await request('shutdown', null);
  send({ jsonrpc: '2.0', method: 'exit' });
  setTimeout(() => {
    p.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
  }, 500);
})().catch((e) => {
  console.error(e);
  p.kill();
  process.exit(1);
});
