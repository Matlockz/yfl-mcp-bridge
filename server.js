// server.mjs — YFL Drive Bridge (Apps Script action proxy + MCP over HTTP)
// Node 18+ (ESM). Uses native fetch in Node 18+/22+.

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
const GAS_BASE_URL = String(process.env.GAS_BASE_URL || '').replace(/\/+$/, '');
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

// ---- Tool mapping with read-only hint (prevents “non-interactive” stalls)
const mapToolsReadOnly = (tools = []) =>
  tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema || t.inputSchema || { type: 'object' },
    annotations: { readOnlyHint: true } // MCP tool annotation (safe / non-interactive)
  }));

// ---- Apps Script action helper with redirect + timeout + one retry
async function gasAction(action, params = {}, { timeoutMs = 12000 } = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('GAS not configured (GAS_BASE_URL / GAS_KEY)');

  const usp = new URLSearchParams({ action, token: GAS_KEY });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const url = `${GAS_BASE_URL}?${usp.toString()}`;

  const attempt = async () => {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(new Error('bridge timeout')), timeoutMs);
    try {
      // First hop (don’t auto-follow so we can diagnose)
      let r = await fetch(url, { redirect: 'manual', signal: controller.signal });

      // Follow one redirect to script.googleusercontent.com (common for Apps Script web apps)
      if ((r.status === 302 || r.status === 303) && r.headers.get('location')) {
        const loc = r.headers.get('location');
        if (loc && /script\.googleusercontent\.com/i.test(loc)) {
          r = await fetch(loc, { redirect: 'follow', signal: controller.signal });
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
    } finally {
      clearTimeout(to);
    }
  };

  try {
    return await attempt();
  } catch (e) {
    // one quick retry on timeout/abort
    const msg = String(e?.message || e);
    if (/timeout|abort/i.test(msg)) {
      if (DEBUG) console.warn('Retrying gasAction after timeout:', action);
      return await attempt();
    }
    throw e;
  }
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

// ---- MCP endpoints

// NEW: allow GET /mcp for connector-creation probe (prevents 404 in UI)
app.get('/mcp', requireToken, (_req, res) => {
  return res.json({ ok: true, mcp: true, protocol: MCP_PROTOCOL, server: 'yfl-drive-bridge' });
});

app.post('/mcp', requireToken, async (req, res) => {
  const { jsonrpc, id, method, params = {} } = req.body || {};
  const rpcError = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.4.4' },
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

app.get('/', (_req, res) => res.send('YFL MCP Drive Bridge is running.'));
app.listen(PORT, () => console.log(`YFL MCP Bridge listening on :${PORT}`));
