param(
  [Parameter(Mandatory=$true)][string]$Base,
  [Parameter(Mandatory=$true)][string]$Token,
  [bool]$DoChunks = $false
)

Write-Host "[Start] Dive 6b verification"

# ---- wiring ---------------------------------------------------------------
$H = @{ 'Content-Type'='application/json'; 'MCP-Protocol-Version'='2024-11-05' }
$mcp = "$Base/mcp?token=$Token"

function Rpc([string]$method, [hashtable]$params = $null) {
  $body = @{ jsonrpc='2.0'; id=[guid]::NewGuid().ToString(); method=$method }
  if ($params) { $body.params = $params }
  $json = $body | ConvertTo-Json -Depth 14
  return Invoke-RestMethod -Uri $mcp -Method Post -Headers $H -Body $json
}

# helpers to read the Bridge’s different result shapes
function SC($r) { if ($r.result -and $r.result.structuredContent) { $r.result.structuredContent } elseif ($r.structuredContent) { $r.structuredContent } }
function CT($r) { if ($r.result -and $r.result.content)            { $r.result.content }            elseif ($r.content)            { $r.content } }

function FirstText($r) {
  $sc = SC $r
  if ($sc -and $sc.item) {
    if ($sc.item.text)        { return $sc.item.text }
    if ($sc.item.'text/plain'){ return $sc.item.'text/plain' }
  }
  $ct = CT $r
  if ($ct) { $t = ($ct | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text; if ($t) { return $t } }
  return $null
}

# tolerant time compare (≤ 2 seconds)
function SameTime($a, $b) {
  try {
    $da = [DateTimeOffset]::Parse($a); $db = [DateTimeOffset]::Parse($b)
    return [math]::Abs(($da - $db).TotalSeconds) -le 2
  } catch { return ($a -eq $b) }
}

# newline-aware chunker (match indexer: 6000/400, prefer newline within last 500 chars)
function ChunkMeta([string]$text, [int]$window = 6000, [int]$overlap = 400) {
  $out = @(); if (-not $text) { return $out }
  $pos = 0; $step = [math]::Max(1, $window - $overlap)
  while ($pos -lt $text.Length) {
    $end = [math]::Min($text.Length, $pos + $window)
    $slice = $text.Substring($pos, $end - $pos)
    $nl = $slice.LastIndexOf("`n")
    if ($nl -ge 0 -and ($slice.Length - $nl) -le 500) { $slice = $slice.Substring(0, $nl + 1); $end = $pos + $slice.Length }
    $out += [pscustomobject]@{ idx=$out.Count; start=$pos; end=$end; len=$slice.Length }
    if ($end -eq $text.Length) { break }
    $pos = [math]::Min($text.Length, $pos + $step)
  }
  return $out
}

# ---- handshake + tool-gate -----------------------------------------------
[void](Rpc 'initialize' @{ protocolVersion='2024-11-05' })
$tl = Rpc 'tools/list' @{}
$toolObjs = $tl.result.tools ?? $tl.tools ?? @()
$names = @(); foreach($t in $toolObjs){ $names += ($t.name ?? "$t") }

$need = @('drive.search','drive.get','drive.export')
$missing = @($need | Where-Object { $names -notcontains $_ })
if ($missing.Count -gt 0) { throw "Missing required tool(s); got: $($names -join ', ')" }

# ---- resolve beacons (LATEST with fallback) ------------------------------
$warnings = New-Object System.Collections.Generic.List[string]

function FindCsvId([string]$latest, [string]$prefix) {
  $a1 = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query="title = '$latest' and trashed = false"; limit=1 } }
  $i1 = (SC $a1).items
  if ($i1 -and $i1.Count -gt 0) { return [pscustomobject]@{ id=$i1[0].id; name=$i1[0].name; warn=$null } }

  $a2 = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query="title contains '$prefix' and trashed = false"; limit=25 } }
  $i2 = (SC $a2).items
  if ($i2 -and $i2.Count -gt 0) {
    $best = $i2 | Sort-Object modifiedDate -Descending | Select-Object -First 1
    return [pscustomobject]@{ id=$best.id; name=$best.name; warn=("WARNING: {0} not found — fell back to {1}" -f $latest, $best.name) }
  }
  return $null
}

$idxSel = FindCsvId 'Transcripts__INDEX__LATEST.csv'  'Transcripts__INDEX__'
$chkSel = FindCsvId 'Transcripts__CHUNKS__LATEST.csv' 'Transcripts__CHUNKS__'

if (-not $idxSel) { $warnings.Add("WARNING: neither Transcripts__INDEX__LATEST.csv nor any 'Transcripts__INDEX__*' files were found.") }
if (-not $chkSel -and $DoChunks) { $warnings.Add("WARNING: neither Transcripts__CHUNKS__LATEST.csv nor any 'Transcripts__CHUNKS__*' files were found.") }
if ($idxSel -and $idxSel.warn) { $warnings.Add($idxSel.warn) }
if ($chkSel -and $chkSel.warn) { $warnings.Add($chkSel.warn) }

# ---- export INDEX, take top-20, live cross-check -------------------------
$drifts  = New-Object System.Collections.Generic.List[object]
$chunkRows = New-Object System.Collections.Generic.List[object]
$top20  = @()

if ($idxSel) {
  $idxExport = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$idxSel.id } }
  $idxText   = FirstText $idxExport
  if ([string]::IsNullOrWhiteSpace($idxText)) { throw "INDEX__LATEST export missing" }

  $index = $idxText | ConvertFrom-Csv
  $top20 = $index | Select-Object -First 20

  foreach ($row in $top20) {
    $g  = Rpc 'tools/call' @{ name='drive.get'; arguments=@{ id=$row.id } }
    $it = (SC $g).item ?? $g.item

    $csvName = $row.title;      $liveName = $it.name
    $csvMime = $row.mimeType;   $liveMime = $it.mimeType
    $csvMod  = $row.modifiedDate
    $liveMod = $it.modifiedTime ?? $it.modifiedDate

    if ($csvName -ne $liveName) { $drifts.Add([pscustomobject]@{id=$row.id; field='name';     csv=$csvName; live=$liveName}) }
    if ($csvMime -ne $liveMime) { $drifts.Add([pscustomobject]@{id=$row.id; field='mime';     csv=$csvMime; live=$liveMime}) }
    if (-not (SameTime $csvMod $liveMod)) {
      $drifts.Add([pscustomobject]@{id=$row.id; field='modified'; csv=$csvMod;   live=$liveMod})
    }

    # size: ignore for native Google types (Docs/Sheets/etc.)
    $isNative = "$liveMime".StartsWith('application/vnd.google-apps')
    $csvSize = "$($row.fileSize)"; $liveSize = "$($it.size ?? $it.fileSize)"
    if (-not $isNative) {
      if ($csvSize -ne $liveSize) { $drifts.Add([pscustomobject]@{id=$row.id; field='size'; csv=$csvSize; live=$liveSize}) }
    }
  }
}

# ---- optional: chunk audit (3 files x first 5 chunks) --------------------
if ($DoChunks -and $chkSel) {
  $chkExport = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$chkSel.id } }
  $chkText   = FirstText $chkExport
  if (-not [string]::IsNullOrWhiteSpace($chkText)) {
    $chunksCsv = $chkText | ConvertFrom-Csv
    $ids = ($chunksCsv | Group-Object id | Sort-Object Count -Descending | Select-Object -First 3).Name
    foreach($fid in $ids){
      $sample = $chunksCsv | Where-Object { $_.id -eq $fid } | Sort-Object {[int]$_.chunkIndex} | Select-Object -First 5
      $e = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$fid } }
      $txt = FirstText $e
      $calc = ChunkMeta $txt 6000 400 | Select-Object -First $sample.Count
      for($i=0; $i -lt $sample.Count; $i++){
        $csv = $sample[$i]; $c = $calc[$i]
        $ok = ([int]$csv.start -eq $c.start) -and ([int]$csv.end -eq $c.end) -and ([int]$csv.length -eq $c.len)
        $chunkRows.Add([pscustomobject]@{
          id=$fid; idx=$i; ok=$ok;
          csv_idx=[int]$csv.chunkIndex; csv_start=[int]$csv.start; csv_end=[int]$csv.end; csv_len=[int]$csv.length;
          calc_start=$c.start;          calc_end=$c.end;          calc_len=$c.len
        })
      }
    }
  }
}

# ---- report + console summary -------------------------------------------
$report = [pscustomobject]@{
  when        = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
  indexId     = ($idxSel ? $idxSel.id : '')
  chunksId    = ($chkSel ? $chkSel.id : '')
  top20Count  = $top20.Count
  driftCount  = $drifts.Count
  driftRows   = $drifts
  chunkAudit  = $DoChunks
  chunkRows   = $chunkRows
  warnings    = $warnings
}

$path = Join-Path (Get-Location) ("Dive6b_Report__" + (Get-Date -Format 'yyyyMMdd_HHmmss') + ".json")
$report | ConvertTo-Json -Depth 14 | Set-Content -Encoding UTF8 -Path $path

Write-Host "* Dive 6b complete."
Write-Host ("Drift rows : {0}" -f $drifts.Count)
if ($DoChunks) { Write-Host ("Chunk rows : {0}" -f $chunkRows.Count) }
if ($warnings.Count -gt 0) { Write-Host ("Warnings  : {0}" -f ($warnings -join " | ")) }
Write-Host ("Saved report -> {0}" -f $path)
