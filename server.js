// YFL Drive Bridge — Streamable HTTP MCP server (v3.1.1n, no node-fetch import)
// Uses Node's global fetch (Node >=18). Keep .env in project root or export env vars.
//
// Env: PORT, GAS_BASE_URL, GAS_KEY, BRIDGE_TOKEN (or TOKEN)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

const app = express();
app.set('trust proxy', true);            // honor X-Forwarded-* behind tunnels/proxies
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
  if (!GAS_BASE_URL || !GAS_KEY) {
    return { ok: false, error: 'GAS_BASE_URL or GAS_KEY missing' };
  }
  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('token', GAS_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { redirect: 'follow' }); // GAS may 302 to script.googleusercontent.com
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: 'non-JSON from GAS', body: text }; }
}

// -------- Basic health --------
app.get('/', (_req, res) => res.type('text/plain').send('YFL MCP up'));
app.get('/health', async (_req, res) => {
  const gas = await gasFetch('health');
  res.json({ ok: true, gas: !!(gas && gas.ok), version: '3.1.1n', ts: new Date().toISOString() });
});

// -------- Convenience mirror of GAS tools (optional) --------
app.get('/tools/list', requireToken, async (_req, res) => {
  const out = await gasFetch('tools/list');
  res.status(out.ok ? 200 : 500).json(out);
});
app.post('/tools/call', requireToken, async (req, res) => {
  const { name, args = {} } = req.body || {};
  const out = await gasFetch('tools/call', { name, ...args });
  res.status(out.ok ? 200 : 500).json(out);
});

// -------- MCP Streamable HTTP surface --------
function rpcOk(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcErr(id, code, message, data) { return { jsonrpc: '2.0', id, error: { code, message, data } }; }

const TOOL_LIST = [
  { name: 'drive.list', description: 'List files by folder path/ID', annotations: { readOnlyHint: true } },
  { name: 'drive.search', description: 'DriveApp v2 query (title contains, trashed=false)', annotations: { readOnlyHint: true } },
  { name: 'drive.get', description: 'Get metadata by file id', annotations: { readOnlyHint: true } },
  { name: 'drive.export', description: 'Export Google Docs/Sheets content', annotations: { readOnlyHint: true } }, // GAS must support
];

app.head('/mcp', (_req, res) => res.sendStatus(204));
app.get('/mcp', (_req, res) => res.json({ ok: true, transport: 'streamable-http' }));

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
      // Proxy to GAS web app (ContentService JSON)
      const out = await gasFetch('tools/call', { name, ...args });
      if (!out || out.ok !== true) {
        return res.json(rpcErr(id, -32000, 'tool call failed', out));
      }
      // Return JSON as text content for MCP Inspector friendliness
      return res.json(rpcOk(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }));
    }

    return res.json(rpcErr(id, -32601, 'method not found'));
  } catch (e) {
    return res.json(rpcErr(null, -32603, 'internal error', String(e)));
  }
});

app.listen(PORT, () => {
  console.log(`[bridge] listening on http://localhost:${PORT}`);
  console.log(`[bridge] GAS_BASE_URL=${GAS_BASE_URL ? 'set' : 'missing'} | GAS_KEY=${GAS_KEY ? 'set' : 'missing'}`);
});
