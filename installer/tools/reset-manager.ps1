# Alyassir — new password for the manager, on the server computer only (Phase 8A).
# Started from the Start menu shortcut. Asks Windows for administrator rights (the database
# owner's password is in the protected secrets file), asks the new password twice, then shows the
# new recovery code once. Arabic and French on the same window.
param([switch]$Elevated)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  if ($Elevated) {
    [System.Windows.Forms.MessageBox]::Show("يجب تشغيل هذه الأداة بحساب مسؤول Windows.`nCet outil doit être lancé avec un compte administrateur Windows.", "Alyassir") | Out-Null
    exit 1
  }
  try {
    Start-Process -FilePath "powershell.exe" -Verb RunAs -WindowStyle Hidden -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-Elevated")
  } catch {
    [System.Windows.Forms.MessageBox]::Show("يجب تشغيل هذه الأداة بحساب مسؤول Windows.`nCet outil doit être lancé avec un compte administrateur Windows.", "Alyassir") | Out-Null
  }
  exit 0
}

$app = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # {app}\server\tools -> {app}
$node = Join-Path $app "server\node.exe"
$cli = Join-Path $app "server\dist\setup\cli.js"

$form = New-Object System.Windows.Forms.Form
$form.Text = "Alyassir — كلمة مرور المدير / Mot de passe du gérant"
$form.Size = New-Object System.Drawing.Size(560, 330)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$intro = New-Object System.Windows.Forms.Label
$intro.Text = "اكتب كلمة مرور جديدة للمدير (6 أحرف على الأقل). تُغلق كل جلساته ويُصنع رمز استعادة جديد.`nSaisissez un nouveau mot de passe pour le gérant (6 caractères au minimum). Ses sessions sont fermées et un nouveau code de récupération est créé."
$intro.Location = New-Object System.Drawing.Point(16, 12)
$intro.Size = New-Object System.Drawing.Size(520, 80)
$form.Controls.Add($intro)

function Add-Field([string]$label, [int]$y) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $label
  $l.Location = New-Object System.Drawing.Point(16, $y)
  $l.Size = New-Object System.Drawing.Size(520, 22)
  $form.Controls.Add($l)
  $t = New-Object System.Windows.Forms.TextBox
  $t.UseSystemPasswordChar = $true
  $t.Location = New-Object System.Drawing.Point(16, ($y + 24))
  $t.Size = New-Object System.Drawing.Size(520, 26)
  $form.Controls.Add($t)
  return $t
}
$p1 = Add-Field "كلمة المرور الجديدة / Nouveau mot de passe" 98
$p2 = Add-Field "أعد كتابتها / Répétez-le" 152

$ok = New-Object System.Windows.Forms.Button
$ok.Text = "حفظ / Enregistrer"
$ok.Location = New-Object System.Drawing.Point(16, 214)
$ok.Size = New-Object System.Drawing.Size(200, 34)
$form.Controls.Add($ok)
$form.AcceptButton = $ok

$ok.Add_Click({
  if ($p1.Text.Length -lt 6) {
    [System.Windows.Forms.MessageBox]::Show("كلمة المرور قصيرة: 6 أحرف على الأقل.`nMot de passe trop court : 6 caractères au minimum.", "Alyassir") | Out-Null
    return
  }
  if ($p1.Text -ne $p2.Text) {
    [System.Windows.Forms.MessageBox]::Show("الكلمتان غير متطابقتين.`nLes deux mots de passe ne correspondent pas.", "Alyassir") | Out-Null
    return
  }
  $dir = Join-Path $env:TEMP ("alyassir-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $dir | Out-Null
  $pwFile = Join-Path $dir "password.txt"
  $resultFile = Join-Path $dir "result.json"
  [System.IO.File]::WriteAllText($pwFile, $p1.Text, [System.Text.UTF8Encoding]::new($false))
  & $node $cli reset-manager --app-dir $app --password-file $pwFile --result $resultFile | Out-Null
  $result = $null
  if (Test-Path $resultFile) { $result = Get-Content $resultFile -Raw -Encoding UTF8 | ConvertFrom-Json }
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
  if ($result -and $result.ok) {
    $form.Hide()
    $done = New-Object System.Windows.Forms.Form
    $done.Text = "Alyassir"
    $done.Size = New-Object System.Drawing.Size(560, 280)
    $done.StartPosition = "CenterScreen"
    $done.FormBorderStyle = "FixedDialog"
    $done.Font = $form.Font
    $msg = New-Object System.Windows.Forms.Label
    $msg.Text = "تم. يدخل المدير ($($result.username)) بكلمة المرور الجديدة.`nاطبع رمز الاستعادة الجديد واحفظه مع أوراق الوكالة. الرمز القديم لم يعد يعمل.`n`nC'est fait. Le gérant ($($result.username)) se connecte avec le nouveau mot de passe.`nImprimez le nouveau code de récupération et gardez-le avec les papiers de l'agence."
    $msg.Location = New-Object System.Drawing.Point(16, 12)
    $msg.Size = New-Object System.Drawing.Size(520, 120)
    $done.Controls.Add($msg)
    $code = New-Object System.Windows.Forms.TextBox
    $code.Text = $result.recoveryCode
    $code.ReadOnly = $true
    $code.Font = New-Object System.Drawing.Font("Consolas", 16, [System.Drawing.FontStyle]::Bold)
    $code.Location = New-Object System.Drawing.Point(16, 140)
    $code.Size = New-Object System.Drawing.Size(520, 36)
    $done.Controls.Add($code)
    $close = New-Object System.Windows.Forms.Button
    $close.Text = "إغلاق / Fermer"
    $close.Location = New-Object System.Drawing.Point(16, 190)
    $close.Size = New-Object System.Drawing.Size(200, 34)
    $close.Add_Click({ $done.Close() })
    $done.Controls.Add($close)
    $done.ShowDialog() | Out-Null
    $form.Close()
  } else {
    $err = if ($result) { $result.errorCode } else { "E_TOOL" }
    [System.Windows.Forms.MessageBox]::Show("لم يتم التغيير. تأكد أن خادم اليسير مثبّت على هذا الحاسوب ويعمل.`nRien n'a été modifié. Vérifiez que le serveur Alyassir est installé sur cet ordinateur et fonctionne.`n`n$err", "Alyassir") | Out-Null
  }
})

[void]$form.ShowDialog()
