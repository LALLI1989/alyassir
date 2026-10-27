// Test server for the interface tests (Playwright): fresh migrated database, a manager account,
// plain HTTP on 127.0.0.1:4199. Uses the built server (dist). Never used in production.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { APP_ROLE, migrate } = require("@alyassir/db");
const { createApp } = require("../dist/app.js");
const { bootstrapData } = require("../dist/setup/common.js");

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
await bootstrapData(ownerUrl, {
  agencyName: "وكالة الاختبار",
  managerUsername: "manager",
  managerPassword: "manager-pass",
  language: "ar",
  backupDir: "/tmp",
});

const app = await createApp({
  host: "127.0.0.1",
  port: 4199,
  databaseUrl: url(APP_ROLE, "app-test-password"),
  jwtSecret: "e2e-secret-e2e-secret-e2e-secret-0123456789",
  tls: null,
  testCorsOrigin: process.env.ALYASSIR_TEST_CORS_ORIGIN ?? "http://127.0.0.1:4173",
  loginRateLimitPerMinute: 1000,
});
await app.listen(4199, "127.0.0.1");
console.log("e2e server ready on http://127.0.0.1:4199");
