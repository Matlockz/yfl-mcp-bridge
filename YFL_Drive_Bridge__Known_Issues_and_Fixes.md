# YFL Drive Bridge — Known Issues & Fixes
_Last updated: 2025‑10‑16_

## 2025‑10‑16 — ChatGPT Connector creation fails with **404 Not Found**
**Symptom:** “Error creating connector: Client error '404 Not Found' for url '…/mcp?token=…'.”  
**Root cause:** Bridge only exposed `POST /mcp`. The ChatGPT UI probes the MCP URL with `GET`/`HEAD` first, which returned 404 (method not matched).  
**Fix:** Add `GET /mcp` and `HEAD /mcp` that return 200 with a minimal JSON banner.  
**Bridge version:** v3.4.5 (`server.mjs` in this repo).  
**References:** Express routing is method‑specific; unmatched methods are 404. :contentReference[oaicite:8]{index=8}

---

## 2025‑10‑15 — MCP Inspector occasional “Request timed out”
**Symptom:** “MCP error -32001: Request timed out” on `tools/call`.  
**Cause:** Apps Script response occasionally > Inspector timeout.  
**Mitigation:** Keep `limit` small in `drive.search`, and avoid large folder listings; re‑run immediately usually succeeds.

---

## 2025‑10‑15 — Apps Script returns HTML/302 instead of JSON
**Symptom:** Bridge error: “GAS returned non‑JSON (text/html)…”.  
**Cause:** First hop is a 302 to `script.googleusercontent.com` or interstitial (ngrok).  
**Fix:** Bridge follows 302 to googleusercontent; when testing via ngrok in a browser, send header `ngrok-skip-browser-warning: 1`. :contentReference[oaicite:9]{index=9}

---

## 2025‑10‑12 — Token drift / bad token
**Symptom:** 401 “bad token”.  
**Fix:** Ensure the same token value is set in:
- `.env` → `TOKEN`
- `MCP Server URL` query string `?token=…`
- Smoke‑test headers: `X-Bridge-Token`.

