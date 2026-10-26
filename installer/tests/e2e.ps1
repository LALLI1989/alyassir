# End-to-end test of the real installer on a clean GitHub Windows machine.
# Each scenario prints PASS/FAIL in plain words; any FAIL stops the run.
param([Parameter(Mandatory = $true)][string]$Setup)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$App = "$env:ProgramFiles\Alyassir"
$Data = "$env:ProgramData\Alyassir"
$Port = 4100
$Rule = "Alyassir Server (TCP $Port)"
$Logs = Join-Path $env:RUNNER_TEMP "alyassir-logs"
New-Item -ItemType Directory -Force -Path $Logs | Out-Null
$script:Run = 0
$script:Passed = @()

# GitHub annotations are the only output readable without the raw log: put the essentials there.
function Annotate($level, $title, $text) {
  $enc = $text -replace "%", "%25" -replace "`r", "" -replace "`n", "%0A"
  Write-Host "::$level title=$title::$enc"
}
function Tail($path, $n = 25) { if (Test-Path $path) { (Get-Content $path -Tail $n) -join "`n" } else { "(no $path)" } }

function Check($ok, $what) {
  if ($ok) { Write-Host "  PASS  $what"; $script:Passed += $what }
  else { Write-Host "  FAIL  $what"; throw "FAILED: $what" }
}

function Install([string[]]$extra) {
  $script:Run++
  $log = Join-Path $Logs "setup-$($script:Run).log"
  $argList = @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LANG=ar", "/LOG=`"$log`"") + $extra
  Write-Host "> setup $($argList -join ' ')"
  $p = Start-Process -FilePath $Setup -ArgumentList $argList -Wait -PassThru
  Write-Host "  exit code $($p.ExitCode)"
  return $p.ExitCode
}

function Wait-Until([scriptblock]$cond, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $cond) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Wait-FilesRemoved { Wait-Until { -not (Test-Path "$App\unins000.exe") } 180 | Out-Null }

function ResultIni { Get-Content "$Data\setup-result.json.ini" -ErrorAction SilentlyContinue }
function IniValue($key) { ((ResultIni) | Where-Object { $_ -like "$key=*" } | Select-Object -First 1) -replace "^$key=", "" }

function Health {
  try {
    $json = & curl.exe -sk --max-time 5 "https://127.0.0.1:$Port/api/health"
    return ($json | ConvertFrom-Json)
  } catch { return $null }
}

function Assert-NothingLeft($label) {
  Check ($null -eq (Get-Service AlyassirServer -ErrorAction SilentlyContinue)) "$label - API service removed"
  Check ($null -eq (Get-Service AlyassirPostgres -ErrorAction SilentlyContinue)) "$label - database service removed"
  Check ($null -eq (Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue)) "$label - firewall rule removed"
  Check (-not (Test-Path "$Data\pgdata")) "$label - no half-created database left"
  Check (-not (Test-Path "$App\server")) "$label - installed program files removed"
}

function Assert-Private($path) {
  $bad = @("S-1-5-32-545", "S-1-1-0", "S-1-5-11")  # Users, Everyone, Authenticated Users
  $sids = (Get-Acl $path).Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }
  Check (-not ($sids | Where-Object { $bad -contains $_ })) "ordinary Windows users cannot open $path"
}

try {
  Write-Host "`n=== 1. Port already used by another program ==="
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
  $listener.Start()
  try { $code = Install @("/MODE=server", "/PORT=$Port") } finally { $listener.Stop() }
  Check ($code -eq 10) "setup reports failure"
  Check ((IniValue "code") -eq "E_API_PORT_IN_USE") "error code says the port is in use"
  Wait-FilesRemoved
  Assert-NothingLeft "port in use"

  Write-Host "`n=== 2. Failure at the very last step: everything must be rolled back ==="
  $code = Install @("/MODE=server", "/PORT=$Port", "/SIMULATEFAIL=health")
  Check ($code -eq 10) "setup reports failure"
  Check ((IniValue "code") -eq "E_SIMULATED") "failure happened at the final health step"
  Wait-FilesRemoved
  Assert-NothingLeft "rollback"
  Check (Wait-Until { -not (Get-NetTCPConnection -State Listen -LocalPort 5433 -ErrorAction SilentlyContinue) } 30) "database port 5433 is free again"

  Write-Host "`n=== 3. Real server installation ==="
  $code = Install @("/MODE=server", "/PORT=$Port")
  Check ($code -eq 0) "setup succeeded"
  Check ((IniValue "ok") -eq "1") "server and database tested OK before finishing"
  $fingerprint = IniValue "fingerprint"
  $url = IniValue "url0"
  Write-Host "  address: $url"
  Write-Host "  fingerprint: $fingerprint"
  Check ($fingerprint -match "^([0-9A-F]{2}:){31}[0-9A-F]{2}$") "fingerprint shown in the expected format"
  Check ($url -match "^https://\d+\.\d+\.\d+\.\d+:$Port$") "network address shown"

  foreach ($name in @("AlyassirPostgres", "AlyassirServer")) {
    $svc = Get-Service $name
    Check ($svc.Status -eq "Running") "$name is running"
    Check ($svc.StartType -eq "Automatic") "$name starts automatically with Windows"
  }

  $pgListen = @(Get-NetTCPConnection -State Listen -LocalPort 5433)
  Check ($pgListen.Count -gt 0 -and -not ($pgListen | Where-Object { $_.LocalAddress -ne "127.0.0.1" })) "database listens on 127.0.0.1:5433 only (never on the network)"
  $apiListen = @(Get-NetTCPConnection -State Listen -LocalPort $Port)
  Check ($apiListen | Where-Object { $_.LocalAddress -eq "0.0.0.0" }) "API listens on the network on port $Port"

  $fw = Get-NetFirewallRule -DisplayName $Rule
  $fwPort = $fw | Get-NetFirewallPortFilter
  Check ($fw.Enabled -eq "True" -and $fw.Direction -eq "Inbound" -and $fw.Action -eq "Allow") "firewall rule allows incoming connections"
  Check ($fw.Profile.ToString() -eq "Private") "firewall rule is for private networks only"
  Check ($fwPort.LocalPort -eq "$Port" -and $fwPort.Protocol -eq "TCP") "firewall rule is for TCP port $Port only"

  $h = Health
  Check ($h -and $h.status -eq "ok" -and $h.database -eq "ok") "health check over HTTPS: server OK, database OK"

  foreach ($dir in @("$Data\pgdata", "$Data\secrets", "$Data\certs", "$Data\service")) { Assert-Private $dir }

  $secrets = Get-Content "$Data\secrets\secrets.json" | ConvertFrom-Json
  $env:PGPASSWORD = $secrets.dbPassword
  $psql = "$App\pgsql\bin\psql.exe"
  foreach ($setting in @("fsync", "synchronous_commit", "full_page_writes")) {
    $v = (& $psql -h 127.0.0.1 -p 5433 -U alyassir -d alyassir -tAc "SHOW $setting").Trim()
    Check ($v -eq "on") "database durability: $setting = on"
  }
  $v = (& $psql -h 127.0.0.1 -p 5433 -U alyassir -d alyassir -tAc "SHOW server_version").Trim()
  Check ($v -like "16.*") "database is PostgreSQL 16 ($v)"
  Remove-Item Env:\PGPASSWORD

  Write-Host "`n=== 4. Desktop app connection logic (fingerprint check) ==="
  $env:ALYASSIR_TEST_URL = $url
  $env:ALYASSIR_TEST_FINGERPRINT = $fingerprint
  Push-Location "$PSScriptRoot\..\..\apps\desktop\src-tauri"
  cargo test -p server-link --release -- --nocapture
  $cargoCode = $LASTEXITCODE
  Pop-Location
  Check ($cargoCode -eq 0) "app sees the same fingerprint, accepts it, and refuses a different one"

  Write-Host "`n=== 5. Restart (like turning the server computer off and on) ==="
  Stop-Service AlyassirServer
  Stop-Service AlyassirPostgres -Force
  Check ($null -eq (Health)) "server is really stopped"
  Start-Service AlyassirServer   # starts the database first, by itself
  Check (Wait-Until { $x = Health; $x -and $x.status -eq "ok" } 120) "server and database come back by themselves"

  Write-Host "`n=== 6. Server program crashes ==="
  $node = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$App\server\*" }
  Check ($node) "server program found"
  $node | Stop-Process -Force
  Check (Wait-Until { $x = Health; $x -and $x.status -eq "ok" } 120) "Windows restarts the server program automatically"

  Write-Host "`n=== 7. Uninstall keeps the data ==="
  $p = Start-Process "$App\unins000.exe" -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait -PassThru
  Wait-FilesRemoved
  Check ($null -eq (Get-Service AlyassirServer -ErrorAction SilentlyContinue)) "API service removed"
  Check ($null -eq (Get-Service AlyassirPostgres -ErrorAction SilentlyContinue)) "database service removed"
  Check ($null -eq (Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue)) "firewall rule removed"
  Check (Test-Path "$Data\pgdata\PG_VERSION") "database files are kept (never deleted)"

  Write-Host "`n=== 8. Installing again never overwrites existing data ==="
  $code = Install @("/MODE=server", "/PORT=$Port")
  Check ($code -eq 10) "setup refuses"
  Check ((IniValue "code") -eq "E_DATA_EXISTS") "error code says data already exists"
  Wait-FilesRemoved
  Check (Test-Path "$Data\pgdata\PG_VERSION") "existing database untouched"

  Write-Host "`n=== 9. User computer installation ==="
  $code = Install @("/MODE=user")
  Check ($code -eq 0) "setup succeeded"
  Check (Test-Path "$App\desktop\Alyassir.exe") "desktop app installed"
  Check (-not (Test-Path "$App\pgsql")) "no database installed"
  Check (-not (Test-Path "$App\server")) "no server installed"
  Check ($null -eq (Get-Service AlyassirServer -ErrorAction SilentlyContinue)) "no Windows service"
  Start-Process "$App\unins000.exe" -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait | Out-Null
  Wait-FilesRemoved
  Check (-not (Test-Path "$App\desktop\Alyassir.exe")) "user computer uninstall removes the app"

  Write-Host "`nALL INSTALLER TESTS PASSED"
  Annotate "notice" "Installer tests passed ($($script:Passed.Count) checks)" ($script:Passed -join "`n")
} catch {
  Annotate "error" "Installer test failed" ("$($_.Exception.Message)`n--- passed so far: $($script:Passed.Count)`n--- setup.log tail:`n" + (Tail "$Data\logs\setup.log") + "`n--- helper errors:`n" + (Tail "$Data\logs\setup-helper-errors.log" 15) + "`n--- last Inno log tail:`n" + (Tail (Join-Path $Logs "setup-$($script:Run).log") 15))
  throw
} finally {
  # Keep every log for diagnosis (uploaded by the workflow). Secrets are never written to these logs.
  if (Test-Path "$Data\logs") { Copy-Item -Recurse -Force "$Data\logs" (Join-Path $Logs "data-logs") }
  if (Test-Path "$Data\setup-result.json") { Copy-Item -Force "$Data\setup-result.json" $Logs }
}
