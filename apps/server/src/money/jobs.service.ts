import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { schema } from "@alyassir/db";
import { addDays, businessDay } from "@alyassir/domain";
import { DatabaseService } from "../database.service";
import { MessagesService } from "../messages/messages.service";
import { RealtimeService } from "../realtime/realtime.service";
import { FinanceService } from "./finance.service";
import { messageManager } from "./payments.service";

export const DEBT_CONVERSION_JOB = "instalments_to_debt";

/**
 * Scheduled jobs inside the server (SPEC 4.18). Late instalments become debts at midnight
 * (Casablanca) starting D+3 (SPEC 14.6). Checked every minute and at start-up: a day the server was
 * off is caught up at once; job_runs (job + date) prevents running the same day twice.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Jobs");
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(FinanceService) private readonly finance: FinanceService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.ALYASSIR_DISABLE_JOBS === "1") return;
    const tick = () => {
      if (this.running) return;
      this.running = true;
      this.runDebtConversion(businessDay(new Date()))
        .catch((e: unknown) => this.logger.error(e instanceof Error ? e.message : String(e)))
        .finally(() => (this.running = false));
    };
    setTimeout(tick, 2_000).unref();
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Converts every instalment due on or before today - 3 that is still unpaid. Returns how many. */
  async runDebtConversion(today: string): Promise<number> {
    const db = this.database.db;
    const claimed = await db
      .insert(schema.jobRuns)
      .values({ job: DEBT_CONVERSION_JOB, runDate: today, details: {} })
      .onConflictDoNothing()
      .returning();
    if (!claimed.length) return 0;
    const limit = addDays(today, -3);
    const i = schema.installments;
    const due = await db
      .select({ policyId: i.policyId })
      .from(i)
      .where(and(inArray(i.status, ["pending", "partial"]), lte(i.dueDate, limit)))
      .groupBy(i.policyId);
    const items: Record<string, unknown>[] = [];
    let managerId: string | null = null;
    for (const { policyId } of due) {
      await db.transaction(async (tx) => {
        const [policy] = await tx.select().from(schema.policies).where(eq(schema.policies.id, policyId)).for("update");
        if (!policy) return;
        const rows = await tx
          .select()
          .from(i)
          .where(and(eq(i.policyId, policyId), inArray(i.status, ["pending", "partial"]), lte(i.dueDate, limit)))
          .orderBy(asc(i.id))
          .for("update");
        const [client] = await tx.select().from(schema.clients).where(eq(schema.clients.id, policy.clientId));
        const converted: Record<string, unknown>[] = [];
        for (const row of rows) {
          const left = row.amountCents - row.paidCents;
          // The late instalment and its fee become one debt; it is no longer a late instalment.
          await tx.update(i).set({ status: "converted_to_debt", convertedAt: new Date(), updatedAt: new Date(), version: row.version + 1 }).where(eq(i.id, row.id));
          await this.finance.newDebt(tx, { clientId: policy.clientId, policyId, periodId: row.periodId, source: "installment", installmentId: row.id, amountCents: left, debtDate: row.dueDate, userId: null });
          converted.push({ client: client?.companyName ?? client?.fullName, policyNumber: policy.policyNumber, seq: row.seq, dueDate: row.dueDate, amountCents: left });
        }
        await this.finance.refreshStatus(tx, policyId);
        if (converted.length) {
          managerId = await messageManager(this.messages, tx, "instalments_to_debt", { items: converted });
          await tx.insert(schema.auditLog).values({ userId: null, action: "system.instalments_to_debt", entityType: "policy", entityId: policyId, after: { items: converted }, device: "server" });
        }
        items.push(...converted);
      });
    }
    await db
      .update(schema.jobRuns)
      .set({ finishedAt: new Date(), details: { converted: items.length } })
      .where(and(eq(schema.jobRuns.job, DEBT_CONVERSION_JOB), eq(schema.jobRuns.runDate, today)));
    if (items.length) {
      if (managerId) this.messages.notify([managerId]);
      this.realtime.notifyAll("payments");
      this.realtime.notifyAll("policies");
      this.logger.log(`${items.length} late instalment(s) became debts`);
    }
    return items.length;
  }
}

