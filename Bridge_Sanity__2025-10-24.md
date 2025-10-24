# Bridge_Sanity__2025-10-24.md

System Under Test: **YFL Drive Bridge** (Node)  
Version: **3.1.1n**  
Entrypoint: **server.mjs**  
Local Port: **5050**  
Public Host: **https://bridge.yflbridge.work**  
MCP URL: **https://bridge.yflbridge.work/mcp?token=v3c3NJQ4i94**  
Drive Dialect: **v2** (`title … and trashed=false`)

---

## Gates & Results

### 0) Health (Local & Tunnel)
- **Local**  
  ```powershell
  curl http://127.0.0.1:5050/health


→ {"ok":true,"gas":true,"version":"3.1.1n","ts":"<iso>"}

Tunnel

curl https://bridge.yflbridge.work/health


→ {"ok":true,"gas":true,"version":"3.1.1n","ts":"<iso>"}

Status: PASS (Apps Script reachable; "gas": true)

1) MCP handshake (HEAD / GET / JSON‑RPC)

HEAD

iwr -Method Head "https://bridge.yflbridge.work/mcp?token=v3c3NJQ4i94" | % StatusCode


→ 204

GET

irm "https://bridge.yflbridge.work/mcp?token=v3c3NJQ4i94"


→

{ "ok": true, "transport": "streamable-http" }


initialize

$init = @{jsonrpc="2.0";id="1";method="initialize";params=@{}} | ConvertTo-Json
irm "https://bridge.yflbridge.work/mcp?token=v3c3NJQ4i94" -Method Post -ContentType "application/json" -Body $init


→ result.serverInfo = { name: "YFL Drive Bridge", version: "3.1.1n" }

Status: PASS

2) tools/list
$tools = @{jsonrpc="2.0";id="2";method="tools/list";params=@{}} | ConvertTo-Json
irm "https://bridge.yflbridge.work/mcp?token=v3c3NJQ4i94" -Method Post -ContentType "application/json" -Body $tools


→ Tools present: drive.list, drive.search, drive.get, drive.export

Status: PASS

3) tools/call → drive.search (v2 grammar)
$body = @{
  jsonrpc="2.0"; id="3"; method="tools/call"; params=@{
    name="drive.search"
    arguments=@{ q = "title contains 'Transcripts__INDEX__LATEST' and trashed=false"; pageSize = 5 }
  }
} | ConvertTo-Json -Depth 5
irm "https://bridge.yflbridge.work/mcp?token=v3c3NJQ4i94" -Method Post -ContentType "application/json" -Body $body


→ result.content[0].object.ok = true and items includes Transcripts__INDEX__LATEST.csv (several versions).

Status: PASS

4) tools/call → drive.export (text/plain)

Export of a textual Drive file (Google Doc or .txt) to verify data plane.

$exp = @{
  jsonrpc="2.0"; id="4"; method="tools/call"; params=@{
    name="drive.export"
    arguments=@{ id = "<SOME_TEXTUAL_FILE_ID>"; mime = "text/plain" }
  }
} | ConvertTo-Json -Depth 5
irm "https://bridge.yflbridge.work/mcp?token=v3c3NJQ4i94" -Method Post -ContentType "application/json" -Body $exp


→ result.ok=true, with mime="text/plain", a positive size, and non‑empty text sample.

Status: PASS

5) CORS preflight (Inspector origin)
Invoke-WebRequest -Method Options `
  -Uri "https://bridge.yflbridge.work/mcp" `
  -Headers @{
    origin='http://localhost:6274'
    'access-control-request-method'='POST'
    'access-control-request-headers'='x-custom-auth-headers,x-bridge-token,content-type'
  } | Select-Object StatusCode, Headers


→ 204 with Access-Control-Allow-Headers echoing the requested headers.

Status: PASS

Decisions

Drive API grammar: Pin to v2 (title … and trashed=false).

Public surface: Keep /health public; /mcp* currently token‑gated without Access login. Optionally require Google SSO later.

Entrypoint: Use server.mjs (package.json start aligned).

Next Gate: DIVE 3c (EMIT) — beacon‑aligned re‑index + CHUNKS verification.

Notes & References

Cloudflare Access application paths and Bypass behavior (policy order matters).

Cloudflare named tunnels & DNS to <UUID>.cfargotunnel.com for stable custom hostnames.

MCP Streamable HTTP handshake sequence.

Apps Script Advanced Drive (v2) semantics; v2 vs v3 differences for title/name.

CORS preflight shape (Origin + Access‑Control‑Request‑*; 200/204 acceptable).
