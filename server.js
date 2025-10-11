// server.js — YFL MCP Drive Bridge (ESM; Node >= 18)
import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
app.set('trust proxy', 1);

// CORS (allow MCP headers used by the ChatGPT web app)
app.use(cors({
  origin: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','MCP-Protocol-Version','MCP-Client','X-Requested-With','Authorization'],
  exposedHeaders: ['Content-Type'],
  credentials: false,
}));
app.options('*', cors());

app.use(express.json({ limit: '1mb' }));

const PORT       = process.env.PORT || 10000;
const GAS_BASE   = process.env.GAS_BASE_URL || process.env.GAS_BASE;
const GAS_KEY    = process.env.GAS_KEY || process.env.BRIDGE_TOKEN || process.env.TOKEN || process.env.BRIDGE_API_KEY;
const PROTOCOL   = process.env.MCP_PROTOCOL || '2024-11-05';
const BRIDGE_KEY = process.env.BRIDGE_API_KEY || process.env.BRIDGE_TOKEN || process.env.TOKEN;

// ---------- helpers ----------
const jsonrpcOk  = (id, result) => ({ jsonrpc: '2.0', id, result });
const jsonrpcErr = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, data } });

function listTools() {
  const baseInput = (extraProps, required=[]) => ({
    type: 'object',
    properties: extraProps,
    required,
  });

  return [
    {
      name: 'drive_search',
      description: 'Search Google Drive by name (contains).',
      inputSchema: baseInput({
        q:   { type: 'string', description: 'Search term for file name (contains).' },
        max: { type: 'number', description: 'Max results (default 25).' },
      }, ['q']),
      annotations: { title: 'Drive Search', readOnlyHint: true, openWorldHint: true },
    },
    {
      name: 'drive_fetch',
      description: 'Fetch Google Drive file by id; returns text for small text files, else metadata.',
      inputSchema: baseInput({
        id:     { type: 'string', description: 'Drive file id.' },
        lines:  { type: 'number', description: 'For text files, return first N lines (0 = all).' },
        binary: { type: 'boolean', description: 'If true, fetch binary and return base64 (size limits).' }
      }, ['id']),
      annotations: { title: 'Drive Fetch', readOnlyHint: true, openWorldHint: true },
    },
    // aliases some clients prefer:
    {
      name: 'search',
      description: 'Alias of drive_search.',
      inputSchema: baseInput({ q: { type: 'string' }, max: { type: 'number' } }, ['q']),
      annotations: { title: 'Search', readOnlyHint: true, openWorldHint: true },
    },
    {
      name: 'fetch',
      description: 'Alias of drive_fetch.',
      inputSchema: baseInput({ id: { type: 'string' }, lines: { type: 'number' }, binary: { type: 'boolean' } }, ['id']),
      annotations: { title: 'Fetch', readOnlyHint: true, openWorldHint: true },
    },
  ];
}

async function gasCall(kind, params = {}) {
  if (!GAS_BASE || !GAS_KEY) {
    throw Object.assign(new Error('missing GAS_BASE_URL or GAS_KEY'), { code: 'CONFIG' });
  }
  const url = new URL(`${GAS_BASE.replace(/\/+$/,'')}/api/${kind}`);
  url.searchParams.set('token', GAS_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url.toString());
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) {
    throw Object.assign(new Error(`GAS ${kind} ${r.status}`), { status: r.status, body: json });
  }
  return json;
}

async function callTool(name, args = {}) {
  if (name === 'drive_search' || name === 'search') {
    const q = String(args.q ?? '').trim();
    const max = args.max != null ? Number(args.max) : undefined;
    if (!q) throw new Error('q is required');
    const j = await gasCall('search', { q, max });
    const payload = j?.data ?? j;
    return [{ type: 'json', json: payload }];
  }

  if (name === 'drive_fetch' || name === 'fetch') {
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('id is required');
    const lines  = args.lines  != null ? Number(args.lines)  : undefined;
    const binary = args.binary != null ? Boolean(args.binary) : false;
    const j = await gasCall('fetch', { id, lines, binary });
    const d = j?.data ?? j;
    if (!binary && d && typeof d.text === 'string') {
      return [{ type: 'text', text: d.text }];
    }
    return [{ type: 'json', json: d }];
  }

  throw Object.assign(new Error('Unknown tool'), { code: -32601 });
}

async function handleMcp(req, res) {
  try {
    if (BRIDGE_KEY) {
      const tok = req.query.token || req.header('X-Bridge-Token');
      if (tok !== BRIDGE_KEY) {
        return res.status(401).json(jsonrpcErr(req.body?.id ?? null, -32001, 'Unauthorized'));
      }
    }

    const { id, method, params } = req.body || {};
    if (method === 'initialize') {
      return res.json(jsonrpcOk(id, {
        protocolVersion: PROTOCOL,
        serverInfo: { name: 'yfl-mcp-bridge', version: '1.0.0' },
        // ➜ Important for MCP tools declaration
        capabilities: { tools: { listChanged: true } },
      }));
    }

    if (method === 'tools/list') {
      return res.json(jsonrpcOk(id, { tools: listTools() }));
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const a = params?.arguments ?? {};
      const content = await callTool(name, a);
      return res.json(jsonrpcOk(id, { content, isError: false }));
    }

    return res.json(jsonrpcErr(id ?? null, -32601, 'Method not found'));
  } catch (e) {
    return res.json(jsonrpcErr(req.body?.id ?? null, -32000, String(e?.message || e), { stack: String(e?.stack || ''), cause: e?.cause }));
  }
}

// ---------- health ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ---------- legacy REST probes (optional) ----------
app.get('/search', async (req, res) => {
  try {
    const data = await gasCall('search', { q: req.query.q, max: req.query.max });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), data: e?.body, status: e?.status });
  }
});
app.get('/fetch', async (req, res) => {
  try {
    const data = await gasCall('fetch', { id: req.query.id, lines: req.query.lines, binary: req.query.binary });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e), data: e?.body, status: e?.status });
  }
});

// ---------- MCP endpoint (Streamable HTTP + legacy SSE discovery) ----------
app.post('/mcp', handleMcp);
app.post('/mcp/messages', handleMcp);

app.get('/mcp', (req, res) => {
  if (!String(req.headers.accept || '').includes('text/event-stream')) {
    return res.status(405).send('Use POST for JSON‑RPC. To open SSE, request with Accept: text/event-stream.');
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ url: fullUrl })}\n\n`);

  const t = setInterval(() => res.write(': keepalive\n\n'), 30000);
  req.on('close', () => clearInterval(t));
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
