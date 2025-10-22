// server.mjs — YFL Drive Bridge (Streamable HTTP MCP)
// Node 18+ (global fetch). Run: `node server.mjs`

import express from "express";

const app = express();

// ---- Config ---------------------------------------------------------------
const PORT            = process.env.PORT ? Number(process.env.PORT) : 5050;
const BRIDGE_TOKEN    = process.env.BRIDGE_TOKEN || process.env.TOKEN || "";
const BRIDGE_VERSION  = process.env.BRIDGE_VERSION || "3.1.1n";

// GAS web app (Apps Script) — set to your deployed "Web app" URL (exec).
const GAS_BASE_URL    = process.env.GAS_BASE_URL || process.env.GAS_BASE || "";
const SHARED_KEY      = process.env.SHARED_KEY || "";

// CORS / origin allow-list for Inspector (and your tunnel).
// Comma-separated list. Supports a wildcard for *.trycloudflare.com.
const ALLOW_ORIGINS   = (process.env.ALLOW_ORIGINS ||
  "http://localhost:6274, http://localhost:6225, *.trycloudflare.com"
).split(",").map(s => s.trim()).filter(Boolean);

// ---- Express plumbing -----------------------------------------------------
app.set("trust proxy", true);           // respect CF headers when tunneled
app.use(express.json({ limit: "1mb" })); // JSON-RPC request bodies

// Strict, minimal CORS with Origin allow-list (see MCP transport security notes).
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const okOrigin = ALLOW_ORIGINS.some(rule => {
    if (!rule) return false;
    if (rule === "*") return true;
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1); // ".domain"
      return origin.endsWith(suffix);
    }
    return origin === rule;
  });

  if (origin && okOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, x-bridge-token, Authorization"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- Helpers --------------------------------------------------------------
const nowIso = () => new Date().toISOString();

const json = (res, body, status = 200) =>
  res.status(status).type("application/json").send(body);

const authed = req =>
  !BRIDGE_TOKEN ||
  req.get("x-bridge-token") === BRIDGE_TOKEN ||
  req.query.token === BRIDGE_TOKEN;

const deny = res => json(res, { ok: false, error: "missing/invalid token" }, 401);

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError  = (id, code, message, data) => {
  const e = { code, message };
  if (data !== undefined) e.data = data;
  return { jsonrpc: "2.0", id, error: e };
};

// GAS caller (Apps Script Web App: doGet(e) → JSON; one redirect is normal)
async function gasCall(name, args = {}) {
  if (!GAS_BASE_URL) {
    const hint = "Set GAS_BASE_URL to your Apps Script Web App (Deploy → Web app → URL).";
    throw new Error(`GAS_BASE_URL not configured. ${hint}`);
  }
  const u = new URL(GAS_BASE_URL);
  u.searchParams.set("tool", name);
  u.searchParams.set("args", JSON.stringify(args));
  if (SHARED_KEY) u.searchParams.set("key", SHARED_KEY);

  const r = await fetch(u.toString(), { method: "GET", headers: { accept: "application/json" } });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function gasHealthy() {
  if (!GAS_BASE_URL) return false;
  try {
    const u = new URL(GAS_BASE_URL);
    u.searchParams.set("echo", "1");
    if (SHARED_KEY) u.searchParams.set("key", SHARED_KEY);
    const r = await fetch(u.toString(), { method: "GET" });
    return r.ok;
  } catch {
    return false;
  }
}

// ---- Routes ---------------------------------------------------------------

// Health (and whether GAS is reachable)
app.get("/health", async (req, res) => {
  const gas = await gasHealthy();
  json(res, { ok: true, gas, version: BRIDGE_VERSION, ts: nowIso() });
});

// Light env probe for debugging (never returns secrets)
app.get("/envcheck", (req, res) => {
  json(res, {
    ok: true,
    version: BRIDGE_VERSION,
    hasToken: Boolean(BRIDGE_TOKEN),
    hasGas: Boolean(GAS_BASE_URL),
    allowOrigins: ALLOW_ORIGINS
  });
});

// Transport discovery (MCP); HEAD = 204, GET = transport banner
app.head("/mcp", (req, res) => {
  if (!authed(req)) return deny(res);
  res.sendStatus(204);
});

app.get("/mcp", (req, res) => {
  if (!authed(req)) return deny(res);
  json(res, { ok: true, transport: "streamable-http" });
});

// JSON‑RPC 2.0 endpoint
app.post("/mcp", async (req, res) => {
  if (!authed(req)) return deny(res);

  const { id = null, method, params = {} } = req.body || {};
  if (!method) return json(res, rpcError(id, -32600, "Invalid Request: missing method"));

  try {
    // initialize
    if (method === "initialize") {
      return json(res, rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "YFL Drive Bridge", version: BRIDGE_VERSION }
      }));
    }

    // tools/list (with JSON Schemas for Inspector Via‑Proxy)
    if (method === "tools/list") {
      const tools = [
        {
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
              ok:    { type: "boolean" },
              items: { type: "array" }
            }
          },
          annotations: { readOnlyHint: true }
        },
        {
          name: "drive.search",
          description: "Drive v2 query (e.g., title contains \"…\" and trashed=false)",
          inputSchema: {
            type: "object",
            properties: {
              q:         { type: "string", description: "Drive v2 query string" },
              pageSize:  { type: "integer", minimum: 1, maximum: 200 },
              pageToken: { type: "string" }
            },
            required: ["q"]
          },
          outputSchema: { type: "object" },
          annotations: { readOnlyHint: true }
        },
        {
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
        {
          name: "drive.export",
          description: "Export Google Docs/Sheets/Slides or text",
          inputSchema: {
            type: "object",
            properties: {
              id:   { type: "string", description: "File ID to export" },
              mime: { type: "string", description: "MIME type (e.g., text/plain, text/csv, application/pdf)" }
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
      ];
      return json(res, rpcResult(id, { tools }));
    }

    // tools/call → delegate to GAS
    if (method === "tools/call") {
      const { name, arguments: args = {} } = params || {};
      if (!name) return json(res, rpcError(id, -32602, "Missing tool name"));

      const out = await gasCall(name, args);
      const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      return json(res, rpcResult(id, { content: [{ type: "text", text }] }));
    }

    // unknown method
    return json(res, rpcError(id, -32601, `Method not found: ${method}`));
  } catch (err) {
    const msg  = err?.message || String(err);
    const data = err?.stack ? { stack: String(err.stack).split("\n").slice(0, 4).join("\n") } : undefined;
    return json(res, rpcError(id, -32000, msg, data));
  }
});

app.listen(PORT, () => {
  console.log(`YFL Drive Bridge listening on ${PORT}`);
});
