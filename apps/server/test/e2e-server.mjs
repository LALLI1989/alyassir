// Test server for the interface tests (Playwright): fresh migrated database, a manager account,
// plain HTTP on 127.0.0.1:4199. Uses the built server (dist). Never used in production.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { APP_ROLE, migrate } = require("@alyassir/db");
const { createApp } = require("../dist/app.js");
const { bootstrapData } = require("../dist/setup/common.js");
const { UsbService } = require("../dist/backups/usb.service.js");
const { mkdtempSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const http = require("node:http");

const ADMIN = process.env.DATABASE_URL;
if (!ADMIN) throw new Error("DATABASE_URL (superuser) is required");
const DB = "alyassir_e2e";
const OWNER = "alyassir_owner_test";
const url = (user, password) => {
  const u = new URL(ADMIN);
  u.username = user;
  u.password = password;
  u.pathname = `/${DB}`;
  return u.toString();
};

const admin = new Client({ connectionString: ADMIN });
await admin.connect();
for (const [role, pw] of [[OWNER, "owner-test-password"], [APP_ROLE, "app-test-password"]]) {
  const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  await admin.query(`${exists.rowCount ? "ALTER" : "CREATE"} ROLE ${role} LOGIN PASSWORD '${pw}'`);
}
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB} OWNER ${OWNER} TEMPLATE template0 ENCODING 'UTF8'`);
await admin.end();

const ownerUrl = url(OWNER, "owner-test-password");
await migrate(ownerUrl);
const recoveryCode = await bootstrapData(ownerUrl, {
  agencyName: "وكالة الاختبار",
  managerUsername: "manager",
  managerPassword: "manager-pass",
  language: "ar",
  backupDir: mkdtempSync(join(tmpdir(), "alyassir-e2e-drive-")),
});

// Backups with the real PostgreSQL tools (Phase 6B). The schedule does not run by itself here;
// this month's USB copy is marked done so the screens are not blocked whatever the date.
process.env.ALYASSIR_DISABLE_JOBS = "1";
const backupRoot = mkdtempSync(join(tmpdir(), "alyassir-e2e-backups-"));
mkdirSync(join(backupRoot, "usb"));
const superUrl = (() => {
  const u = new URL(ADMIN);
  u.pathname = "/postgres";
  return u.toString();
})();
const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca", year: "numeric", month: "2-digit" }).format(new Date());
// A new connection each time: a restore replaces the database (and closes old connections).
const gate = async (overdue) => {
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query(
    `INSERT INTO usb_backup_gates (month, due_on, remind_from, block_from, done_at, done_by)
     VALUES ($1, current_date, now() - interval '2 days', now() - interval '1 day', CASE WHEN $2 THEN NULL ELSE now() END, CASE WHEN $2 THEN NULL ELSE (SELECT id FROM users WHERE role = 'manager') END)
     ON CONFLICT (month) DO UPDATE SET done_at = EXCLUDED.done_at, done_by = EXCLUDED.done_by, skipped_at = NULL, skipped_by = NULL, skip_reason = NULL, block_from = now() - interval '1 day'`,
    [month, overdue],
    );
  } finally {
    await owner.end();
  }
};
await gate(false);
// The weekly Google Drive check (Phase 8A) starts done for this week; the backups test undoes it.
{
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await owner.query("UPDATE drive_watch SET confirmed_week = date_trunc('week', now() AT TIME ZONE 'Africa/Casablanca')::date");
  await owner.end();
}

const app = await createApp({
  host: "127.0.0.1",
  port: 4199,
  databaseUrl: url(APP_ROLE, "app-test-password"),
  jwtSecret: "e2e-secret-e2e-secret-e2e-secret-0123456789",
  tls: null,
  testCorsOrigin: process.env.ALYASSIR_TEST_CORS_ORIGIN ?? "http://127.0.0.1:4173",
  loginRateLimitPerMinute: 1000,
  backup: {
    pgBin: process.env.ALYASSIR_TEST_PG_BIN ?? "",
    superUrl,
    ownerUrl,
    dbName: DB,
    dbOwner: OWNER,
    internalDir: join(backupRoot, "internal"),
    usbTestDir: join(backupRoot, "usb"),
  },
});
await app.listen(4199, "127.0.0.1");
// Test control only (never in production): make this month's USB copy overdue, for the blocking screen.
http
  .createServer((req, res) => {
    // The manager's recovery code "printed" at installation (Phase 8A), for the sign-in screen test.
    if (req.url === "/recovery-code") return void res.writeHead(200).end(recoveryCode);
    // Google Drive watch (Phase 8A): /drive?running=0&due=1 sets what the hourly check would have found.
    if (req.url?.startsWith("/drive?")) {
      const q = new URL(req.url, "http://x").searchParams;
      const owner = new Client({ connectionString: ownerUrl });
      owner
        .connect()
        .then(() =>
          owner.query(
            `UPDATE drive_watch SET running = $1, checked_at = now(),
               confirmed_week = CASE WHEN $2 THEN NULL ELSE date_trunc('week', now() AT TIME ZONE 'Africa/Casablanca')::date END`,
            [q.get("running") === "1", q.get("due") === "1"],
          ),
        )
        .finally(() => owner.end())
        .then(() => res.writeHead(200).end("ok"), (e) => res.writeHead(500).end(String(e)));
      return;
    }
    if (req.url !== "/usb-overdue") return void res.writeHead(404).end();
    gate(true)
      .then(() => app.get(UsbService).refresh())
      .then(() => res.writeHead(200).end("ok"), (e) => res.writeHead(500).end(String(e)));
  })
  .listen(4198, "127.0.0.1");
console.log("e2e server ready on http://127.0.0.1:4199");
