import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { schema, type BackupKind } from "@alyassir/db";
import { backupFileName, businessDay, hourlySlot, isWorkingDay, localClock, type WorkHours } from "@alyassir/domain";
import type { BackupSettings, BackupStatusDto, BackupsDto } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import { verifyPassword } from "../auth/passwords";
import type { AuthUser, RequestContext } from "../common/context";
import { ApiException } from "../common/errors";
import type { BackupConfig } from "../config";
import { DatabaseService } from "../database.service";
import { MessagesService } from "../messages/messages.service";
import { messageManager } from "../money/payments.service";
import { RealtimeService } from "../realtime/realtime.service";
import { cleanOld, folderFor, folderProblem, listBackups, removeBackup, verifyBackup, type BackupFile } from "./files";
import { dumpDatabase, dumpMigrations, knownMigrations, restoreDatabase } from "./pg";

export const BACKUP_CONFIG = Symbol("BACKUP_CONFIG");

export interface TakenBackup {
  runId: string;
  path: string;
  name: string;
  sha256: string;
  sizeBytes: number;
}

const hhmm = (t: string) => t.slice(0, 5);

/**
 * Backups and restore (SPEC 20, 20.1). One backup at a time; while a restore runs, the whole API
 * answers RESTORING (the "service stop" of SPEC 20) and nothing else touches the database.
 */
@Injectable()
export class BackupsService {
  private readonly logger = new Logger("Backups");
  private queue: Promise<unknown> = Promise.resolve();
  private busy = false;
  private restoringNow = false;

  constructor(
    @Inject(BACKUP_CONFIG) readonly config: BackupConfig | null,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  get enabled(): boolean {
    return this.config !== null;
  }

  get restoring(): boolean {
    return this.restoringNow;
  }

  private cfg(): BackupConfig {
    if (!this.config) throw new ApiException("BACKUPS_UNAVAILABLE");
    return this.config;
  }

  /** One backup or restore at a time, in order. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      this.busy = true;
      try {
        return await fn();
      } finally {
        this.busy = false;
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async settings(): Promise<BackupSettings & { dir: string }> {
    const [s] = await this.database.db.select().from(schema.agencySettings).where(eq(schema.agencySettings.id, 1));
    if (!s) throw new ApiException("INTERNAL");
    return { workDays: [...s.workDays].sort(), workStart: hhmm(s.workStart), workEnd: hhmm(s.workEnd), usbTime: hhmm(s.usbTime), dir: s.backupDir };
  }

  async workHours(): Promise<WorkHours & { usbTime: string }> {
    const s = await this.settings();
    return { days: s.workDays, start: s.workStart, end: s.workEnd, usbTime: s.usbTime };
  }

  async updateSettings(ctx: RequestContext, input: BackupSettings): Promise<BackupsDto> {
    const before = await this.settings();
    await this.database.db.transaction(async (tx) => {
      await tx
        .update(schema.agencySettings)
        .set({ workDays: input.workDays, workStart: input.workStart, workEnd: input.workEnd, usbTime: input.usbTime, updatedAt: new Date() })
        .where(eq(schema.agencySettings.id, 1));
      const { dir: _d, ...old } = before;
      await this.audit.record(tx, ctx, { action: "backup.settings", entityType: "settings", entityId: "backups", before: old, after: input });
    });
    this.realtime.notifyAll("backups");
    return this.list();
  }

  /** Changes the Google Drive folder; the server first checks it can write there. */
  async setDir(ctx: RequestContext, path: string): Promise<BackupsDto> {
    this.cfg();
    if (!isAbsolute(path)) throw new ApiException("BACKUP_DIR_UNUSABLE", { fields: { path: "folder_absolute" } });
    const dir = resolve(path);
    const problem = folderProblem(dir);
    if (problem) throw new ApiException("BACKUP_DIR_UNUSABLE", { fields: { path: `folder_${problem}` } });
    const before = (await this.settings()).dir;
    await this.database.db.transaction(async (tx) => {
      await tx.update(schema.agencySettings).set({ backupDir: dir, updatedAt: new Date() }).where(eq(schema.agencySettings.id, 1));
      await this.audit.record(tx, ctx, { action: "backup.folder", entityType: "settings", entityId: "backups", before: { dir: before }, after: { dir } });
    });
    this.realtime.notifyAll("backups");
    return this.list();
  }

  private async files(): Promise<BackupFile[]> {
    const cfg = this.cfg();
    const dir = (await this.settings()).dir;
    return listBackups(folderProblem(dir) === null ? dir : "", cfg.internalDir);
  }

  async list(): Promise<BackupsDto> {
    const s = await this.settings();
    const { dir, ...settings } = s;
    if (!this.config) return { enabled: false, dir, dirProblem: null, lastOkAt: null, lastError: null, running: false, settings, files: [] };
    const [ok] = await this.database.db
      .select({ at: schema.backupRuns.finishedAt })
      .from(schema.backupRuns)
      .where(eq(schema.backupRuns.status, "ok"))
      .orderBy(desc(schema.backupRuns.finishedAt))
      .limit(1);
    const [last] = await this.database.db.select().from(schema.backupRuns).orderBy(desc(schema.backupRuns.startedAt)).limit(1);
    const files = await this.files();
    return {
      enabled: true,
      dir,
      dirProblem: folderProblem(dir),
      lastOkAt: ok?.at ? ok.at.toISOString() : null,
      lastError: last?.status === "failed" ? last.error : null,
      running: this.busy,
      settings,
      files: files.map(({ path: _p, day: _d, ...f }) => f),
    };
  }

  /** For the manager's dashboard: late when the folder is unusable or no good backup for 2 hours of work. */
  async status(now = new Date()): Promise<BackupStatusDto> {
    if (!this.config) return { enabled: false, lastOkAt: null, late: false, dirProblem: null };
    const s = await this.settings();
    const problem = folderProblem(s.dir);
    const [ok] = await this.database.db
      .select({ at: schema.backupRuns.finishedAt })
      .from(schema.backupRuns)
      .where(and(eq(schema.backupRuns.status, "ok"), inArray(schema.backupRuns.kind, ["hourly", "daily", "manual"])))
      .orderBy(desc(schema.backupRuns.finishedAt))
      .limit(1);
    const wh = { days: s.workDays, start: s.workStart, end: s.workEnd };
    const working = hourlySlot(now, wh) !== null && isWorkingDay(localClock(now).day, wh);
    const old = !ok?.at || now.getTime() - ok.at.getTime() > 2 * 3_600_000;
    return { enabled: true, lastOkAt: ok?.at ? ok.at.toISOString() : null, late: problem !== null || (working && old), dirProblem: problem };
  }

  /**
   * Takes a backup now. Scheduled kinds use a period ("slot") taken once: a second call for the
   * same period does nothing and returns null.
   */
  async take(kind: BackupKind, slot: string, requestedBy: string | null, now = new Date(), targetDir?: string): Promise<TakenBackup | null> {
    const cfg = this.cfg();
    if (this.restoringNow && kind !== "safety") throw new ApiException("RESTORING");
    const run = async (): Promise<TakenBackup | null> => {
      const db = this.database.db;
      let dir = targetDir;
      if (!dir) {
        if (kind === "safety") dir = join(cfg.internalDir, "safety");
        else {
          const driveDir = (await this.settings()).dir;
          const problem = folderProblem(driveDir);
          if (problem) {
            await this.warnFolder(problem, driveDir, now);
            throw new ApiException("BACKUP_DIR_UNUSABLE", { fields: { path: `folder_${problem}` } });
          }
          dir = folderFor(driveDir, kind === "usb" ? "manual" : kind, kind === "daily" ? slot : localClock(now).day);
        }
      }
      const [row] = await db
        .insert(schema.backupRuns)
        .values({ kind, slot, requestedBy })
        .onConflictDoNothing()
        .returning({ id: schema.backupRuns.id });
      if (!row) return null;
      try {
        mkdirSync(dir, { recursive: true });
        let name = kind === "daily" ? `alyassir-daily-${slot}.dump` : backupFileName(kind, now);
        // Two copies in the same second (two restores in a row) never overwrite each other.
        for (let s = 1; kind !== "daily" && kind !== "hourly" && existsSync(join(dir, name)) && s < 60; s++) name = backupFileName(kind, new Date(now.getTime() + s * 1000));
        const path = join(dir, name);
        const done = await dumpDatabase(cfg, path);
        await db
          .update(schema.backupRuns)
          .set({ status: "ok", fileName: name, sizeBytes: done.sizeBytes, sha256: done.sha256, finishedAt: new Date() })
          .where(eq(schema.backupRuns.id, row.id));
        if (kind === "hourly" || kind === "daily") this.cleanUp(now);
        this.realtime.notifyAll("backups");
        return { runId: row.id, path, name, ...done };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.failed(row.id, kind, message || "backup failed");
        throw error instanceof ApiException ? error : new ApiException("BACKUP_FAILED", { message });
      }
    };
    return kind === "safety" ? run() : this.exclusive(run);
  }

  /** The Google Drive folder cannot be used: the manager is told once per hour, not every minute. */
  private warnedFolder = "";
  private async warnFolder(problem: string, dir: string, now: Date): Promise<void> {
    const key = `${problem}:${now.toISOString().slice(0, 13)}`;
    if (this.warnedFolder === key) return;
    this.warnedFolder = key;
    this.logger.error(`Backup folder ${problem}: ${dir}`);
    await this.database.db.transaction((tx) => messageManager(this.messages, tx, "backup_failed", { kind: "folder", error: `${problem}: ${dir}` }));
    this.realtime.notifyAll("backups");
  }

  private async failed(runId: string, kind: BackupKind, error: string): Promise<void> {
    const db = this.database.db;
    this.logger.error(`Backup (${kind}) failed: ${error}`);
    // Tell the manager once per series of failures (not every hour).
    const [previous] = await db
      .select({ status: schema.backupRuns.status })
      .from(schema.backupRuns)
      .where(and(sql`${schema.backupRuns.id} <> ${runId}`, sql`${schema.backupRuns.status} <> 'running'`))
      .orderBy(desc(schema.backupRuns.startedAt))
      .limit(1);
    await db.update(schema.backupRuns).set({ status: "failed", error: error.slice(0, 2000), finishedAt: new Date() }).where(eq(schema.backupRuns.id, runId));
    if (previous?.status !== "failed") {
      await db.transaction((tx) => messageManager(this.messages, tx, "backup_failed", { kind, error: error.slice(0, 500) }));
    }
    this.realtime.notifyAll("backups");
  }

  private cleanUp(now: Date): void {
    void this.files()
      .then((files) => {
        const removed = cleanOld(files, businessDay(now));
        if (removed.length) this.logger.log(`Old backups removed: ${removed.join(", ")}`);
      })
      .catch((e: unknown) => this.logger.warn(`Cleaning old backups: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** A backup left "running" by a stop of the server is marked failed (it can be taken again). */
  async markInterrupted(olderThanMinutes: number): Promise<void> {
    await this.database.db
      .update(schema.backupRuns)
      .set({ status: "failed", error: "interrupted", finishedAt: new Date() })
      .where(and(eq(schema.backupRuns.status, "running"), lt(schema.backupRuns.startedAt, new Date(Date.now() - olderThanMinutes * 60_000))));
  }

  async takeManual(ctx: RequestContext, user: AuthUser): Promise<BackupsDto> {
    const now = new Date();
    const taken = await this.take("manual", now.toISOString(), user.id, now);
    if (taken) await this.audit.record(this.database.db, ctx, { action: "backup.manual", entityType: "backup", entityId: taken.name, after: { file: taken.name, sha256: taken.sha256 } });
    return this.list();
  }

  private async find(id: string): Promise<BackupFile> {
    const f = (await this.files()).find((x) => x.id === id);
    if (!f) throw new ApiException("NOT_FOUND");
    return f;
  }

  async remove(ctx: RequestContext, id: string): Promise<BackupsDto> {
    const f = await this.find(id);
    removeBackup(f.path);
    await this.audit.record(this.database.db, ctx, { action: "backup.delete", entityType: "backup", entityId: f.name, before: { file: f.name, kind: f.kind, at: f.at } });
    this.realtime.notifyAll("backups");
    return this.list();
  }

  /**
   * Restore (SPEC 20): explicit confirmation (the manager's password), the API stops serving,
   * a safety copy of the current state, the restore, the compatibility check (migrations), back
   * to work, audit. Any failure goes back to the safety copy: no data is lost.
   */
  async restore(ctx: RequestContext, user: AuthUser, id: string, password: string): Promise<{ restored: string; safety: string }> {
    const cfg = this.cfg();
    const [me] = await this.database.db.select({ hash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, user.id));
    if (!me || !(await verifyPassword(me.hash, password))) throw new ApiException("WRONG_PASSWORD");
    const f = await this.find(id);
    if ((await verifyBackup(f.path)) === false) throw new ApiException("BACKUP_CORRUPT");
    let versions: string[];
    try {
      versions = await dumpMigrations(cfg, f.path);
    } catch {
      throw new ApiException("BACKUP_CORRUPT");
    }
    const known = new Set(knownMigrations());
    if (versions.length === 0) throw new ApiException("BACKUP_CORRUPT");
    if (versions.some((v) => !known.has(v))) throw new ApiException("BACKUP_NEWER");

    return this.exclusive(async () => {
      this.restoringNow = true;
      this.realtime.notifyAll("backups");
      const safetyAt = new Date();
      let safety: TakenBackup | null = null;
      try {
        safety = await this.take("safety", safetyAt.toISOString(), user.id, safetyAt);
        if (!safety) throw new ApiException("RESTORE_FAILED");
        try {
          await restoreDatabase(cfg, f.path);
        } catch (error) {
          this.logger.error(`Restore of ${f.name} failed, going back to ${safety.name}: ${error instanceof Error ? error.message : String(error)}`);
          await restoreDatabase(cfg, safety.path);
          throw new ApiException("RESTORE_FAILED");
        }
        // The restored database does not know what happened after its backup: write it down.
        const db = this.database.db;
        await db.update(schema.backupRuns).set({ status: "failed", error: "interrupted", finishedAt: new Date() }).where(eq(schema.backupRuns.status, "running"));
        await db
          .insert(schema.backupRuns)
          .values({ kind: "safety", slot: safetyAt.toISOString(), status: "ok", fileName: safety.name, sizeBytes: safety.sizeBytes, sha256: safety.sha256, requestedBy: user.id, startedAt: safetyAt, finishedAt: new Date() })
          .onConflictDoNothing();
        await this.audit.record(db, ctx, {
          action: "backup.restore",
          entityType: "backup",
          entityId: f.name,
          after: { restored: f.name, kind: f.kind, backupAt: f.at, safetyCopy: safety.name },
        });
        this.logger.log(`Database restored from ${f.name} (safety copy ${safety.name})`);
        return { restored: f.name, safety: safety.name };
      } finally {
        this.restoringNow = false;
        for (const topic of ["backups", "settings", "users", "clients", "policies", "payments", "drawer", "accounts"] as const) this.realtime.notifyAll(topic);
      }
    });
  }
}
