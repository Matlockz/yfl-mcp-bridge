// YFL MCP Drive Bridge — Streamable HTTP + JSON-RPC (ESM, Node >= 18)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';

// ---------- env ----------
const PORT           = process.env.PORT || 10000;
const GAS_BASE_URL   = process.env.GAS_BASE_URL || '';
const GAS_KEY        = process.env.GAS_KEY || '';
const BRIDGE_TOKEN   = process.env.BRIDGE_TOKEN || '';
const PROTOCOL       = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG          = !!Number(process.env.DEBUG || 0);

// ---------- app ----------
const app = express();
app.set('trust proxy', true);

// CORS: allow ChatGPT (and fall back to *)
const ALLOW_ORIGINS = new Set([
  'https://chat.openai.com',
  'https://chatgpt.com',
  'https://stg.chat.openai.com',
  'http://localhost:5173',
  'http://localhost:3000'
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type,MCP-Protocol-Version,MCP-Client,X-Requested-With,Authorization'
  );
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '1mb' }));

// ---------- helpers ----------
const ok  = (id, result)                   => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message, data=null) => ({ jsonrpc: '2.0', id, error: { code, message, data } });

function required(v, name) {
  if (!v) throw new Error(`Missing required env: ${name}`);
}

function toolAnnotations() {
  // Advises ChatGPT these tools are safe to auto-call in read-only mode.
  return { readOnlyHint: true, openWorldHint: true };
}

function listTools() {
  const annotations = toolAnnotations();
  return [
    {
      name: 'search',
      description: 'Search Google Drive by file title (contains).',
      inputSchema: { type: 'object', properties: { q: { type: 'string' }, max: { type: 'number' } } },
      annotations
    },
    {
      name: 'fetch',
      description: 'Fetch a Google Drive file by id. If text, returns inline text.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number' } } },
      annotations
    },
    // Aliases preserved for your habits
    {
      name: 'drive_search',
      description: 'Alias of search.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' }, max: { type: 'number' } } },
      annotations
    },
    {
      name: 'drive_fetch',
      description: 'Alias of fetch.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number' } } },
      annotations
    },
  ];
}

async function fetchStrictJson(url, tag) {
  const r = await fetch(url, { redirect: 'follow' });
  const ct = String(r.headers.get('content-type') || '').toLowerCase();
  const text = await r.text();

  if (!r.ok) {
    if (DEBUG) console.error(`[${tag}] non-200 from GAS`, { status: r.status, body: text.slice(0, 500) });
    throw Object.assign(new Error(`Upstream ${r.status}`), { status: r.status, body: text });
  }

  // Apps Script should return JSON via ContentService; guard against HTML/other
  if (!ct.includes('application/json')) {
    // Try to parse anyway; if it fails, throw a typed error the UI can display.
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error('Upstream non-JSON payload'), { status: 502, body: text.slice(0, 500) });
    }
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw Object.assign(new Error('Invalid JSON from upstream'), { status: 502, body: text.slice(0, 500) });
  }
}

async function callTool(name, args) {
  required(GAS_BASE_URL, 'GAS_BASE_URL');
  required(GAS_KEY, 'GAS_KEY');

  // Normalize aliases
  if (name === 'drive_search') name = 'search';
  if (name === 'drive_fetch')  name = 'fetch';

  if (name === 'search') {
    const q   = args?.q ?? '';
    const max = Number(args?.max ?? 25);
    const url = `${GAS_BASE_URL}/api/search?q=${encodeURIComponent(q)}&max=${max}&token=${encodeURIComponent(GAS_KEY)}`;
    const j   = await fetchStrictJson(url, 'search');
    // Prefer `{ files: [...] }` style JSON; otherwise wrap whatever came back
    const payload = j?.data ?? j;
    return [{ type: 'json', json: payload }];
  }

  if (name === 'fetch') {
    const id    = String(args?.id ?? '');
    const lines = args?.lines ? Number(args.lines) : '';
    if (!id) return [{ type: 'text', text: 'Missing "id" argument.' }];

    const url = `${GAS_BASE_URL}/api/fetch?id=${encodeURIComponent(id)}${lines?`&lines=${lines}`:''}&token=${encodeURIComponent(GAS_KEY)}`;
    const j   = await fetchStrictJson(url, 'fetch');
    const payload = j?.data ?? j;

    // If GAS returns inline text (our convention), prefer text for readability
    if (payload?.inline && typeof payload?.text === 'string') {
      return [{ type: 'text', text: payload.text }];
    }
    return [{ type: 'json', json: payload }];
  }

  throw Object.assign(new Error('Unknown tool'), { code: -32601 });
}

function requireBridgeToken(req) {
  // Accept token in query (?token=...) or header (x-bridge-token)
  const qt = req.query?.token;
  const ht = req.header('x-bridge-token');
  return (BRIDGE_TOKEN && (qt === BRIDGE_TOKEN || ht === BRIDGE_TOKEN));
}

async function handleMcp(req, res) {
  try {
    // Require token if configured
    if (BRIDGE_TOKEN && !requireBridgeToken(req)) {
      return res.json(err(req.body?.id ?? null, -32001, 'Unauthorized (token missing or invalid)'));
    }

    const { id, method, params } = req.body || {};
    if (method === 'initialize') {
      return res.json(ok(id, {
        protocolVersion: PROTOCOL,
        serverInfo: { name: 'YFL Drive Bridge', version: '1.0.0' },
        // Keep tools list stable; setting tools capability is fine
        capabilities: { tools: { listChanged: false } }
      }));
    }

    if (method === 'tools/list') {
      return res.json(ok(id, { tools: listTools() }));
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const content = await callTool(name, args || {});
      return res.json(ok(id, { content }));
    }

    return res.json(err(id ?? null, -32601, 'Unknown method'));
  } catch (e) {
    if (DEBUG) console.error('tools error', e);
    const status = e?.status || 500;
    // Map upstream failures to a single JSON-RPC error; avoid 424s in the UI
    return res.json(err(req.body?.id ?? null, -32000,
      `Bridge error (${status}) — ${e?.message || e}`, { status, body: e?.body }));
  }
}

// ---------- REST health ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Streamable HTTP discovery ----------
app.get('/mcp', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const base = `${req.protocol}://${req.get('host')}/mcp`;
  const token = req.query?.token ? `?token=${encodeURIComponent(req.query.token)}` : '';
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ messages: `${base}${token}` })}\n\n`);

  const t = setInterval(() => res.write(': keepalive\n\n'), 30000);
  req.on('close', () => clearInterval(t));
});

// ---------- JSON-RPC over POST (preferred) ----------
app.post('/mcp', handleMcp);
app.post('/mcp/messages', handleMcp); // compatibility

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
