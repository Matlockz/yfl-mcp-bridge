// server.js (ESM)
// Adds SSE GET /mcp handshake + CORS + preflight, keeps JSON-RPC POST /mcp,
// and preserves /health, /search, /fetch tooling.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ---- config ----
const app = express();

// Wide-open CORS so the ChatGPT web app can connect from any origin.
// If you prefer, replace '*' with 'https://chat.openai.com' and 'https://chatgpt.com'.
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','x-api-key','MCP-Protocol-Version'] }));

// Parse JSON bodies
app.use(express.json());

// Render/Heroku style port OR local 3332
const PORT = process.env.PORT || 10000;

// Apps Script bridge settings (you already set these in Render -> Environment)
const GAS_BASE_URL   = process.env.GAS_BASE_URL;   // e.g. https://script.google.com/macros/s/.../exec
const GAS_KEY        = process.env.GAS_KEY;        // the shared secret your script checks
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY; // local header key for /search /fetch

// --- tiny helper: token guard for MCP routes ---
function tokenOK(req) {
  // allow either ?token=... or x-api-key header
  const t = (req.query.token || req.get('x-api-key') || '').trim();
  const expected = (BRIDGE_API_KEY || '').trim();
  return expected && t && t === expected;
}

// --- tiny helper: header serializer for SSE ---
function sseWrite(res, evt, dataObj) {
  if (evt) res.write(`event: ${evt}\n`);
  res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

// ---- helper to call Apps Script Web App ----
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

// ----------------- BASIC HEALTH -----------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ----------------- FRIENDLY REST TESTS -----------------
function requireHeaderKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.api_key;
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok:false, error:'Server missing BRIDGE_API_KEY' });
  if (k !== BRIDGE_API_KEY) return res.status(401).json({ ok:false, error:'Missing or invalid x-api-key' });
  next();
}

app.get('/search', requireHeaderKey, async (req, res) => {
  try {
    const { q = '', max = 5 } = req.query;
    const data = await gasCall('search', { q, max });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.get('/fetch', requireHeaderKey, async (req, res) => {
  try {
    const { id, lines } = req.query;
    if (!id) return res.status(400).json({ ok:false, error:'Missing id' });
    const data = await gasCall('fetch', { id, lines });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ----------------- MCP: PRE-FLIGHT -----------------
app.options('/mcp', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, MCP-Protocol-Version');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return res.sendStatus(204);
});

// ----------------- MCP: GET (SSE handshake) -----------------
// Some clients open an SSE first (or fall back to it). We advertise the same /mcp URL as the messages endpoint.
app.get('/mcp', (req, res) => {
  if (!tokenOK(req)) return res.status(401).end('unauthorized');

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Tell the client where to POST messages (back-compat with the older HTTP+SSE transport).
  // Newer clients can ignore this; older clients expect `event: endpoint`.
  const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
  url.searchParams.delete('token'); // do not leak token in the advertised URL
  const endpoint = `${req.protocol}://${req.get('host')}/mcp`;

  sseWrite(res, 'endpoint', { url: endpoint });

  // Optional "ready" signal
  sseWrite(res, 'ready', { ok: true });

  // Keep the stream open with heartbeats so browsers don’t time out.
  const iv = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);

  // Cleanup on disconnect
  req.on('close', () => clearInterval(iv));
});

// ----------------- MCP: POST (JSON-RPC over HTTP) -----------------
app.post('/mcp', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (!tokenOK(req)) return res.status(401).json({ error: { code: 401, message: 'unauthorized' } });

    const msg = req.body || {};
    const { id, method, params = {} } = msg;

    // initialize
    if (method === 'initialize') {
      // We support both 2024-11-05 and newer; report the older one for safety.
      return res.json({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05' } });
    }

    // tools/list
    if (method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            { name: 'drive_search', description: 'Search Drive by title', inputSchema: { type: 'object', properties: { q: { type:'string'}, max: { type:'number'} } } },
            { name: 'drive_fetch',  description: 'Fetch Drive file by id', inputSchema: { type: 'object', properties: { id:{type:'string'}, lines:{type:'number'} } } }
          ]
        }
      });
    }

    // tools/call
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;

      if (name === 'drive_search') {
        const { q = '', max = 5 } = args;
        const data = await gasCall('search', { q, max });
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: data }] } });
      }

      if (name === 'drive_fetch') {
        const { id: fid, lines } = args;
        if (!fid) return res.json({ jsonrpc: '2.0', id, error: { code: 400, message: 'missing id' } });
        const data = await gasCall('fetch', { id: fid, lines });
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: data }] } });
      }

      return res.json({ jsonrpc: '2.0', id, error: { code: 400, message: 'unknown tool' } });
    }

    // Fallback
    return res.json({ jsonrpc: '2.0', id, error: { code: 400, message: 'unknown method' } });

  } catch (err) {
    return res.status(500).json({ jsonrpc: '2.0', id: req.body?.id, error: { code: 500, message: String(err?.message || err) } });
  }
});

// ----------------- START -----------------
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
