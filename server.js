// server.mjs — YFL Drive Bridge (GAS proxy + MCP over Streamable HTTP)
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

// ---- Auth helper
function tokenFrom(req) {
  return (req.get('X-Bridge-Token') || req.query.token || '').toString().trim();
}
function requireToken(req, res, next) {
  if (!TOKEN) return res.status(500).json({ ok:false, error:'bridge token not configured' });
  if (tokenFrom(req) !== TOKEN) return res.status(401).json({ ok:false, error:'bad token' });
  next();
}

// ---- Tool mapping (read-only hint)
const mapToolsReadOnly = (tools = []) =>
  tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema || t.inputSchema || { type: 'object' },
    annotations: { readOnlyHint: true } // host hint (non-normative)
  }));

// ---- GAS helper (action-style), follow /exec → googleusercontent.com JSON
async function gasAction(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('GAS not configured (GAS_BASE_URL / GAS_KEY)');

  const usp = new URLSearchParams({ action, token: GAS_KEY });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) usp.set(k, String(v));
  }
  const url = `${GAS_BASE_URL}?${usp.toString()}`;

  // first request without auto-follow to detect redirects explicitly
  let r = await fetch(url, { redirect: 'manual' });

  if ((r.status === 302 || r.status === 303) && r.headers.get('location')) {
    const loc = r.headers.get('location');
    if (/script\.googleusercontent\.com/i.test(loc)) {
      r = await fetch(loc, { redirect: 'follow' });
    }
  }

  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const bodyText = await r.text();

  if (!ct.includes('application/json')) {
    throw new Error(
      `GAS returned non-JSON (${r.status} ${ct || 'no-ct'}). First 160 chars: ${bodyText.slice(0, 160)}`
    );
  }

  const json = JSON.parse(bodyText);
  if (DEBUG) console.log('[GAS]', action, bodyText.slice(0, 200));
  return json;
}

// ---- Simple health
app.get('/health', async (_req, res) => {
  try {
    const out = await gasAction('health');
    return res.json({ ok: true, protocol: MCP_PROTOCOL, gas: !!out?.ok, ts: out?.ts || null });
  } catch (e) {
    return res.status(424).json({ ok:false, gas:false, error: String(e?.message || e) });
  }
});

// ---- REST (for smoke tests)
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

// ---- MCP endpoint (Streamable HTTP)
// Spec: if SSE/GET is unsupported, respond 405 (not 404) and advertise Allow: POST. :contentReference[oaicite:3]{index=3}
app.head('/mcp', (_req, res) => res.set('Allow', 'POST').status(405).send());
app.get('/mcp',  (_req, res) => res.set('Allow', 'POST').status(405).json({
  ok: true, mcp: true, protocol: MCP_PROTOCOL, hint: 'POST JSON-RPC 2.0 to this endpoint.'
}));

app.post('/mcp', async (req, res) => {
  // token check for POST (compatible with connectors that pass header or ?token=)
  if (TOKEN && tokenFrom(req) !== TOKEN) {
    const id = req.body?.id ?? null;
    return res.status(401).json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'bad token' } });
  }

  const { id, method, params = {} } = req.body || {};
  const rpcError = (code, message, data) => res.json({ jsonrpc: '2.0', id, error: { code, message, data } });

  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.4.3' },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }

    if (method === 'tools/list') {
      const out = await gasAction('tools/list');
      return res.json({ jsonrpc: '2.0', id, result: { tools: mapToolsReadOnly(out.tools || []) } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
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

// ---- Root
app.get('/', (_req, res) => res.send('YFL MCP Drive Bridge is running.'));
app.listen(PORT, () => console.log(`YFL MCP Bridge listening on :${PORT}`));
