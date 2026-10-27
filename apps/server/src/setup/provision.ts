/**
 * First installation of the server computer (SPEC 6.1). Every step can be undone: if any step
 * fails, the finished ones are undone in reverse order and the computer is left as before.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "@alyassir/db";
import { SetupLog } from "./log";
import { isPortFree } from "./ports";
import {
  API_SERVICE,
  APP_ROLE,
  DB_NAME,
  DB_OWNER,
  PG_PORT,
  PG_SERVICE,
  bootstrapData,
  certFingerprint,
  dbUrl,
  ensureAppRole,
  firewallRuleName,
  lanUrls,
  logPostgresDiagnostics,
  logServiceTail,
  paths,
  pgReady,
  readBootstrap,
  secret,
  serviceEnv,
  stateFilePath,
  waitHealthy,
  winswXml,
  withClient,
  writeResult,
  writeSecrets,
  POSTGRES_CONF,
  type Bootstrap,
  type ProvisionState,
  type SetupResult,
} from "./common";
import { SetupError, runSteps, type Step } from "./steps";
import { SID, currentUserSid, powershell, restrictAcl, run, serviceStatus, startService, stopService, waitFor } from "./windows";
import { SERVER_VERSION } from "../version";

export {
  API_SERVICE,
  PG_PORT,
  PG_SERVICE,
  POSTGRES_CONF,
  firewallRuleName,
  stateFilePath,
  winswXml,
  type ProvisionState,
} from "./common";

export interface ProvisionOptions {
  appDir: string;
  dataDir: string;
  port: number;
  resultFile: string;
  bootstrapFile: string;
  simulateFailureAt?: string;
}

function makeDir(dir: string, created: string[]): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    created.push(dir);
  }
}

export async function provision(o: ProvisionOptions): Promise<SetupResult> {
  const p = paths(o.appDir, o.dataDir);
  const rule = firewallRuleName(o.port);
  mkdirSync(p.logDir, { recursive: true });
  const log = new SetupLog(join(p.logDir, "setup.log"));
  log.info(`Provision start: version=${SERVER_VERSION} dataDir=${o.dataDir} port=${o.port}`);

  const pgSuperPassword = secret();
  const ownerPassword = secret();
  const appPassword = secret();
  const pfxPassphrase = secret();
  const jwtSecret = secret(48);
  [pgSuperPassword, ownerPassword, appPassword, pfxPassphrase, jwtSecret].forEach((s) => log.addSecret(s));
  const superUrl = dbUrl("postgres", pgSuperPassword, "postgres");
  const ownerUrl = dbUrl(DB_OWNER, ownerPassword);

  let bootstrap: Bootstrap | null = null;
  const createdDirs: string[] = [];
  let fingerprint = "";

  const steps: Step[] = [
    {
      name: "preflight",
      code: "E_PREFLIGHT",
      run: async () => {
        // Read (and delete) the manager's password file first, whatever happens next.
        bootstrap = readBootstrap(o.bootstrapFile);
        log.addSecret(bootstrap.managerPassword);
        if (process.platform !== "win32") throw new SetupError("E_NOT_WINDOWS", "Setup runs on Windows only");
        for (const f of [join(p.pgBin, "initdb.exe"), join(p.pgBin, "pg_ctl.exe"), p.nodeExe, p.mainJs, p.winswSource]) {
          if (!existsSync(f)) throw new SetupError("E_FILES_MISSING", `Missing installed file ${f}`);
        }
        if (serviceStatus(log, PG_SERVICE) !== null || serviceStatus(log, API_SERVICE) !== null) {
          throw new SetupError("E_ALREADY_INSTALLED", "Alyassir services already exist on this computer");
        }
        // Never overwrite an existing database: it may hold the agency's data.
        if (existsSync(p.pgData) && readdirSync(p.pgData).length > 0) {
          throw new SetupError("E_DATA_EXISTS", `Data folder already contains a database: ${p.pgData}`);
        }
        if (!(await isPortFree(o.port))) throw new SetupError("E_API_PORT_IN_USE", `Port ${o.port} is in use`);
        if (!(await isPortFree(PG_PORT))) throw new SetupError("E_PG_PORT_IN_USE", `Port ${PG_PORT} is in use`);
      },
    },
    {
      name: "folders",
      code: "E_FOLDERS",
      run: () => {
        for (const d of [o.dataDir, p.pgData, p.certDir, p.serviceDir, p.secretDir, p.backupDir]) makeDir(d, createdDirs);
        for (const d of [p.secretDir, p.certDir, p.serviceDir, p.backupDir]) restrictAcl(log, d);
      },
      undo: () => {
        // Remove only what this setup created. The logs folder is kept for support.
        for (const d of [...createdDirs].reverse()) {
          if (d === o.dataDir) continue;
          rmSync(d, { recursive: true, force: true });
        }
      },
    },
    {
      name: "secrets",
      code: "E_SECRETS",
      run: () => {
        writeSecrets(log, p.secretsFile, {
          pgSuperuser: "postgres",
          pgSuperPassword,
          dbUser: DB_OWNER,
          dbPassword: ownerPassword,
          appUser: APP_ROLE,
          appPassword,
          jwtSecret,
          pfxPassphrase,
        }, p.secretDir);
      },
    },
    {
      name: "initdb",
      code: "E_PG_INIT",
      run: () => {
        // initdb drops admin rights while it runs (restricted token), so it needs its own
        // explicit access to the empty data folder. Removed again right after.
        const userSid = currentUserSid(log);
        run(log, "icacls.exe", [p.pgData, "/grant", `*${userSid}:(OI)(CI)F`, "/Q"], { code: "E_ACL" });
        // The password file must be readable by that restricted initdb process too.
        const pwFile = join(p.pgData, "..", "initdb.pw");
        writeFileSync(pwFile, pgSuperPassword);
        try {
          run(log, join(p.pgBin, "initdb.exe"), ["-D", p.pgData, "-U", "postgres", `--pwfile=${pwFile}`,
            "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C", "--data-checksums"],
            { code: "E_PG_INIT", timeoutMs: 300_000 });
        } finally {
          rmSync(pwFile, { force: true });
        }
        appendFileSync(join(p.pgData, "postgresql.conf"), POSTGRES_CONF.replace(/\n/g, "\r\n"));
        // PostgreSQL runs as NETWORK SERVICE; ordinary Windows users get no access to the database files.
        run(log, "icacls.exe", [p.pgData, "/remove:g", `*${userSid}`, "/Q"], { code: "E_ACL" });
        restrictAcl(log, p.pgData, [SID.networkService]);
      },
    },
    {
      name: "pg-service",
      code: "E_PG_SERVICE",
      run: () => {
        run(log, join(p.pgBin, "pg_ctl.exe"), ["register", "-N", PG_SERVICE, "-D", p.pgData, "-S", "auto", "-w", "-t", "120",
          // Without -U, pg_ctl uses LocalSystem; the database must run with low rights instead.
          "-U", "NT AUTHORITY\\NetworkService"], { code: "E_PG_SERVICE" });
      },
      undo: () => {
        stopService(log, PG_SERVICE);
        run(log, join(p.pgBin, "pg_ctl.exe"), ["unregister", "-N", PG_SERVICE], { allowFail: true });
      },
    },
    {
      name: "pg-start",
      code: "E_PG_START",
      run: async () => {
        try {
          startService(log, PG_SERVICE, "E_PG_START");
          if (!(await waitFor(() => pgReady(log, p.pgBin), 90_000))) throw new SetupError("E_PG_START", "PostgreSQL did not become ready");
        } catch (error) {
          logPostgresDiagnostics(log, p.pgBin, p.pgData);
          throw error;
        }
      },
      undo: () => stopService(log, PG_SERVICE),
    },
    {
      name: "database",
      code: "E_DB_CREATE",
      run: async () => {
        await withClient(superUrl, async (c) => {
          // Passwords are base64url (no quotes), so they are safe inside the SQL literal.
          await c.query(`CREATE ROLE ${DB_OWNER} LOGIN PASSWORD '${ownerPassword}'`);
          await c.query(`CREATE DATABASE ${DB_NAME} OWNER ${DB_OWNER} ENCODING 'UTF8' TEMPLATE template0`);
          await c.query(`REVOKE ALL ON DATABASE ${DB_NAME} FROM PUBLIC`);
        });
        await ensureAppRole(superUrl, appPassword);
      },
    },
    {
      name: "migrations",
      code: "E_MIGRATION",
      run: async () => {
        const applied = await migrate(ownerUrl);
        log.info(`Migrations applied: ${applied.join(", ") || "none"}`);
      },
    },
    {
      name: "bootstrap",
      code: "E_BOOTSTRAP",
      run: async () => {
        if (!bootstrap) throw new SetupError("E_BOOTSTRAP", "No agency information");
        await bootstrapData(ownerUrl, bootstrap);
        // The application account must work before going further.
        await withClient(dbUrl(APP_ROLE, appPassword), (c) => c.query("SELECT count(*) FROM users"));
      },
    },
    {
      name: "certificate",
      code: "E_CERT",
      run: () => {
        const script = `
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Security, PKI
$c = New-SelfSignedCertificate -Subject 'CN=Alyassir Server' -FriendlyName 'Alyassir Server' -DnsName @($env:COMPUTERNAME, 'localhost') -CertStoreLocation 'Cert:\\LocalMachine\\My' -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(20) -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.1')
try {
  $pw = ConvertTo-SecureString -String $env:ALYASSIR_PFX_PASS -Force -AsPlainText
  Export-PfxCertificate -Cert $c -FilePath $env:ALYASSIR_PFX_PATH -Password $pw -CryptoAlgorithmOption AES256_SHA256 | Out-Null
  Export-Certificate -Cert $c -FilePath $env:ALYASSIR_CER_PATH -Type CERT | Out-Null
} finally {
  Remove-Item -Path ('Cert:\\LocalMachine\\My\\' + $c.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue
}`;
        powershell(log, script, {
          code: "E_CERT",
          env: { ...process.env, ALYASSIR_PFX_PASS: pfxPassphrase, ALYASSIR_PFX_PATH: p.pfxPath, ALYASSIR_CER_PATH: p.cerPath },
        });
        fingerprint = certFingerprint(p.cerPath);
        log.info(`Certificate fingerprint (SHA-256): ${fingerprint}`);
      },
    },
    {
      name: "api-service",
      code: "E_SERVICE_INSTALL",
      run: () => {
        copyFileSync(p.winswSource, p.winswExe);
        writeFileSync(p.winswXml, winswXml({
          nodeExe: p.nodeExe,
          mainJs: p.mainJs,
          workDir: join(o.appDir, "server"),
          logDir: p.logDir,
          env: serviceEnv({ port: o.port, pfxPath: p.pfxPath, pfxPassphrase, appPassword, jwtSecret }),
        }));
        restrictAcl(log, p.serviceDir);
        run(log, p.winswExe, ["install"], { code: "E_SERVICE_INSTALL" });
      },
      undo: () => {
        stopService(log, API_SERVICE);
        run(log, p.winswExe, ["uninstall"], { allowFail: true });
      },
    },
    {
      name: "api-start",
      code: "E_SERVICE_START",
      run: () => startService(log, API_SERVICE, "E_SERVICE_START"),
      undo: () => stopService(log, API_SERVICE),
    },
    {
      name: "firewall",
      code: "E_FIREWALL",
      run: () => {
        run(log, "netsh.exe", ["advfirewall", "firewall", "add", "rule", `name=${rule}`, "dir=in", "action=allow",
          "protocol=TCP", `localport=${o.port}`, "profile=private", "enable=yes"], { code: "E_FIREWALL" });
      },
      undo: () => {
        run(log, "netsh.exe", ["advfirewall", "firewall", "delete", "rule", `name=${rule}`], { allowFail: true });
      },
    },
    {
      name: "health",
      code: "E_HEALTH",
      run: async () => {
        try {
          await waitHealthy(log, o.port, fingerprint);
        } catch (error) {
          logServiceTail(log, p.logDir);
          throw error;
        }
      },
    },
    {
      name: "state",
      code: "E_STATE",
      run: () => {
        const state: ProvisionState = {
          dataDir: o.dataDir, port: o.port, pgBin: p.pgBin, pgData: p.pgData,
          pgService: PG_SERVICE, apiService: API_SERVICE, winswExe: p.winswExe, firewallRule: rule,
          bootstrapped: true, version: SERVER_VERSION,
        };
        writeFileSync(stateFilePath(o.appDir), JSON.stringify(state, null, 2));
      },
    },
  ];

  const outcome = await runSteps(steps, log, o.simulateFailureAt);
  const result: SetupResult = outcome.ok
    ? { ok: true, port: o.port, urls: lanUrls(o.port), fingerprint, dataDir: o.dataDir }
    : { ok: false, errorCode: outcome.errorCode, failedStep: outcome.failedStep, message: outcome.message };
  writeResult(log, o.resultFile, result);
  return result;
}

/** Uninstall: remove services and the firewall rule. The data folder is always kept. */
export function unprovision(appDir: string): void {
  const file = stateFilePath(appDir);
  if (!existsSync(file)) return;
  const state = JSON.parse(readFileSync(file, "utf8")) as ProvisionState;
  const log = new SetupLog(join(state.dataDir, "logs", "setup.log"));
  log.info("Unprovision start (data folder is kept)");
  stopService(log, state.apiService);
  if (existsSync(state.winswExe)) run(log, state.winswExe, ["uninstall"], { allowFail: true });
  stopService(log, state.pgService);
  run(log, join(state.pgBin, "pg_ctl.exe"), ["unregister", "-N", state.pgService], { allowFail: true });
  run(log, "netsh.exe", ["advfirewall", "firewall", "delete", "rule", `name=${state.firewallRule}`], { allowFail: true });
  rmSync(file, { force: true });
  log.info("Unprovision end");
}
