// YFL MCP Drive Bridge — JSON‑RPC over HTTP + SSE discovery
import 'dotenv/config';
import express from 'express';

// ---------- env ----------
const PORT           = process.env.PORT || 10000;
const GAS_BASE_URL   = process.env.GAS_BASE_URL || process.env.GAS_BASE || '';
const GAS_KEY        = process.env.GAS_KEY || process.env.TOKEN || '';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || process.env.BRIDGE_API || '';
const PROTOCOL       = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG          = (process.env.DEBUG || '').toString() === '1';

// ---------- app ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allow = new Set([
    'https://chat.openai.com', 'https://chatgpt.com', 'https://stg.chat.openai.com',
    'http://localhost:5173', 'http://localhost:3000'
  ]);
  res.setHeader('Access-Control-Allow-Origin', origin && allow.has(origin) ? origin : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type,MCP-Protocol-Version,MCP-Client,X-Requested-With,Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---------- health ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

// --- Add near top ---
async function gasJson(url, attempt = 1) {
  const r = await fetch(url, { redirect: 'follow' });
  const text = await r.text();

  // If Apps Script returns the Google login page, that's an auth misconfig.
  // Detect by 'accounts.google.com' in HTML and throw a clean error.
  if (text.includes('accounts.google.com')) {
    throw new Error('Apps Script requires login (web app not deployed as "Anyone").');
  }

  // Try to parse JSON; if not JSON, raise error with a snippet.
  try {
    return JSON.parse(text);
  } catch {
    if (attempt < 2 && (r.status >= 500 || r.status === 429)) {
      await new Promise(res => setTimeout(res, 400));
      return gasJson(url, attempt + 1);
    }
    throw new Error(`Unexpected non‑JSON from GAS (status ${r.status}).`);
  }
}

// --- In callTool(), replace the two fetches with gasJson(...):

// search / drive_search
if (name === 'search' || name === 'drive_search') {
  const q   = args?.q ?? '';
  const max = Number(args?.max ?? 25);
  const url = `${GAS_BASE_URL}/api/search?q=${encodeURIComponent(q)}&max=${max}&token=${encodeURIComponent(GAS_KEY)}`;
  const j   = await gasJson(url);
  return [{ type: 'json', json: j?.data ?? j }];
}

// fetch / drive_fetch
if (name === 'fetch' || name === 'drive_fetch') {
  const id    = String(args?.id ?? '');
  const lines = args?.lines ?? '';
  if (!id) return [{ type: 'text', text: 'Missing "id" argument.' }];
  const url = `${GAS_BASE_URL}/api/fetch?id=${encodeURIComponent(id)}${lines?`&lines=${lines}`:''}&token=${encodeURIComponent(GAS_KEY)}`;
  const j   = await gasJson(url);
  if (j?.data?.inline && j?.data?.text) return [{ type:'text', text: j.data.text }];
  return [{ type: 'json', json: j?.data ?? j }];
}


// ---------- small helper ----------
async function fetchJsonOrText(url) {
  const r = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  const text = await r.text();
  try {
    return { ok: r.ok, status: r.status, json: JSON.parse(text) };
  } catch {
    return { ok: r.ok, status: r.status, text };
  }
}

function ok(id, result)                   { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message, data){ return { jsonrpc: '2.0', id, error: { code, message, data } }; }

// GAS call tolerant to *both* styles: `/exec/api/{route}` and `?route={route}`
async function callGAS(route, params) {
  if (!GAS_BASE_URL) throw new Error('GAS_BASE_URL missing');
  if (!GAS_KEY)      throw new Error('GAS_KEY missing');

  const qp = new URLSearchParams({ ...params, token: GAS_KEY }).toString();

  // 1) path style
  const u1 = `${GAS_BASE_URL.replace(/\/$/, '')}/api/${route}?${qp}`;
  let out = await fetchJsonOrText(u1);

  // 2) query style (fallback) — Apps Script commonly routes by query only
  if (!out.ok || (!out.json && !out.text)) {
    const u2 = `${GAS_BASE_URL.replace(/\/$/, '')}?route=${encodeURIComponent(route)}&${qp}`;
    out = await fetchJsonOrText(u2);
    if (DEBUG) console.log('[GAS fallback]', route, out.status);
  }

  if (!out.ok) {
    // bubble up a helpful error that MCP clients can show
    const snippet = (out.text || JSON.stringify(out.json || {})).slice(0, 400);
    throw Object.assign(new Error(`GAS ${route} failed (${out.status})`), { details: snippet });
  }

  const payload = out.json ?? { inline: true, text: out.text ?? '' };
  // normalize into { data: ... } if script returned raw object
  return payload?.data ?? payload;
}

// ---------- tools ----------
function listTools() {
  const annotations = { readOnlyHint: true, openWorldHint: true };
  return [
    { name: 'search',       description: 'Search Drive by file title.',
      inputSchema: { type: 'object', properties: { q:{type:'string'}, max:{type:'number'} } }, annotations },
    { name: 'fetch',        description: 'Fetch Drive file by id; returns inline text when available.',
      inputSchema: { type: 'object', properties: { id:{type:'string'}, lines:{type:'number'} } }, annotations },
    { name: 'drive_search', description: 'Alias of search.', inputSchema: { type: 'object' }, annotations },
    { name: 'drive_fetch',  description: 'Alias of fetch.',  inputSchema: { type: 'object' }, annotations },
  ];
}

async function callTool(name, args={}) {
  if (DEBUG) console.log('[tools/call]', name, args);
  const route = (name === 'fetch' || name === 'drive_fetch') ? 'fetch' : 'search';

  if (route === 'search') {
    const q   = args.q ?? '';
    const max = Number(args.max ?? 25);
    const data = await callGAS('search', { q, max });
    return [{ type: 'json', json: data }];             // expects { files: [...] }
  }
  if (route === 'fetch') {
    const id    = String(args.id ?? '');
    const lines = args.lines ?? '';
    if (!id) return [{ type: 'text', text: 'Missing "id".' }];
    const data  = await callGAS('fetch', { id, ...(lines ? { lines } : {}) });
    if (data?.inline && data?.text) return [{ type:'text', text: data.text }];
    return [{ type:'json', json: data }];
  }
  throw Object.assign(new Error('Unknown tool'), { code: -32601 });
}

// ---------- JSON-RPC handler ----------
app.post('/mcp', async (req, res) => {
  try {
    const { id, method, params } = req.body || {};
    if (method === 'initialize') {
      return res.json(ok(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} }
      }));
    }
    if (method === 'tools/list') {
      return res.json(ok(id, { tools: listTools() }));
    }
    if (method === 'tools/call') {
      const { name, arguments: a } = params || {};
      const content = await callTool(name, a || {});
      return res.json(ok(id, { content }));
    }
    return res.json(rpcError(id ?? null, -32601, 'Unknown method'));
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.json(rpcError(req.body?.id ?? null, -32000, String(e?.message || e), { details: e?.details }));
  }
});

// also accept the legacy path some clients probe
app.post('/mcp/messages', (req, res) => app._router.handle(req, res));

// SSE discovery with token propagation
app.get('/mcp', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  const token = req.query.token ? `?token=${encodeURIComponent(req.query.token)}` : '';
  const abs = `${req.protocol}://${req.get('host')}/mcp${token}`;
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ messages: abs })}\n\n`);
  const t = setInterval(() => res.write(': keepalive\n\n'), 30000);
  req.on('close', () => clearInterval(t));
});

// ---------- start ----------
app.listen(PORT, () => console.log(`YFL bridge listening on :${PORT}`));
