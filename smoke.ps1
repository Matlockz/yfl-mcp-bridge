param(
  [Parameter(Mandatory=$true)][string]$Base,   # e.g., https://documents-gage-london-gerald.trycloudflare.com
  [string]$Token = "v3c3NJQ4i94"
)

$ErrorActionPreference = "Stop"
$H = @{
  "Content-Type" = "application/json"
  "MCP-Protocol-Version" = "2024-11-05"
}

Write-Host "`n— Smoke: $Base —`n"

# 0) Local origin check (helps explain 1033 quickly)
try {
  $local = Invoke-RestMethod "http://127.0.0.1:10000/health" -Method Get -TimeoutSec 5
  Write-Host "Local /health:" ($local | ConvertTo-Json -Compress)
} catch {
  Write-Warning "Local bridge not responding on 127.0.0.1:10000. Start 'npm start' first."
  throw
}

# 1) Tunnel health (no token required)
try {
  $h = Invoke-RestMethod "$Base/health" -Method Get -TimeoutSec 10
  Write-Host "Tunnel /health:" ($h | ConvertTo-Json -Compress)
} catch {
  Write-Warning "Tunnel /health failed. If it's 1033, confirm you used the CURRENT printed URL and wait ~10s."
  throw
}

# 2) MCP handshake + tools/list
$mcp = "$Base/mcp?token=$Token"

$init = Invoke-RestMethod $mcp -Method Post -Headers $H -Body '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocolVersion":"2024-11-05"}}'
Write-Host "initialize:" ($init | ConvertTo-Json -Compress)

$tools = Invoke-RestMethod $mcp -Method Post -Headers $H -Body '{"jsonrpc":"2.0","id":"2","method":"tools/list"}'
Write-Host "tools/list:" ($tools | ConvertTo-Json -Compress)
