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
