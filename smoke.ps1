# smoke.ps1  — YFL Drive Bridge smoke for PowerShell 7
param(
  [Parameter(Mandatory = $true)] [string]$Base,
  [Parameter(Mandatory = $true)] [string]$Token
)

$ErrorActionPreference = "Stop"

function Write-Json([string]$label, $obj) {
  if ($null -eq $obj) { Write-Host ("{0} : <null>" -f $label); return }
  if ($obj -is [string]) { Write-Host ("{0} : {1}" -f $label, $obj); return }
  $json = $obj | ConvertTo-Json -Depth 9
  Write-Host ($label + " : " + $json)
}

function Invoke-JsonGet([string]$Url, [hashtable]$Headers) {
  try {
    return Invoke-RestMethod -Method Get -Uri $Url -Headers $Headers -ErrorAction Stop
  } catch {
    return $null
  }
}

function Invoke-Head([string]$Url, [hashtable]$Headers) {
  try {
    $r = Invoke-WebRequest -Method Head -Uri $Url -Headers $Headers -ErrorAction Stop
    return @{ Status = [int]$r.StatusCode }
  } catch {
    if ($_.Exception.Response) {
      return @{ Status = [int]$_.Exception.Response.StatusCode }
    }
    return @{ Status = -1; Error = $_.Exception.Message }
  }
}

function Invoke-JsonPost([string]$Url, [hashtable]$Headers, [hashtable]$Body) {
  try {
    $json = ($Body | ConvertTo-Json -Depth 9)
    return Invoke-RestMethod -Method Post -Uri $Url -Headers $Headers -ContentType "application/json" -Body $json -ErrorAction Stop
  } catch {
    return $null
  }
}

Write-Host "» Smoke: $Base"

# Local health (assumes bridge runs on 127.0.0.1:5050)
$local = Invoke-JsonGet "http://127.0.0.1:5050/health" @{}
Write-Json "Local  /health" $local

# Tunnel health
$headers = @{"x-bridge-token" = $Token }
$tunnel = Invoke-JsonGet "$Base/health" $headers
Write-Json "Tunnel /health" $tunnel

# HEAD /mcp (expect 204)
$head = Invoke-Head "$Base/mcp?token=$Token" @{}
Write-Json "HEAD /mcp" ($head | ConvertTo-Json)

# GET /mcp (expect {ok:true, transport:"streamable-http"})
$get = Invoke-JsonGet "$Base/mcp?token=$Token" @{}
Write-Json "GET  /mcp" $get

# initialize
$initBody = [ordered]@{
  jsonrpc = "2.0"
  id      = ([guid]::NewGuid().ToString("N"))
  method  = "initialize"
  params  = @{}
}
$init = Invoke-JsonPost "$Base/mcp?token=$Token" $headers $initBody
Write-Json "initialize" $init
if ($init -and -not $init.result.serverInfo) {
  Write-Warning "Missing serverInfo in initialize → Inspector (Direct) may fail."
} else {
  if ($init) { Write-Json "serverInfo" $init.result.serverInfo }
}

# tools/list
$toolsListBody = [ordered]@{
  jsonrpc = "2.0"
  id      = ([guid]::NewGuid().ToString("N"))
  method  = "tools/list"
  params  = @{}
}
$toolsList = Invoke-JsonPost "$Base/mcp?token=$Token" $headers $toolsListBody
Write-Json "tools/list" $toolsList
