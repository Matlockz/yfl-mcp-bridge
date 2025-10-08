// server.js — YFL MCP Bridge (stateless)
// Express HTTP endpoint `/mcp` that ChatGPT can call via api_tool.
// Tools: drive_search, drive_fetch. No interactive prompts, ever.

import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const GAS_BASE = process.env.GAS_BASE;                // e.g., https://script.google.com/macros/s/.../exec
const TK = process.env.GDRIVE_TEXT_TOKEN;             // must match Apps Script TOKEN
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';  // optional: used only for your own bookkeeping

if (!GAS_BASE || !TK) {
  console.error('Missing GAS_BASE or GDRIVE_TEXT_TOKEN env vars.');
  process.exit(1);
}

// Simple health
app.get('/', (_, res) => res.json({ ok: true, name: 'yfl-mcp-bridge', ts: Date.now() }));

// 1) List tools (non-interactive)
app.post('/mcp', async (req, res) => {
  try {
    const body = req.body || {};
    const { op, name, args } = body;

    // Handshake: list available operations
    if (!op || op === 'list') {
      return res.json({
        ok: true,
        name: 'YFL MCP Bridge',
        interactive: false,
        tools: [
          {
            name: 'drive_search',
            interactive: false,
            args_schema: { type: 'object', properties: { q: { type: 'string' }, max: { type: 'number' } }, required: ['q'] }
          },
          {
            name: 'drive_fetch',
            interactive: false,
            args_schema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number' } }, required: ['id'] }
          }
        ]
      });
    }

    // 2) Call tool
    if (op === 'call' && name === 'drive_search') {
      const q = (args?.q || '').trim();
      const max = Number(args?.max || 10);
      const url = `${GAS_BASE}/drive_search?q=${encodeURIComponent(q)}&max=${max}&tk=${encodeURIComponent(TK)}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.json({ ok: true, result: data });
    }

    if (op === 'call' && name === 'drive_fetch') {
      const id = (args?.id || '').trim();
      const lines = Number(args?.lines || 0);
      const url = `${GAS_BASE}/drive_fetch?id=${encodeURIComponent(id)}${lines ? `&lines=${lines}` : ''}&tk=${encodeURIComponent(TK)}`;
      const r = await fetch(url);
      const data = await r.json();
      return res.json({ ok: true, result: data });
    }

    return res.status(400).json({ ok: false, error: 'unknown_op_or_tool', body });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`YFL MCP Bridge listening on :${PORT} (POST /mcp)`);
});
