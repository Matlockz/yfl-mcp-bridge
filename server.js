// YFL MCP Drive Bridge — Streamable HTTP + JSON-RPC
// ESM syntax (Node >= 18)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ---------- env ----------
const PORT           = process.env.PORT || 10000;
const GAS_BASE_URL   = process.env.GAS_BASE_URL || '';
const GAS_KEY        = process.env.GAS_KEY || '';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || '';
const PROTOCOL       = process.env.MCP_PROTOCOL || '2024-11-05';

// ---------- app ----------
const app = express();

// IMPORTANT: we’re behind Render’s proxy. This makes req.protocol honor X-Forwarded-Proto.
app.set('trust proxy', true); // so req.protocol becomes "https" on Render.  ← FIX

// CORS: allow ChatGPT (and fall back to *)
const ALLOW_ORIGINS = new Set([
  'https://chat.openai.com',
  'https://chatgpt.com',
  'https://stg.chat.openai.com',
  'http://localhost:5173',
  'http://localhost:3000',
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // Allow MCP headers so preflight passes.
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,MCP-Protocol-Version,MCP-Client,X-Requested-With,Authorization'
  );
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '1mb' }));

// ---------- health ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- simple REST probes (protected by x-api-key) ----------
const requireKey = (req, res, next) => {
  if (!BRIDGE_API_KEY) {
    return res.status(500).json({ ok: false, error: 'missing BRIDGE_API_KEY' });
  }
  const k = req.headers['x-api-key'];
  if (k !== BRIDGE_API_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
};

app.get('/search', requireKey, async (req, res) => {
  const q   = req.query.q ?? '';
  const max = Number(req.query.max ?? 25);
  const url = `${GAS_BASE_URL}/api/search?q=${encodeURIComponent(q)}&max=${max}&token=${encodeURIComponent(GAS_KEY)}`;
  const r   = await fetch(url);
  const j   = await r.json();
  res.json({ ok: true, data: j.data ?? j });
});

app.get('/fetch', requireKey, async (req, res) => {
  const id    = String(req.query.id ?? '');
  const lines = req.query.lines ?? '';
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const url   = `${GAS_BASE_URL}/api/fetch?id=${encodeURIComponent(id)}${lines ? `&lines=${lines}` : ''}&token=${encodeURIComponent(GAS_KEY)}`;
  const r     = await fetch(url);
  const j     = await r.json();
  res.json({ ok: true, data: j.data ?? j });
});

// ---------- MCP helpers ----------
const ok  = (id, result)                   => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message, data=null) => ({ jsonrpc: '2.0', id, error: { code, message, data } });

function listTools() {
  // Mark tools read-only so ChatGPT won’t block them in non-interactive turns.
  const annotations = { readOnlyHint: true, openWorldHint: true };

  return [
    // Canonical names:
    {
      name: 'search',
      description: 'Search Google Drive by file title.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' }, max: { type: 'number' } } },
      annotations
    },
    {
      name: 'fetch',
      description: 'Fetch a Google Drive file by id. If text, returns inline text.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number' } } },
      annotations
    },
    // Back-compat aliases:
    {
      name: 'drive_search',
      description: 'Search Google Drive by file title.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' }, max: { type: 'number' } } },
      annotations
    },
    {
      name: 'drive_fetch',
      description: 'Fetch a Google Drive file by id. If text, returns inline text.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number' } } },
      annotations
    },
  ];
}

async function callTool(name, args) {
  if (name === 'search' || name === 'drive_search') {
    const q   = args?.q ?? '';
    const max = Number(args?.max ?? 25);
    const url = `${GAS_BASE_URL}/api/search?q=${encodeURIComponent(q)}&max=${max}&token=${encodeURIComponent(GAS_KEY)}`;
    const r   = await fetch(url);
    const j   = await r.json();
    return [{ type: 'json', json: j?.data ?? j }];
  }

  if (name === 'fetch' || name === 'drive_fetch') {
    const id    = String(args?.id ?? '');
    const lines = args?.lines ?? '';
    if (!id) return [{ type: 'text', text: 'Missing "id" argument.' }];
    const url = `${GAS_BASE_URL}/api/fetch?id=${encodeURIComponent(id)}${lines ? `&lines=${lines}` : ''}&token=${encodeURIComponent(GAS_KEY)}`;
    const r   = await fetch(url);
    const j   = await r.json();
    if (j?.data?.inline && j?.data?.text) return [{ type: 'text', text: j.data.text }];
    return [{ type: 'json', json: j?.data ?? j }];
  }

  throw Object.assign(new Error('Unknown tool'), { code: -32601 });
}

async function handleMcp(req, res) {
  try {
    const { id, method, params } = req.body || {};

    if (method === 'initialize') {
      return res.json(ok(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} } }));
    }

    if (method === 'tools/list') {
      return res.json(ok(id, { tools: listTools() }));
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const content = await callTool(name, args || {});
      return res.json(ok(id, { content }));
    }

    return res.json(err(id ?? null, -32601, 'Unknown method'));
  } catch (e) {
    return res.json(err(req.body?.id ?? null, -32000, String(e?.message || e), { stack: e?.stack }));
  }
}

// POST /mcp  (messages endpoint)
app.post('/mcp', handleMcp);

// also accept legacy messages path if you need it
app.post('/mcp/messages', handleMcp);

// Minimal GET /mcp SSE for discovery/keepalive
app.get('/mcp', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8'); // SSE content type
  res.setHeader('Cache-Control', 'no-cache');

  // Build a correct absolute URL for the messages endpoint.
  const host = req.get('host') || '';
  const isLocal = /^localhost(?::\d+)?$/.test(host);
  const protoFromHeader = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim().toLowerCase();
  const scheme = isLocal ? 'http' : (protoFromHeader || req.protocol || 'https'); // https on Render

  const base = `${scheme}://${host}`;
  const endpoint = `${base}/mcp`; // this server’s messages endpoint

  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ messages: endpoint })}\n\n`);

  // Keep the connection alive
  const t = setInterval(() => res.write(': keepalive\n\n'), 30000); // SSE "comment" keepalive
  req.on('close', () => clearInterval(t));
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
