// server.mjs  — YFL Drive Bridge (Streamable HTTP MCP)
// ESM only. Requires Node 18+ (global fetch). Run: `node server.mjs`

import express from "express";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.TOKEN || "";
const BRIDGE_VERSION = process.env.BRIDGE_VERSION || "3.1.1n";
const GAS_BASE_URL = process.env.GAS_BASE_URL || process.env.GAS_BASE || "";
const SHARED_KEY = process.env.SHARED_KEY || "";

// Cloudflare/Proxy awareness & JSON bodies
app.set("trust proxy", true); // respect CF headers (IP, proto, etc.) — Express best practice
app.use(express.json({ limit: "1mb" })); // JSON-RPC bodies

// --- helpers -------------------------------------------------------------
const nowIso = () => new Date().toISOString();

function ok(res, payload) {
  res.type("application/json").send(payload);
}

function authOK(req) {
  // token via header or query
  const token = req.get("x-bridge-token") || req.query.token;
  return !BRIDGE_TOKEN || token === BRIDGE_TOKEN;
}

function deny(res) {
  res.status(401).json({ ok: false, error: "missing/invalid token" });
}

// JSON-RPC envelopes (per 2.0 spec)
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

async function gasCall(name, args = {}) {
  if (!GAS_BASE_URL) throw new Error("GAS_BASE_URL not configured");
  const u = new URL(GAS_BASE_URL);
  // Contract: GAS doGet(e) reads tool & args from query and returns JSON via ContentService
  // One redirect to script.googleusercontent.com is normal for web apps.
  u.searchParams.set("tool", name);
  u.searchParams.set("args", JSON.stringify(args));
  if (SHARED_KEY) u.searchParams.set("key", SHARED_KEY);

  const r = await fetch(u, { method: "GET", headers: { accept: "application/json" } });
  const text = await r.text();
  // GAS sometimes returns JSON-string text; try parse then fallback
  try { return JSON.parse(text); } catch { return text; }
}

async function gasHealthy() {
  if (!GAS_BASE_URL) return false;
  try {
    const u = new URL(GAS_BASE_URL);
    u.searchParams.set("echo", "1");
    if (SHARED_KEY) u.searchParams.set("key", SHARED_KEY);
    const r = await fetch(u, { method: "GET" });
    return r.ok;
  } catch {
    return false;
  }
}

// --- routes --------------------------------------------------------------
// Health: include minimal GAS ping if configured
app.get("/health", async (req, res) => {
  const gas = await gasHealthy();
  res.json({ ok: true, gas, version: BRIDGE_VERSION, ts: nowIso() });
});

// MCP transport discovery
app.head("/mcp", (req, res) => {
  if (!authOK(req)) return deny(res);
  // 204 No Content for HEAD probe (handy for Inspector)
  res.sendStatus(204);
});

app.get("/mcp", (req, res) => {
  if (!authOK(req)) return deny(res);
  res.json({ ok: true, transport: "streamable-http" });
});

// JSON-RPC 2.0 endpoint
app.post("/mcp", async (req, res) => {
  if (!authOK(req)) return deny(res);

  const { id = null, method, params = {} } = req.body || {};
  if (!method) return ok(res, rpcError(id, -32600, "Invalid Request: missing method"));

  try {
    // initialize
    if (method === "initialize") {
      return ok(res, rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "YFL Drive Bridge", version: BRIDGE_VERSION }
      }));
    }

    // tools/list
    if (method === "tools/list") {
      const tools = [
        { name: "drive.list",   description: "List files by folder path/ID",                     annotations: { readOnlyHint: true } },
        { name: "drive.search", description: "Drive v2 query (title contains..., trashed=false)", annotations: { readOnlyHint: true } },
        { name: "drive.get",    description: "Get metadata by file id",                          annotations: { readOnlyHint: true } },
        { name: "drive.export", description: "Export Google Docs/Sheets/Slides or text",         annotations: { readOnlyHint: true } }
      ];
      return ok(res, rpcResult(id, { tools }));
    }

    // tools/call
    if (method === "tools/call") {
      const { name, arguments: args = {} } = params || {};
      if (!name) return ok(res, rpcError(id, -32602, "Missing tool name"));
      const out = await gasCall(name, args);
      // MCP content: simple text result for Inspector preview
      const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      return ok(res, rpcResult(id, { content: [{ type: "text", text }] }));
    }

    // anything else is unsupported
    return ok(res, rpcError(id, -32601, `Method not found: ${method}`));
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const data = e && e.stack ? { stack: String(e.stack).split("\n").slice(0, 3).join("\n") } : undefined;
    return ok(res, rpcError(id, -32000, msg, data));
  }
});

app.listen(PORT, () => {
  console.log(`YFL Drive Bridge listening on ${PORT}`);
});
