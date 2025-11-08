// sse-gateway.js — YFL Bridge SSE front door (no changes to your existing server.js)
// Runs on PORT 5051 by default and proxies JSON-RPC to your existing :5050/mcp.
// Requirements: npm i express cors node-fetch
// Token: accepts ?token=v3c3NJQ4i94 on both GET/POST.
// CORS: allows chat.openai.com and chatgpt.com

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const PORT = process.env.SSE_PORT || 5051;
const DOWNSTREAM = process.env.DOWNSTREAM_URL || "http://localhost:5050/mcp";
const TOKEN = process.env.BRIDGE_TOKEN || "v3c3NJQ4i94";
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS ||
  "https://chat.openai.com,https://chatgpt.com")
  .split(",")
  .map(s => s.trim());

const app = express();
app.disable("x-powered-by");

// CORS (Connector UI runs in the browser; we must allow its origin)
const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const ok = ALLOW_ORIGINS.includes(origin);
    return cb(ok ? null : new Error("CORS"), ok);
  },
  credentials: true,
  allowedHeaders: [
    "content-type",
    "authorization",
    "x-bridge-token",
    "x-custom-auth-headers",
    "mcp-session-id"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  maxAge: 86400
};

app.use((req, res, next) => {
  res.setHeader("Vary", "Origin");
  next();
});

app.options("/mcp", cors(corsOptions));

// Simple health
app.get("/health", (req, res) => {
  res.json({ ok: true, gateway: true, version: "sse-1.0", ts: new Date().toISOString() });
});

// ---- Auth helpers ----
function authFromQuery(req) {
  const t = (req.query.token || "").toString().trim();
  return t && t === TOKEN;
}

// ---- SSE endpoint (what ChatGPT Connector expects) ----
app.get("/mcp", cors(corsOptions), (req, res) => {
  if (!authFromQuery(req)) {
    return res.status(401).json({ error: "Unauthorized (token query required)" });
  }

  // Must return text/event-stream and remain open
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Immediate hello so the UI knows we’re alive
  const hello = {
    jsonrpc: "2.0",
    id: "0",
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "YFL Bridge (SSE gateway)", version: "sse-1.0" }
    }
  };
  res.write(`event: message\n`);
  res.write(`data: ${JSON.stringify(hello)}\n\n`);

  // Heartbeat every 25s (keeps Cloudflare + UI happy)
  const ping = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 25000);

  req.on("close", () => clearInterval(ping));
});

// ---- JSON-RPC passthrough for POST /mcp ----
app.use(express.json({ limit: "1mb" }));

app.post("/mcp", cors(corsOptions), async (req, res) => {
  if (!authFromQuery(req)) {
    return res.status(401).json({ error: "Unauthorized (token query required)" });
  }

  // Connector sends application/json; we forward to your existing server
  try {
    const upstream = await fetch(`${DOWNSTREAM}?token=${encodeURIComponent(TOKEN)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream"
      },
      body: JSON.stringify(req.body)
    });
    res.status(upstream.status);
    // Stream back raw body
    const text = await upstream.text();
    res.send(text);
  } catch (e) {
    res.status(502).json({ jsonrpc: "2.0", error: { code: -32000, message: `Upstream error: ${e.message}` }, id: null });
  }
});

app.listen(PORT, () => {
  console.log(`YFL SSE gateway listening on :${PORT} — GET/POST http://localhost:${PORT}/mcp`);
});
