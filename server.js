// server.js — YFL MCP Drive Bridge 3.3.1 (streamable HTTP + JSON-RPC)
import express from 'express';
import cors from 'cors';

const app = express();
app.set('trust proxy', true);

// ---- ENV (use Render Environment or .env for local dev)
const TOKEN        = process.env.TOKEN        || 'Wt8UPTyKNKRGTUQ24NzU';
const GAS_BASE_URL = process.env.GAS_BASE_URL || 'https://script.google.com/macros/s/AKfycby2ssdVE-VgxqbzdZO3jGHDF3YsEf4vguBFF6hJVbzWsuO-0hh_GTcmRMW_Gqr1-Md8/exec';
const MCP_PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG        = String(process.env.DEBUG || '0') !== '0';

app.use(cors({
  origin: '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','MCP-Protocol-Version'],
}));
app.use(express.json({ limit: '1mb' }));

// ---- Helpers
const qs = (obj) =>
  Object.entries(obj).filter(([,v]) => v !== undefined && v !== null)
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');

async function gasCall(action, params = {}) {
  const url = `${GAS_BASE_URL}?${qs({ action, token: TOKEN, ...params })}`;
  const res = await fetch(url, { redirect: 'follow' });
  const ct  = (res.headers.get('content-type') || '').toLowerCase();
  const body = await res.text();
  if (ct.includes('application/json')) {
    try { return JSON.parse(body); }
    catch (e) { return { ok: false, error: 'invalid JSON', raw: body }; }
  }
  return { ok: false, error: `GAS returned non‑JSON (${res.status} ${ct})`, html: body.slice(0, 400), url };
}

// ---- Health
app.get('/health', async (_req, res) => {
  const g = await gasCall('health');
  const gasOK = !!g?.ok;
  res.json({
    ok: true,
    protocol: MCP_PROTOCOL,
    gas: gasOK,
    error: gasOK ? undefined : (g?.error || g?.html || 'gas unreachable').slice(0, 200)
  });
});

// ---- SSE (Streamable HTTP / MCP)
app.get('/mcp', (req, res) => {
  const accept = String(req.headers['accept'] || '');
  if (!accept.includes('text/event-stream')) {
    return res.send('Use POST for JSON‑RPC. To open SSE, request with Accept: text/event-stream.');
  }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const mcpUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ url: mcpUrl })}\n\n`);
  const t = setInterval(() => res.write(`: keepalive\n\n`), 25000);
  req.on('close', () => clearInterval(t));
});

// ---- JSON-RPC
app.post('/mcp', async (req, res) => {
  const { id, method, params } = req.body || {};
  const reply = (result) => res.json({ jsonrpc: '2.0', id, result });
  const fail  = (message, data) => res.json({ jsonrpc: '2.0', id, error: { code: -32000, message, data } });

  try {
    if (method === 'initialize') {
      return reply({
        protocolVersion: MCP_PROTOCOL,
        serverInfo: { name: 'yfl-drive-bridge', version: '3.3.1' },
        capabilities: { tools: { listChanged: true } },
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
              properties: {
                q:   { type: 'string' },
                max: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
              },
              required: ['q']
            }
          },
          {
            name: 'fetch',
            description: 'Fetch by file id; inline text when possible, else JSON metadata.',
            inputSchema: {
              type: 'object',
              properties: {
                id:    { type: 'string' },
                lines: { type: 'integer', minimum: 0, default: 0 }
              },
              required: ['id']
            }
          },
          { name: 'drive_search', description: 'Alias of search', inputSchema: { type: 'object', properties: { q: {type:'string'}, max: {type:'integer'} }, required: ['q'] } },
          { name: 'drive_fetch',  description: 'Alias of fetch',  inputSchema: { type: 'object', properties: { id:{type:'string'}, lines:{type:'integer'} }, required: ['id'] } }
        ]
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      if (name === 'search' || name === 'drive_search') {
        const q   = String(args.q || '').trim();
        const max = Math.min(Math.max(parseInt(args.max ?? '25', 10) || 25, 1), 100);
        const r = await gasCall('search', { q, max });
        if (!r?.ok) return fail('GAS search error', { request: { q, max }, response: r });
        return reply({ content: [{ type: 'json', json: r }], isError: false });
      }
      if (name === 'fetch' || name === 'drive_fetch') {
        const id    = String(args.id || '').trim();
        const lines = Math.max(parseInt(args.lines ?? '0', 10) || 0, 0);
        const r = await gasCall('fetch', { id, lines });
        if (!r?.ok) return fail('GAS fetch error', { request: { id, lines }, response: r });
        if (r?.data?.inline && typeof r?.data?.text === 'string') {
          return reply({ content: [{ type: 'text', text: r.data.text }], isError: false });
        }
        return reply({ content: [{ type: 'json', json: r }], isError: false });
      }
      return fail('Unknown tool: ' + name);
    }

    return fail('Unknown method: ' + method);
  } catch (err) {
    return fail(String(err?.message || err), { stack: err?.stack });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`YFL MCP Drive Bridge listening on :${PORT}`));
