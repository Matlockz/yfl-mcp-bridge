// sse-gateway.js — YFL Bridge SSE/HTTP front door (CommonJS)
const http = require('http');
const { URL } = require('url');

// Config
const PORT = Number(process.env.SSE_PORT || 5051);
const UPSTREAM = process.env.UPSTREAM_URL || 'http://127.0.0.1:5050/mcp';
// You asked for the exact token to be embedded:
const TOKEN = (process.env.BRIDGE_TOKEN || 'v3c3NJQ4i94').trim();
// Allow ChatGPT UI + platform
const ALLOW = (process.env.CORS_ALLOW_ORIGINS ||
  'https://chatgpt.com,https://chat.openai.com,https://platform.openai.com,*'
).split(',').map(s => s.trim());

function allowOrigin(origin) {
  if (!origin) return '*';
  if (ALLOW.includes('*')) return '*';
  return ALLOW.includes(origin) ? origin : '';
}

function sendSseHello(res) {
  const hello = {
    jsonrpc: '2.0',
    id: '0',
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'YFL Bridge (SSE gateway)', version: 'sse-1.0' }
    }
  };
  res.write(`event: message\n`);
  res.write(`data: ${JSON.stringify(hello)}\n\n`);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin || '';
    const allow = allowOrigin(origin);
    if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,HEAD,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept,X-Bridge-Token');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.end();
  }

  // HEAD /mcp — fast health (no auth; connectors often HEAD first)
  if (req.method === 'HEAD' && u.pathname === '/mcp') {
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }

  // Auth — query ?token= or Authorization: Bearer
  const qpToken = u.searchParams.get('token');
  const hdr = (req.headers['x-bridge-token'] || req.headers['authorization'] || '').trim();
  const hdrToken = hdr.startsWith('Bearer ') ? hdr.slice(7) : (hdr || '');
  const token = qpToken || hdrToken;
  if (TOKEN && token !== TOKEN) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
  }

  // GET /mcp — keep an SSE stream open (hello + pings), even if upstream restarts
  if (req.method === 'GET' && u.pathname === '/mcp') {
    const origin = req.headers.origin || '';
    const allow = allowOrigin(origin);
    if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    sendSseHello(res);
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 25000);
    req.on('close', () => clearInterval(ping));
    return;
  }

  // POST /mcp — proxy JSON-RPC to upstream (server.js @ 5050)
  if (req.method === 'POST' && u.pathname === '/mcp') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const up = new URL(UPSTREAM);
      const upReq = http.request(
        {
          hostname: up.hostname,
          port: up.port,
          path: up.pathname + up.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Forward Accept as-is; if client only sends JSON, that’s fine.
            'Accept': req.headers.accept || 'application/json',
            'Connection': 'keep-alive'
          }
        },
        upRes => {
          const origin = req.headers.origin || '';
          const allow = allowOrigin(origin);
          if (allow) upRes.headers['access-control-allow-origin'] = allow;
          upRes.headers['cache-control'] = 'no-store';
          res.writeHead(upRes.statusCode || 200, upRes.headers);
          upRes.pipe(res);
        }
      );

      upReq.on('error', err => {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32098, message: `Upstream error: ${err.message}` },
          id: null
        }));
      });

      upReq.write(body || '');
      upReq.end();
    });
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`YFL SSE gateway listening on :${PORT} — GET/POST http://localhost:${PORT}/mcp`);
});
