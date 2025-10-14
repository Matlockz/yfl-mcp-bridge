// server.js (YFL Drive Bridge)
// Node 18+ / ESM

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import fetch from 'node-fetch';

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT          = process.env.PORT || 10000;
const TOKEN         = process.env.BRIDGE_TOKEN || process.env.TOKEN || '';
const GAS_BASE_URL  = process.env.GAS_BASE_URL || '';
const GAS_KEY       = process.env.GAS_KEY || '';
const MCP_PROTOCOL  = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG         = String(process.env.DEBUG || '0') === '1';

function requireToken(req, res, next) {
  const t = (req.query.token || req.get('X-Bridge-Token') || '').trim();
  if (!TOKEN || t !== TOKEN) return res.status(401).json({ ok:false, error:'bad token' });
  return next();
}

async function getGas(path) {
  const url = `${GAS_BASE_URL}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(GAS_KEY)}`;
  const r = await fetch(url, { redirect: 'manual' });
  // If GAS returns HTML (e.g., sign-in), it's not our /exec deployment.
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json')) {
    const text = await r.text();
    throw new Error(`GAS returned non-JSON (${r.status} ${ct || 'no-ct'}) — first 200 chars: ${text.slice(0,200)}`);
  }
  return await r.json();
}

// --- health
app.get('/health', async (req, res) => {
  try {
    const ok = await getGas('/api/health');
    return res.json({ ok:true, protocol: MCP_PROTOCOL, gas: !!(ok && ok.ok) });
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(424).json({ ok:false, gas:false, error:String(e && e.message || e), base:GAS_BASE_URL });
  }
});

// --- MCP (streamable HTTP over JSON)
app.post('/mcp', requireToken, async (req, res) => {
  try {
    const { jsonrpc, id, method, params = {} } = req.body || {};
    if (method === 'initialize') {
      return res.json({
        jsonrpc: "2.0",
        id, result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: "yfl-drive-bridge", version: "3.3.1" },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }
    if (method === 'tools/list') {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "search",
              description: "Search Google Drive by filename (contains).",
              inputSchema: {
                type: "object",
                properties: {
                  q:   { type: "string" },
                  max: { type: "integer", minimum: 1, maximum: 100, default: 5 }
                },
                required: ["q"]
              }
            },
            {
              name: "fetch",
              description: "Fetch by file id; inline text when possible, else JSON metadata.",
              inputSchema: {
                type: "object",
                properties: {
                  id:    { type: "string" },
                  lines: { type: "integer", minimum: 0, maximum: 1000000, default: 0 }
                },
                required: ["id"]
              }
            },
            { name: "drive_search", description: "Alias of search", inputSchema: { type:"object", properties:{ q:{type:"string"}, max:{type:"integer",minimum:1,maximum:100,default:5 }}, required:["q"] } },
            { name: "drive_fetch",  description: "Alias of fetch",  inputSchema: { type:"object", properties:{ id:{type:"string"}, lines:{type:"integer",minimum:0,maximum:1000000,default:0 }}, required:["id"] } }
          ]
        }
      });
    }
    if (method === 'tools/call') {
      const name = params.name;
      const args = params.arguments || {};
      if (name === 'search' || name === 'drive_search') {
        const q   = String(args.q || '').trim();
        const max = Math.min(Math.max(parseInt(args.max || 5, 10) || 5, 1), 100);
        if (!q) return res.json({ jsonrpc:"2.0", id, error:{ code:-32602, message:"q is required" } });
        const out = await getGas(`/api/search?q=${encodeURIComponent(q)}&max=${max}`);
        return res.json({ jsonrpc:"2.0", id, result:{ content:[{ type:"json", json:out }], isError:false } });
      }
      if (name === 'fetch' || name === 'drive_fetch') {
        const idv   = String(args.id || '').trim();
        const lines = Math.max(parseInt(args.lines || 0, 10) || 0, 0);
        if (!idv) return res.json({ jsonrpc:"2.0", id, error:{ code:-32602, message:"id is required" } });
        const out = await getGas(`/api/fetch?id=${encodeURIComponent(idv)}&lines=${lines}`);
        return res.json({ jsonrpc:"2.0", id, result:{ content:[{ type:"json", json:out }], isError:false } });
      }
      return res.json({ jsonrpc:"2.0", id, error:{ code:-32601, message:`unknown tool: ${name}` } });
    }
    return res.json({ jsonrpc:"2.0", id, error:{ code:-32601, message:`unknown method: ${method}` } });
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.json({ jsonrpc:"2.0", id:req.body && req.body.id, result:{ content:[{ type:"text", text:String(e && e.message || e) }], isError:true } });
  }
});

app.get('/', (req, res) => res.send('YFL MCP Drive Bridge is running.'));
app.listen(PORT, () => console.log(`YFL MCP Bridge on :${PORT}`));
