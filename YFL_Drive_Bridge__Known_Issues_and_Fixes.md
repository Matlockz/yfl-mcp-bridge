# YFL Drive Bridge — Known Issues & Fixes (living log)

_Last updated: YYYY‑MM‑DD_

## 0) Where to start, every time
1. Open **Runbook** + **Smoke Test Checklist** in `/Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here/`.  
2. Run bridge health and MCP round‑trip exactly as written there.  
3. If anything fails, stop here and record the failure below before trying new changes.

---

## 1) GAS returns HTML or 302 (accounts.google.com) instead of JSON
**Symptom**: Logs show `GAS returned non‑JSON (302 text/html...)`.  
**Cause**: Wrong deployment or path. Apps Script web‑apps serve JSON through **ContentService** and redirect via `script.googleusercontent.com`; you *must* hit the published **/exec** URL and pass any routing in the **query string** (e.g., `?action=health`)【:contentReference[oaicite:13]{index=13}】.  
**Fix**:
- Confirm **Active deployment** is Web app, Execute as **Me**, Who has access **Anyone (anonymous)**.  
- Ensure the bridge points to the **/exec** URL.  
- If the server calls `/api/health`, use `/?action=health` or support both (fallback pattern is acceptable).

---

## 2) Token mismatch (“bad token” on /tools/* or /mcp)
**Symptom**: 401 `bad token` in logs; calls omit the header or query token.  
**Fix**: For bridge REST and MCP: include **`X-Bridge-Token: $TOKEN`** (REST) or append **`?token=$TOKEN`** to the MCP URL (Inspector/clients). Keep `GAS_KEY` (for the Apps Script) and `BRIDGE_TOKEN` (for the bridge) distinct in `.env`, even if currently equal.

---

## 3) MCP Inspector won’t connect / can’t list tools
**Symptom**: STDIO selected by mistake, config map wrong, or URL missing `/mcp?token=...`.  
**Fix**:
- Use **HTTP(S)** and launch via CLI:  
  `npx @modelcontextprotocol/inspector --connect http://localhost:10000/mcp?token=$env:TOKEN`【 :contentReference[oaicite:16]{index=16}】  
- If using a config file, the schema is an `mcpServers` map keyed by name, not an array named `clients`【:contentReference[oaicite:17]{index=17}】.  
- Ensure JSON‑RPC shape on `tools/list` matches the spec (`result.tools` is an array)【:contentReference[oaicite:18]{index=18}】.

---

## 4) Drive search returns nothing or errors
**Symptom**: Query syntax complaints or empty results.  
**Fix**: `DriveApp.searchFiles` uses **v2‑style** query fields such as `title`, `trashed`, `modifiedDate`. Example:  
`title contains 'START_HERE' and trashed = false`【:contentReference[oaicite:19]{index=19}】.

---

## 5) PowerShell “jq not recognized”
**Symptom**: `jq` missing on Windows.  
**Fix**: Prefer native PowerShell: `Invoke‑RestMethod ... | ConvertTo‑Json -Depth N` (already used in our smoke tests).

---

## 6) “dotenv” / module not found when starting the bridge
**Symptom**: `ERR_MODULE_NOT_FOUND` for `dotenv` (or similar).  
**Fix**: `npm i dotenv node-fetch cors express morgan` (exact deps are listed in `package.json`).

---

## Quick sanity commands (no jq)
**Health**  
`Invoke‑RestMethod -Uri "http://localhost:10000/health"`

**Tools list (REST, with header token)**  
$H = @{ "X-Bridge-Token" = $env:TOKEN }
Invoke‑RestMethod -Headers $H -Uri "http://localhost:10000/tools/list" | ConvertTo‑Json -Depth 6

yaml
Copy code

**Inspector (HTTP/S)**  
`npx @modelcontextprotocol/inspector --connect "http://localhost:10000/mcp?token=$env:TOKEN"`【 :contentReference[oaicite:20]{index=20}】

---

## Changelog
- 2025‑10‑15: Logged repeated 302 issues from transcripts and added dual‑path `/?action=` fallback reference.
