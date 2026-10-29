/**
 * pg_dump / pg_restore of the agency's database (SPEC 20): custom format, checked readable,
 * fingerprinted (SHA-256 file next to it) and moved into place only when complete.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { APP_ROLE, MIGRATIONS_DIR, migrate } from "@alyassir/db";
import type { BackupConfig } from "../config";

const exec = promisify(execFile);

function tool(cfg: BackupConfig, name: "pg_dump" | "pg_restore"): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  return cfg.pgBin ? join(cfg.pgBin, exe) : exe;
}

function connection(url: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const u = new URL(url);
  return {
    args: ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username)],
    env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) },
  };
}

export class BackupToolError extends Error {}

async function runTool(cfg: BackupConfig, name: "pg_dump" | "pg_restore", args: string[], timeout = 600_000): Promise<string> {
  const c = connection(cfg.superUrl);
  try {
    const { stdout } = await exec(tool(cfg, name), args.includes("--list") ? args : [...c.args, ...args], {
      env: c.env,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    throw new BackupToolError(`${name}: ${(e.stderr || e.message || String(error)).trim().slice(0, 800)}`);
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function writeFingerprint(file: string, sha256: string): void {
  writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\r\n`);
}

/** Dumps the database into `file` (complete or nothing) and returns its size and SHA-256. */
export async function dumpDatabase(cfg: BackupConfig, file: string): Promise<{ sizeBytes: number; sha256: string }> {
  const part = `${file}.part`;
  rmSync(part, { force: true });
  try {
    await runTool(cfg, "pg_dump", ["-Fc", "-Z", "6", "-f", part, cfg.dbName]);
    // Readability check: the table of contents of the file must be readable.
    await runTool(cfg, "pg_restore", ["--list", part]);
    const sha256 = await sha256File(part);
    renameSync(part, file);
    writeFingerprint(file, sha256);
    return { sizeBytes: statSync(file).size, sha256 };
  } finally {
    rmSync(part, { force: true });
  }
}

/** Database steps (migration versions) inside a dump, read without restoring it. */
export async function dumpMigrations(cfg: BackupConfig, file: string): Promise<string[]> {
  const out = await runTool(cfg, "pg_restore", ["--data-only", "--table=schema_migrations", "-f", "-", file]);
  const versions: string[] = [];
  let inCopy = false;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("COPY ") && line.includes("schema_migrations")) inCopy = true;
    else if (inCopy && line === "\\.") inCopy = false;
    else if (inCopy && line.trim()) versions.push(line.split("\t")[0] ?? "");
  }
  return versions;
}

/** Versions this program knows (its migration files). */
export function knownMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .map((f) => /^(\d{4})_.*\.sql$/.exec(f)?.[1])
    .filter((v): v is string => !!v);
}

async function withSuper<T>(cfg: BackupConfig, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: cfg.superUrl });
  c.on("error", () => undefined);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Replaces the database by the content of a dump, then brings it to this program's version
 * (migrations). Every connection to the old database is closed first.
 */
export async function restoreDatabase(cfg: BackupConfig, file: string): Promise<void> {
  await withSuper(cfg, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${ident(cfg.dbName)} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${ident(cfg.dbName)} OWNER ${ident(cfg.dbOwner)} ENCODING 'UTF8' TEMPLATE template0`);
    await c.query(`REVOKE ALL ON DATABASE ${ident(cfg.dbName)} FROM PUBLIC`);
    await c.query(`GRANT CONNECT ON DATABASE ${ident(cfg.dbName)} TO ${ident(APP_ROLE)}`);
  });
  await runTool(cfg, "pg_restore", ["-d", cfg.dbName, "--exit-on-error", file]);
  await migrate(cfg.ownerUrl);
}
