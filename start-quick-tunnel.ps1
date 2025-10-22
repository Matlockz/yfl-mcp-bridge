# start-quick-tunnel.ps1 — launches the bridge + a Quick Tunnel
# 1) Ensure .env has: PORT=5050, BRIDGE_TOKEN=..., GAS_BASE_URL=..., ALLOW_ORIGINS=http://localhost:6274, *.trycloudflare.com
# 2) Run this with PowerShell 7

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# 1) Start the bridge
$env:PORT = "5050"
$env:BRIDGE_TOKEN = "$env:BRIDGE_TOKEN"
$env:GAS_BASE_URL = "$env:GAS_BASE_URL"
$env:ALLOW_ORIGINS = "http://localhost:6274, *.trycloudflare.com"

Write-Host "Starting bridge (server.mjs)..." -ForegroundColor Cyan
$node = Start-Process -FilePath "node" -ArgumentList "server.mjs" -PassThru

Start-Sleep -Seconds 2

# 2) Start a Quick Tunnel pointing to localhost:5050
Write-Host "Starting Quick Tunnel to http://localhost:5050 ..." -ForegroundColor Cyan
cloudflared tunnel --url http://localhost:5050
