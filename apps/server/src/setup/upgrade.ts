/**
 * Update of an installed server (SPEC 6.3). The installer has already stopped both services
 * and replaced the program files. Order: start database -> full backup -> migrations ->
 * service settings -> start -> health check. If migrations or the start fail, the database is
 * restored from the backup taken a minute earlier: the agency's data is never lost.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "@alyassir/db";
import { SERVER_VERSION } from "../version";
import {
  API_SERVICE,
  APP_ROLE,
  DB_NAME,
  PG_SERVICE,
  bootstrapData,
  certFingerprint,
  dbUrl,
  ensureAppRole,
  hasManager,
  lanUrls,
  logPostgresDiagnostics,
  logServiceTail,
  paths,
  pgReady,
  readBootstrap,
  readSecrets,
  readWinswEnv,
  secret,
  serviceEnv,
  stateFilePath,
  waitHealthy,
  winswXml,
  withClient,
  writeResult,
  writeSecrets,
  type Bootstrap,
  type ProvisionState,
  type Secrets,
  type SetupResult,
} from "./common";
import { SetupLog } from "./log";
import { SetupError, runSteps, type Step } from "./steps";
import { restrictAcl, run, serviceStatus, startService, stopService, waitFor } from "./windows";

export interface UpgradeOptions {
  appDir: string;
  resultFile: string;
  /** Only needed when the installation has no manager yet (installed by Phase 0). */
  bootstrapFile?: string;
  simulateFailureAt?: string;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

export async function upgrade(o: UpgradeOptions): Promise<SetupResult> {
  const stateFile = stateFilePath(o.appDir);
  if (!existsSync(stateFile)) throw new SetupError("E_NOT_INSTALLED", "No server installation found");
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as ProvisionState;
  const p = paths(o.appDir, state.dataDir);
  mkdirSync(p.logDir, { recursive: true });
  const log = new SetupLog(join(p.logDir, "setup.log"));
  log.info(`Upgrade start: to version ${SERVER_VERSION} (installed: ${state.version ?? "0.0.1"})`);

  let secrets: Secrets = readSecrets(p.secretsFile);
  const oldEnv = existsSync(p.winswXml) ? readWinswEnv(readFileSync(p.winswXml, "utf8")) : {};
  // Phase 0 kept the certificate password only in the service file.
  secrets = {
    ...secrets,
    pfxPassphrase: secrets.pfxPassphrase ?? oldEnv.ALYASSIR_TLS_PFX_PASSPHRASE,
    appUser: APP_ROLE,
    appPassword: secrets.appPassword ?? secret(),
    jwtSecret: secrets.jwtSecret ?? secret(48),
  };
  for (const s of Object.values(secrets)) if (typeof s === "string" && s.length >= 16) log.addSecret(s);
  if (!secrets.pfxPassphrase) throw new SetupError("E_UPGRADE_SECRETS", "Certificate password not found");

  const superUrl = dbUrl(secrets.pgSuperuser, secrets.pgSuperPassword, "postgres");
  const ownerUrl = dbUrl(secrets.dbUser, secrets.dbPassword);
  let bootstrap: Bootstrap | null = null;
  let backupFile = "";
  let fingerprint = "";

  const restoreBackup = async (): Promise<void> => {
    if (!backupFile) return;
    log.info(`Restoring the database from ${backupFile}`);
    stopService(log, API_SERVICE);
    await withClient(superUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${DB_NAME} OWNER ${secrets.dbUser} ENCODING 'UTF8' TEMPLATE template0`);
      await c.query(`REVOKE ALL ON DATABASE ${DB_NAME} FROM PUBLIC`);
    });
    run(log, join(p.pgBin, "pg_restore.exe"), ["-h", "127.0.0.1", "-p", "5433", "-U", secrets.pgSuperuser, "-d", DB_NAME, "--exit-on-error", backupFile], {
      code: "E_RESTORE",
      env: { ...process.env, PGPASSWORD: secrets.pgSuperPassword },
      timeoutMs: 600_000,
    });
    log.info("Database restored as it was before the update");
  };

  const steps: Step[] = [
    {
      name: "preflight",
      code: "E_PREFLIGHT",
      run: () => {
        if (o.bootstrapFile && existsSync(o.bootstrapFile)) {
          bootstrap = readBootstrap(o.bootstrapFile);
          log.addSecret(bootstrap.managerPassword);
        }
        if (serviceStatus(log, PG_SERVICE) === null || serviceStatus(log, API_SERVICE) === null) {
          throw new SetupError("E_NOT_INSTALLED", "Alyassir services are missing");
        }
        stopService(log, API_SERVICE);
      },
    },
    {
      name: "pg-start",
      code: "E_PG_START",
      run: async () => {
        if (serviceStatus(log, PG_SERVICE) !== "Running") startService(log, PG_SERVICE, "E_PG_START");
        if (!(await waitFor(() => pgReady(log, p.pgBin), 90_000))) {
          logPostgresDiagnostics(log, p.pgBin, p.pgData);
          throw new SetupError("E_PG_START", "PostgreSQL did not become ready");
        }
      },
    },
    {
      name: "backup",
      code: "E_BACKUP",
      run: () => {
        // Automatic full backup before any migration (SPEC 6.3).
        mkdirSync(p.backupDir, { recursive: true });
        restrictAcl(log, p.backupDir);
        backupFile = join(p.backupDir, `pre-update-${stamp()}.dump`);
        const env = { ...process.env, PGPASSWORD: secrets.pgSuperPassword };
        run(log, join(p.pgBin, "pg_dump.exe"), ["-h", "127.0.0.1", "-p", "5433", "-U", secrets.pgSuperuser, "-Fc", "-f", backupFile, DB_NAME], {
          code: "E_BACKUP",
          env,
          timeoutMs: 600_000,
        });
        // Readability check: the archive must list its contents.
        run(log, join(p.pgBin, "pg_restore.exe"), ["--list", backupFile], { code: "E_BACKUP" });
        const hash = sha256File(backupFile);
        writeFileSync(`${backupFile}.sha256`, `${hash}  ${backupFile.split(/[\\/]/).pop() ?? ""}\r\n`);
        log.info(`Backup OK: ${backupFile} sha256=${hash}`);
      },
    },
    {
      name: "roles",
      code: "E_DB_ROLES",
      run: async () => {
        await ensureAppRole(superUrl, secrets.appPassword ?? "");
        writeSecrets(log, p.secretsFile, secrets, p.secretDir);
      },
    },
    {
      name: "migrations",
      code: "E_MIGRATION",
      run: async () => {
        try {
          const applied = await migrate(ownerUrl);
          log.info(`Migrations applied: ${applied.join(", ") || "none"}`);
        } catch (error) {
          // Earlier migrations of this run may be committed: go back to the backup.
          await restoreBackup();
          throw error;
        }
      },
      undo: restoreBackup,
    },
    {
      name: "bootstrap",
      code: "E_BOOTSTRAP",
      run: async () => {
        if (await hasManager(ownerUrl)) return;
        if (!bootstrap) throw new SetupError("E_BOOTSTRAP_NEEDED", "This installation has no manager yet");
        await bootstrapData(ownerUrl, bootstrap);
      },
    },
    {
      name: "service-config",
      code: "E_SERVICE_INSTALL",
      run: () => {
        const previous = existsSync(p.winswXml) ? readFileSync(p.winswXml, "utf8") : "";
        if (previous) writeFileSync(`${p.winswXml}.previous`, previous);
        writeFileSync(p.winswXml, winswXml({
          nodeExe: p.nodeExe,
          mainJs: p.mainJs,
          workDir: join(o.appDir, "server"),
          logDir: p.logDir,
          env: serviceEnv({
            port: state.port,
            pfxPath: p.pfxPath,
            pfxPassphrase: secrets.pfxPassphrase ?? "",
            appPassword: secrets.appPassword ?? "",
            jwtSecret: secrets.jwtSecret ?? "",
          }),
        }));
        restrictAcl(log, p.serviceDir);
        run(log, p.winswExe, ["refresh"], { allowFail: true });
      },
      undo: () => {
        if (existsSync(`${p.winswXml}.previous`)) writeFileSync(p.winswXml, readFileSync(`${p.winswXml}.previous`));
      },
    },
    {
      name: "api-start",
      code: "E_SERVICE_START",
      run: async () => {
        startService(log, API_SERVICE, "E_SERVICE_START");
        fingerprint = certFingerprint(p.cerPath);
        try {
          await waitHealthy(log, state.port, fingerprint);
        } catch (error) {
          logServiceTail(log, p.logDir);
          throw error;
        }
      },
      undo: () => stopService(log, API_SERVICE),
    },
    {
      name: "state",
      code: "E_STATE",
      run: () => {
        writeFileSync(stateFilePath(o.appDir), JSON.stringify({ ...state, bootstrapped: true, version: SERVER_VERSION }, null, 2));
      },
    },
  ];

  const outcome = await runSteps(steps, log, o.simulateFailureAt);
  const result: SetupResult = outcome.ok
    ? { ok: true, port: state.port, urls: lanUrls(state.port), fingerprint, dataDir: state.dataDir }
    : { ok: false, errorCode: outcome.errorCode, failedStep: outcome.failedStep, message: outcome.message };
  writeResult(log, o.resultFile, result);
  return result;
}

/** For the installer: does this installation still need the first manager? */
export function needsBootstrap(appDir: string): boolean {
  const file = stateFilePath(appDir);
  if (!existsSync(file)) return true;
  return (JSON.parse(readFileSync(file, "utf8")) as ProvisionState).bootstrapped !== true;
}

export { DB_NAME };
