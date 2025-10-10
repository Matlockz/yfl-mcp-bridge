// YFL MCP Bridge — Streamable HTTP transport + Apps Script proxy (ESM)

// ---------------- imports ----------------
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ---------------- env ----------------
const PORT = process.env.PORT || 10000;  // Render injects 10000
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY      = process.env.GAS_KEY || '';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || '';
const PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';

// ---------------- app ----------------
const app = express();

// CORS: allow ChatGPT (and fall back to `*`)
const ALLOW_ORIGINS = new Set([
  'https://chat.openai.com',
  'https://chatgpt.com',
  'https://stg.chat.openai.com',
  'http://localhost:5173',
  'http://localhost:3000'
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,OPTIONS'
  );
  // Let preflights include the MCP header
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,MCP-Protocol-Version,MCP-Client,X-Requested-With,Authorization'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------------- utilities ----------------
function ensureEnv() {
  if (!GAS_BASE_URL || !GAS_KEY) {
    throw new Error('Server missing GAS_BASE_URL or GAS_KEY');
  }
}

async function gasCall(action, params = {}) {
  ensureEnv();
  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('key', GAS_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, String(v));
    }
  }
  const r = await fetch(url, { method: 'GET' });
  const j = await r.json();
  if (!j?.ok) throw new Error(j?.error || 'GAS error');
  return j; // shape: { ok:true, data:{ ok:true, data:{ … } } }
}

// JSON-RPC helpers
function jsonrpc(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonrpcErr(id, code, message, data) {
  const e = { code, message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: '2.0', id, error: e };
}

// ---------------- health ----------------
app.get('/health', (_req, res) => {
  res.type('application/json').send(JSON.stringify({ ok: true }));
});

// ---------------- friendly GETs (manual smoke tests) ----------------
function requireKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.api_key;
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok:false, error:'Server missing BRIDGE_API_KEY' });
  if (k !== BRIDGE_API_KEY) return res.status(401).json({ ok:false, error:'Missing or invalid x-api-key' });
  next();
}

app.get('/search', requireKey, async (req, res) => {
  try {
    const { q = '', max = 5 } = req.query;
    const out = await gasCall('search', { q, max });
    res.json({ ok: true, data: out });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

app.get('/fetch', requireKey, async (req, res) => {
  try {
    const { id, lines } = req.query;
    if (!id) return res.status(400).json({ ok:false, error:'Missing id' });
    const out = await gasCall('fetch', { id, lines });
    res.json({ ok: true, data: out });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

// ---------------- MCP: SSE handshake (Streamable HTTP) ----------------
// GET /mcp?token=...
app.get('/mcp', (req, res) => {
  // Very light token check (keeps randoms away). Add anything stronger if you want.
  const tk = req.query.token;
  if (!tk || typeof tk !== 'string') {
    // JSON‑RPC error code parity (unknown method vs invalid request)
    // Here it's a plain HTTP error since this is the SSE handshake.
    return res.status(400).send('Missing token');
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // tell client where to POST JSON-RPC messages
  const endpoint = new URL(req.protocol + '://' + req.get('host') + '/mcp/messages');
  endpoint.searchParams.set('token', tk);
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ messages: endpoint.toString() })}\n\n`);

  // keepalive
  const iv = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 15000);

  req.on('close', () => clearInterval(iv));
});

// ---------------- MCP: single POST endpoint for JSON-RPC ----------------
app.post('/mcp/messages', async (req, res) => {
  try {
    const proto = req.header('MCP-Protocol-Version') || PROTOCOL;
    if (!proto) return res.status(400).json({ error: 'Missing MCP-Protocol-Version' });

    const { jsonrpc: v, id, method, params } = req.body || {};
    if (v !== '2.0') return res.json(jsonrpcErr(id ?? null, -32600, 'Invalid Request')); // JSON-RPC 2.0

    // initialize
    if (method === 'initialize') {
      return res.json(jsonrpc(id, { protocolVersion: PROTOCOL }));
    }

    // tools/list
    if (method === 'tools/list') {
      return res.json(
        jsonrpc(id, {
          tools: [
            {
              name: 'drive_search',
              description: 'Search Drive by title',
              inputSchema: {
                type: 'object',
                properties: {
                  q: { type: 'string' },
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
                  id: { type: 'string' },
                  lines: { type: 'number' }
                }
              }
            }
          ]
        })
      );
    }

    // tools/call
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      if (name === 'drive_search') {
        const q = args.q ?? '';
        const max = args.max ?? 5;
        const out = await gasCall('search', { q, max });
        // out shape: { ok:true, data:{ ok:true, data:{ query,count,files[] } } }
        const files = out?.data?.data ?? null;
        return res.json(
          jsonrpc(id, {
            content: [{ type: 'json', json: files }]
          })
        );
      }
      if (name === 'drive_fetch') {
        const idArg = args.id;
        const lines = args.lines;
        if (!idArg) {
          return res.json(jsonrpcErr(id ?? null, -32602, 'Missing id'));
        }
        const out = await gasCall('fetch', { id: idArg, lines });
        // If GAS returns inline text, expose as type:text. Otherwise bubble the json.
        const payload = out?.data?.data ?? null;
        if (payload?.inline && typeof payload?.text === 'string') {
          return res.json(
            jsonrpc(id, { content: [{ type: 'text', text: payload.text }] })
          );
        }
        return res.json(
          jsonrpc(id, { content: [{ type: 'json', json: payload }] })
        );
      }
      return res.json(jsonrpcErr(id ?? null, -32601, 'Unknown tool')); // JSON-RPC "Method not found" :contentReference[oaicite:2]{index=2}
    }

    // unknown method
    return res.json(jsonrpcErr(id ?? null, -32601, 'Unknown method')); // JSON-RPC 2.0 :contentReference[oaicite:3]{index=3}
  } catch (err) {
    return res.json(jsonrpcErr(req.body?.id ?? null, -32000, 'Internal error', String(err?.message || err)));
  }
});

// ---------------- start ----------------
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
