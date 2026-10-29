import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * All server settings come from environment variables only (SPEC 4.13).
 * On the server computer, the Windows service (WinSW) sets them.
 */
export interface ServerConfig {
  host: string;
  port: number;
  /** Connection as the application role (no rights to change the structure). */
  databaseUrl: string;
  jwtSecret: string;
  tls: { pfx: Buffer; passphrase: string } | null;
  /** Browser origin allowed in automated UI tests only. */
  testCorsOrigin?: string;
  /** Sign-in attempts per minute and per network address. */
  loginRateLimitPerMinute?: number;
  /** Backups and restore (SPEC 20). Absent: this server takes no backups (demo). */
  backup?: BackupConfig;
}

export interface BackupConfig {
  /** Folder of pg_dump / pg_restore ("" = found on the PATH). */
  pgBin: string;
  /** PostgreSQL superuser, database "postgres" (dump, drop and re-create on restore). */
  superUrl: string;
  /** Database owner (migrations after a restore). */
  ownerUrl: string;
  dbName: string;
  dbOwner: string;
  /** The server's own backup folder (before updates, safety copies before a restore). */
  internalDir: string;
  /** Tests only: a folder that plays the USB key. */
  usbTestDir?: string;
}

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ConfigError(`Missing environment variable ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.ALYASSIR_PORT ?? "4100");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("ALYASSIR_PORT must be a valid TCP port");
  }
  const jwtSecret = required(env, "ALYASSIR_JWT_SECRET");
  if (jwtSecret.length < 32) throw new ConfigError("ALYASSIR_JWT_SECRET must be at least 32 characters");

  // HTTPS is mandatory. Plain HTTP is allowed only for automated tests.
  const testMode = env.NODE_ENV === "test";
  let tls: ServerConfig["tls"] = null;
  if (env.ALYASSIR_INSECURE_HTTP === "1") {
    if (!testMode) throw new ConfigError("ALYASSIR_INSECURE_HTTP is only allowed when NODE_ENV=test");
  } else {
    tls = {
      pfx: readFileSync(required(env, "ALYASSIR_TLS_PFX")),
      passphrase: required(env, "ALYASSIR_TLS_PFX_PASSPHRASE"),
    };
  }

  return {
    backup: backupConfig(env, testMode),
    host: env.ALYASSIR_HOST ?? "0.0.0.0",
    port,
    databaseUrl: required(env, "DATABASE_URL"),
    jwtSecret,
    tls,
    testCorsOrigin: testMode ? env.ALYASSIR_TEST_CORS_ORIGIN : undefined,
  };
}

/**
 * On the server computer the service gets the PostgreSQL folder, the data folder and the secrets
 * file (readable by the service and the administrators only).
 */
function backupConfig(env: NodeJS.ProcessEnv, testMode: boolean): BackupConfig | undefined {
  const secretsFile = env.ALYASSIR_SECRETS_FILE;
  const dataDir = env.ALYASSIR_DATA_DIR;
  if (!secretsFile || !dataDir) return undefined;
  const s = JSON.parse(readFileSync(secretsFile, "utf8")) as { pgSuperuser: string; pgSuperPassword: string; dbUser: string; dbPassword: string };
  const port = env.ALYASSIR_PG_PORT ?? "5433";
  const url = (user: string, password: string, db: string) =>
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${db}`;
  return {
    pgBin: env.ALYASSIR_PG_BIN ?? "",
    superUrl: url(s.pgSuperuser, s.pgSuperPassword, "postgres"),
    ownerUrl: url(s.dbUser, s.dbPassword, "alyassir"),
    dbName: "alyassir",
    dbOwner: s.dbUser,
    internalDir: join(dataDir, "backups"),
    usbTestDir: testMode ? env.ALYASSIR_TEST_USB_DIR : undefined,
  };
}
