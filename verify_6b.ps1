param(
  [Parameter(Mandatory=$true)][string]$Base,
  [Parameter(Mandatory=$true)][string]$Token,
  [bool]$DoChunks = $false
)

Write-Host "[Start] Dive 6b verification"

# ---------- JSON-RPC helpers ----------
$H = @{ 'Content-Type'='application/json'; 'MCP-Protocol-Version'='2024-11-05' }
$mcp = "$Base/mcp?token=$Token"

function ToJson($obj){ $obj | ConvertTo-Json -Depth 14 }

function Rpc([string]$method, [hashtable]$params) {
  $body = @{ jsonrpc='2.0'; id=[string](Get-Random); method=$method }
  if ($params) { $body.params = $params }
  return Invoke-RestMethod -Uri $mcp -Method Post -Headers $H -Body (ToJson $body)
}

function ResultOf($r) {
  if ($r.result) { return $r.result }
  return $r
}

function ItemsOf($r) {
  $res = ResultOf $r
  if ($res.structuredContent -and $res.structuredContent.items) { return $res.structuredContent.items }
  if ($res.items) { return $res.items }
  if ($res.content) {
    $t = $res.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1
    if ($t -and $t.text) { return ( $t.text | ConvertFrom-Json ).items }
  }
  @()
}

function ItemOf($r) {
  $res = ResultOf $r
  if ($res.structuredContent -and $res.structuredContent.item) { return $res.structuredContent.item }
  if ($res.item) { return $res.item }
  $null
}

function ExportText([string]$id) {
  $r = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$id } }
  $it = ItemOf $r
  if ($it -and $it.text) { return $it.text }
  if ($it -and $it.'text/plain') { return $it.'text/plain' }
  $res = ResultOf $r
  if ($res.content) {
    $t = $res.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1
    if ($t -and $t.text) { return $t.text }
  }
  return $null
}

# ---------- Tools gate ----------
function RequireTools([string[]]$need) {
  $tl = Rpc 'tools/list' @{}
  $res = ResultOf $tl
  $tools = @()
  if ($res.tools) { $tools = $res.tools }
  $names = @()
  foreach($t in $tools){ if ($t.name) { $names += $t.name } }
  foreach($n in $need){ if (-not ($names -contains $n)) { throw "Missing required tool: $n" } }
}
RequireTools @('drive.search','drive.get','drive.export')

# ---------- Find LATEST (with fallback) ----------
function FindCsvId([string]$latestName, [string]$prefix){
  $warn = $null
  $s1 = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query="title = '$latestName' and trashed = false"; limit=1 } }
  $a1 = ItemsOf $s1
  if ($a1 -and $a1.Count -gt 0) {
    return @{ id=$a1[0].id; name=$a1[0].name; warning=$warn }
  }
  # fallback to newest prefixed file
  $s2 = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query="title contains '$prefix' and trashed = false"; limit=100 } }
  $a2 = ItemsOf $s2
  if ($a2 -and $a2.Count -gt 0) {
    $best = $a2 | Sort-Object { $_.modifiedDate } -Descending | Select-Object -First 1
    $warn = ("WARNING: {0} not found - fell back to ""{1}""" -f $latestName, $best.name)
    return @{ id=$best.id; name=$best.name; warning=$warn }
  }
  $warn = ("WARNING: neither {0} nor any '{1}*' files were found." -f $latestName, $prefix)
  return @{ id=$null; name=$null; warning=$warn }
}

$warnings = New-Object System.Collections.Generic.List[string]

$idxSel = FindCsvId 'Transcripts__INDEX__LATEST.csv'  'Transcripts__INDEX__'
if ($idxSel.warning) { $warnings.Add($idxSel.warning) }
if (-not $idxSel.id) { throw "INDEX__LATEST not found (and no fallback)" }

$chkSel = FindCsvId 'Transcripts__CHUNKS__LATEST.csv' 'Transcripts__CHUNKS__'
if ($chkSel.warning) { $warnings.Add($chkSel.warning) }

# ---------- Load INDEX CSV ----------
$idxText = ExportText $idxSel.id
if ([string]::IsNullOrWhiteSpace($idxText)) { throw "INDEX__LATEST export missing" }
$index = $idxText | ConvertFrom-Csv

# Top 20 to keep the call budget small
$top20 = $index | Select-Object -First 20

# ---------- Compare helpers ----------
function NormIso([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  try {
    # Try invariant first, then current culture; always return UTC-like simple string
    $dt = [DateTime]::Parse($s, [Globalization.CultureInfo]::InvariantCulture)
  } catch {
    try { $dt = [DateTime]::Parse($s) } catch { return $s.Trim() }
  }
  return $dt.ToString('yyyy-MM-ddTHH:mm:ss')
}

# ---------- Field-level drift on top20 ----------
$drifts = New-Object System.Collections.Generic.List[object]

foreach($row in $top20){
  $gid = [string]$row.id
  $g = Rpc 'tools/call' @{ name='drive.get'; arguments=@{ id=$gid } }
  $it = ItemOf $g

  $csvName = [string]$row.title
  $csvMime = [string]$row.mimeType
  $csvMod  = if ($row.modifiedDate) { [string]$row.modifiedDate } elseif ($row.modifiedTime) { [string]$row.modifiedTime } else { '' }
  $csvSize = if ($row.fileSize)     { [string]$row.fileSize }     elseif ($row.size)        { [string]$row.size }        else { '' }

  $liveName = if ($it.name) { [string]$it.name } else { '' }
  $liveMime = if ($it.mimeType) { [string]$it.mimeType } else { '' }
  $liveMod  = if ($it.modifiedTime) { [string]$it.modifiedTime } elseif ($it.modifiedDate) { [string]$it.modifiedDate } else { '' }
  $liveSize = if ($it.size) { [string]$it.size } elseif ($it.fileSize) { [string]$it.fileSize } else { '' }

  if ($csvName -ne $liveName) { $drifts.Add([pscustomobject]@{ id=$gid; field='name';     csv=$csvName; live=$liveName }) }
  if ($csvMime -ne $liveMime) { $drifts.Add([pscustomobject]@{ id=$gid; field='mimeType'; csv=$csvMime; live=$liveMime }) }

  $nCsv = NormIso $csvMod
  $nLive = NormIso $liveMod
  if ($nCsv -ne $nLive) { $drifts.Add([pscustomobject]@{ id=$gid; field='modified'; csv=$csvMod; live=$liveMod }) }

  if ("$csvSize" -ne "$liveSize") { $drifts.Add([pscustomobject]@{ id=$gid; field='size'; csv="$csvSize"; live="$liveSize" }) }
}

# ---------- Optional chunk audit ----------
function ChunkMeta([string]$text,[int]$window=6000,[int]$overlap=400){
  $out = New-Object System.Collections.Generic.List[object]
  if (-not $text) { return $out }
  $pos=0; $step=[Math]::Max(1,$window-$overlap)
  while($pos -lt $text.Length){
    $end=[Math]::Min($text.Length,$pos+$window)
    $slice=$text.Substring($pos,$end-$pos)
    $nl=$slice.LastIndexOf("`n")
    if($nl -ge 0 -and ($slice.Length - $nl) -le 500){ $slice=$slice.Substring(0,$nl+1); $end=$pos+$slice.Length }
    $out.Add([pscustomobject]@{ idx=$out.Count; start=$pos; end=$end; len=$slice.Length })
    if($end -eq $text.Length){ break }
    $pos=[Math]::Min($text.Length,$pos+$step)
  }
  return $out
}

$chunkRows = New-Object System.Collections.Generic.List[object]
if ($DoChunks -and $chkSel.id) {
  $chkText = ExportText $chkSel.id
  if ($chkText) {
    $chunksCsv = $chkText | ConvertFrom-Csv
    $ids = ($chunksCsv | Group-Object id | Sort-Object Count -Descending | Select-Object -First 3).Name
    foreach($fid in $ids){
      $sample = $chunksCsv | Where-Object { $_.id -eq $fid } | Sort-Object { [int]$_.chunkIndex } | Select-Object -First 5
      $txt = ExportText $fid
      $calc = ChunkMeta $txt 6000 400 | Select-Object -First $sample.Count
      for($i=0; $i -lt $sample.Count; $i++){
        $csv = $sample[$i]; $c=$calc[$i]
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

# ---------- Report ----------
$indexId   = if ($idxSel) { $idxSel.id } else { '' }
$chunksId  = if ($chkSel) { $chkSel.id } else { '' }
$top20Cnt  = if ($top20)  { $top20.Count } else { 0 }

$report = [pscustomobject]@{
  when       = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
  indexId    = $indexId
  chunksId   = $chunksId
  top20Count = $top20Cnt
  driftCount = $drifts.Count
  driftRows  = $drifts
  chunkAudit = $DoChunks
  chunkRows  = $chunkRows
  warnings   = $warnings
}

$path = Join-Path (Get-Location) ("Dive6b_Report__" + (Get-Date -Format 'yyyyMMdd_HHmmss') + ".json")
$report | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 -Path $path

Write-Host "* Dive 6b complete."
Write-Host ("Drift rows : {0}" -f $drifts.Count)
if ($DoChunks) { Write-Host ("Chunk rows : {0}" -f $chunkRows.Count) }
if ($warnings.Count -gt 0){ Write-Host ("Warnings  : {0}" -f ($warnings -join " | ")) }
Write-Host ("Saved report -> {0}" -f $path)
