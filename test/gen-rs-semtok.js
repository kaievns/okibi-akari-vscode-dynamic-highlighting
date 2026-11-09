// Capture REAL rust-analyzer semantic tokens for one file in the two layouts the
// path-keyword restore cares about, as JSON DecodedToken[]:
//   detached      the file alone, no Cargo.toml (settled reply)
//   cargoLoading  the file as src/main.rs of a cargo package, first non-empty reply
//   cargo         the same package once the server is quiescent and replies repeat
//   node test/gen-rs-semtok.js test/fixtures/rust-paths.rs > test/fixtures/rust-paths.tokens.json
// RA=/path/to/rust-analyzer overrides the newest one under ~/.vscode/extensions.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findServer() {
  if (process.env.RA) return process.env.RA;
  const dir = path.join(os.homedir(), '.vscode/extensions');
  const ext = fs.readdirSync(dir).filter((d) => d.startsWith('rust-lang.rust-analyzer-')).sort().pop();
  if (!ext) throw new Error('no rust-analyzer found; set RA');
  return path.join(dir, ext, 'server/rust-analyzer');
}

function capture(server, file, root) {
  const src = fs.readFileSync(file, 'utf8');
  const p = spawn(server, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = Buffer.alloc(0);
  const pending = new Map();
  let nextId = 1;
  let quiescent = false;
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
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
      if (msg.method === 'experimental/serverStatus') quiescent = msg.params.quiescent;
      if (msg.method === 'workspace/semanticTokens/refresh') send({ jsonrpc: '2.0', id: msg.id, result: null });
    }
  });
  return (async () => {
    const init = await request('initialize', {
      processId: process.pid,
      rootUri: `file://${root}`,
      capabilities: {
        workspace: { semanticTokens: { refreshSupport: true } },
        textDocument: { semanticTokens: { requests: { full: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'], multilineTokenSupport: true, overlappingTokenSupport: false } },
        experimental: { serverStatusNotification: true },
      },
      initializationOptions: { cargo: { buildScripts: { enable: false } }, procMacro: { enable: false } },
    });
    const legend = init.result.capabilities.semanticTokensProvider.legend;
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: `file://${file}`, languageId: 'rust', version: 1, text: src } } });
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
    const decode = (data) => {
      const out = [];
      let line = 0;
      let ch = 0;
      for (let i = 0; i < data.length; i += 5) {
        const [dl, dc, length, ti, tm] = data.slice(i, i + 5);
        line += dl;
        ch = dl ? dc : ch + dc;
        const offset = starts[line] + ch;
        out.push({ name: src.slice(offset, offset + length), type: legend.tokenTypes[ti], modifiers: legend.tokenModifiers.filter((_, b) => tm & (1 << b)), offset, length });
      }
      return out;
    };
    let first = null;
    let prev = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const r = await request('textDocument/semanticTokens/full', { textDocument: { uri: `file://${file}` } });
      const data = r.result?.data?.length ? r.result.data : null;
      first ??= data;
      if (data && quiescent && prev && data.join() === prev.join()) {
        p.kill();
        return { first: decode(first), settled: decode(data) };
      }
      prev = data;
      await new Promise((res) => setTimeout(res, 300));
    }
    p.kill();
    throw new Error(`rust-analyzer never settled on ${file}`);
  })();
}

(async () => {
  const server = findServer();
  const src = path.resolve(process.argv[2]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-rs-semtok-'));
  const loose = path.join(tmp, 'loose');
  const cargo = path.join(tmp, 'cargo');
  fs.mkdirSync(loose);
  fs.mkdirSync(path.join(cargo, 'src'), { recursive: true });
  fs.copyFileSync(src, path.join(loose, path.basename(src)));
  fs.copyFileSync(src, path.join(cargo, 'src/main.rs'));
  fs.writeFileSync(path.join(cargo, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n');
  const [detached, packaged] = await Promise.all([
    capture(server, path.join(loose, path.basename(src)), loose),
    capture(server, path.join(cargo, 'src/main.rs'), cargo),
  ]);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(JSON.stringify({ detached: detached.settled, cargoLoading: packaged.first, cargo: packaged.settled }, null, 1));
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
