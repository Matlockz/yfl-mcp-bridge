// server.js — YFL MCP Drive Bridge v3.3 (Node 18+, ESM)
import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT         = process.env.PORT || 10000;
const PROTOCOL     = process.env.MCP_PROTOCOL || '2024-11-05';
const RAW_BASE     = process.env.GAS_BASE_URL || '';
const GAS_BASE     = RAW_BASE.replace(/\s+/g, '').replace(/\/+$/,''); // trim whitespace & trailing slash
const GAS_KEY      = process.env.GAS_KEY;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.BRIDGE_API_KEY || process.env.TOKEN;
const DEBUG        = String(process.env.DEBUG || '') === '1';

const ok  = (id, result)                 => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message, data={}) => ({ jsonrpc: '2.0', id, error: { code, message, data } });

function mustConfig() {
  if (!GAS_BASE || !GAS_KEY) throw new Error('missing GAS_BASE_URL or GAS_KEY env');
}
function qs(params) {
  const u = new URLSearchParams({ token: GAS_KEY });
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') u.append(k, String(v));
  }
  return u.toString();
}
function textContent(text) { return [{ type: 'text', text: String(text ?? '') }]; }
function jsonContent(obj)  { return [{ type: 'json', json: obj }]; }

//---------------- Health
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), protocol: PROTOCOL, gas: !!GAS_BASE });
});

//---------------- SSE discovery
app.get('/mcp', (req, res, next) => {
  const accept = String(req.headers.accept || '');
  if (!accept.includes('text/event-stream')) return next();

  if (BRIDGE_TOKEN) {
    const t = req.query.token || req.header('X-Bridge-Token');
    if (t !== BRIDGE_TOKEN) return res.status(401).end('Unauthorized');
  }

  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const url  = new URL(req.protocol + '://' + req.get('host') + req.originalUrl);
  const full = url.origin + url.pathname + url.search;

  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ url: full })}\n\n`);
  const t = setInterval(() => res.write(': keepalive\n\n'), 25000);
  req.on('close', () => clearInterval(t));
});

//---------------- JSON-RPC
app.post('/mcp', async (req, res) => {
  try {
    if (BRIDGE_TOKEN) {
      const tok = req.query.token || req.header('X-Bridge-Token');
      if (tok !== BRIDGE_TOKEN) return res.status(401).json(err(req.body?.id ?? null, -32001, 'Unauthorized'));
    }

    const { id, method, params } = req.body || {};
    if (!method) return res.json(err(id ?? null, -32600, 'Invalid Request: missing method'));

    if (method === 'initialize') {
      return res.json(ok(id, {
        protocolVersion: PROTOCOL,
        serverInfo: { name: 'yfl-drive-bridge', version: '3.3.0' },
        capabilities: { tools: { listChanged: true }, logging: {}, prompts: { listChanged: false }, resources: { listChanged: false } }
      }));
    }
    if (method === 'notifications/initialized') return res.json(ok(id, {}));
    if (method === 'ping') return res.json(ok(id, { pong: true, now: Date.now() }));

    if (method === 'tools/list') {
      const tools = [
        {
          name: 'search',
          description: 'Search Google Drive. mode: "name" (default) or "content".',
          inputSchema: {
            type: 'object',
            properties: {
              q:    { type: 'string',  description: 'Query string.' },
              max:  { type: 'integer', minimum: 1, maximum: 100, default: 25 },
              mode: { type: 'string',  enum: ['name','content'], default: 'name' }
            },
            required: ['q'], additionalProperties: false
          },
          annotations: { readOnlyHint: true, openWorldHint: true, title: 'Drive Search' }
        },
        {
          name: 'fetch',
          description: 'Fetch file by id; inline text when possible, else JSON metadata.',
          inputSchema: {
            type: 'object',
            properties: {
              id:    { type: 'string', description: 'Drive file ID.' },
              lines: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 }
            },
            required: ['id'], additionalProperties: false
          },
          annotations: { readOnlyHint: true, openWorldHint: true, title: 'Drive Fetch' }
        },
        { name: 'drive_search', description: 'Alias of search.', inputSchema: { type: 'object',
            properties: { q:{type:'string'}, max:{type:'integer',minimum:1,maximum:100,default:25}, mode:{type:'string',enum:['name','content'],default:'name'} },
            required:['q'], additionalProperties:false }, annotations:{ readOnlyHint:true, openWorldHint:true } },
        { name: 'drive_fetch',  description: 'Alias of fetch.',  inputSchema: { type: 'object',
            properties: { id:{type:'string'}, lines:{type:'integer',minimum:0,maximum:1000000,default:0} },
            required:['id'], additionalProperties:false }, annotations:{ readOnlyHint:true, openWorldHint:true } }
      ];
      return res.json(ok(id, { tools }));
    }

    if (method === 'tools/call') {
      mustConfig();
      const name = params?.name;
      const args = params?.arguments ?? {};

      // helper to fetch GAS robustly
      const getGasJson = async (url) => {
        const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
        const ct = r.headers.get('content-type') || '';
        const body = await r.text();

        if (DEBUG) console.log('[GAS]', r.status, ct, url, body.slice(0, 120));

        // Try to parse JSON regardless of content-type
        try {
          return { ok: r.ok, json: JSON.parse(body), status: r.status, ct };
        } catch (e) {
          // Not JSON → return structured error (prevents "<!doctype" crashes)
          return { ok: false, html: body.slice(0, 200), status: r.status, ct, url };
        }
      };

      if (name === 'search' || name === 'drive_search') {
        const q    = typeof args.q === 'string' ? args.q.trim() : '';
        const max  = args.max != null ? Number(args.max) : undefined;
        const mode = (args.mode === 'content') ? 'content' : 'name';
        if (!q) return res.json(err(id, -32602, 'q is required'));

        const url = `${GAS_BASE}/api/search?${qs({ q, max, mode })}`;
        const resp = await getGasJson(url);
        if (!resp.ok) {
          const msg = `GAS returned non‑JSON (${resp.status} ${resp.ct || ''}). First 200 chars:\n${resp.html || ''}\nURL:\n${resp.url}`;
          return res.json(ok(id, { content: textContent(msg), isError: true }));
        }
        return res.json(ok(id, { content: jsonContent(resp.json.data ?? resp.json), isError: false }));
      }

      if (name === 'fetch' || name === 'drive_fetch') {
        const fid   = typeof args.id === 'string' ? args.id.trim() : '';
        const lines = args.lines != null ? Number(args.lines) : undefined;
        if (!fid) return res.json(err(id, -32602, 'id is required'));

        const url = `${GAS_BASE}/api/fetch?${qs({ id: fid, lines })}`;
        const resp = await getGasJson(url);
        if (!resp.ok) {
          const msg = `GAS returned non‑JSON (${resp.status} ${resp.ct || ''}). First 200 chars:\n${resp.html || ''}\nURL:\n${resp.url}`;
          return res.json(ok(id, { content: textContent(msg), isError: true }));
        }
        const j = resp.json;
        if ((j.data || {}).inline && typeof j.data.text === 'string') {
          return res.json(ok(id, { content: textContent(j.data.text), isError: false }));
        }
        return res.json(ok(id, { content: jsonContent(j.data ?? j), isError: false }));
      }

      return res.json(err(id, -32002, `Tool not found: ${name}`));
    }

    return res.json(err(id ?? null, -32601, 'Method not found'));
  } catch (e) {
    return res.json(err(req.body?.id ?? null, -32000, String(e?.message || e), { stack: String(e?.stack || '') }));
  }
});

app.listen(PORT, () => console.log(`YFL MCP Bridge listening on ${PORT}`));
