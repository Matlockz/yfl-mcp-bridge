param(
  [Parameter(Mandatory = $true)][string]$Base,
  [Parameter(Mandatory = $true)][string]$Token,
  [bool]$DoChunks = $false
)

Write-Host "[Start] Dive 6b verification"

# ----- Constants
$Protocol = '2024-11-05'
$Headers  = @{ 'Content-Type' = 'application/json'; 'MCP-Protocol-Version' = $Protocol }
$McpUrl   = "$Base/mcp?token=$Token"

# ----- JSON-RPC helper
function Rpc([string]$method, [hashtable]$params) {
  $body = @{ jsonrpc = '2.0'; id = [guid]::NewGuid().ToString(); method = $method }
  if ($params) { $body.params = $params }
  $json = $body | ConvertTo-Json -Depth 12
  $resp = Invoke-RestMethod -Uri $McpUrl -Method Post -Headers $Headers -Body $json
  return $resp
}

# Materialize the "result" envelope if present, otherwise return the root
function Unwrap($r) {
  if ($r.result) { return $r.result }
  return $r
}

# tools/call result normalizer: get "item" first; otherwise the first text content
function ItemOf($r) {
  $u = Unwrap $r
  if ($u.structuredContent -and $u.structuredContent.item) { return $u.structuredContent.item }
  if ($u.item) { return $u.item }
  if ($u.content) {
    $t = $u.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1
    if ($t) { return @{ text = $t.text } }
  }
  return $null
}

# Get the text payload for drive.export results, handling 'text' or 'text/plain'
function ExportText([string]$id) {
  $r = Rpc 'tools/call' @{ name = 'drive.export'; arguments = @{ id = $id } }
  $it = ItemOf $r
  if ($null -eq $it) { return $null }
  if ($it.text) { return [string]$it.text }
  if ($it.'text/plain') { return [string]$it.'text/plain' }
  # Some bridges may return a single-key item with unknown key; fall back to that value
  if ($it.Keys -and $it.Keys.Count -eq 1) { return [string]$it[$it.Keys | Select-Object -First 1] }
  return $null
}

# tools/list gate
function RequireTools([string[]]$need) {
  $list = Rpc 'tools/list' @{}
  $u = Unwrap $list
  $names = @()
  if ($u.tools) { $names = $u.tools | ForEach-Object { if ($_.name) { $_.name } else { $_ } } }
  foreach ($n in $need) { if (-not ($names -contains $n)) { throw "Missing required tool: $n" } }
}

# DriveApp v2 search helper that returns parsed items array
function SearchDrive([string]$query, [int]$limit = 5) {
  $r = Rpc 'tools/call' @{ name = 'drive.search'; arguments = @{ query = $query; limit = $limit } }
  $u = Unwrap $r
  if ($u.structuredContent -and $u.structuredContent.items) { return ,$u.structuredContent.items }
  if ($u.content) {
    $t = $u.content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1
    if ($t) { $o = $t.text | ConvertFrom-Json -ErrorAction Stop; return ,$o.items }
  }
  return @()
}

# Robust latest resolver: prefer exact LATEST; otherwise best dated snapshot by prefix
function FindCsvId([string]$latestName, [string]$prefix) {
  $exact = SearchDrive ("title = '$latestName' and trashed = false") 1
  if ($exact.Count -gt 0) {
    return [pscustomobject]@{ id = $exact[0].id; name = $exact[0].name; warning = $null }
  }
  $scan = SearchDrive ("title contains '$prefix' and trashed = false") 100
  if ($scan.Count -gt 0) {
    $best = $scan | Sort-Object {
      try { [datetime]::Parse($_.modifiedDate).ToUniversalTime() } catch { Get-Date -Date 0 }
    } -Descending | Select-Object -First 1
    return [pscustomobject]@{
      id = $best.id
      name = $best.name
      warning = ("WARNING: {0} not found - fell back to ""{1}""" -f $latestName, $best.name)
    }
  }
  return $null
}

# Equality helpers -------------------------------------------------------------

# Parse any date-like string into UTC DateTime if possible
function ToUtcOrNull([object]$x) {
  if ($null -eq $x) { return $null }
  $s = [string]$x
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  try {
    # Handle RFC3339 "Z" and local formats; use DateTimeOffset to respect embedded Z/offset
    $dto = [datetimeoffset]::Parse($s, [globalization.cultureinfo]::InvariantCulture, [globalization.datetimestyles]::RoundtripKind)
    return $dto.UtcDateTime
  } catch {
    try { return ([datetime]::Parse($s)).ToUniversalTime() } catch { return $null }
  }
}

function EqUtc([object]$a, [object]$b) {
  if ($null -eq $a -and $null -eq $b) { return $true }
  if ("$a" -eq "$b") { return $true }            # exact string match short-circuit
  $ua = ToUtcOrNull $a
  $ub = ToUtcOrNull $b
  if ($ua -and $ub) { return $ua -eq $ub }
  return $false
}

# Newline-aware chunker to mirror the indexer (size 6000, overlap 400)
function Get-ChunkMeta([string]$text, [int]$window = 6000, [int]$overlap = 400) {
  $out = New-Object System.Collections.Generic.List[object]
  $len = $text.Length; $pos = 0; $idx = 0
  $step = [Math]::Max(1, $window - $overlap)
  while ($pos -lt $len) {
    $end   = [Math]::Min($len, $pos + $window)
    $slice = $text.Substring($pos, $end - $pos)
    $nl    = $slice.LastIndexOf("`n")
    if ($nl -ge 0 -and ($slice.Length - $nl) -le 500) {
      $slice = $slice.Substring(0, $nl + 1)
      $end   = $pos + $slice.Length
    }
    $out.Add([pscustomobject]@{ idx = $idx; start = $pos; end = $end; len = $slice.Length })
    if ($end -eq $len) { break }
    $pos = [Math]::Min($len, $pos + $step)
    $idx++
    if ($idx -gt 200000) { break } # safety
  }
  return $out
}

# -----------------------------------------------------------------------------
# 1) Handshake + tool gate
[void](Rpc 'initialize' @{ protocolVersion = $Protocol })
RequireTools @('drive.search', 'drive.get', 'drive.export')

# 2) Locate INDEX__LATEST and CHUNKS__LATEST (with fallback)
$warnings = New-Object System.Collections.Generic.List[string]
$idxSel = FindCsvId 'Transcripts__INDEX__LATEST.csv'  'Transcripts__INDEX__'
$chkSel = FindCsvId 'Transcripts__CHUNKS__LATEST.csv' 'Transcripts__CHUNKS__'

if (-not $idxSel) { throw "INDEX__LATEST not found (and no fallback)" }
if ($idxSel.warning) { $warnings.Add($idxSel.warning) }
if ($chkSel -and $chkSel.warning) { $warnings.Add($chkSel.warning) }

# 3) Export and parse INDEX; take top-20
$idxText = ExportText $idxSel.id
if ([string]::IsNullOrWhiteSpace($idxText)) { throw "INDEX__LATEST export missing" }
$index   = $idxText | ConvertFrom-Csv
$top20   = $index | Select-Object -First 20

# 4) Cross-check metadata on top-20 (name, mimeType, modified, size)
$drifts = New-Object System.Collections.Generic.List[object]
foreach ($row in $top20) {
  $g  = Rpc 'tools/call' @{ name = 'drive.get'; arguments = @{ id = $row.id } }
  $it = ItemOf $g
  if ($null -eq $it) { $warnings.Add("drive.get returned empty for $($row.id)"); continue }

  # CSV (v2) vs live (v3) fields
  $csvName = "$($row.title)"
  $csvMime = "$($row.mimeType)"
  $csvMod  = ($row.modifiedDate) # may be RFC3339 or localized string
  $csvSize = ($row.fileSize)     # might be blank for Google Docs

  $liveName = $it.name
  $liveMime = $it.mimeType
  $liveMod  = ($it.modifiedTime ?? $it.modifiedDate)
  $liveSize = ($it.size ?? $it.fileSize)

  if ("$csvName" -ne "$liveName") { $drifts.Add([pscustomobject]@{ id = $row.id; field = 'name';     csv = $csvName; live = $liveName }) }
  if ("$csvMime" -ne "$liveMime") { $drifts.Add([pscustomobject]@{ id = $row.id; field = 'mimeType'; csv = $csvMime; live = $liveMime }) }
  if (-not (EqUtc $csvMod $liveMod)) {
    $drifts.Add([pscustomobject]@{ id = $row.id; field = 'modified'; csv = "$csvMod"; live = "$liveMod" })
  }
  if (("$csvSize" -ne '') -and ("$csvSize" -ne "$liveSize")) {
    $drifts.Add([pscustomobject]@{ id = $row.id; field = 'size'; csv = "$csvSize"; live = "$liveSize" })
  }
}

# 5) Optional 3-file sample chunk audit
$chunkRows = @()
if ($DoChunks) {
  if ($null -eq $chkSel) { $warnings.Add('CHUNKS__LATEST was not found; skipping chunk audit.') }
  else {
    $chkText = ExportText $chkSel.id
    if ([string]::IsNullOrWhiteSpace($chkText)) { $warnings.Add('CHUNKS__LATEST export missing; skipping chunk audit.') }
    else {
      $chunksCsv = $chkText | ConvertFrom-Csv
      $ids = ($chunksCsv | Group-Object id | Sort-Object Count -Descending | Select-Object -First 3).Name
      foreach ($fid in $ids) {
        $sample = $chunksCsv | Where-Object { $_.id -eq $fid } | Sort-Object {[int]$_.chunkIndex} | Select-Object -First 5
        $txt    = ExportText $fid
        if ([string]::IsNullOrWhiteSpace($txt)) {
          $warnings.Add("drive.export empty for $fid; skipping file in chunk audit.")
          continue
        }
        $calc = Get-ChunkMeta $txt 6000 400 | Select-Object -First $sample.Count
        for ($i = 0; $i -lt $sample.Count; $i++) {
          $csv = $sample[$i]; $c = $calc[$i]
          $ok  = ([int]$csv.start -eq $c.start) -and ([int]$csv.end -eq $c.end) -and ([int]$csv.length -eq $c.len)
          $chunkRows += [pscustomobject]@{
            id=$fid; idx=$i; ok=$ok;
            csv_idx=[int]$csv.chunkIndex; csv_start=[int]$csv.start; csv_end=[int]$csv.end; csv_len=[int]$csv.length;
            calc_start=$c.start;          calc_end=$c.end;          calc_len=$c.len
          }
        }
      }
    }
  }
}

# 6) Report
$report = [pscustomobject]@{
  when       = (Get-Date).ToUniversalTime().ToString('s') + 'Z'
  indexId    = $idxSel.id
  chunksId   = (if ($chkSel) { $chkSel.id } else { '' })
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
