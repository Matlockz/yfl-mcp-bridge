# YFL Drive Bridge — Known Issues & Fixes (living log)

_Last updated: 2025‑10‑16_

## 0) Where to start, every time
1. Open **Runbook** + **Smoke Test Checklist** in `/Your Friend Logan/ChatGPT_Assets/00_Admin/Start_Here/`.  
2. Run bridge health and MCP round‑trip exactly as written there.  
3. If anything fails, stop here and record the failure below before trying new changes. :contentReference[oaicite:25]{index=25}

---

## 1) GAS returns HTML or 302 (accounts.google.com) instead of JSON
**Symptom**: Logs show `GAS returned non‑JSON (302 text/html…)`.  
**Root cause**: Wrong deployment or calling path. Apps Script web apps must be called at the **/exec** URL and return JSON via **ContentService** from `doGet(e)`; request params are read from `e.parameter`.  
**Fix**:
- Confirm **Web app** deployment with **Execute as “Me”** and **Who has access “Anyone”**.  
- Call `/exec` with `?action=...&token=...` (avoid `/api/...` unless using legacy shims).  
**Refs**: Apps Script web apps + ContentService docs. :contentReference[oaicite:26]{index=26}

---

## 2) Token mismatch (“bad token” on /tools/* or /mcp)
**Symptom**: 401 `bad token`; missing `X‑Bridge‑Token` header or missing `?token=` on the MCP URL.  
**Fix**: Always pass **`X‑Bridge‑Token: <TOKEN>`** for REST calls and **append `?token=<TOKEN>`** on the MCP URL. Keep GAS’s `token` (for Apps Script) and the bridge’s token distinct (they can be the same string).

---

## 3) MCP Inspector won’t connect / tools list empty
**Symptom**: Connected with **STDIO** by mistake, or MCP URL missing `?token=`.  
**Fix**: Use **Streamable HTTP** and connect the UI to `http://localhost:<port>/mcp?token=<TOKEN>`; expect `tools/list` to return an array.  
**Refs**: MCP Inspector & transport docs. :contentReference[oaicite:27]{index=27}

---

## 4) Drive search/list quirks
**Symptom**: Queries with v3 `name` field don’t match; `drive.list` returned empty when a **file** id (ZIP) was used.  
**Fix**:  
- Use **v2** query terms for `DriveApp.searchFiles`, e.g., `title contains 'X' and trashed = false`.  
- For **drive.list**, pass a **folder id** or `folderPath`; use **drive.get** for file metadata.  
**Refs**: DriveApp (searchFiles) and Drive v3 reference. :contentReference[oaicite:28]{index=28}

---

## 5) ChatGPT Connector creation shows “Unsafe URL”
**Symptom**: Connector creation fails for `http://localhost...` (unsafe), or with 404 for an invalid public URL.  
**Root cause**: ChatGPT requires a **public HTTPS MCP endpoint**; localhost is not allowed.  
**Fix**: Expose the bridge via **ngrok** or **Cloudflare Tunnel** and use the resulting `https://.../mcp?token=...` URL.  
**Refs**: ChatGPT connectors (custom MCP require a remote server). :contentReference[oaicite:29]{index=29}

---

## 6) JSON‑RPC response shape
**Symptom**: Inspector/clients complain about invalid tool results.  
**Fix**: Ensure responses follow JSON‑RPC 2.0 (`{"jsonrpc":"2.0","id":...,"result":...}` or an `error` object).  
**Refs**: JSON‑RPC 2.0 spec. :contentReference[oaicite:30]{index=30}

---

### Recent timeline (2025‑10‑16)
- Fixed 302/HTML by using `/exec?action=...&token=...` and confirming **Web app** settings. :contentReference[oaicite:31]{index=31}  
- Inspector connected over **Streamable HTTP**; `tools/list` shows `drive.list`, `drive.search`, `drive.get`; calls succeed. :contentReference[oaicite:32]{index=32}  
- `drive.list` returned `[]` when given a **file** id; corrected to folder path/id. :contentReference[oaicite:33]{index=33}  
- ChatGPT Connector failed on `localhost` (“Unsafe URL”); plan to use **ngrok/Cloudflare** HTTPS URL. :contentReference[oaicite:34]{index=34}
