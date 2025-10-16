// server.js — YFL Drive Bridge (Apps Script proxy + MCP over HTTP)
// Node 18+ (ESM). package.json must have: { "type": "module" }

import express from "express";
import cors from "cors";
import morgan from "morgan";

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));

// ---- Environment ------------------------------------------------------------
const PORT         = process.env.PORT || 10000;
const TOKEN        = process.env.TOKEN || process.env.BRIDGE_TOKEN || ""; // bridge token for /tools/* and /mcp
const GAS_BASE_URL = String(process.env.GAS_BASE_URL || "").replace(/\/+$/, "");
const GAS_KEY      = process.env.GAS_KEY || "";   // forwarded to GAS as ?token=
const MCP_PROTOCOL = process.env.MCP_PROTOCOL || "2024-11-05";
const DEBUG        = String(process.env.DEBUG || "0") === "1";

// ---- Tiny auth for bridge endpoints (header or query) ----------------------
function requireToken(req, res, next) {
  const fromHeader = (req.get("X-Bridge-Token") || "").trim();
  const fromQuery  = (req.query.token || "").trim();
  const provided   = fromHeader || fromQuery;
  if (!TOKEN || provided !== TOKEN) return res.status(401).json({ ok: false, error: "bad token" });
  next();
}

// ---- Add read-only hint to tools (prevents “User input required”) ----------
function mapToolsReadOnly(tools = []) {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema || t.inputSchema || { type: "object" },
    annotations: { readOnlyHint: true } // important for non-interactive turns
  }));
}

// ---- GAS helper (action-style) w/ redirect follow & JSON guard -------------
async function gasAction(action, params = {}) {
  if (!GAS_BASE_URL || !GAS_KEY) throw new Error("GAS not configured (GAS_BASE_URL / GAS_KEY)");

  const usp = new URLSearchParams({ action, token: GAS_KEY });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const url = `${GAS_BASE_URL}?${usp.toString()}`;

  // First request without auto-follow to diagnose redirects clearly
  let r = await fetch(url, { redirect: "manual" });

  // If Apps Script web app issues a 302/303 to script.googleusercontent.com, follow once
  if ((r.status === 302 || r.status === 303) && r.headers.get("location")) {
    const loc = r.headers.get("location");
    if (loc && /script\.googleusercontent\.com/i.test(loc)) {
      r = await fetch(loc, { redirect: "follow" });
    }
  }

  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    const peek = await r.text().catch(() => "");
    throw new Error(`GAS returned non-JSON (${r.status} ${ct || "no-ct"}) — first 200 chars: ${peek.slice(0, 200)}`);
  }

  const json = await r.json();
  if (DEBUG) console.log("GAS", action, "→", JSON.stringify(json).slice(0, 240));
  return json;
}

// ---- REST proxy (health + smoke-test helpers) ------------------------------
app.get("/health", async (_req, res) => {
  try {
    const out = await gasAction("health");
    return res.json({ ok: true, protocol: MCP_PROTOCOL, gas: !!(out && out.ok), ts: out.ts || null });
  } catch (e) {
    return res.status(424).json({ ok: false, gas: false, error: String(e?.message || e) });
  }
});

app.get("/tools/list", requireToken, async (_req, res) => {
  try {
    const out = await gasAction("tools/list");
    return res.json({ ok: true, tools: mapToolsReadOnly(out.tools || []) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/tools/call", requireToken, async (req, res) => {
  try {
    const { name, arguments: args = {} } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: "name is required" });
    const out = await gasAction("tools/call", { name, ...args });
    return res.json(out);
  } catch (e) {
    return res.status(424).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---- MCP endpoint ----------------------------------------------------------
// IMPORTANT: The connector UI hits GET/HEAD first. We return 200 (not 404),
// and advertise that POST is the JSON-RPC transport. This avoids “404”
// during connector creation while staying compatible with the MCP spec,
// which allows GET for streaming transports. :contentReference[oaicite:2]{index=2}

app.get("/mcp", requireToken, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, endpoint: "mcp", transport: "http", expects: "POST JSON-RPC", protocol: MCP_PROTOCOL });
});

app.head("/mcp", requireToken, (_req, res) => {
  res.status(204).end();
});

// Minimal JSON‑RPC over HTTP for Inspector/ChatGPT
app.post("/mcp", requireToken, async (req, res) => {
  const { jsonrpc, id, method, params = {} } = req.body || {};
  const rpcError = (code, message) => res.json({ jsonrpc: "2.0", id, error: { code, message } });

  try {
    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL,
          serverInfo: { name: "yfl-drive-bridge", version: "3.4.5" },
          capabilities: { tools: { listChanged: true } }
        }
      });
    }

    if (method === "tools/list") {
      const out = await gasAction("tools/list");
      const tools = mapToolsReadOnly(out.tools || []);
      return res.json({ jsonrpc: "2.0", id, result: { tools } });
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } = params;
      if (!name) return rpcError(-32602, "name is required");
      const out = await gasAction("tools/call", { name, ...args });
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(out) }],
          structuredContent: out,
          isError: false
        }
      });
    }

    return rpcError(-32601, `unknown method: ${method}`);
  } catch (e) {
    // Return a JSON‑RPC “internal error” wrapper for client clarity. :contentReference[oaicite:3]{index=3}
    return res.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: String(e?.message || e) }
    });
  }
});

// Root
app.get("/", (_req, res) => res.send("YFL MCP Drive Bridge is running."));
app.listen(PORT, () => console.log(`YFL MCP Bridge listening on :${PORT}`));
