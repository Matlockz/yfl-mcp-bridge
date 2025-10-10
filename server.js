// YFL MCP Drive Bridge — Streamable HTTP + JSON-RPC 2.0
// Node >= 18, ESM

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ---------- config ----------
const PORT          = process.env.PORT || 10000;
const PROTOCOL      = process.env.MCP_PROTOCOL || '2024-11-05';

// Google Apps Script backend
const GAS_BASE_URL  = process.env.GAS_BASE_URL || process.env.GAS_BASE || '';
const GAS_KEY       = process.env.GAS_KEY || process.env.TOKEN || '';

// Optional probes key
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || process.env.BRIDGE_APT_KEY || '';

// Token protecting the MCP endpoint (recommended)
const BRIDGE_TOKEN  = process.env.BRIDGE_TOKEN || process.env.TOKEN || '';

// ---------- app ----------
const app = express();
app.set('trust proxy', true);                          // so req.protocol honors X-Forwarded-Proto
app.use(express.json({ limit: '1mb' }));

// CORS + preflight: include MCP headers
const ALLOW_ORIGINS = new Set([
  'https://chat.openai.com',
  'https://chatgpt.com',
  'https://stg.chat.openai.com',
  'http://localhost:5173',
  'http://localhost:3000',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', origin && ALLOW_ORIGINS.has(origin) ? origin : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,HEAD');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type,MCP-Protocol-Version,MCP-Client,X-Requested-With,Authorization'
  );
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---------- helpers ----------
const ok  = (id, result)                   => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message, data=null) => ({ jsonrpc: '2.0', id, error: { code, message, data } });

function absoluteMessagesUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('host');
  const base  = `${proto}://${host}/mcp`;
  if (BRIDGE_TOKEN) {
    const u = new URL(base);
    u.searchParams.set('token', BRIDGE_TOKEN);
    return u.toString();
  }
  return base;
}

function tokenOK(req) {
  if (!BRIDGE_TOKEN) return true;
  const t = req.query?.token || req.get('x-bridge-token') || '';
  return t === BRIDGE_TOKEN;
}

// Apps Script helpers
async function gasSearch(q = '', max = 25) {
  if (!GAS_BASE_URL) return { files: [] };
  const u = `${GAS_BASE_URL}/api/search?q=${encodeURIComponent(q)}&max=${Number(max)}&token=${encodeURIComponent(GAS_KEY)}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`search failed: ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return j?.data ?? j ?? { files: [] };
}
async function gasFetch(id = '', lines = null) {
  if (!GAS_BASE_URL) return { inline: false, id, text: '' };
  const u = new URL(`${GAS_BASE_URL}/api/fetch`);
  u.searchParams.set('id', id);
  if (lines != null) u.searchParams.set('lines', String(lines));
  u.searchParams.set('token', GAS_KEY);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return j?.data ?? j ?? {};
}

// ---------- health ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- simple REST probes (x-api-key) ----------
function requireKey(req, res, next) {
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok:false, error:'missing BRIDGE_API_KEY' });
  if (req.get('x-api-key') !== BRIDGE_API_KEY) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
}
app.get('/search', requireKey, async (req, res) => {
  try { res.json({ ok: true, data: await gasSearch(req.query.q ?? '', req.query.max ?? 25) }); }
  catch (e) { res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});
app.get('/fetch', requireKey, async (req, res) => {
  try {
    const id = String(req.query.id ?? '');
    const lines = req.query.lines ?? null;
    if (!id) return res.status(400).json({ ok:false, error:'missing id' });
    res.json({ ok: true, data: await gasFetch(id, lines) });
  } catch (e) { res.status(500).json({ ok:false, error:String(e?.message||e) }); }
});

// ---------- MCP tool registry ----------
function listTools() {
  const annotations = { readOnlyHint: true, openWorldHint: true };
  return [
    {
      name: 'search',
      description: 'Search Google Drive by file title.',
      inputSchema: {
        type: 'object',
        properties: {
          q:   { type:'string',  description:'substring to match in title' },
          max: { type:'number',  description:'max results' }
        },
        required: []
      },
      annotations
    },
    {
      name: 'fetch',
      description: 'Fetch a Google Drive file by id; returns inline text when available.',
      inputSchema: {
        type: 'object',
        properties: {
          id:    { type:'string', description:'Drive file id' },
          lines: { type:'number', description:'optional, first N lines for text' }
        },
        required: ['id']
      },
      annotations
    },
    // Back-compat aliases you’ve used in prompts
    { name:'drive_search', description:'Alias of search', inputSchema:{ type:'object', properties:{ q:{type:'string'}, max:{type:'number'}}, required:[] }, annotations },
    { name:'drive_fetch',  description:'Alias of fetch',  inputSchema:{ type:'object', properties:{ id:{type:'string'}, lines:{type:'number'}}, required:['id'] }, annotations }
  ];
}

async function callTool(name, args) {
  if (name === 'search' || name === 'drive_search') {
    const q   = args?.q ?? '';
    const max = Number(args?.max ?? 25);
    return [{ type:'json', json: await gasSearch(q, max) }];
  }
  if (name === 'fetch' || name === 'drive_fetch') {
    const id    = String(args?.id ?? '');
    const lines = args?.lines ?? null;
    if (!id) return [{ type:'text', text:'Missing "id" argument.' }];
    const data = await gasFetch(id, lines);
    return (data?.inline && typeof data?.text === 'string')
      ? [{ type:'text', text:data.text }]
      : [{ type:'json', json:data }];
  }
  throw Object.assign(new Error('Unknown tool'), { code: -32601 });
}

async function handleMcp(req, res) {
  try {
    if (!tokenOK(req)) return res.status(401).json(err(null, 401, 'unauthorized token'));
    const { id, method, params } = req.body || {};

    if (method === 'initialize') {
      return res.json(ok(id, {
        protocolVersion: PROTOCOL,
        serverInfo: { name: 'yfl-mcp-bridge', version: '1.0.0' },
        capabilities: { tools: { listChanged: true } } // spec requires this flag
      }));
    }

    if (method === 'tools/list') return res.json(ok(id, { tools: listTools() }));

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      return res.json(ok(id, { content: await callTool(name, args || {}) }));
    }

    return res.json(err(id ?? null, -32601, 'Unknown method'));
  } catch (e) {
    return res.json(err(req.body?.id ?? null, -32000, String(e?.message || e), { stack: e?.stack }));
  }
}

// Streamable HTTP endpoints
app.post('/mcp', handleMcp);
app.post('/mcp/messages', handleMcp);

// Minimal GET /mcp SSE for discovery + keepalive
app.get('/mcp', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  if (!tokenOK(req)) {
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({ error:'unauthorized token' })}\n\n`);
    return;
  }
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ messages: absoluteMessagesUrl(req) })}\n\n`);
  const t = setInterval(() => res.write(': keepalive\n\n'), 30000);
  req.on('close', () => clearInterval(t));
});
app.head('/mcp', (req, res) => res.status(tokenOK(req) ? 200 : 401).end());

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
