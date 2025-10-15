// YFL Drive Bridge – MCP proxy for Google Apps Script
// Node >= 18 (ESM). No dotenv required.

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT          = process.env.PORT || '10000';
const BRIDGE_TOKEN  = process.env.BRIDGE_TOKEN || process.env.TOKEN || '';
const GAS_BASE_URL  = (process.env.GAS_BASE_URL || '').replace(/\/$/, '');
const GAS_KEY       = process.env.GAS_KEY || process.env.SHARED_KEY || '';
const MCP_PROTOCOL  = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG         = String(process.env.DEBUG || '0') === '1';

function getClientToken(req) {
  return (
    (req.query.token || '') ||
    (req.get('X-Bridge-Token') || '') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
  ).trim();
}

function requireToken(req, res, next) {
  const t = getClientToken(req);
  if (!BRIDGE_TOKEN || t !== BRIDGE_TOKEN) {
    return res.status(401).json({ ok: false, error: 'bad token' });
  }
  next();
}

function qs(obj = {}) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

async function gas(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('GAS_BASE_URL or GAS_KEY not set');
  const url =
    `${GAS_BASE_URL}?action=${encodeURIComponent(action)}` +
    `&token=${encodeURIComponent(GAS_KEY)}` +
    (Object.keys(params).length ? `&${qs(params)}` : '');

  const r = await fetch(url, { redirect: 'manual' });
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    const body = await r.text().catch(() => '');
    throw new Error(`GAS returned non-JSON (${r.status} ${ct || 'no-ct'}) — first 200 chars: ${body.slice(0, 200)}`);
  }
  return await r.json();
}

// --- health
app.get('/health', async (_req, res) => {
  try {
    const ok = await gas('health');
    res.json({ ok: true, protocol: MCP_PROTOCOL, gas: !!ok?.ok, ts: new Date().toISOString() });
  } catch (e) {
    if (DEBUG) console.error('health:', e);
    res.status(424).json({ ok: false, gas: false, error: String(e?.message || e) });
  }
});

// --- REST smoke tests (protected)
app.get('/tools/list', requireToken, async (_req, res) => {
  try {
    const out = await gas('tools/list');
    res.json(out);
  } catch (e) {
    if (DEBUG) console.error('tools/list:', e);
    res.status(424).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/tools/call', requireToken, async (req, res) => {
  try {
    const { name, arguments: args = {} } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    const out = await gas('tools/call', { name, ...args });
    res.json(out);
  } catch (e) {
    if (DEBUG) console.error('tools/call:', e);
    res.status(424).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- MCP JSON-RPC (Inspector / ChatGPT Connectors)
app.post('/mcp', requireToken, async (req, res) => {
  try {
    const { id, method, params = {} } = req.body || {};

    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.4.1' },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }

    if (method === 'tools/list') {
      const raw = await gas('tools/list');
      const tools = (raw?.tools || []).map(t => ({
        name: t.name,
        description: t.description || '',
        // GAS uses input_schema; MCP expects inputSchema
        inputSchema: t.inputSchema || t.input_schema || { type: 'object' }
      }));
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }

    if (method === 'tools/call') {
      const name = params.name;
      const args = params.arguments || {};
      if (!name) return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'name is required' } });
      const out = await gas('tools/call', { name, ...args });
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: out }], isError: false } });
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
  } catch (e) {
    if (DEBUG) console.error('mcp:', e);
    res.json({
      jsonrpc: '2.0',
      id: req.body?.id,
      result: { content: [{ type: 'text', text: String(e?.message || e) }], isError: true }
    });
  }
});

app.get('/', (_req, res) => res.type('text/plain').send('YFL MCP Drive Bridge is running.'));
app.listen(Number(PORT), () => console.log(`YFL MCP Bridge listening on :${PORT}`));
