// server.js  (ESM)
// Adds permissive CORS (incl. preflight) + GET /mcp SSE fallback,
// and a JSON-RPC /mcp handler compatible with ChatGPT’s connector.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();

// --- CORS: allow ChatGPT browser calls (preflight + custom headers)
const corsOpts = {
  origin: true,                           // reflect request Origin
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'MCP-Protocol-Version',
    'MCP-Client',
    'X-Requested-With',
    'Authorization'
  ],
  exposedHeaders: ['Content-Type'],
  optionsSuccessStatus: 204
};
app.use(cors(corsOpts));
app.options('*', cors(corsOpts));

app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 10000;
const GAS_BASE_URL = process.env.GAS_BASE_URL;
const GAS_KEY      = process.env.GAS_KEY;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

// ---- helper: call Apps Script Web App
async function gasCall(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) {
    throw new Error('Server missing GAS_BASE_URL or GAS_KEY');
  }
  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('key', GAS_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { method: 'GET' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'GAS error');
  return j;
}

// ---- simple local API key for /search & /fetch (not used by /mcp)
function requireKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.api_key;
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok:false, error:'Server missing BRIDGE_API_KEY' });
  if (k !== BRIDGE_API_KEY) return res.status(401).json({ ok:false, error:'Missing or invalid x-api-key' });
  next();
}

// ---- health
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- Friendly smoke-test endpoints
app.get('/search', requireKey, async (req, res) => {
  try {
    const { q = '', max = 5 } = req.query;
    const data = await gasCall('search', { q, max });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get('/fetch', requireKey, async (req, res) => {
  try {
    const { id, lines } = req.query;
    if (!id) return res.status(400).json({ ok:false, error:'Missing id' });
    const data = await gasCall('fetch', { id, lines });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ---- MCP (JSON-RPC over HTTP) ---------------------------------

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function handleMcp(req, res) {
  try {
    const { id, method, params } = req.body || {};
    if (!id || !method) return res.json(jsonRpcError(id ?? null, -32600, 'Invalid Request'));

    if (method === 'initialize') {
      // we speak the 2024-11-05 protocol (ChatGPT negotiates)
      return res.json(jsonRpcResult(id, { protocolVersion: '2024-11-05' }));
    }

    if (method === 'tools/list') {
      const tools = [
        {
          name: 'drive_search',
          description: 'Search Drive by title',
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'string' }, max: { type: 'number' } }
          }
        },
        {
          name: 'drive_fetch',
          description: 'Fetch Drive file by id',
          inputSchema: {
            type: 'object',
            properties: { id: { type: 'string' }, lines: { type: 'number' } }
          }
        }
      ];
      return res.json(jsonRpcResult(id, { tools }));
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};

      if (name === 'drive_search') {
        const q   = args.q   ?? '';
        const max = args.max ?? 5;
        const data = await gasCall('search', { q, max });
        return res.json(jsonRpcResult(id, { content: [{ type: 'json', json: data }] }));
      }

      if (name === 'drive_fetch') {
        const fid   = args.id;
        const lines = args.lines;
        if (!fid) return res.json(jsonRpcError(id, -32602, 'Missing id'));
        const data = await gasCall('fetch', { id: fid, lines });

        // If Apps Script returned inline text, surface it as text, else JSON
        const asText = data?.data?.inline && typeof data?.data?.text === 'string';
        const content = asText
          ? [{ type: 'text', text: data.data.text }]
          : [{ type: 'json', json: data }];

        return res.json(jsonRpcResult(id, { content }));
      }

      return res.json(jsonRpcError(id, -32601, 'Unknown tool'));
    }

    return res.json(jsonRpcError(id, -32601, 'Unknown method'));
  } catch (e) {
    return res.status(500).json(jsonRpcError(req.body?.id ?? null, -32000, e.message));
  }
}

// Primary JSON‑RPC endpoint
app.post('/mcp', handleMcp);
// Compatibility path (older tooling posts here)
app.post('/mcp/messages', handleMcp);

// GET /mcp – compatibility SSE that tells the client where to POST messages
app.get('/mcp', (req, res) => {
  res.set({
    'Content-Type' : 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection'   : 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const origin = `${proto}://${req.get('host')}`;
  const token = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';
  const messagesUrl = `${origin}/mcp/messages${token}`;

  const payload = JSON.stringify({ messages: messagesUrl });
  res.write(`event: endpoint\n`);
  res.write(`data: ${payload}\n\n`);
  // keep the stream open so the client sees it as SSE; send keepalives:
  const ping = setInterval(() => res.write(`: keepalive\n\n`), 25000);
  req.on('close', () => clearInterval(ping));
});

app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
