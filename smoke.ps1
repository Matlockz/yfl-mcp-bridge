# --- YFL Bridge smoke (PS 5/7) ---
$BASE  = "https://triennially-superwise-lilla.ngrok-free.dev"
$TOKEN = "v3c3NJQ4i94"
$GAS   = "https://script.google.com/macros/s/AKfycbzK3N03phivSJsZasvRmhPwYlaS4gFCnR-pvxUmUWZpihXJOaucg5Lw249lZA9vC5p0ZA/exec"
$MCP   = "$BASE/mcp?token=$TOKEN"

$H = @{
  "Content-Type"               = "application/json"
  "MCP-Protocol-Version"       = "2024-11-05"
  "ngrok-skip-browser-warning" = "1"
}

Write-Host "`n— Echo —" -ForegroundColor Cyan
Write-Host (" GAS  = " + $GAS)
Write-Host (" MCP  = " + $MCP)

# 1) GAS health (use explicit -Uri build to avoid paste artefacts)
$gasHealthUri = ($GAS + "?action=health&token=" + $TOKEN)
try {
  Write-Host "`n1) GAS health" -ForegroundColor Cyan
  $gh = Invoke-RestMethod -Uri $gasHealthUri -Headers @{ "ngrok-skip-browser-warning"="1" } -Method GET -MaximumRedirection 5
  $gh | Format-List
} catch { Write-Host $_.Exception.Message -ForegroundColor Yellow }

# 2) Bridge health
Write-Host "`n2) Bridge /health" -ForegroundColor Cyan
try {
  Invoke-RestMethod -Uri "$BASE/health" -Headers @{ "ngrok-skip-browser-warning"="1" } -Method GET | Format-List
} catch { Write-Host $_.Exception.Message -ForegroundColor Yellow }

# 3) /mcp HEAD
Write-Host "`n3) /mcp HEAD probe" -ForegroundColor Cyan
try {
  (Invoke-WebRequest -Uri $MCP -Method Head -Headers @{ "ngrok-skip-browser-warning"="1" }).StatusCode
} catch { Write-Host $_.Exception.Message -ForegroundColor Yellow }

# 4) /mcp GET
Write-Host "`n4) /mcp GET probe" -ForegroundColor Cyan
try {
  Invoke-RestMethod -Uri $MCP -Method GET -Headers @{ "ngrok-skip-browser-warning"="1" } | Format-List
} catch { Write-Host $_.Exception.Message -ForegroundColor Yellow }

# 5) initialize
Write-Host "`n5) initialize (JSON-RPC)" -ForegroundColor Cyan
$init = Invoke-RestMethod -Uri $MCP -Method Post -Headers $H -Body '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocolVersion":"2024-11-05"}}'
$init | ConvertTo-Json -Depth 8

# 6) tools/list
Write-Host "`n6) tools/list" -ForegroundColor Cyan
$tools = Invoke-RestMethod -Uri $MCP -Method Post -Headers $H -Body '{"jsonrpc":"2.0","id":"2","method":"tools/list"}'
$ok = $false; $names = @()
if ($tools -and $tools.result -and $tools.result.tools) {
  $ok = $true
  $names = ($tools.result.tools | ForEach-Object { $_.name }) -join ", "
}
[pscustomobject]@{ ok=$ok; tools=$names } | Format-List
# 7) drive.search
Write-Host "`n7) drive.search (v2 query)" -ForegroundColor Cyan
$searchBody = '{"jsonrpc":"2.0","id":"3","method":"tools/call","params":{"name":"drive.search","arguments":{"query":"title contains \"ChatGPT_Transcript_Quill_LoganBot_\" and trashed = false","limit":5}}}'
$search = Invoke-RestMethod -Uri $MCP -Method Post -Headers $H -Body $searchBody
$firstId = $null
if ($search -and $search.result -and $search.result.structuredContent -and $search.result.structuredContent.items) {
  $items = $search.result.structuredContent.items
  $items | Select-Object id,name,mimeType | Format-Table -AutoSize
  if ($items.Length -ge 1) { $firstId = $items[0].id }
} else {
  Write-Host "No results." -ForegroundColor Yellow
}

# 8) drive.get
if ($firstId) {
  Write-Host "`n8) drive.get (id=$firstId)" -ForegroundColor Cyan
  $getBody = '{"jsonrpc":"2.0","id":"4","method":"tools/call","params":{"name":"drive.get","arguments":{"id":"' + $firstId + '"}}}'
  $get = Invoke-RestMethod -Uri $MCP -Method Post -Headers $H -Body $getBody
  $item = $get.result.structuredContent.item
  $item | Select-Object id,name,mimeType,size,modifiedTime,webViewLink,webContentLink | Format-List

  # 9) drive.export
  Write-Host "`n9) drive.export (Docs→text/plain | Sheets→text/csv)" -ForegroundColor Cyan
  $expBody = '{"jsonrpc":"2.0","id":"5","method":"tools/call","params":{"name":"drive.export","arguments":{"id":"' + $firstId + '"}}}'
  $exp = Invoke-RestMethod -Uri $MCP -Method Post -Headers $H -Body $expBody
  if ($exp -and $exp.result -and $exp.result.structuredContent -and $exp.result.structuredContent.item) {
    $ei = $exp.result.structuredContent.item
    [pscustomobject]@{
      ok   = $exp.result.structuredContent.ok
      id   = $ei.id
      mime = $ei.mime
      size = $ei.size
      text = (if ($ei.text) { [string]$ei.text.Substring(0, [Math]::Min(160, $ei.text.Length)) } else { "" })
    } | Format-List
  } else {
    Write-Host "No export payload returned." -ForegroundColor Yellow
  }
}
