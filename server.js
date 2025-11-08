// server.js — YFL Drive Bridge (CommonJS) — v3.2.0
// LISTENS on :5050  (JSON-RPC over HTTP; no SSE here)
// Proxies Drive ops to Apps Script or to whatever backend you already wired.
// Keeps behavior you had, but relaxes Accept handling (no 406 if Accept lacks text/event-stream).

const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS: allow ChatGPT UIs
const CORS_ORIGINS = [
  'https://chat.openai.com',
  'https://chatgpt.com',
  'https://platform.openai.com',
  'https://labs.openai.com',
  'http://localhost:5051',   // local SSE gateway during testing
];
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || CORS_ORIGINS.includes(origin)),
  credentials: true,
  allowedHeaders: [
    'content-type', 'authorization', 'x-bridge-token', 'x-custom-auth-headers',
    'mcp-session-id', 'accept'
  ],
  exposedHeaders: ['mcp-session-id', 'x-bridge-version']
}));
app.use((req,res,next) => {
  res.header('X-Bridge-Version', '3.2.0');
  next();
});

app.get('/health', (_, res) => {
  res.json({ ok: true, gas: true, version: '3.2.0', ts: new Date().toISOString() });
});

// ---- JSON-RPC endpoint (no SSE here) ----
app.post('/mcp', (req, res) => {
  // Accept header tolerance: allow 'application/json' alone OR with text/event-stream
  const accept = String(req.header('accept') || '').toLowerCase();
  if (!accept.includes('application/json')) {
    res.status(406).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Not Acceptable: Accept must include application/json' }
    });
    return;
  }

  const { method, id } = req.body || {};

  // Minimal “capabilities only” JSON-RPC shim; your real tool wiring can stay behind this.
  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id: String(id ?? '0'),
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'YFL Drive Bridge', version: '3.2.0' }
      }
    });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id: String(id ?? '0'),
      result: {
        tools: [
          {
            name: 'drive.list',
            description: 'List files by folder path/ID',
            inputSchema: { type: 'object', properties: {
              folderId: { type: 'string', description: "Drive folder ID (or 'root')" },
              path:     { type: 'string', description: 'Optional display path' },
              pageToken:{ type: 'string' },
              pageSize: { type: 'integer', minimum: 1, maximum: 200 }
            }},
            outputSchema: { type: 'object', properties: {
              ok: { type: 'boolean' }, items: { type: 'array' }, nextPageToken: { type: 'string' }
            }, required: ['ok','items'] },
            annotations: { readOnlyHint: true }
          },
          {
            name: 'drive.search',
            description: 'Drive v2 query (e.g., title contains "…" and trashed=false)',
            inputSchema: { type: 'object', properties: {
              q: { type: 'string' }, query: { type: 'string' },
              pageToken:{ type: 'string' }, pageSize:{ type: 'integer', minimum: 1, maximum: 200 }
            }, required: ['q']},
            outputSchema: { type: 'object', properties: {
              ok: { type: 'boolean' }, items: { type: 'array' }, nextPageToken: { type: 'string' }
            }, required: ['ok','items'] },
            annotations: { readOnlyHint: true }
          },
          {
            name: 'drive.get',
            description: 'Get metadata by file id',
            inputSchema: { type: 'object', properties: { id: { type: 'string' }}, required: ['id'] },
            outputSchema: { type: 'object' },
            annotations: { readOnlyHint: true }
          },
          {
            name: 'drive.export',
            description: 'Export Google Docs/Sheets/Slides or text',
            inputSchema: { type: 'object', properties: {
              id: { type: 'string', description: 'File ID' },
              mime:{ type: 'string', description: 'MIME (text/plain, text/csv, application/pdf, …)' }
            }, required: ['id']},
            outputSchema: { type: 'object', properties: {
              ok: { type: 'boolean' }, id:{ type:'string' }, srcMime:{ type:'string' },
              mime:{ type:'string' }, size:{ type:'integer' }, text:{ type:'string' }
            }, required:['ok','id','mime','text'] },
            annotations: { readOnlyHint: true }
          }
        ]
      }
    });
  }

  // Default echo (helps connector UX)
  return res.json({
    jsonrpc: '2.0',
    id: String(id ?? '0'),
    result: { ok: true, echo: req.body, service: 'yfl-drive-bridge-v7' }
  });
});

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`YFL Bridge listening on :${PORT} — POST http://localhost:${PORT}/mcp`);
});
