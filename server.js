// YFL MCP Bridge — Streamable HTTP + JSON-RPC proxy to Apps Script
// Node >= 18, ESM syntax

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ---------------- env ----------------
const PORT            = process.env.PORT || 10000;                // Render injects 10000
const GAS_BASE_URL    = process.env.GAS_BASE_URL || '';           // e.g. https://script.google.com/macros/s/<DEPLOY>/exec
const GAS_KEY         = process.env.GAS_KEY || '';                // shared token for Apps Script
const BRIDGE_API_KEY  = process.env.BRIDGE_API_KEY || process.env.TOKEN || ''; // shared token for this bridge
const PROTOCOL        = process.env.MCP_PROTOCOL || '2024-11-05'; // MCP protocol version

if (!GAS_BASE_URL) {
  console.warn('[warn] GAS_BASE_URL is not set. Search/fetch will fail.');
}

// ---------------- app ----------------
const app = express();

// behind Render/Cloudflare reverse proxy: ensure correct protocol/host
app.set('trust proxy', true);

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
    // permissive for dev; tighten later if desired
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,MCP-Protocol-Version,Authorization,X-Requested-With'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '1mb' }));

// ---------------- health ----------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------------- auth helpers ----------------
function getTokenFromReq(req) {
  const urlToken = req.query.token;
  const hdr = req.headers['authorization'];
  const bearer = hdr && hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  const xKey = req.headers['x-api-key'];
  return urlToken || bearer || xKey || '';
}

function requireAuth(req, res, next) {
  if (!BRIDGE_API_KEY) return next(); // auth disabled
  const provided = getTokenFromReq(req);
  if (provided && provided === BRIDGE_API_KEY) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// ---------------- simple REST probes (optional) ----------------
app.get('/search', requireAuth, async (req, res) => {
  try {
    const q   = String(req.query.q ?? '');
    const max = Number(req.query.max ?? 25);
    const url = `${GAS_BASE_URL}/api/search?q=${encodeURIComponent(q)}&max=${max}&token=${encodeURIComponent(GAS_KEY)}`;
    const r   = await fetch(url);
    const j   = await r.json();
    return res.json({ ok: true, data: j?.data ?? j });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/fetch', requireAuth, async (req, res) => {
  try {
    const id    = String(req.query.id ?? '');
    const lines = req.query.lines ?? '';
    if (!id) return res.status(400).json({ ok:false, error:'missing id' });
    const url   = `${GAS_BASE_URL}/api/fetch?id=${encodeURIComponent(id)}${lines ? `&lines=${lines}` : ''}&token=${encodeURIComponent(GAS_KEY)}`;
    const r     = await fetch(url);
    const j     = await r.json();
    return res.json({ ok: true, data: j?.data ?? j });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------------- MCP JSON-RPC helpers ----------------
const ok  = (id, result)                   => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message, data=null) => ({ jsonrpc: '2.0', id, error: { code, message, data } });

// Tool metadata: mark read-only so ChatGPT can call them without interactive gating
const TOOL_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };

function listTools() {
  return [
    {
      name: 'search',
      description: 'Search Google Drive by file title.',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' }, max: { type: 'number' } }
      },
      annotations: TOOL_ANNOTATIONS
    },
    {
      name: 'fetch',
      description: 'Fetch a Google Drive file by id. If text, returns inline text.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, lines: { type: 'number' } }
      },
      annotations: TOOL_ANNOTATIONS
    },
    // aliases you’ve been using
    {
      name: 'drive_search',
      description: 'Search Google Drive by file title.',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' }, max: { type: 'number' } }
      },
      annotations: TOOL_ANNOTATIONS
    },
    {
      name: 'drive_fetch',
      description: 'Fetch a Google Drive file by id. If text, returns inline text.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, lines: { type: 'number' } }
      },
      annotations: TOOL_ANNOTATIONS
    }
  ];
}

async function callTool(name, args) {
  if (name === 'search' || name === 'drive_search') {
    const q   = String(args?.q ?? '');
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

    // Prefer inline text when Apps Script provides it
    if (j?.data?.inline && j?.data?.text) return [{ type: 'text', text: j.data.text }];
    return [{ type: 'json', json: j?.data ?? j }];
  }

  throw Object.assign(new Error('Unknown tool'), { code: -32601 });
}

async function handleMcp(req, res) {
  try {
    // (Optional) validate header per spec: MCP-Protocol-Version
    // Clients send MCP-Protocol-Version; servers should tolerate unknown versions.
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

// POST endpoints (require auth)
app.post('/mcp', requireAuth, handleMcp);
app.post('/mcp/messages', requireAuth, handleMcp);

// GET /mcp — SSE discovery for Streamable HTTP transport.
// Must emit `event: endpoint` with the POST URL. Keep token if present.
app.get('/mcp', (req, res) => {
  // auth for GET is optional; we only advertise the POST URL
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');

  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host  = req.get('host');
  const qs    = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  const messagesUrl = `${proto}://${host}/mcp${qs}`;

  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ messages: messagesUrl })}\n\n`);

  const t = setInterval(() => res.write(': keepalive\n\n'), 30000);
  req.on('close', () => clearInterval(t));
});

// ---------------- start ----------------
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
