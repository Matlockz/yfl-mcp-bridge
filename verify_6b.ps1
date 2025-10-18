param(
  [Parameter(Mandatory=$true)][string]$Base,
  [Parameter(Mandatory=$true)][string]$Token,
  [Parameter()][bool]$DoChunks = $false
)

function H_([string]$token){
  return @{
    'Content-Type' = 'application/json'
    'MCP-Protocol-Version' = '2024-11-05'
  }
}

function Rpc([string]$Base,[string]$Token,[string]$Method,[hashtable]$Params = $null){
  $mcp = "$Base/mcp?token=$Token"
  $body = @{ jsonrpc='2.0'; id=[guid]::NewGuid().ToString(); method=$Method }
  if($Params){ $body['params'] = $Params }
  $resp = Invoke-RestMethod -Uri $mcp -Method Post -Headers (H_ $Token) -Body ($body | ConvertTo-Json -Depth 7)
  if($resp.error){ throw ("RPC error {0}: {1}" -f $resp.error.code, $resp.error.message) }
  if($resp.PSObject.Properties.Name -contains 'result'){ return $resp.result } else { return $resp }
}

function FirstIdFromSearch($searchResult){
  if($searchResult -and $searchResult.structuredContent -and $searchResult.structuredContent.items -and $searchResult.structuredContent.items.Count -gt 0){
    return $searchResult.structuredContent.items[0].id
  }
  if($searchResult -and $searchResult.content){
    foreach($c in $searchResult.content){
      if($c.text){
        try{
          $j = $c.text | ConvertFrom-Json
          if($j.items -and $j.items.Count -gt 0 -and $j.items[0].id){ return $j.items[0].id }
        }catch{}
      }
    }
  }
  throw "Search returned no items"
}

function ExportTextFromResult($exportResult){
  if($exportResult -and $exportResult.structuredContent -and $exportResult.structuredContent.item){
    $it = $exportResult.structuredContent.item
    if($it.text){ return $it.text }
    if($it.base64){ $bytes=[Convert]::FromBase64String($it.base64); return [Text.Encoding]::UTF8.GetString($bytes) }
  }
  if($exportResult -and $exportResult.content){
    foreach($c in $exportResult.content){
      if($c.text){
        try{
          $j = $c.text | ConvertFrom-Json
          if($j.item){
            if($j.item.text){ return $j.item.text }
            if($j.item.base64){ $bytes=[Convert]::FromBase64String($j.item.base64); return [Text.Encoding]::UTF8.GetString($bytes) }
          }
        }catch{}
      }
    }
  }
  return $null
}

function Iso([string]$s){
  if([string]::IsNullOrWhiteSpace($s)){ return '' }
  try{ return ([datetime]$s).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }catch{ return $s }
}

function ChunkMeta([string]$text, [int]$window = 6000, [int]$overlap = 400){
  $out = New-Object System.Collections.Generic.List[object]
  if([string]::IsNullOrEmpty($text)){ return $out }
  $step = [Math]::Max(1, $window - $overlap)
  $pos = 0
  while($pos -lt $text.Length){
    $end = [Math]::Min($text.Length, $pos + $window)
    $slice = $text.Substring($pos, $end - $pos)
    $nl = $slice.LastIndexOf("`n")
    if($nl -gt -1 -and ($slice.Length - $nl) -le 500){
      $end = $pos + $nl + 1
      $slice = $text.Substring($pos, $end - $pos)
    }
    $out.Add([pscustomobject]@{ start = $pos; end = $end; len = $slice.Length })
    if($end -eq $text.Length){ break }
    $pos = [Math]::Min($text.Length, $pos + $step)
  }
  return $out
}

Write-Host "[Start] Dive 6b verification"

# Gate check: drive.search, drive.get, drive.export must be present
$toolsList = Rpc $Base $Token 'tools/list'
$have = @()
if($toolsList.tools){
  foreach($t in $toolsList.tools){
    if($t -is [string]){
      $m = [regex]::Match($t, 'name\s*=\s*([^;}]*)')
      if($m.Success){ $have += $m.Groups[1].Value }
    } elseif($t.name){ $have += $t.name }
  }
}
$need = @('drive.search','drive.get','drive.export')
foreach($n in $need){ if(-not ($have -contains $n)){ throw ("Missing required tool: {0}" -f $n) } }

# Resolve LATEST CSVs
$idxSearch = Rpc $Base $Token 'tools/call' @{ name='drive.search'; arguments=@{ query='title = "Transcripts__INDEX__LATEST.csv" and trashed = false'; limit=1 } }
$idxId = FirstIdFromSearch $idxSearch
$idxExport = Rpc $Base $Token 'tools/call' @{ name='drive.export'; arguments=@{ id=$idxId } }
$idxCsvText = ExportTextFromResult $idxExport
if([string]::IsNullOrWhiteSpace($idxCsvText)){ throw "Failed to export INDEX__LATEST.csv" }
$top20 = $idxCsvText | ConvertFrom-Csv | Select-Object -First 20

# Cross-check (top 20)
$drift = New-Object System.Collections.Generic.List[object]
foreach($row in $top20){
  $live = Rpc $Base $Token 'tools/call' @{ name='drive.get'; arguments=@{ id=$row.id } }
  $item = $null
  if($live.structuredContent -and $live.structuredContent.item){ $item = $live.structuredContent.item }
  elseif($live.content -and $live.content[0].text){ try{ $item = ($live.content[0].text | ConvertFrom-Json).item }catch{} }
  if(-not $item){ continue }

  $csvName = $row.title
  $csvMime = $row.mimeType
  $csvMod  = if($row.modifiedDate){ Iso $row.modifiedDate } elseif($row.modifiedTime){ Iso $row.modifiedTime } else { '' }
  $csvSize = if($row.fileSize){ $row.fileSize } elseif($row.size){ $row.size } else { '' }

  $liveName = if($item.name){ $item.name } elseif($item.title){ $item.title } else { '' }
  $liveMime = $item.mimeType
  $liveMod  = Iso $item.modifiedTime
  $liveSize = if($item.size){ $item.size } elseif($item.fileSize){ $item.fileSize } else { '' }

  if($csvName -ne $liveName){ $drift.Add([pscustomobject]@{ id=$row.id; field='name';     csv=$csvName; live=$liveName }) }
  if($csvMime -ne $liveMime){ $drift.Add([pscustomobject]@{ id=$row.id; field='mime';     csv=$csvMime; live=$liveMime }) }
  if($csvMod  -ne $liveMod ){ $drift.Add([pscustomobject]@{ id=$row.id; field='modified'; csv=$csvMod;  live=$liveMod  }) }
  if($csvSize -ne $liveSize){ $drift.Add([pscustomobject]@{ id=$row.id; field='size';     csv=$csvSize; live=$liveSize }) }
}

# Optional: 3-file chunk audit
$chunkRows = @()
if($DoChunks){
  $chkSearch = Rpc $Base $Token 'tools/call' @{ name='drive.search'; arguments=@{ query='title = "Transcripts__CHUNKS__LATEST.csv" and trashed = false'; limit=1 } }
  $chkId = FirstIdFromSearch $chkSearch
  $chkExport = Rpc $Base $Token 'tools/call' @{ name='drive.export'; arguments=@{ id=$chkId } }
  $chunksCsvText = ExportTextFromResult $chkExport
  if([string]::IsNullOrWhiteSpace($chunksCsvText)){ throw "Failed to export CHUNKS__LATEST.csv" }
  $chunks = $chunksCsvText | ConvertFrom-Csv

  $ids = @()
  foreach($r in $top20){ if(-not ($ids -contains $r.id)){ $ids += $r.id }; if($ids.Count -ge 3){ break } }

  foreach($fid in $ids){
    $exp = Rpc $Base $Token 'tools/call' @{ name='drive.export'; arguments=@{ id=$fid } }
    $text = ExportTextFromResult $exp
    if([string]::IsNullOrWhiteSpace($text)){ continue }
    $calc = ChunkMeta $text 6000 400 | Select-Object -First 5
    $csvParts = $chunks | Where-Object { $_.id -eq $fid } | Sort-Object {[int]$_.chunkIndex} | Select-Object -First 5
    for($i=0; $i -lt $calc.Count; $i++){
      $have = if($i -lt $csvParts.Count){ $csvParts[$i] } else { $null }
      if(-not $have){
        $chunkRows += [pscustomobject]@{ id=$fid; idx=$i; ok=$false; csv_idx=$null; csv_start=$null; csv_end=$null; csv_len=$null; calc_start=$calc[$i].start; calc_end=$calc[$i].end; calc_len=$calc[$i].len }
      }else{
        $ok = ([int]$have.chunkIndex -eq ($i+1)) -and ([int]$have.start -eq $calc[$i].start) -and ([int]$have.end -eq $calc[$i].end) -and ([int]$have.length -eq $calc[$i].len)
        $chunkRows += [pscustomobject]@{
          id=$fid; idx=$i; ok=$ok
          csv_idx=[int]$have.chunkIndex; csv_start=[int]$have.start; csv_end=[int]$have.end; csv_len=[int]$have.length
          calc_start=$calc[$i].start;     calc_end=$calc[$i].end;   calc_len=$calc[$i].len
        }
      }
    }
  }
}

# Report
$report = [pscustomobject]@{
  when       = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
  indexId    = $idxId
  top20Count = ($top20 | Measure-Object).Count
  driftCount = ($drift | Measure-Object).Count
  driftRows  = $drift
  chunkAudit = $DoChunks
  chunkRows  = $chunkRows
}
$json = $report | ConvertTo-Json -Depth 8
$path = Join-Path (Get-Location) ("Dive6b_Report__" + (Get-Date -Format 'yyyyMMdd_HHmmss') + ".json")
$json | Out-File -Encoding UTF8 -FilePath $path

Write-Host ""
Write-Host "* Dive 6b complete."
Write-Host ("Drift rows : {0}" -f $report.driftCount)
Write-Host ("Chunk rows : {0}" -f (($chunkRows | Measure-Object).Count))
Write-Host ("Saved report -> {0}" -f $path)
