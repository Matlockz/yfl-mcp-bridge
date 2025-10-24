param(
  [Parameter(Mandatory=$true)][string]$Base,   # e.g., https://bridge.yflbridge.work
  [Parameter(Mandatory=$true)][string]$Token
)

function Invoke-JsonGet($Url, $Headers) {
  try { return Invoke-RestMethod -Method Get -Uri $Url -Headers $Headers -ErrorAction Stop } catch { return $null }
}
function Invoke-JsonPost($Url, $Body, $Headers) {
  try { return Invoke-RestMethod -Method Post -Uri $Url -Headers $Headers -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 20) -ErrorAction Stop } catch { return $null }
}

Write-Host "» Smoke: $Base"
$Headers = @{ "x-bridge-token" = $Token }

# Health, local & tunnel
$local  = Invoke-JsonGet "http://127.0.0.1:5050/health" $Headers
$tunnel = Invoke-JsonGet "$Base/health" $Headers
Write-Host "Local  /health : " ($local  | ConvertTo-Json -Depth 6)
Write-Host "Tunnel /health : " ($tunnel | ConvertTo-Json -Depth 6)

# MCP probes
try {
  $resp = Invoke-WebRequest -Method Head -Uri "$Base/mcp?token=$Token" -ErrorAction Stop
  Write-Host "HEAD /mcp : " (@{ Status = [int]$resp.StatusCode } | ConvertTo-Json)
} catch { Write-Host "HEAD /mcp : " (@{ Status = 0 } | ConvertTo-Json) }

$probe = Invoke-JsonGet "$Base/mcp?token=$Token" $Headers
Write-Host "GET  /mcp : " ($probe | ConvertTo-Json -Depth 6)

# initialize
$initBody = [ordered]@{
  jsonrpc = "2.0"
  id      = ([Guid]::NewGuid()).ToString("N")
  method  = "initialize"
  params  = @{}
}
$init = Invoke-JsonPost "$Base/mcp?token=$Token" $initBody $Headers
Write-Host "initialize : " ($init | ConvertTo-Json -Depth 6)
if ($init -and $init.result -and $init.result.serverInfo) { Write-Host  "serverInfo : " ($init.result.serverInfo | ConvertTo-Json) }

# tools/list
$toolsListBody = @{
  jsonrpc = "2.0"
  id      = ([Guid]::NewGuid()).ToString("N")
  method  = "tools/list"
  params  = @{}
}
$toolsList = Invoke-JsonPost "$Base/mcp?token=$Token" $toolsListBody $Headers
Write-Host "tools/list : " ($toolsList | ConvertTo-Json -Depth 6)

# tools/call: drive.search (v2 title/trashed=false)
$callBody = @{
  jsonrpc = "2.0"
  id      = ([Guid]::NewGuid()).ToString("N")
  method  = "tools/call"
  params  = @{
    name = "drive.search"
    arguments = @{ q = 'title contains "Transcripts__INDEX__LATEST" and trashed=false'; pageSize = 5 }
  }
}
$search = Invoke-JsonPost "$Base/mcp?token=$Token" $callBody $Headers
Write-Host "drive.search : " ($search | ConvertTo-Json -Depth 6)
