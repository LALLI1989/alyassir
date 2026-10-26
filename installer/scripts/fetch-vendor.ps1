# Downloads the third-party programs bundled in the installer into installer/vendor.
# Runs on the GitHub Windows build machine. Nothing here runs on the owner's computer.
param(
  [string]$NodeMajor = "22",
  [string]$PgVersion = "16.15-1",
  [string]$WinSWVersion = "2.12.0"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Report errors as GitHub annotations, so they are readable without the raw log.
trap { Write-Host "::error title=fetch-vendor::$($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"; exit 1 }
$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root "vendor"
New-Item -ItemType Directory -Force -Path $vendor | Out-Null

function Get-File($url, $out) {
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
  $hash = (Get-FileHash -Algorithm SHA256 $out).Hash
  Write-Host "  SHA256 $hash"
  return $hash
}

# Node.js runtime for the server (verified against the official checksum list).
$sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/latest-v$NodeMajor.x/SHASUMS256.txt" -UseBasicParsing).Content
$line = ($sums -split "`n") | Where-Object { $_ -match "node-v[\d.]+-win-x64\.zip$" } | Select-Object -First 1
$expected, $nodeZipName = ($line.Trim() -split "\s+")
$nodeZip = Join-Path $vendor $nodeZipName
$hash = Get-File "https://nodejs.org/dist/latest-v$NodeMajor.x/$nodeZipName" $nodeZip
if ($hash.ToLower() -ne $expected.ToLower()) { throw "Node.js checksum mismatch" }
Expand-Archive -Force $nodeZip (Join-Path $vendor "node-extract")
$nodeExe = Get-ChildItem -Recurse (Join-Path $vendor "node-extract") -Filter node.exe | Select-Object -First 1
Copy-Item $nodeExe.FullName (Join-Path $vendor "node.exe") -Force
Write-Host "Node: $nodeZipName"

# PostgreSQL 16 binaries (EDB zip), trimmed to what the server needs.
$pgZip = Join-Path $vendor "pgsql.zip"
$pgOk = $false
foreach ($v in @($PgVersion, "16.14-1", "16.13-1", "16.12-1", "16.11-1", "16.10-1")) {
  try {
    Get-File "https://get.enterprisedb.com/postgresql/postgresql-$v-windows-x64-binaries.zip" $pgZip | Out-Null
    Write-Host "::notice title=PostgreSQL::Bundled PostgreSQL $v"
    $pgOk = $true
    break
  } catch { Write-Host "::warning title=PostgreSQL::$v not downloadable: $($_.Exception.Message)" }
}
if (-not $pgOk) { throw "No PostgreSQL 16 binaries could be downloaded" }
Expand-Archive -Force $pgZip $vendor
foreach ($extra in @("pgAdmin 4", "StackBuilder", "doc", "include", "symbols")) {
  $p = Join-Path $vendor "pgsql\$extra"
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}
& (Join-Path $vendor "pgsql\bin\postgres.exe") --version

# WinSW: runs the Node server as a Windows service.
Get-File "https://github.com/winsw/winsw/releases/download/v$WinSWVersion/WinSW-x64.exe" (Join-Path $vendor "WinSW-x64.exe") | Out-Null

# Arabic wizard texts for Inno Setup (unofficial translation from the Inno Setup project).
$langDir = Join-Path $root "languages"
New-Item -ItemType Directory -Force -Path $langDir | Out-Null
Get-File "https://raw.githubusercontent.com/jrsoftware/issrc/main/Files/Languages/Unofficial/Arabic.isl" (Join-Path $langDir "Arabic.isl") | Out-Null
