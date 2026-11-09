// Dump the Deno language server's semantic tokens for one file as JSON DecodedToken[],
// as VS Code's denoland.vscode-deno client receives them with `deno.enable` on.
//   node test/gen-deno-semtok.js <file.js|ts> > test/fixtures/<file>.deno.json
// `DENO=/path/to/deno` picks the binary (default: the one on PATH). The file's
// directory is the workspace; the module cache is a fresh temp directory.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const file = path.resolve(process.argv[2]);
const root = path.dirname(file);
const text = fs.readFileSync(file, 'utf8');
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'okibi-deno-'));
const server = spawn(process.env.DENO || 'deno', ['lsp'], { cwd: root, env: { ...process.env, DENO_DIR: cache, NO_COLOR: '1' } });
server.stderr.resume();

let buf = Buffer.alloc(0);
let nextId = 0;
const pending = new Map();
const send = (msg) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
  server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const request = (method, params) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  send({ id, method, params });
});
server.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const head = buf.indexOf('\r\n\r\n');
    if (head < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, head).toString())[1]);
    if (buf.length < head + 4 + len) return;
    const msg = JSON.parse(buf.subarray(head + 4, head + 4 + len).toString());
    buf = buf.subarray(head + 4 + len);
    if (msg.method === undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method !== undefined && msg.id !== undefined) {
      const result = msg.method === 'workspace/configuration' ? (msg.params.items || []).map(() => ({ enable: true, lint: false })) : null;
      send({ id: msg.id, result });
    }
  }
});

(async () => {
  const rootUri = `file://${root}`;
  const uri = `file://${file}`;
  const init = await request('initialize', {
    processId: process.pid,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
    capabilities: {
      textDocument: { semanticTokens: { requests: { full: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'] } },
      workspace: { configuration: true },
    },
    initializationOptions: { enable: true, lint: false },
  });
  const legend = init.result.capabilities.semanticTokensProvider.legend;
  send({ method: 'initialized', params: {} });
  send({ method: 'workspace/didChangeConfiguration', params: { settings: { deno: { enable: true, lint: false } } } });
  send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: /\.[cm]?tsx?$/.test(file) ? 'typescript' : 'javascript', version: 1, text } } });
  // The first answers can come back empty while the server loads the module graph.
  let data = [];
  for (let attempt = 0; attempt < 20 && data.length === 0; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
    data = (await request('textDocument/semanticTokens/full', { textDocument: { uri } })).result?.data ?? [];
  }
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const out = [];
  let line = 0;
  let ch = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    ch = data[i] ? data[i + 1] : ch + data[i + 1];
    const offset = lineStarts[line] + ch;
    const modifiers = legend.tokenModifiers.filter((_, b) => data[i + 4] & (1 << b));
    out.push({ name: text.slice(offset, offset + data[i + 2]), offset, length: data[i + 2], type: legend.tokenTypes[data[i + 3]], modifiers });
  }
  console.log(JSON.stringify(out, null, 0));
  await request('shutdown', null);
  send({ method: 'exit' });
  setTimeout(() => {
    fs.rmSync(cache, { recursive: true, force: true });
    process.exit(0);
  }, 300);
})();
