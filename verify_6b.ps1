param(
  [Parameter(Mandatory=$true)][string]$Base,
  [Parameter(Mandatory=$true)][string]$Token,
  [bool]$DoChunks = $false
)

Write-Host "[Start] Dive 6b verification"

# --- constants / plumbing
$H   = @{ 'Content-Type'='application/json'; 'MCP-Protocol-Version'='2024-11-05' }
$mcp = "$Base/mcp?token=$Token"

function Rpc([string]$method, [hashtable]$params = $null) {
  $body = @{ jsonrpc='2.0'; id=[guid]::NewGuid().ToString('n'); method=$method }
  if ($params) { $body.params = $params }
  $json = $body | ConvertTo-Json -Depth 14
  return Invoke-RestMethod -Uri $mcp -Method Post -Headers $H -Body $json
}

function ItemsFrom($r) {
  if ($r.result) { $r = $r.result }
  if ($r.structuredContent -and $r.structuredContent.items) { return $r.structuredContent.items }
  if ($r.content) {
    $txt = ($r.content | Where-Object type -eq 'text' | Select-Object -First 1).text
    if ($txt) { try { return (ConvertFrom-Json $txt).items } catch {} }
  }
  return @()
}

function ItemFrom($r) {
  if ($r.result) { $r = $r.result }
  if ($r.structuredContent -and $r.structuredContent.item) { return $r.structuredContent.item }
  if ($r.content) { return ($r.content | Where-Object type -eq 'text' | Select-Object -First 1).text }
  return $null
}

function ExportText([string]$id) {
  $res = Rpc 'tools/call' @{ name='drive.export'; arguments=@{ id=$id } }
  $it  = ItemFrom $res
  if ($null -eq $it) { return $null }

  # 1) Structured item with 'text'
  if ($it -is [pscustomobject] -and $it.PSObject.Properties['text']) { return [string]$it.text }

  # 2) Structured item with 'text/plain'
  if ($it -is [pscustomobject] -and $it.PSObject.Properties['text/plain']) { return [string]$it.'text/plain' }

  # 3) Result delivered as a bare string payload
  if ($it -is [string]) { return $it }

  # 4) Very defensive: single-key wrapper; unwrap it
  if ($it -is [hashtable] -and $it.Keys.Count -eq 1) {
    $k = $($it.Keys | Select-Object -First 1)   # <-- subexpression required in []
    return [string]$it[$k]
  }
  return $null
}

function RequireTools([string[]]$need) {
  $tl = Rpc 'tools/list' @{}
  $names = @()
  if ($tl.result -and $tl.result.tools) { $names = $tl.result.tools   | ForEach-Object { $_.name } }
  elseif ($tl.tools)                    { $names = $tl.tools          | ForEach-Object { $_.name } }
  if (-not $names) { throw "Missing required tool(s); got: (none)" }

  foreach ($n in $need) {
    if (-not ($names -contains $n)) { throw "Missing required tool: $n" }
  }
}

# Precise instant compare (ignores format/zone differences)
function SameMoment([string]$a, [string]$b) {
  try {
    $A = [DateTimeOffset]::Parse($a, [Globalization.CultureInfo]::InvariantCulture,
                                 [System.Globalization.DateTimeStyles]::AssumeUniversal)
    $B = [DateTimeOffset]::Parse($b, [Globalization.CultureInfo]::InvariantCulture,
                                 [System.Globalization.DateTimeStyles]::AssumeUniversal)
    return $A.UtcDateTime -eq $B.UtcDateTime
  } catch { return $false }
}

# Newline-aware chunker (6,000 with 400 overlap)
function ChunkMeta([string]$text, [int]$window=6000, [int]$overlap=400) {
  $out = New-Object System.Collections.Generic.List[object]
  if ([string]::IsNullOrWhiteSpace($text)) { return $out }
  $pos  = 0
  $step = [Math]::Max(1, $window - $overlap)
  while ($pos -lt $text.Length) {
    $end   = [Math]::Min($text.Length, $pos + $window)
    $slice = $text.Substring($pos, $end - $pos)
    $nl    = $slice.LastIndexOf("`n")
    if ($nl -ge 0 -and ($slice.Length - $nl) -le 500) { $slice = $slice.Substring(0, $nl + 1); $end = $pos + $slice.Length }
    $out.Add([pscustomobject]@{ idx=$out.Count; start=$pos; end=$end; len=$slice.Length })
    if ($end -eq $text.Length) { break }
    $pos = [Math]::Min($text.Length, $pos + $step)
  }
  return $out
}

# Find an exact beacon, else fall back to latest dated file by prefix
function ResolveCsv([string]$exactName, [string]$prefix) {
  $warn = $null
  $a1 = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query=("title = '{0}' and trashed = false" -f $exactName); limit=1 } }
  $i1 = ItemsFrom $a1
  if ($i1.Count -gt 0) { return [pscustomobject]@{ id=$i1[0].id; name=$i1[0].name; warning=$null } }

  $a2 = Rpc 'tools/call' @{ name='drive.search'; arguments=@{ query=("title contains '{0}' and trashed = false" -f $prefix); limit=50 } }
  $i2 = ItemsFrom $a2
  if ($i2.Count -gt 0) {
    $best = $i2 | Where-Object { $_.name -like "$prefix*" } |
            Sort-Object @{Expression={ $_.modifiedDate ?? $_.modifiedTime ?? '1970-01-01T00:00:00Z' }} -Descending |
            Select-Object -First 1
    if ($best) {
      $warn = ("WARNING: {0} not found - fell back to '{1}'" -f $exactName, $best.name)
      return [pscustomobject]@{ id=$best.id; name=$best.name; warning=$warn }
    }
  }
  return $null
}

# --- 1) handshake / tool gate
RequireTools @('drive.search','drive.get','drive.export')

# --- 2) locate INDEX & CHUNKS beacons
$warnings = New-Object System.Collections.Generic.List[string]
$idxSel = ResolveCsv 'Transcripts__INDEX__LATEST.csv'  'Transcripts__INDEX__'
$chkSel = ResolveCsv 'Transcripts__CHUNKS__LATEST.csv' 'Transcripts__CHUNKS__'
if ($idxSel -and $idxSel.warning) { $warnings.Add($idxSel.warning) }
if ($chkSel -and $chkSel.warning) { $warnings.Add($chkSel.warning) }
if (-not $idxSel) { throw "INDEX__LATEST not found (and no fallback)" }

# --- 3) export INDEX and take top 20
$idxText = ExportText $idxSel.id
if ([string]::IsNullOrWhiteSpace($idxText)) { throw "INDEX export failed (empty)" }
$index  = $idxText | ConvertFrom-Csv
$top20  = $index | Select-Object -First 20

# --- 4) compare metadata (CSV vs live Drive v3)
$drifts = New-Object System.Collections.Generic.List[object]
foreach ($row in $top20) {
  $live = Rpc 'tools/call' @{ name='drive.get'; arguments=@{ id=$row.id } }
  $it   = ItemFrom $live
  if (-not $it) { continue }

  $csvName = $row.title
  $csvMime = $row.mimeType
  $csvMod  = $row.modifiedDate ?? $row.modifiedTime
  $csvSize = $row.fileSize     ?? $row.size

  $liveName = $it.name         ?? $it.title
  $liveMime = $it.mimeType
  $liveMod  = $it.modifiedTime ?? $it.modifiedDate
  $liveSize = $it.size         ?? $it.fileSize

  if ($csvName -ne $liveName) { $drifts.Add([pscustomobject]@{ id=$row.id; field='name';     csv=$csvName; live=$liveName }) }
  if ($csvMime -ne $liveMime) { $drifts.Add([pscustomobject]@{ id=$row.id; field='mimeType'; csv=$csvMime; live=$liveMime }) }

  if ($csvMod -and $liveMod -and -not (SameMoment $csvMod $liveMod)) {
    $drifts.Add([pscustomobject]@{ id=$row.id; field='modified'; csv=$csvMod; live=$liveMod })
  }
  if (("$csvSize") -ne ("$liveSize")) {
    $drifts.Add([pscustomobject]@{ id=$row.id; field='size'; csv="$csvSize"; live="$liveSize" })
  }
}

# --- 5) optional CHUNKS spot-check
$chunkRows = New-Object System.Collections.Generic.List[object]
if ($DoChunks -and $chkSel) {
  $chkText = ExportText $chkSel.id
  if ($chkText) {
    $chunksCsv = $chkText | ConvertFrom-Csv
    $ids = ($chunksCsv | Group-Object id | Sort-Object Count -Descending | Select-Object -First 3).Name
    foreach ($fid in $ids) {
      $sample = $chunksCsv | Where-Object { $_.id -eq $fid } |
                Sort-Object {[int]$_.chunkIndex} | Select-Object -First 5
      if (-not $sample) { continue }

      $doc = ExportText $fid
      if ([string]::IsNullOrWhiteSpace($doc)) { continue }

      $calc = ChunkMeta $doc 6000 400 | Select-Object -First $sample.Count
      for ($i=0; $i -lt $sample.Count; $i++) {
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

# --- 6) report
$report = [pscustomobject]@{
  when       = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
  indexName  = $idxSel.name
  indexId    = $($idxSel?.id ?? '')
  chunksName = $($chkSel?.name ?? '')
  chunksId   = $($chkSel?.id   ?? '')
  top20Count = $top20.Count
  driftCount = $drifts.Count
  driftRows  = $drifts
  chunkAudit = $DoChunks
  chunkRows  = $chunkRows
  warnings   = $warnings
}

$path = Join-Path (Get-Location) ("Dive6b_Report__" + (Get-Date -Format 'yyyyMMdd_HHmmss') + ".json")
$report | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 $path

Write-Host "* Dive 6b complete."
Write-Host ("Drift rows : {0}" -f $drifts.Count)
if ($DoChunks) { Write-Host ("Chunk rows : {0}" -f $chunkRows.Count) }
if ($warnings.Count -gt 0) { Write-Host ("Warnings  : {0}" -f ($warnings -join " | ")) }
Write-Host ("Saved report -> {0}" -f $path)
