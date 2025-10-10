// YFL MCP Bridge — unified HTTP transport for ChatGPT MCP + Apps Script proxy
// ESM syntax, Node >= 18

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ------------- env -----------------
const PORT           = process.env.PORT || 10000;          // Render injects 10000
const GAS_BASE_URL   = process.env.GAS_BASE_URL || '';     // e.g. https://script.google.com/macros/s/AKfycb.../exec
const GAS_KEY        = process.env.GAS_KEY       || '';    // your Apps Script shared key (SHARED_KEY)
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || '';   // for local /search, /fetch only (not used by MCP)
const PROTOCOL       = process.env.MCP_PROTOCOL  || '2024-11-05';

// ------------- app -----------------
const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS: allow ChatGPT (and fall back to permissive during bring‑up)
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
    // Fine for your bridge; you can tighten later once everything is stable
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,MCP-Protocol-Version,MCP-Client,X-Requested-With,Authorization'
  );
  // Short-circuit preflight
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---------- helpers ----------
function requireKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.api_key;
  if (!BRIDGE_API_KEY) return res.status(500).json({ ok: false, error: 'Server missing BRIDGE_API_KEY' });
  if (k !== BRIDGE_API_KEY) return res.status(401).json({ ok: false, error: 'Missing or invalid x-api-key' });
  next();
}

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

function jsonrpcOk(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function jsonrpcErr(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

// ---------- health ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- friendly smoke-test endpoints (optional) ----------
app.get('/search', requireKey, async (req, res) => {
  try {
    const { q = '', max = 5 } = req.query;
    const data = await gasCall('search', { q, max });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get('/fetch', requireKey, async (req, res) => {
  try {
    const { id, lines = 0 } = req.query;
    if (!id) return res.status(400).json({ ok: false, error: 'Missing id' });
    const data = await gasCall('fetch', { id, lines });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- MCP unified endpoint ----------
// GET  /mcp?token=...  -> SSE handshake: event: endpoint, data: {"url":"<same endpoint including token>"}
// POST /mcp?token=...  -> JSON-RPC 2.0 methods (initialize, tools/list, tools/call, ...)

app.get('/mcp', (req, res) => {
  const token = (req.query.token || '').toString().trim();
  if (!token) return res.status(401).json({ error: 'missing token' });

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });

  // Important: the connector expects { url } pointing to the SAME endpoint for JSON-RPC-over-HTTP
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ url })}\n\n`);

  // Keep the stream alive
  const timer = setInterval(() => res.write(`: keepalive\n\n`), 15000);
  req.on('close', () => clearInterval(timer));
});

app.post('/mcp', async (req, res) => {
  const token = (req.query.token || '').toString().trim();
  if (!token) return res.status(401).json({ error: 'missing token' });

  const id     = req.body?.id ?? null;
  const method = req.body?.method ?? '';
  const params = req.body?.params ?? {};

  try {
    switch (method) {
      case 'initialize': {
        // Clients also send MCP-Protocol-Version header; we advertise what we support.
        return res.json(
          jsonrpcOk(id, {
            protocolVersion: PROTOCOL,
            serverInfo: { name: 'yfl-mcp-bridge', version: '1.0.0' },
            capabilities: { tools: {} }
          })
        );
      }

      case 'tools/list': {
        return res.json(
          jsonrpcOk(id, {
            tools: [
              {
                name: 'drive_search',
                description: 'Search Drive by title',
                inputSchema: {
                  type: 'object',
                  properties: {
                    q: { type: 'string' },
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
                    id: { type: 'string' },
                    lines: { type: 'number' }
                  }
                }
              }
            ]
          })
        );
      }

      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};

        if (name === 'drive_search') {
          const q   = args.q ?? '';
          const max = Number(args.max ?? 5) || 5;
          const data = await gasCall('search', { q, max });
          return res.json(jsonrpcOk(id, { content: [{ type: 'json', json: data?.data }] }));
        }

        if (name === 'drive_fetch') {
          const fid   = args.id;
          const lines = Number(args.lines ?? 0) || 0;
          if (!fid) return res.json(jsonrpcErr(id, -32602, 'Missing id'));
          const data = await gasCall('fetch', { id: fid, lines });
          const d    = data?.data;
          if (d?.text) {
            // small text files -> return as text
            return res.json(jsonrpcOk(id, { content: [{ type: 'text', text: d.text }] }));
          }
          // otherwise return the JSON block (id, name, mimeType, inline, url, sizeBytes, etc.)
          return res.json(jsonrpcOk(id, { content: [{ type: 'json', json: d }] }));
        }

        return res.json(jsonrpcErr(id, -32601, 'Unknown tool'));
      }

      default:
        return res.json(jsonrpcErr(id, -32601, 'Unknown method'));
    }
  } catch (err) {
    return res.json(jsonrpcErr(id, -32000, 'Internal error', String(err?.message || err)));
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
