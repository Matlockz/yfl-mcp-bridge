// server.js — yfl-mcp-bridge (query-param routing to GAS)

import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import compression from 'compression';

const app = express();
app.use(compression());
app.use(cors());
app.use(express.json());

const PORT         = process.env.PORT || 3000;
const TOKEN        = process.env.TOKEN || process.env.BRIDGE_TOKEN || '';
const GAS_KEY      = process.env.GAS_KEY || process.env.BRIDGE_API_KEY || '';
const GAS_BASE_URL = (process.env.GAS_BASE_URL || '').replace(/\/+$/, ''); // must be .../exec
const MCP_PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';

function badEnv(msg) {
  return { ok: false, error: msg };
}

async function gasGet(params) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('GAS_BASE_URL / GAS_KEY missing');
  const qp = new URLSearchParams({ ...params, token: GAS_KEY });
  const url = `${GAS_BASE_URL}?${qp.toString()}`;
  const r = await fetch(url, { method: 'GET' });
  const ct = r.headers.get('content-type') || '';
  const txt = await r.text();
  if (!ct.includes('application/json')) {
    // health wants to detect sign-in HTML
    return { ok: false, error: `GAS returned non-JSON (${r.status} ${ct}) — first 200 chars: ${txt.slice(0, 200)}` };
  }
  try {
    return JSON.parse(txt);
  } catch (e) {
    return { ok: false, error: `GAS JSON parse error: ${e.message}`, raw: txt };
  }
}

// --- health
app.get('/health', async (req, res) => {
  try {
    const out = await gasGet({ action: 'health' });
    res.json({ ok: !!out.ok, protocol: MCP_PROTOCOL, gas: !!out.ok, gas_detail: out });
  } catch (e) {
    res.status(424).json({ ok: false, error: String(e) });
  }
});

// --- MCP endpoints (minimal)
app.post('/mcp', async (req, res) => {
  const auth = String(req.query.token || '');
  if (!TOKEN || auth !== TOKEN) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body || {};
  const { id, method, params } = body;

  const reply = (result) => res.json({ jsonrpc: '2.0', id, result });
  const error = (msg)   => res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: msg } });

  try {
    if (method === 'initialize') {
      return reply({ protocolVersion: MCP_PROTOCOL, serverInfo: { name: 'yfl-drive-bridge', version: '3.3.2' },
                     capabilities: { tools: { listChanged: true } } });
    }
    if (method === 'tools/list') {
      return reply({ tools: [
        { name: 'search',      description: 'Search Google Drive by filename (contains).',
          inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 100, default: 5 } } } },
        { name: 'fetch',       description: 'Fetch by file id; inline text when possible, else JSON metadata.',
          inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, lines: { type: 'integer', minimum: 0, maximum: 1000000, default: 200 } } } },
        { name: 'drive_search', description: 'Alias of search', inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, max: { type: 'integer', default: 5 } } } },
        { name: 'drive_fetch',  description: 'Alias of fetch',  inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, lines: { type: 'integer', default: 200 } } } }
      ]});
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      if (name === 'search' || name === 'drive_search') {
        if (!args.q) return reply({ content: [{ type: 'text', text: 'q is required' }], isError: true });
        const out = await gasGet({ action: 'search', q: args.q, max: String(args.max ?? 5) });
        if (!out.ok) return reply({ content: [{ type: 'text', text: out.error || 'search failed' }], isError: true });
        return reply({ content: [{ type: 'json', json: out.data }], isError: false });
      }
      if (name === 'fetch' || name === 'drive_fetch') {
        if (!args.id) return reply({ content: [{ type: 'text', text: 'id is required' }], isError: true });
        const out = await gasGet({ action: 'fetch', id: args.id, lines: String(args.lines ?? 200) });
        if (!out.ok) return reply({ content: [{ type: 'text', text: out.error || 'fetch failed' }], isError: true });
        return reply({ content: [{ type: 'json', json: out.data }], isError: false });
      }
      return error('unknown tool');
    }

    return error('unknown method');
  } catch (e) {
    return error(String(e));
  }
});

app.listen(PORT, () => console.log(`yfl-mcp-bridge listening on :${PORT}`));
