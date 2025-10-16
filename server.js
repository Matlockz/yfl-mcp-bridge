// server.js — YFL Drive Bridge (GAS action proxy + MCP over HTTP)
// CommonJS (node ≥18). No "type":"module" required.

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

// ---- App
const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// ---- Env
const PORT         = process.env.PORT || 10000;
const TOKEN        = process.env.TOKEN || process.env.BRIDGE_TOKEN || '';
const GAS_BASE_URL = (process.env.GAS_BASE_URL || '').replace(/\/+$/, '');
const GAS_KEY      = process.env.GAS_KEY || '';
const MCP_PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG        = String(process.env.DEBUG || '0') === '1';

// ---- Auth helper (header OR query "token")
function requireToken(req, res, next) {
  const q  = (req.query.token || '').trim();
  const hd = (req.get('X-Bridge-Token') || '').trim();
  const t  = hd || q;
  if (!TOKEN || t !== TOKEN) {
    return res.status(401).json({ ok: false, error: 'bad token' });
  }
  next();
}

// ---- Tool annotations: tell ChatGPT these are safe, read-only calls
function mapToolsReadOnly(tools = []) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema || t.inputSchema || { type: 'object' },
    // non-normative MCP hint recognized by clients incl. ChatGPT
    annotations: { readOnlyHint: true }
  }));
}

// ---- GAS action helper (follows one redirect to googleusercontent)
async function gasAction(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) {
    throw new Error('GAS not configured (GAS_BASE_URL / GAS_KEY)');
  }

  const usp = new URLSearchParams({ action, token: GAS_KEY });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const url = `${GAS_BASE_URL}?${usp.toString()}`;

  // first request (manual redirect so we can diagnose)
  let r = await fetch(url, { redirect: 'manual' });

  // Apps Script web apps often 302 to script.googleusercontent.com (follow once)
  const loc = r.headers.get('location');
  if ((r.status === 302 || r.status === 303) && loc) {
    r = await fetch(loc, { redirect: 'follow' });
  }

  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    const body = await r.text().catch(() => '');
    throw new Error(
      `GAS returned non-JSON (${r.status} ${ct || 'no-ct'}) — first 200 chars: ${body.slice(0, 200)}`
    );
  }

  const json = await r.json();
  if (DEBUG) console.log('GAS', action, '→', JSON.stringify(json).slice(0, 200));
  return json;
}

// ---- Simple home + health
app.get('/', (_req, res) => res.send('YFL MCP Drive Bridge is running.'));
app.get('/health', async (_req, res) => {
  try {
    const out = await gasAction('health');
    return res.json({
      ok: true,
      protocol: MCP_PROTOCOL,
      gas: !!(out && out.ok),
      ts: out.ts || null
    });
  } catch (e) {
    return res.status(424).json({ ok: false, gas: false, error: String(e?.message || e) });
  }
});

// ---- REST proxy (smoke tests)
app.get('/tools/list', requireToken, async (_req, res) => {
  try {
    const out = await gasAction('tools/list');
    return res.json({ ok: true, tools: mapToolsReadOnly(out.tools || []) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/tools/call', requireToken, async (req, res) => {
  try {
    const { name, arguments: args = {} } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    const out = await gasAction('tools/call', { name, ...args });
    return res.json(out);
  } catch (e) {
    return res.status(424).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---- MCP over HTTP (Inspector & ChatGPT)
const rpcError = (id, code, message) =>
  ({ jsonrpc: '2.0', id, error: { code, message } });

// Some clients ping GET /mcp before POSTing initialize; return 200 OK.
app.get('/mcp', requireToken, (_req, res) => {
  res.json({ ok: true, message: 'MCP endpoint. Use POST /mcp for JSON-RPC.' });
});
app.head('/mcp', requireToken, (_req, res) => res.status(204).end());

app.post('/mcp', requireToken, async (req, res) => {
  const { id, method, params = {} } = req.body || {};
  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.4.6' },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }

    if (method === 'tools/list') {
      const out = await gasAction('tools/list');
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { tools: mapToolsReadOnly(out.tools || []) }
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      if (!name) return res.json(rpcError(id, -32602, 'name is required'));
      const out = await gasAction('tools/call', { name, ...args });
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(out) }],
          structuredContent: out,
          isError: false
        }
      });
    }

    return res.json(rpcError(id, -32601, `unknown method: ${method}`));
  } catch (e) {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: String(e?.message || e) }],
        isError: true
      }
    });
  }
});

// ---- Listen
app.listen(PORT, () => console.log(`YFL MCP Bridge listening on :${PORT}`));
