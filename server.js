// YFL Drive Bridge — Streamable HTTP MCP server (v3.1.1n)
// Node >=18 (uses global fetch). Env: PORT, GAS_BASE_URL, GAS_KEY, BRIDGE_TOKEN (or TOKEN)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

const app = express();
app.set('trust proxy', true);

// CORS for Direct connections from MCP Inspector (browser)
app.use(cors({ origin: true, credentials: false }));
app.options('*', cors()); // preflight
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

const PORT = Number(process.env.PORT || 10000);
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY = process.env.GAS_KEY || '';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.TOKEN || '';

function needEnv(res) {
  if (!GAS_BASE_URL || !GAS_KEY) {
    res.status(500).json({ ok: false, error: 'GAS_BASE_URL or GAS_KEY missing' });
    return true;
  }
  return false;
}

function requireToken(req, res, next) {
  const t = req.query.token || req.header('x-bridge-token');
  if (!BRIDGE_TOKEN) return res.status(500).json({ ok: false, error: 'bridge token missing (server)' });
  if (t !== BRIDGE_TOKEN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  return next();
}

async function gasFetch(action, params = {}) {
  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('token', GAS_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { redirect: 'follow' }); // follows script.googleusercontent.com
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: 'non-JSON from GAS', body: text };
  }
}

// ---- Health & simple GAS mirrors ----
app.get('/', (_req, res) => res.type('text/plain').send('YFL MCP up'));
app.get('/health', async (_req, res) => {
  if (needEnv(res)) return;
  const gas = await gasFetch('health');
  res.json({ ok: true, gas: !!(gas && gas.ok), version: '3.1.1n', ts: new Date().toISOString() });
});

// ---- MCP Streamable HTTP endpoint ----
app.get('/mcp', (_req, res) => {
  res.json({ ok: true, transport: 'streamable-http' });
});

app.post('/mcp', async (req, res) => {
  const { id, method, params } = req.body || {};
  const reply = (result, error) =>
    res.json({ jsonrpc: '2.0', id: id ?? null, ...(error ? { error } : { result }) });

  try {
    // --- initialize handler: ensure serverInfo + proper JSON-RPC envelope ---
if (rpc?.method === 'initialize') {
  const result = {
    protocolVersion: '2024-11-05',
    // Advertise only what you actually implement. Tools are fine here.
    capabilities: { tools: {} },
    // This block is required for Inspector/clients to display server info.
    serverInfo: {
      name: 'YFL Drive Bridge',
      version: process.env.BRIDGE_VERSION || '3.1.1n'
    }
  };
  return res.status(200).json({ jsonrpc: '2.0', id: rpc.id ?? null, result });
}


    if (method === 'tools/list') {
      return reply({
        tools: [
          { name: 'drive.list',   description: 'List files by folder path/ID',        annotations: { readOnlyHint: true } },
          { name: 'drive.search', description: 'DriveApp v2 query (title, trashed)',  annotations: { readOnlyHint: true } },
          { name: 'drive.get',    description: 'Get metadata by file id',             annotations: { readOnlyHint: true } },
          { name: 'drive.export', description: 'Export Google Docs/Sheets content',   annotations: { readOnlyHint: true } },
        ],
      });
    }

    if (method === 'tools/call') {
      if (needEnv(res)) return;
      // protect tool invocation with token
      const t = req.query.token || req.header('x-bridge-token');
      if (!BRIDGE_TOKEN || t !== BRIDGE_TOKEN) {
        return reply(null, { code: -32000, message: 'unauthorized (tools/call)' });
      }

      const { name, arguments: args } = params || {};
      if (!name) return reply(null, { code: -32602, message: 'tool name required' });

      let out;
      if (name === 'drive.list')   out = await gasFetch('drive.list',   args || {});
      else if (name === 'drive.search') out = await gasFetch('drive.search', args || {});
      else if (name === 'drive.get')    out = await gasFetch('drive.get',    args || {});
      else if (name === 'drive.export') out = await gasFetch('drive.export', args || {});
      else return reply(null, { code: -32601, message: `unknown tool: ${name}` });

      return out && out.ok
        ? reply(out)
        : reply(null, { code: -32001, message: out?.error || 'tool call failed', data: out });
    }

    return reply(null, { code: -32601, message: `unknown method: ${method}` });
  } catch (e) {
    return reply(null, { code: -32099, message: String(e && e.message || e) });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[yfl-mcp] listening on ${PORT}`);
});
