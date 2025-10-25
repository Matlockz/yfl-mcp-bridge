# Bridge E2E Checklist (DIVE 7b)

## Preconditions
- Cloudflare **named tunnel** running interactively: `cloudflared tunnel run --token <TOKEN>`
- MCP base: `https://bridge.yflbridge.work`
- Inspector server URL: `https://bridge.yflbridge.work/mcp?token=v3c3NJQ4i94`

## Gate 1 — MCP Handshake
- HEAD /mcp = 204
- GET  /mcp = { ok: true, transport: "streamable-http" }
- initialize.protocolVersion = "2024-11-05"

## Gate 2 — Tools shape
- Tools list includes: drive.list, drive.search, drive.get, drive.export
- Each tool shows inputSchema/outputSchema

## Gate 3 — Functional
- drive.search returns >=1 item for Transcripts__INDEX__LATEST.csv
- drive.get on first id shows v2 fields (title, alternateLink, downloadUrl, iconLink, fileSize)
- drive.export (text/csv) returns non-empty text
- Pagination test returns nextPageToken

## Gate 4 — Edge cases
- Missing 'q' causes validation error
- Invalid id causes structured error
- Oversize pageSize is clamped ≤ 200

## Result
- GREEN if all gates pass; else YELLOW with issues list + repro steps.
