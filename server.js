// server.js  (ESM; Node >= 18)
import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT      = process.env.PORT || 10000;
const GAS_BASE  = process.env.GAS_BASE_URL;     // e.g. https://script.google.com/macros/s/.../exec
const GAS_KEY   = process.env.GAS_KEY || process.env.TOKEN || process.env.BRIDGE_TOKEN;
const PROTOCOL  = process.env.MCP_PROTOCOL || '2024-11-05';

// ---------- health ----------
app.get('/health', (_, res) => res.json({ ok: true, protocol: PROTOCOL, gas: Boolean(GAS_BASE) }));

// ---------- SSE discovery (for clients that open an event stream) ----------
app.get('/mcp', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive'
  });
  const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
  res.write(`event: endpoint\n`);
  res.write(`data: {"url":"${url.toString()}"}\n\n`);
  const t = setInterval(() => res.write(`: keepalive\n\n`), 15000);
  req.on('close', () => clearInterval(t));
});

// ---------- JSON-RPC 2.0 over POST ----------
app.post('/mcp', async (req, res) => {
  const { id, method, params } = req.body || {};
  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.3.0' },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }

    if (method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0', id,
        result: {
          tools: [
            {
              name: 'search',
              description: 'Search Google Drive by filename (contains).',
              inputSchema: {
                type: 'object',
                properties: {
                  q:   { type: 'string', description: 'substring to match' },
                  max: { type: 'number', description: 'max results (<=100)' },
                  mode:{ type: 'string', enum: ['name','content'], default: 'name' }
                },
                required: ['q']
              },
              annotations: { readOnlyHint: true, openWorldHint: true }
            },
            {
              name: 'fetch',
              description: 'Fetch by file id; inline text when possible, else JSON metadata.',
              inputSchema: {
                type: 'object',
                properties: {
                  id:    { type: 'string' },
                  lines: { type: 'number', description: 'optional first N lines for text' }
                },
                required: ['id']
              },
              annotations: { readOnlyHint: true, openWorldHint: true }
            },
            { name: 'drive_search', inputSchema: { type: 'object', properties: { q: {type:'string'}, max:{type:'number'} }, required:['q'] }, annotations:{aliasOf:'search'} },
            { name: 'drive_fetch',  inputSchema: { type: 'object', properties: { id:{type:'string'}, lines:{type:'number'} }, required:['id'] }, annotations:{aliasOf:'fetch'} }
          ]
        }
      });
    }

    if (method === 'tools/call') {
      if (!GAS_BASE || !GAS_KEY) throw new Error('missing GAS_BASE_URL or GAS_KEY');
      const { name, arguments: args = {} } = params ?? {};
      const qs = new URLSearchParams({ token: GAS_KEY });

      const getJSON = async (url) => {
        const r = await fetch(url);
        const ct = r.headers.get('content-type') || '';
        const body = await r.text();
        if (!ct.includes('application/json')) {
          // surface the exact page we got (most often: Google sign-in)
          return { content: [{ type: 'text', text: `GAS returned non‑JSON (${r.status} ${ct}). First 200 chars:\n${body.slice(0,200)}\nURL:\n${url}` }], isError: true };
        }
        return JSON.parse(body);
      };

      if (name === 'search' || name === 'drive_search') {
        if (typeof args.q !== 'string' || !args.q.trim()) throw new Error('q is required');
        qs.append('q', args.q);
        if (args.max != null) qs.append('max', String(args.max));
        if (args.mode) qs.append('mode', String(args.mode));
        const result = await getJSON(`${GAS_BASE}/api/search?${qs.toString()}`);
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: result }], isError: !!result?.isError } });
      }

      if (name === 'fetch' || name === 'drive_fetch') {
        if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('id is required');
        qs.append('id', args.id);
        if (args.lines != null) qs.append('lines', String(args.lines));
        const result = await getJSON(`${GAS_BASE}/api/fetch?${qs.toString()}`);

        // Return text directly when inline
        if (result?.ok && result?.data?.inline && typeof result.data.text === 'string') {
          return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result.data.text }] } });
        }
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: result }], isError: !!result?.isError } });
      }

      throw new Error(`unknown tool: ${name}`);
    }

    // method not found
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (err) {
    return res.json({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32000, message: String(err?.message || err), data: { stack: String(err?.stack || '') } }
    });
  }
});

app.listen(PORT, () => console.log(`YFL bridge listening on http://localhost:${PORT}`));
