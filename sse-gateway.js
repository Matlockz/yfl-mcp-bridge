// sse-gateway.js  — YFL Bridge SSE + JSON-RPC gateway (hardened)
// Runs on :5051 and fronts the local MCP server on :5050.
//
// Requirements:
//   node >= 18 (uses global fetch), no extra deps
// How auth works here:
//   - Accepts either ?token=... or Authorization: Bearer ...
//   - Your token is FIXED to the value Matlock provided: v3c3NJQ4i94

import http from 'node:http';
import { parse as parseUrl } from 'node:url';

const PORT = Number(process.env.SSE_PORT || 5051);
const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:5050/mcp';

// **Matlock’s exact token (no placeholders)**
const TOKEN = process.env.BRIDGE_TOKEN || 'v3c3NJQ4i94';

// Allowed web origins for the Connector UI
const ALLOW_ORIGINS = new Set([
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://platform.openai.com',
  'https://labs.openai.com'
]);

function getOrigin(req) {
  // Connector UI uses chatgpt.com; Deep Research may vary in the future.
  const o = req.headers.origin;
  return (o && ALLOW_ORIGINS.has(o)) ? o : 'https://chatgpt.com';
}

function setCORS(req, res) {
  const origin = getOrigin(req);
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'content-type, authorization, x-bridge-token, x-custom-auth-headers'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,HEAD,OPTIONS');
  // For MCP Connectors, we don’t cache
  res.setHeader('Cache-Control', 'no-store');
}

function okAuth(req, url) {
  // Support both query param and Authorization header
  const qp = new URLSearchParams(url.search || '');
  const qt = qp.get('token');
  const ah = req.headers.authorization || '';
  const bearer = ah.startsWith('Bearer ') ? ah.slice(7) : null;
  return qt === TOKEN || bearer === TOKEN;
}

function initialSSEChunk() {
  // MCP wants an initial message with protocol + serverInfo; then keep pings.
  const payload = {
    jsonrpc: '2.0',
    id: '0',
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'YFL Bridge (SSE gateway)', version: 'sse-1.1' }
    }
  };
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = parseUrl(req.url, true);

    // HEAD and OPTIONS should succeed quickly for Connector preflight
    if (req.method === 'HEAD' && url.pathname === '/mcp') {
      setCORS(req, res);
      res.statusCode = 200;
      return res.end();
    }
    if (req.method === 'OPTIONS' && url.pathname === '/mcp') {
      setCORS(req, res);
      res.statusCode = 204;
      return res.end();
    }

    if (url.pathname !== '/mcp') {
      setCORS(req, res);
      res.statusCode = 404;
      return res.end('Not Found');
    }

    // Auth
    if (!okAuth(req, url)) {
      setCORS(req, res);
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    // GET => SSE stream (we serve it here)
    if (req.method === 'GET') {
      setCORS(req, res);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // help proxies avoid buffering
      res.setHeader('Cache-Control', 'no-store');

      res.write(initialSSEChunk());

      // keepalive pings every 25s
      const interval = setInterval(() => {
        res.write(`: ping ${Date.now()}\n\n`);
      }, 25000);

      req.on('close', () => clearInterval(interval));
      return; // keep connection open
    }

    // POST => proxy JSON-RPC to upstream MCP server (:5050)
    if (req.method === 'POST') {
      setCORS(req, res);

      // Read body
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        try {
          const r = await fetch(UPSTREAM, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              // Be lenient: accept JSON; Connector UI sometimes sends its own Accept.
              'Accept': 'application/json'
            },
            body
          });

          // bubble through status and JSON as text
          const text = await r.text();
          res.statusCode = r.status || 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('x-bridge-version', 'sse-1.1');
          return res.end(text);
        } catch (err) {
          res.statusCode = 502;
          return res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: `Upstream error: ${String(err)}` },
            id: null
          }));
        }
      });
      return;
    }

    // Anything else
    setCORS(req, res);
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  } catch (err) {
    res.statusCode = 500;
    return res.end(String(err));
  }
});

server.listen(PORT, () => {
  console.log(`YFL SSE gateway listening on :${PORT} — GET/POST http://localhost:${PORT}/mcp`);
});
