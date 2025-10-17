// server.mjs — YFL Drive Bridge v3.1.1 (adds drive.export to toolList)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

const app = express();
const PORT = process.env.PORT || 10000;
const GAS_BASE_URL = process.env.GAS_BASE_URL;
const GAS_KEY = process.env.GAS_KEY;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.TOKEN || GAS_KEY;

if (!GAS_BASE_URL || !GAS_KEY || !BRIDGE_TOKEN) {
  console.error('[FATAL] Missing GAS_BASE_URL / GAS_KEY / BRIDGE_TOKEN in .env');
  process.exit(1);
}

app.set('trust proxy', 1);
app.use(cors({
  origin: true,
  methods: ['GET','POST','HEAD','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Bridge-Token','MCP-Protocol-Version','ngrok-skip-browser-warning'],
}));
app.options('*', cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

const j = (res, code, obj) => res.status(code).json(obj);
const ok = (obj={}) => ({ ok: true, ...obj });
const err = (msg, data={}) => ({ ok: false, error: msg, ...data });

const getTokenFromReq = (req) =>
  (req.query.token) ||
  (req.headers['x-bridge-token']) ||
  (req.headers['authorization']?.replace(/^Bearer\s+/i, ''));

function requireToken(req,res,next){
  const t = getTokenFromReq(req);
  if (!t || t !== BRIDGE_TOKEN) return j(res, 401, err('unauthorized'));
  next();
}

function gasUrl(action, extraParams={}){
  const u = new URL(GAS_BASE_URL);
  u.searchParams.set('action', action);
  u.searchParams.set('token', GAS_KEY);
  for (const [k,v] of Object.entries(extraParams)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function callGAS(action, params={}){
  const url = gasUrl(action, params);
  const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text();
    throw new Error(`GAS non-JSON (${res.status} ${ct}): ${text.slice(0,200)}`);
  }
  return res.json();
}

function normalizeGasPayload(g){
  if (g && g.ok && g.data !== undefined) return g.data;
  return g;
}

// ---- Health
app.get('/health', async (req,res)=>{
  try {
    const ping = await callGAS('health');
    j(res, 200, ok({ gas: !!ping?.ok, ts: new Date().toISOString() }));
  } catch (e) {
    j(res, 200, ok({ gas: false, error: String(e), ts: new Date().toISOString() }));
  }
});

// ---- Simple REST helpers
app.get('/tools/list', requireToken, async (req,res)=>{
  j(res, 200, ok({ tools: toolList().map(t=>t.name) }));
});
app.post('/tools/call', requireToken, async (req,res)=>{
  try{
    const name = req.body?.name || req.query?.name;
    const args = req.body?.arguments || req.body || {};
    if (!name) return j(res, 400, err('missing tool name'));
    const gas = await callGAS('tools/call', { name, ...args });
    j(res, 200, ok(normalizeGasPayload(gas)));
  } catch(e){
    j(res, 500, err('tools.call failed', { detail: String(e) }));
  }
});

// ---- MCP (Streamable HTTP)
app.head('/mcp', requireToken, (req,res)=>res.status(204).end());
app.get('/mcp', requireToken, (req,res)=> j(res, 200, ok({ transport: 'streamable-http' })));

app.post('/mcp', requireToken, async (req,res)=>{
  const { id, method, params } = req.body || {};
  const rpcErr = (code, message, data)=>({ jsonrpc:'2.0', id, error:{ code, message, data }});
  const rpcOk  = (payload, isError=false)=>({
    jsonrpc:'2.0', id,
    result:{ content:[{type:'text',text:JSON.stringify(payload)}], structuredContent: payload, isError }
  });

  try{
    if (!req.body || req.body.jsonrpc !== '2.0')
      return res.status(400).json(rpcErr(-32600, 'Invalid Request'));

    if (method === 'initialize'){
      return res.json({ jsonrpc:'2.0', id,
        result:{ protocolVersion:'2024-11-05', capabilities:{ tools:{ listChanged:true } },
        serverInfo:{ name:'yfl-drive-bridge', version:'3.1.1' } } });
    }
    if (method === 'tools/list'){
      return res.json({ jsonrpc:'2.0', id, result: { tools: toolList() }});
    }
    if (method === 'tools/call'){
      const name = params?.name;
      const args = params?.arguments || {};
      if (!name) return res.json(rpcErr(-32602, 'Invalid params: missing name'));
      const gas = await callGAS('tools/call', { name, ...args });
      return res.json(rpcOk(normalizeGasPayload(gas), gas?.ok === false));
    }
    return res.json(rpcErr(-32601, 'Method not found'));
  } catch(e){
    return res.json(rpcErr(-32603, 'Internal error', { detail: String(e) }));
  }
});

function toolList(){
  return [
    {
      name: 'drive.search',
      description: 'Search Google Drive using DriveApp v2 query (e.g., title contains "X" and trashed = false).',
      inputSchema: { type:'object',
        properties:{ query:{type:'string'}, limit:{type:'integer', minimum:1, maximum:200, default:50 } },
        required:['query'], additionalProperties:false },
      annotations:{ readOnlyHint:true }
    },
    {
      name: 'drive.list',
      description: 'List files in a folder by ID or path.',
      inputSchema: { type:'object',
        properties:{ folderId:{type:'string'}, folderPath:{type:'string'}, limit:{type:'integer', minimum:1, maximum:200, default:50 } },
        additionalProperties:false },
      annotations:{ readOnlyHint:true }
    },
    {
      name: 'drive.get',
      description: 'Get file metadata by id (Advanced Drive v3).',
      inputSchema: { type:'object', properties:{ id:{type:'string'} }, required:['id'] },
      annotations:{ readOnlyHint:true }
    },
    {
      name: 'drive.export',
      description: 'Export Docs→text/plain, Sheets→text/csv; non-Google files return text or base64.',
      inputSchema: { type:'object',
        properties:{ id:{type:'string'}, mime:{type:'string'} }, required:['id'] },
      annotations:{ readOnlyHint:true }
    }
  ];
}

app.listen(PORT, ()=> console.log(`[bridge] listening on http://localhost:${PORT}`));
