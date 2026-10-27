import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTableColumns, getTableName } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MigrationError, MIGRATIONS_DIR, migrate, pendingMigrations, schema } from "@alyassir/db";
import { ALL_PERMISSIONS } from "@alyassir/shared";
import { Client } from "pg";
import { createTestDb, ownerQuery, type TestDb } from "./harness";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => db.drop());

async function asApp(sql: string): Promise<void> {
  const c = new Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

describe("migrations", () => {
  it("are idempotent: running them again applies nothing", async () => {
    expect(await migrate(db.ownerUrl)).toEqual([]);
    const c = new Client({ connectionString: db.appUrl });
    await c.connect();
    expect(await pendingMigrations((sql) => c.query(sql))).toEqual([]);
    await c.end();
  });

  it("refuse a migration file changed after being applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "0001_foundation.sql"), "-- changed\nSELECT 1;");
    await expect(migrate(db.ownerUrl, dir)).rejects.toBeInstanceOf(MigrationError);
  });

  it("every Drizzle column exists in the database (schema mirror is right)", async () => {
    const res = await ownerQuery(db, "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'");
    const present = new Set(res.rows.map((r) => `${String(r.table_name)}.${String(r.column_name)}`));
    for (const table of Object.values(schema.allTables)) {
      for (const col of Object.values(getTableColumns(table))) {
        expect(present.has(`${getTableName(table)}.${col.name}`), `${getTableName(table)}.${col.name}`).toBe(true);
      }
    }
  });

  it("the permission table has exactly the shared catalogue", async () => {
    const res = await ownerQuery(db, "SELECT code FROM permissions ORDER BY code");
    expect(res.rows.map((r) => r.code)).toEqual([...ALL_PERMISSIONS].sort());
  });

  it("migration files live next to the package (shipped with the server)", () => {
    expect(MIGRATIONS_DIR.endsWith("migrations")).toBe(true);
  });
});

describe("database rules", () => {
  it("allows only one manager", async () => {
    await expect(ownerQuery(db, "INSERT INTO users (username, display_name, password_hash, role) VALUES ('boss2','B','x','manager')"))
      .rejects.toThrow(/users_single_manager/);
  });

  it("never allows disabling the manager", async () => {
    await expect(ownerQuery(db, "UPDATE users SET is_active = false WHERE role = 'manager'")).rejects.toThrow(/users_manager_active/);
  });

  it("refuses a supervisor flag on the manager", async () => {
    await expect(ownerQuery(db, "UPDATE users SET is_supervisor = true WHERE role = 'manager'")).rejects.toThrow(/users_supervisor_is_employee/);
  });

  it("usernames are unique without regard to case", async () => {
    await expect(ownerQuery(db, "INSERT INTO users (username, display_name, password_hash, role) VALUES ('MANAGER','M','x','employee')"))
      .rejects.toThrow(/users_username_unique/);
  });

  it("audit log is append-only, even for the database owner", async () => {
    await ownerQuery(db, "INSERT INTO audit_log (action) VALUES ('test.entry')");
    await expect(ownerQuery(db, "UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(ownerQuery(db, "DELETE FROM audit_log")).rejects.toThrow(/append-only/);
    await expect(ownerQuery(db, "TRUNCATE audit_log")).rejects.toThrow(/append-only/);
  });

  it("the application account cannot change history or the structure", async () => {
    await expect(asApp("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/permission denied/);
    await expect(asApp("DELETE FROM audit_log")).rejects.toThrow(/permission denied/);
    await expect(asApp("DELETE FROM users")).rejects.toThrow(/permission denied/);
    await expect(asApp("DELETE FROM messages")).rejects.toThrow(/permission denied/);
    await expect(asApp("ALTER TABLE users ADD COLUMN hack int")).rejects.toThrow(/must be owner/);
    await expect(asApp("DROP TABLE audit_log")).rejects.toThrow(/must be owner/);
    await asApp("INSERT INTO audit_log (action) VALUES ('allowed.insert')");
  });
});
