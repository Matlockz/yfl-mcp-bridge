param(
  [Parameter(Mandatory=$true)][string]$Base,
  [Parameter(Mandatory=$true)][string]$Token,
  [bool]$DoChunks = $false
)

Write-Host "[Start] Dive 6b verification"

# ---- MCP endpoint + helpers --------------------------------------------------
$H   = @{ 'Content-Type'='application/json'; 'MCP-Protocol-Version'='2024-11-05' }
$mcp = "$Base/mcp?token=$Token"

function Rpc([string]$method, [hashtable]$params){
  $body = @{ jsonrpc='2.0'; id=[string](Get-Random); method=$method }
  if($params){ $body.params = $params }
  $json = $body | ConvertTo-Json -Depth 12
  return Invoke-RestMethod -Uri $mcp -Method Post -Headers $H -Body $json
}

function ItemsOf($r){
  if($r -eq $null){ return @() }
  if($r.structuredContent -and $r.structuredContent.items){ return $r.structuredContent.items }
  if($r.result            -and $r.result.items           ){ return $r.result.items }
  if($r.items){ return $r.items }
  return @()
}

function ItemOf($r){
  if($r -eq $null){ return $null }
  if($r.structuredContent -and $r.structuredContent.item){ return $r.structuredContent.item }
  if($r.result            -and $r.result.item           ){ return $r.result.item }
  if($r.item){ return $r.item }
  return $null
}

function Iso([string]$s){
  if([string]::IsNullOrWhiteSpace($s)){ return "" }
  # normalize trailing Z so "…Z" and "…Z" compare safely
  return ($s.TrimEnd('Z') + 'Z')
}

# ---- 0) Handshake + tool gate -----------------------------------------------
[void](Rpc 'initialize' @{ protocolVersion='2024-11-05' })
$tl     = Rpc 'tools/list' @{}
$tools  = @()
if($tl.tools){ $tools = $tl.tools } elseif($tl.result -and $tl.result.tools){ $tools = $tl.result.tools } elseif($tl.structuredContent -and $tl.structuredContent.tools){ $tools = $tl.structuredContent.tools }
$have   = $tools | ForEach-Object { if($_.name){$_.name}else{$_} }
@('drive.search','drive.get','drive.export') | ForEach-Object {
  if(-not ($have -contains $_)){ throw ("Missing required tool: {0}" -f $_) }
}

# ---- 1) Resolve CSV beacons (LATEST -> fallback to dated) --------------------
function FindCsvId([string]$latestName, [string]$prefix){
  # Try exact LATEST
  $qLatest = "title = '$latestName' and trashed = false"
  $s1 = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query=$qLatest; limit=5 } }
  $a1 = ItemsOf $s1
  if($a1 -and $a1.Count -gt 0){ 
    return @{ id=$a1[0].id; name=$a1[0].name; warning=$null }
  }

  # Fallback: any file that "contains prefix", pick by most recent modifiedDate
  $qAny = "title contains '$prefix' and trashed = false"
  $s2   = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query=$qAny; limit=50 } }
  $a2   = ItemsOf $s2
  if($a2 -and $a2.Count -gt 0){
    $best = $a2 | Sort-Object {
      try { [DateTime]::Parse($_.modifiedDate) } catch { Get-Date 0 }
    } -Descending | Select-Object -First 1
    return @{ id=$best.id; name=$best.name; warning=("WARNING: {0} not found — fell back to: {1}" -f $latestName, $best.name) }
  }

  return @{ id=$null; name=$null; warning=("WARNING: {0} not found (no fallback available)" -f $latestName) }
}

$warnings = New-Object System.Collections.Generic.List[string]

$idxPick = FindCsvId 'Transcripts__INDEX__LATEST.csv'  'Transcripts__INDEX__'
$chkPick = FindCsvId 'Transcripts__CHUNKS__LATEST.csv' 'Transcripts__CHUNKS__'

if($idxPick.warning){ $warnings.Add($idxPick.warning) }
if($chkPick.warning){ $warnings.Add($chkPick.warning) }

$idxId = $idxPick.id
$chkId = $chkPick.id

# If INDEX couldn't be resolved at all, we can't proceed (no rows to check).
if([string]::IsNullOrWhiteSpace($idxId)){
  $report = [pscustomobject]@{
    when       = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
    indexId    = $null
    chunksId   = $chkId
    top20Count = 0
    driftCount = 0
    driftRows  = @()
    chunkAudit = $DoChunks
    chunkRows  = @()
    warnings   = $warnings
  }
  $path = Join-Path (Get-Location) ("Dive6b_Report__" + (Get-Date -Format 'yyyyMMdd_HHmmss') + ".json")
  $report | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 $path
  Write-Host "* Dive 6b complete."
  Write-Host ("Drift rows : {0}" -f 0)
  if($DoChunks){ Write-Host ("Chunk rows : {0}" -f 0) }
  Write-Host ("Warnings  : {0}" -f ($warnings -join " | "))
  Write-Host ("Saved report -> {0}" -f $path)
  return
}

# ---- 2) Export INDEX and parse top 20 ----------------------------------------
$idxExport = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$idxId } }
$idxText   = (ItemOf $idxExport).text
$index     = @()
if(-not [string]::IsNullOrWhiteSpace($idxText)){
  $index = $idxText | ConvertFrom-Csv
}
$top20 = $index | Select-Object -First 20

# ---- 3) Cross-check metadata (name, mime, modified, size) --------------------
$drifts = New-Object System.Collections.Generic.List[object]

foreach($row in $top20){
  $metaResp = Rpc 'tools/call' @{ name='drive.get'; arguments=@{ id=$row.id } }
  $live     = ItemOf $metaResp

  # v2 (index) vs v3 (live) mapping
  $csvName = $row.title
  $csvMime = $row.mimeType
  $csvMod  = if($row.modifiedDate){ $row.modifiedDate } else { $row.modifiedTime }
  $csvSize = if($row.fileSize){ $row.fileSize } else { $row.size }

  if($csvName -ne $live.name){
    $drifts.Add([pscustomobject]@{ id=$row.id; field='name'; csv=$csvName; live=$live.name })
  }

  if($csvMime -ne $live.mimeType){
    $drifts.Add([pscustomobject]@{ id=$row.id; field='mime'; csv=$csvMime; live=$live.mimeType })
  }

  $liveMod  = $live.modifiedTime
  if( (Iso $csvMod) -ne (Iso $liveMod) ){
    $drifts.Add([pscustomobject]@{ id=$row.id; field='modified'; csv=$csvMod; live=$liveMod })
  }

  $liveSize = if($live.size){ $live.size } else { $live.fileSize }
  if( ("$csvSize") -ne ("$liveSize") ){
    $drifts.Add([pscustomobject]@{ id=$row.id; field='size'; csv="$csvSize"; live="$liveSize" })
  }
}

# ---- 4) Optional chunk audit (newline-aware 6000/400) ------------------------
$chunkRows = New-Object System.Collections.Generic.List[object]

function ChunkMeta([string]$text,[int]$window=6000,[int]$overlap=400){
  if([string]::IsNullOrEmpty($text)){ return @() }
  $out = New-Object System.Collections.Generic.List[object]
  $step = [Math]::Max(1, $window - $overlap)
  $pos = 0
  while($pos -lt $text.Length){
    $end = [Math]::Min($text.Length, $pos + $window)
    $slice = $text.Substring($pos, $end - $pos)
    $nl = $slice.LastIndexOf("`n")
    if($nl -ge 0 -and ($slice.Length - $nl) -le 500){
      $slice = $slice.Substring(0, $nl + 1)
      $end = $pos + $slice.Length
    }
    $out.Add([pscustomobject]@{ idx=$out.Count; start=$pos; end=$end; len=$slice.Length })
    if($end -eq $text.Length){ break }
    $pos = [Math]::Min($text.Length, $pos + $step)
  }
  return $out
}

if($DoChunks -and -not [string]::IsNullOrWhiteSpace($chkId)){
  $chkExport = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$chkId } }
  $chkText   = (ItemOf $chkExport).text
  $chunksCsv = @()
  if(-not [string]::IsNullOrWhiteSpace($chkText)){
    $chunksCsv = $chkText | ConvertFrom-Csv
  }

  if($chunksCsv -and $chunksCsv.Count -gt 0){
    # choose 3 files (prefer those with many chunks)
    $ids = ($chunksCsv | Group-Object id | Sort-Object Count -Descending | Select-Object -First 3).Name
    foreach($fid in $ids){
      $sample = $chunksCsv | Where-Object { $_.id -eq $fid } | Sort-Object {[int]$_.chunkIndex} | Select-Object -First 5
      $e      = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$fid } }
      $txt    = (ItemOf $e).text

      $calc = ChunkMeta $txt 6000 400 | Select-Object -First $sample.Count
      for($i=0; $i -lt $sample.Count; $i++){
        $csv = $sample[$i]; $c = $calc[$i]
        $ok  = $false
        if($c -ne $null){
          $ok = ([int]$csv.start -eq $c.start) -and ([int]$csv.end -eq $c.end) -and ([int]$csv.length -eq $c.len)
        }
        $chunkRows.Add([pscustomobject]@{
          id=$fid; idx=$i; ok=$ok;
          csv_idx=[int]$csv.chunkIndex; csv_start=[int]$csv.start; csv_end=[int]$csv.end; csv_len=[int]$csv.length;
          calc_start= if($c){$c.start}else{$null}; calc_end= if($c){$c.end}else{$null}; calc_len= if($c){$c.len}else{$null}
        })
      }
    }
  } else {
    $warnings.Add("WARNING: CHUNKS CSV was empty or unavailable")
  }
} elseif($DoChunks) {
  $warnings.Add("WARNING: CHUNKS__LATEST not found (chunk audit skipped)")
}

# ---- 5) Report ---------------------------------------------------------------
$report = [pscustomobject]@{
  when        = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
  indexId     = $idxId
  chunksId    = $chkId
  top20Count  = $top20.Count
  driftCount  = $drifts.Count
  driftRows   = $drifts
  chunkAudit  = $DoChunks
  chunkRows   = $chunkRows
  warnings    = $warnings
}

$path = Join-Path (Get-Location) ("Dive6b_Report__" + (Get-Date -Format 'yyyyMMdd_HHmmss') + ".json")
$report | ConvertTo-Json -Depth 8 | Out-File -Encoding utf8 $path

Write-Host "* Dive 6b complete."
Write-Host ("Drift rows : {0}" -f $drifts.Count)
if($DoChunks){ Write-Host ("Chunk rows : {0}" -f $chunkRows.Count) }
if($warnings.Count -gt 0){ Write-Host ("Warnings  : {0}" -f ($warnings -join " | ")) }
Write-Host ("Saved report -> {0}" -f $path)
