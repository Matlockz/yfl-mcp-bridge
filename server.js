// server.js  (drop-in)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3332;
const GAS_BASE_URL = process.env.GAS_BASE_URL;
const GAS_KEY = process.env.GAS_KEY;
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

// ---- simple API key check for /search & /fetch ----
function requireKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.api_key;
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok:false, error: 'Server missing BRIDGE_API_KEY' });
  if (k !== BRIDGE_API_KEY) return res.status(401).json({ ok:false, error:'Missing or invalid x-api-key' });
  next();
}

// ---- call Apps Script Web App ----
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
  if (!r.ok) throw new Error(`GAS HTTP ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'GAS error');
  return j;
}

// ---- health ----
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- friendly GET endpoints ----
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
    const { id, lines } = req.query;
    if (!id) return res.status(400).json({ ok:false, error:'Missing id' });
    const data = await gasCall('fetch', { id, lines });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ---- MCP over HTTP (SSE + JSON-RPC) ----

// SSE "hello": tells the client where to POST JSON-RPC messages
app.get('/mcp', (req, res) => {
  const token = String(req.query.token || '');
  if (!token || token !== BRIDGE_API_KEY) {
    res.status(401).end('unauthorized');
    return;
  }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  // Tell the client which endpoint to use for JSON-RPC
  const endpoint = `/mcp/messages?token=${encodeURIComponent(token)}`;
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ url: endpoint })}\n\n`);

  // keep-alive pings
  const timer = setInterval(() => res.write(`: ping\n\n`), 25000);
  req.on('close', () => clearInterval(timer));
});

// JSON-RPC messages
app.post('/mcp/messages', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token || token !== BRIDGE_API_KEY) {
      return res.status(401).json({ jsonrpc:'2.0', id: null, error:{ code:401, message:'unauthorized' }});
    }
    const { jsonrpc, id, method, params } = req.body || {};
    if (jsonrpc !== '2.0') {
      return res.status(400).json({ jsonrpc:'2.0', id, error:{ code:-32600, message:'Invalid Request' }});
    }

    if (method === 'initialize') {
      return res.json({ jsonrpc:'2.0', id, result:{ protocolVersion:'2024-11-05' }});
    }

    if (method === 'tools/list') {
      return res.json({
        jsonrpc:'2.0',
        id,
        result:{
          tools:[
            { name:'drive_search', description:'Search Drive by title/filters', inputSchema:{ q:'string', max:'number' } },
            { name:'drive_fetch',  description:'Fetch a Drive file by id',       inputSchema:{ id:'string', lines:'number?' } }
          ]
        }
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      if (name === 'drive_search') {
        const { q = '', max = 5 } = args;
        const data = await gasCall('search', { q, max });
        return res.json({ jsonrpc:'2.0', id, result:{ content:data }});
      }
      if (name === 'drive_fetch') {
        const { id: fid, lines } = args;
        if (!fid) {
          return res.json({ jsonrpc:'2.0', id, error:{ code:-32602, message:'Missing id'}});
        }
        const data = await gasCall('fetch', { id: fid, lines });
        return res.json({ jsonrpc:'2.0', id, result:{ content:data }});
      }
      return res.json({ jsonrpc:'2.0', id, error:{ code:-32601, message:'Unknown tool'}});
    }

    return res.json({ jsonrpc:'2.0', id, error:{ code:-32601, message:'Unknown method'}});
  } catch (err) {
    return res.status(500).json({ jsonrpc:'2.0', id: null, error:{ code:-32000, message:String(err?.message || err) }});
  }
});

app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
