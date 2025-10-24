# Bridge_Sanity__2025-10-24.md

System Under Test: **YFL Drive Bridge** (Node)  
Version: **3.1.1n**  
Entrypoint: **server.mjs**  
Local Port: **5050**  
Public Host: **https://bridge.yflbridge.work**  
MCP URL: **https://bridge.yflbridge.work/mcp?token=v3c3NJQ4i94**  
Drive Dialect: **v2** (`title … and trashed=false`)

---

## Gates & Results

### 0) Health (Local & Tunnel)
- **Local**  
  ```powershell
  curl http://127.0.0.1:5050/health
