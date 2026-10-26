; Alyassir installer — Phase 0 spike.
; Built on GitHub (see .github/workflows/phase0-installer.yml):
;   iscc /DAppVersion=0.0.1 /DStageDir=<stage> alyassir.iss
;
; Silent use (automated tests):
;   Alyassir-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /MODE=server /PORT=4100 /DATADIR="C:\ProgramData\Alyassir"
;   Alyassir-Setup.exe /VERYSILENT /SUPPRESSMSGBOXES /MODE=user

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "stage"
#endif

[Setup]
AppId={{6C7E2B0F-3B7A-4E5B-9C0D-8A1F4E2D9B31}
AppName=Alyassir
AppVersion={#AppVersion}
AppPublisher=Alyassir
DefaultDirName={autopf}\Alyassir
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Target is Windows 11 (SPEC 1). 10.0.17763 is the floor so the GitHub test machines (Windows Server) can run it.
MinVersion=10.0.17763
OutputDir=output
OutputBaseFilename=Alyassir-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
ShowLanguageDialog=yes
LanguageDetectionMethod=uilanguage
UninstallDisplayIcon={app}\desktop\Alyassir.exe
UninstallDisplayName=Alyassir

[Languages]
Name: "ar"; MessagesFile: "languages\Arabic.isl"
Name: "fr"; MessagesFile: "compiler:Languages\French.isl"

[CustomMessages]
ar.ModeTitle=نوع هذا الحاسوب
ar.ModeDesc=هل هذا حاسوب خادم أم حاسوب مستخدم؟
ar.ModeSub=اختر «حاسوب خادم» لجهاز واحد فقط في الوكالة. هو الذي يحفظ البيانات ويجب أن يبقى مشغّلًا طوال الدوام.
ar.ModeServer=حاسوب خادم (يحفظ البيانات، ويمكن العمل عليه أيضًا)
ar.ModeUser=حاسوب مستخدم (يتصل بالخادم فقط)
ar.ServerTitle=إعدادات الخادم
ar.ServerDesc=المنفذ الذي تتصل عبره الأجهزة الأخرى
ar.ServerSub=اترك القيمة 4100 إلا إذا طُلب منك غيرها.
ar.PortLabel=المنفذ:
ar.PortInvalid=المنفذ يجب أن يكون رقمًا بين 1024 و65535، وغير 5433.
ar.PortBusy=المنفذ %1 مستعمل من برنامج آخر. هل تريد استعمال المنفذ %2 بدلًا منه؟
ar.PortNoneFree=المنفذ %1 مستعمل ولم يُعثر على منفذ بديل. اكتب منفذًا آخر.
ar.DataTitle=مجلد بيانات التطبيق
ar.DataDesc=أين تُحفظ قاعدة البيانات على هذا الحاسوب؟
ar.DataSub=اترك المجلد المقترح إلا إذا طُلب منك غيره.
ar.Configuring=جارٍ إعداد الخادم وقاعدة البيانات واختبارهما… قد يستغرق ذلك دقيقتين.
ar.DoneTitle=اكتمل إعداد الخادم
ar.DoneDesc=احتفظ بهذه المعلومات: ستحتاجها على كل حاسوب مستخدم.
ar.DoneSub=المعلومات محفوظة أيضًا في الملف:
ar.DoneAddress=عنوان الاتصال (استعمل عنوان شبكة الوكالة):
ar.DoneFingerprint=بصمة الخادم (قارنها على كل حاسوب مستخدم):
ar.FailTitle=تعذّر إعداد الخادم
ar.FailDesc=تم التراجع عن كل التغييرات ولم يتغير شيء في هذا الحاسوب.
ar.FailCode=رمز الخطأ للدعم: %1 (الخطوة: %2)
ar.FailLog=ملف السجل: %1
ar.Err_E_ALREADY_INSTALLED=خادم اليسير مثبّت مسبقًا على هذا الحاسوب.
ar.Err_E_DATA_EXISTS=مجلد البيانات يحتوي مسبقًا على قاعدة بيانات. لم نلمسها حفاظًا على بياناتك. اختر مجلدًا آخر أو اتصل بالدعم.
ar.Err_E_API_PORT_IN_USE=المنفذ المختار أصبح مستعملًا من برنامج آخر. أعد التثبيت واختر منفذًا آخر.
ar.Err_E_PG_PORT_IN_USE=المنفذ 5433 الخاص بقاعدة البيانات مستعمل من برنامج آخر على هذا الحاسوب.
ar.Err_E_HEALTH=الخادم لم يُجب على الاختبار النهائي.
ar.Err_Generic=حدث خطأ أثناء الإعداد.

fr.ModeTitle=Type de cet ordinateur
fr.ModeDesc=Cet ordinateur est-il le serveur ou un poste utilisateur ?
fr.ModeSub=Choisissez « Ordinateur serveur » pour un seul appareil de l'agence. Il conserve les données et doit rester allumé pendant les heures de travail.
fr.ModeServer=Ordinateur serveur (conserve les données, utilisable aussi comme poste)
fr.ModeUser=Poste utilisateur (se connecte uniquement au serveur)
fr.ServerTitle=Paramètres du serveur
fr.ServerDesc=Port par lequel les autres postes se connectent
fr.ServerSub=Laissez 4100 sauf indication contraire.
fr.PortLabel=Port :
fr.PortInvalid=Le port doit être un nombre entre 1024 et 65535, différent de 5433.
fr.PortBusy=Le port %1 est utilisé par un autre programme. Utiliser le port %2 à la place ?
fr.PortNoneFree=Le port %1 est utilisé et aucun port de remplacement n'a été trouvé. Saisissez un autre port.
fr.DataTitle=Dossier des données de l'application
fr.DataDesc=Où enregistrer la base de données sur cet ordinateur ?
fr.DataSub=Laissez le dossier proposé sauf indication contraire.
fr.Configuring=Configuration et test du serveur et de la base de données… Cela peut prendre deux minutes.
fr.DoneTitle=Serveur configuré
fr.DoneDesc=Conservez ces informations : elles seront demandées sur chaque poste utilisateur.
fr.DoneSub=Ces informations sont aussi enregistrées dans le fichier :
fr.DoneAddress=Adresse de connexion (utilisez l'adresse du réseau de l'agence) :
fr.DoneFingerprint=Empreinte du serveur (à comparer sur chaque poste) :
fr.FailTitle=La configuration du serveur a échoué
fr.FailDesc=Toutes les modifications ont été annulées ; rien n'a changé sur cet ordinateur.
fr.FailCode=Code d'erreur pour le support : %1 (étape : %2)
fr.FailLog=Fichier journal : %1
fr.Err_E_ALREADY_INSTALLED=Le serveur Alyassir est déjà installé sur cet ordinateur.
fr.Err_E_DATA_EXISTS=Le dossier de données contient déjà une base de données. Elle n'a pas été modifiée pour protéger vos données. Choisissez un autre dossier ou contactez le support.
fr.Err_E_API_PORT_IN_USE=Le port choisi est maintenant utilisé par un autre programme. Relancez l'installation et choisissez un autre port.
fr.Err_E_PG_PORT_IN_USE=Le port 5433 de la base de données est utilisé par un autre programme sur cet ordinateur.
fr.Err_E_HEALTH=Le serveur n'a pas répondu au test final.
fr.Err_Generic=Une erreur est survenue pendant la configuration.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Desktop app: on every computer.
Source: "{#StageDir}\desktop\*"; DestDir: "{app}\desktop"; Flags: ignoreversion recursesubdirs createallsubdirs
; Server parts: only on the server computer.
Source: "{#StageDir}\server\*"; DestDir: "{app}\server"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: IsServerMode
Source: "{#StageDir}\pgsql\*"; DestDir: "{app}\pgsql"; Flags: ignoreversion recursesubdirs createallsubdirs; Check: IsServerMode
Source: "{#StageDir}\service\WinSW-x64.exe"; DestDir: "{app}\service"; Flags: ignoreversion; Check: IsServerMode

[Icons]
Name: "{autoprograms}\Alyassir"; Filename: "{app}\desktop\Alyassir.exe"
Name: "{autodesktop}\Alyassir"; Filename: "{app}\desktop\Alyassir.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\desktop\Alyassir.exe"; Description: "{cm:LaunchProgram,Alyassir}"; Flags: nowait postinstall skipifsilent; Check: not ProvisionFailedCheck

[UninstallRun]
; Removes the Windows services and the firewall rule. The data folder is always kept.
Filename: "{app}\server\node.exe"; Parameters: """{app}\server\dist\setup\cli.js"" unprovision --app-dir ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "Unprovision"; Check: IsServerMode

[Code]
var
  ModePage: TInputOptionWizardPage;
  PortPage: TInputQueryWizardPage;
  DataPage: TInputDirWizardPage;
  ResultPage: TOutputMsgMemoWizardPage;
  ProvisionRan: Boolean;
  ProvisionFailed: Boolean;
  ResultText: String;

function IsServerMode: Boolean;
begin
  Result := ModePage.Values[0];
end;

function ProvisionFailedCheck: Boolean;
begin
  Result := ProvisionFailed;
end;

function ResultIni: String;
begin
  Result := AddBackslash(DataPage.Values[0]) + 'setup-result.json.ini';
end;

{ Asks Windows whether something listens on the port (works on any Windows language). }
function PortInUse(Port: Integer): Boolean;
var
  Code: Integer;
begin
  Exec('powershell.exe',
    '-NoProfile -NonInteractive -Command "if (Get-NetTCPConnection -State Listen -LocalPort ' + IntToStr(Port) +
    ' -ErrorAction SilentlyContinue) { exit 3 } else { exit 0 }"', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := (Code = 3);
end;

function SuggestPort(From: Integer): Integer;
var
  P: Integer;
begin
  Result := 0;
  for P := From + 1 to From + 50 do
    if (P <> 5433) and (not PortInUse(P)) then
    begin
      Result := P;
      Exit;
    end;
end;

procedure InitializeWizard;
var
  Mode, DataDir: String;
begin
  ModePage := CreateInputOptionPage(wpWelcome, CustomMessage('ModeTitle'), CustomMessage('ModeDesc'),
    CustomMessage('ModeSub'), True, False);
  ModePage.Add(CustomMessage('ModeServer'));
  ModePage.Add(CustomMessage('ModeUser'));
  Mode := Lowercase(ExpandConstant('{param:MODE|server}'));
  ModePage.Values[0] := (Mode <> 'user');
  ModePage.Values[1] := (Mode = 'user');

  PortPage := CreateInputQueryPage(ModePage.ID, CustomMessage('ServerTitle'), CustomMessage('ServerDesc'),
    CustomMessage('ServerSub'));
  PortPage.Add(CustomMessage('PortLabel'), False);
  PortPage.Values[0] := ExpandConstant('{param:PORT|4100}');

  DataPage := CreateInputDirPage(PortPage.ID, CustomMessage('DataTitle'), CustomMessage('DataDesc'),
    CustomMessage('DataSub'), False, '');
  DataPage.Add('');
  DataDir := ExpandConstant('{param:DATADIR|}');
  if DataDir = '' then
    DataDir := ExpandConstant('{commonappdata}\Alyassir');
  DataPage.Values[0] := DataDir;

  ResultPage := CreateOutputMsgMemoPage(wpInstalling, CustomMessage('DoneTitle'), CustomMessage('DoneDesc'),
    CustomMessage('DoneSub'), '');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if (PageID = PortPage.ID) or (PageID = DataPage.ID) then
    Result := not IsServerMode;
  if PageID = ResultPage.ID then
    Result := not ProvisionRan;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Port, Alt: Integer;
begin
  Result := True;
  if CurPageID = PortPage.ID then
  begin
    Port := StrToIntDef(Trim(PortPage.Values[0]), 0);
    if (Port < 1024) or (Port > 65535) or (Port = 5433) then
    begin
      SuppressibleMsgBox(CustomMessage('PortInvalid'), mbError, MB_OK, IDOK);
      Result := False;
      Exit;
    end;
    { In silent installs the chosen port is kept as is; setup then reports E_API_PORT_IN_USE. }
    if (not WizardSilent) and PortInUse(Port) then
    begin
      Alt := SuggestPort(Port);
      if Alt = 0 then
      begin
        SuppressibleMsgBox(FmtMessage(CustomMessage('PortNoneFree'), [IntToStr(Port)]), mbError, MB_OK, IDOK);
        Result := False;
      end
      else if SuppressibleMsgBox(FmtMessage(CustomMessage('PortBusy'), [IntToStr(Port), IntToStr(Alt)]),
        mbConfirmation, MB_YESNO, IDYES) = IDYES then
        PortPage.Values[0] := IntToStr(Alt)
      else
        Result := False;
    end;
  end;
end;

function ErrorText(Code: String): String;
begin
  if (Code = 'E_ALREADY_INSTALLED') or (Code = 'E_DATA_EXISTS') or (Code = 'E_API_PORT_IN_USE') or
     (Code = 'E_PG_PORT_IN_USE') or (Code = 'E_HEALTH') then
    Result := CustomMessage('Err_' + Code)
  else
    Result := CustomMessage('Err_Generic');
end;

procedure RunProvision;
var
  Code, I, UrlCount: Integer;
  Params, Ini, ErrCode, Step, Urls: String;
begin
  ProvisionRan := True;
  WizardForm.StatusLabel.Caption := CustomMessage('Configuring');
  Ini := ResultIni;
  DeleteFile(Ini);
  Params := '"' + ExpandConstant('{app}\server\dist\setup\cli.js') + '" provision' +
    ' --app-dir "' + ExpandConstant('{app}') + '"' +
    ' --data-dir "' + DataPage.Values[0] + '"' +
    ' --port ' + Trim(PortPage.Values[0]) +
    ' --result "' + AddBackslash(DataPage.Values[0]) + 'setup-result.json"';
  if ExpandConstant('{param:SIMULATEFAIL|}') <> '' then
    Params := Params + ' --simulate-failure-at ' + ExpandConstant('{param:SIMULATEFAIL|}');
  Log('Provision: node ' + Params);
  { Through cmd.exe so that any crash message of the helper itself lands in a log file. }
  ForceDirectories(AddBackslash(DataPage.Values[0]) + 'logs');
  Params := '/S /C ""' + ExpandConstant('{app}\server\node.exe') + '" ' + Params + ' 2>"' +
    AddBackslash(DataPage.Values[0]) + 'logs\setup-helper-errors.log""';
  if not Exec(ExpandConstant('{cmd}'), Params, ExpandConstant('{app}\server'), SW_HIDE,
    ewWaitUntilTerminated, Code) then
    Code := -1;
  Log('Provision exit code: ' + IntToStr(Code));

  if (Code = 0) and (GetIniString('result', 'ok', '0', Ini) = '1') then
  begin
    Urls := '';
    UrlCount := StrToIntDef(GetIniString('result', 'urlCount', '0', Ini), 0);
    for I := 0 to UrlCount - 1 do
      Urls := Urls + '    ' + GetIniString('result', 'url' + IntToStr(I), '', Ini) + #13#10;
    ResultText := CustomMessage('DoneAddress') + #13#10 + Urls + #13#10 +
      CustomMessage('DoneFingerprint') + #13#10 + '    ' + GetIniString('result', 'fingerprint', '', Ini) + #13#10#13#10 +
      AddBackslash(DataPage.Values[0]) + 'setup-result.json';
    Log('Provision OK. ' + ResultText);
  end
  else
  begin
    ProvisionFailed := True;
    ErrCode := GetIniString('result', 'code', 'E_SETUP_HELPER', Ini);
    Step := GetIniString('result', 'step', '-', Ini);
    ResultPage.Caption := CustomMessage('FailTitle');
    ResultPage.Description := CustomMessage('FailDesc');
    ResultText := ErrorText(ErrCode) + #13#10#13#10 + FmtMessage(CustomMessage('FailCode'), [ErrCode, Step]) + #13#10 +
      FmtMessage(CustomMessage('FailLog'), [AddBackslash(DataPage.Values[0]) + 'logs\setup.log']);
    Log('Provision FAILED: ' + ErrCode + ' at ' + Step);
    SuppressibleMsgBox(ResultText, mbCriticalError, MB_OK, IDOK);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and IsServerMode then
    RunProvision;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = ResultPage.ID then
    ResultPage.RichEditViewer.Text := ResultText;
end;

{ Non-zero exit code for automated tests when the server could not be set up. }
function GetCustomSetupExitCode: Integer;
begin
  if ProvisionFailed then
    Result := 10
  else
    Result := 0;
end;

{ After a failed server setup, remove the installed files too, so nothing is left behind. }
procedure DeinitializeSetup;
var
  Code: Integer;
begin
  if ProvisionFailed then
    Exec(ExpandConstant('{uninstallexe}'), '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_HIDE, ewNoWait, Code);
end;
