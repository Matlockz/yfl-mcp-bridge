# YFL MCP Drive Bridge

Forwards MCP tools to Apps Script endpoints.

**Tools**
- `drive_search` → `GET {GAS_BASE}/api/search?q=...&max=...&token=...`
- `drive_fetch`  → `GET {GAS_BASE}/api/fetch?id=...&lines=...&token=...`

**Health**
- `GET /health` (bridge)

**MCP Endpoint (ChatGPT New Connector)**
- **POST** `https://yfl-mcp-bridge.onrender.com/mcp?token=Wt8UPTyKNKRGTUQ24NzU`
- **SSE discovery (legacy)** `GET https://yfl-mcp-bridge.onrender.com/mcp?token=Wt8UPTyKNKRGTUQ24NzU` with `Accept: text/event-stream`  
  (Server emits `event: endpoint` then keepalives.)

## Quick Tests

**Wake/health**
