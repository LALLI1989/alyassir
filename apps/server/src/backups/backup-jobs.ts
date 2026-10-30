import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { dailySlot, hourlySlot } from "@alyassir/domain";
import { BackupsService } from "./backups.service";
import { DriveService } from "./drive.service";
import { UsbService } from "./usb.service";

/**
 * The backup schedule (SPEC 20.1, owner decisions 28-29/10/2026), checked every minute and at
 * start-up: the hourly backup of the current working hour, the daily backup of the last finished
 * working day (caught up at the first start after it), and the state of the monthly USB copy.
 */
@Injectable()
export class BackupJobs implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("BackupJobs");
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** A period whose backup just failed is tried again 10 minutes later, not every minute. */
  private readonly retryAfter = new Map<string, number>();

  constructor(
    @Inject(BackupsService) private readonly backups: BackupsService,
    @Inject(UsbService) private readonly usb: UsbService,
    @Inject(DriveService) private readonly drive: DriveService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.backups.enabled || process.env.ALYASSIR_DISABLE_JOBS === "1") return;
    void this.backups.markInterrupted(0).catch(() => undefined);
    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.run(new Date())
        .catch((e: unknown) => this.logger.error(e instanceof Error ? e.message : String(e)))
        .finally(() => (this.running = false));
    };
    setTimeout(tick, 5_000).unref();
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass of the schedule at `now`. A failed backup is logged and tried again next minute. */
  async run(now: Date): Promise<void> {
    if (this.backups.restoring) return;
    await this.usb.refresh(now);
    // Phase 8A: is the Google Drive app running on this computer (once per working hour).
    await this.drive.check(now).catch((e: unknown) => this.logger.warn(`drive: ${e instanceof Error ? e.message : String(e)}`));
    const wh = await this.backups.workHours();
    const hour = hourlySlot(now, wh);
    const due: ["hourly" | "daily", string][] = [];
    if (hour) due.push(["hourly", hour]);
    due.push(["daily", dailySlot(now, wh)]);
    for (const [kind, slot] of due) {
      const key = `${kind}:${slot}`;
      if ((this.retryAfter.get(key) ?? 0) > now.getTime()) continue;
      try {
        await this.backups.take(kind, slot, null, now);
        this.retryAfter.delete(key);
      } catch (error) {
        this.retryAfter.set(key, now.getTime() + 10 * 60_000);
        this.logger.warn(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
