// server.js — YFL MCP Bridge (Streamable HTTP transport)

// 1) Friendly REST:  GET /health, /search, /fetch  (protected by x-api-key)
// 2) MCP endpoint:   POST/GET /mcp?token=...       (single URL for JSON-RPC + SSE)

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- Environment ---
const PORT        = process.env.PORT || 10000;
const GAS_BASE    = process.env.GAS_BASE_URL;            // https://script.google.com/macros/s/.../exec
const GAS_KEY     = process.env.GAS_KEY;                 // shared secret Apps Script checks
const TOKEN       = process.env.BRIDGE_API_KEY || process.env.TOKEN; // token for /mcp and x-api-key

// --- Helpers ---
function authRest(req, res, next) {
  const k = req.header('x-api-key') || req.query.api_key;
  if (!TOKEN) return res.status(500).json({ ok:false, error:'Server missing TOKEN/BRIDGE_API_KEY' });
  if (k !== TOKEN) return res.status(401).json({ ok:false, error:'Missing or invalid x-api-key' });
  next();
}

function authMcp(req, res, next) {
  const q = (req.query.token || '').trim();
  const bearer = (req.header('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const provided = q || bearer;
  if (!TOKEN) return res.status(500).json({ ok:false, error:'Server missing TOKEN/BRIDGE_API_KEY' });
  if (provided !== TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
}

async function gasCall(action, params = {}) {
  if (!GAS_BASE || !GAS_KEY) throw new Error('Server missing GAS_BASE_URL or GAS_KEY');
  const url = new URL(GAS_BASE);
  url.searchParams.set('action', action);
  url.searchParams.set('key', GAS_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url.toString(), { method:'GET' });
  if (!r.ok) throw new Error(`GAS HTTP ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'GAS error');
  return j.data ?? j;
}

// --- Health (for Render status checks & keep-alives) ---
app.get('/health', (_req, res) => res.json({ ok:true }));

// --- Friendly smoke tests (protected by x-api-key) ---
app.get('/search', authRest, async (req, res) => {
  try {
    const { q = '', max = 5 } = req.query;
    const data = await gasCall('search', { q, max });
    res.json({ ok:true, data });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

app.get('/fetch', authRest, async (req, res) => {
  try {
    const { id, lines } = req.query;
    if (!id) return res.status(400).json({ ok:false, error:'missing id' });
    const data = await gasCall('fetch', { id, lines });
    res.json({ ok:true, data });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e.message || e) });
  }
});

// ---------------------------------------------------------------------
// /mcp — Streamable HTTP transport (one URL supports POST + GET/SSE).
// Spec: clients POST JSON-RPC 2.0 to this URL and may open an SSE
// stream on the *same* URL.  (This is what the ChatGPT connector expects.)
// ---------------------------------------------------------------------
app.all('/mcp', authMcp, async (req, res) => {
  // GET -> open SSE channel for server-initiated messages (optional here)
  if (req.method === 'GET') {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();
    // Keep-alive so proxies don’t close it
    const iv = setInterval(() => res.write(':\n\n'), 20000);
    req.on('close', () => clearInterval(iv));
    // Harmless ready event (some clients ignore it)
    res.write('event: ready\n');
    res.write('data: ok\n\n');
    return;
  }

  // POST -> JSON-RPC 2.0
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const body = req.body || {};
  const { id, method, params = {} } = body;
  const ok  = (result)              => res.json({ jsonrpc:'2.0', id, result });
  const err = (code, message)       => res.json({ jsonrpc:'2.0', id, error:{ code, message } });

  try {
    switch (method) {
      case 'initialize': {
        const proto = (params && params.protocolVersion) || '2024-11-05';
        return ok({ protocolVersion: proto }); // Echo supported version
      }
      case 'tools/list': {
        // Tool definitions (JSON Schema in inputSchema)
        return ok({
          tools: [
            {
              name: 'drive_search',
              description: 'Search Google Drive by title; returns id, name, mimeType, url, lastUpdated.',
              inputSchema: {
                type: 'object',
                properties: {
                  q:   { type: 'string',  description: 'Title contains…' },
                  max: { type: 'number',  description: 'Max results (default 5)' }
                },
                required: ['q']
              }
            },
            {
              name: 'drive_fetch',
              description: 'Fetch a Drive file by id (optionally first N lines).',
              inputSchema: {
                type: 'object',
                properties: {
                  id:    { type: 'string', description: 'Drive file id' },
                  lines: { type: 'number', description: 'Optional line limit' }
                },
                required: ['id']
              }
            }
          ]
        });
      }
      case 'tools/call': {
        const { name, arguments: args = {} } = params;
        if (name === 'drive_search') {
          const q   = (args.q || '').toString();
          const max = Number(args.max ?? 5);
          const data = await gasCall('search', { q, max });
          return ok({ content: [{ type:'json', json: data }] }); // Tool content per MCP
        }
        if (name === 'drive_fetch') {
          const id    = (args.id || '').toString();
          const lines = args.lines != null ? Number(args.lines) : undefined;
          if (!id) return err(-32602, 'Missing id');
          const data = await gasCall('fetch', { id, lines });
          return ok({ content: [{ type:'json', json: data }] });
        }
        return err(-32601, `Unknown tool: ${name}`);
      }
      default:
        return err(-32601, `Unknown method: ${method}`);
    }
  } catch (e) {
    return err(-32000, String(e.message || e));
  }
});

app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
