// server.js — YFL Drive Bridge (GAS proxy + MCP over HTTP)
// Node 18+ (CommonJS)

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

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

// ---- Auth gate (header or query)
function requireToken(req, res, next) {
  const q  = (req.query.token || '').trim();
  const hd = (req.get('X-Bridge-Token') || '').trim();
  const t  = hd || q;
  if (!TOKEN || t !== TOKEN) return res.status(401).json({ ok:false, error:'bad token' });
  next();
}

// ---- Tool mapper (read‑only hint to avoid OAuth/interactive prompts)
const mapToolsReadOnly = (tools = []) =>
  tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema || t.inputSchema || { type: 'object' },
    annotations: { readOnlyHint: true }   // MCP allows annotations describing behavior
  }));

// ---- GAS proxy with redirect follow + timeout
async function gasAction(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('GAS not configured (GAS_BASE_URL / GAS_KEY)');

  const usp = new URLSearchParams({ action, token: GAS_KEY });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const url = `${GAS_BASE_URL}?${usp.toString()}`;

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort('timeout'), 20_000);

  try {
    let r = await fetch(url, { redirect: 'manual', signal: controller.signal });

    // Apps Script Web Apps often 302 to script.googleusercontent.com — follow once
    const loc = r.headers.get('location');
    if ((r.status === 302 || r.status === 303) && loc) {
      r = await fetch(loc, { redirect: 'follow', signal: controller.signal });
    }

    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
      const body = await r.text().catch(() => '');
      throw new Error(`GAS returned non-JSON (${r.status} ${ct || 'no-ct'}) — ${body.slice(0, 180)}`);
    }

    const json = await r.json();
    if (!json || json.ok === false) {
      throw new Error(json && json.error ? String(json.error) : 'GAS error');
    }
    if (DEBUG) console.log('GAS', action, '→', JSON.stringify(json).slice(0, 300));
    return json;
  } finally {
    clearTimeout(to);
  }
}

// -------- REST (for quick smoke tests)
app.get('/health', async (_req, res) => {
  try {
    const out = await gasAction('health');
    res.json({ ok: true, protocol: MCP_PROTOCOL, gas: !!out.ok, ts: out.ts || null });
  } catch (e) {
    res.status(424).json({ ok:false, gas:false, error: String(e?.message || e) });
  }
});

app.get('/tools/list', requireToken, async (_req, res) => {
  try {
    const out = await gasAction('tools/list');
    res.json({ ok: true, tools: mapToolsReadOnly(out.tools || []) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/tools/call', requireToken, async (req, res) => {
  try {
    const { name, arguments: args = {} } = req.body || {};
    if (!name) return res.status(400).json({ ok:false, error:'name is required' });
    const out = await gasAction('tools/call', { name, ...args });
    res.json(out);
  } catch (e) {
    res.status(424).json({ ok:false, error: String(e?.message || e) });
  }
});

// -------- Minimal MCP over HTTP (Streamable HTTP, JSON‑RPC 2.0)
app.post('/mcp', requireToken, async (req, res) => {
  const { id, method, params = {} } = req.body || {};
  const reply = (obj) => res.json({ jsonrpc: '2.0', id, ...obj });

  try {
    if (method === 'initialize') {
      return reply({
        result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.4.5' },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }

    if (method === 'tools/list') {
      const out = await gasAction('tools/list');
      return reply({ result: { tools: mapToolsReadOnly(out.tools || []) } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      if (!name) return reply({ error: { code: -32602, message: 'name is required' } });
      const out = await gasAction('tools/call', { name, ...args });
      return reply({
        result: {
          content: [{ type: 'text', text: JSON.stringify(out) }],
          structuredContent: out,
          isError: false
        }
      });
    }

    return reply({ error: { code: -32601, message: `unknown method: ${method}` } });
  } catch (e) {
    return reply({
      result: {
        content: [{ type: 'text', text: String(e?.message || e) }],
        isError: true
      }
    });
  }
});

app.get('/', (_req, res) => res.send('YFL MCP Drive Bridge is running.'));
app.listen(PORT, () => console.log(`YFL MCP Bridge listening on :${PORT}`));
