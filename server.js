// server.js — YFL Drive Bridge (CommonJS)

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

async function doFetch(url, opts) {
  if (global.fetch) return await global.fetch(url, opts); // Node 18+
  const { default: f } = await import('node-fetch');
  return await f(url, opts);
}

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT         = process.env.PORT || 10000;
const TOKEN        = process.env.BRIDGE_TOKEN || process.env.TOKEN || '';
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY      = process.env.GAS_KEY || '';
const PROTOCOL     = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG        = String(process.env.DEBUG || '0') === '1';

function u(action, params = {}) {
  const url = new URL(GAS_BASE_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('token', GAS_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    url.searchParams.append(k, String(v));
  }
  return url.toString();
}

async function getFromGAS(action, params = {}) {
  const url = u(action, params);
  const r = await doFetch(url, { redirect: 'follow' });
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    const text = await r.text();
    throw new Error(
      `GAS returned non-JSON (${r.status} ${ct || 'no-ct'}) — first 200 chars: ${text.slice(0, 200)}`
    );
  }
  return await r.json();
}

function requireBridgeToken(req, res, next) {
  const t = (req.query.token || req.get('X-Bridge-Token') || '').trim();
  if (!TOKEN) return next();
  if (t !== TOKEN) return res.status(401).json({ ok: false, error: 'bad token' });
  next();
}

app.get('/health', async (_req, res) => {
  try {
    const ok = await getFromGAS('health');
    return res.json({ ok: true, protocol: PROTOCOL, gas: !!(ok && ok.ok) });
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(424).json({ ok: false, gas: false, error: String(e?.message || e), base: GAS_BASE_URL });
  }
});

app.get('/tools/list', async (_req, res) => {
  try {
    const out = await getFromGAS('tools/list');
    return res.json(out);
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(424).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/tools/call', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const args = req.body?.arguments || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });

    const out = await getFromGAS('tools/call', { name, ...args });
    return res.json(out);
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(424).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/mcp', requireBridgeToken, async (req, res) => {
  const { jsonrpc, id, method, params = {} } = req.body || {};
  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.4.0' },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }
    if (method === 'tools/list') {
      const out = await getFromGAS('tools/list');
      return res.json({ jsonrpc: '2.0', id, result: out });
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      if (!name) {
        return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'name is required' } });
      }
      const out = await getFromGAS('tools/call', { name, ...args });
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: out }], isError: false } });
    }
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.json({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: String(e?.message || e) }], isError: true }
    });
  }
});

app.get('/', (_req, res) => res.send('YFL MCP Drive Bridge is running.'));
app.listen(PORT, () => console.log(`YFL MCP Bridge on :${PORT}`));
