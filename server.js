// YFL MCP Drive Bridge — unified Streamable HTTP + SSE + JSON-RPC 2.0
// ESM syntax, Node >= 18

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.set('trust proxy', 1);                  // behind Render/Cloudflare -> correct https
app.use(express.json({ limit: '1mb' }));

// ---- CORS & preflight (permit MCP headers) ----
const ALLOW_ORIGINS = new Set([
  'https://chat.openai.com',
  'https://chatgpt.com',
  'https://stg.chat.openai.com',
  'http://localhost:5173',
  'http://localhost:3000',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', origin && ALLOW_ORIGINS.has(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization,X-Requested-With,X-Api-Key,MCP-Protocol-Version,MCP-Client'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

const PORT            = process.env.PORT || 10000;          // Render injects 10000
const PROTOCOL        = process.env.MCP_PROTOCOL || '2024-11-05';
const GAS_BASE_URL    = process.env.GAS_BASE_URL || '';
const GAS_KEY         = process.env.GAS_KEY || '';
const BRIDGE_API_KEY  = process.env.BRIDGE_API_KEY || '';    // protects REST probes
const BRIDGE_TOKEN    = process.env.BRIDGE_TOKEN || BRIDGE_API_KEY; // optional token for /mcp

// ---- helpers ----
function tokenFrom(req) {
  const q    = (req.query.token || '').trim();
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const x    = (req.headers['x-api-key'] || '').trim();
  return q || auth || x || '';
}
function requireHeaderKey(req, res, next) {
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok:false, error: 'Server missing BRIDGE_API_KEY' });
  const k = tokenFrom(req);
  if (k !== BRIDGE_API_KEY) return res.status(401).json({ ok:false, error: 'unauthorized' });
  next();
}
function absoluteMcpUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('host');
  const u = new URL(`${proto}://${host}/mcp`);
  if (BRIDGE_TOKEN) u.searchParams.set('token', BRIDGE_TOKEN);
  return u.toString();
}
async function gasCall(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('Server missing GAS_BASE_URL or GAS_KEY');
  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('key', GAS_KEY);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { method: 'GET' });
  const j = await r.json();
  if (!j?.ok) throw new Error(j?.error || 'GAS error');
  return j; // shape often { ok:true, data:{ ok:true, data:{…} } }
}
const unwrap = (j) => j?.data?.data ?? j?.data ?? j;

// ---- health & debug ----
app.get('/health', (_req, res) => res.json({ ok:true, uptime: process.uptime() }));
app.get('/__routes', (_req, res) => {
  const routes = [];
  app._router.stack.forEach((m) => {
    if (m.route && m.route.path) routes.push({ methods: Object.keys(m.route.methods), path: m.route.path });
  });
  res.json({ ok:true, routes });
});

// ---- friendly REST probes (x-api-key guard) ----
app.get('/search', requireHeaderKey, async (req, res) => {
  try {
    const q   = String(req.query.q ?? '');
    const max = Number(req.query.max ?? 10);
    const j   = await gasCall('search', { q, max });
    res.json({ ok:true, data: unwrap(j) });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});
app.get('/fetch', requireHeaderKey, async (req, res) => {
  try {
    const id    = String(req.query.id ?? '');
    const lines = req.query.lines ? Number(req.query.lines) : undefined;
    if (!id) return res.status(400).json({ ok:false, error: 'Missing id' });
    const j = await gasCall('fetch', { id, lines });
    res.json({ ok:true, data: unwrap(j) });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

// ---- minimal SSE handshake on GET /mcp ----
app.get('/mcp', (req, res) => {
  if (BRIDGE_TOKEN && tokenFrom(req) !== BRIDGE_TOKEN) {
    return res.status(401).end('unauthorized');
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  // Tell clients where to POST JSON-RPC
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ url: absoluteMcpUrl(req) })}\n\n`);
  const t = setInterval(() => res.write(`: keepalive\n\n`), 30000);
  req.on('close', () => clearInterval(t));
});

// ---- JSON-RPC 2.0 on POST /mcp (and alias /mcp/messages) ----
function ok(id, result)  { return { jsonrpc: '2.0', id, result }; }
function err(id, code, message, data=null) { return { jsonrpc:'2.0', id, error:{ code, message, data } }; }

async function handleMcp(req, res) {
  if (BRIDGE_TOKEN && tokenFrom(req) !== BRIDGE_TOKEN) {
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }
  const body = req.body;
  const batch = Array.isArray(body) ? body : [body];

  const results = await Promise.all(batch.map(async (msg) => {
    try {
      const { id = null, method, params = {} } = msg || {};

      if (method === 'initialize') {
        return ok(id, {
          protocolVersion: PROTOCOL,
          serverInfo: { name: 'YFL MCP Drive Bridge', version: '1.0.0' },
          capabilities: { tools: { listChanged: true } }
        });
      }

      if (method === 'tools/list') {
        return ok(id, {
          tools: [
            // Canonical names ChatGPT expects:
            { name: 'search',
              description: 'Search Google Drive by filename (contains).',
              inputSchema: { type:'object', properties:{ q:{type:'string'}, max:{type:'number'} } } },
            { name: 'fetch',
              description: 'Fetch a Drive file by id; text for text/CSV/Docs (optionally limited by lines) or metadata link for binaries.',
              inputSchema: { type:'object', properties:{ id:{type:'string'}, lines:{type:'number'} }, required:['id'] } },

            // Back-compat aliases you were using during bring‑up:
            { name: 'drive_search',
              description: '[alias] Search Drive by title.',
              inputSchema: { type:'object', properties:{ q:{type:'string'}, max:{type:'number'} } } },
            { name: 'drive_fetch',
              description: '[alias] Fetch Drive file by id.',
              inputSchema: { type:'object', properties:{ id:{type:'string'}, lines:{type:'number'} }, required:['id'] } },
          ]
        });
      }

      if (method === 'tools/call') {
        const { name, arguments: args = {} } = params;

        if (name === 'search' || name === 'drive_search') {
          const { q = '', max = 10 } = args;
          const j = await gasCall('search', { q, max });
          const payload = unwrap(j);
          return ok(id, { content: [{ type: 'json', json: payload }] });
        }

        if (name === 'fetch' || name === 'drive_fetch') {
          const { id: fid, lines } = args;
          if (!fid) return err(id, -32602, 'Missing id');
          const j = await gasCall('fetch', { id: fid, lines });
          const d = unwrap(j);
          if (d?.text) {
            return ok(id, { content: [{ type: 'text', text: d.text }] });
          }
          return ok(id, { content: [{ type: 'json', json: d }] });
        }

        return err(id, -32601, `Unknown tool: ${name}`);
      }

      return err(id, -32601, `Method not found: ${method}`);
    } catch (e) {
      return err(msg?.id ?? null, -32000, String(e?.message || e), { stack: String(e?.stack || '') });
    }
  }));

  return res.json(Array.isArray(body) ? results : results[0]);
}
app.post('/mcp', handleMcp);
app.post('/mcp/messages', handleMcp);   // compatibility alias

// ---- start ----
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
