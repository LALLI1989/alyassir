# End-to-end test of the real installer on a clean GitHub Windows machine.
# Each scenario prints PASS/FAIL in plain words; any FAIL stops the run.
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  # Installer of the previous phase, to test the update path (optional).
  [string]$PreviousSetup = ""
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$App = "$env:ProgramFiles\Alyassir"
$Data = "$env:ProgramData\Alyassir"
$Port = 4100
$Rule = "Alyassir Server (TCP $Port)"
$Logs = Join-Path $env:RUNNER_TEMP "alyassir-logs"
$BackupDir = "C:\AlyassirDrive"
$ManagerPass = "Gerant-2026"
New-Item -ItemType Directory -Force -Path $Logs, $BackupDir | Out-Null
$Bootstrap = @("/AGENCY=وكالة اليسير للتأمين", "/MANAGER=gerant", "/MANAGERPASS=$ManagerPass", "/BACKUPDIR=$BackupDir")
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

function Install([string[]]$extra, [string]$exe = $Setup) {
  $script:Run++
  $log = Join-Path $Logs "setup-$($script:Run).log"
  $argList = @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LANG=ar", "/LOG=`"$log`"") + ($extra | ForEach-Object { if ($_ -match " ") { "`"$_`"" } else { $_ } })
  Write-Host "> setup $(($argList | Where-Object { $_ -notlike '*PASS*' }) -join ' ')"
  $p = Start-Process -FilePath $exe -ArgumentList $argList -Wait -PassThru
  Write-Host "  exit code $($p.ExitCode)"
  return $p.ExitCode
}

function Uninstall {
  Start-Process "$App\unins000.exe" -ArgumentList "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART" -Wait | Out-Null
  Wait-FilesRemoved
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

# Calls the API like the desktop app (version and device headers). Returns { status, body }.
function Api([string]$method, [string]$path, $body = $null, [string]$token = "") {
  $out = Join-Path $env:RUNNER_TEMP "api-out.json"
  $curlArgs = @("-sk", "--max-time", "20", "-o", $out, "-w", "%{http_code}", "-X", $method,
    "-H", "content-type: application/json", "-H", "x-alyassir-client-version: 0.1.0", "-H", "x-alyassir-device: CI-WINDOWS", "-H", "x-alyassir-user-active: 1")
  if ($token) { $curlArgs += @("-H", "authorization: Bearer $token") }
  if ($null -ne $body) {
    $in = Join-Path $env:RUNNER_TEMP "api-in.json"
    [System.IO.File]::WriteAllText($in, ($body | ConvertTo-Json -Compress -Depth 5), [System.Text.UTF8Encoding]::new($false))
    $curlArgs += @("--data-binary", "@$in")
  }
  $status = & curl.exe @curlArgs "https://127.0.0.1:$Port$path"
  $text = if (Test-Path $out) { [System.IO.File]::ReadAllText($out) } else { "" }
  Remove-Item $out -ErrorAction SilentlyContinue
  $parsed = $null
  if ($text) { try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $text } }
  return [pscustomobject]@{ status = [int]$status; body = $parsed }
}

function Login([string]$user, [string]$pass) {
  return Api "POST" "/api/auth/login" @{ username = $user; password = $pass }
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

function Psql([string]$user, [string]$password, [string]$sql) {
  $env:PGPASSWORD = $password
  try { return (& "$App\pgsql\bin\psql.exe" -h 127.0.0.1 -p 5433 -U $user -d alyassir -tAc $sql 2>&1) }
  finally { Remove-Item Env:\PGPASSWORD }
}

function Wipe-Everything {
  if (Test-Path "$App\unins000.exe") { Uninstall }
  if (Test-Path $Data) { Remove-Item -Recurse -Force $Data }
}

try {
  Write-Host "`n=== 1. Port already used by another program ==="
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
  $listener.Start()
  try { $code = Install (@("/MODE=server", "/PORT=$Port") + $Bootstrap) } finally { $listener.Stop() }
  Check ($code -eq 10) "setup reports failure"
  Check ((IniValue "code") -eq "E_API_PORT_IN_USE") "error code says the port is in use"
  Wait-FilesRemoved
  Assert-NothingLeft "port in use"

  Write-Host "`n=== 2. Failure at the very last step: everything must be rolled back ==="
  $code = Install (@("/MODE=server", "/PORT=$Port", "/SIMULATEFAIL=health") + $Bootstrap)
  Check ($code -eq 10) "setup reports failure"
  Check ((IniValue "code") -eq "E_SIMULATED") "failure happened at the final health step"
  Wait-FilesRemoved
  Assert-NothingLeft "rollback"
  Check (Wait-Until { -not (Get-NetTCPConnection -State Listen -LocalPort 5433 -ErrorAction SilentlyContinue) } 30) "database port 5433 is free again"
  Check (-not (Test-Path "$env:TEMP\is-*\bootstrap.txt")) "the manager's password file does not remain"
  Wipe-Everything

  if ($PreviousSetup) {
    Write-Host "`n=== 3. Update of a server installed by the previous phase (Phase 0) ==="
    $code = Install @("/MODE=server", "/PORT=$Port") $PreviousSetup
    Check ($code -eq 0) "Phase 0 server installed"
    $code = Install $Bootstrap
    Check ($code -eq 0) "update succeeded"
    Check ((Get-ChildItem "$Data\backups\pre-update-*.dump").Count -ge 1) "automatic backup taken before updating the database"
    $s = Login "gerant" $ManagerPass
    Check ($s.status -eq 200 -and $s.body.me.role -eq "manager") "the manager created during the update can sign in"
    Wipe-Everything
  }

  Write-Host "`n=== 4. Real server installation ==="
  $code = Install (@("/MODE=server", "/PORT=$Port") + $Bootstrap)
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
  foreach ($dir in @("$Data\pgdata", "$Data\secrets", "$Data\certs", "$Data\service", "$Data\backups")) { Assert-Private $dir }

  $secrets = Get-Content "$Data\secrets\secrets.json" | ConvertFrom-Json
  foreach ($setting in @("fsync", "synchronous_commit", "full_page_writes")) {
    Check ((Psql "alyassir" $secrets.dbPassword "SHOW $setting").Trim() -eq "on") "database durability: $setting = on"
  }
  $v = (Psql "alyassir" $secrets.dbPassword "SHOW server_version").Trim()
  Check ($v -like "16.*") "database is PostgreSQL 16 ($v)"
  $xml = Get-Content "$Data\service\AlyassirServer.xml" -Raw
  Check ($xml -match "postgres://alyassir_app:") "the server runs with the limited database account"
  $denied = Psql "alyassir_app" $secrets.appPassword "UPDATE audit_log SET action = 'x'"
  Check ("$denied" -match "permission denied") "the server's account cannot change the audit log"
  $denied = Psql "alyassir" $secrets.dbPassword "DELETE FROM audit_log"
  Check ("$denied" -match "append-only") "even the database owner cannot delete the audit log"

  Write-Host "`n=== 5. First manager, sign-in and permissions over HTTPS ==="
  $s = Login "gerant" $ManagerPass
  Check ($s.status -eq 200 -and $s.body.me.role -eq "manager" -and $s.body.me.language -eq "ar") "the manager typed in the installer signs in"
  $token = $s.body.accessToken
  $agency = Api "GET" "/api/settings/agency" $null $token
  $expectedName = "وكالة اليسير للتأمين"
  $gotCodes = (([int[]][char[]]"$($agency.body.nameAr)") | ForEach-Object { $_.ToString("X4") }) -join " "
  $wantCodes = (([int[]][char[]]$expectedName) | ForEach-Object { $_.ToString("X4") }) -join " "
  Write-Host "  agency name received: $gotCodes"
  Write-Host "  agency name expected: $wantCodes"
  Check ($agency.body.nameAr -eq $expectedName) "agency name in Arabic saved correctly (received: $gotCodes / expected: $wantCodes)"
  Check ($agency.body.backupDir -eq $BackupDir) "Google Drive backup folder saved"
  $emp = Api "POST" "/api/users" @{ username = "salma"; displayName = "سلمى"; password = "salma-pass" } $token
  Check ($emp.status -eq 201) "the manager creates an employee"
  $bad = Login "gerant" "wrong-password"
  Check ($bad.status -eq 401 -and $bad.body.code -eq "INVALID_CREDENTIALS") "wrong password refused"
  $es = Login "salma" "salma-pass"
  Check ((Api "GET" "/api/users" $null $es.body.accessToken).body.code -eq "FORBIDDEN") "an employee cannot manage users"

  Write-Host "`n=== 6. Desktop app connection logic (fingerprint check, realtime link) ==="
  $env:ALYASSIR_TEST_URL = $url
  $env:ALYASSIR_TEST_FINGERPRINT = $fingerprint
  $env:ALYASSIR_TEST_TOKEN = (Login "gerant" $ManagerPass).body.accessToken
  Push-Location "$PSScriptRoot\..\..\apps\desktop\src-tauri"
  cargo test -p server-link --release -- --nocapture
  $cargoCode = $LASTEXITCODE
  Pop-Location
  Check ($cargoCode -eq 0) "app sees the same fingerprint, refuses another, and the realtime link works over the pinned certificate"

  Write-Host "`n=== 7. A failed update never loses data ==="
  $code = Install @("/SIMULATEFAIL=api-start")
  Check ($code -eq 10) "the update reports failure"
  Check ((Psql "alyassir" $secrets.dbPassword "SELECT count(*) FROM users WHERE username = 'salma'").Trim() -eq "1") "the employee is still in the database after the failed update"
  Check (Test-Path "$App\unins000.exe") "the existing installation is kept (not uninstalled)"
  $code = Install @()
  Check ($code -eq 0) "the next update succeeds"
  Check ((Login "salma" "salma-pass").status -eq 200) "the employee signs in after the update"
  Check ((Get-ChildItem "$Data\backups\pre-update-*.dump").Count -ge 2) "a backup was taken before each update"

  Write-Host "`n=== 8. Restart (like turning the server computer off and on) ==="
  Stop-Service AlyassirServer
  Stop-Service AlyassirPostgres -Force
  Check ($null -eq (Health)) "server is really stopped"
  Start-Service AlyassirServer   # starts the database first, by itself
  Check (Wait-Until { $x = Health; $x -and $x.status -eq "ok" } 120) "server and database come back by themselves"

  Write-Host "`n=== 9. Server program crashes ==="
  $node = Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$App\server\*" }
  Check ($node) "server program found"
  $node | Stop-Process -Force
  Check (Wait-Until { $x = Health; $x -and $x.status -eq "ok" } 120) "Windows restarts the server program automatically"

  Write-Host "`n=== 10. Uninstall keeps the data ==="
  Uninstall
  Check ($null -eq (Get-Service AlyassirServer -ErrorAction SilentlyContinue)) "API service removed"
  Check ($null -eq (Get-Service AlyassirPostgres -ErrorAction SilentlyContinue)) "database service removed"
  Check ($null -eq (Get-NetFirewallRule -DisplayName $Rule -ErrorAction SilentlyContinue)) "firewall rule removed"
  Check (Test-Path "$Data\pgdata\PG_VERSION") "database files are kept (never deleted)"

  Write-Host "`n=== 11. Installing again never overwrites existing data ==="
  $code = Install (@("/MODE=server", "/PORT=$Port") + $Bootstrap)
  Check ($code -eq 10) "setup refuses"
  Check ((IniValue "code") -eq "E_DATA_EXISTS") "error code says data already exists"
  Wait-FilesRemoved
  Check (Test-Path "$Data\pgdata\PG_VERSION") "existing database untouched"

  Write-Host "`n=== 12. User computer installation ==="
  $code = Install @("/MODE=user")
  Check ($code -eq 0) "setup succeeded"
  Check (Test-Path "$App\desktop\Alyassir.exe") "desktop app installed"
  Check (-not (Test-Path "$App\pgsql")) "no database installed"
  Check (-not (Test-Path "$App\server")) "no server installed"
  Check ($null -eq (Get-Service AlyassirServer -ErrorAction SilentlyContinue)) "no Windows service"
  Uninstall
  Check (-not (Test-Path "$App\desktop\Alyassir.exe")) "user computer uninstall removes the app"

  Write-Host "`nALL INSTALLER TESTS PASSED"
  Annotate "notice" "Installer tests passed ($($script:Passed.Count) checks)" ($script:Passed -join "`n")
} catch {
  Annotate "error" "Installer test failed" ("$($_.Exception.Message)`n--- passed so far: $($script:Passed.Count)`n--- setup.log tail:`n" + (Tail "$Data\logs\setup.log" 40) + "`n--- helper errors:`n" + (Tail "$Data\logs\setup-helper-errors.log" 15) + "`n--- last Inno log tail:`n" + (Tail (Join-Path $Logs "setup-$($script:Run).log") 15))
  throw
} finally {
  # Keep every log for diagnosis (uploaded by the workflow). Secrets are never written to these logs.
  if (Test-Path "$Data\logs") { Copy-Item -Recurse -Force "$Data\logs" (Join-Path $Logs "data-logs") }
  if (Test-Path "$Data\setup-result.json") { Copy-Item -Force "$Data\setup-result.json" $Logs }
}
