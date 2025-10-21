param(
  [string]$Base = "http://localhost:5050",
  [string]$Token = ""
)

$Depth = 12

function Write-Json {
  param([string]$Label, $Obj)
  if ($null -eq $Obj) { Write-Host "$Label : <null>"; return }
  try {
    Write-Host "$Label : " + ($Obj | ConvertTo-Json -Depth $Depth)
  } catch {
    Write-Host "$Label : [unserializable] $_"
  }
}

function Invoke-JsonGet {
  param([string]$Url, [string]$Token)
  $Headers = @{}
  if ($Token) { $Headers['x-bridge-token'] = $Token }
  Invoke-RestMethod -Method Get -Uri $Url -Headers $Headers -ErrorAction Stop
}

function Invoke-JsonPost {
  param([string]$Url, $Body, [string]$Token)
  $Headers = @{}
  if ($Token) { $Headers['x-bridge-token'] = $Token }
  $json = $Body | ConvertTo-Json -Depth $Depth
  Invoke-RestMethod -Method Post -Uri $Url -Headers $Headers -ContentType 'application/json' -Body $json -ErrorAction Stop
}

function Test-Head {
  param([string]$Url, [string]$Token)
  $Headers = @{}
  if ($Token) { $Headers['x-bridge-token'] = $Token }
  try {
    $resp = Invoke-WebRequest -Method Head -Uri $Url -Headers $Headers -ErrorAction Stop
    return @{ Status = $resp.StatusCode }
  } catch {
    try { return @{ Status = $_.Exception.Response.StatusCode.Value__ } }
    catch { return @{ Status = -1; Error = $_.Exception.Message } }
  }
}

Write-Host "» Smoke: $Base"

# health (local + tunnel)
$localHealth  = Invoke-JsonGet "http://localhost:5050/health" $Token
Write-Json "Local  /health"  $localHealth

$tunnelHealth = Invoke-JsonGet "$Base/health" $Token
Write-Json "Tunnel /health" $tunnelHealth

# HEAD /mcp and GET /mcp
$head = Test-Head "$Base/mcp?token=$Token" $Token
Write-Json "HEAD /mcp" $head

$get = Invoke-JsonGet "$Base/mcp?token=$Token" $null
Write-Json "GET  /mcp" $get

# initialize (JSON-RPC 2.0)
$initBody = [ordered]@{
  jsonrpc = "2.0"
  id      = ([Guid]::NewGuid()).ToString("N")
  method  = "initialize"
  params  = [ordered]@{
    protocolVersion = "2024-11-05"
    capabilities    = @{}
    clientInfo      = @{ name = "Smoke"; version = "1.0.0" }
  }
}
$init = Invoke-JsonPost "$Base/mcp?token=$Token" $initBody $null
Write-Json "initialize" $init
if (-not $init.result.serverInfo) {
  Write-Warning "Missing serverInfo in initialize → Inspector (Direct) may fail."
} else {
  Write-Json "serverInfo" $init.result.serverInfo
}

# tools/list
$toolsListBody = @{
  jsonrpc = "2.0"
  id      = ([Guid]::NewGuid()).ToString("N")
  method  = "tools/list"
  params  = @{}
}
$toolsList = Invoke-JsonPost "$Base/mcp?token=$Token" $toolsListBody $null
Write-Json "tools/list" $toolsList
