# smoke.ps1 — PS 5.1 compatible
$ErrorActionPreference = 'Stop'

# ---- CONFIG
$BASE  = "https://triennially-superwise-lilla.ngrok-free.dev"
$TOKEN = "v3c3NJQ4i94"
$GAS   = "https://script.google.com/macros/s/AKfycbzK3N03phivSJsZasvRmhPwYlaS4gFCnR-pvxUmUWZpihXJOaucg5Lw249lZA9vC5p0ZA/exec"
$MCP   = "$BASE/mcp?token=$TOKEN"

$H = @{
  "Content-Type"         = "application/json"
  "MCP-Protocol-Version" = "2024-11-05"
  "ngrok-skip-browser-warning" = "1"
}

Write-Host "`n— Echo —" -ForegroundColor Cyan
Write-Host ("GAS     = {0}" -f $GAS)
Write-Host ("MCP     = {0}" -f $MCP)

function Get-JsonResult($resp) {
  if ($resp -and $resp.result) {
    if ($resp.result.structuredContent) { return $resp.result.structuredContent }
    if ($resp.result.content -and $resp.result.content.Count -gt 0) {
      $c = $resp.result.content[0]
      if ($c.type -eq 'json' -and $c.json) { return $c.json }
    }
  }
  return $null
}

Write-Host "`n1) GAS health" -ForegroundColor Cyan
$gh = Invoke-RestMethod -Uri "$GAS?action=health&token=$TOKEN" -Headers @{ "ngrok-skip-browser-warning"="1" } -Method GET -MaximumRedirection 5
$gh

Write-Host "`n2) Bridge /health" -ForegroundColor Cyan
Invoke-RestMethod -Uri "$BASE/health" -Headers @{ "ngrok-skip-browser-warning"="1" } -Method GET

Write-Host "`n3) /mcp HEAD" -ForegroundColor Cyan
(Invoke-WebRequest -Uri "$MCP" -Method Head -Headers @{ "ngrok-skip-browser-warning"="1" }).StatusCode

Write-Host "`n4) /mcp GET" -ForegroundColor Cyan
Invoke-RestMethod -Uri "$MCP" -Method GET -Headers @{ "ngrok-skip-browser-warning"="1" }

Write-Host "`n5) initialize (JSON-RPC)" -ForegroundColor Cyan
$init = Invoke-RestMethod -Uri "$MCP" -Method Post -Headers $H -Body '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocolVersion":"2024-11-05"}}'
$init

Write-Host "`n6) tools/list" -ForegroundColor Cyan
$toolsResp = Invoke-RestMethod -Uri "$MCP" -Method Post -Headers $H -Body '{"jsonrpc":"2.0","id":"2","method":"tools/list"}'
$tools = Get-JsonResult $toolsResp
if ($tools -and $tools.tools) {
  $tools.tools | ForEach-Object { $_.name } | Sort-Object | Format-Table -HideTableHeaders
} else { $toolsResp | ConvertTo-Json -Depth 6 }

Write-Host "`n7) drive.search" -ForegroundColor Cyan
$searchBody = @'
{"jsonrpc":"2.0","id":"3","method":"tools/call",
 "params":{"name":"drive.search",
          "arguments":{"query":"title contains \"ChatGPT_Transcript_Quill_LoganBot_\" and trashed = false","limit":5}}}
'@
$searchResp = Invoke-RestMethod -Uri "$MCP" -Method Post -Headers $H -Body $searchBody
$search = Get-JsonResult $searchResp
$first = $null
if ($search -and $search.items -and $search.items.Count -gt 0) {
  $first = $search.items[0]
  Write-Host "  -> first hit: $($first.id)  $($first.name)"
} else {
  Write-Host "No files returned from search; adjust query." -ForegroundColor Yellow
}

if ($first) {
  Write-Host "`n8) drive.get (id=$($first.id))" -ForegroundColor Cyan
  $getBody = '{"jsonrpc":"2.0","id":"4","method":"tools/call","params":{"name":"drive.get","arguments":{"id":"' + $first.id + '"}}}'
  $getResp = Invoke-RestMethod -Uri "$MCP" -Method Post -Headers $H -Body $getBody
  $get = Get-JsonResult $getResp
  [pscustomobject]@{
    id    = $get.item.id
    name  = $get.item.name
    mime  = $get.item.mimeType
    mtime = $get.item.modifiedTime
  } | Format-List

  Write-Host "`n9) drive.export (Docs->text/plain | Sheets->text/csv)" -ForegroundColor Cyan
  $expBody = '{"jsonrpc":"2.0","id":"5","method":"tools/call","params":{"name":"drive.export","arguments":{"id":"' + $first.id + '"}}}'
  $expResp = Invoke-RestMethod -Uri "$MCP" -Method Post -Headers $H -Body $expBody
  $exp = Get-JsonResult $expResp
  if ($exp -and $exp.item) {
    $txt = $null
    if ($exp.item.text) { $txt = [string]$exp.item.text }
    [pscustomobject]@{
      ok   = $exp.ok
      id   = $exp.item.id
      mime = $exp.item.mime
      size = $exp.item.size
      text = if ($txt) { if ($txt.Length -gt 160) { $txt.Substring(0,160) } else { $txt } } else { "" }
    } | Format-List
  } else {
    $expResp | ConvertTo-Json -Depth 8
  }
}
