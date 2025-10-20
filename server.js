// YFL Drive Bridge — Streamable HTTP MCP server (v3.1.1n)
// Node >= 18 (uses global fetch). Put .env at project root or set env vars.
//
// Env: PORT, GAS_BASE_URL, GAS_KEY, BRIDGE_TOKEN (or TOKEN)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

const PORT = Number(process.env.PORT || 10000);
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY = process.env.GAS_KEY || '';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.TOKEN || '';

function requireToken(req, res, next) {
  const t = req.query.token || req.header('x-bridge-token');
  if (!BRIDGE_TOKEN) return res.status(500).json({ ok: false, error: 'bridge token missing (server)' });
  if (t !== BRIDGE_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  return next();
}

async function gasFetch(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) return { ok: false, error: 'GAS_BASE_URL or GAS_KEY missing' };
  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('token', GAS_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { redirect: 'follow' }); // follow script.googleusercontent.com hop
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: 'non-JSON from GAS', body: text }; }
}

// ---- Health & simple GAS mirrors ----
app.get('/', (_req, res) => res.type('text/plain').send('YFL MCP up'));
app.get('/health', async (_req, res) => {
  const gas = await gasFetch('health');
  res.json({ ok: true, gas: !!(gas && gas.ok), version: '3.1.1n', ts: new Date().toISOString() });
});
app.get('/tools/list', requireToken, async (_req, res) => {
  const out = await gasFetch('tools/list');
  res.status(out.ok ? 200 : 500).json(out);
});
app.post('/tools/call', requireToken, async (req, res) => {
  const { name, args = {} } = req.body || {};
  const out = await gasFetch('tools/call', { name, ...args });
  res.status(out.ok ? 200 : 500).json(out);
});

// ---- MCP Streamable HTTP ----
function rpcOk(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcErr(id, code, message, data) { return { jsonrpc: '2.0', id, error: { code, message, data } }; }

const TOOL_LIST = [
  { name: 'drive.list',   description: 'List files by folder path/ID',              annotations: { readOnlyHint: true } },
  { name: 'drive.search', description: 'DriveApp v2 query (title, trashed=false)',  annotations: { readOnlyHint: true } },
  { name: 'drive.get',    description: 'Get metadata by file id',                   annotations: { readOnlyHint: true } },
  { name: 'drive.export', description: 'Export Google Docs/Sheets or text files',   annotations: { readOnlyHint: true } },
];

app.head('/mcp', (_req, res) => res.sendStatus(204));
app.get('/mcp',  (_req, res) => res.json({ ok: true, transport: 'streamable-http' }));

app.post('/mcp', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { id, method, params = {} } = req.body || {};
    if (!id) return res.json(rpcErr(null, -32600, 'id required'));

    if (method === 'initialize') {
      return res.json(rpcOk(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} } }));
    }
    if (method === 'tools/list') {
      return res.json(rpcOk(id, { tools: TOOL_LIST }));
    }
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      if (!name) return res.json(rpcErr(id, -32602, 'tool name required'));
      const out = await gasFetch('tools/call', { name, ...args });
      if (!out || !out.ok) return res.json(rpcErr(id, -32001, out?.error || 'tool failed', out));
      // Return GAS JSON as text to keep Inspector rendering simple.
      return res.json(rpcOk(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }));
    }
    return res.json(rpcErr(id, -32601, `unknown method: ${method}`));
  } catch (e) {
    return res.json(rpcErr(null, -32000, String(e)));
  }
});

app.listen(PORT, () => console.log(`YFL MCP Bridge listening on port ${PORT}`));
