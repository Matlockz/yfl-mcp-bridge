// server.mjs — YFL Drive Bridge (Streamable HTTP MCP)
// ESM only. Requires Node 18+ (global fetch). Run: `node server.mjs`
// If you keep the filename as server.js, make sure "type":"module" is set in package.json.

import express from "express";

const app = express();

// --- config -----------------------------------------------------------------
const PORT            = process.env.PORT ? Number(process.env.PORT) : 5050;
const BRIDGE_TOKEN    = process.env.BRIDGE_TOKEN || process.env.TOKEN || "";
const BRIDGE_VERSION  = process.env.BRIDGE_VERSION || "3.1.1n";
const GAS_BASE_URL    = process.env.GAS_BASE_URL || process.env.GAS_BASE || "";
const SHARED_KEY      = process.env.SHARED_KEY || "";

// --- middleware --------------------------------------------------------------
// Trust Cloudflare / reverse proxies for proto/IP, etc.
app.set("trust proxy", true);

// CORS (Direct Inspector calls need this). Preflight gets 204.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, x-bridge-token");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// JSON bodies for JSON‑RPC
app.use(express.json({ limit: "1mb" }));

// --- helpers ----------------------------------------------------------------
const nowIso = () => new Date().toISOString();

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function ok(res, payload) {
  res.type("application/json").send(payload);
}

function authOK(req) {
  // Accept token via header or query
  const token = req.get("x-bridge-token") || req.query.token;
  return !BRIDGE_TOKEN || token === BRIDGE_TOKEN;
}
function deny(res) {
  res.status(401).json({ ok: false, error: "missing/invalid token" });
}

async function gasCall(name, args = {}) {
  if (!GAS_BASE_URL) throw new Error("GAS_BASE_URL not configured");
  // Contract: GAS doGet(e) reads tool & args from query and returns JSON via ContentService.
  // A redirect to script.googleusercontent.com is normal for Apps Script web apps.
  const u = new URL(GAS_BASE_URL);
  u.searchParams.set("tool", name);
  u.searchParams.set("args", JSON.stringify(args));
  if (SHARED_KEY) u.searchParams.set("key", SHARED_KEY);

  const r = await fetch(u, { method: "GET", headers: { accept: "application/json" } });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    // Non‑JSON (e.g., text or helpful error from GAS) — pass through as string.
    return text;
  }
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

// --- MCP JSON Schema for tools (Inspector requires inputSchema) --------------
// Spec requires `inputSchema` on each tool returned by tools/list. :contentReference[oaicite:3]{index=3}
const toolSchemas = {
  "drive.list": {
    name: "drive.list",
    description: "List files by folder path/ID",
    inputSchema: {
      type: "object",
      properties: {
        folderId: { type: "string", description: "Google Drive folder ID" },
        path:     { type: "string", description: "Folder path (beacons style). Either path or folderId." },
        pageToken:{ type: "string" },
        pageSize: { type: "integer", minimum: 1, maximum: 200 }
      }
    },
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        items: { type: "array" }
      }
    },
    annotations: { readOnlyHint: true }
  },
  "drive.search": {
    name: "drive.search",
    description: "Drive v2 query (e.g., title contains \"…\" and trashed=false)",
    inputSchema: {
      type: "object",
      properties: {
        q:        { type: "string", description: "Drive v2 query string" },
        pageSize: { type: "integer", minimum: 1, maximum: 200 },
        pageToken:{ type: "string" }
      },
      required: ["q"]
    },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint: true }
  },
  "drive.get": {
    name: "drive.get",
    description: "Get metadata by file id",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint: true }
  },
  "drive.export": {
    name: "drive.export",
    description: "Export Google Docs/Sheets/Slides or text",
    inputSchema: {
      type: "object",
      properties: {
        id:   { type: "string", description: "File ID to export" },
        mime: { type: "string", description: "MIME to export (e.g., text/plain, text/csv, application/pdf)" }
      },
      required: ["id"]
    },
    outputSchema: {
      type: "object",
      properties: {
        content: {
          type: "array",
          items: {
            type: "object",
            properties: { type: { type: "string" }, text: { type: "string" } },
            required: ["type", "text"]
          }
        }
      }
    },
    annotations: { readOnlyHint: true }
  }
};

// --- routes ------------------------------------------------------------------
// Health: include minimal GAS ping if configured
app.get("/health", async (_req, res) => {
  const gas = await gasHealthy();
  res.json({ ok: true, gas, version: BRIDGE_VERSION, ts: nowIso() });
});

// Transport discovery
app.head("/mcp", (req, res) => {
  if (!authOK(req)) return deny(res);
  res.sendStatus(204); // handy for probes
});

app.get("/mcp", (req, res) => {
  if (!authOK(req)) return deny(res);
  res.json({ ok: true, transport: "streamable-http" });
});

// JSON‑RPC 2.0 endpoint
app.post("/mcp", async (req, res) => {
  if (!authOK(req)) return deny(res);

  const { id = null, method, params = {} } = req.body || {};
  if (!method) return ok(res, rpcError(id, -32600, "Invalid Request: missing method"));

  try {
    // initialize
    if (method === "initialize") {
      // JSON‑RPC response must include jsonrpc, id, and either result or error. :contentReference[oaicite:4]{index=4}
      return ok(res, rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "YFL Drive Bridge", version: BRIDGE_VERSION }
      }));
    }

    // tools/list
    if (method === "tools/list") {
      const tools = Object.values(toolSchemas).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        // outputSchema not required by all clients, but included for completeness.
        outputSchema: t.outputSchema,
        annotations: t.annotations
      }));
      return ok(res, rpcResult(id, { tools }));
    }

    // tools/call
    if (method === "tools/call") {
      const { name, arguments: args = {} } = params || {};
      if (!name) return ok(res, rpcError(id, -32602, "Missing tool name"));

      // Route to GAS
      const out = await gasCall(name, args);

      // MCP content block for Inspector preview
      const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      return ok(res, rpcResult(id, { content: [{ type: "text", text }] }));
    }

    // Not found
    return ok(res, rpcError(id, -32601, `Method not found: ${method}`));
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    const data = e && e.stack ? { stack: String(e.stack).split("\n").slice(0, 3).join("\n") } : undefined;
    return ok(res, rpcError(id, -32000, msg, data));
  }
});

// --- start -------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`YFL Drive Bridge listening on ${PORT}`);
});
