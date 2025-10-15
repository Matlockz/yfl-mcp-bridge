// server.js — YFL Drive Bridge (Node 18+ / ESM)
// Same as server.mjs so Render/GitHub use .js with "type":"module"

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT         = process.env.PORT || 10000;
const TOKEN        = process.env.TOKEN || process.env.BRIDGE_TOKEN || '';
const GAS_BASE_URL = (process.env.GAS_BASE_URL || '').replace(/\/+$/, '');
const GAS_KEY      = process.env.GAS_KEY || '';
const MCP_PROTOCOL = process.env.MCP_PROTOCOL || '2024-11-05';
const DEBUG        = String(process.env.DEBUG || '0') === '1';

function requireToken(req, res, next) {
  const t = (req.query.token || req.get('X-Bridge-Token') || '').trim();
  if (!TOKEN || t !== TOKEN) return res.status(401).json({ ok: false, error: 'bad token' });
  next();
}

function gasURL(kind, value, extra = {}) {
  const u = new URL(GAS_BASE_URL);
  u.searchParams.set(kind, value);
  u.searchParams.set('token', process.env.GAS_KEY || '');
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function fetchJSON(url) {
  const r = await fetch(url, { redirect: 'follow' });
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    if (DEBUG) console.error('[GAS non-JSON]', r.status, ct, text.slice(0, 200));
    throw new Error(`GAS returned non-JSON (${r.status} ${ct || 'no-ct'}) — first 200 chars: ${text.slice(0,200)}`);
  }
}

app.get('/health', async (_req, res) => {
  try {
    if (!GAS_BASE_URL || !GAS_KEY) throw new Error('GAS_BASE_URL or GAS_KEY missing');
    const out = await fetchJSON(gasURL('path', '/api/health'));
    return res.json({ ok: true, protocol: MCP_PROTOCOL, gas: !!(out && out.ok), ts: out.ts || null });
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(424).json({ ok: false, gas: false, error: String(e && e.message || e) });
  }
});

app.get('/tools/list', requireToken, async (_req, res) => {
  try {
    const out = await fetchJSON(gasURL('action', 'tools/list'));
    return res.json(out);
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(502).json({ ok: false, error: String(e && e.message || e) });
  }
});

app.post('/tools/call', requireToken, async (req, res) => {
  try {
    const { name, arguments: args = {} } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
    const out = await fetchJSON(gasURL('action', 'tools/call', { name, ...args }));
    return res.json(out);
  } catch (e) {
    if (DEBUG) console.error(e);
    return res.status(502).json({ ok: false, error: String(e && e.message || e) });
  }
});

app.post('/mcp', requireToken, async (req, res) => {
  const send = (id, resultOrError) => {
    if (resultOrError && resultOrError.error) {
      return res.json({ jsonrpc: '2.0', id, error: resultOrError.error });
    }
    return res.json({ jsonrpc: '2.0', id, result: resultOrError });
  };

  try {
    const { id, method, params = {} } = req.body || {};

    if (method === 'initialize') {
      return send(id, {
        protocolVersion: MCP_PROTOCOL,
        serverInfo: { name: 'yfl-drive-bridge', version: '3.5.0' },
        capabilities: { tools: { listChanged: true } }
      });
    }

    if (method === 'tools/list') {
      return send(id, {
        tools: [
          {
            name: 'drive.search',
            description: 'Search files with DriveApp (v2 query syntax).',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string' },
                limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 }
              },
              required: ['query']
            }
          },
          {
            name: 'drive.list',
            description: 'List files in a folder by path or folderId.',
            inputSchema: {
              type: 'object',
              properties: {
                folderPath: { type: 'string' },
                folderId: { type: 'string' },
                limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
              }
            }
          },
          {
            name: 'drive.get',
            description: 'Get file metadata by id (Drive v3).',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id']
            }
          }
        ]
      });
    }

    if (method === 'tools/call') {
      const { name, arguments: args = {} } = params;
      if (!name) return send(id, { error: { code: -32602, message: 'name is required' } });
      try {
        const out = await fetchJSON(gasURL('action', 'tools/call', { name, ...args }));
        return send(id, { content: [{ type: 'json', json: out }], isError: false });
      } catch (e) {
        return send(id, { content: [{ type: 'text', text: String(e && e.message || e) }], isError: true });
      }
    }

    return send(id, { error: { code: -32601, message: `unknown method: ${method}` } });
  } catch (e) {
    return res.json({
      jsonrpc: '2.0',
      id: (req.body && req.body.id) || null,
      result: { content: [{ type: 'text', text: String(e && e.message || e) }], isError: true }
    });
  }
});

app.get('/', (_req, res) => res.send('YFL MCP Drive Bridge is running.'));
app.listen(PORT, () => console.log(`YFL MCP Bridge listening on :${PORT}`));
