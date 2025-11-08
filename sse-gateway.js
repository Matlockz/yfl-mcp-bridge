// sse-gateway.js — v1.1.0 (ESM)
// LISTENS on :5051 and fronts the Bridge as an SSE endpoint for ChatGPT connectors.
// GET /mcp (SSE) + POST /mcp (JSON). Accepts token via ?token= or Authorization: Bearer …
// Add `"type": "module"` in package.json to silence the Node ESM warning.

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:5050/mcp';
const EXPECTED_TOKEN = process.env.BRIDGE_TOKEN || ''; // optional (we also accept ?token=)

const app = express();
app.use(express.json({ limit: '2mb' }));

const CORS_ORIGINS = [
  'https://chat.openai.com',
  'https://chatgpt.com',
  'https://platform.openai.com',
  'http://localhost:5050'
];
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || CORS_ORIGINS.includes(origin)),
  credentials: true,
  allowedHeaders: [
    'content-type','authorization','x-bridge-token','x-custom-auth-headers',
    'mcp-session-id','accept'
  ],
  exposedHeaders: ['Mcp-Session-Id','x-bridge-version'],
}));

app.get('/health', (req, res) => {
  res.json({ ok: true, version: 'sse-1.1.0', ts: new Date().toISOString() });
});

function getToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  if (req.query.token) return String(req.query.token);
  return '';
}

function checkToken(req, res) {
  const t = getToken(req);
  if (EXPECTED_TOKEN && t !== EXPECTED_TOKEN) {
    res.status(401).json({ jsonrpc:'2.0', id:null, error:{ code:-32001, message:'Unauthorized' }});
    return false;
  }
  return true;
}

// --- GET /mcp — Server-Sent Events handshake ---
app.get('/mcp', async (req, res) => {
  if (!checkToken(req, res)) return;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id,x-bridge-version',
  });
  res.flushHeaders();

  // Initial ready event
  const initial = {
    jsonrpc: '2.0',
    id: '0',
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'YFL Bridge (SSE gateway)', version: 'sse-1.1.0' }
    }
  };
  res.write(`event: message\n`);
  res.write(`data: ${JSON.stringify(initial)}\n\n`);

  // Keepalive pings
  const timer = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 25000);
  req.on('close', () => clearInterval(timer));
});

// --- POST /mcp — JSON-RPC passthrough to Bridge ---
app.post('/mcp', async (req, res) => {
  if (!checkToken(req, res)) return;

  // If client only sends Accept: application/json, that’s fine.
  // If it includes text/event-stream too, also fine.
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  const r = await fetch(BRIDGE_URL, { method:'POST', headers, body: JSON.stringify(req.body) });
  const text = await r.text();
  res.status(r.status).set({
    'Content-Type': 'application/json',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id,x-bridge-version',
  }).send(text);
});

// Preflight
app.options('/mcp', (req, res) => res.sendStatus(204));

const PORT = process.env.PORT || 5051;
app.listen(PORT, () => {
  console.log(`YFL SSE gateway listening on :${PORT} — GET/POST http://localhost:${PORT}/mcp`);
});
