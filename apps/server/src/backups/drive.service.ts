/**
 * Google Drive watch (Phase 8A, owner decision 29/10/2026). Every working hour the server checks that
 * the Google Drive app runs on the server computer (it uploads the backup folder). If it does not,
 * the manager gets one message a day and a warning on the backups screen and the dashboard. The
 * program cannot see whether the files really reached Google, so each week the manager is also
 * reminded to look at drive.google.com and press "I checked".
 */
import { execFile } from "node:child_process";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { businessDay, driveCheckDue, hourlySlot, weekMonday, type WorkHours } from "@alyassir/domain";
import type { DriveStateDto } from "@alyassir/shared";
import { AuditService } from "../audit/audit.service";
import type { AuthUser, RequestContext } from "../common/context";
import { ApiException } from "../common/errors";
import { DatabaseService } from "../database.service";
import { MessagesService } from "../messages/messages.service";
import { messageManager } from "../money/payments.service";
import { RealtimeService } from "../realtime/realtime.service";

/** Is the Google Drive app running here? null when it cannot be known (not Windows). */
export type DriveProbe = () => Promise<boolean | null>;

const windowsProbe: DriveProbe = () =>
  new Promise((resolve) => {
    if (process.platform !== "win32") return resolve(null);
    execFile("tasklist.exe", ["/FI", "IMAGENAME eq GoogleDriveFS.exe", "/NH"], { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(/GoogleDriveFS\.exe/i.test(stdout));
    });
  });

@Injectable()
export class DriveService {
  private readonly logger = new Logger("Drive");
  private probe: DriveProbe = windowsProbe;
  private lastSlot: string | null = null;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  /** Tests only: pretend the Drive app runs or not. */
  setProbe(probe: DriveProbe): void {
    this.probe = probe;
    this.lastSlot = null;
  }

  private async workHours(): Promise<WorkHours> {
    const [s] = await this.database.db
      .select({ days: schema.agencySettings.workDays, start: schema.agencySettings.workStart, end: schema.agencySettings.workEnd })
      .from(schema.agencySettings)
      .where(eq(schema.agencySettings.id, 1));
    if (!s) throw new ApiException("INTERNAL");
    return { days: s.days, start: s.start, end: s.end };
  }

  /** Once per working hour (called by the backup schedule every minute). */
  async check(now = new Date()): Promise<void> {
    const slot = hourlySlot(now, await this.workHours());
    if (!slot || slot === this.lastSlot) return;
    this.lastSlot = slot;
    const running = await this.probe();
    const today = businessDay(now);
    const db = this.database.db;
    const [watch] = await db.select().from(schema.driveWatch).where(eq(schema.driveWatch.id, 1));
    let managerId: string | null = null;
    await db.transaction(async (tx) => {
      const alert = running === false && watch?.lastAlertDay !== today;
      await tx
        .update(schema.driveWatch)
        .set({ checkedAt: now, running, ...(alert ? { lastAlertDay: today } : {}) })
        .where(eq(schema.driveWatch.id, 1));
      if (alert) managerId = await messageManager(this.messages, tx, "drive_not_running", {});
    });
    if (managerId) this.messages.notify([managerId]);
    if (running === false) this.logger.warn("Google Drive is not running on the server computer");
    if (watch?.running !== running) this.realtime.notifyAll("backups");
  }

  async state(now = new Date()): Promise<DriveStateDto> {
    const [w] = await this.database.db.select().from(schema.driveWatch).where(eq(schema.driveWatch.id, 1));
    const wh = await this.workHours();
    return {
      running: w?.running ?? null,
      checkedAt: w?.checkedAt ? w.checkedAt.toISOString() : null,
      confirmDue: driveCheckDue(businessDay(now), wh.days, w?.confirmedWeek ?? null),
      confirmedAt: w?.confirmedAt ? w.confirmedAt.toISOString() : null,
    };
  }

  /** The manager looked at drive.google.com and saw today's backup ("I checked"). */
  async confirm(ctx: RequestContext, user: AuthUser, now = new Date()): Promise<DriveStateDto> {
    if (user.role !== "manager") throw new ApiException("FORBIDDEN");
    const week = weekMonday(businessDay(now));
    await this.database.db.transaction(async (tx) => {
      await tx.update(schema.driveWatch).set({ confirmedWeek: week, confirmedBy: user.id, confirmedAt: now }).where(eq(schema.driveWatch.id, 1));
      await this.audit.record(tx, ctx, { action: "backup.drive_checked", entityType: "backup", entityId: "drive", after: { week } });
    });
    this.realtime.notifyAll("backups");
    return this.state(now);
  }
}
