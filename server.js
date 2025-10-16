// server.js — YFL Drive Bridge (Node <-> GAS proxy) v3.4.8
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

// ---- Environment & Defaults ----
const PORT         = process.env.PORT || 10000;
const TOKEN        = process.env.TOKEN || process.env.BRIDGE_TOKEN || 'v3c3NJQ4i94';  // Bridge auth token
const GAS_BASE_URL = (process.env.GAS_BASE_URL || '<Your Apps Script exec URL>').replace(/\/+$/, '');
const GAS_KEY      = process.env.GAS_KEY || 'v3c3NJQ4i94';  // Token expected by GAS (Apps Script)
const MCP_PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';  // MCP version date
const DEBUG        = String(process.env.DEBUG || '0') === '1';

// ---- Express App Setup ----
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));
app.set('trust proxy', true);

// ---- Auth Middleware for protected routes ----
function requireToken(req, res, next) {
  const qToken = (req.query.token || '').trim();
  const hToken = (req.get('X-Bridge-Token') || '').trim();
  const provided = qToken || hToken;
  if (!TOKEN || provided !== TOKEN) {
    return res.status(401).json({ ok: false, error: 'bad token' });
  }
  return next();
}

// ---- Helper: mark tools as read-only ----
function mapToolsReadOnly(tools = []) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema || t.inputSchema || { type: 'object' },
    annotations: { readOnlyHint: true }
  }));
}

// ---- Helper: Call GAS action and follow redirect ----
async function gasAction(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) {
    throw new Error('GAS not configured (GAS_BASE_URL or GAS_KEY missing)');
  }
  // Construct the Apps Script URL with query parameters
  const usp = new URLSearchParams({ action, token: GAS_KEY });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) usp.set(k, String(v));
  }
  const url = `${GAS_BASE_URL}?${usp.toString()}`;
  // First request (may receive redirect)
  let response = await fetch(url, { redirect: 'manual', headers: { 'Accept': 'application/json' } });
  // Follow one redirect to script.googleusercontent.com if present
  if ((response.status === 302 || response.status === 303) && response.headers.get('location')) {
    const loc = response.headers.get('location');
    if (loc && /script\.googleusercontent\.com/i.test(loc)) {
      response = await fetch(loc, { redirect: 'follow', headers: { 'Accept': 'application/json' } });
    }
  }
  // Ensure we got JSON back
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    const body = await response.text().catch(() => '');
    throw new Error(`GAS returned non-JSON (${response.status} ${contentType || 'no content-type'}) – body: ${body.slice(0,200)}`);
  }
  const json = await response.json();
  if (DEBUG) console.log(`GAS ${action} →`, JSON.stringify(json).slice(0,200));
  return json;
}

// ---- Basic health check (no auth) ----
app.get('/health', async (_req, res) => {
  try {
    const out = await gasAction('health');
    return res.json({ ok: true, protocol: MCP_PROTOCOL, gas: !!(out && out.ok), ts: out.ts || null });
  } catch (e) {
    return res.status(424).json({ ok: false, gas: false, error: String(e.message || e) });
  }
});

// ---- List available tools (requires token) ----
app.get('/tools/list', requireToken, async (_req, res) => {
  try {
    const out = await gasAction('tools/list');
    return res.json({ ok: true, tools: mapToolsReadOnly(out.tools || []) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- Call a tool action (requires token) ----
app.post('/tools/call', requireToken, async (req, res) => {
  try {
    const { name, arguments: args = {} } = req.body || {};
    if (!name) {
      return res.status(400).json({ ok: false, error: 'name is required' });
    }
    const out = await gasAction('tools/call', { name, ...args });
    return res.json(out);  // Proxy the GAS response (which includes ok/result or error)
  } catch (e) {
    return res.status(424).json({ ok: false, error: String(e.message || e) });
  }
});

// ---- MCP (JSON-RPC) endpoints ----
// Handle connector probe (GET /mcp) and HEAD /mcp
app.head('/mcp', requireToken, (_req, res) => res.sendStatus(204));
app.get('/mcp', requireToken, (_req, res) => {
  return res.json({
    ok: true,
    transport: 'streamable-http',
    how: 'POST this URL with JSON-RPC 2.0 payload',
    server: 'yfl-drive-bridge',
    version: '3.4.8'
  });
});
// Handle JSON-RPC calls (POST /mcp)
app.post('/mcp', requireToken, async (req, res) => {
  const { id, method, params = {} } = req.body || {};
  const rpcError = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') {
      // Return MCP handshake info
      return res.json({ 
        jsonrpc: '2.0', id, 
        result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: 'yfl-drive-bridge', version: '3.4.8' },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }
    if (method === 'tools/list') {
      const out = await gasAction('tools/list');
      return res.json({ 
        jsonrpc: '2.0', id, 
        result: { tools: mapToolsReadOnly(out.tools || []) } 
      });
    }
    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      if (!name) return rpcError(-32602, 'name is required');
      const out = await gasAction('tools/call', { name, ...args });
      // Return result embedded as content (text) and structuredContent (raw JSON)
      return res.json({ 
        jsonrpc: '2.0', id, 
        result: {
          content: [ { type: 'text', text: JSON.stringify(out) } ],
          structuredContent: out,
          isError: false
        }
      });
    }
    // Unknown method
    return rpcError(-32601, `unknown method: ${method}`);
  } catch (e) {
    // Handle exceptions as error response (wrapped in JSON-RPC format)
    return res.json({ 
      jsonrpc: '2.0', id, 
      result: { content: [ { type: 'text', text: String(e.message || e) } ], isError: true }
    });
  }
});

// Catch-all root (optional)
app.get('/', (_req, res) => res.send('YFL MCP Drive Bridge is running.'));

// Start the server
app.listen(PORT, () => {
  console.log(`YFL MCP Bridge listening on port ${PORT}`);
});
