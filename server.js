import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT      = process.env.PORT || 10000;
const BRIDGE_TK = process.env.BRIDGE_TOKEN || process.env.TOKEN || 'dev';
const GAS_BASE  = process.env.GAS_BASE_URL;  // MUST be .../exec
const GAS_KEY   = process.env.GAS_KEY || process.env.BRIDGE_API_KEY || BRIDGE_TK; // shared secret
const PROTOCOL  = process.env.MCP_PROTOCOL || '2024-11-05';

app.get('/health', (_, res) => res.json({ ok: true }));

// SSE discovery
app.get('/mcp', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });

  const base = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
  const messages = `${base}/mcp?token=${encodeURIComponent(BRIDGE_TK)}`;

  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ messages })}\n\n`);

  const iv = setInterval(() => res.write(`: keepalive\n\n`), 30000);
  req.on('close', () => clearInterval(iv));
});

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}
function err(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function initializeResult() {
  return {
    protocolVersion: PROTOCOL,
    serverInfo: { name: 'YFL Drive Bridge', version: '1.0.0' },
    capabilities: { tools: { listChanged: true } }
  };
}

function toolList() {
  return {
    tools: [
      {
        name: 'search',
        description: 'Search Google Drive by file title (contains).',
        inputSchema: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            max: { type: 'integer', minimum: 1, maximum: 100 }
          },
          required: ['q']
        },
        annotations: { readOnlyHint: true, openWorldHint: true }
      },
      {
        name: 'fetch',
        description: 'Fetch a Google Drive file by id. Returns inline text for Docs/Sheets/text; otherwise a download url.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            lines: { type: 'integer', minimum: 0 }
          },
          required: ['id']
        },
        annotations: { readOnlyHint: true, openWorldHint: true }
      },
      // Friendly aliases
      {
        name: 'drive_search',
        description: 'Alias of search.',
        inputSchema: { type: 'object', properties: { q: { type: 'string' }, max: { type: 'integer' } }, required: ['q'] },
        annotations: { readOnlyHint: true, openWorldHint: true }
      },
      {
        name: 'drive_fetch',
        description: 'Alias of fetch.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'integer' } }, required: ['id'] },
        annotations: { readOnlyHint: true, openWorldHint: true }
      }
    ]
  };
}

async function gasGet(params) {
  if (!GAS_BASE) throw new Error('GAS_BASE_URL missing');
  const u = new URL(GAS_BASE);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  });

  const r = await fetch(u.toString(), { method: 'GET' });
  const text = await r.text();

  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`GAS returned non-JSON (HTTP ${r.status})`); }

  if (!r.ok || body?.ok === false) {
    const data = { status: r.status, body };
    const msg  = body?.error || `GAS HTTP ${r.status}`;
    const e    = new Error(msg);
    e.data = data;
    throw e;
  }
  return body.data ?? body;
}

app.post('/mcp', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { id, method, params } = req.body || {};

  try {
    if (method === 'initialize') {
      return res.json(ok(id, initializeResult()));
    }

    if (method === 'tools/list') {
      return res.json(ok(id, toolList()));
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};

      if (name === 'search' || name === 'drive_search') {
        const q   = args.q || '';
        const max = Math.min(Number(args.max || 25), 100);
        const data = await gasGet({ action: 'search', token: GAS_KEY, q, max });
        return res.json(ok(id, { content: [{ type: 'json', json: data }] }));
      }

      if (name === 'fetch' || name === 'drive_fetch') {
        const fid   = args.id || '';
        const lines = Math.max(Number(args.lines || 0), 0);
        const data  = await gasGet({ action: 'fetch', token: GAS_KEY, id: fid, lines });

        if (data?.inline && typeof data?.text === 'string') {
          // include a short text preview for convenience + full json
          const preview = lines ? data.text : data.text.slice(0, 2000);
          return res.json(ok(id, { content: [{ type: 'text', text: preview }, { type: 'json', json: data }] }));
        }
        return res.json(ok(id, { content: [{ type: 'json', json: data }] }));
      }

      return res.json(err(id, -32601, `Unknown tool: ${name}`));
    }

    return res.json(err(id, -32601, `Unknown method: ${method}`));
  } catch (e) {
    const payload = { message: String(e?.message || e), ...(e?.data ? { data: e.data } : {}) };
    return res.json(err(id ?? null, -32002, 'Bridge error', payload));
  }
});

app.listen(PORT, () => console.log(`YFL bridge listening on http://localhost:${PORT}`));
