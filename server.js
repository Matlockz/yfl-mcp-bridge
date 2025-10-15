// YFL Drive Bridge (v3.6.0) — local ESM (.mjs)
// Surfaces:
//   - REST:   GET /tools/list, POST /tools/call, GET /health
//   - MCP:    POST /mcp   (JSON-RPC 2.0 over HTTP)
// Requirements:
//   env: PORT, GAS_BASE_URL (your .../exec), GAS_KEY (shared key from GAS), BRIDGE_TOKEN (or TOKEN)

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

// Node 18+ has a global fetch; no node-fetch needed
const app  = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// ----- env
const PORT          = process.env.PORT || 10000;
const BRIDGE_TOKEN  = (process.env.BRIDGE_TOKEN || process.env.TOKEN || '').trim();
const GAS_BASE_URL  = (process.env.GAS_BASE_URL || '').replace(/\/$/, ''); // e.g. https://script.google.com/.../exec
const GAS_KEY       = (process.env.GAS_KEY || '').trim();
const MCP_PROTOCOL  = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG         = String(process.env.DEBUG || '0') === '1';

// ----- helpers
function readTokenFrom(req) {
  const q = (req.query.token || '').toString().trim();
  const h = (req.get('X-Bridge-Token') || '').trim();
  const a = (req.get('Authorization') || '').trim(); // Bearer <token>
  const b = a.toLowerCase().startsWith('bearer ') ? a.slice(7).trim() : '';
  return q || h || b;
}
function requireToken(req, res, next) {
  if (!BRIDGE_TOKEN) return res.status(500).json({ ok:false, error:'bridge token not configured' });
  if (readTokenFrom(req) !== BRIDGE_TOKEN) return res.status(401).json({ ok:false, error:'bad token' });
  return next();
}

// CORS preflight (Inspector / browser)
app.options('*', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Bridge-Token, Authorization, MCP-Protocol-Version',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  return res.sendStatus(204);
});

// One place to call GAS (always as /exec?action=...&token=GAS_KEY)
async function gasCall(action, args = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error('GAS_BASE_URL or GAS_KEY not set');
  const params = new URLSearchParams({ action, token: GAS_KEY });
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const url = `${GAS_BASE_URL}?${params.toString()}`;
  const r   = await fetch(url, { redirect: 'manual' });
  const ct  = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    const text = await r.text();
    throw new Error(`GAS returned non-JSON (${r.status} ${ct || 'no-ct'}) — first 200 chars: ${text.slice(0,200)}`);
  }
  return await r.json();
}

// ---------- REST surface (for quick smoke tests)

app.get('/health', async (_req, res) => {
  try {
    const ping = await gasCall('health');
    return res.json({ ok:true, protocol: MCP_PROTOCOL, gas: !!(ping && ping.ok), ts: new Date().toISOString() });
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(424).json({ ok:false, gas:false, error: String(e && e.message || e) });
  }
});

app.get('/tools/list', requireToken, async (_req, res) => {
  try {
    const out = await gasCall('tools/list');
    return res.json(out);
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(424).json({ ok:false, error: String(e && e.message || e) });
  }
});

app.post('/tools/call', requireToken, async (req, res) => {
  try {
    const { name, arguments: args = {} } = req.body || {};
    if (!name) return res.status(400).json({ ok:false, error:'name required' });
    const out = await gasCall('tools/call', { name, ...args });
    return res.json(out);
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(424).json({ ok:false, error: String(e && e.message || e) });
  }
});

// ---------- MCP surface (JSON-RPC over HTTP)

const TOOL_DEFS = [
  {
    name: "drive.list",
    description: "List files in a folder by path or folderId.",
    inputSchema: {
      type: "object",
      properties: {
        folderPath: { type:"string" },
        folderId:   { type:"string" },
        limit:      { type:"integer", minimum:1, maximum:200 }
      }
    }
  },
  {
    name: "drive.search",
    description: "Search files with DriveApp (v2-style query syntax).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type:"string" },
        limit: { type:"integer", minimum:1, maximum:200 }
      },
      required: ["query"]
    }
  },
  {
    name: "drive.get",
    description: "Get file metadata by id (Advanced Drive v3).",
    inputSchema: {
      type: "object",
      properties: { id: { type:"string" } },
      required: ["id"]
    }
  }
];

app.post('/mcp', requireToken, async (req, res) => {
  const { jsonrpc, id, method, params = {} } = req.body || {};
  const reply = (payload) => res.json({ jsonrpc: "2.0", id, ...payload });

  try {
    if (method === 'initialize') {
      return reply({
        result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: "yfl-drive-bridge", version: "3.6.0" },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }

    if (method === 'tools/list') {
      return reply({ result: { tools: TOOL_DEFS } });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params || {};
      if (!name) return reply({ error: { code: -32602, message: 'tool name required' } });

      // Map calls 1:1 to GAS "tools/call"
      //   drive.list   → args: { folderPath?, folderId?, limit? }
      //   drive.search → args: { query, limit? }
      //   drive.get    → args: { id }
      const out = await gasCall('tools/call', { name, ...args });
      return reply({ result: { content: [{ type: 'json', json: out }], isError: false } });
    }

    return reply({ error: { code: -32601, message: `unknown method: ${method}` } });
  } catch (e) {
    if (DEBUG) console.error(e);
    return reply({ result: { content: [{ type: 'text', text: String(e && e.message || e) }], isError: true } });
  }
});

// ---------- root
app.get('/', (_req, res) => res.send('YFL MCP Drive Bridge is running.'));
app.listen(PORT, () => console.log(`YFL MCP Bridge listening on :${PORT}`));
