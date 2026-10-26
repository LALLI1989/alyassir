# Collects everything the installer ships into installer/stage, then compiles setup.exe.
param([string]$Version = "0.0.1")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $root
$vendor = Join-Path $root "vendor"
$stage = Join-Path $root "stage"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path "$stage\desktop", "$stage\service" | Out-Null

# Desktop app
Copy-Item "$repo\apps\desktop\src-tauri\target\release\alyassir-desktop.exe" "$stage\desktop\Alyassir.exe"

# Server: production dependencies only, plus the Node runtime
Push-Location $repo
pnpm --filter "@alyassir/server" deploy --prod --legacy "$stage\server"
if ($LASTEXITCODE -ne 0) { throw "pnpm deploy failed" }
Pop-Location
Copy-Item "$vendor\node.exe" "$stage\server\node.exe"
if (-not (Test-Path "$stage\server\dist\main.js")) { throw "Server build missing from stage" }

# PostgreSQL and WinSW
Copy-Item -Recurse "$vendor\pgsql" "$stage\pgsql"
Copy-Item "$vendor\WinSW-x64.exe" "$stage\service\WinSW-x64.exe"

$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 (ISCC.exe) not found" }
& $iscc "/DAppVersion=$Version" "/DStageDir=$stage" (Join-Path $root "alyassir.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compile failed" }
Get-ChildItem (Join-Path $root "output")
