// server.mjs — YFL Drive Bridge (Streamable HTTP MCP)
// ESM only. Requires Node 18+ (global fetch). Run: `node server.mjs`

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ------------ lightweight env loader (no deps) -----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

function loadEnvFrom(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const text = fs.readFileSync(filePath, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // strip matching quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] == null) {
        process.env[key] = val;
      }
    }
  } catch { /* ignore */ }
}

// Look for .env / env.txt in cwd and alongside this file
const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "env.txt"),
  path.join(__dirname, ".env"),
  path.join(__dirname, "env.txt"),
];
candidates.forEach(loadEnvFrom);

// ------------ config -----------------
const app = express();
const PORT            = process.env.PORT ? Number(process.env.PORT) : 5050;
const BRIDGE_TOKEN    = process.env.BRIDGE_TOKEN || process.env.TOKEN || "";
const BRIDGE_VERSION  = process.env.BRIDGE_VERSION || "3.1.1n";
const GAS_BASE_URL    = process.env.GAS_BASE_URL || process.env.GAS_BASE || "";
const SHARED_KEY      = process.env.SHARED_KEY || process.env.GAS_KEY || "";
const ALLOW_ORIGINS   = (process.env.ALLOW_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

// ------------ express setup -----------
app.set("trust proxy", true);                               // respect CF / proxy headers
app.use(express.json({ limit: "1mb" }));                    // JSON-RPC bodies

// CORS (optional but helps Inspector Direct)
function isAllowedOrigin(origin) {
  if (!origin || ALLOW_ORIGINS.length === 0) return false;
  return ALLOW_ORIGINS.some(pat => {
    pat = pat.trim();
    if (!pat) return false;
    if (pat === "*") return true;
    if (pat.startsWith("*.")) return origin.endsWith(pat.slice(1));
    return origin === pat;
  });
}
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-bridge-token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ------------ helpers -----------------
const nowIso = () => new Date().toISOString();
const ok = (res, payload) => res.type("application/json").send(payload);

function authOK(req) {
  const token = req.get("x-bridge-token") || req.query.token;
  return !BRIDGE_TOKEN || token === BRIDGE_TOKEN;
}
const deny = (res) => res.status(401).json({ ok: false, error: "missing/invalid token" });

// JSON-RPC envelopes
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError  = (id, code, message, data) => {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
};

async function gasCall(name, args = {}) {
  if (!GAS_BASE_URL) throw new Error("GAS_BASE_URL not configured");
  const u = new URL(GAS_BASE_URL);
  // GAS doGet(e) reads tool & args & key; returns JSON via ContentService (one redirect is normal)
  u.searchParams.set("tool", name);
  u.searchParams.set("args", JSON.stringify(args));
  if (SHARED_KEY) u.searchParams.set("key", SHARED_KEY);

  const r = await fetch(u, { method: "GET", headers: { "accept": "application/json" } });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }
}

// ------------ routes ------------------
// Health: include whether GAS URL is present
app.get("/health", async (req, res) => {
  res.json({ ok: true, gas: Boolean(GAS_BASE_URL), version: BRIDGE_VERSION, ts: nowIso() });
});

// MCP transport discovery
app.head("/mcp", (req, res) => {
  if (!authOK(req)) return deny(res);
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
    if (method === "initialize") {
      return ok(res, rpcResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "YFL Drive Bridge", version: BRIDGE_VERSION },
      }));
    }

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
              pageSize: { type: "integer", minimum: 1, maximum: 200 },
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
      return ok(res, rpcResult(id, { tools }));
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } = params || {};
      if (!name) return ok(res, rpcError(id, -32602, "Missing tool name"));
      const out = await gasCall(name, args);
      const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      return ok(res, rpcResult(id, { content: [{ type: "text", text }] }));
    }

    return ok(res, rpcError(id, -32601, `Method not found: ${method}`));
  } catch (e) {
    const msg  = e?.message || String(e);
    const data = e?.stack ? { stack: String(e.stack).split("\n").slice(0, 4).join("\n") } : undefined;
    return ok(res, rpcError(id, -32000, msg, data));
  }
});

app.listen(PORT, () => {
  console.log(`YFL Drive Bridge listening on ${PORT}`);
});
