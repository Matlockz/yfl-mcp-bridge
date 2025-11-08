// server.mjs — YFL Drive Bridge (Streamable HTTP MCP) — v3.4.6
// Endpoints: /health (public), /mcp (POST Streamable HTTP; GET/HEAD for probes)
// Tools: drive.search, drive.list, drive.get, drive.export (GAS-backed)

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import fetch from 'node-fetch';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const VERSION = process.env.BRIDGE_VERSION || '3.4.6';
const PORT    = Number(process.env.PORT || 5050);

// GAS web app (deployed “Anyone with the link”), v2 Drive semantics
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY      = process.env.GAS_KEY || process.env.TOKEN || 'v3c3NJQ4i94'; // per your request
const SHARED_KEY   = process.env.SHARED_KEY || '';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || 'v3c3NJQ4i94';                 // per your request

// CORS allow list (include ChatGPT web)
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || 'https://chatgpt.com,https://chat.openai.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.use(express.json({ limit: '5mb' }));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const ok = ALLOW_ORIGINS.includes(origin);
    return cb(ok ? null : new Error('CORS'), ok);
  },
  methods: ['GET','POST','HEAD','OPTIONS','DELETE'],
  allowedHeaders: ['content-type','authorization','x-bridge-token','x-mcp-auth','mcp-session-id'],
  exposedHeaders: ['Mcp-Session-Id','x-bridge-version','x-request-id'],
  maxAge: 600,
  credentials: true
}));
morgan.token('rid', req => req.id || '');
app.use((req, _res, next) => { req.id = randomUUID(); next(); });
app.use(morgan(':method :url :status :res[content-length] - :response-time ms rid=:rid'));

function ts() { return new Date().toISOString(); }
const rid = req => (req.id || 'r0');

// ---------- Helpers ----------
function buildGasUrl(params) {
  const u = new URL(GAS_BASE_URL);
  Object.entries(params || {}).forEach(([k, v]) => (v !== undefined && v !== null) && u.searchParams.set(k, String(v)));
  u.searchParams.set('token', GAS_KEY);
  return u.toString();
}
async function gasCall(tool, params) {
  if (!GAS_BASE_URL) throw new Error('GAS_BASE_URL not configured');
  const url = buildGasUrl({ tool, ...params });
  const resp = await fetch(url, { redirect: 'follow', headers: { accept: 'application/json,text/plain;q=0.8,*/*;q=0.5' } });
  const text = await resp.text();
  try { return JSON.parse(text); }
  catch { return { ok:false, error:`GAS non-JSON (${resp.status} ${resp.headers.get('content-type')})`, preview:text.slice(0,500) }; }
}
function authOk(req) {
  // Allow token for CLI/Inspector; allow “No auth” for ChatGPT origins
  const token = String(req.headers['x-bridge-token'] || req.query.token || req.headers.authorization?.replace(/^Bearer\s+/i,'') || '');
  const fromUi = !!req.headers.origin && ALLOW_ORIGINS.includes(req.headers.origin);
  return fromUi ? true : (BRIDGE_TOKEN && token && token === BRIDGE_TOKEN);
}

// ---------- MCP server (official transport) ----------
const mcp = new McpServer({ name: 'YFL Drive Bridge', version: VERSION });

// Tools (surface matches your existing four)
mcp.tool(
  'drive.search',
  {
    title: 'Drive search (v2)',
    description: 'Search files: e.g., title contains "LATEST" and trashed=false',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        pageSize: { type: 'integer', minimum: 1, maximum: 200 },
        pageToken: { type: 'string' }
      },
      required: ['q']
    },
    outputSchema: { type: 'object', properties: { ok:{type:'boolean'}, items:{type:'array'} }, required:['ok','items'] }
  },
  async ({ q, pageSize, pageToken }, _ctx) => {
    if (!q || !String(q).trim()) return { content:[{ type:'text', text:'invalid q' }], isError:true };
    const out = await gasCall('drive.search', { q:String(q), pageSize, pageToken });
    return {
      content: [{ type: 'text', text: JSON.stringify(out) }],
      structuredContent: out
    };
  }
);
mcp.tool(
  'drive.list',
  {
    title: 'Drive list by folder',
    description: 'List files by Drive folder ID (or root)',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type:'string' },
        pageSize: { type:'integer', minimum:1, maximum:200 },
        pageToken: { type:'string' }
      }
    },
    outputSchema: { type:'object', properties:{ ok:{type:'boolean'}, items:{type:'array'} }, required:['ok','items'] }
  },
  async ({ folderId, pageSize, pageToken }) => {
    const out = await gasCall('drive.list', { folderId, pageSize, pageToken });
    return { content:[{ type:'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);
mcp.tool(
  'drive.get',
  {
    title: 'Drive get by id',
    description: 'Get metadata for a file id',
    inputSchema: { type:'object', properties:{ id:{type:'string'} }, required:['id'] },
    outputSchema: { type:'object' }
  },
  async ({ id }) => {
    const out = await gasCall('drive.get', { id });
    return { content:[{ type:'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);
mcp.tool(
  'drive.export',
  {
    title: 'Drive export',
    description: 'Export Google Docs/Sheets/Slides or text',
    inputSchema: { type:'object', properties:{ id:{type:'string'}, mime:{type:'string'} }, required:['id'] },
    outputSchema: { type:'object', properties:{ ok:{type:'boolean'}, id:{type:'string'}, srcMime:{type:'string'}, mime:{type:'string'}, size:{type:'integer'}, text:{type:'string'} }, required:['ok','id','mime','text'] }
  },
  async ({ id, mime }) => {
    const out = await gasCall('drive.export', { id, mime });
    return { content:[{ type:'text', text: JSON.stringify(out) }], structuredContent: out };
  }
);

// Health / probes
app.get('/health', (_req, res) => res.json({ ok:true, version:VERSION, ts:ts() }));
app.head('/health', (_req, res) => res.status(204).end());

// MCP: HEAD/GET probe (no auth required for UI origins)
app.head('/mcp', (req, res) => res.status(authOk(req) ? 204 : 204).end());
app.get('/mcp',  (req, res) => res.json({ ok:true, transport:'streamable-http', version:VERSION, ts:ts() }));

// MCP: Streamable HTTP (official transport) — POST
app.post('/mcp', async (req, res) => {
  if (!authOk(req)) return res.status(401).json({ jsonrpc:'2.0', id:String(req.body?.id || '1'), error:{ code:-32001, message:'unauthorized' }});
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.setHeader('x-bridge-version', VERSION);
  res.on('close', () => transport.close());
  await mcp.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Root (optional)
app.get('/', (_req, res) => res.json({ ok:true, service:'YFL Drive Bridge', version:VERSION, ts:ts() }));

app.listen(PORT, () => {
  console.log(`YFL Bridge listening on :${PORT} — POST http://localhost:${PORT}/mcp`);
});
