// server.mjs
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// ---- env ----
const PORT = process.env.PORT || 3332;
const GAS_BASE_URL = process.env.GAS_BASE_URL;   // e.g. https://script.google.com/.../exec
const GAS_KEY      = process.env.GAS_KEY;        // your Apps Script shared key
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY; // your local/connector shared key

// ---- guards ----
function requireHeaderKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.api_key;
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok:false, error:'Server missing BRIDGE_API_KEY' });
  if (k !== BRIDGE_API_KEY) return res.status(401).json({ ok:false, error:'Missing or invalid x-api-key' });
  next();
}
function requireTokenQuery(req, res, next) {
  const t = req.query.token || req.query.tk || '';
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok:false, error:'Server missing BRIDGE_API_KEY' });
  if (t !== BRIDGE_API_KEY) return res.status(401).json({ ok:false, error:'Missing or invalid token' });
  next();
}

// ---- Apps Script call helper ----
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

// ---------------- Basic health & debug ----------------
app.get('/health', (_req, res) => res.json({ ok:true, uptime: process.uptime() }));
app.get('/__routes', (_req, res) => {
  const routes = [];
  app._router.stack.forEach((m) => {
    if (m.route && m.route.path) {
      const methods = Object.keys(m.route.methods).map(x => x.toUpperCase());
      routes.push({ methods, path: m.route.path });
    }
  });
  res.json({ ok:true, routes });
});

// ---------------- Friendly test endpoints -------------
app.get('/search', requireHeaderKey, async (req, res) => {
  try {
    const { q = '', max = 5 } = req.query;
    const data = await gasCall('search', { q, max });
    res.json({ ok:true, data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get('/fetch', requireHeaderKey, async (req, res) => {
  try {
    const { id, lines } = req.query;
    if (!id) return res.status(400).json({ ok:false, error:'Missing id' });
    const data = await gasCall('fetch', { id, lines });
    res.json({ ok:true, data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ---------------- MCP: SSE endpoint -------------------
// GET /mcp?token=...    (Accept: text/event-stream)
app.get('/mcp', requireTokenQuery, (req, res) => {
  const acceptsSSE = (req.get('accept') || '').includes('text/event-stream');

  // Helpful message if you hit it in a browser
  if (!acceptsSSE) {
    return res
      .status(200)
      .json({ ok:false, hint: 'This is an SSE endpoint. Use Accept: text/event-stream. For JSON-RPC use POST /mcp/messages.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const base = `${req.protocol}://${req.get('host')}`;
  const endpoint = `${base}/mcp/messages?token=${encodeURIComponent(req.query.token)}`;

  // Send the required "endpoint" event so the client knows where to POST JSON-RPC
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ url: endpoint })}\n\n`);

  // Keep-alive ping (optional)
  const timer = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 15000);
  req.on('close', () => clearInterval(timer));
});

// ---------------- MCP: JSON-RPC endpoint --------------
app.post('/mcp/messages', requireTokenQuery, express.json(), async (req, res) => {
  try {
    const msg = req.body || {};
    const { id = null, method = '', params = {} } = msg;

    const respond = (result) => res.json({ jsonrpc: '2.0', id, result });
    const err = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

    if (method === 'initialize') {
      return respond({
        protocolVersion: '2024-11-05',
        capabilities: { tools: { list: true, call: true } }
      });
    }

    if (method === 'tools/list') {
      return respond({
        tools: [
          { name: 'drive_search', description: 'Search Drive by title/filters', inputSchema: { type:'object', properties: { q:{type:'string'}, max:{type:'number'} } } },
          { name: 'drive_fetch',  description: 'Fetch a Drive file by id',       inputSchema: { type:'object', properties: { id:{type:'string'}, lines:{type:'number'} } } }
        ]
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      if (name === 'drive_search') {
        const { q = '', max = 5 } = args;
        const data = await gasCall('search', { q, max });
        return respond({ content: data });
      }
      if (name === 'drive_fetch') {
        const { id, lines } = args;
        if (!id) return err(-32602, 'Missing id');
        const data = await gasCall('fetch', { id, lines });
        return respond({ content: data });
      }
      return err(-32601, `Unknown tool: ${name}`);
    }

    return err(-32601, `Unknown method: ${method}`);
  } catch (e) {
    return res.json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32000, message: String(e.message || e) } });
  }
});

// --------------- start server (Render needs 0.0.0.0) ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`YFL bridge listening on http://0.0.0.0:${PORT}`);
});
