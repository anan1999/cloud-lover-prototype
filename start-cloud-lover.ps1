$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $Root ".env.local"
$ExampleFile = Join-Path $Root ".env.local.example"

if (-not (Test-Path $EnvFile)) {
  Copy-Item -LiteralPath $ExampleFile -Destination $EnvFile
  Write-Host "Created .env.local from template."
}

Set-Location $Root
Write-Host "Starting Cloud Lover server..."
Write-Host "Provider settings are loaded from: $EnvFile"
node server.js
