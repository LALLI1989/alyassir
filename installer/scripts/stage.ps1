# Collects everything the installer ships into installer/stage, then compiles setup.exe.
param([string]$Version = "0.0.1")
$ErrorActionPreference = "Stop"
trap { Write-Host "::error title=stage::$($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"; exit 1 }
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
# Flat node_modules (no links), so Inno Setup copies a plain folder tree.
pnpm --filter "@alyassir/server" --config.node-linker=hoisted deploy --prod --legacy "$stage\server"
if ($LASTEXITCODE -ne 0) { throw "pnpm deploy failed" }
Pop-Location
Copy-Item "$vendor\node.exe" "$stage\server\node.exe"
# Phase 8A: the server-only tool behind the "reset the manager's password" shortcut.
New-Item -ItemType Directory -Force -Path "$stage\server\tools" | Out-Null
Copy-Item (Join-Path $root "tools\reset-manager.ps1") "$stage\server\tools\reset-manager.ps1"
if (-not (Test-Path "$stage\server\dist\main.js")) { throw "Server build missing from stage" }
# Smoke test: the setup helper and all its modules load with the bundled Node.js.
$smoke = & "$stage\server\node.exe" "$stage\server\dist\setup\cli.js" check-port --port 4999 2>&1
if ($LASTEXITCODE -ne 0) { throw "Setup helper does not start from the stage folder: $smoke" }

# PostgreSQL and WinSW
Copy-Item -Recurse "$vendor\pgsql" "$stage\pgsql"
Copy-Item "$vendor\WinSW-x64.exe" "$stage\service\WinSW-x64.exe"

$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw "Inno Setup 6 (ISCC.exe) not found" }
$isccOut = & $iscc "/DAppVersion=$Version" "/DStageDir=$stage" (Join-Path $root "alyassir.iss") 2>&1
$isccOut | Write-Host
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compile failed: $(($isccOut | Select-Object -Last 8) -join ' | ')" }
Get-ChildItem (Join-Path $root "output")
