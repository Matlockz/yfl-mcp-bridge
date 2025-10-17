# smoke.ps1 (v2) — hardened URL echoing + the same gate checks

$BASE  = "https://triennially-superwise-lilla.ngrok-free.dev"
$TOKEN = "v3c3NJQ4i94"
$GAS   = "https://script.google.com/macros/s/AKfycbzK3N03phivSJsZasvRmhPwYlaS4gFCnR-pvxUmUWZpihXJOaucg5Lw249lZA9vC5p0ZA/exec"
$MCP   = "$BASE/mcp?token=$TOKEN"

# Construct GAS health URL robustly (avoids paste/encoding artifacts)
[string]$GAS_HEALTH = ("{0}?action=health&token={1}" -f $GAS, $TOKEN)

$H = @{
  "Content-Type"               = "application/json"
  "MCP-Protocol-Version"       = "2024-11-05"
  "ngrok-skip-browser-warning" = "1"
}

Write-Host "`n— Echo Targets —" -ForegroundColor DarkGray
$GAS_HEALTH
$MCP

Write-Host "`n1) GAS health" -ForegroundColor Cyan
irm $GAS_HEALTH -Headers @{ "ngrok-skip-browser-warning"="1" } -Method GET -MaximumRedirection 5

Write-Host "`n2) Bridge /health" -ForegroundColor Cyan
irm "$BASE/health" -Headers @{ "ngrok-skip-browser-warning"="1" } -Method GET

Write-Host "`n3) /mcp HEAD probe" -ForegroundColor Cyan
iwr "$MCP" -Method Head -Headers @{ "ngrok-skip-browser-warning"="1" } | Select-Object -ExpandProperty StatusCode

Write-Host "`n4) /mcp GET probe" -ForegroundColor Cyan
irm "$MCP" -Method GET -Headers @{ "ngrok-skip-browser-warning"="1" }

Write-Host "`n5) initialize (JSON-RPC)" -ForegroundColor Cyan
$init = irm "$MCP" -Method Post -Headers $H -Body '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocolVersion":"2024-11-05"}}'
$init

Write-Host "`n6) tools/list" -ForegroundColor Cyan
$tools = irm "$MCP" -Method Post -Headers $H -Body '{"jsonrpc":"2.0","id":"2","method":"tools/list"}'
$tools

Write-Host "`n7) tools/call drive.search (v2 query)" -ForegroundColor Cyan
$searchBody = @'
{"jsonrpc":"2.0","id":"3","method":"tools/call",
 "params":{"name":"drive.search",
           "arguments":{"query":"title contains \"ChatGPT_Transcript_Quill_LoganBot_\" and trashed = false","limit":5}}}
'@
$search = irm "$MCP" -Method Post -Headers $H -Body $searchBody
$search

$id = $search.result.structuredContent.items[0].id
if ($id) {
  Write-Host "`n8) tools/call drive.get (id=$id)" -ForegroundColor Cyan
  $getBody = '{"jsonrpc":"2.0","id":"4","method":"tools/call","params":{"name":"drive.get","arguments":{"id":"' + $id + '"}}}'
  $get = irm "$MCP" -Method Post -Headers $H -Body $getBody
  $get
} else {
  Write-Host "No files returned from search; adjust query." -ForegroundColor Yellow
}
