// server.js — YFL Drive Bridge (CommonJS) — v3.1.2
// Endpoints: /health (public), /mcp (HEAD/GET/POST; token required)
// Tools: drive.search, drive.list, drive.get, drive.export (GAS-backed)

'use strict';

const express = require('express');
const morgan  = require('morgan');
const { randomUUID } = require('crypto');

// Use global fetch if available (Node 18+); otherwise lazy-load node-fetch.
// Do not rename to "fetch" to avoid shadowing the global in modern Node.
const doFetch = (...args) =>
  (typeof global.fetch === 'function'
    ? global.fetch(...args)
    : import('node-fetch').then(mod => mod.default(...args)));

const VERSION = process.env.BRIDGE_VERSION || '3.1.2';
const PORT    = Number(process.env.PORT || 5050);

// GAS web app (deployed as “Anyone with the link”), v2 Drive semantics
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY      = process.env.GAS_KEY || '';
const SHARED_KEY   = process.env.SHARED_KEY || '';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';

// Network / security tuning
const TIMEOUT_MS  = Number(process.env.GAS_TIMEOUT_MS || 25000);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// CORS allow list (comma-separated), headers & methods
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ALLOW_HEADERS = process.env.ALLOW_HEADERS
  || 'content-type,x-bridge-token,x-custom-auth-headers,authorization,x-mcp-auth';

const ALLOW_METHODS = process.env.ALLOW_METHODS
  || 'GET,POST,HEAD,OPTIONS';

// --------------------------- Helpers ---------------------------

function allowOrigin(origin) {
  if (!origin) return null;
  if (ALLOW_ORIGINS.includes('*')) return '*';
  return (
    ALLOW_ORIGINS.find(allowed => {
      if (allowed.startsWith('*.')) {
        const suffix = allowed.slice(1); // ".example.com"
        return origin.endsWith(suffix);
      }
      return allowed === origin;
    }) || null
  );
}

function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowed = allowOrigin(origin);

  if (allowed || allowed === '*') {
    res.setHeader('Access-Control-Allow-Origin', allowed === '*' ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
    // Expose helpful headers for clients/inspectors
    res.setHeader('Access-Control-Expose-Headers', 'x-request-id,x-bridge-version');
    // Only allow credentials when not using wildcard origin
    if (allowed !== '*') res.setHeader('Access-Control-Allow-Credentials', 'true');
    // Cache preflight briefly
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function ts() { return new Date().toISOString(); }

function json(id, result) {
  return { jsonrpc: '2.0', id: String(id ?? '1'), result };
}

function jsonError(id, code, message, data) {
  return { jsonrpc: '2.0', id: String(id ?? '1'), error: { code, message, data } };
}

function authOk(req) {
  const token = (req.headers['x-bridge-token'] || req.query.token || '').toString();
  return Boolean(BRIDGE_TOKEN && token && token === BRIDGE_TOKEN);
}

function clamp(n, min, max) {
  const num = Number(n);
  if (!Number.isFinite(num)) return min;
  return Math.min(Math.max(num, min), max);
}

// Collect pass-through auth headers from the caller and (optionally) forward
// them to GAS in a base64url-encoded JSON blob via the "auth" query param.
function pickAuthHeaders(req) {
  const out = {};
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth) out['authorization'] = auth;

  const mcpAuth = req.headers['x-mcp-auth'];
  if (typeof mcpAuth === 'string' && mcpAuth) out['x-mcp-auth'] = mcpAuth;

  const custom = req.headers['x-custom-auth-headers'];
  if (typeof custom === 'string' && custom) {
    try {
      const obj = JSON.parse(custom);
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'string' && v) out[String(k).toLowerCase()] = v;
        }
      }
    } catch (_) {
      // ignore bad JSON; do not fail the request
    }
  }
  return out;
}

async function gasCall(req, tool, args) {
  if (!GAS_BASE_URL) throw new Error('GAS_BASE_URL not configured');

  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('tool', tool);
  url.searchParams.set('args', JSON.stringify(args || {}));
  if (GAS_KEY)    url.searchParams.set('key', GAS_KEY);
  if (SHARED_KEY) url.searchParams.set('shared', SHARED_KEY);

  const authHeaders = pickAuthHeaders(req);
  if (Object.keys(authHeaders).length) {
    const encoded = Buffer.from(JSON.stringify(authHeaders), 'utf8').toString('base64url');
    url.searchParams.set('auth', encoded);
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let r;
  try {
    r = await doFetch(url.toString(), { method: 'GET', signal: controller.signal });
  } catch (err) {
    clearTimeout(t);
    if (String(err && err.name) === 'AbortError') {
      throw new Error(`GAS ${tool} failed: timeout after ${TIMEOUT_MS}ms`);
    }
    throw err;
  }
  clearTimeout(t);

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`GAS ${tool} failed: ${r.status} ${text.slice(0, 200)}`);
  }

  let data;
  try {
    data = await r.json();
  } catch (e) {
    const text = await r.text().catch(() => '');
    throw new Error(`GAS ${tool} returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (!data || data.ok === false) {
    throw new Error(`GAS ${tool} error: ${JSON.stringify(data)}`);
  }
  return data;
}

// Tool registry (Inspector-friendly)
const TOOLS = [
  {
    name: 'drive.list',
    description: 'List files by folder path/ID',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: "Drive folder ID (or 'root')" },
        path:     { type: 'string',  description: 'Folder path (optional; server may ignore)' },
        pageToken:{ type: 'string' },
        pageSize: { type: 'integer', minimum: 1, maximum: 200 }
      }
    },
    outputSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, items: { type:'array' }, nextPageToken: { type:'string' } },
      required: ['ok','items']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'drive.search',
    description: 'Drive v2 query (e.g., title contains "…" and trashed=false)',
    inputSchema: {
      type: 'object',
      properties: {
        q:        { type:'string', description:'Drive v2 search query' },
        query:    { type:'string', description:'Alias of q' },
        pageToken:{ type:'string' },
        pageSize: { type:'integer', minimum:1, maximum:200 }
      },
      required: ['q']
    },
    outputSchema: {
      type: 'object',
      properties: { ok: {type:'boolean'}, items:{type:'array'}, nextPageToken:{type:'string'} },
      required: ['ok','items']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'drive.get',
    description: 'Get metadata by file id',
    inputSchema: { type:'object', properties:{ id:{type:'string'} }, required:['id'] },
    outputSchema: { type:'object' },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'drive.export',
    description: 'Export Google Docs/Sheets/Slides or text',
    inputSchema: {
      type:'object',
      properties: {
        id:   { type:'string', description:'File ID' },
        mime: { type:'string', description:'MIME (e.g., text/plain, text/csv, application/pdf)' }
      },
      required:['id']
    },
    outputSchema: {
      type:'object',
      properties: {
        ok:{type:'boolean'}, id:{type:'string'}, srcMime:{type:'string'},
        mime:{type:'string'}, size:{type:'integer'}, text:{type:'string'}
      },
      required: ['ok','id','mime','text']
    },
    annotations: { readOnlyHint: true }
  }
];

// ----------------------------- App -----------------------------

const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', true);

// Request ID + common headers
app.use((req, res, next) => {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  res.setHeader('X-Bridge-Version', VERSION);
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// morgan with request id
morgan.token('rid', req => req.id);
app.use(morgan(':method :url :status :res[content-length] - :response-time ms rid=:rid'));

app.use(express.json({ limit: '5mb' }));
app.use(cors);

// Root (optional)
app.get('/', (req, res) => {
  res.type('application/json').send(JSON.stringify({
    ok: true,
    service: 'YFL Drive Bridge',
    version: VERSION,
    ts: ts()
  }));
});

// Public health
app.get('/health', (req, res) => {
  res.json({ ok: true, gas: Boolean(GAS_BASE_URL), version: VERSION, ts: ts() });
});
app.head('/health', (req, res) => res.status(204).end());

// MCP transport probe (token required)
app.head('/mcp', (req, res) => {
  if (!authOk(req)) return res.status(401).end();
  return res.status(204).end();
});

app.get('/mcp', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok:false, error:'unauthorized' });
  return res.json({ ok:true, transport:'streamable-http' });
});

// JSON-RPC 2.0 (token required)
app.post('/mcp', async (req, res) => {
  try {
    if (!authOk(req)) {
      // -32001 is used here for "unauthorized" (server-defined)
      return res.status(401).json(jsonError(req.body?.id, -32001, 'unauthorized'));
    }

    // Basic JSON-RPC envelope validation
    const body = req.body;
    if (Array.isArray(body)) {
      // Batch not supported by this bridge
      return res.json(jsonError(null, -32600, 'batch requests are not supported'));
    }
    if (!body || typeof body !== 'object') {
      return res.json(jsonError(null, -32600, 'invalid request'));
    }

    const { id, method, params } = body;

    if (method === 'initialize') {
      return res.json(json(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'YFL Drive Bridge', version: VERSION }
      }));
    }

    if (method === 'tools/list') {
      return res.json(json(id, { tools: TOOLS }));
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      if (typeof name !== 'string' || !name) {
        return res.json(jsonError(id, -32602, 'invalid params: missing tool name'));
      }

      let out;

      if (name === 'drive.search') {
        const qRaw = args.q ?? args.query ?? '';
        const q = typeof qRaw === 'string' ? qRaw : String(qRaw || '');
        if (!q.trim()) return res.json(jsonError(id, -32602, 'invalid params: q is required'));
        const pageSize = args.pageSize ? clamp(args.pageSize, 1, 200) : undefined;
        out = await gasCall(req, 'drive.search', { q, pageSize, pageToken: args.pageToken });
      }

      else if (name === 'drive.list') {
        const pageSize = args.pageSize ? clamp(args.pageSize, 1, 200) : undefined;
        out = await gasCall(req, 'drive.list', {
          folderId: args.folderId, path: args.path, pageSize, pageToken: args.pageToken
        });
      }

      else if (name === 'drive.get') {
        if (!args.id || typeof args.id !== 'string') {
          return res.json(jsonError(id, -32602, 'invalid params: id is required'));
        }
        out = await gasCall(req, 'drive.get', { id: args.id });
      }

      else if (name === 'drive.export') {
        if (!args.id || typeof args.id !== 'string') {
          return res.json(jsonError(id, -32602, 'invalid params: id is required'));
        }
        const mime = typeof args.mime === 'string' && args.mime ? args.mime : undefined;
        out = await gasCall(req, 'drive.export', { id: args.id, mime });
      }

      else {
        return res.json(jsonError(id, -32601, `Unknown tool ${name}`));
      }

      // Inspector-friendly content envelope
      return res.json(json(id, { content: [ { type:'object', object: out } ] }));
    }

    // Unknown method
    return res.json(jsonError(id, -32601, `Unknown method ${method}`));

  } catch (err) {
    const message = String((err && err.message) || err);
    const stack = String((err && err.stack) || '');
    return res.json(jsonError(req.body?.id, -32000, message, { stack }));
  }
});

app.listen(PORT, () => {
  console.log(`YFL Drive Bridge listening on ${PORT}`);
});
