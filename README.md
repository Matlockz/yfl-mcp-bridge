YFL MCP Bridge -> forwards MCP tools to Apps Script endpoints.

Tools:
- drive_search  -> GET {GAS_BASE}/api/search?q=...&max=...&token=...
- drive_fetch   -> GET {GAS_BASE}/api/fetch?id=...&token=...

Health:
- GET /echo

MCP Endpoint (for ChatGPT New Connector):
- POST /mcp?token=${TOKEN}   (Streamable HTTP transport)
