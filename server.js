'use strict';

// YFL Drive Bridge — GAS action proxy + MCP over HTTP (CommonJS)
// Node 18+ (global fetch available)

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

// ----- App & middleware
const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// ----- Env
const PORT         = process.env.PORT || 10000;
const TOKEN        = process.env.TOKEN || process.env.BRIDGE_TOKEN || '';
const GAS_BASE_URL = (process.env.GAS_BASE_URL || '').replace(/\/+$/, '');
const GAS_KEY      = process.env.GAS_KEY || '';
const MCP_PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG        = String(process.env.DEBUG || '0') === '1';

// ----- Auth for /tools/* and /mcp (header or query)
function requireToken(req, res, next) {
  const q  = (req.query.token || '').trim();
  const hd = (req.get('X-Bridge-Token') || '').trim();
  const t  = hd || q;
  if (!TOKEN || t !== TOKEN) return res.status(401).json({ ok: false, error: 'bad token' });
  next();
}

// ----- Read-only tool annotations (MCP)
function mapToolsReadOnly(tools = []) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema || t.inputSchema || { type: 'object' },
    annotations: { readOnlyHint: true }
  }));
}

// ----- GAS action helper (manual 302 follow + JSON guard)
async function gasAction(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('GAS not configured (GAS_BASE_URL / GAS_KEY)');

  const usp = new URLSearchParams({ action, token: GAS_KEY });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const url = `${GAS_BASE_URL}?${usp.toString()}`;

  // First request (don’t auto-follow so we can diagnose)
  let r = await fetch(url, { redirect: 'manual' });

  // If Apps Script redirects to googleusercontent, follow once
  const loc = r.headers.get('location');
  if ((r.status === 302 || r.status === 303) && loc && /script\.googleusercontent\.com/i.test(loc)) {
    r = await fetch(loc, { redirect: 'follow' });
  }

  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const text = await r.text();

  if (!ct.includes('application/json')) {
    throw new Error(
      `GAS returned non-JSON (${r.status} ${ct || 'no-ct'}) — first 200 chars: ${text.slice(0, 200)}`
    );
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON from GAS: ${e.message} — first 200 chars: ${text.slice(0, 200)}`);
  }

  if (DEBUG) console.log('GAS', action, '→', text.slice(0, 200));
  return json;
}

// ----- REST (for local smoke tests)

app.get('/health', async (_req, res) => {
  try {
    const out = await gasAction('health');
    return res.json({ ok: true, protocol: MCP_PROTOCOL, gas: !!(out && out.ok), ts: out.ts || null });
  } catch (e) {
    return res.status(424).json({ ok: false, gas: false, error: String(e?.message || e) });
  }
});

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

// ----- MCP over HTTP (Inspector / ChatGPT connector)

app.get('/mcp', requireToken, (_req, res) => {
  // Lightweight GET so clients that probe with GET don’t get 404.
  return res.json({ ok: true, mcp: true, protocol: MCP_PROTOCOL, server: 'yfl-drive-bridge' });
});

app.post('/mcp', requireToken, async (req, res) => {
  const { id, method, params = {} } = req.body || {};
  const rpcError = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

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
      const tools = mapToolsReadOnly(out.tools || []);
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      if (!name) return rpcError(-32602, 'name is required');
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

    return rpcError(-32601, `unknown method: ${method}`);
  } catch (e) {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: String(e?.message || e) }], isError: true }
    });
  }
});

// ----- Root
app.get('/', (_req, res) => res.send('YFL MCP Drive Bridge is running.'));
app.listen(PORT, () => console.log(`YFL MCP Bridge listening on :${PORT}`));
