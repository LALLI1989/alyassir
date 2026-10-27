/**
 * Explicit SQL migrations (SPEC 3.2, ADR 0003). Files: migrations/NNNN_name.sql, applied in order,
 * each in its own transaction, recorded with a checksum. Runs on the server computer only (SPEC 6.3),
 * as the database owner. A changed, already-applied file is refused.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

/** Role the running server uses. Created by setup (it needs superuser rights). */
export const APP_ROLE = "alyassir_app";

export const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const MIGRATION_LOCK = 4_100_001;

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {}

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), "utf8");
      return {
        version: file.slice(0, 4),
        name: file.slice(5, -4),
        sql,
        // Line endings must not matter (git on Windows may convert them).
        checksum: createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex"),
      };
    });
}

async function ensureTable(client: Client): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    name       text NOT NULL,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function applied(client: Client): Promise<Map<string, string>> {
  const res = await client.query<{ version: string; checksum: string }>(
    "SELECT version, checksum FROM schema_migrations ORDER BY version",
  );
  return new Map(res.rows.map((r) => [r.version, r.checksum]));
}

function verify(files: MigrationFile[], done: Map<string, string>): void {
  for (const [version, checksum] of done) {
    const file = files.find((f) => f.version === version);
    if (!file) throw new MigrationError(`Database has migration ${version}, unknown to this program (newer database?)`);
    if (file.checksum !== checksum) throw new MigrationError(`Migration ${version} was changed after being applied`);
  }
}

/** Applies all pending migrations. Returns the versions applied now. */
export async function migrate(ownerUrl: string, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = readMigrations(dir);
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await ensureTable(client);
    const done = await applied(client);
    verify(files, done);
    const now: string[] = [];
    for (const file of files) {
      if (done.has(file.version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(file.sql);
        await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
          file.version,
          file.name,
          file.checksum,
        ]);
        await client.query("COMMIT");
        now.push(file.version);
      } catch (error) {
        await client.query("ROLLBACK");
        const message = error instanceof Error ? error.message : String(error);
        throw new MigrationError(`Migration ${file.version}_${file.name} failed: ${message}`);
      }
    }
    return now;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    await client.end();
  }
}

/** Used by the server at start: it refuses to run on a database that is not up to date. */
export async function pendingMigrations(query: (sql: string) => Promise<{ rows: { version: string; checksum: string }[] }>, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = readMigrations(dir);
  let rows: { version: string; checksum: string }[] = [];
  try {
    rows = (await query("SELECT version, checksum FROM schema_migrations")).rows;
  } catch {
    return files.map((f) => f.version);
  }
  const done = new Map(rows.map((r) => [r.version, r.checksum]));
  verify(files, done);
  return files.filter((f) => !done.has(f.version)).map((f) => f.version);
}
