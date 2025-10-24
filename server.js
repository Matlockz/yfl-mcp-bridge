// server.js — YFL Drive Bridge (CommonJS) — v3.1.1n
// Endpoints: /health (public), /mcp (HEAD/GET/POST; token required)
// Tools: drive.search, drive.list, drive.get, drive.export (GAS-backed)

const express = require('express');
const morgan = require('morgan');

const VERSION = process.env.BRIDGE_VERSION || '3.1.1n';
const PORT = Number(process.env.PORT || 5050);

// GAS web app (deployed as “Anyone with the link”), v2 Drive semantics
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY      = process.env.GAS_KEY || '';
const SHARED_KEY   = process.env.SHARED_KEY || '';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';

// CORS allow list (comma-separated), headers & methods
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_HEADERS = process.env.ALLOW_HEADERS || 'content-type,x-bridge-token,x-custom-auth-headers,authorization,x-mcp-auth';
const ALLOW_METHODS = process.env.ALLOW_METHODS || 'GET,POST,HEAD,OPTIONS';

// Helpers
function allowOrigin(origin) {
  if (!origin) return null;
  if (ALLOW_ORIGINS.includes('*')) return '*';
  return ALLOW_ORIGINS.find(allowed => {
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1); // ".example.com"
      return origin.endsWith(suffix);
    }
    return allowed === origin;
  }) || null;
}

function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowed = allowOrigin(origin);
  if (allowed || allowed === '*') {
    res.setHeader('Access-Control-Allow-Origin', allowed || origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function ts() { return new Date().toISOString(); }

function json(id, result) {
  return { jsonrpc: '2.0', id: String(id || '1'), result };
}

function jsonError(id, code, message, data) {
  return { jsonrpc: '2.0', id: String(id || '1'), error: { code, message, data } };
}

function authOk(req) {
  const token = (req.headers['x-bridge-token'] || req.query.token || '').toString();
  return BRIDGE_TOKEN && token && token === BRIDGE_TOKEN;
}

async function gasCall(tool, args) {
  if (!GAS_BASE_URL) throw new Error('GAS_BASE_URL not configured');
  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('tool', tool);
  url.searchParams.set('args', JSON.stringify(args || {}));
  if (GAS_KEY) url.searchParams.set('key', GAS_KEY);
  if (SHARED_KEY) url.searchParams.set('shared', SHARED_KEY);

  const r = await fetch(url.toString(), { method: 'GET' });
  if (!r.ok) {
    const text = await r.text().catch(()=>'');
    throw new Error(`GAS ${tool} failed: ${r.status} ${text.slice(0,200)}`);
  }
  const data = await r.json();
  if (!data || data.ok === false) throw new Error(`GAS ${tool} error: ${JSON.stringify(data)}`);
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
        path:     { type: 'string', description: 'Folder path (optional; server may ignore)' },
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
        q:     { type:'string', description:'Drive v2 search query' },
        query: { type:'string', description:'Alias of q' },
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

// App
const app = express();
app.disable('x-powered-by');
app.use(morgan('tiny'));
app.use(express.json({ limit: '5mb' }));
app.use(cors);

// Public health
app.get('/health', (req,res) => {
  res.json({ ok:true, gas: Boolean(GAS_BASE_URL), version: VERSION, ts: ts() });
});

// MCP transport probe (token required)
app.head('/mcp', (req,res) => {
  if (!authOk(req)) return res.status(401).end();
  return res.status(204).end();
});

app.get('/mcp', (req,res) => {
  if (!authOk(req)) return res.status(401).json({ ok:false, error:'unauthorized' });
  return res.json({ ok:true, transport:'streamable-http' });
});

// JSON-RPC 2.0
app.post('/mcp', async (req,res) => {
  try {
    if (!authOk(req)) return res.status(401).json(jsonError(req.body?.id, -32001, 'unauthorized'));
    const { id, method, params } = req.body || {};
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
      let out;
      if (name === 'drive.search') out = await gasCall('drive.search', { q: args.q || args.query, pageSize: args.pageSize, pageToken: args.pageToken });
      else if (name === 'drive.list') out = await gasCall('drive.list', args);
      else if (name === 'drive.get') out = await gasCall('drive.get', args);
      else if (name === 'drive.export') out = await gasCall('drive.export', args);
      else return res.json(jsonError(id, -32601, `Unknown tool ${name}`));

      // Inspector-friendly content envelope
      return res.json(json(id, { content: [ { type:'object', object: out } ] }));
    }
    return res.json(jsonError(id, -32601, `Unknown method ${method}`));
  } catch (err) {
    return res.json(jsonError(req.body?.id, -32000, String(err && err.message || err), { stack: String(err && err.stack || '') }));
  }
});

app.listen(PORT, () => {
  console.log(`YFL Drive Bridge listening on ${PORT}`);
});
