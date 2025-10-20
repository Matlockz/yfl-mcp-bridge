// YFL Drive Bridge v3.1.1 — MCP streamable HTTP server
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import fetch from 'node-fetch';

const { PORT = 10000, GAS_BASE_URL, GAS_KEY: TOKEN, BRIDGE_TOKEN = TOKEN } = process.env;
if (!GAS_BASE_URL || !TOKEN) {
  console.error('Missing GAS_BASE_URL or GAS_KEY in environment'); process.exit(1);
}

const app = express();
app.set('trust proxy', true);              // respect X-Forwarded-Proto behind ngrok/Cloudflare
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

const q = (o) => Object.entries(o).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

async function gas(action, params = {}) {
  const url = `${GAS_BASE_URL}?${q({ action, token: TOKEN, ...params })}`;
  const res = await fetch(url, { redirect: 'follow' });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok:false, error:'non-json', raw:text }; }
}

/** Health */
app.get('/health', async (_req, res) => {
  const h = await gas('health');
  res.json({ ok: !!h.ok, gas: !!h.gas, ts: h.ts || null, version: h.version || null });
});

/** Minimal GET/HEAD surface for Inspector */
app.get('/mcp', (_req, res) => res.json({ ok: true, transport: 'streamable-http' }));
app.head('/mcp', (_req, res) => res.sendStatus(204));

/** JSON-RPC 2.0 */
app.post('/mcp', async (req, res) => {
  const { id, method, params } = req.body || {};
  const rpc = (o) => res.json({ jsonrpc: '2.0', id, ...o }); // spec: exactly one of result|error
  try {
    if (method === 'initialize') {
      return rpc({ result: { protocolVersion: '2024-07-01', capabilities: { tools: {} } } });
    }
    if (method === 'tools/list') {
      const t = await gas('tools/list');
      if (!t.ok) return rpc({ error: { code: -32000, message: t.error || 'tools/list failed' } });
      return rpc({ result: {
        tools: (t.tools || []).map(tool => ({ ...tool, annotations: { ...(tool.annotations||{}), readOnlyHint: true } }))
      }});
    }
    if (method === 'tools/call') {
      const { name, args = {} } = params || {};
      if (!name) return rpc({ error: { code: -32602, message: 'missing tool name' } });
      const out = await gas('tools/call', { name, ...args });
      if (!out.ok) return rpc({ error: { code: -32001, message: out.error || 'tool call failed' } });
      return rpc({ result: out });
    }
    return rpc({ error: { code: -32601, message: 'method not found' } });
  } catch (e) {
    return rpc({ error: { code: -32603, message: String(e) } });
  }
});

app.listen(PORT, () => console.log(`[bridge] listening on http://localhost:${PORT}`));
