/**
 * YFL SSE Gateway — v1.3 (CommonJS)
 * Bridges ChatGPT MCP (SSE + JSON-RPC) -> local HTTP JSON bridge at 127.0.0.1:5050/mcp
 * CORS: allows ChatGPT UI origins; responds to OPTIONS/HEAD quickly; robust SSE pings.
 */

const http = require('http');
const url = require('url');
const { URL } = require('url');
const fetch = require('node-fetch'); // v2
const PORT = process.env.SSE_PORT ? Number(process.env.SSE_PORT) : 5051;
const UPSTREAM = process.env.UPSTREAM_URL || 'http://127.0.0.1:5050/mcp';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || 'v3c3NJQ4i94';

// Allow explicit ChatGPT UI origins. Add more if needed.
const ALLOWED_ORIGINS = new Set([
  'https://chat.openai.com',
  'https://chatgpt.com'
]);

function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  return origin && ALLOWED_ORIGINS.has(origin);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    // safest default: no wildcard; ChatGPT requires explicit origin
    res.setHeader('Access-Control-Allow-Origin', 'https://chat.openai.com');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader(
    'Access-Control-Allow-Headers',
    'content-type,authorization,x-bridge-token,accept'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,HEAD');
  // Expose so the UI can read minimal metadata if it wants to
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id,x-bridge-version');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('x-bridge-version', 'sse-1.3');
}

function okJson(res, obj) {
  const text = JSON.stringify(obj);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(text);
}

function unauthorized(res, msg = 'Unauthorized') {
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: msg }, id: null }));
}

function notAcceptable(res, msg = 'Not Acceptable') {
  res.statusCode = 406;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: msg }, id: null }));
}

function extractToken(req, parsed) {
  // Prefer Authorization header; fallback to ?token=
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const t = parsed.searchParams.get('token');
  return t || '';
}

function sseHandshake(res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=120');
  // First event (required so the client knows we’re alive)
  const hello = {
    jsonrpc: '2.0',
    id: '0',
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'YFL Bridge (SSE gateway)', version: 'sse-1.3' }
    }
  };
  res.write(`event: message\n`);
  res.write(`data: ${JSON.stringify(hello)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsed.pathname;

    // CORS for every request
    setCors(req, res);

    // Preflight & HEAD
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }
    if (req.method === 'HEAD') {
      // Return headers that match the SSE GET
      if (pathname === '/mcp') {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      }
      res.statusCode = 200;
      return res.end();
    }

    if (pathname !== '/mcp') {
      res.statusCode = 404;
      return res.end('Not Found');
    }

    // Auth
    const token = extractToken(req, parsed);
    if (token !== BRIDGE_TOKEN) {
      return unauthorized(res, 'Invalid or missing token.');
    }

    if (req.method === 'GET') {
      // SSE stream
      // Must accept text/event-stream; browsers will send it automatically via EventSource
      const accept = String(req.headers['accept'] || '');
      if (!accept.includes('text/event-stream')) {
        return notAcceptable(res, 'Client must accept text/event-stream');
      }
      sseHandshake(res);

      // Heartbeat
      const timer = setInterval(() => {
        const ts = Date.now();
        res.write(`: ping ${ts}\n\n`);
      }, 15000);

      // If the client disconnects, stop
      req.on('close', () => clearInterval(timer));
      return;
    }

    if (req.method === 'POST') {
      // JSON-RPC call to local HTTP bridge
      // Normalize Accept for upstream (your JSON bridge)
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');

      const upstreamRes = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Normalize so your upstream never 406s on Accept weirdness
          'Accept': 'application/json'
        },
        body
      });

      const text = await upstreamRes.text();
      res.statusCode = upstreamRes.status;
      res.setHeader('Content-Type', 'application/json');
      return res.end(text);
    }

    // Anything else
    res.statusCode = 405;
    res.end('Method Not Allowed');
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32099, message: String(err) }, id: null }));
  }
});

server.listen(PORT, () => {
  console.log(`YFL SSE gateway listening on :${PORT} — GET/POST http://localhost:${PORT}/mcp`);
});
