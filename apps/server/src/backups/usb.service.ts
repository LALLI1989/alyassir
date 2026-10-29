import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { localClock, usbCopiesToRemove, usbGateState, usbGateTimes, type UsbGateState } from "@alyassir/domain";
import type { UsbStateDto } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import { AccessService } from "../common/access.service";
import type { AuthUser, RequestContext } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService } from "../database.service";
import { MessagesService } from "../messages/messages.service";
import { messageManager } from "../money/payments.service";
import { RealtimeService } from "../realtime/realtime.service";
import { BackupsService } from "./backups.service";
import { sha256File, writeFingerprint } from "./pg";

const exec = promisify(execFile);
type Gate = typeof schema.usbBackupGates.$inferSelect;

/** The request comes from the server computer itself (only there is the USB key). */
export function isServerAddress(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const a = ip.replace(/^::ffff:/, "");
  if (a === "127.0.0.1" || a === "::1") return true;
  return Object.values(networkInterfaces()).some((list) => (list ?? []).some((n) => n.address.replace(/^::ffff:/, "") === a));
}

/**
 * Monthly USB copy (owner decision 29/10/2026, replaces "every Friday" of SPEC 20): first Friday at
 * the USB time a reminder for everyone; from the start of the next working day, if still not done,
 * the application stops on every computer until it is done or skipped with a reason.
 */
@Injectable()
export class UsbService {
  private readonly logger = new Logger("UsbBackup");
  private cached: { state: UsbGateState; gate: Gate | null; at: number } = { state: "none", gate: null, at: 0 };

  constructor(
    @Inject(BackupsService) private readonly backups: BackupsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  /** The state used by the guard on every request (refreshed every minute and after each change). */
  get blocked(): boolean {
    return this.backups.enabled && this.cached.state === "block";
  }

  /** Creates this month's gate once its reminder time is reached, then computes the state. */
  async refresh(now = new Date()): Promise<UsbGateState> {
    if (!this.backups.enabled) return "none";
    const month = localClock(now).day.slice(0, 7);
    const wh = await this.backups.workHours();
    const times = usbGateTimes(month, wh, wh.usbTime, now);
    if (now.getTime() >= times.remindFrom.getTime()) {
      await this.database.db
        .insert(schema.usbBackupGates)
        .values({ month, dueOn: times.dueOn, remindFrom: times.remindFrom, blockFrom: times.blockFrom })
        .onConflictDoNothing();
    }
    const [gate] = await this.database.db.select().from(schema.usbBackupGates).where(eq(schema.usbBackupGates.month, month));
    const state = usbGateState(gate ?? null, now);
    const changed = state !== this.cached.state;
    this.cached = { state, gate: gate ?? null, at: now.getTime() };
    if (changed) this.realtime.notifyAll("backups");
    return state;
  }

  /** USB keys plugged into the server (Windows: removable drives). Tests use a folder. */
  async drives(): Promise<UsbStateDto["drives"]> {
    const testDir = this.backups.config?.usbTestDir;
    if (testDir) {
      if (!existsSync(testDir)) return [];
      return [{ drive: "test", label: "TEST", freeBytes: Number(statfsSync(testDir).bavail) * Number(statfsSync(testDir).bsize) }];
    }
    if (process.platform !== "win32") return [];
    try {
      const { stdout } = await exec(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | Select-Object DeviceID,VolumeName,FreeSpace | ConvertTo-Json -Compress"],
        { timeout: 20_000, windowsHide: true },
      );
      const raw = stdout.trim() ? (JSON.parse(stdout) as unknown) : [];
      const list = (Array.isArray(raw) ? raw : [raw]) as { DeviceID?: string; VolumeName?: string | null; FreeSpace?: number | null }[];
      return list
        .filter((d) => typeof d.DeviceID === "string" && /^[A-Z]:$/.test(d.DeviceID) && (d.FreeSpace ?? 0) > 0)
        .map((d) => ({ drive: d.DeviceID as string, label: d.VolumeName ?? "", freeBytes: Number(d.FreeSpace ?? 0) }));
    } catch (error) {
      this.logger.warn(`USB drives: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private root(drive: string): string {
    const testDir = this.backups.config?.usbTestDir;
    if (drive === "test" && testDir) return testDir;
    return `${drive}\\`;
  }

  canSkip(user: AuthUser): boolean {
    return user.role === "manager" || (user.isSupervisor && this.access.has(user, "sup.skip_usb_backup"));
  }

  async state(user: AuthUser, ip: string | null): Promise<UsbStateDto> {
    const state = await this.refresh();
    const gate = this.cached.gate;
    const atServer = isServerAddress(ip);
    const [last] = await this.database.db
      .select({ at: schema.usbBackupGates.doneAt, by: schema.users.displayName })
      .from(schema.usbBackupGates)
      .leftJoin(schema.users, eq(schema.users.id, schema.usbBackupGates.doneBy))
      .where(eq(schema.usbBackupGates.month, gate?.month ?? localClock(new Date()).day.slice(0, 7)));
    return {
      state,
      month: gate?.month ?? null,
      dueOn: gate?.dueOn ?? null,
      blockFrom: gate ? gate.blockFrom.toISOString() : null,
      atServer,
      drives: atServer && this.backups.enabled ? await this.drives() : [],
      canSkip: this.canSkip(user),
      lastDone: last?.at ? { at: last.at.toISOString(), by: last.by ?? null } : null,
    };
  }

  /** Copies a fresh backup to the key, reads it back to check it, keeps the 6 newest copies there. */
  async copy(ctx: RequestContext, user: AuthUser, drive: string, ip: string | null): Promise<UsbStateDto> {
    const cfg = this.backups.config;
    if (!cfg) throw new ApiException("BACKUPS_UNAVAILABLE");
    if (!isServerAddress(ip)) throw new ApiException("USB_NOT_AT_SERVER");
    if (!(await this.drives()).some((d) => d.drive === drive)) throw new ApiException("USB_DRIVE_MISSING");
    const now = new Date();
    const temp = join(cfg.internalDir, "usb-temp");
    const taken = await this.backups.take("usb", now.toISOString(), user.id, now, temp);
    if (!taken) throw new ApiException("BACKUP_BUSY");
    const folder = join(this.root(drive), "Alyassir");
    let target = "";
    try {
      mkdirSync(folder, { recursive: true });
      target = join(folder, taken.name);
      copyFileSync(taken.path, target);
      if ((await sha256File(target)) !== taken.sha256) throw new Error("the copy on the key does not match");
      writeFingerprint(target, taken.sha256);
    } catch (error) {
      if (target) rmSync(target, { force: true });
      this.logger.error(`USB copy failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new ApiException("USB_DRIVE_MISSING");
    } finally {
      rmSync(taken.path, { force: true });
      rmSync(`${taken.path}.sha256`, { force: true });
    }
    const copies = readdirSync(folder).filter((n) => /^alyassir-usb-.*\.dump$/.test(n));
    for (const old of usbCopiesToRemove(copies)) {
      rmSync(join(folder, old), { force: true });
      rmSync(join(folder, `${old}.sha256`), { force: true });
    }

    const month = localClock(now).day.slice(0, 7);
    const wh = await this.backups.workHours();
    const times = usbGateTimes(month, wh, wh.usbTime, now);
    await this.database.db.transaction(async (tx) => {
      // Done early in the month (before the reminder): the copy counts for the month.
      await tx
        .insert(schema.usbBackupGates)
        .values({ month, dueOn: times.dueOn, remindFrom: times.remindFrom, blockFrom: times.blockFrom })
        .onConflictDoNothing();
      await tx.update(schema.usbBackupGates).set({ doneAt: now, doneBy: user.id, doneFile: taken.name }).where(eq(schema.usbBackupGates.month, month));
      await this.audit.record(tx, ctx, { action: "backup.usb", entityType: "backup", entityId: taken.name, after: { file: taken.name, sha256: taken.sha256, month } });
    });
    await this.refresh();
    this.realtime.notifyAll("backups");
    return this.state(user, ip);
  }

  /** Manager, or a supervisor with "skip the USB copy": with a reason, written in the audit log; the manager is told. */
  async skip(ctx: RequestContext, user: AuthUser, reason: string, ip: string | null): Promise<UsbStateDto> {
    if (!this.canSkip(user)) throw new ApiException("FORBIDDEN");
    const state = await this.refresh();
    const gate = this.cached.gate;
    if (state === "none" || !gate) throw new ApiException("CONFLICT");
    await this.database.db.transaction(async (tx) => {
      await tx.update(schema.usbBackupGates).set({ skippedAt: new Date(), skippedBy: user.id, skipReason: reason }).where(eq(schema.usbBackupGates.month, gate.month));
      await this.audit.record(tx, ctx, { action: "backup.usb_skip", entityType: "backup", entityId: gate.month, reason, after: { month: gate.month } });
      await messageManager(this.messages, tx, "usb_skipped", { employee: user.displayName, month: gate.month, reason });
    });
    await this.refresh();
    this.realtime.notifyAll("backups");
    return this.state(user, ip);
  }
}
