# YFL Drive Bridge — Known Issues & Fixes (append‑only)

_Last updated: 2025‑10‑16_

## 2025‑10‑16 — ChatGPT connector “404 Not Found” for /mcp
**Symptom**: Creating the connector with `https://<ngrok>/mcp?token=…` shows “404 Not Found”.  
**Root Cause**: Bridge only implemented POST `/mcp`. MCP HTTP transport requires the endpoint to support GET/HEAD (clients probe with GET).  
**Fix**: Add `app.head('/mcp')` and `app.get('/mcp')` that return 204/200. Keep POST for JSON‑RPC.  
**Status**: Fixed in bridge v3.4.5.

## 2025‑10‑16 — Inspector “Request timed out”
**Symptom**: `MCP error -32001: Request timed out`.  
**Cause**: Long‑running Apps Script execution (~18s) for heavy Drive queries.  
**Fix**: Use `limit <= 5` in smoke tests; keep GAS quick; retry.  
**Status**: Mitigated.

## 2025‑10‑15 — “User input required / non‑interactive” in ChatGPT
**Symptom**: Model refused to run actions in a connector‑only chat.  
**Cause**: Client heuristics treated tools as interactive.  
**Fix**: Return `annotations.readOnlyHint=true` for each tool in `tools/list`.  
**Status**: Fixed.

## 2025‑10‑15 — Ngrok warning page (ERR_NGROK_6024) mangled JSON
**Symptom**: HTML interstitial instead of JSON.  
**Cause**: Ngrok browser warning page.  
**Fix**: For browser‑style calls, send header `ngrok-skip-browser-warning: 1`. (Not needed by ChatGPT; only for manual tests.)  
**Status**: Documented.

## 2025‑10‑15 — 302/HTML from Apps Script instead of JSON
**Symptom**: “GAS returned non‑JSON (text/html …)”  
**Cause**: Apps Script `/exec` often 302‑redirects to script.googleusercontent.com.  
**Fix**: Bridge follows a single 302/303 if the Location host matches `script.googleusercontent.com`. Ensure `doGet(e)` returns JSON via `ContentService` with MIME JSON.  
**Status**: Fixed in bridge; confirmed v7 GAS.

## 2025‑10‑15 — Port in use (EADDRINUSE)
**Symptom**: `listen EADDRINUSE :::10000`.  
**Cause**: Old Node process still running.  
**Fix**: `Get-Process node | Stop-Process -Force` or pick a new `$env:PORT`.

## 2025‑10‑12 — Wrong path / token drift
**Symptom**: 404 or HTML from `/api/...` or missing `?token=`.  
**Fix**: Always call GAS with `https://script.google.com/.../exec?action=...&token=<GAS_KEY>`. Bridge owns adding the token; client uses bridge token for `/tools/*` + `/mcp`.

## 2025‑10‑12 — Inspector transport mismatch
**Symptom**: “Server ‘0’ not found” / no tools.  
**Fix**: Use **Streamable HTTP**, URL `http://localhost:10000/mcp?token=...`, Connection **Via Proxy**.

# YFL Drive Bridge — Known Issues & Fixes (append-only)
_Last updated: 2025-10-16_

## 1) Connector creation shows **404 Not Found** for `/mcp?token=...`
**Symptom:** ChatGPT “New Connector” dialog errors with 404; server logs show no hit or only POSTs later.  
**Root cause:** Bridge exposed only `POST /mcp`; the connector UI probes with **GET/HEAD** first.  
**Fix:** Add `GET /mcp` (200 JSON) and `HEAD /mcp` (204), keep `POST /mcp` for JSON‑RPC.  
**Status:** Fixed in server v3.4.5. (Spec allows GET for streaming transports; returning 2xx is acceptable.)  
Refs: MCP HTTP transport notes.  
---

## 2) “User input required” / non‑interactive stalls
**Symptom:** Chat prompts fail claiming authorization required.  
**Root cause:** Tools not marked read‑only.  
**Fix:** In `tools/list`, include `annotations.readOnlyHint: true` per tool.  
**Status:** Fixed in server v3.4.5.  
---

## 3) GAS returns HTML (302 / content-type text/html)
**Symptom:** Bridge error: “GAS returned non‑JSON (302 text/html)”.  
**Root cause:** Apps Script web app redirects to `script.googleusercontent.com`; naive fetch didn’t follow; or missing `ContentService.MimeType.JSON`.  
**Fix:** Bridge follows 302/303 → `script.googleusercontent.com` and enforces JSON; Apps Script returns JSON via `ContentService.createTextOutput(...).setMimeType(ContentService.MimeType.JSON)`.  
**Status:** Fixed in `gasAction` and GAS.  
Refs: Apps Script Web Apps & ContentService docs.  
---

## 4) Wrong Drive search query field
**Symptom:** No results when searching.  
**Root cause:** Using `name contains` with `DriveApp.searchFiles` (v2-style) which expects **`title contains`** and `trashed = false`.  
**Fix:** Use `title contains '...' and trashed = false`.  
**Status:** Documented in runbook and examples.  
Refs: DriveApp `searchFiles` examples.  
---

## 5) Port in use (EADDRINUSE)
**Symptom:** `Error: listen EADDRINUSE :::10000`.  
**Fix:** Either `Get-Process node | Stop-Process -Force` or reuse the running server (don’t start twice).  
**Status:** Procedural—listed in smoke checklist.  
---

## 6) ngrok browser interstitial (ERR_NGROK_6024)
**Symptom:** Browser/PowerShell calls return the ngrok warning page.  
**Fix:** For manual testing add header `ngrok-skip-browser-warning: 1`. The ChatGPT connector is not a browser and doesn’t need this.  
**Status:** Documented.  
Refs: ngrok docs & community.  
---

## 7) Token/key drift
**Symptom:** Health passes but tools 401/403.  
**Root cause:** TOKEN mismatch between server and client, or stale GAS token.  
**Fix:** Keep `.env` / PowerShell exports in a single source of truth; rotate tokens across server + connector + scripts together.  
**Status:** Procedural—covered in smoke block.
