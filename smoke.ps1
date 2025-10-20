param(
  [Parameter(Mandatory=$true)][string]$Base,
  [Parameter(Mandatory=$true)][string]$Token
)

$ErrorActionPreference = 'Stop'
Write-Host "» Smoke: $Base" -ForegroundColor Cyan

# Health (local + tunnel)
try { $local  = Invoke-RestMethod -Uri "http://127.0.0.1:10000/health" -TimeoutSec 5 } catch { $local = @{ ok=$false; err=$_|Out-String } }
try { $tunnel = Invoke-RestMethod -Uri "$Base/health"             -TimeoutSec 5 } catch { $tunnel = @{ ok=$false; err=$_|Out-String } }
"Local  /health : $($local  | ConvertTo-Json -Compress)"
"Tunnel /health : $($tunnel | ConvertTo-Json -Compress)"

# MCP handshake + tools/list + one search
$H = @{ 'Content-Type'='application/json'; 'MCP-Protocol-Version'='2024-11-05' }
$MCP = "$Base/mcp?token=$Token"

function Rpc($method, $params) {
  $body = @{ jsonrpc='2.0'; id=[Guid]::NewGuid().ToString('N'); method=$method; params=$params } | ConvertTo-Json -Depth 10
  return (Invoke-RestMethod -Uri $MCP -Method Post -Headers $H -Body $body)
}

$init  = Rpc 'initialize' @{ protocolVersion='2024-11-05' }
"initialize : $($init  | ConvertTo-Json -Compress)"

$list  = Rpc 'tools/list' @{}
"tools/list : $($list  | ConvertTo-Json -Compress)"

$srch  = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query="title contains 'ChatGPT_Transcript_Quill_LoganBot_' and trashed = false"; limit=1 } }
"drive.search : $($srch | ConvertTo-Json -Compress)"
