import express from 'express';
import morgan from 'morgan';
import fetch from 'node-fetch';

const app = express();
app.enable('trust proxy');
app.use(express.json({ limit: '256kb' }));
app.use(morgan('tiny'));

const PORT          = process.env.PORT || 10000;
const PROTOCOL_VER  = process.env.MCP_PROTOCOL || '2024-11-05';
const TOKEN         = (process.env.BRIDGE_TOKEN || process.env.TOKEN || process.env.BRIDGE_API_KEY || '').trim();
const GAS_BASE_URL  = (process.env.GAS_BASE_URL || '').trim(); // must be the /exec URL
const GAS_KEY       = (process.env.GAS_KEY || '').trim();
const DEBUG         = String(process.env.DEBUG || '') === '1';

function ensureToken(req, res, next) {
  const t = (req.query.token || req.get('x-bridge-token') || '').trim();
  if (!TOKEN || t !== TOKEN) return res.status(401).json({ ok: false, error: 'bad token' });
  next();
}

async function callGas(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('GAS not configured');

  const qs = new URLSearchParams({ action, token: GAS_KEY, ...params }).toString();
  const url = `${GAS_BASE_URL}?${qs}`;
  const r = await fetch(url, { method: 'GET', redirect: 'follow' });

  const ctype = (r.headers.get('content-type') || '').toLowerCase();
  const text = await r.text();

  if (ctype.includes('application/json')) {
    try { return JSON.parse(text); } catch (e) { /* fallthrough */ }
  }

  // Not JSON — surface a helpful snippet
  throw new Error(`GAS returned non-JSON (${r.status} ${ctype || 'unknown'}); first 200 chars: ${text.slice(0,200)}`);
}

// --- Health ---
app.get('/health', async (_req, res) => {
  try {
    const out = await callGas('health');
    return res.json({ ok: true, protocol: PROTOCOL_VER, gas: !!out?.ok });
  } catch (err) {
    return res.json({ ok: true, protocol: PROTOCOL_VER, gas: false, error: String(err?.message || err) });
  }
});

// --- Minimal MCP over HTTP POST ---
app.post('/mcp', ensureToken, async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  const reply = (result) => res.json({ jsonrpc: '2.0', id, result });

  if (method === 'initialize') {
    return reply({
      protocolVersion: PROTOCOL_VER,
      serverInfo: { name: 'yfl-drive-bridge', version: '3.4.0' },
      capabilities: { tools: { listChanged: true } }
    });
  }

  if (method === 'tools/list') {
    return reply({
      tools: [
        {
          name: 'search',
          description: 'Search Google Drive by filename (contains).',
          inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 100 } } }
        },
        {
          name: 'fetch',
          description: 'Fetch by file id; inline text when possible, else JSON metadata.',
          inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, lines: { type: 'integer', minimum: 0, maximum: 1000000 } } }
        },
        { name: 'drive_search', description: 'Alias of search', inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 100 } } } },
        { name: 'drive_fetch',  description: 'Alias of fetch',  inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, lines: { type: 'integer', minimum: 0, maximum: 1000000 } } } }
      ]
    });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      if (name === 'search' || name === 'drive_search') {
        const q = String(args.q || '').trim();
        const max = Math.max(1, Math.min(100, Number(args.max || 25)));
        const out = await callGas('search', { q, max });
        return reply({ content: [{ type: 'json', json: out }], isError: false });
      }
      if (name === 'fetch' || name === 'drive_fetch') {
        const id = String(args.id || '').trim();
        const lines = Math.max(0, Math.min(1000000, Number(args.lines || 0)));
        const out = await callGas('fetch', { id, lines });
        return reply({ content: [{ type: 'json', json: out }], isError: false });
      }
      return reply({ content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true });
    } catch (err) {
      return reply({ content: [{ type: 'text', text: String(err?.message || err) }], isError: true });
    }
  }

  // Default
  return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});

// Optional: friendly GET for /mcp in browsers
app.get('/mcp', (_req, res) => res.status(405).send('Use POST /mcp (JSON-RPC).'));

app.listen(PORT, () => {
  console.log(`Bridge listening on :${PORT}`);
});
