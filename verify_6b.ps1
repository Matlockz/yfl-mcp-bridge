param(
  [Parameter(Mandatory=$true)][string]$Base,
  [Parameter(Mandatory=$true)][string]$Token,
  [bool]$DoChunks = $false
)

Write-Host "[Start] Dive 6b verification"

# JSON-RPC plumbing -----------------------------------------------------------
$H   = @{ 'Content-Type'='application/json'; 'MCP-Protocol-Version'='2024-11-05' }
$mcp = "$Base/mcp?token=$Token"

function Rpc($method, $params) {
  $body = @{ jsonrpc='2.0'; id=[string](Get-Random); method=$method }
  if ($null -ne $params) { $body.params = $params }
  $json = $body | ConvertTo-Json -Depth 14
  return Invoke-RestMethod -Uri $mcp -Method Post -Headers $H -Body $json
}

function ItemText($r) {
  if ($r.result -and $r.result.structuredContent -and $r.result.structuredContent.item -and $r.result.structuredContent.item.text) {
    return $r.result.structuredContent.item.text
  }
  if ($r.result -and $r.result.content) {
    $first = $r.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1
    if ($first) { return $first.text }
  }
  return $null
}

function ItemsOf($r) {
  if ($r.result -and $r.result.structuredContent -and $r.result.structuredContent.items) {
    return $r.result.structuredContent.items
  }
  if ($r.result -and $r.result.content) {
    $first = $r.result.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1
    if ($first) { return ((ConvertFrom-Json $first.text).items) }
  }
  return @()
}

function SameMoment([string]$a, [string]$b) {
  try {
    $A = [DateTimeOffset]::Parse($a, [Globalization.CultureInfo]::InvariantCulture,
      [System.Globalization.DateTimeStyles]::AssumeUniversal)
    $B = [DateTimeOffset]::Parse($b, [Globalization.CultureInfo]::InvariantCulture,
      [System.Globalization.DateTimeStyles]::AssumeUniversal)
    return $A.UtcDateTime -eq $B.UtcDateTime
  } catch { return $false }
}

# Gate required tools ---------------------------------------------------------
$toolsList = Rpc 'tools/list' $null
$names = @()
if ($toolsList.result -and $toolsList.result.tools) { $names = $toolsList.result.tools | % { if ($_.name){$_.name}else{$_} } }
if (@('drive.search','drive.get','drive.export') | ? { $names -notcontains $_ }) {
  throw "Missing required tool(s); got: $($names -join ', ')"
}

# Resolve INDEX / CHUNKS beacons ----------------------------------------------
function FindCsvId([string]$latestName, [string]$prefix) {
  $s = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query=("title = '{0}' and trashed = false" -f $latestName); limit=1 } }
  $items = ItemsOf $s
  if ($items.Count -gt 0) {
    return [pscustomobject]@{ id=$items[0].id; name=$items[0].name; warning=$null }
  }
  # fallback to newest matching prefix
  $s2 = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query=("title contains '{0}' and trashed = false" -f $prefix); limit=50 } }
  $a2 = ItemsOf $s2 | Sort-Object modifiedDate -Descending
  if ($a2.Count -gt 0) {
    $best = $a2[0]
    $msg = ("WARNING: {0} not found — fell back to '{1}'" -f $latestName, $best.name)
    return [pscustomobject]@{ id=$best.id; name=$best.name; warning=$msg }
  }
  return $null
}

$idxSel = FindCsvId 'Transcripts__INDEX__LATEST.csv'  'Transcripts__INDEX__'
$chkSel = FindCsvId 'Transcripts__CHUNKS__LATEST.csv' 'Transcripts__CHUNKS__'

$warnings = New-Object System.Collections.Generic.List[string]
if ($idxSel -and $idxSel.warning) { [void]$warnings.Add($idxSel.warning) }
if ($chkSel -and $chkSel.warning) { [void]$warnings.Add($chkSel.warning) }

if (-not $idxSel) { throw "INDEX__LATEST not found (and no fallback)" }
$idxExport = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$($idxSel.id) } }
$idxText = ItemText $idxExport
$index = $idxText | ConvertFrom-Csv
$top20 = $index | Select-Object -First 20

# Cross‑check metadata ---------------------------------------------------------
$drifts = New-Object System.Collections.Generic.List[object]
foreach($row in $top20) {
  $g = Rpc 'tools/call' @{ name='drive.get'; arguments=@{ id=$row.id } }
  $it = $g.result.structuredContent.item
  if ($row.title -ne $it.name)      { $drifts.Add([pscustomobject]@{ id=$row.id; field='name';    csv=$row.title;      live=$it.name }) }
  if ($row.mimeType -ne $it.mimeType){ $drifts.Add([pscustomobject]@{ id=$row.id; field='mime';    csv=$row.mimeType;    live=$it.mimeType }) }

  $csvMod  = $row.modifiedDate ?? $row.modifiedTime
  $liveMod = $it.modifiedTime  ?? $it.modifiedDate
  if ($csvMod -and $liveMod -and -not (SameMoment $csvMod $liveMod)) {
    $drifts.Add([pscustomobject]@{ id=$row.id; field='modified'; csv=$csvMod; live=$liveMod })
  }

  $csvSize  = $row.fileSize ?? $row.size
  $liveSize = $it.size ?? $it.fileSize
  if ("$csvSize" -ne "$liveSize") {
    $drifts.Add([pscustomobject]@{ id=$row.id; field='size'; csv="$csvSize"; live="$liveSize" })
  }
}

# Optional: chunk audit --------------------------------------------------------
$chunkRows = New-Object System.Collections.Generic.List[object]
function ChunkMeta([string]$text,[int]$window=6000,[int]$overlap=400){
  $out=@(); $pos=0; $step=[Math]::Max(1,$window-$overlap)
  while($pos -lt $text.Length){
    $end=[Math]::Min($text.Length,$pos+$window)
    $slice=$text.Substring($pos,$end-$pos)
    $nl=$slice.LastIndexOf("`n")
    if($nl -ge 0 -and ($slice.Length - $nl) -le 500){
      $slice=$slice.Substring(0,$nl+1); $end=$pos+$slice.Length
    }
    $out += ,([pscustomobject]@{ start=$pos; end=$end; len=$slice.Length })
    if($end -eq $text.Length){ break }
    $pos=[Math]::Min($text.Length,$pos+$step)
  }
  return $out
}

if ($DoChunks) {
  if (-not $chkSel) { $warnings.Add('WARNING: CHUNKS__LATEST not found; skipping chunk audit.') }
  else {
    $chkExport = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$($chkSel.id) } }
    $chkText   = ItemText $chkExport
    $chunksCsv = $chkText | ConvertFrom-Csv
    $ids = ($chunksCsv | Group-Object id | Sort-Object Count -Descending | Select-Object -First 3).Name
    foreach($fid in $ids){
      $sample = $chunksCsv | Where-Object { $_.id -eq $fid } | Sort-Object {[int]$_.chunkIndex} | Select-Object -First 5
      $e = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$fid } }
      $txt = ItemText $e
      $calc = ChunkMeta $txt 6000 400 | Select-Object -First $sample.Count
      for($i=0; $i -lt $sample.Count; $i++){
        $csv=$sample[$i]; $c=$calc[$i]
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

# Report ----------------------------------------------------------------------
$report = [pscustomobject]@{
  when       = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
  indexId    = ($idxSel ? $idxSel.id : '')
  chunksId   = ($chkSel ? $chkSel.id : '')
  top20Count = $top20.Count
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
if ($warnings.Count -gt 0) { Write-Host ("Warnings  : {0}" -f ($warnings -join " | ")) }
Write-Host ("Saved report -> {0}" -f $path)
