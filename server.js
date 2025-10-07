// Minimal MCP bridge that ChatGPT can stream to, then we proxy to Apps Script.
// Uses the official MCP SDK's Streamable HTTP transport.
// Docs: OpenAI Apps SDK (Set up your server) + MCP transports. 
// (Search 'Streamable HTTP transport' in those docs.)
import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = process.env.PORT || 3000;
const GAS_BASE = process.env.GAS_BASE;     // e.g., https://script.google.com/macros/s/.../exec
const TOKEN   = process.env.TOKEN;         // e.g., tk_yfl_eRkn8sGMTi7hGzo1xs0m

if (!GAS_BASE) throw new Error('Missing GAS_BASE env var');
if (!TOKEN)   throw new Error('Missing TOKEN env var');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/echo', (req, res) => {
  res.json({ ok: true, message: 'Node MCP bridge is up', gasBaseConfigured: !!GAS_BASE });
});

// ----- MCP server & tools -----
const server = new McpServer({
  name:    'YFL GAS Bridge',
  version: '0.1.0'
});

// Tool #1: quick Drive search (proxied to Apps Script /api/search)
server.registerTool(
  {
    name: 'drive_search',
    description: 'Search Drive by name/path substring under the YFL workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        q:   { type: 'string', description: 'substring to match in name or parent path' },
        max: { type: 'number', description: 'max items (default 10)' }
      },
      required: ['q']
    }
  },
  async (args) => {
    const url = new URL('/api/search', GAS_BASE);
    url.searchParams.set('q', String(args.q || ''));
    if (args.max) url.searchParams.set('max', String(args.max));
    url.searchParams.set('token', TOKEN);

    const r = await fetch(url, { method: 'GET' });
    const j = await r.json();
    return { content: [{ type: 'text', text: JSON.stringify(j) }] };
  }
);

// Tool #2: fetch file text (proxied to Apps Script /api/fetch?id=...)
server.registerTool(
  {
    name: 'drive_fetch',
    description: 'Read text/CSV/Docs/Sheets cell text from a Drive file id (text only; trims large).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Drive file id' } },
      required: ['id']
    }
  },
  async (args) => {
    const url = new URL('/api/fetch', GAS_BASE);
    url.searchParams.set('id', String(args.id || ''));
    url.searchParams.set('token', TOKEN);

    const r = await fetch(url, { method: 'GET' });
    const j = await r.json();
    return { content: [{ type: 'text', text: JSON.stringify(j) }] };
  }
);

// MCP endpoint (streamable HTTP)
app.all('/mcp', async (req, res) => {
  // Optional: verify ChatGPT is using the same shared token
  const t = req.query.token;
  if (String(t) !== TOKEN) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const transport = new StreamableHTTPServerTransport({ req, res });
  await server.connect(transport);
});

app.listen(PORT, () => console.log(`MCP bridge listening on :${PORT}`));
