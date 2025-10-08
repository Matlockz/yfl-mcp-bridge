// YFL MCP Bridge — Streamable HTTP transport (Render)
// - POST /mcp  -> MCP JSON-RPC (initialize/tools.list/tools.call)
// - GET  /echo -> health
//
// Proxies tools to your Apps Script worker:
//   GET {GAS_BASE}/api/search?q=...&max=...&token=TOKEN
//   GET {GAS_BASE}/api/fetch?id=...&token=TOKEN
//
// Based on the official SDK quick-start pattern:
// https://github.com/modelcontextprotocol/typescript-sdk (Quickstart).
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ---- env ----
const GAS_BASE      = (process.env.GAS_BASE || '').replace(/\/$/, '');  // e.g. https://script.google.com/.../exec
const TOKEN         = process.env.TOKEN || '';                          // CFG.TOKEN from Apps Script
const BRIDGE_TOKEN  = process.env.BRIDGE_TOKEN || '';                   // optional extra gate for /mcp

if (!GAS_BASE || !TOKEN) {
  console.error('Missing env vars: GAS_BASE or TOKEN'); process.exit(1);
}

// Helper to build Apps Script URLs
function gasUrl(path, params = {}) {
  const u = new URL(GAS_BASE + (path.startsWith('/') ? path : '/' + path));
  u.searchParams.set('token', TOKEN);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

// ---- MCP server & tools ----
const server = new McpServer({ name: 'YFL GAS Bridge', version: '0.2.0' });

server.registerTool(
  'drive_search',
  {
    title: 'Drive search',
    description: 'Search Google Drive by filename (contains).',
    inputSchema: { q: z.string(), max: z.number().int().min(1).max(50).optional() },
    outputSchema: z.any()
  },
  async ({ q, max }) => {
    const r = await fetch(gasUrl('/api/search', { q, max: max ?? 10 }));
    const data = await r.json();
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  }
);

server.registerTool(
  'drive_fetch',
  {
    title: 'Drive fetch',
    description: 'Fetch text content for a Drive file ID (TXT/CSV/Docs/Sheets; truncated).',
    inputSchema: { id: z.string() },
    outputSchema: z.any()
  },
  async ({ id }) => {
    const r = await fetch(gasUrl('/api/fetch', { id }));
    const data = await r.json();
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  }
);

// ---- health
app.get('/echo', (_req, res) => {
  res.json({ ok: true, message: 'YFL MCP Bridge up', gasBase: GAS_BASE });
});

// ---- MCP endpoint (Streamable HTTP; stateless session per official docs)
app.post('/mcp', async (req, res) => {
  // Optional: small gate so randoms can’t hit /mcp unless they know a token
  if (BRIDGE_TOKEN) {
    const q = String(req.query.token || '');
    if (q !== BRIDGE_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,  // new session per request (stateless)
    enableJsonResponse: true
  });
  res.on('close', () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ---- start
const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => console.log(`YFL MCP Bridge listening on :${port} (POST /mcp)`));
