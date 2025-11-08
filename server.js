// server.js — YFL Drive Bridge (connector‑friendly) — v3.4.6
// Endpoints: /health (public), /mcp (HEAD/GET public; POST requires token)
// Tools: drive.search, drive.list, drive.get, drive.export (GAS‑backed)

'use strict';

const express = require('express');
const morgan  = require('morgan');
const { randomUUID } = require('crypto');

// Prefer global fetch (Node 18+); lazy‑load node-fetch otherwise.
const doFetch = (...args) =>
  (typeof global.fetch === 'function'
    ? global.fetch(...args)
    : import('node-fetch').then(mod => mod.default(...args)));

const VERSION = process.env.BRIDGE_VERSION || '3.4.6';
const PORT    = Number(process.env.PORT || 5050);

// === GAS back end (Apps Script; deployed “Anyone with the link”) ===
const GAS_BASE_URL = process.env.GAS_BASE_URL || process.env.APPS_SCRIPT_URL || ''; // e.g., https://script.google.com/macros/s/XXXXXXXX/exec
const GAS_KEY      = process.env.GAS_KEY || '';
const SHARED_KEY   = process.env.SHARED_KEY || '';
// IMPORTANT: default includes your current token for convenience during setup.
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || 'v3c3NJQ4i94';

// === Network / security ===
const TIMEOUT_MS  = Number(process.env.GAS_TIMEOUT_MS || 25000);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

// CORS allow list (comma‑sep). Defaults include ChatGPT UIs + your tunnel host.
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || [
  'https://chat.openai.com',
  'https://chatgpt.com',
  'https://platform.openai.com',
  'https://bridge.yflbridge.work'
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

const ALLOW_HEADERS = process.env.ALLOW_HEADERS
  || 'content-type,authorization,x-bridge-token,x-custom-auth-headers,x-mcp-auth';
const ALLOW_METHODS = process.env.ALLOW_METHODS || 'GET,POST,HEAD,OPTIONS';

// --------------------------- Helpers ---------------------------
function matchOrigin(origin) {
  if (!origin) return null;
  for (const allowed of ALLOW_ORIGINS) {
    if (allowed === '*' || allowed === origin) return origin;
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1); // ".example.com"
      if (origin.endsWith(suffix)) return origin;
    }
  }
  return null;
}

function cors(req, res, next) {
  const origin = req.headers.origin;
  const okOrigin = matchOrigin(origin);
  if (okOrigin) res.setHeader('Access-Control-Allow-Origin', okOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function getToken(req) {
  const q = req.query?.token;
  const h1 = req.headers['x-bridge-token'];
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return q || h1 || (m ? m[1] : null);
}

function requireToken(req, res, next) {
  const tok = getToken(req);
  if (!tok || tok !== BRIDGE_TOKEN) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="yfl-bridge"');
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }
  next();
}

function requireGasConfig(okRes, failRes) {
  if (!GAS_BASE_URL) {
    (failRes || okRes).status(500).json({ ok:false, error:'GAS_BASE_URL missing' });
    return false;
  }
  return true;
}

async function gasCall(path, query = {}, body = null) {
  const url = new URL(GAS_BASE_URL);
  // Forward op params as query
  Object.entries(query).forEach(([k,v]) => url.searchParams.set(k, String(v)));
  if (GAS_KEY) url.searchParams.set('key', GAS_KEY);
  if (SHARED_KEY) url.searchParams.set('sharedKey', SHARED_KEY);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  const resp = await doFetch(url.toString(), {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: ctrl.signal
  }).finally(() => clearTimeout(t));

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GAS ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// --------------------------- App ---------------------------
const app = express();
if (TRUST_PROXY) app.set('trust proxy', 1);
app.use(morgan('tiny'));
app.use(cors);
app.use(express.json({ limit: '1mb' }));

// Health (public)
app.get('/health', (req, res) => {
  res.json({ ok:true, gas: !!GAS_BASE_URL, version: VERSION, ts: new Date().toISOString() });
});

// MCP discovery (public for HEAD/GET to satisfy ChatGPT connector creation)
app.head('/mcp', (req, res) => {
  res.status(200).setHeader('x-bridge-version', VERSION).end();
});
app.get('/mcp', (req, res) => {
  // Minimal descriptor for UI probing (no secrets)
  res.json({
    jsonrpc: '2.0',
    id: '0',
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'YFL Drive Bridge', version: VERSION }
    }
  });
});

// MCP RPC (POST) — requires token
app.post('/mcp', requireToken, async (req, res) => {
  const { id, method, params } = req.body || {};
  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc:'2.0', id: String(id ?? 'init'),
        result:{
          protocolVersion:'2024-11-05',
          capabilities:{ tools:{} },
          serverInfo:{ name:'YFL Drive Bridge', version: VERSION }
        }
      });
    }

    if (method === 'tools/list') {
      return res.json({
        jsonrpc:'2.0', id: String(id ?? 'list'),
        result:{
          tools:[
            {
              name:'drive.list',
              description:'List files by folder path/ID',
              inputSchema:{ type:'object', properties:{
                folderId:{ type:'string', description:"Drive folder ID (or 'root')" },
                path:{ type:'string', description:'Optional display path' },
                pageToken:{ type:'string' }, pageSize:{ type:'integer', minimum:1, maximum:200 }
              }},
              outputSchema:{ type:'object', properties:{ ok:{type:'boolean'}, items:{type:'array'}, nextPageToken:{type:'string'} }, required:['ok','items'] },
              annotations:{ readOnlyHint:true }
            },
            {
              name:'drive.search',
              description:'Drive v2 query (e.g., title contains "…" and trashed=false)',
              inputSchema:{ type:'object', properties:{ q:{type:'string'}, query:{type:'string'}, pageToken:{type:'string'}, pageSize:{type:'integer', minimum:1, maximum:200} }, required:['q'] },
              outputSchema:{ type:'object', properties:{ ok:{type:'boolean'}, items:{type:'array'}, nextPageToken:{type:'string'} }, required:['ok','items'] },
              annotations:{ readOnlyHint:true }
            },
            {
              name:'drive.get',
              description:'Get metadata by file id',
              inputSchema:{ type:'object', properties:{ id:{type:'string'} }, required:['id'] },
              outputSchema:{ type:'object' },
              annotations:{ readOnlyHint:true }
            },
            {
              name:'drive.export',
              description:'Export Google Docs/Sheets/Slides or text',
              inputSchema:{ type:'object', properties:{ id:{type:'string'}, mime:{type:'string'} }, required:['id'] },
              outputSchema:{ type:'object', properties:{ ok:{type:'boolean'}, id:{type:'string'}, srcMime:{type:'string'}, mime:{type:'string'}, size:{type:'integer'}, text:{type:'string'} }, required:['ok','id','mime','text'] },
              annotations:{ readOnlyHint:true }
            }
          ]
        }
      });
    }

    if (method === 'tools/call') {
      if (!requireGasConfig(null, res)) return;
      const { name, arguments: args = {} } = params || {};
      const rid = randomUUID();

      if (name === 'drive.get') {
        const payload = await gasCall('get', { op:'drive.get', id: args.id, rid });
        return res.json({ jsonrpc:'2.0', id:String(id ?? 'call'), result:{ content:[{ type:'object', object: payload }]}});
      }
      if (name === 'drive.export') {
        const payload = await gasCall('export', { op:'drive.export', id: args.id, mime: args.mime || '', rid });
        return res.json({ jsonrpc:'2.0', id:String(id ?? 'call'), result:{ content:[{ type:'object', object: payload }]}});
      }
      if (name === 'drive.search') {
        const payload = await gasCall('search', { op:'drive.search', q: args.q || args.query || '', pageToken: args.pageToken || '', pageSize: args.pageSize || 50, rid });
        return res.json({ jsonrpc:'2.0', id:String(id ?? 'call'), result:{ content:[{ type:'object', object: payload }]}});
      }
      if (name === 'drive.list') {
        const payload = await gasCall('list', { op:'drive.list', folderId: args.folderId || 'root', pageToken: args.pageToken || '', pageSize: args.pageSize || 50, rid });
        return res.json({ jsonrpc:'2.0', id:String(id ?? 'call'), result:{ content:[{ type:'object', object: payload }]}});
      }

      return res.json({ jsonrpc:'2.0', id:String(id ?? 'call'), error:{ code:-32601, message:`Unknown tool: ${name}` }});
    }

    return res.json({ jsonrpc:'2.0', id:String(id ?? 'noop'), error:{ code:-32601, message:`Unknown method: ${method}` }});
  } catch (err) {
    return res.status(500).json({ jsonrpc:'2.0', id:String(id ?? 'err'), error:{ code:-32000, message:String(err?.message || err) }});
  }
});

// Root
app.get('/', (req, res) => res.redirect('/health'));

// Start
app.listen(PORT, () => {
  console.log(`[bridge] ${VERSION} on :${PORT}  origins=${ALLOW_ORIGINS.join(' | ')}`);
});
