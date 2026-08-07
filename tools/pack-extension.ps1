$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$staging = Join-Path $env:TEMP "web-cloner-extension-pack"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null

$files = @(
  "manifest.json","background.js","content.js","popup.html","popup.css","popup.js",
  "offscreen.html","offscreen.js","config.js","README.md"
)
foreach ($f in $files) {
  $src = Join-Path $root $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $staging $f) }
}
Copy-Item (Join-Path $root "icons") (Join-Path $staging "icons") -Recurse
Copy-Item (Join-Path $root "libs") (Join-Path $staging "libs") -Recurse

$public = Join-Path $root "dashboard\public"
if (-not (Test-Path $public)) { New-Item -ItemType Directory -Path $public | Out-Null }
$zipOut = Join-Path $public "web-cloner-extension.zip"
if (Test-Path $zipOut) { Remove-Item $zipOut -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipOut -CompressionLevel Optimal
Remove-Item $staging -Recurse -Force
Write-Host "ZIP gerado:" $zipOut
Get-Item $zipOut | Format-List FullName, Length
