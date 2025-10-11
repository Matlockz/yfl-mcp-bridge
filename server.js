// server.js — YFL MCP Drive Bridge (Node 18+, ESM)
import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT      = process.env.PORT || 10000;
const PROTOCOL  = process.env.MCP_PROTOCOL || '2024-11-05';
const GAS_BASE  = process.env.GAS_BASE_URL;     // e.g. https://script.google.com/macros/s/.../exec
const GAS_KEY   = process.env.GAS_KEY || process.env.TOKEN || process.env.BRIDGE_TOKEN;

// ---------- helpers ----------
function ok(res, id, result) {
  return res.json({ jsonrpc: '2.0', id, result });
}
function err(res, id, code, message, data) {
  return res.json({ jsonrpc: '2.0', id, error: { code, message, data } });
}
const contentJson = (obj) => [{ type: 'json', json: obj }];
const contentText = (text) => [{ type: 'text', text: String(text ?? '') }];
function ensureConfig() {
  if (!GAS_BASE || !GAS_KEY) throw new Error('missing GAS_BASE_URL or GAS_KEY env');
}

// ---------- basics ----------
app.get('/', (req, res) => res.type('text/plain').send('YFL MCP Bridge is running.'));
app.get('/health', (req, res) =>
  res.json({ ok: true, uptime: process.uptime(), protocol: PROTOCOL, gas: !!GAS_BASE })
);

// ---------- SSE (legacy HTTP+SSE transport) ----------
app.get('/mcp', (req, res, next) => {
  const accept = String(req.headers.accept || '');
  if (!accept.includes('text/event-stream')) return next();

  res.set({
    'Cache-Control': 'no-store',
    'Content-Type': 'text/event-stream',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const url = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
  const endpoint = url.origin + url.pathname + url.search; // absolute URL is safest
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ url: endpoint })}\n\n`);

  const t = setInterval(() => res.write(': keepalive\n\n'), 25000);
  req.on('close', () => clearInterval(t));
});

// ---------- JSON-RPC (Streamable HTTP) ----------
app.post('/mcp', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { id, method, params } = req.body || {};
    if (!method) return err(res, id ?? null, -32600, 'Invalid Request: missing method');

    if (method === 'initialize') {
      return ok(res, id, {
        protocolVersion: PROTOCOL,
        capabilities: {
          logging: {},
          tools: { listChanged: true },
          resources: { listChanged: false },
          prompts: { listChanged: false }
        },
        serverInfo: { name: 'yfl-drive-bridge', version: '3.0.0' }
      });
    }

    if (method === 'notifications/initialized') return ok(res, id, {});
    if (method === 'ping') return ok(res, id, { pong: true, now: Date.now() });

    if (method === 'tools/list') {
      const tools = [
        {
          name: 'search',
          description: 'Search Google Drive (by filename substring).',
          inputSchema: {
            type: 'object',
            properties: {
              q: { type: 'string', description: 'Substring to search for in file names.' },
              max: { type: 'integer', minimum: 1, maximum: 100, default: 10 }
            },
            required: ['q'],
            additionalProperties: false
          }
        },
        {
          name: 'fetch',
          description: 'Fetch file content by Drive file ID. Returns text when possible; otherwise metadata.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Drive file ID.' },
              lines: { type: 'integer', minimum: 0, maximum: 1000000, default: 0,
                       description: 'If >0, return only the first N lines.' }
            },
            required: ['id'],
            additionalProperties: false
          }
        },
        // Back-compat aliases
        {
          name: 'drive_search',
          description: 'Alias of `search`.',
          inputSchema: { type: 'object',
            properties: { q: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 100, default: 10 } },
            required: ['q'], additionalProperties: false }
        },
        {
          name: 'drive_fetch',
          description: 'Alias of `fetch`.',
          inputSchema: { type: 'object',
            properties: { id: { type: 'string' }, lines: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 } },
            required: ['id'], additionalProperties: false }
        }
      ];
      return ok(res, id, { tools });
    }

    if (method === 'tools/call') {
      ensureConfig();
      const { name, arguments: args = {} } = params ?? {};
      if (!name) return err(res, id, -32602, 'Missing tool name');

      const qs = new URLSearchParams({ token: GAS_KEY });

      if (name === 'search' || name === 'drive_search') {
        const q = typeof args.q === 'string' ? args.q.trim() : '';
        if (!q) return err(res, id, -32602, 'q is required');
        qs.append('q', q);
        if (args.max != null) qs.append('max', String(args.max));
        const r = await fetch(`${GAS_BASE}/api/search?${qs.toString()}`);
        if (!r.ok) {
          const body = await r.text();
          return ok(res, id, { content: contentText(`Drive search failed (${r.status}). Body: ${body}`), isError: true });
        }
        const j = await r.json();
        return ok(res, id, { content: contentJson(j.data ?? j), isError: false });
      }

      if (name === 'fetch' || name === 'drive_fetch') {
        const fid = typeof args.id === 'string' ? args.id.trim() : '';
        if (!fid) return err(res, id, -32602, 'id is required');
        qs.append('id', fid);
        if (args.lines != null) qs.append('lines', String(args.lines));
        const r = await fetch(`${GAS_BASE}/api/fetch?${qs.toString()}`);
        if (!r.ok) {
          const body = await r.text();
          return ok(res, id, { content: contentText(`Drive fetch failed (${r.status}). Body: ${body}`), isError: true });
        }
        const j = await r.json();
        if ((j.data || {}).inline) {
          return ok(res, id, { content: contentText(j.data.text ?? ''), isError: false });
        }
        return ok(res, id, { content: contentJson(j.data ?? j), isError: false });
      }

      return err(res, id, -32002, `Tool not found: ${name}`);
    }

    return err(res, id, -32601, 'Method not found');
  } catch (e) {
    return err(res, (req.body && req.body.id) ?? null, -32000, String(e?.message || e), { stack: String(e?.stack || '') });
  }
});

app.listen(PORT, () => console.log(`YFL MCP Bridge listening on port ${PORT}`));
