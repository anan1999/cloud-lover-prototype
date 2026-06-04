$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $Root ".env.local"
$ExampleFile = Join-Path $Root ".env.local.example"

if (-not (Test-Path $EnvFile)) {
  Copy-Item -LiteralPath $ExampleFile -Destination $EnvFile
}

$Key = (Get-Clipboard -Raw).Trim()
if (-not $Key.StartsWith("AIza")) {
  throw "Clipboard does not look like a Gemini API key. Click Copy key in Google AI Studio first."
}

$Lines = Get-Content -LiteralPath $EnvFile
$Updated = $false
$Lines = $Lines | ForEach-Object {
  if ($_ -match "^GEMINI_API_KEY=") {
    $Updated = $true
    "GEMINI_API_KEY=$Key"
  } else {
    $_
  }
}

if (-not $Updated) {
  $Lines += "GEMINI_API_KEY=$Key"
}

Set-Content -LiteralPath $EnvFile -Value $Lines -Encoding UTF8
Write-Host "Gemini API key saved to .env.local"
