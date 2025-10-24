// server.mjs — YFL Drive Bridge (Streamable HTTP MCP)
// Node 18+ (global fetch). Run: `node server.mjs`
// CORS aware; JSON-RPC 2.0; returns structured object content for tools.
import 'dotenv/config';

import express from "express";

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || process.env.TOKEN || "";
const BRIDGE_VERSION = process.env.BRIDGE_VERSION || "3.1.1n";
const GAS_BASE_URL = process.env.GAS_BASE_URL || process.env.GAS_BASE || "";
const SHARED_KEY = process.env.SHARED_KEY || process.env.GAS_KEY || "";
const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// --- Express setup -----------------------------------------------------------
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

// CORS (for Inspector Direct). We only echo an origin we recognize.
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOW_ORIGINS.some(prefix => {
    if (prefix.endsWith("*")) return origin.startsWith(prefix.slice(0, -1));
    if (prefix.startsWith("*.")) {
      try {
        const host = new URL(origin).hostname;
        return host.endsWith(prefix.slice(1));
      } catch { return false; }
    }
    return origin === prefix;
  })) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Headers", "content-type, x-bridge-token");
    res.set("Access-Control-Allow-Methods", "POST, GET, HEAD, OPTIONS");
  }
}
app.use((req, res, next) => { applyCors(req, res); next(); });
app.options("*", (req, res) => { applyCors(req, res); res.sendStatus(204); });

// --- helpers ----------------------------------------------------------------
const nowIso = () => new Date().toISOString();

function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
}

function authOK(req) {
  const token = req.get("x-bridge-token") || req.query.token;
  return !BRIDGE_TOKEN || token === BRIDGE_TOKEN;
}
function deny(res) { return res.status(401).json({ ok: false, error: "missing/invalid token" }); }

async function gasCall(name, args = {}) {
  if (!GAS_BASE_URL) throw new Error("GAS_BASE_URL not configured");
  const u = new URL(GAS_BASE_URL);
  u.searchParams.set("tool", name);
  u.searchParams.set("args", JSON.stringify(args));
  if (SHARED_KEY) u.searchParams.set("key", SHARED_KEY);

  const r = await fetch(u, { method: "GET", headers: { accept: "application/json" } });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { ok: true, text }; }
}

async function gasHealthy() {
  if (!GAS_BASE_URL) return false;
  try {
    const u = new URL(GAS_BASE_URL);
    u.searchParams.set("echo", "1");
    if (SHARED_KEY) u.searchParams.set("key", SHARED_KEY);
    const r = await fetch(u, { method: "GET" });
    return r.ok;
  } catch { return false; }
}

// --- MCP Tool Catalog -------------------------------------------------------
const TOOL_CATALOG = {
  "drive.list": {
    description: "List files by folder path/ID",
    inputSchema: {
      type: "object",
      properties: {
        folderId: { type: "string", description: "Drive folder ID (or 'root')" },
        path:     { type: "string", description: "Folder path (optional; if provided, server may ignore if not supported)" },
        pageToken:{ type: "string" },
        pageSize: { type: "integer", minimum: 1, maximum: 200 }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        items: { type: "array" },
        nextPageToken: { type: "string" }
      },
      required: ["ok","items"]
    }
  },
  "drive.search": {
    description: "Drive v2 query (e.g., title contains \"…\" and trashed=false)",
    inputSchema: {
      type: "object",
      properties: {
        q:        { type: "string", description: "Drive v2 search query" },
        query:    { type: "string", description: "Alias of q" },
        pageToken:{ type: "string" },
        pageSize: { type: "integer", minimum: 1, maximum: 200 }
      },
      required: ["q"]
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        items: { type: "array" },
        nextPageToken: { type: "string" }
      },
      required: ["ok","items"]
    }
  },
  "drive.get": {
    description: "Get metadata by file id",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    },
    outputSchema: { type: "object" }
  },
  "drive.export": {
    description: "Export Google Docs/Sheets/Slides or text",
    inputSchema: {
      type: "object",
      properties: {
        id:   { type: "string", description: "File ID" },
        mime: { type: "string", description: "MIME (e.g., text/plain, text/csv, application/pdf)" }
      },
      required: ["id"]
    },
    // export returns text for Inspector preview
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        id: { type: "string" },
        srcMime: { type: "string" },
        mime: { type: "string" },
        size: { type: "integer" },
        text: { type: "string" }
      },
      required: ["ok","id","mime","text"]
    }
  }
};

// --- routes -----------------------------------------------------------------
// Health
app.get("/health", async (req, res) => {
  const gas = await gasHealthy();
  res.json({ ok: true, gas, version: BRIDGE_VERSION, ts: nowIso() });
});

// Transport discovery
app.head("/mcp", (req, res) => { if (!authOK(req)) return deny(res); res.sendStatus(204); });
app.get("/mcp",  (req, res) => { if (!authOK(req)) return deny(res); res.json({ ok: true, transport: "streamable-http" }); });

// JSON-RPC
app.post("/mcp", async (req, res) => {
  if (!authOK(req)) return deny(res);
  const { id = null, method, params = {} } = req.body || {};
  if (!method) return res.json(rpcError(id, -32600, "Invalid Request: missing method"));

  try {
    if (method === "initialize") {
      return res.json(rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "YFL Drive Bridge", version: BRIDGE_VERSION }
      }));
    }

    if (method === "tools/list") {
      const tools = Object.entries(TOOL_CATALOG).map(([name, t]) => ({
        name, description: t.description,
        inputSchema: t.inputSchema, outputSchema: t.outputSchema,
        annotations: { readOnlyHint: true }
      }));
      return res.json(rpcResult(id, { tools }));
    }

    if (method === "tools/call") {
      const { name, arguments: rawArgs = {} } = params || {};
      if (!name) return res.json(rpcError(id, -32602, "Missing tool name"));
      const t = TOOL_CATALOG[name];
      if (!t) return res.json(rpcError(id, -32601, `Unknown tool: ${name}`));

      // normalize args for GAS
      let args = { ...rawArgs };
      if (name === "drive.search") {
        args.q = args.q ?? args.query ?? "";
        if (!args.q) return res.json(rpcError(id, -32602, "drive.search requires 'q'"));
        if (args.pageSize) args.pageSize = Math.min(200, Math.max(1, Number(args.pageSize)));
      }
      if (name === "drive.list") {
        args.pageSize = args.pageSize ? Math.min(200, Math.max(1, Number(args.pageSize))) : undefined;
        // path is best-effort on GAS; folderId preferred.
      }

      const out = await gasCall(name, args);

      // if GAS returned plain text, wrap it in the expected object envelope
      let structured = out && typeof out === "object" ? out : { ok: true, text: String(out ?? "") };

      return res.json(rpcResult(id, {
        content: [{ type: "object", object: structured }]
      }));
    }

    return res.json(rpcError(id, -32601, `Method not found: ${method}`));
  } catch (e) {
    const msg = e?.message || String(e);
    const data = e?.stack ? { stack: String(e.stack).split("\n").slice(0,3).join("\n") } : undefined;
    return res.json(rpcError(id, -32000, msg, data));
  }
});

app.listen(PORT, () => {
  console.log(`YFL Drive Bridge listening on ${PORT}`);
});
