// YFL MCP Bridge — HTTP transport + Apps Script proxy
// ESM syntax, Node >=18

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ---------------- env ----------------
const PORT = process.env.PORT || 10000;        // Render will inject 10000
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY = process.env.GAS_KEY || '';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || '';
const PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';

// ---------------- app ----------------
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
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*'); // safe for this bridge; tighten later if desired
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,MCP-Protocol-Version,MCP-Client,X-Requested-With,Authorization'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '2mb' }));

// ---- helpers ---------------------------------------------------
function authMcp(req) {
  // token comes on the query string:  /mcp?token=...
  const t = (req.query.token || '').toString();
  if (!BRIDGE_API_KEY) return { ok: false, code: 500, msg: 'Server missing BRIDGE_API_KEY' };
  if (!t || t !== BRIDGE_API_KEY) return { ok: false, code: 401, msg: 'Invalid or missing token' };
  return { ok: true };
}

function jsonrpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonrpcErr(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

async function gasCall(action, params) {
  if (!GAS_BASE_URL || !GAS_KEY) {
    throw new Error('Server missing GAS_BASE_URL or GAS_KEY');
  }
  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('key', GAS_KEY);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { method: 'GET' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'GAS error');
  return j.data || j; // Apps Script wrapper returns { ok, data: {...} }
}

// ---- health ----------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- simple REST (debug smoke tests) ---------------------------
function requireKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.api_key;
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok: false, error: 'Server missing BRIDGE_API_KEY' });
  if (k !== BRIDGE_API_KEY) return res.status(401).json({ ok: false, error: 'Missing or invalid x-api-key' });
  next();
}

app.get('/search', requireKey, async (req, res) => {
  try {
    const { q = '', max = 5 } = req.query;
    const data = await gasCall('search', { q, max });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/fetch', requireKey, async (req, res) => {
  try {
    const { id, lines } = req.query;
    if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });
    const data = await gasCall('fetch', { id, lines });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- MCP Streamable HTTP --------------------------------------
// GET /mcp  -> SSE that returns the URL to post JSON-RPC messages
app.get('/mcp', (req, res) => {
  const a = authMcp(req);
  if (!a.ok) return res.status(a.code).end(a.msg);

  // SSE setup
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const base = `${req.protocol}://${req.get('host')}`;
  const messages = `${base}/mcp/messages?token=${encodeURIComponent(req.query.token)}`;

  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ messages })}\n\n`);
  const keepalive = setInterval(() => res.write(`: keepalive\n\n`), 25000);

  req.on('close', () => clearInterval(keepalive));
});

// POST /mcp/messages -> JSON-RPC 2.0 requests
app.post('/mcp/messages', async (req, res) => {
  const a = authMcp(req);
  if (!a.ok) return res.status(a.code).json({ ok: false, error: a.msg });

  try {
    const { id, method, params = {} } = req.body || {};
    if (!id) return res.json(jsonrpcErr(null, -32600, 'Missing id'));
    if (!method) return res.json(jsonrpcErr(id, -32601, 'Missing method'));

    // ---- initialize (MCP lifecycle)
    if (method === 'initialize') {
      // MCP requires the server to report supported capabilities
      // Include tools capability so ChatGPT registers our tools.
      return res.json(
        jsonrpcOk(id, {
          protocolVersion: PROTOCOL,
          capabilities: {
            tools: { listChanged: true }
          },
          serverInfo: { name: 'yfl-mcp-bridge', version: '1.0.0' }
        })
      );
    }

    // ---- tools/list (include annotations so ChatGPT can treat them as READ)
    if (method === 'tools/list') {
      const tools = [
        {
          name: 'drive_search',
          description: 'Search Drive by title',
          inputSchema: {
            type: 'object',
            properties: {
              q: { type: 'string' },
              max: { type: 'number' }
            }
          },
          // <<< IMPORTANT >>> mark read-only so ChatGPT doesn’t gate it as WRITE
          annotations: {
            readOnlyHint: true,
            idempotentHint: true
          }
        },
        {
          name: 'drive_fetch',
          description: 'Fetch a Drive file by id',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              lines: { type: 'number' }
            }
          },
          annotations: {
            readOnlyHint: true,
            idempotentHint: true
          }
        }
      ];
      return res.json(jsonrpcOk(id, { tools }));
    }

    // ---- tools/call
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      if (name === 'drive_search') {
        const { q = '', max = 5 } = args;
        const data = await gasCall('search', { q, max });
        return res.json(
          jsonrpcOk(id, {
            content: [{ type: 'json', json: data }]
          })
        );
      }
      if (name === 'drive_fetch') {
        const { id: fileId, lines } = args;
        if (!fileId) return res.json(jsonrpcErr(id, -32602, 'Missing id'));
        const data = await gasCall('fetch', { id: fileId, lines });
        // If GAS returned inline text, surface as text; else surface JSON
        const payload =
          data && data.data && data.data.inline && typeof data.data.text === 'string'
            ? [{ type: 'text', text: data.data.text }]
            : [{ type: 'json', json: data }];
        return res.json(jsonrpcOk(id, { content: payload }));
      }
      return res.json(jsonrpcErr(id, -32601, 'Unknown tool'));
    }

    return res.json(jsonrpcErr(id, -32601, 'Unknown method'));
  } catch (err) {
    return res.json(jsonrpcErr(req.body?.id ?? null, -32000, 'Internal error', String(err?.message || err)));
  }
});

// (Optional convenience) also accept direct POST /mcp for JSON-RPC
app.post('/mcp', async (req, res) => {
  req.url = '/mcp/messages' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  app._router.handle(req, res);
});

// ---------------- start ----------------
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
