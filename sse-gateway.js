// sse-gateway.js  — CommonJS SSE gateway that fronts the core bridge on :5050
const express = require('express');
const cors = require('cors');
const http = require('http');
const fetch = require('node-fetch'); // v2 CommonJS
const app = express();

const PORT = process.env.SSE_PORT || 5051;
const TOKEN = process.env.BRIDGE_TOKEN || 'v3c3NJQ4i94';
const CORE_URL = process.env.CORE_URL || 'http://127.0.0.1:5050/mcp';

// CORS: reflect allowed ChatGPT origins; fall back to 403 if something unexpected
const ALLOWED = new Set([
  'https://chat.openai.com',
  'https://chatgpt.com'
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'content-type,authorization,x-bridge-token,x-custom-auth-headers,accept'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,HEAD,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '1mb' }));

function okToken(req) {
  const q = (req.query && req.query.token) || '';
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return q === TOKEN || bearer === TOKEN;
}

function requireToken(req, res) {
  if (!okToken(req)) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    return false;
  }
  return true;
}

app.head('/mcp', (req, res) => {
  // lightweight health for connector preflight
  if (!okToken(req)) return res.status(401).end();
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).end();
});

// SSE handshake (GET)
app.get('/mcp', (req, res) => {
  if (!requireToken(req, res)) return;

  // Must be SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Initial message as MCP welcome
  const welcome = {
    jsonrpc: '2.0',
    id: '0',
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'YFL Bridge (SSE gateway)', version: 'sse-1.0' }
    }
  };
  res.write(`event: message\n`);
  res.write(`data: ${JSON.stringify(welcome)}\n\n`);

  // Keepalive pings every 25s
  const t = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 25000);
  req.on('close', () => clearInterval(t));
});

// JSON-RPC calls (POST) — forward to core bridge on :5050
app.post('/mcp', async (req, res) => {
  if (!requireToken(req, res)) return;

  // Enforce Accept header to include both JSON and SSE per MCP guidance
  const accept = (req.headers.accept || '').toLowerCase();
  if (!(accept.includes('application/json') && accept.includes('text/event-stream'))) {
    return res
      .status(406)
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Not Acceptable: Client must accept both application/json and text/event-stream' }, id: null });
  }

  try {
    const upstream = await fetch(CORE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'x-forwarded-for': req.ip || '',
        'x-bridge-token': TOKEN
      },
      body: JSON.stringify(req.body)
    });

    const text = await upstream.text();
    res.setHeader('Cache-Control', 'no-store');
    res.status(upstream.status).send(text);
  } catch (err) {
    res
      .status(502)
      .send(JSON.stringify({ jsonrpc: '2.0', error: { code: -32002, message: `Upstream error: ${String(err)}` }, id: null }));
  }
});

app.listen(PORT, () => {
  console.log(`YFL SSE gateway listening on :${PORT} — GET/POST http://localhost:${PORT}/mcp`);
});
