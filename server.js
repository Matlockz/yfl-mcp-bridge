// server.mjs
// YFL Drive Bridge — MCP Streamable HTTP server → Google Apps Script (GAS)
// Requires: Node 18+ (built-in fetch), express, cors, morgan, dotenv

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

const app = express();

// ---- Config ---------------------------------------------------------------
const PORT = process.env.PORT || 10000;
const GAS_BASE_URL = process.env.GAS_BASE_URL;        // e.g., https://script.google.com/.../exec
const GAS_KEY = process.env.GAS_KEY;                  // shared secret for GAS
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.TOKEN || GAS_KEY;

if (!GAS_BASE_URL || !GAS_KEY || !BRIDGE_TOKEN) {
  console.error('[FATAL] Missing GAS_BASE_URL / GAS_KEY / BRIDGE_TOKEN in .env');
  process.exit(1);
}

// ---- Middleware -----------------------------------------------------------
app.set('trust proxy', 1); // respect x-forwarded-* behind ngrok/proxies (so URLs use https)  // see: express "behind proxies"

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Bridge-Token',
    'MCP-Protocol-Version',
    'ngrok-skip-browser-warning'
  ],
}));
app.options('*', cors());

app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// ---- Helpers --------------------------------------------------------------
const j = (res, code, obj) => res.status(code).json(obj);

const absoluteUrl = (req, pathAndQuery) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${pathAndQuery}`;
};

const ok = (obj = {}) => ({ ok: true, ...obj });
const err = (msg, data = {}) => ({ ok: false, error: msg, ...data });

const getTokenFromReq = (req) =>
  (req.query.token) ||
  (req.headers['x-bridge-token']) ||
  (req.headers['authorization']?.replace(/^Bearer\s+/i, ''));

function requireToken(req, res, next) {
  const t = getTokenFromReq(req);
  if (!t || t !== BRIDGE_TOKEN) return j(res, 401, err('unauthorized'));
  next();
}

function gasUrl(action, extraParams = {}) {
  const u = new URL(GAS_BASE_URL);
  u.searchParams.set('action', action);
  u.searchParams.set('token', GAS_KEY);
  for (const [k, v] of Object.entries(extraParams)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function callGAS(action, params = {}) {
  const url = gasUrl(action, params);
  const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text();
    throw new Error(`GAS non-JSON (${res.status} ${ct}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Unwrap the GAS envelope { ok:true, data: ... } → payload + tool result
function normalizeGasPayload(gasJson) {
  if (gasJson && gasJson.ok && gasJson.data !== undefined) return gasJson.data;
  return gasJson;
}

// MCP result wrapper with both human-readable and machine-readable payloads.
function rpcOk(id, payload, isError = false) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError
    }
  };
}
function rpcErr(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

// ---- Health ---------------------------------------------------------------
app.get('/health', async (req, res) => {
  try {
    const ping = await callGAS('health');
    j(res, 200, ok({ gas: !!ping?.ok, ts: new Date().toISOString() }));
  } catch (e) {
    j(res, 200, ok({ gas: false, error: String(e), ts: new Date().toISOString() }));
  }
});

// ---- REST-style tools (handy for smoke tests) ----------------------------
app.get('/tools/list', requireToken, async (req, res) => {
  j(res, 200, ok({ tools: toolList().map(t => t.name) }));
});

app.post('/tools/call', requireToken, async (req, res) => {
  try {
    const name = req.body?.name || req.query?.name;
    const args = req.body?.arguments || req.body || {};
    if (!name) return j(res, 400, err('missing tool name'));

    const gas = await callGAS('tools/call', { name, ...args });
    const payload = normalizeGasPayload(gas);
    j(res, 200, ok(payload));
  } catch (e) {
    j(res, 500, err('tools.call failed', { detail: String(e) }));
  }
});

// ---- MCP: Streamable HTTP -------------------------------------------------
// HEAD /mcp → 204 No Content (probe)
app.head('/mcp', requireToken, (req, res) => res.status(204).end());

// GET /mcp → if SSE requested: send 'event: endpoint', else JSON probe
app.get('/mcp', requireToken, (req, res) => {
  const acceptsSSE = (req.headers.accept || '').includes('text/event-stream');
  if (acceptsSSE) {
    // SSE handshake that tells the client which POST URL to use
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    const url = absoluteUrl(req, `/mcp?token=${BRIDGE_TOKEN}`);
    const endpointEvt = { url, protocolVersion: '2024-11-05' };
    res.write(`event: endpoint\n`);
    res.write(`data: ${JSON.stringify(endpointEvt)}\n\n`);
    const iv = setInterval(() => res.write(`: keepalive\n\n`), 20_000);
    req.on('close', () => clearInterval(iv));
    return;
  }
  // Simple JSON probe
  return j(res, 200, ok({ transport: 'streamable-http' }));
});

// POST /mcp → JSON-RPC 2.0 (initialize, tools/list, tools/call)
app.post('/mcp', requireToken, async (req, res) => {
  const { id, method, params } = req.body || {};
  try {
    if (!req.body || req.body.jsonrpc !== '2.0') {
      return res.status(400).json(rpcErr(id ?? null, -32600, 'Invalid Request'));
    }

    if (method === 'initialize') {
      const result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'yfl-drive-bridge', version: '3.1.0' }
      };
      return res.json({ jsonrpc: '2.0', id, result });
    }

    if (method === 'tools/list') {
      const result = { tools: toolList() };
      return res.json({ jsonrpc: '2.0', id, result });
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      if (!name) return res.json(rpcErr(id, -32602, 'Invalid params: missing name'));

      const gas = await callGAS('tools/call', { name, ...args });
      const payload = normalizeGasPayload(gas);
      return res.json(rpcOk(id, payload, gas?.ok === false));
    }

    return res.json(rpcErr(id, -32601, 'Method not found'));
  } catch (e) {
    return res.json(rpcErr(id, -32603, 'Internal error', { detail: String(e) }));
  }
});

// ---- Tool definitions -----------------------------------------------------
function toolList() {
  return [
    {
      name: 'drive.search',
      description: 'Search Google Drive using DriveApp v2 query syntax (e.g., title contains "X" and trashed = false).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'DriveApp v2 query, e.g., title contains "Report" and trashed = false' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
        },
        required: ['query'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    {
      name: 'drive.list',
      description: 'List files in a folder by ID or path.',
      inputSchema: {
        type: 'object',
        properties: {
          folderId: { type: 'string' },
          folderPath: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    {
      name: 'drive.get',
      description: 'Get metadata (and small text content, when available) for a file by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          lines: { type: 'integer', description: 'Optional: number of head lines to return for text files' }
        },
        required: ['id'],
        additionalProperties: true
      },
      annotations: { readOnlyHint: true }
    }
  ];
}

// ---- 404 ------------------------------------------------------------------
app.use((req, res) => j(res, 404, err('not found', { path: req.path })));

// ---- Start ----------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[bridge] listening on http://localhost:${PORT}`);
  console.log(`[bridge] MCP endpoint will be: https://<your-public-host>/mcp?token=${BRIDGE_TOKEN}`);
});
