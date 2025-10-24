// server.mjs — YFL Drive Bridge (MCP over Streamable HTTP)
// Node 18+ (global fetch). Run with: node server.mjs
import express from 'express';

const VERSION = '3.1.1n';

// ---- Env
const PORT           = Number(process.env.BRIDGE_PORT || 5050);
const HOST           = process.env.BRIDGE_HOST || '0.0.0.0';
const BRIDGE_TOKEN   = process.env.BRIDGE_TOKEN || process.env.SHARED_KEY || '';
const GAS_BASE_URL   = process.env.GAS_BASE_URL || '';
const GAS_KEY        = process.env.GAS_KEY || process.env.SHARED_KEY || '';

const ALLOW_ORIGINS  = (process.env.ALLOW_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_HEADERS  = (process.env.ALLOW_HEADERS || 'content-type,x-bridge-token,authorization,x-custom-auth-headers')
  .split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_METHODS  = (process.env.ALLOW_METHODS || 'GET,POST,HEAD,OPTIONS')
  .split(',').map(s => s.trim()).filter(Boolean);

// ---- App
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Minimal CORS (manual so we exactly match your preflight needs)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (!ALLOW_ORIGINS.length || ALLOW_ORIGINS.includes(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Methods', ALLOW_METHODS.join(','));
    res.set('Access-Control-Allow-Headers', ALLOW_HEADERS.join(','));
  }
  // Short-circuit preflight
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---- Helpers
function ok(obj) { return { ok: true, ...obj }; }

function authOk(req) {
  const headerToken = (req.headers['x-bridge-token'] || '').toString();
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const qp = (req.query.token || '').toString();
  const t = headerToken || bearer || qp;
  return !BRIDGE_TOKEN || (t && t === BRIDGE_TOKEN);
}

async function gasCall(tool, args = {}) {
  if (!GAS_BASE_URL) throw new Error('GAS_BASE_URL not configured');
  const u = new URL(GAS_BASE_URL);
  u.searchParams.set('tool', tool);
  u.searchParams.set('args', JSON.stringify(args));
  if (GAS_KEY) u.searchParams.set('key', GAS_KEY);

  const r = await fetch(u.toString(), { method: 'GET' });
  if (!r.ok) throw new Error(`GAS ${r.status}`);
  return await r.json();
}

// ---- Health
app.get('/health', (req, res) => {
  res.json({ ok: true, gas: Boolean(GAS_BASE_URL), version: VERSION, ts: new Date().toISOString() });
});

// ---- MCP probes
app.head('/mcp', (req, res) => res.status(204).end());
app.get('/mcp', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  res.json({ ok: true, transport: 'streamable-http' });
});

// ---- MCP JSON-RPC over HTTP POST
app.post('/mcp', async (req, res) => {
  if (!authOk(req)) {
    return res.status(401).json({ jsonrpc: '2.0', id: req.body?.id, error: { code: -32001, message: 'unauthorized' } });
  }

  const { id, method, params } = req.body || {};

  // Utility to send MCP tool results as TEXT content (spec-compliant)
  const textResult = (text, isError = false) => ({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text }],
      ...(isError ? { isError: true } : {})
    }
  });

  try {
    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'YFL Drive Bridge', version: VERSION }
        }
      });
    }

    if (method === 'serverInfo') {
      return res.json({ jsonrpc: '2.0', id, result: { name: 'YFL Drive Bridge', version: VERSION } });
    }

    if (method === 'tools/list') {
      // Expose read-only Drive tools
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'drive.list',
              description: 'List files by folder path/ID',
              inputSchema: {
                type: 'object',
                properties: {
                  folderId: { type: 'string', description: "Drive folder ID (or 'root')" },
                  path: { type: 'string', description: 'Optional path (server may ignore)' },
                  pageToken: { type: 'string' },
                  pageSize: { type: 'integer', minimum: 1, maximum: 200 }
                }
              }
            },
            {
              name: 'drive.search',
              description: 'Drive v2 query (e.g., title contains "…" and trashed=false)',
              inputSchema: {
                type: 'object',
                properties: {
                  q: { type: 'string', description: 'Drive v2 search query' },
                  query: { type: 'string', description: 'Alias of q' },
                  pageToken: { type: 'string' },
                  pageSize: { type: 'integer', minimum: 1, maximum: 200 }
                },
                required: ['q']
              }
            },
            {
              name: 'drive.get',
              description: 'Get metadata by file id',
              inputSchema: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id']
              }
            },
            {
              name: 'drive.export',
              description: 'Export Google Docs/Sheets/Slides or text',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'File ID' },
                  mime: { type: 'string', description: 'target MIME (text/plain, text/csv, application/pdf, …)' }
                },
                required: ['id']
              }
            }
          ]
        }
      });
    }

    if (method === 'tools/call') {
      const name  = params?.name;
      const args  = params?.arguments || {};
      let payload;

      if (name === 'drive.search') {
        payload = await gasCall('drive.search', args);
      } else if (name === 'drive.list') {
        payload = await gasCall('drive.list', args);
      } else if (name === 'drive.get') {
        payload = await gasCall('drive.get', args);
      } else if (name === 'drive.export') {
        payload = await gasCall('drive.export', args);
      } else {
        return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
      }

      // MCP content: text (stringified JSON)
      return res.json(textResult(JSON.stringify(payload, null, 2)));
    }

    // Unknown method
    return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  } catch (err) {
    return res.json(textResult(`Error: ${String(err && err.message || err)}`, true));
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}  (version ${VERSION})`);
});
