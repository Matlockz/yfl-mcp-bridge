# Bridge_Sanity — 2025‑10‑16

## Endpoints checked
- Node/Express:
  - GET /health → {"ok":true,"gas":true,ts:...}  ✅
  - HEAD /mcp → 204  ✅
  - GET /mcp → {"ok":true,"transport":"streamable-http"}  ✅
  - POST /mcp initialize → JSON-RPC 2.0 { jsonrpc:"2.0", id, result }  ✅
  - POST /mcp tools/list → result.tools[3], annotations.readOnlyHint:true  ✅
  - POST /mcp tools/call ("drive.search","drive.get") → ok  ✅

- GAS (Apps Script Web App):
  - GET .../exec?action=health&token=*** → JSON via ContentService  ✅ (server-side verified)
  - Uses one redirect to script.googleusercontent.com (client must follow)  📎

## Sample outputs (redacted)
- /health:
  ```json
  {"ok":true,"gas":true,"ts":"2025-10-16T23:11:58.137Z"}

tools/list:

{"jsonrpc":"2.0","id":"2","result":{"tools":[
  {"name":"drive.search","annotations":{"readOnlyHint":true}}, ...
]}}


drive.search (q: title contains "ChatGPT_Transcript_Quill_LoganBot_" and trashed=false, limit=5) → items[...]

drive.get (id: <from search>) → metadata + content (for small text)

Risks / Notes

Public URL is ngrok; keep window alive or swap to a persistent HTTPS later.

If GAS returns HTML, ensure deployment access and ContentService JSON; client should follow one redirect.

Vendor basis

JSON-RPC 2.0: response must include jsonrpc:"2.0", id, and either result or error.

Apps Script ContentService JSON + one redirect to script.googleusercontent.com; doGet(e).parameters for query.

Express behind proxies: trust proxy reflects X-Forwarded-Proto so URLs are https behind ngrok.

(See: jsonrpc.org; Apps Script Content Service & Web Apps; Express “behind proxies”.)


*(Citations: JSON‑RPC 2.0: :contentReference[oaicite:6]{index=6} · ContentService JSON/redirect: :contentReference[oaicite:7]{index=7} · Express trust proxy: :contentReference[oaicite:8]{index=8})*

---

### 3) Runbook_Recon__2025‑10‑16.md

```md
# Runbook Recon — 2025‑10‑16

## Smoke Test (PowerShell)
- PASS: GAS health (server-side) via /health → gas:true
- PASS: /mcp HEAD/GET probes
- PASS: initialize (JSON-RPC 2.0 shape)
- PASS: tools/list
- PASS: tools/call (drive.search → drive.get)
- NOTE: Local "GAS health" direct call failed only due to a malformed $GAS string in the script. Fixed by using a formatted string in smoke.ps1 (v2).

## Minimal diffs (if you adopt)
- Replace existing smoke script with `smoke.ps1 (v2)` above.
- (Optional) Enhance /health to include build:
  - Current: `{ ok, gas, ts }`
  - Suggested: `{ ok, gas, ts, version:"3.1.0" }`

## How to re-run exactly
1. `npm start`
2. `ngrok http --domain=triennially-superwise-lilla.ngrok-free.dev 10000`
3. `Set-ExecutionPolicy -Scope Process Bypass -Force`
4. `.\smoke.ps1`

## References
- JSON-RPC 2.0 response rules.  
- Apps Script ContentService JSON + doGet(e).parameters and web app deployment levels (ANYONE / ANYONE_ANONYMOUS).  
- Express trust proxy (https URLs behind a proxy).  

(See vendor docs in Bridge_Sanity file.)
