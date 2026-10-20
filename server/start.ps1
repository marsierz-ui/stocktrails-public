# Launcher for the Attention Tracker sync server (Windows PowerShell).
# Run from the server folder:  .\start.ps1
# If PowerShell blocks it:      powershell -ExecutionPolicy Bypass -File .\start.ps1

# Set your own secrets in the environment first (24+ random characters each);
# the server refuses to start without a strong AT_ADMIN_TOKEN.
# AT_TOKEN: the sync token (enter the same value on your phone, Sync -> token).
# AT_ADMIN_TOKEN: the password for the admin page (http://localhost:8787/admin).
# AT_ALLOW_REGISTER=1 lets new clients mint their own tokens (off by default).
if (-not $env:AT_ADMIN_TOKEN) { Write-Error "Set AT_ADMIN_TOKEN first"; exit 1 }
$env:PORT = "8787"

Set-Location -Path $PSScriptRoot

Write-Host "Admin page: http://localhost:8787/admin  (token = AT_ADMIN_TOKEN)"

if (-not (Test-Path ".\node_modules")) {
    Write-Host "Installing dependencies (first run)..."
    npm install
}

Write-Host "Starting sync server on port $($env:PORT). Press Ctrl+C to stop."
npm start
