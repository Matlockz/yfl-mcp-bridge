// server.mjs — YFL Drive Bridge (Streamable HTTP MCP)
// Node 18+ (global fetch). Run: `node server.mjs`
// Drop-in replacement: structured tool outputs for MCP Inspector, CORS, env loader.

import fs from "fs";
import path from "path";
import os from "os";
import express from "express";

// ---- tiny env loader (files are optional) -----------------------------------
function loadKvFile(p) {
  try {
    const txt = fs.readFileSync(p, "utf8");
    txt.split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) return;
      const [, k, raw] = m;
      // strip surrounding quotes if present
      const v = raw.replace(/^['"]|['"]$/g, "");
      if (!(k in process.env)) process.env[k] = v;
    });
  } catch { /* no-op */ }
}
const here = process.cwd();
loadKvFile(path.join(here, ".env"));
loadKvFile(path.join(here, "env.txt"));

// ---- config -----------------------------------------------------------------
const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;
const BRIDGE_TOKEN   = process.env.BRIDGE_TOKEN || process.env.TOKEN || "";
const BRIDGE_VERSION = process.env.BRIDGE_VERSION || "3.1.1n";
const GAS_BASE_URL   = process.env.GAS_BASE_URL || process.env.GAS_BASE || "";
const SHARED_KEY     = process.env.SHARED_KEY || process.env.GAS_KEY || "";

const ALLOW_ORIGINS = (process.env.ALLOW_ORIGINS || "")
  .split(/[,\s]+/).filter(Boolean);

// express core
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

// ---- CORS (allow Inspector + trycloudflare when listed) ---------------------
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const ok =
    !!origin &&
    (ALLOW_ORIGINS.includes(origin) ||
     ALLOW_ORIGINS.includes("*") ||
     ALLOW_ORIGINS.some(p => p.startsWith("*.") ? origin.endsWith(p.slice(1)) : false));
  if (ok) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,HEAD,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-bridge-token, Authorization");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- helpers ----------------------------------------------------------------
const nowIso = () => new Date().toISOString();
const deny = (res) => res.status(401).json({ ok: false, error: "missing/invalid token" });
const authOK = (req) => {
  const token = req.get("x-bridge-token") || req.query.token;
  return !BRIDGE_TOKEN || token === BRIDGE_TOKEN;
};
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError  = (id, code, message, data) => {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id, error: err };
};

// GAS web-app call: doGet(e) returns JSON via ContentService (one redirect is normal)
async function gasCall(name, args = {}) {
  if (!GAS_BASE_URL) throw new Error("GAS_BASE_URL not configured");
  const u = new URL(GAS_BASE_URL);
  u.searchParams.set("tool", name);
  u.searchParams.set("args", JSON.stringify(args));
  if (SHARED_KEY) u.searchParams.set("key", SHARED_KEY);
  const r = await fetch(u.toString(), { method: "GET", headers: { accept: "application/json" } });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    // non-JSON responses are still returned (Inspector will see text)
    return text;
  }
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

// ---- MCP: tool catalog (declare output schemas) ------------------------------
const TOOL_CATALOG = [
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
      properties: { ok: { type: "boolean" }, items: { type: "array" } }
    }
  },
  {
    name: "drive.search",
    description: "Drive v2 query (e.g., title contains \"…\" and trashed=false)",
    inputSchema: {
      type: "object",
      properties: {
        q:        { type: "string", description: "Drive v2 query string" },
        pageSize: { type: "integer", minimum: 1, maximum: 200 },
        pageToken:{ type: "string" }
      },
      required: [ "q" ]
    },
    outputSchema: { type: "object" }
  },
  {
    name: "drive.get",
    description: "Get metadata by file id",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: [ "id" ]
    },
    outputSchema: { type: "object" }
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
      required: [ "id" ]
    },
    outputSchema: {
      type: "object",
      properties: {
        content: {
          type: "array",
          items: {
            type: "object",
            properties: { type: { type: "string" }, text: { type: "string" } },
            required: [ "type", "text" ]
          }
        }
      }
    }
  }
];

const toolMap = new Map(TOOL_CATALOG.map(t => [t.name, t]));

// ---- routes -----------------------------------------------------------------
app.get("/health", async (req, res) => {
  const gas = await gasHealthy();
  res.json({ ok: true, gas, version: BRIDGE_VERSION, ts: nowIso() });
});

app.head("/mcp", (req, res) => {
  if (!authOK(req)) return deny(res);
  res.sendStatus(204);
});

app.get("/mcp", (req, res) => {
  if (!authOK(req)) return deny(res);
  res.json({ ok: true, transport: "streamable-http" });
});

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
      const tools = TOOL_CATALOG.map(({ name, description, inputSchema, outputSchema }) => ({
        name, description, inputSchema, outputSchema, annotations: { readOnlyHint: true }
      }));
      return res.json(rpcResult(id, { tools }));
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } = params || {};
      if (!name) return res.json(rpcError(id, -32602, "Missing tool name"));

      const spec = toolMap.get(name);
      if (!spec) return res.json(rpcError(id, -32601, `Unknown tool: ${name}`));

      const out = await gasCall(name, args);

      // If tool declares an outputSchema and we have JSON, return structured
      if (spec.outputSchema) {
        let obj = out;
        if (typeof out === "string") {
          try { obj = JSON.parse(out); } catch { /* keep string */ }
        }
        if (obj && typeof obj === "object") {
          return res.json(rpcResult(id, { content: [ { type: "object", object: obj } ] }));
        }
      }

      // Fallback to text content
      const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      return res.json(rpcResult(id, { content: [ { type: "text", text } ] }));
    }

    return res.json(rpcError(id, -32601, `Method not found: ${method}`));
  } catch (e) {
    const msg  = (e && e.message) ? e.message : String(e);
    const data = (e && e.stack) ? { stack: String(e.stack).split("\n").slice(0, 3).join("\n") } : undefined;
    return res.json(rpcError(id, -32000, msg, data));
  }
});

app.listen(PORT, () => {
  console.log(`YFL Drive Bridge listening on ${PORT}`);
});
