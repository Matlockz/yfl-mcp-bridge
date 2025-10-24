/**
 * server.js — YFL Drive Bridge (Streamable HTTP for MCP)
 * - /health : diagnostics
 * - /mcp    : HEAD=204, GET=transport banner, POST=JSON-RPC 2.0 (initialize, tools/list, tools/call)
 *
 * Requires Node 18+ (global fetch). Reads .env for config.
 */

const express = require('express');
const crypto = require('crypto');

const {
  PORT = 5050,
  BRIDGE_VERSION = '3.4.5',
  BRIDGE_TOKEN = '',
  GAS_BASE_URL = '',
  GAS_KEY = '',
  ALLOW_ORIGINS = '',
  ALLOW_HEADERS = 'content-type,x-bridge-token,x-custom-auth-headers,authorization,x-mcp-auth',
  ALLOW_METHODS = 'GET,POST,HEAD,OPTIONS',
} = process.env;

const allowedOrigins = ALLOW_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
const app = express();

// ---- minimal CORS with allow-list (emit ONE origin per request) ----
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
  // (No credentials; if you add them, avoid wildcard origins)
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---- body parsing for JSON-RPC ----
app.use(express.json({ limit: '4mb' }));

// ---- auth gate (x-bridge-token header OR ?token=...) ----
function isAuthorized(req) {
  if (!BRIDGE_TOKEN) return true;
  const header = req.headers['x-bridge-token'] || req.headers['x_mcp_auth'] || '';
  const query = req.query.token || '';
  return header === BRIDGE_TOKEN || query === BRIDGE_TOKEN;
}

// ---- helpers ----
function banner() {
  return { ok: true, transport: 'streamable-http' };
}
function nowIso() { return new Date().toISOString(); }

async function callGASTool(name, args) {
  if (!GAS_BASE_URL) {
    throw new Error('GAS_BASE_URL is not set');
  }
  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('tool', name);
  url.searchParams.set('args', JSON.stringify(args || {}));
  const headers = {};
  if (GAS_KEY) headers['x-api-key'] = GAS_KEY;

  const resp = await fetch(url.toString(), { method: 'GET', headers });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`GAS ${name} failed: ${resp.status} ${txt.slice(0,200)}`);
  }
  return await resp.json();
}

// ---- JSON-RPC responders ----
const protocolVersion = '2024-11-05';

const tools = [
  {
    name: 'drive.list',
    description: 'List files by folder path/ID',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: "Drive folder ID (or 'root')" },
        path:     { type: 'string', description: 'Folder path (optional; may be ignored)' },
        pageToken:{ type: 'string' },
        pageSize: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        items: { type: 'array' },
        nextPageToken: { type: 'string' },
      },
      required: ['ok', 'items'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'drive.search',
    description: 'Drive v2 query (e.g., title contains "…" and trashed=false)',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Drive v2 q string' },
        query: { type: 'string', description: 'Alias of q' },
        pageToken: { type: 'string' },
        pageSize: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['q'],
    },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, items: { type: 'array' }, nextPageToken: { type: 'string' } },
      required: ['ok', 'items'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'drive.get',
    description: 'Get metadata by file id',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'drive.export',
    description: 'Export Google Docs/Sheets/Slides or text',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'File ID' },
        mime: { type: 'string', description: 'MIME (e.g., text/plain, text/csv, application/pdf)' },
      },
      required: ['id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        id: { type: 'string' },
        srcMime: { type: 'string' },
        mime: { type: 'string' },
        size: { type: 'integer' },
        text: { type: 'string' },
      },
      required: ['ok', 'id', 'mime', 'text'],
    },
    annotations: { readOnlyHint: true },
  },
];

// health
app.get('/health', (req, res) => {
  res.json({ ok: true, gas: !!GAS_BASE_URL, version: BRIDGE_VERSION, ts: nowIso() });
});

// mcp banners
app.head('/mcp', (req, res) => res.status(204).end());
app.get('/mcp', (req, res) => res.json(banner()));

// mcp json-rpc
app.post('/mcp', async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const { method, id, params } = req.body || {};
  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'YFL Drive Bridge', version: BRIDGE_VERSION },
        },
      });
    }

    if (method === 'tools/list') {
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      if (!name) throw new Error('tools/call requires name');

      // Proxy to GAS
      const obj = await callGASTool(name, args);

      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'object', object: obj }],
        },
      });
    }

    return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (err) {
    return res.status(200).json({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: String(err?.message || err || 'Unknown error') },
    });
  }
});

// start
app.listen(Number(PORT), () => {
  // eslint-disable-next-line no-console
  console.log(`[bridge] v${BRIDGE_VERSION} listening on :${PORT}`);
});
