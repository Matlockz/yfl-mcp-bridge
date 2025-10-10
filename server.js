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
app.get('/health', (_, res) => res.json({ ok: true }));

// ---------- SSE discovery ----------
app.get('/mcp', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive'
  });
  const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ messages: url.href })}\n\n`);
  const t = setInterval(() => res.write(': keepalive\n\n'), 25000);
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
          serverInfo: { name: 'yfl-mcp-bridge', version: '1.0.0' },
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
                  q: { type: 'string', description: 'substring to match' },
                  max: { type: 'number', minimum: 1, maximum: 100, default: 10 }
                },
                required: ['q']
              },
              annotations: { readOnlyHint: true, openWorldHint: true }
            },
            {
              name: 'fetch',
              description: 'Fetch a Google Drive file by id; inline text when available.',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  lines: { type: 'number', minimum: 0, default: 0 }
                },
                required: ['id']
              },
              annotations: { readOnlyHint: true, openWorldHint: true }
            },
            // aliases used in your tests
            { name: 'drive_search', description: 'Alias of search', inputSchema: { type:'object', properties:{ q:{type:'string'}, max:{type:'number'} }, required:['q'] }, annotations: { readOnlyHint: true, openWorldHint: true } },
            { name: 'drive_fetch',  description: 'Alias of fetch',  inputSchema: { type:'object', properties:{ id:{type:'string'}, lines:{type:'number'} }, required:['id'] }, annotations: { readOnlyHint: true, openWorldHint: true } }
          ]
        }
      });
    }

    if (method === 'tools/call') {
      if (!GAS_BASE || !GAS_KEY) throw new Error('missing GAS_BASE_URL or GAS_KEY');
      const { name, arguments: args = {} } = params ?? {};
      const qs = new URLSearchParams({ token: GAS_KEY });

      if (name === 'search' || name === 'drive_search') {
        if (typeof args.q !== 'string' || !args.q.trim()) throw new Error('q is required');
        qs.append('q', args.q);
        if (args.max != null) qs.append('max', String(args.max));
        const r = await fetch(`${GAS_BASE}/api/search?${qs.toString()}`);
        const j = await r.json();
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: j.data ?? j }] } });
      }

      if (name === 'fetch' || name === 'drive_fetch') {
        if (typeof args.id !== 'string' || !args.id.trim()) throw new Error('id is required');
        qs.append('id', args.id);
        if (args.lines != null) qs.append('lines', String(args.lines));
        const r = await fetch(`${GAS_BASE}/api/fetch?${qs.toString()}`);
        const j = await r.json();
        if ((j.data || {}).inline) {
          return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: j.data.text ?? '' }] } });
        }
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'json', json: j.data ?? j }] } });
      }

      throw new Error(`unknown tool: ${name}`);
    }

    // method not found
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (err) {
    // JSON-RPC error envelope
    return res.json({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32000, message: String(err?.message || err), data: { stack: String(err?.stack || '') } }
    });
  }
});

app.listen(PORT, () => console.log(`YFL bridge listening on http://localhost:${PORT}`));
