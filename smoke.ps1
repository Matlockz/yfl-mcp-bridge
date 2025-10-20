# YFL Drive Bridge — Smoke (PowerShell 5/7)
$env:PORT = $env:PORT -as [int]; if (-not $env:PORT) { $env:PORT = 10000 }
$BRIDGE = "http://localhost:$($env:PORT)"
$GAS    = "$($env:GAS_BASE_URL)?action=health&token=$($env:GAS_KEY)"

Write-Host "== Bridge health ==" -ForegroundColor Cyan
try {
  $h = Invoke-RestMethod "$BRIDGE/health" -Method GET
  $h | ConvertTo-Json -Depth 4
} catch { Write-Warning $_ }

Write-Host "`n== GAS health ==" -ForegroundColor Cyan
try {
  $g = Invoke-RestMethod $GAS -Method GET
  $g | ConvertTo-Json -Depth 4
} catch { Write-Warning $_ }

Write-Host "`n== MCP initialize / tools/list ==" -ForegroundColor Cyan
$init = @{ jsonrpc="2.0"; id=1; method="initialize"; params=@{} } | ConvertTo-Json
Invoke-RestMethod "$BRIDGE/mcp" -Method Post -Body $init -ContentType "application/json"

$tl = @{ jsonrpc="2.0"; id=2; method="tools/list"; params=@{} } | ConvertTo-Json
Invoke-RestMethod "$BRIDGE/mcp" -Method Post -Body $tl -ContentType "application/json"

Write-Host "`n== drive.search sample ==" -ForegroundColor Cyan
$searchArgs = @{
  name = "drive.search"
  args = @{ query = 'title contains "ChatGPT_Transcript_Quill_LoganBot_" and trashed = false'; limit = 5 }
}
$tc = @{ jsonrpc="2.0"; id=3; method="tools/call"; params=$searchArgs } | ConvertTo-Json -Depth 6
Invoke-RestMethod "$BRIDGE/mcp" -Method Post -Body $tc -ContentType "application/json"

Write-Host "`nTip: Start a quick Cloudflare Tunnel for this port:"
Write-Host "     cloudflared tunnel --url http://localhost:$($env:PORT)" -ForegroundColor Yellow
