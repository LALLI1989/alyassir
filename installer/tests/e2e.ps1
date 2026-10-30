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
$Bootstrap = @("/TESTAGENCY=1", "/MANAGER=gerant", "/MANAGERPASS=$ManagerPass", "/BACKUPDIR=$BackupDir")
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
  $argList = @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LANG=ar", "/LOG=$log") + @($extra)
  Write-Host "> setup $(($argList | Where-Object { $_ -notlike '*PASS*' }) -join ' ')"
  # Direct Unicode process start (Start-Process went through a path that turned Arabic into "?").
  $psi = [System.Diagnostics.ProcessStartInfo]::new($exe)
  $psi.UseShellExecute = $false
  foreach ($a in $argList) { $psi.ArgumentList.Add($a) }
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
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
function Api([string]$method, [string]$path, $body = $null, [string]$token = "", [int]$seconds = 20) {
  $out = Join-Path $env:RUNNER_TEMP "api-out.json"
  $curlArgs = @("-sk", "--max-time", "$seconds", "-o", $out, "-w", "%{http_code}", "-X", $method,
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
    Write-Host "`n=== 3. Update of a server installed by the previous phase (Phase 7) ==="
    $code = Install (@("/MODE=server", "/PORT=$Port") + $Bootstrap) $PreviousSetup
    Check ($code -eq 0) "Phase 7 server installed"
    $old = Login "gerant" $ManagerPass
    Check ($old.status -eq 200) "the manager signs in on the Phase 7 server"
    $oldToken = $old.body.accessToken
    # A new Phase 7 server asks "do you have old policies?" first: no, live work at once.
    $answer = Api "POST" "/api/historical/answer" @{ hasOldPolicies = $false } $oldToken
    Check ($answer.status -eq 200 -and $answer.body.mode -eq "locked") "the manager answers no on the Phase 7 server: live work"
    $emp = Api "POST" "/api/users" @{ username = "nadia"; displayName = "Nadia"; password = "nadia-pass" } $oldToken
    Check ($emp.status -eq 201) "an employee is created before the update"
    $msg = Api "POST" "/api/messages/threads" @{ subject = "قبل التحديث"; body = "رسالة محفوظة"; to = @($emp.body.id) } $oldToken
    Check ($msg.status -eq 201) "a message is sent before the update"
    # A policy saved in Phase 7: the manager receives the empty drawer, then 1 000 MAD in cash at issue.
    $recv = Api "POST" "/api/drawer/receive" @{ shownCents = 0; countedCents = 0; reason = "" } $oldToken
    Check ($recv.status -eq 200) "the manager receives the drawer on the Phase 7 server"
    $cat = Api "GET" "/api/insurance/catalog" $null $oldToken
    $rma = @($cat.body.insurers | Where-Object { $_.name -eq "RMA" })[0].id
    $cat = Api "POST" "/api/insurance/types" @{ insurerId = $rma; name = "Assurance automobile"; requiresVehicle = $true; supportsFleet = $false } $oldToken
    $typeId = @($cat.body.types | Where-Object { $_.name -eq "Assurance automobile" })[0].id
    $months12 = @($cat.body.durations | Where-Object { $_.months -eq 12 })[0].id
    $client = Api "POST" "/api/clients" @{ kind = "individual"; fullName = "Said EL IDRISSI"; idType = "cin"; idNumber = "AB123456"; phone = "0661234567" } $oldToken
    $vehicle = Api "POST" "/api/vehicles" @{ clientId = $client.body.id; plateType = "ww"; plate = "WW123456"; fiscalPower = 6; fuel = "diesel"; brand = "Dacia Logan" } $oldToken
    $policy = Api "POST" "/api/policies" @{ idempotencyKey = [guid]::NewGuid().ToString(); clientId = $client.body.id; insuranceTypeId = $typeId; policyNumber = "POL-UPD-001"; coverageDurationId = $months12; totalAmountCents = 250000; vehicles = @(@{ vehicleId = $vehicle.body.id; certificateNumber = "ATT-UPD-001" }); finance = @{ payments = @(@{ method = "cash"; amountCents = 100000 }) } } $oldToken
    Check ($policy.status -eq 201 -or $policy.status -eq 200) "a policy of 2 500 MAD (1 000 paid in cash) is saved before the update"
    $today = (Get-Date).ToString("yyyy-MM-dd")
    $claim = Api "POST" "/api/claims" @{ policyId = $policy.body.id; accidentDate = $today; place = "Casablanca"; description = "Choc"; requestedCents = 500000 } $oldToken
    Check ($claim.status -eq 201) "a claim is declared before the update"
    Check ((Api "GET" "/api/me/recovery-code" $null $oldToken).status -eq 404) "the Phase 7 server has no recovery code yet"

    $code = Install @()
    Check ($code -eq 0) "update to Phase 8A succeeded"
    Check ((Get-ChildItem "$Data\backups\pre-update-*.dump").Count -ge 1) "automatic backup taken before updating the database"
    $new = Login "gerant" $ManagerPass
    Check ($new.status -eq 200 -and $new.body.me.role -eq "manager") "the manager still signs in after the update"
    $newToken = $new.body.accessToken
    Check ((Login "nadia" "nadia-pass").status -eq 200) "the employee created before the update still signs in"
    $threads = Api "GET" "/api/messages/threads" $null $newToken
    Check (@($threads.body | Where-Object { $_.subject -eq "قبل التحديث" }).Count -eq 1) "the message sent before the update is still there"
    $finance = Api "GET" "/api/policies/$($policy.body.id)/finance" $null $newToken
    Check ($finance.status -eq 200 -and $finance.body.totals.remainingCents -eq 150000) "the old policy still shows 1 500 MAD left"
    $claims = Api "GET" "/api/claims" $null $newToken
    Check ($claims.status -eq 200 -and $claims.body.total -eq 1) "the claim declared before the update is still there"
    $dash = Api "GET" "/api/dashboard?period=month" $null $newToken
    Check ($dash.status -eq 200 -and $dash.body.money.paymentsCents -eq 100000 -and $dash.body.money.remainingCents -eq 150000 -and $dash.body.balances.drawer -eq 100000) "the dashboard shows 1 000 MAD received, 1 500 MAD left, 1 000 MAD in the drawer"
    Check ($dash.body.openClaims -eq 1 -and $dash.body.clients -eq 1) "the dashboard counts 1 client and 1 open claim"
    $rep = Api "POST" "/api/reports/payments" @{ language = "fr" } $newToken
    Check ($rep.status -eq 200 -and $rep.body.totals.amount -eq 100000 -and $rep.body.title -eq "Paiements et encaissements") "the payments report (in French) adds up to 1 000 MAD"
    $xlsx = Api "POST" "/api/reports/claims/excel" @{ language = "ar" } $newToken
    $bytes = [Convert]::FromBase64String($xlsx.body.dataBase64)
    Check ($xlsx.status -eq 200 -and $bytes.Length -gt 1000 -and $bytes[0] -eq 0x50 -and $bytes[1] -eq 0x4B) "the claims report is saved as an Excel file by the installed server"
    $drawer = Api "GET" "/api/drawer" $null $newToken
    $close = Api "POST" "/api/drawer/close" @{ sessionVersion = $drawer.body.session.version; countedCents = 100000; reason = "" } $newToken
    Check ($close.status -eq 200 -and $close.body.differenceCents -eq 0) "the drawer is closed with 1 000 MAD, no gap"
    $secretsOld = Get-Content "$Data\secrets\secrets.json" | ConvertFrom-Json
    $bk = Api "GET" "/api/backups" $null $newToken
    Check ($bk.status -eq 200 -and $bk.body.enabled -eq $true -and $bk.body.dir -eq $BackupDir) "after the update the server takes backups into the same folder"
    Check ((Psql "alyassir" $secretsOld.dbPassword "SELECT count(*) FROM schema_migrations").Trim() -eq "8") "the eight database steps applied (Phases 1 to 8A)"
    $rc = Api "GET" "/api/me/recovery-code" $null $newToken
    Check ($rc.status -eq 200 -and $rc.body.exists -eq $false) "an updated server has no recovery code until the manager makes one"
    $made = Api "POST" "/api/me/recovery-code" @{ password = $ManagerPass } $newToken
    Check ($made.status -eq 200 -and $made.body.recoveryCode -match "^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$") "the manager makes his recovery code from My account"
    $hist = Api "GET" "/api/historical" $null $newToken
    Check ($hist.status -eq 200 -and $hist.body.mode -eq "locked") "a server that already worked live stays live after the update (no first-start question)"
    $empToken = (Login "nadia" "nadia-pass").body.accessToken
    $empClient = Api "POST" "/api/clients" @{ kind = "individual"; fullName = "Rachid APRES"; idType = "cin"; idNumber = "RA112233"; phone = "0663333333" } $empToken
    Check ($empClient.body.code -eq "FORBIDDEN") "the employee is limited only by his permissions, not by the historical entry"
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
  $hist = Api "GET" "/api/historical" $null $token
  Check ($hist.status -eq 200 -and $hist.body.mode -eq "pending") "a new installation asks first: do you have old policies?"
  $hist = Api "POST" "/api/historical/answer" @{ hasOldPolicies = $false } $token
  Check ($hist.status -eq 200 -and $hist.body.mode -eq "locked") "the manager answers no: live work starts at once"
  $agency = Api "GET" "/api/settings/agency" $null $token
  $expectedName = "وكالة اليسير للتأمين"
  $gotCodes = (([int[]][char[]]"$($agency.body.nameAr)") | ForEach-Object { $_.ToString("X4") }) -join " "
  $wantCodes = (([int[]][char[]]$expectedName) | ForEach-Object { $_.ToString("X4") }) -join " "
  Write-Host "  agency name received: $gotCodes"
  Write-Host "  agency name expected: $wantCodes"
  Check ($agency.body.nameAr -eq $expectedName) "agency name in Arabic saved correctly (received: $gotCodes)"
  Check ($agency.body.backupDir -eq $BackupDir) "Google Drive backup folder saved"
  $emp = Api "POST" "/api/users" @{ username = "salma"; displayName = "Salma"; password = "salma-pass" } $token
  Check ($emp.status -eq 201) "the manager creates an employee"
  $bad = Login "gerant" "wrong-password"
  Check ($bad.status -eq 401 -and $bad.body.code -eq "INVALID_CREDENTIALS") "wrong password refused"
  $es = Login "salma" "salma-pass"
  Check ((Api "GET" "/api/users" $null $es.body.accessToken).body.code -eq "FORBIDDEN") "an employee cannot manage users"

  Write-Host "`n=== 5b. The manager forgot his password (Phase 8A) ==="
  $code = IniValue "recovery"
  Check ($code -match "^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$") "the installer showed a recovery code for the manager"
  Check (-not (Select-String -Path "$Logs\*.log" -SimpleMatch $code -Quiet)) "the recovery code is not written in the setup logs"
  $bad = Api "POST" "/api/auth/recover" @{ username = "gerant"; code = "AAAA-AAAA-AAAA-AAAA"; newPassword = "Nouveau-2026" }
  Check ($bad.body.code -eq "RECOVERY_INVALID") "a wrong recovery code is refused"
  $rec = Api "POST" "/api/auth/recover" @{ username = "gerant"; code = $code; newPassword = "Nouveau-2026" }
  Check ($rec.status -eq 200 -and $rec.body.recoveryCode -ne $code) "the printed code sets a new password and gives a new code"
  Check ((Login "gerant" "Nouveau-2026").status -eq 200) "the manager signs in with the new password"
  Check ((Api "POST" "/api/auth/recover" @{ username = "gerant"; code = $code; newPassword = "Autre-2026" }).body.code -eq "RECOVERY_INVALID") "the used code does not work twice"
  $shell = New-Object -ComObject WScript.Shell
  $links = @(Get-ChildItem "$env:ProgramData\Microsoft\Windows\Start Menu\Programs" -Filter *.lnk -Recurse | Where-Object { $shell.CreateShortcut($_.FullName).Arguments -like "*reset-manager.ps1*" })
  Check ($links.Count -eq 1 -and (Test-Path "$App\server\tools\reset-manager.ps1")) "the server has the Start menu tool to reset the manager's password"
  # The tool's window calls the setup helper as administrator; the same call here, without the window.
  $pwFile = Join-Path $env:RUNNER_TEMP "reset-pw.txt"
  $resetOut = Join-Path $env:RUNNER_TEMP "reset-result.json"
  [System.IO.File]::WriteAllText($pwFile, $ManagerPass, [System.Text.UTF8Encoding]::new($false))
  & "$App\server\node.exe" "$App\server\dist\setup\cli.js" reset-manager --app-dir $App --password-file $pwFile --result $resetOut
  $reset = Get-Content $resetOut -Raw | ConvertFrom-Json
  Check ($LASTEXITCODE -eq 0 -and $reset.ok -and $reset.username -eq "gerant" -and $reset.recoveryCode -match "^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$") "the server tool sets the manager's password again and makes a new code"
  Check (-not (Test-Path $pwFile)) "the tool deletes the password file"
  Check ((Login "gerant" $ManagerPass).status -eq 200 -and (Login "gerant" "Nouveau-2026").status -eq 401) "the manager signs in with the password set on the server"
  $token = (Login "gerant" $ManagerPass).body.accessToken
  $audit = (Psql "alyassir" $secrets.dbPassword "SELECT count(*) FROM audit_log WHERE action = 'auth.recovered'").Trim()
  Check ($audit -eq "2") "both recoveries are in the audit log"

  Write-Host "`n=== 6. Desktop app connection logic (fingerprint check, realtime link) ==="
  $env:ALYASSIR_TEST_URL = $url
  $env:ALYASSIR_TEST_FINGERPRINT = $fingerprint
  $env:ALYASSIR_TEST_TOKEN = (Login "gerant" $ManagerPass).body.accessToken
  Push-Location "$PSScriptRoot\..\..\apps\desktop\src-tauri"
  cargo test -p server-link --release -- --nocapture
  $cargoCode = $LASTEXITCODE
  Pop-Location
  Check ($cargoCode -eq 0) "app sees the same fingerprint, refuses another, and the realtime link works over the pinned certificate"

  Write-Host "`n=== 6b. Backups and a restore inside the application (SPEC 20) ==="
  $token = (Login "gerant" $ManagerPass).body.accessToken
  $before = Api "POST" "/api/clients" @{ kind = "individual"; fullName = "Karim AVANT"; idType = "cin"; idNumber = "K123456"; phone = "0661111111" } $token
  Check ($before.status -eq 201) "a client is saved before the backup"
  $taken = Api "POST" "/api/backups" @{} $token 120
  $manual = @($taken.body.files | Where-Object { $_.kind -eq "manual" })[0]
  Check ($taken.status -eq 200 -and $manual -and $manual.checked -eq $true) "a backup is taken now with the server's own PostgreSQL tools (checked)"
  $dump = Get-ChildItem "$BackupDir\manual\*.dump" | Select-Object -First 1
  Check ($dump -and (Test-Path "$($dump.FullName).sha256")) "the backup file and its SHA-256 are in the Google Drive folder ($($dump.Name))"
  $keep = Join-Path $env:RUNNER_TEMP "restore-as-server"
  New-Item -ItemType Directory -Force -Path $keep | Out-Null
  Copy-Item $dump.FullName, "$($dump.FullName).sha256" $keep
  $after = Api "POST" "/api/clients" @{ kind = "individual"; fullName = "Samir APRES"; idType = "cin"; idNumber = "S654321"; phone = "0662222222" } $token
  Check ($after.status -eq 201) "a client is saved after the backup"
  $usbState = Api "GET" "/api/backups/usb" $null $token
  Check ($usbState.status -eq 200 -and $usbState.body.atServer -eq $true) "the server knows this request comes from the server computer (USB copy allowed here)"
  $restore = Api "POST" "/api/backups/$($manual.id)/restore" @{ password = $ManagerPass } $token 300
  Check ($restore.status -eq 200 -and $restore.body.restored -eq $manual.name) "the restore succeeds (after a safety copy of the current state)"
  Check ((Get-ChildItem "$Data\backups\safety\*.dump").Count -ge 1) "the safety copy is in the server's own folder"
  $h = Health
  Check ($h -and $h.status -eq "ok" -and $h.database -eq "ok") "the server works after the restore"
  $token = (Login "gerant" $ManagerPass).body.accessToken
  $names = @((Api "GET" "/api/clients?pageSize=100" $null $token).body.items | ForEach-Object { $_.fullName })
  Check (($names -contains "Karim AVANT") -and -not ($names -contains "Samir APRES")) "the data is back as it was at the backup (Karim yes, Samir no)"

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

  Write-Host "`n=== 13. Restore as server: a new server from the backup file (SPEC 20.1) ==="
  Wipe-Everything
  $file = (Get-ChildItem (Join-Path $env:RUNNER_TEMP "restore-as-server\*.dump") | Select-Object -First 1).FullName
  $code = Install @("/MODE=restore", "/PORT=$Port", "/BACKUPFILE=$file", "/BACKUPDIR=$BackupDir")
  Check ($code -eq 0) "the installer restores the server from the backup"
  $h = Health
  Check ($h -and $h.status -eq "ok" -and $h.database -eq "ok") "the restored server answers"
  $r = Login "gerant" $ManagerPass
  Check ($r.status -eq 200 -and $r.body.me.role -eq "manager") "the manager signs in with his old password"
  $names = @((Api "GET" "/api/clients?pageSize=100" $null $r.body.accessToken).body.items | ForEach-Object { $_.fullName })
  Check ($names -contains "Karim AVANT") "the agency's data is there (Karim AVANT)"
  Check ((Login "salma" "salma-pass").status -eq 200) "the employees of the backup sign in too"
  $fp = IniValue "fingerprint"
  Check ($fp -match "^([0-9A-F]{2}:){31}[0-9A-F]{2}$") "a new fingerprint is shown for the other computers"
  $secretsNew = Get-Content "$Data\secrets\secrets.json" | ConvertFrom-Json
  Check ((Psql "alyassir" $secretsNew.dbPassword "SELECT count(*) FROM audit_log WHERE action = 'system.restore_as_server'").Trim() -eq "1") "the restore as server is written in the audit log"
  Wipe-Everything

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
