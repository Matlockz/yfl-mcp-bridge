// YFL MCP Drive Bridge 3.4.1  (ESM / Node 18+)
// - No dotenv required. Reads process.env directly.
// - Proxies GAS "action" endpoints and exposes REST + MCP over streamable HTTP.

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

const app = express();

// CORS for ChatGPT + Inspector
const ALLOW_ORIGINS = [
  'https://chat.openai.com',
  'https://chatgpt.com',
  'http://localhost:6274', // MCP Inspector
  'http://127.0.0.1:6274',
];
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOW_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, true); // permissive for local testing
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'X-Bridge-Token',
      'Authorization',
      'MCP-Protocol-Version',
    ],
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.BRIDGE_TOKEN || process.env.TOKEN || '';
const GAS_BASE_URL = String(process.env.GAS_BASE_URL || '').replace(/\/$/, ''); // no trailing slash
const GAS_KEY = process.env.GAS_KEY || process.env.SHARED_KEY || '';
const MCP_PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG = String(process.env.DEBUG || '0') === '1';

function requireToken(req, res, next) {
  const hdrAuth = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const provided =
    (req.query.token || req.get('X-Bridge-Token') || hdrAuth || '').trim();

  if (!TOKEN) return res.status(401).json({ ok: false, error: 'token not configured on server' });
  if (provided !== TOKEN) return res.status(401).json({ ok: false, error: 'bad token' });
  return next();
}

function qs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

// --- low-level call into GAS using your proven ?action=... API
async function gasAction(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('GAS_BASE_URL or GAS_KEY missing');
  const url = `${GAS_BASE_URL}?action=${encodeURIComponent(action)}&${qs({
    ...params,
    token: GAS_KEY,
  })}`;

  const r = await fetch(url, { redirect: 'manual' });
  const ct = (r.headers.get('content-type') || '').toLowerCase();

  if (!ct.includes('application/json')) {
    const text = await r.text();
    throw new Error(
      `GAS returned non-JSON (${r.status} ${ct || 'no-ct'}) — first 200 chars: ${text.slice(
        0,
        200,
      )}`,
    );
  }
  return await r.json();
}

// ---------------- REST proxies (used by smoke tests) ----------------

app.get('/health', async (req, res) => {
  try {
    const body = await gasAction('health');
    return res.json({ ok: true, gas: !!(body && body.ok), ts: body.ts || new Date().toISOString() });
  } catch (e) {
    if (DEBUG) console.error(e);
    return res
      .status(424)
      .json({ ok: false, error: String((e && e.message) || e) });
  }
});

app.get('/tools/list', requireToken, async (req, res) => {
  try {
    const body = await gasAction('tools/list');
    return res.json(body);
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
});

app.post('/tools/call', requireToken, async (req, res) => {
  try {
    const { name, arguments: args = {} } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    const body = await gasAction('tools/call', { name, ...args });
    return res.json(body);
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
});

// also support GET /tools/call?name=... for quick testing
app.get('/tools/call', requireToken, async (req, res) => {
  try {
    const { name, ...args } = req.query || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    const body = await gasAction('tools/call', { name, ...args });
    return res.json(body);
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(502).json({ ok: false, error: String((e && e.message) || e) });
  }
});

// ---------------- MCP (streamable HTTP) endpoint ----------------

app.post('/mcp', requireToken, async (req, res) => {
  const { id, method, params = {} } = req.body || {};

  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.4.1' },
          capabilities: { tools: { listChanged: true } },
        },
      });
    }

    if (method === 'tools/list') {
      const out = await gasAction('tools/list');
      const tools = (out.tools || []).map((t) => ({
        name: t.name,
        description: t.description,
        // GAS returns input_schema; MCP expects inputSchema
        inputSchema: t.input_schema || t.inputSchema || { type: 'object' },
      }));
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      if (!name)
        return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'name is required' } });
      const out = await gasAction('tools/call', { name, ...args });
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: out }], isError: false } });
    }

    return res.json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `unknown method: ${method}` },
    });
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.json({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true },
    });
  }
});

app.get('/', (req, res) => res.send('YFL MCP Drive Bridge is running.'));
app.listen(PORT, () => console.log(`YFL MCP Bridge listening on :${PORT}`));
