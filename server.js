// server.js — YFL MCP Bridge (Render)
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = process.env.PORT || 3000;
const GAS_BASE = process.env.GAS_BASE;   // e.g., https://script.google.com/macros/s/.../exec
const TOKEN   = process.env.TOKEN;       // your CFG.TOKEN from Apps Script

if (!GAS_BASE || !TOKEN) {
  console.error('Missing GAS_BASE or TOKEN');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Health
app.get('/echo', (_req, res) => res.json({ ok: true, message: 'Node MCP bridge is up', gasBase: GAS_BASE }));

// --- MCP server with two tools that proxy to Apps Script ---
const server = new McpServer({ name: 'YFL GAS Bridge', version: '0.2.0' });

// Tool: Drive search (title contains q)
server.tool(
  'drive_search',
  {
    schema: {
      type: 'object',
      properties: { q: { type: 'string' }, max: { type: 'number' } },
      required: ['q']
    }
  },
  async ({ q, max = 10 }) => {
    const u = new URL('/api/search', GAS_BASE);
    u.searchParams.set('q', q);
    u.searchParams.set('max', String(max));
    u.searchParams.set('token', TOKEN);
    const r = await fetch(u);
    const j = await r.json();
    return { content: [{ type: 'text', text: JSON.stringify(j) }] };
  }
);

// Tool: Drive fetch (text where possible)
server.tool(
  'drive_fetch',
  {
    schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  },
  async ({ id }) => {
    const u = new URL('/api/fetch', GAS_BASE);
    u.searchParams.set('id', id);
    u.searchParams.set('token', TOKEN);
    const r = await fetch(u);
    const j = await r.json();
    return { content: [{ type: 'text', text: JSON.stringify(j) }] };
  }
);

// Streamable HTTP endpoint (what ChatGPT expects)
app.all('/mcp', async (req, res) => {
  // Optional: require the same token in the connector URL for symmetry
  if (req.method === 'POST') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const t = url.searchParams.get('token');
    if (t && t !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  }
  const transport = new StreamableHTTPServerTransport({ req, res });
  await server.connect(transport);
});

app.listen(PORT, () => console.log(`MCP bridge listening on :${PORT}`));
