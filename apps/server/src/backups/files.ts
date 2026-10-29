/**
 * Backup files on disk. The Google Drive folder holds the hourly, daily and manual backups:
 *   hourly/2026-10-29/alyassir-hourly-2026-10-29-1000.dump
 *   2026-10/alyassir-daily-2026-10-29.dump          (one folder per month, SPEC 20)
 *   manual/alyassir-manual-2026-10-29-103512.dump
 * The server's own folder holds pre-update-*.dump (installer) and safety/ copies taken before a restore.
 * The screen never sends a path: it sends an id from the list, checked against the list again.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isExpired, parseBackupFileName } from "@alyassir/domain";
import type { BackupFileDto, BackupKindCode } from "@alyassir/shared";
import { sha256File } from "./pg";

export interface BackupFile extends BackupFileDto {
  path: string;
  day: string;
}

const PRE_UPDATE = /^pre-update-(\d{4})(\d{2})(\d{2})-\d{6}\.dump$/;

export function folderFor(root: string, kind: "hourly" | "daily" | "manual" | "safety", day: string): string {
  if (kind === "hourly") return join(root, "hourly", day);
  if (kind === "daily") return join(root, day.slice(0, 7));
  return join(root, kind);
}

function walk(dir: string, depth: number, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, out);
    else if (e.isFile() && e.name.endsWith(".dump")) out.push(p);
  }
}

const idOf = (place: string, root: string, path: string) => Buffer.from(`${place}|${relative(root, path)}`).toString("base64url");

function checked(path: string): boolean | null {
  const fp = `${path}.sha256`;
  return existsSync(fp) ? true : null;
}

/** Every backup file of both folders, newest first. `checked` is only "has a fingerprint" here; verify() reads it. */
export function listBackups(driveDir: string, internalDir: string): BackupFile[] {
  const files: BackupFile[] = [];
  const add = (place: "drive" | "internal", root: string, path: string) => {
    const name = path.split(sep).pop() ?? "";
    const parsed = parseBackupFileName(name);
    const pre = PRE_UPDATE.exec(name);
    const kind: BackupKindCode | null = parsed ? parsed.kind : pre ? "pre_update" : null;
    if (!kind) return;
    const st = statSync(path);
    files.push({
      id: idOf(place, root, path),
      name,
      kind,
      place,
      at: st.mtime.toISOString(),
      sizeBytes: st.size,
      checked: checked(path),
      path,
      day: parsed ? parsed.day : pre ? `${pre[1]}-${pre[2]}-${pre[3]}` : "",
    });
  };
  const drive: string[] = [];
  if (driveDir) walk(driveDir, 2, drive);
  for (const p of drive) add("drive", driveDir, p);
  const internal: string[] = [];
  walk(internalDir, 1, internal);
  for (const p of internal) add("internal", internalDir, p);
  return files.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** True when the fingerprint file matches the content; null when there is none. */
export async function verifyBackup(path: string): Promise<boolean | null> {
  const fp = `${path}.sha256`;
  if (!existsSync(fp)) return null;
  const expected = readFileSync(fp, "utf8").trim().split(/\s+/)[0]?.toLowerCase();
  return expected === (await sha256File(path));
}

export function removeBackup(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}.sha256`, { force: true });
}

/** Removes what is past its keeping time (hourly 30 days; daily, manual, safety 6 months). Returns the names removed. */
export function cleanOld(files: BackupFile[], today: string): string[] {
  const removed: string[] = [];
  for (const f of files) {
    if (f.kind === "pre_update" || f.kind === "usb") continue;
    if (isExpired(f.kind, f.day, today)) {
      removeBackup(f.path);
      removed.push(f.name);
    }
  }
  return removed;
}

/** Can the server write in this folder? Creates it when its parent exists. */
export function folderProblem(dir: string): "missing" | "not_writable" | null {
  if (!dir) return "missing";
  const abs = resolve(dir);
  try {
    if (!existsSync(abs)) mkdirSync(abs, { recursive: false });
  } catch {
    return "missing";
  }
  try {
    if (!statSync(abs).isDirectory()) return "missing";
    const probe = join(abs, `.alyassir-write-test-${process.pid}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return null;
  } catch {
    return "not_writable";
  }
}

