// server.js — YFL Drive Bridge MCP bridge (v3.3.1, spec-safe)
// Node >= 18 (uses global fetch). CommonJS for simplicity.

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', true);

// ----- ENV -----
const PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';
const GAS_BASE  = (process.env.GAS_BASE_URL || '').replace(/\/+$/, '');
const GAS_KEY   = process.env.GAS_KEY || process.env.TOKEN || process.env.BRIDGE_TOKEN || '';
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY || process.env.BRIDGE_APIKEY || '';

// ----- Helpers -----
function json(res, code, obj) {
  res.status(code).set('Cache-Control', 'no-store').json(obj);
}

async function gasGet(path, params = {}) {
  if (!GAS_BASE) throw new Error('GAS_BASE_URL missing');
  if (!GAS_KEY)  throw new Error('GAS token missing');

  const url = new URL(GAS_BASE + '/' + path.replace(/^\//, ''));
  url.searchParams.set('token', GAS_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const r = await fetch(url.toString(), { method: 'GET' });
  const ctype = (r.headers.get('content-type') || '').toLowerCase();

  if (!ctype.includes('application/json')) {
    const t = await r.text();
    // Common failure: Google sign-in HTML if Apps Script deploy isn’t public
    const head = t.slice(0, 200);
    const msg = `GAS returned non-JSON (${r.status} ${ctype}) — first 200 chars: ${head}`;
    const err = new Error(msg);
    err.status = 424;
    err.nonJson = true;
    throw err;
  }

  const body = await r.json();
  if (!body || body.ok === false) {
    const msg = (body && body.error) ? String(body.error) : 'GAS returned ok:false';
    const err = new Error(msg);
    err.status = 424;
    throw err;
  }
  return body; // { ok:true, data: ... } or { ok:true }
}

// MCP tool result helpers (spec-safe)
function okText(text) {
  return { content: [{ type: 'text', text }], isError: false };
}
function errText(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ----- Health -----
app.get('/health', async (req, res) => {
  try {
    const body = await gasGet('api/health');
    return json(res, 200, { ok: true, protocol: PROTOCOL, gas: true });
  } catch (e) {
    const code = e.status || 424;
    const error = String(e.message || e);
    return json(res, code, { ok: false, error, gas: false });
  }
});

// ----- SSE endpoint discovery (optional) -----
app.get('/mcp', (req, res) => {
  const accept = (req.headers['accept'] || '').toLowerCase();
  if (!accept.includes('text/event-stream')) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send('Use POST for JSON-RPC. To open SSE, request with Accept: text/event-stream.');
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const endpoint = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ url: endpoint })}\n\n`);
  const t = setInterval(() => res.write(`: keepalive\n\n`), 30_000);
  req.on('close', () => clearInterval(t));
});

// ----- JSON-RPC (MCP) -----
app.post('/mcp', async (req, res) => {
  try {
    const { id, method, params } = req.body || {};

    if (method === 'initialize') {
      return json(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.3.1' },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }

    if (method === 'tools/list') {
      return json(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'search',
              description: 'Search Google Drive by filename (contains).',
              inputSchema: {
                type: 'object',
                properties: {
                  q:   { type: 'string', description: 'substring to match in filename' },
                  max: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
                  mode:{ type: 'string', enum: ['name', 'content'], description: 'optional; currently name-only' }
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
                  lines: { type: 'integer', minimum: 0, maximum: 1000000, default: 0 }
                },
                required: ['id']
              }
            },
            { name: 'drive_search', description: 'Alias of search', inputSchema: { type: 'object', properties: { q:{type:'string'}, max:{type:'integer'} }, required:['q'] } },
            { name: 'drive_fetch',  description: 'Alias of fetch',  inputSchema: { type: 'object', properties: { id:{type:'string'}, lines:{type:'integer'} }, required:['id'] } }
          ]
        }
      });
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};

      try {
        if (name === 'search' || name === 'drive_search') {
          const q   = String(args.q || '').trim();
          const max = Math.max(1, Math.min(parseInt(args.max ?? 25, 10) || 25, 100));
          if (!q) return json(res, 200, { jsonrpc: '2.0', id, result: errText('q is required') });

          const body = await gasGet('api/search', { q, max });
          const payload = body.data || body; // {query,count,files}
          return json(res, 200, { jsonrpc: '2.0', id, result: okText(JSON.stringify(payload, null, 2)) });
        }

        if (name === 'fetch' || name === 'drive_fetch') {
          const idArg  = String(args.id || '').trim();
          const lines  = Math.max(0, Math.min(parseInt(args.lines ?? 0, 10) || 0, 1000000));
          if (!idArg) return json(res, 200, { jsonrpc: '2.0', id, result: errText('id is required') });

          const body = await gasGet('api/fetch', { id: idArg, lines });
          const payload = body.data || body;
          // If GAS delivered inline text, send text; else JSON
          if (payload && payload.inline && typeof payload.text === 'string') {
            return json(res, 200, { jsonrpc: '2.0', id, result: okText(payload.text) });
          }
          return json(res, 200, { jsonrpc: '2.0', id, result: okText(JSON.stringify(payload, null, 2)) });
        }

        return json(res, 200, { jsonrpc: '2.0', id, result: errText(`unknown tool: ${name}`) });

      } catch (e) {
        const msg = String(e.message || e);
        return json(res, 200, { jsonrpc: '2.0', id, result: errText(msg) });
      }
    }

    // Unknown method
    return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });

  } catch (err) {
    return json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: String(err?.message || err) } });
  }
});

// ----- Start -----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`yfl-drive-bridge listening on ${PORT}`);
});
