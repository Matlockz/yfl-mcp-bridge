// yfl-mcp-bridge — minimal, dependable HTTP bridge for MCP ↔ Google Apps Script
// Version: 3.3.2 (HTTP transport: 2024-11-05)
//
// Routes
//   GET  /health                                     -> {"ok":true,"protocol":"2024-11-05","gas":<bool>}
//   GET  /mcp?token=...   (SSE endpoint discovery)   -> event: endpoint, data: {"url":"https://.../mcp?token=..."}
//   POST /mcp?token=...   (JSON-RPC for MCP)         -> initialize, tools/list, tools/call
//
// Env
//   TOKEN         required – shared token used by ChatGPT/Inspector (same as GAS SHARED_KEY is OK)
//   GAS_BASE_URL  required – Apps Script Web App URL e.g. https://script.google.com/macros/s/…/exec
//   GAS_KEY       required – SHARED_KEY value configured in Apps Script properties
//   MCP_PROTOCOL  optional – defaults to 2024-11-05

import express from 'express';
import cors from 'cors';

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const TOKEN        = process.env.TOKEN || process.env.BRIDGE_TOKEN || '';
const GAS_BASE_URL = (process.env.GAS_BASE_URL || '').replace(/\/+$/, '');
const GAS_KEY      = process.env.GAS_KEY || process.env.SHARED_KEY || '';
const PROTOCOL     = process.env.MCP_PROTOCOL || '2024-11-05';

const PORT = process.env.PORT || 10000;

// --- small helpers ----------------------------------------------------------
function json(res, code, body) {
  res.status(code).type('application/json').send(JSON.stringify(body));
}

function isOkJson(resp) {
  const ct = resp.headers.get('content-type') || '';
  return resp.ok && ct.includes('application/json');
}

function firstChars(s, n = 200) {
  return String(s || '').slice(0, n);
}

function ensureAuthorized(req, res, next) {
  const qTok = (req.query.token || '').trim();
  const hAuth = (req.get('authorization') || '').replace(/^bearer\s+/i, '').trim();
  const hX = (req.get('x-bridge-token') || '').trim();
  const tok = qTok || hAuth || hX;
  if (!TOKEN || tok !== TOKEN) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }
  return next();
}

function gasUrl(path, params = {}) {
  const u = new URL(GAS_BASE_URL + path);
  u.searchParams.set('token', GAS_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// follow redirects; surface HTML-logins cleanly
async function callGAS(path, params = {}) {
  const url = gasUrl(path, params);
  const resp = await fetch(url, { redirect: 'follow', headers: { accept: 'application/json' } });
  if (isOkJson(resp)) {
    return { ok: true, json: await resp.json() };
  }
  const text = await resp.text();
  const ct = resp.headers.get('content-type') || '';
  const isSignin = /accounts\.google\.com\/v3\/signin/i.test(text);
  const msg = `GAS returned non-JSON (${resp.status} ${ct}) — first 200 chars: ${firstChars(text)}`;
  return { ok: false, error: msg, signin: isSignin, base: GAS_BASE_URL };
}

// --- routes -----------------------------------------------------------------
app.get('/health', async (req, res) => {
  // soft check of GAS
  let gas = false; let err;
  try {
    const r = await callGAS('/api/health');
    gas = !!(r.ok && r.json && r.json.ok === true);
    err = r.ok ? undefined : r.error;
  } catch (e) {
    err = String(e && e.message || e);
  }
  const body = { ok: true, protocol: PROTOCOL, gas };
  if (!gas && err) body.error = err;
  return json(res, gas ? 200 : 424, body);
});

// SSE endpoint discovery (per MCP HTTP transport)
// The client connects here, we immediately emit a single 'endpoint' event then keep open.
app.get('/mcp', ensureAuthorized, (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // tell the client where to POST JSON-RPC
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`; // includes ?token=
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ url })}\n\n`);
  // heartbeat to keep proxies happy
  const iv = setInterval(() => res.write(': keepalive\n\n'), 15000);
  req.on('close', () => clearInterval(iv));
});

// JSON-RPC endpoint
app.post('/mcp', ensureAuthorized, async (req, res) => {
  const m = req.body || {};
  const id = m.id ?? null;
  async function ok(result) { return json(res, 200, { jsonrpc: '2.0', id, result }); }
  async function err(message) { return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32000, message } }); }

  try {
    switch (m.method) {
      case 'initialize':
        return ok({
          protocolVersion: PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.3.2' },
          capabilities: { tools: { listChanged: true } }
        });

      case 'tools/list':
        return ok({
          tools: [
            {
              name: 'search',
              description: 'Search Google Drive by filename (contains).',
              inputSchema: {
                type: 'object',
                properties: { q: { type: 'string' }, max: { type: 'number' }, mode: { type: 'string' } },
                required: ['q']
              }
            },
            {
              name: 'fetch',
              description: 'Fetch by file id; inline text when possible, else JSON metadata.',
              inputSchema: {
                type: 'object',
                properties: { id: { type: 'string' }, lines: { type: 'number' } },
                required: ['id']
              }
            },
            { name: 'drive_search', description: 'Alias of search', inputSchema: { type: 'object', properties: { q: { type: 'string' }, max: { type: 'number' } }, required: ['q'] } },
            { name: 'drive_fetch', description: 'Alias of fetch',  inputSchema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number' } }, required: ['id'] } }
          ]
        });

      case 'tools/call': {
        const { name, arguments: args } = m.params || {};
        if (!name) return err('missing tool name');
        if (name === 'search' || name === 'drive_search') {
          const q = String((args && args.q) || '').trim();
          const max = Math.max(1, Math.min(100, Number((args && args.max) || 25)));
          if (!q) return ok({ content: [{ type: 'text', text: 'q is required' }], isError: true });
          const r = await callGAS('/api/search', { q, max });
          if (!r.ok) return ok({ content: [{ type: 'text', text: r.error }], isError: true });
          return ok({ content: [{ type: 'json', json: r.json }], isError: false });
        }
        if (name === 'fetch' || name === 'drive_fetch') {
          const id = String((args && args.id) || '').trim();
          const lines = Math.max(0, Math.min(1_000_000, Number((args && args.lines) || 0)));
          if (!id) return ok({ content: [{ type: 'text', text: 'id is required' }], isError: true });
          const r = await callGAS('/api/fetch', { id, lines });
          if (!r.ok) return ok({ content: [{ type: 'text', text: r.error }], isError: true });
          return ok({ content: [{ type: 'json', json: r.json }], isError: false });
        }
        return err('unknown tool: ' + name);
      }

      default:
        return err('unknown method: ' + m.method);
    }
  } catch (e) {
    return err(String(e && e.message || e));
  }
});

app.listen(PORT, () => {
  console.log(`[yfl-mcp-bridge] listening on :${PORT} (protocol ${PROTOCOL})`);
});
