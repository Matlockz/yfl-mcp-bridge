// server.js — YFL Drive Bridge (Render edge) — v3.3.2
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

// ---- Env
const PROTOCOL   = process.env.MCP_PROTOCOL || '2024-11-05';
const TOKEN      = (process.env.TOKEN || process.env.BRIDGE_TOKEN || '').trim();
const GAS_KEY    = (process.env.GAS_KEY || TOKEN || '').trim();
const GAS_BASE   = ((process.env.GAS_BASE_URL || '').trim()).replace(/\/$/, ''); // strip trailing slash

function need(name, val) {
  if (!val) throw new Error(`Missing env ${name}`);
}
need('GAS_BASE_URL', GAS_BASE);
need('GAS_KEY', GAS_KEY);
need('TOKEN', TOKEN);

// ---- Helpers
async function callGAS(path, params) {
  const qs  = new URLSearchParams(params);
  const url = `${GAS_BASE}${path}?${qs.toString()}`;
  const res = await fetch(url, { redirect: 'follow' });
  const cty = res.headers.get('content-type') || '';
  const bodyText = await res.text();

  if (!cty.includes('application/json')) {
    // The most common cause is a /dev URL or a non-"Anyone" deployment returning a Google sign-in page.
    throw new Error(
      `GAS returned non-JSON (${res.status} ${cty}) — first 200 chars: ${bodyText.slice(0, 200)}`
    );
  }
  try {
    return JSON.parse(bodyText);
  } catch (e) {
    throw new Error(`GAS JSON parse error: ${e.message}`);
  }
}

function checkToken(req, res) {
  const t = (req.query.token || req.headers['x-bridge-token'] || '').trim();
  if (TOKEN && t !== TOKEN) {
    res.status(401).json({ ok: false, error: 'bad token' });
    return false;
  }
  return true;
}

// ---- Health
app.get('/health', async (req, res) => {
  try {
    const j = await callGAS('/api/health', { token: GAS_KEY });
    res.json({ ok: !!j.ok, protocol: PROTOCOL, gas: !!j.ok });
  } catch (e) {
    res.status(424).json({ ok: false, gas: false, error: String(e.message || e), base: GAS_BASE });
  }
});

// ---- MCP JSON-RPC (POST)
app.post('/mcp', async (req, res) => {
  if (!checkToken(req, res)) return;
  const { method, id, params } = req.body || {};
  const reply = (result) => res.json({ jsonrpc: '2.0', id, result });
  const error = (message) => res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: String(message) } });

  try {
    if (method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL,
        serverInfo: { name: 'yfl-drive-bridge', version: '3.3.2' },
        capabilities: { tools: { listChanged: true } }
      });
    }

    if (method === 'tools/list') {
      return reply({
        tools: [
          {
            name: 'search',
            description: 'Search Google Drive by filename (contains).',
            inputSchema: {
              type: 'object',
              required: ['q'],
              properties: {
                q: { type: 'string' },
                max: { type: 'number', minimum: 1, default: 5 },
                mode: { type: 'string', enum: ['optional', 'name-only', 'all'], default: 'optional' }
              }
            }
          },
          {
            name: 'fetch',
            description: 'Fetch by file id; inline text when possible, else JSON metadata.',
            inputSchema: {
              type: 'object',
              required: ['id'],
              properties: {
                id: { type: 'string' },
                lines: { type: 'number', minimum: 0, default: 40 }
              }
            }
          },
          { name: 'drive_search', description: 'Alias of search', inputSchema: { type: 'object', required: ['q'], properties: { q: { type: 'string' }, max: { type: 'number', default: 5 } } } },
          { name: 'drive_fetch',  description: 'Alias of fetch',  inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, lines: { type: 'number', default: 40 } } } }
        ]
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      if (name === 'search' || name === 'drive_search') {
        const q = String(args?.q || '').trim();
        const max = Math.max(1, Math.min(100, Number(args?.max ?? 5)));
        if (!q) return reply({ isError: true, content: [{ type: 'text', text: 'q is required' }] });
        const j = await callGAS('/api/search', { q, max, token: GAS_KEY });
        return reply({ isError: false, content: [{ type: 'json', json: j }] });
      }
      if (name === 'fetch' || name === 'drive_fetch') {
        const idv = String(args?.id || '').trim();   // IMPORTANT: id must be just the file id (no &lines or &token)
        const lines = Math.max(0, Math.min(1_000_000, Number(args?.lines ?? 40)));
        if (!idv) return reply({ isError: true, content: [{ type: 'text', text: 'id is required' }] });
        const j = await callGAS('/api/fetch', { id: idv, lines, token: GAS_KEY });
        return reply({ isError: false, content: [{ type: 'json', json: j }] });
      }
      return error(`Unknown tool: ${name}`);
    }

    return error(`Unknown method: ${method}`);
  } catch (e) {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: { isError: true, content: [{ type: 'text', text: String(e.message || e) }] }
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bridge listening on ${port} — GAS_BASE_URL=${GAS_BASE}`));
