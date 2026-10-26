import { X509Certificate, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { request } from "node:https";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { Client } from "pg";
import { SetupLog } from "./log";
import { isPortFree } from "./ports";
import { SetupError, runSteps, type Step } from "./steps";
import { SID, currentUserSid, powershell, restrictAcl, run, serviceStatus, startService, stopService, waitFor } from "./windows";

export const PG_PORT = 5433;
export const PG_SERVICE = "AlyassirPostgres";
export const API_SERVICE = "AlyassirServer";
export const DB_NAME = "alyassir";
export const DB_USER = "alyassir";

export interface ProvisionOptions {
  appDir: string;
  dataDir: string;
  port: number;
  resultFile: string;
  simulateFailureAt?: string;
}

/** What setup created, so uninstall can remove exactly that (and nothing else). */
export interface ProvisionState {
  dataDir: string;
  port: number;
  pgBin: string;
  pgData: string;
  pgService: string;
  apiService: string;
  winswExe: string;
  firewallRule: string;
}

export interface ProvisionResult {
  ok: boolean;
  errorCode?: string;
  failedStep?: string;
  message?: string;
  port?: number;
  urls?: string[];
  fingerprint?: string;
  dataDir?: string;
}

export function firewallRuleName(port: number): string {
  return `Alyassir Server (TCP ${port})`;
}

export function stateFilePath(appDir: string): string {
  return join(appDir, "provision-state.json");
}

function secret(): string {
  // base64url: letters, digits, '-' and '_' only. Safe in URLs, SQL literals and XML.
  return randomBytes(24).toString("base64url");
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function winswXml(o: {
  nodeExe: string;
  mainJs: string;
  workDir: string;
  logDir: string;
  env: Record<string, string>;
}): string {
  const env = Object.entries(o.env)
    .map(([name, value]) => `  <env name="${xmlEscape(name)}" value="${xmlEscape(value)}" />`)
    .join("\n");
  return `<service>
  <id>${API_SERVICE}</id>
  <name>Alyassir Server</name>
  <description>Alyassir insurance agency server (API + realtime).</description>
  <executable>${xmlEscape(o.nodeExe)}</executable>
  <arguments>"${xmlEscape(o.mainJs)}"</arguments>
  <workingdirectory>${xmlEscape(o.workDir)}</workingdirectory>
  <startmode>Automatic</startmode>
  <depend>${PG_SERVICE}</depend>
  <onfailure action="restart" delay="5 sec" />
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="30 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>${xmlEscape(o.logDir)}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
${env}
</service>
`;
}

/** Durability settings for power cuts (SPEC 4.17): never trade safety for speed. */
export const POSTGRES_CONF = `
# --- Alyassir settings (written by setup) ---
listen_addresses = '127.0.0.1'
port = ${PG_PORT}
fsync = on
synchronous_commit = on
full_page_writes = on
wal_log_hints = on
password_encryption = 'scram-sha-256'
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%a.log'
log_truncate_on_rotation = on
log_rotation_age = 1d
log_timezone = 'UTC'
timezone = 'UTC'
`;

export function lanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== "IPv4" || ni.internal || ni.address.startsWith("169.254.")) continue;
      urls.push(`https://${ni.address}:${port}`);
    }
  }
  return urls;
}

export interface HealthProbe {
  status: number;
  fingerprint: string;
  body: string;
}

export function probeHealth(port: number): Promise<HealthProbe> {
  return new Promise((resolve, reject) => {
    const req = request(
      // The certificate is self-signed: identity is checked by fingerprint below, not by a CA.
      { host: "127.0.0.1", port, path: "/api/health", rejectUnauthorized: false, timeout: 5000 },
      (res) => {
        const fingerprint = (res.socket as TLSSocket).getPeerCertificate().fingerprint256 ?? "";
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, fingerprint, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** Writes into the setup log why PostgreSQL could not start, for support. */
function logPostgresDiagnostics(log: SetupLog, pgBin: string, pgData: string): void {
  try {
    powershell(log, `Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue |
      Where-Object { $_.ProviderName -like '*PostgreSQL*' -or $_.ProviderName -like '*pg_ctl*' } |
      Select-Object -First 15 | ForEach-Object { 'EVENT ' + $_.ProviderName + ': ' + $_.Message }`, { allowFail: true });
    powershell(log, `Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Service Control Manager'; StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue |
      Select-Object -First 5 | ForEach-Object { 'SCM: ' + $_.Message }`, { allowFail: true });
    const logDir = join(pgData, "log");
    if (existsSync(logDir)) {
      for (const f of readdirSync(logDir)) log.info(`PGLOG ${f}: ${readFileSync(join(logDir, f), "utf8").slice(-3000)}`);
    }
    // Same start as the current user (pg_ctl drops admin rights itself) to capture the real error message.
    const trial = join(pgData, "..", "logs", "pg-trial-start.log");
    run(log, join(pgBin, "pg_ctl.exe"), ["start", "-D", pgData, "-w", "-t", "30", "-l", trial], { allowFail: true });
    if (existsSync(trial)) log.info(`PG TRIAL START: ${readFileSync(trial, "utf8").slice(-3000)}`);
    run(log, join(pgBin, "pg_ctl.exe"), ["stop", "-D", pgData, "-m", "fast", "-w"], { allowFail: true });
  } catch (error) {
    log.info(`Diagnostics failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function makeDir(dir: string, created: string[]): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    created.push(dir);
  }
}

export async function provision(o: ProvisionOptions): Promise<ProvisionResult> {
  const pgBin = join(o.appDir, "pgsql", "bin");
  const nodeExe = join(o.appDir, "server", "node.exe");
  const mainJs = join(o.appDir, "server", "dist", "main.js");
  const winswSource = join(o.appDir, "service", "WinSW-x64.exe");

  const pgData = join(o.dataDir, "pgdata");
  const certDir = join(o.dataDir, "certs");
  const serviceDir = join(o.dataDir, "service");
  const secretDir = join(o.dataDir, "secrets");
  const logDir = join(o.dataDir, "logs");
  const pfxPath = join(certDir, "server.pfx");
  const cerPath = join(certDir, "server.cer");
  const winswExe = join(serviceDir, `${API_SERVICE}.exe`);
  const winswXmlPath = join(serviceDir, `${API_SERVICE}.xml`);
  const rule = firewallRuleName(o.port);

  mkdirSync(logDir, { recursive: true });
  const log = new SetupLog(join(logDir, "setup.log"));
  log.info(`Provision start: dataDir=${o.dataDir} port=${o.port}`);

  const pgSuperPassword = secret();
  const dbPassword = secret();
  const pfxPassphrase = secret();
  [pgSuperPassword, dbPassword, pfxPassphrase].forEach((s) => log.addSecret(s));

  const createdDirs: string[] = [];
  let fingerprint = "";
  const pgReady = (): boolean =>
    run(log, join(pgBin, "pg_isready.exe"), ["-h", "127.0.0.1", "-p", String(PG_PORT)], { allowFail: true }).status === 0;

  const steps: Step[] = [
    {
      name: "preflight",
      code: "E_PREFLIGHT",
      run: async () => {
        if (process.platform !== "win32") throw new SetupError("E_NOT_WINDOWS", "Setup runs on Windows only");
        for (const f of [join(pgBin, "initdb.exe"), join(pgBin, "pg_ctl.exe"), nodeExe, mainJs, winswSource]) {
          if (!existsSync(f)) throw new SetupError("E_FILES_MISSING", `Missing installed file ${f}`);
        }
        if (serviceStatus(log, PG_SERVICE) !== null || serviceStatus(log, API_SERVICE) !== null) {
          throw new SetupError("E_ALREADY_INSTALLED", "Alyassir services already exist on this computer");
        }
        // Never overwrite an existing database: it may hold the agency's data.
        if (existsSync(pgData) && readdirSync(pgData).length > 0) {
          throw new SetupError("E_DATA_EXISTS", `Data folder already contains a database: ${pgData}`);
        }
        if (!(await isPortFree(o.port))) throw new SetupError("E_API_PORT_IN_USE", `Port ${o.port} is in use`);
        if (!(await isPortFree(PG_PORT))) throw new SetupError("E_PG_PORT_IN_USE", `Port ${PG_PORT} is in use`);
      },
    },
    {
      name: "folders",
      code: "E_FOLDERS",
      run: () => {
        for (const d of [o.dataDir, pgData, certDir, serviceDir, secretDir]) makeDir(d, createdDirs);
        restrictAcl(log, secretDir);
        restrictAcl(log, certDir);
        restrictAcl(log, serviceDir);
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
        const file = join(secretDir, "secrets.json");
        writeFileSync(file, JSON.stringify({ pgSuperuser: "postgres", pgSuperPassword, dbUser: DB_USER, dbPassword }, null, 2));
        restrictAcl(log, secretDir);
      },
    },
    {
      name: "initdb",
      code: "E_PG_INIT",
      run: () => {
        // initdb drops admin rights while it runs (restricted token), so it needs its own
        // explicit access to the empty data folder. Removed again right after.
        const userSid = currentUserSid(log);
        run(log, "icacls.exe", [pgData, "/grant", `*${userSid}:(OI)(CI)F`, "/Q"], { code: "E_ACL" });
        // The password file must be readable by that restricted initdb process too.
        const pwFile = join(pgData, "..", "initdb.pw");
        writeFileSync(pwFile, pgSuperPassword);
        try {
          run(log, join(pgBin, "initdb.exe"), ["-D", pgData, "-U", "postgres", `--pwfile=${pwFile}`,
            "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C", "--data-checksums"],
            { code: "E_PG_INIT", timeoutMs: 300_000 });
        } finally {
          rmSync(pwFile, { force: true });
        }
        appendFileSync(join(pgData, "postgresql.conf"), POSTGRES_CONF.replace(/\n/g, "\r\n"));
        // PostgreSQL runs as NETWORK SERVICE; ordinary Windows users get no access to the database files.
        run(log, "icacls.exe", [pgData, "/remove:g", `*${userSid}`, "/Q"], { code: "E_ACL" });
        restrictAcl(log, pgData, [SID.networkService]);
        run(log, "icacls.exe", [join(pgData, "postgresql.conf")], { allowFail: true }); // logged for support
      },
    },
    {
      name: "pg-service",
      code: "E_PG_SERVICE",
      run: () => {
        run(log, join(pgBin, "pg_ctl.exe"), ["register", "-N", PG_SERVICE, "-D", pgData, "-S", "auto", "-w", "-t", "120",
          // Without -U, pg_ctl uses LocalSystem; the database must run with low rights instead.
          "-U", "NT AUTHORITY\\NetworkService"],
          { code: "E_PG_SERVICE" });
      },
      undo: () => {
        stopService(log, PG_SERVICE);
        run(log, join(pgBin, "pg_ctl.exe"), ["unregister", "-N", PG_SERVICE], { allowFail: true });
      },
    },
    {
      name: "pg-start",
      code: "E_PG_START",
      run: async () => {
        try {
          startService(log, PG_SERVICE, "E_PG_START");
          if (!(await waitFor(pgReady, 90_000))) throw new SetupError("E_PG_START", "PostgreSQL did not become ready");
        } catch (error) {
          logPostgresDiagnostics(log, pgBin, pgData);
          throw error;
        }
      },
      undo: () => stopService(log, PG_SERVICE),
    },
    {
      name: "database",
      code: "E_DB_CREATE",
      run: async () => {
        const client = new Client({ host: "127.0.0.1", port: PG_PORT, user: "postgres", password: pgSuperPassword, database: "postgres" });
        await client.connect();
        try {
          // Passwords are base64url (no quotes), so they are safe inside the SQL literal.
          await client.query(`CREATE ROLE ${DB_USER} LOGIN PASSWORD '${dbPassword}'`);
          await client.query(`CREATE DATABASE ${DB_NAME} OWNER ${DB_USER} ENCODING 'UTF8' TEMPLATE template0`);
          await client.query(`REVOKE ALL ON DATABASE ${DB_NAME} FROM PUBLIC`);
        } finally {
          await client.end();
        }
        // Prove the application account works before going further.
        const app = new Client({ host: "127.0.0.1", port: PG_PORT, user: DB_USER, password: dbPassword, database: DB_NAME });
        await app.connect();
        await app.query("SELECT 1");
        await app.end();
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
          env: { ...process.env, ALYASSIR_PFX_PASS: pfxPassphrase, ALYASSIR_PFX_PATH: pfxPath, ALYASSIR_CER_PATH: cerPath },
        });
        fingerprint = new X509Certificate(readFileSync(cerPath)).fingerprint256;
        log.info(`Certificate fingerprint (SHA-256): ${fingerprint}`);
      },
    },
    {
      name: "api-service",
      code: "E_SERVICE_INSTALL",
      run: () => {
        copyFileSync(winswSource, winswExe);
        writeFileSync(winswXmlPath, winswXml({
          nodeExe,
          mainJs,
          workDir: join(o.appDir, "server"),
          logDir,
          env: {
            NODE_ENV: "production",
            ALYASSIR_HOST: "0.0.0.0",
            ALYASSIR_PORT: String(o.port),
            ALYASSIR_TLS_PFX: pfxPath,
            ALYASSIR_TLS_PFX_PASSPHRASE: pfxPassphrase,
            DATABASE_URL: `postgres://${DB_USER}:${dbPassword}@127.0.0.1:${PG_PORT}/${DB_NAME}`,
          },
        }));
        restrictAcl(log, serviceDir);
        run(log, winswExe, ["install"], { code: "E_SERVICE_INSTALL" });
      },
      undo: () => {
        stopService(log, API_SERVICE);
        run(log, winswExe, ["uninstall"], { allowFail: true });
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
        let last = "no answer";
        const ok = await waitFor(async () => {
          try {
            const probe = await probeHealth(o.port);
            last = `HTTP ${probe.status} ${probe.body}`;
            if (probe.fingerprint !== fingerprint) {
              last = "certificate fingerprint mismatch";
              return false;
            }
            const body = JSON.parse(probe.body) as { status?: string; database?: string };
            return probe.status === 200 && body.status === "ok" && body.database === "ok";
          } catch (error) {
            last = error instanceof Error ? error.message : String(error);
            return false;
          }
        }, 120_000, 2000);
        if (!ok) throw new SetupError("E_HEALTH", `Server health check failed: ${last}`);
      },
    },
    {
      name: "state",
      code: "E_STATE",
      run: () => {
        const state: ProvisionState = {
          dataDir: o.dataDir, port: o.port, pgBin, pgData,
          pgService: PG_SERVICE, apiService: API_SERVICE, winswExe, firewallRule: rule,
        };
        writeFileSync(stateFilePath(o.appDir), JSON.stringify(state, null, 2));
      },
    },
  ];

  const outcome = await runSteps(steps, log, o.simulateFailureAt);
  const result: ProvisionResult = outcome.ok
    ? { ok: true, port: o.port, urls: lanUrls(o.port), fingerprint, dataDir: o.dataDir }
    : { ok: false, errorCode: outcome.errorCode, failedStep: outcome.failedStep, message: outcome.message };
  writeFileSync(o.resultFile, JSON.stringify(result, null, 2));
  // Same result as INI, which the installer (Inno Setup) reads natively.
  writeFileSync(`${o.resultFile}.ini`, resultIni(result));
  log.info(`Provision end: ${outcome.ok ? "SUCCESS" : `FAILED ${outcome.errorCode}`}`);
  return result;
}

export function resultIni(r: ProvisionResult): string {
  const lines = ["[result]", `ok=${r.ok ? 1 : 0}`];
  if (r.errorCode) lines.push(`code=${r.errorCode}`);
  if (r.failedStep) lines.push(`step=${r.failedStep}`);
  if (r.fingerprint) lines.push(`fingerprint=${r.fingerprint}`);
  if (r.port) lines.push(`port=${r.port}`);
  (r.urls ?? []).forEach((url, i) => lines.push(`url${i}=${url}`));
  lines.push(`urlCount=${(r.urls ?? []).length}`);
  return lines.join("\r\n") + "\r\n";
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
