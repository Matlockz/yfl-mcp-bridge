// YFL MCP Bridge — HTTP transport + Apps Script proxy
// ESM syntax, Node >=18

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ------------------ env ------------------
const PORT = process.env.PORT || 10000;              // Render will inject 10000
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY = process.env.GAS_KEY || '';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || '';
const PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';

// ------------------ app ------------------
const app = express();

// CORS: allow ChatGPT (and fall back to *)
const ALLOW_ORIGINS = new Set([
  'https://chat.openai.com',
  'https://chatgpt.com',
  'https://stg.chat.openai.com',
  'http://localhost:5173',
  'http://localhost:3000'
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOW_ORIGINS.has(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // fine for this bridge; tighten later if you want
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,MCP-Protocol-Version,MCP-Client,Authorization,X-Requested-With'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(cors());

// ------------------ helpers ------------------
function setMcpHeaders(res) {
  res.setHeader('MCP-Protocol-Version', PROTOCOL);
}

function jsonrpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonrpcErr(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

async function gasCall(action, params) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('Server missing GAS_BASE_URL or GAS_KEY');
  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('key', GAS_KEY);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { method: 'GET' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'GAS error');
  return j;
}

// local API key for /search and /fetch (handy smoke tests)
function requireKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.api_key;
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok: false, error: 'Server missing BRIDGE_API_KEY' });
  if (k !== BRIDGE_API_KEY) return res.status(401).json({ ok: false, error: 'Missing or invalid x-api-key' });
  next();
}

// ------------------ health ------------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ------------------ friendly GETs ------------------
app.get('/search', requireKey, async (req, res) => {
  try {
    const { q = '', max = 5 } = req.query;
    const data = await gasCall('search', { q, max });
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/fetch', requireKey, async (req, res) => {
  try {
    const { id, lines } = req.query;
    if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });
    const data = await gasCall('fetch', { id, lines });
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ------------------ MCP: SSE negotiation (GET /mcp) ------------------
app.get('/mcp', (req, res) => {
  setMcpHeaders(res);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const host = req.get('host');
  const scheme = req.protocol;
  const token = req.query.token || '';

  const messagesUrl = new URL(`${scheme}://${host}/mcp/messages`);
  if (token) messagesUrl.searchParams.set('token', token);

  // The connector expects an `endpoint` event containing the messages URL.
  const payload = {
    messages: messagesUrl.toString(),
    protocolVersion: PROTOCOL
  };

  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);

  const keep = setInterval(() => res.write(`: keepalive\n\n`), 25000);
  req.on('close', () => clearInterval(keep));
});

// ------------------ MCP: JSON-RPC endpoint (POST /mcp + /mcp/messages) ------------------
async function handleMcp(req, res) {
  try {
    setMcpHeaders(res);
    const { jsonrpc, id, method, params = {} } = req.body || {};
    if (jsonrpc !== '2.0') return res.json(jsonrpcErr(id ?? null, -32600, 'Invalid Request'));

    // ---- REQUIRED by spec: initialize must return capabilities + serverInfo ----
    if (method === 'initialize') {
      return res.json(jsonrpcOk(id, {
        protocolVersion: PROTOCOL,
        capabilities: {
          tools: { listChanged: true }   // we expose tools and support listChanged
        },
        serverInfo: {
          name: 'yfl-drive-bridge',
          title: 'YFL Drive Bridge',
          version: '1.0.0'
        },
        instructions: 'Tools available: drive_search, drive_fetch.'
      }));
    }

    // This is a notification (no id) — acknowledge with empty body
    if (method === 'notifications/initialized') {
      return res.status(200).end();
    }

    if (method === 'tools/list') {
      return res.json(jsonrpcOk(id, {
        tools: [
          {
            name: 'drive_search',
            description: 'Search Drive by title',
            inputSchema: {
              type: 'object',
              properties: {
                q:   { type: 'string' },
                max: { type: 'number' }
              }
            }
          },
          {
            name: 'drive_fetch',
            description: 'Fetch Drive file by id',
            inputSchema: {
              type: 'object',
              properties: {
                id:    { type: 'string' },
                lines: { type: 'number' }
              }
            }
          }
        ]
      }));
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;

      if (name === 'drive_search') {
        const { q = '', max = 5 } = args;
        const data = await gasCall('search', { q, max });
        // Return as MCP content block
        return res.json(jsonrpcOk(id, { content: [{ type: 'json', json: data }] }));
      }

      if (name === 'drive_fetch') {
        const { id: fileId, lines } = args;
        if (!fileId) return res.json(jsonrpcErr(id, -32602, 'Missing id'));
        const data = await gasCall('fetch', { id: fileId, lines });
        const payload = data?.data?.data || data?.data || data;

        if (payload?.inline && typeof payload.text === 'string') {
          return res.json(jsonrpcOk(id, { content: [{ type: 'text', text: payload.text }] }));
        }
        return res.json(jsonrpcOk(id, { content: [{ type: 'json', json: data }] }));
      }

      return res.json(jsonrpcErr(id, -32601, 'Unknown tool'));
    }

    return res.json(jsonrpcErr(id, -32601, 'Unknown method'));
  } catch (err) {
    return res.json(jsonrpcErr(req.body?.id ?? null, -32000, 'Internal error', String(err?.message || err)));
  }
}

app.post('/mcp', handleMcp);
app.post('/mcp/messages', handleMcp);

// ------------- start -------------
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
