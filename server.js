// YFL MCP Bridge — HTTP transport + Apps Script proxy
// ESM syntax (Node >= 18)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ---------------- env ----------------
const PORT          = process.env.PORT || 10000;    // Render injects 10000
const GAS_BASE_URL  = process.env.GAS_BASE_URL || '';
const GAS_KEY       = process.env.GAS_KEY || '';
const BRIDGE_API_KEY= process.env.BRIDGE_API_KEY || '';
const PROTOCOL      = process.env.MCP_PROTOCOL || '2024-11-05'; // MCP protocol version

// ---------------- app ----------------
const app = express();

// CORS: allow ChatGPT & local dev
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
    // Relaxed for this bridge; tighten later if you like
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,MCP-Protocol-Version,MCP-Client,X-Requested-With,Authorization'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// -------- helpers --------
function jsonrpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonrpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id,
    error: { code, message, ...(data ? { data } : {}) } };
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
  return j.data ?? j; // your Apps Script returns { ok, data }
}

// ---- simple API key check (protects friendly endpoints) ----
function requireKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.api_key;
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok:false, error:'Missing BRIDGE_API_KEY on server' });
  if (k !== BRIDGE_API_KEY) return res.status(401).json({ ok:false, error:'Missing or invalid x-api-key' });
  next();
}

// ---------------- health ----------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ------------- SSE discovery (optional but supported) -------------
// GET /mcp with Accept: text/event-stream
app.get('/mcp', (req, res) => {
  if (req.headers.accept !== 'text/event-stream') {
    return res.status(400).send('Expected Accept: text/event-stream');
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const base = `${req.protocol}://${req.get('host')}`;
  const token = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';
  const messages = `${base}/mcp/messages${token}`;

  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ messages })}\n\n`);

  // keep-alive
  const t = setInterval(() => res.write(': keepalive\n\n'), 15000);
  req.on('close', () => clearInterval(t));
});

// ------------- MCP HTTP transport -------------
async function handleMcp(req, res) {
  try {
    const hdrProto = req.headers['mcp-protocol-version']; // optional
    const { id, method, params } = req.body || {};
    if (!method) {
      return res.json(jsonrpcError(null, -32600, 'Invalid Request'));
    }

    // --- initialize ---
    if (method === 'initialize') {
      // Spec requires: protocolVersion, serverInfo, capabilities
      // https://modelcontextprotocol.io/specification/draft/schema (InitializeResult)
      const result = {
        protocolVersion: PROTOCOL,
        serverInfo: { name: 'yfl-mcp-bridge', version: '1.0.0' },
        capabilities: { tools: {} },
        // Optional: brief instructions to help the model
        instructions: 'This server exposes tools to search and fetch files from Google Drive via an Apps Script proxy.'
      };
      return res.json(jsonrpcResult(id ?? null, result));
    }

    // --- tools/list ---
    if (method === 'tools/list') {
      const tools = [
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
      ];
      return res.json(jsonrpcResult(id ?? null, { tools }));
    }

    // --- tools/call ---
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};

      if (name === 'drive_search') {
        const q   = String(args.q ?? '');
        const max = Number.isFinite(args.max) ? args.max : 5;
        const data = await gasCall('search', { q, max });
        return res.json(jsonrpcResult(id ?? null, {
          content: [{ type: 'json', json: data }]
        }));
      }

      if (name === 'drive_fetch') {
        const idArg = String(args.id ?? '');
        const lines = Number.isFinite(args.lines) ? args.lines : 0;
        if (!idArg) {
          return res.json(jsonrpcError(id ?? null, -32602, 'Missing id'));
        }
        const data = await gasCall('fetch', { id: idArg, lines });
        // Prefer inline text as "text" content; otherwise return JSON blob
        if (data?.data?.inline && typeof data?.data?.text === 'string') {
          return res.json(jsonrpcResult(id ?? null, {
            content: [{ type: 'text', text: data.data.text }]
          }));
        }
        return res.json(jsonrpcResult(id ?? null, {
          content: [{ type: 'json', json: data }]
        }));
      }

      return res.json(jsonrpcError(id ?? null, -32601, 'Unknown tool'));
    }

    // Unknown method
    return res.json(jsonrpcError(id ?? null, -32601, 'Unknown method'));
  } catch (err) {
    return res.json(jsonrpcError(req.body?.id ?? null, -32000, 'Internal error', String(err?.message || err)));
  }
}

// HTTP transport entry points
app.post('/mcp', handleMcp);
app.post('/mcp/messages', handleMcp);

// ---------------- Friendly REST endpoints (smoke tests) ----------------
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
    const { id, lines = 0 } = req.query;
    if (!id) return res.status(400).json({ ok:false, error:'Missing id' });
    const data = await gasCall('fetch', { id, lines });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ------------- start -------------
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
