// server.js — YFL Drive Bridge (Streamable HTTP, MCP 2024-11-05)
import express from 'express';
import cors from 'cors';
import 'dotenv/config';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---------- Config ----------
const PORT       = process.env.PORT || 10000;
const GAS_BASE   = (process.env.GAS_BASE_URL || '').replace(/\/+$/,''); // no trailing slash
const GAS_TOKEN  = process.env.GAS_KEY || process.env.TOKEN || process.env.BRIDGE_TOKEN || '';
const PROTOCOL   = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG      = String(process.env.DEBUG || '0') === '1';

if (!GAS_BASE) console.warn('[WARN] GAS_BASE_URL is not set');
if (!GAS_TOKEN) console.warn('[WARN] GAS token is not set');

// ---------- Helper: fetch from GAS ----------
async function gas(path, params = {}) {
  const url = new URL(GAS_BASE + path);
  url.searchParams.set('token', GAS_TOKEN);
  for (const [k,v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res  = await fetch(url.toString(), { headers: { 'Accept': 'application/json' }});
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  if (!res.ok) throw new Error(`GAS HTTP ${res.status}: ${body.slice(0,200)}`);
  if (!type.includes('application/json')) throw new Error(
    `GAS returned non‑JSON (${res.status} ${type}) — first 200 chars: ${body.slice(0,200)}`
  );
  const j = JSON.parse(body);
  if (j && j.ok === false && j.error) throw new Error(`GAS error: ${j.error}`);
  return j;
}

// ---------- Health ----------
app.get('/health', async (_req, res) => {
  try {
    const j = await gas('/api/health');
    res.json({ ok: true, protocol: PROTOCOL, gas: !!j.ok });
  } catch (e) {
    res.status(424).json({ ok: false, error: String(e?.message || e), gas: false });
  }
});

// ---------- Streamable HTTP MCP endpoint ----------
app.all('/mcp', async (req, res) => {
  // Allow GET to open an SSE discovery stream (optional per spec)
  if (req.method !== 'POST') {
    if ((req.headers.accept || '').includes('text/event-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`event: endpoint\ndata: {"url":"${req.protocol}://${req.get('host')}${req.originalUrl}"}\n\n`);
      const iv = setInterval(() => res.write(':\n\n'), 15000);
      req.on('close', () => clearInterval(iv));
      return;
    }
    return res.status(405).json({ error: 'Use POST for JSON‑RPC' });
  }

  const { id, method, params } = req.body || {};
  const jsonrpc = '2.0';
  const ok  = (result) => res.json({ jsonrpc, id, result });
  const err = (code, message, data) => res.json({ jsonrpc, id, error: { code, message, data } });

  try {
    if (method === 'initialize') {
      return ok({
        protocolVersion: PROTOCOL,
        serverInfo: { name: 'yfl-drive-bridge', version: '3.3.0' },
        capabilities: { tools: {} }
      });
    }

    if (method === 'tools/list' || method === 'mcp/tools') {
      return ok({
        tools: [
          {
            name: 'search',
            description: 'Search Google Drive by filename (contains).',
            inputSchema: {
              type: 'object',
              properties: {
                q:   { type: 'string', description: 'substring to match' },
                max: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
                mode:{ type: 'string', enum: ['name','content','search'], default: 'name' }
              },
              required: ['q']
            }
          },
          {
            name: 'fetch',
            description: 'Fetch file by id; inline text when possible, else JSON metadata.',
            inputSchema: {
              type: 'object',
              properties: {
                id:    { type: 'string' },
                lines: { type: 'integer', minimum: 0, default: 0 }
              },
              required: ['id']
            }
          },
          { name: 'drive_search', description: 'Alias of search', inputSchema: { type: 'object', properties: {} } },
          { name: 'drive_fetch',  description: 'Alias of fetch',  inputSchema: { type: 'object', properties: {} } }
        ]
      });
    }

    if (method === 'tools/call' || method === 'mcp/tools/call') {
      const name = params?.name;
      const args = params?.arguments || params?.args || {};

      const send = (text, isError = false) => ok({ content: [{ type: 'text', text }], isError });

      if (name === 'search' || name === 'drive_search') {
        try {
          const q   = String(args.q ?? '').trim();
          const max = Math.max(1, Math.min(parseInt(args.max ?? '25', 10) || 25, 100));
          const j   = await gas('/api/search', { q, max, mode: 'name' });
          return send(JSON.stringify(j, null, 2));
        } catch (e) {
          return send(`search failed: ${String(e?.message || e)}`, true);
        }
      }

      if (name === 'fetch' || name === 'drive_fetch') {
        try {
          const idv   = String(args.id ?? '').trim();
          const lines = Math.max(0, parseInt(args.lines ?? '0', 10) || 0);
          const j     = await gas('/api/fetch', { id: idv, lines });
          if (j?.data?.inline && typeof j.data.text === 'string') {
            const meta = { id: j.data.id, name: j.data.name, mimeType: j.data.mimeType, sizeBytes: j.data.sizeBytes };
            const header = `# ${meta.name} (${meta.mimeType}, ${meta.sizeBytes} bytes)\n`;
            return send(header + j.data.text);
          }
          return send(JSON.stringify(j, null, 2));
        } catch (e) {
          return send(`fetch failed: ${String(e?.message || e)}`, true);
        }
      }

      return err(-32602, `Unknown tool: ${name}`);
    }

    return err(-32601, 'Method not found');
  } catch (e) {
    return err(-32000, String(e?.message || e), { stack: String(e?.stack || '') });
  }
});

app.listen(PORT, () => {
  console.log(`YFL Drive Bridge listening on :${PORT}`);
  if (DEBUG) console.log({ PORT, GAS_BASE, PROTOCOL });
});
