## 2025-10-16 — Dive 5: Connector stabilization & non-interactive fix

**Symptoms**
- ChatGPT Connector creation fails with: `Client error '404 Not Found' for url '.../mcp?token=...'`.
- MCP Inspector intermittently shows: `MCP error -32001: Request timed out`.
- Occasional Apps Script responses were `text/html` (302) instead of JSON.
- Rare non-interactive/OAuth prompts despite read-only usage.

**Root causes**
- Bridge exposed only `POST /mcp`. ChatGPT connector probes MCP URL with **GET** at creation, producing 404.
- Long Google responses caused the Inspector proxy to exceed its per-call timeout.
- Apps Script web app often 302‑redirects to `script.googleusercontent.com`; first hop may not be JSON.
- Tools lacked explicit `annotations.readOnlyHint`.

**Fixes**
- Added **GET `/mcp`** health handler (token‑guarded) → Connector UI no longer 404s.
- Implemented **timeout+retry** in `gasAction` (12s default, one quick retry).
- On 302/303, follow one redirect to `script.googleusercontent.com` and enforce JSON content-type.
- `tools/list` (REST & MCP) now returns **`annotations: { readOnlyHint: true }`** for every tool.
- Documented adding `ngrok-skip-browser-warning: 1` header to bypass ngrok interstitials.

**Verification (pass gates)**
- **Transcript Gate:** errors & fixes captured here (see earlier timeline sections).
- **Design Gate:** all bridge→GAS calls are `.../exec?action=...&token=<GAS_KEY>`, rejects non‑JSON.
- **Read‑Only Gate:** `annotations.readOnlyHint` present in `tools/list`.
- **Runbook Gate:** local smoke tests pass (health / list / search / get).
- **Inspector Gate:** `initialize → tools/list → tools/call` returns `isError:false`.
- **Connector Gate:** Connector-only chat completes `drive.search` then `drive.get` without OAuth prompts.

**Version bump**
- Bridge `3.4.4`. Files updated: `server.mjs`, `package.json`.

**Notes (citations)**
- Apps Script doGet / JSON: Google docs.  
- Drive v2-style query & Drive v3 links on `files.get`.  
- JSON‑RPC 2.0 shape and MCP annotations/readOnlyHint.  
