// server.js  (ESM)
// YFL MCP Bridge — HTTP transport + Apps Script proxy
// Implements MCP JSON-RPC over HTTP (SSE + /mcp/messages), plus simple smoke-test routes.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ---------------- env ----------------
const PORT         = process.env.PORT || 10000;   // Render injects 10000
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY      = process.env.GAS_KEY || '';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || '';
const PROTOCOL     = process.env.MCP_PROTOCOL || '2024-11-05'; // matches spec date

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
    // Permissive (works fine for this bridge; tighten later if you want)
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type,MCP-Protocol-Version,MCP-Client,X-Requested-With,Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json());

// ---------------- utils ----------------
function requireKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.api_key;
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok:false, error: 'Server missing BRIDGE_API_KEY' });
  if (k !== BRIDGE_API_KEY) return res.status(401).json({ ok:false, error:'Missing or invalid x-api-key' });
  next();
}

async function gasCall(action, params) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('Server missing GAS_BASE_URL or GAS_KEY');
  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('key', GAS_KEY);
  for (const [k,v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { method: 'GET' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'GAS error');
  return j;
}

// Normalize search result to a compact JSON payload ChatGPT can display
function normalizeSearchPayload(j) {
  // your GAS returns { ok:true, data:{ query, count, files:[...] } }
  const data = (j && j.data) ? j.data : {};
  const files = Array.isArray(data.files) ? data.files : [];
  // Keep only the columns the UI usually needs (id, name, mimeType, lastUpdated, url)
  const out = files.map(f => ({
    id: f.id, name: f.name, mimeType: f.mimeType,
    lastUpdated: f.lastUpdated, url: f.url
  }));
  return { query: data.query || '', count: data.count || out.length, files: out };
}

// ---------------- health + smoke tests ----------------
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/search', requireKey, async (req, res) => {
  try {
    const { q = '', max = 5 } = req.query;
    const j = await gasCall('search', { q, max });
    res.json({ ok: true, data: normalizeSearchPayload(j) });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

app.get('/fetch', requireKey, async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ ok:false, error:'Missing id' });
    const data = await gasCall('fetch', { id });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// ---------------- MCP: JSON-RPC ----------------
function jsonrpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonrpcErr(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// Handle JSON-RPC calls (initialize, tools/list, tools/call)
async function handleMcp(req, res) {
  try {
    const id = req.body?.id ?? null;
    const method = req.body?.method ?? '';
    const params = req.body?.params ?? {};

    // initialize
    if (method === 'initialize') {
      return res.json(jsonrpcOk(id, { protocolVersion: PROTOCOL }));
    }

    // tools/list
    if (method === 'tools/list') {
      return res.json(jsonrpcOk(id, {
        tools: [
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
        ]
      }));
    }

    // tools/call
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      if (name === 'drive_search') {
        const q   = String(args.q || '');
        const max = Number.isFinite(+args.max) ? +args.max : 5;
        const j = await gasCall('search', { q, max });
        const payload = normalizeSearchPayload(j);
        return res.json(jsonrpcOk(id, { content: [{ type: 'json', json: payload }] }));
      }
      if (name === 'drive_fetch') {
        const idArg  = String(args.id || '').trim();
        const lines  = Number.isFinite(+args.lines) ? +args.lines : undefined;
        if (!idArg) return res.json(jsonrpcErr(id, -32602, 'Missing "id"'));
        const j = await gasCall('fetch', { id: idArg, lines });
        // If GAS returned inline text we show it; otherwise show the JSON
        const asText = j?.data?.text;
        if (typeof asText === 'string') {
          return res.json(jsonrpcOk(id, { content: [{ type: 'text', text: asText }] }));
        }
        return res.json(jsonrpcOk(id, { content: [{ type: 'json', json: j?.data ?? j }] }));
      }
      return res.json(jsonrpcErr(id, -32601, `Unknown tool: ${name}`));
    }

    return res.json(jsonrpcErr(id, -32601, 'Unknown method'));
  } catch (err) {
    return res.json(jsonrpcErr(req.body?.id ?? null, -32000, String(err?.message || err)));
  }
}

// SSE handshake (2024‑11‑05)
app.get('/mcp', (req, res) => {
  // If the client asked for SSE, return endpoint; otherwise allow POST fallback
  const accept = String(req.headers.accept || '');
  if (!accept.includes('text/event-stream')) return res.status(405).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'keep-alive');

  const endpoint = new URL('/mcp/messages', `${req.protocol}://${req.get('host')}`).toString();
  const token = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ messages: endpoint + token })}\n\n`);

  const timer = setInterval(() => res.write(`: keepalive\n\n`), 20000);
  req.on('close', () => clearInterval(timer));
});

// JSON‑RPC message channel
app.post('/mcp/messages', handleMcp);

// Start
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
