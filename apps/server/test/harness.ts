/**
 * Test harness: a fresh, fully migrated database per test file, on a real PostgreSQL 16.
 * DATABASE_URL must point to a superuser (CI: the postgres service container).
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { APP_ROLE, migrate } from "@alyassir/db";
import { HEADER_CLIENT_VERSION, HEADER_DEVICE, HEADER_USER_ACTIVE, type LoginResponse } from "@alyassir/shared";
import { createApp } from "../src/app";
import type { ServerConfig } from "../src/config";
import { bootstrapData } from "../src/setup/common";

const ADMIN_URL = process.env.DATABASE_URL;
// Tests run the nightly job themselves, with the dates they choose.
process.env.ALYASSIR_DISABLE_JOBS = "1";
if (!ADMIN_URL) throw new Error("Tests need DATABASE_URL pointing to a PostgreSQL 16 superuser");

export const OWNER_ROLE = "alyassir_owner_test";
const OWNER_PASSWORD = "owner-test-password";
const APP_PASSWORD = "app-test-password";
export const JWT_SECRET = "test-secret-test-secret-test-secret-0123456789";
export const MANAGER = { username: "manager", password: "manager-pass" };

function urlFor(user: string, password: string, database: string): string {
  const u = new URL(ADMIN_URL as string);
  u.username = user;
  u.password = password;
  u.pathname = `/${database}`;
  return u.toString();
}

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export interface TestDb {
  name: string;
  ownerUrl: string;
  appUrl: string;
  drop: () => Promise<void>;
}

/** By default the test server works live (already went live); `historical` keeps the first-start question (Phase 7). */
export async function createTestDb(options: { bootstrap?: boolean; historical?: boolean } = {}): Promise<TestDb> {
  const name = `alyassir_t_${randomBytes(6).toString("hex")}`;
  await admin(async (c) => {
    for (const [role, pw] of [[OWNER_ROLE, OWNER_PASSWORD], [APP_ROLE, APP_PASSWORD]] as const) {
      const exists = await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      await c.query(`${exists.rowCount ? "ALTER" : "CREATE"} ROLE ${role} LOGIN PASSWORD '${pw}'`);
    }
    await c.query(`CREATE DATABASE ${name} OWNER ${OWNER_ROLE} TEMPLATE template0 ENCODING 'UTF8'`);
  });
  const ownerUrl = urlFor(OWNER_ROLE, OWNER_PASSWORD, name);
  const appUrl = urlFor(APP_ROLE, APP_PASSWORD, name);
  await migrate(ownerUrl);
  if (options.bootstrap !== false) {
    await bootstrapData(ownerUrl, {
      agencyName: "وكالة الاختبار",
      managerUsername: MANAGER.username,
      managerPassword: MANAGER.password,
      language: "ar",
      backupDir: "C:\\Backups",
    });
  }
  if (!options.historical) {
    const c = new Client({ connectionString: ownerUrl });
    await c.connect();
    await c.query("UPDATE system_info SET historical_mode = 'locked', go_live_at = now()");
    await c.end();
  }
  return {
    name,
    ownerUrl,
    appUrl,
    drop: () => admin(async (c) => void (await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))),
  };
}

/** Runs SQL as the database owner (to set up situations, e.g. move a time back). */
export async function ownerQuery(db: TestDb, sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
  const c = new Client({ connectionString: db.ownerUrl });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

export const CLIENT_HEADERS = { [HEADER_CLIENT_VERSION]: "0.1.0", [HEADER_DEVICE]: "PC-TEST", [HEADER_USER_ACTIVE]: "1" };

export interface TestApp {
  app: NestFastifyApplication;
  db: TestDb;
  call: (method: string, url: string, options?: { token?: string; body?: unknown; headers?: Record<string, string>; remoteAddress?: string }) => Promise<{ status: number; body: any }>;
  login: (username: string, password: string) => Promise<LoginResponse>;
  close: () => Promise<void>;
}

/** Backups on the test database: real pg_dump / pg_restore, folders in the temp directory. */
export function testBackupConfig(db: TestDb): NonNullable<ServerConfig["backup"]> {
  const root = mkdtempSync(join(tmpdir(), "alyassir-backups-"));
  const u = new URL(ADMIN_URL as string);
  return {
    pgBin: process.env.ALYASSIR_TEST_PG_BIN ?? "",
    superUrl: urlFor(decodeURIComponent(u.username), decodeURIComponent(u.password), "postgres"),
    ownerUrl: db.ownerUrl,
    dbName: db.name,
    dbOwner: OWNER_ROLE,
    internalDir: join(root, "internal"),
    usbTestDir: join(root, "usb"),
  };
}

export async function startApp(options: { listen?: boolean; backup?: boolean; historical?: boolean } = {}): Promise<TestApp> {
  const db = await createTestDb({ historical: options.historical });
  const app = await createApp({
    ...(options.backup ? { backup: testBackupConfig(db) } : {}),
    host: "127.0.0.1",
    port: 0,
    databaseUrl: db.appUrl,
    jwtSecret: JWT_SECRET,
    tls: null,
    loginRateLimitPerMinute: 10_000,
  });
  if (options.listen) await app.listen(0, "127.0.0.1");
  else {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }

  const call: TestApp["call"] = async (method, url, o = {}) => {
    const res = await app.inject({
      method: method as "GET",
      url,
      headers: { ...CLIENT_HEADERS, ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...(o.headers ?? {}) },
      ...(o.remoteAddress ? { remoteAddress: o.remoteAddress } : {}),
      ...(o.body !== undefined ? { payload: o.body as object } : {}),
    });
    let body: unknown = null;
    try {
      body = res.body ? res.json() : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  };

  const login = async (username: string, password: string): Promise<LoginResponse> => {
    const res = await call("POST", "/api/auth/login", { body: { username, password } });
    if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as LoginResponse;
  };

  return {
    app,
    db,
    call,
    login,
    close: async () => {
      await app.close();
      await db.drop();
    },
  };
}

/** Creates an employee as the manager and returns its id. */
export async function createEmployee(t: TestApp, managerToken: string, username: string, password = "secret1"): Promise<string> {
  const res = await t.call("POST", "/api/users", { token: managerToken, body: { username, displayName: username.toUpperCase(), password } });
  if (res.status !== 201) throw new Error(`create ${username}: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { id: string }).id;
}
