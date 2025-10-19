param(
  [Parameter(Mandatory = $true)][string]$Base,
  [Parameter(Mandatory = $true)][string]$Token,
  [switch]$DoChunks
)

$ErrorActionPreference = 'Stop'
Write-Host "[Start] Dive 6b verification"

# ---- MCP plumbing ------------------------------------------------------------
$H   = @{ 'Content-Type' = 'application/json'; 'MCP-Protocol-Version' = '2024-11-05' }
$mcp = "$Base/mcp?token=$Token"

function Rpc([string]$method, [hashtable]$params) {
  $body = @{ jsonrpc='2.0'; id=[string](Get-Random); method=$method }
  if ($params) { $body.params = $params }
  $json = $body | ConvertTo-Json -Depth 12
  return Invoke-RestMethod -Uri $mcp -Method Post -Headers $H -Body $json
}

function GetTextFromContent($r) {
  if ($null -ne $r.content) {
    foreach ($c in $r.content) {
      if ($c.type -eq 'text' -and $c.text) { return $c.text }
    }
  }
  if ($r.structuredContent -and $r.structuredContent.item -and $r.structuredContent.item.text) {
    return $r.structuredContent.item.text
  }
  if ($r.result -and $r.result.content) {
    foreach ($c in $r.result.content) {
      if ($c.type -eq 'text' -and $c.text) { return $c.text }
    }
  }
  return $null
}

function GetItems($r) {
  if ($r.structuredContent -and $r.structuredContent.items) { return $r.structuredContent.items }
  $t = GetTextFromContent $r
  if ($t) {
    try {
      $o = $t | ConvertFrom-Json -ErrorAction Stop
      if ($o.items) { return $o.items }
    } catch { }
  }
  return @()
}

function FindCsvSel([string]$latestName, [string]$prefix) {
  $exact = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query="title = '$latestName' and trashed = false"; limit=5 } }
  $ex = GetItems $exact
  if ($ex.Count -gt 0) {
    return [pscustomobject]@{ id=$ex[0].id; name=$ex[0].name; warning=$null }
  }

  $like = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query=("title contains '" + $prefix + "' and trashed = false"); limit=50 } }
  $items = GetItems $like
  if ($items.Count -gt 0) {
    # prefer newest by modified* (v2/v3 differences handled below)
    $best = $items | Sort-Object { $_.modifiedDate ?? $_.modifiedTime } -Descending | Select-Object -First 1
    $w = "WARNING: $latestName not found — fell back to newest '$prefix*' ($($best.name))"
    return [pscustomobject]@{ id=$best.id; name=$best.name; warning=$w }
  }

  return $null
}

function ExportTextById([string]$id) {
  $r = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$id } }
  $t = GetTextFromContent $r
  if ($t) { return $t }

  if ($r.error) {
    $detail = $r.error.message
    if ($r.error.data -and $r.error.data.detail) { $detail = $r.error.data.detail }
    throw "drive.export failed: $detail"
  }
  throw "drive.export returned no text"
}

# ---- Handshake + tool gate ---------------------------------------------------
[void](Rpc 'initialize' @{ protocolVersion = '2024-11-05' })
$tl = Rpc 'tools/list' @{}
$tools = @()
if ($tl.tools) { $tools = $tl.tools }
elseif ($tl.result -and $tl.result.tools) { $tools = $tl.result.tools }

$have = @()
foreach ($t in $tools) { if ($t.name) { $have += $t.name } else { $have += $t } }
foreach ($n in @('drive.search','drive.get','drive.export')) {
  if (-not ($have -contains $n)) { throw "Missing required tool: $n" }
}

# ---- Resolve LATEST ids (with fallback) --------------------------------------
$warnings = @()

$idxSel = FindCsvSel 'Transcripts__INDEX__LATEST.csv'  'Transcripts__INDEX__'
if (-not $idxSel) { $warnings += "WARNING: neither Transcripts__INDEX__LATEST.csv nor any 'Transcripts__INDEX__*' files were found." }

$chkSel = FindCsvSel 'Transcripts__CHUNKS__LATEST.csv' 'Transcripts__CHUNKS__'
if (-not $chkSel) { $warnings += "WARNING: neither Transcripts__CHUNKS__LATEST.csv nor any 'Transcripts__CHUNKS__*' files were found." }

# ---- Export INDEX and parse top 20 -------------------------------------------
$index  = @()
$top20  = @()
if ($idxSel) {
  $idxText = ExportTextById $idxSel.id
  if (-not [string]::IsNullOrWhiteSpace($idxText)) {
    $index = $idxText | ConvertFrom-Csv
    $top20 = $index | Select-Object -First 20
  } else {
    $warnings += "WARNING: INDEX export returned empty text (id=$($idxSel.id))."
  }
}

# ---- Cross-check live Drive v3 metadata --------------------------------------
$drifts = @()
foreach ($row in $top20) {
  $g = Rpc 'tools/call' @{ name='drive.get'; arguments=@{ id=$row.id } }

  $it = $null
  if ($g.structuredContent -and $g.structuredContent.item) { $it = $g.structuredContent.item }
  elseif ($g.result -and $g.result.item) { $it = $g.result.item }
  elseif ($g.item) { $it = $g.item }

  $csvName = $row.title
  $csvMime = $row.mimeType
  $csvMod  = if ($row.modifiedDate) { $row.modifiedDate } else { $row.modifiedTime }
  $csvSize = if ($row.fileSize)     { $row.fileSize }     else { $row.size }

  if ($csvName -ne $it.name)       { $drifts += [pscustomobject]@{id=$row.id; field='name';     csv=$csvName; live=$it.name} }
  if ($csvMime -ne $it.mimeType)   { $drifts += [pscustomobject]@{id=$row.id; field='mime';     csv=$csvMime; live=$it.mimeType} }

  $liveMod  = if ($it.modifiedTime) { $it.modifiedTime } else { $it.modifiedDate }
  if ($csvMod -and $liveMod) {
    $a = ($csvMod.ToString()).TrimEnd('Z') + 'Z'
    $b = ($liveMod.ToString()).TrimEnd('Z') + 'Z'
    if ($a -ne $b) { $drifts += [pscustomobject]@{id=$row.id; field='modified'; csv=$csvMod; live=$liveMod} }
  }

  $liveSize = if ($it.size) { $it.size } else { $it.fileSize }
  if ("$csvSize" -ne "$liveSize") { $drifts += [pscustomobject]@{id=$row.id; field='size'; csv="$csvSize"; live="$liveSize"} }
}

# ---- Optional: chunk audit ---------------------------------------------------
$chunkRows = @()
if ($DoChunks -and $chkSel) {
  function ChunkMeta([string]$text,[int]$window=6000,[int]$overlap=400){
    $out = New-Object System.Collections.Generic.List[object]
    $pos=0; $step=[Math]::Max(1,$window-$overlap); $idx=0
    while ($pos -lt $text.Length) {
      $end  = [Math]::Min($text.Length, $pos+$window)
      $seg  = $text.Substring($pos, $end-$pos)
      $nl   = $seg.LastIndexOf([char]10)
      if ($nl -ge 0 -and ($seg.Length - $nl) -le 500) { $seg = $seg.Substring(0,$nl+1); $end = $pos + $seg.Length }
      $out.Add([pscustomobject]@{ idx=$idx; start=$pos; end=$end; len=$seg.Length })
      if ($end -eq $text.Length) { break }
      $pos=[Math]::Min($text.Length,$pos+$step); $idx++; if ($idx -gt 200000) { break }
    }
    return $out
  }

  $chkText   = ExportTextById $chkSel.id
  $chunksCsv = $chkText | ConvertFrom-Csv
  $ids       = ($chunksCsv | Group-Object id | Sort-Object Count -Descending | Select-Object -First 3).Name

  foreach ($fid in $ids) {
    $sample = $chunksCsv | Where-Object { $_.id -eq $fid } | Sort-Object {[int]$_.chunkIndex} | Select-Object -First 5
    $t = ExportTextById $fid
    $calc = ChunkMeta $t 6000 400 | Select-Object -First $sample.Count
    for ($i=0; $i -lt $sample.Count; $i++) {
      $csv=$sample[$i]; $c=$calc[$i]
      $ok = ([int]$csv.start -eq $c.start) -and ([int]$csv.end -eq $c.end) -and ([int]$csv.length -eq $c.len)
      $chunkRows += [pscustomobject]@{
        id=$fid; idx=$i; ok=$ok;
        csv_idx=[int]$csv.chunkIndex; csv_start=[int]$csv.start; csv_end=[int]$csv.end; csv_len=[int]$csv.length;
        calc_start=$c.start;          calc_end=$c.end;          calc_len=$c.len
      }
    }
  }
}

# ---- Report ------------------------------------------------------------------
$indexId  = if ($idxSel) { $idxSel.id } else { '' }
$chunksId = if ($chkSel) { $chkSel.id } else { '' }

$report = [pscustomobject]@{
  when       = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
  indexId    = $indexId
  chunksId   = $chunksId
  top20Count = $top20.Count
  driftCount = $drifts.Count
  driftRows  = $drifts
  chunkAudit = [bool]$DoChunks
  chunkRows  = $chunkRows
  warnings   = $warnings
}

$path = Join-Path (Get-Location) ("Dive6b_Report__" + (Get-Date -Format 'yyyyMMdd_HHmmss') + ".json")
$report | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 -Path $path

Write-Host "* Dive 6b complete."
Write-Host ("Drift rows : {0}" -f $drifts.Count)
if ($DoChunks) { Write-Host ("Chunk rows : {0}" -f $chunkRows.Count) }
if ($warnings.Count -gt 0) { Write-Host ("Warnings  : {0}" -f ($warnings -join " | ")) }
Write-Host ("Saved report -> {0}" -f $path)
