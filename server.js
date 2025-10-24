// server.mjs — YFL Drive Bridge (streamable HTTP MCP server)
// Node 18+ (global fetch).  Uses Apps Script as the read-only Drive backend.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

const app = express();
const VERSION = '3.1.1n';
const PORT = Number(process.env.PORT || 5050);

// ---------- CORS / security ----------
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_METHODS = (process.env.ALLOW_METHODS || 'GET,POST,HEAD,OPTIONS')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_HEADERS = (process.env.ALLOW_HEADERS || 'content-type,authorization,x-bridge-token,x-mcp-auth,x-custom-auth-headers')
  .split(',').map(s => s.trim()).filter(Boolean);

const corsMw = cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOW_ORIGINS.length === 0 || ALLOW_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed'), false);
  },
  methods: ALLOW_METHODS.join(','),
  allowedHeaders: ALLOW_HEADERS.join(','),
  credentials: true,
  maxAge: 600
});

function setCors(res) {
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS.join(','));
  res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS.join(','));
  if (ALLOW_ORIGINS.length) {
    res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGINS.join(','));
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}

// ---------- App basics ----------
app.use(morgan('tiny'));
app.use(express.json({ limit: '4mb' }));

const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.SHARED_KEY || '';
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY = process.env.GAS_KEY || BRIDGE_TOKEN || '';

function ok(o = {}) { return { ok: true, ...o }; }

function getToken(req) {
  const q = req.query?.token;
  const hb = req.get('x-bridge-token');
  const hAuth = req.get('authorization');
  const m = /^Bearer\s+(.+)$/i.exec(hAuth || '');
  return q || hb || (m ? m[1] : '');
}

function requireToken(req, res) {
  const t = getToken(req);
  if (!BRIDGE_TOKEN) return true; // if no token configured, don’t enforce
  if (t && t === BRIDGE_TOKEN) return true;
  res.status(401).json({ ok: false, error: 'missing or invalid token' });
  return false;
}

// ---------- Health ----------
app.get('/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(ok({ gas: Boolean(GAS_BASE_URL), version: VERSION, ts: new Date().toISOString() }));
});

// ---------- MCP endpoint shape ----------
// Preflight
app.options('/mcp', corsMw, (req, res) => {
  setCors(res);
  res.status(204).end();
});

// HEAD probe (Inspector / scripts)
app.head('/mcp', corsMw, (req, res) => {
  if (!requireToken(req, res)) return;
  setCors(res);
  res.status(204).end();
});

// Capability discovery
app.get('/mcp', corsMw, (req, res) => {
  if (!requireToken(req, res)) return;
  setCors(res);
  res.json(ok({ transport: 'streamable-http' }));
});

// JSON-RPC 2.0 handler
app.post('/mcp', corsMw, async (req, res) => {
  if (!requireToken(req, res)) return;
  setCors(res);
  res.setHeader('Cache-Control', 'no-store');

  const { id = String(Date.now()), method, params = {} } = req.body || {};

  async function rpcResult(result) {
    res.json({ jsonrpc: '2.0', id, result });
  }
  function rpcError(code, message, data) {
    res.json({ jsonrpc: '2.0', id, error: { code, message, data } });
  }

  try {
    if (method === 'initialize') {
      return rpcResult({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'YFL Drive Bridge', version: VERSION }
      });
    }

    if (method === 'tools/list') {
      return rpcResult({
        tools: [
          {
            name: 'drive.list',
            description: 'List files by folder path/ID',
            inputSchema: {
              type: 'object',
              properties: {
                folderId: { type: 'string', description: "Drive folder ID (or 'root')" },
                path: { type: 'string', description: 'Folder path (optional)' },
                pageToken: { type: 'string' },
                pageSize: { type: 'integer', minimum: 1, maximum: 200 }
              }
            },
            outputSchema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                items: { type: 'array' },
                nextPageToken: { type: 'string' }
              },
              required: ['ok', 'items']
            },
            annotations: { readOnlyHint: true }
          },
          {
            name: 'drive.search',
            description: 'Drive v2 query (e.g., title contains "…" and trashed=false)',
            inputSchema: {
              type: 'object',
              properties: {
                q: { type: 'string', description: 'Drive v2 search query' },
                query: { type: 'string', description: 'Alias of q' },
                pageToken: { type: 'string' },
                pageSize: { type: 'integer', minimum: 1, maximum: 200 }
              },
              required: ['q']
            },
            outputSchema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                items: { type: 'array' },
                nextPageToken: { type: 'string' }
              },
              required: ['ok', 'items']
            },
            annotations: { readOnlyHint: true }
          },
          {
            name: 'drive.get',
            description: 'Get metadata by file id',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
            outputSchema: { type: 'object' },
            annotations: { readOnlyHint: true }
          },
          {
            name: 'drive.export',
            description: 'Export Google Docs/Sheets/Slides or text',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'File ID' },
                mime: { type: 'string', description: 'MIME (e.g., text/plain, text/csv, application/pdf)' }
              },
              required: ['id']
            },
            outputSchema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                id: { type: 'string' },
                srcMime: { type: 'string' },
                mime: { type: 'string' },
                size: { type: 'integer' },
                text: { type: 'string' }
              },
              required: ['ok', 'id', 'mime', 'text']
            },
            annotations: { readOnlyHint: true }
          }
        ]
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;

      // Call Apps Script (read-only Drive backend)
      const structured = await gasCall(name, args);

      // Per MCP spec: include human-readable text content and machine-usable structuredContent
      const text = safeJson(structured);
      return rpcResult({
        content: [{ type: 'text', text }],
        structuredContent: structured
      });
    }

    // Not implemented
    return rpcError(-32601, `Method not found: ${method}`);
  } catch (err) {
    return rpcError(-32000, String(err && err.message || err), { stack: err?.stack });
  }
});

// ---------- GAS helper ----------
async function gasCall(toolName, args) {
  if (!GAS_BASE_URL) throw new Error('GAS_BASE_URL not configured');

  const u = new URL(GAS_BASE_URL);
  u.searchParams.set('tool', toolName || '');
  u.searchParams.set('args', JSON.stringify(args || {}));
  if (GAS_KEY) u.searchParams.set('key', GAS_KEY);

  const r = await fetch(u, { method: 'GET', headers: { 'accept': 'application/json' } });
  if (!r.ok) throw new Error(`GAS HTTP ${r.status}`);
  const data = await r.json();
  if (data && data.ok === false && data.error) throw new Error(data.error);
  return data;
}

function safeJson(o) {
  try { return JSON.stringify(o, null, 2); } catch { return String(o); }
}

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`[yfl-bridge] ${VERSION} listening on :${PORT}`);
});
