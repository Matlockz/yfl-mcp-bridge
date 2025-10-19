param(
  [Parameter(Mandatory=$true)][string]$Base,
  [Parameter(Mandatory=$true)][string]$Token,
  [bool]$DoChunks = $false
)

Write-Host "[Start] Dive 6b verification"

$H = @{ 'Content-Type'='application/json'; 'MCP-Protocol-Version'='2024-11-05' }
$mcp = "$Base/mcp?token=$Token"

function Rpc([string]$method, [hashtable]$params){
  $body = @{ jsonrpc='2.0'; id=[string](Get-Random); method=$method }
  if($params){ $body.params = $params }
  $json = $body | ConvertTo-Json -Depth 12
  return Invoke-RestMethod -Uri $mcp -Method Post -Headers $H -Body $json
}

function ItemsOf($r){
  if($r -and $r.structuredContent -and $r.structuredContent.items){ return $r.structuredContent.items }
  if($r -and $r.result -and $r.result.items){ return $r.result.items }
  if($r -and $r.items){ return $r.items }
  return @()
}

function ItemOf($r){
  if($r -and $r.structuredContent -and $r.structuredContent.item){ return $r.structuredContent.item }
  if($r -and $r.result -and $r.result.item){ return $r.result.item }
  if($r -and $r.item){ return $r.item }
  return $null
}

# 1) Handshake + tools gate
[void](Rpc 'initialize' @{ protocolVersion='2024-11-05' })
$tl = Rpc 'tools/list' @{}
$tools = @()
if($tl.tools){ $tools = $tl.tools }
elseif($tl.result -and $tl.result.tools){ $tools = $tl.result.tools }
elseif($tl.structuredContent -and $tl.structuredContent.tools){ $tools = $tl.structuredContent.tools }

$have = $tools | ForEach-Object { if($_ -is [string]){$_} elseif($_.name){$_.name} }
@('drive.search','drive.get','drive.export') | ForEach-Object {
  if(-not ($have -contains $_)){ throw ("Missing required tool: {0}" -f $_) }
}

# 2) Resolve LATEST, with fallback to dated names if LATEST is missing
function FindCsvId([string]$latestName, [string]$prefix){
  $s1 = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query=("title = '{0}' and trashed = false" -f $latestName); limit=5 } }
  $a1 = ItemsOf $s1
  if($a1 -and $a1.Count -gt 0){ return @{ id=$a1[0].id; name=$a1[0].name; warning='' } }

  $s2 = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query=("title contains '{0}' and mimeType = 'text/csv' and trashed = false" -f $prefix); limit=25 } }
  $a2 = ItemsOf $s2
  if($a2 -and $a2.Count -gt 0){
    $best = ($a2 | Sort-Object modifiedDate -Descending | Select-Object -First 1)
    $w = ("WARNING: {0} not found - fell back to latest dated snapshot: {1}" -f $latestName, $best.name)
    return @{ id=$best.id; name=$best.name; warning=$w }
  }
  return @{ id=''; name=''; warning=("WARNING: could not find {0} or any dated snapshot" -f $latestName) }
}

$idxSel = FindCsvId 'Transcripts__INDEX__LATEST.csv'  'Transcripts__INDEX__'
$chkSel = FindCsvId 'Transcripts__CHUNKS__LATEST.csv' 'Transcripts__CHUNKS__'

$warnings = @()
if($idxSel.warning){ $warnings += $idxSel.warning }
if($chkSel.warning){ $warnings += $chkSel.warning }

if(-not $idxSel.id){ throw "INDEX CSV not found" }
if($DoChunks -and (-not $chkSel.id)){ throw "CHUNKS CSV not found (required when -DoChunks is true)" }

# 3) Export INDEX and parse top 20
$idxExport = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$idxSel.id } }
$idxText   = (ItemOf $idxExport).text
$index     = $idxText | ConvertFrom-Csv
$top20     = $index | Select-Object -First 20

# 4) Cross-check metadata for top 20
$drifts = @()
foreach($row in $top20){
  $g = Rpc 'tools/call' @{ name='drive.get'; arguments=@{ id=$row.id } }
  $it = ItemOf $g

  $csvName = $row.title
  $csvMime = $row.mimeType
  $csvMod  = ($row.modifiedDate) ? $row.modifiedDate : $row.modifiedTime
  $csvSize = ($row.fileSize)     ? $row.fileSize     : $row.size

  if($csvName -ne $it.name){ $drifts += [pscustomobject]@{id=$row.id; field='name'; csv=$csvName; live=$it.name} }
  if($csvMime -ne $it.mimeType){ $drifts += [pscustomobject]@{id=$row.id; field='mime'; csv=$csvMime; live=$it.mimeType} }

  $liveMod = $it.modifiedTime
  if($csvMod -and $liveMod){
    $cm = ($csvMod.TrimEnd('Z') + 'Z')
    $lm = ($liveMod.TrimEnd('Z') + 'Z')
    if($cm -ne $lm){ $drifts += [pscustomobject]@{id=$row.id; field='modified'; csv=$csvMod; live=$liveMod} }
  }

  $liveSize = ($it.size) ? $it.size : $it.fileSize
  if(("$csvSize") -ne ("$liveSize")){
    $drifts += [pscustomobject]@{id=$row.id; field='size'; csv=("$csvSize"); live=("$liveSize")}
  }
}

# 5) Optional: chunk audit
$chunkRows = @()

function ChunkMeta([string]$text,[int]$window=6000,[int]$overlap=400){
  if([string]::IsNullOrEmpty($text)){ return @() }
  # normalize line endings to LF to mirror exporter behavior
  $norm = $text -replace "`r`n","`n" -replace "`r","`n"
  $out=@(); $pos=0; $step=[Math]::Max(1,$window-$overlap)
  while($pos -lt $norm.Length){
    $end=[Math]::Min($norm.Length,$pos+$window)
    $slice=$norm.Substring($pos,$end-$pos)
    $nl=$slice.LastIndexOf("`n")
    if($nl -ge 0 -and ($slice.Length - $nl) -le 500){
      $slice=$slice.Substring(0,$nl+1); $end=$pos+$slice.Length
    }
    $out += [pscustomobject]@{ idx=$out.Count; start=$pos; end=$end; len=$slice.Length }
    if($end -eq $norm.Length){ break }
    $pos=[Math]::Min($norm.Length,$pos+$step)
  }
  return $out
}

if($DoChunks){
  $chkExport = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$chkSel.id } }
  $chkText   = (ItemOf $chkExport).text
  $chunksCsv = $chkText | ConvertFrom-Csv

  $ids = ($chunksCsv | Group-Object id | Sort-Object Count -Descending | Select-Object -First 3).Name
  foreach($fid in $ids){
    $sample = $chunksCsv | Where-Object { $_.id -eq $fid } | Sort-Object {[int]$_.chunkIndex} | Select-Object -First 5
    $e   = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$fid } }
    $txt = (ItemOf $e).text

    $calc = ChunkMeta $txt 6000 400 | Select-Object -First $sample.Count
    for($i=0; $i -lt $sample.Count; $i++){
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

# 6) Report + console summary
$report = [pscustomobject]@{
  when       = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
  indexId    = $idxSel.id
  chunksId   = $chkSel.id
  top20Count = $top20.Count
  driftCount = $drifts.Count
  driftRows  = $drifts
  chunkAudit = $DoChunks
  chunkRows  = $chunkRows
  warnings   = $warnings
}
$path = Join-Path (Get-Location) ("Dive6b_Report__" + (Get-Date -Format 'yyyyMMdd_HHmmss') + ".json")
$report | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 $path

Write-Host "* Dive 6b complete."
Write-Host ("Drift rows : {0}" -f $drifts.Count)
if($DoChunks){ Write-Host ("Chunk rows : {0}" -f $chunkRows.Count) }
if($warnings -and $warnings.Count -gt 0){ Write-Host ("Warnings  : {0}" -f ($warnings -join " | ")) }
Write-Host ("Saved report -> {0}" -f $path)
