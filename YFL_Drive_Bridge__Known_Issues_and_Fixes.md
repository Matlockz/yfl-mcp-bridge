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
