 YFL MCP Drive Bridge

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
iwr https://yfl-mcp-bridge.onrender.com/health | Select -ExpandProperty Content

markdown
Copy code

**SSE**
curl.exe -N "https://yfl-mcp-bridge.onrender.com/mcp?token=Wt8UPTyKNKRGTUQ24NzU"

markdown
Copy code

**Initialize / tools / call**
$H=@{"Content-Type"="application/json";"MCP-Protocol-Version"="2024-11-05"}
irm https://yfl-mcp-bridge.onrender.com/mcp?token=Wt8UPTyKNKRGTUQ24NzU -Method Post -Headers $H -Body '{"jsonrpc":"2.0","id":"1","method":"initialize","params":{"protocolVersion":"2024-11-05"}}'
irm https://yfl-mcp-bridge.onrender.com/mcp?token=Wt8UPTyKNKRGTUQ24NzU -Method Post -Headers $H -Body '{"jsonrpc":"2.0","id":"2","method":"tools/list"}'
irm https://yfl-mcp-bridge.onrender.com/mcp?token=Wt8UPTyKNKRGTUQ24NzU -Method Post -Headers $H -Body '{"jsonrpc":"2.0","id":"3","method":"tools/call","params":{"name":"drive_search","arguments":{"q":"Press_Tracker","max":5}}}'
