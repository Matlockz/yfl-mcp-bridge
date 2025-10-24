param(
  [Parameter(Mandatory=$true)][string]$Base,   # https://bridge.yflbridge.work
  [Parameter(Mandatory=$true)][string]$Token   # v3c3NJQ4i94
)

$H = @{ "x-bridge-token" = $Token }

Write-Host "== Smoke on $Base =="

function J($o) { if ($null -eq $o) { return "{}" } return ($o | ConvertTo-Json -Depth 4 -Compress) }

# Health (public + local fallback)
try { $h = Invoke-RestMethod "$Base/health" -TimeoutSec 10 } catch { $h = $null }
Write-Host "health:" (J $h)

# MCP probes
try { $r = Invoke-WebRequest -Method Head "$Base/mcp?token=$Token" -TimeoutSec 10 -ErrorAction Stop
      Write-Host "HEAD /mcp :" "{`"status`": $([int]$r.StatusCode) }"
} catch { Write-Host "HEAD /mcp :" "{`"status`": 0 }" }

try { $g = Invoke-RestMethod "$Base/mcp?token=$Token" -Headers $H -TimeoutSec 10 } catch { $g = $null }
Write-Host "GET  /mcp :" (J $g)

# initialize → tools/list
$init = @{ jsonrpc="2.0"; id=[guid]::NewGuid().ToString("N"); method="initialize"; params=@{} }
try { $i = Invoke-RestMethod "$Base/mcp?token=$Token" -Method Post -ContentType "application/json" -Body ($init|ConvertTo-Json -Depth 20) -TimeoutSec 15 } catch { $i = $null }
Write-Host "initialize:" (J $i)

$tl = @{ jsonrpc="2.0"; id=[guid]::NewGuid().ToString("N"); method="tools/list"; params=@{} }
try { $t = Invoke-RestMethod "$Base/mcp?token=$Token" -Method Post -ContentType "application/json" -Body ($tl|ConvertTo-Json -Depth 20) -TimeoutSec 15 } catch { $t = $null }
$names = ($t.result.tools | ForEach-Object { $_.name }) -join ", "
Write-Host "tools/list:" "names=" $names

# quick search for INDEX LATEST
$call = @{
  jsonrpc="2.0"; id=[guid]::NewGuid().ToString("N"); method="tools/call";
  params=@{ name="drive.search"; arguments=@{ q="title contains 'Transcripts__INDEX__LATEST' and trashed=false"; pageSize=5 } }
}
try { $s = Invoke-RestMethod "$Base/mcp?token=$Token" -Method Post -ContentType "application/json" -Body ($call|ConvertTo-Json -Depth 20) -TimeoutSec 20 } catch { $s = $null }
if ($s.result -and $s.result.content) {
  $items = $s.result.content[0].object.items
  Write-Host "drive.search:" "count=" $items.Count "; first.id=" $items[0].id "; first.title=" $items[0].title
} else {
  Write-Host "drive.search:" (J $s)
}
