// server.js  — YFL Drive Bridge (minimal, JSON-RPC over HTTP)
// ESM mode (see package.json "type": "module")
import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.disable('x-powered-by');
app.use(morgan('tiny'));
app.use(cors({ origin: '*', maxAge: 300 }));
app.use(express.json({ limit: '1mb' }));

const PORT         = process.env.PORT || 10000;
const TOKEN        = process.env.TOKEN || process.env.BRIDGE_TOKEN || '';
const MCP_PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';
const GAS_BASE_URL = process.env.GAS_BASE_URL || '';
const GAS_KEY      = process.env.GAS_KEY || process.env.BRIDGE_API_KEY || '';

function bad(res, code, msg) {
  return res.status(code).json({ ok: false, error: msg });
}

function ensureToken(req, res, next) {
  const t = String(req.query.token || req.headers['x-bridge-token'] || '');
  if (!TOKEN || t !== TOKEN) return bad(res, 401, 'bad bridge token');
  next();
}

// ---- Health ---------------------------------------------------------------
app.get('/health', async (req, res) => {
  let out = { ok: true, protocol: MCP_PROTOCOL, gas: false };
  if (!GAS_BASE_URL || !GAS_KEY) return res.json({ ...out, gas: false, error: 'no GAS_BASE_URL or GAS_KEY' });

  try {
    const url = `${GAS_BASE_URL.replace(/\/+$/,'')}/api/health?token=${encodeURIComponent(GAS_KEY)}`;
    const r = await fetch(url, { method: 'GET', redirect: 'manual' });
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await r.json().catch(() => ({}));
      out.gas = !!j.ok;
      if (!j.ok) out.error = 'gas returned not-ok JSON';
    } else {
      // Likely a 302/HTML sign-in. Grab a short prefix so the UI can show it.
      const text = await r.text().catch(() => '');
      out.gas = false;
      out.error = `GAS returned non-JSON (${r.status} ${ct}) — first 200 chars: ${text.slice(0,200)}`;
      out.base = GAS_BASE_URL;
    }
  } catch (err) {
    out.gas = false;
    out.error = String(err && err.message || err);
    out.base = GAS_BASE_URL;
  }
  return res.json(out);
});

// ---- MCP JSON-RPC over HTTP (POST only) -----------------------------------
app.get('/mcp', (req, res) => res.status(405).type('text/plain').send('Use POST /mcp for JSON-RPC.'));
app.post('/mcp', ensureToken, async (req, res) => {
  const { id, method, params } = req.body || {};
  const reply = (result, error) => res.json({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) });

  if (method === 'initialize') {
    return reply({
      protocolVersion: MCP_PROTOCOL,
      serverInfo: { name: 'yfl-drive-bridge', version: '3.3.2' },
      capabilities: { tools: { listChanged: true } }
    });
  }

  if (method === 'tools/list') {
    return reply({
      tools: [
        { name: 'search',      description: 'Search Google Drive by filename (contains).',
          inputSchema: { type: 'object', properties: { q: { type: 'string' }, max: { type: 'number', minimum: 1, maximum: 100 } }, required: ['q'] } },
        { name: 'fetch',       description: 'Fetch by file id; inline text when possible, else JSON metadata.',
          inputSchema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number', minimum: 0, maximum: 1000000 } }, required: ['id'] } },
        { name: 'drive_search', description: 'Alias of search', inputSchema: { type: 'object', properties: { q: { type: 'string' }, max: { type: 'number' } }, required: ['q'] } },
        { name: 'drive_fetch',  description: 'Alias of fetch',  inputSchema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number' } }, required: ['id'] } }
      ]
    });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      if (!GAS_BASE_URL || !GAS_KEY) return reply(null, { code: -32000, message: 'Bridge not configured for GAS' });
      const base = GAS_BASE_URL.replace(/\/+$/,'');
      if (name === 'search' || name === 'drive_search') {
        if (!args.q) return reply(null, { code: -32602, message: 'q is required' });
        const url = `${base}/api/search?q=${encodeURIComponent(args.q)}&max=${Math.max(1, Math.min(Number(args.max||25), 100))}&token=${encodeURIComponent(GAS_KEY)}`;
        const r = await fetch(url);
        const json = await r.json().catch(async () => ({ error: await r.text() }));
        return reply({ content: [{ type: 'json', json }], isError: !!json?.error });
      }
      if (name === 'fetch' || name === 'drive_fetch') {
        if (!args.id) return reply(null, { code: -32602, message: 'id is required' });
        const url = `${base}/api/fetch?id=${encodeURIComponent(args.id)}&lines=${Math.max(0, Number(args.lines||0))}&token=${encodeURIComponent(GAS_KEY)}`;
        const r = await fetch(url);
        const json = await r.json().catch(async () => ({ error: await r.text() }));
        return reply({ content: [{ type: 'json', json }], isError: !!json?.error });
      }
      return reply(null, { code: -32601, message: `Unknown tool: ${name}` });
    } catch (err) {
      return reply({ content: [{ type: 'text', text: String(err && err.message || err) }], isError: true });
    }
  }

  return reply(null, { code: -32601, message: `Unknown method: ${method}` });
});

// --------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`YFL Bridge listening on :${PORT}`);
});
