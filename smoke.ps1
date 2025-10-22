param(
  [Parameter(Mandatory=$true)][string]$Base,
  [Parameter(Mandatory=$true)][string]$Token
)

$ErrorActionPreference = "Stop"
function Write-Json($label, $obj) {
  $pretty = if ($obj -is [string]) { $obj } else { $obj | ConvertTo-Json -Depth 6 }
  Write-Host "$label : $pretty"
}

# Health (local and tunnel)
try {
  $local = Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:5050/health" -ErrorAction Stop
} catch { $local = $null }
Write-Json "Local  /health" $local

try {
  $tunnel = Invoke-RestMethod -Method Get -Uri "$Base/health" -ErrorAction Stop
} catch { $tunnel = $null }
Write-Json "Tunnel /health" $tunnel

# HEAD /mcp
try {
  $r = Invoke-WebRequest -Method Head -Uri "$Base/mcp?token=$Token" -ErrorAction Stop
  Write-Json "HEAD /mcp" @{ Status = [int]$r.StatusCode }
} catch {
  Write-Json "HEAD /mcp" @{ Status = 0; Error = $_.Exception.Message }
}

# GET /mcp
try {
  $getMcp = Invoke-RestMethod -Method Get -Uri "$Base/mcp?token=$Token" -ErrorAction Stop
} catch { $getMcp = $null }
Write-Json "GET  /mcp" $getMcp

# initialize
$initBody = [ordered]@{
  jsonrpc = "2.0"
  id      = ([Guid]::NewGuid()).ToString("N")
  method  = "initialize"
  params  = @{}
}
try {
  $init = Invoke-RestMethod -Method Post -Uri "$Base/mcp?token=$Token" -Body ($initBody | ConvertTo-Json) -ContentType "application/json"
} catch { $init = $null }
Write-Json "initialize" $init
if ($init -and -not $init.result.serverInfo) { Write-Warning "Missing serverInfo in initialize → Inspector (Direct) may fail." }
if ($init -and $init.result.serverInfo) { Write-Json "serverInfo" $init.result.serverInfo }

# tools/list
$toolsListBody = @{
  jsonrpc = "2.0"
  id      = ([Guid]::NewGuid()).ToString("N")
  method  = "tools/list"
  params  = @{}
}
try {
  $toolsList = Invoke-RestMethod -Method Post -Uri "$Base/mcp?token=$Token" -Body ($toolsListBody | ConvertTo-Json) -ContentType "application/json"
} catch { $toolsList = $null }
Write-Json "tools/list" $toolsList
