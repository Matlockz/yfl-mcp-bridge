# YFL Drive Bridge — Known Issues & Fixes (living log)

_Last updated: 2025‑10‑16_

## 0) Where to start, every time
1. Open **Runbook** + **Smoke Test Checklist** in `/Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here/`.  
2. Run bridge health and MCP round‑trip exactly as written there.  
3. If anything fails, stop here and record the failure below before trying new changes. :contentReference[oaicite:17]{index=17}

---

## 1) GAS returns HTML or 302 (accounts.google.com) instead of JSON
**Symptom**: Logs show `GAS returned non‑JSON (302 text/html...)`.  
**Cause**: Wrong deployment or path. Apps Script web‑apps must be called at the **/exec** URL and return JSON via **ContentService** from `doGet(e)`. Parameters arrive via `e.parameter`.  
**Fix**:
- Confirm **Web app** deployment with **Execute as “Me”** and **Who has access “Anyone”**.  
- Call `/exec` with `?action=...&token=...` (no `/api/...` paths).  
**Refs**: Google Web Apps + ContentService docs. :contentReference[oaicite:18]{index=18}

---

## 2) Token mismatch (“bad token” on /tools/* or /mcp)
**Symptom**: 401 `bad token`; missing `X‑Bridge‑Token` header or missing `?token=` on `/mcp`.  
**Fix**: Always pass **`X‑Bridge‑Token: <TOKEN>`** for REST calls and **append `?token=<TOKEN>`** on the MCP URL. Keep GAS’s `token` (for Apps Script) and the bridge’s token distinct, even if set equal.

---

## 3) MCP Inspector won’t connect / tools list empty
**Symptom**: Connected with **STDIO** by mistake, config schema off, or MCP URL missing `?token=`.  
**Fix**: Use **Streamable HTTP**; connect the UI to `http://localhost:<port>/mcp?token=<TOKEN>`; expect `tools/list` to return an array.  
**Refs**: Inspector docs and usage notes. :contentReference[oaicite:19]{index=19}

---

## 4) Drive search/list quirks
**Symptom**: Queries with `name` field or v3 terms don’t match; `drive.list` returned empty results when a file id was passed.  
**Fix**:  
- Use **v2** query terms for `DriveApp.searchFiles`, e.g., `title contains 'X' and trashed = false`.  
- For **drive.list**, pass a real **folder id** or use `folderPath`; do not pass a **file** id (ZIP).  
**Refs**: DriveApp v2 syntax; Advanced Drive v3 for metadata. :contentReference[oaicite:20]{index=20}

---

## 5) ChatGPT Connector creation shows “Unsafe URL”
**Symptom**: Connector creation fails for `http://localhost...` with **Unsafe URL**.  
**Cause**: ChatGPT requires a **public HTTPS** MCP endpoint.  
**Fix**: Tunnel the local server (e.g., **ngrok** / **cloudflared**) and use the HTTPS URL, e.g., `https://abc123.ngrok-free.app/mcp?token=...`.  
**Ref**: “Connect from ChatGPT” guide (Apps SDK). :contentReference[oaicite:21]{index=21}

---

## Quick sanity commands (PowerShell, no jq)
**Health**  
`Invoke‑RestMethod -Uri "http://localhost:10000/health" | ConvertTo‑Json -Depth 5`

**Tools list (REST)**  
`$h = @{ 'X‑Bridge‑Token' = '<TOKEN>' }`  
`Invoke‑RestMethod -Uri "http://localhost:10000/tools/list" -Headers $h | ConvertTo‑Json -Depth 5`

**Search**  
`Invoke‑RestMethod -Method Post -Uri "http://localhost:10000/tools/call" -Headers $h -Body (@{name='drive.search'; arguments=@{ query="title contains 'X' and trashed = false"; limit=10 }} | ConvertTo‑Json -Depth 5) -ContentType "application/json"`
