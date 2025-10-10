// server.js
// YFL MCP Drive Bridge — Streamable HTTP + JSON-RPC (Node >=18, ESM)

import 'dotenv/config';
import express from 'express';

// -------------------- env --------------------
const PORT            = process.env.PORT || 10000;
const GAS_BASE_URL    = process.env.GAS_BASE_URL || '';           // e.g., https://script.google.com/macros/s/…/exec
const GAS_KEY         = process.env.GAS_KEY || '';                // same shared key you used in Apps Script
const BRIDGE_TOKEN    = process.env.BRIDGE_TOKEN || '';           // optional shared secret for /mcp
const PROTOCOL        = process.env.MCP_PROTOCOL || '2024-11-05'; // MCP protocol version

// -------------------- app --------------------
const app = express();

// trust proxy so we can reconstruct https behind Render/Cloudflare
app.set('trust proxy', true);

// Strict, explicit CORS that allows the MCP headers ChatGPT uses
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowOrigin =
    origin &&
    (
      origin.endsWith('chat.openai.com') ||
      origin.endsWith('chatgpt.com')     ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('https://localhost:')
    )
      ? origin
      : '*';

  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // IMPORTANT: allow MCP headers or preflight fails in the connector flow
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Accept,MCP-Protocol-Version,MCP-Client,Authorization,X-Requested-With'
  );
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '1mb' }));

// -------------------- tiny utils --------------------
const ok  = (id, result)                   => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message, data=null) => ({ jsonrpc: '2.0', id, error: { code, message, data } });

function getToken(req) {
  // accept token in query or Authorization: Bearer
  const q = req.query?.token;
  if (q) return String(q);
  const auth = req.headers.authorization || '';
  const m = auth.match(/^\s*Bearer\s+(.+)\s*$/i);
  return m ? m[1] : '';
}

function ensureAuthorized(req, res) {
  if (!BRIDGE_TOKEN) return true; // if not configured, treat as open
  const t = getToken(req);
  if (t && t === BRIDGE_TOKEN) return true;
  res.status(401).json({ ok: false, error: 'unauthorized' });
  return false;
}

function httpsSelfURL(req, pathWithQuery) {
  // Always advertise HTTPS to the client (MUST give a POST endpoint via SSE). Spec: HTTP+SSE transport. 
  // If Render/Cloudflare set x-forwarded-* we honor those.
  const proto = 'https';
  const host  = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}${pathWithQuery}`;
}

// -------------------- health --------------------
app.get('/health', (_req, res) => res.json({ ok: true }));

// -------------------- Drive tools --------------------
async function tool_search(args) {
  const q   = args?.q ?? '';
  const max = Number(args?.max ?? 25);
  const url = `${GAS_BASE_URL}/api/search?q=${encodeURIComponent(q)}&max=${max}&token=${encodeURIComponent(GAS_KEY)}`;
  const r   = await fetch(url);
  const j   = await r.json();
  return [{ type: 'json', json: j?.data ?? j }];
}

async function tool_fetch(args) {
  const id    = String(args?.id ?? '');
  const lines = args?.lines ?? '';
  if (!id) return [{ type: 'text', text: 'Missing "id" argument.' }];

  const url = `${GAS_BASE_URL}/api/fetch?id=${encodeURIComponent(id)}${lines ? `&lines=${lines}` : ''}&token=${encodeURIComponent(GAS_KEY)}`;
  const r   = await fetch(url);
  const j   = await r.json();

  if (j?.data?.inline && typeof j?.data?.text === 'string') {
    return [{ type: 'text', text: j.data.text }];
  }
  return [{ type: 'json', json: j?.data ?? j }];
}

function listTools() {
  // Annotations hint to clients that these are safe to call without extra user prompts.
  const annotations = { readOnlyHint: true, openWorldHint: true };

  return [
    { name: 'search',       description: 'Search Google Drive by file title.',                  inputSchema: { type: 'object', properties: { q: { type: 'string' }, max: { type: 'number' } } }, annotations },
    { name: 'fetch',        description: 'Fetch Drive file by id. If text, returns inline.',   inputSchema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number' } } }, annotations },
    // aliases you already use:
    { name: 'drive_search', description: 'Search Google Drive by file title.',                  inputSchema: { type: 'object', properties: { q: { type: 'string' }, max: { type: 'number' } } }, annotations },
    { name: 'drive_fetch',  description: 'Fetch Drive file by id. If text, returns inline.',   inputSchema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number' } } }, annotations },
  ];
}

async function handleMcp(req, res) {
  try {
    if (!ensureAuthorized(req, res)) return;

    const { id, method, params } = req.body || {};
    const name = params?.name;
    const args = params?.arguments || {};

    if (method === 'initialize') {
      // MCP requires an initialize round-trip declaring the protocol version and capabilities.
      // Spec: Lifecycle / Initialize. 
      return res.json(ok(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} } }));
    }

    if (method === 'tools/list') {
      return res.json(ok(id, { tools: listTools() }));
    }

    if (method === 'tools/call') {
      if (name === 'search' || name === 'drive_search') {
        const content = await tool_search(args);
        return res.json(ok(id, { content }));
      }
      if (name === 'fetch' || name === 'drive_fetch') {
        const content = await tool_fetch(args);
        return res.json(ok(id, { content }));
      }
      return res.json(err(id ?? null, -32601, `Unknown tool: ${name}`));
    }

    return res.json(err(id ?? null, -32601, 'Unknown method'));
  } catch (e) {
    // Always send a valid JSON-RPC error object (don’t throw HTML errors).
    return res.json(err(req.body?.id ?? null, -32000, String(e?.message || e), { stack: e?.stack }));
  }
}

// POST endpoint (JSON-RPC 2.0)
app.post('/mcp', handleMcp);
app.post('/mcp/messages', handleMcp);

// GET endpoint (SSE discovery + keepalive). MUST emit `event: endpoint` with the POST URL.
// Spec: HTTP+SSE transport, “Server-Sent Events Endpoint”. 
app.get('/mcp', (req, res) => {
  if (!ensureAuthorized(req, res)) return;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();

  const tokenSuffix = getToken(req) ? `?token=${encodeURIComponent(getToken(req))}` : (BRIDGE_TOKEN ? '' : '');
  const postURL = httpsSelfURL(req, `/mcp${tokenSuffix}`);

  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ messages: postURL })}\n\n`);

  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30000);
  req.on('close', () => clearInterval(keepalive));
});

// -------------------- start --------------------
app.listen(PORT, () => {
  console.log(`YFL bridge listening on http://localhost:${PORT}`);
});
