param(
  [Parameter(Mandatory = $true)][string]$Base,
  [Parameter(Mandatory = $true)][string]$Token,
  [bool]$DoChunks = $false
)

$ErrorActionPreference = 'Stop'
Write-Host "[Start] Dive 6b verification"

# ---- wire up JSON‑RPC over your TryCloudflare endpoint ----
$H   = @{ 'Content-Type' = 'application/json'; 'MCP-Protocol-Version' = '2024-11-05' }
$mcp = "$Base/mcp?token=$Token"

function RpcRaw([string]$method, [hashtable]$params) {
  $body = @{ jsonrpc = '2.0'; id = [string](Get-Random); method = $method }
  if ($params) { $body.params = $params }
  $json = $body | ConvertTo-Json -Depth 15
  return Invoke-RestMethod -Uri $mcp -Method Post -Headers $H -Body $json
}
function FromResult($r) { if ($r.result) { $r = $r.result }; return $r }

# ---- tools gate (drive.search, drive.get, drive.export must exist) ----
function GetToolNames {
  $tl = RpcRaw 'tools/list' @{}
  $o  = FromResult $tl
  $names = @()
  if ($o.tools) {
    foreach ($t in $o.tools) { $names += ($t.name ?? [string]$t) }
  }
  return $names
}
$names = GetToolNames
foreach ($need in @('drive.search','drive.get','drive.export')) {
  if (-not ($names -contains $need)) { throw "Missing required tool: $need (have: $($names -join ', '))" }
}

# ---- helpers to read the different response shapes we see ----
function ItemsOf($r) {
  $o = FromResult $r
  if ($o.structuredContent -and $o.structuredContent.items) { return $o.structuredContent.items }
  if ($o.items)                                             { return $o.items }
  return @()
}
function ItemText($r) {
  $o = FromResult $r
  if ($o.structuredContent -and $o.structuredContent.item) {
    $it = $o.structuredContent.item
    if ($it.text)        { return [string]$it.text }
    if ($it.'text/plain'){ return [string]$it.'text/plain' }
  }
  if ($o.content) {
    $first = $o.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1
    if ($first) { return [string]$first.text }
  }
  return $null
}

# ---- find the two beacons; fall back to newest dated snapshot if LATEST missing ----
function FindCsvId([string]$latestName, [string]$prefix) {
  $a1 = RpcRaw 'tools/call' @{ name='drive.search'; arguments=@{ query="title = '$latestName' and trashed = false"; limit=1 } }
  $i1 = ItemsOf $a1
  if ($i1.Count -gt 0) { return [pscustomobject]@{ id=$i1[0].id; name=$i1[0].name; warning=$null } }

  $a2 = RpcRaw 'tools/call' @{ name='drive.search'; arguments=@{ query="title contains '$prefix' and trashed = false"; limit=50 } }
  $i2 = ItemsOf $a2
  if ($i2.Count -eq 0) { return $null }
  $best = $i2 | Sort-Object { Get-Date $_.modifiedDate } -Descending | Select-Object -First 1
  [pscustomobject]@{
    id = $best.id
    name = $best.name
    warning = ("WARNING: {0} not found — fell back to {1}" -f $latestName, $best.name)
  }
}

$idxSel = FindCsvId 'Transcripts__INDEX__LATEST.csv'  'Transcripts__INDEX__'
$chkSel = FindCsvId 'Transcripts__CHUNKS__LATEST.csv' 'Transcripts__CHUNKS__'

$warnings = @()
if ($idxSel -and $idxSel.warning) { $warnings += $idxSel.warning }
if ($chkSel -and $chkSel.warning) { $warnings += $chkSel.warning }
if (-not $idxSel)                 { $warnings += "WARNING: INDEX__LATEST not found" }
if ($DoChunks -and -not $chkSel)  { $warnings += "WARNING: CHUNKS__LATEST not found" }

# ---- export and parse INDEX ----
$idxText = $null
if ($idxSel) {
  $idxExp  = RpcRaw 'tools/call' @{ name='drive.export'; arguments=@{ id=$idxSel.id } }
  $idxText = ItemText $idxExp
}
if ([string]::IsNullOrWhiteSpace($idxText)) {
  # nothing to verify — emit a minimal report and return
  $report = [pscustomobject]@{
    when       = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
    indexId    = (if ($idxSel) { $idxSel.id } else { '' })
    chunksId   = (if ($chkSel) { $chkSel.id } else { '' })
    top20Count = 0
    driftCount = 0
    driftRows  = @()
    chunkAudit = $DoChunks
    chunkRows  = @()
    warnings   = $warnings
  }
  $path = Join-Path (Get-Location) ("Dive6b_Report__" + (Get-Date -Format 'yyyyMMdd_HHmmss') + ".json")
  $report | ConvertTo-Json -Depth 12 | Out-File -Encoding UTF8 -FilePath $path
  Write-Host "* Dive 6b complete."
  if ($warnings.Count -gt 0) { Write-Host ("Warnings  : {0}" -f ($warnings -join ' | ')) }
  Write-Host ("Saved report -> {0}" -f $path)
  exit 0
}

# ensure we feed a *string* to ConvertFrom-Csv (prevents “text/plain already present”)
$idxText = [string]$idxText
$index   = $idxText | ConvertFrom-Csv
$top20   = $index | Select-Object -First 20

# ---- robust ISO time comparison (ignore ms/offset jitter) ----
function ParseIso($s) {
  if (-not $s) { return $null }
  try   { return [DateTimeOffset]::Parse($s) }
  catch { try { return (Get-Date $s) } catch { return $null } }
}
function ModTimesEqual($a, $b, [double]$slackSeconds = 1.0) {
  $da = ParseIso $a; $db = ParseIso $b
  if (-not $da -or -not $db) { return $false }
  [Math]::Abs(($da - $db).TotalSeconds) -le $slackSeconds
}

# ---- cross‑check top‑20 with live Drive v3 ----
$drifts = New-Object System.Collections.Generic.List[object]
foreach ($row in $top20) {
  $g  = RpcRaw 'tools/call' @{ name='drive.get'; arguments=@{ id=$row.id } }
  $go = FromResult $g
  if ($go.structuredContent -and $go.structuredContent.item) { $go = $go.structuredContent.item }

  $csvName = $row.title
  $csvMime = $row.mimeType
  $csvMod  = $row.modifiedDate       # v2 field from your indexer
  $csvSize = $row.fileSize

  $liveName = $go.name
  $liveMime = $go.mimeType
  $liveMod  = $go.modifiedTime       # v3 field
  $liveSize = $go.size ?? $go.fileSize

  if ($csvName -ne $liveName) { $drifts.Add([pscustomobject]@{id=$row.id; field='name';     csv=$csvName; live=$liveName}) }
  if ($csvMime -ne $liveMime) { $drifts.Add([pscustomobject]@{id=$row.id; field='mime';     csv=$csvMime; live=$liveMime}) }
  if (-not (ModTimesEqual $csvMod $liveMod)) {
    $drifts.Add([pscustomobject]@{id=$row.id; field='modified'; csv=$csvMod; live=$liveMod})
  }
  if ("$csvSize" -ne "$liveSize")    { $drifts.Add([pscustomobject]@{id=$row.id; field='size';      csv="$csvSize"; live="$liveSize"}) }
}

# ---- newline‑aware recalc for 6000/400 chunk audit ----
function ChunkMeta([string]$text, [int]$window = 6000, [int]$overlap = 400) {
  $out  = @()
  $pos  = 0
  $step = [Math]::Max(1, $window - $overlap)
  while ($pos -lt $text.Length) {
    $end   = [Math]::Min($text.Length, $pos + $window)
    $slice = $text.Substring($pos, $end - $pos)
    $nl = $slice.LastIndexOf("`n")
    if ($nl -ge 0 -and ($slice.Length - $nl) -le 500) {
      $slice = $slice.Substring(0, $nl + 1)
      $end   = $pos + $slice.Length
    }
    $out += [pscustomobject]@{ start = $pos; end = $end; len = $slice.Length }
    if ($end -eq $text.Length) { break }
    $pos = [Math]::Min($text.Length, $pos + $step)
  }
  return $out
}

$chunkRows = @()
if ($DoChunks -and $chkSel) {
  $chkExp   = RpcRaw 'tools/call' @{ name='drive.export'; arguments=@{ id=$chkSel.id } }
  $chkText  = ItemText $chkExp
  $chunksCsv = $chkText | ConvertFrom-Csv

  # check the first file listed (most rows) — take 5 samples
  $firstId = ($chunksCsv | Group-Object id | Sort-Object Count -Descending | Select-Object -First 1).Name
  if ($firstId) {
    $sample = $chunksCsv | Where-Object { $_.id -eq $firstId } | Sort-Object {[int]$_.chunkIndex} | Select-Object -First 5
    $e    = RpcRaw 'tools/call' @{ name='drive.export'; arguments=@{ id=$firstId } }
    $text = ItemText $e
    $calc = ChunkMeta $text 6000 400 | Select-Object -First $sample.Count

    for ($i = 0; $i -lt $sample.Count; $i++) {
      $csv = $sample[$i]; $c = $calc[$i]
      $ok  = ([int]$csv.start -eq $c.start) -and ([int]$csv.end -eq $c.end) -and ([int]$csv.length -eq $c.len)
      $chunkRows += [pscustomobject]@{
        id=$firstId; idx=$i+1; ok=$ok;
        csv_idx=[int]$csv.chunkIndex; csv_start=[int]$csv.start; csv_end=[int]$csv.end; csv_len=[int]$csv.length;
        calc_start=$c.start;          calc_end=$c.end;          calc_len=$c.len
      }
    }
  }
}

# ---- report ----
$report = [pscustomobject]@{
  when        = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
  indexId     = (if ($idxSel) { $idxSel.id } else { '' })
  chunksId    = (if ($chkSel) { $chkSel.id } else { '' })
  top20Count  = $top20.Count
  driftCount  = $drifts.Count
  driftRows   = $drifts
  chunkAudit  = $DoChunks
  chunkRows   = $chunkRows
  warnings    = $warnings
}
$path = Join-Path (Get-Location) ("Dive6b_Report__" + (Get-Date -Format 'yyyyMMdd_HHmmss') + ".json")
$report | ConvertTo-Json -Depth 12 | Out-File -Encoding UTF8 -FilePath $path

Write-Host "* Dive 6b complete."
Write-Host ("Drift rows : {0}" -f $drifts.Count)
if ($DoChunks) { Write-Host ("Chunk rows : {0}" -f $chunkRows.Count) }
if ($warnings.Count -gt 0) { Write-Host ("Warnings  : {0}" -f ($warnings -join " | ")) }
Write-Host ("Saved report -> {0}" -f $path)
