// sse-gateway.js  — YFL MCP SSE gateway (CJS, no frameworks)
// Listens on :5051 and fronts your Express bridge on :5050.
// - GET  /mcp?token=...      -> SSE handshake (text/event-stream)
// - POST /mcp?token=...      -> JSON-RPC pass-through to :5050/mcp
// - OPTIONS/HEAD supported    -> CORS & liveness for Connector UI

const http = require('http');
const { URL } = require('url');
const { request: httpRequest } = require('http');

const PORT = process.env.SSE_PORT ? Number(process.env.SSE_PORT) : 5051;
const BRIDGE_PORT = process.env.BRIDGE_PORT ? Number(process.env.BRIDGE_PORT) : 5050;
const TOKEN = process.env.BRIDGE_TOKEN || 'v3c3NJQ4i94';

// Allowed browser origins for Connector UI
const ALLOW_ORIGINS = new Set([
  'https://chatgpt.com',
  'https://platform.openai.com',       // safety: some flows originate here
]);

function corsHeaders(origin) {
  const allowOrigin = ALLOW_ORIGINS.has(origin) ? origin : 'https://chatgpt.com';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS,HEAD',
    'Access-Control-Allow-Headers': 'content-type,authorization,x-bridge-token,x-custom-auth-headers',
    'Vary': 'Origin',
  };
}

function unauthorized(res, origin) {
  const h = corsHeaders(origin);
  res.writeHead(401, { ...h, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized' }, id: null }));
}

function notAcceptable(res, origin) {
  const h = corsHeaders(origin);
  res.writeHead(406, { ...h, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Not Acceptable: Client must accept both application/json and text/event-stream' },
    id: null
  }));
}

function okJson(res, origin, bodyObj) {
  const h = corsHeaders(origin);
  res.writeHead(200, { ...h, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(bodyObj));
}

function sseHello(res, origin) {
  const h = corsHeaders(origin);
  res.writeHead(200, {
    ...h,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const hello = {
    jsonrpc: '2.0',
    id: '0',
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'YFL Bridge (SSE gateway)', version: 'sse-1.0' }
    }
  };
  res.write(`event: message\ndata: ${JSON.stringify(hello)}\n\n`);
  // keepalive every 10s
  const timer = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 10000);
  res.on('close', () => clearInterval(timer));
}

function passThroughJsonRpc(req, res, origin) {
  // Proxy JSON-RPC POST to the local Express bridge on :5050
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    const opts = {
      hostname: '127.0.0.1',
      port: BRIDGE_PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connection': 'keep-alive'
      }
    };
    const p = httpRequest(opts, (up) => {
      let resp = '';
      up.setEncoding('utf8');
      up.on('data', (c) => (resp += c));
      up.on('end', () => {
        const h = corsHeaders(origin);
        res.writeHead(200, { ...h, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(resp);
      });
    });
    p.on('error', (err) => {
      const h = corsHeaders(origin);
      res.writeHead(502, { ...h, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: `Upstream error: ${err.message}` }, id: null }));
    });
    p.write(body);
    p.end();
  });
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  const u = new URL(req.url, `http://${req.headers.host}`);
  const isMcpPath = u.pathname === '/mcp';
  const token = u.searchParams.get('token') || req.headers['x-bridge-token'];

  // CORS preflight
  if (req.method === 'OPTIONS') {
    const h = corsHeaders(origin);
    res.writeHead(204, h);
    return res.end();
  }

  // HEAD for liveness
  if (req.method === 'HEAD' && isMcpPath) {
    const h = corsHeaders(origin);
    res.writeHead(200, { ...h, 'Content-Type': 'text/plain' });
    return res.end('OK');
  }

  if (!isMcpPath) {
    const h = corsHeaders(origin);
    res.writeHead(404, { ...h, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
  }

  if (!token || token !== TOKEN) return unauthorized(res, origin);

  if (req.method === 'GET') {
    // For GET, require ability to accept SSE (Connector UI does)
    const accept = String(req.headers.accept || '');
    if (!accept.includes('text/event-stream')) return notAcceptable(res, origin);
    return sseHello(res, origin);
  }

  if (req.method === 'POST') {
    // For POST, clients often send Accept: "application/json, text/event-stream"
    const accept = String(req.headers.accept || '');
    if (!accept.includes('application/json')) return notAcceptable(res, origin);
    return passThroughJsonRpc(req, res, origin);
  }

  const h = corsHeaders(origin);
  res.writeHead(405, { ...h, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
});

server.listen(PORT, () => {
  console.log(`YFL SSE gateway listening on :${PORT} — GET/POST http://localhost:${PORT}/mcp`);
});
