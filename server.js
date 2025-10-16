// server.mjs — YFL Drive Bridge (GAS action proxy + MCP over HTTP)
// Node 18+ (ESM)

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

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

// ---- Auth for bridge (header or query)
function requireToken(req, res, next) {
  const q  = (req.query.token || '').trim();
  const hd = (req.get('X-Bridge-Token') || '').trim();
  const t  = hd || q;
  if (!TOKEN || t !== TOKEN) return res.status(401).json({ ok:false, error:'bad token' });
  return next();
}

// ---- Read-only tool annotations (helps avoid “user input required”)
const mapToolsReadOnly = (tools = []) =>
  tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema || t.inputSchema || { type: 'object' },
    annotations: { readOnlyHint: true } // MCP allows annotations; clients may treat as safe/read-only.
  }));

// ---- GAS helper (action style) with 302 follow
async function gasAction(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('GAS not configured (GAS_BASE_URL / GAS_KEY)');

  const usp = new URLSearchParams({ action, token: GAS_KEY });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const url = `${GAS_BASE_URL}?${usp.toString()}`;

  // First request (don’t auto-follow so we can detect redirect origins)
  let r = await fetch(url, { redirect: 'manual' });

  // Apps Script web apps often 302 to script.googleusercontent.com — follow once.
  if ((r.status === 302 || r.status === 303) && r.headers.get('location')) {
    const loc = r.headers.get('location');
    if (loc && /script\.googleusercontent\.com/i.test(loc)) {
      r = await fetch(loc, { redirect: 'follow' });
    }
  }

  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    const body = await r.text().catch(() => '');
    throw new Error(`GAS returned non-JSON (${r.status} ${ct || 'no-ct'}) — first 200 chars: ${body.slice(0, 200)}`);
  }

  const json = await r.json();
  if (DEBUG) console.log('GAS', action, '→', JSON.stringify(json).slice(0, 200));
  return json;
}

// ---- REST proxy (for smoke tests)
app.get('/health', async (_req, res) => {
  try {
    const out = await gasAction('health');
    return res.json({ ok: true, protocol: MCP_PROTOCOL, gas: !!(out && out.ok), ts: out.ts || null });
  } catch (e) {
    return res.status(424).json({ ok:false, gas:false, error: String(e?.message || e) });
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
    if (!name) return res.status(400).json({ ok:false, error:'name is required' });
    const out = await gasAction('tools/call', { name, ...args });
    return res.json(out);
  } catch (e) {
    return res.status(424).json({ ok:false, error: String(e?.message || e) });
  }
});

// ---- MCP over HTTP (Inspector & ChatGPT Connector)
app.head('/mcp', requireToken, (_req, res) => res.sendStatus(204)); // connector creation probes with HEAD/GET
app.get('/mcp',  requireToken, (_req, res) =>
  res.json({ ok:true, protocol: MCP_PROTOCOL, hint:'POST JSON-RPC 2.0 requests to this endpoint.' })
);

app.post('/mcp', requireToken, async (req, res) => {
  const { id, method, params = {} } = req.body || {};
  const rpcError = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.4.5' },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }

    if (method === 'tools/list') {
      const out = await gasAction('tools/list');
      return res.json({ jsonrpc: '2.0', id, result: { tools: mapToolsReadOnly(out.tools || []) } });
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

app.get('/', (_req, res) => res.send('YFL MCP Drive Bridge is running.'));
app.listen(PORT, () => console.log(`YFL MCP Bridge listening on :${PORT}`));
