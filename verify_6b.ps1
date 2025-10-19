param(
  [Parameter(Mandatory = $true)][string]$Base,
  [Parameter(Mandatory = $true)][string]$Token,
  [bool]$DoChunks = $false,
  [string]$IndexId = '',
  [string]$ChunksId = ''
)

# --- Setup -------------------------------------------------------
$ErrorActionPreference = 'Stop'
Write-Host "[Start] Dive 6b verification"

$H   = @{ 'Content-Type'='application/json'; 'MCP-Protocol-Version'='2024-11-05' }
$mcp = "$Base/mcp?token=$Token"

function ToJson([object]$o){ $o | ConvertTo-Json -Depth 20 -Compress }

function Rpc([string]$method, [hashtable]$params){
  $body = @{ jsonrpc='2.0'; id=[string](Get-Random); method=$method }
  if($params){ $body.params = $params }
  return Invoke-RestMethod -Uri $mcp -Method Post -Headers $H -Body (ToJson $body)
}

# ---- Helpers to normalize Bridge shapes -------------------------

function Get-TextFromExport([object]$resp){
  # Prefer structuredContent.item fields
  if($resp.structuredContent -and $resp.structuredContent.item){
    $item = $resp.structuredContent.item
    if($item.PSObject.Properties['text']){        return [string]$item.text }
    if($item.PSObject.Properties['text/plain']){  return [string]$item.'text/plain' }
    if($item.PSObject.Properties['base64']){
      $bytes = [Convert]::FromBase64String([string]$item.base64)
      return [Text.Encoding]::UTF8.GetString($bytes)
    }
  }
  # Fallback: content[0].text (Bridge often puts JSON/CSV here)
  if($resp.content){
    $node = $resp.content | Where-Object { $_.type -eq 'text' -and $_.text } | Select-Object -First 1
    if($node){ return [string]$node.text }
  }
  return ''
}

function Get-ItemsFromSearch([object]$resp){
  $out = @()

  # 1) structuredContent.items (best)
  if($resp.structuredContent -and $resp.structuredContent.items){
    foreach($raw in $resp.structuredContent.items){
      $out += Convert-SearchItem $raw
    }
  }

  # 2) content[0].text is often a JSON string with {ok, items: [...]}
  if(-not $out -or $out.Count -eq 0){
    $txt = ''
    if($resp.content){
      $node = $resp.content | Where-Object { $_.type -eq 'text' -and $_.text } | Select-Object -First 1
      if($node){ $txt = [string]$node.text }
    }
    if($txt){
      try {
        $json = $txt | ConvertFrom-Json
        if($json.items){
          foreach($raw in $json.items){ $out += Convert-SearchItem $raw }
        }
      } catch { }
    }
  }

  return $out
}

function Convert-SearchItem([object]$raw){
  # Accepts a real object, JSON object, or a PS-style string "@{id=...; name=...}"
  if($null -eq $raw){ return $null }

  if($raw -is [string]){
    # Try JSON first
    try {
      $j = $raw | ConvertFrom-Json
      if($j){
        $nm  = ( $j.name  ) ; if(-not $nm){ $nm = $j.title }
        $mod = ( $j.modifiedTime ) ; if(-not $mod){ $mod = $j.modifiedDate }
        $sz  = ( $j.size ) ; if(-not $sz){ $sz = $j.fileSize }
        return [pscustomobject]@{ id=$j.id; name=$nm; modified=$mod; size=$sz }
      }
    } catch { }

    # PS hashtable string -> pull id/name via regex
    $mId = [regex]::Match($raw, 'id=([\w\-]+)')
    $mNm = [regex]::Match($raw, 'name=([^;}]*)')
    if($mId.Success){ return [pscustomobject]@{ id=$mId.Groups[1].Value; name=$mNm.Groups[1].Value } }
    return $null
  }

  # Real object
  $nm  = if($raw.PSObject.Properties['name']){$raw.name}elseif($raw.PSObject.Properties['title']){$raw.title}else{''}
  $mod = if($raw.PSObject.Properties['modifiedTime']){$raw.modifiedTime}elseif($raw.PSObject.Properties['modifiedDate']){$raw.modifiedDate}else{''}
  $sz  = if($raw.PSObject.Properties['size']){$raw.size}elseif($raw.PSObject.Properties['fileSize']){$raw.fileSize}else{''}
  return [pscustomobject]@{ id=$raw.id; name=$nm; modified=$mod; size=$sz }
}

function Search([string]$query, [int]$limit=5){
  $r = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query=$query; limit=$limit } }
  return Get-ItemsFromSearch $r
}

function DriveGet([string]$id){
  $r = Rpc 'tools/call' @{ name='drive.get'; arguments=@{ id=$id } }
  if($r.structuredContent -and $r.structuredContent.item){ return $r.structuredContent.item }
  if($r.result -and $r.result.item){ return $r.result.item }
  if($r.item){ return $r.item }
  return $null
}

function Pick-Latest([string]$prefix){
  # exact LATEST
  $exact = Search ("title = '${prefix}LATEST.csv' and trashed = false") 1
  if($exact.Count -gt 0){
    return ,@($exact[0], @())
  }

  # fallback to newest dated
  $cand = Search ("title contains '${prefix}' and trashed = false") 50
  if($cand.Count -gt 0){
    # firm up modified by calling drive.get
    $rank = foreach($c in $cand){
      $it = DriveGet $c.id
      $mt = if($it -and $it.PSObject.Properties['modifiedTime']){$it.modifiedTime}elseif($it -and $it.PSObject.Properties['modifiedDate']){$it.modifiedDate}else{''}
      [pscustomobject]@{ id=$c.id; name=$c.name; modified=$mt }
    }
    $best = $rank | Sort-Object modified -Descending | Select-Object -First 1
    $warn = @("WARNING: {0}LATEST.csv not found — fell back to newest '{1}'" -f $prefix, $best.name)
    return ,@($best, $warn)
  }

  return ,@( $null, @("WARNING: neither {0}LATEST.csv nor any '{0}*' files were found." -f $prefix) )
}

# --- Handshake + tool gate ---------------------------------------
[void](Rpc 'initialize' @{ protocolVersion='2024-11-05' })
$tl = Rpc 'tools/list' @{}
$names =
  ( $tl.tools | ForEach-Object { if($_.name){$_.name}else{$_} } )
if(-not ($names -contains 'drive.search' -and $names -contains 'drive.get' -and $names -contains 'drive.export')){
  throw "Missing required tool(s); got: $($names -join ', ')"
}

# --- Resolve LATEST (or fallback) --------------------------------
$warnings = @()

$idxSel = $null
$chkSel = $null
if($IndexId){ $idxSel = [pscustomobject]@{ id=$IndexId; name='(override)' } }
if($ChunksId){ $chkSel = [pscustomobject]@{ id=$ChunksId; name='(override)' } }

if(-not $idxSel){
  $pair = Pick-Latest 'Transcripts__INDEX__'
  $idxSel   = $pair[0]; $warnings += $pair[1]
}
if(-not $chkSel){
  $pair = Pick-Latest 'Transcripts__CHUNKS__'
  $chkSel   = $pair[0]; $warnings += $pair[1]
}

# --- Export INDEX and parse top 20 -------------------------------
$index = @()
$top20 = @()

if($idxSel){
  $idxExport = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$idxSel.id } }
  $idxText   = Get-TextFromExport $idxExport
  if([string]::IsNullOrWhiteSpace($idxText)){ throw "INDEX__LATEST export missing" }
  $index = $idxText | ConvertFrom-Csv
  $top20 = $index | Select-Object -First 20
}

# --- Cross-check metadata (top 20) -------------------------------
$drifts = @()
foreach($row in $top20){
  $it = DriveGet $row.id
  if(-not $it){ continue }

  $csvName = if($row.PSObject.Properties['name']){$row.name}else{$row.title}
  $csvMime = $row.mimeType
  $csvMod  = if($row.PSObject.Properties['modifiedDate']){$row.modifiedDate}else{$row.modifiedTime}
  $csvSize = if($row.PSObject.Properties['fileSize']){$row.fileSize}else{$row.size}

  $liveName = if($it.PSObject.Properties['name']){$it.name}elseif($it.PSObject.Properties['title']){$it.title}else{$null}
  $liveMime = $it.mimeType
  $liveMod  = if($it.PSObject.Properties['modifiedTime']){$it.modifiedTime}elseif($it.PSObject.Properties['modifiedDate']){$it.modifiedDate}else{$null}
  $liveSize = if($it.PSObject.Properties['size']){$it.size}elseif($it.PSObject.Properties['fileSize']){$it.fileSize}else{$null}

  if("$csvName" -ne "$liveName"){ $drifts += [pscustomobject]@{ id=$row.id; field='name';     csv="$csvName"; live="$liveName" } }
  if("$csvMime" -ne "$liveMime"){ $drifts += [pscustomobject]@{ id=$row.id; field='mime';     csv="$csvMime"; live="$liveMime" } }

  if($csvMod -and $liveMod){
    if( ($csvMod.TrimEnd('Z')+'Z') -ne ($liveMod.TrimEnd('Z')+'Z') ){
      $drifts += [pscustomobject]@{ id=$row.id; field='modified'; csv="$csvMod"; live="$liveMod" }
    }
  }

  if(("$csvSize") -ne ("$liveSize")){
    $drifts += [pscustomobject]@{ id=$row.id; field='size'; csv="$csvSize"; live="$liveSize" }
  }
}

# --- Optional CHUNK audit ---------------------------------------
function ChunkMeta([string]$text,[int]$window=6000,[int]$overlap=400){
  $out=@(); $pos=0; $step=[Math]::Max(1,$window-$overlap)
  while($pos -lt $text.Length){
    $end=[Math]::Min($text.Length,$pos+$window)
    $slice=$text.Substring($pos,$end-$pos)
    $nl=$slice.LastIndexOf("`n")
    if($nl -ge 0 -and ($slice.Length - $nl) -le 500){
      $slice=$slice.Substring(0,$nl+1); $end=$pos+$slice.Length
    }
    $out += [pscustomobject]@{ idx=$out.Count; start=$pos; end=$end; len=$slice.Length }
    if($end -eq $text.Length){ break }
    $pos=[Math]::Min($text.Length,$pos+$step)
  }
  return $out
}

$chunkRows = @()
if($DoChunks -and $chkSel){
  $chkExport = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$chkSel.id } }
  $chkText   = Get-TextFromExport $chkExport
  if([string]::IsNullOrWhiteSpace($chkText)){ $warnings += "WARNING: CHUNKS export missing"; }
  else {
    $chunksCsv = $chkText | ConvertFrom-Csv
    $ids = ($chunksCsv | Group-Object id | Sort-Object Count -Descending | Select-Object -First 3).Name
    foreach($fid in $ids){
      $sample = $chunksCsv | Where-Object { $_.id -eq $fid } |
                Sort-Object {[int]$_.chunkIndex} | Select-Object -First 5
      $doc = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$fid } }
      $txt = Get-TextFromExport $doc
      if([string]::IsNullOrWhiteSpace($txt)){ continue }
      $calc = ChunkMeta $txt 6000 400 | Select-Object -First $sample.Count
      for($i=0; $i -lt $sample.Count; $i++){
        $csv=$sample[$i]; $c=$calc[$i]
        $ok = ([int]$csv.start -eq $c.start) -and ([int]$csv.end -eq $c.end) -and ([int]$csv.length -eq $c.len)
        $chunkRows += [pscustomobject]@{
          id=$fid; idx=$i; ok=$ok;
          csv_idx   = [int]$csv.chunkIndex; csv_start=[int]$csv.start; csv_end=[int]$csv.end; csv_len=[int]$csv.length;
          calc_start= $c.start;             calc_end=   $c.end;       calc_len=   $c.len
        }
      }
    }
  }
}

# --- Report ------------------------------------------------------
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
$report | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -Path $path

Write-Host "* Dive 6b complete."
Write-Host ("Drift rows : {0}" -f $drifts.Count)
if($DoChunks){ Write-Host ("Chunk rows : {0}" -f $chunkRows.Count) }
if($warnings.Count -gt 0){ Write-Host ("Warnings  : {0}" -f ($warnings -join " | ")) }
Write-Host ("Saved report -> {0}" -f $path)
