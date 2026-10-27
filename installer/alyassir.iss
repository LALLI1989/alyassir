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
ar.AgencyTitle=الوكالة والمدير
ar.TestAgencyName=وكالة اليسير للتأمين
ar.AgencyDesc=اسم الوكالة وحساب المدير الأول
ar.AgencySub=المدير هو صاحب كل الصلاحيات. احفظ كلمة المرور في مكان آمن: لا توجد استعادة عبر البريد.
ar.AgencyName=اسم الوكالة:
ar.ManagerUser=اسم مستخدم المدير (حروف لاتينية وأرقام، دون مسافات):
ar.ManagerPass=كلمة مرور المدير (6 أحرف على الأقل):
ar.ManagerPass2=أعد كتابة كلمة المرور:
ar.ErrAgency=اكتب اسم الوكالة.
ar.ErrUser=اسم المستخدم: من 3 إلى 32 حرفًا لاتينيًا أو رقمًا أو . _ - دون مسافات.
ar.ErrPass=كلمة المرور قصيرة: 6 أحرف على الأقل.
ar.ErrPass2=كلمتا المرور غير متطابقتين.
ar.BackupTitle=مجلد النسخ الاحتياطي
ar.BackupDesc=مجلد Google Drive المتزامن على هذا الحاسوب
ar.BackupSub=اختر مجلدًا داخل Google Drive، تُحفظ فيه النسخ الاحتياطية اليومية لاحقًا.
ar.ErrBackupDir=المجلد غير موجود. اختر مجلدًا موجودًا.
ar.Updating=جارٍ تحديث الخادم: نسخة احتياطية، ثم تحديث قاعدة البيانات، ثم إعادة التشغيل…
ar.UpdateDoneTitle=اكتمل تحديث الخادم
ar.UpdateFailTitle=تعذّر تحديث الخادم
ar.UpdateFailDesc=البيانات سليمة: أعيدت قاعدة البيانات كما كانت قبل التحديث. أعد تثبيت الإصدار السابق أو اتصل بالدعم.
ar.StopFailed=تعذّر إيقاف خدمات اليسير لتحديثها. أعد تشغيل الحاسوب ثم أعد المحاولة.
ar.Err_E_BOOTSTRAP_USERNAME=اسم مستخدم المدير غير صحيح.
ar.Err_E_BOOTSTRAP_PASSWORD=كلمة مرور المدير قصيرة.
ar.Err_E_BOOTSTRAP_BACKUP_DIR=مجلد النسخ الاحتياطي غير موجود.
ar.Err_E_BACKUP=تعذّرت النسخة الاحتياطية قبل التحديث، فلم يُغيَّر شيء.
ar.Err_E_MIGRATION=تعذّر تحديث قاعدة البيانات. أعيدت كما كانت قبل التحديث.

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
fr.AgencyTitle=Agence et gérant
fr.TestAgencyName=وكالة اليسير للتأمين
fr.AgencyDesc=Nom de l'agence et compte du premier gérant
fr.AgencySub=Le gérant a tous les droits. Conservez son mot de passe en lieu sûr : il n'y a pas de récupération par e-mail.
fr.AgencyName=Nom de l'agence :
fr.ManagerUser=Nom d'utilisateur du gérant (lettres latines et chiffres, sans espace) :
fr.ManagerPass=Mot de passe du gérant (6 caractères au minimum) :
fr.ManagerPass2=Répétez le mot de passe :
fr.ErrAgency=Saisissez le nom de l'agence.
fr.ErrUser=Nom d'utilisateur : de 3 à 32 lettres latines, chiffres ou . _ - sans espace.
fr.ErrPass=Mot de passe trop court : 6 caractères au minimum.
fr.ErrPass2=Les deux mots de passe ne correspondent pas.
fr.BackupTitle=Dossier de sauvegarde
fr.BackupDesc=Dossier Google Drive synchronisé sur cet ordinateur
fr.BackupSub=Choisissez un dossier dans Google Drive ; les sauvegardes quotidiennes y seront enregistrées plus tard.
fr.ErrBackupDir=Ce dossier n'existe pas. Choisissez un dossier existant.
fr.Updating=Mise à jour du serveur : sauvegarde, puis mise à jour de la base de données, puis redémarrage…
fr.UpdateDoneTitle=Serveur mis à jour
fr.UpdateFailTitle=La mise à jour du serveur a échoué
fr.UpdateFailDesc=Les données sont intactes : la base de données a été remise dans son état d'avant la mise à jour. Réinstallez la version précédente ou contactez le support.
fr.StopFailed=Impossible d'arrêter les services Alyassir pour la mise à jour. Redémarrez l'ordinateur puis réessayez.
fr.Err_E_BOOTSTRAP_USERNAME=Nom d'utilisateur du gérant incorrect.
fr.Err_E_BOOTSTRAP_PASSWORD=Mot de passe du gérant trop court.
fr.Err_E_BOOTSTRAP_BACKUP_DIR=Le dossier de sauvegarde n'existe pas.
fr.Err_E_BACKUP=La sauvegarde avant mise à jour a échoué ; rien n'a été modifié.
fr.Err_E_MIGRATION=La mise à jour de la base de données a échoué. Elle a été remise dans son état d'avant.

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
  AgencyPage: TInputQueryWizardPage;
  BackupPage: TInputDirWizardPage;
  ResultPage: TOutputMsgMemoWizardPage;
  ProvisionRan: Boolean;
  ProvisionFailed: Boolean;
  IsUpgrade: Boolean;
  UpgradeNeedsBootstrap: Boolean;
  UpgradeDataDir: String;
  ResultText: String;
  { Agency page values, copied when Next is clicked: later reads of the page can lose Arabic letters. }
  AgencyName, ManagerName, ManagerPassword, BackupFolder: String;

function StateFile: String;
begin
  Result := ExpandConstant('{autopf}\Alyassir\provision-state.json');
end;

{ Reads a string value from the small JSON state file written by setup. }
function JsonString(Json, Key: String): String;
var
  P: Integer;
  Rest: String;
begin
  Result := '';
  P := Pos('"' + Key + '": "', Json);
  if P = 0 then Exit;
  Rest := Copy(Json, P + Length(Key) + 5, Length(Json));
  P := Pos('"', Rest);
  if P = 0 then Exit;
  Result := Copy(Rest, 1, P - 1);
  StringChangeEx(Result, '\\', '\', True);
end;

function IsServerMode: Boolean;
begin
  Result := IsUpgrade or ModePage.Values[0];
end;

function NeedsBootstrap: Boolean;
begin
  Result := IsServerMode and ((not IsUpgrade) or UpgradeNeedsBootstrap);
end;

function ProvisionFailedCheck: Boolean;
begin
  Result := ProvisionFailed;
end;

function DataDir: String;
begin
  if IsUpgrade then
    Result := UpgradeDataDir
  else
    Result := DataPage.Values[0];
end;

function ResultIni: String;
begin
  Result := AddBackslash(DataDir) + 'setup-result.json.ini';
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

function ValidUsername(U: String): Boolean;
var
  I: Integer;
  C: Char;
begin
  Result := (Length(U) >= 3) and (Length(U) <= 32);
  if not Result then Exit;
  for I := 1 to Length(U) do
  begin
    C := U[I];
    if not (((C >= 'a') and (C <= 'z')) or ((C >= 'A') and (C <= 'Z')) or ((C >= '0') and (C <= '9')) or
      (C = '.') or (C = '_') or (C = '-')) then
    begin
      Result := False;
      Exit;
    end;
  end;
end;

procedure InitializeWizard;
var
  Mode, Dir: String;
  State: AnsiString;
begin
  IsUpgrade := FileExists(StateFile);
  if IsUpgrade then
  begin
    LoadStringFromFile(StateFile, State);
    UpgradeDataDir := JsonString(String(State), 'dataDir');
    UpgradeNeedsBootstrap := Pos('"bootstrapped": true', String(State)) = 0;
    Log('Update of an existing server. Data folder: ' + UpgradeDataDir);
  end;

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
  Dir := ExpandConstant('{param:DATADIR|}');
  if Dir = '' then
    Dir := ExpandConstant('{commonappdata}\Alyassir');
  DataPage.Values[0] := Dir;

  AgencyPage := CreateInputQueryPage(DataPage.ID, CustomMessage('AgencyTitle'), CustomMessage('AgencyDesc'),
    CustomMessage('AgencySub'));
  AgencyPage.Add(CustomMessage('AgencyName'), False);
  AgencyPage.Add(CustomMessage('ManagerUser'), False);
  AgencyPage.Add(CustomMessage('ManagerPass'), True);
  AgencyPage.Add(CustomMessage('ManagerPass2'), True);
  AgencyPage.Values[0] := ExpandConstant('{param:AGENCY|}');
  { Automated tests: command-line options lose Arabic letters, so an Arabic name comes from the
    messages file instead. A person types the name in the page, which keeps it intact. }
  if ExpandConstant('{param:TESTAGENCY|}') = '1' then
  begin
    AgencyPage.Values[0] := CustomMessage('TestAgencyName');
  end;
  AgencyPage.Values[1] := ExpandConstant('{param:MANAGER|}');
  AgencyPage.Values[2] := ExpandConstant('{param:MANAGERPASS|}');
  AgencyPage.Values[3] := ExpandConstant('{param:MANAGERPASS|}');

  BackupPage := CreateInputDirPage(AgencyPage.ID, CustomMessage('BackupTitle'), CustomMessage('BackupDesc'),
    CustomMessage('BackupSub'), False, '');
  BackupPage.Add('');
  BackupPage.Values[0] := ExpandConstant('{param:BACKUPDIR|}');

  ResultPage := CreateOutputMsgMemoPage(wpInstalling, CustomMessage('DoneTitle'), CustomMessage('DoneDesc'),
    CustomMessage('DoneSub'), '');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = ModePage.ID then
    Result := IsUpgrade;
  if (PageID = PortPage.ID) or (PageID = DataPage.ID) then
    Result := IsUpgrade or (not IsServerMode);
  if (PageID = AgencyPage.ID) or (PageID = BackupPage.ID) then
    Result := not NeedsBootstrap;
  if PageID = ResultPage.ID then
    Result := not ProvisionRan;
end;

function CheckAgencyPage: Boolean;
begin
  Result := False;
  if Trim(AgencyPage.Values[0]) = '' then
    SuppressibleMsgBox(CustomMessage('ErrAgency'), mbError, MB_OK, IDOK)
  else if not ValidUsername(Trim(AgencyPage.Values[1])) then
    SuppressibleMsgBox(CustomMessage('ErrUser'), mbError, MB_OK, IDOK)
  else if Length(AgencyPage.Values[2]) < 6 then
    SuppressibleMsgBox(CustomMessage('ErrPass'), mbError, MB_OK, IDOK)
  else if AgencyPage.Values[2] <> AgencyPage.Values[3] then
    SuppressibleMsgBox(CustomMessage('ErrPass2'), mbError, MB_OK, IDOK)
  else
    Result := True;
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
  if CurPageID = AgencyPage.ID then
  begin
    Result := CheckAgencyPage;
    AgencyName := Trim(AgencyPage.Values[0]);
    ManagerName := Trim(AgencyPage.Values[1]);
    ManagerPassword := AgencyPage.Values[2];
  end;
  if CurPageID = BackupPage.ID then
  begin
    BackupFolder := BackupPage.Values[0];
    if not DirExists(BackupFolder) then
    begin
      SuppressibleMsgBox(CustomMessage('ErrBackupDir'), mbError, MB_OK, IDOK);
      Result := False;
    end;
  end;
end;

{ Update: the services must stop so their program files can be replaced. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  if not IsUpgrade then Exit;
  Exec('powershell.exe', '-NoProfile -NonInteractive -Command "Stop-Service -Name AlyassirServer -Force -ErrorAction SilentlyContinue; ' +
    'Stop-Service -Name AlyassirPostgres -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; ' +
    'if ((Get-Service AlyassirServer -ErrorAction SilentlyContinue).Status -eq ''Running'') { exit 4 }"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
  if Code = 4 then
    Result := CustomMessage('StopFailed');
end;

function ErrorText(Code: String): String;
begin
  if (Code = 'E_ALREADY_INSTALLED') or (Code = 'E_DATA_EXISTS') or (Code = 'E_API_PORT_IN_USE') or
     (Code = 'E_PG_PORT_IN_USE') or (Code = 'E_HEALTH') or (Code = 'E_BOOTSTRAP_USERNAME') or
     (Code = 'E_BOOTSTRAP_PASSWORD') or (Code = 'E_BOOTSTRAP_BACKUP_DIR') or (Code = 'E_BACKUP') or
     (Code = 'E_MIGRATION') then
    Result := CustomMessage('Err_' + Code)
  else
    Result := CustomMessage('Err_Generic');
end;

{ Agency and manager for the setup helper. UTF-8 file in setup's private temporary folder;
  the helper deletes it as soon as it has read it (it holds the manager's password). }
function WriteBootstrap: String;
var
  Lines: TArrayOfString;
begin
  Result := ExpandConstant('{tmp}\bootstrap.txt');
  { Pages never shown (some silent runs): read them now. }
  if AgencyName = '' then
  begin
    AgencyName := Trim(AgencyPage.Values[0]);
    ManagerName := Trim(AgencyPage.Values[1]);
    ManagerPassword := AgencyPage.Values[2];
  end;
  if BackupFolder = '' then
    BackupFolder := BackupPage.Values[0];
  SetArrayLength(Lines, 5);
  Lines[0] := 'agencyName=' + AgencyName;
  Lines[1] := 'managerUsername=' + ManagerName;
  Lines[2] := 'managerPassword=' + ManagerPassword;
  Lines[3] := 'language=' + ActiveLanguage;
  Lines[4] := 'backupDir=' + BackupFolder;
  SaveStringsToUTF8File(Result, Lines, False);
end;

procedure RunProvision;
var
  Code, I, UrlCount: Integer;
  Params, Ini, ErrCode, Step, Urls: String;
begin
  ProvisionRan := True;
  if IsUpgrade then
    WizardForm.StatusLabel.Caption := CustomMessage('Updating')
  else
    WizardForm.StatusLabel.Caption := CustomMessage('Configuring');
  Ini := ResultIni;
  DeleteFile(Ini);
  Params := '"' + ExpandConstant('{app}\server\dist\setup\cli.js') + '"';
  if IsUpgrade then
    Params := Params + ' upgrade --app-dir "' + ExpandConstant('{app}') + '"'
  else
    Params := Params + ' provision --app-dir "' + ExpandConstant('{app}') + '"' +
      ' --data-dir "' + DataDir + '"' + ' --port ' + Trim(PortPage.Values[0]);
  Params := Params + ' --result "' + AddBackslash(DataDir) + 'setup-result.json"';
  if ExpandConstant('{param:SIMULATEFAIL|}') <> '' then
    Params := Params + ' --simulate-failure-at ' + ExpandConstant('{param:SIMULATEFAIL|}');
  { Logged before the bootstrap file is added: the log never shows where the password is. }
  Log('Setup helper: node ' + Params);
  if NeedsBootstrap then
  begin
    Log('Agency name (' + IntToStr(Length(AgencyName)) + ' characters): ' + AgencyName);
    Params := Params + ' --bootstrap "' + WriteBootstrap + '"';
  end;
  { Through cmd.exe so that any crash message of the helper itself lands in a log file. }
  ForceDirectories(AddBackslash(DataDir) + 'logs');
  Params := '/S /C ""' + ExpandConstant('{app}\server\node.exe') + '" ' + Params + ' 2>"' +
    AddBackslash(DataDir) + 'logs\setup-helper-errors.log""';
  if not Exec(ExpandConstant('{cmd}'), Params, ExpandConstant('{app}\server'), SW_HIDE,
    ewWaitUntilTerminated, Code) then
    Code := -1;
  DeleteFile(ExpandConstant('{tmp}\bootstrap.txt'));
  Log('Setup helper exit code: ' + IntToStr(Code));

  if (Code = 0) and (GetIniString('result', 'ok', '0', Ini) = '1') then
  begin
    if IsUpgrade then
      ResultPage.Caption := CustomMessage('UpdateDoneTitle');
    Urls := '';
    UrlCount := StrToIntDef(GetIniString('result', 'urlCount', '0', Ini), 0);
    for I := 0 to UrlCount - 1 do
      Urls := Urls + '    ' + GetIniString('result', 'url' + IntToStr(I), '', Ini) + #13#10;
    ResultText := CustomMessage('DoneAddress') + #13#10 + Urls + #13#10 +
      CustomMessage('DoneFingerprint') + #13#10 + '    ' + GetIniString('result', 'fingerprint', '', Ini) + #13#10#13#10 +
      AddBackslash(DataDir) + 'setup-result.json';
    Log('Setup OK. ' + ResultText);
  end
  else
  begin
    ProvisionFailed := True;
    ErrCode := GetIniString('result', 'code', 'E_SETUP_HELPER', Ini);
    Step := GetIniString('result', 'step', '-', Ini);
    if IsUpgrade then
    begin
      ResultPage.Caption := CustomMessage('UpdateFailTitle');
      ResultPage.Description := CustomMessage('UpdateFailDesc');
    end
    else
    begin
      ResultPage.Caption := CustomMessage('FailTitle');
      ResultPage.Description := CustomMessage('FailDesc');
    end;
    ResultText := ErrorText(ErrCode) + #13#10#13#10 + FmtMessage(CustomMessage('FailCode'), [ErrCode, Step]) + #13#10 +
      FmtMessage(CustomMessage('FailLog'), [AddBackslash(DataDir) + 'logs\setup.log']);
    Log('Setup FAILED: ' + ErrCode + ' at ' + Step);
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

{ After a failed FIRST installation, remove the installed files too, so nothing is left behind.
  Never after a failed update: the existing installation and its data must stay. }
procedure DeinitializeSetup;
var
  Code: Integer;
begin
  if ProvisionFailed and (not IsUpgrade) then
    Exec(ExpandConstant('{uninstallexe}'), '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_HIDE, ewNoWait, Code);
end;
