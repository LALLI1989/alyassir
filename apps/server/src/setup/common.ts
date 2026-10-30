/** Pieces shared by first installation (provision) and update (upgrade). */
import { X509Certificate, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { Client } from "pg";
import { APP_ROLE, readMigrations } from "@alyassir/db";
import { PASSWORD_MIN_LENGTH, USERNAME_PATTERN, type Language } from "@alyassir/shared";
import { hashPassword, newRecoveryCode } from "../auth/passwords";
import type { SetupLog } from "./log";
import { SetupError } from "./steps";
import { powershell, restrictAcl, run, waitFor } from "./windows";

export const PG_PORT = 5433;
export const PG_SERVICE = "AlyassirPostgres";
export const API_SERVICE = "AlyassirServer";
export const DB_NAME = "alyassir";
/** Owns the database and runs migrations. The server itself uses APP_ROLE. */
export const DB_OWNER = "alyassir";
export { APP_ROLE };

/** What setup created, so update and uninstall act on exactly that (and nothing else). */
export interface ProvisionState {
  dataDir: string;
  port: number;
  pgBin: string;
  pgData: string;
  pgService: string;
  apiService: string;
  winswExe: string;
  firewallRule: string;
  /** Set once the first manager exists (missing on Phase 0 installations). */
  bootstrapped?: boolean;
  version?: string;
}

/** Secrets file, readable by Windows administrators only. */
export interface Secrets {
  pgSuperuser: string;
  pgSuperPassword: string;
  /** Database owner (migrations). Phase 0 called it dbUser. */
  dbUser: string;
  dbPassword: string;
  appUser?: string;
  appPassword?: string;
  jwtSecret?: string;
  pfxPassphrase?: string;
}

export interface SetupResult {
  ok: boolean;
  errorCode?: string;
  failedStep?: string;
  message?: string;
  port?: number;
  urls?: string[];
  fingerprint?: string;
  dataDir?: string;
  /** Phase 8A: the manager's recovery code, shown once at the end of a new installation. */
  recoveryCode?: string;
}

/** Agency and first manager, typed in the installer (SPEC 6.1). */
export interface Bootstrap {
  agencyName: string;
  managerUsername: string;
  managerPassword: string;
  language: Language;
  backupDir: string;
}

export function paths(appDir: string, dataDir: string) {
  return {
    pgBin: join(appDir, "pgsql", "bin"),
    nodeExe: join(appDir, "server", "node.exe"),
    mainJs: join(appDir, "server", "dist", "main.js"),
    winswSource: join(appDir, "service", "WinSW-x64.exe"),
    pgData: join(dataDir, "pgdata"),
    certDir: join(dataDir, "certs"),
    serviceDir: join(dataDir, "service"),
    secretDir: join(dataDir, "secrets"),
    logDir: join(dataDir, "logs"),
    backupDir: join(dataDir, "backups"),
    pfxPath: join(dataDir, "certs", "server.pfx"),
    cerPath: join(dataDir, "certs", "server.cer"),
    secretsFile: join(dataDir, "secrets", "secrets.json"),
    winswExe: join(dataDir, "service", `${API_SERVICE}.exe`),
    winswXml: join(dataDir, "service", `${API_SERVICE}.xml`),
  };
}

export function firewallRuleName(port: number): string {
  return `Alyassir Server (TCP ${port})`;
}

export function stateFilePath(appDir: string): string {
  return join(appDir, "provision-state.json");
}

export function secret(bytes = 24): string {
  // base64url: letters, digits, '-' and '_' only. Safe in URLs, SQL literals and XML.
  return randomBytes(bytes).toString("base64url");
}

export function readSecrets(file: string): Secrets {
  return JSON.parse(readFileSync(file, "utf8")) as Secrets;
}

export function writeSecrets(log: SetupLog, file: string, secrets: Secrets, secretDir: string): void {
  writeFileSync(file, JSON.stringify(secrets, null, 2));
  restrictAcl(log, secretDir);
}

/**
 * Reads the agency/manager file written by the installer, then deletes it at once (it holds
 * the manager's password). Format: UTF-8, one "key=value" per line.
 */
export function readBootstrap(file: string, log?: SetupLog, o: { restore?: boolean } = {}): Bootstrap {
  let text: string;
  try {
    text = readFileSync(file, "utf8").replace(/^﻿/, "");
  } finally {
    rmSync(file, { force: true });
  }
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) values.set(line.slice(0, i).trim(), line.slice(i + 1));
  }
  const b: Bootstrap = {
    agencyName: (values.get("agencyName") ?? "").trim(),
    managerUsername: (values.get("managerUsername") ?? "").trim(),
    managerPassword: values.get("managerPassword") ?? "",
    language: values.get("language") === "fr" ? "fr" : "ar",
    backupDir: (values.get("backupDir") ?? "").trim(),
  };
  // Code points, for support: shows at once if a non-Unicode step damaged the Arabic text.
  log?.info(`Agency name code points: ${[...b.agencyName].map((c) => c.codePointAt(0)?.toString(16)).join(" ")}`);
  // Restore as server: the agency and its manager come from the backup; only the folder is asked.
  if (!o.restore) {
    if (!b.agencyName || b.agencyName.length > 150) throw new SetupError("E_BOOTSTRAP_AGENCY", "Agency name missing or too long");
    if (!USERNAME_PATTERN.test(b.managerUsername)) throw new SetupError("E_BOOTSTRAP_USERNAME", "Invalid manager username");
    if (b.managerPassword.length < PASSWORD_MIN_LENGTH) throw new SetupError("E_BOOTSTRAP_PASSWORD", "Manager password too short");
  }
  if (!b.backupDir || !existsSync(b.backupDir) || !statSync(b.backupDir).isDirectory()) {
    throw new SetupError("E_BOOTSTRAP_BACKUP_DIR", "Backup folder does not exist");
  }
  return b;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function xmlUnescape(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function winswXml(o: { nodeExe: string; mainJs: string; workDir: string; logDir: string; env: Record<string, string> }): string {
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

/** Environment variables of an existing service file (used by update). */
export function readWinswEnv(xml: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const m of xml.matchAll(/<env name="([^"]*)" value="([^"]*)" \/>/g)) {
    if (m[1] !== undefined && m[2] !== undefined) env[xmlUnescape(m[1])] = xmlUnescape(m[2]);
  }
  return env;
}

export function serviceEnv(o: {
  port: number;
  pfxPath: string;
  pfxPassphrase: string;
  appPassword: string;
  jwtSecret: string;
  /** Backups (Phase 6B): where PostgreSQL's tools, the data folder and the secrets file are. */
  pgBin: string;
  dataDir: string;
  secretsFile: string;
}): Record<string, string> {
  return {
    ALYASSIR_PG_BIN: o.pgBin,
    ALYASSIR_DATA_DIR: o.dataDir,
    ALYASSIR_SECRETS_FILE: o.secretsFile,
    NODE_ENV: "production",
    ALYASSIR_HOST: "0.0.0.0",
    ALYASSIR_PORT: String(o.port),
    ALYASSIR_TLS_PFX: o.pfxPath,
    ALYASSIR_TLS_PFX_PASSPHRASE: o.pfxPassphrase,
    ALYASSIR_JWT_SECRET: o.jwtSecret,
    DATABASE_URL: dbUrl(APP_ROLE, o.appPassword),
  };
}

export function dbUrl(user: string, password: string, database = DB_NAME): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${PG_PORT}/${database}`;
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

export function certFingerprint(cerPath: string): string {
  return new X509Certificate(readFileSync(cerPath)).fingerprint256;
}

/** Waits until the server answers OK over HTTPS with the expected certificate. */
export async function waitHealthy(log: SetupLog, port: number, fingerprint: string): Promise<void> {
  let last = "no answer";
  const ok = await waitFor(async () => {
    try {
      const probe = await probeHealth(port);
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
  log.info("Server health check OK");
}

export function pgReady(log: SetupLog, pgBin: string): boolean {
  return run(log, join(pgBin, "pg_isready.exe"), ["-h", "127.0.0.1", "-p", String(PG_PORT)], { allowFail: true }).status === 0;
}

/** Writes into the setup log why PostgreSQL could not start, for support. */
export function logPostgresDiagnostics(log: SetupLog, pgBin: string, pgData: string): void {
  try {
    powershell(log, `Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-10)} -ErrorAction SilentlyContinue |
      Where-Object { $_.ProviderName -like '*PostgreSQL*' -or $_.ProviderName -like '*pg_ctl*' } |
      Select-Object -First 15 | ForEach-Object { 'EVENT ' + $_.ProviderName + ': ' + $_.Message }`, { allowFail: true });
    const logDir = join(pgData, "log");
    if (existsSync(logDir)) {
      for (const f of readdirSync(logDir)) log.info(`PGLOG ${f}: ${readFileSync(join(logDir, f), "utf8").slice(-3000)}`);
    }
  } catch (error) {
    log.info(`Diagnostics failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Copies the last lines of the server's own log into the setup log (for support). */
export function logServiceTail(log: SetupLog, logDir: string): void {
  try {
    for (const f of readdirSync(logDir).filter((n) => n.startsWith(API_SERVICE) && n.endsWith(".log"))) {
      log.info(`SERVICE LOG ${f}: ${readFileSync(join(logDir, f), "utf8").slice(-3000)}`);
    }
  } catch {
    // nothing to add
  }
}

export async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates the application role if missing, and (re)sets its password. Needs the superuser. */
export async function ensureAppRole(superUrl: string, appPassword: string): Promise<void> {
  await withClient(superUrl, async (c) => {
    const exists = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_ROLE]);
    // Passwords are base64url (no quotes), so they are safe inside the SQL literal.
    if (exists.rowCount) await c.query(`ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${appPassword}'`);
    else await c.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${appPassword}'`);
    await c.query(`GRANT CONNECT ON DATABASE ${DB_NAME} TO ${APP_ROLE}`);
  });
}

/** Creates the agency settings and the only manager, if there is no manager yet. */
/** Agency and first manager; returns the manager's recovery code (Phase 8A), to show once. */
export async function bootstrapData(ownerUrl: string, b: Bootstrap): Promise<string> {
  const passwordHash = await hashPassword(b.managerPassword);
  const recovery = await newRecoveryCode();
  await withClient(ownerUrl, async (c) => {
    await c.query("BEGIN");
    try {
      const existing = await c.query("SELECT 1 FROM users WHERE role = 'manager'");
      if (existing.rowCount) throw new SetupError("E_MANAGER_EXISTS", "A manager already exists");
      await c.query(
        `INSERT INTO agency_settings (id, name_ar, name_fr, backup_dir) VALUES (1, $1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET name_ar = EXCLUDED.name_ar, name_fr = EXCLUDED.name_fr, backup_dir = EXCLUDED.backup_dir`,
        [b.agencyName, b.backupDir],
      );
      const user = await c.query<{ id: string }>(
        `INSERT INTO users (username, display_name, password_hash, role, language, recovery_code_hash, recovery_created_at)
         VALUES ($1, $1, $2, 'manager', $3, $4, now()) RETURNING id`,
        [b.managerUsername, passwordHash, b.language, recovery.hash],
      );
      await c.query(
        `INSERT INTO audit_log (user_id, action, entity_type, entity_id, after, device)
         VALUES ($1, 'system.install', 'user', $2, $3, 'setup')`,
        [user.rows[0]?.id, user.rows[0]?.id, JSON.stringify({ agencyName: b.agencyName, managerUsername: b.managerUsername, backupDir: b.backupDir })],
      );
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    }
  });
  return recovery.code;
}

export async function hasManager(ownerUrl: string): Promise<boolean> {
  return withClient(ownerUrl, async (c) => {
    const res = await c.query("SELECT 1 FROM users WHERE role = 'manager'").catch(() => ({ rowCount: 0 }));
    return (res.rowCount ?? 0) > 0;
  });
}

export function resultIni(r: SetupResult): string {
  const lines = ["[result]", `ok=${r.ok ? 1 : 0}`];
  if (r.errorCode) lines.push(`code=${r.errorCode}`);
  if (r.failedStep) lines.push(`step=${r.failedStep}`);
  if (r.fingerprint) lines.push(`fingerprint=${r.fingerprint}`);
  if (r.port) lines.push(`port=${r.port}`);
  if (r.recoveryCode) lines.push(`recovery=${r.recoveryCode}`);
  (r.urls ?? []).forEach((url, i) => lines.push(`url${i}=${url}`));
  lines.push(`urlCount=${(r.urls ?? []).length}`);
  return lines.join("\r\n") + "\r\n";
}

export function writeResult(log: SetupLog, file: string, r: SetupResult): void {
  writeFileSync(file, JSON.stringify(r, null, 2));
  // Same result as INI, which the installer (Inno Setup) reads natively.
  writeFileSync(`${file}.ini`, resultIni(r));
  log.info(`Result: ${r.ok ? "SUCCESS" : `FAILED ${r.errorCode ?? ""} at ${r.failedStep ?? "-"}`}`);
}

/**
 * Restore as server (SPEC 20.1): the chosen backup must be complete (its SHA-256 file, when present,
 * matches), readable, and not made by a newer version of the program.
 */
export function checkRestoreFile(log: SetupLog, file: string, pgBin: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) throw new SetupError("E_RESTORE_FILE", `Backup file not found: ${file}`);
  const fp = `${file}.sha256`;
  if (existsSync(fp)) {
    const expected = readFileSync(fp, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (expected !== actual) throw new SetupError("E_RESTORE_CORRUPT", "The backup does not match its SHA-256 fingerprint");
  }
  run(log, join(pgBin, "pg_restore.exe"), ["--list", file], { code: "E_RESTORE_CORRUPT" });
  const out = run(log, join(pgBin, "pg_restore.exe"), ["--data-only", "--table=schema_migrations", "-f", "-", file], { code: "E_RESTORE_CORRUPT" }).stdout;
  const versions: string[] = [];
  let inCopy = false;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("COPY ") && line.includes("schema_migrations")) inCopy = true;
    else if (inCopy && line === "\\.") inCopy = false;
    else if (inCopy && line.trim()) versions.push(line.split("\t")[0] ?? "");
  }
  const known = new Set(readMigrations().map((m) => m.version));
  if (versions.length === 0) throw new SetupError("E_RESTORE_CORRUPT", "No database steps found in the backup");
  if (versions.some((v) => !known.has(v))) throw new SetupError("E_RESTORE_NEWER", "The backup comes from a newer version of Alyassir");
  log.info(`Backup to restore: ${file} (database steps ${versions.join(", ")})`);
}

/** After restoring as server: the backup folder of this computer, and a line in the audit log. */
export async function restoredAgency(ownerUrl: string, backupDir: string, file: string): Promise<void> {
  await withClient(ownerUrl, async (c) => {
    const manager = await c.query<{ id: string }>("SELECT id FROM users WHERE role = 'manager'");
    if (!manager.rowCount) throw new SetupError("E_RESTORE_CORRUPT", "The backup has no manager");
    await c.query("UPDATE agency_settings SET backup_dir = $1, updated_at = now() WHERE id = 1", [backupDir]);
    await c.query("UPDATE backup_runs SET status = 'failed', error = 'interrupted', finished_at = now() WHERE status = 'running'").catch(() => undefined);
    await c.query(
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, after, device) VALUES (NULL, 'system.restore_as_server', 'backup', $1, $2, 'setup')`,
      [file.split(/[\\/]/).pop() ?? file, JSON.stringify({ file: file.split(/[\\/]/).pop() ?? file, backupDir })],
    );
  });
}
