// YFL MCP Drive Bridge (local) — server.mjs
// Node 18+ (ESM). No dotenv/node-fetch required.

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT         = process.env.PORT || 10000;
const TOKEN        = process.env.BRIDGE_TOKEN || process.env.TOKEN || '';
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY      = process.env.GAS_KEY || '';
const MCP_PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG        = String(process.env.DEBUG || '0') === '1';

function requireToken(req, res, next) {
  const t = String(req.query.token || req.get('X-Bridge-Token') || '').trim();
  if (!TOKEN || t !== TOKEN) return res.status(401).json({ ok: false, error: 'bad token' });
  next();
}

async function getGas(path) {
  if (!GAS_BASE_URL) throw new Error('GAS_BASE_URL missing');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${GAS_BASE_URL}${path}${sep}token=${encodeURIComponent(GAS_KEY)}`;
  const r = await fetch(url, { redirect: 'manual' });
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    const first = await r.text();
    throw new Error(`GAS returned non-JSON (${r.status} ${ct || 'no-ct'}) — first 200 chars: ${first.slice(0,200)}`);
  }
  return await r.json();
}

function qs(obj = {}) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

// --- Health
app.get('/health', async (req, res) => {
  try {
    const h = await getGas('/api/health');
    res.json({ ok: true, protocol: MCP_PROTOCOL, gas: !!(h && h.ok), ts: new Date().toISOString() });
  } catch (e) {
    if (DEBUG) console.error(e);
    res.status(424).json({ ok: false, error: String(e && e.message || e) });
  }
});

// --- REST fallbacks (handy for shell tests)
app.get('/tools/list', requireToken, async (req, res) => {
  try {
    let out;
    try { out = await getGas('/api/tools/list'); }
    catch { out = await getGas('/?action=tools/list'); } // older GAS builds
    res.json(out);
  } catch (e) {
    if (DEBUG) console.error(e);
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

app.post('/tools/call', requireToken, async (req, res) => {
  try {
    const { name, arguments: args = {} } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    let out;
    try { out = await getGas(`/api/tools/call?name=${encodeURIComponent(name)}&${qs(args)}`); }
    catch { out = await getGas(`/?action=tools/call&name=${encodeURIComponent(name)}&${qs(args)}`); }
    res.json(out);
  } catch (e) {
    if (DEBUG) console.error(e);
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

// --- MCP (Streamable HTTP / JSON-RPC)
app.post('/mcp', requireToken, async (req, res) => {
  const { id, method, params = {} } = req.body || {};
  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.4.0' },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }
    if (method === 'tools/list') {
      let out;
      try { out = await getGas('/api/tools/list'); }
      catch { out = await getGas('/?action=tools/list'); }
      const tools = (out.tools || []).map(t => ({
        name: t.name,                      // keep original names (drive.list, drive.search, drive.get)
        description: t.description,
        inputSchema: t.input_schema || t.inputSchema || { type: 'object' }
      }));
      return res.json({ jsonrpc: '2.0', id, result: { tools } });
    }
    if (method === 'tools/call') {
      const name = params.name;
      const args = params.arguments || {};
      if (!name) return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: 'name is required' } });
      let out;
      try { out = await getGas(`/api/tools/call?name=${encodeURIComponent(name)}&${qs(args)}`); }
      catch { out = await getGas(`/?action=tools/call&name=${encodeURIComponent(name)}&${qs(args)}`); }
      return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: out }], isError: false } });
    }
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e && e.message || e) }], isError: true } });
  }
});

app.get('/', (req, res) => res.send('YFL MCP Drive Bridge is running.'));
app.listen(PORT, () => console.log(`YFL MCP Bridge on :${PORT}`));
