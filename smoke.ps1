# smoke.ps1 — local quick probe (PowerShell 5/7)
$base = "http://localhost:10000"
Write-Host "GET /health" -ForegroundColor Cyan
irm "$base/health" -Method GET | ConvertTo-Json -Depth 5

Write-Host "HEAD /mcp" -ForegroundColor Cyan
try { iwr "$base/mcp" -Method Head | Out-Null; "204 HEAD ok" } catch { $_.Exception.Message }

Write-Host "GET /mcp" -ForegroundColor Cyan
irm "$base/mcp" -Method GET | ConvertTo-Json -Depth 5

# JSON-RPC initialize
$rpc = @{ jsonrpc="2.0"; id="1"; method="initialize"; params=@{} } | ConvertTo-Json
irm "$base/mcp" -Method POST -Body $rpc -ContentType "application/json" | ConvertTo-Json -Depth 10

# tools/list
$rpc2 = @{ jsonrpc="2.0"; id="2"; method="tools/list"; params=@{} } | ConvertTo-Json
irm "$base/mcp" -Method POST -Body $rpc2 -ContentType "application/json" | ConvertTo-Json -Depth 10

# tools/call (drive.search) — requires token & GAS
$token = $env:BRIDGE_TOKEN
$q = 'title contains "ChatGPT_Transcript_Quill_LoganBot_" and trashed = false'
$rpc3 = @{ jsonrpc="2.0"; id="3"; method="tools/call"; params=@{ name="drive.search"; arguments=@{ query=$q; limit=5 } } } | ConvertTo-Json
irm "$base/mcp?token=$token" -Method POST -Body $rpc3 -ContentType "application/json" | ConvertTo-Json -Depth 10
